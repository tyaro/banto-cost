//! Project ledger (banto-cost P3a, spec §5.1, `docs/project/design.md` §3.1).
//!
//! Service-layer shape (conventions §2). The wiring layer authorizes each
//! call (ADR-0028) and passes the caller's [`ProjectScope`] to [`ProjectsService::list`],
//! so a list never contains a project the detail view would refuse (T12).
//!
//! The responsible person (`manager_user_id`) is also kept as the project's
//! `project_members` row of kind `manager`, in the same transaction, because
//! that table is what authorization reads.

use banto_admin_services::authz::ProjectScope;
use banto_core::{BantoError, FilterOp, FilterState, ListParams, ListResult};
use banto_storage::{ColumnMap, Db};
use cost_domain::project::{
    validate_project, ProjectInput as DomainInput, ProjectIssue, ProjectStatus,
};
use cost_domain::Date;
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite};

use crate::customers::{clean_optional, field_error, now_expr, stale_version_error};

pub const MAX_CODE_LEN: usize = 30;
pub const MAX_NAME_LEN: usize = 100;
pub const MAX_TEXT_LEN: usize = 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub customer_id: i64,
    pub customer_name: String,
    pub manager_user_id: i64,
    pub manager_name: String,
    /// `cost_domain::project::ProjectStatus::as_str`.
    pub status: String,
    /// `YYYY-MM-DD`, or `None` while undecided (allowed before the order).
    pub planned_start: Option<String>,
    pub planned_end: Option<String>,
    pub order_no: Option<String>,
    pub department: Option<String>,
    pub note: Option<String>,
    pub row_version: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    pub code: String,
    pub name: String,
    pub customer_id: i64,
    pub manager_user_id: i64,
    pub status: String,
    #[serde(default)]
    pub planned_start: Option<String>,
    #[serde(default)]
    pub planned_end: Option<String>,
    #[serde(default)]
    pub order_no: Option<String>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// Required on update (T13); ignored on create.
    #[serde(default)]
    pub row_version: Option<i64>,
}

fn column_map() -> ColumnMap {
    ColumnMap::new()
        .column("id", "p.id")
        .column("code", "p.code")
        .column("name", "p.name")
        .column("customerId", "p.customer_id")
        .column("customerName", "c.name")
        .column("managerUserId", "p.manager_user_id")
        .column("managerName", "u.display_name")
        .column("status", "p.status")
        .column("plannedStart", "p.planned_start")
        .column("plannedEnd", "p.planned_end")
        .column("updatedAt", "p.updated_at")
}

const SELECT_FROM: &str = "SELECT p.id, p.code, p.name, p.customer_id, c.name AS customer_name, \
     p.manager_user_id, u.display_name AS manager_name, p.status, p.planned_start, \
     p.planned_end, p.order_no, p.department, p.note, p.row_version, p.updated_at \
     FROM projects p JOIN customers c ON c.id = p.customer_id \
     JOIN users u ON u.id = p.manager_user_id";
const COUNT_FROM: &str =
    "SELECT COUNT(*) FROM projects p JOIN customers c ON c.id = p.customer_id \
     JOIN users u ON u.id = p.manager_user_id";

/// A validated input, ready to bind.
struct Clean {
    code: String,
    name: String,
    customer_id: i64,
    manager_user_id: i64,
    status: ProjectStatus,
    planned_start: Option<String>,
    planned_end: Option<String>,
    order_no: Option<String>,
    department: Option<String>,
    note: Option<String>,
}

fn parse_date(
    field: &str,
    value: &Option<String>,
    errors: &mut Vec<banto_core::FieldError>,
) -> (Option<String>, Option<Date>) {
    let Some(raw) = clean_optional(value) else {
        return (None, None);
    };
    match Date::parse(&raw) {
        Some(date) => (Some(raw), Some(date)),
        None => {
            errors.push(field_error(field, "日付は YYYY-MM-DD で入力してください"));
            (None, None)
        }
    }
}

fn length_check(
    field: &str,
    value: &Option<String>,
    max: usize,
    errors: &mut Vec<banto_core::FieldError>,
) -> Option<String> {
    let v = clean_optional(value);
    if v.as_deref().is_some_and(|s| s.chars().count() > max) {
        errors.push(field_error(
            field,
            format!("{max}文字以内で入力してください"),
        ));
    }
    v
}

/// Field rules (spec §5.1) via `cost_domain::project::validate_project`, plus
/// the lengths and formats the wire needs. `current` is the stored status on
/// update: moving onto the ordered side happens through order conversion
/// (P3b), never by editing the status here.
fn validate(input: &ProjectInput, current: Option<ProjectStatus>) -> Result<Clean, BantoError> {
    let mut errors = Vec::new();
    let code = input.code.trim().to_string();
    let name = input.name.trim().to_string();
    if code.chars().count() > MAX_CODE_LEN {
        errors.push(field_error(
            "code",
            format!("{MAX_CODE_LEN}文字以内で入力してください"),
        ));
    }
    if name.chars().count() > MAX_NAME_LEN {
        errors.push(field_error(
            "name",
            format!("{MAX_NAME_LEN}文字以内で入力してください"),
        ));
    }
    let status = ProjectStatus::parse(&input.status);
    if status.is_none() {
        errors.push(field_error("status", "状態が正しくありません"));
    }
    if let Some(status) = status {
        if Some(status) != current && !status.settable_directly() {
            errors.push(field_error(
                "status",
                "受注済みの状態へは受注転換で切り替えてください",
            ));
        }
    }
    let (planned_start, start) = parse_date("plannedStart", &input.planned_start, &mut errors);
    let (planned_end, end) = parse_date("plannedEnd", &input.planned_end, &mut errors);
    let order_no = length_check("orderNo", &input.order_no, MAX_CODE_LEN, &mut errors);
    let department = length_check("department", &input.department, MAX_NAME_LEN, &mut errors);
    let note = length_check("note", &input.note, MAX_TEXT_LEN, &mut errors);
    if let Some(status) = status {
        for issue in validate_project(&DomainInput {
            code: &code,
            name: &name,
            status,
            planned_start: start,
            planned_end: end,
        }) {
            errors.push(match issue {
                ProjectIssue::CodeRequired => field_error("code", "入力してください"),
                ProjectIssue::NameRequired => field_error("name", "入力してください"),
                ProjectIssue::PlannedDatesRequired => field_error(
                    if start.is_none() {
                        "plannedStart"
                    } else {
                        "plannedEnd"
                    },
                    "受注後は予定開始日と完了日が必要です",
                ),
                ProjectIssue::EndBeforeStart => {
                    field_error("plannedEnd", "完了日は開始日以降にしてください")
                }
            });
        }
    }
    if !errors.is_empty() {
        return Err(BantoError::Validation {
            field_errors: errors,
        });
    }
    Ok(Clean {
        code,
        name,
        customer_id: input.customer_id,
        manager_user_id: input.manager_user_id,
        status: status.expect("checked above"),
        planned_start,
        planned_end,
        order_no,
        department,
        note,
    })
}

#[derive(Clone)]
pub struct ProjectsService {
    db: Db,
}

impl ProjectsService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    fn ph(&self, n: usize) -> String {
        self.db.dialect().placeholder(n)
    }

    /// Projects in `scope` (T12: the same set `authorize(ViewProject)` allows).
    pub async fn list(
        &self,
        mut params: ListParams,
        scope: &ProjectScope,
    ) -> Result<ListResult<Project>, BantoError> {
        if let ProjectScope::Only(ids) = scope {
            if ids.is_empty() {
                return Ok(ListResult {
                    rows: Vec::new(),
                    total_count: 0,
                });
            }
            params.filters.push(FilterState {
                field: "id".into(),
                op: FilterOp::In,
                value: serde_json::json!(ids.iter().collect::<Vec<_>>()),
            });
        }
        let columns = column_map();
        match &self.db {
            Db::Sqlite(pool) => {
                let mut rows_builder: QueryBuilder<Sqlite> = QueryBuilder::new(SELECT_FROM);
                banto_storage::list_query::sqlite::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<Project> = rows_builder
                    .build_query_as()
                    .fetch_all(pool)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let mut count_builder: QueryBuilder<Sqlite> = QueryBuilder::new(COUNT_FROM);
                banto_storage::list_query::sqlite::append_where(
                    &mut count_builder,
                    &columns,
                    &params.filters,
                )?;
                let total_count: i64 = count_builder
                    .build_query_scalar()
                    .fetch_one(pool)
                    .await
                    .map_err(banto_storage::storage_error)?;
                Ok(ListResult {
                    rows,
                    total_count: total_count as u64,
                })
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut rows_builder: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(SELECT_FROM);
                banto_storage::list_query::postgres::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<Project> = rows_builder
                    .build_query_as()
                    .fetch_all(pool)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let mut count_builder: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(COUNT_FROM);
                banto_storage::list_query::postgres::append_where(
                    &mut count_builder,
                    &columns,
                    &params.filters,
                )?;
                let total_count: i64 = count_builder
                    .build_query_scalar()
                    .fetch_one(pool)
                    .await
                    .map_err(banto_storage::storage_error)?;
                Ok(ListResult {
                    rows,
                    total_count: total_count as u64,
                })
            }
        }
    }

    pub async fn get(&self, id: i64) -> Result<Project, BantoError> {
        let sql = format!("{SELECT_FROM} WHERE p.id = {}", self.ph(1));
        let row: Option<Project> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        row.ok_or_else(|| BantoError::NotFound {
            resource: "projects".into(),
            id: id.to_string(),
        })
    }

    /// The customer must exist and be active; the manager must be a user.
    async fn check_refs(
        &self,
        clean: &Clean,
        current_customer: Option<i64>,
    ) -> Result<(), BantoError> {
        let mut errors = Vec::new();
        let customer_sql = format!("SELECT active FROM customers WHERE id = {}", self.ph(1));
        let user_sql = format!("SELECT id FROM users WHERE id = {}", self.ph(1));
        let (customer, user): (Option<(bool,)>, Option<(i64,)>) = match &self.db {
            Db::Sqlite(pool) => (
                sqlx::query_as(sqlx::AssertSqlSafe(customer_sql))
                    .bind(clean.customer_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(banto_storage::storage_error)?,
                sqlx::query_as(sqlx::AssertSqlSafe(user_sql))
                    .bind(clean.manager_user_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(banto_storage::storage_error)?,
            ),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => (
                sqlx::query_as(sqlx::AssertSqlSafe(customer_sql))
                    .bind(clean.customer_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(banto_storage::storage_error)?,
                sqlx::query_as(sqlx::AssertSqlSafe(user_sql))
                    .bind(clean.manager_user_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(banto_storage::storage_error)?,
            ),
        };
        match customer {
            None => errors.push(field_error("customerId", "顧客が見つかりません")),
            // An inactive customer stays on the projects that already use it.
            Some((false,)) if current_customer != Some(clean.customer_id) => {
                errors.push(field_error("customerId", "使用中止の顧客は選べません"))
            }
            Some(_) => {}
        }
        if user.is_none() {
            errors.push(field_error("managerUserId", "責任者が見つかりません"));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(BantoError::Validation {
                field_errors: errors,
            })
        }
    }

    async fn code_taken(&self, code: &str, except: Option<i64>) -> Result<bool, BantoError> {
        let sql = format!(
            "SELECT id FROM projects WHERE code = {} AND id <> {}",
            self.ph(1),
            self.ph(2)
        );
        let row: Option<(i64,)> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(code)
                    .bind(except.unwrap_or(0))
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(code)
                    .bind(except.unwrap_or(0))
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        Ok(row.is_some())
    }

    /// Register a project. `sales_user_id`: the creator, when they registered
    /// it as its sales owner (`pipeline.edit`), becomes its `sales` member so
    /// they can keep editing its pipeline (ADR-0028).
    pub async fn create(
        &self,
        input: ProjectInput,
        sales_user_id: Option<i64>,
    ) -> Result<Project, BantoError> {
        let clean = validate(&input, None)?;
        self.check_refs(&clean, None).await?;
        if self.code_taken(&clean.code, None).await? {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("code", "この案件IDは既に使われています")],
            });
        }
        let insert = format!(
            "INSERT INTO projects (code, name, customer_id, manager_user_id, status, \
             planned_start, planned_end, order_no, department, note) \
             VALUES ({}) RETURNING id",
            self.db.dialect().placeholders(10)
        );
        let member = format!(
            "INSERT INTO project_members (project_id, user_id, kind) VALUES ({}, {}, {}) \
             ON CONFLICT (project_id, user_id, kind) DO NOTHING",
            self.ph(1),
            self.ph(2),
            self.ph(3)
        );
        let id: i64 = match &self.db {
            Db::Sqlite(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let id: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(insert))
                    .bind(&clean.code)
                    .bind(&clean.name)
                    .bind(clean.customer_id)
                    .bind(clean.manager_user_id)
                    .bind(clean.status.as_str())
                    .bind(&clean.planned_start)
                    .bind(&clean.planned_end)
                    .bind(&clean.order_no)
                    .bind(&clean.department)
                    .bind(&clean.note)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let mut members = vec![(clean.manager_user_id, "manager")];
                members.extend(sales_user_id.map(|u| (u, "sales")));
                for (user, kind) in members {
                    sqlx::query(sqlx::AssertSqlSafe(member.clone()))
                        .bind(id)
                        .bind(user)
                        .bind(kind)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
                id
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let id: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(insert))
                    .bind(&clean.code)
                    .bind(&clean.name)
                    .bind(clean.customer_id)
                    .bind(clean.manager_user_id)
                    .bind(clean.status.as_str())
                    .bind(&clean.planned_start)
                    .bind(&clean.planned_end)
                    .bind(&clean.order_no)
                    .bind(&clean.department)
                    .bind(&clean.note)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let mut members = vec![(clean.manager_user_id, "manager")];
                members.extend(sales_user_id.map(|u| (u, "sales")));
                for (user, kind) in members {
                    sqlx::query(sqlx::AssertSqlSafe(member.clone()))
                        .bind(id)
                        .bind(user)
                        .bind(kind)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
                id
            }
        };
        self.get(id).await
    }

    /// Update with optimistic concurrency (T13). A change of responsible
    /// person moves the `manager` membership in the same transaction.
    pub async fn update(&self, id: i64, input: ProjectInput) -> Result<Project, BantoError> {
        let current = self.get(id).await?;
        let current_status = ProjectStatus::parse(&current.status);
        let clean = validate(&input, current_status)?;
        let Some(row_version) = input.row_version else {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("rowVersion", "版番号がありません")],
            });
        };
        self.check_refs(&clean, Some(current.customer_id)).await?;
        if self.code_taken(&clean.code, Some(id)).await? {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("code", "この案件IDは既に使われています")],
            });
        }
        let update = format!(
            "UPDATE projects SET code = {}, name = {}, customer_id = {}, manager_user_id = {}, \
             status = {}, planned_start = {}, planned_end = {}, order_no = {}, department = {}, \
             note = {}, row_version = row_version + 1, updated_at = {} \
             WHERE id = {} AND row_version = {}",
            self.ph(1),
            self.ph(2),
            self.ph(3),
            self.ph(4),
            self.ph(5),
            self.ph(6),
            self.ph(7),
            self.ph(8),
            self.ph(9),
            self.ph(10),
            now_expr(self.db.dialect()),
            self.ph(11),
            self.ph(12)
        );
        let drop_manager = format!(
            "DELETE FROM project_members WHERE project_id = {} AND user_id = {} AND kind = 'manager'",
            self.ph(1),
            self.ph(2)
        );
        let add_manager = format!(
            "INSERT INTO project_members (project_id, user_id, kind) VALUES ({}, {}, 'manager') \
             ON CONFLICT (project_id, user_id, kind) DO NOTHING",
            self.ph(1),
            self.ph(2)
        );
        let manager_changed = current.manager_user_id != clean.manager_user_id;
        let affected = match &self.db {
            Db::Sqlite(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let affected = sqlx::query(sqlx::AssertSqlSafe(update))
                    .bind(&clean.code)
                    .bind(&clean.name)
                    .bind(clean.customer_id)
                    .bind(clean.manager_user_id)
                    .bind(clean.status.as_str())
                    .bind(&clean.planned_start)
                    .bind(&clean.planned_end)
                    .bind(&clean.order_no)
                    .bind(&clean.department)
                    .bind(&clean.note)
                    .bind(id)
                    .bind(row_version)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?
                    .rows_affected();
                if affected == 1 && manager_changed {
                    sqlx::query(sqlx::AssertSqlSafe(drop_manager))
                        .bind(id)
                        .bind(current.manager_user_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                    sqlx::query(sqlx::AssertSqlSafe(add_manager))
                        .bind(id)
                        .bind(clean.manager_user_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
                affected
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let affected = sqlx::query(sqlx::AssertSqlSafe(update))
                    .bind(&clean.code)
                    .bind(&clean.name)
                    .bind(clean.customer_id)
                    .bind(clean.manager_user_id)
                    .bind(clean.status.as_str())
                    .bind(&clean.planned_start)
                    .bind(&clean.planned_end)
                    .bind(&clean.order_no)
                    .bind(&clean.department)
                    .bind(&clean.note)
                    .bind(id)
                    .bind(row_version)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?
                    .rows_affected();
                if affected == 1 && manager_changed {
                    sqlx::query(sqlx::AssertSqlSafe(drop_manager))
                        .bind(id)
                        .bind(current.manager_user_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                    sqlx::query(sqlx::AssertSqlSafe(add_manager))
                        .bind(id)
                        .bind(clean.manager_user_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
                affected
            }
        };
        if affected == 0 {
            return Err(stale_version_error());
        }
        self.get(id).await
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::customers::{CustomerInput, CustomersService};
    use crate::db::migrate_memory;
    use banto_admin_services::authz::{AuthzService, MemberKind};
    use banto_admin_services::users::{Role, UsersService};
    use std::collections::BTreeSet;

    /// A migrated DB with two users (ids 1, 2) and one active customer (id 1).
    pub(crate) async fn fixture() -> Db {
        let db = migrate_memory().await.unwrap();
        let users = UsersService::new(db.clone());
        users
            .setup_first_user("admin", "password123", "管理者")
            .await
            .unwrap();
        users
            .create_user("pm", "password123", "案件責任者A", Role::Editor)
            .await
            .unwrap();
        CustomersService::new(db.clone())
            .create(CustomerInput {
                name: "架空工業".into(),
                active: true,
                note: None,
                row_version: None,
            })
            .await
            .unwrap();
        db
    }

    pub(crate) fn input(code: &str) -> ProjectInput {
        ProjectInput {
            code: code.into(),
            name: "制御盤更新".into(),
            customer_id: 1,
            manager_user_id: 2,
            status: "lead".into(),
            planned_start: None,
            planned_end: Some(String::new()),
            order_no: None,
            department: None,
            note: None,
            row_version: None,
        }
    }

    #[tokio::test]
    async fn create_keeps_the_manager_and_sales_memberships() {
        let db = fixture().await;
        let svc = ProjectsService::new(db.clone());
        let p = svc.create(input("P-001"), Some(1)).await.unwrap();
        assert_eq!(p.customer_name, "架空工業");
        assert_eq!(p.manager_name, "案件責任者A");
        assert_eq!(
            p.planned_end, None,
            "blank dates are undecided, not empty strings"
        );
        let members = AuthzService::new(db).project_members(p.id).await.unwrap();
        let kinds: Vec<_> = members.iter().map(|m| (m.user_id, m.kind)).collect();
        assert_eq!(
            kinds,
            vec![(1, MemberKind::Sales), (2, MemberKind::Manager)]
        );
    }

    #[tokio::test]
    async fn changing_the_manager_moves_the_membership() {
        let db = fixture().await;
        let svc = ProjectsService::new(db.clone());
        let p = svc.create(input("P-001"), None).await.unwrap();
        let mut change = input("P-001");
        change.manager_user_id = 1;
        change.row_version = Some(p.row_version);
        let updated = svc.update(p.id, change).await.unwrap();
        assert_eq!(updated.manager_user_id, 1);
        let members = AuthzService::new(db).project_members(p.id).await.unwrap();
        assert_eq!(
            members
                .iter()
                .map(|m| (m.user_id, m.kind))
                .collect::<Vec<_>>(),
            vec![(1, MemberKind::Manager)]
        );
    }

    #[tokio::test]
    async fn t12_list_is_limited_to_the_scope() {
        let db = fixture().await;
        let svc = ProjectsService::new(db);
        let a = svc.create(input("P-001"), None).await.unwrap();
        svc.create(input("P-002"), None).await.unwrap();
        let all = svc
            .list(ListParams::default(), &ProjectScope::All)
            .await
            .unwrap();
        assert_eq!(all.total_count, 2);
        let only = svc
            .list(
                ListParams::default(),
                &ProjectScope::Only(BTreeSet::from([a.id])),
            )
            .await
            .unwrap();
        assert_eq!(only.total_count, 1);
        assert_eq!(only.rows[0].code, "P-001");
        let none = svc
            .list(ListParams::default(), &ProjectScope::Only(BTreeSet::new()))
            .await
            .unwrap();
        assert_eq!(none.total_count, 0);
    }

    #[tokio::test]
    async fn validation_follows_the_ledger_rules() {
        let db = fixture().await;
        let svc = ProjectsService::new(db);
        // Ordered statuses are reached through order conversion, not editing.
        let mut ordered = input("P-001");
        ordered.status = "ordered".into();
        ordered.planned_start = Some("2026-12-01".into());
        ordered.planned_end = Some("2027-03-31".into());
        let err = svc.create(ordered, None).await.unwrap_err();
        assert!(
            matches!(err, BantoError::Validation { ref field_errors } if field_errors[0].field == "status")
        );

        let mut bad = input(" ");
        bad.planned_start = Some("2027-04-01".into());
        bad.planned_end = Some("2027-03-31".into());
        bad.customer_id = 99;
        let err = svc.create(bad, None).await.unwrap_err();
        let BantoError::Validation { field_errors } = err else {
            panic!("validation expected");
        };
        let fields: Vec<_> = field_errors.iter().map(|e| e.field.as_str()).collect();
        assert_eq!(fields, vec!["code", "plannedEnd"]);

        let mut missing_customer = input("P-009");
        missing_customer.customer_id = 99;
        let err = svc.create(missing_customer, None).await.unwrap_err();
        assert!(
            matches!(err, BantoError::Validation { ref field_errors } if field_errors[0].field == "customerId")
        );

        svc.create(input("P-001"), None).await.unwrap();
        let err = svc.create(input("P-001"), None).await.unwrap_err();
        assert!(
            matches!(err, BantoError::Validation { ref field_errors } if field_errors[0].field == "code")
        );
    }

    #[tokio::test]
    async fn t13_stale_project_update_is_refused() {
        let db = fixture().await;
        let svc = ProjectsService::new(db);
        let p = svc.create(input("P-001"), None).await.unwrap();
        let mut first = input("P-001");
        first.name = "制御盤更新（一次）".into();
        first.row_version = Some(p.row_version);
        svc.update(p.id, first).await.unwrap();
        let mut stale = input("P-001");
        stale.status = "lost".into();
        stale.row_version = Some(p.row_version);
        let err = svc.update(p.id, stale).await.unwrap_err();
        assert!(
            matches!(err, BantoError::Validation { ref field_errors } if field_errors[0].field == "rowVersion")
        );
        assert_eq!(svc.get(p.id).await.unwrap().status, "lead");
    }
}
