/**
 * Pure helpers for the dashboard's 案件と売上の要約 (banto-cost, 2026-11).
 * The figures themselves come from the server (pipeline overview / monthly
 * outlook); this module only picks months and counts projects, so the page
 * stays a thin view and the rules are unit-tested here.
 */
import type { PipelineOverview } from './pipelineAdmin';
import type { OutlookView } from './ordersAdmin';

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
