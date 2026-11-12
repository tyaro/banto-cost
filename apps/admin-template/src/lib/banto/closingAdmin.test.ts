import { describe, expect, it } from 'vitest';
import { previousMonth } from './closingAdmin';

describe('previousMonth', () => {
	it('is the month before today, across the year end', () => {
		expect(previousMonth('2026-11-07')).toBe('2026-10');
		expect(previousMonth('2027-01-15')).toBe('2026-12');
	});
});
