<script lang="ts">
	/**
	 * サーバーモード (spec §4.1, §4.2, §10, M5 Phase A): sort/filter/paging
	 * execute in the DataProvider (InMemory in the browser, Rust+SQLite in
	 * Tauri) via `ListParams`, and BantoGrid only ever holds the rows that
	 * have scrolled into view (+ overscan) - fetched block-by-block through
	 * `createWindowedListResource` as the virtualization window moves.
	 *
	 * Split out from +page.svelte so the mode toggle can cleanly mount/
	 * unmount whichever side is inactive (see ItemsClientGrid.svelte's doc
	 * comment for why: no double `onInvalidate` subscriptions).
	 */
	import {
		BantoGrid,
		GridState,
		type CellEdit,
		type FilterState,
		type GridColumn,
		type SortState
	} from '@banto/grid-svelte';
	import { createWindowedListResource, invalidate } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { gridMessages } from '#lib/banto/i18n.js';
	import type { Item } from '#lib/banto/sampleData.js';

	interface Props {
		columns: GridColumn<Item>[];
		/**
		 * Owned by the parent page (+page.svelte, spec M15 Phase C addition) so
		 * its CSV export button can read `state.sort`/`state.filters` directly
		 * and reproduce the exact same ListParams this grid is currently
		 * showing - same wiring pattern ItemsClientGrid.svelte already uses for
		 * its own externally-owned GridState (spec §4.3's group-by <select>).
		 */
		state: GridState<Item>;
		onRowClick: (item: Item) => void;
		onCellEdit: (edit: CellEdit<Item>) => Promise<Item>;
		onRangePaste: (edits: CellEdit<Item>[], info: { skipped: number }) => Promise<Item[]>;
		/**
		 * Issue #215: forwarded straight to BantoGrid's own `rowClass` prop so
		 * the parent page can highlight the row it was last opened/saved from
		 * (the round trip's "work position" marker) - same passthrough as
		 * `columns`/`state` above, no grid-mode-specific logic here.
		 */
		rowClass?: (row: Item) => string | undefined;
		/**
		 * Issue #284: lets the page's save queue read the row as currently
		 * displayed (publishSaved-updated) at SEND time. Called with a lookup on
		 * mount and `undefined` on teardown.
		 */
		registerCurrentRow?: (
			lookup: ((rowId: string | number) => Item | undefined) | undefined
		) => void;
	}

	let {
		columns,
		state: gridState,
		onRowClick,
		onCellEdit,
		onRangePaste,
		rowClass,
		registerCurrentRow
	}: Props = $props();

	// リソース自身が作る失敗（期限切れ・応答の形の不正）の文言を Paraglide の
	// 文言に差し替える（banto #344。トーストにもこの文言が出る）。
	const windowed = createWindowedListResource<Item>('items', {
		messages: {
			timeout: (ms) => m['items.loadTimeout']({ seconds: Math.round(ms / 1000) }),
			malformed: () => m['items.malformedResult']()
		}
	});

	// Issue #215: `windowed.params` starts at `{ sort: [], filters: [] }`
	// (windowed.svelte.ts) regardless of what `gridState` was constructed
	// with - it only ever changes through `setParams()`, which BantoGrid
	// calls after a HEADER interaction (sort click / filter apply), never on
	// mount. Before #215 this was unobservable (`gridState` itself always
	// started empty too), but restoring a saved sort/filters onto
	// `gridState` (+page.svelte) now means the two can start out of sync:
	// the grid's header would show the restored sort arrow and filter while
	// `ensureRange()` below quietly fetches the unfiltered/unsorted first
	// page. Seed `windowed.params` from whatever `gridState` already holds
	// at construction time so the very first fetch matches what's on
	// screen. Deliberately only the INITIAL value - a later change to
	// `gridState.sort`/`filters` reaches `windowed` through the normal
	// `onParamsChange` -> `handleParamsChange` -> `windowed.setParams()` path
	// below, same as before this fix.
	// svelte-ignore state_referenced_locally
	windowed.setParams({ sort: gridState.sort, filters: gridState.filters });

	// The most recently requested visible window, so a param change (sort/
	// filter) knows which range to re-fetch under the new params. Updated
	// only by handleVisibleRangeChange below (BantoGrid's own initial
	// onVisibleRangeChange fire is unreliable as a substitute for the first
	// load: `totalRows` is still 0 at that point, so BantoGrid's virtual
	// window computes as empty until the first ensureRange response sets
	// it - hence the hardcoded initial range here rather than reading this
	// variable).
	let visibleRange = { start: 0, end: 100 };

	// Deliberately TWO separate effects rather than one "load + cleanup"
	// effect (a real bug found during manual verification, spec §4.1/§4.2):
	// `ensureRange()` synchronously reads `windowed.params.sort/filters`
	// (as arguments to `getDataProvider().getList()`, before its own first
	// `await`) while still inside this effect's reactive-tracking scope, so
	// a single combined effect ends up depending on `windowed.params` -
	// every `setParams()` call (i.e. every sort/filter change) then reruns
	// it, and Svelte runs the OLD run's cleanup first. If that cleanup were
	// `windowed.dispose()`, the very first sort/filter click would
	// permanently unsubscribe `windowed` from `invalidate('items')` (its
	// constructor-time subscription is never re-established), silently
	// breaking "edit -> invalidate -> refetch" for the rest of the page's
	// life. Keeping disposal in its own effect - one that reads nothing
	// reactive - guarantees it only ever runs once, on unmount.
	$effect(() => {
		void windowed.ensureRange(0, 100); // initial viewport-sized load
	});

	$effect(() => {
		return () => windowed.dispose();
	});

	// "Reload" for a failed block (Issue #243). `refresh()` re-reads the
	// visible range, every block whose failure is still shown, and block 0
	// when the grid's window is empty (a failed first fetch leaves
	// totalCount 0, so BantoGrid reports `{0, 0}`). Never disabled while
	// loading: a hung request times out, and a refresh supersedes it.
	function handleReload(): void {
		void windowed.refresh();
	}

	function handleParamsChange(params: { sort: SortState[]; filters: FilterState[] }): void {
		windowed.setParams(params);
		void windowed.ensureRange(visibleRange.start, visibleRange.end);
	}

	function handleVisibleRangeChange(range: { start: number; end: number }): void {
		visibleRange = range;
		void windowed.ensureRange(range.start, range.end);
	}

	// Publish confirmed saves before allowing another edit (spec §4.5).
	// Replace by ID only: a changed query may have removed or moved the row.
	// Invalidation is synchronous with publication, superseding older GETs.
	function publishSaved(saved: Item[]): void {
		if (saved.length === 0) return;
		const byId = new Map(saved.map((item) => [item.id, item]));
		// Only enumerate loaded slots; rows.length can span millions of holes.
		for (const key of Object.keys(windowed.rows)) {
			const index = Number(key);
			const row = windowed.rows[index];
			const replacement = row && byId.get(row.id);
			if (replacement) windowed.rows[index] = replacement;
		}
		invalidate('items');
	}

	$effect(() => {
		registerCurrentRow?.((rowId) => {
			// Only enumerate loaded slots; rows.length can span millions of holes.
			for (const key of Object.keys(windowed.rows)) {
				const row = windowed.rows[Number(key)];
				if (row && row.id === rowId) return row;
			}
			return undefined;
		});
		return () => registerCurrentRow?.(undefined);
	});

	async function handleCellEdit(edit: CellEdit<Item>): Promise<void> {
		publishSaved([await onCellEdit(edit)]);
	}

	async function handleRangePaste(
		edits: CellEdit<Item>[],
		info: { skipped: number }
	): Promise<void> {
		publishSaved(await onRangePaste(edits, info));
	}
</script>

<p class="note">{m['items.rowCount']({ count: windowed.totalCount.toLocaleString() })}</p>

{#if windowed.failures.length > 0}
	<div class="load-error" role="alert">
		<p>
			<strong>{m['items.loadError']()}</strong>
			<span>{m['items.loadErrorDesc']()}</span>
		</p>
		<button type="button" class="banto-btn banto-btn--secondary" onclick={handleReload}>
			{m['common.reload']()}
		</button>
	</div>
{/if}

<div class="grid-wrap">
	<BantoGrid
		mode="server"
		state={gridState}
		messages={gridMessages()}
		rows={windowed.rows}
		totalRows={windowed.totalCount}
		{columns}
		getRowId={(item) => item.id}
		{onRowClick}
		onCellEdit={handleCellEdit}
		onRangePaste={handleRangePaste}
		onParamsChange={handleParamsChange}
		onVisibleRangeChange={handleVisibleRangeChange}
		{rowClass}
	/>
</div>

<style>
	.note {
		flex: 0 0 auto;
		margin: 0 0 0.75rem;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.load-error {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--banto-danger-solid);
		border-radius: var(--banto-radius-sm);
		background: var(--banto-danger-tint);
		color: var(--banto-danger-tint-text);
		font-size: 0.85rem;
	}

	.load-error p {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.5rem;
	}

	.grid-wrap {
		flex: 1;
		min-height: 0;
	}
</style>
