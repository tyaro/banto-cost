import { describe, expect, it } from 'vitest';
import { intersectErrorBounds, positionCellError } from '../src/cell-error-position';

describe('local cell error positioning', () => {
	const viewport = { left: 10, top: 20, width: 280, height: 200 };
	it('fits a short error below its editor and clamps the width to the viewport', () => {
		expect(positionCellError(viewport, { left: 250, top: 40, width: 100, height: 30 }, 4)).toEqual({
			left: 14,
			top: 74,
			width: 272,
			maxHeight: 142
		});
	});
	it('flips up at the bottom and limits a long error to the available height', () => {
		expect(positionCellError(viewport, { left: 270, top: 180, width: 80, height: 30 }, 4)).toEqual({
			left: 14,
			bottomEdge: 176,
			width: 272,
			maxHeight: 152
		});
	});
	it.each([
		{ left: 290, top: 40, width: 20, height: 30 },
		{ left: -20, top: 40, width: 30, height: 30 },
		{ left: 20, top: 220, width: 20, height: 30 },
		{ left: 20, top: -10, width: 20, height: 30 },
		{ left: 20, top: 40, width: 0, height: 30 }
	])('hides an editor outside the visible scrollport: %j', (editor) => {
		expect(positionCellError(viewport, editor, 4)).toBeNull();
	});
	it('keeps a scrollable box inside a viewport no larger than the editor', () => {
		const tiny = { left: 5, top: 7, width: 12, height: 8 };
		expect(positionCellError(tiny, tiny, 20)).toEqual({
			left: 7,
			top: 9,
			width: 8,
			maxHeight: 4
		});
	});
	it('does not place an error in a collapsed viewport', () => {
		expect(positionCellError({ ...viewport, height: 0 }, viewport, 4)).toBeNull();
	});
	it('intersects nested overflow bounds only on the clipped axis', () => {
		const clip = { left: 30, top: 50, width: 180, height: 90 };
		expect(intersectErrorBounds(viewport, clip, false, true)).toEqual({
			...viewport,
			top: 50,
			height: 90
		});
		expect(intersectErrorBounds(viewport, clip, true, false)).toEqual({
			...viewport,
			left: 30,
			width: 180
		});
		expect(intersectErrorBounds(viewport, clip)).toEqual(clip);
		expect(intersectErrorBounds(viewport, { ...clip, top: 1000 }).height).toBe(0);
	});
	it('anchors to the larger upper side even when a little space remains below', () => {
		const editor = { left: 20, top: 180, width: 80, height: 20 };
		expect(positionCellError(viewport, editor, 4)).toEqual({
			left: 14,
			bottomEdge: 176,
			width: 272,
			maxHeight: 152
		});
	});
});
