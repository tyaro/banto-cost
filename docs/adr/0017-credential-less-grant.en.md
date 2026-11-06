# ADR-0017: Unify credential-less session issuance into "grants", with viewer-public as the first kind and a derived app's commissioning mode as the second (v3.0.0; no auth-bypass hook in banto)

> 日本語: [0017-credential-less-grant.md](0017-credential-less-grant.md)

- Status: Accepted, implemented in the v3.0.0 PR (banto side: decisions §1-§4 and the admin-template items of the migration guide; the derived apps migrate in tyaro/banto-industrial) (owner decision 2026-10-02; the owner's review of 2026-10-03 (tyaro/banto#313, in favour of the generalization) settled six details, and a further decision the same day **dropped backward compatibility in favour of a single API in v3.0.0 (major)**; the second review of the same PR (against `0df014d`, three items) added the issuance/revocation serialization contract, the retention of #431's stop exception and the admin WebSocket wiring; implementation in the v3.0.0 PR)
- Date: 2026-10-02 (revised 2026-10-03)
- Related: [ADR-0012](0012-lan-public-viewer-synthetic-session.en.md) (viewer-public = a viewer-only synthetic session; this ADR generalizes it; the mechanism decision stands, so it is not superseded) /
  [ADR-0003](0003-tls-via-reverse-proxy.en.md) (same-host reverse proxy; the premise of decision §6) /
  [ADR-0014](0014-account-bound-session-revocation.en.md) (account-bound revocation; grant sessions are outside it) /
  [ADR-0016](0016-session-controller-single-writer.en.md) and [docs/design/session-controller-design.md](../design/session-controller-design.md) §4.7, §6.2, I-13, I-21 (`adopt()`/`end()` are removed) /
  [docs/design/viewer-public-plan.md](../design/viewer-public-plan.md) §2.2 / conventions §1, §6, §10 /
  [docs/upgrading.md](../upgrading.md) (where the migration guide goes) /
  derived apps: banto-hub's "commissioning mode" and chronogazer in tyaro/banto-industrial
- Code under discussion: banto v2.1.1 (`25f2291`). `file:line` references below are to that version

## Context

banto has one entry point that hands out a session without credentials: viewer-public
(ADR-0012). `POST /api/auth/public-viewer` issues a bearer token bound to the fixed identity
`{ id: "public", role: "viewer" }` while `server.viewer_public` is ON
(`crates/banto-server/src/routes/auth.rs:95-105`, `crates/banto-server/src/auth.rs:890-926`).
After issuance the token rides the same `require_auth` + `RoleGuard` + audit path as a login,
skipping only the account check (ADR-0014, `auth.rs:1131-1135`). The implementation is
specific to viewer-public:

- a **one-bit** provenance, `TokenRecord.public_viewer: bool` (`auth.rs:424-425`) and
  `AuthenticatedSession.public_viewer: bool` (`auth.rs:255-262`);
- a FIFO of public tokens only, `Inner::public_tokens` (`auth.rs:577`), capped by
  `MAX_PUBLIC_VIEWER_SESSIONS = 256` (`auth.rs:154`);
- the issuance condition hard-coded in the handler (`routes/auth.rs:98`,
  `SettingsService::server_config().viewer_public`);
- revocation on OFF via `revoke_public_viewer_tokens` (`auth.rs:936-953`), called by the app's
  `save_server_config_locked` (`apps/admin-template/src-tauri/src/lib.rs:2155-2166`);
- on the client, `publicViewerFallback` (`packages/admin-core/src/sessionController.svelte.ts:1150-1218`),
  `AuthProvider.enterPublicViewer` and `status().viewerPublic` (`packages/admin-core/src/provider.ts:129,166-168`,
  `providers/http.ts:537-562`), and `kindOfResolvedAuth` deriving `kind: 'publicViewer'` from the
  `identity.publicViewer` marker (`sessionController.svelte.ts:225-229`).

The derived app banto-hub (tyaro/banto-industrial) solves the same need - a session without
credentials - in a **different shape** for its "commissioning mode": until the server is locked
down, its own authorization in 34 places **lets every request through unauthenticated as a
synthesized admin**, and the front end confirms the commissioning session with
`SessionController.adopt()`/`end()` (design §4.7 S-44 to S-46, the policy runner of §6.2)
without going through the provider. Two problems:

1. **The auth bypass is scattered over 34 places in the derived app.** Requests exist that go
   through none of banto's `require_auth`, `RoleGuard`, audit or SSE re-validation
   (`crates/banto-server/src/events.rs:210`); a missed lock-down check is directly an
   unauthenticated admin surface. This breaks conventions §6 ("authorization is explicit",
   "no auth-bypassing public router" - the reason ADR-0012 rejected its options B and C) in the
   derived app.
2. **An `adopt()`ed session has no token**, so `resolve()` cannot ask the provider (I-13), its
   ticket is epoch-only (I-21) and an SSE 401 cannot trigger a confirmation (S-45). The
   controller keeps an exception to "the provider answers in one round trip" (ADR-0016) in its
   core for a single consumer.

What had to be decided: **what banto offers when a derived app needs an "admin-equivalent
session without credentials"**. Constraints:

- No bypass hook ("skip authentication when this condition holds") in banto. The authorization
  entry stays a single bearer path (do not weaken ADR-0012).
- Condition, cap, revocation and lifetime can be expressed in the same shape as viewer-public
  (only the identity and the condition differ).
- Versioning: the known consumers are admin-template and the two banto-industrial apps
  (banto-hub, chronogazer). Rewriting them once is **simpler than adding compatibility glue**
  (old types, wrappers, URL aliases) - owner decision of 2026-10-03. Per SemVer this breaks
  compatibility, so **major = v3.0.0**.

## Decision

**Generalize viewer-public's "conditional, credential-less token issuance" into a `grant`;
viewer-public becomes the first kind (`publicViewer`) and a derived app's commissioning mode the
second (app-defined, e.g. `commissioning`). The viewer-public-specific API, URL and fields are
removed and everything goes through the grant API (v3.0.0).** Only issuance is generalized;
afterwards the token is an ordinary bearer session through `require_auth` + `RoleGuard` + audit +
SSE re-validation. No bypass hook. The front end drops `adopt()`/`end()` and confirms the
commissioning session with the same fallback as viewer-public (fetch a grant, let the provider
answer).

### 1. Version (v3.0.0, major)

No backward compatibility. The old API, URL and fields are **removed**; no compatibility
functions, old types or aliases are kept (list under "Removed", consumer rewrites under
"Migration to v3.0.0").

### 2. Server (`crates/banto-server`)

```rust
/// A grant kind. An open set defined by the app (not a closed enum).
/// `[A-Za-z][A-Za-z0-9_-]{0,31}`; the same string is used in the URL, in status, in identity.kind and as the client's SessionKind.
pub struct GrantKind(/* Arc<str> */);
impl GrantKind { pub const PUBLIC_VIEWER: &str = "publicViewer"; }

pub type GrantCondition =
    Arc<dyn Fn() -> BoxFuture<'static, Result<bool, BantoError>> + Send + Sync>;

pub struct GrantSpec {
    pub kind: GrantKind,
    /// Fixed. The issuing route accepts no identity/role (the same "no escalation path" property as ADR-0012).
    pub identity: Identity,
    /// Issuance condition, evaluated per request (viewer-public: `server_config().viewer_public`).
    pub enabled: GrantCondition,
    /// Per-kind FIFO cap, default 256. Past it the oldest is revoked.
    pub max_sessions: usize,
    /// `None` = `AuthState`'s default `token_policy` (8h / idle 1h). Never remembered.
    pub policy: Option<TokenPolicy>,
    /// If true the issuing route answers 403 unless the peer is loopback (unknown peer included).
    pub require_loopback_peer: bool,
}
impl GrantSpec {
    /// Viewer-public: identity `public`/`viewer`, condition `server_config().viewer_public`, cap 256, no loopback requirement.
    pub fn public_viewer(settings: SettingsService) -> GrantSpec;
}

/// What `require_auth` puts in the extensions (the old `public_viewer: bool` renamed to `grant`).
pub struct AuthenticatedSession {
    pub identity: Identity,
    pub grant: Option<GrantKind>,
    pub stamp: Option<SessionStamp>,
}

/// Per-kind revocation generation (decision §2 "serializing issuance and revocation").
pub struct GrantGeneration(u64);

impl AuthState {
    /// Read before the issuance check starts.
    pub fn grant_generation(&self, kind: &GrantKind) -> GrantGeneration;
    /// Inserts only if, under the internal lock, `observed` still equals the current generation.
    /// Otherwise inserts nothing and returns `None` (the route answers 403, or re-checks).
    pub fn issue_grant_token(&self, spec: &GrantSpec, observed: GrantGeneration) -> Option<String>;
    /// Under the same internal lock: advance the generation and remove every token of that kind.
    pub fn revoke_grant_tokens(&self, kind: &GrantKind) -> usize;
}

/// Registration of grants and "can this peer obtain one right now" (public part (2)).
pub struct GrantRegistry;
impl GrantRegistry {
    /// Name clashes and reserved words (`account`, `local`, an already registered kind, a malformed identifier) are Err.
    pub fn register(&mut self, spec: GrantSpec) -> Result<(), BantoError>;
    /// The check shared by status and issuance. An unknown peer makes every `require_loopback_peer` kind false.
    pub async fn availability(&self, peer: Option<SocketAddr>) -> BTreeMap<GrantKind, bool>;
}
/// The issuing router (public part (1)): `POST /api/auth/grant/{kind}` only.
pub fn grant_router(auth: AuthState, registry: Arc<GrantRegistry>) -> Router;
```

- **Renames**: `TokenRecord.public_viewer: bool` → `grant: Option<GrantKind>` (`auth.rs:424-425`),
  `AuthenticatedSession.public_viewer: bool` → `grant: Option<GrantKind>` (`auth.rs:255-262`; an
  all-`pub` struct, so consumers that construct it rewrite - see the migration).
  `Inner::public_tokens` (`auth.rs:577`) → `HashMap<GrantKind, VecDeque<String>>` (one FIFO per
  kind; the cap, oldest-first eviction and "never touches a real login" tests at
  `auth.rs:2641-2690` hold per kind).
- **Removed**: `issue_public_viewer_token`, `revoke_public_viewer_tokens` (`auth.rs:890,936`),
  `MAX_PUBLIC_VIEWER_SESSIONS` (absorbed by `GrantSpec.max_sessions`, default 256).
  `PUBLIC_VIEWER_ID` (`"public"`) stays as the id of `GrantSpec::public_viewer`'s identity.
- The JSON of `GET /api/auth/identity` becomes `Identity & { kind: string }` (`kind` = the
  grant string | `"account"`; the `publicViewer` field is **removed**).
- The account-check branch (`if session.public_viewer` at `auth.rs:1131-1135`) becomes
  `if session.grant.is_some()`. Grant sessions carry no stamp and are not looked up
  (outside ADR-0014: the identity is fixed, there is nothing to re-read). SSE re-validation
  (`revalidate`, `auth.rs:1114-1119`, `events.rs:210`) goes through the same function, so a
  stream ends at the next re-check after `revoke_grant_tokens` (generalize the test at
  `events.rs:702-713`).
- The `change-password` refusal (`routes/auth.rs:227`) becomes `grant.is_some()`: a grant
  session owns no credential (even if an account shares the display name).
- **One issuing route, `POST /api/auth/grant/{kind}`** (`grant_router`; `X-Banto-Client` stays
  required via `crate::csrf`). **`POST /api/auth/public-viewer` is removed** (viewer-public is
  `/api/auth/grant/publicViewer`). In order: unregistered `kind` → 404 `not_found`;
  **read `grant_generation(kind)` before the check**; the same check as
  `GrantRegistry::availability` is **re-evaluated at issuance**, and `require_loopback_peer`
  with a peer that is not loopback **or is unknown** → 403 `forbidden` (fail closed);
  `enabled()` → `Ok(false)` → 403, `Err` → that `BantoError` (`ApiError`); otherwise
  `issue_grant_token(spec, observed)` → `{ success: true, token }` if the generation has not
  moved (same body as viewer-public), `None` → 403 if it has (the condition was closed during
  the check; next item but one).
  **Issuance is not audited** (existing policy, `routes/auth.rs:88-94`).
- **The kind identifier stays camelCase, also in the URL** (`/api/auth/grant/publicViewer`). It
  is a kind identifier, not a fixed route name, so `identity.kind`, `status.grants`, the URL and
  the client's `SessionKind` use **the same spelling** (no translation table, no alternative
  spellings). **Name clashes are refused at registration**: the existing session kinds
  `account` and `local`, an already registered kind (registering `publicViewer` twice included)
  and a malformed identifier make `GrantRegistry::register` return `Err`.
- **Peer check**: `ConnectInfo<SocketAddr>` is **always supplied on banto's standard start-up
  paths** (`BoundServer::bind`/`serve` with `into_make_service_with_connect_info::<SocketAddr>()`
  at `crates/banto-server/src/server.rs:128-131`) - banto-serve's `server::start`
  (`server.rs:174`) and the Tauri embedded server (`apps/admin-template/src-tauri/src/lib.rs:1887`,
  `bound.serve(router)`) alike. It is **not guaranteed** for a consumer that starts the public
  `Router` on its own (calling `axum::serve` directly, or a `tower::oneshot` test - the path where
  `MaybePeerAddr` at `auth.rs:1515-1536` yields `None`). Hence **an unknown peer is refused**
  (`false` in status, 403 at issuance). `rest/tests.rs` sets
  `req.extensions_mut().insert(ConnectInfo(addr))` explicitly. The loopback test counts
  IPv4-mapped IPv6 (`::ffff:127.0.0.1`) as loopback (same normalization as around
  `server.rs:264`; IPv6 itself stays out of scope).
- `/api/auth/status` (`routes/auth.rs:37-66`) becomes `{ initialized, grants: { <kind>: bool }, …extras }`.
  **`viewerPublic` is removed** (`grants.publicViewer`). The values come from
  `GrantRegistry::availability(peer)` (**the same check shared by status and issuance**) =
  `enabled()` and (when `require_loopback_peer`) the peer is loopback. Status is **point-in-time
  information**, so issuance always re-checks (above). **An `Err` from one grant's check makes
  that kind `false`** (same fail-closed as viewer-public's "cannot read → do not mint"), but
  **the failure behaviour of status as a whole does not change** (a DB failure in
  `is_initialized` and the like is still an error response; "status never fails" is not
  extended).
- **Only two parts are public**: (1) the issuing router `grant_router`, (2) registration plus the
  availability check, `GrantRegistry`. The status route itself is not included; the existing
  status (the template's `auth_status_handler`, the status a derived app copied) adds the result
  of `availability(peer)` as `grants`. No general plugin mechanism.
  `extra_auth_router` (`routes/auth.rs:296-320`) **changes its signature** to take
  `registry: Arc<GrantRegistry>` (the old signature is removed). The template registers only
  `GrantSpec::public_viewer(settings.clone())`. Derived apps **copy** `extra_auth_router`
  (banto-hub `core/src/rest.rs:983`, chronogazer `core/src/rest.rs:770`), so the copies merge
  `grant_router` and add `availability` to their own status.
- **Revocation and audit**: the operation that closes the condition (viewer-public OFF,
  commissioning lock-down) calls `revoke_grant_tokens(kind)` and may put the returned `usize`
  into its own audit `detail` as `revokedGrants: n` (issuance is not audited; the closing side
  keeps the count instead). The template's `save_server_config_locked`
  (`src-tauri/src/lib.rs:2160-2165`) is rewritten to `revoke_grant_tokens(&GrantKind::PUBLIC_VIEWER)`.
- **Serializing issuance and revocation (contract; second review of #313, P1).** Re-checking at
  issuance alone does not close this race: issuance A reads `enabled() == true` → lock-down B
  saves the flag and completes `revoke_grant_tokens` → A calls `issue_grant_token`. A's token did
  not exist when the revocation ran, so it survives, and since a grant is neither account-checked
  nor re-checked against `enabled` after issuance it keeps working after lock-down. Today's
  viewer-public (`routes/auth.rs:95-105`) also separates the check from the issuance, and the
  issuing side never takes `save_server_config_locked`'s `auth_config_lock`. The contract:
  - **`AuthState` keeps a per-kind generation (`GrantGeneration`).** Issuance is "read the
    generation before the check → check (`availability`; may wait on the DB) → **under
    `AuthState`'s internal lock**, insert only if the generation is unchanged, otherwise insert
    nothing and return `None`". Revocation `revoke_grant_tokens(kind)` is "**under the same
    internal lock**, advance the generation and remove every token of that kind". An issuance
    that read `true`, paused, and resumes after the lock-down completed is not inserted because
    the generation moved. The route turns `None` into 403 (it could re-check, but there is no
    reason to re-mint right after the condition closed).
  - **The side that closes the condition (the app) keeps the order "save the condition →
    `revoke_grant_tokens`".** The reverse (revoke first, save later) leaves a window in which
    `enabled()` still returns `true`; such an issuance is inserted under the post-revocation
    generation and survives. With the save first, a check after the save is `false`, and an
    issuance that read `true` before the save is rejected by the generation advance - neither
    survives. "Right after saving the flag, in the same function" is the implementation of this
    order; the serialization itself is the generation.
  - Alternative compared: **one shared async lock around the whole check-to-issuance, also
    taken by the side that closes the condition.** Correct, but the issuance holds the lock while
    `enabled()` waits on the DB, so lock-down is dragged behind issuance DB waits - a poor fit
    for viewer-public's "issuance is cheap and frequent (every reload)". Ownership of the lock
    would also span the app and `AuthState` (every app would keep the duty of taking its
    `auth_config_lock` equivalent correctly). The generation stays inside `AuthState` and the
    app's duty is only the "save → revoke" order. Not adopted.
  - **The race test is mandatory** (a merge condition of the implementation PR and the
    migration PR): a banto unit test (`auth.rs`: pause an issuance that already read `true`
    right before `issue_grant_token` → `revoke_grant_tokens` on another task → resume → `None`
    is returned and no valid token exists; for viewer-public and for an arbitrary kind) and a
    derived-app (banto-hub) integration test (hold an issuing request after `enabled()` returned
    `true` → complete lock-down (save + revoke) → resume the request → 403, the next `GET /api/auth/identity` answers `200 null` (requests to auth-required resources get 401), and open streams close).

### 3. The self-deletion guard on user deletion

`acting_user` at `routes/users.rs:69-84` resolves the caller's row through token →
`identity_for` → `users.get_by_username`. A grant session's fixed identity has no account, so
this yields `Unauthorized` and an admin-equivalent grant (commissioning) cannot delete users.
Decision:

- `UsersService::delete_user` (`crates/banto-admin-services/src/users.rs:843`) takes the acting
  id as `Option<i64>` (the function name is decided in the implementation PR; no compatibility
  function is kept).
- **"No actor" (no acting id) is accepted only for a verified grant session.** The test is
  `grant.is_some()` on the `AuthenticatedSession` that `require_auth` put in the extensions;
  merely failing to resolve a username from the token stays `Unauthorized`.
- **Admin authorization (`require_role_at_least(Admin)`) and "the last admin cannot be deleted"
  (`ensure_admin_removal_allowed`) are kept.** A grant relaxes only the "own row id" comparison
  of the self-deletion guard (a grant has no row).
- Derived apps copy `UsersService` too (banto-hub `core/src/users.rs:634`), so this change
  reaches them through template intake (path B).

### 4. Client (`@banto/admin-core`)

- `AuthProvider.status()` → `{ initialized, grants: Record<string, boolean> }` (`viewerPublic`
  **removed**). The HTTP provider (`providers/http.ts:434-456`) answers `{}` when the response
  has no `grants` (fail closed).
- `AuthProvider.enterGrant?(kind, { expectRevision })` (`enterPublicViewer` **removed**). The
  HTTP provider POSTs `/api/auth/grant/{kind}` and stores the token with the **same
  compare-and-set** as today's `enterPublicViewer` (`http.ts:537-562`: no token at the start,
  revision still `expectRevision`). The Tauri and demo providers stay unimplemented (same
  reasons as viewer-public, `provider.ts:154-164`).
- `grantFallback(controller, provider, ticket, { kind, available?, maxRetries? })`
  (`publicViewerFallback` and `DEFAULT_PUBLIC_VIEWER_RETRIES` **removed**; the latter becomes
  `DEFAULT_GRANT_RETRIES`). `available(status)` defaults to `status.grants[kind] === true`. The
  loop (`status()` → `isCurrent(ticket)` → `enterGrant({ expectRevision })` → `resolveSettled()`;
  a failure is not retried; only `superseded` is retried with a bound) stays as at
  `sessionController.svelte.ts:1150-1218`. Without `provider.enterGrant` it returns `none`
  (no exception).
- `Identity.publicViewer` is **removed** in favour of `Identity.kind?: string` (the issuer's
  marker). `kindOfResolvedAuth` (`sessionController.svelte.ts:225-229`) **prefers the server's
  `identity.kind`**, then the provider's `kind` (Tauri's `'account'`/`'local'`), then
  `'account'`. The TS `PUBLIC_VIEWER_ID` (`provider.ts:48`) is removed (sessions are told apart
  by `kind`, never by id - conventions §10).
- `sessionOwnerKey` (`sessionController.svelte.ts:200-213`): a grant kind is keyed by **the kind
  alone** (`publicViewer`, `commissioning`, ...; the identity is fixed, so the id adds nothing).
  `local` → `local` and `account:${id}` are unchanged. The old `public-viewer` key and adopt's
  `${kind}:${id}` disappear (saved-state owners change once; nothing is deleted).
- Owner-change comparison is limited to `kind === 'account'` actives (S-108, v2.1.1 #308) and
  does not change: a grant session is a state of the terminal or the app, not "another user".
- **`SessionController.adopt()`/`end()` are removed in v3.0.0** (the only user is banto-hub's
  `commissioningPolicy.ts`), together with the epoch-only `SessionTicket` (I-21), the "while
  adopted" branches of steps 0-7 (I-13, S-44 to S-46, S-53, S-62, S-69 to S-71) and the
  `adopt`/`end` members of `SessionController`. A grant-based commissioning session follows the
  S-42 path (the provider answers, the ticket has a revision, an SSE 401 can trigger a
  confirmation) - noted in [session-controller-design.md](../design/session-controller-design.md).

### 5. Derived-app agreements (for reference; not banto rules)

The shape banto-hub agreed to in this decision (not a banto rule; the starting point of its
migration PR):

- Lock-down is "save the flag → **right after, in the same function**,
  `revoke_grant_tokens("commissioning")`" in that order (the same shape as viewer-public OFF in
  `save_server_config_locked`). The race with concurrent issuance is closed by `AuthState`'s
  generation (decision §2 "serializing issuance and revocation"). Never reverse the order
  (revoking first leaves tokens issued before the save).
- **The failure-time policy for "operations that stop writes" (#431) stays banto-hub's
  responsibility after the migration** (banto-hub item of the migration). It is not moved into
  banto.
- The admin WebSocket's (`/api/tag-stream`) token intake (`Sec-WebSocket-Protocol`) and the
  in-connection re-validation through `SessionStreamCredential` stay, and the grant token is
  connected to the shared `AuthState` validation (banto-hub item of the migration).
- Logout only drops the token. While commissioning, the next navigation silently re-issues one
  through `grantFallback` (commissioning does not end by "logout"; only lock-down ends it).
- Returning to commissioning through elevation does not revoke existing tokens.
- Bootstrap's self-issuance (Rust side) uses the commissioning admin grant via
  `issue_grant_token`.
- `max_sessions` may be smaller than viewer-public's 256 (the fewer admin-equivalent tokens the
  better).
- The reverse-proxy operating conditions (§6) go into the operations guide.

### 6. Behind a same-host reverse proxy (handled by a notice; not technically preventable)

The loopback test only tells the **immediate** connection source and cannot identify the
external client. banto already lists a same-host reverse proxy (ADR-0003, TLS termination) as a
supported configuration; behind it every request looks loopback and `require_loopback_peer`
protects nothing. `X-Forwarded-For` is spoofable and is not consulted. Decision:

- **Handle it with a notice; do not add `trusted_proxies` or similar now** (recorded as a future
  option: a list of trusted proxy addresses on `GrantSpec`, with `X-Forwarded-For` read only
  then; no new dependency, but more surface - not added until a real need appears).
- **This delegates the prevention of misconfiguration to operations; a warning does not prevent
  it technically.** The ADR says so plainly.
- The supported configurations and the set-up guide state at least:
  1. **Lock down before exposing externally** (before the proxy forwards to the outside).
  2. **During re-commissioning as well, never expose the issuing route of an admin-equivalent
     grant (`/api/auth/grant/{kind}`) through the proxy** (block that path at the proxy, or stop
     the proxy while commissioning).
- Where it is written: **banto side** - the README section on LAN serving / reverse proxy
  (since 2026-10-08: [recipes/lan-access.md](../recipes/lan-access.md))
  (ADR-0003's supported configuration) and the grant item of conventions §6 (implementation PR).
  **Derived-app obligations** (not touched by banto's PR): the same two points in banto-hub's
  operations guide §19 and tag-server-design §5.6.
- banto-hub is in commissioning mode when the setting is absent (so an admin-equivalent grant is
  issuable at first start). Changing that default to OFF is **a separate design decision**,
  outside this ADR.

## Security

- **The entry shrinks to one route.** The only unauthenticated request that passes is the
  issuance at `POST /api/auth/grant/{kind}`; afterwards the token rides the existing
  `require_auth`, `RoleGuard`, audit and SSE re-validation (`events.rs:210`) without exception.
  The derived app's 34 bypasses disappear by concentrating the trust decision in one place
  (`GrantSpec.enabled`).
- **The condition is explicit.** Everything that permits issuance is written in `GrantSpec`
  (kind, fixed identity, condition, cap, lifetime, loopback); review starts there. Viewer-public's
  "takes no identity/role argument" (`auth.rs:872-877`) is kept: the issuing route accepts
  neither an identity nor a role from the client.
- **Per-kind revocation.** `revoke_grant_tokens(kind)` removes only that kind, never real logins
  or other grants (generalizing the test at `auth.rs:2595-2612`). `AuthState` outlives server
  restarts (comment at `lib.rs:2162`), so the operation that closes the condition always revokes.
- **Lifetime stays default** (8h / idle 1h, never remembered). When it lapses the screen silently
  re-issues (as viewer-public; generalize the test at `auth.rs:2629`). No long-lived tokens are
  handed out.
- **Stream re-validation is one path.** `revalidate` → `authenticate_with` → `session_for_with`,
  so a grant's stream closes at the next re-check after revocation. The adopt design had no
  such hook. A derived app's WebSocket (bearer carried in `Sec-WebSocket-Protocol`) rides the
  same path as long as the extracted token is connected to the same `AuthState` validation
  (migration).
- **Issuance and revocation are serialized by a generation.** Re-checking at issuance alone
  leaves the race "an issuance that already read `true` is inserted after lock-down completed".
  Under `AuthState`'s internal lock, issuance inserts only if the generation matches and
  revocation advances it while removing (decision §2). The side that closes the condition keeps
  the order "save → revoke". The race test is mandatory in banto and in the derived app.
- **The exception that lets only "operations that stop writes" through during a DB failure
  (banto-industrial #431) is not brought into banto.** Grant sessions skip the account check, so
  even during a DB failure a stop from the commissioning grant passes ordinary validation. The
  exception for account sessions (distinguishing unverifiable from confirmed-revoked, the check
  timeout, stop-only) remains banto-hub's responsibility (migration).
- **Caveat 1: an admin-equivalent bearer is stored in the browser.** A commissioning grant token
  sits in `sessionStorage` like viewer-public's. It must be unusable after lock-down, so
  **the derived app pins "lock-down → the next request is 401 → the SSE closes" in tests**
  (banto covers `revoke_grant_tokens` unit tests and the SSE re-validation test).
- **Caveat 2: without `require_loopback_peer` the only protection is the bind constraint at
  start-up.** A commissioning grant with `require_loopback_peer: false` on a LAN-bound server
  hands an admin-equivalent token to anyone on the LAN. banto does not enforce the condition
  (the app's `GrantSpec` decides), so it is a review item of the derived app's migration PR.
- **Caveat 3: behind a reverse proxy the peer is the proxy.** Handled by a notice as in decision
  §6, stating plainly that it is not technically preventable.
- Audit: issuance is not audited (existing policy). Operations of a grant session are recorded
  with the fixed identity's id as actor (as `public` for viewer-public). ui-settings under
  `ui.<identity.id>.*` are shared by terminals of the same kind (`routes/ui_settings.rs:31-36`;
  same nature as viewer-public's `ui.public.*`).

## Removed (v3.0.0)

| Removed                                                                                                            | Replacement                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `POST /api/auth/public-viewer`                                                                                     | `POST /api/auth/grant/publicViewer`                                                  |
| `viewerPublic` in `GET /api/auth/status`                                                                           | `grants.publicViewer`                                                                |
| `publicViewer` in `GET /api/auth/identity`                                                                         | `kind` (`"publicViewer"` / `"commissioning"` / `"account"`)                          |
| `AuthenticatedSession.public_viewer: bool`                                                                         | `AuthenticatedSession.grant: Option<GrantKind>`                                      |
| `AuthState::issue_public_viewer_token` / `revoke_public_viewer_tokens`                                             | `issue_grant_token(&GrantSpec, GrantGeneration)` / `revoke_grant_tokens(&GrantKind)` |
| `MAX_PUBLIC_VIEWER_SESSIONS`                                                                                       | `GrantSpec.max_sessions` (default 256)                                               |
| `extra_auth_router(users, auth, audit, allow_setup, settings, extras)`                                             | the signature taking `registry: Arc<GrantRegistry>` (+ `grant_router`)               |
| `UsersService::delete_user(id, i64)`                                                                               | the form taking the acting id as `Option<i64>` (name: implementation PR)             |
| `publicViewerFallback` / `DEFAULT_PUBLIC_VIEWER_RETRIES`                                                           | `grantFallback(…, { kind })` / `DEFAULT_GRANT_RETRIES`                               |
| `AuthProvider.enterPublicViewer` / `status().viewerPublic`                                                         | `enterGrant(kind, …)` / `status().grants`                                            |
| `Identity.publicViewer` / TS `PUBLIC_VIEWER_ID`                                                                    | `Identity.kind`                                                                      |
| the `public-viewer` owner key of `sessionOwnerKey` and adopt's `${kind}:${id}`                                     | the grant kind alone                                                                 |
| `SessionController.adopt()` / `end()`, the epoch-only `SessionTicket`, the "while adopted" branches                | `grantFallback` + the provider's answer (the S-42 path)                              |
| `POST /api/auth/public-viewer` in `verify-architecture` rule 8 `REST_ONLY` (`scripts/verify-architecture.mjs:326`) | `POST /api/auth/grant/{kind}` (the Tauri window has no "enter a grant" operation)    |

The `server.viewer_public` setting key, the two-way guard in `SettingsService`
(viewer-public-plan §2.3) and the `NavItem` public-screen allowlist **stay** (they are the
viewer-public specification, not its API; whether the allowlist field becomes kind-based is for
admin-template's implementation PR). The "synthetic viewer session" item of `conventions §6` and
the rules in `viewer-public-plan §2.2` are rewritten in the implementation PR as "grants
(viewer-public is one kind)" - this ADR is the decision, the normative text lives in conventions.

## Migration to v3.0.0 (what derived apps rewrite)

The formal guide is added to the "examples" of [docs/upgrading.md](../upgrading.md) in the
implementation PR (same shape as example 2, v2.0.0: path A (`@banto/*`, `banto-*` versions) and
path B (the copied template) together; breaking). Here is **what** each consumer rewrites.

Common (Rust):

1. Construction and reads of `AuthenticatedSession { public_viewer, .. }` → `grant: Option<GrantKind>`.
2. `issue_public_viewer_token()` → the procedure in decision §2 "Serializing issuance and revocation" (read the generation with `grant_generation(kind)` before the check → evaluate the condition → `issue_grant_token(&spec, observed)` → treat `None` as a refusal). The issuing endpoint lives in `grant_router`, so only a copied router calls it directly;
   `revoke_public_viewer_tokens()` → `revoke_grant_tokens(&GrantKind::PUBLIC_VIEWER)`.
3. `extra_auth_router(...)` → build a `GrantRegistry` and pass it to the new signature. A copied
   router merges `grant_router(auth, registry)`, adds `availability(peer)` as `grants` to its
   own status response and drops `viewerPublic`.
4. `users_delete` resolves the acting id by `AuthenticatedSession.grant` (`None` for a grant)
   and follows the new shape of `UsersService::delete_user`.

Common (TS):

5. `publicViewerFallback(controller, provider, ticket)` →
   `grantFallback(controller, provider, ticket, { kind: 'publicViewer' })`.
6. `provider.enterPublicViewer(...)` → `provider.enterGrant('publicViewer', ...)`,
   `status().viewerPublic` → `status().grants.publicViewer`. A custom `AuthProvider` implements
   `enterGrant` and `status().grants`.
7. Reads of `identity.publicViewer` (logout flow, header, navigation) → `snapshot.kind`
   (`'publicViewer'`). Drop references to the TS `PUBLIC_VIEWER_ID`.
8. Saved-state keys that assumed `sessionOwnerKey`'s `public-viewer` → `publicViewer`.

admin-template (banto itself; rewritten in the same implementation PR):
`apps/admin-template/core/src/rest/mod.rs:335` (the `extra_auth_router` call),
`core/src/rest/tests.rs:2958-3160,3280` (the `public_viewer_*` /
`auth_status_reports_viewer_public_*` tests), `core/src/bin/banto-serve.rs` and
`core/src/first_boot.rs` (the display preset's first-boot seed; the setting key stays),
`src-tauri/src/lib.rs:2160-2165,4531,6765` (`save_server_config_locked`, `extra_auth_router`,
tests), `src/routes/(app)/+layout.ts:6,44` (`publicViewerFallback`), `src/lib/session.svelte.ts`,
`src/lib/banto/logout.svelte.ts`, `src/lib/components/{Header,Sidebar}.svelte`,
`src/lib/navigation.ts`, `src/lib/recentCommands.ts`, `src/routes/(app)/+layout.svelte`,
`src/routes/login/+page.svelte`, `src/routes/(app)/settings/{Account,Connectivity}Section.svelte`
(reads of `identity.publicViewer` / `viewerPublic`), `packages/admin-core` (`provider.ts`,
`providers/http.ts`, `providers/legacyAdapter.ts`, `sessionController.svelte.ts`,
`sessionScope.svelte.ts`, `index.ts`, `tests/*`), `scripts/verify-architecture.mjs:326`,
`scripts/lib/templates/display/{monitor/+page.svelte,smoke.spec.ts}`, `scripts/scaffold.mjs`,
`e2e/tests-public-viewer/public-viewer.spec.ts`, `e2e/tests/{smoke,tauri-settings-drafts}.spec.ts`,
`e2e/playwright.config.ts`.

banto-hub (tyaro/banto-industrial):

- Rust: `core/src/stream.rs:1670-1676` (`AuthenticatedSession { public_viewer: false, .. }` →
  `grant: None`), `core/src/rest.rs:983` (the copied `extra_auth_router`: merge `grant_router`,
  add `grants` to status, register the commissioning `GrantSpec` - kind `commissioning`, fixed
  admin identity, condition = not locked down, `require_loopback_peer: true`, a small
  `max_sessions`), `core/src/rest.rs:773` and `core/src/users.rs:634` (the acting id of
  `delete_user`), revocation in the lock-down save function in the order "save →
  `revoke_grant_tokens("commissioning")`", bootstrap's self-issuance.
- Rust (`require_auth_or_commissioning`, `core/src/rest.rs:171-344`): **only the
  "credential-less commissioning branch" is removed** (the early return on `!is_locked_down()`,
  `CommissioningStreamCredential`, the per-request synthesized identity - the substance of the
  34 bypasses). **What stays (banto-industrial #431; not moved into banto)**:
  `OperationKind::StopWrites`, the distinction in `SessionCheck` between unverifiable
  (`Unverified`) and confirmed-revoked (`Revoked`), the `session_gate_decision` table,
  `STOP_SESSION_CHECK_TIMEOUT` (5 s), the `UnverifiedStopException` audit marker, and the
  application to `POST /api/write-control/disable` only (`rest.rs:1765-1824`,
  `WRITE_CONTROL_DISABLE_OPERATION`). banto's `require_auth` (`auth.rs:1562-1572`) returns
  `authenticate`'s error as-is and has no check timeout, so replacing the gate wholesale would
  reintroduce #431 (a DB failure in normal operation rejects, or hangs, the write stop). After
  lock-down the gate keeps calling `AuthState::authenticate` (grant sessions skip the account
  check, so even during a DB failure a stop from the commissioning grant is `Valid`). The
  existing tests - a confirmed-revoked session is refused, the exception is not widened to
  resume (`/api/write-control/enable`) and the like, the 5 s cut-off - are kept.
- Rust (admin WebSocket `/api/tag-stream`): a browser WebSocket cannot set `Authorization`, so
  the bearer extraction through `extract_ws_protocol_token` (`Sec-WebSocket-Protocol: bearer,
<token>`, exact-match path allowlist, `rest.rs:259-269,297-299`) **stays**, and so does
  attaching `SessionStreamCredential` to the passing request (`rest.rs:327-335`) - `ws_upgrade`
  (`stream.rs:529-552`) builds its `Revalidator` from that extension and does not re-validate
  without it; fixing only the intake and dropping this connection would leave streams open
  after lock-down. The extracted grant token is connected to the shared `AuthState` validation
  (`authenticate` / `revalidate`). `CommissioningStreamCredential` (#440, token-less streams)
  becomes unnecessary (commissioning streams open with the grant token and re-validate through
  `SessionStreamCredential`). Tests: a browser-style connection (`Sec-WebSocket-Protocol`) with a
  grant token succeeds, and the re-validation after lock-down (save → revoke) closes it.
- Rust (race test, mandatory): hold an issuing request after `enabled()` returned `true` →
  complete lock-down → resume → 403, the next `GET /api/auth/identity` answers `200 null` (requests to auth-required resources get 401), and the open
  SSE / WebSocket closes at re-validation (decision §2 "serializing issuance and revocation").
- TS: `src/lib/banto/commissioningPolicy.ts`, `commissioningLockDown.ts` (+ `.test.ts`),
  `sessionRecheck.abort.test.ts` (retire the policy runner and `adopt()`/`end()` →
  `grantFallback(…, { kind: 'commissioning' })` after the `none` in `src/routes/(app)/+layout.ts`;
  lock-down = `revoke` → the next request is 401 → `resolve()` confirms `none`),
  `src/lib/session.svelte.ts`, `src/lib/banto/logout.svelte.ts`, `hubLogout.test.ts`
  (`identity.publicViewer` → `snapshot.kind`; logout only drops the token).
- Operations docs: the two points of decision §6 in the operations guide §19 and
  tag-server-design §5.6.

chronogazer (tyaro/banto-industrial):

- Rust: `core/src/rest.rs:538` (the acting id of `delete_user`), `core/src/rest.rs:770` (the
  copied `extra_auth_router` → `grant_router` + `grants` in status; the only grant is
  `publicViewer`).
- TS: `src/routes/(app)/+layout.ts`, `src/lib/session.svelte.ts` (+ `session.test.ts`),
  `src/lib/banto/logout.svelte.ts`, `src/lib/banto/{hubAdmin,sessionGuard}.test.ts` (reads of
  `identity.publicViewer` / `viewerPublic` / `publicViewerFallback`).

## Alternatives considered

- **Option A (adopted): generalize viewer-public issuance into grants, make commissioning the
  second kind, and remove the viewer-public-specific API so there is one API (v3.0.0).**
  Pros: the unauthenticated entry shrinks to one issuing route. Condition, cap, revocation,
  lifetime and re-validation work with the same code as viewer-public, and the tests
  (`auth.rs:2550-2700`, `rest/tests.rs:3023-3160`, `events.rs:702`) generalize over a kind
  parameter. The front end loses the `adopt()` exception path and becomes the single S-42 path.
  Viewer-public and commissioning run through the same code, so a fix to one cannot miss the
  other. Cons: every consumer rewrites once (migration). An admin-equivalent bearer sits in the
  browser (caveat 1). A weak condition in `GrantSpec` stays weak (caveats 2, 3) - but it is far
  easier to inspect than today's 34 scattered bypasses.
- **Option A′ (rejected, owner decision of 2026-10-03): ship it as a backward-compatible minor
  (v2.2.0).** Keep the old API, URL and fields as wrappers/aliases, leave `AuthenticatedSession`
  untouched and add a new validation-result type carrying the grant, keep viewer-public on the
  old path and use the new API only for new kinds. Rejected because the consumers are limited to
  admin-template and the two banto-industrial apps, and rewriting them once is simpler than
  adding compatibility glue (old and new types side by side, two fallbacks, two URLs, a
  compatibility matrix). Keeping compatibility also means the all-`pub` `AuthenticatedSession`
  cannot be touched (renaming or adding a field breaks literal construction) and viewer-public
  and commissioning keep running through different code.
- **Option B (rejected): add a hook to `require_auth` that "skips authentication and inserts a
  synthetic identity while a condition holds"** (moving banto-hub's current shape into banto).
  Rejected for the same reasons as ADR-0012's option C: an "implicit identity" branch in the
  middleware, a second path next to `actor_identity`/`identity_for` (`routes/mod.rs:93`) which
  are written around a token. SSE re-validation (per token) would not apply, lock-down's
  "immediate revocation" could not be expressed as one `revoke_*` call, and with no token there
  is nothing to "silently re-issue". It widens what verify-architecture does not cover.
- **Option C (rejected): do nothing (the derived app keeps its own).**
  banto keeps maintaining the 34 bypasses and the controller-internal adopt branches
  (the "while adopted" column of §5.1 steps 0-7, I-13, I-21, S-44 to S-71) for one consumer.
  The end of commissioning stays unconfirmable through SSE re-validation / 401 (S-45). It also
  contradicts banto-industrial's policy of folding duplicate implementations into banto.
- **Option D (rejected): a second, commissioning-specific issuing route
  (`/api/auth/commissioning`) in banto.**
  A copy of viewer-public's code differing only in condition and identity, to be copied again for
  a third kind; banto would also carry a derived app's domain word (commissioning). The
  generalization (A) is smaller.
- **Option E (rejected, future option): a `trusted_proxies` field on `GrantSpec` that trusts
  `X-Forwarded-For`.** It would technically complement the loopback test behind a reverse
  proxy, but adds surface. Not added until a real need appears; handled by a notice (decision §6).

## Consequences

- **The issuing route accepts neither identity nor role from the client.** `GrantSpec.identity`
  is fixed and the route takes only `kind`. Review starts there (as in ADR-0012).
- **Whatever closes the condition calls `revoke_grant_tokens(kind)` in the same function, in the
  order "save the condition → revoke".** The issuance condition (`enabled`) and the revocation
  call come in pairs (the template: viewer-public OFF; the derived app: lock-down). The race
  with concurrent issuance is closed by `AuthState`'s generation. **The race test (an issuance
  that already read `true`, paused, resumed after the revocation completed, leaves no valid
  token) is mandatory both as a banto unit test and as a derived-app integration test.**
  `revokedGrants: n` may go into the audit detail.
- **The DB-failure exception for "operations that stop writes" (#431) and the admin WebSocket's
  token intake and in-connection re-validation remain banto-industrial's responsibility.** The
  migration removes only the credential-less commissioning branch.
- **Admin-equivalent grants default to `require_loopback_peer: true` and a small
  `max_sessions`, and the reverse-proxy operating conditions (the two points of decision §6) go
  into the set-up guide** (a review item of the derived app's migration PR).
- **Viewer-public and commissioning run through the same code.** A change to viewer-public is a
  change to grants as a whole and is verified for both by tests parametrized over the kind.
- The front end confirms commissioning through `grantFallback` and the provider's answer.
  `adopt()`/`end()` and the "while adopted" branches are removed (the controller is back to the
  single "the provider answers in one round trip").
- Adding a kind is registering one `GrantSpec` in the `GrantRegistry`; banto's routes and the
  verify-architecture classification do not grow (`/api/auth/grant/{kind}` is one route). Name
  clashes and reserved words are `Err` at registration.
- v3.0.0 is a breaking change where path A (versions) and path B (the copied template) go
  together. An example is added to [docs/upgrading.md](../upgrading.md); the CHANGELOG carries
  the removal list and the migration steps.
- Tests (S-number policy): session-controller-design.md allots **S-109 onwards** to grants
  (S-42 generalized over the kind, the grant versions of S-44 to S-46, "revoked → 401 → the
  fallback silently re-issues", "condition false → 403 → stays `none`", "a provider without
  `enterGrant` → `none`"). Rust: parametrize the `public_viewer_*` tests in `auth.rs` over the
  kind; in `rest/tests.rs` add `grant/{kind}` 404 / loopback 403 / unknown-peer 403 /
  condition 403 / issuance → `kind` on identity / refusal of reserved names at registration /
  agreement between status `grants` and the issuance check / `users_delete` from a grant
  session (the last admin is refused); in `events.rs` the stream closes at the re-check after
  revocation. The E2E `e2e/tests-public-viewer/public-viewer.spec.ts` is rewritten to the new
  URL and `grants`.

## Open points

None (decided 2026-10-03; the six items of review tyaro/banto#313 landed as: (1) → decision §1,
§2 and option A′, (2) → decision §2 "only two parts are public", (3) → decision §6 and option E,
(4) → decision §2 "the kind identifier", (5) → decision §2 "`/api/auth/status`", (6) → decision
§3). Function naming (the new shape of `delete_user`, the new signature of `extra_auth_router`)
is settled in the implementation PR (not a design open point).
