<script lang="ts">
	/**
	 * 案件詳細 → 計算基準 (design 10.6, banto-cost P4a): for each item, the
	 * company basis, the value this project applies on the chosen date and
	 * where it comes from, with this project's override history. An
	 * overridable item can be overridden from a date on, or set back to the
	 * company basis (a new row with no value - the override stays as
	 * history, T34). Only this project changes (T32).
	 *
	 * Reading needs `ViewProjectAmounts` on the project; overriding needs the
	 * item's capability, or being the project's manager where the item
	 * allows it. A `forbidden` read hides the section behind a short notice.
	 */
	import { untrack } from 'svelte';
	import { isProviderError } from '@banto/admin-core';
	import { LoadingState, StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { getProjectBasis, type ProjectBasis } from '#lib/banto/calcBasisAdmin.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import {
		calcItemLabel,
		formatCalcValue,
		isForbiddenError,
		todayIso
	} from '#lib/banto/costFormat.js';
	import CalcBasisForm from '#lib/components/CalcBasisForm.svelte';

	interface Props {
		projectId: number;
		canWrite: boolean;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { projectId, canWrite, onPendingChange }: Props = $props();

	const available = isPipelineAvailable();
	let on = $state(todayIso());
	let basis = $state<ProjectBasis | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	const forbidden = $derived(isForbiddenError(loadError));
	let selectedKey = $state<string | null>(null);
	let editing = $state<'override' | 'revert' | null>(null);
	const selected = $derived(basis?.items.find((row) => row.item.key === selectedKey) ?? null);

	const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
	/** A cleared or half-typed date is not requested (PR #13 review). */
	const onValid = $derived(DATE_RE.test(on));
	let formPending = { dirty: false, busy: false };

	async function load() {
		if (!available || !DATE_RE.test(on)) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const result = await getProjectBasis(projectId, on);
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
		untrack(() => void load());
	});

	function close() {
		editing = null;
		formPending = { dirty: false, busy: false };
		onPendingChange?.(formPending);
	}

	/** Switching items or modes drops the open form: ask first when it has input (PR #13 review). */
	function canLeaveForm(): boolean {
		if (!editing) return true;
		if (formPending.busy) return false;
		return !formPending.dirty || window.confirm(m['calcBasis.discardConfirm']());
	}

	function select(key: string, mode: 'override' | 'revert' | null) {
		if (!canLeaveForm()) return;
		close();
		selectedKey = key;
		editing = mode;
	}

	function sourceLabel(source: string): string {
		if (source === 'project') return m['calcBasis.sourceProject']();
		if (source === 'company') return m['calcBasis.sourceCompany']();
		return m['cost.unset']();
	}
</script>

<section class="calc-basis" aria-labelledby="calc-basis-heading">
	<h2 id="calc-basis-heading">{m['calcBasis.projectSectionTitle']()}</h2>

	{#if available && !forbidden}
		<label class="field on">
			<span>{m['calcBasis.fieldOn']()}</span>
			<input class="banto-input" type="date" bind:value={on} aria-invalid={!onValid} />
			{#if !onValid}<span class="error">{m['calcBasis.errorDate']()}</span>{/if}
		</label>
	{/if}

	{#if !available}
		<p class="note">{m['calcBasis.demoUnavailable']()}</p>
	{:else if forbidden}
		<p class="note">{m['calcBasis.projectForbidden']()}</p>
	{:else if loadError}
		<p class="error" role="alert">
			{isProviderError(loadError) ? loadError.message : String(loadError)}
		</p>
		<button type="button" class="banto-btn banto-btn--secondary" onclick={() => void load()}>
			{m['common.reload']()}
		</button>
	{:else if !basis}
		<LoadingState label={m['common.loading']()} />
	{:else}
		<p class="note">{m['calcBasis.projectDesc']()}</p>
		<div class="table-wrap">
			<table>
				<caption class="sr-only">{m['calcBasis.projectSectionTitle']()}</caption>
				<thead>
					<tr>
						<th scope="col">{m['calcBasis.colItem']()}</th>
						<th scope="col" class="num">{m['calcBasis.colCompany']()}</th>
						<th scope="col" class="num">{m['calcBasis.colApplied']()}</th>
						<th scope="col">{m['calcBasis.colSource']()}</th>
						<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
					</tr>
				</thead>
				<tbody>
					{#each basis.items as row (row.item.key)}
						<tr class:selected={row.item.key === selectedKey}>
							<td>{calcItemLabel(row.item)}</td>
							<td class="num" class:unset={!row.company}>
								{formatCalcValue(row.company?.value ?? null, row.item.unit)}
							</td>
							<td class="num" class:unset={row.appliedValue === null}>
								{formatCalcValue(row.appliedValue, row.item.unit)}
							</td>
							<td>
								{#if row.source === 'project'}
									<StatusBadge variant="info" label={sourceLabel(row.source)} />
									{#if row.overrideRow}
										<div class="sub">
											{m['calcBasis.validFromLabel']({ date: row.overrideRow.validFrom })}
										</div>
									{/if}
								{:else}
									{sourceLabel(row.source)}
								{/if}
							</td>
							<td>
								<div class="row-actions">
									{#if row.history.length > 0}
										<button
											type="button"
											class="banto-btn banto-btn--ghost"
											onclick={() => select(row.item.key, null)}
										>
											{m['calcBasis.showHistory']()}
										</button>
									{/if}
									{#if canWrite && row.item.projectOverridable}
										<button
											type="button"
											class="banto-btn banto-btn--secondary"
											onclick={() => select(row.item.key, 'override')}
										>
											{m['calcBasis.override']()}
										</button>
										{#if row.source === 'project'}
											<button
												type="button"
												class="banto-btn banto-btn--ghost"
												onclick={() => select(row.item.key, 'revert')}
											>
												{m['calcBasis.revertToCompany']()}
											</button>
										{/if}
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if selected}
			<h3>{m['calcBasis.overrideHistoryTitle']({ item: calcItemLabel(selected.item) })}</h3>
			{#if selected.history.length === 0}
				<p class="note">{m['calcBasis.noOverrides']()}</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">{m['calcBasis.fieldValidFrom']()}</th>
								<th scope="col" class="num">{m['calcBasis.fieldValue']()}</th>
								<th scope="col">{m['calcBasis.fieldReason']()}</th>
								<th scope="col">{m['calcBasis.colCreated']()}</th>
							</tr>
						</thead>
						<tbody>
							{#each selected.history as entry (entry.id)}
								<tr>
									<td>{entry.validFrom}</td>
									<td class="num">
										{entry.value === null
											? m['calcBasis.revertedEntry']()
											: formatCalcValue(entry.value, selected.item.unit)}
									</td>
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
				{#key `${selected.item.key}:${editing}`}
					<CalcBasisForm
						item={selected.item}
						{projectId}
						revert={editing === 'revert'}
						onSaved={() => {
							close();
							void load();
						}}
						onCancel={close}
						onPendingChange={(pending) => {
							formPending = pending;
							onPendingChange?.(pending);
						}}
					/>
				{/key}
			{/if}
		{/if}
	{/if}
</section>

<style>
	.calc-basis {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: min(var(--banto-space-5), 3%);
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-lg);
	}

	h3 {
		margin: var(--banto-space-2) 0 0;
		font-size: var(--banto-font-size-md);
	}

	.note,
	.sub {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
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

	.on {
		align-self: flex-start;
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
		border-bottom: var(--banto-border-width) solid var(--banto-border);
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
