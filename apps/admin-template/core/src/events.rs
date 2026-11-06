//! Resource-change event plumbing (spec §3.5 `EventProvider`, §11.3).
//!
//! `banto-server::ServerEvent` is the wire type; this module just owns the
//! app-wide broadcast channel that feeds it, so the business services
//! (`CustomersService` / `ProjectsService` / `PipelineService` /
//! `OrdersService`, via `with_events`) and the SSE route
//! (`banto_server::events::sse_route`) share one sender.

use banto_server::ServerEvent;
use tokio::sync::broadcast;

/// Small buffer: events are cheap "go refetch resource X" notifications,
/// not a durable log, and browser clients reconnecting after a gap simply
/// miss stale invalidations (their next `getList` call already reflects the
/// current state).
const CHANNEL_CAPACITY: usize = 64;

/// Create the app-wide `ServerEvent` broadcast channel. Clone the returned
/// `Sender` into every service that emits resource-change events and into
/// the SSE route (`banto_server::events::sse_route`) that fans them out to
/// connected browsers.
pub fn event_channel() -> broadcast::Sender<ServerEvent> {
    let (tx, _rx) = broadcast::channel(CHANNEL_CAPACITY);
    tx
}

/// Send `ServerEvent::ResourceChanged { resource }` after a committed write.
///
/// Services hold `Option<Sender>` (`None` = built without `with_events`,
/// e.g. unit tests) and call this once per successful mutation, after the
/// commit and before the final read-back, so a failed write never notifies.
/// The REST routes and the Tauri commands both call the same service
/// methods, so both paths emit identically. No receiver (no browser / no
/// webview subscribed yet) is not an error: the send result is ignored.
pub fn notify_changed(events: &Option<broadcast::Sender<ServerEvent>>, resource: &str) {
    if let Some(tx) = events {
        let _ = tx.send(ServerEvent::ResourceChanged {
            resource: resource.to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notify_without_receivers_or_sender_is_not_an_error() {
        notify_changed(&None, "customers");
        let tx = event_channel();
        notify_changed(&Some(tx), "customers");
    }
}
