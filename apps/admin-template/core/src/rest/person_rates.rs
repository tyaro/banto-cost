//! `/api/person-rates` (個人別単価, banto-cost T43, design §10.9). The Tauri
//! twins are the `person_rates_*` commands in `src-tauri`; both sides call
//! the same authorized operation in `crate::ops::person_rates` (decision,
//! service, audit; review §8-13, ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | the rates on a date | `ViewRates` (`finance.rate` + `amount.view`) |
//! | preview / add a row | `EditRates` (`finance.rate` + `amount.view`) |
//!
//! Audit details carry the person, the project, the date and the version:
//! never the rate or the reason.

use super::projects::{BusinessServices, BusinessState};
use super::*;
use axum::extract::Query;
use axum::Extension;
use banto_server::AuthenticatedSession;
use serde::Deserialize;

use crate::ops::person_rates as ops;
use crate::person_rates::{PersonRateInput, PersonRatePreview, PersonRateRow, PersonRates};

#[derive(Debug, Deserialize)]
struct OnQuery {
    on: String,
}

async fn list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<OnQuery>,
) -> Result<Json<PersonRates>, ApiError> {
    let gate = state.gate(&session).await?;
    let rates = state.calc_basis.person_rates();
    Ok(Json(ops::list(&gate, &rates, &query.on).await?))
}

async fn preview(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<PersonRateInput>,
) -> Result<Json<PersonRatePreview>, ApiError> {
    let gate = state.gate(&session).await?;
    let rates = state.calc_basis.person_rates();
    Ok(Json(ops::preview(&gate, &rates, input).await?))
}

async fn add(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<PersonRateInput>,
) -> Result<Json<PersonRateRow>, ApiError> {
    let gate = state.gate(&session).await?;
    let rates = state.calc_basis.person_rates();
    Ok(Json(ops::add(&gate, &rates, input).await?))
}

/// Reads and the preview (session only; the decision is in the handler).
pub(super) fn person_rates_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/person-rates", get(list))
        .route("/api/person-rates/preview", post(preview))
        .with_state(super::projects::state(services, audit))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Writes (`editor` floor, then the handler's decision).
pub(super) fn person_rates_write_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/person-rates", post(add))
        .with_state(super::projects::state(services, audit.clone()))
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Editor,
                resource: "business",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
