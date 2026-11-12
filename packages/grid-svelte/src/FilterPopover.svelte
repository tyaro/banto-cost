<script lang="ts" generics="TRow">
	/**
	 * Column filter editor, opened from HeaderCell's filter icon (spec §4.3).
	 *
	 * A `date` / `datetime` column (date-time-pickers §5.9, PR-6) gets a day
	 * range instead of an operator and a value: the injected
	 * `dateRangeInput` (`CellEditors.dateRange`, the app's `DateRangeInput`),
	 * else two native `<input type="date">` in a `role="group"`. Both ends are
	 * inclusive days; apply sends `between` with the day after the end day
	 * (`dateRangeToBetween`, the one place for that rule). A box whose text is
	 * not a date, or an end before the start, shows an error and applies
	 * nothing; both ends empty clears the filter.
	 *
	 * The calendar of the injected input is a DOM child of this popover (in
	 * the top layer): its keys stop inside it and its Esc closes only the
	 * calendar (DateInput's promise 1), so the next Esc - from the text box -
	 * reaches the window handler below and closes this popover. A pointerdown
	 * in the calendar is inside `rootEl`, so it does not close this popover.
	 */
	import { onMount, type Component } from 'svelte';
	import type { FilterOp, FilterState, GridColumn } from './types';
	import { defaultGridMessages, type GridMessages } from './messages';
	import type { FilterDateRangeInputProps } from './cellEditors';
	import { parseDateText } from './core/date';
	import { betweenToDateRange, dateRangeToBetween, type DateRangeValue } from './core/dateRange';

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
		/** Injected day-range input for a `date` / `datetime` column; omitted: two native date inputs. */
		dateRangeInput?: Component<FilterDateRangeInputProps>;
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
		messages = {},
		dateRangeInput
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

	// --- day range (date / datetime columns, §5.9) ---------------------------

	const isRange = $derived(filterType === 'date' || filterType === 'datetime');
	// Seeded once, like `op` / `value`: a `between` this popover can show as
	// inclusive days, else empty (another op, or a host's date-and-time ends).
	// svelte-ignore state_referenced_locally
	const seededRange: DateRangeValue = (current?.op === 'between'
		? betweenToDateRange(current.value)
		: null) ?? { from: null, to: null };
	let range: DateRangeValue = $state(seededRange);
	// The typed text of the injected input's boxes: what apply reads (the
	// same lenient parse as DateInput's), so a box that was never committed
	// still counts.
	const rangeText = { from: seededRange.from ?? '', to: seededRange.to ?? '' };
	let nativeToEl: HTMLInputElement | undefined = $state();
	let rangeError: string | null = $state(null);
	const errorId = `${instanceId}-filter-error`;

	/** One end as a canonical day, `null` when empty, `undefined` when it is not a date. */
	function readEnd(end: 'from' | 'to'): string | null | undefined {
		if (dateRangeInput) {
			const text = rangeText[end];
			if (text.trim() === '') return null;
			return parseDateText(text) ?? undefined;
		}
		const el = end === 'from' ? valueEl : nativeToEl;
		// A half-typed native date reads as '' - `badInput` tells it apart.
		if (el?.validity.badInput) return undefined;
		return el?.value ? el.value : null;
	}

	function applyRange() {
		const from = readEnd('from');
		const to = readEnd('to');
		if (from === undefined || to === undefined) {
			rangeError = t.filterRangeInvalid();
			return;
		}
		if (from === null && to === null) {
			onClear();
			return;
		}
		if (from !== null && to !== null && to < from) {
			rangeError = t.filterRangeOrder();
			return;
		}
		onApply({ field: column.id, op: 'between', value: dateRangeToBetween({ from, to }) });
	}

	function handleRangeKeydown(event: KeyboardEvent) {
		if (
			event.key === 'Enter' &&
			!event.isComposing &&
			event.keyCode !== 229 &&
			!event.defaultPrevented
		) {
			// As the text input below: cancel the native Enter before applying.
			event.preventDefault();
			applyRange();
		}
	}

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
		if (isRange) {
			applyRange();
			return;
		}
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
	class:filter-popover--range={isRange}
	bind:this={rootEl}
	role="dialog"
	aria-label={t.filterAriaLabel(column.header.trim() || column.id)}
>
	{#if isRange}
		{@const DateRange = dateRangeInput}
		{#if DateRange}
			<DateRange
				bind:fromInputEl={() => valueEl, (el) => (valueEl = el)}
				value={range}
				onValueChange={(next) => {
					// A component that only reports values (no `onTextInput`) is
					// read through them; a later keystroke overrides.
					for (const end of ['from', 'to'] as const) {
						if (next[end] !== range[end]) rangeText[end] = next[end] ?? '';
					}
					range = next;
				}}
				onTextInput={(end, text) => {
					rangeText[end] = text;
					rangeError = null;
				}}
				label={t.filterRangeLabel()}
				describedBy={rangeError ? errorId : undefined}
				invalid={!!rangeError}
				orientation="vertical"
				onkeydown={handleRangeKeydown}
			/>
		{:else}
			<div class="filter-range" role="group" aria-label={t.filterRangeLabel()}>
				<input
					bind:this={valueEl}
					type="date"
					aria-label={t.filterRangeStart()}
					aria-describedby={rangeError ? errorId : undefined}
					aria-invalid={rangeError ? 'true' : undefined}
					value={range.from ?? ''}
					oninput={() => (rangeError = null)}
					onkeydown={handleRangeKeydown}
				/>
				<input
					bind:this={nativeToEl}
					type="date"
					aria-label={t.filterRangeEnd()}
					aria-describedby={rangeError ? errorId : undefined}
					aria-invalid={rangeError ? 'true' : undefined}
					value={range.to ?? ''}
					oninput={() => (rangeError = null)}
					onkeydown={handleRangeKeydown}
				/>
			</div>
		{/if}
		{#if rangeError}
			<p id={errorId} class="filter-error" role="alert">{rangeError}</p>
		{/if}
	{:else}
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
	{/if}
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
		gap: var(--banto-space-2);
		width: 190px;
		padding: var(--banto-space-2);
		background: var(--banto-surface-overlay);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		box-shadow: var(--banto-shadow-lg);
		/* Standard preset: no-op (var(--banto-backdrop) is `none`). Glass
		   preset opts in by overriding --banto-backdrop (spec §9). */
		backdrop-filter: var(--banto-backdrop, none);
	}

	.filter-popover--range {
		/* Room for a date text box and its calendar button (the shape of the
		   popover, not a dimension step). */
		width: 220px;
	}

	.filter-range {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
	}

	.filter-error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
	}

	select,
	input {
		width: 100%;
		box-sizing: border-box;
		height: var(--banto-control-height-sm);
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface);
		color: var(--banto-text);
		font-size: var(--banto-font-size-sm);
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
		gap: var(--banto-space-2);
		justify-content: flex-end;
	}

	button {
		box-sizing: border-box;
		height: var(--banto-control-height-sm);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		padding: 0 var(--banto-space-2);
		font-size: var(--banto-font-size-sm);
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
