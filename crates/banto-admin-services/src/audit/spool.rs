//! The audit spool (ADR-0019, tyaro/banto-industrial#437): entries that
//! [`super::AuditLogService::record`] could not write to the database (an
//! error, or no answer within [`SpoolConfig::timeout`]) are kept as one file
//! each and flushed into `audit_log` later, exactly once.
//!
//! Layout: `<dir>/<pending_id>.json`, one entry per file, written as
//! `<pending_id>.json.tmp` -> `sync_all` -> rename, so a reader never sees a
//! half-written `.json`. `.tmp` files are never read; a flush removes the ones
//! older than [`STALE_TMP_AGE`] (a crash between the write and the rename).
//! A `.json` that does not parse, has an unknown version, or whose
//! `pendingId` is not its own file name is moved to `<dir>/quarantine/` and
//! never blocks the others. File names are generated here (UUIDv4) - no
//! caller input ever reaches a path (conventions §6).
//!
//! The in-memory index (`pending_id -> ts`) answers the backlog and the cap
//! without touching the disk. It is filled from the directory when the spool
//! is opened, updated by every spool write / flushed entry, and reconciled
//! with the directory by every flush (another process sharing the directory
//! may have flushed or spooled entries in between).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use banto_core::BantoError;
use serde::{Deserialize, Serialize};

use super::AuditLogSink;

/// A `.tmp` file older than this is a leftover of an interrupted write and is
/// removed by a flush. Younger ones may be a write in progress (this process
/// or another one sharing the directory) and are left alone.
pub(super) const STALE_TMP_AGE: Duration = Duration::from_secs(60);

/// The spool file format version (`v`). A file with another version is
/// quarantined, not guessed at.
const FORMAT_VERSION: u32 = 1;

const QUARANTINE_DIR: &str = "quarantine";

/// Spool settings for [`super::AuditLogService::with_spool`].
///
/// Build it from [`SpoolConfig::default`] and override what differs:
/// `SpoolConfig { timeout: Duration::from_secs(1), ..Default::default() }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpoolConfig {
    /// How long [`super::AuditLogService::record`] waits for the INSERT
    /// before spooling the entry and returning (default 3 s). The INSERT is
    /// not cancelled: it keeps running in the background and, if it completes
    /// later, the flush finds the row already there (`pending_id`).
    pub timeout: Duration,
    /// The most entries the spool holds (default 10,000). An entry beyond it
    /// is dropped, counted in [`SpoolBacklog::dropped`] and logged.
    pub max_files: usize,
    /// The period of [`super::AuditLogService::spawn_spool_flusher`]
    /// (default 30 s): each tick reads the directory and flushes what it
    /// finds, including entries another process spooled. Also the longest a
    /// successful `record` goes without rescanning the directory.
    pub flush_interval: Duration,
}

impl Default for SpoolConfig {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(3),
            max_files: 10_000,
            flush_interval: Duration::from_secs(30),
        }
    }
}

/// The spool's state as seen by this process
/// ([`super::AuditLogService::spool_backlog`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolBacklog {
    /// Entries waiting to be flushed.
    pub count: u64,
    /// The `ts` of the oldest waiting entry (same text as `audit_log.ts`).
    pub oldest_ts: Option<String>,
    /// Entries lost because the spool was full ([`SpoolConfig::max_files`]),
    /// since this service was built.
    pub dropped: u64,
    /// Entries lost because writing the spool file failed too, since this
    /// service was built.
    pub failed: u64,
    /// The last reason an entry was spooled, a flush stopped, or an entry was
    /// lost. Cleared by a flush that leaves the backlog empty.
    pub last_error: Option<String>,
}

/// What one [`super::AuditLogService::flush_spool`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolFlushReport {
    /// Entries written to `audit_log` (or found already there) and removed
    /// from the spool.
    pub flushed: u64,
    /// Entries still waiting after this flush.
    pub remaining: u64,
    /// Unreadable files moved to `<dir>/quarantine/` by this flush.
    pub quarantined: u64,
    /// Why the flush stopped early (the database still failing or hanging),
    /// if it did. The entries not reached stay in the spool.
    pub error: Option<String>,
}

/// One spooled entry: the owned form of an `AuditEntry` plus the
/// `pending_id`/`ts` fixed when it was recorded. Also the spool file's JSON
/// (`camelCase`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingEntry {
    pub v: u32,
    pub pending_id: String,
    pub ts: String,
    pub actor_username: Option<String>,
    pub actor_role: Option<String>,
    pub action: String,
    pub resource: String,
    pub entity_id: Option<String>,
    pub detail: Option<serde_json::Value>,
    pub origin: String,
    pub result: String,
    /// `"timeout"` or `"error: <message>"`. Empty until the entry is spooled.
    #[serde(default)]
    pub spooled_reason: String,
}

impl PendingEntry {
    pub fn new(entry: &super::AuditEntry<'_>, pending_id: String, ts: String) -> Self {
        Self {
            v: FORMAT_VERSION,
            pending_id,
            ts,
            actor_username: entry.actor_username.map(str::to_string),
            actor_role: entry.actor_role.map(str::to_string),
            action: entry.action.to_string(),
            resource: entry.resource.to_string(),
            entity_id: entry.entity_id.map(str::to_string),
            detail: entry.detail.clone(),
            origin: entry.origin.to_string(),
            result: entry.result.to_string(),
            spooled_reason: String::new(),
        }
    }
}

#[derive(Default)]
struct SpoolState {
    /// `pending_id -> ts` of every entry known to be waiting.
    index: HashMap<String, String>,
    /// Entries in `index` whose file is still being written (reserved
    /// before the write so the cap holds); `reconcile` leaves them alone.
    writing: HashSet<String>,
    dropped: u64,
    failed: u64,
    last_error: Option<String>,
    /// When this process last read the directory (a flush's scan, or a
    /// claimed rescan, see [`Spool::claim_rescan`]). `None` = never.
    last_scan: Option<Instant>,
}

/// The result of reading the spool directory.
pub(super) struct Scan {
    /// Valid entries, oldest first (`ts`, then `pending_id`).
    pub entries: Vec<(PathBuf, PendingEntry)>,
    pub quarantined: u64,
    /// Warning lines produced while reading (the blocking scan collects them
    /// and [`Spool::scan`] sends them to the log sink afterwards).
    logs: Vec<String>,
}

pub(super) struct Spool {
    dir: PathBuf,
    pub config: SpoolConfig,
    /// One flush at a time per service (several processes are still safe:
    /// the INSERT is `ON CONFLICT (pending_id) DO NOTHING`).
    pub flush_lock: tokio::sync::Mutex<()>,
    state: Mutex<SpoolState>,
}

impl Spool {
    /// Create the directory if needed and load the entries already waiting
    /// there (left by an earlier run). Blocking file I/O: called once while
    /// the service is built, before it serves anything.
    pub fn open(dir: PathBuf, config: SpoolConfig) -> Result<Self, BantoError> {
        fs::create_dir_all(&dir).map_err(|err| {
            BantoError::Other(format!(
                "監査ログの保留ディレクトリを作れません（{}）: {err}",
                dir.display()
            ))
        })?;
        let scan = scan_dir(&dir, false).map_err(|err| {
            BantoError::Other(format!(
                "監査ログの保留ディレクトリを読めません（{}）: {err}",
                dir.display()
            ))
        })?;
        let index = scan
            .entries
            .into_iter()
            .map(|(_, e)| (e.pending_id, e.ts))
            .collect();
        Ok(Self {
            dir,
            config,
            flush_lock: tokio::sync::Mutex::new(()),
            state: Mutex::new(SpoolState {
                index,
                last_scan: Some(Instant::now()),
                ..Default::default()
            }),
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, SpoolState> {
        // A panic while holding this lock cannot leave the index half
        // updated (every critical section is a single map/counter update).
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn count(&self) -> usize {
        self.state().index.len()
    }

    /// Whether a successful `record` should start a flush: entries this
    /// process knows about are waiting, or the directory has not been read
    /// for [`SpoolConfig::flush_interval`] (another process sharing it may
    /// have spooled entries this index never saw). A `true` from the second
    /// reason claims the rescan (it moves `last_scan` to now), so a burst of
    /// successful writes starts at most one directory read per interval.
    pub fn should_flush_after_success(&self) -> bool {
        let mut state = self.state();
        if !state.index.is_empty() {
            return true;
        }
        let due = state
            .last_scan
            .is_none_or(|at| at.elapsed() >= self.config.flush_interval);
        if due {
            state.last_scan = Some(Instant::now());
        }
        due
    }

    pub fn backlog(&self) -> SpoolBacklog {
        let state = self.state();
        SpoolBacklog {
            count: state.index.len() as u64,
            oldest_ts: state.index.values().min().cloned(),
            dropped: state.dropped,
            failed: state.failed,
            last_error: state.last_error.clone(),
        }
    }

    /// Write `entry` to the spool. Never fails the caller: a full spool or a
    /// failed write is counted and logged, and the entry is lost.
    pub async fn write(&self, log: &AuditLogSink, mut entry: PendingEntry, reason: String) {
        entry.spooled_reason = reason.clone();
        {
            let mut state = self.state();
            state.last_error = Some(reason.clone());
            if state.index.len() >= self.config.max_files {
                state.dropped += 1;
                let dropped = state.dropped;
                drop(state);
                log(&format!(
                    "banto: 監査ログの保留ファイルが上限（{} 件）に達したため、記録を破棄しました（action={}, resource={}, 理由={reason}, 破棄の累計 {dropped} 件）",
                    self.config.max_files, entry.action, entry.resource
                ));
                return;
            }
            // Reserve the slot before the (slow) write so concurrent writers
            // respect the cap; undone below if the write fails.
            state
                .index
                .insert(entry.pending_id.clone(), entry.ts.clone());
            state.writing.insert(entry.pending_id.clone());
        }

        let dir = self.dir.clone();
        let file = entry.clone();
        let written = tokio::task::spawn_blocking(move || write_file(&dir, &file))
            .await
            .unwrap_or_else(|err| Err(io::Error::other(err.to_string())));
        self.state().writing.remove(&entry.pending_id);
        match written {
            Ok(()) => {
                let count = self.count();
                log(&format!(
                    "banto: 監査ログを DB に書けないため保留ファイルに退避しました（action={}, resource={}, 理由={reason}, 保留 {count} 件）",
                    entry.action, entry.resource
                ));
            }
            Err(err) => {
                let mut state = self.state();
                state.index.remove(&entry.pending_id);
                state.failed += 1;
                let message = format!("保留ファイルの書き込みに失敗: {err}");
                state.last_error = Some(message.clone());
                drop(state);
                log(&format!(
                    "banto: 監査ログの記録に失敗しました（action={}, resource={}）: DB: {reason} / {message}",
                    entry.action, entry.resource
                ));
            }
        }
    }

    /// Read the directory for a flush: removes stale `.tmp` files,
    /// quarantines unreadable entries, and returns the valid ones oldest
    /// first. Entries found on disk that the index did not know (another
    /// process spooled them) are added to the index.
    pub async fn scan(&self, log: &AuditLogSink) -> Result<Scan, BantoError> {
        let dir = self.dir.clone();
        let scan = tokio::task::spawn_blocking(move || scan_dir(&dir, true))
            .await
            .map_err(|err| BantoError::Other(err.to_string()))?
            .map_err(|err| {
                BantoError::Other(format!(
                    "監査ログの保留ディレクトリを読めません（{}）: {err}",
                    self.dir.display()
                ))
            })?;
        for line in &scan.logs {
            log(line);
        }
        let mut state = self.state();
        state.last_scan = Some(Instant::now());
        for (_, entry) in &scan.entries {
            state
                .index
                .entry(entry.pending_id.clone())
                .or_insert_with(|| entry.ts.clone());
        }
        Ok(scan)
    }

    /// Remove a flushed entry's file (a missing file is fine: another process
    /// flushed it too) and forget it.
    pub async fn remove(&self, log: &AuditLogSink, path: PathBuf, pending_id: &str) {
        let removed = tokio::task::spawn_blocking(move || match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        })
        .await
        .unwrap_or_else(|err| Err(io::Error::other(err.to_string())));
        match removed {
            // The row is in `audit_log` now either way; a file that could not
            // be removed is flushed again (a no-op) and removed next time.
            Ok(()) => {
                self.state().index.remove(pending_id);
            }
            Err(err) => log(&format!(
                "banto: 流し込み済みの監査ログの保留ファイルを消せませんでした（{pending_id}）: {err}"
            )),
        }
    }

    /// After a flush: forget index entries whose file is gone (another
    /// process flushed them) and record how the flush ended.
    pub async fn reconcile(&self, error: Option<String>) {
        let dir = self.dir.clone();
        let ids: Vec<String> = {
            let state = self.state();
            state
                .index
                .keys()
                .filter(|id| !state.writing.contains(*id))
                .cloned()
                .collect()
        };
        let gone: Vec<String> = tokio::task::spawn_blocking(move || {
            ids.into_iter()
                .filter(|id| !dir.join(format!("{id}.json")).exists())
                .collect()
        })
        .await
        .unwrap_or_default();
        let mut state = self.state();
        for id in gone {
            state.index.remove(&id);
        }
        match error {
            Some(err) => state.last_error = Some(err),
            None if state.index.is_empty() => state.last_error = None,
            None => {}
        }
    }
}

/// `<pending_id>.json.tmp` -> `sync_all` -> rename to `<pending_id>.json`.
fn write_file(dir: &Path, entry: &PendingEntry) -> io::Result<()> {
    let json = serde_json::to_vec(entry).map_err(io::Error::other)?;
    let tmp = dir.join(format!("{}.json.tmp", entry.pending_id));
    let target = dir.join(format!("{}.json", entry.pending_id));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(&json)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Read every `<id>.json` in `dir`. With `mutate`, also remove stale `.tmp`
/// files and move unreadable entries to the quarantine directory (a flush);
/// without it, only read (opening the spool).
fn scan_dir(dir: &Path, mutate: bool) -> io::Result<Scan> {
    let mut entries = Vec::new();
    let mut quarantined = 0;
    let mut logs = Vec::new();
    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        let Some(name) = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let Ok(meta) = item.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if name.ends_with(".json.tmp") {
            if mutate {
                let age = meta
                    .modified()
                    .ok()
                    .and_then(|m| SystemTime::now().duration_since(m).ok());
                if age.is_some_and(|age| age >= STALE_TMP_AGE) {
                    let _ = fs::remove_file(&path);
                }
            }
            continue;
        }
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            // Flushed and removed by another process since `read_dir`.
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            // Unreadable right now (e.g. locked by another process on
            // Windows): skip it this time rather than block the others.
            Err(err) => {
                if mutate {
                    logs.push(format!(
                        "banto: 監査ログの保留ファイルを読めませんでした（{name}）: {err}"
                    ));
                }
                continue;
            }
        };
        match parse_entry(stem, &bytes) {
            Some(entry) => entries.push((path, entry)),
            None if mutate && quarantine(dir, &path, &name, &mut logs) => quarantined += 1,
            None => {}
        }
    }
    entries.sort_by(|(_, a), (_, b)| (&a.ts, &a.pending_id).cmp(&(&b.ts, &b.pending_id)));
    Ok(Scan {
        entries,
        quarantined,
        logs,
    })
}

/// A spool file's entry, or `None` if it is not one this version wrote for
/// this file name.
fn parse_entry(stem: &str, bytes: &[u8]) -> Option<PendingEntry> {
    let entry: PendingEntry = serde_json::from_slice(bytes).ok()?;
    let valid = entry.v == FORMAT_VERSION
        && entry.pending_id == stem
        && uuid::Uuid::parse_str(stem).is_ok()
        && !entry.ts.is_empty();
    valid.then_some(entry)
}

fn quarantine(dir: &Path, path: &Path, name: &str, logs: &mut Vec<String>) -> bool {
    let qdir = dir.join(QUARANTINE_DIR);
    let moved = fs::create_dir_all(&qdir).and_then(|()| fs::rename(path, qdir.join(name)));
    match moved {
        Ok(()) => {
            logs.push(format!(
                "banto: 読めない監査ログの保留ファイルを隔離しました（{QUARANTINE_DIR}/{name}）"
            ));
            true
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => false,
        Err(err) => {
            logs.push(format!(
                "banto: 読めない監査ログの保留ファイルを隔離できませんでした（{name}）: {err}"
            ));
            false
        }
    }
}
