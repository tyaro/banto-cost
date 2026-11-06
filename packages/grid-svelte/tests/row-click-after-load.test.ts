// @vitest-environment jsdom
/**
 * Issue #236: a row click made right after a page loads must reach
 * `onRowClick` (spec §4.5 single-click row activation).
 *
 * The lost click came from `handleCellPointerDown` focusing the grid
 * container with a plain `focus()`. That scrolls every scrolling ancestor
 * to bring the container into view, so a grid that sits partly below the
 * fold (typical while a freshly loaded page is still settling) moves under
 * the pointer between pointerdown and pointerup. The browser then fires
 * `click` on the common ancestor of the press and release targets - the grid,
 * not the cell - and the cell's click handler never runs, although the cell
 * was already selected on pointerdown.
 *
 * jsdom has no layout, so this file reproduces the browser's side of that
 * contract explicitly: focusing the grid container WITHOUT `preventScroll`
 * marks the page as scrolled (the grid is partly below the fold in every test
 * here), and `release()` then sends `pointerup`/`click` where a browser would:
 * to the cell when nothing moved, to the grid when the page scrolled. Rows are
 * replaced with fresh objects between press and release, as a page's second
 * load does while the user clicks.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import type { GridColumn } from '../src/types';

interface Row {
	id: number;
	name: string;
	host: string;
}

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name' },
	{ id: 'host', header: 'Host', accessor: 'host' }
];

function load(): Row[] {
	return [
		{ id: 1, name: 'Alpha', host: '10.0.0.1' },
		{ id: 2, name: 'Beta', host: '10.0.0.2' },
		{ id: 3, name: 'Gamma', host: '10.0.0.3' }
	];
}

let pageScrolled = false;
const nativeFocus = HTMLElement.prototype.focus;

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

beforeEach(() => {
	pageScrolled = false;
	// The browser behavior jsdom lacks: bringing a partly hidden grid into
	// view unless the caller opted out with `preventScroll`.
	vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
		this: HTMLElement,
		options?: FocusOptions
	) {
		if (this.getAttribute('role') === 'grid' && !options?.preventScroll) pageScrolled = true;
		nativeFocus.call(this, options);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	cleanup();
});

/** Releases the pointer where a browser would dispatch pointerup/click (see file comment). */
async function release(cell: HTMLElement, grid: HTMLElement) {
	const target = pageScrolled ? grid : cell;
	await fireEvent.pointerUp(target, { button: 0, pointerId: 1 });
	await fireEvent.click(target);
}

describe('BantoGrid row click right after load (#236)', () => {
	it('calls onRowClick for a click made while the rows are replaced by a reload', async () => {
		const opened: Row[] = [];
		// Initial render before the first load has answered.
		const { container, rerender } = render(BantoGrid<Row>, {
			rows: [] as Row[],
			columns,
			getRowId: (row: Row) => row.id,
			onRowClick: (row: Row) => opened.push(row)
		});
		// First load arrives and draws the rows.
		await rerender({ rows: load() });
		const grid = screen.getByRole('grid');
		const cell = container.querySelector<HTMLElement>(
			'[data-cell-row="1"][data-cell-field="name"]'
		)!;

		await fireEvent.pointerDown(cell, { button: 0, pointerId: 1 });
		// A second load replaces every row object while the button is down.
		const reloaded = load();
		await rerender({ rows: reloaded });
		// The keyed row survives the swap, so the press and release target
		// the same node - a replaced node would lose the click as well.
		expect(cell.isConnected).toBe(true);
		await release(cell, grid);

		expect(opened).toEqual([reloaded[1]]);
		expect(opened[0]).toBe(reloaded[1]);
		// The pointerdown still selects the cell and moves focus to the grid,
		// without scrolling the page out from under the pointer.
		expect(cell.classList.contains('active')).toBe(true);
		expect(document.activeElement).toBe(grid);
		expect(pageScrolled).toBe(false);
	});

	it('calls onRowClick for a click right after the first load', async () => {
		const opened: Row[] = [];
		const rows = load();
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId: (row: Row) => row.id,
			onRowClick: (row: Row) => opened.push(row)
		});
		const grid = screen.getByRole('grid');
		const cell = container.querySelector<HTMLElement>(
			'[data-cell-row="2"][data-cell-field="host"]'
		)!;

		await fireEvent.pointerDown(cell, { button: 0, pointerId: 1 });
		await release(cell, grid);

		expect(opened).toEqual([rows[2]]);
		expect(pageScrolled).toBe(false);
	});
});
