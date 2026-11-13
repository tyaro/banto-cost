//! `/api/projects/{id}/closeout` (精算完了, banto-cost P6a, spec §5.1, T17).
//! The Tauri twins are the `project_closeout_get` / `project_closeout_settle`
//! / `project_closeout_reopen` commands in `src-tauri`; both sides call the same
//! authorized operation in `crate::ops::closeouts` (decision, service, audit;
//! review §8-13, ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | the check (blockers, the settlement once recorded) | `ViewProjectAmounts` |
//! | settle (with waivers) | `SettleProject` (the manager or accounting; the settler approves the waivers) |
//! | reopen (精算完了の取消, back to 作業完了 with a reason) | `SettleProject` |
//!
//! Audit details carry the project, the status before, the business date
//! and the kinds waived, never amounts (`closeouts::audit_detail`); a
//! reopening carries the settlement cancelled and the dates, not the reason
//! (`closeouts::reopen_audit_detail`).

use super::projects::{BusinessServices, BusinessState};
use super::*;
use axum::Extension;
use banto_server::AuthenticatedSession;

use crate::closeouts::{CloseoutCheck, ReopenInput, SettleInput};
use crate::ops::closeouts as ops;

async fn closeout_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<CloseoutCheck>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::get(&gate, &state.forecasts, id).await?))
}

async fn closeout_settle(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<SettleInput>,
) -> Result<Json<CloseoutCheck>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::settle(&gate, &state.forecasts, id, input).await?))
}

async fn closeout_reopen(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<ReopenInput>,
) -> Result<Json<CloseoutCheck>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::reopen(&gate, &state.forecasts, id, input).await?))
}

/// Reads (session only; the decision is in the handler).
pub(super) fn closeout_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/projects/{id}/closeout", get(closeout_get))
        .with_state(super::projects::state(services, audit))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Writes (`editor` floor, then the handler's decision).
pub(super) fn closeout_write_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/projects/{id}/closeout", post(closeout_settle))
        .route("/api/projects/{id}/closeout/reopen", post(closeout_reopen))
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
