import { describe, expect, it } from 'vitest';
import { radarPoints, ringPolygon, spokeAngle, spokeLabelAnchor } from '../src/core/radar';

describe('spokeAngle', () => {
	it("spaces spokes evenly, 0deg = 12 o'clock, increasing clockwise", () => {
		expect(spokeAngle(0, 4)).toBe(0);
		expect(spokeAngle(1, 4)).toBe(90);
		expect(spokeAngle(2, 4)).toBe(180);
		expect(spokeAngle(3, 4)).toBe(270);
	});

	it('handles 3 and 6 spokes', () => {
		expect(spokeAngle(1, 3)).toBeCloseTo(120);
		expect(spokeAngle(1, 6)).toBeCloseTo(60);
	});

	it('returns 0 for a non-positive spoke count instead of dividing by zero', () => {
		expect(spokeAngle(0, 0)).toBe(0);
	});
});

describe('radarPoints', () => {
	it('places a value of 0 at the center, regardless of angle', () => {
		const points = radarPoints([0, 0, 0, 0], 100, 50, 50, 40);
		for (const p of points) {
			expect(p.x).toBeCloseTo(50);
			expect(p.y).toBeCloseTo(50);
		}
	});

	it('places a value of maxValue exactly at the outer radius', () => {
		const [top] = radarPoints([100], 100, 50, 50, 40);
		// spoke 0 of a single-spoke chart points straight up (0deg).
		expect(top.x).toBeCloseTo(50);
		expect(top.y).toBeCloseTo(10);
	});

	it('computes correct coordinates for 3 spokes', () => {
		const points = radarPoints([10, 10, 10], 10, 0, 0, 10);
		expect(points[0].x).toBeCloseTo(0);
		expect(points[0].y).toBeCloseTo(-10);
		expect(points[1].x).toBeCloseTo(10 * Math.sin((120 * Math.PI) / 180));
		expect(points[1].y).toBeCloseTo(-10 * Math.cos((120 * Math.PI) / 180));
	});

	it('computes correct coordinates for 4 spokes (cardinal points)', () => {
		const points = radarPoints([10, 10, 10, 10], 10, 0, 0, 10);
		expect(points[0].x).toBeCloseTo(0);
		expect(points[0].y).toBeCloseTo(-10);
		expect(points[1].x).toBeCloseTo(10);
		expect(points[1].y).toBeCloseTo(0);
		expect(points[2].x).toBeCloseTo(0);
		expect(points[2].y).toBeCloseTo(10);
		expect(points[3].x).toBeCloseTo(-10);
		expect(points[3].y).toBeCloseTo(0);
	});

	it('computes correct coordinates for 6 spokes', () => {
		const points = radarPoints(new Array(6).fill(10), 10, 0, 0, 10);
		expect(points).toHaveLength(6);
		// spoke 3 (halfway around) points straight down.
		expect(points[3].x).toBeCloseTo(0);
		expect(points[3].y).toBeCloseTo(10);
	});

	it('degenerate all-zero maxValue maps every vertex to the center instead of dividing by zero', () => {
		const points = radarPoints([0, 5, 10], 0, 20, 20, 30);
		for (const p of points) {
			expect(p.x).toBeCloseTo(20);
			expect(p.y).toBeCloseTo(20);
		}
	});

	it('clamps an out-of-range value to the outer radius rather than escaping the plot', () => {
		const [p] = radarPoints([150], 100, 0, 0, 10);
		expect(p.y).toBeCloseTo(-10);
	});
});

describe('ringPolygon', () => {
	it('returns count vertices at ratio * radius from center', () => {
		const ring = ringPolygon(4, 0.5, 0, 0, 20);
		expect(ring).toHaveLength(4);
		expect(ring[0].x).toBeCloseTo(0);
		expect(ring[0].y).toBeCloseTo(-10);
		expect(ring[1].x).toBeCloseTo(10);
		expect(ring[1].y).toBeCloseTo(0);
	});
});

describe('spokeLabelAnchor', () => {
	it('anchors the top label centered above (middle/auto)', () => {
		expect(spokeLabelAnchor(0)).toEqual({ textAnchor: 'middle', dominantBaseline: 'auto' });
	});

	it('anchors the right label starting outward, vertically centered', () => {
		expect(spokeLabelAnchor(90)).toEqual({ textAnchor: 'start', dominantBaseline: 'middle' });
	});

	it('anchors the bottom label centered below (middle/hanging)', () => {
		expect(spokeLabelAnchor(180)).toEqual({ textAnchor: 'middle', dominantBaseline: 'hanging' });
	});

	it('anchors the left label ending outward, vertically centered', () => {
		expect(spokeLabelAnchor(270)).toEqual({ textAnchor: 'end', dominantBaseline: 'middle' });
	});

	it('normalizes angles outside [0, 360)', () => {
		expect(spokeLabelAnchor(360)).toEqual(spokeLabelAnchor(0));
		expect(spokeLabelAnchor(-90)).toEqual(spokeLabelAnchor(270));
	});
});
