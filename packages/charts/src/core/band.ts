/**
 * Threshold-band extent resolution (LineChart `bands`). Pure value-space math:
 * resolves open-ended / non-finite `from`/`to` to the plot edge and clips the
 * band to the scale's domain, so the chart can map the result through its
 * scale. A finite band lying inside the domain is returned unchanged (same
 * numbers), so existing output is byte-identical.
 */

/**
 * Resolve a band against the y-domain `[domainMin, domainMax]` (either order).
 * A non-finite `from` (null/undefined/NaN/±Infinity) is open toward the low
 * edge, a non-finite `to` (likewise) toward the high edge - decided by POSITION
 * before ordering, so `(Infinity, 40)` is 0..40, not 40..max;
 * `from`/`to` may be given in either order when both are finite. Returns the
 * clipped `{ low, high, lowEdge, highEdge }` (`*Edge` = that side is a real
 * finite boundary inside the domain, i.e. worth drawing an edge line on; false
 * for an open or clipped side), or `null` when the band lies entirely outside the
 * domain (nothing to draw).
 */
export function resolveBand(
	from: number | null | undefined,
	to: number | null | undefined,
	domain: [number, number]
): { low: number; high: number; lowEdge: boolean; highEdge: boolean } | null {
	const dMin = Math.min(domain[0], domain[1]);
	const dMax = Math.max(domain[0], domain[1]);
	const a = typeof from === 'number' && Number.isFinite(from) ? from : -Infinity;
	const b = typeof to === 'number' && Number.isFinite(to) ? to : Infinity;
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	if (hi < dMin || lo > dMax) return null;
	return {
		low: Math.max(lo, dMin),
		high: Math.min(hi, dMax),
		lowEdge: Number.isFinite(lo) && lo >= dMin,
		highEdge: Number.isFinite(hi) && hi <= dMax
	};
}
