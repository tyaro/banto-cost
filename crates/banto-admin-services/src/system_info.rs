//! System diagnostics probe (spec: settings「システム情報」card / M-review
//! 2026-08 §2.4「縮小版⑤」): the domain-agnostic, DB-derived half of the
//! admin-only System Info surface. Like every Banto service (conventions §2)
//! it takes a [`banto_storage::Db`] handle, returns `Result<_, BantoError>`,
//! and knows nothing about `axum`/`tauri`/RBAC/HTTP - the transport-specific
//! fields (app version, process uptime, active LAN session count) are added by
//! the REST/Tauri wiring layer, which calls [`SystemInfoService::probe`] and
//! folds its result into the wire struct.
//!
//! Everything here is a *read* (no writes, so no audit per conventions §1) and,
//! except for the liveness `SELECT 1` latency probe, *best-effort*: a failing
//! migration-version or attachment-size query degrades to `None` rather than
//! failing the whole card, so an old/foreign DB or an app that removed the
//! optional attachments feature still renders. Table ownership stays with the
//! app (conventions §11): this crate owns no migrations; the unit tests restate
//! the relevant DDL inline.

use banto_storage::{Db, Dialect};

use banto_core::BantoError;

/// DB-derived diagnostics, produced by [`SystemInfoService::probe`]. The
/// wiring layer combines these with app version / uptime / session count to
/// build the full wire payload.
#[derive(Debug, Clone)]
pub struct DbProbe {
    /// The SQL dialect the live handle speaks: `"sqlite"` or `"postgres"`.
    pub dialect: &'static str,
    /// Round-trip latency of a trivial `SELECT 1`, in milliseconds. This is the
    /// one non-best-effort field: if the probe itself errors the whole call
    /// fails, because a DB that cannot answer `SELECT 1` is genuinely down.
    pub db_latency_ms: f64,
    /// Highest applied migration version (`MAX(version)` from sqlx's
    /// `_sqlx_migrations`), or `None` if the table is unreadable. Best-effort.
    pub migration_version: Option<i64>,
    /// Total logical attachment size (`SUM(size_bytes)`), or `None` when the
    /// optional `attachments` table is absent (feature removed / older DB) or
    /// the sum is unreadable. Best-effort - never fails the card. Knowing the
    /// optional table's name here is a diagnostics convenience, not a crate
    /// dependency on `banto-attachments` (conventions §4 bans reverse *imports*,
    /// which this is not).
    pub attachment_bytes: Option<i64>,
}

/// Read-only system diagnostics service. `Clone` is cheap (`Db` is an
/// `Arc`-backed connection handle), matching the other services.
#[derive(Clone)]
pub struct SystemInfoService {
    db: Db,
}

impl SystemInfoService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Gather the DB-derived diagnostics. Times a liveness `SELECT 1` (whose
    /// failure *does* propagate), then best-effort reads the migration version
    /// and total attachment size (each degrading to `None` on error).
    pub async fn probe(&self) -> Result<DbProbe, BantoError> {
        // `Dialect` (unlike `Db`) is not `cfg`-gated - both variants always
        // exist - so this match needs no feature guard.
        let dialect = match self.db.dialect() {
            Dialect::Sqlite => "sqlite",
            Dialect::Postgres => "postgres",
        };

        let started = std::time::Instant::now();
        self.select_one().await?;
        let db_latency_ms = started.elapsed().as_secs_f64() * 1000.0;

        Ok(DbProbe {
            dialect,
            db_latency_ms,
            migration_version: self.migration_version().await,
            attachment_bytes: self.attachment_bytes().await,
        })
    }

    /// Liveness round-trip. Uses `sqlx::query` (not `query_scalar`) so the
    /// column value is never decoded - `SELECT 1` is `int4` on Postgres but
    /// `INTEGER` on SQLite, and we only care about the round-trip, not the 1.
    /// The per-arm `.map(|_| ())` unifies the two backends' distinct row types
    /// (`SqliteRow`/`PgRow`) to `()` *before* the match so they type-check
    /// under `--features postgres` (same idiom as `SettingsService::set`).
    async fn select_one(&self) -> Result<(), BantoError> {
        match &self.db {
            Db::Sqlite(pool) => sqlx::query("SELECT 1").fetch_one(pool).await.map(|_| ()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query("SELECT 1").fetch_one(pool).await.map(|_| ()),
        }
        .map_err(banto_storage::storage_error)
    }

    /// Best-effort `MAX(version)` from sqlx's `_sqlx_migrations` table. The
    /// aggregate is `NULL` on an empty table, so it decodes into `Option<i64>`;
    /// any error (missing table on a foreign DB) collapses to `None`.
    async fn migration_version(&self) -> Option<i64> {
        const SQL: &str = "SELECT MAX(version) FROM _sqlx_migrations";
        let result: Result<Option<i64>, sqlx::Error> = match &self.db {
            Db::Sqlite(pool) => sqlx::query_scalar(SQL).fetch_one(pool).await,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_scalar(SQL).fetch_one(pool).await,
        };
        result.ok().flatten()
    }

    /// Best-effort total attachment size. Probes table existence first (so a
    /// genuinely-absent optional table returns `None` cleanly rather than
    /// masking a real error), then `SUM(size_bytes)`. `CAST(... AS BIGINT)`
    /// keeps the result `i64` on both dialects (Postgres `SUM(bigint)` is
    /// otherwise `numeric`, which does not decode to `i64`).
    async fn attachment_bytes(&self) -> Option<i64> {
        if !self.attachments_table_exists().await {
            return None;
        }
        const SQL: &str = "SELECT CAST(COALESCE(SUM(size_bytes), 0) AS BIGINT) FROM attachments";
        let result: Result<i64, sqlx::Error> = match &self.db {
            Db::Sqlite(pool) => sqlx::query_scalar(SQL).fetch_one(pool).await,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_scalar(SQL).fetch_one(pool).await,
        };
        result.ok()
    }

    /// Whether the optional `attachments` table exists in the live DB, per
    /// dialect (SQLite `sqlite_master`, Postgres `to_regclass`). Any query
    /// error is treated as "absent" - this is a best-effort gate.
    async fn attachments_table_exists(&self) -> bool {
        match &self.db {
            Db::Sqlite(pool) => sqlx::query_scalar::<_, String>(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'",
            )
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .is_some(),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_scalar::<_, Option<String>>(
                "SELECT to_regclass('public.attachments')::text",
            )
            .fetch_one(pool)
            .await
            .ok()
            .flatten()
            .is_some(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An in-memory SQLite handle. Individual tests create the tables they need
    /// inline (this crate owns no migrations, conventions §11): the DDL below
    /// mirrors `apps/admin-template/core/migrations-sqlite/0006_attachments.sql`
    /// (only the columns this probe reads) and sqlx's own `_sqlx_migrations`.
    async fn db() -> Db {
        Db::connect_sqlite_memory()
            .await
            .expect("connect in-memory sqlite")
    }

    fn sqlite_pool(db: &Db) -> &sqlx::SqlitePool {
        db.as_sqlite()
            .expect("service tests run on a SQLite handle")
    }

    async fn create_migrations_table(db: &Db) {
        sqlx::query(
            "CREATE TABLE _sqlx_migrations (\
             version BIGINT PRIMARY KEY, description TEXT, installed_on TEXT, \
             success BOOLEAN, checksum BLOB, execution_time BIGINT)",
        )
        .execute(sqlite_pool(db))
        .await
        .expect("create _sqlx_migrations");
    }

    #[tokio::test]
    async fn probe_reports_sqlite_dialect_and_measures_latency() {
        let svc = SystemInfoService::new(db().await);
        let probe = svc.probe().await.expect("probe should succeed");
        assert_eq!(probe.dialect, "sqlite");
        assert!(
            probe.db_latency_ms >= 0.0,
            "latency should be a non-negative measurement"
        );
    }

    #[tokio::test]
    async fn migration_version_reads_max_when_table_present() {
        let db = db().await;
        create_migrations_table(&db).await;
        for v in [1_i64, 2, 6] {
            sqlx::query("INSERT INTO _sqlx_migrations (version, success) VALUES (?, TRUE)")
                .bind(v)
                .execute(sqlite_pool(&db))
                .await
                .expect("insert migration row");
        }
        let svc = SystemInfoService::new(db);
        let probe = svc.probe().await.expect("probe should succeed");
        assert_eq!(probe.migration_version, Some(6));
    }

    #[tokio::test]
    async fn migration_version_is_none_when_table_absent() {
        // No _sqlx_migrations table created -> best-effort None, not an error.
        let svc = SystemInfoService::new(db().await);
        let probe = svc.probe().await.expect("probe should still succeed");
        assert_eq!(probe.migration_version, None);
    }

    #[tokio::test]
    async fn attachment_bytes_sums_when_table_present() {
        let db = db().await;
        sqlx::query("CREATE TABLE attachments (id TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL)")
            .execute(sqlite_pool(&db))
            .await
            .expect("create attachments table");
        for (id, size) in [("a", 100_i64), ("b", 250)] {
            sqlx::query("INSERT INTO attachments (id, size_bytes) VALUES (?, ?)")
                .bind(id)
                .bind(size)
                .execute(sqlite_pool(&db))
                .await
                .expect("insert attachment row");
        }
        let svc = SystemInfoService::new(db);
        let probe = svc.probe().await.expect("probe should succeed");
        assert_eq!(probe.attachment_bytes, Some(350));
    }

    #[tokio::test]
    async fn attachment_bytes_is_none_when_table_absent() {
        // App that removed the optional attachments feature -> None, no error.
        let svc = SystemInfoService::new(db().await);
        let probe = svc.probe().await.expect("probe should still succeed");
        assert_eq!(probe.attachment_bytes, None);
    }

    #[tokio::test]
    async fn attachment_bytes_is_zero_when_table_empty() {
        let db = db().await;
        sqlx::query("CREATE TABLE attachments (id TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL)")
            .execute(sqlite_pool(&db))
            .await
            .expect("create attachments table");
        let svc = SystemInfoService::new(db);
        let probe = svc.probe().await.expect("probe should succeed");
        assert_eq!(probe.attachment_bytes, Some(0));
    }
}
