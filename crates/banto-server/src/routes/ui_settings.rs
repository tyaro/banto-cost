use super::*;

/// State for the `/api/ui-settings/*` handlers (spec M12): `SettingsService`
/// for the per-user key/value store itself, plus `AuthState` to resolve the
/// caller's own `username` from the bearer token `require_auth` already
/// validated (same pattern as `auth::UsersAuthState`/`users::acting_user`
/// in the sibling modules here).
#[derive(Clone)]
struct UiSettingsState {
    settings: SettingsService,
    auth: AuthState,
}

#[derive(Debug, Serialize)]
struct UiSettingValueResponse {
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UiSettingSetRequest {
    value: String,
}

/// Resolve the calling session's `username` (spec convention: bearer-token
/// `Identity.id` IS the username, see `banto_server::auth::Identity`'s doc
/// comment) from its bearer token. `require_auth` has already proven the
/// token valid by the time a `/api/ui-settings/*` handler runs, so this
/// should always succeed; `Unauthorized` here is a defensive fallback (e.g.
/// the token expired between `require_auth` and this handler running), not
/// an expected path - mirrors `users::acting_user`.
fn acting_username(headers: &HeaderMap, auth: &AuthState) -> Result<String, BantoError> {
    bearer_token(headers)
        .and_then(|token| auth.identity_for(token))
        .map(|identity| identity.id)
        .ok_or(BantoError::Unauthorized)
}

async fn ui_settings_get(
    State(state): State<UiSettingsState>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<Json<UiSettingValueResponse>, ApiError> {
    let username = acting_username(&headers, &state.auth)?;
    let value = state.settings.ui_get(&username, &key).await?;
    Ok(Json(UiSettingValueResponse { value }))
}

async fn ui_settings_set(
    State(state): State<UiSettingsState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(body): Json<UiSettingSetRequest>,
) -> Result<StatusCode, ApiError> {
    let username = acting_username(&headers, &state.auth)?;
    state.settings.ui_set(&username, &key, &body.value).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `/api/ui-settings/*` (spec M12): `require_auth` only, no
/// [`require_role_at_least`] floor - see `admin-template-core::rest`'s
/// module doc comment for why (every route here only ever touches the
/// caller's OWN namespaced keys).
pub fn ui_settings_router(settings: SettingsService, auth: AuthState) -> Router {
    let state = UiSettingsState {
        settings,
        auth: auth.clone(),
    };
    Router::new()
        .route(
            "/api/ui-settings/{key}",
            get(ui_settings_get).put(ui_settings_set),
        )
        .with_state(state)
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
