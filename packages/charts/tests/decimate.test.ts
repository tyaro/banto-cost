import { describe, expect, it } from 'vitest';
import { decimatedIndices, decimationStride } from '../src/core/decimate';

describe('decimationStride', () => {
	it('is 1 when the run already fits under the target', () => {
		expect(decimationStride(100, 200)).toBe(1);
		expect(decimationStride(200, 200)).toBe(1);
	});

	it('grows the stride when there are more points than the target', () => {
		expect(decimationStride(1000, 100)).toBe(10);
		expect(decimationStride(10000, 800)).toBe(13); // ceil(10000/800)
	});

	it('is 1 for a non-positive target rather than dividing by zero', () => {
		expect(decimationStride(1000, 0)).toBe(1);
		expect(decimationStride(1000, -5)).toBe(1);
	});
});

describe('decimatedIndices', () => {
	it('returns the whole contiguous window when no decimation is needed', () => {
		expect(decimatedIndices(2, 6, 100)).toEqual([2, 3, 4, 5, 6]);
	});

	it('returns [] for an empty window', () => {
		expect(decimatedIndices(5, 4, 100)).toEqual([]);
	});

	it('returns a single index for a one-point window', () => {
		expect(decimatedIndices(3, 3, 100)).toEqual([3]);
	});

	it('keeps every stride-th index and always the two endpoints', () => {
		// 11 points [0..10], target 4 -> stride ceil(11/4)=3 -> 0,3,6,9 then 10.
		expect(decimatedIndices(0, 10, 4)).toEqual([0, 3, 6, 9, 10]);
	});

	it('does not duplicate the last index when the stride lands on it', () => {
		// 9 points [0..8], target 3 -> stride ceil(9/3)=3 -> 0,3,6 then 8 (6<8, no dup).
		expect(decimatedIndices(0, 8, 3)).toEqual([0, 3, 6, 8]);
		// 7 points [0..6], stride 3 -> 0,3 then 6 (the strided 6 is skipped by i<hi).
		expect(decimatedIndices(0, 6, 3)).toEqual([0, 3, 6]);
	});

	it('anchors the first and last index for an offset window', () => {
		const out = decimatedIndices(100, 10100, 800);
		expect(out[0]).toBe(100);
		expect(out[out.length - 1]).toBe(10100);
		// Reduced from 10001 points to roughly the target, not the full run.
		expect(out.length).toBeLessThan(900);
		expect(out.length).toBeGreaterThan(700);
	});

	it('keeps output x-monotonic (strictly increasing)', () => {
		const out = decimatedIndices(0, 9999, 500);
		for (let i = 1; i < out.length; i++) {
			expect(out[i]).toBeGreaterThan(out[i - 1]);
		}
	});
});
