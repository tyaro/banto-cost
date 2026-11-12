<script lang="ts">
	/**
	 * The month calendar inside the date pickers' dialog (internal, not
	 * exported): the month / year buttons, the heading and the day grid of
	 * docs/design/date-time-pickers.md §5.4 (APG Date Picker Dialog). Shared
	 * by `DateInput` (PR-1) and `DateTimeInput` (PR-5); the dialog itself -
	 * the popover, the focus trap, Esc, the footer - stays with them.
	 *
	 * - `focusDate` (bindable) is the tracked day: the one cell in the tab
	 *   order (roving tabindex), and the month shown. The parent sets it when
	 *   the dialog opens and calls `focusCell()` once the cells exist.
	 * - The grid's keys (arrows, Home / End, PageUp / PageDown with Shift for
	 *   a year, Enter / Space) are handled by a native listener on the grid,
	 *   so they run before the dialog's own native keydown listener (which
	 *   stops every key, §5.8 promise 1). Enter / Space and a click pick a
	 *   selectable day through `onPick`; what picking means is the parent's.
	 */
	import { flushSync } from 'svelte';
	import { revealInPopover } from './anchoredPopover';
	import {
		addDays,
		addMonths,
		addYears,
		clampDate,
		endOfWeek,
		formatFullDate,
		formatMonthYear,
		isOutOfRange,
		isSameMonth,
		monthGrid,
		startOfWeek,
		weekdayNames,
		type Weekday
	} from './datetime';
	import ChevronLeft from './icons/ChevronLeft.svelte';
	import ChevronRight from './icons/ChevronRight.svelte';
	import ChevronsLeft from './icons/ChevronsLeft.svelte';
	import ChevronsRight from './icons/ChevronsRight.svelte';
	import type { UiMessages } from './messages';

	interface Props {
		/** The tracked day (canonical `YYYY-MM-DD`). */
		focusDate: string;
		/** The day shown as chosen (`aria-selected`), or `null`. */
		selectedDate: string | null;
		/** Today's date (`aria-current="date"`). */
		today: string;
		/** Earliest day that can be tracked and picked (canonical, inclusive). */
		min?: string;
		/** Latest day that can be tracked and picked (canonical, inclusive). */
		max?: string;
		/** Days that can be focused but not picked. */
		isDateDisabled?: (date: string) => boolean;
		locale: string;
		weekStart: Weekday;
		/** Resolved messages (the parent's defaults merged with its `messages`). */
		t: Required<UiMessages>;
		/** The dialog that scrolls when its height is capped (where a focused day is revealed). */
		scroller?: HTMLElement;
		/** A selectable day was picked (Enter / Space / click). */
		onPick: (date: string) => void;
	}

	let {
		focusDate = $bindable(),
		selectedDate,
		today,
		min,
		max,
		isDateDisabled,
		locale,
		weekStart,
		t,
		scroller,
		onPick
	}: Props = $props();

	const uid = $props.id();
	const headingId = `${uid}-heading`;

	let gridEl: HTMLTableElement | undefined = $state();

	const weekdays = $derived(weekdayNames(locale, weekStart));
	const weeks = $derived(focusDate ? monthGrid(focusDate, weekStart) : []);

	export function isSelectable(date: string): boolean {
		return !isOutOfRange(date, min, max) && !isDateDisabled?.(date);
	}

	/** Focus the tracked day's cell (after the cells were rendered). */
	export function focusCell(): void {
		const cell = gridEl?.querySelector<HTMLElement>(`[data-date="${focusDate}"]`);
		if (!cell) return;
		// `preventScroll`: never scroll the page / ancestors (an ancestor scroll
		// would close the popover). But when `computeAnchoredPosition` capped the
		// dialog's height (a short viewport) the dialog scrolls inside, so bring
		// the focused day into its visible box by hand - `scrollIntoView` would
		// move the ancestors too.
		cell.focus({ preventScroll: true });
		if (scroller) revealInPopover(scroller, cell);
	}

	function moveFocus(date: string): void {
		focusDate = clampDate(date, min, max);
		flushSync();
		focusCell();
	}

	/**
	 * A click on a cell: move the tracked day there (the view follows into a
	 * neighbouring month) and focus it, then pick it if it can be picked. A
	 * cell that cannot be tracked (empty slot, outside [min, max]) only puts
	 * focus back on the tracked day. Either way focus ends on the focusDate
	 * cell (or wherever the parent's `onPick` moves it).
	 */
	function handleDayClick(date: string | null): void {
		if (date === null || isOutOfRange(date, min, max)) {
			focusCell();
			return;
		}
		moveFocus(date);
		if (isSelectable(date)) onPick(date);
	}

	/** Month / year buttons: the target moved into range; disabled when that stays in this month. */
	function navTarget(months: number): string {
		return clampDate(addMonths(focusDate, months), min, max);
	}

	function navDisabled(months: number): boolean {
		return isSameMonth(navTarget(months), focusDate);
	}

	function navigate(months: number): void {
		if (navDisabled(months)) return;
		focusDate = navTarget(months);
	}

	function handleGridKey(event: KeyboardEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLElement) || !target.dataset.date) return;
		let next: string | undefined;
		switch (event.key) {
			case 'ArrowLeft':
				next = addDays(focusDate, -1);
				break;
			case 'ArrowRight':
				next = addDays(focusDate, 1);
				break;
			case 'ArrowUp':
				next = addDays(focusDate, -7);
				break;
			case 'ArrowDown':
				next = addDays(focusDate, 7);
				break;
			case 'Home':
				next = startOfWeek(focusDate, weekStart);
				break;
			case 'End':
				next = endOfWeek(focusDate, weekStart);
				break;
			case 'PageUp':
				next = event.shiftKey ? addYears(focusDate, -1) : addMonths(focusDate, -1);
				break;
			case 'PageDown':
				next = event.shiftKey ? addYears(focusDate, 1) : addMonths(focusDate, 1);
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				if (isSelectable(focusDate)) onPick(focusDate);
				return;
			default:
				return;
		}
		event.preventDefault();
		moveFocus(next);
	}

	// A native listener: it runs before the dialog's own native keydown
	// listener, which stops every key (Svelte would delegate `onkeydown` to
	// the app root, past that listener).
	$effect(() => {
		const grid = gridEl;
		if (!grid) return;
		grid.addEventListener('keydown', handleGridKey);
		return () => grid.removeEventListener('keydown', handleGridKey);
	});
</script>

<div class="date-picker-header">
	<button
		type="button"
		class="date-picker-nav"
		aria-label={t.datePickerPrevYear()}
		title={t.datePickerPrevYear()}
		aria-disabled={navDisabled(-12) ? 'true' : undefined}
		onclick={() => navigate(-12)}
	>
		<ChevronsLeft size={16} aria-hidden="true" />
	</button>
	<button
		type="button"
		class="date-picker-nav"
		aria-label={t.datePickerPrevMonth()}
		title={t.datePickerPrevMonth()}
		aria-disabled={navDisabled(-1) ? 'true' : undefined}
		onclick={() => navigate(-1)}
	>
		<ChevronLeft size={16} aria-hidden="true" />
	</button>
	<h2 id={headingId} class="date-picker-heading" aria-live="polite">
		{formatMonthYear(focusDate, locale)}
	</h2>
	<button
		type="button"
		class="date-picker-nav"
		aria-label={t.datePickerNextMonth()}
		title={t.datePickerNextMonth()}
		aria-disabled={navDisabled(1) ? 'true' : undefined}
		onclick={() => navigate(1)}
	>
		<ChevronRight size={16} aria-hidden="true" />
	</button>
	<button
		type="button"
		class="date-picker-nav"
		aria-label={t.datePickerNextYear()}
		title={t.datePickerNextYear()}
		aria-disabled={navDisabled(12) ? 'true' : undefined}
		onclick={() => navigate(12)}
	>
		<ChevronsRight size={16} aria-hidden="true" />
	</button>
</div>

<table class="date-picker-grid" role="grid" aria-labelledby={headingId} bind:this={gridEl}>
	<thead>
		<tr>
			{#each weekdays as day (day.weekday)}
				<th scope="col" abbr={day.long}>{day.short}</th>
			{/each}
		</tr>
	</thead>
	<tbody>
		<!-- Keyed by position on purpose: the cells are reused across months,
		     so the focused one is never removed mid-move (a removed focus target
		     would read as "focus left the component"). -->
		{#each weeks as week, w (w)}
			<tr>
				{#each week as date, d (d)}
					<!-- One <td> per position whether it holds a day or an empty slot
					     (before 0001-01-01 / after 9999-12-31), so a month change never
					     replaces the element that has focus. -->
					<td
						data-date={date ?? undefined}
						tabindex={date === null ? undefined : date === focusDate ? 0 : -1}
						aria-label={date === null ? undefined : formatFullDate(date, locale)}
						aria-selected={date === null ? undefined : date === selectedDate ? 'true' : 'false'}
						aria-current={date !== null && date === today ? 'date' : undefined}
						aria-disabled={date === null || isSelectable(date) ? undefined : 'true'}
						class:date-picker-day--outside={date !== null && !isSameMonth(date, focusDate)}
						class:date-picker-day--empty={date === null}
						onmousedown={(event) => {
							// An empty slot or a day outside [min, max] cannot be focused:
							// keep focus on the tracked day, so focusDate and the focused
							// cell never part ways.
							if (date === null || isOutOfRange(date, min, max)) event.preventDefault();
						}}
						onclick={() => handleDayClick(date)}
					>
						{date === null ? '' : Number(date.slice(8))}
					</td>
				{/each}
			</tr>
		{/each}
	</tbody>
</table>

<style>
	.date-picker-header {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		margin-block-end: var(--banto-space-2);
	}

	.date-picker-heading {
		flex: 1 1 auto;
		margin: 0;
		font-size: var(--banto-font-size-md);
		font-weight: 600;
		text-align: center;
		white-space: nowrap;
	}

	.date-picker-nav {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		inline-size: var(--banto-control-height-sm);
		block-size: var(--banto-control-height-sm);
		padding: 0;
		border: none;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: var(--banto-text-muted);
		font: inherit;
		cursor: pointer;
	}

	.date-picker-nav:hover:not([aria-disabled='true']) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.date-picker-nav[aria-disabled='true'] {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.date-picker-nav:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* The grid is exactly seven cells wide, and on a narrow screen with large
	   text the labels shrink with the cell: a wide font's "30" at 200% is wider
	   than the cell and would push the table out of its popover. */
	.date-picker-grid {
		table-layout: fixed;
		inline-size: calc(7 * var(--banto-date-cell-size));
		border-collapse: collapse;
		margin-inline: auto;
	}

	.date-picker-grid th {
		block-size: var(--banto-date-cell-size);
		padding: 0;
		color: var(--banto-text-muted);
		font-size: min(var(--banto-font-size-sm), calc(var(--banto-date-cell-size) / 2.4));
		font-weight: 500;
		text-align: center;
	}

	.date-picker-grid td {
		inline-size: var(--banto-date-cell-size);
		block-size: var(--banto-date-cell-size);
		padding: 0;
		border-radius: var(--banto-radius-sm);
		font-size: min(1em, calc(var(--banto-date-cell-size) / 1.4));
		font-variant-numeric: tabular-nums;
		text-align: center;
		cursor: pointer;
	}

	.date-picker-grid td.date-picker-day--outside {
		color: var(--banto-text-muted);
	}

	.date-picker-grid td.date-picker-day--empty {
		cursor: default;
	}

	.date-picker-grid td:hover:not([aria-disabled='true'], .date-picker-day--empty) {
		background: var(--banto-surface-hover);
	}

	.date-picker-grid td[aria-current='date'] {
		box-shadow: inset 0 0 0 var(--banto-border-width) var(--banto-border-strong);
		font-weight: 600;
	}

	.date-picker-grid td[aria-selected='true'] {
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
	}

	.date-picker-grid td[aria-disabled='true'] {
		color: var(--banto-text-muted);
		text-decoration: line-through;
		opacity: 0.55;
		cursor: not-allowed;
	}

	.date-picker-grid td:focus {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.date-picker-grid td[aria-current='date']:focus {
		box-shadow:
			inset 0 0 0 var(--banto-border-width) var(--banto-border-strong),
			var(--banto-focus-ring);
	}

	@media (forced-colors: active) {
		.date-picker-grid td[aria-selected='true'] {
			forced-color-adjust: none;
			background: Highlight;
			color: HighlightText;
		}

		.date-picker-grid td[aria-current='date'] {
			outline: var(--banto-border-width) solid CanvasText;
			outline-offset: calc(-1 * var(--banto-border-width));
		}

		.date-picker-grid td[aria-disabled='true'] {
			color: GrayText;
		}

		.date-picker-grid td:focus,
		.date-picker-nav:focus-visible {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
