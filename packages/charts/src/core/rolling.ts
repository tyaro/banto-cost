/**
 * Rolling-window helpers for streaming chart updates (roadmap.md M13,
 * "ストリーミング更新": append-only data feeds that must not grow forever
 * and must not force a full chart re-render just to trim old points). Pure
 * array-in, array-out - callers own how/when to call these, this module just
 * computes the resulting window.
 */

/**
 * Append `incoming` to `data` and drop from the FRONT (oldest first) down to
 * `maxCount` items, so the window always keeps the most recent `maxCount`
 * entries regardless of how many were appended in one call. `maxCount <= 0`
 * (or non-integer, floored) means "keep nothing" and returns `[]`.
 */
export function rollingAppend<T>(
	data: readonly T[],
	incoming: readonly T[],
	maxCount: number
): T[] {
	const cap = Math.max(0, Math.floor(maxCount));
	if (cap === 0) return [];

	const combined = [...data, ...incoming];
	if (combined.length <= cap) return combined;
	return combined.slice(combined.length - cap);
}

/**
 * Drop the leading run of `data` whose `time(item) < cutoff`. Assumes `data`
 * is already sorted ascending by `time` (the invariant a rolling time window
 * naturally maintains), which lets this binary-search for the cut point
 * (`O(log n)`) instead of scanning linearly. Returns a new array; `data`
 * itself is never mutated.
 */
export function evictBefore<T>(data: readonly T[], time: (item: T) => number, cutoff: number): T[] {
	let lo = 0;
	let hi = data.length; // exclusive upper bound of the search
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (time(data[mid]) < cutoff) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return data.slice(lo);
}
