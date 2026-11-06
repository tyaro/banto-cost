/**
 * Review of #242: the whole background path wired together - the real SSE
 * provider, `connectEvents`, and the real HTTP `AuthProvider` over one fake
 * server - must reach `onSessionEnded` on its own (no manual calls), also when
 * the confirmation fails first, answers late, or another tab cleared the
 * shared "Remember me" token first.
 *
 * Issue #260 実装-3: `connectEvents` signals the default SessionController
 * (`signal('unauthorized')` / `signal('credentialCleared')`); the
 * confirmation and its backoff (1 s doubling to 30 s, a 10 s probe deadline)
 * are the controller's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, createSseEventProvider } from '../src/events';
import { createHttpAuthProvider } from '../src/providers/http';
import { initBanto } from '../src/registry.svelte';
import { onSessionEnded } from '../src/sessionEnded';
import type { DataProvider } from '../src/provider';
import {
	DEFAULT_SESSION_RETRY,
	DEFAULT_SESSION_TIMEOUT_MS,
	resetDefaultSessionController
} from '../src/sessionController.svelte';

const CONFIRM_RETRY_INITIAL_MS = DEFAULT_SESSION_RETRY.initialMs;
const CONFIRM_RETRY_MAX_MS = DEFAULT_SESSION_RETRY.maxMs;
const CONFIRM_TIMEOUT_MS = DEFAULT_SESSION_TIMEOUT_MS;

const TOKEN_KEY = 'banto.auth.token';

function makeMemoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		removeItem: (key) => void map.delete(key),
		clear: () => map.clear(),
		key: () => null,
		get length() {
			return map.size;
		}
	} as Storage;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** An SSE response whose stream ends right away (the server closed it). */
function endedStream(): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			}
		})
	);
}

type Handler = (init: RequestInit | undefined) => Promise<Response>;

/**
 * Issue #260 実装-2: the confirmation asks the SessionController, whose HTTP
 * provider calls `GET /api/auth/identity` (one round trip) instead of
 * `/api/auth/check`. The `check` handlers below keep answering `true`/
 * `false`; this maps them to the identity route's `200 identity` /
 * `200 null` (errors pass through unchanged).
 */
async function asIdentityAnswer(response: Response): Promise<Response> {
	if (!response.ok) return response;
	const valid = (await response.json()) as boolean;
	return jsonResponse(200, valid ? { id: 'user', name: 'User' } : null);
}

/** One fake server: `/api/events` and the session check answered by the given handlers. */
function fakeServer(routes: { events: Handler; check: Handler }) {
	const calls = { events: 0, check: 0 };
	const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const path = String(input);
		if (path.endsWith('/api/events')) {
			calls.events += 1;
			return routes.events(init);
		}
		if (path.endsWith('/api/auth/identity')) {
			calls.check += 1;
			return routes.check(init).then(asIdentityAnswer);
		}
		return Promise.reject(new Error(`unexpected ${path}`));
	}) as unknown as typeof fetch;
	return { fetchFn, calls };
}

/** Wire one "tab": the HTTP auth provider, the SSE provider and `connectEvents`. */
function wireTab(fetchFn: typeof fetch) {
	const auth = createHttpAuthProvider({ fetchFn });
	initBanto({ dataProvider: {} as DataProvider, authProvider: auth, resources: [] });
	const ended = vi.fn();
	const off = onSessionEnded(ended);
	const disconnect = connectEvents(
		createSseEventProvider({
			getToken: auth.getToken,
			fetchFn,
			reconnectDelayMs: 100,
			tokenWaitDelayMs: 50
		})
	);
	return {
		auth,
		ended,
		dispose() {
			disconnect();
			off();
		}
	};
}

beforeEach(() => {
	resetDefaultSessionController();
	vi.useFakeTimers();
	vi.stubGlobal('sessionStorage', makeMemoryStorage());
	vi.stubGlobal('localStorage', makeMemoryStorage());
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('background session end, end to end (review of #242)', () => {
	for (const [label, failFirst] of [
		['a 500', () => Promise.resolve(jsonResponse(500, { kind: 'storage', message: 'locked' }))],
		['an unreachable server', () => Promise.reject(new TypeError('Failed to fetch'))]
	] as const) {
		it(`① the confirmation fails first with ${label}, then the server recovers`, async () => {
			localStorage.setItem(TOKEN_KEY, 'revoked');
			let checks = 0;
			const server = fakeServer({
				events: async () => new Response(null, { status: 401 }),
				check: () => (++checks <= 2 ? failFirst() : Promise.resolve(jsonResponse(200, false)))
			});
			const tab = wireTab(server.fetchFn);

			// Two failed confirmations, then the backoff (1 s, 2 s) reaches the
			// recovered server.
			await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_INITIAL_MS * 3 + 500);
			expect(tab.ended).toHaveBeenCalledTimes(1);
			expect(server.calls.check).toBe(3);
			expect(tab.auth.getToken()).toBeNull();
			// The rejected token is never sent to /api/events again.
			expect(server.calls.events).toBe(1);

			// Settled: nothing more happens.
			await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_MAX_MS * 2);
			expect(tab.ended).toHaveBeenCalledTimes(1);
			expect(server.calls.check).toBe(3);
			expect(server.calls.events).toBe(1);
			tab.dispose();
		});
	}

	it('backs off while the server cannot verify (does not ask too often)', async () => {
		localStorage.setItem(TOKEN_KEY, 'revoked');
		const server = fakeServer({
			events: async () => new Response(null, { status: 401 }),
			check: async () => jsonResponse(500, { kind: 'storage', message: 'locked' })
		});
		const tab = wireTab(server.fetchFn);

		// 1 + retries at 1, 3, 7, 15, 31, 61, 91, 121 s (doubling, capped at 30 s).
		await vi.advanceTimersByTimeAsync(121_000 + 500);
		expect(server.calls.check).toBe(9);
		expect(tab.ended).not.toHaveBeenCalled();
		expect(tab.auth.getToken()).toBe('revoked');
		tab.dispose();
	});

	it('② the confirmation answers false only after the timeout', async () => {
		localStorage.setItem(TOKEN_KEY, 'revoked');
		const server = fakeServer({
			events: async () => new Response(null, { status: 401 }),
			// Every check answers false, but only after 12 s.
			check: () =>
				new Promise((resolve) =>
					setTimeout(() => resolve(jsonResponse(200, false)), CONFIRM_TIMEOUT_MS + 2_000)
				)
		});
		const tab = wireTab(server.fetchFn);

		await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 2_000 + 500);
		// The late false cleared the token (the provider's side effect)...
		expect(tab.auth.getToken()).toBeNull();
		// ...and the next retry, finding no token, notifies without a request.
		await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_MAX_MS);
		expect(tab.ended).toHaveBeenCalledTimes(1);
		const checksAtEnd = server.calls.check;
		await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_MAX_MS * 2);
		expect(tab.ended).toHaveBeenCalledTimes(1);
		expect(server.calls.check).toBe(checksAtEnd);
		tab.dispose();
	});

	it('re-login, then a new 401 while a check is in flight, then a late true: checks again (re-review of #242)', async () => {
		// The owner's sequence: token A is rejected and its check fails (500),
		// the user logs in again as B, the retry checks B (valid at the time,
		// but the 200 true is slow), B is revoked and its stream gets a 401
		// while that check is in flight, then the stale true arrives.
		localStorage.setItem(TOKEN_KEY, 'A');
		let bRevoked = false;
		let checks = 0;
		const server = fakeServer({
			events: async (init) => {
				const auth = (init?.headers as Record<string, string>).Authorization;
				if (auth === 'Bearer A' || bRevoked) return new Response(null, { status: 401 });
				return endedStream();
			},
			check: () => {
				checks += 1;
				if (checks === 1)
					return Promise.resolve(jsonResponse(500, { kind: 'storage', message: 'x' }));
				if (checks === 2) {
					// Judged valid now, delivered at 6 s.
					return new Promise((resolve) =>
						setTimeout(() => resolve(jsonResponse(200, true)), 5_000)
					);
				}
				return Promise.resolve(jsonResponse(200, !bRevoked));
			}
		});
		const tab = wireTab(server.fetchFn);

		await vi.advanceTimersByTimeAsync(100);
		localStorage.setItem(TOKEN_KEY, 'B'); // re-login
		await vi.advanceTimersByTimeAsync(1_000); // the retry checks B (slow true)
		expect(checks).toBe(2);
		bRevoked = true; // B revoked; B's next reconnect gets a 401
		await vi.advanceTimersByTimeAsync(5_000); // the stale true arrives

		await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_MAX_MS);
		expect(tab.ended).toHaveBeenCalledTimes(1);
		expect(tab.auth.getToken()).toBeNull();
		expect(checks).toBe(3);
		// B is never sent to /api/events again after its 401.
		const eventsAtEnd = server.calls.events;
		await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_MAX_MS * 2);
		expect(server.calls.events).toBe(eventsAtEnd);
		expect(tab.ended).toHaveBeenCalledTimes(1);
		tab.dispose();
	});

	// v2.0.0 (design §6.1): the background confirmation belongs to the
	// controller, not to the event subscription - ending the subscription does
	// not leave "the session may have ended" unanswered. It goes on (with
	// backoff) until the session is known, then stops.
	it('the confirmation outlives the event subscription and stops once the session is known', async () => {
		localStorage.setItem(TOKEN_KEY, 'revoked');
		let failing = true;
		const server = fakeServer({
			events: async () => new Response(null, { status: 401 }),
			check: async () =>
				failing
					? jsonResponse(500, { kind: 'storage', message: 'locked' })
					: jsonResponse(200, false)
		});
		const tab = wireTab(server.fetchFn);
		await vi.advanceTimersByTimeAsync(100);
		expect(server.calls.check).toBe(1);

		tab.dispose();
		await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_INITIAL_MS * 3 + 500);
		expect(server.calls.check).toBe(3); // retried at 1 s and 3 s
		failing = false;
		await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_INITIAL_MS * 4 + 500);
		expect(server.calls.check).toBe(4); // at 7 s: `none`, the token cleared
		expect(tab.auth.getToken()).toBeNull();
		await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_MAX_MS * 4);
		expect(server.calls.check).toBe(4);
	});
});

describe('a "Remember me" token cleared by another tab (review of #242)', () => {
	// This tab's stream ends (the server's revalidation closed it) after the
	// other tab, sharing localStorage, already confirmed and cleared the token.
	const cases: {
		label: string;
		before: string | null;
		after: string | null;
		notified: boolean;
		eventsWith: (string | null)[];
	}[] = [
		{
			label: 'the token this tab used disappeared',
			before: 'shared',
			after: null,
			notified: true,
			eventsWith: ['shared']
		},
		{
			label: 'there never was a token (waiting for the first login)',
			before: null,
			after: null,
			notified: false,
			eventsWith: []
		},
		{
			label: 'a new login replaced the token',
			before: 'shared',
			after: 'fresh',
			notified: false,
			eventsWith: ['shared', 'fresh']
		}
	];

	for (const { label, before, after, notified, eventsWith } of cases) {
		it(`${label}: ${notified ? 'confirms and notifies' : 'does not notify'}`, async () => {
			if (before) localStorage.setItem(TOKEN_KEY, before);
			const sent: (string | null)[] = [];
			const server = fakeServer({
				events: async (init) => {
					const auth = (init?.headers as Record<string, string>).Authorization;
					sent.push(auth ? auth.replace('Bearer ', '') : null);
					return endedStream();
				},
				check: async () => jsonResponse(200, true)
			});
			const tab = wireTab(server.fetchFn);
			await vi.advanceTimersByTimeAsync(20);

			// The other tab's change to the shared storage.
			if (after) localStorage.setItem(TOKEN_KEY, after);
			else localStorage.removeItem(TOKEN_KEY);
			await vi.advanceTimersByTimeAsync(150);

			expect(tab.ended).toHaveBeenCalledTimes(notified ? 1 : 0);
			expect(new Set(sent)).toEqual(new Set(eventsWith));
			// With no token, the confirmation needs no request.
			expect(server.calls.check).toBe(0);
			tab.dispose();
		});
	}
});
