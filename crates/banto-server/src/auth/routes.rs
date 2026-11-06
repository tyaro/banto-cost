use std::net::SocketAddr;

use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use banto_core::ErrorBody;
use serde::{Deserialize, Serialize};

use super::*;

/// The connection's peer address, as an extractor that never rejects. Yields
/// `Some` when the server was started with
/// `into_make_service_with_connect_info::<SocketAddr>()` (production, see
/// `server::start`), and `None` otherwise - notably `tower`'s `oneshot` in
/// tests, which serves a router with no connect-info layer. axum 0.8's
/// [`ConnectInfo`] is only a required extractor (there is no
/// `Option<ConnectInfo<..>>`), so the login handler wraps it here rather than
/// failing the whole request when the peer address is unavailable. Shared
/// with the grant route and the status route ([`crate::grant`],
/// [`crate::routes`]), which judge `require_loopback_peer` with it.
pub(crate) struct MaybePeerAddr(pub(crate) Option<SocketAddr>);

impl<S: Send + Sync> FromRequestParts<S> for MaybePeerAddr {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(MaybePeerAddr(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|info| info.0),
        ))
    }
}

pub(crate) fn unauthorized_response() -> Response {
    (StatusCode::UNAUTHORIZED, Json(ErrorBody::Unauthorized)).into_response()
}

pub(crate) fn bearer_token(req: &Request) -> Option<&str> {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

/// Axum middleware: reject the request with `401 { "kind": "unauthorized" }`
/// (banto-core's [`ErrorBody`]) unless `Authorization: Bearer <token>`
/// carries a currently-valid token. Apply with
/// `middleware::from_fn_with_state(auth_state, require_auth)` so the guarded
/// router does not need `AuthState` as its own `State` type (this keeps
/// composition with other routers/state simple, spec §11 rest.rs).
///
/// Issue #204: validation is [`AuthState::authenticate`], so with a
/// [`SessionLookup`] installed the account is re-read on every request - a
/// deleted/re-keyed account's token gets `401` here and is revoked, and a
/// store failure is an error response (not a pass). The validated
/// [`AuthenticatedSession`] (current identity) is inserted into the request's
/// extensions for the guards and handlers behind this middleware.
pub async fn require_auth(State(auth): State<AuthState>, mut req: Request, next: Next) -> Response {
    let Some(token) = bearer_token(&req).map(str::to_owned) else {
        return unauthorized_response();
    };
    match auth.authenticate(&token).await {
        Ok(Some(session)) => {
            req.extensions_mut().insert(session);
            next.run(req).await
        }
        Ok(None) => unauthorized_response(),
        Err(err) => crate::ApiError(err).into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
    /// LAN "Remember me" checkbox (spec M11). Defaults to `false` so older
    /// frontend builds that do not send this field at all keep today's
    /// regular-`TokenPolicy` behavior unchanged.
    #[serde(default)]
    remember: bool,
}

#[derive(Debug, Serialize)]
struct LoginResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

/// `POST /api/auth/login` (spec §11.1/§11.2). Three outcomes:
/// - success -> `200 {success:true, token}`.
/// - wrong credentials -> `200 {success:false, error}` (unchanged legacy
///   shape the frontend's `HttpAuthProvider.login` reads directly).
/// - too many recent failures -> `429` with a banto-core [`ErrorBody::Other`]
///   body carrying a Japanese message. `429`'s body is the `{kind,message}`
///   error shape (not `LoginResponse`) on purpose: the frontend treats any
///   non-2xx as an error and surfaces `ErrorBody::message`, so the lockout
///   reason reaches the user as `{success:false, error}` without any frontend
///   change (`packages/admin-core/src/providers/http.ts`).
///
/// The peer address (for the lockout key) comes from `ConnectInfo`, made
/// optional so callers that serve without
/// `into_make_service_with_connect_info` (e.g. `tower`'s `oneshot` in tests)
/// still work - they simply fall back to a username-only lockout key.
async fn login_handler(
    State(auth): State<AuthState>,
    MaybePeerAddr(peer): MaybePeerAddr,
    Json(body): Json<LoginRequest>,
) -> Response {
    match auth
        .login_rate_limited(
            peer.map(|addr| addr.ip()),
            &body.username,
            &body.password,
            body.remember,
        )
        .await
    {
        LoginOutcome::Success(token) => Json(LoginResponse {
            success: true,
            error: None,
            token: Some(token),
        })
        .into_response(),
        LoginOutcome::InvalidCredentials => Json(LoginResponse {
            success: false,
            error: Some("ユーザー名またはパスワードが違います".to_string()),
            token: None,
        })
        .into_response(),
        LoginOutcome::RateLimited { retry_after } => {
            let seconds = retry_after.as_secs().max(1);
            let message = format!(
                "ログインの失敗が続いたため、一時的にロックされています。約{seconds}秒後にもう一度お試しください。"
            );
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, seconds.to_string())],
                Json(ErrorBody::Other { message }),
            )
                .into_response()
        }
        // Issue #204: same `{kind,message}` shape as the 429 above, so the
        // frontend surfaces the message without any change.
        LoginOutcome::Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody::Other {
                message: "アカウントの状態を確認できませんでした。もう一度お試しください。"
                    .to_string(),
            }),
        )
            .into_response(),
    }
}

async fn logout_handler(State(auth): State<AuthState>, req: Request) -> StatusCode {
    if let Some(token) = bearer_token(&req) {
        auth.logout(token);
    }
    StatusCode::OK
}

/// The session behind the request's bearer token, validated the same way
/// [`require_auth`] does (Issue #204) - `check`/`identity` are not behind
/// that middleware, and must not report a revoked session as live.
/// (Takes the token as an owned `String`: a `&Request` held across the
/// `.await` would make the handler future `!Send`.)
async fn authenticated_session(
    auth: &AuthState,
    token: Option<String>,
) -> Result<Option<AuthenticatedSession>, crate::ApiError> {
    let Some(token) = token else {
        return Ok(None);
    };
    Ok(auth.authenticate(&token).await?)
}

async fn check_handler(
    State(auth): State<AuthState>,
    req: Request,
) -> Result<Json<bool>, crate::ApiError> {
    let token = bearer_token(&req).map(str::to_owned);
    Ok(Json(authenticated_session(&auth, token).await?.is_some()))
}

/// `GET /api/auth/identity`: the [`AuthenticatedSession`] (serialized as
/// `Identity & { kind }` - the grant kind or `"account"`, ADR-0017) or `null`.
async fn identity_handler(
    State(auth): State<AuthState>,
    req: Request,
) -> Result<Json<Option<AuthenticatedSession>>, crate::ApiError> {
    let token = bearer_token(&req).map(str::to_owned);
    Ok(Json(authenticated_session(&auth, token).await?))
}

/// Build the `/api/auth/*` routes (spec §11, mirrors `src-tauri`'s
/// `auth_login`/`auth_logout`/`auth_check`/`auth_identity` commands and
/// `packages/admin-core/src/provider.ts::AuthProvider`):
///
/// - `POST /api/auth/login` — `{ username, password, remember? }` -> `{ success, error?, token? }`.
///   The token travels in the JSON body (not a cookie) since a LAN HTTP
///   server has no secure-cookie story; the frontend stores it and attaches
///   it as `Authorization: Bearer <token>` on every other request. Repeated
///   failures are rate-limited to a `429` (spec §11.2, see [`login_handler`]).
///   `remember` (spec M11, defaults to `false` when omitted) issues a
///   long-lived token evaluated against [`AuthState`]'s `remembered_policy`
///   instead of its regular `token_policy` (see [`TokenPolicy::remembered_default`]).
/// - `POST /api/auth/logout` — invalidates the bearer token on the request.
/// - `GET /api/auth/check` — `bool`, whether the bearer token is valid.
/// - `GET /api/auth/identity` — `(Identity & { kind: string }) | null`
///   (`kind` = the grant kind or `"account"`, ADR-0017).
///
/// First-run account setup (`GET /api/auth/status`, `POST /api/auth/setup`)
/// and `POST /api/auth/change-password` are NOT here: those need the app
/// crate's `UsersService` directly, so they are composed alongside this
/// router in `admin-template-core::rest::api_router` instead (this crate
/// stays resource/credential-store-agnostic).
pub fn auth_routes(auth: AuthState) -> Router {
    Router::new()
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/auth/check", get(check_handler))
        .route("/api/auth/identity", get(identity_handler))
        .with_state(auth)
}
