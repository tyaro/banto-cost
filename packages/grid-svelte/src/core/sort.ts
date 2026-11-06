/**
 * Pure sorting logic for the grid's client mode (spec §4.1, §4.3).
 * No Svelte imports — usable standalone and easy to unit test.
 */
import type { GridColumn, SortDirection, SortState } from '../types';

/** Extract a cell's raw value via the column's accessor. */
export function getColumnValue<TRow>(row: TRow, column: GridColumn<TRow>): unknown {
	return typeof column.accessor === 'function'
		? column.accessor(row)
		: (row[column.accessor] as unknown);
}

function isNullish(value: unknown): boolean {
	return value === null || value === undefined;
}

/** Compare two non-null values: numbers numerically, dates by time, strings via localeCompare. */
function compareNonNull(a: unknown, b: unknown): number {
	if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
	return String(a).localeCompare(String(b));
}

function compareForSort<TRow>(
	a: TRow,
	b: TRow,
	column: GridColumn<TRow>,
	direction: SortDirection
): number {
	const va = getColumnValue(a, column);
	const vb = getColumnValue(b, column);
	const aNull = isNullish(va);
	const bNull = isNullish(vb);
	// Nulls/undefined always sort last, regardless of direction.
	if (aNull && bNull) return 0;
	if (aNull) return 1;
	if (bNull) return -1;

	const base = column.comparator ? column.comparator(va, vb) : compareNonNull(va, vb);
	return direction === 'asc' ? base : -base;
}

/**
 * The row's unique key for tie-breaking: its `id` field (the same default as
 * banto-storage's `ColumnMap`, so client and server modes agree), else
 * `getRowId(row)` for rows without one, else none.
 */
function tieBreakKey<TRow>(row: TRow, getRowId?: (row: TRow) => unknown): unknown {
	if (row !== null && typeof row === 'object' && 'id' in row) {
		const id = (row as { id?: unknown }).id;
		if (!isNullish(id)) return id;
	}
	return getRowId ? getRowId(row) : undefined;
}

/**
 * Multi-column sort. Returns a new array; `rows` is not mutated. Sort
 * priority follows the order of entries in `sort`; entries naming an unknown
 * column are skipped.
 *
 * List-order contract (Issue #243, conventions §6), shared with
 * banto-storage's SQL and the InMemory provider: ties are broken by the
 * row's unique key (see `tieBreakKey`) in the direction of the last known
 * sort key; the original index is the final tie-breaker (rows without a key
 * or with duplicate keys keep their relative order). With no sort at all the
 * input order is kept - the data source already returns unsorted lists by
 * `id` ascending, and a host may pass a deliberately ordered array.
 */
export function sortRows<TRow>(
	rows: TRow[],
	sort: SortState[],
	columns: GridColumn<TRow>[],
	getRowId?: (row: TRow) => unknown
): TRow[] {
	if (sort.length === 0) return rows.slice();

	const columnMap = new Map(columns.map((column) => [column.id, column]));
	const known = sort.filter((entry) => columnMap.has(entry.field));
	const tieDirection: SortDirection = known.at(-1)?.direction ?? 'asc';
	const indexed = rows.map((row, index) => ({ row, index, key: tieBreakKey(row, getRowId) }));

	indexed.sort((a, b) => {
		for (const entry of known) {
			const column = columnMap.get(entry.field)!;
			const result = compareForSort(a.row, b.row, column, entry.direction);
			if (result !== 0) return result;
		}
		const aKey = isNullish(a.key);
		const bKey = isNullish(b.key);
		if (!aKey && !bKey) {
			const base = compareNonNull(a.key, b.key);
			if (base !== 0) return tieDirection === 'asc' ? base : -base;
		} else if (aKey !== bKey) {
			return aKey ? 1 : -1;
		}
		// Explicit index tie-breaker guarantees stability independent of the
		// host engine's Array#sort implementation.
		return a.index - b.index;
	});

	return indexed.map((entry) => entry.row);
}
