//! Time entries (工数, banto-cost P4b, `docs/project/design.md` §3.3, spec
//! §6.1 / §6.2).
//!
//! Service-layer shape (conventions §2): `Clone`, `BantoError`, sqlx, no
//! tauri/axum. The rules live in `cost_domain::time` (input checks, the 24-hour
//! day, duplicate and standard-day warnings, the labor cost at approval, the
//! summary); this module loads and stores rows. Authorization (`EnterTime`,
//! `EnterCommonTime`, `Approve`, `ApproveCommon`, `ViewProjectAmounts`,
//! ADR-0028) and audit are the REST/Tauri wiring's. Ownership is the
//! service's: an entry someone else entered reads as not found to the
//! owner-only operations, so its existence does not leak.
//!
//! Workflow: 下書き → 申請 → 承認, or 差戻し (back to the person, who edits and
//! submits again). Only drafts and returned entries can be edited or
//! deleted; an approved entry is never edited here.
//!
//! Corrections (訂正, P6b-2, spec §8 / §11, T11): the owner of an approved
//! entry requests a correction - a new row naming the entry (`corrects_id`)
//! with a reason, submitted at once - and accounting approves it again
//! (`ApproveCorrection`). The rate is fixed anew at that approval, so this is
//! also how an entry approved without a rate gets its cost. Once approved,
//! the entry it names drops out of every figure ([`COUNTS`], mirroring
//! `cost_domain::time::counts`); a returned correction is history only. A
//! correction is never edited: a returned one is requested again.
//! An entry dated in a closed month (月次締め, P6b) takes no write at all:
//! every write checks the month in its transaction (`refuse_closed!`).
//! On approval the `emp_rate` calc-basis row in effect on the work date and
//! the labor cost are stored; without a rate the cost stays NULL (原価未確定,
//! T04). A later calc-basis change never rewrites them (T03, design §10.5):
//! the calc-basis preview counts them as correction candidates instead.
//!
//! Concurrency (T13): every update compares `row_version`; a create with a
//! `clientRequestId` the person already used returns the first row instead
//! of a second one. On Postgres a create/update locks the person's user row
//! so two concurrent saves cannot both pass the 24-hour check.

use banto_admin_services::authz::ProjectScope;
use banto_core::{BantoError, FieldError};
use banto_server::ServerEvent;
use banto_storage::{Db, Dialect};
use cost_domain::calc_basis::{CalcValue, Source, Usage, UsageStatus};
use cost_domain::time::{
    approval_cost, check_correction, check_entry, summarize, CorrectionIssue, CorrectionTarget,
    DayEntry, EntryInput, Rework, SummaryEntry, Target, TimeIssue, TimeStatus, TimeSummary,
    TimeWarning, DAY_LIMIT, RATE_ITEM, UNIT_ITEM,
};
use cost_domain::{calc_basis, Date, Minutes};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::calc_basis::{domain_row, CalcBasisService, CalcValueRow};
use crate::closeouts::{refuse_settled, settled_check_sql};
use crate::closing::{refuse_closed, MonthGate};
use crate::customers::{clean_optional, field_error, now_expr, stale_version_error};
use crate::orders::{
    execute, fetch_all, fetch_optional, in_tx, on_pool, placeholders, scalar, MAX_TEXT_LEN,
};
use crate::work_masters::{MasterKind, WorkMastersService};

/// The standard-day item (`day_minutes`) used for the warning.
const DAY_ITEM: &str = "day_minutes";
/// The longest range one list call returns.
pub const MAX_RANGE_DAYS: i64 = 62;
pub const MAX_REQUEST_ID_LEN: usize = 100;

const SETTLED_MESSAGE: &str = "精算完了の案件には工数を入力できません";

/// The rows that count in the figures, `t` being `time_entries`: not an
/// entry replaced by an approved correction, not a returned correction
/// (`cost_domain::time::counts`, T11).
/// A macro so `concat!` can build constant SQL from it.
macro_rules! counts_sql {
    () => {
        "NOT EXISTS (SELECT 1 FROM time_entries rc \
         WHERE rc.corrects_id = t.id AND rc.status = 'approved') \
         AND NOT (t.corrects_id IS NOT NULL AND t.status = 'returned')"
    };
}
pub(crate) use counts_sql;
pub(crate) const COUNTS: &str = counts_sql!();

/// One time entry as the screens see it.

#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntry {
    pub id: i64,
    pub work_date: String,
    pub user_id: i64,
    pub user_name: String,
    pub project_id: Option<i64>,
    pub project_code: Option<String>,
    pub project_name: Option<String>,
    pub activity_id: Option<i64>,
    pub activity_name: Option<String>,
    pub phase_id: Option<i64>,
    pub phase_name: Option<String>,
    pub minutes: i64,
    pub description: Option<String>,
    /// `internal` | `customer` | `other`; `None` = 当初作業.
    pub rework_kind: Option<String>,
    /// `draft` | `submitted` | `approved` | `returned`.
    pub status: String,
    pub submitted_at: Option<String>,
    pub decided_by_name: Option<String>,
    pub decided_at: Option<String>,
    pub return_reason: Option<String>,
    /// The hourly rate fixed at approval. Shown only to `finance.rate`
    /// holders (the wiring masks it through `crate::time_access`).
    pub applied_rate: Option<i64>,
    /// The labor cost fixed at approval (same visibility as the rate).
    pub labor_cost: Option<i64>,
    /// Approved without a rate: 原価未確定 (T04). Not an amount, always shown.
    pub cost_missing: bool,
    /// A correction: the entry it replaces once approved (T11).
    pub corrects_id: Option<i64>,
    pub correction_reason: Option<String>,
    /// The approved correction that replaced this entry; it no longer counts.
    pub replaced_by_id: Option<i64>,
    /// A correction of this entry waits for approval.
    pub correction_pending: bool,
    pub row_version: i64,
    pub updated_at: String,
}

impl TimeEntry {
    /// The entry without the rate and cost: a record's cost over its minutes
    /// is the person's rate, which only `finance.rate` sees (spec §4).
    pub fn without_costs(mut self) -> Self {
        self.applied_rate = None;
        self.labor_cost = None;
        self
    }

    /// The audit detail both wiring layers record: date, minutes, target and
    /// status - never the rate or the cost (spec §4 / §11).
    pub fn audit_detail(&self) -> serde_json::Value {
        serde_json::json!({
            "workDate": self.work_date,
            "minutes": self.minutes,
            "projectId": self.project_id,
            "activityId": self.activity_id,
            "status": self.status,
            "correctsId": self.corrects_id,
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntryInput {
    pub work_date: String,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub activity_id: Option<i64>,
    #[serde(default)]
    pub phase_id: Option<i64>,
    pub minutes: i64,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub rework_kind: Option<String>,
    /// Create only: a client-generated id that makes a retried send
    /// idempotent (T13).
    #[serde(default)]
    pub client_request_id: Option<String>,
    /// Required on update (T13).
    #[serde(default)]
    pub row_version: Option<i64>,
}

/// A correction of an approved entry: the corrected values, the reason, and
/// in `entry.row_version` the version of the entry being corrected (T13).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionInput {
    #[serde(flatten)]
    pub entry: TimeEntryInput,
    #[serde(default)]
    pub reason: Option<String>,
}

/// A correction waiting for approval, with the entry it would replace.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionPair {
    pub correction: TimeEntry,
    pub original: TimeEntry,
}

/// `rowVersion` for submit / delete.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInput {
    pub row_version: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionInput {
    pub row_version: i64,
    pub approve: bool,
    /// Required when returning (差戻しの理由).
    #[serde(default)]
    pub reason: Option<String>,
}

/// A warning that does not block the save (spec §6.1).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum WarningView {
    /// Same day, same project (or activity) and phase already entered.
    Duplicate { ids: Vec<i64> },
    /// The day's total differs from the standard day.
    DayStandard { total: i64, standard: i64 },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntrySaved {
    pub entry: TimeEntry,
    pub warnings: Vec<WarningView>,
    /// A retried create that returned the row saved the first time.
    pub replayed: bool,
}

/// A count and minutes (件数と時間).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TallyView {
    pub count: usize,
    pub minutes: i64,
}

impl From<cost_domain::time::Tally> for TallyView {
    fn from(t: cost_domain::time::Tally) -> Self {
        Self {
            count: t.count,
            minutes: t.minutes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryView {
    pub approved: TallyView,
    /// Labor cost of the approved entries that have a cost (原価未確定分は除く).
    pub labor_cost: i64,
    pub missing_rate: TallyView,
    pub submitted: TallyView,
    pub unsubmitted: TallyView,
    /// No missing rate, nothing pending: the labor cost is final.
    pub complete: bool,
}

impl From<TimeSummary> for SummaryView {
    fn from(s: TimeSummary) -> Self {
        Self {
            approved: s.approved.into(),
            labor_cost: s.labor_cost,
            missing_rate: s.missing_rate.into(),
            submitted: s.submitted.into(),
            unsubmitted: s.unsubmitted.into(),
            complete: s.is_complete(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseSummary {
    pub phase_id: Option<i64>,
    pub phase_name: Option<String>,
    pub summary: SummaryView,
    /// Approved minutes marked as rework (手直し, spec §5.2).
    pub rework_minutes: i64,
}

/// A project's hours (案件詳細 → 工数). Amounts: `ViewProjectAmounts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTimeSummary {
    pub project_id: i64,
    pub total: SummaryView,
    pub rework_minutes: i64,
    pub phases: Vec<PhaseSummary>,
}

const SELECT: &str = "SELECT t.id, t.work_date, t.user_id, u.display_name AS user_name, \
     t.project_id, p.code AS project_code, p.name AS project_name, \
     t.activity_id, a.name AS activity_name, t.phase_id, ph.name AS phase_name, \
     t.minutes, t.description, t.rework_kind, t.status, t.submitted_at, \
     d.display_name AS decided_by_name, t.decided_at, t.return_reason, \
     t.applied_rate, t.labor_cost, \
     (t.status = 'approved' AND t.labor_cost IS NULL) AS cost_missing, \
     t.corrects_id, t.correction_reason, \
     (SELECT rc.id FROM time_entries rc WHERE rc.corrects_id = t.id \
      AND rc.status = 'approved') AS replaced_by_id, \
     EXISTS (SELECT 1 FROM time_entries pc WHERE pc.corrects_id = t.id \
      AND pc.status = 'submitted') AS correction_pending, \
     t.row_version, t.updated_at \
     FROM time_entries t JOIN users u ON u.id = t.user_id \
     LEFT JOIN projects p ON p.id = t.project_id \
     LEFT JOIN common_activities a ON a.id = t.activity_id \
     LEFT JOIN phases ph ON ph.id = t.phase_id \
     LEFT JOIN users d ON d.id = t.decided_by";

/// Validated input, ready to store.
struct Checked {
    domain: EntryInput,
    description: Option<String>,
    request_id: Option<String>,
}

impl Checked {
    fn project_id(&self) -> Option<i64> {
        match self.domain.target {
            Target::Project(id) => Some(id),
            Target::Activity(_) => None,
        }
    }

    fn activity_id(&self) -> Option<i64> {
        match self.domain.target {
            Target::Activity(id) => Some(id),
            Target::Project(_) => None,
        }
    }
}

fn validation(errors: Vec<FieldError>) -> Result<(), BantoError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(BantoError::Validation {
            field_errors: errors,
        })
    }
}

fn not_found(id: i64) -> BantoError {
    BantoError::NotFound {
        resource: "time_entries".into(),
        id: id.to_string(),
    }
}

fn status_error(message: &str) -> BantoError {
    BantoError::Validation {
        field_errors: vec![field_error("status", message)],
    }
}

fn issue_error(issue: &TimeIssue) -> FieldError {
    match issue {
        TimeIssue::MinutesNotPositive => {
            field_error("minutes", "0分より長い時間を入力してください")
        }
        TimeIssue::NotOnUnit { unit } => {
            field_error("minutes", format!("{unit}分単位で入力してください"))
        }
        TimeIssue::DayOverLimit { total } => field_error(
            "minutes",
            format!(
                "同じ日の合計が24時間を超えます（合計 {}時間{}分）",
                total / 60,
                total % 60
            ),
        ),
        TimeIssue::PhaseRequired => field_error("phaseId", "工程を選んでください"),
        TimeIssue::ActivityWithPhase => {
            field_error("phaseId", "共通活動には工程・手直し区分を付けません")
        }
    }
}

fn correction_error(issue: &CorrectionIssue) -> FieldError {
    match issue {
        CorrectionIssue::NotApproved => field_error(
            "status",
            "承認済みの工数だけを訂正できます（承認前は差戻し後に直します）",
        ),
        CorrectionIssue::AlreadyReplaced => field_error(
            "status",
            "この工数は訂正済みです。訂正後の工数の方を訂正してください",
        ),
        CorrectionIssue::Pending => pending_correction_error(),
        CorrectionIssue::ReasonRequired => field_error("reason", "訂正の理由を入力してください"),
    }
}

fn pending_correction_error() -> FieldError {
    field_error(
        "status",
        "この工数には申請中の訂正があります。承認か差戻しを待ってください",
    )
}

/// The rows of a person's day the 24-hour check counts (`extra` narrows it):
/// those that count, except a correction still waiting - until it is
/// approved the entry it would replace is the one that counts, and the
/// approval checks the day again with the correction in its place (PR #24
/// review: both rows would otherwise fill the day twice).
fn day_sql(extra: &str) -> String {
    format!(
        "SELECT t.id, t.project_id, t.activity_id, t.phase_id, t.minutes FROM time_entries t \
         WHERE t.user_id = ? AND t.work_date = ? AND {COUNTS} \
         AND NOT (t.corrects_id IS NOT NULL AND t.status = 'submitted'){extra}"
    )
}

fn warning_view(w: TimeWarning) -> WarningView {
    match w {
        TimeWarning::DuplicateCandidate { ids } => WarningView::Duplicate { ids },
        TimeWarning::DayDiffersFromStandard { total, standard } => {
            WarningView::DayStandard { total, standard }
        }
    }
}

fn parse_date(field: &str, value: &str) -> Result<Date, BantoError> {
    Date::parse(value.trim()).ok_or_else(|| BantoError::Validation {
        field_errors: vec![field_error(field, "日付は YYYY-MM-DD で入力してください")],
    })
}

#[derive(Clone)]
pub struct TimeEntriesService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

/// Same-day rows of a person (id, project, activity, phase, minutes).
type DayRow = (i64, Option<i64>, Option<i64>, Option<i64>, i64);

impl TimeEntriesService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    /// Emit `ResourceChanged { resource: "time_entries" }` after each
    /// committed write, as the other business services do.
    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn notify_changed(&self) {
        crate::events::notify_changed(&self.events, "time_entries");
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    fn now(&self) -> &'static str {
        now_expr(self.db.dialect())
    }

    /// One entry (any owner). The wiring authorizes against its project.
    pub async fn get(&self, id: i64) -> Result<TimeEntry, BantoError> {
        let sql = self.sql(&format!("{SELECT} WHERE t.id = ?"));
        let row: Option<TimeEntry> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        row.ok_or_else(|| not_found(id))
    }

    /// One of the person's own entries; someone else's reads as not found.
    async fn own(&self, user_id: i64, id: i64) -> Result<TimeEntry, BantoError> {
        let entry = self.get(id).await?;
        if entry.user_id != user_id {
            return Err(not_found(id));
        }
        Ok(entry)
    }

    /// The person's entries from `from` to `to` (both inclusive, at most
    /// [`MAX_RANGE_DAYS`] apart), oldest first.
    pub async fn list_own(
        &self,
        user_id: i64,
        from: &str,
        to: &str,
    ) -> Result<Vec<TimeEntry>, BantoError> {
        let from_d = parse_date("from", from)?;
        let to_d = parse_date("to", to)?;
        let span = to_d.day_number() - from_d.day_number();
        if !(0..=MAX_RANGE_DAYS).contains(&span) {
            return Err(BantoError::Validation {
                field_errors: vec![field_error(
                    "to",
                    format!("期間は開始日から{MAX_RANGE_DAYS}日以内にしてください"),
                )],
            });
        }
        let sql = self.sql(&format!(
            "{SELECT} WHERE t.user_id = ? AND t.work_date >= ? AND t.work_date <= ? \
             ORDER BY t.work_date, t.id"
        ));
        let (f, t) = (from_d.to_string(), to_d.to_string());
        on_pool!(&self.db, pool => fetch_all!(pool, sql, user_id, &f, &t))
    }

    /// Submitted entries the caller may decide: projects in `scope`, and the
    /// common-activity entries when `common` (accounting).
    pub async fn approvals(
        &self,
        scope: &ProjectScope,
        common: bool,
    ) -> Result<Vec<TimeEntry>, BantoError> {
        let sql = format!(
            "{SELECT} WHERE t.status = 'submitted' AND t.corrects_id IS NULL \
             ORDER BY t.work_date, t.id"
        );
        let rows: Vec<TimeEntry> = on_pool!(&self.db, pool => fetch_all!(pool, sql))?;
        Ok(rows
            .into_iter()
            .filter(|e| match e.project_id {
                Some(pid) => scope.contains(pid),
                None => common,
            })
            .collect())
    }

    /// Corrections waiting for approval, each with the entry it replaces
    /// (accounting decides them all: `ApproveCorrection`).
    pub async fn pending_corrections(&self) -> Result<Vec<CorrectionPair>, BantoError> {
        let sql = format!(
            "{SELECT} WHERE t.status = 'submitted' AND t.corrects_id IS NOT NULL \
             ORDER BY t.work_date, t.id"
        );
        let rows: Vec<TimeEntry> = on_pool!(&self.db, pool => fetch_all!(pool, sql))?;
        let mut out = Vec::with_capacity(rows.len());
        for correction in rows {
            let original = self
                .get(correction.corrects_id.expect("filtered above"))
                .await?;
            out.push(CorrectionPair {
                correction,
                original,
            });
        }
        Ok(out)
    }

    /// The corrections of an entry and of the corrections after it, newest
    /// first: the chain's history for the owner's screen.
    pub async fn corrections_of(
        &self,
        user_id: i64,
        id: i64,
    ) -> Result<Vec<TimeEntry>, BantoError> {
        let mut current = self.own(user_id, id).await?;
        let sql = self.sql(&format!("{SELECT} WHERE t.corrects_id = ? ORDER BY t.id"));
        let mut out = Vec::new();
        loop {
            let rows: Vec<TimeEntry> =
                on_pool!(&self.db, pool => fetch_all!(pool, sql, current.id))?;
            let next = rows.iter().find(|r| r.status == "approved").cloned();
            out.extend(rows);
            match next {
                Some(n) => current = n,
                None => break,
            }
        }
        out.reverse();
        Ok(out)
    }

    /// Check the input against the masters, the project and the calc basis.
    /// `kept` is the entry being corrected: a phase or common activity it
    /// already carries stays usable after being discontinued (使用中止 only
    /// closes it for new entries), so a returned entry can still be fixed.
    async fn check(
        &self,
        input: &TimeEntryInput,
        kept: Option<&TimeEntry>,
    ) -> Result<Checked, BantoError> {
        let mut errors = Vec::new();
        let work_date = Date::parse(input.work_date.trim());
        if work_date.is_none() {
            errors.push(field_error(
                "workDate",
                "日付は YYYY-MM-DD で入力してください",
            ));
        }
        let target = match (input.project_id, input.activity_id) {
            (Some(p), None) => Some(Target::Project(p)),
            (None, Some(a)) => Some(Target::Activity(a)),
            _ => {
                errors.push(field_error(
                    "projectId",
                    "案件か共通活動のどちらか一つを選んでください",
                ));
                None
            }
        };
        let rework = match clean_optional(&input.rework_kind) {
            None => None,
            Some(r) => match Rework::parse(&r) {
                Some(k) => Some(k),
                None => {
                    errors.push(field_error("reworkKind", "不明な手直し区分です"));
                    None
                }
            },
        };
        let description = clean_optional(&input.description);
        if description
            .as_deref()
            .is_some_and(|d| d.chars().count() > MAX_TEXT_LEN)
        {
            errors.push(field_error(
                "description",
                format!("{MAX_TEXT_LEN}文字以内で入力してください"),
            ));
        }
        let request_id = clean_optional(&input.client_request_id);
        if request_id
            .as_deref()
            .is_some_and(|r| r.chars().count() > MAX_REQUEST_ID_LEN)
        {
            errors.push(field_error("clientRequestId", "長すぎます"));
        }
        validation(errors)?;
        let target = target.expect("checked above");
        let masters = WorkMastersService::new(self.db.clone());
        match target {
            Target::Project(pid) => self.require_open_project(pid).await?,
            Target::Activity(aid) if kept.is_some_and(|k| k.activity_id == Some(aid)) => {}
            Target::Activity(aid) => {
                masters
                    .require_active(MasterKind::Activities, aid, "activityId")
                    .await?;
            }
        }
        if let Some(phase) = input
            .phase_id
            .filter(|p| !kept.is_some_and(|k| k.phase_id == Some(*p)))
        {
            masters
                .require_active(MasterKind::Phases, phase, "phaseId")
                .await?;
        }
        Ok(Checked {
            domain: EntryInput {
                work_date: work_date.expect("checked above"),
                target,
                phase: input.phase_id,
                minutes: input.minutes,
                rework,
            },
            description,
            request_id,
        })
    }

    /// The project exists and is not settled (精算完了 closes it for hours);
    /// the writes check again in their transaction (`refuse_settled!`).
    async fn require_open_project(&self, project_id: i64) -> Result<(), BantoError> {
        let sql = self.sql("SELECT status FROM projects WHERE id = ?");
        let row: Option<(String,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))?;
        match row {
            None => Err(BantoError::Validation {
                field_errors: vec![field_error("projectId", "見つかりません")],
            }),
            Some((status,)) if status == "settled" => Err(BantoError::Validation {
                field_errors: vec![field_error("projectId", SETTLED_MESSAGE)],
            }),
            Some(_) => Ok(()),
        }
    }

    /// The company value of `item` on `on` (input unit / standard day).
    async fn company_value(
        &self,
        item: &str,
        project: Option<i64>,
        on: Date,
    ) -> Result<Option<i64>, BantoError> {
        let rows = CalcBasisService::new(self.db.clone())
            .value_rows(item)
            .await?;
        let values: Vec<CalcValue> = rows.iter().filter_map(domain_row).collect();
        let pid = project.map(|p| p.to_string());
        Ok(calc_basis::resolve(&values, item, pid.as_deref(), on, None).map(|r| r.value))
    }

    /// Run the domain check for `user_id`'s day inside the transaction `tx`
    /// and return the warnings (or the validation error).
    fn day_check(
        checked: &Checked,
        rows: Vec<DayRow>,
        unit: Option<Minutes>,
        standard: Option<Minutes>,
    ) -> Result<Vec<WarningView>, BantoError> {
        let same_day: Vec<DayEntry> = rows
            .into_iter()
            .filter_map(|(id, project, activity, phase, minutes)| {
                let target = match (project, activity) {
                    (Some(p), _) => Target::Project(p),
                    (None, Some(a)) => Target::Activity(a),
                    _ => return None,
                };
                Some(DayEntry {
                    id,
                    work_date: checked.domain.work_date,
                    target,
                    phase,
                    minutes,
                })
            })
            .collect();
        check_entry(&checked.domain, &same_day, unit, standard)
            .map(|w| w.into_iter().map(warning_view).collect())
            .map_err(|issues| BantoError::Validation {
                field_errors: issues.iter().map(issue_error).collect(),
            })
    }

    fn lock_sql(&self) -> Option<String> {
        match self.db.dialect() {
            Dialect::Postgres => Some(self.sql("SELECT id FROM users WHERE id = ? FOR UPDATE")),
            Dialect::Sqlite => None,
        }
    }

    async fn by_request(&self, user_id: i64, request_id: &str) -> Result<Option<i64>, BantoError> {
        let sql =
            self.sql("SELECT id FROM time_entries WHERE user_id = ? AND client_request_id = ?");
        let row: Option<(i64,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, user_id, request_id))?;
        Ok(row.map(|(id,)| id))
    }

    /// Record a draft for `user_id`.
    pub async fn create(
        &self,
        user_id: i64,
        input: TimeEntryInput,
    ) -> Result<TimeEntrySaved, BantoError> {
        let checked = self.check(&input, None).await?;
        if let Some(rid) = &checked.request_id {
            if let Some(id) = self.by_request(user_id, rid).await? {
                return self.replayed(id).await;
            }
        }
        let on = checked.domain.work_date;
        let unit = self.company_value(UNIT_ITEM, None, on).await?;
        let standard = self
            .company_value(DAY_ITEM, checked.project_id(), on)
            .await?;
        let lock = self.lock_sql();
        let day = self.sql(&day_sql(""));
        let insert = self.sql(
            "INSERT INTO time_entries (work_date, user_id, project_id, activity_id, phase_id, \
             minutes, description, rework_kind, status, client_request_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?) RETURNING id",
        );
        let date = on.to_string();
        let rework = checked.domain.rework.map(Rework::as_str);
        let again =
            self.sql("SELECT id FROM time_entries WHERE user_id = ? AND client_request_id = ?");
        let settled = settled_check_sql(self.db.dialect());
        let gate = MonthGate::new(self.db.dialect());
        // `Err(id)` = a concurrent retry with the same request id committed
        // while this one waited for the lock (PR #16 review): its row is the
        // answer, and it must not be counted against this day as a second one.
        let result: Result<Result<(i64, Vec<WarningView>), i64>, BantoError> = async {
            Ok(in_tx!(&self.db, tx => {
                if let Some(lock) = &lock {
                    let _: Vec<(i64,)> = fetch_all!(&mut *tx, lock, user_id)?;
                }
                let first: Option<(i64,)> = match &checked.request_id {
                    Some(rid) => fetch_optional!(&mut *tx, again, user_id, rid)?,
                    None => None,
                };
                if let Some((existing,)) = first {
                    Err(existing)
                } else {
                    let rows: Vec<DayRow> = fetch_all!(&mut *tx, day, user_id, &date)?;
                    let warnings = Self::day_check(&checked, rows, unit, standard)?;
                    let id: i64 = scalar!(&mut *tx, insert, &date, user_id, checked.project_id(),
                        checked.activity_id(), checked.domain.phase, checked.domain.minutes,
                        &checked.description, rework, &checked.request_id)?;
                    refuse_closed!(&mut *tx, gate, &date, "workDate");
                    if let Some(p) = checked.project_id() {
                        refuse_settled!(&mut *tx, settled, p, "projectId", SETTLED_MESSAGE);
                    }
                    Ok((id, warnings))
                }
            }))
        }
        .await;
        let (id, warnings) = match result {
            Ok(Ok(v)) => v,
            Ok(Err(id)) => return self.replayed(id).await,
            // A concurrent retry with the same request id committed first.
            Err(BantoError::Storage(m)) if m.to_lowercase().contains("unique") => {
                if let Some(rid) = &checked.request_id {
                    if let Some(id) = self.by_request(user_id, rid).await? {
                        return self.replayed(id).await;
                    }
                }
                return Err(BantoError::Storage(m));
            }
            Err(e) => return Err(e),
        };
        self.notify_changed();
        Ok(TimeEntrySaved {
            entry: self.get(id).await?,
            warnings,
            replayed: false,
        })
    }

    async fn replayed(&self, id: i64) -> Result<TimeEntrySaved, BantoError> {
        Ok(TimeEntrySaved {
            entry: self.get(id).await?,
            warnings: Vec::new(),
            replayed: true,
        })
    }

    /// The owner's editable entry with the version they read.
    async fn editable(
        &self,
        user_id: i64,
        id: i64,
        row_version: Option<i64>,
    ) -> Result<TimeEntry, BantoError> {
        let entry = self.own(user_id, id).await?;
        let status = TimeStatus::parse(&entry.status)
            .ok_or_else(|| BantoError::Other(format!("不明な状態です: {}", entry.status)))?;
        if !status.is_editable() {
            return Err(status_error("申請中・承認済みの工数は変更できません"));
        }
        if entry.corrects_id.is_some() {
            return Err(status_error(
                "訂正は変更・削除・再申請できません。もう一度訂正を申請してください",
            ));
        }
        if row_version != Some(entry.row_version) {
            return Err(stale_version_error());
        }
        Ok(entry)
    }

    /// Change a draft or returned entry of `user_id`.
    pub async fn update(
        &self,
        user_id: i64,
        id: i64,
        input: TimeEntryInput,
    ) -> Result<TimeEntrySaved, BantoError> {
        let entry = self.editable(user_id, id, input.row_version).await?;
        let checked = self.check(&input, Some(&entry)).await?;
        let on = checked.domain.work_date;
        let unit = self.company_value(UNIT_ITEM, None, on).await?;
        let standard = self
            .company_value(DAY_ITEM, checked.project_id(), on)
            .await?;
        let lock = self.lock_sql();
        let day = self.sql(&day_sql(" AND t.id <> ?"));
        let update = self.sql(&format!(
            "UPDATE time_entries SET work_date = ?, project_id = ?, activity_id = ?, \
             phase_id = ?, minutes = ?, description = ?, rework_kind = ?, \
             row_version = row_version + 1, updated_at = {} \
             WHERE id = ? AND row_version = ? AND status IN ('draft','returned')",
            self.now()
        ));
        let date = on.to_string();
        let rework = checked.domain.rework.map(Rework::as_str);
        let version = entry.row_version;
        let settled = settled_check_sql(self.db.dialect());
        let gate = MonthGate::new(self.db.dialect());
        let warnings = in_tx!(&self.db, tx => {
            if let Some(lock) = &lock {
                let _: Vec<(i64,)> = fetch_all!(&mut *tx, lock, user_id)?;
            }
            let rows: Vec<DayRow> = fetch_all!(&mut *tx, day, user_id, &date, id)?;
            let warnings = Self::day_check(&checked, rows, unit, standard)?;
            if execute!(&mut *tx, update, &date, checked.project_id(), checked.activity_id(),
                checked.domain.phase, checked.domain.minutes, &checked.description, rework,
                id, version)? == 0
            {
                return Err(stale_version_error());
            }
            refuse_closed!(&mut *tx, gate, &entry.work_date, "workDate");
            refuse_closed!(&mut *tx, gate, &date, "workDate");
            if let Some(p) = checked.project_id() {
                refuse_settled!(&mut *tx, settled, p, "projectId", SETTLED_MESSAGE);
            }
            warnings
        });
        self.notify_changed();
        Ok(TimeEntrySaved {
            entry: self.get(id).await?,
            warnings,
            replayed: false,
        })
    }

    /// Request a correction of `user_id`'s approved entry `id` (T11): a new
    /// row naming it, with the corrected values and a reason, submitted at
    /// once. The entry keeps counting until the correction is approved.
    ///
    /// Both the entry's month and the correction's month must be open (a
    /// closed month is corrected after accounting reopens it, P6b-1), and
    /// neither project may be settled. The unique index on `corrects_id`
    /// keeps a second correction of the same entry out, also against a
    /// concurrent request.
    pub async fn correct(
        &self,
        user_id: i64,
        id: i64,
        input: CorrectionInput,
    ) -> Result<TimeEntrySaved, BantoError> {
        let original = self.own(user_id, id).await?;
        let checked = self.check(&input.entry, Some(&original)).await?;
        if let Some(rid) = &checked.request_id {
            if let Some(existing) = self.by_request(user_id, rid).await? {
                return self.replayed(existing).await;
            }
        }
        if input.entry.row_version != Some(original.row_version) {
            return Err(stale_version_error());
        }
        let reason = clean_optional(&input.reason);
        let status = TimeStatus::parse(&original.status)
            .ok_or_else(|| BantoError::Other(format!("不明な状態です: {}", original.status)))?;
        let target = CorrectionTarget {
            status,
            replaced: original.replaced_by_id.is_some(),
            pending: original.correction_pending,
        };
        let mut errors: Vec<FieldError> = match check_correction(target, reason.as_deref()) {
            Ok(()) => Vec::new(),
            Err(issues) => issues.iter().map(correction_error).collect(),
        };
        if reason
            .as_deref()
            .is_some_and(|r| r.chars().count() > MAX_TEXT_LEN)
        {
            errors.push(field_error(
                "reason",
                format!("{MAX_TEXT_LEN}文字以内で入力してください"),
            ));
        }
        validation(errors)?;
        if let Some(pid) = original.project_id {
            self.require_open_project(pid).await?;
        }
        let on = checked.domain.work_date;
        let unit = self.company_value(UNIT_ITEM, None, on).await?;
        let standard = self
            .company_value(DAY_ITEM, checked.project_id(), on)
            .await?;
        let lock = self.lock_sql();
        // The entry being corrected is replaced, so its minutes do not count.
        let day = self.sql(&day_sql(" AND t.id <> ?"));
        let insert = self.sql(&format!(
            "INSERT INTO time_entries (work_date, user_id, project_id, activity_id, phase_id, \
             minutes, description, rework_kind, status, submitted_at, client_request_id, \
             corrects_id, correction_reason) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', {}, ?, ?, ?) RETURNING id",
            self.now()
        ));
        // Re-read in the transaction: approved and not replaced (T13).
        let still = self.sql(&format!(
            "SELECT t.id FROM time_entries t WHERE t.id = ? AND t.status = 'approved' \
             AND t.row_version = ? AND {COUNTS}"
        ));
        // The entry's version moves, so a settlement or a monthly close that
        // read its project or month sees the waiting correction (T13).
        let touch = self.sql(&format!(
            "UPDATE time_entries SET row_version = row_version + 1, updated_at = {} \
             WHERE id = ? AND row_version = ?",
            self.now()
        ));
        let date = on.to_string();
        let rework = checked.domain.rework.map(Rework::as_str);
        let again =
            self.sql("SELECT id FROM time_entries WHERE user_id = ? AND client_request_id = ?");
        let settled = settled_check_sql(self.db.dialect());
        let gate = MonthGate::new(self.db.dialect());
        let version = original.row_version;
        let result: Result<Result<(i64, Vec<WarningView>), i64>, BantoError> = async {
            Ok(in_tx!(&self.db, tx => {
                if let Some(lock) = &lock {
                    let _: Vec<(i64,)> = fetch_all!(&mut *tx, lock, user_id)?;
                }
                let first: Option<(i64,)> = match &checked.request_id {
                    Some(rid) => fetch_optional!(&mut *tx, again, user_id, rid)?,
                    None => None,
                };
                if let Some((existing,)) = first {
                    Err(existing)
                } else {
                    let live: Option<(i64,)> = fetch_optional!(&mut *tx, still, id, version)?;
                    if live.is_none() || execute!(&mut *tx, touch, id, version)? == 0 {
                        return Err(stale_version_error());
                    }
                    let rows: Vec<DayRow> = fetch_all!(&mut *tx, day, user_id, &date, id)?;
                    let warnings = Self::day_check(&checked, rows, unit, standard)?;
                    let new_id: i64 = scalar!(&mut *tx, insert, &date, user_id,
                        checked.project_id(), checked.activity_id(), checked.domain.phase,
                        checked.domain.minutes, &checked.description, rework,
                        &checked.request_id, id, &reason)?;
                    refuse_closed!(&mut *tx, gate, &original.work_date, "workDate");
                    refuse_closed!(&mut *tx, gate, &date, "workDate");
                    if let Some(p) = original.project_id {
                        refuse_settled!(&mut *tx, settled, p, "projectId", SETTLED_MESSAGE);
                    }
                    if let Some(p) = checked.project_id() {
                        refuse_settled!(&mut *tx, settled, p, "projectId", SETTLED_MESSAGE);
                    }
                    Ok((new_id, warnings))
                }
            }))
        }
        .await;
        let (new_id, warnings) = match result {
            Ok(Ok(v)) => v,
            Ok(Err(existing)) => return self.replayed(existing).await,
            Err(BantoError::Storage(m)) if is_correction_conflict(&m) => {
                return Err(BantoError::Validation {
                    field_errors: vec![pending_correction_error()],
                });
            }
            Err(BantoError::Storage(m)) if m.to_lowercase().contains("unique") => {
                if let Some(rid) = &checked.request_id {
                    if let Some(existing) = self.by_request(user_id, rid).await? {
                        return self.replayed(existing).await;
                    }
                }
                return Err(BantoError::Storage(m));
            }
            Err(e) => return Err(e),
        };
        self.notify_changed();
        Ok(TimeEntrySaved {
            entry: self.get(new_id).await?,
            warnings,
            replayed: false,
        })
    }

    /// Delete a draft or returned entry of `user_id` (never an approved one).
    pub async fn delete(&self, user_id: i64, id: i64, row_version: i64) -> Result<(), BantoError> {
        let entry = self.editable(user_id, id, Some(row_version)).await?;
        let sql = self.sql(
            "DELETE FROM time_entries WHERE id = ? AND row_version = ? \
             AND status IN ('draft','returned')",
        );
        let gate = MonthGate::new(self.db.dialect());
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, sql, id, row_version)? == 0 {
                return Err(stale_version_error());
            }
            refuse_closed!(&mut *tx, gate, &entry.work_date, "workDate");
        });
        self.notify_changed();
        Ok(())
    }

    /// Submit a draft or returned entry of `user_id` (申請).
    pub async fn submit(
        &self,
        user_id: i64,
        id: i64,
        row_version: i64,
    ) -> Result<TimeEntry, BantoError> {
        let entry = self.editable(user_id, id, Some(row_version)).await?;
        if let Some(pid) = entry.project_id {
            self.require_open_project(pid).await?;
        }
        let sql = self.sql(&format!(
            "UPDATE time_entries SET status = 'submitted',submitted_at = {now}, \
             row_version = row_version + 1, updated_at = {now} \
             WHERE id = ? AND row_version = ? AND status IN ('draft','returned')",
            now = self.now()
        ));
        let gate = MonthGate::new(self.db.dialect());
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, sql, id, row_version)? == 0 {
                return Err(stale_version_error());
            }
            refuse_closed!(&mut *tx, gate, &entry.work_date, "workDate");
        });
        self.notify_changed();
        self.get(id).await
    }

    /// Approve (fixing the rate and labor cost) or return a submitted entry.
    ///
    /// `authorized` is the row the caller was authorized against (its project
    /// decides who may approve). The decision applies only to that exact
    /// version, so a row changed after authorization (e.g. moved to another
    /// project and resubmitted) is refused as stale instead of being decided
    /// under the earlier project's permission.
    pub async fn decide(
        &self,
        authorized: &TimeEntry,
        input: DecisionInput,
        actor_user_id: Option<i64>,
    ) -> Result<TimeEntry, BantoError> {
        let id = authorized.id;
        let entry = self.get(id).await?;
        if !TimeStatus::parse(&entry.status).is_some_and(TimeStatus::is_decidable) {
            return Err(status_error("申請中の工数だけを承認・差戻しできます"));
        }
        if input.row_version != authorized.row_version
            || entry.row_version != authorized.row_version
        {
            return Err(stale_version_error());
        }
        // A correction also writes into the month and project of the entry
        // it replaces (T11).
        let original = match entry.corrects_id {
            Some(oid) => Some(self.get(oid).await?),
            None => None,
        };
        if input.approve {
            if let Some(pid) = entry.project_id {
                self.require_open_project(pid).await?;
            }
            if let Some(pid) = original.as_ref().and_then(|o| o.project_id) {
                self.require_open_project(pid).await?;
            }
        }
        let original_date = original.as_ref().map(|o| o.work_date.clone());
        let original_project = original.as_ref().and_then(|o| o.project_id);
        // Approving a correction touches the replaced entry's version, so a
        // settlement or a monthly close that read the entry sees the change
        // in its fingerprint (T13); the entry's values stay as approved.
        let touch = self.sql(&format!(
            "UPDATE time_entries SET row_version = row_version + 1, updated_at = {} \
             WHERE id = ? AND status = 'approved'",
            self.now()
        ));
        let settled = settled_check_sql(self.db.dialect());
        let gate = MonthGate::new(self.db.dialect());
        let changed = if input.approve {
            let work_date = parse_date("workDate", &entry.work_date)?;
            let rows = CalcBasisService::new(self.db.clone())
                .value_rows(RATE_ITEM)
                .await?;
            let values: Vec<CalcValue> = rows.iter().filter_map(domain_row).collect();
            let pid = entry.project_id.map(|p| p.to_string());
            let cost = approval_cost(&values, pid.as_deref(), work_date, entry.minutes);
            let value_id = cost
                .rate
                .as_ref()
                .and_then(|r| row_of(&rows, &r.source, entry.project_id));
            let sql = self.sql(&format!(
                "UPDATE time_entries SET status = 'approved', applied_calc_value_id = ?, \
                 applied_rate = ?, labor_cost = ?, decided_by = ?, decided_at = {now}, \
                 row_version = row_version + 1, updated_at = {now} \
                 WHERE id = ? AND row_version = ? AND status = 'submitted'",
                now = self.now()
            ));
            let rate = cost.rate.map(|r| r.value);
            let lock = self.lock_sql();
            let day = self.sql(&day_sql(""));
            in_tx!(&self.db, tx => {
                if entry.corrects_id.is_some() {
                    if let Some(lock) = &lock {
                        let _: Vec<(i64,)> = fetch_all!(&mut *tx, lock, entry.user_id)?;
                    }
                }
                let n = execute!(&mut *tx, sql, value_id, rate, cost.cost, actor_user_id, id,
                    input.row_version)?;
                refuse_closed!(&mut *tx, gate, &entry.work_date, "workDate");
                if let Some(oid) = entry.corrects_id {
                    if n > 0 && execute!(&mut *tx, touch, oid)? == 0 {
                        return Err(stale_version_error());
                    }
                    // The day with the correction in place of the entry it
                    // replaces (now out of COUNTS) stays within 24 hours.
                    let rows: Vec<DayRow> =
                        fetch_all!(&mut *tx, day, entry.user_id, &entry.work_date)?;
                    let total: i64 = rows.iter().map(|r| r.4).sum();
                    if total > DAY_LIMIT {
                        return Err(BantoError::Validation {
                            field_errors: vec![issue_error(&TimeIssue::DayOverLimit { total })],
                        });
                    }
                }
                if let Some(d) = &original_date {
                    refuse_closed!(&mut *tx, gate, d, "workDate");
                }
                if let Some(p) = original_project {
                    refuse_settled!(&mut *tx, settled, p, "projectId", SETTLED_MESSAGE);
                }
                if let Some(p) = entry.project_id {
                    refuse_settled!(&mut *tx, settled, p, "projectId", SETTLED_MESSAGE);
                }
                n
            })
        } else {
            let reason = clean_optional(&input.reason);
            let mut errors = Vec::new();
            match &reason {
                None => errors.push(field_error("reason", "差戻しの理由を入力してください")),
                Some(r) if r.chars().count() > MAX_TEXT_LEN => errors.push(field_error(
                    "reason",
                    format!("{MAX_TEXT_LEN}文字以内で入力してください"),
                )),
                _ => {}
            }
            validation(errors)?;
            let sql = self.sql(&format!(
                "UPDATE time_entries SET status = 'returned', return_reason = ?, \
                 decided_by = ?, decided_at = {now}, \
                 row_version = row_version + 1, updated_at = {now} \
                 WHERE id = ? AND row_version = ? AND status = 'submitted'",
                now = self.now()
            ));
            in_tx!(&self.db, tx => {
                let n = execute!(&mut *tx, sql, &reason, actor_user_id, id, input.row_version)?;
                refuse_closed!(&mut *tx, gate, &entry.work_date, "workDate");
                if let Some(d) = &original_date {
                    refuse_closed!(&mut *tx, gate, d, "workDate");
                }
                n
            })
        };
        if changed == 0 {
            return Err(stale_version_error());
        }
        self.notify_changed();
        self.get(id).await
    }

    /// A project's hours: approved only as actuals, the rest counted apart
    /// (spec §6.1, T04).
    pub async fn project_summary(&self, project_id: i64) -> Result<ProjectTimeSummary, BantoError> {
        let exists = self.sql("SELECT id FROM projects WHERE id = ?");
        let found: Option<(i64,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, exists, project_id))?;
        if found.is_none() {
            return Err(BantoError::NotFound {
                resource: "projects".into(),
                id: project_id.to_string(),
            });
        }
        let sql = self.sql(&format!(
            "SELECT t.status, t.minutes, t.labor_cost, t.phase_id, ph.name, t.rework_kind \
             FROM time_entries t LEFT JOIN phases ph ON ph.id = t.phase_id \
             WHERE t.project_id = ? AND {COUNTS} ORDER BY ph.sort_order, t.phase_id"
        ));
        type Row = (
            String,
            i64,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
        );
        let rows: Vec<Row> = on_pool!(&self.db, pool => fetch_all!(pool, sql, project_id))?;
        let entry = |r: &Row| SummaryEntry {
            status: TimeStatus::parse(&r.0).unwrap_or(TimeStatus::Draft),
            minutes: r.1,
            labor_cost: r.2,
        };
        let is_rework = |r: &Row| r.0 == "approved" && r.5.is_some();
        let mut phases: Vec<PhaseSummary> = Vec::new();
        let mut order: Vec<Option<i64>> = Vec::new();
        for r in &rows {
            if !order.contains(&r.3) {
                order.push(r.3);
            }
        }
        for phase in order {
            let mine: Vec<&Row> = rows.iter().filter(|r| r.3 == phase).collect();
            let entries: Vec<SummaryEntry> = mine.iter().map(|r| entry(r)).collect();
            phases.push(PhaseSummary {
                phase_id: phase,
                phase_name: mine.first().and_then(|r| r.4.clone()),
                summary: summarize(&entries).into(),
                rework_minutes: mine.iter().filter(|r| is_rework(r)).map(|r| r.1).sum(),
            });
        }
        let all: Vec<SummaryEntry> = rows.iter().map(entry).collect();
        Ok(ProjectTimeSummary {
            project_id,
            total: summarize(&all).into(),
            rework_minutes: rows.iter().filter(|r| is_rework(r)).map(|r| r.1).sum(),
            phases,
        })
    }
}

/// A second in-flight or approved correction of the same entry hit the
/// unique index (SQLite names the column, Postgres the index).
fn is_correction_conflict(message: &str) -> bool {
    message.contains("corrects_id") || message.contains("time_entries_one_correction")
}

/// The `calc_values` row a resolved value came from.
pub(crate) fn row_of(
    rows: &[CalcValueRow],
    source: &Source,
    project_id: Option<i64>,
) -> Option<i64> {
    match source {
        Source::Company {
            version,
            valid_from,
        } => rows.iter().find(|r| {
            r.scope == "company"
                && r.version_no == i64::from(*version)
                && r.valid_from == valid_from.to_string()
        }),
        Source::ProjectOverride { valid_from } => rows.iter().find(|r| {
            r.scope == "project"
                && r.project_id == project_id
                && r.value.is_some()
                && r.valid_from == valid_from.to_string()
        }),
        Source::LineSpecific => None,
    }
    .map(|r| r.id)
}

/// Time entries as usages of `emp_rate`, for the calc-basis impact preview
/// (design §10.5): drafts, submissions and returned entries are pending (they
/// will be costed at approval), approved ones carry the rate they were
/// costed with. An entry dated in a closed month (P6b) is `closed`.
pub(crate) async fn usages(db: &Db, item_key: &str) -> Result<Vec<Usage>, BantoError> {
    if item_key != RATE_ITEM {
        return Ok(Vec::new());
    }
    let closed = crate::closing::closed_months(db).await?;
    // A replaced entry and a returned correction are neither pending nor
    // correction candidates (T11).
    let sql = format!(
        "SELECT t.id, t.project_id, t.work_date, t.status, t.applied_rate \
         FROM time_entries t WHERE {COUNTS}"
    );
    type Row = (i64, Option<i64>, String, String, Option<i64>);
    let rows: Vec<Row> = on_pool!(db, pool => fetch_all!(pool, sql))?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, project, date, status, rate)| {
            Some(Usage {
                id: id.to_string(),
                item: RATE_ITEM.to_string(),
                project: project.map(|p| p.to_string()),
                on: Date::parse(&date)?,
                status: if status == "approved" {
                    UsageStatus::Approved
                } else {
                    UsageStatus::Pending
                },
                closed: closed.contains(&crate::closing::month_of(&date)),
                line_specific: None,
                applied_value: rate,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calc_basis::tests::value;
    use crate::projects::tests::{fixture, input as project_input};
    use crate::projects::ProjectsService;

    async fn setup() -> (Db, TimeEntriesService, i64) {
        let db = fixture().await;
        let p = ProjectsService::new(db.clone())
            .create(project_input("P-001"), Some(1))
            .await
            .unwrap();
        (db.clone(), TimeEntriesService::new(db), p.id)
    }

    fn entry(project: i64, date: &str, minutes: i64) -> TimeEntryInput {
        TimeEntryInput {
            work_date: date.into(),
            project_id: Some(project),
            phase_id: Some(1),
            minutes,
            description: Some("盤図の作成".into()),
            ..Default::default()
        }
    }

    async fn set_rate(db: &Db, item: &str, from: &str, v: i64) {
        CalcBasisService::new(db.clone())
            .add(None, value(item, from, Some(v), "テスト"), Some(1))
            .await
            .unwrap();
    }

    async fn submit_and_approve(svc: &TimeEntriesService, user: i64, id: i64) -> TimeEntry {
        let e = svc.get(id).await.unwrap();
        let e = svc.submit(user, id, e.row_version).await.unwrap();
        svc.decide(
            &e,
            DecisionInput {
                row_version: e.row_version,
                approve: true,
                reason: None,
            },
            Some(1),
        )
        .await
        .unwrap()
    }

    fn fields(err: BantoError) -> Vec<String> {
        match err {
            BantoError::Validation { field_errors } => {
                field_errors.into_iter().map(|e| e.field).collect()
            }
            other => panic!("validation expected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn t02_approval_fixes_rate_and_labor_cost() {
        let (db, svc, p) = setup().await;
        set_rate(&db, "emp_rate", "2026-06-01", 5_000).await;
        let mut ids = Vec::new();
        for day in 1..=20 {
            let date = format!("2026-11-{day:02}");
            let saved = svc.create(2, entry(p, &date, 7 * 60)).await.unwrap();
            assert_eq!(saved.entry.status, "draft");
            ids.push(saved.entry.id);
        }
        for id in &ids {
            let e = submit_and_approve(&svc, 2, *id).await;
            assert_eq!(e.status, "approved");
            assert_eq!(e.applied_rate, Some(5_000));
            assert_eq!(e.labor_cost, Some(35_000));
            assert_eq!(e.decided_by_name.as_deref(), Some("管理者"));
        }
        let sql = "SELECT COUNT(*) FROM time_entries WHERE applied_calc_value_id = 1".to_string();
        let linked: i64 = on_pool!(&db, pool => scalar!(pool, sql)).unwrap();
        assert_eq!(
            linked, 20,
            "the calc_values row used is kept with each entry"
        );
        let s = svc.project_summary(p).await.unwrap();
        assert_eq!(s.total.approved.minutes, 140 * 60);
        assert_eq!(s.total.labor_cost, 700_000);
        assert!(s.total.complete);
        assert_eq!(s.phases.len(), 1);
        assert_eq!(s.phases[0].phase_name.as_deref(), Some("設計"));
    }

    #[tokio::test]
    async fn t03_rate_by_work_date_and_approved_values_stay() {
        let (db, svc, p) = setup().await;
        set_rate(&db, "emp_rate", "2026-06-01", 5_000).await;
        let nov = svc.create(2, entry(p, "2026-11-30", 60)).await.unwrap();
        let nov = submit_and_approve(&svc, 2, nov.entry.id).await;
        set_rate(&db, "emp_rate", "2026-12-01", 5_400).await;
        let dec = svc.create(2, entry(p, "2026-12-01", 60)).await.unwrap();
        let dec = submit_and_approve(&svc, 2, dec.entry.id).await;
        assert_eq!(dec.labor_cost, Some(5_400));
        // A version back-dated over the approved November entry does not touch it.
        set_rate(&db, "emp_rate", "2026-11-01", 6_000).await;
        assert_eq!(svc.get(nov.id).await.unwrap().labor_cost, Some(5_000));
        let preview = CalcBasisService::new(db.clone())
            .preview(None, value("emp_rate", "2026-10-01", Some(4_000), "x"))
            .await
            .unwrap();
        assert_eq!(
            preview.correction_candidates, 0,
            "Oct value is shadowed by Nov"
        );
        let preview = CalcBasisService::new(db.clone())
            .preview(None, value("emp_rate", "2026-11-15", Some(4_000), "x"))
            .await
            .unwrap();
        assert_eq!(
            preview.correction_candidates, 1,
            "T33: the approved Nov 30 entry becomes a correction candidate"
        );
    }

    #[tokio::test]
    async fn t04_no_rate_and_pending_are_not_zero_cost() {
        let (db, svc, p) = setup().await;
        let a = svc.create(2, entry(p, "2026-11-09", 480)).await.unwrap();
        let a = submit_and_approve(&svc, 2, a.entry.id).await;
        assert_eq!(a.labor_cost, None);
        assert!(a.cost_missing);
        let b = svc.create(2, entry(p, "2026-11-10", 120)).await.unwrap();
        svc.submit(2, b.entry.id, b.entry.row_version)
            .await
            .unwrap();
        svc.create(2, entry(p, "2026-11-11", 30)).await.unwrap();
        let s = svc.project_summary(p).await.unwrap();
        assert_eq!(s.total.labor_cost, 0);
        assert_eq!(s.total.missing_rate.minutes, 480);
        assert_eq!(s.total.submitted.minutes, 120);
        assert_eq!(s.total.unsubmitted.minutes, 30);
        assert!(!s.total.complete);
        // Adding a rate later: one pending to cost at approval, one candidate.
        let preview = CalcBasisService::new(db)
            .preview(None, value("emp_rate", "2026-06-01", Some(5_000), "x"))
            .await
            .unwrap();
        assert_eq!(preview.pending, 2);
        assert_eq!(preview.correction_candidates, 1);
        assert_eq!(preview.affected_projects, 1);
    }

    #[tokio::test]
    async fn checks_unit_day_limit_and_targets() {
        let (db, svc, p) = setup().await;
        CalcBasisService::new(db.clone())
            .add(
                None,
                value("time_unit", "2026-06-01", Some(15), "15分"),
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(
            fields(svc.create(2, entry(p, "2026-11-09", 20)).await.unwrap_err()),
            ["minutes"]
        );
        assert_eq!(
            fields(svc.create(2, entry(p, "2026-11-09", 0)).await.unwrap_err()),
            ["minutes"]
        );
        svc.create(2, entry(p, "2026-11-09", 23 * 60))
            .await
            .unwrap();
        assert_eq!(
            fields(svc.create(2, entry(p, "2026-11-09", 75)).await.unwrap_err()),
            ["minutes"],
            "over 24 hours in a day"
        );
        // Someone else's day is separate.
        svc.create(1, entry(p, "2026-11-09", 60)).await.unwrap();
        let mut both = entry(p, "2026-11-10", 60);
        both.activity_id = Some(1);
        assert_eq!(
            fields(svc.create(2, both).await.unwrap_err()),
            ["projectId"]
        );
        let mut no_phase = entry(p, "2026-11-10", 60);
        no_phase.phase_id = None;
        assert_eq!(
            fields(svc.create(2, no_phase).await.unwrap_err()),
            ["phaseId"]
        );
        let activity = TimeEntryInput {
            work_date: "2026-11-10".into(),
            activity_id: Some(2),
            minutes: 60,
            ..Default::default()
        };
        let saved = svc.create(2, activity).await.unwrap();
        assert_eq!(saved.entry.activity_name.as_deref(), Some("教育"));
        let mut bad_rework = entry(p, "2026-11-10", 60);
        bad_rework.rework_kind = Some("x".into());
        assert_eq!(
            fields(svc.create(2, bad_rework).await.unwrap_err()),
            ["reworkKind"]
        );
    }

    #[tokio::test]
    async fn duplicate_and_standard_day_are_warnings() {
        let (db, svc, p) = setup().await;
        set_rate(&db, "day_minutes", "2026-06-01", 480).await;
        let first = svc.create(2, entry(p, "2026-11-09", 240)).await.unwrap();
        assert_eq!(
            first.warnings,
            vec![WarningView::DayStandard {
                total: 240,
                standard: 480
            }]
        );
        let second = svc.create(2, entry(p, "2026-11-09", 240)).await.unwrap();
        assert_eq!(
            second.warnings,
            vec![WarningView::Duplicate {
                ids: vec![first.entry.id]
            }],
            "a second piece of work the same day is allowed, with a warning"
        );
    }

    #[tokio::test]
    async fn t13_retry_and_stale_versions() {
        let (_, svc, p) = setup().await;
        let mut input = entry(p, "2026-11-09", 60);
        input.client_request_id = Some("req-1".into());
        let a = svc.create(2, input.clone()).await.unwrap();
        let b = svc.create(2, input).await.unwrap();
        assert!(b.replayed);
        assert_eq!(a.entry.id, b.entry.id);
        assert_eq!(
            svc.list_own(2, "2026-11-09", "2026-11-09")
                .await
                .unwrap()
                .len(),
            1
        );

        let mut change = entry(p, "2026-11-09", 90);
        change.row_version = Some(a.entry.row_version);
        svc.update(2, a.entry.id, change.clone()).await.unwrap();
        assert_eq!(
            fields(svc.update(2, a.entry.id, change).await.unwrap_err()),
            ["rowVersion"]
        );
        assert_eq!(
            fields(
                svc.submit(2, a.entry.id, a.entry.row_version)
                    .await
                    .unwrap_err()
            ),
            ["rowVersion"]
        );
    }

    #[tokio::test]
    async fn workflow_owner_return_and_locked_states() {
        let (_, svc, p) = setup().await;
        let e = svc
            .create(2, entry(p, "2026-11-09", 60))
            .await
            .unwrap()
            .entry;
        // Someone else's entry reads as not found.
        assert!(matches!(
            svc.submit(1, e.id, e.row_version).await,
            Err(BantoError::NotFound { .. })
        ));
        assert!(
            matches!(
                svc.decide(
                    &e,
                    DecisionInput {
                        row_version: e.row_version,
                        approve: true,
                        reason: None
                    },
                    Some(1)
                )
                .await,
                Err(BantoError::Validation { .. })
            ),
            "a draft cannot be decided"
        );
        let s = svc.submit(2, e.id, e.row_version).await.unwrap();
        let mut edit = entry(p, "2026-11-09", 90);
        edit.row_version = Some(s.row_version);
        assert_eq!(
            fields(svc.update(2, e.id, edit).await.unwrap_err()),
            ["status"]
        );
        assert_eq!(
            fields(
                svc.decide(
                    &s,
                    DecisionInput {
                        row_version: s.row_version,
                        approve: false,
                        reason: Some(" ".into())
                    },
                    Some(1)
                )
                .await
                .unwrap_err()
            ),
            ["reason"]
        );
        let r = svc
            .decide(
                &s,
                DecisionInput {
                    row_version: s.row_version,
                    approve: false,
                    reason: Some("工程が違います".into()),
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(r.status, "returned");
        assert_eq!(r.return_reason.as_deref(), Some("工程が違います"));
        // Returned: the owner can edit, resubmit, or delete.
        let mut fix = entry(p, "2026-11-09", 60);
        fix.phase_id = Some(2);
        fix.row_version = Some(r.row_version);
        let fixed = svc.update(2, e.id, fix).await.unwrap().entry;
        assert_eq!(fixed.phase_name.as_deref(), Some("ソフト開発"));
        let approved = submit_and_approve(&svc, 2, e.id).await;
        assert!(
            matches!(
                svc.delete(2, e.id, approved.row_version).await,
                Err(BantoError::Validation { .. })
            ),
            "an approved entry is never deleted"
        );
        let d = svc
            .create(2, entry(p, "2026-11-10", 60))
            .await
            .unwrap()
            .entry;
        svc.delete(2, d.id, d.row_version).await.unwrap();
        assert!(matches!(
            svc.get(d.id).await,
            Err(BantoError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn approvals_follow_the_scope() {
        let (_, svc, p) = setup().await;
        let e = svc
            .create(2, entry(p, "2026-11-09", 60))
            .await
            .unwrap()
            .entry;
        svc.submit(2, e.id, e.row_version).await.unwrap();
        let a = svc
            .create(
                2,
                TimeEntryInput {
                    work_date: "2026-11-09".into(),
                    activity_id: Some(1),
                    minutes: 30,
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .entry;
        svc.submit(2, a.id, a.row_version).await.unwrap();
        assert_eq!(
            svc.approvals(&ProjectScope::All, true).await.unwrap().len(),
            2
        );
        let only = ProjectScope::Only([p].into_iter().collect());
        let got = svc.approvals(&only, false).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].project_id, Some(p));
        let none = ProjectScope::Only(Default::default());
        assert!(svc.approvals(&none, false).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn inactive_masters_settled_projects_and_ranges() {
        let (db, svc, p) = setup().await;
        let masters = WorkMastersService::new(db.clone());
        let phase = masters.get(MasterKind::Phases, 1).await.unwrap();
        masters
            .update(
                MasterKind::Phases,
                1,
                crate::work_masters::WorkMasterInput {
                    name: phase.name,
                    sort_order: phase.sort_order,
                    active: false,
                    row_version: Some(phase.row_version),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            fields(svc.create(2, entry(p, "2026-11-09", 60)).await.unwrap_err()),
            ["phaseId"]
        );
        let sql = svc.sql("UPDATE projects SET status = 'settled' WHERE id = ?");
        on_pool!(&db, pool => execute!(pool, sql, p)).unwrap();
        let mut other_phase = entry(p, "2026-11-09", 60);
        other_phase.phase_id = Some(2);
        assert_eq!(
            fields(svc.create(2, other_phase).await.unwrap_err()),
            ["projectId"]
        );
        assert!(svc.list_own(2, "2026-11-01", "2027-01-31").await.is_err());
        assert!(svc.list_own(2, "2026-11-09", "2026-11-01").await.is_err());
        assert!(svc
            .list_own(2, "2026-11-01", "2026-11-30")
            .await
            .unwrap()
            .is_empty());
    }

    async fn deactivate_phase(db: &Db, id: i64) {
        let masters = WorkMastersService::new(db.clone());
        let phase = masters.get(MasterKind::Phases, id).await.unwrap();
        masters
            .update(
                MasterKind::Phases,
                id,
                crate::work_masters::WorkMasterInput {
                    name: phase.name,
                    sort_order: phase.sort_order,
                    active: false,
                    row_version: Some(phase.row_version),
                },
            )
            .await
            .unwrap();
    }

    fn decision(row_version: i64, approve: bool) -> DecisionInput {
        DecisionInput {
            row_version,
            approve,
            reason: (!approve).then(|| "直してください".into()),
        }
    }

    #[tokio::test]
    async fn returned_entry_keeps_its_discontinued_phase() {
        let (db, svc, p) = setup().await;
        let e = svc
            .create(2, entry(p, "2026-11-09", 60))
            .await
            .unwrap()
            .entry;
        let s = svc.submit(2, e.id, e.row_version).await.unwrap();
        let r = svc
            .decide(&s, decision(s.row_version, false), Some(1))
            .await;
        let r = r.unwrap();
        deactivate_phase(&db, 1).await;
        // The phase it already has stays usable for the correction…
        let mut fix = entry(p, "2026-11-09", 90);
        fix.row_version = Some(r.row_version);
        let fixed = svc.update(2, e.id, fix).await.unwrap().entry;
        assert_eq!((fixed.phase_id, fixed.minutes), (Some(1), 90));
        // …but is not offered to a new entry.
        assert_eq!(
            fields(svc.create(2, entry(p, "2026-11-10", 60)).await.unwrap_err()),
            ["phaseId"]
        );
    }

    #[tokio::test]
    async fn settled_project_refuses_submit_and_approval() {
        let (db, svc, p) = setup().await;
        let draft = svc
            .create(2, entry(p, "2026-11-09", 60))
            .await
            .unwrap()
            .entry;
        let other = svc
            .create(2, entry(p, "2026-11-10", 60))
            .await
            .unwrap()
            .entry;
        let s = svc.submit(2, other.id, other.row_version).await.unwrap();
        let sql = svc.sql("UPDATE projects SET status = 'settled' WHERE id = ?");
        on_pool!(&db, pool => execute!(pool, sql, p)).unwrap();
        assert_eq!(
            fields(
                svc.submit(2, draft.id, draft.row_version)
                    .await
                    .unwrap_err()
            ),
            ["projectId"]
        );
        assert_eq!(
            fields(
                svc.decide(&s, decision(s.row_version, true), Some(1))
                    .await
                    .unwrap_err()
            ),
            ["projectId"]
        );
        // Returning it is still possible, so the owner learns why.
        let r = svc
            .decide(&s, decision(s.row_version, false), Some(1))
            .await;
        assert_eq!(r.unwrap().status, "returned");
    }

    #[tokio::test]
    async fn decision_applies_only_to_the_authorized_version() {
        let (_db, svc, p) = setup().await;
        let e = svc
            .create(2, entry(p, "2026-11-09", 60))
            .await
            .unwrap()
            .entry;
        let authorized = svc.submit(2, e.id, e.row_version).await.unwrap();
        // Meanwhile it is returned, corrected and submitted again.
        let r = svc
            .decide(
                &authorized,
                decision(authorized.row_version, false),
                Some(1),
            )
            .await
            .unwrap();
        let mut fix = entry(p, "2026-11-09", 30);
        fix.row_version = Some(r.row_version);
        let fixed = svc.update(2, e.id, fix).await.unwrap().entry;
        let current = svc.submit(2, e.id, fixed.row_version).await.unwrap();
        // A decision checked against the earlier row is stale even when the
        // client sends the current version.
        assert_eq!(
            fields(
                svc.decide(&authorized, decision(current.row_version, true), Some(1))
                    .await
                    .unwrap_err()
            ),
            ["rowVersion"]
        );
        assert_eq!(svc.get(e.id).await.unwrap().status, "submitted");
    }

    fn correction(from: &TimeEntry, minutes: i64, reason: Option<&str>) -> CorrectionInput {
        CorrectionInput {
            entry: TimeEntryInput {
                work_date: from.work_date.clone(),
                project_id: from.project_id,
                activity_id: from.activity_id,
                phase_id: from.phase_id,
                minutes,
                description: from.description.clone(),
                row_version: Some(from.row_version),
                ..Default::default()
            },
            reason: reason.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn t11_correction_replaces_the_entry_only_once_approved() {
        let (db, svc, p) = setup().await;
        // Approved without a rate: 原価未確定, the P6a case a correction resolves.
        let e = svc.create(2, entry(p, "2026-11-09", 120)).await.unwrap();
        let original = submit_and_approve(&svc, 2, e.entry.id).await;
        assert!(original.cost_missing);
        set_rate(&db, "emp_rate", "2026-06-01", 6_000).await;

        let c = svc
            .correct(
                2,
                original.id,
                correction(&original, 90, Some("時間の誤り")),
            )
            .await
            .unwrap()
            .entry;
        assert_eq!(c.status, "submitted");
        assert_eq!(c.corrects_id, Some(original.id));
        assert_eq!(c.correction_reason.as_deref(), Some("時間の誤り"));
        assert!(svc.get(original.id).await.unwrap().correction_pending);
        assert_eq!(
            svc.get(original.id).await.unwrap().row_version,
            original.row_version + 1,
            "the request touches the entry, so settlement and closing see it"
        );
        // Until approved, the entry still counts and the correction is pending.
        let s = svc.project_summary(p).await.unwrap();
        assert_eq!(s.total.approved.minutes, 120);
        assert_eq!(s.total.submitted.minutes, 90);
        // Managers' approval list leaves it to accounting's.
        assert!(svc
            .approvals(&ProjectScope::All, true)
            .await
            .unwrap()
            .is_empty());
        let pending = svc.pending_corrections().await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].original.id, original.id);
        assert_eq!(pending[0].original.minutes, 120);

        let approved = svc
            .decide(&c, decision(c.row_version, true), Some(1))
            .await
            .unwrap();
        assert_eq!(approved.labor_cost, Some(9_000), "the rate is fixed anew");
        let before = svc.get(original.id).await.unwrap();
        assert_eq!(before.replaced_by_id, Some(c.id));
        assert_eq!(
            (before.minutes, before.labor_cost),
            (120, None),
            "the replaced entry keeps its approved values"
        );
        let s = svc.project_summary(p).await.unwrap();
        assert_eq!(s.total.approved.minutes, 90);
        assert_eq!(s.total.labor_cost, 9_000);
        assert!(s.total.complete);
        // The chain, newest first; the replaced entry cannot be corrected again.
        let chain = svc.corrections_of(2, original.id).await.unwrap();
        assert_eq!(chain.iter().map(|e| e.id).collect::<Vec<_>>(), [c.id]);
        assert_eq!(
            fields(
                svc.correct(2, original.id, correction(&before, 60, Some("x")))
                    .await
                    .unwrap_err()
            ),
            ["status"]
        );
        // The correction is the one to correct next.
        let again = svc
            .correct(
                2,
                approved.id,
                correction(&approved, 60, Some("さらに訂正")),
            )
            .await
            .unwrap()
            .entry;
        assert_eq!(again.corrects_id, Some(approved.id));
        // A replaced entry is not a correction candidate of the calc basis.
        let preview = CalcBasisService::new(db.clone())
            .preview(None, value("emp_rate", "2026-11-01", Some(7_000), "x"))
            .await
            .unwrap();
        assert_eq!(preview.correction_candidates, 1);
        assert_eq!(preview.pending, 1);
    }

    #[tokio::test]
    async fn t11_correction_needs_an_approved_entry_a_reason_and_no_other_pending() {
        let (_db, svc, p) = setup().await;
        let draft = svc
            .create(2, entry(p, "2026-11-09", 60))
            .await
            .unwrap()
            .entry;
        assert_eq!(
            fields(
                svc.correct(2, draft.id, correction(&draft, 30, Some("x")))
                    .await
                    .unwrap_err()
            ),
            ["status"],
            "before approval the normal flow fixes it"
        );
        let original = submit_and_approve(&svc, 2, draft.id).await;
        assert!(matches!(
            svc.correct(1, original.id, correction(&original, 30, Some("x")))
                .await,
            Err(BantoError::NotFound { .. })
        ));
        assert_eq!(
            fields(
                svc.correct(2, original.id, correction(&original, 30, Some(" ")))
                    .await
                    .unwrap_err()
            ),
            ["reason"]
        );
        let mut stale = correction(&original, 30, Some("x"));
        stale.entry.row_version = Some(original.row_version - 1);
        assert_eq!(
            fields(svc.correct(2, original.id, stale).await.unwrap_err()),
            ["rowVersion"]
        );
        let c = svc
            .correct(2, original.id, correction(&original, 30, Some("x")))
            .await
            .unwrap()
            .entry;
        assert_eq!(
            fields(
                svc.correct(
                    2,
                    original.id,
                    correction(&svc.get(original.id).await.unwrap(), 45, Some("y"))
                )
                .await
                .unwrap_err()
            ),
            ["status"],
            "one correction in flight"
        );
        // Returned: history only, not unprocessed, never edited.
        let r = svc
            .decide(&c, decision(c.row_version, false), Some(1))
            .await
            .unwrap();
        assert_eq!(r.status, "returned");
        let s = svc.project_summary(p).await.unwrap();
        assert_eq!(s.total.approved.minutes, 60);
        assert_eq!(s.total.unsubmitted.count, 0);
        let mut edit = entry(p, "2026-11-09", 45);
        edit.row_version = Some(r.row_version);
        assert_eq!(
            fields(svc.update(2, r.id, edit).await.unwrap_err()),
            ["status"]
        );
        assert_eq!(
            fields(svc.delete(2, r.id, r.row_version).await.unwrap_err()),
            ["status"]
        );
        // A new correction can be requested; both stay in the chain.
        let c2 = svc
            .correct(
                2,
                original.id,
                correction(&svc.get(original.id).await.unwrap(), 45, Some("y")),
            )
            .await
            .unwrap()
            .entry;
        let chain = svc.corrections_of(2, original.id).await.unwrap();
        assert_eq!(
            chain.iter().map(|e| e.id).collect::<Vec<_>>(),
            [c2.id, c.id]
        );
    }

    #[tokio::test]
    async fn t11_correction_moves_hours_and_checks_the_day() {
        let (db, svc, p) = setup().await;
        let other = ProjectsService::new(db.clone())
            .create(project_input("P-002"), Some(1))
            .await
            .unwrap()
            .id;
        let e = svc
            .create(2, entry(p, "2026-11-09", 23 * 60))
            .await
            .unwrap()
            .entry;
        let original = submit_and_approve(&svc, 2, e.id).await;
        // The replaced minutes do not count against the corrected day.
        let mut moved = correction(&original, 23 * 60 + 30, Some("案件の誤り"));
        moved.entry.project_id = Some(other);
        let c = svc.correct(2, original.id, moved).await.unwrap().entry;
        // While it waits, the project it moves hours away from cannot be
        // settled either (PR #24 review).
        let sql = svc.sql("UPDATE projects SET status = 'work_done' WHERE id = ?");
        on_pool!(&db, pool => execute!(pool, sql, p)).unwrap();
        let check = crate::closeouts::CloseoutsService::new(db.clone())
            .check(p)
            .await
            .unwrap();
        let unapproved = check
            .blockers
            .iter()
            .find(|b| b.kind == "unapproved")
            .expect("the waiting correction blocks the settlement");
        assert_eq!(unapproved.time_entries, Some(1));
        svc.decide(&c, decision(c.row_version, true), Some(1))
            .await
            .unwrap();
        assert_eq!(
            svc.project_summary(p).await.unwrap().total.approved.count,
            0
        );
        assert_eq!(
            svc.project_summary(other)
                .await
                .unwrap()
                .total
                .approved
                .minutes,
            23 * 60 + 30
        );
        // The replaced entry no longer fills the day either.
        assert_eq!(
            fields(svc.create(2, entry(p, "2026-11-09", 60)).await.unwrap_err()),
            ["minutes"],
            "23:30 + 1:00 is over 24 hours"
        );
        svc.create(2, entry(p, "2026-11-09", 30)).await.unwrap();
    }

    #[tokio::test]
    async fn t11_a_closed_month_is_corrected_after_reopening() {
        use crate::closing::{CloseInput, ClosingService, ReopenInput};
        let (db, svc, p) = setup().await;
        let e = svc
            .create(2, entry(p, "2026-10-05", 60))
            .await
            .unwrap()
            .entry;
        let original = submit_and_approve(&svc, 2, e.id).await;
        let closing = ClosingService::new(db.clone());
        closing
            .close("2026-10", CloseInput { row_version: 1 }, Some(1))
            .await
            .unwrap();
        let mut moved = correction(&original, 60, Some("日付の誤り"));
        moved.entry.work_date = "2026-11-05".into();
        assert_eq!(
            fields(
                svc.correct(2, original.id, moved.clone())
                    .await
                    .unwrap_err()
            ),
            ["workDate"],
            "the replaced entry's month is closed"
        );
        let m = closing.get("2026-10").await.unwrap();
        closing
            .reopen(
                "2026-10",
                ReopenInput {
                    row_version: m.row_version,
                    reason: "工数の訂正".into(),
                },
                Some(1),
            )
            .await
            .unwrap();
        let c = svc.correct(2, original.id, moved).await.unwrap().entry;
        // A correction in flight blocks closing both months: the one it
        // moves the hours to and the one of the entry it replaces (PR #24).
        assert_eq!(
            closing
                .get("2026-10")
                .await
                .unwrap()
                .unapproved_time_entries,
            1
        );
        assert_eq!(
            closing
                .get("2026-11")
                .await
                .unwrap()
                .unapproved_time_entries,
            1
        );
        svc.decide(&c, decision(c.row_version, true), Some(1))
            .await
            .unwrap();
        let m = closing.get("2026-10").await.unwrap();
        assert!(m.can_close);
        let closed = closing
            .close(
                "2026-10",
                CloseInput {
                    row_version: m.row_version,
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(
            closed.total.labor_missing, 0,
            "the replaced entry left October"
        );
    }

    #[tokio::test]
    async fn t11_a_waiting_correction_does_not_fill_the_day_twice() {
        let (_db, svc, p) = setup().await;
        let mut ids = Vec::new();
        for _ in 0..2 {
            let e = svc
                .create(2, entry(p, "2026-11-09", 12 * 60))
                .await
                .unwrap()
                .entry;
            ids.push(submit_and_approve(&svc, 2, e.id).await);
        }
        // PR #24 review: both corrections of a full day can wait at once.
        let c1 = svc
            .correct(
                2,
                ids[0].id,
                correction(&ids[0], 12 * 60, Some("工程の誤り")),
            )
            .await
            .unwrap()
            .entry;
        let c2 = svc
            .correct(
                2,
                ids[1].id,
                correction(&ids[1], 12 * 60, Some("工程の誤り")),
            )
            .await
            .unwrap()
            .entry;
        assert_eq!(
            fields(svc.create(2, entry(p, "2026-11-09", 30)).await.unwrap_err()),
            ["minutes"],
            "the day is still full with the approved entries"
        );
        svc.decide(&c1, decision(c1.row_version, true), Some(1))
            .await
            .unwrap();
        svc.decide(&c2, decision(c2.row_version, true), Some(1))
            .await
            .unwrap();
        // A correction that would overfill the day is refused at approval:
        // 11h corrected to 12h is fine on its own (12 + 12), but an hour
        // entered while it waited (12 + 11 + 1) leaves no room for it.
        let e = svc
            .create(2, entry(p, "2026-11-10", 12 * 60))
            .await
            .unwrap()
            .entry;
        submit_and_approve(&svc, 2, e.id).await;
        let e = svc
            .create(2, entry(p, "2026-11-10", 11 * 60))
            .await
            .unwrap()
            .entry;
        let short = submit_and_approve(&svc, 2, e.id).await;
        let longer = svc
            .correct(2, short.id, correction(&short, 12 * 60, Some("時間の誤り")))
            .await
            .unwrap()
            .entry;
        svc.create(2, entry(p, "2026-11-10", 60)).await.unwrap();
        assert_eq!(
            fields(
                svc.decide(&longer, decision(longer.row_version, true), Some(1))
                    .await
                    .unwrap_err()
            ),
            ["minutes"]
        );
        assert_eq!(svc.get(longer.id).await.unwrap().status, "submitted");
    }
}
