/** banto-cost P4d display rules of the direct-cost screens. */
import { describe, expect, it } from 'vitest';
import * as m from '#lib/paraglide/messages.js';
import {
	allocationRest,
	kindLabel,
	monthRange,
	parseYen,
	shiftMonth,
	signedAmount,
	taxLabel
} from './costsFormat';

describe('costsFormat', () => {
	it('parses whole yen and refuses signs and decimals', () => {
		expect(parseYen('12,000')).toBe(12_000);
		expect(parseYen(' ¥300000 ')).toBe(300_000);
		expect(parseYen('0')).toBe(0);
		expect(parseYen('-1')).toBeNull();
		expect(parseYen('1.5')).toBeNull();
		expect(parseYen('')).toBeNull();
	});

	it('labels kinds, adjustments and tax kinds', () => {
		expect(kindLabel({ entryKind: 'provisional', adjustmentKind: null })).toBe(
			m['costs.kind.provisional']()
		);
		expect(kindLabel({ entryKind: 'adjustment', adjustmentKind: 'return' })).toBe(
			m['costs.adjustment.return']()
		);
		expect(taxLabel(null)).toBe(m['cost.unset']());
		expect(taxLabel('reduced')).toBe(m['costs.tax.reduced']());
	});

	it('signs adjustments and keeps the allocation remainder (T10)', () => {
		expect(signedAmount({ entryKind: 'adjustment', amount: 20_000 })).toBe(-20_000);
		expect(signedAmount({ entryKind: 'normal', amount: 20_000 })).toBe(20_000);
		expect(allocationRest(30_000, [18_000, 12_000])).toBe(0);
		expect(allocationRest(30_000, [18_000, null])).toBe(12_000);
		expect(allocationRest(null, [1])).toBeNull();
	});

	it('walks months', () => {
		expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
		expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
		expect(shiftMonth('2026-12', 1)).toBe('2027-01');
		expect(shiftMonth('2026-01', -1)).toBe('2025-12');
	});
});
