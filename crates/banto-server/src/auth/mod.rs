//! Token-based authentication for the embedded server (spec §11.2).
//!
//! There is no secure-cookie story for a plain-HTTP LAN server, so the
//! bearer token is handed back in the login response body and the frontend
//! is responsible for attaching `Authorization: Bearer <token>` on every
//! subsequent request (mirrors `HttpDataProvider`'s planned wire contract,
//! spec §3.2/§11.1).
//!
//! Two hardening measures live here beyond plain "is this token known":
//!
//! - **Token expiry** ([`TokenPolicy`]): tokens carry an issue time and a
//!   last-used time and are invalidated once they exceed either an absolute
//!   lifetime (default 8h) or an idle timeout (default 1h, refreshed on every
//!   `verify`/`identity_for`). Without this a session lives forever until an
//!   explicit `logout`, and abandoned sessions accumulate in memory unbounded.
//!   Each token individually opts into a second, much longer-lived policy
//!   (spec M11 "LAN Remember me"): a token issued with `remember: true` is
//!   evaluated against `AuthState`'s `remembered_policy` (default 30d
//!   absolute / 7d idle) instead of the regular `token_policy` for the rest
//!   of its life - see [`TokenRecord::remembered`].
//! - **Login rate limiting** ([`RateLimitPolicy`]): consecutive failed
//!   `POST /api/auth/login` attempts trip a short lockout (default 60s) along
//!   two dimensions - per (IP + username) at 5 failures, and per IP alone at
//!   20 failures. Because credential verification runs a deliberately
//!   expensive argon2id hash even for an unknown username (spec §8.2's
//!   dummy-hash timing defense), an unthrottled login endpoint is also a
//!   CPU-exhaustion DoS, not just a brute-force one; the per-IP dimension is
//!   what stops that from being evaded by rotating the `username` field (see
//!   [`RateLimitPolicy`]). Attempts still in flight are counted against the
//!   same thresholds and capped per IP / globally ([`MAX_IN_FLIGHT_PER_IP`],
//!   [`MAX_CONCURRENT_VERIFICATIONS`]; Issue #279), so a burst arriving before
//!   any failure is recorded cannot all reach the verifier.
//!
//! Expired tokens and stale failure records are reaped lazily (on lookup) and
//! opportunistically (a cheap sweep on each write); there is deliberately no
//! background reaper task, to keep this a plain library type with no owned
//! runtime.
//!
//! ## Grant sessions (credential-less issuance, ADR-0017)
//!
//! [`AuthState::issue_grant_token`] mints a bearer token for a
//! [`GrantSpec`]'s FIXED identity with no credentials at all - viewer-public
//! (LAN 閲覧公開, ADR-0012, kind `publicViewer`) and a derived app's
//! commissioning mode are such kinds. The spec, the registry and the issuing
//! route live in [`crate::grant`]; this module holds the token side, and
//! these properties are asserted by its tests:
//!
//! - The identity comes from the spec, never from the caller of the route,
//!   so there is no escalation path.
//! - Issuance is uncredentialed and therefore free to repeat, so each kind's
//!   tokens are additionally held in a bounded FIFO (`GrantSpec::max_sessions`,
//!   default 256) - minting past the cap evicts the OLDEST token of that kind
//!   (issuance never fails for that reason, so a tablet reloading its page
//!   never gets stuck). Only that kind's tokens are evicted this way; real
//!   login sessions and other kinds are untouched.
//! - Issuance and revocation are serialized by a per-kind
//!   [`GrantGeneration`]: [`AuthState::grant_generation`] is read before the
//!   condition is judged, `issue_grant_token` inserts only while that
//!   generation is still current, and [`AuthState::revoke_grant_tokens`]
//!   advances it under the same lock while removing the kind's tokens. So an
//!   issuance parked after a `true` judgment cannot outlive a revocation that
//!   completed meanwhile (ADR-0017 §2).
//! - `logout` of a grant token revokes only that token, exactly like any
//!   other session, so one wall display signing out never blanks the others.
//!
//! ## Account-bound sessions (Issue #204)
//!
//! A token on its own only proves "this account logged in once". Deleting,
//! demoting or re-keying the account must end that session, across every
//! process that shares the account store (the Tauri app's embedded server,
//! `banto-serve`, several servers on one PostgreSQL) and without a restart.
//! So a session is additionally bound to a [`SessionStamp`] - the account's
//! stable row id plus its current *authentication epoch*, a counter the
//! credential store increments whenever existing sessions must end - and,
//! with [`SessionValidation::Lookup`] (a required constructor argument),
//! every authenticated request re-reads the account through the
//! [`SessionLookup`] ([`AuthState::authenticate`], which [`require_auth`]
//! runs):
//!
//! - account missing, or a different stamp -> the token is revoked and the
//!   request gets `401`;
//! - otherwise the CURRENT identity (display name, role) from the store is
//!   what the request is authorized with, and the token's cached copy is
//!   refreshed to it for the synchronous [`AuthState::identity_for`] readers
//!   that run after [`require_auth`];
//! - the store failing to answer is an error response, not a revocation
//!   (a DB hiccup must not log everyone out), and not a pass either.
//!
//! The stamp is captured BEFORE the credential check at login
//! ([`AuthState::login_rate_limited`]), so a change that commits while a
//! login is in flight leaves the new token with a stale stamp - it is
//! rejected on first use rather than outliving the change. Tokens minted
//! without a stamp ([`AuthState::issue_token`]) are rejected while a lookup is
//! installed (fail closed); callers that create an account and log it in
//! directly use [`AuthState::issue_account_token`]. There is deliberately no
//! cache in front of the lookup: it is one indexed read per request, and a
//! cache would re-open exactly the window this closes. Grant sessions have
//! no account and are not looked up.
//!
//! Every constructor takes the [`SessionValidation`] explicitly, so an
//! application cannot end up without revocation by omission (upgrading from
//! the one-argument `AuthState::new` is a compile error, not a silent
//! downgrade). [`SessionValidation::DisabledNoRevocation`] keeps the pre-#204
//! behavior of trusting the identity captured at login until the token
//! expires, and exists only for states with no account store behind them.

mod policy;
mod routes;
mod session;
mod state;
#[cfg(test)]
mod tests;

pub use policy::{
    LoginOutcome, RateLimitPolicy, TokenPolicy, MAX_CONCURRENT_VERIFICATIONS, MAX_IN_FLIGHT_PER_IP,
};
pub use routes::{auth_routes, require_auth};
pub(crate) use routes::{bearer_token, unauthorized_response, MaybePeerAddr};
pub use session::{
    AuthenticatedSession, CredentialVerifier, Identity, SessionAccount, SessionLookup,
    SessionStamp, SessionValidation,
};
pub use state::{ip_rate_limit_key, rate_limit_key, AuthState};

// Crate-internal names shared between the submodules (and `tests`) through
// `use super::*`.
use policy::SATURATED_RETRY_AFTER;
use policy::{
    FailureRecord, GrantQueue, IdleWindow, InFlight, InFlightGuard, StampedLogin, TokenRecord,
};
use state::Inner;
