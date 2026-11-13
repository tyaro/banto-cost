//! `/api/vendors/*`, `/api/direct-costs/*`, `/api/purchase-orders/*` and
//! `/api/projects/{id}/costs` (banto-cost P4d, spec §6.3 / §6.4, T05, T10,
//! T14). The Tauri twins are the `vendors_*` / `direct_costs_*` /
//! `purchase_orders_*` / `project_costs` commands in `src-tauri`; both call
//! the same authorized operations (`crate::ops::costs` with the `Operation`s
//! from `crate::cost_access`, `crate::ops::work_masters` for vendors, review
//! §8-13) and keep only the role floor and the arguments here (ADR-0028,
//! conventions §1).
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
use super::time::{masters_list, masters_write, RowVersionQuery};
use super::*;
use axum::extract::Query;
use axum::Extension;
use banto_server::AuthenticatedSession;

use crate::direct_costs::{
    DirectCost, DirectCostInput, DirectCostSaved, OrderRevisionInput, ProjectCosts,
    PurchaseOrderInput, PurchaseOrderSaved, PurchaseOrderView,
};
use crate::ops;
use crate::time_entries::{DecisionInput, VersionInput};
use crate::work_masters::{MasterKind, WorkMaster, WorkMasterInput};

// --- vendors (crate::ops::work_masters) --------------------------------------

async fn vendors_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<WorkMaster>>, ApiError> {
    masters_list(&state, &session, MasterKind::Vendors).await
}

async fn vendors_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(&state, &session, MasterKind::Vendors, None, input).await
}

async fn vendors_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(&state, &session, MasterKind::Vendors, Some(id), input).await
}

// --- direct costs (crate::ops::costs) ----------------------------------------

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
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::costs::list_own(&gate, &state.direct_costs, &query.from, &query.to).await?,
    ))
}

async fn costs_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<DirectCostInput>,
) -> Result<Json<DirectCostSaved>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::costs::create(&gate, &state.direct_costs, input).await?,
    ))
}

async fn costs_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<DirectCostInput>,
) -> Result<Json<DirectCostSaved>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::costs::update(&gate, &state.direct_costs, id, input).await?,
    ))
}

async fn costs_delete(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Query(query): Query<RowVersionQuery>,
) -> Result<StatusCode, ApiError> {
    let gate = state.gate(&session).await?;
    ops::costs::delete(&gate, &state.direct_costs, id, query.row_version).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn costs_submit(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<VersionInput>,
) -> Result<Json<DirectCost>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::costs::submit(&gate, &state.direct_costs, id, input).await?,
    ))
}

async fn costs_approvals(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<DirectCost>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::costs::approvals(&gate, &state.direct_costs).await?,
    ))
}

async fn costs_decide(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<DecisionInput>,
) -> Result<Json<DirectCost>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::costs::decide(&gate, &state.direct_costs, id, input).await?,
    ))
}

async fn project_costs(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<ProjectCosts>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::costs::project_costs(&gate, &state.direct_costs, id).await?,
    ))
}

// --- purchase orders (crate::ops::costs) -------------------------------------

async fn orders_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<PurchaseOrderInput>,
) -> Result<Json<PurchaseOrderSaved>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::costs::create_order(&gate, &state.direct_costs, input).await?,
    ))
}

async fn orders_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<PurchaseOrderInput>,
) -> Result<Json<PurchaseOrderView>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::costs::update_order(&gate, &state.direct_costs, id, input).await?,
    ))
}

async fn orders_revise(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<OrderRevisionInput>,
) -> Result<Json<PurchaseOrderView>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::costs::revise_order(&gate, &state.direct_costs, id, input).await?,
    ))
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
        .with_state(super::projects::state(services, audit))
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
        .with_state(super::projects::state(services, audit.clone()))
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
