# ADR-0015: Read lists that change without events through a separate bounded (`asOfId`) class, `SnapshotListResource`, with an injected fetcher

> 日本語: [0015-snapshot-list-resource.md](0015-snapshot-list-resource.md)

- Status: Accepted
- Date: 2026-09-29
- Related: Issue #248, #243 (PR #246) / spec §4.1 / conventions §6 /
  banto-industrial #410, #427, #428, #448, #463, #464 (earlier instances of the same fix)

## Context

The admin-template audit-log page did not use `WindowedListResource`; it kept a
reduced copy (`AuditLogWindow`) inside the page. The audit log sits outside
`DataProvider` for the same reason as `usersAdmin.ts` (its own wire shape and
Tauri command names), and `WindowedListResource` assumed `getDataProvider()`.
#243 fixed `WindowedListResource`, but the copy kept the same defects
(reproduced by running a verbatim copy of the old class):

1. Failures were only toasts: "not read yet", "failed" and "0 rows" looked the
   same, and there was no way to retry.
2. With a visible range of `{0, 0}` (after a failed first fetch, or after a
   filter matched 0 rows) no request was made, so the page could not recover.
3. A request that never answered had no time limit; `loading` stayed up.
4. Rows come and go between fetches. The audit log grows without
   `invalidate()` and shrinks through retention pruning. Without a boundary,
   blocks duplicate or skip rows at their edges (3 new rows made the first 3
   rows of the next block repeat the end of the previous one).

1-3 are fixed by letting `WindowedListResource` take an injected fetcher (the
issue's option A). 4 needs a per-generation snapshot boundary (option B, the
owner's decision).

## Decision

- Add a **separate class** to `@banto/admin-core`, `SnapshotListResource`
  (`createSnapshotListResource(fetcher, options)`, `snapshot.svelte.ts`). It
  **takes an injected fetcher**; `DataProvider.getList` is unchanged.
- The boundary `asOfId` returned by a generation's first answer is pinned and
  sent with every later block. Until it is known, only one request is in
  flight. An answer whose **count or deletion epoch (`deletionEpoch`)**
  differs from the generation's first under the same boundary is not written
  and the generation stops reading (expired). The generation is not restarted
  automatically; `refresh()` (the page's "Reload") starts a new one.
- **The boundary alone does not fix the set** (added after the #256 review).
  The set inside it shrinks through deletions (retention) and, on
  PostgreSQL, grows when **a writer that allocated a lower `id` commits
  late** (`IDENTITY` hands out ids outside transactions). A per-request
  `REPEATABLE READ` only makes one answer consistent. A late commit plus a
  deletion of the same size keeps the count while the set changes, so the
  count alone misses it (rows repeat, e.g. `[5,3,3,2]`). The server therefore
  keeps a **deletion epoch**: when retention pruning deletes rows it advances
  `audit.deletion_epoch` in `settings` in the same transaction, and the list
  reads it in the same read transaction as the rows and the count. The client
  compares both with the generation's first answer:

  | What happened inside the boundary       | Count   | Deletion epoch | Detected by    |
  | --------------------------------------- | ------- | -------------- | -------------- |
  | Late commit only                        | up      | same           | count          |
  | Deletion only                           | down    | advanced       | both           |
  | Late commit + deletion of the same size | same    | advanced       | deletion epoch |
  | Late commit + larger/smaller deletion   | changed | advanced       | both           |

  SQLite writes one at a time, so a row below the boundary never commits late
  there (the count alone would do), but it runs the same mechanism. Rows are
  assumed to be deleted only by `prune` (restoring a backup replaces the whole
  database and restarts).

- Failures per block, recovery from `{0, 0}`, the time limit and dropping
  answers from another generation follow the same promises as
  `WindowedListResource` (#243). The small shared pieces (array-length check,
  timeout message, conversion to `ProviderError`) live in `blockFetch.ts`.
- The server (the audit-log list) accepts an optional `asOfId` and returns the
  boundary it used; a bounded read does not run retention pruning. The
  server-side rules live in [conventions §6](../conventions.en.md).

## Alternatives considered

- **A (chosen): a separate class with an injected fetcher.** Leaves
  `WindowedListResource` and every CRUD screen using it untouched (#212's
  keep-the-old-rows-while-refreshing, #243's promises). Lists that need a
  boundary are few and have dedicated APIs, so injection is natural.
  Downside: the block-loading decisions live in two classes (small pieces
  are shared; what to fetch, accept and stop is not).
- **B (rejected): add fetcher injection and a boundary option to
  `WindowedListResource`.** One class, but a bounded list requests
  differently (one request until the boundary is known, stop on a count
  change, no automatic re-read), so every option adds branches to a state
  machine that went through two review rounds in #246. And
  `WindowedListResource` assumes `invalidate()` re-fetches automatically
  (`refresh()` swaps in the new data while keeping the old one shown), which
  is a different meaning of `refresh()` than "no events, the user starts a
  new generation".
- **C (rejected): add `asOfId` to `DataProvider.getList` (optional argument,
  optional response field) and use it from `WindowedListResource`.**
  Compatible, but every provider - InMemory, Tauri, HTTP and any a derived
  app wrote - would have to decide whether to honour the boundary or silently
  ignore it. An ignored boundary cannot be told apart from an expiry, and CRUD
  lists that need no boundary would pay for it.
- For the deletion epoch (#256 review), other ways of detecting the change:
  - **Return `SUM(id)` (or a set hash) inside the boundary with the count
    (rejected).** Needs no change on the write side and costs about the same
    as the count (same scan). But detection is probabilistic: two late
    commits and two deletions with equal id sums slip through (e.g. `{2,5}`
    in, `{3,4}` out). A hash collides less, but there is no set hash that is
    cheap in SQL and identical in both dialects.
  - **`(max(id), count, min(id))` (rejected).** Row-cap deletion is oldest
    first, so `min(id)` usually moves, but not when no deleted row is inside
    the filter, nor for day-based deletion (`ts` order and `id` order are not
    guaranteed to match). A filtered `min(id)` needs the same scan as the
    count.
  - **A deletion epoch (chosen).** Costs one `settings` row update when a
    prune deleted rows (in the prune's transaction) and one primary-key read
    per list. With `prune` as the only deletion path it misses nothing (table
    above). No migration (`settings` is a Banto base table).
- **D (rejected): fix the reduced copy per page** (banto-industrial #427 keeps
  `blockCache.ts` as a duplicate plus a sync test). Template users would copy
  it for every list of this kind, and a copy is exactly what #248 found left
  unfixed.

## Consequences

- A new list that changes without events uses `SnapshotListResource`, and its
  server side follows conventions §6 (one read transaction, count inside the
  boundary, `id` monotonic without reuse, anything that deletes rows
  advances the deletion epoch in the same transaction, no deleting side
  effect on a bounded read, unchanged result without `asOfId`). A list with
  deletions on a database that commits writes concurrently must return
  `deletionEpoch`.
- Keep `WindowedListResource` and `SnapshotListResource` aligned on failures,
  recovery and time limits; when fixing one, check the other (shared pieces
  are in `blockFetch.ts`).
- While the boundary is pinned the page does not show new records by itself.
  Keep "Reload" always available (also while loading; in-flight requests are
  aborted).
- On PostgreSQL a writer that allocated a lower `id` and commits late raises
  the count under the same boundary. That is treated as an expiry too
  (re-reading is correct). When a deletion offsets the count, the deletion
  epoch still expires the generation.

---

## Addendum (2026-10-06, Issue #342): failure kinds, texts and notifications

The body's decision (a separate class, an injected fetcher, the boundary,
expiry) is unchanged. What changes is how failures reach the page. By owner
decision (2026-10-06) backward compatibility is not kept; this ships in
v5.0.0 (major) without compatibility aliases.

### Context

- A derived app (banto-industrial's audit log) applied its own 15 s limit in
  the fetcher before banto's 30 s one, only to get a Japanese message (the
  timeout text was a fixed English string the app could not replace). It
  replaced the boundary-mismatch text by comparing `message` with
  `SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE`.
- ChronoGazer's `/events` shows failures of different kinds at once (a
  server answer "could not read" and a failed round trip or timeout; the
  lowest block of each kind) and shows no toast for them. "Could not read"
  is a `ProviderError` subclass (carrying `readout`) the app throws from its
  fetcher.
- `error` (only the most recent failure) cannot show failures of different
  kinds at once, and kinds could only be told apart by comparing messages.

### Decision

- The state is `failures` (ascending by block, one entry per block):
  `{ block, kind: 'error', code, error }` or `{ block, kind: 'expired' }`.
  An entry goes away when its block loads and `setParams()` empties the
  list (the body's promises, unchanged). `error` and `failedBlocks` were
  removed (derivable from `failures`). `expired` stays: it says "the current
  generation has stopped", which differs from an expiry recorded in an
  earlier generation.
- A failure's kind is a code, `SnapshotListFailureCode` (`'request'`,
  `'timeout'`, `'boundaryMismatch'`, `'malformed'`). Failures the resource
  creates itself are a `SnapshotListError` (a `ProviderError` subclass with
  `code`). A `ProviderError` the fetcher throws is recorded **as the same
  object** (`'request'`), so the data an app's subclass carries (such as
  `readout`) survives. Anything else is wrapped in
  `SnapshotListError('request')` with the thrown value as `cause`.
- The texts of the failures the resource creates are replaced through the
  `messages` option (`timeout(ms)`, `boundaryMismatch()`, `malformed()`).
  Same as layer-1 injection ([ADR-0005](0005-i18n-paraglide.en.md),
  conventions §13): the package holds no dictionary and takes functions
  (Paraglide message functions can be passed as they are). The defaults are
  English (`defaultSnapshotListMessages`).
  `SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE` was removed. A message function that
  throws falls back to the default text (so a timeout still settles).
- The `notify` option (default `true`, `false`, or a per-failure predicate)
  turns off the per-failure toast. An expiry is still never notified.

### Alternatives considered

- **Replaceable texts only (rejected)**: kinds would still be told apart by
  comparing texts.
- **Codes only (rejected)**: the resource writes the toast text, so a page
  that keeps the toast would still show English. Both codes and texts are
  provided.
- **A dictionary in the package (rejected)**: against conventions §5 and §13.
- **Keeping `error` (the most recent failure) (rejected)**: an alias of what
  `failures` already gives, and not enough for a page that shows failures of
  different kinds at once.

### Consequences

- `WindowedListResource` is not changed here (the default English texts are
  shared in `blockFetch.ts`). This is a temporary gap against the body's
  consequence "keep them aligned on failures"; aligning it to the same shape
  (codes, `messages`, `notify`, `failures`) is left to a separate issue.
  Its `refresh()` keeps the shown rows (#212) through a different state
  machine, and its current users (server-mode CRUD grids) do not yet need
  to tell failure kinds apart, so the breaking change was not widened.

---

## Addendum (2026-10-07, Issue #344): `WindowedListResource` failures take the same shape, and the type names become shared

This closes the gap left in the consequences of the 2026-10-06 addendum. The
decisions of the body and of that addendum are unchanged. By owner decision
(2026-10-07) backward compatibility is not kept and this ships as v6.0.0
(major). No compatibility aliases are kept and no migration guide is written.

### Context

- `WindowedListResource` still had `error` (the most recent failure),
  `failedBlocks` and fixed English texts, so its failures were told apart
  differently from `SnapshotListResource`'s. CRUD screens showed the fixed
  English text in their toast with no way to replace it.
- The type names chosen in the 2026-10-06 addendum (`SnapshotListError` and
  so on) are tied to `SnapshotListResource`; using them for
  `WindowedListResource` would name its failures after a class it is not.

### Decision

- `WindowedListResource` reports failures as `failures` (ascending by block,
  one entry per block, `{ block, kind: 'error', code, error }`). `error` and
  `failedBlocks` were removed. An entry goes away as before (its block loads,
  or `setParams()`).
- `refresh()` keeps the shown rows as before (#212): rows and count stay
  until every block of the generation has settled, while `failures` is
  updated as each retried block settles (removed on success, replaced on a
  new failure). Holding failures back with the rows would hide a failed
  retry until the generation ends and keep showing the old failure. Recording
  a failure writes no rows, so it cannot cause the #212 problem (a transient
  hole making the edited row look gone).
- Kinds and handling follow the 2026-10-06 addendum. A `ProviderError` that
  `getList` (or `getDataProvider()`) throws is kept as the same object
  (`'request'`), a `ListBlockError` keeps its own `code`, anything else is
  wrapped in `ListBlockError('request')` with the thrown value as `cause`.
  Timeouts and malformed answers are `'timeout'` and `'malformed'`. The
  resource takes `messages` (`timeout(ms)`, `malformed()`) and `notify`
  (default `true`, `false`, or a predicate). It never creates
  `'boundaryMismatch'` (it has no boundary).
- The type names are shared by both resources: `SnapshotListError` ->
  `ListBlockError`, `isSnapshotListError` -> `isListBlockError`,
  `SnapshotListFailureCode` -> `ListBlockFailureCode`,
  `SnapshotListErrorFailure` -> `ListBlockErrorFailure`. Texts use the shared
  `ListBlockMessages` (`timeout`, `malformed`; defaults
  `defaultListBlockMessages`), which `SnapshotListMessages` extends with
  `boundaryMismatch`. `SnapshotListFailure`, `SnapshotListExpiredFailure`,
  `SnapshotListMessages` and `defaultSnapshotListMessages` keep their names,
  since expiry and boundary mismatch belong to `SnapshotListResource` only.
  Handling a thrown value, resolving texts and deciding `notify` live in one
  place, `blockFetch.ts`, shared by both resources.

### Alternatives considered

- **A separate `WindowedListError` (rejected)**: two sets of identically
  shaped classes, code types and guards. Apps would need a different
  `instanceof` per resource, and a data source used by both would see one
  resource treat the other's error as `'request'` instead of keeping its
  `code`.
- **Keep the `SnapshotListError` name and use it in `WindowedListResource`
  too (rejected)**: a smaller break, but failures of a resource without a
  boundary would carry the `SnapshotList` name and mislead readers. v6.0.0
  breaks anyway, so the name is fixed now.
- **A narrower code type per resource (`WindowedListResource` without
  `'boundaryMismatch'`) (rejected)**: a `ListBlockError` thrown by the data
  source keeps its `code`, so `'boundaryMismatch'` can appear there too; the
  type would be narrower than the values that can occur.
- **Hold failures during `refresh()` and publish them with the rows at the
  end of the generation (rejected)**: see the reasoning in the decision.

### Consequences

- The body's consequence "keep them aligned on failures" now holds. From now
  on, a change to the failure shape changes both resources together.
- banto-industrial does not use `WindowedListResource`; the renaming affects
  only its tests that use `isSnapshotListError`.
