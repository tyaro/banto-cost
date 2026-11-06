<script lang="ts">
	/** Text input field (spec §7.2 `type: 'text'`). Shared style baseline for all field components. */
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: string) => void;
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
</script>

<input
	type="text"
	class={className}
	id={id ?? def.name}
	value={(value as string | undefined) ?? ''}
	placeholder={def.placeholder}
	{disabled}
	readonly={def.readonly}
	class:muted={def.readonly}
	aria-invalid={!!error}
	aria-describedby={describedBy}
	oninput={(event) => {
		if (!disabled && !def.readonly) onInput(event.currentTarget.value);
	}}
	onblur={() => {
		if (!disabled && !def.readonly) onBlur?.();
	}}
/>

<style>
	input {
		height: var(--banto-control-height);
		padding: 0 0.6rem;
		border: 1px solid var(--banto-border-strong);
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
