<script lang="ts">
	/** Select field (spec §7.2 `type: 'select'`), options from `def.options`. */
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: string | number) => void;
		onBlur?: () => void;
		/**
		 * i18n layer 1 (docs/conventions.md §13): package-level default for the
		 * placeholder option, used when `def.placeholder` isn't set. Defaults
		 * reproduce today's Japanese output.
		 */
		messages?: { selectPlaceholder?: string };
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
		messages = {}
	}: Props = $props();

	// Native selects have no readonly state; preserve their disabled fallback.
	const isDisabled = $derived(disabled || !!def.readonly);

	function handleChange(event: Event & { currentTarget: HTMLSelectElement }) {
		if (isDisabled) return;
		const option = def.options?.find((entry) => String(entry.value) === event.currentTarget.value);
		onInput(option ? option.value : event.currentTarget.value);
	}
</script>

<select
	class={className}
	id={id ?? def.name}
	value={value === undefined || value === null ? '' : String(value)}
	disabled={isDisabled}
	class:muted={def.readonly}
	aria-invalid={!!error}
	aria-describedby={describedBy}
	onchange={handleChange}
	onblur={() => {
		if (!isDisabled) onBlur?.();
	}}
>
	<option value="" disabled hidden
		>{def.placeholder ?? messages.selectPlaceholder ?? '選択してください'}</option
	>
	{#each def.options ?? [] as option (option.value)}
		<option value={String(option.value)}>{option.label}</option>
	{/each}
</select>

<style>
	select {
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

	select:focus-visible {
		outline: var(--banto-border-width-strong) solid transparent;
		outline-offset: var(--banto-border-width);
		box-shadow: var(--banto-focus-ring);
	}

	select:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	select.muted {
		color: var(--banto-text-muted);
	}
</style>
