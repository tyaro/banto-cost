use super::*;
use crate::db::migrate_memory;
use axum::body::Body;
use axum::http::Request as HttpRequest;
use banto_core::BantoError;
// Theme C PR-C4: `rest/mod.rs` no longer needs `Identity` itself (the helpers
// that used it moved to `banto_server::routes`), so the test module imports it
// directly rather than through `use super::*`.
use banto_admin_services::system_metrics::SystemMetrics;
use banto_server::{Identity, SessionValidation};
use serde_json::json;
use std::path::PathBuf;
use tempfile::tempdir;
use tower::ServiceExt;

const CLIENT_HEADER: (&str, &str) = ("X-Banto-Client", "banto");

/// A `BackupService` for router helpers that do not exercise
/// `/api/backups/*` at all (the overwhelming majority of this module's
/// tests) - `BackupService::new` only stores its arguments, so an
/// on-disk path that is never actually written to is harmless. Tests
/// that DO exercise backups use [`router_with_role_tokens_and_backup`]
/// instead, which points at a real, writable temp directory AND (unlike
/// every other helper here) a real on-disk pool - see that function's
/// doc comment for why the pool matters too.
fn unused_backup_service(db: banto_storage::Db) -> BackupService {
    BackupService::new(
        PathBuf::from("unused-in-tests").join("admin-template.sqlite3"),
        db,
    )
}

fn demo_auth() -> AuthState {
    AuthState::new(
        |u: String, p: String| {
            Box::pin(async move {
                if u == "admin" && p == "admin" {
                    Some(Identity {
                        id: "admin".to_string(),
                        name: "管理者".to_string(),
                        role: "admin".to_string(),
                    })
                } else {
                    None
                }
            })
        },
        SessionValidation::DisabledNoRevocation,
    )
}

/// Router + one bearer token per role (admin/editor/viewer), for the
/// RBAC tests below (spec M10). Unlike [`demo_auth_with_roles`] (whose
/// login verifier is independent of any `UsersService`), the three
/// accounts here are REAL rows in the same `UsersService`/pool the
/// router's `/api/users/*` routes operate on - required so
/// `users_delete`'s `acting_user` lookup (by the token's username) can
/// actually resolve the admin account performing the delete in
/// `admin_can_create_list_update_reset_password_and_delete_users`
/// below.
async fn router_with_role_tokens() -> (Router, String, String, String) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let system_info = SystemInfoService::new(pool.clone());
    let authz = banto_admin_services::authz::AuthzService::new(pool.clone());
    let customers = crate::customers::CustomersService::new(pool.clone()).with_events(tx.clone());
    let projects = crate::projects::ProjectsService::new(pool.clone()).with_events(tx.clone());
    let pipeline = crate::pipeline::PipelineService::new(pool.clone()).with_events(tx.clone());
    let orders = crate::orders::OrdersService::new(pool.clone()).with_events(tx.clone());
    let calc_basis = crate::calc_basis::CalcBasisService::new(pool.clone());
    let work_masters = crate::work_masters::WorkMastersService::new(pool.clone());
    let time_entries = crate::time_entries::TimeEntriesService::new(pool.clone());
    let budgets = crate::budgets::BudgetsService::new(pool.clone());
    let forecasts = crate::forecasts::ForecastsService::new(pool.clone());
    let direct_costs = crate::direct_costs::DirectCostsService::new(pool.clone());
    let audit = AuditLogService::new(pool);

    users
        .setup_first_user("admin", "password123", "管理者")
        .await
        .expect("setup_first_user");
    users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create editor");
    users
        .create_user("viewer", "password123", "閲覧者", Role::Viewer)
        .await
        .expect("create viewer");

    let verify_users = users.clone();
    let auth = AuthState::new(
        move |u: String, p: String| {
            let users = verify_users.clone();
            Box::pin(async move {
                match users.verify(&u, &p).await {
                    Ok(Some(identity)) => Some(Identity {
                        id: identity.username,
                        name: identity.display_name,
                        role: identity.role.to_string(),
                    }),
                    _ => None,
                }
            })
        },
        SessionValidation::DisabledNoRevocation,
    );

    let admin_token = auth
        .login("admin", "password123")
        .await
        .expect("admin login");
    let editor_token = auth
        .login("editor", "password123")
        .await
        .expect("editor login");
    let viewer_token = auth
        .login("viewer", "password123")
        .await
        .expect("viewer login");
    let services = Services {
        users,
        settings,
        audit,
        backup,
        system_info,
        authz,
        customers,
        projects,
        pipeline,
        orders,
        calc_basis,
        work_masters,
        time_entries,
        budgets,
        forecasts,
        direct_costs,
        metrics: None,
    };
    (
        api_router(services, auth, tx, false),
        admin_token,
        editor_token,
        viewer_token,
    )
}

async fn router_with_token() -> (Router, String) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let system_info = SystemInfoService::new(pool.clone());
    let authz = banto_admin_services::authz::AuthzService::new(pool.clone());
    let customers = crate::customers::CustomersService::new(pool.clone()).with_events(tx.clone());
    let projects = crate::projects::ProjectsService::new(pool.clone()).with_events(tx.clone());
    let pipeline = crate::pipeline::PipelineService::new(pool.clone()).with_events(tx.clone());
    let orders = crate::orders::OrdersService::new(pool.clone()).with_events(tx.clone());
    let calc_basis = crate::calc_basis::CalcBasisService::new(pool.clone());
    let work_masters = crate::work_masters::WorkMastersService::new(pool.clone());
    let time_entries = crate::time_entries::TimeEntriesService::new(pool.clone());
    let budgets = crate::budgets::BudgetsService::new(pool.clone());
    let forecasts = crate::forecasts::ForecastsService::new(pool.clone());
    let direct_costs = crate::direct_costs::DirectCostsService::new(pool.clone());
    let audit = AuditLogService::new(pool);
    let auth = demo_auth();
    let token = auth
        .login("admin", "admin")
        .await
        .expect("login should succeed");
    let services = Services {
        users,
        settings,
        audit,
        backup,
        system_info,
        authz,
        customers,
        projects,
        pipeline,
        orders,
        calc_basis,
        work_masters,
        time_entries,
        budgets,
        forecasts,
        direct_costs,
        metrics: None,
    };
    (api_router(services, auth, tx, false), token)
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn missing_csrf_header_is_forbidden_even_with_a_token() {
    let (router, token) = router_with_token().await;
    let response = router
        .oneshot(
            HttpRequest::get("/api/auth/check")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

/// Sanity check that `BantoError` variants used elsewhere still map the
/// way this module's tests assume (guards against silent drift if
/// `banto_core::error` changes).
#[test]
fn error_kind_used_in_tests_matches_banto_core() {
    let err = BantoError::NotFound {
        resource: "projects".to_string(),
        id: "1".to_string(),
    };
    assert_eq!(
        serde_json::to_value(&err).unwrap()["kind"],
        json!("not_found")
    );
}

async fn router_with_setup(allow_setup: bool) -> Router {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let system_info = SystemInfoService::new(pool.clone());
    let authz = banto_admin_services::authz::AuthzService::new(pool.clone());
    let customers = crate::customers::CustomersService::new(pool.clone()).with_events(tx.clone());
    let projects = crate::projects::ProjectsService::new(pool.clone()).with_events(tx.clone());
    let pipeline = crate::pipeline::PipelineService::new(pool.clone()).with_events(tx.clone());
    let orders = crate::orders::OrdersService::new(pool.clone()).with_events(tx.clone());
    let calc_basis = crate::calc_basis::CalcBasisService::new(pool.clone());
    let work_masters = crate::work_masters::WorkMastersService::new(pool.clone());
    let time_entries = crate::time_entries::TimeEntriesService::new(pool.clone());
    let budgets = crate::budgets::BudgetsService::new(pool.clone());
    let forecasts = crate::forecasts::ForecastsService::new(pool.clone());
    let direct_costs = crate::direct_costs::DirectCostsService::new(pool.clone());
    let audit = AuditLogService::new(pool);
    let auth = demo_auth();
    let services = Services {
        users,
        settings,
        audit,
        backup,
        system_info,
        authz,
        customers,
        projects,
        pipeline,
        orders,
        calc_basis,
        work_masters,
        time_entries,
        budgets,
        forecasts,
        direct_costs,
        metrics: None,
    };
    api_router(services, auth, tx, allow_setup)
}

fn get(path: &str) -> HttpRequest<Body> {
    HttpRequest::get(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .body(Body::empty())
        .unwrap()
}

fn post_json(path: &str, body: serde_json::Value) -> HttpRequest<Body> {
    HttpRequest::post(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn auth_status_reports_uninitialized_before_any_setup() {
    let router = router_with_setup(true).await;
    let response = router.oneshot(get("/api/auth/status")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["initialized"], false);
}

#[tokio::test]
async fn auth_status_needs_no_bearer_token() {
    // Same assertion as above, phrased to make explicit that omitting
    // Authorization entirely (not just an invalid token) still gets a
    // 200, not a 401 - the login page calls this before any session
    // exists.
    let router = router_with_setup(true).await;
    let request = HttpRequest::get("/api/auth/status")
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .body(Body::empty())
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn auth_setup_is_forbidden_when_allow_setup_is_false() {
    let router = router_with_setup(false).await;
    let response = router
        .oneshot(post_json(
            "/api/auth/setup",
            json!({ "username": "owner", "password": "password123", "displayName": "オーナー" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn auth_setup_creates_account_and_the_token_works_for_guarded_routes() {
    let router = router_with_setup(true).await;

    let setup_response = router
        .clone()
        .oneshot(post_json(
            "/api/auth/setup",
            json!({ "username": "owner", "password": "password123", "displayName": "オーナー" }),
        ))
        .await
        .unwrap();
    assert_eq!(setup_response.status(), StatusCode::OK);
    let setup_json = body_json(setup_response).await;
    assert_eq!(setup_json["success"], true);
    assert!(
        setup_json["token"].as_str().is_some(),
        "setup should mint a token"
    );

    // `initialized` should now be true.
    let status_response = router
        .clone()
        .oneshot(get("/api/auth/status"))
        .await
        .unwrap();
    assert_eq!(body_json(status_response).await["initialized"], true);

    // And the freshly-issued token works on a guarded route (the template
    // used `/api/items/list`; banto-cost removed items).
    let token = setup_json["token"].as_str().expect("token").to_string();
    let list_request = HttpRequest::post("/api/projects/list")
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(Body::from(json!({}).to_string()))
        .unwrap();
    let list_response = router.oneshot(list_request).await.unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
}

#[tokio::test]
async fn auth_setup_rejects_short_password_with_422_validation() {
    let router = router_with_setup(true).await;
    let response = router
        .oneshot(post_json(
            "/api/auth/setup",
            json!({ "username": "owner", "password": "short", "displayName": "オーナー" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "validation");
    assert_eq!(json["field_errors"][0]["field"], "password");
}

#[tokio::test]
async fn auth_setup_second_call_returns_success_false_already_initialized() {
    let router = router_with_setup(true).await;
    let first = post_json(
        "/api/auth/setup",
        json!({ "username": "owner", "password": "password123", "displayName": "オーナー" }),
    );
    router.clone().oneshot(first).await.unwrap();

    let second = post_json(
        "/api/auth/setup",
        json!({ "username": "someone-else", "password": "password123", "displayName": "誰か" }),
    );
    let response = router.oneshot(second).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["success"], false);
    assert!(json["error"].as_str().unwrap().contains("初期化"));
}

async fn setup_and_get_token(router: &Router) -> String {
    let response = router
        .clone()
        .oneshot(post_json(
            "/api/auth/setup",
            json!({ "username": "owner", "password": "password123", "displayName": "オーナー" }),
        ))
        .await
        .unwrap();
    body_json(response).await["token"]
        .as_str()
        .expect("token")
        .to_string()
}

#[tokio::test]
async fn auth_change_password_requires_a_bearer_token() {
    let router = router_with_setup(true).await;
    setup_and_get_token(&router).await;

    let response = router
        .oneshot(post_json(
            "/api/auth/change-password",
            json!({ "currentPassword": "password123", "newPassword": "newpassword1" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_change_password_rejects_wrong_current_password() {
    let router = router_with_setup(true).await;
    let token = setup_and_get_token(&router).await;

    let request = HttpRequest::post("/api/auth/change-password")
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "currentPassword": "not-the-password", "newPassword": "newpassword1" })
                .to_string(),
        ))
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let json = body_json(response).await;
    assert_eq!(json["field_errors"][0]["field"], "currentPassword");
}

/// Builds a router whose `/api/auth/login` verifier is backed by the
/// SAME `UsersService`/pool as `/api/auth/setup` and
/// `/api/auth/change-password` - mirrors how `banto-serve`/`src-tauri`
/// wire things in production (unlike `router_with_setup` above, whose
/// `demo_auth()` login verifier is intentionally independent, matching
/// the other tests in this module that only care about RBAC/CSRF
/// behavior). Also returns the `AuditLogService` sharing the router's
/// pool, so M14 tests can assert on what got recorded.
async fn router_with_real_login(allow_setup: bool) -> (Router, AuditLogService) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let system_info = SystemInfoService::new(pool.clone());
    let authz = banto_admin_services::authz::AuthzService::new(pool.clone());
    let customers = crate::customers::CustomersService::new(pool.clone()).with_events(tx.clone());
    let projects = crate::projects::ProjectsService::new(pool.clone()).with_events(tx.clone());
    let pipeline = crate::pipeline::PipelineService::new(pool.clone()).with_events(tx.clone());
    let orders = crate::orders::OrdersService::new(pool.clone()).with_events(tx.clone());
    let calc_basis = crate::calc_basis::CalcBasisService::new(pool.clone());
    let work_masters = crate::work_masters::WorkMastersService::new(pool.clone());
    let time_entries = crate::time_entries::TimeEntriesService::new(pool.clone());
    let budgets = crate::budgets::BudgetsService::new(pool.clone());
    let forecasts = crate::forecasts::ForecastsService::new(pool.clone());
    let direct_costs = crate::direct_costs::DirectCostsService::new(pool.clone());
    let audit = AuditLogService::new(pool);
    let auth = AuthState::new(
        audited_credential_verifier(users.clone(), audit.clone()),
        SessionValidation::lookup(banto_server::routes::user_session_lookup(users.clone())),
    );
    let services = Services {
        users,
        settings,
        audit: audit.clone(),
        backup,
        system_info,
        authz,
        customers,
        projects,
        pipeline,
        orders,
        calc_basis,
        work_masters,
        time_entries,
        budgets,
        forecasts,
        direct_costs,
        metrics: None,
    };
    (api_router(services, auth, tx, allow_setup), audit)
}

#[tokio::test]
async fn auth_change_password_success_then_relogin_with_new_password() {
    let (router, _audit) = router_with_real_login(true).await;
    let token = setup_and_get_token(&router).await;

    let change_request = HttpRequest::post("/api/auth/change-password")
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "currentPassword": "password123", "newPassword": "newpassword1" }).to_string(),
        ))
        .unwrap();
    let change_response = router.clone().oneshot(change_request).await.unwrap();
    assert_eq!(change_response.status(), StatusCode::OK);
    assert_eq!(body_json(change_response).await["success"], true);

    // The old password must no longer work.
    let old_login = router
        .clone()
        .oneshot(post_json(
            "/api/auth/login",
            json!({ "username": "owner", "password": "password123" }),
        ))
        .await
        .unwrap();
    assert_eq!(body_json(old_login).await["success"], false);

    // The new password must work.
    let new_login = router
        .oneshot(post_json(
            "/api/auth/login",
            json!({ "username": "owner", "password": "newpassword1" }),
        ))
        .await
        .unwrap();
    let json = body_json(new_login).await;
    assert_eq!(json["success"], true);
    assert!(json["token"].as_str().is_some());
}

// --- M10 RBAC ----------------------------------------------------------

fn put_json(path: &str, token: &str, body: serde_json::Value) -> HttpRequest<Body> {
    HttpRequest::put(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn post_json_auth(path: &str, token: &str, body: serde_json::Value) -> HttpRequest<Body> {
    HttpRequest::post(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn get_auth(path: &str, token: &str) -> HttpRequest<Body> {
    HttpRequest::get(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

fn delete_auth(path: &str, token: &str) -> HttpRequest<Body> {
    HttpRequest::delete(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn only_admin_can_list_users() {
    let (router, admin, editor, viewer) = router_with_role_tokens().await;

    for (token, expected) in [
        (&admin, StatusCode::OK),
        (&editor, StatusCode::FORBIDDEN),
        (&viewer, StatusCode::FORBIDDEN),
    ] {
        let response = router
            .clone()
            .oneshot(get_auth("/api/users", token))
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "token role mismatch");
    }
}

#[tokio::test]
async fn non_admin_users_write_routes_are_forbidden_with_forbidden_kind() {
    let (router, _admin, editor, _viewer) = router_with_role_tokens().await;

    let response = router
        .oneshot(post_json_auth(
            "/api/users",
            &editor,
            json!({
                "username": "newperson",
                "password": "password123",
                "displayName": "New Person",
                "role": "viewer"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "forbidden");
}

#[tokio::test]
async fn admin_can_create_list_update_reset_password_and_delete_users() {
    let (router, admin, _editor, _viewer) = router_with_role_tokens().await;

    let create_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/users",
            &admin,
            json!({
                "username": "newperson",
                "password": "password123",
                "displayName": "New Person",
                "role": "editor"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let created = body_json(create_response).await;
    assert_eq!(created["role"], "editor");
    let id = created["id"].as_i64().unwrap();

    let list_response = router
        .clone()
        .oneshot(get_auth("/api/users", &admin))
        .await
        .unwrap();
    let list = body_json(list_response).await;
    assert!(list.as_array().unwrap().iter().any(|u| u["id"] == id));

    let update_response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/users/{id}"),
            &admin,
            json!({ "displayName": "Updated Person", "role": "viewer" }),
        ))
        .await
        .unwrap();
    assert_eq!(update_response.status(), StatusCode::OK);
    assert_eq!(body_json(update_response).await["role"], "viewer");

    let reset_response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/users/{id}/reset-password"),
            &admin,
            json!({ "newPassword": "resetpassword1" }),
        ))
        .await
        .unwrap();
    assert_eq!(reset_response.status(), StatusCode::OK);
    assert_eq!(body_json(reset_response).await["success"], true);

    let delete_response = router
        .oneshot(delete_auth(&format!("/api/users/{id}"), &admin))
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn users_routes_are_unauthorized_without_a_token() {
    let (router, _admin, _editor, _viewer) = router_with_role_tokens().await;
    let response = router.oneshot(get("/api/users")).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// --- M12 per-user UI settings ------------------------------------------

fn put_ui_setting(key: &str, token: &str, value: &str) -> HttpRequest<Body> {
    put_json(
        &format!("/api/ui-settings/{key}"),
        token,
        json!({ "value": value }),
    )
}

#[tokio::test]
async fn ui_settings_round_trip_via_rest() {
    let (router, _admin, _editor, viewer) = router_with_role_tokens().await;

    // Unset key reads back as {"value": null}.
    let response = router
        .clone()
        .oneshot(get_auth("/api/ui-settings/theme", &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_json(response).await["value"].is_null());

    // PUT then GET round-trips - and note this is the VIEWER role:
    // writing your own UI settings needs no role floor (unlike
    // `settings_set`/`/api/users`).
    let put_response = router
        .clone()
        .oneshot(put_ui_setting("theme", &viewer, "glass"))
        .await
        .unwrap();
    assert_eq!(put_response.status(), StatusCode::NO_CONTENT);

    let response = router
        .oneshot(get_auth("/api/ui-settings/theme", &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["value"], "glass");
}

#[tokio::test]
async fn ui_settings_are_isolated_per_user() {
    let (router, admin, editor, _viewer) = router_with_role_tokens().await;

    let put_response = router
        .clone()
        .oneshot(put_ui_setting("theme", &admin, "glass"))
        .await
        .unwrap();
    assert_eq!(put_response.status(), StatusCode::NO_CONTENT);

    // The admin's value must NOT be visible to the editor's session -
    // each account reads its own `ui.{username}.*` namespace.
    let response = router
        .clone()
        .oneshot(get_auth("/api/ui-settings/theme", &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_json(response).await["value"].is_null());

    // And the admin still sees their own value.
    let response = router
        .oneshot(get_auth("/api/ui-settings/theme", &admin))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["value"], "glass");
}

#[tokio::test]
async fn ui_settings_reject_an_invalid_key_with_422_validation() {
    let (router, _admin, _editor, viewer) = router_with_role_tokens().await;

    // `%20` decodes to a space in the path param - an invalid key char.
    let response = router
        .clone()
        .oneshot(put_ui_setting("bad%20key!", &viewer, "x"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "validation");
    assert_eq!(json["field_errors"][0]["field"], "key");

    let response = router
        .oneshot(get_auth("/api/ui-settings/bad%20key!", &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn ui_settings_routes_are_unauthorized_without_a_token() {
    let (router, _admin, _editor, _viewer) = router_with_role_tokens().await;

    let response = router
        .clone()
        .oneshot(get("/api/ui-settings/theme"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = router
        .oneshot(post_json(
            "/api/ui-settings/theme",
            json!({ "value": "glass" }),
        ))
        .await
        .unwrap();
    // POST is not a registered method on this route, but the request
    // must still die at `require_auth` (401), not reach any handler.
    assert!(
        response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::METHOD_NOT_ALLOWED
    );
}

// --- M14 Audit -----------------------------------------------------------

/// Like `router_with_role_tokens`, but also returns the `AuditLogService`
/// sharing the router's pool (so these tests can query
/// `/api/audit-log/list` as the admin token and assert on what got
/// recorded), and wires the login verifier through
/// [`audited_credential_verifier`] so login events are actually recorded
/// - `router_with_role_tokens`'s own verifier predates M14 and stays a
///   plain credential check since none of ITS callers care about audit
///   events.
async fn router_with_role_tokens_and_audit() -> (Router, AuditLogService, String, String, String) {
    let (router, audit, admin, editor, viewer, _tx) =
        router_with_role_tokens_audit_and_events().await;
    (router, audit, admin, editor, viewer)
}

/// [`router_with_role_tokens_and_audit`] plus the app-wide event sender, so
/// a test can `subscribe()` and see the `ResourceChanged` events the
/// business routes emit (spec §3.5).
async fn router_with_role_tokens_audit_and_events() -> (
    Router,
    AuditLogService,
    String,
    String,
    String,
    broadcast::Sender<ServerEvent>,
) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let system_info = SystemInfoService::new(pool.clone());
    let authz = banto_admin_services::authz::AuthzService::new(pool.clone());
    let customers = crate::customers::CustomersService::new(pool.clone()).with_events(tx.clone());
    let projects = crate::projects::ProjectsService::new(pool.clone()).with_events(tx.clone());
    let pipeline = crate::pipeline::PipelineService::new(pool.clone()).with_events(tx.clone());
    let orders = crate::orders::OrdersService::new(pool.clone()).with_events(tx.clone());
    let calc_basis = crate::calc_basis::CalcBasisService::new(pool.clone());
    let work_masters = crate::work_masters::WorkMastersService::new(pool.clone());
    let time_entries = crate::time_entries::TimeEntriesService::new(pool.clone());
    let budgets = crate::budgets::BudgetsService::new(pool.clone());
    let forecasts = crate::forecasts::ForecastsService::new(pool.clone());
    let direct_costs = crate::direct_costs::DirectCostsService::new(pool.clone());
    let audit = AuditLogService::new(pool.clone());

    users
        .setup_first_user("admin", "password123", "管理者")
        .await
        .expect("setup_first_user");
    users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create editor");
    users
        .create_user("viewer", "password123", "閲覧者", Role::Viewer)
        .await
        .expect("create viewer");
    // banto-cost: projects 101 and 102 (no members) for the authz tests.
    seed_projects(&pool).await;

    let auth = AuthState::new(
        audited_credential_verifier(users.clone(), audit.clone()),
        SessionValidation::lookup(banto_server::routes::user_session_lookup(users.clone())),
    );
    let admin_token = auth
        .login("admin", "password123")
        .await
        .expect("admin login");
    let editor_token = auth
        .login("editor", "password123")
        .await
        .expect("editor login");
    let viewer_token = auth
        .login("viewer", "password123")
        .await
        .expect("viewer login");

    let services = Services {
        users,
        settings,
        audit: audit.clone(),
        backup,
        system_info,
        authz,
        customers,
        projects,
        pipeline,
        orders,
        calc_basis,
        work_masters,
        time_entries,
        budgets,
        forecasts,
        direct_costs,
        metrics: None,
    };
    let router = api_router(services, auth, tx.clone(), false);
    (router, audit, admin_token, editor_token, viewer_token, tx)
}

/// Like `router_with_role_tokens_and_audit`, but for the M17
/// `/api/backups/*` (and, since both need a real writable temp
/// directory, M20 `/api/attachments/*`) tests, which need services that
/// ACTUALLY WORK end to end (create/list/read/stage a real file), not
/// [`unused_backup_service`]/[`unused_attachments_service`]'s
/// placeholders. Two things every other helper in this module gets to
/// skip:
/// - The router's own pool must be a real ON-DISK sqlite file, not
///   `:memory:` (`migrate_memory()`) - `VACUUM INTO` (which
///   `BackupService::create` uses) silently writes nothing when its
///   SOURCE connection is `:memory:` (see `crate::backup`'s test module
///   doc comment for the empirically-verified reason).
/// - The returned `tempfile::TempDir` guard must be kept alive by the
///   caller for as long as the router is in use - dropping it deletes
///   the directory `backups/`/`restore-pending.sqlite3`/`attachments/`
///   live in.
async fn router_with_role_tokens_and_backup() -> (Router, tempfile::TempDir, String, String, String)
{
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("admin-template.sqlite3");
    let pool = banto_storage::connect_sqlite(&db_path)
        .await
        .expect("connect_sqlite");
    sqlx::migrate!("./migrations-sqlite")
        .run(&pool)
        .await
        .expect("migrate");
    // V2 PR2: services take a backend-agnostic `Db`; wrap the on-disk SQLite
    // pool (a real file is required here so `VACUUM INTO` actually writes).
    let db = banto_storage::Db::Sqlite(pool);

    let (tx, _rx) = broadcast::channel(16);
    let users = UsersService::new(db.clone());
    let settings = SettingsService::new(db.clone());
    let backup = BackupService::new(db_path, db.clone());
    let system_info = SystemInfoService::new(db.clone());
    let authz = banto_admin_services::authz::AuthzService::new(db.clone());
    let customers = crate::customers::CustomersService::new(db.clone());
    let projects = crate::projects::ProjectsService::new(db.clone());
    let pipeline = crate::pipeline::PipelineService::new(db.clone());
    let orders = crate::orders::OrdersService::new(db.clone());
    let calc_basis = crate::calc_basis::CalcBasisService::new(db.clone());
    let work_masters = crate::work_masters::WorkMastersService::new(db.clone());
    let time_entries = crate::time_entries::TimeEntriesService::new(db.clone());
    let budgets = crate::budgets::BudgetsService::new(db.clone());
    let forecasts = crate::forecasts::ForecastsService::new(db.clone());
    let direct_costs = crate::direct_costs::DirectCostsService::new(db.clone());
    let audit = AuditLogService::new(db);

    users
        .setup_first_user("admin", "password123", "管理者")
        .await
        .expect("setup_first_user");
    users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create editor");
    users
        .create_user("viewer", "password123", "閲覧者", Role::Viewer)
        .await
        .expect("create viewer");

    let auth = AuthState::new(
        audited_credential_verifier(users.clone(), audit.clone()),
        SessionValidation::lookup(banto_server::routes::user_session_lookup(users.clone())),
    );
    let admin_token = auth
        .login("admin", "password123")
        .await
        .expect("admin login");
    let editor_token = auth
        .login("editor", "password123")
        .await
        .expect("editor login");
    let viewer_token = auth
        .login("viewer", "password123")
        .await
        .expect("viewer login");

    let services = Services {
        users,
        settings,
        audit,
        backup,
        system_info,
        authz,
        customers,
        projects,
        pipeline,
        orders,
        calc_basis,
        work_masters,
        time_entries,
        budgets,
        forecasts,
        direct_costs,
        metrics: None,
    };
    let router = api_router(services, auth, tx, false);
    (router, dir, admin_token, editor_token, viewer_token)
}

/// (a) `/api/audit-log/list` is admin-only: 200 for admin, 403 for
/// editor/viewer.
#[tokio::test]
async fn audit_log_list_is_admin_only() {
    let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;

    let admin_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    assert_eq!(admin_response.status(), StatusCode::OK);

    for token in [&editor, &viewer] {
        let response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                token,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "token role mismatch"
        );
    }

    // The list denial keeps `resource: "audit_log"` - it reads the audit log
    // body itself, unlike the config routes whose denial is "settings" (the
    // two-guard split in `audit_log_router`, maintenance-review-2026-08 §5.3
    // H-4). Pinning both sides here guards against the split regressing into a
    // single shared resource tag again.
    let list_rows = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(list_rows).await["rows"].clone();
    assert!(
        rows.as_array()
            .unwrap()
            .iter()
            .any(|r| r["action"] == "denied" && r["resource"] == "audit_log"),
        "expected a denied/audit_log entry, got {rows:?}"
    );
}

#[tokio::test]
async fn audit_log_list_requires_a_token() {
    let (router, _audit, _admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;
    let response = router
        .oneshot(post_json(
            "/api/audit-log/list",
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// `?asOfId=` (Issue #248): an omitted boundary answers with every row and
/// the newest `id` in `asOfId` (the old result plus one field); a given one
/// is echoed back and pins the set - rows recorded after it are neither
/// listed nor counted.
#[tokio::test]
async fn audit_log_list_as_of_id_pins_the_snapshot() {
    let (router, audit, admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;
    let newest_first = json!({
        "sort": [{ "field": "ts", "direction": "desc" }],
        "filters": [],
        "pagination": { "offset": 0, "limit": 2 }
    });

    let first = body_json(
        router
            .clone()
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                newest_first.clone(),
            ))
            .await
            .unwrap(),
    )
    .await;
    let everything = audit.list(ListParams::default()).await.unwrap();
    let max_id = everything.rows.iter().map(|r| r.id).max().unwrap();
    let as_of_id = first["asOfId"].as_i64().expect("asOfId is returned");
    assert_eq!(
        as_of_id, max_id,
        "an omitted boundary is the newest id: {first}"
    );
    assert_eq!(first["totalCount"], everything.total_count);
    assert_eq!(first["rows"][0]["id"], max_id);

    for action in ["create", "update"] {
        audit
            .try_record(crate::audit::AuditEntry {
                actor_username: Some("admin"),
                actor_role: Some("admin"),
                action,
                resource: "projects",
                entity_id: None,
                detail: None,
                origin: "rest",
                result: "ok",
            })
            .await
            .unwrap();
    }

    let pinned = body_json(
        router
            .clone()
            .oneshot(post_json_auth(
                &format!("/api/audit-log/list?asOfId={as_of_id}"),
                &admin,
                newest_first.clone(),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(pinned["asOfId"], as_of_id);
    assert_eq!(pinned["totalCount"], first["totalCount"]);
    assert_eq!(pinned["rows"], first["rows"], "the new rows stay out");

    let fresh = body_json(
        router
            .oneshot(post_json_auth("/api/audit-log/list", &admin, newest_first))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(fresh["asOfId"], max_id + 2);
    assert_eq!(fresh["totalCount"], everything.total_count + 2);
}

/// A bounded read does not run the retention prune (Issue #248, same as
/// banto-industrial #448/#464): with the row cap reached, pruning on every
/// read would delete rows inside the viewer's boundary and expire each
/// generation at its second block. The unbounded read still prunes.
#[tokio::test]
async fn audit_log_list_with_as_of_id_does_not_prune() {
    let (router, audit, admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;
    let response = router
        .clone()
        .oneshot(put_json(
            "/api/audit-log/config",
            &admin,
            json!({ "retentionDays": null, "retentionRows": 3 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    for _ in 0..5 {
        audit
            .try_record(crate::audit::AuditEntry {
                actor_username: Some("admin"),
                actor_role: Some("admin"),
                action: "create",
                resource: "projects",
                entity_id: None,
                detail: None,
                origin: "rest",
                result: "ok",
            })
            .await
            .unwrap();
    }
    let before = audit.list(ListParams::default()).await.unwrap().total_count;
    assert!(before > 3, "more rows than the cap: {before}");

    let bounded = router
        .clone()
        .oneshot(post_json_auth(
            "/api/audit-log/list?asOfId=1000000",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    assert_eq!(bounded.status(), StatusCode::OK);
    let bounded = body_json(bounded).await;
    assert_eq!(bounded["totalCount"], before);
    assert_eq!(bounded["deletionEpoch"], 0, "nothing pruned yet: {bounded}");
    assert_eq!(
        audit.list(ListParams::default()).await.unwrap().total_count,
        before,
        "a bounded read deletes nothing"
    );

    let unbounded = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let unbounded = body_json(unbounded).await;
    assert_eq!(unbounded["totalCount"], 3);
    assert_eq!(
        unbounded["deletionEpoch"], 1,
        "the prune advanced the deletion epoch in the same answer: {unbounded}"
    );
    assert_eq!(
        audit.list(ListParams::default()).await.unwrap().total_count,
        3,
        "the unbounded read still prunes"
    );
}

/// The admin floor is unchanged for a bounded read: `editor`/`viewer` get
/// 403 with or without `asOfId`, and a malformed `asOfId` is a 400
/// `bad_request` (the `ErrorBody` shape, not axum's plain-text rejection).
#[tokio::test]
async fn audit_log_list_with_as_of_id_is_admin_only_and_validated() {
    let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    for token in [&editor, &viewer] {
        let response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/audit-log/list?asOfId=1",
                token,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    let response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list?asOfId=abc",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(response).await["kind"], "bad_request");
}

/// `GET /api/audit-log/config` is admin-only: 200 (with the default
/// retention policy) for admin, 403 for editor/viewer.
#[tokio::test]
async fn audit_config_get_is_admin_only() {
    let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;

    let admin_response = router
        .clone()
        .oneshot(get_auth("/api/audit-log/config", &admin))
        .await
        .unwrap();
    assert_eq!(admin_response.status(), StatusCode::OK);
    let body = body_json(admin_response).await;
    assert_eq!(body["retentionDays"], 90);
    assert_eq!(body["retentionRows"], 100_000);

    for token in [&editor, &viewer] {
        let response = router
            .clone()
            .oneshot(get_auth("/api/audit-log/config", token))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "token role mismatch"
        );
    }
}

/// `GET /api/system/info` (M-review 2026-08 §2.4) is admin-only and needs a
/// token: 200 with the diagnostics payload for admin, 403 for editor/viewer,
/// 401 for no token. Read-only, so nothing is audited.
#[tokio::test]
async fn system_info_is_admin_only() {
    let (router, admin, editor, viewer) = router_with_role_tokens().await;

    let admin_response = router
        .clone()
        .oneshot(get_auth("/api/system/info", &admin))
        .await
        .unwrap();
    assert_eq!(admin_response.status(), StatusCode::OK);
    let body = body_json(admin_response).await;
    // The migrated in-memory DB reports the sqlite dialect and a version.
    assert_eq!(body["dbDialect"], "sqlite");
    assert!(body["appVersion"].is_string());
    assert!(body["migrationVersion"].is_number());
    assert!(body["activeSessions"].as_u64().unwrap() >= 3); // admin+editor+viewer logged in
                                                            // ADR-0013 (Issue #185): `router_with_role_tokens` wires `metrics: None`
                                                            // (no probe) - the field must still be present on the wire, as `null`,
                                                            // not simply absent (see `system_info_reports_metrics_when_probe_is_present`
                                                            // below for the `Some` case).
    assert!(body["metrics"].is_null());

    for token in [&editor, &viewer] {
        let response = router
            .clone()
            .oneshot(get_auth("/api/system/info", token))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "system info is admin-only"
        );
    }
}

#[tokio::test]
async fn system_info_requires_a_token() {
    let (router, _admin, _editor, _viewer) = router_with_role_tokens().await;
    let response = router
        .oneshot(get_auth("/api/system/info", "not-a-real-token"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// ADR-0013 (Issue #185): when the app layer wires a `metrics` probe (the
/// `Some` case - `banto-serve`/`src-tauri` do this via
/// `SystemMetricsSampler::sample` under `#[cfg(feature = "system-metrics")]`),
/// `GET /api/system/info` folds its snapshot into the wire response verbatim.
/// This test stands in for that feature with a fixed stub closure - it does
/// not need the `system-metrics` feature (or a real `sysinfo` sample) to
/// prove the plumbing between `MetricsProbe` and the JSON body round-trips.
#[tokio::test]
async fn system_info_reports_metrics_when_probe_is_present() {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let system_info = SystemInfoService::new(pool.clone());
    let authz = banto_admin_services::authz::AuthzService::new(pool.clone());
    let customers = crate::customers::CustomersService::new(pool.clone()).with_events(tx.clone());
    let projects = crate::projects::ProjectsService::new(pool.clone()).with_events(tx.clone());
    let pipeline = crate::pipeline::PipelineService::new(pool.clone()).with_events(tx.clone());
    let orders = crate::orders::OrdersService::new(pool.clone()).with_events(tx.clone());
    let calc_basis = crate::calc_basis::CalcBasisService::new(pool.clone());
    let work_masters = crate::work_masters::WorkMastersService::new(pool.clone());
    let time_entries = crate::time_entries::TimeEntriesService::new(pool.clone());
    let budgets = crate::budgets::BudgetsService::new(pool.clone());
    let forecasts = crate::forecasts::ForecastsService::new(pool.clone());
    let direct_costs = crate::direct_costs::DirectCostsService::new(pool.clone());
    let audit = AuditLogService::new(pool);
    let auth = demo_auth();
    let token = auth.login("admin", "admin").await.unwrap();

    let stub = SystemMetrics {
        host_cpu_percent: 12.5,
        host_memory_total_bytes: 16_000_000_000,
        host_memory_used_bytes: 8_000_000_000,
        host_swap_total_bytes: 2_000_000_000,
        host_swap_used_bytes: 0,
        process_cpu_percent: 1.25,
        process_memory_bytes: 42_000_000,
        cpu_count: 8,
    };
    let metrics: MetricsProbe = std::sync::Arc::new({
        let stub = stub.clone();
        move || Some(stub.clone())
    });

    let services = Services {
        users,
        settings,
        audit,
        backup,
        system_info,
        authz,
        customers,
        projects,
        pipeline,
        orders,
        calc_basis,
        work_masters,
        time_entries,
        budgets,
        forecasts,
        direct_costs,
        metrics: Some(metrics),
    };
    let router = api_router(services, auth, tx, false);

    let response = router
        .oneshot(get_auth("/api/system/info", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    let metrics_json = &body["metrics"];
    assert!(!metrics_json.is_null());
    assert_eq!(metrics_json["hostCpuPercent"], 12.5);
    assert_eq!(metrics_json["hostMemoryTotalBytes"], 16_000_000_000_u64);
    assert_eq!(metrics_json["hostMemoryUsedBytes"], 8_000_000_000_u64);
    assert_eq!(metrics_json["hostSwapTotalBytes"], 2_000_000_000_u64);
    assert_eq!(metrics_json["hostSwapUsedBytes"], 0);
    assert_eq!(metrics_json["processCpuPercent"], 1.25);
    assert_eq!(metrics_json["processMemoryBytes"], 42_000_000_u64);
    assert_eq!(metrics_json["cpuCount"], 8);
}

/// `PUT /api/audit-log/config` (admin) persists the new policy - a
/// following `GET` reflects it - and records a `settings_change` audit
/// entry (spec M14: settings mutations are audited, unlike the read-only
/// `GET`). `editor`/`viewer` are rejected with 403 and the policy is left
/// untouched.
#[tokio::test]
async fn audit_config_apply_persists_and_is_admin_only() {
    let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;

    for token in [&editor, &viewer] {
        let response = router
            .clone()
            .oneshot(put_json(
                "/api/audit-log/config",
                token,
                json!({ "retentionDays": 30, "retentionRows": 5000 }),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "token role mismatch"
        );
    }

    let apply_response = router
        .clone()
        .oneshot(put_json(
            "/api/audit-log/config",
            &admin,
            json!({ "retentionDays": 30, "retentionRows": 5000 }),
        ))
        .await
        .unwrap();
    assert_eq!(apply_response.status(), StatusCode::OK);
    let applied = body_json(apply_response).await;
    assert_eq!(applied["retentionDays"], 30);
    assert_eq!(applied["retentionRows"], 5000);

    let get_response = router
        .clone()
        .oneshot(get_auth("/api/audit-log/config", &admin))
        .await
        .unwrap();
    let refetched = body_json(get_response).await;
    assert_eq!(refetched["retentionDays"], 30);
    assert_eq!(refetched["retentionRows"], 5000);

    let list_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(list_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    let entry = rows
        .iter()
        .find(|r| r["action"] == "settings_change" && r["resource"] == "settings")
        .unwrap_or_else(|| panic!("expected a settings_change/settings entry, got {rows:?}"));
    assert_eq!(entry["actorUsername"], "admin");
    assert_eq!(entry["origin"], "rest");
    assert_eq!(entry["result"], "ok");

    // The editor/viewer denials above are tagged `resource: "settings"` (NOT
    // "audit_log"): the config routes read/write the audit *settings*, so
    // their denial matches the `settings_change` success entry and the Tauri
    // twin (`audit_config_apply` calls `require_role(.., "settings")`), keeping
    // denied/success filterable under one resource. `audit-log/list` denials
    // keep "audit_log" - see `audit_log_list_is_admin_only`
    // (maintenance-review-2026-08 §5.3 H-4).
    let denial = rows
        .iter()
        .find(|r| r["action"] == "denied" && r["resource"] == "settings")
        .unwrap_or_else(|| panic!("expected a denied/settings entry, got {rows:?}"));
    assert_eq!(denial["origin"], "rest");
    assert_eq!(denial["result"], "denied");
}

/// `users` create/reset-password entries must never leak the plaintext
/// password into `detail` (spec M14's hard rule - see
/// `crate::audit`'s module doc comment).
#[tokio::test]
async fn users_create_audit_entry_never_contains_the_password() {
    let (router, _audit, admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;

    router
        .clone()
        .oneshot(post_json_auth(
            "/api/users",
            &admin,
            json!({
                "username": "newperson",
                "password": "supersecret1",
                "displayName": "New Person",
                "role": "viewer"
            }),
        ))
        .await
        .unwrap();

    let list_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(list_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    let entry = rows
        .iter()
        .find(|r| r["action"] == "create" && r["resource"] == "users")
        .expect("expected a create/users entry");
    assert_eq!(entry["actorUsername"], "admin");
    let detail = entry["detail"].as_str().expect("detail should be set");
    assert!(
        !detail.contains("supersecret1"),
        "audit detail must never contain the password: {detail}"
    );
    assert!(detail.contains("newperson"));
}

/// (d) A failed login attempt is recorded as `login_failed`. Uses
/// `router_with_real_login` (not `router_with_role_tokens_and_audit`)
/// since it wires `/api/auth/login` through the same
/// `audited_credential_verifier` production code path.
#[tokio::test]
async fn login_failure_is_recorded_as_login_failed() {
    let (router, audit) = router_with_real_login(true).await;
    setup_and_get_token(&router).await; // creates the "owner" admin account

    let response = router
        .oneshot(post_json(
            "/api/auth/login",
            json!({ "username": "owner", "password": "wrong-password" }),
        ))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["success"], false);

    let result = audit.list(ListParams::default()).await.unwrap();
    let entry = result
        .rows
        .iter()
        .find(|r| r.action == "login_failed")
        .unwrap_or_else(|| panic!("expected a login_failed entry, got {:?}", result.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("owner"));
    assert_eq!(entry.actor_role, None);
    assert_eq!(entry.result, "failed");
}

#[tokio::test]
async fn login_success_is_recorded_as_login() {
    let (router, audit) = router_with_real_login(true).await;
    setup_and_get_token(&router).await;

    router
        .clone()
        .oneshot(post_json(
            "/api/auth/login",
            json!({ "username": "owner", "password": "password123" }),
        ))
        .await
        .unwrap();

    let result = audit.list(ListParams::default()).await.unwrap();
    assert!(
        result
            .rows
            .iter()
            .any(|r| r.action == "login" && r.actor_username.as_deref() == Some("owner")),
        "expected a login entry, got {:?}",
        result.rows
    );
}

#[tokio::test]
async fn logout_is_recorded() {
    let (router, audit) = router_with_real_login(true).await;
    let token = setup_and_get_token(&router).await;

    router
        .oneshot(
            HttpRequest::post("/api/auth/logout")
                .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let result = audit.list(ListParams::default()).await.unwrap();
    assert!(
        result
            .rows
            .iter()
            .any(|r| r.action == "logout" && r.actor_username.as_deref() == Some("owner")),
        "expected a logout entry, got {:?}",
        result.rows
    );
}

/// Issue #278: logout needs no credentials, so a request without a live
/// session must leave no audit row (otherwise it grows the table for free).
/// A real logout still records exactly one entry, with the right actor.
#[tokio::test]
async fn logout_without_a_live_session_is_not_audited() {
    let (router, audit) = router_with_real_login(true).await;
    let token = setup_and_get_token(&router).await;

    let logout = |auth: Option<String>| {
        let mut req =
            HttpRequest::post("/api/auth/logout").header(CLIENT_HEADER.0, CLIENT_HEADER.1);
        if let Some(value) = auth {
            req = req.header("Authorization", value);
        }
        req.body(Body::empty()).unwrap()
    };
    let logout_rows = || async {
        audit
            .list(ListParams::default())
            .await
            .unwrap()
            .rows
            .into_iter()
            .filter(|r| r.action == "logout")
            .collect::<Vec<_>>()
    };

    // No header, a malformed one, and an unknown token - repeatedly.
    for _ in 0..8 {
        router.clone().oneshot(logout(None)).await.unwrap();
        router
            .clone()
            .oneshot(logout(Some("Bearer not-a-real-token".to_string())))
            .await
            .unwrap();
        router
            .clone()
            .oneshot(logout(Some("garbage".to_string())))
            .await
            .unwrap();
    }
    assert!(
        logout_rows().await.is_empty(),
        "unauthenticated logout audited"
    );

    // A valid logout records one entry for the right actor...
    router
        .clone()
        .oneshot(logout(Some(format!("Bearer {token}"))))
        .await
        .unwrap();
    let rows = logout_rows().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].actor_username.as_deref(), Some("owner"));

    // ...and replaying the now-revoked token adds nothing.
    for _ in 0..8 {
        router
            .clone()
            .oneshot(logout(Some(format!("Bearer {token}"))))
            .await
            .unwrap();
    }
    assert_eq!(logout_rows().await.len(), 1, "revoked-token logout audited");
}

/// Issue #278: the username of a failed login is caller-supplied (no account
/// need exist), so what lands in the audit row is bounded and visibly cut.
#[tokio::test]
async fn failed_login_with_oversized_username_is_bounded_in_the_audit_log() {
    let (router, audit) = router_with_real_login(true).await;
    setup_and_get_token(&router).await;

    let huge = "あ".repeat(64 * 1024 / 3);
    let response = router
        .oneshot(post_json(
            "/api/auth/login",
            json!({ "username": huge, "password": "wrong-password" }),
        ))
        .await
        .unwrap();
    // Same answer as for any unknown user (no enumeration signal).
    assert_eq!(body_json(response).await["success"], false);

    let result = audit.list(ListParams::default()).await.unwrap();
    let entry = result
        .rows
        .iter()
        .find(|r| r.action == "login_failed")
        .expect("login_failed entry");
    let stored = entry.actor_username.as_deref().expect("actor_username");
    assert!(
        stored.chars().count() <= 32,
        "stored {} chars",
        stored.chars().count()
    );
    assert!(stored.len() <= 32 * 4);
    assert!(
        stored.ends_with('…'),
        "truncation must be visible: {stored}"
    );
}

#[tokio::test]
async fn setup_is_recorded() {
    let (router, audit) = router_with_real_login(true).await;
    setup_and_get_token(&router).await;

    let result = audit.list(ListParams::default()).await.unwrap();
    assert!(
        result
            .rows
            .iter()
            .any(|r| r.action == "setup" && r.actor_username.as_deref() == Some("owner")),
        "expected a setup entry, got {:?}",
        result.rows
    );
}

/// Spec M14 (coordinator review): a self-service password change is a
/// security event and must be recorded as `password_change` (actor =
/// entity = the caller) - and the entry must never carry the password.
#[tokio::test]
async fn change_password_is_recorded_as_password_change() {
    let (router, audit) = router_with_real_login(true).await;
    let token = setup_and_get_token(&router).await;

    let change_request = HttpRequest::post("/api/auth/change-password")
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "currentPassword": "password123", "newPassword": "newpassword1" }).to_string(),
        ))
        .unwrap();
    let response = router.oneshot(change_request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let result = audit.list(ListParams::default()).await.unwrap();
    let entry = result
        .rows
        .iter()
        .find(|r| r.action == "password_change")
        .unwrap_or_else(|| panic!("expected a password_change entry, got {:?}", result.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("owner"));
    assert_eq!(entry.actor_role.as_deref(), Some("admin"));
    assert_eq!(entry.resource, "users");
    // `setup_first_user` creates the very first row -> id 1.
    assert_eq!(entry.entity_id.as_deref(), Some("1"));
    assert_eq!(entry.origin, "rest");
    assert_eq!(entry.result, "ok");
    assert_eq!(entry.detail, None, "detail must never carry the password");
}

// --- M17: SQLite backup/restore -------------------------------------------

fn post_bytes_auth(path: &str, token: &str, bytes: Vec<u8>) -> HttpRequest<Body> {
    HttpRequest::post(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/octet-stream")
        .body(Body::from(bytes))
        .unwrap()
}

async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

/// admin can create a backup, see it in the list, and download the exact
/// same bytes back (spec M17: "バックアップファイルが作成・ダウンロード
/// でき"). `POST /api/backups` is recorded as `action: "backup"`.
#[tokio::test]
async fn admin_can_create_list_and_download_backups() {
    let (router, _dir, admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;

    let create_response = router
        .clone()
        .oneshot(post_bytes_auth("/api/backups", &admin, Vec::new()))
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let created = body_json(create_response).await;
    let file_name = created["fileName"].as_str().expect("fileName").to_string();
    assert!(created["sizeBytes"].as_u64().unwrap() > 0);

    let list_response = router
        .clone()
        .oneshot(get_auth("/api/backups", &admin))
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let listed = body_json(list_response).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["fileName"], file_name);

    let download_response = router
        .oneshot(get_auth(&format!("/api/backups/{file_name}"), &admin))
        .await
        .unwrap();
    assert_eq!(download_response.status(), StatusCode::OK);
    let disposition = download_response
        .headers()
        .get(axum::http::header::CONTENT_DISPOSITION)
        .expect("Content-Disposition header")
        .to_str()
        .unwrap()
        .to_string();
    assert!(disposition.contains("attachment"));
    assert!(disposition.contains(&file_name));
    let bytes = body_bytes(download_response).await;
    assert_eq!(&bytes[0..16], b"SQLite format 3\0");
}

/// `editor`/`viewer` cannot reach ANY `/api/backups/*` route (spec M17:
/// "admin以外は全API 403") - checked against both a read route (`GET
/// /api/backups`) and a write route (`POST /api/backups`).
#[tokio::test]
async fn editor_and_viewer_cannot_access_backups_routes() {
    let (router, _dir, _admin, editor, viewer) = router_with_role_tokens_and_backup().await;

    for token in [&editor, &viewer] {
        let list_response = router
            .clone()
            .oneshot(get_auth("/api/backups", token))
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::FORBIDDEN);
        let json = body_json(list_response).await;
        assert_eq!(json["kind"], "forbidden");

        let create_response = router
            .clone()
            .oneshot(post_bytes_auth("/api/backups", token, Vec::new()))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::FORBIDDEN);
    }
}

/// Uploading garbage bytes to `/api/backups/restore` must be rejected
/// (spec M17: "壊れたファイルのリストアが検証で拒否される") - `Validation`
/// maps to `422` (`banto_server::response::status_for`), and no pending
/// restore is left staged.
#[tokio::test]
async fn restore_upload_of_garbage_bytes_is_rejected_as_validation() {
    let (router, _dir, admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;

    let response = router
        .clone()
        .oneshot(post_bytes_auth(
            "/api/backups/restore",
            &admin,
            b"not a sqlite file".to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "validation");

    let pending_response = router
        .oneshot(get_auth("/api/backups/pending-restore", &admin))
        .await
        .unwrap();
    assert_eq!(body_json(pending_response).await, serde_json::Value::Null);
}

/// Full stage-from-existing-backup -> cancel round trip (spec M17),
/// asserting both the `pending-restore` status endpoint AND the
/// `restore_staged`/`restore_cancelled` audit entries it records.
#[tokio::test]
async fn stage_restore_from_existing_backup_then_cancel_is_recorded_in_the_audit_log() {
    let (router, _dir, admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;

    let create_response = router
        .clone()
        .oneshot(post_bytes_auth("/api/backups", &admin, Vec::new()))
        .await
        .unwrap();
    let file_name = body_json(create_response).await["fileName"]
        .as_str()
        .unwrap()
        .to_string();

    let stage_response = router
        .clone()
        .oneshot(post_bytes_auth(
            &format!("/api/backups/{file_name}/restore"),
            &admin,
            Vec::new(),
        ))
        .await
        .unwrap();
    assert_eq!(stage_response.status(), StatusCode::NO_CONTENT);

    let pending_response = router
        .clone()
        .oneshot(get_auth("/api/backups/pending-restore", &admin))
        .await
        .unwrap();
    let pending = body_json(pending_response).await;
    assert!(pending["sizeBytes"].as_u64().unwrap() > 0);

    let cancel_response = router
        .clone()
        .oneshot(delete_auth("/api/backups/pending-restore", &admin))
        .await
        .unwrap();
    assert_eq!(cancel_response.status(), StatusCode::NO_CONTENT);

    let pending_after_cancel = router
        .clone()
        .oneshot(get_auth("/api/backups/pending-restore", &admin))
        .await
        .unwrap();
    assert_eq!(
        body_json(pending_after_cancel).await,
        serde_json::Value::Null
    );

    let audit_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(audit_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    assert!(
        rows.iter()
            .any(|r| r["action"] == "backup" && r["resource"] == "backups"),
        "expected a backup entry, got {rows:?}"
    );
    assert!(
        rows.iter()
            .any(|r| r["action"] == "restore_staged" && r["resource"] == "backups"),
        "expected a restore_staged entry, got {rows:?}"
    );
    assert!(
        rows.iter()
            .any(|r| r["action"] == "restore_cancelled" && r["resource"] == "backups"),
        "expected a restore_cancelled entry, got {rows:?}"
    );
}

// --- Grant sessions (credential-less issuance, ADR-0017) -------------------
//
// Viewer-public (`docs/design/viewer-public-plan.md` §5 / ADR-0012) is the first
// grant kind; a derived app's commissioning mode is the second. The security
// property under test is that `POST /api/auth/grant/{kind}` is the ONLY thing
// a kind's condition unlocks: the token it hands out is an ordinary session
// of the spec's fixed identity, so every existing guard (`require_auth`,
// `RoleGuard`, the audit trail) applies to it unchanged, and there is no path
// from a viewer grant to a write.

/// Router + the service handles the 閲覧公開 tests need to set up and assert:
/// `SettingsService` to flip `server.viewer_public` (the grant condition
/// re-reads it live, so this works after the router is already built),
/// `AuditLogService` to assert on `denied` entries without needing an admin
/// token, and `UsersService` to prove no `public` account row is ever created.
///
/// `server.enabled` stays `false` - this router is driven through
/// `tower::oneshot`, never an actual socket, and `set_server_config`'s
/// exclusivity guard only looks at `enabled` (see that method's
/// `viewer_public_can_be_enabled_while_lan_access_is_off` test).
async fn router_with_viewer_public(
    viewer_public: bool,
) -> (Router, SettingsService, AuditLogService, UsersService) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let system_info = SystemInfoService::new(pool.clone());
    let authz = banto_admin_services::authz::AuthzService::new(pool.clone());
    let customers = crate::customers::CustomersService::new(pool.clone()).with_events(tx.clone());
    let projects = crate::projects::ProjectsService::new(pool.clone()).with_events(tx.clone());
    let pipeline = crate::pipeline::PipelineService::new(pool.clone()).with_events(tx.clone());
    let orders = crate::orders::OrdersService::new(pool.clone()).with_events(tx.clone());
    let calc_basis = crate::calc_basis::CalcBasisService::new(pool.clone());
    let work_masters = crate::work_masters::WorkMastersService::new(pool.clone());
    let time_entries = crate::time_entries::TimeEntriesService::new(pool.clone());
    let budgets = crate::budgets::BudgetsService::new(pool.clone());
    let forecasts = crate::forecasts::ForecastsService::new(pool.clone());
    let direct_costs = crate::direct_costs::DirectCostsService::new(pool.clone());
    let audit = AuditLogService::new(pool);

    settings
        .set_server_config(&crate::settings::ServerSettings {
            viewer_public,
            ..crate::settings::ServerSettings::default()
        })
        .await
        .expect("seed server config");

    let auth = AuthState::new(
        audited_credential_verifier(users.clone(), audit.clone()),
        SessionValidation::lookup(banto_server::routes::user_session_lookup(users.clone())),
    );
    let services = Services {
        users: users.clone(),
        settings: settings.clone(),
        audit: audit.clone(),
        backup,
        system_info,
        authz,
        customers,
        projects,
        pipeline,
        orders,
        calc_basis,
        work_masters,
        time_entries,
        budgets,
        forecasts,
        direct_costs,
        metrics: None,
    };
    (
        api_router(services, auth, tx, false),
        settings,
        audit,
        users,
    )
}

fn post_empty(path: &str) -> HttpRequest<Body> {
    HttpRequest::post(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .body(Body::empty())
        .unwrap()
}

/// `post_empty` with a known peer (`ConnectInfo`, as `BoundServer::serve`
/// supplies it; `tower::oneshot` alone has none).
fn post_empty_from(path: &str, peer: std::net::SocketAddr) -> HttpRequest<Body> {
    let mut req = post_empty(path);
    req.extensions_mut()
        .insert(axum::extract::ConnectInfo(peer));
    req
}

fn get_from(path: &str, peer: std::net::SocketAddr) -> HttpRequest<Body> {
    let mut req = get(path);
    req.extensions_mut()
        .insert(axum::extract::ConnectInfo(peer));
    req
}

const LOOPBACK_PEER: std::net::SocketAddr =
    std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 51000);
const LAN_PEER: std::net::SocketAddr = std::net::SocketAddr::new(
    std::net::IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 10, 20)),
    51000,
);

/// Mint a viewer-public grant through the real route, asserting the wire
/// shape on the way (`{success:true, token}`).
async fn public_viewer_token(router: &Router) -> String {
    let response = router
        .clone()
        .oneshot(post_empty("/api/auth/grant/publicViewer"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["success"], true);
    json["token"].as_str().expect("token").to_string()
}

#[tokio::test]
async fn public_viewer_grant_is_forbidden_while_viewer_public_is_off() {
    let (router, _settings, _audit, _users) = router_with_viewer_public(false).await;

    let response = router
        .oneshot(post_empty("/api/auth/grant/publicViewer"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(response).await["kind"], "forbidden");
}

#[tokio::test]
async fn public_viewer_grant_issues_a_token_when_viewer_public_is_on() {
    let (router, _settings, _audit, _users) = router_with_viewer_public(true).await;
    let token = public_viewer_token(&router).await;
    assert!(!token.is_empty());
}

#[tokio::test]
async fn grant_route_requires_the_client_header_and_knows_only_registered_kinds() {
    let (router, _settings, _audit, _users) = router_with_viewer_public(true).await;

    // CSRF header (`banto_server::csrf`), like every `/api/*` route.
    let bare = router
        .clone()
        .oneshot(
            HttpRequest::post("/api/auth/grant/publicViewer")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bare.status(), StatusCode::FORBIDDEN);

    // Only the registered kind exists: an app kind the template does not
    // register, a reserved session kind and a malformed identifier are 404.
    for kind in ["commissioning", "account", "local", "public-viewer"] {
        let response = router
            .clone()
            .oneshot(post_empty(&format!("/api/auth/grant/{kind}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{kind}");
        assert_eq!(body_json(response).await["kind"], "not_found", "{kind}");
    }
    // The old viewer-public route is gone (v3.0.0): nothing is issued there.
    let old = router
        .oneshot(post_empty("/api/auth/public-viewer"))
        .await
        .unwrap();
    assert!(
        !old.status().is_success(),
        "the pre-v3 route must not issue anything: {}",
        old.status()
    );
}

#[tokio::test]
async fn public_viewer_gate_follows_the_setting_without_a_restart() {
    // The flag is read from `SettingsService` per request (the grant's
    // condition, not captured at router-build time), so flipping it in the
    // settings screen takes effect immediately on an already-running server.
    let (router, settings, _audit, _users) = router_with_viewer_public(false).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_empty("/api/auth/grant/publicViewer"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );

    settings
        .set_server_config(&crate::settings::ServerSettings {
            viewer_public: true,
            ..crate::settings::ServerSettings::default()
        })
        .await
        .unwrap();

    public_viewer_token(&router).await;
}

#[tokio::test]
async fn public_viewer_token_identifies_as_the_public_viewer_kind_and_passes_check() {
    let (router, _settings, _audit, _users) = router_with_viewer_public(true).await;
    let token = public_viewer_token(&router).await;

    let identity_response = router
        .clone()
        .oneshot(get_auth("/api/auth/identity", &token))
        .await
        .unwrap();
    assert_eq!(identity_response.status(), StatusCode::OK);
    let identity = body_json(identity_response).await;
    assert_eq!(identity["id"], "public");
    assert_eq!(identity["role"], "viewer");
    assert_eq!(identity["kind"], "publicViewer");
    assert!(identity.get("publicViewer").is_none(), "removed in v3.0.0");

    let check_response = router
        .oneshot(get_auth("/api/auth/check", &token))
        .await
        .unwrap();
    assert_eq!(check_response.status(), StatusCode::OK);
    assert_eq!(body_json(check_response).await, json!(true));
}

#[tokio::test]
async fn public_viewer_token_cannot_change_a_password_or_create_an_account() {
    let (router, _settings, _audit, users) = router_with_viewer_public(true).await;
    let token = public_viewer_token(&router).await;

    let response = router
        .oneshot(post_json_auth(
            "/api/auth/change-password",
            &token,
            json!({ "currentPassword": "whatever", "newPassword": "newpassword1" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // And the failed attempt must not have conjured an account into existence.
    assert!(users.get_by_username("public").await.unwrap().is_none());
    assert!(
        !users.is_initialized().await.unwrap(),
        "a grant session must never count as a provisioned install"
    );
}

// #209: the account name is not reserved; provenance comes from issuance.
#[tokio::test]
async fn real_public_accounts_keep_identity_and_password_ownership() {
    for role in [Role::Admin, Role::Viewer] {
        let (router, _settings, audit, users) = router_with_viewer_public(true).await;
        users
            .setup_first_user("owner", "password123", "Owner")
            .await
            .unwrap();
        users
            .create_user("public", "password123", "public", role)
            .await
            .unwrap();
        let login = router
            .clone()
            .oneshot(post_json(
                "/api/auth/login",
                json!({ "username": "public", "password": "password123", "remember": true }),
            ))
            .await
            .unwrap();
        let login = body_json(login).await;
        assert_eq!(login["success"], true);
        let real = login["token"].as_str().unwrap();
        let synthetic = public_viewer_token(&router).await;

        for _ in 0..2 {
            for (token, expected_kind) in [(real, "account"), (synthetic.as_str(), "publicViewer")]
            {
                let response = router
                    .clone()
                    .oneshot(get_auth("/api/auth/identity", token))
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                let identity = body_json(response).await;
                assert_eq!(identity["id"], "public");
                assert_eq!(identity["name"], "public");
                assert_eq!(identity["kind"], expected_kind);
                let expected_role = if expected_kind == "publicViewer" {
                    Role::Viewer
                } else {
                    role
                };
                assert_eq!(identity["role"], expected_role.as_str());
            }
        }

        // Even knowing the real account password cannot make a grant
        // session its owner. Denied audit must carry no secrets or row id.
        let denied = router
            .clone()
            .oneshot(post_json_auth(
                "/api/auth/change-password",
                &synthetic,
                json!({ "currentPassword": "password123", "newPassword": "newpassword1" }),
            ))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        assert!(users
            .verify("public", "password123")
            .await
            .unwrap()
            .is_some());
        let entries = audit.list(ListParams::default()).await.unwrap();
        let denied = entries
            .rows
            .iter()
            .find(|entry| entry.action == "password_change" && entry.result == "denied")
            .expect("denied password change audit");
        assert_eq!(denied.actor_username.as_deref(), Some("public"));
        assert_eq!(denied.actor_role.as_deref(), Some("viewer"));
        assert_eq!(denied.entity_id, None);
        assert_eq!(denied.detail, None);
        assert_eq!(denied.origin, "rest");

        let changed = router
            .clone()
            .oneshot(post_json_auth(
                "/api/auth/change-password",
                real,
                json!({ "currentPassword": "password123", "newPassword": "newpassword1" }),
            ))
            .await
            .unwrap();
        assert_eq!(changed.status(), StatusCode::OK);
        assert!(users
            .verify("public", "newpassword1")
            .await
            .unwrap()
            .is_some());
    }
}

#[tokio::test]
async fn setup_public_account_returns_a_regular_session_identity() {
    let (router, _audit) = router_with_real_login(true).await;
    let setup = router
        .clone()
        .oneshot(post_json(
            "/api/auth/setup",
            json!({ "username": "public", "password": "password123", "displayName": "public" }),
        ))
        .await
        .unwrap();
    assert_eq!(setup.status(), StatusCode::OK);
    let setup = body_json(setup).await;
    let token = setup["token"].as_str().unwrap();
    let identity = router
        .oneshot(get_auth("/api/auth/identity", token))
        .await
        .unwrap();
    let identity = body_json(identity).await;
    assert_eq!(identity["id"], "public");
    assert_eq!(identity["role"], "admin");
    assert_eq!(identity["kind"], "account");
}

#[tokio::test]
async fn auth_status_reports_grants_both_ways_and_agrees_with_issuance() {
    let (off_router, _s, _a, _u) = router_with_viewer_public(false).await;
    let off = body_json(
        off_router
            .clone()
            .oneshot(get("/api/auth/status"))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(off["grants"]["publicViewer"], false);
    assert!(off.get("viewerPublic").is_none(), "removed in v3.0.0");
    assert_eq!(
        off_router
            .oneshot(post_empty("/api/auth/grant/publicViewer"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );

    let (on_router, _s, _a, _u) = router_with_viewer_public(true).await;
    let on = body_json(
        on_router
            .clone()
            .oneshot(get("/api/auth/status"))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(on["grants"]["publicViewer"], true);
    assert_eq!(
        on["grants"].as_object().unwrap().len(),
        1,
        "only the registered kind"
    );
    assert_eq!(on["initialized"], false);
    public_viewer_token(&on_router).await;
}

#[tokio::test]
async fn auth_status_flattens_app_supplied_extras() {
    // `AuthStatusExtras` (viewer-public-plan §3.1-2) is the hook an adopter
    // uses to add app-specific fields to `status` without wrapping this router
    // in a response-rewriting layer. The template passes `None`; this test
    // stands in for an adopter passing `Some`.
    let pool = migrate_memory().await.expect("migrate_memory");
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let audit = AuditLogService::new(pool);
    let auth = demo_auth();

    let extras: banto_server::AuthStatusExtras = std::sync::Arc::new(|| {
        let mut map = serde_json::Map::new();
        map.insert("tenant".to_string(), json!("factory-a"));
        map
    });
    let mut grants = GrantRegistry::new();
    grants.register(GrantSpec::public_viewer(settings)).unwrap();
    let router = extra_auth_router(users, auth, audit, false, Arc::new(grants), Some(extras))
        .layer(middleware::from_fn(require_banto_client_header));

    let response = router.oneshot(get("/api/auth/status")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    // The extra field sits alongside the built-in ones, not nested under a
    // wrapper key.
    assert_eq!(json["tenant"], "factory-a");
    assert_eq!(json["initialized"], false);
    assert_eq!(json["grants"]["publicViewer"], false);
}

// --- An app-defined grant (the shape banto-hub's commissioning mode takes) --

/// Flips the app kind's condition (a lock-down flag the app persists).
type GrantSwitch = std::sync::Arc<std::sync::atomic::AtomicBool>;

/// The template's auth routes plus `/api/users/*`, with the viewer-public
/// kind AND an admin-equivalent app kind `commissioning`
/// (`require_loopback_peer: true`, a small cap) registered - the composition
/// a derived app builds. Real `UsersService` accounts behind a lookup-enabled
/// `AuthState`, so grant sessions and account sessions coexist.
async fn router_with_app_grant() -> (
    Router,
    GrantSwitch,
    UsersService,
    AuditLogService,
    AuthState,
) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let audit = AuditLogService::new(pool);
    let auth = AuthState::new(
        audited_credential_verifier(users.clone(), audit.clone()),
        SessionValidation::lookup(banto_server::routes::user_session_lookup(users.clone())),
    );
    let open = GrantSwitch::new(std::sync::atomic::AtomicBool::new(true));
    let condition = open.clone();
    let mut commissioning = GrantSpec::new(
        banto_server::GrantKind::new("commissioning").unwrap(),
        Identity {
            id: "commissioning".to_string(),
            name: "試運転".to_string(),
            role: "admin".to_string(),
        },
        std::sync::Arc::new(move || {
            let condition = condition.clone();
            Box::pin(async move { Ok(condition.load(std::sync::atomic::Ordering::SeqCst)) })
        }),
    );
    commissioning.require_loopback_peer = true;
    commissioning.max_sessions = 4;
    let mut grants = GrantRegistry::new();
    grants.register(GrantSpec::public_viewer(settings)).unwrap();
    grants.register(commissioning).unwrap();

    let router = extra_auth_router(
        users.clone(),
        auth.clone(),
        audit.clone(),
        false,
        Arc::new(grants),
        None,
    )
    .merge(banto_server::routes::users_router(
        users.clone(),
        audit.clone(),
        auth.clone(),
    ))
    .merge(banto_server::auth_routes(auth.clone()))
    .layer(middleware::from_fn(require_banto_client_header));
    (router, open, users, audit, auth)
}

#[tokio::test]
async fn app_grant_requires_a_loopback_peer_and_its_condition_and_status_agrees() {
    let (router, open, _users, _audit, _auth) = router_with_app_grant().await;
    let status = |peer: Option<std::net::SocketAddr>| {
        let router = router.clone();
        async move {
            let req = match peer {
                Some(peer) => get_from("/api/auth/status", peer),
                None => get("/api/auth/status"),
            };
            body_json(router.oneshot(req).await.unwrap()).await["grants"].clone()
        }
    };
    let issue = |peer: Option<std::net::SocketAddr>| {
        let router = router.clone();
        async move {
            let req = match peer {
                Some(peer) => post_empty_from("/api/auth/grant/commissioning", peer),
                None => post_empty("/api/auth/grant/commissioning"),
            };
            router.oneshot(req).await.unwrap()
        }
    };

    // Peer unknown (a router served without ConnectInfo): refused, fail closed.
    assert_eq!(status(None).await["commissioning"], false);
    assert_eq!(
        status(None).await["publicViewer"],
        false,
        "viewer_public is OFF"
    );
    assert_eq!(issue(None).await.status(), StatusCode::FORBIDDEN);
    // A LAN peer: refused.
    assert_eq!(status(Some(LAN_PEER)).await["commissioning"], false);
    assert_eq!(issue(Some(LAN_PEER)).await.status(), StatusCode::FORBIDDEN);
    // Loopback: issued, and the session is the spec's admin identity.
    assert_eq!(status(Some(LOOPBACK_PEER)).await["commissioning"], true);
    let issued = issue(Some(LOOPBACK_PEER)).await;
    assert_eq!(issued.status(), StatusCode::OK);
    let token = body_json(issued).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let identity = body_json(
        router
            .clone()
            .oneshot(get_auth("/api/auth/identity", &token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(identity["kind"], "commissioning");
    assert_eq!(identity["id"], "commissioning");
    assert_eq!(identity["role"], "admin");
    // Condition closed (the app persisted its lock-down flag): refused, and
    // status says so from the same judgment.
    open.store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(status(Some(LOOPBACK_PEER)).await["commissioning"], false);
    assert_eq!(
        issue(Some(LOOPBACK_PEER)).await.status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn a_grant_session_can_delete_users_but_never_the_last_admin() {
    // ADR-0017 §3: the self-deletion guard needs no row for a grant; the
    // admin floor and the last-admin guard are unchanged.
    let (router, _open, users, audit, _auth) = router_with_app_grant().await;
    let owner = users
        .setup_first_user("owner", "password123", "Owner")
        .await
        .unwrap();
    let editor = users
        .create_user("editor1", "password123", "Editor", Role::Editor)
        .await
        .unwrap();
    let issued = router
        .clone()
        .oneshot(post_empty_from(
            "/api/auth/grant/commissioning",
            LOOPBACK_PEER,
        ))
        .await
        .unwrap();
    let grant = body_json(issued).await["token"]
        .as_str()
        .unwrap()
        .to_string();

    // The last admin stays (the guard is a service error, not a 2xx).
    let refused = router
        .clone()
        .oneshot(delete_auth(&format!("/api/users/{}", owner.id), &grant))
        .await
        .unwrap();
    assert_ne!(refused.status(), StatusCode::NO_CONTENT);
    assert!(users.get_by_username("owner").await.unwrap().is_some());

    // An ordinary account is deleted, and the audit actor is the grant's identity.
    let deleted = router
        .clone()
        .oneshot(delete_auth(&format!("/api/users/{}", editor.id), &grant))
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    assert!(users.get_by_username("editor1").await.unwrap().is_none());
    let rows = audit.list(ListParams::default()).await.unwrap().rows;
    let entry = rows
        .iter()
        .find(|row| row.action == "delete" && row.resource == "users")
        .expect("delete audit");
    assert_eq!(entry.actor_username.as_deref(), Some("commissioning"));
    assert_eq!(entry.actor_role.as_deref(), Some("admin"));

    // A viewer grant is not an admin: the role floor still applies.
    let (viewer_router, _s, _a, _u) = router_with_viewer_public(true).await;
    let viewer = public_viewer_token(&viewer_router).await;
    let forbidden = viewer_router
        .oneshot(delete_auth("/api/users/1", &viewer))
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn revoking_an_app_grant_ends_its_sessions_and_refuses_an_issuance_judged_before() {
    // The lock-down sequence of ADR-0017 §2/§5: persist the closed condition,
    // then `revoke_grant_tokens`. Open sessions are 401 on the next request;
    // an issuance that read the generation before the revocation is refused.
    let (router, open, _users, _audit, auth) = router_with_app_grant().await;
    let kind = banto_server::GrantKind::new("commissioning").unwrap();
    let issued = router
        .clone()
        .oneshot(post_empty_from(
            "/api/auth/grant/commissioning",
            LOOPBACK_PEER,
        ))
        .await
        .unwrap();
    let token = body_json(issued).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let observed = auth.grant_generation(&kind);

    open.store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(auth.revoke_grant_tokens(&kind), 1);

    let identity = router
        .clone()
        .oneshot(get_auth("/api/auth/identity", &token))
        .await
        .unwrap();
    assert!(body_json(identity).await.is_null(), "revoked: no session");
    let spec_like = GrantSpec::new(
        kind.clone(),
        Identity {
            id: "commissioning".to_string(),
            name: "試運転".to_string(),
            role: "admin".to_string(),
        },
        std::sync::Arc::new(|| Box::pin(async { Ok(true) })),
    );
    assert!(auth.issue_grant_token(&spec_like, observed).is_none());
    assert_eq!(auth.session_count(), 0);
}

#[test]
fn grant_registry_rejects_reserved_and_duplicate_kinds() {
    let pool_free = |kind: &str| {
        GrantSpec::new(
            banto_server::GrantKind::new(kind).unwrap(),
            Identity {
                id: kind.to_string(),
                name: kind.to_string(),
                role: "viewer".to_string(),
            },
            std::sync::Arc::new(|| Box::pin(async { Ok(true) })),
        )
    };
    let mut grants = GrantRegistry::new();
    assert!(grants.register(pool_free("account")).is_err());
    assert!(grants.register(pool_free("local")).is_err());
    grants.register(pool_free("publicViewer")).unwrap();
    assert!(grants.register(pool_free("publicViewer")).is_err());
    assert!(banto_server::GrantKind::new("public viewer").is_err());
}

// --- Session revocation (Issue #204) -----------------------------------------

const REVOCATION_PASSWORD: &str = "password123";

/// Router over REAL `UsersService` accounts with the production
/// `user_auth_state` (verifier + per-request account re-check): `operator`
/// (admin, performs the changes), `target` (admin, the account changed) and
/// `bystander` (editor, must never be affected).
async fn router_with_user_sessions() -> (Router, UsersService) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let system_info = SystemInfoService::new(pool.clone());
    let authz = banto_admin_services::authz::AuthzService::new(pool.clone());
    let customers = crate::customers::CustomersService::new(pool.clone()).with_events(tx.clone());
    let projects = crate::projects::ProjectsService::new(pool.clone()).with_events(tx.clone());
    let pipeline = crate::pipeline::PipelineService::new(pool.clone()).with_events(tx.clone());
    let orders = crate::orders::OrdersService::new(pool.clone()).with_events(tx.clone());
    let calc_basis = crate::calc_basis::CalcBasisService::new(pool.clone());
    let work_masters = crate::work_masters::WorkMastersService::new(pool.clone());
    let time_entries = crate::time_entries::TimeEntriesService::new(pool.clone());
    let budgets = crate::budgets::BudgetsService::new(pool.clone());
    let forecasts = crate::forecasts::ForecastsService::new(pool.clone());
    let direct_costs = crate::direct_costs::DirectCostsService::new(pool.clone());
    let audit = AuditLogService::new(pool);

    users
        .setup_first_user("operator", REVOCATION_PASSWORD, "操作者")
        .await
        .expect("setup_first_user");
    users
        .create_user("target", REVOCATION_PASSWORD, "対象", Role::Admin)
        .await
        .expect("create target");
    users
        .create_user("bystander", REVOCATION_PASSWORD, "無関係", Role::Editor)
        .await
        .expect("create bystander");

    let auth = user_auth_state(users.clone(), audit.clone());
    let services = Services {
        users: users.clone(),
        settings,
        audit,
        backup,
        system_info,
        authz,
        customers,
        projects,
        pipeline,
        orders,
        calc_basis,
        work_masters,
        time_entries,
        budgets,
        forecasts,
        direct_costs,
        metrics: None,
    };
    (api_router(services, auth, tx, false), users)
}

/// `POST /api/auth/login` - one call per "device". `remember` selects the
/// 30-day "Remember me" token (spec M11).
async fn rest_login(router: &Router, username: &str, password: &str, remember: bool) -> String {
    let response = router
        .clone()
        .oneshot(post_json(
            "/api/auth/login",
            json!({ "username": username, "password": password, "remember": remember }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    json["token"]
        .as_str()
        .unwrap_or_else(|| panic!("login of {username} failed: {json}"))
        .to_string()
}

async fn status_of(router: &Router, request: HttpRequest<Body>) -> StatusCode {
    router.clone().oneshot(request).await.unwrap().status()
}

async fn rest_check(router: &Router, token: &str) -> bool {
    let response = router
        .clone()
        .oneshot(get_auth("/api/auth/check", token))
        .await
        .unwrap();
    body_json(response).await == json!(true)
}

#[derive(Clone, Copy, Debug)]
enum AccountChange {
    Delete,
    Demote,
    PasswordChange,
    PasswordReset,
}

/// One account change made over REST, then every session the target held
/// on OTHER devices - a regular and a "Remember me" token - must be refused
/// by protected routes, while other accounts' sessions keep working.
/// Returns nothing; panics with the change's name on failure.
async fn rest_change_ends_the_other_sessions(change: AccountChange) {
    let (router, users) = router_with_user_sessions().await;
    let operator = rest_login(&router, "operator", REVOCATION_PASSWORD, false).await;
    let bystander = rest_login(&router, "bystander", REVOCATION_PASSWORD, true).await;
    let target_normal = rest_login(&router, "target", REVOCATION_PASSWORD, false).await;
    let target_remembered = rest_login(&router, "target", REVOCATION_PASSWORD, true).await;
    let target_id = users
        .get_by_username("target")
        .await
        .unwrap()
        .expect("target exists")
        .id;
    for token in [&target_normal, &target_remembered] {
        assert_eq!(
            status_of(&router, get_auth("/api/users", token)).await,
            StatusCode::OK,
            "{change:?}: precondition - the target is an admin"
        );
    }

    let survivor = match change {
        AccountChange::Delete => {
            let path = format!("/api/users/{target_id}");
            assert_eq!(
                status_of(&router, delete_auth(&path, &operator)).await,
                StatusCode::NO_CONTENT
            );
            None
        }
        AccountChange::Demote => {
            let path = format!("/api/users/{target_id}");
            let body = json!({ "displayName": "対象", "role": "viewer" });
            assert_eq!(
                status_of(&router, put_json(&path, &operator, body)).await,
                StatusCode::OK
            );
            None
        }
        AccountChange::PasswordReset => {
            let path = format!("/api/users/{target_id}/reset-password");
            let body = json!({ "newPassword": "resetpassword1" });
            assert_eq!(
                status_of(&router, post_json_auth(&path, &operator, body)).await,
                StatusCode::OK
            );
            None
        }
        AccountChange::PasswordChange => {
            // The target changes it themselves, from a third device.
            let device = rest_login(&router, "target", REVOCATION_PASSWORD, false).await;
            let body = json!({
                "currentPassword": REVOCATION_PASSWORD,
                "newPassword": "newpassword1",
            });
            assert_eq!(
                status_of(
                    &router,
                    post_json_auth("/api/auth/change-password", &device, body)
                )
                .await,
                StatusCode::OK
            );
            Some(device)
        }
    };

    for (label, token) in [
        ("regular", &target_normal),
        ("remember-me", &target_remembered),
    ] {
        // The issue's reproduction: create an admin with the old token.
        let intruder = json!({
            "username": format!("intruder-{label}"),
            "password": "password123",
            "displayName": "侵入者",
            "role": "admin",
        });
        assert_eq!(
            status_of(&router, post_json_auth("/api/users", token, intruder)).await,
            StatusCode::UNAUTHORIZED,
            "{change:?}: the {label} session must be refused"
        );
        assert_eq!(
            status_of(&router, get_auth("/api/ui-settings/theme", token)).await,
            StatusCode::UNAUTHORIZED,
            "{change:?}: the {label} session must be refused on require_auth-only routes too"
        );
        assert!(
            !rest_check(&router, token).await,
            "{change:?}: the {label} session must report logged out"
        );
    }
    for label in ["regular", "remember-me"] {
        assert!(
            users
                .get_by_username(&format!("intruder-{label}"))
                .await
                .unwrap()
                .is_none(),
            "{change:?}: no account may have been created"
        );
    }

    // Other accounts' sessions are untouched.
    assert_eq!(
        status_of(&router, get_auth("/api/users", &operator)).await,
        StatusCode::OK,
        "{change:?}: the operator's session must survive"
    );
    assert!(
        rest_check(&router, &bystander).await,
        "{change:?}: bystander"
    );
    assert_eq!(
        status_of(&router, get_auth("/api/ui-settings/theme", &bystander)).await,
        StatusCode::OK,
        "{change:?}: bystander"
    );
    // A self-service password change keeps the session that made it.
    if let Some(device) = survivor {
        assert_eq!(
            status_of(&router, get_auth("/api/users", &device)).await,
            StatusCode::OK,
            "{change:?}: the changing session keeps working"
        );
    }
}

#[tokio::test]
async fn rest_delete_ends_the_accounts_regular_and_remembered_sessions() {
    rest_change_ends_the_other_sessions(AccountChange::Delete).await;
}

#[tokio::test]
async fn rest_demotion_ends_the_accounts_regular_and_remembered_sessions() {
    rest_change_ends_the_other_sessions(AccountChange::Demote).await;
}

#[tokio::test]
async fn rest_password_change_ends_the_accounts_other_sessions() {
    rest_change_ends_the_other_sessions(AccountChange::PasswordChange).await;
}

#[tokio::test]
async fn rest_password_reset_ends_the_accounts_regular_and_remembered_sessions() {
    rest_change_ends_the_other_sessions(AccountChange::PasswordReset).await;
}

#[tokio::test]
async fn a_demoted_account_logs_back_in_with_its_new_role() {
    let (router, users) = router_with_user_sessions().await;
    let operator = rest_login(&router, "operator", REVOCATION_PASSWORD, false).await;
    let target_id = users.get_by_username("target").await.unwrap().unwrap().id;
    let body = json!({ "displayName": "対象", "role": "viewer" });
    assert_eq!(
        status_of(
            &router,
            put_json(&format!("/api/users/{target_id}"), &operator, body)
        )
        .await,
        StatusCode::OK
    );

    let fresh = rest_login(&router, "target", REVOCATION_PASSWORD, true).await;
    assert_eq!(
        status_of(&router, get_auth("/api/users", &fresh)).await,
        StatusCode::FORBIDDEN
    );
    let identity = router
        .clone()
        .oneshot(get_auth("/api/auth/identity", &fresh))
        .await
        .unwrap();
    assert_eq!(body_json(identity).await["role"], "viewer");
}

#[tokio::test]
async fn a_display_name_edit_keeps_the_accounts_sessions() {
    let (router, users) = router_with_user_sessions().await;
    let operator = rest_login(&router, "operator", REVOCATION_PASSWORD, false).await;
    let target = rest_login(&router, "target", REVOCATION_PASSWORD, true).await;
    let target_id = users.get_by_username("target").await.unwrap().unwrap().id;
    let body = json!({ "displayName": "対象（改名）", "role": "admin" });
    assert_eq!(
        status_of(
            &router,
            put_json(&format!("/api/users/{target_id}"), &operator, body)
        )
        .await,
        StatusCode::OK
    );

    assert_eq!(
        status_of(&router, get_auth("/api/users", &target)).await,
        StatusCode::OK
    );
    let identity = router
        .clone()
        .oneshot(get_auth("/api/auth/identity", &target))
        .await
        .unwrap();
    assert_eq!(body_json(identity).await["name"], "対象（改名）");
}

#[tokio::test]
async fn role_guard_revalidates_when_require_auth_is_missing() {
    // A misconfigured router (RoleGuard without require_auth in front) must
    // not fall back to the identity cached on the token at login.
    let (router, users) = router_with_user_sessions().await;
    let operator = rest_login(&router, "operator", REVOCATION_PASSWORD, false).await;
    let target = rest_login(&router, "target", REVOCATION_PASSWORD, false).await;
    let pool_users = users.clone();
    let audit = AuditLogService::new(migrate_memory().await.expect("migrate_memory"));
    let auth = user_auth_state(pool_users, audit.clone());
    // Log the target in on THIS state too (the guard below uses it).
    let token = auth
        .login("target", REVOCATION_PASSWORD)
        .await
        .expect("target login");
    let guarded = Router::new()
        .route("/guarded", axum::routing::get(|| async { "ok" }))
        // Fully qualified: the display preset's scaffold narrows
        // `rest/mod.rs`'s imports (which this module borrows via
        // `use super::*`) and drops these two.
        .layer(axum::middleware::from_fn_with_state(
            banto_server::routes::RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "users",
                audit,
            },
            banto_server::routes::require_role_at_least,
        ));
    let request = |token: &str| {
        HttpRequest::get("/guarded")
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(status_of(&guarded, request(&token)).await, StatusCode::OK);

    let target_id = users.get_by_username("target").await.unwrap().unwrap().id;
    assert_eq!(
        status_of(
            &router,
            delete_auth(&format!("/api/users/{target_id}"), &operator)
        )
        .await,
        StatusCode::NO_CONTENT
    );
    assert!(!rest_check(&router, &target).await);
    assert_eq!(
        status_of(&guarded, request(&token)).await,
        StatusCode::FORBIDDEN
    );
}

// --- banto-cost P2: capability × project scope (ADR-0028) ---------------

/// A customer (id 1) and projects 101 / 102 managed by the admin (user 1),
/// inserted directly so they carry no `project_members` rows.
async fn seed_projects(db: &banto_storage::Db) {
    let pool = db.as_sqlite().expect("tests run on SQLite");
    for sql in [
        "INSERT INTO customers (id, name) VALUES (1, '架空工業')",
        "INSERT INTO projects (id, code, name, customer_id, manager_user_id, status) VALUES \
         (101, 'P-101', '架空案件A', 1, 1, 'lead'), (102, 'P-102', '架空案件B', 1, 1, 'lead')",
    ] {
        sqlx::query(sql).execute(pool).await.expect("seed projects");
    }
}

/// `router_with_role_tokens_and_audit` users: admin = 1, editor = 2, viewer = 3.
const EDITOR_ID: i64 = 2;
const VIEWER_ID: i64 = 3;

async fn denied_entries(audit: &AuditLogService) -> Vec<crate::audit::AuditLogEntry> {
    audit
        .list(ListParams::default())
        .await
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| row.action == "denied")
        .collect()
}

#[tokio::test]
async fn t12_rest_project_members_follow_capability_and_project_scope() {
    let (router, audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;

    // The administrator grants the editor project.manage and makes it the
    // manager of project 101 (both audited writes).
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/users/{EDITOR_ID}/capabilities"),
            &admin,
            json!({ "capabilities": ["project.manage", "amount.view"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        body_json(response).await,
        json!(["project.manage", "amount.view"])
    );
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/projects/101/members/{EDITOR_ID}/manager"),
            &admin,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // In scope: the member list of 101.
    let response = router
        .clone()
        .oneshot(get_auth("/api/projects/101/members", &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        body_json(response).await,
        json!([{ "projectId": 101, "userId": EDITOR_ID, "kind": "manager" }])
    );

    // Out of scope: project 102, even by its direct URL.
    let response = router
        .clone()
        .oneshot(get_auth("/api/projects/102/members", &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // The role floor still applies: the editor cannot grant itself more.
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/users/{EDITOR_ID}/capabilities"),
            &editor,
            json!({ "capabilities": ["report.all"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // The administrator maintains assignments on every project.
    let response = router
        .clone()
        .oneshot(get_auth("/api/projects/102/members", &admin))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let denied = denied_entries(&audit).await;
    let scope = denied
        .iter()
        .find(|row| row.resource == "project_members")
        .expect("the out-of-scope read is recorded");
    assert_eq!(scope.actor_username.as_deref(), Some("editor"));
    assert_eq!(scope.entity_id.as_deref(), Some("102"));
    assert_eq!(scope.origin, "rest");
    let detail: serde_json::Value = serde_json::from_str(scope.detail.as_deref().unwrap()).unwrap();
    assert_eq!(
        detail,
        json!({ "operation": "view_project", "reason": "out_of_project_scope", "projectId": 102 })
    );
    assert!(denied.iter().any(
        |row| row.resource == "capabilities" && row.actor_username.as_deref() == Some("editor")
    ));

    let writes: Vec<_> = audit
        .list(ListParams::default())
        .await
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| row.result == "ok" && row.resource != "auth")
        .map(|row| (row.action, row.resource, row.entity_id))
        .collect();
    assert!(writes.contains(&(
        "update".to_string(),
        "capabilities".to_string(),
        Some(EDITOR_ID.to_string())
    )));
    assert!(writes.contains(&(
        "create".to_string(),
        "project_members".to_string(),
        Some("101".to_string())
    )));
}

#[tokio::test]
async fn t19_t20_rest_role_without_company_grant_gets_no_business_data() {
    let (router, audit, admin, _editor, viewer) = router_with_role_tokens_and_audit().await;
    // The viewer is assigned to project 101 but holds no capability in this
    // database: membership alone is not company membership.
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/projects/101/members/{VIEWER_ID}/worker"),
            &admin,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = router
        .clone()
        .oneshot(get_auth("/api/projects/101/members", &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let denied = denied_entries(&audit).await;
    assert_eq!(denied.len(), 1);
    let detail: serde_json::Value =
        serde_json::from_str(denied[0].detail.as_deref().unwrap()).unwrap();
    assert_eq!(detail["reason"], "not_company_member");

    // Its own view shows no grant (the screen can explain why).
    let response = router
        .clone()
        .oneshot(get_auth("/api/authz/me", &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        body_json(response).await,
        json!({
            "capabilities": [],
            "memberships": [{ "projectId": 101, "userId": VIEWER_ID, "kind": "worker" }]
        })
    );

    // Once granted explicitly, the same request succeeds.
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/users/{VIEWER_ID}/capabilities"),
            &admin,
            json!({ "capabilities": ["time.entry"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(get_auth("/api/projects/101/members", &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn rest_project_member_writes_validate_and_need_admin() {
    let (router, _audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/projects/101/members/{EDITOR_ID}/owner"),
            &admin,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = router
        .clone()
        .oneshot(put_json(
            "/api/projects/101/members/99/worker",
            &admin,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/projects/101/members/{EDITOR_ID}/worker"),
            &editor,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = router
        .clone()
        .oneshot(delete_auth(
            &format!("/api/projects/101/members/{EDITOR_ID}/worker"),
            &admin,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

// --- banto-cost P3a: customers / projects / pipeline -------------------------

fn post_auth(path: &str, token: &str) -> HttpRequest<Body> {
    post_json_auth(path, token, json!(null))
}

async fn grant(router: &Router, admin: &str, user_id: i64, caps: serde_json::Value) {
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/users/{user_id}/capabilities"),
            admin,
            json!({ "capabilities": caps }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

fn project_body(code: &str, manager: i64) -> serde_json::Value {
    json!({
        "code": code,
        "name": "架空の制御盤更新",
        "customerId": 1,
        "managerUserId": manager,
        "status": "negotiating"
    })
}

#[tokio::test]
async fn t12_t21_rest_business_routes_follow_capability_and_scope() {
    let (router, audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["pipeline.edit", "amount.view"]),
    )
    .await;

    // The sales editor registers a project and becomes its sales owner.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-001", 1),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let project = body_json(response).await;
    let id = project["id"].as_i64().unwrap();
    assert_eq!(project["customerName"], "架空工業");

    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/pipeline-versions"),
            &editor,
            json!({
                "stage": "negotiating",
                "expectedAmount": 3_000_000,
                "probabilityPct": 60,
                "expectedOrderMonth": "2026-11",
                "basis": "見積提出済み",
                "revenuePlan": [{ "month": "2026-12", "amount": 3_000_000 }],
                "adopt": true
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // T21 through the API: only the editor's own project is aggregated.
    let response = router
        .clone()
        .oneshot(get_auth("/api/pipeline/overview", &editor))
        .await
        .unwrap();
    let overview = body_json(response).await;
    assert_eq!(overview["totals"]["total"], 3_000_000);
    assert_eq!(overview["totals"]["weighted"], 1_800_000);
    assert_eq!(overview["rows"].as_array().unwrap().len(), 1);

    // T12: lists and direct URLs agree - projects 101/102 are out of scope.
    let response = router
        .clone()
        .oneshot(post_json_auth("/api/projects/list", &editor, json!({})))
        .await
        .unwrap();
    let list = body_json(response).await;
    assert_eq!(list["totalCount"], 1);
    for path in ["/api/projects/101", "/api/projects/101/pipeline-versions"] {
        let response = router
            .clone()
            .oneshot(get_auth(path, &editor))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
    }
    let response = router
        .clone()
        .oneshot(put_json(
            "/api/projects/101",
            &editor,
            project_body("P-101", 1),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // The administrator sees every project's basic information, but no
    // amounts: no pipeline rows and no versions.
    let response = router
        .clone()
        .oneshot(post_json_auth("/api/projects/list", &admin, json!({})))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["totalCount"], 3);
    let response = router
        .clone()
        .oneshot(get_auth("/api/pipeline/overview", &admin))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["rows"], json!([]));
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/projects/{id}/pipeline-versions"),
            &admin,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // No company grant: no masters, an empty project list (T20).
    let response = router
        .clone()
        .oneshot(post_json_auth("/api/customers/list", &viewer, json!({})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = router
        .clone()
        .oneshot(post_json_auth("/api/projects/list", &viewer, json!({})))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["totalCount"], 0);

    // The viewer role cannot write business data whatever its capabilities.
    grant(&router, &admin, VIEWER_ID, json!(["pipeline.edit"])).await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &viewer,
            project_body("P-009", 1),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let denied = denied_entries(&audit).await;
    let resources: Vec<_> = denied.iter().map(|r| r.resource.as_str()).collect();
    for expected in ["projects", "pipeline_versions", "customers", "business"] {
        assert!(resources.contains(&expected), "{expected} in {resources:?}");
    }
    assert!(denied.iter().all(|r| r.origin == "rest"));
    let writes: Vec<_> = audit
        .list(ListParams::default())
        .await
        .unwrap()
        .rows
        .into_iter()
        .filter(|r| {
            r.result == "ok" && (r.resource == "projects" || r.resource == "pipeline_versions")
        })
        .map(|r| (r.action, r.resource))
        .collect();
    assert_eq!(
        writes.len(),
        2,
        "one project create and one version create: {writes:?}"
    );
}

#[tokio::test]
async fn t13_rest_customer_update_with_a_stale_row_version_is_refused() {
    let (router, _audit, admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;
    // The administrator maintains masters without a capability.
    let response = router
        .clone()
        .oneshot(put_json(
            "/api/customers/1",
            &admin,
            json!({ "name": "架空工業（改）", "rowVersion": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(put_json(
            "/api/customers/1",
            &admin,
            json!({ "name": "架空工業（別）", "rowVersion": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = body_json(response).await;
    assert_eq!(body["field_errors"][0]["field"], "rowVersion");
    let response = router
        .clone()
        .oneshot(get_auth("/api/customers/1", &admin))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["name"], "架空工業（改）");
}

#[tokio::test]
async fn rest_customer_writes_emit_resource_changed_only_on_success() {
    let (router, _audit, admin, _editor, _viewer, tx) =
        router_with_role_tokens_audit_and_events().await;
    let mut rx = tx.subscribe();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/customers",
            &admin,
            json!({ "name": "架空物産", "active": true }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(put_json(
            "/api/customers/1",
            &admin,
            json!({ "name": "架空工業（改）", "rowVersion": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    for _ in 0..2 {
        match rx.try_recv().expect("one event per committed write") {
            ServerEvent::ResourceChanged { resource } => assert_eq!(resource, "customers"),
            other => panic!("unexpected event {other:?}"),
        }
    }
    // A stale update is refused and sends nothing.
    let response = router
        .clone()
        .oneshot(put_json(
            "/api/customers/1",
            &admin,
            json!({ "name": "架空工業（別）", "rowVersion": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn rest_pipeline_draft_then_adopt() {
    let (router, _audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["pipeline.edit", "amount.view"]),
    )
    .await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-001", 1),
        ))
        .await
        .unwrap();
    let id = body_json(response).await["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/pipeline-versions"),
            &editor,
            json!({ "stage": "lead", "basis": "引合を受けた" }),
        ))
        .await
        .unwrap();
    let draft = body_json(response).await;
    assert_eq!(draft["kind"], "draft");
    assert_eq!(
        draft["issues"],
        json!([
            "amount_missing",
            "probability_missing",
            "order_month_missing",
            "plan_missing"
        ])
    );
    let response = router
        .clone()
        .oneshot(post_auth(
            &format!("/api/projects/{id}/pipeline-versions/{}/adopt", draft["id"]),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["kind"], "adopted");
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/projects/{id}/pipeline-versions"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(body_json(response).await.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn t23_t26_t27_rest_order_revenue_and_outlook() {
    let (router, audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["pipeline.edit", "amount.view"]),
    )
    .await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-001", 1),
        ))
        .await
        .unwrap();
    let project = body_json(response).await;
    let id = project["id"].as_i64().unwrap();
    let row_version = project["rowVersion"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/pipeline-versions"),
            &editor,
            json!({
                "stage": "negotiating",
                "expectedAmount": 3_000_000,
                "probabilityPct": 60,
                "expectedOrderMonth": "2026-11",
                "basis": "見積提出済み",
                "revenuePlan": [{ "month": "2026-12", "amount": 3_000_000 }],
                "adopt": true
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/outlook/snapshots",
            &editor,
            json!({ "label": "受注前" }),
        ))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "snapshots need report.all"
    );

    // T23: conversion by the sales owner.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/convert"),
            &editor,
            json!({
                "rowVersion": row_version,
                "convertedOn": "2026-11-20",
                "confirmedAmount": 2_800_000,
                "basis": "注文書受領",
                "plannedStart": "2026-12-01",
                "plannedEnd": "2027-03-31",
                "revenuePlan": [{ "month": "2026-12", "amount": 2_800_000 }],
                "scope": "whole"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let summary = body_json(response).await;
    assert_eq!(summary["status"], "ordered");
    assert_eq!(summary["confirmedAmount"], 2_800_000);
    assert_eq!(summary["recognizedTotal"], 0);

    // A change requested and approved by the same (only) person: allowed
    // and audited as a self-approval.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/changes"),
            &editor,
            json!({ "deltaAmount": 200_000, "planMonth": "2027-01", "basis": "追加画面" }),
        ))
        .await
        .unwrap();
    let summary = body_json(response).await;
    assert_eq!(summary["pendingTotal"], 200_000);
    let change_id = summary["changes"][0]["id"].as_i64().unwrap();

    // Without finance.close there is no recognition (and no approval:
    // approving needs project.manage on the project or finance.close).
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/recognitions"),
            &editor,
            json!({ "recognizedOn": "2026-12-25", "amount": 1_000_000 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!([
            "pipeline.edit",
            "amount.view",
            "finance.close",
            "report.all"
        ]),
    )
    .await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/changes/{change_id}/decide"),
            &editor,
            json!({ "approve": true }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["confirmedAmount"], 3_000_000);

    // T26: recognition clears the plan.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/recognitions"),
            &editor,
            json!({ "recognizedOn": "2026-12-25", "amount": 1_000_000 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let summary = body_json(response).await;
    assert_eq!(summary["remaining"], 2_000_000);
    assert_eq!(summary["issues"], json!([]));

    // T27: outlook and snapshot.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/outlook/snapshots",
            &editor,
            json!({ "label": "12月報告" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot_id = body_json(response).await["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/outlook?from=2026-12&to=2027-01&compare={snapshot_id}"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let outlook = body_json(response).await;
    assert_eq!(outlook["rows"][0]["month"], "2026-12");
    assert_eq!(outlook["rows"][0]["recognized"], 1_000_000);
    assert_eq!(outlook["rows"][0]["orderedPlan"], 1_800_000);
    assert_eq!(outlook["rows"][0]["difference"], 0);
    assert_eq!(outlook["totals"]["total"], 3_000_000);
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/outlook/snapshots/{snapshot_id}"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["snapshot"]["label"], "12月報告");

    // No company grant: no order detail, an empty outlook.
    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/order"), &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = router
        .clone()
        .oneshot(get_auth("/api/outlook", &viewer))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["rows"], json!([]));
    // The administrator role sees no amounts either.
    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/order"), &admin))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let rows = audit.list(ListParams::default()).await.unwrap().rows;
    let approval = rows
        .iter()
        .find(|r| r.action == "approve_change")
        .expect("approval audited");
    assert!(
        approval
            .detail
            .as_deref()
            .is_some_and(|d| d.contains("\"selfApproval\":true")),
        "{:?}",
        approval.detail
    );
    let denied = denied_entries(&audit).await;
    assert!(denied.iter().any(|r| r.resource == "revenue_recognitions"));
    assert!(denied.iter().any(|r| r.resource == "outlook_snapshots"));
}

#[tokio::test]
async fn t31_t32_t34_t35_rest_calc_basis_follows_the_item_capability() {
    let (router, audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    let company = json!({
        "itemKey": "emp_rate",
        "validFrom": "2026-06-01",
        "value": 5_000,
        "reason": "第13期の単価"
    });

    // T35: no capability, no basis - not even for the admin role (amounts).
    for token in [&admin, &editor, &viewer] {
        let response = router
            .clone()
            .oneshot(get_auth("/api/calc-basis?on=2026-11-06", token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let response = router
        .clone()
        .oneshot(post_json_auth("/api/calc-basis", &admin, company.clone()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["finance.rate", "amount.view", "pipeline.edit"]),
    )
    .await;
    // T31: a company version.
    let response = router
        .clone()
        .oneshot(post_json_auth("/api/calc-basis", &editor, company))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let row = body_json(response).await;
    assert_eq!(row["versionNo"], 1);
    assert_eq!(row["value"], 5_000);
    // T35: the tax rate is accounting's (finance.close), not the rate holder's.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/calc-basis",
            &editor,
            json!({ "itemKey": "tax_rate", "validFrom": "2026-06-01", "value": 10, "reason": "標準" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // T32: an override on one project, checked with a preview first.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-001", 1),
        ))
        .await
        .unwrap();
    let id = body_json(response).await["id"].as_i64().unwrap();
    let override_body = json!({
        "itemKey": "emp_rate",
        "validFrom": "2026-12-01",
        "value": 5_500,
        "reason": "高単価の技術者が担当"
    });
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/calc-basis/preview"),
            &editor,
            override_body.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let preview = body_json(response).await;
    assert_eq!(preview["before"], 5_000);
    assert_eq!(preview["after"], 5_500);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/calc-basis"),
            &editor,
            override_body,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/projects/{id}/calc-basis?on=2026-12-01"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let basis = body_json(response).await;
    let emp = &basis["items"][0];
    assert_eq!(emp["item"]["key"], "emp_rate");
    assert_eq!(emp["appliedValue"], 5_500);
    assert_eq!(emp["source"], "project");
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/calc-basis/preview",
            &editor,
            json!({ "itemKey": "emp_rate", "validFrom": "2027-06-01", "value": 5_200, "reason": "第14期" }),
        ))
        .await
        .unwrap();
    let preview = body_json(response).await;
    assert_eq!(
        preview["shieldedProjects"],
        json!([{ "id": id, "code": "P-001" }])
    );

    // T34: back to the company basis.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/calc-basis"),
            &editor,
            json!({ "itemKey": "emp_rate", "validFrom": "2027-01-01", "value": null, "reason": "通常の体制に戻った" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/projects/{id}/calc-basis?on=2027-01-01"),
            &editor,
        ))
        .await
        .unwrap();
    let basis = body_json(response).await;
    assert_eq!(basis["items"][0]["appliedValue"], 5_000);
    assert_eq!(basis["items"][0]["source"], "company");
    assert_eq!(basis["items"][0]["history"].as_array().unwrap().len(), 2);

    // Audit: the writes are recorded without the rate itself.
    let writes: Vec<_> = audit
        .list(ListParams::default())
        .await
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| row.resource == "calc_basis" && row.action != "denied")
        .collect();
    assert_eq!(writes.len(), 3, "{writes:?}");
    for row in &writes {
        let detail = row.detail.clone().unwrap_or_default();
        assert!(
            !detail.contains("5000") && !detail.contains("5500"),
            "{detail}"
        );
    }
    assert!(denied_entries(&audit)
        .await
        .iter()
        .any(|row| row.resource == "calc_basis"));
}

#[tokio::test]
async fn t02_t04_t12_rest_time_entries_follow_ownership_scope_and_approval() {
    let (router, audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    let entry = |project: i64, request: &str| {
        json!({
            "workDate": "2026-11-09",
            "projectId": project,
            "phaseId": 1,
            "minutes": 420,
            "description": "盤図の作成",
            "clientRequestId": request
        })
    };
    // No `time.entry`: no hours.
    let response = router
        .clone()
        .oneshot(get_auth(
            "/api/time-entries?from=2026-11-09&to=2026-11-15",
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["time.entry", "project.manage", "amount.view"]),
    )
    .await;
    grant(
        &router,
        &admin,
        1,
        json!(["time.entry", "finance.rate", "amount.view"]),
    )
    .await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/calc-basis",
            &admin,
            json!({ "itemKey": "emp_rate", "validFrom": "2026-06-01", "value": 5_000, "reason": "標準" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-001", EDITOR_ID),
        ))
        .await
        .unwrap();
    let project = body_json(response).await["id"].as_i64().unwrap();

    // Not a member of a project: no hours on it (T12).
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/time-entries",
            &admin,
            entry(project, "a-1"),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // T13: a retried send returns the first row.
    let mut ids = Vec::new();
    for _ in 0..2 {
        let response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/time-entries",
                &editor,
                entry(project, "e-1"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let saved = body_json(response).await;
        ids.push(saved["entry"]["id"].as_i64().unwrap());
    }
    assert_eq!(ids[0], ids[1]);
    let id = ids[0];

    // Someone else's entry reads as not found.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{id}/submit"),
            &admin,
            json!({ "rowVersion": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    // The viewer role cannot write at all.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/time-entries",
            &viewer,
            entry(project, "v-1"),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{id}/submit"),
            &editor,
            json!({ "rowVersion": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let submitted = body_json(response).await;
    assert_eq!(submitted["status"], "submitted");

    // The manager sees it to approve; finance.rate-less callers see no rate.
    let response = router
        .clone()
        .oneshot(get_auth("/api/time-entries/approvals", &editor))
        .await
        .unwrap();
    let list = body_json(response).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    let response = router
        .clone()
        .oneshot(get_auth("/api/time-entries/approvals", &admin))
        .await
        .unwrap();
    assert!(
        body_json(response).await.as_array().unwrap().is_empty(),
        "not a manager, not accounting: nothing to approve"
    );

    // Self-approval (one-person company), recorded in the audit.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{id}/decide"),
            &editor,
            json!({ "rowVersion": submitted["rowVersion"], "approve": true }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let approved = body_json(response).await;
    assert_eq!(approved["status"], "approved");
    assert_eq!(
        approved["laborCost"],
        serde_json::Value::Null,
        "rate hidden"
    );
    assert_eq!(approved["costMissing"], false);

    // T02: the project's labor cost (420 min × 5,000 yen/h).
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/projects/{project}/time-summary"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let summary = body_json(response).await;
    assert_eq!(summary["total"]["laborCost"], 35_000);
    assert_eq!(summary["total"]["approved"]["minutes"], 420);
    assert_eq!(summary["total"]["complete"], true);
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/projects/{project}/time-summary"),
            &admin,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // A common activity is accounting's to approve.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/time-entries",
            &editor,
            json!({ "workDate": "2026-11-10", "activityId": 1, "minutes": 60 }),
        ))
        .await
        .unwrap();
    let common = body_json(response).await["entry"]["id"].as_i64().unwrap();
    router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{common}/submit"),
            &editor,
            json!({ "rowVersion": 1 }),
        ))
        .await
        .unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{common}/decide"),
            &editor,
            json!({ "rowVersion": 2, "approve": true }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let rows = audit.list(ListParams::default()).await.unwrap().rows;
    let writes: Vec<_> = rows
        .iter()
        .filter(|row| row.resource == "time_entries" && row.action != "denied")
        .collect();
    assert_eq!(
        writes.iter().filter(|r| r.action == "create").count(),
        2,
        "the replayed create is not recorded twice"
    );
    let approval = writes.iter().find(|r| r.action == "approve").unwrap();
    let detail = approval.detail.as_deref().unwrap();
    assert!(detail.contains("\"selfApproval\":true"));
    assert!(!detail.contains("5000"), "no rate in the audit");
    assert!(rows
        .iter()
        .any(|r| r.resource == "time_entries" && r.action == "denied"));
}

#[tokio::test]
async fn p4b_rest_work_masters_follow_the_master_rights() {
    let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    for token in [&editor, &viewer] {
        let response = router
            .clone()
            .oneshot(get_auth("/api/phases", token))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "not a company member"
        );
    }
    let response = router
        .clone()
        .oneshot(get_auth("/api/common-activities", &admin))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await.as_array().unwrap().len(), 4);

    grant(&router, &admin, EDITOR_ID, json!(["time.entry"])).await;
    let response = router
        .clone()
        .oneshot(get_auth("/api/phases", &editor))
        .await
        .unwrap();
    assert_eq!(body_json(response).await.as_array().unwrap().len(), 6);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/phases",
            &editor,
            json!({ "name": "据付", "sortOrder": 70 }),
        ))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "time.entry alone does not maintain masters"
    );
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["time.entry", "project.manage"]),
    )
    .await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/phases",
            &editor,
            json!({ "name": "据付", "sortOrder": 70 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let row = body_json(response).await;
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/phases/{}", row["id"]),
            &admin,
            json!({ "name": "据付", "sortOrder": 70, "active": false, "rowVersion": row["rowVersion"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["active"], false);
}

#[tokio::test]
async fn p4b_rest_returned_entry_is_fixed_resubmitted_and_drafts_deleted() {
    let (router, _audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["time.entry", "project.manage"]),
    )
    .await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-001", EDITOR_ID),
        ))
        .await
        .unwrap();
    let project = body_json(response).await["id"].as_i64().unwrap();
    let body = |phase: i64, row_version: Option<i64>| {
        json!({
            "workDate": "2026-11-09", "projectId": project, "phaseId": phase,
            "minutes": 60, "rowVersion": row_version
        })
    };
    let response = router
        .clone()
        .oneshot(post_json_auth("/api/time-entries", &editor, body(1, None)))
        .await
        .unwrap();
    let id = body_json(response).await["entry"]["id"].as_i64().unwrap();
    router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{id}/submit"),
            &editor,
            json!({ "rowVersion": 1 }),
        ))
        .await
        .unwrap();
    // Returning needs a reason.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{id}/decide"),
            &editor,
            json!({ "rowVersion": 2, "approve": false }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{id}/decide"),
            &editor,
            json!({ "rowVersion": 2, "approve": false, "reason": "工程が違います" }),
        ))
        .await
        .unwrap();
    let returned = body_json(response).await;
    assert_eq!(returned["status"], "returned");
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/time-entries/{id}"),
            &editor,
            body(2, returned["rowVersion"].as_i64()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let fixed = body_json(response).await["entry"].clone();
    assert_eq!(fixed["phaseName"], "ソフト開発");
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{id}/submit"),
            &editor,
            json!({ "rowVersion": fixed["rowVersion"] }),
        ))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["status"], "submitted");

    // A draft is deleted with the version it was read at; a stale one is refused.
    let response = router
        .clone()
        .oneshot(post_json_auth("/api/time-entries", &editor, body(1, None)))
        .await
        .unwrap();
    let draft = body_json(response).await["entry"]["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(delete_auth(
            &format!("/api/time-entries/{draft}?rowVersion=9"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let response = router
        .clone()
        .oneshot(delete_auth(
            &format!("/api/time-entries/{draft}?rowVersion=1"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn t09_t12_rest_budget_versions_keep_the_original_and_follow_scope() {
    let (router, audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["project.manage", "amount.view"]),
    )
    .await;
    grant(&router, &admin, 1, json!(["finance.rate", "amount.view"])).await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/calc-basis",
            &admin,
            json!({ "itemKey": "budget_rate", "validFrom": "2020-01-01", "value": 5_000, "reason": "標準" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-B01", EDITOR_ID),
        ))
        .await
        .unwrap();
    let project = body_json(response).await;
    let id = project["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/convert"),
            &editor,
            json!({
                "rowVersion": project["rowVersion"],
                "convertedOn": "2026-11-20",
                "confirmedAmount": 4_000_000,
                "basis": "注文書受領",
                "plannedStart": "2026-12-01",
                "plannedEnd": "2027-03-31",
                "revenuePlan": [{ "month": "2027-03", "amount": 4_000_000 }],
                "scope": "whole"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // Not the manager: no drafting (T12); the viewer role cannot write.
    for token in [&admin, &viewer] {
        let response = router
            .clone()
            .oneshot(post_json_auth(
                &format!("/api/projects/{id}/budget/draft"),
                token,
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    // The manager drafts; a retried create returns the same draft (T13).
    let mut ids = Vec::new();
    for _ in 0..2 {
        let response = router
            .clone()
            .oneshot(post_json_auth(
                &format!("/api/projects/{id}/budget/draft"),
                &editor,
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        ids.push(body_json(response).await["draft"]["id"].as_i64().unwrap());
    }
    assert_eq!(ids[0], ids[1]);
    let draft = ids[0];
    let lines = json!([
        { "phaseId": 1, "costType": "labor", "plannedMinutes": 12_000 },
        { "costType": "material", "amount": 900_000 },
        { "costType": "outsource", "amount": 500_000 },
        { "costType": "travel", "amount": 150_000 },
        { "costType": "other", "amount": 50_000 }
    ]);
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/budget-versions/{draft}"),
            &editor,
            json!({ "rowVersion": 1, "lines": lines }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let saved = body_json(response).await;
    assert_eq!(saved["total"], 2_600_000);
    // A stale version is refused (T13).
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/budget-versions/{draft}"),
            &editor,
            json!({ "rowVersion": 1, "lines": [] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // Someone without the project's scope cannot approve it.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/budget-versions/{draft}/approve"),
            &admin,
            json!({ "rowVersion": saved["rowVersion"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    // The manager approves their own draft (company policy), audited.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/budget-versions/{draft}/approve"),
            &editor,
            json!({ "rowVersion": saved["rowVersion"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let v1 = body_json(response).await;
    assert_eq!(v1["versionNo"], 1);

    // A change needs its reason, then becomes the current budget (T09).
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/budget/draft"),
            &editor,
            json!({}),
        ))
        .await
        .unwrap();
    let d2 = body_json(response).await["draft"].clone();
    let d2_id = d2["id"].as_i64().unwrap();
    assert_eq!(d2["lines"].as_array().unwrap().len(), 5, "copied from v1");
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/budget-versions/{d2_id}/approve"),
            &editor,
            json!({ "rowVersion": d2["rowVersion"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/budget-versions/{d2_id}"),
            &editor,
            json!({
                "rowVersion": d2["rowVersion"],
                "reason": "追加工事",
                "lines": [{ "phaseId": 1, "costType": "labor", "plannedMinutes": 14_400 }]
            }),
        ))
        .await
        .unwrap();
    let d2 = body_json(response).await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/budget-versions/{d2_id}/approve"),
            &editor,
            json!({ "rowVersion": d2["rowVersion"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/budget"), &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let overview = body_json(response).await;
    assert_eq!(overview["original"]["versionNo"], 1);
    assert_eq!(overview["original"]["total"], 2_600_000);
    assert_eq!(overview["current"]["versionNo"], 2);
    assert_eq!(overview["current"]["reason"], "追加工事");
    assert_eq!(overview["current"]["total"], 1_200_000);
    assert_eq!(overview["history"].as_array().unwrap().len(), 2);
    // Approved versions are never deleted.
    let response = router
        .clone()
        .oneshot(delete_auth(
            &format!("/api/budget-versions/{draft}?rowVersion=2"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    // Out of scope: no budget amounts (T12).
    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/budget"), &admin))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // Audit: the self-approval is recorded, amounts are not.
    let writes: Vec<_> = audit
        .list(ListParams::default())
        .await
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| row.resource == "budgets" && row.action == "approve")
        .collect();
    assert_eq!(writes.len(), 2);
    for row in &writes {
        let detail = row.detail.clone().unwrap_or_default();
        assert!(detail.contains("\"selfApproval\":true"), "{detail}");
        assert!(!detail.contains("2600000"), "{detail}");
    }
    assert!(denied_entries(&audit)
        .await
        .iter()
        .any(|row| row.resource == "budgets"));
}

#[tokio::test]
async fn t05_t12_t14_rest_direct_costs_and_orders_follow_scope_and_do_not_double() {
    let (router, audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["project.manage", "amount.view", "time.entry"]),
    )
    .await;
    grant(&router, &admin, 1, json!(["finance.rate"])).await;
    grant(&router, &admin, VIEWER_ID, json!(["time.entry"])).await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-C01", EDITOR_ID),
        ))
        .await
        .unwrap();
    let id = body_json(response).await["id"].as_i64().unwrap();

    // Orders: the manager registers; someone outside the project cannot (T12).
    let order = json!({
        "projectId": id,
        "costType": "outsource",
        "orderedOn": "2026-11-01",
        "amount": 500_000,
        "clientRequestId": "po-1"
    });
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/purchase-orders",
            &admin,
            order.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = router
        .clone()
        .oneshot(post_json_auth("/api/purchase-orders", &editor, order))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let po = body_json(response).await["order"]["id"].as_i64().unwrap();

    // The viewer role cannot write, whatever its capabilities.
    let provisional = json!({
        "entryKind": "provisional",
        "purchaseOrderId": po,
        "bookedOn": "2026-11-30",
        "amount": 300_000,
        "clientRequestId": "c-1"
    });
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/direct-costs",
            &viewer,
            provisional.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // Acceptance as a provisional, then the invoice replaces it (T05).
    let approve_cost = |body: serde_json::Value| {
        let router = router.clone();
        let editor = editor.clone();
        async move {
            let response = router
                .clone()
                .oneshot(post_json_auth("/api/direct-costs", &editor, body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let cost = body_json(response).await["cost"].clone();
            let cid = cost["id"].as_i64().unwrap();
            let response = router
                .clone()
                .oneshot(post_json_auth(
                    &format!("/api/direct-costs/{cid}/submit"),
                    &editor,
                    json!({ "rowVersion": cost["rowVersion"] }),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let cost = body_json(response).await;
            let response = router
                .clone()
                .oneshot(post_json_auth(
                    &format!("/api/direct-costs/{cid}/decide"),
                    &editor,
                    json!({ "rowVersion": cost["rowVersion"], "approve": true }),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            cid
        }
    };
    let prov = approve_cost(provisional).await;
    approve_cost(json!({
        "entryKind": "confirms",
        "refId": prov,
        "bookedOn": "2026-11-30",
        "amount": 300_000,
        "reason": "請求書到着"
    }))
    .await;

    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/costs"), &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let costs = body_json(response).await;
    let outsource = costs["totals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["costType"] == "outsource")
        .unwrap()
        .clone();
    assert_eq!(outsource["amount"], 300_000);
    assert_eq!(costs["orders"][0]["realized"], 300_000);
    assert_eq!(costs["orders"][0]["remaining"], 200_000);
    assert_eq!(costs["committed"], 200_000);
    // The budget comparison now carries the direct-cost actuals.
    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/budget"), &editor))
        .await
        .unwrap();
    let budget = body_json(response).await;
    assert_eq!(budget["directActualComplete"], true);
    let row = budget["totals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["costType"] == "outsource")
        .unwrap()
        .clone();
    assert_eq!(row["actual"], 300_000);

    // Out of scope: no project costs, no deciding, no approvals listed (T12).
    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/costs"), &admin))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    // A worker without membership cannot enter on the project.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/direct-costs",
            &admin,
            json!({ "projectId": id, "costType": "travel", "bookedOn": "2026-11-30", "amount": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = router
        .clone()
        .oneshot(get_auth("/api/direct-costs/approvals", &admin))
        .await
        .unwrap();
    assert_eq!(body_json(response).await, json!([]));
    // The own list shows the caller's records only.
    let response = router
        .clone()
        .oneshot(get_auth(
            "/api/direct-costs?from=2026-11-01&to=2026-11-30",
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(body_json(response).await.as_array().unwrap().len(), 2);
    let response = router
        .clone()
        .oneshot(get_auth(
            "/api/direct-costs?from=2026-11-01&to=2026-11-30",
            &viewer,
        ))
        .await
        .unwrap();
    assert_eq!(body_json(response).await, json!([]));

    // Cancelling the remainder keeps the reason (T14 / spec §6.5).
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/purchase-orders/{po}/revise"),
            &editor,
            json!({ "kind": "cancel", "amount": 200_000, "reason": "残りは不要", "rowVersion": costs["orders"][0]["rowVersion"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let revised = body_json(response).await;
    assert_eq!(revised["remaining"], 0);
    assert_eq!(revised["changes"][0]["reason"], "残りは不要");

    // Audit: approvals carry the self-approval flag and no amounts.
    let writes: Vec<_> = audit
        .list(ListParams::default())
        .await
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| row.resource == "direct_costs" && row.action == "approve")
        .collect();
    assert_eq!(writes.len(), 2);
    for row in &writes {
        let detail = row.detail.clone().unwrap_or_default();
        assert!(detail.contains("\"selfApproval\":true"), "{detail}");
        assert!(!detail.contains("300000"), "{detail}");
    }
    assert!(denied_entries(&audit)
        .await
        .iter()
        .any(|row| row.resource == "purchase_orders"));
}

#[tokio::test]
async fn t06_t12_t30_rest_forecast_versions_and_portfolio_follow_scope() {
    let (router, audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["project.manage", "amount.view"]),
    )
    .await;
    grant(&router, &admin, 1, json!(["finance.rate", "amount.view"])).await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/calc-basis",
            &admin,
            json!({ "itemKey": "forecast_rate", "validFrom": "2020-01-01", "value": 5_000, "reason": "標準" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-F01", EDITOR_ID),
        ))
        .await
        .unwrap();
    let project = body_json(response).await;
    let id = project["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/convert"),
            &editor,
            json!({
                "rowVersion": project["rowVersion"],
                "convertedOn": "2026-11-20",
                "confirmedAmount": 4_000_000,
                "basis": "注文書受領",
                "plannedStart": "2026-12-01",
                "plannedEnd": "2027-03-31",
                "revenuePlan": [{ "month": "2027-03", "amount": 4_000_000 }],
                "scope": "whole"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // Not the manager (admin without the project) and the viewer role: no draft.
    for token in [&admin, &viewer] {
        let response = router
            .clone()
            .oneshot(post_json_auth(
                &format!("/api/projects/{id}/forecast/draft"),
                token,
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let mut ids = Vec::new();
    for _ in 0..2 {
        let response = router
            .clone()
            .oneshot(post_json_auth(
                &format!("/api/projects/{id}/forecast/draft"),
                &editor,
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        ids.push(body_json(response).await["draft"]["id"].as_i64().unwrap());
    }
    assert_eq!(
        ids[0], ids[1],
        "a retried create returns the same draft (T13)"
    );
    let draft = ids[0];
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/forecast-versions/{draft}"),
            &editor,
            json!({
                "rowVersion": 1,
                "baseDate": "2026-01-31",
                "reason": "初回の見込",
                "lines": [
                    { "phaseId": 1, "costType": "labor", "remainingMinutes": 6_000 },
                    { "costType": "material", "amount": 400_000 }
                ]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let saved = body_json(response).await;
    assert_eq!(saved["costTotal"], 900_000);
    assert_eq!(saved["profit"], 3_100_000);

    // Out of scope: no adoption, no amounts (T12).
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/forecast-versions/{draft}/adopt"),
            &admin,
            json!({ "rowVersion": saved["rowVersion"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/forecast"), &admin))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    // The manager adopts their own draft (company policy), audited.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/forecast-versions/{draft}/adopt"),
            &editor,
            json!({ "rowVersion": saved["rowVersion"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let v1 = body_json(response).await;
    assert_eq!(v1["versionNo"], 1);
    assert_eq!(v1["status"], "adopted");
    let response = router
        .clone()
        .oneshot(delete_auth(
            &format!("/api/forecast-versions/{draft}?rowVersion=2"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/forecast"), &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let overview = body_json(response).await;
    assert_eq!(overview["latest"]["costTotal"], 900_000);
    assert_eq!(overview["currentProfit"], 3_100_000);
    assert_eq!(overview["updateReasons"], json!([]));

    // Portfolio: the manager sees the amounts; the admin (no project, no
    // amount.view on it) sees the row but no amount and no alert.
    let response = router
        .clone()
        .oneshot(get_auth("/api/portfolio", &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mine = body_json(response).await;
    let find = |list: &serde_json::Value| {
        list["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["projectId"] == id)
            .cloned()
            .unwrap()
    };
    let row = find(&mine);
    assert_eq!(row["amountsVisible"], true);
    assert_eq!(row["forecastCost"], 900_000);
    assert_eq!(row["forecastProfit"], 3_100_000);
    let response = router
        .clone()
        .oneshot(get_auth("/api/portfolio", &admin))
        .await
        .unwrap();
    let theirs = body_json(response).await;
    let row = find(&theirs);
    assert_eq!(row["amountsVisible"], false);
    assert!(row["forecastCost"].is_null());
    assert_eq!(row["alerts"], json!([]));

    let writes: Vec<_> = audit
        .list(ListParams::default())
        .await
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| row.resource == "forecasts" && row.action == "adopt")
        .collect();
    assert_eq!(writes.len(), 1);
    let detail = writes[0].detail.clone().unwrap_or_default();
    assert!(detail.contains("\"selfApproval\":true"), "{detail}");
    assert!(
        !detail.contains("900000"),
        "no amounts in the audit: {detail}"
    );
}

#[tokio::test]
async fn t17_t12_rest_closeout_is_settled_and_reopened_by_the_manager_or_accounting() {
    let (router, audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["project.manage", "amount.view"]),
    )
    .await;
    grant(&router, &admin, 1, json!(["finance.close", "amount.view"])).await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-C01", EDITOR_ID),
        ))
        .await
        .unwrap();
    let project = body_json(response).await;
    let id = project["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/convert"),
            &editor,
            json!({
                "rowVersion": project["rowVersion"],
                "convertedOn": "2026-11-20",
                "confirmedAmount": 1_000_000,
                "basis": "注文書受領",
                "plannedStart": "2026-12-01",
                "plannedEnd": "2027-03-31",
                "revenuePlan": [{ "month": "2027-03", "amount": 1_000_000 }],
                "scope": "whole"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // The manager marks the work done.
    let current = body_json(
        router
            .clone()
            .oneshot(get_auth(&format!("/api/projects/{id}"), &editor))
            .await
            .unwrap(),
    )
    .await;
    let mut body = project_body("P-C01", EDITOR_ID);
    body["status"] = json!("work_done");
    body["plannedStart"] = json!("2026-12-01");
    body["plannedEnd"] = json!("2027-03-31");
    body["rowVersion"] = current["rowVersion"].clone();
    let response = router
        .clone()
        .oneshot(put_json(&format!("/api/projects/{id}"), &editor, body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // The manager sees the check; the viewer (no capability) does not.
    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/closeout"), &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let check = body_json(response).await;
    assert_eq!(check["settleable"], true);
    assert_eq!(check["blockers"][0]["kind"], "revenue_difference");
    assert_eq!(check["blockers"][0]["amount"], 1_000_000);
    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/closeout"), &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let waiver = json!({
        "rowVersion": check["rowVersion"],
        "note": "精算",
        "waivers": [{ "kind": "revenue_difference", "amount": 1_000_000, "reason": "値引きで合意" }]
    });
    // The viewer role does not settle.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/closeout"),
            &viewer,
            waiver.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(denied_entries(&audit)
        .await
        .iter()
        .any(|row| row.resource == "project_closeouts"));
    // Accounting: without the waiver the remaining revenue blocks it.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/closeout"),
            &admin,
            json!({ "rowVersion": check["rowVersion"], "waivers": [] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    // The project's manager settles it (2026-11-07 decision).
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/closeout"),
            &editor,
            waiver.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let settled = body_json(response).await;
    assert_eq!(settled["status"], "settled");
    assert_eq!(settled["closeout"]["waivers"][0]["reason"], "値引きで合意");

    // Reopening: the viewer may not; a reason is required; the manager may.
    let reopen_url = format!("/api/projects/{id}/closeout/reopen");
    let reopen = json!({ "rowVersion": settled["rowVersion"], "reason": "売上の計上漏れ" });
    let response = router
        .clone()
        .oneshot(post_json_auth(&reopen_url, &viewer, reopen.clone()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &reopen_url,
            &editor,
            json!({ "rowVersion": settled["rowVersion"], "reason": "" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let response = router
        .clone()
        .oneshot(post_json_auth(&reopen_url, &editor, reopen.clone()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let reopened = body_json(response).await;
    assert_eq!(reopened["status"], "work_done");
    assert!(reopened["closeout"].is_null());
    assert_eq!(
        reopened["history"][0]["reopening"]["reason"],
        "売上の計上漏れ"
    );
    assert_eq!(
        reopened["history"][0]["waivers"][0]["reason"],
        "値引きで合意"
    );
    // Accounting settles it again.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/closeout"),
            &admin,
            json!({
                "rowVersion": reopened["rowVersion"],
                "waivers": [{ "kind": "revenue_difference", "amount": 1_000_000, "reason": "値引きで合意" }]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["status"], "settled");
    // Once settled, the order takes no revenue.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/recognitions"),
            &admin,
            json!({ "recognizedOn": "2027-03-10", "amount": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let writes: Vec<_> = audit
        .list(ListParams::default())
        .await
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| row.resource == "project_closeouts" && row.action == "settle")
        .collect();
    assert_eq!(writes.len(), 2);
    let detail = writes[0].detail.clone().unwrap_or_default();
    assert!(detail.contains("revenue_difference"), "{detail}");
    assert!(!detail.contains("1000000"), "no amounts: {detail}");
    let reopens: Vec<_> = audit
        .list(ListParams::default())
        .await
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| row.resource == "project_closeouts" && row.action == "reopen")
        .collect();
    assert_eq!(reopens.len(), 1);
    let detail = reopens[0].detail.clone().unwrap_or_default();
    assert!(detail.contains("closeoutId"), "{detail}");
    assert!(!detail.contains("計上漏れ"), "no reason: {detail}");
}

#[tokio::test]
async fn t11_rest_closing_is_accounting_only_and_refuses_hours_in_a_closed_month() {
    let (router, audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;
    // finance.close without amount.view: the month's figures stay hidden.
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["time.entry", "finance.close"]),
    )
    .await;
    let response = router
        .clone()
        .oneshot(get_auth("/api/closing/2026-10", &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    grant(&router, &admin, EDITOR_ID, json!(["time.entry"])).await;
    grant(&router, &admin, 1, json!(["finance.close", "amount.view"])).await;

    // Without finance.close: no month, no close.
    let response = router
        .clone()
        .oneshot(get_auth("/api/closing/2026-10", &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/closing/2026-10/close",
            &editor,
            json!({ "rowVersion": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(denied_entries(&audit)
        .await
        .iter()
        .any(|row| row.resource == "closing_periods"));

    // Accounting closes the month.
    let response = router
        .clone()
        .oneshot(get_auth("/api/closing/2026-10", &admin))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let month = body_json(response).await;
    assert_eq!(month["status"], "open");
    assert_eq!(month["canClose"], true);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/closing/2026-10/close",
            &admin,
            json!({ "rowVersion": month["rowVersion"] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let closed = body_json(response).await;
    assert_eq!(closed["status"], "closed");

    // An hour on a common activity dated in the closed month is refused.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/time-entries",
            &editor,
            json!({ "workDate": "2026-10-15", "activityId": 1, "minutes": 60 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = body_json(response).await;
    assert!(body.to_string().contains("締め済み"), "{body}");

    // Reopening needs a reason, then the month takes hours again.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/closing/2026-10/reopen",
            &admin,
            json!({ "rowVersion": closed["rowVersion"], "reason": "" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/closing/2026-10/reopen",
            &admin,
            json!({ "rowVersion": closed["rowVersion"], "reason": "工数の追加" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/time-entries",
            &editor,
            json!({ "workDate": "2026-10-15", "activityId": 1, "minutes": 60 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(get_auth("/api/closing", &admin))
        .await
        .unwrap();
    let months = body_json(response).await;
    assert_eq!(months[0]["month"], "2026-10");
    assert_eq!(months[0]["status"], "reopened");
    // The audit names the month and the action, not the reason.
    let entries = audit.list(ListParams::default()).await.unwrap().rows;
    let reopen = entries
        .iter()
        .find(|e| e.resource == "closing_periods" && e.action == "reopen")
        .expect("reopen audited");
    let detail = format!("{:?}", reopen.detail);
    assert!(detail.contains("2026-10"), "{detail}");
    assert!(!detail.contains("工数の追加"), "{detail}");
}

// Tauri twin: `t11_tauri_time_corrections_are_requested_by_the_owner_and_approved_by_accounting`.
#[tokio::test]
async fn t11_rest_time_corrections_are_requested_by_the_owner_and_approved_by_accounting() {
    let (router, audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["time.entry", "project.manage", "amount.view"]),
    )
    .await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-001", EDITOR_ID),
        ))
        .await
        .unwrap();
    let project = body_json(response).await["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/time-entries",
            &editor,
            json!({ "workDate": "2026-11-09", "projectId": project, "phaseId": 1, "minutes": 120 }),
        ))
        .await
        .unwrap();
    let id = body_json(response).await["entry"]["id"].as_i64().unwrap();
    for (path, body) in [
        ("submit", json!({ "rowVersion": 1 })),
        ("decide", json!({ "rowVersion": 2, "approve": true })),
    ] {
        let response = router
            .clone()
            .oneshot(post_json_auth(
                &format!("/api/time-entries/{id}/{path}"),
                &editor,
                body,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
    }
    let correction = |reason: &str| {
        json!({
            "workDate": "2026-11-09", "projectId": project, "phaseId": 2, "minutes": 90,
            "rowVersion": 3, "reason": reason
        })
    };
    // Someone else's entry reads as not found; a reason is required.
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{id}/correct"),
            &admin,
            correction("工程の誤り"),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{id}/correct"),
            &editor,
            correction(""),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{id}/correct"),
            &editor,
            correction("工程の誤り"),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let saved = body_json(response).await;
    let cid = saved["entry"]["id"].as_i64().unwrap();
    assert_eq!(saved["entry"]["status"], "submitted");
    assert_eq!(saved["entry"]["correctsId"], id);

    // The project's manager approves hours but not their corrections (訂正承認).
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{cid}/decide"),
            &editor,
            json!({ "rowVersion": 1, "approve": true }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = router
        .clone()
        .oneshot(get_auth("/api/time-entries/corrections", &editor))
        .await
        .unwrap();
    assert!(body_json(response).await.as_array().unwrap().is_empty());
    let response = router
        .clone()
        .oneshot(get_auth("/api/time-entries/approvals", &editor))
        .await
        .unwrap();
    assert!(
        body_json(response).await.as_array().unwrap().is_empty(),
        "a correction is not in the manager's list"
    );

    grant(&router, &admin, 1, json!(["finance.close"])).await;
    let response = router
        .clone()
        .oneshot(get_auth("/api/time-entries/corrections", &admin))
        .await
        .unwrap();
    let queue = body_json(response).await;
    assert_eq!(queue.as_array().unwrap().len(), 1);
    assert_eq!(queue[0]["original"]["minutes"], 120);
    assert_eq!(queue[0]["correction"]["minutes"], 90);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/time-entries/{cid}/decide"),
            &admin,
            json!({ "rowVersion": 1, "approve": true }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // The replaced entry left the figures; the owner sees the chain.
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/projects/{project}/time-summary"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(
        body_json(response).await["total"]["approved"]["minutes"],
        90
    );
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/time-entries/{id}/corrections"),
            &editor,
        ))
        .await
        .unwrap();
    let chain = body_json(response).await;
    assert_eq!(chain.as_array().unwrap().len(), 1);
    assert_eq!(chain[0]["correctionReason"], "工程の誤り");
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/time-entries/{id}/corrections"),
            &admin,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // The audit keeps the action, never the free-text reason.
    let logged = audit.list(ListParams::default()).await.unwrap();
    let correct = logged
        .rows
        .iter()
        .find(|e| e.action == "correct")
        .expect("correct is audited");
    let detail = correct.detail.clone().unwrap_or_default();
    assert!(!detail.contains("工程の誤り"));
    assert!(detail.contains("correctsId"));
}

// Tauri twin: `t12_t15_tauri_monthly_figures_and_csv_follow_scope`.
#[tokio::test]
async fn t12_t15_rest_monthly_figures_and_csv_follow_scope() {
    let (router, audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["project.manage", "amount.view", "finance.close"]),
    )
    .await;
    grant(&router, &admin, 1, json!(["amount.view"])).await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-M01", EDITOR_ID),
        ))
        .await
        .unwrap();
    let project = body_json(response).await;
    let id = project["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/convert"),
            &editor,
            json!({
                "rowVersion": project["rowVersion"],
                "convertedOn": "2027-04-01",
                "confirmedAmount": 1_000_000,
                "basis": "注文書受領",
                "plannedStart": "2027-04-01",
                "plannedEnd": "2027-07-31",
                "revenuePlan": [
                    { "month": "2027-05", "amount": 600_000 },
                    { "month": "2027-07", "amount": 400_000 }
                ],
                "scope": "whole"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    for (on, amount) in [("2027-05-31", 600_000), ("2027-07-31", 400_000)] {
        let response = router
            .clone()
            .oneshot(post_json_auth(
                &format!("/api/projects/{id}/order/recognitions"),
                &editor,
                json!({ "recognizedOn": on, "amount": amount, "basis": "検収" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    // The manager sees the months across 第13期 and 第14期.
    let response = router
        .clone()
        .oneshot(get_auth(&format!("/api/projects/{id}/monthly"), &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let monthly = body_json(response).await;
    assert_eq!(monthly["spansPeriods"], true);
    assert_eq!(monthly["lines"].as_array().unwrap().len(), 3);
    assert_eq!(monthly["total"]["revenue"], 1_000_000);
    assert_eq!(monthly["periods"][1]["period"], 14);
    let response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/projects/{id}/monthly.csv"),
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let csv = body_json(response).await;
    let content = csv["content"].as_str().unwrap();
    assert!(content.starts_with('\u{feff}'));
    assert!(content.contains("集計条件,案件,P-M01"), "{content}");
    assert_eq!(csv["rowCount"], 3);

    // Not on the project (admin with amount.view, viewer): no figures (T12).
    for token in [&admin, &viewer] {
        for path in [
            format!("/api/projects/{id}/monthly"),
            format!("/api/projects/{id}/monthly.csv"),
        ] {
            let response = router
                .clone()
                .oneshot(get_auth(&path, token))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        }
    }
    assert!(denied_entries(&audit)
        .await
        .iter()
        .any(|row| row.resource == "reports"));

    // The overall list CSV: the admin sees the row, no amount.
    let response = router
        .clone()
        .oneshot(get_auth("/api/reports/portfolio.csv", &admin))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let theirs = body_json(response).await;
    let row = theirs["content"]
        .as_str()
        .unwrap()
        .split("\r\n")
        .find(|l| l.starts_with("P-M01,"))
        .unwrap()
        .to_string();
    assert!(!row.contains("1000000"), "{row}");
    let response = router
        .clone()
        .oneshot(get_auth("/api/reports/portfolio.csv", &editor))
        .await
        .unwrap();
    let mine = body_json(response).await;
    assert!(mine["content"].as_str().unwrap().contains(",1000000,"));

    // The period CSV lists the amount scope only.
    let response = router
        .clone()
        .oneshot(get_auth(
            "/api/reports/period-monthly.csv?period=14",
            &admin,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["rowCount"], 0);
    let response = router
        .clone()
        .oneshot(get_auth(
            "/api/reports/period-monthly.csv?period=14",
            &editor,
        ))
        .await
        .unwrap();
    let period = body_json(response).await;
    // June (no record, kept so the cumulative runs on) and July.
    assert_eq!(period["rowCount"], 2);
    assert!(period["content"].as_str().unwrap().contains("P-M01,"));
    let response = router
        .clone()
        .oneshot(get_auth(
            "/api/reports/period-monthly.csv?period=0",
            &editor,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // Exports are audited with the kind and the row count, no amount.
    let entries = audit.list(ListParams::default()).await.unwrap().rows;
    let exports: Vec<_> = entries
        .iter()
        .filter(|e| e.resource == "reports" && e.action == "export")
        .collect();
    assert_eq!(exports.len(), 5);
    for e in exports {
        let detail = format!("{:?}", e.detail);
        assert!(!detail.contains("1000000"), "{detail}");
        assert!(!detail.contains("P-M01"), "{detail}");
    }
}

#[tokio::test]
async fn t37_rest_fixed_costs_need_finance_rate_and_post_a_month_once() {
    let (router, audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["project.manage", "amount.view", "finance.close"]),
    )
    .await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-F01", EDITOR_ID),
        ))
        .await
        .unwrap();
    let project = body_json(response).await;
    let id = project["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/convert"),
            &editor,
            json!({
                "rowVersion": project["rowVersion"],
                "convertedOn": "2026-06-01",
                "confirmedAmount": 3_600_000,
                "basis": "年間契約",
                "plannedStart": "2026-06-01",
                "plannedEnd": "2027-05-31",
                "revenuePlan": [{ "month": "2026-06", "amount": 3_600_000 }],
                "scope": "whole"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/vendors",
            &admin,
            json!({ "name": "架空外注" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let vendor = body_json(response).await["id"].as_i64().unwrap();
    let contract = json!({
        "projectId": id,
        "payeeKind": "vendor",
        "vendorId": vendor,
        "monthlyAmount": 300_000,
        "fromMonth": "2026-06"
    });

    // finance.close without finance.rate: per-person amounts stay hidden.
    for request in [
        get_auth("/api/fixed-costs/contracts", &editor),
        get_auth("/api/fixed-costs/months/2026-06", &editor),
        post_json_auth("/api/fixed-costs/contracts", &editor, contract.clone()),
        post_json_auth("/api/fixed-costs/months/2026-06/post", &editor, json!({})),
    ] {
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    assert!(denied_entries(&audit)
        .await
        .iter()
        .any(|row| row.resource == "fixed_costs"));

    grant(&router, &admin, 1, json!(["finance.rate", "amount.view"])).await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/fixed-costs/contracts",
            &admin,
            contract,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let created = body_json(response).await;
    assert_eq!(created["costType"], "outsource");
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/fixed-costs/months/2026-06/post",
            &admin,
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let posted = body_json(response).await;
    assert_eq!(posted["posted"], 1);
    assert_eq!(posted["view"]["postedTotal"], 300_000);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/fixed-costs/months/2026-06/post",
            &admin,
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["posted"], 0, "二度計上しない");

    // The amount changes later months only.
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/fixed-costs/contracts/{}", created["id"]),
            &admin,
            json!({
                "projectId": id,
                "payeeKind": "vendor",
                "vendorId": vendor,
                "monthlyAmount": 200_000,
                "fromMonth": "2026-06",
                "rowVersion": created["rowVersion"]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = router
        .clone()
        .oneshot(get_auth("/api/fixed-costs/months/2026-06", &admin))
        .await
        .unwrap();
    let june = body_json(response).await;
    assert_eq!(june["postedTotal"], 300_000);

    // Cancelling needs a reason; the audit keeps no amount nor reason.
    let posting = june["lines"][0]["posting"]["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/fixed-costs/postings/{posting}/cancel"),
            &admin,
            json!({ "reason": "" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/fixed-costs/postings/{posting}/cancel"),
            &admin,
            json!({ "reason": "二重払いの訂正" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["postedTotal"], 0);
    let entries = audit.list(ListParams::default()).await.unwrap().rows;
    let writes: Vec<_> = entries
        .iter()
        .filter(|e| e.resource == "fixed_costs" && e.action != "denied")
        .collect();
    let actions: Vec<&str> = writes.iter().map(|e| e.action.as_str()).collect();
    for action in ["create", "update", "post", "cancel"] {
        assert!(actions.contains(&action), "{actions:?}");
    }
    for e in writes {
        let detail = format!("{:?}", e.detail);
        assert!(
            !detail.contains("300000") && !detail.contains("200000"),
            "{detail}"
        );
        assert!(!detail.contains("二重払い"), "{detail}");
    }
}

#[tokio::test]
async fn t38_rest_recurring_revenue_needs_finance_close_and_recognizes_a_month_once() {
    let (router, audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;
    grant(
        &router,
        &admin,
        EDITOR_ID,
        json!(["project.manage", "amount.view"]),
    )
    .await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/projects",
            &editor,
            project_body("P-R01", EDITOR_ID),
        ))
        .await
        .unwrap();
    let project = body_json(response).await;
    let id = project["id"].as_i64().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/projects/{id}/order/convert"),
            &editor,
            json!({
                "rowVersion": project["rowVersion"],
                "convertedOn": "2026-06-01",
                "confirmedAmount": 3_600_000,
                "basis": "年間保守契約",
                "plannedStart": "2026-06-01",
                "plannedEnd": "2027-05-31",
                "revenuePlan": [{ "month": null, "amount": 3_600_000 }],
                "scope": "whole"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let agreement = json!({
        "projectId": id,
        "monthlyAmount": 300_000,
        "fromMonth": "2026-06",
        "toMonth": "2027-05"
    });

    // The project manager is not accounting (no finance.close).
    for request in [
        get_auth("/api/recurring-revenue/agreements", &editor),
        get_auth("/api/recurring-revenue/months/2026-06", &editor),
        post_json_auth(
            "/api/recurring-revenue/agreements",
            &editor,
            agreement.clone(),
        ),
        post_json_auth(
            "/api/recurring-revenue/months/2026-06/recognize",
            &editor,
            json!({}),
        ),
    ] {
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    assert!(denied_entries(&audit)
        .await
        .iter()
        .any(|row| row.resource == "recurring_revenues"));

    grant(&router, &admin, 1, json!(["finance.close", "amount.view"])).await;
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/recurring-revenue/agreements",
            &admin,
            agreement,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let created = body_json(response).await;
    assert_eq!(created["months"], 12);
    assert_eq!(created["contractTotal"], 3_600_000);

    // A mismatching change is refused with the reason.
    let response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/recurring-revenue/agreements/{}", created["id"]),
            &admin,
            json!({
                "projectId": id,
                "monthlyAmount": 250_000,
                "fromMonth": "2026-06",
                "toMonth": "2027-05",
                "rowVersion": created["rowVersion"]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/recurring-revenue/months/2026-06/recognize",
            &admin,
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let r = body_json(response).await;
    assert_eq!(r["recognized"], 1);
    assert_eq!(r["view"]["recognizedOn"], "2026-06-30");
    assert_eq!(r["view"]["lines"][0]["state"], "recognized");
    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/recurring-revenue/months/2026-06/recognize",
            &admin,
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["recognized"], 0, "二度計上しない");
    let response = router
        .clone()
        .oneshot(get_auth("/api/recurring-revenue/months/2026-07", &admin))
        .await
        .unwrap();
    let july = body_json(response).await;
    assert_eq!(july["dueCount"], 1);
    assert_eq!(july["dueTotal"], 300_000);

    // The audit keeps the action, the month and the project, no amount.
    let entries = audit.list(ListParams::default()).await.unwrap().rows;
    let writes: Vec<_> = entries
        .iter()
        .filter(|e| e.resource == "recurring_revenues" && e.action != "denied")
        .collect();
    let actions: Vec<&str> = writes.iter().map(|e| e.action.as_str()).collect();
    for action in ["create", "recognize"] {
        assert!(actions.contains(&action), "{actions:?}");
    }
    for e in writes {
        let detail = format!("{:?}", e.detail);
        assert!(
            !detail.contains("300000") && !detail.contains("3600000"),
            "{detail}"
        );
    }
}
