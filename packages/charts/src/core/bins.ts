/**
 * Histogram binning (roadmap.md M13, SPC/QC "ヒストグラム": auto bin count +
 * manual override, optional normal-curve overlay). Pure number-array in,
 * `Bin[]` out - no knowledge of rows/accessors or SVG geometry.
 */
import type { Point } from './path';
import { quantileSorted } from './boxplot';

export interface Bin {
	x0: number;
	x1: number;
	count: number;
}

/** Round `width` up to a "nice" 1/2/5 * 10^n step, mirroring the private `niceNumber` helper in core/scale.ts, so bin edges land on clean numbers instead of arbitrary decimals. */
function niceBinWidth(width: number): number {
	if (width <= 0) return 1;
	const exponent = Math.floor(Math.log10(width));
	const fraction = width / 10 ** exponent;
	let niceFraction: number;
	if (fraction <= 1) niceFraction = 1;
	else if (fraction <= 2) niceFraction = 2;
	else if (fraction <= 5) niceFraction = 5;
	else niceFraction = 10;
	return niceFraction * 10 ** exponent;
}

/**
 * Freedman-Diaconis bin count for `sorted` values spanning `[lo, hi]`: bin
 * width `2*IQR*n^(-1/3)`. When the IQR collapses to 0 (many repeated values,
 * or too few points to have a meaningful spread) that formula divides by
 * zero, so it falls back to Sturges' rule (`ceil(log2(n) + 1)`) instead.
 */
function autoBinCount(sorted: number[], lo: number, hi: number): number {
	const q1 = quantileSorted(sorted, 0.25);
	const q3 = quantileSorted(sorted, 0.75);
	const iqr = q3 - q1;
	if (iqr === 0) {
		return Math.max(1, Math.ceil(Math.log2(sorted.length) + 1));
	}
	const binWidth = (2 * iqr) / Math.cbrt(sorted.length);
	return Math.max(1, Math.ceil((hi - lo) / binWidth));
}

/**
 * Bin `values` into a histogram. `opts.binCount` forces an exact bin count;
 * otherwise it is computed automatically (Freedman-Diaconis, Sturges
 * fallback - see `autoBinCount`). `opts.domain` restricts which values are
 * binned (values outside it are dropped) and overrides the auto-detected
 * `[min, max]`; a reversed domain (`domain[0] > domain[1]`) is treated as
 * swapped, matching `niceTicks`' order-independence. Non-finite values
 * (NaN/Infinity) are always dropped. An empty result (no finite values, or
 * none within `opts.domain`) returns `[]`.
 */
export function histogramBins(
	values: number[],
	opts: { binCount?: number; domain?: [number, number] } = {}
): Bin[] {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length === 0) return [];

	let lo: number;
	let hi: number;
	if (opts.domain) {
		const [d0, d1] = opts.domain;
		[lo, hi] = d0 <= d1 ? [d0, d1] : [d1, d0];
	} else {
		lo = Math.min(...finite);
		hi = Math.max(...finite);
	}

	const inDomain = finite.filter((v) => v >= lo && v <= hi);
	if (inDomain.length === 0) return [];

	// Degenerate domain (a single unique value, or every in-range value
	// equal): there is no spread to divide into bins, so fabricate one bin
	// around the value - the same padding trick `niceTicks` (core/scale.ts)
	// uses for its min===max case.
	if (lo === hi) {
		const pad = lo === 0 ? 1 : Math.abs(lo) * 0.5;
		return [{ x0: lo - pad, x1: hi + pad, count: inDomain.length }];
	}

	const sorted = [...inDomain].sort((a, b) => a - b);
	const binCount = Math.max(1, Math.floor(opts.binCount ?? autoBinCount(sorted, lo, hi)));

	const width = niceBinWidth((hi - lo) / binCount);
	const niceLo = Math.floor(lo / width) * width;
	const niceHi = Math.ceil(hi / width) * width;
	const numBins = Math.max(1, Math.round((niceHi - niceLo) / width));

	const bins: Bin[] = Array.from({ length: numBins }, (_, i) => ({
		x0: Math.round((niceLo + i * width) * 1e9) / 1e9,
		x1: Math.round((niceLo + (i + 1) * width) * 1e9) / 1e9,
		count: 0
	}));

	for (const v of sorted) {
		// The last bin's upper edge is inclusive (a value exactly at `niceHi`
		// still belongs to the final bin, not a nonexistent bin past it), and
		// clamping guards against float noise nudging the index out of range.
		const idx = Math.min(numBins - 1, Math.max(0, Math.floor((v - niceLo) / width)));
		bins[idx].count += 1;
	}

	return bins;
}

/**
 * Normal-distribution probability-density curve over `domain`, sampled at
 * `samples` evenly-spaced points (for overlaying on a histogram, e.g.
 * `HistogramChart`'s optional normal-curve option). `stdDev <= 0` has no
 * defined distribution and returns `[]`. The result is a raw density curve
 * (area under it integrates to ~1, not to the histogram's point count) - to
 * overlay it on bin COUNTS, the caller scales each `y` by `binWidth * n`
 * (bin width times total sample count) before mapping through the y scale.
 */
export function normalCurvePoints(
	mean: number,
	stdDev: number,
	domain: [number, number],
	samples = 64
): Point[] {
	if (stdDev <= 0) return [];

	const [d0, d1] = domain[0] <= domain[1] ? domain : [domain[1], domain[0]];
	const n = Math.max(2, Math.floor(samples));
	const step = (d1 - d0) / (n - 1);
	const coeff = 1 / (stdDev * Math.sqrt(2 * Math.PI));

	const points: Point[] = [];
	for (let i = 0; i < n; i++) {
		const x = d0 + i * step;
		const z = (x - mean) / stdDev;
		points.push({ x, y: coeff * Math.exp(-0.5 * z * z) });
	}
	return points;
}
