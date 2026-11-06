# ADR-0013: Provide CPU/memory usage as a shared API by adopting `sysinfo` behind a feature (an exception to ADR-0002)

> 日本語: [0013-sysinfo-system-metrics-feature.md](0013-sysinfo-system-metrics-feature.md)

- Status: Accepted
- Date: 2026-09-14
- Related: Issue #185 / conventions §3 / [ADR-0002](0002-minimal-dependencies.en.md) /
  feature-review-2026-08 §2.4 (the System Info card, "縮小版⑤")

## Context

Downstream apps built on banto (banto-industrial / banto-hub) want **CPU and
memory usage** on their server-status screens (Issue #185). banto has
`SystemInfoService` (DB probe: dialect, latency, migration version, attachment
bytes) and an admin-only System Info card returned symmetrically over REST and
Tauri, but no API for process/host CPU and memory.

feature-review 2026-08 §2.4 **deferred only disk free**, reasoning that "std
cannot provide it, a sysinfo-style crate or FFI is needed, and that alone is not
worth passing the §3 gate". The new fact is that "CPU + memory (process RSS,
host total/used)" is now needed by several downstream apps at once.

Constraints:

- conventions §3 / ADR-0002: adding a dependency is a design decision; adopt it
  only when several P1-5 criteria hold (an in-house implementation would bloat,
  the area is edge-case heavy, the crate is mature, it can be feature-limited,
  the binary growth is measured) and record it in an ADR.
- std alone cannot read CPU usage / memory cross-platform (Linux needs `/proc`,
  Windows the Win32 API, macOS Mach/sysctl FFI).
- Three apps (the template + two downstream) each carrying their own `sysinfo`
  wiring costs more to maintain in total.

## Decision

**Add an opt-in feature `system-metrics` to `banto-admin-services` that pulls
`sysinfo` (`default-features = false, features = ["system"]`).** It provides a
stateful sampler, `SystemMetricsSampler` (CPU usage derived from the delta
between calls), and its snapshot `SystemMetrics` (host CPU %, memory total/used,
swap total/used, process CPU %, process RSS, logical CPU count). The
`SystemMetrics` type compiles without the feature and rides the existing System
Info wire struct as `metrics: Option<SystemMetrics>` (`null` when the feature is
off or the OS is unsupported).

`banto-server`'s `system_info_router` knows nothing about the feature: it takes
an `Option<MetricsProbe>` (`Arc<dyn Fn() -> Option<SystemMetrics> + Send + Sync>`).
Creating the sampler and wiring the closure is the app layer's job
(`banto-serve` / `src-tauri`) under `#[cfg(feature = "system-metrics")]`.

The template's app layer (`admin-template-core` and `src-tauri`) enables
`system-metrics` **by default**: the template is the reference wiring, and a
feature nothing enables is dead code in a template. Removal is one line in the
README's "removing optional assets" section (drop the feature from `default`).

## Alternatives considered

- **Option A (adopted): `sysinfo`, feature-limited.**
  P1-5 hits: ① an in-house version means per-OS FFI (the `windows` crate on
  Windows, Mach on macOS), well past 100-200 lines; ② parsing `/proc` and
  Windows performance counters is edge-case heavy; ③ `sysinfo` has been
  maintained since 2015 (MSRV 1.95; the workspace already needs ≥ 1.94 for
  sqlx 0.9, so effectively no change); ④ the `system` feature alone drops
  `component`/`disk`/`gpu`/`network`/`user`; ⑤ the binary delta is measured on
  a release build in the implementing PR and recorded in the CHANGELOG.
  Cons: on Windows the `windows` 0.62 line newly enters the tree (alongside
  `src-tauri`'s 0.61 line), and it enters standalone `banto-serve` too.
- **Option B (rejected): dependency-free in-house implementation.**
  Linux alone is ~100 lines over `/proc/stat` + `/proc/meminfo` +
  `/proc/self/statm`, but Windows (the primary target) needs `windows`/
  `windows-sys` FFI and macOS yet another implementation. It would not deliver
  the requested "thin cross-platform helper" and would leave us tracking
  vulnerabilities and API changes for three OSes ourselves.
- **Option C (rejected): defer again; each downstream app keeps its own `sysinfo`.**
  Two apps have already started reimplementing it; a third means fixing the
  same delta-computation bug three times. With several P1-5 criteria met, the
  §2.4 deferral rested on the premise "only for disk free", which no longer
  holds.
- **Option D (rejected): always on (no feature).**
  Contradicts ADR-0002's concern for adopters' copy burden. With a feature, an
  app that does not need it drops it in one line.

## Consequences

- Add this ADR to conventions §3's "exceptions that add a dependency" (the
  second after Paraglide = ADR-0005).
- **Disk free stays out of scope** (the `disk` feature would provide it, but
  nobody has asked). When needed, a small PR adding one feature suffices; no
  superseding ADR required — noted here on purpose.
- The sampler is **stateful** (sysinfo only yields CPU usage from the second
  refresh on), so one instance is created at `AppState` / `banto-serve` startup
  and shared. Calls closer together than `sysinfo::MINIMUM_CPU_UPDATE_INTERVAL`
  skip the CPU refresh and return the previous value (so it never collapses to 0).
- `sysinfo` refreshes are synchronous I/O (`/proc` reads, Win32 calls) — a few
  ms — so handlers call the probe via `tokio::task::spawn_blocking`.
- On unsupported OSes (`sysinfo::IS_SUPPORTED_SYSTEM == false`) `metrics` is
  `None` and the rest of the card degrades gracefully.
- The `SystemInfo` wire shape only gains `metrics` (backward compatible; older
  frontends ignore it).
- Downstream apps (banto-industrial / banto-hub) can replace their own `sysinfo`
  code with `SystemMetricsSampler`.
