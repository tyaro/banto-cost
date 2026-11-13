//! 見込 (P3a, spec §5.2): a project's pipeline versions are
//! `ViewProjectAmounts`; saving and adopting a version are `EditPipeline`.
//! The overview is narrowed to `amount_projects` (no `Operation`). Audit
//! details carry the version number and kind, never amounts.

use banto_admin_services::authz::Operation;
use banto_core::BantoError;
use serde_json::json;

use super::Gate;
use crate::pipeline::{PipelineOverview, PipelineService, PipelineVersion, PipelineVersionInput};

const RESOURCE: &str = "pipeline_versions";

pub async fn versions(
    gate: &Gate<'_>,
    pipeline: &PipelineService,
    project_id: i64,
) -> Result<Vec<PipelineVersion>, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    pipeline.versions(project_id).await
}

pub async fn create_version(
    gate: &Gate<'_>,
    pipeline: &PipelineService,
    project_id: i64,
    input: PipelineVersionInput,
) -> Result<PipelineVersion, BantoError> {
    gate.check(Operation::EditPipeline { project_id }, RESOURCE)
        .await?;
    let version = pipeline
        .create_version(project_id, input, gate.user_id())
        .await?;
    gate.record(
        "create",
        RESOURCE,
        Some(&project_id.to_string()),
        Some(json!({ "versionNo": version.version_no, "kind": version.kind })),
    )
    .await;
    Ok(version)
}

pub async fn adopt(
    gate: &Gate<'_>,
    pipeline: &PipelineService,
    project_id: i64,
    version_id: i64,
) -> Result<PipelineVersion, BantoError> {
    gate.check(Operation::EditPipeline { project_id }, RESOURCE)
        .await?;
    let version = pipeline
        .adopt(project_id, version_id, gate.user_id())
        .await?;
    gate.record(
        "adopt",
        RESOURCE,
        Some(&project_id.to_string()),
        Some(json!({ "versionNo": version.version_no })),
    )
    .await;
    Ok(version)
}

pub async fn overview(
    gate: &Gate<'_>,
    pipeline: &PipelineService,
) -> Result<PipelineOverview, BantoError> {
    let scope = gate.amount_scope().await?;
    pipeline.overview(&scope).await
}
