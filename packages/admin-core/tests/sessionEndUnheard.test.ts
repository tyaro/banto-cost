/**
 * S-34 (design §4.5; Issue #260 実装-2 - replaces the third review of #242's
 * "unheard ending" re-probe): an ending confirmed before the protected
 * layout subscribes must still reach that layout once it mounts - and must
 * not log out a NEW login.
 *
 * New expectation: there is no re-probe. `onSessionEnded` decides from the
 * state at subscription time - a subscription made while the controller's
 * session is `none` is notified ONCE, asynchronously (never inside the
 * subscribing call). The listener re-runs the route guard (what
 * `refreshAll()` does), and it is that guard - not the notification -
 * that decides between /login and a new login's session.
 *
 * Wires the real SSE provider, `connectEvents`, the real HTTP
 * `AuthProvider` and the route-guard decision as the app composes it on
 * v2.0.0 (`resolveSettled` + `grantFallback`, `./guard.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, createSseEventProvider } from '../src/events';
import { createHttpAuthProvider } from '../src/providers/http';
import { initBanto } from '../src/registry.svelte';
import { resetDefaultSessionController } from '../src/sessionController.svelte';
import { onSessionEnded } from '../src/sessionEnded';
import { guardRoute } from './guard';
import type { DataProvider } from '../src/provider';

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

function wire(revoked: Set<string>) {
	const identitiesFor: string[] = [];
	const bearer = (init?: RequestInit) =>
		((init?.headers as Record<string, string>).Authorization ?? '').replace('Bearer ', '');
	const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = String(input);
		const token = bearer(init);
		if (path.endsWith('/api/events')) {
			if (revoked.has(token)) return new Response(null, { status: 401 });
			return new Response(new ReadableStream({ start: (c) => c.close() }));
		}
		if (path.endsWith('/api/auth/identity')) {
			identitiesFor.push(token);
			return jsonResponse(200, revoked.has(token) ? null : { id: token, name: token });
		}
		if (path.endsWith('/api/auth/status')) return jsonResponse(200, { initialized: true });
		throw new Error(`unexpected ${path}`);
	}) as unknown as typeof fetch;
	const auth = createHttpAuthProvider({ fetchFn });
	initBanto({ dataProvider: {} as DataProvider, authProvider: auth, resources: [] });
	const disconnect = connectEvents(
		createSseEventProvider({
			getToken: auth.getToken,
			fetchFn,
			reconnectDelayMs: 100,
			tokenWaitDelayMs: 50
		})
	);
	return { auth, identitiesFor, disconnect };
}

describe('S-34: an ending confirmed before the protected layout subscribes (I-14)', () => {
	it('S-34: reaches the layout once it mounts (once, asynchronously, without a re-probe)', async () => {
		localStorage.setItem(TOKEN_KEY, 'A');
		const revoked = new Set<string>();
		const { auth, identitiesFor, disconnect } = wire(revoked);

		// The first protected load confirms A.
		await expect(guardRoute(auth)).resolves.toBe('session');
		// A is revoked: the stream's reconnect gets a 401, the confirmation
		// confirms `none` and clears A - no listener exists yet.
		revoked.add('A');
		await vi.advanceTimersByTimeAsync(500);
		expect(auth.getToken()).toBeNull();
		const requests = identitiesFor.length;

		// The protected layout mounts and subscribes; its listener re-runs the
		// guard (what `refreshAll()` does).
		const outcomes: string[] = [];
		const layout = vi.fn(() => {
			void guardRoute(auth).then((outcome) => outcomes.push(outcome));
		});
		const off = onSessionEnded(layout);
		expect(layout).not.toHaveBeenCalled(); // never synchronously in the subscription
		await vi.advanceTimersByTimeAsync(10);
		expect(layout).toHaveBeenCalledTimes(1);
		expect(outcomes).toEqual(['login']);
		// The subscription itself asked nothing (no re-probe); only the guard
		// the listener re-ran did, and with no token that needs no request.
		expect(identitiesFor.length).toBe(requests);
		off();

		// Still `none`: another subscription is told once too (decided from
		// the state at subscription time, not from a remembered ending).
		const later = vi.fn();
		const offLater = onSessionEnded(later);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(later).toHaveBeenCalledTimes(1);
		offLater();
		disconnect();
	});

	it('S-34: a new login before the layout mounts is not logged out - the re-run guard confirms it', async () => {
		localStorage.setItem(TOKEN_KEY, 'A');
		const revoked = new Set<string>(['A']);
		const { auth, identitiesFor, disconnect } = wire(revoked);
		// A is rejected and confirmed ended while nothing listens.
		await vi.advanceTimersByTimeAsync(50);
		expect(auth.getToken()).toBeNull();

		// A new login (B), then the protected layout mounts.
		localStorage.setItem(TOKEN_KEY, 'B');
		const outcomes: string[] = [];
		const layout = vi.fn(() => {
			void guardRoute(auth).then((outcome) => outcomes.push(outcome));
		});
		const off = onSessionEnded(layout);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(layout).toHaveBeenCalledTimes(1);
		expect(outcomes).toEqual(['session']);
		expect(auth.getToken()).toBe('B');
		expect(identitiesFor.at(-1)).toBe('B');

		// B is active now: a later subscription is not told anything.
		off();
		const again = vi.fn();
		const offAgain = onSessionEnded(again);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(again).not.toHaveBeenCalled();
		offAgain();
		disconnect();
	});

	it('S-34: unsubscribing before the asynchronous notification cancels it', async () => {
		const { auth, disconnect } = wire(new Set());
		await expect(guardRoute(auth)).resolves.toBe('login'); // no token: `none`
		const listener = vi.fn();
		const off = onSessionEnded(listener);
		off();
		await vi.advanceTimersByTimeAsync(10);
		expect(listener).not.toHaveBeenCalled();
		disconnect();
	});
});
