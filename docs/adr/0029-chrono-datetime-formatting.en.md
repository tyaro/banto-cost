# ADR-0029: Format dates and times in one place in `banto-core` with `chrono` (no features) (exception to ADR-0002)

> 日本語: [0029-chrono-datetime-formatting.md](0029-chrono-datetime-formatting.md)

- Status: Accepted
- Date: 2026-11-09
- Related: conventions §3 / [ADR-0002](0002-minimal-dependencies.en.md) /
  [ADR-0028](https://github.com/tyaro/banto/blob/v7.0.0/docs/adr/0028-chrono-local-date.en.md) (this ADR widens its "not added to the shared crates")

> banto-cost note: imported from Banto v7.0.0. "ADR-0028" in this text is Banto's own ADR-0028 (the local date of `items.updated_at`; not imported, banto-cost has no items), not banto-cost's [ADR-0028](0028-capability-project-scope-authz.en.md) (capability and project scope authz).

## Context

Turning a `SystemTime` or a day count since the epoch into `YYYY-MM-DD...` text lived in three
hand-written ports of Howard Hinnant's `civil_from_days` (`banto-attachments`,
`backup.rs` in `banto-admin-services`, and the app's `core/src/db.rs`). Conventions §3 said
"if a fourth appears, decide on consolidating into `banto-core`".

ADR-0028 already let the app core use `chrono` (`clock`), and `chrono` is in the lockfile and in
`src-tauri`. On 2026-11-09 the owner decided that using `chrono` for date/time is allowed.

## Decision

**Add `chrono` (`default-features = false`, no features) to `banto-core` and put three
functions in `banto-core::datetime`. Delete the three hand-written conversions and call these.**
Approved by the owner on 2026-11-09.

- `iso_datetime_from_system_time` (`YYYY-MM-DD HH:MM:SS`, UTC; the same text as SQLite's `datetime('now')`)
- `iso8601_utc_from_system_time` (`YYYY-MM-DDTHH:MM:SSZ`)
- `iso_date_from_days_since_epoch` (`YYYY-MM-DD`)

Output formats and boundary behavior are unchanged: a time before the epoch is the epoch,
fractions of a second are dropped, negative day counts work. `DateTime::<Utc>::from(SystemTime)` can
panic when out of range (the backup list passes a file mtime, an external value), so it is not
used; the `Option`-returning `DateTime::from_timestamp` / `NaiveDate::from_num_days_from_ce_opt`
are, and an out-of-range value becomes the epoch (no panic). `compact_stamp` is plain string
handling and is untouched.

No feature is enabled. `clock` (current time, local TZ) is not needed in `banto-core`; only the
app core, which reads the local date, adds `clock` as before (ADR-0028). The root
`[workspace.dependencies]` declares it with `default-features = false` and each user adds only the
features it needs. No new crate appears in `Cargo.lock`.

## Alternatives considered

- **A (chosen): add `chrono` to `banto-core` and consolidate into one place.**
  Conventions §3 criteria (P1-5) met: (1) dates/times are an edge-case-heavy domain (calendar,
  leap years, out of range); (2) the hand-written code was duplicated three times; (3) `chrono` is
  mature and already in the dependency graph, so the real increase is near zero; (4) it needs no
  features. Downside: one more dependency in a shared crate; derived apps get `chrono` transitively.
- **B (rejected): keep the three hand-written copies.** Keeps three calendar implementations to
  maintain, and a boundary fix (out of range, negative days) would need three edits. The fourth-copy
  risk stays.
- **C (rejected): only consolidate the hand-written code into `banto-core`.** One copy, but we
  still maintain our own calendar code. Since `chrono` is already present, the reason to keep it is weak.

## Consequences

- No hand-written `civil_from_days` remains; date/time-to-text conversion lives only in
  `banto-core::datetime`, with the boundary tests there.
- The `chrono` / `time` row of the conventions §3 table now states the current facts. ADR-0028's
  "not added to the shared crates" is widened by this ADR (ADR-0028's body is not rewritten).
- To remove: replace only the bodies of the three `banto-core::datetime` functions with
  hand-written code (callers do not change).
