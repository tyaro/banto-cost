import { describe, expect, it } from 'vitest';
import { previousMonth } from './closingAdmin';

describe('previousMonth', () => {
	it('is the month before today, across the year end', () => {
		expect(previousMonth(new Date(2026, 10, 7))).toBe('2026-10');
		expect(previousMonth(new Date(2027, 0, 15))).toBe('2026-12');
	});
});
