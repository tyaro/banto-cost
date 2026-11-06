/**
 * Y-axis extent helpers.
 *
 * `includeY` lets a caller force specific values into an axis extent without
 * injecting fake data points (tyaro/banto-industrial#554: a bit trend whose
 * only visible value is 0.5 must still get 0 and 1 ticks).
 */

/**
 * Union of a data extent and extra values to include.
 *
 * - `dataExtent` is `[min, max]` as produced by an extent scan; `[Infinity,
 *   -Infinity]` (or any non-finite end) means "no finite data".
 * - Non-finite `include` entries are ignored.
 * - With no usable include values the data extent is returned unchanged (same
 *   reference), so callers without `includeY` are byte-for-byte unaffected.
 * - With no finite data the extent comes from `include` alone; with neither,
 *   the (non-finite) data extent is returned so callers still detect "empty".
 */
export function mergeExtent(
	dataExtent: readonly [number, number],
	include?: readonly number[]
): [number, number] {
	const base: [number, number] = [dataExtent[0], dataExtent[1]];
	if (!include || include.length === 0) return dataExtent as [number, number];
	let min = Number.isFinite(base[0]) ? base[0] : Infinity;
	let max = Number.isFinite(base[1]) ? base[1] : -Infinity;
	let used = false;
	for (const v of include) {
		if (!Number.isFinite(v)) continue;
		used = true;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	if (!used) return dataExtent as [number, number];
	return [min, max];
}
