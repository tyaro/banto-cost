//! PostgreSQL connection helpers (spec §12.1). Contrasts with
//! [`crate::sqlite`] in two ways: the argument is a `postgres://` URL, not a
//! filesystem path (PostgreSQL is a network service, not a file), and the
//! database itself is pre-provisioned by a DBA/admin - unlike SQLite there is
//! no `create_if_missing`, connecting to a database that doesn't exist yet is
//! an error.
//!
//! `list_query`'s `Postgres` instantiation
//! (`impl_list_query!(postgres, sqlx::Postgres)`) already covers query
//! building; this module only adds the connection helper that was missing.

use std::str::FromStr;

use banto_core::BantoError;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;

use crate::error::storage_error;

/// Maximum number of pooled connections opened per [`connect`] call.
///
/// PostgreSQL, unlike SQLite, is accessed over the network by a connection
/// pool rather than a single serialized writer, so concurrent callers share
/// up to this many live connections instead of contending on one file lock.
/// 5 is a conservative default sized for a single application instance
/// talking to a shared server (as opposed to sqlx's own default of 10);
/// callers that need a different ceiling can grow this into a parameter once
/// a real PostgreSQL-backed resource needs it.
const DEFAULT_MAX_CONNECTIONS: u32 = 5;

/// Connect to a PostgreSQL server at `url` (a `postgres://user:pass@host/db`
/// connection string), returning a pooled connection ready for concurrent
/// use.
///
/// Takes a `postgres://` URL, NOT a filesystem path: unlike SQLite,
/// PostgreSQL is a server the caller connects to over the network, so the
/// address/credentials/database name all live in the URL rather than in a
/// path on disk. Also unlike [`crate::sqlite::connect`], the target database
/// is expected to already exist - PostgreSQL databases are pre-created by an
/// admin, so there is no `create_if_missing` equivalent here; connecting to
/// a database that doesn't exist yet is a connection error.
pub async fn connect(url: &str) -> Result<PgPool, BantoError> {
    let options = PgConnectOptions::from_str(url).map_err(storage_error)?;

    PgPoolOptions::new()
        .max_connections(DEFAULT_MAX_CONNECTIONS)
        .connect_with(options)
        .await
        .map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    /// Integration test against a real PostgreSQL server. Skipped (not
    /// failed) when `BANTO_TEST_PG_URL` is unset so a plain `cargo test`
    /// with no PostgreSQL available still passes; CI's `storage-postgres`
    /// job sets the env var against a `postgres:16` service container.
    #[tokio::test]
    async fn connect_gives_a_usable_pool() {
        let Ok(url) = std::env::var("BANTO_TEST_PG_URL") else {
            return;
        };

        let pool = connect(&url).await.expect("connect should succeed");
        let row = sqlx::query("SELECT 1 AS one")
            .fetch_one(&pool)
            .await
            .expect("query should succeed");
        let value: i32 = row.get("one");
        assert_eq!(value, 1);
        pool.close().await;
    }
}
