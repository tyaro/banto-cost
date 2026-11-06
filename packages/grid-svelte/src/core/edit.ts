/**
 * Pure cell-edit commit decision logic (spec §4.5): given a column, its row,
 * and a candidate (already-parsed) value, decide whether the edit is a
 * no-op, fails `column.validate`, or should be committed. No Svelte imports
 * — usable standalone and easy to unit test. BantoGrid.svelte calls this for
 * both interactive edits (Enter/Tab/blur/checkbox-toggle) and range paste.
 */
import type { CellEdit, GridColumn } from '../types';
import { getColumnValue } from './sort';

export type PrepareCommitResult<TRow> =
	| { kind: 'noop' }
	| { kind: 'invalid'; message: string }
	| { kind: 'commit'; edit: CellEdit<TRow> };

/**
 * Whether `column` is currently editable for `row` (spec §4.5).
 *
 * A column with a `cell` renderer (the `cellRenderer` escape hatch, spec
 * §4.1 — typically an internal link like the items page's "open" column) is
 * never editable, regardless of `column.editable`: a link cell being
 * editable makes no sense, and BantoGrid's row-cell template checks
 * `column.cell` before edit state, so a column defining both would render
 * its link forever and its editor could never appear (pre-merge review
 * regression, deferred fix). Treating `cell` as editable-by-construction
 * `false` here is the single source of truth every edit entry point
 * (double-click, F2, Enter, paste, checkbox toggle, `startEditing`) goes
 * through, so none of them need their own `column.cell` check.
 */
export function isColumnEditable<TRow>(column: GridColumn<TRow>, row: TRow): boolean {
	if (column.cell) return false;
	return typeof column.editable === 'function' ? column.editable(row) : column.editable === true;
}

/**
 * `oldValue` is read from `row` via `column.accessor` (the row is not yet
 * mutated at commit time — the caller owns rows and applies the change,
 * typically after a round trip through the DataProvider).
 */
export function prepareCommit<TRow>(
	column: GridColumn<TRow>,
	row: TRow,
	rowId: string | number,
	draft: unknown
): PrepareCommitResult<TRow> {
	const oldValue = getColumnValue(row, column);
	if (draft === oldValue) return { kind: 'noop' };

	if (column.validate) {
		const message = column.validate(draft, row);
		if (message) return { kind: 'invalid', message };
	}

	return {
		kind: 'commit',
		edit: { row, rowId, field: column.id, value: draft, oldValue }
	};
}
