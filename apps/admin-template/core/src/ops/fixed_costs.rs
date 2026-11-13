//! 月額固定原価 (P7b, design §9.4, T37): every step is `ManageFixedCosts`
//! (`finance.rate` + `amount.view`). Audit details carry the action, the
//! contract or the month and the project (`fixed_costs::audit_detail`),
//! never an amount or a reason.

use banto_admin_services::authz::Operation;
use banto_core::BantoError;

use super::Gate;
use crate::fixed_costs::{
    audit_detail, CancelInput, Contract, ContractInput, MonthView, PostResult, RESOURCE,
};
use crate::forecasts::ForecastsService;

const OP: Operation = Operation::ManageFixedCosts;

pub async fn contracts(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
) -> Result<Vec<Contract>, BantoError> {
    gate.check(OP, RESOURCE).await?;
    forecasts.fixed_costs().list().await
}

pub async fn month(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    month: &str,
) -> Result<MonthView, BantoError> {
    gate.check(OP, RESOURCE).await?;
    forecasts.fixed_costs().month(month).await
}

pub async fn create(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    input: ContractInput,
) -> Result<Contract, BantoError> {
    gate.check(OP, RESOURCE).await?;
    let c = forecasts
        .fixed_costs()
        .create(input, gate.user_id())
        .await?;
    gate.record(
        "create",
        RESOURCE,
        Some(&c.id.to_string()),
        Some(audit_detail("create", Some(c.id), None, Some(c.project_id))),
    )
    .await;
    Ok(c)
}

pub async fn update(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    id: i64,
    input: ContractInput,
) -> Result<Contract, BantoError> {
    gate.check(OP, RESOURCE).await?;
    let c = forecasts
        .fixed_costs()
        .update(id, input, gate.user_id())
        .await?;
    gate.record(
        "update",
        RESOURCE,
        Some(&c.id.to_string()),
        Some(audit_detail("update", Some(c.id), None, Some(c.project_id))),
    )
    .await;
    Ok(c)
}

pub async fn post_month(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    month: &str,
) -> Result<PostResult, BantoError> {
    gate.check(OP, RESOURCE).await?;
    let r = forecasts
        .fixed_costs()
        .post_month(month, gate.user_id())
        .await?;
    gate.record(
        "post",
        RESOURCE,
        Some(&r.view.month),
        Some(audit_detail("post", None, Some(&r.view.month), None)),
    )
    .await;
    Ok(r)
}

pub async fn cancel_posting(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    id: i64,
    input: CancelInput,
) -> Result<MonthView, BantoError> {
    gate.check(OP, RESOURCE).await?;
    let svc = forecasts.fixed_costs();
    let (project_id, month) = svc.posting_scope(id).await?;
    let view = svc.cancel(id, input, gate.user_id()).await?;
    gate.record(
        "cancel",
        RESOURCE,
        Some(&id.to_string()),
        Some(audit_detail("cancel", None, Some(&month), Some(project_id))),
    )
    .await;
    Ok(view)
}
