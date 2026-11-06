// @vitest-environment jsdom
/** Nonmodal filter focus belongs to the control the user is operating. */
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { GridState } from '../src/state.svelte';
import type { GridMessages } from '../src/messages';
import type { GridColumn } from '../src/types';

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
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

interface Row {
	id: number;
	name: string;
	price: number;
}
const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name', filterable: true },
	{ id: 'price', header: 'Price', accessor: 'price', filterable: true, filterType: 'number' }
];
function setup(
	mode: 'client' | 'server' = 'client',
	messages: Partial<GridMessages> = {},
	cols = columns,
	initialState?: GridState<Row>
) {
	const state = initialState ?? new GridState(cols);
	const onParamsChange = vi.fn();
	const view = render(BantoGrid<Row>, {
		rows: [{ id: 1, name: 'Alpha', price: 10 }],
		columns: cols,
		state,
		mode,
		totalRows: 1,
		getRowId: (row: Row) => row.id,
		onParamsChange,
		messages
	});
	const query = within(view.container);
	return { ...view, query, state, onParamsChange };
}
async function open(view: ReturnType<typeof setup>, name = 'Nameの絞り込み') {
	const trigger = view.query.getByRole('button', { name });
	trigger.focus();
	await fireEvent.click(trigger);
	const dialog = view.query.getByRole('dialog', { name });
	const input = dialog.querySelector('input')!;
	return { trigger, dialog, input, select: dialog.querySelector('select')! };
}

it('names controls, focuses the value once and connects the expanded trigger', async () => {
	const view = setup('client', {
		filterOperatorLabel: () => 'Filter operator',
		filterValueLabel: () => 'Filter value'
	});
	const button = view.query.getByRole('button', { name: 'Nameの絞り込み' });
	expect(button.getAttribute('aria-haspopup')).toBe('dialog');
	expect(button.getAttribute('aria-expanded')).toBe('false');
	expect(button.hasAttribute('aria-controls')).toBe(false);
	const { trigger, dialog, input, select } = await open(view);
	expect(trigger.getAttribute('aria-expanded')).toBe('true');
	expect(trigger.getAttribute('aria-controls')).toBe(dialog.id);
	expect(dialog.hasAttribute('aria-modal')).toBe(false);
	expect(document.activeElement).toBe(input);
	expect(within(dialog).getByRole('textbox', { name: 'Filter value' })).toBe(input);
	expect(within(dialog).getByRole('combobox', { name: 'Filter operator' })).toBe(select);
	select.focus();
	await fireEvent.change(select, { target: { value: 'eq' } });
	expect(document.activeElement).toBe(select);
});

it('uses independent IDs for identical grids and falls back to the column ID', async () => {
	const cols = [{ ...columns[0], header: '  ' }];
	const first = await open(setup('client', {}, cols), 'nameの絞り込み');
	const second = await open(setup('client', {}, cols), 'nameの絞り込み');
	expect(first.dialog.id).not.toBe(second.dialog.id);
	expect(document.getElementById(first.trigger.getAttribute('aria-controls')!)).toBe(first.dialog);
	expect(document.getElementById(second.trigger.getAttribute('aria-controls')!)).toBe(
		second.dialog
	);
});

it('dismisses Escape only when the popover owns focus and the event', async () => {
	const view = setup();
	const { trigger, dialog, input } = await open(view);
	await fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
	expect(dialog.isConnected).toBe(true);
	const prevented = new KeyboardEvent('keydown', {
		key: 'Escape',
		bubbles: true,
		cancelable: true
	});
	prevented.preventDefault();
	await fireEvent(input, prevented);
	expect(dialog.isConnected).toBe(true);
	trigger.focus();
	await fireEvent.keyDown(trigger, { key: 'Escape' });
	expect(dialog.isConnected).toBe(true);
	// A stale event from inside must not take focus back from an outside control.
	await fireEvent.keyDown(input, { key: 'Escape' });
	expect(dialog.isConnected).toBe(true);
	input.focus();
	const focus = vi.spyOn(trigger, 'focus');
	await fireEvent.keyDown(input, { key: 'Escape' });
	expect(dialog.isConnected).toBe(false);
	expect(document.activeElement).toBe(trigger);
	expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
	expect(trigger.getAttribute('aria-expanded')).toBe('false');
	expect(trigger.hasAttribute('aria-controls')).toBe(false);
	expect(view.onParamsChange).not.toHaveBeenCalled();
});

it('does not trap Tab or reclaim focus on an outside pointer action', async () => {
	const view = setup();
	const { trigger, dialog, input } = await open(view);
	for (const shiftKey of [false, true]) {
		const event = new KeyboardEvent('keydown', {
			key: 'Tab',
			shiftKey,
			bubbles: true,
			cancelable: true
		});
		await fireEvent(input, event);
		expect(event.defaultPrevented).toBe(false);
	}
	const outside = document.createElement('button');
	view.container.appendChild(outside);
	outside.focus();
	await fireEvent.keyDown(outside, { key: 'Escape' });
	expect(dialog.isConnected).toBe(true);
	const focus = vi.spyOn(trigger, 'focus');
	await fireEvent.pointerDown(outside, { button: 0 });
	expect(dialog.isConnected).toBe(false);
	expect(document.activeElement).toBe(outside);
	expect(focus).not.toHaveBeenCalled();
});

it('closes on the same trigger click and switches to another column without reopening the old popup', async () => {
	const view = setup();
	const first = await open(view);
	await fireEvent.pointerDown(first.trigger, { button: 0 });
	expect(first.dialog.isConnected).toBe(true);
	first.trigger.focus();
	await fireEvent.click(first.trigger);
	expect(view.query.queryByRole('dialog')).toBeNull();
	const reopened = await open(view);
	const other = view.query.getByRole('button', { name: 'Priceの絞り込み' });
	const oldFocus = vi.spyOn(reopened.trigger, 'focus');
	await fireEvent.pointerDown(other, { button: 0 });
	other.focus();
	await fireEvent.click(other);
	expect(oldFocus).not.toHaveBeenCalled();
	expect(reopened.dialog.isConnected).toBe(false);
	const dialog = view.query.getByRole('dialog', { name: 'Priceの絞り込み' });
	expect(document.activeElement).toBe(
		within(dialog).getByRole('spinbutton', { name: '絞り込み値' })
	);
});

describe.each(['client', 'server'] as const)('%s filter actions', (mode) => {
	it('applies once, restores the trigger, and re-seeds from the saved filter after cancelling a draft', async () => {
		const view = setup(mode);
		let controls = await open(view);
		await fireEvent.change(controls.select, { target: { value: 'eq' } });
		await fireEvent.input(controls.input, { target: { value: 'Alpha' } });
		const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		await fireEvent(controls.input, enter);
		expect(enter.defaultPrevented).toBe(true);
		expect(view.query.queryByRole('dialog')).toBeNull();
		expect(document.activeElement).toBe(controls.trigger);
		expect(view.state.filters).toEqual([{ field: 'name', op: 'eq', value: 'Alpha' }]);
		expect(view.onParamsChange).toHaveBeenCalledTimes(mode === 'server' ? 1 : 0);
		controls = await open(view);
		expect(controls.input.value).toBe('Alpha');
		expect(controls.select.value).toBe('eq');
		await fireEvent.input(controls.input, { target: { value: 'unsaved' } });
		await fireEvent.keyDown(controls.input, { key: 'Escape' });
		controls = await open(view);
		expect(controls.input.value).toBe('Alpha');
		await fireEvent.click(within(controls.dialog).getByRole('button', { name: 'クリア' }));
		expect(document.activeElement).toBe(controls.trigger);
		expect(view.state.filters).toEqual([]);
		expect(view.onParamsChange).toHaveBeenCalledTimes(mode === 'server' ? 2 : 0);
		controls = await open(view);
		expect(controls.input.value).toBe('');
		expect(controls.select.value).toBe('contains');
	});

	it('keeps numeric zero and clears an erased value without sending NaN', async () => {
		const view = setup(mode);
		let controls = await open(view, 'Priceの絞り込み');
		await fireEvent.input(controls.input, { target: { value: '0' } });
		await fireEvent.click(within(controls.dialog).getByRole('button', { name: '適用' }));
		expect(view.state.filters).toEqual([{ field: 'price', op: 'eq', value: 0 }]);
		if (mode === 'server') {
			expect(view.onParamsChange).toHaveBeenCalledExactlyOnceWith({
				sort: [],
				filters: [{ field: 'price', op: 'eq', value: 0 }]
			});
		}
		expect(document.activeElement).toBe(controls.trigger);
		controls = await open(view, 'Priceの絞り込み');
		expect(controls.input.value).toBe('0');
		await fireEvent.input(controls.input, { target: { value: '' } });
		const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		await fireEvent(controls.input, enter);
		expect(enter.defaultPrevented).toBe(true);
		expect(view.query.queryByRole('dialog')).toBeNull();
		expect(view.state.filters).toEqual([]);
		expect(document.activeElement).toBe(controls.trigger);
		expect(view.onParamsChange).toHaveBeenCalledTimes(mode === 'server' ? 2 : 0);
		if (mode === 'server') {
			expect(view.onParamsChange).toHaveBeenLastCalledWith({ sort: [], filters: [] });
		}
	});

	it('clears an empty applied text value and restores focus', async () => {
		const view = setup(mode);
		view.state.setFilter({ field: 'name', op: 'eq', value: 'Alpha' });
		const { input, dialog, trigger } = await open(view);
		await fireEvent.input(input, { target: { value: '' } });
		await fireEvent.click(within(dialog).getByRole('button', { name: '適用' }));
		expect(view.state.filters).toEqual([]);
		expect(document.activeElement).toBe(trigger);
		expect(view.onParamsChange).toHaveBeenCalledTimes(mode === 'server' ? 1 : 0);
	});
});

function expectApplied(trigger: HTMLElement, description?: string) {
	expect(trigger.hasAttribute('aria-pressed')).toBe(false);
	if (description === undefined) {
		expect(trigger.classList.contains('active')).toBe(false);
		expect(trigger.hasAttribute('aria-describedby')).toBe(false);
		expect(trigger.hasAttribute('title')).toBe(false);
		return undefined;
	}
	expect(trigger.classList.contains('active')).toBe(true);
	const id = trigger.getAttribute('aria-describedby');
	expect(id).toBeTruthy();
	const text = document.getElementById(id!)!;
	expect(text.textContent).toBe(description);
	expect(text.hidden).toBe(true);
	expect(text.hasAttribute('aria-live')).toBe(false);
	expect(text.hasAttribute('role')).toBe(false);
	expect(trigger.getAttribute('title')).toBe(description);
	return text;
}

describe.each(['client', 'server'] as const)('%s applied filter descriptions', (mode) => {
	it('keeps applied state independent of opening, draft changes, cancellation and clearing', async () => {
		const view = setup(mode);
		const trigger = view.query.getByRole('button', { name: 'Nameの絞り込み' });
		expectApplied(trigger);
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		let controls = await open(view);
		expectApplied(trigger);
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		await fireEvent.input(controls.input, { target: { value: 'Alpha' } });
		expectApplied(trigger);
		await fireEvent.keyDown(controls.input, { key: 'Escape' });
		expectApplied(trigger);
		expect(view.onParamsChange).not.toHaveBeenCalled();
		controls = await open(view);
		await fireEvent.change(controls.select, { target: { value: 'eq' } });
		await fireEvent.input(controls.input, { target: { value: 'Alpha' } });
		await fireEvent.keyDown(controls.input, { key: 'Enter' });
		const description = expectApplied(trigger, 'Nameの絞り込みを適用中')!;
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(trigger.hasAttribute('aria-controls')).toBe(false);
		expect(view.state.filters).toEqual([{ field: 'name', op: 'eq', value: 'Alpha' }]);
		controls = await open(view);
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		expect(expectApplied(trigger, 'Nameの絞り込みを適用中')).toBe(description);
		expect(trigger.getAttribute('aria-controls')).not.toBe(description.id);
		await fireEvent.input(controls.input, { target: { value: 'unsaved' } });
		await fireEvent.keyDown(controls.input, { key: 'Escape' });
		expectApplied(trigger, 'Nameの絞り込みを適用中');
		expect(view.state.filters).toEqual([{ field: 'name', op: 'eq', value: 'Alpha' }]);
		expect(view.onParamsChange).toHaveBeenCalledTimes(mode === 'server' ? 1 : 0);
		if (mode === 'server')
			expect(view.onParamsChange).toHaveBeenLastCalledWith({
				sort: [],
				filters: [{ field: 'name', op: 'eq', value: 'Alpha' }]
			});
		controls = await open(view);
		await fireEvent.click(within(controls.dialog).getByRole('button', { name: 'クリア' }));
		expectApplied(trigger);
		expect(document.getElementById(description.id)).toBeNull();
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(view.state.filters).toEqual([]);
		expect(view.onParamsChange).toHaveBeenCalledTimes(mode === 'server' ? 2 : 0);
		if (mode === 'server')
			expect(view.onParamsChange).toHaveBeenLastCalledWith({ sort: [], filters: [] });
	});

	it('describes numeric zero as applied and removes the description on empty-value clearing', async () => {
		const view = setup(mode);
		let controls = await open(view, 'Priceの絞り込み');
		await fireEvent.input(controls.input, { target: { value: '0' } });
		expectApplied(controls.trigger);
		await fireEvent.keyDown(controls.input, { key: 'Enter' });
		expectApplied(controls.trigger, 'Priceの絞り込みを適用中');
		expect(view.state.filters).toEqual([{ field: 'price', op: 'eq', value: 0 }]);
		controls = await open(view, 'Priceの絞り込み');
		await fireEvent.input(controls.input, { target: { value: '' } });
		expectApplied(controls.trigger, 'Priceの絞り込みを適用中');
		await fireEvent.keyDown(controls.input, { key: 'Enter' });
		expectApplied(controls.trigger);
		expect(view.state.filters).toEqual([]);
		expect(view.onParamsChange).toHaveBeenCalledTimes(mode === 'server' ? 2 : 0);
		if (mode === 'server')
			expect(view.onParamsChange).toHaveBeenLastCalledWith({ sort: [], filters: [] });
	});
});

it('reflects existing and hydrated external filters without firing callbacks', async () => {
	const state = new GridState(columns);
	state.setFilter({ field: 'price', op: 'eq', value: 0 });
	const serialized = state.serialize();
	const view = setup(
		'server',
		{ filterAppliedDescription: (header) => `${header}: filter applied` },
		columns,
		state
	);
	const trigger = view.query.getByRole('button', { name: 'Priceの絞り込み' });
	expectApplied(trigger, 'Price: filter applied');
	state.removeFilter('price');
	await tick();
	expectApplied(trigger);
	state.hydrate(serialized);
	await tick();
	expectApplied(trigger, 'Price: filter applied');
	expect(view.onParamsChange).not.toHaveBeenCalled();
});

it('uses column-ID fallback and unique description IDs across columns and identical grids', async () => {
	const cols = [{ ...columns[0], header: '  ' }, columns[1]];
	const ids: string[] = [];
	for (let i = 0; i < 2; i++) {
		const state = new GridState(cols);
		state.setFilter({ field: 'name', op: 'eq', value: 'Alpha' });
		state.setFilter({ field: 'price', op: 'eq', value: 0 });
		const view = setup('server', {}, cols, state);
		for (const label of ['name', 'Price']) {
			const trigger = view.query.getByRole('button', { name: `${label}の絞り込み` });
			const description = expectApplied(trigger, `${label}の絞り込みを適用中`)!;
			expect(view.container.contains(description)).toBe(true);
			ids.push(description.id);
		}
	}
	expect(new Set(ids).size).toBe(4);
});
