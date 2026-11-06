/**
 * Tooltip value formatting for `LineChart`.
 *
 * `formatTooltip` lets a caller format tooltip row values differently from the
 * axis tick labels, per series (tyaro/banto#376: a bit tag shows
 * `True` / `False` in the tooltip while the axis keeps plain numbers).
 */
import type { ChartAxis } from '../types';

/** Series info handed to `formatTooltip`. */
export interface TooltipSeriesInfo {
	id: string;
	label: string;
	axis: ChartAxis;
}

/** Tooltip-only value formatter: (value, series, data index) => text. */
export type FormatTooltip = (value: number, series: TooltipSeriesInfo, index: number) => string;

/**
 * Text for one tooltip row value.
 *
 * Non-finite values are `'-'` and never reach `formatTooltip`. Without
 * `formatTooltip` the axis formatter of the series' side is used
 * (left → `formatY`, right → `formatYRight`).
 */
export function formatTooltipValue(
	raw: number,
	series: TooltipSeriesInfo,
	index: number,
	formatTooltip: FormatTooltip | undefined,
	formatLeft: (n: number) => string,
	formatRight: (n: number) => string
): string {
	if (!Number.isFinite(raw)) return '-';
	if (formatTooltip) return formatTooltip(raw, series, index);
	return series.axis === 'right' ? formatRight(raw) : formatLeft(raw);
}
