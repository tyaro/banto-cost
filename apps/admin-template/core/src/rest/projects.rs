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
//! | order get | `ViewProjectAmounts` |
//! | order convert / change request / revenue plan | `EditOrder` |
//! | order change decide | `ViewProjectAmounts` + `Approve` (self-approval allowed, audited) |
//! | revenue recognition create/cancel | `FinanceClose` + `ViewProjectAmounts` |
//! | outlook / snapshot view | scope `amount_projects` |
//! | snapshots list | `ViewMasters` |
//! | snapshot create | `ViewAllReports` |
//! | company calc basis | `ViewCalcBasis` |
//! | company calc basis add / preview | `EditCalcBasis` (the item's change right) |
//! | project calc basis | `ViewProjectAmounts` |
//! | project override add / preview | `OverrideCalcBasis` |
//!
//! Self-approval: banto-cost is run by one person in a small company
//! (user decision 2026-11-06), so the order-change decision allows it
//! (spec §4's small-team exception) and records `selfApproval` in the audit
//! detail.
//!
//! The `admin` role passes the master/basic-information checks because the
//! system administrator maintains masters and assignments (spec §4); it
//! never passes a check that shows amounts.

use super::*;
use axum::extract::Query;
use axum::Extension;
use banto_admin_services::authz::{
    amount_projects, visible_projects, Actor, Allowed, AuthzService, Capability, Operation, Policy,
    ProjectScope, Subject,
};
use banto_core::BantoError;
use banto_server::AuthenticatedSession;
use std::str::FromStr;

use crate::calc_basis::{
    audit_detail, CalcBasisService, CalcValueInput, CalcValueRow, CompanyBasis, ImpactPreview,
    ProjectBasis,
};
use crate::customers::{Customer, CustomerInput, CustomersService};
use crate::orders::outlook::{OutlookQuery, OutlookView, SnapshotInfo};
use crate::orders::{
    CancelInput, ChangeDecision, ChangeRequest, ConversionRequest, OrderSummary, OrdersService,
    RecognitionInput, ReplanInput,
};
use crate::pipeline::{PipelineOverview, PipelineService, PipelineVersion, PipelineVersionInput};
use crate::projects::{Project, ProjectInput, ProjectsService};
use crate::time_entries::TimeEntriesService;
use crate::work_masters::WorkMastersService;

use super::authz::caller_user_id;

#[derive(Clone)]
pub(super) struct BusinessState {
    pub(super) customers: CustomersService,
    pub(super) projects: ProjectsService,
    pub(super) pipeline: PipelineService,
    pub(super) orders: OrdersService,
    pub(super) calc_basis: CalcBasisService,
    pub(super) work_masters: WorkMastersService,
    pub(super) time_entries: TimeEntriesService,
    pub(super) authz: AuthzService,
    pub(super) users: UsersService,
    pub(super) audit: AuditLogService,
    pub(super) auth: AuthState,
}

pub(super) fn is_admin(session: &AuthenticatedSession) -> bool {
    Role::from_str(&session.identity.role).is_ok_and(|role| role.is_admin())
}

impl BusinessState {
    /// Decide `op` for the caller (recording a denial), returning the loaded
    /// subject and the caller's user id.
    pub(super) async fn guard(
        &self,
        session: &AuthenticatedSession,
        op: Operation,
        resource: &str,
    ) -> Result<(Subject, Option<i64>), BantoError> {
        let (subject, user_id, _) = self
            .guard_with(session, op, Policy::default(), resource)
            .await?;
        Ok((subject, user_id))
    }

    /// As [`Self::guard`] with an explicit policy, also returning the decision.
    pub(super) async fn guard_with(
        &self,
        session: &AuthenticatedSession,
        op: Operation,
        policy: Policy,
        resource: &str,
    ) -> Result<(Subject, Option<i64>, Allowed), BantoError> {
        let user_id = caller_user_id(session, &self.users).await?;
        let (subject, allowed) = self
            .authz
            .authorize_audited(
                &self.audit,
                Actor {
                    user_id,
                    username: &session.identity.id,
                    role: &session.identity.role,
                },
                op,
                policy,
                resource,
                "rest",
            )
            .await?;
        Ok((subject, user_id, allowed))
    }

    /// As [`Self::guard`], but the `admin` role passes without a capability.
    pub(super) async fn guard_or_admin(
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

    pub(super) async fn subject(
        &self,
        session: &AuthenticatedSession,
    ) -> Result<Subject, BantoError> {
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

// --- orders (P3b) -------------------------------------------------------------

async fn order_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<OrderSummary>, ApiError> {
    state
        .guard(
            &session,
            Operation::ViewProjectAmounts { project_id: id },
            "orders",
        )
        .await?;
    Ok(Json(state.orders.summary(id).await?))
}

async fn order_convert(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ConversionRequest>,
) -> Result<Json<OrderSummary>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::EditOrder { project_id: id }, "orders")
        .await?;
    let summary = state.orders.convert(id, input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "convert",
        "orders",
        Some(&id.to_string()),
        Some(json!({
            "confirmedAmount": summary.confirmed_amount,
            "scope": summary.conversion.as_ref().map(|c| c.scope.clone()),
            "remainderProjectId": summary.conversion.as_ref().and_then(|c| c.remainder_project_id),
        })),
    )
    .await;
    Ok(Json(summary))
}

async fn order_change_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ChangeRequest>,
) -> Result<Json<OrderSummary>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::EditOrder { project_id: id }, "orders")
        .await?;
    let delta = input.delta_amount;
    let summary = state.orders.request_change(id, input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "request_change",
        "orders",
        Some(&id.to_string()),
        Some(json!({ "deltaAmount": delta })),
    )
    .await;
    Ok(Json(summary))
}

async fn order_change_decide(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path((id, change_id)): Path<(i64, i64)>,
    Json(input): Json<ChangeDecision>,
) -> Result<Json<OrderSummary>, ApiError> {
    state
        .guard(
            &session,
            Operation::ViewProjectAmounts { project_id: id },
            "orders",
        )
        .await?;
    let requester = state.orders.change_requester(id, change_id).await?;
    let (_, user_id, allowed) = state
        .guard_with(
            &session,
            Operation::Approve {
                project_id: id,
                // A request without a requester (deleted user) is nobody's own.
                submitted_by: requester.unwrap_or(0),
            },
            crate::approval::APPROVAL_POLICY,
            "orders",
        )
        .await?;
    let approve = input.approve;
    let summary = state
        .orders
        .decide_change(id, change_id, input, user_id)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        if approve {
            "approve_change"
        } else {
            "reject_change"
        },
        "orders",
        Some(&id.to_string()),
        Some(json!({
            "changeId": change_id,
            "selfApproval": allowed.self_approval_exception,
        })),
    )
    .await;
    Ok(Json(summary))
}

async fn revenue_plan_replace(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ReplanInput>,
) -> Result<Json<OrderSummary>, ApiError> {
    state
        .guard(&session, Operation::EditOrder { project_id: id }, "orders")
        .await?;
    let summary = state.orders.replan(id, input).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "replan",
        "orders",
        Some(&id.to_string()),
        Some(json!({ "lines": summary.plan.len() })),
    )
    .await;
    Ok(Json(summary))
}

/// Revenue recognition is accounting's (`FinanceClose`) and shows amounts.
async fn finance_guard(
    state: &BusinessState,
    session: &AuthenticatedSession,
    project_id: i64,
) -> Result<Option<i64>, BantoError> {
    let (_, user_id) = state
        .guard(session, Operation::FinanceClose, "revenue_recognitions")
        .await?;
    state
        .guard(
            session,
            Operation::ViewProjectAmounts { project_id },
            "revenue_recognitions",
        )
        .await?;
    Ok(user_id)
}

async fn recognition_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<RecognitionInput>,
) -> Result<Json<OrderSummary>, ApiError> {
    let user_id = finance_guard(&state, &session, id).await?;
    let amount = input.amount;
    let summary = state.orders.recognize(id, input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "revenue_recognitions",
        Some(&id.to_string()),
        Some(json!({ "amount": amount })),
    )
    .await;
    Ok(Json(summary))
}

async fn recognition_cancel(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path((id, recognition_id)): Path<(i64, i64)>,
    Json(input): Json<CancelInput>,
) -> Result<Json<OrderSummary>, ApiError> {
    let user_id = finance_guard(&state, &session, id).await?;
    let summary = state
        .orders
        .cancel_recognition(id, recognition_id, input, user_id)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "cancel",
        "revenue_recognitions",
        Some(&id.to_string()),
        Some(json!({ "recognitionId": recognition_id })),
    )
    .await;
    Ok(Json(summary))
}

// --- outlook (P3b) ------------------------------------------------------------

async fn outlook_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<OutlookQuery>,
) -> Result<Json<OutlookView>, ApiError> {
    let scope = amount_projects(&state.subject(&session).await?);
    Ok(Json(state.orders.outlook(&scope, query).await?))
}

async fn outlook_snapshots_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<SnapshotInfo>>, ApiError> {
    state
        .guard(&session, Operation::ViewMasters, "outlook_snapshots")
        .await?;
    Ok(Json(state.orders.snapshots().await?))
}

async fn outlook_snapshot_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Query(query): Query<OutlookQuery>,
) -> Result<Json<OutlookView>, ApiError> {
    let scope = amount_projects(&state.subject(&session).await?);
    Ok(Json(state.orders.snapshot_view(id, &scope, query).await?))
}

#[derive(serde::Deserialize)]
struct SnapshotCreate {
    #[serde(default)]
    label: Option<String>,
}

async fn outlook_snapshot_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<SnapshotCreate>,
) -> Result<Json<SnapshotInfo>, ApiError> {
    let (_, user_id) = state
        .guard(&session, Operation::ViewAllReports, "outlook_snapshots")
        .await?;
    let snapshot = state.orders.save_snapshot(input.label, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "outlook_snapshots",
        Some(&snapshot.id.to_string()),
        Some(json!({ "label": snapshot.label })),
    )
    .await;
    Ok(Json(snapshot))
}

// --- calc basis (P4a) -------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
struct OnQuery {
    on: String,
}

/// `EditCalcBasis` for the item the request names.
async fn company_basis_guard(
    state: &BusinessState,
    session: &AuthenticatedSession,
    input: &CalcValueInput,
) -> Result<Option<i64>, BantoError> {
    let item = state.calc_basis.item_for(input).await?;
    let (_, user_id) = state
        .guard(
            session,
            Operation::EditCalcBasis {
                capability: item.capability()?,
            },
            "calc_basis",
        )
        .await?;
    Ok(user_id)
}

/// `OverrideCalcBasis` on the project for the item the request names.
async fn project_basis_guard(
    state: &BusinessState,
    session: &AuthenticatedSession,
    project_id: i64,
    input: &CalcValueInput,
) -> Result<Option<i64>, BantoError> {
    let item = state.calc_basis.item_for(input).await?;
    let (_, user_id) = state
        .guard(
            session,
            Operation::OverrideCalcBasis {
                project_id,
                capability: item.capability()?,
                managers_allowed: item.managers_may_override,
            },
            "calc_basis",
        )
        .await?;
    Ok(user_id)
}

async fn calc_basis_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<OnQuery>,
) -> Result<Json<CompanyBasis>, ApiError> {
    state
        .guard(&session, Operation::ViewCalcBasis, "calc_basis")
        .await?;
    Ok(Json(state.calc_basis.company(&query.on).await?))
}

async fn calc_basis_preview(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<CalcValueInput>,
) -> Result<Json<ImpactPreview>, ApiError> {
    company_basis_guard(&state, &session, &input).await?;
    Ok(Json(state.calc_basis.preview(None, input).await?))
}

async fn calc_basis_add(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(input): Json<CalcValueInput>,
) -> Result<Json<CalcValueRow>, ApiError> {
    let user_id = company_basis_guard(&state, &session, &input).await?;
    let row = state.calc_basis.add(None, input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "calc_basis",
        Some(&row.id.to_string()),
        Some(audit_detail(&row)),
    )
    .await;
    Ok(Json(row))
}

async fn project_basis_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Query(query): Query<OnQuery>,
) -> Result<Json<ProjectBasis>, ApiError> {
    state
        .guard(
            &session,
            Operation::ViewProjectAmounts { project_id: id },
            "calc_basis",
        )
        .await?;
    Ok(Json(state.calc_basis.project(id, &query.on).await?))
}

async fn project_basis_preview(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<CalcValueInput>,
) -> Result<Json<ImpactPreview>, ApiError> {
    project_basis_guard(&state, &session, id, &input).await?;
    Ok(Json(state.calc_basis.preview(Some(id), input).await?))
}

async fn project_basis_add(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<CalcValueInput>,
) -> Result<Json<CalcValueRow>, ApiError> {
    let user_id = project_basis_guard(&state, &session, id, &input).await?;
    let row = state.calc_basis.add(Some(id), input, user_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "override",
        "calc_basis",
        Some(&row.id.to_string()),
        Some(audit_detail(&row)),
    )
    .await;
    Ok(Json(row))
}

/// The services the business routers need, bundled so `api_router` passes one value.
#[derive(Clone)]
pub(super) struct BusinessServices {
    pub customers: CustomersService,
    pub projects: ProjectsService,
    pub pipeline: PipelineService,
    pub orders: OrdersService,
    pub calc_basis: CalcBasisService,
    pub work_masters: WorkMastersService,
    pub time_entries: TimeEntriesService,
    pub authz: AuthzService,
    pub users: UsersService,
}

pub(super) fn state(
    services: BusinessServices,
    audit: AuditLogService,
    auth: AuthState,
) -> BusinessState {
    BusinessState {
        customers: services.customers,
        projects: services.projects,
        pipeline: services.pipeline,
        orders: services.orders,
        calc_basis: services.calc_basis,
        work_masters: services.work_masters,
        time_entries: services.time_entries,
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
        .route("/api/projects/{id}/order", get(order_get))
        .route("/api/outlook", get(outlook_get))
        .route("/api/outlook/snapshots", get(outlook_snapshots_list))
        .route("/api/outlook/snapshots/{id}", get(outlook_snapshot_get))
        .route("/api/calc-basis", get(calc_basis_get))
        .route("/api/calc-basis/preview", post(calc_basis_preview))
        .route("/api/projects/{id}/calc-basis", get(project_basis_get))
        .route(
            "/api/projects/{id}/calc-basis/preview",
            post(project_basis_preview),
        )
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
        .route("/api/projects/{id}/order/convert", post(order_convert))
        .route(
            "/api/projects/{id}/order/changes",
            post(order_change_create),
        )
        .route(
            "/api/projects/{id}/order/changes/{changeId}/decide",
            post(order_change_decide),
        )
        .route(
            "/api/projects/{id}/order/revenue-plan",
            axum::routing::put(revenue_plan_replace),
        )
        .route(
            "/api/projects/{id}/order/recognitions",
            post(recognition_create),
        )
        .route(
            "/api/projects/{id}/order/recognitions/{recognitionId}/cancel",
            post(recognition_cancel),
        )
        .route("/api/outlook/snapshots", post(outlook_snapshot_create))
        .route("/api/calc-basis", post(calc_basis_add))
        .route("/api/projects/{id}/calc-basis", post(project_basis_add))
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
