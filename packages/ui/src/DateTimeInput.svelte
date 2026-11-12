<script lang="ts">
	/**
	 * Date and time input: one text box plus a button that opens one dialog
	 * holding the month calendar and a list of times
	 * (docs/design/date-time-pickers.md §5.2-§5.6, D5-a, PR-5). The value is
	 * the canonical `YYYY-MM-DDTHH:mm` - a wall-clock time with no time zone
	 * (§5.1, D4) - or `null` (D6). The box shows it with a space for the `T`
	 * (`2026-11-07 09:30`, §5.3); typed text is parsed leniently on blur /
	 * Enter (`parseDateTimeText`, D7: `2026/11/7 9:30`, `11/7 930`,
	 * full-width) and the box is rewritten to the shown form; text that does
	 * not parse is left as is (the value does not change - the parent decides
	 * how to show it, `invalid`).
	 *
	 * The dialog (§5.4: "the time listbox beside the date dialog's calendar,
	 * inside the dialog, so focus moves"): `role="dialog"` +
	 * `aria-modal="true"` + `attachFocusTrap`, a `popover="manual"` in the top
	 * layer placed by `anchoredPopover.ts`, closed on an ancestor scroll or a
	 * pointerdown outside - the same dialog as `DateInput`, with the same
	 * calendar (`MonthCalendar`). Picking a day (Enter / Space / click, or
	 * "today") marks it and moves focus to the time list without changing the
	 * value; picking a time there (Enter / Space / click) sets the value to
	 * that day and time and closes the dialog. The list is a focusable
	 * `role="listbox"` whose active option is `aria-activedescendant` (↑ / ↓ /
	 * Home / End). With `step` the list is every `step` minutes from 00:00,
	 * else every 30 (D8); the times outside `[min, max]` on the marked day are
	 * `aria-disabled`. Checking a typed value against `step` / `min` / `max`
	 * is the parent's job (forms / grid), like `TimeInput`.
	 *
	 * Esc goes through one function, `closeOnEscape` (layering.ts rules 1-2),
	 * from the dialog's keydown and from the window (rule 3); closing returns
	 * focus to the text box (D10). Promises to a host that runs its own key /
	 * blur state machine (§5.8), as `DateInput`:
	 * 1. Keys inside the dialog are handled here and do not propagate.
	 * 2. Keys the text box handles itself (Alt+ArrowDown, Esc while open) are
	 *    `preventDefault`ed before `onkeydown` gets them; everything else is
	 *    passed through (Enter with the dialog closed commits the text first).
	 * 3. `onblur` fires only when focus leaves the whole component, after the
	 *    text is committed.
	 * 4. `pointerdown` does not propagate out of the component's root.
	 *
	 * No dependency, no package import, no locale branch: names come from
	 * `Intl` with the `locale` prop (§5.5), text from `messages` (conventions
	 * §13); times are always `HH:mm`.
	 */
	import { flushSync, untrack } from 'svelte';
	import {
		computeAnchoredPosition,
		revealInPopover,
		watchAnchoredPopover
	} from './anchoredPopover';
	import {
		clampDate,
		currentTime,
		formatDateTimeText,
		formatFullDate,
		isBlankDateText,
		isOutOfRange,
		joinDateTime,
		nearestTime,
		parseDateTimeText,
		parseIsoDateTime,
		resolveWeekStart,
		timeOptions,
		todayDate,
		type DateTimeParts
	} from './datetime';
	import Calendar from './icons/Calendar.svelte';
	import { attachFocusTrap, hasVisibleLayerAbove } from './layering';
	import { defaultUiMessages, type UiMessages } from './messages';
	import MonthCalendar from './MonthCalendar.svelte';
	import { stopPointerdown } from './stopPointerdown';

	interface Props {
		/** Canonical `YYYY-MM-DDTHH:mm`, or `null` (`''` is read as empty too). */
		value?: string | null;
		/** Called with the new value (canonical or `null`) when it changes. */
		onValueChange?: (value: string | null) => void;
		/** Typed text owned by the parent (a draft). Omitted: the component keeps it. */
		text?: string;
		/** Every change of the typed text, including the rewrite to the shown form on commit. */
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
		/** Earliest selectable date and time (canonical `YYYY-MM-DDTHH:mm`, inclusive). */
		min?: string;
		/** Latest selectable date and time (canonical `YYYY-MM-DDTHH:mm`, inclusive). */
		max?: string;
		/** Days that can be focused but not picked in the calendar (weekends, holidays). */
		isDateDisabled?: (date: string) => boolean;
		/** Minutes between the listed times, counted from 00:00 (D8). Omitted: a 30-minute list. */
		step?: number;
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
		step,
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
	const listId = `${uid}-times`;
	const optionId = (time: string) => `${uid}-time-${time.replace(':', '')}`;

	// --- text and value --------------------------------------------------

	let ownText = $state(untrack(() => formatDateTimeText(value)));
	// The value last mirrored into `ownText`, so a parent's change of `value`
	// rewrites the box but the component's own commit does not run twice.
	let mirroredValue: string | null | undefined = untrack(() => value);
	$effect(() => {
		const current = value;
		if (current === mirroredValue) return;
		mirroredValue = current;
		// A parent that echoes the typed text back as the value (forms'
		// FormStore path) gets the box left as typed: rewriting
		// `2026-11-07T09:30` to the shown form mid-typing would move the caret.
		if (current === untrack(() => ownText)) return;
		ownText = formatDateTimeText(current);
	});

	const shownText = $derived(text ?? ownText);
	const selected = $derived(value ? parseIsoDateTime(value) : null);

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
			next = parseDateTimeText(raw);
			if (next === null) return;
		}
		const shown = formatDateTimeText(next);
		if (shown !== raw) setText(shown);
		setValue(next);
	}

	// --- dialog ----------------------------------------------------------

	let rootEl: HTMLDivElement | undefined = $state();
	let fieldEl: HTMLDivElement | undefined = $state();
	let panelEl: HTMLDivElement | undefined = $state();
	let listEl: HTMLDivElement | undefined = $state();
	let buttonEl: HTMLButtonElement | undefined = $state();
	let calendar: ReturnType<typeof MonthCalendar> | undefined = $state();
	let open = $state(false);
	let coords = $state<{ top: number; left: number } | undefined>(undefined);
	let focusDate = $state('');
	let today = $state('');
	/** The day picked in the calendar (or the value's), shown as chosen; `null` until one is. */
	let pickedDate = $state<string | null>(null);
	/** The active time option (`aria-activedescendant`), always a selectable one or `null`. */
	let activeTime = $state<string | null>(null);
	let detachTrap: (() => void) | undefined;

	// The bounds as canonical date and time; a bound that is not one is ignored.
	const minParts = $derived(min ? parseIsoDateTime(min) : null);
	const maxParts = $derived(max ? parseIsoDateTime(max) : null);
	const minDate = $derived(minParts?.date);
	const maxDate = $derived(maxParts?.date);
	const weekStart = $derived(resolveWeekStart(locale, weekStartsOn));
	const options = $derived(timeOptions(step));
	/** The day the time list is for: the picked one, else the tracked one. */
	const timeDay = $derived(pickedDate ?? focusDate);
	const selectableTimes = $derived(options.filter((time) => isTimeSelectable(timeDay, time)));
	const buttonLabel = $derived(
		selected
			? t.dateTimePickerChange(`${formatFullDate(selected.date, locale)} ${selected.time}`)
			: t.dateTimePickerOpen()
	);

	function isDaySelectable(date: string): boolean {
		return !isOutOfRange(date, minDate, maxDate) && !isDateDisabled?.(date);
	}

	function isTimeSelectable(date: string, time: string): boolean {
		return (
			!!date &&
			!isOutOfRange(
				joinDateTime(date, time),
				minParts ? min : undefined,
				maxParts ? max : undefined
			)
		);
	}

	/** The typed text if it parses, else the value (§5.4: the dialog opens on what is in the box). */
	function initialParts(): DateTimeParts | null {
		const typed = isBlankDateText(shownText) ? null : parseDateTimeText(shownText);
		return (typed ? parseIsoDateTime(typed) : null) ?? selected;
	}

	/** The time list's active option for `time` on the current day: the nearest selectable one. */
	function nearestSelectable(time: string | null | undefined): string | null {
		if (!time) return null;
		return nearestTime(time, selectableTimes);
	}

	function reposition(): void {
		if (!fieldEl || !panelEl) return;
		coords = computeAnchoredPosition(fieldEl, panelEl, 'bottom-start');
	}

	function revealActive(block: 'nearest' | 'center'): void {
		const list = listEl;
		if (!list || !activeTime) return;
		const option = list.querySelector<HTMLElement>(`[data-time="${activeTime}"]`);
		if (option) revealInPopover(list, option, block);
	}

	function openPicker(): void {
		if (open || disabled || readonly) return;
		const initial = initialParts();
		today = todayDate();
		pickedDate = initial && isDaySelectable(initial.date) ? initial.date : null;
		focusDate = clampDate(initial?.date ?? today, minDate, maxDate);
		open = true;
		// Render the dialog, show it, measure it, then make it visible
		// (`coords`) - a still-hidden cell cannot take focus. It exists only
		// while open, so a closed picker leaves no `role="dialog"` in the page.
		flushSync();
		if (!panelEl) return;
		// Empty: point at the time nearest to now (only points, never picks).
		activeTime = nearestSelectable(initial?.time ?? currentTime());
		panelEl.showPopover();
		reposition();
		flushSync();
		detachTrap = attachFocusTrap(panelEl);
		revealActive('center');
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
		pickedDate = null;
		activeTime = null;
	}

	/** The one Esc path (§5.4): yields to a consumed Esc and to a layer above. */
	function closeOnEscape(event: KeyboardEvent): void {
		if (!open || event.key !== 'Escape') return;
		if (event.defaultPrevented || hasVisibleLayerAbove({ except: panelEl })) return;
		event.preventDefault();
		closePicker(true);
	}

	/** A day picked in the calendar (or "today"): mark it and go on to the time list. */
	function pickDate(date: string): void {
		if (!isDaySelectable(date)) return;
		pickedDate = date;
		focusDate = date;
		flushSync();
		// The marked day may refuse the active time (a bound on that day).
		if (activeTime !== null && !selectableTimes.includes(activeTime)) {
			activeTime = nearestSelectable(activeTime);
		}
		listEl?.focus({ preventScroll: true });
		ensureActive();
		revealActive('center');
	}

	/** A time picked in the list: the value becomes the marked day at that time; the dialog closes. */
	function pickTime(time: string): void {
		const date = pickedDate ?? (isDaySelectable(focusDate) ? focusDate : null);
		if (date === null) {
			// No day yet: the calendar first.
			calendar?.focusCell();
			return;
		}
		if (!isTimeSelectable(date, time)) return;
		const next = joinDateTime(date, time);
		setText(formatDateTimeText(next));
		setValue(next);
		closePicker(true);
	}

	function clear(): void {
		setText('');
		setValue(null);
		closePicker(true);
	}

	/** The list has focus: make sure an option is active (the first selectable one when none is). */
	function ensureActive(): void {
		if (activeTime === null || !selectableTimes.includes(activeTime)) {
			activeTime = selectableTimes[0] ?? null;
		}
	}

	function moveActive(to: number | 'first' | 'last'): void {
		const list = selectableTimes;
		if (list.length === 0) return;
		const index = activeTime === null ? -1 : list.indexOf(activeTime);
		let next: string;
		if (to === 'first') next = list[0];
		else if (to === 'last') next = list[list.length - 1];
		else if (index === -1) next = list[0];
		else next = list[Math.min(Math.max(index + to, 0), list.length - 1)];
		activeTime = next;
		flushSync();
		revealActive('nearest');
	}

	function handleListKey(event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowDown':
				moveActive(1);
				break;
			case 'ArrowUp':
				moveActive(-1);
				break;
			case 'Home':
				moveActive('first');
				break;
			case 'End':
				moveActive('last');
				break;
			case 'Enter':
			case ' ':
				if (activeTime) pickTime(activeTime);
				break;
			default:
				return;
		}
		event.preventDefault();
	}

	// Promise 1: a native listener (Svelte delegates `onkeydown` to the app
	// root, past a host's own native listeners), so stopPropagation here
	// keeps every key inside. The calendar's own grid listener runs first
	// (arrows, Enter). Promise 4 the same way for pointerdown.
	function handlePanelKeydown(event: KeyboardEvent): void {
		if (event.target === listEl) handleListKey(event);
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
		// Light dismiss (manual popover): a pointerdown outside the dialog
		// closes it. The button is left to its own click (toggle).
		function handleDocumentPointerDown(event: PointerEvent): void {
			const target = event.target;
			if (target instanceof Node && (panelEl?.contains(target) || buttonEl?.contains(target))) {
				return;
			}
			// Park focus on the text box first: the click then moves it on from
			// there, so a host sees one ordinary blur from the component.
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

	// The parent changed `step` / `min` / `max` (or disabled the input) while
	// the dialog is open: never leave the active time on one that is gone or
	// refused, nor the dialog open on an input that cannot change.
	$effect(() => {
		if (!open) return;
		if (disabled || readonly) {
			untrack(() => closePicker(!!panelEl?.contains(document.activeElement)));
			return;
		}
		const list = selectableTimes;
		untrack(() => {
			if (activeTime !== null && !list.includes(activeTime)) activeTime = null;
		});
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

<div
	class="datetime-input"
	bind:this={rootEl}
	{@attach stopPointerdown}
	onfocusout={handleFocusOut}
>
	<div
		class="datetime-input-field"
		class:datetime-input-field--invalid={invalid}
		bind:this={fieldEl}
	>
		<input
			bind:this={inputEl}
			{id}
			class="datetime-input-text"
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
			class="datetime-input-button"
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
	<span id={hintId} class="datetime-input-hint">{t.dateTimeFormatHint()}</span>

	{#if open}
		<div
			bind:this={panelEl}
			popover="manual"
			role="dialog"
			aria-modal="true"
			aria-label={t.dateTimePickerDialog()}
			tabindex="-1"
			class="datetime-picker"
			style:top={coords ? `${coords.top}px` : undefined}
			style:left={coords ? `${coords.left}px` : undefined}
			style:visibility={coords ? 'visible' : 'hidden'}
			onmousedown={(event) => {
				// A press on something that cannot take focus (heading, weekday
				// header, gaps) would focus the dialog itself and strand the keys:
				// keep focus where it is. A time option focuses the list (its
				// focusable ancestor), which the click then picks from.
				const target = event.target;
				if (
					!(target instanceof Element) ||
					!target.closest('button, td[tabindex], [role="listbox"]')
				) {
					event.preventDefault();
				}
			}}
		>
			{#if focusDate}
				<div class="datetime-picker-body">
					<div class="datetime-picker-calendar">
						<MonthCalendar
							bind:this={calendar}
							bind:focusDate
							selectedDate={pickedDate}
							{today}
							min={minDate}
							max={maxDate}
							{isDateDisabled}
							{locale}
							{weekStart}
							{t}
							scroller={panelEl}
							onPick={pickDate}
						/>
					</div>

					<!-- Focus moves into the list (it is inside the dialog, §5.4); the
					     active option is pointed at with aria-activedescendant. -->
					<div
						bind:this={listEl}
						id={listId}
						role="listbox"
						tabindex="0"
						aria-label={t.timePickerList()}
						aria-activedescendant={activeTime ? optionId(activeTime) : undefined}
						class="datetime-picker-times"
						onfocus={ensureActive}
					>
						{#each options as time (time)}
							{@const pickable = isTimeSelectable(timeDay, time)}
							<!-- svelte-ignore a11y_interactive_supports_focus, a11y_click_events_have_key_events -->
							<div
								id={optionId(time)}
								role="option"
								data-time={time}
								aria-selected={time === activeTime ? 'true' : 'false'}
								aria-disabled={pickable ? undefined : 'true'}
								class="datetime-option"
								class:datetime-option--active={time === activeTime}
								class:datetime-option--value={!!selected &&
									time === selected.time &&
									timeDay === selected.date}
								onpointermove={() => {
									// The pointer moves the active option (one highlight, the
									// one aria-activedescendant names); a disabled one is skipped.
									if (pickable && activeTime !== time) activeTime = time;
								}}
								onclick={() => {
									if (pickable) pickTime(time);
								}}
							>
								{time}
							</div>
						{/each}
					</div>
				</div>

				<div class="datetime-picker-footer">
					<button
						type="button"
						class="datetime-picker-action"
						aria-disabled={isDaySelectable(today) ? undefined : 'true'}
						onclick={() => pickDate(today)}
					>
						{t.datePickerToday()}
					</button>
					<button type="button" class="datetime-picker-action" onclick={clear}>
						{t.datePickerClear()}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.datetime-input {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		inline-size: var(--banto-datetime-input-width, 15em);
		max-inline-size: 100%;
	}

	.datetime-input-field {
		display: flex;
		align-items: stretch;
		min-inline-size: 0;
	}

	.datetime-input-text {
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

	.datetime-input-button {
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

	.datetime-input-field--invalid .datetime-input-text,
	.datetime-input-field--invalid .datetime-input-button {
		border-color: var(--banto-danger);
	}

	.datetime-input-button:hover:not(:disabled) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.datetime-input-text:focus-visible,
	.datetime-input-button:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.datetime-input-text:disabled,
	.datetime-input-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Read with the text box only (aria-describedby). */
	.datetime-input-hint {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.datetime-picker {
		/* Shape of the calendar (§9: a part's own size, not a dimension step):
		   one day cell, shrunk so 7 of them plus the padding fit a 320px
		   viewport at 200% text (the time list then wraps below). */
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

	.datetime-picker:focus {
		outline: none;
	}

	.datetime-picker-body {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--banto-space-3);
	}

	.datetime-picker-calendar {
		flex: 0 1 auto;
		min-inline-size: 0;
	}

	.datetime-picker-times {
		/* Shape of the list (§9: a part's own size): as tall as the day grid
		   (the weekday row and six weeks), wide enough for `HH:mm`. */
		flex: 1 0 auto;
		box-sizing: border-box;
		min-inline-size: 5.5em;
		max-block-size: calc(7 * var(--banto-date-cell-size));
		padding: var(--banto-space-1);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-sm);
		overflow: auto;
		overscroll-behavior: contain;
	}

	.datetime-picker-times:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.datetime-option {
		padding: var(--banto-space-1) var(--banto-space-2);
		border-radius: var(--banto-radius-sm);
		font-variant-numeric: tabular-nums;
		text-align: center;
		cursor: pointer;
	}

	.datetime-option--value {
		color: var(--banto-primary-text);
		font-weight: 600;
	}

	/* The value's colour does not keep its contrast on the hover background:
	   the active option (value or not) uses the text colour; the value stays bold. */
	.datetime-option--active {
		background: var(--banto-surface-hover);
		box-shadow: inset 0 0 0 var(--banto-border-width) var(--banto-border-strong);
		color: var(--banto-text);
	}

	.datetime-option[aria-disabled='true'] {
		color: var(--banto-text-muted);
		text-decoration: line-through;
		opacity: 0.55;
		cursor: not-allowed;
	}

	.datetime-picker-footer {
		display: flex;
		justify-content: space-between;
		margin-block-start: var(--banto-space-2);
	}

	.datetime-picker-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: var(--banto-space-1) var(--banto-space-2);
		border: none;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: var(--banto-primary-text);
		font: inherit;
		font-size: var(--banto-font-size-md);
		cursor: pointer;
	}

	.datetime-picker-action:hover:not([aria-disabled='true']) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.datetime-picker-action[aria-disabled='true'] {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.datetime-picker-action:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	@media (forced-colors: active) {
		.datetime-option--active {
			forced-color-adjust: none;
			background: Highlight;
			color: HighlightText;
		}

		.datetime-option[aria-disabled='true'] {
			color: GrayText;
		}

		.datetime-picker-times:focus-visible,
		.datetime-picker-action:focus-visible,
		.datetime-input-text:focus-visible,
		.datetime-input-button:focus-visible {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
