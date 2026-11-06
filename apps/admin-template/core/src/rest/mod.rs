//! REST surface for the embedded server (spec §11.1): exposes the same
//! `ItemsService` used by `src-tauri`'s `items_*` commands over HTTP, so a
//! LAN browser's `HttpDataProvider` (Phase B,
//! `packages/admin-core/src/providers/tauri.ts` is the wire contract it
//! must match) hits the exact same service layer and DB.
//!
//! ## Route table
//!
//! | Method | Path               | Body           | Response              |
//! |--------|--------------------|----------------|------------------------|
//! | GET    | `/api/auth/status`   | -              | `{initialized,grants}` (NO auth required) |
//! | POST   | `/api/auth/setup`     | `{username,password,displayName}` | `{success,error?,token?}` (needs `allow_setup`) |
//! | POST   | `/api/auth/grant/{kind}` | -          | `{success,token}` (NO auth required; 404 unless `kind` is registered, 403 unless its condition holds - `publicViewer` = `server.viewer_public`, ADR-0017) |
//! | POST   | `/api/reach-check`   | `{token}`      | `{result}` (NO auth required, never a session; Tauri embedded server only - `banto_server::reach_check`, Issue #219) |
//! | POST   | `/api/auth/login`    | `{username,password}` | `{success,error?,token?}` |
//! | POST   | `/api/auth/logout`   | -              | 200                    |
//! | GET    | `/api/auth/check`    | -              | `bool`                 |
//! | GET    | `/api/auth/identity` | -              | `Identity \| null`     |
//! | POST   | `/api/auth/change-password` | `{currentPassword,newPassword}` | `{success}` (auth required) |
//! | GET    | `/api/events`        | -              | SSE stream of `ServerEvent` |
// [scaffold:items] begin (Route table doc rows)
//! | POST   | `/api/items/list`    | `ListParams`   | `ListResult<Item>` (any role) |
//! | GET    | `/api/items/{id}`    | -              | `Item` (any role)      |
//! | POST   | `/api/items`         | `ItemInput`    | `Item` (editor+)        |
//! | PUT    | `/api/items/{id}`    | `ItemInput`    | `Item` (editor+)        |
//! | DELETE | `/api/items/{id}`    | -              | 204 (editor+)           |
//! | POST   | `/api/items/import`  | `ItemImportRow[]` | `ImportResult` (editor+, spec M15) |
// [scaffold:items] end
//! | GET    | `/api/users`         | -              | `UserSummary[]` (admin) |
//! | POST   | `/api/users`         | `{username,password,displayName,role}` | `UserIdentityResponse` (admin) |
//! | PUT    | `/api/users/{id}`    | `{displayName,role}` | `UserSummary` (admin) |
//! | POST   | `/api/users/{id}/reset-password` | `{newPassword}` | `{success}` (admin) |
//! | DELETE | `/api/users/{id}`    | -              | 204 (admin)             |
//! | GET    | `/api/authz/me`      | -              | `{capabilities,memberships}` (any role; ADR-0028) |
//! | GET    | `/api/users/{id}/capabilities` | -    | `Capability[]` (admin; ADR-0028) |
//! | PUT    | `/api/users/{id}/capabilities` | `{capabilities}` | `Capability[]` (admin; ADR-0028) |
//! | GET    | `/api/projects/{id}/members` | -      | `ProjectMember[]` (admin, or `ViewProject` on that project; ADR-0028) |
//! | PUT    | `/api/projects/{id}/members/{userId}/{kind}` | - | `ProjectMember[]` (admin; ADR-0028) |
//! | DELETE | `/api/projects/{id}/members/{userId}/{kind}` | - | 204 (admin; ADR-0028) |
//! | GET    | `/api/ui-settings/{key}` | -          | `{value: string \| null}` (any role) |
//! | PUT    | `/api/ui-settings/{key}` | `{value}`  | 204 (any role)          |
//! | POST   | `/api/audit-log/list?asOfId=` | `ListParams` | `AuditLogList` (`ListResult` + `asOfId`/`deletionEpoch`, admin; #248) |
//! | GET    | `/api/audit-log/config` | -            | `AuditSettings` (admin) |
//! | PUT    | `/api/audit-log/config` | `AuditSettings` | `AuditSettings` (admin) |
//! | GET    | `/api/system/info`   | -              | `SystemInfo` (admin, M-review 2026-08 §2.4) |
//! | POST   | `/api/backups`        | -              | `BackupInfo` (admin, spec M17) |
//! | GET    | `/api/backups`        | -              | `BackupInfo[]` (admin)  |
//! | GET    | `/api/backups/{fileName}` | -          | raw bytes, `Content-Disposition: attachment` (admin) |
//! | POST   | `/api/backups/restore?fileName=` | raw bytes (`application/octet-stream`) | 204 (admin) |
//! | POST   | `/api/backups/{fileName}/restore` | -   | 204 (admin)             |
//! | GET    | `/api/backups/pending-restore` | -      | `PendingRestoreInfo \| null` (admin) |
//! | DELETE | `/api/backups/pending-restore` | -      | 204 (admin)             |

//!
//! ## Where each router lives (theme C PR-C4, docs/template-scope.md §7 移行順 ④)
//!
//! The table above stays here - it is the artifact conventions §1 designates
//! as the REST side of the Tauri⇔REST correspondence table, and
//! `scripts/verify-architecture.mjs` rule 8 anchors on it. The router
//! IMPLEMENTATIONS, however, are split by who owns them:
//!
//! - App-specific, and therefore this crate's: `items` (`/api/items/*`,
//!   the demo resource a template adopter replaces) and `attachments`
//!   (`/api/attachments/*`, M20 - `resource`/`resourceId` are app data).
//! - Domain-agnostic, and therefore `banto_server::routes`: the
//!   `/api/auth/*` extras, `/api/users/*`, `/api/audit-log/*`,
//!   `/api/backups/*` and `/api/ui-settings/*`. Identical in every adopter,
//!   so they are a dependency rather than copied code. The RBAC/audit
//!   helpers the app's own routers use ([`RoleGuard`],
//!   [`require_role_at_least`], [`record_write`], [`actor_identity`]) come
//!   from there too.
//!
//! [`api_router`] below is the assembly: it owns the `.merge()` order,
//! the CSRF layer, and nothing else.
//!
//! `/api/ui-settings/*` (spec M12 SettingsProvider migration): per-user UI
//! settings (theme/preset/dock layout), namespaced by the caller's own
//! `username` (`SettingsService::ui_get`/`ui_set` - see that module for the
//! `ui.{username}.{key}` storage key scheme). Guarded by `require_auth`
//! alone - unlike `items`/`users`, there is no role floor: a `viewer` may
//! freely read/write their OWN UI preferences, they just cannot touch
//! anyone else's (there is no way to name another user's key over this
//! wire - `username` always comes from the caller's own bearer token, never
//! a request parameter).
//!
//! `/api/auth/status`, `/api/auth/setup` and `/api/auth/grant/{kind}` are
//! deliberately NOT behind `require_auth` - the login page needs `status`
//! before any session exists, `setup` is how the very first session gets
//! created, and `grant/{kind}` is how a credential-less session (ADR-0017)
//! obtains its first token. Each of the latter two carries its own gate
//! instead of a bearer token: `setup` is gated by an `allow_setup` flag
//! (spec §8.2) - the Tauri app always passes `false` (desktop first-run goes
//! through the `auth_setup` Tauri command instead, spec §10), while
//! `banto-serve` enables it via `BANTO_ALLOW_SETUP=1` so this REST path is
//! exercisable standalone - and `grant/{kind}` is gated by the registered
//! `GrantSpec`'s condition: the template registers only the viewer-public
//! kind, whose condition is the `server.viewer_public` setting, so
//! `grant/publicViewer` returns `403 { "kind": "forbidden" }` unless 閲覧公開
//! is explicitly on (Issue #189, ADR-0012, `docs/design/viewer-public-plan.md`
//! §2.2; `banto-serve` seeds the setting via `BANTO_VIEWER_PUBLIC=1`), and
//! any other kind is `404`. The token a grant returns is an ordinary bearer
//! token for the spec's fixed identity (`{ id: "public", role: "viewer" }`
//! for viewer-public), so everything after that point - `require_auth`,
//! [`require_role_at_least`], the audit trail - treats it exactly like any
//! other session of that role, and a mutating request made with a viewer
//! grant is rejected `403` and recorded as `denied` with actor `public`.
//! Issuance itself is not audited (see `banto_server::grant`).
//!
//! `POST /api/reach-check` (Issue #219 stage 1,
//! `docs/design/lan-reach-check-design.md`) is the other route outside
//! `require_auth`, and it is NOT assembled by [`api_router`]: `src-tauri`'s
//! `start_embedded_server` merges `banto_server::reach_check_router` next to
//! it, bound to that listener's generation and port (`banto-serve` has no
//! screen to issue tokens and does not mount it). It checks a one-time token
//! the administrator's screen issued, records that another device reached
//! the listener, and answers `{ "result": "<code>" }` only - it never issues a
//! session, so every other route stays `401` afterwards. It carries its own
//! `X-Banto-Client` check because it sits outside this router's CSRF layer.
//! Neither issuance nor reach is audited (an uncredentialed route must not
//! amplify the audit log, conventions §1 / Issue #278).
//!
//! `POST /api/items/list` (rather than `GET` with query-string encoded
//! `ListParams`) is chosen deliberately: `ListParams` (sort/filters/
//! pagination, spec §3.2) is a nested structure, and sending it as a JSON
//! body makes the wire shape byte-for-byte identical to what
//! `DataProvider.getList`'s `HttpDataProvider` implementation (Phase B)
//! sends, with no query-string (de)serialization layer to keep in sync.
//!
//! Every `/api/*` route requires the `X-Banto-Client: banto` header
//! (`banto_server::csrf`) and, except for the auth routes themselves, a
//! valid bearer token (`banto_server::auth::require_auth`).
//!
//! ## RBAC (spec M10, `docs/roadmap.md`)
//!
//! On top of `require_auth` (valid session, any role), mutating `items`
//! routes and all `/api/users` routes are additionally gated by
//! [`require_role_at_least`]: it re-resolves the bearer token to an
//! [`banto_server::Identity`], parses `Identity.role` into [`Role`], and rejects with
//! `403 { "kind": "forbidden" }` (`banto_core::ErrorBody::Forbidden`) if the
//! caller's role is not at least the route's minimum. `viewer` can read
//! (`items` list/get); `editor` and up can also write; only `admin` can
//! manage other accounts.
//!
//! ## Audit log (spec M14, `docs/roadmap.md`)
//!
//! Every mutating handler above (`items`/`users` create/update/delete,
//! password reset, self-service password change) records a
//! `crate::audit::AuditEntry` to [`crate::audit::AuditLogService`] once its
//! underlying service call has already succeeded (`origin: "rest"`);
//! [`require_role_at_least`] records `action: "denied"` when an
//! authenticated caller's role is too low; [`audited_credential_verifier`]
//! records `login`/`login_failed`; [`audit_logout_middleware`] records
//! `logout`; and `auth_setup_handler` records `setup`. Read routes
//! (`list`/`get`) are never audited. The trail itself is only readable via
//! `POST /api/audit-log/list`, `admin`-only.
//!
//! `POST /api/items/import` (spec M15) is a partial exception to "once its
//! underlying service call has already succeeded": [`ItemsService::import`]
//! itself never fails on bad ROW data (an all-or-nothing rollback is a
//! successful `Ok(ImportResult)` with `errors` populated, spec M15 design
//! decision - see that method's doc comment), so [`items_import`] always
//! records exactly one `action: "import"` entry - `result: "ok"` with a
//! `{created,updated}` summary when `errors` is empty, `result: "failed"`
//! with an `{errorCount}` summary when the batch was rolled back. It only
//! skips the audit write the way every other handler does: when the
//! service call returns `Err` outright (e.g. the row-count limit), which
//! `?`-propagates straight to a `422` before this handler's audit code runs.
//!
//! `/api/backups/*` (spec M17): `admin`-only, guarded the same way
//! `/api/users/*`/`/api/audit-log/*` are. `POST /api/backups` records
//! `action: "backup"`; either restore-staging route records
//! `action: "restore_staged"`; `DELETE /api/backups/pending-restore` records
//! `action: "restore_cancelled"` - all `resource: "backups"`. Reads (`GET
//! /api/backups`, the per-file download, `GET .../pending-restore`) are
//! never audited, same "read routes are never audited" convention as
//! everywhere else in this module. `action: "restore_applied"` is
//! deliberately NEVER recorded from here - a staged restore is only ever
//! APPLIED at the next process start, before any REST router (or pool) even
//! exists yet (spec M17: "稼働中のプールの差し替えはしない") - see
//! `crate::backup::BackupService::apply_pending_restore_at_startup`'s doc
//! comment and its callers in `src-tauri`'s `run()`/`bin/banto-serve.rs`'s
//! `main`, which record that entry themselves once a fresh `AuditLogService`
//! exists. `POST /api/backups/restore`'s request body is raw bytes
//! (`Content-Type: application/octet-stream`), not JSON or multipart - this
//! workspace has no multipart dependency (spec M17 design decision:
//! "依存追加はしない") - with the uploaded file's original name passed as a
//! `?fileName=` query parameter purely for the audit `detail`/error
//! messages, never as a filesystem path (the actual bytes are always staged
//! under the service's own fixed `restore-pending.sqlite3` name - see
//! `crate::backup::BackupService::stage_restore_from_bytes`).
//!
//! `/api/attachments/*` (spec `docs/design/attachments-plan.md` §3.5, M20 unit B):
//! same read/write RBAC split as `items` (`viewer`+ read, `editor`+ write),
//! backed by `banto_attachments::AttachmentsService`. Upload is raw `Bytes`
//! with metadata on the query string, same "no multipart dependency" design
//! as `/api/backups/restore` above; `?fileName=` here IS actually used
//! (as display/`Content-Disposition` text, never a filesystem path - see
//! `banto_attachments`'s module doc comment). `POST /api/attachments`
//! records `action: "create"`, `DELETE /api/attachments/{id}` records
//! `action: "delete"`, both `resource: "attachments"` with
//! `{fileName,sizeBytes,parentResource,parentId}` detail. Reads (`list`/
//! `download`/`thumbnail`) are never audited. `AttachmentsService` itself
//! has no `ServerEvent`/`banto-server` awareness (a deliberate crate
//! boundary - see that crate's module doc comment), so
//! [`attachments_upload`]/[`attachments_delete`] broadcast
//! `ServerEvent::ResourceChanged { resource: "attachments" }` directly,
//! reusing the same `broadcast::Sender` [`api_router`] already threads
//! through for SSE.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware;
use axum::routing::{get, post};
use axum::{Json, Router};
use banto_core::{ListParams, ListResult};
use banto_server::routes::{
    actor_identity, audit_log_router, audit_logout_middleware, backups_router, extra_auth_router,
    record_write, require_role_at_least, system_info_router, ui_settings_router, users_router,
    LogoutAuditState, MetricsProbe, RoleGuard,
};
use banto_server::{
    auth_routes, require_auth, require_banto_client_header, sse_route, ApiError, AuthState,
    GrantRegistry, GrantSpec, ServerEvent,
};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::audit::{AuditEntry, AuditLogService};
use crate::backup::BackupService;
// [scaffold:items] begin
use crate::items::{ImportResult, Item, ItemImportRow, ItemInput, ItemsService};
// [scaffold:items] end
use crate::settings::SettingsService;
use crate::system_info::SystemInfoService;
use crate::users::{Role, UsersService};

mod authz;
// [scaffold:items] begin
mod items;
// [scaffold:items] end
#[cfg(test)]
mod tests;

// Theme C PR-C4 (docs/template-scope.md §7 移行順 ④): re-exported so
// `admin_template_core::rest::audited_credential_verifier` - the path
// `bin/banto-serve.rs` and `src-tauri`'s `run()` already use - keeps
// resolving unchanged now that the function itself lives in
// `banto_server::routes::audit`.
pub use banto_server::routes::audited_credential_verifier;
// Issue #204: the REST `AuthState` with session revocation wired in
// (`audited_credential_verifier` + the per-request account re-check).
// `bin/banto-serve.rs` and `src-tauri`'s `run()` build their state with it.
pub use banto_server::routes::user_auth_state;

// [scaffold:items] begin
use items::items_router;
// [scaffold:items] end

/// The already-cloneable service handles [`api_router`] threads into its
/// route builders (spec §11.1). Bundled into one struct (M-review 2026-08
/// M-13) so adding a service is a single field here rather than a new
/// positional parameter rippled through every `api_router` call site
/// (`bin/banto-serve.rs`, `src-tauri`'s `start_embedded_server`, and the
/// six `rest::tests` router helpers). `scaffold.mjs`'s attachments remover
/// likewise drops one named field instead of a position-dependent argument
/// slot. Every field is an independent handle over the same pool - no
/// ordering or lifetime relationship between them, so the caller may build
/// this in any order.
pub struct Services {
    // [scaffold:items] begin
    pub items: ItemsService,
    // [scaffold:items] end
    pub users: UsersService,
    pub settings: SettingsService,
    pub audit: AuditLogService,
    pub backup: BackupService,
    pub system_info: SystemInfoService,
    /// Capability × project-scope authorization (banto-cost P2, ADR-0028).
    pub authz: crate::authz::AuthzService,
    /// CPU/memory probe (ADR-0013, Issue #185), or `None` when the
    /// `system-metrics` feature is off (or the host platform is
    /// unsupported) - the app layer builds the `Some` case, see
    /// `bin/banto-serve.rs`/`src-tauri`'s `start_embedded_server`. This
    /// struct/`api_router` do not know about the `sysinfo` feature at all;
    /// they only pass the already-type-erased closure through to
    /// [`system_info_router`].
    pub metrics: Option<MetricsProbe>,
}

/// Compose the full `/api/*` router (spec §11.1): auth routes (login/
/// logout/check/identity from `banto_server` - wrapped with an audit-log
/// hook for `logout`, spec M14 - plus status/setup/change-password here
/// since those need `UsersService`), SSE events, the `items` CRUD routes
/// (RBAC-split read/write, spec M10), the `admin`-only `users` management
/// routes (spec M10), the `admin`-only `audit-log` viewer (spec M14), the
/// `admin`-only `backups` routes (spec M17), the `attachments` CRUD routes
/// (RBAC-split read/write, spec `docs/design/attachments-plan.md` §3.5 M20 unit
/// B), and the per-user `ui-settings` routes (spec M12), all behind the
/// CSRF header check. Mount the result *before*
/// `banto_server::static_files::static_router` so `/api/*` takes priority
/// over the SPA fallback.
pub fn api_router(
    services: Services,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
    allow_setup: bool,
) -> Router {
    let Services {
        // [scaffold:items] begin
        items,
        // [scaffold:items] end
        users,
        settings,
        audit,
        backup,
        system_info,
        authz,
        metrics,
    } = services;

    let audited_auth_routes = auth_routes(auth.clone()).layer(middleware::from_fn_with_state(
        LogoutAuditState {
            auth: auth.clone(),
            audit: audit.clone(),
        },
        audit_logout_middleware,
    ));

    // ADR-0017: the grant kinds this app issues without credentials. The
    // template has exactly one - viewer-public (`server.viewer_public`, read
    // live on every request so the settings screen's toggle takes effect
    // without a restart). `GET /api/auth/status` reports its availability as
    // `grants.publicViewer` and `POST /api/auth/grant/publicViewer` issues
    // it. A derived app registers its own kinds here (e.g. a commissioning
    // grant with `require_loopback_peer: true`). `None` extras - the template
    // itself adds no app-specific `status` fields (`banto_server::AuthStatusExtras`
    // is the hook an adopter fills in here).
    let mut grants = GrantRegistry::new();
    grants
        .register(GrantSpec::public_viewer(settings.clone()))
        .expect("the viewer-public grant registers on an empty registry");

    Router::new()
        .merge(audited_auth_routes)
        .merge(extra_auth_router(
            users.clone(),
            auth.clone(),
            audit.clone(),
            allow_setup,
            Arc::new(grants),
            None,
        ))
        .merge(sse_route(auth.clone(), events.clone()))
        // [scaffold:items] begin
        .merge(items_router(items, audit.clone(), auth.clone()))
        // [scaffold:items] end
        .merge(authz::authz_me_router(
            authz.clone(),
            users.clone(),
            audit.clone(),
            auth.clone(),
        ))
        .merge(authz::capabilities_router(
            authz.clone(),
            users.clone(),
            audit.clone(),
            auth.clone(),
        ))
        .merge(authz::project_members_read_router(
            authz.clone(),
            users.clone(),
            audit.clone(),
            auth.clone(),
        ))
        .merge(authz::project_members_write_router(
            authz,
            users.clone(),
            audit.clone(),
            auth.clone(),
        ))
        .merge(users_router(users, audit.clone(), auth.clone()))
        .merge(audit_log_router(
            audit.clone(),
            settings.clone(),
            auth.clone(),
        ))
        .merge(backups_router(backup, audit.clone(), auth.clone()))
        .merge(system_info_router(
            system_info,
            auth.clone(),
            audit.clone(),
            metrics,
        ))
        .merge(ui_settings_router(settings, auth))
        .layer(middleware::from_fn(require_banto_client_header))
}
