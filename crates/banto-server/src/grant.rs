//! Credential-less session issuance - "grants" (ADR-0017, v3.0.0).
//!
//! A grant is a bearer token minted WITHOUT credentials under a condition the
//! application states up front: viewer-public (LAN 閲覧公開, ADR-0012,
//! the first kind, [`GrantKind::PUBLIC_VIEWER`]) and a derived app's
//! commissioning mode (the second kind, defined by that app). Only the
//! *issuance* is generalized here. A grant token is an ordinary session
//! afterwards: it goes through [`crate::require_auth`] + the app's
//! `RoleGuard` + audit + the SSE re-validation exactly like a login, so there
//! is no "skip authentication when ..." hook anywhere in banto
//! (conventions §6). Only the account re-check of ADR-0014 is skipped: a
//! grant has a fixed identity and no account row behind it.
//!
//! What a kind states, all in one [`GrantSpec`] (review starts there):
//!
//! - the FIXED [`Identity`] every token of the kind carries - the issuing
//!   route takes no identity/role from the client, so there is no escalation
//!   path (the property ADR-0012 relied on, kept for every kind);
//! - the condition ([`GrantCondition`]) evaluated on EVERY request (status
//!   and issuance share it through [`GrantRegistry::availability`]);
//! - a per-kind FIFO cap (`max_sessions`, default 256) - issuance is cheap
//!   and uncredentialed, so the cap (not a rate limit) bounds memory, and
//!   reaching it evicts the OLDEST token of that kind rather than failing (a
//!   wall display reloading its page is never refused);
//! - the token lifetime (`policy`, default the state's regular 8h / 1h idle;
//!   never "remembered");
//! - whether the peer must be the loopback interface (`require_loopback_peer`;
//!   an unknown peer is then refused, fail closed).
//!
//! The two public pieces are [`grant_router`] (`POST /api/auth/grant/{kind}`)
//! and [`GrantRegistry`] (registration + the shared availability judgment).
//! The app's own `/api/auth/status` reports `availability(peer)` as `grants`
//! ([`crate::routes::extra_auth_router`] does so for the template).
//!
//! ## Issuance and revocation are serialized by a generation (ADR-0017 §2)
//!
//! Re-evaluating the condition at issuance time is not enough: an issuance
//! that already read `enabled() == true` may be parked while the condition is
//! closed (viewer-public turned OFF, a commissioning lock-down) and the kind's
//! tokens revoked; resumed afterwards, it would insert a token the revocation
//! never saw. So [`AuthState`] keeps a [`GrantGeneration`] per kind: the
//! issuer reads it BEFORE judging ([`AuthState::grant_generation`]), and
//! [`AuthState::issue_grant_token`] inserts only if, under the state's
//! internal lock, the generation is still the one observed;
//! [`AuthState::revoke_grant_tokens`] advances it under the same lock while
//! removing the kind's tokens. The application's only duty is the order
//! "persist the closed condition, THEN revoke" - the reverse leaves a window
//! in which `enabled()` still answers `true` after the revocation.
//!
//! ## Peer address
//!
//! `ConnectInfo<SocketAddr>` is always present on banto's standard serving
//! path (`BoundServer::serve`, `server::start`, the Tauri embedded server).
//! A router driven without it (`tower::oneshot` in tests, a hand-rolled
//! `axum::serve`) has no peer: a kind with `require_loopback_peer` then
//! reports `false` in status and answers `403` on issuance. An IPv4-mapped
//! IPv6 peer (`::ffff:127.0.0.1`) counts as loopback, like `server.rs`'s
//! bind normalization. Behind a same-host reverse proxy (ADR-0003) every
//! peer IS the proxy, so the loopback requirement protects nothing there -
//! ADR-0017 §6 handles that with operating instructions, not code
//! (`X-Forwarded-For` is spoofable and is deliberately not read).

use std::collections::BTreeMap;
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use banto_admin_services::settings::SettingsService;
use banto_core::BantoError;
use futures_util::future::BoxFuture;
use serde::{Serialize, Serializer};

use crate::auth::{AuthState, Identity, MaybePeerAddr, TokenPolicy};
use crate::ApiError;

/// `Identity.id` (and `name`) of every viewer-public grant session
/// ([`GrantSpec::public_viewer`]; Issue #189, ADR-0012). Real accounts may
/// share this username, so this is a display/audit label, never a session
/// discriminator - provenance is the session's `kind`.
pub const PUBLIC_VIEWER_ID: &str = "public";

/// Longest grant kind identifier (`[A-Za-z][A-Za-z0-9_-]{0,31}`).
const MAX_KIND_LEN: usize = 32;

/// The kind of a grant: an open set the application defines (not a closed
/// enum). The SAME string is used everywhere - the URL
/// (`/api/auth/grant/{kind}`), `status.grants`, `identity.kind` and the
/// client's `SessionKind` - so there is no translation table and no alias.
/// Grammar: `[A-Za-z][A-Za-z0-9_-]{0,31}` ([`GrantKind::new`]).
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct GrantKind(Arc<str>);

impl GrantKind {
    /// The viewer-public kind (LAN 閲覧公開, the first grant).
    pub const PUBLIC_VIEWER: &'static str = "publicViewer";

    /// Session kinds that are NOT grants and can never be registered as one
    /// (an account session, and the Tauri auth-disabled `local` session).
    pub const RESERVED: [&'static str; 2] = ["account", "local"];

    /// Validate `kind` against the grammar. Reserved words pass here (they
    /// are a REGISTRATION error, [`GrantRegistry::register`]) so that a
    /// request for `/api/auth/grant/account` is answered with the ordinary
    /// "not registered" `404`.
    pub fn new(kind: &str) -> Result<Self, BantoError> {
        if Self::is_well_formed(kind) {
            Ok(Self(Arc::from(kind)))
        } else {
            Err(BantoError::BadRequest(format!(
                "grant kind `{kind}` は識別子の文法 [A-Za-z][A-Za-z0-9_-]{{0,31}} に合いません"
            )))
        }
    }

    /// [`GrantKind::PUBLIC_VIEWER`] as a kind.
    pub fn public_viewer() -> Self {
        Self(Arc::from(Self::PUBLIC_VIEWER))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_reserved(&self) -> bool {
        Self::RESERVED.contains(&self.as_str())
    }

    fn is_well_formed(kind: &str) -> bool {
        let mut chars = kind.chars();
        let Some(first) = chars.next() else {
            return false;
        };
        kind.len() <= MAX_KIND_LEN
            && first.is_ascii_alphabetic()
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    }
}

impl fmt::Debug for GrantKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "GrantKind({:?})", self.as_str())
    }
}

impl fmt::Display for GrantKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl AsRef<str> for GrantKind {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl PartialEq<str> for GrantKind {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for GrantKind {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

/// Serializes as the plain string, so it works as a JSON object key
/// (`status.grants`) and as `identity.kind`.
impl Serialize for GrantKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// The condition under which a kind may be issued, evaluated on every
/// request (status and issuance alike). `Ok(false)` and `Err` both mean "do
/// not issue" (fail closed); `Err` is additionally the response of the
/// issuing route (an `ApiError`), while status reports it as `false`.
pub type GrantCondition =
    Arc<dyn Fn() -> BoxFuture<'static, Result<bool, BantoError>> + Send + Sync>;

/// Default `max_sessions` of a [`GrantSpec`] (the viewer-public cap of
/// ADR-0012: far above any plausible number of kiosk screens on one LAN,
/// while keeping the token map trivially bounded).
pub const DEFAULT_GRANT_MAX_SESSIONS: usize = 256;

/// Everything that decides whether, and as whom, a kind is issued. All
/// fields are public: a derived app builds one for its own kind
/// ([`GrantSpec::new`] fills the defaults) and registers it with
/// [`GrantRegistry::register`].
#[derive(Clone)]
pub struct GrantSpec {
    pub kind: GrantKind,
    /// FIXED. The issuing route takes no identity/role from the client.
    pub identity: Identity,
    /// Evaluated per request (viewer-public: `server_config().viewer_public`).
    pub enabled: GrantCondition,
    /// Per-kind FIFO cap, at least 1 (default [`DEFAULT_GRANT_MAX_SESSIONS`]).
    /// Past it the oldest token of this kind is revoked to make room.
    pub max_sessions: usize,
    /// `None` = the [`AuthState`]'s regular `token_policy` (8h / idle 1h).
    /// Grants are never "remembered".
    pub policy: Option<TokenPolicy>,
    /// `true`: issue only to a loopback peer; an unknown peer is refused.
    pub require_loopback_peer: bool,
}

impl GrantSpec {
    /// A spec with the defaults (`max_sessions` 256, the state's regular
    /// policy, no loopback requirement). Admin-equivalent kinds should set
    /// `require_loopback_peer: true` and a small `max_sessions` (ADR-0017
    /// 帰結).
    pub fn new(kind: GrantKind, identity: Identity, enabled: GrantCondition) -> Self {
        Self {
            kind,
            identity,
            enabled,
            max_sessions: DEFAULT_GRANT_MAX_SESSIONS,
            policy: None,
            require_loopback_peer: false,
        }
    }

    /// Viewer-public (LAN 閲覧公開, ADR-0012 generalized): identity
    /// `{ id: "public", name: "public", role: "viewer" }`, condition
    /// `SettingsService::server_config().viewer_public` (read live on every
    /// request, so the settings toggle takes effect without a restart), cap
    /// 256, regular lifetime, no loopback requirement (it exists to be
    /// handed to LAN clients).
    pub fn public_viewer(settings: SettingsService) -> Self {
        Self::new(
            GrantKind::public_viewer(),
            Identity {
                id: PUBLIC_VIEWER_ID.to_string(),
                name: PUBLIC_VIEWER_ID.to_string(),
                role: "viewer".to_string(),
            },
            Arc::new(move || {
                let settings = settings.clone();
                Box::pin(async move { Ok(settings.server_config().await?.viewer_public) })
            }),
        )
    }
}

impl fmt::Debug for GrantSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GrantSpec")
            .field("kind", &self.kind)
            .field("identity", &self.identity)
            .field("max_sessions", &self.max_sessions)
            .field("policy", &self.policy)
            .field("require_loopback_peer", &self.require_loopback_peer)
            .finish_non_exhaustive()
    }
}

/// The revocation generation of one grant kind (see the module doc). Read
/// with [`AuthState::grant_generation`] before judging, handed back to
/// [`AuthState::issue_grant_token`]. Opaque; compare with `==` only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrantGeneration(pub(crate) u64);

/// The kinds an application issues, and the one judgment status and
/// issuance share. Built once at start-up, then shared as `Arc`.
#[derive(Default)]
pub struct GrantRegistry {
    specs: BTreeMap<GrantKind, GrantSpec>,
}

impl GrantRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a kind. `Err` for a reserved word (`account`, `local`), a
    /// kind already registered (registering `publicViewer` twice included)
    /// and a `max_sessions` of 0 (the kind's own tokens would evict
    /// themselves). The identifier grammar was checked by [`GrantKind::new`].
    pub fn register(&mut self, spec: GrantSpec) -> Result<(), BantoError> {
        if spec.kind.is_reserved() {
            return Err(BantoError::BadRequest(format!(
                "grant kind `{}` は予約語です（既存のセッション種別）",
                spec.kind
            )));
        }
        if self.specs.contains_key(&spec.kind) {
            return Err(BantoError::BadRequest(format!(
                "grant kind `{}` は登録済みです",
                spec.kind
            )));
        }
        if spec.max_sessions == 0 {
            return Err(BantoError::BadRequest(format!(
                "grant kind `{}` の max_sessions は 1 以上にしてください",
                spec.kind
            )));
        }
        self.specs.insert(spec.kind.clone(), spec);
        Ok(())
    }

    /// The spec registered under `kind` (`None` for an unknown or malformed
    /// identifier).
    pub fn get(&self, kind: &str) -> Option<&GrantSpec> {
        let kind = GrantKind::new(kind).ok()?;
        self.specs.get(&kind)
    }

    /// Every registered kind, in order.
    pub fn kinds(&self) -> impl Iterator<Item = &GrantKind> {
        self.specs.keys()
    }

    pub fn is_empty(&self) -> bool {
        self.specs.is_empty()
    }

    /// Whether each kind may be issued to `peer` RIGHT NOW: `enabled()` and,
    /// for `require_loopback_peer`, a known loopback peer. A kind whose
    /// condition fails (`Err`) is `false` (fail closed); the caller's own
    /// failures (e.g. `is_initialized` in the status route) are not this
    /// method's concern. Status is a point-in-time report: the issuing route
    /// judges again.
    pub async fn availability(&self, peer: Option<SocketAddr>) -> BTreeMap<GrantKind, bool> {
        let mut out = BTreeMap::new();
        for (kind, spec) in &self.specs {
            let available = match judge(spec, peer).await {
                Ok(()) => true,
                Err(_) => false,
            };
            out.insert(kind.clone(), available);
        }
        out
    }
}

impl fmt::Debug for GrantRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GrantRegistry")
            .field("kinds", &self.specs.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// Is `addr` the loopback interface? IPv4 `127.0.0.0/8`, IPv6 `::1`, and the
/// IPv4-mapped form (`::ffff:127.0.0.1`, which `Ipv6Addr::is_loopback`
/// alone does not recognize - same normalization as `server.rs`).
pub fn is_loopback_peer(addr: SocketAddr) -> bool {
    match addr.ip() {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map_or(v6.is_loopback(), |v4| v4.is_loopback()),
    }
}

/// The judgment shared by status and issuance (one function, so the two can
/// never disagree): the peer requirement first (no DB read for a refused
/// peer), then the condition. `Err(Forbidden)` for "not available",
/// otherwise the condition's own error.
async fn judge(spec: &GrantSpec, peer: Option<SocketAddr>) -> Result<(), BantoError> {
    if spec.require_loopback_peer && !peer.is_some_and(is_loopback_peer) {
        return Err(BantoError::Forbidden);
    }
    if (spec.enabled)().await? {
        Ok(())
    } else {
        Err(BantoError::Forbidden)
    }
}

#[derive(Clone)]
struct GrantRouteState {
    auth: AuthState,
    registry: Arc<GrantRegistry>,
}

#[derive(Debug, Serialize)]
struct GrantResponse {
    success: bool,
    token: String,
}

/// `POST /api/auth/grant/{kind}`: the ONE credential-less entry. In order:
/// unregistered (or malformed) `kind` -> `404 not_found`; read the kind's
/// generation; judge exactly as status does (`require_loopback_peer` with a
/// non-loopback or unknown peer -> `403 forbidden`; `enabled()` `Ok(false)`
/// -> `403`, `Err` -> that error); then insert under the observed generation
/// -> `{ success: true, token }`, or `403` when a revocation advanced the
/// generation meanwhile (the condition was closed while this request was
/// judging; nothing is issued).
///
/// Deliberately NOT audited (ADR-0012's rule, kept for every kind): this is
/// not a credential check, and a kiosk re-issuing on every reload would bury
/// the log. What a grant session then DOES is audited as usual (the
/// `RoleGuard` records `denied` with the fixed identity as actor), and the
/// side that closes a condition records `revokedGrants: n` from
/// [`AuthState::revoke_grant_tokens`]'s return value.
async fn grant_handler(
    State(state): State<GrantRouteState>,
    MaybePeerAddr(peer): MaybePeerAddr,
    Path(kind): Path<String>,
) -> Result<Json<GrantResponse>, ApiError> {
    let Some(spec) = state.registry.get(&kind) else {
        return Err(ApiError(BantoError::NotFound {
            resource: "grant".to_string(),
            id: kind,
        }));
    };
    // Before the judgment (ADR-0017 §2 "発行と失効の直列化").
    let observed = state.auth.grant_generation(&spec.kind);
    judge(spec, peer).await?;
    match state.auth.issue_grant_token(spec, observed) {
        Some(token) => Ok(Json(GrantResponse {
            success: true,
            token,
        })),
        None => Err(ApiError(BantoError::Forbidden)),
    }
}

/// The issuing router (`POST /api/auth/grant/{kind}`), `Router<()>` like
/// every router of this crate. The `X-Banto-Client` requirement comes from
/// the app's CSRF layer over the whole `/api` tree ([`crate::csrf`]), as for
/// every other `/api/auth/*` route - merge this inside that layer.
pub fn grant_router(auth: AuthState, registry: Arc<GrantRegistry>) -> Router {
    Router::new()
        .route("/api/auth/grant/{kind}", post(grant_handler))
        .with_state(GrantRouteState { auth, registry })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::SessionValidation;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request as HttpRequest, StatusCode};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tower::ServiceExt;

    fn always(value: bool) -> GrantCondition {
        Arc::new(move || Box::pin(async move { Ok(value) }))
    }

    fn flag(flag: Arc<AtomicBool>) -> GrantCondition {
        Arc::new(move || {
            let flag = flag.clone();
            Box::pin(async move { Ok(flag.load(Ordering::SeqCst)) })
        })
    }

    fn failing() -> GrantCondition {
        Arc::new(|| Box::pin(async { Err(BantoError::Storage("db down".to_string())) }))
    }

    fn admin_identity() -> Identity {
        Identity {
            id: "commissioning".to_string(),
            name: "試運転".to_string(),
            role: "admin".to_string(),
        }
    }

    fn spec(kind: &str, enabled: GrantCondition) -> GrantSpec {
        GrantSpec::new(GrantKind::new(kind).unwrap(), admin_identity(), enabled)
    }

    fn auth() -> AuthState {
        AuthState::new(
            |_u: String, _p: String| Box::pin(async { None }),
            SessionValidation::DisabledNoRevocation,
        )
    }

    fn registry(specs: Vec<GrantSpec>) -> Arc<GrantRegistry> {
        let mut registry = GrantRegistry::new();
        for spec in specs {
            registry.register(spec).unwrap();
        }
        Arc::new(registry)
    }

    fn post(kind: &str, peer: Option<SocketAddr>) -> HttpRequest<Body> {
        let mut req = HttpRequest::post(format!("/api/auth/grant/{kind}"))
            .body(Body::empty())
            .unwrap();
        if let Some(peer) = peer {
            req.extensions_mut().insert(ConnectInfo(peer));
        }
        req
    }

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    const LOOPBACK: Option<SocketAddr> = Some(SocketAddr::new(
        IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
        40000,
    ));
    const LAN: Option<SocketAddr> = Some(SocketAddr::new(
        IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 20)),
        40000,
    ));

    // --- kind grammar and registration -----------------------------------

    #[test]
    fn kind_grammar() {
        for ok in [
            "publicViewer",
            "commissioning",
            "a",
            "A1_-x",
            &"k".repeat(32),
        ] {
            assert!(GrantKind::new(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "1abc",
            "-x",
            "public viewer",
            "pub/lic",
            "日本語",
            &"k".repeat(33),
        ] {
            assert!(GrantKind::new(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn register_rejects_reserved_words_duplicates_and_a_zero_cap() {
        let mut registry = GrantRegistry::new();
        for reserved in GrantKind::RESERVED {
            assert!(
                registry.register(spec(reserved, always(true))).is_err(),
                "{reserved} must be refused"
            );
        }
        registry
            .register(spec("commissioning", always(true)))
            .unwrap();
        assert!(registry
            .register(spec("commissioning", always(true)))
            .is_err());
        let mut zero = spec("tiny", always(true));
        zero.max_sessions = 0;
        assert!(registry.register(zero).is_err());
        assert_eq!(registry.kinds().count(), 1);
        assert!(registry.get("commissioning").is_some());
        assert!(registry.get("account").is_none());
        assert!(registry.get("not a kind").is_none());
    }

    #[test]
    fn public_viewer_cannot_be_registered_twice_either() {
        // No `SettingsService` here: the duplicate check is by kind alone.
        let mut registry = GrantRegistry::new();
        let pv = |e| GrantSpec::new(GrantKind::public_viewer(), admin_identity(), e);
        registry.register(pv(always(true))).unwrap();
        assert!(registry.register(pv(always(true))).is_err());
    }

    // --- availability and the route agree ----------------------------------

    #[test]
    fn loopback_peer_classification() {
        let at = |ip: &str| SocketAddr::new(ip.parse().unwrap(), 1);
        assert!(is_loopback_peer(at("127.0.0.1")));
        assert!(is_loopback_peer(at("127.8.9.10")));
        assert!(is_loopback_peer(at("::1")));
        assert!(is_loopback_peer(at("::ffff:127.0.0.1")));
        assert!(!is_loopback_peer(at("192.168.1.20")));
        assert!(!is_loopback_peer(at("::ffff:192.168.1.20")));
    }

    #[tokio::test]
    async fn status_judgment_and_issuance_agree_for_every_peer_and_condition() {
        let open = Arc::new(AtomicBool::new(true));
        let mut local_only = spec("commissioning", flag(open.clone()));
        local_only.require_loopback_peer = true;
        let registry = registry(vec![
            local_only,
            spec("anywhere", flag(open.clone())),
            spec("broken", failing()),
        ]);
        let auth = auth();
        let router = grant_router(auth.clone(), registry.clone());

        for (peer, open_now) in [
            (LOOPBACK, true),
            (LAN, true),
            (None, true),
            (LOOPBACK, false),
        ] {
            open.store(open_now, Ordering::SeqCst);
            let availability = registry.availability(peer).await;
            for kind in ["commissioning", "anywhere", "broken"] {
                let response = router.clone().oneshot(post(kind, peer)).await.unwrap();
                let issued = response.status() == StatusCode::OK;
                let kind = GrantKind::new(kind).unwrap();
                assert_eq!(
                    availability[&kind], issued,
                    "peer {peer:?}, open {open_now}, kind {kind}: status and issuance must agree"
                );
                if issued {
                    let json = body_json(response).await;
                    assert_eq!(json["success"], true);
                    let token = json["token"].as_str().unwrap();
                    let session = auth.authenticate(token).await.unwrap().unwrap();
                    assert_eq!(session.grant, Some(kind));
                    assert_eq!(session.identity.role, "admin");
                }
            }
        }
        // The loopback-only kind: refused from the LAN and with no peer (fail closed).
        open.store(true, Ordering::SeqCst);
        let commissioning = GrantKind::new("commissioning").unwrap();
        assert!(!registry.availability(LAN).await[&commissioning]);
        assert!(!registry.availability(None).await[&commissioning]);
        assert!(registry.availability(None).await[&GrantKind::new("anywhere").unwrap()]);
    }

    #[tokio::test]
    async fn route_status_codes() {
        let registry = registry(vec![spec("off", always(false)), spec("broken", failing())]);
        let router = grant_router(auth(), registry);

        let unknown = router
            .clone()
            .oneshot(post("nope", LOOPBACK))
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(unknown).await["kind"], "not_found");

        let reserved = router
            .clone()
            .oneshot(post("account", LOOPBACK))
            .await
            .unwrap();
        assert_eq!(reserved.status(), StatusCode::NOT_FOUND);

        let closed = router.clone().oneshot(post("off", LOOPBACK)).await.unwrap();
        assert_eq!(closed.status(), StatusCode::FORBIDDEN);
        assert_eq!(body_json(closed).await["kind"], "forbidden");

        // The condition's own error is the route's answer (status says false).
        let broken = router
            .clone()
            .oneshot(post("broken", LOOPBACK))
            .await
            .unwrap();
        assert_eq!(broken.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn an_issuance_parked_between_the_judgment_and_the_insert_loses_to_a_revocation() {
        // ADR-0017 §2, through the real route: `enabled()` answered `true`,
        // the request is parked right before `issue_grant_token`; a
        // revocation (the condition closing) completes meanwhile; the
        // resumed request gets 403 and no token of the kind exists.
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let gates = Arc::new(std::sync::Mutex::new(Some((entered_tx, release_rx))));
        let parked: GrantCondition = Arc::new(move || {
            let gates = gates.clone();
            Box::pin(async move {
                let taken = gates.lock().unwrap().take();
                if let Some((entered, release)) = taken {
                    let _ = entered.send(());
                    let _ = release.await;
                }
                Ok(true)
            })
        });
        let auth = auth();
        let router = grant_router(auth.clone(), registry(vec![spec("commissioning", parked)]));
        let kind = GrantKind::new("commissioning").unwrap();

        let request = tokio::spawn({
            let router = router.clone();
            async move {
                router
                    .oneshot(post("commissioning", LOOPBACK))
                    .await
                    .unwrap()
            }
        });
        entered_rx.await.unwrap();
        // The lock-down: (the app persisted its flag, then) revoke.
        assert_eq!(auth.revoke_grant_tokens(&kind), 0);
        release_tx.send(()).unwrap();

        let response = request.await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(auth.session_count(), 0, "nothing was issued");

        // A request judged AFTER the revocation is issued as usual.
        let fresh = router
            .oneshot(post("commissioning", LOOPBACK))
            .await
            .unwrap();
        assert_eq!(fresh.status(), StatusCode::OK);
    }
}
