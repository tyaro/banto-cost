import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isProviderError, isStaleAnswerError } from '../src/errors';
import type { CredentialRevision } from '../src/provider';
import { createHttpAuthProvider } from '../src/providers/http';

/**
 * Issue #260 実装-1 (docs/design/session-controller-design.md §5.2, §8.2): the HTTP
 * provider's `resolve()`, credential revision, compare-and-set token writes
 * (#259) and change notifications. Test names start with the scenario
 * number (S-n) of design §4.
 */

const KEY = 'banto.auth.token';

/** In-memory Storage stand-in: Node has no global sessionStorage. */
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

function json(status: number, body: unknown, statusText = ''): Response {
	return new Response(JSON.stringify(body), {
		status,
		statusText,
		headers: { 'content-type': 'application/json' }
	});
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let every queued promise continuation run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A `window` stand-in that can dispatch `storage` events (Node has none). */
let windowTarget: EventTarget;

function storageEvent(key: string | null): Event {
	return Object.assign(new Event('storage'), { key });
}

beforeEach(() => {
	vi.stubGlobal('sessionStorage', makeMemoryStorage());
	vi.stubGlobal('localStorage', makeMemoryStorage());
	windowTarget = new EventTarget();
	vi.stubGlobal('window', windowTarget);
});

/**
 * A fake server whose responses the test hands out in order: each request is
 * recorded with the bearer token it carried, and waits on its own deferred.
 */
function scriptedServer() {
	const requests: { path: string; token: string | null; reply: Deferred<Response> }[] = [];
	const fetchFn = vi.fn((url: string, init?: { headers?: Record<string, string> }) => {
		const path = url.replace(/^.*?(\/api\/)/, '/api/');
		const token = init?.headers?.Authorization?.replace('Bearer ', '') ?? null;
		const reply = deferred<Response>();
		requests.push({ path, token, reply });
		return reply.promise;
	});
	return { requests, fetchFn: fetchFn as unknown as typeof fetch, fetchMock: fetchFn };
}

function provider(fetchFn: typeof fetch) {
	const auth = createHttpAuthProvider({ fetchFn });
	const changed = vi.fn();
	auth.onCredentialChanged(changed);
	return { auth, changed };
}

describe('HTTP resolve(): one GET /api/auth/identity (§2.1, decision 3)', () => {
	it('S-9: no stored token resolves none without a request', async () => {
		const { fetchFn, fetchMock } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const answer = await auth.resolve();

		expect(answer).toEqual({ status: 'none', checked: before, current: before });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(changed).not.toHaveBeenCalled();
	});

	it('S-9: 200 with an identity resolves active for the token held on entry', async () => {
		sessionStorage.setItem(KEY, 'tok-a');
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const pending = auth.resolve();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ path: '/api/auth/identity', token: 'tok-a' });
		requests[0].reply.resolve(json(200, { id: 'a', name: 'A', role: 'admin' }));

		await expect(pending).resolves.toEqual({
			status: 'active',
			checked: before,
			current: before,
			identity: { id: 'a', name: 'A', role: 'admin' }
		});
		expect(sessionStorage.getItem(KEY)).toBe('tok-a');
		expect(changed).not.toHaveBeenCalled();
	});

	for (const [label, response] of [
		['200 null', () => json(200, null)],
		['401', () => json(401, { kind: 'unauthorized' })]
	] as const) {
		for (const storage of ['sessionStorage', 'localStorage'] as const) {
			it(`S-9: ${label} resolves none and clears the checked token from ${storage} without notifying (current !== checked)`, async () => {
				globalThis[storage].setItem(KEY, 'tok-a');
				const { requests, fetchFn } = scriptedServer();
				const { auth, changed } = provider(fetchFn);
				const before = auth.credentialRevision();

				const pending = auth.resolve();
				requests[0].reply.resolve(response());
				const answer = await pending;

				expect(answer.status).toBe('none');
				expect(answer.checked).toBe(before);
				expect(answer.current).not.toBe(answer.checked);
				expect(answer.current).toBe(auth.credentialRevision());
				expect(auth.getToken()).toBeNull();
				expect(changed).not.toHaveBeenCalled();
			});
		}
	}

	it('S-64: a session whose role was changed is answered 200 null (revoked), i.e. none - not the new role', async () => {
		sessionStorage.setItem(KEY, 'tok-a');
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);

		const pending = auth.resolve();
		// The server re-validates the token (#204, ADR-0014): the role change
		// advanced auth_epoch, so the token is no longer valid.
		requests[0].reply.resolve(json(200, null));

		await expect(pending).resolves.toMatchObject({ status: 'none' });
		expect(auth.getToken()).toBeNull();
	});

	it('S-9/S-105: a none answer for a token replaced while in flight is stale and keeps the new token', async () => {
		sessionStorage.setItem(KEY, 'tok-a');
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);
		const before = auth.credentialRevision();

		const pending = auth.resolve();
		const login = auth.login({ username: 'b', password: 'pw' });
		requests[1].reply.resolve(json(200, { success: true, token: 'tok-b' }));
		await login;
		requests[0].reply.resolve(json(200, null));

		await expect(pending).rejects.toSatisfy(isStaleAnswerError);
		expect(auth.credentialRevision()).not.toBe(before);
		expect(auth.getToken()).toBe('tok-b');
	});

	it('S-105: another tab replaced the token while the request was in flight (storage event not yet delivered): the answer about the old token is stale', async () => {
		localStorage.setItem(KEY, 'tok-a');
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const pending = auth.resolve();
		expect(requests[0].token).toBe('tok-a');
		localStorage.setItem(KEY, 'tok-b'); // the other tab's login; no event yet
		requests[0].reply.resolve(json(200, { id: 'a', name: 'A' }));

		await expect(pending).rejects.toSatisfy(isStaleAnswerError);
		expect(auth.credentialRevision()).toBe(before);
		expect(changed).not.toHaveBeenCalled();
		expect(auth.getToken()).toBe('tok-b');
	});

	it('S-106: a changePassword answered 401 clears the token it was sent with and reports it', async () => {
		sessionStorage.setItem(KEY, 'tok-a');
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const changing = auth.changePassword!('old', 'newpassword');
		expect(requests[0].token).toBe('tok-a');
		requests[0].reply.resolve(json(401, { kind: 'unauthorized', message: 'unauthorized' }));

		await expect(changing).resolves.toMatchObject({ success: false });
		expect(auth.getToken()).toBeNull();
		expect(auth.credentialRevision()).not.toBe(before);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-9: a 500, an unreachable server, or a malformed body rejects and changes nothing', async () => {
		for (const failure of [
			(d: Deferred<Response>) => d.resolve(json(500, { kind: 'storage', message: 'db locked' })),
			(d: Deferred<Response>) => d.reject(new TypeError('fetch failed')),
			(d: Deferred<Response>) => d.resolve(json(200, { unexpected: true }))
		]) {
			sessionStorage.setItem(KEY, 'tok-a');
			const { requests, fetchFn } = scriptedServer();
			const { auth, changed } = provider(fetchFn);
			const before = auth.credentialRevision();

			const pending = auth.resolve();
			failure(requests[0].reply);
			const err = await pending.catch((e: unknown) => e);

			expect(isProviderError(err)).toBe(true);
			expect(auth.credentialRevision()).toBe(before);
			expect(auth.getToken()).toBe('tok-a');
			expect(changed).not.toHaveBeenCalled();
		}
	});

	it('passes the caller signal to fetch', async () => {
		sessionStorage.setItem(KEY, 'tok-a');
		const { fetchFn, fetchMock } = scriptedServer();
		const { auth } = provider(fetchFn);
		const abort = new AbortController();

		void auth.resolve({ signal: abort.signal }).catch(() => {});

		expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: abort.signal });
	});
});

describe('HTTP compare-and-set token writes (#259, I-7)', () => {
	it('S-20: a publicViewer grant token minted while a login finished is not stored; the login token stays', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);

		const entering = auth.enterGrant?.('publicViewer');
		const login = auth.login({ username: 'b', password: 'pw' });
		requests[1].reply.resolve(json(200, { success: true, token: 'tok-b' }));
		await expect(login).resolves.toEqual({ success: true, error: undefined });
		requests[0].reply.resolve(json(200, { success: true, token: 'public-token' }));

		await expect(entering).resolves.toEqual({ success: false, superseded: true });
		expect(auth.getToken()).toBe('tok-b');
	});

	it('S-52 (provider half): enterGrant with a stale expectRevision stores nothing', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);
		const ticketRevision = auth.credentialRevision();
		const login = auth.login({ username: 'b', password: 'pw' });
		requests[0].reply.resolve(json(200, { success: true, token: 'tok-b' }));
		await login;

		const entering = auth.enterGrant?.('publicViewer', { expectRevision: ticketRevision });

		await expect(entering).resolves.toEqual({ success: false, superseded: true });
		// A token is stored, so nothing is even requested (PR #264 re-review P1).
		expect(requests).toHaveLength(1);
		expect(auth.getToken()).toBe('tok-b');
	});

	it('S-42 (provider half): enterGrant with the current expectRevision stores the token and notifies once', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const ticketRevision = auth.credentialRevision();

		const entering = auth.enterGrant?.('publicViewer', { expectRevision: ticketRevision });
		requests[0].reply.resolve(json(200, { success: true, token: 'public-token' }));

		await expect(entering).resolves.toEqual({ success: true });
		expect(sessionStorage.getItem(KEY)).toBe('public-token');
		expect(auth.credentialRevision()).not.toBe(ticketRevision);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-21: a logout that was overtaken by a login does not clear the new token', async () => {
		sessionStorage.setItem(KEY, 'tok-a');
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);

		const logout = auth.logout();
		expect(requests[0]).toMatchObject({ path: '/api/auth/logout', token: 'tok-a' });
		const login = auth.login({ username: 'b', password: 'pw' });
		requests[1].reply.resolve(json(200, { success: true, token: 'tok-b' }));
		await login;
		requests[0].reply.resolve(new Response(null, { status: 204 }));
		await logout;

		expect(auth.getToken()).toBe('tok-b');
	});

	it('S-21: the logout request carries the token held when the logout started', async () => {
		sessionStorage.setItem(KEY, 'tok-a');
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);

		const logout = auth.logout();
		sessionStorage.setItem(KEY, 'tok-other');
		requests[0].reply.resolve(new Response(null, { status: 204 }));
		await logout;

		expect(requests[0].token).toBe('tok-a');
	});

	it('S-40: a login during which another tab rewrote the Remember me token does not overwrite it', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);

		const login = auth.login({ username: 'a', password: 'pw', remember: true });
		// Another tab logs in as B with Remember me.
		localStorage.setItem(KEY, 'tok-b-from-tab-2');
		windowTarget.dispatchEvent(storageEvent(KEY));
		requests[0].reply.resolve(json(200, { success: true, token: 'tok-a' }));

		await expect(login).resolves.toMatchObject({ success: false, superseded: true });
		expect(localStorage.getItem(KEY)).toBe('tok-b-from-tab-2');
	});

	it('S-18 (HTTP twin): setup overtaken by a login stores nothing and reports superseded', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);

		const setup = auth.setup?.({ username: 'owner', password: 'pw', displayName: 'O' });
		const login = auth.login({ username: 'b', password: 'pw' });
		requests[1].reply.resolve(json(200, { success: true, token: 'tok-b' }));
		await login;
		requests[0].reply.resolve(json(200, { success: true, token: 'tok-owner' }));

		await expect(setup).resolves.toMatchObject({ success: false, superseded: true });
		expect(auth.getToken()).toBe('tok-b');
	});
});

describe('HTTP compare-and-set: storage changed, event not yet delivered (PR #264 review P2)', () => {
	// Another tab's write is already visible in localStorage, but its
	// `storage` event (which advances this provider's revision) has not been
	// dispatched: the revision alone still matches, the token does not.

	it('S-40: a login does not overwrite a Remember me token another tab wrote before its event arrived', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const login = auth.login({ username: 'a', password: 'pw', remember: true });
		localStorage.setItem(KEY, 'tok-b-from-tab-2'); // no storage event yet
		requests[0].reply.resolve(json(200, { success: true, token: 'tok-a' }));

		await expect(login).resolves.toMatchObject({ success: false, superseded: true });
		expect(localStorage.getItem(KEY)).toBe('tok-b-from-tab-2');
		expect(sessionStorage.getItem(KEY)).toBeNull();
		expect(auth.credentialRevision()).toBe(before);
		expect(changed).not.toHaveBeenCalled();
	});

	it('S-40: a setup does not overwrite a token another tab wrote before its event arrived', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);

		const setup = auth.setup?.({ username: 'owner', password: 'pw', displayName: 'O' });
		localStorage.setItem(KEY, 'tok-b-from-tab-2'); // no storage event yet
		requests[0].reply.resolve(json(200, { success: true, token: 'tok-owner' }));

		await expect(setup).resolves.toMatchObject({ success: false, superseded: true });
		expect(localStorage.getItem(KEY)).toBe('tok-b-from-tab-2');
		expect(sessionStorage.getItem(KEY)).toBeNull();
	});

	it('S-21: a logout does not delete a Remember me token another tab wrote before its event arrived', async () => {
		localStorage.setItem(KEY, 'tok-a');
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const logout = auth.logout();
		expect(requests[0]).toMatchObject({ path: '/api/auth/logout', token: 'tok-a' });
		localStorage.setItem(KEY, 'tok-b-from-tab-2'); // no storage event yet
		requests[0].reply.resolve(new Response(null, { status: 204 }));
		await logout;

		expect(localStorage.getItem(KEY)).toBe('tok-b-from-tab-2');
		expect(auth.credentialRevision()).toBe(before);
		expect(changed).not.toHaveBeenCalled();
	});

	it('S-20: enterGrant does not store over a token another tab wrote before its event arrived', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);

		const entering = auth.enterGrant?.('publicViewer');
		localStorage.setItem(KEY, 'tok-b-from-tab-2'); // no storage event yet
		requests[0].reply.resolve(json(200, { success: true, token: 'public-token' }));

		await expect(entering).resolves.toEqual({ success: false, superseded: true });
		expect(localStorage.getItem(KEY)).toBe('tok-b-from-tab-2');
		expect(sessionStorage.getItem(KEY)).toBeNull();
	});

	it('S-20: with a caller expectRevision, the token is still compared against the value at the call start', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);
		const ticketRevision = auth.credentialRevision();

		const entering = auth.enterGrant?.('publicViewer', { expectRevision: ticketRevision });
		localStorage.setItem(KEY, 'tok-b-from-tab-2'); // no storage event yet
		requests[0].reply.resolve(json(200, { success: true, token: 'public-token' }));

		await expect(entering).resolves.toEqual({ success: false, superseded: true });
		expect(localStorage.getItem(KEY)).toBe('tok-b-from-tab-2');
		expect(sessionStorage.getItem(KEY)).toBeNull();
	});

	it('S-20: enterGrant("publicViewer", { expectRevision }) called AFTER another tab wrote a token (event not yet delivered) does not overwrite it', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		// The ticket: resolve() confirmed none at this revision.
		const ticketRevision = auth.credentialRevision();
		localStorage.setItem(KEY, 'tok-b-from-tab-2'); // no storage event yet

		const entering = auth.enterGrant?.('publicViewer', { expectRevision: ticketRevision });

		await expect(entering).resolves.toEqual({ success: false, superseded: true });
		expect(requests).toHaveLength(0);
		expect(localStorage.getItem(KEY)).toBe('tok-b-from-tab-2');
		expect(sessionStorage.getItem(KEY)).toBeNull();
		expect(auth.credentialRevision()).toBe(ticketRevision);
		expect(changed).not.toHaveBeenCalled();
	});

	it('S-20: the default enterGrant("publicViewer") called after another tab wrote a token does not overwrite it', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);
		localStorage.setItem(KEY, 'tok-b-from-tab-2'); // no storage event yet

		const entering = auth.enterGrant?.('publicViewer');

		await expect(entering).resolves.toEqual({ success: false, superseded: true });
		expect(requests).toHaveLength(0);
		expect(localStorage.getItem(KEY)).toBe('tok-b-from-tab-2');
		expect(sessionStorage.getItem(KEY)).toBeNull();
	});

	it('the event arriving afterwards advances the revision and notifies once', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const login = auth.login({ username: 'a', password: 'pw' });
		localStorage.setItem(KEY, 'tok-b-from-tab-2');
		requests[0].reply.resolve(json(200, { success: true, token: 'tok-a' }));
		await login;
		windowTarget.dispatchEvent(storageEvent(KEY));

		expect(auth.credentialRevision()).not.toBe(before);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(auth.getToken()).toBe('tok-b-from-tab-2');
	});
});

describe('HTTP revision and notifications (I-19, I-23)', () => {
	it('a successful login advances the revision and notifies once, in the response continuation', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const login = auth.login({ username: 'a', password: 'pw' });
		requests[0].reply.resolve(json(200, { success: true, token: 'tok-a' }));
		await login;

		expect(auth.credentialRevision()).not.toBe(before);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('a rejected login and a login the network dropped change nothing', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const rejected = auth.login({ username: 'a', password: 'wrong' });
		requests[0].reply.resolve(json(200, { success: false, error: 'bad credentials' }));
		await rejected;
		const dropped = auth.login({ username: 'a', password: 'pw' });
		requests[1].reply.reject(new TypeError('fetch failed'));
		await dropped;

		expect(auth.credentialRevision()).toBe(before);
		expect(changed).not.toHaveBeenCalled();
	});

	it('a logout whose request failed after sending still clears, advances and notifies', async () => {
		sessionStorage.setItem(KEY, 'tok-a');
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const logout = auth.logout();
		requests[0].reply.reject(new TypeError('fetch failed'));
		await logout;

		expect(auth.getToken()).toBeNull();
		expect(auth.credentialRevision()).not.toBe(before);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-21: the overtaken logout (compare-and-set not met) does not notify', async () => {
		sessionStorage.setItem(KEY, 'tok-a');
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);

		const logout = auth.logout();
		const login = auth.login({ username: 'b', password: 'pw' });
		requests[1].reply.resolve(json(200, { success: true, token: 'tok-b' }));
		await login;
		changed.mockClear();
		requests[0].reply.resolve(new Response(null, { status: 204 }));
		await logout;

		expect(changed).not.toHaveBeenCalled();
	});

	it('a logout with no token stored changes nothing', async () => {
		const { requests, fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		const logout = auth.logout();
		requests[0].reply.resolve(new Response(null, { status: 204 }));
		await logout;

		expect(auth.credentialRevision()).toBe(before);
		expect(changed).not.toHaveBeenCalled();
	});

	it("storage events: only this provider's key (or a clear) advances the revision and notifies", async () => {
		const { fetchFn } = scriptedServer();
		const { auth, changed } = provider(fetchFn);
		const before = auth.credentialRevision();

		windowTarget.dispatchEvent(storageEvent('some.other.key'));
		expect(auth.credentialRevision()).toBe(before);
		expect(changed).not.toHaveBeenCalled();

		windowTarget.dispatchEvent(storageEvent(KEY));
		const afterKey = auth.credentialRevision();
		expect(afterKey).not.toBe(before);
		expect(changed).toHaveBeenCalledTimes(1);

		windowTarget.dispatchEvent(storageEvent(null));
		expect(auth.credentialRevision()).not.toBe(afterKey);
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it('the revision is opaque: equal only to itself, never exposes the token', async () => {
		sessionStorage.setItem(KEY, 'secret-token');
		const { fetchFn } = scriptedServer();
		const { auth } = provider(fetchFn);

		const revision: CredentialRevision = auth.credentialRevision();

		expect(revision).not.toContain('secret-token');
		expect(auth.credentialRevision()).toBe(revision);
	});

	it('an unsubscribed listener is not called', async () => {
		const { requests, fetchFn } = scriptedServer();
		const auth = createHttpAuthProvider({ fetchFn });
		const listener = vi.fn();
		const unsubscribe = auth.onCredentialChanged(listener);
		unsubscribe();

		const login = auth.login({ username: 'a', password: 'pw' });
		requests[0].reply.resolve(json(200, { success: true, token: 'tok-a' }));
		await login;
		await flush();

		expect(listener).not.toHaveBeenCalled();
	});
});
