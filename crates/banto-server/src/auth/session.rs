use std::sync::Arc;

use banto_core::BantoError;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize, Serializer};

use crate::grant::GrantKind;

/// Identity returned by `GET /api/auth/identity` (spec §3.3). Mirrors
/// `packages/admin-core/src/provider.ts::Identity`.
///
/// Convention: `id` is the account's `username` (not a numeric row id) -
/// both the REST layer (`admin-template-core::rest`) and the `src-tauri`
/// adapter rely on this to recover "which account is this session for"
/// (e.g. for `change-password`) from nothing but the `Identity` a session
/// is keyed on.
///
/// `role` (spec M10 RBAC) is carried as a plain string, not an enum:
/// `banto-server` is resource/policy-agnostic (see this module's doc
/// comment) and has no `Role` type of its own - it just ferries whatever
/// the app crate's credential verifier put here back out again. Callers
/// that need to make a decision based on it (`admin-template-core::rest`'s
/// role-guard middleware, `src-tauri`'s `require_role`) parse it into their
/// own `Role` type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub role: String,
}

/// Verifies a `username`/`password` pair against whatever credential store
/// the app crate wires in (spec §8.2), asynchronously (a real store is a
/// database lookup + password hash verification, both of which may need to
/// `.await`). Returns the session [`Identity`] on success.
///
/// Boxed owned-`String` arguments (rather than `&str` + a lifetime) keep
/// this object-safe/`'static` without extra lifetime plumbing: the request
/// body the credentials come from is already owned by the time a handler
/// calls this.
pub type CredentialVerifier =
    Arc<dyn Fn(String, String) -> BoxFuture<'static, Option<Identity>> + Send + Sync>;

/// What a session is bound to besides its identity (Issue #204, see the
/// module doc's "Account-bound sessions"): the account's stable row id and
/// its authentication epoch at the time the session was established. A
/// session stays valid only while the store reports the SAME pair for the
/// account - the id guards against a deleted account's username being
/// reused by a new account, the epoch against every in-place change the
/// store decides should end sessions (role, password, reset).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionStamp {
    pub account_id: i64,
    pub auth_epoch: i64,
}

/// The current state of an account as reported by a [`SessionLookup`]:
/// the identity to authorize the request with (its `role` is the account's
/// role NOW, not at login) plus the [`SessionStamp`] to compare against.
#[derive(Debug, Clone)]
pub struct SessionAccount {
    pub identity: Identity,
    pub stamp: SessionStamp,
}

/// Re-reads an account by [`Identity::id`] (the username) from the
/// credential store (Issue #204). `Ok(None)` means the account no longer
/// exists (the session is revoked); `Err` means the store could not answer
/// (the request fails, the session is kept). Passed in as
/// [`SessionValidation::Lookup`]; for `banto-admin-services`'
/// `UsersService` use `crate::routes::user_session_lookup`.
pub type SessionLookup = Arc<
    dyn Fn(String) -> BoxFuture<'static, Result<Option<SessionAccount>, BantoError>> + Send + Sync,
>;

/// How an [`AuthState`] decides that a session is still valid (Issue #204).
/// A required argument of every constructor, so no application ends up
/// without revocation by omission - see the module doc's "Account-bound
/// sessions".
pub enum SessionValidation {
    /// Re-read the account through the [`SessionLookup`] on every
    /// authenticated request: sessions of deleted accounts, and of accounts
    /// whose [`SessionStamp`] changed (role change, password change/reset),
    /// are revoked, and requests are authorized with the account's current
    /// role. **The only choice for states whose sessions belong to real
    /// accounts.**
    ///
    /// At login the lookup receives the username exactly as submitted (it
    /// runs before the verifier, see [`AuthState::login_rate_limited`]); the
    /// login succeeds only when the account it returns is the one the
    /// verifier accepted ([`Identity::id`]). A verifier that normalizes
    /// usernames (trimming, case folding) needs a lookup that accepts the
    /// submitted form too, or such logins report [`LoginOutcome::Unavailable`].
    Lookup(SessionLookup),
    /// **DANGER: no revocation.** Sessions trust the identity (role included)
    /// captured at login until the token expires (up to 30 days with
    /// "Remember me"): deleting, demoting or re-keying the account does NOT
    /// end them. This is the pre-#204 behavior, kept only for states with no
    /// account store behind them - tests with a fixed verifier, or a server
    /// that only ever issues grant sessions. Never use it for real accounts.
    DisabledNoRevocation,
}

impl SessionValidation {
    /// [`SessionValidation::Lookup`] from a plain closure (wraps it in the
    /// `Arc` [`SessionLookup`] is).
    pub fn lookup(
        lookup: impl Fn(String) -> BoxFuture<'static, Result<Option<SessionAccount>, BantoError>>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self::Lookup(Arc::new(lookup))
    }
}

/// A session that passed [`AuthState::authenticate`] (Issue #204): the
/// identity to authorize with - re-read from the account store when a
/// [`SessionLookup`] is installed - which grant kind issued it, if any
/// (ADR-0017; `None` = an account session), and the stamp it is bound to
/// (`None` for grant sessions and when no lookup is installed).
///
/// [`require_auth`] inserts this into the request's extensions, so guards and
/// handlers behind it can read the validated identity (and, e.g. for
/// `users_delete`, whether it is a grant) without a second lookup.
/// Serializes as the `GET /api/auth/identity` body - `Identity & { kind }`,
/// where `kind` is the grant kind's string or `"account"`; the stamp is
/// internal and never serialized.
#[derive(Debug, Clone, Serialize)]
pub struct AuthenticatedSession {
    #[serde(flatten)]
    pub identity: Identity,
    #[serde(rename = "kind", serialize_with = "serialize_session_kind")]
    pub grant: Option<GrantKind>,
    #[serde(skip)]
    pub stamp: Option<SessionStamp>,
}

/// `identity.kind` on the wire: the grant kind, or `account`. The same
/// strings the client's `SessionKind` uses (no translation table).
fn serialize_session_kind<S: Serializer>(
    grant: &Option<GrantKind>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(grant.as_ref().map_or("account", GrantKind::as_str))
}
