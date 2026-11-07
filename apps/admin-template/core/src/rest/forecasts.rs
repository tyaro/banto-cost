//! `/api/projects/{id}/forecast*`, `/api/forecast-versions/*` and
//! `/api/portfolio` (banto-cost P5, spec §6.6・§9, T06・T28・T30). The Tauri
//! twins are the `project_forecast` / `forecast_draft_*` / `portfolio_overview`
//! commands in `src-tauri`; both sides authorize through
//! `AuthzService::authorize_audited` with the same `Operation`s (ADR-0028,
//! conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | project forecast (versions, draft, comparison) | `ViewProjectAmounts` |
//! | create / update / delete a draft | `ManageProject` on the project |
//! | adopt a draft | `AdoptForecast` with `APPROVAL_POLICY` (submitter = last editor) |
//! | portfolio (全体一覧) | rows: `admin` all, others `visible_projects`; amounts and alerts: `amount_projects` |
//!
//! Audit details carry the project, version number, status, base date and
//! line count, never amounts (`ForecastVersion::audit_detail`).

use super::projects::{is_admin, BusinessServices, BusinessState};
use super::*;
use axum::extract::Query;
use axum::Extension;
use banto_admin_services::authz::{amount_projects, visible_projects, Operation, ProjectScope};
use banto_server::AuthenticatedSession;

use crate::approval::APPROVAL_POLICY;
use crate::forecasts::{
    ForecastDraftCreated, ForecastDraftInput, ForecastOverview, ForecastVersion,
    ForecastVersionInput, RESOURCE,
};
use crate::portfolio::Portfolio;

async fn project_forecast(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<ForecastOverview>, ApiError> {
    state
        .guard(
            &session,
            Operation::ViewProjectAmounts { project_id: id },
            RESOURCE,
        )
        .await?;
    Ok(Json(state.forecasts.overview(id).await?))
}

async fn portfolio(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Portfolio>, ApiError> {
    let subject = state.subject(&session).await?;
    let visible = if is_admin(&session) {
        ProjectScope::All
    } else {
        visible_projects(&subject)
    };
    let amounts = amount_projects(&subject);
    Ok(Json(
        state
            .forecasts
            .portfolio()
            .overview(&visible, &amounts)
            .await?,
    ))
}

async fn draft_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<ForecastDraftCreated>, ApiError> {
    let (_, user_id) = state
        .guard(
            &session,
            Operation::ManageProject { project_id: id },
            RESOURCE,
        )
        .await?;
    let created = state.forecasts.create_draft(id, user_id).await?;
    if !created.replayed {
        record_write(
            &state.audit,
            &state.auth,
            &headers,
            "create",
            RESOURCE,
            Some(&created.draft.id.to_string()),
            Some(created.draft.audit_detail()),
        )
        .await;
    }
    Ok(Json(created))
}

async fn draft_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ForecastDraftInput>,
) -> Result<Json<ForecastVersion>, ApiError> {
    let version = state.forecasts.get(id).await?;
    let (_, user_id) = state
        .guard(
            &session,
            Operation::ManageProject {
                project_id: version.project_id,
            },
            RESOURCE,
        )
        .await?;
    let saved = state.forecasts.update_draft(id, input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        RESOURCE,
        Some(&id.to_string()),
        Some(saved.audit_detail()),
    )
    .await;
    Ok(Json(saved))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowVersionQuery {
    row_version: i64,
}

async fn draft_delete(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(query): Query<RowVersionQuery>,
) -> Result<StatusCode, ApiError> {
    let version = state.forecasts.get(id).await?;
    state
        .guard(
            &session,
            Operation::ManageProject {
                project_id: version.project_id,
            },
            RESOURCE,
        )
        .await?;
    state.forecasts.delete_draft(id, query.row_version).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        RESOURCE,
        Some(&id.to_string()),
        Some(version.audit_detail()),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn draft_adopt(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ForecastVersionInput>,
) -> Result<Json<ForecastVersion>, ApiError> {
    let version = state.forecasts.get(id).await?;
    let (_, user_id, allowed) = state
        .guard_with(
            &session,
            Operation::AdoptForecast {
                project_id: version.project_id,
                submitted_by: version.updated_by.unwrap_or(0),
            },
            APPROVAL_POLICY,
            RESOURCE,
        )
        .await?;
    let adopted = state
        .forecasts
        .adopt(&version, input.row_version, user_id)
        .await?;
    let mut detail = adopted.audit_detail();
    detail["selfApproval"] = json!(allowed.self_approval_exception);
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "adopt",
        RESOURCE,
        Some(&id.to_string()),
        Some(detail),
    )
    .await;
    Ok(Json(adopted))
}

/// Reads (session only; the decision is in each handler).
pub(super) fn forecast_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/projects/{id}/forecast", get(project_forecast))
        .route("/api/portfolio", get(portfolio))
        .with_state(super::projects::state(services, audit, auth.clone()))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Writes (`editor` floor, then the handler's decision).
pub(super) fn forecast_write_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/projects/{id}/forecast/draft", post(draft_create))
        .route(
            "/api/forecast-versions/{id}",
            axum::routing::put(draft_update).delete(draft_delete),
        )
        .route("/api/forecast-versions/{id}/adopt", post(draft_adopt))
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
