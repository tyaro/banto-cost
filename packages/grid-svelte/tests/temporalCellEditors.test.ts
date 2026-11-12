// @vitest-environment jsdom
/**
 * Time and date-and-time cell editors (date-time-pickers §5.8, PR-5): the
 * injected `@banto/ui` `TimeInput` / `DateTimeInput` (a relative import - a
 * test may read another package's source, `src` may not) keep the grid's
 * edit state machine as `DateInput` does (cellEditors.test.ts): handled keys
 * never reach the grid, the first Enter / Esc belongs to the picker and the
 * next one to the grid, a click inside the dialog neither commits nor
 * unmounts the editor. Plus the native fallback and pasting.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DateTimeInput from '../../ui/src/DateTimeInput.svelte';
import TimeInput from '../../ui/src/TimeInput.svelte';
import type { CellEditors } from '../src/cellEditors';
import { columnsFromSchema } from '../src/core/schema';
import type { CellEdit, GridColumn } from '../src/types';
import CellEditorsHarness from './CellEditorsHarness.svelte';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

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
	const proto = HTMLElement.prototype as unknown as PopoverElement;
	proto.showPopover = function (this: HTMLElement) {
		this.dataset.popoverOpen = 'true';
		this.style.display = 'block';
	};
	proto.hidePopover = function (this: HTMLElement) {
		delete this.dataset.popoverOpen;
		this.style.removeProperty('display');
	};
});
afterEach(cleanup);

interface Row {
	id: number;
	at: string | null;
	starts: string | null;
}
const rows: Row[] = [
	{ id: 1, at: '09:30', starts: '2026-11-07T09:30' },
	{ id: 2, at: null, starts: null }
];
const columns: GridColumn<Row>[] = columnsFromSchema<Row>({
	fields: [
		{ name: 'at', label: 'At', type: 'time', min: '09:00', max: '18:00', step: 15 },
		{
			name: 'starts',
			label: 'Starts',
			type: 'datetime',
			min: '2026-11-02T09:00',
			max: '2026-11-27T18:00',
			step: 30
		}
	]
});

const injected: CellEditors = { time: TimeInput, datetime: DateTimeInput };

function setup(provided: CellEditors = injected) {
	const onCellEdit = vi.fn();
	const onRangePaste = vi.fn();
	const view = render(CellEditorsHarness<Row>, {
		provided,
		rows,
		columns,
		getRowId: (row: Row) => row.id,
		onCellEdit,
		onRangePaste
	});
	const grid = screen.getByRole('grid');
	const cell = (row: number, field: string) =>
		view.container.querySelector<HTMLElement>(
			`[data-cell-row="${row}"][data-cell-field="${field}"]`
		)!;
	return { ...view, grid, cell, onCellEdit, onRangePaste };
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const list = () => document.querySelector<HTMLElement>('[role="listbox"]');
const day = (date: string) => document.querySelector<HTMLElement>(`[data-date="${date}"]`)!;
const option = (time: string) => document.querySelector<HTMLElement>(`[data-time="${time}"]`)!;

describe('native fallback (D3-a)', () => {
	it('without injected editors: native time / datetime-local with the column’s bounds', async () => {
		const { cell } = setup({});
		await fireEvent.doubleClick(cell(0, 'at'));
		const time = cell(0, 'at').querySelector('input')!;
		expect(time.type).toBe('time');
		expect(time.min).toBe('09:00');
		expect(time.step).toBe('900');
		await fireEvent.keyDown(time, { key: 'Escape' });
		await fireEvent.doubleClick(cell(0, 'starts'));
		const dateTime = cell(0, 'starts').querySelector('input')!;
		expect(dateTime.type).toBe('datetime-local');
		expect(dateTime.value).toBe('2026-11-07T09:30');
		expect(dateTime.max).toBe('2026-11-27T18:00');
	});
});

describe('DateTimeInput in a cell (§5.8)', () => {
	async function startEditing(cell: HTMLElement) {
		await fireEvent.doubleClick(cell);
		const input = screen.getByRole('textbox', { name: 'Starts' }) as HTMLInputElement;
		expect(document.activeElement).toBe(input);
		return input;
	}

	it('shows the draft with a space and gets the column’s range', async () => {
		const { cell } = setup();
		const input = await startEditing(cell(0, 'starts'));
		expect(input.value).toBe('2026-11-07 09:30');
		expect(cell(0, 'starts').textContent).not.toContain('T09');
	});

	it('a day then a time only drafts (D11); the next Enter commits the canonical value', async () => {
		const { cell, grid, onCellEdit } = setup();
		const input = await startEditing(cell(0, 'starts'));
		await fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
		flushSync();
		expect(dialog()).not.toBeNull();
		await fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		await fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		expect(document.activeElement).toBe(list());
		await fireEvent.keyDown(list()!, { key: 'ArrowDown' });
		await fireEvent.keyDown(list()!, { key: 'Enter' });
		flushSync();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe('2026-11-08 10:00');
		expect(cell(0, 'starts').classList.contains('editing')).toBe(true);
		expect(onCellEdit).not.toHaveBeenCalled();
		await fireEvent.keyDown(input, { key: 'Enter' });
		await tick();
		expect(onCellEdit).toHaveBeenCalledTimes(1);
		expect(onCellEdit.mock.calls[0][0]).toMatchObject({
			field: 'starts',
			value: '2026-11-08T10:00',
			oldValue: '2026-11-07T09:30'
		});
		expect(document.activeElement).toBe(grid);
	});

	it('Esc in the list closes the dialog only; the second Esc cancels the edit', async () => {
		const { cell, grid, onCellEdit } = setup();
		const input = await startEditing(cell(0, 'starts'));
		await fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
		flushSync();
		list()!.focus();
		await fireEvent.keyDown(list()!, { key: 'Escape' });
		flushSync();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(input);
		expect(cell(0, 'starts').classList.contains('editing')).toBe(true);
		await fireEvent.keyDown(input, { key: 'Escape' });
		expect(cell(0, 'starts').classList.contains('editing')).toBe(false);
		expect(document.activeElement).toBe(grid);
		expect(onCellEdit).not.toHaveBeenCalled();
	});

	it('clicking a day and a time with the mouse neither commits nor unmounts the editor', async () => {
		const { cell, onCellEdit } = setup();
		const input = await startEditing(cell(0, 'starts'));
		const button = cell(0, 'starts').querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
		await fireEvent.pointerDown(button, { button: 0 });
		await fireEvent.click(button);
		flushSync();
		for (const target of [day('2026-11-20'), option('14:30')]) {
			await fireEvent.pointerDown(target, { button: 0 });
			await fireEvent.mouseDown(target);
			await fireEvent.click(target);
			flushSync();
		}
		expect(dialog()).toBeNull();
		expect(cell(0, 'starts').classList.contains('editing')).toBe(true);
		expect(input.isConnected).toBe(true);
		expect(input.value).toBe('2026-11-20 14:30');
		expect(document.activeElement).toBe(input);
		expect(onCellEdit).not.toHaveBeenCalled();
	});

	it('typed text stays as typed; a picked value is the editor’s value (its button names it)', async () => {
		const { cell } = setup();
		const input = await startEditing(cell(0, 'starts'));
		const button = cell(0, 'starts').querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
		expect(button.getAttribute('aria-label')).toContain('09:30');
		fireEvent.input(input, { target: { value: '2026-11-09T11:00' } });
		flushSync();
		expect(input.value).toBe('2026-11-09T11:00');
		await fireEvent.click(button);
		flushSync();
		await fireEvent.click(option('12:00'));
		flushSync();
		expect(input.value).toBe('2026-11-09 12:00');
		expect(button.getAttribute('aria-label')).toContain('12:00');
	});

	it('typed text is normalised on commit; a breach of the rules is an edit error', async () => {
		const { cell, onCellEdit } = setup();
		let input = await startEditing(cell(0, 'starts'));
		fireEvent.input(input, { target: { value: '2026/11/10 9' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		await tick();
		expect(onCellEdit.mock.calls[0][0]).toMatchObject({ value: '2026-11-10T09:00' });
		input = await startEditing(cell(1, 'starts'));
		fireEvent.input(input, { target: { value: '2026-11-10 09:10' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		await tick();
		expect(onCellEdit).toHaveBeenCalledTimes(1);
		expect(cell(1, 'starts').classList.contains('editing')).toBe(true);
		expect(input.getAttribute('aria-invalid')).toBe('true');
	});
});

describe('TimeInput in a cell (§5.8)', () => {
	it('Enter in the open list picks; the next Enter commits', async () => {
		const { cell, onCellEdit } = setup();
		await fireEvent.doubleClick(cell(0, 'at'));
		const input = screen.getByRole('combobox', { name: 'At' }) as HTMLInputElement;
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'Enter' });
		flushSync();
		expect(input.value).toBe('09:45');
		expect(onCellEdit).not.toHaveBeenCalled();
		await fireEvent.keyDown(input, { key: 'Enter' });
		await tick();
		expect(onCellEdit.mock.calls[0][0]).toMatchObject({
			field: 'at',
			value: '09:45',
			oldValue: '09:30'
		});
	});
});

describe('pasting into time / datetime columns (§5.10)', () => {
	it('normalises Excel’s forms and skips what does not parse or breaks the rules', async () => {
		const { cell, grid, onRangePaste } = setup();
		await fireEvent.pointerDown(cell(0, 'at'), { button: 0 });
		await fireEvent.paste(grid, {
			clipboardData: { getData: () => '9:15\t2026/11/10 9:30\n9:10\t11/12 9:00' }
		});
		const [edits, info] = onRangePaste.mock.calls[0];
		expect(edits.map((edit: CellEdit<Row>) => [edit.rowId, edit.field, edit.value])).toEqual([
			[1, 'at', '09:15'],
			[1, 'starts', '2026-11-10T09:30']
		]);
		// Row 2: 9:10 is off the 15-minute step, 11/12 has no year (never guessed on paste).
		expect(info.skipped).toBe(2);
	});
});
