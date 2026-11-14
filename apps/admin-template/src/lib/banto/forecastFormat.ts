/**
 * banto-cost P5 display rules of the completion forecast and the overall
 * list: profit ratios in permille (27.5%, 分母0は算出不可), the alert and
 * 見込更新要 labels, a version's label. Labels resolve through Paraglide at
 * call time (conventions §13).
 */
import * as m from '#lib/paraglide/messages.js';

/** 275 → `27.5%`; `null` (denominator 0 or unknown) → 算出不可. */
export function formatPermille(value: number | null | undefined): string {
	if (value === null || value === undefined) return m['forecast.notComputable']();
	const sign = value < 0 ? '-' : '';
	const abs = Math.abs(value);
	return `${sign}${Math.floor(abs / 10)}.${abs % 10}%`;
}

const ALERTS: Record<string, () => string> = {
	order_month_passed: () => m['alerts.orderMonthPassed'](),
	review_overdue: () => m['alerts.reviewOverdue'](),
	pipeline_unset: () => m['alerts.pipelineUnset'](),
	forecast_loss: () => m['alerts.forecastLoss'](),
	forecast_over_budget: () => m['alerts.forecastOverBudget'](),
	low_margin: () => m['alerts.lowMargin'](),
	forecast_over_funds: () => m['alerts.forecastOverFunds'](),
	unapproved: () => m['alerts.unapproved'](),
	pending_addition: () => m['alerts.pendingAddition'](),
	forecast_update_needed: () => m['alerts.forecastUpdateNeeded'](),
	no_forecast: () => m['alerts.noForecast'](),
	open_commitment: () => m['alerts.openCommitment'](),
	ledger_review: () => m['alerts.ledgerReview']()
};

/** `cost_domain::alerts::Alert` code → label; an unknown code is shown as-is. */
export function alertLabel(code: string): string {
	return ALERTS[code]?.() ?? code;
}

/** Alerts that call for action first (red); the rest are cautions. */
export function isSevereAlert(code: string): boolean {
	return code === 'forecast_loss' || code === 'forecast_over_budget' || code === 'ledger_review';
}

const REASONS: Record<string, () => string> = {
	actual_after_base: () => m['forecast.reason.actualAfterBase'](),
	actual_corrected: () => m['forecast.reason.actualCorrected'](),
	rate_changed: () => m['forecast.reason.rateChanged'](),
	order_changed: () => m['forecast.reason.orderChanged']()
};

/** `cost_domain::forecast::UpdateReason` code → label. */
export function updateReasonLabel(code: string): string {
	return REASONS[code]?.() ?? code;
}

export function forecastVersionLabel(versionNo: number | null): string {
	if (versionNo === null) return m['forecast.draft']();
	return m['forecast.version']({ no: versionNo });
}

const LEDGER_REASONS: Record<string, () => string> = {
	invalid_amount: () => m['ledger.reason.invalidAmount'](),
	duplicate_id: () => m['ledger.reason.duplicateId'](),
	unknown_reference: () => m['ledger.reason.unknownReference'](),
	invalid_target: () => m['ledger.reason.invalidTarget'](),
	confirmed_twice: () => m['ledger.reason.confirmedTwice'](),
	adjustment_exceeds_original: () => m['ledger.reason.adjustmentExceedsOriginal'](),
	allocation_mismatch: () => m['ledger.reason.allocationMismatch'](),
	allocation_of_invalid_source: () => m['ledger.reason.allocationOfInvalidSource'](),
	unassigned: () => m['ledger.reason.unassigned'](),
	related: () => m['ledger.reason.related']()
};

const LEDGER_COLUMNS: Record<string, () => string> = {
	entry_kind: () => m['ledger.column.entryKind'](),
	ref_id: () => m['ledger.column.refId'](),
	adjustment_kind: () => m['ledger.column.adjustmentKind'](),
	cost_type: () => m['ledger.column.costType'](),
	booked_on: () => m['ledger.column.bookedOn']()
};

/** A record left out of the direct-cost ledger (T39): `明細ID 12` / `月額固定の計上ID 3`. */
export function ledgerRecordLabel(p: { source: string; id: number }): string {
	return p.source === 'fixed_cost'
		? m['ledger.source.fixedCost']({ id: p.id })
		: m['ledger.source.directCost']({ id: p.id });
}

/** Why the record was left out; an unknown code is shown as-is. */
export function ledgerReasonLabel(p: { code: string; column: string | null }): string {
	if (p.code === 'unreadable') {
		const column = p.column ?? '';
		return m['ledger.reason.unreadable']({ column: LEDGER_COLUMNS[column]?.() ?? column });
	}
	return LEDGER_REASONS[p.code]?.() ?? p.code;
}
