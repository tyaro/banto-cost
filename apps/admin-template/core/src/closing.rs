//! 月次締め (monthly close, banto-cost P6b, `docs/project/design.md` §3.5.2,
//! spec §7 / §9, T11).
//!
//! The rules live in `cost_domain::closing`; this module loads and stores
//! the months, the close/reopen history and the figures saved at each close.
//! Authorization (`Operation::CloseMonth`: `finance.close` + `amount.view`, for every route) and audit are
//! the REST/Tauri wiring's.
//!
//! A closed month refuses every write of hours, direct costs and revenue
//! recognitions whose business date (work date, booking date, recognition
//! date) falls in it: create, change, delete, submit, approve/return and
//! cancel. A correction is made by reopening the month (accounting, with a
//! reason), correcting through the normal workflow and closing it again; the
//! figures saved at the earlier close stay, so the difference is visible.
//!
//! Concurrency (T13): a writer upserts its month's `open` row and reads it
//! back in its own transaction after its write ([`refuse_closed!`]); the
//! closer upserts and locks the same row before re-counting the month's
//! unapproved records and comparing a fingerprint of the month's rows with
//! the one taken before the figures were computed. On SQLite the transaction
//! that writes first holds the write lock; on Postgres the row lock orders
//! them (`FOR SHARE` / `FOR UPDATE`).

use std::collections::BTreeMap;

use banto_core::BantoError;
use banto_server::ServerEvent;
use banto_storage::{Db, Dialect};
use cost_domain::closing::{
    check_close, check_reopen, compare, warnings, CloseIssue, MonthFigures, MonthState,
    MonthStatus, ReopenIssue,
};
use cost_domain::{Date, YearMonth};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::customers::{field_error, now_expr, stale_version_error};
use crate::direct_costs::DirectCostsService;
use crate::orders::{
    execute, fetch_all, fetch_optional, in_tx, on_pool, placeholders, scalar, MAX_TEXT_LEN,
};
use crate::time_entries::COUNTS;

pub const RESOURCE: &str = "closing_periods";

/// The two statements a writer runs in its transaction for the month of its
/// business date: create the month's `open` row if missing, then read its
/// status (`FOR SHARE` on Postgres).
pub(crate) struct MonthGate {
    pub(crate) upsert: String,
    pub(crate) read: String,
}

impl MonthGate {
    pub(crate) fn new(dialect: Dialect) -> Self {
        let read = match dialect {
            Dialect::Sqlite => "SELECT status FROM closing_periods WHERE month = ?",
            Dialect::Postgres => "SELECT status FROM closing_periods WHERE month = ? FOR SHARE",
        };
        Self {
            upsert: placeholders(
                dialect,
                "INSERT INTO closing_periods (month, status) VALUES (?, 'open') \
                 ON CONFLICT (month) DO NOTHING",
            ),
            read: placeholders(dialect, read),
        }
    }
}

/// The month (`YYYY-MM`) of a stored business date (`YYYY-MM-DD`).
pub(crate) fn month_of(date: &str) -> String {
    date.get(..7).unwrap_or(date).to_string()
}

/// The message of a write refused because its month is closed.
pub(crate) fn closed_message(month: &str) -> String {
    let label = YearMonth::parse(month)
        .map(|m| format!("{}年{}月", m.year, m.month))
        .unwrap_or_else(|| month.to_string());
    format!("{label}は締め済みです。経理が月を再開するまで登録・変更できません")
}

/// Refuse (`return Err`) when the month of `$date` (`YYYY-MM-DD`) is closed,
/// reading with `$exec` inside the writer's transaction ([`MonthGate`]).
macro_rules! refuse_closed {
    ($exec:expr, $gate:expr, $date:expr, $field:expr) => {{
        let month = crate::closing::month_of($date);
        execute!($exec, $gate.upsert, &month)?;
        let row: Option<(String,)> = fetch_optional!($exec, $gate.read, &month)?;
        if row.is_some_and(|(status,)| status == "closed") {
            return Err(BantoError::Validation {
                field_errors: vec![crate::customers::field_error(
                    $field,
                    crate::closing::closed_message(&month),
                )],
            });
        }
    }};
}
pub(crate) use refuse_closed;

/// The closed months (`YYYY-MM`), read outside a transaction for the
/// calc-basis impact preview; writers use [`refuse_closed!`].
pub(crate) async fn closed_months(db: &Db) -> Result<Vec<String>, BantoError> {
    let sql = "SELECT month FROM closing_periods WHERE status = 'closed'".to_string();
    let rows: Vec<(String,)> = on_pool!(db, pool => fetch_all!(pool, sql))?;
    Ok(rows.into_iter().map(|(m,)| m).collect())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseInput {
    pub row_version: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenInput {
    pub row_version: i64,
    #[serde(default)]
    pub reason: String,
}

/// A month in the list (締め済み・再開中だけ).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MonthRow {
    pub month: String,
    pub status: String,
    pub updated_at: String,
}

/// One close or reopen.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ClosingEvent {
    pub id: i64,
    /// `close` | `reopen`.
    pub action: String,
    pub reason: Option<String>,
    pub actor_name: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarningView {
    /// `missing_rate` | `provisional`.
    pub code: String,
    pub count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiguresView {
    pub labor_cost: i64,
    pub labor_missing: usize,
    pub direct_cost: i64,
    pub revenue: i64,
}

impl From<MonthFigures> for FiguresView {
    fn from(f: MonthFigures) -> Self {
        Self {
            labor_cost: f.labor_cost,
            labor_missing: f.labor_missing,
            direct_cost: f.direct_cost,
            revenue: f.revenue,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub project_id: i64,
    pub project_code: Option<String>,
    pub project_name: Option<String>,
    pub at_close: FiguresView,
    pub current: FiguresView,
}

/// The figures saved at the latest close compared with today's.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub event_id: i64,
    pub closed_at: String,
    /// The month's totals at that close and now.
    pub total_at_close: FiguresView,
    pub total_current: FiguresView,
    /// Projects whose figures changed since (empty = unchanged).
    pub changed: Vec<DiffRow>,
}

/// A month as the closing screen sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthClosing {
    pub month: String,
    /// `open` | `closed` | `reopened`.
    pub status: String,
    pub row_version: i64,
    pub unapproved_time_entries: usize,
    pub unapproved_costs: usize,
    /// Unapproved records block the close.
    pub can_close: bool,
    pub warnings: Vec<WarningView>,
    /// The month's figures now (all projects).
    pub total: FiguresView,
    pub history: Vec<ClosingEvent>,
    pub comparison: Option<Comparison>,
}

/// (count, version sum, last id) of the month's hours, direct costs and
/// revenue recognitions: a write between the figures and the close shows.
type Fingerprint = Vec<(i64, i64, i64)>;

/// Labor (project, cost, rows without a rate) and revenue (project, amount).
type LaborRevenue = (Vec<(i64, i64, i64)>, Vec<(i64, i64)>);

const FINGERPRINT_SQL: [&str; 3] = [
    "SELECT CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(row_version), 0) AS BIGINT), \
     CAST(COALESCE(MAX(id), 0) AS BIGINT) FROM time_entries \
     WHERE work_date >= ? AND work_date <= ?",
    "SELECT CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(row_version), 0) AS BIGINT), \
     CAST(COALESCE(MAX(id), 0) AS BIGINT) FROM direct_costs \
     WHERE booked_on >= ? AND booked_on <= ?",
    "SELECT CAST(COUNT(*) AS BIGINT), \
     CAST(COALESCE(SUM(CASE WHEN cancelled_at IS NULL THEN 0 ELSE 1 END), 0) AS BIGINT), \
     CAST(COALESCE(MAX(id), 0) AS BIGINT) FROM revenue_recognitions \
     WHERE recognized_on >= ? AND recognized_on <= ?",
];

const UNAPPROVED_SQL: [&str; 2] = [
    // A returned correction is not unprocessed: the entry it would replace
    // is still approved (T11).
    concat!(
        "SELECT CAST(COUNT(*) AS BIGINT) FROM time_entries t \
         WHERE t.status <> 'approved' AND t.work_date >= ? AND t.work_date <= ? AND ",
        crate::time_entries::counts_sql!()
    ),
    "SELECT CAST(COUNT(*) AS BIGINT) FROM direct_costs \
     WHERE status <> 'approved' AND booked_on >= ? AND booked_on <= ?",
];

macro_rules! month_reads {
    ($exec:expr, $fp:expr, $un:expr, $from:expr, $to:expr) => {{
        let a: Option<(i64, i64, i64)> = fetch_optional!($exec, $fp[0], $from, $to)?;
        let b: Option<(i64, i64, i64)> = fetch_optional!($exec, $fp[1], $from, $to)?;
        let c: Option<(i64, i64, i64)> = fetch_optional!($exec, $fp[2], $from, $to)?;
        let t: i64 = scalar!($exec, $un[0], $from, $to)?;
        let d: i64 = scalar!($exec, $un[1], $from, $to)?;
        (
            vec![
                a.unwrap_or_default(),
                b.unwrap_or_default(),
                c.unwrap_or_default(),
            ],
            (t, d),
        )
    }};
}

fn validation(field: &str, message: impl Into<String>) -> BantoError {
    BantoError::Validation {
        field_errors: vec![field_error(field, message)],
    }
}

fn parse_month(month: &str) -> Result<YearMonth, BantoError> {
    YearMonth::parse(month.trim())
        .ok_or_else(|| validation("month", "月は YYYY-MM で入力してください"))
}

fn first_day(m: YearMonth) -> Date {
    Date {
        year: m.year,
        month: m.month,
        day: 1,
    }
}

fn count(n: i64) -> usize {
    usize::try_from(n).unwrap_or(0)
}

#[derive(Clone)]
pub struct ClosingService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl ClosingService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    /// The months closed or reopened, newest first.
    pub async fn months(&self) -> Result<Vec<MonthRow>, BantoError> {
        let sql = "SELECT month, status, updated_at FROM closing_periods \
                   WHERE status <> 'open' ORDER BY month DESC"
            .to_string();
        on_pool!(&self.db, pool => fetch_all!(pool, sql))
    }

    async fn status(&self, month: &str) -> Result<(MonthStatus, i64), BantoError> {
        let sql = self.sql("SELECT status, row_version FROM closing_periods WHERE month = ?");
        let row: Option<(String, i64)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, month))?;
        Ok(match row {
            // A month never touched reads as the `open` row a write or the
            // close will create (version 1, never bumped while open).
            None => (MonthStatus::Open, 1),
            Some((s, v)) => (MonthStatus::parse(&s).unwrap_or(MonthStatus::Open), v),
        })
    }

    /// The month's warnings (approved hours without a rate, provisionals
    /// not confirmed).
    async fn warning_state(&self, from: &str, to: &str) -> Result<(i64, i64), BantoError> {
        let rate = self.sql(&format!(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM time_entries t WHERE t.status = 'approved' \
             AND t.labor_cost IS NULL AND t.work_date >= ? AND t.work_date <= ? AND {COUNTS}"
        ));
        let provisional = self.sql(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM direct_costs p WHERE p.status = 'approved' \
             AND p.entry_kind = 'provisional' AND p.booked_on >= ? AND p.booked_on <= ? \
             AND NOT EXISTS (SELECT 1 FROM direct_costs f WHERE f.ref_id = p.id \
             AND f.entry_kind = 'confirms' AND f.status = 'approved')",
        );
        on_pool!(&self.db, pool => Ok((
            scalar!(pool, rate, from, to)?,
            scalar!(pool, provisional, from, to)?,
        )))
    }

    /// Each project's figures of the month now.
    async fn figures(&self, m: YearMonth) -> Result<BTreeMap<i64, MonthFigures>, BantoError> {
        let (from, to) = (first_day(m).to_string(), m.last_day().to_string());
        // CAST: Postgres sums BIGINT to NUMERIC.
        // A replaced entry no longer counts (T11).
        let labor = self.sql(&format!(
            "SELECT t.project_id, CAST(COALESCE(SUM(t.labor_cost), 0) AS BIGINT), \
             CAST(SUM(CASE WHEN t.labor_cost IS NULL THEN 1 ELSE 0 END) AS BIGINT) \
             FROM time_entries t WHERE t.status = 'approved' AND t.project_id IS NOT NULL \
             AND t.work_date >= ? AND t.work_date <= ? AND {COUNTS} GROUP BY t.project_id"
        ));
        let revenue = self.sql(
            "SELECT project_id, CAST(COALESCE(SUM(amount), 0) AS BIGINT) \
             FROM revenue_recognitions WHERE cancelled_at IS NULL \
             AND recognized_on >= ? AND recognized_on <= ? GROUP BY project_id",
        );
        let (labor, revenue): LaborRevenue = on_pool!(&self.db, pool => (
            fetch_all!(pool, labor, &from, &to)?,
            fetch_all!(pool, revenue, &from, &to)?,
        ));
        let mut out: BTreeMap<i64, MonthFigures> = BTreeMap::new();
        for (p, cost, missing) in labor {
            let f = out.entry(p).or_default();
            f.labor_cost = cost;
            f.labor_missing = count(missing);
        }
        for (p, amount) in revenue {
            out.entry(p).or_default().revenue = amount;
        }
        // Direct costs: the ledger as it stood at the month's end less the
        // ledger at the previous month's end, so a provisional confirmed in
        // a later month stays in the month it was booked (翌月調整).
        let ledger = DirectCostsService::new(self.db.clone()).ledger().await?;
        let mut direct: BTreeMap<i64, i64> = BTreeMap::new();
        for p in ledger.until(m.last_day())? {
            if let Ok(id) = p.project.parse::<i64>() {
                *direct.entry(id).or_default() += p.amount;
            }
        }
        for p in ledger.until(m.previous().last_day())? {
            if let Ok(id) = p.project.parse::<i64>() {
                *direct.entry(id).or_default() -= p.amount;
            }
        }
        for (p, amount) in direct {
            if amount != 0 {
                out.entry(p).or_default().direct_cost = amount;
            }
        }
        out.retain(|_, f| *f != MonthFigures::default());
        Ok(out)
    }

    async fn history(&self, month: &str) -> Result<Vec<ClosingEvent>, BantoError> {
        let sql = self.sql(
            "SELECT e.id, e.action, e.reason, u.display_name AS actor_name, e.created_at \
             FROM closing_events e LEFT JOIN users u ON u.id = e.actor_user_id \
             WHERE e.month = ? ORDER BY e.id DESC",
        );
        on_pool!(&self.db, pool => fetch_all!(pool, sql, month))
    }

    async fn snapshot(&self, event_id: i64) -> Result<BTreeMap<i64, MonthFigures>, BantoError> {
        let sql = self.sql(
            "SELECT project_id, labor_cost, labor_missing, direct_cost, revenue \
             FROM closing_snapshot_rows WHERE event_id = ?",
        );
        let rows: Vec<(i64, i64, i64, i64, i64)> =
            on_pool!(&self.db, pool => fetch_all!(pool, sql, event_id))?;
        Ok(rows
            .into_iter()
            .map(|(p, labor, missing, direct, revenue)| {
                (
                    p,
                    MonthFigures {
                        labor_cost: labor,
                        labor_missing: count(missing),
                        direct_cost: direct,
                        revenue,
                    },
                )
            })
            .collect())
    }

    async fn project_labels(&self) -> Result<BTreeMap<i64, (String, String)>, BantoError> {
        let sql = "SELECT id, code, name FROM projects".to_string();
        let rows: Vec<(i64, String, String)> = on_pool!(&self.db, pool => fetch_all!(pool, sql))?;
        Ok(rows.into_iter().map(|(id, c, n)| (id, (c, n))).collect())
    }

    /// The month: status, what blocks or warns the close, the figures now,
    /// the history and the comparison with the latest close.
    pub async fn get(&self, month: &str) -> Result<MonthClosing, BantoError> {
        let m = parse_month(month)?;
        let key = m.to_string();
        let (from, to) = (first_day(m).to_string(), m.last_day().to_string());
        let (status, row_version) = self.status(&key).await?;
        let fp: Vec<String> = FINGERPRINT_SQL.iter().map(|s| self.sql(s)).collect();
        let un: Vec<String> = UNAPPROVED_SQL.iter().map(|s| self.sql(s)).collect();
        let (_, (time, costs)) = on_pool!(&self.db, pool => month_reads!(pool, fp, un, &from, &to));
        let (missing, provisional) = self.warning_state(&from, &to).await?;
        let state = MonthState {
            unapproved_time_entries: count(time),
            unapproved_costs: count(costs),
            missing_rate_entries: count(missing),
            provisional_entries: count(provisional),
        };
        let current = self.figures(m).await?;
        let total = |f: &BTreeMap<i64, MonthFigures>| {
            f.values()
                .fold(MonthFigures::default(), |a, b| MonthFigures {
                    labor_cost: a.labor_cost + b.labor_cost,
                    labor_missing: a.labor_missing + b.labor_missing,
                    direct_cost: a.direct_cost + b.direct_cost,
                    revenue: a.revenue + b.revenue,
                })
        };
        let history = self.history(&key).await?;
        let comparison = match history.iter().find(|e| e.action == "close") {
            None => None,
            Some(e) => {
                let at = self.snapshot(e.id).await?;
                let labels = self.project_labels().await?;
                let keyed = |f: &BTreeMap<i64, MonthFigures>| -> BTreeMap<String, MonthFigures> {
                    f.iter().map(|(k, v)| (format!("{k:020}"), *v)).collect()
                };
                let changed = compare(&keyed(&at), &keyed(&current))
                    .into_iter()
                    .filter_map(|d| {
                        let id: i64 = d.project.parse().ok()?;
                        let label = labels.get(&id);
                        Some(DiffRow {
                            project_id: id,
                            project_code: label.map(|l| l.0.clone()),
                            project_name: label.map(|l| l.1.clone()),
                            at_close: d.at_close.into(),
                            current: d.current.into(),
                        })
                    })
                    .collect();
                Some(Comparison {
                    event_id: e.id,
                    closed_at: e.created_at.clone(),
                    total_at_close: total(&at).into(),
                    total_current: total(&current).into(),
                    changed,
                })
            }
        };
        Ok(MonthClosing {
            month: key,
            status: status.as_str().to_string(),
            row_version,
            unapproved_time_entries: state.unapproved_time_entries,
            unapproved_costs: state.unapproved_costs,
            can_close: status != MonthStatus::Closed
                && state.unapproved_time_entries == 0
                && state.unapproved_costs == 0,
            warnings: warnings(&state)
                .iter()
                .map(|w| WarningView {
                    code: w.code().to_string(),
                    count: w.count(),
                })
                .collect(),
            total: total(&current).into(),
            history,
            comparison,
        })
    }

    fn lock_sql(&self) -> String {
        self.sql(match self.db.dialect() {
            Dialect::Sqlite => "SELECT status, row_version FROM closing_periods WHERE month = ?",
            Dialect::Postgres => {
                "SELECT status, row_version FROM closing_periods WHERE month = ? FOR UPDATE"
            }
        })
    }

    /// Close the month (締め): no unapproved hours or direct costs dated in
    /// it; the figures of each project are saved with the close.
    pub async fn close(
        &self,
        month: &str,
        input: CloseInput,
        actor_user_id: Option<i64>,
    ) -> Result<MonthClosing, BantoError> {
        let m = parse_month(month)?;
        let key = m.to_string();
        let (from, to) = (first_day(m).to_string(), m.last_day().to_string());
        let fp: Vec<String> = FINGERPRINT_SQL.iter().map(|s| self.sql(s)).collect();
        let un: Vec<String> = UNAPPROVED_SQL.iter().map(|s| self.sql(s)).collect();
        let (before, _) = on_pool!(&self.db, pool => month_reads!(pool, fp, un, &from, &to));
        let figures = self.figures(m).await?;
        let gate = MonthGate::new(self.db.dialect());
        let lock = self.lock_sql();
        let set = self.sql(&format!(
            "UPDATE closing_periods SET status = 'closed', row_version = row_version + 1, \
             updated_at = {} WHERE month = ? AND row_version = ?",
            now_expr(self.db.dialect())
        ));
        let event = self.sql(
            "INSERT INTO closing_events (month, action, actor_user_id) VALUES (?, 'close', ?) \
             RETURNING id",
        );
        let row = self.sql(
            "INSERT INTO closing_snapshot_rows (event_id, project_id, labor_cost, \
             labor_missing, direct_cost, revenue) VALUES (?, ?, ?, ?, ?, ?)",
        );
        in_tx!(&self.db, tx => {
            execute!(&mut *tx, gate.upsert, &key)?;
            let (status, version): (String, i64) = fetch_optional!(&mut *tx, lock, &key)?
                .ok_or_else(|| BantoError::Other("締めの行がありません".into()))?;
            if version != input.row_version {
                return Err(stale_version_error());
            }
            let status = MonthStatus::parse(&status).unwrap_or(MonthStatus::Open);
            let (now, (time, costs)) = month_reads!(&mut *tx, fp, un, &from, &to);
            let state = MonthState {
                unapproved_time_entries: count(time),
                unapproved_costs: count(costs),
                ..Default::default()
            };
            match check_close(status, &state) {
                Ok(_) => {}
                Err(CloseIssue::AlreadyClosed) => {
                    return Err(validation("status", "この月は既に締め済みです"));
                }
                Err(CloseIssue::Unapproved { time_entries, costs }) => {
                    return Err(validation(
                        "status",
                        format!(
                            "この月の未承認の工数{time_entries}件・直接費{costs}件があります。\
                             承認か差戻し・削除をしてから締めてください"
                        ),
                    ));
                }
            }
            let fingerprint: Fingerprint = now;
            if fingerprint != before {
                return Err(stale_version_error());
            }
            if execute!(&mut *tx, set, &key, version)? == 0 {
                return Err(stale_version_error());
            }
            let id: i64 = scalar!(&mut *tx, event, &key, actor_user_id)?;
            for (p, f) in &figures {
                execute!(&mut *tx, row, id, *p, f.labor_cost, f.labor_missing as i64,
                    f.direct_cost, f.revenue)?;
            }
        });
        crate::events::notify_changed(&self.events, RESOURCE);
        self.get(&key).await
    }

    /// Reopen a closed month (再開, accounting, with a reason).
    pub async fn reopen(
        &self,
        month: &str,
        input: ReopenInput,
        actor_user_id: Option<i64>,
    ) -> Result<MonthClosing, BantoError> {
        let m = parse_month(month)?;
        let key = m.to_string();
        let reason = input.reason.trim().to_string();
        if reason.chars().count() > MAX_TEXT_LEN {
            return Err(validation(
                "reason",
                format!("{MAX_TEXT_LEN}文字以内で入力してください"),
            ));
        }
        let lock = self.lock_sql();
        let set = self.sql(&format!(
            "UPDATE closing_periods SET status = 'reopened', row_version = row_version + 1, \
             updated_at = {} WHERE month = ? AND row_version = ?",
            now_expr(self.db.dialect())
        ));
        let event = self.sql(
            "INSERT INTO closing_events (month, action, reason, actor_user_id) \
             VALUES (?, 'reopen', ?, ?)",
        );
        in_tx!(&self.db, tx => {
            let row: Option<(String, i64)> = fetch_optional!(&mut *tx, lock, &key)?;
            let (status, version) = row.unwrap_or(("open".into(), 1));
            let status = MonthStatus::parse(&status).unwrap_or(MonthStatus::Open);
            match check_reopen(status, &reason) {
                Ok(()) => {}
                Err(ReopenIssue::ReasonRequired) => {
                    return Err(validation("reason", "再開の理由を入力してください"));
                }
                Err(ReopenIssue::NotClosed) => {
                    return Err(validation("status", "締め済みの月だけを再開できます"));
                }
            }
            if version != input.row_version {
                return Err(stale_version_error());
            }
            if execute!(&mut *tx, set, &key, version)? == 0 {
                return Err(stale_version_error());
            }
            execute!(&mut *tx, event, &key, &reason, actor_user_id)?;
        });
        crate::events::notify_changed(&self.events, RESOURCE);
        self.get(&key).await
    }
}

/// What both wiring layers record: the month and the action. A reopening's
/// reason (free text) and the figures (amounts) are not recorded.
pub fn audit_detail(month: &str, action: &str) -> serde_json::Value {
    serde_json::json!({ "month": month, "action": action })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::direct_costs::DirectCostInput;
    use crate::orders::tests::{line, ordered_project};
    use crate::orders::{OrdersService, RecognitionInput};
    use crate::projects::tests::fixture;
    use crate::time_entries::{TimeEntriesService, TimeEntryInput};

    fn fields(err: BantoError) -> Vec<(String, String)> {
        match err {
            BantoError::Validation { field_errors } => field_errors
                .into_iter()
                .map(|e| (e.field, e.message))
                .collect(),
            other => panic!("validation expected, got {other:?}"),
        }
    }

    fn hours(date: &str, project: i64) -> TimeEntryInput {
        TimeEntryInput {
            work_date: date.into(),
            project_id: Some(project),
            phase_id: Some(1),
            minutes: 60,
            ..Default::default()
        }
    }

    async fn approved_hours(db: &Db, date: &str, project: i64, cost: Option<i64>) {
        let sql = placeholders(
            db.dialect(),
            "INSERT INTO time_entries (work_date, user_id, project_id, phase_id, minutes, \
             status, applied_rate, labor_cost) VALUES (?, 1, ?, 1, 60, 'approved', ?, ?)",
        );
        on_pool!(db, pool => execute!(pool, sql, date, project, cost, cost)).unwrap();
    }

    #[tokio::test]
    async fn t11_a_closed_month_refuses_hours_costs_and_revenue_until_reopened() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-C01", vec![line(Some("2026-11"), 1_000_000)]).await;
        let svc = ClosingService::new(db.clone());
        let time = TimeEntriesService::new(db.clone());
        let costs = DirectCostsService::new(db.clone());

        // A draft in the month blocks the close.
        let draft = time.create(1, hours("2026-10-05", p)).await.unwrap().entry;
        let m = svc.get("2026-10").await.unwrap();
        assert_eq!((m.status.as_str(), m.row_version), ("open", 1));
        assert!(!m.can_close);
        assert_eq!(m.unapproved_time_entries, 1);
        let err = svc
            .close("2026-10", CloseInput { row_version: 1 }, Some(1))
            .await
            .unwrap_err();
        assert!(fields(err)[0].1.contains("未承認の工数1件"));
        time.delete(1, draft.id, draft.row_version).await.unwrap();

        // Closed: hours, direct costs and revenue dated in it are refused.
        approved_hours(&db, "2026-10-06", p, Some(3_000)).await;
        let closed = svc
            .close("2026-10", CloseInput { row_version: 1 }, Some(1))
            .await
            .unwrap();
        assert_eq!(closed.status, "closed");
        assert_eq!(closed.history[0].action, "close");
        assert_eq!(closed.total.labor_cost, 3_000);
        let err = time.create(1, hours("2026-10-07", p)).await.unwrap_err();
        assert_eq!(fields(err)[0].0, "workDate");
        assert!(
            fields(time.create(1, hours("2026-10-07", p)).await.unwrap_err())[0]
                .1
                .contains("2026年10月は締め済み")
        );
        let cost = DirectCostInput {
            project_id: Some(p),
            cost_type: Some("travel".into()),
            booked_on: "2026-10-08".into(),
            amount: 5_000,
            ..Default::default()
        };
        assert_eq!(
            fields(costs.create(1, cost.clone()).await.unwrap_err())[0].0,
            "bookedOn"
        );
        let orders = OrdersService::new(db.clone());
        let sale = |on: &str| RecognitionInput {
            recognized_on: on.into(),
            amount: 100_000,
            basis: Some("検収".into()),
            clears: None,
        };
        assert_eq!(
            fields(
                orders
                    .recognize(p, sale("2026-10-31"), Some(1))
                    .await
                    .unwrap_err()
            )[0]
            .0,
            "recognizedOn"
        );
        // The next month stays open (翌月で調整できる).
        time.create(1, hours("2026-11-02", p)).await.unwrap();
        orders
            .recognize(p, sale("2026-11-01"), Some(1))
            .await
            .unwrap();
        // Moving an open-month draft into the closed month is refused too.
        let nov = time.create(1, hours("2026-11-03", p)).await.unwrap().entry;
        let mut moved = hours("2026-10-30", p);
        moved.row_version = Some(nov.row_version);
        assert_eq!(
            fields(time.update(1, nov.id, moved).await.unwrap_err())[0].0,
            "workDate"
        );

        // Reopening needs a reason; then the month takes writes again.
        let err = svc
            .reopen(
                "2026-10",
                ReopenInput {
                    row_version: closed.row_version,
                    reason: " ".into(),
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(fields(err)[0].0, "reason");
        let reopened = svc
            .reopen(
                "2026-10",
                ReopenInput {
                    row_version: closed.row_version,
                    reason: "工数の訂正".into(),
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(reopened.status, "reopened");
        assert_eq!(reopened.history[0].reason.as_deref(), Some("工数の訂正"));
        time.create(1, hours("2026-10-07", p)).await.unwrap();
        costs.create(1, cost).await.unwrap();
        assert_eq!(svc.months().await.unwrap()[0].status, "reopened");
    }

    #[tokio::test]
    async fn t11_the_figures_saved_at_the_close_show_a_later_correction() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-C02", vec![line(Some("2026-11"), 1_000_000)]).await;
        let svc = ClosingService::new(db.clone());
        approved_hours(&db, "2026-10-06", p, Some(3_000)).await;
        approved_hours(&db, "2026-10-07", p, None).await;
        // Another month does not count.
        approved_hours(&db, "2026-11-01", p, Some(9_000)).await;
        let m = svc.get("2026-10").await.unwrap();
        assert_eq!(m.warnings[0].code, "missing_rate");
        assert!(m.can_close);
        let closed = svc
            .close("2026-10", CloseInput { row_version: 1 }, Some(1))
            .await
            .unwrap();
        let c = closed.comparison.unwrap();
        assert!(c.changed.is_empty());
        assert_eq!(c.total_at_close.labor_cost, 3_000);
        assert_eq!(c.total_at_close.labor_missing, 1);

        // Reopen, correct, close again: the first close's figures stay and
        // the new close is compared with what it saved.
        let reopened = svc
            .reopen(
                "2026-10",
                ReopenInput {
                    row_version: closed.row_version,
                    reason: "単価の訂正".into(),
                },
                Some(1),
            )
            .await
            .unwrap();
        approved_hours(&db, "2026-10-08", p, Some(1_500)).await;
        let c = reopened.comparison.unwrap();
        assert!(c.changed.is_empty(), "read before the correction");
        let now = svc.get("2026-10").await.unwrap();
        let c = now.comparison.unwrap();
        assert_eq!(c.changed.len(), 1);
        assert_eq!(c.changed[0].project_id, p);
        assert_eq!(c.changed[0].at_close.labor_cost, 3_000);
        assert_eq!(c.changed[0].current.labor_cost, 4_500);
        let again = svc
            .close(
                "2026-10",
                CloseInput {
                    row_version: now.row_version,
                },
                Some(1),
            )
            .await
            .unwrap();
        assert!(again.comparison.unwrap().changed.is_empty());
        assert_eq!(again.history.len(), 3);
    }

    #[tokio::test]
    async fn t14_a_provisional_confirmed_next_month_keeps_the_closed_month_figures() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-C03", vec![line(Some("2026-11"), 1_000_000)]).await;
        let svc = ClosingService::new(db.clone());
        let costs = DirectCostsService::new(db.clone());
        let prov = crate::direct_costs::tests::approved(
            &costs,
            DirectCostInput {
                entry_kind: Some("provisional".into()),
                project_id: Some(p),
                cost_type: Some("outsource".into()),
                booked_on: "2026-10-31".into(),
                amount: 300_000,
                ..Default::default()
            },
        )
        .await;
        let m = svc.get("2026-10").await.unwrap();
        assert_eq!(m.warnings[0].code, "provisional");
        let closed = svc
            .close("2026-10", CloseInput { row_version: 1 }, Some(1))
            .await
            .unwrap();
        assert_eq!(closed.total.direct_cost, 300_000);

        // The invoice (320,000) is booked in November (翌月調整): October
        // keeps the provisional, November carries only the difference.
        crate::direct_costs::tests::approved(
            &costs,
            DirectCostInput {
                entry_kind: Some("confirms".into()),
                ref_id: Some(prov.id),
                booked_on: "2026-11-10".into(),
                amount: 320_000,
                reason: Some("請求書到着".into()),
                ..Default::default()
            },
        )
        .await;
        let oct = svc.get("2026-10").await.unwrap();
        assert_eq!(oct.total.direct_cost, 300_000);
        assert!(oct.comparison.unwrap().changed.is_empty());
        assert_eq!(svc.get("2026-11").await.unwrap().total.direct_cost, 20_000);
    }

    #[tokio::test]
    async fn t13_a_stale_version_or_a_second_close_is_refused() {
        let db = fixture().await;
        let svc = ClosingService::new(db.clone());
        assert!(svc
            .close("2026-09", CloseInput { row_version: 2 }, Some(1))
            .await
            .is_err());
        let closed = svc
            .close("2026-09", CloseInput { row_version: 1 }, Some(1))
            .await
            .unwrap();
        let err = svc
            .close(
                "2026-09",
                CloseInput {
                    row_version: closed.row_version,
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(fields(err)[0].1, "この月は既に締め済みです");
        let err = svc
            .reopen(
                "2026-08",
                ReopenInput {
                    row_version: 1,
                    reason: "x".into(),
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(fields(err)[0].0, "status");
        assert!(svc.get("2026-13").await.is_err());
    }
}
