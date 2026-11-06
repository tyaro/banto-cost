//! RBAC role vocabulary (spec M10 RBAC, `docs/roadmap.md`): the three fixed
//! privilege levels shared by every Banto admin surface.
//!
//! This type used to live in `admin-template-core::users`. It moved here in
//! theme C PR-C1 because [`crate::settings::SettingsService`]'s
//! `AuthSettings.disabled_role` is a `Role`, and settings moved to this crate
//! ahead of `users` (§7 移行順 ①): the shared vocabulary a moved service
//! depends on has to live at or below it in the dependency graph, never above
//! (conventions §"逆依存禁止"). `admin-template-core::users` re-exports it
//! (`pub use banto_admin_services::Role`) so `admin_template_core::users::Role`
//! keeps resolving unchanged for the REST role-guard middleware and the
//! Tauri `require_role` call sites. When `users` itself moves (a later PR),
//! this can fold back in alongside it.

use std::fmt;
use std::str::FromStr;

use banto_core::BantoError;
use serde::{Deserialize, Serialize};

/// Account role (spec M10 RBAC, `docs/roadmap.md`): three fixed levels,
/// `viewer` < `editor` < `admin`, each a superset of the previous one's
/// permissions. Stored as lowercase TEXT in the `users.role` column
/// (migration `0004_user_roles.sql`, which also `CHECK`s the DB-side set of
/// allowed values) and travels over the wire the same way (`#[serde(rename_all
/// = "lowercase")]`), so this is the single place both the DB round-trip and
/// the JSON wire shape agree on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Editor,
    Viewer,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Editor => "editor",
            Role::Viewer => "viewer",
        }
    }

    /// Total order used by [`Role::at_least`]: `viewer` is the least
    /// privileged, `admin` the most.
    fn rank(&self) -> u8 {
        match self {
            Role::Viewer => 0,
            Role::Editor => 1,
            Role::Admin => 2,
        }
    }

    /// Is this role at least as privileged as `min`? The core RBAC
    /// predicate every role guard (REST middleware, Tauri's `require_role`)
    /// is built on.
    pub fn at_least(&self, min: Role) -> bool {
        self.rank() >= min.rank()
    }

    /// `editor` or `admin` - resources' create/update/delete (spec M10:
    /// "editor: + create/update/delete").
    pub fn can_write_resources(&self) -> bool {
        self.at_least(Role::Editor)
    }

    pub fn is_admin(&self) -> bool {
        matches!(self, Role::Admin)
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Role {
    type Err = BantoError;

    /// Parses the lowercase DB/wire representation. Used both to read the
    /// `role` TEXT column back out of SQLite and (in `admin-template-core::rest`)
    /// to turn a bearer token's `Identity.role` string back into a typed
    /// `Role` for the REST role-guard middleware. An unrecognized value is a
    /// `BantoError::Other` (not `Validation`): it does not correspond to any
    /// particular request field at either call site.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "admin" => Ok(Role::Admin),
            "editor" => Ok(Role::Editor),
            "viewer" => Ok(Role::Viewer),
            other => Err(BantoError::Other(format!("不明なロールです: {other}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_as_str_and_from_str_round_trip() {
        for role in [Role::Admin, Role::Editor, Role::Viewer] {
            assert_eq!(Role::from_str(role.as_str()).unwrap(), role);
        }
    }

    #[test]
    fn role_from_str_rejects_unknown_values() {
        assert!(Role::from_str("superuser").is_err());
    }

    #[test]
    fn role_at_least_orders_viewer_editor_admin() {
        assert!(Role::Admin.at_least(Role::Admin));
        assert!(Role::Admin.at_least(Role::Editor));
        assert!(Role::Admin.at_least(Role::Viewer));
        assert!(Role::Editor.at_least(Role::Editor));
        assert!(Role::Editor.at_least(Role::Viewer));
        assert!(!Role::Editor.at_least(Role::Admin));
        assert!(Role::Viewer.at_least(Role::Viewer));
        assert!(!Role::Viewer.at_least(Role::Editor));
        assert!(!Role::Viewer.at_least(Role::Admin));
    }

    #[test]
    fn can_write_resources_is_editor_and_above() {
        assert!(Role::Admin.can_write_resources());
        assert!(Role::Editor.can_write_resources());
        assert!(!Role::Viewer.can_write_resources());
    }

    #[test]
    fn is_admin_is_admin_only() {
        assert!(Role::Admin.is_admin());
        assert!(!Role::Editor.is_admin());
        assert!(!Role::Viewer.is_admin());
    }
}
