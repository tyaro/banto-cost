//! `/api/projects/{id}/closeout` (精算完了, banto-cost P6a, spec §5.1, T17).
//! The Tauri twins are the `project_closeout_get` / `project_closeout_settle`
//! / `project_closeout_reopen` commands in `src-tauri`; both sides authorize through
//! `AuthzService::authorize_audited` with the same `Operation`s (ADR-0028,
//! conventions §1).
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
use banto_admin_services::authz::Operation;
use banto_server::AuthenticatedSession;

use crate::closeouts::{
    audit_detail, reopen_audit_detail, CloseoutCheck, ReopenInput, SettleInput, RESOURCE,
};

async fn closeout_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<CloseoutCheck>, ApiError> {
    state
        .guard(
            &session,
            Operation::ViewProjectAmounts { project_id: id },
            RESOURCE,
        )
        .await?;
    Ok(Json(state.forecasts.closeouts().check(id).await?))
}

async fn closeout_settle(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<SettleInput>,
) -> Result<Json<CloseoutCheck>, ApiError> {
    let (_, user_id) = state
        .guard(
            &session,
            Operation::SettleProject { project_id: id },
            RESOURCE,
        )
        .await?;
    let settled = state
        .forecasts
        .closeouts()
        .settle(id, input, user_id)
        .await?;
    if let Some(record) = &settled.closeout {
        record_write(
            &state.audit,
            &state.auth,
            &headers,
            "settle",
            RESOURCE,
            Some(&id.to_string()),
            Some(audit_detail(id, record)),
        )
        .await;
    }
    Ok(Json(settled))
}

async fn closeout_reopen(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ReopenInput>,
) -> Result<Json<CloseoutCheck>, ApiError> {
    let (_, user_id) = state
        .guard(
            &session,
            Operation::SettleProject { project_id: id },
            RESOURCE,
        )
        .await?;
    let reopened = state
        .forecasts
        .closeouts()
        .reopen(id, input, user_id)
        .await?;
    if let Some(record) = reopened.history.first() {
        record_write(
            &state.audit,
            &state.auth,
            &headers,
            "reopen",
            RESOURCE,
            Some(&id.to_string()),
            Some(reopen_audit_detail(id, record)),
        )
        .await;
    }
    Ok(Json(reopened))
}

/// Reads (session only; the decision is in the handler).
pub(super) fn closeout_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/projects/{id}/closeout", get(closeout_get))
        .with_state(super::projects::state(services, audit, auth.clone()))
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
