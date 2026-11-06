//! Issue #208: attachment storage on PostgreSQL is per database and does not
//! depend on the connection credentials.
//!
//! Before #208, `banto-serve` derived the attachments directory from the
//! `BANTO_DB` URL as if it were a file path, so two databases on one server
//! shared a directory (the second database's attachment `1` overwrote the
//! first's) and changing the password moved the directory. These tests drive
//! the same `banto_attachments::base_dir_for_target` call `banto-serve` makes,
//! against real databases.
//!
//! Gated like `pg_smoke.rs`: compiled only with feature `postgres`, and a
//! no-op unless `BANTO_TEST_PG_URL` is set. That URL is used as an
//! administrative connection: each test creates its own databases (and role)
//! with a per-process suffix and drops them again at the end, so it needs
//! `CREATEDB`/`CREATEROLE` (the CI service container's `postgres` superuser
//! has both). It never touches the database named in the URL.
#![cfg(feature = "postgres")]

use std::path::Path;
use std::str::FromStr;

use admin_template_core::db::init_db_from_target;
use banto_attachments::{base_dir_for_target, AttachmentsService, NewAttachment};
use sqlx::postgres::{PgConnectOptions, PgPool};
use sqlx::ConnectOptions;

fn admin_url() -> Option<String> {
    match std::env::var("BANTO_TEST_PG_URL") {
        Ok(url) => Some(url),
        Err(_) => {
            eprintln!("pg_attachments: BANTO_TEST_PG_URL unset - skipping (no PostgreSQL server)");
            None
        }
    }
}

/// `admin_url` with the database (and optionally user/password) swapped.
fn url_for(admin_url: &str, database: &str, credentials: Option<(&str, &str)>) -> String {
    let mut options = PgConnectOptions::from_str(admin_url)
        .expect("BANTO_TEST_PG_URL parses")
        .database(database);
    if let Some((user, password)) = credentials {
        options = options.username(user).password(password);
    }
    options.to_url_lossy().to_string()
}

async fn admin_pool(admin_url: &str) -> PgPool {
    PgPool::connect(admin_url)
        .await
        .expect("connect with BANTO_TEST_PG_URL")
}

async fn exec(pool: &PgPool, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(pool)
        .await
        .unwrap_or_else(|err| panic!("{sql}: {err}"));
}

/// Drops every database and role whose name starts with `prefix` - run
/// before each test (sweeping leftovers of a run that panicked before its own
/// cleanup, whatever its process id was) and after it. Each test has its own
/// prefix, so the two tests in this file never sweep each other.
async fn cleanup(pool: &PgPool, prefix: &str) {
    let pattern = format!("{prefix}%");
    let databases: Vec<String> =
        sqlx::query_scalar("SELECT datname FROM pg_database WHERE datname LIKE $1")
            .bind(&pattern)
            .fetch_all(pool)
            .await
            .expect("list test databases");
    for db in databases {
        exec(
            pool,
            &format!("DROP DATABASE IF EXISTS \"{db}\" WITH (FORCE)"),
        )
        .await;
    }
    let roles: Vec<String> =
        sqlx::query_scalar("SELECT rolname FROM pg_roles WHERE rolname LIKE $1")
            .bind(&pattern)
            .fetch_all(pool)
            .await
            .expect("list test roles");
    for role in roles {
        exec(pool, &format!("DROP ROLE IF EXISTS \"{role}\"")).await;
    }
}

fn attachment(bytes: &[u8]) -> NewAttachment {
    NewAttachment {
        resource: "items".to_string(),
        resource_id: "1".to_string(),
        file_name: "body.bin".to_string(),
        created_by: None,
        bytes: bytes.to_vec(),
    }
}

/// What `banto-serve` does: `BANTO_DB` + `BANTO_ATTACHMENTS_DIR` -> service.
async fn open(url: &str, root: &Path) -> (banto_storage::Db, AttachmentsService) {
    let db = init_db_from_target(url)
        .await
        .expect("migrations-postgres on the test database");
    let dir = base_dir_for_target(url, true, Some(root)).expect("base dir");
    (db.clone(), AttachmentsService::new(db, dir))
}

async fn close(db: banto_storage::Db) {
    if let banto_storage::Db::Postgres(pool) = db {
        pool.close().await;
    }
}

#[tokio::test]
async fn two_databases_on_one_server_keep_their_attachments_apart() {
    let Some(admin) = admin_url() else { return };
    let pool = admin_pool(&admin).await;
    let suffix = std::process::id();
    let prefix = "banto208_sep_";
    let (name_a, name_b) = (format!("{prefix}a_{suffix}"), format!("{prefix}b_{suffix}"));
    cleanup(&pool, prefix).await;
    exec(&pool, &format!("CREATE DATABASE \"{name_a}\"")).await;
    exec(&pool, &format!("CREATE DATABASE \"{name_b}\"")).await;

    let root = tempfile::tempdir().expect("tempdir");
    let (db_a, a) = open(&url_for(&admin, &name_a, None), root.path()).await;
    let (db_b, b) = open(&url_for(&admin, &name_b, None), root.path()).await;

    // Both databases hand out id 1 first - the collision the issue describes.
    let in_a = a.upload(attachment(b"database A")).await.expect("upload A");
    let in_b = b.upload(attachment(b"database B")).await.expect("upload B");
    assert_eq!(in_a.id, in_b.id, "precondition: the ids collide");

    assert_eq!(a.read_body(in_a.id).await.unwrap().1, b"database A");
    assert_eq!(b.read_body(in_b.id).await.unwrap().1, b"database B");

    // Deleting in B leaves A's body alone.
    b.delete(in_b.id).await.expect("delete B");
    assert_eq!(a.read_body(in_a.id).await.unwrap().1, b"database A");

    close(db_a).await;
    close(db_b).await;
    cleanup(&pool, prefix).await;
    pool.close().await;
}

#[tokio::test]
async fn changing_the_password_keeps_the_existing_attachments_reachable() {
    let Some(admin) = admin_url() else { return };
    let pool = admin_pool(&admin).await;
    let suffix = std::process::id();
    let prefix = "banto208_pw_";
    let name = format!("{prefix}db_{suffix}");
    let role = format!("{prefix}role_{suffix}");
    cleanup(&pool, prefix).await;
    exec(
        &pool,
        &format!("CREATE ROLE \"{role}\" LOGIN PASSWORD 'first-password'"),
    )
    .await;
    exec(
        &pool,
        &format!("CREATE DATABASE \"{name}\" OWNER \"{role}\""),
    )
    .await;

    let root = tempfile::tempdir().expect("tempdir");
    let before_url = url_for(&admin, &name, Some((&role, "first-password")));
    let (db, service) = open(&before_url, root.path()).await;
    let stored = service
        .upload(attachment(b"kept across the rotation"))
        .await
        .expect("upload with the first password");
    close(db).await;

    exec(
        &pool,
        &format!("ALTER ROLE \"{role}\" PASSWORD 'second-password'"),
    )
    .await;

    // Reconnect with the new password (and, for good measure, as a different
    // user entirely): same database, same directory, same file.
    let after_url = url_for(&admin, &name, Some((&role, "second-password")));
    let (db, service) = open(&after_url, root.path()).await;
    assert_eq!(
        service
            .read_body(stored.id)
            .await
            .expect("read after rotation")
            .1,
        b"kept across the rotation"
    );
    close(db).await;
    let (db, service) = open(&url_for(&admin, &name, None), root.path()).await;
    assert_eq!(
        service.read_body(stored.id).await.expect("read as admin").1,
        b"kept across the rotation"
    );
    close(db).await;

    // No credential made it into the directory layout.
    for entry in walk(root.path()) {
        let text = entry.to_string_lossy();
        assert!(
            !text.contains("password") && !text.contains("role_"),
            "credential in path: {text}"
        );
    }

    cleanup(&pool, prefix).await;
    pool.close().await;
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(&path));
        }
        out.push(path);
    }
    out
}
