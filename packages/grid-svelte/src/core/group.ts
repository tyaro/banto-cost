/**
 * Pure row-grouping logic for the grid's client mode (spec §4.3). No Svelte
 * imports — usable standalone and easy to unit test. Server mode does not
 * call into this at all (SQL GROUP BY integration is a later milestone);
 * BantoGrid enforces that (see BantoGrid.svelte's mode==='server' guard).
 */
import type { GridColumn } from '../types';
import { getColumnValue } from './sort';

/** Group key/label used when the group-by column's value is null/undefined. */
const EMPTY_GROUP_LABEL = '(なし)';

/**
 * One collapsible group header, standing in for all of its rows in the
 * flattened view. Takes the same `TRow` type parameter as `RowEntry` purely
 * to keep `FlatEntry<TRow>` symmetric across both union members - not used
 * in this interface's own body.
 */
export interface GroupEntry<_TRow> {
	kind: 'group';
	/** Stable identity for the group (also the string passed to `GridState.toggleGroup`). */
	key: string;
	/** Display label - currently identical to `key`. */
	label: string;
	/** Number of rows in this group (regardless of collapsed state). */
	count: number;
	/** column.id -> formatted aggregate value, one entry per column with `aggregate` set. */
	aggregates: Record<string, string>;
	collapsed: boolean;
}

/** One data row placed at its position in the flattened (possibly grouped) view. */
export interface RowEntry<TRow> {
	kind: 'row';
	row: TRow;
	/** This row's index in the `rows` array passed to `buildGroupedView` (i.e. its position in the already filtered+sorted, ungrouped list). */
	absoluteIndex: number;
}

export type FlatEntry<TRow> = GroupEntry<TRow> | RowEntry<TRow>;

/** Coerce a value to a finite number for sum/avg, or NaN when it can't be (skipped by the caller). */
function toAggregateNumber(value: unknown): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'string' && value.trim() !== '') return Number(value);
	return NaN;
}

/** Trim trailing zeros left over from `toFixed`-style rounding (e.g. "12.50" -> "12.5", "12.00" -> "12"). */
function formatRounded(value: number): string {
	const rounded = Math.round(value * 100) / 100;
	return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function computeAggregate<TRow>(column: GridColumn<TRow>, rows: TRow[]): string {
	const kind = column.aggregate;
	if (!kind) return '';

	if (typeof kind === 'function') {
		const values = rows.map((row) => getColumnValue(row, column));
		return kind(values, rows);
	}

	if (kind === 'count') return rows.length.toLocaleString();

	const numbers = rows
		.map((row) => toAggregateNumber(getColumnValue(row, column)))
		.filter((n) => !Number.isNaN(n));

	if (kind === 'sum') {
		const sum = numbers.reduce((total, n) => total + n, 0);
		return sum.toLocaleString();
	}

	// avg
	if (numbers.length === 0) return '0';
	const avg = numbers.reduce((total, n) => total + n, 0) / numbers.length;
	return formatRounded(avg);
}

/**
 * Flatten `rows` into group headers + rows for rendering under virtualization
 * (spec §4.3). `rows` must already be filtered+sorted - groups are NOT
 * re-sorted; a group's position in the output is determined by where its
 * first row appears in `rows`. An unknown `groupBy` column id degrades to a
 * plain (ungrouped) `RowEntry` list rather than throwing, since the caller
 * (BantoGrid) reacts to `GridState.groupBy` changes reactively and a
 * momentarily-stale id (e.g. mid-column-set-change) should never crash render.
 */
export function buildGroupedView<TRow>(
	rows: TRow[],
	columns: GridColumn<TRow>[],
	groupBy: string,
	collapsed: (key: string) => boolean,
	/**
	 * i18n layer 1 (docs/conventions.md §13): overridable label for the
	 * "null/undefined group value" bucket. Defaults to the current Japanese
	 * literal verbatim.
	 */
	emptyGroupLabel: string = EMPTY_GROUP_LABEL
): FlatEntry<TRow>[] {
	const groupColumn = columns.find((column) => column.id === groupBy);
	if (!groupColumn) {
		return rows.map((row, index) => ({ kind: 'row', row, absoluteIndex: index }));
	}

	// Bucket rows by group key while remembering each row's original index
	// and the order group keys first appear in (Map preserves insertion
	// order of its keys, which is exactly "first row's position").
	const keyOrder: string[] = [];
	const buckets = new Map<string, { row: TRow; index: number }[]>();
	rows.forEach((row, index) => {
		const raw = getColumnValue(row, groupColumn);
		const key = raw === null || raw === undefined ? emptyGroupLabel : String(raw);
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = [];
			buckets.set(key, bucket);
			keyOrder.push(key);
		}
		bucket.push({ row, index });
	});

	const aggregateColumns = columns.filter((column) => column.aggregate);
	const entries: FlatEntry<TRow>[] = [];

	for (const key of keyOrder) {
		const bucket = buckets.get(key)!;
		const bucketRows = bucket.map((entry) => entry.row);

		const aggregates: Record<string, string> = {};
		for (const column of aggregateColumns) {
			aggregates[column.id] = computeAggregate(column, bucketRows);
		}

		const isCollapsed = collapsed(key);
		entries.push({
			kind: 'group',
			key,
			label: key,
			count: bucket.length,
			aggregates,
			collapsed: isCollapsed
		});

		if (!isCollapsed) {
			for (const { row, index } of bucket) {
				entries.push({ kind: 'row', row, absoluteIndex: index });
			}
		}
	}

	return entries;
}
