<script lang="ts">
	/**
	 * 顧客の詳細・編集 (banto-cost P3a; same shape as items/[id], without
	 * delete - customers are switched to inactive instead). The `rowVersion`
	 * read by `getOne` stays in the form values, so the update carries it
	 * back; a stale one comes back as a `rowVersion` field error, which no
	 * rendered field owns and is therefore listed above the form.
	 *
	 * As with items/[id], the (app) layout keys this page on its route params,
	 * so reading `page.params.id` once at setup is enough.
	 */
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { BantoForm, UnsavedChangesNotice, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { createFormResource, getResource, isProviderError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { formValidationMessages } from '#lib/banto/i18n.js';
	import { isForbiddenError, unmatchedFieldErrors } from '#lib/banto/costFormat.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';

	const resource = getResource('customers');
	const schema = resource.schema as FormSchema;
	const fieldNames = schema.fields.map((field) => field.name);
	const canWrite = $derived(canWriteResources(sessionStore.role));

	// Tauri's `customers_get` takes `id: i64`: convert the route param first.
	const rawId = page.params.id ?? '';
	const parsedId = Number(rawId);
	const idValid = rawId !== '' && Number.isInteger(parsedId);

	const formResource = idValid ? createFormResource(resource.name, parsedId) : null;
	let store = $state(createFormStore(schema, undefined, formValidationMessages()));
	let storeReady = $state(false);
	let formErrors = $state<string[]>([]);

	const guard = guardUnsavedChanges({
		isDirty: () => storeReady && store.isDirty,
		isSaving: () => formResource?.saving ?? false
	});

	async function loadForm() {
		if (!formResource) return;
		await formResource.load();
		if (formResource.initialValues) {
			store = createFormStore(schema, formResource.initialValues, formValidationMessages());
			storeReady = true;
		}
	}

	$effect(() => {
		void loadForm();
	});

	const isNotFound = $derived.by(() => {
		if (!idValid) return true;
		const err = formResource?.error;
		return isProviderError(err) && err.body.kind === 'not_found';
	});
	const forbidden = $derived(isForbiddenError(formResource?.error));

	async function handleSubmit(values: Record<string, unknown>) {
		if (!formResource || !canWrite) return;
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
	<PageHeader hideTitle title={m['customers.editTitle']({ resource: resource.label })} />

	<div class="form-panel">
		{#if isNotFound}
			<EmptyState
				title={m['cost.notFoundTitle']({ resource: resource.label })}
				description={m['cost.notFoundDesc']()}
			>
				{#snippet action()}
					<a class="banto-btn banto-btn--secondary" href={resolve(`customers`)}
						>{m['common.backToList']()}</a
					>
				{/snippet}
			</EmptyState>
		{:else if forbidden}
			<EmptyState title={m['cost.forbiddenTitle']()} description={m['cost.forbiddenDesc']()} />
		{:else if formResource?.loading}
			<LoadingState label={m['common.loading']()} />
		{:else if formResource?.error}
			<ErrorState title={m['cost.loadError']()} description={formResource.error.message}>
				{#snippet action()}
					<button
						type="button"
						class="banto-btn banto-btn--secondary"
						onclick={() => void loadForm()}
					>
						{m['common.reload']()}
					</button>
				{/snippet}
			</ErrorState>
		{:else if storeReady}
			{#each formErrors as message, i (i)}
				<p class="form-error" role="alert">{message}</p>
			{/each}
			<BantoForm
				appearance="underline"
				{schema}
				{store}
				onSubmit={handleSubmit}
				submitting={(formResource?.saving ?? false) || !canWrite}
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
