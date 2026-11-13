//! 精算完了 (P6a, spec §5.1, T17): the check is `ViewProjectAmounts`;
//! settling (with waivers) and reopening are `SettleProject` (the manager or
//! accounting). Audit details carry no amount and no reason
//! (`closeouts::audit_detail`, `closeouts::reopen_audit_detail`).

use banto_admin_services::authz::Operation;
use banto_core::BantoError;

use super::Gate;
use crate::closeouts::{
    audit_detail, reopen_audit_detail, CloseoutCheck, ReopenInput, SettleInput, RESOURCE,
};
use crate::forecasts::ForecastsService;

pub async fn get(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    project_id: i64,
) -> Result<CloseoutCheck, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    forecasts.closeouts().check(project_id).await
}

pub async fn settle(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    project_id: i64,
    input: SettleInput,
) -> Result<CloseoutCheck, BantoError> {
    gate.check(Operation::SettleProject { project_id }, RESOURCE)
        .await?;
    let settled = forecasts
        .closeouts()
        .settle(project_id, input, gate.user_id())
        .await?;
    if let Some(record) = &settled.closeout {
        gate.record(
            "settle",
            RESOURCE,
            Some(&project_id.to_string()),
            Some(audit_detail(project_id, record)),
        )
        .await;
    }
    Ok(settled)
}

pub async fn reopen(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    project_id: i64,
    input: ReopenInput,
) -> Result<CloseoutCheck, BantoError> {
    gate.check(Operation::SettleProject { project_id }, RESOURCE)
        .await?;
    let reopened = forecasts
        .closeouts()
        .reopen(project_id, input, gate.user_id())
        .await?;
    if let Some(record) = reopened.history.first() {
        gate.record(
            "reopen",
            RESOURCE,
            Some(&project_id.to_string()),
            Some(reopen_audit_detail(project_id, record)),
        )
        .await;
    }
    Ok(reopened)
}
