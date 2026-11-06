/**
 * Public types for @banto/dock-svelte (spec §5). M7 shipped floating pseudo-
 * windows only; M8 Phase A (this file) adds the docked layout tree
 * (spec §5.1: "Panel, Split, TabGroup の再帰的な組み合わせ") as a sibling of
 * `floating` rather than a replacement for it - exactly the forward-compat
 * path the M7 doc comment called out. `version` bumps 1 -> 2 accordingly;
 * `DockState.hydrate` (state.svelte.ts) accepts both shapes, migrating a v1
 * payload to v2 with `docked: null`. z-order is still just array order (last
 * = frontmost) - no numeric z field to keep in sync or serialize.
 *
 * M8 Phase A is the pure data model + tree operations only (core/tree.ts,
 * core/dropzones.ts, and the new DockState methods) - no drag UI, no new
 * .svelte components. Those are Phase B, built on top of this shape.
 */

/** One floating pseudo-window's persisted geometry + open/closed state. */
export interface FloatingWindow {
	/** Panel id, unique within a DockLayout. */
	id: string;
	title: string;
	/** Emoji, shown in the titlebar. */
	icon?: string;
	/** Position in px, relative to the DockHost's top-left. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Closed panels keep their geometry around so reopening restores it. */
	open: boolean;
}

/** A single docked panel - the leaf of the docked tree. Same id space as `FloatingWindow`: a panel is either docked or floating, never both at once. */
export interface DockPanelNode {
	type: 'panel';
	/** Panel id, unique within a DockLayout (shared id space with `FloatingWindow.id`). */
	id: string;
	title: string;
	/** Emoji, shown in the tab/titlebar. */
	icon?: string;
}

/** A group of panels presented as tabs. Spec §5.1: tab groups only ever hold panels directly - no nested splits inside a tab group in v1. */
export interface DockTabGroupNode {
	type: 'tabs';
	/** Group id - distinct from any panel id, used to target the group itself (e.g. dropping onto its tab bar, or `setActiveTab`/`moveTab`). */
	id: string;
	children: DockPanelNode[];
	/** Index into `children` of the visible tab. */
	activeIndex: number;
}

/**
 * A split container: 2+ children laid out side by side (`row`, divided by a
 * vertical divider) or stacked (`column`, horizontal divider). `sizes` are
 * fractional weights (same length as `children`, summing to ~1) - see
 * `core/tree.ts#normalizeSizes` for how drift gets repaired.
 */
export interface DockSplitNode {
	type: 'split';
	id: string;
	direction: 'row' | 'column';
	children: DockNode[];
	sizes: number[];
}

/** Recursive docked-layout node (spec §5.1: "Panel, Split, TabGroup の再帰的な組み合わせ"). */
export type DockNode = DockPanelNode | DockTabGroupNode | DockSplitNode;

/**
 * Which region of a drop target's rect a pointer is over (spec §5.2:
 * "画面端・グループ端にドロップして分割（上下左右スナップ）"). `center` means
 * "add as a tab to the target panel/group"; the 4 edges mean "split the
 * target in that direction". Computed by `core/dropzones.ts#computeDropRegion`
 * and consumed by `core/tree.ts#dockPanelIntoTree` - Phase B renders the
 * corresponding snap-guide overlay from the same value.
 */
export type DropRegion = 'center' | 'left' | 'right' | 'top' | 'bottom';

/** Full serializable dock layout (spec §5.1: "レイアウト全体をJSONにシリアライズ/デシリアライズ可能に"). */
export interface DockLayout {
	/** Bump on breaking changes. v1 (M7) had no `docked` field; `DockState.hydrate` migrates it to `docked: null`. */
	version: 2;
	/** Render order = z-order; last entry is frontmost. */
	floating: FloatingWindow[];
	/** The docked tree, or `null` when nothing is docked (host shows only floating windows). */
	docked: DockNode | null;
}

/** Definition passed to `DockState.ensureWindow` / `reset` for a window that may not exist in the layout yet. */
export interface FloatingWindowDef {
	id: string;
	title: string;
	icon?: string;
	/** Falls back to geometry.ts's DEFAULT_WINDOW_WIDTH/HEIGHT when omitted. */
	width?: number;
	height?: number;
}

/** Resize handle positions (4 edges + 4 corners; spec §5.2 "自由な位置・サイズ変更"). */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Minimal shape passed to the `panel` snippet (M8 Phase B). Both
 * `FloatingWindow` and `DockPanelNode` structurally satisfy this (they carry
 * extra fields the snippet doesn't need), so `DockHost` can share ONE
 * `Snippet<[PanelContent]>` prop between docked panes (`DockedTree`) and
 * floating windows (`DockWindow`) instead of the caller having to branch on
 * which chrome rendered it.
 */
export interface PanelContent {
	id: string;
	title: string;
	icon?: string;
}
