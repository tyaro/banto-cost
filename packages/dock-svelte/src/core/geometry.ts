/**
 * Pure geometry helpers for floating pseudo-windows (spec §5.1/§5.2, M7
 * scope). No Svelte imports - unit-tested directly with Vitest. All
 * functions are pure: they return a new `FloatingWindow` (or plain object)
 * rather than mutating the one passed in.
 */
import type { DropRegion, FloatingWindow, ResizeEdge } from '../types';

/** Minimum px of a window that must stay reachable inside the host on drag (spec §5.2: never draggable irretrievably off-screen). */
export const DEFAULT_MIN_VISIBLE = 48;
export const DEFAULT_MIN_WIDTH = 160;
export const DEFAULT_MIN_HEIGHT = 120;
/** Fallback geometry for a window opened without a saved/explicit size. */
export const DEFAULT_WINDOW_WIDTH = 360;
export const DEFAULT_WINDOW_HEIGHT = 280;
/** Cascade step (spec §5.2 initial placement) for windows without saved geometry. */
const CASCADE_STEP = 32;

/**
 * Consumer-supplied clamp policy (shared-primitives-upstream-plan §3.2, #434).
 * Every field is optional; the package defaults (`DEFAULT_MIN_*`) are generic
 * and carry no app's numbers - an app with larger minimums passes its own.
 */
export interface ClampOptions {
	/** Px of the window that must stay inside the host on each axis (default `DEFAULT_MIN_VISIBLE`). */
	minVisible?: number;
	/** Minimum window width in px (default `DEFAULT_MIN_WIDTH`). */
	minW?: number;
	/** Minimum window height in px (default `DEFAULT_MIN_HEIGHT`). */
	minH?: number;
	/**
	 * What to do when the host is narrower (or shorter) than `minW` (`minH`):
	 * - `'overflow'` (default): keep the minimum size; the window is larger
	 *   than the host and only `minVisible` px of it is guaranteed reachable.
	 * - `'fit'`: give up the minimum on that axis and shrink the window to the
	 *   host's size, so the whole window (title bar and close button included)
	 *   stays visible.
	 */
	narrowHost?: 'overflow' | 'fit';
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Clamp a window's size to [min, host] and its position so at least
 * `minVisible` px stays inside the host on both axes. When the host is too
 * small for any valid position range, the window is centered instead.
 * `opts.narrowHost` decides whether a host below the minimum size lets the
 * window overflow it or shrinks the window to fit.
 *
 * Pure: it returns a new window and never touches the saved layout. It serves
 * two callers with different consequences (shared-primitives-upstream-plan
 * §3.2): operations (`applyDrag` / new placement / `DockState.move`) write the
 * result back as the new preference, while rendering goes through
 * `displayWindowGeometry` and only DRAWS the result - a host that shrinks and
 * grows again does not rewrite the saved x/y/width/height.
 */
export function clampWindowToHost(
	win: FloatingWindow,
	hostW: number,
	hostH: number,
	opts: ClampOptions = {}
): FloatingWindow {
	const minVisible = opts.minVisible ?? DEFAULT_MIN_VISIBLE;
	const fit = opts.narrowHost === 'fit';
	const baseMinW = opts.minW ?? DEFAULT_MIN_WIDTH;
	const baseMinH = opts.minH ?? DEFAULT_MIN_HEIGHT;
	const minW = fit ? Math.min(baseMinW, Math.max(0, hostW)) : baseMinW;
	const minH = fit ? Math.min(baseMinH, Math.max(0, hostH)) : baseMinH;

	const width = clamp(win.width, minW, Math.max(minW, hostW));
	const height = clamp(win.height, minH, Math.max(minH, hostH));

	const minX = minVisible - width;
	const maxX = hostW - minVisible;
	// 'fit' on a squeezed axis: the window IS the host on that axis, so it sits at the edge.
	const squeezedX = fit && hostW < baseMinW;
	const squeezedY = fit && hostH < baseMinH;
	const x = squeezedX ? 0 : maxX >= minX ? clamp(win.x, minX, maxX) : (hostW - width) / 2;

	const minY = minVisible - height;
	const maxY = hostH - minVisible;
	const y = squeezedY ? 0 : maxY >= minY ? clamp(win.y, minY, maxY) : (hostH - height) / 2;

	return { ...win, x, y, width, height };
}

/**
 * The geometry to DRAW for a saved window in a host of the current size
 * (shared-primitives-upstream-plan §3.2, #434): the saved "preferred"
 * placement clamped by `opts`, so a floating window stays reachable when the
 * host shrinks. The saved layout is not modified - when the host grows back
 * the window returns to its preferred place. A not-yet-measured host
 * (`hostW`/`hostH` <= 0, before the first size binding) draws the saved
 * geometry unchanged rather than squashing it to the minimums.
 */
export function displayWindowGeometry(
	win: FloatingWindow,
	hostW: number,
	hostH: number,
	opts: ClampOptions = {}
): FloatingWindow {
	if (!(hostW > 0) || !(hostH > 0)) return win;
	return clampWindowToHost(win, hostW, hostH, opts);
}

/** Move a window by (dx, dy), then clamp to the host (spec §5.2 drag-by-titlebar). */
export function applyDrag(
	win: FloatingWindow,
	dx: number,
	dy: number,
	hostW: number,
	hostH: number,
	opts: ClampOptions = {}
): FloatingWindow {
	return clampWindowToHost({ ...win, x: win.x + dx, y: win.y + dy }, hostW, hostH, opts);
}

/**
 * Resize one axis (x&width, or y&height) for a single moving edge. `moving`
 * says which end of the axis the pointer drag is attached to; the opposite
 * end (`fixedEnd` below, or `startPos` itself) is always preserved exactly,
 * including when a minima/host-bound clamp has to adjust both the position
 * and the size together.
 */
function resizeAxis(
	startPos: number,
	startSize: number,
	delta: number,
	moving: 'start' | 'end' | 'none',
	hostSize: number,
	minSize: number
): { pos: number; size: number } {
	if (moving === 'none') return { pos: startPos, size: startSize };

	if (moving === 'end') {
		// startPos (the opposite edge) stays fixed; only size changes.
		let size = startSize + delta;
		size = Math.max(minSize, size);
		const maxSize = Math.max(minSize, hostSize - startPos);
		size = Math.min(size, maxSize);
		return { pos: startPos, size };
	}

	// moving === 'start': the opposite edge (fixedEnd) stays fixed; pos and
	// size are recomputed together so pos + size === fixedEnd always holds.
	const fixedEnd = startPos + startSize;
	let pos = startPos + delta;
	pos = Math.max(0, pos);
	let size = fixedEnd - pos;
	if (size < minSize) {
		size = minSize;
		pos = fixedEnd - size;
	}
	if (pos < 0) {
		// Host too small for minSize at this fixedEnd - clamp to the edge and
		// let size absorb the difference rather than pushing pos negative.
		pos = 0;
		size = fixedEnd - pos;
	}
	return { pos, size };
}

/**
 * Resize from one of the 8 handles (4 edges + 4 corners). The edge(s) named
 * in `edge` move; the opposite edge(s) stay fixed. Respects `minW`/`minH`
 * and keeps the moving edge within [0, host] on that axis.
 */
export function applyResize(
	win: FloatingWindow,
	edge: ResizeEdge,
	dx: number,
	dy: number,
	hostW: number,
	hostH: number,
	minW: number = DEFAULT_MIN_WIDTH,
	minH: number = DEFAULT_MIN_HEIGHT
): FloatingWindow {
	const hasWest = edge.includes('w');
	const hasEast = edge.includes('e');
	const hasNorth = edge.includes('n');
	const hasSouth = edge.includes('s');

	const horizontalMoving = hasWest ? 'start' : hasEast ? 'end' : 'none';
	const verticalMoving = hasNorth ? 'start' : hasSouth ? 'end' : 'none';

	const horizontal = resizeAxis(win.x, win.width, dx, horizontalMoving, hostW, minW);
	const vertical = resizeAxis(win.y, win.height, dy, verticalMoving, hostH, minH);

	return {
		...win,
		x: horizontal.pos,
		y: vertical.pos,
		width: horizontal.size,
		height: vertical.size
	};
}

/**
 * Move a window to the front of z-order (spec §5.2: render order IS z-order,
 * last entry = frontmost - no numeric z field). Idempotent: focusing the
 * already-frontmost window returns the same layout reference.
 */
export function bringToFront<T extends { floating: FloatingWindow[] }>(layout: T, id: string): T {
	const index = layout.floating.findIndex((w) => w.id === id);
	if (index === -1 || index === layout.floating.length - 1) return layout;
	const next = layout.floating.slice();
	const [win] = next.splice(index, 1);
	next.push(win);
	return { ...layout, floating: next };
}

/**
 * Initial placement for a window with no saved geometry: staggered by
 * `CASCADE_STEP` px per index, wrapping back to the origin once the stagger
 * would run out of room in the host (spec §5.2 initial placement).
 */
export function cascadePosition(
	index: number,
	hostW: number,
	hostH: number,
	defaultW: number,
	defaultH: number
): { x: number; y: number } {
	const availX = Math.max(0, hostW - defaultW);
	const availY = Math.max(0, hostH - defaultH);
	const avail = Math.min(availX, availY);
	const maxSteps = Math.max(1, Math.floor(avail / CASCADE_STEP) + 1);
	const step = index % maxSteps;
	return { x: step * CASCADE_STEP, y: step * CASCADE_STEP };
}

/**
 * Plain rectangle in some consistent coordinate space (host-relative px
 * throughout Phase B's drag/snap-guide code - see `core/drag.svelte.ts`).
 */
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Convert an incremental pointer-drag delta (px) into a split `sizes`
 * fraction, given the split container's measured size along the drag axis
 * (spec §5.2 split resizing, M8 Phase B - the divider drag in
 * `DockedTree.svelte`). Guards the degenerate `containerSizePx <= 0` case
 * (e.g. a not-yet-measured container) by returning 0 rather than `NaN`/
 * `Infinity`, so a stray event before layout never corrupts `sizes`.
 */
export function pixelDeltaToFraction(deltaPx: number, containerSizePx: number): number {
	if (!(containerSizePx > 0)) return 0;
	return deltaPx / containerSizePx;
}

/**
 * The snap-guide sub-rectangle for a `DropRegion` within a drop target's full
 * `rect` (M8 Phase B, spec §5.2 "ドラッグ中のドロップ位置プレビュー（スナップ
 * ガイド表示）") - half the target for an edge region (matching
 * `computeDropRegion`'s `edgeRatio`-independent split-in-half convention,
 * since that's where `core/tree.ts#splitInsert` actually divides the space),
 * the whole target for `'center'` (a new/joined tab covers the whole pane).
 */
export function dropRegionRect(rect: Rect, region: DropRegion): Rect {
	const { x, y, width, height } = rect;
	switch (region) {
		case 'left':
			return { x, y, width: width / 2, height };
		case 'right':
			return { x: x + width / 2, y, width: width / 2, height };
		case 'top':
			return { x, y, width, height: height / 2 };
		case 'bottom':
			return { x, y: y + height / 2, width, height: height / 2 };
		default:
			return rect;
	}
}
