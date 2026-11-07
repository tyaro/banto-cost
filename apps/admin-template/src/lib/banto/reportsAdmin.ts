/**
 * Client for the banto-cost monthly figures and CSV exports (月別収支と CSV,
 * spec §9, T12・T15, P6c). Same transport split as closingAdmin.ts: the Tauri
 * webview calls `invoke()` (`project_monthly`, `project_monthly_csv`,
 * `portfolio_csv`, `period_monthly_csv`, apps/admin-template/src-tauri/src/lib.rs)
 * and a LAN browser calls `fetch()` against the twin routes
 * (apps/admin-template/core/src/rest/reports.rs).
 *
 * The server builds every CSV (the same permissions as the screens, the
 * conditions and the output time in the first lines, formulas neutralized);
 * this module only saves the returned text as a file.
 *
 * Amounts are integer yen, ratios permille. Demo mode has no backend: every
 * export rejects like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

/** Mirrors `admin_template_core::reports::AmountsView`. */
export interface MonthlyAmounts {
	revenue: number;
	labor: number;
	/** Approved hours without a rate (原価未確定). */
	laborMissing: number;
	direct: number;
	cost: number;
	profit: number;
	/** `null` = 算出不可 (no revenue). */
	ratioPermille: number | null;
}

export interface MonthLine {
	/** `YYYY-MM`. */
	month: string;
	period: number;
	amounts: MonthlyAmounts;
	/** 当期累計. */
	periodToDate: MonthlyAmounts;
	/** 案件累計. */
	cumulative: MonthlyAmounts;
}

export interface PeriodTotal {
	period: number;
	label: string;
	first: string;
	last: string;
	amounts: MonthlyAmounts;
}

/** Mirrors `admin_template_core::reports::ProjectMonthly`. */
export interface ProjectMonthly {
	projectId: number;
	lines: MonthLine[];
	periods: PeriodTotal[];
	total: MonthlyAmounts;
	spansPeriods: boolean;
	basis: string;
}

/** Mirrors `admin_template_core::reports::CsvExport`. */
export interface CsvExport {
	fileName: string;
	content: string;
	rowCount: number;
}

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/** 案件の月別収支 (`ViewProjectAmounts`). */
export async function getProjectMonthly(projectId: number): Promise<ProjectMonthly> {
	guard();
	if (tauri()) return invokeCommand<ProjectMonthly>('project_monthly', { projectId });
	return httpRequest<ProjectMonthly>(`/api/projects/${projectId}/monthly`, { method: 'GET' });
}

/** 案件の月別収支の CSV. */
export async function exportProjectMonthly(projectId: number): Promise<CsvExport> {
	guard();
	if (tauri()) return invokeCommand<CsvExport>('project_monthly_csv', { projectId });
	return httpRequest<CsvExport>(`/api/projects/${projectId}/monthly.csv`, { method: 'GET' });
}

/** 全体一覧の CSV (rows as the list, amounts only where visible). */
export async function exportPortfolio(): Promise<CsvExport> {
	guard();
	if (tauri()) return invokeCommand<CsvExport>('portfolio_csv', {});
	return httpRequest<CsvExport>('/api/reports/portfolio.csv', { method: 'GET' });
}

/** 期の月別収支（案件×月）の CSV. */
export async function exportPeriodMonthly(period: number): Promise<CsvExport> {
	guard();
	if (tauri()) return invokeCommand<CsvExport>('period_monthly_csv', { period });
	return httpRequest<CsvExport>(`/api/reports/period-monthly.csv?period=${period}`, {
		method: 'GET'
	});
}

/** Save the CSV through a temporary object URL (the browser's download). */
export function saveCsv(csv: CsvExport): void {
	const blob = new Blob([csv.content], { type: 'text/csv;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement('a');
		a.href = url;
		a.download = csv.fileName;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * The fiscal period of a date (6月開始、第13期 = 2026年6月〜2027年5月, design
 * 10.1), as `cost_domain::FiscalCalendar::COMPANY_DEFAULT`.
 */
export function periodOf(date: Date): number {
	const y = date.getFullYear();
	const startYear = date.getMonth() + 1 >= 6 ? y : y - 1;
	return 13 + (startYear - 2026);
}
