//! `/api/projects/{id}/forecast*`, `/api/forecast-versions/*` and
//! `/api/portfolio`, `/api/projects/{id}/summary` (banto-cost P5, spec §6.6・§9,
//! T06・T28・T30). The Tauri twins are the `project_forecast` /
//! `forecast_draft_*` / `portfolio_overview` / `project_summary` commands in `src-tauri`; both sides call the same
//! authorized operation in `crate::ops::forecasts` (decision, service, audit;
//! review §8-13, ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | project forecast (versions, draft, comparison) | `ViewProjectAmounts` |
//! | project summary (the overall list's row of one project) | `ViewProjectAmounts` |
//! | create / update / delete a draft | `ManageProject` on the project |
//! | adopt a draft | `AdoptForecast` with `APPROVAL_POLICY` (submitter = last editor) |
//! | portfolio (全体一覧) | rows: `admin` all, others `visible_projects`; amounts and alerts: `amount_projects` |
//!
//! Audit details carry the project, version number, status, base date and
//! line count, never amounts (`ForecastVersion::audit_detail`).

use super::projects::{BusinessServices, BusinessState};
use super::*;
use axum::extract::Query;
use axum::Extension;
use banto_server::AuthenticatedSession;

use crate::forecasts::{
    ForecastDraftCreated, ForecastDraftInput, ForecastOverview, ForecastVersion,
    ForecastVersionInput,
};
use crate::ops::forecasts as ops;
use crate::portfolio::{Portfolio, ProjectSummary};

async fn project_forecast(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<ForecastOverview>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::overview(&gate, &state.forecasts, id).await?))
}

/// The summary at the top of the project's page (review D-1): the overall
/// list's row of this project, amounts and alerts included.
async fn project_summary(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<ProjectSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::summary(&gate, &state.forecasts, id).await?))
}

async fn portfolio(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Portfolio>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::portfolio(&gate, &state.forecasts).await?))
}

async fn draft_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<ForecastDraftCreated>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::create_draft(&gate, &state.forecasts, id).await?))
}

async fn draft_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<ForecastDraftInput>,
) -> Result<Json<ForecastVersion>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::update_draft(&gate, &state.forecasts, id, input).await?,
    ))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowVersionQuery {
    row_version: i64,
}

async fn draft_delete(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Query(query): Query<RowVersionQuery>,
) -> Result<StatusCode, ApiError> {
    let gate = state.gate(&session).await?;
    ops::delete_draft(&gate, &state.forecasts, id, query.row_version).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn draft_adopt(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<ForecastVersionInput>,
) -> Result<Json<ForecastVersion>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::adopt(&gate, &state.forecasts, id, input).await?))
}

/// Reads (session only; the decision is in each handler).
pub(super) fn forecast_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/projects/{id}/forecast", get(project_forecast))
        .route("/api/projects/{id}/summary", get(project_summary))
        .route("/api/portfolio", get(portfolio))
        .with_state(super::projects::state(services, audit))
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
