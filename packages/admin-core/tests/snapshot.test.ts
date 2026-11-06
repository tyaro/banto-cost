/**
 * Table tests for `SnapshotListResource` (snapshot.svelte.ts, Issue #248).
 * A fake server keeps an append-only list (ids 1..n, newest first) and
 * answers each request only when the test says so, applying the boundary
 * the way `AuditLogService::list_as_of` does: `asOfId: null` picks the
 * newest id, rows and count come from `id <= asOfId`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../src/errors';
import type { DataProvider } from '../src/provider';
import { initBanto } from '../src/registry.svelte';
import { ListBlockError, type ListBlockErrorFailure } from '../src/blockFetch';
import {
	createSnapshotListResource,
	defaultSnapshotListMessages,
	type SnapshotListFailure,
	type SnapshotListRequest,
	type SnapshotListResult
} from '../src/snapshot.svelte';
import { STUB_SESSION } from './stubAuth';

interface Row {
	id: number;
}

const BLOCK = 10;

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Let every queued promise callback run (fake-timer safe). */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

interface Call {
	request: SnapshotListRequest;
	signal: AbortSignal;
	resolve: (value: SnapshotListResult<Row>) => void;
	reject: (reason: unknown) => void;
}

function createServer(initial: number, { epoch = true }: { epoch?: boolean } = {}) {
	let ids = Array.from({ length: initial }, (_, i) => i + 1);
	let nextId = initial + 1;
	// Ids handed out but not committed yet (a concurrent writer, PostgreSQL).
	const pending = new Set<number>();
	let deletionEpoch = 0;
	const calls: Call[] = [];

	const fetcher = vi.fn(
		(request: SnapshotListRequest, signal: AbortSignal) =>
			new Promise<SnapshotListResult<Row>>((resolve, reject) => {
				calls.push({ request, signal, resolve, reject });
			})
	);

	/** The server's answer to `request` against the data as it is now. */
	function respond(request: SnapshotListRequest): SnapshotListResult<Row> {
		const visible = ids.filter((id) => !pending.has(id));
		const boundary = request.asOfId ?? (visible.length > 0 ? Math.max(...visible) : 0);
		const minId = request.filters.find((f) => f.field === 'id' && f.op === 'gt')?.value as
			number | undefined;
		const set = ids
			.filter((id) => !pending.has(id) && id <= boundary && (minId === undefined || id > minId))
			.sort((a, b) => b - a);
		const { offset, limit } = request.pagination;
		return {
			rows: set.slice(offset, offset + limit).map((id) => ({ id })),
			totalCount: set.length,
			asOfId: boundary,
			...(epoch ? { deletionEpoch } : {})
		};
	}

	return {
		fetcher,
		calls,
		/** Answer call `index` from the current data (optionally overridden). */
		answer(index: number, override?: Partial<SnapshotListResult<Row>>): void {
			calls[index].resolve({ ...respond(calls[index].request), ...override });
		},
		fail(index: number, message = 'boom'): void {
			calls[index].reject(new ProviderError({ kind: 'other', message }));
		},
		/** Record `n` new entries (newest ids). */
		add(n: number): void {
			for (let i = 0; i < n; i++) ids.push(nextId++);
		},
		/** Retention prune: delete the `n` oldest committed entries. */
		pruneOldest(n: number): void {
			const oldest = ids
				.filter((id) => !pending.has(id))
				.sort((a, b) => a - b)
				.slice(0, n);
			ids = ids.filter((id) => !oldest.includes(id));
			if (oldest.length > 0) deletionEpoch++;
		},
		/** A writer takes the next id but has not committed. */
		begin(): number {
			const id = nextId++;
			ids.push(id);
			pending.add(id);
			return id;
		},
		commit(id: number): void {
			pending.delete(id);
		}
	};
}

/** The loaded ids, in index order (holes as `null`). */
function loadedIds(rows: (Row | undefined)[]): (number | null)[] {
	return Array.from({ length: rows.length }, (_, i) => rows[i]?.id ?? null);
}

function descending(from: number, count: number): number[] {
	return Array.from({ length: count }, (_, i) => from - i);
}

/** The blocks `failures` lists, in its order. */
function blocksOf(list: { failures: readonly SnapshotListFailure[] }): number[] {
	return list.failures.map((failure) => failure.block);
}

/** The lowest block's `'error'` failure, `null` when there is none. */
function errorFailureOf(list: {
	failures: readonly SnapshotListFailure[];
}): ListBlockErrorFailure | null {
	return (
		list.failures.find((failure): failure is ListBlockErrorFailure => failure.kind === 'error') ??
		null
	);
}

function errorOf(list: { failures: readonly SnapshotListFailure[] }): ProviderError | null {
	return errorFailureOf(list)?.error ?? null;
}

const notified: string[] = [];

beforeEach(() => {
	notified.length = 0;
	initBanto({
		dataProvider: {} as DataProvider,
		authProvider: {
			login: async () => ({ success: true }),
			logout: async () => {},
			...STUB_SESSION
		},
		notifier: { notify: (_kind, message) => notified.push(message) },
		resources: []
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe('SnapshotListResource: the boundary', () => {
	it('sends one request until the boundary is known, then pins it on every later block', async () => {
		const server = createServer(35);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });

		list.ensureRange(0, 40);
		expect(server.calls.map((c) => c.request.asOfId)).toEqual([null]);
		expect(server.calls[0].request.pagination).toEqual({ offset: 0, limit: BLOCK });
		expect(list.loading).toBe(true);
		expect(list.totalCount).toBeNull();

		server.answer(0);
		await tick();
		expect(list.asOfId).toBe(35);
		expect(list.totalCount).toBe(35);
		// Blocks 1..3 of the range (block 3 holds rows 30..34), all bounded.
		expect(
			server.calls.slice(1).map((c) => [c.request.pagination.offset, c.request.asOfId])
		).toEqual([
			[10, 35],
			[20, 35],
			[30, 35]
		]);
	});

	it('keeps the set when rows are added between blocks: no duplicate, no gap', async () => {
		const server = createServer(25);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 30);
		server.answer(0);
		await tick();

		server.add(3); // three entries recorded between the blocks
		server.answer(1);
		server.answer(2);
		await tick();

		expect(list.totalCount).toBe(25);
		expect(loadedIds(list.rows)).toEqual(descending(25, 25));
		expect(blocksOf(list)).toEqual([]);
		expect(list.expired).toBe(false);

		// The next generation takes the new rows in.
		list.refresh();
		expect(server.calls.at(-1)?.request.asOfId).toBeNull();
		server.answer(server.calls.length - 1);
		await tick();
		expect(list.totalCount).toBe(28);
		expect(list.asOfId).toBe(28);
		expect(list.rows[0]?.id).toBe(28);
	});

	it('expires the generation when rows are pruned between blocks, and refresh() reads again', async () => {
		const server = createServer(25);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 10);
		server.answer(0);
		await tick();
		expect(server.calls).toHaveLength(1);

		server.pruneOldest(4);
		list.ensureRange(10, 20);
		server.answer(1);
		await tick();

		expect(list.expired).toBe(true);
		expect(list.failures).toEqual([{ block: 1, kind: 'expired' }]);
		expect(loadedIds(list.rows).slice(10, 20)).toEqual(Array(10).fill(null));
		expect(notified).toEqual([]);

		// The generation fetches nothing more, whatever the range.
		list.ensureRange(20, 25);
		list.ensureRange(10, 20);
		expect(server.calls).toHaveLength(2);
		expect(list.loading).toBe(false);

		list.refresh();
		expect(list.expired).toBe(false);
		expect(server.calls).toHaveLength(3);
		server.answer(2);
		await tick();
		expect(list.totalCount).toBe(21);
		// Block 1 failed in the previous generation: requested again.
		expect(server.calls.slice(3).map((c) => c.request.pagination.offset)).toEqual([10]);
		server.answer(3);
		await tick();
		expect(blocksOf(list)).toEqual([]);
		expect(loadedIds(list.rows).slice(10, 20)).toEqual(descending(15, 10));
	});

	it.each([
		['with a deletion epoch: expires', true],
		['without one (count only): misses it', false]
	])('a late commit offset by a prune of the same size, %s', async (_name, epoch) => {
		// Issue #248 review: ids 1..3 committed, id 4 taken but not
		// committed, id 5 committed after it.
		const server = createServer(3, { epoch });
		const late = server.begin();
		server.add(1);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: 2 });
		list.ensureRange(0, 2);
		server.answer(0);
		await tick();
		expect(loadedIds(list.rows)).toEqual([5, 3, null, null]);

		// Id 4 commits (+1), another tab's read prunes id 1 (-1).
		server.commit(late);
		server.pruneOldest(1);
		list.ensureRange(2, 4);
		server.answer(1);
		await tick();

		expect(list.totalCount).toBe(4);
		if (epoch) {
			expect(list.expired).toBe(true);
			expect(loadedIds(list.rows)).toEqual([5, 3, null, null]);
		} else {
			// What the count alone lets through: row 3 twice.
			expect(list.expired).toBe(false);
			expect(loadedIds(list.rows)).toEqual([5, 3, 3, 2]);
		}
	});

	it('expires on a changed deletion epoch alone, and a late commit alone on the count', async () => {
		const server = createServer(6);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: 2 });
		list.ensureRange(0, 2);
		server.answer(0);
		await tick();
		list.ensureRange(2, 4);
		server.answer(1, { deletionEpoch: 7 });
		await tick();
		expect(list.expired).toBe(true);

		const lateServer = createServer(3);
		const late = lateServer.begin();
		lateServer.add(1);
		const lateList = createSnapshotListResource<Row>(lateServer.fetcher, { blockSize: 2 });
		lateList.ensureRange(0, 2);
		lateServer.answer(0);
		await tick();
		lateServer.commit(late);
		lateList.ensureRange(2, 4);
		lateServer.answer(1);
		await tick();
		expect(lateList.expired).toBe(true);
	});

	it('records an answer with another boundary as an error, not rows', async () => {
		const server = createServer(25);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 20);
		server.answer(0);
		await tick();
		server.answer(1, { asOfId: 99 });
		await tick();
		expect(errorOf(list)?.message).toBe(defaultSnapshotListMessages.boundaryMismatch());
		expect(errorFailureOf(list)?.code).toBe('boundaryMismatch');
		expect(blocksOf(list)).toEqual([1]);
		expect(list.expired).toBe(false);
		expect(list.rows[10]).toBeUndefined();
	});

	it('does not request blocks past the count', async () => {
		const server = createServer(12);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 100);
		server.answer(0);
		await tick();
		expect(server.calls.map((c) => c.request.pagination.offset)).toEqual([0, 10]);
	});
});

describe('SnapshotListResource: recovery', () => {
	it('recovers from a failed first fetch through refresh(), not by retrying on its own', async () => {
		const server = createServer(5);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 100);
		server.fail(0, 'server down');
		await tick();

		expect(list.totalCount).toBeNull();
		expect(blocksOf(list)).toEqual([0]);
		expect(errorOf(list)?.message).toBe('server down');
		expect(list.loading).toBe(false);
		expect(notified).toEqual(['server down']);

		// The grid reports {0, 0} while the count is unknown: no silent retry.
		list.ensureRange(0, 0);
		list.ensureRange(0, 100);
		expect(server.calls).toHaveLength(1);

		list.refresh();
		expect(server.calls).toHaveLength(2);
		expect(server.calls[1].request.pagination.offset).toBe(0);
		server.answer(1);
		await tick();
		expect(list.totalCount).toBe(5);
		expect(errorOf(list)).toBeNull();
		expect(blocksOf(list)).toEqual([]);
	});

	it('reaches the server from a 0-row result when the filter is cleared', async () => {
		const server = createServer(8);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 100);
		server.answer(0);
		await tick();

		list.setParams({ filters: [{ field: 'id', op: 'gt', value: 1000 }] });
		expect(list.totalCount).toBeNull();
		server.answer(1);
		await tick();
		expect(list.totalCount).toBe(0);
		expect(blocksOf(list)).toEqual([]);
		// A 0-row grid reports an empty window.
		list.ensureRange(0, 0);
		expect(server.calls).toHaveLength(2);

		list.setParams({ filters: [] });
		expect(server.calls).toHaveLength(3);
		expect(server.calls[2].request.asOfId).toBeNull();
		server.answer(2);
		await tick();
		expect(list.totalCount).toBe(8);
		expect(loadedIds(list.rows)).toEqual(descending(8, 8));
	});

	it('keeps a failure on its block until that block loads', async () => {
		const server = createServer(30);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 30);
		server.answer(0);
		await tick();
		server.fail(1, 'block 1 failed');
		server.answer(2);
		await tick();
		expect(blocksOf(list)).toEqual([1]);
		expect(errorOf(list)?.message).toBe('block 1 failed');

		// Out of the range now, but refresh() still retries it.
		list.ensureRange(0, 10);
		list.refresh();
		server.answer(3);
		await tick();
		expect(server.calls.slice(4).map((c) => c.request.pagination.offset)).toEqual([10]);
		expect(errorOf(list)?.message).toBe('block 1 failed');
		server.answer(4);
		await tick();
		expect(errorOf(list)).toBeNull();
		expect(blocksOf(list)).toEqual([]);
	});

	it('drops a failure past the new count after the list shrank', async () => {
		const server = createServer(30);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 30);
		server.answer(0);
		await tick();
		server.answer(1);
		server.fail(2);
		await tick();
		expect(blocksOf(list)).toEqual([2]);

		server.pruneOldest(15);
		list.refresh();
		server.answer(3);
		await tick();
		expect(list.totalCount).toBe(15);
		expect(blocksOf(list)).toEqual([]);
		expect(errorOf(list)).toBeNull();
	});
});

describe('SnapshotListResource: stale answers', () => {
	it.each([
		['refresh()', (list: { refresh(): void }) => list.refresh()],
		['setParams()', (list: { setParams(p: object): void }) => list.setParams({ sort: [] })]
	])('ignores an answer from before %s and aborts its request', async (_name, restart) => {
		const server = createServer(25);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 10);
		restart(list as never);
		expect(server.calls[0].signal.aborted).toBe(true);
		expect(server.calls).toHaveLength(2);

		server.add(5);
		server.answer(1);
		await tick();
		expect(list.asOfId).toBe(30);

		// The old request answers late with its own (older) view.
		server.calls[0].resolve({ rows: [{ id: -1 }], totalCount: 1, asOfId: 1 });
		await tick();
		expect(list.asOfId).toBe(30);
		expect(list.totalCount).toBe(30);
		expect(list.rows[0]?.id).toBe(30);
		expect(list.loading).toBe(false);
		expect(errorOf(list)).toBeNull();
		expect(blocksOf(list)).toEqual([]);
	});

	it('does not take a boundary from an answer of the previous generation', async () => {
		const server = createServer(25);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 10);
		list.refresh();
		server.add(5);

		// The superseded request answers first, before the new generation's.
		server.calls[0].resolve({ rows: [{ id: -1 }], totalCount: 1, asOfId: 1 });
		await tick();
		expect(list.asOfId).toBeNull();
		expect(list.totalCount).toBeNull();
		expect(list.loading).toBe(true);

		server.answer(1);
		await tick();
		expect(list.asOfId).toBe(30);
		expect(list.totalCount).toBe(30);
		expect(blocksOf(list)).toEqual([]);
	});

	it('ignores answers after dispose()', async () => {
		const server = createServer(5);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 10);
		list.dispose();
		expect(server.calls[0].signal.aborted).toBe(true);
		expect(list.loading).toBe(false);
		server.answer(0);
		await tick();
		expect(list.totalCount).toBeNull();
		list.refresh();
		list.ensureRange(0, 10);
		expect(server.calls).toHaveLength(1);
	});
});

describe('SnapshotListResource: requests that never answer', () => {
	it('fails a hung request after requestTimeoutMs and ignores its late answer', async () => {
		vi.useFakeTimers();
		const server = createServer(5);
		const list = createSnapshotListResource<Row>(server.fetcher, {
			blockSize: BLOCK,
			requestTimeoutMs: 1000
		});
		list.ensureRange(0, 10);
		await vi.advanceTimersByTimeAsync(999);
		expect(list.loading).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		await flush();
		expect(list.loading).toBe(false);
		expect(errorOf(list)?.message).toBe('list request timed out after 1000 ms');
		expect(errorFailureOf(list)?.code).toBe('timeout');
		expect(errorOf(list)).toBeInstanceOf(ListBlockError);
		expect(blocksOf(list)).toEqual([0]);
		expect(server.calls[0].signal.aborted).toBe(true);

		server.answer(0);
		await flush();
		expect(list.totalCount).toBeNull();

		list.refresh();
		server.answer(1);
		await flush();
		expect(list.totalCount).toBe(5);
		expect(errorOf(list)).toBeNull();
	});

	it('lets refresh() replace a hung request before the time limit', async () => {
		const server = createServer(5);
		const list = createSnapshotListResource<Row>(server.fetcher, {
			blockSize: BLOCK,
			requestTimeoutMs: 0
		});
		list.ensureRange(0, 10);
		expect(list.loading).toBe(true);
		list.refresh();
		expect(server.calls).toHaveLength(2);
		expect(server.calls[0].signal.aborted).toBe(true);
		server.answer(1);
		await tick();
		expect(list.loading).toBe(false);
		expect(list.totalCount).toBe(5);
	});
});

describe('SnapshotListResource: misbehaving fetchers', () => {
	it('records a synchronous throw as the block failure without throwing', async () => {
		const fetcher = vi.fn(() => {
			throw new Error('sync boom');
		});
		const list = createSnapshotListResource<Row>(fetcher, { blockSize: BLOCK });
		expect(() => list.ensureRange(0, 10)).not.toThrow();
		expect(list.loading).toBe(true);
		await tick();
		expect(list.loading).toBe(false);
		expect(errorOf(list)?.message).toBe('Error: sync boom');
		expect(errorFailureOf(list)?.code).toBe('request');
		// Not a ProviderError: wrapped, with the thrown value kept as `cause`.
		const error = errorOf(list);
		expect(error).toBeInstanceOf(ListBlockError);
		expect((error as ListBlockError).code).toBe('request');
		expect((error?.cause as Error).message).toBe('sync boom');
		expect(blocksOf(list)).toEqual([0]);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it.each([
		['a count beyond the array-length limit', { totalCount: 2 ** 32 }],
		['a negative count', { totalCount: -1 }],
		['a fractional count', { totalCount: 1.5 }],
		['rows that are not an array', { rows: 'nope' as unknown as Row[] }],
		['a missing boundary', { asOfId: undefined as unknown as number }],
		['a boundary that is not a safe integer', { asOfId: 2 ** 53 }],
		['a deletion epoch that is not a safe integer', { deletionEpoch: 1.5 }]
	])('records %s as malformed', async (_name, override) => {
		const server = createServer(5);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 10);
		server.answer(0, override);
		await tick();
		expect(errorOf(list)?.message).toBe('malformed list result');
		expect(errorFailureOf(list)?.code).toBe('malformed');
		expect(list.totalCount).toBeNull();
		expect(list.loading).toBe(false);
	});

	it('keeps going when the notifier throws', async () => {
		initBanto({
			dataProvider: {} as DataProvider,
			authProvider: {
				login: async () => ({ success: true }),
				logout: async () => {},
				...STUB_SESSION
			},
			notifier: {
				notify: () => {
					throw new Error('toast broke');
				}
			},
			resources: []
		});
		const server = createServer(30);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 30);
		server.answer(0);
		await tick();
		server.fail(1);
		await tick();
		expect(list.loading).toBe(true); // block 2 is still in flight
		server.answer(2);
		await tick();
		expect(list.loading).toBe(false);
		expect(blocksOf(list)).toEqual([1]);
	});
});

describe('SnapshotListResource: before the first ensureRange()', () => {
	it('makes no request from setParams()/refresh() and starts with the given params', () => {
		const server = createServer(5);
		const list = createSnapshotListResource<Row>(server.fetcher, {
			blockSize: BLOCK,
			params: { sort: [{ field: 'ts', direction: 'desc' }] }
		});
		list.refresh();
		list.setParams({ filters: [] });
		expect(server.calls).toHaveLength(0);
		list.ensureRange(0, 10);
		expect(server.calls[0].request.sort).toEqual([{ field: 'ts', direction: 'desc' }]);
	});
});

describe('SnapshotListResource: failure codes, messages and notifications (#342)', () => {
	/** A fetcher's own error type carrying more than a message (ChronoGazer's `Readout`). */
	class ReadoutError extends ProviderError {
		constructor(readonly readout: 'unavailable' | 'notRunning') {
			super({ kind: 'other', message: `readout ${readout}` });
		}
	}

	it('keeps a ProviderError the fetcher throws as the same object, code request', async () => {
		const server = createServer(30);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 30);
		server.answer(0);
		await tick();
		const thrown = new ReadoutError('unavailable');
		server.calls[1].reject(thrown);
		server.answer(2);
		await tick();
		const failure = errorFailureOf(list);
		expect(failure?.block).toBe(1);
		expect(failure?.code).toBe('request');
		expect(failure?.error).toBe(thrown);
		expect((failure?.error as ReadoutError).readout).toBe('unavailable');
		expect(notified).toEqual(['readout unavailable']);
	});

	it('keeps the code of a ListBlockError the fetcher throws', async () => {
		const server = createServer(5);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 10);
		const thrown = new ListBlockError('timeout', 'gave up');
		server.calls[0].reject(thrown);
		await tick();
		expect(errorFailureOf(list)?.code).toBe('timeout');
		expect(errorOf(list)).toBe(thrown);
	});

	it('uses the messages option for the failures it detects itself', async () => {
		vi.useFakeTimers();
		const timeoutCalls: number[] = [];
		const server = createServer(30);
		const list = createSnapshotListResource<Row>(server.fetcher, {
			blockSize: BLOCK,
			requestTimeoutMs: 500,
			messages: {
				timeout: (ms) => {
					timeoutCalls.push(ms);
					return `timeout ${ms}`;
				},
				boundaryMismatch: () => 'mismatch!',
				malformed: () => 'broken!'
			}
		});
		list.ensureRange(0, 30);
		server.answer(0);
		await flush();
		server.answer(1, { asOfId: 99 });
		server.answer(2, { rows: 'nope' as unknown as Row[] });
		await flush();
		expect(
			list.failures.map((f) => (f.kind === 'error' ? [f.code, f.error.message] : f.kind))
		).toEqual([
			['boundaryMismatch', 'mismatch!'],
			['malformed', 'broken!']
		]);

		list.setParams({ sort: [] });
		await vi.advanceTimersByTimeAsync(500);
		await flush();
		expect(errorFailureOf(list)?.code).toBe('timeout');
		expect(errorOf(list)?.message).toBe('timeout 500');
		expect(timeoutCalls).toEqual([500]);
		expect(notified).toEqual(['mismatch!', 'broken!', 'timeout 500']);
	});

	it('falls back to the default text when a message function throws, and still settles', async () => {
		vi.useFakeTimers();
		const server = createServer(5);
		const list = createSnapshotListResource<Row>(server.fetcher, {
			blockSize: BLOCK,
			requestTimeoutMs: 100,
			messages: {
				timeout: () => {
					throw new Error('i18n broke');
				}
			}
		});
		list.ensureRange(0, 10);
		await vi.advanceTimersByTimeAsync(100);
		await flush();
		expect(list.loading).toBe(false);
		expect(errorFailureOf(list)?.code).toBe('timeout');
		expect(errorOf(list)?.message).toBe(defaultSnapshotListMessages.timeout(100));
	});

	it('lists every failed block sorted by block, mixed kinds, each cleared when its block loads', async () => {
		const server = createServer(50);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 50);
		server.answer(0);
		await tick();
		// Settle out of block order: 4, 2, 1 (3 loads).
		server.calls[4].reject(new ReadoutError('unavailable'));
		await tick();
		server.fail(2, 'network down');
		await tick();
		server.calls[1].reject(new ReadoutError('notRunning'));
		server.answer(3);
		await tick();
		expect(
			list.failures.map((f) => [f.block, f.kind === 'error' ? f.error.message : f.kind])
		).toEqual([
			[1, 'readout notRunning'],
			[2, 'network down'],
			[4, 'readout unavailable']
		]);
		// The lowest block of each kind, as /events shows them side by side.
		const readout = list.failures.find(
			(f) => f.kind === 'error' && f.error instanceof ReadoutError
		);
		const transport = list.failures.find(
			(f) => f.kind === 'error' && !(f.error instanceof ReadoutError)
		);
		expect([readout?.block, transport?.block]).toEqual([1, 2]);

		list.refresh();
		server.answer(5); // block 0, new generation
		await tick();
		// The new generation reads the range again; 2 (and 3) load first.
		expect(server.calls.slice(6).map((c) => c.request.pagination.offset)).toEqual([10, 20, 30, 40]);
		server.answer(7);
		server.answer(8);
		await tick();
		expect(blocksOf(list)).toEqual([1, 4]);
		server.answer(6);
		server.answer(9);
		await tick();
		expect(list.failures).toEqual([]);
	});

	it('includes an expiry next to request failures', async () => {
		const server = createServer(30);
		const list = createSnapshotListResource<Row>(server.fetcher, { blockSize: BLOCK });
		list.ensureRange(0, 30);
		server.answer(0);
		await tick();
		server.fail(1, 'block 1 failed');
		await tick();
		server.pruneOldest(1);
		server.answer(2);
		await tick();
		expect(list.failures).toEqual([
			{ block: 1, kind: 'error', code: 'request', error: expect.any(ProviderError) },
			{ block: 2, kind: 'expired' }
		]);
		expect(list.expired).toBe(true);
		expect(notified).toEqual(['block 1 failed']);
	});

	it('does not notify with notify: false, but still records the failure', async () => {
		const server = createServer(5);
		const list = createSnapshotListResource<Row>(server.fetcher, {
			blockSize: BLOCK,
			notify: false
		});
		list.ensureRange(0, 10);
		server.fail(0, 'quiet');
		await tick();
		expect(notified).toEqual([]);
		expect(errorOf(list)?.message).toBe('quiet');
	});

	it('asks a notify predicate per failure; one that throws counts as no', async () => {
		const seen: ListBlockErrorFailure[] = [];
		const server = createServer(40);
		const list = createSnapshotListResource<Row>(server.fetcher, {
			blockSize: BLOCK,
			notify: (failure) => {
				seen.push(failure);
				if (failure.block === 3) throw new Error('predicate broke');
				return failure.code !== 'boundaryMismatch';
			}
		});
		list.ensureRange(0, 40);
		server.answer(0);
		await tick();
		server.fail(1, 'shown');
		server.answer(2, { asOfId: 99 });
		server.fail(3, 'predicate threw');
		await tick();
		expect(seen.map((f) => [f.block, f.code])).toEqual([
			[1, 'request'],
			[2, 'boundaryMismatch'],
			[3, 'request']
		]);
		expect(notified).toEqual(['shown']);
		expect(blocksOf(list)).toEqual([1, 2, 3]);
		expect(list.loading).toBe(false);
	});
});
