//! `/api/recurring-revenue` (定期売上, banto-cost P7c, design §9.4, T38).
//! The Tauri twins are the `recurring_revenue_*` commands in `src-tauri`;
//! both sides authorize through `AuthzService::authorize_audited` with the
//! same `Operation` (ADR-0028, conventions §1).
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
use banto_admin_services::authz::Operation;
use banto_server::AuthenticatedSession;

use crate::recurring_revenue::{
    audit_detail, Agreement, AgreementInput, MonthView, RecognizeResult, RESOURCE,
};

async fn agreements_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<Agreement>>, ApiError> {
    state
        .guard(&session, Operation::ManageRecurringRevenue, RESOURCE)
        .await?;
    Ok(Json(state.forecasts.recurring_revenue().list().await?))
}

async fn month_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(month): Path<String>,
) -> Result<Json<MonthView>, ApiError> {
    state
        .guard(&session, Operation::ManageRecurringRevenue, RESOURCE)
        .await?;
    Ok(Json(
        state.forecasts.recurring_revenue().month(&month).await?,
    ))
}

async fn agreement_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<AgreementInput>,
) -> Result<Json<Agreement>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::ManageRecurringRevenue, RESOURCE)
        .await?;
    let a = state
        .forecasts
        .recurring_revenue()
        .create(input, user_id)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        RESOURCE,
        Some(&a.id.to_string()),
        Some(audit_detail("create", Some(a.id), None, &[a.project_id])),
    )
    .await;
    Ok(Json(a))
}

async fn agreement_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<AgreementInput>,
) -> Result<Json<Agreement>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::ManageRecurringRevenue, RESOURCE)
        .await?;
    let a = state
        .forecasts
        .recurring_revenue()
        .update(id, input, user_id)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        RESOURCE,
        Some(&a.id.to_string()),
        Some(audit_detail("update", Some(a.id), None, &[a.project_id])),
    )
    .await;
    Ok(Json(a))
}

async fn month_recognize(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(month): Path<String>,
) -> Result<Json<RecognizeResult>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::ManageRecurringRevenue, RESOURCE)
        .await?;
    let r = state
        .forecasts
        .recurring_revenue()
        .recognize_month(&month, user_id)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "recognize",
        RESOURCE,
        Some(&r.view.month),
        Some(audit_detail(
            "recognize",
            None,
            Some(&r.view.month),
            &r.project_ids,
        )),
    )
    .await;
    Ok(Json(r))
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
