/**
 * List-order contract parity (Issue #243 review): the grid's client sort
 * breaks ties like banto-storage's SQL and the InMemory provider - by the
 * row's `id` in the direction of the last sort key, NULLs last. Shared
 * fixture: `crates/banto-storage/testdata/list-order-parity.json`.
 *
 * An empty sort is the one intended difference: client mode keeps the order
 * of the `rows` it was given (the data source already returns unsorted lists
 * by `id` ascending), so a host can show a deliberately ordered array.
 */
import { describe, expect, it } from 'vitest';
import parityFixture from '../../../crates/banto-storage/testdata/list-order-parity.json';
import { sortRows } from '../src/core/sort';
import type { GridColumn, SortState } from '../src/types';

interface ParityRow {
	id: number;
	grp: number;
	score: number | null;
}

const fixture = parityFixture as {
	rows: ParityRow[];
	cases: { sort: SortState[]; expectedIds: number[] }[];
};

const columns: GridColumn<ParityRow>[] = [
	{ id: 'id', header: 'ID', accessor: 'id' },
	{ id: 'grp', header: 'Group', accessor: 'grp' },
	{ id: 'score', header: 'Score', accessor: 'score' }
];

describe('grid client sort matches the shared SQL contract', () => {
	for (const { sort, expectedIds } of fixture.cases) {
		if (sort.length === 0) continue; // see the doc comment above
		const label = sort.map((s) => `${s.field} ${s.direction}`).join(', ');
		it(`orders ${label}`, () => {
			const result = sortRows(fixture.rows, sort, columns);
			expect(result.map((row) => row.id)).toEqual(expectedIds);
		});
	}

	it('keeps the given order when unsorted', () => {
		const result = sortRows(fixture.rows, [], columns);
		expect(result.map((row) => row.id)).toEqual(fixture.rows.map((row) => row.id));
	});

	it('falls back to getRowId for rows without an id field, then to the input order', () => {
		type Keyed = { key: string; v: number };
		const rows: Keyed[] = [
			{ key: 'b', v: 1 },
			{ key: 'c', v: 1 },
			{ key: 'a', v: 1 }
		];
		const cols: GridColumn<Keyed>[] = [{ id: 'v', header: 'V', accessor: 'v' }];
		const desc: SortState[] = [{ field: 'v', direction: 'desc' }];
		expect(sortRows(rows, desc, cols, (row) => row.key).map((r) => r.key)).toEqual(['c', 'b', 'a']);
		expect(sortRows(rows, desc, cols).map((r) => r.key)).toEqual(['b', 'c', 'a']);
	});
});
