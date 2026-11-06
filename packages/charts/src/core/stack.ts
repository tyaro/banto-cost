/**
 * Stacked-bar offset math (spec §6, BarChart `stacked` option). Pure
 * number-matrix in, running-offset segments out; no knowledge of rows/
 * accessors (BarChart.svelte extracts the matrix via the series accessors).
 */

export interface StackSegment {
	seriesIndex: number;
	value: number;
	/** Running offset before this segment (closer to the zero baseline). */
	start: number;
	/** Running offset after this segment. */
	end: number;
}

/**
 * For each category (row of `matrix`), compute running start/end offsets per
 * series index. Positive values stack upward from 0 and negative values
 * stack downward from 0 independently, so a mixed-sign stack never overlaps.
 * Non-finite values (NaN from `toNumber`) are treated as 0 (zero-height
 * segment) rather than dropped, so the segment index still lines up with its
 * series/color slot (spec §6 rule 1).
 */
export function stackSeries(matrix: number[][]): StackSegment[][] {
	return matrix.map((row) => {
		let posOffset = 0;
		let negOffset = 0;
		return row.map((raw, seriesIndex) => {
			const value = Number.isFinite(raw) ? raw : 0;
			if (value >= 0) {
				const start = posOffset;
				posOffset += value;
				return { seriesIndex, value, start, end: posOffset };
			}
			const end = negOffset;
			negOffset += value;
			return { seriesIndex, value, start: negOffset, end };
		});
	});
}
