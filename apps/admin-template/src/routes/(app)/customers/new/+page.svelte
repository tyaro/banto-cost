<script lang="ts">
	/** 顧客の新規登録 (banto-cost P3a; same shape as items/new). */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { BantoForm, UnsavedChangesNotice, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { createFormResource, getResource } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { formValidationMessages } from '#lib/banto/i18n.js';
	import { unmatchedFieldErrors } from '#lib/banto/costFormat.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { PageHeader, LoadingState } from '@banto/ui';

	const resource = getResource('customers');
	const schema = resource.schema as FormSchema;
	const fieldNames = schema.fields.map((field) => field.name);

	const formResource = createFormResource('customers');
	const store = createFormStore(schema, undefined, formValidationMessages());
	let formErrors = $state<string[]>([]);

	const guard = guardUnsavedChanges({
		isDirty: () => store.isDirty,
		isSaving: () => formResource.saving
	});

	$effect(() => {
		void formResource.load();
	});

	async function handleSubmit(values: Record<string, unknown>) {
		formErrors = [];
		const result = await formResource.submit(values);
		if (result.ok) {
			store.markClean();
			if (guard.canAutoNavigate) goto(resolve(`customers`));
		} else {
			store.setServerErrors(result.fieldErrors);
			formErrors = unmatchedFieldErrors(fieldNames, result.fieldErrors);
		}
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['customers.createTitle']({ resource: resource.label })} />

	<div class="form-panel">
		{#if formResource.loading}
			<LoadingState label={m['common.loading']()} />
		{:else}
			{#each formErrors as message, i (i)}
				<p class="form-error" role="alert">{message}</p>
			{/each}
			<BantoForm
				appearance="underline"
				{schema}
				{store}
				onSubmit={handleSubmit}
				submitting={formResource.saving}
				submitLabel={m['common.save']()}
			>
				<UnsavedChangesNotice pending={guard.pending} label={m['unsaved.notice']()} />
				<a class="banto-btn banto-btn--ghost" href={resolve(`customers`)}
					>{m['common.backToList']()}</a
				>
			</BantoForm>
		{/if}
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 720px;
	}

	.form-panel {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: min(var(--banto-space-5), 3%);
	}

	.form-error {
		margin: 0 0 var(--banto-space-3);
		color: var(--banto-danger);
	}
</style>
