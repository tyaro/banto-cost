import { describe, expect, it } from 'vitest';
import { currentMonth, termLabel } from './fixedCostsAdmin';

describe('fixed costs helpers', () => {
	it('shows an open end with an empty end month', () => {
		expect(termLabel({ fromMonth: '2026-06', toMonth: null })).toBe('2026-06〜');
		expect(termLabel({ fromMonth: '2026-06', toMonth: '2027-05' })).toBe('2026-06〜2027-05');
	});

	it('posts this month by default', () => {
		expect(currentMonth(new Date(2026, 10, 7))).toBe('2026-11');
		expect(currentMonth(new Date(2027, 0, 1))).toBe('2027-01');
	});
});
