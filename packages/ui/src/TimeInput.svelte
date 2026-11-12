<script lang="ts">
	/**
	 * Time input: a text box you can type into plus a list of times
	 * (docs/design/date-time-pickers.md §5.2-§5.6, PR-2). The value is the
	 * canonical `HH:mm` (00:00-23:59, 24-hour) or `null` (§5.1, D6); typed text
	 * is parsed leniently on blur / Enter (`parseTimeText`, D7: `9:30`, `0930`,
	 * `930`, `9`, full-width) and the box is rewritten to the canonical form;
	 * text that does not parse is left as is (the value does not change - the
	 * parent decides how to show it, `invalid`). Display is always `HH:mm`,
	 * never the locale's `hourCycle` (no `Intl` here).
	 *
	 * Step (§5.6, D8): with `step` (minutes) the list is every `step` minutes
	 * from 00:00; without it the list is every 30 minutes and typed text may
	 * be any minute. Checking a typed value against `step` / `min` / `max` is
	 * the parent's job (forms / grid, PR-3 onwards - `isOnTimeStep`,
	 * `isOutOfRange`); in the list, times outside `[min, max]` are
	 * `aria-disabled` and cannot be picked or made active.
	 *
	 * Combobox + listbox (APG, §5.4): the text box is `role="combobox"` and
	 * **keeps focus** while the list is open; the active option is pointed at
	 * by `aria-activedescendant`, and the highlight shown is that same option
	 * (the pointer moves it, clicks never move focus into the list). The list
	 * is a `popover="manual"` in the top layer (placed by `anchoredPopover.ts`,
	 * closed on an ancestor scroll or a pointerdown outside) that scrolls
	 * inside its own box to show the active option (`revealInPopover`, never
	 * `scrollIntoView`). The button beside the box only opens / closes the
	 * list (`tabindex="-1"`, for the mouse).
	 *
	 * Promises to a host that runs its own key / blur state machine (§5.8, the
	 * grid cell editor of PR-4):
	 * 1. Focus never enters the list, so no key arises inside it; the list
	 *    still stops keydown propagation for safety.
	 * 2. Keys the text box handles itself (ArrowDown / Alt+ArrowDown to open,
	 *    and while open ArrowUp / ArrowDown / Enter / Esc / Alt+ArrowUp) are
	 *    `preventDefault`ed before `onkeydown` gets them; everything else is
	 *    passed through untouched (Enter with the list closed commits the text
	 *    first, then reaches `onkeydown` as usual). The open list carries
	 *    `data-esc-layer` (layering.ts `LAYER_MARKER_ATTR`), so a dialog
	 *    around the input yields its Esc to it. Esc goes through one
	 *    function, `closeOnEscape` (layering.ts rules 1-2), from the text box
	 *    and from the window (rule 3); no capture-phase window listener.
	 * 3. `onblur` fires only when focus leaves the whole component, after the
	 *    text is committed.
	 * 4. `pointerdown` does not propagate out of the component's root.
	 *
	 * No dependency, no package import: text comes from `messages`
	 * (conventions §13).
	 */
	import { flushSync, untrack } from 'svelte';
	import {
		computeAnchoredPosition,
		revealInPopover,
		watchAnchoredPopover
	} from './anchoredPopover';
	import {
		currentTime,
		isBlankDateText,
		isIsoTime,
		isOutOfRange,
		nearestTime,
		parseTimeText,
		timeOptions
	} from './datetime';
	import Clock from './icons/Clock.svelte';
	import { hasVisibleLayerAbove } from './layering';
	import { defaultUiMessages, type UiMessages } from './messages';
	import { stopPointerdown } from './stopPointerdown';

	interface Props {
		/** Canonical `HH:mm`, or `null` (`''` is read as empty too). */
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
		/** Earliest selectable time in the list (canonical `HH:mm`, inclusive). */
		min?: string;
		/** Latest selectable time in the list (canonical `HH:mm`, inclusive). */
		max?: string;
		/** Minutes between the listed times, counted from 00:00 (D8). Omitted: a 30-minute list. */
		step?: number;
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
		step,
		messages,
		onkeydown,
		onblur,
		inputEl = $bindable()
	}: Props = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });
	const uid = $props.id();
	const hintId = `${uid}-hint`;
	const listId = `${uid}-list`;
	const optionId = (time: string) => `${uid}-option-${time.replace(':', '')}`;

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
	const selectedTime = $derived(value && isIsoTime(value) ? value : null);

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
			next = parseTimeText(raw);
			if (next === null) return;
		}
		if ((next ?? '') !== raw) setText(next ?? '');
		setValue(next);
	}

	// --- list --------------------------------------------------------------

	let rootEl: HTMLDivElement | undefined = $state();
	let fieldEl: HTMLDivElement | undefined = $state();
	let panelEl: HTMLDivElement | undefined = $state();
	let open = $state(false);
	let coords = $state<{ top: number; left: number } | undefined>(undefined);
	/** The active option (`aria-activedescendant` and the highlight), always a selectable one or `null`. */
	let activeTime = $state<string | null>(null);

	// Bounds that are not canonical are ignored (no option is disabled by them).
	const minTime = $derived(min && isIsoTime(min) ? min : undefined);
	const maxTime = $derived(max && isIsoTime(max) ? max : undefined);
	const options = $derived(timeOptions(step));
	const selectable = $derived(options.filter((time) => isSelectable(time)));

	function isSelectable(time: string): boolean {
		return !isOutOfRange(time, minTime, maxTime);
	}

	/**
	 * Nearest selectable option to the typed (parsable) text, else the value,
	 * else the current time (§5.4) - the list opens near "now" when empty, and
	 * only points there: the value is never changed by opening.
	 */
	function initialActive(): string | null {
		const typed = isBlankDateText(shownText) ? null : parseTimeText(shownText);
		return nearestTime(typed ?? selectedTime ?? currentTime(), selectable);
	}

	function reposition(): void {
		if (!fieldEl || !panelEl) return;
		coords = computeAnchoredPosition(fieldEl, panelEl, 'bottom-start');
	}

	function revealActive(block: 'nearest' | 'center'): void {
		const panel = panelEl;
		if (!panel || !activeTime) return;
		const option = panel.querySelector<HTMLElement>(`[data-time="${activeTime}"]`);
		if (option) revealInPopover(panel, option, block);
	}

	function openList(): void {
		if (open || disabled || readonly) return;
		activeTime = initialActive();
		open = true;
		// Render the list, show it, measure it, then make it visible (`coords`).
		// It exists only while open, so a closed input leaves no listbox in
		// the page (and `aria-controls` is set only while it exists).
		flushSync();
		if (!panelEl) return;
		panelEl.showPopover();
		reposition();
		flushSync();
		revealActive('center');
	}

	function closeList(): void {
		if (!open) return;
		try {
			panelEl?.hidePopover();
		} catch {
			// Already hidden (removed from the top layer by the browser).
		}
		open = false;
		coords = undefined;
		activeTime = null;
	}

	/** The one Esc path (§5.4): yields to a consumed Esc and to a layer above. */
	function closeOnEscape(event: KeyboardEvent): void {
		if (!open || event.key !== 'Escape') return;
		if (event.defaultPrevented || hasVisibleLayerAbove({ except: panelEl })) return;
		event.preventDefault();
		closeList();
	}

	/** Move the active option by `delta` selectable options (no wrap); from none, start at the initial one. */
	function moveActive(delta: number): void {
		const list = selectable;
		if (list.length === 0) return;
		const index = activeTime === null ? -1 : list.indexOf(activeTime);
		const next =
			index === -1
				? (initialActive() ?? list[0])
				: list[Math.min(Math.max(index + delta, 0), list.length - 1)];
		activeTime = next;
		flushSync();
		revealActive('nearest');
	}

	// The parent changed `step` / `min` / `max` (or disabled the input) while
	// the list is open: never leave the active option on a time that is gone
	// or disabled, nor the list open on an input that cannot change.
	$effect(() => {
		if (!open) return;
		if (disabled || readonly) {
			untrack(closeList);
			return;
		}
		const list = selectable;
		untrack(() => {
			if (activeTime !== null && !list.includes(activeTime)) activeTime = null;
		});
	});

	function select(time: string): void {
		if (!isSelectable(time)) return;
		setText(time);
		setValue(time);
		closeList();
	}

	function handleInputKeydown(event: KeyboardEvent): void {
		if (!event.isComposing) {
			switch (event.key) {
				case 'ArrowDown':
					if (open) {
						event.preventDefault();
						if (!event.altKey) moveActive(1);
					} else if (!disabled && !readonly) {
						event.preventDefault();
						openList();
					}
					break;
				case 'ArrowUp':
					if (open) {
						event.preventDefault();
						if (event.altKey) closeList();
						else moveActive(-1);
					}
					break;
				case 'Escape':
					closeOnEscape(event);
					break;
				case 'Enter':
					if (open) {
						// Pick the active option; with none (the user typed while the
						// list was open) take the typed text instead.
						event.preventDefault();
						if (activeTime) select(activeTime);
						else {
							commit();
							closeList();
						}
					} else {
						commit();
					}
					break;
			}
		}
		onkeydown?.(event);
	}

	function handleInput(event: Event & { currentTarget: HTMLInputElement }): void {
		setText(event.currentTarget.value);
		// Typing takes over from the list (`aria-autocomplete="none"`): no option
		// stays active, so Enter commits what was typed, not a stale option.
		activeTime = null;
	}

	$effect(() => {
		const panel = panelEl;
		if (!panel) return;
		const stop = (event: Event) => event.stopPropagation();
		panel.addEventListener('keydown', stop);
		return () => panel.removeEventListener('keydown', stop);
	});

	$effect(() => {
		if (!open) return;
		// Light dismiss (manual popover): a pointerdown outside the component
		// closes the list (the text box - placing the caret - and the button,
		// which toggles on its own click, keep it); focus stays on the text box
		// until the click moves it on.
		function handleDocumentPointerDown(event: PointerEvent): void {
			const target = event.target;
			if (target instanceof Node && rootEl?.contains(target)) return;
			closeList();
		}
		document.addEventListener('pointerdown', handleDocumentPointerDown, true);
		const unwatch = watchAnchoredPopover(panelEl, { reposition, close: closeList });
		return () => {
			document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
			unwatch();
		};
	});

	function handleButtonClick(): void {
		if (open) {
			closeList();
			return;
		}
		if (document.activeElement !== inputEl) inputEl?.focus({ preventScroll: true });
		openList();
	}

	function handleFocusOut(event: FocusEvent): void {
		const next = event.relatedTarget;
		if (next instanceof Node && rootEl?.contains(next)) return;
		closeList();
		commit();
		onblur?.(event);
	}
</script>

<svelte:window onkeydown={closeOnEscape} />

<div class="time-input" bind:this={rootEl} {@attach stopPointerdown} onfocusout={handleFocusOut}>
	<div class="time-input-field" class:time-input-field--invalid={invalid} bind:this={fieldEl}>
		<input
			bind:this={inputEl}
			{id}
			class="time-input-text"
			type="text"
			role="combobox"
			inputmode="numeric"
			autocomplete="off"
			spellcheck="false"
			aria-label={label}
			aria-autocomplete="none"
			aria-expanded={open}
			aria-controls={open ? listId : undefined}
			aria-activedescendant={open && activeTime ? optionId(activeTime) : undefined}
			aria-describedby={describedBy ? `${hintId} ${describedBy}` : hintId}
			aria-invalid={invalid ? 'true' : undefined}
			{disabled}
			{readonly}
			value={shownText}
			oninput={handleInput}
			onkeydown={handleInputKeydown}
		/>
		<button
			type="button"
			class="time-input-button"
			tabindex="-1"
			aria-label={t.timePickerOpen()}
			title={t.timePickerOpen()}
			aria-expanded={open}
			aria-controls={open ? listId : undefined}
			disabled={disabled || readonly}
			onmousedown={(event) => {
				// Focus stays on the text box (the combobox owns it, §5.4).
				event.preventDefault();
			}}
			onclick={handleButtonClick}
		>
			<Clock size={16} aria-hidden="true" />
		</button>
	</div>
	<span id={hintId} class="time-input-hint">{t.timeFormatHint()}</span>

	{#if open}
		<!-- The listbox and its options never take focus: the combobox keeps it
		     and points at the active option with aria-activedescendant (APG), and
		     the keys are the text box's. -->
		<!-- svelte-ignore a11y_interactive_supports_focus -->
		<div
			bind:this={panelEl}
			id={listId}
			popover="manual"
			role="listbox"
			aria-label={t.timePickerList()}
			data-esc-layer
			class="time-list"
			style:top={coords ? `${coords.top}px` : undefined}
			style:left={coords ? `${coords.left}px` : undefined}
			style:visibility={coords ? 'visible' : 'hidden'}
			onmousedown={(event) => {
				// Nothing in the list takes focus: the text box keeps it, so the
				// active option and the focus never part ways.
				event.preventDefault();
			}}
		>
			{#each options as time (time)}
				{@const pickable = isSelectable(time)}
				<!-- svelte-ignore a11y_interactive_supports_focus, a11y_click_events_have_key_events -->
				<div
					id={optionId(time)}
					role="option"
					data-time={time}
					aria-selected={time === activeTime ? 'true' : 'false'}
					aria-disabled={pickable ? undefined : 'true'}
					class="time-option"
					class:time-option--active={time === activeTime}
					class:time-option--value={time === selectedTime}
					onpointermove={() => {
						// The pointer moves the active option (one highlight, the one
						// aria-activedescendant names); a disabled one is skipped.
						if (pickable && activeTime !== time) activeTime = time;
					}}
					onclick={() => {
						if (pickable) select(time);
					}}
				>
					{time}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.time-input {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		inline-size: var(--banto-time-input-width, 7.5em);
		max-inline-size: 100%;
	}

	.time-input-field {
		display: flex;
		align-items: stretch;
		min-inline-size: 0;
	}

	.time-input-text {
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

	.time-input-button {
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

	.time-input-field--invalid .time-input-text,
	.time-input-field--invalid .time-input-button {
		border-color: var(--banto-danger);
	}

	.time-input-button:hover:not(:disabled) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.time-input-text:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.time-input-text:disabled,
	.time-input-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Read with the text box only (aria-describedby). */
	.time-input-hint {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.time-list {
		position: fixed;
		inset: auto;
		margin: 0;
		box-sizing: border-box;
		/* Shape of the list (§9: a part's own size): as wide as the field, about
		   eight rows tall; anchoredPopover caps it further on a short viewport. */
		inline-size: var(--banto-time-input-width, 7.5em);
		max-inline-size: calc(100vw - 2 * var(--banto-space-1));
		max-block-size: var(--banto-time-list-max-height, 16em);
		padding: var(--banto-space-1);
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

	.time-option {
		padding: var(--banto-space-1) var(--banto-space-2);
		border-radius: var(--banto-radius-sm);
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}

	.time-option--value {
		color: var(--banto-primary-text);
		font-weight: 600;
	}

	/* The value's colour does not keep its contrast on the hover background
	   (dark themes): the active option uses the text colour; the value stays bold. */
	.time-option--active {
		background: var(--banto-surface-hover);
		box-shadow: inset 0 0 0 var(--banto-border-width) var(--banto-border-strong);
		color: var(--banto-text);
	}

	.time-option[aria-disabled='true'] {
		color: var(--banto-text-muted);
		text-decoration: line-through;
		opacity: 0.55;
		cursor: not-allowed;
	}

	@media (forced-colors: active) {
		.time-option--active {
			forced-color-adjust: none;
			background: Highlight;
			color: HighlightText;
		}

		.time-option[aria-disabled='true'] {
			color: GrayText;
		}

		.time-input-text:focus-visible {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
