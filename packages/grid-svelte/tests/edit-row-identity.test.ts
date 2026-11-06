// @vitest-environment jsdom
/** Issue #205: an inline draft belongs to a row ID, never its display index. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { GridState } from '../src/state.svelte';
import type { CellEdit, GridColumn } from '../src/types';
import { createReactiveRows } from './fixtures/rows.svelte';

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
	{ id: 'category', header: 'Category', accessor: 'category' }
];
const rows: Row[] = [
	{ id: 1, name: 'Alpha', category: 'First' },
	{ id: 2, name: 'Beta', category: 'Second' },
	{ id: 3, name: 'Gamma', category: 'Second' }
];

function setup(mode: 'client' | 'server' = 'client', save?: Promise<void>) {
	const edits: CellEdit<Row>[] = [];
	const state = new GridState(columns);
	const view = render(BantoGrid<Row>, {
		rows,
		columns,
		state,
		mode,
		totalRows: rows.length,
		getRowId: (row: Row) => row.id,
		onCellEdit: (edit: CellEdit<Row>) => {
			edits.push(edit);
			return save;
		}
	});
	return { ...view, edits, state };
}

async function startDraft(container: HTMLElement, rowIndex: number, value = 'Beta draft') {
	await fireEvent.doubleClick(
		container.querySelector(`[data-cell-row="${rowIndex}"][data-cell-field="name"]`)!
	);
	await fireEvent.input(screen.getByRole('textbox'), { target: { value } });
}

async function assertDraftAndCommit(rowIndex: number, edits: CellEdit<Row>[]) {
	const editor = screen.getByRole('textbox') as HTMLInputElement;
	expect(editor.value).toBe('Beta draft');
	expect(editor.closest('[data-cell-row]')?.getAttribute('data-cell-row')).toBe(String(rowIndex));
	expect(editor.closest('.cell')?.classList.contains('active')).toBe(true);
	await fireEvent.keyDown(editor, { key: 'Enter' });
	expect(edits).toHaveLength(1);
	expect(edits[0]).toMatchObject({
		rowId: 2,
		row: { id: 2 },
		field: 'name',
		oldValue: 'Beta',
		value: 'Beta draft'
	});
}

describe.each(['client', 'server'] as const)('inline edit row identity (%s)', (mode) => {
	it('keeps the clicked cell selected while a different row saves on blur', async () => {
		let finishSave!: () => void;
		const save = new Promise<void>((resolve) => (finishSave = resolve));
		const { container, edits } = setup(mode, save);
		await startDraft(container, 0, 'Alpha draft');
		const editor = screen.getByRole('textbox') as HTMLInputElement;
		editor.focus();
		// pointerdown focuses the grid, synchronously blurring Alpha's editor.
		const betaCell = container.querySelector('[data-cell-row="1"][data-cell-field="name"]')!;
		await fireEvent.pointerDown(betaCell, { button: 0, pointerId: 1 });
		await fireEvent.pointerUp(window, { button: 0, pointerId: 1 });
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ rowId: 1, value: 'Alpha draft' });
		expect(editor.classList.contains('pending')).toBe(true);
		expect.soft(container.querySelector('.cell.active')).toBe(betaCell);
		finishSave();
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
		expect(container.querySelector('.cell.active')).toBe(betaCell);
	});

	it('does not move an independently selected cell when the saving row moves', async () => {
		let finishSave!: () => void;
		const save = new Promise<void>((resolve) => (finishSave = resolve));
		const { container, rerender } = setup(mode, save);
		await startDraft(container, 0, 'Alpha draft');
		(screen.getByRole('textbox') as HTMLInputElement).focus();
		const betaCell = container.querySelector('[data-cell-row="1"][data-cell-field="name"]')!;
		await fireEvent.pointerDown(betaCell, { button: 0, pointerId: 1 });
		await fireEvent.pointerUp(window, { button: 0, pointerId: 1 });
		// Beta remains at index 1 while Alpha changes position during its save.
		await rerender({ rows: [rows[2], rows[1], rows[0]] });
		expect(
			screen.getByRole('textbox').closest('[data-cell-row]')?.getAttribute('data-cell-row')
		).toBe('2');
		expect.soft(container.querySelector('.cell.active')).toBe(betaCell);
		finishSave();
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
		expect(container.querySelector('.cell.active')).toBe(betaCell);
	});

	it('keeps the draft on the same row after an incoming reorder', async () => {
		const { container, rerender, edits } = setup(mode);
		await startDraft(container, 1);
		// Fresh objects model a provider refresh rather than in-place DOM movement.
		await rerender({ rows: [rows[1], rows[2], rows[0]].map((row) => ({ ...row })) });
		await assertDraftAndCommit(0, edits);
	});

	it('keeps the draft on the same row after a preceding row is deleted', async () => {
		const { container, rerender, edits } = setup(mode);
		await startDraft(container, 1);
		await rerender({ rows: rows.slice(1), totalRows: 2 });
		await assertDraftAndCommit(0, edits);
	});

	it('cancels when the edited row disappears and does not resurrect the draft', async () => {
		const { container, rerender, edits } = setup(mode);
		await startDraft(container, 1);
		await rerender({ rows: [rows[0], rows[2]], totalRows: 2 });
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(edits).toHaveLength(0);
		await rerender({ rows, totalRows: 3 });
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(edits).toHaveLength(0);
	});
});

it('preserves the edited row when client sorting changes its position', async () => {
	const { container, state, edits } = setup();
	await startDraft(container, 1);
	// Category descending puts the Second rows first; name ascending orders
	// them Beta, Gamma, so the edited Beta moves from index 1 to 0. (A
	// category-only sort would break the Beta/Gamma tie by id in the same
	// descending direction - Issue #243's list-order contract - and leave
	// Beta where it was.)
	state.sort = [
		{ field: 'category', direction: 'desc' },
		{ field: 'name', direction: 'asc' }
	];
	await tick();
	await assertDraftAndCommit(0, edits);
});

it('preserves the edited row when group headers change display indices', async () => {
	const { container, state, edits } = setup();
	await startDraft(container, 1);
	state.setGroupBy('category');
	await tick();
	// First header, Alpha, Second header, Beta, Gamma.
	await assertDraftAndCommit(3, edits);
});

it('cancels when a sparse server refresh replaces the edited row with a hole', async () => {
	const { container, rerender, edits } = setup('server');
	await startDraft(container, 1);
	await rerender({ rows: [rows[0], undefined, rows[2]] });
	expect(screen.queryByRole('textbox')).toBeNull();
	expect(edits).toHaveLength(0);
	// Loading another record into that slot must not inherit the abandoned edit.
	await rerender({ rows: [rows[0], { id: 4, name: 'Delta', category: 'Second' }, rows[2]] });
	expect(screen.queryByRole('textbox')).toBeNull();
	expect(edits).toHaveLength(0);
});

describe.each([100_000, 1_000_000])('sparse server edit lookup (%i row extent)', (totalRows) => {
	it('reads loaded rows without traversing holes when editing and cancelling', async () => {
		const tailIndex = totalRows - 2;
		const sparseRows = new Array<Row | undefined>(totalRows);
		sparseRows[tailIndex] = rows[1];
		let numericReads = 0;
		const counted = () =>
			new Proxy(sparseRows, {
				get(target, key, receiver) {
					if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) numericReads++;
					return Reflect.get(target, key, receiver);
				}
			});
		const edits: CellEdit<Row>[] = [];
		const { container, rerender } = render(BantoGrid<Row>, {
			rows: counted(),
			columns,
			mode: 'server',
			totalRows,
			rowHeight: 32,
			getRowId: (row: Row) => row.id,
			onCellEdit: (edit: CellEdit<Row>) => {
				edits.push(edit);
			}
		});
		const grid = screen.getByRole('grid');
		grid.scrollTop = tailIndex * 32 + 32;
		await fireEvent.scroll(grid);
		numericReads = 0;
		await startDraft(container, tailIndex);
		// Count array accesses rather than time: the same fixed viewport and
		// one loaded row must cost the same for 100k and 1m logical rows.
		expect.soft(numericReads).toBeLessThan(300);
		delete sparseRows[tailIndex];
		numericReads = 0;
		await rerender({ rows: counted() });
		expect.soft(numericReads).toBeLessThan(300);
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(edits).toHaveLength(0);
	});
});

it('tracks relocation and deletion within the same reactive sparse array', async () => {
	const sparseRows = createReactiveRows<Row>(1_000);
	sparseRows[990] = rows[1];
	const edits: CellEdit<Row>[] = [];
	const { container } = render(BantoGrid<Row>, {
		rows: sparseRows,
		columns,
		mode: 'server',
		totalRows: 1_000,
		rowHeight: 32,
		getRowId: (row: Row) => row.id,
		onCellEdit: (edit: CellEdit<Row>) => {
			edits.push(edit);
		}
	});
	const grid = screen.getByRole('grid');
	grid.scrollTop = 988 * 32 + 32;
	await fireEvent.scroll(grid);
	await startDraft(container, 990);
	// A windowed provider can fill/delete slots without replacing rows.
	sparseRows[992] = { ...rows[1] };
	delete sparseRows[990];
	await tick();
	const editor = screen.getByRole('textbox') as HTMLInputElement;
	expect(editor.value).toBe('Beta draft');
	expect(editor.closest('[data-cell-row]')?.getAttribute('data-cell-row')).toBe('992');
	expect(editor.closest('.cell')?.classList.contains('active')).toBe(true);
	delete sparseRows[992];
	await tick();
	expect(screen.queryByRole('textbox')).toBeNull();
	sparseRows[992] = { id: 4, name: 'Delta', category: 'Second' };
	await tick();
	expect(screen.queryByRole('textbox')).toBeNull();
	expect(edits).toHaveLength(0);
});
