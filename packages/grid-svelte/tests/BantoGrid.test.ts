// @vitest-environment jsdom
/**
 * BantoGrid component test (spec §4, improvement-plan P3-3): mount + basic
 * rendering only. Sort/filter/virtualization/clipboard logic is covered by
 * the headless core/* tests; here we prove the component mounts, renders
 * column headers and (virtualized) body cells with their `format`/`cell`
 * output, and shows the empty state.
 *
 * jsdom has no `ResizeObserver` and reports 0 for every element dimension,
 * which would leave the virtual window empty (no body rows) and throw on the
 * component's `new ResizeObserver(...)`. We stub both so a realistic viewport
 * height lets rows virtualize into view - the minimum needed to render, not a
 * real layout engine.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	// Give the scroll container a real height and the header row a small one,
	// so computeWindow() yields a non-empty visible window.
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get() {
			return 400;
		}
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get() {
			return 32;
		}
	});
});

afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	price: number;
}

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: '商品名', accessor: 'name' },
	{ id: 'price', header: '価格', accessor: 'price', align: 'right', format: (v) => `¥${v}` },
	{
		id: 'open',
		header: '操作',
		accessor: () => '',
		cell: (row) => ({ text: '開く', href: `/items/${row.id}` })
	}
];

const rows: Row[] = [
	{ id: 1, name: 'ペン', price: 100 },
	{ id: 2, name: 'ノート', price: 200 }
];

function renderGrid(data: (Row | undefined)[]) {
	return render(BantoGrid<Row>, {
		rows: data,
		columns,
		state: new GridState<Row>(columns),
		getRowId: (row: Row) => row.id
	});
}

describe('BantoGrid', () => {
	it('mounts as a grid with the right column count', () => {
		renderGrid(rows);
		const grid = screen.getByRole('grid');
		expect(grid.getAttribute('aria-colcount')).toBe('3');
	});

	it('renders every column header', () => {
		renderGrid(rows);
		expect(screen.getByText('商品名')).toBeTruthy();
		expect(screen.getByText('価格')).toBeTruthy();
		expect(screen.getByText('操作')).toBeTruthy();
	});

	it('renders body cell values, applying column.format', () => {
		renderGrid(rows);
		expect(screen.getByText('ペン')).toBeTruthy();
		expect(screen.getByText('ノート')).toBeTruthy();
		// `format: v => ¥${v}` is applied to the raw value, not the raw 100/200.
		expect(screen.getByText('¥100')).toBeTruthy();
		expect(screen.getByText('¥200')).toBeTruthy();
	});

	it('renders a cell link column as an anchor with the computed href', () => {
		renderGrid(rows);
		const links = screen.getAllByRole('link', { name: '開く' });
		expect(links).toHaveLength(2);
		expect(links[0].getAttribute('href')).toBe('/items/1');
		expect(links[1].getAttribute('href')).toBe('/items/2');
	});

	it('renders neither header nor cells for a hidden column (spec §4.4)', () => {
		const state = new GridState<Row>(columns);
		state.setColumnHidden('price', true);
		render(BantoGrid<Row>, {
			rows,
			columns,
			state,
			getRowId: (row: Row) => row.id
		});

		expect(screen.queryByText('価格')).toBeNull();
		expect(screen.queryByText('¥100')).toBeNull();
		// The remaining columns still render, and the count follows.
		expect(screen.getByText('商品名')).toBeTruthy();
		expect(screen.getByRole('grid').getAttribute('aria-colcount')).toBe('2');
	});

	it('drops a cell selection that pointed at a column being hidden (spec §4.4)', async () => {
		const state = new GridState<Row>(columns);
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			state,
			getRowId: (row: Row) => row.id
		});

		const priceCell = container.querySelector('[data-cell-field="price"]')!;
		await fireEvent.pointerDown(priceCell);
		expect(container.querySelector('.cell.active')).not.toBeNull();

		state.setColumnHidden('price', true);
		await tick();
		state.setColumnHidden('price', false);
		await tick();

		// Bringing the column back must NOT resurrect the old active cell: a
		// selection left pointing at a hidden field keeps copy/paste and
		// Enter/F2 acting on a field with no DOM node while it is away.
		expect(container.querySelector('.cell.active')).toBeNull();
	});

	it('falls back to single-click row open once every editable column is hidden', async () => {
		const editableColumns: GridColumn<Row>[] = [
			{ id: 'name', header: '商品名', accessor: 'name', editable: true },
			{ id: 'price', header: '価格', accessor: 'price' }
		];
		const state = new GridState<Row>(editableColumns);
		const opened: Row[] = [];
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns: editableColumns,
			state,
			getRowId: (row: Row) => row.id,
			onRowClick: (row: Row) => opened.push(row)
		});

		// While an editable column shows, single click is reserved for cell
		// selection (double click opens the row instead).
		await fireEvent.click(container.querySelector('[data-cell-field="price"]')!);
		expect(opened).toHaveLength(0);

		state.setColumnHidden('name', true);
		await tick();
		await fireEvent.click(container.querySelector('[data-cell-field="price"]')!);

		// The grid on screen is now read-only, so single click opens the row.
		expect(opened).toHaveLength(1);
	});

	it('shows the empty state when there are no rows', () => {
		renderGrid([]);
		expect(screen.getByText('データがありません')).toBeTruthy();
		// still a grid, just with only the header row.
		expect(within(screen.getByRole('grid')).queryByText('ペン')).toBeNull();
	});
});
