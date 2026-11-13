//! 直接費・発注 (P4d, spec §6.3・§6.4, T05・T10・T14): saving a record is
//! `EnterCost` on every project it lands on (+ `ViewProjectAmounts` there
//! for someone else's record or an order, `cost_access::entry_ops`); a
//! record is the caller's own (someone else's reads as not found) and needs
//! a user row. Deciding is `ApproveCost` on every project under
//! `APPROVAL_POLICY` (self-approval allowed and audited). The caller's own
//! list is `ViewMasters`, the approval list is narrowed to
//! `cost_approval_projects`, a project's costs and orders are
//! `ViewProjectAmounts`, and registering, editing or revising an order is
//! `EditPurchaseOrder` on its project.
//!
//! Audit details carry kinds, projects, dates and status, never amounts
//! (`DirectCost::audit_detail`, `PurchaseOrderView::audit_detail`).

use banto_admin_services::authz::{cost_approval_projects, Operation, Policy};
use banto_core::BantoError;
use serde_json::json;

use super::Gate;
use crate::approval::APPROVAL_POLICY;
use crate::cost_access::{approve_ops, entry_ops, order_create_op, own_ops};
use crate::direct_costs::{
    DirectCost, DirectCostInput, DirectCostSaved, DirectCostsService, OrderRevisionInput,
    ProjectCosts, PurchaseOrderInput, PurchaseOrderSaved, PurchaseOrderView, ORDER_RESOURCE,
    RESOURCE,
};
use crate::time_entries::{DecisionInput, VersionInput};

/// The caller's own record and user row, as not found when it is someone
/// else's (a session without a user row is refused).
async fn own_cost(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    id: i64,
) -> Result<(DirectCost, i64), BantoError> {
    let user_id = gate.person()?;
    let cost = costs.get(id).await?;
    if cost.user_id != user_id {
        return Err(BantoError::NotFound {
            resource: RESOURCE.into(),
            id: id.to_string(),
        });
    }
    Ok((cost, user_id))
}

/// The caller's own records in `from..=to`.
pub async fn list_own(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    from: &str,
    to: &str,
) -> Result<Vec<DirectCost>, BantoError> {
    gate.check(Operation::ViewMasters, RESOURCE).await?;
    costs.list_own(gate.person()?, from, to).await
}

pub async fn create(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    input: DirectCostInput,
) -> Result<DirectCostSaved, BantoError> {
    let user_id = gate.person()?;
    let ops = entry_ops(costs, &input, None, user_id).await?;
    gate.check_all(&ops, Policy::default(), RESOURCE).await?;
    let saved = costs.create(user_id, input).await?;
    if !saved.replayed {
        gate.record(
            "create",
            RESOURCE,
            Some(&saved.cost.id.to_string()),
            Some(saved.cost.audit_detail()),
        )
        .await;
    }
    Ok(saved)
}

pub async fn update(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    id: i64,
    input: DirectCostInput,
) -> Result<DirectCostSaved, BantoError> {
    let (kept, user_id) = own_cost(gate, costs, id).await?;
    let ops = entry_ops(costs, &input, Some(&kept), user_id).await?;
    gate.check_all(&ops, Policy::default(), RESOURCE).await?;
    let saved = costs.update(user_id, id, input).await?;
    gate.record(
        "update",
        RESOURCE,
        Some(&id.to_string()),
        Some(saved.cost.audit_detail()),
    )
    .await;
    Ok(saved)
}

pub async fn delete(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    id: i64,
    row_version: i64,
) -> Result<(), BantoError> {
    let (cost, user_id) = own_cost(gate, costs, id).await?;
    gate.check_all(&own_ops(&cost), Policy::default(), RESOURCE)
        .await?;
    costs.delete(user_id, id, row_version).await?;
    gate.record(
        "delete",
        RESOURCE,
        Some(&id.to_string()),
        Some(cost.audit_detail()),
    )
    .await;
    Ok(())
}

pub async fn submit(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    id: i64,
    input: VersionInput,
) -> Result<DirectCost, BantoError> {
    let (cost, user_id) = own_cost(gate, costs, id).await?;
    gate.check_all(&own_ops(&cost), Policy::default(), RESOURCE)
        .await?;
    let cost = costs.submit(user_id, id, input.row_version).await?;
    gate.record(
        "submit",
        RESOURCE,
        Some(&id.to_string()),
        Some(cost.audit_detail()),
    )
    .await;
    Ok(cost)
}

/// The submitted records the caller may decide (no `Operation`: the scope
/// only narrows).
pub async fn approvals(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
) -> Result<Vec<DirectCost>, BantoError> {
    let subject = gate.subject().await?;
    costs.approvals(&cost_approval_projects(&subject)).await
}

/// Approving or returning a record on every project it lands on:
/// self-approval is allowed (`APPROVAL_POLICY`) and recorded as
/// `selfApproval` in the audit detail.
pub async fn decide(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    id: i64,
    input: DecisionInput,
) -> Result<DirectCost, BantoError> {
    let cost = costs.get(id).await?;
    let (_, exception) = gate
        .check_all(&approve_ops(&cost), APPROVAL_POLICY, RESOURCE)
        .await?;
    let approve = input.approve;
    let cost = costs.decide(&cost, input, gate.user_id()).await?;
    let mut detail = cost.audit_detail();
    detail["selfApproval"] = json!(exception);
    gate.record(
        if approve { "approve" } else { "return" },
        RESOURCE,
        Some(&id.to_string()),
        Some(detail),
    )
    .await;
    Ok(cost)
}

pub async fn project_costs(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    project_id: i64,
) -> Result<ProjectCosts, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    costs.project_costs(project_id).await
}

pub async fn create_order(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    input: PurchaseOrderInput,
) -> Result<PurchaseOrderSaved, BantoError> {
    gate.check(order_create_op(input.project_id)?, ORDER_RESOURCE)
        .await?;
    let saved = costs.create_order(input, gate.user_id()).await?;
    if !saved.replayed {
        gate.record(
            "create",
            ORDER_RESOURCE,
            Some(&saved.order.id.to_string()),
            Some(saved.order.audit_detail()),
        )
        .await;
    }
    Ok(saved)
}

async fn check_order(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    id: i64,
) -> Result<(), BantoError> {
    let order = costs.order(id).await?;
    gate.check(
        Operation::EditPurchaseOrder {
            project_id: order.project_id,
        },
        ORDER_RESOURCE,
    )
    .await?;
    Ok(())
}

pub async fn update_order(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    id: i64,
    input: PurchaseOrderInput,
) -> Result<PurchaseOrderView, BantoError> {
    check_order(gate, costs, id).await?;
    let saved = costs.update_order(id, input, gate.user_id()).await?;
    gate.record(
        "update",
        ORDER_RESOURCE,
        Some(&id.to_string()),
        Some(saved.audit_detail()),
    )
    .await;
    Ok(saved)
}

/// 発注の見直し・取消: the audit action is `cancel` for a cancellation,
/// `revise` otherwise.
pub async fn revise_order(
    gate: &Gate<'_>,
    costs: &DirectCostsService,
    id: i64,
    input: OrderRevisionInput,
) -> Result<PurchaseOrderView, BantoError> {
    check_order(gate, costs, id).await?;
    let action = if input.kind == "cancel" {
        "cancel"
    } else {
        "revise"
    };
    let saved = costs.revise_order(id, input, gate.user_id()).await?;
    gate.record(
        action,
        ORDER_RESOURCE,
        Some(&id.to_string()),
        Some(saved.audit_detail()),
    )
    .await;
    Ok(saved)
}
