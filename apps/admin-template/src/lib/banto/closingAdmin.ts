/**
 * Client for the banto-cost monthly close API (月次締め, spec §7 / §9, T11,
 * P6b). Same transport split as closeoutAdmin.ts: the Tauri webview calls
 * `invoke()` (`closing_months`, `closing_get`, `closing_close`,
 * `closing_reopen`, apps/admin-template/src-tauri/src/lib.rs) and a LAN
 * browser calls `fetch()` against the twin routes
 * (apps/admin-template/core/src/rest/closing.rs). Every route is
 * accounting's (`CloseMonth`: `finance.close` + `amount.view`).
 *
 * Amounts are integer yen. Demo mode has no backend: every export rejects
 * like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

export type MonthStatus = 'open' | 'closed' | 'reopened';
export type WarningCode =
	'missing_rate' | 'provisional' | 'fixed_unposted' | 'recurring_unrecognized';

/** Mirrors `admin_template_core::closing::MonthRow`. */
export interface MonthRow {
	month: string;
	status: MonthStatus;
	updatedAt: string;
}

/** Mirrors `admin_template_core::closing::ClosingEvent`. */
export interface ClosingEvent {
	id: number;
	action: 'close' | 'reopen';
	reason: string | null;
	actorName: string | null;
	createdAt: string;
}

export interface Figures {
	laborCost: number;
	laborMissing: number;
	directCost: number;
	revenue: number;
}

export interface DiffRow {
	projectId: number;
	projectCode: string | null;
	projectName: string | null;
	atClose: Figures;
	current: Figures;
}

export interface Comparison {
	eventId: number;
	closedAt: string;
	totalAtClose: Figures;
	totalCurrent: Figures;
	changed: DiffRow[];
}

/** Mirrors `admin_template_core::closing::MonthClosing`. */
export interface MonthClosing {
	month: string;
	status: MonthStatus;
	rowVersion: number;
	unapprovedTimeEntries: number;
	unapprovedCosts: number;
	/** Direct-cost records left out of the ledger for review (T39). */
	ledgerReviewEntries: number;
	canClose: boolean;
	warnings: { code: WarningCode; count: number }[];
	total: Figures;
	history: ClosingEvent[];
	comparison: Comparison | null;
}

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/** The months closed or reopened, newest first. */
export async function listClosingMonths(): Promise<MonthRow[]> {
	guard();
	if (tauri()) return invokeCommand<MonthRow[]>('closing_months', {});
	return httpRequest<MonthRow[]>('/api/closing', { method: 'GET' });
}

/** A month (`YYYY-MM`): status, what blocks the close, history, comparison. */
export async function getClosingMonth(month: string): Promise<MonthClosing> {
	guard();
	if (tauri()) return invokeCommand<MonthClosing>('closing_get', { month });
	return httpRequest<MonthClosing>(`/api/closing/${encodeURIComponent(month)}`, {
		method: 'GET'
	});
}

/** Close the month (締め). */
export async function closeMonth(month: string, rowVersion: number): Promise<MonthClosing> {
	guard();
	const values = { rowVersion };
	if (tauri()) return invokeCommand<MonthClosing>('closing_close', { month, values });
	return httpRequest<MonthClosing>(`/api/closing/${encodeURIComponent(month)}/close`, {
		method: 'POST',
		body: values
	});
}

/** Reopen a closed month with a reason (再開). */
export async function reopenMonth(
	month: string,
	rowVersion: number,
	reason: string
): Promise<MonthClosing> {
	guard();
	const values = { rowVersion, reason };
	if (tauri()) return invokeCommand<MonthClosing>('closing_reopen', { month, values });
	return httpRequest<MonthClosing>(`/api/closing/${encodeURIComponent(month)}/reopen`, {
		method: 'POST',
		body: values
	});
}

/** The month before a business date's (`YYYY-MM-DD`), the usual one to close. */
export function previousMonth(today: string): string {
	const y = Number(today.slice(0, 4));
	const m = Number(today.slice(5, 7)) - 1; // the previous month's 1-based number
	return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}
