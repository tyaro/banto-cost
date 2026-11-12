//! 1人で使う間の扱い（banto-cost、2026-11-12 ユーザー決定）。
//!
//! - アカウントが1件だけの間、デスクトップ版は起動時にその本人としてログイン
//!   する（パスワードを聞かない）。2件目を追加するとログインが必要になる。
//!   LAN のブラウザは対象外（常にログイン）。判定は [`sole_account`]。
//! - 初回の設定で作った管理者には業務の能力をすべて付ける
//!   （[`grant_initial_capabilities`]）。REST・Tauri の両方の初回設定から呼ぶ。
//!
//! このモジュールは呼び出し元・権限を知らない（conventions §2）。監査は
//! 呼び出し側が残す。

use banto_admin_services::authz::{AuthzService, Capability};
use banto_core::BantoError;

use crate::users::{UserIdentity, UsersService};

/// アカウントがちょうど1件ならその現在の行、0件・2件以上なら `None`。
pub async fn sole_account(users: &UsersService) -> Result<Option<UserIdentity>, BantoError> {
    let list = users.list_users().await?;
    match list.as_slice() {
        [only] => users.get_by_username(&only.username).await,
        _ => Ok(None),
    }
}

/// 初回の設定で作った管理者 `user_id` に能力をすべて付ける。既に何か付いて
/// いれば何もしない（`None`）。付けたときは付けた能力を返す（監査用）。
pub async fn grant_initial_capabilities(
    authz: &AuthzService,
    user_id: i64,
) -> Result<Option<Vec<Capability>>, BantoError> {
    if !authz.capabilities(user_id).await?.is_empty() {
        return Ok(None);
    }
    authz
        .set_capabilities(user_id, &Capability::ALL)
        .await
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::users::Role;

    async fn services() -> (UsersService, AuthzService) {
        let db = crate::db::init_db_memory()
            .await
            .expect("in-memory DB with migrations");
        (UsersService::new(db.clone()), AuthzService::new(db))
    }

    #[tokio::test]
    async fn sole_account_is_the_only_account_and_none_otherwise() {
        let (users, _) = services().await;
        assert_eq!(sole_account(&users).await.unwrap(), None);

        let owner = users
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        assert_eq!(sole_account(&users).await.unwrap(), Some(owner.clone()));

        let second = users
            .create_user("worker", "password123", "作業者", Role::Editor)
            .await
            .unwrap();
        assert_eq!(sole_account(&users).await.unwrap(), None);

        users.delete_user(second.id, Some(owner.id)).await.unwrap();
        assert_eq!(sole_account(&users).await.unwrap(), Some(owner));
    }

    #[tokio::test]
    async fn initial_capabilities_are_all_once_and_never_overwrite() {
        let (users, authz) = services().await;
        let owner = users
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();

        let granted = grant_initial_capabilities(&authz, owner.id).await.unwrap();
        let mut all = Capability::ALL.to_vec();
        all.sort();
        assert_eq!(granted, Some(all.clone()));
        assert_eq!(authz.capabilities(owner.id).await.unwrap(), all);

        // 利用者が減らした後は付け直さない。
        authz
            .set_capabilities(owner.id, &[Capability::TimeEntry])
            .await
            .unwrap();
        assert_eq!(
            grant_initial_capabilities(&authz, owner.id).await.unwrap(),
            None
        );
        assert_eq!(
            authz.capabilities(owner.id).await.unwrap(),
            vec![Capability::TimeEntry]
        );
    }
}
