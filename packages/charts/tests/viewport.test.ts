import { describe, expect, it } from 'vitest';
import {
	fullViewport,
	isFullViewport,
	panViewport,
	visibleRange,
	zoomViewport
} from '../src/core/viewport';

describe('fullViewport', () => {
	it('spans the whole index range for a typical count', () => {
		expect(fullViewport(10)).toEqual({ start: 0, end: 9 });
	});

	it('fabricates a unit span for count === 1 (still start < end)', () => {
		expect(fullViewport(1)).toEqual({ start: 0, end: 1 });
	});

	it('fabricates a unit span for count === 0', () => {
		expect(fullViewport(0)).toEqual({ start: 0, end: 1 });
	});
});

describe('isFullViewport', () => {
	it('is true for the exact full-domain viewport', () => {
		expect(isFullViewport({ start: 0, end: 9 }, 10)).toBe(true);
	});

	it('is false for a narrower window', () => {
		expect(isFullViewport({ start: 2, end: 8 }, 10)).toBe(false);
	});

	it('tolerates float noise at the edges', () => {
		expect(isFullViewport({ start: 1e-12, end: 9 - 1e-12 }, 10)).toBe(true);
	});
});

describe('visibleRange', () => {
	it('floors the start and ceils the end for a fractional window', () => {
		expect(visibleRange({ start: 2.3, end: 7.8 }, 20)).toEqual([2, 8]);
	});

	it('clamps to [0, count-1] even if the viewport overshoots', () => {
		expect(visibleRange({ start: -5, end: 500 }, 10)).toEqual([0, 9]);
	});

	it('handles count === 0 without going negative', () => {
		expect(visibleRange({ start: 0, end: 1 }, 0)).toEqual([0, 0]);
	});
});

describe('zoomViewport', () => {
	it('narrows the window around a fixed focus point (zoom in, factor < 1)', () => {
		const vp = { start: 0, end: 99 };
		const result = zoomViewport(vp, 50, 0.5, 100);
		expect(result.end - result.start).toBeCloseTo(49.5, 6);
		// focus (50) sits ~50.5% into the original window, so it stays at
		// ~50.5% into the narrowed window too.
		expect(result.start).toBeCloseTo(25, 6);
		expect(result.end).toBeCloseTo(74.5, 6);
	});

	it('widens the window on zoom out (factor > 1), clamped to the full domain', () => {
		const vp = { start: 40, end: 60 };
		const result = zoomViewport(vp, 50, 10, 100);
		expect(result.start).toBe(0);
		expect(result.end).toBe(99);
	});

	it('never collapses the span below minSpan', () => {
		const vp = { start: 0, end: 99 };
		const result = zoomViewport(vp, 50, 0.001, 100, 5);
		expect(result.end - result.start).toBeGreaterThanOrEqual(5 - 1e-6);
	});

	it('falls back minSpan to the domain span when the domain itself is smaller', () => {
		const vp = { start: 0, end: 1 };
		const result = zoomViewport(vp, 0.5, 0.01, 2, 10);
		expect(result.start).toBe(0);
		expect(result.end).toBe(1);
	});

	it('clamps the window to stay inside [0, count-1] when zooming near an edge', () => {
		const vp = { start: 0, end: 20 };
		const result = zoomViewport(vp, 0, 0.5, 100);
		expect(result.start).toBeGreaterThanOrEqual(0);
		expect(result.end).toBeLessThanOrEqual(99);
	});

	it('accepts a focus point outside the current window', () => {
		const vp = { start: 40, end: 60 };
		const result = zoomViewport(vp, 90, 0.5, 100);
		expect(result.start).toBeLessThan(result.end);
		expect(result.start).toBeGreaterThanOrEqual(0);
		expect(result.end).toBeLessThanOrEqual(99);
	});
});

describe('panViewport', () => {
	it('shifts the window by delta, preserving its span', () => {
		const result = panViewport({ start: 10, end: 20 }, 5, 100);
		expect(result).toEqual({ start: 15, end: 25 });
	});

	it('clamps at the low edge (delta pans off the start of the domain)', () => {
		const result = panViewport({ start: 5, end: 15 }, -20, 100);
		expect(result.start).toBe(0);
		expect(result.end).toBe(10);
	});

	it('clamps at the high edge (delta pans off the end of the domain)', () => {
		const result = panViewport({ start: 80, end: 90 }, 50, 100);
		expect(result.start).toBe(89);
		expect(result.end).toBe(99);
	});

	it('is a no-op at zero delta', () => {
		const vp = { start: 10, end: 20 };
		expect(panViewport(vp, 0, 100)).toEqual(vp);
	});
});
