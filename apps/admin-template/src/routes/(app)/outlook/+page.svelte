<script lang="ts">
	/**
	 * 月次売上見通し (spec §7.5, banto-cost P3b, T27). Per month:
	 * 計上済み売上 + 受注済み売上予定 (still open) + 未受注の売上見込
	 * (plan × probability), shown as three separate columns plus their sum.
	 *
	 * Display rules (banto-cost CLAUDE.md, spec §7.5):
	 * - Order-month figures (the pipeline page) are never added here.
	 * - 時期未定 is its own row, outside the month totals.
	 * - 未確定追加売上 (pending order changes) is a separate column outside
	 *   the total.
	 * - Pre-order projects whose amount or probability is unset are listed,
	 *   not counted as 0; ordered projects whose plan does not match the
	 *   unrecognized remainder are listed too.
	 * - A saved snapshot keeps its figures; comparing shows 前回差異.
	 *
	 * Scope: the server returns only projects whose amounts the caller may
	 * see (`amount_projects`); saving a snapshot needs `report.all`.
	 */
	import { resolve } from '$app/paths';
	import { isProviderError, notify } from '@banto/admin-core';
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import {
		getOutlook,
		getSnapshot,
		listSnapshots,
		saveSnapshot,
		type OutlookView,
		type SnapshotInfo
	} from '#lib/banto/ordersAdmin.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import {
		formatSignedYen,
		formatYen,
		isForbiddenError,
		revenueIssueLabel
	} from '#lib/banto/costFormat.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';

	const available = isPipelineAvailable();
	const canWrite = $derived(canWriteResources(sessionStore.role));

	let from = $state('');
	let to = $state('');
	/** '' = no comparison. */
	let compare = $state('');
	/** '' = the live outlook; otherwise a snapshot id to show as saved. */
	let viewing = $state('');
	let snapshots = $state<SnapshotInfo[]>([]);
	let view = $state<OutlookView | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	let label = $state('');
	let saving = $state(false);
	const forbidden = $derived(isForbiddenError(loadError));

	async function load() {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const range = { from: from || null, to: to || null };
			const [result, list] = await Promise.all([
				viewing
					? getSnapshot(Number(viewing), range)
					: getOutlook({ ...range, compare: compare ? Number(compare) : null }),
				listSnapshots().catch(() => [] as SnapshotInfo[])
			]);
			if (token !== loadToken) return;
			view = result;
			snapshots = list;
		} catch (err) {
			if (token === loadToken) loadError = err;
		}
	}

	void load();

	async function save() {
		if (saving || label.trim() === '') return;
		saving = true;
		try {
			const saved = await saveSnapshot(label.trim());
			notify('success', m['outlook.snapshotSaved']({ label: saved.label }));
			label = '';
			await load();
		} catch (err) {
			if (isForbiddenError(err)) notify('error', m['outlook.snapshotForbidden']());
			else if (isProviderError(err) && err.body.kind === 'validation') {
				notify('error', err.body.field_errors.map((e) => e.message).join(' / '));
			} else notify('error', isProviderError(err) ? err.message : String(err));
		} finally {
			saving = false;
		}
	}

	const comparing = $derived(view?.compared !== null && view?.compared !== undefined);
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.outlook']()} description={m['outlook.description']()}>
		{#snippet actions()}
			{#if available}
				<button type="button" class="banto-btn banto-btn--secondary" onclick={() => void load()}>
					{m['common.reload']()}
				</button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if !available}
		<EmptyState
			title={m['pipeline.demoUnavailableTitle']()}
			description={m['pipeline.demoUnavailable']()}
		/>
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
	{:else}
		<form
			class="panel filters"
			onsubmit={(event) => {
				event.preventDefault();
				void load();
			}}
		>
			<label class="field">
				<span>{m['outlook.from']()}</span>
				<input class="banto-input" type="month" placeholder="YYYY-MM" bind:value={from} />
			</label>
			<label class="field">
				<span>{m['outlook.to']()}</span>
				<input class="banto-input" type="month" placeholder="YYYY-MM" bind:value={to} />
			</label>
			<label class="field">
				<span>{m['outlook.show']()}</span>
				<select class="banto-input" bind:value={viewing}>
					<option value="">{m['outlook.live']()}</option>
					{#each snapshots as snapshot (snapshot.id)}
						<option value={String(snapshot.id)}>{snapshot.label} ({snapshot.createdAt})</option>
					{/each}
				</select>
			</label>
			{#if !viewing}
				<label class="field">
					<span>{m['outlook.compare']()}</span>
					<select class="banto-input" bind:value={compare}>
						<option value="">{m['outlook.noCompare']()}</option>
						{#each snapshots as snapshot (snapshot.id)}
							<option value={String(snapshot.id)}>{snapshot.label} ({snapshot.createdAt})</option>
						{/each}
					</select>
				</label>
			{/if}
			<button type="submit" class="banto-btn banto-btn--primary">{m['outlook.apply']()}</button>
		</form>

		{#if !view}
			<LoadingState label={m['common.loading']()} />
		{:else}
			{#if view.snapshot}
				<p class="note" role="status">
					{m['outlook.viewingSnapshot']({
						label: view.snapshot.label,
						at: view.snapshot.createdAt
					})}
				</p>
			{/if}
			<section class="panel">
				<h2>{m['outlook.tableTitle']()}</h2>
				{#if view.rows.length === 0}
					<p class="note">{m['outlook.noRows']()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th scope="col">{m['outlook.colMonth']()}</th>
									<th scope="col" class="num">{m['outlook.colRecognized']()}</th>
									<th scope="col" class="num">{m['outlook.colOrderedPlan']()}</th>
									<th scope="col" class="num">{m['outlook.colWeightedPipeline']()}</th>
									<th scope="col" class="num">{m['outlook.colTotal']()}</th>
									{#if comparing}
										<th scope="col" class="num">{m['outlook.colPrevious']()}</th>
										<th scope="col" class="num">{m['outlook.colDifference']()}</th>
									{/if}
									<th scope="col" class="num">{m['outlook.colPending']()}</th>
								</tr>
							</thead>
							<tbody>
								{#each view.rows as row (row.month ?? '')}
									<tr class:undated={row.month === null}>
										<td>{row.month ?? m['pipeline.timeUndecided']()}</td>
										<td class="num">{formatYen(row.recognized)}</td>
										<td class="num">{formatYen(row.orderedPlan)}</td>
										<td class="num">{formatYen(row.weightedPipeline)}</td>
										<td class="num strong">{formatYen(row.total)}</td>
										{#if comparing}
											<td class="num">{formatYen(row.previousTotal)}</td>
											<td class="num">{formatSignedYen(row.difference)}</td>
										{/if}
										<td class="num muted">{formatSignedYen(row.pendingAddition)}</td>
									</tr>
								{/each}
							</tbody>
							<tfoot>
								<tr>
									<th scope="row">{m['outlook.monthTotal']()}</th>
									<td class="num">{formatYen(view.totals.recognized)}</td>
									<td class="num">{formatYen(view.totals.orderedPlan)}</td>
									<td class="num">{formatYen(view.totals.weightedPipeline)}</td>
									<td class="num strong">{formatYen(view.totals.total)}</td>
									{#if comparing}
										<td class="num">{formatYen(view.totals.previousTotal)}</td>
										<td class="num">{formatSignedYen(view.totals.difference)}</td>
									{/if}
									<td class="num muted">{formatSignedYen(view.totals.pendingAddition)}</td>
								</tr>
							</tfoot>
						</table>
					</div>
				{/if}
				<p class="note">{m['outlook.tableNote']()}</p>
			</section>

			{#if view.excluded.length > 0}
				<section class="panel">
					<h2>{m['outlook.excludedTitle']()}</h2>
					<ul>
						{#each view.excluded as project (project.projectId)}
							<li>
								<a href={resolve(`projects/${project.projectId}`)}>{project.code}</a>
								{project.name}
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if view.revenueIssues.length > 0}
				<section class="panel" role="alert">
					<h2>{m['outlook.issuesTitle']()}</h2>
					<ul>
						{#each view.revenueIssues as project (project.projectId)}
							<li>
								<a href={resolve(`projects/${project.projectId}`)}>{project.code}</a>
								{project.name}: {project.issues.map(revenueIssueLabel).join(' / ')}
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if canWrite && !view.snapshot}
				<form
					class="panel filters"
					onsubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<label class="field grow">
						<span>{m['outlook.snapshotLabel']()}</span>
						<input
							class="banto-input"
							type="text"
							maxlength="100"
							placeholder={m['outlook.snapshotPlaceholder']()}
							bind:value={label}
							disabled={saving}
						/>
					</label>
					<button
						type="submit"
						class="banto-btn banto-btn--secondary"
						disabled={saving || label.trim() === ''}
					>
						{m['outlook.saveSnapshot']()}
					</button>
					<p class="note full">{m['outlook.snapshotNote']()}</p>
				</form>
			{/if}
		{/if}
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: var(--banto-space-4);
	}

	.filters {
		flex-direction: row;
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

	.field input,
	.field select {
		color: var(--banto-text);
	}

	.grow {
		flex: 1 1 16rem;
	}

	.full {
		flex-basis: 100%;
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-md);
	}

	.note {
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
		white-space: nowrap;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	tfoot th,
	tfoot td {
		border-top: 2px solid var(--banto-border);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.strong {
		font-weight: 600;
	}

	.muted,
	tr.undated td {
		color: var(--banto-text-muted);
	}

	ul {
		margin: 0;
		padding-left: 1.25rem;
	}
</style>
