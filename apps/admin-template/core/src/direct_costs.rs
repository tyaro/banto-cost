//! Direct costs and purchase orders (直接費・発注, banto-cost P4d,
//! `docs/project/design.md` §3.3, spec §3.2 / §6.3 / §6.4 / §11, T05, T10,
//! T14).
//!
//! Service-layer shape (conventions §2): `Clone`, `BantoError`, sqlx, no
//! tauri/axum. The rules live in `cost_domain::direct_cost` (input checks, the
//! approval check over the approved ledger, purchase-order remainders) and
//! `cost_domain::ledger` (adjustments, provisional confirmation, allocation);
//! this module loads and stores rows. Authorization (`EnterCost`,
//! `ApproveCost`, `EditPurchaseOrder`, `ViewProjectAmounts`, ADR-0028) and
//! audit are the REST/Tauri wiring's ([`crate::cost_access`] maps a record to
//! the projects it lands on). Ownership is the service's: someone else's
//! record reads as not found to the owner-only operations.
//!
//! Workflow (the same as hours): 下書き → 申請 → 承認, or 差戻し. Only
//! approved records are actuals; an approved record is never edited. A
//! change to an approved record is a new record that refers to it and is
//! approved in turn (spec §11): a return / cancel / discount (`adjustment`,
//! the reduction as a positive amount) or the invoiced amount replacing a
//! provisional (`confirms`, the provisional no longer counts, spec §6.3).
//! A cost with no project is split over projects (`cost_allocations`, T10)
//! and counts on those projects only.
//!
//! A purchase order is a commitment, not a cost: its realized amount is the
//! sum of the approved records that refer to it, computed from the ledger,
//! so the order, the invoice and the payment never add the same cost twice
//! (T05). Approving a record that would realize more than the order's
//! remainder is refused: the order's amount is revised first, with its reason.
//!
//! Concurrency (T13): every update compares `row_version`; a create with a
//! `clientRequestId` the person already used returns the first row. An
//! approval writes its row first and then reads the approved ledger in the
//! same transaction (SQLite holds the write lock from the first write; on
//! Postgres the order and the referred record are locked `FOR UPDATE`), so
//! two approvals cannot both pass the remainder or the adjustment check.
//! The ledger is loaded whole: a small company's direct costs are few.

use std::collections::BTreeMap;

use banto_admin_services::authz::ProjectScope;
use banto_core::{BantoError, FieldError};
use banto_server::ServerEvent;
use banto_storage::{Db, Dialect};
use cost_domain::direct_cost::{
    check_amount_change, check_approval, check_cancel, check_input, order_realized,
    project_actuals, ApprovalIssue, CostInput, CostIssue, OrderTerms, RecordKind, TaxKind,
    MAX_ALLOCATIONS,
};
use cost_domain::forecast::CostType;
use cost_domain::ledger::{
    self, AdjustmentKind, Allocation, CostEntry, EntryKind, LedgerIssue, Posting,
};
use cost_domain::purchase::PurchaseError;
use cost_domain::time::TimeStatus;
use cost_domain::{Date, FiscalCalendar};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::customers::{clean_optional, field_error, now_expr, stale_version_error};
use crate::orders::{
    execute, fetch_all, fetch_optional, in_tx, on_pool, placeholders, scalar, MAX_TEXT_LEN,
};
use crate::time_entries::{DecisionInput, MAX_REQUEST_ID_LEN};
use crate::work_masters::{MasterKind, WorkMastersService};

pub const RESOURCE: &str = "direct_costs";
pub const ORDER_RESOURCE: &str = "purchase_orders";
/// The longest range one list call returns.
pub const MAX_RANGE_DAYS: i64 = 366;
/// The cost types a direct cost or an order may carry.
pub const DIRECT_TYPES: [CostType; 4] = [
    CostType::Material,
    CostType::Outsource,
    CostType::Travel,
    CostType::Other,
];

/// One allocation line (配分先) of a split cost.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationLine {
    pub project_id: i64,
    pub project_code: String,
    pub project_name: String,
    pub amount: i64,
}

/// One direct cost record as the screens see it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectCost {
    pub id: i64,
    pub user_id: i64,
    pub user_name: String,
    /// `normal` | `provisional` | `confirms` | `adjustment`.
    pub entry_kind: String,
    /// The record a `confirms` / `adjustment` refers to.
    pub ref_id: Option<i64>,
    /// `return` | `cancel` | `discount` (adjustments).
    pub adjustment_kind: Option<String>,
    /// `None` = split over `allocations`.
    pub project_id: Option<i64>,
    pub project_code: Option<String>,
    pub project_name: Option<String>,
    pub phase_id: Option<i64>,
    pub phase_name: Option<String>,
    /// `material` | `outsource` | `travel` | `other`.
    pub cost_type: String,
    pub vendor_id: Option<i64>,
    pub vendor_name: Option<String>,
    pub purchase_order_id: Option<i64>,
    pub description: Option<String>,
    /// 管理計上日 (the date the cost is counted on, spec §6.3).
    pub booked_on: String,
    /// Tax-exclusive yen.
    pub amount: i64,
    pub tax_kind: Option<String>,
    pub amount_in_tax: Option<i64>,
    pub voucher_no: Option<String>,
    pub reason: Option<String>,
    pub allocation_basis: Option<String>,
    pub allocations: Vec<AllocationLine>,
    /// `draft` | `submitted` | `approved` | `returned`.
    pub status: String,
    pub submitted_at: Option<String>,
    pub decided_by_name: Option<String>,
    pub decided_at: Option<String>,
    pub return_reason: Option<String>,
    /// The approved record that confirmed this provisional (仮計上の確定).
    pub confirmed_by: Option<i64>,
    /// Approved adjustments of this record (sum of the reductions).
    pub adjusted: i64,
    pub row_version: i64,
    pub updated_at: String,
}

impl DirectCost {
    /// The projects the record lands on: its project, or its allocations.
    pub fn projects(&self) -> Vec<i64> {
        match self.project_id {
            Some(p) => vec![p],
            None => self.allocations.iter().map(|a| a.project_id).collect(),
        }
    }

    /// What both wiring layers record: no amounts (the audit log is read by
    /// the system administrator, who does not see amounts by default).
    pub fn audit_detail(&self) -> serde_json::Value {
        serde_json::json!({
            "entryKind": self.entry_kind,
            "refId": self.ref_id,
            "projectId": self.project_id,
            "projects": self.projects(),
            "costType": self.cost_type,
            "bookedOn": self.booked_on,
            "purchaseOrderId": self.purchase_order_id,
            "status": self.status,
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationInput {
    pub project_id: i64,
    pub amount: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectCostInput {
    /// Create only (default `normal`); kept as it is on update.
    #[serde(default)]
    pub entry_kind: Option<String>,
    /// Create only: the approved record a `confirms` / `adjustment` refers to.
    #[serde(default)]
    pub ref_id: Option<i64>,
    #[serde(default)]
    pub adjustment_kind: Option<String>,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub phase_id: Option<i64>,
    #[serde(default)]
    pub cost_type: Option<String>,
    #[serde(default)]
    pub vendor_id: Option<i64>,
    #[serde(default)]
    pub purchase_order_id: Option<i64>,
    #[serde(default)]
    pub description: Option<String>,
    pub booked_on: String,
    pub amount: i64,
    #[serde(default)]
    pub tax_kind: Option<String>,
    #[serde(default)]
    pub amount_in_tax: Option<i64>,
    #[serde(default)]
    pub voucher_no: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub allocation_basis: Option<String>,
    #[serde(default)]
    pub allocations: Vec<AllocationInput>,
    /// Create only (T13).
    #[serde(default)]
    pub client_request_id: Option<String>,
    /// Required on update (T13).
    #[serde(default)]
    pub row_version: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectCostSaved {
    pub cost: DirectCost,
    /// A retried create that returned the row saved the first time.
    pub replayed: bool,
}

/// One change of a purchase order (amount revision or cancellation).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OrderChange {
    #[serde(skip)]
    pub purchase_order_id: i64,
    /// `amount` | `cancel`.
    pub kind: String,
    pub before_amount: i64,
    pub after_amount: i64,
    pub reason: String,
    pub created_by_name: Option<String>,
    pub created_at: String,
}

/// A purchase order with its remainder (未実績発注残).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrderView {
    pub id: i64,
    pub project_id: i64,
    pub vendor_id: Option<i64>,
    pub vendor_name: Option<String>,
    pub phase_id: Option<i64>,
    pub phase_name: Option<String>,
    pub cost_type: String,
    pub description: Option<String>,
    pub ordered_on: String,
    pub amount: i64,
    pub cancelled_amount: i64,
    /// Sum of the approved records that refer to the order.
    pub realized: i64,
    /// amount − cancelled − realized.
    pub remaining: i64,
    /// Not yet approved records that refer to the order (count, amount).
    pub pending_count: i64,
    pub pending_amount: i64,
    pub changes: Vec<OrderChange>,
    pub created_by: Option<i64>,
    pub created_by_name: Option<String>,
    pub row_version: i64,
    pub updated_at: String,
}

impl PurchaseOrderView {
    pub fn audit_detail(&self) -> serde_json::Value {
        serde_json::json!({
            "projectId": self.project_id,
            "costType": self.cost_type,
            "orderedOn": self.ordered_on,
            "changes": self.changes.len(),
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrderInput {
    /// Create only.
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub vendor_id: Option<i64>,
    #[serde(default)]
    pub phase_id: Option<i64>,
    /// Create only.
    #[serde(default)]
    pub cost_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub ordered_on: String,
    /// Create only; later changes go through [`OrderRevisionInput`].
    #[serde(default)]
    pub amount: Option<i64>,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub row_version: Option<i64>,
}

/// A revision of an order's amount, or a cancellation of part of it; both
/// keep their reason (spec §6.5: 見直し理由を残す).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderRevisionInput {
    /// `amount`: the new order amount. `cancel`: the amount to cancel.
    pub kind: String,
    pub amount: i64,
    #[serde(default)]
    pub reason: Option<String>,
    pub row_version: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrderSaved {
    pub order: PurchaseOrderView,
    pub replayed: bool,
}

/// Count and amount (件数と金額).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    pub count: i64,
    pub amount: i64,
}

/// Approved direct costs of one cost type.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostTypeAmount {
    pub cost_type: String,
    pub amount: i64,
}

/// One month of approved direct costs (管理計上日の月).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthCosts {
    pub month: String,
    pub period: i32,
    pub by_type: Vec<CostTypeAmount>,
    pub total: i64,
}

/// 案件詳細 → 直接費. Amounts: `ViewProjectAmounts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCosts {
    pub project_id: i64,
    /// Every record that lands on the project (any status), newest first. A
    /// split record shows only this project's share and allocation line.
    pub entries: Vec<DirectCost>,
    /// Approved actuals of the project by cost type (case累計).
    pub totals: Vec<CostTypeAmount>,
    pub total: i64,
    /// By month and fiscal period of the booked date (T15).
    pub months: Vec<MonthCosts>,
    /// Records waiting for approval or not yet submitted (this project's share).
    pub pending: Tally,
    /// Approved provisionals not yet confirmed (仮計上).
    pub provisional: Tally,
    /// Nothing pending and no provisional: the actuals are final.
    pub complete: bool,
    pub orders: Vec<PurchaseOrderView>,
    /// Sum of the orders' remainders (発注済み未実績).
    pub committed: i64,
}

/// What a completion forecast takes from the direct costs
/// ([`DirectCostsService::snapshot`]).
#[derive(Debug, Clone, PartialEq)]
pub struct CostSnapshot {
    /// Approved actuals booked up to the date, by phase × cost type.
    pub actual: Vec<(Option<i64>, CostType, i64)>,
    /// Every approved actual of the project, whatever its date (最新実績).
    pub latest_total: i64,
    /// Order remainders at the date, by phase × cost type (発注済み未実績).
    pub committed: Vec<(Option<i64>, CostType, i64)>,
    /// Records booked up to the date that are not approved yet.
    pub pending: i64,
    /// Approved provisionals booked up to the date and not confirmed.
    pub provisional: i64,
}

/// What the budget comparison takes from the direct costs.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectActuals {
    pub by_key: Vec<(Option<i64>, CostType, i64)>,
    /// Nothing pending and no provisional.
    pub complete: bool,
}

#[derive(sqlx::FromRow)]
struct CostRow {
    id: i64,
    user_id: i64,
    user_name: String,
    entry_kind: String,
    ref_id: Option<i64>,
    adjustment_kind: Option<String>,
    project_id: Option<i64>,
    project_code: Option<String>,
    project_name: Option<String>,
    phase_id: Option<i64>,
    phase_name: Option<String>,
    cost_type: String,
    vendor_id: Option<i64>,
    vendor_name: Option<String>,
    purchase_order_id: Option<i64>,
    description: Option<String>,
    booked_on: String,
    amount: i64,
    tax_kind: Option<String>,
    amount_in_tax: Option<i64>,
    voucher_no: Option<String>,
    reason: Option<String>,
    allocation_basis: Option<String>,
    status: String,
    submitted_at: Option<String>,
    decided_by_name: Option<String>,
    decided_at: Option<String>,
    return_reason: Option<String>,
    row_version: i64,
    updated_at: String,
}

const SELECT: &str = "SELECT c.id, c.user_id, u.display_name AS user_name, c.entry_kind, \
     c.ref_id, c.adjustment_kind, c.project_id, p.code AS project_code, p.name AS project_name, \
     c.phase_id, ph.name AS phase_name, c.cost_type, c.vendor_id, v.name AS vendor_name, \
     c.purchase_order_id, c.description, c.booked_on, c.amount, c.tax_kind, c.amount_in_tax, \
     c.voucher_no, c.reason, c.allocation_basis, c.status, c.submitted_at, \
     d.display_name AS decided_by_name, c.decided_at, c.return_reason, c.row_version, \
     c.updated_at FROM direct_costs c JOIN users u ON u.id = c.user_id \
     LEFT JOIN projects p ON p.id = c.project_id \
     LEFT JOIN phases ph ON ph.id = c.phase_id \
     LEFT JOIN vendors v ON v.id = c.vendor_id \
     LEFT JOIN users d ON d.id = c.decided_by";

/// The ledger columns of an approved record.
type LedgerRow = (
    i64,
    String,
    Option<i64>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    String,
    Option<i64>,
    String,
    i64,
);

const LEDGER_SQL: &str = "SELECT id, entry_kind, ref_id, adjustment_kind, project_id, phase_id, \
     cost_type, purchase_order_id, booked_on, amount FROM direct_costs \
     WHERE status = 'approved' ORDER BY id";
const LEDGER_ALLOC_SQL: &str = "SELECT a.direct_cost_id, a.project_id, a.amount \
     FROM cost_allocations a JOIN direct_costs c ON c.id = a.direct_cost_id \
     WHERE c.status = 'approved' ORDER BY a.direct_cost_id, a.line_no";

fn ledger_entry(r: &LedgerRow) -> Option<CostEntry> {
    let (id, kind, ref_id, adj, project, phase, cost_type, order, booked_on, amount) = r;
    let kind = match RecordKind::parse(kind)? {
        RecordKind::Normal => EntryKind::Normal,
        RecordKind::Provisional => EntryKind::Provisional,
        RecordKind::Confirms => EntryKind::Confirms {
            provisional_id: (*ref_id)?.to_string(),
        },
        RecordKind::Adjustment => EntryKind::Adjustment {
            corrects_id: (*ref_id)?.to_string(),
            kind: AdjustmentKind::parse(adj.as_deref()?)?,
        },
    };
    Some(CostEntry {
        id: id.to_string(),
        project: project.map(|p| p.to_string()),
        phase: *phase,
        purchase_order: order.map(|o| o.to_string()),
        cost_type: CostType::parse(cost_type)?,
        booked_on: Date::parse(booked_on)?,
        amount: *amount,
        kind,
    })
}

fn ledger_of(rows: &[LedgerRow], allocs: &[(i64, i64, i64)]) -> (Vec<CostEntry>, Vec<Allocation>) {
    (
        rows.iter().filter_map(ledger_entry).collect(),
        allocs
            .iter()
            .map(|(src, project, amount)| Allocation {
                source_id: src.to_string(),
                project: project.to_string(),
                amount: *amount,
            })
            .collect(),
    )
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

fn not_found(resource: &str, id: i64) -> BantoError {
    BantoError::NotFound {
        resource: resource.into(),
        id: id.to_string(),
    }
}

fn status_error(message: &str) -> BantoError {
    BantoError::Validation {
        field_errors: vec![field_error("status", message)],
    }
}

fn yen(v: i64) -> String {
    let s = v.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if v < 0 {
        format!("-{out}円")
    } else {
        format!("{out}円")
    }
}

fn issue_error(issue: &CostIssue) -> FieldError {
    match issue {
        CostIssue::LaborNotDirect => field_error(
            "costType",
            "労務費は工数から計算します。直接費には材料・外注・旅費・その他を選んでください",
        ),
        CostIssue::AmountNotPositive => field_error("amount", "1円以上で入力してください"),
        CostIssue::AmountNegative => field_error("amount", "0円以上で入力してください"),
        CostIssue::InTaxNegative => field_error("amountInTax", "0円以上で入力してください"),
        CostIssue::TargetRequired => {
            field_error("projectId", "案件を選ぶか、複数の案件に配分してください")
        }
        CostIssue::ProjectAndAllocations => field_error(
            "allocations",
            "案件を選んだ明細は配分しません。配分するときは案件を空にしてください",
        ),
        CostIssue::AllocationTooFew => {
            field_error("allocations", "配分は2つ以上の案件に分けてください")
        }
        CostIssue::TooManyAllocations => field_error(
            "allocations",
            format!("配分先は{MAX_ALLOCATIONS}件までにしてください"),
        ),
        CostIssue::AllocationNotPositive { index } => field_error(
            &format!("allocations.{index}.amount"),
            "1円以上で入力してください",
        ),
        CostIssue::AllocationDuplicate { index } => field_error(
            &format!("allocations.{index}.projectId"),
            "同じ案件が配分先に2回あります",
        ),
        CostIssue::AllocationMismatch { allocated, amount } => field_error(
            "allocations",
            format!(
                "配分の合計（{}）を金額（{}）に合わせてください",
                yen(*allocated),
                yen(*amount)
            ),
        ),
        CostIssue::AllocationNotNormal => {
            field_error("allocations", "仮計上・確定・調整は配分できません")
        }
        CostIssue::AllocationWithOrder => field_error(
            "allocations",
            "発注にひもづく明細は発注の案件に付けるため、配分できません",
        ),
        CostIssue::ReasonRequired => field_error("reason", "理由を入力してください"),
    }
}

fn approval_error(issue: &ApprovalIssue) -> FieldError {
    match issue {
        ApprovalIssue::ExceedsOrder { excess } => field_error(
            "purchaseOrderId",
            format!(
                "発注残を{}超えます。先に発注額を見直してください（理由を残します）",
                yen(*excess)
            ),
        ),
        ApprovalIssue::Ledger(LedgerIssue::AdjustmentExceedsOriginal { excess, .. }) => {
            field_error(
                "amount",
                format!("調整の合計が元の明細を{}超えます", yen(*excess)),
            )
        }
        ApprovalIssue::Ledger(LedgerIssue::ProvisionalConfirmedTwice { .. }) => {
            field_error("refId", "この仮計上はすでに確定しています")
        }
        ApprovalIssue::Ledger(LedgerIssue::InvalidTarget { .. }) => field_error(
            "refId",
            "この明細には付けられません（確定済みの仮計上は確定の明細を調整します）",
        ),
        ApprovalIssue::Ledger(LedgerIssue::UnknownReference { .. }) => {
            field_error("refId", "元の明細が承認済みではありません")
        }
        ApprovalIssue::Ledger(LedgerIssue::AllocationMismatch { .. }) => {
            field_error("allocations", "配分の合計が金額と一致しません")
        }
        ApprovalIssue::Ledger(other) => field_error(
            "status",
            format!("台帳の不整合のため承認できません（{other:?}）"),
        ),
    }
}

fn order_error(e: PurchaseError) -> FieldError {
    match e {
        PurchaseError::ExceedsOrder { excess } => {
            field_error("amount", format!("未実績の発注残を{}超えます", yen(excess)))
        }
        PurchaseError::BelowUsed { used } => field_error(
            "amount",
            format!(
                "取消済みと実績化済みの合計（{}）より小さくはできません",
                yen(used)
            ),
        ),
        PurchaseError::NotPositive | PurchaseError::NegativeAmount => {
            field_error("amount", "1円以上で入力してください")
        }
    }
}

fn parse_date(field: &str, value: &str) -> Result<Date, BantoError> {
    Date::parse(value.trim()).ok_or_else(|| BantoError::Validation {
        field_errors: vec![field_error(field, "日付は YYYY-MM-DD で入力してください")],
    })
}

fn text(errors: &mut Vec<FieldError>, field: &str, value: &Option<String>) -> Option<String> {
    let v = clean_optional(value);
    if v.as_deref()
        .is_some_and(|s| s.chars().count() > MAX_TEXT_LEN)
    {
        errors.push(field_error(
            field,
            format!("{MAX_TEXT_LEN}文字以内で入力してください"),
        ));
    }
    v
}

fn direct_type(errors: &mut Vec<FieldError>, value: Option<&str>) -> Option<CostType> {
    match value.map(str::trim).filter(|s| !s.is_empty()) {
        None => {
            errors.push(field_error("costType", "費目を選んでください"));
            None
        }
        Some(s) => match CostType::parse(s) {
            Some(t) => Some(t),
            None => {
                errors.push(field_error("costType", "不明な費目です"));
                None
            }
        },
    }
}

/// Validated input, ready to store.
#[derive(Debug, Clone)]
struct Resolved {
    kind: RecordKind,
    ref_id: Option<i64>,
    adjustment_kind: Option<AdjustmentKind>,
    project_id: Option<i64>,
    phase_id: Option<i64>,
    cost_type: CostType,
    vendor_id: Option<i64>,
    purchase_order_id: Option<i64>,
    description: Option<String>,
    booked_on: Date,
    amount: i64,
    tax_kind: Option<TaxKind>,
    amount_in_tax: Option<i64>,
    voucher_no: Option<String>,
    reason: Option<String>,
    allocation_basis: Option<String>,
    allocations: Vec<(i64, i64)>,
    request_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct OrderRow {
    id: i64,
    project_id: i64,
    vendor_id: Option<i64>,
    vendor_name: Option<String>,
    phase_id: Option<i64>,
    phase_name: Option<String>,
    cost_type: String,
    description: Option<String>,
    ordered_on: String,
    amount: i64,
    cancelled_amount: i64,
    created_by: Option<i64>,
    created_by_name: Option<String>,
    row_version: i64,
    updated_at: String,
}

const ORDER_SELECT: &str = "SELECT o.id, o.project_id, o.vendor_id, v.name AS vendor_name, \
     o.phase_id, ph.name AS phase_name, o.cost_type, o.description, o.ordered_on, o.amount, \
     o.cancelled_amount, o.created_by, u.display_name AS created_by_name, o.row_version, \
     o.updated_at FROM purchase_orders o \
     LEFT JOIN vendors v ON v.id = o.vendor_id \
     LEFT JOIN phases ph ON ph.id = o.phase_id \
     LEFT JOIN users u ON u.id = o.created_by";

#[derive(Clone)]
pub struct DirectCostsService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl DirectCostsService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    /// Emit `ResourceChanged` (`direct_costs` / `purchase_orders`) after each
    /// committed write, as the other business services do.
    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn notify(&self, resource: &str) {
        crate::events::notify_changed(&self.events, resource);
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    fn now(&self) -> &'static str {
        now_expr(self.db.dialect())
    }

    fn is_postgres(&self) -> bool {
        self.db.dialect() == Dialect::Postgres
    }

    // --- reads ------------------------------------------------------------

    async fn views(&self, rows: Vec<CostRow>) -> Result<Vec<DirectCost>, BantoError> {
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        let marks = vec!["?"; ids.len()].join(",");
        let alloc_sql = self.sql(&format!(
            "SELECT a.direct_cost_id, a.project_id, p.code, p.name, a.amount \
             FROM cost_allocations a JOIN projects p ON p.id = a.project_id \
             WHERE a.direct_cost_id IN ({marks}) ORDER BY a.direct_cost_id, a.line_no"
        ));
        let refs_sql = self.sql(&format!(
            "SELECT ref_id, id, entry_kind, amount FROM direct_costs \
             WHERE status = 'approved' AND ref_id IN ({marks})"
        ));
        type AllocRow = (i64, i64, String, String, i64);
        type RefRow = (i64, i64, String, i64);
        let (allocs, refs): (Vec<AllocRow>, Vec<RefRow>) = match &self.db {
            Db::Sqlite(pool) => {
                let mut a = sqlx::query_as(sqlx::AssertSqlSafe(alloc_sql.as_str()));
                let mut r = sqlx::query_as(sqlx::AssertSqlSafe(refs_sql.as_str()));
                for id in &ids {
                    a = a.bind(*id);
                    r = r.bind(*id);
                }
                (
                    a.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                    r.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                )
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut a = sqlx::query_as(sqlx::AssertSqlSafe(alloc_sql.as_str()));
                let mut r = sqlx::query_as(sqlx::AssertSqlSafe(refs_sql.as_str()));
                for id in &ids {
                    a = a.bind(*id);
                    r = r.bind(*id);
                }
                (
                    a.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                    r.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                )
            }
        };
        let mut by_cost: BTreeMap<i64, Vec<AllocationLine>> = BTreeMap::new();
        for (cost, project_id, code, name, amount) in allocs {
            by_cost.entry(cost).or_default().push(AllocationLine {
                project_id,
                project_code: code,
                project_name: name,
                amount,
            });
        }
        Ok(rows
            .into_iter()
            .map(|r| {
                let confirmed_by = refs
                    .iter()
                    .find(|(t, _, k, _)| *t == r.id && k == "confirms")
                    .map(|(_, id, _, _)| *id);
                let adjusted = refs
                    .iter()
                    .filter(|(t, _, k, _)| *t == r.id && k == "adjustment")
                    .map(|(_, _, _, a)| *a)
                    .sum();
                DirectCost {
                    allocations: by_cost.remove(&r.id).unwrap_or_default(),
                    confirmed_by,
                    adjusted,
                    id: r.id,
                    user_id: r.user_id,
                    user_name: r.user_name,
                    entry_kind: r.entry_kind,
                    ref_id: r.ref_id,
                    adjustment_kind: r.adjustment_kind,
                    project_id: r.project_id,
                    project_code: r.project_code,
                    project_name: r.project_name,
                    phase_id: r.phase_id,
                    phase_name: r.phase_name,
                    cost_type: r.cost_type,
                    vendor_id: r.vendor_id,
                    vendor_name: r.vendor_name,
                    purchase_order_id: r.purchase_order_id,
                    description: r.description,
                    booked_on: r.booked_on,
                    amount: r.amount,
                    tax_kind: r.tax_kind,
                    amount_in_tax: r.amount_in_tax,
                    voucher_no: r.voucher_no,
                    reason: r.reason,
                    allocation_basis: r.allocation_basis,
                    status: r.status,
                    submitted_at: r.submitted_at,
                    decided_by_name: r.decided_by_name,
                    decided_at: r.decided_at,
                    return_reason: r.return_reason,
                    row_version: r.row_version,
                    updated_at: r.updated_at,
                }
            })
            .collect())
    }

    /// One record (any owner). The wiring authorizes against its projects.
    pub async fn get(&self, id: i64) -> Result<DirectCost, BantoError> {
        let sql = self.sql(&format!("{SELECT} WHERE c.id = ?"));
        let row: Option<CostRow> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        let row = row.ok_or_else(|| not_found(RESOURCE, id))?;
        Ok(self.views(vec![row]).await?.remove(0))
    }

    async fn own(&self, user_id: i64, id: i64) -> Result<DirectCost, BantoError> {
        let cost = self.get(id).await?;
        if cost.user_id != user_id {
            return Err(not_found(RESOURCE, id));
        }
        Ok(cost)
    }

    /// The person's records booked from `from` to `to` (both inclusive, at
    /// most [`MAX_RANGE_DAYS`] apart), oldest first.
    pub async fn list_own(
        &self,
        user_id: i64,
        from: &str,
        to: &str,
    ) -> Result<Vec<DirectCost>, BantoError> {
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
            "{SELECT} WHERE c.user_id = ? AND c.booked_on >= ? AND c.booked_on <= ? \
             ORDER BY c.booked_on, c.id"
        ));
        let (f, t) = (from_d.to_string(), to_d.to_string());
        let rows: Vec<CostRow> =
            on_pool!(&self.db, pool => fetch_all!(pool, sql, user_id, &f, &t))?;
        self.views(rows).await
    }

    /// Submitted records whose every project is in `scope`.
    pub async fn approvals(&self, scope: &ProjectScope) -> Result<Vec<DirectCost>, BantoError> {
        let sql = format!("{SELECT} WHERE c.status = 'submitted' ORDER BY c.booked_on, c.id");
        let rows: Vec<CostRow> = on_pool!(&self.db, pool => fetch_all!(pool, sql))?;
        Ok(self
            .views(rows)
            .await?
            .into_iter()
            .filter(|c| {
                let projects = c.projects();
                !projects.is_empty() && projects.iter().all(|p| scope.contains(*p))
            })
            .collect())
    }

    /// The projects an input lands on, for the wiring's `EnterCost` check:
    /// the referred record's (confirm / adjustment), the order's, the
    /// project, or the allocations. Unknown references are left to the
    /// service's own checks (an empty list means nothing to authorize yet).
    pub async fn input_projects(
        &self,
        input: &DirectCostInput,
        kept: Option<&DirectCost>,
    ) -> Result<Vec<i64>, BantoError> {
        let ref_id = kept.and_then(|k| k.ref_id).or(input.ref_id);
        let is_refers = kept.map(|k| k.ref_id.is_some()).unwrap_or_else(|| {
            input
                .entry_kind
                .as_deref()
                .and_then(RecordKind::parse)
                .is_some_and(RecordKind::refers)
        });
        if is_refers {
            if let Some(r) = ref_id {
                return match self.get(r).await {
                    Ok(target) => Ok(target.projects()),
                    Err(BantoError::NotFound { .. }) => Ok(Vec::new()),
                    Err(e) => Err(e),
                };
            }
            return Ok(Vec::new());
        }
        if let Some(o) = input.purchase_order_id {
            return match self.order_row(o).await {
                Ok(order) => Ok(vec![order.project_id]),
                Err(BantoError::NotFound { .. }) => Ok(input.project_id.into_iter().collect()),
                Err(e) => Err(e),
            };
        }
        Ok(match input.project_id {
            Some(p) => vec![p],
            None => input.allocations.iter().map(|a| a.project_id).collect(),
        })
    }

    /// The project exists and is not settled (精算完了 closes it for costs).
    async fn require_open_project(&self, project_id: i64, field: &str) -> Result<(), BantoError> {
        let sql = self.sql("SELECT status FROM projects WHERE id = ?");
        let row: Option<(String,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))?;
        match row {
            None => Err(BantoError::Validation {
                field_errors: vec![field_error(field, "見つかりません")],
            }),
            Some((status,)) if status == "settled" => Err(BantoError::Validation {
                field_errors: vec![field_error(
                    field,
                    "精算完了の案件には直接費・発注を登録できません",
                )],
            }),
            Some(_) => Ok(()),
        }
    }

    /// Check the input against the referred record, the order, the masters
    /// and the projects. `kept` is the record being corrected (its kind and
    /// reference stay; masters it already carries stay usable after being
    /// discontinued).
    async fn resolve(
        &self,
        input: &DirectCostInput,
        kept: Option<&DirectCost>,
    ) -> Result<Resolved, BantoError> {
        let mut errors = Vec::new();
        let kind = match kept {
            Some(k) => RecordKind::parse(&k.entry_kind)
                .ok_or_else(|| BantoError::Other(format!("不明な種類です: {}", k.entry_kind)))?,
            None => match clean_optional(&input.entry_kind) {
                None => RecordKind::Normal,
                Some(s) => match RecordKind::parse(&s) {
                    Some(k) => k,
                    None => {
                        errors.push(field_error("entryKind", "不明な種類です"));
                        RecordKind::Normal
                    }
                },
            },
        };
        let ref_id = match kept {
            Some(k) => k.ref_id,
            None => input.ref_id,
        };
        let adjustment_kind = if kind == RecordKind::Adjustment {
            match clean_optional(&input.adjustment_kind)
                .as_deref()
                .map(AdjustmentKind::parse)
            {
                Some(Some(a)) => Some(a),
                _ => {
                    errors.push(field_error(
                        "adjustmentKind",
                        "返品・取消・値引きのどれかを選んでください",
                    ));
                    None
                }
            }
        } else {
            None
        };
        let booked_on = Date::parse(input.booked_on.trim());
        if booked_on.is_none() {
            errors.push(field_error(
                "bookedOn",
                "日付は YYYY-MM-DD で入力してください",
            ));
        }
        let tax_kind = match clean_optional(&input.tax_kind) {
            None => None,
            Some(s) => match TaxKind::parse(&s) {
                Some(t) => Some(t),
                None => {
                    errors.push(field_error("taxKind", "不明な税区分です"));
                    None
                }
            },
        };
        let description = text(&mut errors, "description", &input.description);
        let voucher_no = text(&mut errors, "voucherNo", &input.voucher_no);
        let reason = text(&mut errors, "reason", &input.reason);
        let allocation_basis = text(&mut errors, "allocationBasis", &input.allocation_basis);
        let request_id = clean_optional(&input.client_request_id);
        if request_id
            .as_deref()
            .is_some_and(|r| r.chars().count() > MAX_REQUEST_ID_LEN)
        {
            errors.push(field_error("clientRequestId", "長すぎます"));
        }

        // Where the cost lands: the referred record, the order, or the input.
        let (project_id, phase_id, cost_type, vendor_id, purchase_order_id, allocations) = if kind
            .refers()
        {
            let Some(target_id) = ref_id else {
                errors.push(field_error("refId", "元の明細を選んでください"));
                validation(errors)?;
                unreachable!("an error was pushed");
            };
            let target = match self.get(target_id).await {
                Ok(t) => t,
                Err(BantoError::NotFound { .. }) => {
                    errors.push(field_error("refId", "見つかりません"));
                    validation(errors)?;
                    unreachable!("an error was pushed");
                }
                Err(e) => return Err(e),
            };
            let target_kind = RecordKind::parse(&target.entry_kind);
            if target.status != "approved" {
                errors.push(field_error("refId", "承認済みの明細にだけ付けられます"));
            } else if kind == RecordKind::Confirms && target_kind != Some(RecordKind::Provisional) {
                errors.push(field_error("refId", "確定できるのは仮計上の明細だけです"));
            } else if kind == RecordKind::Confirms && target.confirmed_by.is_some() {
                errors.push(field_error("refId", "この仮計上はすでに確定しています"));
            } else if kind == RecordKind::Adjustment && target_kind == Some(RecordKind::Adjustment)
            {
                errors.push(field_error("refId", "調整の明細はさらに調整できません"));
            } else if kind == RecordKind::Adjustment && target.confirmed_by.is_some() {
                errors.push(field_error(
                    "refId",
                    "確定済みの仮計上は調整できません。確定の明細を調整してください",
                ));
            } else if target.project_id.is_none() {
                errors.push(field_error(
                    "refId",
                    "配分した明細は調整できません。取消してから配分し直してください",
                ));
            }
            let cost_type = CostType::parse(&target.cost_type).unwrap_or(CostType::Other);
            (
                target.project_id,
                target.phase_id,
                Some(cost_type),
                target.vendor_id,
                target.purchase_order_id,
                Vec::new(),
            )
        } else if let Some(order_id) = input.purchase_order_id {
            match self.order_row(order_id).await {
                Ok(order) => {
                    if input.project_id.is_some_and(|p| p != order.project_id) {
                        errors.push(field_error(
                            "purchaseOrderId",
                            "発注の案件と違う案件には付けられません",
                        ));
                    }
                    let order_type = CostType::parse(&order.cost_type);
                    let wanted = clean_optional(&input.cost_type);
                    if wanted
                        .as_deref()
                        .is_some_and(|w| Some(w) != order_type.map(CostType::as_str))
                    {
                        errors.push(field_error(
                            "costType",
                            "発注の費目と同じ費目にしてください",
                        ));
                    }
                    (
                        Some(order.project_id),
                        input.phase_id.or(order.phase_id),
                        order_type,
                        input.vendor_id.or(order.vendor_id),
                        Some(order_id),
                        input
                            .allocations
                            .iter()
                            .map(|a| (a.project_id, a.amount))
                            .collect(),
                    )
                }
                Err(BantoError::NotFound { .. }) => {
                    errors.push(field_error("purchaseOrderId", "見つかりません"));
                    validation(errors)?;
                    unreachable!("an error was pushed");
                }
                Err(e) => return Err(e),
            }
        } else {
            (
                input.project_id,
                input.phase_id,
                direct_type(&mut errors, input.cost_type.as_deref()),
                input.vendor_id,
                None,
                input
                    .allocations
                    .iter()
                    .map(|a| (a.project_id, a.amount))
                    .collect(),
            )
        };
        validation(errors)?;
        let cost_type = cost_type.expect("checked above");
        let domain = CostInput {
            kind,
            project: project_id,
            cost_type,
            amount: input.amount,
            amount_in_tax: input.amount_in_tax,
            purchase_order: purchase_order_id,
            allocations: allocations.clone(),
            has_reason: reason.is_some(),
        };
        check_input(&domain).map_err(|issues| BantoError::Validation {
            field_errors: issues.iter().map(issue_error).collect(),
        })?;

        // Masters and projects (a reference's own values are not re-checked).
        let masters = WorkMastersService::new(self.db.clone());
        if !kind.refers() {
            if let Some(phase) = phase_id.filter(|p| !kept.is_some_and(|k| k.phase_id == Some(*p)))
            {
                masters
                    .require_active(MasterKind::Phases, phase, "phaseId")
                    .await?;
            }
            if let Some(vendor) =
                vendor_id.filter(|v| !kept.is_some_and(|k| k.vendor_id == Some(*v)))
            {
                masters
                    .require_active(MasterKind::Vendors, vendor, "vendorId")
                    .await?;
            }
        }
        match project_id {
            Some(p) => self.require_open_project(p, "projectId").await?,
            None => {
                for (index, (p, _)) in allocations.iter().enumerate() {
                    self.require_open_project(*p, &format!("allocations.{index}.projectId"))
                        .await?;
                }
            }
        }
        Ok(Resolved {
            kind,
            ref_id: if kind.refers() { ref_id } else { None },
            adjustment_kind,
            project_id,
            phase_id,
            cost_type,
            vendor_id,
            purchase_order_id,
            description,
            booked_on: booked_on.expect("checked above"),
            amount: input.amount,
            tax_kind,
            amount_in_tax: input.amount_in_tax,
            voucher_no,
            reason,
            allocation_basis,
            allocations,
            request_id,
        })
    }

    async fn by_request(&self, user_id: i64, request_id: &str) -> Result<Option<i64>, BantoError> {
        let sql =
            self.sql("SELECT id FROM direct_costs WHERE user_id = ? AND client_request_id = ?");
        let row: Option<(i64,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, user_id, request_id))?;
        Ok(row.map(|(id,)| id))
    }

    async fn replayed(&self, id: i64) -> Result<DirectCostSaved, BantoError> {
        Ok(DirectCostSaved {
            cost: self.get(id).await?,
            replayed: true,
        })
    }

    /// Record a draft for `user_id`.
    pub async fn create(
        &self,
        user_id: i64,
        input: DirectCostInput,
    ) -> Result<DirectCostSaved, BantoError> {
        if let Some(rid) = clean_optional(&input.client_request_id) {
            if let Some(id) = self.by_request(user_id, &rid).await? {
                return self.replayed(id).await;
            }
        }
        let r = self.resolve(&input, None).await?;
        let insert = self.sql(
            "INSERT INTO direct_costs (user_id, entry_kind, ref_id, adjustment_kind, project_id, \
             phase_id, cost_type, vendor_id, purchase_order_id, description, booked_on, amount, \
             tax_kind, amount_in_tax, voucher_no, reason, allocation_basis, status, \
             client_request_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?) RETURNING id",
        );
        let alloc = self.sql(
            "INSERT INTO cost_allocations (direct_cost_id, line_no, project_id, amount) \
             VALUES (?, ?, ?, ?)",
        );
        let date = r.booked_on.to_string();
        let result: Result<i64, BantoError> = async {
            Ok(in_tx!(&self.db, tx => {
                let id: i64 = scalar!(&mut *tx, insert, user_id, r.kind.as_str(), r.ref_id,
                    r.adjustment_kind.map(AdjustmentKind::as_str), r.project_id, r.phase_id,
                    r.cost_type.as_str(), r.vendor_id, r.purchase_order_id, &r.description,
                    &date, r.amount, r.tax_kind.map(TaxKind::as_str), r.amount_in_tax,
                    &r.voucher_no, &r.reason, &r.allocation_basis, &r.request_id)?;
                for (n, (project, amount)) in r.allocations.iter().enumerate() {
                    execute!(&mut *tx, alloc, id, n as i64 + 1, *project, *amount)?;
                }
                id
            }))
        }
        .await;
        let id = match result {
            Ok(id) => id,
            // A concurrent retry with the same request id committed first.
            Err(BantoError::Storage(m)) if m.to_lowercase().contains("unique") => {
                if let Some(rid) = &r.request_id {
                    if let Some(id) = self.by_request(user_id, rid).await? {
                        return self.replayed(id).await;
                    }
                }
                return Err(BantoError::Storage(m));
            }
            Err(e) => return Err(e),
        };
        self.notify(RESOURCE);
        Ok(DirectCostSaved {
            cost: self.get(id).await?,
            replayed: false,
        })
    }

    /// The owner's editable record with the version they read.
    pub async fn editable(
        &self,
        user_id: i64,
        id: i64,
        row_version: Option<i64>,
    ) -> Result<DirectCost, BantoError> {
        let cost = self.own(user_id, id).await?;
        if !TimeStatus::parse(&cost.status).is_some_and(TimeStatus::is_editable) {
            return Err(status_error("申請中・承認済みの直接費は変更できません"));
        }
        if row_version != Some(cost.row_version) {
            return Err(stale_version_error());
        }
        Ok(cost)
    }

    /// Change a draft or returned record of `user_id`.
    pub async fn update(
        &self,
        user_id: i64,
        id: i64,
        input: DirectCostInput,
    ) -> Result<DirectCostSaved, BantoError> {
        let cost = self.editable(user_id, id, input.row_version).await?;
        let r = self.resolve(&input, Some(&cost)).await?;
        let update = self.sql(&format!(
            "UPDATE direct_costs SET adjustment_kind = ?, project_id = ?, phase_id = ?, \
             cost_type = ?, vendor_id = ?, purchase_order_id = ?, description = ?, \
             booked_on = ?, amount = ?, tax_kind = ?, amount_in_tax = ?, voucher_no = ?, \
             reason = ?, allocation_basis = ?, row_version = row_version + 1, updated_at = {} \
             WHERE id = ? AND row_version = ? AND status IN ('draft','returned')",
            self.now()
        ));
        let clear = self.sql("DELETE FROM cost_allocations WHERE direct_cost_id = ?");
        let alloc = self.sql(
            "INSERT INTO cost_allocations (direct_cost_id, line_no, project_id, amount) \
             VALUES (?, ?, ?, ?)",
        );
        let date = r.booked_on.to_string();
        let version = cost.row_version;
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, update, r.adjustment_kind.map(AdjustmentKind::as_str),
                r.project_id, r.phase_id, r.cost_type.as_str(), r.vendor_id,
                r.purchase_order_id, &r.description, &date, r.amount,
                r.tax_kind.map(TaxKind::as_str), r.amount_in_tax, &r.voucher_no, &r.reason,
                &r.allocation_basis, id, version)? == 0
            {
                return Err(stale_version_error());
            }
            execute!(&mut *tx, clear, id)?;
            for (n, (project, amount)) in r.allocations.iter().enumerate() {
                execute!(&mut *tx, alloc, id, n as i64 + 1, *project, *amount)?;
            }
        });
        self.notify(RESOURCE);
        Ok(DirectCostSaved {
            cost: self.get(id).await?,
            replayed: false,
        })
    }

    /// Delete a draft or returned record of `user_id` (never an approved one).
    pub async fn delete(&self, user_id: i64, id: i64, row_version: i64) -> Result<(), BantoError> {
        self.editable(user_id, id, Some(row_version)).await?;
        let allocs = self.sql("DELETE FROM cost_allocations WHERE direct_cost_id = ?");
        let sql = self.sql(
            "DELETE FROM direct_costs WHERE id = ? AND row_version = ? \
             AND status IN ('draft','returned')",
        );
        in_tx!(&self.db, tx => {
            execute!(&mut *tx, allocs, id)?;
            if execute!(&mut *tx, sql, id, row_version)? == 0 {
                return Err(stale_version_error());
            }
        });
        self.notify(RESOURCE);
        Ok(())
    }

    /// Submit a draft or returned record of `user_id` (申請).
    pub async fn submit(
        &self,
        user_id: i64,
        id: i64,
        row_version: i64,
    ) -> Result<DirectCost, BantoError> {
        let cost = self.editable(user_id, id, Some(row_version)).await?;
        for p in cost.projects() {
            self.require_open_project(p, "projectId").await?;
        }
        let sql = self.sql(&format!(
            "UPDATE direct_costs SET status = 'submitted', submitted_at = {now}, \
             row_version = row_version + 1, updated_at = {now} \
             WHERE id = ? AND row_version = ? AND status IN ('draft','returned')",
            now = self.now()
        ));
        if on_pool!(&self.db, pool => execute!(pool, sql, id, row_version))? == 0 {
            return Err(stale_version_error());
        }
        self.notify(RESOURCE);
        self.get(id).await
    }

    /// Approve or return a submitted record. `authorized` is the row the
    /// caller was authorized against; a row changed afterwards is refused as
    /// stale. Approval re-checks the approved ledger with the record added
    /// (adjustments within the original, one confirmation per provisional,
    /// allocations) and the order's remainder (T05, T10, T14).
    pub async fn decide(
        &self,
        authorized: &DirectCost,
        input: DecisionInput,
        actor_user_id: Option<i64>,
    ) -> Result<DirectCost, BantoError> {
        let id = authorized.id;
        let cost = self.get(id).await?;
        if !TimeStatus::parse(&cost.status).is_some_and(TimeStatus::is_decidable) {
            return Err(status_error("申請中の直接費だけを承認・差戻しできます"));
        }
        if input.row_version != authorized.row_version || cost.row_version != authorized.row_version
        {
            return Err(stale_version_error());
        }
        if !input.approve {
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
                "UPDATE direct_costs SET status = 'returned', return_reason = ?, \
                 decided_by = ?, decided_at = {now}, row_version = row_version + 1, \
                 updated_at = {now} WHERE id = ? AND row_version = ? AND status = 'submitted'",
                now = self.now()
            ));
            if on_pool!(&self.db, pool => execute!(pool, sql, &reason, actor_user_id, id,
                input.row_version))?
                == 0
            {
                return Err(stale_version_error());
            }
            self.notify(RESOURCE);
            return self.get(id).await;
        }

        for p in cost.projects() {
            self.require_open_project(p, "projectId").await?;
        }
        let candidate_row: LedgerRow = (
            cost.id,
            cost.entry_kind.clone(),
            cost.ref_id,
            cost.adjustment_kind.clone(),
            cost.project_id,
            cost.phase_id,
            cost.cost_type.clone(),
            cost.purchase_order_id,
            cost.booked_on.clone(),
            cost.amount,
        );
        let candidate = ledger_entry(&candidate_row)
            .ok_or_else(|| BantoError::Other(format!("直接費 {id} を台帳に変換できません")))?;
        let candidate_allocs: Vec<Allocation> = cost
            .allocations
            .iter()
            .map(|a| Allocation {
                source_id: id.to_string(),
                project: a.project_id.to_string(),
                amount: a.amount,
            })
            .collect();
        let order_id = cost.purchase_order_id;
        let order_sql =
            self.sql("SELECT amount, cancelled_amount FROM purchase_orders WHERE id = ?");
        let lock_order = self
            .is_postgres()
            .then(|| self.sql("SELECT id FROM purchase_orders WHERE id = ? FOR UPDATE"));
        let lock_ref = self
            .is_postgres()
            .then(|| self.sql("SELECT id FROM direct_costs WHERE id = ? FOR UPDATE"));
        let approve = self.sql(&format!(
            "UPDATE direct_costs SET status = 'approved', decided_by = ?, decided_at = {now}, \
             return_reason = NULL, row_version = row_version + 1, updated_at = {now} \
             WHERE id = ? AND row_version = ? AND status = 'submitted'",
            now = self.now()
        ));
        let ledger_sql = LEDGER_SQL.to_string();
        let alloc_sql = LEDGER_ALLOC_SQL.to_string();
        let ref_id = cost.ref_id;
        let result: Result<(), BantoError> = async {
            in_tx!(&self.db, tx => {
                if let (Some(lock), Some(o)) = (&lock_order, order_id) {
                    let _: Vec<(i64,)> = fetch_all!(&mut *tx, lock, o)?;
                }
                if let (Some(lock), Some(r)) = (&lock_ref, ref_id) {
                    let _: Vec<(i64,)> = fetch_all!(&mut *tx, lock, r)?;
                }
                if execute!(&mut *tx, approve, actor_user_id, id, input.row_version)? == 0 {
                    return Err(stale_version_error());
                }
                let rows: Vec<LedgerRow> = fetch_all!(&mut *tx, ledger_sql)?;
                let allocs: Vec<(i64, i64, i64)> = fetch_all!(&mut *tx, alloc_sql)?;
                let others: Vec<LedgerRow> = rows.into_iter().filter(|r| r.0 != id).collect();
                let other_allocs: Vec<(i64, i64, i64)> =
                    allocs.into_iter().filter(|a| a.0 != id).collect();
                let (entries, allocations) = ledger_of(&others, &other_allocs);
                // The order the record (or its original) realizes.
                let terms = match order_id {
                    Some(o) => {
                        let t: Option<(i64, i64)> = fetch_optional!(&mut *tx, order_sql, o)?;
                        t.map(|(amount, cancelled)| (o.to_string(), OrderTerms { amount, cancelled }))
                    }
                    None => None,
                };
                check_approval(
                    &entries,
                    &allocations,
                    candidate.clone(),
                    &candidate_allocs,
                    terms.as_ref().map(|(o, t)| (o.as_str(), *t)),
                )
                .map_err(|issues| BantoError::Validation {
                    field_errors: issues.iter().map(approval_error).collect(),
                })?;
            });
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {}
            // A concurrent approval confirmed the same provisional first.
            Err(BantoError::Storage(m)) if m.to_lowercase().contains("unique") => {
                return Err(BantoError::Validation {
                    field_errors: vec![field_error("refId", "この仮計上はすでに確定しています")],
                });
            }
            Err(e) => return Err(e),
        }
        self.notify(RESOURCE);
        self.get(id).await
    }

    /// Every approved record as ledger postings (company-wide).
    pub async fn postings(&self) -> Result<Vec<Posting>, BantoError> {
        let sql = LEDGER_SQL.to_string();
        let asql = LEDGER_ALLOC_SQL.to_string();
        let rows: Vec<LedgerRow> = on_pool!(&self.db, pool => fetch_all!(pool, sql))?;
        let allocs: Vec<(i64, i64, i64)> = on_pool!(&self.db, pool => fetch_all!(pool, asql))?;
        let (entries, allocations) = ledger_of(&rows, &allocs);
        ledger::postings(&entries, &allocations).map_err(|issues| {
            BantoError::Other(format!("直接費の台帳に不整合があります: {issues:?}"))
        })
    }

    /// The ledger as it stood on `until`: approved records booked up to then,
    /// resolved among themselves. A confirmation or an adjustment booked
    /// later is left out with its effect, so a provisional confirmed after
    /// the date still counts as the provisional it was (spec §6.6: the
    /// forecast's actuals are those of its base date).
    pub async fn postings_until(&self, until: Date) -> Result<Vec<Posting>, BantoError> {
        let sql = LEDGER_SQL.to_string();
        let asql = LEDGER_ALLOC_SQL.to_string();
        let rows: Vec<LedgerRow> = on_pool!(&self.db, pool => fetch_all!(pool, sql))?;
        let allocs: Vec<(i64, i64, i64)> = on_pool!(&self.db, pool => fetch_all!(pool, asql))?;
        let rows: Vec<LedgerRow> = rows
            .into_iter()
            .filter(|r| Date::parse(&r.8).is_some_and(|d| d <= until))
            .collect();
        let kept: std::collections::BTreeSet<i64> = rows.iter().map(|r| r.0).collect();
        // A reference to a record booked after the date (not a valid
        // ledger) is dropped rather than failing the whole read.
        let rows: Vec<LedgerRow> = rows
            .into_iter()
            .filter(|r| r.2.is_none_or(|target| kept.contains(&target)))
            .collect();
        let kept: std::collections::BTreeSet<i64> = rows.iter().map(|r| r.0).collect();
        let allocs: Vec<(i64, i64, i64)> = allocs
            .into_iter()
            .filter(|(src, _, _)| kept.contains(src))
            .collect();
        let (entries, allocations) = ledger_of(&rows, &allocs);
        ledger::postings(&entries, &allocations).map_err(|issues| {
            BantoError::Other(format!("直接費の台帳に不整合があります: {issues:?}"))
        })
    }

    /// Pending (not approved) and provisional tallies of a project.
    async fn tallies(&self, project_id: i64) -> Result<(Tally, Tally), BantoError> {
        let pending_sql = self.sql(
            "SELECT CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(amount), 0) AS BIGINT) \
             FROM direct_costs WHERE project_id = ? AND status <> 'approved'",
        );
        let pending_alloc_sql = self.sql(
            "SELECT CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(a.amount), 0) AS BIGINT) \
             FROM cost_allocations a JOIN direct_costs c ON c.id = a.direct_cost_id \
             WHERE a.project_id = ? AND c.status <> 'approved'",
        );
        let provisional_sql = self.sql(
            "SELECT CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(p.amount), 0) AS BIGINT) \
             FROM direct_costs p WHERE p.project_id = ? AND p.status = 'approved' \
             AND p.entry_kind = 'provisional' AND NOT EXISTS (SELECT 1 FROM direct_costs f \
             WHERE f.ref_id = p.id AND f.entry_kind = 'confirms' AND f.status = 'approved')",
        );
        let (a, b): (i64, i64) =
            on_pool!(&self.db, pool => fetch_optional!(pool, pending_sql, project_id))?
                .unwrap_or((0, 0));
        let (c, d): (i64, i64) =
            on_pool!(&self.db, pool => fetch_optional!(pool, pending_alloc_sql, project_id))?
                .unwrap_or((0, 0));
        let (e, f): (i64, i64) =
            on_pool!(&self.db, pool => fetch_optional!(pool, provisional_sql, project_id))?
                .unwrap_or((0, 0));
        Ok((
            Tally {
                count: a + c,
                amount: b + d,
            },
            Tally {
                count: e,
                amount: f,
            },
        ))
    }

    /// What the budget comparison needs: approved actuals by phase × cost
    /// type, and whether they are final.
    pub async fn project_actuals(&self, project_id: i64) -> Result<ProjectActuals, BantoError> {
        let postings = self.postings().await?;
        let (pending, provisional) = self.tallies(project_id).await?;
        Ok(ProjectActuals {
            by_key: project_actuals(&postings, &project_id.to_string()),
            complete: pending.count == 0 && provisional.count == 0,
        })
    }

    /// What a completion forecast takes from the direct costs as of `until`
    /// (its base date, spec §6.6): approved actuals booked up to then, each
    /// order's remainder at that date (orders placed by then; realized by
    /// records booked by then; the amount and cancellation as they stand),
    /// and whether records up to then wait for approval or are provisional.
    /// `postings` is [`Self::postings`] (read once by the caller).
    pub async fn snapshot(
        &self,
        project_id: i64,
        until: Date,
        postings: &[Posting],
    ) -> Result<CostSnapshot, BantoError> {
        let until_postings = self.postings_until(until).await?;
        let key = project_id.to_string();
        let orders = self.orders_of(project_id, &until_postings).await?;
        let mut committed: Vec<(Option<i64>, CostType, i64)> = Vec::new();
        for o in orders
            .iter()
            .filter(|o| Date::parse(&o.ordered_on).is_some_and(|d| d <= until) && o.remaining > 0)
        {
            let Some(t) = CostType::parse(&o.cost_type) else {
                continue;
            };
            match committed
                .iter_mut()
                .find(|(ph, ct, _)| *ph == o.phase_id && *ct == t)
            {
                Some(row) => row.2 += o.remaining,
                None => committed.push((o.phase_id, t, o.remaining)),
            }
        }
        let on = until.to_string();
        let pending_sql = self.sql(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM direct_costs \
             WHERE project_id = ? AND status <> 'approved' AND booked_on <= ?",
        );
        let pending_alloc_sql = self.sql(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM cost_allocations a \
             JOIN direct_costs c ON c.id = a.direct_cost_id \
             WHERE a.project_id = ? AND c.status <> 'approved' AND c.booked_on <= ?",
        );
        let provisional_sql = self.sql(
            "SELECT CAST(COUNT(*) AS BIGINT) FROM direct_costs p WHERE p.project_id = ? \
             AND p.status = 'approved' AND p.entry_kind = 'provisional' AND p.booked_on <= ? \
             AND NOT EXISTS (SELECT 1 FROM direct_costs f WHERE f.ref_id = p.id \
             AND f.entry_kind = 'confirms' AND f.status = 'approved' AND f.booked_on <= ?)",
        );
        let (a, b, c): (i64, i64, i64) = on_pool!(&self.db, pool => (
            scalar!(pool, pending_sql, project_id, &on)?,
            scalar!(pool, pending_alloc_sql, project_id, &on)?,
            scalar!(pool, provisional_sql, project_id, &on, &on)?,
        ));
        Ok(CostSnapshot {
            actual: project_actuals(&until_postings, &key),
            latest_total: postings
                .iter()
                .filter(|p| p.project == key)
                .map(|p| p.amount)
                .sum(),
            committed,
            pending: a + b,
            provisional: c,
        })
    }

    /// 案件詳細 → 直接費.
    pub async fn project_costs(&self, project_id: i64) -> Result<ProjectCosts, BantoError> {
        let exists = self.sql("SELECT id FROM projects WHERE id = ?");
        let found: Option<(i64,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, exists, project_id))?;
        if found.is_none() {
            return Err(not_found("projects", project_id));
        }
        let sql = self.sql(&format!(
            "{SELECT} WHERE c.project_id = ? OR c.id IN \
             (SELECT direct_cost_id FROM cost_allocations WHERE project_id = ?) \
             ORDER BY c.booked_on DESC, c.id DESC"
        ));
        let rows: Vec<CostRow> =
            on_pool!(&self.db, pool => fetch_all!(pool, sql, project_id, project_id))?;
        // A split record shows only this project's share: its other projects
        // and its whole amount are not this project's to see (T12).
        let entries: Vec<DirectCost> = self
            .views(rows)
            .await?
            .into_iter()
            .map(|c| scoped_to(c, project_id))
            .collect();
        let postings = self.postings().await?;
        let key = project_id.to_string();
        let summary = ledger::summarize(&postings, &key, &FiscalCalendar::COMPANY_DEFAULT);
        let by_type = |b: &cost_domain::forecast::ByCostType| -> Vec<CostTypeAmount> {
            DIRECT_TYPES
                .iter()
                .map(|t| CostTypeAmount {
                    cost_type: t.as_str().into(),
                    amount: b.get(*t),
                })
                .collect()
        };
        let cal = FiscalCalendar::COMPANY_DEFAULT;
        let months = summary
            .by_month
            .iter()
            .map(|(ym, b)| MonthCosts {
                month: ym.to_string(),
                period: cal.period_of(*ym),
                by_type: by_type(b),
                total: b.total(),
            })
            .collect();
        let (pending, provisional) = self.tallies(project_id).await?;
        let orders = self.orders_of(project_id, &postings).await?;
        Ok(ProjectCosts {
            project_id,
            entries,
            totals: by_type(&summary.cumulative),
            total: summary.cumulative.total(),
            months,
            pending,
            provisional,
            complete: pending.count == 0 && provisional.count == 0,
            committed: orders.iter().map(|o| o.remaining.max(0)).sum(),
            orders,
        })
    }

    // --- purchase orders ----------------------------------------------------

    async fn order_row(&self, id: i64) -> Result<OrderRow, BantoError> {
        let sql = self.sql(&format!("{ORDER_SELECT} WHERE o.id = ?"));
        let row: Option<OrderRow> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        row.ok_or_else(|| not_found(ORDER_RESOURCE, id))
    }

    async fn order_views(
        &self,
        rows: Vec<OrderRow>,
        postings: &[Posting],
    ) -> Result<Vec<PurchaseOrderView>, BantoError> {
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        let marks = vec!["?"; ids.len()].join(",");
        let changes_sql = self.sql(&format!(
            "SELECT c.purchase_order_id, c.kind, c.before_amount, c.after_amount, c.reason, \
             u.display_name AS created_by_name, c.created_at FROM purchase_order_changes c \
             LEFT JOIN users u ON u.id = c.created_by \
             WHERE c.purchase_order_id IN ({marks}) ORDER BY c.id"
        ));
        let pending_sql = self.sql(&format!(
            "SELECT purchase_order_id, CAST(COUNT(*) AS BIGINT), \
             CAST(COALESCE(SUM(amount), 0) AS BIGINT) FROM direct_costs \
             WHERE status <> 'approved' AND entry_kind IN ('normal','provisional') \
             AND purchase_order_id IN ({marks}) GROUP BY purchase_order_id"
        ));
        let (changes, pending): (Vec<OrderChange>, Vec<(i64, i64, i64)>) = match &self.db {
            Db::Sqlite(pool) => {
                let mut a = sqlx::query_as(sqlx::AssertSqlSafe(changes_sql.as_str()));
                let mut b = sqlx::query_as(sqlx::AssertSqlSafe(pending_sql.as_str()));
                for id in &ids {
                    a = a.bind(*id);
                    b = b.bind(*id);
                }
                (
                    a.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                    b.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                )
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut a = sqlx::query_as(sqlx::AssertSqlSafe(changes_sql.as_str()));
                let mut b = sqlx::query_as(sqlx::AssertSqlSafe(pending_sql.as_str()));
                for id in &ids {
                    a = a.bind(*id);
                    b = b.bind(*id);
                }
                (
                    a.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                    b.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                )
            }
        };
        Ok(rows
            .into_iter()
            .map(|r| {
                let realized = order_realized(postings, &r.id.to_string());
                let (pending_count, pending_amount) = pending
                    .iter()
                    .find(|(o, _, _)| *o == r.id)
                    .map(|(_, c, a)| (*c, *a))
                    .unwrap_or((0, 0));
                PurchaseOrderView {
                    remaining: r.amount - r.cancelled_amount - realized,
                    realized,
                    pending_count,
                    pending_amount,
                    changes: changes
                        .iter()
                        .filter(|c| c.purchase_order_id == r.id)
                        .cloned()
                        .collect(),
                    id: r.id,
                    project_id: r.project_id,
                    vendor_id: r.vendor_id,
                    vendor_name: r.vendor_name,
                    phase_id: r.phase_id,
                    phase_name: r.phase_name,
                    cost_type: r.cost_type,
                    description: r.description,
                    ordered_on: r.ordered_on,
                    amount: r.amount,
                    cancelled_amount: r.cancelled_amount,
                    created_by: r.created_by,
                    created_by_name: r.created_by_name,
                    row_version: r.row_version,
                    updated_at: r.updated_at,
                }
            })
            .collect())
    }

    async fn orders_of(
        &self,
        project_id: i64,
        postings: &[Posting],
    ) -> Result<Vec<PurchaseOrderView>, BantoError> {
        let sql = self.sql(&format!(
            "{ORDER_SELECT} WHERE o.project_id = ? ORDER BY o.ordered_on DESC, o.id DESC"
        ));
        let rows: Vec<OrderRow> = on_pool!(&self.db, pool => fetch_all!(pool, sql, project_id))?;
        self.order_views(rows, postings).await
    }

    /// One order with its remainder. The wiring authorizes against its project.
    pub async fn order(&self, id: i64) -> Result<PurchaseOrderView, BantoError> {
        let row = self.order_row(id).await?;
        let postings = self.postings().await?;
        Ok(self.order_views(vec![row], &postings).await?.remove(0))
    }

    async fn order_by_request(
        &self,
        user_id: Option<i64>,
        request_id: &str,
    ) -> Result<Option<i64>, BantoError> {
        let Some(user_id) = user_id else {
            return Ok(None);
        };
        let sql = self
            .sql("SELECT id FROM purchase_orders WHERE created_by = ? AND client_request_id = ?");
        let row: Option<(i64,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, user_id, request_id))?;
        Ok(row.map(|(id,)| id))
    }

    /// Check the fields shared by create and update (vendor, phase, text, date).
    async fn order_fields(
        &self,
        input: &PurchaseOrderInput,
        kept: Option<&PurchaseOrderView>,
        errors: &mut Vec<FieldError>,
    ) -> Result<(Option<String>, Option<Date>), BantoError> {
        let description = text(errors, "description", &input.description);
        let ordered_on = Date::parse(input.ordered_on.trim());
        if ordered_on.is_none() {
            errors.push(field_error(
                "orderedOn",
                "日付は YYYY-MM-DD で入力してください",
            ));
        }
        let masters = WorkMastersService::new(self.db.clone());
        if let Some(phase) = input
            .phase_id
            .filter(|p| !kept.is_some_and(|k| k.phase_id == Some(*p)))
        {
            masters
                .require_active(MasterKind::Phases, phase, "phaseId")
                .await?;
        }
        if let Some(vendor) = input
            .vendor_id
            .filter(|v| !kept.is_some_and(|k| k.vendor_id == Some(*v)))
        {
            masters
                .require_active(MasterKind::Vendors, vendor, "vendorId")
                .await?;
        }
        Ok((description, ordered_on))
    }

    /// Register an order (発注).
    pub async fn create_order(
        &self,
        input: PurchaseOrderInput,
        actor_user_id: Option<i64>,
    ) -> Result<PurchaseOrderSaved, BantoError> {
        let request_id = clean_optional(&input.client_request_id);
        if let Some(rid) = &request_id {
            if rid.chars().count() > MAX_REQUEST_ID_LEN {
                return Err(BantoError::Validation {
                    field_errors: vec![field_error("clientRequestId", "長すぎます")],
                });
            }
            if let Some(id) = self.order_by_request(actor_user_id, rid).await? {
                return Ok(PurchaseOrderSaved {
                    order: self.order(id).await?,
                    replayed: true,
                });
            }
        }
        let mut errors = Vec::new();
        let Some(project_id) = input.project_id else {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("projectId", "案件を選んでください")],
            });
        };
        let cost_type = direct_type(&mut errors, input.cost_type.as_deref());
        if cost_type == Some(CostType::Labor) {
            errors.push(field_error(
                "costType",
                "労務は発注に使いません。材料・外注・旅費・その他を選んでください",
            ));
        }
        match input.amount {
            Some(a) if a > 0 => {}
            _ => errors.push(field_error("amount", "1円以上で入力してください")),
        }
        let (description, ordered_on) = self.order_fields(&input, None, &mut errors).await?;
        validation(errors)?;
        self.require_open_project(project_id, "projectId").await?;
        let sql = self.sql(
            "INSERT INTO purchase_orders (project_id, vendor_id, phase_id, cost_type, \
             description, ordered_on, amount, created_by, updated_by, client_request_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        );
        let date = ordered_on.expect("checked").to_string();
        let cost_type = cost_type.expect("checked").as_str();
        let result: Result<i64, BantoError> = on_pool!(&self.db, pool => scalar!(pool, sql,
            project_id, input.vendor_id, input.phase_id, cost_type, &description, &date,
            input.amount, actor_user_id, actor_user_id, &request_id));
        let id = match result {
            Ok(id) => id,
            Err(BantoError::Storage(m)) if m.to_lowercase().contains("unique") => {
                if let Some(rid) = &request_id {
                    if let Some(id) = self.order_by_request(actor_user_id, rid).await? {
                        return Ok(PurchaseOrderSaved {
                            order: self.order(id).await?,
                            replayed: true,
                        });
                    }
                }
                return Err(BantoError::Storage(m));
            }
            Err(e) => return Err(e),
        };
        self.notify(ORDER_RESOURCE);
        Ok(PurchaseOrderSaved {
            order: self.order(id).await?,
            replayed: false,
        })
    }

    /// Change an order's vendor, phase, description or date (not its amount).
    pub async fn update_order(
        &self,
        id: i64,
        input: PurchaseOrderInput,
        actor_user_id: Option<i64>,
    ) -> Result<PurchaseOrderView, BantoError> {
        let order = self.order(id).await?;
        if input.row_version != Some(order.row_version) {
            return Err(stale_version_error());
        }
        let mut errors = Vec::new();
        let (description, ordered_on) =
            self.order_fields(&input, Some(&order), &mut errors).await?;
        validation(errors)?;
        self.require_open_project(order.project_id, "projectId")
            .await?;
        let sql = self.sql(&format!(
            "UPDATE purchase_orders SET vendor_id = ?, phase_id = ?, description = ?, \
             ordered_on = ?, updated_by = ?, row_version = row_version + 1, updated_at = {} \
             WHERE id = ? AND row_version = ?",
            self.now()
        ));
        let date = ordered_on.expect("checked").to_string();
        if on_pool!(&self.db, pool => execute!(pool, sql, input.vendor_id, input.phase_id,
            &description, &date, actor_user_id, id, order.row_version))?
            == 0
        {
            return Err(stale_version_error());
        }
        self.notify(ORDER_RESOURCE);
        self.order(id).await
    }

    /// Revise an order's amount or cancel part of its remainder, with the
    /// reason. Checked against the approved ledger in the same transaction.
    pub async fn revise_order(
        &self,
        id: i64,
        input: OrderRevisionInput,
        actor_user_id: Option<i64>,
    ) -> Result<PurchaseOrderView, BantoError> {
        let order = self.order(id).await?;
        if input.row_version != order.row_version {
            return Err(stale_version_error());
        }
        let mut errors = Vec::new();
        let is_cancel = match input.kind.as_str() {
            "cancel" => true,
            "amount" => false,
            _ => {
                errors.push(field_error("kind", "発注額の見直しか取消を選んでください"));
                false
            }
        };
        let reason = text(&mut errors, "reason", &input.reason);
        if reason.is_none() {
            errors.push(field_error(
                "reason",
                "見直し・取消の理由を入力してください",
            ));
        }
        validation(errors)?;
        self.require_open_project(order.project_id, "projectId")
            .await?;
        let lock = self
            .is_postgres()
            .then(|| self.sql("SELECT id FROM purchase_orders WHERE id = ? FOR UPDATE"));
        let bump = self.sql(&format!(
            "UPDATE purchase_orders SET updated_by = ?, row_version = row_version + 1, \
             updated_at = {} WHERE id = ? AND row_version = ?",
            self.now()
        ));
        let set_amount =
            self.sql("UPDATE purchase_orders SET amount = ?, cancelled_amount = ? WHERE id = ?");
        let log = self.sql(
            "INSERT INTO purchase_order_changes (purchase_order_id, kind, before_amount, \
             after_amount, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)",
        );
        let ledger_sql = LEDGER_SQL.to_string();
        let alloc_sql = LEDGER_ALLOC_SQL.to_string();
        let terms = OrderTerms {
            amount: order.amount,
            cancelled: order.cancelled_amount,
        };
        let key = id.to_string();
        in_tx!(&self.db, tx => {
            if let Some(lock) = &lock {
                let _: Vec<(i64,)> = fetch_all!(&mut *tx, lock, id)?;
            }
            if execute!(&mut *tx, bump, actor_user_id, id, input.row_version)? == 0 {
                return Err(stale_version_error());
            }
            let rows: Vec<LedgerRow> = fetch_all!(&mut *tx, ledger_sql)?;
            let allocs: Vec<(i64, i64, i64)> = fetch_all!(&mut *tx, alloc_sql)?;
            let (entries, allocations) = ledger_of(&rows, &allocs);
            let posted = ledger::postings(&entries, &allocations).map_err(|issues| {
                BantoError::Other(format!("直接費の台帳に不整合があります: {issues:?}"))
            })?;
            let next = if is_cancel {
                check_cancel(terms, &posted, &key, input.amount)
            } else {
                check_amount_change(terms, &posted, &key, input.amount)
            }
            .map_err(|e| BantoError::Validation { field_errors: vec![order_error(e)] })?;
            execute!(&mut *tx, set_amount, next.amount, next.cancelled, id)?;
            let (kind, before, after) = if is_cancel {
                ("cancel", terms.cancelled, next.cancelled)
            } else {
                ("amount", terms.amount, next.amount)
            };
            execute!(&mut *tx, log, id, kind, before, after, &reason, actor_user_id)?;
        });
        self.notify(ORDER_RESOURCE);
        self.order(id).await
    }
}

/// A split record as one of its projects sees it: only that project's
/// allocation line, its share as the amount, no tax-inclusive total.
fn scoped_to(mut cost: DirectCost, project_id: i64) -> DirectCost {
    if cost.project_id.is_some() {
        return cost;
    }
    cost.allocations.retain(|a| a.project_id == project_id);
    cost.amount = cost.allocations.iter().map(|a| a.amount).sum();
    cost.amount_in_tax = None;
    cost
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::budgets::tests::ordered_project;
    use crate::projects::tests::fixture;
    use crate::work_masters::WorkMasterInput;

    pub(crate) fn cost(project: i64, cost_type: &str, amount: i64) -> DirectCostInput {
        DirectCostInput {
            project_id: Some(project),
            cost_type: Some(cost_type.into()),
            booked_on: "2026-11-20".into(),
            amount,
            ..Default::default()
        }
    }

    fn field_errors(err: BantoError) -> Vec<String> {
        match err {
            BantoError::Validation { field_errors } => {
                field_errors.into_iter().map(|e| e.field).collect()
            }
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    fn approve() -> impl Fn(i64) -> DecisionInput {
        |row_version| DecisionInput {
            row_version,
            approve: true,
            reason: None,
        }
    }

    /// Create, submit and approve as user 1.
    pub(crate) async fn approved(svc: &DirectCostsService, input: DirectCostInput) -> DirectCost {
        let c = svc.create(1, input).await.unwrap().cost;
        let c = svc.submit(1, c.id, c.row_version).await.unwrap();
        svc.decide(&c, approve()(c.row_version), Some(1))
            .await
            .unwrap()
    }

    async fn submitted(svc: &DirectCostsService, input: DirectCostInput) -> DirectCost {
        let c = svc.create(1, input).await.unwrap().cost;
        svc.submit(1, c.id, c.row_version).await.unwrap()
    }

    fn order_input(project: i64, amount: i64) -> PurchaseOrderInput {
        PurchaseOrderInput {
            project_id: Some(project),
            cost_type: Some("outsource".into()),
            ordered_on: "2026-11-01".into(),
            amount: Some(amount),
            client_request_id: Some("po-1".into()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn t05_outsourcing_order_realized_by_acceptance_and_invoice_does_not_double() {
        let db = fixture().await;
        let svc = DirectCostsService::new(db.clone());
        let pid = ordered_project(&db, "P-D01").await;
        let po = svc
            .create_order(order_input(pid, 500_000), Some(1))
            .await
            .unwrap();
        assert!(!po.replayed);
        // A retried send returns the same order (T13).
        let again = svc
            .create_order(order_input(pid, 500_000), Some(1))
            .await
            .unwrap();
        assert!(again.replayed);
        assert_eq!(again.order.id, po.order.id);
        let po = po.order;
        assert_eq!((po.realized, po.remaining), (0, 500_000));

        // 300,000 accepted, booked as provisional while the invoice is due.
        let mut accept = cost(pid, "outsource", 300_000);
        accept.entry_kind = Some("provisional".into());
        accept.purchase_order_id = Some(po.id);
        accept.project_id = None;
        accept.cost_type = None;
        let prov = approved(&svc, accept).await;
        assert_eq!(prov.project_id, Some(pid));
        assert_eq!(prov.cost_type, "outsource");
        let po_now = svc.order(po.id).await.unwrap();
        assert_eq!((po_now.realized, po_now.remaining), (300_000, 200_000));

        // The same 300,000 invoice replaces the provisional: still 300,000.
        let confirm = DirectCostInput {
            entry_kind: Some("confirms".into()),
            ref_id: Some(prov.id),
            booked_on: "2026-11-30".into(),
            amount: 300_000,
            voucher_no: Some("INV-0001".into()),
            reason: Some("請求書到着".into()),
            ..Default::default()
        };
        let conf = approved(&svc, confirm.clone()).await;
        assert_eq!(conf.purchase_order_id, Some(po.id));
        let pc = svc.project_costs(pid).await.unwrap();
        let outsource = pc
            .totals
            .iter()
            .find(|t| t.cost_type == "outsource")
            .unwrap();
        assert_eq!(outsource.amount, 300_000);
        assert_eq!(pc.orders[0].remaining, 200_000);
        assert_eq!(pc.committed, 200_000);
        assert!(pc.complete);
        // The provisional now names its confirmation; a second one is refused.
        assert_eq!(svc.get(prov.id).await.unwrap().confirmed_by, Some(conf.id));
        let err = svc.create(1, confirm).await.unwrap_err();
        assert_eq!(field_errors(err), vec!["refId"]);

        // Realizing more than the remainder needs the order revised first.
        let mut over = cost(pid, "outsource", 250_000);
        over.purchase_order_id = Some(po.id);
        let over = submitted(&svc, over).await;
        let err = svc
            .decide(&over, approve()(over.row_version), Some(1))
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["purchaseOrderId"]);
        let po_now = svc.order(po.id).await.unwrap();
        assert_eq!((po_now.pending_count, po_now.pending_amount), (1, 250_000));
        let revised = svc
            .revise_order(
                po.id,
                OrderRevisionInput {
                    kind: "amount".into(),
                    amount: 550_000,
                    reason: Some("追加作業の発注".into()),
                    row_version: po_now.row_version,
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(revised.remaining, 250_000);
        assert_eq!(revised.changes.len(), 1);
        let over = svc.get(over.id).await.unwrap();
        svc.decide(&over, approve()(over.row_version), Some(1))
            .await
            .unwrap();
        let po_now = svc.order(po.id).await.unwrap();
        assert_eq!((po_now.realized, po_now.remaining), (550_000, 0));
    }

    #[tokio::test]
    async fn t05_order_cancel_and_revision_keep_reason_and_stay_above_realized() {
        let db = fixture().await;
        let svc = DirectCostsService::new(db.clone());
        let pid = ordered_project(&db, "P-D02").await;
        let po = svc
            .create_order(order_input(pid, 500_000), Some(1))
            .await
            .unwrap()
            .order;
        let mut part = cost(pid, "outsource", 300_000);
        part.purchase_order_id = Some(po.id);
        approved(&svc, part).await;
        let po = svc.order(po.id).await.unwrap();
        let revise =
            |kind: &str, amount: i64, reason: Option<&str>, row_version: i64| OrderRevisionInput {
                kind: kind.into(),
                amount,
                reason: reason.map(Into::into),
                row_version,
            };
        let err = svc
            .revise_order(po.id, revise("cancel", 1, None, po.row_version), Some(1))
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["reason"]);
        let err = svc
            .revise_order(
                po.id,
                revise("cancel", 250_000, Some("不要"), po.row_version),
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["amount"]);
        let po2 = svc
            .revise_order(
                po.id,
                revise("cancel", 200_000, Some("残りは不要"), po.row_version),
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!((po2.cancelled_amount, po2.remaining), (200_000, 0));
        assert_eq!(po2.changes[0].kind, "cancel");
        assert_eq!(po2.changes[0].reason, "残りは不要");
        // Stale version (T13) and an amount below cancelled + realized.
        let err = svc
            .revise_order(
                po.id,
                revise("amount", 600_000, Some("値上がり"), po.row_version),
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["rowVersion"]);
        let err = svc
            .revise_order(
                po.id,
                revise("amount", 400_000, Some("減額"), po2.row_version),
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["amount"]);
    }

    #[tokio::test]
    async fn t10_travel_split_over_two_projects_counts_once() {
        let db = fixture().await;
        let svc = DirectCostsService::new(db.clone());
        let a = ordered_project(&db, "P-D03").await;
        let b = ordered_project(&db, "P-D04").await;
        let mut trip = cost(a, "travel", 30_000);
        trip.project_id = None;
        trip.allocation_basis = Some("作業日数 3:2".into());
        trip.allocations = vec![
            AllocationInput {
                project_id: a,
                amount: 18_000,
            },
            AllocationInput {
                project_id: b,
                amount: 13_000,
            },
        ];
        let err = svc.create(1, trip.clone()).await.unwrap_err();
        assert_eq!(field_errors(err), vec!["allocations"]);
        trip.allocations[1].amount = 12_000;
        let c = approved(&svc, trip).await;
        assert_eq!(c.projects(), vec![a, b]);
        let pa = svc.project_costs(a).await.unwrap();
        let pb = svc.project_costs(b).await.unwrap();
        assert_eq!((pa.total, pb.total), (18_000, 12_000));
        assert_eq!(pa.entries.len(), 1);
        // Each project sees only its own share of the split (T12).
        assert_eq!(pa.entries[0].amount, 18_000);
        assert_eq!(pa.entries[0].allocations.len(), 1);
        assert_eq!(pa.entries[0].allocations[0].project_id, a);
        assert_eq!(pb.entries[0].amount, 12_000);
        assert!(pb.entries[0].allocations.iter().all(|x| x.project_id == b));
        assert_eq!(pb.entries[0].id, c.id);
        // The postings total the original once.
        let all: i64 = svc.postings().await.unwrap().iter().map(|p| p.amount).sum();
        assert_eq!(all, 30_000);
        // A split record cannot be adjusted (cancel and split again).
        let err = svc
            .create(
                1,
                DirectCostInput {
                    entry_kind: Some("adjustment".into()),
                    adjustment_kind: Some("discount".into()),
                    ref_id: Some(c.id),
                    booked_on: "2026-11-21".into(),
                    amount: 1_000,
                    reason: Some("値引き".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["refId"]);
    }

    #[tokio::test]
    async fn t14_return_cancel_and_provisional_are_traced_and_change_the_cost() {
        let db = fixture().await;
        let svc = DirectCostsService::new(db.clone());
        let pid = ordered_project(&db, "P-D05").await;
        let material = approved(&svc, cost(pid, "material", 100_000)).await;
        let adjust = |kind: &str, target: i64, amount: i64| DirectCostInput {
            entry_kind: Some("adjustment".into()),
            adjustment_kind: Some(kind.into()),
            ref_id: Some(target),
            booked_on: "2026-12-01".into(),
            amount,
            reason: Some("返品".into()),
            ..Default::default()
        };
        // A negative normal entry is refused: reductions are adjustments.
        let err = svc
            .create(1, cost(pid, "material", -20_000))
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["amount"]);
        let ret = approved(&svc, adjust("return", material.id, 20_000)).await;
        assert_eq!(ret.project_id, Some(pid));
        assert_eq!(ret.cost_type, "material");
        // Adjusting beyond the original is refused at approval.
        let over = submitted(&svc, adjust("discount", material.id, 90_000)).await;
        let err = svc
            .decide(&over, approve()(over.row_version), Some(1))
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["amount"]);
        // An adjustment of an adjustment is refused when entered.
        let err = svc
            .create(1, adjust("discount", ret.id, 1_000))
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["refId"]);

        let other = approved(&svc, cost(pid, "other", 50_000)).await;
        approved(&svc, adjust("cancel", other.id, 50_000)).await;

        let pc = svc.project_costs(pid).await.unwrap();
        let get = |t: &str| pc.totals.iter().find(|x| x.cost_type == t).unwrap().amount;
        assert_eq!(get("material"), 80_000);
        assert_eq!(get("other"), 0);
        // The adjustments sit in their own month (2026-12).
        assert_eq!(pc.months.len(), 2);
        assert_eq!(pc.months[1].month, "2026-12");
        assert_eq!(pc.months[1].total, -70_000);
        assert_eq!(pc.months[0].period, 13);
        // The original names what adjusted it; nothing is lost.
        let m = pc.entries.iter().find(|e| e.id == material.id).unwrap();
        assert_eq!(m.adjusted, 20_000);
        // The pending over-discount keeps the actuals 暫定.
        assert!(!pc.complete);
        assert_eq!(pc.pending.count, 1);

        // Provisional, then the invoice with a different amount.
        let mut prov = cost(pid, "outsource", 300_000);
        prov.entry_kind = Some("provisional".into());
        let prov = approved(&svc, prov).await;
        let pc = svc.project_costs(pid).await.unwrap();
        assert_eq!(
            pc.provisional,
            Tally {
                count: 1,
                amount: 300_000
            }
        );
        approved(
            &svc,
            DirectCostInput {
                entry_kind: Some("confirms".into()),
                ref_id: Some(prov.id),
                booked_on: "2026-11-30".into(),
                amount: 320_000,
                reason: Some("請求確定".into()),
                ..Default::default()
            },
        )
        .await;
        let pc = svc.project_costs(pid).await.unwrap();
        assert_eq!(pc.provisional.count, 0);
        let get = |t: &str| pc.totals.iter().find(|x| x.cost_type == t).unwrap().amount;
        assert_eq!(get("outsource"), 320_000);
        // A confirmed provisional is adjusted through its confirmation.
        let err = svc
            .create(1, adjust("discount", prov.id, 1_000))
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["refId"]);
    }

    #[tokio::test]
    async fn workflow_ownership_retries_and_masters() {
        let db = fixture().await;
        let svc = DirectCostsService::new(db.clone());
        let pid = ordered_project(&db, "P-D06").await;
        let mut input = cost(pid, "travel", 12_000);
        input.client_request_id = Some("req-1".into());
        let first = svc.create(1, input.clone()).await.unwrap();
        let again = svc.create(1, input.clone()).await.unwrap();
        assert!(again.replayed);
        assert_eq!(again.cost.id, first.cost.id);
        // Someone else's record reads as not found.
        assert!(matches!(
            svc.editable(2, first.cost.id, Some(first.cost.row_version))
                .await,
            Err(BantoError::NotFound { .. })
        ));
        // Labor is not a direct cost; unknown masters are refused.
        let err = svc.create(1, cost(pid, "labor", 1)).await.unwrap_err();
        assert_eq!(field_errors(err), vec!["costType"]);
        let mut bad = cost(pid, "travel", 1);
        bad.vendor_id = Some(999);
        assert_eq!(
            field_errors(svc.create(1, bad).await.unwrap_err()),
            vec!["vendorId"]
        );
        let vendor = WorkMastersService::new(db.clone())
            .create(
                MasterKind::Vendors,
                WorkMasterInput {
                    name: "架空工業".into(),
                    sort_order: 0,
                    active: true,
                    row_version: None,
                },
            )
            .await
            .unwrap();
        let mut ok = cost(pid, "material", 5_000);
        ok.vendor_id = Some(vendor.id);
        ok.tax_kind = Some("standard".into());
        ok.amount_in_tax = Some(5_500);
        let saved = svc.create(1, ok).await.unwrap().cost;
        assert_eq!(saved.vendor_name.as_deref(), Some("架空工業"));

        // Edit with a stale version, then submit, return and resubmit.
        let c = first.cost;
        let mut edit = cost(pid, "travel", 13_000);
        edit.row_version = Some(c.row_version + 1);
        assert_eq!(
            field_errors(svc.update(1, c.id, edit.clone()).await.unwrap_err()),
            vec!["rowVersion"]
        );
        edit.row_version = Some(c.row_version);
        let c = svc.update(1, c.id, edit).await.unwrap().cost;
        assert_eq!(c.amount, 13_000);
        let c = svc.submit(1, c.id, c.row_version).await.unwrap();
        let err = svc
            .decide(
                &c,
                DecisionInput {
                    row_version: c.row_version,
                    approve: false,
                    reason: None,
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["reason"]);
        let c = svc
            .decide(
                &c,
                DecisionInput {
                    row_version: c.row_version,
                    approve: false,
                    reason: Some("領収書の番号を".into()),
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(c.status, "returned");
        let c = svc.submit(1, c.id, c.row_version).await.unwrap();
        assert_eq!(svc.approvals(&ProjectScope::All).await.unwrap().len(), 1);
        let c = svc
            .decide(&c, approve()(c.row_version), Some(1))
            .await
            .unwrap();
        // An approved record is never edited or deleted.
        assert!(svc.delete(1, c.id, c.row_version).await.is_err());
        let own = svc.list_own(1, "2026-11-01", "2026-11-30").await.unwrap();
        assert_eq!(own.len(), 2);

        // A settled project takes no new costs.
        let sql = placeholders(
            db.dialect(),
            "UPDATE projects SET status = 'settled' WHERE id = ?",
        );
        on_pool!(&db, pool => execute!(pool, sql, pid)).unwrap();
        assert_eq!(
            field_errors(svc.create(1, cost(pid, "travel", 1)).await.unwrap_err()),
            vec!["projectId"]
        );
    }
}
