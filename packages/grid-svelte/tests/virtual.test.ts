import { describe, expect, it } from 'vitest';
import { computeWindow } from '../src/core/virtual';

describe('computeWindow', () => {
	const rowHeight = 36;
	const rowCount = 10_000;
	const viewportHeight = 360; // 10 visible rows
	const overscan = 8;

	it('at the top boundary, start clamps to 0', () => {
		const result = computeWindow({ scrollTop: 0, viewportHeight, rowHeight, rowCount, overscan });
		expect(result.start).toBe(0);
		expect(result.offsetY).toBe(0);
		expect(result.end).toBeGreaterThan(0);
		expect(result.totalHeight).toBe(rowCount * rowHeight);
	});

	it('negative scrollTop is treated as 0', () => {
		const result = computeWindow({
			scrollTop: -100,
			viewportHeight,
			rowHeight,
			rowCount,
			overscan
		});
		expect(result.start).toBe(0);
		expect(result.offsetY).toBe(0);
	});

	it('in the middle, the window is centered around the scroll position with overscan', () => {
		const scrollTop = 5000 * rowHeight; // row 5000 at the top of the viewport
		const result = computeWindow({ scrollTop, viewportHeight, rowHeight, rowCount, overscan });
		expect(result.start).toBe(5000 - overscan);
		expect(result.offsetY).toBe(result.start * rowHeight);
		expect(result.end).toBeLessThanOrEqual(rowCount);
		expect(result.end).toBeGreaterThan(result.start);
	});

	it('at the bottom boundary, end clamps to rowCount (exclusive)', () => {
		const scrollTop = rowCount * rowHeight; // scrolled past the end
		const result = computeWindow({ scrollTop, viewportHeight, rowHeight, rowCount, overscan });
		expect(result.end).toBe(rowCount);
		expect(result.start).toBeLessThan(rowCount);
	});

	it('small datasets (rowCount < viewport rows) render the whole set', () => {
		const smallRowCount = 5;
		const result = computeWindow({
			scrollTop: 0,
			viewportHeight,
			rowHeight,
			rowCount: smallRowCount,
			overscan
		});
		expect(result.start).toBe(0);
		expect(result.end).toBe(smallRowCount);
		expect(result.totalHeight).toBe(smallRowCount * rowHeight);
	});

	it('returns an empty window for zero rows', () => {
		const result = computeWindow({
			scrollTop: 0,
			viewportHeight,
			rowHeight,
			rowCount: 0,
			overscan
		});
		expect(result).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 });
	});

	it('handles a zero viewport height (not yet measured) without throwing', () => {
		const result = computeWindow({
			scrollTop: 0,
			viewportHeight: 0,
			rowHeight,
			rowCount,
			overscan
		});
		expect(result.start).toBe(0);
		expect(result.end).toBeGreaterThan(0);
	});
});
