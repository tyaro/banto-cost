//! Banto admin services (docs/template-scope.md §7, theme C PR-C1): the
//! domain-agnostic (`items`-free) slice of what used to live entirely in
//! `admin-template-core`'s service layer. Moving it here shrinks the surface
//! a template adopter has to copy-and-maintain: this crate is a normal
//! workspace dependency (`admin-template-core` depends ON it, like it already
//! depends on `banto-storage`), not code the adopter owns.
//!
//! PR-C1 moved the two most self-contained services (settings, audit) plus
//! the shared RBAC [`Role`] vocabulary they need (`SettingsService`'s
//! `AuthSettings.disabled_role` is a `Role`). PR-C2 (§7 移行順 ②) adds
//! [`users`] (`UsersService`, M10 RBAC), the RBAC-central service with the
//! most REST/Tauri test coverage. It uses the same [`Role`], which was left
//! in place in [`rbac`] and re-exported from [`users`] (minimal churn - the
//! type did not need to move again now that both live in this crate). PR-C3
//! (§7 移行順 ③) adds [`backup`] (`BackupService`, M17), the I/O-heavy
//! (`VACUUM INTO`/`PRAGMA`/startup file-swap) SQLite-only service; it stays
//! SQLite-only (theme A PR4: a Postgres handle yields an explicit error, never
//! a panic). The REST router moves in a later PR.
//!
//! [`system_metrics`] (ADR-0013, Issue #185) adds host/process CPU and memory
//! sampling behind the opt-in `system-metrics` feature (`sysinfo`, feature
//! `["system"]` only) - a deliberate exception to §3's "add no dependency"
//! stance, see the ADR for the alternatives considered.
//!
//! Like every Banto service (conventions §2), the services here take a
//! `banto_storage::Db` handle, return `Result<_, banto_core::BantoError>`,
//! and know nothing about `axum`/`tauri`/RBAC/HTTP - authorization, audit,
//! and event notification are added by the REST/Tauri wiring layer in
//! `admin-template-core`. This crate deliberately does NOT depend on `axum`
//! or `tauri` (verified by `scripts/verify-architecture.mjs` rule 1).
//!
//! Table ownership stays with the app (conventions §11): this crate owns no
//! migrations. `settings`/`audit_log` DDL lives in `admin-template-core`'s
//! `migrations-{sqlite,postgres}/`; the unit tests here re-state the same
//! `CREATE TABLE` inline (see each module's test helper), the same pattern
//! `banto-attachments` uses to avoid a backwards dependency on the app crate.

pub mod audit;
pub mod backup;
pub mod rbac;
pub mod settings;
pub mod system_info;
pub mod system_metrics;
pub mod users;

pub use rbac::Role;
