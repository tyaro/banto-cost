/**
 * Public entry point for @banto/dock-svelte (spec §5).
 * M7 shipped floating pseudo-windows only (draggable/resizable, focus/
 * z-order, open/close, JSON layout serialize/restore) inside a host
 * container - no Tauri native windows (spec §5.3, still future work).
 * M8 Phase A adds the docked layout tree's pure data model + operations
 * (`core/tree.ts`, `core/dropzones.ts`) and the matching `DockState`
 * methods, as a sibling of `floating` (no breaking format change - see
 * `types.ts`). Phase B builds the drag-and-drop/snap-guide/tab-bar UI on top
 * of this; no new .svelte components ship in Phase A.
 */
export { default as DockHost } from './DockHost.svelte';
/** Gesture hook types of `DockHost` (`canStartGesture` / `onGestureEnd`; #433-b, shared-primitives-upstream-plan §3.3). */
export type {
	GestureCancelReason as DockCancelReason,
	GestureKind as DockGestureKind
} from './core/gesture.svelte';
/**
 * Pane lifecycle types of `DockHost` (`beforePanelChange` / `hidePanel` /
 * `closePanel`; #432, shared-primitives-upstream-plan §3.5 / §4.2 / D3-c / D4).
 * `structureKey` is the structure an async answer is checked against;
 * `DockState.structureRevision` counts its changes (a structure that came back
 * to the same shape still makes the answer stale).
 */
export { structureKey, type DockPanelChange, type DockPanelChangeOutcome } from './core/lifecycle';
export { DockState, createDockState } from './state.svelte';
export { defaultDockMessages, type DockMessages } from './messages';

export {
	applyDrag,
	applyResize,
	bringToFront,
	cascadePosition,
	clampWindowToHost,
	displayWindowGeometry,
	DEFAULT_MIN_HEIGHT,
	DEFAULT_MIN_VISIBLE,
	DEFAULT_MIN_WIDTH,
	DEFAULT_WINDOW_HEIGHT,
	DEFAULT_WINDOW_WIDTH,
	type ClampOptions
} from './core/geometry';

export {
	collapse,
	collectPanelIds,
	defaultMakeId,
	dockPanelIntoTree,
	findNode,
	findParent,
	MIN_PANE_FRACTION,
	moveTabWithinGroup,
	normalizeSizes,
	removePanel,
	resizeSplit,
	setActiveTab,
	splitInsert
} from './core/tree';

export {
	validateDockLayout,
	type DockLayoutIssue,
	type DockLayoutIssueCode,
	type DockLayoutValidation
} from './core/validate';

export { computeDropRegion } from './core/dropzones';

export { type DockCapabilities } from './core/policy';

export type {
	DockLayout,
	DockNode,
	DockPanelNode,
	DockSplitNode,
	DockTabGroupNode,
	DropRegion,
	FloatingWindow,
	FloatingWindowDef,
	PanelContent,
	ResizeEdge
} from './types';
