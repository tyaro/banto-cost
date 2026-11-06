/**
 * Client for the banto-cost calc basis API (計算基準, design 第10章, P4a).
 * Same transport split as pipelineAdmin.ts: the Tauri webview calls
 * `invoke()` (`calc_basis_*` / `project_calc_basis_*`,
 * apps/admin-template/src-tauri/src/lib.rs) and a LAN browser calls
 * `fetch()` against `/api/calc-basis*` and `/api/projects/{id}/calc-basis*`
 * (apps/admin-template/core/src/rest/projects.rs).
 *
 * Rows are append-only: a change is a new row with an effective date, and
 * on a project `value: null` means "back to the company basis". Values are
 * integers (yen, minutes, percent points or days, see `CalcItem.unit`);
 * `null` is 未設定 and is never shown as 0 (banto-cost CLAUDE.md).
 *
 * Demo mode has no backend: every export rejects like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

/** Mirrors `admin_template_core::calc_basis::CalcItem`. */
export interface CalcItem {
	key: string;
	itemGroup: string;
	label: string;
	unit: string;
	valueType: 'yen' | 'minutes' | 'percent' | 'days';
	projectOverridable: boolean;
	managersMayOverride: boolean;
	editCapability: string;
	sortOrder: number;
}

export interface CalcValueRow {
	id: number;
	itemKey: string;
	scope: 'company' | 'project';
	projectId: number | null;
	validFrom: string;
	value: number | null;
	versionNo: number;
	reason: string;
	createdByName: string | null;
	createdAt: string;
}

export interface CompanyItemView {
	item: CalcItem;
	current: CalcValueRow | null;
	scheduled: CalcValueRow[];
	overridingProjects: number;
	history: CalcValueRow[];
}

export interface CompanyBasis {
	on: string;
	items: CompanyItemView[];
}

export type AppliedSource = 'company' | 'project' | 'unset';

export interface ProjectItemView {
	item: CalcItem;
	company: CalcValueRow | null;
	appliedValue: number | null;
	source: AppliedSource;
	overrideRow: CalcValueRow | null;
	history: CalcValueRow[];
}

export interface ProjectBasis {
	projectId: number;
	on: string;
	items: ProjectItemView[];
}

/** A new row. On a project `value: null` reverts to the company basis. */
export interface CalcValueInput {
	itemKey: string;
	validFrom: string;
	value: number | null;
	reason: string;
}

export interface ImpactPreview {
	before: number | null;
	after: number | null;
	affectedProjects: number;
	shieldedProjects: { id: number; code: string }[];
	pending: number;
	correctionCandidates: number;
	includesClosed: boolean;
}

function query(on: string): string {
	return `on=${encodeURIComponent(on)}`;
}

/** The company basis on `on` (`YYYY-MM-DD`). */
export async function getCompanyBasis(on: string): Promise<CompanyBasis> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') return invokeCommand<CompanyBasis>('calc_basis_get', { on });
	return httpRequest<CompanyBasis>(`/api/calc-basis?${query(on)}`, { method: 'GET' });
}

/** A project's applied values on `on` and its override history. */
export async function getProjectBasis(projectId: number, on: string): Promise<ProjectBasis> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return invokeCommand<ProjectBasis>('project_calc_basis_get', { projectId, on });
	}
	return httpRequest<ProjectBasis>(`/api/projects/${projectId}/calc-basis?${query(on)}`, {
		method: 'GET'
	});
}

/** What adding the row would change; saves nothing. `projectId: null` = company. */
export async function previewCalcValue(
	projectId: number | null,
	values: CalcValueInput
): Promise<ImpactPreview> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return projectId === null
			? invokeCommand<ImpactPreview>('calc_basis_preview', { values })
			: invokeCommand<ImpactPreview>('project_calc_basis_preview', { projectId, values });
	}
	const path =
		projectId === null
			? '/api/calc-basis/preview'
			: `/api/projects/${projectId}/calc-basis/preview`;
	return httpRequest<ImpactPreview>(path, { method: 'POST', body: values });
}

/** Add the row (company when `projectId` is null). */
export async function addCalcValue(
	projectId: number | null,
	values: CalcValueInput
): Promise<CalcValueRow> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return projectId === null
			? invokeCommand<CalcValueRow>('calc_basis_add', { values })
			: invokeCommand<CalcValueRow>('project_calc_basis_add', { projectId, values });
	}
	const path = projectId === null ? '/api/calc-basis' : `/api/projects/${projectId}/calc-basis`;
	return httpRequest<CalcValueRow>(path, { method: 'POST', body: values });
}
