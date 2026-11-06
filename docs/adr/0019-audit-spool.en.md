# ADR-0019: Spool an audit entry the database cannot take to a file, and flush it exactly once by `pending_id` after recovery

> 日本語: [0019-audit-spool.md](0019-audit-spool.md)

- Status: Accepted
- Date: 2026-10-10
- Related: tyaro/banto-industrial#437 / [conventions.md](../conventions.en.md) §1, §3, §6, §11 /
  [ADR-0002](0002-minimal-dependencies.en.md), [ADR-0004](0004-server-logging-eprintln.en.md) /
  `crates/banto-admin-services/src/audit.rs` (its module doc is the primary source for the implementation)

## Context

`AuditLogService::record` must never fail the operation it audits, so it logged a failed write
(`eprintln`) and dropped the entry (spec M14). Audit entries written while the database was down or
waiting on a lock were lost, and when the database did not answer at all `record` did not return,
holding up the operation itself (the REST response or the Tauri command). banto-industrial (#437)
needs to avoid "the operation happened but left no audit row", e.g. for writes to a PLC.

Two requirements:

- Do not lose the audit row when the database fails or hangs (it must reach `audit_log` later).
- Do not hold up the request meanwhile (`record` returns within a bounded time).

## Decision

Add an **opt-in spool** to `banto-admin-services`' `AuditLogService` (owner decision 2026-10-10).

1. **It lives in banto** (`banto-admin-services`): the audit log is part of the base, so derived
   apps do not each build one.
2. **Opt-in**: `AuditLogService::new(db)` is unchanged; `.with_spool(dir, SpoolConfig)` turns it on.
   Without it `record` behaves exactly as before (no timeout, no `pending_id`, `ts` from the column
   default).
3. **Migration `0008_audit_log_pending_id.sql`** (SQLite and PostgreSQL) adds
   `audit_log.pending_id TEXT` and the unique index `idx_audit_log_pending_id`. NULLs never conflict,
   so rows that do not go through the spool (`try_record`, `record` without a spool, existing rows)
   stay NULL.
4. **With a spool, `record` fixes a UUIDv4 `pending_id` and the `ts` (the time of the call) before
   writing.** The INSERT is `ON CONFLICT (pending_id) DO NOTHING`, and the flush runs the same INSERT
   with the same `pending_id` and `ts`, so a timed-out INSERT that completes later and the flush still
   leave one row. `ts` has each database's default format (SQLite `datetime('now')`,
   `YYYY-MM-DD HH:MM:SS` UTC; PostgreSQL the UTC time cast through `timestamptz` to `text`, the same
   format as `now()::text`).
5. **Scope: every audit entry that goes through `record`.** `try_record` (for callers that want the
   operation to fail when the audit write does) never spools.
6. **Timeout 3 s by default** (`SpoolConfig::timeout`). On an error or a timeout the entry is written
   to the spool and `record` returns. A timed-out INSERT is **not cancelled** (it runs on in a
   separate task).
7. **At most 10,000 spooled entries by default** (`SpoolConfig::max_files`). Beyond that an entry is
   dropped, counted (`SpoolBacklog::dropped`) and logged. An entry whose spool file cannot be written
   is counted too (`SpoolBacklog::failed`).
8. **One file per entry** (`<dir>/<pending_id>.json`), written as `.json.tmp`, `sync_all`, then
   renamed. `.tmp` files are never read (a flush removes those older than 60 s). An unreadable file is
   moved to `<dir>/quarantine/` without blocking the others.
9. **The flush** goes oldest first (`ts`, then `pending_id`) and removes each file once its row is in
   (a missing file is fine). One flush at a time per service; several processes flushing one
   directory still leave one row thanks to `ON CONFLICT`. Triggers: `flush_spool()` called by the app
   at startup, a successful `record` (when this process has entries waiting, or has not read the
   spool directory for `flush_interval`), and the periodic task of `spawn_spool_flusher()` (30 s by
   default). The periodic task **reads the directory every time, even when this process's own
   backlog is empty**: entries spooled by another process sharing the directory, which then exited,
   never show up in this process's in-memory count (added after the 2026-10-10 owner review; one
   directory read per interval, and nothing is logged when it is empty). A successful `record`
   rescans at most once per `flush_interval` so that writes do not each read the directory.
10. **Flushed rows carry `detail.spooled = true`** (added to an object `detail`; any other `detail`
    is wrapped as `{"value": <original detail>, "spooled": true}`).
11. **No HMAC or other tamper detection**: whoever can write the data directory can write the SQLite
    file directly, so protecting only the spool would not protect anything.
12. **Retention pruning** (`prune`) judges flushed rows by their `ts` too. A row whose `ts` is
    already older than the retention period may be deleted right after the flush (`ts` is the time
    of the operation, so this is correct).
13. The state is visible through `spool_backlog()` (count, oldest `ts`, `dropped`, `failed`, last
    error). Spooling and flushing each log one `eprintln` line (ADR-0004). An app with no stderr (a Windows
    service) can route these lines (and the `record` failure) to its own log with
    `AuditLogService::with_log_sink`, called before or after `with_spool` (`with_shared_log_sink` takes an already-shared `AuditLogSink`); the default stays
    `eprintln`, and no `tracing` is added.
14. Applying it to banto-industrial's ChronoGazer comes later.

## Alternatives considered

- **Option A (adopted)**: a unique index on `pending_id` + `ON CONFLICT DO NOTHING` + one file per
  entry. Pros: a timed-out INSERT need not be cancelled, and completing late does not duplicate the
  row; safe across processes; files appear atomically and one broken file does not block the rest.
  Cons: one more migration, which derived apps have to take in (path C).
- **Option B (rejected)**: cancel the INSERT on timeout and treat the spool as the only truth. Whether
  the cancellation took effect in the database is unknowable (it may have committed and only the
  answer was late), so rows could be duplicated or lost.
- **Option C (rejected)**: no migration; on flush, look for "a row with the same content" to avoid a
  duplicate. Cannot tell it apart from two legitimate rows of the same user doing the same thing in
  the same second.
- **Option D (rejected)**: append to one file (JSON Lines). Partially written lines, concurrent
  writers and tracking the flushed position are all harder.
- **Option E (rejected)**: an HMAC on spool files. Nothing to protect, see decision 11.
- **Option F (rejected)**: a timeout even without a spool. It would stop the wait but only lose more
  audit entries. Apps without a spool keep their behavior.

## Consequences

- An app that uses the spool **takes in migration 0008**. Enabling the spool without it makes every
  INSERT fail into the spool, and no flush succeeds.
- The app wires three calls: `with_spool(dir, config)` (one directory per database), `flush_spool()`
  at startup (after the migrations), and `spawn_spool_flusher()` (abort the handle at shutdown).
- In the audit log viewer a flushed row has a newer `id` but an older `ts`, so the `ts` order and the
  `id` order no longer match (the bounded list of ADR-0015 cuts by `id`, so a flushed row shows up in
  the next generation).
- The spool directory holds audit content itself (including `detail`), so protect it like the data
  directory (and, per conventions §6, `detail` never carries secrets).
- Tests live in `crates/banto-admin-services/src/audit.rs` (`spool_*`, `pg_audit_spool_*`: failure =
  renamed table, hang = held connection / exclusive lock). CI's app-postgres job runs the PostgreSQL
  ones.
