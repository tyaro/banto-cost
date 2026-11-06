import { describe, expect, it } from 'vitest';
import { paretoData } from '../src/core/pareto';

describe('paretoData', () => {
	it('sorts items descending by value', () => {
		const result = paretoData([
			{ label: 'a', value: 10 },
			{ label: 'b', value: 50 },
			{ label: 'c', value: 30 }
		]);
		expect(result.map((d) => d.label)).toEqual(['b', 'c', 'a']);
	});

	it('accumulates running totals in sorted order', () => {
		const result = paretoData([
			{ label: 'a', value: 10 },
			{ label: 'b', value: 50 },
			{ label: 'c', value: 30 }
		]);
		expect(result.map((d) => d.cumulative)).toEqual([50, 80, 90]);
	});

	it('computes cumulative percent of the total (last item reaches ~100%)', () => {
		const result = paretoData([
			{ label: 'a', value: 25 },
			{ label: 'b', value: 75 }
		]);
		expect(result[0].cumulativePercent).toBeCloseTo(75, 6);
		expect(result[1].cumulativePercent).toBeCloseTo(100, 6);
	});

	it('handles an empty input', () => {
		expect(paretoData([])).toEqual([]);
	});

	it('reports 0 percent for a non-positive total instead of NaN/Infinity', () => {
		const result = paretoData([
			{ label: 'a', value: -5 },
			{ label: 'b', value: 5 }
		]);
		expect(result.every((d) => d.cumulativePercent === 0)).toBe(true);
	});

	it('keeps negative values as-is in cumulative sums (no clamping to 0)', () => {
		const result = paretoData([
			{ label: 'a', value: 10 },
			{ label: 'b', value: -3 }
		]);
		const b = result.find((d) => d.label === 'b');
		expect(b?.value).toBe(-3);
		expect(b?.cumulative).toBe(7);
	});

	it('keeps the original relative order for tied values (stable sort)', () => {
		const result = paretoData([
			{ label: 'first', value: 10 },
			{ label: 'second', value: 10 }
		]);
		expect(result.map((d) => d.label)).toEqual(['first', 'second']);
	});
});
