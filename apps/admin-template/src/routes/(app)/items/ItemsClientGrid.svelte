<script lang="ts">
	/**
	 * クライアントモード (spec §4.1, M2-M4): unchanged from before M5 - fetch
	 * the whole demo dataset once (limit large enough to cover it) and let
	 * BantoGrid do client-side sort/filter/paging under virtualization.
	 *
	 * Split out from +page.svelte (M5 Phase A) so the mode toggle can fully
	 * mount/unmount whichever side is inactive: `createListResource`
	 * subscribes to `onInvalidate('items')` in its constructor, so keeping
	 * both this and ItemsServerGrid always alive at the parent level would
	 * leave two live subscriptions (and two in-flight resources) at once.
	 * A plain `{#if}` in the parent already destroys this component (running
	 * the `$effect` cleanup below) when the toggle flips to サーバー.
	 */
	import { BantoGrid, GridState, type CellEdit, type GridColumn } from '@banto/grid-svelte';
	import { createListResource, invalidate } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { gridMessages } from '#lib/banto/i18n.js';
	import type { Item } from '#lib/banto/sampleData.js';
	import { LoadingState } from '@banto/ui';
	import { toItemRow, type ItemRow } from './itemRow';

	interface Props {
		columns: GridColumn<ItemRow>[];
		/**
		 * Owned by the parent page (+page.svelte) so its shared group-by
		 * <select> can call `state.setGroupBy(...)` directly (spec §4.3
		 * wiring pattern, same as ItemsServerGrid's own externally-owned
		 * GridState for reading sort/filters).
		 */
		state: GridState<ItemRow>;
		onRowClick: (item: Item) => void;
		onCellEdit: (edit: CellEdit<Item>) => Promise<Item>;
		onRangePaste: (edits: CellEdit<Item>[], info: { skipped: number }) => Promise<Item[]>;
		/**
		 * Issue #215: forwarded straight to BantoGrid's own `rowClass` prop so
		 * the parent page can highlight the row it was last opened/saved from
		 * (the round trip's "work position" marker) - same passthrough as
		 * `columns`/`state` above, no grid-mode-specific logic here.
		 */
		rowClass?: (row: ItemRow) => string | undefined;
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

	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: 20_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	const rows = $derived(list.rows.map(toItemRow));

	// Publish confirmed saves before allowing another edit (spec §4.5).
	// Replace by ID only: a changed query may have removed or moved the row.
	// Invalidation is synchronous with publication, superseding older GETs.
	function publishSaved(saved: Item[]): void {
		if (saved.length === 0) return;
		const byId = new Map(saved.map((item) => [item.id, item]));
		list.rows = list.rows.map((item) => byId.get(item.id) ?? item);
		invalidate('items');
	}

	$effect(() => {
		registerCurrentRow?.((rowId) => list.rows.find((item) => item.id === rowId));
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

<p class="note">{m['items.rowCount']({ count: list.totalCount.toLocaleString() })}</p>

{#if list.loading && list.rows.length === 0}
	<div class="loading">
		<LoadingState label={m['items.loadingData']()} />
	</div>
{:else}
	<div class="grid-wrap">
		<BantoGrid
			{rows}
			{columns}
			state={gridState}
			messages={gridMessages()}
			getRowId={(item) => item.id}
			onRowClick={(row: ItemRow) => onRowClick(row)}
			onCellEdit={handleCellEdit}
			onRangePaste={handleRangePaste}
			{rowClass}
		/>
	</div>
{/if}

<style>
	.note {
		flex: 0 0 auto;
		margin: 0 0 0.75rem;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.loading {
		flex: 1;
		display: grid;
		place-items: center;
		color: var(--banto-text-muted);
	}

	.grid-wrap {
		flex: 1;
		min-height: 0;
	}
</style>
