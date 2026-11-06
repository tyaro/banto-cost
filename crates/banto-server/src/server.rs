//! Server lifecycle: bind, run, graceful-stop (spec §11.1, §11.4).

use axum::Router;
use banto_core::BantoError;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// Bind address + port for the embedded server (spec §11.2: bind address
/// and port are both configurable; default is localhost-only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub bind: String,
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1".to_string(),
            port: 8721,
        }
    }
}

/// How long [`RunningServer::stop`] waits for graceful shutdown before it
/// aborts the server task (Issue #283). Graceful shutdown waits for every open
/// connection to finish; long-lived ones (SSE, slow downloads) must not be
/// able to hold a settings change or app exit hostage.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// Server-wide stop signal, injected into every request as an `Extension` by
/// [`start`]. Long-lived handlers (the SSE stream, [`crate::events`]) watch it
/// and end on their own when the server is asked to stop - hyper's graceful
/// shutdown otherwise waits for them forever (Issue #283). Absent when a
/// router is served some other way (e.g. `oneshot` in tests); handlers treat
/// that as "never signalled".
#[derive(Clone)]
pub(crate) struct ShutdownSignal(watch::Receiver<bool>);

impl ShutdownSignal {
    /// Resolves once the server has been asked to stop (or its handle was
    /// dropped, which also stops it). Cancel-safe.
    pub(crate) async fn triggered(&mut self) {
        // `wait_for` checks the current value first, so a signal sent before
        // this call is not missed. `Err` = sender dropped = shutting down.
        let _ = self.0.wait_for(|stopped| *stopped).await;
    }
}

/// A handle to a running server: its bound address, and a way to stop it.
pub struct RunningServer {
    local_addr: SocketAddr,
    shutdown_tx: watch::Sender<bool>,
    join_handle: JoinHandle<()>,
}

impl RunningServer {
    /// The actual bound address (useful when `port: 0` asked the OS to pick
    /// a free port).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Signal graceful shutdown and wait for the server task to finish.
    ///
    /// Open SSE streams are told to end ([`ShutdownSignal`]). As a safety net
    /// for any other connection that does not finish, the wait is capped at
    /// [`STOP_TIMEOUT`], after which the server task is aborted (Issue #283).
    pub async fn stop(self) {
        self.stop_within(STOP_TIMEOUT).await;
    }

    async fn stop_within(mut self, limit: Duration) {
        let _ = self.shutdown_tx.send(true);
        if tokio::time::timeout(limit, &mut self.join_handle)
            .await
            .is_err()
        {
            eprintln!(
                "banto-server: 停止が{}秒以内に完了しなかったためサーバタスクを中断します",
                limit.as_secs()
            );
            self.join_handle.abort();
            let _ = self.join_handle.await;
        }
    }
}

/// A listener that is bound (the port is reserved, the OS may queue incoming
/// connections) but NOT yet serving: no request is read or answered until
/// [`BoundServer::serve`]. Lets a caller learn that the bind succeeded, do
/// other work that must finish before the listener can be reached (e.g.
/// persisting the settings it was started from, Issue #294 review), and only
/// then open it up. Dropping it releases the port without serving anything.
pub struct BoundServer {
    listener: TcpListener,
    local_addr: SocketAddr,
}

impl BoundServer {
    /// The actual bound address (useful when `port: 0` asked the OS to pick
    /// a free port).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Start serving `router` in a background task, with graceful shutdown
    /// wired up. Infallible: every failure mode of starting a server (the
    /// bind) was already resolved by [`bind`].
    pub fn serve(self, router: Router) -> RunningServer {
        let BoundServer {
            listener,
            local_addr,
        } = self;
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let router = router.layer(axum::Extension(ShutdownSignal(shutdown_rx.clone())));
        let join_handle = tokio::spawn(async move {
            // `into_make_service_with_connect_info::<SocketAddr>()` (rather than
            // the plain `into_make_service()`) makes each connection's peer
            // address available to handlers via `ConnectInfo<SocketAddr>` - the
            // login rate limiter (`auth::login_handler`, spec §11.2) keys its
            // lockout on client IP + username. Handlers extract it as
            // `Option<ConnectInfo<..>>`, so this is purely additive: routers
            // served some other way still work, just with a username-only key.
            let server = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            );
            let graceful = server.with_graceful_shutdown(async move {
                // Signalled, or the handle dropped (`Err`): either way, stop.
                let _ = shutdown_rx.wait_for(|stopped| *stopped).await;
            });
            if let Err(err) = graceful.await {
                eprintln!("banto-server: サーバエラー: {err}");
            }
        });

        RunningServer {
            local_addr,
            shutdown_tx,
            join_handle,
        }
    }
}

/// Bind `config` without serving yet (first half of [`start`]). Binding
/// failures (e.g. the port already being in use) surface as
/// `BantoError::Other` with a Japanese, readable message (this crosses into
/// user-facing settings-screen territory per spec §11.4, so keep it friendly
/// rather than a raw OS error).
pub async fn bind(config: ServerConfig) -> Result<BoundServer, BantoError> {
    let addr = format!("{}:{}", config.bind, config.port);
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|err| bind_error(&addr, &err))?;
    bound_from(listener)
}

/// The readable message [`bind`] reports for a failed bind of `addr`.
fn bind_error(addr: &str, err: &std::io::Error) -> BantoError {
    BantoError::Other(format!(
        "サーバの起動に失敗しました（{addr}）: {err}。ポート番号を変更するか、\
         他のプロセスがそのポートを使用していないか確認してください。"
    ))
}

fn bound_from(listener: TcpListener) -> Result<BoundServer, BantoError> {
    let local_addr = listener
        .local_addr()
        .map_err(|err| BantoError::Other(err.to_string()))?;
    Ok(BoundServer {
        listener,
        local_addr,
    })
}

/// How many ports after the requested one [`bind_with_port_fallback`] tries
/// (requested + 1 ..= requested + 19, never past 65535).
///
/// A small, fixed range right behind the configured port - not port 0 (an
/// OS-assigned port) or a random port - so the port the server ends up on
/// stays predictable: an administrator can tell which ports to allow or look
/// for, and the chosen port is saved and reused on the next launch (other
/// devices' bookmarks and QR codes keep working). The range is relative to
/// the configured port, so it is NOT kept out of the OS's ephemeral range: a
/// configured port near it (e.g. 49151 or 50000) yields candidates inside it.
/// 19 extra ports (20
/// candidates in all) is enough to step over another copy of the app or a
/// couple of unrelated services on neighbouring ports without wandering far.
pub const PORT_FALLBACK_SPAN: u16 = 19;

/// Why [`bind_with_port_fallback`] could not bind.
#[derive(Debug)]
pub enum PortFallbackError {
    /// The requested port was in use and no port of the fallback range
    /// (`requested + 1 ..= last_tried`) could be bound. `error` is the bind
    /// error for the requested port. `unavailable` lists the candidates that
    /// failed for a reason other than being in use (e.g. a port the OS
    /// reserves, which Windows reports as access denied), with their errors;
    /// empty means every candidate was in use.
    Exhausted {
        requested: u16,
        last_tried: u16,
        error: BantoError,
        unavailable: Vec<(u16, BantoError)>,
    },
    /// The bind failed for a reason other than the port being in use
    /// (permission, address not available, unparseable address, ...). No other
    /// port was tried.
    Failed(BantoError),
}

impl PortFallbackError {
    /// The underlying bind error (for the requested port).
    pub fn into_error(self) -> BantoError {
        match self {
            PortFallbackError::Exhausted { error, .. } | PortFallbackError::Failed(error) => error,
        }
    }
}

/// The ports [`bind_with_port_fallback`] tries after `port`, clamped to 65535
/// (empty when `port` is 65535).
fn fallback_ports(port: u16, span: u16) -> std::ops::RangeInclusive<u32> {
    let first = u32::from(port) + 1;
    let last = (u32::from(port) + u32::from(span)).min(u32::from(u16::MAX));
    first..=last
}

/// Like [`bind`], but when the requested port is in use (`AddrInUse`, and only
/// then; spec §11.4's automatic fallback on a port conflict), try the ports right behind it ([`PORT_FALLBACK_SPAN`]) in order and
/// bind the first free one. The bind address is never changed. Compare
/// `local_addr().port()` with `config.port` to see whether another port was
/// chosen.
///
/// Meant for starting a server from SAVED settings (e.g. at app launch),
/// where serving on a neighbouring port beats not serving at all. A port the
/// user has just typed in should be bound with plain [`bind`] instead, so an
/// explicit choice is never silently changed.
pub async fn bind_with_port_fallback(
    config: ServerConfig,
) -> Result<BoundServer, PortFallbackError> {
    bind_with_port_fallback_span(config, PORT_FALLBACK_SPAN).await
}

/// Like [`bind`] (no other port is tried), but tells a port in use apart
/// from every other bind failure, so a caller can report "that port is taken"
/// without parsing the message (Issue #459: the desktop app's `server_apply`
/// reports a port conflict in its status).
///
/// `Err(PortFallbackError::Exhausted { .. })` means exactly "the requested
/// port is in use" (`last_tried == requested`, `unavailable` empty);
/// `Err(PortFallbackError::Failed(_))` is any other failure. The error
/// messages are the same as [`bind`]'s.
pub async fn bind_without_fallback(config: ServerConfig) -> Result<BoundServer, PortFallbackError> {
    bind_with_port_fallback_span(config, 0).await
}

async fn bind_with_port_fallback_span(
    config: ServerConfig,
    span: u16,
) -> Result<BoundServer, PortFallbackError> {
    let addr = format!("{}:{}", config.bind, config.port);
    let first_err = match TcpListener::bind(&addr).await {
        Ok(listener) => return bound_from(listener).map_err(PortFallbackError::Failed),
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => bind_error(&addr, &err),
        Err(err) => return Err(PortFallbackError::Failed(bind_error(&addr, &err))),
    };
    let mut last_tried = config.port;
    let mut unavailable = Vec::new();
    for port in fallback_ports(config.port, span) {
        // `fallback_ports` never yields more than u16::MAX.
        let port = port as u16;
        last_tried = port;
        let candidate = format!("{}:{}", config.bind, port);
        match TcpListener::bind(&candidate).await {
            Ok(listener) => return bound_from(listener).map_err(PortFallbackError::Failed),
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => continue,
            // Some other failure on this one port (e.g. a port the OS reserves,
            // which Windows reports as access denied): skip it, but keep the
            // error so the caller does not report the range as "all in use".
            // The requested port failed only with "in use", so the address
            // itself is fine and a neighbouring port may still work.
            Err(err) => unavailable.push((port, bind_error(&candidate, &err))),
        }
    }
    Err(PortFallbackError::Exhausted {
        requested: config.port,
        last_tried,
        error: first_err,
        unavailable,
    })
}

/// [`bind`] then [`BoundServer::serve`] in one step: bind `config` and start
/// serving `router` in a background task.
pub async fn start(config: ServerConfig, router: Router) -> Result<RunningServer, BantoError> {
    Ok(bind(config).await?.serve(router))
}

/// URLs a client could use to reach a server bound to `port`, assuming it
/// listens on every interface (`0.0.0.0`): always `http://127.0.0.1:{port}`,
/// plus one entry per non-loopback IPv4 interface. This is `lan_urls`'s
/// pre-#216 behavior, kept unchanged and under its original name.
///
/// **Exists only for source/binary compatibility with derived apps already
/// built against this signature** (`banto-server` is consumed by derived
/// apps via a git-tag/`path:` dependency - see `docs/publishing.md` - so
/// changing a `pub fn`'s signature breaks every such app's next build, not
/// just this repo's). New callers should use [`lan_urls_for_bind`] instead,
/// which is what this function now delegates to (hardcoding `"0.0.0.0"`) -
/// **this one reintroduces Issue #216's bug** for any server actually bound
/// to something else, because it cannot know the caller's real `bind`.
///
/// Deliberately not `#[deprecated]`: derived apps commonly build with
/// `-D warnings` (this repo's CI `rust` job does too), so marking this
/// deprecated would turn a routine dependency bump into a broken build for
/// every caller that has not yet migrated - that migration should be a
/// deliberate change a maintainer chooses to make, not a side effect of
/// picking up a patch release.
pub fn lan_urls(port: u16) -> Vec<String> {
    lan_urls_for_bind("0.0.0.0", port)
}

/// URLs a client could use to reach a server bound to `bind`:`port` (spec
/// §11.4's access-URL display; Issue #216). The set returned is scoped to
/// what `bind` actually listens on, so callers building "you can reach this
/// server at..." UI never advertise an address nothing is listening on:
///
/// - **loopback IPv4** (`127.0.0.0/8`, any bracketed/whitespace/IPv4-mapped
///   spelling - see [`parse_bind`]): only that loopback URL - a LAN URL
///   would be misleading since no other machine can reach it.
/// - **unspecified IPv4** (`0.0.0.0`): loopback plus one entry per
///   non-loopback IPv4 interface (unchanged from the original `lan_urls`
///   behavior - this is the "LAN公開" case).
/// - **a specific IPv4 address**: only that address's URL - binding to one
///   NIC means only that NIC's clients can connect, so nothing else is
///   listed.
/// - **anything IPv6** (loopback `::1`, unspecified `::`, or a specific
///   address - any bracketed/whitespace spelling, not an IPv4-mapped one,
///   which [`parse_bind`] already normalizes to plain IPv4 above): **no
///   URLs at all**. Owner decision, 2026-09-29: IPv6 is out of scope for
///   this settings screen's URL/QR guidance for now - `start` does not set
///   `IPV6_V6ONLY=0` before binding (so a `::` bind is not reachable over
///   IPv4 on Windows, where sockets default to IPv6-only), and a NIC's own
///   IPv6 address is frequently link-local (`fe80::/10`, reachable only
///   with a zone/scope id this server has no way to supply for the
///   *client's* interface). Both are real, previously-reported bugs (PR
///   #254 review rounds 3-4); rather than build and maintain IPv6-specific
///   guidance for a path this app does not otherwise support end-to-end,
///   the simpler and safer choice is to not guide toward IPv6 destinations
///   at all until that support exists. Revisit if/when the listener grows
///   deliberate dual-stack/IPv6 support.
/// - **unparseable even after [`parse_bind`]'s normalization** (defensive;
///   the settings UI only ever sends the addresses above): no URLs, for the
///   same reason as IPv6 above - a string we could not classify is not one
///   we can vouch for as a connectable destination (this used to return the
///   raw, unnormalized `bind:port` string verbatim; that was itself
///   sometimes not a connectable URL, e.g. a zone-qualified address).
pub fn lan_urls_for_bind(bind: &str, port: u16) -> Vec<String> {
    use std::net::IpAddr;

    match parse_bind(bind) {
        Some(IpAddr::V4(v4)) if v4.is_loopback() => vec![format!("http://{v4}:{port}")],
        Some(IpAddr::V4(v4)) if v4.is_unspecified() => {
            unspecified_v4_urls(&non_loopback_v4_addrs(), port)
        }
        Some(IpAddr::V4(v4)) => vec![format!("http://{v4}:{port}")],
        Some(IpAddr::V6(_)) | None => Vec::new(),
    }
}

/// Parses `bind` into the address it actually represents, tolerating forms
/// a real `ServerConfig.bind`/`BANTO_BIND` value can take beyond the bare
/// dotted/colon notation `IpAddr::from_str` accepts on its own (PR #254
/// review, 3rd round):
///
/// - **Surrounding whitespace** (`" ::1 "`) is trimmed.
/// - **A bracketed IPv6 literal** (`"[::]"`, `"[::1]"` - the form a
///   `[host]:port` address carries, and a form `start`'s
///   `TcpListener::bind` already accepts today) has its brackets stripped
///   before parsing - without this, `"[::]".parse::<IpAddr>()` fails and
///   the caller falls through to the raw-string fallback, which is how the
///   unspecified-address bug this function fixes slipped in for the
///   bracketed form specifically.
/// - **An IPv4-mapped IPv6 address** (`"::ffff:127.0.0.1"`,
///   `"[::ffff:0.0.0.0]"`) is normalized to its plain IPv4 form via
///   [`Ipv6Addr::to_ipv4_mapped`], so the `is_loopback`/`is_unspecified`
///   checks in [`lan_urls_for_bind`] see the address it actually is -
///   `Ipv6Addr::is_loopback` itself does not recognize this form (it only
///   matches the literal `::1`), so without this an IPv4-mapped loopback or
///   unspecified address would fall through as "a specific address" and be
///   advertised as directly connectable.
///
/// Deliberately does **not** support a zone id (`"fe80::1%eth0"`):
/// `IpAddr::from_str` already rejects it outright, and a link-local,
/// zone-qualified bind is not a realistic input for this desktop app's
/// LAN-exposure setting. It falls through to the `None` case in
/// [`lan_urls_for_bind`] (no URLs) like any other unparseable value - safe
/// (no panic, no false LAN-reachability claim), just not specially
/// classified.
fn parse_bind(bind: &str) -> Option<std::net::IpAddr> {
    use std::net::IpAddr;

    let trimmed = bind.trim();
    let unbracketed = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(trimmed);

    let addr = unbracketed.parse::<IpAddr>().ok()?;
    Some(match addr {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    })
}

/// This machine's non-loopback IPv4 interface addresses - the one place
/// that talks to `if_addrs` for the `0.0.0.0` case. Kept separate from URL
/// *formatting* ([`unspecified_v4_urls`] below) so tests can exercise the
/// formatting logic against a fixed fixture instead of this machine's
/// actual NICs (owner review on PR #254, P2 2nd round: a test that called
/// this function directly was flaky on any machine/container with no
/// non-loopback IPv4 interface).
fn non_loopback_v4_addrs() -> Vec<std::net::Ipv4Addr> {
    let mut addrs = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for iface in interfaces {
            if iface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(v4) = iface.ip() {
                addrs.push(v4);
            }
        }
    }
    addrs
}

/// Pure: the full `0.0.0.0`-bind URL list - loopback first, then `addrs`
/// (already-enumerated non-loopback IPv4 addresses, [`non_loopback_v4_addrs`]
/// in production, a fixed fixture in tests).
fn unspecified_v4_urls(addrs: &[std::net::Ipv4Addr], port: u16) -> Vec<String> {
    let mut urls = vec![format!("http://127.0.0.1:{port}")];
    urls.extend(addrs.iter().map(|v4| format!("http://{v4}:{port}")));
    urls
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_urls_for_bind_ipv4_loopback_bind_is_loopback_only() {
        // Issue #216: a loopback bind must never advertise a LAN URL - the
        // whole regression was this case falling through to the 0.0.0.0
        // (enumerate every interface) behavior instead.
        assert_eq!(
            lan_urls_for_bind("127.0.0.1", 8721),
            vec!["http://127.0.0.1:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_for_bind_loopback_range_ipv4_bind_is_loopback_only() {
        // 127.0.0.0/8, not just the canonical 127.0.0.1 (PR #254 review,
        // 2nd round).
        assert_eq!(
            lan_urls_for_bind("127.0.0.2", 8721),
            vec!["http://127.0.0.2:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_for_bind_ipv4_unspecified_bind_includes_loopback_and_lan_ipv4() {
        // 0.0.0.0: same shape as the original `lan_urls(port)` - loopback
        // first, then whatever non-loopback IPv4 interfaces this machine
        // has (0 or more; CI runners commonly have none besides loopback).
        let urls = lan_urls_for_bind("0.0.0.0", 8721);
        assert_eq!(urls[0], "http://127.0.0.1:8721");
    }

    #[test]
    fn lan_urls_for_bind_specific_ipv4_bind_is_that_address_only() {
        // Binding one NIC must not also list every other interface - only
        // that NIC's clients can actually reach this listener.
        assert_eq!(
            lan_urls_for_bind("192.168.1.50", 8721),
            vec!["http://192.168.1.50:8721".to_string()]
        );
    }

    // --- PR #254 review, 3rd round: bracketed / whitespace / IPv4-mapped
    // IPv4 spellings must classify the same as their bare form.

    #[test]
    fn lan_urls_for_bind_whitespace_padded_ipv4_bind_is_trimmed() {
        assert_eq!(
            lan_urls_for_bind("  127.0.0.1  ", 8721),
            vec!["http://127.0.0.1:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_for_bind_ipv4_mapped_ipv6_loopback_is_loopback_only() {
        // "::ffff:127.0.0.1" is IPv6 syntax for the IPv4 address
        // 127.0.0.1 - `parse_bind` normalizes it to plain IPv4 via
        // `to_ipv4_mapped`, so it takes the IPv4 loopback path above, not
        // the "anything IPv6" no-URLs path below.
        assert_eq!(
            lan_urls_for_bind("::ffff:127.0.0.1", 8721),
            vec!["http://127.0.0.1:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_for_bind_bracketed_ipv4_mapped_ipv6_unspecified_is_unspecified() {
        // "::ffff:0.0.0.0" normalizes to plain 0.0.0.0 the same way -
        // exercises the IPv4 unspecified path, not "anything IPv6".
        let urls = lan_urls_for_bind("[::ffff:0.0.0.0]", 8721);
        assert_eq!(urls[0], "http://127.0.0.1:8721");
    }

    // --- Owner decision, 2026-09-29: IPv6 is out of scope for URL/QR
    // guidance for now (PR #254 review, 4th round found two real bugs in an
    // earlier version of this fix - IPv4 falsely advertised as reachable
    // over a `::` bind on Windows, and link-local IPv6 advertised without a
    // zone id - rather than keep patching IPv6-specific guidance for a path
    // this app does not otherwise support end-to-end, IPv6 binds now
    // produce no URLs at all).

    #[test]
    fn lan_urls_for_bind_ipv6_loopback_bind_yields_no_urls() {
        assert_eq!(lan_urls_for_bind("::1", 8721), Vec::<String>::new());
    }

    #[test]
    fn lan_urls_for_bind_bracketed_ipv6_loopback_bind_yields_no_urls() {
        assert_eq!(lan_urls_for_bind("[::1]", 8721), Vec::<String>::new());
    }

    #[test]
    fn lan_urls_for_bind_ipv6_wildcard_yields_no_urls() {
        assert_eq!(lan_urls_for_bind("::", 8721), Vec::<String>::new());
    }

    #[test]
    fn lan_urls_for_bind_bracketed_ipv6_wildcard_yields_no_urls() {
        // The bind value at the center of the review's 3rd-round report
        // (`start`'s `TcpListener::bind` accepts this fine) - previously
        // this fell through to a raw-string fallback that returned the
        // unspecified address itself as a "destination" (RFC 4291 §2.5.2);
        // now, like every other IPv6 bind, it returns no URLs.
        assert_eq!(lan_urls_for_bind("[::]", 8721), Vec::<String>::new());
    }

    #[test]
    fn lan_urls_for_bind_unabbreviated_bracketed_ipv6_wildcard_yields_no_urls() {
        assert_eq!(
            lan_urls_for_bind("[0:0:0:0:0:0:0:0]", 8721),
            Vec::<String>::new()
        );
    }

    #[test]
    fn lan_urls_for_bind_specific_ipv6_bind_yields_no_urls() {
        // The bind the review's 4th-round report used as its non-loopback
        // example. A specific IPv6 address is explicitly configured (not
        // guessed), but IPv6 guidance is out of scope entirely for now, so
        // this yields no URLs the same as every other IPv6 case above.
        assert_eq!(lan_urls_for_bind("2001:db8::1", 8721), Vec::<String>::new());
    }

    #[test]
    fn lan_urls_for_bind_link_local_ipv6_bind_yields_no_urls() {
        // The review's 4th-round link-local report (`fe80::/10`) - already
        // covered by "IPv6 yields no URLs", but pinned explicitly since it
        // was the concrete bug reported.
        assert_eq!(lan_urls_for_bind("fe80::abcd", 8721), Vec::<String>::new());
    }

    #[test]
    fn lan_urls_for_bind_zone_id_yields_no_urls() {
        // Documented decision (PR #254 review, 3rd round): a zone-qualified
        // link-local address is not specially parsed - `IpAddr::from_str`
        // already rejects it, so `parse_bind` returns `None` - but the
        // outcome is the same "no URLs" as every unparseable/IPv6 bind,
        // not a raw, possibly-unusable string.
        assert_eq!(
            lan_urls_for_bind("fe80::1%eth0", 8721),
            Vec::<String>::new()
        );
    }

    #[test]
    fn lan_urls_for_bind_unparseable_bind_yields_no_urls() {
        // Defensive only - the settings UI never sends a non-IP bind - but
        // must not panic, and must not advertise a URL we cannot vouch for
        // (owner decision, 2026-09-29: this used to return the raw
        // `bind:port` string verbatim, which is not always a usable URL
        // either).
        assert_eq!(lan_urls_for_bind("not-an-ip", 8721), Vec::<String>::new());
    }

    // --- Back-compat: `lan_urls(port)` (pre-#216 signature) --------------
    //
    // Owner review on PR #254: `lan_urls`'s signature must not change (it is
    // `pub` in a crate derived apps depend on via a git-tag/`path:`
    // dependency - a signature change breaks their build on the next
    // dependency bump, not just this repo). These pin its old, bind-agnostic
    // behavior so a future edit cannot silently fold it back into
    // `lan_urls_for_bind`'s signature or change what it returns.

    #[test]
    fn lan_urls_kept_for_compat_matches_its_pre_216_shape() {
        // Old callers get exactly the old shape: loopback first, then
        // non-loopback IPv4 interfaces - same as `lan_urls_for_bind("0.0.0.0", ..)`.
        let old = lan_urls(8721);
        let new = lan_urls_for_bind("0.0.0.0", 8721);
        assert_eq!(old, new);
        assert_eq!(old[0], "http://127.0.0.1:8721");
    }

    // Owner review on PR #254 (P2, 2nd round): the original version of this
    // test called `lan_urls(8721)` (live interface enumeration) and asserted
    // it differs from a loopback-scoped result. On any machine/container
    // with no non-loopback IPv4 interface - a real, common case, not just a
    // theoretical one - `lan_urls(8721)` legitimately degenerates to the
    // same single loopback URL, so `assert_ne!` failed there even though
    // nothing was wrong. Fixed by testing `unspecified_v4_urls` (the pure
    // formatter `lan_urls`/`lan_urls_for_bind("0.0.0.0", ..)` delegates to)
    // against a fixed fixture instead of this machine's real NICs, and by
    // testing the "no LAN interfaces" case explicitly as an expected normal
    // outcome rather than leaving it to accidentally fail the counter-proof.

    #[test]
    fn lan_urls_kept_for_compat_counter_proof_it_is_not_bind_aware() {
        // Documents the known limitation this compat shim carries forward:
        // unlike `lan_urls_for_bind`, `lan_urls(port)` has no way to learn
        // the caller's actual bind, so it cannot avoid Issue #216's bug for
        // a caller that is not actually listening on 0.0.0.0. A caller
        // bound to loopback must migrate to `lan_urls_for_bind` to get the
        // fix - this test fails if `lan_urls` is ever "fixed" to somehow
        // guess a narrower scope on its own (it can't, and shouldn't try).
        let fixture = [std::net::Ipv4Addr::new(192, 168, 1, 50)];
        let old_shaped = unspecified_v4_urls(&fixture, 8721);
        let loopback_scoped = lan_urls_for_bind("127.0.0.1", 8721);
        assert_ne!(
            old_shaped, loopback_scoped,
            "lan_urls(port) must keep behaving like a 0.0.0.0 bind, not a loopback one"
        );
    }

    #[test]
    fn lan_urls_kept_for_compat_matches_loopback_when_there_are_no_lan_interfaces() {
        // Normal/expected case, NOT a failure: on a machine with zero
        // non-loopback interfaces, the 0.0.0.0-shaped result legitimately
        // degenerates to the same single loopback URL as a loopback bind.
        // This is exactly the case the old, network-dependent counter-proof
        // test was silently hitting in some CI/container environments.
        let no_lan_interfaces: [std::net::Ipv4Addr; 0] = [];
        let old_shaped = unspecified_v4_urls(&no_lan_interfaces, 8721);
        let loopback_scoped = lan_urls_for_bind("127.0.0.1", 8721);
        assert_eq!(old_shaped, loopback_scoped);
    }

    #[test]
    fn unspecified_v4_urls_fixture_loopback_first_then_given_addrs() {
        // Pins the pure formatter's own shape against a fixed fixture,
        // independent of this machine's real NICs.
        let fixture = [
            std::net::Ipv4Addr::new(192, 168, 1, 50),
            std::net::Ipv4Addr::new(10, 0, 0, 2),
        ];
        assert_eq!(
            unspecified_v4_urls(&fixture, 8721),
            vec![
                "http://127.0.0.1:8721".to_string(),
                "http://192.168.1.50:8721".to_string(),
                "http://10.0.0.2:8721".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn start_and_stop_a_minimal_router() {
        let router = Router::new().route("/", axum::routing::get(|| async { "ok" }));
        let server = start(
            ServerConfig {
                bind: "127.0.0.1".to_string(),
                port: 0, // let the OS pick a free port
            },
            router,
        )
        .await
        .expect("server should start");

        let addr = server.local_addr();
        let response = reqwest_get(addr).await;
        assert_eq!(response, "ok");

        server.stop().await;
    }

    #[tokio::test]
    async fn bound_server_does_not_answer_until_serve() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let router = Router::new().route("/", axum::routing::get(|| async { "ok" }));
        let bound = bind(ServerConfig {
            bind: "127.0.0.1".to_string(),
            port: 0,
        })
        .await
        .expect("bind should succeed");
        let addr = bound.local_addr();

        // The port is reserved (the connect is queued by the OS) but nothing
        // reads or answers the request before `serve`.
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(
                b"GET / HTTP/1.1
Host: localhost
Connection: close

",
            )
            .await
            .unwrap();
        let mut buf = [0u8; 64];
        let early = tokio::time::timeout(Duration::from_millis(300), stream.read(&mut buf)).await;
        assert!(early.is_err(), "no response may be produced before serve()");

        let server = bound.serve(router);
        assert_eq!(server.local_addr(), addr);
        // The request queued before serve() is answered once serving starts.
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut rest))
            .await
            .expect("answer after serve")
            .unwrap();
        assert!(String::from_utf8_lossy(&rest).ends_with("ok"));
        assert_eq!(reqwest_get(addr).await, "ok");
        server.stop().await;
    }

    #[tokio::test]
    async fn bind_reports_a_port_in_use_and_drop_releases_the_port() {
        let bound = bind(ServerConfig {
            bind: "127.0.0.1".to_string(),
            port: 0,
        })
        .await
        .unwrap();
        let port = bound.local_addr().port();
        let config = ServerConfig {
            bind: "127.0.0.1".to_string(),
            port,
        };
        assert!(bind(config.clone()).await.is_err());
        drop(bound);
        bind(config).await.expect("port is free after drop");
    }

    /// Hold `count` consecutive loopback ports in 20000-29999 (retrying with
    /// another base when a neighbour happens to be taken by something else).
    /// Not next to an OS-picked port: these tests release and re-bind the
    /// ports around the base, and Windows hands out ephemeral ports
    /// sequentially, so a parallel test's `port: 0` bind could take one of
    /// them in between. Both OS ephemeral ranges (Windows 49152+, Linux
    /// 32768+) are well above this range.
    async fn hold_consecutive_ports(count: u16) -> Vec<BoundServer> {
        let start = 20_000 + (std::process::id() % 2_000) as u16 * 5;
        let bases = (start..30_000)
            .step_by(23)
            .chain((20_000..start).step_by(23));
        for base in bases {
            let mut held = Vec::new();
            for offset in 0..count {
                match bind(ServerConfig {
                    bind: "127.0.0.1".to_string(),
                    port: base + offset,
                })
                .await
                {
                    Ok(bound) => held.push(bound),
                    Err(_) => break,
                }
            }
            if held.len() == usize::from(count) {
                return held;
            }
        }
        panic!("could not hold {count} consecutive ports");
    }

    #[tokio::test]
    async fn port_fallback_binds_the_requested_port_when_free() {
        let held = hold_consecutive_ports(1).await;
        let port = held[0].local_addr().port();
        drop(held);
        let bound = bind_with_port_fallback(ServerConfig {
            bind: "127.0.0.1".to_string(),
            port,
        })
        .await
        .expect("free port binds");
        assert_eq!(bound.local_addr().port(), port);
    }

    #[tokio::test]
    async fn port_fallback_picks_the_next_free_port_when_the_requested_one_is_in_use() {
        // Hold two ports and release the second: the requested one stays in
        // use, the one right behind it is (almost certainly) free.
        let mut held = hold_consecutive_ports(2).await;
        let port = held[0].local_addr().port();
        drop(held.pop());
        let bound = bind_with_port_fallback(ServerConfig {
            bind: "127.0.0.1".to_string(),
            port,
        })
        .await
        .expect("a neighbouring port binds");
        let chosen = bound.local_addr().port();
        assert_ne!(chosen, port);
        assert!(
            (port + 1..=port.saturating_add(PORT_FALLBACK_SPAN)).contains(&chosen),
            "chosen port {chosen} must be in the range right behind {port}"
        );
        assert_eq!(bound.local_addr().ip().to_string(), "127.0.0.1");
    }

    #[tokio::test]
    async fn port_fallback_fails_when_the_whole_range_is_in_use() {
        // Span 2 keeps the test small: requested + 2 neighbours, all held.
        let held = hold_consecutive_ports(3).await;
        let port = held[0].local_addr().port();
        let err = bind_with_port_fallback_span(
            ServerConfig {
                bind: "127.0.0.1".to_string(),
                port,
            },
            2,
        )
        .await
        .err()
        .expect("every candidate is in use");
        match err {
            PortFallbackError::Exhausted {
                requested,
                last_tried,
                error,
                unavailable,
            } => {
                assert_eq!(requested, port);
                assert_eq!(last_tried, port + 2);
                assert!(error.to_string().contains(&port.to_string()));
                assert!(unavailable.is_empty(), "every candidate was in use");
            }
            other => panic!("expected Exhausted, got {other:?}"),
        }
        drop(held);
    }

    #[tokio::test]
    async fn bind_without_fallback_reports_in_use_and_tries_no_other_port() {
        let held = hold_consecutive_ports(1).await;
        let port = held[0].local_addr().port();
        let err = bind_without_fallback(ServerConfig {
            bind: "127.0.0.1".to_string(),
            port,
        })
        .await
        .err()
        .expect("the port is in use");
        match err {
            PortFallbackError::Exhausted {
                requested,
                last_tried,
                unavailable,
                ..
            } => {
                assert_eq!((requested, last_tried), (port, port));
                assert!(unavailable.is_empty());
            }
            other => panic!("expected Exhausted, got {other:?}"),
        }
        drop(held);
        let bound = bind_without_fallback(ServerConfig {
            bind: "127.0.0.1".to_string(),
            port,
        })
        .await
        .expect("free again");
        assert_eq!(bound.local_addr().port(), port);
    }

    #[tokio::test]
    async fn port_fallback_does_not_try_other_ports_for_a_non_in_use_failure() {
        // 192.0.2.1 (TEST-NET-1) is not an address of this machine, so the
        // bind fails with "address not available", not "in use".
        let err = bind_with_port_fallback(ServerConfig {
            bind: "192.0.2.1".to_string(),
            port: 8721,
        })
        .await
        .err()
        .expect("foreign address cannot be bound");
        assert!(
            matches!(err, PortFallbackError::Failed(_)),
            "expected Failed, got {err:?}"
        );
    }

    #[test]
    fn fallback_ports_stay_behind_the_requested_port_and_below_65536() {
        assert_eq!(fallback_ports(8721, PORT_FALLBACK_SPAN), 8722..=8740);
        assert_eq!(fallback_ports(65530, PORT_FALLBACK_SPAN), 65531..=65535);
        assert!(fallback_ports(65535, PORT_FALLBACK_SPAN).is_empty());
    }

    /// Tiny hand-rolled GET so this test does not need an HTTP client
    /// dependency: connects with a plain TCP stream and reads the response.
    async fn reqwest_get(addr: SocketAddr) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(addr)
            .await
            .expect("connect should succeed");
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .expect("write should succeed");
        let mut buf = Vec::new();
        stream
            .read_to_end(&mut buf)
            .await
            .expect("read should succeed");
        let text = String::from_utf8_lossy(&buf);
        text.rsplit("\r\n\r\n").next().unwrap_or("").to_string()
    }

    // ---- Issue #283: stop() with open long-lived connections --------------

    fn sse_auth() -> crate::auth::AuthState {
        crate::auth::AuthState::new(
            |u: String, p: String| {
                Box::pin(async move {
                    (u == "admin" && p == "admin").then(|| crate::auth::Identity {
                        id: "admin".to_string(),
                        name: "管理者".to_string(),
                        role: "admin".to_string(),
                    })
                })
            },
            crate::auth::SessionValidation::DisabledNoRevocation,
        )
    }

    /// Opens an authenticated SSE stream and returns the live socket after
    /// the response head arrived (so the stream is really open).
    async fn open_sse(addr: SocketAddr, token: &str) -> tokio::net::TcpStream {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req = format!(
            "GET /api/events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        let mut buf = [0u8; 512];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buf).await.unwrap();
            assert!(n > 0, "closed before the response head");
            head.extend_from_slice(&buf[..n]);
        }
        let head = String::from_utf8_lossy(&head);
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(head.to_ascii_lowercase().contains("text/event-stream"));
        stream
    }

    #[tokio::test]
    async fn stop_completes_while_authenticated_sse_connections_stay_open() {
        let auth = sse_auth();
        let token = auth.login("admin", "admin").await.unwrap();
        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        // `tx` stays alive for the whole test, like AppState/ItemsService in
        // production - the channel does not close on its own.
        let router = crate::events::sse_route(auth, tx.clone());
        let server = start(
            ServerConfig {
                bind: "127.0.0.1".to_string(),
                port: 0,
            },
            router,
        )
        .await
        .unwrap();

        // Several simultaneous streams, all held open by the client.
        let mut streams = Vec::new();
        for _ in 0..3 {
            streams.push(open_sse(server.local_addr(), &token).await);
        }

        tokio::time::timeout(Duration::from_secs(3), server.stop())
            .await
            .expect("stop() must finish while SSE streams are open");

        // The streams were ended by the server (EOF), not left dangling.
        for mut stream in streams {
            use tokio::io::AsyncReadExt;
            let mut sink = Vec::new();
            tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut sink))
                .await
                .expect("client side sees the end of the stream")
                .ok();
        }
        drop(tx);
    }

    #[tokio::test]
    async fn stop_aborts_a_connection_that_never_finishes_after_the_limit() {
        use axum::routing::get;
        // A handler the shutdown signal does not reach: the safety net must
        // cut the wait short instead of hanging.
        let router = Router::new().route(
            "/hang",
            get(|| async {
                std::future::pending::<()>().await;
                "never"
            }),
        );
        let server = start(
            ServerConfig {
                bind: "127.0.0.1".to_string(),
                port: 0,
            },
            router,
        )
        .await
        .unwrap();
        let addr = server.local_addr();
        let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
        {
            use tokio::io::AsyncWriteExt;
            conn.write_all(b"GET /hang HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .await
                .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;

        tokio::time::timeout(
            Duration::from_secs(3),
            server.stop_within(Duration::from_millis(300)),
        )
        .await
        .expect("the safety net bounds stop()");
    }

    #[tokio::test]
    async fn stop_on_an_idle_server_is_immediate() {
        let server = start(
            ServerConfig {
                bind: "127.0.0.1".to_string(),
                port: 0,
            },
            Router::new(),
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(3), server.stop())
            .await
            .expect("idle stop is immediate");
    }
}
