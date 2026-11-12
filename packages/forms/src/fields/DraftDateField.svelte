<script lang="ts">
	/**
	 * Date / time / date-and-time input bound to a `FormDraft` (spec §7.2
	 * `type: 'date'` / `'time'` / `'datetime'`, the last two from PR-5;
	 * date-time-pickers §5.3 / §5.7; the `DraftNumberField` pattern of
	 * shared-primitives-upstream-plan §3.5). Typed text - lenient forms such as
	 * `2026/11/7` and text that does not parse yet - lives in `draft.raw`, so it
	 * survives a pane re-mount; `draft.commit` normalises it to `YYYY-MM-DD`
	 * / `HH:mm` / `YYYY-MM-DDTHH:mm` (blank -> `null`, D6) and validates it. A
	 * committed date and time is shown with a space (`2026-11-07 09:30`, §5.3).
	 *
	 * - The picker of the field's type comes from `provideFieldInputs` or the
	 *   `input` prop (D1-a),
	 *   which gets the draft's text (`text` / `onTextInput`). A day picked in
	 *   the calendar is committed at once; typed text on blur / Enter (the
	 *   component commits it first, then hands over the blur / key).
	 * - Without one, the native `<input type="date">` / `"time"` /
	 *   `"datetime-local"` (D3-a), committed on blur / Enter like
	 *   `DraftNumberField`.
	 */
	import type { Component } from 'svelte';
	import { formatDateTimeText, nativeTimeStep } from '../date';
	import { formatDraftValue, type FormDraft } from '../draft.svelte';
	import { getFieldInputs, type TemporalFieldInputProps } from '../fieldInputs';
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		draft: FormDraft;
		disabled?: boolean;
		/** Called after each commit (blur / Enter / a picked day) with whether the field is valid. */
		onCommit?: (valid: boolean) => void;
		/** Overrides the input of the field's type from `provideFieldInputs` for this field. */
		input?: Component<TemporalFieldInputProps>;
	}

	let {
		def,
		id,
		class: className,
		'aria-describedby': describedBy,
		draft,
		disabled = false,
		onCommit,
		input
	}: Props = $props();

	const provided = getFieldInputs();
	const Input = $derived<Component<TemporalFieldInputProps> | undefined>(
		input ??
			(def.type === 'time'
				? provided.time
				: def.type === 'datetime'
					? provided.datetime
					: provided.date)
	);

	const editable = $derived(!disabled && !def.readonly);
	const native = $derived(!Input);
	const text = $derived.by(() => {
		const raw = draft.raw[def.name];
		if (raw !== undefined) return raw;
		const shown = formatDraftValue(draft.values[def.name]);
		// The picker shows a date and time with a space; the native
		// `datetime-local` input takes the canonical value with the `T`.
		return def.type === 'datetime' && !native ? formatDateTimeText(shown) : shown;
	});
	const error = $derived(draft.errors[def.name]);
	// The committed value (not the typed text): a picked day or a committed
	// text differs from it, so the component reports it and it is committed.
	const committed = $derived.by(() => {
		const value = draft.values[def.name];
		return typeof value === 'string' && value !== '' ? value : null;
	});
	const min = $derived(typeof def.min === 'string' ? def.min : undefined);
	const max = $derived(typeof def.max === 'string' ? def.max : undefined);
	const step = $derived(def.type === 'date' ? undefined : def.step);
	const nativeType = $derived(
		def.type === 'datetime' ? 'datetime-local' : def.type === 'time' ? 'time' : 'date'
	);
	// The native time inputs count `step` in seconds and from `min`: given only
	// when that agrees with the validator's 00:00-based step (`nativeTimeStep`).
	const nativeStep = $derived(
		def.type === 'date'
			? undefined
			: nativeTimeStep(def.type === 'time' ? 'time' : 'datetime', step, min)
	);

	function setText(next: string) {
		if (editable) draft.setRaw(def.name, next);
	}

	function commit() {
		if (!editable) return;
		const valid = draft.commit(def.name);
		onCommit?.(valid);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.isComposing) commit();
	}

	// One commit per user action with the injected input. Its own commit
	// (blur / Enter) reports a changed value first and then hands over the
	// blur / key in the same task - that blur / Enter must not commit (and
	// notify `onCommit`) a second time. A day picked in the calendar has no
	// blur / key after it, so it is committed at once by `onValueChange`.
	let committedThisTask = false;

	function commitFromInput() {
		commit();
		committedThisTask = true;
		queueMicrotask(() => (committedThisTask = false));
	}

	function commitUnlessDone() {
		if (!committedThisTask) commit();
	}

	function handleInputKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.isComposing) commitUnlessDone();
	}
</script>

{#if Input}
	<Input
		id={id ?? def.name}
		value={committed}
		{text}
		{describedBy}
		invalid={!!error}
		{disabled}
		readonly={def.readonly}
		{min}
		{max}
		isDateDisabled={def.type === 'time' ? undefined : def.isDateDisabled}
		{step}
		onTextInput={setText}
		onValueChange={commitFromInput}
		onkeydown={handleInputKeydown}
		onblur={commitUnlessDone}
	/>
{:else}
	<input
		type={nativeType}
		class={className}
		id={id ?? def.name}
		value={text}
		{min}
		{max}
		step={nativeStep}
		{disabled}
		readonly={def.readonly}
		class:muted={def.readonly}
		aria-invalid={!!error}
		aria-describedby={describedBy}
		oninput={(event) => setText(event.currentTarget.value)}
		onblur={commit}
		onkeydown={handleKeydown}
	/>
{/if}

<style>
	input {
		height: var(--banto-control-height);
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font: inherit;
		width: 100%;
		box-sizing: border-box;
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	input:focus-visible {
		outline: var(--banto-border-width-strong) solid transparent;
		outline-offset: var(--banto-border-width);
		box-shadow: var(--banto-focus-ring);
	}

	input:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	input.muted {
		color: var(--banto-text-muted);
	}
</style>
