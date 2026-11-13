//! 定期売上 (P7c, design §9.4, T38): every step is `ManageRecurringRevenue`
//! (`finance.close` + `amount.view`). Audit details carry the action, the
//! agreement or the month and the project(s)
//! (`recurring_revenue::audit_detail`), never an amount.

use banto_admin_services::authz::Operation;
use banto_core::BantoError;

use super::Gate;
use crate::forecasts::ForecastsService;
use crate::recurring_revenue::{
    audit_detail, Agreement, AgreementInput, MonthView, RecognizeResult, RESOURCE,
};

const OP: Operation = Operation::ManageRecurringRevenue;

pub async fn agreements(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
) -> Result<Vec<Agreement>, BantoError> {
    gate.check(OP, RESOURCE).await?;
    forecasts.recurring_revenue().list().await
}

pub async fn month(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    month: &str,
) -> Result<MonthView, BantoError> {
    gate.check(OP, RESOURCE).await?;
    forecasts.recurring_revenue().month(month).await
}

pub async fn create(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    input: AgreementInput,
) -> Result<Agreement, BantoError> {
    gate.check(OP, RESOURCE).await?;
    let a = forecasts
        .recurring_revenue()
        .create(input, gate.user_id())
        .await?;
    gate.record(
        "create",
        RESOURCE,
        Some(&a.id.to_string()),
        Some(audit_detail("create", Some(a.id), None, &[a.project_id])),
    )
    .await;
    Ok(a)
}

pub async fn update(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    id: i64,
    input: AgreementInput,
) -> Result<Agreement, BantoError> {
    gate.check(OP, RESOURCE).await?;
    let a = forecasts
        .recurring_revenue()
        .update(id, input, gate.user_id())
        .await?;
    gate.record(
        "update",
        RESOURCE,
        Some(&a.id.to_string()),
        Some(audit_detail("update", Some(a.id), None, &[a.project_id])),
    )
    .await;
    Ok(a)
}

pub async fn recognize_month(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    month: &str,
) -> Result<RecognizeResult, BantoError> {
    gate.check(OP, RESOURCE).await?;
    let r = forecasts
        .recurring_revenue()
        .recognize_month(month, gate.user_id())
        .await?;
    gate.record(
        "recognize",
        RESOURCE,
        Some(&r.view.month),
        Some(audit_detail(
            "recognize",
            None,
            Some(&r.view.month),
            &r.project_ids,
        )),
    )
    .await;
    Ok(r)
}
