/**
 * Radar/spider chart angle + vertex math (spec §6.1 RadarChart). Angle 0deg
 * is 12 o'clock (straight up), increasing CLOCKWISE - deliberately different
 * from `core/pie.ts`'s 0deg-at-+x convention, since a radar chart's first
 * spoke conventionally points up, not right.
 */
import type { Point } from './path';

/** Angle (degrees, 0 = 12 o'clock, clockwise) of spoke `index` out of `count` evenly-spaced spokes. */
export function spokeAngle(index: number, count: number): number {
	if (count <= 0) return 0;
	return (index * 360) / count;
}

function polarPoint(cx: number, cy: number, r: number, angleDeg: number): Point {
	const rad = (angleDeg * Math.PI) / 180;
	// sin/-cos (not the usual cos/sin) because angle 0 is "up", not "right".
	return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

/**
 * Vertex coordinates for one series' closed polygon: `values[i]` sits on
 * spoke `i` (of `values.length` total spokes), at a radius proportional to
 * `values[i] / maxValue` (clamped to [0, 1] so an out-of-range value doesn't
 * escape the plot). `maxValue <= 0` (degenerate "all axes are zero, or an
 * explicit max of 0") maps every vertex to the center rather than dividing by
 * zero.
 */
export function radarPoints(
	values: number[],
	maxValue: number,
	cx: number,
	cy: number,
	radius: number
): Point[] {
	const count = values.length;
	return values.map((value, index) => {
		const ratio =
			maxValue > 0 && Number.isFinite(value) ? Math.min(1, Math.max(0, value / maxValue)) : 0;
		return polarPoint(cx, cy, radius * ratio, spokeAngle(index, count));
	});
}

/** Vertices of a full ring polygon (a background grid ring, or the outermost spoke guides) at `ratio` of `radius` (1 = the outer ring). */
export function ringPolygon(
	count: number,
	ratio: number,
	cx: number,
	cy: number,
	radius: number
): Point[] {
	return Array.from({ length: count }, (_, index) =>
		polarPoint(cx, cy, radius * ratio, spokeAngle(index, count))
	);
}

export interface LabelAnchor {
	textAnchor: 'start' | 'middle' | 'end';
	dominantBaseline: 'auto' | 'middle' | 'hanging';
}

/**
 * Anchor/baseline for a perimeter axis label at `angleDeg` (same convention
 * as `spokeAngle`), so the label reads AWAY from the plot's center instead of
 * overlapping the rings: octant-based (8 sectors of 45deg, centered on the 8
 * compass points), snapping to the nearest octant via rounding rather than a
 * continuous gradient - a label a few degrees off its ideal anchor is
 * invisible, a wrong octant (e.g. text growing back over the plot) is not.
 */
export function spokeLabelAnchor(angleDeg: number): LabelAnchor {
	const normalized = ((angleDeg % 360) + 360) % 360;
	const octant = Math.round(normalized / 45) % 8;
	const table: LabelAnchor[] = [
		{ textAnchor: 'middle', dominantBaseline: 'auto' }, // 0deg   - top
		{ textAnchor: 'start', dominantBaseline: 'auto' }, // 45deg  - upper-right
		{ textAnchor: 'start', dominantBaseline: 'middle' }, // 90deg  - right
		{ textAnchor: 'start', dominantBaseline: 'hanging' }, // 135deg - lower-right
		{ textAnchor: 'middle', dominantBaseline: 'hanging' }, // 180deg - bottom
		{ textAnchor: 'end', dominantBaseline: 'hanging' }, // 225deg - lower-left
		{ textAnchor: 'end', dominantBaseline: 'middle' }, // 270deg - left
		{ textAnchor: 'end', dominantBaseline: 'auto' } // 315deg - upper-left
	];
	return table[octant];
}
