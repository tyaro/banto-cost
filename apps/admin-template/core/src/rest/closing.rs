//! `/api/closing` (月次締め, banto-cost P6b, spec §7 / §9, T11). The Tauri
//! twins are the `closing_months` / `closing_get` / `closing_close` /
//! `closing_reopen` commands in `src-tauri`; both sides authorize through
//! `AuthzService::authorize_audited` with the same `Operation` (ADR-0028,
//! conventions §1).
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
use banto_admin_services::authz::Operation;
use banto_server::AuthenticatedSession;

use crate::closing::{audit_detail, CloseInput, MonthClosing, MonthRow, ReopenInput, RESOURCE};

async fn closing_months(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<MonthRow>>, ApiError> {
    state
        .guard(&session, Operation::CloseMonth, RESOURCE)
        .await?;
    Ok(Json(state.forecasts.closing().months().await?))
}

async fn closing_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(month): Path<String>,
) -> Result<Json<MonthClosing>, ApiError> {
    state
        .guard(&session, Operation::CloseMonth, RESOURCE)
        .await?;
    Ok(Json(state.forecasts.closing().get(&month).await?))
}

async fn closing_close(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(month): Path<String>,
    Json(input): Json<CloseInput>,
) -> Result<Json<MonthClosing>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::CloseMonth, RESOURCE)
        .await?;
    let closed = state
        .forecasts
        .closing()
        .close(&month, input, user_id)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "close",
        RESOURCE,
        Some(&closed.month),
        Some(audit_detail(&closed.month, "close")),
    )
    .await;
    Ok(Json(closed))
}

async fn closing_reopen(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(month): Path<String>,
    Json(input): Json<ReopenInput>,
) -> Result<Json<MonthClosing>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::CloseMonth, RESOURCE)
        .await?;
    let reopened = state
        .forecasts
        .closing()
        .reopen(&month, input, user_id)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "reopen",
        RESOURCE,
        Some(&reopened.month),
        Some(audit_detail(&reopened.month, "reopen")),
    )
    .await;
    Ok(Json(reopened))
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
        .with_state(super::projects::state(services, audit, auth.clone()))
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
