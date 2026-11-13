import { describe, expect, it } from 'vitest';
import {
	dueLinesKey,
	monthsBetween,
	type RecurringAgreement,
	type RecurringMonthLine
} from './recurringRevenueAdmin';

describe('recurring revenue helpers', () => {
	it('counts the months of a term, both ends included', () => {
		expect(monthsBetween('2026-06', '2027-05')).toBe(12);
		expect(monthsBetween('2026-06', '2026-06')).toBe(1);
	});

	it('gives nothing for an unset or reversed term', () => {
		expect(monthsBetween('2026-06', '')).toBeNull();
		expect(monthsBetween('2026-06', '2026-05')).toBeNull();
		expect(monthsBetween('2026-6', '2027-05')).toBeNull();
	});

	function line(id: number, open: number, state: RecurringMonthLine['state'] = 'due') {
		const agreement = { id, projectId: id * 10, rowVersion: 1 } as RecurringAgreement;
		return { agreement, state, planned: open, open };
	}

	it('compares the due agreements and amounts, not only their count', () => {
		const shown = { lines: [line(1, 200_000), line(2, 300_000), line(3, 0, 'recognized')] };
		expect(dueLinesKey(shown)).toBe(dueLinesKey({ lines: [line(2, 300_000), line(1, 200_000)] }));
		expect(dueLinesKey(shown)).not.toBe(
			dueLinesKey({ lines: [line(1, 200_000), line(4, 300_000)] })
		);
		expect(dueLinesKey(shown)).not.toBe(
			dueLinesKey({ lines: [line(1, 200_000), line(2, 250_000)] })
		);
	});
});
