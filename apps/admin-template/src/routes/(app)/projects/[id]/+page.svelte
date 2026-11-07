<script lang="ts">
	/**
	 * 案件の詳細・編集 (banto-cost P3a, spec §5.1) + 案件見込 (§5.4,
	 * PipelineSection.svelte). Same load/save shape as customers/[id], without
	 * delete. The `rowVersion` read by `getOne` stays in the form values so
	 * the update carries it back; a stale one is a `rowVersion` field error
	 * that no field owns, listed above the form.
	 *
	 * The calc basis of the project (P4a, design 10.6) is CalcBasisSection.svelte;
	 * its hours by phase (P4b, spec §6.1) are TimeSection.svelte, its budget
	 * versions (P4c, spec §5.3) BudgetSection.svelte, its direct costs and
	 * purchase orders (P4d, spec §6.3) CostsSection.svelte, its completion
	 * forecast versions (P5, spec §6.6) ForecastSection.svelte.
	 * Order conversion and ordered revenue (P3b) are OrderSection.svelte; it
	 * asks this page to reload after a conversion (status and rowVersion change).
	 * An ordered project's status moves only between 受注・進行中・作業完了.
	 * Viewing needs admin or `ViewProject` on this project (design 第2章);
	 * `forbidden` shows a no-access state.
	 *
	 * As with every detail page, the (app) layout keys this page on its route params,
	 * so reading `page.params.id` once at setup is enough.
	 */
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { BantoForm, UnsavedChangesNotice, createFormStore, type FormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { createFormResource, getResource, isProviderError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { formValidationMessages } from '#lib/banto/i18n.js';
	import { isForbiddenError, statusLabel, unmatchedFieldErrors } from '#lib/banto/costFormat.js';
	import { isOrderedStatus, projectFormSchema } from '#lib/banto/resources/projects.js';
	import { loadProjectPickers } from '#lib/banto/projectPickers.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';
	import PipelineSection from './PipelineSection.svelte';
	import OrderSection from './OrderSection.svelte';
	import CalcBasisSection from './CalcBasisSection.svelte';
	import TimeSection from './TimeSection.svelte';
	import BudgetSection from './BudgetSection.svelte';
	import CostsSection from './CostsSection.svelte';
	import ForecastSection from './ForecastSection.svelte';

	const resource = getResource('projects');
	const canWrite = $derived(canWriteResources(sessionStore.role));

	// Tauri's `projects_get` takes `id: i64`: convert the route param first.
	const rawId = page.params.id ?? '';
	const parsedId = Number(rawId);
	const idValid = rawId !== '' && Number.isInteger(parsedId);

	const formResource = idValid ? createFormResource(resource.name, parsedId) : null;
	// `.raw`: the schema carries lazy label getters a deep proxy would not need.
	let schema = $state.raw<FormSchema | null>(null);
	let store = $state.raw<FormStore | null>(null);
	let status = $state('');
	let customerName = $state('');
	let managerName = $state('');
	let projectCode = $state('');
	let projectName = $state('');
	let projectRowVersion = $state(0);
	let formErrors = $state<string[]>([]);

	// The pipeline section's own form counts too (PR #9 review).
	let pipelineDirty = $state(false);
	let pipelineBusy = $state(false);
	let ordersDirty = $state(false);
	let ordersBusy = $state(false);
	let calcDirty = $state(false);
	let calcBusy = $state(false);
	let budgetDirty = $state(false);
	let budgetBusy = $state(false);
	let costsDirty = $state(false);
	let costsBusy = $state(false);
	let forecastDirty = $state(false);
	let forecastBusy = $state(false);
	const guard = guardUnsavedChanges({
		isDirty: () =>
			(store?.isDirty ?? false) ||
			pipelineDirty ||
			ordersDirty ||
			calcDirty ||
			budgetDirty ||
			costsDirty ||
			forecastDirty,
		isSaving: () =>
			(formResource?.saving ?? false) ||
			pipelineBusy ||
			ordersBusy ||
			calcBusy ||
			budgetBusy ||
			costsBusy ||
			forecastBusy
	});

	async function loadForm() {
		if (!formResource) return;
		await formResource.load();
		const initial = formResource.initialValues;
		if (!initial) return;
		const pickers = await loadProjectPickers(sessionStore.role, Number(initial.customerId));
		status = String(initial.status ?? '');
		customerName = String(initial.customerName ?? '');
		managerName = String(initial.managerName ?? '');
		projectCode = String(initial.code ?? '');
		projectName = String(initial.name ?? '');
		projectRowVersion = Number(initial.rowVersion ?? 0);
		const built = projectFormSchema({ ...pickers, currentStatus: status });
		store = createFormStore(built, initial, formValidationMessages());
		schema = built;
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
	const ordered = $derived(isOrderedStatus(status));
	const managerIsSelect = $derived(
		schema?.fields.some((field) => field.name === 'managerUserId' && field.type === 'select') ??
			false
	);

	async function handleSubmit(values: Record<string, unknown>) {
		if (!formResource || !canWrite || !schema || !store) return;
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
	<PageHeader hideTitle title={m['projects.editTitle']({ resource: resource.label })} />

	<div class="form-panel">
		{#if isNotFound}
			<EmptyState
				title={m['cost.notFoundTitle']({ resource: resource.label })}
				description={m['cost.notFoundDesc']()}
			>
				{#snippet action()}
					<a class="banto-btn banto-btn--secondary" href={resolve(`projects`)}
						>{m['common.backToList']()}</a
					>
				{/snippet}
			</EmptyState>
		{:else if forbidden}
			<EmptyState title={m['cost.forbiddenTitle']()} description={m['cost.forbiddenDesc']()} />
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
		{:else if !schema || !store}
			<LoadingState label={m['common.loading']()} />
		{:else}
			<dl class="summary">
				<div>
					<dt>{m['projects.fieldCustomer']()}</dt>
					<dd>{customerName}</dd>
				</div>
				<div>
					<dt>{m['projects.fieldManager']()}</dt>
					<dd>{managerName}</dd>
				</div>
				<div>
					<dt>{m['projects.fieldStatus']()}</dt>
					<dd>{statusLabel(status)}</dd>
				</div>
			</dl>
			{#if ordered}
				<p class="hint">{m['projects.orderedStatusHint']()}</p>
			{/if}
			{#if !managerIsSelect}
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
				submitting={(formResource?.saving ?? false) || !canWrite}
				submitLabel={m['common.save']()}
			>
				<UnsavedChangesNotice pending={guard.pending} label={m['unsaved.notice']()} />
				<a class="banto-btn banto-btn--ghost" href={resolve(`projects`)}
					>{m['common.backToList']()}</a
				>
			</BantoForm>
		{/if}
	</div>

	{#if schema && idValid}
		{#key status}
			<OrderSection
				projectId={parsedId}
				code={projectCode}
				{status}
				rowVersion={projectRowVersion}
				{canWrite}
				onProjectChanged={() => void loadForm()}
				onPendingChange={(pending) => {
					ordersDirty = pending.dirty;
					ordersBusy = pending.busy;
				}}
			/>
		{/key}
		<PipelineSection
			projectId={parsedId}
			{ordered}
			{canWrite}
			onPendingChange={(pending) => {
				pipelineDirty = pending.dirty;
				pipelineBusy = pending.busy;
			}}
		/>
		<CalcBasisSection
			projectId={parsedId}
			{canWrite}
			onPendingChange={(pending) => {
				calcDirty = pending.dirty;
				calcBusy = pending.busy;
			}}
		/>
		<BudgetSection
			projectId={parsedId}
			{canWrite}
			onPendingChange={(pending) => {
				budgetDirty = pending.dirty;
				budgetBusy = pending.busy;
			}}
		/>
		{#if ordered}
			<ForecastSection
				projectId={parsedId}
				{canWrite}
				onPendingChange={(pending) => {
					forecastDirty = pending.dirty;
					forecastBusy = pending.busy;
				}}
			/>
		{/if}
		<CostsSection
			projectId={parsedId}
			projectLabel={`${projectCode} ${projectName}`.trim()}
			{canWrite}
			onPendingChange={(pending) => {
				costsDirty = pending.dirty;
				costsBusy = pending.busy;
			}}
		/>
		<TimeSection projectId={parsedId} />
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 1100px;
	}

	.form-panel {
		max-width: 720px;
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: min(var(--banto-space-5), 3%);
	}

	.summary {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-4);
		margin: 0 0 var(--banto-space-3);
	}

	.summary dt {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.summary dd {
		margin: 0;
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
