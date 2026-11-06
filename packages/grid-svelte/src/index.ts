/**
 * Public entry point for @banto/grid-svelte (spec §4).
 * M1 scope: client-mode data, row virtualization, multi-column sort,
 * per-column filters, column resize/reorder.
 * M3 (spec §4.5) adds cell navigation/range selection, inline editing with
 * built-in editors + validation, and TSV copy/paste.
 * M5 Phase A adds server mode (windowed loading). M5 Phase B (spec §4.3)
 * adds client-mode-only row grouping/collapsing/aggregates. Column
 * visibility (spec §4.4: `GridColumn.hidden`, `GridState.setColumnHidden`
 * and the `ColumnsMenu` manager UI) lands with issue #168. Still no
 * column pinning or row reordering (later milestones); grouping has no
 * server-mode equivalent yet (SQL GROUP BY integration is a later
 * milestone) - BantoGrid ignores `GridState.groupBy` when `mode==='server'`.
 */
export { default as BantoGrid } from './BantoGrid.svelte';
export { default as ColumnsMenu } from './ColumnsMenu.svelte';
export { GridState, DEFAULT_ROW_HEIGHT, type GridStateOptions } from './state.svelte';
export { CellSelection, type CellPos } from './selection.svelte';
export { defaultGridMessages, type GridMessages } from './messages';

export { sortRows, getColumnValue } from './core/sort';
export { filterRows } from './core/filter';
export { computeWindow, type ComputeWindowParams, type WindowResult } from './core/virtual';
export { rangeToTsv, parseTsv, parseCellInput } from './core/clipboard';
export { prepareCommit, type PrepareCommitResult } from './core/edit';
export { buildGroupedView, type GroupEntry, type RowEntry, type FlatEntry } from './core/group';
export {
	columnsFromSchema,
	type ColumnsSchema,
	type SchemaField,
	type SchemaFieldType,
	type ColumnsFromSchemaOptions,
	type ColumnValidationMessages
} from './core/schema';
export {
	toCsv,
	csvForExcel,
	csvFilename,
	parseCsv,
	mapCsvHeader,
	convertCsvRow,
	type CsvMapping,
	type CsvRowResult,
	type CsvConversionMessages
} from './core/csv';

export type {
	SortDirection,
	SortState,
	FilterOp,
	FilterState,
	FilterType,
	GridColumn,
	SerializedGridState,
	CellEditorType,
	CellEdit,
	CellRange,
	AggregateKind
} from './types';
export { DEFAULT_COLUMN_WIDTH, DEFAULT_MIN_WIDTH } from './types';
