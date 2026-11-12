// @vitest-environment jsdom
/**
 * TimeInput (docs/design/date-time-pickers.md §5.2-§5.6 / §5.8, PR-2): typed
 * text parsed on blur / Enter, the combobox + listbox wiring (APG: focus stays
 * on the text box, `aria-activedescendant` names the active option, which is
 * also the one highlighted), the step list (D8) and `min` / `max`, clicks and
 * pointer moves that never part the active option from the highlight or move
 * focus, scrolling the list itself (not the page) to show the active option,
 * and the promises to a host with its own key / blur handling (§5.8).
 *
 * jsdom has no Popover API: the stand-in from menu.test.ts is installed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import TimeInputHarness from './fixtures/TimeInputHarness.svelte';

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
	render(TimeInputHarness, {
		onValueChange,
		onTextInput,
		onkeydown,
		onblur,
		onHostKeydown,
		onHostPointerdown,
		...props
	});
	const input = screen.getByRole('combobox', { name: 'Start time' }) as HTMLInputElement;
	const button = screen.getByRole('button', { name: '時刻を選択' }) as HTMLButtonElement;
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

function setupWithRerender(props: Record<string, unknown>) {
	const { rerender } = render(TimeInputHarness, props);
	const input = screen.getByRole('combobox', { name: 'Start time' }) as HTMLInputElement;
	return { input, rerender };
}

const listbox = () => screen.queryByRole('listbox', { name: '時刻の一覧' });
const option = (time: string) => document.querySelector<HTMLElement>(`[data-time="${time}"]`)!;
const isOpen = () => listbox()?.dataset.popoverOpen === 'true';
/** The option `aria-activedescendant` names - and it must be the only highlighted / aria-selected one. */
function active(input: HTMLInputElement): string | null {
	const id = input.getAttribute('aria-activedescendant');
	const highlighted = [...document.querySelectorAll<HTMLElement>('.time-option--active')];
	const selected = [
		...document.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')
	];
	if (!id) {
		expect(highlighted).toEqual([]);
		expect(selected).toEqual([]);
		return null;
	}
	const el = document.getElementById(id)!;
	expect(highlighted).toEqual([el]);
	expect(selected).toEqual([el]);
	return el.dataset.time ?? null;
}

/** Dispatch a mousedown and tell whether its default (moving focus) was prevented. */
function mouseDownPrevented(el: Element): boolean {
	const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
	el.dispatchEvent(event);
	return event.defaultPrevented;
}

function press(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}) {
	fireEvent.keyDown(input, { key, ...init });
	flushSync();
}

/** Move focus outside the way a click does: pointerdown first (closes the list), then focus. */
function clickOutside() {
	const outside = screen.getByRole('button', { name: 'Outside' });
	fireEvent.pointerDown(outside);
	outside.focus();
	flushSync();
}

describe('TimeInput text box', () => {
	it('is a combobox described by the format hint, closed and without a listbox', () => {
		const { input, button } = setup({ value: '09:30' });
		expect(input.value).toBe('09:30');
		expect(input.getAttribute('aria-autocomplete')).toBe('none');
		expect(input.getAttribute('aria-expanded')).toBe('false');
		expect(input.hasAttribute('aria-controls')).toBe(false);
		expect(input.hasAttribute('aria-activedescendant')).toBe(false);
		const hint = document.getElementById(input.getAttribute('aria-describedby')!)!;
		expect(hint.textContent).toBe('HH:mm の形で入力（例: 09:30）');
		expect(button.tabIndex).toBe(-1);
		expect(listbox()).toBeNull();
	});

	it('typed text is parsed on blur and rewritten to the canonical form', () => {
		const { input, onValueChange, onblur } = setup();
		input.focus();
		fireEvent.input(input, { target: { value: '９３０' } });
		clickOutside();
		expect(input.value).toBe('09:30');
		expect(onValueChange).toHaveBeenLastCalledWith('09:30');
		expect(onblur).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('value').textContent).toBe('09:30');
	});

	it('any minute is accepted without a step (D8), and with one too (checking is the parent’s)', () => {
		const { input, onValueChange } = setup({ step: 15 });
		input.focus();
		fireEvent.input(input, { target: { value: '10:17' } });
		press(input, 'Enter');
		expect(input.value).toBe('10:17');
		expect(onValueChange).toHaveBeenLastCalledWith('10:17');
	});

	it('Enter with the list closed commits and still reaches onkeydown untouched', () => {
		const { input, onkeydown, onValueChange } = setup();
		input.focus();
		fireEvent.input(input, { target: { value: '7' } });
		press(input, 'Enter');
		expect(onValueChange).toHaveBeenLastCalledWith('07:00');
		const event = onkeydown.mock.calls.at(-1)![0] as KeyboardEvent;
		expect(event.key).toBe('Enter');
		expect(event.defaultPrevented).toBe(false);
	});

	it('text that does not parse stays and the value does not change; blank gives null (D6)', () => {
		const { input, onValueChange } = setup({ value: '09:30' });
		input.focus();
		fireEvent.input(input, { target: { value: '25:00' } });
		clickOutside();
		expect(input.value).toBe('25:00');
		expect(onValueChange).not.toHaveBeenCalled();
		input.focus();
		fireEvent.input(input, { target: { value: '  ' } });
		clickOutside();
		expect(input.value).toBe('');
		expect(onValueChange).toHaveBeenLastCalledWith(null);
	});

	it('disabled / readonly cannot open the list; readonly passes ArrowDown through untouched', () => {
		for (const props of [{ disabled: true }, { readonly: true }]) {
			const { input, button, onkeydown } = setup(props);
			expect(button.disabled).toBe(true);
			press(input, 'ArrowDown');
			expect(listbox()).toBeNull();
			expect((onkeydown.mock.calls.at(-1)![0] as KeyboardEvent).defaultPrevented).toBe(false);
			cleanup();
		}
	});
});

describe('TimeInput list (combobox + listbox)', () => {
	it('ArrowDown opens on the value with the APG wiring; focus stays on the text box', () => {
		const { input, onkeydown } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		expect(isOpen()).toBe(true);
		const list = listbox()!;
		expect(input.getAttribute('aria-expanded')).toBe('true');
		expect(input.getAttribute('aria-controls')).toBe(list.id);
		expect(list.getAttribute('popover')).toBe('manual');
		expect(list.hasAttribute('data-esc-layer')).toBe(true);
		expect(document.activeElement).toBe(input);
		expect(active(input)).toBe('09:30');
		expect(option('09:30').classList.contains('time-option--value')).toBe(true);
		expect(screen.getAllByRole('option')).toHaveLength(48);
		const event = onkeydown.mock.calls.at(-1)![0] as KeyboardEvent;
		expect(event.defaultPrevented).toBe(true);
	});

	it('Alt+ArrowDown opens too; Alt+ArrowUp closes', () => {
		const { input } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown', { altKey: true });
		expect(isOpen()).toBe(true);
		expect(active(input)).toBe('09:30');
		press(input, 'ArrowDown', { altKey: true });
		expect(active(input)).toBe('09:30');
		press(input, 'ArrowUp', { altKey: true });
		expect(listbox()).toBeNull();
		expect(input.value).toBe('09:30');
	});

	it('opens on the nearest option to an off-step value (tie: the earlier one)', () => {
		const { input } = setup({ value: '10:15' });
		input.focus();
		press(input, 'ArrowDown');
		expect(active(input)).toBe('10:00');
		expect(option('10:00').classList.contains('time-option--value')).toBe(false);
	});

	it('opens on the typed (uncommitted) time when it parses', () => {
		const { input } = setup({ value: '09:30' });
		input.focus();
		fireEvent.input(input, { target: { value: '1450' } });
		press(input, 'ArrowDown');
		expect(active(input)).toBe('15:00');
	});

	it('without a value it opens on the option nearest to now, and does not pick it', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 10, 7, 14, 20));
		const { input, onValueChange } = setup();
		input.focus();
		press(input, 'ArrowDown');
		expect(active(input)).toBe('14:30');
		expect(input.value).toBe('');
		expect(onValueChange).not.toHaveBeenCalled();
		press(input, 'ArrowDown');
		expect(active(input)).toBe('15:00');
	});

	it('without a value the nearest-to-now option follows step and min / max', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 10, 7, 14, 20));
		const first = setup({ step: 15 });
		first.input.focus();
		press(first.input, 'ArrowDown');
		expect(active(first.input)).toBe('14:15');
		cleanup();
		const before = setup({ min: '15:00', max: '18:00' });
		before.input.focus();
		press(before.input, 'ArrowDown');
		expect(active(before.input)).toBe('15:00');
		cleanup();
		vi.setSystemTime(new Date(2026, 10, 7, 23, 50));
		const after = setup({ min: '09:00', max: '18:00' });
		after.input.focus();
		press(after.input, 'ArrowDown');
		expect(active(after.input)).toBe('18:00');
	});

	it('ArrowDown / ArrowUp move the active option and stop at the ends (00:00, last)', () => {
		const { input } = setup({ value: '00:00' });
		input.focus();
		press(input, 'ArrowDown');
		press(input, 'ArrowUp');
		expect(active(input)).toBe('00:00');
		press(input, 'ArrowDown');
		expect(active(input)).toBe('00:30');
		cleanup();
		const again = setup({ value: '23:59' });
		again.input.focus();
		press(again.input, 'ArrowDown');
		expect(active(again.input)).toBe('23:30');
		press(again.input, 'ArrowDown');
		expect(active(again.input)).toBe('23:30');
		press(again.input, 'ArrowUp');
		expect(active(again.input)).toBe('23:00');
	});

	it('Enter picks the active option, closes, and arrives defaultPrevented (§5.8 promise 2)', () => {
		const { input, onValueChange, onkeydown, onHostKeydown } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		press(input, 'ArrowDown');
		press(input, 'Enter');
		expect(listbox()).toBeNull();
		expect(input.value).toBe('10:00');
		expect(onValueChange).toHaveBeenLastCalledWith('10:00');
		expect(document.activeElement).toBe(input);
		const event = onkeydown.mock.calls.at(-1)![0] as KeyboardEvent;
		expect(event.key).toBe('Enter');
		expect(event.defaultPrevented).toBe(true);
		// The host sees the key (it bubbles from the text box) already handled.
		expect((onHostKeydown.mock.calls.at(-1)![0] as KeyboardEvent).defaultPrevented).toBe(true);
	});

	it('typing while open clears the active option, so Enter takes the typed text', () => {
		const { input, onValueChange } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		fireEvent.input(input, { target: { value: '10:17' } });
		flushSync();
		expect(active(input)).toBeNull();
		expect(isOpen()).toBe(true);
		press(input, 'Enter');
		expect(listbox()).toBeNull();
		expect(input.value).toBe('10:17');
		expect(onValueChange).toHaveBeenLastCalledWith('10:17');
	});

	it('after typing, ArrowDown resumes from the option nearest to the typed time', () => {
		const { input } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		fireEvent.input(input, { target: { value: '18:10' } });
		press(input, 'ArrowDown');
		expect(active(input)).toBe('18:00');
	});

	it('Esc closes, keeps the value and arrives defaultPrevented; a consumed Esc is left alone', () => {
		const { input, onkeydown } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		press(input, 'ArrowDown');
		press(input, 'Escape');
		expect(listbox()).toBeNull();
		expect(input.value).toBe('09:30');
		expect(document.activeElement).toBe(input);
		expect((onkeydown.mock.calls.at(-1)![0] as KeyboardEvent).defaultPrevented).toBe(true);
		// Closed: the next Esc is the host's (not prevented).
		press(input, 'Escape');
		expect((onkeydown.mock.calls.at(-1)![0] as KeyboardEvent).defaultPrevented).toBe(false);
		// A consumed Esc does not close it.
		press(input, 'ArrowDown');
		const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		event.preventDefault();
		input.dispatchEvent(event);
		flushSync();
		expect(isOpen()).toBe(true);
	});

	it('Esc at window level closes it (layering rule 3)', () => {
		const { input } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		fireEvent.keyDown(window, { key: 'Escape' });
		flushSync();
		expect(listbox()).toBeNull();
	});

	it('closed, ArrowUp and other keys pass through untouched', () => {
		const { input, onkeydown } = setup({ value: '09:30' });
		input.focus();
		for (const key of ['ArrowUp', 'Home', 'End', 'Tab']) {
			press(input, key);
			expect(listbox()).toBeNull();
			expect((onkeydown.mock.calls.at(-1)![0] as KeyboardEvent).defaultPrevented).toBe(false);
		}
	});

	it('the button toggles the list and focuses the text box, never itself', () => {
		const { input, button } = setup({ value: '09:30' });
		// Default prevented: focus does not move to the button.
		expect(mouseDownPrevented(button)).toBe(true);
		fireEvent.click(button);
		flushSync();
		expect(isOpen()).toBe(true);
		expect(document.activeElement).toBe(input);
		expect(active(input)).toBe('09:30');
		fireEvent.click(button);
		flushSync();
		expect(listbox()).toBeNull();
		expect(document.activeElement).toBe(input);
	});
});

describe('TimeInput pointer: the active option, the highlight and focus never part', () => {
	it('moving the pointer over an option makes it the active one', () => {
		const { input } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		fireEvent.pointerMove(option('11:00'));
		flushSync();
		expect(active(input)).toBe('11:00');
		// The keys continue from there.
		press(input, 'ArrowDown');
		expect(active(input)).toBe('11:30');
	});

	it('a click on an option picks it; focus stays on the text box throughout', () => {
		const { input, onValueChange, onblur } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		const target = option('13:30');
		expect(mouseDownPrevented(target)).toBe(true);
		fireEvent.pointerMove(target);
		fireEvent.click(target);
		flushSync();
		expect(listbox()).toBeNull();
		expect(input.value).toBe('13:30');
		expect(onValueChange).toHaveBeenLastCalledWith('13:30');
		expect(document.activeElement).toBe(input);
		expect(onblur).not.toHaveBeenCalled();
	});

	it('times outside [min, max] are aria-disabled: no pointer activation, no pick, state unchanged', () => {
		const { input, onValueChange } = setup({
			value: '09:00',
			min: '09:00',
			max: '17:00',
			step: 60
		});
		input.focus();
		press(input, 'ArrowDown');
		expect(screen.getAllByRole('option')).toHaveLength(24);
		expect(option('08:00').getAttribute('aria-disabled')).toBe('true');
		expect(option('09:00').hasAttribute('aria-disabled')).toBe(false);
		expect(option('18:00').getAttribute('aria-disabled')).toBe('true');
		expect(active(input)).toBe('09:00');
		const off = option('20:00');
		expect(mouseDownPrevented(off)).toBe(true);
		fireEvent.pointerMove(off);
		fireEvent.click(off);
		flushSync();
		expect(isOpen()).toBe(true);
		expect(active(input)).toBe('09:00');
		expect(document.activeElement).toBe(input);
		expect(onValueChange).not.toHaveBeenCalled();
	});

	it('the keys skip the disabled times and stop at the range ends', () => {
		const { input } = setup({ value: '16:00', min: '09:00', max: '17:00', step: 60 });
		input.focus();
		press(input, 'ArrowDown');
		press(input, 'ArrowDown');
		expect(active(input)).toBe('17:00');
		press(input, 'ArrowDown');
		expect(active(input)).toBe('17:00');
		cleanup();
		const early = setup({ value: '03:00', min: '09:00', max: '17:00', step: 60 });
		early.input.focus();
		press(early.input, 'ArrowDown');
		// Out-of-range value: the nearest selectable option.
		expect(active(early.input)).toBe('09:00');
		press(early.input, 'ArrowUp');
		expect(active(early.input)).toBe('09:00');
	});

	it('a parent narrowing [min, max] while open drops an active option that is now disabled', async () => {
		const { input, rerender } = setupWithRerender({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		expect(active(input)).toBe('09:30');
		await rerender({ min: '12:00' });
		flushSync();
		expect(option('09:30').getAttribute('aria-disabled')).toBe('true');
		expect(active(input)).toBeNull();
		press(input, 'ArrowDown');
		expect(active(input)).toBe('12:00');
		await rerender({ readonly: true });
		flushSync();
		expect(listbox()).toBeNull();
	});

	it('with no selectable time (min > max) nothing becomes active', () => {
		const { input } = setup({ min: '18:00', max: '09:00' });
		input.focus();
		press(input, 'ArrowDown');
		expect(isOpen()).toBe(true);
		expect(active(input)).toBeNull();
		press(input, 'ArrowDown');
		expect(active(input)).toBeNull();
		press(input, 'Enter');
		expect(listbox()).toBeNull();
	});

	it('the step lists every `step` minutes from 00:00, ending before midnight (D8)', () => {
		const { input } = setup({ step: 25, value: '23:59' });
		input.focus();
		press(input, 'ArrowDown');
		const times = screen.getAllByRole('option').map((el) => el.textContent?.trim());
		expect(times[0]).toBe('00:00');
		expect(times[1]).toBe('00:25');
		expect(times.at(-1)).toBe('23:45');
		expect(active(input)).toBe('23:45');
	});

	it('pointerdown inside the component does not reach the host (§5.8 promise 4)', () => {
		const { input, button, onHostPointerdown } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		fireEvent.pointerDown(option('10:00'));
		fireEvent.pointerDown(input);
		fireEvent.pointerDown(button);
		expect(onHostPointerdown).not.toHaveBeenCalled();
		expect(isOpen()).toBe(true);
	});

	it('a pointerdown outside closes the list; onblur fires once focus has left', () => {
		const { input, onblur, onValueChange } = setup({ value: '09:30' });
		input.focus();
		press(input, 'ArrowDown');
		press(input, 'ArrowDown');
		clickOutside();
		expect(listbox()).toBeNull();
		expect(onblur).toHaveBeenCalledTimes(1);
		// Closing does not pick the active option.
		expect(onValueChange).not.toHaveBeenCalled();
		expect(input.value).toBe('09:30');
	});
});

/** jsdom has no layout: fake a 100px list of 20px options and a scrollTop that the list keeps. */
function installListLayout() {
	let scrollTop = 0;
	const isList = (el: HTMLElement) => el.getAttribute('role') === 'listbox';
	const original = HTMLElement.prototype.getBoundingClientRect;
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		if (isList(this)) return new DOMRect(0, 100, 100, 100);
		const time = this.dataset.time;
		if (time) {
			const index = [...document.querySelectorAll<HTMLElement>('[data-time]')].indexOf(this);
			return new DOMRect(0, 100 + index * 20 - scrollTop, 100, 20);
		}
		return original.call(this);
	};
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	Object.defineProperty(proto, 'clientHeight', {
		get(this: HTMLElement) {
			return isList(this) ? 100 : 0;
		},
		configurable: true
	});
	Object.defineProperty(proto, 'clientWidth', {
		get(this: HTMLElement) {
			return isList(this) ? 100 : 0;
		},
		configurable: true
	});
	Object.defineProperty(proto, 'scrollTop', {
		get(this: HTMLElement) {
			return isList(this) ? scrollTop : 0;
		},
		set(this: HTMLElement, v: number) {
			if (isList(this)) scrollTop = v;
		},
		configurable: true
	});
	const scrollSpy = vi.spyOn(window, 'scrollTo');
	const intoView = vi.fn();
	const originalIntoView = HTMLElement.prototype.scrollIntoView;
	HTMLElement.prototype.scrollIntoView = intoView;
	return {
		scrollTop: () => scrollTop,
		scrollSpy,
		intoView,
		restore() {
			HTMLElement.prototype.getBoundingClientRect = original;
			HTMLElement.prototype.scrollIntoView = originalIntoView;
			delete proto.clientHeight;
			delete proto.clientWidth;
			delete proto.scrollTop;
		}
	};
}

describe('TimeInput in a height-capped list', () => {
	it('scrolls the list itself (not the page) to show the active option', () => {
		const { input } = setup({ value: '09:30' });
		// jsdom has no layout: a list showing y 100..200 with 20px options from
		// y 100 (00:00 first), all following the list's scrollTop.
		let scrollTop = 0;
		const isList = (el: HTMLElement) => el.getAttribute('role') === 'listbox';
		const original = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
			if (isList(this)) return new DOMRect(0, 100, 100, 100);
			const time = this.dataset.time;
			if (time) {
				const index = [...document.querySelectorAll<HTMLElement>('[data-time]')].indexOf(this);
				return new DOMRect(0, 100 + index * 20 - scrollTop, 100, 20);
			}
			return original.call(this);
		};
		const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
		Object.defineProperty(proto, 'clientHeight', {
			get(this: HTMLElement) {
				return isList(this) ? 100 : 0;
			},
			configurable: true
		});
		Object.defineProperty(proto, 'clientWidth', {
			get(this: HTMLElement) {
				return isList(this) ? 100 : 0;
			},
			configurable: true
		});
		Object.defineProperty(proto, 'scrollTop', {
			get(this: HTMLElement) {
				return isList(this) ? scrollTop : 0;
			},
			set(this: HTMLElement, v: number) {
				if (isList(this)) scrollTop = v;
			},
			configurable: true
		});
		const scrollSpy = vi.spyOn(window, 'scrollTo');
		const intoView = vi.fn();
		const originalIntoView = HTMLElement.prototype.scrollIntoView;
		HTMLElement.prototype.scrollIntoView = intoView;
		try {
			input.focus();
			press(input, 'ArrowDown');
			// 09:30 is option 19 (y 480..500 unscrolled): centred on open -> its
			// middle (490) at the list's middle (150): scrollTop 340.
			expect(active(input)).toBe('09:30');
			expect(scrollTop).toBe(340);
			// 10:00 (y 160..180 now) is visible: no scroll.
			press(input, 'ArrowDown');
			expect(scrollTop).toBe(340);
			// Down to 11:00 (option 22, y 200..220): scrolled by 20 to end at 200.
			press(input, 'ArrowDown');
			press(input, 'ArrowDown');
			expect(active(input)).toBe('11:00');
			expect(scrollTop).toBe(360);
			// Back up to 09:00 (option 18, y 100+360-360=100.. ): visible at the
			// top edge; one more up (08:30, y 80) scrolls by 20.
			for (let i = 0; i < 4; i++) press(input, 'ArrowUp');
			expect(active(input)).toBe('09:00');
			expect(scrollTop).toBe(360);
			press(input, 'ArrowUp');
			expect(active(input)).toBe('08:30');
			expect(scrollTop).toBe(340);
			expect(scrollSpy).not.toHaveBeenCalled();
			expect(intoView).not.toHaveBeenCalled();
		} finally {
			HTMLElement.prototype.getBoundingClientRect = original;
			HTMLElement.prototype.scrollIntoView = originalIntoView;
			delete proto.clientHeight;
			delete proto.clientWidth;
			delete proto.scrollTop;
		}
	});

	it('without a value it scrolls to the option nearest to now (centred) and leaves the value alone', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 10, 7, 14, 20));
		const { input, onValueChange } = setup();
		const layout = installListLayout();
		try {
			input.focus();
			press(input, 'ArrowDown');
			// 14:30 is option 29 (middle y 100+29*20+10 = 690): centred in the
			// list's middle (150) -> scrollTop 540.
			expect(active(input)).toBe('14:30');
			expect(layout.scrollTop()).toBe(540);
			expect(input.value).toBe('');
			expect(onValueChange).not.toHaveBeenCalled();
		} finally {
			layout.restore();
		}
	});
});

describe('TimeInput messages', () => {
	it('messages override the default text', () => {
		render(TimeInputHarness, {
			messages: {
				timePickerOpen: () => 'Choose time',
				timePickerList: () => 'Times',
				timeFormatHint: () => 'HH:mm'
			}
		});
		const input = screen.getByRole('combobox', { name: 'Start time' });
		expect(screen.getByRole('button', { name: 'Choose time' })).toBeTruthy();
		fireEvent.keyDown(input, { key: 'ArrowDown' });
		flushSync();
		expect(screen.getByRole('listbox', { name: 'Times' })).toBeTruthy();
		expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe(
			'HH:mm'
		);
	});
});
