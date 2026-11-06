/**
 * Data model for the tree view. Pure types — no Svelte, no DOM.
 *
 * A `TreeNode` is the caller's data shape. Children may be omitted for a
 * lazily-loaded branch: set `hasChildren: true` so the UI shows a disclosure
 * toggle before the children are fetched (the `loadChildren` prop supplies
 * them on first expand). The optional `data` payload is what tree-grid
 * columns and the caller's callbacks read.
 */

/** A node identifier. Stable across a node's lifetime. */
export type NodeId = string;

/** A hierarchical node. */
export interface TreeNode<TData = unknown> {
	id: NodeId;
	/** Human-readable label (rendered, and the default rename target). */
	label: string;
	/** Loaded children. Omit (with `hasChildren: true`) for a lazy branch. */
	children?: TreeNode<TData>[];
	/**
	 * For a lazy branch: `true` when the node CAN have children that are not
	 * yet loaded, so the UI shows a disclosure toggle before `loadChildren`
	 * runs. Ignored once `children` is a non-empty array.
	 */
	hasChildren?: boolean;
	/** Shown but not selectable / checkable / editable. */
	disabled?: boolean;
	/** Arbitrary payload read by tree-grid columns and caller callbacks. */
	data?: TData;
}

/**
 * A flattened, visible-only node — the unit the component renders in a single
 * `{#each}` (so the same list can later be windowed/virtualized). Produced by
 * {@link (flattenVisible:function)}.
 */
export interface FlatNode<TData = unknown> {
	node: TreeNode<TData>;
	/** 0-based depth; root nodes are `0`. Drives indentation and `aria-level` (level = depth + 1). */
	depth: number;
	/** Whether the node has (or may lazily have) children — shows a toggle. */
	hasChildren: boolean;
	/** Whether the node is currently expanded (its children are shown). */
	expanded: boolean;
	/** 1-based position among its siblings (`aria-posinset`). */
	posInSet: number;
	/** Number of siblings including itself (`aria-setsize`). */
	setSize: number;
	/** Parent node id, or `null` for a root. */
	parentId: NodeId | null;
}

/** Tri-state check value for a node's checkbox. */
export type CheckState = 'checked' | 'unchecked' | 'indeterminate';

/** Async child-load status for a lazy branch. */
export type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** Where a dragged node lands relative to a drop target. */
export type DropPosition = 'before' | 'after' | 'inside';

/**
 * A tree-grid column. This is a deliberate STRUCTURAL MIRROR of
 * `@banto/grid-svelte`'s `GridColumn` (kept lighter) — it is NOT imported,
 * because cross-`@banto/*` imports are banned (conventions §4). A tree that is
 * given `columns` renders as a tree-grid: the first column holds the
 * indent + disclosure + label, the rest render `data` values.
 */
export interface TreeColumn<TData = unknown> {
	/** Stable identifier (used as the `{#each}` key and `data-*` hooks). */
	id: string;
	/** Column header text. */
	header: string;
	/** How to read the cell value from a node's `data` (a key or a function). */
	accessor: keyof TData | ((data: TData | undefined, node: TreeNode<TData>) => unknown);
	/** Fixed column width in px (default 160). */
	width?: number;
	/** Cell text alignment (default 'left'). */
	align?: 'left' | 'right' | 'center';
	/** Format the resolved value to display text (default `String(value)`, `''` for null/undefined). */
	format?: (value: unknown, node: TreeNode<TData>) => string;
}
