/**
 * Client for the banto-cost settlement API (精算完了, spec §5.1, T17, P6a).
 * Same transport split as forecastAdmin.ts: the Tauri webview calls
 * `invoke()` (`project_closeout_get`, `project_closeout_settle`,
 * apps/admin-template/src-tauri/src/lib.rs) and a LAN browser calls `fetch()`
 * against the twin routes (apps/admin-template/core/src/rest/closeouts.rs).
 *
 * Amounts are integer yen, hours integer minutes. A waiver names the amount
 * it is given for; when that amount changed on the server, the settlement
 * is refused and the check has to be read again.
 *
 * Demo mode has no backend: every export rejects like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

export type BlockerKind =
	| 'unapproved'
	| 'missing_rate'
	| 'provisional'
	| 'pending_order_changes'
	| 'purchase_remaining'
	| 'forecast_remaining'
	| 'revenue_difference';

/** Mirrors `admin_template_core::closeouts::BlockerView`. */
export interface CloseoutBlocker {
	kind: BlockerKind;
	waivable: boolean;
	amount: number | null;
	purchaseOrderId: number | null;
	purchaseOrderLabel: string | null;
	count: number | null;
	timeEntries: number | null;
	minutes: number | null;
	costs: number | null;
}

export interface CloseoutWaiver {
	kind: BlockerKind;
	purchaseOrderId: number | null;
	amount: number;
	reason: string;
	approvedByName: string | null;
	purchaseOrderLabel: string | null;
}

export interface CloseoutRecord {
	id: number;
	previousStatus: string;
	settledOn: string;
	note: string | null;
	settledByName: string | null;
	createdAt: string;
	waivers: CloseoutWaiver[];
}

/** Mirrors `admin_template_core::closeouts::CloseoutCheck`. */
export interface CloseoutCheck {
	projectId: number;
	status: string;
	rowVersion: number;
	settleable: boolean;
	blockers: CloseoutBlocker[];
	closeout: CloseoutRecord | null;
}

export interface WaiverInput {
	kind: BlockerKind;
	purchaseOrderId: number | null;
	amount: number;
	reason: string;
}

export interface SettleInput {
	rowVersion: number;
	note: string | null;
	waivers: WaiverInput[];
}

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/** What blocks the settlement, and the settlement once recorded (`ViewProjectAmounts`). */
export async function getProjectCloseout(projectId: number): Promise<CloseoutCheck> {
	guard();
	if (tauri()) return invokeCommand<CloseoutCheck>('project_closeout_get', { projectId });
	return httpRequest<CloseoutCheck>(`/api/projects/${projectId}/closeout`, { method: 'GET' });
}

/** Settle a work-done project (`SettleProject`: accounting). */
export async function settleProject(
	projectId: number,
	values: SettleInput
): Promise<CloseoutCheck> {
	guard();
	if (tauri()) {
		return invokeCommand<CloseoutCheck>('project_closeout_settle', { projectId, values });
	}
	return httpRequest<CloseoutCheck>(`/api/projects/${projectId}/closeout`, {
		method: 'POST',
		body: values
	});
}

/** The key a waiver input is kept under (a purchase order has one per order). */
export function blockerKey(b: { kind: BlockerKind; purchaseOrderId: number | null }): string {
	return b.purchaseOrderId === null ? b.kind : `${b.kind}:${b.purchaseOrderId}`;
}
