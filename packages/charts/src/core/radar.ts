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

/**
 * Horizontal room (px) perimeter label `index` (of `count`) has at radius `r`
 * before it leaves `[0, width]`: the counterpart of `labelFitRadius` for
 * cutting labels that still don't fit once the radius hit its floor.
 */
export function labelMaxWidth(
	index: number,
	count: number,
	cx: number,
	width: number,
	r: number,
	gap: number
): number {
	const angle = spokeAngle(index, count);
	const x = cx + (r + gap) * Math.sin((angle * Math.PI) / 180);
	const { textAnchor } = spokeLabelAnchor(angle);
	const room =
		textAnchor === 'end' ? x : textAnchor === 'start' ? width - x : 2 * Math.min(x, width - x);
	return Math.max(0, room);
}

/**
 * Largest radius at which every perimeter label (placed `gap` px beyond the
 * ring, anchored by `spokeLabelAnchor`) stays inside `[0, width]`
 * horizontally, given each label's estimated width (`widths[i]`, px) and the
 * center `cx`. Infinity when no label constrains it (only top/bottom labels).
 * Used as an upper bound next to the fixed label padding so a larger label
 * font (root font size / token override, theme-dimension-tokens.md D9-b)
 * shrinks the plot instead of clipping the side labels.
 */
export function labelFitRadius(widths: number[], cx: number, width: number, gap: number): number {
	let limit = Infinity;
	const count = widths.length;
	for (let index = 0; index < count; index++) {
		const angle = spokeAngle(index, count);
		const s = Math.sin((angle * Math.PI) / 180);
		if (Math.abs(s) < 1e-9) continue;
		const { textAnchor } = spokeLabelAnchor(angle);
		// Horizontal room the label needs beyond its anchor point, on the side it extends to.
		const reach = textAnchor === 'middle' ? widths[index] / 2 : widths[index];
		const room = s > 0 ? width - cx - reach : cx - reach;
		limit = Math.min(limit, room / Math.abs(s) - gap);
	}
	return Math.max(0, limit);
}

/** Share of the available half-size the radius never goes below (see `radarRadius`). */
export const MIN_RADIUS_RATIO = 0.5;

/**
 * Plot radius for a `width` x `height` radar: the half-size minus the label
 * `padding`, shrunk further so the estimated side labels (`widths`) fit, but
 * never below `MIN_RADIUS_RATIO` of the half-size - the plot shrinks, it
 * never collapses; labels that still don't fit are cut by the component
 * (`labelMaxWidth` + `truncateLabel`, full text in `<title>`).
 */
export function radarRadius(
	width: number,
	height: number,
	padding: number,
	widths: number[],
	gap: number
): number {
	const half = Math.min(width, height) / 2;
	const base = Math.max(0, half - padding);
	const fit = labelFitRadius(widths, width / 2, width, gap);
	return Math.min(base, Math.max(fit, half * MIN_RADIUS_RATIO));
}
