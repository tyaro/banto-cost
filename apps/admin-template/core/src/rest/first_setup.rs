//! `POST /api/auth/setup` の後始末（banto-cost、`crate::sole_user`）。
//!
//! 初回設定のルートは共通の `banto_server::routes::extra_auth_router` に
//! あるので、その外側に重ねるミドルウェアで、設定が成功したとき（呼ぶ前は
//! 未初期化、応答が成功、いまアカウントが1件）だけ、その管理者に能力を
//! すべて付けて監査に残す。Tauri の `setup_body` と同じ判断。

use axum::extract::{Request, State};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::Response;
use banto_admin_services::authz::AuthzService;
use serde_json::json;

use crate::audit::{AuditEntry, AuditLogService};
use crate::sole_user::{grant_initial_capabilities, sole_account};
use crate::users::UsersService;

#[derive(Clone)]
pub(super) struct FirstSetupState {
    pub users: UsersService,
    pub authz: AuthzService,
    pub audit: AuditLogService,
}

pub(super) async fn grant_after_first_setup(
    State(state): State<FirstSetupState>,
    request: Request,
    next: Next,
) -> Response {
    let is_setup = request.method() == Method::POST && request.uri().path() == "/api/auth/setup";
    // 判定に失敗したら付けない（設定そのものは妨げない）。
    let was_initialized = if is_setup {
        state.users.is_initialized().await.unwrap_or(true)
    } else {
        true
    };
    let response = next.run(request).await;
    if was_initialized || !response.status().is_success() {
        return response;
    }
    // 応答が成功でも本文は `success:false` のことがある（既に初期化済み）。
    // その場合は呼ぶ前の未初期化の判定と食い違うので、アカウントが1件の
    // ときだけ付ける（能力が既にあれば付けない）。
    let owner = match sole_account(&state.users).await {
        Ok(Some(owner)) => owner,
        Ok(None) => return response,
        Err(err) => {
            eprintln!("banto: 初回設定後のアカウントの読み取りに失敗しました: {err}");
            return response;
        }
    };
    match grant_initial_capabilities(&state.authz, owner.id).await {
        Ok(Some(capabilities)) => {
            state
                .audit
                .record(AuditEntry {
                    actor_username: Some(&owner.username),
                    actor_role: Some(owner.role.as_str()),
                    action: "update",
                    resource: "capabilities",
                    entity_id: Some(&owner.id.to_string()),
                    detail: Some(json!({ "capabilities": capabilities, "reason": "setup" })),
                    origin: "rest",
                    result: "ok",
                })
                .await;
        }
        Ok(None) => {}
        Err(err) => eprintln!("banto: 初回設定後の能力の付与に失敗しました: {err}"),
    }
    response
}
