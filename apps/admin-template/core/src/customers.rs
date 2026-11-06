//! Customers master (banto-cost P3a, `docs/project/design.md` §3.1).
//!
//! Service-layer shape (conventions §2): `Clone`, `BantoError`, sqlx, no
//! tauri/axum. Authorization (`Operation::ViewMasters` / `EditMasters`,
//! ADR-0028) and audit are added by the REST/Tauri wiring. Customers are
//! never deleted - a customer that is no longer used is marked inactive, so
//! the projects that refer to it keep their history.

use banto_core::{BantoError, FieldError, ListParams, ListResult};
use banto_server::ServerEvent;
use banto_storage::{ColumnMap, Db, Dialect};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite};
use tokio::sync::broadcast;

pub const MAX_NAME_LEN: usize = 100;
pub const MAX_NOTE_LEN: usize = 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Customer {
    pub id: i64,
    pub name: String,
    pub active: bool,
    pub note: Option<String>,
    /// Optimistic-concurrency token (T13): an update must send the version it
    /// read, and a stale one is refused instead of silently overwriting.
    pub row_version: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerInput {
    pub name: String,
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default)]
    pub note: Option<String>,
    /// Required on update (T13); ignored on create.
    #[serde(default)]
    pub row_version: Option<i64>,
}

fn default_true() -> bool {
    true
}

fn column_map() -> ColumnMap {
    ColumnMap::new()
        .column("id", "id")
        .column("name", "name")
        .column("active", "active")
        .column("updatedAt", "updated_at")
}

pub(crate) fn now_expr(dialect: Dialect) -> &'static str {
    match dialect {
        Dialect::Sqlite => "datetime('now')",
        Dialect::Postgres => "now()::text",
    }
}

pub(crate) fn field_error(field: &str, message: impl Into<String>) -> FieldError {
    FieldError {
        field: field.to_string(),
        message: message.into(),
    }
}

/// The error a stale `rowVersion` produces (T13): someone else saved first.
pub(crate) fn stale_version_error() -> BantoError {
    BantoError::Validation {
        field_errors: vec![field_error(
            "rowVersion",
            "他の利用者が先に更新しました。再読み込みしてから入力し直してください",
        )],
    }
}

/// Trim an optional text field; an empty string is stored as NULL.
pub(crate) fn clean_optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn validate(input: &CustomerInput) -> Result<(String, Option<String>), BantoError> {
    let mut errors = Vec::new();
    let name = input.name.trim().to_string();
    if name.is_empty() {
        errors.push(field_error("name", "入力してください"));
    } else if name.chars().count() > MAX_NAME_LEN {
        errors.push(field_error(
            "name",
            format!("{MAX_NAME_LEN}文字以内で入力してください"),
        ));
    }
    let note = clean_optional(&input.note);
    if note
        .as_deref()
        .is_some_and(|n| n.chars().count() > MAX_NOTE_LEN)
    {
        errors.push(field_error(
            "note",
            format!("{MAX_NOTE_LEN}文字以内で入力してください"),
        ));
    }
    if errors.is_empty() {
        Ok((name, note))
    } else {
        Err(BantoError::Validation {
            field_errors: errors,
        })
    }
}

const SELECT_COLUMNS: &str = "id, name, active, note, row_version, updated_at";

#[derive(Clone)]
pub struct CustomersService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl CustomersService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    /// Emit `ServerEvent::ResourceChanged { resource: "customers" }` after each
    /// committed write (spec §3.5), so other clients' `customers` screens refetch
    /// and their nav badge counts the change. Wired by `banto-serve` and
    /// `src-tauri` with the app-wide `event_channel()` sender.
    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn notify_changed(&self) {
        crate::events::notify_changed(&self.events, "customers");
    }

    fn ph(&self, n: usize) -> String {
        self.db.dialect().placeholder(n)
    }

    pub async fn list(&self, params: ListParams) -> Result<ListResult<Customer>, BantoError> {
        let columns = column_map();
        let select_rows = format!("SELECT {SELECT_COLUMNS} FROM customers");
        const SELECT_COUNT: &str = "SELECT COUNT(*) FROM customers";
        match &self.db {
            Db::Sqlite(pool) => {
                let mut rows_builder: QueryBuilder<Sqlite> = QueryBuilder::new(select_rows);
                banto_storage::list_query::sqlite::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<Customer> = rows_builder
                    .build_query_as()
                    .fetch_all(pool)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let mut count_builder: QueryBuilder<Sqlite> = QueryBuilder::new(SELECT_COUNT);
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
                let mut rows_builder: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(select_rows);
                banto_storage::list_query::postgres::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<Customer> = rows_builder
                    .build_query_as()
                    .fetch_all(pool)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let mut count_builder: QueryBuilder<sqlx::Postgres> =
                    QueryBuilder::new(SELECT_COUNT);
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

    pub async fn get(&self, id: i64) -> Result<Customer, BantoError> {
        let sql = format!(
            "SELECT {SELECT_COLUMNS} FROM customers WHERE id = {}",
            self.ph(1)
        );
        let row: Option<Customer> = match &self.db {
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
            resource: "customers".into(),
            id: id.to_string(),
        })
    }

    pub async fn create(&self, input: CustomerInput) -> Result<Customer, BantoError> {
        let (name, note) = validate(&input)?;
        let sql = format!(
            "INSERT INTO customers (name, active, note) VALUES ({}, {}, {}) RETURNING id",
            self.ph(1),
            self.ph(2),
            self.ph(3)
        );
        let id: i64 = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .bind(&name)
                    .bind(input.active)
                    .bind(&note)
                    .fetch_one(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .bind(&name)
                    .bind(input.active)
                    .bind(&note)
                    .fetch_one(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        self.notify_changed();
        self.get(id).await
    }

    /// Update with optimistic concurrency (T13): `input.row_version` must be
    /// the version the caller read.
    pub async fn update(&self, id: i64, input: CustomerInput) -> Result<Customer, BantoError> {
        let (name, note) = validate(&input)?;
        let Some(row_version) = input.row_version else {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("rowVersion", "版番号がありません")],
            });
        };
        self.get(id).await?;
        let sql = format!(
            "UPDATE customers SET name = {}, active = {}, note = {}, \
             row_version = row_version + 1, updated_at = {} \
             WHERE id = {} AND row_version = {}",
            self.ph(1),
            self.ph(2),
            self.ph(3),
            now_expr(self.db.dialect()),
            self.ph(4),
            self.ph(5)
        );
        let affected = match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(&name)
                .bind(input.active)
                .bind(&note)
                .bind(id)
                .bind(row_version)
                .execute(pool)
                .await
                .map(|r| r.rows_affected()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(&name)
                .bind(input.active)
                .bind(&note)
                .bind(id)
                .bind(row_version)
                .execute(pool)
                .await
                .map(|r| r.rows_affected()),
        }
        .map_err(banto_storage::storage_error)?;
        if affected == 0 {
            return Err(stale_version_error());
        }
        self.notify_changed();
        self.get(id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_memory;

    fn input(name: &str) -> CustomerInput {
        CustomerInput {
            name: name.into(),
            active: true,
            note: Some("  ".into()),
            row_version: None,
        }
    }

    #[tokio::test]
    async fn create_get_list_and_update() {
        let svc = CustomersService::new(migrate_memory().await.unwrap());
        let created = svc.create(input(" 架空工業 ")).await.unwrap();
        assert_eq!(created.name, "架空工業");
        assert_eq!(created.note, None, "a blank note is stored as NULL");
        assert!(created.active);
        assert_eq!(created.row_version, 1);
        let list = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(list.total_count, 1);

        let mut change = input("架空工業株式会社");
        change.active = false;
        change.row_version = Some(1);
        let updated = svc.update(created.id, change).await.unwrap();
        assert_eq!(updated.row_version, 2);
        assert!(!updated.active);
    }

    #[tokio::test]
    async fn successful_writes_emit_one_resource_changed_and_failures_none() {
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = CustomersService::new(migrate_memory().await.unwrap()).with_events(tx);
        let created = svc.create(input("架空商事")).await.unwrap();
        let mut change = input("架空商事株式会社");
        change.row_version = Some(1);
        svc.update(created.id, change.clone()).await.unwrap();
        for _ in 0..2 {
            match rx.try_recv().expect("one event per write") {
                ServerEvent::ResourceChanged { resource } => assert_eq!(resource, "customers"),
                other => panic!("unexpected event {other:?}"),
            }
        }
        // Validation error and stale row_version: nothing written, nothing sent.
        assert!(svc.create(input("  ")).await.is_err());
        assert!(svc.update(created.id, change).await.is_err());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn t13_a_stale_row_version_is_refused_not_overwritten() {
        let svc = CustomersService::new(migrate_memory().await.unwrap());
        let created = svc.create(input("架空商事")).await.unwrap();
        let mut first = input("架空商事A");
        first.row_version = Some(created.row_version);
        svc.update(created.id, first).await.unwrap();
        // A second editor still holding version 1.
        let mut second = input("架空商事B");
        second.row_version = Some(created.row_version);
        let err = svc.update(created.id, second).await.unwrap_err();
        assert!(matches!(
            err,
            BantoError::Validation { ref field_errors } if field_errors[0].field == "rowVersion"
        ));
        assert_eq!(svc.get(created.id).await.unwrap().name, "架空商事A");
    }

    #[tokio::test]
    async fn validation_and_missing_rows() {
        let svc = CustomersService::new(migrate_memory().await.unwrap());
        assert!(matches!(
            svc.create(input("  ")).await,
            Err(BantoError::Validation { .. })
        ));
        assert!(matches!(svc.get(9).await, Err(BantoError::NotFound { .. })));
        let mut change = input("x");
        change.row_version = Some(1);
        assert!(matches!(
            svc.update(9, change).await,
            Err(BantoError::NotFound { .. })
        ));
    }
}
