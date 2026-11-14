/**
 * Client for the banto-cost direct-cost and purchase-order API (直接費・発注,
 * spec §6.3 / §6.4, T05, T10, T14, P4d). Same transport split as
 * timeAdmin.ts: the Tauri webview calls `invoke()` (`vendors_*`,
 * `direct_costs_*`, `purchase_orders_*`, `project_costs`,
 * apps/admin-template/src-tauri/src/lib.rs) and a LAN browser calls `fetch()`
 * against the twin routes (apps/admin-template/core/src/rest/costs.rs).
 *
 * Amounts are tax-exclusive integer yen. A reduction is never a negative
 * amount: it is an `adjustment` (return / cancel / discount) of an approved
 * record. An invoice replaces a provisional through a `confirms` record.
 *
 * Demo mode has no backend: every export rejects like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';
import type { TimeStatus } from './timeAdmin';

export type DirectCostType = 'material' | 'outsource' | 'travel' | 'other';
export const DIRECT_COST_TYPES: readonly DirectCostType[] = [
	'material',
	'outsource',
	'travel',
	'other'
];
export type EntryKind = 'normal' | 'provisional' | 'confirms' | 'adjustment';
export type AdjustmentKind = 'return' | 'cancel' | 'discount';
export const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = ['return', 'cancel', 'discount'];
export type TaxKind = 'standard' | 'reduced' | 'exempt' | 'out_of_scope';
export const TAX_KINDS: readonly TaxKind[] = ['standard', 'reduced', 'exempt', 'out_of_scope'];

export interface AllocationLine {
	projectId: number;
	projectCode: string;
	projectName: string;
	amount: number;
}

/** Mirrors `admin_template_core::direct_costs::DirectCost`. */
export interface DirectCost {
	id: number;
	userId: number;
	userName: string;
	entryKind: EntryKind;
	refId: number | null;
	adjustmentKind: AdjustmentKind | null;
	projectId: number | null;
	projectCode: string | null;
	projectName: string | null;
	phaseId: number | null;
	phaseName: string | null;
	costType: DirectCostType;
	vendorId: number | null;
	vendorName: string | null;
	purchaseOrderId: number | null;
	description: string | null;
	bookedOn: string;
	amount: number;
	taxKind: TaxKind | null;
	amountInTax: number | null;
	voucherNo: string | null;
	reason: string | null;
	allocationBasis: string | null;
	allocations: AllocationLine[];
	status: TimeStatus;
	submittedAt: string | null;
	decidedByName: string | null;
	decidedAt: string | null;
	returnReason: string | null;
	confirmedBy: number | null;
	adjusted: number;
	/**
	 * On the owner's list only: a draft or returned record the owner may also
	 * approve once submitted (申請して承認, review U-2).
	 */
	canApprove?: boolean;
	rowVersion: number;
	updatedAt: string;
}

export interface DirectCostInput {
	entryKind?: EntryKind;
	refId?: number | null;
	adjustmentKind?: AdjustmentKind | null;
	projectId: number | null;
	phaseId: number | null;
	costType: DirectCostType | null;
	vendorId: number | null;
	purchaseOrderId: number | null;
	description: string | null;
	bookedOn: string;
	amount: number;
	taxKind: TaxKind | null;
	amountInTax: number | null;
	voucherNo: string | null;
	reason: string | null;
	allocationBasis: string | null;
	allocations: { projectId: number; amount: number }[];
	/** Create only (T13). */
	clientRequestId?: string;
	/** Update only. */
	rowVersion?: number;
}

export interface DirectCostSaved {
	cost: DirectCost;
	replayed: boolean;
}

export interface OrderChange {
	kind: 'amount' | 'cancel';
	beforeAmount: number;
	afterAmount: number;
	reason: string;
	createdByName: string | null;
	createdAt: string;
}

/** Mirrors `admin_template_core::direct_costs::PurchaseOrderView`. */
export interface PurchaseOrder {
	id: number;
	projectId: number;
	vendorId: number | null;
	vendorName: string | null;
	phaseId: number | null;
	phaseName: string | null;
	costType: DirectCostType;
	description: string | null;
	orderedOn: string;
	amount: number;
	cancelledAmount: number;
	realized: number;
	remaining: number;
	pendingCount: number;
	pendingAmount: number;
	changes: OrderChange[];
	createdBy: number | null;
	createdByName: string | null;
	rowVersion: number;
	updatedAt: string;
}

export interface PurchaseOrderInput {
	projectId?: number;
	vendorId: number | null;
	phaseId: number | null;
	costType?: DirectCostType;
	description: string | null;
	orderedOn: string;
	amount?: number;
	clientRequestId?: string;
	rowVersion?: number;
}

export interface CostTypeAmount {
	costType: DirectCostType;
	amount: number;
}

/** Mirrors `admin_template_core::direct_costs::ProjectCosts`. */
export interface ProjectCosts {
	projectId: number;
	entries: DirectCost[];
	totals: CostTypeAmount[];
	total: number;
	months: { month: string; period: number; byType: CostTypeAmount[]; total: number }[];
	pending: { count: number; amount: number };
	provisional: { count: number; amount: number };
	complete: boolean;
	orders: PurchaseOrder[];
	committed: number;
}

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/** The caller's own records booked from `from` to `to` (inclusive). */
export async function listOwnCosts(from: string, to: string): Promise<DirectCost[]> {
	guard();
	if (tauri()) return invokeCommand<DirectCost[]>('direct_costs_list', { from, to });
	const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
	return httpRequest<DirectCost[]>(`/api/direct-costs?${q}`, { method: 'GET' });
}

/** Create (`id` null, as a draft) or update one of the caller's records. */
export async function saveCost(
	id: number | null,
	values: DirectCostInput
): Promise<DirectCostSaved> {
	guard();
	if (tauri()) {
		return id === null
			? invokeCommand<DirectCostSaved>('direct_costs_create', { values })
			: invokeCommand<DirectCostSaved>('direct_costs_update', { id, values });
	}
	return id === null
		? httpRequest<DirectCostSaved>('/api/direct-costs', { method: 'POST', body: values })
		: httpRequest<DirectCostSaved>(`/api/direct-costs/${id}`, { method: 'PUT', body: values });
}

export async function deleteCost(id: number, rowVersion: number): Promise<void> {
	guard();
	if (tauri()) return invokeCommand<void>('direct_costs_delete', { id, rowVersion });
	return httpRequest<void>(`/api/direct-costs/${id}?rowVersion=${rowVersion}`, {
		method: 'DELETE'
	});
}

export async function submitCost(id: number, rowVersion: number): Promise<DirectCost> {
	guard();
	if (tauri()) {
		return invokeCommand<DirectCost>('direct_costs_submit', { id, values: { rowVersion } });
	}
	return httpRequest<DirectCost>(`/api/direct-costs/${id}/submit`, {
		method: 'POST',
		body: { rowVersion }
	});
}

/** Submitted records the caller may approve or return. */
export async function listCostApprovals(): Promise<DirectCost[]> {
	guard();
	if (tauri()) return invokeCommand<DirectCost[]>('direct_costs_approvals');
	return httpRequest<DirectCost[]>('/api/direct-costs/approvals', { method: 'GET' });
}

export async function decideCost(
	id: number,
	values: { rowVersion: number; approve: boolean; reason?: string }
): Promise<DirectCost> {
	guard();
	if (tauri()) return invokeCommand<DirectCost>('direct_costs_decide', { id, values });
	return httpRequest<DirectCost>(`/api/direct-costs/${id}/decide`, {
		method: 'POST',
		body: values
	});
}

/** A project's direct costs and orders (`ViewProjectAmounts`). */
export async function getProjectCosts(projectId: number): Promise<ProjectCosts> {
	guard();
	if (tauri()) return invokeCommand<ProjectCosts>('project_costs', { projectId });
	return httpRequest<ProjectCosts>(`/api/projects/${projectId}/costs`, { method: 'GET' });
}

/** Register (`id` null) or update an order's vendor, phase, description and date. */
export async function saveOrder(
	id: number | null,
	values: PurchaseOrderInput
): Promise<PurchaseOrder> {
	guard();
	if (id === null) {
		const saved = tauri()
			? await invokeCommand<{ order: PurchaseOrder }>('purchase_orders_create', { values })
			: await httpRequest<{ order: PurchaseOrder }>('/api/purchase-orders', {
					method: 'POST',
					body: values
				});
		return saved.order;
	}
	if (tauri()) return invokeCommand<PurchaseOrder>('purchase_orders_update', { id, values });
	return httpRequest<PurchaseOrder>(`/api/purchase-orders/${id}`, { method: 'PUT', body: values });
}

/** Revise an order's amount (`amount`) or cancel part of it (`cancel`), with the reason. */
export async function reviseOrder(
	id: number,
	values: { kind: 'amount' | 'cancel'; amount: number; reason: string; rowVersion: number }
): Promise<PurchaseOrder> {
	guard();
	if (tauri()) return invokeCommand<PurchaseOrder>('purchase_orders_revise', { id, values });
	return httpRequest<PurchaseOrder>(`/api/purchase-orders/${id}/revise`, {
		method: 'POST',
		body: values
	});
}
