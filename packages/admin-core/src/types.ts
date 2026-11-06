/**
 * Wire types for @banto/admin-core.
 *
 * `SortState`/`FilterState` mirror both `@banto/grid-svelte`'s src/types.ts
 * and the Rust types in `crates/banto-core/src/params.rs` field-for-field,
 * so the same shapes flow client grid -> DataProvider -> (Phase B) Rust
 * without conversion. admin-core intentionally does NOT import from
 * grid-svelte (UI-agnostic core, spec §3) — keep these three definitions in
 * sync by hand.
 */

export type SortDirection = 'asc' | 'desc';

export interface SortState {
	field: string;
	direction: SortDirection;
}

export type FilterOp =
	| 'eq'
	| 'ne'
	| 'lt'
	| 'lte'
	| 'gt'
	| 'gte'
	| 'contains'
	| 'starts_with'
	| 'in'
	| 'is_null'
	| 'not_null';

export interface FilterState {
	field: string;
	op: FilterOp;
	value: unknown;
}

/** Offset-based pagination, mirrors `crates/banto-core/src/params.rs::Pagination`. */
export interface Pagination {
	offset: number;
	limit: number;
}

/** Parameters for `DataProvider.getList` (spec §3.2). */
export interface ListParams {
	pagination?: Pagination;
	sort: SortState[];
	filters: FilterState[];
}

/** Result envelope for `DataProvider.getList`. */
export interface ListResult<T> {
	rows: T[];
	totalCount: number;
}
