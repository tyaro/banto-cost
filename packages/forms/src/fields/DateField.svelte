<script lang="ts">
	/**
	 * Date / time / date-and-time field (spec §7.2 `type: 'date'` / `'time'` /
	 * `'datetime'`; date-time-pickers §5.3 / §5.7, PR-5 for the last two).
	 * The value is a canonical `YYYY-MM-DD` / `HH:mm` / `YYYY-MM-DDTHH:mm`,
	 * or `null` when empty (D6). `BantoForm` hands it the injected input of
	 * the field's type.
	 *
	 * - With an injected `input` (`provideFieldInputs` / `BantoForm`'s
	 *   `fieldInputs`, D1-a) it renders that component: typed text goes to the
	 *   store as it is typed, so text that does not parse stays the value and
	 *   `validateField`'s format check reports it - a stale date is never
	 *   submitted silently (§5.3). The component commits on blur / Enter
	 *   (canonical text, or `null` for blank) and `onBlur` (validation) runs
	 *   only once focus has left the whole component (box, button, calendar).
	 * - Without one, the native `<input type="date">` / `"time"` /
	 *   `"datetime-local"` (D3-a), whose values are the same canonical forms
	 *   (`step` in seconds for the native time inputs).
	 */
	import type { Component } from 'svelte';
	import { nativeTimeStep } from '../date';
	import type { TemporalFieldInputProps } from '../fieldInputs';
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: string | null) => void;
		onBlur?: () => void;
		/** The picker to render instead of the native input (date-time-pickers D1-a). */
		input?: Component<TemporalFieldInputProps>;
	}

	let {
		def,
		id,
		class: className,
		'aria-describedby': describedBy,
		value,
		error,
		disabled = false,
		onInput,
		onBlur,
		input: Input
	}: Props = $props();

	const editable = $derived(!disabled && !def.readonly);
	const text = $derived(typeof value === 'string' ? value : '');
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

	/** Blank text is the empty value `null` (D6). */
	const fromText = (next: string) => (next.trim() === '' ? null : next);
</script>

{#if Input}
	<Input
		id={id ?? def.name}
		value={text === '' ? null : text}
		{describedBy}
		invalid={!!error}
		{disabled}
		readonly={def.readonly}
		{min}
		{max}
		isDateDisabled={def.type === 'time' ? undefined : def.isDateDisabled}
		{step}
		onTextInput={(next: string) => {
			if (editable) onInput(fromText(next));
		}}
		onValueChange={(next: string | null) => {
			if (editable) onInput(next);
		}}
		onblur={() => {
			if (editable) onBlur?.();
		}}
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
		oninput={(event) => {
			if (editable) onInput(fromText(event.currentTarget.value));
		}}
		onblur={() => {
			if (editable) onBlur?.();
		}}
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
