//! 顧客・案件台帳 (P3a, spec §5.1, ADR-0028): customers and the user-name
//! pickers are masters (`ViewMasters` / `EditMasters`); a project's basic
//! information is `ViewProject` / `EditProject` and the list is narrowed to
//! `visible_projects`. The `admin` role passes the master and
//! basic-information checks (spec §4) but never one that shows amounts
//! ([`Gate::check_or_admin`]). Creating a project is `CreateProject`, and a
//! sales registrant (`pipeline.edit`) becomes its sales owner. Audit details
//! carry names and codes only.

use std::str::FromStr;

use crate::users::{Role, UsersService};
use banto_admin_services::authz::{authorize, Capability, Operation, Policy};
use banto_core::{BantoError, ListParams, ListResult};
use serde::Serialize;
use serde_json::json;

use super::Gate;
use crate::approval::APPROVAL_POLICY;
use crate::calc_basis::CalcBasisService;
use crate::customers::{Customer, CustomerInput, CustomersService};
use crate::projects::{Project, ProjectInput, ProjectsService};
use crate::user_names::{user_names, UserName};

const CUSTOMERS: &str = "customers";
const PROJECTS: &str = "projects";

pub async fn customers_list(
    gate: &Gate<'_>,
    customers: &CustomersService,
    params: ListParams,
) -> Result<ListResult<Customer>, BantoError> {
    gate.check_or_admin(Operation::ViewMasters, CUSTOMERS)
        .await?;
    customers.list(params).await
}

pub async fn customers_get(
    gate: &Gate<'_>,
    customers: &CustomersService,
    id: i64,
) -> Result<Customer, BantoError> {
    gate.check_or_admin(Operation::ViewMasters, CUSTOMERS)
        .await?;
    customers.get(id).await
}

pub async fn customers_create(
    gate: &Gate<'_>,
    customers: &CustomersService,
    input: CustomerInput,
) -> Result<Customer, BantoError> {
    gate.check_or_admin(Operation::EditMasters, CUSTOMERS)
        .await?;
    let customer = customers.create(input).await?;
    gate.record(
        "create",
        CUSTOMERS,
        Some(&customer.id.to_string()),
        Some(json!({ "name": customer.name })),
    )
    .await;
    Ok(customer)
}

pub async fn customers_update(
    gate: &Gate<'_>,
    customers: &CustomersService,
    id: i64,
    input: CustomerInput,
) -> Result<Customer, BantoError> {
    gate.check_or_admin(Operation::EditMasters, CUSTOMERS)
        .await?;
    let customer = customers.update(id, input).await?;
    gate.record(
        "update",
        CUSTOMERS,
        Some(&id.to_string()),
        Some(json!({ "name": customer.name, "active": customer.active })),
    )
    .await;
    Ok(customer)
}

/// Id and display name for the manager / employee pickers (`ViewMasters`).
pub async fn user_names_list(
    gate: &Gate<'_>,
    users: &UsersService,
) -> Result<Vec<UserName>, BantoError> {
    gate.check_or_admin(Operation::ViewMasters, "users").await?;
    user_names(users).await
}

/// The project list, narrowed to [`Gate::visible_scope`] (no `Operation`:
/// nothing is denied, the scope only narrows).
pub async fn projects_list(
    gate: &Gate<'_>,
    projects: &ProjectsService,
    params: ListParams,
) -> Result<ListResult<Project>, BantoError> {
    let scope = gate.visible_scope().await?;
    projects.list(params, &scope).await
}

pub async fn projects_get(
    gate: &Gate<'_>,
    projects: &ProjectsService,
    id: i64,
) -> Result<Project, BantoError> {
    gate.check_or_admin(Operation::ViewProject { project_id: id }, PROJECTS)
        .await?;
    projects.get(id).await
}

pub async fn projects_create(
    gate: &Gate<'_>,
    projects: &ProjectsService,
    input: ProjectInput,
) -> Result<Project, BantoError> {
    let subject = gate.check(Operation::CreateProject, PROJECTS).await?;
    // A sales registrant becomes the project's sales owner (ADR-0028).
    let sales = gate
        .user_id()
        .filter(|_| subject.has(Capability::PipelineEdit));
    let project = projects.create(input, sales).await?;
    gate.record(
        "create",
        PROJECTS,
        Some(&project.id.to_string()),
        Some(json!({ "code": project.code, "status": project.status })),
    )
    .await;
    Ok(project)
}

pub async fn projects_update(
    gate: &Gate<'_>,
    projects: &ProjectsService,
    id: i64,
    input: ProjectInput,
) -> Result<Project, BantoError> {
    gate.check(Operation::EditProject { project_id: id }, PROJECTS)
        .await?;
    let project = projects.update(id, input).await?;
    gate.record(
        "update",
        PROJECTS,
        Some(&id.to_string()),
        Some(json!({ "code": project.code, "status": project.status })),
    )
    .await;
    Ok(project)
}

/// What the caller may do on one project's page (review D-4, §8-15): the
/// same decisions as the writes below and in the other modules, made with
/// the pure `authorize` on the caller's subject, so nothing is denied or
/// audited - a probe is not an attempt. DISPLAY ONLY: the page hides the
/// buttons of the actions that are `false`, and every write still decides
/// (and audits) on its own. Writes need the `editor` floor on both paths,
/// so a `viewer` gets `false` everywhere.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActions {
    /// The basic information (`EditProject`).
    pub edit_project: bool,
    /// The members (担当営業・作業者): the `admin` role (`rest/authz.rs`).
    pub edit_members: bool,
    /// Order conversion, its cancellation and correction, change requests
    /// and the revenue plan (`EditOrder`).
    pub edit_order: bool,
    /// Deciding an order change (`Approve`, `APPROVAL_POLICY`).
    pub decide_order_change: bool,
    /// Revenue recognition and its cancellation (`FinanceClose` and
    /// `ViewProjectAmounts`).
    pub recognize_revenue: bool,
    /// Pipeline versions and their adoption (`EditPipeline`).
    pub edit_pipeline: bool,
    /// Budget and completion-forecast drafts (`ManageProject`).
    pub manage_project: bool,
    /// Approving a budget draft (`ApproveBudget`, `APPROVAL_POLICY`).
    pub approve_budget: bool,
    /// Adopting a completion-forecast draft (`AdoptForecast`, `APPROVAL_POLICY`).
    pub adopt_forecast: bool,
    /// Settling and reopening (`SettleProject`).
    pub settle: bool,
    /// Entering a direct cost on the project (`EnterCost`).
    pub enter_cost: bool,
    /// Registering and revising purchase orders (`EditPurchaseOrder`).
    pub edit_purchase_order: bool,
    /// The calc-basis items the caller may override on the project
    /// (`OverrideCalcBasis` with each item's right; overridable items only).
    pub override_calc_items: Vec<String>,
}

pub async fn project_actions(
    gate: &Gate<'_>,
    projects: &ProjectsService,
    calc_basis: &CalcBasisService,
    id: i64,
) -> Result<ProjectActions, BantoError> {
    gate.check_or_admin(Operation::ViewProject { project_id: id }, PROJECTS)
        .await?;
    // An unknown project is not found, as on its page.
    projects.get(id).await?;
    let writer = Role::from_str(gate.caller.role).is_ok_and(|role| role.can_write_resources());
    if !writer {
        return Ok(ProjectActions::default());
    }
    let subject = gate.subject().await?;
    let may = |op: Operation, policy: Policy| authorize(&subject, op, policy).is_ok();
    let plain = Policy::default();
    // An approval of a record nobody here submitted: the right itself
    // (self-approval is allowed by `APPROVAL_POLICY` anyway).
    const NOBODY: i64 = 0;
    let mut override_calc_items = Vec::new();
    for item in calc_basis.items().await? {
        if !item.project_overridable {
            continue;
        }
        let op = Operation::OverrideCalcBasis {
            project_id: id,
            capability: item.capability()?,
            managers_allowed: item.managers_may_override,
        };
        if may(op, plain) {
            override_calc_items.push(item.key);
        }
    }
    Ok(ProjectActions {
        edit_project: may(Operation::EditProject { project_id: id }, plain),
        edit_members: gate.is_admin(),
        edit_order: may(Operation::EditOrder { project_id: id }, plain),
        decide_order_change: may(
            Operation::Approve {
                project_id: id,
                submitted_by: NOBODY,
            },
            APPROVAL_POLICY,
        ),
        recognize_revenue: may(Operation::FinanceClose, plain)
            && may(Operation::ViewProjectAmounts { project_id: id }, plain),
        edit_pipeline: may(Operation::EditPipeline { project_id: id }, plain),
        manage_project: may(Operation::ManageProject { project_id: id }, plain),
        approve_budget: may(
            Operation::ApproveBudget {
                project_id: id,
                submitted_by: NOBODY,
            },
            APPROVAL_POLICY,
        ),
        adopt_forecast: may(
            Operation::AdoptForecast {
                project_id: id,
                submitted_by: NOBODY,
            },
            APPROVAL_POLICY,
        ),
        settle: may(Operation::SettleProject { project_id: id }, plain),
        enter_cost: may(Operation::EnterCost { project_id: id }, plain),
        edit_purchase_order: may(Operation::EditPurchaseOrder { project_id: id }, plain),
        override_calc_items,
    })
}
