//! 月次締め (P6b, spec §7 / §9, T11): every step is `CloseMonth`
//! (`finance.close` + `amount.view`). Audit details carry the month and the
//! action only (`closing::audit_detail`), never the reason or the figures.

use banto_admin_services::authz::Operation;
use banto_core::BantoError;

use super::Gate;
use crate::closing::{audit_detail, CloseInput, MonthClosing, MonthRow, ReopenInput, RESOURCE};
use crate::forecasts::ForecastsService;

pub async fn months(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
) -> Result<Vec<MonthRow>, BantoError> {
    gate.check(Operation::CloseMonth, RESOURCE).await?;
    forecasts.closing().months().await
}

pub async fn get(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    month: &str,
) -> Result<MonthClosing, BantoError> {
    gate.check(Operation::CloseMonth, RESOURCE).await?;
    forecasts.closing().get(month).await
}

pub async fn close(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    month: &str,
    input: CloseInput,
) -> Result<MonthClosing, BantoError> {
    gate.check(Operation::CloseMonth, RESOURCE).await?;
    let closed = forecasts
        .closing()
        .close(month, input, gate.user_id())
        .await?;
    gate.record(
        "close",
        RESOURCE,
        Some(&closed.month),
        Some(audit_detail(&closed.month, "close")),
    )
    .await;
    Ok(closed)
}

pub async fn reopen(
    gate: &Gate<'_>,
    forecasts: &ForecastsService,
    month: &str,
    input: ReopenInput,
) -> Result<MonthClosing, BantoError> {
    gate.check(Operation::CloseMonth, RESOURCE).await?;
    let reopened = forecasts
        .closing()
        .reopen(month, input, gate.user_id())
        .await?;
    gate.record(
        "reopen",
        RESOURCE,
        Some(&reopened.month),
        Some(audit_detail(&reopened.month, "reopen")),
    )
    .await;
    Ok(reopened)
}
