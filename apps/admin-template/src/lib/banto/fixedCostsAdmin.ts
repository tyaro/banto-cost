/**
 * Client for the banto-cost monthly fixed costs API (月額固定原価, design
 * §9.4, T37, P7b). Same transport split as closingAdmin.ts: the Tauri
 * webview calls `invoke()` (`fixed_cost_contracts`, `fixed_cost_month`,
 * `fixed_cost_contract_create`, `fixed_cost_contract_update`,
 * `fixed_cost_month_post`, `fixed_cost_posting_cancel`,
 * apps/admin-template/src-tauri/src/lib.rs) and a LAN browser calls
 * `fetch()` against the twin routes
 * (apps/admin-template/core/src/rest/fixed_costs.rs). Every route needs
 * `ManageFixedCosts` (`finance.rate` + `amount.view`): the amounts are per
 * person.
 *
 * Amounts are integer yen. Demo mode has no backend: every export rejects
 * like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

export type PayeeKind = 'employee' | 'vendor';
export type FixedCostType = 'labor' | 'outsource';
export type LineState = 'posted' | 'due' | 'project_closed';

/** Mirrors `admin_template_core::fixed_costs::Contract`. */
export interface FixedCostContract {
	id: number;
	projectId: number;
	projectCode: string;
	projectName: string;
	projectStatus: string;
	payeeKind: PayeeKind;
	userId: number | null;
	vendorId: number | null;
	payeeName: string | null;
	costType: FixedCostType;
	monthlyAmount: number;
	fromMonth: string;
	toMonth: string | null;
	description: string | null;
	rowVersion: number;
	postedCount: number;
	lastPostedMonth: string | null;
}

/** Mirrors `admin_template_core::fixed_costs::ContractInput`. */
export interface FixedCostContractInput {
	projectId: number | null;
	payeeKind: PayeeKind;
	userId: number | null;
	vendorId: number | null;
	monthlyAmount: number | null;
	fromMonth: string;
	toMonth: string | null;
	description: string | null;
	rowVersion?: number;
}

/** Mirrors `admin_template_core::fixed_costs::PostingView`. */
export interface FixedCostPosting {
	id: number;
	contractId: number;
	month: string;
	amount: number;
	status: 'approved' | 'cancelled';
	postedByName: string | null;
	postedAt: string;
	cancelReason: string | null;
	cancelledAt: string | null;
}

export interface FixedCostMonthLine {
	contract: FixedCostContract;
	state: LineState;
	posting: FixedCostPosting | null;
}

/** Mirrors `admin_template_core::fixed_costs::MonthView`. */
export interface FixedCostMonth {
	month: string;
	closed: boolean;
	lines: FixedCostMonthLine[];
	dueCount: number;
	postedTotal: number;
	cancelled: FixedCostPosting[];
}

export interface FixedCostPostResult {
	posted: number;
	view: FixedCostMonth;
}

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/** Every contract. */
export async function listFixedCostContracts(): Promise<FixedCostContract[]> {
	guard();
	if (tauri()) return invokeCommand<FixedCostContract[]>('fixed_cost_contracts', {});
	return httpRequest<FixedCostContract[]>('/api/fixed-costs/contracts', { method: 'GET' });
}

/** Register (`id` null) or change a contract. */
export async function saveFixedCostContract(
	id: number | null,
	values: FixedCostContractInput
): Promise<FixedCostContract> {
	guard();
	if (tauri()) {
		return id === null
			? invokeCommand<FixedCostContract>('fixed_cost_contract_create', { values })
			: invokeCommand<FixedCostContract>('fixed_cost_contract_update', { id, values });
	}
	return id === null
		? httpRequest<FixedCostContract>('/api/fixed-costs/contracts', {
				method: 'POST',
				body: values
			})
		: httpRequest<FixedCostContract>(`/api/fixed-costs/contracts/${id}`, {
				method: 'PUT',
				body: values
			});
}

/** A month (`YYYY-MM`): every contract covering it, posted or not. */
export async function getFixedCostMonth(month: string): Promise<FixedCostMonth> {
	guard();
	if (tauri()) return invokeCommand<FixedCostMonth>('fixed_cost_month', { month });
	return httpRequest<FixedCostMonth>(`/api/fixed-costs/months/${encodeURIComponent(month)}`, {
		method: 'GET'
	});
}

/** Post the month (計上): each due contract once. */
export async function postFixedCostMonth(month: string): Promise<FixedCostPostResult> {
	guard();
	if (tauri()) return invokeCommand<FixedCostPostResult>('fixed_cost_month_post', { month });
	return httpRequest<FixedCostPostResult>(
		`/api/fixed-costs/months/${encodeURIComponent(month)}/post`,
		{ method: 'POST', body: {} }
	);
}

/** Cancel a posting with a reason (取消). */
export async function cancelFixedCostPosting(id: number, reason: string): Promise<FixedCostMonth> {
	guard();
	const values = { reason };
	if (tauri()) return invokeCommand<FixedCostMonth>('fixed_cost_posting_cancel', { id, values });
	return httpRequest<FixedCostMonth>(`/api/fixed-costs/postings/${id}/cancel`, {
		method: 'POST',
		body: values
	});
}

/** The term as shown: `2026-06〜` or `2026-06〜2027-05`. */
export function termLabel(c: Pick<FixedCostContract, 'fromMonth' | 'toMonth'>): string {
	return `${c.fromMonth}〜${c.toMonth ?? ''}`;
}

/** This month (`YYYY-MM`), the usual one to post. */
export function currentMonth(today: Date): string {
	return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
}
