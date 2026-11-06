import { describe, expect, it } from 'vitest';
import { everyNthIndex } from '../src/core/ticks-time';

describe('everyNthIndex', () => {
	it('returns every index when count fits within maxTicks', () => {
		expect(everyNthIndex(4, 6)).toEqual([0, 1, 2, 3]);
	});

	it('thins out indices when count exceeds maxTicks, always including the last', () => {
		const result = everyNthIndex(100, 5);
		expect(result[0]).toBe(0);
		expect(result[result.length - 1]).toBe(99);
		expect(result.length).toBeLessThanOrEqual(6);
	});

	it('handles count = 0', () => {
		expect(everyNthIndex(0, 5)).toEqual([]);
	});

	it('handles a single data point', () => {
		expect(everyNthIndex(1, 5)).toEqual([0]);
	});

	it('drops the last stepped index when it would collide with the final index', () => {
		// count=31, maxTicks=4 -> step=8 -> stepped [0,8,16,24]; 30-24=6 < 8,
		// so 24 yields to the always-labeled final index 30.
		expect(everyNthIndex(31, 4)).toEqual([0, 8, 16, 30]);
	});

	it('always yields a strictly increasing sequence ending at the final index', () => {
		// The stepped loop can never leave a gap of >= step before count-1,
		// so the final index always replaces the too-close stepped one; the
		// resulting invariant is: strictly increasing, ends at count-1.
		const result = everyNthIndex(100, 7);
		for (let i = 1; i < result.length; i++) expect(result[i]).toBeGreaterThan(result[i - 1]);
		expect(result[result.length - 1]).toBe(99);
	});
});
