import { describe, expect, it } from 'vitest';
import { bandScale, linearScale, niceTicks } from '../src/core/scale';

describe('linearScale', () => {
	it('maps domain endpoints to range endpoints', () => {
		const scale = linearScale([0, 100], [0, 200]);
		expect(scale(0)).toBe(0);
		expect(scale(100)).toBe(200);
		expect(scale(50)).toBe(100);
	});

	it('handles an inverted range (e.g. y-axis, 0 at bottom)', () => {
		const scale = linearScale([0, 10], [100, 0]);
		expect(scale(0)).toBe(100);
		expect(scale(10)).toBe(0);
		expect(scale(5)).toBe(50);
	});

	it('extrapolates outside the domain', () => {
		const scale = linearScale([0, 10], [0, 100]);
		expect(scale(-5)).toBe(-50);
		expect(scale(15)).toBe(150);
	});

	it('maps every value to the range midpoint when the domain is degenerate (all-equal values)', () => {
		const scale = linearScale([5, 5], [0, 100]);
		expect(scale(5)).toBe(50);
		expect(scale(999)).toBe(50);
	});
});

describe('niceTicks', () => {
	it('produces ~4-6 clean ticks for a typical span', () => {
		const ticks = niceTicks(0, 93, 5);
		expect(ticks).toEqual([0, 20, 40, 60, 80, 100]);
	});

	it('always includes the domain (min/max fall within [first, last])', () => {
		const ticks = niceTicks(3, 987, 5);
		expect(ticks[0]).toBeLessThanOrEqual(3);
		expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(987);
		expect(ticks.length).toBeGreaterThanOrEqual(4);
		expect(ticks.length).toBeLessThanOrEqual(7);
	});

	it('handles min === max === 0 without dividing by zero', () => {
		const ticks = niceTicks(0, 0, 5);
		expect(ticks[0]).toBe(0);
		expect(ticks.every(Number.isFinite)).toBe(true);
	});

	it('handles min === max at a non-zero value (all-equal data)', () => {
		const ticks = niceTicks(42, 42, 5);
		expect(ticks.every(Number.isFinite)).toBe(true);
		expect(ticks.some((t) => t <= 42)).toBe(true);
		expect(ticks.some((t) => t >= 42)).toBe(true);
	});

	it('produces evenly-spaced steps with no visible float noise', () => {
		const ticks = niceTicks(0, 1, 5);
		for (let i = 1; i < ticks.length; i++) {
			const step = ticks[i] - ticks[i - 1];
			expect(step).toBeCloseTo(0.2, 9);
		}
	});

	it('is order-independent (min/max may arrive swapped)', () => {
		expect(niceTicks(100, 0, 5)).toEqual(niceTicks(0, 100, 5));
	});
});

describe('bandScale', () => {
	it('lays out equal-width bands with a centered inset gap', () => {
		const scale = bandScale(3, [0, 300], 0.2);
		expect(scale.bandwidth).toBe(80);
		expect(scale.start(0)).toBe(10);
		expect(scale.start(1)).toBe(110);
		expect(scale.start(2)).toBe(210);
		expect(scale.center(0)).toBe(50);
		expect(scale.center(1)).toBe(150);
		expect(scale.center(2)).toBe(250);
	});

	it('padding 0 means bands touch edge-to-edge', () => {
		const scale = bandScale(2, [0, 100], 0);
		expect(scale.bandwidth).toBe(50);
		expect(scale.start(0)).toBe(0);
		expect(scale.start(1)).toBe(50);
	});

	it('handles a single band (centered in the full range minus padding)', () => {
		const scale = bandScale(1, [0, 100], 0.2);
		expect(scale.bandwidth).toBe(80);
		expect(scale.center(0)).toBe(50);
	});

	it('handles count === 0 without dividing by zero', () => {
		const scale = bandScale(0, [0, 100], 0.2);
		expect(scale.bandwidth).toBe(0);
		expect(Number.isFinite(scale.start(0))).toBe(true);
	});
});
