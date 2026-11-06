/**
 * In-memory DataProvider for playground/tests/mocks (spec §3.2). Keeps one
 * mutable row array per resource. Re-implements the grid's filter/sort
 * semantics (spec §4.3) rather than importing @banto/grid-svelte, since
 * admin-core must stay UI-agnostic.
 */
import { notFound } from '../errors';
import type { DataProvider } from '../provider';
import type { FilterState, ListParams, ListResult, SortState } from '../types';

export interface InMemorySeed {
	rows: Record<string, unknown>[];
	/** Defaults to 'id'. */
	idField?: string;
}

export interface InMemoryDataProviderOptions {
	/** Simulated network latency in ms, so loading states are visible. Default 150. */
	latencyMs?: number;
}

function isNullish(value: unknown): boolean {
	return value === null || value === undefined;
}

/**
 * Must stay in sync with `packages/grid-svelte/src/core/filter.ts`'s
 * `toComparable` (KNOWN DRIFT, M5 fix: this was missing the `Date` branch).
 */
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
	if (isNullish(a) || isNullish(b)) return false;
	return String(a) === String(b);
}

function matchOne(row: Record<string, unknown>, filter: FilterState): boolean {
	const value = row[filter.field];
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

/** Apply all filters with AND semantics. */
function applyFilters(
	rows: Record<string, unknown>[],
	filters: FilterState[]
): Record<string, unknown>[] {
	if (filters.length === 0) return rows.slice();
	return rows.filter((row) => filters.every((filter) => matchOne(row, filter)));
}

/**
 * Must stay in sync with `packages/grid-svelte/src/core/sort.ts`'s
 * `compareNonNull` (KNOWN DRIFT, M5 fix: this was missing the `Date`
 * branch).
 */
function compareNonNull(a: unknown, b: unknown): number {
	if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
	return String(a).localeCompare(String(b));
}

function compareForSort(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	sort: SortState
): number {
	const va = a[sort.field];
	const vb = b[sort.field];
	const aNull = isNullish(va);
	const bNull = isNullish(vb);
	if (aNull && bNull) return 0;
	if (aNull) return 1;
	if (bNull) return -1;
	const base = compareNonNull(va, vb);
	return sort.direction === 'asc' ? base : -base;
}

/**
 * The table's columns: every field that is an own property of at least one
 * of its rows (a field present with a `null` value counts, like a SQL column
 * whose values are all NULL). Taken over the whole table, not the filtered
 * rows, so a filter never changes which sort keys count - the InMemory
 * counterpart of banto-storage's `ColumnMap` whitelist.
 */
function tableColumns(rows: Record<string, unknown>[]): Set<string> {
	const columns = new Set<string>();
	for (const row of rows) for (const field of Object.keys(row)) columns.add(field);
	return columns;
}

/**
 * Multi-column sort (priority = array order) with the list-order contract
 * shared with banto-storage's SQL and the grid's client sort (Issue #243,
 * conventions §6):
 *
 * - sort entries naming a field that is not one of the table's `columns`
 *   are skipped, **before** the tie-break direction is chosen (SQL skips
 *   fields missing from its `ColumnMap` the same way);
 * - ties are broken by the unique key `idField` in the direction of the
 *   last remaining sort key, and a list with no remaining sort key is
 *   ordered by `idField` ascending;
 * - NULLs sort last in both directions (`compareForSort`);
 * - the original index is the final tie-breaker, for rows whose key is
 *   missing or duplicated.
 *
 * Parity with SQL and the grid is pinned by `tests/listOrderParity.test.ts`
 * (shared fixture).
 */
function applySort(
	rows: Record<string, unknown>[],
	sort: SortState[],
	idField: string,
	columns: Set<string>
): Record<string, unknown>[] {
	const known = sort.filter((entry) => columns.has(entry.field));
	const last = known.at(-1)?.direction ?? 'asc';
	const keys: SortState[] = [...known, { field: idField, direction: last }];
	const indexed = rows.map((row, index) => ({ row, index }));
	indexed.sort((a, b) => {
		for (const entry of keys) {
			const result = compareForSort(a.row, b.row, entry);
			if (result !== 0) return result;
		}
		return a.index - b.index;
	});
	return indexed.map((entry) => entry.row);
}

function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an in-memory DataProvider seeded with one row array per resource.
 * `create` assigns the next numeric id (max existing + 1); `create`/`update`
 * stamp `updatedAt` with today's date (ISO) when the resource's rows carry
 * that field.
 */
export function createInMemoryDataProvider(
	seed: Record<string, InMemorySeed>,
	options: InMemoryDataProviderOptions = {}
): DataProvider {
	const latencyMs = options.latencyMs ?? 150;
	const tables = new Map<string, { rows: Record<string, unknown>[]; idField: string }>();
	for (const [resource, def] of Object.entries(seed)) {
		tables.set(resource, { rows: def.rows.slice(), idField: def.idField ?? 'id' });
	}

	function table(resource: string): { rows: Record<string, unknown>[]; idField: string } {
		let found = tables.get(resource);
		if (!found) {
			found = { rows: [], idField: 'id' };
			tables.set(resource, found);
		}
		return found;
	}

	async function delay(): Promise<void> {
		if (latencyMs > 0) await wait(latencyMs);
	}

	return {
		async getList<T>(resource: string, params: ListParams): Promise<ListResult<T>> {
			await delay();
			const { rows, idField } = table(resource);
			const filtered = applyFilters(rows, params.filters);
			const sorted = applySort(filtered, params.sort, idField, tableColumns(rows));
			const totalCount = sorted.length;
			const paged = params.pagination
				? sorted.slice(
						params.pagination.offset,
						params.pagination.limit !== undefined
							? params.pagination.offset + params.pagination.limit
							: undefined
					)
				: sorted;
			return { rows: paged as T[], totalCount };
		},

		async getOne<T>(resource: string, id: string | number): Promise<T> {
			await delay();
			const { rows, idField } = table(resource);
			const row = rows.find((entry) => looseEquals(entry[idField], id));
			if (!row) throw notFound(resource, id);
			return row as T;
		},

		async create<T>(resource: string, values: Record<string, unknown>): Promise<T> {
			await delay();
			const entry = table(resource);
			const maxId = entry.rows.reduce((max, row) => {
				const value = Number(row[entry.idField]);
				return Number.isFinite(value) && value > max ? value : max;
			}, 0);
			const hasUpdatedAt = 'updatedAt' in values || entry.rows.some((row) => 'updatedAt' in row);
			const row: Record<string, unknown> = { ...values, [entry.idField]: maxId + 1 };
			if (hasUpdatedAt) row.updatedAt = todayIso();
			entry.rows.push(row);
			return row as T;
		},

		async update<T>(
			resource: string,
			id: string | number,
			values: Record<string, unknown>
		): Promise<T> {
			await delay();
			const entry = table(resource);
			const index = entry.rows.findIndex((row) => looseEquals(row[entry.idField], id));
			if (index === -1) throw notFound(resource, id);
			const merged: Record<string, unknown> = { ...entry.rows[index], ...values };
			if ('updatedAt' in merged) merged.updatedAt = todayIso();
			entry.rows[index] = merged;
			return merged as T;
		},

		async deleteOne(resource: string, id: string | number): Promise<void> {
			await delay();
			const entry = table(resource);
			const index = entry.rows.findIndex((row) => looseEquals(row[entry.idField], id));
			if (index === -1) throw notFound(resource, id);
			entry.rows.splice(index, 1);
		}
	};
}
