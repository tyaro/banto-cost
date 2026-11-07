//! `/api/projects/{id}/budget*` and `/api/budget-versions/*` (banto-cost
//! P4c, spec §5.3, T09). The Tauri twins are the `project_budget` /
//! `budget_draft_*` commands in `src-tauri`; both sides authorize through
//! `AuthzService::authorize_audited` with the same `Operation`s (ADR-0028,
//! conventions §1).
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
use banto_admin_services::authz::Operation;
use banto_server::AuthenticatedSession;

use crate::approval::APPROVAL_POLICY;
use crate::budgets::{
    BudgetDraftInput, BudgetOverview, BudgetVersion, BudgetVersionInput, DraftCreated, RESOURCE,
};

async fn project_budget(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<BudgetOverview>, ApiError> {
    state
        .guard(
            &session,
            Operation::ViewProjectAmounts { project_id: id },
            RESOURCE,
        )
        .await?;
    Ok(Json(state.budgets.overview(id).await?))
}

async fn draft_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<DraftCreated>, ApiError> {
    let (_, user_id) = state
        .guard(
            &session,
            Operation::ManageProject { project_id: id },
            RESOURCE,
        )
        .await?;
    let created = state.budgets.create_draft(id, user_id).await?;
    if !created.replayed {
        record_write(
            &state.audit,
            &state.auth,
            &headers,
            "create",
            RESOURCE,
            Some(&created.draft.id.to_string()),
            Some(created.draft.audit_detail()),
        )
        .await;
    }
    Ok(Json(created))
}

async fn draft_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<BudgetDraftInput>,
) -> Result<Json<BudgetVersion>, ApiError> {
    let version = state.budgets.get(id).await?;
    let (_, user_id) = state
        .guard(
            &session,
            Operation::ManageProject {
                project_id: version.project_id,
            },
            RESOURCE,
        )
        .await?;
    let saved = state.budgets.update_draft(id, input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        RESOURCE,
        Some(&id.to_string()),
        Some(saved.audit_detail()),
    )
    .await;
    Ok(Json(saved))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowVersionQuery {
    row_version: i64,
}

async fn draft_delete(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(query): Query<RowVersionQuery>,
) -> Result<StatusCode, ApiError> {
    let version = state.budgets.get(id).await?;
    state
        .guard(
            &session,
            Operation::ManageProject {
                project_id: version.project_id,
            },
            RESOURCE,
        )
        .await?;
    state.budgets.delete_draft(id, query.row_version).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        RESOURCE,
        Some(&id.to_string()),
        Some(version.audit_detail()),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn draft_approve(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<BudgetVersionInput>,
) -> Result<Json<BudgetVersion>, ApiError> {
    let version = state.budgets.get(id).await?;
    let (_, user_id, allowed) = state
        .guard_with(
            &session,
            Operation::ApproveBudget {
                project_id: version.project_id,
                submitted_by: version.updated_by.unwrap_or(0),
            },
            APPROVAL_POLICY,
            RESOURCE,
        )
        .await?;
    let approved = state
        .budgets
        .approve(&version, input.row_version, user_id)
        .await?;
    let mut detail = approved.audit_detail();
    detail["selfApproval"] = json!(allowed.self_approval_exception);
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "approve",
        RESOURCE,
        Some(&id.to_string()),
        Some(detail),
    )
    .await;
    Ok(Json(approved))
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
