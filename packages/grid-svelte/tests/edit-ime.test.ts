// @vitest-environment jsdom
/** Synthetic key ownership checks, not an operating-system IME integration test. */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
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
const rows: Row[] = [
	{ id: 1, name: 'Original', category: 'First' },
	{ id: 2, name: 'Other', category: 'Second' }
];
const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name', editable: true },
	{ id: 'category', header: 'Category', accessor: 'category', editable: true }
];
const owners = ['composition', 'legacy229', 'already handled'] as const;
type Owner = (typeof owners)[number];
const cases = owners.flatMap((owner) => ['Enter', 'Escape', 'Tab'].map((key) => ({ owner, key })));
function ownedKey(key: string, owner: Owner) {
	const event = new KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		isComposing: owner === 'composition',
		keyCode: owner === 'legacy229' ? 229 : 0
	});
	if (owner === 'already handled') event.preventDefault();
	return event;
}
async function setup(
	mode: 'client' | 'server',
	save?: (edit: CellEdit<Row>) => void | Promise<void>
) {
	const onCellEdit = vi.fn(save ?? (() => {}));
	const view = render(BantoGrid<Row>, {
		rows,
		columns,
		mode,
		totalRows: rows.length,
		getRowId: (row: Row) => row.id,
		onCellEdit
	});
	const cell = view.container.querySelector('[data-cell-row="0"][data-cell-field="name"]')!;
	await fireEvent.doubleClick(cell);
	const editor = within(view.container).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
	editor.focus();
	await fireEvent.input(editor, { target: { value: '変換中の値' } });
	return { ...view, cell, editor, onCellEdit };
}

function expectDraft(view: Awaited<ReturnType<typeof setup>>) {
	expect(within(view.container).getByRole('textbox', { name: 'Name' })).toBe(view.editor);
	expect(view.editor.value).toBe('変換中の値');
	expect(view.container.querySelector('.cell.active')).toBe(view.cell);
	expect(document.activeElement).toBe(view.editor);
}

describe.each(['client', 'server'] as const)('%s editor key ownership', (mode) => {
	it.each(cases)(
		'$owner $key does not save, cancel or navigate; a later Enter saves once',
		async ({ owner, key }) => {
			const view = await setup(mode);
			const parentKey = vi.fn();
			window.addEventListener('keydown', parentKey);
			try {
				const event = ownedKey(key, owner);
				await fireEvent(view.editor, event);
				expect(event.defaultPrevented).toBe(owner === 'already handled');
				expect(parentKey).not.toHaveBeenCalled();
				expect(view.onCellEdit).not.toHaveBeenCalled();
				expectDraft(view);
				await fireEvent.keyDown(view.editor, { key: 'Enter' });
				await tick();
				expect(view.onCellEdit).toHaveBeenCalledExactlyOnceWith({
					row: rows[0],
					rowId: 1,
					field: 'name',
					oldValue: 'Original',
					value: '変換中の値'
				});
				expect(view.container.querySelector('.cell-editor')).toBeNull();
				expect(view.container.querySelector('.cell.active')?.getAttribute('data-cell-row')).toBe(
					'1'
				);
				expect(document.activeElement).toBe(within(view.container).getByRole('grid'));
			} finally {
				window.removeEventListener('keydown', parentKey);
			}
		}
	);

	it('retains pending suppression even for keys owned by the IME', async () => {
		let resolve!: () => void;
		const saved = new Promise<void>((done) => {
			resolve = done;
		});
		const view = await setup(mode, () => saved);
		await fireEvent.keyDown(view.editor, { key: 'Enter' });
		for (const { owner, key } of cases) {
			const event = ownedKey(key, owner);
			await fireEvent(view.editor, event);
			expect(event.defaultPrevented).toBe(true);
			expectDraft(view);
			expect(view.editor.classList.contains('pending')).toBe(true);
		}
		expect(view.onCellEdit).toHaveBeenCalledTimes(1);
		resolve();
		await saved;
		await tick();
		expect(view.container.querySelector('.cell-editor')).toBeNull();
	});

	it('preserves the existing save on explicit blur after a composing key', async () => {
		const view = await setup(mode);
		await fireEvent(view.editor, ownedKey('Tab', 'composition'));
		expect(view.onCellEdit).not.toHaveBeenCalled();
		// jsdom does not perform native Tab focus movement. Model a separate,
		// explicit focus departure without claiming to simulate an actual IME.
		const outside = document.createElement('button');
		view.container.appendChild(outside);
		outside.focus();
		await waitFor(() => expect(view.container.querySelector('.cell-editor')).toBeNull());
		expect(view.onCellEdit).toHaveBeenCalledTimes(1);
		expect(view.onCellEdit.mock.calls[0][0].value).toBe('変換中の値');
		expect(document.activeElement).toBe(outside);
	});
});
