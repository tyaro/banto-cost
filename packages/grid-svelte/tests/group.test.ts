import { describe, expect, it } from 'vitest';
import { buildGroupedView, type GroupEntry, type RowEntry } from '../src/core/group';
import type { GridColumn } from '../src/types';

interface Row {
	id: number;
	category: string | null;
	price: number;
	stock: number;
	label: string;
}

const columns: GridColumn<Row>[] = [
	{ id: 'id', header: 'ID', accessor: 'id' },
	{ id: 'category', header: 'Category', accessor: 'category' },
	{ id: 'price', header: 'Price', accessor: 'price', aggregate: 'avg' },
	{ id: 'stock', header: 'Stock', accessor: 'stock', aggregate: 'sum' },
	{ id: 'label', header: 'Label', accessor: 'label' }
];

const notCollapsed = () => false;

describe('buildGroupedView', () => {
	it('returns a plain RowEntry list (no groups) for an unknown groupBy column id', () => {
		const rows: Row[] = [
			{ id: 1, category: 'a', price: 10, stock: 1, label: 'x' },
			{ id: 2, category: 'b', price: 20, stock: 2, label: 'y' }
		];
		const result = buildGroupedView(rows, columns, 'nope', notCollapsed);
		expect(result).toEqual([
			{ kind: 'row', row: rows[0], absoluteIndex: 0 },
			{ kind: 'row', row: rows[1], absoluteIndex: 1 }
		]);
	});

	it('returns an empty array for empty input', () => {
		expect(buildGroupedView([], columns, 'category', notCollapsed)).toEqual([]);
	});

	it('groups rows in first-appearance order without re-sorting groups', () => {
		// Already "sorted" input where group b appears before group a.
		const rows: Row[] = [
			{ id: 1, category: 'b', price: 10, stock: 1, label: 'x' },
			{ id: 2, category: 'a', price: 20, stock: 2, label: 'y' },
			{ id: 3, category: 'b', price: 30, stock: 3, label: 'z' }
		];
		const result = buildGroupedView(rows, columns, 'category', notCollapsed);
		const groupKeys = result
			.filter((e): e is GroupEntry<Row> => e.kind === 'group')
			.map((e) => e.key);
		expect(groupKeys).toEqual(['b', 'a']); // b first (its first row appears first), not re-sorted alphabetically

		// b's group gathers BOTH of its rows even though they aren't contiguous in the input.
		const bGroupIndex = result.findIndex((e) => e.kind === 'group' && e.key === 'b');
		const bGroup = result[bGroupIndex] as GroupEntry<Row>;
		expect(bGroup.count).toBe(2);
	});

	it('lays out each group as one GroupEntry followed by its RowEntries', () => {
		const rows: Row[] = [
			{ id: 1, category: 'a', price: 10, stock: 1, label: 'x' },
			{ id: 2, category: 'a', price: 20, stock: 2, label: 'y' },
			{ id: 3, category: 'b', price: 30, stock: 3, label: 'z' }
		];
		const result = buildGroupedView(rows, columns, 'category', notCollapsed);
		expect(result.map((e) => e.kind)).toEqual(['group', 'row', 'row', 'group', 'row']);
		expect((result[0] as GroupEntry<Row>).key).toBe('a');
		expect((result[1] as RowEntry<Row>).row).toBe(rows[0]);
		expect((result[2] as RowEntry<Row>).row).toBe(rows[1]);
		expect((result[3] as GroupEntry<Row>).key).toBe('b');
		expect((result[4] as RowEntry<Row>).row).toBe(rows[2]);
	});

	it('preserves each row absoluteIndex as its position in the input array', () => {
		const rows: Row[] = [
			{ id: 1, category: 'b', price: 10, stock: 1, label: 'x' },
			{ id: 2, category: 'a', price: 20, stock: 2, label: 'y' },
			{ id: 3, category: 'b', price: 30, stock: 3, label: 'z' }
		];
		const result = buildGroupedView(rows, columns, 'category', notCollapsed);
		const rowEntries = result.filter((e): e is RowEntry<Row> => e.kind === 'row');
		expect(rowEntries.map((e) => e.absoluteIndex)).toEqual([0, 2, 1]); // b's rows (0, 2) then a's row (1)
	});

	it('groups null/undefined values under the "(なし)" label', () => {
		const rows: Row[] = [
			{ id: 1, category: null, price: 10, stock: 1, label: 'x' },
			{ id: 2, category: undefined as unknown as string, price: 20, stock: 2, label: 'y' }
		];
		const result = buildGroupedView(rows, columns, 'category', notCollapsed);
		const group = result[0] as GroupEntry<Row>;
		expect(group.key).toBe('(なし)');
		expect(group.count).toBe(2);
	});

	describe('collapse filtering', () => {
		it("omits a collapsed group's RowEntries but still reports its GroupEntry with the full count", () => {
			const rows: Row[] = [
				{ id: 1, category: 'a', price: 10, stock: 1, label: 'x' },
				{ id: 2, category: 'a', price: 20, stock: 2, label: 'y' },
				{ id: 3, category: 'b', price: 30, stock: 3, label: 'z' }
			];
			const result = buildGroupedView(rows, columns, 'category', (key) => key === 'a');
			expect(result.map((e) => e.kind)).toEqual(['group', 'group', 'row']);
			const aGroup = result[0] as GroupEntry<Row>;
			expect(aGroup.collapsed).toBe(true);
			expect(aGroup.count).toBe(2);
		});

		it('marks a non-collapsed group entry as collapsed: false', () => {
			const rows: Row[] = [{ id: 1, category: 'a', price: 10, stock: 1, label: 'x' }];
			const result = buildGroupedView(rows, columns, 'category', () => false);
			expect((result[0] as GroupEntry<Row>).collapsed).toBe(false);
		});
	});

	describe('aggregates', () => {
		const rows: Row[] = [
			{ id: 1, category: 'a', price: 10, stock: 100, label: 'x' },
			{ id: 2, category: 'a', price: 20, stock: 200, label: 'y' },
			{ id: 3, category: 'a', price: 30, stock: 300, label: 'z' }
		];

		it('computes sum', () => {
			const result = buildGroupedView(rows, columns, 'category', notCollapsed);
			expect((result[0] as GroupEntry<Row>).aggregates.stock).toBe('600');
		});

		it('computes avg, rounded to 2 decimals with trailing zeros trimmed', () => {
			const result = buildGroupedView(rows, columns, 'category', notCollapsed);
			expect((result[0] as GroupEntry<Row>).aggregates.price).toBe('20');
		});

		it('avg rounds to at most 2 decimals', () => {
			const oddRows: Row[] = [
				{ id: 1, category: 'a', price: 1, stock: 0, label: 'x' },
				{ id: 2, category: 'a', price: 2, stock: 0, label: 'y' },
				{ id: 3, category: 'a', price: 2, stock: 0, label: 'z' }
			];
			const result = buildGroupedView(oddRows, columns, 'category', notCollapsed);
			// (1+2+2)/3 = 1.6666... -> rounds to 1.67
			expect((result[0] as GroupEntry<Row>).aggregates.price).toBe('1.67');
		});

		it("computes count regardless of the column's own values", () => {
			const countColumns: GridColumn<Row>[] = [
				...columns,
				{ id: 'idCount', header: 'Count', accessor: 'id', aggregate: 'count' }
			];
			const result = buildGroupedView(rows, countColumns, 'category', notCollapsed);
			expect((result[0] as GroupEntry<Row>).aggregates.idCount).toBe('3');
		});

		it('skips non-numeric values (NaN) when computing sum/avg', () => {
			interface MixedRow {
				category: string;
				amount: unknown;
			}
			const mixedColumns: GridColumn<MixedRow>[] = [
				{ id: 'category', header: 'Category', accessor: 'category' },
				{ id: 'amount', header: 'Amount', accessor: 'amount', aggregate: 'sum' }
			];
			const mixedRows: MixedRow[] = [
				{ category: 'a', amount: 10 },
				{ category: 'a', amount: 'not-a-number' },
				{ category: 'a', amount: 20 }
			];
			const result = buildGroupedView(mixedRows, mixedColumns, 'category', notCollapsed);
			expect((result[0] as GroupEntry<MixedRow>).aggregates.amount).toBe('30');
		});

		it('avg over an all-NaN group returns "0" rather than NaN/Infinity', () => {
			interface MixedRow {
				category: string;
				amount: unknown;
			}
			const mixedColumns: GridColumn<MixedRow>[] = [
				{ id: 'category', header: 'Category', accessor: 'category' },
				{ id: 'amount', header: 'Amount', accessor: 'amount', aggregate: 'avg' }
			];
			const mixedRows: MixedRow[] = [{ category: 'a', amount: 'nope' }];
			const result = buildGroupedView(mixedRows, mixedColumns, 'category', notCollapsed);
			expect((result[0] as GroupEntry<MixedRow>).aggregates.amount).toBe('0');
		});

		it('formats large sums with toLocaleString grouping separators', () => {
			const bigRows: Row[] = [
				{ id: 1, category: 'a', price: 0, stock: 500_000, label: 'x' },
				{ id: 2, category: 'a', price: 0, stock: 500_000, label: 'y' }
			];
			const result = buildGroupedView(bigRows, columns, 'category', notCollapsed);
			expect((result[0] as GroupEntry<Row>).aggregates.stock).toBe((1_000_000).toLocaleString());
		});

		it('calls a custom aggregate function with raw values and rows, using its return value verbatim', () => {
			const customColumns: GridColumn<Row>[] = [
				...columns,
				{
					id: 'labels',
					header: 'Labels',
					accessor: 'label',
					aggregate: (values, groupRows) => `${values.join('+')} (${groupRows.length})`
				}
			];
			const result = buildGroupedView(rows, customColumns, 'category', notCollapsed);
			expect((result[0] as GroupEntry<Row>).aggregates.labels).toBe('x+y+z (3)');
		});

		it('omits aggregates for columns without an `aggregate` config', () => {
			const result = buildGroupedView(rows, columns, 'category', notCollapsed);
			expect((result[0] as GroupEntry<Row>).aggregates).not.toHaveProperty('label');
			expect((result[0] as GroupEntry<Row>).aggregates).not.toHaveProperty('id');
		});
	});
});
