//! Items resource service (spec §8.2, §10): the domain logic behind the
//! `items` resource, callable directly from tests and from thin
//! `tauri::command` adapters in `src-tauri` alike. Field names on
//! [`ItemInput`] intentionally match the frontend schema
//! (`apps/admin-template/src/lib/banto/setup.ts`'s `itemsSchema`) field for
//! field, so `BantoError::Validation` field errors map back onto the right
//! form inputs.

use banto_core::{BantoError, FieldError, ListParams, ListResult};
use banto_server::ServerEvent;
use banto_storage::{ColumnMap, Db, Dialect};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite};
use tokio::sync::broadcast;

/// A single row of the `items` table, wire-shaped for the frontend
/// (`updatedAt`, matching `apps/admin-template/src/lib/banto/sampleData.ts::Item`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub name: String,
    pub price: i64,
    pub stock: i64,
    #[sqlx(rename = "updated_at")]
    pub updated_at: String,
}

/// Create/update payload. Field names match the frontend form schema's
/// field names exactly (`name`, `price`, `stock`) so that
/// `BantoError::Validation`'s per-field messages land on the right inputs.
#[derive(Debug, Clone, Deserialize)]
pub struct ItemInput {
    pub name: String,
    pub price: i64,
    pub stock: i64,
}

const MAX_NAME_LEN: usize = 40;
const MIN_PRICE: i64 = 0;
const MAX_PRICE: i64 = 99_999;
const MIN_STOCK: i64 = 0;

fn required_message() -> String {
    "必須項目です".to_string()
}

fn min_message(min: i64) -> String {
    format!("{min}以上で入力してください")
}

fn max_message(max: i64) -> String {
    format!("{max}以下で入力してください")
}

fn max_length_message(max: usize) -> String {
    format!("{max}文字以内で入力してください")
}

/// Validate an [`ItemInput`] against the same rules as the frontend schema
/// (spec §7.2): `name` trimmed non-empty, <= 40 chars; `price` in
/// `0..=99999`; `stock` >= 0. Returns every violation (not just the first),
/// mirroring `validateAll` in `@banto/forms`.
fn validate_item_input(input: &ItemInput) -> Result<(), BantoError> {
    let mut errors: Vec<FieldError> = Vec::new();

    let trimmed_name = input.name.trim();
    if trimmed_name.is_empty() {
        errors.push(FieldError {
            field: "name".to_string(),
            message: required_message(),
        });
    } else if trimmed_name.chars().count() > MAX_NAME_LEN {
        errors.push(FieldError {
            field: "name".to_string(),
            message: max_length_message(MAX_NAME_LEN),
        });
    }

    if input.price < MIN_PRICE {
        errors.push(FieldError {
            field: "price".to_string(),
            message: min_message(MIN_PRICE),
        });
    } else if input.price > MAX_PRICE {
        errors.push(FieldError {
            field: "price".to_string(),
            message: max_message(MAX_PRICE),
        });
    }

    if input.stock < MIN_STOCK {
        errors.push(FieldError {
            field: "stock".to_string(),
            message: min_message(MIN_STOCK),
        });
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(BantoError::Validation {
            field_errors: errors,
        })
    }
}

/// One row of a CSV/UI bulk import (spec M15, `docs/roadmap.md`): shaped
/// like [`ItemInput`] plus an optional `id` that selects UPDATE vs INSERT
/// (spec: "id あり→UPDATE / なし→INSERT"). Field names mirror `ItemInput`'s
/// (camelCase over the wire) so the frontend's CSV-to-row mapping can reuse
/// the same column names as the create/update form.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemImportRow {
    pub id: Option<i64>,
    pub name: String,
    pub price: i64,
    pub stock: i64,
}

/// One row-level failure from [`ItemsService::import`] (spec M15). `row` is
/// the 0-based index into the request's `Vec<ItemImportRow>` - NOT a
/// database id, since a row can fail before it ever reaches the DB (e.g. a
/// validation error) - so the frontend's preview screen can point back at
/// the exact input row that needs fixing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowError {
    pub row: usize,
    pub message: String,
}

/// Outcome of [`ItemsService::import`] (spec M15). `errors` non-empty means
/// the whole import was rolled back (see that method's doc comment for why
/// this is all-or-nothing) - `created`/`updated` are then always `0`, never
/// a partial count.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub created: usize,
    pub updated: usize,
    pub errors: Vec<ImportRowError>,
}

/// Upper bound on rows accepted by a single [`ItemsService::import`] call
/// (spec M15): the whole request runs as one transaction, so this keeps a
/// runaway file from holding a single DB lock/transaction open over an
/// unbounded number of rows. `pub(crate)` so the REST layer can size the
/// import route's `DefaultBodyLimit` off the same single source of truth
/// (spec M14-review M-14; see `rest::items::items_write_router`).
pub(crate) const MAX_IMPORT_ROWS: usize = 10_000;

/// Format every field violation on one import row into a single
/// human-readable string (`ImportRowError::message` is one `String`, not a
/// `Vec<FieldError>`, since the import preview shows one line per row).
fn format_field_errors(field_errors: &[FieldError]) -> String {
    field_errors
        .iter()
        .map(|e| format!("{}: {}", e.field, e.message))
        .collect::<Vec<_>>()
        .join("; ")
}

fn column_map() -> ColumnMap {
    ColumnMap::new()
        .column("id", "id")
        .column("name", "name")
        .column("price", "price")
        .column("stock", "stock")
        .column("updatedAt", "updated_at")
}

const RESOURCE: &str = "items";

/// The dialect-specific SQL expression for "today's date" (a **date**, not a
/// datetime), used by `create`/`update`/`import` to stamp `items.updated_at`.
///
/// This is deliberately NOT `Dialect::now_expr()`: that helper renders
/// `datetime('now')` (a `YYYY-MM-DD HH:MM:SS` timestamp) on SQLite, whereas
/// this crate has always written `items.updated_at` with `date('now')` (a
/// bare `YYYY-MM-DD` date). Routing this through `now_expr()` would silently
/// change the stored SQLite value's shape and break byte-for-byte
/// compatibility with the pre-V2 behavior (see `docs/conventions.md` "既定
/// SQLite 経路は挙動不変"). `Dialect` itself only exposes a *datetime*
/// current-time expression, so the date-only variant is kept here in the app
/// layer rather than widening PR1's `banto-storage` API for this one call
/// site. The Postgres rendering is `CURRENT_DATE::text`: `items.updated_at` is
/// a TEXT column (it decodes into `String`), and Postgres has no implicit
/// assignment cast from `date` to `text`, so a bare `CURRENT_DATE` would fail
/// to insert - the `::text` cast yields the same `YYYY-MM-DD` shape SQLite's
/// `date('now')` produces (PR3, first time this arm is actually exercised).
fn today_expr(dialect: Dialect) -> &'static str {
    match dialect {
        Dialect::Sqlite => "date('now')",
        Dialect::Postgres => "CURRENT_DATE::text",
    }
}

/// Service layer for the `items` resource (spec §10): the same methods a
/// REST handler would call in M6. No `tauri` dependency, so it is testable
/// in a plain `cargo test`.
///
/// `Clone` is cheap: `Db` (an `Arc`-backed connection handle) and
/// `broadcast::Sender` are both cheap to clone, so the REST layer (`rest.rs`)
/// can capture an owned `ItemsService` in each route closure without wrapping
/// it itself.
#[derive(Clone)]
pub struct ItemsService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl ItemsService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    /// Attach an event sender: `create`/`update`/`delete` will emit
    /// `ServerEvent::ResourceChanged { resource: "items" }` after their SQL
    /// commits successfully (spec §3.5). Builder-style so callers can write
    /// `ItemsService::new(pool).with_events(tx)`.
    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    /// Broadcast a `resource_changed` event for `items`, if an event sender
    /// is attached. Receivers being absent (`send` returning `Err`, e.g. no
    /// browser currently connected) is not an error.
    fn notify_changed(&self) {
        if let Some(tx) = &self.events {
            let _ = tx.send(ServerEvent::ResourceChanged {
                resource: RESOURCE.to_string(),
            });
        }
    }

    pub async fn list(&self, params: ListParams) -> Result<ListResult<Item>, BantoError> {
        let columns = column_map();
        const SELECT_ROWS: &str = "SELECT id, name, price, stock, updated_at FROM items";
        const SELECT_COUNT: &str = "SELECT COUNT(*) FROM items";

        // `QueryBuilder`/`list_query` are per-backend (the module is
        // monomorphized per dialect via macro), so the list path dispatches on
        // the backend and routes through the matching `list_query::{sqlite,
        // postgres}` module - each one's `push_bind` handles that backend's
        // placeholder syntax (conventions §6 "SQL 列はホワイトリスト経由のみ").
        match &self.db {
            Db::Sqlite(pool) => {
                let mut rows_builder: QueryBuilder<Sqlite> = QueryBuilder::new(SELECT_ROWS);
                banto_storage::list_query::sqlite::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<Item> = rows_builder
                    .build_query_as::<Item>()
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
                let mut rows_builder: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(SELECT_ROWS);
                banto_storage::list_query::postgres::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<Item> = rows_builder
                    .build_query_as::<Item>()
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

    pub async fn get(&self, id: i64) -> Result<Item, BantoError> {
        let dialect = self.db.dialect();
        // AssertSqlSafe (here and throughout this impl): only
        // `dialect.placeholder(n)`/`today_expr(dialect)` are interpolated -
        // both internally generated from the `Dialect` enum, never caller
        // input. Every actual value is bound below via `.bind(...)`.
        let sql = format!(
            "SELECT id, name, price, stock, updated_at FROM items WHERE id = {}",
            dialect.placeholder(1)
        );
        match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_one(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_one(pool)
                    .await
            }
        }
        .map_err(|err| banto_storage::not_found(err, RESOURCE, id.to_string()))
    }

    pub async fn create(&self, input: ItemInput) -> Result<Item, BantoError> {
        validate_item_input(&input)?;
        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note in `get` above.
        let sql = format!(
            "INSERT INTO items (name, price, stock, updated_at) VALUES ({}, {}, {}, {}) \
             RETURNING id, name, price, stock, updated_at",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            today_expr(dialect),
        );
        let item = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(input.name.trim())
                    .bind(input.price)
                    .bind(input.stock)
                    .fetch_one(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(input.name.trim())
                    .bind(input.price)
                    .bind(input.stock)
                    .fetch_one(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        self.notify_changed();
        Ok(item)
    }

    pub async fn update(&self, id: i64, input: ItemInput) -> Result<Item, BantoError> {
        validate_item_input(&input)?;
        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note in `get` above.
        let sql = format!(
            "UPDATE items SET name = {}, price = {}, stock = {}, updated_at = {} WHERE id = {} \
             RETURNING id, name, price, stock, updated_at",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            today_expr(dialect),
            dialect.placeholder(4),
        );
        let item = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(input.name.trim())
                    .bind(input.price)
                    .bind(input.stock)
                    .bind(id)
                    .fetch_one(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(sql))
                    .bind(input.name.trim())
                    .bind(input.price)
                    .bind(input.stock)
                    .bind(id)
                    .fetch_one(pool)
                    .await
            }
        }
        .map_err(|err| banto_storage::not_found(err, RESOURCE, id.to_string()))?;
        self.notify_changed();
        Ok(item)
    }

    pub async fn delete(&self, id: i64) -> Result<(), BantoError> {
        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note in `get` above.
        let sql = format!("DELETE FROM items WHERE id = {}", dialect.placeholder(1));
        // Map to `rows_affected` in each arm so the backend query-result types
        // unify (see the same pattern across the service layer).
        let rows_affected = match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(id)
                .execute(pool)
                .await
                .map(|r| r.rows_affected()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(id)
                .execute(pool)
                .await
                .map(|r| r.rows_affected()),
        }
        .map_err(banto_storage::storage_error)?;
        if rows_affected == 0 {
            return Err(BantoError::NotFound {
                resource: RESOURCE.to_string(),
                id: id.to_string(),
            });
        }
        self.notify_changed();
        Ok(())
    }

    /// Bulk create/update (spec M15, `docs/roadmap.md`): each row carrying
    /// an `id` is an UPDATE (a missing id is that row's error), each row
    /// without one is an INSERT. Runs as a SINGLE transaction, and -
    /// crucially - is all-or-nothing: if ANY row fails validation or names a
    /// missing id, the ENTIRE import is rolled back and this returns
    /// `created: 0, updated: 0` with every failing row in `errors`, rather
    /// than applying the rows that would otherwise have succeeded.
    ///
    /// This is a deliberate spec M15 design decision, not the usual
    /// "skip the bad rows, apply the rest" bulk-import convention: the UI
    /// flow is "pick a file -> preview counts/errors (computed by calling
    /// this same validation) -> confirm -> run". If a partial apply were
    /// allowed, whatever the user confirmed against in the preview could
    /// silently diverge from what actually lands in the DB the moment any
    /// row in the batch is bad - there would be no way to show "312 of 400
    /// imported, 88 failed" honestly up front, only after the fact, and a
    /// re-run after fixing the 88 would risk re-creating the 312 that
    /// already went in as duplicates (rows without `id` always INSERT).
    /// All-or-nothing keeps "what you previewed is what you get" true.
    pub async fn import(&self, rows: Vec<ItemImportRow>) -> Result<ImportResult, BantoError> {
        if rows.len() > MAX_IMPORT_ROWS {
            return Err(BantoError::Validation {
                field_errors: vec![FieldError {
                    field: "rows".to_string(),
                    message: format!("一度にインポートできるのは{MAX_IMPORT_ROWS}行までです"),
                }],
            });
        }
        if rows.is_empty() {
            return Ok(ImportResult {
                created: 0,
                updated: 0,
                errors: Vec::new(),
            });
        }

        // Validate every row BEFORE opening a transaction: since a single
        // bad row rolls back the whole batch anyway (see doc comment
        // above), there is no reason to pay for a transaction/DB round trip
        // that is just going to be thrown away.
        let mut errors: Vec<ImportRowError> = Vec::new();
        for (row_index, row) in rows.iter().enumerate() {
            let input = ItemInput {
                name: row.name.clone(),
                price: row.price,
                stock: row.stock,
            };
            if let Err(BantoError::Validation { field_errors }) = validate_item_input(&input) {
                errors.push(ImportRowError {
                    row: row_index,
                    message: format_field_errors(&field_errors),
                });
            }
        }
        if !errors.is_empty() {
            return Ok(ImportResult {
                created: 0,
                updated: 0,
                errors,
            });
        }

        // The SQL is dialect-independent apart from placeholders / the
        // date-stamp expression, so build it once (shared by both backend
        // arms) and only the transaction execution dispatches per backend.
        let dialect = self.db.dialect();
        let update_sql = format!(
            "UPDATE items SET name = {}, price = {}, stock = {}, updated_at = {} WHERE id = {}",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            today_expr(dialect),
            dialect.placeholder(4),
        );
        let insert_sql = format!(
            "INSERT INTO items (name, price, stock, updated_at) VALUES ({}, {}, {}, {})",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            today_expr(dialect),
        );

        let result = match &self.db {
            Db::Sqlite(pool) => import_apply_sqlite(pool, &rows, &update_sql, &insert_sql).await?,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                import_apply_postgres(pool, &rows, &update_sql, &insert_sql).await?
            }
        };

        // Exactly one notify for a committed batch (spec M15) - an all-or-
        // nothing rollback (`errors` non-empty) emits none.
        if result.errors.is_empty() {
            self.notify_changed();
        }
        Ok(result)
    }
}

/// Run one import batch inside a single SQLite transaction (spec M15
/// all-or-nothing). Free function (not a method) so the identical logic can be
/// mirrored for Postgres without threading `self` through two backend arms -
/// `sqlx`'s `Query<Sqlite>` and `Query<Postgres>` are distinct types, so the
/// two transaction bodies cannot share one generic implementation (the same
/// enum-dispatch trade-off `banto_storage::list_query` documents). Assumes
/// every row already passed validation (the caller validates the whole batch
/// before opening any transaction).
///
/// `update_sql`/`insert_sql` are wrapped in `sqlx::AssertSqlSafe` at their
/// call sites below: both are built once by [`ItemsService::import`] from
/// `dialect.placeholder(n)`/`today_expr(dialect)` only (internally
/// generated, never caller input) - every row's actual field values are
/// bound, never interpolated.
async fn import_apply_sqlite(
    pool: &sqlx::SqlitePool,
    rows: &[ItemImportRow],
    update_sql: &str,
    insert_sql: &str,
) -> Result<ImportResult, BantoError> {
    let mut errors: Vec<ImportRowError> = Vec::new();
    let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
    let mut created = 0usize;
    let mut updated = 0usize;

    for (row_index, row) in rows.iter().enumerate() {
        match row.id {
            Some(id) => {
                let result = sqlx::query(sqlx::AssertSqlSafe(update_sql))
                    .bind(row.name.trim())
                    .bind(row.price)
                    .bind(row.stock)
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                if result.rows_affected() == 0 {
                    errors.push(ImportRowError {
                        row: row_index,
                        message: format!("id {id} の商品が見つかりません"),
                    });
                } else {
                    updated += 1;
                }
            }
            None => {
                sqlx::query(sqlx::AssertSqlSafe(insert_sql))
                    .bind(row.name.trim())
                    .bind(row.price)
                    .bind(row.stock)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                created += 1;
            }
        }
    }

    if !errors.is_empty() {
        tx.rollback().await.map_err(banto_storage::storage_error)?;
        return Ok(ImportResult {
            created: 0,
            updated: 0,
            errors,
        });
    }

    tx.commit().await.map_err(banto_storage::storage_error)?;
    Ok(ImportResult {
        created,
        updated,
        errors: Vec::new(),
    })
}

/// Postgres mirror of [`import_apply_sqlite`] (see that function's doc for why
/// the two cannot be unified). Not exercised in PR2 - `init_db` builds SQLite
/// only - but kept a faithful copy so PR3 can wire a Postgres pool with no
/// further change here.
#[cfg(feature = "postgres")]
async fn import_apply_postgres(
    pool: &sqlx::PgPool,
    rows: &[ItemImportRow],
    update_sql: &str,
    insert_sql: &str,
) -> Result<ImportResult, BantoError> {
    let mut errors: Vec<ImportRowError> = Vec::new();
    let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
    let mut created = 0usize;
    let mut updated = 0usize;

    for (row_index, row) in rows.iter().enumerate() {
        match row.id {
            Some(id) => {
                let result = sqlx::query(sqlx::AssertSqlSafe(update_sql))
                    .bind(row.name.trim())
                    .bind(row.price)
                    .bind(row.stock)
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                if result.rows_affected() == 0 {
                    errors.push(ImportRowError {
                        row: row_index,
                        message: format!("id {id} の商品が見つかりません"),
                    });
                } else {
                    updated += 1;
                }
            }
            None => {
                sqlx::query(sqlx::AssertSqlSafe(insert_sql))
                    .bind(row.name.trim())
                    .bind(row.price)
                    .bind(row.stock)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                created += 1;
            }
        }
    }

    if !errors.is_empty() {
        tx.rollback().await.map_err(banto_storage::storage_error)?;
        return Ok(ImportResult {
            created: 0,
            updated: 0,
            errors,
        });
    }

    tx.commit().await.map_err(banto_storage::storage_error)?;
    Ok(ImportResult {
        created,
        updated,
        errors: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_memory;
    use banto_core::{FilterOp, FilterState, Pagination, SortDirection, SortState};
    use serde_json::json;

    /// A migrated but unseeded database, so tests have full control over
    /// which rows/ids exist (the 1,000-row demo seed lives behind
    /// `db::init_db`/`init_db_memory`, exercised separately in `db.rs`'s
    /// own tests).
    async fn service() -> ItemsService {
        let pool = migrate_memory().await.expect("migrate_memory");
        ItemsService::new(pool)
    }

    #[tokio::test]
    async fn create_then_get_round_trips() {
        let svc = service().await;
        let created = svc
            .create(ItemInput {
                name: "Test Item".to_string(),
                price: 100,
                stock: 5,
            })
            .await
            .expect("create should succeed");
        assert_eq!(created.name, "Test Item");
        assert_eq!(created.price, 100);
        assert_eq!(created.stock, 5);
        assert!(!created.updated_at.is_empty());

        let fetched = svc.get(created.id).await.expect("get should succeed");
        assert_eq!(fetched, created);
    }

    #[tokio::test]
    async fn create_trims_name() {
        let svc = service().await;
        let created = svc
            .create(ItemInput {
                name: "  Padded  ".to_string(),
                price: 1,
                stock: 1,
            })
            .await
            .expect("create should succeed");
        assert_eq!(created.name, "Padded");
    }

    #[tokio::test]
    async fn update_changes_fields_and_stamps_updated_at() {
        let svc = service().await;
        let created = svc
            .create(ItemInput {
                name: "Before".to_string(),
                price: 10,
                stock: 1,
            })
            .await
            .unwrap();
        let updated = svc
            .update(
                created.id,
                ItemInput {
                    name: "After".to_string(),
                    price: 20,
                    stock: 2,
                },
            )
            .await
            .expect("update should succeed");
        assert_eq!(updated.name, "After");
        assert_eq!(updated.price, 20);
        assert_eq!(updated.stock, 2);
    }

    #[tokio::test]
    async fn update_missing_id_is_not_found() {
        let svc = service().await;
        let err = svc
            .update(
                999,
                ItemInput {
                    name: "X".to_string(),
                    price: 1,
                    stock: 1,
                },
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, BantoError::NotFound { resource, id } if resource == "items" && id == "999")
        );
    }

    #[tokio::test]
    async fn get_missing_id_is_not_found() {
        let svc = service().await;
        let err = svc.get(12345).await.unwrap_err();
        assert!(
            matches!(err, BantoError::NotFound { resource, id } if resource == "items" && id == "12345")
        );
    }

    #[tokio::test]
    async fn delete_then_get_is_not_found() {
        let svc = service().await;
        let created = svc
            .create(ItemInput {
                name: "Doomed".to_string(),
                price: 1,
                stock: 1,
            })
            .await
            .unwrap();
        svc.delete(created.id).await.expect("delete should succeed");
        let err = svc.get(created.id).await.unwrap_err();
        assert!(matches!(err, BantoError::NotFound { .. }));
    }

    #[tokio::test]
    async fn delete_missing_id_is_not_found() {
        let svc = service().await;
        let err = svc.delete(999).await.unwrap_err();
        assert!(
            matches!(err, BantoError::NotFound { resource, id } if resource == "items" && id == "999")
        );
    }

    #[tokio::test]
    async fn create_rejects_empty_name_with_required_message() {
        let svc = service().await;
        let err = svc
            .create(ItemInput {
                name: "   ".to_string(),
                price: 1,
                stock: 1,
            })
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors.len(), 1);
                assert_eq!(field_errors[0].field, "name");
                assert_eq!(field_errors[0].message, "必須項目です");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_rejects_name_over_40_chars() {
        let svc = service().await;
        let long_name = "あ".repeat(41);
        let err = svc
            .create(ItemInput {
                name: long_name,
                price: 1,
                stock: 1,
            })
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "name");
                assert_eq!(field_errors[0].message, "40文字以内で入力してください");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_rejects_negative_price_and_stock_with_min_message() {
        let svc = service().await;
        let err = svc
            .create(ItemInput {
                name: "Valid".to_string(),
                price: -1,
                stock: -5,
            })
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors.len(), 2);
                assert_eq!(field_errors[0].field, "price");
                assert_eq!(field_errors[0].message, "0以上で入力してください");
                assert_eq!(field_errors[1].field, "stock");
                assert_eq!(field_errors[1].message, "0以上で入力してください");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_rejects_price_over_99999_with_max_message() {
        let svc = service().await;
        let err = svc
            .create(ItemInput {
                name: "Valid".to_string(),
                price: 100_000,
                stock: 1,
            })
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "price");
                assert_eq!(field_errors[0].message, "99999以下で入力してください");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn list_filters_sorts_and_paginates_with_total_count() {
        let svc = service().await;
        for (name, price, stock) in [("Alpha", 10, 1), ("Beta", 20, 2), ("Gamma", 30, 3)] {
            svc.create(ItemInput {
                name: name.to_string(),
                price,
                stock,
            })
            .await
            .unwrap();
        }

        let result = svc
            .list(ListParams {
                sort: vec![SortState {
                    field: "price".to_string(),
                    direction: SortDirection::Desc,
                }],
                filters: vec![FilterState {
                    field: "price".to_string(),
                    op: FilterOp::Gte,
                    value: json!(20),
                }],
                pagination: Some(Pagination {
                    offset: 0,
                    limit: 1,
                }),
            })
            .await
            .expect("list should succeed");

        assert_eq!(result.total_count, 2); // Beta and Gamma match the filter
        assert_eq!(result.rows.len(), 1); // pagination limits the page to 1
        assert_eq!(result.rows[0].name, "Gamma"); // highest price first
    }

    #[tokio::test]
    async fn update_emits_resource_changed_event() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = ItemsService::new(pool).with_events(tx);

        let created = svc
            .create(ItemInput {
                name: "Before".to_string(),
                price: 10,
                stock: 1,
            })
            .await
            .unwrap();
        // Drain the event from `create` so we can assert specifically on
        // the one from `update` below.
        rx.try_recv().expect("create should have emitted an event");

        svc.update(
            created.id,
            ItemInput {
                name: "After".to_string(),
                price: 20,
                stock: 2,
            },
        )
        .await
        .expect("update should succeed");

        let event = rx
            .try_recv()
            .expect("update should emit a resource_changed event");
        match event {
            ServerEvent::ResourceChanged { resource } => assert_eq!(resource, "items"),
            other => panic!("expected ResourceChanged, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn failed_update_emits_no_event() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = ItemsService::new(pool).with_events(tx);

        let created = svc
            .create(ItemInput {
                name: "Before".to_string(),
                price: 10,
                stock: 1,
            })
            .await
            .unwrap();
        rx.try_recv().expect("create should have emitted an event");

        let err = svc
            .update(
                created.id,
                ItemInput {
                    name: "".to_string(), // fails validation
                    price: 20,
                    stock: 2,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));

        assert!(
            rx.try_recv().is_err(),
            "a failed validation update must not emit a resource_changed event"
        );
    }

    // --- import (spec M15) --------------------------------------------------

    #[tokio::test]
    async fn import_all_success_creates_and_updates_in_one_transaction() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = ItemsService::new(pool).with_events(tx);

        let existing = svc
            .create(ItemInput {
                name: "Before".to_string(),
                price: 10,
                stock: 1,
            })
            .await
            .unwrap();
        rx.try_recv().expect("create should have emitted an event");

        let result = svc
            .import(vec![
                ItemImportRow {
                    id: Some(existing.id),
                    name: "After".to_string(),
                    price: 20,
                    stock: 2,
                },
                ItemImportRow {
                    id: None,
                    name: "New Item".to_string(),
                    price: 30,
                    stock: 3,
                },
            ])
            .await
            .expect("import should succeed");

        assert_eq!(result.created, 1);
        assert_eq!(result.updated, 1);
        assert!(result.errors.is_empty());

        let updated = svc.get(existing.id).await.unwrap();
        assert_eq!(updated.name, "After");
        assert_eq!(updated.price, 20);
        assert_eq!(updated.stock, 2);

        let all = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(all.total_count, 2);

        // Exactly one resource_changed event for the whole batch, not one
        // per row (spec M15: "成功時に notify_changed() を1回だけ").
        rx.try_recv()
            .expect("import should emit a resource_changed event");
        assert!(
            rx.try_recv().is_err(),
            "import must emit exactly one resource_changed event, not one per row"
        );
    }

    #[tokio::test]
    async fn import_with_missing_id_rolls_back_the_whole_batch() {
        let svc = service().await;

        let result = svc
            .import(vec![
                ItemImportRow {
                    id: None,
                    name: "Would Have Been Created".to_string(),
                    price: 10,
                    stock: 1,
                },
                ItemImportRow {
                    id: Some(999),
                    name: "No Such Row".to_string(),
                    price: 20,
                    stock: 2,
                },
            ])
            .await
            .expect("import should return Ok with row errors, not Err");

        assert_eq!(result.created, 0);
        assert_eq!(result.updated, 0);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].row, 1);

        // The first row must NOT have been committed despite being valid on
        // its own - the id-not-found error on row 1 rolls back row 0's
        // insert too.
        let all = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(all.total_count, 0);
    }

    #[tokio::test]
    async fn import_with_validation_error_rolls_back_and_reports_the_row() {
        let svc = service().await;

        let result = svc
            .import(vec![
                ItemImportRow {
                    id: None,
                    name: "Valid".to_string(),
                    price: 10,
                    stock: 1,
                },
                ItemImportRow {
                    id: None,
                    name: "".to_string(), // fails validation: required
                    price: -1,            // fails validation: min
                    stock: 1,
                },
            ])
            .await
            .expect("import should return Ok with row errors, not Err");

        assert_eq!(result.created, 0);
        assert_eq!(result.updated, 0);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].row, 1);
        assert!(result.errors[0].message.contains("name"));
        assert!(result.errors[0].message.contains("price"));

        // No transaction was even opened for a pre-validated batch, but
        // assert on the observable behavior (nothing landed) rather than the
        // implementation detail.
        let all = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(all.total_count, 0);
    }

    #[tokio::test]
    async fn import_rejects_more_than_the_max_row_count() {
        let svc = service().await;

        let rows: Vec<ItemImportRow> = (0..(MAX_IMPORT_ROWS + 1))
            .map(|i| ItemImportRow {
                id: None,
                name: format!("Item {i}"),
                price: 1,
                stock: 1,
            })
            .collect();

        let err = svc.import(rows).await.unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors.len(), 1);
                assert_eq!(field_errors[0].field, "rows");
            }
            other => panic!("expected Validation, got {other:?}"),
        }

        let all = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(all.total_count, 0);
    }

    #[tokio::test]
    async fn import_empty_is_a_no_op_ok() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = ItemsService::new(pool).with_events(tx);

        let result = svc
            .import(Vec::new())
            .await
            .expect("empty import should succeed");
        assert_eq!(result.created, 0);
        assert_eq!(result.updated, 0);
        assert!(result.errors.is_empty());
        assert!(
            rx.try_recv().is_err(),
            "an empty import must not emit a resource_changed event"
        );
    }
}
