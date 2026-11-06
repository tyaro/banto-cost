import { describe, expect, it } from 'vitest';
import { mergeExtent } from '../src/core/extent';
import { niceTicks } from '../src/core/scale';

const NONE: [number, number] = [Infinity, -Infinity];

describe('mergeExtent', () => {
	it('returns the data extent unchanged without includeY', () => {
		const e: [number, number] = [2, 5];
		expect(mergeExtent(e)).toBe(e);
		expect(mergeExtent(e, [])).toBe(e);
	});

	it('widens a lone 0.5 to 0..1 so the ticks contain 0 and 1 (#554)', () => {
		const ext = mergeExtent([0.5, 0.5], [0, 1]);
		expect(ext).toEqual([0, 1]);
		expect(niceTicks(ext[0], ext[1], 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
		// without includeY the ticks would be 0.2..0.8 (no 0 / 1)
		expect(niceTicks(0.5, 0.5, 5)).not.toContain(0);
	});

	it('is identical to no includeY when the data already spans the values', () => {
		const withInc = mergeExtent([0, 1], [0, 1]);
		expect(niceTicks(withInc[0], withInc[1], 5)).toEqual(niceTicks(0, 1, 5));
	});

	it('does not shrink a wider data extent', () => {
		expect(mergeExtent([-3, 9], [0, 1])).toEqual([-3, 9]);
	});

	it('builds the extent from includeY alone when there is no finite data', () => {
		expect(mergeExtent(NONE, [0, 1])).toEqual([0, 1]);
	});

	it('ignores non-finite entries', () => {
		expect(mergeExtent([0.5, 0.5], [NaN, Infinity, -Infinity, 1])).toEqual([0.5, 1]);
		const e: [number, number] = [2, 5];
		expect(mergeExtent(e, [NaN, Infinity])).toBe(e);
		// no data and only junk includes: stays non-finite so callers see "empty"
		expect(Number.isFinite(mergeExtent(NONE, [NaN])[0])).toBe(false);
	});
});
