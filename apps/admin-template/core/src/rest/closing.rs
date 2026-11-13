//! `/api/closing` (月次締め, banto-cost P6b, spec §7 / §9, T11). The Tauri
//! twins are the `closing_months` / `closing_get` / `closing_close` /
//! `closing_reopen` commands in `src-tauri`; both sides call the same
//! authorized operation in `crate::ops::closing` (decision, service, audit;
//! review §8-13, ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | the list, a month (check, history, figures) | `CloseMonth` (`finance.close` + `amount.view`) |
//! | close / reopen (with a reason) | `CloseMonth` |
//!
//! Audit details carry the month and the action only
//! (`closing::audit_detail`): never the reopening's reason or the figures.

use super::projects::{BusinessServices, BusinessState};
use super::*;
use axum::Extension;
use banto_server::AuthenticatedSession;

use crate::closing::{CloseInput, MonthClosing, MonthRow, ReopenInput};
use crate::ops::closing as ops;

async fn closing_months(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<MonthRow>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::months(&gate, &state.forecasts).await?))
}

async fn closing_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(month): Path<String>,
) -> Result<Json<MonthClosing>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::get(&gate, &state.forecasts, &month).await?))
}

async fn closing_close(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(month): Path<String>,
    Json(input): Json<CloseInput>,
) -> Result<Json<MonthClosing>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::close(&gate, &state.forecasts, &month, input).await?,
    ))
}

async fn closing_reopen(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(month): Path<String>,
    Json(input): Json<ReopenInput>,
) -> Result<Json<MonthClosing>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::reopen(&gate, &state.forecasts, &month, input).await?,
    ))
}

/// Reads (session only; the decision is in the handler).
pub(super) fn closing_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/closing", get(closing_months))
        .route("/api/closing/{month}", get(closing_get))
        .with_state(super::projects::state(services, audit))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Writes (`editor` floor, then the handler's decision).
pub(super) fn closing_write_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/closing/{month}/close", post(closing_close))
        .route("/api/closing/{month}/reopen", post(closing_reopen))
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
