//! `/api/recurring-revenue` (定期売上, banto-cost P7c, design §9.4, T38).
//! The Tauri twins are the `recurring_revenue_*` commands in `src-tauri`;
//! both sides call the same
//! authorized operation in `crate::ops::recurring_revenue` (decision, service, audit;
//! review §8-13, ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | the agreements, a month | `ManageRecurringRevenue` (`finance.close` + `amount.view`) |
//! | register / change an agreement, recognize a month | `ManageRecurringRevenue` |
//!
//! Audit details carry the action, the agreement or the month and the
//! project(s) (`recurring_revenue::audit_detail`): never an amount.

use super::projects::{BusinessServices, BusinessState};
use super::*;
use axum::Extension;
use banto_server::AuthenticatedSession;

use crate::ops::recurring_revenue as ops;
use crate::recurring_revenue::{Agreement, AgreementInput, MonthView, RecognizeResult};

async fn agreements_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<Agreement>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::agreements(&gate, &state.forecasts).await?))
}

async fn month_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(month): Path<String>,
) -> Result<Json<MonthView>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::month(&gate, &state.forecasts, &month).await?))
}

async fn agreement_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<AgreementInput>,
) -> Result<Json<Agreement>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::create(&gate, &state.forecasts, input).await?))
}

async fn agreement_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<AgreementInput>,
) -> Result<Json<Agreement>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::update(&gate, &state.forecasts, id, input).await?))
}

async fn month_recognize(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(month): Path<String>,
) -> Result<Json<RecognizeResult>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::recognize_month(&gate, &state.forecasts, &month).await?,
    ))
}

/// Reads (session only; the decision is in the handler).
pub(super) fn recurring_revenue_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/recurring-revenue/agreements", get(agreements_list))
        .route("/api/recurring-revenue/months/{month}", get(month_get))
        .with_state(super::projects::state(services, audit, auth.clone()))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Writes (`editor` floor, then the handler's decision).
pub(super) fn recurring_revenue_write_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/recurring-revenue/agreements", post(agreement_create))
        .route(
            "/api/recurring-revenue/agreements/{id}",
            axum::routing::put(agreement_update),
        )
        .route(
            "/api/recurring-revenue/months/{month}/recognize",
            post(month_recognize),
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
