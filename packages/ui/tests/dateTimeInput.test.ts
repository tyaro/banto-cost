// @vitest-environment jsdom
/**
 * DateTimeInput (docs/design/date-time-pickers.md §5.2-§5.6 / §5.8, D5-a,
 * PR-5): one text box showing `YYYY-MM-DD HH:mm` for the value
 * `YYYY-MM-DDTHH:mm`, typed text parsed on blur / Enter, one dialog with the
 * calendar and a time list (a day marks the date and moves to the list, a
 * time sets the value and closes), `min` / `max` across the two, `step`, and
 * the promises to a host with its own key / blur handling (§5.8).
 *
 * The calendar's own keys are `MonthCalendar`'s, covered through DateInput
 * (dateInput.test.ts). jsdom has no Popover API: the stand-in from
 * menu.test.ts is installed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DateTimeInputHarness from './fixtures/DateTimeInputHarness.svelte';

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
	render(DateTimeInputHarness, {
		onValueChange,
		onTextInput,
		onkeydown,
		onblur,
		onHostKeydown,
		onHostPointerdown,
		...props
	});
	const input = screen.getByRole('textbox', { name: 'Starts at' }) as HTMLInputElement;
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

const dialog = () => screen.queryByRole('dialog', { name: '日時の選択' });
const isOpen = () => dialog()?.dataset.popoverOpen === 'true';
const cell = (date: string) => document.querySelector<HTMLElement>(`[data-date="${date}"]`)!;
const list = () => screen.getByRole('listbox', { name: '時刻の一覧' });
const option = (time: string) => document.querySelector<HTMLElement>(`[data-time="${time}"]`)!;
const activeTime = () => {
	const id = list().getAttribute('aria-activedescendant');
	return id ? document.getElementById(id)?.dataset.time : undefined;
};
const focusedDate = () => (document.activeElement as HTMLElement | null)?.dataset.date;

/** Move focus outside the way a click does: pointerdown first (closes the dialog), then focus. */
function clickOutside() {
	const outside = screen.getByRole('button', { name: 'Outside' });
	fireEvent.pointerDown(outside);
	outside.focus();
	flushSync();
}

describe('DateTimeInput text box', () => {
	it('shows the value with a space, names the button by it, describes the box', () => {
		const { input, button } = setup({ value: '2026-11-07T09:30' });
		expect(input.value).toBe('2026-11-07 09:30');
		expect(button.getAttribute('aria-label')).toBe('日時を変更、2026年11月7日土曜日 09:30');
		expect(button.getAttribute('aria-haspopup')).toBe('dialog');
		const hintId = input.getAttribute('aria-describedby')!;
		expect(document.getElementById(hintId)?.textContent).toBe(
			'YYYY-MM-DD HH:mm の形で入力（例: 2026-11-07 09:30）'
		);
	});

	it('without a value the button says "choose a date and time"', () => {
		const { button } = setup();
		expect(button.getAttribute('aria-label')).toBe('日時を選択');
	});

	it('typed text is parsed on blur: the value keeps the T, the box shows a space', () => {
		const { input, onValueChange, onTextInput, onblur } = setup();
		input.focus();
		fireEvent.input(input, { target: { value: '２０２６/11/7 9:30' } });
		expect(onValueChange).not.toHaveBeenCalled();
		clickOutside();
		expect(onValueChange).toHaveBeenCalledWith('2026-11-07T09:30');
		expect(input.value).toBe('2026-11-07 09:30');
		expect(onTextInput).toHaveBeenLastCalledWith('2026-11-07 09:30');
		expect(onblur).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('value').textContent).toBe('2026-11-07T09:30');
	});

	it('the canonical form with a T is accepted and shown with a space', () => {
		const { input, onValueChange } = setup();
		fireEvent.input(input, { target: { value: '2026-11-07T23:59' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onValueChange).toHaveBeenCalledWith('2026-11-07T23:59');
		expect(input.value).toBe('2026-11-07 23:59');
	});

	it('Enter commits and still reaches onkeydown untouched', () => {
		const { input, onValueChange, onkeydown } = setup();
		fireEvent.input(input, { target: { value: '20261107 0000' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onValueChange).toHaveBeenCalledWith('2026-11-07T00:00');
		const event = onkeydown.mock.calls[0][0] as KeyboardEvent;
		expect(event.key).toBe('Enter');
		expect(event.defaultPrevented).toBe(false);
	});

	it('text that does not parse (a date alone, seconds) stays and the value does not change', () => {
		const { input, onValueChange } = setup({ value: '2026-11-07T09:30' });
		for (const bad of ['2026-11-07', '2026-11-07 09:30:00', '2026-11-07 24:00']) {
			fireEvent.input(input, { target: { value: bad } });
			fireEvent.keyDown(input, { key: 'Enter' });
			expect(input.value).toBe(bad);
		}
		expect(onValueChange).not.toHaveBeenCalled();
	});

	it('clearing the text gives null (D6)', () => {
		const { input, onValueChange } = setup({ value: '2026-11-07T09:30' });
		fireEvent.input(input, { target: { value: '  ' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onValueChange).toHaveBeenCalledWith(null);
		expect(input.value).toBe('');
	});

	it('a parent-owned text is shown as given', () => {
		const { input } = setup({ value: '2026-11-07T09:30', text: '2026/11/7 9' });
		expect(input.value).toBe('2026/11/7 9');
	});

	it('Alt+ArrowDown opens the dialog and arrives defaultPrevented', () => {
		const { input, onkeydown } = setup();
		fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
		expect(isOpen()).toBe(true);
		expect((onkeydown.mock.calls[0][0] as KeyboardEvent).defaultPrevented).toBe(true);
	});

	it('disabled / readonly cannot open the dialog', () => {
		for (const props of [{ disabled: true }, { readonly: true }]) {
			const { input, button } = setup(props);
			fireEvent.click(button);
			fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
			expect(dialog()).toBeNull();
			cleanup();
		}
	});
});

describe('DateTimeInput dialog', () => {
	it('opens on the value: the day focused and marked, its time active in the list', () => {
		const { button } = setup({ value: '2026-11-07T09:30' });
		fireEvent.click(button);
		expect(isOpen()).toBe(true);
		expect(dialog()!.getAttribute('aria-modal')).toBe('true');
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(focusedDate()).toBe('2026-11-07');
		expect(cell('2026-11-07').getAttribute('aria-selected')).toBe('true');
		expect(list().getAttribute('tabindex')).toBe('0');
		expect(activeTime()).toBe('09:30');
		expect(option('09:30').getAttribute('aria-selected')).toBe('true');
	});

	it('a value off the list step points at the nearest time', () => {
		const { button } = setup({ value: '2026-11-07T09:40' });
		fireEvent.click(button);
		expect(activeTime()).toBe('09:30');
	});

	it('opens on the typed (uncommitted) date and time when it parses', () => {
		const { input, button, onValueChange } = setup({ value: '2026-11-07T09:30' });
		fireEvent.input(input, { target: { value: '2026/12/24 18:00' } });
		fireEvent.click(button);
		expect(focusedDate()).toBe('2026-12-24');
		expect(activeTime()).toBe('18:00');
		expect(onValueChange).not.toHaveBeenCalled();
	});

	it('Enter on a day marks it and moves focus to the list; Enter there sets the value and closes', () => {
		const { input, button, onValueChange } = setup({ value: '2026-11-07T09:30' });
		fireEvent.click(button);
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		expect(focusedDate()).toBe('2026-11-08');
		fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		expect(isOpen()).toBe(true);
		expect(onValueChange).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(list());
		expect(cell('2026-11-08').getAttribute('aria-selected')).toBe('true');
		expect(activeTime()).toBe('09:30');
		fireEvent.keyDown(list(), { key: 'ArrowDown' });
		expect(activeTime()).toBe('10:00');
		fireEvent.keyDown(list(), { key: 'Enter' });
		expect(onValueChange).toHaveBeenCalledWith('2026-11-08T10:00');
		expect(input.value).toBe('2026-11-08 10:00');
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(input);
	});

	it('the list keys: ↑ / ↓ stop at the ends, Home / End, Space picks', () => {
		const { button, onValueChange } = setup({ value: '2026-11-07T00:00' });
		fireEvent.click(button);
		fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		fireEvent.keyDown(list(), { key: 'ArrowUp' });
		expect(activeTime()).toBe('00:00');
		fireEvent.keyDown(list(), { key: 'End' });
		expect(activeTime()).toBe('23:30');
		fireEvent.keyDown(list(), { key: 'ArrowDown' });
		expect(activeTime()).toBe('23:30');
		fireEvent.keyDown(list(), { key: 'Home' });
		expect(activeTime()).toBe('00:00');
		fireEvent.keyDown(list(), { key: ' ' });
		expect(onValueChange).not.toHaveBeenCalled(); // the same value: no change reported
		expect(dialog()).toBeNull();
	});

	it('a click on a day and then on a time sets the value', () => {
		const { input, button, onValueChange } = setup({ value: '2026-11-07T09:30' });
		fireEvent.click(button);
		fireEvent.click(cell('2026-11-20'));
		expect(document.activeElement).toBe(list());
		fireEvent.pointerMove(option('14:30'));
		expect(activeTime()).toBe('14:30');
		fireEvent.click(option('14:30'));
		expect(onValueChange).toHaveBeenCalledWith('2026-11-20T14:30');
		expect(input.value).toBe('2026-11-20 14:30');
		expect(document.activeElement).toBe(input);
	});

	it('without a value the list points at the time nearest to now (not picked) and the tracked day is used', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 1, 14, 10, 10));
		const { button, onValueChange } = setup();
		fireEvent.click(button);
		expect(focusedDate()).toBe('2026-02-14');
		expect(activeTime()).toBe('10:00');
		expect(onValueChange).not.toHaveBeenCalled();
		list().focus();
		flushSync();
		expect(activeTime()).toBe('10:00');
		fireEvent.keyDown(list(), { key: 'Enter' });
		expect(onValueChange).toHaveBeenCalledWith('2026-02-14T10:00');
	});

	it('Today marks today and moves to the list; Clear empties the value', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 10, 7, 9, 0));
		const { input, button, onValueChange } = setup({ value: '2026-10-01T08:00' });
		fireEvent.click(button);
		fireEvent.click(screen.getByRole('button', { name: '今日' }));
		expect(onValueChange).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(list());
		expect(cell('2026-11-07').getAttribute('aria-selected')).toBe('true');
		fireEvent.keyDown(list(), { key: 'Enter' });
		expect(onValueChange).toHaveBeenLastCalledWith('2026-11-07T08:00');
		fireEvent.click(button);
		fireEvent.click(screen.getByRole('button', { name: 'クリア' }));
		expect(onValueChange).toHaveBeenLastCalledWith(null);
		expect(input.value).toBe('');
		expect(document.activeElement).toBe(input);
	});

	it('Esc closes, keeps the value, returns focus to the text box; the host never sees it', () => {
		const { input, button, onValueChange, onHostKeydown, onkeydown } = setup({
			value: '2026-11-07T09:30'
		});
		fireEvent.click(button);
		fireEvent.keyDown(document.activeElement!, { key: 'Enter' }); // into the list
		fireEvent.keyDown(list(), { key: 'ArrowDown' });
		fireEvent.keyDown(list(), { key: 'Escape' });
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(input);
		expect(onValueChange).not.toHaveBeenCalled();
		expect(onHostKeydown).not.toHaveBeenCalled();
		// The next Esc is the host's (a grid cancels the edit, §5.8).
		fireEvent.keyDown(input, { key: 'Escape' });
		const event = onkeydown.mock.calls.at(-1)![0] as KeyboardEvent;
		expect(event.key).toBe('Escape');
		expect(event.defaultPrevented).toBe(false);
	});

	it('Esc in the text box while open closes and arrives defaultPrevented (§5.8 promise 2)', () => {
		const { input, button, onkeydown } = setup({ value: '2026-11-07T09:30' });
		fireEvent.click(button);
		input.focus();
		fireEvent.keyDown(input, { key: 'Escape' });
		expect(dialog()).toBeNull();
		expect((onkeydown.mock.calls.at(-1)![0] as KeyboardEvent).defaultPrevented).toBe(true);
	});

	it('pointerdown inside does not reach the host; one outside closes it, then onblur once', () => {
		const { button, onHostPointerdown, onblur, onValueChange } = setup({
			value: '2026-11-07T09:30'
		});
		fireEvent.click(button);
		fireEvent.pointerDown(cell('2026-11-10'));
		fireEvent.pointerDown(option('10:00'));
		fireEvent.pointerDown(button);
		expect(onHostPointerdown).not.toHaveBeenCalled();
		expect(isOpen()).toBe(true);
		expect(onblur).not.toHaveBeenCalled();
		clickOutside();
		expect(dialog()).toBeNull();
		expect(onblur).toHaveBeenCalledTimes(1);
		expect(onValueChange).not.toHaveBeenCalled();
	});

	it('moving focus inside (calendar -> list -> footer) is not a blur', () => {
		const { button, onblur } = setup({ value: '2026-11-07T09:30' });
		fireEvent.click(button);
		list().focus();
		screen.getByRole('button', { name: 'クリア' }).focus();
		flushSync();
		expect(onblur).not.toHaveBeenCalled();
		expect(isOpen()).toBe(true);
	});
});

describe('DateTimeInput min / max / step / isDateDisabled (§5.6)', () => {
	const bounds = { min: '2026-11-02T09:00', max: '2026-11-27T18:00' };

	it('days outside the dates of [min, max] are aria-disabled; focus is clamped into range', () => {
		const { button } = setup({ ...bounds, value: '2026-12-24T12:00' });
		fireEvent.click(button);
		expect(focusedDate()).toBe('2026-11-27');
		expect(cell('2026-11-01').getAttribute('aria-disabled')).toBe('true');
		expect(cell('2026-11-02').hasAttribute('aria-disabled')).toBe(false);
		expect(cell('2026-11-28').getAttribute('aria-disabled')).toBe('true');
	});

	it('on the min / max day the times past the bound are refused; in between none are', () => {
		const { button, onValueChange } = setup({ ...bounds, value: '2026-11-10T12:00' });
		fireEvent.click(button);
		expect(option('08:30').hasAttribute('aria-disabled')).toBe(false);
		fireEvent.click(cell('2026-11-02'));
		expect(option('08:30').getAttribute('aria-disabled')).toBe('true');
		expect(option('09:00').hasAttribute('aria-disabled')).toBe(false);
		expect(option('18:00').hasAttribute('aria-disabled')).toBe(false);
		fireEvent.click(option('08:30'));
		expect(onValueChange).not.toHaveBeenCalled();
		expect(isOpen()).toBe(true);
		fireEvent.keyDown(list(), { key: 'Home' });
		expect(activeTime()).toBe('09:00');
		fireEvent.click(cell('2026-11-27'));
		expect(option('18:00').hasAttribute('aria-disabled')).toBe(false);
		expect(option('18:30').getAttribute('aria-disabled')).toBe('true');
		fireEvent.keyDown(list(), { key: 'End' });
		expect(activeTime()).toBe('18:00');
		fireEvent.keyDown(list(), { key: 'Enter' });
		expect(onValueChange).toHaveBeenCalledWith('2026-11-27T18:00');
	});

	it('marking a day that refuses the active time moves it to the nearest allowed one', () => {
		const { button } = setup({ ...bounds, value: '2026-11-10T07:00' });
		fireEvent.click(button);
		expect(activeTime()).toBe('07:00');
		fireEvent.click(cell('2026-11-02'));
		expect(activeTime()).toBe('09:00');
	});

	it('step sets the list', () => {
		const { button } = setup({ step: 15, value: '2026-11-07T09:15' });
		fireEvent.click(button);
		expect(activeTime()).toBe('09:15');
		expect(option('09:45')).not.toBeNull();
		expect(document.querySelectorAll('[role="option"]')).toHaveLength(96);
	});

	it('isDateDisabled days can be focused but not marked', () => {
		const weekend = (date: string) => ['2026-11-07', '2026-11-08'].includes(date);
		const { button, onValueChange } = setup({ value: '2026-11-06T09:00', isDateDisabled: weekend });
		fireEvent.click(button);
		fireEvent.click(cell('2026-11-07'));
		expect(focusedDate()).toBe('2026-11-07');
		expect(cell('2026-11-07').getAttribute('aria-disabled')).toBe('true');
		expect(cell('2026-11-06').getAttribute('aria-selected')).toBe('true');
		fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		expect(document.activeElement).toBe(cell('2026-11-07'));
		expect(onValueChange).not.toHaveBeenCalled();
	});
});
