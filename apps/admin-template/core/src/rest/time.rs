//! `/api/phases/*`, `/api/common-activities/*`, `/api/time-entries/*` and
//! `/api/projects/{id}/time-summary` (banto-cost P4b). The Tauri twins are
//! the `phases_*` / `common_activities_*` / `time_entries_*` commands in
//! `src-tauri`; both call the same authorized operations
//! (`crate::ops::work_masters`, `crate::ops::time`, review §8-13) and keep
//! only the role floor and the arguments here (ADR-0028, conventions §1).
//!
//! | Route | Decision |
//! |-------|----------|
//! | phases / activities list | `admin` role, or `ViewMasters` |
//! | phases / activities create/update | `admin` role, or `EditMasters` |
//! | own time entries list | `EnterCommonTime` (`time.entry`); drafts carry `canApprove` (the decide rule, `shown_own`) |
//! | create / update | `EnterTime` on the project, or `EnterCommonTime`; own draft/returned only |
//! | delete / submit | as above for the entry's target; own draft/returned only |
//! | approvals list | scope `approval_projects`; activities with `finance.close` |
//! | decide | `Approve` (project) / `ApproveCommon` (activity) / `ApproveCorrection` (a correction) with `APPROVAL_POLICY` |
//! | correct | own approved entry; `EnterTime` / `EnterCommonTime` on the corrected target |
//! | an entry's corrections | own entry; `EnterCommonTime` |
//! | pending corrections | `finance.close` (others: empty) |
//! | project time summary | `ViewProjectAmounts` |
//! | rerate candidates | `EditRates` + `FinanceClose` (単価の当て直し, T45) |
//! | rerate an entry | `EditRates` + `ApproveCorrection` with `APPROVAL_POLICY` |
//!
//! An entry's rate and labor cost are shown only to `sees_record_costs`
//! (`finance.rate` + `amount.view`): cost ÷ minutes is the person's rate
//! (spec §4). Audit details carry dates, minutes and targets, never a rate.

use super::projects::{BusinessServices, BusinessState};
use super::*;
use axum::extract::Query;
use axum::Extension;
use banto_server::AuthenticatedSession;

use crate::ops;
use crate::time_entries::{
    CorrectionInput, CorrectionPair, DecisionInput, ProjectTimeSummary, RerateInput, RerateList,
    TimeEntry, TimeEntryInput, TimeEntrySaved, VersionInput,
};
use crate::work_masters::{MasterKind, WorkMaster, WorkMasterInput};

// --- masters (crate::ops::work_masters) --------------------------------------

pub(super) async fn masters_list(
    state: &BusinessState,
    session: &AuthenticatedSession,
    kind: MasterKind,
) -> Result<Json<Vec<WorkMaster>>, ApiError> {
    let gate = state.gate(session).await?;
    Ok(Json(
        ops::work_masters::list(&gate, &state.work_masters, kind).await?,
    ))
}

pub(super) async fn masters_write(
    state: &BusinessState,
    session: &AuthenticatedSession,
    kind: MasterKind,
    id: Option<i64>,
    input: WorkMasterInput,
) -> Result<Json<WorkMaster>, ApiError> {
    let gate = state.gate(session).await?;
    Ok(Json(
        ops::work_masters::write(&gate, &state.work_masters, kind, id, input).await?,
    ))
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
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(&state, &session, MasterKind::Phases, None, input).await
}

async fn phases_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(&state, &session, MasterKind::Phases, Some(id), input).await
}

async fn activities_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(&state, &session, MasterKind::Activities, None, input).await
}

async fn activities_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<WorkMasterInput>,
) -> Result<Json<WorkMaster>, ApiError> {
    masters_write(&state, &session, MasterKind::Activities, Some(id), input).await
}

// --- time entries (crate::ops::time) -----------------------------------------

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
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::list_own(&gate, &state.time_entries, &query.from, &query.to).await?,
    ))
}

async fn entries_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<TimeEntryInput>,
) -> Result<Json<TimeEntrySaved>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::create(&gate, &state.time_entries, input).await?,
    ))
}

async fn entries_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<TimeEntryInput>,
) -> Result<Json<TimeEntrySaved>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::update(&gate, &state.time_entries, id, input).await?,
    ))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RowVersionQuery {
    pub(super) row_version: i64,
}

async fn entries_delete(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Query(query): Query<RowVersionQuery>,
) -> Result<StatusCode, ApiError> {
    let gate = state.gate(&session).await?;
    ops::time::delete(&gate, &state.time_entries, id, query.row_version).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn entries_submit(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<VersionInput>,
) -> Result<Json<TimeEntry>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::submit(&gate, &state.time_entries, id, input).await?,
    ))
}

async fn approvals_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<TimeEntry>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::approvals(&gate, &state.time_entries).await?,
    ))
}

async fn entries_decide(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<DecisionInput>,
) -> Result<Json<TimeEntry>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::decide(&gate, &state.time_entries, id, input).await?,
    ))
}

async fn entries_correct(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<CorrectionInput>,
) -> Result<Json<TimeEntrySaved>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::correct(&gate, &state.time_entries, id, input).await?,
    ))
}

async fn entries_corrections(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<Vec<TimeEntry>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::corrections_of(&gate, &state.time_entries, id).await?,
    ))
}

async fn corrections_pending(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<CorrectionPair>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::pending_corrections(&gate, &state.time_entries).await?,
    ))
}

async fn project_time_summary(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<ProjectTimeSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::project_summary(&gate, &state.time_entries, id).await?,
    ))
}

async fn rerates_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<RerateList>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::rerate_candidates(&gate, &state.time_entries).await?,
    ))
}

async fn entries_rerate(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<RerateInput>,
) -> Result<Json<TimeEntry>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::time::rerate(&gate, &state.time_entries, id, input).await?,
    ))
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
        .route("/api/time-entries/corrections", get(corrections_pending))
        .route("/api/time-entries/rerates", get(rerates_list))
        .route(
            "/api/time-entries/{id}/corrections",
            get(entries_corrections),
        )
        .route("/api/projects/{id}/time-summary", get(project_time_summary))
        .with_state(super::projects::state(services, audit))
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
        .route("/api/time-entries/{id}/correct", post(entries_correct))
        .route("/api/time-entries/{id}/rerate", post(entries_rerate))
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
