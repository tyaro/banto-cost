/**
 * Client for the banto-cost budget-version API (予算版, spec §5.3, T09, P4c).
 * Same transport split as timeAdmin.ts: the Tauri webview calls `invoke()`
 * (`project_budget`, `budget_draft_*`, apps/admin-template/src-tauri/src/lib.rs)
 * and a LAN browser calls `fetch()` against the twin routes
 * (apps/admin-template/core/src/rest/budgets.rs).
 *
 * Amounts are integer yen, planned hours integer minutes. A labor line
 * without a budget rate has `amount: null` (未確定) and is never read as 0.
 * Actuals are approved hours (labor) and approved direct costs (P4d).
 *
 * Demo mode has no backend: every export rejects like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

export type CostType = 'labor' | 'material' | 'outsource' | 'travel' | 'other';
export const COST_TYPES: readonly CostType[] = [
	'labor',
	'material',
	'outsource',
	'travel',
	'other'
];

/** Mirrors `admin_template_core::budgets::BudgetLine`. */
export interface BudgetLine {
	phaseId: number | null;
	phaseName: string | null;
	costType: CostType;
	plannedMinutes: number | null;
	budgetRate: number | null;
	amount: number | null;
}

/** Mirrors `admin_template_core::budgets::BudgetVersion`. */
export interface BudgetVersion {
	id: number;
	projectId: number;
	versionNo: number | null;
	status: 'draft' | 'approved';
	reason: string | null;
	createdOn: string;
	createdByName: string | null;
	updatedBy: number | null;
	updatedByName: string | null;
	approvedByName: string | null;
	approvedAt: string | null;
	total: number | null;
	rateMissing: boolean;
	lines: BudgetLine[];
	rowVersion: number;
	updatedAt: string;
}

export interface ComparisonRow {
	phaseId: number | null;
	phaseName: string | null;
	costType: CostType;
	original: number | null;
	current: number | null;
	actual: number | null;
	variance: number | null;
}

export interface CostTypeTotal {
	costType: CostType;
	original: number | null;
	current: number | null;
	actual: number | null;
	variance: number | null;
}

/** Mirrors `admin_template_core::budgets::BudgetOverview`. */
export interface BudgetOverview {
	projectId: number;
	projectStatus: string;
	original: BudgetVersion | null;
	current: BudgetVersion | null;
	history: BudgetVersion[];
	draft: BudgetVersion | null;
	comparison: ComparisonRow[];
	totals: CostTypeTotal[];
	laborActualComplete: boolean;
	/** No direct cost pending approval and no provisional left (P4d). */
	directActualComplete: boolean;
}

export interface BudgetLineInput {
	phaseId: number | null;
	costType: CostType;
	plannedMinutes: number | null;
	amount: number | null;
}

export interface BudgetDraftInput {
	reason: string | null;
	lines: BudgetLineInput[];
	rowVersion: number;
}

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/** The project's budget versions, draft and comparison (`ViewProjectAmounts`). */
export async function getProjectBudget(projectId: number): Promise<BudgetOverview> {
	guard();
	if (tauri()) return invokeCommand<BudgetOverview>('project_budget', { projectId });
	return httpRequest<BudgetOverview>(`/api/projects/${projectId}/budget`, { method: 'GET' });
}

/** Start a draft (a copy of the current budget), or get the existing one. */
export async function createBudgetDraft(
	projectId: number
): Promise<{ draft: BudgetVersion; replayed: boolean }> {
	guard();
	if (tauri()) return invokeCommand('budget_draft_create', { projectId });
	return httpRequest(`/api/projects/${projectId}/budget/draft`, { method: 'POST', body: {} });
}

export async function saveBudgetDraft(
	id: number,
	values: BudgetDraftInput
): Promise<BudgetVersion> {
	guard();
	if (tauri()) return invokeCommand<BudgetVersion>('budget_draft_update', { id, values });
	return httpRequest<BudgetVersion>(`/api/budget-versions/${id}`, { method: 'PUT', body: values });
}

export async function deleteBudgetDraft(id: number, rowVersion: number): Promise<void> {
	guard();
	if (tauri()) return invokeCommand<void>('budget_draft_delete', { id, rowVersion });
	return httpRequest<void>(`/api/budget-versions/${id}?rowVersion=${rowVersion}`, {
		method: 'DELETE'
	});
}

export async function approveBudgetDraft(id: number, rowVersion: number): Promise<BudgetVersion> {
	guard();
	if (tauri()) {
		return invokeCommand<BudgetVersion>('budget_draft_approve', { id, values: { rowVersion } });
	}
	return httpRequest<BudgetVersion>(`/api/budget-versions/${id}/approve`, {
		method: 'POST',
		body: { rowVersion }
	});
}
