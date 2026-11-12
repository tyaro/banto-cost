<script lang="ts">
	/**
	 * Inline cell editor markup (select / checkbox / text-number-date-time input).
	 * Template only: edit state transitions, key/blur handling and focus
	 * management stay in `BantoGrid.svelte` and arrive here as callbacks. The
	 * draft is never written here; `onDraftChange` lets the grid own it.
	 *
	 * A date / time / date-and-time editor injected by the app (`dateEditor`
	 * / `timeEditor` / `dateTimeEditor`, date-time-pickers §5.8,
	 * `cellEditors.ts`) replaces the native `<input type="date">` / `"time"` /
	 * `"datetime-local"`. It gets the draft as its text (a canonical date and
	 * time shown with a space, §5.3) and reports every text change back, so the grid's
	 * Enter / Tab / blur commit stays the one path. Its wrapper is the
	 * editor's root for the grid (`editorRootEl`): pointerdown, click and
	 * dblclick inside it - the button, the calendar (a top-layer popover that
	 * is still a DOM child of the cell) - stop here, so they never reach the
	 * cell's selection / row click / start-editing handlers (§5.8 promise 4),
	 * and neither do keys from anything but the text box (whose keys the grid
	 * handles through `onKeydown`).
	 */
	import type { Component } from 'svelte';
	import type { CellEditorType } from './types';
	import type {
		CellDateEditorProps,
		CellDateTimeEditorProps,
		CellTemporalEditorProps,
		CellTimeEditorProps
	} from './cellEditors';
	import { resolveSelectValue } from './core/clipboard';
	import {
		formatDateTimeText,
		isIsoDate,
		isIsoDateTime,
		isIsoTime,
		nativeTimeStep
	} from './core/date';

	let {
		editor,
		label,
		invalid,
		describedBy,
		pending,
		draft,
		options,
		dateEditor,
		timeEditor,
		dateTimeEditor,
		min,
		max,
		isDateDisabled,
		step,
		editorEl = $bindable(),
		editorRootEl = $bindable(),
		onDraftChange,
		onToggle,
		onKeydown,
		onBlur
	}: {
		editor: CellEditorType | undefined;
		label: string;
		invalid: boolean;
		describedBy: string | undefined;
		pending: boolean;
		draft: unknown;
		options: { value: string | number; label: string }[] | undefined;
		/** Injected date editor (`CellEditors.date`); omitted: the native input. */
		dateEditor?: Component<CellDateEditorProps>;
		/** Injected time editor (`CellEditors.time`); omitted: the native input. */
		timeEditor?: Component<CellTimeEditorProps>;
		/** Injected date-and-time editor (`CellEditors.datetime`); omitted: the native input. */
		dateTimeEditor?: Component<CellDateTimeEditorProps>;
		min?: string;
		max?: string;
		isDateDisabled?: (date: string) => boolean;
		/** Minutes between listed times (time / datetime). */
		step?: number;
		editorEl: HTMLInputElement | HTMLSelectElement | undefined;
		/** The injected editor's wrapper (unset for the native inputs, whose root is `editorEl`). */
		editorRootEl?: HTMLElement | null;
		onDraftChange: (value: unknown) => void;
		onToggle: (checked: boolean) => void;
		onKeydown: (event: KeyboardEvent) => void;
		onBlur: (event: FocusEvent) => void;
	} = $props();

	const DateEditor = $derived<Component<CellTemporalEditorProps> | undefined>(
		editor === 'date'
			? dateEditor
			: editor === 'time'
				? timeEditor
				: editor === 'datetime'
					? dateTimeEditor
					: undefined
	);
	const draftText = $derived(String(draft ?? ''));
	/** The draft as the injected editor's value: canonical for the column's type, else `null`. */
	const pickerValue = $derived.by(() => {
		if (editor === 'time') return isIsoTime(draft) ? draft : null;
		if (editor !== 'datetime') return isIsoDate(draft) ? draft : null;
		// The shown form (`2026-11-07 09:30`, what the editor writes back after
		// a pick or a commit) is that value too.
		const canonical = draftText.replace(' ', 'T');
		return isIsoDateTime(canonical) ? canonical : null;
	});
	// A canonical date and time is shown with a space (§5.3) until the editor
	// reports text of its own: from then on the box shows the draft as typed
	// (rewriting it mid-typing would move the caret); `parseCellInput`
	// normalises it on commit.
	let typedText = $state(false);
	const pickerText = $derived(
		editor === 'datetime' && !typedText ? formatDateTimeText(draftText) : draftText
	);
	function handleTextInput(text: string) {
		typedText = true;
		onDraftChange(text);
	}
	const nativeType = $derived(
		editor === 'number'
			? 'number'
			: editor === 'date'
				? 'date'
				: editor === 'time'
					? 'time'
					: editor === 'datetime'
						? 'datetime-local'
						: 'text'
	);
	const isTemporal = $derived(editor === 'date' || editor === 'time' || editor === 'datetime');
	// The native time inputs count `step` in seconds and from `min`: given only
	// when that agrees with the validator's 00:00-based step (`nativeTimeStep`).
	const nativeStep = $derived(
		editor === 'time' || editor === 'datetime' ? nativeTimeStep(editor, step, min) : undefined
	);

	function stop(event: Event) {
		event.stopPropagation();
	}

	const common = $derived({
		'aria-label': label,
		'aria-invalid': invalid,
		'aria-describedby': describedBy,
		class: 'cell-editor',
		onpointerdown: (event: PointerEvent) => event.stopPropagation(),
		onkeydown: onKeydown,
		onblur: onBlur
	});
</script>

{#if (editor ?? 'text') === 'select'}
	<select
		bind:this={editorEl}
		{...common}
		class:pending
		value={String(draft ?? '')}
		onchange={(event) => onDraftChange(resolveSelectValue(event.currentTarget.value, options))}
	>
		{#each options ?? [] as option (option.value)}
			<option value={String(option.value)}>{option.label}</option>
		{/each}
	</select>
{:else if (editor ?? 'text') === 'checkbox'}
	<input
		type="checkbox"
		bind:this={editorEl}
		{...common}
		class:pending
		checked={!!draft}
		onclick={(event) => event.stopPropagation()}
		onchange={(event) => onToggle(event.currentTarget.checked)}
	/>
{:else if DateEditor}
	<!-- Not a control itself: it only keeps the editor's pointer and key events
	     away from the cell (see the module doc). -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="cell-editor-host"
		class:pending
		bind:this={editorRootEl}
		onpointerdown={stop}
		onclick={stop}
		ondblclick={stop}
		onkeydown={stop}
	>
		<DateEditor
			bind:inputEl={() => editorEl as HTMLInputElement | undefined, (el) => (editorEl = el)}
			value={pickerValue}
			text={pickerText}
			onTextInput={handleTextInput}
			{label}
			{describedBy}
			{invalid}
			readonly={pending}
			{min}
			{max}
			isDateDisabled={editor === 'time' ? undefined : isDateDisabled}
			{step}
			onkeydown={onKeydown}
			onblur={onBlur}
		/>
	</div>
{:else}
	<input
		type={nativeType}
		bind:this={editorEl}
		{...common}
		class:pending
		min={isTemporal ? min : undefined}
		max={isTemporal ? max : undefined}
		step={nativeStep}
		value={String(draft ?? '')}
		oninput={(event) => onDraftChange(event.currentTarget.value)}
	/>
{/if}

<style>
	.cell-editor {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		padding: 0 var(--banto-space-2);
		border: none;
		outline: none;
		background: var(--banto-surface);
		color: var(--banto-text);
		font: inherit;
	}

	/* Keep the native checkbox compact instead of stretching the editor box. */
	.cell-editor[type='checkbox'] {
		width: var(--banto-checkbox-size, 1.1rem);
		height: var(--banto-checkbox-size, 1.1rem);
		flex-shrink: 0;
		padding: 0;
		margin-inline: var(--banto-space-2);
		accent-color: var(--banto-primary);
	}

	/* The injected editor fills the cell. The three `--banto-*-input-width`
	   variables are the width hooks `@banto/ui`'s DateInput / TimeInput /
	   DateTimeInput read (their defaults are fixed widths for forms); another
	   component simply ignores them. A picker is `--banto-control-height` tall,
	   which is 1px more than the default 36px row's content box (the row's
	   bottom border takes 1px), so the row publishes
	   `--banto-grid-editor-height` (the control height capped to the row's
	   content box) and the host re-points `--banto-control-height` at it. The
	   floor keeps a target of at least the small control height. */
	.cell-editor-host {
		display: flex;
		align-items: center;
		width: 100%;
		height: 100%;
		min-width: 0;
		--banto-control-height: max(
			var(--banto-grid-editor-height, var(--banto-control-height-sm)),
			var(--banto-control-height-sm)
		);
		--banto-date-input-width: 100%;
		--banto-time-input-width: 100%;
		--banto-datetime-input-width: 100%;
	}

	.cell-editor.pending,
	.cell-editor-host.pending {
		opacity: 0.5;
		pointer-events: none;
	}
</style>
