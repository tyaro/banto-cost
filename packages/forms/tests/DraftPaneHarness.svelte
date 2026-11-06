<script lang="ts">
	/**
	 * Test-only pane (draftPane.test.ts): borrows a `FormDraft`; the page owns the
	 * registration. `registerInPane` registers from an `$effect` to check it does
	 * not loop; that effect also writes to the draft (`seed`) - mutators must not
	 * make it re-run itself (conventions §8).
	 */
	import DraftNumberField from '../src/fields/DraftNumberField.svelte';
	import { draftSourceFrom, type FormDraft } from '../src/draft.svelte';
	import type { DraftCoordinator } from '../src/draftCoordinator.svelte';
	import type { FieldDef } from '../src/types';

	interface Props {
		draft: FormDraft;
		coordinator: DraftCoordinator;
		def: FieldDef;
		seed?: string;
		onEffect?: () => void;
		/** Register from the pane's effect (only the effect-loop test does; real pages register at the draft's lifetime). */
		registerInPane?: boolean;
	}

	let { draft, coordinator, def, seed, onEffect, registerInPane = false }: Props = $props();

	$effect(() => {
		onEffect?.();
		const unregister = registerInPane
			? coordinator.register(draftSourceFrom(draft, async () => true))
			: undefined;
		if (seed !== undefined) draft.setRaw(def.name, seed);
		return unregister;
	});
</script>

<DraftNumberField {def} {draft} />
<output data-testid="state"
	>{coordinator.pending ? 'pending' : 'clean'}:{draft.dirty
		? 'dirty'
		: 'clean'}:{draft.revision}</output
>
