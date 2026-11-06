import { describe, expect, it } from 'vitest';
import { TreeState } from '../src/tree-state.svelte';

describe('TreeState expand/collapse', () => {
	it('toggles, expands and collapses ids', () => {
		const s = new TreeState({ expanded: ['a'] });
		expect(s.isExpanded('a')).toBe(true);
		s.toggleExpanded('a');
		expect(s.isExpanded('a')).toBe(false);
		s.expand('b');
		expect(s.isExpanded('b')).toBe(true);
		s.collapse('b');
		expect(s.isExpanded('b')).toBe(false);
	});
});

describe('TreeState highlight selection', () => {
	it('selectOnly replaces the selection and sets anchor + focus', () => {
		const s = new TreeState({ selectionMode: 'multi' });
		s.selectOnly('a');
		s.selectOnly('b');
		expect([...s.selectedIds]).toEqual(['b']);
		expect(s.anchorId).toBe('b');
		expect(s.focusedId).toBe('b');
	});

	it('toggleSelected adds/removes without clearing others', () => {
		const s = new TreeState({ selectionMode: 'multi' });
		s.selectOnly('a');
		s.toggleSelected('b');
		expect([...s.selectedIds].sort()).toEqual(['a', 'b']);
		s.toggleSelected('b');
		expect([...s.selectedIds]).toEqual(['a']);
	});

	it('selectRange replaces the selection with the whole range', () => {
		const s = new TreeState({ selectionMode: 'multi' });
		s.selectOnly('a');
		s.selectRange(['a', 'b', 'c']);
		expect([...s.selectedIds].sort()).toEqual(['a', 'b', 'c']);
		expect(s.focusedId).toBe('c');
	});
});

describe('TreeState checkboxes', () => {
	it('applies a subtreeCheckToggle result in place', () => {
		const s = new TreeState();
		s.applyCheck({ add: ['a1', 'a2x'], remove: [] });
		expect([...s.checkedIds].sort()).toEqual(['a1', 'a2x']);
		s.applyCheck({ add: [], remove: ['a1'] });
		expect([...s.checkedIds]).toEqual(['a2x']);
		expect(s.isChecked('a2x')).toBe(true);
	});
});

describe('TreeState load status', () => {
	it('defaults to idle and records transitions', () => {
		const s = new TreeState();
		expect(s.getLoadStatus('b')).toBe('idle');
		s.setLoadStatus('b', 'loading');
		expect(s.getLoadStatus('b')).toBe('loading');
		s.setLoadStatus('b', 'loaded');
		expect(s.getLoadStatus('b')).toBe('loaded');
	});
});
