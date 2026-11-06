//! `/api/customers/*`, `/api/projects/*` and the pipeline routes (banto-cost
//! P3a). The Tauri twins are the `customers_*` / `projects_*` / `pipeline_*`
//! commands in `src-tauri`; both sides authorize through
//! `AuthzService::authorize_audited` with the same `Operation`s (ADR-0028,
//! conventions §1), and lists use the same scope functions as the detail
//! decisions (`visible_projects` / `amount_projects`, T12).
//!
//! Role floors: reads need a session; writes need `editor` (Banto's "may
//! enter business data"). On top of the floor:
//!
//! | Route | Decision |
//! |-------|----------|
//! | customers list/get | `admin` role, or `ViewMasters` |
//! | customers create/update | `admin` role, or `EditMasters` |
//! | projects list | `admin` role sees all; others `visible_projects` |
//! | projects get | `admin` role, or `ViewProject` |
//! | projects create | `CreateProject` |
//! | projects update | `EditProject` |
//! | pipeline versions list | `ViewProjectAmounts` |
//! | pipeline version create/adopt | `EditPipeline` |
//! | pipeline overview | scope `amount_projects` |
//!
//! The `admin` role passes the master/basic-information checks because the
//! system administrator maintains masters and assignments (spec §4); it
//! never passes a check that shows amounts.

use super::*;
use axum::Extension;
use banto_admin_services::authz::{
    amount_projects, visible_projects, Actor, AuthzService, Capability, Operation, Policy,
    ProjectScope, Subject,
};
use banto_core::BantoError;
use banto_server::AuthenticatedSession;
use std::str::FromStr;

use crate::customers::{Customer, CustomerInput, CustomersService};
use crate::pipeline::{PipelineOverview, PipelineService, PipelineVersion, PipelineVersionInput};
use crate::projects::{Project, ProjectInput, ProjectsService};

use super::authz::caller_user_id;

#[derive(Clone)]
struct BusinessState {
    customers: CustomersService,
    projects: ProjectsService,
    pipeline: PipelineService,
    authz: AuthzService,
    users: UsersService,
    audit: AuditLogService,
    auth: AuthState,
}

fn is_admin(session: &AuthenticatedSession) -> bool {
    Role::from_str(&session.identity.role).is_ok_and(|role| role.is_admin())
}

impl BusinessState {
    /// Decide `op` for the caller (recording a denial), returning the loaded
    /// subject and the caller's user id.
    async fn guard(
        &self,
        session: &AuthenticatedSession,
        op: Operation,
        resource: &str,
    ) -> Result<(Subject, Option<i64>), BantoError> {
        let user_id = caller_user_id(session, &self.users).await?;
        let (subject, _) = self
            .authz
            .authorize_audited(
                &self.audit,
                Actor {
                    user_id,
                    username: &session.identity.id,
                    role: &session.identity.role,
                },
                op,
                Policy::default(),
                resource,
                "rest",
            )
            .await?;
        Ok((subject, user_id))
    }

    /// As [`Self::guard`], but the `admin` role passes without a capability.
    async fn guard_or_admin(
        &self,
        session: &AuthenticatedSession,
        op: Operation,
        resource: &str,
    ) -> Result<(), BantoError> {
        if !is_admin(session) {
            self.guard(session, op, resource).await?;
        }
        Ok(())
    }

    async fn subject(&self, session: &AuthenticatedSession) -> Result<Subject, BantoError> {
        let user_id = caller_user_id(session, &self.users).await?;
        self.authz.subject(user_id).await
    }
}

// --- customers --------------------------------------------------------------

async fn customers_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(params): Json<ListParams>,
) -> Result<Json<ListResult<Customer>>, ApiError> {
    state
        .guard_or_admin(&session, Operation::ViewMasters, "customers")
        .await?;
    Ok(Json(state.customers.list(params).await?))
}

async fn customers_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<Customer>, ApiError> {
    state
        .guard_or_admin(&session, Operation::ViewMasters, "customers")
        .await?;
    Ok(Json(state.customers.get(id).await?))
}

async fn customers_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<CustomerInput>,
) -> Result<Json<Customer>, ApiError> {
    state
        .guard_or_admin(&session, Operation::EditMasters, "customers")
        .await?;
    let customer = state.customers.create(input).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "customers",
        Some(&customer.id.to_string()),
        Some(json!({ "name": customer.name })),
    )
    .await;
    Ok(Json(customer))
}

async fn customers_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<CustomerInput>,
) -> Result<Json<Customer>, ApiError> {
    state
        .guard_or_admin(&session, Operation::EditMasters, "customers")
        .await?;
    let customer = state.customers.update(id, input).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        "customers",
        Some(&id.to_string()),
        Some(json!({ "name": customer.name, "active": customer.active })),
    )
    .await;
    Ok(Json(customer))
}

// --- projects ---------------------------------------------------------------

async fn projects_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(params): Json<ListParams>,
) -> Result<Json<ListResult<Project>>, ApiError> {
    let scope = if is_admin(&session) {
        ProjectScope::All
    } else {
        visible_projects(&state.subject(&session).await?)
    };
    Ok(Json(state.projects.list(params, &scope).await?))
}

async fn projects_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<Project>, ApiError> {
    state
        .guard_or_admin(
            &session,
            Operation::ViewProject { project_id: id },
            "projects",
        )
        .await?;
    Ok(Json(state.projects.get(id).await?))
}

async fn projects_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<ProjectInput>,
) -> Result<Json<Project>, ApiError> {
    let (subject, user_id) = state
        .guard(&session, Operation::CreateProject, "projects")
        .await?;
    // A sales registrant becomes the project's sales owner (ADR-0028).
    let sales = user_id.filter(|_| subject.has(Capability::PipelineEdit));
    let project = state.projects.create(input, sales).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "projects",
        Some(&project.id.to_string()),
        Some(json!({ "code": project.code, "status": project.status })),
    )
    .await;
    Ok(Json(project))
}

async fn projects_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ProjectInput>,
) -> Result<Json<Project>, ApiError> {
    state
        .guard(
            &session,
            Operation::EditProject { project_id: id },
            "projects",
        )
        .await?;
    let project = state.projects.update(id, input).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        "projects",
        Some(&id.to_string()),
        Some(json!({ "code": project.code, "status": project.status })),
    )
    .await;
    Ok(Json(project))
}

// --- pipeline ---------------------------------------------------------------

async fn pipeline_versions_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<Vec<PipelineVersion>>, ApiError> {
    state
        .guard(
            &session,
            Operation::ViewProjectAmounts { project_id: id },
            "pipeline_versions",
        )
        .await?;
    Ok(Json(state.pipeline.versions(id).await?))
}

async fn pipeline_versions_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<PipelineVersionInput>,
) -> Result<Json<PipelineVersion>, ApiError> {
    let (_, user_id) = state
        .guard(
            &session,
            Operation::EditPipeline { project_id: id },
            "pipeline_versions",
        )
        .await?;
    let version = state.pipeline.create_version(id, input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "pipeline_versions",
        Some(&id.to_string()),
        Some(json!({ "versionNo": version.version_no, "kind": version.kind })),
    )
    .await;
    Ok(Json(version))
}

async fn pipeline_versions_adopt(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path((id, version_id)): Path<(i64, i64)>,
) -> Result<Json<PipelineVersion>, ApiError> {
    let (_, user_id) = state
        .guard(
            &session,
            Operation::EditPipeline { project_id: id },
            "pipeline_versions",
        )
        .await?;
    let version = state.pipeline.adopt(id, version_id, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "adopt",
        "pipeline_versions",
        Some(&id.to_string()),
        Some(json!({ "versionNo": version.version_no })),
    )
    .await;
    Ok(Json(version))
}

async fn pipeline_overview(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<PipelineOverview>, ApiError> {
    let scope = amount_projects(&state.subject(&session).await?);
    Ok(Json(state.pipeline.overview(&scope).await?))
}

/// The services the business routers need, bundled so `api_router` passes one value.
#[derive(Clone)]
pub(super) struct BusinessServices {
    pub customers: CustomersService,
    pub projects: ProjectsService,
    pub pipeline: PipelineService,
    pub authz: AuthzService,
    pub users: UsersService,
}

fn state(services: BusinessServices, audit: AuditLogService, auth: AuthState) -> BusinessState {
    BusinessState {
        customers: services.customers,
        projects: services.projects,
        pipeline: services.pipeline,
        authz: services.authz,
        users: services.users,
        audit,
        auth,
    }
}

/// Business reads (session only; the decision is in each handler).
pub(super) fn business_read_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/customers/list", post(customers_list))
        .route("/api/customers/{id}", get(customers_get))
        .route("/api/projects/list", post(projects_list))
        .route("/api/projects/{id}", get(projects_get))
        .route(
            "/api/projects/{id}/pipeline-versions",
            get(pipeline_versions_list),
        )
        .route("/api/pipeline/overview", get(pipeline_overview))
        .with_state(state(services, audit, auth.clone()))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Business writes (`editor` floor, then the handler's decision).
pub(super) fn business_write_router(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/customers", post(customers_create))
        .route("/api/customers/{id}", axum::routing::put(customers_update))
        .route("/api/projects", post(projects_create))
        .route("/api/projects/{id}", axum::routing::put(projects_update))
        .route(
            "/api/projects/{id}/pipeline-versions",
            post(pipeline_versions_create),
        )
        .route(
            "/api/projects/{id}/pipeline-versions/{versionId}/adopt",
            post(pipeline_versions_adopt),
        )
        .with_state(state(services, audit.clone(), auth.clone()))
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
