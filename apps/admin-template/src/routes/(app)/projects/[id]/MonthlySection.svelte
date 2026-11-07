<script lang="ts">
	/**
	 * 案件詳細 → 月別収支 (spec §9, design 10.1, T15, banto-cost P6c): the
	 * project's revenue, labor and direct costs by month of the business
	 * date, a subtotal per fiscal period (6月開始) and the period-to-date and
	 * cumulative profit, so a project across two periods reads month by month
	 * and in total. The months follow the monthly close's basis and add up to
	 * the subtotals and the cumulative (the server's `cost_domain::report`).
	 *
	 * Reading and the CSV need `ViewProjectAmounts`; a `forbidden` read hides
	 * the section. The CSV is built by the server (conditions, output time,
	 * formulas neutralized) and saved here. The table re-reads on the change
	 * events of revenue (`projects`), direct costs and hours.
	 */
	import { isProviderError, notify, onInvalidate } from '@banto/admin-core';
	import { LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { formatSignedYen, formatYen, isForbiddenError } from '#lib/banto/costFormat.js';
	import { formatPermille } from '#lib/banto/forecastFormat.js';
	import {
		exportProjectMonthly,
		getProjectMonthly,
		saveCsv,
		type MonthLine,
		type PeriodTotal,
		type ProjectMonthly
	} from '#lib/banto/reportsAdmin.js';

	interface Props {
		projectId: number;
	}

	let { projectId }: Props = $props();

	const available = isPipelineAvailable();
	let data = $state<ProjectMonthly | null>(null);
	let forbidden = $state(false);
	let loadError = $state<string | null>(null);
	let loadToken = 0;
	let exporting = $state(false);

	async function load(id: number) {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const next = await getProjectMonthly(id);
			if (token !== loadToken) return;
			data = next;
			forbidden = false;
		} catch (err) {
			if (token !== loadToken) return;
			if (isForbiddenError(err)) forbidden = true;
			else loadError = isProviderError(err) ? err.message : String(err);
		}
	}

	$effect(() => {
		void load(projectId);
	});

	// Revenue (orders emit `projects`), direct costs and hours recorded or
	// cancelled elsewhere on the page or by someone else change the figures:
	// re-read on the server's change events so the table matches the CSV.
	$effect(() => {
		const id = projectId;
		const offs = ['projects', 'direct_costs', 'time_entries'].map((resource) =>
			onInvalidate(resource, () => void load(id))
		);
		return () => offs.forEach((off) => off());
	});

	async function exportCsv() {
		exporting = true;
		try {
			const csv = await exportProjectMonthly(projectId);
			saveCsv(csv);
			notify('success', m['monthly.exported']({ count: csv.rowCount }));
		} catch (err) {
			notify('error', isProviderError(err) ? err.message : String(err));
		} finally {
			exporting = false;
		}
	}

	/** ¥150,000 / -¥150,000 (a return can make a month negative). */
	function yen(value: number): string {
		return value < 0 ? formatSignedYen(value) : formatYen(value);
	}

	function monthLabel(month: string): string {
		const [year, mo] = month.split('-');
		return m['monthly.monthLabel']({ year, month: String(Number(mo)) });
	}

	/** The months grouped by period, each followed by its subtotal. */
	const groups = $derived.by(() => {
		if (!data) return [] as { period: PeriodTotal; lines: MonthLine[] }[];
		return data.periods.map((period) => ({
			period,
			lines: data!.lines.filter((l) => l.period === period.period)
		}));
	});
</script>

{#if available && !forbidden}
	<section class="panel" aria-labelledby="monthly-heading">
		<div class="head">
			<h2 id="monthly-heading">{m['monthly.sectionTitle']()}</h2>
			{#if data && data.lines.length > 0}
				<button
					type="button"
					class="banto-btn banto-btn--secondary"
					disabled={exporting}
					onclick={() => void exportCsv()}
				>
					{m['monthly.exportCsv']()}
				</button>
			{/if}
		</div>
		{#if loadError}
			<p class="error" role="alert">{loadError}</p>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => void load(projectId)}
			>
				{m['common.reload']()}
			</button>
		{:else if !data}
			<LoadingState label={m['common.loading']()} />
		{:else if data.lines.length === 0}
			<p class="note">{m['monthly.empty']()}</p>
		{:else}
			<p class="note">{m['monthly.basis']()}</p>
			{#if data.spansPeriods}
				<p class="note">{m['monthly.spansPeriods']({ count: data.periods.length })}</p>
			{/if}
			{#if data.total.laborMissing > 0}
				<p class="warn">{m['monthly.missingRate']({ count: data.total.laborMissing })}</p>
			{/if}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">{m['monthly.colMonth']()}</th>
							<th scope="col" class="num">{m['monthly.colRevenue']()}</th>
							<th scope="col" class="num">{m['monthly.colLabor']()}</th>
							<th scope="col" class="num">{m['monthly.colDirect']()}</th>
							<th scope="col" class="num">{m['monthly.colCost']()}</th>
							<th scope="col" class="num">{m['monthly.colProfit']()}</th>
							<th scope="col" class="num">{m['monthly.colRatio']()}</th>
							<th scope="col" class="num">{m['monthly.colPeriodProfit']()}</th>
							<th scope="col" class="num">{m['monthly.colCumulativeProfit']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each groups as group (group.period.period)}
							{#each group.lines as line (line.month)}
								<tr>
									<td>{monthLabel(line.month)}</td>
									<td class="num">{yen(line.amounts.revenue)}</td>
									<td class="num">{yen(line.amounts.labor)}</td>
									<td class="num">{yen(line.amounts.direct)}</td>
									<td class="num">{yen(line.amounts.cost)}</td>
									<td class="num">{yen(line.amounts.profit)}</td>
									<td class="num">{formatPermille(line.amounts.ratioPermille)}</td>
									<td class="num">{yen(line.periodToDate.profit)}</td>
									<td class="num">{yen(line.cumulative.profit)}</td>
								</tr>
							{/each}
							<tr class="subtotal">
								<th scope="row">{m['monthly.periodTotal']({ label: group.period.label })}</th>
								<td class="num">{yen(group.period.amounts.revenue)}</td>
								<td class="num">{yen(group.period.amounts.labor)}</td>
								<td class="num">{yen(group.period.amounts.direct)}</td>
								<td class="num">{yen(group.period.amounts.cost)}</td>
								<td class="num">{yen(group.period.amounts.profit)}</td>
								<td class="num">{formatPermille(group.period.amounts.ratioPermille)}</td>
								<td></td>
								<td></td>
							</tr>
						{/each}
						<tr class="total">
							<th scope="row">{m['monthly.total']()}</th>
							<td class="num">{yen(data.total.revenue)}</td>
							<td class="num">{yen(data.total.labor)}</td>
							<td class="num">{yen(data.total.direct)}</td>
							<td class="num">{yen(data.total.cost)}</td>
							<td class="num">{yen(data.total.profit)}</td>
							<td class="num">{formatPermille(data.total.ratioPermille)}</td>
							<td></td>
							<td></td>
						</tr>
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/if}

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: min(var(--banto-space-5), 3%);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--banto-space-3);
		flex-wrap: wrap;
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-lg);
	}

	.note,
	.warn {
		margin: 0;
		font-size: var(--banto-font-size-sm);
	}

	.note {
		color: var(--banto-text-muted);
	}

	.warn {
		color: var(--banto-warning-tint-text);
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

	.subtotal th,
	.subtotal td {
		background: var(--banto-surface-subtle);
		font-weight: 600;
	}

	.total th,
	.total td {
		font-weight: 700;
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
	}
</style>
