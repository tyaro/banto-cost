// @vitest-environment jsdom
/** Inline editors keep their names, error references and busy state local to each grid. */
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
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
	id: string;
	value: unknown;
	other: string;
}

function setup(
	column: GridColumn<Row>,
	value: unknown,
	onCellEdit?: (edit: CellEdit<Row>) => void | Promise<void>
) {
	return render(BantoGrid<Row>, {
		rows: [{ id: 'same row / id', value, other: 'Read only' }],
		columns: [column, { id: 'other', header: 'Other', accessor: 'other' }],
		getRowId: (row: Row) => row.id,
		onCellEdit
	});
}

async function open(container: HTMLElement, name: string) {
	await fireEvent.doubleClick(container.querySelector('[data-cell-field="value"]')!);
	return within(container).getByLabelText(name) as HTMLInputElement | HTMLSelectElement;
}

function associatedError(editor: HTMLElement) {
	const id = editor.getAttribute('aria-describedby');
	expect(id).toBeTruthy();
	const error = document.getElementById(id!);
	expect(error?.getAttribute('role')).toBe('alert');
	expect(editor.getAttribute('aria-invalid')).toBe('true');
	return error!;
}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe('inline editor accessibility', () => {
	it.each([
		{ editor: 'text', initial: 'Original', draft: 'Changed' },
		{ editor: 'number', initial: 1, draft: '2' },
		{ editor: 'date', initial: '2026-11-04', draft: '2026-12-01' },
		{ editor: 'select', initial: 'a', draft: 'b' },
		{ editor: 'checkbox', initial: false, draft: true }
	] as const)('names the $editor editor and associates its validation error', async (sample) => {
		const save = vi.fn();
		const { container } = setup(
			{
				id: 'value',
				header: 'Value',
				accessor: 'value',
				editable: true,
				editor: sample.editor,
				editorOptions: [
					{ value: 'a', label: 'Alpha' },
					{ value: 'b', label: 'Beta' }
				],
				validate: () => 'Rejected value'
			},
			sample.initial,
			save
		);
		const editor = await open(container, 'Value');
		expect(editor.getAttribute('aria-invalid')).toBe('false');
		expect(editor.hasAttribute('aria-describedby')).toBe(false);
		expect(editor.closest('[role="gridcell"]')?.getAttribute('aria-busy')).toBe('false');
		expect(container.querySelector('[data-cell-field="other"]')?.hasAttribute('aria-busy')).toBe(
			false
		);
		if (sample.editor === 'checkbox') await fireEvent.click(editor);
		else {
			await fireEvent[sample.editor === 'select' ? 'change' : 'input'](editor, {
				target: { value: sample.draft }
			});
			await fireEvent.keyDown(editor, { key: 'Enter' });
		}
		expect(associatedError(editor).textContent).toBe('Rejected value');
		expect(save).not.toHaveBeenCalled();
		await fireEvent.keyDown(editor, { key: 'Escape' });
		expect(within(container).queryByRole('alert')).toBeNull();
		expect(container.querySelector('[aria-busy]')).toBeNull();
	});

	it('keeps the editor mounted while retrying validation and save errors', async () => {
		let save = deferred();
		const onSave = vi.fn(() => save.promise);
		const { container } = setup(
			{
				id: 'value',
				header: 'Value',
				accessor: 'value',
				editable: true,
				validate: (value) => (value === 'bad' ? 'Invalid draft' : null)
			},
			'Original',
			onSave
		);
		const editor = await open(container, 'Value');
		await fireEvent.input(editor, { target: { value: 'bad' } });
		await fireEvent.keyDown(editor, { key: 'Enter' });
		const errorId = associatedError(editor).id;
		await fireEvent.input(editor, { target: { value: 'Valid draft' } });
		await fireEvent.keyDown(editor, { key: 'Enter' });
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(editor.closest('[role="gridcell"]')?.getAttribute('aria-busy')).toBe('true');
		expect(editor.disabled).toBe(false);
		expect(within(container).getByLabelText('Value')).toBe(editor);
		expect(editor.getAttribute('aria-invalid')).toBe('false');
		expect(editor.hasAttribute('aria-describedby')).toBe(false);
		expect(document.getElementById(errorId)).toBeNull();
		save.reject(new Error('Save failed'));
		await save.promise.catch(() => {});
		await tick();
		expect(associatedError(editor).id).toBe(errorId);
		expect(associatedError(editor).textContent).toBe('Save failed');
		expect(editor.closest('[role="gridcell"]')?.getAttribute('aria-busy')).toBe('false');
		expect(editor.value).toBe('Valid draft');
		save = deferred();
		await fireEvent.keyDown(editor, { key: 'Enter' });
		save.resolve();
		await save.promise;
		await tick();
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(container.querySelector('.cell-editor')).toBeNull();
		expect(container.querySelector('[aria-busy]')).toBeNull();
		expect(document.getElementById(errorId)).toBeNull();
	});

	it('falls back to the column ID and keeps identical grids error references separate', async () => {
		const column: GridColumn<Row> = {
			id: 'value',
			header: '  ',
			accessor: 'value',
			editable: true,
			validate: () => 'Invalid draft'
		};
		const views = [setup(column, 'Original'), setup(column, 'Original')];
		const ids: string[] = [];
		for (const { container } of views) {
			const editor = await open(container, 'value');
			await fireEvent.input(editor, { target: { value: 'Changed' } });
			await fireEvent.keyDown(editor, { key: 'Enter' });
			const error = associatedError(editor);
			expect(container.contains(error)).toBe(true);
			ids.push(error.id);
		}
		expect(new Set(ids).size).toBe(2);
		expect(document.querySelectorAll('[role="alert"]')).toHaveLength(2);
	});
});
