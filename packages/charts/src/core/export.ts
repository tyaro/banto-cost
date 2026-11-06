/**
 * SVG export (roadmap.md M13, "SVGエクスポート", one-time first scope - PNG is
 * backlog). Serializes a rendered chart's live `<svg>` into a standalone SVG
 * string that renders correctly OUTSIDE the app: components style
 * themselves via CSS custom-property references (`fill="var(--banto-chart-2)"`
 * attributes AND scoped `<style>` class rules like `.gridline { stroke:
 * var(--banto-chart-grid); }`), neither of which a detached clone can resolve
 * on its own once it leaves the live, styled document (no attached
 * stylesheet, no cascade, no inherited custom properties) - so every
 * relevant presentation property is baked onto the clone as an explicit
 * resolved value (via `getComputedStyle` on the ORIGINAL, still-attached
 * elements) before serializing.
 *
 * DOM-dependent end to end (elements, `getComputedStyle`, `XMLSerializer`,
 * `Blob`/`document`), so only the pure regex-substitution helper below is
 * Vitest-covered (`vite.config.ts` runs tests under `environment: 'node'`,
 * no DOM). `serializeChartSvg`/`downloadSvg` themselves are exercised
 * manually (dashboard demo) rather than unit tested.
 */

const CSS_VAR_REF = /var\((--[a-zA-Z0-9-]+)\)/g;

/**
 * Replace every `var(--x)` reference found in `value` with `resolve(name)`
 * (typically `getComputedStyle(el).getPropertyValue(name)`). A reference
 * `resolve` can't answer (empty/whitespace-only string) is left as the
 * original `var(...)` text rather than collapsing to `''`, so a missed or
 * typo'd variable fails visibly (a literal `var(--x)` left in the output) —
 * instead of silently vanishing into invalid/empty attribute values.
 */
export function inlineCssVarRefs(value: string, resolve: (name: string) => string): string {
	return value.replace(CSS_VAR_REF, (match, name: string) => {
		const resolved = resolve(name).trim();
		return resolved || match;
	});
}

/** SVG presentation properties baked from computed style onto the clone (covers both attribute-set and class-driven styling). */
const BAKED_PROPS = [
	'fill',
	'stroke',
	'stroke-width',
	'stroke-dasharray',
	'stroke-opacity',
	'fill-opacity',
	'opacity',
	'font-size',
	'font-family'
] as const;

/**
 * Clone `svg`, resolve every CSS custom-property reference to its computed
 * value, and serialize the result to a standalone SVG string. `opts.background`
 * additionally inserts an opaque background `<rect>` (resolved
 * `--banto-surface`) as the first child, spanning the full viewBox, since the
 * app's own charts are transparent (they rely on a page background behind
 * them) - a standalone export usually wants an opaque backing instead.
 */
export function serializeChartSvg(svg: SVGSVGElement, opts: { background?: boolean } = {}): string {
	const clone = svg.cloneNode(true) as SVGSVGElement;
	clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

	// Bake resolved presentation properties in lockstep tree order - `clone`
	// is a structural copy of `svg` taken above, before any further mutation,
	// so `querySelectorAll('*')` walks both in the same order/length.
	const originals: Element[] = [svg, ...Array.from(svg.querySelectorAll('*'))];
	const clones: Element[] = [clone, ...Array.from(clone.querySelectorAll('*'))];
	for (let i = 0; i < originals.length && i < clones.length; i++) {
		const computed = getComputedStyle(originals[i]);
		for (const prop of BAKED_PROPS) {
			const value = computed.getPropertyValue(prop).trim();
			if (value) clones[i].setAttribute(prop, value);
		}
	}

	// Fallback pass: any attribute outside BAKED_PROPS that still literally
	// contains a `var(--x)` reference (e.g. a future `stop-color`) is resolved
	// against the root svg's computed style.
	const rootStyle = getComputedStyle(svg);
	const resolve = (name: string) => rootStyle.getPropertyValue(name);
	for (const el of clones) {
		for (const attr of Array.from(el.attributes)) {
			if (attr.value.includes('var(')) {
				el.setAttribute(attr.name, inlineCssVarRefs(attr.value, resolve));
			}
		}
	}

	// Explicit width/height so the file has a sensible intrinsic size when
	// opened standalone - the live <svg> only carries `viewBox`; its 100%
	// sizing comes from ChartContainer's own CSS, which the export doesn't have.
	let viewBoxRect: [number, number, number, number] | null = null;
	const viewBox = clone.getAttribute('viewBox');
	if (viewBox) {
		const parts = viewBox.trim().split(/\s+/).map(Number);
		if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
			viewBoxRect = parts as [number, number, number, number];
			if (!clone.getAttribute('width')) clone.setAttribute('width', String(viewBoxRect[2]));
			if (!clone.getAttribute('height')) clone.setAttribute('height', String(viewBoxRect[3]));
		}
	}

	if (opts.background) {
		const [x, y, w, h] = viewBoxRect ?? [
			0,
			0,
			Number(clone.getAttribute('width') ?? 0),
			Number(clone.getAttribute('height') ?? 0)
		];
		const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		bg.setAttribute('x', String(x));
		bg.setAttribute('y', String(y));
		bg.setAttribute('width', String(w));
		bg.setAttribute('height', String(h));
		bg.setAttribute('fill', rootStyle.getPropertyValue('--banto-surface').trim() || '#ffffff');
		clone.insertBefore(bg, clone.firstChild);
	}

	return new XMLSerializer().serializeToString(clone);
}

/**
 * Serialize `svg` (with an opaque background - see `serializeChartSvg`) and
 * trigger a browser download named `filename` via a temporary `Blob` object
 * URL. No-op outside a browser environment (`typeof document === 'undefined'`,
 * e.g. SSR/build-time) rather than throwing.
 */
export function downloadSvg(svg: SVGSVGElement, filename: string): void {
	if (typeof document === 'undefined') return;

	const content = serializeChartSvg(svg, { background: true });
	const blob = new Blob([content], { type: 'image/svg+xml;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	} finally {
		URL.revokeObjectURL(url);
	}
}
