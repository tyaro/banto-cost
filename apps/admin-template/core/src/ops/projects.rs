//! 顧客・案件台帳 (P3a, spec §5.1, ADR-0028): customers and the user-name
//! pickers are masters (`ViewMasters` / `EditMasters`); a project's basic
//! information is `ViewProject` / `EditProject` and the list is narrowed to
//! `visible_projects`. The `admin` role passes the master and
//! basic-information checks (spec §4) but never one that shows amounts
//! ([`Gate::check_or_admin`]). Creating a project is `CreateProject`, and a
//! sales registrant (`pipeline.edit`) becomes its sales owner. Audit details
//! carry names and codes only.

use crate::users::UsersService;
use banto_admin_services::authz::{Capability, Operation};
use banto_core::{BantoError, ListParams, ListResult};
use serde_json::json;

use super::Gate;
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
