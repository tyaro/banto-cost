import { describe, expect, it } from 'vitest';
import { arcPath, pieSlices } from '../src/core/pie';

describe('pieSlices', () => {
	it('splits proportionally to values, summing to 360deg total sweep', () => {
		const slices = pieSlices([1, 1, 2]);
		const sweeps = slices.map((s) => s.endAngle - s.startAngle);
		expect(sweeps[0]).toBeCloseTo(90);
		expect(sweeps[1]).toBeCloseTo(90);
		expect(sweeps[2]).toBeCloseTo(180);
		expect(sweeps.reduce((a, b) => a + b, 0)).toBeCloseTo(360);
	});

	it('defaults startAngle to -90 (top of the circle)', () => {
		const [first] = pieSlices([1, 1]);
		expect(first.startAngle).toBe(-90);
	});

	it('honors a custom startAngle', () => {
		const [first] = pieSlices([1, 1], { startAngle: 0 });
		expect(first.startAngle).toBe(0);
	});

	it('slices stay contiguous (each startAngle equals the previous endAngle)', () => {
		const slices = pieSlices([3, 1, 4, 1, 5]);
		for (let i = 1; i < slices.length; i++) {
			expect(slices[i].startAngle).toBeCloseTo(slices[i - 1].endAngle);
		}
	});

	it('handles empty data without dividing by zero', () => {
		expect(pieSlices([])).toEqual([]);
	});

	it('handles all-zero data (degenerates to zero-width slices, index-aligned)', () => {
		const slices = pieSlices([0, 0, 0]);
		expect(slices).toHaveLength(3);
		for (const slice of slices) {
			expect(slice.startAngle).toBe(slice.endAngle);
		}
		expect(slices.map((s) => s.index)).toEqual([0, 1, 2]);
	});

	it('gives negative values a zero sweep but keeps them in the index sequence', () => {
		const slices = pieSlices([10, -5, 10]);
		expect(slices[1].startAngle).toBe(slices[1].endAngle);
		expect(slices.map((s) => s.index)).toEqual([0, 1, 2]);
	});

	it('a single 100% value produces one full-circle slice (360deg sweep)', () => {
		const [only] = pieSlices([42]);
		expect(only.endAngle - only.startAngle).toBeCloseTo(360);
	});
});

describe('arcPath', () => {
	it('produces a moveto+lineto+arc+close path for a pie slice (rInner = 0)', () => {
		const d = arcPath(50, 50, 40, 0, -90, 0);
		expect(d).toMatch(/^M 50 50/);
		expect(d).toContain('A 40 40 0 0 1');
		expect(d.trim().endsWith('Z')).toBe(true);
	});

	it('sets the large-arc-flag to 1 for sweeps > 180deg', () => {
		const d = arcPath(0, 0, 10, 0, 0, 200);
		expect(d).toContain('A 10 10 0 1 1');
	});

	it('sets the large-arc-flag to 0 for sweeps <= 180deg', () => {
		const d = arcPath(0, 0, 10, 0, 0, 90);
		expect(d).toContain('A 10 10 0 0 1');
	});

	it('produces two arcs (outer + inner) for a donut slice (rInner > 0)', () => {
		const d = arcPath(0, 0, 10, 5, 0, 90);
		const arcCount = (d.match(/A /g) ?? []).length;
		expect(arcCount).toBe(2);
		expect(d).toContain('A 10 10');
		expect(d).toContain('A 5 5');
	});

	it('splits a full 360deg sweep into two arcs instead of degenerating', () => {
		const d = arcPath(0, 0, 10, 0, -90, 270);
		const arcCount = (d.match(/A /g) ?? []).length;
		expect(arcCount).toBe(2);
	});

	it('returns empty string for a zero or negative sweep', () => {
		expect(arcPath(0, 0, 10, 0, 90, 90)).toBe('');
		expect(arcPath(0, 0, 10, 0, 90, 45)).toBe('');
	});
});
