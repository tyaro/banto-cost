//! Database bootstrap for the admin-template app (spec §12): connect,
//! run embedded migrations. banto-cost seeds no demo data (the template's
//! `items` demo and its 1,000-row seed were removed; `0012_drop_items.sql`
//! drops the table from existing databases).

use banto_core::BantoError;
use banto_storage::Db;

/// Connect to the **SQLite** database at `path` and run migrations. Used by the `src-tauri` adapter with a
/// path under the app's data directory - desktop is always local SQLite, so
/// this entry point stays SQLite-fixed (V2 "PostgreSQL アプリ全体対応": the
/// Postgres path is opt-in via [`init_db_from_target`], never here).
///
/// Returns a backend-agnostic [`Db`] handle: the service layer takes `Db`, not
/// a concrete pool. The migration helper dispatches on the handle's
/// backend, so this function simply builds the SQLite handle and hands it off.
pub async fn init_db(path: impl AsRef<std::path::Path>) -> Result<Db, BantoError> {
    let db = Db::connect_sqlite(path).await?;
    run_migrations(&db).await?;
    Ok(db)
}

/// Connect using a backend selected by the `target` connection string, run the
/// matching migrations (V2 "PostgreSQL アプリ全体対応", PR3).
///
/// Backend selection is by URL scheme: a `postgres://` / `postgresql://`
/// `target` opens a **PostgreSQL** backend (feature `postgres`); anything else
/// is treated as a **SQLite** filesystem path (the default, byte-for-byte
/// identical to [`init_db`]). This is what `bin/banto-serve.rs` calls with its
/// `BANTO_DB` env value, so pointing `BANTO_DB` at a `postgres://` URL is all
/// it takes to run the whole app on Postgres; a plain path keeps the existing
/// SQLite behavior untouched.
pub async fn init_db_from_target(target: &str) -> Result<Db, BantoError> {
    if is_postgres_url(target) {
        #[cfg(feature = "postgres")]
        {
            let db = Db::connect_postgres(target).await?;
            run_migrations(&db).await?;
            Ok(db)
        }
        #[cfg(not(feature = "postgres"))]
        {
            Err(BantoError::Storage(format!(
                "connection target {:?} is a PostgreSQL URL but this build was compiled without the `postgres` feature",
                display_target(target)
            )))
        }
    } else {
        init_db(target).await
    }
}

/// Does `target` name a PostgreSQL server (vs. a SQLite filesystem path)?
/// Matches the two canonical libpq URL schemes.
///
/// `pub` so the single backend-selection rule lives here and is reused rather
/// than duplicated: `bin/banto-serve.rs` calls this to decide whether to skip
/// the SQLite-only startup restore (`BackupService::apply_pending_restore_at_startup`)
/// for a `BANTO_DB` that points at Postgres, keeping that guard in lock-step
/// with [`init_db_from_target`]'s own scheme check below.
pub fn is_postgres_url(target: &str) -> bool {
    target.starts_with("postgres://") || target.starts_with("postgresql://")
}

/// What [`display_target`] shows for a PostgreSQL URL it cannot take apart
/// safely.
pub const REDACTED_POSTGRES_TARGET: &str = "postgres://<redacted>";
/// What [`display_target`] shows for a non-PostgreSQL target that looks like
/// a connection string rather than a file path.
pub const REDACTED_TARGET: &str = "<redacted>";

/// `target` with its credentials removed, for logs and error messages (Issue
/// #208).
///
/// - A PostgreSQL URL (per [`is_postgres_url`]) is shown as
///   `scheme://host:port/database`: the user info (`user:password@`) and the
///   whole query string / fragment (`?password=` ...) are dropped. This only
///   happens when the URL has an unambiguous shape - the host part is a
///   plain host name / IP (optionally `[IPv6]`) with an all-digit port, and
///   no `@` follows the host part. Anything else, e.g. a password containing
///   an unescaped `/`, `?`, `#` or `@` (which makes the host part end inside
///   the credentials), becomes the fixed [`REDACTED_POSTGRES_TARGET`] that
///   contains nothing of the input.
/// - Anything else is a SQLite file path and shown as-is - unless it contains
///   `://` or `@` (a mistyped connection string such as `Postgres://...` or
///   `user:pw@host/db`), which becomes the fixed [`REDACTED_TARGET`].
pub fn display_target(target: &str) -> String {
    if !is_postgres_url(target) {
        if target.contains("://") || target.contains('@') {
            return REDACTED_TARGET.to_string();
        }
        return target.to_string();
    }
    display_postgres_url(target).unwrap_or_else(|| REDACTED_POSTGRES_TARGET.to_string())
}

/// The credential-free form of a PostgreSQL URL, or `None` if its shape is
/// not unambiguous (see [`display_target`]).
fn display_postgres_url(target: &str) -> Option<String> {
    let (scheme, rest) = target.split_once("://")?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    // An `@` after the authority means the authority ended early - inside the
    // credentials - so we cannot tell which part is the host.
    if tail.contains('@') {
        return None;
    }
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if !is_plain_host_port(host_port) {
        return None;
    }
    let path = tail.split(['?', '#']).next().unwrap_or("");
    let path_is_plain = path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | '%'));
    if !path_is_plain {
        return None;
    }
    Some(format!("{scheme}://{host_port}{path}"))
}

/// `host`, `host:port`, `[v6]` or `[v6]:port` (empty allowed - libpq's
/// default host), with a host of name/IP characters and an all-digit port.
fn is_plain_host_port(value: &str) -> bool {
    let (host, port) = if let Some(bracketed) = value.strip_prefix('[') {
        let Some((v6, after)) = bracketed.split_once(']') else {
            return false;
        };
        if !v6
            .chars()
            .all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '.' | '%'))
        {
            return false;
        }
        match after.strip_prefix(':') {
            Some(port) => ("", Some(port)),
            None if after.is_empty() => ("", None),
            None => return false,
        }
    } else {
        match value.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (value, None),
        }
    };
    let host_is_plain = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '%'));
    let port_is_plain = port.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    host_is_plain && port_is_plain
}

/// Same as [`init_db`] but against a private in-memory SQLite database. Used by
/// tests so each test gets an isolated, migrated database.
pub async fn init_db_memory() -> Result<Db, BantoError> {
    let db = Db::connect_sqlite_memory().await?;
    run_migrations(&db).await?;
    Ok(db)
}

/// A migrated in-memory database for this crate's unit tests (same as
/// [`init_db_memory`] now that there is no demo seed; kept so the tests'
/// helper name does not churn).
#[cfg(test)]
pub(crate) async fn migrate_memory() -> Result<Db, BantoError> {
    let db = Db::connect_sqlite_memory().await?;
    run_migrations(&db).await?;
    Ok(db)
}

/// Run the embedded migrations matching the handle's backend. The two migration
/// sets are byte-distinct SQL (`migrations-sqlite/` is the historical DDL kept
/// unchanged for backward compatibility; `migrations-postgres/` is the
/// strict-typed Postgres port), so each backend embeds and runs its own.
async fn run_migrations(db: &Db) -> Result<(), BantoError> {
    match db {
        Db::Sqlite(pool) => sqlx::migrate!("./migrations-sqlite")
            .run(pool)
            .await
            .map_err(|err| BantoError::Storage(err.to_string())),
        #[cfg(feature = "postgres")]
        Db::Postgres(pool) => sqlx::migrate!("./migrations-postgres")
            .run(pool)
            .await
            .map_err(|err| BantoError::Storage(err.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_url_detection_selects_backend_by_scheme() {
        assert!(is_postgres_url("postgres://user:pass@localhost/db"));
        assert!(is_postgres_url("postgresql://localhost/db"));
        assert!(!is_postgres_url("./banto-dev.sqlite3"));
        assert!(!is_postgres_url("/var/lib/banto/app.sqlite3"));
        assert!(!is_postgres_url("C:\\data\\app.sqlite3"));
    }

    /// Issue #208: what `banto-serve` prints for `BANTO_DB` carries no
    /// credentials.
    #[test]
    fn display_target_drops_postgres_credentials() {
        let cases = [
            (
                "postgres://review_user:example_password@localhost:5432/banto_a",
                "postgres://localhost:5432/banto_a",
            ),
            (
                "postgresql://u:p%40ss@db.example/banto?sslmode=require&password=q",
                "postgresql://db.example/banto",
            ),
            ("postgres://u:p@[::1]:5432", "postgres://[::1]:5432"),
            (
                "postgres://localhost/db?user=x&password=y",
                "postgres://localhost/db",
            ),
            ("postgres://a@b:c@host/db", "postgres://host/db"),
            ("postgres:///banto", "postgres:///banto"),
            ("postgres://host", "postgres://host"),
            ("./banto-dev.sqlite3", "./banto-dev.sqlite3"),
            ("C:\\data\\app.sqlite3", "C:\\data\\app.sqlite3"),
            ("/var/lib/banto/app.sqlite3", "/var/lib/banto/app.sqlite3"),
        ];
        for (target, expected) in cases {
            assert_eq!(display_target(target), expected, "{target}");
        }
    }

    /// Review of #233 (3): malformed connection strings - an unescaped `?`,
    /// `#`, `/` or `@` inside the credentials, a missing or mistyped scheme -
    /// never let a secret through; they fall back to a fixed text.
    #[test]
    fn display_target_redacts_what_it_cannot_parse_safely() {
        const SECRET: &str = "ExampleSecret";
        let cases = [
            (
                "postgres://alice:ExampleSecret?tail@localhost/db",
                REDACTED_POSTGRES_TARGET,
            ),
            (
                "postgres://alice:ExampleSecret#tail@localhost/db",
                REDACTED_POSTGRES_TARGET,
            ),
            (
                "postgres://alice:Example/Secret@localhost/db",
                REDACTED_POSTGRES_TARGET,
            ),
            (
                "postgresql://alice:ExampleSecret?a#b@localhost:5432/db?x=1",
                REDACTED_POSTGRES_TARGET,
            ),
            // No `@` at all: the credentials would be read as host:port.
            ("postgres://alice:ExampleSecret", REDACTED_POSTGRES_TARGET),
            (
                "postgres://alice:ExampleSecret/db",
                REDACTED_POSTGRES_TARGET,
            ),
            (
                "postgres://u:p@[::1:ExampleSecret",
                REDACTED_POSTGRES_TARGET,
            ),
            (
                "postgres://u:p@host/db name ExampleSecret",
                REDACTED_POSTGRES_TARGET,
            ),
            // Mistyped or missing scheme: not PostgreSQL, but not a path either.
            (
                "Postgres://alice:ExampleSecret@localhost/db",
                REDACTED_TARGET,
            ),
            (
                "postgres:/alice:ExampleSecret@localhost/db",
                REDACTED_TARGET,
            ),
            ("alice:ExampleSecret@localhost:5432/db", REDACTED_TARGET),
            ("mysql://alice:ExampleSecret@localhost/db", REDACTED_TARGET),
        ];
        for (target, expected) in cases {
            let shown = display_target(target);
            assert_eq!(shown, expected, "{target}");
            assert!(
                !shown.contains(SECRET) && !shown.contains("alice"),
                "{target}"
            );
        }
    }

    /// Review of #233 (3): the one error that prints `BANTO_DB` - a PostgreSQL
    /// URL given to a build without the `postgres` feature - keeps no secret,
    /// even for a malformed URL.
    #[cfg(not(feature = "postgres"))]
    #[tokio::test]
    async fn postgres_url_without_the_feature_errors_without_the_secret() {
        for target in [
            "postgres://alice:ExampleSecret@localhost/db",
            "postgres://alice:ExampleSecret?tail@localhost/db",
            "postgres://alice:ExampleSecret#tail@localhost/db",
        ] {
            let err = match init_db_from_target(target).await {
                Ok(_) => panic!("{target}: a build without `postgres` must refuse"),
                Err(err) => err,
            };
            let text = format!("{err} {err:?}");
            assert!(text.contains("postgres"), "{text}");
            assert!(
                !text.contains("ExampleSecret") && !text.contains("alice"),
                "{text}"
            );
        }
    }

    /// Issue #204: a database created before migration 0007 upgrades in
    /// place - accounts that already exist get `auth_epoch = 0` and keep
    /// working (the SQLite half; `tests/pg_smoke.rs` covers the PostgreSQL
    /// DDL on CI).
    #[tokio::test]
    async fn a_database_from_before_0007_upgrades_with_existing_accounts_at_epoch_zero() {
        let db = Db::connect_sqlite_memory().await.unwrap();
        let pool = db.as_sqlite().expect("sqlite handle");
        sqlx::migrate!("./migrations-sqlite")
            .run_to(6, pool)
            .await
            .expect("pre-#204 schema");
        sqlx::query(
            "INSERT INTO users (username, password_hash, display_name, role) \
             VALUES ('existing', 'unused', '既存', 'admin')",
        )
        .execute(pool)
        .await
        .unwrap();

        run_migrations(&db)
            .await
            .expect("upgrade to the current schema");

        let users = crate::users::UsersService::new(db.clone());
        let existing = users
            .get_by_username("existing")
            .await
            .unwrap()
            .expect("the existing account survives the upgrade");
        assert_eq!(existing.auth_epoch, 0);
        users
            .reset_password(existing.id, "password123")
            .await
            .unwrap();
        let verified = users
            .verify("existing", "password123")
            .await
            .unwrap()
            .expect("the upgraded account can log in");
        assert_eq!(verified.auth_epoch, 1);
    }

    /// Whether `sql` fails on the migrated in-memory database.
    async fn refused(pool: &sqlx::SqlitePool, sql: &str) -> bool {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
            .execute(pool)
            .await
            .is_err()
    }

    /// Review §8-16 (M-1, design.md §3.6): every business date or month
    /// column of every table is guarded by the 0027 insert and update
    /// triggers. Finding the columns by name catches a later table that
    /// forgets its triggers.
    #[tokio::test]
    async fn every_business_date_and_month_column_has_format_triggers() {
        let db = migrate_memory().await.unwrap();
        let pool = db.as_sqlite().expect("sqlite handle");
        let columns: Vec<(String, String)> = sqlx::query_as(
            "SELECT m.name, c.name FROM sqlite_master m, pragma_table_info(m.name) c \
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name <> '_sqlx_migrations' \
             ORDER BY m.name, c.cid",
        )
        .fetch_all(pool)
        .await
        .unwrap();
        let is_business_date = |c: &str| {
            c.ends_with("_on")
                || c.ends_with("_date")
                || c == "month"
                || c.ends_with("_month")
                || c == "valid_from"
                || c == "planned_start"
                || c == "planned_end"
        };
        let mut checked = 0;
        for (table, column) in columns.iter().filter(|(_, c)| is_business_date(c)) {
            for kind in ["insert", "update"] {
                let sql: Option<String> = sqlx::query_scalar(
                    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
                )
                .bind(format!("{table}_dates_{kind}"))
                .fetch_optional(pool)
                .await
                .unwrap();
                let sql = sql.unwrap_or_else(|| panic!("{table}: no {kind} trigger"));
                assert!(
                    sql.contains(&format!("NEW.{column} ")),
                    "{table}.{column} is not checked by the {kind} trigger"
                );
                if kind == "update" {
                    assert!(sql.contains(column.as_str()), "{table}.{column}");
                }
            }
            checked += 1;
        }
        assert_eq!(
            checked, 33,
            "date and month columns found: update the count"
        );
    }

    /// Review §8-16 (M-1): a date must be a real calendar date written
    /// YYYY-MM-DD and a month YYYY-MM, on insert and on update; NULL stays
    /// allowed where the column allows it.
    #[tokio::test]
    async fn malformed_dates_and_months_are_refused_by_the_database() {
        let db = migrate_memory().await.unwrap();
        let pool = db.as_sqlite().expect("sqlite handle");
        for sql in [
            "INSERT INTO users (username, password_hash, display_name, role) \
             VALUES ('u', 'unused', '架空', 'admin')",
            "INSERT INTO customers (name) VALUES ('架空顧客')",
        ] {
            sqlx::query(sql).execute(pool).await.unwrap();
        }
        let project = |code: &str, start: &str| {
            format!(
                "INSERT INTO projects (code, name, customer_id, manager_user_id, status, planned_start) \
                 VALUES ('{code}', '架空案件', 1, 1, 'lead', {start})"
            )
        };
        for bad in [
            "'2026-6-1'",
            "'2026-02-30'",
            "'2026-04-31'",
            "'2026-13-01'",
            "'2026/06/01'",
            "'2026-06-01 '",
            "''",
        ] {
            assert!(
                refused(pool, &project("P-BAD", bad)).await,
                "planned_start {bad}"
            );
        }
        assert!(!refused(pool, &project("P-1", "'2026-06-01'")).await);
        assert!(!refused(pool, &project("P-2", "NULL")).await);
        assert!(
            refused(
                pool,
                "UPDATE projects SET planned_end = '2026-6-30' WHERE id = 1"
            )
            .await
        );
        assert!(
            !refused(
                pool,
                "UPDATE projects SET planned_end = '2026-06-30' WHERE id = 1"
            )
            .await
        );

        // A row stored before 0027 keeps its malformed date: an update that
        // does not change it (even one naming the column) still works.
        sqlx::query("DROP TRIGGER projects_dates_insert")
            .execute(pool)
            .await
            .unwrap();
        assert!(!refused(pool, &project("P-OLD", "'2026-6-1'")).await);
        assert!(
            !refused(
                pool,
                "UPDATE projects SET name = '改名', planned_start = planned_start WHERE code = 'P-OLD'"
            )
            .await
        );
        assert!(
            refused(
                pool,
                "UPDATE projects SET planned_start = '2026-7-1' WHERE code = 'P-OLD'"
            )
            .await
        );

        for bad in [
            "'2026-6'",
            "'2026-13'",
            "'2026-00'",
            "'2026/06'",
            "'2026-06-01'",
        ] {
            assert!(
                refused(
                    pool,
                    &format!("INSERT INTO closing_periods (month, status) VALUES ({bad}, 'open')")
                )
                .await,
                "month {bad}"
            );
        }
        assert!(
            !refused(
                pool,
                "INSERT INTO closing_periods (month, status) VALUES ('2026-06', 'open')"
            )
            .await
        );
        assert!(refused(pool, "UPDATE closing_periods SET month = '2026-1x'").await);
        assert!(!refused(pool, "UPDATE closing_periods SET status = 'closed'").await);
    }

    /// Review §8-16 (M-5): one revenue plan line per project and month, and
    /// one undecided-timing line at most (a trigger, so that duplicates
    /// already stored do not make the migration fail).
    #[tokio::test]
    async fn revenue_plan_allows_one_line_per_project_and_month() {
        let db = migrate_memory().await.unwrap();
        let pool = db.as_sqlite().expect("sqlite handle");
        for sql in [
            "INSERT INTO users (username, password_hash, display_name, role) \
             VALUES ('u', 'unused', '架空', 'admin')",
            "INSERT INTO customers (name) VALUES ('架空顧客')",
            "INSERT INTO projects (code, name, customer_id, manager_user_id, status) \
             VALUES ('P-1', '架空案件', 1, 1, 'ordered')",
            "INSERT INTO projects (code, name, customer_id, manager_user_id, status) \
             VALUES ('P-2', '架空案件2', 1, 1, 'ordered')",
            "INSERT INTO revenue_plan (project_id, month, amount) VALUES (1, '2026-06', 100)",
            "INSERT INTO revenue_plan (project_id, month, amount) VALUES (1, NULL, 100)",
        ] {
            sqlx::query(sql).execute(pool).await.unwrap();
        }
        let insert = |project: i64, month: &str| {
            format!("INSERT INTO revenue_plan (project_id, month, amount) VALUES ({project}, {month}, 50)")
        };
        assert!(refused(pool, &insert(1, "'2026-06'")).await);
        assert!(refused(pool, &insert(1, "NULL")).await);
        assert!(!refused(pool, &insert(1, "'2026-07'")).await);
        assert!(!refused(pool, &insert(2, "'2026-06'")).await);
        assert!(!refused(pool, &insert(2, "NULL")).await);
        assert!(
            refused(
                pool,
                "UPDATE revenue_plan SET month = '2026-06' WHERE month = '2026-07'"
            )
            .await
        );
        assert!(
            !refused(
                pool,
                "UPDATE revenue_plan SET amount = 70 WHERE month = '2026-07'"
            )
            .await
        );

        // Duplicates stored before 0027 do not stop the migration; their
        // other columns stay writable.
        sqlx::query("DROP TRIGGER revenue_plan_month_insert")
            .execute(pool)
            .await
            .unwrap();
        assert!(!refused(pool, &insert(2, "'2026-06'")).await);
        assert!(
            !refused(
                pool,
                "UPDATE revenue_plan SET amount = 0, month = month WHERE project_id = 2"
            )
            .await
        );
    }
}
