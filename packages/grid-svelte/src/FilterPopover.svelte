<script lang="ts" generics="TRow">
	/** Column filter editor, opened from HeaderCell's filter icon (spec §4.3). */
	import { onMount } from 'svelte';
	import type { FilterOp, FilterState, GridColumn } from './types';
	import { defaultGridMessages, type GridMessages } from './messages';

	interface Props {
		id?: string;
		trigger?: HTMLButtonElement;
		column: GridColumn<TRow>;
		current: FilterState | undefined;
		onApply: (filter: FilterState) => void;
		onClear: () => void;
		onClose: (reason: 'escape' | 'outside') => void;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings. Defaults reproduce today's Japanese output. */
		messages?: Partial<GridMessages>;
	}

	const instanceId = $props.id();
	let {
		id = `${instanceId}-filter`,
		trigger,
		column,
		current,
		onApply,
		onClear,
		onClose,
		messages = {}
	}: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultGridMessages, ...messages };

	const filterType = $derived(column.filterType ?? 'text');

	const TEXT_OPS: { value: FilterOp; label: string }[] = [
		{ value: 'contains', label: t.filterOpContains() },
		{ value: 'starts_with', label: t.filterOpStartsWith() },
		{ value: 'eq', label: t.filterOpEquals() }
	];
	const NUMBER_OPS: { value: FilterOp; label: string }[] = [
		{ value: 'eq', label: '=' },
		{ value: 'ne', label: '≠' },
		{ value: 'gt', label: '>' },
		{ value: 'gte', label: '≥' },
		{ value: 'lt', label: '<' },
		{ value: 'lte', label: '≤' }
	];
	const ops = $derived(filterType === 'number' ? NUMBER_OPS : TEXT_OPS);

	// `op` / `value` are deliberately seeded from the initial `current` prop:
	// the popover unmounts on close, so a re-open re-reads the latest filter.
	// svelte-ignore state_referenced_locally
	let op: FilterOp = $state(current?.op ?? (filterType === 'number' ? 'eq' : 'contains'));
	// Number inputs bind numbers, or undefined when empty/invalid. Keep that
	// empty state distinct from 0 so applying an empty value clears the filter.
	// svelte-ignore state_referenced_locally
	let value: string | number | undefined = $state(
		current?.value === undefined || current?.value === null ? '' : String(current.value)
	);

	let rootEl: HTMLDivElement | undefined = $state();
	let valueEl: HTMLInputElement | undefined = $state();

	// This runs once per opening, not when the draft or operator changes.
	onMount(() => valueEl?.focus({ preventScroll: true }));

	$effect(() => {
		function handlePointerDown(event: PointerEvent) {
			if (
				rootEl &&
				event.target instanceof Node &&
				!rootEl.contains(event.target) &&
				!trigger?.contains(event.target)
			) {
				onClose('outside');
			}
		}
		function handleKeydown(event: KeyboardEvent) {
			if (
				event.key !== 'Escape' ||
				event.defaultPrevented ||
				event.isComposing ||
				event.keyCode === 229 ||
				!(event.target instanceof Node) ||
				!rootEl?.contains(event.target) ||
				!rootEl.contains(document.activeElement)
			)
				return;
			event.preventDefault();
			event.stopPropagation();
			onClose('escape');
		}
		// Capture phase so this still sees the click even if a descendant stops propagation.
		window.addEventListener('pointerdown', handlePointerDown, true);
		window.addEventListener('keydown', handleKeydown);
		return () => {
			window.removeEventListener('pointerdown', handlePointerDown, true);
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	function apply() {
		// An empty value means "no filter": applying it would be a no-op for
		// text and, worse, Number('') === 0 would silently filter by 0 for
		// number columns. Treat it as clearing the filter instead. `value`
		// may be a number here (bind:value on a number input), so normalize
		// to a string before trimming.
		const raw = String(value ?? '');
		if (raw.trim() === '') {
			onClear();
			return;
		}
		const parsedValue: unknown = filterType === 'number' ? Number(raw) : raw;
		onApply({ field: column.id, op, value: parsedValue });
	}
</script>

<div
	{id}
	class="filter-popover"
	bind:this={rootEl}
	role="dialog"
	aria-label={t.filterAriaLabel(column.header.trim() || column.id)}
>
	<select bind:value={op} aria-label={t.filterOperatorLabel()}>
		{#each ops as item (item.value)}
			<option value={item.value}>{item.label}</option>
		{/each}
	</select>
	<input
		bind:this={valueEl}
		aria-label={t.filterValueLabel()}
		type={filterType === 'number' ? 'number' : 'text'}
		bind:value
		placeholder={t.filterValuePlaceholder()}
		onkeydown={(event) => {
			if (
				event.key === 'Enter' &&
				!event.isComposing &&
				event.keyCode !== 229 &&
				!event.defaultPrevented
			) {
				// Applying restores focus to the trigger. Cancel native Enter
				// activation first so it cannot click that trigger and reopen us.
				event.preventDefault();
				apply();
			}
		}}
	/>
	<div class="actions">
		<button type="button" class="apply" onclick={apply}>{t.filterApply()}</button>
		<button type="button" class="clear" onclick={onClear}>{t.filterClear()}</button>
	</div>
</div>

<style>
	.filter-popover {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		width: 190px;
		padding: 0.6rem;
		background: var(--banto-surface-overlay);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		box-shadow: var(--banto-shadow-lg);
		/* Standard preset: no-op (var(--banto-backdrop) is `none`). Glass
		   preset opts in by overriding --banto-backdrop (spec §9). */
		backdrop-filter: var(--banto-backdrop, none);
	}

	select,
	input {
		width: 100%;
		box-sizing: border-box;
		height: var(--banto-control-height-sm);
		padding: 0 0.4rem;
		border: 1px solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface);
		color: var(--banto-text);
		font-size: 0.8rem;
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	select:focus-visible,
	input:focus-visible,
	button:focus-visible {
		outline: var(--banto-border-width-strong, 2px) solid var(--banto-primary);
		outline-offset: calc(-1 * var(--banto-border-width-strong, 2px));
		box-shadow: var(--banto-focus-ring);
	}

	button.apply:focus-visible {
		/* The primary outline would disappear into this button's solid fill. */
		outline-color: var(--banto-on-solid);
	}

	@media (forced-colors: active) {
		select:focus-visible,
		input:focus-visible,
		button:focus-visible,
		button.apply:focus-visible {
			outline-color: Highlight;
		}
	}

	.actions {
		display: flex;
		gap: 0.4rem;
		justify-content: flex-end;
	}

	button {
		box-sizing: border-box;
		height: var(--banto-control-height-sm);
		border: 1px solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		padding: 0 0.6rem;
		font-size: 0.75rem;
		cursor: pointer;
		background: var(--banto-surface);
		color: var(--banto-text);
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	button.apply {
		background: var(--banto-primary-solid);
		border-color: var(--banto-primary-solid);
		color: var(--banto-on-solid);
	}

	button.apply:hover {
		background: var(--banto-primary-solid-hover);
		border-color: var(--banto-primary-solid-hover);
	}
</style>
