use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use banto_core::BantoError;
use futures_util::future::BoxFuture;
use uuid::Uuid;

use super::*;
use crate::grant::{GrantGeneration, GrantKind, GrantSpec};

/// Monotonic clock injected into [`AuthState`] so tests can advance time
/// deterministically instead of sleeping. Production always uses
/// [`Clock::real`], which reports elapsed time since construction; the
/// manually-advanced variant is only constructible under `#[cfg(test)]`.
pub(super) struct Clock {
    /// Anchor captured at construction; the real clock reports time relative
    /// to this so `now()` is a small monotonic `Duration`.
    base: Instant,
    /// When present, `now()` returns this stored value (advanced by tests)
    /// instead of reading the wall clock.
    #[cfg(test)]
    frozen: Option<RwLock<Duration>>,
}

impl Clock {
    fn real() -> Self {
        Self {
            base: Instant::now(),
            #[cfg(test)]
            frozen: None,
        }
    }

    /// Current time on this clock's monotonic scale.
    fn now(&self) -> Duration {
        #[cfg(test)]
        if let Some(frozen) = &self.frozen {
            return *frozen.read().expect("auth clock lock poisoned");
        }
        self.base.elapsed()
    }

    #[cfg(test)]
    fn frozen() -> Self {
        Self {
            base: Instant::now(),
            frozen: Some(RwLock::new(Duration::ZERO)),
        }
    }

    #[cfg(test)]
    fn advance(&self, by: Duration) {
        let frozen = self
            .frozen
            .as_ref()
            .expect("advance() called on a real clock");
        *frozen.write().expect("auth clock lock poisoned") += by;
    }
}

pub(super) struct Inner {
    pub(super) tokens: RwLock<HashMap<String, TokenRecord>>,
    /// Per grant kind: the FIFO of its tokens (the cap needs the *oldest*
    /// one and `HashMap` has no order) and its revocation generation
    /// (ADR-0017 §2). This is THE internal lock issuance and revocation
    /// serialize on. Lock order: `grants` before `tokens`; never the reverse.
    grants: Mutex<HashMap<GrantKind, GrantQueue>>,
    failures: RwLock<HashMap<String, FailureRecord>>,
    /// Verification slots reserved right now (Issue #279). Lock order: this
    /// before `failures`; never the reverse.
    pub(super) in_flight: Mutex<InFlight>,
    verify_credentials: CredentialVerifier,
    /// Issue #204: `Some` for [`SessionValidation::Lookup`], `None` for
    /// [`SessionValidation::DisabledNoRevocation`]. Fixed at construction,
    /// shared by every clone of this state (they share `Inner`).
    session_lookup: Option<SessionLookup>,
    token_policy: TokenPolicy,
    /// Long-lived policy applied to tokens issued with "Remember me" (spec
    /// M11) instead of `token_policy` - see [`TokenRecord::remembered`].
    remembered_policy: TokenPolicy,
    rate_limit: RateLimitPolicy,
    clock: Clock,
}

impl Inner {
    /// Which [`TokenPolicy`] `record` is evaluated against: its own grant
    /// policy when it has one, else the "remembered" or the regular policy by
    /// its `remembered` flag (spec M11).
    fn policy_for(&self, record: &TokenRecord) -> TokenPolicy {
        record.policy.unwrap_or(if record.remembered {
            self.remembered_policy
        } else {
            self.token_policy
        })
    }

    /// Drop every expired record (the opportunistic sweep on each write).
    fn sweep_expired(&self, tokens: &mut HashMap<String, TokenRecord>, now: Duration) {
        tokens.retain(|_, record| !record.is_expired(now, &self.policy_for(record)));
    }
}

/// Shared, cloneable auth state: an in-memory map of valid bearer tokens to
/// the [`Identity`] that logged in with them (each with expiry bookkeeping),
/// a per-key failed-login counter, and an injected async credential verifier.
/// Cloning is cheap (`Arc` handle).
#[derive(Clone)]
pub struct AuthState {
    pub(super) inner: Arc<Inner>,
}

impl AuthState {
    /// Build a new [`AuthState`] with the default [`TokenPolicy`] and
    /// [`RateLimitPolicy`]. `verify_credentials` decides whether a
    /// `username`/`password` pair may log in and, if so, which [`Identity`]
    /// the resulting session belongs to.
    ///
    /// `validation` (Issue #204) is required on purpose: every caller must
    /// decide whether sessions are re-checked against the account store
    /// ([`SessionValidation::Lookup`] - the only safe choice for real
    /// accounts) or not ([`SessionValidation::DisabledNoRevocation`]). There
    /// is deliberately no constructor that picks for you, so upgrading to
    /// this version fails to compile until that choice is written down:
    ///
    /// ```compile_fail,E0061
    /// # use banto_server::{AuthState, Identity};
    /// # use futures_util::future::BoxFuture;
    /// // The pre-#204 one-argument form no longer exists.
    /// let auth = AuthState::new(|_u: String, _p: String| -> BoxFuture<'static, Option<Identity>> {
    ///     Box::pin(async { None })
    /// });
    /// ```
    pub fn new(
        verify_credentials: impl Fn(String, String) -> BoxFuture<'static, Option<Identity>>
            + Send
            + Sync
            + 'static,
        validation: SessionValidation,
    ) -> Self {
        Self::with_policy(
            verify_credentials,
            validation,
            TokenPolicy::default(),
            RateLimitPolicy::default(),
        )
    }

    /// Like [`AuthState::new`], but with explicit token-expiry and
    /// login-rate-limit policies (spec §11.2). Callers that need non-default
    /// session lifetimes or lockout thresholds use this; everything else
    /// stays on [`AuthState::new`]'s defaults. The "Remember me" policy
    /// (spec M11) stays on [`TokenPolicy::remembered_default`] - use
    /// [`AuthState::with_policies`] to also override that.
    pub fn with_policy(
        verify_credentials: impl Fn(String, String) -> BoxFuture<'static, Option<Identity>>
            + Send
            + Sync
            + 'static,
        validation: SessionValidation,
        token_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
    ) -> Self {
        Self::with_policies(
            verify_credentials,
            validation,
            token_policy,
            TokenPolicy::remembered_default(),
            rate_limit,
        )
    }

    /// Like [`AuthState::with_policy`], but also lets the caller override the
    /// "Remember me" policy (spec M11) applied to tokens issued with
    /// `remember: true` instead of [`TokenPolicy::remembered_default`].
    pub fn with_policies(
        verify_credentials: impl Fn(String, String) -> BoxFuture<'static, Option<Identity>>
            + Send
            + Sync
            + 'static,
        validation: SessionValidation,
        token_policy: TokenPolicy,
        remembered_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
    ) -> Self {
        Self::build(
            Arc::new(verify_credentials),
            validation,
            token_policy,
            remembered_policy,
            rate_limit,
            Clock::real(),
        )
    }

    fn build(
        verify_credentials: CredentialVerifier,
        validation: SessionValidation,
        token_policy: TokenPolicy,
        remembered_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
        clock: Clock,
    ) -> Self {
        let session_lookup = match validation {
            SessionValidation::Lookup(lookup) => Some(lookup),
            SessionValidation::DisabledNoRevocation => None,
        };
        Self {
            inner: Arc::new(Inner {
                tokens: RwLock::new(HashMap::new()),
                grants: Mutex::new(HashMap::new()),
                failures: RwLock::new(HashMap::new()),
                in_flight: Mutex::new(InFlight::default()),
                verify_credentials,
                session_lookup,
                token_policy,
                remembered_policy,
                rate_limit,
                clock,
            }),
        }
    }

    fn session_lookup(&self) -> Option<&SessionLookup> {
        self.inner.session_lookup.as_ref()
    }
    /// Run the credential check and, when a [`SessionLookup`] is installed,
    /// establish the [`SessionStamp`] the new session is bound to (Issue
    /// #204). The stamp is read BEFORE the credential check: if the account
    /// changes while the (slow, argon2) check runs, the token carries the
    /// pre-change stamp and dies on first use instead of surviving the
    /// change. The verifier always runs, even when the pre-read failed, so
    /// an unknown username still pays the verifier's full cost.
    async fn verify_and_stamp(&self, username: &str, password: &str) -> StampedLogin {
        let pre_read = match self.session_lookup() {
            Some(lookup) => Some(lookup(username.to_string()).await),
            None => None,
        };
        let Some(identity) =
            (self.inner.verify_credentials)(username.to_string(), password.to_string()).await
        else {
            return StampedLogin::Rejected;
        };
        match pre_read {
            None => StampedLogin::Accepted(identity, None),
            Some(Ok(Some(account))) if account.identity.id == identity.id => {
                StampedLogin::Accepted(identity, Some(account.stamp))
            }
            Some(_) => StampedLogin::Unavailable,
        }
    }

    /// Verify credentials and, on success, mint and store a new uuid-v4
    /// bearer token bound to the returned identity. Returns `None` on bad
    /// credentials (and, with a [`SessionLookup`] installed, when the
    /// account's stamp could not be established - see
    /// [`LoginOutcome::Unavailable`]).
    ///
    /// This is the un-throttled, trusted-caller path (used programmatically
    /// and in tests): it does NOT consult the login rate limiter. The
    /// network-exposed `POST /api/auth/login` handler goes through
    /// [`AuthState::login_rate_limited`] instead, since that is the surface an
    /// attacker can flood.
    pub async fn login(&self, username: &str, password: &str) -> Option<String> {
        match self.verify_and_stamp(username, password).await {
            StampedLogin::Accepted(identity, stamp) => {
                Some(self.issue_token_with(identity, false, stamp))
            }
            StampedLogin::Rejected | StampedLogin::Unavailable => None,
        }
    }

    /// Rate-limited credential check for the login endpoint (spec §11.2).
    /// `ip` is the caller's peer address (`None` only when the server was
    /// started without `ConnectInfo`, e.g. `tower::oneshot` in tests). Both
    /// throttle dimensions - per (IP+username) and per IP alone (see
    /// [`RateLimitPolicy`]) - are checked *before* the expensive credential
    /// verifier runs, so a lockout on either cannot be used to keep argon2
    /// busy. A success clears both dimensions' streaks; a failure adds to
    /// both (each against its own threshold) and may start a lockout.
    ///
    /// `remember` (spec M11 "LAN Remember me"): when `true`, the issued token
    /// is evaluated against `remembered_policy` (long-lived) instead of the
    /// regular `token_policy` for the rest of its life - see
    /// [`TokenRecord::remembered`].
    pub async fn login_rate_limited(
        &self,
        ip: Option<IpAddr>,
        username: &str,
        password: &str,
        remember: bool,
    ) -> LoginOutcome {
        let account_key = rate_limit_key(ip, username);
        // The per-IP dimension only exists when the peer address is known
        // (production always wires up `ConnectInfo`; `None` is the test /
        // no-connect-info fallback, where an IP-wide limit is meaningless).
        let ip_key = ip.map(ip_rate_limit_key);
        let policy = self.inner.rate_limit;

        // BOTH dimensions are checked before the expensive verifier runs, so
        // a lockout on either one short-circuits argon2 (this is the property
        // that makes the endpoint DoS-resistant, not just brute-force-proof).
        //
        // The check also RESERVES a verification slot atomically (Issue
        // #279): attempts still in flight count like recorded failures, so a
        // burst that lands before the first failure is recorded cannot all
        // slip past the same check. The guard is held across the verifier
        // await and releases the slot however this future ends, cancellation
        // included.
        let _slot = match self.reserve_attempt(&account_key, ip_key.as_deref()) {
            Ok(slot) => slot,
            Err(retry_after) => return LoginOutcome::RateLimited { retry_after },
        };

        match self.verify_and_stamp(username, password).await {
            StampedLogin::Accepted(identity, stamp) => {
                self.reset_failures(&account_key);
                if let Some(ip_key) = &ip_key {
                    self.reset_failures(ip_key);
                }
                LoginOutcome::Success(self.issue_token_with(identity, remember, stamp))
            }
            // The password was right; only the account binding could not be
            // established. Clear the streak like a success, issue nothing.
            StampedLogin::Unavailable => {
                self.reset_failures(&account_key);
                if let Some(ip_key) = &ip_key {
                    self.reset_failures(ip_key);
                }
                LoginOutcome::Unavailable
            }
            StampedLogin::Rejected => {
                self.record_failure(&account_key, policy.max_failures);
                if let Some(ip_key) = &ip_key {
                    self.record_failure(ip_key, policy.max_ip_failures);
                }
                LoginOutcome::InvalidCredentials
            }
        }
    }

    /// Mint a token for an account the caller has just created or verified
    /// through some other path, bound to its [`SessionStamp`] (Issue #204) -
    /// the stamped counterpart of [`AuthState::issue_token`]/
    /// [`AuthState::issue_token_remembered`], and the one to use while a
    /// [`SessionLookup`] is installed (e.g. `POST /api/auth/setup` logging
    /// the first account in). `remember` selects the "Remember me" policy
    /// (spec M11).
    pub fn issue_account_token(&self, account: SessionAccount, remember: bool) -> String {
        self.issue_token_with(account.identity, remember, Some(account.stamp))
    }

    /// Mint and store a new bearer token for an already-verified `identity`,
    /// without going through `verify_credentials` again. Used by callers
    /// that just created/authenticated an account through some other path
    /// (e.g. the REST `/api/auth/setup` handler, right after
    /// `UsersService::setup_first_user` succeeds) and want to log the new
    /// session in immediately, the same way `login` would. Not "remembered"
    /// (spec M11) - use [`AuthState::issue_token_remembered`] for that.
    ///
    /// The token carries no [`SessionStamp`] (Issue #204): while a
    /// [`SessionLookup`] is installed it is rejected on first use - use
    /// [`AuthState::issue_account_token`] there instead.
    pub fn issue_token(&self, identity: Identity) -> String {
        self.issue_token_with(identity, false, None)
    }

    /// Like [`AuthState::issue_token`], but the token is issued as
    /// "remembered" (spec M11 "LAN Remember me"): it is evaluated against
    /// `remembered_policy` instead of `token_policy` for the rest of its
    /// life. Unstamped, like [`AuthState::issue_token`].
    pub fn issue_token_remembered(&self, identity: Identity) -> String {
        self.issue_token_with(identity, true, None)
    }

    /// The revocation generation of `kind` RIGHT NOW (ADR-0017 §2). An issuer
    /// reads this BEFORE judging the kind's condition and hands it to
    /// [`AuthState::issue_grant_token`]; a [`AuthState::revoke_grant_tokens`]
    /// in between makes that issuance a no-op. A kind nothing has touched yet
    /// is at generation 0 (the same value its first issuance will see).
    pub fn grant_generation(&self, kind: &GrantKind) -> GrantGeneration {
        let grants = self.inner.grants.lock().expect("auth grant lock poisoned");
        GrantGeneration(grants.get(kind).map_or(0, |queue| queue.generation))
    }

    /// Mint a grant session (ADR-0017; viewer-public is one kind): a regular
    /// (non-remembered) bearer token bound to `spec.identity` - the identity
    /// is the spec's, never the caller's, so there is no escalation path to
    /// review. Everything downstream is unchanged: the token goes through the
    /// same [`require_auth`] + `RoleGuard` + audit path as a logged-in
    /// session, and only the account re-check (Issue #204) is skipped.
    ///
    /// Inserts ONLY while `observed` (read with [`AuthState::grant_generation`]
    /// before the condition was judged) is still the kind's generation,
    /// checked under the same internal lock [`AuthState::revoke_grant_tokens`]
    /// advances it with; otherwise nothing is inserted and `None` is
    /// returned (the issuing route answers `403` - the condition was closed
    /// while this issuance was judging, and re-judging right after a close
    /// has no point). This is what makes "persist the closed condition, then
    /// revoke" sufficient for the application.
    ///
    /// Past `spec.max_sessions` outstanding tokens of the kind, the OLDEST is
    /// revoked to make room - only tokens of this kind; real login sessions
    /// and other kinds are never touched. Lifetime: `spec.policy`, or the
    /// state's regular [`TokenPolicy`] (never the "remembered" one): an
    /// expired grant is simply re-issued by the client's fallback, so an
    /// anonymous LAN client never holds a 30-day token.
    pub fn issue_grant_token(&self, spec: &GrantSpec, observed: GrantGeneration) -> Option<String> {
        let token = Uuid::new_v4().to_string();
        let now = self.inner.clock.now();
        // Lock order: `grants` -> `tokens` (same as `revoke_grant_tokens`).
        let mut grants = self.inner.grants.lock().expect("auth grant lock poisoned");
        let queue = grants.entry(spec.kind.clone()).or_default();
        if queue.generation != observed.0 {
            return None;
        }
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        self.inner.sweep_expired(&mut tokens, now);
        tokens.insert(
            token.clone(),
            TokenRecord {
                identity: spec.identity.clone(),
                issued_at: now,
                last_used: now,
                remembered: false,
                grant: Some(spec.kind.clone()),
                policy: spec.policy,
                stamp: None,
            },
        );
        queue.tokens.push_back(token.clone());
        while queue.tokens.len() > spec.max_sessions.max(1) {
            if let Some(oldest) = queue.tokens.pop_front() {
                tokens.remove(&oldest);
            }
        }
        Some(token)
    }

    /// Revoke every outstanding token of `kind` and advance its generation
    /// (ADR-0017 §2), under the one internal lock
    /// [`AuthState::issue_grant_token`] checks that generation with. Only
    /// that kind's tokens are touched; real login sessions and other kinds
    /// are never revoked here. The `AuthState` outlives server restarts (the
    /// app shares one across `server_apply`), so the side that closes a
    /// kind's condition (viewer-public turned OFF, a commissioning lock-down)
    /// must call this right after persisting the closed condition - in that
    /// order. Returns how many tokens were removed (the caller may record it
    /// as `revokedGrants` in its audit detail).
    pub fn revoke_grant_tokens(&self, kind: &GrantKind) -> usize {
        let mut grants = self.inner.grants.lock().expect("auth grant lock poisoned");
        let queue = grants.entry(kind.clone()).or_default();
        queue.generation += 1;
        let queued: Vec<String> = queue.tokens.drain(..).collect();
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        let before = tokens.len();
        for t in queued {
            tokens.remove(&t);
        }
        // Defensive: also drop any record of the kind the FIFO lost track of.
        tokens.retain(|_, record| record.grant.as_ref() != Some(kind));
        before - tokens.len()
    }

    /// Shared implementation of [`AuthState::issue_token`]/
    /// [`AuthState::issue_token_remembered`]/[`AuthState::login_rate_limited`]
    /// (account sessions; grants go through [`AuthState::issue_grant_token`]).
    ///
    /// Opportunistically sweeps already-expired tokens under the same write
    /// lock, so the map stays bounded without a background reaper. Each
    /// existing record is checked against whichever policy applies to IT
    /// (its own `remembered` flag / grant policy), not the policy of the
    /// token being inserted.
    fn issue_token_with(
        &self,
        identity: Identity,
        remembered: bool,
        stamp: Option<SessionStamp>,
    ) -> String {
        let token = Uuid::new_v4().to_string();
        let now = self.inner.clock.now();
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        self.inner.sweep_expired(&mut tokens, now);
        tokens.insert(
            token.clone(),
            TokenRecord {
                identity,
                issued_at: now,
                last_used: now,
                remembered,
                grant: None,
                policy: None,
                stamp,
            },
        );
        token
    }

    /// Is `token` a currently-valid, unexpired bearer token? A successful
    /// check refreshes the token's idle timer (spec §11.2); an expired token
    /// is removed as a side effect.
    ///
    /// Synchronous and in-memory only: it does NOT consult the account store
    /// (Issue #204). Anything that decides access must use
    /// [`AuthState::authenticate`] (as [`require_auth`] does).
    pub fn verify(&self, token: &str) -> bool {
        self.session_for(token).is_some()
    }

    /// Invalidate `token` (idempotent: logging out twice is not an error).
    pub fn logout(&self, token: &str) {
        self.inner
            .tokens
            .write()
            .expect("auth token lock poisoned")
            .remove(token);
    }

    /// Number of bearer tokens currently held in memory, for the admin System
    /// Info card (M-review 2026-08 §2.4).
    ///
    /// CAVEAT - this is an UPPER BOUND on genuinely-active sessions, not an
    /// exact count. Per this module's design, "expired tokens … are reaped
    /// lazily (on lookup) and opportunistically (a cheap sweep on each write);
    /// there is deliberately no background reaper task", so a token whose
    /// absolute/idle TTL has already lapsed still counts here until the next
    /// `verify`/`identity_for` on it, or the next token issue, sweeps it out.
    /// The card labels this accordingly. A read lock suffices; unlike
    /// [`verify`](Self::verify) this does not slide any idle timer.
    pub fn session_count(&self) -> usize {
        self.inner
            .tokens
            .read()
            .expect("auth token lock poisoned")
            .len()
    }

    /// The [`Identity`] bound to `token`, or `None` if it is not a
    /// currently-valid, unexpired token. Refreshes the idle timer on success
    /// (same as [`AuthState::verify`]). Exposed (beyond what the `/api/auth/*`
    /// routes below need) so other routers built in the app crate - e.g.
    /// `admin-template-core::rest`'s `/api/auth/change-password` - can
    /// recover "which account is this request for" from the same bearer
    /// token `require_auth` already validated.
    ///
    /// Synchronous and in-memory only (Issue #204): it returns the identity
    /// as of the token's last [`AuthState::authenticate`] (which refreshes it
    /// from the account store), so it is current for code running behind
    /// [`require_auth`] - and only there. Code that is not behind it must
    /// call [`AuthState::authenticate`] itself.
    pub fn identity_for(&self, token: &str) -> Option<Identity> {
        self.session_for(token).map(|session| session.identity)
    }

    /// Validate `token` for a request (Issue #204): the in-memory checks of
    /// [`AuthState::verify`] (known, unexpired; slides the idle window), then
    /// - when a [`SessionLookup`] is installed and this is an account session
    /// - re-read the account and compare its [`SessionStamp`]:
    ///
    /// - `Ok(Some(_))`: valid; the returned identity is the account's
    ///   CURRENT one (role included), and the token's cached identity is
    ///   refreshed to it;
    /// - `Ok(None)`: unknown/expired token, or the account is gone or its
    ///   stamp changed (or the token has no stamp) - the token is revoked;
    /// - `Err`: the store could not answer. The token is kept (a transient
    ///   store failure must not log everyone out) but the caller must fail
    ///   the request.
    pub async fn authenticate(
        &self,
        token: &str,
    ) -> Result<Option<AuthenticatedSession>, BantoError> {
        self.authenticate_with(token, IdleWindow::Slide).await
    }

    /// [`AuthState::authenticate`] for a check the client did not ask for -
    /// the periodic re-check of a long-lived stream that is already open
    /// (Issue #231: this crate's own `/api/events`; Issue #239: exposed so a
    /// derived app's own stream, e.g. banto-industrial's `/api/tag-stream` /
    /// `/api/v1/stream`, banto-industrial#430, can do the same). Same
    /// verdicts - including the in-flight re-binding rule of
    /// `AuthState::settle_stamp_mismatch` and "a store failure is `Err`,
    /// the token is kept" - but it does NOT slide the token's idle window:
    /// an open tab's stream must not keep an otherwise idle session alive
    /// (spec §11.2's `idle_ttl` would never lapse while a browser tab stays
    /// open). This is the ONLY difference from [`AuthState::authenticate`];
    /// use `authenticate` (or `require_auth`) for anything the client
    /// actually asked for.
    ///
    /// Return value (the same verdicts as `authenticate`):
    ///
    /// - `Ok(Some(_))`: valid right now; the returned identity is current.
    /// - `Ok(None)`: not valid right now - e.g. an unknown or logged-out
    ///   token, idle or absolute expiry, a deleted account, a changed
    ///   role/password (stamp mismatch) or an unstamped session. Whether the
    ///   token is also dropped from the in-memory store is NOT part of this
    ///   contract (a token re-bound while this check was in flight is left
    ///   for its next check to decide).
    /// - `Err(BantoError)`: the backing account store could not be checked.
    ///   The token is kept, and the caller may simply try again later.
    ///
    /// Policy for a long-lived stream (this crate's own use in `events.rs`;
    /// see [`crate::events`]'s module doc and `event_stream`) - a caller
    /// decision, not part of `revalidate`'s meaning:
    ///
    /// - end the stream on `Ok(None)`;
    /// - keep the stream open (fail-open) on `Err`, and likewise when the
    ///   caller's own timeout around this call elapses (that is the
    ///   wrapper's error, e.g. `tokio::time::error::Elapsed`, not a
    ///   `revalidate` `Err`) - a transient store failure must not drop every
    ///   open stream;
    /// - re-check on a fixed period, wrap the call in a timeout shorter than
    ///   that period (so a stuck lookup cannot delay the next check), and
    ///   re-arm the next deadline only after the check finishes (from
    ///   completion, not from when it was scheduled) so a slow check cannot
    ///   starve later ones.
    pub async fn revalidate(
        &self,
        token: &str,
    ) -> Result<Option<AuthenticatedSession>, BantoError> {
        self.authenticate_with(token, IdleWindow::Keep).await
    }

    async fn authenticate_with(
        &self,
        token: &str,
        idle: IdleWindow,
    ) -> Result<Option<AuthenticatedSession>, BantoError> {
        let Some(session) = self.session_for_with(token, idle) else {
            return Ok(None);
        };
        let Some(lookup) = self.session_lookup() else {
            return Ok(Some(session));
        };
        if session.grant.is_some() {
            // A grant session (ADR-0017): no account behind it, and its
            // fixed identity cannot change, so there is nothing to re-check.
            // It ends only through its token (expiry, `logout`,
            // `revoke_grant_tokens`).
            return Ok(Some(session));
        }
        let Some(stamp) = session.stamp else {
            self.revoke_if_stamp(token, None);
            return Ok(None);
        };
        match lookup(session.identity.id.clone()).await? {
            Some(account) if account.stamp == stamp => {
                self.refresh_identity(token, stamp, &account.identity);
                Ok(Some(AuthenticatedSession {
                    identity: account.identity,
                    grant: None,
                    stamp: Some(stamp),
                }))
            }
            account => {
                // The stamp this lookup started from may be stale for a reason
                // other than revocation: THIS token may have been re-bound
                // meanwhile ([`AuthState::rotate_session_epoch`], its own
                // password change). Decide on the token's CURRENT stamp.
                let rebound = self.settle_stamp_mismatch(token, stamp, account.as_ref());
                Ok(match (rebound, account) {
                    (Some(rebound), Some(account)) => Some(AuthenticatedSession {
                        identity: account.identity,
                        grant: None,
                        stamp: Some(rebound),
                    }),
                    _ => None,
                })
            }
        }
    }

    /// Resolve a lookup whose result does not match the stamp the request
    /// started from (`validated`), under one lock:
    ///
    /// - the token is still bound to `validated` -> it really is stale:
    ///   revoke it, `None`;
    /// - the token was re-bound meanwhile to EXACTLY the stamp the store now
    ///   reports -> it is valid under its new binding: refresh its identity
    ///   and return that stamp. Only the token's own re-binding counts; this
    ///   never adopts the store's newest epoch on a token's behalf, so the
    ///   account's other sessions still end;
    /// - anything else (re-bound to something the store no longer reports,
    ///   or already gone) -> `None`, leaving the token for its next request
    ///   to decide against a fresh lookup.
    fn settle_stamp_mismatch(
        &self,
        token: &str,
        validated: SessionStamp,
        account: Option<&SessionAccount>,
    ) -> Option<SessionStamp> {
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        let current = tokens.get(token)?.stamp;
        if current == Some(validated) {
            tokens.remove(token);
            return None;
        }
        let (Some(current), Some(account)) = (current, account) else {
            return None;
        };
        if current != account.stamp {
            return None;
        }
        if let Some(record) = tokens.get_mut(token) {
            record.identity = account.identity.clone();
        }
        Some(current)
    }

    /// Keep `token` alive across its own account's password change (Issue
    /// #204): the change incremented the account's epoch, which ends every
    /// session of it; this re-binds just `token` to `new_epoch` - the value
    /// the change itself wrote - so the session that made the change stays
    /// logged in while all the others end.
    ///
    /// Compare-and-set: only a token still bound to `previous` (the stamp it
    /// was authenticated with for this request) is re-bound. Returns whether
    /// it was; `false` means the token was meanwhile revoked, which the
    /// caller should leave as is (the user simply logs in again).
    pub fn rotate_session_epoch(
        &self,
        token: &str,
        previous: SessionStamp,
        new_epoch: i64,
    ) -> bool {
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        match tokens.get_mut(token) {
            Some(record) if record.stamp == Some(previous) => {
                record.stamp = Some(SessionStamp {
                    account_id: previous.account_id,
                    auth_epoch: new_epoch,
                });
                true
            }
            _ => false,
        }
    }

    /// Revoke `token` only if it is still bound to `stamp`. A token re-bound
    /// in the meantime ([`AuthState::rotate_session_epoch`]) was validated
    /// against a newer state than the lookup that failed, so it is left
    /// alone.
    fn revoke_if_stamp(&self, token: &str, stamp: Option<SessionStamp>) {
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        if tokens
            .get(token)
            .is_some_and(|record| record.stamp == stamp)
        {
            tokens.remove(token);
        }
    }

    /// Store the account's current identity on `token` (for the synchronous
    /// [`AuthState::identity_for`] readers behind [`require_auth`]), only if
    /// the token is still bound to the stamp that identity was read under.
    fn refresh_identity(&self, token: &str, stamp: SessionStamp, identity: &Identity) {
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        if let Some(record) = tokens.get_mut(token) {
            if record.stamp == Some(stamp) {
                record.identity = identity.clone();
            }
        }
    }

    /// Shared lookup for [`verify`](Self::verify)/[`identity_for`](Self::identity_for):
    /// return the identity behind a live token and slide its idle window
    /// forward, or evict it and return `None` if it has expired. Takes a
    /// write lock (not a read lock) precisely because the idle-timer refresh
    /// mutates the record - an acceptable cost for a single-host LAN server.
    ///
    /// Which [`TokenPolicy`] applies is decided per-token by its own
    /// `remembered` flag (spec M11), not by a single state-wide policy.
    pub(crate) fn session_for(&self, token: &str) -> Option<AuthenticatedSession> {
        self.session_for_with(token, IdleWindow::Slide)
    }

    /// [`AuthState::session_for`], sliding the idle window only for
    /// [`IdleWindow::Slide`] (expiry is enforced either way).
    fn session_for_with(&self, token: &str, idle: IdleWindow) -> Option<AuthenticatedSession> {
        let now = self.inner.clock.now();
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");

        let expired = {
            let record = tokens.get(token)?;
            record.is_expired(now, &self.inner.policy_for(record))
        };

        if expired {
            tokens.remove(token);
            None
        } else {
            let record = tokens
                .get_mut(token)
                .expect("token was just confirmed present");
            if idle == IdleWindow::Slide {
                record.last_used = now;
            }
            Some(AuthenticatedSession {
                identity: record.identity.clone(),
                grant: record.grant.clone(),
                stamp: record.stamp,
            })
        }
    }

    /// Atomically decide whether a login attempt may start the (expensive)
    /// verifier and, if so, reserve its slot (Issue #279). `Err` carries the
    /// `Retry-After` for an immediate [`LoginOutcome::RateLimited`].
    ///
    /// Refused when any of these holds:
    /// - either key is locked out (the pre-existing lockout);
    /// - recorded failures + attempts in flight reach the key's threshold
    ///   (`max_failures` per account key, `max_ip_failures` per IP key) - so
    ///   concurrency can never buy more attempts than the sequential policy;
    /// - [`MAX_IN_FLIGHT_PER_IP`] or [`MAX_CONCURRENT_VERIFICATIONS`] is
    ///   reached (a pure resource cap; no lockout starts, the answer is the
    ///   same `RateLimited` with a short retry).
    ///
    /// Holds the `in_flight` mutex for the whole check-and-reserve, taking
    /// the `failures` read lock inside it (the documented lock order).
    fn reserve_attempt(
        &self,
        account_key: &str,
        ip_key: Option<&str>,
    ) -> Result<InFlightGuard, Duration> {
        let policy = self.inner.rate_limit;
        let mut in_flight = self
            .inner
            .in_flight
            .lock()
            .expect("auth in-flight lock poisoned");

        let mut retry_after = self.locked_out(account_key);
        if let Some(ip_key) = ip_key {
            retry_after = max_option(retry_after, self.locked_out(ip_key));
        }
        if let Some(retry_after) = retry_after {
            return Err(retry_after);
        }

        let account_busy = self.live_failure_count(account_key) + in_flight.count(account_key)
            >= policy.max_failures as usize;
        let ip_busy = ip_key.is_some_and(|ip_key| {
            let held = in_flight.count(ip_key);
            held >= MAX_IN_FLIGHT_PER_IP
                || self.live_failure_count(ip_key) + held >= policy.max_ip_failures as usize
        });
        if account_busy || ip_busy || in_flight.total >= MAX_CONCURRENT_VERIFICATIONS {
            return Err(SATURATED_RETRY_AFTER);
        }

        let mut keys = vec![account_key.to_string()];
        keys.extend(ip_key.map(str::to_string));
        in_flight.total += 1;
        for key in &keys {
            *in_flight.per_key.entry(key.clone()).or_insert(0) += 1;
        }
        Ok(InFlightGuard {
            inner: Arc::clone(&self.inner),
            keys,
        })
    }

    /// Failures currently counting toward `key`'s streak: 0 when the record
    /// is absent or its streak has aged out (same staleness rule as
    /// [`AuthState::record_failure`]).
    fn live_failure_count(&self, key: &str) -> usize {
        let now = self.inner.clock.now();
        let lockout = self.inner.rate_limit.lockout;
        let failures = self
            .inner
            .failures
            .read()
            .expect("auth failure lock poisoned");
        failures
            .get(key)
            .filter(|record| now.saturating_sub(record.last_failure) < lockout)
            .map_or(0, |record| record.count as usize)
    }

    /// If `key` is currently locked out, how long until it may retry;
    /// otherwise `None`.
    fn locked_out(&self, key: &str) -> Option<Duration> {
        let now = self.inner.clock.now();
        let failures = self
            .inner
            .failures
            .read()
            .expect("auth failure lock poisoned");
        failures.get(key).and_then(|record| {
            record
                .locked_until
                .filter(|until| *until > now)
                .map(|until| until - now)
        })
    }

    /// Record a failed attempt for `key`, starting a lockout once the streak
    /// reaches `max_failures` (the caller passes the threshold for this key's
    /// dimension - `RateLimitPolicy::max_failures` for the per-account key,
    /// `max_ip_failures` for the per-IP key). Sweeps aged-out records under
    /// the same write lock.
    fn record_failure(&self, key: &str, max_failures: u32) {
        let now = self.inner.clock.now();
        let policy = self.inner.rate_limit;
        let mut failures = self
            .inner
            .failures
            .write()
            .expect("auth failure lock poisoned");
        failures.retain(|_, record| record.is_live(now, &policy));

        let record = failures.entry(key.to_string()).or_insert(FailureRecord {
            count: 0,
            locked_until: None,
            last_failure: now,
        });

        // An expired lockout, or a gap longer than the window since the last
        // failure, ends the previous streak so counting restarts cleanly.
        let lock_expired = record.locked_until.is_some_and(|until| until <= now);
        let streak_stale = now.saturating_sub(record.last_failure) >= policy.lockout;
        if lock_expired || streak_stale {
            record.count = 0;
            record.locked_until = None;
        }

        record.count += 1;
        record.last_failure = now;
        if record.count >= max_failures {
            record.locked_until = Some(now + policy.lockout);
        }
    }

    /// Clear `key`'s failure streak after a successful login.
    fn reset_failures(&self, key: &str) {
        self.inner
            .failures
            .write()
            .expect("auth failure lock poisoned")
            .remove(key);
    }

    #[cfg(test)]
    pub(super) fn with_frozen_clock(
        verify_credentials: impl Fn(String, String) -> BoxFuture<'static, Option<Identity>>
            + Send
            + Sync
            + 'static,
        validation: SessionValidation,
        token_policy: TokenPolicy,
        remembered_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
    ) -> Self {
        Self::build(
            Arc::new(verify_credentials),
            validation,
            token_policy,
            remembered_policy,
            rate_limit,
            Clock::frozen(),
        )
    }

    #[cfg(test)]
    pub(super) fn advance(&self, by: Duration) {
        self.inner.clock.advance(by);
    }
}

/// How many chars of the username go into a [`rate_limit_key`] (twice the
/// longest creatable username, so no real account is ever affected).
const RATE_LIMIT_KEY_USERNAME_CHARS: usize = 64;

/// Lockout key for a login attempt (spec §11.2): client IP + username when
/// the peer address is known, falling back to username-only when it is not
/// (e.g. a caller that did not wire up `ConnectInfo`). Keying on the pair
/// (rather than IP alone) avoids one noisy client on a shared NAT locking out
/// every account behind it, while still binding the streak to a network
/// origin when available.
pub fn rate_limit_key(ip: Option<IpAddr>, username: &str) -> String {
    // Bound the key's size (Issue #278): the username is attacker-controlled
    // and this key lives in the failure map. No real account name is this
    // long, so the cut only ever merges overlong junk names together.
    let username: String = username
        .chars()
        .take(RATE_LIMIT_KEY_USERNAME_CHARS)
        .collect();
    match ip {
        Some(ip) => format!("{ip}|{username}"),
        None => format!("-|{username}"),
    }
}

/// Lockout key for the per-IP throttle dimension (spec §11.2, see
/// [`RateLimitPolicy`]): the client IP alone, username-independent. The
/// `ip-only|` prefix can never collide with a [`rate_limit_key`] value (whose
/// first `|`-segment is always an IP address or `-`, never the literal
/// `ip-only`), so the two dimensions share the one failure map safely.
pub fn ip_rate_limit_key(ip: IpAddr) -> String {
    format!("ip-only|{ip}")
}

/// The larger of two optional retry-after durations (a present value beats
/// `None`): used to report the longer of the two lockout dimensions.
pub(super) fn max_option(a: Option<Duration>, b: Option<Duration>) -> Option<Duration> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}
