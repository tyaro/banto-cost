// @vitest-environment jsdom
/** Issue #210: a save response belongs to the edit session that submitted it (spec §4.5). */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import type { CellEdit, GridColumn } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	// jsdom has no layout; match the viewport stubs in BantoGrid.test.ts.
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
	{ id: 'name', header: 'Name', accessor: 'name', editable: true },
	{ id: 'category', header: 'Category', accessor: 'category', editable: true }
];
const rows: Row[] = [
	{ id: 1, name: 'Alpha', category: 'First' },
	{ id: 2, name: 'Beta', category: 'Second' },
	{ id: 3, name: 'Gamma', category: 'Second' }
];
type Outcome = 'success' | 'failure';

function deferredSave() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function finishSave(save: ReturnType<typeof deferredSave>, outcome: Outcome) {
	if (outcome === 'success') save.resolve();
	else save.reject(new Error('Save failed'));
	// The component subscribed before this await. Drain its save continuation,
	// subsequent keyboard navigation, and Svelte rendering before asserting
	// that a later draft is unchanged; an immediate negative assertion can pass
	// before the stale response has had any chance to affect the component.
	await save.promise.catch(() => {});
	await tick();
}

function setup(mode: 'client' | 'server' = 'client') {
	const edits: CellEdit<Row>[] = [];
	const saves: ReturnType<typeof deferredSave>[] = [];
	const view = render(BantoGrid<Row>, {
		rows,
		columns,
		mode,
		totalRows: rows.length,
		getRowId: (row: Row) => row.id,
		onCellEdit: (edit: CellEdit<Row>) => {
			edits.push(edit);
			const save = deferredSave();
			saves.push(save);
			return save.promise;
		}
	});
	return { ...view, edits, saves };
}

function cell(container: HTMLElement, rowIndex: number, field = 'name') {
	return container.querySelector(`[data-cell-row="${rowIndex}"][data-cell-field="${field}"]`)!;
}

async function startDraft(container: HTMLElement, rowIndex: number, value: string) {
	await fireEvent.doubleClick(cell(container, rowIndex));
	const editor = screen.getByRole('textbox') as HTMLInputElement;
	await fireEvent.input(editor, { target: { value } });
	return editor;
}

function assertDraft(container: HTMLElement, rowIndex: number, value: string, pending = false) {
	const editor = screen.getByRole('textbox') as HTMLInputElement;
	expect(editor.value).toBe(value);
	expect(editor.closest('.cell')).toBe(cell(container, rowIndex));
	expect(container.querySelector('.cell.active')).toBe(cell(container, rowIndex));
	expect(editor.classList.contains('pending')).toBe(pending);
	expect(screen.queryByRole('alert')).toBeNull();
	return editor;
}

describe.each(['client', 'server'] as const)('edit session isolation (%s)', (mode) => {
	it.each(['success', 'failure'] as const)(
		'preserves another row draft when an earlier save reports %s',
		async (outcome) => {
			const { container, edits, saves } = setup(mode);
			const alpha = await startDraft(container, 0, 'Alpha draft');
			await fireEvent.keyDown(alpha, { key: 'Enter' });
			expect(saves).toHaveLength(1);
			expect(alpha.classList.contains('pending')).toBe(true);
			await startDraft(container, 1, 'Beta draft');
			await finishSave(saves[0], outcome);
			const beta = assertDraft(container, 1, 'Beta draft');
			expect(edits).toHaveLength(1);
			await fireEvent.keyDown(beta, { key: 'Enter' });
			expect(edits).toHaveLength(2);
			expect(edits[1]).toMatchObject({
				rowId: 2,
				field: 'name',
				oldValue: 'Beta',
				value: 'Beta draft'
			});
			await finishSave(saves[1], 'success');
			expect(screen.queryByRole('textbox')).toBeNull();
			expect(container.querySelector('.cell.active')).toBe(cell(container, 2));
		}
	);
});

it.each(['success', 'failure'] as const)(
	'preserves a new draft in the same cell when an earlier save reports %s',
	async (outcome) => {
		const { container, edits, saves } = setup();
		const first = await startDraft(container, 0, 'First Alpha draft');
		await fireEvent.keyDown(first, { key: 'Enter' });
		await startDraft(container, 0, 'Second Alpha draft');
		await finishSave(saves[0], outcome);
		const second = assertDraft(container, 0, 'Second Alpha draft');
		await fireEvent.keyDown(second, { key: 'Enter' });
		expect(edits).toHaveLength(2);
		expect(edits[1]).toMatchObject({ rowId: 1, field: 'name', value: 'Second Alpha draft' });
		await finishSave(saves[1], 'success');
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(container.querySelector('.cell.active')).toBe(cell(container, 1));
	}
);

it.each(['success', 'failure'] as const)(
	'does not reopen an editor or move selection after a later edit is cancelled and the old save reports %s',
	async (outcome) => {
		const { container, edits, saves } = setup();
		const alpha = await startDraft(container, 0, 'Alpha draft');
		await fireEvent.keyDown(alpha, { key: 'Enter' });
		const beta = await startDraft(container, 1, 'Beta draft');
		await fireEvent.keyDown(beta, { key: 'Escape' });
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(container.querySelector('.cell.active')).toBe(cell(container, 1));
		await finishSave(saves[0], outcome);
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(container.querySelector('.cell.active')).toBe(cell(container, 1));
		expect(edits).toHaveLength(1);
	}
);

it.each(['success', 'failure'] as const)(
	'keeps a later save pending when the old save reports %s',
	async (outcome) => {
		const { container, edits, saves } = setup();
		const alpha = await startDraft(container, 0, 'Alpha draft');
		await fireEvent.keyDown(alpha, { key: 'Enter' });
		const beta = await startDraft(container, 1, 'Beta draft');
		await fireEvent.keyDown(beta, { key: 'Enter' });
		expect(edits).toHaveLength(2);
		assertDraft(container, 1, 'Beta draft', true);
		await finishSave(saves[0], outcome);
		assertDraft(container, 1, 'Beta draft', true);
		await finishSave(saves[1], 'success');
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(container.querySelector('.cell.active')).toBe(cell(container, 2));
	}
);

it('does not navigate a new session started between save completion and keyboard navigation', async () => {
	const { container, edits, saves } = setup();
	const alpha = await startDraft(container, 0, 'Alpha draft');
	await fireEvent.keyDown(alpha, { key: 'Enter' });
	const startedNextSession = saves[0].promise.then(async () => {
		// Svelte's development await wrapper adds a microtask before the
		// commitValue continuation. Prove Alpha has closed, but navigation
		// has not run, before synchronously starting Beta in that gap.
		await Promise.resolve();
		flushSync();
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(container.querySelector('.cell.active')).toBe(cell(container, 0));
		cell(container, 1).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
	});
	await finishSave(saves[0], 'success');
	await startedNextSession;
	const beta = assertDraft(container, 1, 'Beta');
	await fireEvent.input(beta, { target: { value: 'Beta draft' } });
	assertDraft(container, 1, 'Beta draft');
	expect(edits).toHaveLength(1);
});

it.each([
	{ key: 'Enter', rowIndex: 1, field: 'name' },
	{ key: 'Tab', rowIndex: 0, field: 'category' }
])(
	'moves the active cell after the current session saves with $key',
	async ({ key, rowIndex, field }) => {
		const { container, edits, saves } = setup();
		const alpha = await startDraft(container, 0, 'Alpha draft');
		await fireEvent.keyDown(alpha, { key });
		assertDraft(container, 0, 'Alpha draft', true);
		expect(edits).toHaveLength(1);
		await finishSave(saves[0], 'success');
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(container.querySelector('.cell.active')).toBe(cell(container, rowIndex, field));
	}
);

it('keeps a failed current draft editable and allows a retry', async () => {
	const { container, edits, saves } = setup();
	const alpha = await startDraft(container, 0, 'Alpha draft');
	await fireEvent.keyDown(alpha, { key: 'Enter' });
	await finishSave(saves[0], 'failure');
	const editor = screen.getByRole('textbox') as HTMLInputElement;
	expect(editor.value).toBe('Alpha draft');
	expect(editor.classList.contains('pending')).toBe(false);
	expect(screen.getByRole('alert').textContent).toBe('Save failed');
	expect(container.querySelector('.cell.active')).toBe(cell(container, 0));
	await fireEvent.input(editor, { target: { value: 'Alpha retry' } });
	await fireEvent.keyDown(editor, { key: 'Enter' });
	expect(edits).toHaveLength(2);
	expect(edits[1]).toMatchObject({ rowId: 1, field: 'name', value: 'Alpha retry' });
	assertDraft(container, 0, 'Alpha retry', true);
	await finishSave(saves[1], 'success');
	expect(screen.queryByRole('textbox')).toBeNull();
	expect(container.querySelector('.cell.active')).toBe(cell(container, 1));
});
