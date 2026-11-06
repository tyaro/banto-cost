use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use super::*;
use crate::grant::GrantKind;

/// Session-token lifetime policy (spec §11.2). Both bounds are enforced on
/// every lookup ([`AuthState::verify`]/[`AuthState::identity_for`]):
///
/// - `absolute_ttl`: hard cap measured from the token's issue time; refresh
///   activity cannot extend a token past this.
/// - `idle_ttl`: sliding window measured from the token's last use; each
///   successful lookup resets it, so an actively-used session stays alive
///   (up to `absolute_ttl`) while an abandoned one lapses.
#[derive(Debug, Clone, Copy)]
pub struct TokenPolicy {
    pub absolute_ttl: Duration,
    pub idle_ttl: Duration,
}

impl Default for TokenPolicy {
    /// 8h absolute / 1h idle - a full working session, but a laptop left
    /// open overnight (or a walked-away-from browser) does not stay logged
    /// in indefinitely.
    fn default() -> Self {
        Self {
            absolute_ttl: Duration::from_secs(8 * 60 * 60),
            idle_ttl: Duration::from_secs(60 * 60),
        }
    }
}

impl TokenPolicy {
    /// 30-day absolute / 7-day idle - the "Remember me" policy (spec M11):
    /// long-lived enough that a LAN browser client stays logged in across
    /// restarts for weeks, but still bounded (unlike no expiry at all) so a
    /// token that leaked or was simply forgotten about does not grant access
    /// forever, and idle enough to lapse if the client genuinely stops
    /// using it.
    pub fn remembered_default() -> Self {
        Self {
            absolute_ttl: Duration::from_secs(30 * 24 * 60 * 60),
            idle_ttl: Duration::from_secs(7 * 24 * 60 * 60),
        }
    }
}

/// Login failed-attempt throttling policy (spec §11.2). Failures are counted
/// along TWO independent dimensions, each starting a `lockout`-long window on
/// reaching its threshold (during which attempts are rejected without running
/// the expensive credential check); a success clears both:
///
/// - **per (IP + username)** ([`rate_limit_key`]), threshold `max_failures`:
///   the classic per-account brute-force guard, and NAT-friendly (one noisy
///   client behind a shared address doesn't lock out every account).
/// - **per IP alone** ([`ip_rate_limit_key`]), threshold `max_ip_failures`:
///   counts failures from an address regardless of username. Without this,
///   an attacker on one IP evades the per-account lockout entirely just by
///   varying the `username` field each request - and because credential
///   verification runs a deliberately expensive argon2id hash even for an
///   unknown user (dummy-hash timing defense), that is a CPU/memory
///   exhaustion DoS, not merely brute-force. This dimension bounds argon2
///   invocations per IP. Its threshold is higher than `max_failures` so a
///   shared NAT with several genuinely-fumbling users isn't tripped by
///   normal use.
#[derive(Debug, Clone, Copy)]
pub struct RateLimitPolicy {
    pub max_failures: u32,
    pub max_ip_failures: u32,
    pub lockout: Duration,
}

impl Default for RateLimitPolicy {
    /// 5 per-account strikes / 20 per-IP strikes, then a 60s cool-off. The
    /// per-account count is long enough to make online brute-forcing
    /// impractical, short enough that a user who fat-fingered their password
    /// five times isn't locked out for long. The per-IP count (4x higher)
    /// caps argon2 to ~20 hashes / 60s / IP under a username-rotation flood
    /// while leaving generous headroom for a shared NAT's legitimate misses.
    fn default() -> Self {
        Self {
            max_failures: 5,
            max_ip_failures: 20,
            lockout: Duration::from_secs(60),
        }
    }
}

/// Most credential verifications (argon2id, ~tens of ms of CPU and a
/// double-digit-MiB memory arena each) allowed to run at once across ALL
/// clients (Issue #279). Beyond this a login is turned away immediately with
/// the ordinary [`LoginOutcome::RateLimited`] answer rather than queued - an
/// unbounded queue of hashes is exactly the resource exhaustion the throttle
/// exists to prevent. 8 keeps the worst-case arena footprint to a few hundred
/// MiB and matches the core count of a typical LAN host, while a small
/// office's genuine login rate (a handful per minute) never gets near it.
pub const MAX_CONCURRENT_VERIFICATIONS: usize = 8;

/// Most verifications one client IP may have in flight at once (Issue #279).
/// Half the global cap, so a single address (an attacker, or a script gone
/// wrong) can never take every slot and starve the other clients, yet a
/// shared NAT still has room for a few simultaneous genuine logins.
pub const MAX_IN_FLIGHT_PER_IP: usize = 4;

/// `Retry-After` reported when a login is turned away only because the
/// verification slots are busy (no lockout is in force): the work is over in
/// well under a second, so ask the client to retry shortly.
pub(super) const SATURATED_RETRY_AFTER: Duration = Duration::from_secs(1);

/// Result of a rate-limited login attempt ([`AuthState::login_rate_limited`]).
/// The three variants map onto the three login-handler responses: a bearer
/// token, a plain "wrong credentials" 200, or a 429 lockout.
#[derive(Debug)]
pub enum LoginOutcome {
    /// Credentials verified; carries a freshly-issued bearer token.
    Success(String),
    /// Credentials rejected (and this failure was counted toward the lockout
    /// threshold).
    InvalidCredentials,
    /// The key is currently locked out; `retry_after` is how long until it
    /// may try again. The credential check was NOT run.
    RateLimited { retry_after: Duration },
    /// Issue #204: the credentials were accepted, but the account's
    /// [`SessionStamp`] could not be established (the [`SessionLookup`]
    /// failed, or the account it read is not the one that verified - it was
    /// created, deleted or replaced while the login was in flight). No token
    /// was issued and the failure streak was NOT extended; the client may
    /// simply retry. Only produced while a lookup is installed.
    Unavailable,
}

/// Result of [`AuthState::verify_and_stamp`] (Issue #204).
pub(super) enum StampedLogin {
    /// Credentials verified; the stamp is `None` exactly when no
    /// [`SessionLookup`] is installed.
    Accepted(Identity, Option<SessionStamp>),
    /// Credentials rejected.
    Rejected,
    /// Credentials verified, but the account binding could not be
    /// established (see [`LoginOutcome::Unavailable`]).
    Unavailable,
}

/// Whether a token lookup counts as use of the session (Issue #231): a
/// request does ([`AuthState::authenticate`]), the server's own periodic
/// re-check of an open event stream does not ([`AuthState::revalidate`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum IdleWindow {
    /// Slide the idle window forward (spec §11.2).
    Slide,
    /// Leave `last_used` as it is.
    Keep,
}

/// One stored session token: the identity it authenticates plus the two
/// timestamps [`TokenPolicy`] is evaluated against. Times are measured on
/// [`Clock`]'s monotonic scale (a `Duration` since the state was created).
pub(super) struct TokenRecord {
    pub(super) identity: Identity,
    pub(super) issued_at: Duration,
    pub(super) last_used: Duration,
    /// Whether this particular token was issued with "Remember me" (spec
    /// M11): if so, it is evaluated against `AuthState`'s `remembered_policy`
    /// instead of its regular `token_policy` for the rest of its life. This
    /// lives on the token, not on the login/identity, so a single account can
    /// have both a short-lived desktop session and a long-lived "remembered"
    /// LAN browser session live at the same time.
    pub(super) remembered: bool,
    /// Issuance provenance, independent of account name/role (ADR-0017,
    /// conventions §6): the grant kind that minted this token, `None` for an
    /// account session.
    pub(super) grant: Option<GrantKind>,
    /// A per-token lifetime (`GrantSpec::policy`) that overrides the state's
    /// `token_policy`/`remembered_policy`. `None` for every other token.
    pub(super) policy: Option<TokenPolicy>,
    /// The account binding (Issue #204) checked by [`AuthState::authenticate`]
    /// while a [`SessionLookup`] is installed. `None` for grant sessions and
    /// for tokens minted without one ([`AuthState::issue_token`]), which a
    /// lookup-enabled state rejects.
    pub(super) stamp: Option<SessionStamp>,
}

impl TokenRecord {
    /// Has this token exceeded either bound of `policy` as of `now`?
    pub(super) fn is_expired(&self, now: Duration, policy: &TokenPolicy) -> bool {
        now.saturating_sub(self.issued_at) >= policy.absolute_ttl
            || now.saturating_sub(self.last_used) >= policy.idle_ttl
    }
}

/// The tokens of one grant kind, in issue order, and the kind's revocation
/// generation (ADR-0017 §2). Entries may name a token that has since been
/// logged out or expired out of `tokens`; eviction simply removes whatever
/// it finds (a `HashMap::remove` of an absent key is a no-op), and the
/// queue itself is capped at the spec's `max_sessions`, so live sessions of
/// the kind are bounded whether or not stale entries are present.
#[derive(Default)]
pub(super) struct GrantQueue {
    pub(super) generation: u64,
    pub(super) tokens: VecDeque<String>,
}

/// Per-key failed-login bookkeeping for [`RateLimitPolicy`].
pub(super) struct FailureRecord {
    /// Consecutive failures since the last success/reset.
    pub(super) count: u32,
    /// End of the active lockout, if the threshold has been reached.
    pub(super) locked_until: Option<Duration>,
    /// Time of the most recent failure, used to age out stale entries so the
    /// map does not grow without bound and so a long-ago streak does not
    /// count against a much later attempt.
    pub(super) last_failure: Duration,
}

impl FailureRecord {
    /// Should this record be kept during a sweep as of `now`? Keep it while a
    /// lockout is still in force, or while its last failure is recent enough
    /// (within one `lockout` window) to still count toward the streak.
    pub(super) fn is_live(&self, now: Duration, policy: &RateLimitPolicy) -> bool {
        if let Some(until) = self.locked_until {
            if until > now {
                return true;
            }
        }
        now.saturating_sub(self.last_failure) < policy.lockout
    }
}

/// Verifications currently running (Issue #279). Reserved BEFORE the verifier
/// is awaited and counted together with recorded failures in the throttle's
/// threshold checks, so a burst that arrives before any failure is recorded
/// cannot all pass the same check.
#[derive(Default)]
pub(super) struct InFlight {
    /// All reservations, any client.
    pub(super) total: usize,
    /// Reservations per throttle key ([`rate_limit_key`] and
    /// [`ip_rate_limit_key`] values; the two namespaces cannot collide).
    pub(super) per_key: HashMap<String, usize>,
}

impl InFlight {
    pub(super) fn count(&self, key: &str) -> usize {
        self.per_key.get(key).copied().unwrap_or(0)
    }
}

/// RAII reservation of one verification slot. Dropping it - on success,
/// failure, error, or because the request future was cancelled (client
/// disconnect, timeout) - always releases the slot, so nothing can leak it
/// and lock other users out.
pub(super) struct InFlightGuard {
    pub(super) inner: Arc<Inner>,
    pub(super) keys: Vec<String>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        // Release even if another thread panicked while holding the lock.
        let mut in_flight = self
            .inner
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        in_flight.total = in_flight.total.saturating_sub(1);
        for key in self.keys.drain(..) {
            if let Some(n) = in_flight.per_key.get_mut(&key) {
                *n -= 1;
                if *n == 0 {
                    in_flight.per_key.remove(&key);
                }
            }
        }
    }
}
