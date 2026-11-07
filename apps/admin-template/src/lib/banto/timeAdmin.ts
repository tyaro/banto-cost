/**
 * Client for the banto-cost time-entry API (工数, spec §6.1, P4b) and the
 * phase / common-activity masters (spec §5.2). Same transport split as
 * pipelineAdmin.ts: the Tauri webview calls `invoke()` (`phases_*`,
 * `common_activities_*`, `time_entries_*`, `project_time_summary`,
 * apps/admin-template/src-tauri/src/lib.rs) and a LAN browser calls
 * `fetch()` against the twin routes (apps/admin-template/core/src/rest/time.rs).
 *
 * Minutes are integers. An entry's `appliedRate` / `laborCost` are `null`
 * unless the caller holds the personal-rate right; `costMissing` (approved
 * without a rate, 原価未確定) is shown to everyone and never read as 0 yen.
 *
 * Demo mode has no backend: every export rejects like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

/** `vendors` = 取引先 (P4d, the vendors of orders and direct costs). */
export type MasterKind = 'phases' | 'activities' | 'vendors';

/** Mirrors `admin_template_core::work_masters::WorkMaster`. */
export interface WorkMaster {
	id: number;
	name: string;
	sortOrder: number;
	active: boolean;
	rowVersion: number;
	updatedAt: string;
}

export interface WorkMasterInput {
	name: string;
	sortOrder: number;
	active: boolean;
	rowVersion?: number;
}

export type TimeStatus = 'draft' | 'submitted' | 'approved' | 'returned';
export type ReworkKind = 'internal' | 'customer' | 'other';

/** Mirrors `admin_template_core::time_entries::TimeEntry`. */
export interface TimeEntry {
	id: number;
	workDate: string;
	userId: number;
	userName: string;
	projectId: number | null;
	projectCode: string | null;
	projectName: string | null;
	activityId: number | null;
	activityName: string | null;
	phaseId: number | null;
	phaseName: string | null;
	minutes: number;
	description: string | null;
	reworkKind: ReworkKind | null;
	status: TimeStatus;
	submittedAt: string | null;
	decidedByName: string | null;
	decidedAt: string | null;
	returnReason: string | null;
	appliedRate: number | null;
	laborCost: number | null;
	costMissing: boolean;
	rowVersion: number;
	updatedAt: string;
}

export interface TimeEntryInput {
	workDate: string;
	projectId: number | null;
	activityId: number | null;
	phaseId: number | null;
	minutes: number;
	description: string | null;
	reworkKind: ReworkKind | null;
	/** Create only: makes a retried send idempotent (T13). */
	clientRequestId?: string;
	/** Update only. */
	rowVersion?: number;
}

export type TimeWarning =
	{ code: 'duplicate'; ids: number[] } | { code: 'day_standard'; total: number; standard: number };

export interface TimeEntrySaved {
	entry: TimeEntry;
	warnings: TimeWarning[];
	replayed: boolean;
}

export interface Tally {
	count: number;
	minutes: number;
}

export interface SummaryView {
	approved: Tally;
	laborCost: number;
	missingRate: Tally;
	submitted: Tally;
	unsubmitted: Tally;
	complete: boolean;
}

export interface ProjectTimeSummary {
	projectId: number;
	total: SummaryView;
	reworkMinutes: number;
	phases: {
		phaseId: number | null;
		phaseName: string | null;
		summary: SummaryView;
		reworkMinutes: number;
	}[];
}

const MASTER_PATH: Record<MasterKind, string> = {
	phases: '/api/phases',
	activities: '/api/common-activities',
	vendors: '/api/vendors'
};
const MASTER_CMD: Record<MasterKind, string> = {
	phases: 'phases',
	activities: 'common_activities',
	vendors: 'vendors'
};

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/** Every row of a master (active and inactive) in display order. */
export async function listMasters(kind: MasterKind): Promise<WorkMaster[]> {
	guard();
	if (tauri()) return invokeCommand<WorkMaster[]>(`${MASTER_CMD[kind]}_list`);
	return httpRequest<WorkMaster[]>(MASTER_PATH[kind], { method: 'GET' });
}

/** Create (`id` null) or update a master row. */
export async function saveMaster(
	kind: MasterKind,
	id: number | null,
	values: WorkMasterInput
): Promise<WorkMaster> {
	guard();
	if (tauri()) {
		return id === null
			? invokeCommand<WorkMaster>(`${MASTER_CMD[kind]}_create`, { values })
			: invokeCommand<WorkMaster>(`${MASTER_CMD[kind]}_update`, { id, values });
	}
	return id === null
		? httpRequest<WorkMaster>(MASTER_PATH[kind], { method: 'POST', body: values })
		: httpRequest<WorkMaster>(`${MASTER_PATH[kind]}/${id}`, { method: 'PUT', body: values });
}

/** The caller's own entries from `from` to `to` (both `YYYY-MM-DD`, inclusive). */
export async function listOwnEntries(from: string, to: string): Promise<TimeEntry[]> {
	guard();
	if (tauri()) return invokeCommand<TimeEntry[]>('time_entries_list', { from, to });
	const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
	return httpRequest<TimeEntry[]>(`/api/time-entries?${q}`, { method: 'GET' });
}

/** Create (`id` null, as a draft) or update one of the caller's entries. */
export async function saveEntry(
	id: number | null,
	values: TimeEntryInput
): Promise<TimeEntrySaved> {
	guard();
	if (tauri()) {
		return id === null
			? invokeCommand<TimeEntrySaved>('time_entries_create', { values })
			: invokeCommand<TimeEntrySaved>('time_entries_update', { id, values });
	}
	return id === null
		? httpRequest<TimeEntrySaved>('/api/time-entries', { method: 'POST', body: values })
		: httpRequest<TimeEntrySaved>(`/api/time-entries/${id}`, { method: 'PUT', body: values });
}

/** Delete one of the caller's drafts / returned entries. */
export async function deleteEntry(id: number, rowVersion: number): Promise<void> {
	guard();
	if (tauri()) return invokeCommand<void>('time_entries_delete', { id, rowVersion });
	return httpRequest<void>(`/api/time-entries/${id}?rowVersion=${rowVersion}`, {
		method: 'DELETE'
	});
}

/** Submit (申請) one of the caller's drafts / returned entries. */
export async function submitEntry(id: number, rowVersion: number): Promise<TimeEntry> {
	guard();
	if (tauri()) {
		return invokeCommand<TimeEntry>('time_entries_submit', { id, values: { rowVersion } });
	}
	return httpRequest<TimeEntry>(`/api/time-entries/${id}/submit`, {
		method: 'POST',
		body: { rowVersion }
	});
}

/** Submitted entries the caller may approve or return. */
export async function listApprovals(): Promise<TimeEntry[]> {
	guard();
	if (tauri()) return invokeCommand<TimeEntry[]>('time_entries_approvals');
	return httpRequest<TimeEntry[]>('/api/time-entries/approvals', { method: 'GET' });
}

/** Approve, or return with a reason (差戻し). */
export async function decideEntry(
	id: number,
	values: { rowVersion: number; approve: boolean; reason?: string }
): Promise<TimeEntry> {
	guard();
	if (tauri()) return invokeCommand<TimeEntry>('time_entries_decide', { id, values });
	return httpRequest<TimeEntry>(`/api/time-entries/${id}/decide`, {
		method: 'POST',
		body: values
	});
}

/** A project's hours (amounts: `ViewProjectAmounts`). */
export async function getProjectTimeSummary(projectId: number): Promise<ProjectTimeSummary> {
	guard();
	if (tauri()) return invokeCommand<ProjectTimeSummary>('project_time_summary', { projectId });
	return httpRequest<ProjectTimeSummary>(`/api/projects/${projectId}/time-summary`, {
		method: 'GET'
	});
}

/** A fresh id for `clientRequestId` (T13). */
export function newRequestId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === 'function') return c.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
