use super::*;

use banto_admin_services::system_info::SystemInfoService;
// Re-exported (not just `use`d) so `banto_server::routes::SystemMetrics` is a
// valid path for callers building a `MetricsProbe` closure or a test stub
// (ADR-0013, Issue #185) - this crate has no `sysinfo` dependency of its own
// and never constructs a `SystemMetrics` itself, but its wire struct carries
// one.
pub use banto_admin_services::system_metrics::SystemMetrics;

// --- System Info (M-review 2026-08 §2.4「縮小版⑤」) --------------------------

/// Admin-only system diagnostics payload (`GET /api/system/info`). Read-only,
/// so it is never audited (conventions §1). `camelCase` on the wire to match
/// the frontend `SystemInfo` interface and the symmetric `system_info` Tauri
/// command's serialized shape.
///
/// The DB-derived fields come from [`SystemInfoService::probe`]; the rest are
/// assembled by this wiring layer: `app_version` is the compiled-in Banto
/// version (uniform across the workspace's `version.workspace = true` crates),
/// `uptime_secs` is measured from server start, and `active_sessions` is the
/// LAN bearer-token count (see the field docs).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// Compiled-in Banto version (`env!("CARGO_PKG_VERSION")`).
    pub app_version: &'static str,
    /// SQL dialect of the live DB handle: `"sqlite"` or `"postgres"`.
    pub db_dialect: &'static str,
    /// Round-trip latency of a `SELECT 1` probe, in milliseconds.
    pub db_latency_ms: f64,
    /// Highest applied migration version, or `null` if unreadable.
    pub migration_version: Option<i64>,
    /// Seconds since this server started serving (router build time).
    pub uptime_secs: u64,
    /// Active LAN bearer sessions (see [`AuthState::session_count`] - an upper
    /// bound; expired-but-not-yet-swept tokens are still counted). This counts
    /// the embedded/LAN server's tokens, not the desktop webview session.
    pub active_sessions: usize,
    /// Total logical attachment size in bytes, or `null` when the optional
    /// attachments feature is absent / unreadable.
    pub attachment_bytes: Option<i64>,
    /// Host/process CPU and memory (ADR-0013, Issue #185), or `null` when
    /// the `system-metrics` feature is off on the wiring crate, or the host
    /// platform is unsupported by `sysinfo`. This router does not know about
    /// that feature at all (see [`MetricsProbe`]/[`system_info_router`]'s
    /// doc comments) - `null` here just means the caller passed no probe.
    pub metrics: Option<SystemMetrics>,
}

/// A synchronous, best-effort CPU/memory sampler closure (ADR-0013, Issue
/// #185: `banto_admin_services::system_metrics::SystemMetricsSampler::sample`,
/// type-erased so this crate - which does NOT depend on `sysinfo` and does
/// not know about the `system-metrics` feature - can still accept one).
/// `Arc`-wrapped so [`system_info`]'s handler can cheaply clone it into a
/// `tokio::task::spawn_blocking` closure (the sampler's `sample()` is
/// synchronous, blocking I/O - see that method's doc comment).
///
/// The app layer (`banto-serve` / `src-tauri`) builds this behind its OWN
/// `#[cfg(feature = "system-metrics")]` and passes `None` when the feature is
/// off; this router just calls whatever it is handed, or nothing at all.
pub type MetricsProbe = std::sync::Arc<dyn Fn() -> Option<SystemMetrics> + Send + Sync>;

/// State for the `/api/system/info` handler: the DB-probe service, the
/// [`AuthState`] whose live token count is reported, and the server-start
/// [`Instant`](std::time::Instant) uptime is measured from.
#[derive(Clone)]
struct SystemInfoState {
    service: SystemInfoService,
    auth: AuthState,
    started_at: std::time::Instant,
    /// `Some` when the app layer built a `SystemMetricsSampler`
    /// (`banto_admin_services::system_metrics`, `system-metrics` feature on,
    /// ADR-0013); `None` degrades `metrics` to `null` in the response. Not an
    /// intra-doc link: that type only exists when the OTHER crate's optional
    /// feature is enabled, which this crate does not control.
    metrics: Option<MetricsProbe>,
}

/// `GET /api/system/info` (admin-only): assemble the diagnostics payload.
/// Read-only - records nothing (conventions §1). A DB that cannot answer the
/// liveness probe surfaces as an error; the best-effort fields degrade to
/// `null` inside [`SystemInfoService::probe`].
async fn system_info(State(state): State<SystemInfoState>) -> Result<Json<SystemInfo>, ApiError> {
    let probe = state.service.probe().await?;

    // ADR-0013: `sample()` is synchronous, blocking I/O (a `/proc` read or a
    // handful of Win32/Mach calls) - never call it directly on this async
    // handler's thread. The probe is an `Arc`, so cloning it into the
    // blocking closure is cheap; `spawn_blocking`'s `JoinError` (task panic)
    // is the one genuinely exceptional case here, mapped to `BantoError::Other`
    // same as other infra-level failures in this crate.
    let metrics = match state.metrics.clone() {
        Some(probe_fn) => tokio::task::spawn_blocking(move || probe_fn())
            .await
            .map_err(|err| BantoError::Other(err.to_string()))?,
        None => None,
    };

    Ok(Json(SystemInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        db_dialect: probe.dialect,
        db_latency_ms: probe.db_latency_ms,
        migration_version: probe.migration_version,
        uptime_secs: state.started_at.elapsed().as_secs(),
        active_sessions: state.auth.session_count(),
        attachment_bytes: probe.attachment_bytes,
        metrics,
    }))
}

/// `/api/system/info` (M-review 2026-08 §2.4): `admin`-only, guarded the same
/// way `audit_log_router`/`users_router` are (`require_auth` then
/// `require_role_at_least` at the `Admin` floor). `uptime_secs` is measured
/// from this router's construction, which for both vehicles is server start
/// (`banto-serve` main / the embedded LAN server's `start_embedded_server`).
///
/// Needs an [`AuditLogService`] handle purely so [`RoleGuard`] can record a
/// denial when a non-admin hits the route; the read handler itself audits
/// nothing.
///
/// `metrics` (ADR-0013, Issue #185) is the sole way `system-metrics` reaches
/// this crate: this router does NOT depend on `sysinfo` and does not know
/// whether that feature is compiled in anywhere - the app layer
/// (`banto-serve` / `src-tauri`) decides that under its own
/// `#[cfg(feature = "system-metrics")]` and passes `Some(probe)` or `None`
/// accordingly. `None` (feature off, or an app that never wires one) simply
/// serializes `SystemInfo::metrics` as `null` - a purely additive wire change
/// (ADR-0013's "後方互換" note).
pub fn system_info_router(
    service: SystemInfoService,
    auth: AuthState,
    audit: AuditLogService,
    metrics: Option<MetricsProbe>,
) -> Router {
    let state = SystemInfoState {
        service,
        auth: auth.clone(),
        started_at: std::time::Instant::now(),
        metrics,
    };
    Router::new()
        .route("/api/system/info", get(system_info))
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "system",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
