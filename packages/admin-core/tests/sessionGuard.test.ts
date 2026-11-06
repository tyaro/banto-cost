import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isProviderError } from '../src/errors';
import { loadListViewState, saveListViewState } from '../src/listViewState';
import type { AuthProvider, CredentialRevision } from '../src/provider';
import { createHttpAuthProvider } from '../src/providers/http';
import { createTauriAuthProvider } from '../src/providers/tauri';
import { currentSessionScope, isCurrentSessionScope } from '../src/sessionScope.svelte';
import {
	bindDefaultSessionProvider,
	DEFAULT_GRANT_RETRIES,
	getSessionController,
	grantFallback,
	resetDefaultSessionController,
	resolveSettled
} from '../src/sessionController.svelte';
import { protectedGuard as guardOutcome } from './guard';

/**
 * Issue #204 review: a session the backend could not VERIFY (a `500` from
 * the session check on a DB error, or an unreachable server) must not be
 * treated as logged out - no redirect to /login, no switch to a public viewer
 * session, no token cleared or replaced - and must resume once the backend
 * answers again. Only a confirmed-invalid session falls through.
 *
 * Issue #260 実装-3 (v2.0.0): the decision is the app's composition of
 * `resolveSettled()` and `grantFallback()` (design §6.1,
 * `./guard.ts`) over the default controller bound to the real HTTP / Tauri
 * provider. "Could not verify" is `unverified` (the 503 page), never a
 * rejection. These were the `resolveProtectedSession` tests.
 */

/** Bind `auth` to the default controller (what `initBanto` does) and run the guard. */
async function guard(auth: AuthProvider) {
	bindDefaultSessionProvider(auth);
	return guardOutcome(auth);
}

async function route(auth: AuthProvider) {
	return (await guard(auth)).route;
}

const KEY = 'banto.auth.token';

/** In-memory Storage stand-in: Node has no global sessionStorage. `key()` is real (not a stub) - `clearAllListViewState` enumerates keys. */
function makeMemoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		removeItem: (key) => void map.delete(key),
		clear: () => map.clear(),
		key: (index) => Array.from(map.keys())[index] ?? null,
		get length() {
			return map.size;
		}
	} as Storage;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/**
 * A fake LAN server for the `/api/auth/*` routes the gate touches. Issue #260
 * 実装-2: the gate delegates to the SessionController, whose HTTP provider
 * asks `GET /api/auth/identity` (one round trip, design §2.1) instead of
 * `/api/auth/check` - both answer from the same token state here.
 */
function fakeServer(options: { viewerPublic: boolean }) {
	const state = {
		viewerPublic: options.viewerPublic,
		checkFails: false,
		unreachable: false,
		validTokens: new Set<string>(),
		calls: [] as string[]
	};
	const fetchFn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
		const path = url.replace(/^.*?(\/api\/)/, '/api/');
		state.calls.push(path);
		if (state.unreachable) throw new TypeError('fetch failed');
		const token = init?.headers?.Authorization?.replace('Bearer ', '') ?? null;
		switch (path) {
			case '/api/auth/check':
				if (state.checkFails) {
					return json(500, { kind: 'storage', message: 'database is locked' });
				}
				return json(200, token !== null && state.validTokens.has(token));
			case '/api/auth/identity':
				if (state.checkFails) {
					return json(500, { kind: 'storage', message: 'database is locked' });
				}
				if (token === 'public-token' && state.viewerPublic) return json(200, PUBLIC_VIEWER);
				return json(200, token !== null && state.validTokens.has(token) ? ALICE : null);
			case '/api/auth/status':
				return json(200, { initialized: true, grants: { publicViewer: state.viewerPublic } });
			case '/api/auth/grant/publicViewer':
				return state.viewerPublic
					? json(200, { success: true, token: 'public-token' })
					: json(403, { kind: 'forbidden' });
			default:
				return json(404, { kind: 'other', message: 'unexpected route' });
		}
	});
	return { state, fetchFn: fetchFn as unknown as typeof fetch };
}

const ALICE = { id: 'alice', name: 'Alice' };
const PUBLIC_VIEWER = { id: 'public', name: 'public', role: 'viewer', kind: 'publicViewer' };

function storedTokens() {
	return { local: localStorage.getItem(KEY), session: sessionStorage.getItem(KEY) };
}

beforeEach(() => {
	vi.stubGlobal('sessionStorage', makeMemoryStorage());
	vi.stubGlobal('localStorage', makeMemoryStorage());
	resetDefaultSessionController();
});

describe('the guard over the HTTP provider (#204)', () => {
	for (const viewerPublic of [false, true]) {
		for (const remember of [false, true]) {
			const label = `viewerPublic ${viewerPublic ? 'ON' : 'OFF'}, ${remember ? 'Remember me' : 'regular'} token`;

			it(`${label}: a failed check keeps the token and resumes after recovery`, async () => {
				const { state, fetchFn } = fakeServer({ viewerPublic });
				const auth = createHttpAuthProvider({ fetchFn });
				(remember ? localStorage : sessionStorage).setItem(KEY, 'user-token');
				state.validTokens.add('user-token');
				const before = storedTokens();

				state.checkFails = true;
				const failure = await guard(auth);
				expect(failure.route).toBe('unverified');
				const error = (failure as { error: unknown }).error;
				expect(isProviderError(error)).toBe(true);
				expect((error as { body: { kind: string } }).body.kind).toBe('storage');
				expect(storedTokens(), 'no token cleared or replaced').toEqual(before);
				expect(state.calls, 'no status / public viewer entry after a failed check').toEqual([
					'/api/auth/identity'
				]);

				state.checkFails = false;
				await expect(route(auth)).resolves.toBe('session');
				expect(storedTokens()).toEqual(before);
				expect(auth.getToken()).toBe('user-token');
			});

			it(`${label}: an unreachable server is unverified too, not a logout`, async () => {
				const { state, fetchFn } = fakeServer({ viewerPublic });
				const auth = createHttpAuthProvider({ fetchFn });
				(remember ? localStorage : sessionStorage).setItem(KEY, 'user-token');
				state.validTokens.add('user-token');
				const before = storedTokens();

				state.unreachable = true;
				const failure = await guard(auth);
				expect(failure.route).toBe('unverified');
				expect(isProviderError((failure as { error: unknown }).error)).toBe(true);
				expect(storedTokens()).toEqual(before);

				state.unreachable = false;
				await expect(route(auth)).resolves.toBe('session');
			});
		}

		it(`viewerPublic ${viewerPublic ? 'ON' : 'OFF'}: a session the server confirms invalid still falls through`, async () => {
			const { fetchFn } = fakeServer({ viewerPublic });
			const auth = createHttpAuthProvider({ fetchFn });
			sessionStorage.setItem(KEY, 'revoked-token');

			const outcome = await route(auth);
			if (viewerPublic) {
				expect(outcome).toBe('publicViewer');
				expect(auth.getToken()).toBe('public-token');
			} else {
				expect(outcome).toBe('login');
			}
		});
	}

	it('a 401 from the identity route is a confirmed `none`: the token is cleared', async () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 401 }));
		const auth = createHttpAuthProvider({ fetchFn: fetchFn as unknown as typeof fetch });
		localStorage.setItem(KEY, 'expired-token');
		await expect(route(auth)).resolves.toBe('login');
		expect(storedTokens()).toEqual({ local: null, session: null });
	});
});

describe('the guard over the Tauri provider', () => {
	const resolved = (identity: { id: string; name: string } | null) => ({
		identity,
		kind: identity ? 'account' : null,
		checked: 1,
		current: 1,
		stale: false
	});

	it('a failed auth_resolve is unverified, without consulting status or logging out', async () => {
		let checkFails = true;
		const invoke = vi.fn(async (command: string) => {
			if (command === 'auth_resolve') {
				if (checkFails) throw { kind: 'storage', message: 'database is locked' };
				return resolved(ALICE);
			}
			if (command === 'auth_status') return { initialized: true };
			throw new Error(`unexpected command ${command}`);
		});
		const auth = createTauriAuthProvider({ invoke });

		const failure = await guard(auth);
		expect(failure.route).toBe('unverified');
		expect(isProviderError((failure as { error: unknown }).error)).toBe(true);
		expect(invoke.mock.calls.map(([command]) => command)).toEqual(['auth_resolve']);

		checkFails = false;
		await expect(route(auth)).resolves.toBe('session');
	});

	it('a confirmed-invalid desktop session goes to login', async () => {
		const invoke = vi.fn(async (command: string) =>
			command === 'auth_resolve' ? resolved(null) : { initialized: true }
		);
		await expect(route(createTauriAuthProvider({ invoke }))).resolves.toBe('login');
	});
});

// Issue #215/#255 (4th review): once the session is CONFIRMED not valid, the
// previous identity is gone whichever way the guard continues - the
// controller commits `none` (new generation, saved list view state dropped)
// before either the public-viewer entry or the login redirect. A still-valid
// session is left alone.
describe('the guard ends the confirmed-invalid session (#215/#255, I-6)', () => {
	async function establishedScope(auth: AuthProvider, state: { validTokens: Set<string> }) {
		sessionStorage.setItem(KEY, 'user-token');
		state.validTokens.add('user-token');
		await expect(route(auth)).resolves.toBe('session');
		const scope = currentSessionScope();
		expect(scope.owner).toBe('account:alice');
		saveListViewState(scope, 'items:server', { sort: [], filters: [] }, sessionStorage);
		return scope;
	}

	it("'login' (viewerPublic OFF): ends the session", async () => {
		const { state, fetchFn } = fakeServer({ viewerPublic: false });
		const auth = createHttpAuthProvider({ fetchFn });
		const scope = await establishedScope(auth, state);
		state.validTokens.delete('user-token'); // revoked from another session

		await expect(route(auth)).resolves.toBe('login');
		expect(isCurrentSessionScope(scope)).toBe(false);
		expect(currentSessionScope().owner).toBeNull();
		expect(sessionStorage.getItem('banto.listView.items:server')).toBeNull();
	});

	it("'publicViewer': ends the previous session before entering the synthetic one", async () => {
		const { state, fetchFn } = fakeServer({ viewerPublic: true });
		const auth = createHttpAuthProvider({ fetchFn });
		const scope = await establishedScope(auth, state);
		state.validTokens.delete('user-token');

		await expect(route(auth)).resolves.toBe('publicViewer');
		expect(isCurrentSessionScope(scope)).toBe(false);
		expect(currentSessionScope().owner).toBe('publicViewer');
		expect(sessionStorage.getItem('banto.listView.items:server')).toBeNull();
	});

	it("'session' (still valid): leaves the session and its state alone", async () => {
		const { state, fetchFn } = fakeServer({ viewerPublic: false });
		const auth = createHttpAuthProvider({ fetchFn });
		const scope = await establishedScope(auth, state);

		await expect(route(auth)).resolves.toBe('session');
		expect(isCurrentSessionScope(scope)).toBe(true);
		expect(loadListViewState(scope, 'items:server', undefined, sessionStorage)).not.toBeNull();
	});
});

// Issue #260 (design §6.1, #259): the public-viewer policy with the real
// HTTP provider. A `superseded` entry (another login stored its token while
// the public-viewer token was being minted - the provider's compare-and-set
// refused to overwrite it) is confirmed again, not sent to /login; a token
// that appeared after the ticket is confirmed (and cleared when revoked)
// and the policy re-runs, a bounded number of times.
describe('the public-viewer policy with the HTTP provider (S-20)', () => {
	it("S-20: a public-viewer entry superseded by a login is confirmed again and resolves 'session'", async () => {
		const { state, fetchFn } = fakeServer({ viewerPublic: true });
		let releasePublicViewer!: () => void;
		const publicViewerHeld = new Promise<void>((resolve) => (releasePublicViewer = resolve));
		let publicViewerStarted!: () => void;
		const publicViewerRequested = new Promise<void>((resolve) => (publicViewerStarted = resolve));
		const routed = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
			if (url.endsWith('/api/auth/login')) {
				state.validTokens.add('login-token');
				return json(200, { success: true, token: 'login-token' });
			}
			if (url.endsWith('/api/auth/grant/publicViewer')) {
				publicViewerStarted();
				await publicViewerHeld;
			}
			return fetchFn(url, init as RequestInit);
		});
		const auth = createHttpAuthProvider({ fetchFn: routed as unknown as typeof fetch });
		sessionStorage.setItem(KEY, 'revoked-token');

		const outcome = route(auth);
		await publicViewerRequested;
		await expect(auth.login({ username: 'b', password: 'pw' })).resolves.toMatchObject({
			success: true
		});
		releasePublicViewer();

		await expect(outcome).resolves.toBe('session');
		expect(auth.getToken()).toBe('login-token');
	});

	// PR #264 re-review P1: enterPublicViewer refuses (superseded, no request)
	// while ANY token is stored. A stale token that shows up between the
	// confirmation and the entry is confirmed on the next round (and cleared
	// when revoked), so the guard still gets to the public viewer.
	it("S-20: a revoked token appearing before the entry (event not delivered) is confirmed, cleared, and the guard resolves 'publicViewer'", async () => {
		const { state, fetchFn } = fakeServer({ viewerPublic: true });
		let rewrites = 0;
		const routed = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
			if (url.endsWith('/api/auth/status') && rewrites === 0) {
				rewrites += 1;
				// Another tab's (already revoked) Remember me token, event not delivered.
				localStorage.setItem(KEY, 'revoked-from-tab-2');
			}
			return fetchFn(url, init as RequestInit);
		});
		const auth = createHttpAuthProvider({ fetchFn: routed as unknown as typeof fetch });
		sessionStorage.setItem(KEY, 'revoked-token');

		await expect(route(auth)).resolves.toBe('publicViewer');
		// Two `none` confirmations (the first token, then the one that
		// appeared), then the confirmation of the minted public-viewer session.
		expect(state.calls.filter((path) => path === '/api/auth/identity')).toHaveLength(3);
		expect(state.calls.filter((path) => path === '/api/auth/grant/publicViewer')).toHaveLength(1);
		expect(storedTokens()).toEqual({ local: null, session: 'public-token' });
	});

	it('S-20: a token that keeps reappearing ends in the last confirmed `none` (/login) after maxRetries + 1 rounds', async () => {
		const { state, fetchFn } = fakeServer({ viewerPublic: true });
		const routed = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
			if (url.endsWith('/api/auth/status')) localStorage.setItem(KEY, 'revoked-again');
			return fetchFn(url, init as RequestInit);
		});
		const auth = createHttpAuthProvider({ fetchFn: routed as unknown as typeof fetch });
		sessionStorage.setItem(KEY, 'revoked-token');

		await expect(route(auth)).resolves.toBe('login');
		const rounds = DEFAULT_GRANT_RETRIES + 1;
		expect(state.calls.filter((path) => path === '/api/auth/status')).toHaveLength(rounds);
		// The guard's own confirmation, then one per round.
		expect(state.calls.filter((path) => path === '/api/auth/identity')).toHaveLength(1 + rounds);
		expect(state.calls.filter((path) => path === '/api/auth/grant/publicViewer')).toHaveLength(0);
	});

	it('S-20: maxRetries = 0 runs the policy once', async () => {
		const { state, fetchFn } = fakeServer({ viewerPublic: true });
		const routed = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
			if (url.endsWith('/api/auth/status')) localStorage.setItem(KEY, 'revoked-again');
			return fetchFn(url, init as RequestInit);
		});
		const auth = createHttpAuthProvider({ fetchFn: routed as unknown as typeof fetch });
		sessionStorage.setItem(KEY, 'revoked-token');
		bindDefaultSessionProvider(auth);
		const controller = getSessionController();
		const first = await resolveSettled(controller);
		if (first.outcome !== 'confirmed') throw new Error('expected confirmed');

		const result = await grantFallback(controller, auth, first.ticket, {
			kind: 'publicViewer',
			maxRetries: 0
		});
		expect(result).toMatchObject({ outcome: 'confirmed', snapshot: { status: 'none' } });
		expect(state.calls.filter((path) => path === '/api/auth/status')).toHaveLength(1);
		expect(state.calls.filter((path) => path === '/api/auth/identity')).toHaveLength(2);
	});

	it("a failed entry ({ success: false }) still falls back to 'login', without a retry", async () => {
		const revision = '1.0' as CredentialRevision;
		const auth: AuthProvider = {
			login: vi.fn(),
			logout: vi.fn(),
			resolve: vi.fn(async () => ({
				status: 'none' as const,
				checked: revision,
				current: revision
			})),
			credentialRevision: () => revision,
			onCredentialChanged: () => () => {},
			status: vi.fn(async () => ({ initialized: true, grants: { publicViewer: true } })),
			enterGrant: vi.fn(async () => ({ success: false }))
		};

		await expect(route(auth)).resolves.toBe('login');
		expect(auth.resolve).toHaveBeenCalledTimes(1);
		expect(auth.enterGrant).toHaveBeenCalledTimes(1);
	});
});
