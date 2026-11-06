import { describe, expect, it } from 'vitest';
import { sortRows } from '../src/core/sort';
import type { GridColumn } from '../src/types';

interface Row {
	id: number;
	name: string | null;
	amount: number | null;
	createdAt: Date | null;
}

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name' },
	{ id: 'amount', header: 'Amount', accessor: 'amount' },
	{ id: 'createdAt', header: 'Created', accessor: 'createdAt' }
];

describe('sortRows', () => {
	it('returns a new array and does not mutate the input when there is no sort', () => {
		const rows: Row[] = [{ id: 1, name: 'b', amount: 1, createdAt: null }];
		const result = sortRows(rows, [], columns);
		expect(result).not.toBe(rows);
		expect(result).toEqual(rows);
	});

	it('sorts numbers ascending/descending', () => {
		const rows: Row[] = [
			{ id: 1, name: 'a', amount: 3, createdAt: null },
			{ id: 2, name: 'b', amount: 1, createdAt: null },
			{ id: 3, name: 'c', amount: 2, createdAt: null }
		];
		const asc = sortRows(rows, [{ field: 'amount', direction: 'asc' }], columns);
		expect(asc.map((r) => r.amount)).toEqual([1, 2, 3]);

		const desc = sortRows(rows, [{ field: 'amount', direction: 'desc' }], columns);
		expect(desc.map((r) => r.amount)).toEqual([3, 2, 1]);
	});

	it('sorts strings via localeCompare', () => {
		const rows: Row[] = [
			{ id: 1, name: 'banana', amount: 0, createdAt: null },
			{ id: 2, name: 'Apple', amount: 0, createdAt: null },
			{ id: 3, name: 'cherry', amount: 0, createdAt: null }
		];
		const asc = sortRows(rows, [{ field: 'name', direction: 'asc' }], columns);
		expect(asc.map((r) => r.name)).toEqual(['Apple', 'banana', 'cherry']);
	});

	it('sorts dates by time', () => {
		const rows: Row[] = [
			{ id: 1, name: 'a', amount: 0, createdAt: new Date('2026-01-02') },
			{ id: 2, name: 'b', amount: 0, createdAt: new Date('2026-01-01') }
		];
		const asc = sortRows(rows, [{ field: 'createdAt', direction: 'asc' }], columns);
		expect(asc.map((r) => r.id)).toEqual([2, 1]);
	});

	it('keeps null/undefined values last regardless of direction', () => {
		const rows: Row[] = [
			{ id: 1, name: 'a', amount: 5, createdAt: null },
			{ id: 2, name: 'b', amount: null, createdAt: null },
			{ id: 3, name: 'c', amount: 1, createdAt: null }
		];
		const asc = sortRows(rows, [{ field: 'amount', direction: 'asc' }], columns);
		expect(asc.map((r) => r.id)).toEqual([3, 1, 2]);

		const desc = sortRows(rows, [{ field: 'amount', direction: 'desc' }], columns);
		expect(desc.map((r) => r.id)).toEqual([1, 3, 2]);
	});

	it('is stable: equal keys preserve original relative order', () => {
		const rows: Row[] = [
			{ id: 1, name: 'x', amount: 1, createdAt: null },
			{ id: 2, name: 'y', amount: 1, createdAt: null },
			{ id: 3, name: 'z', amount: 1, createdAt: null }
		];
		const result = sortRows(rows, [{ field: 'amount', direction: 'asc' }], columns);
		expect(result.map((r) => r.id)).toEqual([1, 2, 3]);
	});

	it('supports multi-key sort priority', () => {
		const rows: Row[] = [
			{ id: 1, name: 'b', amount: 1, createdAt: null },
			{ id: 2, name: 'a', amount: 2, createdAt: null },
			{ id: 3, name: 'a', amount: 1, createdAt: null },
			{ id: 4, name: 'b', amount: 2, createdAt: null }
		];
		// Primary: name asc, secondary: amount desc
		const result = sortRows(
			rows,
			[
				{ field: 'name', direction: 'asc' },
				{ field: 'amount', direction: 'desc' }
			],
			columns
		);
		expect(result.map((r) => r.id)).toEqual([2, 3, 4, 1]);
	});

	it('uses a custom comparator when provided', () => {
		const customColumns: GridColumn<Row>[] = [
			{
				id: 'name',
				header: 'Name',
				accessor: 'name',
				// Reverse alphabetical regardless of direction sign flip below.
				comparator: (a, b) => String(b).localeCompare(String(a))
			}
		];
		const rows: Row[] = [
			{ id: 1, name: 'a', amount: 0, createdAt: null },
			{ id: 2, name: 'b', amount: 0, createdAt: null }
		];
		const result = sortRows(rows, [{ field: 'name', direction: 'asc' }], customColumns);
		expect(result.map((r) => r.name)).toEqual(['b', 'a']);
	});
});
