//! 完了見込と全体一覧 (P5, spec §6.6・§9, T06・T28・T30): reading a project's
//! forecast and its summary (the overall list's row of one project) is
//! `ViewProjectAmounts`; creating, updating and deleting a draft are
//! `ManageProject` on its project; adopting is `AdoptForecast` under
//! `APPROVAL_POLICY` (the submitter is the draft's last editor). The overall
//! list takes its scopes from [`Gate::portfolio_scopes`]. Audit details carry
//! the project, version number, status, base date and line count, never
//! amounts (`ForecastVersion::audit_detail`).

use banto_admin_services::authz::Operation;
use banto_core::BantoError;
use serde_json::json;

use super::Gate;
use crate::approval::APPROVAL_POLICY;
use crate::forecasts::{
    ForecastDraftCreated, ForecastDraftInput, ForecastOverview, ForecastVersion,
    ForecastVersionInput, ForecastsService, RESOURCE,
};
use crate::portfolio::{Portfolio, ProjectSummary};

pub async fn overview(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    project_id: i64,
) -> Result<ForecastOverview, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    forecasts.overview(project_id).await
}

/// The summary at the top of the project's page (review D-1).
pub async fn summary(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    project_id: i64,
) -> Result<ProjectSummary, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    forecasts.portfolio().project(project_id).await
}

/// 全体一覧: rows and amounts narrowed by the caller's scopes.
pub async fn portfolio(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
) -> Result<Portfolio, BantoError> {
    let (visible, amounts) = gate.portfolio_scopes().await?;
    forecasts.portfolio().overview(&visible, &amounts).await
}

pub async fn create_draft(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    project_id: i64,
) -> Result<ForecastDraftCreated, BantoError> {
    gate.check(Operation::ManageProject { project_id }, RESOURCE)
        .await?;
    let created = forecasts.create_draft(project_id, gate.user_id()).await?;
    if !created.replayed {
        gate.record(
            "create",
            RESOURCE,
            Some(&created.draft.id.to_string()),
            Some(created.draft.audit_detail()),
        )
        .await;
    }
    Ok(created)
}

pub async fn update_draft(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    id: i64,
    input: ForecastDraftInput,
) -> Result<ForecastVersion, BantoError> {
    let version = forecasts.get(id).await?;
    gate.check(
        Operation::ManageProject {
            project_id: version.project_id,
        },
        RESOURCE,
    )
    .await?;
    let saved = forecasts.update_draft(id, input, gate.user_id()).await?;
    gate.record(
        "update",
        RESOURCE,
        Some(&id.to_string()),
        Some(saved.audit_detail()),
    )
    .await;
    Ok(saved)
}

pub async fn delete_draft(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    id: i64,
    row_version: i64,
) -> Result<(), BantoError> {
    let version = forecasts.get(id).await?;
    gate.check(
        Operation::ManageProject {
            project_id: version.project_id,
        },
        RESOURCE,
    )
    .await?;
    forecasts.delete_draft(id, row_version).await?;
    gate.record(
        "delete",
        RESOURCE,
        Some(&id.to_string()),
        Some(version.audit_detail()),
    )
    .await;
    Ok(())
}

pub async fn adopt(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    id: i64,
    input: ForecastVersionInput,
) -> Result<ForecastVersion, BantoError> {
    let version = forecasts.get(id).await?;
    let (_, allowed) = gate
        .check_with(
            Operation::AdoptForecast {
                project_id: version.project_id,
                submitted_by: version.updated_by.unwrap_or(0),
            },
            APPROVAL_POLICY,
            RESOURCE,
        )
        .await?;
    let adopted = forecasts
        .adopt(&version, input.row_version, gate.user_id())
        .await?;
    let mut detail = adopted.audit_detail();
    detail["selfApproval"] = json!(allowed.self_approval_exception);
    gate.record("adopt", RESOURCE, Some(&id.to_string()), Some(detail))
        .await;
    Ok(adopted)
}
