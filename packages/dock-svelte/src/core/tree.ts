/**
 * Pure operations over the docked-layout tree (spec §5.1/§5.2, M8 Phase A).
 * No Svelte imports - unit-tested directly with Vitest, exactly like
 * `geometry.ts`. Every function returns a NEW tree (or `null`); none mutate
 * their input. `state.svelte.ts` is the only caller that reassigns
 * `DockState.layout` for reactivity - this module knows nothing about Svelte.
 *
 * ID generation for newly-created split/tabs nodes is always via an injected
 * `makeId` parameter (defaulting to `defaultMakeId`, which wraps
 * `crypto.randomUUID`) rather than calling it directly, so tests can pass a
 * deterministic counter and assert on generated ids.
 */
import type {
	DockLayout,
	DockNode,
	DockPanelNode,
	DockSplitNode,
	DockTabGroupNode,
	DropRegion
} from '../types';

/** Neither pane of a resized split may shrink below this fraction of the split's total (spec §5.2 resizing). */
export const MIN_PANE_FRACTION = 0.1;

/** Default id generator for new split/tabs nodes - see the module doc comment on why this is injected everywhere rather than called directly. */
export function defaultMakeId(): string {
	return crypto.randomUUID();
}

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.min(Math.max(index, 0), length - 1);
}

function evenSizes(count: number): number[] {
	return Array.from({ length: count }, () => 1 / count);
}

/** Rescale `sizes` proportionally so they sum to 1, preserving relative weights. Falls back to an even split if the input sums to 0 (or is empty). */
function normalizeSizesArray(sizes: number[]): number[] {
	if (sizes.length === 0) return [];
	const sum = sizes.reduce((a, b) => a + b, 0);
	if (!(sum > 0)) return evenSizes(sizes.length);
	return sizes.map((s) => s / sum);
}

/** Find a node (panel, tabs group, or split) anywhere in the tree by id. */
export function findNode(root: DockNode | null, id: string): DockNode | null {
	if (!root) return null;
	if (root.id === id) return root;
	if (root.type === 'split') {
		for (const child of root.children) {
			const found = findNode(child, id);
			if (found) return found;
		}
		return null;
	}
	if (root.type === 'tabs') {
		return root.children.find((c) => c.id === id) ?? null;
	}
	return null;
}

/** Find the split/tabs-group that directly contains the node with `id` (null for the root itself, or an id not present in the tree). */
export function findParent(
	root: DockNode | null,
	id: string
): DockSplitNode | DockTabGroupNode | null {
	if (!root || root.id === id) return null;
	if (root.type === 'split') {
		for (const child of root.children) {
			if (child.id === id) return root;
			const found = findParent(child, id);
			if (found) return found;
		}
		return null;
	}
	if (root.type === 'tabs') {
		return root.children.some((c) => c.id === id) ? root : null;
	}
	return null;
}

/** Every panel id currently in the docked tree (for pruning/validation against `floating`). */
export function collectPanelIds(root: DockNode | null): string[] {
	if (!root) return [];
	if (root.type === 'panel') return [root.id];
	if (root.type === 'tabs') return root.children.map((c) => c.id);
	return root.children.flatMap(collectPanelIds);
}

/** Collapse a split/tabs node that ended up with 0 or 1 children into `null` / that lone child. Leaves panels and multi-child nodes untouched. Pure - called after any structural removal. */
export function collapse(node: DockNode): DockNode | null {
	if (node.type === 'panel') return node;
	if (node.children.length === 0) return null;
	if (node.children.length === 1) return node.children[0];
	return node;
}

/**
 * Recursively repair a tree's `sizes` arrays: length must match `children`,
 * values must sum to ~1. Used internally after structural edits, and by
 * `DockState.hydrate` to repair drift in a persisted payload. Panels and tab
 * groups have no sizes and pass through unchanged (aside from recursing into
 * a tab group's children, which are always panels and therefore no-ops too).
 */
export function normalizeSizes(node: DockNode): DockNode {
	if (node.type !== 'split') return node;
	const children = node.children.map(normalizeSizes);
	const raw = node.sizes.length === children.length ? node.sizes : evenSizes(children.length);
	return { ...node, children, sizes: normalizeSizesArray(raw) };
}

function removeFromNode(node: DockNode, panelId: string): DockNode | null {
	if (node.type === 'panel') {
		return node.id === panelId ? null : node;
	}
	if (node.type === 'tabs') {
		const idx = node.children.findIndex((c) => c.id === panelId);
		if (idx === -1) return node;
		const children = node.children.filter((_, i) => i !== idx);
		let activeIndex = node.activeIndex;
		if (idx < activeIndex) activeIndex -= 1;
		activeIndex = clampIndex(activeIndex, children.length);
		return collapse({ ...node, children, activeIndex });
	}
	// split
	const results = node.children.map((c) => removeFromNode(c, panelId));
	const changed = results.some((r, i) => r !== node.children[i]);
	if (!changed) return node;
	const kept: DockNode[] = [];
	const keptSizes: number[] = [];
	results.forEach((r, i) => {
		if (r !== null) {
			kept.push(r);
			keptSizes.push(node.sizes[i] ?? 0);
		}
	});
	return collapse({ ...node, children: kept, sizes: normalizeSizesArray(keptSizes) });
}

/**
 * Remove a panel wherever it is in the tree, collapsing any split/tabs group
 * left with 0 or 1 children (propagating upward). Returns the new root, or
 * `null` if the tree became empty. A no-op (same tree, well - `null` in,
 * `null` out) when `root` is already empty or doesn't contain `panelId`.
 */
export function removePanel(root: DockNode | null, panelId: string): DockNode | null {
	if (!root) return null;
	return removeFromNode(root, panelId);
}

/** First leaf (panel or tabs group) reachable by always descending into the first child - used to pick a sane fallback drop target. */
function firstLeaf(node: DockNode): DockPanelNode | DockTabGroupNode {
	return node.type === 'split' ? firstLeaf(node.children[0]) : node;
}

/**
 * Resolve the effective drop target for `targetId`: always a panel or tabs
 * group (never a bare split - splits are pure layout and have no rendered
 * surface of their own to drop onto in Phase B). Redirects a panel that
 * lives inside a tab group to that group (dropping "on a tab" acts on the
 * whole group's pane, matching typical VSCode-style docking). Falls back to
 * the tree's first leaf when `targetId` isn't found (e.g. a stale id), so
 * `dockPanelIntoTree`/`splitInsert` never have to handle a "no such target"
 * case explicitly.
 */
function resolveTarget(root: DockNode, targetId: string): DockPanelNode | DockTabGroupNode {
	const node = findNode(root, targetId) ?? firstLeaf(root);
	if (node.type === 'split') return firstLeaf(node);
	if (node.type === 'panel') {
		const parent = findParent(root, node.id);
		if (parent && parent.type === 'tabs') return parent;
	}
	return node;
}

function replaceNodeById(
	root: DockNode,
	id: string,
	replace: (node: DockNode) => DockNode
): DockNode {
	if (root.id === id) return replace(root);
	if (root.type === 'split') {
		let changed = false;
		const children = root.children.map((c) => {
			const next = replaceNodeById(c, id, replace);
			if (next !== c) changed = true;
			return next;
		});
		return changed ? { ...root, children } : root;
	}
	// A tabs group's children are only ever addressed via the group itself
	// (see `resolveTarget`'s redirect) - nothing deeper to search here.
	return root;
}

function appendCenter(
	node: DockPanelNode | DockTabGroupNode,
	panel: DockPanelNode,
	makeId: () => string
): DockNode {
	if (node.type === 'tabs') {
		const children = [...node.children, panel];
		return { ...node, children, activeIndex: children.length - 1 };
	}
	return { type: 'tabs', id: makeId(), children: [node, panel], activeIndex: 1 };
}

/**
 * Build the "split, or flatten into an already-matching-direction split"
 * result for an edge-region drop. `target` must already be resolved (see
 * `resolveTarget`) and present in `root`. If `target`'s direct parent is a
 * split with the same direction this drop implies, the new panel is spliced
 * in as a sibling (evenly re-sized) instead of nesting a redundant single-use
 * split - keeps the tree shallow, per spec.
 */
export function splitInsert(
	root: DockNode,
	target: DockPanelNode | DockTabGroupNode,
	panel: DockPanelNode,
	region: 'left' | 'right' | 'top' | 'bottom',
	makeId: () => string = defaultMakeId
): DockNode {
	const direction: 'row' | 'column' = region === 'left' || region === 'right' ? 'row' : 'column';
	const before = region === 'left' || region === 'top';
	const parent = findParent(root, target.id);

	if (parent && parent.type === 'split' && parent.direction === direction) {
		const idx = parent.children.findIndex((c) => c.id === target.id);
		const insertAt = before ? idx : idx + 1;
		const children = parent.children.slice();
		children.splice(insertAt, 0, panel);
		const sizes = evenSizes(children.length);
		return replaceNodeById(root, parent.id, () => ({ ...parent, children, sizes }));
	}

	const newSplit: DockSplitNode = {
		type: 'split',
		id: makeId(),
		direction,
		children: before ? [panel, target] : [target, panel],
		sizes: [0.5, 0.5]
	};
	return replaceNodeById(root, target.id, () => newSplit);
}

/**
 * The core docking operation (spec §5.2): place `panel` into the docked tree
 * relative to `targetId`, per `region`.
 *  - `root === null` (nothing docked yet): the new panel just becomes the
 *    bare root, regardless of `targetId`/`region`.
 *  - `region: 'center'` onto a panel: wrap target + new panel into a new
 *    `tabs` node (new panel active). Onto a tabs group: append as a new,
 *    active tab.
 *  - `region: 'left'|'right'|'top'|'bottom'`: see `splitInsert`.
 */
export function dockPanelIntoTree(
	root: DockNode | null,
	panel: DockPanelNode,
	targetId: string,
	region: DropRegion,
	makeId: () => string = defaultMakeId
): DockNode {
	if (!root) return panel;
	const target = resolveTarget(root, targetId);

	if (region === 'center') {
		return replaceNodeById(root, target.id, (node) =>
			appendCenter(node as DockPanelNode | DockTabGroupNode, panel, makeId)
		);
	}
	return splitInsert(root, target, panel, region, makeId);
}

/** Change the visible tab of a tab group. Out-of-range indices clamp; an unknown `groupId` (or a `null` tree) is a no-op. */
export function setActiveTab(
	root: DockNode | null,
	groupId: string,
	index: number
): DockNode | null {
	if (!root) return root;
	return replaceNodeById(root, groupId, (node) => {
		if (node.type !== 'tabs') return node;
		return { ...node, activeIndex: clampIndex(index, node.children.length) };
	});
}

/** Reorder a tab within its group, keeping the same panel active across the move (tracked by id, not index). Out-of-range `from`/`to` or `from === to` is a no-op. */
export function moveTabWithinGroup(
	root: DockNode | null,
	groupId: string,
	from: number,
	to: number
): DockNode | null {
	if (!root) return root;
	return replaceNodeById(root, groupId, (node) => {
		if (node.type !== 'tabs') return node;
		const { children: original, activeIndex: originalActive } = node;
		if (from < 0 || from >= original.length || to < 0 || to >= original.length || from === to)
			return node;
		const children = original.slice();
		const [moved] = children.splice(from, 1);
		children.splice(to, 0, moved);
		const activeId = original[originalActive]?.id;
		const activeIndex = activeId ? children.findIndex((c) => c.id === activeId) : originalActive;
		return { ...node, children, activeIndex: activeIndex === -1 ? originalActive : activeIndex };
	});
}

/**
 * Resize a split's two adjacent panes around `dividerIndex` (between
 * `sizes[dividerIndex]` and `sizes[dividerIndex + 1]`) by `deltaFraction`,
 * keeping the pair's sum constant and clamping each to `MIN_PANE_FRACTION`.
 * An out-of-range `dividerIndex`, unknown `splitId`, or `null` tree is a
 * no-op.
 */
export function resizeSplit(
	root: DockNode | null,
	splitId: string,
	dividerIndex: number,
	deltaFraction: number
): DockNode | null {
	if (!root) return root;
	return replaceNodeById(root, splitId, (node) => {
		if (node.type !== 'split') return node;
		const i = dividerIndex;
		const j = dividerIndex + 1;
		if (i < 0 || j >= node.sizes.length) return node;

		const pairSum = node.sizes[i] + node.sizes[j];
		const min = MIN_PANE_FRACTION;
		if (pairSum < 2 * min) {
			// Degenerate pair (already too small to give both panes the
			// minimum) - split what little there is evenly rather than
			// letting one side go negative.
			const sizes = node.sizes.slice();
			sizes[i] = pairSum / 2;
			sizes[j] = pairSum / 2;
			return { ...node, sizes };
		}

		let a = node.sizes[i] + deltaFraction;
		a = Math.min(Math.max(a, min), pairSum - min);
		const b = pairSum - a;

		const sizes = node.sizes.slice();
		sizes[i] = a;
		sizes[j] = b;
		return { ...node, sizes };
	});
}

/**
 * The parts of the layout a structure change depends on: the docked tree's
 * shape and active tabs, and which floating windows exist and are open
 * (#432). Geometry, split sizes and z-order are left out (they change on
 * focus / move / resize and never invalidate a structure decision). Floating
 * ids are arbitrary strings, so they are encoded as sorted `[id, open]` pairs
 * inside the JSON - never joined with a delimiter that an id could contain.
 */
export function structureKey(layout: DockLayout): string {
	const node = (n: DockNode): unknown => {
		if (n.type === 'panel') return n.id;
		if (n.type === 'tabs') return [n.id, n.activeIndex, n.children.map((c) => c.id)];
		return [n.id, n.direction, n.children.map(node)];
	};
	const floating = layout.floating
		.map((w): [string, boolean] => [w.id, w.open])
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : Number(a[1]) - Number(b[1])));
	return JSON.stringify([floating, layout.docked ? node(layout.docked) : null]);
}
