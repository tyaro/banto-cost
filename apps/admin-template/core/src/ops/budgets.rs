//! 予算 (P4c, spec §5.3, T09): reading a project's budget is
//! `ViewProjectAmounts`; creating, updating and deleting a draft are
//! `ManageProject` on its project; approving is `ApproveBudget` under
//! `APPROVAL_POLICY` (the submitter is the draft's last editor). Audit
//! details carry the project, version number, status and line count, never
//! amounts (`BudgetVersion::audit_detail`).

use banto_admin_services::authz::Operation;
use banto_core::BantoError;
use serde_json::json;

use super::Gate;
use crate::approval::APPROVAL_POLICY;
use crate::budgets::{
    BudgetDraftInput, BudgetOverview, BudgetVersion, BudgetVersionInput, BudgetsService,
    DraftCreated, RESOURCE,
};

pub async fn overview(
    gate: &Gate<'_>,
    budgets: &BudgetsService,
    project_id: i64,
) -> Result<BudgetOverview, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    budgets.overview(project_id).await
}

pub async fn create_draft(
    gate: &Gate<'_>,
    budgets: &BudgetsService,
    project_id: i64,
) -> Result<DraftCreated, BantoError> {
    gate.check(Operation::ManageProject { project_id }, RESOURCE)
        .await?;
    let created = budgets.create_draft(project_id, gate.user_id()).await?;
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
    budgets: &BudgetsService,
    id: i64,
    input: BudgetDraftInput,
) -> Result<BudgetVersion, BantoError> {
    let version = budgets.get(id).await?;
    gate.check(
        Operation::ManageProject {
            project_id: version.project_id,
        },
        RESOURCE,
    )
    .await?;
    let saved = budgets.update_draft(id, input, gate.user_id()).await?;
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
    budgets: &BudgetsService,
    id: i64,
    row_version: i64,
) -> Result<(), BantoError> {
    let version = budgets.get(id).await?;
    gate.check(
        Operation::ManageProject {
            project_id: version.project_id,
        },
        RESOURCE,
    )
    .await?;
    budgets.delete_draft(id, row_version).await?;
    gate.record(
        "delete",
        RESOURCE,
        Some(&id.to_string()),
        Some(version.audit_detail()),
    )
    .await;
    Ok(())
}

pub async fn approve(
    gate: &Gate<'_>,
    budgets: &BudgetsService,
    id: i64,
    input: BudgetVersionInput,
) -> Result<BudgetVersion, BantoError> {
    let version = budgets.get(id).await?;
    let (_, allowed) = gate
        .check_with(
            Operation::ApproveBudget {
                project_id: version.project_id,
                submitted_by: version.updated_by.unwrap_or(0),
            },
            APPROVAL_POLICY,
            RESOURCE,
        )
        .await?;
    let approved = budgets
        .approve(&version, input.row_version, gate.user_id())
        .await?;
    let mut detail = approved.audit_detail();
    detail["selfApproval"] = json!(allowed.self_approval_exception);
    gate.record("approve", RESOURCE, Some(&id.to_string()), Some(detail))
        .await;
    Ok(approved)
}
