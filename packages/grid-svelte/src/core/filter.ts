/**
 * Pure per-column filtering logic for the grid's client mode (spec §4.3).
 * No Svelte imports — usable standalone and easy to unit test.
 */
import type { FilterState, GridColumn } from '../types';
import { getColumnValue } from './sort';

function isNullish(value: unknown): boolean {
	return value === null || value === undefined;
}

/** Coerce a value to a number for relational comparisons (lt/lte/gt/gte). */
function toComparable(value: unknown): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number') return value;
	if (typeof value === 'string') {
		const asNumber = Number(value);
		if (value.trim() !== '' && !Number.isNaN(asNumber)) return asNumber;
		const asDate = Date.parse(value);
		if (!Number.isNaN(asDate)) return asDate;
	}
	return NaN;
}

function looseEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	// Allow number/string operand mismatch (e.g. filter UI stores "5" while row has 5).
	if (isNullish(a) || isNullish(b)) return false;
	return String(a) === String(b);
}

function matchOne<TRow>(
	row: TRow,
	filter: FilterState,
	column: GridColumn<TRow> | undefined
): boolean {
	const value = column
		? getColumnValue(row, column)
		: (row as Record<string, unknown>)[filter.field];

	switch (filter.op) {
		case 'eq':
			return looseEquals(value, filter.value);
		case 'ne':
			return !looseEquals(value, filter.value);
		case 'lt':
			return toComparable(value) < toComparable(filter.value);
		case 'lte':
			return toComparable(value) <= toComparable(filter.value);
		case 'gt':
			return toComparable(value) > toComparable(filter.value);
		case 'gte':
			return toComparable(value) >= toComparable(filter.value);
		case 'contains':
			return String(value ?? '')
				.toLowerCase()
				.includes(String(filter.value ?? '').toLowerCase());
		case 'starts_with':
			return String(value ?? '')
				.toLowerCase()
				.startsWith(String(filter.value ?? '').toLowerCase());
		case 'in':
			return Array.isArray(filter.value) && filter.value.some((entry) => looseEquals(value, entry));
		case 'is_null':
			return isNullish(value);
		case 'not_null':
			return !isNullish(value);
		default:
			return true;
	}
}

/** Apply all filters with AND semantics. Returns a new array. */
export function filterRows<TRow>(
	rows: TRow[],
	filters: FilterState[],
	columns: GridColumn<TRow>[]
): TRow[] {
	if (filters.length === 0) return rows.slice();
	const columnMap = new Map(columns.map((column) => [column.id, column]));
	return rows.filter((row) =>
		filters.every((filter) => matchOne(row, filter, columnMap.get(filter.field)))
	);
}
