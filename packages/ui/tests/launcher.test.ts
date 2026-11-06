/**
 * @banto/ui `launcher.ts` (docs/design/nav-launcher-plan.md §4.2, §7.1): the
 * magnification curve `magnifyScale(distance, range, max)` - max at the
 * pointer, 1 from `range` on, monotone and symmetric in between, and a safe 1
 * for degenerate inputs (an unreadable token must not magnify or yield NaN).
 */
import { describe, expect, it } from 'vitest';
import { magnifyScale } from '../src/index';

describe('magnifyScale', () => {
	const range = 110;
	const max = 1.5;

	it.each([
		[0, 1.5],
		[range / 2, 1.25],
		[range, 1],
		[range * 3, 1]
	])('distance %d -> %d', (distance, expected) => {
		expect(magnifyScale(distance, range, max)).toBeCloseTo(expected, 10);
	});

	it('falls monotonically from max to 1 across the range', () => {
		let previous = Infinity;
		for (let d = 0; d <= range; d += 5) {
			const scale = magnifyScale(d, range, max);
			expect(scale).toBeLessThanOrEqual(previous);
			expect(scale).toBeGreaterThanOrEqual(1);
			expect(scale).toBeLessThanOrEqual(max);
			previous = scale;
		}
	});

	it('is symmetric for negative distances', () => {
		for (const d of [0, 10, 40, 80, 200]) {
			expect(magnifyScale(-d, range, max)).toBe(magnifyScale(d, range, max));
		}
	});

	it('is always 1 when max <= 1', () => {
		for (const d of [0, 10, 200]) {
			expect(magnifyScale(d, range, 1)).toBe(1);
			expect(magnifyScale(d, range, 0.5)).toBe(1);
		}
	});

	it('is 1 (never NaN) for a non-positive range or non-finite inputs', () => {
		expect(magnifyScale(0, 0, max)).toBe(1);
		expect(magnifyScale(0, -10, max)).toBe(1);
		expect(magnifyScale(Number.NaN, range, max)).toBe(1);
		expect(magnifyScale(0, Number.NaN, max)).toBe(1);
		expect(magnifyScale(0, range, Number.NaN)).toBe(1);
		expect(magnifyScale(0, Infinity, max)).toBe(1);
	});
});
