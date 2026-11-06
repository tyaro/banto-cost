/**
 * SessionController (Issue #260 実装-2/実装-3, docs/design/session-controller-design.md).
 * Test names start with the scenario number (`S-n:`) of design §4; each
 * `describe` names the invariants (I-n) it pins down. §3.1's generation
 * table has one test per row. The order of answers/timers is decided by the
 * statements here (`sessionHarness.ts`, design §8.1).
 */
import { describe, expect, it, vi } from 'vitest';
import { adaptLegacyAuthProvider } from '../src/providers/legacyAdapter';
import { createHttpAuthProvider } from '../src/providers/http';
import { StaleAnswerError } from '../src/errors';
import type { AuthProvider } from '../src/provider';
import {
	controllerInternals,
	createSessionController,
	grantFallback,
	resolveSettled,
	SessionChangedError,
	sessionOwnerKey,
	SessionTimeoutError,
	type ResolveResult,
	type SessionControllerDeps,
	type SessionSnapshot
} from '../src/sessionController.svelte';
import {
	ALICE,
	BOB,
	COMMISSIONING_GRANT,
	deferred,
	flush,
	makeProbeProvider,
	makeScheduler,
	PUBLIC,
	serverError
} from './sessionHarness';

function setup(options: { revision?: number; deps?: Partial<SessionControllerDeps> } = {}) {
	const scheduler = makeScheduler();
	const p = makeProbeProvider({ revision: options.revision });
	const onNone = vi.fn();
	const onActive = vi.fn();
	const controller = createSessionController(p.provider, {
		scheduler,
		onNone,
		onActive,
		...options.deps
	});
	const changes: { next: SessionSnapshot; prev: SessionSnapshot }[] = [];
	controller.subscribe((next, prev) => changes.push({ next, prev }));
	const last = () => p.probes.length - 1;
	/** Confirm `identity` (or none) through one probe. */
	async function settleTo(identity: typeof ALICE | null): Promise<ResolveResult> {
		const request = controller.resolve();
		if (identity) p.active(last(), identity);
		else p.none(last());
		await flush();
		return request;
	}
	return { scheduler, p, controller, onNone, onActive, changes, last, settleTo };
}

describe('§4.1 the #255 scenarios (I-1, I-3, I-4, I-6, I-9, I-20)', () => {
	it('S-1: a hold while A’s probe waits supersedes it; B’s later confirmation is not undone by A’s late answer', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const aRequest = controller.resolve();
		expect(p.probes).toHaveLength(2);
		p.change(); // the credential changed while ALICE was active (hold)
		await expect(aRequest).resolves.toMatchObject({ outcome: 'superseded' });
		expect(p.probes[1].signal?.aborted).toBe(true);
		expect(p.probes).toHaveLength(3); // the hold started the background confirmation

		const bRequest = controller.resolve(); // joins the background probe
		p.active(2, BOB);
		await expect(bRequest).resolves.toMatchObject({ outcome: 'confirmed' });
		const bob = controller.snapshot;
		p.active(1, ALICE); // A's late answer
		await flush();
		expect(controller.snapshot).toBe(bob);
		expect(bob.owner).toBe('account:bob');
	});

	it('S-2: a standard provider reports the switch (hold); the old probe is dropped and a new one decides', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const request = controller.resolve();
		p.change(); // another tab logged in as B
		await expect(request).resolves.toMatchObject({ outcome: 'superseded' });
		expect(controller.snapshot.status).toBe('unknown');
		expect(p.probes[1].signal?.aborted).toBe(true);
		expect(p.probes).toHaveLength(3); // the background confirmation
		p.active(1, ALICE); // stale answer for A
		p.active(2, BOB);
		await flush();
		expect(controller.snapshot).toMatchObject({ status: 'active', owner: 'account:bob' });
	});

	it('S-2: through the compatibility adapter the switch is not detectable (documented non-guarantee)', async () => {
		let who = ALICE;
		const legacy = {
			login: async () => ({ success: true }),
			logout: async () => {},
			check: vi.fn(async () => true),
			getIdentity: vi.fn(async () => who)
		};
		const controller = createSessionController(adaptLegacyAuthProvider(legacy), {
			scheduler: makeScheduler(),
			onNone: vi.fn(),
			onActive: vi.fn()
		});
		await controller.resolve();
		const before = controller.snapshot.generation;
		who = BOB; // switched with no revision and no notification
		expect(controller.snapshot.status).toBe('active');
		await controller.resolve();
		expect(controller.snapshot.owner).toBe('account:bob');
		expect(controller.snapshot.generation).toBe(before + 1); // active(A) -> active(B), no hold
	});

	it('S-3: a `none` for A that arrives after B was confirmed is discarded', async () => {
		const { p, controller, settleTo, onNone } = setup();
		await settleTo(ALICE);
		const aRequest = controller.resolve();
		p.change();
		await expect(aRequest).resolves.toMatchObject({ outcome: 'superseded' });
		p.active(2, BOB);
		await flush();
		p.none(1);
		await flush();
		expect(controller.snapshot.owner).toBe('account:bob');
		expect(onNone).not.toHaveBeenCalled();
	});

	it('S-4: a signal’s probe answering `none` after B was confirmed does not end B', async () => {
		const { p, controller, settleTo, changes } = setup();
		await settleTo(ALICE);
		controller.signal('unauthorized');
		expect(p.probes).toHaveLength(2);
		p.change(); // B logged in
		expect(p.probes[1].signal?.aborted).toBe(true);
		p.active(2, BOB); // B's probe started after the signal
		await flush();
		p.none(1);
		await flush();
		expect(controller.snapshot.owner).toBe('account:bob');
		expect(changes.some((c) => c.next.status === 'none')).toBe(false);
		expect(p.live()).toBe(0);
	});

	it('S-5: a signal confirmed `none` commits once: +1, saved state cleared, listeners told', async () => {
		const { p, controller, settleTo, onNone, changes } = setup();
		await settleTo(ALICE);
		const generation = controller.snapshot.generation;
		changes.length = 0;
		const request = controller.resolve({ cause: 'signal' });
		p.none(1);
		await expect(request).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot).toMatchObject({ status: 'none', generation: generation + 1 });
		expect(onNone).toHaveBeenCalledTimes(1);
		expect(changes).toHaveLength(1);
	});

	it('S-6: A’s `none` and B’s answer settled in the same turn leave B (order-independent)', async () => {
		for (const order of ['none-first', 'bob-first'] as const) {
			const { p, controller, settleTo } = setup();
			await settleTo(ALICE);
			const aCheck = controller.resolve();
			p.change(); // B's login in this tab
			const bLoad = controller.resolve();
			if (order === 'none-first') {
				p.none(1);
				p.active(2, BOB);
			} else {
				p.active(2, BOB);
				p.none(1);
			}
			await flush();
			await expect(aCheck).resolves.toMatchObject({ outcome: 'superseded' });
			await expect(bLoad).resolves.toMatchObject({ outcome: 'confirmed' });
			expect(controller.snapshot.owner).toBe('account:bob');
		}
	});

	it('S-7: the signal version of S-6 - B, and no ending is published', async () => {
		const { p, controller, settleTo, changes } = setup();
		await settleTo(ALICE);
		controller.signal('unauthorized');
		p.change();
		p.none(1);
		p.active(2, BOB);
		await flush();
		expect(controller.snapshot.owner).toBe('account:bob');
		expect(changes.some((c) => c.next.status === 'none')).toBe(false);
	});

	it('S-8: a rejected probe is `unverified` and changes nothing but `verification`; the retry confirms the same generation', async () => {
		const { p, controller, settleTo, onNone } = setup();
		await settleTo(ALICE);
		const before = controller.snapshot;
		const failed = controller.resolve();
		const error = serverError();
		p.fail(1, error);
		await expect(failed).resolves.toMatchObject({ outcome: 'unverified', error });
		expect(controller.snapshot).toMatchObject({
			status: 'active',
			owner: 'account:alice',
			generation: before.generation,
			verification: { state: 'failed', lastError: error }
		});
		const retried = controller.resolve();
		p.active(2, ALICE);
		await expect(retried).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot.generation).toBe(before.generation);
		expect(controller.snapshot.verification.state).toBe('idle');
		expect(onNone).not.toHaveBeenCalled();
	});

	it('S-9: HTTP `200 null` for a sent token is `none`; the token is cleared by compare-and-set and carried in `current`, not notified', async () => {
		const map = new Map<string, string>();
		const storage = {
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => void map.set(k, v),
			removeItem: (k: string) => void map.delete(k),
			clear: () => map.clear(),
			key: () => null,
			get length() {
				return map.size;
			}
		} as Storage;
		vi.stubGlobal('sessionStorage', storage);
		vi.stubGlobal('localStorage', storage);
		try {
			storage.setItem('banto.auth.token', 'revoked');
			const fetchFn = vi.fn(async () => new Response('null', { status: 200 }));
			const http = createHttpAuthProvider({ fetchFn: fetchFn as unknown as typeof fetch });
			const notified = vi.fn();
			http.onCredentialChanged(notified);
			const onNone = vi.fn();
			const controller = createSessionController(http, { onNone, onActive: vi.fn() });
			await expect(controller.resolve()).resolves.toMatchObject({ outcome: 'confirmed' });
			expect(controller.snapshot.status).toBe('none');
			expect(http.getToken()).toBeNull();
			expect(notified).not.toHaveBeenCalled();
			expect(onNone).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('S-10: an identity without an id is active with no owner (+1); A’s saved state is not dropped', async () => {
		const { controller, settleTo, onNone, onActive } = setup();
		await settleTo(ALICE);
		const generation = controller.snapshot.generation;
		onActive.mockClear();
		await settleTo({ id: '', name: 'nobody' });
		expect(controller.snapshot).toMatchObject({
			status: 'active',
			owner: null,
			generation: generation + 1
		});
		expect(onNone).not.toHaveBeenCalled();
		expect(onActive).not.toHaveBeenCalled();
		await settleTo(ALICE);
		expect(controller.snapshot.owner).toBe('account:alice');
	});

	it('S-12: an old probe (before the hold) and a new one (after) settling in the same turn: only the new one counts', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const old = controller.resolve();
		p.change();
		const fresh = controller.resolve();
		p.none(1);
		p.active(2, BOB);
		await flush();
		await expect(old).resolves.toMatchObject({ outcome: 'superseded' });
		await expect(fresh).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot.owner).toBe('account:bob');
	});

	it('S-13: two requests share one probe (single-flight) and get the same snapshot', async () => {
		const { p, controller } = setup();
		const first = controller.resolve();
		const second = controller.resolve();
		expect(p.provider.resolve).toHaveBeenCalledTimes(1);
		p.active(0, ALICE);
		const [a, b] = await Promise.all([first, second]);
		expect(a.outcome).toBe('confirmed');
		expect(a.snapshot).toBe(b.snapshot);
	});

	it('S-14: a hold supersedes both waiters and aborts the probe; the background confirmation replaces it (with its own signal)', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const first = controller.resolve();
		const second = controller.resolve();
		p.change();
		await expect(first).resolves.toMatchObject({ outcome: 'superseded' });
		await expect(second).resolves.toMatchObject({ outcome: 'superseded' });
		expect(p.probes[1].signal?.aborted).toBe(true);
		expect(p.probes).toHaveLength(3);
		expect(p.probes[2].signal?.aborted).toBe(false);
		p.active(1, ALICE); // the retired probe's late answer is never applied
		await flush();
		expect(controller.snapshot.status).toBe('unknown');
		// resolveSettled joins the background probe.
		const settled = resolveSettled(controller);
		expect(p.probes).toHaveLength(3);
		p.none(2);
		await expect(settled).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot.status).toBe('none');
	});
});

describe('§4.4 a switch followed by a failed confirmation (I-2, I-4, I-5, I-6)', () => {
	async function switched() {
		const ctx = setup();
		await ctx.settleTo(ALICE);
		const generation = ctx.controller.snapshot.generation;
		ctx.p.change(); // B
		return { ...ctx, generation };
	}

	it('S-23: the hold (unknown, +1) is kept when the confirmation fails - A is not active again', async () => {
		const { p, controller, generation } = await switched();
		expect(controller.snapshot).toMatchObject({
			status: 'unknown',
			owner: null,
			generation: generation + 1
		});
		const request = controller.resolve();
		p.fail(1);
		await expect(request).resolves.toMatchObject({ outcome: 'unverified' });
		expect(controller.snapshot.status).toBe('unknown');
	});

	it('S-24: the retry confirms B: +1 again, other owners’ saved state purged', async () => {
		const { p, controller, generation, onActive } = await switched();
		const failed = controller.resolve();
		p.fail(1);
		await failed;
		const retried = controller.resolve();
		p.active(2, BOB);
		await expect(retried).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot.generation).toBe(generation + 2);
		expect(onActive).toHaveBeenLastCalledWith('account:bob');
	});

	it('S-25: the retry confirms `none`: one commit, +1, cleared', async () => {
		const { p, controller, generation, onNone } = await switched();
		const failed = controller.resolve();
		p.fail(1);
		await failed;
		const retried = controller.resolve();
		p.none(2);
		await retried;
		expect(controller.snapshot).toMatchObject({ status: 'none', generation: generation + 2 });
		expect(onNone).toHaveBeenCalledTimes(1);
	});

	it('S-26: the SAME credential failing keeps A active (distinct from S-23)', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const request = controller.resolve();
		p.fail(1);
		await expect(request).resolves.toMatchObject({ outcome: 'unverified' });
		expect(controller.snapshot).toMatchObject({
			status: 'active',
			owner: 'account:alice',
			verification: { state: 'failed' }
		});
	});

	it('S-27: a scope captured before the switch is no longer current', async () => {
		const { controller, settleTo, p } = setup();
		await settleTo(ALICE);
		const scope = controller.scope();
		p.change();
		expect(controller.isCurrent(scope)).toBe(false);
	});
});

describe('§4.5 freshness and deadlines (I-3, I-8, I-9, I-15, I-22)', () => {
	it('S-28: a signal-caused request is not answered by a probe that started before it', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const navigation = controller.resolve();
		const signalled = controller.resolve({ cause: 'signal' });
		expect(p.probes).toHaveLength(3);
		expect(p.probes[1].signal?.aborted).toBe(true);
		p.active(1, ALICE); // the older probe
		await flush();
		p.active(2, ALICE);
		await expect(signalled).resolves.toMatchObject({ outcome: 'confirmed' });
		await expect(navigation).resolves.toMatchObject({ outcome: 'confirmed' });
	});

	it('S-29: a signal during a navigation probe discards that probe and asks again (pendingBackground)', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const navigation = controller.resolve();
		controller.signal('unauthorized');
		expect(p.probes).toHaveLength(3);
		expect(p.probes[1].signal?.aborted).toBe(true);
		p.active(1, ALICE);
		await flush();
		p.none(2);
		await expect(navigation).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot.status).toBe('none');
	});

	it('S-30: the probe deadline gives `unverified` (timeout), aborts the probe, keeps the state', async () => {
		const { p, controller, settleTo, scheduler } = setup();
		await settleTo(ALICE);
		const snapshot = controller.snapshot;
		const request = controller.resolve();
		await scheduler.advance(10_000);
		const result = await request;
		expect(result.outcome).toBe('unverified');
		expect((result as { error: unknown }).error).toBeInstanceOf(SessionTimeoutError);
		expect(p.probes[1].signal?.aborted).toBe(true);
		expect(controller.snapshot.status).toBe(snapshot.status);
		expect(controller.snapshot.generation).toBe(snapshot.generation);
		expect(p.probes).toHaveLength(2); // no pendingBackground: nothing re-issued
	});

	it('S-31: a late `none` that cleared the credential sets pendingBackground; the next probe confirms `none`', async () => {
		const { p, controller, settleTo, scheduler } = setup();
		await settleTo(ALICE);
		const notified = vi.fn();
		p.provider.onCredentialChanged(notified);
		const request = controller.resolve();
		await scheduler.advance(10_000);
		await request;
		p.none(1, { clear: true }); // late, abandoned
		await flush();
		expect(p.probes).toHaveLength(3);
		p.none(2);
		await flush();
		expect(controller.snapshot.status).toBe('none');
		expect(notified).not.toHaveBeenCalled();
	});

	it('S-32: a late `active(A)` after the deadline is discarded; the next request asks again', async () => {
		const { p, controller, settleTo, scheduler } = setup();
		await settleTo(ALICE);
		const request = controller.resolve();
		await scheduler.advance(10_000);
		await request;
		p.active(1, ALICE);
		await flush();
		expect(controller.snapshot.verification.state).toBe('failed');
		const next = controller.resolve();
		expect(p.probes).toHaveLength(3);
		p.active(2, ALICE);
		await expect(next).resolves.toMatchObject({ outcome: 'confirmed' });
	});

	it('S-101: a late answer after the deadline that came with an unreported revision advance holds A and starts a confirmation (I-5)', async () => {
		const { p, controller, settleTo, scheduler } = setup();
		await settleTo(ALICE);
		const generation = controller.snapshot.generation;
		const request = controller.resolve();
		await scheduler.advance(10_000);
		await expect(request).resolves.toMatchObject({ outcome: 'unverified' });
		expect(controller.snapshot.status).toBe('active');

		// The provider observed a `seq` advance from this very answer (the Tauri
		// provider observes `current`), without a report.
		p.bump();
		p.active(1, ALICE);
		await flush();

		expect(controller.snapshot).toMatchObject({
			status: 'unknown',
			owner: null,
			generation: generation + 1
		});
		expect(p.probes).toHaveLength(3); // the background confirmation
		expect(p.live()).toBe(1);
	});

	it('S-33: a signal that cannot be verified retries with backoff until confirmed (also for resolve({cause: "signal"}))', async () => {
		for (const start of ['signal', 'resolve'] as const) {
			const { p, controller, settleTo, scheduler } = setup();
			await settleTo(ALICE);
			if (start === 'signal') controller.signal('unauthorized');
			else void controller.resolve({ cause: 'signal' });
			p.fail(1);
			await flush();
			await scheduler.advance(999);
			expect(p.probes).toHaveLength(2);
			await scheduler.advance(1);
			expect(p.probes).toHaveLength(3); // 1 s
			p.fail(2);
			await flush();
			await scheduler.advance(2_000);
			expect(p.probes).toHaveLength(4); // 2 s
			p.none(3);
			await flush();
			expect(controller.snapshot.status).toBe('none');
			await scheduler.advance(60_000);
			expect(p.probes).toHaveLength(4); // confirmed: stops
		}
	});

	it('S-72: repeated probe deadlines abort every probe; never more than one un-aborted fetch', async () => {
		const { p, controller, settleTo, scheduler } = setup();
		await settleTo(ALICE);
		controller.signal('unauthorized'); // pendingBackground
		for (let i = 0; i < 5; i++) {
			await scheduler.advance(10_000); // the probe deadline
			expect(p.live()).toBeLessThanOrEqual(1);
			await scheduler.advance(30_000); // the backoff
			expect(p.live()).toBeLessThanOrEqual(1);
		}
		expect(p.probes.slice(1, -1).every((probe) => probe.signal?.aborted)).toBe(true);
	});

	it('I-22: a waiter leaving on its own deadline does not abort a probe another waiter still needs', async () => {
		const { p, controller, scheduler } = setup();
		const short = resolveSettled(controller, { deadlineMs: 1_000 });
		const long = controller.resolve();
		await scheduler.advance(1_000);
		await expect(short).resolves.toMatchObject({ outcome: 'unverified' });
		expect(p.probes[0].signal?.aborted).toBe(false);
		p.active(0, ALICE);
		await expect(long).resolves.toMatchObject({ outcome: 'confirmed' });
	});

	it('I-22: the last waiter leaving (no pendingBackground) aborts the probe', async () => {
		const { p, controller, scheduler } = setup();
		const only = resolveSettled(controller, { deadlineMs: 1_000 });
		await scheduler.advance(1_000);
		await expect(only).resolves.toMatchObject({ outcome: 'unverified' });
		expect(p.probes[0].signal?.aborted).toBe(true);
	});
});

describe('§4.7 credential-less grants (I-10, I-13, I-18, I-21; ADR-0017)', () => {
	it('S-42: none -> status -> isCurrent -> enterGrant(publicViewer, expectRevision r0) -> confirmed publicViewer (+1)', async () => {
		const { p, controller } = setup();
		const first = controller.resolve();
		p.none(0);
		const confirmed = await first;
		if (confirmed.outcome !== 'confirmed') throw new Error('expected confirmed');
		const generation = controller.snapshot.generation;
		const r0 = p.revision;
		const fallback = grantFallback(controller, p.provider, confirmed.ticket, {
			kind: 'publicViewer'
		});
		p.statuses[0].resolve({ initialized: true, grants: { publicViewer: true } });
		await flush();
		expect(p.entries[0].expectRevision).toBe(r0);
		p.change(); // the provider stored the public token and reports it
		expect(controller.snapshot.status).toBe('none'); // none is not held (I-5)
		p.entries[0].answer.resolve({ success: true });
		await flush();
		p.active(p.probes.length - 1, PUBLIC);
		const result = await fallback;
		expect(result).toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot).toMatchObject({
			status: 'active',
			kind: 'publicViewer',
			owner: 'publicViewer',
			generation: generation + 1
		});
	});

	it('S-43: a login while the entry is pending: the entry is superseded and B is confirmed', async () => {
		const { p, controller } = setup();
		const first = controller.resolve();
		p.none(0);
		const confirmed = await first;
		if (confirmed.outcome !== 'confirmed') throw new Error('expected confirmed');
		const fallback = grantFallback(controller, p.provider, confirmed.ticket, {
			kind: 'publicViewer'
		});
		p.statuses[0].resolve({ initialized: true, grants: { publicViewer: true } });
		await flush();
		p.change(); // B logged in
		p.entries[0].answer.resolve({ success: false, superseded: true });
		await flush();
		p.active(p.probes.length - 1, BOB);
		await expect(fallback).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot.owner).toBe('account:bob');
		expect(p.entries).toHaveLength(1);
	});

	it('S-47: a `local` answer (Tauri auth-disabled) is keyed `local`, not `account:0`', async () => {
		const { p, controller } = setup();
		const request = controller.resolve();
		p.active(0, { id: 0 as unknown as string, name: 'local', role: 'admin' }, { kind: 'local' });
		await request;
		expect(controller.snapshot).toMatchObject({ status: 'active', kind: 'local', owner: 'local' });
		expect(sessionOwnerKey({ id: '0', name: 'x' })).toBe('account:0');
	});

	it('S-66: the entry succeeds but the final confirmation fails: `unverified` with the `none` snapshot (503, not /login)', async () => {
		const { p, controller } = setup();
		const first = controller.resolve();
		p.none(0);
		const confirmed = await first;
		if (confirmed.outcome !== 'confirmed') throw new Error('expected confirmed');
		const fallback = grantFallback(controller, p.provider, confirmed.ticket, {
			kind: 'publicViewer'
		});
		p.statuses[0].resolve({ initialized: true, grants: { publicViewer: true } });
		await flush();
		p.change();
		p.entries[0].answer.resolve({ success: true });
		await flush();
		p.fail(p.probes.length - 1);
		const result = await fallback;
		expect(result.outcome).toBe('unverified');
		expect(result.snapshot.status).toBe('none');
	});

	/** A confirmed `none` and its ticket. */
	async function confirmedNoneTicket(ctx: ReturnType<typeof setup>) {
		const first = ctx.controller.resolve();
		ctx.p.none(ctx.p.probes.length - 1);
		const confirmed = await first;
		if (confirmed.outcome !== 'confirmed') throw new Error('expected confirmed');
		return confirmed.ticket;
	}

	it('S-109: S-42 for an arbitrary kind: grantFallback({ kind: commissioning }) enters it and confirms active commissioning (+1)', async () => {
		const ctx = setup();
		const { p, controller } = ctx;
		const ticket = await confirmedNoneTicket(ctx);
		const generation = controller.snapshot.generation;
		const fallback = grantFallback(controller, p.provider, ticket, { kind: 'commissioning' });
		p.statuses[0].resolve({ initialized: true, grants: { commissioning: true } });
		await flush();
		expect(p.entries).toHaveLength(1);
		expect(p.entries[0].kind).toBe('commissioning');
		expect(p.entries[0].expectRevision).toBe(ticket.revision);
		p.change(); // the provider stored the grant token and reports it
		p.entries[0].answer.resolve({ success: true });
		await flush();
		p.active(p.probes.length - 1, COMMISSIONING_GRANT);
		await expect(fallback).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot).toMatchObject({
			status: 'active',
			kind: 'commissioning',
			owner: 'commissioning',
			generation: generation + 1
		});
	});

	it.each([
		['the kind is reported false', { commissioning: false }],
		['the kind is missing from grants', { publicViewer: true }],
		['grants is missing', undefined]
	])(
		'S-110: %s: enterGrant is never called and the confirmed `none` stands',
		async (_label, grants) => {
			const ctx = setup();
			const { p, controller } = ctx;
			const ticket = await confirmedNoneTicket(ctx);
			const generation = controller.snapshot.generation;
			const fallback = grantFallback(controller, p.provider, ticket, { kind: 'commissioning' });
			p.statuses[0].resolve({ initialized: true, ...(grants ? { grants } : {}) });
			const result = await fallback;
			expect(p.provider.enterGrant).not.toHaveBeenCalled();
			expect(result).toMatchObject({ outcome: 'confirmed', ticket });
			expect(result.snapshot.status).toBe('none');
			expect(controller.snapshot.generation).toBe(generation);
		}
	);

	it('S-111: a provider without enterGrant: the `none` stands and no entry is attempted', async () => {
		const ctx = setup();
		const { p, controller } = ctx;
		const ticket = await confirmedNoneTicket(ctx);
		const generation = controller.snapshot.generation;
		const fallback = grantFallback(controller, { status: p.provider.status }, ticket, {
			kind: 'publicViewer'
		});
		p.statuses[0].resolve({ initialized: true, grants: { publicViewer: true } });
		const result = await fallback;
		expect(p.provider.enterGrant).not.toHaveBeenCalled();
		expect(result).toMatchObject({ outcome: 'confirmed', ticket });
		expect(result.snapshot.status).toBe('none');
		expect(controller.snapshot.generation).toBe(generation);
	});

	it('S-112: a custom `available` predicate decides instead of grants[kind]', async () => {
		const ctx = setup();
		const { p, controller } = ctx;
		const ticket = await confirmedNoneTicket(ctx);
		const available = vi.fn(
			(status: { grants?: Record<string, boolean> }) => status.grants?.anything === true
		);
		const fallback = grantFallback(controller, p.provider, ticket, {
			kind: 'commissioning',
			available
		});
		// grants.commissioning is true but the predicate reads `anything`: no entry.
		p.statuses[0].resolve({ initialized: true, grants: { commissioning: true } });
		const refused = await fallback;
		expect(available).toHaveBeenCalledTimes(1);
		expect(p.provider.enterGrant).not.toHaveBeenCalled();
		expect(refused.snapshot.status).toBe('none');

		const again = grantFallback(controller, p.provider, ticket, {
			kind: 'commissioning',
			available
		});
		p.statuses[1].resolve({ initialized: true, grants: { anything: true } });
		await flush();
		expect(p.entries).toHaveLength(1);
		expect(p.entries[0].kind).toBe('commissioning');
		p.entries[0].answer.resolve({ success: false }); // 403: the none stands
		await expect(again).resolves.toMatchObject({ outcome: 'confirmed' });
	});

	it('S-113: revoked -> 401 -> the provider clears the token -> grantFallback silently re-enters the grant', async () => {
		const { p, controller } = setup();
		const entered = controller.resolve();
		p.active(0, COMMISSIONING_GRANT);
		await entered;
		expect(controller.snapshot).toMatchObject({ status: 'active', kind: 'commissioning' });

		controller.signal('unauthorized');
		p.none(p.probes.length - 1, { clear: true }); // the provider cleared the revoked token
		await flush();
		expect(controller.snapshot.status).toBe('none');
		const ticket = controller.ticket();
		expect(ticket.revision).toBeDefined(); // never an epoch-only ticket
		expect(ticket.revision).toBe(p.revision);
		const generation = controller.snapshot.generation;

		const fallback = grantFallback(controller, p.provider, ticket, { kind: 'commissioning' });
		p.statuses[0].resolve({ initialized: true, grants: { commissioning: true } });
		await flush();
		expect(p.entries).toHaveLength(1);
		expect(p.entries[0].expectRevision).toBe(ticket.revision);
		p.change();
		p.entries[0].answer.resolve({ success: true });
		await flush();
		p.active(p.probes.length - 1, COMMISSIONING_GRANT);
		await expect(fallback).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot).toMatchObject({
			status: 'active',
			kind: 'commissioning',
			owner: 'commissioning',
			generation: generation + 1
		});
	});

	it('S-114: after the lock-down the kind is unavailable: the `none` stands (the guard goes to /login)', async () => {
		const { p, controller } = setup();
		const entered = controller.resolve();
		p.active(0, COMMISSIONING_GRANT);
		await entered;
		controller.signal('unauthorized');
		p.none(p.probes.length - 1, { clear: true });
		await flush();
		const ticket = controller.ticket();
		const generation = controller.snapshot.generation;

		const fallback = grantFallback(controller, p.provider, ticket, { kind: 'commissioning' });
		p.statuses[0].resolve({ initialized: true, grants: { commissioning: false } });
		const result = await fallback;
		expect(p.provider.enterGrant).not.toHaveBeenCalled();
		expect(result).toMatchObject({ outcome: 'confirmed', ticket });
		expect(result.snapshot.status).toBe('none');
		expect(controller.snapshot.generation).toBe(generation);
	});
});

describe('§6.1 grantFallback: tickets and bounded re-runs (I-7, I-18; S-20, S-52)', () => {
	/** A confirmed `none` and its ticket - where the guard hands over to the policy. */
	async function confirmedNone(ctx: ReturnType<typeof setup>) {
		const first = ctx.controller.resolve();
		ctx.p.none(0);
		const confirmed = await first;
		if (confirmed.outcome !== 'confirmed') throw new Error('expected confirmed');
		return confirmed.ticket;
	}

	it('S-52: B is confirmed while status() is pending: the stale ticket stops the mint, B is the answer', async () => {
		const ctx = setup();
		const { p, controller } = ctx;
		const ticket = await confirmedNone(ctx);
		const fallback = grantFallback(controller, p.provider, ticket, { kind: 'publicViewer' });

		p.change(); // B logged in (none is not held; a background probe starts)
		p.active(ctx.last(), BOB);
		await flush();
		expect(controller.snapshot.owner).toBe('account:bob');
		p.statuses[0].resolve({ initialized: true, grants: { publicViewer: true } });
		await flush();
		p.active(ctx.last(), BOB); // the policy confirms what is stored now

		const result = await fallback;
		expect(p.entries).toHaveLength(0); // enterGrant never called
		expect(result).toMatchObject({ outcome: 'confirmed', snapshot: { owner: 'account:bob' } });
	});

	it('S-20: a revoked token appeared before the mint, its event not yet delivered: the mint is superseded, the token confirmed `none` (cleared), and the re-run mints', async () => {
		const ctx = setup();
		const { p, controller } = ctx;
		const ticket = await confirmedNone(ctx);
		const fallback = grantFallback(controller, p.provider, ticket, { kind: 'publicViewer' });

		p.statuses[0].resolve({ initialized: true, grants: { publicViewer: true } });
		await flush();
		expect(p.entries[0].expectRevision).toBe(ticket.revision);
		p.entries[0].answer.resolve({ success: false, superseded: true }); // a token is stored
		await flush();
		p.none(ctx.last(), { clear: true }); // it was revoked: resolve() cleared it
		await flush();

		// The re-run, with the ticket of that confirmation.
		p.statuses[1].resolve({ initialized: true, grants: { publicViewer: true } });
		await flush();
		expect(p.entries[1].expectRevision).toBe(p.revision);
		p.change(); // the publicViewer grant token was stored and reported
		p.entries[1].answer.resolve({ success: true });
		await flush();
		p.active(ctx.last(), PUBLIC);

		await expect(fallback).resolves.toMatchObject({
			outcome: 'confirmed',
			snapshot: { kind: 'publicViewer', owner: 'publicViewer' }
		});
		expect(p.statuses).toHaveLength(2);
	});

	it('S-20: the same token, its event already delivered (the ticket is stale at the check): confirmed `none` without a mint, then the re-run mints', async () => {
		const ctx = setup();
		const { p, controller } = ctx;
		const ticket = await confirmedNone(ctx);
		const fallback = grantFallback(controller, p.provider, ticket, { kind: 'publicViewer' });

		p.change(); // the storage event arrived: a background probe starts
		p.statuses[0].resolve({ initialized: true, grants: { publicViewer: true } });
		await flush();
		expect(p.entries).toHaveLength(0); // no mint on a stale ticket
		p.none(ctx.last(), { clear: true });
		await flush();

		p.statuses[1].resolve({ initialized: true, grants: { publicViewer: true } });
		await flush();
		p.change();
		p.entries[0].answer.resolve({ success: true });
		await flush();
		p.active(ctx.last(), PUBLIC);

		await expect(fallback).resolves.toMatchObject({
			outcome: 'confirmed',
			snapshot: { kind: 'publicViewer' }
		});
	});

	for (const [maxRetries, rounds] of [
		[3, 4],
		[0, 1]
	] as const) {
		it(`S-20: a token that keeps reappearing: maxRetries = ${maxRetries} runs the policy ${rounds} time(s) (status() and resolveSettled ${rounds} each), then the last confirmed \`none\``, async () => {
			const ctx = setup();
			const { p, controller } = ctx;
			const ticket = await confirmedNone(ctx);
			const probesBefore = p.probes.length;
			const fallback = grantFallback(controller, p.provider, ticket, {
				kind: 'publicViewer',
				maxRetries
			});

			for (let round = 0; round < rounds; round++) {
				await flush();
				p.statuses[round].resolve({ initialized: true, grants: { publicViewer: true } });
				await flush();
				p.entries[round].answer.resolve({ success: false, superseded: true });
				await flush();
				p.none(ctx.last(), { clear: true });
			}

			await expect(fallback).resolves.toMatchObject({
				outcome: 'confirmed',
				snapshot: { status: 'none' }
			});
			expect(p.statuses).toHaveLength(rounds);
			expect(p.entries).toHaveLength(rounds);
			expect(p.probes.length - probesBefore).toBe(rounds);
		});
	}

	it('a failed mint (403 / network, not superseded) is not retried: the confirmed `none` stands', async () => {
		const ctx = setup();
		const { p, controller } = ctx;
		const ticket = await confirmedNone(ctx);
		const probes = p.probes.length;
		const fallback = grantFallback(controller, p.provider, ticket, { kind: 'publicViewer' });
		p.statuses[0].resolve({ initialized: true, grants: { publicViewer: true } });
		await flush();
		p.entries[0].answer.resolve({ success: false });

		await expect(fallback).resolves.toMatchObject({
			outcome: 'confirmed',
			snapshot: { status: 'none' }
		});
		expect(p.statuses).toHaveLength(1);
		expect(p.probes).toHaveLength(probes);
	});
});

describe('§4.8 `superseded` under a load (I-8, I-16)', () => {
	it('S-48: resolveSettled asks again after `superseded` and returns B’s generation', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const load = resolveSettled(controller, { cause: 'navigation' });
		p.change(); // B: hold
		await flush();
		p.active(p.probes.length - 1, BOB);
		const result = await load;
		expect(result).toMatchObject({ outcome: 'confirmed' });
		expect(result.snapshot.owner).toBe('account:bob');
		expect(result.snapshot.generation).toBe(controller.snapshot.generation);
	});

	it('S-49: past the deadline it is `unverified`, never a generation', async () => {
		const { p, controller, settleTo, scheduler } = setup();
		await settleTo(ALICE);
		const load = resolveSettled(controller, { deadlineMs: 5_000 });
		p.change();
		await flush();
		await scheduler.advance(5_000);
		const result = await load;
		expect(result.outcome).toBe('unverified');
		expect((result as { error: unknown }).error).toBeInstanceOf(SessionTimeoutError);
	});

	it('S-50: a result nobody uses does no harm - the state is whatever the latest confirmation decided', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		void resolveSettled(controller);
		p.change();
		await flush();
		p.active(p.probes.length - 1, BOB);
		await flush();
		expect(controller.snapshot.owner).toBe('account:bob');
	});
});

describe('§4.9 review scenarios (I-3, I-5, I-9, I-19, I-20)', () => {
	it('S-56: an old probe’s late rejection leaves B’s snapshot and verification untouched', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		void controller.resolve();
		p.change();
		p.active(2, BOB);
		await flush();
		const snapshot = controller.snapshot;
		const verification = snapshot.verification;
		p.fail(1);
		await flush();
		expect(controller.snapshot).toBe(snapshot);
		expect(controller.snapshot.verification).toBe(verification);
	});

	it('S-57: the very first request (epoch 0) is `confirmed` by its own commit, not superseded', async () => {
		const { p, controller } = setup();
		const request = controller.resolve();
		p.active(0, ALICE);
		const result = await request;
		expect(result.outcome).toBe('confirmed');
		expect(result.snapshot).toMatchObject({ generation: 1, owner: 'account:alice' });
	});

	it('S-58: resolve({cause: "signal"}) does not join the probe a signal() already started', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		controller.signal('stream-closed');
		const request = controller.resolve({ cause: 'signal' });
		expect(p.probes).toHaveLength(3);
		expect(p.probes[1].signal?.aborted).toBe(true);
		p.active(2, ALICE);
		await expect(request).resolves.toMatchObject({ outcome: 'confirmed' });
	});

	it('S-63: A must not stay active after a switch whose confirmation fails - reported or not', async () => {
		for (const reported of [true, false]) {
			const { p, controller, settleTo } = setup();
			await settleTo(ALICE);
			if (reported) {
				const pending = controller.resolve();
				p.change();
				await expect(pending).resolves.toMatchObject({ outcome: 'superseded' });
				p.fail(p.probes.length - 1);
				await flush();
			} else {
				p.bump(); // no onCredentialChanged: step 0 holds
				const request = controller.resolve();
				expect(controller.snapshot.status).toBe('unknown');
				p.fail(p.probes.length - 1);
				await expect(request).resolves.toMatchObject({ outcome: 'unverified' });
			}
			expect(controller.snapshot.status).toBe('unknown');
		}
	});

	it('S-63: a second change while held stays unknown with the same generation', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		p.change();
		const generation = controller.snapshot.generation;
		p.change();
		expect(controller.snapshot).toMatchObject({ status: 'unknown', generation });
	});

	it('S-65: an accepted `none` that cleared the credential commits once, without a hold', async () => {
		const { p, controller, settleTo, changes, onNone } = setup();
		await settleTo(ALICE);
		changes.length = 0;
		const request = controller.resolve();
		p.none(1, { clear: true });
		await expect(request).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(changes.map((c) => c.next.status)).toEqual(['none']);
		expect(onNone).toHaveBeenCalledTimes(1);
	});

	it('a StaleAnswerError is not a failure: verification unchanged, a new probe decides (S-75/S-77 path)', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const request = controller.resolve();
		p.fail(1, new StaleAnswerError());
		await flush();
		expect(controller.snapshot.verification.state).toBe('idle');
		expect(p.probes).toHaveLength(3);
		p.active(2, ALICE);
		await expect(request).resolves.toMatchObject({ outcome: 'confirmed' });
	});

	it('maxStaleRetries: answers that keep being stale end in `unverified` with SessionChangedError', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const request = controller.resolve();
		for (let i = 1; i <= 4; i++) {
			p.fail(i, new StaleAnswerError());
			await flush();
		}
		const result = await request;
		expect(result.outcome).toBe('unverified');
		expect((result as { error: unknown }).error).toBeInstanceOf(SessionChangedError);
		expect(p.probes).toHaveLength(5); // the first + 3 re-issues
	});
});

describe('re-confirmations and tickets (I-18)', () => {
	it('S-88: a pure re-confirmation keeps tickets current - two concurrent fallbacks do not livelock', async () => {
		const { p, controller } = setup();
		const first = controller.resolve();
		p.none(0);
		const confirmed = await first;
		if (confirmed.outcome !== 'confirmed') throw new Error('expected confirmed');
		const snapshot = controller.snapshot;
		const ticket = controller.ticket();
		// Another load re-confirms the same `none` while a policy awaits status().
		const again = controller.resolve();
		p.none(1);
		await expect(again).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.isCurrent(ticket)).toBe(true);
		expect(controller.snapshot).toBe(snapshot);
		// So the policy goes on with its ticket instead of starting over.
		const fallback = grantFallback(controller, p.provider, confirmed.ticket, {
			kind: 'publicViewer',
			maxRetries: 0
		});
		const other = controller.resolve();
		p.none(2);
		await other;
		p.statuses[0].resolve({ initialized: true, grants: { publicViewer: false } });
		await expect(fallback).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(p.probes).toHaveLength(3);
	});

	it('S-88: a re-confirmation after a failure only resets `verification`', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const failed = controller.resolve();
		p.fail(1);
		await failed;
		const ticket = controller.ticket();
		await settleTo(ALICE);
		expect(controller.snapshot.verification.state).toBe('idle');
		expect(controller.isCurrent(ticket)).toBe(true);
	});
});

// §10 decision (a) of 実装-2: a `seq` advance the provider had not observed.
describe('§10 (a) catch-up after an unobserved seq advance (I-3, I-5, I-23)', () => {
	it('S-84: a reloaded webview (observedSeq restarted) confirms without spending maxStaleRetries', async () => {
		// maxStaleRetries 0: any counted discard would end in SessionChangedError.
		const { p, controller } = setup({ revision: 0, deps: { maxStaleRetries: 0 } });
		const request = controller.resolve();
		// Rust's seq is 5: the answer is checked=5/current=5; the provider
		// observed it (max) before resolving.
		p.setRevision(5);
		p.active(0, ALICE, { checked: p.rev(5), current: p.rev(5) });
		await flush();
		expect(p.probes).toHaveLength(2); // one free catch-up probe
		expect(p.probes[1].checked).toBe(p.rev(5));
		p.active(1, ALICE);
		await expect(request).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot.owner).toBe('account:alice');
	});

	it('S-85: a data command cleared A in Rust (seq advanced unobserved): A is held first, then `none` - no retry spent', async () => {
		const { p, controller, settleTo } = setup({ revision: 1, deps: { maxStaleRetries: 0 } });
		await settleTo(ALICE);
		const request = controller.resolve();
		// The slot was cleared by another command (seq 1 -> 2) before this
		// probe read it: `none`, checked = current = 2.
		p.setRevision(2);
		p.none(1, { checked: p.rev(2), current: p.rev(2) });
		await flush();
		expect(controller.snapshot.status).toBe('unknown'); // I-5: held before the retry
		await expect(request).resolves.toMatchObject({ outcome: 'superseded' });
		p.none(p.probes.length - 1);
		await flush();
		expect(controller.snapshot.status).toBe('none');
		// Through resolveSettled the caller sees a confirmation, not an error.
		const settled = resolveSettled(controller);
		p.none(p.probes.length - 1);
		await expect(settled).resolves.toMatchObject({ outcome: 'confirmed' });
	});

	it('S-86: the catch-up is free only once per request - a revision that keeps moving still ends in SessionChangedError', async () => {
		const { p, controller } = setup({ revision: 0, deps: { maxStaleRetries: 1 } });
		const request = controller.resolve();
		for (let seq = 1; seq <= 3; seq++) {
			p.setRevision(seq);
			p.active(seq - 1, ALICE, { checked: p.rev(seq), current: p.rev(seq) });
			await flush();
		}
		const result = await request;
		expect(result.outcome).toBe('unverified');
		expect((result as { error: unknown }).error).toBeInstanceOf(SessionChangedError);
		expect(p.probes).toHaveLength(3); // 1 + free catch-up + 1 counted
	});
});

describe('§10 (a) one counting rule for replaced probes (P3-1)', () => {
	it('S-86: a signal replacing the probe does not count against maxStaleRetries', async () => {
		for (const replace of ['signal', 'credential change'] as const) {
			const { p, controller, settleTo } = setup({ deps: { maxStaleRetries: 0 } });
			await settleTo(null);
			const request = controller.resolve();
			const last = p.probes.length - 1;
			if (replace === 'signal') controller.signal('unauthorized');
			else p.change();
			expect(p.probes[last].signal?.aborted).toBe(true);
			p.active(p.probes.length - 1, ALICE);
			const result = await request;
			// A change while unknown/none is not a hold: the request is answered.
			expect(result.outcome).toBe('confirmed');
		}
	});

	it('S-86: the replacing probe inherits catchUpUsed - no second free catch-up after a signal', async () => {
		const { p, controller } = setup({ revision: 0, deps: { maxStaleRetries: 0 } });
		const request = controller.resolve();
		p.setRevision(5);
		p.active(0, ALICE, { checked: p.rev(5), current: p.rev(5) }); // the free catch-up
		await flush();
		expect(p.probes).toHaveLength(2);
		controller.signal('unauthorized'); // replaces probe #1, keeps catchUpUsed
		expect(p.probes).toHaveLength(3);
		p.setRevision(6);
		p.active(2, ALICE, { checked: p.rev(6), current: p.rev(6) }); // counted now
		const result = await request;
		expect(result.outcome).toBe('unverified');
		expect((result as { error: unknown }).error).toBeInstanceOf(SessionChangedError);
	});
});

// §10 decision (b) of 実装-2: providers that send no `kind`.
describe('§10 (b) the kind of an answer without `kind` (I-2, 統合修正 13)', () => {
	it('S-87: no kind -> account; the issuer’s publicViewer marker -> publicViewer; a provider kind is kept', async () => {
		const cases: [Parameters<ReturnType<typeof makeProbeProvider>['active']>, string, string][] = [
			[[0, ALICE], 'account', 'account:alice'],
			[[0, PUBLIC], 'publicViewer', 'publicViewer'],
			[[0, PUBLIC, { kind: 'account' }], 'publicViewer', 'publicViewer'],
			[[0, { id: 'op', name: 'op' }, { kind: 'local' }], 'local', 'local']
		];
		for (const [args, kind, owner] of cases) {
			const { p, controller } = setup();
			const request = controller.resolve();
			p.active(...args);
			await request;
			expect(controller.snapshot).toMatchObject({ kind, owner });
		}
	});

	it('S-87: an account and the public viewer with the same id never share an owner', () => {
		expect(sessionOwnerKey({ id: 'public', name: 'public' }, 'account')).toBe('account:public');
		expect(sessionOwnerKey({ id: 'public', name: 'public' })).toBe('account:public');
		expect(sessionOwnerKey(PUBLIC, 'publicViewer')).toBe('publicViewer');
	});
});

describe('switching the provider (owner review of #265 P1; I-1, I-18, I-20)', () => {
	async function aliceThenSwitch() {
		const ctx = setup();
		await ctx.settleTo(ALICE);
		const oldTicket = ctx.controller.ticket();
		const oldRequest = ctx.controller.resolve(); // pending on provider A
		const generation = ctx.controller.snapshot.generation;
		const b = makeProbeProvider({ revision: 1 }); // same revision string by chance
		controllerInternals(ctx.controller)!.bind(b.provider);
		return { ...ctx, b, oldTicket, oldRequest, generation };
	}

	it('S-89: provider A (Alice) -> provider B (none): unknown right away, old ticket stale, A’s late answer discarded, B decides', async () => {
		const { p, b, controller, oldTicket, oldRequest, generation } = await aliceThenSwitch();
		expect(controller.snapshot).toMatchObject({
			status: 'unknown',
			owner: null,
			generation: generation + 1,
			pendingOwnerChange: null,
			previousActiveOwner: null
		});
		expect(controller.isCurrent(oldTicket)).toBe(false);
		await expect(oldRequest).resolves.toMatchObject({ outcome: 'superseded' });
		expect(p.probes[1].signal?.aborted).toBe(true);
		expect(b.probes).toHaveLength(1); // the new provider is asked
		p.active(1, ALICE); // late answer from provider A
		await flush();
		expect(controller.snapshot.status).toBe('unknown');
		b.none(0);
		await flush();
		expect(controller.snapshot).toMatchObject({ status: 'none', generation: generation + 2 });
	});

	it('S-90: provider A (Alice) -> provider B (Bob): Bob is confirmed with no owner-change notice carried over', async () => {
		const { p, b, controller, generation } = await aliceThenSwitch();
		p.none(1, { clear: true }); // a late clearing answer from A changes nothing either
		await flush();
		expect(b.probes).toHaveLength(1);
		b.active(0, BOB);
		await flush();
		expect(controller.snapshot).toMatchObject({
			status: 'active',
			owner: 'account:bob',
			generation: generation + 2,
			pendingOwnerChange: null
		});
		p.change(); // provider A's notifications are no longer heard
		expect(controller.snapshot.owner).toBe('account:bob');
	});

	it('S-91: binding the same provider again is a no-op', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		const snapshot = controller.snapshot;
		const ticket = controller.ticket();
		controllerInternals(controller)!.bind(p.provider);
		expect(controller.snapshot).toBe(snapshot);
		expect(controller.isCurrent(ticket)).toBe(true);
		expect(p.probes).toHaveLength(1);
	});
});

describe('an ownerless active in between (owner review of #265 P2; S-10, I-24)', () => {
	it('S-92: A -> ownerless -> B raises { A -> B }', async () => {
		const { controller, settleTo } = setup();
		await settleTo(ALICE);
		await settleTo({ id: '', name: 'nobody' });
		expect(controller.snapshot.pendingOwnerChange).toBeNull();
		await settleTo(BOB);
		expect(controller.snapshot.pendingOwnerChange).toEqual({
			from: 'account:alice',
			to: 'account:bob'
		});
	});

	it('S-92: A -> ownerless -> A raises nothing; A -> B -> ownerless -> A drops the pending change', async () => {
		const { controller, settleTo } = setup();
		await settleTo(ALICE);
		await settleTo({ id: '', name: 'nobody' });
		await settleTo(ALICE);
		expect(controller.snapshot.pendingOwnerChange).toBeNull();
		await settleTo(BOB);
		await settleTo({ id: '', name: 'nobody' });
		expect(controller.snapshot.pendingOwnerChange).toEqual({
			from: 'account:alice',
			to: 'account:bob'
		});
		await settleTo(ALICE);
		expect(controller.snapshot.pendingOwnerChange).toBeNull();
	});
});

describe('the public viewer is not a user (S-93, I-24; independent audit of 実装-3 P2-1)', () => {
	it('S-93: none -> P (S-42) -> own login in the same tab (hold) -> A raises no pendingOwnerChange', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(null);
		await settleTo(PUBLIC);
		expect(controller.snapshot.owner).toBe('publicViewer');
		p.change(); // the login stored A's token (reported): hold
		expect(controller.snapshot.status).toBe('unknown');
		await settleTo(ALICE);
		expect(controller.snapshot).toMatchObject({ owner: 'account:alice', pendingOwnerChange: null });
		// A later real change of user is still reported from A, not from P.
		p.change();
		await settleTo(BOB);
		expect(controller.snapshot.pendingOwnerChange).toEqual({
			from: 'account:alice',
			to: 'account:bob'
		});
	});

	it('S-93: A -> none -> P raises nothing either (the reverse passes through none)', async () => {
		const { controller, settleTo } = setup();
		await settleTo(ALICE);
		await settleTo(null);
		await settleTo(PUBLIC);
		expect(controller.snapshot.pendingOwnerChange).toBeNull();
	});
});

describe('the auth-disabled local session is not a user (S-107, I-24; Issue #291)', () => {
	const LOCAL = { id: 'op', name: 'op', role: 'admin' } as const;
	async function settleLocal(
		ctx: ReturnType<typeof setup>,
		identity: { id: string; name: string; role: string } = LOCAL
	) {
		const request = ctx.controller.resolve();
		ctx.p.active(ctx.p.probes.length - 1, identity, { kind: 'local' });
		await request;
	}

	it('S-107: A -> local (enabling no-login) and local -> local (role change) raise nothing', async () => {
		const ctx = setup();
		await ctx.settleTo(ALICE);
		await settleLocal(ctx);
		expect(ctx.controller.snapshot).toMatchObject({
			kind: 'local',
			owner: 'local',
			pendingOwnerChange: null
		});
		await settleLocal(ctx, { id: 'op', name: 'op', role: 'viewer' });
		expect(ctx.controller.snapshot).toMatchObject({ owner: 'local', pendingOwnerChange: null });
	});

	it('S-107: a real change of user after local is still reported from the last real owner (A -> local -> B)', async () => {
		const ctx = setup();
		await ctx.settleTo(ALICE);
		await settleLocal(ctx);
		expect(ctx.controller.snapshot.pendingOwnerChange).toBeNull();
		// Not reachable in Tauri (enabling/disabling passes through none),
		// but if it happens A is compared with B, not local with B.
		ctx.p.change();
		const request = ctx.controller.resolve();
		ctx.p.active(ctx.p.probes.length - 1, BOB);
		await request;
		expect(ctx.controller.snapshot.pendingOwnerChange).toEqual({
			from: 'account:alice',
			to: 'account:bob'
		});
	});

	it('S-107: A -> local -> A raises nothing; none after local clears the history', async () => {
		const ctx = setup();
		await ctx.settleTo(ALICE);
		await settleLocal(ctx);
		await ctx.settleTo(ALICE);
		expect(ctx.controller.snapshot.pendingOwnerChange).toBeNull();
		await settleLocal(ctx);
		await ctx.settleTo(null);
		await ctx.settleTo(BOB);
		expect(ctx.controller.snapshot.pendingOwnerChange).toBeNull();
	});
});

describe('a non-account active is not a user (S-108, I-24; Issue #308)', () => {
	/** The credential changed and the provider now answers `identity` (a grant's `identity.kind` drives the kind). */
	async function answerAfterChange(ctx: ReturnType<typeof setup>, identity: typeof ALICE) {
		ctx.p.change();
		const request = ctx.controller.resolve();
		ctx.p.active(ctx.p.probes.length - 1, identity);
		await request;
	}

	it('S-108: A -> commissioning (a provider answer, no none) raises nothing; A -> commissioning -> A raises nothing', async () => {
		const ctx = setup();
		await ctx.settleTo(ALICE);
		await answerAfterChange(ctx, COMMISSIONING_GRANT);
		expect(ctx.controller.snapshot).toMatchObject({
			kind: 'commissioning',
			owner: 'commissioning',
			pendingOwnerChange: null
		});
		// The grant ends (a lock-down changed the credential) and the
		// confirmation answers A again: the same user, so nothing.
		await answerAfterChange(ctx, ALICE);
		expect(ctx.controller.snapshot.pendingOwnerChange).toBeNull();
	});

	it('S-108: commissioning -> A after a none in between raises nothing; no history is carried', async () => {
		const ctx = setup();
		await ctx.settleTo(ALICE);
		await answerAfterChange(ctx, COMMISSIONING_GRANT);
		ctx.p.change();
		await ctx.settleTo(null);
		await ctx.settleTo(BOB);
		expect(ctx.controller.snapshot.pendingOwnerChange).toBeNull();
	});

	it('S-108: commissioning -> B without a prior account raises nothing; commissioning -> commissioning raises nothing', async () => {
		const ctx = setup();
		await answerAfterChange(ctx, COMMISSIONING_GRANT);
		await answerAfterChange(ctx, COMMISSIONING_GRANT);
		expect(ctx.controller.snapshot.pendingOwnerChange).toBeNull();
		await answerAfterChange(ctx, BOB);
		expect(ctx.controller.snapshot.pendingOwnerChange).toBeNull();
	});

	it('S-108: a real account switch A -> B is still reported, and B -> commissioning -> A (no none) is {B -> A}', async () => {
		const ctx = setup();
		await ctx.settleTo(ALICE);
		ctx.p.change();
		const direct = ctx.controller.resolve();
		ctx.p.active(ctx.p.probes.length - 1, BOB);
		await direct;
		expect(ctx.controller.snapshot.pendingOwnerChange).toEqual({
			from: 'account:alice',
			to: 'account:bob'
		});
		ctx.controller.acknowledgeOwnerChange();
		// Commissioning followed by a user without a none: the last real
		// owner (B) is compared with A, not commissioning with A.
		ctx.p.change();
		const toCommissioning = ctx.controller.resolve();
		ctx.p.active(ctx.p.probes.length - 1, COMMISSIONING_GRANT);
		await toCommissioning;
		expect(ctx.controller.snapshot).toMatchObject({
			kind: 'commissioning',
			pendingOwnerChange: null
		});
		ctx.p.change();
		const toAlice = ctx.controller.resolve();
		ctx.p.active(ctx.p.probes.length - 1, ALICE);
		await toAlice;
		expect(ctx.controller.snapshot.pendingOwnerChange).toEqual({
			from: 'account:bob',
			to: 'account:alice'
		});
	});

	it('S-108: a provider answer without a kind is an account and is still compared', async () => {
		const ctx = setup();
		await ctx.settleTo(ALICE);
		ctx.p.change();
		const request = ctx.controller.resolve();
		ctx.p.active(ctx.p.probes.length - 1, BOB); // no `kind` in the answer
		await request;
		expect(ctx.controller.snapshot).toMatchObject({
			kind: 'account',
			pendingOwnerChange: { from: 'account:alice', to: 'account:bob' }
		});
	});
});

describe('owner changes (I-12, I-24) - controller side of S-76/S-81/S-83', () => {
	it('S-76: A -> none -> B raises no pendingOwnerChange; A -> unknown -> B does', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		await settleTo(null);
		await settleTo(BOB);
		expect(controller.snapshot.pendingOwnerChange).toBeNull();
		p.change();
		const request = controller.resolve();
		p.active(p.probes.length - 1, ALICE);
		await request;
		expect(controller.snapshot.pendingOwnerChange).toEqual({
			from: 'account:bob',
			to: 'account:alice'
		});
	});

	it('S-81: a re-confirmation of the same user keeps the pending change until acknowledged', async () => {
		const { p, controller, settleTo, changes } = setup();
		await settleTo(ALICE);
		p.change();
		p.active(p.probes.length - 1, BOB);
		await flush();
		await settleTo(BOB);
		expect(controller.snapshot.pendingOwnerChange).toEqual({
			from: 'account:alice',
			to: 'account:bob'
		});
		changes.length = 0;
		controller.acknowledgeOwnerChange();
		expect(controller.snapshot.pendingOwnerChange).toBeNull();
		controller.acknowledgeOwnerChange();
		expect(changes).toHaveLength(1); // no listener call for an unchanged snapshot
	});

	it('S-83: `none` discards the pending change; the next login raises none', async () => {
		const { p, controller, settleTo } = setup();
		await settleTo(ALICE);
		p.change();
		p.active(p.probes.length - 1, BOB);
		await flush();
		await settleTo(null);
		expect(controller.snapshot.pendingOwnerChange).toBeNull();
		await settleTo({ id: 'carol', name: 'Carol' });
		expect(controller.snapshot.pendingOwnerChange).toBeNull();
	});
});

// §3.1: one test per row. `epoch` is internal; tickets expose it, so each row
// also checks that a commit advanced the epoch (a ticket taken before it is
// no longer current) while the generation follows (status, owner, kind).
describe('§3.1 generation table (I-2)', () => {
	async function row(
		prepare: (ctx: ReturnType<typeof setup>) => Promise<void>,
		act: (ctx: ReturnType<typeof setup>) => Promise<void>,
		delta: number,
		commits = true
	) {
		const ctx = setup();
		await prepare(ctx);
		const generation = ctx.controller.snapshot.generation;
		const before = ctx.controller.ticket();
		await act(ctx);
		expect(ctx.controller.snapshot.generation - generation).toBe(delta);
		if (commits)
			expect({ epochMoved: before.epoch !== ctx.controller.ticket().epoch }).toEqual({
				epochMoved: true
			});
		else expect(ctx.controller.ticket().epoch).toBe(before.epoch);
	}
	const none = async (ctx: ReturnType<typeof setup>) => void (await ctx.settleTo(null));
	const alice = async (ctx: ReturnType<typeof setup>) => void (await ctx.settleTo(ALICE));

	it('unknown -> active(A): +1', () => row(async () => {}, alice, 1));
	// A pure re-confirmation is not a commit: the epoch stays too (S-88).
	it('active(A) -> active(A) (re-confirmation): 0', () => row(alice, alice, 0, false));
	it('active(A) -> active(owner null): +1', () =>
		row(alice, async (ctx) => void (await ctx.settleTo({ id: '', name: 'x' })), 1));
	it('active(A) -> active(B): +1', () =>
		row(alice, async (ctx) => void (await ctx.settleTo(BOB)), 1));
	it('active(A) -> unknown (hold): +1', () => row(alice, async (ctx) => ctx.p.change(), 1));
	it('unknown -> active(A) after a hold (same A): +1 (+2 with the hold)', async () => {
		const ctx = setup();
		await alice(ctx);
		const generation = ctx.controller.snapshot.generation;
		ctx.p.change();
		ctx.p.active(ctx.p.probes.length - 1, ALICE);
		await flush();
		expect(ctx.controller.snapshot.generation - generation).toBe(2);
	});
	it('unknown -> unknown (a second change while held): no commit', () =>
		row(
			async (ctx) => {
				await alice(ctx);
				ctx.p.change();
			},
			async (ctx) => ctx.p.change(),
			0,
			false
		));
	it('none learning of a credential change: no commit', async () => {
		await row(none, async (ctx) => ctx.p.change(), 0, false);
	});
	it('active(A) -> none: +1', () => row(alice, none, 1));
	it('none -> none: 0', () => row(none, none, 0, false));
	it('active(A) -> active(A) with a new display name: 0 (a commit)', () =>
		row(alice, async (ctx) => void (await ctx.settleTo({ ...ALICE, name: 'Alice 2' })), 0));
	it('none -> active(P): +1', () => row(none, async (ctx) => void (await ctx.settleTo(PUBLIC)), 1));
	it('none -> active(A) (after a none): +1', () => row(none, alice, 1));
	it('active(A, account) -> active(local): +1', () =>
		row(
			alice,
			async (ctx) => {
				const request = ctx.controller.resolve();
				ctx.p.active(ctx.p.probes.length - 1, { id: 'alice', name: 'Alice' }, { kind: 'local' });
				await request;
			},
			1
		));
});

describe('provider binding', () => {
	it('v2.0.0: a provider without resolve/credentialRevision/onCredentialChanged is rejected (no silent adapter)', () => {
		const legacy = {
			login: async () => ({ success: true }),
			logout: async () => {},
			check: vi.fn(async () => false),
			getIdentity: vi.fn(async () => null)
		};
		expect(() => createSessionController(legacy as unknown as AuthProvider)).toThrow(TypeError);
		expect(legacy.check).not.toHaveBeenCalled();
	});

	it('an explicitly adapted pre-v2 provider works (the adapter is the migration scaffold)', async () => {
		const check = vi.fn(async () => false);
		const controller = createSessionController(
			adaptLegacyAuthProvider({
				login: async () => ({ success: true }),
				logout: async () => {},
				check,
				getIdentity: async () => null
			}),
			{ onNone: vi.fn(), onActive: vi.fn() }
		);
		await expect(controller.resolve()).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot.status).toBe('none');
		expect(check).toHaveBeenCalledTimes(1);
	});

	it('a listener that throws does not stop the others', async () => {
		const { controller, settleTo } = setup();
		const seen = vi.fn();
		controller.subscribe(() => {
			throw new Error('broken');
		});
		controller.subscribe(seen);
		await settleTo(ALICE);
		expect(seen).toHaveBeenCalled();
	});

	it('never rejects: a provider whose resolve throws synchronously is `unverified`', async () => {
		const { p, controller } = setup();
		(p.provider.resolve as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error('sync');
		});
		await expect(controller.resolve()).resolves.toMatchObject({ outcome: 'unverified' });
		const pending = deferred<void>();
		pending.resolve();
	});
});
