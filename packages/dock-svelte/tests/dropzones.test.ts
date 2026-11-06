import { describe, expect, it } from 'vitest';
import { computeDropRegion } from '../src/core/dropzones';

const W = 200;
const H = 100;

describe('computeDropRegion', () => {
	it('returns center for the middle of the rect', () => {
		expect(computeDropRegion(W / 2, H / 2, W, H)).toBe('center');
	});

	it('returns center exactly at the edgeRatio boundary (strict <, not <=)', () => {
		// edgeRatio 0.25 => left/right bands are [0, 50) and (150, 200]; a point
		// at exactly x=50 (dist 0.25) is NOT inside the left band.
		expect(computeDropRegion(50, H / 2, W, H)).toBe('center');
		expect(computeDropRegion(150, H / 2, W, H)).toBe('center');
		expect(computeDropRegion(W / 2, 25, W, H)).toBe('center');
		expect(computeDropRegion(W / 2, 75, W, H)).toBe('center');
	});

	it('returns left just inside the left band', () => {
		expect(computeDropRegion(10, H / 2, W, H)).toBe('left');
	});

	it('returns right just inside the right band', () => {
		expect(computeDropRegion(W - 10, H / 2, W, H)).toBe('right');
	});

	it('returns top just inside the top band', () => {
		expect(computeDropRegion(W / 2, 5, W, H)).toBe('top');
	});

	it('returns bottom just inside the bottom band', () => {
		expect(computeDropRegion(W / 2, H - 5, W, H)).toBe('bottom');
	});

	it('resolves a corner to whichever edge is normalized-distance-closer (clear winner)', () => {
		// width=200,height=100: at (5, 5), leftDist = 5/200 = 0.025, topDist = 5/100 = 0.05.
		// left is closer (smaller normalized distance) so it wins over top.
		expect(computeDropRegion(5, 5, W, H)).toBe('left');
	});

	it('resolves the opposite corner correctly too', () => {
		// bottom-right corner: rightDist = 5/200 = 0.025, bottomDist = 5/100 = 0.05 -> right wins.
		expect(computeDropRegion(W - 5, H - 5, W, H)).toBe('right');
	});

	it('breaks an exact tie in favor of left over top (stable sort, insertion priority left > right > top > bottom)', () => {
		// Using a square rect removes the aspect-ratio skew, so a corner point
		// at equal absolute offset from both edges produces an exact tie.
		const S = 100;
		expect(computeDropRegion(5, 5, S, S)).toBe('left');
	});

	it('breaks an exact tie in favor of right over bottom', () => {
		const S = 100;
		expect(computeDropRegion(S - 5, S - 5, S, S)).toBe('right');
	});

	it('breaks an exact tie in favor of top over... nothing else competing (top vs bottom impossible in one corner) - verifies top wins over a simultaneous left/right non-match', () => {
		const S = 100;
		// (50, 5): not in left/right band (x is centered), only top band matches.
		expect(computeDropRegion(50, 5, S, S)).toBe('top');
	});

	it('respects a custom edgeRatio', () => {
		expect(computeDropRegion(45, H / 2, W, H, 0.1)).toBe('center'); // 45/200=0.225 > 0.1
		expect(computeDropRegion(15, H / 2, W, H, 0.1)).toBe('left'); // 15/200=0.075 < 0.1
	});

	it('falls back to center for a degenerate (zero-size) rect', () => {
		expect(computeDropRegion(0, 0, 0, 0)).toBe('center');
	});
});
