/**
 * banto-cost P4c display rules of the budget section: cost-type labels, the
 * planned hours input (hours with up to two decimals → whole minutes) and a
 * version's label (版1 = 当初予算).
 */
import * as m from '#lib/paraglide/messages.js';
import type { CostType } from './budgetAdmin';

const COST_TYPE: Record<CostType, () => string> = {
	labor: () => m['budget.costType.labor'](),
	material: () => m['budget.costType.material'](),
	outsource: () => m['budget.costType.outsource'](),
	travel: () => m['budget.costType.travel'](),
	other: () => m['budget.costType.other']()
};

export function costTypeLabel(t: string): string {
	return COST_TYPE[t as CostType]?.() ?? t;
}

/** `"7.5"` hours → 450 minutes. Blank, negative or not a number → `null`. */
export function hoursToMinutes(hours: string): number | null {
	const text = hours.trim();
	if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
	return Math.round(Number(text) * 60);
}

/** 450 minutes → `"7.5"` for the hours input. */
export function minutesToHours(minutes: number | null): string {
	if (minutes === null) return '';
	return String(Math.round((minutes / 60) * 100) / 100);
}

/** 版1 is the original budget (当初予算), the rest are changes. */
export function versionLabel(versionNo: number | null): string {
	if (versionNo === null) return m['budget.draft']();
	if (versionNo === 1) return m['budget.versionOriginal']({ no: versionNo });
	return m['budget.versionChange']({ no: versionNo });
}
