// @vitest-environment jsdom
/**
 * DateRangeInput (docs/design/date-time-pickers.md §5.4 / §5.9, D13, PR-6):
 * two DateInputs in a named `role="group"`, the boxes named 開始日 / 終了日,
 * the value `{ from, to }` updated per end, typed text reported per end, and
 * the §5.8 promises for the whole range: keys inside a calendar and
 * pointerdowns do not reach the host, `onblur` only when focus leaves both
 * boxes. jsdom has no Popover API: the stand-in from dateInput.test.ts is
 * installed.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DateRangeInputHarness from './fixtures/DateRangeInputHarness.svelte';

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

function setup(props: Record<string, unknown> = {}) {
	const handlers = {
		onValueChange: vi.fn(),
		onTextInput: vi.fn(),
		onkeydown: vi.fn(),
		onblur: vi.fn(),
		onHostKeydown: vi.fn(),
		onHostPointerdown: vi.fn()
	};
	render(DateRangeInputHarness, { label: 'Visit', ...handlers, ...props });
	const group = screen.getByRole('group', { name: 'Visit' });
	const from = within(group).getByRole('textbox', { name: '開始日' }) as HTMLInputElement;
	const to = within(group).getByRole('textbox', { name: '終了日' }) as HTMLInputElement;
	return { ...handlers, group, from, to };
}

const calendar = () => document.querySelector<HTMLElement>('[role="dialog"]');
const shown = () => screen.getByTestId('value').textContent;

describe('DateRangeInput', () => {
	it('is a named group of two named date boxes', () => {
		const { from, to } = setup({ value: { from: '2026-11-01', to: '2026-11-30' } });
		expect(from.value).toBe('2026-11-01');
		expect(to.value).toBe('2026-11-30');
	});

	it('takes its name from labelledBy over label', () => {
		setup({ label: 'Ignored', labelledBy: 'range-name' });
		expect(screen.getByRole('group', { name: 'Visit' })).toBeTruthy();
	});

	it('updates one end on commit and reports text per end', async () => {
		const { from, to, onValueChange, onTextInput } = setup();
		await fireEvent.input(from, { target: { value: '2026/11/1' } });
		expect(onTextInput).toHaveBeenLastCalledWith('from', '2026/11/1');
		await fireEvent.keyDown(from, { key: 'Enter' });
		expect(from.value).toBe('2026-11-01');
		expect(onValueChange).toHaveBeenLastCalledWith({ from: '2026-11-01', to: null });
		await fireEvent.input(to, { target: { value: '2026-11-30' } });
		expect(onTextInput).toHaveBeenLastCalledWith('to', '2026-11-30');
		await fireEvent.keyDown(to, { key: 'Enter' });
		expect(onValueChange).toHaveBeenLastCalledWith({ from: '2026-11-01', to: '2026-11-30' });
		expect(shown()).toBe('2026-11-01..2026-11-30');
	});

	it('does not check the order of the ends (the host does)', async () => {
		const { from, onValueChange } = setup({ value: { from: null, to: '2026-11-01' } });
		await fireEvent.input(from, { target: { value: '2026-12-01' } });
		await fireEvent.keyDown(from, { key: 'Enter' });
		expect(onValueChange).toHaveBeenLastCalledWith({ from: '2026-12-01', to: '2026-11-01' });
	});

	it('passes keys from both boxes to onkeydown', async () => {
		const { from, to, onkeydown } = setup();
		await fireEvent.keyDown(from, { key: 'Enter' });
		await fireEvent.keyDown(to, { key: 'Enter' });
		expect(onkeydown).toHaveBeenCalledTimes(2);
	});

	it('fires onblur only when focus leaves both boxes', async () => {
		const { from, to, onblur } = setup();
		from.focus();
		await fireEvent.focusOut(from, { relatedTarget: to });
		to.focus();
		expect(onblur).not.toHaveBeenCalled();
		const outside = screen.getByRole('button', { name: 'Outside' });
		await fireEvent.focusOut(to, { relatedTarget: outside });
		expect(onblur).toHaveBeenCalledTimes(1);
	});

	it('keeps calendar keys and pointerdowns away from the host; Esc closes the calendar only', async () => {
		const { to, group, onHostKeydown, onHostPointerdown } = setup();
		await fireEvent.keyDown(to, { key: 'ArrowDown', altKey: true });
		flushSync();
		expect(calendar()).not.toBeNull();
		onHostKeydown.mockClear();
		await fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		await fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
		flushSync();
		expect(onHostKeydown).not.toHaveBeenCalled();
		expect(calendar()).toBeNull();
		expect(document.activeElement).toBe(to);
		// The gap between the boxes too (promise 4).
		group.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(onHostPointerdown).not.toHaveBeenCalled();
	});

	it('stacks the boxes without the dash when vertical', () => {
		const { group } = setup({ orientation: 'vertical' });
		expect(group.textContent).not.toContain('–');
	});
});
