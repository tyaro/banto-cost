/**
 * Box-plot statistics (roadmap.md M13, SPC/QC "箱ひげ図"). Pure number-array
 * in, five-number-summary + Tukey whiskers/outliers out - no knowledge of
 * rows/accessors or SVG geometry (the `BoxPlot` component maps `BoxStats`
 * onto a scale itself).
 */

/**
 * R-7 quantile (linear interpolation between the two closest ranks - the
 * method NumPy/Excel default to). `sorted` must already be ascending. `p` is
 * clamped to `[0, 1]`; a single-element array returns that element for any
 * `p` rather than interpolating against a nonexistent neighbor.
 */
export function quantileSorted(sorted: number[], p: number): number {
	const n = sorted.length;
	if (n === 0) return NaN;
	if (n === 1) return sorted[0];

	const clampedP = Math.min(1, Math.max(0, p));
	const rank = clampedP * (n - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return sorted[lo];

	const frac = rank - lo;
	return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export interface BoxStats {
	min: number;
	q1: number;
	median: number;
	q3: number;
	max: number;
	/** Lowest ACTUAL data point still within `q1 - 1.5*IQR` (Tukey fence). */
	whiskerLow: number;
	/** Highest actual data point still within `q3 + 1.5*IQR`. */
	whiskerHigh: number;
	/** Values outside the Tukey fence, ascending. */
	outliers: number[];
}

/**
 * Five-number summary + Tukey (1.5x IQR) whiskers/outliers for `values`.
 * Non-finite entries (NaN/Infinity) are dropped before computing anything, so
 * a single bad value can't NaN-poison the whole result. An empty or
 * all-non-finite input has no distribution to summarize and returns `null`
 * rather than a struct of NaNs.
 */
export function boxStats(values: number[]): BoxStats | null {
	const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
	if (finite.length === 0) return null;

	const min = finite[0];
	const max = finite[finite.length - 1];
	const q1 = quantileSorted(finite, 0.25);
	const median = quantileSorted(finite, 0.5);
	const q3 = quantileSorted(finite, 0.75);
	const iqr = q3 - q1;

	const lowFence = q1 - 1.5 * iqr;
	const highFence = q3 + 1.5 * iqr;

	const outliers = finite.filter((v) => v < lowFence || v > highFence);
	const within = finite.filter((v) => v >= lowFence && v <= highFence);

	// Whiskers extend to the most extreme value still inside the fence, not
	// to the fence itself - the classic Tukey box plot, so a whisker end is
	// always a real observed value. If EVERY value sits outside the fence
	// (only possible when IQR collapses to 0, e.g. one dominant outlier among
	// otherwise-identical values), there is no "within" point to anchor on;
	// fall back to the box edges [q1, q3] so the whiskers never point outside
	// the box itself.
	const whiskerLow = within.length > 0 ? within[0] : q1;
	const whiskerHigh = within.length > 0 ? within[within.length - 1] : q3;

	return { min, q1, median, q3, max, whiskerLow, whiskerHigh, outliers };
}
