# ADR-0012: Implement LAN "viewer-public" as a viewer-only synthetic session, not an auth-bypassing public router

> 日本語: [0012-lan-public-viewer-synthetic-session.md](0012-lan-public-viewer-synthetic-session.md)

- Status: Accepted
- Date: 2026-09-14
- Related: Issue #189 / [docs/design/viewer-public-plan.md](../design/viewer-public-plan.md) /
  conventions §1, §6, §10 / roadmap M10, M11 / ADR-0001 (two-path symmetry)

## Context

Display-only apps (andon boards, always-on dashboards, exhibition demos) are
normally "one desktop writes, LAN devices watch without logging in". M11's
no-login mode is limited to the Tauri window, and "auth disabled + LAN server
enabled" is rejected by settings validation (2026-07-08 decision: "never expose
the LAN side unauthenticated"). A private project had to reinvent, in its app
layer, a `server.viewerPublic` setting, a read-only REST tree `/api/viewer/*`,
a widened login gate and a response-rewriting layer over `auth/status`.

What had to be decided is the **mechanism** that lets LAN clients view without
logging in. Constraints:

- The write surface (mutating routes) must never be reachable from the LAN
  without authentication (the intent of the original decision).
- conventions §1 (every mutating operation goes through identical
  authorization + audit on REST and Tauri) and §6 must not weaken; every new
  authorization path widens what rule 8's machine check does not cover.
- The existing APIs viewing needs (SSE `/api/events`, `/api/ui-settings/*`,
  attachment thumbnails/downloads, items list/get) must keep working as-is.

## Decision

**When `server.viewerPublic` is ON, `POST /api/auth/public-viewer` issues a
bearer token bound to the fixed identity `{ id: "public", role: "viewer" }`.**
LAN clients pass the existing `require_auth` + `RoleGuard` with that token and
use the read APIs as the `viewer` role. Mutating routes are rejected with 403 by
the existing RBAC and audited as `denied`. No auth-bypassing router is added.
The normative text lives in conventions §6 (synthetic viewer session rules).

## Alternatives considered

- **Option A (adopted): viewer-only synthetic session.**
  Pros: authorization, audit, SSE and ui-settings work unchanged; explainable
  in the vocabulary of M10 ("viewer = display-only role") and M11 ("synthetic
  identity + role"); verify-architecture only needs one REST-only route
  classified.
  Cons: an anonymous device reaches **everything** the `viewer` role may read
  (the screen allowlist `NavItem.publicViewer` only narrows the UI). Accepted
  because in a display-only app the viewer read surface _is_ the public
  surface. Token issuance needs no credentials, so a cap on concurrent
  sessions prevents unbounded growth.
- **Option B (rejected): merge an auth-bypassing read-only public router into
  `api_router` (the original proposal in #189).**
  Every read API to be exposed would have to be **duplicated** into the public
  router (publishing items list means growing a separate
  `/api/public/items/list`), creating a second read path outside RBAC. The
  frontend would have to model a "no token" state in the provider layer (SSE,
  ui-settings and attachments would 401), effectively adding a fourth mode to
  `getBantoMode()`'s three. A machine check would also be needed to keep
  mutating routes out of the public router.
- **Option C (rejected): make `require_auth` itself treat "viewerPublic ON and
  no bearer" as the synthetic viewer.**
  Same public surface as A, but `actor_identity`/`identity_for` are written
  around a token, and adding an "implicit identity" branch to the middleware
  goes against §6's "authorization is explicit" style. With A the public
  session rides the ordinary bearer path with no special casing.
- **Option D (rejected): extend M11 to the LAN and apply the synthetic
  session's role there too.**
  The role could be `admin`/`editor`, putting the write surface on the LAN —
  exactly what the original decision forbids.

## Consequences

- The synthetic viewer token is **always `viewer`**. `issue_public_viewer_token()`
  takes no `Identity`/role argument (there is no escalation path). Reviewers
  look here first.
- Issuance is not audited (it is not a credential check). `denied` entries for
  mutating attempts are recorded by the existing `RoleGuard` with actor
  `public`. Anyone on the LAN can accumulate `denied` rows; audit retention
  (M14 prune) keeps that bounded.
- "auth disabled + LAN enabled" is allowed only while viewer-public is ON; with
  it OFF the 2026-07-08 exclusivity stays.
- The public **screen** surface is narrowed by the `NavItem.publicViewer`
  allowlist (default: dashboard and items). The **data** boundary is RBAC's
  `viewer` role. A read that should be hidden from viewers is an RBAC (role
  floor) problem, not a viewer-public one.
- ui-settings under `ui.public.*` are shared by every public device (same
  nature as desktop M11's `ui.local.*`).
- Beyond `MAX_PUBLIC_VIEWER_SESSIONS` (256) the oldest session is evicted.
  When a token expires the frontend gate re-issues one transparently.
