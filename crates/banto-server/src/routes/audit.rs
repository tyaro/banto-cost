use super::*;
use axum::extract::rejection::QueryRejection;
use banto_admin_services::audit::AuditLogList;
use banto_admin_services::users::bound_username_for_audit;

// --- M14: audit log ---------------------------------------------------------

/// Wraps `UsersService::verify` as the async credential verifier
/// `banto_server::AuthState::new` expects (spec §8.2), additionally
/// recording a `login`/`login_failed` audit entry for every attempt (spec
/// M14). Shared by `banto-serve` (the standalone REST dev server) and
/// `src-tauri`'s embedded LAN server auth state - both are `origin: "rest"`
/// sessions (the Tauri webview's OWN session goes through the `auth_login`
/// command instead, which records its own login/login_failed entries with
/// `origin: "tauri"`).
pub fn audited_credential_verifier(
    users: UsersService,
    audit: AuditLogService,
) -> impl Fn(String, String) -> futures_util::future::BoxFuture<'static, Option<Identity>>
       + Send
       + Sync
       + 'static {
    move |username: String, password: String| {
        let users = users.clone();
        let audit = audit.clone();
        Box::pin(async move {
            match users.verify(&username, &password).await {
                Ok(Some(identity)) => {
                    audit
                        .record(AuditEntry {
                            actor_username: Some(&identity.username),
                            actor_role: Some(identity.role.as_str()),
                            action: "login",
                            resource: "auth",
                            entity_id: None,
                            detail: None,
                            origin: "rest",
                            result: "ok",
                        })
                        .await;
                    Some(Identity {
                        id: identity.username,
                        name: identity.display_name,
                        role: identity.role.to_string(),
                    })
                }
                _ => {
                    // Issue #278: the username is attacker-supplied and need
                    // not be a real account, so never store it unbounded.
                    let bounded = bound_username_for_audit(&username);
                    audit
                        .record(AuditEntry {
                            actor_username: Some(&bounded),
                            actor_role: None,
                            action: "login_failed",
                            resource: "auth",
                            entity_id: None,
                            detail: None,
                            origin: "rest",
                            result: "failed",
                        })
                        .await;
                    None
                }
            }
        })
    }
}

/// The [`crate::SessionLookup`] for `UsersService` accounts (Issue #204):
/// re-reads the account by username and reports its current identity and
/// `(id, auth_epoch)` stamp, so [`AuthState::authenticate`] ends the sessions
/// of deleted accounts and of accounts whose epoch `UsersService` advanced
/// (role change, password change/reset), and authorizes with the current
/// role. One indexed `SELECT` per authenticated request.
pub fn user_session_lookup(
    users: UsersService,
) -> impl Fn(
    String,
) -> futures_util::future::BoxFuture<'static, Result<Option<SessionAccount>, BantoError>>
       + Send
       + Sync
       + 'static {
    move |username: String| {
        let users = users.clone();
        Box::pin(async move {
            Ok(users
                .get_by_username(&username)
                .await?
                .map(|user| session_account(&user)))
        })
    }
}

/// `UserIdentity` -> the wire [`Identity`] + [`SessionStamp`] a session is
/// bound to (`Identity.id` is the username, see its doc comment).
pub(crate) fn session_account(user: &UserIdentity) -> SessionAccount {
    SessionAccount {
        identity: Identity {
            id: user.username.clone(),
            name: user.display_name.clone(),
            role: user.role.to_string(),
        },
        stamp: SessionStamp {
            account_id: user.id,
            auth_epoch: user.auth_epoch,
        },
    }
}

/// The REST [`AuthState`] for a `UsersService` credential store, with
/// session revocation wired in (Issue #204): [`audited_credential_verifier`]
/// for login plus [`user_session_lookup`] for the per-request re-check.
/// `banto-serve` and the Tauri app's embedded server both build their state
/// here, so neither can forget the lookup.
pub fn user_auth_state(users: UsersService, audit: AuditLogService) -> AuthState {
    AuthState::new(
        audited_credential_verifier(users.clone(), audit),
        SessionValidation::lookup(user_session_lookup(users)),
    )
}

/// State for [`audit_logout_middleware`]: needs `AuthState` to resolve the
/// logging-out session's identity BEFORE the token is invalidated, plus
/// `AuditLogService` to record it (spec M14).
#[derive(Clone)]
pub struct LogoutAuditState {
    pub auth: AuthState,
    pub audit: AuditLogService,
}

/// Wraps the WHOLE `banto_server::auth_routes` sub-router (login/logout/
/// check/identity) rather than adding a competing `/api/auth/logout` route
/// of its own (spec M14): `axum::Router::merge` panics if two routers both
/// register the same path+method, and `banto_server::auth_routes` bundles
/// all four routes into one `Router` with no way to omit just `logout` - so
/// this instead inspects each request's path/method, resolving the caller's
/// identity (before the real handler invalidates the token) only when the
/// request IS the logout route, letting `next` run the real handler
/// completely unmodified either way, then recording the `logout` entry
/// after.
///
/// `POST /api/auth/login`'s own login/login_failed events are NOT recorded
/// here - see [`audited_credential_verifier`], which records those from
/// inside the credential-verifier closure instead (simpler: no need to peek
/// at the response body to learn success/failure).
pub async fn audit_logout_middleware(
    State(state): State<LogoutAuditState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let is_logout =
        req.method() == axum::http::Method::POST && req.uri().path() == "/api/auth/logout";
    let identity = if is_logout {
        actor_identity(req.headers(), &state.auth)
    } else {
        None
    };

    let response = next.run(req).await;

    // Issue #278: only a logout that ended a real session is audited. With no
    // token, an unknown/expired/already-revoked one, `identity` is `None` and
    // the request - which needs no credentials - leaves no row, so it cannot
    // be used to grow the audit table. (Tauri's `auth_logout` already records
    // only when it cleared a session; conventions §1/§6.)
    if is_logout && identity.is_some() {
        state
            .audit
            .record(AuditEntry {
                actor_username: identity.as_ref().map(|i| i.id.as_str()),
                actor_role: identity.as_ref().map(|i| i.role.as_str()),
                action: "logout",
                resource: "auth",
                entity_id: None,
                detail: None,
                origin: "rest",
                result: "ok",
            })
            .await;
    }

    response
}

/// State for the `/api/audit-log/*` handlers (spec M14): `AuditLogService`
/// for the read/write itself, `SettingsService` for the retention-policy
/// config endpoints (and the list route's opportunistic prune), plus
/// `AuthState` so `audit_config_apply` can resolve the calling actor (via
/// [`actor_identity`]) for its own `settings_change` audit entry, same as
/// the items/users write handlers' `record_write` helper.
#[derive(Clone)]
struct AuditLogState {
    audit: AuditLogService,
    settings: SettingsService,
    auth: AuthState,
}

/// `POST /api/audit-log/list?asOfId=` (spec M14, `admin`-only): filtered/
/// sorted/paginated read of the audit trail (spec: read routes themselves
/// are never audited, only mutations/denials/auth events are).
///
/// `?asOfId=` (optional, Issue #248) is the snapshot boundary
/// ([`AuditLogService::list_as_of`]): only rows with `id <= asOfId` are
/// listed and counted. Omitted, every row is covered as before. The answer
/// is [`AuditLogList`] - `ListResult`'s `rows`/`totalCount` plus the
/// boundary it used in `asOfId` and the prune's `deletionEpoch`, so a client
/// that ignores the new fields keeps working.
///
/// An unbounded read also opportunistically prunes (spec: "list実行時に
/// 軽く") before answering - best-effort, a prune failure must never block
/// an admin from viewing existing entries, so its result is discarded.
/// There is deliberately no separate background pruning task: this plus a
/// once-at-startup prune (`bin/banto-serve.rs`'s `main`/`src-tauri`'s
/// `run()`) is judged sufficient - the audit-log viewer is an admin-only,
/// infrequently-visited page, and each prune is a couple of indexed
/// `DELETE`s, not an expensive scan.
///
/// **A bounded read (`asOfId` given = block 2+ of a viewer generation) does
/// not prune** (Issue #248, same as banto-industrial #448/#464): a prune
/// deletes rows inside the boundary, which the viewer must treat as an
/// expired snapshot. With the row cap reached and entries still being
/// written, every list call deletes the oldest rows, so pruning here would
/// expire every generation at its second block. The unbounded read (the
/// first block of a generation, i.e. the viewer's "reload") and startup
/// still prune.
async fn audit_log_list(
    State(state): State<AuditLogState>,
    query: Result<Query<AuditLogListQuery>, QueryRejection>,
    Json(params): Json<ListParams>,
) -> Result<Json<AuditLogList>, ApiError> {
    let Query(query) = query.map_err(|err| BantoError::BadRequest(err.body_text()))?;
    if query.as_of_id.is_none() {
        if let Ok(config) = state.settings.audit_config().await {
            let _ = state
                .audit
                .prune(config.retention_days, config.retention_rows)
                .await;
        }
    }
    Ok(Json(state.audit.list_as_of(params, query.as_of_id).await?))
}

/// `POST /api/audit-log/list?asOfId=`'s query string (Issue #248).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditLogListQuery {
    #[serde(default)]
    as_of_id: Option<i64>,
}

/// `GET /api/audit-log/config` (spec M14, `admin`-only): current retention
/// policy - read-only, so unlike `audit_config_apply` this records nothing
/// (spec: read routes are never audited).
async fn audit_config_get(
    State(state): State<AuditLogState>,
) -> Result<Json<AuditSettings>, ApiError> {
    Ok(Json(state.settings.audit_config().await?))
}

/// `PUT /api/audit-log/config` (spec M14, `admin`-only): persist a new
/// retention policy (days and/or row-count cap; either may be `null` for
/// "unlimited" on that dimension, see
/// [`banto_admin_services::settings::AuditSettings`]),
/// mirroring `src-tauri`'s `audit_config_apply` command - same
/// `settings_change`/`settings` audit entry shape, just `origin: "rest"` and
/// the actor resolved from the bearer token (`actor_identity`) instead of
/// from Tauri's session mutex.
async fn audit_config_apply(
    State(state): State<AuditLogState>,
    headers: HeaderMap,
    Json(config): Json<AuditSettings>,
) -> Result<Json<AuditSettings>, ApiError> {
    state.settings.set_audit_config(&config).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "settings_change",
        "settings",
        None,
        Some(serde_json::json!({
            "retentionDays": config.retention_days,
            "retentionRows": config.retention_rows,
        })),
    )
    .await;
    Ok(Json(state.settings.audit_config().await?))
}

/// `/api/audit-log/*` (spec M14): `admin`-only, guarded the same way
/// `users_router` is (`require_auth` then `require_role_at_least`).
///
/// Two guards, one router: the `config` routes read/write the audit
/// *settings* (their success records use `resource: "settings"`), so their
/// denial is tagged `"settings"` too — matching the Tauri twin
/// (`audit_config_get`/`audit_config_apply` call
/// `require_role(.., "settings")`) and keeping denied/success filterable
/// under one resource. Only `list` is a read of the audit log itself and
/// keeps `resource: "audit_log"` (conventions §1: identical audit on both
/// paths; drift found by maintenance-review-2026-08 §5.3 H-4).
pub fn audit_log_router(
    audit: AuditLogService,
    settings: SettingsService,
    auth: AuthState,
) -> Router {
    let state = AuditLogState {
        audit: audit.clone(),
        settings,
        auth: auth.clone(),
    };
    let list = Router::new()
        .route("/api/audit-log/list", post(audit_log_list))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "audit_log",
                audit: audit.clone(),
            },
            require_role_at_least,
        ));
    let config = Router::new()
        .route(
            "/api/audit-log/config",
            get(audit_config_get).put(audit_config_apply),
        )
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "settings",
                audit,
            },
            require_role_at_least,
        ));
    list.merge(config)
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
