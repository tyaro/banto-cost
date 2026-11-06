//! Standalone dev server for the embedded-server milestone (spec §11): runs
//! the full REST + static stack WITHOUT Tauri, so it can be exercised in
//! any environment - including this repo's containers, which cannot build
//! the `src-tauri` crate because they lack webkit2gtk. This is also a
//! user-facing way to preview LAN mode before the settings-screen toggle
//! (Phase B) wires it into the Tauri app itself.
//!
//! This binary always builds (bins cannot be feature-gated the way a
//! library module can); whether it serves the real frontend or the
//! built-in placeholder page depends on the `embed-ui` feature on
//! `admin_template_core::assets::FrontendAssets`, which is applied
//! internally - this file does not need its own `#[cfg(feature = ...)]`.
//!
//! ```text
//! pnpm --filter admin-template build   # produces apps/admin-template/build
//! cargo run -p admin-template-core --bin banto-serve --features embed-ui
//! ```
//!
//! (Omit `--features embed-ui` to serve the built-in placeholder page
//! instead of the real frontend build - useful for exercising the REST API
//! alone.)
//!
//! Env vars: `PORT` (default `8721`), `BANTO_BIND` (default `0.0.0.0`, so
//! the LAN-access URLs printed at startup are actually reachable - the
//! Tauri app's default of `127.0.0.1`-only is a setting applied at the
//! settings-screen layer, Phase B, not a property of this dev vehicle),
//! `BANTO_DB` (default `./banto-dev.sqlite3`; a `postgres://`/`postgresql://`
//! URL selects the PostgreSQL backend instead of a SQLite file - the binary
//! must be built `--features postgres` for that to link),
//! `BANTO_ATTACHMENTS_DIR` (required when `BANTO_DB` is PostgreSQL: the root
//! under which each database gets its own attachments subdirectory, Issue
//! #208; ignored for SQLite, whose attachments stay next to the DB file),
//! `BANTO_ALLOW_SETUP` (`1` to
//! enable `POST /api/auth/setup`; unset/anything else keeps it `403`'d, spec
//! §8.2 - the Tauri app never sets this, since desktop first-run goes
//! through the `auth_setup` command instead), `BANTO_VIEWER_PUBLIC` (`1` to
//! seed `server.viewer_public = true` at startup so LAN clients may mint a
//! viewer-public grant session through `POST /api/auth/grant/publicViewer`
//! without logging in - Issue #189, `docs/design/viewer-public-plan.md` §3.1-5,
//! ADR-0012; grants in general: ADR-0017).
//!
//! `BANTO_VIEWER_PUBLIC` is a dev/e2e entry point in the same spirit as
//! `BANTO_ALLOW_SETUP`: it WRITES the persisted setting (rather than
//! overriding it per-process) because the flag is read live from
//! `SettingsService` by `/api/auth/status` and `/api/auth/grant/publicViewer`, so
//! there is nowhere else for a process-local override to live. Unsetting the
//! variable therefore does NOT turn 閲覧公開 back off - use the settings
//! screen, or a fresh DB. It only ever sets the one flag; `server.enabled`
//! and the bind/port keys are left exactly as they were.
//!
//! `--features system-metrics` (ON by default, ADR-0013, Issue #185): wires a
//! `SystemMetricsSampler` into the System Info card's `metrics` field. Off
//! (`--no-default-features`), or on an unsupported host, `metrics` is `null`.

use admin_template_core::assets::FrontendAssets;
use admin_template_core::audit::{AuditEntry, AuditLogService};
use admin_template_core::backup::BackupService;
use admin_template_core::db::{display_target, init_db_from_target, is_postgres_url};
use admin_template_core::events::event_channel;
use admin_template_core::first_boot::seed_first_boot_settings;
use admin_template_core::rest::{api_router, user_auth_state, Services};
use admin_template_core::settings::{ServerSettings, SettingsService};
use admin_template_core::system_info::SystemInfoService;
#[cfg(feature = "system-metrics")]
use admin_template_core::system_metrics::SystemMetricsSampler;
use admin_template_core::users::UsersService;
use banto_server::{lan_urls_for_bind, start, static_router, with_security_headers, ServerConfig};
use std::path::PathBuf;

const DEFAULT_PORT: u16 = 8721;
const DEFAULT_BIND: &str = "0.0.0.0";
const DEFAULT_DB_PATH: &str = "./banto-dev.sqlite3";

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let bind = std::env::var("BANTO_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let db_path = std::env::var("BANTO_DB").unwrap_or_else(|_| DEFAULT_DB_PATH.to_string());
    let allow_setup = std::env::var("BANTO_ALLOW_SETUP")
        .map(|value| value == "1")
        .unwrap_or(false);
    let seed_viewer_public = std::env::var("BANTO_VIEWER_PUBLIC")
        .map(|value| value == "1")
        .unwrap_or(false);

    let db_path_buf = PathBuf::from(&db_path);

    // Apply any staged restore (spec M17) BEFORE `init_db`/the pool is
    // created - see `BackupService::apply_pending_restore_at_startup`'s doc
    // comment for why this must run first. Best-effort at the top level:
    // a failure here must not prevent the server from starting at all (the
    // old db, if any, is left untouched on error - see that function's
    // per-step safety notes).
    //
    // V2 (backup owner decision D3): the startup restore is a SQLite-file-only
    // concept. When `BANTO_DB` is a `postgres://`/`postgresql://` URL the whole
    // backend is Postgres, so there is no db FILE to swap and `db_path` is a
    // connection string, not a path - skip entirely rather than let it probe
    // for a `restore-pending.sqlite3` next to a URL. The same
    // `db::is_postgres_url` rule drives `init_db_from_target` below, so the two
    // never disagree on which backend is in play.
    let applied_restore = if is_postgres_url(&db_path) {
        None
    } else {
        match BackupService::apply_pending_restore_at_startup(&db_path_buf).await {
            Ok(applied) => applied,
            Err(err) => {
                eprintln!("banto-serve: 起動時のリストア適用に失敗しました: {err}");
                None
            }
        }
    };

    // V2 PR3: `init_db_from_target` selects the backend from `BANTO_DB`'s
    // value - a `postgres://`/`postgresql://` URL runs on PostgreSQL, anything
    // else is a SQLite file path (the default). Either way it returns a
    // backend-agnostic `banto_storage::Db`; every service constructor takes
    // `Db`. (The staged-restore step above is SQLite-file-only; against a
    // Postgres target `db_path_buf` simply names no pending-restore file.)
    let db = init_db_from_target(&db_path)
        .await
        .expect("init_db should succeed");

    let events = event_channel();
    let users = UsersService::new(db.clone());
    let settings = SettingsService::new(db.clone());
    // D1-a (display-preset-plan.md, Issue #190 prep): seed
    // `FIRST_BOOT_SETTINGS` before any `auth_config`/`server_config` read
    // below, so a display-preset app's seeded `auth.disabled = true` (say)
    // takes effect on the very first launch. No-op today: the const ships
    // empty.
    match seed_first_boot_settings(&settings).await {
        Ok(true) => println!("banto-serve: 初回起動の既定設定を書き込みました"),
        Ok(false) => {}
        Err(err) => eprintln!("banto-serve: 初回起動の既定設定の書き込みに失敗しました: {err}"),
    }
    let backup = BackupService::new(db_path_buf.clone(), db.clone());

    let system_info = SystemInfoService::new(db.clone());
    let authz = admin_template_core::authz::AuthzService::new(db.clone());
    let customers = admin_template_core::customers::CustomersService::new(db.clone())
        .with_events(events.clone());
    let projects =
        admin_template_core::projects::ProjectsService::new(db.clone()).with_events(events.clone());
    let pipeline =
        admin_template_core::pipeline::PipelineService::new(db.clone()).with_events(events.clone());
    let orders =
        admin_template_core::orders::OrdersService::new(db.clone()).with_events(events.clone());
    let calc_basis = admin_template_core::calc_basis::CalcBasisService::new(db.clone());
    // ADR-0013 (Issue #185): the sampler is stateful (CPU% needs a delta
    // between refreshes, see `SystemMetricsSampler::sample`'s doc comment),
    // so it is built once here and shared - same lifetime as `system_info`
    // above. Type-erased into a `MetricsProbe` closure because
    // `admin_template_core::rest::Services`/`banto_server::routes::system_info_router`
    // do not depend on `sysinfo` and do not know this feature exists.
    #[cfg(feature = "system-metrics")]
    let metrics: Option<banto_server::routes::MetricsProbe> = {
        let sampler = SystemMetricsSampler::new();
        Some(std::sync::Arc::new(move || sampler.sample()))
    };
    #[cfg(not(feature = "system-metrics"))]
    let metrics: Option<banto_server::routes::MetricsProbe> = None;
    let audit = AuditLogService::new(db);
    // Credential verifier from `admin_template_core::rest` (spec §8.2),
    // backed by `UsersService`'s argon2id-hashed accounts - replaces the old
    // fixed admin/admin check that used to live here directly. Also records
    // `login`/`login_failed` audit entries (spec M14), and re-checks the
    // account on every request so deleting/demoting/re-keying it ends its
    // sessions (Issue #204).
    let auth = user_auth_state(users.clone(), audit.clone());

    // Spec M17: record `restore_applied` now that a real `AuditLogService`
    // exists - `apply_pending_restore_at_startup` itself cannot do this (it
    // runs before any pool/audit service exists at all).
    if let Some(applied) = applied_restore {
        audit
            .record(AuditEntry {
                actor_username: None,
                actor_role: None,
                action: "restore_applied",
                resource: "backups",
                entity_id: None,
                detail: Some(serde_json::json!({
                    "preRestoreBackupFileName": applied.pre_restore_backup_file_name,
                })),
                origin: "rest",
                result: "ok",
            })
            .await;
        println!(
            "banto-serve: 起動時にリストアを適用しました（適用前の自動バックアップ: {}）",
            applied.pre_restore_backup_file_name
        );
    }

    // Startup prune (spec M14: "サーバ起動時に1回 + list実行時に軽く" - see
    // `audit_log_list`'s doc comment in `rest.rs` for why no dedicated
    // background task is needed beyond this plus that opportunistic prune).
    // Best-effort: a prune failure here must not stop the server from
    // starting.
    match settings.audit_config().await {
        Ok(config) => {
            if let Err(err) = audit
                .prune(config.retention_days, config.retention_rows)
                .await
            {
                eprintln!("banto-serve: 起動時の監査ログの剪定に失敗しました: {err}");
            }
        }
        Err(err) => eprintln!("banto-serve: 監査ログの保持設定の読み取りに失敗しました: {err}"),
    }

    // Issue #189: seed 閲覧公開 when asked. Read-modify-write rather than
    // constructing a fresh `ServerSettings` so `enabled`/`bind`/`port`
    // (whatever a previous run or the settings screen persisted) survive - the
    // LAN listener this binary starts comes from `BANTO_BIND`/`PORT`, not from
    // these keys, so flipping `enabled` here would silently change what the
    // Tauri app does with the same DB. Best-effort, like the prune above: a
    // failure must not stop the server from starting.
    if seed_viewer_public {
        match settings.server_config().await {
            Ok(config) => {
                let seeded = ServerSettings {
                    viewer_public: true,
                    ..config
                };
                if let Err(err) = settings.set_server_config(&seeded).await {
                    eprintln!("banto-serve: 閲覧公開設定の保存に失敗しました: {err}");
                }
            }
            Err(err) => eprintln!("banto-serve: サーバー設定の読み取りに失敗しました: {err}"),
        }
    }

    // `with_security_headers` (spec improvements §2.4) wraps LAST/outermost
    // so every response - static UI, `/api/*` JSON, and SSE alike - gets
    // the baseline security headers, regardless of which inner router
    // produced it.
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
        metrics,
    };
    let app = with_security_headers(
        api_router(services, auth, events, allow_setup).merge(static_router::<FrontendAssets>()),
    );

    let server = start(
        ServerConfig {
            bind: bind.clone(),
            port,
        },
        app,
    )
    .await
    .expect("server should start");

    // Issue #208: never print the connection credentials.
    println!("banto-serve: DB at {}", display_target(&db_path));
    println!("banto-serve: listening at:");
    // Issue #216: scope the printed URLs to `bind` (a loopback `BANTO_BIND`
    // override must not print a LAN URL nobody outside this machine can
    // reach), same fix as the Tauri settings screen's `build_status`.
    for url in lan_urls_for_bind(&bind, server.local_addr().port()) {
        println!("  {url}");
    }
    if allow_setup {
        println!("banto-serve: first-run setup is ENABLED (BANTO_ALLOW_SETUP=1) - POST /api/auth/setup will create the first account");
    } else {
        println!(
            "banto-serve: first-run setup is DISABLED - set BANTO_ALLOW_SETUP=1 to allow POST /api/auth/setup"
        );
    }
    if seed_viewer_public {
        println!("banto-serve: public viewing is ENABLED (BANTO_VIEWER_PUBLIC=1) - POST /api/auth/grant/publicViewer will hand out anonymous viewer sessions");
    }
    println!("banto-serve: press Ctrl-C to stop");

    tokio::signal::ctrl_c()
        .await
        .expect("failed to listen for ctrl-c");
    println!("banto-serve: shutting down");
    server.stop().await;
}
