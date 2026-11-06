/**
 * Client for the banto-cost pipeline API (案件見込の版, spec §5.4 / design
 * 第2章 for the capability checks). Same split as usersAdmin.ts: the Tauri
 * webview calls `invoke()` (`pipeline_versions_*` / `pipeline_overview`,
 * apps/admin-template/src-tauri/src/lib.rs) and a LAN browser calls
 * `fetch()` against `/api/projects/{id}/pipeline-versions` and
 * `/api/pipeline/overview` (apps/admin-template/core/src/rest/projects.rs),
 * with the same bearer-token / CSRF-header mechanism.
 *
 * Not built on the generic `DataProvider`: versions hang off a project and
 * are append-only (create + adopt, no update/delete), and the overview is an
 * aggregate, not a resource list.
 *
 * Demo mode (no backend, conventions §10): every export rejects with a
 * `ProviderError` carrying `DEMO_MODE_MESSAGE` - there is no in-memory
 * pipeline. `isPipelineAvailable()` lets pages check this up front.
 *
 * Amounts are integer yen and percentages integer points; `null` means
 * 未設定 and must never be shown or summed as 0 (banto-cost CLAUDE.md).
 */
import { invoke } from '@tauri-apps/api/core';
import { getAuthProvider, isProviderError, ProviderError, type ErrorBody } from '@banto/admin-core';
import { CSRF_HEADER, getBantoMode } from './setup';

/** Stages a version can record (the ordered side is reached via order conversion). */
export type VersionStage = 'lead' | 'quoting' | 'negotiating' | 'informal';
export const VERSION_STAGES: readonly VersionStage[] = [
	'lead',
	'quoting',
	'negotiating',
	'informal'
];

/** Issue codes the server attaches to versions / overview rows. */
export type PipelineIssue =
	| 'amount_missing'
	| 'probability_missing'
	| 'order_month_missing'
	| 'plan_missing'
	| 'plan_mismatch'
	| 'no_adopted_version';

/** One revenue-plan line. `month: null` = 時期未定. */
export interface PlanLine {
	month: string | null;
	amount: number;
}

/** Mirrors `admin_template_core::pipeline::PipelineVersion` (camelCase). */
export interface PipelineVersion {
	id: number;
	projectId: number;
	versionNo: number;
	kind: 'draft' | 'adopted';
	stage: VersionStage;
	expectedAmount: number | null;
	probabilityPct: number | null;
	expectedOrderMonth: string | null;
	expectedStartMonth: string | null;
	expectedEndMonth: string | null;
	estCostAtOrder: number | null;
	basis: string | null;
	nextAction: string | null;
	confirmedOn: string | null;
	createdByName: string | null;
	createdAt: string;
	adoptedByName: string | null;
	adoptedAt: string | null;
	revenuePlan: PlanLine[];
	issues: string[];
}

/** Mirrors `PipelineVersionInput`. `adopt: true` saves straight as the adopted version (basis required). */
export interface PipelineVersionInput {
	stage: VersionStage;
	expectedAmount: number | null;
	probabilityPct: number | null;
	expectedOrderMonth: string | null;
	expectedStartMonth: string | null;
	expectedEndMonth: string | null;
	estCostAtOrder: number | null;
	basis: string | null;
	nextAction: string | null;
	confirmedOn: string | null;
	revenuePlan: PlanLine[];
	adopt: boolean;
}

export interface OverviewRow {
	projectId: number;
	code: string;
	name: string;
	customerName: string;
	status: string;
	stage: string | null;
	versionNo: number | null;
	expectedAmount: number | null;
	probabilityPct: number | null;
	weightedAmount: number | null;
	expectedOrderMonth: string | null;
	confirmedOn: string | null;
	undatedAmount: number | null;
	issues: string[];
}

export interface OverviewTotals {
	activeCount: number;
	total: number;
	weighted: number;
	missingAmount: number[];
	missingProbability: number[];
	excludedCount: number;
	withoutAdoptedVersion: number[];
}

/** `month: null` = 受注予定月 undecided. */
export interface OrderMonthRow {
	month: string | null;
	total: number;
	weighted: number;
}

/** `month: null` = 時期未定. */
export interface RevenueMonthRow {
	month: string | null;
	weighted: number;
}

export interface PipelineOverview {
	rows: OverviewRow[];
	totals: OverviewTotals;
	byOrderMonth: OrderMonthRow[];
	byRevenueMonth: RevenueMonthRow[];
	revenueExcluded: number[];
}

export const DEMO_MODE_MESSAGE = 'デモモードでは利用できません';

/** Shared with ordersAdmin.ts (same transport, same demo-mode refusal). */
export function demoModeError(): ProviderError {
	return new ProviderError({ kind: 'other', message: DEMO_MODE_MESSAGE });
}

/** Is this environment backed by a real database (Tauri or the embedded server)? False in demo mode. */
export function isPipelineAvailable(): boolean {
	return getBantoMode() !== 'demo';
}

const ERROR_KINDS = new Set([
	'not_found',
	'validation',
	'bad_request',
	'unauthorized',
	'forbidden',
	'storage',
	'other'
]);

/** Same type guard as providers/tauri.ts / providers/http.ts (spec §10/§11.1). */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

function toProviderError(err: unknown): ProviderError {
	if (isProviderError(err)) return err;
	if (isErrorBody(err)) return new ProviderError(err);
	const message = err instanceof Error ? err.message : String(err);
	return new ProviderError({ kind: 'other', message });
}

export async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	try {
		return (await invoke(cmd, args)) as T;
	} catch (err) {
		throw toProviderError(err);
	}
}

const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません';

export interface HttpInit {
	method: string;
	body?: unknown;
}

/** Bearer token of the active http `AuthProvider` (same as usersAdmin.ts). */
function currentToken(): string | null {
	const auth = getAuthProvider() as { getToken?: () => string | null };
	return auth.getToken ? auth.getToken() : null;
}

export async function httpRequest<T>(path: string, init: HttpInit): Promise<T> {
	const hasBody = init.body !== undefined;
	const headers: Record<string, string> = { ...CSRF_HEADER };
	if (hasBody) headers['Content-Type'] = 'application/json';
	const token = currentToken();
	if (token) headers.Authorization = `Bearer ${token}`;

	let response: Response;
	try {
		response = await fetch(path, {
			method: init.method,
			headers,
			body: hasBody ? JSON.stringify(init.body) : undefined
		});
	} catch {
		throw new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
	}

	if (!response.ok) {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new ProviderError({
				kind: 'other',
				message: `${response.status} ${response.statusText}`
			});
		}
		if (isErrorBody(body)) throw new ProviderError(body);
		throw new ProviderError({
			kind: 'other',
			message: `${response.status} ${response.statusText}`
		});
	}

	return (await response.json()) as T;
}

/** Versions of one project, newest first. */
export async function listPipelineVersions(projectId: number): Promise<PipelineVersion[]> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return invokeCommand<PipelineVersion[]>('pipeline_versions_list', { projectId });
	}
	return httpRequest<PipelineVersion[]>(`/api/projects/${projectId}/pipeline-versions`, {
		method: 'GET'
	});
}

/** Save a new version (draft, or adopted when `values.adopt`). */
export async function createPipelineVersion(
	projectId: number,
	values: PipelineVersionInput
): Promise<PipelineVersion> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return invokeCommand<PipelineVersion>('pipeline_versions_create', { projectId, values });
	}
	return httpRequest<PipelineVersion>(`/api/projects/${projectId}/pipeline-versions`, {
		method: 'POST',
		body: values
	});
}

/** Adopt an existing draft as the project's current version. */
export async function adoptPipelineVersion(
	projectId: number,
	versionId: number
): Promise<PipelineVersion> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return invokeCommand<PipelineVersion>('pipeline_versions_adopt', { projectId, versionId });
	}
	return httpRequest<PipelineVersion>(
		`/api/projects/${projectId}/pipeline-versions/${versionId}/adopt`,
		{ method: 'POST' }
	);
}

/** The scope-filtered pipeline aggregate (latest adopted version per pre-order project). */
export async function getPipelineOverview(): Promise<PipelineOverview> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') return invokeCommand<PipelineOverview>('pipeline_overview');
	return httpRequest<PipelineOverview>('/api/pipeline/overview', { method: 'GET' });
}
