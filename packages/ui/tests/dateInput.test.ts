// @vitest-environment jsdom
/**
 * DateInput (docs/design/date-time-pickers.md §5.2-§5.6 / §5.8, PR-1): typed
 * text parsed on blur / Enter, the calendar dialog's ARIA and keys (APG Date
 * Picker Dialog), focus on open and back to the text box on close (D10),
 * `min` / `max` / `isDateDisabled`, the `Intl` names, and the promises to a
 * host with its own key / blur handling (§5.8: keys inside the popover and
 * pointerdowns do not propagate, handled keys arrive `defaultPrevented`,
 * `onblur` only when focus leaves the whole component).
 *
 * Placement and the top-layer look are browser behaviour (e2e/visual), not
 * asserted here. jsdom has no Popover API: the stand-in from menu.test.ts
 * (an inline `display: block` so the contents can take focus) is installed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DateInputHarness from './fixtures/DateInputHarness.svelte';
import ModalDateInputHarness from './fixtures/ModalDateInputHarness.svelte';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as PopoverElement;
	proto.showPopover = function (this: HTMLElement) {
		if (this.dataset.popoverOpen === 'true') throw new Error('already open');
		this.dataset.popoverOpen = 'true';
		this.style.display = 'block';
	};
	proto.hidePopover = function (this: HTMLElement) {
		if (this.dataset.popoverOpen !== 'true') return;
		delete this.dataset.popoverOpen;
		this.style.removeProperty('display');
	};
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function setup(props: Record<string, unknown> = {}) {
	const onValueChange = vi.fn();
	const onTextInput = vi.fn();
	const onkeydown = vi.fn();
	const onblur = vi.fn();
	const onHostKeydown = vi.fn();
	const onHostPointerdown = vi.fn();
	render(DateInputHarness, {
		onValueChange,
		onTextInput,
		onkeydown,
		onblur,
		onHostKeydown,
		onHostPointerdown,
		...props
	});
	const input = screen.getByRole('textbox', { name: 'Due date' }) as HTMLInputElement;
	const button = document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
	return {
		input,
		button,
		onValueChange,
		onTextInput,
		onkeydown,
		onblur,
		onHostKeydown,
		onHostPointerdown
	};
}

const dialog = () => screen.queryByRole('dialog', { name: '日付の選択' });
const cell = (date: string) => document.querySelector<HTMLElement>(`[data-date="${date}"]`)!;
const focusedDate = () => (document.activeElement as HTMLElement | null)?.dataset.date;
const isOpen = () => dialog()?.dataset.popoverOpen === 'true';

/** Move focus outside the way a click does: pointerdown first (closes the popover), then focus. */
function clickOutside() {
	const outside = screen.getByRole('button', { name: 'Outside' });
	fireEvent.pointerDown(outside);
	outside.focus();
	flushSync();
}

describe('DateInput text box', () => {
	it('names the button by the value and describes the box with the format hint', () => {
		const { input, button } = setup({ value: '2026-11-07' });
		expect(input.value).toBe('2026-11-07');
		expect(button.getAttribute('aria-label')).toBe('日付を変更、2026年11月7日土曜日');
		expect(button.getAttribute('aria-haspopup')).toBe('dialog');
		expect(button.getAttribute('aria-expanded')).toBe('false');
		const hintId = input.getAttribute('aria-describedby')!;
		expect(document.getElementById(hintId)?.textContent).toBe(
			'YYYY-MM-DD の形で入力（例: 2026-11-07）'
		);
	});

	it('without a value the button says "choose a date"', () => {
		const { button } = setup();
		expect(button.getAttribute('aria-label')).toBe('日付を選択');
	});

	it('typed text is parsed on blur and rewritten to the canonical form', () => {
		const { input, onValueChange, onTextInput, onblur } = setup();
		input.focus();
		fireEvent.input(input, { target: { value: '２０２６/11/7' } });
		expect(onValueChange).not.toHaveBeenCalled(); // not while typing
		clickOutside();
		expect(onValueChange).toHaveBeenCalledWith('2026-11-07');
		expect(input.value).toBe('2026-11-07');
		expect(onTextInput).toHaveBeenLastCalledWith('2026-11-07');
		expect(onblur).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('value').textContent).toBe('2026-11-07');
	});

	it('Enter commits and still reaches onkeydown untouched', () => {
		const { input, onValueChange, onkeydown } = setup();
		fireEvent.input(input, { target: { value: '20261107' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onValueChange).toHaveBeenCalledWith('2026-11-07');
		const event = onkeydown.mock.calls[0][0] as KeyboardEvent;
		expect(event.key).toBe('Enter');
		expect(event.defaultPrevented).toBe(false);
	});

	it('text that does not parse stays and the value does not change', () => {
		const { input, onValueChange } = setup({ value: '2026-11-07' });
		fireEvent.input(input, { target: { value: '11/07/2026' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		flushSync();
		expect(onValueChange).not.toHaveBeenCalled();
		expect(input.value).toBe('11/07/2026');
	});

	it('clearing the text gives null (D6)', () => {
		const { input, onValueChange } = setup({ value: '2026-11-07' });
		fireEvent.input(input, { target: { value: '  ' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		flushSync();
		expect(onValueChange).toHaveBeenCalledWith(null);
		expect(input.value).toBe('');
	});

	it('reads "" as empty and does not report a change for it', () => {
		const { input, onValueChange } = setup({ value: '' });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onValueChange).not.toHaveBeenCalled();
	});

	it('Alt+ArrowDown opens the calendar and arrives defaultPrevented', () => {
		const { input, onkeydown } = setup({ value: '2026-11-07' });
		fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
		expect(isOpen()).toBe(true);
		expect((onkeydown.mock.calls[0][0] as KeyboardEvent).defaultPrevented).toBe(true);
	});

	it('disabled / readonly cannot open the calendar', () => {
		const { button, input } = setup({ value: '2026-11-07', readonly: true });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
		expect(isOpen()).toBe(false);
	});
});

describe('DateInput calendar dialog', () => {
	it('opens on the value with the APG wiring', () => {
		const { button } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		const panel = dialog()!;
		expect(isOpen()).toBe(true);
		expect(panel.getAttribute('aria-modal')).toBe('true');
		expect(button.getAttribute('aria-expanded')).toBe('true');
		const grid = screen.getByRole('grid');
		const heading = document.getElementById(grid.getAttribute('aria-labelledby')!)!;
		expect(heading.textContent?.trim()).toBe('2026年11月');
		expect(heading.getAttribute('aria-live')).toBe('polite');
		expect(focusedDate()).toBe('2026-11-07');
		const selected = cell('2026-11-07');
		expect(selected.getAttribute('aria-selected')).toBe('true');
		expect(selected.getAttribute('tabindex')).toBe('0');
		expect(selected.getAttribute('aria-label')).toBe('2026年11月7日土曜日');
		expect(cell('2026-11-08').getAttribute('tabindex')).toBe('-1');
		// Weekday headers: short name shown, long name in abbr; ja-JP starts on Sunday.
		const headers = screen.getAllByRole('columnheader');
		expect(headers.map((h) => h.textContent)).toEqual(['日', '月', '火', '水', '木', '金', '土']);
		expect(headers[0].getAttribute('abbr')).toBe('日曜日');
	});

	it('opens on today without a value; today is aria-current', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 1, 14, 10, 0));
		const { button } = setup();
		fireEvent.click(button);
		expect(focusedDate()).toBe('2026-02-14');
		expect(cell('2026-02-14').getAttribute('aria-current')).toBe('date');
		expect(cell('2026-02-15').hasAttribute('aria-current')).toBe(false);
	});

	it('opens on the typed (uncommitted) day when it parses', () => {
		const { input, button, onValueChange } = setup({ value: '2026-11-07' });
		fireEvent.input(input, { target: { value: '2026/12/24' } });
		fireEvent.click(button);
		expect(focusedDate()).toBe('2026-12-24');
		expect(onValueChange).not.toHaveBeenCalled();
	});

	it('arrow / Home / End / PageUp / PageDown move the focused day', () => {
		const { button } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		const press = (key: string, init: KeyboardEventInit = {}) =>
			fireEvent.keyDown(document.activeElement!, { key, ...init });
		press('ArrowRight');
		expect(focusedDate()).toBe('2026-11-08');
		press('ArrowLeft');
		press('ArrowLeft');
		expect(focusedDate()).toBe('2026-11-06');
		press('ArrowDown');
		expect(focusedDate()).toBe('2026-11-13');
		press('ArrowUp');
		expect(focusedDate()).toBe('2026-11-06');
		press('Home');
		expect(focusedDate()).toBe('2026-11-01');
		press('End');
		expect(focusedDate()).toBe('2026-11-07');
		press('PageDown');
		expect(focusedDate()).toBe('2026-12-07');
		expect(screen.getByRole('heading').textContent?.trim()).toBe('2026年12月');
		press('PageUp', { shiftKey: true });
		expect(focusedDate()).toBe('2025-12-07');
		press('PageDown', { shiftKey: true });
		press('PageUp');
		expect(focusedDate()).toBe('2026-11-07');
		// Into the neighbouring month: the view follows.
		press('ArrowUp');
		press('ArrowUp');
		expect(focusedDate()).toBe('2026-10-24');
		expect(screen.getByRole('heading').textContent?.trim()).toBe('2026年10月');
	});

	it('Enter picks the focused day, closes and returns focus to the text box (D10)', () => {
		const { input, button, onValueChange, onblur } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		expect(onValueChange).toHaveBeenCalledWith('2026-11-08');
		expect(input.value).toBe('2026-11-08');
		expect(isOpen()).toBe(false);
		expect(document.activeElement).toBe(input);
		expect(onblur).not.toHaveBeenCalled();
	});

	it('Space picks too, and a click on a day picks it', () => {
		const { button, onValueChange } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		fireEvent.keyDown(document.activeElement!, { key: ' ' });
		expect(onValueChange).not.toHaveBeenCalled(); // same day: no change
		expect(isOpen()).toBe(false);
		fireEvent.click(button);
		fireEvent.click(cell('2026-11-20'));
		expect(onValueChange).toHaveBeenCalledWith('2026-11-20');
		expect(isOpen()).toBe(false);
	});

	it('Esc closes, keeps the value, returns focus to the text box; the host never sees it', () => {
		const { input, button, onValueChange, onHostKeydown, onblur } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
		expect(isOpen()).toBe(false);
		expect(document.activeElement).toBe(input);
		expect(onValueChange).not.toHaveBeenCalled();
		expect(onblur).not.toHaveBeenCalled();
		// §5.8 promise 1: no key from inside the popover reached the host.
		expect(onHostKeydown).not.toHaveBeenCalled();
	});

	it('a consumed Esc is left alone', () => {
		const { button } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		event.preventDefault();
		document.activeElement!.dispatchEvent(event);
		expect(isOpen()).toBe(true);
	});

	it('Esc at window level closes it when focus is outside (layering rule 3)', () => {
		const { button } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
		expect(isOpen()).toBe(false);
	});

	it('the button toggles it closed and focus goes back to the text box', () => {
		const { input, button } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		fireEvent.click(button);
		expect(isOpen()).toBe(false);
		expect(document.activeElement).toBe(input);
	});

	it('a pointerdown outside closes it and onblur fires once focus has left', () => {
		const { button, onblur } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		clickOutside();
		expect(isOpen()).toBe(false);
		expect(onblur).toHaveBeenCalledTimes(1);
	});

	it('pointerdown inside the component does not reach the host (§5.8 promise 4)', () => {
		const { input, button, onHostPointerdown } = setup({ value: '2026-11-07' });
		fireEvent.pointerDown(input);
		fireEvent.click(button);
		fireEvent.pointerDown(cell('2026-11-10'));
		expect(onHostPointerdown).not.toHaveBeenCalled();
		expect(isOpen()).toBe(true);
	});

	it('moving focus inside (box -> button -> dialog) is not a blur', () => {
		const { input, button, onblur } = setup({ value: '2026-11-07' });
		input.focus();
		button.focus();
		fireEvent.click(button);
		expect(onblur).not.toHaveBeenCalled();
	});

	it('Today picks today, Clear empties the value', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 10, 7, 9, 0));
		const { input, button, onValueChange } = setup({ value: '2026-10-01' });
		fireEvent.click(button);
		fireEvent.click(screen.getByRole('button', { name: '今日' }));
		expect(onValueChange).toHaveBeenLastCalledWith('2026-11-07');
		fireEvent.click(button);
		fireEvent.click(screen.getByRole('button', { name: 'クリア' }));
		expect(onValueChange).toHaveBeenLastCalledWith(null);
		expect(input.value).toBe('');
		expect(document.activeElement).toBe(input);
	});
});

describe('DateInput in a height-capped panel', () => {
	it('scrolls the panel itself (not the page) to show the focused day', () => {
		const { button } = setup({ value: '2026-11-07' });
		// jsdom has no layout: a panel showing y 100..200 and cells 40px per week
		// row from y 120 (the first row), all following the panel's scrollTop.
		let scrollTop = 0;
		const rowOf = (date: string) =>
			Math.floor(
				[...document.querySelectorAll('[data-date]')].findIndex(
					(el) => (el as HTMLElement).dataset.date === date
				) / 7
			);
		const original = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
			if (this.getAttribute('role') === 'dialog') return new DOMRect(0, 100, 300, 100);
			const date = this.dataset.date;
			if (date) return new DOMRect(10, 120 + rowOf(date) * 40 - scrollTop, 30, 30);
			return original.call(this);
		};
		const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
		const isPanel = (el: HTMLElement) => el.getAttribute('role') === 'dialog';
		Object.defineProperty(proto, 'clientHeight', {
			get(this: HTMLElement) {
				return isPanel(this) ? 100 : 0;
			},
			configurable: true
		});
		Object.defineProperty(proto, 'clientWidth', {
			get(this: HTMLElement) {
				return isPanel(this) ? 300 : 0;
			},
			configurable: true
		});
		Object.defineProperty(proto, 'scrollTop', {
			get(this: HTMLElement) {
				return isPanel(this) ? scrollTop : 0;
			},
			set(this: HTMLElement, v: number) {
				if (isPanel(this)) scrollTop = v;
			},
			configurable: true
		});
		try {
			fireEvent.click(button);
			expect(scrollTop).toBe(0);
			const scrollSpy = vi.spyOn(window, 'scrollTo');
			// 2026-11-07 is row 0 (y 120..150): visible, no scroll.
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
			expect(scrollTop).toBe(0);
			// Two weeks down: row 2 (y 200..230) -> scrolled by 30 to end at 200.
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
			expect(focusedDate()).toBe('2026-11-20');
			expect(scrollTop).toBe(30);
			// Back to row 0 (y 90..120 at scrollTop 30): scrolled up by 10, so it starts at 100.
			fireEvent.keyDown(document.activeElement!, { key: 'Home' });
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
			expect(focusedDate()).toBe('2026-11-01');
			expect(scrollTop).toBe(20);
			expect(scrollSpy).not.toHaveBeenCalled();
		} finally {
			HTMLElement.prototype.getBoundingClientRect = original;
			delete proto.clientHeight;
			delete proto.clientWidth;
			delete proto.scrollTop;
		}
	});
});

describe('DateInput min / max / isDateDisabled (§5.6)', () => {
	it('days outside [min, max] are aria-disabled, focus is clamped into range', () => {
		const { button, onValueChange } = setup({
			value: '2026-11-07',
			min: '2026-11-05',
			max: '2026-11-20'
		});
		fireEvent.click(button);
		expect(cell('2026-11-04').getAttribute('aria-disabled')).toBe('true');
		expect(cell('2026-11-05').hasAttribute('aria-disabled')).toBe(false);
		expect(cell('2026-11-21').getAttribute('aria-disabled')).toBe('true');
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
		expect(focusedDate()).toBe('2026-11-05');
		fireEvent.keyDown(document.activeElement!, { key: 'PageDown' });
		expect(focusedDate()).toBe('2026-11-20');
		fireEvent.click(cell('2026-11-21'));
		expect(onValueChange).not.toHaveBeenCalled();
		expect(isOpen()).toBe(true);
	});

	it('a click on a day outside the range leaves focus on the tracked day (focusDate)', () => {
		const { button, onValueChange } = setup({
			value: '2026-11-07',
			min: '2026-11-05',
			max: '2026-11-20'
		});
		fireEvent.click(button);
		const outside = cell('2026-11-21');
		// What a browser does: mousedown focuses the cell unless prevented.
		const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		outside.dispatchEvent(mousedown);
		expect(mousedown.defaultPrevented).toBe(true);
		fireEvent.click(outside);
		expect(focusedDate()).toBe('2026-11-07');
		// Even when focus got there anyway (touch), the click puts it back.
		outside.focus();
		fireEvent.click(outside);
		expect(focusedDate()).toBe('2026-11-07');
		expect(cell('2026-11-07').getAttribute('tabindex')).toBe('0');
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		expect(onValueChange).toHaveBeenCalledWith('2026-11-08');
	});

	it('month / year buttons cannot leave the range', () => {
		const { button } = setup({ value: '2026-11-07', min: '2026-11-01', max: '2027-01-15' });
		fireEvent.click(button);
		const prevMonth = screen.getByRole('button', { name: '前の月' });
		const nextMonth = screen.getByRole('button', { name: '次の月' });
		const nextYear = screen.getByRole('button', { name: '次の年' });
		expect(prevMonth.getAttribute('aria-disabled')).toBe('true');
		expect(nextMonth.hasAttribute('aria-disabled')).toBe(false);
		// A year ahead is out of range, but clamping lands in a later month: allowed.
		expect(nextYear.hasAttribute('aria-disabled')).toBe(false);
		fireEvent.click(prevMonth);
		expect(screen.getByRole('heading').textContent?.trim()).toBe('2026年11月');
		fireEvent.click(nextYear);
		expect(screen.getByRole('heading').textContent?.trim()).toBe('2027年1月');
		expect(nextMonth.getAttribute('aria-disabled')).toBe('true');
		expect(nextYear.getAttribute('aria-disabled')).toBe('true');
	});

	it('the month buttons move the view and keep focus on the button', () => {
		const { button } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		const nextMonth = screen.getByRole('button', { name: '次の月' });
		nextMonth.focus();
		fireEvent.click(nextMonth);
		expect(screen.getByRole('heading').textContent?.trim()).toBe('2026年12月');
		expect(document.activeElement).toBe(nextMonth);
		expect(cell('2026-12-07').getAttribute('tabindex')).toBe('0');
	});

	it('isDateDisabled days can be focused but not picked', () => {
		const weekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00`).getDay());
		const { button, onValueChange } = setup({ value: '2026-11-06', isDateDisabled: weekend });
		fireEvent.click(button);
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		expect(focusedDate()).toBe('2026-11-07');
		expect(cell('2026-11-07').getAttribute('aria-disabled')).toBe('true');
		fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		expect(onValueChange).not.toHaveBeenCalled();
		expect(isOpen()).toBe(true);
		expect(screen.getByRole('button', { name: '今日' })).toBeTruthy();
	});

	it('opening without a value clamps today into range', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 10, 7, 9, 0));
		const { button } = setup({ min: '2027-03-10' });
		fireEvent.click(button);
		expect(focusedDate()).toBe('2027-03-10');
	});
});

describe('DateInput focus follows the tracked day (clicks, edge months)', () => {
	it('a click on an unpickable day of the next month moves the view and focus there', () => {
		const { button, onValueChange } = setup({
			value: '2026-11-07',
			isDateDisabled: (date: string) => date === '2026-12-05'
		});
		fireEvent.click(button);
		fireEvent.click(cell('2026-12-05'));
		expect(onValueChange).not.toHaveBeenCalled();
		expect(isOpen()).toBe(true);
		expect(screen.getByRole('heading').textContent?.trim()).toBe('2026年12月');
		// The browser focus is on the 12/5 cell, the same day focusDate tracks.
		expect(focusedDate()).toBe('2026-12-05');
		expect(cell('2026-12-05').getAttribute('tabindex')).toBe('0');
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		expect(focusedDate()).toBe('2026-12-06');
	});

	it('a click on a pickable day of the next month picks it and returns to the box', () => {
		const { input, button, onValueChange } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		fireEvent.click(cell('2026-12-01'));
		expect(onValueChange).toHaveBeenCalledWith('2026-12-01');
		expect(isOpen()).toBe(false);
		expect(document.activeElement).toBe(input);
	});

	it('9999-12: one 12/31, empty slots after it that cannot take focus', () => {
		const { button } = setup({ value: '9999-12-31' });
		fireEvent.click(button);
		expect(document.querySelectorAll('[data-date="9999-12-31"]')).toHaveLength(1);
		expect(document.querySelectorAll('td[tabindex="0"]')).toHaveLength(1);
		const empty = document.querySelectorAll<HTMLElement>('td.date-picker-day--empty');
		expect(empty.length).toBeGreaterThan(0);
		expect(empty[0].hasAttribute('tabindex')).toBe(false);
		expect(empty[0].hasAttribute('aria-selected')).toBe(false);
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		fireEvent.keyDown(document.activeElement!, { key: 'PageDown' });
		fireEvent.keyDown(document.activeElement!, { key: 'End' });
		expect(focusedDate()).toBe('9999-12-31');
		const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		empty[0].dispatchEvent(mousedown);
		expect(mousedown.defaultPrevented).toBe(true);
		fireEvent.click(empty[0]);
		expect(focusedDate()).toBe('9999-12-31');
		expect(screen.getByRole('button', { name: '次の月' }).getAttribute('aria-disabled')).toBe(
			'true'
		);
		expect(screen.getByRole('button', { name: '次の年' }).getAttribute('aria-disabled')).toBe(
			'true'
		);
	});

	it('0001-01: the 1st sits under its weekday (Monday) after an empty slot', () => {
		const { button } = setup({ value: '0001-01-01' });
		fireEvent.click(button);
		const firstRow = document.querySelector('tbody tr')!.querySelectorAll('td');
		expect(firstRow[0].classList.contains('date-picker-day--empty')).toBe(true);
		expect(firstRow[1].dataset.date).toBe('0001-01-01');
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
		fireEvent.keyDown(document.activeElement!, { key: 'Home' });
		fireEvent.keyDown(document.activeElement!, { key: 'PageUp', shiftKey: true });
		expect(focusedDate()).toBe('0001-01-01');
		expect(screen.getByRole('button', { name: '前の月' }).getAttribute('aria-disabled')).toBe(
			'true'
		);
	});

	it('a press on the heading or a weekday header does not take focus off the tracked day', () => {
		const { button } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		for (const target of [screen.getByRole('heading'), screen.getAllByRole('columnheader')[0]]) {
			const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
			target.dispatchEvent(mousedown);
			expect(mousedown.defaultPrevented).toBe(true);
		}
		const onDay = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		cell('2026-11-10').dispatchEvent(onDay);
		expect(onDay.defaultPrevented).toBe(false);
		expect(focusedDate()).toBe('2026-11-07');
	});

	it('moving the view across months keeps focus inside the component (no blur)', () => {
		const { button, onblur } = setup({ value: '9999-11-30' });
		fireEvent.click(button);
		fireEvent.keyDown(document.activeElement!, { key: 'PageDown' });
		fireEvent.keyDown(document.activeElement!, { key: 'PageUp' });
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
		expect(focusedDate()).toBe('9999-12-07');
		expect(onblur).not.toHaveBeenCalled();
	});
});

describe('DateInput locale and messages (§5.5)', () => {
	it('uses Intl for the names and weekStartsOn for the first column', () => {
		const { button } = setup({ value: '2026-11-07', locale: 'en-US', weekStartsOn: 1 });
		expect(button.getAttribute('aria-label')).toBe('日付を変更、Saturday, November 7, 2026');
		fireEvent.click(button);
		expect(screen.getByRole('heading').textContent?.trim()).toBe('November 2026');
		const headers = screen.getAllByRole('columnheader');
		expect(headers[0].textContent).toBe('Mon');
		expect(headers[0].getAttribute('abbr')).toBe('Monday');
		expect(cell('2026-10-26')).toBeTruthy(); // the grid starts on Monday 26 Oct
	});

	it('messages override the default text', () => {
		const { button } = setup({
			messages: {
				datePickerOpen: () => 'Choose date',
				datePickerDialog: () => 'Calendar'
			}
		});
		expect(button.getAttribute('aria-label')).toBe('Choose date');
		fireEvent.click(button);
		expect(screen.getByRole('dialog', { name: 'Calendar' })).toBeTruthy();
	});
});

describe('DateInput inside a Modal (§8, PR-3: a form in a dialog)', () => {
	it('Esc closes only the calendar first; the second Esc closes the Modal', () => {
		const onclose = vi.fn();
		render(ModalDateInputHarness, { onclose });
		flushSync();
		const modal = screen.getByRole('dialog', { name: 'Edit' });
		const input = screen.getByRole('textbox', { name: 'Due date' });
		fireEvent.click(modal.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!);
		flushSync();
		expect(isOpen()).toBe(true);
		expect(modal.contains(document.activeElement)).toBe(true);

		fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
		flushSync();
		expect(isOpen()).toBe(false);
		expect(document.activeElement).toBe(input);
		expect(onclose).not.toHaveBeenCalled();

		fireEvent.keyDown(input, { key: 'Escape' });
		flushSync();
		expect(onclose).toHaveBeenCalledTimes(1);
	});
});
