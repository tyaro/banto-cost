<script lang="ts">
	/**
	 * 案件台帳一覧 (banto-cost P3a, spec §5.1; docs/recipes/add-resource.md
	 * step 8). The server already narrows the list to the caller's project
	 * scope (admin: all, others: the projects they may view - design 第2章),
	 * so this page only renders what comes back. Columns derive from
	 * `projectsSchema` (M23); the customer / manager names and the update time
	 * are joined columns outside the form schema, written by hand.
	 *
	 * 全体一覧 (banto-cost P5, spec §9): the overall list adds, per project, the
	 * confirmed order, the current approved budget, the latest actual cost, the
	 * latest adopted completion forecast (its cost, profit, ratio and base
	 * date) and the alerts (注意表示) from `GET /api/portfolio`. The server
	 * sends amounts and alerts only for the projects whose amounts the caller
	 * may see (`amount_projects`); the others show "—". Each forecast keeps its
	 * own base date; the summary counts the ones that need an update instead of
	 * adding new actuals to old remaining costs (spec §7.5).
	 *
	 * CSV (banto-cost P6c, spec §9, T12・T15): the overall list and a fiscal
	 * period's figures by project and month. The server builds both with the
	 * same scopes as the screens (amounts only where visible), the output
	 * time and the conditions, formulas neutralized.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		BantoGrid,
		ColumnsMenu,
		GridState,
		columnsFromSchema,
		type GridColumn
	} from '@banto/grid-svelte';
	import type { FormSchema } from '@banto/forms';
	import { createListResource, getResource, isProviderError, notify } from '@banto/admin-core';
	import { Plus } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { gridMessages } from '#lib/banto/i18n.js';
	import { formatYen, isForbiddenError } from '#lib/banto/costFormat.js';
	import { getPortfolio, type Portfolio, type PortfolioRow } from '#lib/banto/forecastAdmin.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { businessCalendar, currentPeriod } from '#lib/banto/businessCalendar.svelte.js';
	import {
		exportPeriodMonthly,
		exportPortfolio,
		saveCsv,
		type CsvExport
	} from '#lib/banto/reportsAdmin.js';
	import {
		alertLabel,
		formatPermille,
		isSevereAlert,
		ledgerReasonLabel,
		ledgerRecordLabel
	} from '#lib/banto/forecastFormat.js';
	import type { Project } from '#lib/banto/resources/projects.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';

	const resource = getResource('projects');
	const schema = resource.schema as FormSchema;
	const canWrite = $derived(canWriteResources(sessionStore.role));

	const list = createListResource<Project>('projects', {
		initialParams: { pagination: { offset: 0, limit: 5_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	// The overall list's amounts and alerts (P5). Demo mode has no backend,
	// and a failed read leaves the ledger columns usable ("—").
	let portfolio = $state<Portfolio | null>(null);
	let portfolioError = $state(false);
	async function loadPortfolio() {
		if (!isPipelineAvailable()) return;
		try {
			portfolio = await getPortfolio();
			portfolioError = false;
		} catch {
			portfolio = null;
			portfolioError = true;
		}
	}
	$effect(() => {
		void loadPortfolio();
	});

	type Row = Project & { pf: PortfolioRow | null };
	const rows = $derived.by<Row[]>(() => {
		const byId = new Map((portfolio?.rows ?? []).map((r) => [r.projectId, r]));
		return list.rows.map((p) => ({ ...p, pf: byId.get(p.id) ?? null }));
	});

	const money = (v: unknown) => (typeof v === 'number' ? formatYen(v) : '—');
	const numeric = (a: unknown, b: unknown) =>
		(typeof a === 'number' ? a : -Infinity) - (typeof b === 'number' ? b : -Infinity);
	/**
	 * A figure built on incomplete records is marked, never shown as final: the
	 * actual cost while approved hours lack a rate or records are unapproved or
	 * provisional (`actualComplete`), a forecast adopted as 暫定・不足あり
	 * (`forecastActualComplete`).
	 */
	const actualMark = (row: Row) =>
		row.pf?.actualComplete === false ? m['forecast.provisionalShort']() : '';
	const forecastMark = (row: Row) =>
		row.pf?.forecastActualComplete === false ? m['forecast.provisionalShort']() : '';
	/** A project's code for the ledger review list (its id if not listed). */
	function projectCode(id: number): string {
		return list.rows.find((p) => p.id === id)?.code ?? `#${id}`;
	}

	function amountColumn(
		id: string,
		header: string,
		pick: (r: PortfolioRow) => number | null,
		mark?: (row: Row) => string
	): GridColumn<Row> {
		return {
			id,
			header,
			accessor: (row) => (row.pf ? pick(row.pf) : null),
			width: mark ? 170 : 140,
			align: 'right',
			format: (v, row) => (mark && typeof v === 'number' ? `${money(v)}${mark(row)}` : money(v)),
			comparator: numeric
		};
	}

	// The ids are shown through the joined name columns below; the note is
	// long free text that belongs on the detail page.
	const OMITTED = new Set(['customerId', 'managerUserId', 'note']);
	const schemaColumns = columnsFromSchema<Row>(schema, {
		editable: false,
		overrides: {
			code: { width: 130 },
			name: { width: 260 },
			status: { width: 110 },
			plannedStart: { width: 130, hidden: true },
			plannedEnd: { width: 130, hidden: true },
			orderNo: { width: 130, hidden: true },
			department: { width: 140, hidden: true }
		}
	}).filter((column) => !OMITTED.has(column.id));

	const byId = (id: string) => schemaColumns.filter((column) => column.id === id);

	const columns: GridColumn<Row>[] = [
		{
			id: 'open',
			header: m['cost.colActions'](),
			accessor: () => '',
			width: 70,
			resizable: false,
			sortable: false,
			cell: (row) => ({ text: m['cost.open'](), href: resolve(`projects/${row.id}`) })
		},
		...byId('code'),
		...byId('name'),
		{
			id: 'customerName',
			header: m['projects.fieldCustomer'](),
			accessor: 'customerName',
			width: 200,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'managerName',
			header: m['projects.fieldManager'](),
			accessor: 'managerName',
			width: 140,
			filterable: true,
			filterType: 'text'
		},
		...schemaColumns.filter((column) => !['code', 'name'].includes(column.id)),
		amountColumn('orderAmount', m['portfolio.colOrder'](), (r) => r.orderAmount),
		amountColumn('budgetTotal', m['portfolio.colBudget'](), (r) => r.budgetTotal),
		{
			id: 'funds',
			header: m['portfolio.colFunds'](),
			accessor: (row) => row.pf?.funds ?? null,
			width: 140,
			align: 'right',
			// An ordered project with no 目標粗利率 shows 未設定, never a 0% funds.
			format: (v, row) =>
				row.pf?.orderAmount != null && row.pf.targetMarginPct === null
					? m['cost.unset']()
					: money(v),
			comparator: numeric
		},
		amountColumn('actualCost', m['portfolio.colActual'](), (r) => r.actualCost, actualMark),
		amountColumn(
			'forecastCost',
			m['portfolio.colForecastCost'](),
			(r) => r.forecastCost,
			forecastMark
		),
		amountColumn(
			'forecastProfit',
			m['portfolio.colForecastProfit'](),
			(r) => r.forecastProfit,
			forecastMark
		),
		{
			id: 'forecastRatio',
			header: m['portfolio.colForecastRatio'](),
			accessor: (row) => row.pf?.forecastRatioPermille ?? null,
			width: 110,
			align: 'right',
			format: (v, row) => (row.pf?.forecastCost == null ? '—' : formatPermille(v as number | null)),
			comparator: numeric
		},
		{
			id: 'forecastBaseDate',
			header: m['portfolio.colBaseDate'](),
			accessor: (row) => row.pf?.forecastBaseDate ?? '',
			width: 120,
			format: (v) => (v ? String(v) : '—')
		},
		{
			id: 'alerts',
			header: m['portfolio.colAlerts'](),
			accessor: (row) => (row.pf?.alerts ?? []).map(alertLabel).join('・'),
			width: 280,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'updatedAt',
			header: m['projects.fieldUpdatedAt'](),
			accessor: 'updatedAt',
			width: 170
		}
	];

	// The ledger has many columns: the column chooser (ColumnsMenu) hides the
	// ones not needed right now. Page-local state, not saved.
	const gridState = new GridState<Row>(columns);

	const forbidden = $derived(isForbiddenError(list.error));

	// CSV (P6c). The period defaults to the current one (6月開始), from the
	// server's calendar (P8d); the choices show each period's months.
	let period = $state(String(currentPeriod() ?? ''));
	const periodChoices = $derived(businessCalendar()?.periods ?? []);
	// The calendar can arrive after the page opened (the layout waits only so
	// long): fill in the current period then, unless one was already chosen.
	$effect(() => {
		if (businessCalendar() && period === '') period = String(currentPeriod() ?? '');
	});
	let exporting = $state(false);
	async function runExport(make: () => Promise<CsvExport>) {
		exporting = true;
		try {
			const csv = await make();
			saveCsv(csv);
			notify('success', m['reports.exported']({ count: csv.rowCount }));
		} catch (err) {
			notify('error', isProviderError(err) ? err.message : String(err));
		} finally {
			exporting = false;
		}
	}
	function exportPeriod() {
		const n = Number(period);
		if (!Number.isInteger(n) || n < 1 || n > 999) {
			notify('error', m['reports.invalidPeriod']());
			return;
		}
		void runExport(() => exportPeriodMonthly(n));
	}
</script>

<div class="page">
	<PageHeader hideTitle title={resource.label} description={m['projects.description']()}>
		{#snippet actions()}
			<ColumnsMenu state={gridState} messages={gridMessages()} />
			{#if canWrite}
				<button
					type="button"
					class="banto-btn banto-btn--primary"
					onclick={() => goto(resolve(`projects/new`))}
				>
					<Plus size={16} aria-hidden="true" />
					{m['projects.create']()}
				</button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if forbidden}
		<EmptyState title={m['cost.forbiddenTitle']()} description={m['cost.forbiddenDesc']()} />
	{:else if list.error}
		<ErrorState title={m['cost.loadError']()} description={list.error.message}>
			{#snippet action()}
				<button
					type="button"
					class="banto-btn banto-btn--secondary"
					onclick={() => void list.load()}
				>
					{m['common.reload']()}
				</button>
			{/snippet}
		</ErrorState>
	{:else if list.loading && list.rows.length === 0}
		<LoadingState label={m['common.loading']()} />
	{:else if list.rows.length === 0}
		<EmptyState title={m['projects.emptyTitle']()} description={m['projects.emptyDesc']()} />
	{:else}
		{#if portfolio && portfolio.totals.amountCount > 0}
			{@const t = portfolio.totals}
			<section class="summary" aria-label={m['portfolio.summaryTitle']()}>
				<dl>
					<div>
						<dt>{m['portfolio.ordered']()}</dt>
						<dd>{m['portfolio.count']({ count: t.orderedCount })} · {formatYen(t.orderTotal)}</dd>
					</div>
					<div>
						<dt>{m['portfolio.forecastProfitTotal']({ count: t.forecastCount })}</dt>
						<dd>
							{formatYen(t.forecastProfitTotal)} ({formatPermille(t.forecastRatioPermille)})
							{#if t.provisionalForecasts.length > 0}
								<span class="warn"
									>{m['portfolio.provisionalForecasts']({
										count: t.provisionalForecasts.length
									})}</span
								>
							{/if}
						</dd>
					</div>
					<div>
						<dt>{m['portfolio.needsUpdate']()}</dt>
						<dd>{m['portfolio.count']({ count: t.needsUpdate.length })}</dd>
					</div>
					<div>
						<dt>{m['portfolio.withoutForecast']()}</dt>
						<dd>{m['portfolio.count']({ count: t.withoutForecast.length })}</dd>
					</div>
				</dl>
				{#if t.alertCounts.length > 0}
					<ul class="alerts">
						{#each t.alertCounts as a (a.alert)}
							<li class:severe={isSevereAlert(a.alert)}>{alertLabel(a.alert)} {a.count}</li>
						{/each}
					</ul>
				{/if}
				<p class="note">
					{m['portfolio.note']({
						date: portfolio.asOf,
						oldest: t.oldestBaseDate ?? '—'
					})}
					{#if portfolio.reviewDelayDays === null || portfolio.lowMarginPct === null}
						{m['portfolio.thresholdUnset']()}
					{/if}
				</p>
			</section>
		{:else if portfolioError}
			<p class="note">{m['portfolio.loadError']()}</p>
		{/if}
		{#if portfolio && portfolio.ledgerProblems.length > 0}
			<section
				class="ledger-review"
				role="alert"
				aria-labelledby="ledger-review-title"
				data-testid="ledger-review"
			>
				<h2 id="ledger-review-title">{m['portfolio.ledgerReviewTitle']()}</h2>
				<p class="note">{m['portfolio.ledgerReviewNote']()}</p>
				<ul>
					{#each portfolio.ledgerProblems as p (`${p.source}-${p.id}`)}
						<li>
							{ledgerRecordLabel(p)}: {ledgerReasonLabel(p)}
							{#if p.projectIds.length > 0}
								<span class="note"
									>{m['portfolio.ledgerProblemProjects']({
										codes: p.projectIds.map(projectCode).join(', ')
									})}</span
								>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if isPipelineAvailable()}
			<section class="exports" aria-label={m['reports.title']()}>
				<button
					type="button"
					class="banto-btn banto-btn--secondary"
					disabled={exporting}
					onclick={() => void runExport(exportPortfolio)}
				>
					{m['reports.portfolioCsv']()}
				</button>
				<label class="period">
					<span>{m['reports.period']()}</span>
					{#if periodChoices.length > 0}
						<select class="banto-input" bind:value={period}>
							{#each periodChoices as choice (choice.period)}
								<option value={String(choice.period)}>{choice.label}</option>
							{/each}
						</select>
					{:else}
						<input class="banto-input" type="number" min="1" max="999" bind:value={period} />
					{/if}
				</label>
				<button
					type="button"
					class="banto-btn banto-btn--secondary"
					disabled={exporting}
					onclick={exportPeriod}
				>
					{m['reports.periodCsv']()}
				</button>
				<p class="note">{m['reports.description']()}</p>
			</section>
		{/if}
		<div class="grid-wrap">
			<BantoGrid
				{rows}
				{columns}
				state={gridState}
				messages={gridMessages()}
				getRowId={(row) => row.id}
			/>
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.summary {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		padding: var(--banto-space-3);
	}

	.summary dl {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-4);
		margin: 0;
	}

	.summary dt,
	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.summary dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}

	.warn {
		color: var(--banto-warning-tint-text);
		font-size: var(--banto-font-size-sm);
	}

	.alerts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--banto-font-size-sm);
	}

	.alerts li {
		padding: 0 var(--banto-space-2);
		border-radius: var(--banto-radius-sm);
		background: var(--banto-warning-tint);
		color: var(--banto-warning-tint-text);
	}

	/* The danger pair (tint + its text), not --banto-danger on the warning
	   tint: that mix stays under 4.5:1 (axe color-contrast, P8g). */
	.alerts li.severe {
		background: var(--banto-danger-tint);
		color: var(--banto-danger-tint-text);
	}

	.ledger-review {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-danger);
		border-radius: var(--banto-radius-lg);
		background: var(--banto-danger-tint);
		color: var(--banto-danger-tint-text);
		padding: var(--banto-space-3);
	}

	.ledger-review h2 {
		margin: 0;
		font-size: var(--banto-font-size-base);
	}

	.ledger-review .note {
		color: inherit;
	}

	.ledger-review ul {
		margin: 0;
		padding-left: var(--banto-space-4);
	}

	/* BantoGrid virtualizes, so it needs a definite height (component shape). */
	.exports {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.exports .note {
		flex-basis: 100%;
	}

	.period {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
	}

	.period input {
		width: 5rem;
	}

	.grid-wrap {
		height: 70vh;
		min-height: 320px;
	}
</style>
