/**
 * Pure row-virtualization math (fixed row height, spec §4.2).
 * No Svelte imports — usable standalone and easy to unit test.
 */

export interface ComputeWindowParams {
	scrollTop: number;
	viewportHeight: number;
	rowHeight: number;
	rowCount: number;
	/** Extra rows rendered above/below the visible viewport. Default 8. */
	overscan?: number;
}

export interface WindowResult {
	/** First rendered row index, inclusive. */
	start: number;
	/** Last rendered row index, exclusive. */
	end: number;
	/** translateY offset (px) applied to the rendered row block. */
	offsetY: number;
	/** Total scrollable height (px) of all rows, for the scroll spacer. */
	totalHeight: number;
}

/** Compute the virtualized row window for the current scroll position. */
export function computeWindow(params: ComputeWindowParams): WindowResult {
	const { scrollTop, viewportHeight, rowHeight, rowCount, overscan = 8 } = params;

	if (rowCount <= 0 || rowHeight <= 0) {
		return { start: 0, end: 0, offsetY: 0, totalHeight: 0 };
	}

	const totalHeight = rowCount * rowHeight;
	const safeScrollTop = Math.min(Math.max(0, scrollTop), Math.max(0, totalHeight - 1));
	const safeViewportHeight = Math.max(0, viewportHeight);

	const firstVisible = Math.floor(safeScrollTop / rowHeight);
	const visibleCount = Math.ceil(safeViewportHeight / rowHeight) + 1;

	const start = Math.max(0, firstVisible - overscan);
	const end = Math.min(rowCount, firstVisible + visibleCount + overscan);

	return { start, end, offsetY: start * rowHeight, totalHeight };
}
