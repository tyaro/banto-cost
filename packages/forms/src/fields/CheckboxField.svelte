<script lang="ts">
	/** Checkbox field (spec §7.2 `type: 'checkbox'`). */
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: boolean) => void;
		onBlur?: () => void;
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
		onBlur
	}: Props = $props();

	// Native checkboxes have no readonly state; preserve their disabled fallback.
	const isDisabled = $derived(disabled || !!def.readonly);
</script>

<input
	type="checkbox"
	class={className}
	id={id ?? def.name}
	checked={!!value}
	disabled={isDisabled}
	class:muted={def.readonly}
	aria-invalid={!!error}
	aria-describedby={describedBy}
	onchange={(event) => {
		if (!isDisabled) onInput(event.currentTarget.checked);
	}}
	onblur={() => {
		if (!isDisabled) onBlur?.();
	}}
/>

<style>
	/* Note: --banto-control-height (36px) is not applied to the checkbox
	   itself - a checkbox is a small square control, not a text-input-height
	   control; the shared size falls back to the native 1.1rem box and keeps
	   focus-ring/disabled/transition treatment. */
	input {
		width: var(--banto-checkbox-size, 1.1rem);
		height: var(--banto-checkbox-size, 1.1rem);
		flex-shrink: 0;
		accent-color: var(--banto-primary);
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	input:focus-visible {
		outline: var(--banto-border-width-strong, 2px) solid var(--banto-primary);
		outline-offset: var(--banto-border-width, 1px);
		box-shadow: var(--banto-focus-ring);
		border-radius: var(--banto-radius-sm);
	}

	input:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
