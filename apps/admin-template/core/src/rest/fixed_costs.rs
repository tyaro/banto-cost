//! `/api/fixed-costs` (月額固定原価, banto-cost P7b, design §9.4, T37). The
//! Tauri twins are the `fixed_cost_*` commands in `src-tauri`; both sides
//! authorize through `AuthzService::authorize_audited` with the same
//! `Operation` (ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | the contracts, a month | `ManageFixedCosts` (`finance.rate` + `amount.view`) |
//! | register / change a contract, post a month, cancel a posting | `ManageFixedCosts` |
//!
//! Audit details carry the action, the contract or the month and the
//! project (`fixed_costs::audit_detail`): never an amount or a reason.

use super::projects::{BusinessServices, BusinessState};
use super::*;
use axum::Extension;
use banto_admin_services::authz::Operation;
use banto_server::AuthenticatedSession;

use crate::fixed_costs::{
    audit_detail, CancelInput, Contract, ContractInput, MonthView, PostResult, RESOURCE,
};

async fn contracts_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<Contract>>, ApiError> {
    state
        .guard(&session, Operation::ManageFixedCosts, RESOURCE)
        .await?;
    Ok(Json(state.forecasts.fixed_costs().list().await?))
}

async fn month_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(month): Path<String>,
) -> Result<Json<MonthView>, ApiError> {
    state
        .guard(&session, Operation::ManageFixedCosts, RESOURCE)
        .await?;
    Ok(Json(state.forecasts.fixed_costs().month(&month).await?))
}

async fn contract_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<ContractInput>,
) -> Result<Json<Contract>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::ManageFixedCosts, RESOURCE)
        .await?;
    let c = state.forecasts.fixed_costs().create(input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        RESOURCE,
        Some(&c.id.to_string()),
        Some(audit_detail("create", Some(c.id), None, Some(c.project_id))),
    )
    .await;
    Ok(Json(c))
}

async fn contract_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ContractInput>,
) -> Result<Json<Contract>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::ManageFixedCosts, RESOURCE)
        .await?;
    let c = state
        .forecasts
        .fixed_costs()
        .update(id, input, user_id)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        RESOURCE,
        Some(&c.id.to_string()),
        Some(audit_detail("update", Some(c.id), None, Some(c.project_id))),
    )
    .await;
    Ok(Json(c))
}

async fn month_post(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(month): Path<String>,
) -> Result<Json<PostResult>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::ManageFixedCosts, RESOURCE)
        .await?;
    let r = state
        .forecasts
        .fixed_costs()
        .post_month(&month, user_id)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "post",
        RESOURCE,
        Some(&r.view.month),
        Some(audit_detail("post", None, Some(&r.view.month), None)),
    )
    .await;
    Ok(Json(r))
}

async fn posting_cancel(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<CancelInput>,
) -> Result<Json<MonthView>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::ManageFixedCosts, RESOURCE)
        .await?;
    let svc = state.forecasts.fixed_costs();
    let (project_id, month) = svc.posting_scope(id).await?;
    let view = svc.cancel(id, input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "cancel",
        RESOURCE,
        Some(&id.to_string()),
        Some(audit_detail("cancel", None, Some(&month), Some(project_id))),
    )
    .await;
    Ok(Json(view))
}

/// Reads (session only; the decision is in the handler).
pub(super) fn fixed_costs_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/fixed-costs/contracts", get(contracts_list))
        .route("/api/fixed-costs/months/{month}", get(month_get))
        .with_state(super::projects::state(services, audit, auth.clone()))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Writes (`editor` floor, then the handler's decision).
pub(super) fn fixed_costs_write_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/fixed-costs/contracts", post(contract_create))
        .route(
            "/api/fixed-costs/contracts/{id}",
            axum::routing::put(contract_update),
        )
        .route("/api/fixed-costs/months/{month}/post", post(month_post))
        .route(
            "/api/fixed-costs/postings/{id}/cancel",
            post(posting_cancel),
        )
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
