<script lang="ts">
	/**
	 * Password input field (spec §7.2 `type: 'password'`, added M10 RBAC for
	 * the user-management create form). Identical to TextField except for
	 * `type="password"` (masked input) and `autocomplete="new-password"` (a
	 * password field in an admin form is always setting a NEW credential for
	 * some account, never the current browser user's own login, so browsers
	 * should not offer to autofill/save it as such).
	 */
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
	type="password"
	class={className}
	id={id ?? def.name}
	value={(value as string | undefined) ?? ''}
	placeholder={def.placeholder}
	{disabled}
	readonly={def.readonly}
	class:muted={def.readonly}
	aria-invalid={!!error}
	aria-describedby={describedBy}
	autocomplete="new-password"
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
