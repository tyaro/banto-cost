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
 * Corrections (訂正, P6b-2, T11): an approved entry is never edited; its
 * owner requests a correction (a new row with `correctsId` and a reason,
 * submitted at once) and accounting approves it again. Once approved the
 * entry it replaces (`replacedById`) no longer counts; a returned correction
 * is history only (`countsInTotals`).
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
	/** A correction: the entry it replaces once approved. */
	correctsId: number | null;
	correctionReason: string | null;
	/** The approved correction that replaced this entry (it no longer counts). */
	replacedById: number | null;
	/** A correction of this entry waits for approval. */
	correctionPending: boolean;
	/**
	 * Not yet approved and no hourly rate resolves for its project and work
	 * date: approving now fixes 原価未確定. Only on the approval list and
	 * the owner's list; absent elsewhere and once approved.
	 */
	rateMissing?: boolean;
	/**
	 * On the owner's list only: a draft or returned entry the owner may also
	 * approve once submitted (the server's approval rule), so the screen can
	 * offer 申請して承認 (review U-2). Absent elsewhere.
	 */
	canApprove?: boolean;
	rowVersion: number;
	updatedAt: string;
}

/** Mirrors `admin_template_core::time_entries::CorrectionPair`. */
export interface CorrectionPair {
	correction: TimeEntry;
	original: TimeEntry;
}

/** Mirrors `cost_domain::time::counts`: a replaced entry and a returned correction count as nothing. */
export function countsInTotals(e: TimeEntry): boolean {
	if (e.replacedById !== null) return false;
	return !(e.correctsId !== null && e.status === 'returned');
}

/** An approved entry that can be corrected now (not replaced, no correction pending). */
export function isCorrectable(e: TimeEntry): boolean {
	return e.status === 'approved' && e.replacedById === null && !e.correctionPending;
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

/**
 * Request a correction of one of the caller's approved entries: the corrected
 * values, the reason and the entry's `rowVersion` (T11, T13).
 */
export async function correctEntry(
	id: number,
	values: TimeEntryInput & { rowVersion: number; reason: string }
): Promise<TimeEntrySaved> {
	guard();
	if (tauri()) return invokeCommand<TimeEntrySaved>('time_entries_correct', { id, values });
	return httpRequest<TimeEntrySaved>(`/api/time-entries/${id}/correct`, {
		method: 'POST',
		body: values
	});
}

/** The corrections of one of the caller's entries, newest first. */
export async function listEntryCorrections(id: number): Promise<TimeEntry[]> {
	guard();
	if (tauri()) return invokeCommand<TimeEntry[]>('time_entries_corrections', { id });
	return httpRequest<TimeEntry[]>(`/api/time-entries/${id}/corrections`, { method: 'GET' });
}

/** Corrections waiting for accounting's approval (empty for everyone else). */
export async function listPendingCorrections(): Promise<CorrectionPair[]> {
	guard();
	if (tauri()) return invokeCommand<CorrectionPair[]>('time_entries_pending_corrections');
	return httpRequest<CorrectionPair[]>('/api/time-entries/corrections', { method: 'GET' });
}

/**
 * An approved entry whose saved rate differs from the rate that applies now
 * (単価の当て直しの候補, T45). Mirrors `time_entries::RerateCandidate`.
 */
export interface RerateCandidate {
	entry: TimeEntry;
	newRate: number;
	newCost: number;
	source: 'personProject' | 'person' | 'projectOverride' | 'company';
	/** Why it cannot be rerated now; `null` = it can. */
	blocked: 'closed_month' | 'settled' | 'correction_pending' | null;
}

export interface RerateList {
	candidates: RerateCandidate[];
	/** Approved entries that still have no rate anywhere. */
	noRate: number;
}

/** The rerate candidates (`finance.rate` + `amount.view` + `finance.close`). */
export async function listRerates(): Promise<RerateList> {
	guard();
	if (tauri()) return invokeCommand<RerateList>('time_entries_rerates');
	return httpRequest<RerateList>('/api/time-entries/rerates', { method: 'GET' });
}

/**
 * Rerate one approved entry with the rate that applies now: an approved
 * correction of it (the entry stays as history). `rowVersion` is the entry's (T13).
 */
export async function rerateEntry(
	id: number,
	values: { rowVersion: number; reason: string }
): Promise<TimeEntry> {
	guard();
	if (tauri()) return invokeCommand<TimeEntry>('time_entries_rerate', { id, values });
	return httpRequest<TimeEntry>(`/api/time-entries/${id}/rerate`, {
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
