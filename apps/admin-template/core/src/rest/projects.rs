//! `/api/customers/*`, `/api/projects/*` and the pipeline routes (banto-cost
//! P3a). The Tauri twins are the `customers_*` / `projects_*` / `pipeline_*`
//! commands in `src-tauri`; both call the same authorized operations in
//! `crate::ops::{projects, pipeline, calc_basis, orders}` (decision,
//! service, audit; review §8-13, ADR-0028, conventions §1), and lists use
//! the same scope functions as the detail decisions (`visible_projects` /
//! `amount_projects`, T12). [`BusinessState::gate`] names the REST caller
//! for every business route (`rest/{time,costs,budgets,...}.rs` too).
//!
//! Role floors: reads need a session; writes need `editor` (Banto's "may
//! enter business data"). On top of the floor:
//!
//! | Route | Decision |
//! |-------|----------|
//! | customers list/get | `admin` role, or `ViewMasters` |
//! | customers create/update | `admin` role, or `EditMasters` |
//! | user names (id + display name) | `admin` role, or `ViewMasters` |
//! | projects list | `admin` role sees all; others `visible_projects` |
//! | projects get | `admin` role, or `ViewProject` |
//! | project actions (what the caller may do on the page; display only) | `admin` role, or `ViewProject` |
//! | projects create | `CreateProject` |
//! | projects update | `EditProject` |
//! | pipeline versions list | `ViewProjectAmounts` |
//! | pipeline version create/adopt | `EditPipeline` |
//! | pipeline overview | scope `amount_projects` |
//! | order get | `ViewProjectAmounts` |
//! | order convert / conversion cancel (+ `EditProject` on a partial order's remainder) / conversion correct / change request / revenue plan | `EditOrder` |
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
use banto_admin_services::authz::AuthzService;
use banto_core::BantoError;
use banto_server::AuthenticatedSession;

use crate::budgets::BudgetsService;
use crate::calc_basis::{
    CalcBasisService, CalcValueInput, CalcValueRow, CompanyBasis, ImpactPreview, ProjectBasis,
};
use crate::customers::{Customer, CustomerInput, CustomersService};
use crate::direct_costs::DirectCostsService;
use crate::ops::{self, Caller, Gate};
use crate::orders::outlook::{OutlookQuery, OutlookView, SnapshotInfo};
use crate::orders::{
    CancelInput, ChangeDecision, ChangeRequest, ConversionCancelInput, ConversionCorrectionInput,
    ConversionRequest, OrderSummary, OrdersService, RecognitionInput, ReplanInput,
};
use crate::pipeline::{PipelineOverview, PipelineService, PipelineVersion, PipelineVersionInput};
use crate::projects::{Project, ProjectInput, ProjectsService};
use crate::time_entries::TimeEntriesService;
use crate::user_names::UserName;
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
    pub(super) budgets: BudgetsService,
    pub(super) forecasts: crate::forecasts::ForecastsService,
    pub(super) direct_costs: DirectCostsService,
    pub(super) authz: AuthzService,
    pub(super) users: UsersService,
    pub(super) audit: AuditLogService,
}

impl BusinessState {
    /// The caller of an authorized operation (`crate::ops`, review §8-13)
    /// from the REST path: the session's user row and identity.
    pub(super) async fn gate<'a>(
        &'a self,
        session: &'a AuthenticatedSession,
    ) -> Result<Gate<'a>, BantoError> {
        Ok(Gate {
            authz: &self.authz,
            audit: &self.audit,
            caller: Caller {
                user_id: caller_user_id(session, &self.users).await?,
                username: &session.identity.id,
                role: &session.identity.role,
                origin: "rest",
            },
        })
    }
}

// --- customers, projects (crate::ops::projects) ---------------------------

async fn customers_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(params): Json<ListParams>,
) -> Result<Json<ListResult<Customer>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::projects::customers_list(&gate, &state.customers, params).await?,
    ))
}

async fn customers_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<Customer>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::projects::customers_get(&gate, &state.customers, id).await?,
    ))
}

// --- user names (the manager / employee pickers) -------------------------

async fn user_names_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<UserName>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::projects::user_names_list(&gate, &state.users).await?,
    ))
}

async fn customers_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<CustomerInput>,
) -> Result<Json<Customer>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::projects::customers_create(&gate, &state.customers, input).await?,
    ))
}

async fn customers_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<CustomerInput>,
) -> Result<Json<Customer>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::projects::customers_update(&gate, &state.customers, id, input).await?,
    ))
}

async fn projects_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(params): Json<ListParams>,
) -> Result<Json<ListResult<Project>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::projects::projects_list(&gate, &state.projects, params).await?,
    ))
}

async fn projects_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<Project>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::projects::projects_get(&gate, &state.projects, id).await?,
    ))
}

/// What the caller may do on the project's page (review D-4, §8-15):
/// display only, every write still decides on its own.
async fn project_actions(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<ops::projects::ProjectActions>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::projects::project_actions(&gate, &state.projects, &state.calc_basis, id).await?,
    ))
}

async fn projects_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<ProjectInput>,
) -> Result<Json<Project>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::projects::projects_create(&gate, &state.projects, input).await?,
    ))
}

async fn projects_update(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<ProjectInput>,
) -> Result<Json<Project>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::projects::projects_update(&gate, &state.projects, id, input).await?,
    ))
}

// --- pipeline (crate::ops::pipeline) ----------------------------------------

async fn pipeline_versions_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<Vec<PipelineVersion>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::pipeline::versions(&gate, &state.pipeline, id).await?,
    ))
}

async fn pipeline_versions_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<PipelineVersionInput>,
) -> Result<Json<PipelineVersion>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::pipeline::create_version(&gate, &state.pipeline, id, input).await?,
    ))
}

async fn pipeline_versions_adopt(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((id, version_id)): Path<(i64, i64)>,
) -> Result<Json<PipelineVersion>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::pipeline::adopt(&gate, &state.pipeline, id, version_id).await?,
    ))
}

async fn pipeline_overview(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<PipelineOverview>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::pipeline::overview(&gate, &state.pipeline).await?))
}

// --- orders, outlook (P3b, crate::ops::orders) ------------------------------

async fn order_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
) -> Result<Json<OrderSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::orders::get(&gate, &state.orders, id).await?))
}

async fn order_convert(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<ConversionRequest>,
) -> Result<Json<OrderSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::convert(&gate, &state.orders, id, input).await?,
    ))
}

async fn order_conversion_cancel(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<ConversionCancelInput>,
) -> Result<Json<OrderSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::cancel_conversion(&gate, &state.orders, id, input).await?,
    ))
}

async fn order_conversion_correct(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<ConversionCorrectionInput>,
) -> Result<Json<OrderSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::correct_conversion(&gate, &state.orders, id, input).await?,
    ))
}

async fn order_change_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<ChangeRequest>,
) -> Result<Json<OrderSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::request_change(&gate, &state.orders, id, input).await?,
    ))
}

async fn order_change_decide(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((id, change_id)): Path<(i64, i64)>,
    Json(input): Json<ChangeDecision>,
) -> Result<Json<OrderSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::decide_change(&gate, &state.orders, id, change_id, input).await?,
    ))
}

async fn revenue_plan_replace(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<ReplanInput>,
) -> Result<Json<OrderSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::replan(&gate, &state.orders, id, input).await?,
    ))
}

async fn recognition_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<RecognitionInput>,
) -> Result<Json<OrderSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::recognize(&gate, &state.orders, id, input).await?,
    ))
}

async fn recognition_cancel(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((id, recognition_id)): Path<(i64, i64)>,
    Json(input): Json<CancelInput>,
) -> Result<Json<OrderSummary>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::cancel_recognition(&gate, &state.orders, id, recognition_id, input).await?,
    ))
}

async fn outlook_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<OutlookQuery>,
) -> Result<Json<OutlookView>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::outlook(&gate, &state.orders, query).await?,
    ))
}

async fn outlook_snapshots_list(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<Vec<SnapshotInfo>>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(ops::orders::snapshots(&gate, &state.orders).await?))
}

async fn outlook_snapshot_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Query(query): Query<OutlookQuery>,
) -> Result<Json<OutlookView>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::snapshot_view(&gate, &state.orders, id, query).await?,
    ))
}

#[derive(serde::Deserialize)]
struct SnapshotCreate {
    #[serde(default)]
    label: Option<String>,
}

async fn outlook_snapshot_create(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<SnapshotCreate>,
) -> Result<Json<SnapshotInfo>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::orders::save_snapshot(&gate, &state.orders, input.label).await?,
    ))
}

// --- calc basis (P4a, crate::ops::calc_basis) -----------------------------

#[derive(Debug, serde::Deserialize)]
struct OnQuery {
    on: String,
}

async fn calc_basis_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<OnQuery>,
) -> Result<Json<CompanyBasis>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::calc_basis::company(&gate, &state.calc_basis, &query.on).await?,
    ))
}

async fn calc_basis_preview(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<CalcValueInput>,
) -> Result<Json<ImpactPreview>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::calc_basis::company_preview(&gate, &state.calc_basis, input).await?,
    ))
}

async fn calc_basis_add(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(input): Json<CalcValueInput>,
) -> Result<Json<CalcValueRow>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::calc_basis::company_add(&gate, &state.calc_basis, input).await?,
    ))
}

async fn project_basis_get(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Query(query): Query<OnQuery>,
) -> Result<Json<ProjectBasis>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::calc_basis::project(&gate, &state.calc_basis, id, &query.on).await?,
    ))
}

async fn project_basis_preview(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<CalcValueInput>,
) -> Result<Json<ImpactPreview>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::calc_basis::project_preview(&gate, &state.calc_basis, id, input).await?,
    ))
}

async fn project_basis_add(
    State(state): State<BusinessState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(id): Path<i64>,
    Json(input): Json<CalcValueInput>,
) -> Result<Json<CalcValueRow>, ApiError> {
    let gate = state.gate(&session).await?;
    Ok(Json(
        ops::calc_basis::project_add(&gate, &state.calc_basis, id, input).await?,
    ))
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
    pub budgets: BudgetsService,
    pub forecasts: crate::forecasts::ForecastsService,
    pub direct_costs: DirectCostsService,
    pub authz: AuthzService,
    pub users: UsersService,
}

pub(super) fn state(services: BusinessServices, audit: AuditLogService) -> BusinessState {
    BusinessState {
        customers: services.customers,
        projects: services.projects,
        pipeline: services.pipeline,
        orders: services.orders,
        calc_basis: services.calc_basis,
        work_masters: services.work_masters,
        time_entries: services.time_entries,
        budgets: services.budgets,
        forecasts: services.forecasts,
        direct_costs: services.direct_costs,
        authz: services.authz,
        users: services.users,
        audit,
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
        .route("/api/user-names", get(user_names_list))
        .route("/api/projects/list", post(projects_list))
        .route("/api/projects/{id}", get(projects_get))
        .route("/api/projects/{id}/actions", get(project_actions))
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
        .with_state(state(services, audit))
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
            "/api/projects/{id}/order/conversion/cancel",
            post(order_conversion_cancel),
        )
        .route(
            "/api/projects/{id}/order/conversion/correct",
            post(order_conversion_correct),
        )
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
        .with_state(state(services, audit.clone()))
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
