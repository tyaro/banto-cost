/**
 * Pareto-diagram data (roadmap.md M13, SPC/QC "パレート図": bars sorted
 * descending + cumulative-percent line, conventionally read against an
 * 80% reference line). Pure array-in, array-out - no knowledge of SVG
 * geometry; the 80% line itself is just a caller-side constant on the same
 * percent axis.
 */

export interface ParetoItem {
	label: string;
	value: number;
}

export interface ParetoDatum extends ParetoItem {
	/** Running sum of `value` up to and including this item, in sorted order. */
	cumulative: number;
	/** `cumulative` as a percent of the total, 0-100 (see degenerate-total note below). */
	cumulativePercent: number;
}

/**
 * Sort `items` descending by `value` and attach running cumulative
 * sum/percent (the classic Pareto layout). Ties keep their original relative
 * order (`Array.prototype.sort` is stable). Negative values are NOT clamped
 * to 0 - they pass through as-is into `cumulative`, since deciding whether
 * negative values are meaningful for a given dataset is the caller's call.
 * A non-positive total (empty input, or values summing to <= 0) has no
 * meaningful "percent of total" though, so `cumulativePercent` is explicitly
 * 0 in that case rather than a negative/Infinity/NaN ratio.
 */
export function paretoData(items: ParetoItem[]): ParetoDatum[] {
	const sorted = [...items].sort((a, b) => b.value - a.value);
	const total = sorted.reduce((sum, item) => sum + item.value, 0);

	let cumulative = 0;
	return sorted.map((item) => {
		cumulative += item.value;
		const cumulativePercent = total > 0 ? Math.round((cumulative / total) * 100 * 1e9) / 1e9 : 0;
		return { ...item, cumulative, cumulativePercent };
	});
}
