/**
 * Rendered label font size for the `core/labels.ts` width estimates
 * (theme-dimension-tokens.md D9-b). The label CSS uses the rem-based type
 * tokens (`--banto-font-size-xs/sm/md`), so the real size follows the root
 * font size and any token override; the margin math therefore reads the
 * computed `font-size` of a rendered label instead of assuming a constant.
 *
 * Where nothing can be read (SSR, node unit tests, a detached element) the
 * estimate keeps the pre-token tick font, `DEFAULT_LABEL_FONT_SIZE` (11px).
 */
import type { Attachment } from 'svelte/attachments';

/** Fallback (px) when the computed size is unavailable - the pre-token SVG tick font. */
export const DEFAULT_LABEL_FONT_SIZE = 11;

type GetComputedStyle = (element: Element) => { fontSize: string };

/** Computed `font-size` of `element` in px, or `fallback` when it can't be read. */
export function readFontSizePx(
	element: Element | null | undefined,
	fallback = DEFAULT_LABEL_FONT_SIZE,
	getStyle: GetComputedStyle | undefined = typeof getComputedStyle === 'function'
		? getComputedStyle
		: undefined
): number {
	if (!element || !getStyle) return fallback;
	const px = Number.parseFloat(getStyle(element).fontSize);
	return Number.isFinite(px) && px > 0 ? px : fallback;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Fixed text of the measuring probe: never empty, so its box always tracks the font. */
export const PROBE_TEXT = '0';

/**
 * A hidden `<text>` carrying the label's classes (so the same scoped
 * `font-size` rule applies) with a fixed, non-empty string, appended to the
 * label's root `<svg>` (after everything Svelte renders there, so it never
 * sits inside a keyed block's range). Returns null where it can't be made
 * (no owner SVG / DOM, e.g. node tests): the label itself is observed then.
 */
function createProbe(label: Element): SVGTextElement | null {
	const svg = (label as SVGElement).ownerSVGElement;
	const doc = label.ownerDocument;
	if (!svg || !doc) return null;
	const probe = doc.createElementNS(SVG_NS, 'text');
	probe.setAttribute('class', label.getAttribute('class') ?? '');
	probe.setAttribute('aria-hidden', 'true');
	probe.setAttribute('visibility', 'hidden');
	probe.setAttribute('data-banto-font-probe', '');
	probe.textContent = PROBE_TEXT;
	svg.appendChild(probe);
	return probe;
}

/**
 * Attachment for ONE representative label `<text>` (all labels of a class
 * share the size): reports the computed font size on mount and again whenever
 * a hidden probe with the same classes and a fixed non-empty text resizes - a
 * root font-size change or a token override at runtime resizes the glyphs,
 * so the margins re-estimate without a remount. The probe (not the label) is
 * observed because a label can be empty (e.g. `formatY` turning 0 into ''),
 * whose zero-size box would never report a font change.
 *
 * No feedback loop: the margin only moves the labels (`x`); the probe's size
 * depends on the font alone, and the callback is expected to store a
 * primitive `$state` (re-assigning the same number is a no-op). The first
 * read runs synchronously in the attach effect, i.e. before the first paint,
 * so the 11px fallback layout is never shown when the real size differs.
 * The caller's state starts at `DEFAULT_LABEL_FONT_SIZE`, which is also what
 * SSR and node tests (no attach) keep.
 */
export function trackFontSize(onChange: (px: number) => void): Attachment<Element> {
	return (element) => {
		const probe = createProbe(element);
		const target = probe ?? element;
		// An unreadable size (e.g. a transiently detached node) keeps the last
		// reported value instead of snapping back to the 11px fallback.
		const read = () => {
			const px = readFontSizePx(target, Number.NaN);
			if (!Number.isNaN(px)) onChange(px);
		};
		read();
		const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null;
		observer?.observe(target);
		if (!observer && !probe) return;
		return () => {
			observer?.disconnect();
			probe?.remove();
		};
	};
}
