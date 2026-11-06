/**
 * Pure scale/tick math (spec §6.2: number logic lives in `charts/core`,
 * separate from the SVG rendering layer, and is Vitest-covered).
 */

/** A numeric domain -> pixel range mapping function. */
export type LinearScale = (value: number) => number;

/**
 * Linear scale from a numeric domain to a pixel range. When the domain is
 * degenerate (`min === max`, e.g. a single data point or all-equal values)
 * every value maps to the range's midpoint rather than dividing by zero.
 */
export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
	const [d0, d1] = domain;
	const [r0, r1] = range;
	const span = d1 - d0;
	if (span === 0) {
		const mid = (r0 + r1) / 2;
		return () => mid;
	}
	return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** Round `value` to a "nice" 1/2/5 * 10^n number, rounding up (round=false, for the raw span) or to the nearest nice step (round=true). */
function niceNumber(value: number, round: boolean): number {
	if (value <= 0) return 0;
	const exponent = Math.floor(Math.log10(value));
	const fraction = value / 10 ** exponent;
	let niceFraction: number;
	if (round) {
		if (fraction < 1.5) niceFraction = 1;
		else if (fraction < 3) niceFraction = 2;
		else if (fraction < 7) niceFraction = 5;
		else niceFraction = 10;
	} else {
		if (fraction <= 1) niceFraction = 1;
		else if (fraction <= 2) niceFraction = 2;
		else if (fraction <= 5) niceFraction = 5;
		else niceFraction = 10;
	}
	return niceFraction * 10 ** exponent;
}

/**
 * "Nice ticks" axis algorithm (spec §6, rule 7): steps of 1/2/5 x 10^n,
 * targeting ~`count` ticks. Handles the degenerate `min === max` case (all
 * data equal, or a single point) by fabricating a small span around the
 * value so the axis still renders sensible ticks instead of a single line.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
	let lo = Math.min(min, max);
	let hi = Math.max(min, max);

	if (lo === hi) {
		if (lo === 0) {
			hi = 1;
		} else {
			const pad = Math.abs(lo) * 0.5;
			lo -= pad;
			hi += pad;
		}
	}

	const span = niceNumber(hi - lo, false);
	const step = niceNumber(span / Math.max(1, count - 1), true);
	const niceMin = Math.floor(lo / step) * step;
	const niceMax = Math.ceil(hi / step) * step;

	const ticks: number[] = [];
	const epsilon = step / 1e6;
	for (let value = niceMin; value <= niceMax + epsilon; value += step) {
		// Round away float-accumulation noise (e.g. 0.1 + 0.2) at a precision
		// far finer than any realistic step, so ticks come out as clean numbers.
		ticks.push(Math.round(value * 1e9) / 1e9);
	}
	return ticks;
}

/** Uniform-inset band scale for categorical axes (bar charts). */
export interface BandScale {
	/** Width of one band (excluding inter-band gap), in px. */
	bandwidth: number;
	/** Left/top edge of the band at `index`, in px. */
	start(index: number): number;
	/** Center of the band at `index`, in px. */
	center(index: number): number;
}

/**
 * `count` equal-width bands laid out across `range`, each inset by `padding`
 * (fraction of the per-band step reserved as gap, split evenly on both
 * sides). `padding` of 0 means bands touch edge-to-edge.
 */
export function bandScale(count: number, range: [number, number], padding = 0.2): BandScale {
	const [r0, r1] = range;
	const total = r1 - r0;
	if (count <= 0) {
		return { bandwidth: 0, start: () => r0, center: () => r0 };
	}
	const step = total / count;
	const bandwidth = Math.max(0, step * (1 - padding));
	const inset = (step - bandwidth) / 2;
	return {
		bandwidth,
		start: (index: number) => r0 + index * step + inset,
		center: (index: number) => r0 + index * step + inset + bandwidth / 2
	};
}
