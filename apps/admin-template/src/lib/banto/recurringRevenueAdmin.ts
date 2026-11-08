/**
 * Client for the banto-cost recurring revenue API (定期売上, design §9.4,
 * T38, P7c). Same transport split as fixedCostsAdmin.ts: the Tauri webview
 * calls `invoke()` (`recurring_revenue_agreements`,
 * `recurring_revenue_month`, `recurring_revenue_agreement_create`,
 * `recurring_revenue_agreement_update`, `recurring_revenue_month_recognize`,
 * apps/admin-template/src-tauri/src/lib.rs) and a LAN browser calls
 * `fetch()` against the twin routes
 * (apps/admin-template/core/src/rest/recurring_revenue.rs). Every route
 * needs `ManageRecurringRevenue` (`finance.close` + `amount.view`).
 *
 * Amounts are integer yen. Demo mode has no backend: every export rejects
 * like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

export type RecurringLineState = 'due' | 'recognized' | 'project_closed' | 'no_plan';

/** Mirrors `admin_template_core::recurring_revenue::Agreement`. */
export interface RecurringAgreement {
	id: number;
	projectId: number;
	projectCode: string;
	projectName: string;
	projectStatus: string;
	monthlyAmount: number;
	fromMonth: string;
	toMonth: string;
	description: string | null;
	rowVersion: number;
	months: number;
	contractTotal: number;
	recognizedTotal: number;
}

/** Mirrors `admin_template_core::recurring_revenue::AgreementInput`. */
export interface RecurringAgreementInput {
	projectId: number | null;
	monthlyAmount: number | null;
	fromMonth: string;
	toMonth: string;
	description: string | null;
	rowVersion?: number;
}

export interface RecurringMonthLine {
	agreement: RecurringAgreement;
	state: RecurringLineState;
	planned: number;
	open: number;
}

/** Mirrors `admin_template_core::recurring_revenue::MonthView`. */
export interface RecurringMonth {
	month: string;
	recognizedOn: string;
	closed: boolean;
	lines: RecurringMonthLine[];
	dueCount: number;
	dueTotal: number;
}

export interface RecurringFailure {
	projectId: number;
	projectCode: string;
	message: string;
}

export interface RecurringRecognizeResult {
	recognized: number;
	projectIds: number[];
	failures: RecurringFailure[];
	view: RecurringMonth;
}

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/** Every agreement. */
export async function listRecurringAgreements(): Promise<RecurringAgreement[]> {
	guard();
	if (tauri()) return invokeCommand<RecurringAgreement[]>('recurring_revenue_agreements', {});
	return httpRequest<RecurringAgreement[]>('/api/recurring-revenue/agreements', {
		method: 'GET'
	});
}

/** Register (`id` null) or change an agreement; the server regenerates the monthly plan. */
export async function saveRecurringAgreement(
	id: number | null,
	values: RecurringAgreementInput
): Promise<RecurringAgreement> {
	guard();
	if (tauri()) {
		return id === null
			? invokeCommand<RecurringAgreement>('recurring_revenue_agreement_create', { values })
			: invokeCommand<RecurringAgreement>('recurring_revenue_agreement_update', { id, values });
	}
	return id === null
		? httpRequest<RecurringAgreement>('/api/recurring-revenue/agreements', {
				method: 'POST',
				body: values
			})
		: httpRequest<RecurringAgreement>(`/api/recurring-revenue/agreements/${id}`, {
				method: 'PUT',
				body: values
			});
}

/** A month (`YYYY-MM`): every agreement covering it. */
export async function getRecurringMonth(month: string): Promise<RecurringMonth> {
	guard();
	if (tauri()) return invokeCommand<RecurringMonth>('recurring_revenue_month', { month });
	return httpRequest<RecurringMonth>(`/api/recurring-revenue/months/${encodeURIComponent(month)}`, {
		method: 'GET'
	});
}

/** Recognize the month (月末検収): each due agreement once. */
export async function recognizeRecurringMonth(month: string): Promise<RecurringRecognizeResult> {
	guard();
	if (tauri())
		return invokeCommand<RecurringRecognizeResult>('recurring_revenue_month_recognize', { month });
	return httpRequest<RecurringRecognizeResult>(
		`/api/recurring-revenue/months/${encodeURIComponent(month)}/recognize`,
		{ method: 'POST', body: {} }
	);
}

/** Months from `from` to `to` (both `YYYY-MM`, inclusive); `null` when either is unset or reversed. */
export function monthsBetween(from: string, to: string): number | null {
	const re = /^(\d{4})-(0[1-9]|1[0-2])$/;
	const a = re.exec(from);
	const b = re.exec(to);
	if (!a || !b) return null;
	const n = (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2])) + 1;
	return n >= 1 ? n : null;
}
