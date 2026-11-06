<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { BantoForm, UnsavedChangesNotice, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { createFormResource, getResource } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { formValidationMessages } from '#lib/banto/i18n.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { PageHeader, LoadingState } from '@banto/ui';

	const resource = getResource('items');
	const schema = resource.schema as FormSchema;

	const formResource = createFormResource('items');
	// i18n layer ② (ADR-0005): inject Paraglide-backed validation messages.
	const store = createFormStore(schema, undefined, formValidationMessages());

	// Issue #214: ask before leaving with unsaved input (or mid-save).
	const guard = guardUnsavedChanges({
		isDirty: () => store.isDirty,
		isSaving: () => formResource.saving
	});

	$effect(() => {
		void formResource.load();
	});

	async function handleSubmit(values: Record<string, unknown>) {
		const result = await formResource.submit(values);
		if (result.ok) {
			// Saved: the values are no longer unsaved, so the move back to the
			// list must not prompt. Skip the move if the user already chose
			// another screen while the save was in flight - even if that screen
			// is still loading (don't override their choice).
			store.markClean();
			if (guard.canAutoNavigate) goto(resolve(`items`));
		} else {
			store.setServerErrors(result.fieldErrors);
		}
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['items.createTitle']({ resource: resource.label })} />

	<div class="form-panel">
		{#if formResource.loading}
			<LoadingState label={m['common.loading']()} />
		{:else}
			<BantoForm
				appearance="underline"
				{schema}
				{store}
				onSubmit={handleSubmit}
				submitting={formResource.saving}
				submitLabel={m['common.save']()}
			>
				<UnsavedChangesNotice pending={guard.pending} label={m['unsaved.notice']()} />
				<!-- Cancel = back to the list; the guard asks first if anything is unsaved. -->
				<a class="banto-btn banto-btn--ghost" href={resolve(`items`)}>{m['common.backToList']()}</a>
			</BantoForm>
		{/if}
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		/* Readable form width (design.md §Phase 4), not the full page width. */
		max-width: 720px;
	}

	.form-panel {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		/* Keep native date segments usable in a narrow form at enlarged text. */
		padding: min(var(--banto-space-5), 3%);
	}
</style>
