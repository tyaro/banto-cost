//! 精算完了 (settling a work-done project, banto-cost P6a, spec §5.1, T17).
//!
//! The check lists what blocks the settlement (`cost_domain::closeout`):
//! hours and direct costs not approved yet, approved hours without a rate,
//! provisionals not confirmed, order changes not decided — all of which need
//! processing — and the remaining amounts (未実績発注残 per purchase order,
//! the latest adopted forecast's remaining cost other than the orders, the
//! unrecognized revenue), which may instead be waived with a reason. The
//! settler (accounting, `Operation::SettleProject`) is the approver of the
//! waivers. A waiver names the amount it was given for: when the amount
//! changed, it no longer matches and the settlement is refused.
//!
//! Only a work-done project (作業完了) is settled. Settling moves it to
//! `settled` and keeps one `project_closeouts` row (the status before, the
//! business date, who, a note) and its waivers; nothing is rewritten. Every
//! other service refuses new records on a settled project.
//!
//! Concurrency (T13): the settlement compares the project's `row_version`
//! and `revenue_version`, and re-reads in its transaction a fingerprint of
//! the project's hours, direct costs, purchase orders and forecast versions
//! (count, version sum, last id) taken before the check. Any write between
//! the check and the commit makes it a stale-version error, so the check
//! always describes what is settled.
//!
//! Reopening (精算完了の取消, 2026-11-07 decision): a settled project goes back
//! to 作業完了 with a reason, by the same people who settle
//! (`Operation::SettleProject`). The settlement and its waivers stay; one
//! `closeout_reopenings` row records the cancellation, and settling again
//! writes a new settlement (the check runs anew, waivers included).

use banto_core::{BantoError, FieldError};
use banto_server::ServerEvent;
use banto_storage::Db;
use cost_domain::closeout::{check_closeout, Blocker, CloseoutError, CloseoutState, Waiver};
use cost_domain::project::ProjectStatus;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::customers::{field_error, now_expr, stale_version_error};
use crate::direct_costs::DirectCostsService;
use crate::forecasts::ForecastsService;
use crate::orders::{
    execute, fetch_all, fetch_optional, in_tx, on_pool, placeholders, scalar, OrdersService,
    MAX_TEXT_LEN,
};
use crate::time_entries::COUNTS;

pub const RESOURCE: &str = "project_closeouts";

/// The status read a writer runs in its own transaction, after its write, to
/// refuse a record on a project settled meanwhile (T13): on SQLite the
/// writer then holds the write lock, so a settlement cannot commit between
/// the read and its commit; on Postgres `FOR SHARE` waits for a settlement
/// holding the row and makes a later one wait for the writer.
pub(crate) fn settled_check_sql(dialect: banto_storage::Dialect) -> String {
    let sql = match dialect {
        banto_storage::Dialect::Sqlite => "SELECT status FROM projects WHERE id = ?",
        banto_storage::Dialect::Postgres => "SELECT status FROM projects WHERE id = ? FOR SHARE",
    };
    placeholders(dialect, sql)
}

/// Refuse (`return Err`) when `$project` is settled, reading with `$exec`
/// inside the writer's transaction ([`settled_check_sql`]).
macro_rules! refuse_settled {
    ($exec:expr, $sql:expr, $project:expr, $field:expr, $message:expr) => {{
        let row: Option<(String,)> = fetch_optional!($exec, $sql, $project)?;
        if row.is_some_and(|(status,)| status == "settled") {
            return Err(BantoError::Validation {
                field_errors: vec![crate::customers::field_error($field, $message)],
            });
        }
    }};
}
pub(crate) use refuse_settled;

/// One item that blocks the settlement.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockerView {
    /// `cost_domain::closeout::Blocker::code`.
    pub kind: String,
    /// A remaining amount that may be waived with a reason; otherwise the
    /// records must be processed first.
    pub waivable: bool,
    /// The remaining amount (waivable kinds only).
    pub amount: Option<i64>,
    /// `purchase_remaining` only.
    pub purchase_order_id: Option<i64>,
    pub purchase_order_label: Option<String>,
    /// Records concerned (`unapproved`: hours + direct costs; `missing_rate`,
    /// `provisional`, `pending_order_changes`: their count).
    pub count: Option<i64>,
    /// `unapproved` only: hours not approved yet (count, minutes) and direct costs.
    pub time_entries: Option<i64>,
    pub minutes: Option<i64>,
    pub costs: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct WaiverView {
    #[serde(skip)]
    pub closeout_id: i64,
    pub kind: String,
    pub purchase_order_id: Option<i64>,
    pub amount: i64,
    pub reason: String,
    pub approved_by_name: Option<String>,
    /// `purchase_remaining` only: the order as the check named it.
    #[sqlx(skip)]
    pub purchase_order_label: Option<String>,
    #[serde(skip)]
    pub ordered_on: Option<String>,
    #[serde(skip)]
    pub vendor_name: Option<String>,
    #[serde(skip)]
    pub order_description: Option<String>,
}

/// The cancellation of a settlement (精算完了の取消).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ReopeningView {
    #[serde(skip)]
    pub closeout_id: i64,
    pub reopened_on: String,
    pub reason: String,
    pub reopened_by_name: Option<String>,
    pub created_at: String,
}

/// A recorded settlement.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CloseoutRecord {
    pub id: i64,
    pub previous_status: String,
    pub settled_on: String,
    pub note: Option<String>,
    pub settled_by_name: Option<String>,
    pub created_at: String,
    #[sqlx(skip)]
    pub waivers: Vec<WaiverView>,
    /// Set once the settlement was cancelled (the project was reopened).
    #[sqlx(skip)]
    pub reopening: Option<ReopeningView>,
}

/// 案件詳細 → 精算完了. Amounts: `ViewProjectAmounts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseoutCheck {
    pub project_id: i64,
    pub status: String,
    /// Send back as `rowVersion` when settling (T13).
    pub row_version: i64,
    /// The project is 作業完了 (the only status that is settled).
    pub settleable: bool,
    /// What blocks the settlement now (empty when nothing is left; also
    /// empty before the work is done and once settled).
    pub blockers: Vec<BlockerView>,
    /// The settlement in force (the project is settled).
    pub closeout: Option<CloseoutRecord>,
    /// Settlements cancelled since, newest first (each with its `reopening`).
    pub history: Vec<CloseoutRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaiverInput {
    pub kind: String,
    #[serde(default)]
    pub purchase_order_id: Option<i64>,
    pub amount: i64,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleInput {
    pub row_version: i64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub waivers: Vec<WaiverInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenInput {
    pub row_version: i64,
    #[serde(default)]
    pub reason: String,
}

/// What both wiring layers record for a reopening: the project, the
/// settlement cancelled (its business date) and the reopening's date — not
/// the reason (free text) nor any amount.
pub fn reopen_audit_detail(project_id: i64, record: &CloseoutRecord) -> serde_json::Value {
    serde_json::json!({
        "projectId": project_id,
        "closeoutId": record.id,
        "settledOn": record.settled_on,
        "reopenedOn": record.reopening.as_ref().map(|r| r.reopened_on.clone()),
    })
}

/// What both wiring layers record: the project, the status before and the
/// kinds waived, never amounts (spec §4・§11).
pub fn audit_detail(project_id: i64, record: &CloseoutRecord) -> serde_json::Value {
    serde_json::json!({
        "projectId": project_id,
        "previousStatus": record.previous_status,
        "settledOn": record.settled_on,
        "waivers": record.waivers.iter().map(|w| w.kind.clone()).collect::<Vec<_>>(),
    })
}

#[derive(sqlx::FromRow)]
struct ProjectRow {
    status: String,
    row_version: i64,
    revenue_version: i64,
}

/// (count, version sum, last id) of each table the check reads.
type Fingerprint = Vec<(i64, i64, i64)>;

const FINGERPRINT_SQL: [&str; 4] = [
    "SELECT CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(row_version), 0) AS BIGINT), \
     CAST(COALESCE(MAX(id), 0) AS BIGINT) FROM time_entries WHERE project_id = ?",
    "SELECT CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(row_version), 0) AS BIGINT), \
     CAST(COALESCE(MAX(id), 0) AS BIGINT) FROM direct_costs WHERE project_id = ? OR id IN \
     (SELECT direct_cost_id FROM cost_allocations WHERE project_id = ?)",
    "SELECT CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(row_version), 0) AS BIGINT), \
     CAST(COALESCE(MAX(id), 0) AS BIGINT) FROM purchase_orders WHERE project_id = ?",
    "SELECT CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(row_version), 0) AS BIGINT), \
     CAST(COALESCE(MAX(id), 0) AS BIGINT) FROM forecast_versions WHERE project_id = ?",
];

/// Read the fingerprint with `$exec` (a pool or a transaction).
macro_rules! fingerprint {
    ($exec:expr, $sql:expr, $project:expr) => {{
        let a: Option<(i64, i64, i64)> = fetch_optional!($exec, $sql[0], $project)?;
        let b: Option<(i64, i64, i64)> = fetch_optional!($exec, $sql[1], $project, $project)?;
        let c: Option<(i64, i64, i64)> = fetch_optional!($exec, $sql[2], $project)?;
        let d: Option<(i64, i64, i64)> = fetch_optional!($exec, $sql[3], $project)?;
        vec![
            a.unwrap_or_default(),
            b.unwrap_or_default(),
            c.unwrap_or_default(),
            d.unwrap_or_default(),
        ]
    }};
}

/// How a purchase order is named on the check and the record.
fn order_label(ordered_on: &str, vendor: Option<&str>, description: Option<&str>) -> String {
    [Some(ordered_on), vendor, description]
        .into_iter()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn status_error(message: &str) -> BantoError {
    BantoError::Validation {
        field_errors: vec![field_error("status", message)],
    }
}

fn blocker_view(b: &Blocker, labels: &[(i64, String)]) -> BlockerView {
    let mut v = BlockerView {
        kind: b.code().to_string(),
        waivable: b.waivable(),
        amount: b.amount(),
        purchase_order_id: None,
        purchase_order_label: None,
        count: None,
        time_entries: None,
        minutes: None,
        costs: None,
    };
    let n = |c: usize| i64::try_from(c).unwrap_or(i64::MAX);
    match b {
        Blocker::Unapproved {
            time_entries,
            minutes,
            costs,
        } => {
            v.count = Some(n(*time_entries) + n(*costs));
            v.time_entries = Some(n(*time_entries));
            v.minutes = Some(*minutes);
            v.costs = Some(n(*costs));
        }
        Blocker::MissingRate { entries } | Blocker::Provisional { entries } => {
            v.count = Some(n(*entries));
        }
        Blocker::PendingOrderChanges { changes } => v.count = Some(n(*changes)),
        Blocker::PurchaseRemaining {
            purchase_order_id, ..
        } => {
            let id = purchase_order_id.parse().ok();
            v.purchase_order_id = id;
            v.purchase_order_label = labels
                .iter()
                .find(|(o, _)| Some(*o) == id)
                .map(|(_, l)| l.clone());
        }
        Blocker::ForecastRemaining { .. } | Blocker::RevenueDifference { .. } => {}
    }
    v
}

/// The domain blocker a waiver input names, or a field error.
fn waiver_blocker(w: &WaiverInput) -> Result<Blocker, FieldError> {
    match w.kind.as_str() {
        "purchase_remaining" => match w.purchase_order_id {
            Some(id) => Ok(Blocker::PurchaseRemaining {
                purchase_order_id: id.to_string(),
                amount: w.amount,
            }),
            None => Err(field_error("waivers", "発注を指定してください")),
        },
        "forecast_remaining" => Ok(Blocker::ForecastRemaining { amount: w.amount }),
        "revenue_difference" => Ok(Blocker::RevenueDifference { amount: w.amount }),
        _ => Err(field_error("waivers", "この項目は理由つきで解消できません")),
    }
}

/// The message of an item still blocking the settlement.
fn blocker_message(b: &Blocker) -> String {
    match b {
        Blocker::Unapproved {
            time_entries,
            costs,
            ..
        } => format!(
            "未承認の工数{time_entries}件・直接費{costs}件があります。承認か差戻し・削除をしてください"
        ),
        Blocker::MissingRate { entries } => {
            format!("単価未設定で原価未確定の工数が{entries}件あります")
        }
        Blocker::Provisional { entries } => {
            format!("請求確定していない仮計上が{entries}件あります")
        }
        Blocker::PendingOrderChanges { changes } => {
            format!("判断待ちの受注変更が{changes}件あります")
        }
        Blocker::PurchaseRemaining {
            purchase_order_id, ..
        } => format!(
            "発注 {purchase_order_id} の未実績発注残があります。実績化・取消するか、理由を入力してください"
        ),
        Blocker::ForecastRemaining { .. } => {
            "完了見込の残見込みがあります。見込を更新するか、理由を入力してください".into()
        }
        Blocker::RevenueDifference { .. } => {
            "未計上の売上差額があります。売上を計上するか、理由を入力してください".into()
        }
    }
}

#[derive(Clone)]
pub struct CloseoutsService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl CloseoutsService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    /// Emit `ResourceChanged { resource: "projects" }` after a settlement
    /// (the project's status changes).
    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    async fn fingerprint(&self, project_id: i64) -> Result<Fingerprint, BantoError> {
        let fp_sql: Vec<String> = FINGERPRINT_SQL.iter().map(|s| self.sql(s)).collect();
        Ok(on_pool!(&self.db, pool => fingerprint!(pool, fp_sql, project_id)))
    }

    async fn project(&self, project_id: i64) -> Result<(ProjectStatus, ProjectRow), BantoError> {
        let sql =
            self.sql("SELECT status, row_version, revenue_version FROM projects WHERE id = ?");
        let row: Option<ProjectRow> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))?;
        let row = row.ok_or_else(|| BantoError::NotFound {
            resource: "projects".into(),
            id: project_id.to_string(),
        })?;
        let status = ProjectStatus::parse(&row.status)
            .ok_or_else(|| BantoError::Other(format!("不明な案件の状態です: {}", row.status)))?;
        Ok((status, row))
    }

    /// The state the domain check reads, and a label per purchase order.
    async fn state(
        &self,
        project_id: i64,
    ) -> Result<(CloseoutState, Vec<(i64, String)>), BantoError> {
        // COUNTS: a replaced entry and a returned correction count as
        // nothing (T11) - an entry approved without a rate is resolved by an
        // approved correction, whose approval fixes the rate.
        // A waiting correction also blocks the project of the entry it would
        // replace, wherever it moves the hours: settling first would leave
        // it impossible to approve (PR #24 review).
        let time_sql = self.sql(&format!(
            "SELECT CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(t.minutes), 0) AS BIGINT) \
             FROM time_entries t WHERE (t.project_id = ? OR (t.status = 'submitted' \
             AND t.corrects_id IN (SELECT o.id FROM time_entries o WHERE o.project_id = ?))) \
             AND t.status <> 'approved' AND {COUNTS}"
        ));
        let rate_sql = self.sql(&format!(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM time_entries t \
             WHERE t.project_id = ? AND t.status = 'approved' AND t.labor_cost IS NULL \
             AND {COUNTS}"
        ));
        let (time, missing): (Option<(i64, i64)>, i64) = on_pool!(&self.db, pool => (
            fetch_optional!(pool, time_sql, project_id, project_id)?,
            scalar!(pool, rate_sql, project_id)?,
        ));
        let (time_count, time_minutes) = time.unwrap_or_default();
        let costs = DirectCostsService::new(self.db.clone())
            .project_costs(project_id)
            .await?;
        let order = OrdersService::new(self.db.clone())
            .summary(project_id)
            .await?;
        let forecast = ForecastsService::new(self.db.clone())
            .overview(project_id)
            .await?;
        let count = |n: i64| usize::try_from(n).unwrap_or(0);
        let labels = costs
            .orders
            .iter()
            .map(|o| {
                (
                    o.id,
                    order_label(
                        &o.ordered_on,
                        o.vendor_name.as_deref(),
                        o.description.as_deref(),
                    ),
                )
            })
            .collect();
        // Oldest order first, whatever the list order.
        let mut purchase_remaining: Vec<(i64, i64)> =
            costs.orders.iter().map(|o| (o.id, o.remaining)).collect();
        purchase_remaining.sort();
        let state = CloseoutState {
            unapproved_time_entries: count(time_count),
            unapproved_minutes: time_minutes,
            unapproved_costs: count(costs.pending.count),
            missing_rate_entries: count(missing),
            provisional_entries: count(costs.provisional.count),
            pending_order_changes: order
                .changes
                .iter()
                .filter(|c| c.status == "pending")
                .count(),
            purchase_remaining: purchase_remaining
                .into_iter()
                .map(|(id, remaining)| (id.to_string(), remaining))
                .collect(),
            // The orders' remainders are counted per order above.
            forecast_remaining: forecast
                .latest
                .as_ref()
                .map(|f| f.remaining_total.unwrap_or(0) - f.committed_total),
            unrecognized_revenue: order.remaining.unwrap_or(0),
        };
        Ok((state, labels))
    }

    /// Every settlement of the project, newest first, with its waivers and
    /// its cancellation if any.
    async fn records(&self, project_id: i64) -> Result<Vec<CloseoutRecord>, BantoError> {
        let sql = self.sql(
            "SELECT c.id, c.previous_status, c.settled_on, c.note, \
             u.display_name AS settled_by_name, c.created_at FROM project_closeouts c \
             LEFT JOIN users u ON u.id = c.settled_by WHERE c.project_id = ? ORDER BY c.id DESC",
        );
        let waivers_sql = self.sql(
            "SELECT w.closeout_id, w.kind, w.purchase_order_id, w.amount, w.reason, \
             u.display_name AS approved_by_name, po.ordered_on, v.name AS vendor_name, \
             po.description AS order_description FROM closeout_waivers w \
             JOIN project_closeouts c ON c.id = w.closeout_id \
             LEFT JOIN users u ON u.id = w.approved_by \
             LEFT JOIN purchase_orders po ON po.id = w.purchase_order_id \
             LEFT JOIN vendors v ON v.id = po.vendor_id WHERE c.project_id = ? ORDER BY w.id",
        );
        let reopenings_sql = self.sql(
            "SELECT r.closeout_id, r.reopened_on, r.reason, u.display_name AS reopened_by_name, \
             r.created_at FROM closeout_reopenings r \
             JOIN project_closeouts c ON c.id = r.closeout_id \
             LEFT JOIN users u ON u.id = r.reopened_by WHERE c.project_id = ?",
        );
        let (mut rows, waivers, reopenings): (
            Vec<CloseoutRecord>,
            Vec<WaiverView>,
            Vec<ReopeningView>,
        ) = on_pool!(&self.db, pool => (
            fetch_all!(pool, sql, project_id)?,
            fetch_all!(pool, waivers_sql, project_id)?,
            fetch_all!(pool, reopenings_sql, project_id)?,
        ));
        for row in &mut rows {
            row.waivers = waivers
                .iter()
                .filter(|w| w.closeout_id == row.id)
                .cloned()
                .map(|mut w| {
                    w.purchase_order_label = w.ordered_on.as_deref().map(|on| {
                        order_label(on, w.vendor_name.as_deref(), w.order_description.as_deref())
                    });
                    w
                })
                .collect();
            row.reopening = reopenings.iter().find(|r| r.closeout_id == row.id).cloned();
        }
        Ok(rows)
    }

    /// What blocks the settlement of the project now, and the settlement
    /// once recorded.
    pub async fn check(&self, project_id: i64) -> Result<CloseoutCheck, BantoError> {
        let (status, row) = self.project(project_id).await?;
        let blockers = if status.settleable() {
            let (state, labels) = self.state(project_id).await?;
            cost_domain::closeout::blockers(&state)
                .iter()
                .map(|b| blocker_view(b, &labels))
                .collect()
        } else {
            Vec::new()
        };
        // The settlement in force is the latest one not cancelled, while the
        // project is settled; the cancelled ones are the history.
        let (history, current): (Vec<_>, Vec<_>) = self
            .records(project_id)
            .await?
            .into_iter()
            .partition(|r| r.reopening.is_some());
        let closeout = if status == ProjectStatus::Settled {
            current.into_iter().next()
        } else {
            None
        };
        Ok(CloseoutCheck {
            project_id,
            status: row.status,
            row_version: row.row_version,
            settleable: status.settleable(),
            blockers,
            closeout,
            history,
        })
    }

    /// Settle a work-done project (T17). Every blocker must be gone, or be a
    /// remaining amount waived with a reason for exactly its current amount;
    /// `actor_user_id` approves the waivers.
    pub async fn settle(
        &self,
        project_id: i64,
        input: SettleInput,
        actor_user_id: Option<i64>,
    ) -> Result<CloseoutCheck, BantoError> {
        let (status, row) = self.project(project_id).await?;
        if status == ProjectStatus::Settled {
            return Err(status_error("この案件は既に精算完了しています"));
        }
        if !status.settleable() {
            return Err(status_error("作業完了の案件だけを精算完了にできます"));
        }
        if input.row_version != row.row_version {
            return Err(stale_version_error());
        }
        let note = input
            .note
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string);
        let mut errors = Vec::new();
        if note
            .as_ref()
            .is_some_and(|n| n.chars().count() > MAX_TEXT_LEN)
        {
            errors.push(field_error(
                "note",
                format!("{MAX_TEXT_LEN}文字以内で入力してください"),
            ));
        }
        let approver = actor_user_id.map(|id| id.to_string());
        let mut waivers = Vec::new();
        for w in &input.waivers {
            match waiver_blocker(w) {
                Ok(blocker) => {
                    let reason = w.reason.trim().to_string();
                    if reason.chars().count() > MAX_TEXT_LEN {
                        errors.push(field_error(
                            "waivers",
                            format!("{MAX_TEXT_LEN}文字以内で入力してください"),
                        ));
                    }
                    waivers.push(Waiver {
                        blocker,
                        reason,
                        approved_by: approver.clone(),
                    });
                }
                Err(e) => errors.push(e),
            }
        }
        if !errors.is_empty() {
            return Err(BantoError::Validation {
                field_errors: errors,
            });
        }

        let fp_sql: Vec<String> = FINGERPRINT_SQL.iter().map(|s| self.sql(s)).collect();
        let before = self.fingerprint(project_id).await?;
        let (state, _) = self.state(project_id).await?;
        let applied = check_closeout(&state, &waivers).map_err(|e| match e {
            CloseoutError::Blocked {
                unresolved,
                invalid_waivers,
            } => {
                let mut field_errors: Vec<FieldError> = unresolved
                    .iter()
                    .map(|b| field_error("blockers", blocker_message(b)))
                    .collect();
                if !invalid_waivers.is_empty() {
                    field_errors.push(field_error(
                        "waivers",
                        "解消の理由を入力してください（未承認・単価未設定・仮計上・受注変更は理由では解消できません）",
                    ));
                }
                BantoError::Validation { field_errors }
            }
        })?;

        let today = crate::business_date::today();
        let settled_on = today.to_string();
        let now = now_expr(self.db.dialect());
        let guard = self.sql(&format!(
            "UPDATE projects SET status = 'settled', row_version = row_version + 1, \
             revenue_version = revenue_version + 1, updated_at = {now} \
             WHERE id = ? AND row_version = ? AND revenue_version = ? AND status = 'work_done'"
        ));
        let insert = self.sql(
            "INSERT INTO project_closeouts (project_id, previous_status, settled_on, note, \
             settled_by) VALUES (?, ?, ?, ?, ?) RETURNING id",
        );
        let insert_waiver = self.sql(
            "INSERT INTO closeout_waivers (closeout_id, kind, purchase_order_id, amount, reason, \
             approved_by) VALUES (?, ?, ?, ?, ?, ?)",
        );
        let rows: Vec<(String, Option<i64>, i64, String)> = applied
            .iter()
            .map(|w| {
                let po = match &w.blocker {
                    Blocker::PurchaseRemaining {
                        purchase_order_id, ..
                    } => purchase_order_id.parse().ok(),
                    _ => None,
                };
                (
                    w.blocker.code().to_string(),
                    po,
                    w.blocker.amount().unwrap_or(0),
                    w.reason.clone(),
                )
            })
            .collect();
        let previous = row.status.clone();
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, guard, project_id, row.row_version, row.revenue_version)? == 0 {
                return Err(stale_version_error());
            }
            let after: Fingerprint = fingerprint!(&mut *tx, fp_sql, project_id);
            if after != before {
                return Err(stale_version_error());
            }
            let id: i64 = scalar!(&mut *tx, insert, project_id, &previous, &settled_on, &note,
                actor_user_id)?;
            for (kind, po, amount, reason) in &rows {
                execute!(&mut *tx, insert_waiver, id, kind, *po, *amount, reason, actor_user_id)?;
            }
        });
        crate::events::notify_changed(&self.events, "projects");
        self.check(project_id).await
    }

    /// Cancel the settlement of a settled project (精算完了の取消): back to
    /// 作業完了 (`ProjectStatus::reopened_to`) with a reason. The settlement
    /// and its waivers are kept; `actor_user_id` is recorded as who reopened.
    pub async fn reopen(
        &self,
        project_id: i64,
        input: ReopenInput,
        actor_user_id: Option<i64>,
    ) -> Result<CloseoutCheck, BantoError> {
        let (status, row) = self.project(project_id).await?;
        let Some(to) = status.reopened_to() else {
            return Err(status_error("精算完了の案件だけを取り消せます"));
        };
        if input.row_version != row.row_version {
            return Err(stale_version_error());
        }
        let reason = input.reason.trim().to_string();
        if reason.is_empty() {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("reason", "取り消す理由を入力してください")],
            });
        }
        if reason.chars().count() > MAX_TEXT_LEN {
            return Err(BantoError::Validation {
                field_errors: vec![field_error(
                    "reason",
                    format!("{MAX_TEXT_LEN}文字以内で入力してください"),
                )],
            });
        }
        let today = crate::business_date::today();
        let reopened_on = today.to_string();
        let now = now_expr(self.db.dialect());
        let guard = self.sql(&format!(
            "UPDATE projects SET status = ?, row_version = row_version + 1, \
             revenue_version = revenue_version + 1, updated_at = {now} \
             WHERE id = ? AND row_version = ? AND status = 'settled'"
        ));
        // The settlement in force: the latest one, not cancelled yet.
        let latest = self.sql(
            "SELECT c.id FROM project_closeouts c WHERE c.project_id = ? AND NOT EXISTS \
             (SELECT 1 FROM closeout_reopenings r WHERE r.closeout_id = c.id) \
             ORDER BY c.id DESC LIMIT 1",
        );
        let insert = self.sql(
            "INSERT INTO closeout_reopenings (closeout_id, reopened_on, reason, reopened_by) \
             VALUES (?, ?, ?, ?)",
        );
        let to = to.as_str();
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, guard, to, project_id, row.row_version)? == 0 {
                return Err(stale_version_error());
            }
            let closeout: Option<(i64,)> = fetch_optional!(&mut *tx, latest, project_id)?;
            let Some((closeout_id,)) = closeout else {
                return Err(BantoError::Other(
                    "精算完了の記録が見つかりません".into(),
                ));
            };
            execute!(&mut *tx, insert, closeout_id, &reopened_on, &reason, actor_user_id)?;
        });
        crate::events::notify_changed(&self.events, "projects");
        self.check(project_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::direct_costs::DirectCostInput;
    use crate::forecasts::tests::{rem, spec_project};
    use crate::forecasts::ForecastDraftInput;
    use crate::orders::tests::{line, ordered_project};
    use crate::orders::RecognitionInput;
    use crate::projects::tests::fixture;
    use crate::time_entries::DecisionInput;

    async fn set_status(db: &Db, project: i64, status: &str) {
        let sql = placeholders(
            db.dialect(),
            "UPDATE projects SET status = ?, row_version = row_version + 1 WHERE id = ?",
        );
        on_pool!(db, pool => execute!(pool, sql, status, project)).unwrap();
    }

    fn fields(err: BantoError) -> Vec<(String, String)> {
        match err {
            BantoError::Validation { field_errors } => field_errors
                .into_iter()
                .map(|e| (e.field, e.message))
                .collect(),
            other => panic!("validation expected, got {other:?}"),
        }
    }

    fn waive(b: &BlockerView, reason: &str) -> WaiverInput {
        WaiverInput {
            kind: b.kind.clone(),
            purchase_order_id: b.purchase_order_id,
            amount: b.amount.unwrap(),
            reason: reason.into(),
        }
    }

    fn settle_input(row_version: i64, waivers: Vec<WaiverInput>) -> SettleInput {
        SettleInput {
            row_version,
            note: Some("精算".into()),
            waivers,
        }
    }

    #[tokio::test]
    async fn t17_only_a_work_done_project_without_blockers_is_settled() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-S01", vec![line(Some("2026-12"), 1_000_000)]).await;
        let svc = CloseoutsService::new(db.clone());
        // Not work-done yet: no check, refused.
        let c = svc.check(p).await.unwrap();
        assert!(!c.settleable);
        assert!(c.blockers.is_empty());
        let err = svc
            .settle(p, settle_input(c.row_version, vec![]), Some(1))
            .await
            .unwrap_err();
        assert_eq!(fields(err)[0].0, "status");

        // Work done: the unrecognized revenue blocks it.
        set_status(&db, p, "work_done").await;
        let c = svc.check(p).await.unwrap();
        assert!(c.settleable);
        assert_eq!(c.blockers.len(), 1);
        assert_eq!(c.blockers[0].kind, "revenue_difference");
        assert_eq!(c.blockers[0].amount, Some(1_000_000));
        assert!(c.blockers[0].waivable);
        // Recognizing it clears the blocker (the revenue version moved).
        OrdersService::new(db.clone())
            .recognize(
                p,
                RecognitionInput {
                    recognized_on: "2026-12-10".into(),
                    amount: 1_000_000,
                    basis: Some("検収".into()),
                    clears: None,
                },
                Some(1),
            )
            .await
            .unwrap();
        let c = svc.check(p).await.unwrap();
        assert!(c.blockers.is_empty());
        // A stale row version is refused.
        assert!(matches!(
            svc.settle(p, settle_input(c.row_version - 1, vec![]), Some(1))
                .await,
            Err(BantoError::Validation { .. })
        ));
        let done = svc
            .settle(p, settle_input(c.row_version, vec![]), Some(1))
            .await
            .unwrap();
        assert_eq!(done.status, "settled");
        assert!(!done.settleable);
        let rec = done.closeout.unwrap();
        assert_eq!(rec.previous_status, "work_done");
        assert_eq!(rec.note.as_deref(), Some("精算"));
        assert!(rec.waivers.is_empty());
        // Settled once; the other services refuse new records.
        let err = svc
            .settle(p, settle_input(done.row_version, vec![]), Some(1))
            .await
            .unwrap_err();
        assert_eq!(fields(err)[0].0, "status");
        let err = OrdersService::new(db.clone())
            .recognize(
                p,
                RecognitionInput {
                    recognized_on: "2026-12-11".into(),
                    amount: 1,
                    basis: None,
                    clears: None,
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(fields(err)[0].0, "status");
    }

    #[tokio::test]
    async fn t17_a_settlement_is_reopened_with_a_reason_and_settled_again() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-S05", vec![line(Some("2026-12"), 1_000)]).await;
        set_status(&db, p, "work_done").await;
        let svc = CloseoutsService::new(db.clone());
        let reopen = |row_version: i64, reason: &str| ReopenInput {
            row_version,
            reason: reason.into(),
        };
        // Only a settled project is reopened.
        let c = svc.check(p).await.unwrap();
        let err = svc
            .reopen(p, reopen(c.row_version, "誤り"), Some(1))
            .await
            .unwrap_err();
        assert_eq!(fields(err)[0].0, "status");

        let waiver = |c: &CloseoutCheck, reason: &str| {
            settle_input(c.row_version, vec![waive(&c.blockers[0], reason)])
        };
        let first = svc.settle(p, waiver(&c, "値引き"), Some(1)).await.unwrap();
        assert_eq!(first.status, "settled");
        assert!(first.history.is_empty());
        // A reason is required; a stale row version is refused.
        let err = svc
            .reopen(p, reopen(first.row_version, "  "), Some(1))
            .await
            .unwrap_err();
        assert_eq!(fields(err)[0].0, "reason");
        assert!(matches!(
            svc.reopen(p, reopen(first.row_version - 1, "誤り"), Some(1))
                .await,
            Err(BantoError::Validation { .. })
        ));

        let reopened = svc
            .reopen(p, reopen(first.row_version, "売上の計上漏れ"), Some(1))
            .await
            .unwrap();
        assert_eq!(reopened.status, "work_done");
        assert!(reopened.settleable);
        assert!(reopened.closeout.is_none());
        // The settlement and its waiver are kept, with the cancellation.
        assert_eq!(reopened.history.len(), 1);
        let past = &reopened.history[0];
        assert_eq!(past.waivers.len(), 1);
        assert_eq!(past.waivers[0].reason, "値引き");
        let r = past.reopening.as_ref().unwrap();
        assert_eq!(r.reason, "売上の計上漏れ");
        assert!(r.reopened_by_name.is_some());
        let detail = reopen_audit_detail(p, past);
        assert_eq!(detail["closeoutId"], past.id);
        assert!(!detail.to_string().contains("売上の計上漏れ"), "no reason");
        // The check runs anew: the remaining revenue blocks it again.
        assert_eq!(reopened.blockers[0].kind, "revenue_difference");
        // Records are taken again while it is open.
        OrdersService::new(db.clone())
            .recognize(
                p,
                RecognitionInput {
                    recognized_on: "2026-12-10".into(),
                    amount: 1_000,
                    basis: None,
                    clears: None,
                },
                Some(1),
            )
            .await
            .unwrap();
        let c = svc.check(p).await.unwrap();
        assert!(c.blockers.is_empty());
        let second = svc
            .settle(p, settle_input(c.row_version, vec![]), Some(1))
            .await
            .unwrap();
        assert_eq!(second.status, "settled");
        let rec = second.closeout.unwrap();
        assert_ne!(rec.id, past.id);
        assert!(rec.waivers.is_empty());
        assert!(rec.reopening.is_none());
        assert_eq!(second.history.len(), 1);
        assert_eq!(second.history[0].id, past.id);
    }

    #[tokio::test]
    async fn t17_processing_is_required_and_remaining_amounts_are_waived() {
        let db = fixture().await;
        let (p, material, outsource) = spec_project(&db, "P-S02").await;
        // The spec forecast: remaining 100h labor, travel 70,000, other
        // 30,000 besides the 400,000 left on the orders.
        let forecasts = ForecastsService::new(db.clone());
        let d = forecasts.create_draft(p, Some(2)).await.unwrap().draft;
        let d = forecasts
            .update_draft(
                d.id,
                ForecastDraftInput {
                    base_date: "2026-01-31".into(),
                    planned_end: None,
                    reason: Some("初回".into()),
                    lines: vec![
                        rem(Some(1), "labor", Some(100 * 60), None),
                        rem(None, "travel", None, Some(70_000)),
                        rem(None, "other", None, Some(30_000)),
                    ],
                    row_version: d.row_version,
                },
                Some(2),
            )
            .await
            .unwrap();
        forecasts.adopt(&d, d.row_version, Some(1)).await.unwrap();
        // An hour without a rate, and a direct cost waiting for approval.
        let sql = placeholders(
            db.dialect(),
            "INSERT INTO time_entries (work_date, user_id, project_id, phase_id, minutes, \
             status) VALUES ('2026-02-01', 1, ?, 1, 60, 'approved')",
        );
        on_pool!(&db, pool => execute!(pool, sql, p)).unwrap();
        let costs = DirectCostsService::new(db.clone());
        let pending = costs
            .create(
                1,
                DirectCostInput {
                    project_id: Some(p),
                    cost_type: Some("travel".into()),
                    booked_on: "2026-02-02".into(),
                    amount: 5_000,
                    client_request_id: Some("s02-travel".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .cost;
        set_status(&db, p, "work_done").await;

        let svc = CloseoutsService::new(db.clone());
        let c = svc.check(p).await.unwrap();
        let kinds: Vec<&str> = c.blockers.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec![
                "unapproved",
                "missing_rate",
                "purchase_remaining",
                "purchase_remaining",
                "forecast_remaining",
                "revenue_difference",
            ]
        );
        assert_eq!(c.blockers[0].costs, Some(1));
        assert_eq!(c.blockers[1].count, Some(1));
        let po: Vec<(Option<i64>, Option<i64>)> = c.blockers[2..4]
            .iter()
            .map(|b| (b.purchase_order_id, b.amount))
            .collect();
        assert_eq!(
            po,
            vec![
                (Some(material), Some(200_000)),
                (Some(outsource), Some(200_000))
            ]
        );
        // The forecast's remaining without the orders: 500,000 + 70,000 +
        // 30,000 (the 400,000 on the orders is counted per order).
        assert_eq!(c.blockers[4].amount, Some(600_000));

        // Waivers alone do not settle while records need processing.
        let all: Vec<WaiverInput> = c
            .blockers
            .iter()
            .filter(|b| b.waivable)
            .map(|b| waive(b, "不要になった"))
            .collect();
        let err = svc
            .settle(p, settle_input(c.row_version, all.clone()), Some(1))
            .await
            .unwrap_err();
        let f = fields(err);
        assert_eq!(f.len(), 2, "{f:?}");
        assert!(f.iter().all(|(field, _)| field == "blockers"));

        // Process them: approve the cost, and price the hour by correcting
        // it once the rate is registered (P6b-2: the correction's approval
        // fixes the rate, the entry it replaces drops out).
        let submitted = costs
            .submit(1, pending.id, pending.row_version)
            .await
            .unwrap();
        costs
            .decide(
                &submitted,
                DecisionInput {
                    approve: true,
                    reason: None,
                    row_version: submitted.row_version,
                },
                Some(1),
            )
            .await
            .unwrap();
        crate::calc_basis::CalcBasisService::new(db.clone())
            .add(
                None,
                crate::calc_basis::tests::value("emp_rate", "2026-01-01", Some(6_000), "標準"),
                Some(1),
            )
            .await
            .unwrap();
        let time = crate::time_entries::TimeEntriesService::new(db.clone());
        let sql = placeholders(
            db.dialect(),
            "SELECT id FROM time_entries WHERE project_id = ? AND labor_cost IS NULL",
        );
        let unpriced: i64 = on_pool!(&db, pool => scalar!(pool, sql, p)).unwrap();
        let original = time.get(unpriced).await.unwrap();
        let correction = time
            .correct(
                1,
                unpriced,
                crate::time_entries::CorrectionInput {
                    entry: crate::time_entries::TimeEntryInput {
                        work_date: original.work_date.clone(),
                        project_id: Some(p),
                        phase_id: Some(1),
                        minutes: 60,
                        row_version: Some(original.row_version),
                        ..Default::default()
                    },
                    reason: Some("単価登録後の再計算".into()),
                },
            )
            .await
            .unwrap()
            .entry;
        let c = svc.check(p).await.unwrap();
        assert!(
            c.blockers.iter().any(|b| !b.waivable),
            "the correction in flight needs processing"
        );
        let priced = time
            .decide(
                &correction,
                DecisionInput {
                    approve: true,
                    reason: None,
                    row_version: correction.row_version,
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(priced.labor_cost, Some(6_000));

        let c = svc.check(p).await.unwrap();
        assert!(c.blockers.iter().all(|b| b.waivable));
        // A waiver without a reason, and one for an amount that changed.
        let mut ws: Vec<WaiverInput> = c
            .blockers
            .iter()
            .map(|b| waive(b, "不要になった"))
            .collect();
        ws[0].reason = " ".into();
        let err = svc
            .settle(p, settle_input(c.row_version, ws.clone()), Some(1))
            .await
            .unwrap_err();
        assert!(fields(err).iter().any(|(f, _)| f == "waivers"));
        ws[0].reason = "部材が不要になった".into();
        ws[1].amount -= 1;
        let err = svc
            .settle(p, settle_input(c.row_version, ws.clone()), Some(1))
            .await
            .unwrap_err();
        assert_eq!(
            fields(err),
            vec![(
                "blockers".into(),
                blocker_message(&Blocker::PurchaseRemaining {
                    purchase_order_id: outsource.to_string(),
                    amount: 200_000,
                })
            )]
        );
        ws[1].amount += 1;
        let done = svc
            .settle(p, settle_input(c.row_version, ws), Some(1))
            .await
            .unwrap();
        assert_eq!(done.status, "settled");
        let rec = done.closeout.unwrap();
        let kinds: Vec<(&str, i64)> = rec
            .waivers
            .iter()
            .map(|w| (w.kind.as_str(), w.amount))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("purchase_remaining", 200_000),
                ("purchase_remaining", 200_000),
                ("forecast_remaining", 600_000),
                ("revenue_difference", 4_000_000),
            ]
        );
        assert_eq!(rec.waivers[0].reason, "部材が不要になった");
        assert_eq!(
            rec.waivers[0].purchase_order_label.as_deref(),
            Some("2026-01-05")
        );
        assert!(rec.waivers.iter().all(|w| w.approved_by_name.is_some()));
        let detail = audit_detail(p, &rec);
        assert_eq!(detail["waivers"].as_array().unwrap().len(), 4);
        assert!(!detail.to_string().contains("200000"), "no amounts");
    }

    /// What the writers run after their write (PR #20 review): a record that
    /// passed the open-project check before a settlement committed is still
    /// refused in its own transaction.
    async fn write_then_check(db: &Db, project: i64) -> Result<(), BantoError> {
        let insert = placeholders(
            db.dialect(),
            "INSERT INTO time_entries (work_date, user_id, project_id, phase_id, minutes, \
             status) VALUES ('2026-02-01', 1, ?, 1, 60, 'draft')",
        );
        let settled = settled_check_sql(db.dialect());
        in_tx!(db, tx => {
            execute!(&mut *tx, insert, project)?;
            refuse_settled!(&mut *tx, settled, project, "projectId", "精算完了");
        });
        Ok(())
    }

    #[tokio::test]
    async fn t13_a_write_racing_a_settlement_is_refused_in_its_transaction() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-S04", vec![line(None, 1_000)]).await;
        write_then_check(&db, p).await.unwrap();
        set_status(&db, p, "settled").await;
        let err = write_then_check(&db, p).await.unwrap_err();
        assert_eq!(fields(err)[0].0, "projectId");
        // Rolled back: only the first entry is there.
        let count = placeholders(
            db.dialect(),
            "SELECT CAST(COUNT(*) AS BIGINT) FROM time_entries WHERE project_id = ?",
        );
        let n: i64 = on_pool!(&db, pool => scalar!(pool, count, p)).unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn t13_a_write_between_the_check_and_the_commit_is_stale() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-S03", vec![line(None, 1_000)]).await;
        set_status(&db, p, "work_done").await;
        let svc = CloseoutsService::new(db.clone());
        let before = svc.fingerprint(p).await.unwrap();
        DirectCostsService::new(db.clone())
            .create(
                1,
                DirectCostInput {
                    project_id: Some(p),
                    cost_type: Some("other".into()),
                    booked_on: "2026-02-02".into(),
                    amount: 1,
                    client_request_id: Some("s03".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_ne!(before, svc.fingerprint(p).await.unwrap());
    }
}
