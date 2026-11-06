//! Pins the parts of `banto-server`'s API that derived apps depend on, from
//! OUTSIDE the crate (an integration test is compiled as a separate crate).
//!
//! A unit test inside `src/` still compiles if an item is narrowed from `pub`
//! back to `pub(crate)`; this file does not. Each function here is
//! compile-only - it is never called - so it pins visibility and signature,
//! not behaviour (behaviour is covered by the unit tests in `src/auth/tests.rs`).

#![allow(dead_code)]

use banto_core::BantoError;
use banto_server::{AuthState, AuthenticatedSession};

/// Issue #239: `AuthState::revalidate` is public so a derived app's own
/// long-lived stream (banto-industrial#430) can re-check a session without
/// sliding its idle window. Reverting it to `pub(crate)` must fail this
/// test's compilation.
async fn revalidate_is_public(
    auth: &AuthState,
    token: &str,
) -> Result<Option<AuthenticatedSession>, BantoError> {
    auth.revalidate(token).await
}

/// banto-industrial#505: a derived app's desktop shell that navigates its
/// Tauri webview to this server's HTTP UI widens `connect-src` with Tauri IPC
/// for loopback peers only, and its tests compare the window CSP against
/// `content_security_policy()`. Narrowing any of these must fail compilation.
fn security_headers_connect_src_api_is_public(router: axum::Router) -> axum::Router {
    use banto_server::{
        request_from_loopback_peer, with_security_headers_using, InvalidCspSource, SecurityHeaders,
        CONTENT_SECURITY_POLICY, TAURI_IPC_CONNECT_SRC,
    };
    let _: &str = CONTENT_SECURITY_POLICY;
    let config: Result<SecurityHeaders, InvalidCspSource> =
        SecurityHeaders::new().extra_connect_src(TAURI_IPC_CONNECT_SRC);
    let config = config
        .expect("static sources are valid")
        .extra_connect_src_when(request_from_loopback_peer);
    let _: String = config.content_security_policy();
    with_security_headers_using(router, config)
}

/// banto-industrial#505 follow-up (2026-10-06): the recommended selector also
/// requires a loopback request authority, so LAN viewers behind a
/// `Host`-preserving same-host reverse proxy keep the strict policy.
fn security_headers_loopback_local_selector_is_public(router: axum::Router) -> axum::Router {
    use banto_server::{
        request_is_loopback_local, with_security_headers_using, SecurityHeaders,
        TAURI_IPC_CONNECT_SRC,
    };
    let _: fn(&axum::extract::Request) -> bool = request_is_loopback_local;
    let config = SecurityHeaders::new()
        .extra_connect_src(TAURI_IPC_CONNECT_SRC)
        .expect("static sources are valid")
        .extra_connect_src_when(request_is_loopback_local);
    with_security_headers_using(router, config)
}
