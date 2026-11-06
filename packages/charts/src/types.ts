/**
 * Shared public types for @banto/charts (spec §6).
 *
 * `Accessor`/`getValue` intentionally mirror the pattern in
 * `@banto/grid-svelte`'s `GridColumn.accessor` / `getColumnValue` (spec §4.1)
 * so callers already familiar with the grid feel at home, and so grid rows
 * can be passed straight into a chart with the same kind of accessor. Charts
 * do NOT depend on @banto/grid-svelte (no runtime dependency, spec
 * constraint) - this is a local reimplementation.
 */

export type Accessor<TRow> = keyof TRow | ((row: TRow) => unknown);

/** Extract a raw value from a row via a grid-style accessor. */
export function getValue<TRow>(row: TRow, accessor: Accessor<TRow>): unknown {
	return typeof accessor === 'function' ? accessor(row) : (row[accessor] as unknown);
}

/** Coerce to a finite number; non-numeric/invalid values become NaN so the caller can skip the row (spec §6 data-format note). */
export function toNumber(value: unknown): number {
	return Number(value);
}

/** One data series shared across chart types that plot more than one value per category/x. */
export interface SeriesBase {
	/** Stable identifier; also used as the Svelte `#each` key. */
	id: string;
	label: string;
}

/** Margin (in px) reserved around the plot area for axes/labels. */
export interface ChartMargin {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export const DEFAULT_HEIGHT = 240;

/** One row of a chart's hover tooltip (spec §6 rule 6). */
export interface TooltipRow {
	label: string;
	value: string;
	/** CSS color (e.g. `seriesColorVar(i)`); omitted for rows with no series identity (e.g. scatter X/Y). */
	colorVar?: string;
}

/** Which y-scale a series/annotation is measured against (roadmap.md M13 第2Y軸). */
export type ChartAxis = 'left' | 'right';

/**
 * A shaded horizontal band across the plot marking a value range (roadmap.md
 * M13, しきい値バンド - e.g. an SPC control limit / acceptable-operating zone).
 * `from`/`to` are y-values in either order; `axis` picks which y-scale they are
 * read against when a chart has a second axis (defaults to `'left'`).
 */
export interface ThresholdBand {
	from: number;
	to: number;
	label?: string;
	/** CSS color; defaults to `var(--banto-chart-axis)`. */
	colorVar?: string;
	axis?: ChartAxis;
}

/**
 * `ThresholdBand` that may be open-ended (LineChart `bands`): a `null`/non-finite
 * `from` extends to the lower plot edge, a `null`/non-finite `to` to the upper
 * one. Every `ThresholdBand` is assignable to it.
 */
export interface OpenThresholdBand extends Omit<ThresholdBand, 'from' | 'to'> {
	from: number | null;
	to: number | null;
}

/**
 * A vertical event marker at a data index (roadmap.md M13, 注釈). `at` is a
 * DATA INDEX (0-based) rather than an x-value, because these charts treat x as
 * an index-spaced ordered category axis (see `core/ticks-time.ts`).
 */
export interface EventMarker {
	at: number;
	label?: string;
	/** CSS color; defaults to `var(--banto-chart-axis)`. */
	colorVar?: string;
}
