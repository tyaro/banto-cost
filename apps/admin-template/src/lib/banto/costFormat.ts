/**
 * Display helpers shared by the banto-cost screens (customers / projects /
 * pipeline). Amounts are integer yen and percentages integer points; an
 * unset value (`null`) is always shown as 未設定, never as 0 (banto-cost
 * CLAUDE.md, spec §5.4). Labels resolve through Paraglide at call time
 * (conventions §13), so call these from render code, not at module load.
 */
import { isProviderError } from '@banto/admin-core';
import * as m from '#lib/paraglide/messages.js';

/** True when `err` is the server refusing the caller's capability / project scope (design 第2章). */
export function isForbiddenError(err: unknown): boolean {
	return isProviderError(err) && err.body.kind === 'forbidden';
}

export function formatYen(value: number | null | undefined): string {
	if (value === null || value === undefined) return m['cost.unset']();
	return `¥${value.toLocaleString()}`;
}

export function formatPct(value: number | null | undefined): string {
	if (value === null || value === undefined) return m['cost.unset']();
	return `${value}%`;
}

/** A `YYYY-MM` / `YYYY-MM-DD` text, or 未設定 when absent. */
export function formatOptional(value: string | null | undefined): string {
	return value ? value : m['cost.unset']();
}

const STATUS_LABELS: Record<string, () => string> = {
	lead: () => m['projects.status.lead'](),
	quoting: () => m['projects.status.quoting'](),
	negotiating: () => m['projects.status.negotiating'](),
	ordered: () => m['projects.status.ordered'](),
	in_progress: () => m['projects.status.inProgress'](),
	work_done: () => m['projects.status.workDone'](),
	settled: () => m['projects.status.settled'](),
	lost: () => m['projects.status.lost'](),
	cancelled: () => m['projects.status.cancelled'](),
	on_hold: () => m['projects.status.onHold']()
};

/** Project status label; an unknown code is shown as-is. */
export function statusLabel(status: string): string {
	return STATUS_LABELS[status]?.() ?? status;
}

const STAGE_LABELS: Record<string, () => string> = {
	lead: () => m['pipeline.stage.lead'](),
	quoting: () => m['pipeline.stage.quoting'](),
	negotiating: () => m['pipeline.stage.negotiating'](),
	informal: () => m['pipeline.stage.informal'](),
	ordered: () => m['projects.status.ordered'](),
	lost: () => m['projects.status.lost'](),
	cancelled: () => m['projects.status.cancelled'](),
	on_hold: () => m['projects.status.onHold']()
};

/** Sales-stage label (`null` = no adopted version yet -> 未設定). */
export function stageLabel(stage: string | null | undefined): string {
	if (!stage) return m['cost.unset']();
	return STAGE_LABELS[stage]?.() ?? stage;
}

const ISSUE_LABELS: Record<string, () => string> = {
	amount_missing: () => m['pipeline.issue.amountMissing'](),
	probability_missing: () => m['pipeline.issue.probabilityMissing'](),
	order_month_missing: () => m['pipeline.issue.orderMonthMissing'](),
	plan_missing: () => m['pipeline.issue.planMissing'](),
	plan_mismatch: () => m['pipeline.issue.planMismatch'](),
	no_adopted_version: () => m['pipeline.issue.noAdoptedVersion']()
};

/** Localized label of a pipeline issue code; an unknown code is shown as-is. */
export function issueLabel(issue: string): string {
	return ISSUE_LABELS[issue]?.() ?? issue;
}

const REVENUE_ISSUE_LABELS: Record<string, () => string> = {
	over_recognized: () => m['orders.issue.overRecognized'](),
	plan_mismatch: () => m['orders.issue.planMismatch'](),
	over_cleared: () => m['orders.issue.overCleared'](),
	clearing_exceeds_sale: () => m['orders.issue.clearingExceedsSale'](),
	unknown_plan: () => m['orders.issue.unknownPlan'](),
	invalid_amount: () => m['orders.issue.invalidAmount'](),
	duplicate_plan_month: () => m['orders.issue.duplicatePlanMonth'](),
	unknown_sale: () => m['orders.issue.unknownSale']()
};

/** Localized label of an ordered-revenue issue code (`cost_domain::revenue::RevenueIssue`). */
export function revenueIssueLabel(issue: string): string {
	return REVENUE_ISSUE_LABELS[issue]?.() ?? issue;
}

const CHANGE_STATUS_LABELS: Record<string, () => string> = {
	pending: () => m['orders.changeStatus.pending'](),
	approved: () => m['orders.changeStatus.approved'](),
	rejected: () => m['orders.changeStatus.rejected']()
};

/** Order-change status label (pending = 未確定追加売上). */
export function changeStatusLabel(status: string): string {
	return CHANGE_STATUS_LABELS[status]?.() ?? status;
}

/** A signed yen amount (+¥300,000 / -¥100,000) for order-change deltas and differences. */
export function formatSignedYen(value: number | null | undefined): string {
	if (value === null || value === undefined) return m['cost.unset']();
	if (value > 0) return `+¥${value.toLocaleString()}`;
	if (value < 0) return `-¥${(-value).toLocaleString()}`;
	return '¥0';
}

/**
 * Server field errors that no rendered field shows (e.g. a stale `rowVersion`
 * after someone else saved the record first) - the form pages list these
 * above the form so they are never silently dropped.
 */
export function unmatchedFieldErrors(
	fieldNames: readonly string[],
	fieldErrors: readonly { field: string; message: string }[]
): string[] {
	return fieldErrors.filter((e) => !fieldNames.includes(e.field)).map((e) => e.message);
}
