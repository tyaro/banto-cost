import { describe, expect, it } from 'vitest';
import { filterRows } from '../src/core/filter';
import type { GridColumn } from '../src/types';

interface Row {
	id: number;
	name: string;
	amount: number | null;
	tags: string;
}

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name' },
	{ id: 'amount', header: 'Amount', accessor: 'amount' },
	{ id: 'tags', header: 'Tags', accessor: 'tags' }
];

const rows: Row[] = [
	{ id: 1, name: 'Green Tea', amount: 140, tags: 'drink' },
	{ id: 2, name: 'Roasted Tea', amount: 150, tags: 'drink' },
	{ id: 3, name: 'Coffee', amount: null, tags: 'drink' },
	{ id: 4, name: 'Water', amount: 100, tags: 'basic' }
];

describe('filterRows', () => {
	it('returns a new array when there are no filters', () => {
		const result = filterRows(rows, [], columns);
		expect(result).not.toBe(rows);
		expect(result).toEqual(rows);
	});

	it('eq / ne', () => {
		expect(
			filterRows(rows, [{ field: 'amount', op: 'eq', value: 150 }], columns).map((r) => r.id)
		).toEqual([2]);
		expect(
			filterRows(rows, [{ field: 'tags', op: 'ne', value: 'drink' }], columns).map((r) => r.id)
		).toEqual([4]);
	});

	it('lt / lte / gt / gte', () => {
		expect(
			filterRows(rows, [{ field: 'amount', op: 'lt', value: 140 }], columns).map((r) => r.id)
		).toEqual([4]);
		expect(
			filterRows(rows, [{ field: 'amount', op: 'lte', value: 140 }], columns).map((r) => r.id)
		).toEqual([1, 4]);
		expect(
			filterRows(rows, [{ field: 'amount', op: 'gt', value: 140 }], columns).map((r) => r.id)
		).toEqual([2]);
		expect(
			filterRows(rows, [{ field: 'amount', op: 'gte', value: 140 }], columns).map((r) => r.id)
		).toEqual([1, 2]);
	});

	it('contains is case-insensitive', () => {
		expect(
			filterRows(rows, [{ field: 'name', op: 'contains', value: 'TEA' }], columns).map((r) => r.id)
		).toEqual([1, 2]);
	});

	it('starts_with is case-insensitive', () => {
		expect(
			filterRows(rows, [{ field: 'name', op: 'starts_with', value: 'green' }], columns).map(
				(r) => r.id
			)
		).toEqual([1]);
	});

	it('in expects an array value', () => {
		expect(
			filterRows(rows, [{ field: 'id', op: 'in', value: [1, 3] }], columns).map((r) => r.id)
		).toEqual([1, 3]);
		// Non-array value never matches.
		expect(filterRows(rows, [{ field: 'id', op: 'in', value: 1 }], columns)).toEqual([]);
	});

	it('is_null / not_null', () => {
		expect(
			filterRows(rows, [{ field: 'amount', op: 'is_null', value: null }], columns).map((r) => r.id)
		).toEqual([3]);
		expect(
			filterRows(rows, [{ field: 'amount', op: 'not_null', value: null }], columns).map((r) => r.id)
		).toEqual([1, 2, 4]);
	});

	it('combines multiple filters with AND semantics', () => {
		const result = filterRows(
			rows,
			[
				{ field: 'tags', op: 'eq', value: 'drink' },
				{ field: 'amount', op: 'gte', value: 150 }
			],
			columns
		);
		expect(result.map((r) => r.id)).toEqual([2]);
	});
});
