// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BantoTree from '../src/BantoTree.svelte';
import type { TreeColumn, TreeNode } from '../src/core/types';

interface Row {
	size: number;
}

function forest(): TreeNode<Row>[] {
	return [
		{
			id: 'a',
			label: 'Alpha',
			data: { size: 3 },
			children: [{ id: 'a1', label: 'Alpha-1', data: { size: 1 } }]
		},
		{ id: 'b', label: 'Bravo', data: { size: 2 } }
	];
}

afterEach(() => cleanup());

describe('BantoTree', () => {
	it('renders a tree with the root nodes, hiding collapsed children', () => {
		render(BantoTree<Row>, { nodes: forest() });
		expect(screen.getByRole('tree')).toBeTruthy();
		expect(screen.getByText('Alpha')).toBeTruthy();
		expect(screen.getByText('Bravo')).toBeTruthy();
		expect(screen.queryByText('Alpha-1')).toBeNull();
	});

	it('reveals children when the disclosure toggle is clicked', async () => {
		render(BantoTree<Row>, { nodes: forest() });
		const toggle = screen.getByRole('button', { name: /Alpha/ });
		await fireEvent.click(toggle);
		expect(screen.getByText('Alpha-1')).toBeTruthy();
		const row = screen.getByText('Alpha').closest('[role="treeitem"]');
		expect(row?.getAttribute('aria-expanded')).toBe('true');
	});

	it('fires onSelectionChange with the clicked node id', async () => {
		const onSelectionChange = vi.fn();
		render(BantoTree<Row>, { nodes: forest(), onSelectionChange });
		await fireEvent.click(screen.getByText('Bravo'));
		expect(onSelectionChange).toHaveBeenLastCalledWith(['b']);
	});

	it('tri-state checkbox on a branch checks all descendant leaves', async () => {
		const onCheckChange = vi.fn();
		render(BantoTree<Row>, { nodes: forest(), checkboxes: true, expanded: ['a'], onCheckChange });
		const boxes = screen.getAllByRole('checkbox');
		await fireEvent.click(boxes[0]); // the 'a' branch checkbox
		expect(onCheckChange).toHaveBeenLastCalledWith(['a1']);
	});

	it('renders extra columns as a tree-grid', () => {
		const columns: TreeColumn<Row>[] = [
			{ id: 'size', header: 'Size', accessor: 'size', align: 'right' }
		];
		render(BantoTree<Row>, { nodes: forest(), columns });
		expect(screen.getByText('Size')).toBeTruthy(); // column header
		expect(screen.getByText('2')).toBeTruthy(); // Bravo's size cell
	});

	it('shows the empty message for an empty forest', () => {
		render(BantoTree<Row>, { nodes: [], messages: { empty: () => 'nothing here' } });
		expect(screen.getByText('nothing here')).toBeTruthy();
	});
});
