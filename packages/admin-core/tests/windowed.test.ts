import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	defaultListBlockMessages,
	ListBlockError,
	type ListBlockErrorFailure
} from '../src/blockFetch';
import { ProviderError } from '../src/errors';
import { invalidate } from '../src/invalidate';
import type { DataProvider } from '../src/provider';
import { initBanto } from '../src/registry.svelte';
import { createWindowedListResource } from '../src/windowed.svelte';
import { STUB_SESSION } from './stubAuth';

interface Row {
	id: number;
	name: string;
}

const authProvider = {
	login: async () => ({ success: true }),
	logout: async () => {},
	...STUB_SESSION
};

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The blocks `failures` lists, in its order. */
function blocksOf(list: { failures: readonly ListBlockErrorFailure[] }): number[] {
	return list.failures.map((failure) => failure.block);
}

/** The error of the lowest failed block, `null` when there is none. */
function errorOf(list: { failures: readonly ListBlockErrorFailure[] }): ProviderError | null {
	return list.failures[0]?.error ?? null;
}

function makeDataset(count: number): Row[] {
	return Array.from({ length: count }, (_, i) => ({ id: i, name: `row-${i}` }));
}

/**
 * Controllable mock DataProvider: every `getList` call queues a manually
 * resolvable promise (recorded in `calls`) instead of resolving immediately,
 * so tests can force a specific resolution order.
 */
function createControllableProvider(datasetSize = 50) {
	const dataset = makeDataset(datasetSize);
	const calls: { offset: number; limit: number }[] = [];
	const resolvers: ((value: { rows: Row[]; totalCount: number }) => void)[] = [];
	const rejectors: ((reason: unknown) => void)[] = [];

	const provider: DataProvider = {
		getList: (_resource: string, params) =>
			new Promise((resolve, reject) => {
				const offset = params.pagination?.offset ?? 0;
				const limit = params.pagination?.limit ?? dataset.length;
				calls.push({ offset, limit });
				rejectors.push(reject);
				resolvers.push(resolve as (value: { rows: Row[]; totalCount: number }) => void);
			}),
		getOne: async () => {
			throw new Error('unused');
		},
		create: async () => {
			throw new Error('unused');
		},
		update: async () => {
			throw new Error('unused');
		},
		deleteOne: async () => {}
	};

	/** Resolve the call at `index` with a slice of the dataset matching its own offset/limit (or `overrideRows`/`overrideTotal` for custom responses). */
	function resolveCall(index: number, overrideRows?: Row[], overrideTotal?: number): void {
		const { offset, limit } = calls[index];
		const rows = overrideRows ?? dataset.slice(offset, offset + limit);
		resolvers[index]({ rows, totalCount: overrideTotal ?? dataset.length });
	}

	return {
		provider,
		calls,
		resolveCall,
		rejectCall: (index: number) => rejectors[index](new Error('Refresh failed')),
		/** Reject the call at `index` with exactly `reason`. */
		rejectCallWith: (index: number, reason: unknown) => rejectors[index](reason),
		dataset
	};
}

describe('createWindowedListResource', () => {
	it('dedups overlapping ensureRange calls: each covering block is fetched at most once', async () => {
		const { provider, calls, resolveCall } = createControllableProvider(50);
		initBanto({
			dataProvider: provider,
			authProvider,
			resources: [{ name: 'w-dedup', label: 'W' }]
		});

		const windowed = createWindowedListResource<Row>('w-dedup', { blockSize: 10 });

		// Blocks 0 (offset 0) and 1 (offset 10) requested by the first call...
		const first = windowed.ensureRange(0, 15);
		// ...and blocks 0, 1, 2 requested by a second, overlapping call made
		// before the first has resolved (marking-in-flight happens
		// synchronously, so only block 2/offset 20 is newly fetched here).
		const second = windowed.ensureRange(5, 25);

		expect(calls.map((c) => c.offset).sort((a, b) => a - b)).toEqual([0, 10, 20]);

		resolveCall(0);
		resolveCall(1);
		resolveCall(2);
		await Promise.all([first, second]);

		expect(windowed.totalCount).toBe(50);
		expect(windowed.rows.slice(0, 25)).toEqual(
			Array.from({ length: 25 }, (_, i) => ({ id: i, name: `row-${i}` }))
		);
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('setParams bumps the generation; an in-flight response from the old generation is dropped', async () => {
		const { provider, calls, resolveCall } = createControllableProvider(50);
		initBanto({ dataProvider: provider, authProvider, resources: [{ name: 'w-gen', label: 'W' }] });

		const windowed = createWindowedListResource<Row>('w-gen', { blockSize: 10 });

		const staleLoad = windowed.ensureRange(0, 10); // offset 0, call index 0 - left pending
		windowed.setParams({ sort: [{ field: 'name', direction: 'asc' }] }); // bumps generation, clears cache

		// The stale call's response arrives after the param change...
		resolveCall(0);
		await staleLoad;
		// ...and must not have written state: totalCount/rows are untouched
		// (still their post-setParams-reset values).
		expect(windowed.totalCount).toBe(0);
		expect(windowed.rows).toEqual([]);

		// A fresh ensureRange under the new generation fetches and writes normally.
		const freshLoad = windowed.ensureRange(0, 10); // call index 1
		resolveCall(1);
		await freshLoad;
		expect(windowed.totalCount).toBe(50);
		expect(windowed.rows.slice(0, 10)).toEqual(
			Array.from({ length: 10 }, (_, i) => ({ id: i, name: `row-${i}` }))
		);
		expect(calls).toHaveLength(2);
		windowed.dispose();
	});

	it('invalidate(resource) triggers refresh(), which re-fetches the last ensured range', async () => {
		const { provider, resolveCall } = createControllableProvider(50);
		initBanto({
			dataProvider: provider,
			authProvider,
			resources: [{ name: 'w-invalidate', label: 'W' }]
		});

		const windowed = createWindowedListResource<Row>('w-invalidate', { blockSize: 10 });
		const load = windowed.ensureRange(0, 10);
		resolveCall(0);
		await load;
		expect(windowed.rows[0]).toEqual({ id: 0, name: 'row-0' });

		invalidate('w-invalidate');
		await tick(); // let refresh()'s fire-and-forget ensureRange start

		// refresh() re-fetches the same [0, 10) range under a new generation.
		resolveCall(1, [{ id: 0, name: 'row-0-updated' }, ...makeDataset(9).slice(1)]);
		await tick();

		expect(windowed.rows[0]).toEqual({ id: 0, name: 'row-0-updated' });
		windowed.dispose();
	});

	it('totalCount is adopted from the first response and rows are written at their absolute offsets (sparse elsewhere)', async () => {
		const { provider, resolveCall } = createControllableProvider(30);
		initBanto({
			dataProvider: provider,
			authProvider,
			resources: [{ name: 'w-sparse', label: 'W' }]
		});

		const windowed = createWindowedListResource<Row>('w-sparse', { blockSize: 10 });
		expect(windowed.totalCount).toBe(0);

		// Only ensure the last block (offset 20); blocks 0/1 stay unloaded holes.
		const load = windowed.ensureRange(20, 30);
		resolveCall(0);
		await load;

		expect(windowed.totalCount).toBe(30);
		expect(windowed.rows).toHaveLength(30);
		expect(windowed.rows[0]).toBeUndefined();
		expect(windowed.rows[19]).toBeUndefined();
		expect(windowed.rows[20]).toEqual({ id: 20, name: 'row-20' });
		expect(windowed.rows[29]).toEqual({ id: 29, name: 'row-29' });
		windowed.dispose();
	});

	it('dispose stops further invalidate-triggered refreshes', async () => {
		const { provider, calls, resolveCall } = createControllableProvider(20);
		initBanto({
			dataProvider: provider,
			authProvider,
			resources: [{ name: 'w-dispose', label: 'W' }]
		});

		const windowed = createWindowedListResource<Row>('w-dispose', { blockSize: 10 });
		const load = windowed.ensureRange(0, 10);
		resolveCall(0);
		await load;
		windowed.dispose();

		invalidate('w-dispose');
		await tick();
		expect(calls).toHaveLength(1); // no refetch after dispose
	});
});

function setupRefresh(name: string, size = 6) {
	const controlled = createControllableProvider(size);
	initBanto({ dataProvider: controlled.provider, authProvider, resources: [{ name, label: 'W' }] });
	return { ...controlled, windowed: createWindowedListResource<Row>(name, { blockSize: 2 }) };
}

describe('atomic window refresh (#212)', () => {
	it('keeps the published snapshot and total until all refreshed blocks settle', async () => {
		const { windowed, resolveCall } = setupRefresh('w-atomic');
		const load = windowed.ensureRange(0, 6);
		resolveCall(0);
		resolveCall(1);
		resolveCall(2);
		await load;
		await windowed.ensureRange(0, 4);
		const previous = windowed.rows;
		const refresh = windowed.refresh();
		expect(windowed.rows).toBe(previous);
		// A deletion/reorder affects absolute offsets; old and new blocks must not mix.
		resolveCall(
			3,
			[
				{ id: 2, name: 'new-2' },
				{ id: 3, name: 'new-3' }
			],
			4
		);
		await tick();
		expect(windowed.rows).toBe(previous);
		expect(windowed.totalCount).toBe(6);
		expect(windowed.loading).toBe(true);
		resolveCall(
			4,
			[
				{ id: 4, name: 'new-4' },
				{ id: 5, name: 'new-5' }
			],
			4
		);
		await refresh;
		expect(windowed.rows.map((row) => row?.id)).toEqual([2, 3, 4, 5]);
		expect(windowed.totalCount).toBe(4);
		expect(windowed.rows).toHaveLength(4);
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('includes concurrent range requests in the same atomic publication', async () => {
		const { windowed, resolveCall, calls } = setupRefresh('w-atomic-concurrent');
		const load = windowed.ensureRange(0, 2);
		resolveCall(0);
		await load;
		const previous = windowed.rows;
		const refresh = windowed.refresh();
		const scroll = windowed.ensureRange(0, 4);
		expect(calls).toHaveLength(3);
		resolveCall(1, [{ id: 10, name: 'replacement' }]);
		await refresh;
		expect(windowed.rows).toBe(previous);
		expect(windowed.loading).toBe(true);
		resolveCall(2, [{ id: 12, name: 'new block' }]);
		await scroll;
		expect(windowed.rows[0]?.id).toBe(10);
		expect(windowed.rows[2]?.id).toBe(12);
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('setParams discards a staged refresh and immediately clears rows under the new params', async () => {
		const { windowed, resolveCall } = setupRefresh('w-atomic-params');
		const load = windowed.ensureRange(0, 2);
		resolveCall(0);
		await load;
		const refresh = windowed.refresh();
		windowed.setParams({ sort: [{ field: 'name', direction: 'desc' }] });
		expect(windowed.rows[0]).toBeUndefined();
		const sorted = windowed.ensureRange(0, 2);
		resolveCall(2, [{ id: 5, name: 'sorted' }]);
		await sorted;
		resolveCall(1, [{ id: 99, name: 'stale' }]);
		await refresh;
		expect(windowed.rows[0]?.id).toBe(5);
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('a newer refresh discards the older staged results and bookkeeping', async () => {
		const { windowed, resolveCall } = setupRefresh('w-atomic-generation');
		const load = windowed.ensureRange(0, 4);
		resolveCall(0);
		resolveCall(1);
		await load;
		const previous = windowed.rows;
		const first = windowed.refresh();
		resolveCall(2, [{ id: 99, name: 'stale first block' }]);
		await tick();
		const second = windowed.refresh();
		resolveCall(3, [{ id: 98, name: 'stale second block' }]);
		await first;
		expect(windowed.rows).toBe(previous);
		expect(windowed.loading).toBe(true);
		resolveCall(4, [{ id: 20, name: 'latest first block' }]);
		resolveCall(5, [{ id: 22, name: 'latest second block' }]);
		await second;
		expect(windowed.rows[0]?.id).toBe(20);
		expect(windowed.rows[2]?.id).toBe(22);
		windowed.dispose();
	});

	it('publishes successful refreshed blocks with holes for failures and permits retry', async () => {
		const { windowed, resolveCall, rejectCall } = setupRefresh('w-atomic-failure');
		const load = windowed.ensureRange(0, 4);
		resolveCall(0);
		resolveCall(1);
		await load;
		const previous = windowed.rows;
		const refresh = windowed.refresh();
		resolveCall(2, [{ id: 10, name: 'replacement' }]);
		await tick();
		expect(windowed.rows).toBe(previous);
		rejectCall(3);
		await refresh;
		expect(windowed.rows[0]?.id).toBe(10);
		expect(windowed.rows[2]).toBeUndefined();
		expect(errorOf(windowed)?.message).toContain('Refresh failed');
		expect(windowed.loading).toBe(false);
		const retry = windowed.ensureRange(2, 4);
		resolveCall(4, [{ id: 12, name: 'retried' }]);
		await retry;
		expect(windowed.rows[2]?.id).toBe(12);
		expect(windowed.failures).toEqual([]);
		windowed.dispose();
	});

	it('initial loads remain incremental even while another block is pending', async () => {
		const { windowed, resolveCall } = setupRefresh('w-atomic-initial');
		const load = windowed.ensureRange(0, 4);
		resolveCall(0);
		await tick();
		expect(windowed.rows[0]?.id).toBe(0);
		expect(windowed.rows[2]).toBeUndefined();
		expect(windowed.loading).toBe(true);
		resolveCall(1);
		await load;
		windowed.dispose();
	});

	it('a refresh before any ensureRange issues no request; after an empty range it re-reads block 0 (#243)', async () => {
		const { windowed, resolveCall, calls } = setupRefresh('w-atomic-empty');
		await windowed.refresh();
		expect(calls).toHaveLength(0);
		const load = windowed.ensureRange(0, 2);
		resolveCall(0);
		await load;
		await windowed.ensureRange(0, 0);
		const previous = windowed.rows;
		const refresh = windowed.refresh();
		// Before #243 this issued no request at all, so a list that had
		// collapsed to an empty window could never be re-read.
		expect(calls).toHaveLength(2);
		expect(calls[1].offset).toBe(0);
		expect(windowed.rows).toBe(previous);
		resolveCall(1, [{ id: 7, name: 'only row now' }], 1);
		await refresh;
		expect(windowed.rows).toEqual([{ id: 7, name: 'only row now' }]);
		expect(windowed.totalCount).toBe(1);
		windowed.dispose();
	});
});

function setupRecovery(name: string, size = 30, options: { requestTimeoutMs?: number } = {}) {
	const controlled = createControllableProvider(size);
	initBanto({ dataProvider: controlled.provider, authProvider, resources: [{ name, label: 'W' }] });
	return {
		...controlled,
		windowed: createWindowedListResource<Row>(name, { blockSize: 10, ...options })
	};
}

/**
 * Issue #243: failures are held per block, recovery (setParams/refresh) works
 * even when the visible range has collapsed to `{0, 0}`, and a request that
 * never answers cannot keep `loading` up forever.
 */
describe('failure state and recovery (#243)', () => {
	it('recovers from a failed first fetch: refresh() refetches block 0 although the grid now reports {0, 0}', async () => {
		const { windowed, calls, resolveCall, rejectCall } = setupRecovery('w243-first-failure');
		const first = windowed.ensureRange(0, 10);
		rejectCall(0);
		await first;
		expect(windowed.failures).not.toEqual([]);
		expect(windowed.loading).toBe(false);
		expect(windowed.totalCount).toBe(0);
		// totalCount 0 -> BantoGrid's virtual window is empty.
		await windowed.ensureRange(0, 0);
		const callsBeforeReload = calls.length;

		const reload = windowed.refresh();
		expect(calls.length).toBe(callsBeforeReload + 1);
		expect(calls.at(-1)?.offset).toBe(0);
		resolveCall(calls.length - 1);
		await reload;
		expect(windowed.totalCount).toBe(30);
		expect(windowed.rows[0]).toEqual({ id: 0, name: 'row-0' });
		expect(windowed.failures).toEqual([]);
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('an invalidate() after a failed first fetch also refetches block 0', async () => {
		const { windowed, calls, rejectCall } = setupRecovery('w243-first-failure-invalidate');
		const first = windowed.ensureRange(0, 10);
		rejectCall(0);
		await first;
		await windowed.ensureRange(0, 0);
		const callsBefore = calls.length;
		invalidate('w243-first-failure-invalidate');
		await tick();
		expect(calls.length).toBe(callsBefore + 1);
		expect(calls.at(-1)?.offset).toBe(0);
		windowed.dispose();
	});

	it('after a filter matched 0 rows, removing the filter fetches again (range {0, 0})', async () => {
		const { windowed, calls, resolveCall } = setupRecovery('w243-zero-rows');
		const first = windowed.ensureRange(0, 10);
		resolveCall(0, [], 0);
		await first;
		expect(windowed.totalCount).toBe(0);
		await windowed.ensureRange(0, 0); // the grid's empty window
		const callsBefore = calls.length;

		// Exactly what ItemsServerGrid's handleParamsChange does.
		windowed.setParams({ filters: [] });
		const reload = windowed.ensureRange(0, 0);
		expect(calls.length).toBe(callsBefore + 1);
		expect(calls.at(-1)?.offset).toBe(0);
		resolveCall(calls.length - 1);
		await reload;
		expect(windowed.totalCount).toBe(30);
		expect(windowed.rows[0]).toEqual({ id: 0, name: 'row-0' });
		windowed.dispose();
	});

	it('setParams alone refetches the last range (and block 0 when it is empty)', async () => {
		const { windowed, calls, resolveCall } = setupRecovery('w243-setparams-alone');
		const first = windowed.ensureRange(0, 10);
		resolveCall(0, [], 0);
		await first;
		await windowed.ensureRange(0, 0);
		const callsBefore = calls.length;
		windowed.setParams({ filters: [] });
		expect(calls.length).toBe(callsBefore + 1);
		expect(calls.at(-1)?.offset).toBe(0);
		windowed.dispose();
	});

	it('a refresh after 0 rows (e.g. from invalidate) fetches block 0', async () => {
		const { windowed, calls, resolveCall } = setupRecovery('w243-zero-rows-refresh');
		const first = windowed.ensureRange(0, 10);
		resolveCall(0, [], 0);
		await first;
		await windowed.ensureRange(0, 0);
		const callsBefore = calls.length;
		const reload = windowed.refresh();
		expect(calls.length).toBe(callsBefore + 1);
		resolveCall(calls.length - 1);
		await reload;
		expect(windowed.totalCount).toBe(30);
		windowed.dispose();
	});

	it("another block's success does not clear a block's failure", async () => {
		const { windowed, resolveCall, rejectCall } = setupRecovery('w243-per-block');
		const load = windowed.ensureRange(0, 20); // blocks 0 and 1
		rejectCall(0);
		await tick();
		resolveCall(1);
		await load;
		expect(windowed.failures).not.toEqual([]);
		expect(blocksOf(windowed)).toEqual([0]);
		expect(windowed.rows[10]).toEqual({ id: 10, name: 'row-10' });
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('a failure stays visible through refresh() until that block is fetched successfully', async () => {
		const { windowed, calls, resolveCall, rejectCall } = setupRecovery('w243-refresh-keeps');
		const load = windowed.ensureRange(0, 20);
		resolveCall(0);
		rejectCall(1);
		await load;
		expect(blocksOf(windowed)).toEqual([1]);

		const reload = windowed.refresh();
		expect(windowed.failures).not.toEqual([]); // kept while the retry is in flight
		const offsets = calls.slice(2).map((c) => c.offset);
		expect(offsets.sort((a, b) => a - b)).toEqual([0, 10]);
		resolveCall(2);
		resolveCall(3);
		await reload;
		expect(windowed.failures).toEqual([]);
		expect(blocksOf(windowed)).toEqual([]);
		windowed.dispose();
	});

	it('refresh() retries a failed block even when it is outside the last range', async () => {
		const { windowed, calls, resolveCall, rejectCall } = setupRecovery(
			'w243-refresh-retry-outside'
		);
		const far = windowed.ensureRange(20, 30); // block 2
		rejectCall(0);
		await far;
		const near = windowed.ensureRange(0, 10); // block 0
		resolveCall(1);
		await near;
		expect(blocksOf(windowed)).toEqual([2]);

		const reload = windowed.refresh();
		const offsets = calls.slice(2).map((c) => c.offset);
		expect(offsets.sort((a, b) => a - b)).toEqual([0, 20]);
		resolveCall(2);
		resolveCall(3);
		await reload;
		expect(blocksOf(windowed)).toEqual([]);
		expect(windowed.rows[20]).toEqual({ id: 20, name: 'row-20' });
		windowed.dispose();
	});

	it('setParams drops the failures of the previous query', async () => {
		const { windowed, rejectCall } = setupRecovery('w243-setparams-clears');
		const load = windowed.ensureRange(0, 10);
		rejectCall(0);
		await load;
		expect(windowed.failures).not.toEqual([]);
		windowed.setParams({ sort: [{ field: 'name', direction: 'desc' }] });
		expect(windowed.failures).toEqual([]);
		expect(blocksOf(windowed)).toEqual([]);
		windowed.dispose();
	});

	it('an empty range does not silently retry block 0 after it failed in this generation (no retry loop)', async () => {
		const { windowed, calls, rejectCall } = setupRecovery('w243-no-loop');
		const first = windowed.ensureRange(0, 10);
		rejectCall(0);
		await first;
		const callsBefore = calls.length;
		await windowed.ensureRange(0, 0);
		await windowed.ensureRange(0, 0);
		expect(calls.length).toBe(callsBefore);
		windowed.dispose();
	});

	it('a stale generation response after a failure is not adopted', async () => {
		const { windowed, calls, resolveCall, rejectCall } = setupRecovery('w243-stale');
		const first = windowed.ensureRange(0, 10);
		rejectCall(0);
		await first;
		const reloadA = windowed.refresh(); // call 1
		const reloadB = windowed.refresh(); // call 2, supersedes call 1
		expect(calls).toHaveLength(3);
		resolveCall(1, [{ id: 99, name: 'stale' }], 1);
		await reloadA;
		expect(windowed.rows[0]).toBeUndefined();
		expect(windowed.failures).not.toEqual([]);
		resolveCall(2);
		await reloadB;
		expect(windowed.rows[0]).toEqual({ id: 0, name: 'row-0' });
		expect(windowed.failures).toEqual([]);
		windowed.dispose();
	});
});

describe('synchronous provider failures (#243 review)', () => {
	function throwingProvider(onCall: () => void): DataProvider {
		return {
			getList: () => {
				onCall();
				throw new Error('sync boom');
			},
			getOne: async () => {
				throw new Error('unused');
			},
			create: async () => {
				throw new Error('unused');
			},
			update: async () => {
				throw new Error('unused');
			},
			deleteOne: async () => {}
		};
	}

	it('a getList that throws synchronously leaves no in-flight entry behind', async () => {
		let calls = 0;
		initBanto({
			dataProvider: throwingProvider(() => calls++),
			authProvider,
			resources: [{ name: 'w243-sync-throw', label: 'W' }]
		});
		const windowed = createWindowedListResource<Row>('w243-sync-throw', { blockSize: 10 });
		await windowed.ensureRange(0, 20);
		expect(calls).toBe(2);
		expect(windowed.loading).toBe(false);
		expect(blocksOf(windowed)).toEqual([0, 1]);
		expect(errorOf(windowed)?.message).toContain('sync boom');
		expect(windowed.failures.map((f) => f.code)).toEqual(['request', 'request']);

		// Recovery still works: the blocks are neither loaded nor in flight.
		await windowed.refresh();
		expect(calls).toBe(4);
		expect(windowed.loading).toBe(false);
		expect(blocksOf(windowed)).toEqual([0, 1]);
		windowed.dispose();
	});

	it('a synchronous throw during refresh() does not publish the staged snapshot early', async () => {
		const { windowed, resolveCall, provider } = setupRecovery('w243-sync-throw-refresh');
		const load = windowed.ensureRange(0, 20);
		resolveCall(0);
		resolveCall(1);
		await load;
		const previous = windowed.rows;
		// Block 0 throws synchronously, block 1 stays pending.
		const original = provider.getList;
		let first = true;
		provider.getList = ((resource, params) => {
			if (first) {
				first = false;
				throw new Error('sync boom');
			}
			return original(resource, params);
		}) as DataProvider['getList'];
		const reload = windowed.refresh();
		await tick();
		expect(windowed.rows).toBe(previous); // block 1 still in flight
		expect(windowed.loading).toBe(true);
		resolveCall(2);
		await reload;
		expect(windowed.loading).toBe(false);
		expect(blocksOf(windowed)).toEqual([0]);
		expect(windowed.rows[10]).toEqual({ id: 10, name: 'row-10' });
		windowed.dispose();
	});
});

describe('settlement cannot be skipped (#243 review)', () => {
	it('a throwing notifier still settles the block', async () => {
		const controlled = createControllableProvider(30);
		initBanto({
			dataProvider: controlled.provider,
			authProvider,
			notifier: {
				notify: () => {
					throw new Error('notifier broke');
				}
			},
			resources: [{ name: 'w243-throwing-notifier', label: 'W' }]
		});
		const windowed = createWindowedListResource<Row>('w243-throwing-notifier', { blockSize: 10 });
		const load = windowed.ensureRange(0, 10);
		controlled.rejectCall(0);
		await expect(load).resolves.toBeUndefined();
		expect(windowed.loading).toBe(false);
		expect(blocksOf(windowed)).toEqual([0]);
		windowed.dispose();
	});

	it('a malformed answer is recorded as a failure instead of throwing mid-write', async () => {
		const { windowed, calls, resolveCall } = setupRecovery('w243-malformed');
		const load = windowed.ensureRange(0, 10);
		resolveCall(0, undefined, -1);
		await load;
		expect(windowed.loading).toBe(false);
		expect(blocksOf(windowed)).toEqual([0]);
		expect(windowed.failures[0]?.code).toBe('malformed');
		expect(windowed.totalCount).toBe(0);
		// The generation still has no total count, so recovery reaches block 0.
		const reload = windowed.refresh();
		resolveCall(calls.length - 1);
		await reload;
		expect(windowed.totalCount).toBe(30);
		expect(blocksOf(windowed)).toEqual([]);
		windowed.dispose();
	});

	// #246 re-review: a count that passes a safe-integer check can still be
	// an impossible array length (the limit is 2 ** 32 - 1).
	it.each([
		['totalCount = 2 ** 32', 2 ** 32],
		['totalCount = 2 ** 53 - 1', Number.MAX_SAFE_INTEGER]
	])('an impossible array length (%s) is a failure, not a stuck load', async (_label, total) => {
		const { windowed, calls, resolveCall } = setupRecovery('w243-huge-count');
		const load = windowed.ensureRange(0, 10);
		resolveCall(0, [], total);
		await expect(load).resolves.toBeUndefined();
		expect(windowed.loading).toBe(false);
		expect(blocksOf(windowed)).toEqual([0]);
		expect(windowed.totalCount).toBe(0);
		// The published count stayed valid, so recovery (which sizes arrays
		// from it) works.
		const reload = windowed.refresh();
		resolveCall(calls.length - 1);
		await reload;
		expect(windowed.totalCount).toBe(30);
		expect(blocksOf(windowed)).toEqual([]);
		windowed.setParams({ filters: [] });
		expect(windowed.rows).toHaveLength(30);
		windowed.dispose();
	});

	it('rows that would extend past the array length limit are a failure', async () => {
		const { windowed, calls, resolveCall } = setupRecovery('w243-past-limit');
		// Block 429496729 starts at offset 4294967290; 10 rows would end at
		// 2 ** 32 + 4, past the 2 ** 32 - 1 limit.
		const load = windowed.ensureRange(4_294_967_290, 4_294_967_295);
		resolveCall(0, makeDataset(10), 5);
		await expect(load).resolves.toBeUndefined();
		expect(windowed.loading).toBe(false);
		expect(blocksOf(windowed)).toEqual([429_496_729]);
		expect(windowed.totalCount).toBe(0);
		const near = windowed.ensureRange(0, 10);
		resolveCall(calls.length - 1);
		await near;
		expect(windowed.totalCount).toBe(30);
		windowed.dispose();
	});
});

describe('request timeout (#243)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('a request that never answers fails after the timeout and loading goes down', async () => {
		vi.useFakeTimers();
		const { windowed, calls, resolveCall } = setupRecovery('w243-timeout', 30, {
			requestTimeoutMs: 1000
		});
		const load = windowed.ensureRange(0, 10);
		expect(windowed.loading).toBe(true);
		await vi.advanceTimersByTimeAsync(999);
		expect(windowed.loading).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		await load;
		expect(windowed.loading).toBe(false);
		expect(errorOf(windowed)?.message).toContain('timed out');
		expect(windowed.failures[0]?.code).toBe('timeout');
		expect(blocksOf(windowed)).toEqual([0]);

		// The late answer of the timed-out request is not adopted...
		resolveCall(0, [{ id: 99, name: 'late' }], 1);
		await vi.advanceTimersByTimeAsync(0);
		expect(windowed.rows[0]).toBeUndefined();
		expect(windowed.totalCount).toBe(0);

		// ...and refresh() recovers.
		const reload = windowed.refresh();
		expect(calls).toHaveLength(2);
		resolveCall(1);
		await reload;
		expect(windowed.rows[0]).toEqual({ id: 0, name: 'row-0' });
		expect(windowed.failures).toEqual([]);
		windowed.dispose();
	});

	it('has a default timeout of 30 s', async () => {
		vi.useFakeTimers();
		const { windowed } = setupRecovery('w243-timeout-default');
		const load = windowed.ensureRange(0, 10);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(windowed.loading).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		await load;
		expect(windowed.loading).toBe(false);
		expect(windowed.failures).not.toEqual([]);
		windowed.dispose();
	});

	it('refresh() while a request hangs lowers loading once the new generation settles', async () => {
		vi.useFakeTimers();
		const { windowed, calls, resolveCall } = setupRecovery('w243-timeout-refresh', 30, {
			requestTimeoutMs: 1000
		});
		void windowed.ensureRange(0, 10); // call 0 hangs
		const reload = windowed.refresh(); // call 1
		expect(calls).toHaveLength(2);
		resolveCall(1);
		await reload;
		expect(windowed.loading).toBe(false);
		await vi.advanceTimersByTimeAsync(1000); // call 0 times out: stale, ignored
		expect(windowed.loading).toBe(false);
		expect(windowed.failures).toEqual([]);
		windowed.dispose();
	});
});

/**
 * Issue #344: the failures say the same things as `SnapshotListResource`'s
 * after #342 - a code per kind, the provider's own `ProviderError` kept as
 * is, replaceable texts and a `notify` option - while `refresh()` keeps its
 * #212 behaviour (published rows stay until the generation settles).
 */
describe('failure codes, messages and notifications (#344)', () => {
	/** An app's own error type carrying more than a message. */
	class ReadoutError extends ProviderError {
		constructor(readonly readout: 'unavailable' | 'notRunning') {
			super({ kind: 'other', message: `readout ${readout}` });
		}
	}

	function setup(
		name: string,
		options: Parameters<typeof createWindowedListResource>[1] = {},
		size = 50
	) {
		const notified: string[] = [];
		const controlled = createControllableProvider(size);
		initBanto({
			dataProvider: controlled.provider,
			authProvider,
			notifier: { notify: (_kind, message) => notified.push(message) },
			resources: [{ name, label: 'W' }]
		});
		const windowed = createWindowedListResource<Row>(name, { blockSize: 10, ...options });
		return { ...controlled, notified, windowed };
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('keeps a ProviderError the provider throws as the same object, code request', async () => {
		const { windowed, resolveCall, rejectCallWith, notified } = setup('w344-identity');
		const load = windowed.ensureRange(0, 20);
		resolveCall(0);
		const thrown = new ReadoutError('unavailable');
		rejectCallWith(1, thrown);
		await load;
		expect(windowed.failures).toHaveLength(1);
		const failure = windowed.failures[0];
		expect(failure.block).toBe(1);
		expect(failure.kind).toBe('error');
		expect(failure.code).toBe('request');
		expect(failure.error).toBe(thrown);
		expect((failure.error as ReadoutError).readout).toBe('unavailable');
		expect(notified).toEqual(['readout unavailable']);
		windowed.dispose();
	});

	it('wraps anything else in ListBlockError(request) with the thrown value as cause', async () => {
		const { windowed, rejectCallWith } = setup('w344-wrap');
		const load = windowed.ensureRange(0, 10);
		const thrown = new TypeError('socket closed');
		rejectCallWith(0, thrown);
		await load;
		const error = errorOf(windowed);
		expect(error).toBeInstanceOf(ListBlockError);
		expect((error as ListBlockError).code).toBe('request');
		expect(error?.message).toBe('TypeError: socket closed');
		expect(error?.cause).toBe(thrown);
		expect(windowed.failures[0]?.code).toBe('request');
		windowed.dispose();
	});

	it('records a missing data provider (a synchronous throw) as request with cause', async () => {
		initBanto({
			dataProvider: undefined as unknown as DataProvider,
			authProvider,
			resources: [{ name: 'w344-no-provider', label: 'W' }]
		});
		const windowed = createWindowedListResource<Row>('w344-no-provider', { blockSize: 10 });
		await windowed.ensureRange(0, 10);
		expect(windowed.loading).toBe(false);
		expect(windowed.failures[0]?.code).toBe('request');
		expect(errorOf(windowed)?.cause).toBeInstanceOf(Error);
		windowed.dispose();
	});

	it('keeps the code of a ListBlockError the provider throws', async () => {
		const { windowed, rejectCallWith } = setup('w344-keep-code');
		const load = windowed.ensureRange(0, 10);
		const thrown = new ListBlockError('timeout', 'gave up');
		rejectCallWith(0, thrown);
		await load;
		expect(windowed.failures[0]?.code).toBe('timeout');
		expect(errorOf(windowed)).toBe(thrown);
		windowed.dispose();
	});

	it('records a timeout as ListBlockError(timeout) with the default text', async () => {
		vi.useFakeTimers();
		const { windowed, notified } = setup('w344-timeout-default', { requestTimeoutMs: 1000 });
		const load = windowed.ensureRange(0, 10);
		await vi.advanceTimersByTimeAsync(1000);
		await load;
		const error = errorOf(windowed);
		expect(windowed.failures[0]?.code).toBe('timeout');
		expect(error).toBeInstanceOf(ListBlockError);
		expect((error as ListBlockError).code).toBe('timeout');
		expect(error?.message).toBe(defaultListBlockMessages.timeout(1000));
		expect(error?.message).toBe('list request timed out after 1000 ms');
		expect(notified).toEqual(['list request timed out after 1000 ms']);
		windowed.dispose();
	});

	it('records a malformed answer as ListBlockError(malformed) with the default text', async () => {
		const { windowed, resolveCall } = setup('w344-malformed-default');
		const load = windowed.ensureRange(0, 10);
		resolveCall(0, 'nope' as unknown as Row[]);
		await load;
		const error = errorOf(windowed);
		expect(windowed.failures[0]?.code).toBe('malformed');
		expect(error).toBeInstanceOf(ListBlockError);
		expect(error?.message).toBe(defaultListBlockMessages.malformed());
		expect(error?.message).toBe('malformed list result');
		windowed.dispose();
	});

	it('uses the messages option for the failures it detects itself (timeout gets the ms)', async () => {
		vi.useFakeTimers();
		const timeoutCalls: number[] = [];
		const { windowed, resolveCall, notified } = setup('w344-messages', {
			requestTimeoutMs: 500,
			messages: {
				timeout: (ms) => {
					timeoutCalls.push(ms);
					return `timeout ${ms}`;
				},
				malformed: () => 'broken!'
			}
		});
		const load = windowed.ensureRange(0, 20);
		resolveCall(0, undefined, -1); // block 0: malformed
		await vi.advanceTimersByTimeAsync(500); // block 1: times out
		await load;
		expect(windowed.failures.map((f) => [f.block, f.code, f.error.message])).toEqual([
			[0, 'malformed', 'broken!'],
			[1, 'timeout', 'timeout 500']
		]);
		expect(timeoutCalls).toEqual([500]);
		expect(notified).toEqual(['broken!', 'timeout 500']);
		windowed.dispose();
	});

	it('falls back to the default text when a message function throws or returns a non-string', async () => {
		vi.useFakeTimers();
		const { windowed, resolveCall } = setup('w344-messages-broken', {
			requestTimeoutMs: 100,
			messages: {
				timeout: () => {
					throw new Error('i18n broke');
				},
				malformed: () => undefined as unknown as string
			}
		});
		const load = windowed.ensureRange(0, 20);
		resolveCall(0, undefined, -1);
		await vi.advanceTimersByTimeAsync(100);
		await load;
		expect(windowed.loading).toBe(false);
		expect(windowed.failures.map((f) => [f.code, f.error.message])).toEqual([
			['malformed', defaultListBlockMessages.malformed()],
			['timeout', defaultListBlockMessages.timeout(100)]
		]);
		windowed.dispose();
	});

	it('lists every failed block sorted by block, one entry each, cleared per block', async () => {
		const { windowed, calls, resolveCall, rejectCallWith } = setup('w344-sorted');
		const load = windowed.ensureRange(0, 50); // blocks 0..4 = calls 0..4
		resolveCall(0);
		await tick();
		// Settle out of block order: 4, 2, 1 (3 loads).
		rejectCallWith(4, new ReadoutError('unavailable'));
		await tick();
		rejectCallWith(2, new ProviderError({ kind: 'other', message: 'network down' }));
		await tick();
		rejectCallWith(1, new ReadoutError('notRunning'));
		resolveCall(3);
		await load;
		expect(windowed.failures.map((f) => [f.block, f.error.message])).toEqual([
			[1, 'readout notRunning'],
			[2, 'network down'],
			[4, 'readout unavailable']
		]);

		// A block that fails again keeps one entry, with the new error.
		const again = windowed.ensureRange(10, 20); // retries block 1 = call 5
		expect(calls).toHaveLength(6);
		const second = new ReadoutError('unavailable');
		rejectCallWith(5, second);
		await again;
		expect(blocksOf(windowed)).toEqual([1, 2, 4]);
		expect(windowed.failures[0]?.error).toBe(second);

		// Each block's success clears only its own failure.
		const retry2 = windowed.ensureRange(20, 30); // call 6
		resolveCall(6);
		await retry2;
		expect(blocksOf(windowed)).toEqual([1, 4]);
		const retry1 = windowed.ensureRange(10, 20); // call 7
		resolveCall(7);
		await retry1;
		expect(blocksOf(windowed)).toEqual([4]);
		windowed.dispose();
	});

	it('does not notify with notify: false, but still records the failure', async () => {
		const { windowed, rejectCallWith, notified } = setup('w344-notify-false', { notify: false });
		const load = windowed.ensureRange(0, 10);
		rejectCallWith(0, new ProviderError({ kind: 'other', message: 'quiet' }));
		await load;
		expect(notified).toEqual([]);
		expect(errorOf(windowed)?.message).toBe('quiet');
		windowed.dispose();
	});

	it('asks a notify predicate per failure; one that throws counts as no', async () => {
		const seen: ListBlockErrorFailure[] = [];
		const { windowed, resolveCall, rejectCallWith, notified } = setup('w344-notify-predicate', {
			notify: (failure) => {
				seen.push(failure);
				if (failure.block === 3) throw new Error('predicate broke');
				return failure.code !== 'malformed';
			}
		});
		const load = windowed.ensureRange(0, 40);
		resolveCall(0);
		rejectCallWith(1, new ProviderError({ kind: 'other', message: 'shown' }));
		await tick();
		resolveCall(2, 'nope' as unknown as Row[]);
		await tick();
		rejectCallWith(3, new ProviderError({ kind: 'other', message: 'predicate threw' }));
		await load;
		expect(seen.map((f) => [f.block, f.code])).toEqual([
			[1, 'request'],
			[2, 'malformed'],
			[3, 'request']
		]);
		expect(notified).toEqual(['shown']);
		expect(blocksOf(windowed)).toEqual([1, 2, 3]);
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('refresh() keeps the published rows while its failures update at once (#212)', async () => {
		const { windowed, resolveCall, rejectCallWith } = setup('w344-refresh-rows');
		const load = windowed.ensureRange(0, 30); // blocks 0..2 = calls 0..2
		resolveCall(0);
		resolveCall(1);
		const first = new ProviderError({ kind: 'other', message: 'first' });
		rejectCallWith(2, first);
		await load;
		const previous = windowed.rows;
		expect(blocksOf(windowed)).toEqual([2]);

		const reload = windowed.refresh(); // calls 3, 4, 5 for blocks 0, 1, 2
		// The old failure stays shown while its retry is in flight.
		expect(windowed.failures[0]?.error).toBe(first);
		const second = new ProviderError({ kind: 'other', message: 'second' });
		rejectCallWith(4, second); // block 1 fails in the new generation
		await tick();
		// Failures are published as they settle, rows are not.
		expect(windowed.rows).toBe(previous);
		expect(windowed.rows[10]).toEqual({ id: 10, name: 'row-10' });
		expect(windowed.loading).toBe(true);
		expect(windowed.failures.map((f) => [f.block, f.error.message])).toEqual([
			[1, 'second'],
			[2, 'first']
		]);
		resolveCall(5); // block 2 retried successfully
		await tick();
		expect(windowed.rows).toBe(previous);
		expect(blocksOf(windowed)).toEqual([1]);
		resolveCall(3, [{ id: 100, name: 'refreshed' }]);
		await reload;
		// The generation settled: its rows replace the old ones atomically,
		// the failed block is a hole.
		expect(windowed.rows).not.toBe(previous);
		expect(windowed.rows[0]).toEqual({ id: 100, name: 'refreshed' });
		expect(windowed.rows[10]).toBeUndefined();
		expect(windowed.rows[20]).toEqual({ id: 20, name: 'row-20' });
		expect(windowed.failures).toEqual([
			{ block: 1, kind: 'error', code: 'request', error: second }
		]);
		windowed.dispose();
	});
});
