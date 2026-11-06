//! SQLite connection helpers (spec §11.3, §12.1): WAL mode + foreign keys
//! enabled for every connection, file created automatically if missing.

use banto_core::BantoError;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::str::FromStr;

use crate::error::storage_error;

/// Open (creating the file if missing) a SQLite database at the filesystem
/// path `path`, with WAL journaling and foreign key enforcement turned on
/// (spec §11.3: multi-client writes are handled via WAL + serialized
/// writes).
///
/// Takes a plain filesystem path, NOT a `sqlite://` URL: sqlx's URL parsing
/// mangles Windows paths (drive letters, backslashes), and the app data
/// directory this is used with is an OS-native path.
pub async fn connect(path: impl AsRef<Path>) -> Result<SqlitePool, BantoError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);

    SqlitePoolOptions::new()
        .connect_with(options)
        .await
        .map_err(storage_error)
}

/// Open a private, ephemeral in-memory SQLite database. Intended for tests:
/// each call yields an independent, empty database.
pub async fn connect_memory() -> Result<SqlitePool, BantoError> {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .map_err(storage_error)?
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);

    SqlitePoolOptions::new()
        .connect_with(options)
        .await
        .map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    #[tokio::test]
    async fn connect_memory_gives_a_usable_pool() {
        let pool = connect_memory()
            .await
            .expect("connect_memory should succeed");
        let row = sqlx::query("SELECT 1 AS one")
            .fetch_one(&pool)
            .await
            .expect("query should succeed");
        let value: i64 = row.get("one");
        assert_eq!(value, 1);
    }

    #[tokio::test]
    async fn connect_creates_a_file_that_does_not_exist_yet() {
        let dir = std::env::temp_dir().join(format!("banto-storage-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let db_path = dir.join("test.sqlite3");
        if db_path.exists() {
            std::fs::remove_file(&db_path).expect("remove stale test db");
        }

        let pool = connect(&db_path)
            .await
            .expect("connect should create the file");
        assert!(db_path.exists(), "connect() should create the sqlite file");
        pool.close().await;

        std::fs::remove_file(&db_path).ok();
        std::fs::remove_dir(&dir).ok();
    }
}
