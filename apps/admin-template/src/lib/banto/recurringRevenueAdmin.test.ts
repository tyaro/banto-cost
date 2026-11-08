import { describe, expect, it } from 'vitest';
import { monthsBetween } from './recurringRevenueAdmin';

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
});
