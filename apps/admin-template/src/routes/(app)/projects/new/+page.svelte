<script lang="ts">
	/**
	 * 案件の新規登録 (banto-cost P3a, spec §5.1; same shape as customers/new).
	 * The form waits for the customer / manager choices (projectPickers.ts)
	 * before it is built, so the schema and its store are created once. Only
	 * the pre-order statuses and 失注・中止・保留 can be chosen
	 * (`projectFormSchema`); a new project starts as 引合.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { BantoForm, UnsavedChangesNotice, createFormStore, type FormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { createFormResource, getResource } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { formValidationMessages } from '#lib/banto/i18n.js';
	import { unmatchedFieldErrors } from '#lib/banto/costFormat.js';
	import { projectFormSchema } from '#lib/banto/resources/projects.js';
	import { loadProjectPickers, ownUserId } from '#lib/banto/projectPickers.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { PageHeader, LoadingState } from '@banto/ui';

	const resource = getResource('projects');
	const formResource = createFormResource('projects');

	// `.raw`: the schema carries lazy label getters a deep proxy would not need.
	let schema = $state.raw<FormSchema | null>(null);
	let store = $state.raw<FormStore | null>(null);
	let formErrors = $state<string[]>([]);

	const guard = guardUnsavedChanges({
		isDirty: () => store?.isDirty ?? false,
		isSaving: () => formResource.saving
	});

	// Once per page instance (ssr is off, so setup runs in the browser only).
	async function buildForm() {
		const pickers = await loadProjectPickers();
		const built = projectFormSchema(pickers);
		const manager = ownUserId(sessionStore.identity);
		store = createFormStore(
			built,
			manager !== undefined ? { managerUserId: manager } : undefined,
			formValidationMessages()
		);
		schema = built;
	}
	void buildForm();

	async function handleSubmit(values: Record<string, unknown>) {
		if (!schema || !store) return;
		formErrors = [];
		const result = await formResource.submit(values);
		if (result.ok) {
			store.markClean();
			if (guard.canAutoNavigate) goto(resolve(`projects`));
		} else {
			store.setServerErrors(result.fieldErrors);
			formErrors = unmatchedFieldErrors(
				schema.fields.map((field) => field.name),
				result.fieldErrors
			);
		}
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['projects.createTitle']({ resource: resource.label })} />

	<div class="form-panel">
		{#if !schema || !store}
			<LoadingState label={m['common.loading']()} />
		{:else}
			{#if !schema.fields.some((field) => field.name === 'managerUserId' && field.type === 'select')}
				<p class="hint">{m['projects.managerIdHint']()}</p>
			{/if}
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
				<a class="banto-btn banto-btn--ghost" href={resolve(`projects`)}
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

	.hint {
		margin: 0 0 var(--banto-space-3);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.form-error {
		margin: 0 0 var(--banto-space-3);
		color: var(--banto-danger);
	}
</style>
