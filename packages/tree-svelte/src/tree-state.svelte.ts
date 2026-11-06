/**
 * Reactive UI state for a tree (Svelte 5 runes). Holds the ephemeral view
 * state — which nodes are expanded, highlight-selected, checkbox-checked,
 * focused, and each lazy branch's load status — separate from the forest data
 * itself (which the component owns and edits with the pure `core/tree` ops).
 *
 * Expanded / selected / checked are `SvelteSet`s: Svelte 5's `$state` proxy
 * does NOT intercept `Set`/`Map` mutator methods, so a plain `$state(new Set())`
 * would silently fail to notify readers on `.add()`/`.delete()`. `SvelteSet`
 * (mutated in place, never reassigned) is the supported way.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { LoadStatus, NodeId } from './core/types';

/** Highlight-selection behaviour. `none` disables row selection entirely. */
export type SelectionMode = 'none' | 'single' | 'multi';

export interface TreeStateOptions {
	/** Initially expanded node ids. */
	expanded?: Iterable<NodeId>;
	/** Initially highlight-selected node ids. */
	selected?: Iterable<NodeId>;
	/** Initially checkbox-checked leaf ids. */
	checked?: Iterable<NodeId>;
	/** Highlight-selection mode (default `'single'`). */
	selectionMode?: SelectionMode;
}

export class TreeState {
	/** Expanded node ids (children shown). Mutated in place. */
	readonly expandedIds: SvelteSet<NodeId>;
	/** Highlight-selected node ids. Mutated in place. */
	readonly selectedIds: SvelteSet<NodeId>;
	/** Checkbox-checked leaf ids (tri-state parents are derived). Mutated in place. */
	readonly checkedIds: SvelteSet<NodeId>;
	/** Per-lazy-branch async load status. */
	readonly loadStatus: SvelteMap<NodeId, LoadStatus>;
	/** The roving-focus node id (one `tabindex=0` at a time). */
	focusedId: NodeId | null = $state(null);
	/** Anchor for shift-range multi-selection (bookkeeping, not reactive-critical). */
	anchorId: NodeId | null = null;
	readonly selectionMode: SelectionMode;

	constructor(options: TreeStateOptions = {}) {
		this.expandedIds = new SvelteSet(options.expanded);
		this.selectedIds = new SvelteSet(options.selected);
		this.checkedIds = new SvelteSet(options.checked);
		this.loadStatus = new SvelteMap();
		this.selectionMode = options.selectionMode ?? 'single';
	}

	// --- expand/collapse ---
	isExpanded(id: NodeId): boolean {
		return this.expandedIds.has(id);
	}
	expand(id: NodeId): void {
		this.expandedIds.add(id);
	}
	collapse(id: NodeId): void {
		this.expandedIds.delete(id);
	}
	toggleExpanded(id: NodeId): void {
		if (this.expandedIds.has(id)) this.expandedIds.delete(id);
		else this.expandedIds.add(id);
	}

	// --- highlight selection ---
	isSelected(id: NodeId): boolean {
		return this.selectedIds.has(id);
	}
	/** Replace the selection with just `id` (plain click / single mode). */
	selectOnly(id: NodeId): void {
		this.selectedIds.clear();
		this.selectedIds.add(id);
		this.anchorId = id;
		this.focusedId = id;
	}
	/** Toggle `id` in the selection (ctrl/cmd click; multi mode only). */
	toggleSelected(id: NodeId): void {
		if (this.selectedIds.has(id)) this.selectedIds.delete(id);
		else this.selectedIds.add(id);
		this.anchorId = id;
		this.focusedId = id;
	}
	/** Replace the selection with `ids` (shift range; multi mode only). */
	selectRange(ids: NodeId[]): void {
		this.selectedIds.clear();
		for (const id of ids) this.selectedIds.add(id);
		this.focusedId = ids[ids.length - 1] ?? this.focusedId;
	}
	clearSelection(): void {
		this.selectedIds.clear();
		this.anchorId = null;
	}

	// --- checkboxes (apply a pure subtreeCheckToggle result in place) ---
	isChecked(id: NodeId): boolean {
		return this.checkedIds.has(id);
	}
	applyCheck(change: { add: NodeId[]; remove: NodeId[] }): void {
		for (const id of change.remove) this.checkedIds.delete(id);
		for (const id of change.add) this.checkedIds.add(id);
	}

	// --- lazy load status ---
	getLoadStatus(id: NodeId): LoadStatus {
		return this.loadStatus.get(id) ?? 'idle';
	}
	setLoadStatus(id: NodeId, status: LoadStatus): void {
		this.loadStatus.set(id, status);
	}
}
