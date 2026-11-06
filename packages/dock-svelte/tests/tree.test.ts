import { describe, expect, it } from 'vitest';
import {
	collapse,
	collectPanelIds,
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
} from '../src/core/tree';
import type { DockNode, DockPanelNode, DockSplitNode, DockTabGroupNode } from '../src/types';

// Deterministic id generator for tests: 'id-0', 'id-1', ...
function counterMakeId(): () => string {
	let n = 0;
	return () => `id-${n++}`;
}

function panel(id: string, title = id): DockPanelNode {
	return { type: 'panel', id, title };
}

function tabs(id: string, children: DockPanelNode[], activeIndex = 0): DockTabGroupNode {
	return { type: 'tabs', id, children, activeIndex };
}

function split(
	id: string,
	direction: 'row' | 'column',
	children: DockNode[],
	sizes?: number[]
): DockSplitNode {
	return {
		type: 'split',
		id,
		direction,
		children,
		sizes: sizes ?? children.map(() => 1 / children.length)
	};
}

describe('findNode', () => {
	it('finds the root itself', () => {
		const root = panel('a');
		expect(findNode(root, 'a')).toBe(root);
	});

	it('finds a panel nested inside a split', () => {
		const b = panel('b');
		const root = split('s1', 'row', [panel('a'), b]);
		expect(findNode(root, 'b')).toBe(b);
	});

	it('finds a panel nested inside a tabs group inside a split', () => {
		const t = tabs('t1', [panel('a'), panel('b')]);
		const root = split('s1', 'row', [t, panel('c')]);
		expect(findNode(root, 'b')).toEqual(panel('b'));
	});

	it('finds a tabs group by its own id', () => {
		const t = tabs('t1', [panel('a'), panel('b')]);
		expect(findNode(t, 't1')).toBe(t);
	});

	it('returns null for an unknown id', () => {
		expect(findNode(panel('a'), 'zzz')).toBeNull();
	});

	it('returns null for a null root', () => {
		expect(findNode(null, 'a')).toBeNull();
	});
});

describe('findParent', () => {
	it('returns null for the root itself', () => {
		const root = panel('a');
		expect(findParent(root, 'a')).toBeNull();
	});

	it('returns null for an unknown id', () => {
		expect(findParent(panel('a'), 'zzz')).toBeNull();
	});

	it('returns null for a null root', () => {
		expect(findParent(null, 'a')).toBeNull();
	});

	it('finds the direct split parent of a panel child', () => {
		const root = split('s1', 'row', [panel('a'), panel('b')]);
		expect(findParent(root, 'b')).toBe(root);
	});

	it('finds the direct tabs parent of a panel child', () => {
		const t = tabs('t1', [panel('a'), panel('b')]);
		const root = split('s1', 'row', [t, panel('c')]);
		expect(findParent(root, 'b')).toBe(t);
	});

	it('finds the parent of a deeply-nested split child', () => {
		const inner = split('s2', 'column', [panel('x'), panel('y')]);
		const root = split('s1', 'row', [inner, panel('c')]);
		expect(findParent(root, 'y')).toBe(inner);
	});

	it('finds the split parent of a tabs group node by the group id', () => {
		const t = tabs('t1', [panel('a')]);
		const root = split('s1', 'row', [t, panel('c')]);
		expect(findParent(root, 't1')).toBe(root);
	});
});

describe('collectPanelIds', () => {
	it('is empty for a null tree', () => {
		expect(collectPanelIds(null)).toEqual([]);
	});

	it('is the single id for a bare panel', () => {
		expect(collectPanelIds(panel('a'))).toEqual(['a']);
	});

	it('collects all children of a tabs group', () => {
		expect(collectPanelIds(tabs('t1', [panel('a'), panel('b')]))).toEqual(['a', 'b']);
	});

	it('collects recursively through nested splits and tabs groups', () => {
		const root = split('s1', 'row', [
			tabs('t1', [panel('a'), panel('b')]),
			split('s2', 'column', [panel('c'), panel('d')])
		]);
		expect(collectPanelIds(root)).toEqual(['a', 'b', 'c', 'd']);
	});
});

describe('collapse', () => {
	it('leaves a panel untouched', () => {
		const p = panel('a');
		expect(collapse(p)).toBe(p);
	});

	it('leaves a multi-child split untouched', () => {
		const s = split('s1', 'row', [panel('a'), panel('b')]);
		expect(collapse(s)).toBe(s);
	});

	it('collapses a 1-child split into that child', () => {
		const a = panel('a');
		const s = split('s1', 'row', [a]);
		expect(collapse(s)).toBe(a);
	});

	it('collapses a 1-child tabs group into that child', () => {
		const a = panel('a');
		const t = tabs('t1', [a]);
		expect(collapse(t)).toBe(a);
	});

	it('collapses a 0-child split to null', () => {
		const s: DockSplitNode = { type: 'split', id: 's1', direction: 'row', children: [], sizes: [] };
		expect(collapse(s)).toBeNull();
	});

	it('collapses a 0-child tabs group to null', () => {
		const t: DockTabGroupNode = { type: 'tabs', id: 't1', children: [], activeIndex: 0 };
		expect(collapse(t)).toBeNull();
	});
});

describe('normalizeSizes', () => {
	it('leaves a panel untouched', () => {
		const p = panel('a');
		expect(normalizeSizes(p)).toBe(p);
	});

	it('leaves a tabs group untouched', () => {
		const t = tabs('t1', [panel('a')]);
		expect(normalizeSizes(t)).toBe(t);
	});

	it('rescales sizes that sum to something other than 1, preserving proportions', () => {
		const s = split('s1', 'row', [panel('a'), panel('b')], [1, 3]);
		const result = normalizeSizes(s) as DockSplitNode;
		expect(result.sizes[0]).toBeCloseTo(0.25);
		expect(result.sizes[1]).toBeCloseTo(0.75);
	});

	it('falls back to even sizes when the sizes array length mismatches children', () => {
		const s = split('s1', 'row', [panel('a'), panel('b'), panel('c')], [0.5, 0.5]);
		const result = normalizeSizes(s) as DockSplitNode;
		expect(result.sizes).toHaveLength(3);
		expect(result.sizes[0]).toBeCloseTo(1 / 3);
		expect(result.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
	});

	it('falls back to even sizes when sizes sum to 0', () => {
		const s = split('s1', 'row', [panel('a'), panel('b')], [0, 0]);
		const result = normalizeSizes(s) as DockSplitNode;
		expect(result.sizes[0]).toBeCloseTo(0.5);
		expect(result.sizes[1]).toBeCloseTo(0.5);
	});

	it('recurses into nested splits', () => {
		const inner = split('s2', 'column', [panel('x'), panel('y')], [2, 2]);
		const root = split('s1', 'row', [inner, panel('c')], [1, 1]);
		const result = normalizeSizes(root) as DockSplitNode;
		const innerResult = result.children[0] as DockSplitNode;
		expect(innerResult.sizes[0]).toBeCloseTo(0.5);
		expect(innerResult.sizes[1]).toBeCloseTo(0.5);
	});
});

describe('removePanel', () => {
	it('returns null when root is already null', () => {
		expect(removePanel(null, 'a')).toBeNull();
	});

	it('removes the sole panel entirely, returning null', () => {
		expect(removePanel(panel('a'), 'a')).toBeNull();
	});

	it('is a no-op (same reference) when the panel is not found', () => {
		const root = split('s1', 'row', [panel('a'), panel('b')]);
		expect(removePanel(root, 'zzz')).toBe(root);
	});

	it('collapses a 2-child split down to the surviving sibling', () => {
		const root = split('s1', 'row', [panel('a'), panel('b')]);
		expect(removePanel(root, 'a')).toEqual(panel('b'));
	});

	it('collapses a 3-child split down to a 2-child split with rescaled sizes', () => {
		const root = split('s1', 'row', [panel('a'), panel('b'), panel('c')], [0.2, 0.3, 0.5]);
		const result = removePanel(root, 'a') as DockSplitNode;
		expect(result.type).toBe('split');
		expect(result.children.map((c) => c.id)).toEqual(['b', 'c']);
		expect(result.sizes[0]).toBeCloseTo(0.3 / 0.8);
		expect(result.sizes[1]).toBeCloseTo(0.5 / 0.8);
		expect(result.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
	});

	it('removes a tab from a group, clamping activeIndex when the active tab itself was removed', () => {
		const t = tabs('t1', [panel('a'), panel('b'), panel('c')], 2);
		const root = split('s1', 'row', [t, panel('d')]);
		const result = removePanel(root, 'c') as DockSplitNode;
		const group = result.children[0] as DockTabGroupNode;
		expect(group.children.map((c) => c.id)).toEqual(['a', 'b']);
		expect(group.activeIndex).toBe(1);
	});

	it('shifts activeIndex down when a tab before the active one is removed', () => {
		const t = tabs('t1', [panel('a'), panel('b'), panel('c')], 2);
		const root = split('s1', 'row', [t, panel('d')]);
		const result = removePanel(root, 'a') as DockSplitNode;
		const group = result.children[0] as DockTabGroupNode;
		expect(group.children.map((c) => c.id)).toEqual(['b', 'c']);
		expect(group.activeIndex).toBe(1); // 'c' is still active, now at index 1
	});

	it('collapses a tabs group down to its lone surviving panel', () => {
		const t = tabs('t1', [panel('a'), panel('b')]);
		const root = split('s1', 'row', [t, panel('c')]);
		const result = removePanel(root, 'a') as DockSplitNode;
		expect(result.children.map((c) => c.id)).toEqual(['b', 'c']);
		expect(result.children[0].type).toBe('panel');
	});

	it('propagates collapse upward through multiple levels', () => {
		// removing 'a' collapses the inner split down to 'b'; the outer
		// split (deliberately built with a single child to exercise this
		// path) then also collapses down to that same 'b'.
		const innerTwo = split('s2', 'column', [panel('a'), panel('b')]);
		const root = split('s1', 'row', [innerTwo]);
		const result = removePanel(root, 'a');
		expect(result).toEqual(panel('b'));
	});
});

describe('dockPanelIntoTree', () => {
	it('yields the bare panel when the tree is empty', () => {
		const makeId = counterMakeId();
		expect(dockPanelIntoTree(null, panel('a'), 'whatever', 'center', makeId)).toEqual(panel('a'));
		expect(dockPanelIntoTree(null, panel('a'), 'whatever', 'left', makeId)).toEqual(panel('a'));
	});

	it('center onto a bare panel wraps both into a new tabs node, new panel active', () => {
		const makeId = counterMakeId();
		const root = panel('a');
		const result = dockPanelIntoTree(root, panel('b'), 'a', 'center', makeId) as DockTabGroupNode;
		expect(result.type).toBe('tabs');
		expect(result.id).toBe('id-0');
		expect(result.children.map((c) => c.id)).toEqual(['a', 'b']);
		expect(result.activeIndex).toBe(1);
	});

	it('center onto a tabs group appends a new active tab', () => {
		const makeId = counterMakeId();
		const t = tabs('t1', [panel('a'), panel('b')], 0);
		const result = dockPanelIntoTree(t, panel('c'), 't1', 'center', makeId) as DockTabGroupNode;
		expect(result.id).toBe('t1');
		expect(result.children.map((c) => c.id)).toEqual(['a', 'b', 'c']);
		expect(result.activeIndex).toBe(2);
	});

	it('center onto a specific tab (a panel inside a group) redirects to appending on the group', () => {
		const makeId = counterMakeId();
		const t = tabs('t1', [panel('a'), panel('b')], 0);
		const result = dockPanelIntoTree(t, panel('c'), 'b', 'center', makeId) as DockTabGroupNode;
		expect(result.type).toBe('tabs');
		expect(result.id).toBe('t1');
		expect(result.children.map((c) => c.id)).toEqual(['a', 'b', 'c']);
	});

	it.each([
		['left', ['new', 'a']],
		['right', ['a', 'new']],
		['top', ['new', 'a']],
		['bottom', ['a', 'new']]
	] as const)(
		'%s onto a bare panel creates a split with correct direction and child order',
		(region, order) => {
			const makeId = counterMakeId();
			const result = dockPanelIntoTree(
				panel('a'),
				panel('new'),
				'a',
				region,
				makeId
			) as DockSplitNode;
			expect(result.type).toBe('split');
			expect(result.direction).toBe(region === 'left' || region === 'right' ? 'row' : 'column');
			expect(result.children.map((c) => c.id)).toEqual(order);
			expect(result.sizes).toEqual([0.5, 0.5]);
		}
	);

	it('flattens into an existing same-direction split as a sibling instead of nesting', () => {
		const makeId = counterMakeId();
		const root = split('s1', 'row', [panel('a'), panel('b')], [0.5, 0.5]);
		const result = dockPanelIntoTree(root, panel('c'), 'b', 'right', makeId) as DockSplitNode;
		expect(result.id).toBe('s1'); // same split, no new node created
		expect(result.type).toBe('split');
		expect(result.children.map((n) => n.id)).toEqual(['a', 'b', 'c']);
		expect(result.sizes.every((s) => Math.abs(s - 1 / 3) < 1e-9)).toBe(true);
	});

	it('flattens on the "before" side too', () => {
		const makeId = counterMakeId();
		const root = split('s1', 'row', [panel('a'), panel('b')], [0.5, 0.5]);
		const result = dockPanelIntoTree(root, panel('c'), 'b', 'left', makeId) as DockSplitNode;
		expect(result.children.map((n) => n.id)).toEqual(['a', 'c', 'b']);
	});

	it('does NOT flatten into a split of a different direction - nests a new split instead', () => {
		const makeId = counterMakeId();
		const root = split('s1', 'row', [panel('a'), panel('b')], [0.5, 0.5]);
		const result = dockPanelIntoTree(root, panel('c'), 'b', 'bottom', makeId) as DockSplitNode;
		expect(result.id).toBe('s1');
		expect(result.direction).toBe('row');
		const bSlot = result.children[1] as DockSplitNode;
		expect(bSlot.type).toBe('split');
		expect(bSlot.direction).toBe('column');
		expect(bSlot.children.map((n) => n.id)).toEqual(['b', 'c']);
	});

	it('edge-drop onto a tab redirects to splitting the whole group, not just that one panel', () => {
		const makeId = counterMakeId();
		const t = tabs('t1', [panel('a'), panel('b')], 0);
		const result = dockPanelIntoTree(t, panel('c'), 'a', 'right', makeId) as DockSplitNode;
		expect(result.type).toBe('split');
		expect(result.direction).toBe('row');
		expect(result.children[0]).toEqual(t);
		expect(result.children[1]).toEqual(panel('c'));
	});

	it("falls back to the tree's first leaf when targetId is unknown", () => {
		const makeId = counterMakeId();
		const root = split('s1', 'row', [panel('a'), panel('b')]);
		const result = dockPanelIntoTree(
			root,
			panel('c'),
			'does-not-exist',
			'center',
			makeId
		) as DockSplitNode;
		const aSlot = result.children[0];
		expect(aSlot.type).toBe('tabs');
		expect((aSlot as DockTabGroupNode).children.map((c) => c.id)).toEqual(['a', 'c']);
	});
});

describe('splitInsert', () => {
	it('creates a fresh split when there is no matching-direction parent', () => {
		const makeId = counterMakeId();
		const root = panel('a');
		const result = splitInsert(root, panel('a'), panel('b'), 'right', makeId) as DockSplitNode;
		expect(result.type).toBe('split');
		expect(result.direction).toBe('row');
		expect(result.children.map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('flattens into a same-direction parent split', () => {
		const root = split('s1', 'column', [panel('a'), panel('b')], [0.5, 0.5]);
		const result = splitInsert(root, panel('a'), panel('c'), 'top') as DockSplitNode;
		expect(result.id).toBe('s1');
		expect(result.children.map((c) => c.id)).toEqual(['c', 'a', 'b']);
	});
});

describe('setActiveTab', () => {
	it('sets the active index', () => {
		const t = tabs('t1', [panel('a'), panel('b'), panel('c')], 0);
		const result = setActiveTab(t, 't1', 2) as DockTabGroupNode;
		expect(result.activeIndex).toBe(2);
	});

	it('clamps an out-of-range index', () => {
		const t = tabs('t1', [panel('a'), panel('b')], 0);
		expect((setActiveTab(t, 't1', 99) as DockTabGroupNode).activeIndex).toBe(1);
		expect((setActiveTab(t, 't1', -5) as DockTabGroupNode).activeIndex).toBe(0);
	});

	it('is a no-op for a null tree', () => {
		expect(setActiveTab(null, 't1', 0)).toBeNull();
	});

	it('is a no-op (same reference) for an unknown group id', () => {
		const t = tabs('t1', [panel('a')]);
		expect(setActiveTab(t, 'zzz', 0)).toBe(t);
	});
});

describe('moveTabWithinGroup', () => {
	it('reorders tabs and keeps the same panel active by id', () => {
		const t = tabs('t1', [panel('a'), panel('b'), panel('c')], 2); // 'c' active
		const result = moveTabWithinGroup(t, 't1', 0, 2) as DockTabGroupNode;
		expect(result.children.map((c) => c.id)).toEqual(['b', 'c', 'a']);
		expect(result.activeIndex).toBe(1); // 'c' is now at index 1
	});

	it('is a no-op for from === to', () => {
		const t = tabs('t1', [panel('a'), panel('b')], 0);
		expect(moveTabWithinGroup(t, 't1', 1, 1)).toBe(t);
	});

	it('is a no-op for out-of-range indices', () => {
		const t = tabs('t1', [panel('a'), panel('b')], 0);
		expect(moveTabWithinGroup(t, 't1', 0, 5)).toBe(t);
		expect(moveTabWithinGroup(t, 't1', -1, 1)).toBe(t);
	});

	it('is a no-op for a null tree', () => {
		expect(moveTabWithinGroup(null, 't1', 0, 1)).toBeNull();
	});
});

describe('resizeSplit', () => {
	it('adjusts the pair and keeps their sum constant', () => {
		const s = split('s1', 'row', [panel('a'), panel('b')], [0.5, 0.5]);
		const result = resizeSplit(s, 's1', 0, 0.2) as DockSplitNode;
		expect(result.sizes[0]).toBeCloseTo(0.7);
		expect(result.sizes[1]).toBeCloseTo(0.3);
		expect(result.sizes[0] + result.sizes[1]).toBeCloseTo(1);
	});

	it('clamps growth so the shrinking pane never drops below MIN_PANE_FRACTION', () => {
		const s = split('s1', 'row', [panel('a'), panel('b')], [0.5, 0.5]);
		const result = resizeSplit(s, 's1', 0, 10) as DockSplitNode;
		expect(result.sizes[1]).toBeCloseTo(MIN_PANE_FRACTION);
		expect(result.sizes[0]).toBeCloseTo(1 - MIN_PANE_FRACTION);
	});

	it('clamps shrinkage the other direction too', () => {
		const s = split('s1', 'row', [panel('a'), panel('b')], [0.5, 0.5]);
		const result = resizeSplit(s, 's1', 0, -10) as DockSplitNode;
		expect(result.sizes[0]).toBeCloseTo(MIN_PANE_FRACTION);
		expect(result.sizes[1]).toBeCloseTo(1 - MIN_PANE_FRACTION);
	});

	it('only touches the targeted pair in a 3+ child split', () => {
		const s = split('s1', 'row', [panel('a'), panel('b'), panel('c')], [1 / 3, 1 / 3, 1 / 3]);
		const result = resizeSplit(s, 's1', 1, 0.1) as DockSplitNode;
		expect(result.sizes[0]).toBeCloseTo(1 / 3);
		expect(result.sizes[1]).toBeCloseTo(1 / 3 + 0.1);
		expect(result.sizes[2]).toBeCloseTo(1 / 3 - 0.1);
	});

	it('is a no-op for an out-of-range dividerIndex', () => {
		const s = split('s1', 'row', [panel('a'), panel('b')], [0.5, 0.5]);
		expect(resizeSplit(s, 's1', 5, 0.1)).toBe(s);
		expect(resizeSplit(s, 's1', -1, 0.1)).toBe(s);
	});

	it('is a no-op for an unknown splitId', () => {
		const s = split('s1', 'row', [panel('a'), panel('b')], [0.5, 0.5]);
		expect(resizeSplit(s, 'zzz', 0, 0.1)).toBe(s);
	});

	it('is a no-op for a null tree', () => {
		expect(resizeSplit(null, 's1', 0, 0.1)).toBeNull();
	});

	it('splits a degenerate (already-too-small) pair evenly rather than going negative', () => {
		const s = split('s1', 'row', [panel('a'), panel('b')], [0.05, 0.05]);
		const result = resizeSplit(s, 's1', 0, 0.03) as DockSplitNode;
		expect(result.sizes[0]).toBeCloseTo(0.05);
		expect(result.sizes[1]).toBeCloseTo(0.05);
	});
});
