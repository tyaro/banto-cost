<script lang="ts" generics="TRow">
	/**
	 * Column manager (spec §4.4 "列の表示/非表示切り替え（列マネージャーUI）"):
	 * a trigger button plus a popover of one checkbox per column, writing
	 * through to `GridState.setColumnHidden`.
	 *
	 * Deliberately a SEPARATE component rather than a menu inside
	 * BantoGrid's header row: the header is a CSS grid whose
	 * `grid-template-columns` is computed from the visible columns' widths,
	 * so an extra always-present affordance in that row would have to be
	 * excluded from every width/field-index calculation. Placing the menu in
	 * the page's own toolbar (next to the group-by select, the CSV buttons,
	 * ...) keeps the grid's layout math untouched, and lets a page that
	 * doesn't want column management simply not render it. It takes the same
	 * `GridState` instance the grid was handed - the externally-owned-state
	 * pattern that the group-by <select> already uses (spec §4.3).
	 *
	 * Dismiss model mirrors FilterPopover: Escape or a pointer-down outside
	 * the root closes it; there is no Tab-cycling focus trap.
	 */
	import type { GridState } from './state.svelte';
	import { defaultGridMessages, type GridMessages } from './messages';

	interface Props {
		/** The SAME GridState instance passed to BantoGrid - this menu mutates its `hidden` list. */
		state: GridState<TRow>;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings. Defaults reproduce today's Japanese output. */
		messages?: Partial<GridMessages>;
	}

	// Aliased to avoid clashing with the `$state` rune (a local binding named
	// exactly `state` makes the compiler treat `$state(...)` calls below as
	// store-subscription syntax instead of rune usage).
	let { state: gridState, messages = {} }: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultGridMessages, ...messages };

	let open = $state(false);
	let rootEl: HTMLDivElement | undefined = $state();

	const columns = $derived(gridState.allColumns);
	const visibleCount = $derived(gridState.orderedColumns.length);
	/**
	 * The one column whose checkbox is disabled while it is the only visible
	 * one left (`setColumnHidden` refuses to hide it anyway - this just makes
	 * the refusal visible instead of a dead click).
	 */
	const lockedId = $derived(visibleCount === 1 ? gridState.orderedColumns[0]?.id : undefined);

	$effect(() => {
		if (!open) return;
		function handlePointerDown(event: PointerEvent) {
			if (rootEl && event.target instanceof Node && !rootEl.contains(event.target)) {
				open = false;
			}
		}
		function handleKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') open = false;
		}
		// Capture phase so this still sees the click even if a descendant stops propagation.
		window.addEventListener('pointerdown', handlePointerDown, true);
		window.addEventListener('keydown', handleKeydown);
		return () => {
			window.removeEventListener('pointerdown', handlePointerDown, true);
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	/** A column with no header text (an actions/link column) still needs a label in the list. */
	function labelOf(header: string, id: string): string {
		return header.trim() === '' ? id : header;
	}
</script>

<div class="columns-menu" bind:this={rootEl}>
	<button
		type="button"
		class="trigger"
		aria-haspopup="dialog"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		{t.columnsMenuButton()}
		<span class="count">{t.columnsMenuCount(visibleCount, columns.length)}</span>
	</button>

	{#if open}
		<div class="popover" role="dialog" aria-label={t.columnsMenuTitle()}>
			{#each columns as column (column.id)}
				{@const locked = column.id === lockedId}
				<label class="item" title={locked ? t.columnsMenuLastColumn() : undefined}>
					<input
						type="checkbox"
						checked={!gridState.isHidden(column.id)}
						disabled={locked}
						onchange={() => gridState.toggleColumnHidden(column.id)}
					/>
					<span class="label">{labelOf(column.header, column.id)}</span>
				</label>
			{/each}
		</div>
	{/if}
</div>

<style>
	.columns-menu {
		position: relative;
		display: inline-flex;
	}

	.trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		box-sizing: border-box;
		height: var(--banto-control-height-sm);
		padding: 0 0.6rem;
		border: 1px solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface);
		color: var(--banto-text);
		font-size: 0.8rem;
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.trigger:hover {
		background: var(--banto-surface-hover);
	}

	.trigger:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.count {
		font-size: 0.7rem;
		color: var(--banto-text-muted);
	}

	.popover {
		position: absolute;
		top: calc(100% + 0.25rem);
		right: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 180px;
		max-height: 60vh;
		overflow-y: auto;
		padding: 0.5rem;
		background: var(--banto-surface-overlay);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		box-shadow: var(--banto-shadow-lg);
		/* Standard preset: no-op (var(--banto-backdrop) is `none`). Glass
		   preset opts in by overriding --banto-backdrop (spec §9). */
		backdrop-filter: var(--banto-backdrop, none);
	}

	.item {
		box-sizing: border-box;
		display: flex;
		min-height: var(--banto-control-height-sm, 28px);
		align-items: center;
		gap: 0.45rem;
		padding: 0.25rem 0.3rem;
		border-radius: var(--banto-radius-md);
		font-size: 0.8rem;
		color: var(--banto-text);
		cursor: pointer;
	}

	.item:hover {
		background: var(--banto-surface-hover);
	}

	.item:has(input:disabled) {
		color: var(--banto-text-muted);
		cursor: default;
	}

	/* Native checkbox styling remains local for standalone package consumers. */
	input {
		width: var(--banto-checkbox-size, 1.1rem);
		height: var(--banto-checkbox-size, 1.1rem);
		flex-shrink: 0;
		accent-color: var(--banto-primary);
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	input:focus-visible {
		outline: var(--banto-border-width-strong, 2px) solid var(--banto-primary);
		outline-offset: var(--banto-border-width, 1px);
		box-shadow: var(--banto-focus-ring);
		border-radius: var(--banto-radius-sm);
	}

	input:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
