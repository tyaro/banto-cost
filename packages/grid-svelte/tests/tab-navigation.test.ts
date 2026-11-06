// @vitest-environment jsdom
/**
 * Issue #211: non-editing Tab follows the browser's focus order while
 * editor Tab commits and moves selection (spec §4.5, §4.7).
 * jsdom does not perform native Tab navigation; these tests verify that
 * the event is left uncancelled and selection is unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import type { CellEdit, GridColumn } from '../src/types';

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

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name', editable: true, filterable: true },
	{ id: 'category', header: 'Category', accessor: 'category', editable: true },
	{
		id: 'open',
		header: 'Open',
		accessor: () => '',
		cell: (row) => ({ text: `Open ${row.name}`, href: `/items/${row.id}` })
	}
];
const rows: Row[] = [
	{ id: 1, name: 'Alpha', category: 'First' },
	{ id: 2, name: 'Beta', category: 'Second' }
];

function setup(onCellEdit = vi.fn<(edit: CellEdit<Row>) => void | Promise<void>>()) {
	return render(BantoGrid<Row>, {
		rows,
		columns,
		getRowId: (row: Row) => row.id,
		onCellEdit
	});
}

function cell(container: HTMLElement, rowIndex: number, field: string) {
	return container.querySelector<HTMLElement>(
		`[data-cell-row="${rowIndex}"][data-cell-field="${field}"]`
	)!;
}

async function selectCell(container: HTMLElement, rowIndex: number, field: string) {
	const target = cell(container, rowIndex, field);
	await fireEvent.pointerDown(target, { button: 0, pointerId: 1 });
	await fireEvent.pointerUp(window, { pointerId: 1 });
	expect(document.activeElement).toBe(screen.getByRole('grid'));
	expect(container.querySelector('.cell.active')).toBe(target);
	return target;
}

function tabEvent(shiftKey: boolean) {
	return new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
}

describe.each([
	{ direction: 'Tab', shiftKey: false },
	{ direction: 'Shift+Tab', shiftKey: true }
])('non-editing $direction', ({ shiftKey }) => {
	it.each(['name', 'category', 'open'])(
		'keeps native focus navigation available when the selected column is %s',
		async (field) => {
			const { container } = setup();
			const selected = await selectCell(container, 0, field);
			const event = tabEvent(shiftKey);
			await fireEvent(screen.getByRole('grid'), event);
			expect(event.defaultPrevented).toBe(false);
			expect(container.querySelector('.cell.active')).toBe(selected);
			expect(screen.queryByRole('textbox')).toBeNull();
		}
	);

	it.each([
		{ role: 'button', name: 'Name' },
		{ role: 'button', name: 'Nameの絞り込み' },
		{ role: 'link', name: 'Open Alpha' }
	])('does not intercept a bubbled event from $name', async ({ role, name }) => {
		const { container } = setup();
		const selected = await selectCell(container, 0, 'category');
		const target = screen.getByRole(role, { name });
		target.focus();
		expect(document.activeElement).toBe(target);
		const event = tabEvent(shiftKey);
		await fireEvent(target, event);
		expect(event.defaultPrevented).toBe(false);
		expect(container.querySelector('.cell.active')).toBe(selected);
	});
});

it('continues to use arrow keys for cell navigation', async () => {
	const { container } = setup();
	await selectCell(container, 0, 'category');
	for (const { key, rowIndex, field } of [
		{ key: 'ArrowRight', rowIndex: 0, field: 'open' },
		{ key: 'ArrowLeft', rowIndex: 0, field: 'category' },
		{ key: 'ArrowDown', rowIndex: 1, field: 'category' },
		{ key: 'ArrowUp', rowIndex: 0, field: 'category' }
	]) {
		const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
		await fireEvent(screen.getByRole('grid'), event);
		expect(event.defaultPrevented).toBe(true);
		expect(container.querySelector('.cell.active')).toBe(cell(container, rowIndex, field));
	}
});

describe('keyboard actions on focused grid descendants', () => {
	it.each(['Enter', ' '])('lets the sort header handle %s exactly once', async (key) => {
		const { container } = setup();
		const selected = await selectCell(container, 0, 'name');
		const target = screen.getByRole('button', { name: 'Name' });
		const header = target.closest('[role="columnheader"]')!;
		expect(header.getAttribute('aria-sort')).toBe('none');
		target.focus();
		await fireEvent.keyDown(target, { key });
		expect(header.getAttribute('aria-sort')).toBe('ascending');
		expect(document.activeElement).toBe(target);
		expect(container.querySelector('.cell.active')).toBe(selected);
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it.each([
		{ role: 'button', name: 'Nameの絞り込み' },
		{ role: 'link', name: 'Open Alpha' }
	])('preserves native Enter activation on $name', async ({ role, name }) => {
		const { container } = setup();
		const selected = await selectCell(container, 0, 'name');
		const target = screen.getByRole(role, { name });
		target.focus();
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			bubbles: true,
			cancelable: true
		});
		await fireEvent(target, event);
		// jsdom does not synthesize the native click; browser E2E covers activation.
		expect(event.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(target);
		expect(container.querySelector('.cell.active')).toBe(selected);
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it.each(['ArrowDown', 'Home', 'End', 'F2'])(
		'does not apply the grid %s shortcut while a child control has focus',
		async (key) => {
			const { container } = setup();
			const selected = await selectCell(container, 0, 'category');
			const target = screen.getByRole('button', { name: 'Nameの絞り込み' });
			target.focus();
			const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
			await fireEvent(target, event);
			expect(event.defaultPrevented).toBe(false);
			expect(document.activeElement).toBe(target);
			expect(container.querySelector('.cell.active')).toBe(selected);
			expect(screen.queryByRole('textbox')).toBeNull();
		}
	);
});

it.each(['Enter', 'F2'])(
	'still starts editing with %s when the grid itself has focus',
	async (key) => {
		const { container } = setup();
		const selected = await selectCell(container, 0, 'name');
		const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
		await fireEvent(screen.getByRole('grid'), event);
		expect(event.defaultPrevented).toBe(true);
		expect(screen.getByRole('textbox')).toHaveProperty('value', 'Alpha');
		expect(container.querySelector('.cell.active')).toBe(selected);
	}
);

it.each([
	{ direction: 'Tab', shiftKey: false, nextField: 'open' },
	{ direction: 'Shift+Tab', shiftKey: true, nextField: 'name' }
])(
	'keeps editor $direction as one commit followed by cell movement',
	async ({ shiftKey, nextField }) => {
		let finishSave!: () => void;
		const save = new Promise<void>((resolve) => {
			finishSave = resolve;
		});
		const onCellEdit = vi.fn<(edit: CellEdit<Row>) => void | Promise<void>>(() => save);
		const { container } = setup(onCellEdit);
		await fireEvent.doubleClick(cell(container, 0, 'category'));
		const editor = screen.getByRole('textbox');
		await fireEvent.input(editor, { target: { value: 'Updated category' } });
		const event = tabEvent(shiftKey);
		await fireEvent(editor, event);
		expect(event.defaultPrevented).toBe(true);
		expect(onCellEdit).toHaveBeenCalledTimes(1);
		expect(onCellEdit).toHaveBeenCalledWith({
			row: rows[0],
			rowId: 1,
			field: 'category',
			oldValue: 'First',
			value: 'Updated category'
		});
		expect(container.querySelector('.cell.active')).toBe(cell(container, 0, 'category'));
		finishSave();
		await waitFor(() => {
			expect(container.querySelector('.cell.active')).toBe(cell(container, 0, nextField));
		});
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(onCellEdit).toHaveBeenCalledTimes(1);
	}
);
