<script lang="ts">
	/**
	 * Schema-driven form (spec §7.3): renders one field per `FieldDef` in a
	 * single column (default layout), wires value/blur to the FormStore, and
	 * runs full validation on submit before calling `onSubmit`.
	 */
	import type { Snippet } from 'svelte';
	import type { FieldDef, FormSchema, FormAppearance } from './types';
	import type { FormStore } from './store.svelte';
	import TextField from './fields/TextField.svelte';
	import PasswordField from './fields/PasswordField.svelte';
	import TextareaField from './fields/TextareaField.svelte';
	import NumberField from './fields/NumberField.svelte';
	import DateField from './fields/DateField.svelte';
	import SelectField from './fields/SelectField.svelte';
	import CheckboxField from './fields/CheckboxField.svelte';

	interface Props {
		schema: FormSchema;
		store: FormStore;
		onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
		submitting?: boolean;
		submitLabel?: string;
		/** Underline keeps labels above controls; requires matching theme CSS. */
		appearance?: FormAppearance;
		/** Escape hatch for extra footer content (e.g. a delete button) next to the submit button. */
		children?: Snippet;
	}

	let {
		schema,
		store,
		onSubmit,
		submitting = false,
		submitLabel = '保存',
		appearance = 'default',
		children
	}: Props = $props();

	// Svelte keeps this namespace stable across SSR/hydration. Field names stay
	// store keys; indices avoid whitespace and input/error ID collisions.
	const formId = $props.id();

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!store.validateAll()) return;
		await onSubmit(store.values);
	}

	function fieldComponent(def: FieldDef) {
		switch (def.type) {
			case 'password':
				return PasswordField;
			case 'textarea':
				return TextareaField;
			case 'number':
				return NumberField;
			case 'date':
				return DateField;
			case 'select':
				return SelectField;
			case 'checkbox':
				return CheckboxField;
			default:
				return TextField;
		}
	}
</script>

<form onsubmit={handleSubmit} novalidate>
	{#each schema.fields as def, index (def.name)}
		{@const Field = fieldComponent(def)}
		{@const inputId = `${formId}-field-${index}`}
		{@const errorId = `${formId}-error-${index}`}
		{@const underline = appearance === 'underline' && def.type !== 'checkbox'}
		{#snippet control()}
			<Field
				{def}
				class={underline ? 'banto-field-control' : undefined}
				id={inputId}
				aria-describedby={store.errors[def.name] ? errorId : undefined}
				value={store.values[def.name]}
				error={store.errors[def.name]}
				disabled={submitting}
				onInput={(value: unknown) => store.setValue(def.name, value)}
				onBlur={() => store.touch(def.name)}
			/>
		{/snippet}
		<div class="field">
			{#if underline}
				<label class="banto-field banto-field--stacked" for={inputId}>
					{@render control()}
					<span class="banto-field-label">
						{def.label}
						{#if def.required}<span class="required">*</span>{/if}
					</span>
				</label>
			{:else}
				<label class="label" for={inputId}>
					{def.label}
					{#if def.required}<span class="required">*</span>{/if}
				</label>
				{@render control()}
			{/if}
			{#if store.errors[def.name]}
				<p id={errorId} class="error">{store.errors[def.name]}</p>
			{/if}
		</div>
	{/each}

	<div class="footer" class:footer--underline={appearance === 'underline'}>
		{#if children}
			{@render children()}
		{/if}
		<button type="submit" disabled={submitting}>{submitLabel}</button>
	</div>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.label {
		font-size: 0.875rem;
		color: var(--banto-text-muted);
	}

	.required {
		color: var(--banto-danger);
		margin-left: 0.15rem;
	}

	.error {
		margin: 0;
		font-size: 0.8rem;
		color: var(--banto-danger);
	}

	.footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 0.5rem;
	}

	.footer--underline {
		flex-wrap: wrap;
	}

	.footer--underline > button,
	.footer--underline > :global(.banto-btn) {
		box-sizing: border-box;
		max-width: 100%;
		min-height: var(--banto-control-height);
		height: auto;
		padding: var(--banto-space-2) var(--banto-space-3);
		white-space: normal;
		text-align: center;
	}

	.footer--underline > button:focus-visible,
	.footer--underline > :global(.banto-btn:focus-visible) {
		outline: var(--banto-border-width-strong) solid var(--banto-primary-hover);
		outline-offset: var(--banto-border-width);
	}

	button {
		height: var(--banto-control-height);
		box-sizing: border-box;
		padding: 0 1.25rem;
		border: none;
		border-radius: var(--banto-radius-md);
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
		font-weight: 600;
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	button:hover:not(:disabled) {
		background: var(--banto-primary-solid-hover);
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
