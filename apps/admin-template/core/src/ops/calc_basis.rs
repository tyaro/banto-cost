//! 計算基準 (P4a, design §10): the company basis is `ViewCalcBasis`; adding
//! a company row or previewing its impact is `EditCalcBasis` for the item's
//! change right. A project's basis is `ViewProjectAmounts`; an override or
//! its preview is `OverrideCalcBasis` (the item's right, or the project's
//! manager where the item allows it). Audit details leave the value out
//! (`calc_basis::audit_detail`).

use banto_admin_services::authz::Operation;
use banto_core::BantoError;

use super::Gate;
use crate::calc_basis::{
    audit_detail, CalcBasisService, CalcValueInput, CalcValueRow, CompanyBasis, ImpactPreview,
    ProjectBasis,
};

const RESOURCE: &str = "calc_basis";

/// `EditCalcBasis` for the item the request names.
async fn check_company(
    gate: &Gate<'_>,
    calc_basis: &CalcBasisService,
    input: &CalcValueInput,
) -> Result<(), BantoError> {
    let item = calc_basis.item_for(input).await?;
    gate.check(
        Operation::EditCalcBasis {
            capability: item.capability()?,
        },
        RESOURCE,
    )
    .await?;
    Ok(())
}

/// `OverrideCalcBasis` on the project for the item the request names.
async fn check_project(
    gate: &Gate<'_>,
    calc_basis: &CalcBasisService,
    project_id: i64,
    input: &CalcValueInput,
) -> Result<(), BantoError> {
    let item = calc_basis.item_for(input).await?;
    gate.check(
        Operation::OverrideCalcBasis {
            project_id,
            capability: item.capability()?,
            managers_allowed: item.managers_may_override,
        },
        RESOURCE,
    )
    .await?;
    Ok(())
}

pub async fn company(
    gate: &Gate<'_>,
    calc_basis: &CalcBasisService,
    on: &str,
) -> Result<CompanyBasis, BantoError> {
    gate.check(Operation::ViewCalcBasis, RESOURCE).await?;
    calc_basis.company(on).await
}

pub async fn company_preview(
    gate: &Gate<'_>,
    calc_basis: &CalcBasisService,
    input: CalcValueInput,
) -> Result<ImpactPreview, BantoError> {
    check_company(gate, calc_basis, &input).await?;
    calc_basis.preview(None, input).await
}

pub async fn company_add(
    gate: &Gate<'_>,
    calc_basis: &CalcBasisService,
    input: CalcValueInput,
) -> Result<CalcValueRow, BantoError> {
    check_company(gate, calc_basis, &input).await?;
    let row = calc_basis.add(None, input, gate.user_id()).await?;
    gate.record(
        "create",
        RESOURCE,
        Some(&row.id.to_string()),
        Some(audit_detail(&row)),
    )
    .await;
    Ok(row)
}

pub async fn project(
    gate: &Gate<'_>,
    calc_basis: &CalcBasisService,
    project_id: i64,
    on: &str,
) -> Result<ProjectBasis, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    calc_basis.project(project_id, on).await
}

pub async fn project_preview(
    gate: &Gate<'_>,
    calc_basis: &CalcBasisService,
    project_id: i64,
    input: CalcValueInput,
) -> Result<ImpactPreview, BantoError> {
    check_project(gate, calc_basis, project_id, &input).await?;
    calc_basis.preview(Some(project_id), input).await
}

pub async fn project_add(
    gate: &Gate<'_>,
    calc_basis: &CalcBasisService,
    project_id: i64,
    input: CalcValueInput,
) -> Result<CalcValueRow, BantoError> {
    check_project(gate, calc_basis, project_id, &input).await?;
    let row = calc_basis
        .add(Some(project_id), input, gate.user_id())
        .await?;
    gate.record(
        "override",
        RESOURCE,
        Some(&row.id.to_string()),
        Some(audit_detail(&row)),
    )
    .await;
    Ok(row)
}
