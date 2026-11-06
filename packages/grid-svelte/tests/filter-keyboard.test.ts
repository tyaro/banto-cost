// @vitest-environment jsdom
/** Issue #213: filter controls own their keyboard events (spec §4.3, §4.5).
 * jsdom does not implement native caret/select/Tab movement; browser E2E covers it.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import type { GridColumn } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get: () => 400
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get: () => 32
	});
});
afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	category: string;
}
const rows: Row[] = [
	{ id: 1, name: 'Alpha', category: 'First' },
	{ id: 2, name: 'Beta', category: 'Second' }
];
const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name', editable: true, filterable: true },
	{ id: 'category', header: 'Category', accessor: 'category', editable: true }
];
async function setup(mode: 'client' | 'server') {
	const onCellEdit = vi.fn();
	const onParamsChange = vi.fn();
	const { container } = render(BantoGrid<Row>, {
		rows,
		columns,
		mode,
		totalRows: rows.length,
		getRowId: (row: Row) => row.id,
		onCellEdit,
		onParamsChange
	});
	const selected = container.querySelector<HTMLElement>(
		'[data-cell-row="0"][data-cell-field="name"]'
	)!;
	await fireEvent.pointerDown(selected, { button: 0, pointerId: 1 });
	await fireEvent.pointerUp(window, { pointerId: 1 });
	await fireEvent.click(screen.getByRole('button', { name: 'Nameの絞り込み' }));
	const dialog = screen.getByRole('dialog', { name: 'Nameの絞り込み' });
	return { container, selected, dialog, onCellEdit, onParamsChange };
}
function keyEvent(key: string, shiftKey = false) {
	return new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
}

describe.each(['client', 'server'] as const)('%s filter keyboard isolation', (mode) => {
	it.each(['textbox', 'combobox'] as const)(
		'leaves arrows, Tab and F2 to the focused %s',
		async (role) => {
			const { container, selected, dialog, onCellEdit, onParamsChange } = await setup(mode);
			const control = within(dialog).getByRole(role);
			control.focus();
			for (const [key, shiftKey] of [
				['ArrowRight', false],
				['ArrowDown', false],
				['ArrowLeft', false],
				['ArrowUp', false],
				['Tab', false],
				['Tab', true],
				['F2', false]
			] as const) {
				const event = keyEvent(key, shiftKey);
				await fireEvent(control, event);
				expect(event.defaultPrevented, `${role}: ${key}`).toBe(false);
				expect(container.querySelector('.cell.active')).toBe(selected);
				expect(container.querySelector('.cell-editor')).toBeNull();
				expect(document.activeElement).toBe(control);
			}
			expect(onCellEdit).not.toHaveBeenCalled();
			expect(onParamsChange).not.toHaveBeenCalled();
		}
	);

	it('applies input Enter once without opening the selected cell editor', async () => {
		const { container, selected, dialog, onCellEdit, onParamsChange } = await setup(mode);
		const input = within(dialog).getByRole('textbox');
		input.focus();
		await fireEvent.input(input, { target: { value: 'Alpha' } });
		await fireEvent(input, keyEvent('Enter'));
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(container.querySelector('.cell-editor')).toBeNull();
		expect(container.querySelector('.cell.active')).toBe(selected);
		expect(onCellEdit).not.toHaveBeenCalled();
		if (mode === 'server') {
			expect(onParamsChange).toHaveBeenCalledExactlyOnceWith({
				sort: [],
				filters: [{ field: 'name', op: 'contains', value: 'Alpha' }]
			});
		} else {
			expect(container.querySelectorAll('[data-cell-field="name"]')).toHaveLength(1);
			expect(selected.textContent).toBe('Alpha');
		}
	});

	it('leaves select Enter native without applying a filter or editing a cell', async () => {
		const { container, selected, dialog, onCellEdit, onParamsChange } = await setup(mode);
		const select = within(dialog).getByRole('combobox');
		select.focus();
		const event = keyEvent('Enter');
		await fireEvent(select, event);
		expect(event.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(select);
		expect(screen.getByRole('dialog')).toBe(dialog);
		expect(container.querySelector('.cell.active')).toBe(selected);
		expect(container.querySelector('.cell-editor')).toBeNull();
		expect(onParamsChange).not.toHaveBeenCalled();
		expect(onCellEdit).not.toHaveBeenCalled();
	});
});
