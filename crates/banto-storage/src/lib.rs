//! Banto storage: sqlx-based repository implementations (spec §12).
//!
//! - [`list_query`]: whitelist-based `ListParams` -> SQL (`WHERE`/
//!   `ORDER BY`/`LIMIT..OFFSET..`), shared by every resource's service layer
//!   so query construction is never duplicated (spec §10).
//! - [`db`]: enum-dispatch connection handle (`Db`, `cfg`-gated variants) plus
//!   feature-independent SQL dialect helpers (`Dialect`: placeholders,
//!   current-time expression) shared by the app service layer (V2).
//! - [`error`]: `sqlx::Error` -> `banto_core::BantoError` mapping.
//! - [`sqlite`] (feature `sqlite`, default): SQLite connection helpers
//!   (WAL + foreign keys, spec §11.3).
//! - [`postgres`] (feature `postgres`): PostgreSQL connection helper (pooled,
//!   `postgres://` URL, database pre-provisioned - spec §12.1).
//!
//! PostgreSQL support (feature `postgres`) covers `list_query`'s `Postgres`
//! instantiation, the connection helper above, and - since V2 "PostgreSQL
//! アプリ全体対応" - the whole app service layer: services take a `Db` handle
//! rather than a concrete pool, and `apps/admin-template/core`'s
//! `init_db_from_target` opens a Postgres backend for a `postgres://` target
//! and runs the `migrations-postgres/` set, so the app runs end-to-end on
//! PostgreSQL (spec §12.1). Backup/restore stays SQLite-only (a Postgres
//! handle yields an explicit error, `banto-admin-services`). TimescaleDB
//! hypertables / `time_bucket` aggregation remain future work.
//!
//! No `sqlx::query!`/`query_as!` compile-time macros are used anywhere in
//! this crate - only runtime queries, so building never requires a
//! `DATABASE_URL` (CI-friendly, spec's "no compile-time DB access" design).

pub mod db;
pub mod error;
pub mod list_query;

#[cfg(feature = "sqlite")]
pub mod sqlite;

#[cfg(feature = "postgres")]
pub mod postgres;

pub use error::{not_found, storage_error};
pub use list_query::ColumnMap;

#[cfg(any(feature = "sqlite", feature = "postgres"))]
pub use db::Db;
/// Backend-agnostic SQL dialect helpers ([`db::Dialect`]) are always
/// available; the enum-dispatch connection handle ([`db::Db`]) exists only
/// when at least one backend feature is compiled in.
pub use db::Dialect;

#[cfg(feature = "sqlite")]
pub use sqlite::{connect as connect_sqlite, connect_memory as connect_sqlite_memory};

#[cfg(feature = "postgres")]
pub use postgres::connect as connect_postgres;
