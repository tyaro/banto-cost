// @vitest-environment jsdom
/** Reading a failed edit must not retry its save or take another session's focus. */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import type { CellEdit, GridColumn } from '../src/types';

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
afterEach(cleanup);
interface Row {
	id: number;
	name: string;
}
const rows: Row[] = [
	{ id: 1, name: 'Alpha' },
	{ id: 2, name: 'Beta' }
];
function deferred() {
	let reject!: (reason: Error) => void;
	const promise = new Promise<void>((_, no) => {
		reject = no;
	});
	return { promise, reject };
}
function setup(
	mode: 'client' | 'server',
	save?: (edit: CellEdit<Row>) => void | Promise<void>,
	validate?: GridColumn<Row>['validate']
) {
	const onCellEdit = vi.fn(save ?? (() => {}));
	const columns: GridColumn<Row>[] = [
		{ id: 'name', header: 'Name', accessor: 'name', editable: true, validate }
	];
	const view = render(BantoGrid<Row>, {
		rows,
		columns,
		mode,
		totalRows: rows.length,
		getRowId: (row: Row) => row.id,
		onCellEdit
	});
	return { ...view, onCellEdit, query: within(view.container) };
}
async function open(view: ReturnType<typeof setup>, rowIndex = 0) {
	await fireEvent.doubleClick(view.container.querySelector(`[data-cell-row="${rowIndex}"]`)!);
	const editor = view.query.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
	editor.focus();
	await fireEvent.input(editor, { target: { value: 'Draft' } });
	return editor;
}
async function regionFocused(view: ReturnType<typeof setup>) {
	const region = await view.query.findByRole('region', { name: 'Nameのエラー' });
	await waitFor(() => expect(document.activeElement).toBe(region));
	return region;
}

describe.each(['client', 'server'] as const)('%s edit error reader', (mode) => {
	it('keeps Enter errors on the same editor; Tab reads without retrying, even after draft changes', async () => {
		const save = vi.fn().mockRejectedValue(new Error('Failed save'));
		const view = setup(mode, save);
		const editor = await open(view);
		const grid = view.query.getByRole('grid');
		const selected = view.container.querySelector('.cell.active');
		grid.scrollTop = 20;
		grid.scrollLeft = 7;
		const beforeHeight = grid.clientHeight;
		await fireEvent.keyDown(editor, { key: 'Enter' });
		const alert = await view.query.findByRole('alert');
		expect(document.activeElement).toBe(editor);
		expect(document.getElementById(editor.getAttribute('aria-describedby')!)).toBe(alert);
		await fireEvent.input(editor, { target: { value: 'Corrected draft' } });
		await fireEvent.keyDown(editor, { key: 'Tab' });
		const region = await regionFocused(view);
		expect(save).toHaveBeenCalledTimes(1);
		expect(region.parentElement).toBe(grid.parentElement);
		expect(region.previousElementSibling).toBe(grid);
		expect(grid.contains(alert)).toBe(false);
		expect(view.query.getByRole('textbox')).toBe(editor);
		expect(editor.value).toBe('Corrected draft');
		expect(view.container.querySelector('.cell.active')).toBe(selected);
		expect([grid.clientHeight, grid.scrollTop, grid.scrollLeft]).toEqual([beforeHeight, 20, 7]);
		for (const key of ['Escape', 'Tab']) {
			await fireEvent.keyDown(region, { key, shiftKey: key === 'Tab' });
			expect(document.activeElement).toBe(editor);
			expect(save).toHaveBeenCalledTimes(1);
			await fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true });
			await regionFocused(view);
		}
		for (const key of ['Tab', 'ArrowDown', 'PageDown', 'PageUp']) {
			const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
			await fireEvent(region, event);
			expect(event.defaultPrevented).toBe(false);
		}
		await fireEvent.keyDown(region, { key: 'Escape' });
		await fireEvent.keyDown(editor, { key: 'Enter' });
		await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
	});

	it('focuses a new Tab validation error without changing the editor or submitting', async () => {
		const view = setup(mode, undefined, () => 'Invalid draft');
		const editor = await open(view);
		await fireEvent.keyDown(editor, { key: 'Tab' });
		await regionFocused(view);
		expect(view.query.getByRole('textbox')).toBe(editor);
		expect(view.onCellEdit).not.toHaveBeenCalled();
	});

	it('moves a failed Tab save to the reader without submitting again on blur', async () => {
		const save = deferred();
		const view = setup(mode, () => save.promise);
		await fireEvent.keyDown(await open(view), { key: 'Tab' });
		save.reject(new Error('Delayed failure'));
		await save.promise.catch(() => {});
		await regionFocused(view);
		expect(view.onCellEdit).toHaveBeenCalledTimes(1);
	});

	it.each(['outside', 'new session', 'window blur'] as const)(
		'does not steal focus after a Tab save loses ownership to %s',
		async (departure) => {
			const save = deferred();
			const view = setup(mode, () => save.promise);
			await fireEvent.keyDown(await open(view), { key: 'Tab' });
			let target: HTMLElement;
			if (departure === 'new session') target = await open(view, 1);
			else if (departure === 'window blur') {
				target = view.query.getByRole('textbox');
				window.dispatchEvent(new Event('blur'));
			} else {
				target = document.createElement('button');
				view.container.appendChild(target);
				target.focus();
			}
			save.reject(new Error('Old failure'));
			await save.promise.catch(() => {});
			await tick();
			await tick();
			expect(document.activeElement).toBe(target);
			expect(view.onCellEdit).toHaveBeenCalledTimes(1);
			if (departure === 'new session') expect(view.query.queryByRole('region')).toBeNull();
		}
	);

	it('removes the reader when its edited row disappears without saving or taking focus', async () => {
		const view = setup(mode, undefined, () => 'Invalid');
		await fireEvent.keyDown(await open(view), { key: 'Tab' });
		await regionFocused(view);
		const outside = document.createElement('button');
		view.container.appendChild(outside);
		outside.focus();
		await view.rerender({ rows: [rows[1]] });
		expect(view.query.queryByRole('region')).toBeNull();
		expect(view.query.queryByRole('alert')).toBeNull();
		expect(document.activeElement).toBe(outside);
		expect(view.onCellEdit).not.toHaveBeenCalled();
	});

	it('does not reclaim focus during the error-render wait', async () => {
		const view = setup(mode, undefined, () => 'Invalid');
		const editor = await open(view);
		const outside = document.createElement('button');
		view.container.appendChild(outside);
		editor.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
		);
		outside.focus();
		await tick();
		await tick();
		expect(document.activeElement).toBe(outside);
		expect(view.onCellEdit).not.toHaveBeenCalled();
	});

	it('respects IME/handled keys in the reader and discards it when the edit ends', async () => {
		const view = setup(mode, undefined, () => 'Invalid');
		const editor = await open(view);
		await fireEvent.keyDown(editor, { key: 'Tab' });
		const region = await regionFocused(view);
		for (const key of ['Escape', 'Tab'])
			for (const owner of ['composition', 'legacy', 'handled']) {
				const event = new KeyboardEvent('keydown', {
					key,
					shiftKey: true,
					isComposing: owner === 'composition',
					keyCode: owner === 'legacy' ? 229 : 0,
					bubbles: true,
					cancelable: true
				});
				if (owner === 'handled') event.preventDefault();
				await fireEvent(region, event);
				expect(event.defaultPrevented).toBe(owner === 'handled');
				expect(document.activeElement).toBe(region);
			}
		await fireEvent.keyDown(region, { key: 'Escape' });
		await fireEvent.keyDown(editor, { key: 'Escape' });
		expect(view.query.queryByRole('region')).toBeNull();
		expect(view.query.queryByRole('alert')).toBeNull();
		expect(view.onCellEdit).not.toHaveBeenCalled();
	});
});

it('keeps two grids error descriptions and readers independent', async () => {
	const views = [
		setup('client', undefined, () => 'First'),
		setup('client', undefined, () => 'Second')
	];
	const ids: string[] = [];
	for (const view of views) {
		const editor = await open(view);
		await fireEvent.keyDown(editor, { key: 'Tab' });
		const region = await regionFocused(view);
		const alert = within(region).getByRole('alert');
		ids.push(alert.id);
		expect(editor.getAttribute('aria-describedby')).toBe(alert.id);
	}
	expect(new Set(ids).size).toBe(2);
});

it('hides an offscreen anchor and restores the same region without reclaiming focus', async () => {
	const view = setup('client', undefined, () => 'Long error');
	const editor = await open(view);
	await fireEvent.keyDown(editor, { key: 'Tab' });
	const region = await regionFocused(view);
	const alert = within(region).getByRole('alert');
	const grid = view.query.getByRole('grid');
	const frame = grid.parentElement!;
	Object.defineProperties(frame, {
		offsetWidth: { value: 300 },
		offsetHeight: { value: 200 },
		getBoundingClientRect: { value: () => new DOMRect(0, 0, 300, 200) }
	});
	Object.defineProperties(grid, {
		clientWidth: { value: 300 },
		clientHeight: { value: 200 },
		getBoundingClientRect: { value: () => new DOMRect(0, 0, 300, 200) }
	});
	let anchorLeft = 400;
	let anchorTop = 60;
	Object.defineProperty(editor, 'getBoundingClientRect', {
		value: () => new DOMRect(anchorLeft, anchorTop, 100, 30)
	});
	const outside = document.createElement('button');
	view.container.appendChild(outside);
	outside.focus();
	await fireEvent.scroll(grid);
	expect(region.hidden).toBe(true);
	anchorLeft = 20;
	await fireEvent.scroll(grid);
	expect(region.hidden).toBe(false);
	expect(within(region).getByRole('alert')).toBe(alert);
	expect(document.activeElement).toBe(outside);
	expect(view.onCellEdit).not.toHaveBeenCalled();
	const previousTop = region.style.top;
	anchorTop = 110;
	await view.rerender({ rows: [rows[1], rows[0]] });
	await tick();
	expect(view.query.getByRole('textbox')).toBe(editor);
	expect(region.style.top).not.toBe(previousTop);
	expect(within(region).getByRole('alert')).toBe(alert);
	expect(document.activeElement).toBe(outside);
});
