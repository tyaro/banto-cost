/**
 * Axis-label width estimation (pure, Vitest-covered - spec §6.2 keeps number
 * logic out of the components). SVG <text> cannot be measured before render
 * without a DOM round-trip, so margins that depend on label length (e.g. the
 * left margin of a horizontal bar chart holding category names) use a
 * per-character estimate instead: fullwidth/CJK glyphs are roughly square
 * (~1.18em, i.e. ~13px at the 11px tick font), everything else (~digits,
 * ASCII, halfwidth kana) averages ~0.62em. Deliberately slightly generous -
 * a few px of unused margin is invisible; a clipped label is not.
 */

const CJK_CHAR_WIDTH_EM = 1.18;
const DEFAULT_CHAR_WIDTH_EM = 0.62;

/** True for characters rendered fullwidth (CJK ideographs, kana, fullwidth forms, CJK punctuation). */
function isFullwidth(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
		(codePoint >= 0x2e80 && codePoint <= 0x9fff) || // CJK radicals..ideographs (incl. kana 3040-30FF)
		(codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
		(codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compatibility forms
		(codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth forms
		(codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK extensions
	);
}

/** Estimated rendered width (px) of `text` at `fontSize` px. */
export function estimateLabelWidth(text: string, fontSize = 11): number {
	let em = 0;
	for (const char of text) {
		em += isFullwidth(char.codePointAt(0) ?? 0) ? CJK_CHAR_WIDTH_EM : DEFAULT_CHAR_WIDTH_EM;
	}
	return em * fontSize;
}

export interface AxisMarginOptions {
	fontSize?: number;
	/** Gap between the label's end and the plot edge (the `x = innerLeft - gap` offset used by the components). */
	gap?: number;
	min?: number;
	max?: number;
}

/**
 * Left margin needed to fit end-anchored axis labels (horizontal bar chart
 * category names): the longest estimated label + gap, clamped to [min, max]
 * so one pathological label can't crush the plot area.
 */
export function leftMarginFor(labels: string[], options: AxisMarginOptions = {}): number {
	const { fontSize = 11, gap = 8, min = 48, max = 140 } = options;
	const widest = labels.reduce(
		(acc, label) => Math.max(acc, estimateLabelWidth(label, fontSize)),
		0
	);
	return Math.round(Math.min(max, Math.max(min, widest + gap)));
}

/** Max share of the chart width each auto-grown y-axis margin may take. */
const MAX_TICK_MARGIN_RATIO = 0.4;

export interface TickMarginOptions extends AxisMarginOptions {
	/** Measured container width (px). Unknown/0 -> only the absolute `max` applies. */
	totalWidth?: number;
}

/** Grow `base` to fit the widest label (+ `gap`), capped by `max` and 40% of `totalWidth`; never below `base`. */
function growMargin(labels: string[], base: number, gap: number, o: TickMarginOptions): number {
	const { fontSize = 11, max = 140, totalWidth = 0 } = o;
	let widest = 0;
	for (const label of labels) widest = Math.max(widest, estimateLabelWidth(label, fontSize));
	const cap = Math.max(
		base,
		totalWidth > 0 ? Math.min(max, Math.floor(totalWidth * MAX_TICK_MARGIN_RATIO)) : max
	);
	return Math.min(cap, Math.max(base, Math.ceil(widest + gap)));
}

/**
 * Left margin needed to fit the end-anchored y tick labels of a value axis
 * (line/combo/area/scatter charts): `max(baseLeft, widest label + gap)`.
 * `baseLeft` is the caller's (or the chart's default) left margin and acts as
 * the minimum, so charts whose labels already fit keep their exact previous
 * layout; only clipped cases widen.
 *
 * The growth is capped (same policy as `leftMarginFor`: absolute `max`,
 * default 140px) and, when the container width is known (`totalWidth` > 0),
 * also at 40% of it, so a pathological label (e.g. `1e100` through the
 * default formatter, ~130 chars) can't squeeze the plot area to zero. When
 * capped, the label simply clips at the container edge rather than the plot
 * disappearing. The cap never goes below `baseLeft`.
 */
export function leftMarginForTicks(
	labels: string[],
	baseLeft: number,
	options: TickMarginOptions = {}
): number {
	return growMargin(labels, baseLeft, options.gap ?? 8, options);
}

/** Right-axis counterpart of `leftMarginForTicks` (start-anchored labels, 12px clearance), same cap policy. */
export function rightMarginForTicks(
	labels: string[],
	baseRight: number,
	options: TickMarginOptions = {}
): number {
	return growMargin(labels, baseRight, options.gap ?? 12, options);
}

/**
 * Right margin needed so the LAST middle-anchored tick label of a bottom
 * value axis doesn't clip at the container edge: half the label overhangs
 * the plot's right edge, so reserve that half (plus a small pad).
 */
export function rightMarginForLastTick(lastLabel: string, options: AxisMarginOptions = {}): number {
	const { fontSize = 11, gap = 4, min = 16 } = options;
	return Math.round(Math.max(min, estimateLabelWidth(lastLabel, fontSize) / 2 + gap));
}
