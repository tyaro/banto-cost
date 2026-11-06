//! Banto server: embedded HTTP server for LAN browser access (spec §11).
//!
//! Domain-agnostic only: auth/token management, credential-less grant
//! issuance ([`grant`], ADR-0017), the LAN reach check's one-time-token
//! store and route ([`reach_check`], Issue #219), CSRF header enforcement,
//! baseline security response headers, SSE event fan-out, static/SPA
//! fallback serving, server lifecycle (bind/serve/graceful-shutdown), plus
//! (since theme C PR-C4, docs/template-scope.md §7 移行順 ④) the REST
//! routers for the resources that are themselves domain-agnostic
//! ([`routes`]: auth extras, users, audit-log, backups, ui-settings, backed
//! by `banto-admin-services`). Anything that knows about a specific APP
//! resource (`items`, `attachments`) or the frontend build's on-disk
//! location lives in the app crate (`apps/admin-template/core`), which
//! composes these pieces via [`auth::auth_routes`], [`events::sse_route`],
//! [`routes`], [`static_files::static_router`], [`response::ApiError`] and
//! [`security_headers::with_security_headers`] (or
//! [`security_headers::with_security_headers_using`] when the app's own
//! desktop shell needs Tauri IPC in `connect-src`).
//!
//! Every router built here stays `Router<()>` (no shared `axum::State`):
//! handlers close over their state (`AuthState`, `broadcast::Sender`, ...)
//! instead, so routers from different modules merge without state-type
//! conflicts.

pub mod auth;
pub mod csrf;
pub mod events;
pub mod grant;
pub mod reach_check;
pub mod response;
pub mod routes;
pub mod security_headers;
pub mod server;
pub mod static_files;

pub use auth::{
    auth_routes, rate_limit_key, require_auth, AuthState, AuthenticatedSession, Identity,
    LoginOutcome, RateLimitPolicy, SessionAccount, SessionLookup, SessionStamp, SessionValidation,
    TokenPolicy,
};
pub use csrf::require_banto_client_header;
pub use events::{sse_route, ServerEvent};
pub use grant::{
    grant_router, is_loopback_peer, GrantCondition, GrantGeneration, GrantKind, GrantRegistry,
    GrantSpec, DEFAULT_GRANT_MAX_SESSIONS, PUBLIC_VIEWER_ID,
};
pub use reach_check::{
    reach_check_router, CheckOutcome, LastIssue, ReachCheckClock, ReachCheckResult,
    ReachCheckState, ReachCheckStatus, ReachIssue, ReachIssueError, ReachOutcome, ReachRecord,
    ReachTarget, SystemReachCheckClock,
};
pub use response::ApiError;
pub use routes::AuthStatusExtras;
pub use security_headers::{
    request_from_loopback_peer, request_is_loopback_local, with_security_headers,
    with_security_headers_using, InvalidCspSource, SecurityHeaders, CONTENT_SECURITY_POLICY,
    TAURI_IPC_CONNECT_SRC,
};
pub use server::{
    bind, bind_with_port_fallback, bind_without_fallback, lan_urls, lan_urls_for_bind, start,
    BoundServer, PortFallbackError, RunningServer, ServerConfig, PORT_FALLBACK_SPAN,
};
pub use static_files::{guess_mime, static_router, UiAssets};
