use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Request as HttpRequest;
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use banto_core::BantoError;
use tower::ServiceExt;

use super::*;
use crate::grant::{GrantKind, GrantSpec};

fn demo_auth() -> AuthState {
    AuthState::new(
        |u: String, p: String| {
            Box::pin(async move {
                if u == "admin" && p == "admin" {
                    Some(Identity {
                        id: "admin".to_string(),
                        name: "管理者".to_string(),
                        role: "admin".to_string(),
                    })
                } else {
                    None
                }
            })
        },
        SessionValidation::DisabledNoRevocation,
    )
}

async fn body_json(response: Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn login_wrong_credentials_returns_success_false() {
    let router = auth_routes(demo_auth());
    let response = router
        .oneshot(
            HttpRequest::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"username":"admin","password":"nope"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["success"], false);
    assert!(json["token"].is_null());
}

#[tokio::test]
async fn login_right_credentials_returns_token() {
    let router = auth_routes(demo_auth());
    let response = router
        .oneshot(
            HttpRequest::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"username":"admin","password":"admin"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_json(response).await;
    assert_eq!(json["success"], true);
    assert!(json["token"].as_str().is_some());
}

#[tokio::test]
async fn logout_invalidates_token() {
    let auth = demo_auth();
    let token = auth
        .login("admin", "admin")
        .await
        .expect("login should succeed");
    assert!(auth.verify(&token));
    auth.logout(&token);
    assert!(!auth.verify(&token));
}

#[tokio::test]
async fn identity_for_returns_the_identity_bound_to_the_token() {
    let auth = demo_auth();
    let token = auth
        .login("admin", "admin")
        .await
        .expect("login should succeed");
    let identity = auth.identity_for(&token).expect("identity should exist");
    assert_eq!(identity.id, "admin");
    assert_eq!(identity.name, "管理者");
}

#[tokio::test]
async fn identity_for_is_none_for_an_invalid_token() {
    let auth = demo_auth();
    assert!(auth.identity_for("not-a-real-token").is_none());
}

#[tokio::test]
async fn issue_token_logs_in_without_calling_verify_credentials() {
    let auth = demo_auth();
    let token = auth.issue_token(Identity {
        id: "owner".to_string(),
        name: "オーナー".to_string(),
        role: "admin".to_string(),
    });
    assert!(auth.verify(&token));
    assert_eq!(auth.identity_for(&token).unwrap().id, "owner");
}

// --- Token expiry (spec §11.2) ---------------------------------------

/// A small, fast policy so the expiry tests read clearly; the clock is
/// frozen and advanced by hand, so the durations are just relative.
fn short_token_policy() -> TokenPolicy {
    TokenPolicy {
        absolute_ttl: Duration::from_secs(100),
        idle_ttl: Duration::from_secs(30),
    }
}

fn frozen_auth(token_policy: TokenPolicy, rate_limit: RateLimitPolicy) -> AuthState {
    frozen_auth_with_remembered(token_policy, TokenPolicy::remembered_default(), rate_limit)
}

/// Like [`frozen_auth`], but also lets a test override the "Remember me"
/// policy (spec M11) instead of [`TokenPolicy::remembered_default`].
fn frozen_auth_with_remembered(
    token_policy: TokenPolicy,
    remembered_policy: TokenPolicy,
    rate_limit: RateLimitPolicy,
) -> AuthState {
    AuthState::with_frozen_clock(
        |u: String, p: String| {
            Box::pin(async move {
                if u == "admin" && p == "admin" {
                    Some(Identity {
                        id: "admin".to_string(),
                        name: "管理者".to_string(),
                        role: "admin".to_string(),
                    })
                } else {
                    None
                }
            })
        },
        SessionValidation::DisabledNoRevocation,
        token_policy,
        remembered_policy,
        rate_limit,
    )
}

#[tokio::test]
async fn token_expires_after_absolute_ttl_even_with_activity() {
    let auth = frozen_auth(short_token_policy(), RateLimitPolicy::default());
    let token = auth.login("admin", "admin").await.unwrap();

    // Keep "using" it just under the idle timeout each step, so idle
    // expiry never fires - only the absolute cap should eventually kill it.
    // Three steps of 25s = 75s elapsed, all within absolute_ttl (100s).
    for _ in 0..3 {
        auth.advance(Duration::from_secs(25));
        assert!(auth.verify(&token), "should survive within absolute_ttl");
    }
    // One more step: 100s since issue == absolute_ttl. The token is still
    // well within its idle window (last used 25s ago), yet the absolute
    // cap must kill it anyway - activity cannot extend it past this.
    auth.advance(Duration::from_secs(25));
    assert!(!auth.verify(&token), "should be dead past absolute_ttl");
}

#[tokio::test]
async fn token_expires_after_idle_timeout() {
    let auth = frozen_auth(short_token_policy(), RateLimitPolicy::default());
    let token = auth.login("admin", "admin").await.unwrap();

    auth.advance(Duration::from_secs(31)); // > idle_ttl, no use in between
    assert!(!auth.verify(&token), "should lapse after idle_ttl");
}

#[tokio::test]
async fn verify_refreshes_the_idle_window() {
    let auth = frozen_auth(short_token_policy(), RateLimitPolicy::default());
    let token = auth.login("admin", "admin").await.unwrap();

    // Use it every 20s (< 30s idle_ttl): the sliding window keeps
    // resetting, so it stays alive well past a single idle period.
    for _ in 0..3 {
        auth.advance(Duration::from_secs(20));
        assert!(auth.verify(&token));
    }
    // Now go quiet past the idle timeout -> lapses.
    auth.advance(Duration::from_secs(31));
    assert!(!auth.verify(&token));
}

#[tokio::test]
async fn issue_token_sweeps_expired_tokens() {
    let auth = frozen_auth(short_token_policy(), RateLimitPolicy::default());
    let stale = auth.login("admin", "admin").await.unwrap();

    auth.advance(Duration::from_secs(200)); // well past absolute_ttl
                                            // A write (issuing a fresh token) should opportunistically drop the
                                            // stale one rather than leave it lingering in the map.
    let fresh = auth.issue_token(Identity {
        id: "admin".to_string(),
        name: "管理者".to_string(),
        role: "admin".to_string(),
    });
    assert!(auth.verify(&fresh));
    assert_eq!(
        auth.inner.tokens.read().unwrap().len(),
        1,
        "the expired token should have been swept on write"
    );
    assert!(!auth.inner.tokens.read().unwrap().contains_key(&stale));
}

// --- Login rate limiting (spec §11.2) --------------------------------

/// Auth state whose verifier counts how many times it actually ran, so a
/// test can prove a locked-out attempt short-circuits *before* the
/// (expensive) credential check.
fn counting_auth(rate_limit: RateLimitPolicy) -> (AuthState, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let auth = AuthState::with_frozen_clock(
        move |u: String, p: String| {
            let counter = counter.clone();
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                if u == "admin" && p == "admin" {
                    Some(Identity {
                        id: "admin".to_string(),
                        name: "管理者".to_string(),
                        role: "admin".to_string(),
                    })
                } else {
                    None
                }
            })
        },
        SessionValidation::DisabledNoRevocation,
        TokenPolicy::default(),
        TokenPolicy::remembered_default(),
        rate_limit,
    );
    (auth, calls)
}

/// A state whose verifier parks on `gate` (a semaphore the test releases)
/// after counting its entry, always rejecting. Returns the state, the
/// number of verifier entries, and the peak number inside at once.
fn gated_auth(
    rate_limit: RateLimitPolicy,
) -> (
    AuthState,
    Arc<tokio::sync::Semaphore>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
) {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let entered = Arc::new(AtomicUsize::new(0));
    let inside = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let (g, e, i, p) = (gate.clone(), entered.clone(), inside.clone(), peak.clone());
    let auth = AuthState::with_frozen_clock(
        move |_u: String, _p: String| {
            let (g, e, i, p) = (g.clone(), e.clone(), i.clone(), p.clone());
            Box::pin(async move {
                e.fetch_add(1, Ordering::SeqCst);
                let now_inside = i.fetch_add(1, Ordering::SeqCst) + 1;
                p.fetch_max(now_inside, Ordering::SeqCst);
                let _permit = g.acquire().await.expect("gate closed");
                i.fetch_sub(1, Ordering::SeqCst);
                None
            })
        },
        SessionValidation::DisabledNoRevocation,
        TokenPolicy::default(),
        TokenPolicy::remembered_default(),
        rate_limit,
    );
    (auth, gate, entered, peak)
}

/// Let every spawned task run until it parks (in the verifier) or ends.
/// Single-threaded runtime, so yielding is deterministic: no sleeps.
/// `entered` is the verifier-entry counter and `expected_entered` how many
/// attempts must have reached it; `parked` of those stay parked, every
/// other task must have finished.
async fn settle(
    handles: &[tokio::task::JoinHandle<LoginOutcome>],
    entered: &AtomicUsize,
    expected_entered: usize,
    parked: usize,
) {
    for _ in 0..1000 {
        let finished = handles.iter().filter(|h| h.is_finished()).count();
        if entered.load(Ordering::SeqCst) == expected_entered && finished + parked == handles.len()
        {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("tasks did not settle");
}

async fn drain(handles: Vec<tokio::task::JoinHandle<LoginOutcome>>) -> (usize, usize) {
    let (mut invalid, mut limited) = (0, 0);
    for h in handles {
        match h.await.expect("login task panicked") {
            LoginOutcome::InvalidCredentials => invalid += 1,
            LoginOutcome::RateLimited { .. } => limited += 1,
            other => panic!("unexpected outcome {other:?}"),
        }
    }
    (invalid, limited)
}

fn in_flight_total(auth: &AuthState) -> usize {
    auth.inner.in_flight.lock().unwrap().total
}

#[tokio::test]
async fn concurrent_same_ip_and_username_logins_are_capped_before_the_verifier() {
    // Issue #279: 64 simultaneous attempts, none failed yet. Without
    // in-flight accounting all 64 would enter the verifier.
    let (auth, gate, entered, peak) = gated_auth(RateLimitPolicy::default());
    let ip = Some(IpAddr::from([203, 0, 113, 7]));
    let handles: Vec<_> = (0..64)
        .map(|_| {
            let auth = auth.clone();
            tokio::spawn(async move { auth.login_rate_limited(ip, "alice", "x", false).await })
        })
        .collect();
    settle(
        &handles,
        &entered,
        MAX_IN_FLIGHT_PER_IP,
        MAX_IN_FLIGHT_PER_IP,
    )
    .await;
    assert_eq!(entered.load(Ordering::SeqCst), MAX_IN_FLIGHT_PER_IP);
    assert_eq!(in_flight_total(&auth), MAX_IN_FLIGHT_PER_IP);

    gate.add_permits(64);
    let (invalid, limited) = drain(handles).await;
    assert_eq!(invalid, MAX_IN_FLIGHT_PER_IP);
    assert_eq!(limited, 64 - MAX_IN_FLIGHT_PER_IP);
    assert!(peak.load(Ordering::SeqCst) <= MAX_IN_FLIGHT_PER_IP);
    assert_eq!(in_flight_total(&auth), 0, "every slot released");
}

#[tokio::test]
async fn concurrent_username_rotation_from_one_ip_is_capped() {
    let (auth, gate, entered, _peak) = gated_auth(RateLimitPolicy::default());
    let ip = Some(IpAddr::from([203, 0, 113, 7]));
    let handles: Vec<_> = (0..64)
        .map(|i| {
            let auth = auth.clone();
            tokio::spawn(async move {
                auth.login_rate_limited(ip, &format!("user{i}"), "x", false)
                    .await
            })
        })
        .collect();
    settle(
        &handles,
        &entered,
        MAX_IN_FLIGHT_PER_IP,
        MAX_IN_FLIGHT_PER_IP,
    )
    .await;
    assert_eq!(entered.load(Ordering::SeqCst), MAX_IN_FLIGHT_PER_IP);
    gate.add_permits(64);
    drain(handles).await;
    assert_eq!(in_flight_total(&auth), 0);
}

#[tokio::test]
async fn concurrent_logins_from_many_ips_hit_the_global_cap() {
    let (auth, gate, entered, peak) = gated_auth(RateLimitPolicy::default());
    let handles: Vec<_> = (0..64u8)
        .map(|i| {
            let auth = auth.clone();
            let ip = Some(IpAddr::from([198, 51, 100, i]));
            tokio::spawn(async move { auth.login_rate_limited(ip, "alice", "x", false).await })
        })
        .collect();
    settle(
        &handles,
        &entered,
        MAX_CONCURRENT_VERIFICATIONS,
        MAX_CONCURRENT_VERIFICATIONS,
    )
    .await;
    assert_eq!(entered.load(Ordering::SeqCst), MAX_CONCURRENT_VERIFICATIONS);
    gate.add_permits(64);
    let (invalid, limited) = drain(handles).await;
    assert_eq!(invalid, MAX_CONCURRENT_VERIFICATIONS);
    assert_eq!(limited, 64 - MAX_CONCURRENT_VERIFICATIONS);
    assert!(peak.load(Ordering::SeqCst) <= MAX_CONCURRENT_VERIFICATIONS);
    assert_eq!(in_flight_total(&auth), 0);
}

#[tokio::test]
async fn in_flight_attempts_count_toward_the_failure_threshold() {
    // Two failures recorded + max_failures 3: only ONE more attempt may
    // be in flight, even though the per-IP cap would allow four.
    let policy = RateLimitPolicy {
        max_failures: 3,
        max_ip_failures: 100,
        lockout: Duration::from_secs(60),
    };
    let (auth, gate, entered, _peak) = gated_auth(policy);
    gate.add_permits(2);
    let ip = Some(IpAddr::from([203, 0, 113, 7]));
    for _ in 0..2 {
        assert!(matches!(
            auth.login_rate_limited(ip, "alice", "x", false).await,
            LoginOutcome::InvalidCredentials
        ));
    }
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let auth = auth.clone();
            tokio::spawn(async move { auth.login_rate_limited(ip, "alice", "x", false).await })
        })
        .collect();
    settle(&handles, &entered, 3, 0).await;
    assert_eq!(entered.load(Ordering::SeqCst), 3);
    gate.add_permits(8);
    let (invalid, limited) = drain(handles).await;
    assert_eq!((invalid, limited), (1, 7));
}

#[tokio::test]
async fn cancelled_attempts_release_their_slots() {
    let (auth, gate, entered, _peak) = gated_auth(RateLimitPolicy::default());
    let ip = Some(IpAddr::from([203, 0, 113, 7]));
    let handles: Vec<_> = (0..MAX_IN_FLIGHT_PER_IP)
        .map(|_| {
            let auth = auth.clone();
            tokio::spawn(async move { auth.login_rate_limited(ip, "alice", "x", false).await })
        })
        .collect();
    settle(
        &handles,
        &entered,
        MAX_IN_FLIGHT_PER_IP,
        MAX_IN_FLIGHT_PER_IP,
    )
    .await;
    assert_eq!(in_flight_total(&auth), MAX_IN_FLIGHT_PER_IP);

    // Client disconnects: the futures are dropped mid-verifier.
    for h in &handles {
        h.abort();
    }
    for h in handles {
        assert!(h.await.unwrap_err().is_cancelled());
    }
    assert_eq!(
        in_flight_total(&auth),
        0,
        "cancellation must not leak slots"
    );
    assert!(auth.inner.in_flight.lock().unwrap().per_key.is_empty());

    // And a fresh attempt is admitted (cancelled ones recorded no failure).
    gate.add_permits(1);
    assert!(matches!(
        auth.login_rate_limited(ip, "alice", "x", false).await,
        LoginOutcome::InvalidCredentials
    ));
    assert_eq!(entered.load(Ordering::SeqCst), MAX_IN_FLIGHT_PER_IP + 1);
}

#[tokio::test]
async fn success_and_failure_release_slots_and_keep_sequential_policy() {
    let (auth, calls) = counting_auth(RateLimitPolicy {
        max_failures: 3,
        max_ip_failures: 100,
        lockout: Duration::from_secs(60),
    });
    let ip = Some(IpAddr::from([203, 0, 113, 7]));
    for _ in 0..2 {
        auth.login_rate_limited(ip, "admin", "bad", false).await;
    }
    assert!(matches!(
        auth.login_rate_limited(ip, "admin", "admin", false).await,
        LoginOutcome::Success(_)
    ));
    assert_eq!(in_flight_total(&auth), 0);
    // success reset the streak: two more failures do not lock out...
    for _ in 0..2 {
        auth.login_rate_limited(ip, "admin", "bad", false).await;
    }
    // ...the third does, after which the verifier is not consulted.
    auth.login_rate_limited(ip, "admin", "bad", false).await;
    let before = calls.load(Ordering::SeqCst);
    assert!(matches!(
        auth.login_rate_limited(ip, "admin", "admin", false).await,
        LoginOutcome::RateLimited { .. }
    ));
    assert_eq!(calls.load(Ordering::SeqCst), before);
    assert_eq!(in_flight_total(&auth), 0);
}

#[tokio::test]
async fn login_locks_out_after_max_consecutive_failures() {
    let policy = RateLimitPolicy {
        max_failures: 3,
        max_ip_failures: 100,
        lockout: Duration::from_secs(60),
    };
    let (auth, calls) = counting_auth(policy);
    for _ in 0..3 {
        assert!(matches!(
            auth.login_rate_limited(None, "admin", "wrong", false).await,
            LoginOutcome::InvalidCredentials
        ));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 3, "3 real checks so far");

    // The 4th attempt is locked out and must NOT run the verifier.
    match auth.login_rate_limited(None, "admin", "wrong", false).await {
        LoginOutcome::RateLimited { retry_after } => {
            assert!(retry_after <= Duration::from_secs(60));
        }
        other => panic!("expected RateLimited, got {other:?}"),
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        3,
        "locked-out attempt must short-circuit the verifier"
    );

    // Even the CORRECT password is refused while locked out.
    assert!(matches!(
        auth.login_rate_limited(None, "admin", "admin", false).await,
        LoginOutcome::RateLimited { .. }
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn lockout_expires_after_the_cooloff() {
    let policy = RateLimitPolicy {
        max_failures: 3,
        max_ip_failures: 100,
        lockout: Duration::from_secs(60),
    };
    let (auth, _calls) = counting_auth(policy);
    for _ in 0..3 {
        auth.login_rate_limited(None, "admin", "wrong", false).await;
    }
    assert!(matches!(
        auth.login_rate_limited(None, "admin", "admin", false).await,
        LoginOutcome::RateLimited { .. }
    ));

    auth.advance(Duration::from_secs(61)); // ride out the cool-off
    match auth.login_rate_limited(None, "admin", "admin", false).await {
        LoginOutcome::Success(token) => assert!(auth.verify(&token)),
        other => panic!("expected Success after cool-off, got {other:?}"),
    }
}

#[tokio::test]
async fn success_resets_the_failure_streak() {
    let policy = RateLimitPolicy {
        max_failures: 3,
        max_ip_failures: 100,
        lockout: Duration::from_secs(60),
    };
    let (auth, _calls) = counting_auth(policy);
    // Two failures (one short of the threshold)...
    auth.login_rate_limited(None, "admin", "wrong", false).await;
    auth.login_rate_limited(None, "admin", "wrong", false).await;
    // ...then a success clears the streak.
    assert!(matches!(
        auth.login_rate_limited(None, "admin", "admin", false).await,
        LoginOutcome::Success(_)
    ));
    // Two more failures should NOT lock out (streak restarted at 0).
    auth.login_rate_limited(None, "admin", "wrong", false).await;
    assert!(matches!(
        auth.login_rate_limited(None, "admin", "wrong", false).await,
        LoginOutcome::InvalidCredentials
    ));
}

#[tokio::test]
async fn per_ip_dimension_bounds_a_username_rotation_flood() {
    // Regression: without a username-independent per-IP limit, an attacker
    // on one IP evades the per-(IP,username) lockout by varying `username`
    // every request, keeping the argon2 verifier busy indefinitely (a
    // CPU/memory DoS). max_ip_failures must trip regardless of username.
    let policy = RateLimitPolicy {
        max_failures: 5,
        max_ip_failures: 3,
        lockout: Duration::from_secs(60),
    };
    let (auth, calls) = counting_auth(policy);
    let ip = Some(IpAddr::from([203, 0, 113, 7]));

    // Three failures, each under a DIFFERENT username: the per-account
    // lockout (threshold 5) never trips, but the per-IP one (threshold 3)
    // does.
    for i in 0..3 {
        let username = format!("victim{i}");
        assert!(matches!(
            auth.login_rate_limited(ip, &username, "wrong", false).await,
            LoginOutcome::InvalidCredentials
        ));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 3, "3 real checks so far");

    // The 4th attempt - yet another fresh username - is now locked out by
    // the IP dimension WITHOUT running the verifier (argon2 is capped).
    match auth
        .login_rate_limited(ip, "victim-new", "wrong", false)
        .await
    {
        LoginOutcome::RateLimited { retry_after } => {
            assert!(retry_after <= Duration::from_secs(60))
        }
        other => panic!("expected RateLimited from the IP dimension, got {other:?}"),
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        3,
        "IP-locked attempt must short-circuit the verifier"
    );

    // A DIFFERENT IP is unaffected - the lockout is per-address.
    let other_ip = Some(IpAddr::from([203, 0, 113, 8]));
    assert!(matches!(
        auth.login_rate_limited(other_ip, "victim0", "wrong", false)
            .await,
        LoginOutcome::InvalidCredentials
    ));
}

#[tokio::test]
async fn per_ip_dimension_leaves_headroom_above_the_account_threshold() {
    // The IP threshold is deliberately higher than the per-account one so
    // a shared NAT with a few genuinely-fumbling users isn't tripped by
    // normal misses. Below max_ip_failures, distinct-username failures
    // from one IP keep returning InvalidCredentials (not RateLimited).
    let policy = RateLimitPolicy {
        max_failures: 5,
        max_ip_failures: 4,
        lockout: Duration::from_secs(60),
    };
    let (auth, _calls) = counting_auth(policy);
    let ip = Some(IpAddr::from([198, 51, 100, 20]));

    for i in 0..3 {
        let username = format!("user{i}");
        assert!(matches!(
            auth.login_rate_limited(ip, &username, "wrong", false).await,
            LoginOutcome::InvalidCredentials
        ));
    }
    // A legitimate success from the same IP then clears the IP streak...
    assert!(matches!(
        auth.login_rate_limited(ip, "admin", "admin", false).await,
        LoginOutcome::Success(_)
    ));
    // ...so the counter restarts and 3 more distinct-user misses still do
    // not lock the IP (would have, had the streak not reset at 4).
    for i in 0..3 {
        let username = format!("again{i}");
        assert!(matches!(
            auth.login_rate_limited(ip, &username, "wrong", false).await,
            LoginOutcome::InvalidCredentials
        ));
    }
}

// --- Remember me (spec M11) --------------------------------------------

#[tokio::test]
async fn remembered_token_survives_the_regular_absolute_ttl_but_not_forever() {
    let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
    let token = match auth.login_rate_limited(None, "admin", "admin", true).await {
        LoginOutcome::Success(token) => token,
        other => panic!("expected Success, got {other:?}"),
    };

    // Well past the regular 8h absolute_ttl - a non-remembered token
    // would be dead by now (see `token_expires_after_absolute_ttl_even_with_activity`).
    auth.advance(TokenPolicy::default().absolute_ttl + Duration::from_secs(60));
    assert!(
        auth.verify(&token),
        "remember:true should survive past the regular TokenPolicy's absolute_ttl"
    );

    // But it is not immortal: past the remembered policy's own absolute
    // bound, it must lapse too.
    auth.advance(TokenPolicy::remembered_default().absolute_ttl);
    assert!(
        !auth.verify(&token),
        "remembered tokens must still expire at their own absolute_ttl"
    );
}

#[tokio::test]
async fn non_remembered_login_still_uses_the_regular_policy() {
    let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
    let token = match auth.login_rate_limited(None, "admin", "admin", false).await {
        LoginOutcome::Success(token) => token,
        other => panic!("expected Success, got {other:?}"),
    };

    auth.advance(TokenPolicy::default().absolute_ttl + Duration::from_secs(60));
    assert!(
        !auth.verify(&token),
        "remember:false (the default) must still expire at the regular absolute_ttl"
    );
}

#[tokio::test]
async fn login_handler_remember_true_issues_a_long_lived_token() {
    let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
    let router = auth_routes(auth.clone());

    let response = router
        .oneshot(
            HttpRequest::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"username":"admin","password":"admin","remember":true}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_json(response).await;
    assert_eq!(json["success"], true);
    let token = json["token"].as_str().expect("token").to_string();

    auth.advance(TokenPolicy::default().absolute_ttl + Duration::from_secs(60));
    assert!(
        auth.verify(&token),
        "POST /api/auth/login with remember:true should issue a remembered token"
    );
}

#[tokio::test]
async fn login_handler_omitting_remember_defaults_to_false() {
    // No `remember` field at all (older-frontend-shaped request body) -
    // must behave exactly like the pre-M11 wire contract.
    let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
    let router = auth_routes(auth.clone());

    let response = router
        .oneshot(
            HttpRequest::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"username":"admin","password":"admin"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let token = body_json(response).await["token"]
        .as_str()
        .expect("token")
        .to_string();

    auth.advance(TokenPolicy::default().absolute_ttl + Duration::from_secs(60));
    assert!(
        !auth.verify(&token),
        "omitting remember must default to false (regular policy)"
    );
}

#[tokio::test]
async fn login_handler_returns_429_after_lockout() {
    let policy = RateLimitPolicy {
        max_failures: 2,
        max_ip_failures: 100,
        lockout: Duration::from_secs(60),
    };
    let auth = frozen_auth(TokenPolicy::default(), policy);
    let router = auth_routes(auth);

    let bad = || {
        HttpRequest::post("/api/auth/login")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"username":"admin","password":"nope"}"#))
            .unwrap()
    };

    // Two failures reach the threshold (max_failures: 2).
    for _ in 0..2 {
        let r = router.clone().oneshot(bad()).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK);
    }
    // The next attempt is locked out -> 429 with an ErrorBody the
    // frontend already knows how to surface.
    let locked = router.clone().oneshot(bad()).await.unwrap();
    assert_eq!(locked.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(locked.headers().contains_key(header::RETRY_AFTER));
    let json = body_json(locked).await;
    assert_eq!(json["kind"], "other");
    assert!(json["message"].as_str().unwrap().contains("ロック"));
}

// --- Grant sessions (credential-less issuance, ADR-0017) -----------------
//
// Every scenario runs for BOTH the viewer-public kind (the first grant,
// ADR-0012) and an app-defined kind, so a change to one path cannot
// regress the other (ADR-0017 帰結 "閲覧公開と試運転は同じコードを通る").

fn always_true() -> crate::grant::GrantCondition {
    Arc::new(|| Box::pin(async { Ok(true) }))
}

/// The viewer-public spec without a `SettingsService` (the condition is
/// not under test here; the token side is).
fn public_viewer_spec() -> GrantSpec {
    GrantSpec::new(
        GrantKind::public_viewer(),
        Identity {
            id: crate::grant::PUBLIC_VIEWER_ID.to_string(),
            name: crate::grant::PUBLIC_VIEWER_ID.to_string(),
            role: "viewer".to_string(),
        },
        always_true(),
    )
}

/// An app-defined admin-equivalent kind (banto-hub's commissioning mode).
fn commissioning_spec() -> GrantSpec {
    GrantSpec::new(
        GrantKind::new("commissioning").unwrap(),
        Identity {
            id: "commissioning".to_string(),
            name: "試運転".to_string(),
            role: "admin".to_string(),
        },
        always_true(),
    )
}

fn both_kinds() -> [GrantSpec; 2] {
    [public_viewer_spec(), commissioning_spec()]
}

/// Issue without a race: read the generation, then insert.
fn issue(auth: &AuthState, spec: &GrantSpec) -> String {
    auth.issue_grant_token(spec, auth.grant_generation(&spec.kind))
        .expect("no revocation in between")
}

async fn identity_kind(router: &Router, token: &str) -> serde_json::Value {
    let response = router
        .clone()
        .oneshot(
            HttpRequest::get("/api/auth/identity")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    body_json(response).await
}

#[tokio::test]
async fn grant_kind_follows_token_lifetime_and_not_identity() {
    for spec in both_kinds() {
        let auth = frozen_auth(short_token_policy(), RateLimitPolicy::default());
        let granted = issue(&auth, &spec);
        let identity = auth.identity_for(&granted).unwrap();
        // Account sessions with the very same identity fields.
        let regular = auth.issue_token(identity.clone());
        let remembered = auth.issue_token_remembered(identity);
        let router = auth_routes(auth.clone());

        // Fresh identity requests (including reload) must recover
        // provenance from the token, never from the identity fields.
        for _ in 0..2 {
            for (token, expected) in [
                (&granted, spec.kind.as_str()),
                (&regular, "account"),
                (&remembered, "account"),
            ] {
                let json = identity_kind(&router, token).await;
                assert_eq!(json["kind"], expected, "{}", spec.kind);
                assert!(json.get("publicViewer").is_none(), "v3.0.0 removed it");
            }
        }
        auth.advance(Duration::from_secs(31));
        let fresh = issue(&auth, &spec);
        auth.logout(&fresh);
        for token in [&granted, &regular, &fresh] {
            assert!(identity_kind(&router, token).await.is_null());
        }
        assert_eq!(auth.session_for(&remembered).unwrap().grant, None);
    }
}

#[tokio::test]
async fn revoke_grant_tokens_removes_only_that_kind() {
    let auth = demo_auth();
    let [pv, cm] = both_kinds();
    let p1 = issue(&auth, &pv);
    let p2 = issue(&auth, &pv);
    let c1 = issue(&auth, &cm);
    let regular = auth.issue_token(Identity {
        id: "1".into(),
        name: "admin".into(),
        role: "admin".into(),
    });

    assert_eq!(auth.revoke_grant_tokens(&pv.kind), 2);
    assert!(!auth.verify(&p1));
    assert!(!auth.verify(&p2));
    assert!(auth.verify(&c1), "another kind is untouched");
    assert!(auth.verify(&regular), "a login session is untouched");
    assert_eq!(auth.revoke_grant_tokens(&pv.kind), 0);
    // Issuing afterwards works as usual (with the new generation).
    assert!(auth.verify(&issue(&auth, &pv)));

    assert_eq!(auth.revoke_grant_tokens(&cm.kind), 1);
    assert!(!auth.verify(&c1));
    assert!(auth.verify(&regular));
}

#[tokio::test]
async fn grant_token_is_always_the_spec_identity() {
    for spec in both_kinds() {
        let auth = demo_auth();
        let token = issue(&auth, &spec);
        assert!(auth.verify(&token));
        let session = auth.authenticate(&token).await.unwrap().unwrap();
        assert_eq!(session.identity.id, spec.identity.id);
        assert_eq!(session.identity.name, spec.identity.name);
        assert_eq!(
            session.identity.role, spec.identity.role,
            "the role is the spec's, never the caller's (no escalation path)"
        );
        assert_eq!(session.grant, Some(spec.kind.clone()));
        assert_eq!(session.stamp, None);
    }
}

#[tokio::test]
async fn grant_tokens_are_not_remembered_and_may_carry_their_own_policy() {
    for mut spec in both_kinds() {
        // Default: the regular TokenPolicy (the client's fallback re-issues
        // transparently, so an anonymous LAN client never holds a 30-day token).
        let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
        let token = issue(&auth, &spec);
        auth.advance(TokenPolicy::default().absolute_ttl + Duration::from_secs(60));
        assert!(!auth.verify(&token), "{}", spec.kind);

        // A spec policy overrides it (shorter here; the record decides,
        // not the state-wide policy).
        spec.policy = Some(TokenPolicy {
            absolute_ttl: Duration::from_secs(100),
            idle_ttl: Duration::from_secs(10),
        });
        let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
        let token = issue(&auth, &spec);
        auth.advance(Duration::from_secs(9));
        assert!(auth.verify(&token));
        auth.advance(Duration::from_secs(11));
        assert!(!auth.verify(&token), "{}: idle 10s lapsed", spec.kind);
    }
}

#[tokio::test]
async fn grant_issuance_past_the_cap_evicts_the_oldest_of_that_kind() {
    for mut spec in both_kinds() {
        spec.max_sessions = 5;
        let auth = demo_auth();
        let other = commissioning_spec();
        let other = if other.kind == spec.kind {
            public_viewer_spec()
        } else {
            other
        };
        let bystander = issue(&auth, &other);
        let tokens: Vec<_> = (0..5).map(|_| issue(&auth, &spec)).collect();
        assert!(tokens.iter().all(|token| auth.verify(token)));

        // One past the cap: issuance still succeeds (a reloading wall
        // display must never be refused), and the FIRST token goes.
        let overflow = issue(&auth, &spec);
        assert!(auth.verify(&overflow));
        assert!(
            !auth.verify(&tokens[0]),
            "{}: the oldest is evicted",
            spec.kind
        );
        assert!(auth.verify(&tokens[1]), "only the oldest, not the pool");
        assert!(auth.verify(&bystander), "another kind's token stays");
    }
}

#[tokio::test]
async fn grant_eviction_never_touches_a_real_login_session() {
    for mut spec in both_kinds() {
        spec.max_sessions = 3;
        let auth = demo_auth();
        let admin_token = auth.login("admin", "admin").await.expect("admin login");
        let same_identity_token = auth.issue_token(spec.identity.clone());
        for _ in 0..10 {
            issue(&auth, &spec);
        }
        assert!(auth.verify(&admin_token), "the cap only evicts grants");
        assert!(auth.verify(&same_identity_token));
        assert_eq!(auth.session_for(&same_identity_token).unwrap().grant, None);
    }
}

#[tokio::test]
async fn logout_of_a_grant_token_revokes_only_that_token() {
    // One wall display signing out must not blank the others (conventions
    // §6) - `logout` is the plain per-token revoke, nothing grant-specific.
    for spec in both_kinds() {
        let auth = demo_auth();
        let first = issue(&auth, &spec);
        let second = issue(&auth, &spec);
        auth.logout(&first);
        assert!(!auth.verify(&first));
        assert!(auth.verify(&second));
    }
}

#[tokio::test]
async fn grant_generation_is_per_kind_and_a_stale_one_is_refused() {
    let auth = demo_auth();
    let [pv, cm] = both_kinds();
    let g0 = auth.grant_generation(&pv.kind);
    assert_eq!(
        auth.grant_generation(&pv.kind),
        g0,
        "reading does not advance it"
    );
    assert!(auth.issue_grant_token(&pv, g0).is_some());
    auth.revoke_grant_tokens(&pv.kind);
    let g1 = auth.grant_generation(&pv.kind);
    assert_ne!(g0, g1);
    assert!(auth.issue_grant_token(&pv, g0).is_none(), "stale");
    assert!(auth.issue_grant_token(&pv, g1).is_some());
    // Another kind's generation is independent.
    assert!(auth
        .issue_grant_token(&cm, auth.grant_generation(&cm.kind))
        .is_some());
    auth.revoke_grant_tokens(&cm.kind);
    assert_eq!(auth.grant_generation(&pv.kind), g1);
}

/// ADR-0017 §2, the mandatory race: an issuance that already judged
/// `enabled() == true` is parked right before `issue_grant_token`; a
/// revocation (the condition being closed) completes meanwhile; the
/// issuance resumes and must NOT insert - no valid token of the kind
/// may exist afterwards. The pause is a real suspension point: the
/// issuing task awaits a oneshot between its judgment (the generation
/// read + the condition) and the insert, and the test runs the
/// revocation to completion in another task while it waits.
#[tokio::test]
async fn an_issuance_parked_before_the_insert_loses_to_a_revocation_that_completed_meanwhile() {
    for spec in both_kinds() {
        let auth = demo_auth();
        let kind = spec.kind.clone();
        let (judged_tx, judged_rx) = tokio::sync::oneshot::channel::<()>();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel::<()>();

        let issuing = tokio::spawn({
            let auth = auth.clone();
            let spec = spec.clone();
            async move {
                // 1. the judgment: generation first, then the condition.
                let observed = auth.grant_generation(&spec.kind);
                let allowed = (spec.enabled)().await.unwrap();
                assert!(allowed);
                // 2. parked right before the insert.
                judged_tx.send(()).unwrap();
                resume_rx.await.unwrap();
                // 3. resumed after the revocation.
                auth.issue_grant_token(&spec, observed)
            }
        });
        judged_rx.await.unwrap();

        // The lock-down, in another task, runs to completion while the
        // issuance is parked (the app persisted its flag first).
        let revoked = tokio::spawn({
            let auth = auth.clone();
            let kind = kind.clone();
            async move { auth.revoke_grant_tokens(&kind) }
        })
        .await
        .unwrap();
        assert_eq!(revoked, 0, "{kind}: nothing was issued yet");

        resume_tx.send(()).unwrap();
        assert!(
            issuing.await.unwrap().is_none(),
            "{kind}: the parked issuance must be refused"
        );
        assert_eq!(auth.session_count(), 0, "{kind}: no valid token exists");
        assert!(
            !auth
                .inner
                .tokens
                .read()
                .unwrap()
                .values()
                .any(|record| record.grant.is_some()),
            "{kind}: no grant record at all"
        );

        // The same race with a token already outstanding: that one is
        // revoked, the parked one is refused, and nothing survives.
        let earlier = issue(&auth, &spec);
        let observed = auth.grant_generation(&kind);
        assert_eq!(auth.revoke_grant_tokens(&kind), 1);
        assert!(auth.issue_grant_token(&spec, observed).is_none());
        assert!(!auth.verify(&earlier));
        assert_eq!(auth.session_count(), 0);
    }
}

#[test]
fn rate_limit_key_distinguishes_ip_and_username() {
    let with_ip = rate_limit_key(Some("192.168.0.5".parse().unwrap()), "admin");
    let without = rate_limit_key(None, "admin");
    assert_eq!(with_ip, "192.168.0.5|admin");
    assert_eq!(without, "-|admin");
    assert_ne!(with_ip, without);
}

// --- Account-bound sessions (Issue #204) ----------------------------------

type VerifyHook = Box<dyn FnOnce() + Send>;

/// An in-memory account store standing in for `UsersService`: the
/// verifier accepts password `"pw"` for any stored account, and the
/// lookup reports the stored [`SessionAccount`] (or fails on demand).
#[derive(Clone, Default)]
struct FakeStore {
    accounts: Arc<std::sync::Mutex<HashMap<String, SessionAccount>>>,
    failing: Arc<std::sync::atomic::AtomicBool>,
    lookups: Arc<AtomicUsize>,
    /// Run once inside the verifier, i.e. while a login is "in flight".
    during_verify: Arc<std::sync::Mutex<Option<VerifyHook>>>,
    /// Holds the NEXT lookup in flight: it signals the first sender on
    /// entry, then waits for the second channel before reading.
    lookup_gate: Arc<std::sync::Mutex<Option<LookupGate>>>,
}

type LookupGate = (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);

impl FakeStore {
    fn put(&self, username: &str, role: &str, account_id: i64, auth_epoch: i64) {
        self.accounts.lock().unwrap().insert(
            username.to_string(),
            SessionAccount {
                identity: Identity {
                    id: username.to_string(),
                    name: format!("{username} name"),
                    role: role.to_string(),
                },
                stamp: SessionStamp {
                    account_id,
                    auth_epoch,
                },
            },
        );
    }

    fn remove(&self, username: &str) {
        self.accounts.lock().unwrap().remove(username);
    }

    fn get(&self, username: &str) -> Option<SessionAccount> {
        self.accounts.lock().unwrap().get(username).cloned()
    }

    fn auth(&self) -> AuthState {
        let verify_store = self.clone();
        let lookup_store = self.clone();
        let lookup = SessionValidation::lookup(move |u: String| {
            let store = lookup_store.clone();
            Box::pin(async move {
                store.lookups.fetch_add(1, Ordering::SeqCst);
                let gate = store.lookup_gate.lock().unwrap().take();
                if let Some((entered, release)) = gate {
                    let _ = entered.send(());
                    let _ = release.await;
                }
                if store.failing.load(Ordering::SeqCst) {
                    Err(BantoError::Other("store unavailable".to_string()))
                } else {
                    Ok(store.get(&u))
                }
            })
        });
        AuthState::with_frozen_clock(
            move |u: String, p: String| {
                let store = verify_store.clone();
                Box::pin(async move {
                    let hook = store.during_verify.lock().unwrap().take();
                    if let Some(hook) = hook {
                        hook();
                    }
                    if p == "pw" {
                        store.get(&u).map(|account| account.identity)
                    } else {
                        None
                    }
                })
            },
            lookup,
            TokenPolicy::default(),
            TokenPolicy::remembered_default(),
            RateLimitPolicy::default(),
        )
    }
}

impl FakeStore {
    /// The same verifier, with [`SessionValidation::DisabledNoRevocation`].
    fn auth_without_revocation(&self) -> AuthState {
        let verify_store = self.clone();
        AuthState::with_frozen_clock(
            move |u: String, p: String| {
                let store = verify_store.clone();
                Box::pin(async move {
                    if p == "pw" {
                        store.get(&u).map(|account| account.identity)
                    } else {
                        None
                    }
                })
            },
            SessionValidation::DisabledNoRevocation,
            TokenPolicy::default(),
            TokenPolicy::remembered_default(),
            RateLimitPolicy::default(),
        )
    }
}

/// Start `authenticate(token)` and hold its lookup in flight; returns the
/// pending check and the switch that lets the lookup continue.
async fn check_held_in_lookup(
    store: &FakeStore,
    auth: &AuthState,
    token: &str,
) -> (
    tokio::task::JoinHandle<Result<Option<AuthenticatedSession>, BantoError>>,
    tokio::sync::oneshot::Sender<()>,
) {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    *store.lookup_gate.lock().unwrap() = Some((entered_tx, release_rx));
    let pending = {
        let auth = auth.clone();
        let token = token.to_string();
        tokio::spawn(async move { auth.authenticate(&token).await })
    };
    entered_rx.await.expect("the lookup started");
    (pending, release_tx)
}

#[tokio::test]
async fn a_session_rebound_while_its_check_was_in_flight_stays_valid() {
    // Review of #230: the check snapshotted epoch 0, the password change
    // committed epoch 1 and re-bound this very token, then the lookup
    // (epoch 1) came back. The token is valid under its new binding.
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let changer = login_token(&auth, "alice", false).await;
    let other = login_token(&auth, "alice", true).await;
    let epoch0 = SessionStamp {
        account_id: 1,
        auth_epoch: 0,
    };

    let (changer_check, release_changer) = check_held_in_lookup(&store, &auth, &changer).await;
    store.put("alice", "admin", 1, 1);
    assert!(auth.rotate_session_epoch(&changer, epoch0, 1));
    release_changer.send(()).unwrap();
    let session = changer_check
        .await
        .unwrap()
        .unwrap()
        .expect("the re-bound session must not be reported as revoked");
    assert_eq!(
        session.stamp,
        Some(SessionStamp {
            account_id: 1,
            auth_epoch: 1
        })
    );
    assert!(is_live(&auth, &changer).await);

    // The same interleaving for a session that was NOT re-bound: the
    // store's new epoch is not adopted on its behalf.
    let (other_check, release_other) = check_held_in_lookup(&store, &auth, &other).await;
    release_other.send(()).unwrap();
    assert!(other_check.await.unwrap().unwrap().is_none());
    assert!(!auth.verify(&other), "the stale session is revoked");
    assert!(is_live(&auth, &changer).await);
}

#[tokio::test]
async fn revalidate_judges_like_authenticate_but_does_not_slide_the_idle_window() {
    // Issue #231: the SSE stream's periodic re-check must not keep an
    // idle session alive (default idle_ttl = 1h, absolute = 8h).
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let revalidated = login_token(&auth, "alice", false).await;
    let used = login_token(&auth, "alice", false).await;

    auth.advance(Duration::from_secs(50 * 60));
    assert!(auth.revalidate(&revalidated).await.unwrap().is_some());
    assert!(is_live(&auth, &used).await, "a request slides the window");

    auth.advance(Duration::from_secs(20 * 60));
    assert!(
        auth.revalidate(&revalidated).await.unwrap().is_none(),
        "70 min since the last request: idle-expired despite the re-check"
    );
    assert!(!auth.verify(&revalidated), "and evicted");
    assert!(auth.revalidate(&used).await.unwrap().is_some());

    // Same verdicts as authenticate otherwise: a store failure keeps the
    // token, an epoch change revokes it.
    store.failing.store(true, Ordering::SeqCst);
    assert!(auth.revalidate(&used).await.is_err());
    store.failing.store(false, Ordering::SeqCst);
    assert!(auth.revalidate(&used).await.unwrap().is_some());
    store.put("alice", "admin", 1, 1);
    assert!(auth.revalidate(&used).await.unwrap().is_none());
    assert!(!auth.verify(&used));
}

#[tokio::test]
async fn disabled_validation_keeps_the_pre_204_behavior() {
    // The explicit opt-out: nothing is looked up, account changes do not
    // revoke, and the login-time role is what authorizes - exactly what
    // every state did before #204 (and why it must be chosen by name).
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth_without_revocation();
    let normal = login_token(&auth, "alice", false).await;
    let remembered = login_token(&auth, "alice", true).await;
    let unstamped = auth.issue_token(store.get("alice").unwrap().identity);

    store.put("alice", "viewer", 1, 5);
    store.remove("alice");

    for token in [&normal, &remembered, &unstamped] {
        let session = auth.authenticate(token).await.unwrap().unwrap();
        assert_eq!(session.identity.role, "admin");
        assert_eq!(session.stamp, None);
    }
    assert_eq!(store.lookups.load(Ordering::SeqCst), 0);
    assert_eq!(
        protected_router(&auth)
            .oneshot(bearer_get("/protected", &normal))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}

async fn login_token(auth: &AuthState, username: &str, remember: bool) -> String {
    match auth
        .login_rate_limited(None, username, "pw", remember)
        .await
    {
        LoginOutcome::Success(token) => token,
        other => panic!("expected Success, got {other:?}"),
    }
}

async fn is_live(auth: &AuthState, token: &str) -> bool {
    auth.authenticate(token).await.unwrap().is_some()
}

fn protected_router(auth: &AuthState) -> Router {
    Router::new()
        .route("/protected", get(|| async { "ok" }))
        .layer(axum::middleware::from_fn_with_state(
            auth.clone(),
            require_auth,
        ))
}

fn bearer_get(path: &str, token: &str) -> HttpRequest<Body> {
    HttpRequest::get(path)
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn account_bound_sessions_live_while_the_stamp_matches() {
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    for remember in [false, true] {
        let token = login_token(&auth, "alice", remember).await;
        let session = auth.authenticate(&token).await.unwrap().unwrap();
        assert_eq!(session.identity.role, "admin");
        assert_eq!(
            session.stamp,
            Some(SessionStamp {
                account_id: 1,
                auth_epoch: 0
            })
        );
    }
}

#[tokio::test]
async fn deleting_the_account_revokes_normal_and_remembered_sessions() {
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let normal = login_token(&auth, "alice", false).await;
    let remembered = login_token(&auth, "alice", true).await;

    store.remove("alice");

    assert!(!is_live(&auth, &normal).await);
    assert!(!is_live(&auth, &remembered).await);
    // Revoked, not just refused once: gone from the token map.
    assert!(!auth.verify(&normal));
    assert!(!auth.verify(&remembered));
}

#[tokio::test]
async fn an_epoch_change_revokes_that_account_only() {
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    store.put("bob", "editor", 2, 0);
    let auth = store.auth();
    let alice_normal = login_token(&auth, "alice", false).await;
    let alice_remembered = login_token(&auth, "alice", true).await;
    let bob = login_token(&auth, "bob", true).await;

    store.put("alice", "admin", 1, 1);

    assert!(!is_live(&auth, &alice_normal).await);
    assert!(!is_live(&auth, &alice_remembered).await);
    assert!(is_live(&auth, &bob).await);
    // A fresh login after the change is bound to the new epoch.
    let again = login_token(&auth, "alice", false).await;
    assert!(is_live(&auth, &again).await);
}

#[tokio::test]
async fn a_recreated_account_does_not_inherit_the_deleted_accounts_sessions() {
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let token = login_token(&auth, "alice", true).await;

    // Deleted and re-created under the same username: same epoch (a new
    // row starts at 0 again), different row id.
    store.remove("alice");
    store.put("alice", "admin", 7, 0);

    assert!(!is_live(&auth, &token).await);
}

#[tokio::test]
async fn authenticate_authorizes_with_the_current_role_and_refreshes_the_cache() {
    // A store that changes the role WITHOUT advancing the epoch (the
    // banto `UsersService` does advance it; a derived store might not):
    // the session survives, but with the role it has NOW.
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let token = login_token(&auth, "alice", false).await;

    store.put("alice", "viewer", 1, 0);

    let session = auth.authenticate(&token).await.unwrap().unwrap();
    assert_eq!(session.identity.role, "viewer");
    assert_eq!(
        auth.identity_for(&token).unwrap().role,
        "viewer",
        "synchronous readers behind require_auth must see the current role"
    );
}

#[tokio::test]
async fn a_store_failure_fails_the_request_but_keeps_the_session() {
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let token = login_token(&auth, "alice", false).await;

    store.failing.store(true, Ordering::SeqCst);
    assert!(auth.authenticate(&token).await.is_err());
    let response = protected_router(&auth)
        .oneshot(bearer_get("/protected", &token))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::INTERNAL_SERVER_ERROR,
        "a store failure is neither a pass nor a revocation"
    );

    store.failing.store(false, Ordering::SeqCst);
    assert!(is_live(&auth, &token).await);
}

#[tokio::test]
async fn unstamped_tokens_are_rejected_once_a_lookup_is_installed() {
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let identity = store.get("alice").unwrap().identity;
    let unstamped = auth.issue_token(identity.clone());
    let unstamped_remembered = auth.issue_token_remembered(identity);
    assert!(!is_live(&auth, &unstamped).await);
    assert!(!is_live(&auth, &unstamped_remembered).await);

    let stamped = auth.issue_account_token(store.get("alice").unwrap(), true);
    assert!(is_live(&auth, &stamped).await);
}

#[tokio::test]
async fn grant_sessions_are_not_looked_up() {
    for spec in both_kinds() {
        let store = FakeStore::default();
        let auth = store.auth();
        let token = issue(&auth, &spec);
        let session = auth.authenticate(&token).await.unwrap().unwrap();
        assert_eq!(session.grant, Some(spec.kind.clone()));
        assert_eq!(store.lookups.load(Ordering::SeqCst), 0);
        // ...and the token side still ends it: a revocation is a 401 on
        // the next request, with no lookup either.
        auth.revoke_grant_tokens(&spec.kind);
        assert!(auth.authenticate(&token).await.unwrap().is_none());
        assert_eq!(store.lookups.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn a_change_committed_during_login_leaves_the_new_token_dead() {
    // The stamp is read BEFORE the (slow) credential check, so a reset
    // that commits while it runs cannot be outlived by the new token.
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let bump = store.clone();
    *store.during_verify.lock().unwrap() = Some(Box::new(move || {
        bump.put("alice", "admin", 1, 1);
    }));

    let token = login_token(&auth, "alice", false).await;
    assert!(!is_live(&auth, &token).await);
}

#[tokio::test]
async fn login_is_unavailable_when_the_stamp_cannot_be_established() {
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    store.failing.store(true, Ordering::SeqCst);
    assert!(matches!(
        auth.login_rate_limited(None, "alice", "pw", false).await,
        LoginOutcome::Unavailable
    ));
    assert!(auth.login("alice", "pw").await.is_none());
    assert_eq!(auth.session_count(), 0, "no token may be issued");

    let response = auth_routes(auth.clone())
        .oneshot(
            HttpRequest::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"username":"alice","password":"pw"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body_json(response).await["kind"], "other");
}

#[tokio::test]
async fn rotate_session_epoch_rebinds_only_the_named_token_from_the_expected_stamp() {
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let current = login_token(&auth, "alice", false).await;
    let other = login_token(&auth, "alice", true).await;
    let previous = SessionStamp {
        account_id: 1,
        auth_epoch: 0,
    };

    store.put("alice", "admin", 1, 1);
    assert!(auth.rotate_session_epoch(&current, previous, 1));
    // Already re-bound: a second rotation from the old stamp is refused.
    assert!(!auth.rotate_session_epoch(&current, previous, 1));

    assert!(is_live(&auth, &current).await);
    assert!(!is_live(&auth, &other).await);
    assert!(!auth.rotate_session_epoch(&other, previous, 1), "revoked");
}

#[tokio::test]
async fn check_and_identity_report_a_revoked_session_as_logged_out() {
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let token = login_token(&auth, "alice", true).await;
    let router = auth_routes(auth.clone());

    let identity = body_json(
        router
            .clone()
            .oneshot(bearer_get("/api/auth/identity", &token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(identity["id"], "alice");
    assert_eq!(identity["kind"], "account");
    assert!(
        identity.get("stamp").is_none(),
        "the account binding is internal: {identity}"
    );

    store.put("alice", "admin", 1, 1);
    let check = router
        .clone()
        .oneshot(bearer_get("/api/auth/check", &token))
        .await
        .unwrap();
    assert_eq!(body_json(check).await, serde_json::json!(false));
    let identity = router
        .clone()
        .oneshot(bearer_get("/api/auth/identity", &token))
        .await
        .unwrap();
    assert!(body_json(identity).await.is_null());
}

#[tokio::test]
async fn require_auth_rejects_a_revoked_session_with_401() {
    let store = FakeStore::default();
    store.put("alice", "admin", 1, 0);
    let auth = store.auth();
    let token = login_token(&auth, "alice", false).await;
    let protected = protected_router(&auth);
    assert_eq!(
        protected
            .clone()
            .oneshot(bearer_get("/protected", &token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    store.remove("alice");
    assert_eq!(
        protected
            .clone()
            .oneshot(bearer_get("/protected", &token))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}
