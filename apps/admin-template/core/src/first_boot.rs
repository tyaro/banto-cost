//! First-boot settings seed (display-preset-plan.md D1-a, Issue #190 prep):
//! a generic mechanism, empty by default, so behavior does not change for
//! today's template. A derived app (or a future `scripts/scaffold.mjs
//! --preset display`, plan §3.2) fills [`FIRST_BOOT_SETTINGS`] with the
//! pairs it wants applied on a genuinely fresh database - e.g.
//! `("auth.disabled", "true")`, `("server.viewer_public", "true")` for a
//! kiosk/display app that should be usable the moment it is copied, with no
//! setup screen.
//!
//! This module only ever WRITES through [`SettingsService::set`] (conventions
//! §2: no tauri/axum/RBAC knowledge here) and only when the `settings` table
//! is empty - an existing install (any row already present, even an
//! unrelated one) is left untouched.

use banto_core::BantoError;

use crate::settings::SettingsService;

/// App-level hook: the `(key, value)` pairs to seed on a fresh install.
/// Empty by default (today's behavior: no seed). A derived app edits this
/// list directly; `scripts/scaffold.mjs --preset display` (plan §3.2)
/// reverses it to a non-empty default in the scaffolded copy only - the
/// template itself always ships with an empty list.
///
/// Wrapped in scaffold-anchor markers so the preset's editor can swap the
/// list body without needing a fuzzy diff.
// [scaffold:first-boot-settings] begin
pub const FIRST_BOOT_SETTINGS: &[(&str, &str)] = &[];
// [scaffold:first-boot-settings] end

/// Seed [`FIRST_BOOT_SETTINGS`] into `settings` if (and only if) the table is
/// currently empty. Returns `Ok(true)` if it wrote anything, `Ok(false)` if
/// it was a no-op (table already has rows, or the const is empty).
///
/// Called once at startup, before any `auth_config`/`server_config` read, by
/// both entry points (`bin/banto-serve.rs` and `src-tauri/src/lib.rs`
/// `run()`), so a seeded `auth.disabled = true` (say) takes effect on the
/// very first launch rather than one launch late.
pub async fn seed_first_boot_settings(settings: &SettingsService) -> Result<bool, BantoError> {
    seed_with(settings, FIRST_BOOT_SETTINGS).await
}

/// Thin wrapper's actual logic, parametrized over the pair list so tests can
/// exercise the "non-empty list" path without mutating the real
/// [`FIRST_BOOT_SETTINGS`] constant.
async fn seed_with(settings: &SettingsService, pairs: &[(&str, &str)]) -> Result<bool, BantoError> {
    if pairs.is_empty() {
        return Ok(false);
    }
    if !settings.is_empty().await? {
        return Ok(false);
    }
    for (key, value) in pairs {
        settings.set(key, value).await?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn service() -> SettingsService {
        let db = banto_storage::Db::connect_sqlite_memory()
            .await
            .expect("connect in-memory sqlite");
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(
                db.as_sqlite()
                    .expect("first_boot tests run on a SQLite handle"),
            )
            .await
            .expect("create settings table");
        SettingsService::new(db)
    }

    #[tokio::test]
    async fn seeding_is_a_no_op_on_an_empty_const() {
        let settings = service().await;
        let wrote = seed_with(&settings, &[]).await.unwrap();
        assert!(!wrote);
        assert!(settings.is_empty().await.unwrap());
    }

    #[tokio::test]
    async fn seeding_writes_pairs_when_the_table_is_empty() {
        let settings = service().await;
        let pairs: &[(&str, &str)] = &[("auth.disabled", "true"), ("server.viewer_public", "true")];
        let wrote = seed_with(&settings, pairs).await.unwrap();
        assert!(wrote);
        assert_eq!(
            settings.get("auth.disabled").await.unwrap(),
            Some("true".to_string())
        );
        assert_eq!(
            settings.get("server.viewer_public").await.unwrap(),
            Some("true".to_string())
        );
    }

    #[tokio::test]
    async fn seeding_is_a_no_op_when_the_table_already_has_a_row() {
        let settings = service().await;
        settings.set("unrelated", "1").await.unwrap();
        let pairs: &[(&str, &str)] = &[("auth.disabled", "true")];
        let wrote = seed_with(&settings, pairs).await.unwrap();
        assert!(!wrote);
        assert_eq!(settings.get("auth.disabled").await.unwrap(), None);
    }

    #[tokio::test]
    async fn second_call_is_a_no_op() {
        let settings = service().await;
        let pairs: &[(&str, &str)] = &[("auth.disabled", "true")];
        assert!(seed_with(&settings, pairs).await.unwrap());

        // Second call sees a non-empty table now and must not re-run/overwrite.
        settings.set("auth.disabled", "false").await.unwrap();
        let wrote_again = seed_with(&settings, pairs).await.unwrap();
        assert!(!wrote_again);
        assert_eq!(
            settings.get("auth.disabled").await.unwrap(),
            Some("false".to_string())
        );
    }

    #[tokio::test]
    async fn seed_first_boot_settings_is_a_no_op_with_todays_empty_const() {
        let settings = service().await;
        let wrote = seed_first_boot_settings(&settings).await.unwrap();
        assert!(!wrote);
    }
}
