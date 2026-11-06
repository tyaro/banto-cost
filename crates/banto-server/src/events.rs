//! Server -> client event delivery (spec §3.5 `EventProvider`, §11.3).
//!
//! Exactly two event kinds ship in v1: resource-change notifications (so a
//! connected browser's `createListResource`/`createShowResource` can
//! `invalidate` and refetch) and free-form server notices (surfaced via
//! `NotificationProvider`). Transport is Server-Sent Events; the spec notes
//! this can be upgraded to WebSocket later without changing the
//! `EventProvider` interface, so nothing here should assume one-way-only
//! beyond the SSE plumbing itself.
//!
//! ## Re-checking an open stream (Issue #231, ADR-0014)
//!
//! [`require_auth`] validates the session when the stream opens. A stream
//! then stays open for as long as the tab does, so every stream also
//! re-runs the session check (`AuthState::revalidate`, i.e.
//! [`AuthState::authenticate`] without sliding the idle window) every
//! [`REVALIDATE_INTERVAL`] - the keepalive's interval - and ends when the
//! session is no longer valid (account deleted, role/password changed or
//! reset, token logged out or expired). Revocation therefore reaches an open
//! stream within one interval (plus one check), in any process sharing the
//! account store.
//!
//! - One deadline per stream, owned by the stream itself (no spawned task,
//!   no second timer): when the client disconnects, axum drops the stream,
//!   and the deadline and any re-check in flight are dropped with it.
//! - A due re-check runs before further events are taken, exactly once; the
//!   next deadline is set one interval after that check FINISHED. However
//!   long checks take, events get a whole interval between two checks - the
//!   checks can never starve the delivery (review of #234).
//! - A check is abandoned after [`REVALIDATE_TIMEOUT`] (shorter than the
//!   interval). A timeout counts as "could not check", like a store failure
//!   (`Err`): neither ends the stream (#230: a session that cannot be
//!   checked is kept); the next deadline checks again. The abandoned lookup
//!   future is dropped, and since `authenticate` only changes the session
//!   after its lookup returns, an abandoned check never changes it later.
//! - A session re-bound while its check was in flight (its own password
//!   change) is judged on its current binding, exactly as for a request
//!   ([`AuthState::authenticate`]'s `settle_stamp_mismatch`).
//! - Public viewer sessions and `SessionValidation::DisabledNoRevocation`
//!   never look anything up, so the re-check is an in-memory token check:
//!   those streams end only when the token itself does.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Extension, Request};
use axum::middleware;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::time::Instant;

use crate::auth::{bearer_token, require_auth, unauthorized_response, AuthState};
use crate::server::ShutdownSignal;

/// Interval of the SSE keepalive comment.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// Interval of an open stream's session re-check (Issue #231): the
/// keepalive's, so a revoked session loses its stream within one keepalive
/// period. Measured from the end of the previous check. Costs one indexed
/// account read per open account stream per interval (none for public
/// viewer / no-revocation sessions).
pub const REVALIDATE_INTERVAL: Duration = KEEPALIVE_INTERVAL;

/// How long one re-check may take before it is abandoned as "could not
/// check" (the session is kept). Shorter than [`REVALIDATE_INTERVAL`], so a
/// store that stops answering cannot hold the stream inside one check.
pub const REVALIDATE_TIMEOUT: Duration = Duration::from_secs(5);

const _: () = assert!(REVALIDATE_TIMEOUT.as_nanos() < REVALIDATE_INTERVAL.as_nanos());

/// When one stream's re-checks are due.
enum Schedule {
    /// Production: due `period` after the stream opened (the open itself
    /// was just checked by [`require_auth`]), then `period` after the END of
    /// each check ([`Schedule::rearm`]).
    Every { period: Duration, next: Instant },
    /// Tests: due whenever the test sends a tick; ends when it drops the
    /// sender.
    #[cfg(test)]
    Manual(tokio::sync::mpsc::UnboundedReceiver<()>),
}

impl Schedule {
    fn every(period: Duration) -> Self {
        Self::Every {
            period,
            next: Instant::now() + period,
        }
    }

    /// Resolves when a re-check is due; `false` if the schedule ended.
    /// Cancel-safe: the deadline lives in `self`, not in this future.
    async fn due(&mut self) -> bool {
        match self {
            Self::Every { next, .. } => {
                tokio::time::sleep_until(*next).await;
                true
            }
            #[cfg(test)]
            Self::Manual(ticks) => ticks.recv().await.is_some(),
        }
    }

    /// Set the next deadline, after a check has finished.
    fn rearm(&mut self) {
        match self {
            Self::Every { period, next } => *next = Instant::now() + *period,
            #[cfg(test)]
            Self::Manual(_) => {}
        }
    }
}

/// Makes the [`Schedule`] for each newly opened stream.
type ScheduleSource = Arc<dyn Fn() -> Schedule + Send + Sync>;

/// What the stream's loop does next.
enum Step {
    /// A re-check is due (`false`: the schedule ended).
    Recheck(bool),
    Deliver(Result<ServerEvent, broadcast::error::RecvError>),
    /// The server was asked to stop (Issue #283).
    Shutdown,
}

/// The two event kinds delivered to browser clients (spec §3.5). Serializes
/// as `{ "kind": "resource_changed", "resource": "items" }` /
/// `{ "kind": "notice", "level": "...", "message": "..." }`, matching the
/// `AppEvent` shape `packages/admin-core`'s `SseEventProvider` will parse in
/// Phase B.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerEvent {
    ResourceChanged {
        resource: String,
    },
    /// A free-form server notice, surfaced as a toast on every connected
    /// client (LAN browsers via SSE + the Tauri webview via the forwarding
    /// task). `level` maps to the frontend `NotificationKind`
    /// (`success`/`error`/`info`/`warning`, else `info`).
    ///
    /// To push one, broadcast on the same `events` channel `ItemsService`
    /// mutations already use (spec §3.5) - e.g. from a Tauri command or a
    /// `banto-serve` handler that holds the `Sender`:
    ///
    /// ```
    /// use banto_server::ServerEvent;
    /// use tokio::sync::broadcast;
    ///
    /// let (events, _rx) = broadcast::channel::<ServerEvent>(16);
    /// // `send` errors only when there are no receivers - harmless here.
    /// let _ = events.send(ServerEvent::Notice {
    ///     level: "warning".to_string(),
    ///     message: "在庫が下限を下回りました".to_string(),
    /// });
    /// ```
    Notice {
        level: String,
        message: String,
    },
}

/// The state the handler needs to re-check its stream's session.
#[derive(Clone)]
struct Revalidation {
    auth: AuthState,
    schedule: ScheduleSource,
    timeout: Duration,
}

/// The event stream of one connection: broadcast events, ended when the
/// session behind `token` stops being valid (see the module doc).
fn event_stream(
    auth: AuthState,
    token: String,
    mut rx: broadcast::Receiver<ServerEvent>,
    mut schedule: Schedule,
    timeout: Duration,
    mut shutdown: Option<ShutdownSignal>,
) -> impl futures_util::Stream<Item = Result<Event, Infallible>> {
    async_stream::stream! {
        loop {
            // Both branches are cancel-safe (an event not taken stays in the
            // receiver; the deadline stays in `schedule`). `biased`: a due
            // re-check runs before further events are taken - once, since
            // `rearm` then puts the next one a whole interval away.
            let step = tokio::select! {
                biased;
                // Server stop (Issue #283): a separate lifecycle from the
                // session re-check - without it graceful shutdown waits for
                // this stream forever.
                () = async {
                    match shutdown.as_mut() {
                        Some(signal) => signal.triggered().await,
                        None => std::future::pending().await,
                    }
                } => Step::Shutdown,
                due = schedule.due() => Step::Recheck(due),
                received = rx.recv() => Step::Deliver(received),
            };
            match step {
                Step::Shutdown => break,
                Step::Recheck(true) => {
                    let verdict = tokio::time::timeout(timeout, auth.revalidate(&token)).await;
                    schedule.rearm();
                    // Revoked, logged out or expired: end the stream. Valid,
                    // or the store could not answer (`Err`) or not in time
                    // (the lookup is dropped): keep the stream (#230) and
                    // check again next time.
                    if let Ok(Ok(None)) = verdict {
                        break;
                    }
                }
                // Never keep streaming without the re-check.
                Step::Recheck(false) => break,
                Step::Deliver(Ok(event)) => {
                    if let Ok(json) = serde_json::to_string(&event) {
                        yield Ok(Event::default().data(json));
                    }
                }
                // A slow client fell behind the broadcast buffer: skip the
                // gap rather than closing the connection.
                Step::Deliver(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                // Sender dropped (server shutting down): end the stream.
                Step::Deliver(Err(broadcast::error::RecvError::Closed)) => break,
            }
        }
    }
}

async fn sse_handler(
    Extension(tx): Extension<broadcast::Sender<ServerEvent>>,
    Extension(revalidation): Extension<Revalidation>,
    shutdown: Option<Extension<ShutdownSignal>>,
    req: Request,
) -> Response {
    // Always present behind `require_auth`, which just validated it.
    let Some(token) = bearer_token(&req).map(str::to_owned) else {
        return unauthorized_response();
    };
    let stream = event_stream(
        revalidation.auth,
        token,
        tx.subscribe(),
        (revalidation.schedule)(),
        revalidation.timeout,
        shutdown.map(|Extension(signal)| signal),
    );
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(KEEPALIVE_INTERVAL))
        .into_response()
}

/// Build the `GET /api/events` SSE endpoint (spec §11.3), auth-required.
/// Each subscriber gets its own broadcast receiver, so one slow reader
/// cannot block delivery to the others. An open stream re-checks its
/// session every [`REVALIDATE_INTERVAL`] and ends once it is revoked
/// (Issue #231, see the module doc).
pub fn sse_route(auth: AuthState, tx: broadcast::Sender<ServerEvent>) -> Router {
    sse_route_with(
        auth,
        tx,
        Arc::new(|| Schedule::every(REVALIDATE_INTERVAL)),
        REVALIDATE_TIMEOUT,
    )
}

fn sse_route_with(
    auth: AuthState,
    tx: broadcast::Sender<ServerEvent>,
    schedule: ScheduleSource,
    timeout: Duration,
) -> Router {
    Router::new()
        .route("/api/events", get(sse_handler))
        .layer(Extension(tx))
        .layer(Extension(Revalidation {
            auth: auth.clone(),
            schedule,
            timeout,
        }))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

// `require_auth` takes `State<AuthState>` via `from_fn_with_state`, which
// only requires `state: S` and does not force this router's own generic
// `State` type to be `AuthState` - so the router above stays `Router<()>`
// and merges cleanly with other routers that carry no state.
#[allow(dead_code)]
fn _assert_state_stays_unit(router: Router) -> Router<()> {
    router
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Identity;
    use axum::body::Body;
    use axum::http::{Request as HttpRequest, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

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
            crate::auth::SessionValidation::DisabledNoRevocation,
        )
    }

    #[tokio::test]
    async fn sse_stream_delivers_broadcast_event() {
        let auth = demo_auth();
        let token = auth.login("admin", "admin").await.unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let router = sse_route(auth, tx.clone());

        let response = router
            .oneshot(
                HttpRequest::get("/api/events")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("text/event-stream")
        );

        tx.send(ServerEvent::ResourceChanged {
            resource: "items".to_string(),
        })
        .unwrap();

        let mut body = response.into_body();
        let frame = tokio::time::timeout(Duration::from_secs(2), body.frame())
            .await
            .expect("timed out waiting for SSE frame")
            .expect("stream ended unexpectedly")
            .expect("frame error");
        let bytes = frame.into_data().expect("expected a data frame");
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("resource_changed"));
        assert!(text.contains("items"));
    }

    #[tokio::test]
    async fn sse_stream_delivers_notice_event() {
        let auth = demo_auth();
        let token = auth.login("admin", "admin").await.unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let router = sse_route(auth, tx.clone());

        let response = router
            .oneshot(
                HttpRequest::get("/api/events")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        // The documented emission recipe: broadcast a Notice on the events
        // channel; every subscriber gets it as a toast.
        tx.send(ServerEvent::Notice {
            level: "warning".to_string(),
            message: "careful".to_string(),
        })
        .unwrap();

        let mut body = response.into_body();
        let frame = tokio::time::timeout(Duration::from_secs(2), body.frame())
            .await
            .expect("timed out waiting for SSE frame")
            .expect("stream ended unexpectedly")
            .expect("frame error");
        let bytes = frame.into_data().expect("expected a data frame");
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        // Wire shape the frontend `SseEventProvider` parses (kind-tagged,
        // snake_case), carrying the level so it maps to the `warning` kind.
        assert!(text.contains("\"kind\":\"notice\""));
        assert!(text.contains("\"level\":\"warning\""));
        assert!(text.contains("careful"));
    }

    #[tokio::test]
    async fn sse_endpoint_requires_auth() {
        let auth = demo_auth();
        let (tx, _rx) = broadcast::channel(16);
        let router = sse_route(auth, tx);

        let response = router
            .oneshot(HttpRequest::get("/api/events").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // ---- Issue #231: re-checking an open stream ----

    use crate::auth::{SessionAccount, SessionStamp, SessionValidation};
    use banto_core::BantoError;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tokio::sync::{mpsc, oneshot};

    type Gate = (oneshot::Sender<()>, oneshot::Receiver<()>);

    /// A minimal account store (like `auth::tests::FakeStore`): the verifier
    /// accepts password `"pw"`, the lookup reports the stored account, fails
    /// on demand, can be held in flight once (`gate`), can take `delay`
    /// per lookup, or never answer (`hanging`).
    #[derive(Clone, Default)]
    struct Store {
        accounts: Arc<Mutex<HashMap<String, SessionAccount>>>,
        failing: Arc<AtomicBool>,
        lookups: Arc<AtomicUsize>,
        gate: Arc<Mutex<Option<Gate>>>,
        delay: Arc<Mutex<Option<Duration>>>,
        hanging: Arc<AtomicBool>,
    }

    impl Store {
        fn put(&self, username: &str, role: &str, account_id: i64, auth_epoch: i64) {
            self.accounts.lock().unwrap().insert(
                username.to_string(),
                SessionAccount {
                    identity: Identity {
                        id: username.to_string(),
                        name: username.to_string(),
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

        fn lookups(&self) -> usize {
            self.lookups.load(Ordering::SeqCst)
        }

        fn verifier(
            &self,
        ) -> impl Fn(String, String) -> futures_util::future::BoxFuture<'static, Option<Identity>>
               + Send
               + Sync
               + 'static {
            let store = self.clone();
            move |u: String, p: String| {
                let store = store.clone();
                Box::pin(async move {
                    let accounts = store.accounts.lock().unwrap();
                    (p == "pw")
                        .then(|| accounts.get(&u).map(|a| a.identity.clone()))
                        .flatten()
                })
            }
        }

        fn auth(&self) -> AuthState {
            let store = self.clone();
            AuthState::new(
                self.verifier(),
                SessionValidation::lookup(move |u: String| {
                    let store = store.clone();
                    Box::pin(async move {
                        store.lookups.fetch_add(1, Ordering::SeqCst);
                        let gate = store.gate.lock().unwrap().take();
                        if let Some((entered, release)) = gate {
                            let _ = entered.send(());
                            let _ = release.await;
                        }
                        if store.hanging.load(Ordering::SeqCst) {
                            std::future::pending::<()>().await;
                        }
                        let delay = *store.delay.lock().unwrap();
                        if let Some(delay) = delay {
                            tokio::time::sleep(delay).await;
                        }
                        if store.failing.load(Ordering::SeqCst) {
                            Err(BantoError::Other("store unavailable".to_string()))
                        } else {
                            Ok(store.accounts.lock().unwrap().get(&u).cloned())
                        }
                    })
                }),
            )
        }

        fn auth_without_revocation(&self) -> AuthState {
            AuthState::new(self.verifier(), SessionValidation::DisabledNoRevocation)
        }

        /// Hold the next lookup in flight: resolves the returned receiver
        /// once it started, and continues when the sender fires.
        fn hold_next_lookup(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
            let (entered_tx, entered_rx) = oneshot::channel();
            let (release_tx, release_rx) = oneshot::channel();
            *self.gate.lock().unwrap() = Some((entered_tx, release_rx));
            (entered_rx, release_tx)
        }
    }

    /// A schedule the test drives by hand (it serves one stream).
    fn manual_ticks() -> (ScheduleSource, mpsc::UnboundedSender<()>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let rx = Mutex::new(Some(rx));
        let source: ScheduleSource = Arc::new(move || {
            Schedule::Manual(
                rx.lock()
                    .unwrap()
                    .take()
                    .expect("a manual schedule serves one stream"),
            )
        });
        (source, tx)
    }

    /// The production schedule, with a short period.
    fn every(period: Duration) -> ScheduleSource {
        Arc::new(move || Schedule::every(period))
    }

    async fn open_with(
        auth: &AuthState,
        tx: &broadcast::Sender<ServerEvent>,
        token: &str,
        source: ScheduleSource,
        timeout: Duration,
    ) -> Body {
        let response = sse_route_with(auth.clone(), tx.clone(), source, timeout)
            .oneshot(
                HttpRequest::get("/api/events")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.into_body()
    }

    async fn open(
        auth: &AuthState,
        tx: &broadcast::Sender<ServerEvent>,
        token: &str,
    ) -> (Body, mpsc::UnboundedSender<()>) {
        let (source, ticks) = manual_ticks();
        (
            open_with(auth, tx, token, source, REVALIDATE_TIMEOUT).await,
            ticks,
        )
    }

    /// The next frame's text, or `None` once the stream has ended. The
    /// timeout only turns a hang into a failure; nothing waits on it.
    async fn next_frame(body: &mut Body) -> Option<String> {
        tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .expect("timed out waiting for the stream")
            .map(|frame| {
                let bytes = frame
                    .expect("frame error")
                    .into_data()
                    .expect("expected a data frame");
                String::from_utf8(bytes.to_vec()).unwrap()
            })
    }

    fn changed(resource: &str) -> ServerEvent {
        ServerEvent::ResourceChanged {
            resource: resource.to_string(),
        }
    }

    /// One re-check, then an event: the event arrives, so the stream
    /// survived the check (the loop is `biased` towards a due re-check, so
    /// the check runs before the event is taken).
    async fn recheck_keeps_open(
        body: &mut Body,
        ticks: &mpsc::UnboundedSender<()>,
        tx: &broadcast::Sender<ServerEvent>,
        resource: &str,
    ) {
        ticks.send(()).unwrap();
        tx.send(changed(resource)).unwrap();
        let text = next_frame(body)
            .await
            .expect("the stream must survive the re-check");
        assert!(text.contains(resource), "{text}");
    }

    /// One re-check, then an event: the stream ends without delivering it.
    async fn recheck_closes(
        body: &mut Body,
        ticks: &mpsc::UnboundedSender<()>,
        tx: &broadcast::Sender<ServerEvent>,
    ) {
        ticks.send(()).unwrap();
        let _ = tx.send(changed("after-revocation"));
        assert_eq!(
            next_frame(body).await,
            None,
            "the stream must end at the re-check, before the next event"
        );
    }

    #[tokio::test]
    async fn an_open_stream_ends_at_the_next_recheck_after_delete_demote_or_password_change() {
        type Change = fn(&Store);
        let changes: [(&str, Change); 3] = [
            ("delete", |s| s.remove("alice")),
            // `UsersService` advances the epoch with the role change...
            ("demote", |s| s.put("alice", "viewer", 1, 1)),
            // ...and with a password change or reset.
            ("password", |s| s.put("alice", "admin", 1, 1)),
        ];
        for (name, change) in changes {
            let store = Store::default();
            store.put("alice", "admin", 1, 0);
            let auth = store.auth();
            let token = auth.login("alice", "pw").await.unwrap();
            let (tx, _rx) = broadcast::channel(16);
            let (mut body, ticks) = open(&auth, &tx, &token).await;
            recheck_keeps_open(&mut body, &ticks, &tx, "before").await;
            let lookups = store.lookups();

            change(&store);
            // Until the next re-check the stream is unchanged (the at-most
            // one interval window)...
            tx.send(changed("in-window")).unwrap();
            assert!(next_frame(&mut body).await.unwrap().contains("in-window"));
            // ...and the re-check ends it and revokes the session.
            recheck_closes(&mut body, &ticks, &tx).await;
            assert_eq!(store.lookups(), lookups + 1, "{name}: one lookup per tick");
            assert!(!auth.verify(&token), "{name}: the session is revoked");
        }
    }

    #[tokio::test]
    async fn a_store_failure_keeps_the_stream_and_the_checks_resume_after_recovery() {
        let store = Store::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = auth.login("alice", "pw").await.unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let (mut body, ticks) = open(&auth, &tx, &token).await;

        store.failing.store(true, Ordering::SeqCst);
        let before = store.lookups();
        recheck_keeps_open(&mut body, &ticks, &tx, "during-outage-1").await;
        recheck_keeps_open(&mut body, &ticks, &tx, "during-outage-2").await;
        assert_eq!(
            store.lookups(),
            before + 2,
            "the checks did run (and failed)"
        );
        assert!(auth.verify(&token), "a failed check keeps the session");

        store.failing.store(false, Ordering::SeqCst);
        recheck_keeps_open(&mut body, &ticks, &tx, "recovered").await;
        // The checks are live again: a revocation now ends the stream.
        store.remove("alice");
        recheck_closes(&mut body, &ticks, &tx).await;
    }

    /// A grant spec for the stream tests (ADR-0017): the viewer-public kind
    /// and an app-defined one, so both go through the same re-validation.
    fn grant_specs() -> [crate::grant::GrantSpec; 2] {
        use crate::grant::{GrantCondition, GrantKind, GrantSpec};
        let on: GrantCondition = Arc::new(|| Box::pin(async { Ok(true) }));
        [
            GrantSpec::new(
                GrantKind::public_viewer(),
                Identity {
                    id: "public".into(),
                    name: "public".into(),
                    role: "viewer".into(),
                },
                on.clone(),
            ),
            GrantSpec::new(
                GrantKind::new("commissioning").unwrap(),
                Identity {
                    id: "commissioning".into(),
                    name: "試運転".into(),
                    role: "admin".into(),
                },
                on,
            ),
        ]
    }

    #[tokio::test]
    async fn grant_streams_ignore_account_changes_but_end_at_the_recheck_after_a_revocation() {
        for spec in grant_specs() {
            let store = Store::default();
            store.put("alice", "admin", 1, 0);
            let (tx, _rx) = broadcast::channel(16);

            // A grant session has no account: nothing is looked up.
            let auth = store.auth();
            let token = auth
                .issue_grant_token(&spec, auth.grant_generation(&spec.kind))
                .unwrap();
            let (mut body, ticks) = open(&auth, &tx, &token).await;
            store.remove("alice");
            recheck_keeps_open(&mut body, &ticks, &tx, "grant-1").await;
            recheck_keeps_open(&mut body, &ticks, &tx, "grant-2").await;
            assert_eq!(store.lookups(), 0);

            // Closing the kind's condition (`revoke_grant_tokens`) ends the
            // stream at the next re-check - the same one path as a revoked
            // account session (ADR-0017 セキュリティ "ストリームの再検証は 1 経路").
            assert_eq!(auth.revoke_grant_tokens(&spec.kind), 1);
            tx.send(changed("in-window")).unwrap();
            assert!(next_frame(&mut body).await.unwrap().contains("in-window"));
            recheck_closes(&mut body, &ticks, &tx).await;
            assert_eq!(store.lookups(), 0, "{}: still no lookup", spec.kind);
        }
    }

    #[tokio::test]
    async fn no_revocation_streams_are_not_ended_by_account_changes() {
        let store = Store::default();
        let (tx, _rx) = broadcast::channel(16);

        // `DisabledNoRevocation`: account changes do not end the stream.
        store.put("alice", "admin", 1, 0);
        let auth = store.auth_without_revocation();
        let token = auth.login("alice", "pw").await.unwrap();
        let (mut body, ticks) = open(&auth, &tx, &token).await;
        store.put("alice", "viewer", 1, 5);
        recheck_keeps_open(&mut body, &ticks, &tx, "disabled-1").await;
        store.remove("alice");
        recheck_keeps_open(&mut body, &ticks, &tx, "disabled-2").await;
        assert_eq!(store.lookups(), 0);
        // Only the token itself ending does.
        auth.logout(&token);
        recheck_closes(&mut body, &ticks, &tx).await;
    }

    #[tokio::test]
    async fn a_session_rebound_while_its_recheck_was_in_flight_keeps_its_stream() {
        // The stream's check snapshotted epoch 0; the session's own password
        // change committed epoch 1 and re-bound this very token; then the
        // lookup (epoch 1) came back. Same rule as a request (#230).
        let store = Store::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let changer = auth.login("alice", "pw").await.unwrap();
        let other = auth.login("alice", "pw").await.unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let (mut changer_body, changer_ticks) = open(&auth, &tx, &changer).await;
        let (mut other_body, other_ticks) = open(&auth, &tx, &other).await;

        let (entered, release) = store.hold_next_lookup();
        changer_ticks.send(()).unwrap();
        let reading = tokio::spawn(async move {
            let frame = next_frame(&mut changer_body).await;
            (frame, changer_body)
        });
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("timed out waiting for the re-check's lookup")
            .expect("the re-check's lookup started");
        store.put("alice", "admin", 1, 1);
        assert!(auth.rotate_session_epoch(
            &changer,
            SessionStamp {
                account_id: 1,
                auth_epoch: 0
            },
            1
        ));
        release.send(()).unwrap();
        tx.send(changed("after-rebind")).unwrap();
        let (frame, mut changer_body) = reading.await.unwrap();
        assert!(frame
            .expect("the re-bound session keeps its stream")
            .contains("after-rebind"),);
        recheck_keeps_open(&mut changer_body, &changer_ticks, &tx, "still").await;

        // The account's other session was not re-bound: its stream ends.
        // (Drain the event the shared channel already gave it first.)
        assert!(next_frame(&mut other_body)
            .await
            .unwrap()
            .contains("after-rebind"));
        assert!(next_frame(&mut other_body).await.unwrap().contains("still"));
        recheck_closes(&mut other_body, &other_ticks, &tx).await;
    }

    #[tokio::test]
    async fn a_disconnected_stream_stops_rechecking() {
        let store = Store::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = auth.login("alice", "pw").await.unwrap();
        let (tx, _rx) = broadcast::channel(16);

        // Disconnect between checks: the stream (and its timer) is dropped.
        let (mut body, ticks) = open(&auth, &tx, &token).await;
        recheck_keeps_open(&mut body, &ticks, &tx, "open").await;
        let lookups = store.lookups();
        drop(body);
        assert!(ticks.is_closed(), "the stream's ticks were dropped with it");
        assert!(ticks.send(()).is_err());
        assert_eq!(store.lookups(), lookups, "no check after the disconnect");

        // Disconnect while a check is in flight: the check is dropped too,
        // without touching the session.
        let (mut body, ticks) = open(&auth, &tx, &token).await;
        let (entered, release) = store.hold_next_lookup();
        ticks.send(()).unwrap();
        let reading = tokio::spawn(async move { next_frame(&mut body).await });
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("timed out waiting for the re-check's lookup")
            .expect("the re-check's lookup started");
        reading.abort();
        assert!(reading.await.unwrap_err().is_cancelled());
        assert!(ticks.is_closed(), "the stream's ticks were dropped with it");
        assert!(
            release.send(()).is_err(),
            "the in-flight lookup was dropped with the stream"
        );
        assert!(auth.verify(&token), "an abandoned check does not revoke");
    }

    #[tokio::test]
    async fn the_production_schedule_ends_a_revoked_stream() {
        // The production schedule, with a short period: no manual ticks.
        let store = Store::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = auth.login("alice", "pw").await.unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let mut body = open_with(
            &auth,
            &tx,
            &token,
            every(Duration::from_millis(20)),
            REVALIDATE_TIMEOUT,
        )
        .await;

        store.remove("alice");
        assert_eq!(next_frame(&mut body).await, None);
        assert!(!auth.verify(&token));
    }

    // ---- Review of #234: slow checks must not starve the delivery ----

    const PERIOD: Duration = Duration::from_millis(30);
    /// Longer than [`PERIOD`]: every check overruns its interval.
    const SLOW_LOOKUP: Duration = Duration::from_millis(60);

    /// Keep sending and receiving events until at least `checks` lookups
    /// have run in total: the delivery keeps pace with checks that overrun
    /// the interval. Each event must arrive (a starved stream fails in
    /// `next_frame`'s timeout).
    async fn keeps_delivering_through(
        body: &mut Body,
        tx: &broadcast::Sender<ServerEvent>,
        store: &Store,
        checks: usize,
    ) {
        let mut sent = 0usize;
        while store.lookups() < checks {
            sent += 1;
            let resource = format!("event-{sent}");
            tx.send(changed(&resource)).unwrap();
            let text = next_frame(body)
                .await
                .expect("the stream must stay open while the checks overrun");
            assert!(text.contains(&resource), "{text}");
        }
    }

    #[tokio::test]
    async fn checks_slower_than_the_interval_do_not_starve_the_delivery() {
        // Every lookup succeeds, but only after SLOW_LOOKUP > PERIOD (the
        // timeout is generous here, so the checks really complete late).
        let store = Store::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = auth.login("alice", "pw").await.unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let mut body = open_with(&auth, &tx, &token, every(PERIOD), Duration::from_secs(1)).await;
        *store.delay.lock().unwrap() = Some(SLOW_LOOKUP);

        keeps_delivering_through(&mut body, &tx, &store, 4).await;
        assert!(auth.verify(&token));

        // The checks are still effective: a revocation ends the stream.
        store.remove("alice");
        assert_eq!(next_frame(&mut body).await, None);
    }

    #[tokio::test]
    async fn slow_failing_checks_do_not_starve_the_delivery_and_revocation_applies_after_recovery()
    {
        let store = Store::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = auth.login("alice", "pw").await.unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let mut body = open_with(&auth, &tx, &token, every(PERIOD), Duration::from_secs(1)).await;
        *store.delay.lock().unwrap() = Some(SLOW_LOOKUP);
        store.failing.store(true, Ordering::SeqCst);

        // Revoked during the outage: the failing checks cannot see it.
        store.remove("alice");
        keeps_delivering_through(&mut body, &tx, &store, 4).await;
        assert!(auth.verify(&token), "a failed check keeps the session");

        // Recovered: the next check ends the stream.
        store.failing.store(false, Ordering::SeqCst);
        assert_eq!(next_frame(&mut body).await, None);
        assert!(!auth.verify(&token));
    }

    #[tokio::test]
    async fn a_lookup_that_never_answers_times_out_and_the_delivery_goes_on() {
        let store = Store::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = auth.login("alice", "pw").await.unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let mut body =
            open_with(&auth, &tx, &token, every(PERIOD), Duration::from_millis(20)).await;
        store.hanging.store(true, Ordering::SeqCst);

        store.remove("alice");
        keeps_delivering_through(&mut body, &tx, &store, 4).await;
        assert!(auth.verify(&token), "a timed-out check keeps the session");

        // Answering again: the next check ends the revoked stream.
        store.hanging.store(false, Ordering::SeqCst);
        assert_eq!(next_frame(&mut body).await, None);
        assert!(!auth.verify(&token));
    }

    #[tokio::test]
    async fn a_timed_out_lookup_is_dropped_and_cannot_change_the_session_later() {
        let store = Store::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = auth.login("alice", "pw").await.unwrap();
        let (tx, _rx) = broadcast::channel(16);
        // Manual ticks (checks run only when the test says) with a short
        // timeout, so the assertions below cannot race a second check.
        let (source, ticks) = manual_ticks();
        let mut body = open_with(&auth, &tx, &token, source, Duration::from_millis(20)).await;

        // The check's lookup is held; meanwhile the account changes, so a
        // late answer from THAT lookup would revoke the session.
        let before = store.lookups();
        let (entered, mut release) = store.hold_next_lookup();
        ticks.send(()).unwrap();
        let reading = tokio::spawn(async move {
            let frame = next_frame(&mut body).await;
            (frame, body)
        });
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("timed out waiting for the check's lookup")
            .expect("the check's lookup started");
        store.put("alice", "admin", 1, 1);
        // The timeout dropped the held lookup (its release receiver is gone)
        // while the stream stays open...
        tokio::time::timeout(Duration::from_secs(5), release.closed())
            .await
            .expect("the timed-out lookup must be dropped");
        assert!(release.send(()).is_err());
        tx.send(changed("after-timeout")).unwrap();
        let (frame, mut body) = reading.await.unwrap();
        assert!(frame.unwrap().contains("after-timeout"));
        // ...and nothing it could have answered was applied (the token is
        // untouched until a check that completes decides).
        assert_eq!(
            store.lookups(),
            before + 1,
            "only the held lookup has run so far"
        );
        assert!(auth.verify(&token));
        // The next, completing check sees the change and ends the stream.
        recheck_closes(&mut body, &ticks, &tx).await;
        assert!(!auth.verify(&token));
    }
}
