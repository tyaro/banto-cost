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
	unapproved: () => m['alerts.unapproved'](),
	pending_addition: () => m['alerts.pendingAddition'](),
	forecast_update_needed: () => m['alerts.forecastUpdateNeeded'](),
	no_forecast: () => m['alerts.noForecast'](),
	open_commitment: () => m['alerts.openCommitment']()
};

/** `cost_domain::alerts::Alert` code → label; an unknown code is shown as-is. */
export function alertLabel(code: string): string {
	return ALERTS[code]?.() ?? code;
}

/** Alerts that call for action first (red); the rest are cautions. */
export function isSevereAlert(code: string): boolean {
	return code === 'forecast_loss' || code === 'forecast_over_budget';
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
