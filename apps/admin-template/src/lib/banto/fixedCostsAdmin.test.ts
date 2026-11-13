import { describe, expect, it } from 'vitest';
import {
	currentMonth,
	dueLinesKey,
	termLabel,
	type FixedCostContract,
	type FixedCostMonthLine
} from './fixedCostsAdmin';

describe('fixed costs helpers', () => {
	it('shows an open end with an empty end month', () => {
		expect(termLabel({ fromMonth: '2026-06', toMonth: null })).toBe('2026-06〜');
		expect(termLabel({ fromMonth: '2026-06', toMonth: '2027-05' })).toBe('2026-06〜2027-05');
	});

	it('posts this month by default', () => {
		expect(currentMonth('2026-11-07')).toBe('2026-11');
		expect(currentMonth('2027-01-01')).toBe('2027-01');
	});

	function line(id: number, monthlyAmount: number, state: FixedCostMonthLine['state'] = 'due') {
		const contract = {
			id,
			projectId: 10,
			payeeKind: 'vendor',
			userId: null,
			vendorId: 3,
			monthlyAmount,
			rowVersion: 1
		} as FixedCostContract;
		return { contract, state, posting: null };
	}

	it('compares the due contracts and amounts, not only their count', () => {
		const shown = { lines: [line(1, 100_000), line(2, 50_000), line(3, 9, 'posted')] };
		expect(dueLinesKey(shown)).toBe(dueLinesKey({ lines: [line(2, 50_000), line(1, 100_000)] }));
		// Same count, another contract or amount: changed.
		expect(dueLinesKey(shown)).not.toBe(
			dueLinesKey({ lines: [line(1, 100_000), line(4, 50_000)] })
		);
		expect(dueLinesKey(shown)).not.toBe(
			dueLinesKey({ lines: [line(1, 100_000), line(2, 60_000)] })
		);
	});
});
