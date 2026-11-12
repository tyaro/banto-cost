// @vitest-environment jsdom
/**
 * Injected cell editors (date-time-pickers §5.8, PR-4): `provideCellEditors`
 * / the `cellEditors` prop with the native fallback (D3-a), and the grid's
 * edit state machine with the real `@banto/ui` `DateInput` injected (a
 * relative import - a test may read another package's source, `src` may
 * not, conventions §4): Esc in two steps, Enter in two steps, focus moving
 * into the calendar is not a blur, and pressing the button or a day with the
 * mouse neither commits nor unmounts the editor (promise 4 and the widened
 * `relinquishFocus`). jsdom has no Popover API: the stand-in from the ui
 * tests is installed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync, tick, type Component } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DateInput from '../../ui/src/DateInput.svelte';
import DateRangeInput from '../../ui/src/DateRangeInput.svelte';
import type { CellEditors, FilterDateRangeInputProps } from '../src/cellEditors';
import { columnsFromSchema } from '../src/core/schema';
import type { CellEdit, GridColumn } from '../src/types';
import CellEditorsHarness from './CellEditorsHarness.svelte';
import StubDateEditor from './StubDateEditor.svelte';

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
	due: string | null;
	name: string;
}
const rows: Row[] = [
	{ id: 1, due: '2026-11-07', name: 'Alpha' },
	{ id: 2, due: null, name: 'Beta' }
];
const columns: GridColumn<Row>[] = columnsFromSchema<Row>({
	fields: [
		{ name: 'due', label: 'Due', type: 'date', min: '2026-11-02', max: '2026-11-27' },
		{ name: 'name', label: 'Name', type: 'text' }
	]
});

function setup(
	options: {
		provided?: CellEditors;
		cellEditors?: CellEditors;
		onCellEdit?: (edit: CellEdit<Row>) => void | Promise<void>;
	} = { provided: { date: DateInput } }
) {
	const onCellEdit = vi.fn(options.onCellEdit);
	const view = render(CellEditorsHarness<Row>, {
		provided: options.provided,
		cellEditors: options.cellEditors,
		rows,
		columns,
		getRowId: (row: Row) => row.id,
		onCellEdit
	});
	const grid = screen.getByRole('grid');
	const cell = (row = 0, field = 'due') =>
		view.container.querySelector<HTMLElement>(
			`[data-cell-row="${row}"][data-cell-field="${field}"]`
		)!;
	const outside = screen.getByRole('button', { name: 'Outside' });
	return { ...view, grid, cell, outside, onCellEdit };
}

async function startEditing(cell: HTMLElement) {
	await fireEvent.doubleClick(cell);
	const input = screen.getByRole('textbox', { name: 'Due' }) as HTMLInputElement;
	expect(document.activeElement).toBe(input);
	return input;
}

const calendar = () => document.querySelector<HTMLElement>('[role="dialog"]');
const day = (date: string) => document.querySelector<HTMLElement>(`[data-date="${date}"]`)!;

async function openFromKeyboard(input: HTMLInputElement) {
	await fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
	flushSync();
	expect(calendar()).not.toBeNull();
}

describe('injection and the native fallback (D1-a / D3-a)', () => {
	it('without an injected editor a date cell keeps the native input', async () => {
		const { cell } = setup({});
		await fireEvent.doubleClick(cell());
		expect(cell().querySelector('input')?.type).toBe('date');
	});

	it('the provided editor gets the draft, the label and the column’s range', async () => {
		const { cell } = setup({ provided: { date: StubDateEditor } });
		await fireEvent.doubleClick(cell());
		const stub = screen.getByTestId('stub-date') as HTMLInputElement;
		expect(document.activeElement).toBe(stub);
		expect(stub.value).toBe('2026-11-07');
		expect(stub.getAttribute('aria-label')).toBe('Due');
		expect(stub.dataset.min).toBe('2026-11-02');
		expect(stub.dataset.max).toBe('2026-11-27');
	});

	it('the cellEditors prop wins over the context', async () => {
		const { cell } = setup({
			provided: { date: StubDateEditor },
			cellEditors: { date: DateInput }
		});
		await fireEvent.doubleClick(cell());
		expect(screen.queryByTestId('stub-date')).toBeNull();
		expect(cell().querySelector('[aria-haspopup="dialog"]')).not.toBeNull();
	});

	it('only date cells use it', async () => {
		const { cell } = setup({ provided: { date: StubDateEditor } });
		await fireEvent.doubleClick(cell(0, 'name'));
		expect(screen.queryByTestId('stub-date')).toBeNull();
		expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy();
	});
});

describe('pasting into a date column (§5.10)', () => {
	it('normalises, takes blank as null, skips an impossible, year-less or out-of-range day', async () => {
		const onRangePaste = vi.fn();
		const view = render(CellEditorsHarness<Row>, {
			rows: [
				...rows,
				{ id: 3, due: null, name: 'Gamma' },
				{ id: 4, due: null, name: 'Delta' },
				{ id: 5, due: null, name: 'Epsilon' }
			],
			columns,
			getRowId: (row: Row) => row.id,
			onRangePaste
		});
		const grid = screen.getByRole('grid');
		await fireEvent.pointerDown(
			view.container.querySelector('[data-cell-row="0"][data-cell-field="due"]')!,
			{ button: 0 }
		);
		await fireEvent.paste(grid, {
			clipboardData: { getData: () => '2026/11/10\n\n11/12\n2026-02-30\n2026-12-01' }
		});
		expect(onRangePaste).toHaveBeenCalledTimes(1);
		const [edits, info] = onRangePaste.mock.calls[0];
		expect(edits.map((edit: CellEdit<Row>) => [edit.rowId, edit.value])).toEqual([
			[1, '2026-11-10']
		]);
		// Line 2 (blank -> null) lands on a null: a no-op, not skipped. Lines 3
		// (year-less) and 4 (no such day) fail to parse; line 5 is after `max`.
		expect(info.skipped).toBe(3);
	});
});

describe('the day-range filter of a date column (§5.9, PR-6)', () => {
	it('uses the provided dateRange, else two native date inputs', async () => {
		setup({
			provided: { dateRange: DateRangeInput as unknown as Component<FilterDateRangeInputProps> }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Dueの絞り込み' }));
		const group = screen.getByRole('group', { name: '期間' });
		expect(group.classList.contains('date-range-input')).toBe(true);
		cleanup();
		setup({});
		await fireEvent.click(screen.getByRole('button', { name: 'Dueの絞り込み' }));
		const native = screen.getByRole('group', { name: '期間' });
		expect([...native.querySelectorAll('input')].map((input) => input.type)).toEqual([
			'date',
			'date'
		]);
	});

	it('a paste into the filter popover stays there with a cell selected', async () => {
		const onRangePaste = vi.fn();
		const view = render(CellEditorsHarness<Row>, {
			provided: { dateRange: DateRangeInput as unknown as Component<FilterDateRangeInputProps> },
			rows,
			columns,
			getRowId: (row: Row) => row.id,
			onRangePaste
		});
		await fireEvent.pointerDown(
			view.container.querySelector('[data-cell-row="0"][data-cell-field="due"]')!,
			{ button: 0 }
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Dueの絞り込み' }));
		const start = screen.getByRole('textbox', { name: '開始日' });
		await fireEvent.paste(start, { clipboardData: { getData: () => '2026-11-10' } });
		expect(onRangePaste).not.toHaveBeenCalled();
	});
});

describe('the grid’s edit state machine with @banto/ui DateInput (§5.8)', () => {
	it('Esc 1 closes the calendar, Esc 2 cancels the edit', async () => {
		const { cell, grid, onCellEdit } = setup();
		const input = await startEditing(cell());
		await openFromKeyboard(input);
		// Focus is on a day: the key stays in the popover (promise 1).
		await fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
		flushSync();
		expect(calendar()).toBeNull();
		expect(document.activeElement).toBe(input);
		expect(cell().classList.contains('editing')).toBe(true);
		await fireEvent.keyDown(input, { key: 'Escape' });
		expect(cell().classList.contains('editing')).toBe(false);
		expect(document.activeElement).toBe(grid);
		expect(onCellEdit).not.toHaveBeenCalled();
	});

	it('Enter on a day only drafts it (D11); the next Enter commits and moves down', async () => {
		const { cell, grid, onCellEdit } = setup();
		const input = await startEditing(cell());
		await openFromKeyboard(input);
		await fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		await fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		flushSync();
		expect(calendar()).toBeNull();
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe('2026-11-08');
		expect(onCellEdit).not.toHaveBeenCalled();
		await fireEvent.keyDown(input, { key: 'Enter' });
		await tick();
		expect(onCellEdit).toHaveBeenCalledTimes(1);
		expect(onCellEdit.mock.calls[0][0]).toMatchObject({
			field: 'due',
			value: '2026-11-08',
			oldValue: '2026-11-07'
		});
		expect(cell().classList.contains('editing')).toBe(false);
		expect(document.activeElement).toBe(grid);
		expect(cell(1).classList.contains('active')).toBe(true);
	});

	it('pressing the button and a day with the mouse neither commits nor unmounts the editor', async () => {
		const { cell, grid, onCellEdit } = setup();
		const input = await startEditing(cell());
		const button = cell().querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
		await fireEvent.pointerDown(button, { button: 0 });
		await fireEvent.mouseDown(button);
		await fireEvent.click(button);
		flushSync();
		expect(calendar()).not.toBeNull();
		expect(cell().classList.contains('editing')).toBe(true);
		expect(document.activeElement).not.toBe(grid);
		const target = day('2026-11-20');
		await fireEvent.pointerDown(target, { button: 0 });
		await fireEvent.mouseDown(target);
		await fireEvent.click(target);
		// A double click in the calendar must not restart the edit either.
		await fireEvent.dblClick(input);
		flushSync();
		expect(calendar()).toBeNull();
		expect(cell().classList.contains('editing')).toBe(true);
		expect(input.isConnected).toBe(true);
		expect(input.value).toBe('2026-11-20');
		expect(document.activeElement).toBe(input);
		expect(onCellEdit).not.toHaveBeenCalled();
		// The session still owns focus: Enter commits and moves on to the grid.
		await fireEvent.keyDown(input, { key: 'Enter' });
		await tick();
		expect(onCellEdit.mock.calls[0][0]).toMatchObject({ value: '2026-11-20' });
		expect(document.activeElement).toBe(grid);
	});

	it('pressing another cell with the calendar open commits; a failure does not pull focus back', async () => {
		const { cell, grid, onCellEdit } = setup();
		const input = await startEditing(cell());
		await fireEvent.input(input, { target: { value: '2026-11-28' } });
		await openFromKeyboard(input);
		await fireEvent.pointerDown(cell(1, 'name'), { button: 0 });
		await tick();
		await tick();
		expect(calendar()).toBeNull();
		expect(onCellEdit).not.toHaveBeenCalled();
		expect(input.getAttribute('aria-invalid')).toBe('true');
		expect(document.activeElement).toBe(grid);
		expect(cell(1, 'name').classList.contains('active')).toBe(true);
	});

	it('pressing plain page outside with the calendar open: a failed commit does not reclaim focus', async () => {
		// #212's rule ("never reclaim abandoned focus") with the calendar's light
		// dismiss parking focus on the text box during the same press.
		const { cell, onCellEdit } = setup();
		const input = await startEditing(cell());
		await fireEvent.input(input, { target: { value: '2026-11-28' } });
		await openFromKeyboard(input);
		const blank = document.createElement('p');
		document.body.append(blank);
		await fireEvent.pointerDown(blank, { button: 0 });
		expect(document.activeElement).toBe(input);
		// The press's default action: focus leaves for <body>.
		input.blur();
		await tick();
		await tick();
		expect(onCellEdit).not.toHaveBeenCalled();
		expect(input.getAttribute('aria-invalid')).toBe('true');
		expect(document.activeElement).toBe(document.body);
		blank.remove();
	});

	it('a day outside the column’s range cannot be picked', async () => {
		const { cell } = setup();
		const input = await startEditing(cell());
		await openFromKeyboard(input);
		expect(day('2026-11-01').getAttribute('aria-disabled')).toBe('true');
		expect(day('2026-11-02').getAttribute('aria-disabled')).toBeNull();
	});

	it('typed lenient text commits canonical on Enter; blur commits too', async () => {
		const { cell, outside, onCellEdit } = setup();
		let input = await startEditing(cell());
		await fireEvent.input(input, { target: { value: '2026/11/9' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		await tick();
		expect(onCellEdit.mock.calls[0][0]).toMatchObject({ value: '2026-11-09' });
		input = await startEditing(cell(1));
		await fireEvent.input(input, { target: { value: '２０２６／１１／２７' } });
		outside.focus();
		await tick();
		expect(onCellEdit.mock.calls[1][0]).toMatchObject({ value: '2026-11-27', oldValue: null });
	});

	it('Tab commits a typed year-less day as this year’s', async () => {
		const { cell, onCellEdit } = setup({
			provided: { date: DateInput },
			onCellEdit: () => {}
		});
		const input = await startEditing(cell(1));
		await fireEvent.input(input, { target: { value: '11/10' } });
		await fireEvent.keyDown(input, { key: 'Tab' });
		await tick();
		const year = new Date().getFullYear();
		// Out of the 2026 range in other years: then it is the validator's error.
		if (year === 2026) expect(onCellEdit.mock.calls[0][0]).toMatchObject({ value: '2026-11-10' });
		else expect(input.getAttribute('aria-invalid')).toBe('true');
	});

	it('an impossible day or one out of range is an error; clearing commits null', async () => {
		const { cell, onCellEdit } = setup();
		const input = await startEditing(cell());
		await fireEvent.input(input, { target: { value: '2026-02-30' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		await tick();
		expect(onCellEdit).not.toHaveBeenCalled();
		expect(input.getAttribute('aria-invalid')).toBe('true');
		await fireEvent.input(input, { target: { value: '2026-11-28' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		await tick();
		expect(onCellEdit).not.toHaveBeenCalled();
		const errorId = input.getAttribute('aria-describedby')!.split(' ').pop()!;
		expect(document.getElementById(errorId)?.textContent).toContain(
			'2026-11-27以前の日付を入力してください'
		);
		await fireEvent.input(input, { target: { value: '' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		await tick();
		expect(onCellEdit.mock.calls[0][0]).toMatchObject({ value: null, oldValue: '2026-11-07' });
	});
});
