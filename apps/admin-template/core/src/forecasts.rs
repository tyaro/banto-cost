//! Completion forecast versions (完了見込版, banto-cost P5,
//! `docs/project/design.md` §3.4, spec §6.5・§6.6・§7.1, T06・T28・T30).
//!
//! Service-layer shape (conventions §2): `Clone`, `BantoError`, sqlx, no
//! tauri/axum. The rules live in `cost_domain::forecast` (remaining input
//! checks, merging, pricing, the adoption check, 見込更新要); this module
//! loads and stores rows. Authorization (`ViewProjectAmounts`,
//! `ManageProject`, `AdoptForecast`, ADR-0028) and audit are the REST/Tauri
//! wiring's.
//!
//! Workflow: a project has at most one draft. The draft holds a base date,
//! the planned end and the remaining input (残工数・それ以外の見込み); its
//! actuals (approved hours and direct costs up to the base date) and its
//! commitments (purchase-order remainders at the base date) are read on
//! every read, so the same cost is never typed in twice (spec §6.5).
//! Adopting it (採用) gives it the next version number and fixes the whole
//! set for that base date — actuals, commitments, the forecast rate and its
//! calc_values row, the confirmed order amount and the current approved
//! budget. An adopted version is never rewritten: later actuals, corrections
//! of earlier ones, a rate change or an order change only flag 見込更新要
//! (T30) and the next draft re-estimates (T28).
//!
//! Concurrency (T13): writes to a draft compare `row_version`; a second
//! "create draft" returns the existing draft (one-draft index). The
//! adoption checks the version number in its transaction (Postgres locks
//! the project row).

use std::collections::BTreeMap;

use banto_core::{BantoError, FieldError};
use banto_server::ServerEvent;
use banto_storage::{Db, Dialect};
use cost_domain::budget::LineKey;
use cost_domain::calc_basis::{Usage, UsageStatus};
use cost_domain::forecast::{
    check_adoption, check_base_date, merge_lines, next_version, overrun, price_lines, profit,
    summarize, update_reasons, validate_remaining, AdoptedFacts, AdoptionIssue, CostType,
    KeyedLine, PricedForecastLine, RemainingInput, RemainingIssue, UpdateReason, RATE_ITEM,
};
use cost_domain::project::ProjectStatus;
use cost_domain::Date;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::calc_basis::applied_value;
use crate::customers::{clean_optional, field_error, now_expr, stale_version_error};
use crate::direct_costs::{DirectCostsService, Ledger};
use crate::orders::{
    execute, fetch_all, fetch_optional, in_tx, on_pool, placeholders, scalar, OrdersService,
    MAX_TEXT_LEN,
};
use crate::work_masters::{MasterKind, WorkMastersService};

pub const RESOURCE: &str = "forecasts";

/// One phase × cost type row of a version.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastLine {
    pub phase_id: Option<i64>,
    pub phase_name: Option<String>,
    /// `labor` | `material` | `outsource` | `travel` | `other`.
    pub cost_type: String,
    /// Approved actuals up to the base date.
    pub actual: i64,
    /// Purchase-order remainder at the base date (発注済み未実績).
    pub committed: i64,
    pub remaining_minutes: Option<i64>,
    /// それ以外に必要な見込み (non-labor).
    pub other_remaining: Option<i64>,
    /// Remaining minutes × forecast rate; `None` = no rate (未確定, never 0).
    pub labor_remaining: Option<i64>,
    /// committed + other + labor remaining; `None` while the labor is 未確定.
    pub remaining: Option<i64>,
    /// actual + remaining.
    pub total: Option<i64>,
}

/// One remaining input row (what the draft editor sends back).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemainingLine {
    pub phase_id: Option<i64>,
    pub phase_name: Option<String>,
    pub cost_type: String,
    pub remaining_minutes: Option<i64>,
    pub amount: Option<i64>,
}

/// Per cost type totals of a version.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeTotal {
    pub cost_type: String,
    pub actual: i64,
    pub committed: i64,
    /// `None` while the remaining labor is 未確定.
    pub remaining: Option<i64>,
    pub total: Option<i64>,
}

/// One forecast version (draft or adopted). Amounts: `ViewProjectAmounts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastVersion {
    pub id: i64,
    pub project_id: i64,
    /// `None` while a draft.
    pub version_no: Option<i64>,
    /// `draft` | `adopted`.
    pub status: String,
    pub base_date: String,
    pub planned_end: Option<String>,
    pub reason: Option<String>,
    /// The forecast rate on the base date (fixed on an adopted version).
    pub forecast_rate: Option<i64>,
    /// The confirmed order amount (fixed at adoption; a draft shows today's).
    pub order_amount: Option<i64>,
    pub budget_version_no: Option<i64>,
    /// The approved cost budget the version is compared with.
    pub budget_total: Option<i64>,
    pub actual_total: i64,
    pub committed_total: i64,
    /// `None` while the remaining labor is 未確定 (draft only).
    pub remaining_total: Option<i64>,
    /// 完了見込原価.
    pub cost_total: Option<i64>,
    /// 完了見込直接利益 against `order_amount`.
    pub profit: Option<i64>,
    /// Permille; `None` = 算出不可.
    pub profit_ratio_permille: Option<i64>,
    /// 完了見込超過額 = cost − budget (plus = over).
    pub overrun: Option<i64>,
    /// The actuals up to the base date were final (no hour without a rate,
    /// nothing waiting for approval, no provisional); otherwise 暫定・不足あり.
    pub actual_complete: bool,
    /// A remaining labor line has no forecast rate (draft only).
    pub rate_missing: bool,
    /// Live tallies up to the base date (draft only; 0 on adopted versions).
    pub pending_count: i64,
    pub provisional_count: i64,
    pub missing_rate_count: i64,
    pub by_cost_type: Vec<TypeTotal>,
    pub lines: Vec<ForecastLine>,
    pub inputs: Vec<RemainingLine>,
    pub created_by_name: Option<String>,
    /// Who last saved the draft: the requester of its adoption.
    pub updated_by: Option<i64>,
    pub updated_by_name: Option<String>,
    pub adopted_by_name: Option<String>,
    pub adopted_at: Option<String>,
    pub row_version: i64,
    pub updated_at: String,
}

impl ForecastVersion {
    /// What both wiring layers record: no amounts.
    pub fn audit_detail(&self) -> serde_json::Value {
        serde_json::json!({
            "projectId": self.project_id,
            "versionNo": self.version_no,
            "status": self.status,
            "baseDate": self.base_date,
            "lines": self.inputs.len(),
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastLineInput {
    #[serde(default)]
    pub phase_id: Option<i64>,
    pub cost_type: String,
    #[serde(default)]
    pub remaining_minutes: Option<i64>,
    #[serde(default)]
    pub amount: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastDraftInput {
    pub base_date: String,
    #[serde(default)]
    pub planned_end: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub lines: Vec<ForecastLineInput>,
    pub row_version: i64,
}

/// `rowVersion` for delete / adopt.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastVersionInput {
    pub row_version: i64,
}

/// A created draft; `replayed` = the project already had one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastDraftCreated {
    pub draft: ForecastVersion,
    pub replayed: bool,
}

/// One cost type of the comparison (spec §6.6 step 5: 当初予算・現在予算・
/// 前回見込・今回見込, and the latest actuals in their own column).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonRow {
    pub cost_type: String,
    pub original_budget: Option<i64>,
    pub current_budget: Option<i64>,
    pub previous: Option<i64>,
    pub latest: Option<i64>,
    pub draft: Option<i64>,
    /// Every approved actual, whatever its date (最新実績). Never added to
    /// an adopted version's remaining (T30).
    pub latest_actual: i64,
}

/// 案件詳細 → 完了見込. Amounts: `ViewProjectAmounts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastOverview {
    pub project_id: i64,
    pub project_status: String,
    /// 現在の確定受注額.
    pub order_amount: Option<i64>,
    /// 未確定追加売上 (never part of the profit, T07).
    pub pending_addition: i64,
    pub budget_original_total: Option<i64>,
    pub budget_current_total: Option<i64>,
    pub budget_current_version_no: Option<i64>,
    /// The latest adopted version (the standard reports use it).
    pub latest: Option<ForecastVersion>,
    /// The adopted version before it.
    pub previous: Option<ForecastVersion>,
    /// Every adopted version, newest first.
    pub history: Vec<ForecastVersion>,
    pub draft: Option<ForecastVersion>,
    pub latest_actual_total: i64,
    /// [`UpdateReason`] codes for the latest version (empty = up to date).
    pub update_reasons: Vec<String>,
    /// Current confirmed order − the latest version's cost (spec §7.1).
    pub current_profit: Option<i64>,
    pub current_profit_ratio_permille: Option<i64>,
    /// The latest version's cost − the current approved budget.
    pub current_overrun: Option<i64>,
    /// The latest version's cost − the previous version's.
    pub change_from_previous: Option<i64>,
    pub comparison: Vec<ComparisonRow>,
}

/// What the overall list (全体一覧) takes from a project's forecast.
#[derive(Debug, Clone, PartialEq)]
pub struct ForecastSummary {
    pub latest: Option<AdoptedSummary>,
    pub update_reasons: Vec<UpdateReason>,
    /// Every approved actual (labor + direct), whatever its date.
    pub latest_actual_total: i64,
    /// No approved hour without a rate, nothing pending, no provisional.
    pub latest_actual_complete: bool,
    /// Hours and direct costs not approved yet (any date).
    pub unapproved: i64,
    /// Purchase-order remainders now (未実績発注残).
    pub committed: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdoptedSummary {
    pub version_no: i64,
    pub base_date: String,
    pub cost_total: i64,
    pub actual_complete: bool,
}

#[derive(sqlx::FromRow)]
struct VersionRow {
    id: i64,
    project_id: i64,
    version_no: Option<i64>,
    status: String,
    base_date: String,
    planned_end: Option<String>,
    reason: Option<String>,
    forecast_rate: Option<i64>,
    order_amount: Option<i64>,
    budget_version_no: Option<i64>,
    budget_total: Option<i64>,
    actual_total: Option<i64>,
    committed_total: Option<i64>,
    remaining_total: Option<i64>,
    cost_total: Option<i64>,
    actual_complete: Option<i64>,
    created_by_name: Option<String>,
    updated_by: Option<i64>,
    updated_by_name: Option<String>,
    adopted_by_name: Option<String>,
    adopted_at: Option<String>,
    row_version: i64,
    updated_at: String,
}

#[derive(sqlx::FromRow)]
struct LineRow {
    forecast_version_id: i64,
    phase_id: Option<i64>,
    phase_name: Option<String>,
    cost_type: String,
    actual_amount: Option<i64>,
    committed_amount: Option<i64>,
    remaining_minutes: Option<i64>,
    other_remaining: Option<i64>,
    labor_remaining: Option<i64>,
}

const SELECT: &str = "SELECT f.id, f.project_id, f.version_no, f.status, f.base_date, \
     f.planned_end, f.reason, f.forecast_rate, f.order_amount, bv.version_no AS budget_version_no, \
     f.budget_total, f.actual_total, f.committed_total, f.remaining_total, f.cost_total, \
     f.actual_complete, c.display_name AS created_by_name, f.updated_by, \
     u.display_name AS updated_by_name, a.display_name AS adopted_by_name, f.adopted_at, \
     f.row_version, f.updated_at FROM forecast_versions f \
     LEFT JOIN budget_versions bv ON bv.id = f.budget_version_id \
     LEFT JOIN users c ON c.id = f.created_by \
     LEFT JOIN users u ON u.id = f.updated_by \
     LEFT JOIN users a ON a.id = f.adopted_by";

/// Approved actuals and commitments of a project as of a date.
struct Actuals {
    by_key: Vec<(LineKey, i64)>,
    committed: Vec<(LineKey, i64)>,
    total: i64,
    pending: i64,
    provisional: i64,
    missing_rate: i64,
}

impl Actuals {
    fn complete(&self) -> bool {
        self.pending == 0 && self.provisional == 0 && self.missing_rate == 0
    }
}

/// The current approved budget (id, version number, total).
type CurrentBudget = Option<(i64, i64, i64)>;

fn not_found(id: i64) -> BantoError {
    BantoError::NotFound {
        resource: RESOURCE.into(),
        id: id.to_string(),
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

fn status_error(message: &str) -> BantoError {
    BantoError::Validation {
        field_errors: vec![field_error("status", message)],
    }
}

fn remaining_error(issue: &RemainingIssue) -> FieldError {
    let at = |index: &usize, field: &str| format!("lines.{index}.{field}");
    match issue {
        RemainingIssue::TooMany => field_error(
            "lines",
            format!(
                "残見込みは{}行までにしてください",
                cost_domain::forecast::MAX_LINES
            ),
        ),
        RemainingIssue::MinutesInvalid { index } => field_error(
            &at(index, "remainingMinutes"),
            "残工数は0分より長く入力してください",
        ),
        RemainingIssue::LaborWithAmount { index } => field_error(
            &at(index, "amount"),
            "労務の残りは残工数と見込み用単価から計算します。金額は入れません",
        ),
        RemainingIssue::MinutesOnNonLabor { index } => field_error(
            &at(index, "remainingMinutes"),
            "残工数は労務の行だけに入れます",
        ),
        RemainingIssue::AmountNegative { index } => {
            field_error(&at(index, "amount"), "0円以上で入力してください")
        }
        RemainingIssue::Empty { index } => field_error(
            &at(index, "amount"),
            "残工数か金額を入力してください（不要な行は削除します）",
        ),
        RemainingIssue::Duplicate { index } => {
            field_error(&at(index, "costType"), "同じ工程・費目の行がすでにあります")
        }
    }
}

fn adoption_error(issue: &AdoptionIssue) -> FieldError {
    match issue {
        AdoptionIssue::ProjectNotOrdered => field_error(
            "status",
            "受注・進行中・作業完了の案件だけ完了見込を採用できます",
        ),
        AdoptionIssue::RateMissing => field_error(
            "lines",
            "見込み用単価が未設定のため残工数の金額を計算できません。計算基準で見込み用単価を設定してください",
        ),
        AdoptionIssue::ReasonRequired => field_error("reason", "更新理由を入力してください"),
        AdoptionIssue::BaseDateInFuture => {
            field_error("baseDate", "基準日は今日以前の日付にしてください")
        }
        AdoptionIssue::BaseDateBeforePrevious => field_error(
            "baseDate",
            "基準日は前回採用した見込の基準日以降にしてください",
        ),
    }
}

fn key_of(phase: Option<i64>, cost_type: &str) -> Option<LineKey> {
    Some(LineKey {
        phase,
        cost_type: CostType::parse(cost_type)?,
    })
}

fn by_cost_type(lines: &[PricedForecastLine]) -> Vec<TypeTotal> {
    CostType::ALL
        .into_iter()
        .map(|t| {
            let of: Vec<&PricedForecastLine> =
                lines.iter().filter(|l| l.line.key.cost_type == t).collect();
            let remaining: Option<i64> = of.iter().map(|l| l.remaining()).sum();
            let actual: i64 = of.iter().map(|l| l.line.actual).sum();
            TypeTotal {
                cost_type: t.as_str().into(),
                actual,
                committed: of.iter().map(|l| l.line.committed).sum(),
                remaining,
                total: remaining.map(|r| r + actual),
            }
        })
        .collect()
}

#[derive(Clone)]
pub struct ForecastsService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl ForecastsService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    /// Emit `ResourceChanged { resource: "forecasts" }` after each committed write.
    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn notify_changed(&self) {
        crate::events::notify_changed(&self.events, RESOURCE);
    }

    /// The overall list (全体一覧) over the same database.
    pub fn portfolio(&self) -> crate::portfolio::PortfolioService {
        crate::portfolio::PortfolioService::new(self.db.clone())
    }

    /// 精算完了 (P6a) over the same database and event channel.
    pub fn closeouts(&self) -> crate::closeouts::CloseoutsService {
        let svc = crate::closeouts::CloseoutsService::new(self.db.clone());
        match &self.events {
            Some(events) => svc.with_events(events.clone()),
            None => svc,
        }
    }

    /// 月次締め (P6b) over the same database and event channel.
    pub fn closing(&self) -> crate::closing::ClosingService {
        let svc = crate::closing::ClosingService::new(self.db.clone());
        match &self.events {
            Some(events) => svc.with_events(events.clone()),
            None => svc,
        }
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    fn now(&self) -> &'static str {
        now_expr(self.db.dialect())
    }

    /// The business date today (Asia/Tokyo is the server's local time).
    pub(crate) async fn today(&self) -> Result<Date, BantoError> {
        let sql = match self.db.dialect() {
            Dialect::Sqlite => "SELECT date('now','localtime')",
            Dialect::Postgres => "SELECT CURRENT_DATE::text",
        }
        .to_string();
        let today: String = on_pool!(&self.db, pool => scalar!(pool, sql))?;
        Date::parse(&today).ok_or_else(|| BantoError::Other(format!("不明な日付です: {today}")))
    }

    async fn project(
        &self,
        project_id: i64,
    ) -> Result<(ProjectStatus, Option<String>), BantoError> {
        let sql = self.sql("SELECT status, planned_end FROM projects WHERE id = ?");
        let row: Option<(String, Option<String>)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))?;
        let (status, planned_end) = row.ok_or_else(|| BantoError::NotFound {
            resource: "projects".into(),
            id: project_id.to_string(),
        })?;
        let status = ProjectStatus::parse(&status)
            .ok_or_else(|| BantoError::Other(format!("不明な案件の状態です: {status}")))?;
        Ok((status, planned_end))
    }

    /// Drafts exist for ordered projects that are not settled.
    async fn require_open(&self, project_id: i64) -> Result<ProjectStatus, BantoError> {
        let (status, _) = self.project(project_id).await?;
        if !status.is_ordered_open() {
            return Err(status_error(
                "受注・進行中・作業完了の案件だけ完了見込を作れます",
            ));
        }
        Ok(status)
    }

    async fn current_budget(&self, project_id: i64) -> Result<CurrentBudget, BantoError> {
        let sql = self.sql(
            "SELECT id, version_no, total_amount FROM budget_versions \
             WHERE project_id = ? AND status = 'approved' ORDER BY version_no DESC LIMIT 1",
        );
        on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))
    }

    async fn order_now(&self, project_id: i64) -> Result<(Option<i64>, i64), BantoError> {
        let s = OrdersService::new(self.db.clone())
            .summary(project_id)
            .await?;
        Ok((s.confirmed_amount, s.pending_total))
    }

    async fn rate(
        &self,
        project_id: i64,
        on: Date,
    ) -> Result<Option<(i64, Option<i64>)>, BantoError> {
        applied_value(&self.db, RATE_ITEM, Some(project_id), on).await
    }

    /// Approved actuals (labor and direct) and commitments as of `until`.
    async fn actuals(
        &self,
        project_id: i64,
        until: Date,
        ledger: &Ledger,
    ) -> Result<Actuals, BantoError> {
        let on = until.to_string();
        // CAST: Postgres sums BIGINT to NUMERIC.
        let labor_sql = self.sql(
            "SELECT phase_id, CAST(COALESCE(SUM(labor_cost), 0) AS BIGINT), \
             CAST(SUM(CASE WHEN labor_cost IS NULL THEN 1 ELSE 0 END) AS BIGINT) \
             FROM time_entries WHERE project_id = ? AND status = 'approved' AND work_date <= ? \
             GROUP BY phase_id",
        );
        let pending_sql = self.sql(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM time_entries \
             WHERE project_id = ? AND status <> 'approved' AND work_date <= ?",
        );
        let (labor, pending): (Vec<(Option<i64>, i64, i64)>, i64) = on_pool!(&self.db, pool => (
            fetch_all!(pool, labor_sql, project_id, &on)?,
            scalar!(pool, pending_sql, project_id, &on)?,
        ));
        let costs = DirectCostsService::new(self.db.clone())
            .snapshot(project_id, until, ledger)
            .await?;
        let mut by_key: Vec<(LineKey, i64)> = labor
            .iter()
            .map(|(phase, cost, _)| {
                (
                    LineKey {
                        phase: *phase,
                        cost_type: CostType::Labor,
                    },
                    *cost,
                )
            })
            .collect();
        by_key.extend(costs.actual.iter().map(|(phase, t, v)| {
            (
                LineKey {
                    phase: *phase,
                    cost_type: *t,
                },
                *v,
            )
        }));
        let committed = costs
            .committed
            .iter()
            .map(|(phase, t, v)| {
                (
                    LineKey {
                        phase: *phase,
                        cost_type: *t,
                    },
                    *v,
                )
            })
            .collect();
        Ok(Actuals {
            total: by_key.iter().map(|(_, v)| *v).sum(),
            by_key,
            committed,
            pending: pending + costs.pending,
            provisional: costs.provisional,
            missing_rate: labor.iter().map(|r| r.2).sum(),
        })
    }

    async fn lines_of(&self, ids: &[i64]) -> Result<BTreeMap<i64, Vec<LineRow>>, BantoError> {
        let mut out: BTreeMap<i64, Vec<LineRow>> = BTreeMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let marks = vec!["?"; ids.len()].join(",");
        let sql = self.sql(&format!(
            "SELECT l.forecast_version_id, l.phase_id, ph.name AS phase_name, l.cost_type, \
             l.actual_amount, l.committed_amount, l.remaining_minutes, l.other_remaining, \
             l.labor_remaining FROM forecast_lines l LEFT JOIN phases ph ON ph.id = l.phase_id \
             WHERE l.forecast_version_id IN ({marks}) ORDER BY l.forecast_version_id, l.line_no"
        ));
        let rows: Vec<LineRow> = match &self.db {
            Db::Sqlite(pool) => {
                let mut q = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()));
                for id in ids {
                    q = q.bind(*id);
                }
                q.fetch_all(pool)
                    .await
                    .map_err(banto_storage::storage_error)?
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut q = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()));
                for id in ids {
                    q = q.bind(*id);
                }
                q.fetch_all(pool)
                    .await
                    .map_err(banto_storage::storage_error)?
            }
        };
        for r in rows {
            out.entry(r.forecast_version_id).or_default().push(r);
        }
        Ok(out)
    }

    async fn phase_names(&self) -> Result<BTreeMap<i64, String>, BantoError> {
        Ok(WorkMastersService::new(self.db.clone())
            .list(MasterKind::Phases)
            .await?
            .into_iter()
            .map(|p| (p.id, p.name))
            .collect())
    }

    /// The draft computed now: its stored input with the actuals and
    /// commitments as of its base date, today's rate, order and budget.
    async fn priced_draft(
        &self,
        project_id: i64,
        base: Date,
        inputs: &[RemainingInput],
        ledger: &Ledger,
    ) -> Result<DraftFigures, BantoError> {
        let actuals = self.actuals(project_id, base, ledger).await?;
        let rate = self.rate(project_id, base).await?;
        let merged = merge_lines(&actuals.by_key, &actuals.committed, inputs);
        let priced = price_lines(&merged, rate.map(|(v, _)| v));
        Ok(DraftFigures {
            actuals,
            rate,
            priced,
        })
    }

    async fn views(
        &self,
        rows: Vec<VersionRow>,
        ledger: &Ledger,
    ) -> Result<Vec<ForecastVersion>, BantoError> {
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        let mut lines = self.lines_of(&ids).await?;
        let names = self.phase_names().await?;
        let name = |p: Option<i64>| p.and_then(|p| names.get(&p).cloned());
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let stored = lines.remove(&r.id).unwrap_or_default();
            let inputs: Vec<RemainingLine> = stored
                .iter()
                .filter(|l| l.remaining_minutes.is_some() || l.other_remaining.is_some())
                .map(|l| RemainingLine {
                    phase_id: l.phase_id,
                    phase_name: l.phase_name.clone(),
                    cost_type: l.cost_type.clone(),
                    remaining_minutes: l.remaining_minutes,
                    amount: l.other_remaining,
                })
                .collect();
            let view = if r.status == "draft" {
                let base = Date::parse(&r.base_date).ok_or_else(|| {
                    BantoError::Other(format!("不明な基準日です: {}", r.base_date))
                })?;
                let domain: Vec<RemainingInput> = stored
                    .iter()
                    .filter_map(|l| {
                        Some(RemainingInput {
                            key: key_of(l.phase_id, &l.cost_type)?,
                            minutes: l.remaining_minutes,
                            amount: l.other_remaining,
                        })
                    })
                    .collect();
                let figures = self
                    .priced_draft(r.project_id, base, &domain, ledger)
                    .await?;
                let (order, _) = self.order_now(r.project_id).await?;
                let budget = self.current_budget(r.project_id).await?;
                let summary = summarize(&figures.priced);
                let cost = summary.complete.then(|| summary.total());
                let pr = cost.map(|c| profit(order, c));
                ForecastVersion {
                    id: r.id,
                    project_id: r.project_id,
                    version_no: None,
                    status: r.status,
                    base_date: r.base_date,
                    planned_end: r.planned_end,
                    reason: r.reason,
                    forecast_rate: figures.rate.map(|(v, _)| v),
                    order_amount: order,
                    budget_version_no: budget.map(|b| b.1),
                    budget_total: budget.map(|b| b.2),
                    actual_total: summary.actual_total(),
                    committed_total: summary.committed,
                    remaining_total: summary.complete.then(|| summary.remaining_total()),
                    cost_total: cost,
                    profit: pr.filter(|_| order.is_some()).map(|p| p.amount),
                    profit_ratio_permille: pr.and_then(|p| p.ratio_permille),
                    overrun: cost.zip(budget).map(|(c, b)| overrun(c, b.2)),
                    actual_complete: figures.actuals.complete(),
                    rate_missing: !summary.complete,
                    pending_count: figures.actuals.pending,
                    provisional_count: figures.actuals.provisional,
                    missing_rate_count: figures.actuals.missing_rate,
                    by_cost_type: by_cost_type(&figures.priced),
                    lines: figures
                        .priced
                        .iter()
                        .map(|p| line_view(p, name(p.line.key.phase)))
                        .collect(),
                    inputs,
                    created_by_name: r.created_by_name,
                    updated_by: r.updated_by,
                    updated_by_name: r.updated_by_name,
                    adopted_by_name: None,
                    adopted_at: None,
                    row_version: r.row_version,
                    updated_at: r.updated_at,
                }
            } else {
                let priced: Vec<PricedForecastLine> = stored
                    .iter()
                    .filter_map(|l| {
                        Some(PricedForecastLine {
                            line: KeyedLine {
                                key: key_of(l.phase_id, &l.cost_type)?,
                                actual: l.actual_amount.unwrap_or(0),
                                committed: l.committed_amount.unwrap_or(0),
                                remaining_minutes: l.remaining_minutes.unwrap_or(0),
                                other_remaining: l.other_remaining.unwrap_or(0),
                            },
                            labor_remaining: Some(l.labor_remaining.unwrap_or(0)),
                        })
                    })
                    .collect();
                let cost = r.cost_total.unwrap_or(0);
                let pr = profit(r.order_amount, cost);
                ForecastVersion {
                    id: r.id,
                    project_id: r.project_id,
                    version_no: r.version_no,
                    status: r.status,
                    base_date: r.base_date,
                    planned_end: r.planned_end,
                    reason: r.reason,
                    forecast_rate: r.forecast_rate,
                    order_amount: r.order_amount,
                    budget_version_no: r.budget_version_no,
                    budget_total: r.budget_total,
                    actual_total: r.actual_total.unwrap_or(0),
                    committed_total: r.committed_total.unwrap_or(0),
                    remaining_total: r.remaining_total,
                    cost_total: r.cost_total,
                    profit: r.order_amount.map(|_| pr.amount),
                    profit_ratio_permille: pr.ratio_permille,
                    overrun: r.budget_total.map(|b| overrun(cost, b)),
                    actual_complete: r.actual_complete == Some(1),
                    rate_missing: false,
                    pending_count: 0,
                    provisional_count: 0,
                    missing_rate_count: 0,
                    by_cost_type: by_cost_type(&priced),
                    lines: stored
                        .iter()
                        .map(|l| {
                            let remaining = l.labor_remaining.unwrap_or(0)
                                + l.committed_amount.unwrap_or(0)
                                + l.other_remaining.unwrap_or(0);
                            ForecastLine {
                                phase_id: l.phase_id,
                                phase_name: l.phase_name.clone(),
                                cost_type: l.cost_type.clone(),
                                actual: l.actual_amount.unwrap_or(0),
                                committed: l.committed_amount.unwrap_or(0),
                                remaining_minutes: l.remaining_minutes,
                                other_remaining: l.other_remaining,
                                labor_remaining: l.labor_remaining,
                                remaining: Some(remaining),
                                total: Some(remaining + l.actual_amount.unwrap_or(0)),
                            }
                        })
                        .collect(),
                    inputs,
                    created_by_name: r.created_by_name,
                    updated_by: r.updated_by,
                    updated_by_name: r.updated_by_name,
                    adopted_by_name: r.adopted_by_name,
                    adopted_at: r.adopted_at,
                    row_version: r.row_version,
                    updated_at: r.updated_at,
                }
            };
            out.push(view);
        }
        Ok(out)
    }

    async fn ledger(&self) -> Result<Ledger, BantoError> {
        DirectCostsService::new(self.db.clone()).ledger().await
    }

    /// One version (any status). The wiring authorizes against its project.
    pub async fn get(&self, id: i64) -> Result<ForecastVersion, BantoError> {
        let sql = self.sql(&format!("{SELECT} WHERE f.id = ?"));
        let row: Option<VersionRow> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        let row = row.ok_or_else(|| not_found(id))?;
        let ledger = self.ledger().await?;
        Ok(self.views(vec![row], &ledger).await?.remove(0))
    }

    async fn draft_id(&self, project_id: i64) -> Result<Option<i64>, BantoError> {
        let sql =
            self.sql("SELECT id FROM forecast_versions WHERE project_id = ? AND status = 'draft'");
        let row: Option<(i64,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))?;
        Ok(row.map(|(id,)| id))
    }

    /// The latest adopted version's id, base date and planned end.
    async fn latest_adopted(
        &self,
        project_id: i64,
    ) -> Result<Option<(i64, String, Option<String>)>, BantoError> {
        let sql = self.sql(
            "SELECT id, base_date, planned_end FROM forecast_versions \
             WHERE project_id = ? AND status = 'adopted' ORDER BY version_no DESC LIMIT 1",
        );
        on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))
    }

    /// Start a draft dated today, with the latest adopted version's
    /// remaining input as the starting point to re-estimate (never added to
    /// the new actuals as is, spec §6.6 step 3), or return the draft the
    /// project already has (`replayed`).
    pub async fn create_draft(
        &self,
        project_id: i64,
        actor_user_id: Option<i64>,
    ) -> Result<ForecastDraftCreated, BantoError> {
        self.require_open(project_id).await?;
        if let Some(id) = self.draft_id(project_id).await? {
            return Ok(ForecastDraftCreated {
                draft: self.get(id).await?,
                replayed: true,
            });
        }
        let today = self.today().await?.to_string();
        let (_, project_end) = self.project(project_id).await?;
        let latest = self.latest_adopted(project_id).await?;
        let planned_end = latest.as_ref().and_then(|l| l.2.clone()).or(project_end);
        let insert = self.sql(
            "INSERT INTO forecast_versions (project_id, status, base_date, planned_end, \
             created_by, updated_by) VALUES (?, 'draft', ?, ?, ?, ?) RETURNING id",
        );
        let copy = self.sql(
            "INSERT INTO forecast_lines (forecast_version_id, line_no, phase_id, cost_type, \
             remaining_minutes, other_remaining) \
             SELECT ?, line_no, phase_id, cost_type, remaining_minutes, other_remaining \
             FROM forecast_lines WHERE forecast_version_id = ? \
             AND (remaining_minutes IS NOT NULL OR other_remaining IS NOT NULL)",
        );
        let base = latest.map(|l| l.0);
        let result: Result<i64, BantoError> = async {
            Ok(in_tx!(&self.db, tx => {
                let id: i64 = scalar!(&mut *tx, insert, project_id, &today, &planned_end,
                    actor_user_id, actor_user_id)?;
                if let Some(base) = base {
                    execute!(&mut *tx, copy, id, base)?;
                }
                id
            }))
        }
        .await;
        let id = match result {
            Ok(id) => id,
            // A concurrent create committed the project's one draft first.
            Err(BantoError::Storage(m)) if m.to_lowercase().contains("unique") => {
                if let Some(id) = self.draft_id(project_id).await? {
                    return Ok(ForecastDraftCreated {
                        draft: self.get(id).await?,
                        replayed: true,
                    });
                }
                return Err(BantoError::Storage(m));
            }
            Err(e) => return Err(e),
        };
        self.notify_changed();
        Ok(ForecastDraftCreated {
            draft: self.get(id).await?,
            replayed: false,
        })
    }

    /// The draft with the version the caller read.
    async fn draft(&self, id: i64, row_version: i64) -> Result<ForecastVersion, BantoError> {
        let v = self.get(id).await?;
        if v.status != "draft" {
            return Err(status_error("採用済みの完了見込は変更できません"));
        }
        if v.row_version != row_version {
            return Err(stale_version_error());
        }
        Ok(v)
    }

    /// Phases already used on the project's forecasts stay usable after
    /// being discontinued; new ones must be active.
    async fn check_phases(
        &self,
        project_id: i64,
        lines: &[RemainingInput],
    ) -> Result<(), BantoError> {
        let used = self.sql(
            "SELECT DISTINCT l.phase_id FROM forecast_lines l JOIN forecast_versions f \
             ON f.id = l.forecast_version_id WHERE f.project_id = ? AND l.phase_id IS NOT NULL",
        );
        let kept: Vec<(i64,)> = on_pool!(&self.db, pool => fetch_all!(pool, used, project_id))?;
        let kept: Vec<i64> = kept.into_iter().map(|(p,)| p).collect();
        let masters = WorkMastersService::new(self.db.clone());
        for (index, l) in lines.iter().enumerate() {
            if let Some(phase) = l.key.phase.filter(|p| !kept.contains(p)) {
                masters
                    .require_active(MasterKind::Phases, phase, &format!("lines.{index}.phaseId"))
                    .await?;
            }
        }
        Ok(())
    }

    async fn previous_base(&self, project_id: i64) -> Result<Option<Date>, BantoError> {
        Ok(self
            .latest_adopted(project_id)
            .await?
            .and_then(|(_, b, _)| Date::parse(&b)))
    }

    /// Replace a draft's base date, planned end, reason and remaining input.
    pub async fn update_draft(
        &self,
        id: i64,
        input: ForecastDraftInput,
        actor_user_id: Option<i64>,
    ) -> Result<ForecastVersion, BantoError> {
        let draft = self.draft(id, input.row_version).await?;
        self.require_open(draft.project_id).await?;
        let mut errors = Vec::new();
        let reason = clean_optional(&input.reason);
        if reason
            .as_deref()
            .is_some_and(|r| r.chars().count() > MAX_TEXT_LEN)
        {
            errors.push(field_error(
                "reason",
                format!("{MAX_TEXT_LEN}文字以内で入力してください"),
            ));
        }
        let base = Date::parse(input.base_date.trim());
        if base.is_none() {
            errors.push(field_error(
                "baseDate",
                "基準日を YYYY-MM-DD で入力してください",
            ));
        }
        let planned_end = clean_optional(&input.planned_end);
        if planned_end
            .as_deref()
            .is_some_and(|d| Date::parse(d).is_none())
        {
            errors.push(field_error(
                "plannedEnd",
                "完了予定日を YYYY-MM-DD で入力してください",
            ));
        }
        let mut lines = Vec::with_capacity(input.lines.len());
        for (index, l) in input.lines.iter().enumerate() {
            match key_of(l.phase_id, l.cost_type.trim()) {
                Some(key) => lines.push(RemainingInput {
                    key,
                    minutes: l.remaining_minutes,
                    amount: l.amount,
                }),
                None => errors.push(field_error(
                    &format!("lines.{index}.costType"),
                    "不明な費目です",
                )),
            }
        }
        validation(errors)?;
        let base = base.expect("checked above");
        let today = self.today().await?;
        let previous = self.previous_base(draft.project_id).await?;
        check_base_date(base, today, previous).map_err(|issues| BantoError::Validation {
            field_errors: issues.iter().map(adoption_error).collect(),
        })?;
        validate_remaining(&lines).map_err(|issues| BantoError::Validation {
            field_errors: issues.iter().map(remaining_error).collect(),
        })?;
        self.check_phases(draft.project_id, &lines).await?;
        let update = self.sql(&format!(
            "UPDATE forecast_versions SET base_date = ?, planned_end = ?, reason = ?, \
             updated_by = ?, row_version = row_version + 1, updated_at = {} \
             WHERE id = ? AND row_version = ? AND status = 'draft'",
            self.now()
        ));
        let clear = self.sql("DELETE FROM forecast_lines WHERE forecast_version_id = ?");
        let insert = self.sql(
            "INSERT INTO forecast_lines (forecast_version_id, line_no, phase_id, cost_type, \
             remaining_minutes, other_remaining) VALUES (?, ?, ?, ?, ?, ?)",
        );
        let version = draft.row_version;
        let base_text = base.to_string();
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, update, &base_text, &planned_end, &reason, actor_user_id, id,
                version)? == 0
            {
                return Err(stale_version_error());
            }
            execute!(&mut *tx, clear, id)?;
            for (n, l) in lines.iter().enumerate() {
                execute!(&mut *tx, insert, id, n as i64 + 1, l.key.phase,
                    l.key.cost_type.as_str(), l.minutes, l.amount)?;
            }
        });
        self.notify_changed();
        self.get(id).await
    }

    /// Discard a draft (adopted versions are never deleted).
    pub async fn delete_draft(&self, id: i64, row_version: i64) -> Result<(), BantoError> {
        self.draft(id, row_version).await?;
        let lines = self.sql("DELETE FROM forecast_lines WHERE forecast_version_id = ?");
        let version = self.sql(
            "DELETE FROM forecast_versions WHERE id = ? AND row_version = ? AND status = 'draft'",
        );
        in_tx!(&self.db, tx => {
            execute!(&mut *tx, lines, id)?;
            if execute!(&mut *tx, version, id, row_version)? == 0 {
                return Err(stale_version_error());
            }
        });
        self.notify_changed();
        Ok(())
    }

    /// Adopt the draft `authorized` (the row the caller was authorized
    /// against): number it and fix the set for its base date. A draft
    /// changed after authorization is refused as stale.
    pub async fn adopt(
        &self,
        authorized: &ForecastVersion,
        row_version: i64,
        actor_user_id: Option<i64>,
    ) -> Result<ForecastVersion, BantoError> {
        if row_version != authorized.row_version {
            return Err(stale_version_error());
        }
        let draft = self.draft(authorized.id, row_version).await?;
        let project_id = draft.project_id;
        let (status, _) = self.project(project_id).await?;
        let base = Date::parse(&draft.base_date)
            .ok_or_else(|| BantoError::Other(format!("不明な基準日です: {}", draft.base_date)))?;
        let today = self.today().await?;
        let previous = self.previous_base(project_id).await?;
        let inputs: Vec<RemainingInput> = draft
            .inputs
            .iter()
            .filter_map(|l| {
                Some(RemainingInput {
                    key: key_of(l.phase_id, &l.cost_type)?,
                    minutes: l.remaining_minutes,
                    amount: l.amount,
                })
            })
            .collect();
        let ledger = self.ledger().await?;
        let figures = self
            .priced_draft(project_id, base, &inputs, &ledger)
            .await?;
        check_adoption(
            &figures.priced,
            draft.reason.as_deref(),
            status,
            base,
            today,
            previous,
        )
        .map_err(|issues| BantoError::Validation {
            field_errors: issues.iter().map(adoption_error).collect(),
        })?;
        let summary = summarize(&figures.priced);
        let (order, _) = self.order_now(project_id).await?;
        let budget = self.current_budget(project_id).await?;
        let adopted = self.sql(
            "SELECT version_no FROM forecast_versions WHERE project_id = ? AND status = 'adopted'",
        );
        let numbers: Vec<(i64,)> =
            on_pool!(&self.db, pool => fetch_all!(pool, adopted, project_id))?;
        let numbers: Vec<u32> = numbers
            .into_iter()
            .filter_map(|(n,)| u32::try_from(n).ok())
            .collect();
        let version = next_version(&numbers);
        let lock = match self.db.dialect() {
            Dialect::Postgres => Some(self.sql("SELECT id FROM projects WHERE id = ? FOR UPDATE")),
            Dialect::Sqlite => None,
        };
        let max = self.sql(
            "SELECT COALESCE(MAX(version_no), 0) FROM forecast_versions \
             WHERE project_id = ? AND status = 'adopted'",
        );
        let update = self.sql(&format!(
            "UPDATE forecast_versions SET status = 'adopted', version_no = ?, forecast_rate = ?, \
             applied_calc_value_id = ?, order_amount = ?, budget_version_id = ?, \
             budget_total = ?, actual_total = ?, committed_total = ?, remaining_total = ?, \
             cost_total = ?, actual_complete = ?, adopted_by = ?, adopted_at = {now}, \
             row_version = row_version + 1, updated_at = {now} \
             WHERE id = ? AND row_version = ? AND status = 'draft'",
            now = self.now()
        ));
        let clear = self.sql("DELETE FROM forecast_lines WHERE forecast_version_id = ?");
        let insert = self.sql(
            "INSERT INTO forecast_lines (forecast_version_id, line_no, phase_id, cost_type, \
             actual_amount, committed_amount, remaining_minutes, other_remaining, \
             labor_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        let id = draft.id;
        let (rate, value_id) = match figures.rate {
            Some((v, row)) => (Some(v), row),
            None => (None, None),
        };
        let complete = i64::from(figures.actuals.complete());
        let (actual_total, committed_total, remaining_total, cost_total) = (
            summary.actual_total(),
            summary.committed,
            summary.remaining_total(),
            summary.total(),
        );
        let priced = figures.priced;
        in_tx!(&self.db, tx => {
            if let Some(lock) = &lock {
                let _: Vec<(i64,)> = fetch_all!(&mut *tx, lock, project_id)?;
            }
            let taken: i64 = scalar!(&mut *tx, max, project_id)?;
            if taken + 1 != i64::from(version) {
                return Err(stale_version_error());
            }
            if execute!(&mut *tx, update, i64::from(version), rate, value_id, order,
                budget.map(|b| b.0), budget.map(|b| b.2), actual_total, committed_total,
                remaining_total, cost_total, complete, actor_user_id, id, row_version)? == 0
            {
                return Err(stale_version_error());
            }
            execute!(&mut *tx, clear, id)?;
            for (n, p) in priced.iter().enumerate() {
                let l = p.line;
                let labor = l.key.cost_type == CostType::Labor;
                execute!(&mut *tx, insert, id, n as i64 + 1, l.key.phase,
                    l.key.cost_type.as_str(), l.actual, l.committed,
                    (labor && l.remaining_minutes > 0).then_some(l.remaining_minutes),
                    (!labor && l.other_remaining > 0).then_some(l.other_remaining),
                    labor.then_some(p.labor_remaining.unwrap_or(0)))?;
            }
        });
        self.notify_changed();
        self.get(id).await
    }

    /// 見込更新要 for the latest adopted version and what the overall list
    /// needs. `ledger` is the company ledger (read once by the caller).
    pub async fn summary(
        &self,
        project_id: i64,
        ledger: &Ledger,
        order_now: Option<i64>,
    ) -> Result<ForecastSummary, BantoError> {
        let far = Date::new(9999, 12, 31).expect("valid date");
        let latest_actuals = self.actuals(project_id, far, ledger).await?;
        // Up to a far date = every record, whatever its date.
        let unapproved = latest_actuals.pending;
        let committed: i64 = latest_actuals.committed.iter().map(|(_, v)| *v).sum();
        let sql = self.sql(&format!(
            "{SELECT} WHERE f.project_id = ? AND f.status = 'adopted' \
             ORDER BY f.version_no DESC LIMIT 1"
        ));
        let row: Option<VersionRow> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))?;
        let Some(row) = row else {
            return Ok(ForecastSummary {
                latest: None,
                update_reasons: Vec::new(),
                latest_actual_total: latest_actuals.total,
                latest_actual_complete: latest_actuals.complete(),
                unapproved,
                committed,
            });
        };
        let base = Date::parse(&row.base_date)
            .ok_or_else(|| BantoError::Other(format!("不明な基準日です: {}", row.base_date)))?;
        let at_base = self.actuals(project_id, base, ledger).await?;
        let rate_now = self.rate(project_id, base).await?.map(|(v, _)| v);
        let minutes_sql = self.sql(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM forecast_lines \
             WHERE forecast_version_id = ? AND remaining_minutes IS NOT NULL",
        );
        let minutes: i64 = on_pool!(&self.db, pool => scalar!(pool, minutes_sql, row.id))?;
        let reasons = update_reasons(&AdoptedFacts {
            snapshot_actual: row.actual_total.unwrap_or(0),
            actual_at_base_now: at_base.total,
            latest_actual: latest_actuals.total,
            snapshot_rate: row.forecast_rate,
            rate_now,
            has_remaining_minutes: minutes > 0,
            snapshot_order: row.order_amount,
            order_now,
        });
        Ok(ForecastSummary {
            latest: Some(AdoptedSummary {
                version_no: row.version_no.unwrap_or(0),
                base_date: row.base_date,
                cost_total: row.cost_total.unwrap_or(0),
                actual_complete: row.actual_complete == Some(1),
            }),
            update_reasons: reasons,
            latest_actual_total: latest_actuals.total,
            latest_actual_complete: latest_actuals.complete(),
            unapproved,
            committed,
        })
    }

    /// Every version of the project, the comparison and 見込更新要.
    pub async fn overview(&self, project_id: i64) -> Result<ForecastOverview, BantoError> {
        let (status, _) = self.project(project_id).await?;
        let ledger = self.ledger().await?;
        let sql = self.sql(&format!(
            "{SELECT} WHERE f.project_id = ? ORDER BY f.status DESC, f.version_no DESC"
        ));
        let rows: Vec<VersionRow> = on_pool!(&self.db, pool => fetch_all!(pool, sql, project_id))?;
        // `status DESC` puts the draft first ('draft' > 'adopted').
        let mut versions = self.views(rows, &ledger).await?;
        let draft = versions
            .iter()
            .position(|v| v.status == "draft")
            .map(|i| versions.remove(i));
        let history = versions;
        let latest = history.first().cloned();
        let previous = history.get(1).cloned();
        let (order, pending) = self.order_now(project_id).await?;
        let summary = self.summary(project_id, &ledger, order).await?;
        let budget = crate::budgets::BudgetsService::new(self.db.clone())
            .overview(project_id)
            .await?;
        let budget_of = |t: &str, current: bool| {
            budget
                .totals
                .iter()
                .find(|b| b.cost_type == t)
                .and_then(|b| if current { b.current } else { b.original })
        };
        let type_total = |v: &Option<ForecastVersion>, t: &str| {
            v.as_ref().and_then(|v| {
                v.by_cost_type
                    .iter()
                    .find(|x| x.cost_type == t)
                    .and_then(|x| x.total)
            })
        };
        let comparison = CostType::ALL
            .into_iter()
            .map(|t| {
                let t = t.as_str();
                ComparisonRow {
                    cost_type: t.into(),
                    original_budget: budget_of(t, false),
                    current_budget: budget_of(t, true),
                    previous: type_total(&previous, t),
                    latest: type_total(&latest, t),
                    draft: type_total(&draft, t),
                    latest_actual: budget
                        .totals
                        .iter()
                        .find(|b| b.cost_type == t)
                        .and_then(|b| b.actual)
                        .unwrap_or(0),
                }
            })
            .collect();
        let latest_cost = latest.as_ref().and_then(|v| v.cost_total);
        let current_profit = latest_cost.map(|c| profit(order, c));
        let current_total = budget.current.as_ref().and_then(|b| b.total);
        Ok(ForecastOverview {
            project_id,
            project_status: status.as_str().into(),
            order_amount: order,
            pending_addition: pending,
            budget_original_total: budget.original.as_ref().and_then(|b| b.total),
            budget_current_total: current_total,
            budget_current_version_no: budget.current.as_ref().and_then(|b| b.version_no),
            change_from_previous: latest_cost
                .zip(previous.as_ref().and_then(|v| v.cost_total))
                .map(|(a, b)| a - b),
            latest,
            previous,
            history,
            draft,
            latest_actual_total: summary.latest_actual_total,
            update_reasons: summary
                .update_reasons
                .iter()
                .map(|r| r.as_str().to_string())
                .collect(),
            current_profit: current_profit.filter(|_| order.is_some()).map(|p| p.amount),
            current_profit_ratio_permille: current_profit.and_then(|p| p.ratio_permille),
            current_overrun: latest_cost.zip(current_total).map(|(c, b)| overrun(c, b)),
            comparison,
        })
    }
}

struct DraftFigures {
    actuals: Actuals,
    rate: Option<(i64, Option<i64>)>,
    priced: Vec<PricedForecastLine>,
}

fn line_view(p: &PricedForecastLine, phase_name: Option<String>) -> ForecastLine {
    let l = p.line;
    let labor = l.key.cost_type == CostType::Labor;
    ForecastLine {
        phase_id: l.key.phase,
        phase_name,
        cost_type: l.key.cost_type.as_str().into(),
        actual: l.actual,
        committed: l.committed,
        remaining_minutes: (labor && l.remaining_minutes > 0).then_some(l.remaining_minutes),
        other_remaining: (!labor && l.other_remaining > 0).then_some(l.other_remaining),
        labor_remaining: if labor { p.labor_remaining } else { None },
        remaining: p.remaining(),
        total: p.total(),
    }
}

/// Forecast drafts as usages of `forecast_rate`, for the calc-basis impact
/// preview (design §10.5): a draft is repriced on read, so it is pending.
/// Adopted versions keep their rate (見込更新要 instead), so they are not
/// correction candidates.
pub(crate) async fn usages(db: &Db, item_key: &str) -> Result<Vec<Usage>, BantoError> {
    if item_key != RATE_ITEM {
        return Ok(Vec::new());
    }
    let sql = "SELECT id, project_id, base_date FROM forecast_versions WHERE status = 'draft'"
        .to_string();
    let rows: Vec<(i64, i64, String)> = on_pool!(db, pool => fetch_all!(pool, sql))?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, project, on)| {
            Some(Usage {
                id: format!("forecast-{id}"),
                item: RATE_ITEM.to_string(),
                project: Some(project.to_string()),
                on: Date::parse(&on)?,
                status: UsageStatus::Pending,
                closed: false,
                line_specific: None,
                applied_value: None,
            })
        })
        .collect())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::budgets::tests::{set_rate as set_budget_rate, spec_lines};
    use crate::budgets::{BudgetDraftInput, BudgetsService};
    use crate::calc_basis::tests::value;
    use crate::calc_basis::CalcBasisService;
    use crate::direct_costs::tests::approved;
    use crate::direct_costs::{DirectCostInput, PurchaseOrderInput};
    use crate::orders::tests::{line as plan_line, ordered_project};
    use crate::projects::tests::fixture;

    fn field_errors(err: BantoError) -> Vec<String> {
        match err {
            BantoError::Validation { field_errors } => {
                field_errors.into_iter().map(|e| e.field).collect()
            }
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    pub(crate) async fn approved_hours(
        db: &Db,
        project: i64,
        phase: i64,
        on: &str,
        minutes: i64,
        cost: i64,
    ) {
        let sql = placeholders(
            db.dialect(),
            "INSERT INTO time_entries (work_date, user_id, project_id, phase_id, minutes, \
             status, applied_rate, labor_cost) VALUES (?, 1, ?, ?, ?, 'approved', 5000, ?)",
        );
        on_pool!(db, pool => execute!(pool, sql, on, project, phase, minutes, cost)).unwrap();
    }

    async fn cost(db: &Db, project: i64, cost_type: &str, on: &str, amount: i64, po: Option<i64>) {
        approved(
            &DirectCostsService::new(db.clone()),
            DirectCostInput {
                project_id: Some(project),
                cost_type: Some(cost_type.into()),
                booked_on: on.into(),
                amount,
                purchase_order_id: po,
                ..Default::default()
            },
        )
        .await;
    }

    async fn order(db: &Db, project: i64, cost_type: &str, amount: i64) -> i64 {
        DirectCostsService::new(db.clone())
            .create_order(
                PurchaseOrderInput {
                    project_id: Some(project),
                    cost_type: Some(cost_type.into()),
                    ordered_on: "2026-01-05".into(),
                    amount: Some(amount),
                    client_request_id: Some(format!("po-{cost_type}")),
                    ..Default::default()
                },
                Some(1),
            )
            .await
            .unwrap()
            .order
            .id
    }

    pub(crate) fn rem(
        phase: Option<i64>,
        cost_type: &str,
        minutes: Option<i64>,
        amount: Option<i64>,
    ) -> ForecastLineInput {
        ForecastLineInput {
            phase_id: phase,
            cost_type: cost_type.into(),
            remaining_minutes: minutes,
            amount,
        }
    }

    /// Spec 12.1: order 4,000,000, original budget 2,600,000, actuals
    /// 1,900,000 up to 2026-01-31, purchase orders with 400,000 left.
    /// Returns (project, material order, outsource order).
    pub(crate) async fn spec_project(db: &Db, code: &str) -> (i64, i64, i64) {
        let pid = ordered_project(db, code, vec![plan_line(Some("2027-03"), 4_000_000)]).await;
        set_budget_rate(db, 5_000).await;
        let budgets = BudgetsService::new(db.clone());
        let d = budgets.create_draft(pid, Some(2)).await.unwrap().draft;
        let d = budgets
            .update_draft(
                d.id,
                BudgetDraftInput {
                    reason: None,
                    lines: spec_lines(),
                    row_version: d.row_version,
                },
                Some(2),
            )
            .await
            .unwrap();
        budgets.approve(&d, d.row_version, Some(1)).await.unwrap();
        CalcBasisService::new(db.clone())
            .add(
                None,
                value(RATE_ITEM, "2020-01-01", Some(5_000), "初期"),
                Some(1),
            )
            .await
            .unwrap();
        let material = order(db, pid, "material", 1_000_000).await;
        let outsource = order(db, pid, "outsource", 500_000).await;
        approved_hours(db, pid, 1, "2026-01-15", 600, 700_000).await;
        cost(db, pid, "material", "2026-01-20", 800_000, Some(material)).await;
        cost(db, pid, "outsource", "2026-01-20", 300_000, Some(outsource)).await;
        cost(db, pid, "travel", "2026-01-20", 80_000, None).await;
        cost(db, pid, "other", "2026-01-20", 20_000, None).await;
        (pid, material, outsource)
    }

    async fn save(
        svc: &ForecastsService,
        d: &ForecastVersion,
        base: &str,
        reason: Option<&str>,
        lines: Vec<ForecastLineInput>,
    ) -> Result<ForecastVersion, BantoError> {
        svc.update_draft(
            d.id,
            ForecastDraftInput {
                base_date: base.into(),
                planned_end: Some("2027-03-31".into()),
                reason: reason.map(str::to_string),
                lines,
                row_version: d.row_version,
            },
            Some(2),
        )
        .await
    }

    #[tokio::test]
    async fn t06_t28_t30_adopt_the_spec_set_then_re_estimate() {
        let db = fixture().await;
        let svc = ForecastsService::new(db.clone());
        let (pid, material, outsource) = spec_project(&db, "P-F01").await;

        let created = svc.create_draft(pid, Some(2)).await.unwrap();
        assert!(!created.replayed);
        assert!(svc.create_draft(pid, Some(2)).await.unwrap().replayed);
        let d = save(
            &svc,
            &created.draft,
            "2026-01-31",
            None,
            vec![
                rem(Some(1), "labor", Some(100 * 60), None),
                rem(None, "travel", None, Some(70_000)),
                rem(None, "other", None, Some(30_000)),
            ],
        )
        .await
        .unwrap();
        // T06: the draft reads the actuals and commitments as of its base date.
        assert_eq!(d.actual_total, 1_900_000);
        assert_eq!(d.committed_total, 400_000, "発注残は発注から（入力しない）");
        assert_eq!(d.remaining_total, Some(1_000_000));
        assert_eq!(d.cost_total, Some(2_900_000));
        assert_eq!(d.order_amount, Some(4_000_000));
        assert_eq!(d.profit, Some(1_100_000));
        assert_eq!(d.profit_ratio_permille, Some(275));
        assert_eq!(d.budget_total, Some(2_600_000));
        assert_eq!(d.overrun, Some(300_000));
        assert!(d.actual_complete);
        // An adoption needs its reason.
        let err = svc.adopt(&d, d.row_version, Some(1)).await.unwrap_err();
        assert_eq!(field_errors(err), vec!["reason"]);
        let d = save(
            &svc,
            &d,
            "2026-01-31",
            Some("月次見直し"),
            d.inputs
                .iter()
                .map(|l| rem(l.phase_id, &l.cost_type, l.remaining_minutes, l.amount))
                .collect(),
        )
        .await
        .unwrap();
        let v1 = svc.adopt(&d, d.row_version, Some(1)).await.unwrap();
        assert_eq!(v1.version_no, Some(1));
        assert_eq!(v1.cost_total, Some(2_900_000));
        assert_eq!(v1.forecast_rate, Some(5_000));
        assert!(svc
            .update_draft(
                v1.id,
                ForecastDraftInput {
                    base_date: "2026-01-31".into(),
                    row_version: v1.row_version,
                    ..Default::default()
                },
                Some(2)
            )
            .await
            .is_err());
        let o = svc.overview(pid).await.unwrap();
        assert!(o.update_reasons.is_empty());
        assert_eq!(o.current_profit, Some(1_100_000));

        // 300,000 more is realized after the base date (spec 12.5).
        approved_hours(&db, pid, 1, "2026-02-10", 600, 150_000).await;
        cost(&db, pid, "material", "2026-02-10", 100_000, Some(material)).await;
        cost(&db, pid, "outsource", "2026-02-10", 50_000, Some(outsource)).await;
        let o = svc.overview(pid).await.unwrap();
        assert_eq!(
            o.update_reasons,
            vec!["actual_after_base"],
            "T30: 見込更新要"
        );
        assert_eq!(o.latest_actual_total, 2_200_000, "最新実績は別の列");
        let latest = o.latest.as_ref().unwrap();
        assert_eq!(
            latest.cost_total,
            Some(2_900_000),
            "古い残見込みに最新実績を足さない"
        );
        assert_eq!(latest.actual_total, 1_900_000);

        // T28: the next draft starts from v1's remaining input; it is re-estimated.
        let d2 = svc.create_draft(pid, Some(2)).await.unwrap().draft;
        assert_eq!(d2.inputs.len(), 3);
        let err = save(&svc, &d2, "2026-01-15", Some("x"), vec![])
            .await
            .unwrap_err();
        assert_eq!(
            field_errors(err),
            vec!["baseDate"],
            "前回の基準日より前は不可"
        );
        let d2 = save(
            &svc,
            &d2,
            "2026-02-28",
            Some("2月の実績を反映し残工数を見直し"),
            vec![
                rem(Some(1), "labor", Some(90 * 60), None),
                rem(None, "travel", None, Some(70_000)),
                rem(None, "other", None, Some(30_000)),
            ],
        )
        .await
        .unwrap();
        assert_eq!(d2.actual_total, 2_200_000);
        assert_eq!(d2.committed_total, 250_000);
        assert_eq!(d2.remaining_total, Some(800_000));
        let v2 = svc.adopt(&d2, d2.row_version, Some(1)).await.unwrap();
        assert_eq!(v2.version_no, Some(2));
        assert_eq!(v2.cost_total, Some(3_000_000));
        assert_eq!(v2.profit, Some(1_000_000));
        assert_eq!(v2.overrun, Some(400_000));
        let o = svc.overview(pid).await.unwrap();
        assert!(o.update_reasons.is_empty());
        assert_eq!(o.change_from_previous, Some(100_000));
        assert_eq!(
            o.previous.as_ref().unwrap().cost_total,
            Some(2_900_000),
            "古い版は保持"
        );
        assert_eq!(o.budget_original_total, Some(2_600_000), "予算は変わらない");
        assert_eq!(o.current_overrun, Some(400_000));
        let labor = o
            .comparison
            .iter()
            .find(|r| r.cost_type == "labor")
            .unwrap();
        assert_eq!(
            (labor.previous, labor.latest, labor.latest_actual),
            (Some(1_200_000), Some(1_300_000), 850_000)
        );

        // T30: an actual corrected on or before the base date flags 見込更新要 too.
        approved_hours(&db, pid, 1, "2026-02-01", 60, 5_000).await;
        let o = svc.overview(pid).await.unwrap();
        assert_eq!(o.update_reasons, vec!["actual_corrected"]);
        // A rate change does not touch the adopted version.
        CalcBasisService::new(db.clone())
            .add(
                None,
                value(RATE_ITEM, "2026-02-01", Some(6_000), "改定"),
                Some(1),
            )
            .await
            .unwrap();
        let o = svc.overview(pid).await.unwrap();
        assert_eq!(o.update_reasons, vec!["actual_corrected", "rate_changed"]);
        assert_eq!(o.latest.unwrap().cost_total, Some(3_000_000));
    }

    #[tokio::test]
    async fn drafts_need_an_ordered_project_a_rate_and_clean_lines() {
        let db = fixture().await;
        let svc = ForecastsService::new(db.clone());
        // A pre-order project has no completion forecast.
        let lead = crate::projects::ProjectsService::new(db.clone())
            .create(crate::projects::tests::input("P-F02"), Some(1))
            .await
            .unwrap();
        let err = svc.create_draft(lead.id, Some(2)).await.unwrap_err();
        assert_eq!(field_errors(err), vec!["status"]);

        let pid = ordered_project(&db, "P-F03", vec![plan_line(None, 1_000_000)]).await;
        let d = svc.create_draft(pid, Some(2)).await.unwrap().draft;
        let err = save(
            &svc,
            &d,
            "2099-01-01",
            None,
            vec![
                rem(Some(1), "labor", Some(0), Some(1)),
                rem(None, "material", Some(60), Some(-1)),
            ],
        )
        .await
        .unwrap_err();
        assert_eq!(field_errors(err), vec!["baseDate"]);
        let err = save(
            &svc,
            &d,
            "2026-01-31",
            None,
            vec![
                rem(Some(1), "labor", Some(0), Some(1)),
                rem(None, "material", Some(60), Some(-1)),
                rem(None, "x", None, Some(1)),
            ],
        )
        .await
        .unwrap_err();
        assert_eq!(field_errors(err), vec!["lines.2.costType"]);
        let err = save(
            &svc,
            &d,
            "2026-01-31",
            None,
            vec![rem(Some(1), "labor", Some(0), Some(1))],
        )
        .await
        .unwrap_err();
        assert_eq!(
            field_errors(err),
            vec!["lines.0.remainingMinutes", "lines.0.amount"]
        );
        // No forecast rate: the remaining labor is 未確定 (not 0 yen) and cannot be adopted.
        let d = save(
            &svc,
            &d,
            "2026-01-31",
            Some("初回"),
            vec![rem(Some(1), "labor", Some(600), None)],
        )
        .await
        .unwrap();
        assert!(d.rate_missing);
        assert_eq!(d.cost_total, None);
        assert_eq!(d.lines[0].labor_remaining, None);
        let err = svc.adopt(&d, d.row_version, Some(1)).await.unwrap_err();
        assert_eq!(field_errors(err), vec!["lines"]);
        // Stale row_version (T13) and discarding.
        let err = save(
            &svc,
            &ForecastVersion {
                row_version: d.row_version + 1,
                ..d.clone()
            },
            "2026-01-31",
            None,
            vec![],
        )
        .await
        .unwrap_err();
        assert_eq!(field_errors(err), vec!["rowVersion"]);
        assert_eq!(usages(&db, RATE_ITEM).await.unwrap().len(), 1);
        svc.delete_draft(d.id, d.row_version).await.unwrap();
        assert!(matches!(
            svc.get(d.id).await,
            Err(BantoError::NotFound { .. })
        ));
        assert!(usages(&db, "emp_rate").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn pending_records_up_to_the_base_date_mark_the_version_provisional() {
        let db = fixture().await;
        let svc = ForecastsService::new(db.clone());
        let pid = ordered_project(&db, "P-F04", vec![plan_line(None, 1_000_000)]).await;
        let sql = placeholders(
            db.dialect(),
            "INSERT INTO time_entries (work_date, user_id, project_id, phase_id, minutes, status) \
             VALUES ('2026-01-10', 1, ?, 1, 60, 'submitted')",
        );
        on_pool!(&db, pool => execute!(pool, sql, pid)).unwrap();
        let d = svc.create_draft(pid, Some(2)).await.unwrap().draft;
        let d = save(
            &svc,
            &d,
            "2026-01-31",
            Some("初回"),
            vec![rem(None, "material", None, Some(100_000))],
        )
        .await
        .unwrap();
        assert!(!d.actual_complete);
        assert_eq!(d.pending_count, 1);
        let v = svc.adopt(&d, d.row_version, Some(1)).await.unwrap();
        assert!(!v.actual_complete, "暫定・不足あり として残る");
        assert_eq!(v.cost_total, Some(100_000));
        let s = svc
            .summary(pid, &svc.ledger().await.unwrap(), Some(1_000_000))
            .await
            .unwrap();
        assert_eq!(s.unapproved, 1);
        assert!(s.update_reasons.is_empty());
        // The overall list keeps it marked provisional (not as final figures).
        let all = banto_admin_services::authz::ProjectScope::All;
        let p = svc.portfolio().overview(&all, &all).await.unwrap();
        let row = p.rows.iter().find(|r| r.project_id == pid).unwrap();
        assert_eq!(row.forecast_actual_complete, Some(false));
        assert_eq!(row.actual_complete, Some(false), "最新実績も暫定");
        assert_eq!(p.totals.provisional_forecasts, vec![pid]);
    }

    #[tokio::test]
    async fn a_provisional_confirmed_after_the_base_date_still_counts_on_that_date() {
        let db = fixture().await;
        let svc = ForecastsService::new(db.clone());
        let costs = DirectCostsService::new(db.clone());
        let pid = ordered_project(&db, "P-F05", vec![plan_line(None, 1_000_000)]).await;
        let provisional = approved(
            &costs,
            DirectCostInput {
                project_id: Some(pid),
                cost_type: Some("outsource".into()),
                entry_kind: Some("provisional".into()),
                booked_on: "2026-01-20".into(),
                amount: 300_000,
                ..Default::default()
            },
        )
        .await;
        approved(
            &costs,
            DirectCostInput {
                entry_kind: Some("confirms".into()),
                ref_id: Some(provisional.id),
                booked_on: "2026-02-10".into(),
                amount: 320_000,
                reason: Some("請求書到着".into()),
                ..Default::default()
            },
        )
        .await;
        let d = svc.create_draft(pid, Some(2)).await.unwrap().draft;
        // On 2026-01-31 the cost was the unconfirmed provisional.
        let d = save(&svc, &d, "2026-01-31", Some("1月末"), vec![])
            .await
            .unwrap();
        assert_eq!(d.actual_total, 300_000);
        assert_eq!(d.provisional_count, 1);
        assert!(!d.actual_complete);
        // On 2026-02-28 the invoice replaced it.
        let d = save(&svc, &d, "2026-02-28", Some("2月末"), vec![])
            .await
            .unwrap();
        assert_eq!(d.actual_total, 320_000);
        assert_eq!(d.provisional_count, 0);
        assert!(d.actual_complete);
    }
}
