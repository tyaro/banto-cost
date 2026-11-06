import { describe, expect, it } from 'vitest';
import { boxStats, quantileSorted } from '../src/core/boxplot';

describe('quantileSorted', () => {
	it('returns min/median/max at p=0/0.5/1', () => {
		const sorted = [1, 2, 3, 4, 5];
		expect(quantileSorted(sorted, 0)).toBe(1);
		expect(quantileSorted(sorted, 0.5)).toBe(3);
		expect(quantileSorted(sorted, 1)).toBe(5);
	});

	it('interpolates linearly (R-7) between ranks', () => {
		// n=4, p=0.25 -> rank = 0.25*3 = 0.75 -> between index 0 and 1.
		expect(quantileSorted([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 9);
	});

	it('returns the single element for any p on a one-element array', () => {
		expect(quantileSorted([42], 0)).toBe(42);
		expect(quantileSorted([42], 0.5)).toBe(42);
		expect(quantileSorted([42], 1)).toBe(42);
	});

	it('returns NaN for an empty array', () => {
		expect(Number.isNaN(quantileSorted([], 0.5))).toBe(true);
	});

	it('clamps an out-of-range p instead of extrapolating', () => {
		const sorted = [1, 2, 3];
		expect(quantileSorted(sorted, -1)).toBe(1);
		expect(quantileSorted(sorted, 2)).toBe(3);
	});
});

describe('boxStats', () => {
	it('returns null for an empty array', () => {
		expect(boxStats([])).toBeNull();
	});

	it('returns null when every value is non-finite', () => {
		expect(boxStats([NaN, Infinity, -Infinity])).toBeNull();
	});

	it('drops non-finite values before computing the summary', () => {
		const stats = boxStats([1, 2, 3, NaN, 4, 5]);
		expect(stats?.min).toBe(1);
		expect(stats?.max).toBe(5);
	});

	it('computes the five-number summary for a simple dataset', () => {
		const stats = boxStats([1, 2, 3, 4, 5]);
		expect(stats).not.toBeNull();
		expect(stats?.min).toBe(1);
		expect(stats?.median).toBe(3);
		expect(stats?.max).toBe(5);
	});

	it('has no outliers and whiskers at min/max when there are none beyond the fence', () => {
		const stats = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(stats?.outliers).toEqual([]);
		expect(stats?.whiskerLow).toBe(stats?.min);
		expect(stats?.whiskerHigh).toBe(stats?.max);
	});

	it('flags values beyond 1.5*IQR as outliers, whiskers stop at the last in-fence value', () => {
		const stats = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
		expect(stats).not.toBeNull();
		expect(stats?.outliers).toContain(100);
		expect(stats?.whiskerHigh).toBeLessThan(100);
	});

	it('handles a single value (min=q1=median=q3=max, no outliers)', () => {
		const stats = boxStats([7]);
		expect(stats).toEqual({
			min: 7,
			q1: 7,
			median: 7,
			q3: 7,
			max: 7,
			whiskerLow: 7,
			whiskerHigh: 7,
			outliers: []
		});
	});

	it('handles all-equal values without producing outliers', () => {
		const stats = boxStats([5, 5, 5, 5]);
		expect(stats?.outliers).toEqual([]);
		expect(stats?.whiskerLow).toBe(5);
		expect(stats?.whiskerHigh).toBe(5);
	});
});
