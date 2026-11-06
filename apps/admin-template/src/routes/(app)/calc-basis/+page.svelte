<script lang="ts">
	/**
	 * 管理設定 → 計算基準 (design 10.6, banto-cost P4a): the company value of
	 * each item on a chosen date - its version, effective date, scheduled
	 * changes and how many projects override it - with the history of an
	 * item and a form that adds a new version (CalcBasisForm.svelte).
	 *
	 * Reading needs `amount.view` and a capability that works with the basis
	 * (rates, accounting, reports, project management); changing an item
	 * needs its own capability (design 10.3). The server decides; a
	 * `forbidden` read shows the no-access state. Unset items are 未設定,
	 * never 0. Demo mode has no backend.
	 */
	import { PageHeader, EmptyState, ErrorState, LoadingState, StatusBadge } from '@banto/ui';
	import { isProviderError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { getCompanyBasis, type CompanyBasis } from '#lib/banto/calcBasisAdmin.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import {
		calcCapabilityLabel,
		calcGroupLabel,
		calcItemLabel,
		formatCalcValue,
		isForbiddenError,
		todayIso
	} from '#lib/banto/costFormat.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import CalcBasisForm from '#lib/components/CalcBasisForm.svelte';

	const available = isPipelineAvailable();
	const canWrite = $derived(canWriteResources(sessionStore.role));

	let on = $state(todayIso());
	let basis = $state<CompanyBasis | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	const forbidden = $derived(isForbiddenError(loadError));
	/** The item whose history (and, when `editing`, change form) is open. */
	let selectedKey = $state<string | null>(null);
	let editing = $state(false);
	let formPending = $state({ dirty: false, busy: false });
	const guard = guardUnsavedChanges({
		isDirty: () => editing && formPending.dirty,
		isSaving: () => formPending.busy
	});

	const selected = $derived(basis?.items.find((row) => row.item.key === selectedKey) ?? null);

	async function load() {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const result = await getCompanyBasis(on);
			if (token !== loadToken) return;
			basis = result;
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			basis = null;
		}
	}

	$effect(() => {
		void on;
		void load();
	});

	function open(key: string, edit: boolean) {
		selectedKey = key;
		editing = edit;
		formPending = { dirty: false, busy: false };
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.calcBasis']()} description={m['calcBasis.description']()} />

	{#if !available}
		<EmptyState title={m['calcBasis.demoUnavailable']()} />
	{:else if forbidden}
		<EmptyState title={m['cost.forbiddenTitle']()} description={m['cost.forbiddenDesc']()} />
	{:else if loadError}
		<ErrorState
			title={m['cost.loadError']()}
			description={isProviderError(loadError) ? loadError.message : String(loadError)}
		>
			{#snippet action()}
				<button type="button" class="banto-btn banto-btn--secondary" onclick={() => void load()}>
					{m['common.reload']()}
				</button>
			{/snippet}
		</ErrorState>
	{:else if !basis}
		<LoadingState label={m['common.loading']()} />
	{:else}
		<section class="panel">
			<div class="toolbar">
				<label class="field">
					<span>{m['calcBasis.fieldOn']()}</span>
					<input class="banto-input" type="date" bind:value={on} />
				</label>
				<p class="note">{m['calcBasis.onNote']()}</p>
			</div>
			<div class="table-wrap">
				<table>
					<caption class="sr-only">{m['nav.calcBasis']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['calcBasis.colGroup']()}</th>
							<th scope="col">{m['calcBasis.colItem']()}</th>
							<th scope="col" class="num">{m['calcBasis.colCurrent']()}</th>
							<th scope="col">{m['calcBasis.colVersion']()}</th>
							<th scope="col">{m['calcBasis.colScheduled']()}</th>
							<th scope="col" class="num">{m['calcBasis.colOverriding']()}</th>
							<th scope="col">{m['calcBasis.colOverridable']()}</th>
							<th scope="col">{m['calcBasis.colEditRight']()}</th>
							<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
						</tr>
					</thead>
					<tbody>
						{#each basis.items as row (row.item.key)}
							<tr class:selected={row.item.key === selectedKey}>
								<td>{calcGroupLabel(row.item.itemGroup)}</td>
								<td>{calcItemLabel(row.item)}</td>
								<td class="num" class:unset={!row.current}>
									{formatCalcValue(row.current?.value ?? null, row.item.unit)}
								</td>
								<td>
									{#if row.current}
										<div>{m['calcBasis.versionNo']({ no: row.current.versionNo })}</div>
										<div class="sub">
											{m['calcBasis.validFromLabel']({ date: row.current.validFrom })}
										</div>
									{/if}
								</td>
								<td>
									{#each row.scheduled as next (next.id)}
										<div>
											{formatCalcValue(next.value, row.item.unit)}
											<span class="sub"
												>{m['calcBasis.validFromLabel']({ date: next.validFrom })}</span
											>
										</div>
									{/each}
								</td>
								<td class="num">{row.overridingProjects}</td>
								<td>
									{#if row.item.projectOverridable}
										<StatusBadge
											variant="neutral"
											label={row.item.managersMayOverride
												? m['calcBasis.overridableWithManager']()
												: m['calcBasis.overridable']()}
										/>
									{:else}
										{m['calcBasis.notOverridable']()}
									{/if}
								</td>
								<td>{calcCapabilityLabel(row.item.editCapability)}</td>
								<td>
									<div class="row-actions">
										<button
											type="button"
											class="banto-btn banto-btn--ghost"
											onclick={() => open(row.item.key, false)}
										>
											{m['calcBasis.showHistory']()}
										</button>
										{#if canWrite}
											<button
												type="button"
												class="banto-btn banto-btn--secondary"
												onclick={() => open(row.item.key, true)}
											>
												{m['calcBasis.change']()}
											</button>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		{#if selected}
			<section class="panel" aria-labelledby="calc-history-heading">
				<h2 id="calc-history-heading">
					{m['calcBasis.historyTitle']({ item: calcItemLabel(selected.item) })}
				</h2>
				{#if selected.history.length === 0}
					<p class="note">{m['calcBasis.noHistory']()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th scope="col">{m['calcBasis.colVersion']()}</th>
									<th scope="col">{m['calcBasis.fieldValidFrom']()}</th>
									<th scope="col" class="num">{m['calcBasis.fieldValue']()}</th>
									<th scope="col">{m['calcBasis.fieldReason']()}</th>
									<th scope="col">{m['calcBasis.colCreated']()}</th>
								</tr>
							</thead>
							<tbody>
								{#each selected.history as entry (entry.id)}
									<tr>
										<td>{m['calcBasis.versionNo']({ no: entry.versionNo })}</td>
										<td>{entry.validFrom}</td>
										<td class="num">{formatCalcValue(entry.value, selected.item.unit)}</td>
										<td class="wrap">{entry.reason}</td>
										<td>
											<div>{entry.createdByName ?? m['cost.unset']()}</div>
											<div class="sub">{entry.createdAt}</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
				{#if editing && canWrite}
					{#key selected.item.key}
						<CalcBasisForm
							item={selected.item}
							projectId={null}
							onSaved={() => {
								editing = false;
								formPending = { dirty: false, busy: false };
								void load();
							}}
							onCancel={() => {
								editing = false;
								formPending = { dirty: false, busy: false };
							}}
							onPendingChange={(pending) => (formPending = pending)}
						/>
					{/key}
				{/if}
			</section>
		{/if}
		<p class="sr-only" aria-live="polite">{guard.pending ? m['unsaved.notice']() : ''}</p>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 1200px;
	}

	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: min(var(--banto-space-5), 3%);
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-lg);
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--banto-space-3);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.field input {
		color: var(--banto-text);
	}

	.note,
	.sub {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.table-wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--banto-font-size-sm);
	}

	th,
	td {
		padding: var(--banto-space-2);
		border-bottom: 1px solid var(--banto-border);
		text-align: left;
		vertical-align: top;
		white-space: nowrap;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	td.wrap {
		white-space: normal;
		min-width: 12rem;
	}

	tr.selected td {
		background: var(--banto-surface-subtle);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.unset {
		color: var(--banto-text-muted);
	}

	.row-actions {
		display: flex;
		gap: var(--banto-space-1);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
