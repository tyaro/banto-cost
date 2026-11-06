/**
 * Point decimation for dense trend series (roadmap.md M13, ズーム/パン 性能).
 *
 * When a zoomed/panned `LineChart` still has far more visible data points than
 * screen pixels to draw them on (e.g. 10k points across an 800px plot), drawing
 * every point wastes work: the resulting <path> has thousands of segments that
 * land on the same pixel column. This module reduces the index set to render.
 *
 * Strategy: **plain nth-point (stride) decimation** - keep every `stride`-th
 * index plus the two endpoints. It is the cheapest possible reducer (`O(output)`,
 * no per-point value inspection) and preserves x-monotonicity for free. The
 * known trade-off is that it can skip a narrow spike that falls between kept
 * samples; that is acceptable for a pannable trend overview (the user zooms in
 * to inspect a region, at which point the stride drops to 1 and every point is
 * drawn). A min/max-preserving reducer (e.g. LTTB or per-bucket min+max) is a
 * deliberate future upgrade, not needed for v1's "실用フレームレート" target.
 *
 * Pure index math - no knowledge of pixels, SVG, or the data values; the chart
 * maps the returned indices through its own scales.
 */

/**
 * How many source indices to collapse into one output sample so that a run of
 * `count` points renders as at most ~`target` samples. `1` means "draw every
 * point" (no decimation needed). `target <= 0` also yields `1` (a degenerate
 * request to draw nothing is not this module's job - the caller clamps first).
 */
export function decimationStride(count: number, target: number): number {
	if (target <= 0 || count <= target) return 1;
	return Math.ceil(count / target);
}

/**
 * Indices to actually draw for the inclusive visible window `[lo, hi]`,
 * decimated to at most ~`target` samples. The first (`lo`) and last (`hi`)
 * indices are ALWAYS included so the drawn line still reaches both edges of the
 * window regardless of where the stride grid falls. Returns `[]` for an empty
 * window (`hi < lo`); a single-point window returns `[lo]`.
 */
export function decimatedIndices(lo: number, hi: number, target: number): number[] {
	if (hi < lo) return [];
	if (hi === lo) return [lo];

	const count = hi - lo + 1;
	const stride = decimationStride(count, target);

	if (stride <= 1) {
		// Dense enough already: emit the whole contiguous window.
		const out = new Array<number>(count);
		for (let i = 0; i < count; i++) out[i] = lo + i;
		return out;
	}

	const out: number[] = [];
	for (let i = lo; i < hi; i += stride) out.push(i);
	// Always terminate on the true last index rather than the last strided one,
	// so the line's right end is anchored to the real final sample.
	out.push(hi);
	return out;
}
