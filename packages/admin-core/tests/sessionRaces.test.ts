/**
 * Issue #215/#255 5th/6th review: an auth answer that was requested for one
 * session and arrives after this tab moved on to another (logout, then a
 * login as B whose session is confirmed and rendered) must not start, end
 * or change B's session scope - its owner, its generation (what
 * `(app)/+layout.svelte` compares against the generation its load
 * confirmed), or its saved list view state.
 *
 * Issue #260 実装-3 (v2.0.0): the pre-#260 API these scenarios were written
 * against (`establishSession`, `resolveProtectedSession`,
 * `confirmSessionEnded`, `beginSession`/`endSession`) is gone. The same
 * scenarios run against what replaced it on the default controller: a
 * load's `resolveSettled()`, the guard composition (`./guard.ts`), and
 * `signal()`. The logout and the login are the provider's reported
 * credential changes (`change()`), as they are in the app (I-10, I-19).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadListViewState, saveListViewState } from '../src/listViewState';
import { createHttpAuthProvider } from '../src/providers/http';
import type { AuthProvider, DataProvider } from '../src/provider';
import { initBanto } from '../src/registry.svelte';
import {
	getSessionController,
	resetDefaultSessionController,
	resolveSettled
} from '../src/sessionController.svelte';
import { onSessionEnded } from '../src/sessionEnded';
import {
	currentSessionScope,
	isCurrentSessionScope,
	sessionGeneration,
	type SessionScope
} from '../src/sessionScope.svelte';
import { guardRoute } from './guard';
import { ALICE, BOB, flush, makeProbeProvider } from './sessionHarness';

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

type Probe = ReturnType<typeof makeProbeProvider>;

/** Alice signed in on the default controller bound to a fresh probe provider. */
async function signedInAsAlice(): Promise<Probe> {
	const p = makeProbeProvider();
	initBanto({ dataProvider: {} as DataProvider, authProvider: p.provider, resources: [] });
	const first = resolveSettled(getSessionController());
	p.active(0, ALICE);
	await first;
	return p;
}

const last = (p: Probe) => p.probes.length - 1;

/** Log out of A and log in as B (both reported credential changes); B's load confirms B. Returns B's scope. */
async function switchToBob(p: Probe): Promise<SessionScope> {
	p.change(); // the logout cleared A's token
	p.change(); // B's login stored B's token
	const bobLoad = resolveSettled(getSessionController());
	p.active(last(p), BOB);
	await expect(bobLoad).resolves.toMatchObject({
		outcome: 'confirmed',
		snapshot: { owner: 'account:bob' }
	});
	const bob = currentSessionScope();
	saveListViewState(bob, 'items:server', {
		sort: [{ field: 'price', direction: 'asc' }],
		filters: []
	});
	return bob;
}

function expectBobUntouched(bob: SessionScope): void {
	expect(isCurrentSessionScope(bob)).toBe(true);
	expect(currentSessionScope().owner).toBe('account:bob');
	expect(sessionGeneration()).toBe(bob.generation);
	expect(loadListViewState(bob, 'items:server')?.sort).toEqual([
		{ field: 'price', direction: 'asc' }
	]);
}

let storage: Storage;
beforeEach(() => {
	storage = makeMemoryStorage();
	vi.stubGlobal('sessionStorage', storage);
	resetDefaultSessionController();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a late answer for A's session leaves B's session alone (#255 5th review, I-3)", () => {
	it('a load: A’s pending answer resolved after B’s load is discarded', async () => {
		const p = await signedInAsAlice();
		const aliceLoad = resolveSettled(getSessionController());
		const aliceProbe = last(p);

		const bob = await switchToBob(p);
		p.active(aliceProbe, ALICE);
		await flush();

		// The earlier load was superseded and asked again: it can only report B.
		await expect(aliceLoad).resolves.toMatchObject({ snapshot: { owner: 'account:bob' } });
		expectBobUntouched(bob);
	});

	it('a load whose answer was made stale by a session change asks the current session again (I-16)', async () => {
		const p = await signedInAsAlice();
		const load = resolveSettled(getSessionController());
		const stale = last(p);
		p.change(); // B logged in (another tab)
		p.active(stale, ALICE); // A's late answer
		await flush();
		p.active(last(p), BOB);

		const result = await load;
		expect(result).toMatchObject({ outcome: 'confirmed', snapshot: { owner: 'account:bob' } });
		expect(result.snapshot.generation).toBe(sessionGeneration());
	});

	it('the guard: A’s late `none` does not end B’s session; B is confirmed instead', async () => {
		const p = await signedInAsAlice();
		const guard = guardRoute(p.provider);
		const stale = last(p);

		const bob = await switchToBob(p);
		p.none(stale);
		await flush();

		await expect(guard).resolves.toBe('session');
		expectBobUntouched(bob);
	});

	it('a signal: A’s late `none` does not end B’s session nor notify', async () => {
		const p = await signedInAsAlice();
		getSessionController().signal('unauthorized');
		const stale = last(p);

		const bob = await switchToBob(p);
		const ended = vi.fn();
		const off = onSessionEnded(ended);
		p.none(stale);
		await flush();

		expect(ended).not.toHaveBeenCalled();
		expectBobUntouched(bob);
		off();
	});

	it('a signal: a `none` for the session still current ends it', async () => {
		const p = await signedInAsAlice();
		const alice = currentSessionScope();
		getSessionController().signal('unauthorized');
		p.none(last(p), { clear: true });
		await flush();
		expect(isCurrentSessionScope(alice)).toBe(false);
		expect(currentSessionScope().owner).toBeNull();
	});
});

// 6th review (P2 1): the check and the write must be ONE continuation. With
// the controller, requests in flight together share ONE probe (I-9), so "the
// guard's `none` and B's identity in the same turn" is one answer that both
// see; the state is that answer and the next load confirms B.
describe('requests settled in the same turn (#255 6th review, I-9)', () => {
	it('the guard and a load share one answer; the next load confirms B', async () => {
		const p = makeProbeProvider();
		initBanto({ dataProvider: {} as DataProvider, authProvider: p.provider, resources: [] });
		const guard = guardRoute({});
		const load = resolveSettled(getSessionController());
		expect(p.probes).toHaveLength(1);

		p.none(0);
		await expect(guard).resolves.toBe('login'); // no status(): no public viewer
		await expect(load).resolves.toMatchObject({ snapshot: { status: 'none' } });
		expect(p.probes).toHaveLength(1);

		p.change(); // B logs in
		const nextLoad = resolveSettled(getSessionController());
		p.active(last(p), BOB);
		await expect(nextLoad).resolves.toMatchObject({ snapshot: { owner: 'account:bob' } });
	});

	it('a signal and B’s load share the signal’s probe (it started after the signal)', async () => {
		const p = await signedInAsAlice();
		const probes = p.probes.length;
		getSessionController().signal('unauthorized');
		const load = resolveSettled(getSessionController());
		expect(p.probes).toHaveLength(probes + 1);
		p.active(last(p), BOB);

		await expect(load).resolves.toMatchObject({ snapshot: { owner: 'account:bob' } });
		expect(p.probes).toHaveLength(probes + 1);
	});
});

// 6th review (P2 2): an identity that could not be FETCHED (a 500, a network
// failure) is not "nobody" - the session scope and the saved state stay as
// they are (I-4), and the same identity confirmed on the retry restores it.
describe('a transient identity failure keeps the session and its saved state (#255 6th review, I-4)', () => {
	function httpAuth(responses: (() => Promise<Response>)[]): AuthProvider {
		sessionStorage.setItem('banto.auth.token', 'token-a');
		vi.stubGlobal('localStorage', makeMemoryStorage());
		const fetchFn = vi.fn(async (url: string) => {
			if (url.endsWith('/api/auth/identity')) return responses.shift()!();
			throw new Error(`unexpected ${url}`);
		});
		return createHttpAuthProvider({ fetchFn: fetchFn as unknown as typeof fetch });
	}

	it.each([
		['a 500', async () => new Response('boom', { status: 500 })],
		[
			'a network failure',
			async () => {
				throw new TypeError('Failed to fetch');
			}
		]
	])('%s, then the same identity again', async (_label, failure) => {
		const auth = httpAuth([
			async () => new Response(JSON.stringify(ALICE), { status: 200 }),
			failure,
			async () => new Response(JSON.stringify(ALICE), { status: 200 })
		]);
		initBanto({ dataProvider: {} as DataProvider, authProvider: auth, resources: [] });
		const controller = getSessionController();
		await expect(resolveSettled(controller)).resolves.toMatchObject({ outcome: 'confirmed' });
		const alice = currentSessionScope();
		saveListViewState(alice, 'items:server', {
			sort: [{ field: 'price', direction: 'desc' }],
			filters: []
		});

		await expect(resolveSettled(controller)).resolves.toMatchObject({ outcome: 'unverified' });
		expect(isCurrentSessionScope(alice)).toBe(true);
		expect(sessionGeneration()).toBe(alice.generation);
		expect(storage.getItem('banto.listView.items:server')).not.toBeNull();

		await expect(resolveSettled(controller)).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(isCurrentSessionScope(alice)).toBe(true);
		expect(loadListViewState(alice, 'items:server')?.sort).toEqual([
			{ field: 'price', direction: 'desc' }
		]);
	});

	it("an ownerless session (an identity without an id) does not drop the previous owner's entries (S-10)", async () => {
		const p = await signedInAsAlice();
		const alice = currentSessionScope();
		saveListViewState(alice, 'items:server', { sort: [], filters: [] });

		p.change();
		const ownerless = resolveSettled(getSessionController());
		p.active(last(p), { id: '', name: 'nobody' });
		await ownerless;
		expect(currentSessionScope().owner).toBeNull();
		expect(storage.getItem('banto.listView.items:server')).not.toBeNull();

		p.change();
		const again = resolveSettled(getSessionController());
		p.active(last(p), ALICE);
		await again;
		expect(loadListViewState(currentSessionScope(), 'items:server')).not.toBeNull();
	});
});
