/**
 * Another tab switches the shared "Remember me" session (#257, design §4.6,
 * I-5/I-17): two "tabs", each with the real HTTP provider and its own
 * SessionController, sharing one `localStorage` and one fake server. A tab
 * hears the other's writes only through a `storage` event, delivered by the
 * test (`deliver`) - so the order of "the other tab wrote" and "this tab
 * heard it" is the test's to decide, as in a browser, where the event
 * arrives after the write is already visible.
 *
 * Scenario numbers are design §4 (S-35〜S-39, S-59, S-60). The layout side
 * of S-35/S-37/S-81/S-83 (the notice, `'relogin'`) is in admin-template's
 * `ownerChange.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '../src/provider';
import { createHttpAuthProvider } from '../src/providers/http';
import {
	createSessionController,
	resolveSettled,
	type SessionController
} from '../src/sessionController.svelte';
import { deferred, flush, makeScheduler } from './sessionHarness';

const KEY = 'banto.auth.token';

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

const USERS: Record<string, Identity> = {
	alice: { id: 'alice', name: 'Alice' },
	bob: { id: 'bob', name: 'Bob' }
};

/**
 * One server for both tabs: `POST /api/auth/login` issues `tok-<user>-<n>`,
 * `/api/auth/logout` revokes the token it carries, `GET /api/auth/identity`
 * answers the token's identity (`200 null` when unknown/revoked). `gates`
 * holds a route's response until the test releases it; `identityFails`
 * answers 500.
 */
function fakeServer() {
	const tokens = new Map<string, Identity>();
	let issued = 0;
	const state = {
		identityFails: false,
		gates: new Map<string, Promise<void>>()
	};
	const fetchFn = vi.fn(
		async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
			const path = url.replace(/^.*?(\/api\/)/, '/api/');
			const gate = state.gates.get(path);
			if (gate) {
				state.gates.delete(path);
				await gate;
			}
			const token = init?.headers?.Authorization?.replace('Bearer ', '') ?? null;
			switch (path) {
				case '/api/auth/login': {
					const { username } = JSON.parse(init?.body ?? '{}') as { username: string };
					const identity = USERS[username];
					if (!identity) return json(200, { success: false, error: 'bad credentials' });
					issued += 1;
					const issuedToken = `tok-${username}-${issued}`;
					tokens.set(issuedToken, identity);
					return json(200, { success: true, token: issuedToken });
				}
				case '/api/auth/logout':
					if (token) tokens.delete(token);
					return json(200, null);
				case '/api/auth/identity':
					if (state.identityFails) {
						return json(500, { kind: 'storage', message: 'database is locked' });
					}
					return json(200, (token && tokens.get(token)) || null);
				default:
					return json(404, { kind: 'other', message: path });
			}
		}
	);
	/** Hold `path`'s next response until the returned function is called. */
	function hold(path: string): () => void {
		const gate = deferred<void>();
		state.gates.set(path, gate.promise);
		return () => gate.resolve();
	}
	return { state, hold, fetchFn: fetchFn as unknown as typeof fetch };
}

interface Tab {
	target: EventTarget;
	auth: ReturnType<typeof createHttpAuthProvider>;
	controller: SessionController;
	scheduler: ReturnType<typeof makeScheduler>;
}

/** A tab: its own `window` (for `storage` events) and controller; the shared localStorage. */
function openTab(server: ReturnType<typeof fakeServer>): Tab {
	const target = new EventTarget();
	vi.stubGlobal('window', target);
	const auth = createHttpAuthProvider({ fetchFn: server.fetchFn });
	const scheduler = makeScheduler();
	const controller = createSessionController(auth, {
		scheduler,
		onNone: () => {},
		onActive: () => {}
	});
	return { target, auth, controller, scheduler };
}

/** The browser delivers the other tab's write to `tab` (a `storage` event for the token key). */
function deliver(tab: Tab): void {
	tab.target.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }));
}

async function loginRemembered(tab: Tab, username: string) {
	return tab.auth.login({ username, password: 'pw', remember: true });
}

beforeEach(() => {
	vi.stubGlobal('localStorage', makeMemoryStorage());
	// Each tab has its own sessionStorage in a browser; the Remember me
	// logins here only use localStorage, so one stand-in is enough.
	vi.stubGlobal('sessionStorage', makeMemoryStorage());
});
afterEach(() => {
	vi.unstubAllGlobals();
});

/** Tab 1 signed in as Alice (Remember me) and confirmed. */
async function aliceInTab1(server: ReturnType<typeof fakeServer>) {
	const tab1 = openTab(server);
	const tab2 = openTab(server);
	await loginRemembered(tab1, 'alice');
	await expect(resolveSettled(tab1.controller)).resolves.toMatchObject({
		snapshot: { owner: 'account:alice' }
	});
	deliver(tab2); // tab 2 hears tab 1's login
	return { tab1, tab2 };
}

describe('another tab switches the Remember me session (#257, I-5, I-17)', () => {
	it('S-35: tab 2 logs in as B: tab 1 holds (A is not used), confirms B, records { A -> B }, and clears nothing', async () => {
		const server = fakeServer();
		const { tab1, tab2 } = await aliceInTab1(server);
		const generation = tab1.controller.snapshot.generation;

		await loginRemembered(tab2, 'bob');
		const bobToken = localStorage.getItem(KEY);
		expect(bobToken).toMatch(/^tok-bob-/);
		deliver(tab1);
		expect(tab1.controller.snapshot).toMatchObject({
			status: 'unknown',
			owner: null,
			generation: generation + 1
		});

		const result = await resolveSettled(tab1.controller);
		expect(result).toMatchObject({ outcome: 'confirmed', snapshot: { owner: 'account:bob' } });
		expect(tab1.controller.snapshot.generation).toBe(generation + 2);
		expect(tab1.controller.snapshot.pendingOwnerChange).toEqual({
			from: 'account:alice',
			to: 'account:bob'
		});
		expect(localStorage.getItem(KEY)).toBe(bobToken); // tab 2 stays logged in
	});

	it('S-36/S-60: the confirmation after the switch fails (500): unverified, the hold stays (A is never active again), B’s token kept', async () => {
		const server = fakeServer();
		const { tab1, tab2 } = await aliceInTab1(server);
		await loginRemembered(tab2, 'bob');
		const bobToken = localStorage.getItem(KEY);

		server.state.identityFails = true;
		deliver(tab1);
		const result = await resolveSettled(tab1.controller);
		expect(result.outcome).toBe('unverified'); // the load's 503
		expect(tab1.controller.snapshot).toMatchObject({ status: 'unknown', owner: null });
		expect(tab1.controller.snapshot.verification.state).toBe('failed');
		expect(localStorage.getItem(KEY)).toBe(bobToken);

		// The background confirmation keeps going (backoff) and confirms B once
		// the server answers; the change stays recorded for the layout (S-81).
		server.state.identityFails = false;
		await tab1.scheduler.advance(1_000);
		await flush();
		expect(tab1.controller.snapshot).toMatchObject({ status: 'active', owner: 'account:bob' });
		expect(tab1.controller.snapshot.pendingOwnerChange).toEqual({
			from: 'account:alice',
			to: 'account:bob'
		});
	});

	it('S-59: tab 2 logs in again as the SAME user: hold + re-confirmation (+2), no owner change recorded', async () => {
		const server = fakeServer();
		const { tab1, tab2 } = await aliceInTab1(server);
		const generation = tab1.controller.snapshot.generation;

		await loginRemembered(tab2, 'alice');
		deliver(tab1);
		await resolveSettled(tab1.controller);

		expect(tab1.controller.snapshot).toMatchObject({
			status: 'active',
			owner: 'account:alice',
			generation: generation + 2,
			pendingOwnerChange: null
		});
	});

	it('S-38: both tabs log in at the same time as different users: each follows the stored token, not its own login’s answer', async () => {
		const server = fakeServer();
		const tab1 = openTab(server);
		const tab2 = openTab(server);

		const release = server.hold('/api/auth/login');
		const tab1Login = loginRemembered(tab1, 'alice'); // held by the server
		await flush();
		await loginRemembered(tab2, 'bob'); // finishes first
		deliver(tab1);
		release();
		// Tab 1's answer is not stored over tab 2's token (#259 compare-and-set).
		await expect(tab1Login).resolves.toMatchObject({ success: false, superseded: true });

		const [one, two] = await Promise.all([
			resolveSettled(tab1.controller),
			resolveSettled(tab2.controller)
		]);
		expect(one.snapshot.owner).toBe('account:bob');
		expect(two.snapshot.owner).toBe('account:bob');
	});

	it('S-39: tab 1 logs out while tab 2 logs in as B (B’s write first): tab 1 does not delete B’s token and ends as B, not A', async () => {
		const server = fakeServer();
		const { tab1, tab2 } = await aliceInTab1(server);

		const release = server.hold('/api/auth/logout');
		const logout = tab1.auth.logout(); // held by the server
		await flush();
		await loginRemembered(tab2, 'bob'); // visible in localStorage; tab 1's event not delivered yet
		release();
		await logout;
		expect(localStorage.getItem(KEY)).toMatch(/^tok-bob-/);

		deliver(tab1);
		await expect(resolveSettled(tab1.controller, { cause: 'signal' })).resolves.toMatchObject({
			snapshot: { status: 'active', owner: 'account:bob' }
		});
	});

	it('S-39: tab 2’s login is heard first, then tab 1 logs out (clearing it): both tabs end with no session - none stays A', async () => {
		const server = fakeServer();
		const { tab1, tab2 } = await aliceInTab1(server);

		await loginRemembered(tab2, 'bob');
		deliver(tab1);
		await resolveSettled(tab1.controller); // tab 1 is B now
		await tab1.auth.logout(); // clears the shared token (B's)
		deliver(tab2);

		const [one, two] = await Promise.all([
			resolveSettled(tab1.controller, { cause: 'signal' }),
			resolveSettled(tab2.controller)
		]);
		expect(one.snapshot.status).toBe('none');
		expect(two.snapshot.status).toBe('none');
		expect(localStorage.getItem(KEY)).toBeNull();
	});
});
