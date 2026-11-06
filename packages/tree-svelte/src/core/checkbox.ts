/**
 * Tri-state checkbox math — pure and deterministic (unit-tested without a DOM).
 *
 * The checkbox model tracks a set of CHECKED leaf ids; a branch's visual state
 * is DERIVED from its descendant leaves: all checked → `checked`, none →
 * `unchecked`, a mix → `indeterminate`. A lazy branch whose children are not
 * loaded yet has no descendant leaves, so it behaves like a leaf keyed on its
 * own id (checking it stores the branch id until its real leaves arrive).
 */
import { collectLeafIds } from './tree';
import type { CheckState, NodeId, TreeNode } from './types';

/** The ids the checkbox for `node` actually toggles: its descendant leaves, or its own id when none are loaded. */
function effectiveIds(node: TreeNode): NodeId[] {
	const leaves = collectLeafIds(node);
	return leaves.length > 0 ? leaves : [node.id];
}

/** Derive the tri-state value of `node`'s checkbox from the checked-leaf set. */
export function computeCheckState(node: TreeNode, checkedIds: ReadonlySet<NodeId>): CheckState {
	const ids = effectiveIds(node);
	let checked = 0;
	for (const id of ids) if (checkedIds.has(id)) checked++;
	if (checked === 0) return 'unchecked';
	if (checked === ids.length) return 'checked';
	return 'indeterminate';
}

/**
 * The set changes to apply when the user toggles `node`'s checkbox: a fully
 * `checked` node clears all its effective ids, otherwise (`unchecked` or
 * `indeterminate`) it adds them. Returns id lists the caller applies to its
 * (reactive) checked set in place — this function never mutates.
 */
export function subtreeCheckToggle(
	node: TreeNode,
	checkedIds: ReadonlySet<NodeId>
): { add: NodeId[]; remove: NodeId[] } {
	const ids = effectiveIds(node);
	if (computeCheckState(node, checkedIds) === 'checked') {
		return { add: [], remove: ids };
	}
	return { add: ids.filter((id) => !checkedIds.has(id)), remove: [] };
}
