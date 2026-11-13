/**
 * Client for the banto-cost order / revenue / outlook API (P3b, spec §5.5 /
 * §7.5). Same transport split as pipelineAdmin.ts: the Tauri webview calls
 * `invoke()` (`order_*` / `revenue_*` / `outlook_*`,
 * apps/admin-template/src-tauri/src/lib.rs) and a LAN browser calls
 * `fetch()` against `/api/projects/{id}/order/*` and `/api/outlook*`
 * (apps/admin-template/core/src/rest/projects.rs).
 *
 * Demo mode has no backend: every export rejects like pipelineAdmin.ts.
 *
 * Amounts are integer yen; `null` means 未設定 / before the order and is
 * never shown or summed as 0 (banto-cost CLAUDE.md).
 */
import { getBantoMode } from './setup';
import {
	demoModeError,
	httpRequest,
	invokeCommand,
	isPipelineAvailable,
	type PipelineVersionInput,
	type PlanLine
} from './pipelineAdmin';

/** Mirrors `admin_template_core::orders::OrderConversion`. */
export interface OrderConversion {
	id: number;
	sourcePipelineVersionId: number | null;
	sourceVersionNo: number | null;
	previousStatus: string;
	convertedOn: string;
	confirmedAmount: number;
	scope: 'whole' | 'partial';
	remainderProjectId: number | null;
	remainderCode: string | null;
	basis: string;
	createdByName: string | null;
	createdAt: string;
	/** Corrections of the 受注日 / 根拠 (T41), newest first. */
	corrections: ConversionCorrectionRow[];
}

/** Mirrors `admin_template_core::orders::ConversionCorrectionRow` (T41). */
export interface ConversionCorrectionRow {
	id: number;
	oldConvertedOn: string;
	newConvertedOn: string;
	oldBasis: string;
	newBasis: string;
	reason: string;
	correctedOn: string;
	correctedByName: string | null;
	correctedAt: string;
}

/** Mirrors `admin_template_core::orders::ConversionCorrectionInput` (T41). */
export interface ConversionCorrectionInput {
	revenueVersion: number;
	convertedOn: string;
	basis: string;
	reason: string;
}

/** Mirrors `admin_template_core::orders::CancelledConversion` (T40). */
export interface CancelledConversion {
	id: number;
	previousStatus: string;
	convertedOn: string;
	confirmedAmount: number;
	scope: 'whole' | 'partial';
	/** A partial order's remainder project (set to 中止 by the cancellation). */
	remainderProjectId: number | null;
	remainderCode: string | null;
	basis: string;
	createdByName: string | null;
	cancelledOn: string;
	cancelReason: string;
	cancelledByName: string | null;
	cancelledAt: string;
}

export interface OrderChangeRow {
	id: number;
	changeNo: number;
	deltaAmount: number;
	/** `null` = 時期未定. */
	planMonth: string | null;
	status: 'pending' | 'approved' | 'rejected';
	basis: string;
	requestedBy: number | null;
	requestedByName: string | null;
	requestedAt: string;
	decidedByName: string | null;
	decidedAt: string | null;
	decisionNote: string | null;
}

export interface RevenuePlanRow {
	id: number;
	month: string | null;
	amount: number;
	cleared: number;
	open: number;
}

export interface ClearingRow {
	planId: number;
	month: string | null;
	amount: number;
}

export interface RecognitionRow {
	id: number;
	recognizedOn: string;
	amount: number;
	basis: string | null;
	recordedByName: string | null;
	recordedAt: string;
	cancelledByName: string | null;
	cancelledAt: string | null;
	cancelReason: string | null;
	clears: ClearingRow[];
}

/** Mirrors `admin_template_core::orders::OrderSummary`. */
export interface OrderSummary {
	projectId: number;
	status: string;
	revenueVersion: number;
	parentProjectId: number | null;
	parentCode: string | null;
	conversion: OrderConversion | null;
	/** 確定受注額; `null` before the order. */
	confirmedAmount: number | null;
	/** 未確定追加売上 (pending changes), outside the confirmed amount. */
	pendingTotal: number;
	recognizedTotal: number;
	/** 未計上残; `null` before the order. */
	remaining: number | null;
	plan: RevenuePlanRow[];
	changes: OrderChangeRow[];
	recognitions: RecognitionRow[];
	issues: string[];
	/**
	 * Why the current conversion cannot be cancelled
	 * (`cost_domain::order::ConversionCancelIssue` codes); empty when it can,
	 * or when there is no conversion (T40).
	 */
	cancelBlockers: string[];
	/** Cancelled conversions, newest first. */
	cancelledConversions: CancelledConversion[];
}

export interface ConversionRequest {
	rowVersion: number;
	convertedOn: string;
	confirmedAmount: number;
	basis: string | null;
	plannedStart: string | null;
	plannedEnd: string | null;
	orderNo: string | null;
	revenuePlan: PlanLine[];
	scope: 'whole' | 'partial';
	remainder: { code: string; name: string; version: PipelineVersionInput } | null;
}

export interface ChangeRequest {
	deltaAmount: number;
	planMonth: string | null;
	basis: string | null;
}

export interface RecognitionInput {
	recognizedOn: string;
	amount: number;
	basis: string | null;
}

export interface OutlookFigures {
	recognized: number;
	orderedPlan: number;
	weightedPipeline: number;
	total: number;
	pendingAddition: number;
	previousTotal: number | null;
	difference: number | null;
}

export interface OutlookRow extends OutlookFigures {
	/** `null` = 時期未定. */
	month: string | null;
}

export interface ProjectRef {
	projectId: number;
	code: string;
	name: string;
}

export interface SnapshotInfo {
	id: number;
	label: string;
	createdByName: string | null;
	createdAt: string;
}

/** Mirrors `admin_template_core::orders::outlook::OutlookView`. */
export interface OutlookView {
	rows: OutlookRow[];
	totals: OutlookFigures;
	excluded: ProjectRef[];
	revenueIssues: (ProjectRef & { issues: string[] })[];
	compared: SnapshotInfo | null;
	snapshot: SnapshotInfo | null;
}

export interface OutlookQuery {
	from?: string | null;
	to?: string | null;
	compare?: number | null;
}

function guard() {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

export async function getOrder(projectId: number): Promise<OrderSummary> {
	guard();
	if (tauri()) return invokeCommand<OrderSummary>('order_get', { projectId });
	return httpRequest<OrderSummary>(`/api/projects/${projectId}/order`, { method: 'GET' });
}

export async function convertOrder(
	projectId: number,
	values: ConversionRequest
): Promise<OrderSummary> {
	guard();
	if (tauri()) return invokeCommand<OrderSummary>('order_convert', { projectId, values });
	return httpRequest<OrderSummary>(`/api/projects/${projectId}/order/convert`, {
		method: 'POST',
		body: values
	});
}

/**
 * 受注転換の取消 (T40): back to the status before the conversion. Only an
 * order with nothing recorded on it (a partial order's remainder is set to
 * 中止); the reason is required.
 */
export async function cancelOrderConversion(
	projectId: number,
	values: { rowVersion: number; reason: string }
): Promise<OrderSummary> {
	guard();
	if (tauri()) {
		return invokeCommand<OrderSummary>('order_conversion_cancel', { projectId, values });
	}
	return httpRequest<OrderSummary>(`/api/projects/${projectId}/order/conversion/cancel`, {
		method: 'POST',
		body: values
	});
}

/**
 * 受注日・根拠の訂正 (T41): also after records are on the order (not once
 * settled). The values before and after stay in `conversion.corrections`.
 */
export async function correctOrderConversion(
	projectId: number,
	values: ConversionCorrectionInput
): Promise<OrderSummary> {
	guard();
	if (tauri()) {
		return invokeCommand<OrderSummary>('order_conversion_correct', { projectId, values });
	}
	return httpRequest<OrderSummary>(`/api/projects/${projectId}/order/conversion/correct`, {
		method: 'POST',
		body: values
	});
}

export async function requestOrderChange(
	projectId: number,
	values: ChangeRequest
): Promise<OrderSummary> {
	guard();
	if (tauri()) return invokeCommand<OrderSummary>('order_change_create', { projectId, values });
	return httpRequest<OrderSummary>(`/api/projects/${projectId}/order/changes`, {
		method: 'POST',
		body: values
	});
}

export async function decideOrderChange(
	projectId: number,
	changeId: number,
	values: { approve: boolean; note: string | null }
): Promise<OrderSummary> {
	guard();
	if (tauri()) {
		return invokeCommand<OrderSummary>('order_change_decide', { projectId, changeId, values });
	}
	return httpRequest<OrderSummary>(`/api/projects/${projectId}/order/changes/${changeId}/decide`, {
		method: 'POST',
		body: values
	});
}

/** Replace the open (not yet recognized) plan; its total must equal the remainder. */
export async function replaceRevenuePlan(
	projectId: number,
	values: { revenueVersion: number; lines: PlanLine[] }
): Promise<OrderSummary> {
	guard();
	if (tauri()) return invokeCommand<OrderSummary>('revenue_plan_replace', { projectId, values });
	return httpRequest<OrderSummary>(`/api/projects/${projectId}/order/revenue-plan`, {
		method: 'PUT',
		body: values
	});
}

/** Record recognized revenue; the server clears plan lines automatically (month first). */
export async function recordRecognition(
	projectId: number,
	values: RecognitionInput
): Promise<OrderSummary> {
	guard();
	if (tauri()) {
		return invokeCommand<OrderSummary>('revenue_recognition_create', { projectId, values });
	}
	return httpRequest<OrderSummary>(`/api/projects/${projectId}/order/recognitions`, {
		method: 'POST',
		body: values
	});
}

export async function cancelRecognition(
	projectId: number,
	recognitionId: number,
	reason: string | null
): Promise<OrderSummary> {
	guard();
	const values = { reason };
	if (tauri()) {
		return invokeCommand<OrderSummary>('revenue_recognition_cancel', {
			projectId,
			recognitionId,
			values
		});
	}
	return httpRequest<OrderSummary>(
		`/api/projects/${projectId}/order/recognitions/${recognitionId}/cancel`,
		{ method: 'POST', body: values }
	);
}

function queryString(query: OutlookQuery): string {
	const params = new URLSearchParams();
	if (query.from) params.set('from', query.from);
	if (query.to) params.set('to', query.to);
	if (query.compare !== null && query.compare !== undefined) {
		params.set('compare', String(query.compare));
	}
	const text = params.toString();
	return text ? `?${text}` : '';
}

/** Tauri's `OutlookQuery` (serde camelCase): unset fields are omitted. */
function tauriQuery(query: OutlookQuery): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (query.from) out.from = query.from;
	if (query.to) out.to = query.to;
	if (query.compare !== null && query.compare !== undefined) out.compare = query.compare;
	return out;
}

export async function getOutlook(query: OutlookQuery = {}): Promise<OutlookView> {
	guard();
	if (tauri()) return invokeCommand<OutlookView>('outlook_get', { query: tauriQuery(query) });
	return httpRequest<OutlookView>(`/api/outlook${queryString(query)}`, { method: 'GET' });
}

export async function listSnapshots(): Promise<SnapshotInfo[]> {
	guard();
	if (tauri()) return invokeCommand<SnapshotInfo[]>('outlook_snapshots_list');
	return httpRequest<SnapshotInfo[]>('/api/outlook/snapshots', { method: 'GET' });
}

export async function getSnapshot(id: number, query: OutlookQuery = {}): Promise<OutlookView> {
	guard();
	const { from, to } = query;
	if (tauri()) {
		return invokeCommand<OutlookView>('outlook_snapshot_get', {
			id,
			query: tauriQuery({ from, to })
		});
	}
	return httpRequest<OutlookView>(`/api/outlook/snapshots/${id}${queryString({ from, to })}`, {
		method: 'GET'
	});
}

export async function saveSnapshot(label: string): Promise<SnapshotInfo> {
	guard();
	if (tauri()) return invokeCommand<SnapshotInfo>('outlook_snapshot_create', { label });
	return httpRequest<SnapshotInfo>('/api/outlook/snapshots', {
		method: 'POST',
		body: { label }
	});
}
