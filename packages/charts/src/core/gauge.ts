/**
 * Gauge arc-angle + threshold-color math (spec §6.1 Gauge). The track sweeps
 * 270deg, from 135deg to 405deg in `core/pie.ts`'s angle convention (0deg =
 * +x/3 o'clock, clockwise) - that range traces up over the top and back down
 * to a 90deg gap centered at the bottom, the classic speedometer shape, and
 * feeds straight into `arcPath(cx, cy, rOuter, rInner, 135, gaugeAngle(...))`.
 */
export const GAUGE_START_DEG = 135;
export const GAUGE_SWEEP_DEG = 270;
export const GAUGE_END_DEG = GAUGE_START_DEG + GAUGE_SWEEP_DEG; // 405

/**
 * `value` clamped into `[min, max]`, expressed as a ratio 0..1 of that range.
 * A degenerate/inverted range (`max <= min`) yields 0 rather than dividing by
 * zero or a negative span. A non-finite `value` is treated as the range
 * floor (ratio 0) rather than propagating `NaN` into the arc geometry.
 */
export function gaugeRatio(value: number, min: number, max: number): number {
	if (max <= min || !Number.isFinite(value)) return 0;
	const clamped = Math.min(max, Math.max(min, value));
	return (clamped - min) / (max - min);
}

/**
 * Absolute end angle (degrees, `core/pie.ts` convention) of the value arc:
 * `GAUGE_START_DEG` when `value <= min`, `GAUGE_END_DEG` when `value >= max`,
 * linear in between. Pass this straight as `arcPath`'s `endDeg` alongside
 * `GAUGE_START_DEG` as `startDeg`.
 */
export function gaugeAngle(value: number, min: number, max: number): number {
	return GAUGE_START_DEG + gaugeRatio(value, min, max) * GAUGE_SWEEP_DEG;
}

export interface GaugeThresholds {
	warning?: number;
	danger?: number;
	/** Lower warning threshold: `value <= warningLow` is warning-colored (e.g. low-level alarm). */
	warningLow?: number;
	/** Lower danger threshold: `value <= dangerLow` is danger-colored; wins over `warningLow`. */
	dangerLow?: number;
}

/**
 * Value-arc color: a THEME status var (spec §6.4 rule 10 - never a
 * chart series slot), chosen by which threshold `value` has reached or
 * crossed ("crossed above", i.e. `value >= threshold`; the lower thresholds
 * `warningLow`/`dangerLow` match on `value <= threshold`). Danger wins over
 * warning (checked first); omitted thresholds never match, so no `thresholds`
 * prop at all means "always primary". A non-finite `value` never matches
 * and stays primary.
 */
export function gaugeColorVar(value: number, thresholds: GaugeThresholds = {}): string {
	if (thresholds.danger !== undefined && value >= thresholds.danger) return 'var(--banto-danger)';
	if (thresholds.dangerLow !== undefined && value <= thresholds.dangerLow)
		return 'var(--banto-danger)';
	if (thresholds.warning !== undefined && value >= thresholds.warning)
		return 'var(--banto-warning)';
	if (thresholds.warningLow !== undefined && value <= thresholds.warningLow)
		return 'var(--banto-warning)';
	return 'var(--banto-primary)';
}
