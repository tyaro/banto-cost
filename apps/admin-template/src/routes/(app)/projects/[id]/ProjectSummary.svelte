<script lang="ts" module>
	export interface TocEntry {
		/** The id of the heading to scroll to. */
		id: string;
		label: string;
	}
</script>

<script lang="ts">
	/**
	 * 案件詳細の先頭の利益の要約と節の目次 (review D-1, P8c).
	 *
	 * The figures are the overall list's row of this project
	 * (`GET /api/projects/{id}/summary`, Tauri `project_summary`): the
	 * confirmed order, the current approved budget, the approved actuals, the
	 * latest adopted completion forecast with its profit and ratio, 原資, and
	 * the alerts judged by `cost_domain::alerts` on the server — never a
	 * second copy of those rules here. Unset stays 未設定 / 算出不可, never 0.
	 *
	 * Reading needs `ViewProjectAmounts`; without it (or in demo mode) the
	 * band is left out and only the contents remain. The page bumps
	 * `reloadKey` after any section finishes an action, so the band follows
	 * the sections without being told what changed.
	 *
	 * The contents scroll to the section headings in place instead of
	 * navigating to a `#hash`, so the router and the unsaved-changes guard
	 * never see a navigation.
	 */
	import { isProviderError } from '@banto/admin-core';
	import { LoadingState, StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import {
		formatPct,
		formatSignedYen,
		formatYen,
		isForbiddenError
	} from '#lib/banto/costFormat.js';
	import { getProjectSummary, type ProjectSummary } from '#lib/banto/forecastAdmin.js';
	import {
		alertLabel,
		formatPermille,
		forecastVersionLabel,
		isSevereAlert
	} from '#lib/banto/forecastFormat.js';
	import { isOrderedStatus } from '#lib/banto/resources/projects.js';

	interface Props {
		projectId: number;
		/** Changes whenever a section finished an action: read the summary again. */
		reloadKey: number;
		toc: TocEntry[];
	}

	let { projectId, reloadKey, toc }: Props = $props();

	const available = isPipelineAvailable();
	let summary = $state<ProjectSummary | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;

	async function load(id: number) {
		if (!available) return;
		const token = ++loadToken;
		try {
			const got = await getProjectSummary(id);
			if (token !== loadToken) return;
			summary = got;
			loadError = null;
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			summary = null;
		}
	}

	$effect(() => {
		void reloadKey;
		void load(projectId);
	});

	const ordered = $derived(summary !== null && isOrderedStatus(summary.status));
	const hidden = $derived(!available || isForbiddenError(loadError));

	function money(v: number | null): string {
		return v === null ? '—' : formatYen(v);
	}

	function jump(event: MouseEvent, id: string) {
		const target = document.getElementById(id);
		if (!target) return;
		event.preventDefault();
		if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
		// Clear the sticky top bar of the app shell.
		target.style.scrollMarginTop = 'calc(var(--banto-shell-header-height) + var(--banto-space-4))';
		target.scrollIntoView({ block: 'start' });
		target.focus({ preventScroll: true });
	}
</script>

{#if !hidden}
	<section
		class="summary-band"
		aria-labelledby="project-summary-heading"
		data-testid="project-summary"
	>
		<h2 id="project-summary-heading">{m['projectSummary.title']()}</h2>
		{#if loadError}
			<p class="error" role="alert">
				{isProviderError(loadError) ? loadError.message : String(loadError)}
			</p>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => void load(projectId)}
			>
				{m['common.reload']()}
			</button>
		{:else if !summary}
			<LoadingState label={m['common.loading']()} />
		{:else}
			{#if ordered}
				<div class="figures">
					<div data-figure="order">
						<span class="label">{m['forecast.orderAmount']()}</span>
						<span class="value">{formatYen(summary.orderAmount)}</span>
						{#if summary.pendingAddition}
							<span class="label"
								>{m['projectSummary.pendingAddition']({
									amount: formatSignedYen(summary.pendingAddition)
								})}</span
							>
						{/if}
					</div>
					<div data-figure="budget">
						<span class="label">{m['forecast.currentBudget']()}</span>
						<span class="value">{money(summary.budgetTotal)}</span>
						{#if summary.budgetVersionNo !== null}
							<span class="label"
								>{m['projectSummary.budgetVersion']({ no: summary.budgetVersionNo })}</span
							>
						{:else}
							<span class="label">{m['projectSummary.noBudget']()}</span>
						{/if}
					</div>
					<div data-figure="actual">
						<span class="label">{m['forecast.latestActual']()}</span>
						<span class="value">{money(summary.actualCost)}</span>
						{#if summary.actualComplete === false}
							<span class="label">{m['projectSummary.actualIncomplete']()}</span>
						{/if}
					</div>
					<div data-figure="forecast-cost">
						<span class="label">{m['forecast.costTotal']()}</span>
						<span class="value">{money(summary.forecastCost)}</span>
						{#if summary.forecastVersionNo !== null && summary.forecastBaseDate}
							<span class="label"
								>{forecastVersionLabel(summary.forecastVersionNo)} · {m['forecast.baseDateShort']({
									date: summary.forecastBaseDate
								})}</span
							>
						{:else}
							<span class="label">{m['projectSummary.noForecast']()}</span>
						{/if}
					</div>
					<div data-figure="profit">
						<span class="label">{m['forecast.profit']()}</span>
						<span
							class="value"
							class:over={summary.forecastProfit !== null && summary.forecastProfit < 0}
							>{money(summary.forecastProfit)}</span
						>
						{#if summary.forecastProfit !== null}
							<span class="label"
								>{m['projectSummary.ratio']({
									ratio: formatPermille(summary.forecastRatioPermille)
								})}</span
							>
						{/if}
					</div>
					<div data-figure="funds">
						<span class="label"
							>{summary.targetMarginPct === null
								? m['forecast.fundsLabel']()
								: m['forecast.funds']({ pct: formatPct(summary.targetMarginPct) })}</span
						>
						<span class="value"
							>{summary.targetMarginPct === null ? m['cost.unset']() : money(summary.funds)}</span
						>
					</div>
				</div>
				{#if summary.forecastActualComplete === false}
					<p class="warn">{m['forecast.provisionalVersion']()}</p>
				{/if}
			{:else}
				<p class="note">{m['projectSummary.preOrder']()}</p>
			{/if}
			<div class="alerts" role="status">
				{#if summary.alerts.length === 0}
					<span class="note">{m['projectSummary.noAlerts']({ date: summary.asOf })}</span>
				{:else}
					<span class="note">{m['projectSummary.alertsAsOf']({ date: summary.asOf })}</span>
					<ul>
						{#each summary.alerts as code (code)}
							<li>
								<StatusBadge
									variant={isSevereAlert(code) ? 'danger' : 'warning'}
									label={alertLabel(code)}
								/>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</section>
{/if}

<nav class="toc" aria-labelledby="project-toc-heading">
	<span id="project-toc-heading" class="note">{m['projectSummary.tocLabel']()}</span>
	<ul>
		{#each toc as entry (entry.id)}
			<li><a href={`#${entry.id}`} onclick={(event) => jump(event, entry.id)}>{entry.label}</a></li>
		{/each}
	</ul>
</nav>

<style>
	.summary-band {
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

	.figures {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: var(--banto-space-4);
	}

	.figures div {
		display: flex;
		flex-direction: column;
		min-width: 9rem;
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

	.value.over {
		color: var(--banto-danger);
	}

	.warn {
		margin: 0;
		color: var(--banto-warning-tint-text);
		font-size: var(--banto-font-size-sm);
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
	}

	.alerts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.alerts ul {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.toc {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--banto-space-2) var(--banto-space-3);
	}

	.toc a {
		color: var(--banto-primary-text);
	}

	.toc ul {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-2) var(--banto-space-4);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--banto-font-size-sm);
	}
</style>
