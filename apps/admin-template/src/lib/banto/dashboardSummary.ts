/**
 * Pure helpers for the dashboard's 案件と売上の要約 (banto-cost, 2026-11).
 * The figures themselves come from the server (pipeline overview / monthly
 * outlook); this module only picks months and counts projects, so the page
 * stays a thin view and the rules are unit-tested here.
 */
import type { PipelineOverview } from './pipelineAdmin';
import type { OutlookView } from './ordersAdmin';
import type { PortfolioTotals } from './forecastAdmin';

/**
 * This month and next month (`YYYY-MM`) of a business date (`YYYY-MM-DD`),
 * crossing the year end.
 */
export function currentAndNextMonth(today: string): { current: string; next: string } {
	const year = Number(today.slice(0, 4));
	const month = Number(today.slice(5, 7));
	const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
	return { current: today.slice(0, 7), next };
}

/**
 * The outlook total (計上済み＋受注済み予定＋確度加重見込) of one month. The
 * server returns only months that have figures, so a month inside the
 * requested range without a row really is 0円 (not 未設定).
 */
export function outlookMonthTotal(view: OutlookView, month: string): number {
	return view.rows.find((row) => row.month === month)?.total ?? 0;
}

/**
 * Projects that need attention: a pre-order project whose adopted version
 * has an issue (未設定の見込額・確度・受注予定月、売上予定の不足・不一致) or
 * no adopted version at all, and a project the outlook lists with a revenue
 * issue or leaves out. Each project is counted once.
 */
export function attentionProjectIds(
	overview: PipelineOverview | null,
	outlook: OutlookView | null
): number[] {
	const ids = new Set<number>();
	if (overview) {
		for (const row of overview.rows) if (row.issues.length > 0) ids.add(row.projectId);
		for (const id of overview.totals.withoutAdoptedVersion) ids.add(id);
	}
	if (outlook) {
		for (const project of outlook.revenueIssues) ids.add(project.projectId);
		for (const project of outlook.excluded) ids.add(project.projectId);
	}
	return [...ids].sort((a, b) => a - b);
}

/**
 * Projects with one alert in the overall list's totals (`alertCounts`,
 * amount-visible rows only). An alert the server did not count is 0 projects:
 * the list judged every visible row, so a missing entry is not 未設定.
 */
export function alertCount(totals: Pick<PortfolioTotals, 'alertCounts'>, alert: string): number {
	return totals.alertCounts.find((entry) => entry.alert === alert)?.count ?? 0;
}

/** The previous month (`YYYY-MM`) of a month, crossing the year start. */
export function previousMonth(month: string): string {
	const year = Number(month.slice(0, 4));
	const value = Number(month.slice(5, 7));
	return value === 1 ? `${year - 1}-12` : `${year}-${String(value - 1).padStart(2, '0')}`;
}

/** One figure the dashboard reads: still loading, read, or failed. */
export type Source<T> =
	{ state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; error: unknown };

/**
 * Several counts shown as one tile (承認待ち = time entries + direct costs +
 * corrections). The total of the lists already read shows even when another
 * is still loading or failed - `missing` says which, so the tile never reads
 * as complete when it is not. With no list read yet, the tile takes the first
 * failure (権限がありません / 取得できません), else it is still loading.
 */
export type CombinedCount =
	| { state: 'loading' }
	| { state: 'error'; error: unknown }
	| { state: 'ok'; total: number; missing: 'none' | 'loading' | 'failed' };

export function combineCounts(sources: readonly Source<number>[]): CombinedCount {
	let total = 0;
	let read = 0;
	let loading = false;
	let failure: { error: unknown } | null = null;
	for (const source of sources) {
		if (source.state === 'ok') {
			total += source.value;
			read += 1;
		} else if (source.state === 'loading') {
			loading = true;
		} else {
			failure ??= { error: source.error };
		}
	}
	if (read === 0)
		return failure && !loading ? { state: 'error', ...failure } : { state: 'loading' };
	return { state: 'ok', total, missing: failure ? 'failed' : loading ? 'loading' : 'none' };
}
