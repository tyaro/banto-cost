//! Database bootstrap for the admin-template app (spec §12): connect,
//! run embedded migrations, seed demo data on first run.

use banto_core::BantoError;
use banto_storage::Db;

// [scaffold:items] begin
const SEED_ROW_COUNT: usize = 1_000;
// [scaffold:items] end

/// Connect to the **SQLite** database at `path`, run migrations, and seed demo
/// data if the `items` table is empty. Used by the `src-tauri` adapter with a
/// path under the app's data directory - desktop is always local SQLite, so
/// this entry point stays SQLite-fixed (V2 "PostgreSQL アプリ全体対応": the
/// Postgres path is opt-in via [`init_db_from_target`], never here).
///
/// Returns a backend-agnostic [`Db`] handle: the service layer takes `Db`, not
/// a concrete pool. The migration/seed helpers dispatch on the handle's
/// backend, so this function simply builds the SQLite handle and hands it off.
pub async fn init_db(path: impl AsRef<std::path::Path>) -> Result<Db, BantoError> {
    let db = Db::connect_sqlite(path).await?;
    run_migrations_and_seed(&db).await?;
    Ok(db)
}

/// Connect using a backend selected by the `target` connection string, run the
/// matching migrations, and seed if empty (V2 "PostgreSQL アプリ全体対応", PR3).
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
            run_migrations_and_seed(&db).await?;
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
/// tests so each test gets an isolated, migrated, seeded database.
pub async fn init_db_memory() -> Result<Db, BantoError> {
    let db = Db::connect_sqlite_memory().await?;
    run_migrations_and_seed(&db).await?;
    Ok(db)
}

/// A migrated but *unseeded* in-memory database. Used by `items` service
/// tests that need full control over which rows exist (e.g. asserting a
/// specific id is absent), where the 1,000-row demo seed from
/// [`init_db_memory`] would collide with test fixture ids.
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

async fn run_migrations_and_seed(db: &Db) -> Result<(), BantoError> {
    run_migrations(db).await?;
    // [scaffold:items] begin
    seed_if_empty(db).await?;
    // [scaffold:items] end
    Ok(())
}

// [scaffold:items] begin
//
// D1-d (display-preset-plan.md, Issue #190 prep): the `items` demo-seed
// generator (row-count check, the deterministic mulberry32 PRNG port, the
// product tables, and `generate_sample_items` itself) - everything below is
// items-only, contiguous through the end of `generate_sample_items`, so a
// future `display`/`items` remover can delete it with one `cutRegion`.

async fn seed_if_empty(db: &Db) -> Result<(), BantoError> {
    let count: i64 = match db {
        Db::Sqlite(pool) => {
            sqlx::query_scalar("SELECT COUNT(*) FROM items")
                .fetch_one(pool)
                .await
        }
        #[cfg(feature = "postgres")]
        Db::Postgres(pool) => {
            sqlx::query_scalar("SELECT COUNT(*) FROM items")
                .fetch_one(pool)
                .await
        }
    }
    .map_err(banto_storage::storage_error)?;
    if count > 0 {
        return Ok(());
    }

    let rows = generate_sample_items(SEED_ROW_COUNT);
    // Positional placeholders via the shared `Dialect` helper so the same
    // INSERT text works on both backends (`?` on SQLite, `$1..$5` on Postgres).
    let dialect = db.dialect();
    // AssertSqlSafe: only `dialect.placeholder(n)` is interpolated
    // (internal enum, never caller input); each row's fields are bound
    // below. `.as_str()` (not moving `insert_sql`) because this statement is
    // reused across every iteration of the loops below.
    let insert_sql = format!(
        "INSERT INTO items (id, name, price, stock, updated_at) VALUES ({}, {}, {}, {}, {})",
        dialect.placeholder(1),
        dialect.placeholder(2),
        dialect.placeholder(3),
        dialect.placeholder(4),
        dialect.placeholder(5),
    );

    match db {
        Db::Sqlite(pool) => {
            let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
            for row in &rows {
                sqlx::query(sqlx::AssertSqlSafe(insert_sql.as_str()))
                    .bind(row.id)
                    .bind(&row.name)
                    .bind(row.price)
                    .bind(row.stock)
                    .bind(&row.updated_at)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
            }
            tx.commit().await.map_err(banto_storage::storage_error)?;
        }
        #[cfg(feature = "postgres")]
        Db::Postgres(pool) => {
            let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
            for row in &rows {
                sqlx::query(sqlx::AssertSqlSafe(insert_sql.as_str()))
                    .bind(row.id)
                    .bind(&row.name)
                    .bind(row.price)
                    .bind(row.stock)
                    .bind(&row.updated_at)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
            }
            tx.commit().await.map_err(banto_storage::storage_error)?;
            // The seed inserted explicit ids 1..=N into a `GENERATED BY DEFAULT
            // AS IDENTITY` column, which does NOT advance the identity sequence.
            // Without this, the next app INSERT (which omits `id`) would try to
            // generate id=1 and collide. `setval(..., MAX(id))` moves the
            // sequence past the seed so the first real insert gets N+1. SQLite's
            // AUTOINCREMENT tracks this from the explicit inserts automatically,
            // so this fix-up is Postgres-only.
            sqlx::query(
                "SELECT setval(pg_get_serial_sequence('items', 'id'), (SELECT MAX(id) FROM items))",
            )
            .execute(pool)
            .await
            .map_err(banto_storage::storage_error)?;
        }
    }
    Ok(())
}

struct SeedItem {
    id: i64,
    name: String,
    price: i64,
    stock: i64,
    updated_at: String,
}

/// mulberry32: small, fast, deterministic PRNG (no runtime dependency).
/// Ported 1:1 from `apps/admin-template/src/lib/banto/sampleData.ts` so the
/// two seed generators (TS `InMemoryDataProvider` seed data, Rust SQLite
/// seed data) use the exact same algorithm and per-row draw order - only
/// the row count and destination differ.
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// Returns a float in `[0, 1)`, matching the TS implementation's
    /// `>>> 0) / 4294967296` normalization.
    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

const PRODUCT_BASES: [&str; 12] = [
    "緑茶",
    "ほうじ茶",
    "麦茶",
    "烏龍茶",
    "紅茶",
    "コーヒー",
    "抹茶ラテ",
    "レモネード",
    "炭酸水",
    "スポーツドリンク",
    "オレンジジュース",
    "アップルジュース",
];

const PRODUCT_SIZES: [&str; 6] = ["280ml", "350ml", "500ml", "600ml", "1L", "2L"];

fn base_unit_price(base: &str) -> i64 {
    match base {
        "緑茶" => 140,
        "ほうじ茶" => 140,
        "麦茶" => 120,
        "烏龍茶" => 150,
        "紅茶" => 160,
        "コーヒー" => 130,
        "抹茶ラテ" => 220,
        "レモネード" => 180,
        "炭酸水" => 110,
        "スポーツドリンク" => 170,
        "オレンジジュース" => 190,
        "アップルジュース" => 190,
        _ => unreachable!("all PRODUCT_BASES entries are covered above"),
    }
}

const SEED: u32 = 0x8a17c05;
// Fixed "today" for deterministic output regardless of when the app runs
// (matches sampleData.ts's UPDATED_AT_END = Date.UTC(2026, 6, 2)).
const UPDATED_AT_END_DAYS_SINCE_EPOCH: i64 = 20636; // 2026-07-02 UTC
const UPDATED_AT_SPAN_DAYS: i64 = 900; // ~2.5 years of history

/// Days-since-epoch (1970-01-01) -> `YYYY-MM-DD`, using Howard Hinnant's
/// `civil_from_days` algorithm (http://howardhinnant.github.io/date_algorithms.html).
/// No date/time crate dependency for one small conversion.
///
/// Private to this module: the seed-data generator below is the only user.
/// (`backup` no longer lives in this crate as of theme C PR-C3 - it moved to
/// `banto-admin-services`, where it carries its own copy of this small pure
/// algorithm rather than depending back on the app crate, conventions
/// §"逆依存禁止".)
fn iso_date_from_days_since_epoch(days: i64) -> String {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Port of `generateSampleItems` (`apps/admin-template/src/lib/banto/sampleData.ts`):
/// same PRNG, same product tables, same per-row draw order, so the first
/// `count` rows are identical to the TS dataset's first `count` rows.
fn generate_sample_items(count: usize) -> Vec<SeedItem> {
    let mut random = Mulberry32::new(SEED);
    let mut rows = Vec::with_capacity(count);

    for i in 0..count {
        let id = (i + 1) as i64;
        let base = PRODUCT_BASES[(random.next() * PRODUCT_BASES.len() as f64).floor() as usize];
        let size = PRODUCT_SIZES[(random.next() * PRODUCT_SIZES.len() as f64).floor() as usize];
        let lot = random.next();
        let name = if lot < 0.15 {
            format!("{base} {size} 数量限定")
        } else {
            format!("{base} {size}")
        };

        let unit_price = base_unit_price(base);
        let price_jitter = ((random.next() * 40.0 - 20.0) / 10.0).round() as i64 * 10; // -20..+20, rounded to 10
        let price = (unit_price + price_jitter).max(50);

        let stock = (random.next() * 500.0).floor() as i64;

        let days_ago = (random.next() * UPDATED_AT_SPAN_DAYS as f64).floor() as i64;
        let updated_at_days = UPDATED_AT_END_DAYS_SINCE_EPOCH - days_ago;
        let updated_at = iso_date_from_days_since_epoch(updated_at_days);

        rows.push(SeedItem {
            id,
            name,
            price,
            stock,
            updated_at,
        });
    }

    rows
}
// [scaffold:items] end

#[cfg(test)]
mod tests {
    use super::*;

    // [scaffold:items] begin (demo-seed tests; `postgres_url_detection_*`
    // below stays outside - it tests generic backend selection, not the seed)

    #[test]
    fn iso_date_round_trips_known_epoch_days() {
        assert_eq!(iso_date_from_days_since_epoch(0), "1970-01-01");
        assert_eq!(iso_date_from_days_since_epoch(1), "1970-01-02");
        assert_eq!(iso_date_from_days_since_epoch(-1), "1969-12-31");
        // 2026-07-02 is the fixed "today" used by the seed generator.
        assert_eq!(
            iso_date_from_days_since_epoch(UPDATED_AT_END_DAYS_SINCE_EPOCH),
            "2026-07-02"
        );
    }

    #[test]
    fn generate_sample_items_is_deterministic() {
        let a = generate_sample_items(50);
        let b = generate_sample_items(50);
        assert_eq!(a.len(), 50);
        for (x, y) in a.iter().zip(b.iter()) {
            assert_eq!(x.id, y.id);
            assert_eq!(x.name, y.name);
            assert_eq!(x.price, y.price);
            assert_eq!(x.stock, y.stock);
            assert_eq!(x.updated_at, y.updated_at);
        }
    }

    #[test]
    fn generate_sample_items_produces_plausible_rows() {
        let rows = generate_sample_items(200);
        for row in &rows {
            assert!(row.price >= 50);
            assert!(row.stock >= 0 && row.stock < 500);
            assert_eq!(row.updated_at.len(), 10); // YYYY-MM-DD
        }
    }

    #[tokio::test]
    async fn init_db_memory_migrates_and_seeds_exactly_once() {
        let db = init_db_memory()
            .await
            .expect("init_db_memory should succeed");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items")
            .fetch_one(db.as_sqlite().expect("sqlite handle"))
            .await
            .unwrap();
        assert_eq!(count, SEED_ROW_COUNT as i64);
    }

    #[tokio::test]
    async fn seeding_is_idempotent_across_two_inits_on_the_same_db() {
        let db = Db::connect_sqlite_memory().await.unwrap();
        run_migrations_and_seed(&db).await.unwrap();
        run_migrations_and_seed(&db).await.unwrap(); // second init: must not double-seed
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items")
            .fetch_one(db.as_sqlite().expect("sqlite handle"))
            .await
            .unwrap();
        assert_eq!(count, SEED_ROW_COUNT as i64);
    }

    // [scaffold:items] end

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
}
