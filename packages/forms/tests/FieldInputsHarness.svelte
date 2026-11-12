<script lang="ts">
	/**
	 * Test-only host (dateField.test.ts): provides field inputs through the
	 * context the way an app layout does (`provideFieldInputs`, date-time-pickers
	 * §5.7), then renders a `BantoForm` and a `DraftDateField` below it.
	 */
	import type { Component } from 'svelte';
	import BantoForm from '../src/BantoForm.svelte';
	import DraftDateField from '../src/fields/DraftDateField.svelte';
	import type { FormDraft } from '../src/draft.svelte';
	import {
		provideFieldInputs,
		type DateFieldInputProps,
		type FieldInputs
	} from '../src/fieldInputs';
	import type { FormStore } from '../src/store.svelte';
	import type { FieldDef, FormSchema } from '../src/types';

	interface Props {
		provided?: Component<DateFieldInputProps>;
		/** Every type at once (wins over `provided`). */
		providedInputs?: FieldInputs;
		schema?: FormSchema;
		store?: FormStore;
		onSubmit?: (values: Record<string, unknown>) => void;
		fieldInputs?: FieldInputs;
		draft?: FormDraft;
		draftDef?: FieldDef;
		onCommit?: (valid: boolean) => void;
	}

	let {
		provided,
		providedInputs,
		schema,
		store,
		onSubmit,
		fieldInputs,
		draft,
		draftDef,
		onCommit
	}: Props = $props();

	// svelte-ignore state_referenced_locally
	provideFieldInputs(providedInputs ?? (provided ? { date: provided } : {}));
</script>

{#if schema && store}
	<BantoForm {schema} {store} onSubmit={onSubmit ?? (() => {})} {fieldInputs} />
{/if}
{#if draft && draftDef}
	<label for="draft-date">{draftDef.label}</label>
	<DraftDateField id="draft-date" def={draftDef} {draft} {onCommit} />
{/if}
<button type="button">Outside</button>
