use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserIdentityResponse {
    id: i64,
    username: String,
    display_name: String,
    role: Role,
}

impl From<UserIdentity> for UserIdentityResponse {
    fn from(identity: UserIdentity) -> Self {
        Self {
            id: identity.id,
            username: identity.username,
            display_name: identity.display_name,
            role: identity.role,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUserRequest {
    username: String,
    password: String,
    display_name: String,
    role: Role,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateUserRequest {
    display_name: String,
    role: Role,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetPasswordRequest {
    new_password: String,
}

#[derive(Debug, Serialize)]
struct ResetPasswordResponse {
    success: bool,
}

/// State for the `/api/users/*` handlers: `UsersService` for the CRUD
/// itself, `AuthState` so `users_delete` can resolve the acting caller's
/// numeric row id from its bearer token (spec M10's self-deletion guard,
/// see `UsersService::delete_user`'s doc comment), and `AuditLogService`
/// (spec M14) so every mutation here records a `create`/`update`/
/// `password_reset`/`delete` entry once it has already succeeded.
#[derive(Clone)]
struct UsersAdminState {
    users: UsersService,
    auth: AuthState,
    audit: AuditLogService,
}

/// Resolve the [`UserIdentity`] of the caller making this request, from its
/// bearer token. `require_auth`/`require_role_at_least` have already proven
/// the token is valid and `admin`-roled by the time a `/api/users/*` handler
/// runs, so this should always succeed - `Unauthorized` here is a defensive
/// fallback (e.g. the account was deleted by another admin between the
/// token being issued and this request), not an expected path.
async fn acting_user(
    headers: &HeaderMap,
    auth: &AuthState,
    users: &UsersService,
) -> Result<UserIdentity, BantoError> {
    let username = bearer_token(headers)
        .and_then(|token| auth.identity_for(token))
        .map(|identity| identity.id);
    let Some(username) = username else {
        return Err(BantoError::Unauthorized);
    };
    users
        .get_by_username(&username)
        .await?
        .ok_or(BantoError::Unauthorized)
}

async fn users_list(
    State(state): State<UsersAdminState>,
) -> Result<Json<Vec<UserSummary>>, ApiError> {
    Ok(Json(state.users.list_users().await?))
}

async fn users_create(
    State(state): State<UsersAdminState>,
    headers: HeaderMap,
    Json(body): Json<CreateUserRequest>,
) -> Result<Json<UserIdentityResponse>, ApiError> {
    let identity = state
        .users
        .create_user(
            &body.username,
            &body.password,
            &body.display_name,
            body.role,
        )
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "users",
        Some(&identity.id.to_string()),
        Some(json!({ "username": identity.username, "role": identity.role })),
    )
    .await;
    Ok(Json(identity.into()))
}

async fn users_update(
    State(state): State<UsersAdminState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<UpdateUserRequest>,
) -> Result<Json<UserSummary>, ApiError> {
    let updated = state
        .users
        .update_user(id, &body.display_name, body.role)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        "users",
        Some(&id.to_string()),
        Some(json!({ "role": updated.role })),
    )
    .await;
    Ok(Json(updated))
}

async fn users_reset_password(
    State(state): State<UsersAdminState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<Json<ResetPasswordResponse>, ApiError> {
    state.users.reset_password(id, &body.new_password).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "password_reset",
        "users",
        Some(&id.to_string()),
        None,
    )
    .await;
    Ok(Json(ResetPasswordResponse { success: true }))
}

/// `DELETE /api/users/{id}`. The self-deletion guard needs the caller's own
/// row id ([`UsersService::delete_user`]); a grant session (ADR-0017 §3,
/// e.g. a derived app's admin-equivalent commissioning grant) has a fixed
/// identity and no row, so for it - and ONLY for it, judged by the
/// [`AuthenticatedSession`] `require_auth` validated for this request, never
/// by the identity's name - no acting id is passed. An account session whose
/// row cannot be resolved stays `Unauthorized` as before. The `admin` floor
/// (`require_role_at_least`) and "the last admin cannot be deleted" apply to
/// a grant session unchanged.
async fn users_delete(
    State(state): State<UsersAdminState>,
    session: Option<axum::Extension<AuthenticatedSession>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let is_grant = session.is_some_and(|axum::Extension(session)| session.grant.is_some());
    let acting_id = if is_grant {
        None
    } else {
        Some(acting_user(&headers, &state.auth, &state.users).await?.id)
    };
    state.users.delete_user(id, acting_id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        "users",
        Some(&id.to_string()),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `/api/users/*` (spec M10): `admin`-only account management. Guarded the
/// same way `items_write_router` is (`require_auth` then
/// `require_role_at_least`), just with `Role::Admin` as the floor.
pub fn users_router(users: UsersService, audit: AuditLogService, auth: AuthState) -> Router {
    let state = UsersAdminState {
        users,
        auth: auth.clone(),
        audit: audit.clone(),
    };
    Router::new()
        .route("/api/users", get(users_list).post(users_create))
        .route(
            "/api/users/{id}",
            axum::routing::put(users_update).delete(users_delete),
        )
        .route("/api/users/{id}/reset-password", post(users_reset_password))
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "users",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
