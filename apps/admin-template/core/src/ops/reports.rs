//! 帳票 (P6c, spec §9, T12・T15): a project's monthly figures and their CSV
//! are `ViewProjectAmounts`; the overall list CSV takes the overall list's
//! scopes ([`Gate::portfolio_scopes`]) and the period monthly CSV the amount
//! scope ([`Gate::amount_scope`]). Each export is audited (`export`) with the
//! kind, its key and the row count, never amounts or names
//! (`CsvExport::audit_detail`).

use banto_admin_services::authz::Operation;
use banto_core::BantoError;
use serde_json::json;

use super::Gate;
use crate::forecasts::ForecastsService;
use crate::reports::{CsvExport, ProjectMonthly, RESOURCE};

pub async fn project_monthly(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    project_id: i64,
) -> Result<ProjectMonthly, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    forecasts.reports().project_monthly(project_id).await
}

pub async fn project_monthly_csv(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    project_id: i64,
) -> Result<CsvExport, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    let csv = forecasts.reports().project_monthly_csv(project_id).await?;
    gate.record(
        "export",
        RESOURCE,
        Some(&project_id.to_string()),
        Some(csv.audit_detail("project_monthly", json!(project_id))),
    )
    .await;
    Ok(csv)
}

pub async fn portfolio_csv(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
) -> Result<CsvExport, BantoError> {
    let (visible, amounts) = gate.portfolio_scopes().await?;
    let csv = forecasts
        .reports()
        .portfolio_csv(&visible, &amounts)
        .await?;
    gate.record(
        "export",
        RESOURCE,
        None,
        Some(csv.audit_detail("portfolio", serde_json::Value::Null)),
    )
    .await;
    Ok(csv)
}

pub async fn period_monthly_csv(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    period: i32,
) -> Result<CsvExport, BantoError> {
    let amounts = gate.amount_scope().await?;
    let csv = forecasts
        .reports()
        .period_monthly_csv(period, &amounts)
        .await?;
    gate.record(
        "export",
        RESOURCE,
        None,
        Some(csv.audit_detail("period_monthly", json!(period))),
    )
    .await;
    Ok(csv)
}
