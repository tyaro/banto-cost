/**
 * Issue #289: a reconnected change stream cannot recover what was broadcast
 * while it was down (no history replay), so `connectEvents` re-reads every
 * subscribed resource once per successful reconnect.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, createSseEventProvider, type EventProvider } from '../src/events';
import { onInvalidate } from '../src/invalidate';
import { createListResource } from '../src/list.svelte';
import { createWindowedListResource } from '../src/windowed.svelte';
import { initBanto } from '../src/registry.svelte';
import type { AuthProvider, DataProvider } from '../src/provider';
import {
	getSessionController,
	resetDefaultSessionController,
	resolveSettled
} from '../src/sessionController.svelte';
import { ALICE, flush, makeProbeProvider } from './sessionHarness';
import { STUB_SESSION } from './stubAuth';

function endedStream(): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				c.close();
			}
		})
	);
}

function countingDataProvider(): { dp: DataProvider; calls: () => number } {
	let n = 0;
	const dp: DataProvider = {
		getList: async () => {
			n++;
			return { rows: [{ id: 1 }], totalCount: 1 } as never;
		},
		getOne: async () => ({}) as never,
		create: async () => ({}) as never,
		update: async () => ({}) as never,
		deleteOne: async () => {}
	};
	return { dp, calls: () => n };
}

function initWith(dataProvider: DataProvider): void {
	const authProvider: AuthProvider = {
		login: async () => ({ success: true }),
		logout: async () => {},
		...STUB_SESSION
	};
	initBanto({ dataProvider, authProvider, resources: [] });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SSE provider: onReconnected', () => {
	it('fires on a later successful connect, never the first (Issue #289 steps)', async () => {
		const fetchFn = vi.fn(() => Promise.resolve(endedStream()));
		const onReconnected = vi.fn();
		const provider = createSseEventProvider({
			getToken: () => 'tok',
			fetchFn,
			reconnectDelayMs: 5
		});
		const unsub = provider.subscribe(vi.fn(), { onReconnected });
		await vi.waitFor(() => expect(onReconnected).toHaveBeenCalled());
		unsub();
		// one call per successful connect after the first, never more
		expect(onReconnected.mock.calls.length).toBeLessThanOrEqual(fetchFn.mock.calls.length - 1);
	});

	it('fires nothing for failed attempts', async () => {
		let n = 0;
		const fetchFn = vi.fn(() => {
			n++;
			if (n === 1) return Promise.resolve(endedStream());
			return Promise.reject(new TypeError('Failed to fetch'));
		});
		const onReconnected = vi.fn();
		const provider = createSseEventProvider({
			getToken: () => 'tok',
			fetchFn,
			reconnectDelayMs: 5
		});
		const unsub = provider.subscribe(vi.fn(), { onReconnected });
		await vi.waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(4));
		unsub();
		expect(onReconnected).not.toHaveBeenCalled();
	});

	it('does not fire for the first connect of a new login after a 401', async () => {
		let token = 'a';
		let n = 0;
		const fetchFn = vi.fn(() => {
			n++;
			if (n === 1) return Promise.resolve(endedStream());
			if (n === 2) return Promise.resolve(new Response(null, { status: 401 }));
			// 3rd = first connect of the new token; keep it open so no 4th happens
			return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start() {} })));
		});
		const onReconnected = vi.fn();
		const onUnauthorized = vi.fn(() => {
			token = 'b';
		});
		const provider = createSseEventProvider({
			getToken: () => token,
			fetchFn,
			reconnectDelayMs: 5,
			tokenWaitDelayMs: 5
		});
		const unsub = provider.subscribe(vi.fn(), { onReconnected, onUnauthorized });
		await vi.waitFor(() => expect(fetchFn.mock.calls.length).toBe(3));
		await sleep(40);
		unsub();
		expect(fetchFn.mock.calls.length).toBe(3);
		expect(onReconnected).not.toHaveBeenCalled();
	});

	it('does not fire when the token changed while the connect was in flight', async () => {
		let token = 'a';
		let n = 0;
		const fetchFn = vi.fn(() => {
			n++;
			if (n === 2) token = 'b'; // logout / user switch during the fetch
			if (n >= 3) return Promise.resolve(new Response(new ReadableStream({ start() {} })));
			return Promise.resolve(endedStream());
		});
		const onReconnected = vi.fn();
		const provider = createSseEventProvider({
			getToken: () => token,
			fetchFn,
			reconnectDelayMs: 5
		});
		const unsub = provider.subscribe(vi.fn(), { onReconnected });
		await vi.waitFor(() => expect(fetchFn.mock.calls.length).toBe(3));
		await sleep(40);
		unsub();
		expect(onReconnected).not.toHaveBeenCalled();
	});
});

describe('connectEvents: re-sync after reconnect (Issue #289)', () => {
	beforeEach(() => {
		resetDefaultSessionController();
	});

	function capture(): { fire: () => void; provider: EventProvider } {
		let hook: (() => void) | undefined;
		return {
			fire: () => hook?.(),
			provider: {
				subscribe: (_h, hooks) => {
					hook = hooks?.onReconnected;
					return vi.fn();
				}
			}
		};
	}

	it('invalidates each subscribed resource exactly once per reconnect', () => {
		initWith(countingDataProvider().dp);
		const items = vi.fn();
		const users = vi.fn();
		const off = [onInvalidate('rs-items', items), onInvalidate('rs-users', users)];
		const { fire, provider } = capture();
		connectEvents(provider);

		fire();
		expect(items).toHaveBeenCalledTimes(1);
		expect(users).toHaveBeenCalledTimes(1);
		fire();
		expect(items).toHaveBeenCalledTimes(2);
		expect(users).toHaveBeenCalledTimes(2);
		off.forEach((f) => f());
	});

	it('notifies subscribers with reason resync on reconnect', () => {
		initWith(countingDataProvider().dp);
		const cb = vi.fn();
		const off = onInvalidate('rs-reason', cb);
		const { fire, provider } = capture();
		connectEvents(provider);
		fire();
		expect(cb).toHaveBeenCalledWith('rs-reason', 'resync');
		off();
	});

	it('refetches a list and a windowed list once each', async () => {
		const { dp, calls } = countingDataProvider();
		initWith(dp);
		const list = createListResource('rs-list');
		const win = createWindowedListResource('rs-win');
		await list.load();
		await win.ensureRange(0, 10);
		const before = calls();
		const { fire, provider } = capture();
		connectEvents(provider);

		fire();
		await vi.waitFor(() => expect(calls()).toBe(before + 2));
		await sleep(20);
		expect(calls()).toBe(before + 2);
		list.dispose();
		win.dispose();
	});

	it('does not refetch once the session has ended (logout overlapping a reconnect)', async () => {
		const p = makeProbeProvider();
		initBanto({ dataProvider: {} as DataProvider, authProvider: p.provider, resources: [] });
		const first = resolveSettled(getSessionController());
		p.active(0, ALICE);
		await first;
		const cb = vi.fn();
		const off = onInvalidate('rs-ended', cb);
		const { fire, provider } = capture();
		connectEvents(provider);

		fire();
		expect(cb).toHaveBeenCalledTimes(1);

		getSessionController().signal('unauthorized');
		p.none(1, { clear: true });
		await flush();
		expect(getSessionController().snapshot.status).toBe('none');
		fire();
		expect(cb).toHaveBeenCalledTimes(1);
		off();
	});
});
