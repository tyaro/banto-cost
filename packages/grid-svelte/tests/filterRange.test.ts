// @vitest-environment jsdom
/**
 * FilterPopover's day range for `date` / `datetime` columns
 * (date-time-pickers §5.9, PR-6): the native fallback (two
 * `<input type="date">` in a group) and the real `@banto/ui`
 * `DateRangeInput` injected (a relative import - a test may read another
 * package's source, `src` may not, conventions §4). Apply sends `between`
 * with the day after the end day; a box that is not a date or an end before
 * the start shows an error; both empty clears. With the calendar open, Esc
 * closes only the calendar and the next Esc closes the popover; a press in
 * the calendar does not close the popover. jsdom has no Popover API: the
 * stand-in from the ui tests is installed.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { flushSync, type Component } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DateRangeInput from '../../ui/src/DateRangeInput.svelte';
import type { FilterDateRangeInputProps } from '../src/cellEditors';
import FilterPopover from '../src/FilterPopover.svelte';
import type { FilterState, GridColumn } from '../src/types';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

beforeAll(() => {
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
	updatedAt: string;
}

const dateColumn: GridColumn<Row> = {
	id: 'updatedAt',
	header: '更新日',
	accessor: 'updatedAt',
	filterable: true,
	filterType: 'date'
};

function renderPopover(
	options: {
		current?: FilterState;
		injected?: boolean;
		column?: GridColumn<Row>;
	} = {}
) {
	const handlers = { onApply: vi.fn(), onClear: vi.fn(), onClose: vi.fn() };
	render(FilterPopover<Row>, {
		column: options.column ?? dateColumn,
		current: options.current,
		dateRangeInput: options.injected
			? (DateRangeInput as unknown as Component<FilterDateRangeInputProps>)
			: undefined,
		...handlers
	});
	return handlers;
}

const popover = () => screen.getByRole('dialog', { name: '更新日の絞り込み' });
const range = () => within(popover()).getByRole('group', { name: '期間' });
const start = () => within(range()).getByRole('textbox', { name: '開始日' }) as HTMLInputElement;
const end = () => within(range()).getByRole('textbox', { name: '終了日' }) as HTMLInputElement;
const calendar = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');

async function type(input: HTMLInputElement, text: string) {
	await fireEvent.input(input, { target: { value: text } });
}

async function pressEnter(input: HTMLElement) {
	const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
	await fireEvent(input, enter);
	return enter;
}

describe('the native fallback', () => {
	const nativeStart = () =>
		within(range()).getByLabelText('開始日', { selector: 'input' }) as HTMLInputElement;
	const nativeEnd = () =>
		within(range()).getByLabelText('終了日', { selector: 'input' }) as HTMLInputElement;

	it('shows two date inputs in a named group, no operator', () => {
		renderPopover();
		expect(nativeStart().type).toBe('date');
		expect(nativeEnd().type).toBe('date');
		expect(within(popover()).queryByRole('combobox')).toBeNull();
		expect(document.activeElement).toBe(nativeStart());
	});

	it('applies the day after the end day', async () => {
		const { onApply } = renderPopover();
		nativeStart().value = '2024-02-01';
		nativeEnd().value = '2024-02-29';
		await fireEvent.click(screen.getByRole('button', { name: '適用' }));
		expect(onApply).toHaveBeenCalledExactlyOnceWith({
			field: 'updatedAt',
			op: 'between',
			value: ['2024-02-01', '2024-03-01']
		});
	});

	it('shows the inclusive end of the current filter', () => {
		renderPopover({
			current: { field: 'updatedAt', op: 'between', value: ['2025-12-01', '2026-01-01'] }
		});
		expect(nativeStart().value).toBe('2025-12-01');
		expect(nativeEnd().value).toBe('2025-12-31');
	});

	it('refuses an end before the start, then clears when both are empty', async () => {
		const { onApply, onClear } = renderPopover();
		nativeStart().value = '2026-11-08';
		nativeEnd().value = '2026-11-07';
		await fireEvent.click(screen.getByRole('button', { name: '適用' }));
		expect(onApply).not.toHaveBeenCalled();
		const alert = screen.getByRole('alert');
		expect(alert.textContent).toBe('終了日は開始日と同じ日かそれより後にしてください');
		expect(nativeEnd().getAttribute('aria-describedby')).toBe(alert.id);
		nativeStart().value = '';
		nativeEnd().value = '';
		await fireEvent.input(nativeEnd());
		expect(screen.queryByRole('alert')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: '適用' }));
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onApply).not.toHaveBeenCalled();
	});

	it('refuses a half-typed date (badInput)', async () => {
		const { onApply } = renderPopover();
		Object.defineProperty(nativeStart(), 'validity', { value: { badInput: true } });
		await pressEnter(nativeStart());
		expect(onApply).not.toHaveBeenCalled();
		expect(screen.getByRole('alert').textContent).toBe('日付は YYYY-MM-DD の形で入力してください');
	});

	it('applies one open end on Enter', async () => {
		const { onApply } = renderPopover({ column: { ...dateColumn, filterType: 'datetime' } });
		nativeEnd().value = '2025-12-31';
		const enter = await pressEnter(nativeEnd());
		expect(enter.defaultPrevented).toBe(true);
		expect(onApply).toHaveBeenCalledExactlyOnceWith({
			field: 'updatedAt',
			op: 'between',
			value: [null, '2026-01-01']
		});
	});
});

describe('the injected DateRangeInput', () => {
	it('names both boxes and focuses the start day', () => {
		renderPopover({ injected: true });
		expect(start()).toBeTruthy();
		expect(end()).toBeTruthy();
		expect(document.activeElement).toBe(start());
	});

	it('applies typed text, lenient, with the day after the end day', async () => {
		const { onApply } = renderPopover({ injected: true });
		await type(start(), '2025/12/1');
		await type(end(), '2025-12-31');
		const enter = await pressEnter(end());
		expect(enter.defaultPrevented).toBe(true);
		expect(onApply).toHaveBeenCalledExactlyOnceWith({
			field: 'updatedAt',
			op: 'between',
			value: ['2025-12-01', '2026-01-01']
		});
	});

	it('refuses text that is not a date and marks both boxes', async () => {
		const { onApply } = renderPopover({ injected: true });
		await type(start(), '2026-02-30');
		await fireEvent.click(screen.getByRole('button', { name: '適用' }));
		expect(onApply).not.toHaveBeenCalled();
		const alert = screen.getByRole('alert');
		expect(start().getAttribute('aria-invalid')).toBe('true');
		expect(start().getAttribute('aria-describedby')).toContain(alert.id);
		// Typing again takes the error away.
		await type(start(), '2026-02-28');
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('refuses an end before the start', async () => {
		const { onApply } = renderPopover({ injected: true });
		await type(start(), '2026-11-08');
		await type(end(), '2026-11-07');
		await pressEnter(end());
		expect(onApply).not.toHaveBeenCalled();
		expect(screen.getByRole('alert').textContent).toBe(
			'終了日は開始日と同じ日かそれより後にしてください'
		);
	});

	it('starts from the current filter and clears when both are emptied', async () => {
		const { onApply, onClear } = renderPopover({
			injected: true,
			current: { field: 'updatedAt', op: 'between', value: ['2024-02-29', '2024-03-01'] }
		});
		expect(start().value).toBe('2024-02-29');
		expect(end().value).toBe('2024-02-29');
		await type(start(), '');
		await type(end(), ' ');
		await pressEnter(end());
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onApply).not.toHaveBeenCalled();
	});

	it('picking a day in the calendar is what apply reads', async () => {
		const { onApply, onClose } = renderPopover({
			injected: true,
			current: { field: 'updatedAt', op: 'between', value: ['2026-11-01', '2026-11-08'] }
		});
		await fireEvent.keyDown(end(), { key: 'ArrowDown', altKey: true });
		flushSync();
		const day = document.querySelector<HTMLElement>('[data-date="2026-11-10"]')!;
		// A press in the calendar (top layer, DOM inside the popover) does not
		// close the popover.
		day.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		await fireEvent.click(day);
		flushSync();
		expect(onClose).not.toHaveBeenCalled();
		expect(calendar()).toBeNull();
		expect(document.activeElement).toBe(end());
		await fireEvent.click(screen.getByRole('button', { name: '適用' }));
		expect(onApply).toHaveBeenCalledExactlyOnceWith({
			field: 'updatedAt',
			op: 'between',
			value: ['2026-11-01', '2026-11-11']
		});
	});

	it('Esc 1 closes only the calendar, Esc 2 closes the popover', async () => {
		const { onClose } = renderPopover({ injected: true });
		await fireEvent.keyDown(start(), { key: 'ArrowDown', altKey: true });
		flushSync();
		expect(calendar()).not.toBeNull();
		await fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
		flushSync();
		expect(calendar()).toBeNull();
		expect(document.activeElement).toBe(start());
		expect(onClose).not.toHaveBeenCalled();
		await fireEvent.keyDown(start(), { key: 'Escape' });
		expect(onClose).toHaveBeenCalledExactlyOnceWith('escape');
	});
});
