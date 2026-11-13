//! Authorized operations (判定つきの操作, review design-ux-data-review-2026-11
//! §5.2 F-1 / §8-13): the business steps that REST (`rest/*.rs`) and Tauri
//! (`src-tauri`) used to wire twice - choose the `Operation`, decide it
//! through `AuthzService::authorize_audited`, call the service, record the
//! success audit - written once here. Both paths keep only what differs
//! between them (conventions §1): the role floor (`RoleGuard` /
//! `require_role`, checked by `verify:architecture` rule 8), taking the
//! arguments apart, and naming the caller with its origin (`"rest"` /
//! `"tauri"`). So a test of a function here covers the decision of both
//! paths, which matters because `src-tauri` cannot be built everywhere and
//! has no integration tests of its own.
//!
//! The services stay free of callers and permissions (conventions §2); the
//! functions here are the only place that pairs a service call with its
//! `Operation` and audit detail. Reads are not audited (conventions §1),
//! only their denials, which `authorize_audited` records.
//!
//! Migrated so far: 精算完了 ([`closeouts`]), 月次締め ([`closing`]),
//! 月額固定原価 ([`fixed_costs`]), 定期売上 ([`recurring_revenue`]) - the
//! areas with the fewest operations, as the review proposed - then 予算
//! ([`budgets`]), 完了見込と全体一覧 ([`forecasts`]) and 帳票 ([`reports`]),
//! then 顧客・案件 ([`projects`]), 見込 ([`pipeline`]) and 計算基準
//! ([`calc_basis`]).

pub mod budgets;
pub mod calc_basis;
pub mod closeouts;
pub mod closing;
pub mod fixed_costs;
pub mod forecasts;
pub mod pipeline;
pub mod projects;
pub mod recurring_revenue;
pub mod reports;

use banto_admin_services::audit::{AuditEntry, AuditLogService};
use std::str::FromStr;

use banto_admin_services::authz::{
    amount_projects, visible_projects, Actor, Allowed, AuthzService, Operation, Policy,
    ProjectScope, Subject,
};
use banto_core::BantoError;

use crate::users::Role;

/// Who calls, as the path resolved it: the `users.id` (`None` for a session
/// with no user row, e.g. a grant session), the username and role snapshot
/// the audit log keeps, and the path (`"rest"` / `"tauri"`).
#[derive(Debug, Clone, Copy)]
pub struct Caller<'a> {
    pub user_id: Option<i64>,
    pub username: &'a str,
    pub role: &'a str,
    pub origin: &'static str,
}

/// The authorization and audit services with the caller: what every
/// operation here needs besides its own service.
#[derive(Clone, Copy)]
pub struct Gate<'a> {
    pub authz: &'a AuthzService,
    pub audit: &'a AuditLogService,
    pub caller: Caller<'a>,
}

impl Gate<'_> {
    /// Decide `op` with the default policy (a denial is audited).
    pub async fn check(&self, op: Operation, resource: &str) -> Result<Subject, BantoError> {
        let (subject, _) = self.check_with(op, Policy::default(), resource).await?;
        Ok(subject)
    }

    /// Decide `op` under `policy`, also returning the decision.
    pub async fn check_with(
        &self,
        op: Operation,
        policy: Policy,
        resource: &str,
    ) -> Result<(Subject, Allowed), BantoError> {
        let caller = self.caller;
        self.authz
            .authorize_audited(
                self.audit,
                Actor {
                    user_id: caller.user_id,
                    username: caller.username,
                    role: caller.role,
                },
                op,
                policy,
                resource,
                caller.origin,
            )
            .await
    }

    /// The success audit of a write, with the caller's origin.
    pub async fn record(
        &self,
        action: &str,
        resource: &str,
        entity_id: Option<&str>,
        detail: Option<serde_json::Value>,
    ) {
        let caller = self.caller;
        self.audit
            .record(AuditEntry {
                actor_username: Some(caller.username),
                actor_role: Some(caller.role),
                action,
                resource,
                entity_id,
                detail,
                origin: caller.origin,
                result: "ok",
            })
            .await;
    }

    /// Decide `op`, except that the `admin` role passes without a
    /// capability: the system administrator maintains masters and the
    /// projects' basic information (spec §4), never a check that shows
    /// amounts.
    pub async fn check_or_admin(&self, op: Operation, resource: &str) -> Result<(), BantoError> {
        if !self.is_admin() {
            self.check(op, resource).await?;
        }
        Ok(())
    }

    pub fn user_id(&self) -> Option<i64> {
        self.caller.user_id
    }

    /// Whether the caller holds the `admin` role.
    pub fn is_admin(&self) -> bool {
        Role::from_str(self.caller.role).is_ok_and(|role| role.is_admin())
    }

    /// The projects whose rows (basic information) the caller sees: every
    /// project for the `admin` role, `visible_projects` for the others.
    pub async fn visible_scope(&self) -> Result<ProjectScope, BantoError> {
        if self.is_admin() {
            return Ok(ProjectScope::All);
        }
        let subject = self.authz.subject(self.caller.user_id).await?;
        Ok(visible_projects(&subject))
    }

    /// The scopes of the overall list and the reports built from it
    /// (全体一覧): the rows are every project for the `admin` role and
    /// `visible_projects` for the others; amounts and alerts are
    /// `amount_projects` for everyone (no `Operation`, so nothing is denied
    /// or audited - the scope only narrows).
    pub async fn portfolio_scopes(&self) -> Result<(ProjectScope, ProjectScope), BantoError> {
        let subject = self.authz.subject(self.caller.user_id).await?;
        let visible = if self.is_admin() {
            ProjectScope::All
        } else {
            visible_projects(&subject)
        };
        Ok((visible, amount_projects(&subject)))
    }

    /// The projects whose amounts the caller sees (`amount_projects`).
    pub async fn amount_scope(&self) -> Result<ProjectScope, BantoError> {
        let subject = self.authz.subject(self.caller.user_id).await?;
        Ok(amount_projects(&subject))
    }
}

#[cfg(test)]
pub(crate) mod tests;
