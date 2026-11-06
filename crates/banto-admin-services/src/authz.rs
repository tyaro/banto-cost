//! Business authorization for banto-cost: capabilities × project scope
//! (ADR-0028, `docs/project/design.md` §2, spec §4).
//!
//! Banto's three [`Role`]s are a total order and stay the app-wide floor
//! (viewer = may sign in, editor = may enter business data, admin = system
//! administration). They cannot express side-by-side permissions such as
//! "accounting sees cost rates but does not manage users" or "the system
//! administrator manages users but does not see amounts", so business
//! permissions are a separate vocabulary:
//!
//! - [`Capability`]: granted per user, any number of them
//!   (`user_capabilities`, migration `0009_authz.sql`).
//! - Project scope: `project_members` (project, user, [`MemberKind`]).
//!
//! [`authorize`] is the ONE decision function every path goes through - the
//! REST handlers, the Tauri commands, and (from P3 on) CSV export, search and
//! detail URLs (spec T12). List/search/CSV filter with [`visible_projects`] /
//! [`amount_projects`], which are derived from the same rules so a row that
//! [`authorize`] would reject for a detail view never appears in a list.
//!
//! Company membership (spec §4 last bullet, T19/T20): a user is a member of
//! the company data only through an explicit capability grant in THIS
//! database. Nothing is derived from the Banto role (an `admin` with no
//! capability sees no business data), from a grant session (it has no user
//! row), or from any other application's accounts.
//!
//! [`AuthzService`] is the DB side (conventions §2 shape: `Clone`,
//! `BantoError`, sqlx, no tauri/axum). [`AuthzService::authorize_audited`]
//! is the shared guard both wiring layers call, so a denial is decided AND
//! recorded identically on both paths (conventions §1); only `origin`
//! differs. That a service records the denial itself is the deliberate
//! deviation from conventions §2 that ADR-0028 records.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::str::FromStr;

use banto_core::{BantoError, FieldError};
use banto_storage::Db;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::audit::{AuditEntry, AuditLogService};

/// Business capability (design §2.3). Stored as the dotted string in
/// `user_capabilities.capability` (CHECKed by migration `0009_authz.sql`)
/// and sent over the wire the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Capability {
    /// Enter and submit one's own hours and expenses.
    #[serde(rename = "time.entry")]
    TimeEntry,
    /// Update and adopt the pipeline (pre-order outlook) of one's sales projects.
    #[serde(rename = "pipeline.edit")]
    PipelineEdit,
    /// Budget drafts, remaining-cost outlook and approval of one's managed projects.
    #[serde(rename = "project.manage")]
    ProjectManage,
    /// View and register personal hourly cost rates.
    #[serde(rename = "finance.rate")]
    FinanceRate,
    /// Revenue recognition, cost confirmation, monthly close, correction approval.
    #[serde(rename = "finance.close")]
    FinanceClose,
    /// Company-wide aggregates and details of every project.
    #[serde(rename = "report.all")]
    ReportAll,
    /// See amounts at all. Not granted to the system administrator by default.
    #[serde(rename = "amount.view")]
    AmountView,
}

impl Capability {
    pub const ALL: [Capability; 7] = [
        Capability::TimeEntry,
        Capability::PipelineEdit,
        Capability::ProjectManage,
        Capability::FinanceRate,
        Capability::FinanceClose,
        Capability::ReportAll,
        Capability::AmountView,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            Capability::TimeEntry => "time.entry",
            Capability::PipelineEdit => "pipeline.edit",
            Capability::ProjectManage => "project.manage",
            Capability::FinanceRate => "finance.rate",
            Capability::FinanceClose => "finance.close",
            Capability::ReportAll => "report.all",
            Capability::AmountView => "amount.view",
        }
    }
}

impl fmt::Display for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Capability {
    type Err = BantoError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Capability::ALL
            .into_iter()
            .find(|cap| cap.as_str() == value)
            .ok_or_else(|| BantoError::Other(format!("不明な能力です: {value}")))
    }
}

/// How a user takes part in a project (`project_members.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemberKind {
    /// Sales owner of the project's pipeline.
    Sales,
    /// Project manager (案件責任者).
    Manager,
    /// Assigned worker who enters hours and expenses.
    Worker,
}

impl MemberKind {
    pub const ALL: [MemberKind; 3] = [MemberKind::Sales, MemberKind::Manager, MemberKind::Worker];

    pub fn as_str(&self) -> &'static str {
        match self {
            MemberKind::Sales => "sales",
            MemberKind::Manager => "manager",
            MemberKind::Worker => "worker",
        }
    }
}

impl FromStr for MemberKind {
    type Err = BantoError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        MemberKind::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
            .ok_or_else(|| BantoError::Other(format!("不明な担当種別です: {value}")))
    }
}

/// Everything [`authorize`] needs to know about the caller, loaded from this
/// app's own database ([`AuthzService::subject`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    /// `users.id` in this database, or `None` for a session with no user row
    /// here (a grant session, an identity from another application).
    pub user_id: Option<i64>,
    pub capabilities: BTreeSet<Capability>,
    /// project id → the kinds this user holds on it.
    pub memberships: BTreeMap<i64, BTreeSet<MemberKind>>,
}

impl Subject {
    /// A subject with no row in this database: never a company member.
    pub fn outsider() -> Self {
        Self::default()
    }

    pub fn has(&self, cap: Capability) -> bool {
        self.capabilities.contains(&cap)
    }

    /// Company membership is an explicit capability grant in this database
    /// (spec §4, T20). No grant, no business data - whatever the role.
    pub fn is_company_member(&self) -> bool {
        self.user_id.is_some() && !self.capabilities.is_empty()
    }

    fn holds(&self, project_id: i64, kind: MemberKind) -> bool {
        self.memberships
            .get(&project_id)
            .is_some_and(|kinds| kinds.contains(&kind))
    }

    fn is_member_of(&self, project_id: i64) -> bool {
        self.memberships
            .get(&project_id)
            .is_some_and(|kinds| !kinds.is_empty())
    }

    /// Capabilities that see every project (accounting, management).
    fn sees_all_projects(&self) -> bool {
        self.has(Capability::ReportAll) || self.has(Capability::FinanceClose)
    }
}

/// A business operation to authorize. Project-scoped operations name the
/// project; company-scoped ones (rates, close, reports) do not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    /// Basic information of a project (name, customer, members).
    ViewProject { project_id: i64 },
    /// Revenue, cost and profit amounts of a project.
    ViewProjectAmounts { project_id: i64 },
    /// Enter one's own hours/expenses against a project.
    EnterTime { project_id: i64 },
    /// Update and adopt the pipeline of a project. Entering and adopting
    /// amounts presupposes seeing them, so this also needs `amount.view`
    /// (PR #9 review: the saved version is returned with its amounts).
    EditPipeline { project_id: i64 },
    /// Budget drafts and remaining-cost outlook of a project.
    ManageProject { project_id: i64 },
    /// Approve a record someone submitted against a project.
    Approve { project_id: i64, submitted_by: i64 },
    /// Personal hourly cost rates (view).
    ViewRates,
    /// Personal hourly cost rates (register/change).
    EditRates,
    /// Revenue recognition, cost confirmation, monthly close, corrections.
    FinanceClose,
    /// Company-wide aggregates and every project's details.
    ViewAllReports,
    /// Read masters (customers, phases): any company member.
    ViewMasters,
    /// Maintain masters (customers). The `admin` role (system
    /// administration, spec §4) is let through by the wiring layer.
    EditMasters,
    /// Register a new project (sales or project managers).
    CreateProject,
    /// Edit a project's ledger entry: its sales owner (`pipeline.edit`) or
    /// its manager (`project.manage`).
    EditProject { project_id: i64 },
    /// Convert a project to an order, request order changes and re-plan
    /// its ordered revenue (banto-cost P3b): its sales owner or its manager,
    /// as for [`Operation::EditProject`], and the amounts must be visible.
    EditOrder { project_id: i64 },
}

impl Operation {
    /// Stable name used in the audit `detail` of a denial.
    pub fn name(&self) -> &'static str {
        match self {
            Operation::ViewProject { .. } => "view_project",
            Operation::ViewProjectAmounts { .. } => "view_project_amounts",
            Operation::EnterTime { .. } => "enter_time",
            Operation::EditPipeline { .. } => "edit_pipeline",
            Operation::ManageProject { .. } => "manage_project",
            Operation::Approve { .. } => "approve",
            Operation::ViewRates => "view_rates",
            Operation::EditRates => "edit_rates",
            Operation::FinanceClose => "finance_close",
            Operation::ViewAllReports => "view_all_reports",
            Operation::ViewMasters => "view_masters",
            Operation::EditMasters => "edit_masters",
            Operation::CreateProject => "create_project",
            Operation::EditProject { .. } => "edit_project",
            Operation::EditOrder { .. } => "edit_order",
        }
    }

    pub fn project_id(&self) -> Option<i64> {
        match *self {
            Operation::ViewProject { project_id }
            | Operation::ViewProjectAmounts { project_id }
            | Operation::EnterTime { project_id }
            | Operation::EditPipeline { project_id }
            | Operation::ManageProject { project_id }
            | Operation::Approve { project_id, .. }
            | Operation::EditProject { project_id }
            | Operation::EditOrder { project_id } => Some(project_id),
            Operation::ViewRates
            | Operation::EditRates
            | Operation::FinanceClose
            | Operation::ViewAllReports
            | Operation::ViewMasters
            | Operation::EditMasters
            | Operation::CreateProject => None,
        }
    }
}

/// Company policy knobs [`authorize`] consults.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Policy {
    /// Small-team exception: allow approving one's own submission (spec §4).
    /// Off by default; when it is used, [`Allowed::self_approval_exception`]
    /// is set so the caller records it in the audit log.
    pub allow_self_approval: bool,
}

/// Why [`authorize`] refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denial {
    /// No capability grant in this database (T19/T20).
    NotCompanyMember,
    MissingCapability(Capability),
    OutOfProjectScope {
        project_id: i64,
    },
    SelfApproval,
}

impl Denial {
    pub fn code(&self) -> &'static str {
        match self {
            Denial::NotCompanyMember => "not_company_member",
            Denial::MissingCapability(_) => "missing_capability",
            Denial::OutOfProjectScope { .. } => "out_of_project_scope",
            Denial::SelfApproval => "self_approval",
        }
    }
}

/// [`authorize`]'s success value.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Allowed {
    /// The operation is allowed only through [`Policy::allow_self_approval`];
    /// the caller must record that in the audit log.
    pub self_approval_exception: bool,
}

fn require(subject: &Subject, cap: Capability) -> Result<(), Denial> {
    if subject.has(cap) {
        Ok(())
    } else {
        Err(Denial::MissingCapability(cap))
    }
}

fn require_scope(ok: bool, project_id: i64) -> Result<(), Denial> {
    if ok {
        Ok(())
    } else {
        Err(Denial::OutOfProjectScope { project_id })
    }
}

/// The decision function (design §2.3): capability × project scope ×
/// self-approval. Pure; every path calls it (directly or through
/// [`AuthzService::authorize_audited`]).
pub fn authorize(subject: &Subject, op: Operation, policy: Policy) -> Result<Allowed, Denial> {
    if !subject.is_company_member() {
        return Err(Denial::NotCompanyMember);
    }
    let allowed = Allowed::default();
    match op {
        Operation::ViewProject { project_id } => {
            require_scope(
                subject.sees_all_projects() || subject.is_member_of(project_id),
                project_id,
            )?;
        }
        Operation::ViewProjectAmounts { project_id } => {
            require(subject, Capability::AmountView)?;
            // Workers enter hours; they do not see the project's money.
            require_scope(
                subject.sees_all_projects()
                    || subject.holds(project_id, MemberKind::Manager)
                    || subject.holds(project_id, MemberKind::Sales),
                project_id,
            )?;
        }
        Operation::EnterTime { project_id } => {
            require(subject, Capability::TimeEntry)?;
            require_scope(subject.is_member_of(project_id), project_id)?;
        }
        Operation::EditPipeline { project_id } => {
            require(subject, Capability::PipelineEdit)?;
            require(subject, Capability::AmountView)?;
            require_scope(subject.holds(project_id, MemberKind::Sales), project_id)?;
        }
        Operation::ManageProject { project_id } => {
            require(subject, Capability::ProjectManage)?;
            require_scope(subject.holds(project_id, MemberKind::Manager), project_id)?;
        }
        Operation::Approve {
            project_id,
            submitted_by,
        } => {
            let as_manager = subject.has(Capability::ProjectManage)
                && subject.holds(project_id, MemberKind::Manager);
            let as_finance = subject.has(Capability::FinanceClose);
            if !as_manager && !as_finance {
                if subject.has(Capability::ProjectManage) {
                    return Err(Denial::OutOfProjectScope { project_id });
                }
                return Err(Denial::MissingCapability(Capability::ProjectManage));
            }
            if subject.user_id == Some(submitted_by) {
                if !policy.allow_self_approval {
                    return Err(Denial::SelfApproval);
                }
                return Ok(Allowed {
                    self_approval_exception: true,
                });
            }
        }
        Operation::ViewRates | Operation::EditRates => require(subject, Capability::FinanceRate)?,
        Operation::FinanceClose => require(subject, Capability::FinanceClose)?,
        Operation::ViewAllReports => {
            require(subject, Capability::ReportAll)?;
            require(subject, Capability::AmountView)?;
        }
        // Company membership (checked above) is all reading masters needs.
        Operation::ViewMasters => {}
        Operation::EditMasters => {
            if !(subject.has(Capability::PipelineEdit)
                || subject.has(Capability::ProjectManage)
                || subject.has(Capability::FinanceClose))
            {
                return Err(Denial::MissingCapability(Capability::PipelineEdit));
            }
        }
        Operation::CreateProject => {
            if !(subject.has(Capability::PipelineEdit) || subject.has(Capability::ProjectManage)) {
                return Err(Denial::MissingCapability(Capability::PipelineEdit));
            }
        }
        Operation::EditProject { project_id } | Operation::EditOrder { project_id } => {
            if matches!(op, Operation::EditOrder { .. }) {
                require(subject, Capability::AmountView)?;
            }
            let as_sales = subject.has(Capability::PipelineEdit)
                && subject.holds(project_id, MemberKind::Sales);
            let as_manager = subject.has(Capability::ProjectManage)
                && subject.holds(project_id, MemberKind::Manager);
            if !as_sales && !as_manager {
                if subject.has(Capability::PipelineEdit) || subject.has(Capability::ProjectManage) {
                    return Err(Denial::OutOfProjectScope { project_id });
                }
                return Err(Denial::MissingCapability(Capability::PipelineEdit));
            }
        }
    }
    Ok(allowed)
}

/// The projects a subject may see in lists, search results and CSV output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectScope {
    All,
    Only(BTreeSet<i64>),
}

impl ProjectScope {
    pub fn contains(&self, project_id: i64) -> bool {
        match self {
            ProjectScope::All => true,
            ProjectScope::Only(ids) => ids.contains(&project_id),
        }
    }
}

/// Projects whose basic information the subject may see - exactly the ids
/// for which `authorize(ViewProject)` succeeds (T12: lists, search and CSV
/// use this, never a looser filter).
pub fn visible_projects(subject: &Subject) -> ProjectScope {
    if !subject.is_company_member() {
        return ProjectScope::Only(BTreeSet::new());
    }
    if subject.sees_all_projects() {
        return ProjectScope::All;
    }
    ProjectScope::Only(
        subject
            .memberships
            .iter()
            .filter(|(_, kinds)| !kinds.is_empty())
            .map(|(id, _)| *id)
            .collect(),
    )
}

/// Projects whose amounts the subject may see - exactly the ids for which
/// `authorize(ViewProjectAmounts)` succeeds (amount columns of lists and CSV).
pub fn amount_projects(subject: &Subject) -> ProjectScope {
    if !subject.is_company_member() || !subject.has(Capability::AmountView) {
        return ProjectScope::Only(BTreeSet::new());
    }
    if subject.sees_all_projects() {
        return ProjectScope::All;
    }
    ProjectScope::Only(
        subject
            .memberships
            .iter()
            .filter(|(_, kinds)| {
                kinds.contains(&MemberKind::Manager) || kinds.contains(&MemberKind::Sales)
            })
            .map(|(id, _)| *id)
            .collect(),
    )
}

/// The caller as the wiring layer knows it, for [`AuthzService::authorize_audited`].
#[derive(Debug, Clone, Copy)]
pub struct Actor<'a> {
    /// `users.id` in this database (`None`: no row, e.g. a grant session).
    pub user_id: Option<i64>,
    pub username: &'a str,
    pub role: &'a str,
}

/// One `project_members` row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMember {
    pub project_id: i64,
    pub user_id: i64,
    pub kind: MemberKind,
}

/// DB side of the authorization model (migration `0009_authz.sql`).
#[derive(Clone)]
pub struct AuthzService {
    db: Db,
}

impl AuthzService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    fn ph(&self, n: usize) -> String {
        self.db.dialect().placeholder(n)
    }

    /// Load the subject for a user row. `None` (no row in this database)
    /// yields [`Subject::outsider`].
    pub async fn subject(&self, user_id: Option<i64>) -> Result<Subject, BantoError> {
        let Some(user_id) = user_id else {
            return Ok(Subject::outsider());
        };
        let capabilities = self.capabilities(user_id).await?.into_iter().collect();
        let mut memberships: BTreeMap<i64, BTreeSet<MemberKind>> = BTreeMap::new();
        for member in self.memberships_of(user_id).await? {
            memberships
                .entry(member.project_id)
                .or_default()
                .insert(member.kind);
        }
        Ok(Subject {
            user_id: Some(user_id),
            capabilities,
            memberships,
        })
    }

    /// Decide `op` for `actor` and, on denial, record `action: "denied"` to
    /// the audit log (`detail`: operation, reason, project) and return
    /// `Forbidden`. The one guard both REST (`origin: "rest"`) and Tauri
    /// (`origin: "tauri"`) call (conventions §1). Returns the loaded subject
    /// and the decision so the caller can audit a self-approval exception.
    pub async fn authorize_audited(
        &self,
        audit: &AuditLogService,
        actor: Actor<'_>,
        op: Operation,
        policy: Policy,
        resource: &str,
        origin: &str,
    ) -> Result<(Subject, Allowed), BantoError> {
        let subject = self.subject(actor.user_id).await?;
        match authorize(&subject, op, policy) {
            Ok(allowed) => Ok((subject, allowed)),
            Err(denial) => {
                let mut detail = json!({ "operation": op.name(), "reason": denial.code() });
                if let Some(project_id) = op.project_id() {
                    detail["projectId"] = json!(project_id);
                }
                if let Denial::MissingCapability(cap) = denial {
                    detail["capability"] = json!(cap.as_str());
                }
                audit
                    .record(AuditEntry {
                        actor_username: Some(actor.username),
                        actor_role: Some(actor.role),
                        action: "denied",
                        resource,
                        entity_id: op.project_id().map(|id| id.to_string()).as_deref(),
                        detail: Some(detail),
                        origin,
                        result: "denied",
                    })
                    .await;
                Err(BantoError::Forbidden)
            }
        }
    }

    /// The capabilities granted to a user, in [`Capability`] order.
    pub async fn capabilities(&self, user_id: i64) -> Result<Vec<Capability>, BantoError> {
        let sql = format!(
            "SELECT capability FROM user_capabilities WHERE user_id = {}",
            self.ph(1)
        );
        let rows: Vec<(String,)> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(user_id)
                    .fetch_all(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(user_id)
                    .fetch_all(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        let mut caps = rows
            .into_iter()
            .map(|(cap,)| Capability::from_str(&cap))
            .collect::<Result<Vec<_>, _>>()?;
        caps.sort();
        Ok(caps)
    }

    /// Replace a user's capability set (one transaction). The user must
    /// exist in this database.
    ///
    /// Concurrent replacements for the same user are serialized so the
    /// result is exactly one request's set, never a union (PR #8 review): on
    /// Postgres the user row is locked `FOR UPDATE` first - under READ
    /// COMMITTED two transactions could otherwise both DELETE nothing and
    /// then INSERT disjoint sets. SQLite already admits one writer at a time.
    pub async fn set_capabilities(
        &self,
        user_id: i64,
        capabilities: &[Capability],
    ) -> Result<Vec<Capability>, BantoError> {
        let wanted: BTreeSet<Capability> = capabilities.iter().copied().collect();
        let delete = format!(
            "DELETE FROM user_capabilities WHERE user_id = {}",
            self.ph(1)
        );
        let insert = format!(
            "INSERT INTO user_capabilities (user_id, capability) VALUES ({}, {})",
            self.ph(1),
            self.ph(2)
        );
        match &self.db {
            Db::Sqlite(pool) => {
                self.ensure_user(user_id).await?;
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                sqlx::query(sqlx::AssertSqlSafe(delete.clone()))
                    .bind(user_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                for cap in &wanted {
                    sqlx::query(sqlx::AssertSqlSafe(insert.clone()))
                        .bind(user_id)
                        .bind(cap.as_str())
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let locked: Option<(i64,)> =
                    sqlx::query_as("SELECT id FROM users WHERE id = $1 FOR UPDATE")
                        .bind(user_id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                if locked.is_none() {
                    return Err(BantoError::NotFound {
                        resource: "users".into(),
                        id: user_id.to_string(),
                    });
                }
                sqlx::query(sqlx::AssertSqlSafe(delete.clone()))
                    .bind(user_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                for cap in &wanted {
                    sqlx::query(sqlx::AssertSqlSafe(insert.clone()))
                        .bind(user_id)
                        .bind(cap.as_str())
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
            }
        }
        Ok(wanted.into_iter().collect())
    }

    /// Members of a project, ordered by user then kind.
    pub async fn project_members(&self, project_id: i64) -> Result<Vec<ProjectMember>, BantoError> {
        let sql = format!(
            "SELECT project_id, user_id, kind FROM project_members WHERE project_id = {} \
             ORDER BY user_id, kind",
            self.ph(1)
        );
        self.fetch_members(sql, project_id).await
    }

    async fn memberships_of(&self, user_id: i64) -> Result<Vec<ProjectMember>, BantoError> {
        let sql = format!(
            "SELECT project_id, user_id, kind FROM project_members WHERE user_id = {} \
             ORDER BY project_id, kind",
            self.ph(1)
        );
        self.fetch_members(sql, user_id).await
    }

    async fn fetch_members(&self, sql: String, key: i64) -> Result<Vec<ProjectMember>, BantoError> {
        let rows: Vec<(i64, i64, String)> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(key)
                    .fetch_all(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(key)
                    .fetch_all(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        rows.into_iter()
            .map(|(project_id, user_id, kind)| {
                Ok(ProjectMember {
                    project_id,
                    user_id,
                    kind: MemberKind::from_str(&kind)?,
                })
            })
            .collect()
    }

    /// Add a member (idempotent: an existing row is left as is).
    pub async fn add_project_member(&self, member: &ProjectMember) -> Result<(), BantoError> {
        if member.project_id <= 0 {
            return Err(BantoError::Validation {
                field_errors: vec![FieldError {
                    field: "projectId".into(),
                    message: "案件IDが正しくありません".into(),
                }],
            });
        }
        self.ensure_user(member.user_id).await?;
        self.ensure_project(member.project_id).await?;
        let sql = format!(
            "INSERT INTO project_members (project_id, user_id, kind) VALUES ({}, {}, {}) \
             ON CONFLICT (project_id, user_id, kind) DO NOTHING",
            self.ph(1),
            self.ph(2),
            self.ph(3)
        );
        match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(member.project_id)
                .bind(member.user_id)
                .bind(member.kind.as_str())
                .execute(pool)
                .await
                .map(|_| ()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(member.project_id)
                .bind(member.user_id)
                .bind(member.kind.as_str())
                .execute(pool)
                .await
                .map(|_| ()),
        }
        .map_err(banto_storage::storage_error)?;
        Ok(())
    }

    /// Remove a member row. `NotFound` when it does not exist.
    pub async fn remove_project_member(&self, member: &ProjectMember) -> Result<(), BantoError> {
        let sql = format!(
            "DELETE FROM project_members WHERE project_id = {} AND user_id = {} AND kind = {}",
            self.ph(1),
            self.ph(2),
            self.ph(3)
        );
        let affected = match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(member.project_id)
                .bind(member.user_id)
                .bind(member.kind.as_str())
                .execute(pool)
                .await
                .map(|r| r.rows_affected()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(member.project_id)
                .bind(member.user_id)
                .bind(member.kind.as_str())
                .execute(pool)
                .await
                .map(|r| r.rows_affected()),
        }
        .map_err(banto_storage::storage_error)?;
        if affected == 0 {
            return Err(BantoError::NotFound {
                resource: "project_members".into(),
                id: format!(
                    "{}/{}/{}",
                    member.project_id,
                    member.user_id,
                    member.kind.as_str()
                ),
            });
        }
        Ok(())
    }

    async fn ensure_project(&self, project_id: i64) -> Result<(), BantoError> {
        let sql = format!("SELECT id FROM projects WHERE id = {}", self.ph(1));
        let row: Option<(i64,)> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(project_id)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(project_id)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        row.map(|_| ()).ok_or_else(|| BantoError::NotFound {
            resource: "projects".into(),
            id: project_id.to_string(),
        })
    }

    async fn ensure_user(&self, user_id: i64) -> Result<(), BantoError> {
        let sql = format!("SELECT id FROM users WHERE id = {}", self.ph(1));
        let row: Option<(i64,)> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(user_id)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(user_id)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        row.map(|_| ()).ok_or_else(|| BantoError::NotFound {
            resource: "users".into(),
            id: user_id.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject(user_id: i64, caps: &[Capability], members: &[(i64, MemberKind)]) -> Subject {
        let mut memberships: BTreeMap<i64, BTreeSet<MemberKind>> = BTreeMap::new();
        for (project, kind) in members {
            memberships.entry(*project).or_default().insert(*kind);
        }
        Subject {
            user_id: Some(user_id),
            capabilities: caps.iter().copied().collect(),
            memberships,
        }
    }

    const P1: i64 = 101;
    const P2: i64 = 102;

    fn deny(s: &Subject, op: Operation) -> Denial {
        authorize(s, op, Policy::default()).expect_err("should be denied")
    }

    fn allow(s: &Subject, op: Operation) {
        authorize(s, op, Policy::default()).expect("should be allowed");
    }

    #[test]
    fn capability_and_member_kind_round_trip() {
        for cap in Capability::ALL {
            assert_eq!(Capability::from_str(cap.as_str()).unwrap(), cap);
            assert_eq!(
                serde_json::to_value(cap).unwrap(),
                json!(cap.as_str()),
                "wire shape matches the DB string"
            );
        }
        for kind in MemberKind::ALL {
            assert_eq!(MemberKind::from_str(kind.as_str()).unwrap(), kind);
        }
        assert!(Capability::from_str("admin").is_err());
        assert!(MemberKind::from_str("owner").is_err());
    }

    #[test]
    fn t12_out_of_scope_project_is_denied_for_detail_amounts_and_list() {
        // A project manager of P1 only.
        let pm = subject(
            1,
            &[Capability::ProjectManage, Capability::AmountView],
            &[(P1, MemberKind::Manager)],
        );
        allow(&pm, Operation::ViewProject { project_id: P1 });
        allow(&pm, Operation::ViewProjectAmounts { project_id: P1 });
        allow(&pm, Operation::ManageProject { project_id: P1 });
        assert_eq!(
            deny(&pm, Operation::ViewProject { project_id: P2 }),
            Denial::OutOfProjectScope { project_id: P2 }
        );
        assert_eq!(
            deny(&pm, Operation::ViewProjectAmounts { project_id: P2 }),
            Denial::OutOfProjectScope { project_id: P2 }
        );
        assert_eq!(
            deny(&pm, Operation::ManageProject { project_id: P2 }),
            Denial::OutOfProjectScope { project_id: P2 }
        );
        // List / search / CSV filters agree with the detail decision.
        assert!(visible_projects(&pm).contains(P1));
        assert!(!visible_projects(&pm).contains(P2));
        assert!(amount_projects(&pm).contains(P1));
        assert!(!amount_projects(&pm).contains(P2));
    }

    #[test]
    fn t12_rates_require_finance_rate_even_for_project_managers() {
        let pm = subject(
            1,
            &[
                Capability::ProjectManage,
                Capability::AmountView,
                Capability::ReportAll,
            ],
            &[(P1, MemberKind::Manager)],
        );
        assert_eq!(
            deny(&pm, Operation::ViewRates),
            Denial::MissingCapability(Capability::FinanceRate)
        );
        assert_eq!(
            deny(&pm, Operation::EditRates),
            Denial::MissingCapability(Capability::FinanceRate)
        );
        let finance = subject(2, &[Capability::FinanceRate], &[]);
        allow(&finance, Operation::ViewRates);
        allow(&finance, Operation::EditRates);
    }

    #[test]
    fn t12_amounts_need_amount_view_and_workers_do_not_see_money() {
        // System administrator with every business scope but no amount.view.
        let sysadmin = subject(1, &[Capability::ReportAll], &[]);
        allow(&sysadmin, Operation::ViewProject { project_id: P1 });
        assert_eq!(
            deny(&sysadmin, Operation::ViewProjectAmounts { project_id: P1 }),
            Denial::MissingCapability(Capability::AmountView)
        );
        assert_eq!(
            deny(&sysadmin, Operation::ViewAllReports),
            Denial::MissingCapability(Capability::AmountView)
        );
        assert_eq!(
            amount_projects(&sysadmin),
            ProjectScope::Only(BTreeSet::new())
        );

        // A worker assigned to P1 enters hours there, sees its basics, not its money.
        let worker = subject(
            2,
            &[Capability::TimeEntry, Capability::AmountView],
            &[(P1, MemberKind::Worker)],
        );
        allow(&worker, Operation::EnterTime { project_id: P1 });
        allow(&worker, Operation::ViewProject { project_id: P1 });
        assert_eq!(
            deny(&worker, Operation::ViewProjectAmounts { project_id: P1 }),
            Denial::OutOfProjectScope { project_id: P1 }
        );
        assert_eq!(
            deny(&worker, Operation::EnterTime { project_id: P2 }),
            Denial::OutOfProjectScope { project_id: P2 }
        );
        assert!(!amount_projects(&worker).contains(P1));
    }

    #[test]
    fn t12_company_wide_capabilities_see_every_project() {
        let finance = subject(1, &[Capability::FinanceClose, Capability::AmountView], &[]);
        allow(&finance, Operation::ViewProjectAmounts { project_id: P2 });
        allow(&finance, Operation::FinanceClose);
        assert_eq!(visible_projects(&finance), ProjectScope::All);
        assert_eq!(amount_projects(&finance), ProjectScope::All);
        let exec = subject(2, &[Capability::ReportAll, Capability::AmountView], &[]);
        allow(&exec, Operation::ViewAllReports);
        assert_eq!(
            deny(&exec, Operation::FinanceClose),
            Denial::MissingCapability(Capability::FinanceClose)
        );
    }

    #[test]
    fn pipeline_edit_is_limited_to_own_sales_projects() {
        let sales = subject(
            1,
            &[Capability::PipelineEdit, Capability::AmountView],
            &[(P1, MemberKind::Sales)],
        );
        allow(&sales, Operation::EditPipeline { project_id: P1 });
        // Saving or adopting returns the version's amounts: no amount.view, no edit.
        let blind = subject(4, &[Capability::PipelineEdit], &[(P1, MemberKind::Sales)]);
        assert_eq!(
            deny(&blind, Operation::EditPipeline { project_id: P1 }),
            Denial::MissingCapability(Capability::AmountView)
        );
        assert_eq!(
            deny(&sales, Operation::EditPipeline { project_id: P2 }),
            Denial::OutOfProjectScope { project_id: P2 }
        );
        // A manager of P1 without pipeline.edit cannot edit its pipeline.
        let pm = subject(
            2,
            &[Capability::ProjectManage],
            &[(P1, MemberKind::Manager)],
        );
        assert_eq!(
            deny(&pm, Operation::EditPipeline { project_id: P1 }),
            Denial::MissingCapability(Capability::PipelineEdit)
        );
    }

    #[test]
    fn self_approval_is_denied_unless_the_policy_exception_is_on() {
        let pm = subject(
            7,
            &[Capability::ProjectManage, Capability::TimeEntry],
            &[(P1, MemberKind::Manager)],
        );
        let own = Operation::Approve {
            project_id: P1,
            submitted_by: 7,
        };
        let other = Operation::Approve {
            project_id: P1,
            submitted_by: 8,
        };
        assert_eq!(deny(&pm, own), Denial::SelfApproval);
        assert_eq!(
            authorize(&pm, other, Policy::default()),
            Ok(Allowed::default())
        );
        let exception = Policy {
            allow_self_approval: true,
        };
        assert_eq!(
            authorize(&pm, own, exception),
            Ok(Allowed {
                self_approval_exception: true
            })
        );
        // Approving on someone else's project is out of scope.
        assert_eq!(
            deny(
                &pm,
                Operation::Approve {
                    project_id: P2,
                    submitted_by: 8
                }
            ),
            Denial::OutOfProjectScope { project_id: P2 }
        );
        // Finance approves corrections company-wide but not its own.
        let finance = subject(9, &[Capability::FinanceClose], &[]);
        allow(
            &finance,
            Operation::Approve {
                project_id: P2,
                submitted_by: 8,
            },
        );
        assert_eq!(
            deny(
                &finance,
                Operation::Approve {
                    project_id: P2,
                    submitted_by: 9
                }
            ),
            Denial::SelfApproval
        );
    }

    #[test]
    fn masters_and_project_registration() {
        let worker = subject(1, &[Capability::TimeEntry], &[(P1, MemberKind::Worker)]);
        allow(&worker, Operation::ViewMasters);
        assert_eq!(
            deny(&worker, Operation::EditMasters),
            Denial::MissingCapability(Capability::PipelineEdit)
        );
        assert_eq!(
            deny(&worker, Operation::CreateProject),
            Denial::MissingCapability(Capability::PipelineEdit)
        );
        let sales = subject(2, &[Capability::PipelineEdit], &[(P1, MemberKind::Sales)]);
        allow(&sales, Operation::EditMasters);
        allow(&sales, Operation::CreateProject);
        allow(&sales, Operation::EditProject { project_id: P1 });
        assert_eq!(
            deny(&sales, Operation::EditProject { project_id: P2 }),
            Denial::OutOfProjectScope { project_id: P2 }
        );
        // A worker on P1 cannot edit P1's ledger entry.
        assert_eq!(
            deny(&worker, Operation::EditProject { project_id: P1 }),
            Denial::MissingCapability(Capability::PipelineEdit)
        );
        let pm = subject(
            3,
            &[Capability::ProjectManage],
            &[(P2, MemberKind::Manager)],
        );
        allow(&pm, Operation::EditProject { project_id: P2 });
        // Orders need the amounts on top of the same scope (P3b).
        assert_eq!(
            deny(&pm, Operation::EditOrder { project_id: P2 }),
            Denial::MissingCapability(Capability::AmountView)
        );
        let pm_amounts = subject(
            4,
            &[Capability::ProjectManage, Capability::AmountView],
            &[(P2, MemberKind::Manager)],
        );
        allow(&pm_amounts, Operation::EditOrder { project_id: P2 });
        assert_eq!(
            deny(&pm_amounts, Operation::EditOrder { project_id: P1 }),
            Denial::OutOfProjectScope { project_id: P1 }
        );
        assert_eq!(
            deny(&Subject::outsider(), Operation::ViewMasters),
            Denial::NotCompanyMember
        );
    }

    #[test]
    fn t20_no_capability_grant_means_no_company_data() {
        // Memberships alone (e.g. copied from elsewhere) do not make a member.
        let no_caps = subject(1, &[], &[(P1, MemberKind::Manager)]);
        assert_eq!(
            deny(&no_caps, Operation::ViewProject { project_id: P1 }),
            Denial::NotCompanyMember
        );
        assert_eq!(
            visible_projects(&no_caps),
            ProjectScope::Only(BTreeSet::new())
        );
        // A session with no user row here (grant session, another app's identity).
        let outsider = Subject::outsider();
        for op in [
            Operation::ViewProject { project_id: P1 },
            Operation::ViewRates,
            Operation::ViewAllReports,
        ] {
            assert_eq!(deny(&outsider, op), Denial::NotCompanyMember);
        }
        assert_eq!(
            visible_projects(&outsider),
            ProjectScope::Only(BTreeSet::new())
        );
        assert_eq!(
            amount_projects(&outsider),
            ProjectScope::Only(BTreeSet::new())
        );
    }

    // --- DB side ---

    /// (action, actor_username, resource, entity_id, detail, origin)
    type AuditRow = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
    );

    /// In-memory DB with the tables of `0003_users.sql` + `0004` + `0007`
    /// (users) and `0009_authz.sql`. This crate owns no migrations
    /// (conventions §11); this DDL MUST be kept in sync with them.
    async fn service() -> (AuthzService, AuditLogService, Db) {
        let db = Db::connect_sqlite_memory()
            .await
            .expect("connect in-memory sqlite");
        let pool = db.as_sqlite().expect("sqlite handle");
        for ddl in [
            "CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer')),
                auth_epoch INTEGER NOT NULL DEFAULT 0
            )",
            "CREATE TABLE user_capabilities (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                capability TEXT NOT NULL CHECK (capability IN ('time.entry','pipeline.edit',
                    'project.manage','finance.rate','finance.close','report.all','amount.view')),
                granted_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (user_id, capability)
            )",
            "CREATE TABLE project_members (
                project_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('sales','manager','worker')),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (project_id, user_id, kind)
            )",
            "CREATE INDEX project_members_user ON project_members (user_id)",
            // Only the column `ensure_project` reads; the full table is
            // `0010_projects.sql`.
            "CREATE TABLE projects (id INTEGER PRIMARY KEY)",
            "INSERT INTO projects (id) VALUES (101), (102)",
            "CREATE TABLE audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL DEFAULT (datetime('now')),
                actor_username TEXT,
                actor_role TEXT,
                action TEXT NOT NULL,
                resource TEXT NOT NULL,
                entity_id TEXT,
                detail TEXT,
                origin TEXT NOT NULL,
                result TEXT NOT NULL DEFAULT 'ok'
            )",
            "INSERT INTO users (username, password_hash, display_name, role)
                VALUES ('pm', 'x', '案件責任者A', 'editor'), ('admin', 'x', '管理者', 'admin')",
        ] {
            sqlx::query(ddl).execute(pool).await.expect("ddl");
        }
        let audit = AuditLogService::new(db.clone());
        (AuthzService::new(db.clone()), audit, db)
    }

    #[tokio::test]
    async fn capabilities_and_members_round_trip_and_build_the_subject() {
        let (svc, _audit, _db) = service().await;
        assert_eq!(svc.subject(Some(1)).await.unwrap().capabilities.len(), 0);
        let set = svc
            .set_capabilities(
                1,
                &[
                    Capability::AmountView,
                    Capability::ProjectManage,
                    Capability::AmountView,
                ],
            )
            .await
            .unwrap();
        assert_eq!(set, vec![Capability::ProjectManage, Capability::AmountView]);
        assert_eq!(svc.capabilities(1).await.unwrap(), set);
        let member = ProjectMember {
            project_id: P1,
            user_id: 1,
            kind: MemberKind::Manager,
        };
        svc.add_project_member(&member).await.unwrap();
        svc.add_project_member(&member).await.unwrap(); // idempotent
        assert_eq!(svc.project_members(P1).await.unwrap(), vec![member.clone()]);
        let subject = svc.subject(Some(1)).await.unwrap();
        allow(&subject, Operation::ViewProjectAmounts { project_id: P1 });
        // Replacing the set drops what is not listed.
        svc.set_capabilities(1, &[Capability::TimeEntry])
            .await
            .unwrap();
        assert_eq!(
            svc.capabilities(1).await.unwrap(),
            vec![Capability::TimeEntry]
        );
        svc.remove_project_member(&member).await.unwrap();
        assert!(matches!(
            svc.remove_project_member(&member).await,
            Err(BantoError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn unknown_users_and_bad_project_ids_are_rejected() {
        let (svc, _audit, _db) = service().await;
        assert!(matches!(
            svc.add_project_member(&ProjectMember {
                project_id: 999,
                user_id: 1,
                kind: MemberKind::Worker
            })
            .await,
            Err(BantoError::NotFound { .. })
        ));
        assert!(matches!(
            svc.set_capabilities(99, &[Capability::TimeEntry]).await,
            Err(BantoError::NotFound { .. })
        ));
        assert!(matches!(
            svc.add_project_member(&ProjectMember {
                project_id: 0,
                user_id: 1,
                kind: MemberKind::Worker
            })
            .await,
            Err(BantoError::Validation { .. })
        ));
    }

    #[tokio::test]
    async fn deleting_a_user_cascades_its_grants() {
        let (svc, _audit, db) = service().await;
        svc.set_capabilities(1, &[Capability::TimeEntry])
            .await
            .unwrap();
        svc.add_project_member(&ProjectMember {
            project_id: P1,
            user_id: 1,
            kind: MemberKind::Worker,
        })
        .await
        .unwrap();
        sqlx::query("DELETE FROM users WHERE id = 1")
            .execute(db.as_sqlite().unwrap())
            .await
            .unwrap();
        assert!(svc.capabilities(1).await.unwrap().is_empty());
        assert!(svc.project_members(P1).await.unwrap().is_empty());
    }

    /// T12/T20 on both paths: the shared guard decides and records the same
    /// denial for `rest` and `tauri`; only `origin` differs.
    #[tokio::test]
    async fn t12_t20_authorize_audited_records_the_same_denial_on_both_paths() {
        let (svc, audit, _db) = service().await;
        svc.set_capabilities(1, &[Capability::ProjectManage])
            .await
            .unwrap();
        svc.add_project_member(&ProjectMember {
            project_id: P1,
            user_id: 1,
            kind: MemberKind::Manager,
        })
        .await
        .unwrap();
        let pm = Actor {
            user_id: Some(1),
            username: "pm",
            role: "editor",
        };
        // The `admin` role with no capability grant (T20): role is not membership.
        let admin = Actor {
            user_id: Some(2),
            username: "admin",
            role: "admin",
        };
        let outsider = Actor {
            user_id: None,
            username: "public",
            role: "viewer",
        };
        for origin in ["rest", "tauri"] {
            let ok = svc
                .authorize_audited(
                    &audit,
                    pm,
                    Operation::ViewProject { project_id: P1 },
                    Policy::default(),
                    "projects",
                    origin,
                )
                .await;
            assert!(ok.is_ok());
            for (actor, op) in [
                (pm, Operation::ViewProject { project_id: P2 }),
                (admin, Operation::ViewProject { project_id: P1 }),
                (outsider, Operation::ViewProject { project_id: P1 }),
            ] {
                let denied = svc
                    .authorize_audited(&audit, actor, op, Policy::default(), "projects", origin)
                    .await;
                assert!(matches!(denied, Err(BantoError::Forbidden)));
            }
        }
        let rows: Vec<AuditRow> = sqlx::query_as(
            "SELECT action, actor_username, resource, entity_id, detail, origin \
                 FROM audit_log ORDER BY id",
        )
        .fetch_all(_db.as_sqlite().unwrap())
        .await
        .unwrap();
        let denied: Vec<_> = rows.iter().filter(|r| r.0 == "denied").collect();
        assert_eq!(
            denied.len(),
            6,
            "every denial is recorded, successes are not"
        );
        for origin in ["rest", "tauri"] {
            let mut shapes: Vec<_> = denied
                .iter()
                .filter(|r| r.5 == origin)
                .map(|r| {
                    (
                        Some(r.1.clone()),
                        r.2.clone(),
                        r.3.clone(),
                        r.4.as_deref()
                            .map(|d| serde_json::from_str::<serde_json::Value>(d).unwrap()),
                    )
                })
                .collect();
            shapes.sort_by(|a, b| a.0.cmp(&b.0));
            assert_eq!(
                shapes,
                vec![
                    (
                        Some("admin".to_string()),
                        "projects".to_string(),
                        Some(P1.to_string()),
                        Some(
                            json!({"operation":"view_project","reason":"not_company_member","projectId":P1})
                        ),
                    ),
                    (
                        Some("pm".to_string()),
                        "projects".to_string(),
                        Some(P2.to_string()),
                        Some(
                            json!({"operation":"view_project","reason":"out_of_project_scope","projectId":P2})
                        ),
                    ),
                    (
                        Some("public".to_string()),
                        "projects".to_string(),
                        Some(P1.to_string()),
                        Some(
                            json!({"operation":"view_project","reason":"not_company_member","projectId":P1})
                        ),
                    ),
                ]
            );
        }
    }

    /// PR #8 review: concurrent replacements for the same user must not
    /// merge into a union no request asked for (Postgres READ COMMITTED lets
    /// two transactions both DELETE nothing and then INSERT disjoint sets).
    /// Skipped unless `BANTO_TEST_PG_URL` is set (CI's `app-postgres` job);
    /// uses its own schema so it never touches `public`.
    #[cfg(feature = "postgres")]
    #[tokio::test]
    async fn pg_concurrent_set_capabilities_replaces_instead_of_merging() {
        let Ok(url) = std::env::var("BANTO_TEST_PG_URL") else {
            return;
        };
        let schema = format!("banto_authz_{}", std::process::id());
        let admin = Db::connect_postgres(&url).await.unwrap();
        let pool = admin.as_postgres().unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA IF EXISTS {schema} CASCADE"
        )))
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
            .execute(pool)
            .await
            .unwrap();
        let sep = if url.contains('?') { '&' } else { '?' };
        let scoped = format!("{url}{sep}options=-c%20search_path%3D{schema}");
        let db = Db::connect_postgres(&scoped).await.unwrap();
        // MUST match migrations-postgres 0003/0004/0007 (users) and 0009.
        for ddl in [
            "CREATE TABLE users (
                id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'admin',
                auth_epoch BIGINT NOT NULL DEFAULT 0
            )",
            "CREATE TABLE user_capabilities (
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                capability TEXT NOT NULL,
                granted_at TEXT NOT NULL DEFAULT (now()::text),
                PRIMARY KEY (user_id, capability)
            )",
            "INSERT INTO users (username, password_hash, display_name) VALUES ('u', 'x', 'x')",
        ] {
            sqlx::query(ddl)
                .execute(db.as_postgres().unwrap())
                .await
                .unwrap();
        }
        let user_id: i64 = sqlx::query_scalar("SELECT id FROM users")
            .fetch_one(db.as_postgres().unwrap())
            .await
            .unwrap();

        let caps = Capability::ALL;
        for round in 0..20 {
            // Start each round from an empty set, then race one single-
            // capability replacement per capability.
            AuthzService::new(db.clone())
                .set_capabilities(user_id, &[])
                .await
                .unwrap();
            let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(caps.len()));
            let mut handles = Vec::new();
            for cap in caps {
                let svc = AuthzService::new(Db::connect_postgres(&scoped).await.unwrap());
                let barrier = barrier.clone();
                handles.push(tokio::spawn(async move {
                    barrier.wait().await;
                    svc.set_capabilities(user_id, &[cap]).await
                }));
            }
            for h in handles {
                h.await.unwrap().unwrap();
            }
            let now = AuthzService::new(db.clone())
                .capabilities(user_id)
                .await
                .unwrap();
            assert_eq!(
                now.len(),
                1,
                "round {round}: the last replacement wins, no union: {now:?}"
            );
        }
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA IF EXISTS {schema} CASCADE"
        )))
        .execute(pool)
        .await
        .unwrap();
    }
}
