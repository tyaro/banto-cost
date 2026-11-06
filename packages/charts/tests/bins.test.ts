import { describe, expect, it } from 'vitest';
import { histogramBins, normalCurvePoints } from '../src/core/bins';

describe('histogramBins', () => {
	it('handles an empty array', () => {
		expect(histogramBins([])).toEqual([]);
	});

	it('drops NaN/Infinity before binning', () => {
		const bins = histogramBins([1, 2, NaN, 3, Infinity, -Infinity, 4]);
		const total = bins.reduce((sum, b) => sum + b.count, 0);
		expect(total).toBe(4);
	});

	it('fabricates a single padded bin for all-equal values (degenerate domain)', () => {
		const bins = histogramBins([5, 5, 5]);
		expect(bins).toHaveLength(1);
		expect(bins[0].count).toBe(3);
		expect(bins[0].x0).toBeLessThan(5);
		expect(bins[0].x1).toBeGreaterThan(5);
	});

	it('fabricates a padded bin around 0 for all-zero values (0 needs special padding, not *0.5)', () => {
		const bins = histogramBins([0, 0]);
		expect(bins).toHaveLength(1);
		expect(bins[0].count).toBe(2);
		expect(bins[0].x0).toBeLessThan(0);
		expect(bins[0].x1).toBeGreaterThan(0);
	});

	it('honors an explicit binCount and every value falls into exactly one bin', () => {
		const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		const bins = histogramBins(values, { binCount: 5 });
		expect(bins).toHaveLength(5);
		const total = bins.reduce((sum, b) => sum + b.count, 0);
		expect(total).toBe(values.length);
		expect(bins[0].x0).toBeLessThanOrEqual(0);
		expect(bins[bins.length - 1].x1).toBeGreaterThanOrEqual(9);
	});

	it('bin edges are non-decreasing and contiguous', () => {
		const values = [3, 7, 1, 9, 4, 4, 4, 2, 8, 6, 5, 0, 12, 15, 3];
		const bins = histogramBins(values);
		for (let i = 1; i < bins.length; i++) {
			expect(bins[i].x0).toBeCloseTo(bins[i - 1].x1, 9);
		}
	});

	it('auto-computes a bin count when none is given, covering every finite value', () => {
		const values = Array.from({ length: 50 }, (_, i) => i);
		const bins = histogramBins(values);
		expect(bins.length).toBeGreaterThan(1);
		const total = bins.reduce((sum, b) => sum + b.count, 0);
		expect(total).toBe(50);
	});

	it('restricts binning to opts.domain, dropping out-of-domain values', () => {
		const bins = histogramBins([1, 2, 3, 4, 5, 100], { domain: [1, 5] });
		const total = bins.reduce((sum, b) => sum + b.count, 0);
		expect(total).toBe(5);
	});

	it('returns [] when no values fall inside opts.domain', () => {
		expect(histogramBins([1, 2, 3], { domain: [10, 20] })).toEqual([]);
	});

	it('treats a reversed domain as swapped (order-independent, like niceTicks)', () => {
		const forward = histogramBins([1, 2, 3, 4, 5], { domain: [1, 5], binCount: 2 });
		const reversed = histogramBins([1, 2, 3, 4, 5], { domain: [5, 1], binCount: 2 });
		expect(reversed).toEqual(forward);
	});
});

describe('normalCurvePoints', () => {
	it('returns [] for stdDev <= 0', () => {
		expect(normalCurvePoints(0, 0, [-1, 1])).toEqual([]);
		expect(normalCurvePoints(0, -1, [-1, 1])).toEqual([]);
	});

	it('defaults to 64 samples', () => {
		expect(normalCurvePoints(0, 1, [-1, 1])).toHaveLength(64);
	});

	it('samples evenly across the domain, endpoints included', () => {
		const points = normalCurvePoints(0, 1, [-3, 3], 7);
		expect(points).toHaveLength(7);
		expect(points[0].x).toBeCloseTo(-3, 9);
		expect(points[6].x).toBeCloseTo(3, 9);
		expect(points[3].x).toBeCloseTo(0, 9);
	});

	it('peaks at the mean and is symmetric around it', () => {
		const points = normalCurvePoints(0, 1, [-3, 3], 7);
		const peak = points[3].y;
		expect(peak).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 9);
		expect(points[0].y).toBeCloseTo(points[6].y, 9);
		expect(points[0].y).toBeLessThan(peak);
	});

	it('treats a reversed domain as swapped', () => {
		const forward = normalCurvePoints(0, 1, [-3, 3], 7);
		const reversed = normalCurvePoints(0, 1, [3, -3], 7);
		expect(reversed).toEqual(forward);
	});

	it('floors a non-integer/low samples count to at least 2 points', () => {
		expect(normalCurvePoints(0, 1, [-1, 1], 0)).toHaveLength(2);
		expect(normalCurvePoints(0, 1, [-1, 1], 1)).toHaveLength(2);
	});
});
