// @vitest-environment jsdom
/**
 * FilterPopover interaction/dismiss test (spec §4.3, improvement-plan P4-1).
 *
 * improvements.md §8 flagged the popover's "focus trap" as unverified. On
 * inspection the popover does NOT implement a Tab-cycling focus trap; its
 * focus/interaction boundary is instead a DISMISS model: it closes on Escape
 * owned by its focused controls and on a pointer-down outside its root/trigger, while a pointer-down
 * inside is left alone. These tests pin exactly that behavior (plus the
 * dialog semantics and apply/clear wiring), so the §8 item is resolved by
 * documenting + covering the real contract rather than a trap that isn't there.
 *
 * The outside/inside pointer-down cases dispatch a plain `Event('pointerdown')`
 * rather than a `PointerEvent` (whose constructor jsdom does not provide) -
 * the component only ever reads `event.target`/`event.type`, so a generic
 * bubbling event exercises the exact capture-phase window listener it registers.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FilterPopover from '../src/FilterPopover.svelte';
import type { FilterState, GridColumn } from '../src/types';

afterEach(cleanup);

interface Row {
	name: string;
	price: number;
}

const textColumn: GridColumn<Row> = {
	id: 'name',
	header: '商品名',
	accessor: 'name',
	filterable: true,
	filterType: 'text'
};

function renderPopover(column = textColumn, current: FilterState | undefined = undefined) {
	const handlers = {
		onApply: vi.fn(),
		onClear: vi.fn(),
		onClose: vi.fn()
	};
	const { unmount } = render(FilterPopover<Row>, {
		column,
		current,
		...handlers
	});
	return { ...handlers, unmount };
}

function pointerDown(target: EventTarget) {
	target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

describe('FilterPopover', () => {
	it('exposes a labelled dialog', () => {
		renderPopover();
		expect(screen.getByRole('dialog', { name: '商品名の絞り込み' })).toBeTruthy();
	});

	it('closes on Escape from its focused input', async () => {
		const { onClose } = renderPopover();
		const input = screen.getByRole('textbox');
		input.focus();
		await fireEvent.keyDown(input, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledExactlyOnceWith('escape');
	});

	it('does not close on other keys', async () => {
		const { onClose } = renderPopover();
		await fireEvent.keyDown(document.body, { key: 'a' });
		expect(onClose).not.toHaveBeenCalled();
	});

	it('closes on a pointer-down outside its root', () => {
		const { onClose } = renderPopover();
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		pointerDown(outside);
		expect(onClose).toHaveBeenCalledTimes(1);
		outside.remove();
	});

	it('stays open on a pointer-down inside its root', () => {
		const { onClose } = renderPopover();
		pointerDown(screen.getByRole('dialog').querySelector('input')!);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('removes its window listeners on unmount (no dismiss after close)', () => {
		const { onClose, unmount } = renderPopover();
		unmount();
		// After teardown, a stray outside pointer-down must not reach a
		// leaked listener (the $effect cleanup removed it).
		pointerDown(document.body);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('applies the entered value via the 適用 button', async () => {
		const { onApply, onClear } = renderPopover();
		await fireEvent.input(screen.getByPlaceholderText('値を入力'), { target: { value: 'ペン' } });
		await fireEvent.click(screen.getByRole('button', { name: '適用' }));
		expect(onApply).toHaveBeenCalledWith({ field: 'name', op: 'contains', value: 'ペン' });
		expect(onClear).not.toHaveBeenCalled();
	});

	it('treats applying an empty value as clearing the filter', async () => {
		const { onApply, onClear } = renderPopover();
		await fireEvent.click(screen.getByRole('button', { name: '適用' }));
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onApply).not.toHaveBeenCalled();
	});

	it('clears an existing numeric zero after erasing the input without applying NaN', async () => {
		const { onApply, onClear } = renderPopover(
			{ id: 'price', header: 'Price', accessor: 'price', filterType: 'number' },
			{ field: 'price', op: 'eq', value: 0 }
		);
		const input = screen.getByRole('spinbutton') as HTMLInputElement;
		expect(input.value).toBe('0');
		await fireEvent.input(input, { target: { value: '' } });
		const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		await fireEvent(input, enter);
		expect(enter.defaultPrevented).toBe(true);
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onApply).not.toHaveBeenCalled();
	});

	it('applies on Enter in the value input', async () => {
		const { onApply } = renderPopover();
		const input = screen.getByPlaceholderText('値を入力');
		await fireEvent.input(input, { target: { value: 'ノート' } });
		const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		await fireEvent(input, enter);
		expect(enter.defaultPrevented).toBe(true);
		expect(onApply).toHaveBeenCalledExactlyOnceWith({
			field: 'name',
			op: 'contains',
			value: 'ノート'
		});
	});

	it('leaves composing and already handled Enter events to their owner', async () => {
		const { onApply, onClear } = renderPopover();
		const input = screen.getByRole('textbox');
		await fireEvent.input(input, { target: { value: '変換中' } });
		const composing = new KeyboardEvent('keydown', {
			key: 'Enter',
			bubbles: true,
			cancelable: true,
			isComposing: true
		});
		await fireEvent(input, composing);
		expect(composing.defaultPrevented).toBe(false);
		const handled = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		handled.preventDefault();
		await fireEvent(input, handled);
		expect(onApply).not.toHaveBeenCalled();
		expect(onClear).not.toHaveBeenCalled();
	});

	it.each(['Enter', 'Escape'])('leaves legacy composition %s to the IME', async (key) => {
		const { onApply, onClear, onClose } = renderPopover();
		const input = screen.getByRole('textbox');
		input.focus();
		await fireEvent.input(input, { target: { value: '変換中' } });
		const event = new KeyboardEvent('keydown', {
			key,
			keyCode: 229,
			isComposing: false,
			bubbles: true,
			cancelable: true
		});
		await fireEvent(input, event);
		expect(event.defaultPrevented).toBe(false);
		expect(onApply).not.toHaveBeenCalled();
		expect(onClear).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(input);
	});
});
