//! `/api/phases/*`, `/api/common-activities/*`, `/api/time-entries/*` and
//! `/api/projects/{id}/time-summary` (banto-cost P4b). The Tauri twins are
//! the `work_masters_*` / `time_entries_*` commands in `src-tauri`; both
//! sides authorize through `AuthzService::authorize_audited` with the same
//! `Operation`s (ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | phases / activities list | `admin` role, or `ViewMasters` |
//! | phases / activities create/update | `admin` role, or `EditMasters` |
//! | own time entries list | `EnterCommonTime` (`time.entry`) |
//! | create / update | `EnterTime` on the project, or `EnterCommonTime`; own draft/returned only |
//! | delete / submit | as above for the entry's target; own draft/returned only |
//! | approvals list | scope `approval_projects`; activities with `finance.close` |
//! | decide | `Approve` (project) / `ApproveCommon` (activity) with `APPROVAL_POLICY` |
//! | project time summary | `ViewProjectAmounts` |
//!
//! An entry's rate and labor cost are shown only to `sees_record_costs`
//! (`finance.rate` + `amount.view`): cost ÷ minutes is the person's rate
//! (spec §4). Audit details carry dates, minutes and targets, never a rate.

use super::projects::{is_admin, BusinessServices, BusinessState};
use super::*;
use axum::extract::Query;
use axum::Extension;
use banto_admin_services::authz::{approval_projects, Capability, Operation, Subject};
use banto_core::BantoError;
use banto_server::AuthenticatedSession;

use crate::approval::APPROVAL_POLICY;
use crate::time_access::{approve_op, enter_op, shown, shown_saved};
use crate::time_entries::{
    DecisionInput, ProjectTimeSummary, TimeEntry, TimeEntryInput, TimeEntrySaved, VersionInput,
};
use crate::work_masters::{MasterKind, WorkMaster, WorkMasterInput};

const RESOURCE: &str = "time_entries";

// --- masters ------------------------------------------------------------------

async fn masters_list(
    state: &BusinessState,
    session: &AuthenticatedSession,
    kind: MasterKind,
) -> Result<Json<Vec<WorkMaster>>, ApiError> {
    if !is_admin(session) {
        state
            .guard(session, Operation::ViewMasters, kind.resource())
            .await?;
    }
    Ok(Json(state.work_masters.list(kind).await?))
}

async fn masters_write(
    state: &BusinessState,
    session: &AuthenticatedSession,
    headers: &HeaderMap,
    kind: MasterKind,
    id: Option<i64>,
    input: WorkMasterInput,
) -> Result<Json<WorkMaster>, ApiError> {
    if !is_admin(session) {
        state
            .guard(session, Operation::EditMasters, kind.resource())
            .await?;
    }
    let (row, action) = match id {
        None => (state.work_masters.create(kind, input).await?, "create"),
        Some(id) => (state.work_masters.update(kind, id, input).await?, "update"),
    };
    record_write(
        &state.audit,
        &state.auth,
        headers,
        action,
        kind.resource(),
        Some(&row.id.to_string()),
        Some(json!({ "name": row.name, "active": row.active })),
    )
    .await;
    Ok(Json(row))
}

async fn phases_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<WorkMaster>>, ApiError> {
    masters_list(&state, &session, MasterKind::Phases).await
}

async fn activities_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<WorkMaster>>, ApiError> {
    masters_list(&state, &session, MasterKind::Activities).await
}

async fn phases_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(&state, &session, &headers, MasterKind::Phases, None, input).await
}

async fn phases_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(
        &state,
        &session,
        &headers,
        MasterKind::Phases,
        Some(id),
        input,
    )
    .await
}

async fn activities_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(
        &state,
        &session,
        &headers,
        MasterKind::Activities,
        None,
        input,
    )
    .await
}

async fn activities_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(
        &state,
        &session,
        &headers,
        MasterKind::Activities,
        Some(id),
        input,
    )
    .await
}

// --- time entries ------------------------------------------------------------

/// Authorize `op` and return the subject and the caller's user row (an
/// entry needs a person: a session without a user row is refused).
async fn entry_guard(
    state: &BusinessState,
    session: &AuthenticatedSession,
    op: Operation,
) -> Result<(Subject, i64), BantoError> {
    let (subject, user_id) = state.guard(session, op, RESOURCE).await?;
    let user_id = user_id.ok_or(BantoError::Forbidden)?;
    Ok((subject, user_id))
}

/// The caller's own entry, as not found when it is someone else's.
async fn own_entry(
    state: &BusinessState,
    session: &AuthenticatedSession,
    id: i64,
) -> Result<TimeEntry, BantoError> {
    let user_id = super::authz::caller_user_id(session, &state.users).await?;
    let entry = state.time_entries.get(id).await?;
    if Some(entry.user_id) != user_id {
        return Err(BantoError::NotFound {
            resource: RESOURCE.into(),
            id: id.to_string(),
        });
    }
    Ok(entry)
}

#[derive(Debug, serde::Deserialize)]
struct RangeQuery {
    from: String,
    to: String,
}

async fn entries_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<RangeQuery>,
) -> Result<Json<Vec<TimeEntry>>, ApiError> {
    let (subject, user_id) = entry_guard(&state, &session, Operation::EnterCommonTime).await?;
    let rows = state
        .time_entries
        .list_own(user_id, &query.from, &query.to)
        .await?;
    Ok(Json(rows.into_iter().map(|e| shown(&subject, e)).collect()))
}

async fn entries_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<TimeEntryInput>,
) -> Result<Json<TimeEntrySaved>, ApiError> {
    let (subject, user_id) = entry_guard(&state, &session, enter_op(input.project_id)).await?;
    let saved = state.time_entries.create(user_id, input).await?;
    if !saved.replayed {
        record_write(
            &state.audit,
            &state.auth,
            &headers,
            "create",
            RESOURCE,
            Some(&saved.entry.id.to_string()),
            Some(saved.entry.audit_detail()),
        )
        .await;
    }
    Ok(Json(shown_saved(&subject, saved)))
}

async fn entries_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<TimeEntryInput>,
) -> Result<Json<TimeEntrySaved>, ApiError> {
    own_entry(&state, &session, id).await?;
    let (subject, user_id) = entry_guard(&state, &session, enter_op(input.project_id)).await?;
    let saved = state.time_entries.update(user_id, id, input).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        RESOURCE,
        Some(&id.to_string()),
        Some(saved.entry.audit_detail()),
    )
    .await;
    Ok(Json(shown_saved(&subject, saved)))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowVersionQuery {
    row_version: i64,
}

async fn entries_delete(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(query): Query<RowVersionQuery>,
) -> Result<StatusCode, ApiError> {
    let entry = own_entry(&state, &session, id).await?;
    let (_, user_id) = entry_guard(&state, &session, enter_op(entry.project_id)).await?;
    state
        .time_entries
        .delete(user_id, id, query.row_version)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        RESOURCE,
        Some(&id.to_string()),
        Some(entry.audit_detail()),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn entries_submit(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<VersionInput>,
) -> Result<Json<TimeEntry>, ApiError> {
    let entry = own_entry(&state, &session, id).await?;
    let (subject, user_id) = entry_guard(&state, &session, enter_op(entry.project_id)).await?;
    let entry = state
        .time_entries
        .submit(user_id, id, input.row_version)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "submit",
        RESOURCE,
        Some(&id.to_string()),
        Some(entry.audit_detail()),
    )
    .await;
    Ok(Json(shown(&subject, entry)))
}

async fn approvals_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<TimeEntry>>, ApiError> {
    let subject = state.subject(&session).await?;
    let scope = approval_projects(&subject);
    let common = subject.is_company_member() && subject.has(Capability::FinanceClose);
    let rows = state.time_entries.approvals(&scope, common).await?;
    Ok(Json(rows.into_iter().map(|e| shown(&subject, e)).collect()))
}

async fn entries_decide(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<DecisionInput>,
) -> Result<Json<TimeEntry>, ApiError> {
    let entry = state.time_entries.get(id).await?;
    let (subject, user_id, allowed) = state
        .guard_with(&session, approve_op(&entry), APPROVAL_POLICY, RESOURCE)
        .await?;
    let approve = input.approve;
    let entry = state.time_entries.decide(id, input, user_id).await?;
    let mut detail = entry.audit_detail();
    detail["selfApproval"] = json!(allowed.self_approval_exception);
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        if approve { "approve" } else { "return" },
        RESOURCE,
        Some(&id.to_string()),
        Some(detail),
    )
    .await;
    Ok(Json(shown(&subject, entry)))
}

async fn project_time_summary(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<ProjectTimeSummary>, ApiError> {
    state
        .guard(
            &session,
            Operation::ViewProjectAmounts { project_id: id },
            RESOURCE,
        )
        .await?;
    Ok(Json(state.time_entries.project_summary(id).await?))
}

/// Reads (session only; the decision is in each handler).
pub(super) fn time_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/phases", get(phases_list))
        .route("/api/common-activities", get(activities_list))
        .route("/api/time-entries", get(entries_list))
        .route("/api/time-entries/approvals", get(approvals_list))
        .route("/api/projects/{id}/time-summary", get(project_time_summary))
        .with_state(super::projects::state(services, audit, auth.clone()))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Writes (`editor` floor, then the handler's decision).
pub(super) fn time_write_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/phases", post(phases_create))
        .route("/api/phases/{id}", axum::routing::put(phases_update))
        .route("/api/common-activities", post(activities_create))
        .route(
            "/api/common-activities/{id}",
            axum::routing::put(activities_update),
        )
        .route("/api/time-entries", post(entries_create))
        .route(
            "/api/time-entries/{id}",
            axum::routing::put(entries_update).delete(entries_delete),
        )
        .route("/api/time-entries/{id}/submit", post(entries_submit))
        .route("/api/time-entries/{id}/decide", post(entries_decide))
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
