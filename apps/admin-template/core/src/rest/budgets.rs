//! `/api/projects/{id}/budget*` and `/api/budget-versions/*` (banto-cost
//! P4c, spec §5.3, T09). The Tauri twins are the `project_budget` /
//! `budget_draft_*` commands in `src-tauri`; both sides call the same
//! authorized operation in `crate::ops::budgets` (decision, service, audit;
//! review §8-13, ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | project budget (versions, draft, comparison) | `ViewProjectAmounts` |
//! | create / update / delete a draft | `ManageProject` on the project |
//! | approve a draft | `ApproveBudget` with `APPROVAL_POLICY` (submitter = last editor) |
//!
//! Audit details carry the project, version number, status and line count,
//! never amounts (`BudgetVersion::audit_detail`).

use super::projects::{BusinessServices, BusinessState};
use super::*;
use axum::extract::Query;
use axum::Extension;
use banto_server::AuthenticatedSession;

use crate::budgets::{
    BudgetDraftInput, BudgetOverview, BudgetVersion, BudgetVersionInput, DraftCreated,
};
use crate::ops::budgets as ops;

async fn project_budget(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<BudgetOverview>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::overview(&gate, &state.budgets, id).await?))
}

async fn draft_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<DraftCreated>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::create_draft(&gate, &state.budgets, id).await?))
}

async fn draft_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<BudgetDraftInput>,
) -> Result<Json<BudgetVersion>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::update_draft(&gate, &state.budgets, id, input).await?,
    ))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowVersionQuery {
    row_version: i64,
}

async fn draft_delete(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Query(query): Query<RowVersionQuery>,
) -> Result<StatusCode, ApiError> {
    let gate = state.gate(&session).await?;
    ops::delete_draft(&gate, &state.budgets, id, query.row_version).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn draft_approve(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<BudgetVersionInput>,
) -> Result<Json<BudgetVersion>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::approve(&gate, &state.budgets, id, input).await?))
}

/// Reads (session only; the decision is in each handler).
pub(super) fn budget_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/projects/{id}/budget", get(project_budget))
        .with_state(super::projects::state(services, audit, auth.clone()))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Writes (`editor` floor, then the handler's decision).
pub(super) fn budget_write_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/projects/{id}/budget/draft", post(draft_create))
        .route(
            "/api/budget-versions/{id}",
            axum::routing::put(draft_update).delete(draft_delete),
        )
        .route("/api/budget-versions/{id}/approve", post(draft_approve))
        .with_state(super::projects::state(
            services,
            audit.clone(),
            auth.clone(),
        ))
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
