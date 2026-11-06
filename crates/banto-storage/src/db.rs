//! Backend-agnostic connection handle and SQL dialect helpers (spec §12.1,
//! V2 "PostgreSQL アプリ全体対応").
//!
//! Two distinct concerns live here:
//!
//! - [`Db`]: an **enum-dispatch** connection handle wrapping either a
//!   [`SqlitePool`] or a [`PgPool`]. Each variant is `cfg`-gated behind its
//!   backend feature, so the type only ever carries variants the build can
//!   actually construct (default `sqlite`-only builds have no `Postgres`
//!   variant; `--no-default-features --features postgres` has no `Sqlite`
//!   variant; enabling both yields both). This deliberately does **not** try
//!   to unify the backends behind one generic `sqlx::Database` bound — that
//!   fights sqlx's trait bounds hard enough that [`crate::list_query`] already
//!   chose macro monomorphization over a generic impl; enum dispatch is the
//!   same choice at the connection level.
//!
//! - [`Dialect`]: a feature-independent enum of the two SQL dialects, exposing
//!   the small syntactic differences the app service layer (PR2) has to bridge
//!   as **pure string-generating functions** — positional placeholders and the
//!   "current time" expression. Being pure and feature-independent, both
//!   dialects are testable with no database and under any feature combination.
//!   The SQLite renderings are byte-for-byte identical to the hand-written SQL
//!   the app already ships (`?` placeholders, `datetime('now')`), so PR2 can
//!   route existing SQLite SQL through these helpers without changing a single
//!   emitted byte.

/// The SQL dialect a query is being built for.
///
/// Kept independent of the `sqlite`/`postgres` cargo features on purpose: the
/// helpers below are pure string generation with no pool/`sqlx` dependency, so
/// the app layer can reason about (and unit-test) both dialects' SQL even in a
/// build that only links one backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Dialect {
    /// SQLite: `?` positional placeholders, `datetime('now')` for the current
    /// timestamp.
    Sqlite,
    /// PostgreSQL: `$1`, `$2`, … numbered placeholders, `NOW()` for the current
    /// timestamp.
    Postgres,
}

impl Dialect {
    /// Render the `n`-th positional bind placeholder (`n` is **1-based**, to
    /// match PostgreSQL's `$1` numbering).
    ///
    /// - SQLite ignores `n` and always yields `?` (positional-by-order),
    ///   identical to the crate's existing hand-written SQL.
    /// - PostgreSQL yields `$n`.
    ///
    /// ```
    /// use banto_storage::Dialect;
    /// assert_eq!(Dialect::Sqlite.placeholder(1), "?");
    /// assert_eq!(Dialect::Sqlite.placeholder(3), "?");
    /// assert_eq!(Dialect::Postgres.placeholder(1), "$1");
    /// assert_eq!(Dialect::Postgres.placeholder(3), "$3");
    /// ```
    pub fn placeholder(self, n: usize) -> String {
        match self {
            Dialect::Sqlite => "?".to_string(),
            Dialect::Postgres => format!("${n}"),
        }
    }

    /// Render `count` comma-separated placeholders numbered `1..=count`
    /// (e.g. for `IN (...)` lists or a `VALUES (...)` tuple).
    ///
    /// A `count` of 0 yields an empty string (the caller decides whether an
    /// empty list is legal for its clause).
    ///
    /// ```
    /// use banto_storage::Dialect;
    /// assert_eq!(Dialect::Sqlite.placeholders(3), "?, ?, ?");
    /// assert_eq!(Dialect::Postgres.placeholders(3), "$1, $2, $3");
    /// assert_eq!(Dialect::Postgres.placeholders(0), "");
    /// ```
    pub fn placeholders(self, count: usize) -> String {
        let mut out = String::new();
        for n in 1..=count {
            if n > 1 {
                out.push_str(", ");
            }
            out.push_str(&self.placeholder(n));
        }
        out
    }

    /// The SQL expression evaluating to the current UTC timestamp, matching the
    /// convention the app already uses (`created_at`/`updated_at` are written
    /// from the DB's own clock, never the host's).
    ///
    /// - SQLite: `datetime('now')` — byte-identical to the existing
    ///   `UPDATE ... SET updated_at = datetime('now')` SQL in the app layer.
    /// - PostgreSQL: `NOW()`.
    ///
    /// ```
    /// use banto_storage::Dialect;
    /// assert_eq!(Dialect::Sqlite.now_expr(), "datetime('now')");
    /// assert_eq!(Dialect::Postgres.now_expr(), "NOW()");
    /// ```
    pub fn now_expr(self) -> &'static str {
        match self {
            Dialect::Sqlite => "datetime('now')",
            Dialect::Postgres => "NOW()",
        }
    }
}

// The connection handle only exists when at least one backend is compiled in.
// A build with neither feature has no pool type to wrap, so `Db` would be an
// empty enum with nothing to construct or dispatch on; gating the whole type
// (and its impl) keeps that configuration compiling cleanly while the pure
// `Dialect` helpers above remain available unconditionally.
#[cfg(any(feature = "sqlite", feature = "postgres"))]
mod handle {
    use super::Dialect;
    use banto_core::BantoError;

    #[cfg(feature = "postgres")]
    use sqlx::PgPool;
    #[cfg(feature = "sqlite")]
    use sqlx::SqlitePool;

    /// A backend-agnostic connection handle: either a SQLite or a PostgreSQL
    /// connection pool, dispatched by `enum` rather than a generic bound.
    ///
    /// Cloning is cheap — both `sqlx` pools are `Arc`-backed, so a `Db` clone
    /// shares the same underlying pool (same contract the app services rely on
    /// for their `#[derive(Clone)]`, `docs/conventions.md` §2).
    ///
    /// Variants are `cfg`-gated: only backends actually compiled in appear, so
    /// `match`ing a `Db` never has to handle a backend the build can't create.
    #[derive(Debug, Clone)]
    pub enum Db {
        /// A SQLite connection pool (feature `sqlite`).
        #[cfg(feature = "sqlite")]
        Sqlite(SqlitePool),
        /// A PostgreSQL connection pool (feature `postgres`).
        #[cfg(feature = "postgres")]
        Postgres(PgPool),
    }

    impl Db {
        /// Open a SQLite database at filesystem `path` (WAL + foreign keys,
        /// created if missing) and wrap it as [`Db::Sqlite`]. Thin wrapper over
        /// [`crate::sqlite::connect`].
        #[cfg(feature = "sqlite")]
        pub async fn connect_sqlite(path: impl AsRef<std::path::Path>) -> Result<Self, BantoError> {
            Ok(Db::Sqlite(crate::sqlite::connect(path).await?))
        }

        /// Open a private in-memory SQLite database and wrap it as
        /// [`Db::Sqlite`]. Thin wrapper over [`crate::sqlite::connect_memory`];
        /// intended for tests.
        #[cfg(feature = "sqlite")]
        pub async fn connect_sqlite_memory() -> Result<Self, BantoError> {
            Ok(Db::Sqlite(crate::sqlite::connect_memory().await?))
        }

        /// Connect to a PostgreSQL server at `url` (a `postgres://` connection
        /// string) and wrap the pool as [`Db::Postgres`]. Thin wrapper over
        /// [`crate::postgres::connect`].
        #[cfg(feature = "postgres")]
        pub async fn connect_postgres(url: &str) -> Result<Self, BantoError> {
            Ok(Db::Postgres(crate::postgres::connect(url).await?))
        }

        /// The SQL [`Dialect`] this handle speaks, for the placeholder /
        /// `now_expr` helpers.
        pub fn dialect(&self) -> Dialect {
            match self {
                #[cfg(feature = "sqlite")]
                Db::Sqlite(_) => Dialect::Sqlite,
                #[cfg(feature = "postgres")]
                Db::Postgres(_) => Dialect::Postgres,
            }
        }

        /// Borrow the underlying [`SqlitePool`], or `None` if this handle is a
        /// PostgreSQL connection. Lets a SQLite-specific code path get at the
        /// concrete pool without an `if let` on the variant at every call site.
        #[cfg(feature = "sqlite")]
        pub fn as_sqlite(&self) -> Option<&SqlitePool> {
            match self {
                Db::Sqlite(pool) => Some(pool),
                #[cfg(feature = "postgres")]
                Db::Postgres(_) => None,
            }
        }

        /// Borrow the underlying [`PgPool`], or `None` if this handle is a
        /// SQLite connection.
        #[cfg(feature = "postgres")]
        pub fn as_postgres(&self) -> Option<&PgPool> {
            match self {
                Db::Postgres(pool) => Some(pool),
                #[cfg(feature = "sqlite")]
                Db::Sqlite(_) => None,
            }
        }
    }
}

#[cfg(any(feature = "sqlite", feature = "postgres"))]
pub use handle::Db;

#[cfg(test)]
mod dialect_tests {
    use super::Dialect;

    #[test]
    fn sqlite_placeholder_is_always_question_mark() {
        // Positional-by-order: the index is irrelevant, matching the crate's
        // existing hand-written `?` SQL (backward compatibility).
        assert_eq!(Dialect::Sqlite.placeholder(1), "?");
        assert_eq!(Dialect::Sqlite.placeholder(2), "?");
        assert_eq!(Dialect::Sqlite.placeholder(99), "?");
    }

    #[test]
    fn postgres_placeholder_is_dollar_numbered_one_based() {
        assert_eq!(Dialect::Postgres.placeholder(1), "$1");
        assert_eq!(Dialect::Postgres.placeholder(2), "$2");
        assert_eq!(Dialect::Postgres.placeholder(10), "$10");
    }

    #[test]
    fn placeholders_list_matches_each_backend() {
        assert_eq!(Dialect::Sqlite.placeholders(1), "?");
        assert_eq!(Dialect::Sqlite.placeholders(3), "?, ?, ?");
        assert_eq!(Dialect::Postgres.placeholders(1), "$1");
        assert_eq!(Dialect::Postgres.placeholders(3), "$1, $2, $3");
    }

    #[test]
    fn placeholders_zero_is_empty() {
        assert_eq!(Dialect::Sqlite.placeholders(0), "");
        assert_eq!(Dialect::Postgres.placeholders(0), "");
    }

    #[test]
    fn now_expr_is_stable_per_backend() {
        // The SQLite rendering MUST stay byte-equal to the app's existing
        // `datetime('now')` SQL (see `apps/.../users.rs`), or PR2 routing SQL
        // through this helper would silently change emitted bytes.
        assert_eq!(Dialect::Sqlite.now_expr(), "datetime('now')");
        assert_eq!(Dialect::Postgres.now_expr(), "NOW()");
    }
}

#[cfg(all(test, feature = "sqlite"))]
mod sqlite_handle_tests {
    use super::{Db, Dialect};

    #[tokio::test]
    async fn connect_sqlite_memory_yields_a_sqlite_handle() {
        let db = Db::connect_sqlite_memory()
            .await
            .expect("connect_sqlite_memory should succeed");
        assert_eq!(db.dialect(), Dialect::Sqlite);
        assert!(db.as_sqlite().is_some());
    }

    #[tokio::test]
    async fn clone_shares_the_same_pool() {
        // Arc-backed cheap clone: the clone must be usable and point at the
        // same live database as the original.
        let db = Db::connect_sqlite_memory().await.expect("connect");
        let cloned = db.clone();
        let pool = cloned.as_sqlite().expect("clone is a sqlite handle");
        let row: (i64,) = sqlx::query_as("SELECT 1")
            .fetch_one(pool)
            .await
            .expect("query on cloned handle should succeed");
        assert_eq!(row.0, 1);
    }

    #[cfg(feature = "postgres")]
    #[tokio::test]
    async fn sqlite_handle_is_not_postgres() {
        let db = Db::connect_sqlite_memory().await.expect("connect");
        assert!(db.as_postgres().is_none());
    }
}
