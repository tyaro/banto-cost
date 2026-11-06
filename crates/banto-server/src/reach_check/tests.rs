//! Tests of the reach-check store and route (design §6.2). The route is
//! driven through `tower::oneshot` with `ConnectInfo` inserted by hand (the
//! grant tests' convention); time comes from [`ManualClock`].

use super::*;
use crate::auth::SessionValidation;
use crate::{require_auth, AuthState};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::Request as HttpRequest;
use axum::routing::get;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use tower::ServiceExt;

/// A clock tests move by hand (monotonic and wall time move together).
struct ManualClock {
    base: Instant,
    offset_ms: AtomicU64,
}

const WALL_BASE_MS: i64 = 1_800_000_000_000;

impl ManualClock {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            base: Instant::now(),
            offset_ms: AtomicU64::new(0),
        })
    }

    fn advance(&self, by: Duration) {
        self.offset_ms
            .fetch_add(by.as_millis() as u64, Ordering::SeqCst);
    }
}

impl ReachCheckClock for ManualClock {
    fn now(&self) -> Instant {
        self.base + Duration::from_millis(self.offset_ms.load(Ordering::SeqCst))
    }

    fn wall_ms(&self) -> i64 {
        WALL_BASE_MS + self.offset_ms.load(Ordering::SeqCst) as i64
    }
}

const PORT: u16 = 23456;
const HOST: &str = "192.168.1.10";
const PHONE: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 50);

fn target() -> ReachTarget {
    ReachTarget {
        host: HOST.to_string(),
        port: PORT,
    }
}

fn store() -> (ReachCheckState, Arc<ManualClock>) {
    let clock = ManualClock::new();
    (ReachCheckState::with_clock(clock.clone()), clock)
}

/// Issue at the store's current generation; this PC's own address is
/// `192.168.1.10` (the issued host).
fn issue(store: &ReachCheckState) -> ReachIssue {
    store
        .issue_with_local_addrs(
            store.generation(),
            target(),
            vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10))],
        )
        .unwrap()
}

fn peer(ip: impl Into<IpAddr>) -> Option<SocketAddr> {
    Some(SocketAddr::new(ip.into(), 40000))
}

fn phone() -> Option<SocketAddr> {
    peer(PHONE)
}

struct Req<'a> {
    token: &'a str,
    peer: Option<SocketAddr>,
    host: Option<&'a str>,
    csrf: bool,
    extra: Vec<(&'static str, &'a str)>,
}

impl<'a> Req<'a> {
    fn new(token: &'a str) -> Self {
        Self {
            token,
            peer: phone(),
            host: Some("192.168.1.10:23456"),
            csrf: true,
            extra: Vec::new(),
        }
    }

    fn build(self) -> HttpRequest<Body> {
        let mut builder =
            HttpRequest::post(REACH_CHECK_PATH).header("content-type", "application/json");
        if self.csrf {
            builder = builder.header("x-banto-client", "banto");
        }
        if let Some(host) = self.host {
            builder = builder.header("host", host);
        }
        for (name, value) in self.extra {
            builder = builder.header(name, value);
        }
        let body = serde_json::json!({ "token": self.token }).to_string();
        let mut req = builder.body(Body::from(body)).unwrap();
        if let Some(peer) = self.peer {
            req.extensions_mut().insert(ConnectInfo(peer));
        }
        req
    }
}

async fn send(router: &Router, req: HttpRequest<Body>) -> (StatusCode, HeaderMapLite, String) {
    let response = router.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let headers = HeaderMapLite {
        retry_after: response
            .headers()
            .get(header::RETRY_AFTER)
            .map(|v| v.to_str().unwrap().to_string()),
        has_auth: response.headers().contains_key(header::AUTHORIZATION)
            || response.headers().contains_key(header::SET_COOKIE),
    };
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, headers, String::from_utf8(bytes.to_vec()).unwrap())
}

struct HeaderMapLite {
    retry_after: Option<String>,
    has_auth: bool,
}

fn result_body(code: &str) -> String {
    format!(r#"{{"result":"{code}"}}"#)
}

async fn post(router: &Router, req: Req<'_>) -> (StatusCode, String) {
    let (status, _, body) = send(router, req.build()).await;
    (status, body)
}

// --- constant-time comparison ---------------------------------------------

#[test]
fn constant_time_eq_compares_bytes() {
    assert!(constant_time_eq(b"abcdef", b"abcdef"));
    assert!(constant_time_eq(b"", b""));
    assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
    assert!(!constant_time_eq(b"abcdef", b"bbcdef"));
    assert!(!constant_time_eq(b"abcdef", b"abcde"));
    assert!(!constant_time_eq(b"abc", b"abcdef"));
}

// --- the happy path -------------------------------------------------------

#[tokio::test]
async fn correct_token_is_recorded_with_the_observed_values() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);

    let (status, headers, body) = send(&router, Req::new(&issued.token).build()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, result_body("recorded"));
    assert!(!body.contains(&issued.token));
    assert!(!headers.has_auth, "the route never hands out a session");

    let status = store.status();
    assert_eq!(status.generation, 0);
    assert_eq!(
        status.records,
        vec![ReachRecord {
            issue_id: issued.issue_id,
            at_ms: WALL_BASE_MS,
            peer_ip: IpAddr::V4(PHONE),
            host: HOST.to_string(),
            port: PORT,
        }]
    );
    let last = status.last_issue.unwrap();
    assert_eq!(last.outcome, ReachOutcome::Recorded);
    assert_eq!(last.issue_id, issued.issue_id);
    assert_eq!(last.expires_in_ms, 0);
}

#[tokio::test]
async fn token_never_appears_in_status_debug_or_records() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    post(&router, Req::new(&issued.token)).await;
    // a pending one, too
    let pending = issue(&store);

    let json = serde_json::to_string(&store.status()).unwrap();
    assert!(!json.contains(&issued.token));
    assert!(!json.contains(&pending.token));
    let debug = format!("{pending:?} {:?} {store:?}", store.status());
    assert!(!debug.contains(&pending.token));
    assert!(debug.contains("<redacted>"));
}

#[tokio::test]
async fn status_serializes_camel_case_codes_and_values() {
    let (store, _clock) = store();
    assert_eq!(
        serde_json::to_value(store.status()).unwrap(),
        serde_json::json!({ "generation": 0, "lastIssue": null, "selfAccessAt": null, "records": [] })
    );
    let issued = issue(&store);
    let value = serde_json::to_value(store.status()).unwrap();
    assert_eq!(
        value["lastIssue"],
        serde_json::json!({
            "issueId": issued.issue_id,
            "host": HOST,
            "port": PORT,
            "expiresAt": WALL_BASE_MS + 300_000,
            "outcome": "pending",
            "expiresInMs": 300_000,
        })
    );
    let router = reach_check_router(store.clone(), 0, PORT);
    post(&router, Req::new(&issued.token)).await;
    let value = serde_json::to_value(store.status()).unwrap();
    assert_eq!(
        value["records"][0],
        serde_json::json!({
            "issueId": issued.issue_id,
            "at": WALL_BASE_MS,
            "peerIp": "192.168.1.50",
            "host": HOST,
            "port": PORT,
        })
    );
    assert_eq!(value["lastIssue"]["outcome"], "recorded");
}

// --- expiry ------------------------------------------------------------------

#[tokio::test]
async fn token_works_just_before_expiry() {
    let (store, clock) = store();
    let issued = issue(&store);
    clock.advance(TOKEN_TTL - Duration::from_millis(1));
    assert_eq!(store.status().last_issue.unwrap().expires_in_ms, 1);
    let router = reach_check_router(store.clone(), 0, PORT);
    assert_eq!(
        post(&router, Req::new(&issued.token)).await,
        (StatusCode::OK, result_body("recorded"))
    );
}

#[tokio::test]
async fn token_is_unusable_at_expiry_and_outcome_becomes_expired() {
    let (store, clock) = store();
    let issued = issue(&store);
    assert_eq!(
        store.status().last_issue.unwrap().outcome,
        ReachOutcome::Pending
    );
    clock.advance(TOKEN_TTL);
    let router = reach_check_router(store.clone(), 0, PORT);
    assert_eq!(
        post(&router, Req::new(&issued.token)).await,
        (StatusCode::NOT_FOUND, result_body("unusable"))
    );
    let status = store.status();
    let last = status.last_issue.unwrap();
    assert_eq!(last.outcome, ReachOutcome::Expired);
    assert_eq!(last.expires_in_ms, 0);
    assert!(status.records.is_empty());
}

#[tokio::test]
async fn status_alone_marks_an_unused_issuance_expired() {
    let (store, clock) = store();
    issue(&store);
    clock.advance(TOKEN_TTL + Duration::from_secs(1));
    assert_eq!(
        store.status().last_issue.unwrap().outcome,
        ReachOutcome::Expired
    );
}

// --- once, one at a time ----------------------------------------------------

#[tokio::test]
async fn token_is_consumed_once() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    assert_eq!(
        post(&router, Req::new(&issued.token)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        post(&router, Req::new(&issued.token)).await,
        (StatusCode::NOT_FOUND, result_body("unusable"))
    );
    assert_eq!(store.status().records.len(), 1);
}

#[tokio::test]
async fn concurrent_requests_record_once() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    let mut handles = Vec::new();
    for _ in 0..8 {
        let router = router.clone();
        let token = issued.token.clone();
        handles.push(tokio::spawn(async move {
            post(&router, Req::new(&token)).await.0
        }));
    }
    let mut ok = 0;
    for handle in handles {
        if handle.await.unwrap() == StatusCode::OK {
            ok += 1;
        }
    }
    assert_eq!(ok, 1);
    assert_eq!(store.status().records.len(), 1);
}

#[tokio::test]
async fn a_new_issuance_revokes_the_previous_token() {
    let (store, _clock) = store();
    let first = issue(&store);
    let second = issue(&store);
    assert!(second.issue_id > first.issue_id);
    let router = reach_check_router(store.clone(), 0, PORT);
    assert_eq!(
        post(&router, Req::new(&first.token)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        post(&router, Req::new(&second.token)).await.0,
        StatusCode::OK
    );
    assert_eq!(store.status().records[0].issue_id, second.issue_id);
}

#[tokio::test]
async fn nothing_is_recorded_without_an_issued_token() {
    let (store, _clock) = store();
    let router = reach_check_router(store.clone(), 0, PORT);
    for token in ["", "anything", "00000000-0000-4000-8000-000000000000"] {
        assert_eq!(
            post(&router, Req::new(token)).await,
            (StatusCode::NOT_FOUND, result_body("unusable"))
        );
    }
    let status = store.status();
    assert!(status.records.is_empty());
    assert!(status.last_issue.is_none());
    assert!(status.self_access_at_ms.is_none());
}

#[tokio::test]
async fn records_keep_only_the_newest() {
    let (store, _clock) = store();
    let router = reach_check_router(store.clone(), 0, PORT);
    let mut ids = Vec::new();
    for _ in 0..(MAX_RECORDS + 2) {
        let issued = issue(&store);
        ids.push(issued.issue_id);
        assert_eq!(
            post(&router, Req::new(&issued.token)).await.0,
            StatusCode::OK
        );
    }
    let records = store.status().records;
    assert_eq!(records.len(), MAX_RECORDS);
    let newest: Vec<u64> = ids.iter().rev().take(MAX_RECORDS).copied().collect();
    assert_eq!(
        records.iter().map(|r| r.issue_id).collect::<Vec<_>>(),
        newest
    );
}

// --- generation ---------------------------------------------------------------

#[tokio::test]
async fn a_new_generation_drops_tokens_and_results() {
    let (store, _clock) = store();
    let recorded = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    post(&router, Req::new(&recorded.token)).await;
    let pending = issue(&store);
    post(
        &router,
        Req::new(&pending.token).peer(peer(Ipv4Addr::LOCALHOST)),
    )
    .await;

    store.begin_generation(1);
    let status = store.status();
    assert_eq!(status.generation, 1);
    assert!(status.last_issue.is_none());
    assert!(status.records.is_empty());
    assert!(status.self_access_at_ms.is_none());

    let new_router = reach_check_router(store.clone(), 1, PORT);
    assert_eq!(
        post(&new_router, Req::new(&pending.token)).await,
        (StatusCode::NOT_FOUND, result_body("unusable"))
    );
}

#[tokio::test]
async fn an_old_generation_router_does_not_record() {
    let (store, _clock) = store();
    store.begin_generation(1);
    let issued = issue(&store);
    assert_eq!(issued.generation, 1);
    let stale_router = reach_check_router(store.clone(), 0, PORT);
    assert_eq!(
        post(&stale_router, Req::new(&issued.token)).await,
        (StatusCode::NOT_FOUND, result_body("unusable"))
    );
    // not consumed by the stale listener: the current one still records it
    let router = reach_check_router(store.clone(), 1, PORT);
    assert_eq!(
        post(&router, Req::new(&issued.token)).await.0,
        StatusCode::OK
    );
}

#[test]
fn issuance_under_a_stale_generation_is_refused() {
    let (store, _clock) = store();
    // The issuer read generation 0, then a listener change advanced it.
    let observed = store.generation();
    store.begin_generation(observed + 1);
    assert_eq!(
        store
            .issue_with_local_addrs(
                observed,
                target(),
                vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10))]
            )
            .unwrap_err(),
        ReachIssueError::StaleGeneration
    );
    assert!(store.status().last_issue.is_none());
}

// --- this PC itself -----------------------------------------------------------

impl<'a> Req<'a> {
    fn peer(mut self, peer: Option<SocketAddr>) -> Self {
        self.peer = peer;
        self
    }

    fn host(mut self, host: Option<&'a str>) -> Self {
        self.host = host;
        self
    }

    fn header(mut self, name: &'static str, value: &'a str) -> Self {
        self.extra.push((name, value));
        self
    }

    fn no_csrf(mut self) -> Self {
        self.csrf = false;
        self
    }
}

#[tokio::test]
async fn this_pc_is_self_access_and_does_not_consume() {
    let (store, clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    let mapped_loopback = IpAddr::V6(Ipv4Addr::LOCALHOST.to_ipv6_mapped());
    let mapped_own = IpAddr::V6(Ipv4Addr::new(192, 168, 1, 10).to_ipv6_mapped());
    for (i, self_peer) in [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
        mapped_loopback,
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)),
        mapped_own,
    ]
    .into_iter()
    .enumerate()
    {
        clock.advance(Duration::from_secs(1));
        assert_eq!(
            post(&router, Req::new(&issued.token).peer(peer(self_peer))).await,
            (StatusCode::OK, result_body("selfAccess")),
            "{self_peer}"
        );
        let status = store.status();
        assert_eq!(
            status.self_access_at_ms,
            Some(WALL_BASE_MS + 1000 * (i as i64 + 1))
        );
        assert!(status.records.is_empty());
        assert_eq!(status.last_issue.unwrap().outcome, ReachOutcome::Pending);
    }
    // still usable from another device
    assert_eq!(
        post(&router, Req::new(&issued.token)).await,
        (StatusCode::OK, result_body("recorded"))
    );
}

#[tokio::test]
async fn a_new_issuance_drops_the_previous_self_access() {
    let (store, _clock) = store();
    let first = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    assert_eq!(
        post(
            &router,
            Req::new(&first.token).peer(peer(Ipv4Addr::LOCALHOST))
        )
        .await,
        (StatusCode::OK, result_body("selfAccess"))
    );
    assert!(store.status().self_access_at_ms.is_some());
    // Issuance B: A's self access is not B's result.
    let second = issue(&store);
    let status = store.status();
    assert!(status.self_access_at_ms.is_none());
    assert_eq!(status.last_issue.unwrap().issue_id, second.issue_id);
}

#[test]
fn issuing_needs_this_pcs_own_addresses() {
    let (store, _clock) = store();
    let target = || ReachTarget {
        host: HOST.to_string(),
        port: PORT,
    };
    // A failed enumeration reaches `issue_with_local_addrs` as no address
    // (or loopback only): nothing is issued, so nothing can be recorded.
    for addrs in [vec![], vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]] {
        assert!(matches!(
            store.issue_with_local_addrs(0, target(), addrs),
            Err(ReachIssueError::LocalAddressesUnavailable)
        ));
    }
    assert!(store.status().last_issue.is_none());
}

#[tokio::test]
async fn the_target_ip_is_always_this_pc() {
    // Even if the enumeration missed the issued address, a request from it is
    // this PC, not another device.
    let (store, _clock) = store();
    let issued = store
        .issue_with_local_addrs(
            0,
            ReachTarget {
                host: HOST.to_string(),
                port: PORT,
            },
            vec![IpAddr::V4(Ipv4Addr::new(10, 9, 9, 9))],
        )
        .unwrap();
    let router = reach_check_router(store.clone(), 0, PORT);
    let own: IpAddr = HOST.parse().unwrap();
    assert_eq!(
        post(&router, Req::new(&issued.token).peer(peer(own)))
            .await
            .1,
        result_body("selfAccess")
    );
    assert!(store.status().records.is_empty());
}

#[tokio::test]
async fn self_access_needs_the_issued_url_first() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    // A changed Host from this PC is a host mismatch, not a self access.
    assert_eq!(
        post(
            &router,
            Req::new(&issued.token)
                .peer(peer(Ipv4Addr::LOCALHOST))
                .host(Some("127.0.0.1:23456"))
        )
        .await
        .1,
        result_body("hostMismatch")
    );
    // A router of another port: also a mismatch, not a self access.
    let other = reach_check_router(store.clone(), 0, PORT + 1);
    assert_eq!(
        post(
            &other,
            Req::new(&issued.token).peer(peer(Ipv4Addr::LOCALHOST))
        )
        .await
        .1,
        result_body("hostMismatch")
    );
    assert!(store.status().self_access_at_ms.is_none());
}

#[tokio::test]
async fn unknown_peer_is_refused() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    assert_eq!(
        post(&router, Req::new(&issued.token).peer(None)).await,
        (StatusCode::FORBIDDEN, result_body("unusable"))
    );
    // not consumed
    assert_eq!(
        post(&router, Req::new(&issued.token)).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn x_forwarded_for_is_ignored() {
    let (store, _clock) = store();
    let router = reach_check_router(store.clone(), 0, PORT);

    // A loopback socket peer stays "this PC" whatever the header claims.
    let issued = issue(&store);
    assert_eq!(
        post(
            &router,
            Req::new(&issued.token)
                .peer(peer(Ipv4Addr::LOCALHOST))
                .header("x-forwarded-for", "192.168.1.77")
        )
        .await,
        (StatusCode::OK, result_body("selfAccess"))
    );
    // A LAN socket peer is recorded as itself, not as the claimed address.
    assert_eq!(
        post(
            &router,
            Req::new(&issued.token)
                .header("x-forwarded-for", "127.0.0.1")
                .header("forwarded", "for=127.0.0.1")
        )
        .await,
        (StatusCode::OK, result_body("recorded"))
    );
    assert_eq!(store.status().records[0].peer_ip, IpAddr::V4(PHONE));
}

// --- Host ---------------------------------------------------------------------

#[tokio::test]
async fn host_mismatch_does_not_consume() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    for host in [
        Some("192.168.1.11:23456"),
        Some("192.168.1.10:23457"),
        Some("192.168.1.10"),
        Some("evil.example:23456"),
        Some("192.168.1.10:"),
        Some("192.168.1.10:99999"),
        None,
    ] {
        assert_eq!(
            post(&router, Req::new(&issued.token).host(host)).await,
            (StatusCode::CONFLICT, result_body("hostMismatch")),
            "{host:?}"
        );
    }
    assert_eq!(
        store.status().last_issue.unwrap().outcome,
        ReachOutcome::Pending
    );
    assert!(store.status().records.is_empty());
    // 7 failures so far, under the limit: the token is still there
    assert_eq!(
        post(&router, Req::new(&issued.token)).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn several_host_headers_are_a_mismatch() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    assert_eq!(
        post(
            &router,
            Req::new(&issued.token).header("host", "192.168.1.10:23456")
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn host_name_matches_case_insensitively() {
    let (store, _clock) = store();
    let issued = store
        .issue_with_local_addrs(
            0,
            ReachTarget {
                host: "office-pc.local".to_string(),
                port: PORT,
            },
            vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10))],
        )
        .unwrap();
    let router = reach_check_router(store.clone(), 0, PORT);
    assert_eq!(
        post(
            &router,
            Req::new(&issued.token).host(Some("Office-PC.LOCAL:23456"))
        )
        .await,
        (StatusCode::OK, result_body("recorded"))
    );
    assert_eq!(store.status().records[0].host, "office-pc.local");
}

#[tokio::test]
async fn a_listener_on_another_port_is_a_mismatch() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT + 1);
    assert_eq!(
        post(
            &router,
            Req::new(&issued.token).host(Some("192.168.1.10:23457"))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[test]
fn authority_matching() {
    assert!(authority_matches("192.168.1.10:80", "192.168.1.10", 80));
    assert!(authority_matches("192.168.1.10", "192.168.1.10", 80));
    assert!(!authority_matches("192.168.1.10", "192.168.1.10", 8080));
    assert!(authority_matches("[fe80::1]:8080", "[fe80::1]", 8080));
    assert!(!authority_matches("[fe80::1:8080", "[fe80::1]", 8080));
    assert!(!authority_matches(":8080", "", 8080));
    assert!(!authority_matches("host:+80", "host", 80));
}

// --- rate limit ---------------------------------------------------------------

#[tokio::test]
async fn ten_failures_block_the_ip_without_checking() {
    let (store, clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    for _ in 0..RATE_LIMIT_FAILURES {
        assert_eq!(
            post(&router, Req::new("wrong")).await.0,
            StatusCode::NOT_FOUND
        );
    }
    // even the right token is not compared now
    let (status, headers, body) = send(&router, Req::new(&issued.token).build()).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body, result_body("rateLimited"));
    assert_eq!(headers.retry_after.as_deref(), Some("60"));
    assert_eq!(
        store.status().last_issue.unwrap().outcome,
        ReachOutcome::Pending
    );

    // another IP is unaffected (a host mismatch, which is not a block)
    assert_eq!(
        post(
            &router,
            Req::new(&issued.token)
                .peer(peer(Ipv4Addr::new(192, 168, 1, 51)))
                .host(Some("x:1"))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );

    clock.advance(Duration::from_secs(30));
    let (_, headers, _) = send(&router, Req::new(&issued.token).build()).await;
    assert_eq!(headers.retry_after.as_deref(), Some("30"));

    clock.advance(Duration::from_secs(30));
    assert_eq!(
        post(&router, Req::new(&issued.token)).await,
        (StatusCode::OK, result_body("recorded"))
    );
}

#[tokio::test]
async fn host_mismatches_count_as_failures() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    for _ in 0..RATE_LIMIT_FAILURES {
        post(&router, Req::new(&issued.token).host(Some("x:1"))).await;
    }
    assert_eq!(
        post(&router, Req::new(&issued.token)).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn successes_and_self_access_are_not_counted() {
    let (store, _clock) = store();
    let router = reach_check_router(store.clone(), 0, PORT);
    for _ in 0..(RATE_LIMIT_FAILURES - 1) {
        post(&router, Req::new("wrong")).await;
    }
    let issued = issue(&store);
    // 9 failures + this success: a counted success would block the next one
    assert_eq!(
        post(&router, Req::new(&issued.token)).await.0,
        StatusCode::OK
    );
    let issued = issue(&store);
    assert_eq!(
        post(&router, Req::new(&issued.token)).await,
        (StatusCode::OK, result_body("recorded"))
    );
    let issued = issue(&store);
    for _ in 0..3 {
        assert_eq!(
            post(
                &router,
                Req::new(&issued.token).peer(peer(Ipv4Addr::LOCALHOST))
            )
            .await
            .0,
            StatusCode::OK
        );
    }
}

#[tokio::test]
async fn the_failure_window_resets_after_a_minute() {
    let (store, clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    for _ in 0..(RATE_LIMIT_FAILURES - 1) {
        post(&router, Req::new("wrong")).await;
    }
    clock.advance(RATE_LIMIT_WINDOW);
    for _ in 0..(RATE_LIMIT_FAILURES - 1) {
        post(&router, Req::new("wrong")).await;
    }
    assert_eq!(
        post(&router, Req::new(&issued.token)).await.0,
        StatusCode::OK
    );
}

#[test]
fn the_failure_table_is_bounded() {
    let (store, clock) = store();
    let first = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 0)), 1);
    store.check(Some(first), 0, PORT, None, "wrong");
    for i in 1..=(RATE_LIMIT_TABLE_CAP as u32 + 10) {
        clock.advance(Duration::from_millis(1));
        let ip = Ipv4Addr::from(u32::from(Ipv4Addr::new(10, 0, 0, 0)) + i);
        store.check(
            Some(SocketAddr::new(IpAddr::V4(ip), 1)),
            0,
            PORT,
            None,
            "wrong",
        );
    }
    let inner = store.lock();
    assert_eq!(inner.failures.len(), RATE_LIMIT_TABLE_CAP);
    assert!(
        !inner.failures.contains_key(&first.ip()),
        "the least recently seen IP is evicted first"
    );
}

#[test]
fn a_blocked_peer_that_keeps_trying_is_not_evicted_first() {
    let (store, clock) = store();
    let blocked = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 1, 0, 1)), 1);
    for _ in 0..RATE_LIMIT_FAILURES {
        store.check(Some(blocked), 0, PORT, None, "wrong");
    }
    // Fill the table with other peers, the blocked one retrying meanwhile.
    for i in 1..=(RATE_LIMIT_TABLE_CAP as u32 + 10) {
        clock.advance(Duration::from_millis(1));
        let ip = Ipv4Addr::from(u32::from(Ipv4Addr::new(10, 2, 0, 0)) + i);
        store.check(
            Some(SocketAddr::new(IpAddr::V4(ip), 1)),
            0,
            PORT,
            None,
            "wrong",
        );
        assert!(matches!(
            store.check(Some(blocked), 0, PORT, None, "wrong"),
            CheckOutcome::RateLimited(_)
        ));
    }
    assert!(store.lock().failures.contains_key(&blocked.ip()));
}

// --- outside authorization ------------------------------------------------------

#[tokio::test]
async fn csrf_header_is_required_and_nothing_is_consumed() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let router = reach_check_router(store.clone(), 0, PORT);
    assert_eq!(
        post(&router, Req::new(&issued.token).no_csrf()).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        post(&router, Req::new(&issued.token)).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_body_that_is_not_json_is_rejected_by_the_extractor() {
    let (store, _clock) = store();
    let router = reach_check_router(store.clone(), 0, PORT);
    let mut req = HttpRequest::post(REACH_CHECK_PATH)
        .header("content-type", "application/json")
        .header("x-banto-client", "banto")
        .header("host", "192.168.1.10:23456")
        .body(Body::from("not json"))
        .unwrap();
    req.extensions_mut().insert(ConnectInfo(phone().unwrap()));
    assert_eq!(send(&router, req).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn other_api_routes_stay_unauthorized_after_a_success() {
    let (store, _clock) = store();
    let issued = issue(&store);
    let auth = AuthState::new(
        |_u: String, _p: String| Box::pin(async { None }),
        SessionValidation::DisabledNoRevocation,
    );
    let protected = Router::new()
        .route("/api/items/list", get(|| async { "items" }))
        .layer(middleware::from_fn_with_state(auth, require_auth));
    let router = reach_check_router(store.clone(), 0, PORT).merge(protected);

    let (status, headers, body) = send(&router, Req::new(&issued.token).build()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, result_body("recorded"));
    assert!(!headers.has_auth);

    let mut req = HttpRequest::get("/api/items/list")
        .header("x-banto-client", "banto")
        .body(Body::empty())
        .unwrap();
    req.extensions_mut().insert(ConnectInfo(phone().unwrap()));
    assert_eq!(send(&router, req).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn other_methods_are_not_routed() {
    let (store, _clock) = store();
    let router = reach_check_router(store, 0, PORT);
    let req = HttpRequest::get(REACH_CHECK_PATH)
        .header("x-banto-client", "banto")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&router, req).await.0, StatusCode::METHOD_NOT_ALLOWED);
}
