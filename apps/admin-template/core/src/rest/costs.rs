//! `/api/vendors/*`, `/api/direct-costs/*`, `/api/purchase-orders/*` and
//! `/api/projects/{id}/costs` (banto-cost P4d, spec §6.3 / §6.4, T05, T10,
//! T14). The Tauri twins are the `vendors_*` / `direct_costs_*` /
//! `purchase_orders_*` / `project_costs` commands in `src-tauri`; both sides
//! authorize through `AuthzService::authorize_audited` with the same
//! `Operation`s from `crate::cost_access` (ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | vendors list / create / update | `admin` role, or `ViewMasters` / `EditMasters` |
//! | own direct costs list | `ViewMasters` (company member); the caller's own |
//! | create / update | `EnterCost` on every project the record lands on (+ `ViewProjectAmounts` for someone else's record or an order); own draft/returned only |
//! | delete / submit | `EnterCost` on the record's projects; own draft/returned only |
//! | approvals list | scope `cost_approval_projects` |
//! | decide | `ApproveCost` on every project with `APPROVAL_POLICY` |
//! | project costs and orders | `ViewProjectAmounts` |
//! | order create / update / revise | `EditPurchaseOrder` on the order's project |
//!
//! Audit details carry kinds, projects, dates and status, never amounts
//! (`DirectCost::audit_detail`, `PurchaseOrderView::audit_detail`).

use super::projects::{BusinessServices, BusinessState};
use super::time::{masters_list, masters_write};
use super::*;
use axum::extract::Query;
use axum::Extension;
use banto_admin_services::authz::{cost_approval_projects, Operation, Policy, Subject};
use banto_core::BantoError;
use banto_server::AuthenticatedSession;

use crate::approval::APPROVAL_POLICY;
use crate::cost_access::{approve_ops, entry_ops, order_create_op, own_ops};
use crate::direct_costs::{
    DirectCost, DirectCostInput, DirectCostSaved, OrderRevisionInput, ProjectCosts,
    PurchaseOrderInput, PurchaseOrderSaved, PurchaseOrderView, ORDER_RESOURCE, RESOURCE,
};
use crate::time_entries::{DecisionInput, VersionInput};
use crate::work_masters::{MasterKind, WorkMaster, WorkMasterInput};

/// Authorize every op (each denial is recorded); the subject, the caller's
/// user row, and whether a self-approval exception was used.
async fn guard_all(
    state: &BusinessState,
    session: &AuthenticatedSession,
    ops: &[Operation],
    policy: Policy,
    resource: &str,
) -> Result<(Subject, Option<i64>, bool), BantoError> {
    let mut out = None;
    let mut exception = false;
    for op in ops {
        let (subject, user_id, allowed) = state.guard_with(session, *op, policy, resource).await?;
        exception |= allowed.self_approval_exception;
        out = Some((subject, user_id));
    }
    let (subject, user_id) = out.ok_or(BantoError::Forbidden)?;
    Ok((subject, user_id, exception))
}

async fn caller(state: &BusinessState, session: &AuthenticatedSession) -> Result<i64, BantoError> {
    super::authz::caller_user_id(session, &state.users)
        .await?
        .ok_or(BantoError::Forbidden)
}

/// The caller's own record, as not found when it is someone else's.
async fn own_cost(
    state: &BusinessState,
    session: &AuthenticatedSession,
    id: i64,
) -> Result<(DirectCost, i64), BantoError> {
    let user_id = caller(state, session).await?;
    let cost = state.direct_costs.get(id).await?;
    if cost.user_id != user_id {
        return Err(BantoError::NotFound {
            resource: RESOURCE.into(),
            id: id.to_string(),
        });
    }
    Ok((cost, user_id))
}

// --- vendors -------------------------------------------------------------------

async fn vendors_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<WorkMaster>>, ApiError> {
    masters_list(&state, &session, MasterKind::Vendors).await
}

async fn vendors_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(&state, &session, &headers, MasterKind::Vendors, None, input).await
}

async fn vendors_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(
        &state,
        &session,
        &headers,
        MasterKind::Vendors,
        Some(id),
        input,
    )
    .await
}

// --- direct costs --------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
struct RangeQuery {
    from: String,
    to: String,
}

async fn costs_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<RangeQuery>,
) -> Result<Json<Vec<DirectCost>>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::ViewMasters, RESOURCE)
        .await?;
    let user_id = user_id.ok_or(BantoError::Forbidden)?;
    Ok(Json(
        state
            .direct_costs
            .list_own(user_id, &query.from, &query.to)
            .await?,
    ))
}

async fn costs_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<DirectCostInput>,
) -> Result<Json<DirectCostSaved>, ApiError> {
    let user_id = caller(&state, &session).await?;
    let ops = entry_ops(&state.direct_costs, &input, None, user_id).await?;
    guard_all(&state, &session, &ops, Policy::default(), RESOURCE).await?;
    let saved = state.direct_costs.create(user_id, input).await?;
    if !saved.replayed {
        record_write(
            &state.audit,
            &state.auth,
            &headers,
            "create",
            RESOURCE,
            Some(&saved.cost.id.to_string()),
            Some(saved.cost.audit_detail()),
        )
        .await;
    }
    Ok(Json(saved))
}

async fn costs_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<DirectCostInput>,
) -> Result<Json<DirectCostSaved>, ApiError> {
    let (kept, user_id) = own_cost(&state, &session, id).await?;
    let ops = entry_ops(&state.direct_costs, &input, Some(&kept), user_id).await?;
    guard_all(&state, &session, &ops, Policy::default(), RESOURCE).await?;
    let saved = state.direct_costs.update(user_id, id, input).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        RESOURCE,
        Some(&id.to_string()),
        Some(saved.cost.audit_detail()),
    )
    .await;
    Ok(Json(saved))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowVersionQuery {
    row_version: i64,
}

async fn costs_delete(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(query): Query<RowVersionQuery>,
) -> Result<StatusCode, ApiError> {
    let (cost, user_id) = own_cost(&state, &session, id).await?;
    guard_all(
        &state,
        &session,
        &own_ops(&cost),
        Policy::default(),
        RESOURCE,
    )
    .await?;
    state
        .direct_costs
        .delete(user_id, id, query.row_version)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        RESOURCE,
        Some(&id.to_string()),
        Some(cost.audit_detail()),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn costs_submit(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<VersionInput>,
) -> Result<Json<DirectCost>, ApiError> {
    let (cost, user_id) = own_cost(&state, &session, id).await?;
    guard_all(
        &state,
        &session,
        &own_ops(&cost),
        Policy::default(),
        RESOURCE,
    )
    .await?;
    let cost = state
        .direct_costs
        .submit(user_id, id, input.row_version)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "submit",
        RESOURCE,
        Some(&id.to_string()),
        Some(cost.audit_detail()),
    )
    .await;
    Ok(Json(cost))
}

async fn costs_approvals(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<DirectCost>>, ApiError> {
    let subject = state.subject(&session).await?;
    let scope = cost_approval_projects(&subject);
    Ok(Json(state.direct_costs.approvals(&scope).await?))
}

async fn costs_decide(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<DecisionInput>,
) -> Result<Json<DirectCost>, ApiError> {
    let cost = state.direct_costs.get(id).await?;
    let (_, user_id, exception) = guard_all(
        &state,
        &session,
        &approve_ops(&cost),
        APPROVAL_POLICY,
        RESOURCE,
    )
    .await?;
    let approve = input.approve;
    let cost = state.direct_costs.decide(&cost, input, user_id).await?;
    let mut detail = cost.audit_detail();
    detail["selfApproval"] = json!(exception);
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        if approve { "approve" } else { "return" },
        RESOURCE,
        Some(&id.to_string()),
        Some(detail),
    )
    .await;
    Ok(Json(cost))
}

async fn project_costs(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<ProjectCosts>, ApiError> {
    state
        .guard(
            &session,
            Operation::ViewProjectAmounts { project_id: id },
            RESOURCE,
        )
        .await?;
    Ok(Json(state.direct_costs.project_costs(id).await?))
}

// --- purchase orders -----------------------------------------------------------

async fn orders_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<PurchaseOrderInput>,
) -> Result<Json<PurchaseOrderSaved>, ApiError> {
    let (_, user_id) = state
        .guard(&session, order_create_op(input.project_id)?, ORDER_RESOURCE)
        .await?;
    let saved = state.direct_costs.create_order(input, user_id).await?;
    if !saved.replayed {
        record_write(
            &state.audit,
            &state.auth,
            &headers,
            "create",
            ORDER_RESOURCE,
            Some(&saved.order.id.to_string()),
            Some(saved.order.audit_detail()),
        )
        .await;
    }
    Ok(Json(saved))
}

async fn orders_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<PurchaseOrderInput>,
) -> Result<Json<PurchaseOrderView>, ApiError> {
    let order = state.direct_costs.order(id).await?;
    let (_, user_id) = state
        .guard(
            &session,
            Operation::EditPurchaseOrder {
                project_id: order.project_id,
            },
            ORDER_RESOURCE,
        )
        .await?;
    let saved = state.direct_costs.update_order(id, input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        ORDER_RESOURCE,
        Some(&id.to_string()),
        Some(saved.audit_detail()),
    )
    .await;
    Ok(Json(saved))
}

async fn orders_revise(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<OrderRevisionInput>,
) -> Result<Json<PurchaseOrderView>, ApiError> {
    let order = state.direct_costs.order(id).await?;
    let (_, user_id) = state
        .guard(
            &session,
            Operation::EditPurchaseOrder {
                project_id: order.project_id,
            },
            ORDER_RESOURCE,
        )
        .await?;
    let action = if input.kind == "cancel" {
        "cancel"
    } else {
        "revise"
    };
    let saved = state.direct_costs.revise_order(id, input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        action,
        ORDER_RESOURCE,
        Some(&id.to_string()),
        Some(saved.audit_detail()),
    )
    .await;
    Ok(Json(saved))
}

/// Reads (session only; the decision is in each handler).
pub(super) fn costs_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/vendors", get(vendors_list))
        .route("/api/direct-costs", get(costs_list))
        .route("/api/direct-costs/approvals", get(costs_approvals))
        .route("/api/projects/{id}/costs", get(project_costs))
        .with_state(super::projects::state(services, audit, auth.clone()))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Writes (`editor` floor, then the handler's decision).
pub(super) fn costs_write_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/vendors", post(vendors_create))
        .route("/api/vendors/{id}", axum::routing::put(vendors_update))
        .route("/api/direct-costs", post(costs_create))
        .route(
            "/api/direct-costs/{id}",
            axum::routing::put(costs_update).delete(costs_delete),
        )
        .route("/api/direct-costs/{id}/submit", post(costs_submit))
        .route("/api/direct-costs/{id}/decide", post(costs_decide))
        .route("/api/purchase-orders", post(orders_create))
        .route(
            "/api/purchase-orders/{id}",
            axum::routing::put(orders_update),
        )
        .route("/api/purchase-orders/{id}/revise", post(orders_revise))
        .with_state(super::projects::state(
            services,
            audit.clone(),
            auth.clone(),
        ))
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Editor,
                resource: "business",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
