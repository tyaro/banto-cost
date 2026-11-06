//! LAN reach check - "did another device actually reach this server?"
//! (Issue #219 stage 1, `docs/design/lan-reach-check-design.md`, PR-C1).
//!
//! The administrator's own screen issues a one-time token ([`ReachCheckState::issue`],
//! wired to an admin-only Tauri command by the app) and shows it as a QR code /
//! URL whose FRAGMENT carries the token. A phone on the LAN opens the URL, the
//! SPA's `/reach` page POSTs the token to `POST /api/reach-check`
//! ([`reach_check_router`]), and the store records that a request from that
//! peer reached this listener. The administrator's screen then reads
//! [`ReachCheckState::status`].
//!
//! ## The one extra unauthenticated route (design §3.1)
//!
//! `POST /api/reach-check` is reachable WITHOUT a session. It never issues
//! one: the response is `{ "result": "<code>" }` and nothing else (no token,
//! no bearer, no server details - design §3.10), it does not touch
//! [`crate::AuthState`], grants or `require_auth`, and a successful check
//! leaves every other `/api/*` route at `401`. It behaves the same whether
//! viewer-public / auth-disabled mode is on or off.
//!
//! ## What a token is (design §3.3 - §3.5)
//!
//! - a `uuid` v4 (122 bits of OS randomness, the session token's strength);
//! - valid for [`TOKEN_TTL`] (5 minutes) on the monotonic clock;
//! - used ONCE: a successful check consumes it;
//! - at most ONE at a time: issuing again revokes the previous one;
//! - bound to the listener generation it was issued under: the store, the
//!   router that received the request and the token must all agree
//!   ([`ReachCheckState::begin_generation`] drops everything otherwise);
//! - bound to the URL host it was issued for: the request's `Host` must name
//!   that host and the receiving listener's port (`hostMismatch` otherwise,
//!   and the token is not consumed);
//! - compared in constant time ([`constant_time_eq`]); expiry / generation /
//!   host are judged only AFTER the bytes matched.
//!
//! Used, expired, other-generation and malformed tokens all answer the same
//! `404 { "result": "unusable" }`.
//!
//! ## This PC itself (design §3.6)
//!
//! The peer comes ONLY from `ConnectInfo<SocketAddr>` (no `X-Forwarded-For`;
//! no peer -> `403 unusable`, fail closed). A loopback peer, or one of this
//! PC's own interface addresses (enumerated at issuance, not per request),
//! is "this PC itself" (judged after the Host and listener-port checks, so
//! it is only reported for the URL the token was issued for): the request is
//! answered `selfAccess`, remembered only
//! as "this PC accessed at <time>", and the token is NOT consumed - the
//! administrator may still scan it with a phone. Behind a same-host reverse
//! proxy every peer is the proxy, so everything is "this PC itself" (the
//! embedded server does not assume a proxy; documented, not coded - like
//! ADR-0017 §6).
//!
//! ## Memory, rate limit, logging (design §3.8, §3.9)
//!
//! Memory only, never persisted: the current token, the last issuance's
//! outcome (`pending` / `recorded` / `expired`, without the token), the
//! latest [`MAX_RECORDS`] reach records and the last self-access time.
//! Failed checks (`unusable` / `hostMismatch`) are counted per peer IP:
//! [`RATE_LIMIT_FAILURES`] within [`RATE_LIMIT_WINDOW`] blocks that IP for
//! [`RATE_LIMIT_WINDOW`] (`429 rateLimited` + `Retry-After`, without even
//! comparing), in a table of at most [`RATE_LIMIT_TABLE_CAP`] IPs (oldest
//! evicted). Successful checks are not counted.
//!
//! The token is never logged, audited, recorded or echoed; records are
//! identified by a non-secret per-issuance serial (`issueId`). Neither
//! issuance nor reach is audited (design D8; conventions §1 Issue #278: an
//! uncredentialed route must not amplify the audit log).
//!
//! ## CSRF
//!
//! [`reach_check_router`] carries the `X-Banto-Client` requirement
//! ([`crate::require_banto_client_header`]) ITSELF, so it holds wherever the
//! app merges it - also outside an app's own `/api` CSRF layer (the template
//! merges it next to `api_router`, whose layer only covers the routes
//! inside it). Merging it inside such a layer as well just checks twice.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::MaybePeerAddr;
use crate::require_banto_client_header;

/// How long an issued token stays valid (design D4).
pub const TOKEN_TTL: Duration = Duration::from_secs(5 * 60);

/// How many reach records are kept (newest first; the oldest is dropped).
pub const MAX_RECORDS: usize = 8;

/// Failed checks per peer IP within [`RATE_LIMIT_WINDOW`] before that IP is
/// blocked (design D6).
pub const RATE_LIMIT_FAILURES: u32 = 10;

/// The counting window, and how long a blocked IP stays blocked.
pub const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);

/// Most peer IPs the failure table holds (the least recently seen is evicted).
pub const RATE_LIMIT_TABLE_CAP: usize = 256;

/// The route path.
pub const REACH_CHECK_PATH: &str = "/api/reach-check";

/// Largest accepted request body (`{ "token": "<36 chars>" }` fits easily).
const BODY_LIMIT_BYTES: usize = 1024;

/// The time source: a monotonic instant for expiry / rate limiting, and the
/// wall clock (milliseconds since the Unix epoch) for what the administrator's
/// screen shows. Injected so tests can move time ([`ReachCheckState::with_clock`]).
pub trait ReachCheckClock: Send + Sync + 'static {
    fn now(&self) -> Instant;
    fn wall_ms(&self) -> i64;
}

/// The real clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemReachCheckClock;

impl ReachCheckClock for SystemReachCheckClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn wall_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    }
}

/// The URL a token is issued for: the host the administrator picked (a
/// non-loopback entry of the live listener's URLs) and the live port. A
/// request's `Host` must name exactly this (host ASCII case-insensitive).
/// An IPv6 literal is given in brackets (`[fe80::1]`), as it appears in a URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReachTarget {
    pub host: String,
    pub port: u16,
}

/// What [`ReachCheckState::issue`] hands back to the issuing (admin) side.
/// The token is the only place it ever leaves the store; `Debug` redacts it.
#[derive(Clone)]
pub struct ReachIssue {
    pub generation: u64,
    /// Non-secret per-issuance serial (also in [`LastIssue`] / [`ReachRecord`]).
    pub issue_id: u64,
    /// The secret. Put it in the URL FRAGMENT only; never log or audit it.
    pub token: String,
    pub expires_at_ms: i64,
    pub expires_in_ms: u64,
}

impl fmt::Debug for ReachIssue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReachIssue")
            .field("generation", &self.generation)
            .field("issue_id", &self.issue_id)
            .field("token", &"<redacted>")
            .field("expires_at_ms", &self.expires_at_ms)
            .field("expires_in_ms", &self.expires_in_ms)
            .finish()
    }
}

/// Why [`ReachCheckState::issue`] refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReachIssueError {
    /// The generation the issuer observed is not the store's current one (a
    /// listener change happened in between): nothing is issued.
    StaleGeneration,
    /// This PC's own addresses could not be enumerated (or none but loopback
    /// came back), so a request from this PC to its own LAN address could not
    /// be told from another device's: nothing is issued rather than risk a
    /// false "reached from another device" (design §3.6).
    LocalAddressesUnavailable,
}

/// The outcome of the last issuance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReachOutcome {
    Pending,
    Recorded,
    Expired,
}

/// The last issuance of the current generation (no token in it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastIssue {
    pub issue_id: u64,
    pub host: String,
    pub port: u16,
    #[serde(rename = "expiresAt")]
    pub expires_at_ms: i64,
    pub outcome: ReachOutcome,
    /// Remaining validity while `pending`, else `0`.
    pub expires_in_ms: u64,
}

/// One successful reach: who (the socket peer), when, and through which URL
/// (the issued host, the receiving listener's port).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachRecord {
    pub issue_id: u64,
    #[serde(rename = "at")]
    pub at_ms: i64,
    pub peer_ip: IpAddr,
    pub host: String,
    pub port: u16,
}

/// A snapshot for the administrator's screen (codes and values only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachCheckStatus {
    pub generation: u64,
    /// `None` = nothing issued in this generation (unverified).
    pub last_issue: Option<LastIssue>,
    /// The last access from this PC itself with the last issuance's URL
    /// (cleared by every new issuance and listener change).
    #[serde(rename = "selfAccessAt")]
    pub self_access_at_ms: Option<i64>,
    /// Newest first, at most [`MAX_RECORDS`].
    pub records: Vec<ReachRecord>,
}

/// The result code of `POST /api/reach-check` (design §3.10). The client
/// maps it to its own text (conventions §13).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReachCheckResult {
    Recorded,
    SelfAccess,
    Unusable,
    HostMismatch,
    RateLimited,
}

/// What [`ReachCheckState::check`] decided (the router turns it into a
/// response).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckOutcome {
    Recorded,
    SelfAccess,
    /// No peer address (fail closed).
    NoPeer,
    Unusable,
    HostMismatch,
    /// Blocked by the failure counter; retry after this long.
    RateLimited(Duration),
}

impl CheckOutcome {
    fn status_and_result(self) -> (StatusCode, ReachCheckResult) {
        match self {
            Self::Recorded => (StatusCode::OK, ReachCheckResult::Recorded),
            Self::SelfAccess => (StatusCode::OK, ReachCheckResult::SelfAccess),
            Self::NoPeer => (StatusCode::FORBIDDEN, ReachCheckResult::Unusable),
            Self::Unusable => (StatusCode::NOT_FOUND, ReachCheckResult::Unusable),
            Self::HostMismatch => (StatusCode::CONFLICT, ReachCheckResult::HostMismatch),
            Self::RateLimited(_) => (StatusCode::TOO_MANY_REQUESTS, ReachCheckResult::RateLimited),
        }
    }
}

struct ActiveToken {
    token: String,
    generation: u64,
    issue_id: u64,
    target: ReachTarget,
    expires_at: Instant,
    self_addrs: Vec<IpAddr>,
}

struct IssueSummary {
    issue_id: u64,
    target: ReachTarget,
    expires_at: Instant,
    expires_at_ms: i64,
    outcome: ReachOutcome,
}

struct FailureEntry {
    window_start: Instant,
    failures: u32,
    blocked_until: Option<Instant>,
    last_seen: Instant,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    next_issue_id: u64,
    active: Option<ActiveToken>,
    last_issue: Option<IssueSummary>,
    records: VecDeque<ReachRecord>,
    self_access_at_ms: Option<i64>,
    failures: HashMap<IpAddr, FailureEntry>,
}

impl Inner {
    /// Drop the active token once it has expired, marking the last issuance
    /// `expired` (so a reopened screen can tell "expired" from "never").
    fn expire(&mut self, now: Instant) {
        if self.active.as_ref().is_some_and(|t| now >= t.expires_at) {
            self.active = None;
        }
        if let Some(last) = self.last_issue.as_mut() {
            if last.outcome == ReachOutcome::Pending && now >= last.expires_at {
                last.outcome = ReachOutcome::Expired;
            }
        }
    }

    /// `Some(retry_after)` while `ip` is blocked.
    fn blocked(&mut self, ip: IpAddr, now: Instant) -> Option<Duration> {
        let entry = self.failures.get_mut(&ip)?;
        match entry.blocked_until {
            Some(until) if now < until => {
                // A blocked peer that keeps trying is recent activity: without
                // this it could become the least recently seen entry, be
                // evicted when the table is full and resume guessing early.
                entry.last_seen = now;
                Some(until - now)
            }
            Some(_) => {
                self.failures.remove(&ip);
                None
            }
            None => None,
        }
    }

    fn count_failure(&mut self, ip: IpAddr, now: Instant) {
        if !self.failures.contains_key(&ip) && self.failures.len() >= RATE_LIMIT_TABLE_CAP {
            if let Some(oldest) = self
                .failures
                .iter()
                .min_by_key(|(_, e)| e.last_seen)
                .map(|(ip, _)| *ip)
            {
                self.failures.remove(&oldest);
            }
        }
        let entry = self.failures.entry(ip).or_insert(FailureEntry {
            window_start: now,
            failures: 0,
            blocked_until: None,
            last_seen: now,
        });
        if now.duration_since(entry.window_start) >= RATE_LIMIT_WINDOW {
            entry.window_start = now;
            entry.failures = 0;
        }
        entry.failures += 1;
        entry.last_seen = now;
        if entry.failures >= RATE_LIMIT_FAILURES {
            entry.blocked_until = Some(now + RATE_LIMIT_WINDOW);
        }
    }
}

/// The reach-check store (design §3.8). Cheap to clone (shared inside); the
/// app keeps one for the process and passes it to every listener's
/// [`reach_check_router`].
///
/// The app's duty (PR-C2): issue under the same lock that guards its
/// listener generation, and call [`ReachCheckState::begin_generation`] with
/// the new generation inside that lock whenever it advances it (including an
/// apply that failed and restored the old listener), so an issuance parked
/// before a listener change cannot slip in after it.
#[derive(Clone)]
pub struct ReachCheckState {
    inner: Arc<Mutex<Inner>>,
    clock: Arc<dyn ReachCheckClock>,
}

impl Default for ReachCheckState {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for ReachCheckState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReachCheckState").finish_non_exhaustive()
    }
}

impl ReachCheckState {
    /// A store at generation `0` (the template's launch-time listener
    /// generation) on the real clock.
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemReachCheckClock))
    }

    pub fn with_clock(clock: Arc<dyn ReachCheckClock>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            clock,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // No code path panics while holding the lock; recover anyway rather
        // than poisoning the route forever.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The store's current listener generation.
    pub fn generation(&self) -> u64 {
        self.lock().generation
    }

    /// The listener changed: adopt `generation` and drop the issued token,
    /// the last issuance's outcome, the records and the self-access mark
    /// (old results are never carried over). The failure counter is kept (it
    /// is about peers, not listeners).
    pub fn begin_generation(&self, generation: u64) {
        let mut inner = self.lock();
        inner.generation = generation;
        inner.active = None;
        inner.last_issue = None;
        inner.records.clear();
        inner.self_access_at_ms = None;
    }

    /// Issue a token for `target` under the `generation` the caller observed
    /// (revoking any previous token). This PC's own interface addresses are
    /// enumerated here, once per issuance.
    pub fn issue(
        &self,
        generation: u64,
        target: ReachTarget,
    ) -> Result<ReachIssue, ReachIssueError> {
        let local_addrs =
            local_interface_addrs().map_err(|_| ReachIssueError::LocalAddressesUnavailable)?;
        self.issue_with_local_addrs(generation, target, local_addrs)
    }

    /// [`ReachCheckState::issue`] with this PC's addresses given (tests, or an
    /// app that already enumerated them). A list without any non-loopback
    /// address is refused (`LocalAddressesUnavailable`): it cannot be a real
    /// enumeration of a PC serving the LAN. The target host, when it is an IP
    /// literal, is this PC's own address by construction and is always added.
    pub fn issue_with_local_addrs(
        &self,
        generation: u64,
        target: ReachTarget,
        local_addrs: Vec<IpAddr>,
    ) -> Result<ReachIssue, ReachIssueError> {
        let mut self_addrs: Vec<IpAddr> = local_addrs.into_iter().map(canonical_ip).collect();
        if !self_addrs.iter().any(|ip| !ip.is_loopback()) {
            return Err(ReachIssueError::LocalAddressesUnavailable);
        }
        let target_ip = target
            .host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .ok()
            .map(canonical_ip);
        if let Some(ip) = target_ip {
            if !self_addrs.contains(&ip) {
                self_addrs.push(ip);
            }
        }
        let now = self.clock.now();
        let wall = self.clock.wall_ms();
        let mut inner = self.lock();
        if inner.generation != generation {
            return Err(ReachIssueError::StaleGeneration);
        }
        inner.next_issue_id += 1;
        let issue_id = inner.next_issue_id;
        let token = Uuid::new_v4().to_string();
        let expires_at = now + TOKEN_TTL;
        let ttl_ms = u64::try_from(TOKEN_TTL.as_millis()).unwrap_or(u64::MAX);
        let expires_at_ms = wall.saturating_add(i64::try_from(ttl_ms).unwrap_or(i64::MAX));
        inner.active = Some(ActiveToken {
            token: token.clone(),
            generation,
            issue_id,
            target: target.clone(),
            expires_at,
            self_addrs,
        });
        // The self-access mark belongs to the issuance whose URL was opened
        // on this PC: a new issuance revokes that token, so the mark goes
        // with it - otherwise a screen reopened after issuing B (which has
        // no issue answer of its own to compare with) would show A's self
        // access as B's result (PR #470 review).
        inner.self_access_at_ms = None;
        inner.last_issue = Some(IssueSummary {
            issue_id,
            target,
            expires_at,
            expires_at_ms,
            outcome: ReachOutcome::Pending,
        });
        Ok(ReachIssue {
            generation,
            issue_id,
            token,
            expires_at_ms,
            expires_in_ms: ttl_ms,
        })
    }

    /// A snapshot for the administrator's screen.
    pub fn status(&self) -> ReachCheckStatus {
        let now = self.clock.now();
        let mut inner = self.lock();
        inner.expire(now);
        ReachCheckStatus {
            generation: inner.generation,
            last_issue: inner.last_issue.as_ref().map(|last| LastIssue {
                issue_id: last.issue_id,
                host: last.target.host.clone(),
                port: last.target.port,
                expires_at_ms: last.expires_at_ms,
                outcome: last.outcome,
                expires_in_ms: if last.outcome == ReachOutcome::Pending {
                    u64::try_from(last.expires_at.saturating_duration_since(now).as_millis())
                        .unwrap_or(u64::MAX)
                } else {
                    0
                },
            }),
            self_access_at_ms: inner.self_access_at_ms,
            records: inner.records.iter().cloned().collect(),
        }
    }

    /// Judge one `POST /api/reach-check` (design §3.3 - §3.8): `peer` is the
    /// socket peer (`None` = unknown), `router_generation` / `router_port`
    /// belong to the listener that received the request, `host` is its
    /// single `Host` authority (`None` = missing or ambiguous). Everything
    /// happens under one lock, so a token is consumed at most once.
    pub fn check(
        &self,
        peer: Option<SocketAddr>,
        router_generation: u64,
        router_port: u16,
        host: Option<&str>,
        token: &str,
    ) -> CheckOutcome {
        let Some(peer) = peer else {
            return CheckOutcome::NoPeer;
        };
        let peer_ip = canonical_ip(peer.ip());
        let now = self.clock.now();
        let wall = self.clock.wall_ms();
        let mut inner = self.lock();

        if let Some(retry_after) = inner.blocked(peer_ip, now) {
            return CheckOutcome::RateLimited(retry_after);
        }

        let matched = inner
            .active
            .as_ref()
            .is_some_and(|active| constant_time_eq(active.token.as_bytes(), token.as_bytes()));
        if !matched {
            inner.count_failure(peer_ip, now);
            return CheckOutcome::Unusable;
        }
        // Only a matching token reaches the judgments below.
        inner.expire(now);
        let store_generation = inner.generation;
        let Some(active) = inner.active.as_ref() else {
            // It matched, but had expired.
            inner.count_failure(peer_ip, now);
            return CheckOutcome::Unusable;
        };
        if active.generation != router_generation || active.generation != store_generation {
            inner.count_failure(peer_ip, now);
            return CheckOutcome::Unusable;
        }
        // The URL binding (Host and the listener's port) is checked before
        // "this PC": a self access is only reported for the URL the token was
        // issued for, never for a changed Host or a wrong listener.
        if active.target.port != router_port
            || !host.is_some_and(|h| authority_matches(h, &active.target.host, router_port))
        {
            inner.count_failure(peer_ip, now);
            return CheckOutcome::HostMismatch;
        }
        if peer_ip.is_loopback() || active.self_addrs.contains(&peer_ip) {
            inner.self_access_at_ms = Some(wall);
            return CheckOutcome::SelfAccess;
        }

        let Some(active) = inner.active.take() else {
            return CheckOutcome::Unusable;
        };
        if let Some(last) = inner.last_issue.as_mut() {
            if last.issue_id == active.issue_id {
                last.outcome = ReachOutcome::Recorded;
            }
        }
        inner.records.push_front(ReachRecord {
            issue_id: active.issue_id,
            at_ms: wall,
            peer_ip,
            host: active.target.host,
            port: router_port,
        });
        inner.records.truncate(MAX_RECORDS);
        CheckOutcome::Recorded
    }
}

/// Constant-time byte comparison (design §3.4): a length difference answers
/// `false` at once (the length of a token is public), otherwise every byte is
/// folded so the time does not depend on where the first difference is.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// `::ffff:a.b.c.d` -> `a.b.c.d` (the bind normalization of `server.rs`).
fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

/// This PC's interface addresses (loopback included; that is judged by
/// `is_loopback` anyway). An enumeration failure is an error, never an empty
/// list: with no own addresses known, this PC reaching its own LAN address
/// would be recorded as another device (owner review on PR #468).
fn local_interface_addrs() -> std::io::Result<Vec<IpAddr>> {
    if_addrs::get_if_addrs().map(|ifaces| ifaces.into_iter().map(|iface| iface.ip()).collect())
}

/// Whether the `Host` authority names `host` and `port` exactly. A missing
/// port means the scheme default (80; the embedded server is plain HTTP).
fn authority_matches(authority: &str, host: &str, port: u16) -> bool {
    let (name, port_part) = if authority.starts_with('[') {
        match authority.find(']') {
            Some(end) => authority.split_at(end + 1),
            None => return false,
        }
    } else {
        authority.split_at(authority.find(':').unwrap_or(authority.len()))
    };
    let authority_port = match port_part.strip_prefix(':') {
        None if port_part.is_empty() => 80,
        Some(digits) if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => {
            match digits.parse::<u16>() {
                Ok(p) => p,
                Err(_) => return false,
            }
        }
        _ => return false,
    };
    !name.is_empty() && name.eq_ignore_ascii_case(host) && authority_port == port
}

/// The request's single authority: one `Host` header (several = ambiguous),
/// which must agree with the URI authority when both are present (as in
/// [`crate::request_is_loopback_local`]).
fn request_authority(req: &Request) -> Option<String> {
    let mut hosts = req.headers().get_all(header::HOST).iter();
    let host = match (hosts.next(), hosts.next()) {
        (None, _) => None,
        (Some(value), None) => Some(value.to_str().ok()?),
        (Some(_), Some(_)) => return None,
    };
    let uri = req.uri().authority().map(|a| a.as_str());
    match (host, uri) {
        (Some(h), Some(u)) if h.eq_ignore_ascii_case(u) => Some(h.to_string()),
        (Some(_), Some(_)) => None,
        (Some(only), None) | (None, Some(only)) => Some(only.to_string()),
        (None, None) => None,
    }
}

#[derive(Clone)]
struct RouteState {
    store: ReachCheckState,
    generation: u64,
    port: u16,
}

#[derive(Deserialize)]
struct ReachCheckBody {
    token: String,
}

#[derive(Serialize)]
struct ReachCheckResponse {
    result: ReachCheckResult,
}

/// Captures the authority before the body is consumed (the handler needs
/// both, and `Json` must be the last extractor).
#[derive(Clone)]
struct RequestAuthority(Option<String>);

async fn capture_authority(mut req: Request, next: middleware::Next) -> Response {
    let authority = RequestAuthority(request_authority(&req));
    req.extensions_mut().insert(authority);
    next.run(req).await
}

async fn reach_check_handler(
    State(state): State<RouteState>,
    MaybePeerAddr(peer): MaybePeerAddr,
    axum::Extension(RequestAuthority(authority)): axum::Extension<RequestAuthority>,
    Json(body): Json<ReachCheckBody>,
) -> Response {
    let outcome = state.store.check(
        peer,
        state.generation,
        state.port,
        authority.as_deref(),
        &body.token,
    );
    let (status, result) = outcome.status_and_result();
    let mut response = (status, Json(ReachCheckResponse { result })).into_response();
    if let CheckOutcome::RateLimited(retry_after) = outcome {
        let secs = retry_after.as_secs() + u64::from(retry_after.subsec_nanos() > 0);
        if let Ok(value) = HeaderValue::from_str(&secs.max(1).to_string()) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
    }
    response
}

/// `POST /api/reach-check` for ONE listener: `generation` and `port` are that
/// listener's (the app builds a router per listener it starts). `Router<()>`
/// like every router of this crate; carries its own `X-Banto-Client` check
/// (see the module doc). Merge it into the served router so the outermost
/// [`crate::with_security_headers`] covers it. Not for a server that has no
/// screen to issue tokens (e.g. `banto-serve`): there it could only fail, and
/// it would be one more unauthenticated route.
pub fn reach_check_router(store: ReachCheckState, generation: u64, port: u16) -> Router {
    Router::new()
        // A literal (not `REACH_CHECK_PATH`): `verify-architecture.mjs` rule 8 (d)
        // greps `.route("...")` declarations against the Route table.
        .route("/api/reach-check", post(reach_check_handler))
        .with_state(RouteState {
            store,
            generation,
            port,
        })
        .layer(middleware::from_fn(capture_authority))
        .layer(DefaultBodyLimit::max(BODY_LIMIT_BYTES))
        .layer(middleware::from_fn(require_banto_client_header))
}

#[cfg(test)]
mod tests;
