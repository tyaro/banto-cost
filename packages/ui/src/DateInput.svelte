<script lang="ts">
	/**
	 * Date input: a text box you can type into plus a button that opens a
	 * calendar popover (docs/design/date-time-pickers.md §5.2-§5.6, PR-1). The
	 * value is the canonical `YYYY-MM-DD` or `null` (§5.1, D6); typed text is
	 * parsed leniently on blur / Enter (`parseDateText`, D7) and the box is
	 * rewritten to the canonical form; text that does not parse is left as is
	 * (the value does not change - the parent decides how to show it, `invalid`).
	 *
	 * Popover (APG Date Picker Dialog, §5.4): `role="dialog"` +
	 * `aria-modal="true"` + `attachFocusTrap`, in the browser's top layer
	 * (`popover="manual"`, so it never closes another `auto` popover and its
	 * light dismiss is ours: a pointerdown outside closes it), placed by
	 * `anchoredPopover.ts` (shared with Menu), closed on an ancestor scroll.
	 * Esc goes through one function, `closeOnEscape` (layering.ts rules 1-2),
	 * from the popover's keydown and from the window (rule 3); a capture-phase
	 * window listener is not used (§5.4). Closing returns focus to the text box
	 * (D10).
	 *
	 * Promises to a host that runs its own key / blur state machine (§5.8, the
	 * grid cell editor of PR-4):
	 * 1. Keys inside the popover are handled here and do not propagate (a
	 *    native listener on the popover - the popover is a DOM child of the
	 *    component, so they would otherwise reach the host's container).
	 * 2. Keys the text box handles itself (Alt+ArrowDown, Esc while open) are
	 *    `preventDefault`ed before `onkeydown` gets them; everything else is
	 *    passed through untouched (Enter with the popover closed commits the
	 *    text first, then reaches `onkeydown` as usual).
	 * 3. `onblur` fires only when focus leaves the whole component (box,
	 *    button and popover), after the text is committed.
	 * 4. `pointerdown` does not propagate out of the component's root.
	 *
	 * No dependency, no package import, no locale branch: names come from
	 * `Intl` with the `locale` prop (§5.5), text from `messages` (conventions
	 * §13).
	 */
	import { flushSync, untrack } from 'svelte';
	import { computeAnchoredPosition, watchAnchoredPopover } from './anchoredPopover';
	import {
		clampDate,
		formatFullDate,
		isBlankDateText,
		isIsoDate,
		isOutOfRange,
		parseDateText,
		resolveWeekStart,
		todayDate
	} from './datetime';
	import Calendar from './icons/Calendar.svelte';
	import { attachFocusTrap, hasVisibleLayerAbove } from './layering';
	import { defaultUiMessages, type UiMessages } from './messages';
	import MonthCalendar from './MonthCalendar.svelte';
	import { stopPointerdown } from './stopPointerdown';

	interface Props {
		/** Canonical `YYYY-MM-DD`, or `null` (`''` is read as empty too). */
		value?: string | null;
		/** Called with the new value (canonical or `null`) when it changes. */
		onValueChange?: (value: string | null) => void;
		/** Typed text owned by the parent (a draft). Omitted: the component keeps it. */
		text?: string;
		/** Every change of the typed text, including the canonical rewrite on commit. */
		onTextInput?: (text: string) => void;
		/** id of the text box. */
		id?: string;
		/** Accessible name of the text box (`aria-label`); omit when a `<label for={id}>` names it. */
		label?: string;
		/** Extra ids for the text box's `aria-describedby` (the format hint is always included). */
		describedBy?: string;
		invalid?: boolean;
		disabled?: boolean;
		readonly?: boolean;
		/** Earliest selectable day (canonical, inclusive). */
		min?: string;
		/** Latest selectable day (canonical, inclusive). */
		max?: string;
		/** Days that can be focused but not picked in the calendar (weekends, holidays). */
		isDateDisabled?: (date: string) => boolean;
		/** BCP 47 tag for the month / weekday names (default `'ja-JP'`, D15). */
		locale?: string;
		/** First day of the week, 0 = Sunday ... 6 = Saturday. Default: the locale's, else Sunday. */
		weekStartsOn?: number;
		messages?: UiMessages;
		/** Keys from the text box (see promise 2 in the module doc). */
		onkeydown?: (event: KeyboardEvent) => void;
		/** Focus left the whole component (promise 3). */
		onblur?: (event: FocusEvent) => void;
		/** The text box (bindable) - where a host returns focus. */
		inputEl?: HTMLInputElement;
	}

	let {
		value = $bindable(null),
		onValueChange,
		text,
		onTextInput,
		id,
		label,
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
		onkeydown,
		onblur,
		inputEl = $bindable()
	}: Props = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });
	const uid = $props.id();
	const hintId = `${uid}-hint`;

	// --- text and value --------------------------------------------------

	let ownText = $state(untrack(() => value ?? ''));
	// The value last mirrored into `ownText`, so a parent's change of `value`
	// rewrites the box but the component's own commit does not run twice.
	let mirroredValue: string | null | undefined = untrack(() => value);
	$effect(() => {
		const current = value;
		if (current === mirroredValue) return;
		mirroredValue = current;
		ownText = current ?? '';
	});

	const shownText = $derived(text ?? ownText);
	const selectedDate = $derived(value && isIsoDate(value) ? value : null);

	function setText(next: string): void {
		ownText = next;
		onTextInput?.(next);
	}

	function setValue(next: string | null): void {
		const current = isBlankDateText(value) ? null : value;
		if (next === current) return;
		mirroredValue = next;
		value = next;
		onValueChange?.(next);
	}

	/** Parse the typed text (blur, Enter): canonical -> value, blank -> null, otherwise leave both alone. */
	function commit(): void {
		const raw = shownText;
		let next: string | null = null;
		if (!isBlankDateText(raw)) {
			next = parseDateText(raw);
			if (next === null) return;
		}
		if ((next ?? '') !== raw) setText(next ?? '');
		setValue(next);
	}

	// --- popover ---------------------------------------------------------

	let rootEl: HTMLDivElement | undefined = $state();
	let fieldEl: HTMLDivElement | undefined = $state();
	let panelEl: HTMLDivElement | undefined = $state();
	let buttonEl: HTMLButtonElement | undefined = $state();
	let open = $state(false);
	let coords = $state<{ top: number; left: number } | undefined>(undefined);
	let focusDate = $state('');
	let today = $state('');
	let detachTrap: (() => void) | undefined;
	let calendar: ReturnType<typeof MonthCalendar> | undefined = $state();

	const weekStart = $derived(resolveWeekStart(locale, weekStartsOn));
	const buttonLabel = $derived(
		selectedDate ? t.datePickerChange(formatFullDate(selectedDate, locale)) : t.datePickerOpen()
	);

	function isSelectable(date: string): boolean {
		return !isOutOfRange(date, min, max) && !isDateDisabled?.(date);
	}

	/** Value's day (or the typed one) -> today -> moved into [min, max] (§5.4). */
	function initialFocusDate(): string {
		const typed = isBlankDateText(shownText) ? null : parseDateText(shownText);
		return clampDate(typed ?? selectedDate ?? today, min, max);
	}

	function reposition(): void {
		if (!fieldEl || !panelEl) return;
		coords = computeAnchoredPosition(fieldEl, panelEl, 'bottom-start');
	}

	function openPicker(): void {
		if (open || disabled || readonly) return;
		today = todayDate();
		focusDate = initialFocusDate();
		open = true;
		// Render the popover, show it, measure it, then make it visible
		// (`coords`) - a still-hidden cell cannot take focus. It exists only
		// while open, so a closed picker leaves no `role="dialog"` in the page.
		flushSync();
		if (!panelEl) return;
		panelEl.showPopover();
		reposition();
		flushSync();
		detachTrap = attachFocusTrap(panelEl);
		calendar?.focusCell();
	}

	function closePicker(focusInput: boolean): void {
		if (!open) return;
		// Trap off first: focusing the box from inside the dialog must not be
		// pulled back. Then focus the box before hiding, so focus never drops
		// to <body> (which would read as "left the component", promise 3).
		detachTrap?.();
		detachTrap = undefined;
		if (focusInput) inputEl?.focus({ preventScroll: true });
		try {
			panelEl?.hidePopover();
		} catch {
			// Already hidden (removed from the top layer by the browser).
		}
		open = false;
		coords = undefined;
	}

	/** The one Esc path (§5.4): yields to a consumed Esc and to a layer above. */
	function closeOnEscape(event: KeyboardEvent): void {
		if (!open || event.key !== 'Escape') return;
		if (event.defaultPrevented || hasVisibleLayerAbove({ except: panelEl })) return;
		event.preventDefault();
		closePicker(true);
	}

	function select(date: string): void {
		if (!isSelectable(date)) return;
		setText(date);
		setValue(date);
		closePicker(true);
	}

	function clear(): void {
		setText('');
		setValue(null);
		closePicker(true);
	}

	// Promise 1: a native listener (Svelte delegates `onkeydown` to the app
	// root, past a host's own native listeners), so stopPropagation here
	// keeps every key inside. The calendar's own grid listener runs first
	// (arrows, Enter). Promise 4 the same way for pointerdown.
	function handlePanelKeydown(event: KeyboardEvent): void {
		closeOnEscape(event);
		event.stopPropagation();
	}

	$effect(() => {
		const panel = panelEl;
		if (!panel) return;
		panel.addEventListener('keydown', handlePanelKeydown);
		return () => panel.removeEventListener('keydown', handlePanelKeydown);
	});

	$effect(() => {
		if (!open) return;
		// Light dismiss (manual popover): a pointerdown outside the popover
		// closes it. The button is left to its own click (toggle).
		function handleDocumentPointerDown(event: PointerEvent): void {
			const target = event.target;
			if (target instanceof Node && (panelEl?.contains(target) || buttonEl?.contains(target))) {
				return;
			}
			// Park focus on the text box first: the click then moves it on from
			// there, so a host sees one ordinary blur from the component (focus
			// on a day cell that is hidden / removed would drop to <body>
			// without any focusout).
			closePicker(true);
		}
		document.addEventListener('pointerdown', handleDocumentPointerDown, true);
		const unwatch = watchAnchoredPopover(panelEl, {
			reposition,
			close: () => closePicker(!!panelEl?.contains(document.activeElement))
		});
		return () => {
			document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
			unwatch();
		};
	});

	// Unmounted while open (a grid row scrolled away): drop the trap's listeners.
	$effect(() => () => detachTrap?.());

	function handleButtonClick(): void {
		if (open) closePicker(true);
		else openPicker();
	}

	function handleButtonMousedown(event: MouseEvent): void {
		// While open, keep focus in the dialog until the click closes it (a
		// focus move to the button would trip the focus trap's pull-back).
		if (open) event.preventDefault();
	}

	function handleInputKeydown(event: KeyboardEvent): void {
		if (!event.isComposing) {
			if (event.key === 'ArrowDown' && event.altKey) {
				event.preventDefault();
				openPicker();
			} else if (event.key === 'Escape') {
				closeOnEscape(event);
			} else if (event.key === 'Enter' && !open) {
				commit();
			}
		}
		onkeydown?.(event);
	}

	function handleFocusOut(event: FocusEvent): void {
		const next = event.relatedTarget;
		if (next instanceof Node && rootEl?.contains(next)) return;
		closePicker(false);
		commit();
		onblur?.(event);
	}
</script>

<svelte:window onkeydown={closeOnEscape} />

<div class="date-input" bind:this={rootEl} {@attach stopPointerdown} onfocusout={handleFocusOut}>
	<div class="date-input-field" class:date-input-field--invalid={invalid} bind:this={fieldEl}>
		<input
			bind:this={inputEl}
			{id}
			class="date-input-text"
			type="text"
			autocomplete="off"
			spellcheck="false"
			aria-label={label}
			aria-describedby={describedBy ? `${hintId} ${describedBy}` : hintId}
			aria-invalid={invalid ? 'true' : undefined}
			{disabled}
			{readonly}
			value={shownText}
			oninput={(event) => setText(event.currentTarget.value)}
			onkeydown={handleInputKeydown}
		/>
		<button
			bind:this={buttonEl}
			type="button"
			class="date-input-button"
			aria-label={buttonLabel}
			title={buttonLabel}
			aria-haspopup="dialog"
			aria-expanded={open}
			disabled={disabled || readonly}
			onmousedown={handleButtonMousedown}
			onclick={handleButtonClick}
		>
			<Calendar size={16} aria-hidden="true" />
		</button>
	</div>
	<span id={hintId} class="date-input-hint">{t.dateFormatHint()}</span>

	{#if open}
		<div
			bind:this={panelEl}
			popover="manual"
			role="dialog"
			aria-modal="true"
			aria-label={t.datePickerDialog()}
			tabindex="-1"
			class="date-picker"
			style:top={coords ? `${coords.top}px` : undefined}
			style:left={coords ? `${coords.left}px` : undefined}
			style:visibility={coords ? 'visible' : 'hidden'}
			onmousedown={(event) => {
				// A press on something that cannot take focus (heading, weekday
				// header, gaps) would focus the dialog itself and strand the
				// arrow keys: keep focus where it is (the tracked day).
				const target = event.target;
				if (!(target instanceof Element) || !target.closest('button, td[tabindex]')) {
					event.preventDefault();
				}
			}}
		>
			{#if focusDate}
				<MonthCalendar
					bind:this={calendar}
					bind:focusDate
					{selectedDate}
					{today}
					{min}
					{max}
					{isDateDisabled}
					{locale}
					{weekStart}
					{t}
					scroller={panelEl}
					onPick={select}
				/>

				<div class="date-picker-footer">
					<button
						type="button"
						class="date-picker-action"
						aria-disabled={isSelectable(today) ? undefined : 'true'}
						onclick={() => select(today)}
					>
						{t.datePickerToday()}
					</button>
					<button type="button" class="date-picker-action" onclick={clear}>
						{t.datePickerClear()}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.date-input {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		inline-size: var(--banto-date-input-width, 11em);
		max-inline-size: 100%;
	}

	.date-input-field {
		display: flex;
		align-items: stretch;
		min-inline-size: 0;
	}

	.date-input-text {
		flex: 1 1 auto;
		min-inline-size: 0;
		block-size: var(--banto-control-height);
		box-sizing: border-box;
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-inline-end: none;
		border-start-start-radius: var(--banto-radius-md);
		border-end-start-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font: inherit;
		font-variant-numeric: tabular-nums;
	}

	.date-input-button {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		inline-size: var(--banto-control-height);
		block-size: var(--banto-control-height);
		box-sizing: border-box;
		padding: 0;
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-start-end-radius: var(--banto-radius-md);
		border-end-end-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
	}

	.date-input-field--invalid .date-input-text,
	.date-input-field--invalid .date-input-button {
		border-color: var(--banto-danger);
	}

	.date-input-button:hover:not(:disabled) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.date-input-text:focus-visible,
	.date-input-button:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.date-input-text:disabled,
	.date-input-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Read with the text box only (aria-describedby). */
	.date-input-hint {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.date-picker {
		/* Shape of the calendar (§9: a part's own size, not a dimension step):
		   one day cell, shrunk so 7 of them plus the padding fit a 320px
		   viewport at 200% text. */
		--banto-date-cell-size: min(
			2.25rem,
			calc((100vw - 2 * var(--banto-space-3) - var(--banto-space-4)) / 7)
		);
		position: fixed;
		inset: auto;
		margin: 0;
		box-sizing: border-box;
		max-inline-size: calc(100vw - 2 * var(--banto-space-1));
		padding: var(--banto-space-3);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface-overlay);
		box-shadow: var(--banto-shadow-lg);
		color: var(--banto-text);
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
		overflow: auto;
		overscroll-behavior: contain;
	}

	.date-picker:focus {
		outline: none;
	}

	.date-picker-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: var(--banto-text-muted);
		font: inherit;
		cursor: pointer;
	}

	.date-picker-action {
		padding: var(--banto-space-1) var(--banto-space-2);
		color: var(--banto-primary-text);
		font-size: var(--banto-font-size-md);
	}

	.date-picker-action:hover:not([aria-disabled='true']) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.date-picker-action[aria-disabled='true'] {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.date-picker-action:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.date-picker-footer {
		display: flex;
		justify-content: space-between;
		margin-block-start: var(--banto-space-2);
	}

	@media (forced-colors: active) {
		.date-picker-action:focus-visible,
		.date-input-text:focus-visible,
		.date-input-button:focus-visible {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
