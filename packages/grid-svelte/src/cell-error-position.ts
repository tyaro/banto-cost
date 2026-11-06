/** Local geometry only: does not resize the grid or change its scroll position. */
export interface ErrorRect {
	left: number;
	top: number;
	width: number;
	height: number;
}
export interface ErrorPosition {
	left: number;
	top?: number;
	/** Bottom edge in frame coordinates; CSS anchors it without measuring height. */
	bottomEdge?: number;
	width: number;
	maxHeight: number;
}

export function intersectErrorBounds(
	bounds: ErrorRect,
	clip: ErrorRect,
	x = true,
	y = true
): ErrorRect {
	const left = x ? Math.max(bounds.left, clip.left) : bounds.left;
	const top = y ? Math.max(bounds.top, clip.top) : bounds.top;
	const right = x
		? Math.min(bounds.left + bounds.width, clip.left + clip.width)
		: bounds.left + bounds.width;
	const bottom = y
		? Math.min(bounds.top + bounds.height, clip.top + clip.height)
		: bounds.top + bounds.height;
	return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Coordinates are relative to the frame, already intersected with the browser viewport. */
export function positionCellError(
	viewport: ErrorRect,
	editor: ErrorRect,
	gap: number
): ErrorPosition | null {
	if (viewport.width <= 0 || viewport.height <= 0 || editor.width <= 0 || editor.height <= 0)
		return null;
	const right = viewport.left + viewport.width;
	const bottom = viewport.top + viewport.height;
	if (
		editor.left >= right ||
		editor.left + editor.width <= viewport.left ||
		editor.top >= bottom ||
		editor.top + editor.height <= viewport.top
	)
		return null;
	// In a tiny viewport, reduce the inset rather than create negative space.
	const inset = Math.max(0, Math.min(gap, viewport.width / 4, viewport.height / 4));
	const left = viewport.left + inset;
	const width = viewport.width - 2 * inset;
	const belowTop = Math.max(viewport.top + inset, editor.top + editor.height + inset);
	const aboveBottom = Math.min(bottom - inset, editor.top - inset);
	const below = Math.max(0, bottom - inset - belowTop);
	const above = Math.max(0, aboveBottom - viewport.top - inset);
	// Choose the larger side without measuring the initially hidden content.
	// CSS top/bottom anchoring keeps even the first paint within these bounds.
	if (below >= above && below > 0) {
		return { left, top: belowTop, width, maxHeight: below };
	}
	if (above > 0) {
		return { left, bottomEdge: aboveBottom, width, maxHeight: above };
	}
	// A viewport barely larger than its editor has no separate side. Keep
	// the readable, scrollable region inside the frame, even if it overlaps.
	return { left, top: viewport.top + inset, width, maxHeight: viewport.height - 2 * inset };
}
