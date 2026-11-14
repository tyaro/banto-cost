/**
 * Client for the banto-cost personal rates API (個人別単価, design 10.9, T43).
 * Same transport split as calcBasisAdmin.ts: the Tauri webview calls
 * `invoke()` (`person_rates_*`, apps/admin-template/src-tauri/src/lib.rs)
 * and a LAN browser calls `fetch()` against `/api/person-rates*`
 * (apps/admin-template/core/src/rest/person_rates.rs).
 *
 * A person's hourly cost rate for every project (`projectId: null`) or for
 * one project. Time entries are costed with, in order: the person's rate for
 * the project, the person's rate, the project's override, the company
 * standard (計算基準). Rows are append-only: a change is a new row with an
 * effective date, and `value: null` ends the person's own rate in that scope.
 * Reading and changing need `finance.rate` + `amount.view` (server-side).
 *
 * Demo mode has no backend: every export rejects like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

/** Mirrors `admin_template_core::person_rates::PersonRateRow`. */
export interface PersonRateRow {
	id: number;
	userId: number;
	projectId: number | null;
	projectCode: string | null;
	projectName: string | null;
	validFrom: string;
	/** Yen per hour; `null` = the person's own rate ends here. */
	value: number | null;
	versionNo: number;
	reason: string;
	createdByName: string | null;
	createdAt: string;
}

export interface ProjectRateView {
	projectId: number;
	projectCode: string;
	projectName: string;
	current: PersonRateRow | null;
	scheduled: PersonRateRow[];
}

export interface PersonView {
	userId: number;
	displayName: string;
	current: PersonRateRow | null;
	scheduled: PersonRateRow[];
	projects: ProjectRateView[];
	history: PersonRateRow[];
}

export interface PersonRates {
	on: string;
	people: PersonView[];
}

/** A new row. `projectId: null` = every project; `value: null` ends the rate. */
export interface PersonRateInput {
	userId: number;
	projectId: number | null;
	validFrom: string;
	value: number | null;
	reason: string;
}

export interface PersonRatePreview {
	before: number | null;
	after: number | null;
	affectedProjects: number;
	pending: number;
	correctionCandidates: number;
	includesClosed: boolean;
}

/** Every account with its rates on `on` (`YYYY-MM-DD`). */
export async function getPersonRates(on: string): Promise<PersonRates> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') return invokeCommand<PersonRates>('person_rates_get', { on });
	return httpRequest<PersonRates>(`/api/person-rates?on=${encodeURIComponent(on)}`, {
		method: 'GET'
	});
}

/** What adding the row would change; saves nothing. */
export async function previewPersonRate(values: PersonRateInput): Promise<PersonRatePreview> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return invokeCommand<PersonRatePreview>('person_rates_preview', { values });
	}
	return httpRequest<PersonRatePreview>('/api/person-rates/preview', {
		method: 'POST',
		body: values
	});
}

/** Add the row. */
export async function addPersonRate(values: PersonRateInput): Promise<PersonRateRow> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return invokeCommand<PersonRateRow>('person_rates_add', { values });
	}
	return httpRequest<PersonRateRow>('/api/person-rates', { method: 'POST', body: values });
}
