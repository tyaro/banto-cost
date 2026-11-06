//! Audit trail service (spec M14, `docs/roadmap.md`): who did what, when,
//! over which transport, and whether it was allowed. Backed by the
//! `audit_log` table (migration `0005_audit_log.sql`), same service-layer
//! pattern as `admin_template_core::items::ItemsService` - testable in a
//! plain `cargo test`, no `tauri`/`axum` dependency.
//!
//! Moved from `admin-template-core::audit` to this crate in theme C PR-C1
//! (docs/template-scope.md §7 移行順 ①): the logic is domain-agnostic, so it
//! belongs in the shared crate rather than in code every adopter copies.
//!
//! **This service does not know about actors, RBAC, or HTTP** - it only
//! knows how to store/list/prune rows. Every REST handler and Tauri command
//! that mutates state (or gets rejected by an RBAC guard) is responsible for
//! building an [`AuditEntry`] itself and calling
//! [`AuditLogService::record`] - see `admin_template_core::rest`'s and
//! `src-tauri`'s `require_role`/`require_role_at_least` call sites for where
//! the actor (`Identity`) and the REST/Tauri "origin" are known.
//!
//! SECURITY: [`AuditEntry::detail`] is a JSON **summary** (spec: "値の全量は
//! 入れない") - changed field NAMES, a new role, a method+path, etc. Nothing
//! that calls into this module may ever put a password, password hash, or
//! bearer token into `detail`. There is no runtime guard against this (the
//! type is a free-form `serde_json::Value`) - it is enforced by review at
//! every call site instead.
//!
//! ## The spool: an audit write the database cannot take (ADR-0019)
//!
//! [`AuditLogService::record`] must not fail or block the operation it
//! audits, and before ADR-0019 an entry it could not write was only logged
//! (`eprintln`) and lost. An app can opt in to a **spool**
//! ([`AuditLogService::with_spool`], tyaro/banto-industrial#437): `record`
//! then
//!
//! 1. fixes a `pending_id` (UUIDv4) and the `ts` before writing, and INSERTs
//!    them with the row (`ON CONFLICT (pending_id) DO NOTHING`, the unique
//!    index of migration `0008_audit_log_pending_id.sql`);
//! 2. waits for the INSERT at most [`SpoolConfig::timeout`] (3 s by
//!    default). On an error, or no answer in time, it writes the entry to a
//!    file in the spool directory and returns. A timed-out INSERT is **not**
//!    cancelled - it runs on in a spawned task and may still complete;
//! 3. flushes the spool into `audit_log` later
//!    ([`AuditLogService::flush_spool`]: at startup when the app calls it,
//!    after a successful `record` when entries are waiting or the spool
//!    directory has not been read for [`SpoolConfig::flush_interval`], and
//!    from [`AuditLogService::spawn_spool_flusher`]'s periodic task, which
//!    reads the directory every interval even when this process spooled
//!    nothing - another process sharing the directory may have). The flush
//!    INSERTs with the same `pending_id` and `ts`, so an entry whose original
//!    INSERT completed late is not written twice, and several processes
//!    flushing one directory are safe too. Rows written by a flush carry
//!    `"spooled": true` in `detail` (merged into an object `detail`; any
//!    other `detail` is wrapped as `{"value": <detail>, "spooled": true}`).
//!
//! `ts` is the time of the `record` call, in the text the column DEFAULT
//! would have produced: SQLite `datetime('now')` (`YYYY-MM-DD HH:MM:SS`,
//! UTC); PostgreSQL `now()::text` (the UTC microsecond time is cast through
//! `timestamptz` to `text` by the INSERT, so it follows the session's
//! `TimeZone`/`DateStyle` exactly like the DEFAULT). A flushed row therefore
//! sorts and filters by when it happened, not when it was flushed - and a
//! retention prune ([`AuditLogService::prune`]) may delete it right after the
//! flush if it is already older than the retention period.
//!
//! **Without a spool nothing changes**: `record` awaits [`try_record`]
//! inline (no timeout, no `pending_id`, `ts` from the DEFAULT), so an app
//! that has not applied migration `0008` keeps working. [`try_record`]
//! never spools - its callers want the operation to fail when the audit
//! write does.
//!
//! ## Where the warning lines go
//!
//! By default every warning line this service logs (a `record` failure
//! without a spool, and all spool messages: spooled, flushed, dropped,
//! failed, quarantined, unreadable or unremovable file, flush failed) is
//! printed with `eprintln!` (ADR-0004). An app without a stderr - a Windows
//! service - routes them to its own log with
//! [`AuditLogService::with_log_sink`] ([`AuditLogSink`]); the sink gets the
//! same text `eprintln!` would print, without the trailing newline.
//!
//! [`try_record`]: AuditLogService::try_record

mod spool;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use banto_core::{BantoError, ListParams, ListResult};
use banto_storage::{ColumnMap, Db, Dialect};
use serde::Serialize;
use sqlx::{QueryBuilder, Sqlite};

use spool::{PendingEntry, Spool};
pub use spool::{SpoolBacklog, SpoolConfig, SpoolFlushReport};

/// One row of the `audit_log` table, wire-shaped for the audit-log viewer
/// (spec M14's admin-only grid). `detail` is the raw JSON-encoded summary
/// string as stored (not re-parsed into a `Value`) - the frontend grid can
/// `JSON.parse` it on demand for display, mirroring how `detail` is written
/// (see [`AuditLogService::try_record`]).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub id: i64,
    pub ts: String,
    pub actor_username: Option<String>,
    pub actor_role: Option<String>,
    pub action: String,
    pub resource: String,
    pub entity_id: Option<String>,
    pub detail: Option<String>,
    pub origin: String,
    pub result: String,
}

/// One page of the audit-log viewer's read with its snapshot boundary
/// (Issue #248, [`AuditLogService::list_as_of`]). `rows`/`totalCount` are
/// spelled exactly like `banto_core::ListResult` (which lives in
/// `banto-core` and cannot grow a field), plus the boundary this answer
/// used, `asOfId` - a client that reads only `rows`/`totalCount` keeps
/// working unchanged.
///
/// Both `rows` and `total_count` are taken from the rows with
/// `id <= as_of_id`. On an empty table `as_of_id` is `0` (ids start at 1, so
/// it is a boundary containing no row), never `null`.
///
/// `deletion_epoch` (`deletionEpoch`, Issue #248 review) is the retention
/// prune's counter ([`DELETION_EPOCH_KEY`]) read in the same transaction:
/// it advances with every prune that deleted rows, in the prune's own
/// transaction. A viewer compares it (and the count) with its generation's
/// first answer - see [`AuditLogService::list_as_of`] for why the count
/// alone is not enough.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogList {
    pub rows: Vec<AuditLogEntry>,
    pub total_count: u64,
    pub as_of_id: i64,
    pub deletion_epoch: i64,
}

/// `settings` key of the retention prune's deletion epoch (Issue #248
/// review, [`AuditLogList::deletion_epoch`]). Absent (never pruned) or not an
/// integer reads as `0`. Lives in `settings` (a Banto base table every
/// adopter has, conventions §11) so no migration is needed.
pub const DELETION_EPOCH_KEY: &str = "audit.deletion_epoch";

/// The stored epoch text as a number (`0` when absent or not an integer).
fn parse_epoch(value: Option<String>) -> i64 {
    value.and_then(|v| v.trim().parse().ok()).unwrap_or(0)
}

/// One record to write to the `audit_log` table (spec M14). Borrowed string
/// fields keep call sites cheap - this is built fresh at each call site and
/// consumed immediately by [`AuditLogService::record`]/[`AuditLogService::try_record`],
/// never stored.
///
/// See this module's doc comment for the hard rule on what `detail` may
/// carry.
#[derive(Debug, Clone)]
pub struct AuditEntry<'a> {
    /// Username snapshot of the actor, or `None` for an unauthenticated
    /// event (e.g. a login failure before any session exists).
    pub actor_username: Option<&'a str>,
    /// The actor's role AT THE TIME of the action (spec: not looked up
    /// later - a role change afterward must not rewrite history).
    pub actor_role: Option<&'a str>,
    /// e.g. `"create"`, `"update"`, `"delete"`, `"login"`, `"login_failed"`,
    /// `"logout"`, `"setup"`, `"password_reset"`, `"settings_change"`,
    /// `"denied"`.
    pub action: &'a str,
    /// e.g. `"items"`, `"users"`, `"settings"`, `"auth"`.
    pub resource: &'a str,
    pub entity_id: Option<&'a str>,
    pub detail: Option<serde_json::Value>,
    /// `"rest"` or `"tauri"`.
    pub origin: &'a str,
    /// `"ok"`, `"denied"`, or `"failed"`.
    pub result: &'a str,
}

/// Column whitelist for [`AuditLogService::list`] (spec M14, mirrors
/// `admin_template_core::items::column_map`): wire field name (camelCase, as
/// sent by the audit-log viewer) -> actual `audit_log` SQL column.
fn column_map() -> ColumnMap {
    ColumnMap::new()
        .column("id", "id")
        .column("ts", "ts")
        .column("actorUsername", "actor_username")
        .column("actorRole", "actor_role")
        .column("action", "action")
        .column("resource", "resource")
        .column("entityId", "entity_id")
        .column("detail", "detail")
        .column("origin", "origin")
        .column("result", "result")
}

/// Audit trail service (spec M14): append-only writes, a filtered/sorted/
/// paginated read (admin-only viewer), and retention-based pruning.
///
/// `Clone` is cheap (`Db` is an `Arc`-backed connection handle), matching
/// `ItemsService`/`UsersService`/`SettingsService`.
#[derive(Clone)]
pub struct AuditLogService {
    db: Db,
    /// `None` = no spool (the behavior before ADR-0019).
    spool: Option<Arc<Spool>>,
    /// Where warning lines go (default: stderr). Held here, not in the
    /// spool, so [`AuditLogService::with_log_sink`] works before or after
    /// [`AuditLogService::with_spool`].
    log: AuditLogSink,
}

/// A destination for the warning lines [`AuditLogService`] logs, set with
/// [`AuditLogService::with_log_sink`]. Called with one line, no trailing
/// newline; may be called from any thread or task, so keep it quick.
pub type AuditLogSink = Arc<dyn Fn(&str) + Send + Sync>;

fn stderr_sink() -> AuditLogSink {
    Arc::new(|line| eprintln!("{line}"))
}

/// The `audit_log` INSERT of an entry that has a `pending_id` (the spool
/// path, ADR-0019). Same statement for the first attempt and the flush.
const SQLITE_INSERT_PENDING: &str = "INSERT INTO audit_log \
     (pending_id, ts, actor_username, actor_role, action, resource, entity_id, detail, origin, result) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (pending_id) DO NOTHING";
/// PostgreSQL: `ts` is bound as UTC text and cast through `timestamptz` so
/// the stored text is what the column DEFAULT `now()::text` would write.
#[cfg(feature = "postgres")]
const PG_INSERT_PENDING: &str = "INSERT INTO audit_log \
     (pending_id, ts, actor_username, actor_role, action, resource, entity_id, detail, origin, result) \
     VALUES ($1, CAST(CAST($2 AS timestamptz) AS text), $3, $4, $5, $6, $7, $8, $9, $10) \
     ON CONFLICT (pending_id) DO NOTHING";

/// `ts` of an entry recorded at `now`, as bound by the pending INSERT (see
/// the module doc).
fn pending_ts(dialect: Dialect, now: SystemTime) -> String {
    let seconds = crate::backup::iso_datetime_from_system_time(now);
    match dialect {
        Dialect::Sqlite => seconds,
        Dialect::Postgres => {
            let micros = now
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.subsec_micros())
                .unwrap_or(0);
            format!("{seconds}.{micros:06}+00")
        }
    }
}

/// The `detail` a flushed row stores: the original with `"spooled": true`.
fn spooled_detail(detail: Option<&serde_json::Value>) -> serde_json::Value {
    match detail {
        None => serde_json::json!({ "spooled": true }),
        Some(serde_json::Value::Object(map)) => {
            let mut map = map.clone();
            map.insert("spooled".to_string(), serde_json::Value::Bool(true));
            serde_json::Value::Object(map)
        }
        Some(other) => serde_json::json!({ "value": other, "spooled": true }),
    }
}

/// INSERT a pending entry (`ON CONFLICT (pending_id) DO NOTHING`). `flushed`
/// marks `detail` as spooled.
async fn insert_pending(db: &Db, entry: &PendingEntry, flushed: bool) -> Result<(), BantoError> {
    let detail = if flushed {
        Some(spooled_detail(entry.detail.as_ref()))
    } else {
        entry.detail.clone()
    };
    let detail = detail
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| {
            BantoError::Other(format!("監査ログのdetailシリアライズに失敗しました: {err}"))
        })?;
    match db {
        Db::Sqlite(pool) => sqlx::query(SQLITE_INSERT_PENDING)
            .bind(&entry.pending_id)
            .bind(&entry.ts)
            .bind(&entry.actor_username)
            .bind(&entry.actor_role)
            .bind(&entry.action)
            .bind(&entry.resource)
            .bind(&entry.entity_id)
            .bind(detail)
            .bind(&entry.origin)
            .bind(&entry.result)
            .execute(pool)
            .await
            .map(|_| ()),
        #[cfg(feature = "postgres")]
        Db::Postgres(pool) => sqlx::query(PG_INSERT_PENDING)
            .bind(&entry.pending_id)
            .bind(&entry.ts)
            .bind(&entry.actor_username)
            .bind(&entry.actor_role)
            .bind(&entry.action)
            .bind(&entry.resource)
            .bind(&entry.entity_id)
            .bind(detail)
            .bind(&entry.origin)
            .bind(&entry.result)
            .execute(pool)
            .await
            .map(|_| ()),
    }
    .map_err(banto_storage::storage_error)
}

/// Outcome of waiting for one spooled INSERT.
///
/// A timeout does not abort the task (ADR-0019): dropping the `JoinHandle`
/// detaches it, so the INSERT may still complete, and the flush finds that
/// row by `pending_id` instead of writing a second one.
#[derive(Debug, PartialEq, Eq)]
enum InsertWait {
    /// The INSERT finished within the timeout.
    Completed,
    /// Spool the entry. The reason is `timeout` or `error: ...`.
    NeedsSpool(String),
}

/// Wait for `insert` for at most `timeout`.
///
/// An error returns `error:` as soon as the INSERT fails and does not wait
/// out the rest of the timeout. No answer returns `timeout` at exactly
/// `timeout`, without aborting the task (ADR-0019, see [`InsertWait`]). The
/// spool file's `sync_all` is outside this function, so it is not part of
/// the elapsed time measured here.
async fn wait_for_insert(
    timeout: Duration,
    insert: tokio::task::JoinHandle<Result<(), BantoError>>,
) -> InsertWait {
    match tokio::time::timeout(timeout, insert).await {
        Ok(Ok(Ok(()))) => InsertWait::Completed,
        Ok(Ok(Err(err))) => InsertWait::NeedsSpool(format!("error: {err}")),
        Ok(Err(join_err)) => InsertWait::NeedsSpool(format!("error: {join_err}")),
        Err(_) => InsertWait::NeedsSpool("timeout".to_string()),
    }
}

impl AuditLogService {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            spool: None,
            log: stderr_sink(),
        }
    }

    /// Send every warning line this service logs - the `record` failure
    /// without a spool, and all spool messages (spooled, flushed, dropped,
    /// failed, quarantined, unreadable or unremovable file, flush failed) -
    /// to `sink` instead of stderr. For an app that has no stderr (a Windows
    /// service) and keeps its own log file. The line is the text `eprintln!`
    /// would print, without the trailing newline. Not calling this keeps the
    /// default (`eprintln!`), unchanged. Works before or after
    /// [`AuditLogService::with_spool`].
    pub fn with_log_sink(mut self, sink: impl Fn(&str) + Send + Sync + 'static) -> Self {
        self.log = Arc::new(sink);
        self
    }

    /// Like [`AuditLogService::with_log_sink`], but takes an already-shared
    /// [`AuditLogSink`] (an `Arc<dyn Fn(&str) + Send + Sync>`), so one sink
    /// can be cloned into several services. A separate method because
    /// `Arc<dyn Fn>` does not implement `Fn` and so cannot be passed to the
    /// generic `with_log_sink`; closures keep using that one.
    pub fn with_shared_log_sink(mut self, sink: AuditLogSink) -> Self {
        self.log = sink;
        self
    }

    /// Opt in to the spool (ADR-0019, see the module doc): `record` then
    /// writes an entry the database cannot take within `config.timeout` to
    /// `dir` instead of losing it. `dir` is created if missing and the
    /// entries already waiting there (an earlier run) are loaded, so build
    /// the service once at startup, then call [`AuditLogService::flush_spool`]
    /// and [`AuditLogService::spawn_spool_flusher`].
    ///
    /// Requires migration `0008_audit_log_pending_id.sql` (the `pending_id`
    /// column and its unique index): without it every spooled `record` fails
    /// its INSERT and lands in the spool, and no flush succeeds.
    ///
    /// Use a directory of its own per database (e.g. next to the SQLite file
    /// or in the app's data directory); several processes writing to the
    /// same database may share it.
    pub fn with_spool(
        mut self,
        dir: impl Into<PathBuf>,
        config: SpoolConfig,
    ) -> Result<Self, BantoError> {
        self.spool = Some(Arc::new(Spool::open(dir.into(), config)?));
        Ok(self)
    }

    /// Write one audit entry. `Result`-returning (unlike
    /// [`AuditLogService::record`]) so unit tests can assert on failure
    /// modes; every REST/Tauri call site should use `record` instead, which
    /// never fails the caller's real operation over an audit-write hiccup.
    pub async fn try_record(&self, entry: AuditEntry<'_>) -> Result<(), BantoError> {
        let detail = entry
            .detail
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|err| {
                BantoError::Other(format!("監査ログのdetailシリアライズに失敗しました: {err}"))
            })?;

        let dialect = self.db.dialect();
        // sqlx 0.9: `sqlx::query` requires `impl SqlSafeStr`, which a runtime
        // `String` does not implement directly. AssertSqlSafe is safe here
        // because the only interpolated fragment is `dialect.placeholders(8)`,
        // which is internally generated from the `Dialect` enum (never
        // caller input) - every actual value is bound below via `.bind(...)`.
        let sql = format!(
            "INSERT INTO audit_log (actor_username, actor_role, action, resource, entity_id, detail, origin, result) \
             VALUES ({})",
            dialect.placeholders(8),
        );
        match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(entry.actor_username)
                .bind(entry.actor_role)
                .bind(entry.action)
                .bind(entry.resource)
                .bind(entry.entity_id)
                .bind(detail)
                .bind(entry.origin)
                .bind(entry.result)
                .execute(pool)
                .await
                .map(|_| ()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(entry.actor_username)
                .bind(entry.actor_role)
                .bind(entry.action)
                .bind(entry.resource)
                .bind(entry.entity_id)
                .bind(detail)
                .bind(entry.origin)
                .bind(entry.result)
                .execute(pool)
                .await
                .map(|_| ()),
        }
        .map_err(banto_storage::storage_error)?;
        Ok(())
    }

    /// Fire-and-forget wrapper around [`AuditLogService::try_record`] (spec
    /// M14 design decision): a failure to WRITE an audit entry must never
    /// fail the operation being audited (e.g. an `items.create` that
    /// otherwise succeeded) - it is only logged as a warning (`eprintln` by
    /// default, or the sink of [`AuditLogService::with_log_sink`]; this
    /// workspace has no `tracing` dependency, see the root `Cargo.toml`).
    /// Every REST handler and Tauri command calls this, not `try_record`,
    /// directly.
    ///
    /// With a spool ([`AuditLogService::with_spool`], ADR-0019) a failed or
    /// hanging write is spooled instead of lost, and `record` returns within
    /// about [`SpoolConfig::timeout`] - see the module doc. Without one,
    /// unchanged.
    pub async fn record(&self, entry: AuditEntry<'_>) {
        if let Some(spool) = &self.spool {
            return self.record_spooled(spool, entry).await;
        }
        let action = entry.action.to_string();
        let resource = entry.resource.to_string();
        if let Err(err) = self.try_record(entry).await {
            (self.log)(&format!(
                "banto: 監査ログの記録に失敗しました（action={action}, resource={resource}）: {err}"
            ));
        }
    }

    async fn record_spooled(&self, spool: &Arc<Spool>, entry: AuditEntry<'_>) {
        let pending = PendingEntry::new(
            &entry,
            uuid::Uuid::new_v4().to_string(),
            pending_ts(self.db.dialect(), SystemTime::now()),
        );
        // The INSERT runs in its own task so a timeout does not cancel it:
        // dropping the `JoinHandle` detaches the task, which may still
        // complete later (the flush then finds the row by `pending_id`).
        let db = self.db.clone();
        let attempt = pending.clone();
        let insert = tokio::spawn(async move { insert_pending(&db, &attempt, false).await });
        match wait_for_insert(spool.config.timeout, insert).await {
            InsertWait::Completed => {
                // Local backlog, or a directory not read for
                // `flush_interval` (another process may have spooled to it).
                if spool.should_flush_after_success() {
                    let svc = self.clone();
                    tokio::spawn(async move { svc.flush_spool_if_idle().await });
                }
            }
            InsertWait::NeedsSpool(reason) => {
                spool.write(&self.log, pending, reason).await;
            }
        }
    }

    /// The spool's backlog as seen by this process (ADR-0019). All zero /
    /// `None` without a spool.
    pub fn spool_backlog(&self) -> SpoolBacklog {
        self.spool
            .as_ref()
            .map(|spool| spool.backlog())
            .unwrap_or_default()
    }

    /// Write the spooled entries into `audit_log`, oldest first (`ts`, then
    /// `pending_id`), and remove each file once its row is in (ADR-0019).
    /// Call it once at startup (after the migrations); `record` and
    /// [`AuditLogService::spawn_spool_flusher`] also trigger it. Waits for a
    /// flush already running in this service. A database error or timeout
    /// stops the flush (the rest stay spooled) and is reported in
    /// [`SpoolFlushReport::error`]; `Err` only when the spool directory
    /// cannot be read. Without a spool, does nothing.
    pub async fn flush_spool(&self) -> Result<SpoolFlushReport, BantoError> {
        let Some(spool) = &self.spool else {
            return Ok(SpoolFlushReport::default());
        };
        let _guard = spool.flush_lock.lock().await;
        self.flush_locked(spool).await
    }

    /// [`AuditLogService::flush_spool`] unless one is already running (the
    /// background triggers do not queue up behind it).
    async fn flush_spool_if_idle(&self) {
        let Some(spool) = &self.spool else { return };
        let Ok(_guard) = spool.flush_lock.try_lock() else {
            return;
        };
        if let Err(err) = self.flush_locked(spool).await {
            (self.log)(&format!(
                "banto: 監査ログの保留分を流し込めませんでした: {err}"
            ));
        }
    }

    async fn flush_locked(&self, spool: &Spool) -> Result<SpoolFlushReport, BantoError> {
        let scan = spool.scan(&self.log).await?;
        let total = scan.entries.len() as u64;
        let mut report = SpoolFlushReport {
            quarantined: scan.quarantined,
            ..Default::default()
        };
        for (path, entry) in scan.entries {
            let inserted =
                tokio::time::timeout(spool.config.timeout, insert_pending(&self.db, &entry, true))
                    .await;
            match inserted {
                Ok(Ok(())) => {
                    spool.remove(&self.log, path, &entry.pending_id).await;
                    report.flushed += 1;
                }
                Ok(Err(err)) => {
                    report.error = Some(format!("error: {err}"));
                    break;
                }
                Err(_) => {
                    report.error = Some("timeout".to_string());
                    break;
                }
            }
        }
        spool
            .reconcile(
                report
                    .error
                    .as_ref()
                    .map(|err| format!("流し込みを中断: {err}")),
            )
            .await;
        report.remaining = spool.count() as u64;
        if total > 0 || report.quarantined > 0 {
            (self.log)(&format!(
                "banto: 監査ログの保留分を {} 件 DB へ流し込みました（残り {} 件、隔離 {} 件{}）",
                report.flushed,
                report.remaining,
                report.quarantined,
                report
                    .error
                    .as_ref()
                    .map(|err| format!("、中断: {err}"))
                    .unwrap_or_default()
            ));
        }
        Ok(report)
    }

    /// Start the periodic flush (ADR-0019): every
    /// [`SpoolConfig::flush_interval`] it reads the spool directory and
    /// flushes what it finds - even when this process's own backlog is
    /// empty, because another process sharing the directory may have spooled
    /// entries this one never saw (a `read_dir` per interval; nothing is
    /// logged when the directory is empty). Returns `None` without a spool.
    /// The task holds a clone of this service (and so of its pool) - abort
    /// the handle when shutting down. Must be called inside a Tokio runtime.
    pub fn spawn_spool_flusher(&self) -> Option<tokio::task::JoinHandle<()>> {
        let spool = self.spool.clone()?;
        let svc = self.clone();
        Some(tokio::spawn(async move {
            let mut tick = tokio::time::interval(spool.config.flush_interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tick.tick().await; // the first tick is immediate
            loop {
                tick.tick().await;
                svc.flush_spool_if_idle().await;
            }
        }))
    }

    /// Filtered/sorted/paginated read (spec M14's admin-only viewer) with no
    /// snapshot boundary. Same result as [`AuditLogService::list_as_of`] with
    /// `as_of_id: None` minus the boundary it picked (that boundary is the
    /// newest row at the time of the read, so the result covers the whole
    /// table exactly as before Issue #248). Kept with its original return
    /// type so existing callers (and derived apps) stay unchanged.
    pub async fn list(&self, params: ListParams) -> Result<ListResult<AuditLogEntry>, BantoError> {
        let list = self.list_as_of(params, None).await?;
        Ok(ListResult {
            rows: list.rows,
            total_count: list.total_count,
        })
    }

    /// Filtered/sorted/paginated read (spec M14's admin-only viewer), same
    /// `banto_storage::list_query` pattern as
    /// `admin_template_core::items::ItemsService::list`. Deliberately called
    /// only from the admin-gated `/api/audit-log/list` route / `audit_log_list`
    /// command - this service itself has no RBAC awareness (see this
    /// module's doc comment).
    ///
    /// **`as_of_id` is a snapshot boundary** (Issue #248, spec §4.1): when
    /// given, only rows with `id <= as_of_id` are counted and listed. When
    /// omitted, the boundary is the largest `id` at the time of this read
    /// (`0` for an empty table), which covers every row - so a caller that
    /// omits it gets the same rows and count as before. The boundary used
    /// is returned in [`AuditLogList::as_of_id`]; a block-fetching viewer
    /// (`@banto/admin-core`'s `SnapshotListResource`) pins the one its first
    /// answer returned and sends it with every later block of the same
    /// generation, so rows **added** between two block requests do not
    /// shift `OFFSET`. This relies on `audit_log.id` growing monotonically
    /// and never being reused (SQLite `AUTOINCREMENT`, PostgreSQL
    /// `IDENTITY`; migration `0005_audit_log.sql`) and on audit rows never
    /// being updated.
    ///
    /// The boundary does **not** keep the set fixed by itself: retention
    /// pruning ([`AuditLogService::prune`]) removes rows inside it, and on
    /// PostgreSQL a writer that allocated a lower `id` can commit after the
    /// boundary was picked and add a row inside it (SQLite writes one at a
    /// time, so there a row below the boundary is always committed before a
    /// higher id exists). Either shifts `OFFSET`. The viewer stops reading
    /// the generation when an answer differs from the generation's first in
    /// **the count or the deletion epoch** ([`AuditLogList::deletion_epoch`]):
    /// a late commit alone raises the count, a prune alone lowers the count
    /// and advances the epoch, and a late commit plus an equally large prune
    /// (the count is unchanged) still advances the epoch. The count alone
    /// would miss that last case (a duplicated row, no expiry, Issue #248
    /// review). Rows are never deleted outside `prune` (restoring a backup
    /// replaces the whole database and restarts the app). The callers also
    /// skip the opportunistic prune for bounded reads (see the REST route /
    /// Tauri command) so a page's own reads do not expire it.
    ///
    /// **The boundary, the rows and the count come from one read
    /// transaction** together with the deletion epoch, so one answer never
    /// mixes two points in time (the comparisons above depend on it). PostgreSQL runs it as
    /// `REPEATABLE READ, READ ONLY` - its default `READ COMMITTED` would
    /// give every statement its own snapshot; a SQLite read transaction
    /// already reads one snapshot.
    ///
    /// The order is total: `column_map()` registers `id`, so
    /// `append_order_by` ends `ORDER BY` with `id` in the direction of the
    /// last sort key (Issue #243) - rows sharing a `ts` second keep one
    /// order across blocks.
    pub async fn list_as_of(
        &self,
        params: ListParams,
        as_of_id: Option<i64>,
    ) -> Result<AuditLogList, BantoError> {
        let columns = column_map();
        // The bounded set is wrapped as a subquery aliased `audit_log`, so the
        // column whitelist (`column_map`) and `apply_list_params` apply to it
        // unchanged (`append_where` writes its own ` WHERE `, so the bound
        // cannot simply be appended to the outer query).
        const SELECT_ROWS: &str =
            "SELECT id, ts, actor_username, actor_role, action, resource, entity_id, detail, origin, result \
             FROM (SELECT * FROM audit_log WHERE id <= ";
        const SELECT_COUNT: &str = "SELECT COUNT(*) FROM (SELECT * FROM audit_log WHERE id <= ";
        const BOUNDED_ALIAS: &str = ") AS audit_log";
        const SELECT_MAX_ID: &str = "SELECT MAX(id) FROM audit_log";
        // The key literal here and in `prune` is [`DELETION_EPOCH_KEY`]
        // (`deletion_epoch_uses_the_documented_settings_key` pins it).
        const SELECT_EPOCH: &str = "SELECT value FROM settings WHERE key = 'audit.deletion_epoch'";

        // Per-backend `QueryBuilder`/`list_query` dispatch, same shape as
        // `admin_template_core::items::ItemsService::list` (see that method's
        // comment).
        match &self.db {
            Db::Sqlite(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let as_of_id = match as_of_id {
                    Some(id) => id,
                    None => sqlx::query_scalar::<_, Option<i64>>(SELECT_MAX_ID)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .unwrap_or(0),
                };

                let mut rows_builder: QueryBuilder<Sqlite> = QueryBuilder::new(SELECT_ROWS);
                rows_builder.push_bind(as_of_id);
                rows_builder.push(BOUNDED_ALIAS);
                banto_storage::list_query::sqlite::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<AuditLogEntry> = rows_builder
                    .build_query_as::<AuditLogEntry>()
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;

                let mut count_builder: QueryBuilder<Sqlite> = QueryBuilder::new(SELECT_COUNT);
                count_builder.push_bind(as_of_id);
                count_builder.push(BOUNDED_ALIAS);
                banto_storage::list_query::sqlite::append_where(
                    &mut count_builder,
                    &columns,
                    &params.filters,
                )?;
                let total_count: i64 = count_builder
                    .build_query_scalar()
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;

                let deletion_epoch = parse_epoch(
                    sqlx::query_scalar::<_, String>(SELECT_EPOCH)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?,
                );

                tx.commit().await.map_err(banto_storage::storage_error)?;
                Ok(AuditLogList {
                    rows,
                    total_count: total_count as u64,
                    as_of_id,
                    deletion_epoch,
                })
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                // Must be the transaction's first statement (PostgreSQL rejects
                // it after a query has run).
                sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let as_of_id = match as_of_id {
                    Some(id) => id,
                    None => sqlx::query_scalar::<_, Option<i64>>(SELECT_MAX_ID)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .unwrap_or(0),
                };

                let mut rows_builder: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(SELECT_ROWS);
                rows_builder.push_bind(as_of_id);
                rows_builder.push(BOUNDED_ALIAS);
                banto_storage::list_query::postgres::apply_list_params(
                    &mut rows_builder,
                    &columns,
                    &params,
                )?;
                let rows: Vec<AuditLogEntry> = rows_builder
                    .build_query_as::<AuditLogEntry>()
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;

                let mut count_builder: QueryBuilder<sqlx::Postgres> =
                    QueryBuilder::new(SELECT_COUNT);
                count_builder.push_bind(as_of_id);
                count_builder.push(BOUNDED_ALIAS);
                banto_storage::list_query::postgres::append_where(
                    &mut count_builder,
                    &columns,
                    &params.filters,
                )?;
                let total_count: i64 = count_builder
                    .build_query_scalar()
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;

                let deletion_epoch = parse_epoch(
                    sqlx::query_scalar::<_, String>(SELECT_EPOCH)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?,
                );

                tx.commit().await.map_err(banto_storage::storage_error)?;
                Ok(AuditLogList {
                    rows,
                    total_count: total_count as u64,
                    as_of_id,
                    deletion_epoch,
                })
            }
        }
    }

    /// Retention-based pruning (spec M14): delete rows older than
    /// `retention_days` (if `Some`), then - separately - delete the oldest
    /// rows beyond `retention_rows` (if `Some`), oldest-first by `id`
    /// (`AUTOINCREMENT` guarantees `id` order matches insertion order,
    /// which is a more reliable "oldest" tiebreak than `ts` alone since
    /// several rows can share the same second). `None` means unlimited for
    /// that dimension (spec: "0以下は「無制限」として None 扱い" - callers
    /// normalize at the settings layer, see
    /// `crate::settings::SettingsService::audit_config`; this method also
    /// treats a non-positive value defensively as "skip this dimension").
    ///
    /// Called opportunistically (spec: "サーバ/アプリ起動時に1回 + list実行時に
    /// 軽く") rather than from a dedicated background task - see the REST/
    /// Tauri call sites' comments for why that is sufficient here.
    ///
    /// **The deletions and the deletion epoch move together** (Issue #248
    /// review): both deletes run in one transaction that, when it deleted
    /// anything, also advances [`DELETION_EPOCH_KEY`] in `settings`. A
    /// reader's snapshot therefore sees either the rows and the old epoch or
    /// neither and the new one - the invariant [`AuditLogList::deletion_epoch`]
    /// relies on. The row-cap delete computes its excess inside the `DELETE`
    /// (no read-then-write gap between counting and deleting).
    ///
    /// Returns the total number of rows deleted.
    pub async fn prune(
        &self,
        retention_days: Option<i64>,
        retention_rows: Option<i64>,
    ) -> Result<u64, BantoError> {
        let days = retention_days.filter(|d| *d > 0);
        let max_rows = retention_rows.filter(|r| *r > 0);
        if days.is_none() && max_rows.is_none() {
            return Ok(0);
        }

        // The "N days ago" interval arithmetic is the largest dialect gap in
        // this crate: SQLite's `datetime('now', '-N days')` modifier has no
        // Postgres analogue, so each backend gets its own hand-written SQL.
        // The SQLite string is byte-identical to the pre-V2 query. Postgres
        // casts the TEXT `ts` to `timestamptz` (it has no `text <
        // timestamptz` operator; the stored `now()::text` values round-trip)
        // and binds `days` as `int8` while `make_interval` wants `int4`.
        const SQLITE_DAYS: &str =
            "DELETE FROM audit_log WHERE ts < datetime('now', '-' || ? || ' days')";
        // Oldest-first-by-`id` delete of everything beyond the cap; the excess
        // is computed in the same statement.
        const SQLITE_ROWS: &str = "DELETE FROM audit_log WHERE id IN \
             (SELECT id FROM audit_log ORDER BY id ASC \
              LIMIT max(0, (SELECT COUNT(*) FROM audit_log) - ?))";
        // `CAST('garbage' AS INTEGER)` is 0 in SQLite, so a hand-edited value
        // restarts from 1 instead of failing the prune.
        const SQLITE_BUMP: &str = "INSERT INTO settings (key, value) VALUES ('audit.deletion_epoch', '1') \
             ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT)";

        match &self.db {
            Db::Sqlite(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let mut deleted: u64 = 0;
                if let Some(days) = days {
                    deleted += sqlx::query(SQLITE_DAYS)
                        .bind(days)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .rows_affected();
                }
                if let Some(max_rows) = max_rows {
                    deleted += sqlx::query(SQLITE_ROWS)
                        .bind(max_rows)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .rows_affected();
                }
                if deleted > 0 {
                    sqlx::query(SQLITE_BUMP)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
                Ok(deleted)
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                const PG_DAYS: &str = "DELETE FROM audit_log WHERE ts::timestamptz < NOW() - make_interval(days => $1::int)";
                const PG_ROWS: &str = "DELETE FROM audit_log WHERE id IN \
                     (SELECT id FROM audit_log ORDER BY id ASC \
                      LIMIT GREATEST(0, (SELECT COUNT(*) FROM audit_log) - $1))";
                // `ON CONFLICT DO UPDATE` locks the row, so two concurrent
                // prunes each advance the epoch. A value that is not an integer
                // (hand-edited) restarts from 1 instead of failing the prune.
                const PG_BUMP: &str = "INSERT INTO settings (key, value) VALUES ('audit.deletion_epoch', '1') \
                     ON CONFLICT (key) DO UPDATE SET value = ((CASE WHEN settings.value ~ '^-?[0-9]{1,18}$' \
                     THEN settings.value::bigint ELSE 0 END) + 1)::text";
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let mut deleted: u64 = 0;
                if let Some(days) = days {
                    deleted += sqlx::query(PG_DAYS)
                        .bind(days)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .rows_affected();
                }
                if let Some(max_rows) = max_rows {
                    deleted += sqlx::query(PG_ROWS)
                        .bind(max_rows)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?
                        .rows_affected();
                }
                if deleted > 0 {
                    sqlx::query(PG_BUMP)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
                Ok(deleted)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use banto_core::{FilterOp, FilterState, Pagination, SortDirection, SortState};
    use serde_json::json;

    /// An in-memory SQLite handle with the `audit_log` table + indexes
    /// created inline. This crate owns no migrations (conventions §11: table
    /// definitions belong to the app); the DDL below MUST be kept in sync
    /// with `apps/admin-template/core/migrations-sqlite/0005_audit_log.sql`.
    /// Same pattern `banto-attachments` uses to avoid a backwards dependency
    /// on the app crate's `db::migrate_memory` (conventions §"逆依存禁止").
    async fn service() -> AuditLogService {
        let db = Db::connect_sqlite_memory()
            .await
            .expect("connect in-memory sqlite");
        let pool = db
            .as_sqlite()
            .expect("service tests run on a SQLite handle");
        sqlx::query(
            "CREATE TABLE audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL DEFAULT (datetime('now')),
                actor_username TEXT,
                actor_role TEXT,
                action TEXT NOT NULL,
                resource TEXT NOT NULL,
                entity_id TEXT,
                detail TEXT,
                origin TEXT NOT NULL,
                result TEXT NOT NULL DEFAULT 'ok'
            )",
        )
        .execute(pool)
        .await
        .expect("create audit_log table");
        // `prune`/`list_as_of` keep the deletion epoch in `settings`
        // (Issue #248 review); MUST match `0002_settings.sql`.
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(pool)
            .await
            .expect("create settings table");
        sqlx::query("CREATE INDEX idx_audit_log_ts ON audit_log(ts)")
            .execute(pool)
            .await
            .expect("create ts index");
        sqlx::query("CREATE INDEX idx_audit_log_actor ON audit_log(actor_username)")
            .execute(pool)
            .await
            .expect("create actor index");
        sqlx::query("CREATE INDEX idx_audit_log_resource ON audit_log(resource, entity_id)")
            .execute(pool)
            .await
            .expect("create resource index");
        add_pending_id(pool).await;
        AuditLogService::new(db)
    }

    /// The spool's column (ADR-0019); MUST match
    /// `apps/admin-template/core/migrations-sqlite/0008_audit_log_pending_id.sql`.
    async fn add_pending_id(pool: &sqlx::SqlitePool) {
        sqlx::query("ALTER TABLE audit_log ADD COLUMN pending_id TEXT")
            .execute(pool)
            .await
            .expect("add pending_id");
        sqlx::query("CREATE UNIQUE INDEX idx_audit_log_pending_id ON audit_log(pending_id)")
            .execute(pool)
            .await
            .expect("create pending_id index");
    }

    fn sample_entry<'a>(action: &'a str, resource: &'a str, actor: &'a str) -> AuditEntry<'a> {
        AuditEntry {
            actor_username: Some(actor),
            actor_role: Some("admin"),
            action,
            resource,
            entity_id: Some("1"),
            detail: Some(json!({ "name": "Widget" })),
            origin: "rest",
            result: "ok",
        }
    }

    #[tokio::test]
    async fn record_then_list_round_trips() {
        let svc = service().await;
        svc.try_record(sample_entry("create", "items", "admin"))
            .await
            .expect("try_record should succeed");

        let result = svc
            .list(ListParams::default())
            .await
            .expect("list should succeed");
        assert_eq!(result.total_count, 1);
        assert_eq!(result.rows.len(), 1);
        let row = &result.rows[0];
        assert_eq!(row.actor_username.as_deref(), Some("admin"));
        assert_eq!(row.actor_role.as_deref(), Some("admin"));
        assert_eq!(row.action, "create");
        assert_eq!(row.resource, "items");
        assert_eq!(row.entity_id.as_deref(), Some("1"));
        assert_eq!(row.origin, "rest");
        assert_eq!(row.result, "ok");
        let detail: serde_json::Value =
            serde_json::from_str(row.detail.as_deref().expect("detail should be set")).unwrap();
        assert_eq!(detail, json!({ "name": "Widget" }));
        assert!(!row.ts.is_empty());
    }

    #[tokio::test]
    async fn record_with_no_actor_stores_null_actor_columns() {
        let svc = service().await;
        svc.try_record(AuditEntry {
            actor_username: None,
            actor_role: None,
            action: "login_failed",
            resource: "auth",
            entity_id: None,
            detail: None,
            origin: "rest",
            result: "failed",
        })
        .await
        .expect("try_record should succeed");

        let result = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(result.rows[0].actor_username, None);
        assert_eq!(result.rows[0].actor_role, None);
        assert_eq!(result.rows[0].detail, None);
    }

    /// `record` (the fire-and-forget entry point every REST/Tauri call site
    /// actually uses) must not panic and must still persist a valid entry -
    /// this is the "happy path" proof that it delegates to `try_record`
    /// correctly, since its failure-swallowing behavior itself can't be
    /// observed without a broken pool (not exercised here).
    #[tokio::test]
    async fn record_persists_like_try_record() {
        let svc = service().await;
        svc.record(sample_entry("delete", "users", "owner")).await;
        let result = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.rows[0].action, "delete");
    }

    #[tokio::test]
    async fn list_filters_by_resource_and_action() {
        let svc = service().await;
        svc.record(sample_entry("create", "items", "admin")).await;
        svc.record(sample_entry("create", "users", "admin")).await;
        svc.record(sample_entry("delete", "items", "admin")).await;

        let result = svc
            .list(ListParams {
                filters: vec![
                    FilterState {
                        field: "resource".to_string(),
                        op: FilterOp::Eq,
                        value: json!("items"),
                    },
                    FilterState {
                        field: "action".to_string(),
                        op: FilterOp::Eq,
                        value: json!("create"),
                    },
                ],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.rows[0].resource, "items");
        assert_eq!(result.rows[0].action, "create");
    }

    #[tokio::test]
    async fn list_filters_by_actor_username() {
        let svc = service().await;
        svc.record(sample_entry("create", "items", "alice")).await;
        svc.record(sample_entry("create", "items", "bob")).await;

        let result = svc
            .list(ListParams {
                filters: vec![FilterState {
                    field: "actorUsername".to_string(),
                    op: FilterOp::Eq,
                    value: json!("bob"),
                }],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.rows[0].actor_username.as_deref(), Some("bob"));
    }

    #[tokio::test]
    async fn list_sorts_and_paginates() {
        let svc = service().await;
        for action in ["a", "b", "c"] {
            svc.record(sample_entry(action, "items", "admin")).await;
        }

        let result = svc
            .list(ListParams {
                sort: vec![SortState {
                    field: "id".to_string(),
                    direction: SortDirection::Desc,
                }],
                pagination: Some(Pagination {
                    offset: 0,
                    limit: 1,
                }),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.total_count, 3);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0].action, "c"); // most recently inserted first
    }

    // --- prune (spec M14) ---------------------------------------------------

    async fn seed_n(svc: &AuditLogService, n: usize) {
        for i in 0..n {
            svc.record(sample_entry("create", "items", "admin")).await;
            let _ = i;
        }
    }

    #[tokio::test]
    async fn prune_with_both_none_is_a_no_op() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        let deleted = svc.prune(None, None).await.unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(
            svc.list(ListParams::default()).await.unwrap().total_count,
            5
        );
    }

    #[tokio::test]
    async fn prune_by_row_count_keeps_the_newest_rows() {
        let svc = service().await;
        seed_n(&svc, 5).await;

        let deleted = svc.prune(None, Some(2)).await.unwrap();
        assert_eq!(deleted, 3);

        let remaining = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(remaining.total_count, 2);
        // The two highest ids (most recently inserted) must survive.
        let mut ids: Vec<i64> = remaining.rows.iter().map(|r| r.id).collect();
        ids.sort();
        assert_eq!(ids, vec![4, 5]);
    }

    #[tokio::test]
    async fn prune_by_row_count_is_a_no_op_when_under_the_limit() {
        let svc = service().await;
        seed_n(&svc, 3).await;
        let deleted = svc.prune(None, Some(100)).await.unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(
            svc.list(ListParams::default()).await.unwrap().total_count,
            3
        );
    }

    #[tokio::test]
    async fn prune_by_days_deletes_rows_older_than_the_cutoff() {
        let svc = service().await;
        seed_n(&svc, 2).await;
        // Directly backdate one row's `ts` past a 1-day retention window -
        // there is no clock injection in this service (unlike
        // `banto_server::auth`'s `AuthState`), so this is the simplest way
        // to exercise the days branch deterministically.
        sqlx::query("UPDATE audit_log SET ts = datetime('now', '-10 days') WHERE id = 1")
            .execute(
                svc.db
                    .as_sqlite()
                    .expect("service tests run on a SQLite handle"),
            )
            .await
            .unwrap();

        let deleted = svc.prune(Some(1), None).await.unwrap();
        assert_eq!(deleted, 1);
        let remaining = svc.list(ListParams::default()).await.unwrap();
        assert_eq!(remaining.total_count, 1);
        assert_eq!(remaining.rows[0].id, 2);
    }

    #[tokio::test]
    async fn prune_treats_non_positive_values_as_unlimited() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        let deleted = svc.prune(Some(0), Some(-1)).await.unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(
            svc.list(ListParams::default()).await.unwrap().total_count,
            5
        );
    }

    // --- list_as_of: snapshot boundary (Issue #248) ----------------------------

    fn page(offset: u64, limit: u64, sort: Vec<SortState>) -> ListParams {
        ListParams {
            pagination: Some(Pagination { offset, limit }),
            sort,
            ..Default::default()
        }
    }

    fn ts_desc() -> Vec<SortState> {
        vec![SortState {
            field: "ts".to_string(),
            direction: SortDirection::Desc,
        }]
    }

    fn ids(list: &AuditLogList) -> Vec<i64> {
        list.rows.iter().map(|r| r.id).collect()
    }

    /// Rows written between two block reads do not enter a pinned
    /// generation: the second block continues the first one's set exactly
    /// (no duplicate at the block edge), and its count is the first one's.
    /// A new unbounded read (the viewer's "reload") sees the new rows.
    #[tokio::test]
    async fn list_as_of_pins_the_set_across_blocks() {
        let svc = service().await;
        seed_n(&svc, 5).await;

        let first = svc.list_as_of(page(0, 2, ts_desc()), None).await.unwrap();
        assert_eq!(first.as_of_id, 5, "an omitted boundary is the newest id");
        assert_eq!(first.total_count, 5);
        assert_eq!(ids(&first), vec![5, 4]);

        // Two entries recorded between the blocks.
        seed_n(&svc, 2).await;

        let second = svc
            .list_as_of(page(2, 2, ts_desc()), Some(first.as_of_id))
            .await
            .unwrap();
        let third = svc
            .list_as_of(page(4, 2, ts_desc()), Some(first.as_of_id))
            .await
            .unwrap();
        assert_eq!(second.as_of_id, 5, "the given boundary is echoed back");
        assert_eq!(second.total_count, 5, "the pinned set's count is unchanged");
        assert_eq!(ids(&second), vec![3, 2]);
        assert_eq!(ids(&third), vec![1]);

        let fresh = svc.list_as_of(page(0, 2, ts_desc()), None).await.unwrap();
        assert_eq!(fresh.as_of_id, 7);
        assert_eq!(fresh.total_count, 7);
        assert_eq!(ids(&fresh), vec![7, 6]);
    }

    /// Without the boundary the same interleaving duplicates a row at the
    /// block edge - the failure `asOfId` exists to prevent (the "before"
    /// half of the test above).
    #[tokio::test]
    async fn unbounded_blocks_shift_when_rows_are_added_between_them() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        let first = svc.list(page(0, 2, ts_desc())).await.unwrap();
        seed_n(&svc, 2).await;
        let second = svc.list(page(2, 2, ts_desc())).await.unwrap();
        let first_ids: Vec<i64> = first.rows.iter().map(|r| r.id).collect();
        let second_ids: Vec<i64> = second.rows.iter().map(|r| r.id).collect();
        assert_eq!(first_ids, vec![5, 4]);
        assert_eq!(second_ids, vec![5, 4], "the edge rows come back again");
    }

    /// Omitting `as_of_id` keeps `list`'s old result: every row, the same
    /// count, and on an empty table the boundary `0` (a boundary that holds
    /// no row, never `null`).
    #[tokio::test]
    async fn list_as_of_without_a_boundary_matches_list() {
        let svc = service().await;
        let empty = svc.list_as_of(ListParams::default(), None).await.unwrap();
        assert_eq!(empty.as_of_id, 0);
        assert_eq!(empty.total_count, 0);
        assert!(empty.rows.is_empty());
        let pinned_empty = svc
            .list_as_of(ListParams::default(), Some(0))
            .await
            .unwrap();
        assert_eq!(pinned_empty.total_count, 0);

        svc.record(sample_entry("create", "items", "alice")).await;
        svc.record(sample_entry("delete", "users", "bob")).await;
        svc.record(sample_entry("create", "users", "alice")).await;

        let params = ListParams {
            sort: ts_desc(),
            filters: vec![FilterState {
                field: "actorUsername".to_string(),
                op: FilterOp::Eq,
                value: json!("alice"),
            }],
            ..Default::default()
        };
        let old = svc.list(params.clone()).await.unwrap();
        let new = svc.list_as_of(params, None).await.unwrap();
        assert_eq!(new.as_of_id, 3);
        assert_eq!(new.total_count, old.total_count);
        assert_eq!(new.rows, old.rows);
        assert_eq!(ids(&new), vec![3, 1]);
    }

    /// The boundary and the filters combine: the count is the filtered
    /// count inside the boundary.
    #[tokio::test]
    async fn list_as_of_combines_with_filters() {
        let svc = service().await;
        svc.record(sample_entry("create", "items", "alice")).await;
        svc.record(sample_entry("create", "items", "bob")).await;
        svc.record(sample_entry("create", "items", "alice")).await;
        svc.record(sample_entry("create", "items", "alice")).await;

        let bounded = svc
            .list_as_of(
                ListParams {
                    filters: vec![FilterState {
                        field: "actorUsername".to_string(),
                        op: FilterOp::Eq,
                        value: json!("alice"),
                    }],
                    ..Default::default()
                },
                Some(3),
            )
            .await
            .unwrap();
        assert_eq!(bounded.total_count, 2);
        assert_eq!(ids(&bounded), vec![1, 3]);
    }

    /// Rows sharing one `ts` (several entries within one second) keep one
    /// order across `OFFSET` blocks: `ORDER BY ts DESC` ends with `id DESC`
    /// (`column_map()` registers `id`, Issue #243), `ts ASC` with `id ASC`.
    #[tokio::test]
    async fn rows_with_the_same_ts_are_ordered_by_id_in_both_directions() {
        let svc = service().await;
        seed_n(&svc, 7).await;
        sqlx::query("UPDATE audit_log SET ts = '2026-09-29 12:00:00'")
            .execute(
                svc.db
                    .as_sqlite()
                    .expect("service tests run on a SQLite handle"),
            )
            .await
            .unwrap();

        for (direction, expected) in [
            (SortDirection::Desc, vec![7, 6, 5, 4, 3, 2, 1]),
            (SortDirection::Asc, vec![1, 2, 3, 4, 5, 6, 7]),
        ] {
            let sort = vec![SortState {
                field: "ts".to_string(),
                direction,
            }];
            let first = svc
                .list_as_of(page(0, 3, sort.clone()), None)
                .await
                .unwrap();
            let mut seen = ids(&first);
            for offset in [3, 6] {
                let block = svc
                    .list_as_of(page(offset, 3, sort.clone()), Some(first.as_of_id))
                    .await
                    .unwrap();
                seen.extend(ids(&block));
            }
            assert_eq!(seen, expected, "{direction:?}");
        }
    }

    /// A prune inside a pinned boundary changes the pinned set's count -
    /// the signal the viewer uses to expire the generation (the boundary
    /// only covers additions).
    #[tokio::test]
    async fn a_prune_inside_the_boundary_changes_the_pinned_count() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        let first = svc.list_as_of(page(0, 2, ts_desc()), None).await.unwrap();
        assert_eq!(first.total_count, 5);

        svc.prune(None, Some(3)).await.unwrap();
        let second = svc
            .list_as_of(page(2, 2, ts_desc()), Some(first.as_of_id))
            .await
            .unwrap();
        assert_eq!(second.total_count, 3);
    }

    // --- deletion epoch (Issue #248 review) -----------------------------------

    fn pool_of(svc: &AuditLogService) -> &sqlx::SqlitePool {
        svc.db
            .as_sqlite()
            .expect("service tests run on a SQLite handle")
    }

    /// A late commit below the boundary (+1) and a prune of the same size
    /// (-1) leave the pinned count unchanged while the set changed - the
    /// block after the edge repeats a row. The deletion epoch still moves.
    ///
    /// SQLite writes one at a time, so a row below the boundary cannot
    /// commit late there; the late commit is simulated by inserting an
    /// explicit lower id (the PostgreSQL smoke test reproduces it with real
    /// transactions).
    #[tokio::test]
    async fn a_late_commit_offset_by_a_prune_keeps_the_count_but_moves_the_epoch() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        // Id 4 "has not committed yet".
        sqlx::query("DELETE FROM audit_log WHERE id = 4")
            .execute(pool_of(&svc))
            .await
            .unwrap();

        let first = svc.list_as_of(page(0, 2, ts_desc()), None).await.unwrap();
        assert_eq!(ids(&first), vec![5, 3]);
        assert_eq!((first.as_of_id, first.total_count), (5, 4));

        // Id 4 commits, then another tab's unbounded read prunes to 4 rows.
        sqlx::query(
            "INSERT INTO audit_log (id, action, resource, origin) VALUES (4, 'create', 'items', 'rest')",
        )
        .execute(pool_of(&svc))
        .await
        .unwrap();
        assert_eq!(svc.prune(None, Some(4)).await.unwrap(), 1);

        let second = svc
            .list_as_of(page(2, 2, ts_desc()), Some(first.as_of_id))
            .await
            .unwrap();
        assert_eq!(
            second.total_count, first.total_count,
            "the count alone misses it"
        );
        assert_eq!(
            ids(&second),
            vec![3, 2],
            "row 3 comes back: the set shifted"
        );
        assert_ne!(
            second.deletion_epoch, first.deletion_epoch,
            "the deletion epoch catches it"
        );
    }

    /// The epoch starts at 0, advances once per prune that deleted rows
    /// (both dimensions in one prune count once), and not for a prune that
    /// deleted nothing. It is stored under `DELETION_EPOCH_KEY`.
    #[tokio::test]
    async fn deletion_epoch_uses_the_documented_settings_key() {
        let svc = service().await;
        seed_n(&svc, 5).await;
        let epoch = |svc: &AuditLogService| {
            let svc = svc.clone();
            async move {
                svc.list_as_of(ListParams::default(), None)
                    .await
                    .unwrap()
                    .deletion_epoch
            }
        };
        assert_eq!(epoch(&svc).await, 0);

        assert_eq!(svc.prune(None, Some(100)).await.unwrap(), 0);
        assert_eq!(epoch(&svc).await, 0, "nothing deleted, no advance");

        sqlx::query("UPDATE audit_log SET ts = datetime('now', '-10 days') WHERE id = 1")
            .execute(pool_of(&svc))
            .await
            .unwrap();
        assert_eq!(svc.prune(Some(1), Some(3)).await.unwrap(), 2);
        assert_eq!(epoch(&svc).await, 1);
        let stored: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(DELETION_EPOCH_KEY)
            .fetch_one(pool_of(&svc))
            .await
            .unwrap();
        assert_eq!(stored, "1");

        assert_eq!(svc.prune(None, Some(2)).await.unwrap(), 1);
        assert_eq!(epoch(&svc).await, 2);

        // A hand-edited value that is not a number restarts from 1 instead
        // of failing the prune.
        sqlx::query("UPDATE settings SET value = 'x' WHERE key = ?")
            .bind(DELETION_EPOCH_KEY)
            .execute(pool_of(&svc))
            .await
            .unwrap();
        assert_eq!(epoch(&svc).await, 0);
        assert_eq!(svc.prune(None, Some(1)).await.unwrap(), 1);
        assert_eq!(epoch(&svc).await, 1);
    }

    // --- spool (ADR-0019, tyaro/banto-industrial#437) -------------------------

    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use std::path::Path;
    use std::time::{Duration, Instant};

    /// The `audit_log` DDL of `0005_audit_log.sql`, plus `0008`'s
    /// `pending_id` when `pending_id` is set.
    async fn create_audit_log(pool: &sqlx::SqlitePool, pending_id: bool) {
        sqlx::query(
            "CREATE TABLE audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL DEFAULT (datetime('now')),
                actor_username TEXT,
                actor_role TEXT,
                action TEXT NOT NULL,
                resource TEXT NOT NULL,
                entity_id TEXT,
                detail TEXT,
                origin TEXT NOT NULL,
                result TEXT NOT NULL DEFAULT 'ok'
            )",
        )
        .execute(pool)
        .await
        .expect("create audit_log table");
        if pending_id {
            add_pending_id(pool).await;
        }
    }

    /// A file-backed SQLite handle (the spool tests break and hold the
    /// database from a second handle on the same pool) with at most
    /// `max_connections` connections.
    async fn file_db(dir: &Path, max_connections: u32, pending_id: bool) -> Db {
        let options = SqliteConnectOptions::new()
            .filename(dir.join("audit.sqlite3"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        // The DDL runs on a pool of its own that is closed before the test's
        // pool opens: a pooled connection that loaded the schema before the
        // unique index existed can fail to *prepare* the `ON CONFLICT
        // (pending_id)` INSERT (SQLite checks the conflict target against the
        // schema the connection has cached; it only reloads on execution).
        let setup = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .expect("open file sqlite");
        create_audit_log(&setup, pending_id).await;
        setup.close().await;
        let pool = SqlitePoolOptions::new()
            .max_connections(max_connections)
            .connect_with(options)
            .await
            .expect("open file sqlite");
        Db::Sqlite(pool)
    }

    fn spool_config(timeout_ms: u64) -> SpoolConfig {
        SpoolConfig {
            timeout: Duration::from_millis(timeout_ms),
            ..Default::default()
        }
    }

    /// The `*.json` file names in the spool directory (not `.tmp`, not the
    /// quarantine directory).
    fn spool_files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".json"))
            .collect();
        names.sort();
        names
    }

    fn read_spool_file(dir: &Path, name: &str) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(dir.join(name)).unwrap()).unwrap()
    }

    /// `(ts, pending_id, detail)` of every row, by id.
    async fn audit_rows(pool: &sqlx::SqlitePool) -> Vec<(String, Option<String>, Option<String>)> {
        sqlx::query_as("SELECT ts, pending_id, detail FROM audit_log ORDER BY id")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    async fn count_rows(pool: &sqlx::SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn take_offline(pool: &sqlx::SqlitePool) {
        sqlx::query("ALTER TABLE audit_log RENAME TO audit_log_offline")
            .execute(pool)
            .await
            .unwrap();
    }

    async fn bring_back(pool: &sqlx::SqlitePool) {
        sqlx::query("ALTER TABLE audit_log_offline RENAME TO audit_log")
            .execute(pool)
            .await
            .unwrap();
    }

    /// Polls `cond` for up to 5 s (background tasks in these tests).
    async fn eventually<F, Fut>(mut cond: F) -> bool
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        for _ in 0..100 {
            if cond().await {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    /// Stop the test when `record` does not return.
    ///
    /// The limit is a hang guard, not a latency bound. The spool file's
    /// `sync_all` takes seconds on Windows CI (#399).
    async fn assert_record_returns(svc: &AuditLogService, entry: AuditEntry<'_>) {
        assert!(
            tokio::time::timeout(Duration::from_secs(60), svc.record(entry))
                .await
                .is_ok(),
            "record did not return within the hang guard"
        );
    }

    /// A failing INSERT takes the error path when it fails, and does not
    /// wait out the configured timeout.
    ///
    /// The clock is paused, so this does not include the spool file's
    /// `sync_all`. `spooledReason` starting with `error:` would not catch a
    /// wait after the error. Elapsed time reaching `timeout` means the
    /// error path waited the limit out (#399).
    #[tokio::test(start_paused = true)]
    async fn failing_insert_does_not_wait_out_the_timeout() {
        let timeout = Duration::from_secs(2);
        let started = tokio::time::Instant::now();
        let insert = tokio::spawn(async { Err(BantoError::Other("no such table".into())) });
        let outcome = super::wait_for_insert(timeout, insert).await;
        assert_eq!(
            started.elapsed(),
            Duration::ZERO,
            "an immediate error must not wait"
        );
        assert_eq!(
            outcome,
            super::InsertWait::NeedsSpool("error: no such table".to_string())
        );

        // Fails 1 s into a 2 s timeout, and does not pad the remaining second.
        let fail_after = Duration::from_secs(1);
        let started = tokio::time::Instant::now();
        let insert = tokio::spawn(async move {
            tokio::time::sleep(fail_after).await;
            Err(BantoError::Other("no such table".into()))
        });
        let outcome = super::wait_for_insert(timeout, insert).await;
        assert_eq!(started.elapsed(), fail_after);
        assert!(started.elapsed() < timeout);
        assert_eq!(
            outcome,
            super::InsertWait::NeedsSpool("error: no such table".to_string())
        );
    }

    /// An INSERT that never answers becomes `timeout` at exactly `timeout`,
    /// and the task keeps running.
    ///
    /// The clock is paused, so this does not wait 2 real seconds. Returning
    /// early, sleeping past the timeout, or cancelling the task all fail
    /// here (#399).
    #[tokio::test(start_paused = true)]
    async fn hanging_insert_waits_exactly_the_timeout_and_keeps_running() {
        let timeout = Duration::from_secs(2);
        let (release, released) = tokio::sync::oneshot::channel();
        let (finished_tx, mut finished_rx) = tokio::sync::oneshot::channel();
        let insert = tokio::spawn(async move {
            let _ = released.await;
            let _ = finished_tx.send(());
            Ok(())
        });
        let started = tokio::time::Instant::now();
        let outcome = super::wait_for_insert(timeout, insert).await;
        assert_eq!(started.elapsed(), timeout);
        assert_eq!(
            outcome,
            super::InsertWait::NeedsSpool("timeout".to_string())
        );
        assert!(
            matches!(
                finished_rx.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ),
            "the insert is still running when the wait gives up"
        );
        release
            .send(())
            .expect("the timed-out insert is still running");
        finished_rx
            .await
            .expect("the timed-out insert should still finish");
    }

    /// A successful INSERT completes without waiting out the timeout.
    #[tokio::test(start_paused = true)]
    async fn successful_insert_returns_without_waiting() {
        let started = tokio::time::Instant::now();
        let insert = tokio::spawn(async { Ok(()) });
        let outcome = super::wait_for_insert(Duration::from_secs(2), insert).await;
        assert_eq!(started.elapsed(), Duration::ZERO);
        assert_eq!(outcome, super::InsertWait::Completed);
    }

    /// A panicked INSERT task is an error, not a timeout, and does not wait.
    #[tokio::test(start_paused = true)]
    async fn panicked_insert_is_an_error_not_a_timeout() {
        let started = tokio::time::Instant::now();
        let insert: tokio::task::JoinHandle<Result<(), BantoError>> =
            tokio::spawn(async { panic!("boom") });
        let outcome = super::wait_for_insert(Duration::from_secs(2), insert).await;
        assert_eq!(started.elapsed(), Duration::ZERO);
        let super::InsertWait::NeedsSpool(reason) = outcome else {
            panic!("expected an error reason, got {outcome:?}");
        };
        assert!(reason.starts_with("error: "), "{reason}");
        assert_ne!(reason, "timeout");
    }

    /// A failing write (the table is gone) is spooled at once; after the
    /// table comes back one flush writes exactly one row with the original
    /// `ts` and `detail.spooled = true`, and flushing again (or the same
    /// file reappearing, as with a second process) adds nothing.
    ///
    /// "At once" is checked two ways (#399). The configured timeout here is
    /// 30 s and `record` must return in under 30 s, so a regression that
    /// waits the timeout out, including one outside `wait_for_insert`,
    /// fails, while a slow spool-file `sync_all` (seconds on Windows CI)
    /// does not. [`failing_insert_does_not_wait_out_the_timeout`] pauses
    /// the clock and checks that the wait itself does not pad out to the
    /// timeout.
    #[tokio::test]
    async fn spool_round_trip_after_a_failing_write() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let spool_dir = tmp.path().join("spool");
        let svc = AuditLogService::new(db)
            .with_spool(&spool_dir, spool_config(30_000))
            .unwrap();

        take_offline(&pool).await;
        let started = Instant::now();
        assert_record_returns(&svc, sample_entry("create", "items", "admin")).await;
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(30),
            "an error through record must not wait out the configured timeout, got {elapsed:?}"
        );

        let files = spool_files(&spool_dir);
        assert_eq!(files.len(), 1);
        let spooled = read_spool_file(&spool_dir, &files[0]);
        let pending_id = spooled["pendingId"].as_str().unwrap().to_string();
        let ts = spooled["ts"].as_str().unwrap().to_string();
        assert_eq!(files[0], format!("{pending_id}.json"));
        assert_eq!(spooled["v"], 1);
        assert_eq!(spooled["action"], "create");
        assert_eq!(spooled["detail"], json!({ "name": "Widget" }));
        assert!(spooled["spooledReason"]
            .as_str()
            .unwrap()
            .starts_with("error: "));

        let backlog = svc.spool_backlog();
        assert_eq!(backlog.count, 1);
        assert_eq!(backlog.oldest_ts.as_deref(), Some(ts.as_str()));
        assert_eq!((backlog.dropped, backlog.failed), (0, 0));
        assert!(backlog.last_error.unwrap().starts_with("error: "));

        bring_back(&pool).await;
        assert_eq!(
            count_rows(&pool).await,
            0,
            "nothing was written while offline"
        );

        let report = svc.flush_spool().await.unwrap();
        assert_eq!(
            report,
            SpoolFlushReport {
                flushed: 1,
                remaining: 0,
                quarantined: 0,
                error: None
            }
        );
        let rows = audit_rows(&pool).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, ts, "the row keeps the time of the record call");
        assert_eq!(rows[0].1.as_deref(), Some(pending_id.as_str()));
        let detail: serde_json::Value =
            serde_json::from_str(rows[0].2.as_deref().unwrap()).unwrap();
        assert_eq!(detail, json!({ "name": "Widget", "spooled": true }));
        // Same text as the column DEFAULT `datetime('now')`.
        let normalized: String = sqlx::query_scalar("SELECT datetime(?)")
            .bind(&ts)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(normalized, ts);
        assert!(spool_files(&spool_dir).is_empty());
        assert_eq!(svc.spool_backlog(), SpoolBacklog::default());

        assert_eq!(
            svc.flush_spool().await.unwrap(),
            SpoolFlushReport::default()
        );
        // The same entry flushed again (another process had it too).
        std::fs::write(
            spool_dir.join(format!("{pending_id}.json")),
            serde_json::to_vec(&spooled).unwrap(),
        )
        .unwrap();
        assert_eq!(svc.flush_spool().await.unwrap().flushed, 1);
        assert_eq!(count_rows(&pool).await, 1, "still exactly one row");
    }

    /// A hanging write (every pool connection is held) is spooled after the
    /// timeout and not cancelled: once the connection is released the
    /// original INSERT completes, and the flush then finds its row by
    /// `pending_id` instead of writing a second one. The original INSERT's
    /// detail wins over the flush.
    ///
    /// Waiting exactly `timeout`, and not cancelling the INSERT, is
    /// [`hanging_insert_waits_exactly_the_timeout_and_keeps_running`] on a
    /// paused clock. The 60 s guard below only stops a real hang; it is not
    /// a latency bound. The old `< 2 s` bound included the spool file's
    /// `sync_all` and failed on Windows CI at 4.77 s (#399).
    ///
    /// The 200 ms timeout is only for the hang. The flush runs through a
    /// second service on the same spool directory with a long timeout (as
    /// another process would): with 200 ms the flush's own INSERT timed out
    /// on Windows CI and left the entry in the spool.
    #[tokio::test]
    async fn spool_after_a_hang_does_not_duplicate_the_late_insert() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 1, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let spool_dir = tmp.path().join("spool");
        let svc = AuditLogService::new(db.clone())
            .with_spool(&spool_dir, spool_config(200))
            .unwrap();

        let held = pool.acquire().await.unwrap();
        let started = Instant::now();
        assert_record_returns(&svc, sample_entry("create", "items", "admin")).await;
        // Real-time lower bound: the held connection must keep `record`
        // from returning before the timeout. Slowness cannot fail it.
        // An upper bound would include `sync_all` (#399).
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(200),
            "record must wait out the timeout while every connection is held, got {elapsed:?}"
        );
        assert_eq!(spool_files(&spool_dir).len(), 1);
        assert_eq!(svc.spool_backlog().last_error.as_deref(), Some("timeout"));

        drop(held);
        assert!(
            eventually(|| async { count_rows(&pool).await == 1 }).await,
            "the timed-out INSERT completes on its own"
        );

        let flusher = AuditLogService::new(db)
            .with_spool(&spool_dir, spool_config(30_000))
            .unwrap();
        let report = flusher.flush_spool().await.unwrap();
        assert_eq!((report.flushed, report.remaining), (1, 0));
        let rows = audit_rows(&pool).await;
        assert_eq!(rows.len(), 1, "the flush does not write a second row");
        let detail: serde_json::Value =
            serde_json::from_str(rows[0].2.as_deref().unwrap()).unwrap();
        assert_eq!(
            detail,
            json!({ "name": "Widget" }),
            "the late original won, not the flush"
        );
        assert!(spool_files(&spool_dir).is_empty());
    }

    /// Without a spool `record` is unchanged: it works on a database that
    /// never got migration `0008` (no `pending_id` column), and the spool
    /// API is inert.
    #[tokio::test]
    async fn without_a_spool_record_works_on_a_schema_without_pending_id() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, false).await;
        let pool = db.as_sqlite().unwrap().clone();
        let svc = AuditLogService::new(db);
        svc.record(sample_entry("create", "items", "admin")).await;
        svc.try_record(sample_entry("update", "items", "admin"))
            .await
            .unwrap();
        assert_eq!(count_rows(&pool).await, 2);
        assert_eq!(svc.spool_backlog(), SpoolBacklog::default());
        assert_eq!(
            svc.flush_spool().await.unwrap(),
            SpoolFlushReport::default()
        );
        assert!(svc.spawn_spool_flusher().is_none());

        // A failure is still only logged (nothing to spool to).
        take_offline(&pool).await;
        svc.record(sample_entry("delete", "items", "admin")).await;
        bring_back(&pool).await;
        assert_eq!(count_rows(&pool).await, 2);
    }

    /// `try_record` never spools: its caller sees the error.
    #[tokio::test]
    async fn try_record_does_not_spool() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let spool_dir = tmp.path().join("spool");
        let svc = AuditLogService::new(db)
            .with_spool(&spool_dir, spool_config(2_000))
            .unwrap();
        take_offline(&pool).await;
        assert!(svc
            .try_record(sample_entry("create", "items", "admin"))
            .await
            .is_err());
        assert!(spool_files(&spool_dir).is_empty());
    }

    /// `.tmp` files are never read (a stale one is removed, a fresh one is
    /// left for its writer), unreadable files are quarantined without
    /// blocking the valid one, and entries flush oldest first.
    #[tokio::test]
    async fn flush_skips_tmp_files_and_quarantines_unreadable_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let spool_dir = tmp.path().join("spool");
        let svc = AuditLogService::new(db)
            .with_spool(&spool_dir, spool_config(2_000))
            .unwrap();

        let entry = |id: &str, ts: &str, action: &str| {
            json!({
                "v": 1, "pendingId": id, "ts": ts, "actorUsername": "admin",
                "actorRole": "admin", "action": action, "resource": "items",
                "entityId": null, "detail": null, "origin": "rest", "result": "ok",
                "spooledReason": "timeout"
            })
        };
        let write = |name: String, value: &serde_json::Value| {
            std::fs::write(spool_dir.join(name), serde_json::to_vec(value).unwrap()).unwrap();
        };
        let newer = uuid::Uuid::new_v4().to_string();
        let older = uuid::Uuid::new_v4().to_string();
        write(
            format!("{newer}.json"),
            &entry(&newer, "2026-10-10 10:00:02", "second"),
        );
        write(
            format!("{older}.json"),
            &entry(&older, "2026-10-10 10:00:01", "first"),
        );
        // Corrupt JSON, and a valid entry under another file name.
        let corrupt = uuid::Uuid::new_v4().to_string();
        std::fs::write(spool_dir.join(format!("{corrupt}.json")), b"{not json").unwrap();
        let renamed = uuid::Uuid::new_v4().to_string();
        write(
            format!("{renamed}.json"),
            &entry(
                &uuid::Uuid::new_v4().to_string(),
                "2026-10-10 10:00:00",
                "x",
            ),
        );
        // A write in progress, and one interrupted long ago.
        let fresh = uuid::Uuid::new_v4().to_string();
        write(
            format!("{fresh}.json.tmp"),
            &entry(&fresh, "2026-10-10 09:00:00", "tmp"),
        );
        let stale = uuid::Uuid::new_v4().to_string();
        write(
            format!("{stale}.json.tmp"),
            &entry(&stale, "2026-10-10 09:00:00", "tmp"),
        );
        std::fs::File::options()
            .write(true)
            .open(spool_dir.join(format!("{stale}.json.tmp")))
            .unwrap()
            .set_modified(std::time::SystemTime::now() - Duration::from_secs(3600))
            .unwrap();

        let report = svc.flush_spool().await.unwrap();
        assert_eq!(
            report,
            SpoolFlushReport {
                flushed: 2,
                remaining: 0,
                quarantined: 2,
                error: None
            }
        );
        let actions: Vec<String> = sqlx::query_scalar("SELECT action FROM audit_log ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(actions, vec!["first", "second"], "oldest first");
        let rows = audit_rows(&pool).await;
        assert_eq!(rows[0].2.as_deref(), Some(r#"{"spooled":true}"#));

        let mut quarantined: Vec<String> = std::fs::read_dir(spool_dir.join("quarantine"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        quarantined.sort();
        let mut expected = vec![format!("{corrupt}.json"), format!("{renamed}.json")];
        expected.sort();
        assert_eq!(quarantined, expected);
        assert!(spool_dir.join(format!("{fresh}.json.tmp")).exists());
        assert!(!spool_dir.join(format!("{stale}.json.tmp")).exists());
        assert!(spool_files(&spool_dir).is_empty());
    }

    /// Beyond `max_files` an entry is dropped and counted, not written.
    #[tokio::test]
    async fn a_full_spool_drops_and_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let spool_dir = tmp.path().join("spool");
        let svc = AuditLogService::new(db)
            .with_spool(
                &spool_dir,
                SpoolConfig {
                    max_files: 2,
                    ..spool_config(2_000)
                },
            )
            .unwrap();

        take_offline(&pool).await;
        for action in ["a", "b", "c"] {
            svc.record(sample_entry(action, "items", "admin")).await;
        }
        assert_eq!(spool_files(&spool_dir).len(), 2);
        let backlog = svc.spool_backlog();
        assert_eq!((backlog.count, backlog.dropped, backlog.failed), (2, 1, 0));

        bring_back(&pool).await;
        assert_eq!(svc.flush_spool().await.unwrap().flushed, 2);
        assert_eq!(count_rows(&pool).await, 2);
        let backlog = svc.spool_backlog();
        assert_eq!(
            (backlog.count, backlog.dropped),
            (0, 1),
            "dropped stays counted"
        );
        assert_eq!(backlog.last_error, None);
    }

    /// Entries left by an earlier run are loaded when the spool is opened;
    /// a second service on the same directory (another process) flushes
    /// them, and the first one's next flush forgets what is gone.
    #[tokio::test]
    async fn a_reopened_spool_sees_and_flushes_earlier_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let spool_dir = tmp.path().join("spool");
        let first = AuditLogService::new(db.clone())
            .with_spool(&spool_dir, spool_config(2_000))
            .unwrap();
        take_offline(&pool).await;
        first.record(sample_entry("create", "items", "admin")).await;
        bring_back(&pool).await;

        let second = AuditLogService::new(db)
            .with_spool(&spool_dir, spool_config(2_000))
            .unwrap();
        let backlog = second.spool_backlog();
        assert_eq!(backlog.count, 1);
        assert_eq!(backlog.oldest_ts, first.spool_backlog().oldest_ts);
        assert_eq!(second.flush_spool().await.unwrap().flushed, 1);

        assert_eq!(first.spool_backlog().count, 1, "not seen yet");
        assert_eq!(
            first.flush_spool().await.unwrap(),
            SpoolFlushReport::default()
        );
        assert_eq!(first.spool_backlog().count, 0);
        assert_eq!(count_rows(&pool).await, 1);
    }

    /// A successful `record` while entries are waiting flushes them in the
    /// background.
    #[tokio::test]
    async fn a_successful_record_flushes_the_backlog() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let spool_dir = tmp.path().join("spool");
        let svc = AuditLogService::new(db)
            .with_spool(&spool_dir, spool_config(2_000))
            .unwrap();
        take_offline(&pool).await;
        svc.record(sample_entry("create", "items", "admin")).await;
        bring_back(&pool).await;

        svc.record(sample_entry("update", "items", "admin")).await;
        assert!(eventually(|| async { svc.spool_backlog().count == 0 }).await);
        assert_eq!(count_rows(&pool).await, 2);
        assert!(spool_files(&spool_dir).is_empty());
    }

    /// The periodic flusher drains the backlog once the database is back.
    #[tokio::test]
    async fn the_periodic_flusher_drains_the_backlog() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let spool_dir = tmp.path().join("spool");
        let svc = AuditLogService::new(db)
            .with_spool(
                &spool_dir,
                SpoolConfig {
                    flush_interval: Duration::from_millis(50),
                    ..spool_config(2_000)
                },
            )
            .unwrap();
        take_offline(&pool).await;
        svc.record(sample_entry("create", "items", "admin")).await;
        let flusher = svc.spawn_spool_flusher().expect("a spool is configured");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(svc.spool_backlog().count, 1, "still offline");

        bring_back(&pool).await;
        assert!(eventually(|| async { svc.spool_backlog().count == 0 }).await);
        assert_eq!(count_rows(&pool).await, 1);
        flusher.abort();
    }

    /// Two services (processes) share one spool directory and are both built
    /// while it is empty. During an outage only B records, so only B's index
    /// knows the entry; B then goes away. A's periodic flusher alone must
    /// find B's file on disk (A's own count is 0) and write it exactly once.
    #[tokio::test]
    async fn the_periodic_flusher_finds_entries_spooled_by_another_process() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let spool_dir = tmp.path().join("spool");
        let config = SpoolConfig {
            flush_interval: Duration::from_millis(50),
            ..spool_config(2_000)
        };
        let a = AuditLogService::new(db.clone())
            .with_spool(&spool_dir, config)
            .unwrap();
        let b = AuditLogService::new(db)
            .with_spool(&spool_dir, config)
            .unwrap();

        take_offline(&pool).await;
        b.record(sample_entry("create", "items", "admin")).await;
        assert_eq!(spool_files(&spool_dir).len(), 1);
        assert_eq!(a.spool_backlog().count, 0, "A never saw it");
        drop(b);
        bring_back(&pool).await;

        let flusher = a.spawn_spool_flusher().expect("a spool is configured");
        assert!(
            eventually(|| async { count_rows(&pool).await == 1 }).await,
            "A's periodic flusher writes B's entry"
        );
        assert!(eventually(|| async { spool_files(&spool_dir).is_empty() }).await);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(count_rows(&pool).await, 1, "exactly once");
        assert_eq!(a.spool_backlog().count, 0);
        flusher.abort();
    }

    /// A successful `record` also looks at the directory once it has not
    /// been scanned for `flush_interval`, so another process's entries are
    /// picked up even without the periodic flusher.
    #[tokio::test]
    async fn a_successful_record_rescans_a_stale_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let spool_dir = tmp.path().join("spool");
        let config = SpoolConfig {
            flush_interval: Duration::from_millis(50),
            ..spool_config(2_000)
        };
        let a = AuditLogService::new(db.clone())
            .with_spool(&spool_dir, config)
            .unwrap();
        let b = AuditLogService::new(db)
            .with_spool(&spool_dir, config)
            .unwrap();
        take_offline(&pool).await;
        b.record(sample_entry("create", "items", "admin")).await;
        drop(b);
        bring_back(&pool).await;

        tokio::time::sleep(Duration::from_millis(100)).await;
        a.record(sample_entry("update", "items", "admin")).await;
        assert!(eventually(|| async { count_rows(&pool).await == 2 }).await);
        assert!(eventually(|| async { spool_files(&spool_dir).is_empty() }).await);
    }

    #[test]
    fn spooled_detail_merges_into_objects_and_wraps_the_rest() {
        assert_eq!(spooled_detail(None), json!({ "spooled": true }));
        assert_eq!(
            spooled_detail(Some(&json!({ "a": 1 }))),
            json!({ "a": 1, "spooled": true })
        );
        assert_eq!(
            spooled_detail(Some(&json!([1, 2]))),
            json!({ "value": [1, 2], "spooled": true })
        );
    }

    #[test]
    fn pending_ts_matches_each_default_format() {
        let t = std::time::UNIX_EPOCH + Duration::from_micros(1_791_590_400_123_456);
        assert_eq!(pending_ts(Dialect::Sqlite, t), "2026-10-10 00:00:00");
        assert_eq!(
            pending_ts(Dialect::Postgres, t),
            "2026-10-10 00:00:00.123456+00"
        );
        // Fixed instants with trailing zeros: the bound text always has six
        // digits (PostgreSQL parses it; the stored text is PostgreSQL's own
        // output, see `pg_audit_spool_ts_matches_the_default_text_*`).
        let t = std::time::UNIX_EPOCH + Duration::from_micros(1_791_590_400_070_250);
        assert_eq!(pending_ts(Dialect::Sqlite, t), "2026-10-10 00:00:00");
        assert_eq!(
            pending_ts(Dialect::Postgres, t),
            "2026-10-10 00:00:00.070250+00"
        );
        let t = std::time::UNIX_EPOCH + Duration::from_secs(1_791_590_399);
        assert_eq!(pending_ts(Dialect::Sqlite, t), "2026-10-09 23:59:59");
        assert_eq!(
            pending_ts(Dialect::Postgres, t),
            "2026-10-09 23:59:59.000000+00"
        );
    }

    // --- spool on PostgreSQL (skipped unless BANTO_TEST_PG_URL is set) --------

    /// A service on its own schema (selected through `search_path`, same
    /// pattern as `users`' `pg_concurrent_setup_*`) with the PostgreSQL DDL
    /// of `0005_audit_log.sql` + `0008_audit_log_pending_id.sql`. Returns the
    /// admin handle (to drop the schema) and the scoped one.
    #[cfg(feature = "postgres")]
    async fn pg_scoped(url: &str, schema: &str) -> (Db, Db) {
        let admin = Db::connect_postgres(url).await.unwrap();
        let pool = admin.as_postgres().unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA IF EXISTS {schema} CASCADE"
        )))
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
            .execute(pool)
            .await
            .unwrap();
        let sep = if url.contains('?') { '&' } else { '?' };
        let scoped =
            Db::connect_postgres(&format!("{url}{sep}options=-c%20search_path%3D{schema}"))
                .await
                .unwrap();
        let p = scoped.as_postgres().unwrap();
        for ddl in [
            "CREATE TABLE audit_log (
                id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                ts TEXT NOT NULL DEFAULT (now()::text),
                actor_username TEXT,
                actor_role TEXT,
                action TEXT NOT NULL,
                resource TEXT NOT NULL,
                entity_id TEXT,
                detail TEXT,
                origin TEXT NOT NULL,
                result TEXT NOT NULL DEFAULT 'ok'
            )",
            "ALTER TABLE audit_log ADD COLUMN pending_id TEXT",
            "CREATE UNIQUE INDEX idx_audit_log_pending_id ON audit_log(pending_id)",
        ] {
            sqlx::query(ddl).execute(p).await.unwrap();
        }
        (admin, scoped)
    }

    #[cfg(feature = "postgres")]
    async fn pg_drop_schema(admin: &Db, schema: &str) {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA IF EXISTS {schema} CASCADE"
        )))
        .execute(admin.as_postgres().unwrap())
        .await
        .unwrap();
    }

    #[cfg(feature = "postgres")]
    async fn pg_count(db: &Db) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
            .fetch_one(db.as_postgres().unwrap())
            .await
            .unwrap()
    }

    /// The failing-write round trip on PostgreSQL, including the `ts` text
    /// (what `now()::text` would have written for that instant).
    #[cfg(feature = "postgres")]
    #[tokio::test]
    async fn pg_audit_spool_round_trip_after_a_failing_write() {
        let Ok(url) = std::env::var("BANTO_TEST_PG_URL") else {
            return;
        };
        let schema = format!("banto_437a_{}", std::process::id());
        let (admin, db) = pg_scoped(&url, &schema).await;
        let pool = db.as_postgres().unwrap().clone();
        let tmp = tempfile::tempdir().unwrap();
        let spool_dir = tmp.path().join("spool");
        let svc = AuditLogService::new(db.clone())
            .with_spool(&spool_dir, spool_config(2_000))
            .unwrap();

        sqlx::query("ALTER TABLE audit_log RENAME TO audit_log_offline")
            .execute(&pool)
            .await
            .unwrap();
        svc.record(sample_entry("create", "items", "admin")).await;
        let files = spool_files(&spool_dir);
        assert_eq!(files.len(), 1);
        let spooled = read_spool_file(&spool_dir, &files[0]);
        let ts = spooled["ts"].as_str().unwrap().to_string();
        sqlx::query("ALTER TABLE audit_log_offline RENAME TO audit_log")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(pg_count(&db).await, 0);

        assert_eq!(svc.flush_spool().await.unwrap().flushed, 1);
        let (row_ts, pending_id, detail): (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT ts, pending_id, detail FROM audit_log")
                .fetch_one(&pool)
                .await
                .unwrap();
        let expected: String = sqlx::query_scalar("SELECT CAST(CAST($1 AS timestamptz) AS text)")
            .bind(&ts)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row_ts, expected);
        assert_eq!(
            pending_id,
            spooled["pendingId"].as_str().map(str::to_string)
        );
        let detail: serde_json::Value = serde_json::from_str(detail.as_deref().unwrap()).unwrap();
        assert_eq!(detail, json!({ "name": "Widget", "spooled": true }));

        assert_eq!(
            svc.flush_spool().await.unwrap(),
            SpoolFlushReport::default()
        );
        std::fs::write(
            spool_dir.join(&files[0]),
            serde_json::to_vec(&spooled).unwrap(),
        )
        .unwrap();
        assert_eq!(svc.flush_spool().await.unwrap().flushed, 1);
        assert_eq!(pg_count(&db).await, 1);
        pg_drop_schema(&admin, &schema).await;
    }

    /// The hang on PostgreSQL: another transaction holds an exclusive lock
    /// on `audit_log`, so the INSERT waits; `record` spools after the
    /// timeout, the INSERT completes once the lock is released, and the
    /// flush does not add a second row.
    #[cfg(feature = "postgres")]
    #[tokio::test]
    async fn pg_audit_spool_after_a_hang_does_not_duplicate_the_late_insert() {
        let Ok(url) = std::env::var("BANTO_TEST_PG_URL") else {
            return;
        };
        let schema = format!("banto_437b_{}", std::process::id());
        let (admin, db) = pg_scoped(&url, &schema).await;
        let pool = db.as_postgres().unwrap().clone();
        let tmp = tempfile::tempdir().unwrap();
        let spool_dir = tmp.path().join("spool");
        let svc = AuditLogService::new(db.clone())
            .with_spool(&spool_dir, spool_config(300))
            .unwrap();

        let mut lock = pool.begin().await.unwrap();
        sqlx::query("LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *lock)
            .await
            .unwrap();
        let started = Instant::now();
        svc.record(sample_entry("create", "items", "admin")).await;
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(spool_files(&spool_dir).len(), 1);
        assert_eq!(svc.spool_backlog().last_error.as_deref(), Some("timeout"));
        lock.rollback().await.unwrap();

        assert!(eventually(|| async { pg_count(&db).await == 1 }).await);
        assert_eq!(svc.flush_spool().await.unwrap().flushed, 1);
        assert_eq!(
            pg_count(&db).await,
            1,
            "the flush does not write a second row"
        );
        pg_drop_schema(&admin, &schema).await;
    }

    /// The `ts` text the pending INSERT stores is exactly what the column
    /// DEFAULT (`now()::text`, a `timestamptz` cast to `text`) produces for
    /// the same instant, in the session's time zone - including fractional
    /// seconds with trailing zeros (`.070250` is written `.07025`) and none
    /// (`.000000` has no fraction). The reference instant is built in SQL
    /// from integer seconds + microseconds, so it is exact (no clock, no
    /// float rounding).
    #[cfg(feature = "postgres")]
    #[tokio::test]
    async fn pg_audit_spool_ts_matches_the_default_text_for_the_same_instant() {
        let Ok(url) = std::env::var("BANTO_TEST_PG_URL") else {
            return;
        };
        let db = Db::connect_postgres(&url).await.unwrap();
        let mut conn = db.as_postgres().unwrap().acquire().await.unwrap();
        let cases: [(u64, u32, &str); 3] = [
            (1_791_590_400, 70_250, "2026-10-10 00:00:00.07025+00"),
            (1_791_590_400, 0, "2026-10-10 00:00:00+00"),
            (1_791_590_399, 123_456, "2026-10-09 23:59:59.123456+00"),
        ];
        for tz in ["UTC", "Asia/Tokyo"] {
            sqlx::query(sqlx::AssertSqlSafe(format!("SET TIME ZONE '{tz}'")))
                .execute(&mut *conn)
                .await
                .unwrap();
            for (secs, micros, utc_text) in cases {
                let t = std::time::UNIX_EPOCH
                    + Duration::from_secs(secs)
                    + Duration::from_micros(u64::from(micros));
                let ours = pending_ts(Dialect::Postgres, t);
                let (stored, default_text): (String, String) = sqlx::query_as(
                    "SELECT CAST(CAST($1 AS timestamptz) AS text),                      CAST(to_timestamp($2::bigint) + $3::bigint * INTERVAL '1 microsecond' AS text)",
                )
                .bind(&ours)
                .bind(secs as i64)
                .bind(i64::from(micros))
                .fetch_one(&mut *conn)
                .await
                .unwrap();
                assert_eq!(stored, default_text, "{tz}: {ours}");
                if tz == "UTC" {
                    assert_eq!(stored, utc_text);
                }
            }
        }
    }

    // --- log sink (with_log_sink) ---------------------------------------------

    type Lines = Arc<std::sync::Mutex<Vec<String>>>;

    fn collecting_sink() -> (Lines, impl Fn(&str) + Send + Sync + 'static) {
        let lines: Lines = Arc::default();
        let sink = lines.clone();
        (lines, move |line: &str| {
            sink.lock().unwrap().push(line.to_string())
        })
    }

    fn has_line(lines: &Lines, needle: &str) -> bool {
        lines.lock().unwrap().iter().any(|l| l.contains(needle))
    }

    /// Spooling and flushing log through the sink, with the `banto: ` text.
    #[tokio::test]
    async fn log_sink_receives_spooled_and_flushed_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let (lines, sink) = collecting_sink();
        let svc = AuditLogService::new(db)
            .with_spool(tmp.path().join("spool"), spool_config(2_000))
            .unwrap()
            .with_log_sink(sink);

        take_offline(&pool).await;
        svc.record(sample_entry("create", "items", "admin")).await;
        assert!(has_line(&lines, "保留ファイルに退避しました"));
        assert!(lines
            .lock()
            .unwrap()
            .iter()
            .all(|l| l.starts_with("banto: ")));

        bring_back(&pool).await;
        assert_eq!(svc.flush_spool().await.unwrap().flushed, 1);
        assert!(has_line(&lines, "流し込みました"));
    }

    /// The public `AuditLogSink` type can be stored, cloned and passed
    /// straight to `with_shared_log_sink` (it cannot go to `with_log_sink`).
    #[tokio::test]
    async fn shared_log_sink_accepts_the_public_type() {
        let lines: Lines = Arc::default();
        let store = lines.clone();
        let sink: AuditLogSink = Arc::new(move |l: &str| store.lock().unwrap().push(l.to_string()));
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let svc = AuditLogService::new(db)
            .with_spool(tmp.path().join("spool"), spool_config(2_000))
            .unwrap()
            .with_shared_log_sink(sink.clone());
        take_offline(&pool).await;
        svc.record(sample_entry("create", "items", "admin")).await;
        assert!(has_line(&lines, "保留ファイルに退避しました"));
    }

    /// The sink works whether it is set before or after `with_spool`.
    #[tokio::test]
    async fn log_sink_works_before_and_after_with_spool() {
        for sink_first in [true, false] {
            let tmp = tempfile::tempdir().unwrap();
            let db = file_db(tmp.path(), 4, true).await;
            let pool = db.as_sqlite().unwrap().clone();
            let (lines, sink) = collecting_sink();
            let spool_dir = tmp.path().join("spool");
            let svc = if sink_first {
                AuditLogService::new(db)
                    .with_log_sink(sink)
                    .with_spool(&spool_dir, spool_config(2_000))
                    .unwrap()
            } else {
                AuditLogService::new(db)
                    .with_spool(&spool_dir, spool_config(2_000))
                    .unwrap()
                    .with_log_sink(sink)
            };
            take_offline(&pool).await;
            svc.record(sample_entry("create", "items", "admin")).await;
            assert!(
                has_line(&lines, "保留ファイルに退避しました"),
                "sink_first={sink_first}"
            );
        }
    }

    /// Without a spool the `record` failure goes to the sink too.
    #[tokio::test]
    async fn log_sink_receives_the_record_failure_without_a_spool() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let (lines, sink) = collecting_sink();
        let svc = AuditLogService::new(db).with_log_sink(sink);
        take_offline(&pool).await;
        svc.record(sample_entry("create", "items", "admin")).await;
        assert!(has_line(&lines, "監査ログの記録に失敗しました"));
    }

    /// A drop on a full spool reaches the sink.
    #[tokio::test]
    async fn log_sink_receives_the_dropped_line() {
        let tmp = tempfile::tempdir().unwrap();
        let db = file_db(tmp.path(), 4, true).await;
        let pool = db.as_sqlite().unwrap().clone();
        let (lines, sink) = collecting_sink();
        let svc = AuditLogService::new(db)
            .with_spool(
                tmp.path().join("spool"),
                SpoolConfig {
                    max_files: 1,
                    ..spool_config(2_000)
                },
            )
            .unwrap()
            .with_log_sink(sink);
        take_offline(&pool).await;
        svc.record(sample_entry("a", "items", "admin")).await;
        svc.record(sample_entry("b", "items", "admin")).await;
        assert!(has_line(&lines, "記録を破棄しました"));
    }
}
