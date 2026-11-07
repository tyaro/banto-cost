//! Wiring helpers of the direct-cost and purchase-order routes and commands
//! (banto-cost P4d), shared by REST (`rest/costs.rs`) and Tauri
//! (`src-tauri`) so both paths decide identically (conventions §1). They map
//! a record or an input to the `Operation`s that authorize it; the service
//! (`direct_costs`) stays free of callers and permissions (conventions §2).
//!
//! A record lands on its project, or on each project it is split over, so
//! every one of them must allow the operation (T10, T12).

use banto_admin_services::authz::Operation;
use banto_core::BantoError;
use cost_domain::direct_cost::RecordKind;

use crate::customers::field_error;
use crate::direct_costs::{DirectCost, DirectCostInput, DirectCostsService};

/// The operations that let `caller` save `input` (create, or update of
/// `kept`): `EnterCost` on every project the record lands on, and
/// `ViewProjectAmounts` there when it refers to someone else's record
/// (confirm / adjustment) or links an order - both presuppose seeing those
/// amounts. An input that lands nowhere is refused before the service sees it.
pub async fn entry_ops(
    service: &DirectCostsService,
    input: &DirectCostInput,
    kept: Option<&DirectCost>,
    caller: i64,
) -> Result<Vec<Operation>, BantoError> {
    let projects = service.input_projects(input, kept).await?;
    let refers = match kept {
        Some(k) => k.ref_id.is_some(),
        None => input
            .entry_kind
            .as_deref()
            .and_then(RecordKind::parse)
            .is_some_and(RecordKind::refers),
    };
    if projects.is_empty() {
        let (field, message) = if refers {
            ("refId", "見つかりません")
        } else if input.purchase_order_id.is_some() {
            ("purchaseOrderId", "見つかりません")
        } else {
            ("projectId", "案件を選ぶか、複数の案件に配分してください")
        };
        return Err(BantoError::Validation {
            field_errors: vec![field_error(field, message)],
        });
    }
    let mut ops: Vec<Operation> = projects
        .iter()
        .map(|&project_id| Operation::EnterCost { project_id })
        .collect();
    let others_record = if refers {
        let target = kept.and_then(|k| k.ref_id).or(input.ref_id);
        match target {
            Some(t) => service.get(t).await.map(|r| r.user_id != caller)?,
            None => false,
        }
    } else {
        false
    };
    if others_record || (!refers && input.purchase_order_id.is_some()) {
        ops.extend(
            projects
                .iter()
                .map(|&project_id| Operation::ViewProjectAmounts { project_id }),
        );
    }
    Ok(ops)
}

/// The operations that let the owner delete or submit their record.
pub fn own_ops(cost: &DirectCost) -> Vec<Operation> {
    cost.projects()
        .into_iter()
        .map(|project_id| Operation::EnterCost { project_id })
        .collect()
}

/// The operations that decide a record: `ApproveCost` on every project.
pub fn approve_ops(cost: &DirectCost) -> Vec<Operation> {
    cost.projects()
        .into_iter()
        .map(|project_id| Operation::ApproveCost {
            project_id,
            submitted_by: cost.user_id,
        })
        .collect()
}

/// The order-registration decision for a create input naming `project_id`.
pub fn order_create_op(project_id: Option<i64>) -> Result<Operation, BantoError> {
    project_id
        .map(|project_id| Operation::EditPurchaseOrder { project_id })
        .ok_or_else(|| BantoError::Validation {
            field_errors: vec![field_error("projectId", "案件を選んでください")],
        })
}
