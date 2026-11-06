/**
 * Pie/donut angle + arc-path math (spec §6, PieChart). Angles are degrees;
 * 0deg points along +x, increasing clockwise (screen-space y-down), so the
 * default `startAngle = -90` starts at the top of the circle.
 */

export interface PieSlice {
	index: number;
	value: number;
	startAngle: number;
	endAngle: number;
}

/**
 * Convert `values` into slices summing to a full 360deg sweep, proportional
 * to each (non-negative) value. Non-finite or negative values contribute 0
 * (no sweep) but still get a slice entry so the index stays aligned with the
 * series/category order (spec §6 rule 1: color follows entity, by index).
 * When every value is <= 0 (including the empty-data case), all slices
 * degenerate to zero-width at `startAngle` rather than dividing by zero.
 */
export function pieSlices(values: number[], options: { startAngle?: number } = {}): PieSlice[] {
	const start = options.startAngle ?? -90;
	const positive = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
	const total = positive.reduce((sum, v) => sum + v, 0);

	if (total <= 0) {
		return values.map((value, index) => ({ index, value, startAngle: start, endAngle: start }));
	}

	let angle = start;
	return values.map((value, index) => {
		const sweep = (positive[index] / total) * 360;
		const startAngle = angle;
		const endAngle = angle + sweep;
		angle = endAngle;
		return { index, value, startAngle, endAngle };
	});
}

/** Polar -> cartesian in the same 0deg-at-+x, clockwise convention as this file's angles (also reused by Gauge.svelte for its arc-end labels). */
export function polarToCartesian(
	cx: number,
	cy: number,
	r: number,
	deg: number
): { x: number; y: number } {
	const rad = (deg * Math.PI) / 180;
	return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/**
 * SVG path `d` for one pie (rInner = 0) or donut (rInner > 0) slice, from
 * `startDeg` to `endDeg`. Handles sweeps > 180deg via the large-arc-flag, and
 * a full 360deg sweep (single slice covering the whole circle) by splitting
 * into two 180deg arcs - a single `A` command degenerates when its start and
 * end points coincide.
 */
export function arcPath(
	cx: number,
	cy: number,
	rOuter: number,
	rInner: number,
	startDeg: number,
	endDeg: number
): string {
	const sweep = endDeg - startDeg;
	if (sweep <= 0 || rOuter <= 0) return '';

	if (sweep >= 359.999) {
		const mid = startDeg + 180;
		return `${arcPath(cx, cy, rOuter, rInner, startDeg, mid)} ${arcPath(cx, cy, rOuter, rInner, mid, endDeg)}`;
	}

	const largeArc = sweep > 180 ? 1 : 0;
	const outerStart = polarToCartesian(cx, cy, rOuter, startDeg);
	const outerEnd = polarToCartesian(cx, cy, rOuter, endDeg);

	if (rInner <= 0) {
		return [
			`M ${cx} ${cy}`,
			`L ${outerStart.x} ${outerStart.y}`,
			`A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
			'Z'
		].join(' ');
	}

	const innerStart = polarToCartesian(cx, cy, rInner, startDeg);
	const innerEnd = polarToCartesian(cx, cy, rInner, endDeg);
	return [
		`M ${outerStart.x} ${outerStart.y}`,
		`A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
		`L ${innerEnd.x} ${innerEnd.y}`,
		`A ${rInner} ${rInner} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
		'Z'
	].join(' ');
}
