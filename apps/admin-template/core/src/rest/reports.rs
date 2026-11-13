//! `/api/projects/{id}/monthly`, `/api/reports/*.csv` (月別収支と CSV,
//! banto-cost P6c, spec §9, T12・T15). The Tauri twins are the
//! `project_monthly` / `project_monthly_csv` / `portfolio_csv` /
//! `period_monthly_csv` commands in `src-tauri`; both sides call the same
//! authorized operation in `crate::ops::reports` (decision or scopes, service,
//! audit; review §8-13, ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | project monthly figures / its CSV | `ViewProjectAmounts` |
//! | overall list CSV | rows: `admin` all, others `visible_projects`; amounts and alerts: `amount_projects` (as `/api/portfolio`) |
//! | period monthly CSV | `amount_projects` |
//! | business calendar (today, periods) | any signed-in role (no amounts, no names) |
//!
//! Each CSV is returned as JSON (`CsvExport`: file name and content) so the
//! browser and the Tauri webview save it the same way. An export is audited
//! (`export`, resource `reports`) with the kind, its key and the row count:
//! never amounts or names (`CsvExport::audit_detail`).

use super::projects::{BusinessServices, BusinessState};
use super::*;
use axum::extract::Query;
use axum::Extension;
use banto_server::AuthenticatedSession;

use crate::business_date::{calendar, BusinessCalendar};
use crate::ops::reports as ops;
use crate::reports::{CsvExport, PeriodQuery, ProjectMonthly};

/// The business date and the fiscal periods (P8d). Company-wide facts with no
/// amounts or names, so any signed-in role reads them.
async fn business_calendar() -> Json<BusinessCalendar> {
    Json(calendar())
}

async fn project_monthly(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<ProjectMonthly>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::project_monthly(&gate, &state.forecasts, id).await?,
    ))
}

async fn project_monthly_csv(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<CsvExport>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::project_monthly_csv(&gate, &state.forecasts, id).await?,
    ))
}

async fn portfolio_csv(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<CsvExport>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::portfolio_csv(&gate, &state.forecasts).await?))
}

async fn period_monthly_csv(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<PeriodQuery>,
) -> Result<Json<CsvExport>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::period_monthly_csv(&gate, &state.forecasts, query.period).await?,
    ))
}

/// Reads (session only; the decision is in each handler).
pub(super) fn reports_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/projects/{id}/monthly", get(project_monthly))
        .route("/api/projects/{id}/monthly.csv", get(project_monthly_csv))
        .route("/api/reports/portfolio.csv", get(portfolio_csv))
        .route("/api/reports/period-monthly.csv", get(period_monthly_csv))
        .route("/api/calendar", get(business_calendar))
        .with_state(super::projects::state(services, audit))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
