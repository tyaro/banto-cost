<script lang="ts">
	/**
	 * 案件詳細 → 工数 (spec §6.1 / §7.1, banto-cost P4b): the project's hours
	 * by phase. Only approved hours are actuals; their labor cost is the sum of
	 * the costs fixed at approval. Approved hours without a rate (原価未確定),
	 * submitted ones and drafts are counted apart and never read as 0 yen
	 * (T04) - while any remain, the labor cost is marked provisional.
	 *
	 * Reading needs `ViewProjectAmounts` on the project (aggregates only:
	 * nobody's rate is shown here). A `forbidden` read hides the section
	 * behind a short notice.
	 */
	import { isProviderError } from '@banto/admin-core';
	import { LoadingState, StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { formatYen, isForbiddenError } from '#lib/banto/costFormat.js';
	import { getProjectTimeSummary, type ProjectTimeSummary } from '#lib/banto/timeAdmin.js';
	import { formatMinutes } from '#lib/banto/timeFormat.js';

	interface Props {
		projectId: number;
	}

	let { projectId }: Props = $props();

	const available = isPipelineAvailable();
	let summary = $state<ProjectTimeSummary | null>(null);
	let loadError = $state<unknown>(null);

	async function load() {
		if (!available) return;
		loadError = null;
		try {
			summary = await getProjectTimeSummary(projectId);
		} catch (err) {
			loadError = err;
			summary = null;
		}
	}

	$effect(() => {
		void load();
	});
</script>

<section class="time" aria-labelledby="time-heading">
	<h2 id="time-heading">{m['time.projectSectionTitle']()}</h2>
	{#if !available}
		<p class="note">{m['time.demoUnavailable']()}</p>
	{:else if isForbiddenError(loadError)}
		<p class="note">{m['time.projectForbidden']()}</p>
	{:else if loadError}
		<p class="error" role="alert">
			{isProviderError(loadError) ? loadError.message : String(loadError)}
		</p>
		<button type="button" class="banto-btn banto-btn--secondary" onclick={() => void load()}>
			{m['common.reload']()}
		</button>
	{:else if !summary}
		<LoadingState label={m['common.loading']()} />
	{:else}
		{@const t = summary.total}
		<div class="headline">
			<div>
				<span class="label">{m['time.approvedHours']()}</span>
				<span class="value">{formatMinutes(t.approved.minutes)}</span>
			</div>
			<div>
				<span class="label">{m['time.laborCost']()}</span>
				<span class="value">{formatYen(t.laborCost)}</span>
			</div>
			<StatusBadge
				variant={t.complete ? 'success' : 'warning'}
				label={t.complete ? m['time.complete']() : m['time.provisional']()}
			/>
		</div>
		{#if !t.complete}
			<ul class="gaps">
				{#if t.missingRate.count > 0}
					<li>
						{m['time.gapMissingRate']({
							count: t.missingRate.count,
							minutes: formatMinutes(t.missingRate.minutes)
						})}
					</li>
				{/if}
				{#if t.submitted.count > 0}
					<li>
						{m['time.gapSubmitted']({
							count: t.submitted.count,
							minutes: formatMinutes(t.submitted.minutes)
						})}
					</li>
				{/if}
				{#if t.unsubmitted.count > 0}
					<li>
						{m['time.gapUnsubmitted']({
							count: t.unsubmitted.count,
							minutes: formatMinutes(t.unsubmitted.minutes)
						})}
					</li>
				{/if}
			</ul>
		{/if}
		{#if summary.phases.length === 0}
			<p class="note">{m['time.noEntries']()}</p>
		{:else}
			<div class="table-wrap">
				<table>
					<caption class="sr-only">{m['time.projectSectionTitle']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['time.fieldPhase']()}</th>
							<th scope="col" class="num">{m['time.approvedHours']()}</th>
							<th scope="col" class="num">{m['time.laborCost']()}</th>
							<th scope="col" class="num">{m['time.colMissingRate']()}</th>
							<th scope="col" class="num">{m['time.colPending']()}</th>
							<th scope="col" class="num">{m['time.colRework']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each summary.phases as p (p.phaseId)}
							<tr>
								<td>{p.phaseName ?? ''}</td>
								<td class="num">{formatMinutes(p.summary.approved.minutes)}</td>
								<td class="num">{formatYen(p.summary.laborCost)}</td>
								<td class="num">{formatMinutes(p.summary.missingRate.minutes)}</td>
								<td class="num">
									{formatMinutes(p.summary.submitted.minutes + p.summary.unsubmitted.minutes)}
								</td>
								<td class="num">{formatMinutes(p.reworkMinutes)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</section>

<style>
	.time {
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

	.headline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-4);
	}

	.headline div {
		display: flex;
		flex-direction: column;
	}

	.label,
	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.value {
		font-size: var(--banto-font-size-lg);
		font-variant-numeric: tabular-nums;
	}

	.gaps {
		margin: 0;
		padding-left: var(--banto-space-5);
		color: var(--banto-warning-tint-text);
		font-size: var(--banto-font-size-sm);
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
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
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		text-align: left;
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
