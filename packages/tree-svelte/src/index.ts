/**
 * `@banto/tree-svelte` — a hierarchical tree view (M-review 2026-08 follow-up).
 *
 * A dependency-free, headless pure-TS core (`core/`) with a thin Svelte 5
 * (Runes) UI. Ships as an optional, deletable package (template-scope §3.1):
 * the app imports it via a README recipe; it is not wired into the demo app.
 *
 * - {@link BantoTree}: the tree — expand/collapse, single/multi selection,
 *   tri-state checkboxes, lazy loading, drag reorder/reparent, inline rename,
 *   and an optional `columns` tree-grid mode.
 * - {@link TreeSelect}: a popover tree-select input.
 * - {@link TreeState}: the reactive UI-state model.
 * - `core/*`: pure, unit-tested tree math.
 */
export { default as BantoTree } from './BantoTree.svelte';
export { default as TreeSelect } from './TreeSelect.svelte';

export { TreeState, type SelectionMode, type TreeStateOptions } from './tree-state.svelte';
export { defaultTreeMessages, type TreeMessages } from './messages';

export {
	nodeHasChildren,
	isLeaf,
	findNode,
	findParent,
	nodePath,
	collectLeafIds,
	collectIds,
	flattenVisible,
	rangeIds,
	setNodeChildren,
	patchNode,
	canDrop,
	moveNode
} from './core/tree';
export { computeCheckState, subtreeCheckToggle } from './core/checkbox';

export type {
	NodeId,
	TreeNode,
	FlatNode,
	CheckState,
	LoadStatus,
	DropPosition,
	TreeColumn
} from './core/types';
