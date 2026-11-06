# Banto maintainer conventions — invariants you must not break

> The Japanese [`conventions.md`](conventions.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

Intended reader: **people who maintain and extend the template itself**
(Track A). Procedures for users building their own app from the template live
on the [README](../README.md) side (Track B). For the distinction between the
two tracks, see
[README "Documentation comes in two tracks"](../README.md#ドキュメントの2トラック).

Positioning: this collects, in one place, the "why we write it this way" rules
that used to be scattered across the doc comments at the top of each module, so
they can be referenced every time a feature is added. The items written here
are limited to **invariants that machines (lint/types/CI) cannot fully enforce,
and are upheld by review**. General language style (naming, formatting) is
delegated to eslint/prettier/clippy/rustfmt and is out of scope here.

The three categories of documentation (added 2026-07-19, improvement-plan
P4-7): the "why" is divided into three roles — **code comments** (local reasons
that only make sense in place) / **this document** (cross-cutting invariants =
rules to uphold) / **[ADR](adr/README.en.md)** (design decisions that chose one
option by comparing alternatives = why that rule was made). Where the "why"
behind an invariant here involves a comparison of alternatives, it can be
traced from the corresponding ADR (e.g., §1 · §2 →
[ADR-0001](adr/0001-rest-tauri-two-path-symmetry.en.md), §3 →
[ADR-0002](adr/0002-minimal-dependencies.en.md)). Do not write the same "why"
in two places.

Machine checks (added 2026-07-19, improvement-plan P3-5): the machine-checkable
items in this document are checked by `pnpm verify:architecture`
(`scripts/verify-architecture.mjs`, enforced in the CI frontend job). Such
items are annotated **[machine-checked]** in each section — everything else
continues to be upheld by review. Intentional exceptions are managed as a pair:
a justification comment in the code + an allowlist (with reasons) in the script.

Deletability: this document is a Track A asset. If you **hard-fork and evolve
independently** without tracking upstream, you may delete it wholesale
(following the template's "everything is deletable" policy). Keep it if you keep
tracking upstream / keep maintaining the template.

How to reference: because line numbers change, this document references by
**file + symbol name + spec section** as a rule. The actual code is the primary
source; if there is a discrepancy, the code wins.

---

## 1. Decision symmetry between REST and Tauri [machine-checked: existence of both paths for mutating operations]

Every mutating operation (create/update/delete/import/login/logout/setup)
**passes through the same authorization and the same audit on both the REST and
Tauri paths**. Only the origin (`"rest"` / `"tauri"`) differs.

- REST: `RoleGuard` / `require_role_at_least` + `record_write` in
  `banto-server` `routes/mod.rs` (moved from `admin-template-core` `rest/mod.rs`
  in V2 theme C PR-C4; the app-side `rest/items.rs` · `rest/attachments.rs`
  import and use these).
- Tauri: `require_role` in `src-tauri/src/lib.rs` (its doc comment states
  "mirrors REST's `RoleGuard`") + `audit.record(...)` in each command.
- The correspondence table is in the module doc of `rest/mod.rs` (spec M14).
- **Read operations (list/get) are not audited on either path.** A denied
  record is written only for "authenticated but insufficient role." No-session
  (Unauthorized) is not recorded — this decision, too, is aligned on both
  sides.

When adding a feature: do not add a new mutating command to only one of the
paths. Always implement and test both paths + the denied case on both paths as
a pair (template-scope §6 checklist ④⑤).

**Machine check (`verify:architecture` rule 8, CR-1)**: that a mutating
operation exists on both the REST/Tauri paths is guaranteed by the `DUAL_PATH`
manifest + completeness check in `scripts/verify-architecture.mjs`. Unless you
add a new Tauri command / REST route to a classification (dual-path /
desktop-only / read), CI fails — so **the mistake of adding to only one path is
always caught**. For declared pairs, **rule 8 also cross-checks the role floor
(authorization level) on both paths** (CR-6: the `role` field of `DUAL_PATH`
plus `ROLE_READ` for reads). The only part outside the machine check is
**whether the audit records are identical** (same `AuditEntry` shape), which is
guaranteed by code + tests. The rationale for the desktop-only / read
classification is in maintainability-review-2026-07.md §3.

**Canonical audit shape** (outside the machine check = aligned by code + tests;
deviations were measured and fixed in maintenance-review-2026-08 §5.3):

- **`resource` follows the operation's target.** The audit-log *retention
  policy* config (`audit_config_get`/`apply`) reads/writes settings, not the
  audit log itself, so both its success and denial use `resource: "settings"`
  (only `audit-log/list`, which reads the log body, keeps `"audit_log"`). On
  REST this is done by splitting `audit_log_router` into a list guard and a
  config guard. Tagging denial and success alike lets an admin filtering by
  resource see refusals and successes in one bucket.
- **`entity_id` is "the target's real name".** Backup operations always use the
  backup file's real name (`backups_create` and restore-from-existing are
  `Some`; restore-from-upload has no server-assigned name yet, so `None` with
  the display name in `detail.fileName`).
- **A denial's `detail` may be asymmetric between paths.** REST carries
  `{method, path}` (a side effect of the RoleGuard middleware) while Tauri is
  `None`. A denial records an operation that did NOT run, so what matters is
  "who was refused which `resource`"; identifying the specific operation is
  unnecessary (an operation that ran leaves its `action`/`entity_id` on the
  success entry). This asymmetry is deliberate.
- **REST login does not record throttled (429) attempts** — `login_failed` is
  recorded only once the request reaches the argon2 verifier. This is a
  deliberate asymmetry to avoid audit-log self-DoS; the Tauri path (local
  input, no throttle) records every failure. The lockout itself is separately
  observable as rate-limiter state.
- **Credential-less auth endpoints must not amplify the audit log** (Issue
  #278). REST `POST /api/auth/logout` records only when it actually ended a
  session (actor resolved from a live token; no/invalid/revoked token records
  nothing; Tauri's `auth_logout` already records only when it cleared a
  session). The `login_failed` `actor_username` is caller-supplied and need not
  be a real account, so `users::bound_username_for_audit` cuts it to the
  creation limit (`MAX_USERNAME_LEN` = 32 chars) on a char boundary with a
  trailing `…` (REST and Tauri). A longer username skips the DB lookup in
  `UsersService::verify` and only pays the dummy hash (same answer and similar
  timing as an unknown user); throttle keys cap the username at 64 chars.
  Retention runs at startup / on list, so it is not a per-write cap; bounding
  these two write paths is what protects capacity.

## 2. The service layer knows nothing of tauri / axum / RBAC / HTTP [machine-checked: tauri/axum non-dependence only]

All services (`ItemsService` / `AuditLogService` / `BackupService` /
`SettingsService` / `UsersService` / the `AttachmentsService` of
`banto-attachments`) keep the same shape:

- `#[derive(Clone)]` (`Db` (an enum wrapper over an Arc-backed pool) /
  `broadcast::Sender` / `PathBuf` are Arc-backed or read-only, so cloning is
  cheap).
- Return `Result<_, BantoError>`. Do not depend on `tauri` / `axum`.
- Authorization, audit, and event notification are **attached by the caller
  (the REST/Tauri wiring layer)**. The service knows nothing of actor / RBAC /
  HTTP (`audit.rs` doc: "This service does not know about actors, RBAC, or
  HTTP").

Effect: services can be driven directly from a `:memory:` pool in
`cargo test`. Each service's `#[cfg(test)] mod tests` assumes this shape. New
services also keep this contract.

Deliberate trade-off: `Db` is an enum of `Db::Sqlite(..)` / `Db::Postgres(..)`, and each service method
writes both backends' SQL side by side in a `match` (about 50 pairs). We do not fold this into macros or a
trait: keeping the SQL differences between the backends readable comes first. As of 2026-10, history holds
no parity regression — a bug where only one arm of a `match` was updated and the two backends drifted apart
(bugs specific to one backend are a different thing and do not count). Revisit when a third backend is
added or such a parity regression appears (maintenance-review-2026-10 §5; the earlier commitment is
maintenance-review-2026-08 §3.3).

## 3. Do not add dependencies (a culture of hand-implementation)

The workspace (root `Cargo.toml`) curates dependencies carefully and does
**not** include the following. Each is substituted by a hand-written
implementation:

| Dependency you might want | Instead | Where it is implemented |
|---|---|---|
| `chrono` / `time` | hand-written date conversion | `iso_datetime_from_system_time` / `compact_stamp` in `backup.rs`. Howard Hinnant's `civil_from_days` is ported in three places (`banto-attachments`, `backup.rs`, the app's `core/src/db.rs`; if a fourth appears, decide on consolidating into `banto-core`) |
| MIME detection library | magic-byte detection | `banto-attachments` `detect_mime` (see §6 below) |
| `multipart` | raw byte body + `?fileName=` query | uploads in `banto-server` `routes/backups.rs` · app `rest/attachments.rs` |
| `tower-http` | hand-written `axum::middleware::from_fn` | `security_headers.rs` / `csrf.rs` |
| markdown library | own parser + escaping | `packages/report/src/core/{parse,bind,html}.ts` (deps empty) |
| `tracing` | `eprintln!` | `audit.rs` |

Rule: if you want to pull in any of the above, that is a design decision and
**subject to discussion**. Do not add it lightly (avoid binary bloat, an
enlarged audit surface, and the copy burden on users).

Decision criteria (added 2026-07-18, improvement-plan-2026-07.md P1-5): the
goal is not "zero dependencies" but **minimizing total maintenance cost**. If
several of the following apply, favorably consider adopting the dependency:

- the hand-written implementation is growing (rule of thumb: over ~100–200
  lines, or its spec has started to expand)
- it touches a security boundary (with a hand-written one, you must chase
  vulnerability fixes yourself)
- it is a domain with many edge cases: Unicode, date/time, cryptography,
  parsers, etc.
- the crate/package is sufficiently mature (maintenance track record, few
  dependencies)
- you can pull in only the needed part behind a feature flag
- you have measured the increase in binary/bundle size and confirmed it is
  within an acceptable range

Conversely, a small hand-written implementation that matches none of these
should stay as is. Do not preemptively replace existing hand-written
implementations (the table in §3) — decide individually, at the point when each
implementation actually starts to match the above.

Individual "add it or not" deferred decisions are recorded in an ADR (including
the comparison of alternatives): **server logging (using `eprintln!` instead of
pulling in `tracing`) is [ADR-0004](adr/0004-server-logging-eprintln.en.md)**,
**TLS on the LAN (terminating at a reverse proxy instead of pulling in rustls)
is [ADR-0003](adr/0003-tls-via-reverse-proxy.en.md)**. Both are Accepted as
"do not add it now, with conditions for reconsideration."

**Exceptions on the "add it" side are also recorded in an ADR**: the decision to
pull in Paraglide JS for the UI i18n runtime is
[ADR-0005](adr/0005-i18n-paraglide.en.md) (this table and policy are kept as-is;
an intentional exception limited to i18n — adopted under the P1-5 criteria of
"compile-time i18n so the runtime dependency is minimal and type-safe"). i18n is
in the app layer only; neither dictionaries nor i18n dependencies go into
`@banto/*` (§5). The decision to pull in `sysinfo`, feature-limited, for the
System Info card's CPU/memory readout is
[ADR-0013](adr/0013-sysinfo-system-metrics-feature.en.md) (a second "add it"
exception, after Paraglide — justified by multiple P1-5 criteria at once: std
alone cannot read this cross-platform, three apps had already started
reimplementing it, the crate's `system` feature scopes it down, the crate is
mature, and the binary-size delta was measured in the implementing PR). It is
scoped to `banto-admin-services`'s opt-in `system-metrics` feature; the
`SystemMetrics` type itself always compiles, feature or not.
The decision to add `windows-sys` and `embed-resource` as direct dependencies of
the elevated helper for the Windows firewall allowance (Issue #219 stage 2) is
[ADR-0021](adr/0021-firewall-elevated-helper.en.md) (the third; pinned to the
versions already in `Cargo.lock` transitively, so no crate is added to the
build; limited to the helper and its launcher module; Proposed).

## 4. No reverse dependency from core → options [machine-checked]

Core (`admin-core` / `grid-svelte` / `forms` / `theme` / `ui`) does not import
options. The dependency direction is "shell → option allowed, option → core
allowed, **core → option not allowed**". **The canonical core/option list is
the table in [template-scope.md §3](template-scope.md)** (do not duplicate the
enumeration here — duplication is a drift source; machine checks rule 2/6 walk
`packages/` dynamically, so new packages are covered automatically).

Current guarantees:

- The `dependencies` / `peerDependencies` of all `packages/@banto/*` are empty.
- There are zero `from '@banto/...'` imports between packages.
- Notes like "charts/dock consume this token" in `theme/banto.css` are comments,
  not imports.

When you bundle an option, add a row to the table in template-scope §3 and take
on **the obligation to document its removal procedure (the list of files to
pull out)**. Keep a structure where deleting it does not break the rest (§6
checklist ②③).

## 5. Packages hold no app-specific imports [machine-checked: `#lib` (formerly `$lib`) import only]

Components in `packages/@banto/*` **do not import app-specific symbols** such as
`sessionStore` or the `ProviderError` of `@banto/admin-core`. The transport is
injected, as in `client: XxxClient` (e.g., `AttachmentsPanel` receives an
`AttachmentsClient` and never imports `attachmentsAdmin.ts` (the app-side layer
you copy and rewrite) from the package).

Machine check: `verify:architecture`'s rule `no-app-import` greps `packages/` for
imports of the app alias (SvelteKit 3's subpath import `#lib`; SvelteKit 2's `$lib`
is still detected too) (#325). Only imports of that alias are machine-checked; the
shape of the transport injection is upheld by review.

State ownership: loading/empty/error states are owned inside the component and
do not leak branching to the host page (the same rule as grid-svelte).

## 6. Security invariants (cross-cutting) [machine-checked: partial (no mime / settings symmetry)]

These are the kind of rules that "become vulnerabilities if not upheld." Items
without a runtime guard are **upheld by reviewing every call site**.

- **Detect MIME by magic bytes. Do not use the client's declaration.**
  `banto-attachments` `detect_mime` limits to four formats via the magic bytes
  of `image::guess_format`; anything else is `application/octet-stream`.
  `NewAttachment` has no `mime` field (it does not even receive a declaration).
  **[machine-checked: `NewAttachment` has no mime field (rule 9)]**
- **Do not use user input in file paths.** The attachment body is named by the
  row id, and `file_name` is display-only. For backups, `safe_backup_path`
  rejects all separators, `..`, and anything outside `[A-Za-z0-9._-]` (which
  also simultaneously blocks Content-Disposition injection and Windows reserved
  names). Attachments have the same kind of check in `validate_file_name`.
- **Throttle before heavy verification (argon2).** `auth/state.rs`
  `login_rate_limited` passes a two-dimensional throttle, per-(IP+username) and
  per-IP, **before** the argon2 verifier (a DoS countermeasure against a
  username-rotation flood). The regression test
  `per_ip_dimension_bounds_a_username_rotation_flood` verifies that "argon2 is
  not called during a lockout." The check also **reserves a verification slot
  atomically before the verifier is awaited** (Issue #279): attempts in flight
  count like recorded failures against the per-account and per-IP thresholds,
  and `MAX_IN_FLIGHT_PER_IP` (4) / `MAX_CONCURRENT_VERIFICATIONS` (8) cap
  concurrency outright. Over a cap the answer is the usual `RateLimited` (no
  queue). The slot is an RAII guard released on success, failure, error and
  future cancellation. The verifier hashes on tokio's blocking pool. Scope:
  this is the REST network boundary (`POST /api/auth/login`); the Tauri
  `auth_login` command is local input and stays unthrottled (see §1).
- **`DefaultBodyLimit` sits above the service-layer check.** The ordering is
  that the transport limit only needs to be "comfortably above" the service
  layer's actual check (`MAX_ATTACHMENT_BYTES`, etc.) (the doc of `rest/mod.rs`
  and various places in the router).
- **Apply the security-headers middleware at the outermost layer (LAST).** By
  attaching it after merging `/api/*` and the static fallback, the structure
  ensures headers do not leak even if a new route forgets to opt in
  (`security_headers.rs`).
- **Do not put secrets in audit detail.** Never put password / hash / bearer
  token into `detail`. There is no runtime guard; **upheld by review**. The
  key/value store records only the key and does not include the value
  (`settings_set`).
- **Raw key/value reads of settings are admin-symmetric.** `settings_get` is
  admin-gated symmetrically with `settings_set` (being able to read an arbitrary
  key is of equal privilege to being able to write it). Only UI settings are
  split into a separate command `ui_settings_get` (viewer-allowed, limited to
  their own namespace). "Do not create an asymmetry of privilege within the same
  store." **[machine-checked: `settings_get`/`settings_set` share the same Admin
  gate (rule 9)]**
- **SQL columns only through the whitelist.** Field names originating from the
  frontend must always be resolved to SQL columns via `ColumnMap`
  (`list_query.rs`), and values must always be bound (never string-interpolated).
  Sort on an unknown field is ignored; filter is a hard error. Services that
  accept `ListParams` (currently items / audit) have a `column_map()` (services
  with a fixed ORDER BY only do not need one).
  **`ORDER BY` always ends with a unique key** (Issue #243): `append_order_by`
  appends the `ColumnMap`'s unique key (by default the registered `id`; declare
  another with `ColumnMap::unique_key`, or none with `without_unique_key`) in the
  direction of the last sort key (ascending when unsorted), so `LIMIT`/`OFFSET`
  paging neither repeats nor skips tied rows. Map `id` in `column_map()` **only
  to a unique column**.
  **This ordering contract is shared by three implementations** (#243 review):
  SQL (`banto-storage`), the InMemory `DataProvider` (`idField`, default `id`)
  and the grid's client sort (the row's `id`, else `getRowId`) all **first drop
  unknown sort fields** (not in the `ColumnMap` / not a grid column / not a
  field of any InMemory row), then break ties by the unique key in the
  direction of the last remaining sort key, put NULLs last in both
  directions, and order an unsorted list by the unique key ascending (only the
  grid's client sort keeps the order of the array it was given). One fixture,
  `crates/banto-storage/testdata/list-order-parity.json`, is read by all three
  test suites - change the fixture and all three together.
  **Lists with a boundary (`asOfId`)** (Issue #248,
  [ADR-0015](adr/0015-snapshot-list-resource.en.md)): a list whose rows come
  and go without change events (the audit log) is read with
  `@banto/admin-core`'s `SnapshotListResource`, and the server side keeps
  these rules - pick the boundary, read the rows and count them in **one read
  transaction** (PostgreSQL `REPEATABLE READ`; the default `READ COMMITTED`
  reads each statement at its own point in time), count inside the boundary,
  let `id` grow monotonically without reuse and never update rows, **have
  anything that deletes rows advance a deletion epoch in the same transaction
  (the audit log's is `audit.deletion_epoch` in `settings`) and return it as
  `deletionEpoch`, read in the same read transaction as the rows and count**
  (on PostgreSQL a late commit of a lower `id` plus a deletion of the same
  size leaves the count unchanged; #256 review), and **run
  no deleting side effect (such as retention pruning) on a bounded read** (the
  page treats a deletion inside the boundary as an expired snapshot, so
  deleting on every read would expire every generation at its second block).
  A read without `asOfId` returns the same result as before.
- **Keep the two CSP definitions in sync.** Desktop uses `app.security.csp` in
  `tauri.conf.json`; LAN uses `CONTENT_SECURITY_POLICY` in `banto-server`'s
  `security_headers.rs`. **The only intended delta is connect-src** (Tauri
  IPC); everything else must match directive-by-directive (the rationale, and
  why `unsafe-inline` is required, live in the doc comment at the top of
  `security_headers.rs`). Editing is manual, but **drift in any directive other
  than connect-src is caught in CI by `verify-architecture.mjs` rule 12**
  ([ADR-0008](adr/0008-machine-check-stop-gate.md); src-tauri does not compile,
  so it guards against one side silently loosening). In addition,
  `apps/admin-template/core/tests/tauri_window_csp.rs` compares the window CSP
  as a string against `SecurityHeaders::new().extra_connect_src(TAURI_IPC_CONNECT_SRC)`'s
  `content_security_policy()` — whenever you change one, update both.
- **Only `with_security_headers_using` widens connect-src on LAN responses.**
  When an app's own desktop shell navigates its Tauri webview to its own HTTP
  UI (e.g. banto-industrial's banto-hub shell), that page runs under the
  response CSP, not the window CSP, so Tauri IPC is blocked by
  `connect-src 'self'`. In that case add `TAURI_IPC_CONNECT_SRC` via
  `SecurityHeaders` and **restrict it to requests whose peer and authority
  (`Host` / `:authority`) are both loopback** with
  `request_is_loopback_local` (2026-10-06; LAN browsers keep the strict
  policy). Only connect-src can be widened; every other directive and header
  stays the same. Do not select on request headers, the query or `Host`
  **alone** (the other party controls them; ANDed with a loopback peer they
  can only narrow). Do not use the peer-only `request_from_loopback_peer`:
  **behind a same-host reverse proxy that connects over loopback, every
  request is a loopback peer, so LAN viewers get the widened policy too**
  (their own machine's port 80 (http) and port 443 (https; in CSP an `http:`
  source also matches `https:`) become reachable). `request_is_loopback_local`
  is defeated too if the proxy rewrites `Host` to the upstream address (Caddy
  `header_up Host {upstream_hostport}`, nginx's default
  `proxy_set_header Host $proxy_host`), so keep `Host` preserved there or
  leave the widening off. Also, "a forged `Host` only affects the forger's own
  response" holds only if no shared cache reuses responses across `Host`s
  (e.g. nginx `proxy_cache` + `proxy_cache_valid`, whose default
  `proxy_cache_key` omits the incoming Host): do not put a shared cache in
  front, or key it per incoming Host (include `$host` in `proxy_cache_key`);
  reject unexpected Hosts on the public side, or override the CSP to the strict
  value at the proxy. The impact analysis lives in the doc comment at the
  top of `security_headers.rs`.
- **Grants (credential-less session issuance, ADR-0017; public viewing is the
  first kind, `publicViewer`).** A client without credentials is issued a
  session with a **fixed identity** of a registered kind
  ([ADR-0017](adr/0017-credential-less-grant.en.md); public viewing:
  [ADR-0012](adr/0012-lan-public-viewer-synthetic-session.en.md),
  [viewer-public-plan §2.2](design/viewer-public-plan.md)). No auth-bypassing public
  router is created — the issued token rides the existing `require_auth` +
  `RoleGuard` + audit + SSE revalidation unchanged. The rules below are
  guaranteed by review:
  - **The only issuing route is `POST /api/auth/grant/{kind}`, which issues a
    fixed identity from a registered `GrantSpec` (e.g.
    `GrantSpec::public_viewer`).** The route takes no identity or role from the
    client (**there is no escalation path** — look here first in review). An
    unregistered kind is 404; a false condition is 403 `forbidden`.
  - **The condition is evaluated on every request** (for public viewing,
    `server.viewer_public`; no restart needed; banto-serve and the Tauri
    embedded server behave identically). Status `grants.<kind>` and issuance
    share `GrantRegistry::availability`.
  - **Concurrent sessions are capped per kind by `max_sessions` (default 256),
    FIFO.** Issuance needs no credentials, so a cap (not a rate limit) bounds
    unlimited growth. Reaching the cap never fails issuance — it **revokes the
    oldest token of that kind**, so a wall display reloading its page never
    loses its view. Other kinds and real login sessions are never evicted.
  - **Lifetime defaults to 8h absolute / 1h idle, and is never remembered.**
  - **Admin-equivalent kinds set `require_loopback_peer`;** an unknown peer is
    refused.
  - **Closing a condition is "persist the condition, THEN
    `revoke_grant_tokens(kind)`" in the same function** (the generation
    serialises it against a parked issuance; `revokedGrants: n` may go into the
    audit detail). Real login sessions are unaffected.
  - **Issuance is not audited** (it is not a credential check, and a tablet
    re-issuing on every reload would bury the log in `login` entries). A
    `denied` entry is still recorded by the existing `RoleGuard` (actor
    `public`, etc.) when a grant session attempts a mutation.
  - **`POST /api/auth/logout` revokes only its own token** (other devices are
    unaffected).
  - **`change-password` explicitly rejects grant sessions**, even if a normal
    account has the same username. The frontend shows no account UI in a grant
    session.
  - **The kind names `account` and `local` are reserved** (they appear as the
    identity `kind`).
  - **Reverse-proxy caveat (ADR-0017 §6).** Behind a same-host proxy every peer
    looks like loopback, so `require_loopback_peer` protects nothing. Lock
    down admin-equivalent grants before exposing the app externally, and do not
    expose `/api/auth/grant/{kind}` from the proxy even during a re-commissioning.
    This is an operating rule; banto cannot enforce it technically.
  - "auth disabled + LAN enabled" is allowed **only when public viewing is
    ON** (guarded from both directions in `SettingsService`, viewer-public-plan
    §2.3). With it OFF the exclusivity is unchanged from the 2026-07-08
    decision.
- **Sessions are re-checked against the account on every request (Issue
  #204).** A session carries the account's row id + `auth_epoch` from when it
  was established; REST's `require_auth` (`AuthState::authenticate`) and
  Tauri's `require_role` (`current_session`) re-read the `users` row each time,
  revoke the session if the account is gone or either value differs, and
  otherwise authorize with the role stored **now**
  ([ADR-0014](adr/0014-account-bound-session-revocation.en.md)). Reviewed by
  hand:
  - **Every write that must end sessions advances `auth_epoch` in the same
    `UPDATE`** (role change, password change, password reset). A new such
    operation (e.g. disabling an account) must do the same.
  - **Access decisions never use the synchronous `verify`/`identity_for`**;
    they go through `authenticate` (`require_auth`). Routes not behind
    `require_auth` (`check`/`identity`/`change-password`) call it themselves.
  - **REST `AuthState`s for real accounts are built with
    `SessionValidation::Lookup`** (`user_auth_state`). `SessionValidation` is a
    required constructor argument with no default; `DisabledNoRevocation` is only
    for tests and public-viewer-only servers with no account store. With a lookup,
    create-and-login paths use `issue_account_token` (unstamped tokens are
    rejected).
  - **The Tauri window's session is a `DesktopSession` enum** (`Account` /
    `AuthDisabledLocal`). It is read only through `current_session`, and
    synthetic sessions are never recognized by a value such as their `id`.
  - A store failure fails the request; it neither revokes nor passes.

## 7. `{@html}` only with self-generated, fully escaped output [machine-checked: allowlist of use sites]

Keep the use of `{@html}` to a minimum, limited to **safe strings that are
self-generated and fully escaped**. The current two sites:

- `report/src/ReportView.svelte`: only the output of the own engine
  `renderHtml`. `html.ts` escapes all text/attributes without exception and
  also blocks `javascript:` src ("no 'trusted' string anywhere in this
  module").
- `settings/ConnectivitySection.svelte`: the SVG generated by the `qrcode` crate (the LAN
  connection QR).

Do not feed externally-sourced, unescaped strings into `{@html}`.

## 8. Pitfalls of Svelte 5 runes

Traps that are easy to fall into in `@banto/*` components.
`AttachmentsPanel.svelte` is a live example:

- **`$effect` tracks only the intended dependencies; wrap side effects in
  `untrack`.** If state that you read and write inside an effect becomes a
  tracking target, you get `effect_update_depth_exceeded` (an infinite loop).
  Wrap the synchronous prefix of reload logic in `untrack()`.
- **The owner revokes the object URL.** A URL created via `createObjectURL` must
  always be revoked in the `finally` of reload / teardown / download
  (`attachmentsAdmin.ts`: "Callers own the returned URL's lifetime").
- **Invalidate async races with a request owner.** admin-core, and apps that can
  import it, use `createRequestOwner` (`request.svelte.ts`,
  shared-primitives-upstream-plan §3.1): a stale request's result and error are not
  applied, an old request's `finally` does not clear the new request's busy flag,
  temporary resources are `hold`-ed and released exactly once on every path
  (success, failure, staleness), and the ones taken into the model are `adopt`-ed.
  Packages that cannot import admin-core (§4) keep the same contract internally and
  run the contract table (`packages/admin-core/tests/contracts/request-owner.json`)
  in their own tests. `AttachmentsPanel.svelte`'s `++loadToken` (discard a
  superseded result and revoke its URL) is a hand-written instance of this
  contract and is not replaced.

## 9. Theme tokens only; raw values consolidated in the theme [machine-checked: color values in packages only]

UI CSS uses only `var(--banto-*)` tokens and **does not write raw values of
color or dimension into components**. Raw values are consolidated in
`packages/theme/src/css/banto.css`. The glass preset is applied opt-in, as in
`backdrop-filter: var(--banto-backdrop, none)` (visual-refresh-design.md).
Scope note: the machine check (rule 5, raw-colors) walks `packages/` only. Raw
values in the app layer (`apps/admin-template/src`) are tolerated **only as
deliberate exceptions with a justification comment** (existing examples: the
login brand pane, the static theme-preview swatches; never write a raw value
without a reason comment).

## 10. 3-way provider branching + demo explicitly refuses

Environment branching is decided by `getBantoMode()` across the three kinds
`tauri` / `server` / `demo`, and is **confined to the provider layer
(`*Admin.ts` / setup)**. UI components hold no environment branching. Demo mode
does not create an InMemory implementation but refuses with `DEMO_MODE_MESSAGE`
(do not let a standalone browser use backend features). Mode restrictions on
some operations (download/upload are server-only, folder is tauri-only, etc.)
are also expressed in the provider layer.

LAN public viewing (#189) adds no fourth mode. `publicViewer` is **session-layer
state** (the issuer-provided `identity.kind === 'publicViewer'`) that distinguishes "logged in" from
"synthetic viewer session" *within* `server` mode; it does not affect which
provider is selected (grant kinds are not provider modes) — a public viewing device uses the ordinary http provider
and its bearer token against the existing APIs
([ADR-0012](adr/0012-lan-public-viewer-synthetic-session.en.md), the reason
alternative B was rejected).
Normal accounts may also use the username `public`, so never infer a synthetic
session from identity id, name, or role. Providers without the marker represent
ordinary sessions.

## 11. The migration style

- Sequentially-numbered file names (`0001_items.sql` … `0008_audit_log_pending_id.sql`)
  are embedded and run by `sqlx::migrate!`. Since V2 "full PostgreSQL support
  for the app," they branch into two lines per dialect:
  `apps/admin-template/core/migrations-sqlite/` (the existing DDL kept
  byte-equivalent for backward compatibility) and `.../migrations-postgres/`
  (the strict-type Postgres version of the same schema: `BIGINT GENERATED BY
  DEFAULT AS IDENTITY` / `BOOLEAN` / TEXT time columns default to `now()::text`,
  etc.). `db::run_migrations` dispatches based on the connection's backend.
  **Filename/sequence parity between the two dialects is caught in CI by
  `verify-architecture.mjs` rule 11** ([ADR-0008](adr/0008-machine-check-stop-gate.md);
  Postgres CI is smoke-only and each `sqlx::migrate!` embeds its dir
  independently, so adding to one dialect only would go silently missing; type
  differences within a same-named pair stay review-guaranteed per the intended
  divergence above).
- **Released migrations are append-only** (not a single byte changes, comments
  included; no deletes or renames). SQLx records a checksum of each applied
  migration's full text, comments included, in the DB and verifies it at
  startup, so editing one makes any DB created with that release or earlier
  fail to start with `VersionMismatch(<version>)`. Make changes as a new
  numbered migration. **That the files under `migrations*/` in the latest `v*`
  tag reachable from HEAD are unchanged in the working tree is caught in CI by
  `pnpm verify:migrations`** (`scripts/verify-migrations-frozen.mjs`; guards
  against the near-miss in #312, where moving docs rewrote a path inside a
  migration comment).
- **The app owns the table definitions.** `banto-attachments` has no migrations
  of its own and keeps its in-test `CREATE TABLE` in sync with
  `0006_attachments.sql` ("MUST be kept in sync").
- Restore validation (`REQUIRED_TABLES`) checks **only table existence** for the
  Banto-owned `settings`, `users`, and `audit_log` tables, not columns (a coarse
  but cheap "is this a Banto DB" judgment). Domain tables such as `items`, which
  derived apps replace or remove, are deliberately not required.
- Every connection opened for validation is `conn.close()`d on all paths (a
  countermeasure against lingering file locks on Windows).

## 12. Doc comments reference spec sections

The top of a module and individual design decisions cite spec sections,
maintaining the culture of tying the "why" of a design to the spec. New modules
also cite the relevant spec section at the top (measure the number of
referencing files with `rg -l 'spec §|spec M'`; as of 2026-08 roughly 40 Rust /
159 TS+Svelte files).

**Reference grammar** (prefix → target). Before consolidating, moving, or
renaming a document, count inbound references with `rg` in **both the path
form (`docs/xxx.md`) and the label/section form (`spec §N` etc.)** — measuring
only one form has produced real misjudgements (maintenance-review-2026-08 §2.1):

| Notation | Target |
| --- | --- |
| `spec §N` | §N of `ui-framework-spec.md` (**this notation is reserved for ui-framework-spec**) |
| `roadmap MN` / `spec MN` | the MN section of `roadmap.md` (M10+ live in roadmap; spec §15 only holds the initial draft M0–M9; prefer `roadmap MN` for new code) |
| `<doc> §N` / `<doc> <section label>` | The matching section of `docs/design/<doc>.md` or `docs/reviews/<doc>.md` (e.g. `attachments-plan §3.7`, `session-controller-design §5.2`, `display-preset-plan D1-c`, `choiapp-feedback-2026-09 §3.2`). `<doc>` is the file name without the extension, so the notation does not change when the directory does |
| `conventions §N` | §N of this document (section numbers are immutable) |
| `M-review YYYY-MM §N` | §N of `docs/reviews/feature-review-YYYY-MM.md` |
| `CR-N` / `AD-N` | `docs/reviews/maintainability-review-2026-07.md` (§4 and the §7 addendum) |
| `ADR-000N` | `adr/000N-*.md` |
| `Discussion #N` | GitHub Discussion (**provenance notes only** — allowed in an ADR's "Related" line and review-document context notes; never as a normative reference in code or docs body. Body text must stand alone without reading the Discussion. [ADR-0010](adr/0010-discussions-predecision-layer.en.md)) |

## 13. UI text is held through keys (Paraglide) [machine-checked: raw Japanese literals in the app layer] {#i18n-messages}

The **text version** of §9 (raw color/dimension values consolidated in the
theme). Text shown in the UI is placed under keys in `messages/{en,ja}.json`,
and components reference it **through Paraglide** (`import * as m from
'#lib/paraglide/messages.js'` → `m['key']()`; `#lib` is a subpath import from
`package.json`'s `imports`, so the extension is required). Do not hardcode raw text (Japanese
literals, etc.) into components ([ADR-0005](adr/0005-i18n-paraglide.en.md)).

- **The scope is the app layer only** (`apps/admin-template/src`). `@banto/*`
  packages hold neither dictionaries nor i18n dependencies nor `#lib` imports
  (§5); they receive text as resolved strings injected **via the layer-①
  `messages` props** (the layer-① injection method,
  [ADR-0005](adr/0005-i18n-paraglide.en.md)). Do not place `messages/*.json`
  in packages.
- The base/source locale is English (the source of truth for messages), and the
  default **display** locale is Japanese (via the custom-banto strategy in
  `locale.ts`, for zero visual regression, ADR-0005).
- Locale resolution and persistence are confined to the provider/settings layer
  (`locale.ts`) (§10). UI components hold no locale branching.
- The brand name "Banto" is not translated. Locale display names (日本語 /
  English) are held in each language's native name and not translated (a key
  with the same value in both locales).

Current guarantee: that the `.svelte` files under `apps/admin-template/src`
(excluding the generated `paraglide/` and the dictionaries `messages/*.json`)
have no Japanese literals outside comments is checked by grep in
`verify:architecture` (rule `raw-jp-in-app`) (the same shape as the raw-color
check in §9). Legitimate exceptions are added to the script's allowlist with a
reason.

**The app layer may opt out per preset** (display-preset-plan.md D1-c, Issue
#190): when `apps/admin-template/package.json`'s `banto.i18n` is `"raw"`
(default `"keys"` = today's behavior), a single-language app may write UI
strings directly (for a display preset such as a kiosk/standing dashboard).
`@banto/*` packages are unaffected - the layer-① `messages`-props injection
method is unchanged. When `banto.i18n = "raw"`, both `verify:architecture`
(rule `raw-jp-in-app`) and `scripts/check-i18n-nonempty.mjs` skip themselves
and print a reason (both share `readI18nMode` from
`scripts/lib/i18n-mode.mjs`).

## 14. Exclude source-shipped `.svelte.ts` packages from the dev optimizer [machine-checked]

`@banto/*` ship source (`exports` point at `./src/index.ts`, raw `.svelte.ts`
published as-is;
[publishing.md](publishing.md) / [ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.en.md)).
In a derived app they become real node_modules packages, and Vite's dev
dependency optimizer hands `.svelte.ts` to `svelte.compileModule` without
preprocessing, so TS-only syntax like `import type` throws 500 (issue #150).

Invariant: **every `@banto/*` package that source-ships a `.svelte.ts` under
`src/` and is a dependency of `apps/admin-template` MUST be listed in
`apps/admin-template/vite.config.ts`'s `optimizeDeps.exclude`** (kept in sync on
new additions). Packages with only `.svelte` components
(charts/attachments/report) go through the preprocessing path and are exempt.
`@banto/ui` is **not** exempt: it ships `createToastStore()` (`toast.svelte.ts`, #220 phase 2c), so a
derived app that adds `@banto/ui` must list it in `optimizeDeps.exclude` too.
`verify:architecture` (rule `optimizedeps-svelte-source`) machine-checks that
the exclude list matches "the `@banto/*` deps of admin-template that carry a
`.svelte.ts`". The external-consumer fixture (`fixtures/external-consumer/`,
#271) carries the same set in its dependencies, its `+page.svelte` imports and
its exclude (rule `external-consumer-fixture`, which also checks that every
crate under `crates/*` is a Git dependency of the fixture's Rust side). When
adding a new `.svelte.ts`-shipping package or a public crate, add it to the
fixture too.

---

## Process (already covered in other documents)

- **Execution process** (orchestrator design → task splitting → model
  delegation → verification → PR + CI gate):
  [roadmap.md §7](roadmap.md#7-実施プロセス).
- **Feature-addition checklist** (four-condition judgment / documenting removal
  procedure / no reverse dependency / two-path symmetry / test both admin's 403
  and UI hiding):
  [template-scope.md §6](template-scope.md#6-今後の運用ルールと宿題).
- **Form in which extensions are provided** (package + deletable demo + recipe;
  do not build a runtime plugin mechanism):
  [template-scope.md §3.1](template-scope.md#31-今後の機能拡張の提供形態2026-07-15-決定).
- **Distribution** (consumed via git tag / `path:` dependency):
  [publishing.md](publishing.md).
