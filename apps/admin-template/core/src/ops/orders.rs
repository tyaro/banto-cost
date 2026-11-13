//! 受注・売上・月次見通し (P3b, spec §5.3・§5.4): a project's order is
//! `ViewProjectAmounts`; converting it, cancelling or correcting the
//! conversion, requesting an order change and replanning the revenue are
//! `EditOrder` (a partial order's cancellation also `EditProject` on the
//! remainder it sets to 中止). Deciding a change is `ViewProjectAmounts` and
//! `Approve` under `APPROVAL_POLICY` (self-approval allowed and audited).
//! Recognizing revenue and cancelling a recognition are `FinanceClose` and
//! `ViewProjectAmounts`. The outlook and a snapshot's view are narrowed to
//! `amount_projects` (no `Operation`); the snapshot list is `ViewMasters`
//! and saving one `ViewAllReports`.
//!
//! Audit details are the ones the routes always wrote: the conversion's
//! amount and scope, a change's delta, a recognition's amount (accounting's
//! own record), never a reason or basis.

use banto_admin_services::authz::Operation;
use banto_core::BantoError;
use serde_json::json;

use super::Gate;
use crate::approval::APPROVAL_POLICY;
use crate::orders::outlook::{OutlookQuery, OutlookView, SnapshotInfo};
use crate::orders::{
    conversion_cancel_audit_detail, conversion_correction_audit_detail, CancelInput,
    ChangeDecision, ChangeRequest, ConversionCancelInput, ConversionCorrectionInput,
    ConversionRequest, OrderSummary, OrdersService, RecognitionInput, ReplanInput,
};

const RESOURCE: &str = "orders";
const RECOGNITIONS: &str = "revenue_recognitions";
const SNAPSHOTS: &str = "outlook_snapshots";

pub async fn get(
    gate: &Gate<'_>,
    orders: &OrdersService,
    project_id: i64,
) -> Result<OrderSummary, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    orders.summary(project_id).await
}

pub async fn convert(
    gate: &Gate<'_>,
    orders: &OrdersService,
    project_id: i64,
    input: ConversionRequest,
) -> Result<OrderSummary, BantoError> {
    gate.check(Operation::EditOrder { project_id }, RESOURCE)
        .await?;
    let summary = orders.convert(project_id, input, gate.user_id()).await?;
    gate.record(
        "convert",
        RESOURCE,
        Some(&project_id.to_string()),
        Some(json!({
            "confirmedAmount": summary.confirmed_amount,
            "scope": summary.conversion.as_ref().map(|c| c.scope.clone()),
            "remainderProjectId": summary.conversion.as_ref().and_then(|c| c.remainder_project_id),
        })),
    )
    .await;
    Ok(summary)
}

/// 受注転換の取消 (T40): a partial order's remainder is set to 中止, so
/// editing it is checked too. The audit detail names the cancelled
/// conversion and its amount, not the reason.
pub async fn cancel_conversion(
    gate: &Gate<'_>,
    orders: &OrdersService,
    project_id: i64,
    input: ConversionCancelInput,
) -> Result<OrderSummary, BantoError> {
    gate.check(Operation::EditOrder { project_id }, RESOURCE)
        .await?;
    let remainder = orders.conversion_remainder(project_id).await?;
    if let Some(remainder_id) = remainder {
        gate.check(
            Operation::EditProject {
                project_id: remainder_id,
            },
            "projects",
        )
        .await?;
    }
    let summary = orders
        .cancel_conversion(project_id, input, gate.user_id(), remainder)
        .await?;
    gate.record(
        "cancel_conversion",
        RESOURCE,
        Some(&project_id.to_string()),
        Some(conversion_cancel_audit_detail(&summary)),
    )
    .await;
    Ok(summary)
}

/// 受注日・根拠の訂正 (T41): the audit detail names the conversion, which
/// values changed and the 受注日 before and after, not the basis or reason.
pub async fn correct_conversion(
    gate: &Gate<'_>,
    orders: &OrdersService,
    project_id: i64,
    input: ConversionCorrectionInput,
) -> Result<OrderSummary, BantoError> {
    gate.check(Operation::EditOrder { project_id }, RESOURCE)
        .await?;
    let (summary, record) = orders
        .correct_conversion(project_id, input, gate.user_id())
        .await?;
    gate.record(
        "correct_conversion",
        RESOURCE,
        Some(&project_id.to_string()),
        Some(conversion_correction_audit_detail(&record)),
    )
    .await;
    Ok(summary)
}

pub async fn request_change(
    gate: &Gate<'_>,
    orders: &OrdersService,
    project_id: i64,
    input: ChangeRequest,
) -> Result<OrderSummary, BantoError> {
    gate.check(Operation::EditOrder { project_id }, RESOURCE)
        .await?;
    let delta = input.delta_amount;
    let summary = orders
        .request_change(project_id, input, gate.user_id())
        .await?;
    gate.record(
        "request_change",
        RESOURCE,
        Some(&project_id.to_string()),
        Some(json!({ "deltaAmount": delta })),
    )
    .await;
    Ok(summary)
}

/// Approving or rejecting an order change: self-approval is allowed
/// (`APPROVAL_POLICY`, banto-cost is run by one person) and recorded as
/// `selfApproval` in the audit detail.
pub async fn decide_change(
    gate: &Gate<'_>,
    orders: &OrdersService,
    project_id: i64,
    change_id: i64,
    input: ChangeDecision,
) -> Result<OrderSummary, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    let requester = orders.change_requester(project_id, change_id).await?;
    let (_, allowed) = gate
        .check_with(
            Operation::Approve {
                project_id,
                // A request without a requester (deleted user) is nobody's own.
                submitted_by: requester.unwrap_or(0),
            },
            APPROVAL_POLICY,
            RESOURCE,
        )
        .await?;
    let approve = input.approve;
    let summary = orders
        .decide_change(project_id, change_id, input, gate.user_id())
        .await?;
    gate.record(
        if approve {
            "approve_change"
        } else {
            "reject_change"
        },
        RESOURCE,
        Some(&project_id.to_string()),
        Some(json!({
            "changeId": change_id,
            "selfApproval": allowed.self_approval_exception,
        })),
    )
    .await;
    Ok(summary)
}

pub async fn replan(
    gate: &Gate<'_>,
    orders: &OrdersService,
    project_id: i64,
    input: ReplanInput,
) -> Result<OrderSummary, BantoError> {
    gate.check(Operation::EditOrder { project_id }, RESOURCE)
        .await?;
    let summary = orders.replan(project_id, input).await?;
    gate.record(
        "replan",
        RESOURCE,
        Some(&project_id.to_string()),
        Some(json!({ "lines": summary.plan.len() })),
    )
    .await;
    Ok(summary)
}

/// Revenue recognition is accounting's (`FinanceClose`) and shows amounts.
async fn finance_check(gate: &Gate<'_>, project_id: i64) -> Result<(), BantoError> {
    gate.check(Operation::FinanceClose, RECOGNITIONS).await?;
    gate.check(Operation::ViewProjectAmounts { project_id }, RECOGNITIONS)
        .await?;
    Ok(())
}

pub async fn recognize(
    gate: &Gate<'_>,
    orders: &OrdersService,
    project_id: i64,
    input: RecognitionInput,
) -> Result<OrderSummary, BantoError> {
    finance_check(gate, project_id).await?;
    let amount = input.amount;
    let summary = orders.recognize(project_id, input, gate.user_id()).await?;
    gate.record(
        "create",
        RECOGNITIONS,
        Some(&project_id.to_string()),
        Some(json!({ "amount": amount })),
    )
    .await;
    Ok(summary)
}

pub async fn cancel_recognition(
    gate: &Gate<'_>,
    orders: &OrdersService,
    project_id: i64,
    recognition_id: i64,
    input: CancelInput,
) -> Result<OrderSummary, BantoError> {
    finance_check(gate, project_id).await?;
    let summary = orders
        .cancel_recognition(project_id, recognition_id, input, gate.user_id())
        .await?;
    gate.record(
        "cancel",
        RECOGNITIONS,
        Some(&project_id.to_string()),
        Some(json!({ "recognitionId": recognition_id })),
    )
    .await;
    Ok(summary)
}

// --- 月次見通し (outlook) ------------------------------------------------------

pub async fn outlook(
    gate: &Gate<'_>,
    orders: &OrdersService,
    query: OutlookQuery,
) -> Result<OutlookView, BantoError> {
    let scope = gate.amount_scope().await?;
    orders.outlook(&scope, query).await
}

pub async fn snapshots(
    gate: &Gate<'_>,
    orders: &OrdersService,
) -> Result<Vec<SnapshotInfo>, BantoError> {
    gate.check(Operation::ViewMasters, SNAPSHOTS).await?;
    orders.snapshots().await
}

pub async fn snapshot_view(
    gate: &Gate<'_>,
    orders: &OrdersService,
    id: i64,
    query: OutlookQuery,
) -> Result<OutlookView, BantoError> {
    let scope = gate.amount_scope().await?;
    orders.snapshot_view(id, &scope, query).await
}

pub async fn save_snapshot(
    gate: &Gate<'_>,
    orders: &OrdersService,
    label: Option<String>,
) -> Result<SnapshotInfo, BantoError> {
    gate.check(Operation::ViewAllReports, SNAPSHOTS).await?;
    let snapshot = orders.save_snapshot(label, gate.user_id()).await?;
    gate.record(
        "create",
        SNAPSHOTS,
        Some(&snapshot.id.to_string()),
        Some(json!({ "label": snapshot.label })),
    )
    .await;
    Ok(snapshot)
}
