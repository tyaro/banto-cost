// @vitest-environment jsdom
/**
 * ColumnsMenu (spec §4.4 column manager) interaction test.
 *
 * Covers the three things the component owns on top of `GridState`: the
 * open/dismiss model (same Escape + outside-pointerdown contract as
 * FilterPopover - see that file's doc on why there is no focus trap), the
 * checkbox <-> `hidden` wiring, and the last-visible-column lock that makes
 * `setColumnHidden`'s refusal visible instead of a dead click.
 *
 * Outside/inside pointer-down cases dispatch a plain `Event('pointerdown')`
 * (jsdom provides no `PointerEvent` constructor); the component only reads
 * `event.target`, so a generic bubbling event exercises the same listener.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ColumnsMenu from '../src/ColumnsMenu.svelte';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	price: number;
}

const columns: GridColumn<Row>[] = [
	{ id: 'id', header: 'ID', accessor: 'id' },
	{ id: 'name', header: '商品名', accessor: 'name' },
	{ id: 'price', header: '価格', accessor: 'price' }
];

function renderMenu(state = new GridState<Row>(columns)) {
	render(ColumnsMenu<Row>, { state });
	return state;
}

function openMenu(): void {
	fireEvent.click(screen.getByRole('button', { name: /列/ }));
}

function pointerDown(target: EventTarget) {
	target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

describe('ColumnsMenu', () => {
	it('opens a labelled dialog with one checkbox per column', async () => {
		const state = renderMenu();
		state.setColumnHidden('id', true);
		openMenu();

		expect(await screen.findByRole('dialog', { name: '列の表示' })).toBeTruthy();
		const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
		expect(boxes).toHaveLength(3);
		// Hidden column reads as unchecked, visible ones as checked.
		expect(boxes.map((box) => box.checked)).toEqual([false, true, true]);
	});

	it('shows the visible/total count on the trigger', async () => {
		const state = renderMenu();
		expect(screen.getByRole('button', { name: /列/ }).textContent).toContain('3/3');

		state.setColumnHidden('id', true);
		expect((await screen.findByRole('button', { name: /列/ })).textContent).toContain('2/3');
	});

	it('unchecking a column hides it in the shared GridState', async () => {
		const state = renderMenu();
		openMenu();

		await fireEvent.click(screen.getByRole('checkbox', { name: '商品名' }));

		expect(state.isHidden('name')).toBe(true);
		expect(state.orderedColumns.map((column) => column.id)).toEqual(['id', 'price']);
	});

	it('re-checking a hidden column brings it back', async () => {
		const state = renderMenu();
		state.setColumnHidden('name', true);
		openMenu();

		await fireEvent.click(await screen.findByRole('checkbox', { name: '商品名' }));

		expect(state.isHidden('name')).toBe(false);
	});

	it('locks the last visible column instead of offering a dead click', async () => {
		const state = renderMenu();
		state.setColumnHidden('id', true);
		state.setColumnHidden('name', true);
		openMenu();

		const last = (await screen.findByRole('checkbox', { name: '価格' })) as HTMLInputElement;
		expect(last.disabled).toBe(true);
		expect(state.orderedColumns).toHaveLength(1);
	});

	it('closes on Escape', async () => {
		renderMenu();
		openMenu();
		expect(await screen.findByRole('dialog')).toBeTruthy();

		await fireEvent.keyDown(window, { key: 'Escape' });

		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('closes on a pointer-down outside, but not inside', async () => {
		renderMenu();
		openMenu();
		const dialog = await screen.findByRole('dialog');

		pointerDown(dialog);
		expect(screen.queryByRole('dialog')).not.toBeNull();

		pointerDown(document.body);
		await Promise.resolve();
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});
