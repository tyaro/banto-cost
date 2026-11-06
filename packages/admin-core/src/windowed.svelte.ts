/**
 * `createWindowedListResource` composable (spec §4.1, §4.2, §10, M5 Phase A):
 * a sparse, block-fetched list resource for the grid's server mode. Unlike
 * `ListResource` (list.svelte.ts), which fetches one full page in a single
 * call, this resource fetches fixed-size blocks lazily as the caller's
 * visible row range moves (BantoGrid's row-virtualization window), so a
 * server-backed grid with a huge `totalCount` only ever fetches the rows
 * that have scrolled into view (+ overscan) instead of the whole table.
 *
 * Failures and recovery (Issue #243):
 *
 * - **A failure belongs to its block.** It stays in `failures` (one entry
 *   per block, ascending) until that block is fetched successfully or
 *   `setParams()` starts a new query; another block's success does not
 *   clear it. `refresh()` keeps it until its retry settles (removed on
 *   success, replaced on a new failure); `failures` is updated as each
 *   block settles, while the published rows wait for the whole generation
 *   (#212).
 * - **Recovery never depends on the visible range.** While the current
 *   generation has no `totalCount` yet (a failed first fetch, or a new
 *   query/refresh), a load with nothing else to fetch requests block 0, so
 *   `setParams()`/`refresh()` still reach the server when the grid reports
 *   an empty window `{0, 0}` (it does whenever `totalCount` is 0). A block
 *   that already failed in the current generation is not requested this
 *   way again (no silent retry loop); `refresh()` (a new generation) and an
 *   `ensureRange()` that explicitly covers it do retry it.
 * - **A request cannot hang forever.** Each block request fails after
 *   `requestTimeoutMs` (default {@link DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS});
 *   its late answer is ignored, so `loading` always comes down.
 * - A `getList` that throws synchronously, rejects with anything, or answers
 *   with a malformed result records a failure for that block instead of
 *   throwing out of the resource.
 *
 * What a failure says (Issue #344, the same as `SnapshotListResource` after
 * #342; the shared types live in blockFetch.ts):
 *
 * - `'request'`: `getList` (or `getDataProvider()`) threw or rejected. A
 *   thrown `ProviderError` (including an app's own subclass) is kept **as
 *   the same object**; a `ListBlockError` keeps its own code; anything else
 *   is wrapped in a `ListBlockError('request')` with the thrown value as
 *   `cause`.
 * - `'timeout'`, `'malformed'`: detected by the resource itself and recorded
 *   as a `ListBlockError` with that code. Their texts come from the
 *   `messages` option (i18n layer 1), the English defaults otherwise; a
 *   message function that throws falls back to the default.
 *
 * Each failure is also reported through the registered notifier (a toast)
 * unless the `notify` option turns that off or its predicate declines it.
 *
 * Not included on purpose: a per-generation snapshot boundary (an "as of"
 * id every block of a generation is read from). Rows added or removed
 * between two block requests can still shift `OFFSET` by the change; fixing
 * that needs `DataProvider.getList` to carry the boundary (an API change),
 * and ordinary CRUD screens re-fetch anyway on the `invalidate()` their own
 * change events trigger. The server side guarantees a total order
 * (`banto-storage` appends the unique key to `ORDER BY`), so with unchanged
 * data the blocks tile the list exactly. A list that changes without
 * events (an append-only log such as the audit log) uses
 * `SnapshotListResource` (snapshot.svelte.ts, Issue #248) instead, which
 * takes an injected fetcher that carries the boundary.
 *
 * Runes constraint: this class never creates an `$effect` itself (no effect
 * context in a plain module, same rule as ListResource); components wire
 * `$effect`/cleanup around `ensureRange()`/`dispose()`.
 */
import {
	detectedFailure,
	hasTimeLimit,
	isWritableList,
	requestFailure,
	shouldNotify,
	type ListBlockErrorFailure,
	type ListBlockErrorOutcome,
	type ListBlockMessages,
	type ListBlockNotify
} from './blockFetch';
import { onInvalidate } from './invalidate';
import { getDataProvider, notify } from './registry.svelte';
import type { FilterState, ListResult, SortState } from './types';

/** Default for {@link CreateWindowedListResourceOptions.requestTimeoutMs}: 30 s. */
export const DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS = 30_000;

export interface CreateWindowedListResourceOptions {
	/** Rows fetched per block. Default 200. */
	blockSize?: number;
	/**
	 * Milliseconds after which a block request that has not answered is
	 * treated as failed (its late answer is ignored). Default
	 * {@link DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS}. `0`, a negative number or
	 * `Infinity` disables the limit.
	 */
	requestTimeoutMs?: number;
	/** Replaces the texts of the failures the resource detects itself (`timeout`, `malformed`). */
	messages?: ListBlockMessages;
	/**
	 * Whether a failure is also reported through the registered notifier (a
	 * toast). `false` never; a function decides per failure (one that throws
	 * counts as `false`). Default `true`.
	 */
	notify?: ListBlockNotify;
}

export interface WindowedParams {
	sort: SortState[];
	filters: FilterState[];
}

interface InFlightBlock {
	promise: Promise<void>;
	/** Distinguishes two requests for the same block (a retry after a timeout). */
	attempt: number;
}

interface FailureRecord {
	failure: ListBlockErrorFailure;
	/** The generation the failure was recorded in (see `#implicitFirstBlock`). */
	generation: number;
}

type Outcome<T> = { ok: true; result: ListResult<T> } | ({ ok: false } & ListBlockErrorOutcome);

export class WindowedListResource<T> {
	/** Sparse: index i holds row i once its covering block has loaded, `undefined` (a hole) otherwise. */
	rows: (T | undefined)[] = $state([]);
	totalCount = $state(0);
	/** True while any block is in flight. */
	loading = $state(false);
	/**
	 * One entry per block whose latest request failed and that has not loaded
	 * since, ascending by block. Emptied by `setParams()`; kept through
	 * `refresh()` until the retried block settles (a success removes it, a
	 * new failure replaces it).
	 */
	failures: readonly ListBlockErrorFailure[] = $state([]);
	params: WindowedParams = $state({ sort: [], filters: [] });

	#resource: string;
	#blockSize: number;
	#requestTimeoutMs: number;
	#messages: ListBlockMessages;
	#notify: ListBlockNotify;
	#unsubscribe: () => void;

	#loadedBlocks = new Set<number>();
	#inFlightBlocks = new Map<number, InFlightBlock>();
	#failures = new Map<number, FailureRecord>();
	#attempts = 0;
	// Bumped by setParams()/refresh(). A block response only writes state
	// (rows/totalCount/failures) if its generation still matches - the same
	// stale-response guard as ListResource's request token (list.svelte.ts),
	// applied per block instead of per whole-list load().
	#generation = 0;
	// Whether a response in the *current* generation has already supplied
	// totalCount/resized `rows`; only the first one per generation should.
	#hasTotalCountForGeneration = false;
	// Refreshes replace one dataset snapshot with another. Keep the published
	// rows until all current-generation requests settle, so grids do not lose
	// their edit/selection to temporary holes or mix old and reordered rows.
	#refreshSnapshot: { rows: (T | undefined)[]; totalCount: number } | null = null;
	// Last range passed to ensureRange(), so refresh()/setParams() can re-fetch it.
	#lastRange: { start: number; end: number } | null = null;

	constructor(resource: string, options: CreateWindowedListResourceOptions = {}) {
		this.#resource = resource;
		this.#blockSize = options.blockSize ?? 200;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS;
		this.#messages = { ...options.messages };
		this.#notify = options.notify ?? true;
		this.#unsubscribe = onInvalidate(resource, () => {
			void this.refresh();
		});
	}

	#blocksFor(start: number, end: number): number[] {
		if (end <= start) return [];
		const firstBlock = Math.floor(Math.max(start, 0) / this.#blockSize);
		const lastBlock = Math.floor((end - 1) / this.#blockSize);
		const blocks: number[] = [];
		for (let b = firstBlock; b <= lastBlock; b++) blocks.push(b);
		return blocks;
	}

	/**
	 * Fetch whatever blocks covering `[start, end)` aren't already loaded or
	 * in flight. Safe to call repeatedly (e.g. on every virtualization
	 * window move) - already-covered blocks are skipped, and overlapping
	 * calls dedup per block (the in-flight bookkeeping below is populated
	 * synchronously before this function's first `await`, so two calls made
	 * back-to-back without awaiting the first never double-fetch the same
	 * block). The returned promise settles once every covering block that
	 * is (or was already) in flight has settled.
	 *
	 * A block that failed is requested again when a range covers it. While
	 * the generation has no `totalCount` yet and nothing else is being
	 * fetched, block 0 is requested even for an empty range (see the module
	 * doc comment).
	 */
	ensureRange(start: number, end: number): Promise<void> {
		this.#lastRange = { start, end };
		return this.#load(this.#blocksFor(start, end));
	}

	#load(wanted: number[]): Promise<void> {
		const generation = this.#generation;
		const blocks = [...new Set(wanted)].sort((a, b) => a - b);
		const toFetch = blocks.filter(
			(block) => !this.#loadedBlocks.has(block) && !this.#inFlightBlocks.has(block)
		);
		if (toFetch.length === 0 && this.#implicitFirstBlock(generation)) {
			toFetch.push(0);
			blocks.push(0);
		} else if (
			blocks.length === 0 &&
			!this.#hasTotalCountForGeneration &&
			this.#inFlightBlocks.has(0)
		) {
			// An empty range while the implicit block 0 is already in flight
			// (e.g. setParams() then the grid's `ensureRange(0, 0)`): wait for it.
			blocks.push(0);
		}

		// Bookkeeping first, requests second (#243 review): every block of
		// this load is in the in-flight map before any request starts, so no
		// settlement - even one that runs early - can see a half-registered
		// load (a missing entry, or an empty map that publishes a staged
		// refresh while later blocks are still to be requested).
		const started = toFetch.map((block) => {
			const entry: InFlightBlock = { promise: Promise.resolve(), attempt: ++this.#attempts };
			this.#inFlightBlocks.set(block, entry);
			return { block, entry };
		});
		for (const { block, entry } of started) {
			entry.promise = this.#fetchBlock(block, generation, entry.attempt);
		}
		this.#settleLoading();

		const pending = blocks
			.map((block) => this.#inFlightBlocks.get(block)?.promise)
			.filter((promise): promise is Promise<void> => promise !== undefined);
		return Promise.all(pending).then(() => undefined);
	}

	/**
	 * Whether a load that fetches nothing else should request block 0: the
	 * generation has no `totalCount` yet, nothing in flight will supply it,
	 * and block 0 has not already failed in this generation.
	 */
	#implicitFirstBlock(generation: number): boolean {
		return (
			!this.#hasTotalCountForGeneration &&
			this.#inFlightBlocks.size === 0 &&
			!this.#loadedBlocks.has(0) &&
			this.#failures.get(0)?.generation !== generation
		);
	}

	async #fetchBlock(block: number, generation: number, attempt: number): Promise<void> {
		const offset = block * this.#blockSize;
		let outcome: Outcome<T>;
		// The provider is still called synchronously (callers rely on the
		// request being issued before ensureRange() returns), but a
		// synchronous throw - from getDataProvider() or a custom getList() -
		// becomes a rejected promise, so this block always settles after
		// the `await` below, never in the middle of `#load`.
		let request: Promise<ListResult<T>>;
		try {
			request = Promise.resolve(
				getDataProvider().getList<T>(this.#resource, {
					pagination: { offset, limit: this.#blockSize },
					sort: this.params.sort,
					filters: this.params.filters
				})
			);
		} catch (err) {
			request = Promise.reject(err);
		}
		try {
			const result = await this.#withTimeout(request);
			outcome = { ok: true, result };
		} catch (err) {
			// A timeout arrives here as the ListBlockError('timeout') that
			// #withTimeout rejected with, and keeps its code.
			outcome = { ok: false, ...requestFailure(err) };
		}

		// Superseded by setParams()/refresh() (which also dropped this block
		// from the in-flight map), or by a newer request for the same block.
		if (generation !== this.#generation) return;
		if (this.#inFlightBlocks.get(block)?.attempt !== attempt) return;
		this.#inFlightBlocks.delete(block);

		// A malformed answer (a buggy custom provider) must not throw while
		// writing below - that would skip the settlement at the end and leave
		// `loading` up - so it is recorded as this block's failure instead.
		if (outcome.ok && !isWritableList(outcome.result, offset)) {
			outcome = { ok: false, ...detectedFailure('malformed', this.#messages) };
		}

		if (outcome.ok) {
			// The check above makes this write non-throwing; the catch is the
			// structural guarantee that, whatever happens, the block still
			// reaches the settlement below (#246 re-review).
			try {
				this.#writeBlock(block, offset, outcome.result);
			} catch (err) {
				// Unreachable after the check above; an answer that could not
				// be written is a malformed one.
				const { code, error } = detectedFailure('malformed', this.#messages);
				error.cause = err;
				outcome = { ok: false, code, error };
			}
		}
		let failure: ListBlockErrorFailure | null = null;
		if (!outcome.ok) {
			failure = { block, kind: 'error', code: outcome.code, error: outcome.error };
			this.#failures.set(block, { failure, generation });
		}
		this.#publishFailures();
		this.#settleLoading();
		// Last, after the state is consistent: the predicate and the notifier
		// are app code and may throw; that must neither leave `loading` up nor
		// reject the promise ensureRange()/refresh() callers await.
		if (failure) {
			try {
				if (shouldNotify(this.#notify, failure)) notify('error', failure.error.message);
			} catch {
				// Ignored on purpose (see above).
			}
		}
	}

	/**
	 * Write one block's rows. Everything that can throw (resizing the target
	 * array) happens before any state is changed, so a throw leaves
	 * `totalCount` and the generation's bookkeeping untouched; `totalCount`
	 * therefore always stays a valid array length, which `setParams()` and
	 * `refresh()` rely on (`new Array(this.totalCount)`).
	 */
	#writeBlock(block: number, offset: number, result: ListResult<T>): void {
		const snapshot = this.#refreshSnapshot;
		const targetRows = snapshot ? snapshot.rows : this.rows;
		const first = !this.#hasTotalCountForGeneration;
		const end = offset + result.rows.length;
		// Resize first (the only step that can throw)...
		if (first) targetRows.length = result.totalCount;
		if (targetRows.length < end) targetRows.length = end;
		// ...then publish.
		if (first) {
			this.#hasTotalCountForGeneration = true;
			if (snapshot) snapshot.totalCount = result.totalCount;
			else this.totalCount = result.totalCount;
		}
		for (let i = 0; i < result.rows.length; i++) {
			targetRows[offset + i] = result.rows[i];
		}
		this.#loadedBlocks.add(block);
		this.#failures.delete(block);
	}

	#withTimeout<R>(request: Promise<R>): Promise<R> {
		const ms = this.#requestTimeoutMs;
		if (!hasTimeLimit(ms)) return request;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(detectedFailure('timeout', this.#messages, ms).error), ms);
		});
		return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
	}

	/** Recompute `loading`; when the generation has settled, publish a staged refresh. */
	#settleLoading(): void {
		// Decide from the private map, never by reading `this.loading` back:
		// ensureRange() runs this synchronously, often inside a caller's
		// `$effect`, which must not start depending on `loading`.
		const loading = this.#inFlightBlocks.size > 0;
		this.loading = loading;
		if (!loading && this.#refreshSnapshot) {
			this.rows = this.#refreshSnapshot.rows;
			this.totalCount = this.#refreshSnapshot.totalCount;
			this.#refreshSnapshot = null;
		}
	}

	/** Publish `failures`, ascending by block. Decides from the private map only. */
	#publishFailures(): void {
		this.failures = [...this.#failures.values()]
			.map((record) => record.failure)
			.sort((a, b) => a.block - b.block);
	}

	/**
	 * Replace sort/filters. Clears all cached blocks/rows (and the previous
	 * query's failures) so stale data isn't shown under the new params, but
	 * deliberately keeps the previous `totalCount` (rather than resetting to
	 * 0) until the first response under the new params arrives - resetting
	 * to 0 immediately would make the virtual scroller collapse and jump the
	 * scroll position. Re-fetches the last ensured range itself (block 0
	 * when that range is empty); callers that re-`ensureRange()` the visible
	 * window afterwards (BantoGrid's `onParamsChange` does) just join those
	 * requests.
	 */
	setParams(partial: Partial<WindowedParams>): void {
		this.params = { ...this.params, ...partial };
		this.#bumpGeneration();
		this.#failures.clear();
		this.#publishFailures();
		this.rows = new Array(this.totalCount);
		if (this.#lastRange) {
			void this.#load(this.#blocksFor(this.#lastRange.start, this.#lastRange.end));
		} else {
			this.#settleLoading();
		}
	}

	/**
	 * Re-fetch the last ensured range and publish its replacement atomically
	 * (spec §4.1 / #212). Initial loads and setParams still expose holes while
	 * loading; refresh alone preserves the prior snapshot until completion.
	 * Failed blocks become holes in the new snapshot and remain retryable.
	 *
	 * Also re-requests every block whose failure is still outstanding (even
	 * outside the last range), and block 0 when the last range is empty
	 * (Issue #243: the "reload" after a failed first fetch or a 0-row result
	 * must reach the server). Before the first `ensureRange()` it fetches
	 * nothing.
	 */
	refresh(): Promise<void> {
		this.#bumpGeneration();
		if (!this.#lastRange) {
			this.rows = new Array(this.totalCount);
			this.#settleLoading();
			return Promise.resolve();
		}
		this.#refreshSnapshot = { rows: new Array(this.totalCount), totalCount: this.totalCount };
		return this.#load([
			...this.#blocksFor(this.#lastRange.start, this.#lastRange.end),
			...this.#failures.keys()
		]);
	}

	#bumpGeneration(): void {
		this.#generation++;
		this.#refreshSnapshot = null;
		this.#loadedBlocks.clear();
		this.#inFlightBlocks.clear();
		this.#hasTotalCountForGeneration = false;
	}

	/** Stop reacting to invalidate() calls for this resource. Call from the owning component's cleanup. */
	dispose(): void {
		this.#unsubscribe();
	}
}

export function createWindowedListResource<T>(
	resource: string,
	options?: CreateWindowedListResourceOptions
): WindowedListResource<T> {
	return new WindowedListResource<T>(resource, options);
}
