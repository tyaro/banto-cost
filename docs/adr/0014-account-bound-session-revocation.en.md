# ADR-0014: Bind sessions to "account row id + authentication epoch" and revoke them by checking the database on every request

> 日本語: [0014-account-bound-session-revocation.md](0014-account-bound-session-revocation.md)

- Status: Accepted
- Date: 2026-09-24
- Related: Issue #204, #241 / conventions §1, §6 / roadmap M10, M11 / ADR-0001 (two-path symmetry) /
  ADR-0012 (synthetic viewer session)

## Context

Deleting or demoting a user, or changing/resetting their password, left their
existing sessions working with the permissions they had at login. REST's
`AuthState` stored the login-time `Identity` (role included) on the token and
returned it until expiry, and `RoleGuard` authorized on that role alone. Tauri's
`require_role` likewise authorized on a cached `UserIdentity`. A deleted admin's
old token could create admins for as long as it was unexpired (8 hours normally,
30 days with Remember me).

Constraints:

- It must work on **both paths**, and a change made on one path must affect the
  other path's sessions.
- It must hold across processes (the Tauri app's embedded server, `banto-serve`,
  several servers sharing one PostgreSQL) and restarts. Tokens live only in
  process memory.
- `banto-server` does not know where accounts are stored (`UsersService` is
  injected). Derived apps own their `users` table and service.
- Shorter token lifetimes do not solve it (a window remains).

## Decision

**A session carries the `SessionStamp { account_id, auth_epoch }` it was issued
under, and the account is re-read from the database on every authenticated
request/command.** A missing account, a different row id or a different epoch
revokes the session (401); a match authorizes with the account's **current**
role from the database.

- `users.auth_epoch` is incremented in the **same statement** as a role change,
  a password change and a password reset (no read-then-write split). Deletion
  needs no epoch: the row is gone. Row ids are never reused, so an account
  re-created under the same username does not inherit old sessions.
- REST: every `AuthState` constructor takes a `SessionValidation` as a
  **required argument**. With `SessionValidation::Lookup(re-read)`,
  `require_auth` (`AuthState::authenticate`) checks it; `RoleGuard`, `check`,
  `identity` and `change-password` go through the same check. The unchecked
  `SessionValidation::DisabledNoRevocation` (the old behavior, only for tests
  and servers with no account store, e.g. public-viewer-only) can only be had
  by naming it. There is no default: the old one-argument
  `AuthState::new(verifier)` is a compile error (pinned by a `compile_fail`
  doctest), and there is no after-the-fact installer, so the lookup can be
  neither forgotten nor installed twice.
- Tauri: the window's session is an enum, `DesktopSession::Account` or
  `DesktopSession::AuthDisabledLocal` (the no-login mode's synthetic session).
  `require_role` checks it via `current_session` - the former against its
  `users` row, the latter against no-login mode still being ON (and its
  current role) - and only rewrites the cached session after comparing it
  (compare-and-set). Synthetic sessions are never recognized by a value such as
  `id == 0`, so an account with row id 0 cannot skip the check.
- At login the stamp is read **before** the credential check (argon2), so a
  change committed during verification cannot be outlived by the new token.
- When the database cannot answer, the session is not revoked; only that
  request fails (a transient outage neither logs everyone out nor lets requests
  through).
- A self-service password change keeps only the session that made it, re-bound
  to the new epoch - it has just proven the current password. Every other
  session (other devices, the other path, Remember me) ends. If another change
  interleaved (the epoch advanced by more than one), it is not re-bound.

## Alternatives considered

- **Option A (adopted): row id + authentication epoch in the database, checked
  per request.** Pros: the state lives only in the database, so every process,
  path and restart sees the same result. Demotion takes effect at once (the role
  is read from the database too). `banto-server` only receives a lookup
  function and stays storage-agnostic. Cons: one index read on
  `UNIQUE(username)` per authenticated request - negligible for a LAN admin
  app. No cache: its lifetime would be exactly the revocation delay.
- **Option B (rejected): drop the user's tokens from the in-memory map.** Only
  works in the process holding the tokens. It does not propagate between the
  Tauri app's embedded server, `banto-serve` or several servers, and never
  reaches the Tauri window's session (a separate token space). Persisting tokens
  to the database would propagate, but adds token storage, cleanup and leak
  surface - and still reads the database per request.
- **Option C (rejected): no epoch; only check existence and role per request.**
  Stops deletion and demotion, but password changes/resets leave old sessions
  alive (a session obtained with a leaked password cannot be cut).
- **Option D (rejected): a "sessions issued before this time are invalid"
  timestamp instead of an epoch.** Compares issue and change times across
  process/server clocks, which breaks on clock skew and same-second ordering. A
  monotonic integer epoch compares deterministically.
- **Option E (rejected): shorter token lifetimes.** Narrows the window; does
  not revoke.

## Consequences

- Upgrading **always breaks the build** of a derived app where it constructs
  its `AuthState`. It must then either wire the check in
  (`SessionValidation::Lookup`, `auth_epoch` on `users` plus the writes that
  advance it, and the Tauri-side check) or explicitly choose
  `SessionValidation::DisabledNoRevocation` (migration steps in CHANGELOG),
  which keeps trusting login-time permissions until expiry. The Tauri-side check
  lives in the derived app's own code, so banto's types cannot force it; the
  migration steps and review cover it.
- With a lookup installed, tokens without a stamp (`issue_token`) are rejected
  on first use (fail closed). Paths that create an account and log it straight
  in use `issue_account_token`.
- The synchronous `verify`/`identity_for` look at memory only. Access decisions
  must go through `authenticate` (`require_auth`). `identity_for` is current only
  behind `require_auth` (each check writes the current identity back).
- Synthetic viewer sessions (ADR-0012) have no account and are not checked. The
  Tauri no-login mode's synthetic session is checked against the mode instead of
  an account (turning the mode off ends it on the next command).
- If a lookup disagrees with the epoch the check started from, the session is
  still valid when it was itself re-bound during the check (its own password
  change) and its new epoch matches the database. It is never moved to the
  database's newest epoch unconditionally (sessions that were not re-bound
  still end). REST (`AuthState::authenticate`) and Tauri (`settle_session`)
  decide the same way.
- "Could not verify" is carried to the frontend as distinct from "invalid". A
  `500` from `/api/auth/check` or an unreachable server makes
  `AuthProvider.check()` reject, and the protected-route gate
  (`resolveProtectedSession`) neither goes to the login screen nor switches to
  the viewer; it keeps the token and shows an error with a retry.
- SSE (`/api/events`) is checked when the connection opens, and an open stream
  re-checks its session at the keepalive's interval (15 s,
  `REVALIDATE_INTERVAL`) and ends once it is revoked (Issue #231, owner
  decision 2026-09-24; this was originally a known limitation: "keeps
  receiving notifications until it disconnects"). Notifications stop at most
  one interval (plus one check) after revocation. The verdict is the
  request's (`authenticate`: a session re-bound by its own change during the
  check is kept; when the store cannot answer, the stream is kept and
  re-checked next interval). A check is abandoned after `REVALIDATE_TIMEOUT`
  (5 s, shorter than the interval), which also counts as "could not check"
  and keeps the stream (the abandoned lookup is dropped and never changes the
  session later). The next check is due one interval after the previous one
  FINISHED, so slow checks always leave the delivery its turn (review of
  #234: counting from the check's start let checks slower than the interval
  run back to back and starve the notifications). The re-check does not
  slide the idle window (an open tab does not keep an idle session alive).
  Each stream owns its one deadline (no spawned task), so a disconnect drops
  the deadline and any check in flight.
  Closing a stream immediately when the same process learns of a logout or
  revocation (option C) was not added: every path that ends a token
  (logout, revocation by a check, expiry, public-viewer eviction, a change
  made by another process) would need its own notification, and the
  same-process paths already close within one interval.
- The frontend (`@banto/admin-core`) clears the token and hands the open screen
  to the route guard only when revocation is CONFIRMED (Issue #241).
  `AuthProvider.check()` (HTTP) clears the stored token (the Remember me
  localStorage copy included) on both a `401` and a `200 false`, but only if the
  checked token is still the stored one, so a login made while the check was in
  flight is kept. The SSE client reads the stream with `fetch`, so it sees the status:
  a reconnect answered `401` (`require_auth` looked the session up and found it
  invalid; a failed lookup is a `500`) stops reconnecting with that token and
  sends nothing until a different token (a new login) appears. `connectEvents`
  passes that to `confirmSessionEnded`, which tells `onSessionEnded` listeners
  only when `check()` returns `false` (overlapping confirmations notify once, and a
  signal that arrives while a check is in flight is never settled by that check's
  answer: it is checked again; an ending confirmed while nothing is subscribed -
  during the first protected load, or on the login page - is remembered and
  confirmed again by `check()` when the next listener subscribes, so a new login
  is never logged out by an older ending). A
  confirmation that cannot verify (`500`, unreachable, no answer within 10 s) is
  retried with backoff (1 s doubling to 30 s) while the stream stays stopped for
  the rejected token; a `false` arriving after the 10 s clears the token, and the
  next retry, finding no token, confirms and notifies. When another tab clears
  the shared Remember me token first, the stream notices at its reconnect that
  the token it used is gone and starts the same confirmation (not for the wait
  before the first login, nor for a new login replacing the token; review of
  #242). The app re-runs its route guard there
  (admin-template: `invalidateAll()` in `(app)/+layout.svelte`). A `500`, an
  unreachable server or a stream that ended is retried as before, and the token
  is kept.
- `AuthState::revalidate` is `pub`, exposed to derived apps (Issue #239,
  banto-industrial#430): so a derived app's own long-lived stream (e.g.
  banto-industrial's `/api/tag-stream` / `/api/v1/stream`) can re-check with
  the same verdicts as `authenticate` without sliding the idle window. The
  verdicts are identical to this section's re-check; its doc points callers
  at this crate's own `/api/events` implementation (`events.rs`) for how to
  call it (period, timeout, when to re-arm the next deadline).
