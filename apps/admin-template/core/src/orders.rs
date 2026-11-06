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

use std::collections::{BTreeMap, BTreeSet};

use banto_core::{BantoError, FieldError};
use banto_storage::{Db, Dialect};
use cost_domain::order::{
    check_conversion, ChangeStatus, ConversionInput as DomainConversion, ConversionIssue,
    ConversionScope, OrderBook, OrderChange as DomainChange,
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

use crate::customers::{clean_optional, field_error, now_expr, stale_version_error};
use crate::pipeline::{PipelineVersionInput, PlanLine};
use crate::projects::{MAX_CODE_LEN, MAX_NAME_LEN};

pub const MAX_TEXT_LEN: usize = 1000;

/// The policy the order-change decision is authorized with on both paths:
/// the person who requested a change may decide it, because the company
/// runs banto-cost single-handed (spec §4 small-team exception, user
/// decision 2026-11-06). The wiring layers record `selfApproval` in the
/// audit detail when it is used.
pub const ORDER_CHANGE_POLICY: banto_admin_services::authz::Policy =
    banto_admin_services::authz::Policy {
        allow_self_approval: true,
    };
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

    fn require_ordered(&self) -> Result<OrderedRevenue, BantoError> {
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
        }
    }
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
fn revenue_errors(field: &str, issues: &[RevenueIssue]) -> BantoError {
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
}

impl OrdersService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// `?` placeholders as the backend wants them (`$1`, `$2`, … on Postgres).
    pub(crate) fn sql(&self, s: &str) -> String {
        match self.db.dialect() {
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
             LEFT JOIN users u ON u.id = c.created_by WHERE c.project_id = ?",
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
        let (conversion, changes, plans, recognitions, clearings) = on_pool!(&self.db, pool => (
            fetch_optional!(pool, conversion_sql, project_id)?,
            fetch_all!(pool, changes_sql, project_id)?,
            fetch_all!(pool, plans_sql, project_id)?,
            fetch_all!(pool, recognitions_sql, project_id)?,
            fetch_all!(pool, clearings_sql, project_id)?,
        ));
        Ok(State {
            project_id,
            project,
            status,
            conversion,
            changes,
            plans,
            recognitions,
            clearings,
        })
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
        self.summary(project_id).await
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
        let ops = if input.approve {
            let next = revenue
                .apply_change(change.delta_amount, ym(&change.plan_month))
                .map_err(|issues| revenue_errors("deltaAmount", &issues))?;
            plan_ops(&state, &next)
        } else {
            Vec::new()
        };
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
        let version = state.project.revenue_version;
        self.write_plan(
            project_id,
            version,
            ops,
            Some(Decision {
                sql: decide,
                status,
                actor: actor_user_id,
                note,
                change_id,
            }),
        )
        .await?;
        self.summary(project_id).await
    }

    /// Apply plan ops (plus an optional change decision) behind the guard.
    async fn write_plan(
        &self,
        project_id: i64,
        version: i64,
        ops: Vec<PlanOp>,
        decision: Option<Decision>,
    ) -> Result<(), BantoError> {
        let guard = self.guard_sql();
        let update = self.sql("UPDATE revenue_plan SET amount = ? WHERE id = ? AND project_id = ?");
        let delete = self.sql("DELETE FROM revenue_plan WHERE id = ? AND project_id = ?");
        let insert =
            self.sql("INSERT INTO revenue_plan (project_id, month, amount) VALUES (?, ?, ?)");
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, guard, project_id, version)? == 0 {
                return Err(stale_version_error());
            }
            if let Some(d) = &decision {
                if execute!(&mut *tx, d.sql, d.status.as_str(), d.actor, &d.note, d.change_id, project_id)? == 0 {
                    return Err(stale_version_error());
                }
            }
            for op in &ops {
                match op {
                    PlanOp::Update(id, amount) => {
                        execute!(&mut *tx, update, *amount, *id, project_id)?;
                    }
                    PlanOp::Delete(id) => {
                        execute!(&mut *tx, delete, *id, project_id)?;
                    }
                    PlanOp::Insert(month, amount) => {
                        execute!(&mut *tx, insert, project_id, month, *amount)?;
                    }
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
        let ops = plan_ops(&state, &next);
        self.write_plan(project_id, version, ops, None).await?;
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
        let clears: Vec<(i64, i64)> = clears
            .iter()
            .filter_map(|c| c.plan_id.parse().ok().map(|id| (id, c.amount)))
            .collect();
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, guard, project_id, version)? == 0 {
                return Err(stale_version_error());
            }
            let id: i64 = scalar!(&mut *tx, insert, project_id, &recognized_on, input.amount,
                &basis, actor_user_id)?;
            for (plan_id, amount) in &clears {
                execute!(&mut *tx, insert_clearing, id, *plan_id, *amount)?;
            }
        });
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
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, guard, project_id, version)? == 0 {
                return Err(stale_version_error());
            }
            if execute!(&mut *tx, cancel, actor_user_id, &reason, recognition_id, project_id)? == 0 {
                return Err(stale_version_error());
            }
        });
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
        let svc = OrdersService::new(db.clone());
        let rv = row_version(&db, a).await;
        let s = svc
            .convert(
                a,
                conversion(rv, 2_800_000, vec![line(Some("2026-12"), 2_800_000)]),
                Some(1),
            )
            .await
            .unwrap();
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
