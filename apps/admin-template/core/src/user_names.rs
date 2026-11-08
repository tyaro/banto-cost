//! The id + display name of every account, for the business pickers
//! (案件の責任者・月額固定原価の社員, banto-cost). The user-management list
//! (`UsersService::list_users`) is admin-only and carries the login name and
//! role; a business user only needs to pick a person, so this narrows it to
//! the two fields. Both wiring layers guard it with `ViewMasters` (or the
//! `admin` role), like the other masters.

use banto_admin_services::users::UsersService;
use banto_core::BantoError;
use serde::Serialize;

/// One account as a business picker shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserName {
    pub id: i64,
    pub display_name: String,
}

/// Every account, by display name then id. No login name, role or dates.
pub async fn user_names(users: &UsersService) -> Result<Vec<UserName>, BantoError> {
    let mut names: Vec<UserName> = users
        .list_users()
        .await?
        .into_iter()
        .map(|user| UserName {
            id: user.id,
            display_name: user.display_name,
        })
        .collect();
    names.sort_by(|a, b| a.display_name.cmp(&b.display_name).then(a.id.cmp(&b.id)));
    Ok(names)
}
