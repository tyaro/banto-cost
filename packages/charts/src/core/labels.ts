/**
 * Axis-label width estimation (pure, Vitest-covered - spec §6.2 keeps number
 * logic out of the components). SVG <text> cannot be measured before render
 * without a DOM round-trip, so margins that depend on label length (e.g. the
 * left margin of a horizontal bar chart holding category names) use a
 * per-character estimate instead: fullwidth/CJK glyphs are roughly square
 * (~1.18em, i.e. ~13px at the 11px tick font), everything else (~digits,
 * ASCII, halfwidth kana) averages ~0.62em. Deliberately slightly generous -
 * a few px of unused margin is invisible; a clipped label is not.
 *
 * The charts pass `fontSize` = the computed font size of a rendered label
 * (`internal/label-font.ts`, theme-dimension-tokens.md D9-b), since the label
 * CSS uses the rem type tokens; the 11px default is what they use until it
 * can be read (SSR, tests) and what direct callers get when they omit it.
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

const ELLIPSIS = '…';

/**
 * `text` shortened with a trailing ellipsis so its estimated width at
 * `fontSize` fits `maxWidth` (px); unchanged when it already fits. Used for
 * category labels whose margin hit its cap (absolute `max` or 40% of the
 * chart width): the cap wins so the plot never collapses, and the label is
 * cut visibly instead of overflowing the chart edge (the components keep the
 * full text in a `<title>`). Returns '' when not even the ellipsis fits.
 */
export function truncateLabel(text: string, maxWidth: number, fontSize = 11): string {
	if (estimateLabelWidth(text, fontSize) <= maxWidth) return text;
	// CJK fonts draw '…' fullwidth: budget it like a fullwidth glyph.
	const ellipsis = CJK_CHAR_WIDTH_EM * fontSize;
	const chars = [...text];
	while (chars.length > 0) {
		chars.pop();
		const prefix = chars.join('');
		if (estimateLabelWidth(prefix, fontSize) + ellipsis <= maxWidth) return prefix + ELLIPSIS;
	}
	return ellipsis <= maxWidth ? ELLIPSIS : '';
}

export interface AxisMarginOptions {
	fontSize?: number;
	/** Gap between the label's end and the plot edge (the `x = innerLeft - gap` offset used by the components). */
	gap?: number;
	min?: number;
	/**
	 * Absolute cap (px). Default: 140px at the 11px label font, scaled with
	 * `fontSize` so a larger rendered font (root font size / token override,
	 * D9-b) doesn't clip labels that fit at the standard size.
	 */
	max?: number;
}

const DEFAULT_MAX_MARGIN = 140;

/** The default absolute cap for `fontSize` (140px at 11px). */
function defaultMax(fontSize: number): number {
	return (DEFAULT_MAX_MARGIN * fontSize) / 11;
}

/**
 * Max share of the chart width each auto-grown margin may take. Left and
 * right are capped separately, so together they never exceed 80% and the
 * plot keeps at least 20% of the width.
 */
const MAX_TICK_MARGIN_RATIO = 0.4;

export interface TickMarginOptions extends AxisMarginOptions {
	/** Measured container width (px). Unknown/0 -> only the absolute `max` applies. */
	totalWidth?: number;
}

/** `max`, further capped at 40% of `totalWidth` when the width is known. */
function widthCap(max: number, totalWidth: number): number {
	return totalWidth > 0 ? Math.min(max, Math.floor(totalWidth * MAX_TICK_MARGIN_RATIO)) : max;
}

/**
 * Left margin needed to fit end-anchored axis labels (horizontal bar chart
 * category names): the longest estimated label + gap, clamped to [min, max]
 * so one pathological label can't crush the plot area. With `totalWidth`,
 * also capped at 40% of it (that cap wins over `min` in a very narrow chart).
 */
export function leftMarginFor(labels: string[], options: TickMarginOptions = {}): number {
	const { fontSize = 11, gap = 8, min = 48, totalWidth = 0 } = options;
	const max = widthCap(options.max ?? defaultMax(fontSize), totalWidth);
	const widest = labels.reduce(
		(acc, label) => Math.max(acc, estimateLabelWidth(label, fontSize)),
		0
	);
	// ceil (not round): a label that sets the margin must never be cut by `truncateLabel`.
	return Math.floor(Math.min(max, Math.ceil(Math.max(min, widest + gap))));
}

/** Grow `base` to fit the widest label (+ `gap`), capped by `max` and 40% of `totalWidth`; never below `base`. */
function growMargin(labels: string[], base: number, gap: number, o: TickMarginOptions): number {
	const { fontSize = 11, totalWidth = 0 } = o;
	const max = Math.floor(o.max ?? defaultMax(fontSize));
	let widest = 0;
	for (const label of labels) widest = Math.max(widest, estimateLabelWidth(label, fontSize));
	const cap = Math.max(base, widthCap(max, totalWidth));
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
 * the plot's right edge, so reserve that half (plus a small pad). With
 * `totalWidth`, capped at 40% of it like the other margins.
 */
export function rightMarginForLastTick(lastLabel: string, options: TickMarginOptions = {}): number {
	const { fontSize = 11, gap = 4, min = 16, totalWidth = 0 } = options;
	const margin = Math.round(Math.max(min, estimateLabelWidth(lastLabel, fontSize) / 2 + gap));
	// No absolute cap (as before); with `totalWidth`, at most 40% of it.
	return Math.min(margin, widthCap(Infinity, totalWidth));
}
