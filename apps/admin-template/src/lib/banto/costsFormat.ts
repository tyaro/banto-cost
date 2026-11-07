/**
 * banto-cost P4d display rules of the direct-cost screens: labels of record
 * kinds, adjustments and tax kinds, the yen input (whole yen, no sign - a
 * reduction is an adjustment, never a negative amount), the allocation
 * remainder and the month range of the own list.
 */
import * as m from '#lib/paraglide/messages.js';
import type { AdjustmentKind, DirectCost, EntryKind, TaxKind } from './costsAdmin';

const KIND: Record<EntryKind, () => string> = {
	normal: () => m['costs.kind.normal'](),
	provisional: () => m['costs.kind.provisional'](),
	confirms: () => m['costs.kind.confirms'](),
	adjustment: () => m['costs.kind.adjustment']()
};

const ADJUSTMENT: Record<AdjustmentKind, () => string> = {
	return: () => m['costs.adjustment.return'](),
	cancel: () => m['costs.adjustment.cancel'](),
	discount: () => m['costs.adjustment.discount']()
};

const TAX: Record<TaxKind, () => string> = {
	standard: () => m['costs.tax.standard'](),
	reduced: () => m['costs.tax.reduced'](),
	exempt: () => m['costs.tax.exempt'](),
	out_of_scope: () => m['costs.tax.outOfScope']()
};

/** The record's kind; an adjustment names its kind (返品・取消・値引き). */
export function kindLabel(cost: Pick<DirectCost, 'entryKind' | 'adjustmentKind'>): string {
	if (cost.entryKind === 'adjustment' && cost.adjustmentKind) {
		return ADJUSTMENT[cost.adjustmentKind]?.() ?? cost.adjustmentKind;
	}
	return KIND[cost.entryKind]?.() ?? cost.entryKind;
}

export function adjustmentLabel(kind: string): string {
	return ADJUSTMENT[kind as AdjustmentKind]?.() ?? kind;
}

/** Tax kind; `null` = 未設定. */
export function taxLabel(kind: string | null): string {
	if (!kind) return m['cost.unset']();
	return TAX[kind as TaxKind]?.() ?? kind;
}

/** `"12,000"` / `"12000"` → 12000. Blank, negative, decimal or not a number → `null`. */
export function parseYen(text: string): number | null {
	const t = text.trim().replace(/[,，¥￥円\s]/g, '');
	if (!/^\d+$/.test(t)) return null;
	const n = Number(t);
	return Number.isSafeInteger(n) ? n : null;
}

/** The signed amount a record adds to the cost (an adjustment reduces it). */
export function signedAmount(cost: Pick<DirectCost, 'entryKind' | 'amount'>): number {
	return cost.entryKind === 'adjustment' ? -cost.amount : cost.amount;
}

/** What is left to allocate: the amount minus the allocated lines (blank lines count 0). */
export function allocationRest(amount: number | null, lines: (number | null)[]): number | null {
	if (amount === null) return null;
	return amount - lines.reduce<number>((sum, v) => sum + (v ?? 0), 0);
}

/** The first and last day of the month `YYYY-MM`. */
export function monthRange(month: string): { from: string; to: string } {
	const [y, mo] = month.split('-').map(Number);
	const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
	return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** The month before / after `YYYY-MM`. */
export function shiftMonth(month: string, delta: number): string {
	const [y, mo] = month.split('-').map(Number);
	const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
