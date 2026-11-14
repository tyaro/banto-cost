//! 個人別単価 (design §10.9, T43): viewing is `ViewRates`, adding a row or
//! previewing its impact `EditRates` (both `finance.rate` + `amount.view`;
//! the rates are per person). Audit details leave the rate and the reason
//! out (`person_rates::audit_detail`).

use banto_admin_services::authz::Operation;
use banto_core::BantoError;

use super::Gate;
use crate::person_rates::{
    audit_detail, PersonRateInput, PersonRatePreview, PersonRateRow, PersonRates,
    PersonRatesService,
};

pub const RESOURCE: &str = "person_rates";

pub async fn list(
    gate: &Gate<'_>,
    rates: &PersonRatesService,
    on: &str,
) -> Result<PersonRates, BantoError> {
    gate.check(Operation::ViewRates, RESOURCE).await?;
    rates.list(on).await
}

pub async fn preview(
    gate: &Gate<'_>,
    rates: &PersonRatesService,
    input: PersonRateInput,
) -> Result<PersonRatePreview, BantoError> {
    gate.check(Operation::EditRates, RESOURCE).await?;
    rates.preview(input).await
}

pub async fn add(
    gate: &Gate<'_>,
    rates: &PersonRatesService,
    input: PersonRateInput,
) -> Result<PersonRateRow, BantoError> {
    gate.check(Operation::EditRates, RESOURCE).await?;
    let row = rates.add(input, gate.user_id()).await?;
    gate.record(
        "create",
        RESOURCE,
        Some(&row.id.to_string()),
        Some(audit_detail(&row)),
    )
    .await;
    Ok(row)
}
