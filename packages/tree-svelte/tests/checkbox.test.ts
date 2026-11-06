import { describe, expect, it } from 'vitest';
import { computeCheckState, subtreeCheckToggle } from '../src/core/checkbox';
import type { TreeNode } from '../src/core/types';

function branch(): TreeNode {
	return {
		id: 'a',
		label: 'A',
		children: [
			{ id: 'a1', label: 'A1' },
			{ id: 'a2', label: 'A2', children: [{ id: 'a2x', label: 'A2X' }] }
		]
	};
}

const lazy: TreeNode = { id: 'b', label: 'B', hasChildren: true };
const leaf: TreeNode = { id: 'c', label: 'C' };

describe('computeCheckState', () => {
	it('reads a leaf directly from the checked set', () => {
		expect(computeCheckState(leaf, new Set())).toBe('unchecked');
		expect(computeCheckState(leaf, new Set(['c']))).toBe('checked');
	});

	it('derives a branch from its descendant leaves (all / none / mixed)', () => {
		const a = branch();
		expect(computeCheckState(a, new Set())).toBe('unchecked');
		expect(computeCheckState(a, new Set(['a1', 'a2x']))).toBe('checked');
		expect(computeCheckState(a, new Set(['a1']))).toBe('indeterminate');
	});

	it('treats a lazy (unloaded) branch as keyed on its own id', () => {
		expect(computeCheckState(lazy, new Set())).toBe('unchecked');
		expect(computeCheckState(lazy, new Set(['b']))).toBe('checked');
	});
});

describe('subtreeCheckToggle', () => {
	it('checking an unchecked branch adds all descendant leaves', () => {
		const a = branch();
		expect(subtreeCheckToggle(a, new Set())).toEqual({ add: ['a1', 'a2x'], remove: [] });
	});

	it('checking an indeterminate branch adds only the missing leaves', () => {
		const a = branch();
		expect(subtreeCheckToggle(a, new Set(['a1']))).toEqual({ add: ['a2x'], remove: [] });
	});

	it('unchecking a fully-checked branch removes all its leaves', () => {
		const a = branch();
		expect(subtreeCheckToggle(a, new Set(['a1', 'a2x']))).toEqual({
			add: [],
			remove: ['a1', 'a2x']
		});
	});

	it('toggles a leaf by its own id', () => {
		expect(subtreeCheckToggle(leaf, new Set())).toEqual({ add: ['c'], remove: [] });
		expect(subtreeCheckToggle(leaf, new Set(['c']))).toEqual({ add: [], remove: ['c'] });
	});

	it('toggles a lazy branch by its own id', () => {
		expect(subtreeCheckToggle(lazy, new Set())).toEqual({ add: ['b'], remove: [] });
		expect(subtreeCheckToggle(lazy, new Set(['b']))).toEqual({ add: [], remove: ['b'] });
	});
});
