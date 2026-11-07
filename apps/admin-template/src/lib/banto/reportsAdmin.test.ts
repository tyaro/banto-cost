import { describe, expect, it } from 'vitest';
import { periodOf } from './reportsAdmin';

describe('periodOf', () => {
	it('starts a period in June (第13期 = 2026年6月〜2027年5月)', () => {
		expect(periodOf(new Date(2026, 5, 1))).toBe(13);
		expect(periodOf(new Date(2027, 4, 31))).toBe(13);
		expect(periodOf(new Date(2027, 5, 1))).toBe(14);
		expect(periodOf(new Date(2026, 4, 31))).toBe(12);
	});
});
