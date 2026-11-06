import { describe, expect, it } from 'vitest';
import {
	canDrop,
	collectLeafIds,
	findNode,
	findParent,
	flattenVisible,
	isLeaf,
	moveNode,
	nodeHasChildren,
	nodePath,
	patchNode,
	rangeIds,
	setNodeChildren
} from '../src/core/tree';
import type { TreeNode } from '../src/core/types';

/** a > (a1, a2 > a2x), b (lazy branch, no loaded children), c (leaf). */
function forest(): TreeNode[] {
	return [
		{
			id: 'a',
			label: 'A',
			children: [
				{ id: 'a1', label: 'A1' },
				{ id: 'a2', label: 'A2', children: [{ id: 'a2x', label: 'A2X' }] }
			]
		},
		{ id: 'b', label: 'B', hasChildren: true },
		{ id: 'c', label: 'C' }
	];
}

const expandAll = () => true;
const expandNone = () => false;
const expanded = (...ids: string[]) => {
	const set = new Set(ids);
	return (id: string) => set.has(id);
};

describe('nodeHasChildren / isLeaf', () => {
	it('treats a loaded branch and a lazy branch as having children', () => {
		const [a, b, c] = forest();
		expect(nodeHasChildren(a)).toBe(true);
		expect(nodeHasChildren(b)).toBe(true); // lazy: hasChildren:true, no children yet
		expect(nodeHasChildren(c)).toBe(false);
		expect(isLeaf(c)).toBe(true);
		expect(isLeaf(b)).toBe(false);
	});
});

describe('findNode / findParent / nodePath', () => {
	it('finds nested nodes and their parents', () => {
		const f = forest();
		expect(findNode(f, 'a2x')?.label).toBe('A2X');
		expect(findNode(f, 'nope')).toBeNull();
		expect(findParent(f, 'a2x')?.id).toBe('a2');
		expect(findParent(f, 'a')).toBeNull(); // root has no parent
		expect(findParent(f, 'nope')).toBeNull();
	});

	it('returns the root→node id path, or [] when absent', () => {
		const f = forest();
		expect(nodePath(f, 'a2x')).toEqual(['a', 'a2', 'a2x']);
		expect(nodePath(f, 'c')).toEqual(['c']);
		expect(nodePath(f, 'nope')).toEqual([]);
	});
});

describe('collectLeafIds', () => {
	it('collects descendant leaves; a lazy branch has none', () => {
		const [a, b, c] = forest();
		expect(collectLeafIds(a)).toEqual(['a1', 'a2x']);
		expect(collectLeafIds(b)).toEqual([]); // lazy, unloaded
		expect(collectLeafIds(c)).toEqual(['c']);
	});
});

describe('flattenVisible', () => {
	it('shows only roots when nothing is expanded', () => {
		const flat = flattenVisible(forest(), expandNone);
		expect(flat.map((f) => f.node.id)).toEqual(['a', 'b', 'c']);
		expect(flat.every((f) => f.depth === 0)).toBe(true);
		expect(flat[0]).toMatchObject({
			posInSet: 1,
			setSize: 3,
			parentId: null,
			hasChildren: true,
			expanded: false
		});
		expect(flat[1]).toMatchObject({ hasChildren: true, expanded: false }); // lazy branch still toggleable
	});

	it('includes children of expanded nodes at increasing depth', () => {
		const flat = flattenVisible(forest(), expanded('a'));
		expect(flat.map((f) => f.node.id)).toEqual(['a', 'a1', 'a2', 'b', 'c']);
		const a2 = flat.find((f) => f.node.id === 'a2')!;
		expect(a2).toMatchObject({
			depth: 1,
			parentId: 'a',
			hasChildren: true,
			expanded: false,
			posInSet: 2,
			setSize: 2
		});
	});

	it('recurses through multiple expanded levels', () => {
		const flat = flattenVisible(forest(), expandAll);
		expect(flat.map((f) => f.node.id)).toEqual(['a', 'a1', 'a2', 'a2x', 'b', 'c']);
		expect(flat.find((f) => f.node.id === 'a2x')).toMatchObject({ depth: 2, parentId: 'a2' });
	});
});

describe('rangeIds', () => {
	it('returns the inclusive visible range regardless of direction', () => {
		const flat = flattenVisible(forest(), expandAll); // a,a1,a2,a2x,b,c
		expect(rangeIds(flat, 'a1', 'b')).toEqual(['a1', 'a2', 'a2x', 'b']);
		expect(rangeIds(flat, 'b', 'a1')).toEqual(['a1', 'a2', 'a2x', 'b']); // symmetric
		expect(rangeIds(flat, 'a', 'a')).toEqual(['a']);
		expect(rangeIds(flat, 'a', 'nope')).toEqual([]);
	});
});

describe('setNodeChildren (lazy load)', () => {
	it('installs children on a lazy branch immutably', () => {
		const f = forest();
		const next = setNodeChildren(f, 'b', [
			{ id: 'b1', label: 'B1' },
			{ id: 'b2', label: 'B2' }
		]);
		expect(next).not.toBe(f);
		expect(findNode(next, 'b')?.children?.map((c) => c.id)).toEqual(['b1', 'b2']);
		// untouched subtree keeps its reference (cheap reactivity)
		expect(findNode(next, 'a')).toBe(findNode(f, 'a'));
	});

	it('returns the same reference for an unknown id', () => {
		const f = forest();
		expect(setNodeChildren(f, 'nope', [])).toBe(f);
	});
});

describe('patchNode (inline rename)', () => {
	it('renames immutably and leaves siblings referentially equal', () => {
		const f = forest();
		const next = patchNode(f, 'a1', { label: 'renamed' });
		expect(next).not.toBe(f);
		expect(findNode(next, 'a1')?.label).toBe('renamed');
		expect(findNode(next, 'a2')).toBe(findNode(f, 'a2'));
	});

	it('is a no-op (same ref) when the patch changes nothing', () => {
		const f = forest();
		expect(patchNode(f, 'a1', { label: 'A1' })).toBe(f);
		expect(patchNode(f, 'nope', { label: 'x' })).toBe(f);
	});
});

describe('canDrop / moveNode', () => {
	it('rejects dropping a node onto itself or into its own subtree', () => {
		const f = forest();
		expect(canDrop(f, 'a', 'a', 'inside')).toBe(false);
		expect(canDrop(f, 'a', 'a2x', 'inside')).toBe(false); // a2x is inside a
		expect(moveNode(f, 'a', 'a2x', 'inside')).toBe(f); // no-op, same ref
	});

	it('reorders siblings (before/after)', () => {
		const f = forest();
		const next = moveNode(f, 'c', 'a', 'before');
		expect(next.map((n) => n.id)).toEqual(['c', 'a', 'b']);
		const after = moveNode(f, 'a', 'c', 'after');
		expect(after.map((n) => n.id)).toEqual(['b', 'c', 'a']);
	});

	it('reparents a node inside another (appends as last child)', () => {
		const f = forest();
		const next = moveNode(f, 'a1', 'c', 'inside');
		expect(findParent(next, 'a1')?.id).toBe('c');
		expect(findNode(next, 'c')?.children?.map((n) => n.id)).toEqual(['a1']);
		// a1 no longer under a
		expect(findNode(next, 'a')?.children?.map((n) => n.id)).toEqual(['a2']);
	});

	it('reparents before a nested target', () => {
		const f = forest();
		const next = moveNode(f, 'c', 'a2x', 'before');
		const a2 = findNode(next, 'a2')!;
		expect(a2.children?.map((n) => n.id)).toEqual(['c', 'a2x']);
	});

	it('returns the same reference for an unknown drag/target', () => {
		const f = forest();
		expect(moveNode(f, 'nope', 'a', 'inside')).toBe(f);
		expect(moveNode(f, 'a', 'nope', 'inside')).toBe(f);
	});
});
