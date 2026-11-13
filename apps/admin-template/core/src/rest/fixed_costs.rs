//! `/api/fixed-costs` (月額固定原価, banto-cost P7b, design §9.4, T37). The
//! Tauri twins are the `fixed_cost_*` commands in `src-tauri`; both sides call the same
//! authorized operation in `crate::ops::fixed_costs` (decision, service, audit;
//! review §8-13, ADR-0028, conventions §1).
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
use banto_server::AuthenticatedSession;

use crate::fixed_costs::{CancelInput, Contract, ContractInput, MonthView, PostResult};
use crate::ops::fixed_costs as ops;

async fn contracts_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<Contract>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::contracts(&gate, &state.forecasts).await?))
}

async fn month_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(month): Path<String>,
) -> Result<Json<MonthView>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::month(&gate, &state.forecasts, &month).await?))
}

async fn contract_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<ContractInput>,
) -> Result<Json<Contract>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::create(&gate, &state.forecasts, input).await?))
}

async fn contract_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<ContractInput>,
) -> Result<Json<Contract>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::update(&gate, &state.forecasts, id, input).await?))
}

async fn month_post(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(month): Path<String>,
) -> Result<Json<PostResult>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::post_month(&gate, &state.forecasts, &month).await?,
    ))
}

async fn posting_cancel(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<CancelInput>,
) -> Result<Json<MonthView>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::cancel_posting(&gate, &state.forecasts, id, input).await?,
    ))
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
        .with_state(super::projects::state(services, audit))
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
