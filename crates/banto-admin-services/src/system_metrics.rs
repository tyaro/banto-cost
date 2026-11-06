//! Host/process CPU and memory sampling (ADR-0013, Issue #185): the
//! `system-metrics`-feature half of the admin System Info card
//! (`docs/adr/0013-sysinfo-system-metrics-feature.md`; [`crate::system_info`]
//! is the DB-derived half). Unlike every other service in this crate, this is
//! not a [`banto_storage::Db`]-backed service - it wraps `sysinfo::System`
//! (feature-gated `["system"]` only, per the ADR's P1-5 ④) behind a stateful
//! sampler, because `sysinfo`'s CPU-usage figures are only meaningful as a
//! delta between two refreshes.
//!
//! [`SystemMetrics`] (the wire snapshot) compiles UNCONDITIONALLY, with or
//! without the `system-metrics` feature, so the REST/Tauri wire struct
//! (`banto_server::routes::SystemInfo`) can carry `metrics: Option<SystemMetrics>`
//! without itself needing the feature (ADR-0013: "the router does not know
//! the feature"). Only [`SystemMetricsSampler`] - the part that actually
//! calls into `sysinfo` - is behind `#[cfg(feature = "system-metrics")]`.

use serde::Serialize;

/// A snapshot of host/process CPU and memory usage, produced by
/// [`SystemMetricsSampler::sample`]. `camelCase` on the wire (folded into
/// `banto_server::routes::SystemInfo::metrics`) to match the rest of that
/// struct.
///
/// This type itself has no `sysinfo` dependency and compiles regardless of
/// the `system-metrics` feature - only the sampler that produces it is
/// feature-gated (ADR-0013).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetrics {
    /// Host-wide CPU usage, as a percentage (0..=100, `sysinfo`'s
    /// `global_cpu_usage()`).
    pub host_cpu_percent: f32,
    /// Total host physical memory, in bytes.
    pub host_memory_total_bytes: u64,
    /// Used host physical memory, in bytes.
    pub host_memory_used_bytes: u64,
    /// Total host swap, in bytes. `0` on a host with no swap configured.
    pub host_swap_total_bytes: u64,
    /// Used host swap, in bytes.
    pub host_swap_used_bytes: u64,
    /// This process's own CPU usage, as a percentage. Can exceed 100 on a
    /// multi-core host if the process uses more than one core's worth of
    /// time (`sysinfo::Process::cpu_usage`'s own documented behavior).
    pub process_cpu_percent: f32,
    /// This process's resident memory (RSS), in bytes.
    pub process_memory_bytes: u64,
    /// Logical CPU count, for interpreting `process_cpu_percent` (which can
    /// range up to `100 * cpu_count`).
    pub cpu_count: usize,
}

#[cfg(feature = "system-metrics")]
mod sampler {
    use super::SystemMetrics;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use sysinfo::{MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    struct Inner {
        system: System,
        pid: Pid,
        last_cpu_refresh: Instant,
    }

    /// Stateful CPU/memory sampler (ADR-0013). Holds a `sysinfo::System`
    /// plus the current process's own [`Pid`] behind an `Arc<Mutex<_>>` so
    /// it is cheaply `Clone` (matching every other service in this crate,
    /// conventions §2), even though `sysinfo::System` itself is not `Clone`
    /// and sampling needs `&mut` access.
    ///
    /// `sysinfo`'s CPU-usage numbers are only meaningful as a delta between
    /// two refreshes at least [`sysinfo::MINIMUM_CPU_UPDATE_INTERVAL`] apart:
    /// a single refresh (or two refreshes closer together than that) reports
    /// `0%`. [`SystemMetricsSampler::new`] performs the first (baseline)
    /// refresh so the caller's first [`sample`](Self::sample) call already
    /// has something to diff against, and `sample` itself skips the CPU
    /// refresh (reusing the previous values) when called again before the
    /// minimum interval has passed, rather than re-collapsing to `0%`.
    #[derive(Clone)]
    pub struct SystemMetricsSampler {
        inner: Arc<Mutex<Option<Inner>>>,
    }

    impl SystemMetricsSampler {
        /// Build a sampler and take the warm-up refresh described above.
        /// Cheap enough to call once at app/server startup (spec: `banto-serve`
        /// / `src-tauri`'s `setup()`) and share the resulting handle.
        pub fn new() -> Self {
            Self::from_system(System::new())
        }

        // sysinfo 0.40 reports unsupported platforms and initialization failures
        // through Result. Preserve the infallible public constructor and the
        // existing metrics: null fallback instead of failing app startup.
        fn from_system(system: Result<System, sysinfo::Error>) -> Self {
            let inner = system.ok().map(|mut system| {
                let pid = sysinfo::get_current_pid().unwrap_or(Pid::from_u32(0));
                system.refresh_memory_specifics(MemoryRefreshKind::everything());
                system.refresh_cpu_usage();
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[pid]),
                    true,
                    ProcessRefreshKind::nothing().with_cpu().with_memory(),
                );
                Inner {
                    system,
                    pid,
                    last_cpu_refresh: Instant::now(),
                }
            });
            Self {
                inner: Arc::new(Mutex::new(inner)),
            }
        }

        /// Take a snapshot. Synchronous and fast (a few milliseconds - a
        /// `/proc` read on Linux, a handful of Win32/Mach calls elsewhere),
        /// but still blocking I/O: callers on an async runtime should run it
        /// via `tokio::task::spawn_blocking` rather than `.await`ing it
        /// directly (see `banto_server::routes::system_info`'s handler).
        ///
        /// Returns `None` when `sysinfo::System` could not be initialized,
        /// including on unsupported platforms - ADR-0013's degrade-to-`null`
        /// path. Initialization is attempted once, when constructing the sampler.
        /// Memory is refreshed unconditionally (cheap, always fresh);
        /// the CPU figures (host + this process) are only re-measured once
        /// [`sysinfo::MINIMUM_CPU_UPDATE_INTERVAL`] has elapsed since the
        /// last refresh - a closer-spaced call reuses the previous CPU
        /// numbers rather than re-measuring (which would report `0%`, see
        /// the struct doc comment).
        pub fn sample(&self) -> Option<SystemMetrics> {
            let mut guard = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Inner {
                system,
                pid,
                last_cpu_refresh,
            } = guard.as_mut()?;

            system.refresh_memory_specifics(MemoryRefreshKind::everything());

            if last_cpu_refresh.elapsed() >= sysinfo::MINIMUM_CPU_UPDATE_INTERVAL {
                system.refresh_cpu_usage();
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[*pid]),
                    true,
                    ProcessRefreshKind::nothing().with_cpu().with_memory(),
                );
                *last_cpu_refresh = Instant::now();
            }

            let (process_cpu_percent, process_memory_bytes) = system
                .process(*pid)
                .map(|process| (process.cpu_usage(), process.memory()))
                .unwrap_or((0.0, 0));

            Some(SystemMetrics {
                host_cpu_percent: system.global_cpu_usage(),
                host_memory_total_bytes: system.total_memory(),
                host_memory_used_bytes: system.used_memory(),
                host_swap_total_bytes: system.total_swap(),
                host_swap_used_bytes: system.used_swap(),
                process_cpu_percent,
                process_memory_bytes,
                cpu_count: system.cpus().len(),
            })
        }
    }

    impl Default for SystemMetricsSampler {
        fn default() -> Self {
            Self::new()
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn supported_sampler() -> Option<SystemMetricsSampler> {
            match System::new() {
                Ok(system) => Some(SystemMetricsSampler::from_system(Ok(system))),
                Err(sysinfo::Error::Unsupported) => None,
                Err(error) => panic!("system initialization failed: {error}"),
            }
        }

        #[test]
        fn sampler_reports_positive_host_memory_on_supported_platforms() {
            let Some(sampler) = supported_sampler() else {
                return;
            };
            let metrics = sampler.sample().expect("supported platform samples Some");
            assert!(metrics.host_memory_total_bytes > 0);
            assert!(metrics.host_memory_used_bytes <= metrics.host_memory_total_bytes);
            assert!(metrics.cpu_count >= 1);
        }

        #[test]
        fn repeated_samples_stay_finite() {
            let Some(sampler) = supported_sampler() else {
                return;
            };
            let first = sampler.sample().expect("first sample");
            std::thread::sleep(std::time::Duration::from_millis(250));
            let second = sampler.sample().expect("second sample");

            for metrics in [first, second] {
                assert!(metrics.host_cpu_percent.is_finite());
                assert!((0.0..=100.0).contains(&metrics.host_cpu_percent));
                assert!(metrics.process_cpu_percent.is_finite());
                let max_process_percent = 100.0 * metrics.cpu_count as f32;
                assert!(
                    (0.0..=max_process_percent).contains(&metrics.process_cpu_percent),
                    "process_cpu_percent {} out of 0..={} range",
                    metrics.process_cpu_percent,
                    max_process_percent
                );
            }
        }

        #[test]
        fn sampler_is_clone_and_shares_state() {
            let Some(sampler) = supported_sampler() else {
                return;
            };
            let cloned = sampler.clone();
            // Both handles wrap the same `Arc<Mutex<Option<Inner>>>` - sampling
            // through either one advances the same `last_cpu_refresh`
            // state, proving `Clone` shares rather than duplicates it.
            assert!(Arc::ptr_eq(&sampler.inner, &cloned.inner));
            assert!(sampler.sample().is_some());
            assert!(cloned.sample().is_some());
        }

        #[test]
        fn initialization_failure_returns_none_for_original_and_clone() {
            for error in [
                sysinfo::Error::Unsupported,
                sysinfo::Error::Io(std::io::Error::other("initialization unavailable")),
            ] {
                let sampler = SystemMetricsSampler::from_system(Err(error));
                let cloned = sampler.clone();
                assert!(sampler.sample().is_none());
                assert!(cloned.sample().is_none());
            }
        }

        #[test]
        fn sampling_recovers_a_poisoned_mutex() {
            let Some(sampler) = supported_sampler() else {
                return;
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _guard = sampler.inner.lock().expect("initial lock");
                panic!("poison the sampler lock");
            }));
            assert!(result.is_err());
            assert!(sampler.inner.is_poisoned());
            assert!(sampler.sample().is_some());
            assert!(sampler.clone().sample().is_some());
        }
    }
}

#[cfg(feature = "system-metrics")]
pub use sampler::SystemMetricsSampler;
