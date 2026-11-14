/**
 * Client for the banto-cost completion-forecast API (完了見込版, spec §6.6,
 * T06・T28・T30, P5) and the overall list (全体一覧, spec §9). Same
 * transport split as budgetAdmin.ts: the Tauri webview calls `invoke()`
 * (`project_forecast`, `forecast_draft_*`, `portfolio_overview`,
 * apps/admin-template/src-tauri/src/lib.rs) and a LAN browser calls `fetch()`
 * against the twin routes (apps/admin-template/core/src/rest/forecasts.rs).
 *
 * Amounts are integer yen, remaining hours integer minutes, ratios permille.
 * A remaining labor line without a forecast rate has `laborRemaining: null`
 * (未確定) and is never read as 0; a draft's totals are then `null` too.
 *
 * Demo mode has no backend: every export rejects like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';
import type { CostType } from './budgetAdmin';

/** Mirrors `admin_template_core::forecasts::ForecastLine`. */
export interface ForecastLine {
	phaseId: number | null;
	phaseName: string | null;
	costType: CostType;
	actual: number;
	committed: number;
	remainingMinutes: number | null;
	otherRemaining: number | null;
	laborRemaining: number | null;
	remaining: number | null;
	total: number | null;
}

/** One remaining input row (残工数・それ以外の見込み). */
export interface RemainingLine {
	phaseId: number | null;
	phaseName: string | null;
	costType: CostType;
	remainingMinutes: number | null;
	amount: number | null;
}

export interface TypeTotal {
	costType: CostType;
	actual: number;
	committed: number;
	remaining: number | null;
	total: number | null;
}

/** Mirrors `admin_template_core::forecasts::ForecastVersion`. */
export interface ForecastVersion {
	id: number;
	projectId: number;
	versionNo: number | null;
	status: 'draft' | 'adopted';
	baseDate: string;
	plannedEnd: string | null;
	reason: string | null;
	forecastRate: number | null;
	orderAmount: number | null;
	budgetVersionNo: number | null;
	budgetTotal: number | null;
	actualTotal: number;
	committedTotal: number;
	remainingTotal: number | null;
	costTotal: number | null;
	profit: number | null;
	profitRatioPermille: number | null;
	overrun: number | null;
	actualComplete: boolean;
	rateMissing: boolean;
	pendingCount: number;
	provisionalCount: number;
	missingRateCount: number;
	byCostType: TypeTotal[];
	lines: ForecastLine[];
	inputs: RemainingLine[];
	createdByName: string | null;
	updatedBy: number | null;
	updatedByName: string | null;
	adoptedByName: string | null;
	adoptedAt: string | null;
	rowVersion: number;
	updatedAt: string;
}

export interface ForecastComparisonRow {
	costType: CostType;
	originalBudget: number | null;
	currentBudget: number | null;
	previous: number | null;
	latest: number | null;
	draft: number | null;
	latestActual: number;
}

/** Mirrors `admin_template_core::forecasts::ForecastOverview`. */
export interface ForecastOverview {
	projectId: number;
	projectStatus: string;
	orderAmount: number | null;
	pendingAddition: number;
	budgetOriginalTotal: number | null;
	budgetCurrentTotal: number | null;
	budgetCurrentVersionNo: number | null;
	latest: ForecastVersion | null;
	previous: ForecastVersion | null;
	history: ForecastVersion[];
	draft: ForecastVersion | null;
	latestActualTotal: number;
	/** `actual_after_base` | `actual_corrected` | `rate_changed` | `order_changed`. */
	updateReasons: string[];
	currentProfit: number | null;
	currentProfitRatioPermille: number | null;
	currentOverrun: number | null;
	changeFromPrevious: number | null;
	/** 目標粗利率 on the business date (`null` = 未設定, never 0%). */
	targetMarginPct: number | null;
	/** The acceptance date the rate was read on (`null` = not accepted: the business date). */
	targetMarginOn: string | null;
	targetProfit: number | null;
	/** 原資 = confirmed order − 目標粗利 (`null` before the order or with no rate). */
	funds: number | null;
	comparison: ForecastComparisonRow[];
}

export interface ForecastLineInput {
	phaseId: number | null;
	costType: CostType;
	remainingMinutes: number | null;
	amount: number | null;
}

export interface ForecastDraftInput {
	baseDate: string;
	plannedEnd: string | null;
	reason: string | null;
	lines: ForecastLineInput[];
	rowVersion: number;
}

/** Mirrors `admin_template_core::portfolio::PortfolioRow`. */
export interface PortfolioRow {
	projectId: number;
	code: string;
	name: string;
	customerName: string;
	managerName: string;
	status: string;
	amountsVisible: boolean;
	orderAmount: number | null;
	pendingAddition: number | null;
	budgetTotal: number | null;
	budgetVersionNo: number | null;
	actualCost: number | null;
	actualComplete: boolean | null;
	forecastVersionNo: number | null;
	forecastBaseDate: string | null;
	/** `false` = the adopted version was 暫定・不足あり at its base date. */
	forecastActualComplete: boolean | null;
	forecastCost: number | null;
	forecastProfit: number | null;
	forecastRatioPermille: number | null;
	forecastOverrun: number | null;
	targetMarginPct: number | null;
	/** 原資 (`null` before the order or with no 目標粗利率). */
	funds: number | null;
	/** 原資 − the current approved budget (negative = over the funds, T42). */
	fundsLeftAfterBudget: number | null;
	/** 原資 − 完了見込原価 (negative = over the funds, T42). */
	fundsLeftAfterForecast: number | null;
	alerts: string[];
	updateReasons: string[];
}

/**
 * Mirrors `admin_template_core::portfolio::ProjectSummary`: the overall
 * list's row of one project, for the summary at the top of its page.
 */
export interface ProjectSummary extends PortfolioRow {
	/** The business date the alerts were judged on. */
	asOf: string;
}

export interface PortfolioTotals {
	projectCount: number;
	amountCount: number;
	orderedCount: number;
	orderTotal: number;
	forecastCount: number;
	forecastOrderTotal: number;
	forecastCostTotal: number;
	forecastProfitTotal: number;
	forecastRatioPermille: number | null;
	needsUpdate: number[];
	withoutForecast: number[];
	/** Summed forecasts that were 暫定・不足あり at their base date. */
	provisionalForecasts: number[];
	oldestBaseDate: string | null;
	alertCounts: { alert: string; count: number }[];
}

/** Mirrors `admin_template_core::portfolio::Portfolio`. */
export interface Portfolio {
	asOf: string;
	reviewDelayDays: number | null;
	lowMarginPct: number | null;
	rows: PortfolioRow[];
	totals: PortfolioTotals;
	/** Approved direct-cost records left out of the ledger for review (T39). */
	ledgerProblems: LedgerProblem[];
}

/** Mirrors `admin_template_core::direct_costs::LedgerProblem`. */
export interface LedgerProblem {
	/** `direct_cost` | `fixed_cost`. */
	source: string;
	id: number;
	projectIds: number[];
	/** `unreadable` | a `LedgerIssue` code | `related`. */
	code: string;
	/** The unreadable column when `code` is `unreadable`. */
	column: string | null;
}

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/** The project's forecast versions, draft and comparison (`ViewProjectAmounts`). */
export async function getProjectForecast(projectId: number): Promise<ForecastOverview> {
	guard();
	if (tauri()) return invokeCommand<ForecastOverview>('project_forecast', { projectId });
	return httpRequest<ForecastOverview>(`/api/projects/${projectId}/forecast`, { method: 'GET' });
}

/** The project's row of the overall list, amounts and alerts included (`ViewProjectAmounts`). */
export async function getProjectSummary(projectId: number): Promise<ProjectSummary> {
	guard();
	if (tauri()) return invokeCommand<ProjectSummary>('project_summary', { projectId });
	return httpRequest<ProjectSummary>(`/api/projects/${projectId}/summary`, { method: 'GET' });
}

/** Start a draft (today's base date, the last remaining input), or get the existing one. */
export async function createForecastDraft(
	projectId: number
): Promise<{ draft: ForecastVersion; replayed: boolean }> {
	guard();
	if (tauri()) return invokeCommand('forecast_draft_create', { projectId });
	return httpRequest(`/api/projects/${projectId}/forecast/draft`, { method: 'POST', body: {} });
}

export async function saveForecastDraft(
	id: number,
	values: ForecastDraftInput
): Promise<ForecastVersion> {
	guard();
	if (tauri()) return invokeCommand<ForecastVersion>('forecast_draft_update', { id, values });
	return httpRequest<ForecastVersion>(`/api/forecast-versions/${id}`, {
		method: 'PUT',
		body: values
	});
}

export async function deleteForecastDraft(id: number, rowVersion: number): Promise<void> {
	guard();
	if (tauri()) return invokeCommand<void>('forecast_draft_delete', { id, rowVersion });
	return httpRequest<void>(`/api/forecast-versions/${id}?rowVersion=${rowVersion}`, {
		method: 'DELETE'
	});
}

export async function adoptForecastDraft(id: number, rowVersion: number): Promise<ForecastVersion> {
	guard();
	if (tauri()) {
		return invokeCommand<ForecastVersion>('forecast_draft_adopt', { id, values: { rowVersion } });
	}
	return httpRequest<ForecastVersion>(`/api/forecast-versions/${id}/adopt`, {
		method: 'POST',
		body: { rowVersion }
	});
}

/** The overall list (rows the caller may view; amounts and alerts where allowed). */
export async function getPortfolio(): Promise<Portfolio> {
	guard();
	if (tauri()) return invokeCommand<Portfolio>('portfolio_overview', {});
	return httpRequest<Portfolio>('/api/portfolio', { method: 'GET' });
}
