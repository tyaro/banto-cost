//! admin-template's domain/service layer (spec §10). Kept tauri-free so it
//! is testable without the src-tauri crate (which cannot be built in every
//! environment, e.g. CI containers without webkit2gtk). Thin
//! `tauri::command` adapters in `src-tauri` call into this crate; the same
//! services back the embedded REST server in M6.

pub mod approval;
pub mod assets;
pub mod budgets;
pub mod business_date;
pub mod calc_basis;
pub mod closeouts;
pub mod closing;
pub mod cost_access;
pub mod customers;
pub mod db;
pub mod direct_costs;
pub mod events;
pub mod first_boot;
pub mod fixed_costs;
pub mod forecasts;
pub mod ops;
pub mod orders;
pub mod pipeline;
pub mod portfolio;
pub mod projects;
pub mod recurring_revenue;
pub mod reports;
pub mod rest;
pub mod sole_user;
pub mod time_access;
pub mod time_entries;
pub mod user_names;
pub mod work_masters;

// Theme C (docs/template-scope.md §7): the domain-agnostic services moved to
// the shared `banto-admin-services` crate to shrink the surface a template
// adopter copy-maintains. PR-C1 移行順 ① moved settings/audit; PR-C2 移行順 ②
// moved `users` (`UsersService`, M10 RBAC); PR-C3 移行順 ③ moved `backup`
// (`BackupService`, M17, SQLite-only). Re-exported here so existing
// `crate::{settings,audit,users,backup}::*` paths - REST wiring, `src-tauri`
// commands, `bin/banto-serve.rs` (startup `apply_pending_restore_at_startup`),
// other services, and `admin_template_core::users::{UsersService, Role, ...}` -
// resolve unchanged: the services' location changed, not the REST/Tauri
// exposure (conventions §1 両経路対称は不変).
pub use banto_admin_services::{
    audit, authz, backup, settings, system_info, system_metrics, users,
};
