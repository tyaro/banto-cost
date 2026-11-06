/**
 * Categorical series color slots (spec §6.4 rule 1):
 * series take CSS var slots 1..8 IN FIXED ORDER by series index - never
 * cycle, never reassign when a series is removed (color follows the
 * entity, i.e. its position in the caller's `series`/`data` array).
 * More than 8 series is out of scope for v1; overflow series are clamped
 * to the last slot rather than wrapping back to slot 1 (wrapping would
 * silently alias a later series onto an earlier one's color).
 */
export const MAX_CHART_SERIES = 8;

export function seriesColorVar(index: number): string {
	const slot = Math.min(Math.max(index, 0) + 1, MAX_CHART_SERIES);
	return `var(--banto-chart-${slot})`;
}

/**
 * Sequential (single-hue, light -> dark) ramp for magnitude encodings (spec
 * §6.4 rule 9: a heatmap cell's color is a MAGNITUDE, not a category,
 * so it must never borrow from the categorical `seriesColorVar` slots - one
 * hue only, varying in lightness). Validated blue ramp, light to dark.
 */
export const SEQ_RAMP: readonly string[] = [
	'#cde2fb',
	'#9ec5f4',
	'#6da7ec',
	'#3987e5',
	'#256abf',
	'#184f95',
	'#0d366b'
];

/**
 * Bin `value` into one of `ramp`'s steps by its linear position within
 * `[min, max]` (step 0 = min end, last step = max end). Degenerate domains
 * (`min === max`, e.g. every cell holds the same value) map to the ramp's
 * middle step rather than always the lightest/darkest end, since there is no
 * "low" or "high" to distinguish. `ramp` defaults to `SEQ_RAMP` but accepts a
 * caller-supplied ramp of any length >= 1.
 */
export function sequentialColor(
	value: number,
	min: number,
	max: number,
	ramp: readonly string[] = SEQ_RAMP
): string {
	if (ramp.length === 0) return '';
	if (ramp.length === 1) return ramp[0];
	if (min === max) return ramp[Math.floor(ramp.length / 2)];

	const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
	const step = Math.min(ramp.length - 1, Math.floor(ratio * ramp.length));
	return ramp[step];
}
