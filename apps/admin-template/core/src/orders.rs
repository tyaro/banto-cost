//! Order conversion, order changes, the ordered revenue plan and revenue
//! recognition (banto-cost P3b, spec §3.1 / §5.5, `docs/project/design.md`
//! §3.2). The monthly outlook and its snapshots are in [`outlook`].
//!
//! - Conversion switches the same project to `ordered`, records the
//!   confirmed amount and basis, and sets the ordered revenue plan. The
//!   pipeline versions stay as they were; the project leaves the pipeline
//!   aggregate because of its status (T23). Nothing is recognized as revenue.
//! - A partial order keeps the ordered scope on this project and moves the
//!   rest to a new project (`parent_project_id`) with its own adopted
//!   pipeline version, so the ordered part is not also left in the pipeline (T24).
//! - An order change is pending (未確定追加売上, outside the confirmed amount)
//!   until approved; approval adds its delta to the confirmed amount and to
//!   the revenue plan of its month.
//! - A recognition clears plan lines so recognized and planned revenue are
//!   not counted twice (T26). Every write is checked with
//!   `cost_domain::revenue::OrderedRevenue::check` and refused when the open
//!   plan would stop matching the unrecognized remainder.
//!
//! Concurrency: every write bumps `projects.revenue_version` with a
//! compare-and-set against the version the check was made on, so two
//! writers cannot both pass the check on the same state (T13).
//!
//! Authorization (ADR-0028) is the wiring layer's: `ViewProjectAmounts` to
//! read, `EditOrder` to convert / request changes / re-plan, `Approve` to
//! decide a change, `FinanceClose` to record or cancel revenue.

pub mod outlook;

use banto_server::ServerEvent;
use std::collections::{BTreeMap, BTreeSet};
use tokio::sync::broadcast;

use banto_core::{BantoError, FieldError};
use banto_storage::{Db, Dialect};
use cost_domain::order::{
    check_conversion, check_conversion_cancel, check_conversion_correction, ChangeStatus,
    ConversionCancelFacts, ConversionCancelIssue, ConversionCorrection, ConversionCorrectionIssue,
    ConversionInput as DomainConversion, ConversionIssue, ConversionScope, OrderBook,
    OrderChange as DomainChange,
};
use cost_domain::pipeline::RevenuePlanLine;
use cost_domain::project::{
    validate_project, ProjectInput as DomainProject, ProjectIssue, ProjectStatus,
};
use cost_domain::revenue::{
    Clearing, OrderedRevenue, PlanLine as DomainPlanLine, RecognizedSale, RevenueIssue,
    NEW_PLAN_PREFIX,
};
use cost_domain::{Date, YearMonth};
use serde::{Deserialize, Serialize};

use crate::closing::{refuse_closed, MonthGate};
use crate::customers::{clean_optional, field_error, now_expr, stale_version_error};
use crate::pipeline::{PipelineVersionInput, PlanLine};
use crate::projects::{MAX_CODE_LEN, MAX_NAME_LEN};

pub const MAX_TEXT_LEN: usize = 1000;

pub const MAX_PLAN_LINES: usize = 60;

/// Run `$body` with `$pool` bound to the concrete pool of either backend.
macro_rules! on_pool {
    ($db:expr, $pool:ident => $body:expr) => {
        match $db {
            Db::Sqlite($pool) => $body,
            #[cfg(feature = "postgres")]
            Db::Postgres($pool) => $body,
        }
    };
}

/// Run `$body` in a transaction of either backend, committing when it ends
/// normally (an early `?` return drops the transaction, which rolls back).
macro_rules! in_tx {
    ($db:expr, $tx:ident => $body:block) => {
        match $db {
            Db::Sqlite(pool) => {
                let mut $tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let out = $body;
                $tx.commit().await.map_err(banto_storage::storage_error)?;
                out
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut $tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let out = $body;
                $tx.commit().await.map_err(banto_storage::storage_error)?;
                out
            }
        }
    };
}

macro_rules! fetch_all {
    ($exec:expr, $sql:expr $(, $bind:expr)*) => {
        sqlx::query_as(sqlx::AssertSqlSafe($sql.as_str()))
            $(.bind($bind))*
            .fetch_all($exec)
            .await
            .map_err(banto_storage::storage_error)
    };
}

macro_rules! fetch_optional {
    ($exec:expr, $sql:expr $(, $bind:expr)*) => {
        sqlx::query_as(sqlx::AssertSqlSafe($sql.as_str()))
            $(.bind($bind))*
            .fetch_optional($exec)
            .await
            .map_err(banto_storage::storage_error)
    };
}

macro_rules! scalar {
    ($exec:expr, $sql:expr $(, $bind:expr)*) => {
        sqlx::query_scalar(sqlx::AssertSqlSafe($sql.as_str()))
            $(.bind($bind))*
            .fetch_one($exec)
            .await
            .map_err(banto_storage::storage_error)
    };
}

macro_rules! execute {
    ($exec:expr, $sql:expr $(, $bind:expr)*) => {
        sqlx::query(sqlx::AssertSqlSafe($sql.as_str()))
            $(.bind($bind))*
            .execute($exec)
            .await
            .map_err(banto_storage::storage_error)
            .map(|r| r.rows_affected())
    };
}

pub(crate) use {execute, fetch_all, fetch_optional, in_tx, on_pool, scalar};

/// `?` placeholders as the backend wants them (`$1`, `$2`, … on Postgres).
pub(crate) fn placeholders(dialect: Dialect, s: &str) -> String {
    match dialect {
        Dialect::Sqlite => s.to_string(),
        Dialect::Postgres => {
            let mut out = String::with_capacity(s.len() + 8);
            let mut n = 0;
            for ch in s.chars() {
                if ch == '?' {
                    n += 1;
                    out.push_str(&format!("${n}"));
                } else {
                    out.push(ch);
                }
            }
            out
        }
    }
}

// --- wire types ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OrderConversion {
    pub id: i64,
    pub source_pipeline_version_id: Option<i64>,
    pub source_version_no: Option<i64>,
    /// The project's status right before the conversion.
    pub previous_status: String,
    pub converted_on: String,
    /// 受注転換額 (the confirmed amount at conversion, before order changes).
    pub confirmed_amount: i64,
    /// `whole` | `partial`.
    pub scope: String,
    pub remainder_project_id: Option<i64>,
    pub remainder_code: Option<String>,
    pub basis: String,
    pub created_by_name: Option<String>,
    pub created_at: String,
    /// Corrections of the 受注日 / 根拠 (T41), newest first.
    #[sqlx(skip)]
    pub corrections: Vec<ConversionCorrectionRow>,
}

/// A correction of a conversion's 受注日 / 根拠 (T41), kept as history.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ConversionCorrectionRow {
    pub id: i64,
    pub old_converted_on: String,
    pub new_converted_on: String,
    pub old_basis: String,
    pub new_basis: String,
    pub reason: String,
    /// The business date of the correction.
    pub corrected_on: String,
    pub corrected_by_name: Option<String>,
    pub corrected_at: String,
}

/// A cancelled conversion (受注転換の取消, T40), kept as history.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CancelledConversion {
    pub id: i64,
    pub previous_status: String,
    pub converted_on: String,
    pub confirmed_amount: i64,
    /// `whole` | `partial`.
    pub scope: String,
    /// A partial order's remainder project (set to 中止 by the cancellation).
    pub remainder_project_id: Option<i64>,
    pub remainder_code: Option<String>,
    pub basis: String,
    pub created_by_name: Option<String>,
    /// The business date of the cancellation.
    pub cancelled_on: String,
    pub cancel_reason: String,
    pub cancelled_by_name: Option<String>,
    pub cancelled_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OrderChangeRow {
    pub id: i64,
    pub change_no: i64,
    pub delta_amount: i64,
    /// The revenue-plan month the delta goes to; `None` = 時期未定.
    pub plan_month: Option<String>,
    /// `pending` | `approved` | `rejected`.
    pub status: String,
    pub basis: String,
    pub requested_by: Option<i64>,
    pub requested_by_name: Option<String>,
    pub requested_at: String,
    pub decided_by_name: Option<String>,
    pub decided_at: Option<String>,
    pub decision_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevenuePlanRow {
    pub id: i64,
    /// `None` = 時期未定.
    pub month: Option<String>,
    /// Planned amount (cleared + open).
    pub amount: i64,
    pub cleared: i64,
    pub open: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearingRow {
    pub plan_id: i64,
    pub month: Option<String>,
    pub amount: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionRow {
    pub id: i64,
    pub recognized_on: String,
    pub amount: i64,
    pub basis: Option<String>,
    pub recorded_by_name: Option<String>,
    pub recorded_at: String,
    pub cancelled_by_name: Option<String>,
    pub cancelled_at: Option<String>,
    pub cancel_reason: Option<String>,
    #[sqlx(skip)]
    pub clears: Vec<ClearingRow>,
}

/// A project's order and revenue state.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSummary {
    pub project_id: i64,
    pub status: String,
    /// Send back as `revenueVersion` when re-planning (T13).
    pub revenue_version: i64,
    pub parent_project_id: Option<i64>,
    pub parent_code: Option<String>,
    pub conversion: Option<OrderConversion>,
    /// 確定受注額 = conversion + approved changes. `None` before the order.
    pub confirmed_amount: Option<i64>,
    /// 未確定追加売上 (pending changes), never part of the confirmed amount.
    pub pending_total: i64,
    pub recognized_total: i64,
    /// 未計上残. `None` before the order; may be negative (shown, not rounded).
    pub remaining: Option<i64>,
    pub plan: Vec<RevenuePlanRow>,
    pub changes: Vec<OrderChangeRow>,
    pub recognitions: Vec<RecognitionRow>,
    /// `cost_domain::revenue::RevenueIssue` codes (empty when consistent).
    pub issues: Vec<String>,
    /// Why the current conversion cannot be cancelled
    /// (`cost_domain::order::ConversionCancelIssue` codes); empty when it can,
    /// or when there is no conversion (T40).
    pub cancel_blockers: Vec<String>,
    /// Cancelled conversions, newest first (history).
    pub cancelled_conversions: Vec<CancelledConversion>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemainderInput {
    pub code: String,
    pub name: String,
    /// The remainder's first (adopted) pipeline version.
    pub version: PipelineVersionInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionRequest {
    /// The project's `rowVersion` the form was loaded with (T13).
    #[serde(default)]
    pub row_version: Option<i64>,
    pub converted_on: String,
    pub confirmed_amount: i64,
    #[serde(default)]
    pub basis: Option<String>,
    #[serde(default)]
    pub planned_start: Option<String>,
    #[serde(default)]
    pub planned_end: Option<String>,
    #[serde(default)]
    pub order_no: Option<String>,
    #[serde(default)]
    pub revenue_plan: Vec<PlanLine>,
    /// `whole` | `partial`.
    pub scope: String,
    /// Required for `partial`, refused for `whole`.
    #[serde(default)]
    pub remainder: Option<RemainderInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequest {
    pub delta_amount: i64,
    #[serde(default)]
    pub plan_month: Option<String>,
    #[serde(default)]
    pub basis: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDecision {
    pub approve: bool,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplanInput {
    #[serde(default)]
    pub revenue_version: Option<i64>,
    /// The open (not yet recognized) plan per month.
    #[serde(default)]
    pub lines: Vec<PlanLine>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearingInput {
    pub plan_id: i64,
    pub amount: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionInput {
    pub recognized_on: String,
    pub amount: i64,
    #[serde(default)]
    pub basis: Option<String>,
    /// Which plan lines to clear; omitted = automatic
    /// (`OrderedRevenue::auto_clear`: the month's line first).
    #[serde(default)]
    pub clears: Option<Vec<ClearingInput>>,
}

/// 受注転換の取消 (T40).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionCancelInput {
    /// The project's `rowVersion` the screen was loaded with (T13).
    #[serde(default)]
    pub row_version: Option<i64>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// 受注日・根拠の訂正 (T41): the corrected values (both, as the form shows
/// them; at least one must differ from the current ones) and the reason.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionCorrectionInput {
    /// The `revenueVersion` the screen was loaded with (T13).
    #[serde(default)]
    pub revenue_version: Option<i64>,
    pub converted_on: String,
    #[serde(default)]
    pub basis: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelInput {
    #[serde(default)]
    pub reason: Option<String>,
}

// --- loaded state ---------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct ProjectRow {
    code: String,
    name: String,
    status: String,
    revenue_version: i64,
    parent_project_id: Option<i64>,
    parent_code: Option<String>,
}

/// Everything a write is checked against.
struct State {
    project_id: i64,
    project: ProjectRow,
    status: ProjectStatus,
    conversion: Option<OrderConversion>,
    changes: Vec<OrderChangeRow>,
    /// (id, month, amount).
    plans: Vec<(i64, Option<String>, i64)>,
    recognitions: Vec<RecognitionRow>,
    /// (recognition id, plan id, amount), cancelled recognitions included.
    clearings: Vec<(i64, i64, i64)>,
    cancel_blockers: Vec<ConversionCancelIssue>,
    cancelled_conversions: Vec<CancelledConversion>,
}

/// Counts of the records that block a conversion cancellation (T40):
/// order changes, recognitions, budgets, time entries, direct costs
/// (purchase orders, costs, allocations), forecasts, fixed costs (contracts,
/// postings), recurring revenue.
#[derive(Default, sqlx::FromRow)]
struct RecordCounts(i64, i64, i64, i64, i64, i64, i64, i64);

fn cancel_issues(
    status: ProjectStatus,
    conversion: &OrderConversion,
    remainder: Option<ProjectStatus>,
    records: RecordCounts,
) -> Vec<ConversionCancelIssue> {
    check_conversion_cancel(&ConversionCancelFacts {
        status: Some(status),
        previous: ProjectStatus::parse(&conversion.previous_status),
        scope: ConversionScope::parse(&conversion.scope),
        remainder,
        has_order_changes: records.0 > 0,
        has_recognitions: records.1 > 0,
        has_budgets: records.2 > 0,
        has_time_entries: records.3 > 0,
        has_direct_costs: records.4 > 0,
        has_forecasts: records.5 > 0,
        has_fixed_costs: records.6 > 0,
        has_recurring_revenue: records.7 > 0,
    })
}

/// The screen's words for a reason a conversion cannot be cancelled.
fn cancel_issue_label(issue: ConversionCancelIssue) -> &'static str {
    match issue {
        ConversionCancelIssue::NotOrdered => "進行中・作業完了・精算完了の案件",
        ConversionCancelIssue::PreviousUnknown => "転換前の状態が読めない",
        ConversionCancelIssue::ScopeUnknown => "受注の範囲が読めない",
        ConversionCancelIssue::RemainderUnknown => "残りの範囲の案件が見つからない",
        ConversionCancelIssue::RemainderOrdered => "残りの範囲の案件が受注転換済み",
        ConversionCancelIssue::OrderChanges => "受注変更",
        ConversionCancelIssue::Recognitions => "売上計上（取消済みを含む）",
        ConversionCancelIssue::Budgets => "予算",
        ConversionCancelIssue::TimeEntries => "工数",
        ConversionCancelIssue::DirectCosts => "直接費・発注",
        ConversionCancelIssue::Forecasts => "完了見込",
        ConversionCancelIssue::FixedCosts => "月額固定",
        ConversionCancelIssue::RecurringRevenue => "定期売上",
    }
}

fn cancel_refused(issues: &[ConversionCancelIssue]) -> BantoError {
    let labels: Vec<&str> = issues.iter().map(|i| cancel_issue_label(*i)).collect();
    BantoError::Validation {
        field_errors: vec![field_error(
            "status",
            format!("受注転換を取り消せません（{}）", labels.join("・")),
        )],
    }
}

fn ym(month: &Option<String>) -> Option<YearMonth> {
    month.as_deref().and_then(YearMonth::parse)
}

impl State {
    fn book(&self) -> Option<OrderBook> {
        let conversion = self.conversion.as_ref()?;
        Some(OrderBook {
            converted_amount: conversion.confirmed_amount,
            changes: self
                .changes
                .iter()
                .map(|c| DomainChange {
                    delta: c.delta_amount,
                    month: ym(&c.plan_month),
                    status: ChangeStatus::parse(&c.status).unwrap_or(ChangeStatus::Rejected),
                })
                .collect(),
        })
    }

    fn active(&self, recognition_id: i64) -> bool {
        self.recognitions
            .iter()
            .any(|r| r.id == recognition_id && r.cancelled_at.is_none())
    }

    /// The domain view: confirmed amount, plan lines, active recognitions.
    fn revenue(&self) -> Option<OrderedRevenue> {
        let book = self.book()?;
        Some(OrderedRevenue {
            order_amount: book.confirmed_amount(),
            plans: self
                .plans
                .iter()
                .map(|(id, month, amount)| DomainPlanLine {
                    id: id.to_string(),
                    month: ym(month),
                    amount: *amount,
                })
                .collect(),
            sales: self
                .recognitions
                .iter()
                .filter(|r| r.cancelled_at.is_none())
                .map(|r| RecognizedSale {
                    id: r.id.to_string(),
                    month: Date::parse(&r.recognized_on)
                        .map(Date::year_month)
                        .unwrap_or(YearMonth { year: 0, month: 1 }),
                    amount: r.amount,
                    clears: self
                        .clearings
                        .iter()
                        .filter(|(rid, _, _)| *rid == r.id)
                        .map(|(_, plan_id, amount)| Clearing {
                            plan_id: plan_id.to_string(),
                            amount: *amount,
                        })
                        .collect(),
                })
                .collect(),
        })
    }

    /// The ordered revenue of a project that is not settled: 精算完了 closes
    /// the order and its revenue (T17).
    fn require_ordered(&self) -> Result<OrderedRevenue, BantoError> {
        if self.status == ProjectStatus::Settled {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("status", "精算完了の案件です")],
            });
        }
        self.revenue().ok_or_else(|| BantoError::Validation {
            field_errors: vec![field_error(
                "status",
                "受注前の案件です。先に受注転換してください",
            )],
        })
    }

    fn summary(self) -> OrderSummary {
        let book = self.book();
        let revenue = self.revenue();
        let mut cleared: BTreeMap<i64, i64> = BTreeMap::new();
        for (rid, plan_id, amount) in &self.clearings {
            if self.active(*rid) {
                *cleared.entry(*plan_id).or_default() += amount;
            }
        }
        let plan: Vec<RevenuePlanRow> = self
            .plans
            .iter()
            .map(|(id, month, amount)| {
                let c = cleared.get(id).copied().unwrap_or(0);
                RevenuePlanRow {
                    id: *id,
                    month: month.clone(),
                    amount: *amount,
                    cleared: c,
                    open: amount - c,
                }
            })
            // A line kept only for a cancelled recognition's history.
            .filter(|row| row.amount != 0 || row.cleared != 0)
            .collect();
        let months: BTreeMap<i64, Option<String>> = self
            .plans
            .iter()
            .map(|(id, month, _)| (*id, month.clone()))
            .collect();
        let mut recognitions = self.recognitions;
        for r in &mut recognitions {
            r.clears = self
                .clearings
                .iter()
                .filter(|(rid, _, _)| *rid == r.id)
                .map(|(_, plan_id, amount)| ClearingRow {
                    plan_id: *plan_id,
                    month: months.get(plan_id).cloned().flatten(),
                    amount: *amount,
                })
                .collect();
        }
        let recognized_total = revenue.as_ref().map_or(0, OrderedRevenue::recognized_total);
        OrderSummary {
            project_id: self.project_id,
            status: self.project.status,
            revenue_version: self.project.revenue_version,
            parent_project_id: self.project.parent_project_id,
            parent_code: self.project.parent_code,
            conversion: self.conversion,
            confirmed_amount: book.as_ref().map(OrderBook::confirmed_amount),
            pending_total: book.as_ref().map_or(0, OrderBook::pending_total),
            recognized_total,
            remaining: revenue.as_ref().map(OrderedRevenue::unrecognized_remaining),
            plan,
            changes: self.changes,
            recognitions,
            issues: revenue
                .map(|r| r.check().iter().map(issue_code).collect())
                .unwrap_or_default(),
            cancel_blockers: self
                .cancel_blockers
                .iter()
                .map(|i| i.code().to_string())
                .collect(),
            cancelled_conversions: self.cancelled_conversions,
        }
    }
}

/// The audit detail of a conversion cancellation (REST and Tauri): the
/// cancelled conversion, its amount and the status the project went back to.
/// Never the reason.
pub fn conversion_cancel_audit_detail(summary: &OrderSummary) -> serde_json::Value {
    let cancelled = summary.cancelled_conversions.first();
    serde_json::json!({
        "conversionId": cancelled.map(|c| c.id),
        "confirmedAmount": cancelled.map(|c| c.confirmed_amount),
        "remainderProjectId": cancelled.and_then(|c| c.remainder_project_id),
        "status": summary.status,
    })
}

/// The correction one `correct_conversion` call recorded (T41), as written
/// in its transaction: the audit is built from this, not from the history
/// read back afterwards, which may already hold a later correction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrectionRecord {
    pub conversion_id: i64,
    pub correction_id: i64,
    pub old_converted_on: String,
    pub new_converted_on: String,
    pub basis_changed: bool,
}

/// The audit detail of a 受注日・根拠の訂正 (REST and Tauri): the conversion,
/// which values changed and the 受注日 before and after. Never the basis
/// text or the reason.
pub fn conversion_correction_audit_detail(record: &CorrectionRecord) -> serde_json::Value {
    serde_json::json!({
        "conversionId": record.conversion_id,
        "correctionId": record.correction_id,
        "convertedOnChanged": record.old_converted_on != record.new_converted_on,
        "basisChanged": record.basis_changed,
        "fromConvertedOn": record.old_converted_on,
        "toConvertedOn": record.new_converted_on,
    })
}

pub(crate) fn issue_code(issue: &RevenueIssue) -> String {
    match issue {
        RevenueIssue::OverRecognized { .. } => "over_recognized",
        RevenueIssue::PlanMismatch { .. } => "plan_mismatch",
        RevenueIssue::OverCleared { .. } => "over_cleared",
        RevenueIssue::ClearingExceedsSale { .. } => "clearing_exceeds_sale",
        RevenueIssue::UnknownPlan { .. } => "unknown_plan",
        RevenueIssue::InvalidAmount { .. } => "invalid_amount",
        RevenueIssue::DuplicatePlanMonth => "duplicate_plan_month",
        RevenueIssue::UnknownSale { .. } => "unknown_sale",
    }
    .to_string()
}

/// A refused revenue write as field errors on `field`.
pub(crate) fn revenue_errors(field: &str, issues: &[RevenueIssue]) -> BantoError {
    let mut errors: Vec<FieldError> = Vec::new();
    for issue in issues {
        let message = match issue {
            RevenueIssue::OverRecognized { excess } => {
                format!("確定受注額を{excess}円超える計上になります")
            }
            RevenueIssue::PlanMismatch {
                open_total,
                remaining,
            } => format!(
                "未計上の売上予定の合計（{open_total}円）が未計上残（{remaining}円）と一致しません"
            ),
            RevenueIssue::OverCleared { excess, .. } => {
                format!("売上予定を{excess}円超えて消し込もうとしています")
            }
            RevenueIssue::ClearingExceedsSale { .. } => {
                "消し込みの合計が計上額を超えています".to_string()
            }
            RevenueIssue::UnknownPlan { .. } => "消し込む売上予定が見つかりません".to_string(),
            RevenueIssue::InvalidAmount { .. } => {
                "金額が正しくありません（予定がマイナスになる変更はできません）".to_string()
            }
            RevenueIssue::DuplicatePlanMonth => "同じ月の売上予定が重複しています".to_string(),
            RevenueIssue::UnknownSale { .. } => "売上計上が見つかりません".to_string(),
        };
        if !errors.iter().any(|e| e.message == message) {
            errors.push(field_error(field, message));
        }
    }
    BantoError::Validation {
        field_errors: errors,
    }
}

fn text(
    field: &str,
    value: &Option<String>,
    required: Option<&str>,
    errors: &mut Vec<FieldError>,
) -> Option<String> {
    let v = clean_optional(value);
    if v.as_deref()
        .is_some_and(|s| s.chars().count() > MAX_TEXT_LEN)
    {
        errors.push(field_error(
            field,
            format!("{MAX_TEXT_LEN}文字以内で入力してください"),
        ));
    }
    if v.is_none() {
        if let Some(message) = required {
            errors.push(field_error(field, message));
        }
    }
    v
}

fn date(field: &str, value: &str, errors: &mut Vec<FieldError>) -> Option<Date> {
    let d = Date::parse(value.trim());
    if d.is_none() {
        errors.push(field_error(field, "日付は YYYY-MM-DD で入力してください"));
    }
    d
}

fn month(field: &str, value: &Option<String>, errors: &mut Vec<FieldError>) -> Option<String> {
    let raw = clean_optional(value)?;
    if YearMonth::parse(&raw).is_some() {
        Some(raw)
    } else {
        errors.push(field_error(field, "年月は YYYY-MM で入力してください"));
        None
    }
}

/// Parse plan lines (months must be `YYYY-MM` or empty for 時期未定).
fn plan_lines(
    field: &str,
    lines: &[PlanLine],
    errors: &mut Vec<FieldError>,
) -> Vec<RevenuePlanLine> {
    if lines.len() > MAX_PLAN_LINES {
        errors.push(field_error(
            field,
            format!("売上予定は{MAX_PLAN_LINES}行までです"),
        ));
    }
    let mut out = Vec::new();
    for l in lines {
        match clean_optional(&l.month) {
            None => out.push(RevenuePlanLine {
                month: None,
                amount: l.amount,
            }),
            Some(m) => match YearMonth::parse(&m) {
                Some(m) => out.push(RevenuePlanLine {
                    month: Some(m),
                    amount: l.amount,
                }),
                None => {
                    errors.push(field_error(
                        field,
                        "売上予定の年月は YYYY-MM で入力してください",
                    ));
                }
            },
        }
    }
    out
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

/// An order-change decision written with the plan ops.
struct Decision {
    sql: String,
    status: ChangeStatus,
    actor: Option<i64>,
    note: Option<String>,
    change_id: i64,
}

/// A change of plan lines to apply in the write transaction.
enum PlanOp {
    Update(i64, i64),
    Delete(i64),
    Insert(Option<String>, i64),
}

/// A checked rewrite of a project's revenue plan (see
/// [`OrdersService::prepare_plan_rewrite`]).
pub(crate) struct PlanRewrite {
    /// The `revenue_version` the rewrite was checked on (T13).
    pub(crate) version: i64,
    ops: Vec<PlanOp>,
    pub(crate) guard: String,
    pub(crate) update: String,
    pub(crate) delete: String,
    pub(crate) insert: String,
}

/// Write a [`PlanRewrite`] in the transaction `$tx`: bump the project's
/// `revenue_version` from the checked one (stale otherwise) and apply the
/// line changes.
macro_rules! write_plan_rewrite {
    ($tx:expr, $rw:expr, $project_id:expr) => {{
        let rw = &$rw;
        let project_id: i64 = $project_id;
        if execute!($tx, rw.guard, project_id, rw.version)? == 0 {
            return Err(stale_version_error());
        }
        for op in rw.ops() {
            match op {
                PlanOpRef::Update(id, amount) => {
                    execute!($tx, rw.update, amount, id, project_id)?;
                }
                PlanOpRef::Delete(id) => {
                    execute!($tx, rw.delete, id, project_id)?;
                }
                PlanOpRef::Insert(month, amount) => {
                    execute!($tx, rw.insert, project_id, month, amount)?;
                }
            }
        }
    }};
}

pub(crate) use write_plan_rewrite;

/// A line change of a [`PlanRewrite`], as the macro writes it.
pub(crate) enum PlanOpRef<'a> {
    Update(i64, i64),
    Delete(i64),
    Insert(&'a Option<String>, i64),
}

impl PlanRewrite {
    pub(crate) fn ops(&self) -> impl Iterator<Item = PlanOpRef<'_>> {
        self.ops.iter().map(|op| match op {
            PlanOp::Update(id, amount) => PlanOpRef::Update(*id, *amount),
            PlanOp::Delete(id) => PlanOpRef::Delete(*id),
            PlanOp::Insert(month, amount) => PlanOpRef::Insert(month, *amount),
        })
    }
}

/// Diff the stored lines against the domain's new lines. A line some
/// recognition (even a cancelled one) points at is set to 0, not deleted.
fn plan_ops(state: &State, next: &OrderedRevenue) -> Vec<PlanOp> {
    let referenced: BTreeSet<i64> = state.clearings.iter().map(|(_, p, _)| *p).collect();
    let mut ops = Vec::new();
    let mut kept = BTreeSet::new();
    for line in &next.plans {
        if line.id.starts_with(NEW_PLAN_PREFIX) {
            ops.push(PlanOp::Insert(
                line.month.map(|m| m.to_string()),
                line.amount,
            ));
        } else if let Ok(id) = line.id.parse::<i64>() {
            kept.insert(id);
            let old = state.plans.iter().find(|(pid, _, _)| *pid == id);
            if old.is_some_and(|(_, _, amount)| *amount != line.amount) {
                ops.push(PlanOp::Update(id, line.amount));
            }
        }
    }
    for (id, _, amount) in &state.plans {
        if kept.contains(id) {
            continue;
        }
        if referenced.contains(id) {
            if *amount != 0 {
                ops.push(PlanOp::Update(*id, 0));
            }
        } else {
            ops.push(PlanOp::Delete(*id));
        }
    }
    ops
}

#[derive(Clone)]
pub struct OrdersService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl OrdersService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    /// Emit `ServerEvent::ResourceChanged { resource: "projects" }` after each
    /// committed write (spec §3.5), so other clients' `projects` screens refetch
    /// and their nav badge counts the change. Wired by `banto-serve` and
    /// `src-tauri` with the app-wide `event_channel()` sender.
    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn notify_changed(&self) {
        crate::events::notify_changed(&self.events, "projects");
    }

    /// `?` placeholders as the backend wants them (`$1`, `$2`, … on Postgres).
    pub(crate) fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    fn now(&self) -> &'static str {
        now_expr(self.db.dialect())
    }

    async fn state(&self, project_id: i64) -> Result<State, BantoError> {
        let project_sql = self.sql(
            "SELECT p.code, p.name, p.status, p.revenue_version, \
             p.parent_project_id, pp.code AS parent_code FROM projects p \
             LEFT JOIN projects pp ON pp.id = p.parent_project_id WHERE p.id = ?",
        );
        let project: Option<ProjectRow> =
            on_pool!(&self.db, pool => fetch_optional!(pool, project_sql, project_id))?;
        let Some(project) = project else {
            return Err(BantoError::NotFound {
                resource: "projects".into(),
                id: project_id.to_string(),
            });
        };
        let status = ProjectStatus::parse(&project.status).ok_or_else(|| {
            BantoError::Other(format!("不明な案件の状態です: {}", project.status))
        })?;
        let conversion_sql = self.sql(
            "SELECT c.id, c.source_pipeline_version_id, v.version_no AS source_version_no, \
             c.previous_status, c.converted_on, c.confirmed_amount, c.scope, \
             c.remainder_project_id, rp.code AS remainder_code, c.basis, \
             u.display_name AS created_by_name, c.created_at FROM order_conversions c \
             LEFT JOIN pipeline_versions v ON v.id = c.source_pipeline_version_id \
             LEFT JOIN projects rp ON rp.id = c.remainder_project_id \
             LEFT JOIN users u ON u.id = c.created_by \
             WHERE c.project_id = ? AND c.cancelled_at IS NULL",
        );
        let cancelled_sql = self.sql(
            "SELECT c.id, c.previous_status, c.converted_on, c.confirmed_amount, c.scope, \
             c.remainder_project_id, rp.code AS remainder_code, c.basis, \
             u.display_name AS created_by_name, c.cancelled_on, c.cancel_reason, \
             cu.display_name AS cancelled_by_name, c.cancelled_at FROM order_conversions c \
             LEFT JOIN projects rp ON rp.id = c.remainder_project_id \
             LEFT JOIN users u ON u.id = c.created_by \
             LEFT JOIN users cu ON cu.id = c.cancelled_by \
             WHERE c.project_id = ? AND c.cancelled_at IS NOT NULL \
             ORDER BY c.cancelled_at DESC, c.id DESC",
        );
        let changes_sql = self.sql(
            "SELECT c.id, c.change_no, c.delta_amount, c.plan_month, c.status, c.basis, \
             c.requested_by, ru.display_name AS requested_by_name, c.requested_at, \
             du.display_name AS decided_by_name, c.decided_at, c.decision_note \
             FROM order_changes c LEFT JOIN users ru ON ru.id = c.requested_by \
             LEFT JOIN users du ON du.id = c.decided_by WHERE c.project_id = ? \
             ORDER BY c.change_no DESC",
        );
        let plans_sql = self.sql(
            "SELECT id, month, amount FROM revenue_plan WHERE project_id = ? \
             ORDER BY month IS NULL, month, id",
        );
        let recognitions_sql = self.sql(
            "SELECT r.id, r.recognized_on, r.amount, r.basis, \
             ru.display_name AS recorded_by_name, r.recorded_at, \
             cu.display_name AS cancelled_by_name, r.cancelled_at, r.cancel_reason \
             FROM revenue_recognitions r LEFT JOIN users ru ON ru.id = r.recorded_by \
             LEFT JOIN users cu ON cu.id = r.cancelled_by WHERE r.project_id = ? \
             ORDER BY r.recognized_on DESC, r.id DESC",
        );
        let clearings_sql = self.sql(
            "SELECT c.recognition_id, c.plan_id, c.amount FROM revenue_clearings c \
             JOIN revenue_recognitions r ON r.id = c.recognition_id WHERE r.project_id = ? \
             ORDER BY c.recognition_id, c.plan_id",
        );
        let records_sql = self.records_sql();
        let corrections_sql = self.sql(
            "SELECT c.id, c.old_converted_on, c.new_converted_on, c.old_basis, c.new_basis, \
             c.reason, c.corrected_on, u.display_name AS corrected_by_name, c.corrected_at \
             FROM order_conversion_corrections c LEFT JOIN users u ON u.id = c.corrected_by \
             WHERE c.conversion_id = ? ORDER BY c.id DESC",
        );
        let (mut conversion, changes, plans, recognitions, clearings, cancelled_conversions) = on_pool!(&self.db, pool => (
            fetch_optional!(pool, conversion_sql, project_id)?,
            fetch_all!(pool, changes_sql, project_id)?,
            fetch_all!(pool, plans_sql, project_id)?,
            fetch_all!(pool, recognitions_sql, project_id)?,
            fetch_all!(pool, clearings_sql, project_id)?,
            fetch_all!(pool, cancelled_sql, project_id)?,
        ));
        let conversion_ref: &mut Option<OrderConversion> = &mut conversion;
        if let Some(c) = conversion_ref.as_mut() {
            let conversion_id: i64 = c.id;
            c.corrections =
                on_pool!(&self.db, pool => fetch_all!(pool, corrections_sql, conversion_id))?;
        }
        let cancel_blockers = match &conversion {
            Some(c) => {
                let records: Option<RecordCounts> = on_pool!(&self.db, pool =>
                    fetch_optional!(pool, records_sql, project_id, project_id, project_id,
                        project_id, project_id, project_id, project_id, project_id,
                        project_id, project_id, project_id))?;
                let remainder = self.remainder_status(c).await?;
                cancel_issues(status, c, remainder, records.unwrap_or_default())
            }
            None => Vec::new(),
        };
        Ok(State {
            project_id,
            project,
            status,
            conversion,
            changes,
            plans,
            recognitions,
            clearings,
            cancel_blockers,
            cancelled_conversions,
        })
    }

    /// The current status of a partial order's remainder project (`None` for a
    /// whole order, or when the project cannot be read).
    async fn remainder_status(
        &self,
        conversion: &OrderConversion,
    ) -> Result<Option<ProjectStatus>, BantoError> {
        let Some(id) = conversion.remainder_project_id else {
            return Ok(None);
        };
        let sql = self.sql("SELECT status FROM projects WHERE id = ?");
        let row: Option<(String,)> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        Ok(row.and_then(|(s,)| ProjectStatus::parse(&s)))
    }

    /// How many records of each kind that block a conversion cancellation the
    /// project has (T40). Binds the project id 11 times.
    fn records_sql(&self) -> String {
        self.sql(
            "SELECT \
             (SELECT COUNT(*) FROM order_changes WHERE project_id = ?), \
             (SELECT COUNT(*) FROM revenue_recognitions WHERE project_id = ?), \
             (SELECT COUNT(*) FROM budget_versions WHERE project_id = ?), \
             (SELECT COUNT(*) FROM time_entries WHERE project_id = ?), \
             (SELECT COUNT(*) FROM purchase_orders WHERE project_id = ?) \
             + (SELECT COUNT(*) FROM direct_costs WHERE project_id = ?) \
             + (SELECT COUNT(*) FROM cost_allocations WHERE project_id = ?), \
             (SELECT COUNT(*) FROM forecast_versions WHERE project_id = ?), \
             (SELECT COUNT(*) FROM fixed_cost_contracts WHERE project_id = ?) \
             + (SELECT COUNT(*) FROM fixed_cost_postings WHERE project_id = ?), \
             (SELECT COUNT(*) FROM recurring_revenues WHERE project_id = ?)",
        )
    }

    /// The order and revenue of a project (pre-order projects return an
    /// empty summary with `confirmedAmount: null`).
    pub async fn summary(&self, project_id: i64) -> Result<OrderSummary, BantoError> {
        Ok(self.state(project_id).await?.summary())
    }

    /// Who requested a change (the `Approve` decision needs it: nobody
    /// approves their own request, spec §4).
    pub async fn change_requester(
        &self,
        project_id: i64,
        change_id: i64,
    ) -> Result<Option<i64>, BantoError> {
        let sql =
            self.sql("SELECT requested_by FROM order_changes WHERE id = ? AND project_id = ?");
        let row: Option<(Option<i64>,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, change_id, project_id))?;
        row.map(|(by,)| by).ok_or_else(|| BantoError::NotFound {
            resource: "order_changes".into(),
            id: change_id.to_string(),
        })
    }

    /// Convert a pre-order project to an order (T23), optionally splitting
    /// the rest of the scope into a new pre-order project (T24).
    pub async fn convert(
        &self,
        project_id: i64,
        input: ConversionRequest,
        actor_user_id: Option<i64>,
    ) -> Result<OrderSummary, BantoError> {
        let state = self.state(project_id).await?;
        let mut errors = Vec::new();
        if state.conversion.is_some() {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("status", "この案件は既に受注転換しています")],
            });
        }
        let Some(row_version) = input.row_version else {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("rowVersion", "版番号がありません")],
            });
        };
        date("convertedOn", &input.converted_on, &mut errors);
        let basis = text(
            "basis",
            &input.basis,
            Some("受注の根拠（注文書番号・契約など）を入力してください"),
            &mut errors,
        );
        let order_no = clean_optional(&input.order_no);
        if order_no
            .as_deref()
            .is_some_and(|s| s.chars().count() > MAX_CODE_LEN)
        {
            errors.push(field_error(
                "orderNo",
                format!("{MAX_CODE_LEN}文字以内で入力してください"),
            ));
        }
        let planned_start = clean_optional(&input.planned_start);
        let planned_end = clean_optional(&input.planned_end);
        let start = planned_start.as_deref().map(Date::parse);
        let end = planned_end.as_deref().map(Date::parse);
        if start.is_some_and(|d| d.is_none()) {
            errors.push(field_error(
                "plannedStart",
                "日付は YYYY-MM-DD で入力してください",
            ));
        }
        if end.is_some_and(|d| d.is_none()) {
            errors.push(field_error(
                "plannedEnd",
                "日付は YYYY-MM-DD で入力してください",
            ));
        }
        for issue in validate_project(&DomainProject {
            code: &state.project.code,
            name: &state.project.name,
            status: ProjectStatus::Ordered,
            planned_start: start.flatten(),
            planned_end: end.flatten(),
        }) {
            match issue {
                ProjectIssue::PlannedDatesRequired => errors.push(field_error(
                    if planned_start.is_none() {
                        "plannedStart"
                    } else {
                        "plannedEnd"
                    },
                    "受注後は予定開始日と完了日が必要です",
                )),
                ProjectIssue::EndBeforeStart => errors.push(field_error(
                    "plannedEnd",
                    "完了日は開始日以降にしてください",
                )),
                ProjectIssue::CodeRequired | ProjectIssue::NameRequired => {}
            }
        }
        let plan = plan_lines("revenuePlan", &input.revenue_plan, &mut errors);
        let scope = ConversionScope::parse(&input.scope);
        if scope.is_none() {
            errors.push(field_error("scope", "受注の範囲が正しくありません"));
        }
        for issue in check_conversion(&DomainConversion {
            status: state.status,
            confirmed_amount: input.confirmed_amount,
            plan: &plan,
            scope: scope.unwrap_or(ConversionScope::Whole),
        }) {
            let (field, message) = match issue {
                ConversionIssue::NotConvertible => (
                    "status",
                    "受注前の有効な案件（引合・見積中・交渉中・保留）だけ受注転換できます".to_string(),
                ),
                ConversionIssue::AmountNotPositive => {
                    ("confirmedAmount", "確定受注額は1円以上で入力してください".to_string())
                }
                ConversionIssue::PlanMissing => (
                    "revenuePlan",
                    "売上予定を入力してください（時期未定でも1行必要です）".to_string(),
                ),
                ConversionIssue::PlanNegative => {
                    ("revenuePlan", "売上予定の金額は0以上で入力してください".to_string())
                }
                ConversionIssue::DuplicateMonth => {
                    ("revenuePlan", "同じ月の売上予定が重複しています".to_string())
                }
                ConversionIssue::PlanMismatch {
                    plan_total,
                    confirmed,
                } => (
                    "revenuePlan",
                    format!("売上予定の合計（{plan_total}円）を確定受注額（{confirmed}円）に合わせてください"),
                ),
            };
            errors.push(field_error(field, message));
        }
        // The remainder of a partial order: a new pre-order project.
        let remainder = match (scope, &input.remainder) {
            (Some(ConversionScope::Partial), None) => {
                errors.push(field_error(
                    "remainder",
                    "一部受注では残りの範囲（新しい案件）を入力してください",
                ));
                None
            }
            (Some(ConversionScope::Whole), Some(_)) => {
                errors.push(field_error(
                    "remainder",
                    "全部受注では残りの範囲を指定しません",
                ));
                None
            }
            (Some(ConversionScope::Partial), Some(r)) => {
                let code = r.code.trim().to_string();
                let name = r.name.trim().to_string();
                if code.is_empty() {
                    errors.push(field_error("remainder.code", "入力してください"));
                } else if code.chars().count() > MAX_CODE_LEN {
                    errors.push(field_error(
                        "remainder.code",
                        format!("{MAX_CODE_LEN}文字以内で入力してください"),
                    ));
                } else if self.code_taken(&code).await? {
                    errors.push(field_error(
                        "remainder.code",
                        "この案件IDは既に使われています",
                    ));
                }
                if name.is_empty() {
                    errors.push(field_error("remainder.name", "入力してください"));
                } else if name.chars().count() > MAX_NAME_LEN {
                    errors.push(field_error(
                        "remainder.name",
                        format!("{MAX_NAME_LEN}文字以内で入力してください"),
                    ));
                }
                let mut version = r.version.clone();
                version.adopt = true;
                match crate::pipeline::validate(&version) {
                    Ok(clean) => Some((code, name, clean)),
                    Err(BantoError::Validation { field_errors }) => {
                        errors.extend(field_errors.into_iter().map(|e| FieldError {
                            field: format!("remainder.{}", e.field),
                            message: e.message,
                        }));
                        None
                    }
                    Err(other) => return Err(other),
                }
            }
            (None, _) | (Some(ConversionScope::Whole), None) => None,
        };
        validation(errors)?;
        let scope = scope.expect("checked above");
        let source_sql = self.sql(
            "SELECT id, stage FROM pipeline_versions WHERE project_id = ? AND kind = 'adopted' \
             ORDER BY version_no DESC LIMIT 1",
        );
        let source: Option<(i64, String)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, source_sql, project_id))?;
        let source_id = source.as_ref().map(|(id, _)| *id);

        let update_project = self.sql(&format!(
            "UPDATE projects SET status = 'ordered', planned_start = ?, planned_end = ?, \
             order_no = COALESCE(?, order_no), row_version = row_version + 1, \
             revenue_version = revenue_version + 1, updated_at = {} \
             WHERE id = ? AND row_version = ? AND status = ?",
            self.now()
        ));
        let insert_remainder = self.sql(
            "INSERT INTO projects (code, name, customer_id, manager_user_id, status, \
             department, parent_project_id) SELECT ?, ?, customer_id, manager_user_id, ?, \
             department, id FROM projects WHERE id = ? RETURNING id",
        );
        let copy_members = self.sql(
            "INSERT INTO project_members (project_id, user_id, kind) \
             SELECT ?, user_id, kind FROM project_members \
             WHERE project_id = ? AND kind IN ('sales', 'manager')",
        );
        let insert_version = self.sql(&format!(
            "INSERT INTO pipeline_versions (project_id, version_no, kind, stage, expected_amount, \
             probability_pct, expected_order_month, expected_start_month, expected_end_month, \
             est_cost_at_order, basis, next_action, confirmed_on, created_by, adopted_by, adopted_at) \
             VALUES (?, 1, 'adopted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, {}) RETURNING id",
            self.now()
        ));
        let insert_version_plan = self.sql(
            "INSERT INTO pipeline_revenue_plan (pipeline_version_id, month, amount) VALUES (?, ?, ?)",
        );
        let insert_conversion = self.sql(
            "INSERT INTO order_conversions (project_id, source_pipeline_version_id, \
             previous_status, converted_on, confirmed_amount, scope, remainder_project_id, \
             basis, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        let insert_plan =
            self.sql("INSERT INTO revenue_plan (project_id, month, amount) VALUES (?, ?, ?)");
        let previous = state.status.as_str();
        let converted_on = input.converted_on.trim().to_string();
        let plan_rows: Vec<(Option<String>, i64)> = plan
            .iter()
            .filter(|l| l.amount != 0)
            .map(|l| (l.month.map(|m| m.to_string()), l.amount))
            .collect();
        in_tx!(&self.db, tx => {
            let affected = execute!(&mut *tx, update_project, &planned_start, &planned_end,
                &order_no, project_id, row_version, previous)?;
            if affected == 0 {
                return Err(stale_version_error());
            }
            let mut remainder_id: Option<i64> = None;
            if let Some((code, name, clean)) = &remainder {
                let id: i64 = scalar!(&mut *tx, insert_remainder, code, name, previous, project_id)?;
                execute!(&mut *tx, copy_members, id, project_id)?;
                let version_id: i64 = scalar!(&mut *tx, insert_version, id,
                    clean.stage.as_str(), clean.expected_amount,
                    clean.probability_pct.map(i64::from), &clean.expected_order_month,
                    &clean.expected_start_month, &clean.expected_end_month,
                    clean.est_cost_at_order, &clean.basis, &clean.next_action,
                    &clean.confirmed_on, actor_user_id, actor_user_id)?;
                for (month, amount) in &clean.plan {
                    execute!(&mut *tx, insert_version_plan, version_id, month, *amount)?;
                }
                remainder_id = Some(id);
            }
            execute!(&mut *tx, insert_conversion, project_id, source_id, previous,
                &converted_on, input.confirmed_amount, scope.as_str(), remainder_id,
                &basis, actor_user_id)?;
            for (month, amount) in &plan_rows {
                execute!(&mut *tx, insert_plan, project_id, month, *amount)?;
            }
        });
        self.notify_changed();
        self.summary(project_id).await
    }

    /// Cancel the project's conversion (受注転換の取消, T40, review U-3): only an
    /// order on which nothing has been recorded yet, and for a partial order only
    /// while its remainder project is not ordered itself
    /// (`cost_domain::order::check_conversion_cancel`). A partial order's
    /// remainder becomes 中止 (`ProjectStatus::remainder_closed_to`). The project goes back to
    /// its status before the conversion, the unrecognized revenue plan the
    /// conversion made is removed, and the conversion row stays as history with
    /// the business date, the reason and who. Planned dates and the order
    /// number stay as entered. The pipeline versions were never rewritten, so
    /// the project's adopted version counts in the pipeline again.
    ///
    /// The records are counted again inside the transaction after the project
    /// row is written (on SQLite that write takes the database's write lock,
    /// so a record written after the check cannot slip in, T13).
    ///
    /// `checked_remainder` is the remainder project the wiring layer checked
    /// `EditProject` on ([`Self::conversion_remainder`]): the cancellation
    /// sets that project to 中止, so the caller must be allowed to edit it
    /// too. A conversion whose remainder is another one is refused as stale.
    pub async fn cancel_conversion(
        &self,
        project_id: i64,
        input: ConversionCancelInput,
        actor_user_id: Option<i64>,
        checked_remainder: Option<i64>,
    ) -> Result<OrderSummary, BantoError> {
        let state = self.state(project_id).await?;
        let Some(conversion) = state.conversion.as_ref() else {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("status", "受注転換していない案件です")],
            });
        };
        if conversion.remainder_project_id != checked_remainder {
            return Err(stale_version_error());
        }
        let Some(row_version) = input.row_version else {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("rowVersion", "版番号がありません")],
            });
        };
        if !state.cancel_blockers.is_empty() {
            return Err(cancel_refused(&state.cancel_blockers));
        }
        let mut errors = Vec::new();
        let reason = text(
            "reason",
            &input.reason,
            Some("取消の理由を入力してください"),
            &mut errors,
        );
        validation(errors)?;
        let previous = ProjectStatus::parse(&conversion.previous_status)
            .and_then(|p| state.status.unconverted_to(p))
            .ok_or_else(|| cancel_refused(&[ConversionCancelIssue::PreviousUnknown]))?;
        let conversion_id = conversion.id;
        let cancelled_on = crate::business_date::today().to_string();
        let update_project = self.sql(&format!(
            "UPDATE projects SET status = ?, row_version = row_version + 1, \
             revenue_version = revenue_version + 1, updated_at = {} \
             WHERE id = ? AND row_version = ? AND revenue_version = ? AND status = 'ordered'",
            self.now()
        ));
        let records_sql = self.records_sql();
        let cancel = self.sql(&format!(
            "UPDATE order_conversions SET cancelled_on = ?, cancel_reason = ?, \
             cancelled_by = ?, cancelled_at = {} WHERE id = ? AND cancelled_at IS NULL",
            self.now()
        ));
        let delete_plan = self.sql("DELETE FROM revenue_plan WHERE project_id = ?");
        let remainder_sql = self.sql("SELECT status FROM projects WHERE id = ?");
        let close_remainder = self.sql(&format!(
            "UPDATE projects SET status = ?, row_version = row_version + 1, updated_at = {} \
             WHERE id = ? AND status = ?",
            self.now()
        ));
        let remainder_id = conversion.remainder_project_id;
        let revenue_version = state.project.revenue_version;
        in_tx!(&self.db, tx => {
            let affected = execute!(&mut *tx, update_project, previous.as_str(), project_id,
                row_version, revenue_version)?;
            if affected == 0 {
                return Err(stale_version_error());
            }
            let records: Option<RecordCounts> = fetch_optional!(&mut *tx, records_sql,
                project_id, project_id, project_id, project_id, project_id, project_id,
                project_id, project_id, project_id, project_id, project_id)?;
            let remainder: Option<ProjectStatus> = match remainder_id {
                Some(id) => {
                    let row: Option<(String,)> = fetch_optional!(&mut *tx, remainder_sql, id)?;
                    row.and_then(|(s,)| ProjectStatus::parse(&s))
                }
                None => None,
            };
            let issues = cancel_issues(
                ProjectStatus::Ordered,
                conversion,
                remainder,
                records.unwrap_or_default(),
            );
            if !issues.is_empty() {
                return Err(cancel_refused(&issues));
            }
            // A partial order's remainder leaves the pipeline as 中止 (lost /
            // cancelled ones stay as they are), so the original project's
            // adopted version - the whole scope - is not counted twice.
            if let (Some(id), Some(from)) = (remainder_id, remainder) {
                if let Some(to) = from.remainder_closed_to() {
                    if execute!(&mut *tx, close_remainder, to.as_str(), id, from.as_str())? == 0 {
                        return Err(stale_version_error());
                    }
                }
            }
            if execute!(&mut *tx, cancel, &cancelled_on, &reason, actor_user_id,
                conversion_id)? == 0 {
                return Err(stale_version_error());
            }
            execute!(&mut *tx, delete_plan, project_id)?;
        });
        self.notify_changed();
        self.summary(project_id).await
    }

    /// The remainder project of the project's current (not cancelled)
    /// conversion, if it is a partial order. The wiring layer checks
    /// `EditProject` on it before a cancellation (which sets it to 中止).
    pub async fn conversion_remainder(&self, project_id: i64) -> Result<Option<i64>, BantoError> {
        let sql = self.sql(
            "SELECT remainder_project_id FROM order_conversions \
             WHERE project_id = ? AND cancelled_at IS NULL",
        );
        let row: Option<(Option<i64>,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))?;
        Ok(row.and_then(|(id,)| id))
    }

    /// Correct the 受注日 / 根拠 of the project's conversion (T41) with a reason,
    /// also after records are on the order (unlike the cancellation, T40). The
    /// conversion row keeps the corrected values and the correction keeps
    /// both, so the history shows what was entered first. Neither value feeds
    /// any amount, so no figure changes. Settled projects are refused
    /// (`cost_domain::order::check_conversion_correction`).
    ///
    /// Starts with the `revenue_version` compare-and-set, which also requires
    /// the project to be still ordered and not settled (T13).
    pub async fn correct_conversion(
        &self,
        project_id: i64,
        input: ConversionCorrectionInput,
        actor_user_id: Option<i64>,
    ) -> Result<(OrderSummary, CorrectionRecord), BantoError> {
        let state = self.state(project_id).await?;
        let Some(conversion) = state.conversion.as_ref() else {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("status", "受注転換していない案件です")],
            });
        };
        let Some(revenue_version) = input.revenue_version else {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("revenueVersion", "版番号がありません")],
            });
        };
        let mut errors = Vec::new();
        let converted_on = input.converted_on.trim().to_string();
        let basis = text("basis", &input.basis, None, &mut errors).unwrap_or_default();
        let reason = text("reason", &input.reason, None, &mut errors).unwrap_or_default();
        for issue in check_conversion_correction(&ConversionCorrection {
            status: state.status,
            current_converted_on: &conversion.converted_on,
            current_basis: &conversion.basis,
            converted_on: Date::parse(&converted_on),
            basis: &basis,
            reason: &reason,
        }) {
            let (field, message) = match issue {
                ConversionCorrectionIssue::NotOpenOrder => (
                    "status",
                    "精算完了の案件は直せません（精算完了を取り消してから直してください）",
                ),
                ConversionCorrectionIssue::DateInvalid => {
                    ("convertedOn", "日付は YYYY-MM-DD で入力してください")
                }
                ConversionCorrectionIssue::BasisRequired => (
                    "basis",
                    "受注の根拠（注文書番号・契約など）を入力してください",
                ),
                ConversionCorrectionIssue::ReasonRequired => {
                    ("reason", "訂正の理由を入力してください")
                }
                ConversionCorrectionIssue::NoChange => (
                    "convertedOn",
                    "受注日も根拠も今のままです。直す値を入力してください",
                ),
            };
            errors.push(field_error(field, message));
        }
        validation(errors)?;
        let corrected_on = crate::business_date::today().to_string();
        let guard = self.sql(
            "UPDATE projects SET revenue_version = revenue_version + 1 \
             WHERE id = ? AND revenue_version = ? \
             AND status IN ('ordered', 'in_progress', 'work_done')",
        );
        let update = self.sql(
            "UPDATE order_conversions SET converted_on = ?, basis = ? \
             WHERE id = ? AND cancelled_at IS NULL AND converted_on = ? AND basis = ?",
        );
        let insert = self.sql(
            "INSERT INTO order_conversion_corrections (conversion_id, old_converted_on, \
             new_converted_on, old_basis, new_basis, reason, corrected_on, corrected_by) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        );
        let conversion_id = conversion.id;
        let (old_on, old_basis) = (&conversion.converted_on, &conversion.basis);
        let correction_id: i64 = in_tx!(&self.db, tx => {
            if execute!(&mut *tx, guard, project_id, revenue_version)? == 0 {
                return Err(stale_version_error());
            }
            if execute!(&mut *tx, update, &converted_on, &basis, conversion_id, old_on,
                old_basis)? == 0 {
                return Err(stale_version_error());
            }
            scalar!(&mut *tx, insert, conversion_id, old_on, &converted_on, old_basis, &basis,
                &reason, &corrected_on, actor_user_id)?
        });
        let record = CorrectionRecord {
            conversion_id,
            correction_id,
            old_converted_on: old_on.clone(),
            new_converted_on: converted_on,
            basis_changed: *old_basis != basis,
        };
        self.notify_changed();
        Ok((self.summary(project_id).await?, record))
    }

    async fn code_taken(&self, code: &str) -> Result<bool, BantoError> {
        let sql = self.sql("SELECT id FROM projects WHERE code = ?");
        let row: Option<(i64,)> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, code))?;
        Ok(row.is_some())
    }

    /// The compare-and-set every revenue write starts with (T13).
    fn guard_sql(&self) -> String {
        self.sql(
            "UPDATE projects SET revenue_version = revenue_version + 1 \
             WHERE id = ? AND revenue_version = ?",
        )
    }

    /// Record an order change as pending (未確定追加売上).
    pub async fn request_change(
        &self,
        project_id: i64,
        input: ChangeRequest,
        actor_user_id: Option<i64>,
    ) -> Result<OrderSummary, BantoError> {
        let state = self.state(project_id).await?;
        state.require_ordered()?;
        let mut errors = Vec::new();
        if input.delta_amount == 0 {
            errors.push(field_error(
                "deltaAmount",
                "変更差額を入力してください（0円は不可）",
            ));
        }
        let plan_month = month("planMonth", &input.plan_month, &mut errors);
        let basis = text(
            "basis",
            &input.basis,
            Some("変更の根拠を入力してください"),
            &mut errors,
        );
        validation(errors)?;
        let guard = self.guard_sql();
        let next_no = self
            .sql("SELECT COALESCE(MAX(change_no), 0) + 1 FROM order_changes WHERE project_id = ?");
        let insert = self.sql(
            "INSERT INTO order_changes (project_id, change_no, delta_amount, plan_month, status, \
             basis, requested_by) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        );
        let version = state.project.revenue_version;
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, guard, project_id, version)? == 0 {
                return Err(stale_version_error());
            }
            let no: i64 = scalar!(&mut *tx, next_no, project_id)?;
            execute!(&mut *tx, insert, project_id, no, input.delta_amount, &plan_month,
                &basis, actor_user_id)?;
        });
        self.notify_changed();
        self.summary(project_id).await
    }

    /// Approve (adds the delta to the confirmed amount and the plan) or
    /// reject a pending change. Decided changes stay as history.
    pub async fn decide_change(
        &self,
        project_id: i64,
        change_id: i64,
        input: ChangeDecision,
        actor_user_id: Option<i64>,
    ) -> Result<OrderSummary, BantoError> {
        let state = self.state(project_id).await?;
        let revenue = state.require_ordered()?;
        let Some(change) = state.changes.iter().find(|c| c.id == change_id) else {
            return Err(BantoError::NotFound {
                resource: "order_changes".into(),
                id: change_id.to_string(),
            });
        };
        if change.status != ChangeStatus::Pending.as_str() {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("status", "この受注変更は既に判断済みです")],
            });
        }
        let mut errors = Vec::new();
        let note = text(
            "note",
            &input.note,
            (!input.approve).then_some("却下の理由を入力してください"),
            &mut errors,
        );
        validation(errors)?;
        // A rejection leaves the plan as it is (no line changes).
        let next = if input.approve {
            revenue
                .apply_change(change.delta_amount, ym(&change.plan_month))
                .map_err(|issues| revenue_errors("deltaAmount", &issues))?
        } else {
            revenue
        };
        let rewrite = self.plan_rewrite(&state, &next);
        let status = if input.approve {
            ChangeStatus::Approved
        } else {
            ChangeStatus::Rejected
        };
        let decide = self.sql(&format!(
            "UPDATE order_changes SET status = ?, decided_by = ?, decided_at = {}, \
             decision_note = ? WHERE id = ? AND project_id = ? AND status = 'pending'",
            self.now()
        ));
        self.write_plan(
            project_id,
            rewrite,
            Some(Decision {
                sql: decide,
                status,
                actor: actor_user_id,
                note,
                change_id,
            }),
        )
        .await?;
        self.notify_changed();
        self.summary(project_id).await
    }

    /// Apply plan ops (plus an optional change decision) behind the guard.
    /// The plan line changes `next` needs, with the statements to write
    /// them (checked on `version`, the project's `revenue_version`).
    fn plan_rewrite(&self, state: &State, next: &OrderedRevenue) -> PlanRewrite {
        PlanRewrite {
            version: state.project.revenue_version,
            ops: plan_ops(state, next),
            guard: self.guard_sql(),
            update: self.sql("UPDATE revenue_plan SET amount = ? WHERE id = ? AND project_id = ?"),
            delete: self.sql("DELETE FROM revenue_plan WHERE id = ? AND project_id = ?"),
            insert: self
                .sql("INSERT INTO revenue_plan (project_id, month, amount) VALUES (?, ?, ?)"),
        }
    }

    /// Check a rewrite of an ordered (not settled) project's revenue plan:
    /// `next` builds the new state from the current one (it must pass
    /// `OrderedRevenue::check`). The caller writes it with
    /// [`write_plan_rewrite!`] inside its own transaction (定期売上, P7c).
    pub(crate) async fn prepare_plan_rewrite(
        &self,
        project_id: i64,
        next: impl FnOnce(&OrderedRevenue) -> Result<OrderedRevenue, BantoError>,
    ) -> Result<PlanRewrite, BantoError> {
        let state = self.state(project_id).await?;
        let revenue = state.require_ordered()?;
        let next = next(&revenue)?;
        Ok(self.plan_rewrite(&state, &next))
    }

    async fn write_plan(
        &self,
        project_id: i64,
        rewrite: PlanRewrite,
        decision: Option<Decision>,
    ) -> Result<(), BantoError> {
        in_tx!(&self.db, tx => {
            write_plan_rewrite!(&mut *tx, rewrite, project_id);
            if let Some(d) = &decision {
                if execute!(&mut *tx, d.sql, d.status.as_str(), d.actor, &d.note, d.change_id, project_id)? == 0 {
                    return Err(stale_version_error());
                }
            }
        });
        Ok(())
    }

    /// Replace the open (not yet recognized) revenue plan. The open total
    /// must equal the unrecognized remainder (spec §5.5).
    pub async fn replan(
        &self,
        project_id: i64,
        input: ReplanInput,
    ) -> Result<OrderSummary, BantoError> {
        let state = self.state(project_id).await?;
        let revenue = state.require_ordered()?;
        let Some(version) = input.revenue_version else {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("revenueVersion", "版番号がありません")],
            });
        };
        if version != state.project.revenue_version {
            return Err(stale_version_error());
        }
        let mut errors = Vec::new();
        let lines = plan_lines("lines", &input.lines, &mut errors);
        validation(errors)?;
        let next = revenue
            .replan(&lines)
            .map_err(|issues| revenue_errors("lines", &issues))?;
        let rewrite = self.plan_rewrite(&state, &next);
        self.write_plan(project_id, rewrite, None).await?;
        self.notify_changed();
        self.summary(project_id).await
    }

    /// Record revenue recognized by accounting, clearing plan lines (T26).
    pub async fn recognize(
        &self,
        project_id: i64,
        input: RecognitionInput,
        actor_user_id: Option<i64>,
    ) -> Result<OrderSummary, BantoError> {
        let state = self.state(project_id).await?;
        let revenue = state.require_ordered()?;
        let mut errors = Vec::new();
        let on = date("recognizedOn", &input.recognized_on, &mut errors);
        let basis = text("basis", &input.basis, None, &mut errors);
        if input.amount <= 0 {
            errors.push(field_error("amount", "計上額は1円以上で入力してください"));
        }
        validation(errors)?;
        let on = on.expect("checked above");
        let clears: Vec<Clearing> = match &input.clears {
            None => revenue.auto_clear(on.year_month(), input.amount),
            Some(list) => list
                .iter()
                .map(|c| Clearing {
                    plan_id: c.plan_id.to_string(),
                    amount: c.amount,
                })
                .collect(),
        };
        if clears.iter().any(|c| c.amount <= 0) {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("clears", "消込額は1円以上で入力してください")],
            });
        }
        revenue
            .with_sale(RecognizedSale {
                id: "new".into(),
                month: on.year_month(),
                amount: input.amount,
                clears: clears.clone(),
            })
            .map_err(|issues| revenue_errors("amount", &issues))?;
        let guard = self.guard_sql();
        let insert = self.sql(
            "INSERT INTO revenue_recognitions (project_id, recognized_on, amount, basis, \
             recorded_by) VALUES (?, ?, ?, ?, ?) RETURNING id",
        );
        let insert_clearing = self.sql(
            "INSERT INTO revenue_clearings (recognition_id, plan_id, amount) VALUES (?, ?, ?)",
        );
        let version = state.project.revenue_version;
        let recognized_on = on.to_string();
        let gate = MonthGate::new(self.db.dialect());
        let clears: Vec<(i64, i64)> = clears
            .iter()
            .filter_map(|c| c.plan_id.parse().ok().map(|id| (id, c.amount)))
            .collect();
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, guard, project_id, version)? == 0 {
                return Err(stale_version_error());
            }
            refuse_closed!(&mut *tx, gate, &recognized_on, "recognizedOn");
            let id: i64 = scalar!(&mut *tx, insert, project_id, &recognized_on, input.amount,
                &basis, actor_user_id)?;
            for (plan_id, amount) in &clears {
                execute!(&mut *tx, insert_clearing, id, *plan_id, *amount)?;
            }
        });
        self.notify_changed();
        self.summary(project_id).await
    }

    /// Cancel a recognition (with a reason). Its clearings are released; the
    /// row and its clearings stay as history.
    pub async fn cancel_recognition(
        &self,
        project_id: i64,
        recognition_id: i64,
        input: CancelInput,
        actor_user_id: Option<i64>,
    ) -> Result<OrderSummary, BantoError> {
        let state = self.state(project_id).await?;
        let revenue = state.require_ordered()?;
        let Some(row) = state.recognitions.iter().find(|r| r.id == recognition_id) else {
            return Err(BantoError::NotFound {
                resource: "revenue_recognitions".into(),
                id: recognition_id.to_string(),
            });
        };
        if row.cancelled_at.is_some() {
            return Err(BantoError::Validation {
                field_errors: vec![field_error(
                    "status",
                    "この売上計上は既に取り消されています",
                )],
            });
        }
        let mut errors = Vec::new();
        let reason = text(
            "reason",
            &input.reason,
            Some("取消の理由を入力してください"),
            &mut errors,
        );
        validation(errors)?;
        revenue
            .without_sale(&recognition_id.to_string())
            .map_err(|issues| revenue_errors("reason", &issues))?;
        let guard = self.guard_sql();
        let cancel = self.sql(&format!(
            "UPDATE revenue_recognitions SET cancelled_by = ?, cancelled_at = {}, \
             cancel_reason = ? WHERE id = ? AND project_id = ? AND cancelled_at IS NULL",
            self.now()
        ));
        let version = state.project.revenue_version;
        let gate = MonthGate::new(self.db.dialect());
        let recognized_on = row.recognized_on.clone();
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, guard, project_id, version)? == 0 {
                return Err(stale_version_error());
            }
            if execute!(&mut *tx, cancel, actor_user_id, &reason, recognition_id, project_id)? == 0 {
                return Err(stale_version_error());
            }
            refuse_closed!(&mut *tx, gate, &recognized_on, "reason");
        });
        self.notify_changed();
        self.summary(project_id).await
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::pipeline::{PipelineService, PipelineVersionInput};
    use crate::projects::tests::{fixture, input as project_input};
    use crate::projects::ProjectsService;
    use banto_admin_services::authz::{AuthzService, MemberKind, ProjectScope};

    pub(crate) fn line(month: Option<&str>, amount: i64) -> PlanLine {
        PlanLine {
            month: month.map(str::to_string),
            amount,
        }
    }

    pub(crate) fn version(amount: i64, prob: i64, month: &str) -> PipelineVersionInput {
        PipelineVersionInput {
            stage: "negotiating".into(),
            expected_amount: Some(amount),
            probability_pct: Some(prob),
            expected_order_month: Some("2026-11".into()),
            expected_start_month: None,
            expected_end_month: None,
            est_cost_at_order: None,
            basis: Some("見積提出済み".into()),
            next_action: None,
            confirmed_on: Some("2026-11-02".into()),
            revenue_plan: vec![line(Some(month), amount)],
            adopt: true,
        }
    }

    /// A pre-order project with an adopted version (amount, probability,
    /// revenue month).
    pub(crate) async fn pipeline_project(
        db: &Db,
        code: &str,
        amount: i64,
        prob: i64,
        month: &str,
    ) -> i64 {
        let id = ProjectsService::new(db.clone())
            .create(project_input(code), Some(1))
            .await
            .unwrap()
            .id;
        PipelineService::new(db.clone())
            .create_version(id, version(amount, prob, month), Some(2))
            .await
            .unwrap();
        id
    }

    pub(crate) async fn row_version(db: &Db, id: i64) -> i64 {
        ProjectsService::new(db.clone())
            .get(id)
            .await
            .unwrap()
            .row_version
    }

    pub(crate) fn conversion(
        row_version: i64,
        amount: i64,
        plan: Vec<PlanLine>,
    ) -> ConversionRequest {
        ConversionRequest {
            row_version: Some(row_version),
            converted_on: "2026-11-20".into(),
            confirmed_amount: amount,
            basis: Some("注文書 PO-0001".into()),
            planned_start: Some("2026-12-01".into()),
            planned_end: Some("2027-03-31".into()),
            order_no: Some("PO-0001".into()),
            revenue_plan: plan,
            scope: "whole".into(),
            remainder: None,
        }
    }

    pub(crate) async fn ordered_project(db: &Db, code: &str, plan: Vec<PlanLine>) -> i64 {
        let total = plan.iter().map(|l| l.amount).sum();
        let id = pipeline_project(db, code, total, 50, "2026-12").await;
        let rv = row_version(db, id).await;
        OrdersService::new(db.clone())
            .convert(id, conversion(rv, total, plan), Some(1))
            .await
            .unwrap();
        id
    }

    fn field_of(err: BantoError) -> Vec<String> {
        match err {
            BantoError::Validation { field_errors } => {
                field_errors.into_iter().map(|e| e.field).collect()
            }
            other => panic!("validation expected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn t23_conversion_moves_the_project_to_the_ordered_side_once() {
        let db = fixture().await;
        let a = pipeline_project(&db, "P-001", 3_000_000, 60, "2026-12").await;
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = OrdersService::new(db.clone()).with_events(tx);
        let rv = row_version(&db, a).await;
        // A refused conversion (stale row_version) sends nothing.
        assert!(svc
            .convert(
                a,
                conversion(rv + 1, 2_800_000, vec![line(Some("2026-12"), 2_800_000)]),
                Some(1),
            )
            .await
            .is_err());
        assert!(rx.try_recv().is_err());
        let s = svc
            .convert(
                a,
                conversion(rv, 2_800_000, vec![line(Some("2026-12"), 2_800_000)]),
                Some(1),
            )
            .await
            .unwrap();
        match rx.try_recv().expect("the conversion notifies once") {
            ServerEvent::ResourceChanged { resource } => assert_eq!(resource, "projects"),
            other => panic!("unexpected event {other:?}"),
        }
        assert!(rx.try_recv().is_err());
        assert_eq!(s.status, "ordered");
        assert_eq!(s.confirmed_amount, Some(2_800_000));
        assert_eq!(
            s.recognized_total, 0,
            "no revenue is recognized automatically"
        );
        assert_eq!(s.remaining, Some(2_800_000));
        assert_eq!(s.plan.len(), 1);
        assert!(s.issues.is_empty());
        let c = s.conversion.unwrap();
        assert_eq!(
            (c.previous_status.as_str(), c.source_version_no),
            ("lead", Some(1))
        );
        // The pipeline no longer counts it; its versions stay as history.
        let pipeline = PipelineService::new(db.clone());
        let o = pipeline.overview(&ProjectScope::All).await.unwrap();
        assert!(o.rows.is_empty());
        assert_eq!(o.totals.total, 0);
        assert_eq!(pipeline.versions(a).await.unwrap().len(), 1);
        // Converting again, or recording a pipeline version, is refused.
        let rv = row_version(&db, a).await;
        assert_eq!(
            field_of(
                svc.convert(a, conversion(rv, 1, vec![line(None, 1)]), None)
                    .await
                    .unwrap_err()
            ),
            vec!["status"]
        );
        assert!(pipeline
            .create_version(a, version(1, 1, "2026-12"), None)
            .await
            .is_err());
        // An ordered project cannot be edited back to a pre-order status.
        let projects = ProjectsService::new(db.clone());
        let mut lost = project_input("P-001");
        lost.status = "lost".into();
        lost.planned_start = Some("2026-12-01".into());
        lost.planned_end = Some("2027-03-31".into());
        lost.row_version = Some(rv);
        assert_eq!(
            field_of(projects.update(a, lost).await.unwrap_err()),
            vec!["status"]
        );
        let mut progress = project_input("P-001");
        progress.status = "in_progress".into();
        progress.planned_start = Some("2026-12-01".into());
        progress.planned_end = Some("2027-03-31".into());
        progress.row_version = Some(rv);
        assert_eq!(
            projects.update(a, progress).await.unwrap().status,
            "in_progress"
        );
    }

    #[tokio::test]
    async fn conversion_validates_and_needs_the_current_row_version() {
        let db = fixture().await;
        let a = pipeline_project(&db, "P-001", 3_000_000, 60, "2026-12").await;
        let svc = OrdersService::new(db.clone());
        let rv = row_version(&db, a).await;
        let mut bad = conversion(rv, 2_800_000, vec![line(Some("2026-12"), 3_000_000)]);
        bad.basis = None;
        bad.planned_end = None;
        bad.converted_on = "2026/11/20".into();
        assert_eq!(
            field_of(svc.convert(a, bad, None).await.unwrap_err()),
            vec!["convertedOn", "basis", "plannedEnd", "revenuePlan"]
        );
        let stale = conversion(rv - 1, 2_800_000, vec![line(Some("2026-12"), 2_800_000)]);
        assert_eq!(
            field_of(svc.convert(a, stale, None).await.unwrap_err()),
            vec!["rowVersion"]
        );
        let mut partial = conversion(rv, 2_800_000, vec![line(Some("2026-12"), 2_800_000)]);
        partial.scope = "partial".into();
        assert_eq!(
            field_of(svc.convert(a, partial, None).await.unwrap_err()),
            vec!["remainder"]
        );
        assert_eq!(svc.summary(a).await.unwrap().status, "lead");
    }

    #[tokio::test]
    async fn t24_partial_order_splits_the_scope_without_overlap() {
        let db = fixture().await;
        let a = pipeline_project(&db, "P-001", 5_000_000, 50, "2027-01").await;
        let svc = OrdersService::new(db.clone());
        let rv = row_version(&db, a).await;
        let mut req = conversion(rv, 3_000_000, vec![line(Some("2027-01"), 3_000_000)]);
        req.scope = "partial".into();
        let mut rest = version(2_000_000, 50, "2027-03");
        rest.basis = Some("二期工事は次年度予算".into());
        req.remainder = Some(RemainderInput {
            code: "P-001-2".into(),
            name: "制御盤更新（二期）".into(),
            version: rest,
        });
        let s = svc.convert(a, req, Some(1)).await.unwrap();
        let c = s.conversion.unwrap();
        assert_eq!(c.scope, "partial");
        assert_eq!(c.remainder_code.as_deref(), Some("P-001-2"));
        let b = c.remainder_project_id.unwrap();
        let remainder = svc.summary(b).await.unwrap();
        assert_eq!(
            (remainder.status.as_str(), remainder.parent_code.as_deref()),
            ("lead", Some("P-001"))
        );
        // Only the remainder is left in the pipeline.
        let o = PipelineService::new(db.clone())
            .overview(&ProjectScope::All)
            .await
            .unwrap();
        assert_eq!(o.rows.len(), 1);
        assert_eq!(o.rows[0].project_id, b);
        assert_eq!((o.totals.total, o.totals.weighted), (2_000_000, 1_000_000));
        // The sales owner and the manager carry over to the remainder.
        let members = AuthzService::new(db.clone())
            .project_members(b)
            .await
            .unwrap();
        assert_eq!(
            members
                .iter()
                .map(|m| (m.user_id, m.kind))
                .collect::<Vec<_>>(),
            vec![(1, MemberKind::Sales), (2, MemberKind::Manager)]
        );
    }

    fn cancel_input(row_version: i64, reason: Option<&str>) -> ConversionCancelInput {
        ConversionCancelInput {
            row_version: Some(row_version),
            reason: reason.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn t40_conversion_cancel_returns_the_project_to_the_pipeline_and_allows_reconverting() {
        let db = fixture().await;
        let a = pipeline_project(&db, "P-001", 3_000_000, 60, "2026-12").await;
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = OrdersService::new(db.clone()).with_events(tx);
        let rv = row_version(&db, a).await;
        let s = svc
            .convert(
                a,
                conversion(rv, 2_800_000, vec![line(Some("2026-12"), 2_800_000)]),
                Some(1),
            )
            .await
            .unwrap();
        assert!(s.cancel_blockers.is_empty(), "{:?}", s.cancel_blockers);
        while rx.try_recv().is_ok() {}
        let rv = row_version(&db, a).await;
        // The reason is required; a stale row version is refused. Neither notifies.
        assert_eq!(
            field_of(
                svc.cancel_conversion(a, cancel_input(rv, Some("  ")), Some(1), None)
                    .await
                    .unwrap_err()
            ),
            vec!["reason"]
        );
        assert_eq!(
            field_of(
                svc.cancel_conversion(
                    a,
                    cancel_input(rv - 1, Some("案件の取り違え")),
                    Some(1),
                    None
                )
                .await
                .unwrap_err()
            ),
            vec!["rowVersion"]
        );
        assert!(rx.try_recv().is_err());
        let s = svc
            .cancel_conversion(a, cancel_input(rv, Some("案件の取り違え")), Some(2), None)
            .await
            .unwrap();
        assert!(matches!(
            rx.try_recv().expect("the cancellation notifies once"),
            ServerEvent::ResourceChanged { .. }
        ));
        assert_eq!(s.status, "lead", "back to the status before the conversion");
        assert!(s.conversion.is_none());
        assert_eq!(s.confirmed_amount, None);
        assert!(s.plan.is_empty(), "the unrecognized plan is removed");
        assert_eq!(s.cancelled_conversions.len(), 1);
        let h = &s.cancelled_conversions[0];
        assert_eq!(
            (
                h.confirmed_amount,
                h.cancel_reason.as_str(),
                h.previous_status.as_str()
            ),
            (2_800_000, "案件の取り違え", "lead")
        );
        assert_eq!(h.cancelled_on, crate::business_date::today().to_string());
        // The adopted pipeline version counts again.
        let pipeline = PipelineService::new(db.clone());
        let o = pipeline.overview(&ProjectScope::All).await.unwrap();
        assert_eq!((o.totals.total, o.totals.weighted), (3_000_000, 1_800_000));
        // Cancelling again is refused; converting again works and keeps the history.
        let rv = row_version(&db, a).await;
        assert_eq!(
            field_of(
                svc.cancel_conversion(a, cancel_input(rv, Some("再度")), None, None)
                    .await
                    .unwrap_err()
            ),
            vec!["status"]
        );
        let s = svc
            .convert(
                a,
                conversion(rv, 3_000_000, vec![line(Some("2026-12"), 3_000_000)]),
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(s.confirmed_amount, Some(3_000_000));
        assert_eq!(s.plan.len(), 1);
        assert_eq!(s.cancelled_conversions.len(), 1);
        assert!(s.issues.is_empty());
    }

    fn correction_input(
        revenue_version: i64,
        converted_on: &str,
        basis: &str,
        reason: &str,
    ) -> ConversionCorrectionInput {
        ConversionCorrectionInput {
            revenue_version: Some(revenue_version),
            converted_on: converted_on.into(),
            basis: Some(basis.into()),
            reason: Some(reason.into()),
        }
    }

    #[tokio::test]
    async fn t41_conversion_correction_works_after_records_and_keeps_the_history() {
        let db = fixture().await;
        let a = ordered_project(&db, "P-001", vec![line(Some("2027-01"), 4_000_000)]).await;
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = OrdersService::new(db.clone()).with_events(tx);
        svc.recognize(
            a,
            RecognitionInput {
                recognized_on: "2027-01-25".into(),
                amount: 1_000_000,
                basis: None,
                clears: None,
            },
            Some(1),
        )
        .await
        .unwrap();
        let before = svc.summary(a).await.unwrap();
        assert_eq!(before.cancel_blockers, vec!["recognitions"]);
        while rx.try_recv().is_ok() {}
        let v = before.revenue_version;
        // Nothing to correct, an empty reason, a stale version: refused, no event.
        assert_eq!(
            field_of(
                svc.correct_conversion(
                    a,
                    correction_input(v, "2026-11-20", "注文書 PO-0001", "同じ"),
                    Some(1)
                )
                .await
                .unwrap_err()
            ),
            vec!["convertedOn"]
        );
        assert_eq!(
            field_of(
                svc.correct_conversion(a, correction_input(v, "2026-11-02", " ", " "), Some(1))
                    .await
                    .unwrap_err()
            ),
            vec!["basis", "reason"]
        );
        assert_eq!(
            field_of(
                svc.correct_conversion(
                    a,
                    correction_input(v - 1, "2026-11-02", "注文書 PO-0001", "日付の誤り"),
                    Some(1)
                )
                .await
                .unwrap_err()
            ),
            vec!["rowVersion"]
        );
        assert!(rx.try_recv().is_err());

        let (s, first) = svc
            .correct_conversion(
                a,
                correction_input(v, "2026-11-02", "注文書 PO-0001", "注文書の日付の入力誤り"),
                Some(2),
            )
            .await
            .unwrap();
        assert!(rx.try_recv().is_ok(), "the correction notifies");
        let c = s.conversion.as_ref().unwrap();
        assert_eq!(
            (c.converted_on.as_str(), c.basis.as_str()),
            ("2026-11-02", "注文書 PO-0001")
        );
        // No figure changes.
        assert_eq!(
            (
                s.confirmed_amount,
                s.recognized_total,
                s.remaining,
                s.status.as_str()
            ),
            (
                before.confirmed_amount,
                before.recognized_total,
                before.remaining,
                "ordered"
            )
        );
        assert_eq!(s.plan, before.plan);
        assert_eq!(s.revenue_version, v + 1);

        let (s, second) = svc
            .correct_conversion(
                a,
                correction_input(
                    s.revenue_version,
                    "2026-11-02",
                    "注文書 PO-0010",
                    "番号の誤り",
                ),
                None,
            )
            .await
            .unwrap();
        let c = s.conversion.as_ref().unwrap();
        assert_eq!(c.basis, "注文書 PO-0010");
        let h: Vec<_> = c
            .corrections
            .iter()
            .map(|r| {
                (
                    r.old_converted_on.as_str(),
                    r.new_converted_on.as_str(),
                    r.old_basis.as_str(),
                    r.new_basis.as_str(),
                    r.reason.as_str(),
                )
            })
            .collect();
        assert_eq!(
            h,
            vec![
                (
                    "2026-11-02",
                    "2026-11-02",
                    "注文書 PO-0001",
                    "注文書 PO-0010",
                    "番号の誤り"
                ),
                (
                    "2026-11-20",
                    "2026-11-02",
                    "注文書 PO-0001",
                    "注文書 PO-0001",
                    "注文書の日付の入力誤り"
                ),
            ],
            "newest first, before and after"
        );
        assert_eq!(
            c.corrections[0].corrected_on,
            crate::business_date::today().to_string()
        );
        // Each call's audit names its own correction, even though the history
        // read back after the first one could already hold a later one.
        assert_eq!(first.correction_id, c.corrections[1].id);
        let detail = conversion_correction_audit_detail(&first);
        assert_eq!(detail["correctionId"], c.corrections[1].id);
        assert_eq!(detail["convertedOnChanged"], true);
        assert_eq!(detail["basisChanged"], false);
        assert_eq!(
            (&detail["fromConvertedOn"], &detail["toConvertedOn"]),
            (
                &serde_json::json!("2026-11-20"),
                &serde_json::json!("2026-11-02")
            )
        );
        let detail = conversion_correction_audit_detail(&second);
        assert_eq!(detail["correctionId"], c.corrections[0].id);
        assert_eq!(detail["basisChanged"], true);
        assert_eq!(detail["convertedOnChanged"], false);
        assert!(detail.get("reason").is_none());
    }

    #[tokio::test]
    async fn t41_conversion_correction_is_refused_before_the_order_and_once_settled() {
        let db = fixture().await;
        let svc = OrdersService::new(db.clone());
        let p = pipeline_project(&db, "P-001", 3_000_000, 60, "2026-12").await;
        assert_eq!(
            field_of(
                svc.correct_conversion(
                    p,
                    correction_input(0, "2026-11-02", "注文書", "誤り"),
                    Some(1)
                )
                .await
                .unwrap_err()
            ),
            vec!["status"]
        );
        let a = ordered_project(&db, "P-002", vec![line(Some("2027-01"), 4_000_000)]).await;
        let v = svc.summary(a).await.unwrap().revenue_version;
        let settle = "UPDATE projects SET status = 'settled' WHERE id = ?".to_string();
        on_pool!(&db, pool => execute!(pool, settle, a)).unwrap();
        assert_eq!(
            field_of(
                svc.correct_conversion(
                    a,
                    correction_input(v, "2026-11-02", "注文書", "誤り"),
                    Some(1)
                )
                .await
                .unwrap_err()
            ),
            vec!["status"]
        );
        let c = svc.summary(a).await.unwrap().conversion.unwrap();
        assert_eq!(c.converted_on, "2026-11-20");
        assert!(c.corrections.is_empty());
    }

    /// A partial order: 3,000,000 ordered out of a 5,000,000 pipeline version,
    /// the remaining 2,000,000 as project `{code}-2`.
    async fn partial_project(db: &Db, code: &str) -> i64 {
        let id = pipeline_project(db, code, 5_000_000, 50, "2027-01").await;
        let rv = row_version(db, id).await;
        let mut req = conversion(rv, 3_000_000, vec![line(Some("2027-01"), 3_000_000)]);
        req.scope = "partial".into();
        req.remainder = Some(RemainderInput {
            code: format!("{code}-2"),
            name: "二期".into(),
            version: version(2_000_000, 50, "2027-03"),
        });
        OrdersService::new(db.clone())
            .convert(id, req, Some(1))
            .await
            .unwrap();
        id
    }

    #[tokio::test]
    async fn t40_partial_order_cancel_closes_the_remainder_without_double_counting() {
        let db = fixture().await;
        let a = partial_project(&db, "P-001").await;
        let svc = OrdersService::new(db.clone());
        let s = svc.summary(a).await.unwrap();
        assert!(s.cancel_blockers.is_empty(), "{:?}", s.cancel_blockers);
        let remainder = s.conversion.unwrap().remainder_project_id.unwrap();
        let rv = row_version(&db, a).await;
        // The remainder the caller was checked on must be this conversion's.
        assert!(matches!(
            svc.cancel_conversion(a, cancel_input(rv, Some("範囲の入力誤り")), Some(1), None)
                .await
                .unwrap_err(),
            BantoError::Validation { .. }
        ));
        assert_eq!(svc.conversion_remainder(a).await.unwrap(), Some(remainder));
        assert_eq!(svc.summary(remainder).await.unwrap().status, "lead");
        let s = svc
            .cancel_conversion(
                a,
                cancel_input(rv, Some("範囲の入力誤り")),
                Some(1),
                Some(remainder),
            )
            .await
            .unwrap();
        assert_eq!(s.status, "lead");
        let h = &s.cancelled_conversions[0];
        assert_eq!(
            (h.scope.as_str(), h.remainder_code.as_deref()),
            ("partial", Some("P-001-2"))
        );
        // The remainder is 中止 and keeps its history; only the original
        // project's adopted version (the whole 5,000,000) counts again.
        assert_eq!(svc.summary(remainder).await.unwrap().status, "cancelled");
        let pipeline = PipelineService::new(db.clone());
        assert_eq!(pipeline.versions(remainder).await.unwrap().len(), 1);
        let o = pipeline.overview(&ProjectScope::All).await.unwrap();
        let remainder_row = o.rows.iter().find(|r| r.project_id == remainder).unwrap();
        assert_eq!(remainder_row.stage.as_deref(), Some("cancelled"));
        assert_eq!((o.totals.total, o.totals.weighted), (5_000_000, 2_500_000));
        assert_eq!(o.totals.active_count, 1);
        // The project can be converted again (as a whole order this time).
        let rv = row_version(&db, a).await;
        let s = svc
            .convert(
                a,
                conversion(rv, 5_000_000, vec![line(Some("2027-01"), 5_000_000)]),
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(s.confirmed_amount, Some(5_000_000));
    }

    #[tokio::test]
    async fn t40_conversion_cancel_is_refused_once_the_order_has_records() {
        let db = fixture().await;
        let a = ordered_project(&db, "P-001", vec![line(Some("2027-01"), 4_000_000)]).await;
        let svc = OrdersService::new(db.clone());
        svc.request_change(
            a,
            ChangeRequest {
                delta_amount: 300_000,
                plan_month: Some("2027-02".into()),
                basis: Some("追加の画面改修".into()),
            },
            Some(1),
        )
        .await
        .unwrap();
        svc.recognize(
            a,
            RecognitionInput {
                recognized_on: "2027-01-25".into(),
                amount: 1_000_000,
                basis: None,
                clears: None,
            },
            Some(1),
        )
        .await
        .unwrap();
        let s = svc.summary(a).await.unwrap();
        assert_eq!(s.cancel_blockers, vec!["order_changes", "recognitions"]);
        let rv = row_version(&db, a).await;
        let err = svc
            .cancel_conversion(a, cancel_input(rv, Some("取り違え")), Some(1), None)
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "status");
                assert!(field_errors[0].message.contains("受注変更"));
            }
            other => panic!("validation expected, got {other:?}"),
        }
        assert_eq!(svc.summary(a).await.unwrap().status, "ordered");

        // A partial order whose remainder has been converted itself stays.
        let b = partial_project(&db, "P-002").await;
        let remainder = svc
            .summary(b)
            .await
            .unwrap()
            .conversion
            .unwrap()
            .remainder_project_id
            .unwrap();
        let rv = row_version(&db, remainder).await;
        svc.convert(
            remainder,
            conversion(rv, 2_000_000, vec![line(Some("2027-03"), 2_000_000)]),
            Some(1),
        )
        .await
        .unwrap();
        assert_eq!(
            svc.summary(b).await.unwrap().cancel_blockers,
            vec!["remainder_ordered"]
        );

        // Once the project is in progress, the conversion stays.
        let c = ordered_project(&db, "P-003", vec![line(None, 1_000)]).await;
        let mut progress = project_input("P-003");
        progress.status = "in_progress".into();
        progress.planned_start = Some("2026-12-01".into());
        progress.planned_end = Some("2027-03-31".into());
        progress.row_version = Some(row_version(&db, c).await);
        ProjectsService::new(db.clone())
            .update(c, progress)
            .await
            .unwrap();
        assert_eq!(
            svc.summary(c).await.unwrap().cancel_blockers,
            vec!["not_ordered"]
        );
    }

    #[tokio::test]
    async fn t24_order_changes_stay_out_of_the_confirmed_amount_until_approved() {
        let db = fixture().await;
        let a = ordered_project(&db, "P-001", vec![line(Some("2027-01"), 4_000_000)]).await;
        let svc = OrdersService::new(db.clone());
        let s = svc
            .request_change(
                a,
                ChangeRequest {
                    delta_amount: 300_000,
                    plan_month: Some("2027-02".into()),
                    basis: Some("追加の画面改修".into()),
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(
            (s.confirmed_amount, s.pending_total),
            (Some(4_000_000), 300_000)
        );
        let change_id = s.changes[0].id;
        assert_eq!(svc.change_requester(a, change_id).await.unwrap(), Some(1));
        let s = svc
            .decide_change(
                a,
                change_id,
                ChangeDecision {
                    approve: true,
                    note: None,
                },
                Some(2),
            )
            .await
            .unwrap();
        assert_eq!((s.confirmed_amount, s.pending_total), (Some(4_300_000), 0));
        assert_eq!(s.remaining, Some(4_300_000));
        assert_eq!(
            s.plan
                .iter()
                .map(|p| (p.month.as_deref(), p.open))
                .collect::<Vec<_>>(),
            vec![(Some("2027-01"), 4_000_000), (Some("2027-02"), 300_000)]
        );
        assert!(s.issues.is_empty());
        assert_eq!(s.changes[0].status, "approved");
        assert!(svc
            .decide_change(
                a,
                change_id,
                ChangeDecision {
                    approve: true,
                    note: None
                },
                Some(2)
            )
            .await
            .is_err());
        // A rejection needs a reason and changes nothing but the status.
        let s = svc
            .request_change(
                a,
                ChangeRequest {
                    delta_amount: -100_000,
                    plan_month: None,
                    basis: Some("値引き交渉".into()),
                },
                Some(1),
            )
            .await
            .unwrap();
        let id = s.changes[0].id;
        assert_eq!(
            field_of(
                svc.decide_change(
                    a,
                    id,
                    ChangeDecision {
                        approve: false,
                        note: None
                    },
                    Some(2)
                )
                .await
                .unwrap_err()
            ),
            vec!["note"]
        );
        let s = svc
            .decide_change(
                a,
                id,
                ChangeDecision {
                    approve: false,
                    note: Some("値引きはしない".into()),
                },
                Some(2),
            )
            .await
            .unwrap();
        assert_eq!((s.confirmed_amount, s.pending_total), (Some(4_300_000), 0));
        // A pre-order project has no order changes.
        let p = pipeline_project(&db, "P-002", 1, 1, "2026-12").await;
        assert!(svc
            .request_change(
                p,
                ChangeRequest {
                    delta_amount: 1,
                    plan_month: None,
                    basis: Some("x".into())
                },
                None
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn t26_recognition_clears_the_plan_and_cancel_restores_it() {
        let db = fixture().await;
        let a = ordered_project(
            &db,
            "P-001",
            vec![
                line(Some("2026-12"), 2_000_000),
                line(Some("2027-01"), 700_000),
                line(None, 300_000),
            ],
        )
        .await;
        let svc = OrdersService::new(db.clone());
        let s = svc
            .recognize(
                a,
                RecognitionInput {
                    recognized_on: "2026-12-25".into(),
                    amount: 1_200_000,
                    basis: Some("12月検収分".into()),
                    clears: None,
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(
            (s.recognized_total, s.remaining),
            (1_200_000, Some(1_800_000))
        );
        assert_eq!(
            s.plan
                .iter()
                .map(|p| (p.month.as_deref(), p.cleared, p.open))
                .collect::<Vec<_>>(),
            vec![
                (Some("2026-12"), 1_200_000, 800_000),
                (Some("2027-01"), 0, 700_000),
                (None, 0, 300_000)
            ]
        );
        assert!(s.issues.is_empty());
        let rec = s.recognitions[0].id;
        assert_eq!(
            s.recognitions[0].clears[0].month.as_deref(),
            Some("2026-12")
        );
        // Over the confirmed amount is refused, not rounded.
        let err = svc
            .recognize(
                a,
                RecognitionInput {
                    recognized_on: "2027-01-31".into(),
                    amount: 1_900_000,
                    basis: None,
                    clears: None,
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(field_of(err)[0], "amount");
        // Explicit clearing of the undated line.
        let s = svc
            .recognize(
                a,
                RecognitionInput {
                    recognized_on: "2027-01-31".into(),
                    amount: 300_000,
                    basis: None,
                    clears: Some(vec![ClearingInput {
                        plan_id: s.plan[2].id,
                        amount: 300_000,
                    }]),
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(s.plan[2].open, 0);
        // Cancelling needs a reason, keeps the row and reopens the plan.
        assert_eq!(
            field_of(
                svc.cancel_recognition(a, rec, CancelInput { reason: None }, Some(1))
                    .await
                    .unwrap_err()
            ),
            vec!["reason"]
        );
        let s = svc
            .cancel_recognition(
                a,
                rec,
                CancelInput {
                    reason: Some("計上月の誤り".into()),
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(
            (s.recognized_total, s.remaining),
            (300_000, Some(2_700_000))
        );
        assert_eq!(s.plan[0].open, 2_000_000);
        assert_eq!(
            s.recognitions.len(),
            2,
            "the cancelled row stays as history"
        );
        assert!(s.issues.is_empty());
    }

    #[tokio::test]
    async fn replan_keeps_cleared_lines_and_needs_the_current_version() {
        let db = fixture().await;
        let a = ordered_project(
            &db,
            "P-001",
            vec![
                line(Some("2026-12"), 2_000_000),
                line(Some("2027-01"), 1_000_000),
            ],
        )
        .await;
        let svc = OrdersService::new(db.clone());
        let s = svc
            .recognize(
                a,
                RecognitionInput {
                    recognized_on: "2026-12-25".into(),
                    amount: 2_000_000,
                    basis: None,
                    clears: None,
                },
                Some(1),
            )
            .await
            .unwrap();
        let s2 = svc
            .replan(
                a,
                ReplanInput {
                    revenue_version: Some(s.revenue_version),
                    lines: vec![line(Some("2027-02"), 600_000), line(None, 400_000)],
                },
            )
            .await
            .unwrap();
        assert_eq!(
            s2.plan
                .iter()
                .map(|p| (p.month.as_deref(), p.amount, p.open))
                .collect::<Vec<_>>(),
            vec![
                (Some("2026-12"), 2_000_000, 0),
                (Some("2027-02"), 600_000, 600_000),
                (None, 400_000, 400_000)
            ]
        );
        // A plan that does not add up to the remainder is refused.
        assert_eq!(
            field_of(
                svc.replan(
                    a,
                    ReplanInput {
                        revenue_version: Some(s2.revenue_version),
                        lines: vec![line(None, 1)],
                    },
                )
                .await
                .unwrap_err()
            ),
            vec!["lines"]
        );
        // A stale version is refused (T13).
        assert_eq!(
            field_of(
                svc.replan(
                    a,
                    ReplanInput {
                        revenue_version: Some(s.revenue_version),
                        lines: vec![line(None, 1_000_000)],
                    },
                )
                .await
                .unwrap_err()
            ),
            vec!["rowVersion"]
        );
    }
}
