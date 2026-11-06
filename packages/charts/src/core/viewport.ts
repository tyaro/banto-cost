/**
 * Zoom/pan viewport math for trend charts (roadmap.md M13, "ズーム/パン").
 * A `Viewport` is a window into INDEX space (data array indices
 * `0..count-1`, not pixels or data values) - `LineChart.svelte`/
 * `ComboChart.svelte` hold the `Viewport` as component state and call these
 * pure functions on wheel/drag events; this module has no knowledge of SVG,
 * pixels, or the underlying data values themselves.
 */

/** A window `[start, end]` into index space. Always `start < end`. */
export interface Viewport {
	start: number;
	end: number;
}

/**
 * The full-domain viewport for `count` data points: `{start: 0, end:
 * count-1}`. Degenerate counts (`0` or `1`, i.e. no span to show) still need
 * `start < end` per the `Viewport` contract, so they fabricate a unit span
 * `{0, 1}` rather than a zero/negative-width window.
 */
export function fullViewport(count: number): Viewport {
	return { start: 0, end: Math.max(1, count - 1) };
}

/**
 * `true` when `vp` already shows the entire `[0, count-1]` domain (e.g. to
 * decide whether a "reset zoom" affordance should be disabled). Compares
 * with a small epsilon since `zoomViewport`/`panViewport` round their output.
 */
export function isFullViewport(vp: Viewport, count: number): boolean {
	const domainSpan = Math.max(count - 1, 1);
	const epsilon = 1e-9;
	return vp.start <= epsilon && vp.end >= domainSpan - epsilon;
}

/**
 * Data-index range to actually render for `vp`: `[floor(start), ceil(end)]`,
 * clamped to `[0, count-1]`. The floor/ceil (rather than round) intentionally
 * keeps one extra data point of margin past each edge of a fractional
 * viewport, so a partially-panned line segment doesn't get clipped mid-line.
 */
export function visibleRange(vp: Viewport, count: number): [number, number] {
	const maxIndex = Math.max(count - 1, 0);
	const lo = Math.min(maxIndex, Math.max(0, Math.floor(vp.start)));
	const hi = Math.min(maxIndex, Math.max(0, Math.ceil(vp.end)));
	return [lo, hi];
}

/**
 * Zoom `vp` by `factor` (`< 1` zooms in/narrows, `> 1` zooms out/widens)
 * around the fixed point `focus` (an index-space position, typically the
 * cursor's data index under the pointer - it does not need to lie inside
 * `vp`, e.g. zooming from a legend/toolbar control uses the window center
 * instead). The resulting span is clamped to `[minSpan, count-1]` and the
 * window is clamped to stay inside `[0, count-1]`, so zooming out never
 * exceeds the data's full extent and zooming in never collapses past
 * `minSpan` points.
 */
export function zoomViewport(
	vp: Viewport,
	focus: number,
	factor: number,
	count: number,
	minSpan = 2
): Viewport {
	const domainSpan = Math.max(count - 1, 1);
	// A caller-requested `minSpan` larger than the entire domain (e.g. a tiny
	// dataset) is impossible to honor - fall back to the domain span itself
	// rather than a window wider than the data.
	const effectiveMinSpan = Math.min(Math.max(minSpan, 0), domainSpan);

	const span = vp.end - vp.start;
	const rawSpan = span * factor;
	const newSpan = Math.min(domainSpan, Math.max(effectiveMinSpan, rawSpan));

	// Fixed-point zoom: `focus` keeps the same relative position within the
	// window before and after. `span === 0` can't normally happen (the
	// `Viewport` contract requires `start < end`), but guard it anyway rather
	// than dividing by zero if a caller passes a malformed window.
	const ratio = span === 0 ? 0.5 : (focus - vp.start) / span;
	let start = focus - ratio * newSpan;
	let end = start + newSpan;

	if (start < 0) {
		end -= start;
		start = 0;
	}
	if (end > domainSpan) {
		start -= end - domainSpan;
		end = domainSpan;
	}
	start = Math.max(0, start);

	// Round away float-accumulation noise from repeated zoom gestures, same
	// precision `niceTicks` (core/scale.ts) uses.
	return {
		start: Math.round(start * 1e9) / 1e9,
		end: Math.round(end * 1e9) / 1e9
	};
}

/**
 * Pan `vp` by `delta` index-space units (positive = later/rightward),
 * preserving its span, clamped so the window stays inside `[0, count-1]`.
 */
export function panViewport(vp: Viewport, delta: number, count: number): Viewport {
	const domainSpan = Math.max(count - 1, 1);
	let start = vp.start + delta;
	let end = vp.end + delta;

	if (start < 0) {
		end -= start;
		start = 0;
	}
	if (end > domainSpan) {
		start -= end - domainSpan;
		end = domainSpan;
	}
	start = Math.max(0, start);

	return {
		start: Math.round(start * 1e9) / 1e9,
		end: Math.round(end * 1e9) / 1e9
	};
}
