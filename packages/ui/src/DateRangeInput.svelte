<script lang="ts">
	/**
	 * Date range input (docs/design/date-time-pickers.md §5.4 / §5.9, D13,
	 * PR-6): two `DateInput`s - the start day and the end day, both inclusive -
	 * grouped by `role="group"` and named by `label` / `labelledBy`. Each box
	 * is named `dateRangeStart` / `dateRangeEnd` and keeps all of DateInput's
	 * behaviour (lenient typing, the calendar popover, Esc closing only the
	 * popover). The range between the two days is not highlighted (D13).
	 *
	 * The value is `{ from, to }`, canonical `YYYY-MM-DD` or `null` (an open
	 * end). The component does not check `from <= to` - the host decides how
	 * to show that (a filter refuses it, a form validates it, D14) - and it
	 * does not turn the inclusive end into a half-open one: that is the
	 * grid's `dateRangeToBetween` (one place, §5.9).
	 *
	 * Promises to a host with its own key / blur handling, as DateInput's
	 * (§5.8): keys inside a calendar do not propagate; keys a text box handles
	 * itself are `preventDefault`ed before `onkeydown`; `onblur` fires only
	 * when focus leaves the whole range (not when it moves from one box to
	 * the other); `pointerdown` does not propagate out of the group.
	 */
	import DateInput from './DateInput.svelte';
	import { defaultUiMessages, type UiMessages } from './messages';
	import { stopPointerdown } from './stopPointerdown';

	/** A day range: inclusive canonical `YYYY-MM-DD` ends, `null` when open. */
	interface DateRange {
		from: string | null;
		to: string | null;
	}

	interface Props {
		/** The range (bindable). */
		value?: DateRange;
		/** Called with the new range when either end's value changes. */
		onValueChange?: (value: DateRange) => void;
		/** Every change of either box's typed text (see DateInput's `onTextInput`). */
		onTextInput?: (end: 'from' | 'to', text: string) => void;
		/** id of the group. */
		id?: string;
		/** Accessible name of the group (`aria-label`); `labelledBy` wins. */
		label?: string;
		/** id of the element that names the group (`aria-labelledby`). */
		labelledBy?: string;
		/** Extra ids for both text boxes' `aria-describedby` (an error message). */
		describedBy?: string;
		invalid?: boolean;
		disabled?: boolean;
		readonly?: boolean;
		/** Earliest selectable day for both ends (canonical, inclusive). */
		min?: string;
		/** Latest selectable day for both ends (canonical, inclusive). */
		max?: string;
		isDateDisabled?: (date: string) => boolean;
		/** BCP 47 tag for the month / weekday names (default `'ja-JP'`, D15). */
		locale?: string;
		weekStartsOn?: number;
		messages?: UiMessages;
		/** `horizontal` (default): side by side with a dash; `vertical`: stacked (a narrow popover). */
		orientation?: 'horizontal' | 'vertical';
		/** Keys from either text box (after DateInput handled its own). */
		onkeydown?: (event: KeyboardEvent) => void;
		/** Focus left the whole range. */
		onblur?: (event: FocusEvent) => void;
		/** The start day's text box (bindable). */
		fromInputEl?: HTMLInputElement;
		/** The end day's text box (bindable). */
		toInputEl?: HTMLInputElement;
	}

	let {
		value = $bindable({ from: null, to: null }),
		onValueChange,
		onTextInput,
		id,
		label,
		labelledBy,
		describedBy,
		invalid = false,
		disabled = false,
		readonly = false,
		min,
		max,
		isDateDisabled,
		locale = 'ja-JP',
		weekStartsOn,
		messages,
		orientation = 'horizontal',
		onkeydown,
		onblur,
		fromInputEl = $bindable(),
		toInputEl = $bindable()
	}: Props = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });

	let rootEl: HTMLDivElement | undefined = $state();

	function setEnd(end: 'from' | 'to', next: string | null): void {
		const current = value ?? { from: null, to: null };
		if (current[end] === next) return;
		const updated = { ...current, [end]: next };
		value = updated;
		onValueChange?.(updated);
	}

	/** A box's blur reaches the host only when focus left the group (promise 3). */
	function handleBlur(event: FocusEvent): void {
		const next = event.relatedTarget;
		if (next instanceof Node && rootEl?.contains(next)) return;
		onblur?.(event);
	}
</script>

<!-- Promise 4 for the gap and the dash between the boxes (each DateInput
	already stops it at its own root). -->
<div
	bind:this={rootEl}
	{@attach stopPointerdown}
	{id}
	class="date-range-input"
	class:date-range-input--vertical={orientation === 'vertical'}
	role="group"
	aria-label={labelledBy ? undefined : label}
	aria-labelledby={labelledBy}
>
	<DateInput
		bind:inputEl={fromInputEl}
		value={value?.from ?? null}
		onValueChange={(next) => setEnd('from', next)}
		onTextInput={(text) => onTextInput?.('from', text)}
		label={t.dateRangeStart()}
		{describedBy}
		{invalid}
		{disabled}
		{readonly}
		{min}
		{max}
		{isDateDisabled}
		{locale}
		{weekStartsOn}
		{messages}
		{onkeydown}
		onblur={handleBlur}
	/>
	{#if orientation === 'horizontal'}
		<span class="date-range-input-dash" aria-hidden="true">–</span>
	{/if}
	<DateInput
		bind:inputEl={toInputEl}
		value={value?.to ?? null}
		onValueChange={(next) => setEnd('to', next)}
		onTextInput={(text) => onTextInput?.('to', text)}
		label={t.dateRangeEnd()}
		{describedBy}
		{invalid}
		{disabled}
		{readonly}
		{min}
		{max}
		{isDateDisabled}
		{locale}
		{weekStartsOn}
		{messages}
		{onkeydown}
		onblur={handleBlur}
	/>
</div>

<style>
	.date-range-input {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.date-range-input--vertical {
		display: flex;
		flex-direction: column;
		align-items: stretch;
	}

	.date-range-input-dash {
		color: var(--banto-text-muted);
	}
</style>
