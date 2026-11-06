/**
 * `EventProvider` (spec §3.5): server -> client change notifications.
 * Exactly two event kinds ship in v1 - mirrors
 * `crates/banto-server/src/events.rs::ServerEvent` field-for-field (`kind`
 * tag, snake_case variant names) so the wire shape needs no translation.
 *
 * Two implementations, picked by environment the same way `DataProvider` is
 * (`setup.ts`'s three-way detection):
 * - `createTauriEventProvider`: Webview only, no network - relays Tauri's
 *   `banto://event` events (emitted by `src-tauri`'s broadcast-forwarding
 *   task).
 * - `createSseEventProvider`: LAN browser - reads `GET /api/events` itself
 *   (see sse-parser.ts for why not `EventSource`).
 *
 * `connectEvents` is the one bridge either implementation is wired through
 * into the rest of admin-core: resource-changed -> `invalidate`, notice ->
 * `notify`.
 */
import { invalidate, invalidateAll } from './invalidate';
import { notify } from './registry.svelte';
import type { NotificationKind } from './provider';
import { createSseParser } from './sse-parser';
import { getSessionController } from './sessionController.svelte';

export type AppEvent =
	| { kind: 'resource_changed'; resource: string }
	| { kind: 'notice'; level: string; message: string };

/**
 * Optional callbacks for things that happen to the subscription itself
 * rather than events it carries (Issue #241).
 */
export interface EventSubscriptionHooks {
	/**
	 * The server rejected the stream's session (`/api/events` answered
	 * `401`): the session is no longer valid. Called once per rejected token;
	 * the provider stops reconnecting with that token and resumes only when a
	 * different token appears (a new login). `connectEvents` wires this to
	 * `getSessionController().signal('unauthorized')`.
	 */
	onUnauthorized?: () => void;
	/**
	 * The token this stream was using disappeared from storage without this
	 * stream being rejected - typically another tab sharing the "Remember me"
	 * token (localStorage) confirmed the revocation and cleared it first
	 * (review of #242). Called once per disappearance, and only for a token
	 * this stream had actually used: the first wait before any login and a
	 * new login replacing the token are not disappearances. `connectEvents`
	 * wires this to `getSessionController().signal('credentialCleared')`.
	 */
	onTokenCleared?: () => void;
	/**
	 * The stream was re-established after an earlier connection of the same
	 * session had been lost (Issue #289). Broadcast events are not replayed,
	 * so changes made while disconnected were never delivered: the consumer
	 * must re-read what it shows. Called once per successful reconnect, never
	 * for the first connection, nor for the first connection after a `401` /
	 * cleared token / new login (a new session loads its data itself).
	 * `connectEvents` wires this to `invalidateAll()`.
	 */
	onReconnected?: () => void;
}

/** Backend-agnostic subscription to `AppEvent`s. Returns an unsubscribe function. */
export interface EventProvider {
	subscribe(handler: (event: AppEvent) => void, hooks?: EventSubscriptionHooks): () => void;
}

function isAppEvent(value: unknown): value is AppEvent {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return kind === 'resource_changed' || kind === 'notice';
}

export interface TauriEventListenOptions {
	/**
	 * Injected so this module has no `@tauri-apps/api` dependency of its own
	 * (same pattern as `providers/tauri.ts`'s injected `invoke`). Pass
	 * `@tauri-apps/api/event`'s `listen`.
	 */
	listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
}

const TAURI_EVENT_NAME = 'banto://event';

/**
 * `EventProvider` for the Tauri webview: listens on the `banto://event`
 * Tauri event, which `src-tauri`'s setup forwards from its
 * `broadcast::Sender<ServerEvent>` (the same channel the REST/SSE side
 * uses) via `app_handle.emit(...)`.
 */
export function createTauriEventProvider(options: TauriEventListenOptions): EventProvider {
	return {
		subscribe(handler: (event: AppEvent) => void): () => void {
			let disposed = false;
			let unlisten: (() => void) | null = null;

			options
				.listen(TAURI_EVENT_NAME, (e) => {
					if (isAppEvent(e.payload)) handler(e.payload);
				})
				.then((fn) => {
					// subscribe()'s caller may have already unsubscribed before the
					// async `listen()` call resolved - tear down immediately rather
					// than leaking a live Tauri listener.
					if (disposed) fn();
					else unlisten = fn;
				});

			return () => {
				disposed = true;
				unlisten?.();
			};
		}
	};
}

export interface SseEventProviderOptions {
	baseUrl?: string;
	getToken: () => string | null;
	fetchFn?: typeof fetch;
	/** Delay before reconnecting after a stream ends/fails. Default 3000. */
	reconnectDelayMs?: number;
	/**
	 * Poll interval while `getToken()` is still null (user not logged in
	 * yet). Kept much shorter than `reconnectDelayMs` so the stream opens
	 * almost immediately after login - broadcast events are not replayed,
	 * so every second of gap between login and the stream opening is a
	 * window where another client's change would be silently missed until
	 * the next event. Default 500.
	 */
	tokenWaitDelayMs?: number;
}

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_TOKEN_WAIT_DELAY_MS = 500;
const SSE_HEADERS = { 'X-Banto-Client': 'banto' } as const;

/**
 * `EventProvider` for a LAN browser client: connects to `GET /api/events`
 * (spec §11.3) via `fetch` + a `ReadableStream` reader (not `EventSource`,
 * see sse-parser.ts's doc comment for why), auto-reconnecting on
 * disconnect/error. While `getToken()` returns `null` (not logged in yet),
 * connecting is skipped and retried after `tokenWaitDelayMs` instead of
 * failing loudly - the same token is shared with `HttpDataProvider`/
 * `HttpAuthProvider`.
 *
 * Reconnect policy (Issue #241). Because this reads the stream with `fetch`,
 * the HTTP status of every (re)connect is visible:
 * - `401`: the server's `require_auth` CONFIRMED the session invalid (a
 *   revoked, expired or logged-out token - a failed account lookup is a
 *   `500`, never a `401`, ADR-0014). Retrying with the same token can never
 *   succeed, so the provider stops using it: no more requests until
 *   `getToken()` returns a different token (a new login; the check is a
 *   local read, same as the not-logged-in wait). `hooks.onUnauthorized` is
 *   called once so the app can run its route guard.
 * - the token it had been using is gone from storage at the next
 *   (re)connect, without a `401` here: another tab sharing the "Remember
 *   me" token already confirmed the revocation and cleared it.
 *   `hooks.onTokenCleared` is called once so this tab confirms too (review
 *   of #242). Never for the wait before the first login.
 * - any other failure (`500`, `503`, a network error, the stream ending -
 *   e.g. the server's periodic revalidation closing it): the session could
 *   not be verified or the stream simply ended, so reconnect after
 *   `reconnectDelayMs` as before. A revoked session's stream ends on the
 *   server's next revalidation, and the reconnect then gets the `401`.
 */
export function createSseEventProvider(options: SseEventProviderOptions): EventProvider {
	const baseUrl = options.baseUrl ?? '';
	const fetchFn = options.fetchFn ?? fetch;
	const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
	const tokenWaitDelayMs = options.tokenWaitDelayMs ?? DEFAULT_TOKEN_WAIT_DELAY_MS;

	return {
		subscribe(handler: (event: AppEvent) => void, hooks?: EventSubscriptionHooks): () => void {
			let stopped = false;
			let controller: AbortController | null = null;
			let timer: ReturnType<typeof setTimeout> | null = null;
			// The last token the server answered `401` for (see the doc comment
			// above): never sent again.
			let rejectedToken: string | null = null;
			// The token this stream last connected with, while it is still the
			// one to watch for disappearing (`onTokenCleared`). Reset on a `401`,
			// whose own path (`onUnauthorized`) already covers that token.
			let usedToken: string | null = null;
			// A stream of the current session has been established before, so the
			// next successful connect is a reconnect (Issue #289). Reset whenever
			// the session ends or changes (401, cleared token, different token).
			let hasConnected = false;

			function dispatch(payload: string): void {
				try {
					const parsed: unknown = JSON.parse(payload);
					if (isAppEvent(parsed)) handler(parsed);
				} catch {
					// Malformed payload (should not happen against banto-server):
					// ignore rather than tear down the whole connection over it.
				}
			}

			function scheduleReconnect(delayMs: number = reconnectDelayMs): void {
				if (stopped) return;
				timer = setTimeout(() => void connectOnce(), delayMs);
			}

			async function connectOnce(): Promise<void> {
				const token = options.getToken();
				if (token === null && usedToken !== null) {
					usedToken = null;
					hasConnected = false;
					if (!stopped) hooks?.onTokenCleared?.();
				}
				if (token === null || token === rejectedToken) {
					scheduleReconnect(tokenWaitDelayMs);
					return;
				}
				if (usedToken !== null && usedToken !== token) hasConnected = false; // a new login
				usedToken = token;

				controller = new AbortController();
				try {
					const response = await fetchFn(`${baseUrl}/api/events`, {
						headers: { ...SSE_HEADERS, Authorization: `Bearer ${token}` },
						signal: controller.signal
					});
					if (response.status === 401) {
						void response.body?.cancel().catch(() => {});
						rejectedToken = token;
						usedToken = null;
						hasConnected = false;
						if (!stopped) hooks?.onUnauthorized?.();
						scheduleReconnect(tokenWaitDelayMs);
						return;
					}
					if (!response.ok || !response.body) {
						scheduleReconnect();
						return;
					}

					// Reconnected: re-sync once, only while this token is still the live
					// one (a logout/user switch during the fetch must not refresh the old
					// session's view). Failed attempts never reach here, so repeated
					// failures cause no requests; one successful connect = one re-sync.
					const wasReconnect = hasConnected;
					hasConnected = true;
					if (wasReconnect && !stopped && options.getToken() === token) {
						hooks?.onReconnected?.();
					}

					const parser = createSseParser();
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					while (!stopped) {
						const { done, value } = await reader.read();
						if (done) break;
						for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
							dispatch(payload);
						}
					}
				} catch {
					// Network failure or abort() from unsubscribe - either way, fall
					// through to the reconnect scheduling below (a no-op if stopped).
				}
				scheduleReconnect();
			}

			void connectOnce();

			return () => {
				stopped = true;
				if (timer !== null) clearTimeout(timer);
				controller?.abort();
			};
		}
	};
}

// Keep in sync with the `NotificationKind` union in provider.ts: a `notice`
// event's `level` maps to the kind when it is one of these, else `'info'`.
const NOTIFICATION_KINDS = new Set<NotificationKind>(['success', 'error', 'info', 'warning']);

function toNotificationKind(level: string): NotificationKind {
	return NOTIFICATION_KINDS.has(level as NotificationKind) ? (level as NotificationKind) : 'info';
}

/**
 * Bridge an `EventProvider` into the rest of admin-core (spec §3.5):
 * `resource_changed` -> `invalidate(resource)` (so `ListResource`/
 * `WindowedListResource` subscribers refetch); `notice` -> `notify(...)`
 * (falls back to `'info'` for an unrecognized `level`). A stream the server
 * rejected (`onUnauthorized`, Issue #241) or whose token another tab cleared
 * (`onTokenCleared`) is a signal to the default `SessionController`
 * (Issue #260 実装-3, design §6.1): `signal('unauthorized')` /
 * `signal('credentialCleared')`. The controller confirms the session with a
 * probe started after the signal (`AuthProvider.resolve()`, which clears a
 * revoked token) and, while the server cannot verify, retries with backoff
 * until it knows; a confirmed `none` moves the generation, which the app's
 * protected layout turns into a re-run of its route guard (wiring ①). The
 * stream itself stays stopped for a rejected token. Returns an unsubscribe
 * function (the controller's background confirmation is not tied to it).
 */
export function connectEvents(provider: EventProvider): () => void {
	const unsubscribe = provider.subscribe(
		(event) => {
			if (event.kind === 'resource_changed') {
				invalidate(event.resource);
			} else {
				notify(toNotificationKind(event.level), event.message);
			}
		},
		{
			onUnauthorized: () => getSessionController().signal('unauthorized'),
			onTokenCleared: () => getSessionController().signal('credentialCleared'),
			// Issue #289: a reconnect cannot recover what was broadcast while
			// the stream was down, so re-read every subscribed resource once
			// (same path as `resource_changed`). Not for an ended session.
			onReconnected: () => {
				if (getSessionController().snapshot.status !== 'none') invalidateAll();
			}
		}
	);
	return unsubscribe;
}
