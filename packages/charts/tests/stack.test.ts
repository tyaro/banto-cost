import { describe, expect, it } from 'vitest';
import { stackSeries } from '../src/core/stack';

describe('stackSeries', () => {
	it('stacks positive values upward from 0 per category', () => {
		const result = stackSeries([
			[10, 20, 5],
			[1, 2, 3]
		]);
		expect(result[0]).toEqual([
			{ seriesIndex: 0, value: 10, start: 0, end: 10 },
			{ seriesIndex: 1, value: 20, start: 10, end: 30 },
			{ seriesIndex: 2, value: 5, start: 30, end: 35 }
		]);
		expect(result[1]).toEqual([
			{ seriesIndex: 0, value: 1, start: 0, end: 1 },
			{ seriesIndex: 1, value: 2, start: 1, end: 3 },
			{ seriesIndex: 2, value: 3, start: 3, end: 6 }
		]);
	});

	it('treats a zero value as a zero-height segment at the current offset (not dropped)', () => {
		const result = stackSeries([[10, 0, 5]]);
		expect(result[0][1]).toEqual({ seriesIndex: 1, value: 0, start: 10, end: 10 });
		expect(result[0][2]).toEqual({ seriesIndex: 2, value: 5, start: 10, end: 15 });
	});

	it('treats a NaN value as 0 (does not break the running offset or the index alignment)', () => {
		const result = stackSeries([[10, NaN, 5]]);
		expect(result[0][1]).toEqual({ seriesIndex: 1, value: 0, start: 10, end: 10 });
		expect(result[0][2].start).toBe(10);
		expect(result[0][2].end).toBe(15);
	});

	it('stacks negative values downward from 0, independent of the positive stack', () => {
		const result = stackSeries([[10, -5, -3, 2]]);
		expect(result[0][0]).toEqual({ seriesIndex: 0, value: 10, start: 0, end: 10 });
		expect(result[0][1]).toEqual({ seriesIndex: 1, value: -5, start: -5, end: 0 });
		expect(result[0][2]).toEqual({ seriesIndex: 2, value: -3, start: -8, end: -5 });
		expect(result[0][3]).toEqual({ seriesIndex: 3, value: 2, start: 10, end: 12 });
	});

	it('handles an empty matrix', () => {
		expect(stackSeries([])).toEqual([]);
	});

	it('handles a single-series matrix (no visible stacking, but still offset from 0)', () => {
		const result = stackSeries([[7], [0], [3]]);
		expect(result).toEqual([
			[{ seriesIndex: 0, value: 7, start: 0, end: 7 }],
			[{ seriesIndex: 0, value: 0, start: 0, end: 0 }],
			[{ seriesIndex: 0, value: 3, start: 0, end: 3 }]
		]);
	});
});
