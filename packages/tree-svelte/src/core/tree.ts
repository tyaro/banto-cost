/**
 * Pure operations over a tree of {@link TreeNode}s. No Svelte, no DOM — every
 * function is deterministic and directly unit-testable with Vitest.
 *
 * Structural edits ({@link moveNode}, {@link setNodeChildren},
 * {@link patchNode}) are IMMUTABLE: they return a NEW forest, or the SAME
 * reference when nothing changed (so a `$state`-held forest only re-renders
 * the subtrees that actually changed). Every op is total: an unknown id or an
 * out-of-range move is a no-op that returns the input unchanged.
 */
import type { DropPosition, FlatNode, NodeId, TreeNode } from './types';

/** Whether a node has, or may lazily have, children (shows a disclosure toggle). */
export function nodeHasChildren(node: TreeNode): boolean {
	return (node.children !== undefined && node.children.length > 0) || node.hasChildren === true;
}

/** Whether a node is a leaf (no children and not a lazy branch). */
export function isLeaf(node: TreeNode): boolean {
	return !nodeHasChildren(node);
}

/** Find a node by id anywhere in the forest, or `null`. */
export function findNode<TData>(roots: TreeNode<TData>[], id: NodeId): TreeNode<TData> | null {
	for (const node of roots) {
		if (node.id === id) return node;
		if (node.children) {
			const found = findNode(node.children, id);
			if (found) return found;
		}
	}
	return null;
}

/** Find the parent of `id`, or `null` if it is a root or not present. */
export function findParent<TData>(roots: TreeNode<TData>[], id: NodeId): TreeNode<TData> | null {
	for (const node of roots) {
		if (node.children) {
			if (node.children.some((child) => child.id === id)) return node;
			const found = findParent(node.children, id);
			if (found) return found;
		}
	}
	return null;
}

/**
 * The id path from a root down to `id` (inclusive), or `[]` if not found.
 * Useful to expand every ancestor so a node can be revealed.
 */
export function nodePath<TData>(roots: TreeNode<TData>[], id: NodeId): NodeId[] {
	for (const node of roots) {
		if (node.id === id) return [node.id];
		if (node.children) {
			const sub = nodePath(node.children, id);
			if (sub.length > 0) return [node.id, ...sub];
		}
	}
	return [];
}

/** All descendant LEAF ids of `node` (a leaf includes itself). */
export function collectLeafIds(node: TreeNode): NodeId[] {
	if (isLeaf(node)) return [node.id];
	const out: NodeId[] = [];
	for (const child of node.children ?? []) out.push(...collectLeafIds(child));
	return out;
}

/** Every id in the subtree rooted at `node` (inclusive). */
export function collectIds(node: TreeNode): NodeId[] {
	const out: NodeId[] = [node.id];
	for (const child of node.children ?? []) out.push(...collectIds(child));
	return out;
}

/**
 * Flatten the forest to the visible nodes only (a node's children are
 * included iff `isExpanded(node.id)` is true), depth-first in sibling order.
 * The result is a flat array ready for a single `{#each}` render (and later
 * windowing/virtualization).
 */
export function flattenVisible<TData>(
	roots: TreeNode<TData>[],
	isExpanded: (id: NodeId) => boolean
): FlatNode<TData>[] {
	const out: FlatNode<TData>[] = [];
	const walk = (nodes: TreeNode<TData>[], depth: number, parentId: NodeId | null): void => {
		const setSize = nodes.length;
		nodes.forEach((node, index) => {
			const hasChildren = nodeHasChildren(node);
			const expanded = hasChildren && isExpanded(node.id);
			out.push({
				node,
				depth,
				hasChildren,
				expanded,
				posInSet: index + 1,
				setSize,
				parentId
			});
			if (expanded && node.children && node.children.length > 0) {
				walk(node.children, depth + 1, node.id);
			}
		});
	};
	walk(roots, 0, null);
	return out;
}

/**
 * Ids of the visible nodes between `anchorId` and `targetId` (inclusive), in
 * visible order — for shift-range multi-selection. Either id missing from the
 * flattened list yields `[]`.
 */
export function rangeIds(flat: FlatNode[], anchorId: NodeId, targetId: NodeId): NodeId[] {
	const a = flat.findIndex((f) => f.node.id === anchorId);
	const b = flat.findIndex((f) => f.node.id === targetId);
	if (a === -1 || b === -1) return [];
	const [lo, hi] = a <= b ? [a, b] : [b, a];
	return flat.slice(lo, hi + 1).map((f) => f.node.id);
}

// --- immutable structural edits ---------------------------------------------

/**
 * Replace the children array of the node with `id`. Returns a NEW forest, or
 * the same reference when `id` is absent. Used to install lazily-loaded
 * children.
 */
export function setNodeChildren<TData>(
	roots: TreeNode<TData>[],
	id: NodeId,
	children: TreeNode<TData>[]
): TreeNode<TData>[] {
	return mapForest(roots, id, (node) => ({ ...node, children, hasChildren: children.length > 0 }));
}

/**
 * Shallow-merge `patch` into the node with `id` (e.g. `{ label }` for an
 * inline rename). Returns a NEW forest, or the same reference when `id` is
 * absent or the patch changes nothing.
 */
export function patchNode<TData>(
	roots: TreeNode<TData>[],
	id: NodeId,
	patch: Partial<TreeNode<TData>>
): TreeNode<TData>[] {
	return mapForest(roots, id, (node) => {
		let changed = false;
		for (const key of Object.keys(patch) as (keyof TreeNode<TData>)[]) {
			if (node[key] !== patch[key]) {
				changed = true;
				break;
			}
		}
		return changed ? { ...node, ...patch } : node;
	});
}

/** Rebuild only the spine to `id`, applying `replace`; unchanged spine keeps its reference. */
function mapForest<TData>(
	nodes: TreeNode<TData>[],
	id: NodeId,
	replace: (node: TreeNode<TData>) => TreeNode<TData>
): TreeNode<TData>[] {
	let changed = false;
	const next = nodes.map((node) => {
		if (node.id === id) {
			const replaced = replace(node);
			if (replaced !== node) changed = true;
			return replaced;
		}
		if (node.children) {
			const children = mapForest(node.children, id, replace);
			if (children !== node.children) {
				changed = true;
				return { ...node, children };
			}
		}
		return node;
	});
	return changed ? next : nodes;
}

/**
 * Whether dragging `dragId` onto `targetId` at `position` is a legal move:
 * both nodes exist, they differ, and the target is NOT inside the dragged
 * subtree (which would detach the subtree from the forest). `inside` onto a
 * leaf target is allowed (it becomes a branch).
 */
export function canDrop<TData>(
	roots: TreeNode<TData>[],
	dragId: NodeId,
	targetId: NodeId,
	_position: DropPosition
): boolean {
	if (dragId === targetId) return false;
	const dragged = findNode(roots, dragId);
	const target = findNode(roots, targetId);
	if (!dragged || !target) return false;
	// Target must not be the dragged node's own descendant (cycle) — collectIds
	// includes dragId itself, already excluded above.
	return !collectIds(dragged).includes(targetId);
}

/**
 * Move `dragId` to sit `before`/`after` `targetId`, or `inside` it (appended
 * as its last child). Returns a NEW forest, or the SAME reference when the
 * move is illegal ({@link canDrop} false) or a genuine no-op.
 */
export function moveNode<TData>(
	roots: TreeNode<TData>[],
	dragId: NodeId,
	targetId: NodeId,
	position: DropPosition
): TreeNode<TData>[] {
	if (!canDrop(roots, dragId, targetId, position)) return roots;
	const dragged = findNode(roots, dragId);
	if (!dragged) return roots;

	// 1. Detach the dragged node from wherever it is.
	const without = removeNode(roots, dragId);

	// 2. Insert it relative to the (still-present) target.
	if (position === 'inside') {
		return mapForest(without, targetId, (node) => ({
			...node,
			children: [...(node.children ?? []), dragged],
			hasChildren: true
		}));
	}
	return insertSibling(without, targetId, dragged, position);
}

/** Remove the node with `id`, returning a new forest (or same ref if absent). */
function removeNode<TData>(nodes: TreeNode<TData>[], id: NodeId): TreeNode<TData>[] {
	let changed = false;
	const filtered: TreeNode<TData>[] = [];
	for (const node of nodes) {
		if (node.id === id) {
			changed = true;
			continue;
		}
		if (node.children) {
			const children = removeNode(node.children, id);
			if (children !== node.children) {
				changed = true;
				filtered.push({ ...node, children });
				continue;
			}
		}
		filtered.push(node);
	}
	return changed ? filtered : nodes;
}

/** Insert `moved` immediately before/after the sibling `targetId`. */
function insertSibling<TData>(
	nodes: TreeNode<TData>[],
	targetId: NodeId,
	moved: TreeNode<TData>,
	position: 'before' | 'after'
): TreeNode<TData>[] {
	const index = nodes.findIndex((node) => node.id === targetId);
	if (index !== -1) {
		const at = position === 'before' ? index : index + 1;
		const next = nodes.slice();
		next.splice(at, 0, moved);
		return next;
	}
	let changed = false;
	const next = nodes.map((node) => {
		if (node.children) {
			const children = insertSibling(node.children, targetId, moved, position);
			if (children !== node.children) {
				changed = true;
				return { ...node, children };
			}
		}
		return node;
	});
	return changed ? next : nodes;
}
