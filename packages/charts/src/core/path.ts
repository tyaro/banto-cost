/**
 * SVG path-string generators (spec §6): line/area polylines and the
 * rounded-data-end bar shape (rule 3 - rounded 4px on the data end only,
 * square baseline end, hence a path rather than `<rect rx>` which rounds all
 * four corners).
 */

export interface Point {
	x: number;
	y: number;
}

/** Polyline through `points` (no smoothing - spec limits v1 to straight segments). Empty for 0/1 points is still valid (a single `M` with no `L`). */
export function linePath(points: Point[]): string {
	if (points.length === 0) return '';
	return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

/** Filled area under `points` down to the baseline `y0` (spec §6 LineChart `area` option). */
export function areaPath(points: Point[], y0: number): string {
	if (points.length === 0) return '';
	if (points.length === 1) {
		const p = points[0];
		return `M ${p.x} ${p.y} L ${p.x} ${y0} Z`;
	}
	const top = linePath(points);
	const last = points[points.length - 1];
	const first = points[0];
	return `${top} L ${last.x} ${y0} L ${first.x} ${y0} Z`;
}

/**
 * Several disjoint polylines as one path string (`gaps="break"`): each
 * non-empty segment restarts with its own `M`, so a gap between segments is
 * not bridged. A single segment equals `linePath(segment)`.
 */
export function linePathSegments(segments: Point[][]): string {
	return segments
		.filter((s) => s.length > 0)
		.map((s) => linePath(s))
		.join(' ');
}

/** Filled area under each of several disjoint segments down to `y0` (one closed subpath per segment). A single segment equals `areaPath(segment, y0)`. */
export function areaPathSegments(segments: Point[][], y0: number): string {
	return segments
		.filter((s) => s.length > 0)
		.map((s) => areaPath(s, y0))
		.join(' ');
}

/**
 * Filled band between two polylines `top` and `bottom` (spec §6, stacked-area
 * charts): the region enclosed by the top boundary drawn forward and the
 * bottom boundary drawn in reverse. Both arrays share the same x positions
 * (one point per visible data index); either being empty yields no path.
 */
export function bandAreaPath(top: Point[], bottom: Point[]): string {
	if (top.length === 0 || bottom.length === 0) return '';
	const forward = linePath(top);
	const back = bottom
		.slice()
		.reverse()
		.map((p) => `L ${p.x} ${p.y}`)
		.join(' ');
	return `${forward} ${back} Z`;
}

/**
 * Rectangle with radius `r` rounded only on the "data end": the top edge for
 * a vertical bar, or the right edge for a horizontal bar (`horizontal` =
 * true). The baseline end (bottom / left respectively) stays perfectly
 * square, per spec §6 rule 3. `r` is clamped to half of the smaller of
 * width/height so a thin/short bar never produces overlapping curves.
 */
export function roundedTopBarPath(
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
	horizontal = false
): string {
	const width = Math.max(0, w);
	const height = Math.max(0, h);
	const radius = Math.max(0, Math.min(r, width / 2, height / 2));

	if (radius === 0) {
		return `M ${x} ${y} L ${x + width} ${y} L ${x + width} ${y + height} L ${x} ${y + height} Z`;
	}

	if (horizontal) {
		// Rounded right edge (data end), square left edge (baseline).
		return [
			`M ${x} ${y}`,
			`L ${x + width - radius} ${y}`,
			`Q ${x + width} ${y} ${x + width} ${y + radius}`,
			`L ${x + width} ${y + height - radius}`,
			`Q ${x + width} ${y + height} ${x + width - radius} ${y + height}`,
			`L ${x} ${y + height}`,
			'Z'
		].join(' ');
	}

	// Rounded top edge (data end), square bottom edge (baseline).
	return [
		`M ${x} ${y + radius}`,
		`Q ${x} ${y} ${x + radius} ${y}`,
		`L ${x + width - radius} ${y}`,
		`Q ${x + width} ${y} ${x + width} ${y + radius}`,
		`L ${x + width} ${y + height}`,
		`L ${x} ${y + height}`,
		'Z'
	].join(' ');
}
