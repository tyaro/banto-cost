use std::sync::Arc;

use super::*;
use crate::auth::MaybePeerAddr;
use crate::grant::{grant_router, GrantKind, GrantRegistry};

/// Extension point for app-specific `GET /api/auth/status` fields
/// (`docs/design/viewer-public-plan.md` §3.1-2). The returned map is flattened into
/// the status response alongside `initialized`/`grants`, so an adopter
/// that needs to tell its login screen something extra (a tenant name, a
/// branding flag, ...) can do it without wrapping this router in a
/// response-rewriting layer of its own.
///
/// Synchronous on purpose: `status` is the very first request a cold login
/// screen makes, and every field the template itself needs is already read
/// inside the handler - an app-supplied hook that wants to `.await` should
/// keep its own cached value and read it here instead of turning this route
/// into an arbitrary async fan-out.
pub type AuthStatusExtras =
    std::sync::Arc<dyn Fn() -> serde_json::Map<String, serde_json::Value> + Send + Sync>;

/// State shared by `/api/auth/status`, `/api/auth/setup` and
/// `/api/auth/change-password` (see [`extra_auth_router`]): these need
/// `UsersService` (the credential store, spec §8.2), `AuthState` (to issue a
/// token on `setup`'s implicit login and to resolve the calling account on
/// `change-password`) and the [`GrantRegistry`] (`status` reports which
/// grant kinds may be issued to this peer, ADR-0017) - none of which
/// [`crate::auth`] knows about on its own.
#[derive(Clone)]
struct UsersAuthState {
    users: UsersService,
    auth: AuthState,
    audit: AuditLogService,
    allow_setup: bool,
    registry: Arc<GrantRegistry>,
    status_extras: Option<AuthStatusExtras>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusResponse {
    initialized: bool,
    /// Which grant kinds this server would issue to THIS peer right now
    /// (ADR-0017): `{ publicViewer: bool, <appKind>: bool, ... }`, from
    /// [`GrantRegistry::availability`] - the same judgment the issuing route
    /// repeats, read live on every request (toggling 閲覧公開 in the settings
    /// screen takes effect without a restart). A kind whose condition fails
    /// is `false`; the login screen reads a missing kind as `false` too.
    grants: std::collections::BTreeMap<GrantKind, bool>,
    /// App-supplied extra fields, flattened into the same JSON object (see
    /// [`AuthStatusExtras`]). Empty for the template itself.
    #[serde(flatten)]
    extras: serde_json::Map<String, serde_json::Value>,
}

/// `GET /api/auth/status`: `{ initialized, grants, ...extras }`. The DB
/// failure of `is_initialized` is an error response as before (status is
/// not "never fails"); only the per-kind grant judgment is fail-closed to
/// `false`.
async fn auth_status_handler(
    State(state): State<UsersAuthState>,
    MaybePeerAddr(peer): MaybePeerAddr,
) -> Result<Json<AuthStatusResponse>, ApiError> {
    let initialized = state.users.is_initialized().await?;
    let grants = state.registry.availability(peer).await;
    let extras = state
        .status_extras
        .as_ref()
        .map(|hook| hook())
        .unwrap_or_default();
    Ok(Json(AuthStatusResponse {
        initialized,
        grants,
        extras,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupRequest {
    username: String,
    password: String,
    display_name: String,
}

#[derive(Debug, Serialize)]
struct SetupResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

/// `POST /api/auth/setup`: creates the first account, then behaves like a
/// successful login (spec §8.2/§3.3). Three distinct outcomes:
/// - `allow_setup` is `false` -> `403` with a plain `{kind,message}` body
///   (not the `{success,error?}` shape below - this is a server
///   configuration rejection, not a "try again" outcome).
/// - `UsersService::setup_first_user` returns `BantoError::Validation` (bad
///   username/password) -> `422` with `field_errors`, same convention as
///   `items_create` (spec: form fields should be able to map these).
/// - Anything else (already initialized, storage error) -> `200` with
///   `{success:false,error}`, mirroring `login_handler`'s "expected,
///   retryable failure" convention.
async fn auth_setup_handler(
    State(state): State<UsersAuthState>,
    Json(body): Json<SetupRequest>,
) -> Result<Response, ApiError> {
    if !state.allow_setup {
        let message = "このサーバーでは初期セットアップが許可されていません".to_string();
        return Ok((StatusCode::FORBIDDEN, Json(ErrorBody::Other { message })).into_response());
    }

    match state
        .users
        .setup_first_user(&body.username, &body.password, &body.display_name)
        .await
    {
        Ok(user) => {
            // Issue #204: bound to the new account's stamp, so the session
            // is accepted by a lookup-enabled `AuthState` (and ends like
            // any other once the account changes).
            let account = super::audit::session_account(&user);
            let identity = account.identity.clone();
            state
                .audit
                .record(AuditEntry {
                    actor_username: Some(&identity.id),
                    actor_role: Some(&identity.role),
                    action: "setup",
                    resource: "auth",
                    entity_id: None,
                    detail: None,
                    origin: "rest",
                    result: "ok",
                })
                .await;
            let token = state.auth.issue_account_token(account, false);
            Ok(Json(SetupResponse {
                success: true,
                error: None,
                token: Some(token),
            })
            .into_response())
        }
        Err(err @ BantoError::Validation { .. }) => Err(ApiError(err)),
        Err(other) => Ok(Json(SetupResponse {
            success: false,
            error: Some(other.to_string()),
            token: None,
        })
        .into_response()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

#[derive(Debug, Serialize)]
struct ChangePasswordResponse {
    success: bool,
}

/// `POST /api/auth/change-password`: authenticated via the same bearer
/// token as every other guarded route, but implemented as a plain handler
/// (not `require_auth` middleware) since it also needs the token's bound
/// `Identity` to know *which* account to update - `require_auth` only
/// proves the token is valid, it does not thread the identity through.
///
/// Issue #204: the token is validated with [`AuthState::authenticate`] (a
/// deleted/re-keyed account's session is `401`, not a password change).
/// The change advances the account's epoch, ending every session of it -
/// other devices, the other transport's session, "Remember me" tokens - and
/// then re-binds only THIS token to the new epoch
/// ([`AuthState::rotate_session_epoch`]): the caller just proved the current
/// password, so it keeps working, while anything that might have been
/// obtained with the old password does not.
async fn auth_change_password_handler(
    State(state): State<UsersAuthState>,
    headers: HeaderMap,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<Json<ChangePasswordResponse>, ApiError> {
    let Some(token) = bearer_token(&headers) else {
        return Err(ApiError(BantoError::Unauthorized));
    };
    let Some(session) = state.auth.authenticate(token).await? else {
        return Err(ApiError(BantoError::Unauthorized));
    };
    let identity = session.identity;
    // ADR-0017 (conventions §6): a grant session is never a credential
    // owner, even when a real account happens to share its display label.
    if session.grant.is_some() {
        state
            .audit
            .record(AuditEntry {
                actor_username: Some(&identity.id),
                actor_role: Some(&identity.role),
                action: "password_change",
                resource: "users",
                entity_id: None,
                detail: None,
                origin: "rest",
                result: "denied",
            })
            .await;
        return Err(ApiError(BantoError::Forbidden));
    }

    let new_epoch = state
        .users
        .change_password(&identity.id, &body.current_password, &body.new_password)
        .await?;
    // Re-bind only when this change was the ONLY one since the session was
    // validated (`UsersService` advances the epoch by one per change): if a
    // role change interleaved, the session must end like every other one.
    // A `false` from the compare-and-set (revoked meanwhile) is likewise
    // left as is - the password change itself did succeed.
    if let Some(stamp) = session.stamp {
        if new_epoch == stamp.auth_epoch + 1 {
            state.auth.rotate_session_epoch(token, stamp, new_epoch);
        }
    }
    // Spec M14: a self-service password change is a security event (it is
    // also what naturally invalidates an M11 autologin credential), so it IS
    // audited - `entity_id` is the caller's own numeric row id (matching the
    // other `users` entries), recovered from the username since the bearer
    // token only carries the latter. `detail` stays `None`: neither the old
    // nor the new password (nor any hash) may ever be recorded.
    let entity_id = state
        .users
        .get_by_username(&identity.id)
        .await
        .ok()
        .flatten()
        .map(|user| user.id.to_string());
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&identity.id),
            actor_role: Some(&identity.role),
            action: "password_change",
            resource: "users",
            entity_id: entity_id.as_deref(),
            detail: None,
            origin: "rest",
            result: "ok",
        })
        .await;
    Ok(Json(ChangePasswordResponse { success: true }))
}

/// `/api/auth/{status,setup,change-password}` plus the grant issuing route
/// `POST /api/auth/grant/{kind}` ([`grant_router`], ADR-0017): the auth
/// routes that need more than a token - a `UsersService` (the credential
/// store) and/or the [`GrantRegistry`] - on top of the token-only
/// login/logout/check/identity routes [`crate::auth_routes`] already
/// provides. Merged by the app's `api_router`, inside its CSRF layer.
///
/// `registry` holds every grant kind the app issues (the template registers
/// `GrantSpec::public_viewer(settings)` only); `status` reports
/// `availability(peer)` as `grants` and the grant route issues from it. An
/// app that has copied this router instead merges `grant_router` itself and
/// puts `availability(peer)` on its own status (ADR-0017 移行手順).
///
/// `status_extras` (optional, [`AuthStatusExtras`]) lets an adopter add
/// app-specific fields to `GET /api/auth/status`; the template passes
/// `None`.
pub fn extra_auth_router(
    users: UsersService,
    auth: AuthState,
    audit: AuditLogService,
    allow_setup: bool,
    registry: Arc<GrantRegistry>,
    status_extras: Option<AuthStatusExtras>,
) -> Router {
    let state = UsersAuthState {
        users,
        auth: auth.clone(),
        audit,
        allow_setup,
        registry: registry.clone(),
        status_extras,
    };
    Router::new()
        .route("/api/auth/status", get(auth_status_handler))
        .route("/api/auth/setup", post(auth_setup_handler))
        .route(
            "/api/auth/change-password",
            post(auth_change_password_handler),
        )
        .with_state(state)
        .merge(grant_router(auth, registry))
}
