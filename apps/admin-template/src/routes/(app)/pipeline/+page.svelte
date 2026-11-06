<script lang="ts">
	/**
	 * 案件見込の一覧・集計 (spec §5.4 / §7.5, banto-cost P3a). Reads the
	 * server's aggregate of the latest ADOPTED version of each pre-order
	 * project in the caller's scope (pipelineAdmin.ts `getPipelineOverview`).
	 *
	 * Display rules (banto-cost CLAUDE.md):
	 * - 受注予定月別 and 売上予定月別 are two different views of the same
	 *   pipeline and are kept in separate tables - never added together.
	 * - An undecided month is labelled 未定 / 時期未定, never folded into a month.
	 * - Unset amounts / probabilities show 未設定, never 0, and the projects
	 *   missing them are counted, not silently dropped.
	 */
	import { resolve } from '$app/paths';
	import { isProviderError } from '@banto/admin-core';
	import { StatusBadge, PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import {
		getPipelineOverview,
		isPipelineAvailable,
		type PipelineOverview
	} from '#lib/banto/pipelineAdmin.js';
	import {
		formatOptional,
		formatPct,
		formatYen,
		isForbiddenError,
		issueLabel,
		stageLabel,
		statusLabel
	} from '#lib/banto/costFormat.js';

	const available = isPipelineAvailable();

	let overview = $state<PipelineOverview | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	const forbidden = $derived(isForbiddenError(loadError));

	async function load() {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const result = await getPipelineOverview();
			if (token === loadToken) overview = result;
		} catch (err) {
			if (token === loadToken) loadError = err;
		}
	}

	void load();
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.pipeline']()} description={m['pipeline.description']()}>
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
	{:else if !overview}
		<LoadingState label={m['common.loading']()} />
	{:else}
		{@const totals = overview.totals}
		<section class="tiles" aria-label={m['pipeline.totalsTitle']()}>
			<div class="tile">
				<span class="tile-label">{m['pipeline.totalAmount']()}</span>
				<span class="tile-value">{formatYen(totals.total)}</span>
				<span class="tile-sub">{m['pipeline.activeCount']({ count: totals.activeCount })}</span>
			</div>
			<div class="tile">
				<span class="tile-label">{m['pipeline.weightedAmount']()}</span>
				<span class="tile-value">{formatYen(totals.weighted)}</span>
			</div>
			<div class="tile">
				<span class="tile-label">{m['pipeline.missingAmountCount']()}</span>
				<span class="tile-value">{totals.missingAmount.length}</span>
			</div>
			<div class="tile">
				<span class="tile-label">{m['pipeline.missingProbabilityCount']()}</span>
				<span class="tile-value">{totals.missingProbability.length}</span>
			</div>
			<div class="tile">
				<span class="tile-label">{m['pipeline.withoutAdoptedCount']()}</span>
				<span class="tile-value">{totals.withoutAdoptedVersion.length}</span>
			</div>
			<div class="tile">
				<span class="tile-label">{m['pipeline.excludedCount']()}</span>
				<span class="tile-value">{totals.excludedCount}</span>
			</div>
		</section>
		<p class="note">{m['pipeline.totalsNote']()}</p>

		<div class="months">
			<section class="panel">
				<h2>{m['pipeline.byOrderMonthTitle']()}</h2>
				{#if overview.byOrderMonth.length === 0}
					<p class="note">{m['pipeline.noRows']()}</p>
				{:else}
					<table>
						<thead>
							<tr>
								<th scope="col">{m['pipeline.fieldExpectedOrderMonth']()}</th>
								<th scope="col" class="num">{m['pipeline.colTotal']()}</th>
								<th scope="col" class="num">{m['pipeline.colWeighted']()}</th>
							</tr>
						</thead>
						<tbody>
							{#each overview.byOrderMonth as row (row.month ?? '')}
								<tr>
									<td>{row.month ?? m['pipeline.monthUndecided']()}</td>
									<td class="num">{formatYen(row.total)}</td>
									<td class="num">{formatYen(row.weighted)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</section>

			<section class="panel">
				<h2>{m['pipeline.byRevenueMonthTitle']()}</h2>
				{#if overview.byRevenueMonth.length === 0}
					<p class="note">{m['pipeline.noRows']()}</p>
				{:else}
					<table>
						<thead>
							<tr>
								<th scope="col">{m['pipeline.planMonth']()}</th>
								<th scope="col" class="num">{m['pipeline.colWeightedRevenue']()}</th>
							</tr>
						</thead>
						<tbody>
							{#each overview.byRevenueMonth as row (row.month ?? '')}
								<tr>
									<td>{row.month ?? m['pipeline.timeUndecided']()}</td>
									<td class="num">{formatYen(row.weighted)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
				{#if overview.revenueExcluded.length > 0}
					<p class="note">
						{m['pipeline.revenueExcluded']({ count: overview.revenueExcluded.length })}
					</p>
				{/if}
			</section>
		</div>
		<p class="note">{m['pipeline.monthsNote']()}</p>

		<section class="panel">
			<h2>{m['pipeline.rowsTitle']()}</h2>
			{#if overview.rows.length === 0}
				<p class="note">{m['pipeline.noRows']()}</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">{m['projects.fieldCode']()}</th>
								<th scope="col">{m['projects.fieldName']()}</th>
								<th scope="col">{m['projects.fieldCustomer']()}</th>
								<th scope="col">{m['projects.fieldStatus']()}</th>
								<th scope="col">{m['pipeline.fieldStage']()}</th>
								<th scope="col">{m['pipeline.colVersion']()}</th>
								<th scope="col" class="num">{m['pipeline.fieldExpectedAmount']()}</th>
								<th scope="col" class="num">{m['pipeline.fieldProbability']()}</th>
								<th scope="col" class="num">{m['pipeline.colWeighted']()}</th>
								<th scope="col">{m['pipeline.fieldExpectedOrderMonth']()}</th>
								<th scope="col" class="num">{m['pipeline.colUndated']()}</th>
								<th scope="col">{m['pipeline.fieldConfirmedOn']()}</th>
								<th scope="col">{m['pipeline.colIssues']()}</th>
							</tr>
						</thead>
						<tbody>
							{#each overview.rows as row (row.projectId)}
								<tr>
									<td>
										<a href={resolve(`projects/${row.projectId}`)}>{row.code}</a>
									</td>
									<td>{row.name}</td>
									<td>{row.customerName}</td>
									<td>{statusLabel(row.status)}</td>
									<td class:unset={!row.stage}>{stageLabel(row.stage)}</td>
									<td class:unset={row.versionNo === null}>
										{row.versionNo === null
											? m['cost.unset']()
											: m['pipeline.versionNo']({ no: row.versionNo })}
									</td>
									<td class="num" class:unset={row.expectedAmount === null}>
										{formatYen(row.expectedAmount)}
									</td>
									<td class="num" class:unset={row.probabilityPct === null}>
										{formatPct(row.probabilityPct)}
									</td>
									<td class="num" class:unset={row.weightedAmount === null}>
										{formatYen(row.weightedAmount)}
									</td>
									<td class:unset={!row.expectedOrderMonth}>
										{row.expectedOrderMonth ?? m['pipeline.monthUndecided']()}
									</td>
									<td class="num" class:unset={row.undatedAmount === null}>
										{formatYen(row.undatedAmount)}
									</td>
									<td class:unset={!row.confirmedOn}>{formatOptional(row.confirmedOn)}</td>
									<td>
										<div class="badges">
											{#each row.issues as issue (issue)}
												<StatusBadge variant="warning" label={issueLabel(issue)} />
											{/each}
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: var(--banto-space-3);
	}

	.tile,
	.panel {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: var(--banto-space-4);
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
	}

	.tile-label,
	.tile-sub {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.tile-value {
		font-size: var(--banto-font-size-xl);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.months {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: var(--banto-space-3);
		align-items: start;
	}

	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
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
		vertical-align: top;
		white-space: nowrap;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.unset {
		color: var(--banto-text-muted);
	}

	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-1);
	}
</style>
