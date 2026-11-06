/**
 * Pure CSV (RFC 4180) export/import helpers for the grid (spec §M15). Builds
 * on `core/clipboard.ts`'s per-cell type conversion (`parseCellInput`,
 * `resolveSelectValue`) rather than duplicating it — CSV cells and pasted
 * TSV cells go through the same editor-aware parsing rules. No Svelte
 * imports — usable standalone and easy to unit test.
 */
import type { CellEditorType, GridColumn } from '../types';
import { parseCellInput, resolveSelectValue } from './clipboard';
import { getColumnValue } from './sort';

const BOM = '﻿';

/**
 * Quote a CSV field per RFC 4180 when it contains a comma, double quote, or
 * line break (CR/LF), doubling any internal `"`. A raw tab is left
 * unquoted — it's ordinary field data in CSV (unlike TSV, where it's the
 * delimiter), so no escaping is needed for `parseCsv` to round-trip it.
 */
function escapeCsvField(raw: string): string {
	if (/[",\r\n]/.test(raw)) {
		return `"${raw.replace(/"/g, '""')}"`;
	}
	return raw;
}

/**
 * Characters that make a spreadsheet treat a text cell as a formula (OWASP
 * "CSV Injection"): `=` `+` `-` `@`, TAB, CR, LF, and the full-width
 * `＝` `＋` `－` `＠` (U+FF1D / FF0B / FF0D / FF20, which Japanese-locale
 * Excel can also treat as a formula start).
 */
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;

/** Prefix a leading `'` when `text` could be read as a formula. */
function neutralizeFormula(text: string): string {
	return FORMULA_START.test(text) ? `'${text}` : text;
}

/**
 * Serialize `rows` to RFC 4180 CSV using each column's RAW value (via
 * `getColumnValue`), never `column.format` — same rationale as
 * `rangeToTsv`: formatted display strings (e.g. "¥1,200") are lossy to
 * re-parse and would break re-import round-trip fidelity. Rows are
 * separated by CRLF (Excel-compatible); `headers` (default `true`) emits
 * `column.id` values as the first line.
 *
 * `formulaSafe` (default `false`) is the opt-in spreadsheet-safe mode for
 * files meant to be opened in Excel. Only values that are JavaScript
 * *strings* and begin with `=` `+` `-` `@`, TAB, CR, LF, or the full-width
 * `＝` `＋` `－` `＠` get a leading `'` (applied before RFC 4180 quoting).
 * Numbers (including negatives such as -5), booleans, null and undefined are
 * never changed. Headers (developer-defined `column.id`) are not changed.
 * Caveats: the output is NOT the raw value any more, so `parseCsv` re-import
 * keeps the leading `'` (strip it on import if wanted); and it is a
 * mitigation for Excel-style apps only, not a guarantee for every CSV
 * consumer. The default (`false`) output is unchanged and re-imports
 * losslessly.
 */
export function toCsv<TRow>(
	columns: GridColumn<TRow>[],
	rows: TRow[],
	opts?: { headers?: boolean; formulaSafe?: boolean }
): string {
	const headers = opts?.headers ?? true;
	const formulaSafe = opts?.formulaSafe ?? false;
	const lines: string[] = [];
	if (headers) {
		lines.push(columns.map((column) => escapeCsvField(column.id)).join(','));
	}
	for (const row of rows) {
		const cells = columns.map((column) => {
			const raw = getColumnValue(row, column);
			if (raw === null || raw === undefined) return '';
			const text = String(raw);
			return escapeCsvField(
				formulaSafe && typeof raw === 'string' ? neutralizeFormula(text) : text
			);
		});
		lines.push(cells.join(','));
	}
	return lines.join('\r\n');
}

/**
 * Prefix `csv` with a UTF-8 BOM so Excel on Japanese Windows detects UTF-8
 * instead of misreading it as Shift-JIS (spec §M15). Idempotent — a `csv`
 * that already starts with the BOM is returned unchanged.
 */
export function csvForExcel(csv: string): string {
	return csv.startsWith(BOM) ? csv : BOM + csv;
}

/**
 * Build a timestamped export filename, e.g. `csvFilename('items')` →
 * `"items-20260711-1430.csv"`. `now` defaults to the current time but is
 * accepted as a parameter for deterministic tests.
 */
export function csvFilename(base: string, now: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const y = now.getFullYear();
	const m = pad(now.getMonth() + 1);
	const d = pad(now.getDate());
	const hh = pad(now.getHours());
	const mm = pad(now.getMinutes());
	return `${base}-${y}${m}${d}-${hh}${mm}.csv`;
}

/**
 * Parse RFC 4180 CSV text into rows of string cells. A small state machine
 * (not split/regex) so quoted commas, quoted newlines, and `""` escapes are
 * handled correctly. A leading BOM is stripped. `\r\n`, bare `\r`, and bare
 * `\n` are all accepted as row terminators (real-world exports mix these),
 * and a wholly-empty trailing row (from a trailing newline) is dropped —
 * same "ignore the trailing terminator" treatment as `parseTsv`. An
 * unterminated quoted field (malformed input) is not treated as an error:
 * it's read through to the end of input, since Excel-authored CSVs are
 * sometimes slightly non-conformant and a hard failure would be unhelpful
 * here (spec: 素直に読める範囲で返す).
 */
export function parseCsv(text: string): string[][] {
	const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	let i = 0;
	const len = input.length;

	const pushField = () => {
		row.push(field);
		field = '';
	};
	const pushRow = () => {
		pushField();
		rows.push(row);
		row = [];
	};

	while (i < len) {
		const ch = input[i];
		if (inQuotes) {
			if (ch === '"') {
				if (input[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (ch === ',') {
			pushField();
			i++;
			continue;
		}
		if (ch === '\r') {
			pushRow();
			i += input[i + 1] === '\n' ? 2 : 1;
			continue;
		}
		if (ch === '\n') {
			pushRow();
			i++;
			continue;
		}
		field += ch;
		i++;
	}
	// Flush a final field/row that wasn't terminated by a line break.
	if (field !== '' || row.length > 0) {
		pushRow();
	}
	// Drop a single wholly-empty trailing row produced by a trailing
	// terminator (mirrors parseTsv, which never materializes that row at
	// all). Only the trailing one - a blank line *within* the data is kept.
	const last = rows[rows.length - 1];
	if (last && last.length === 1 && last[0] === '') {
		rows.pop();
	}
	return rows;
}

/** One CSV column mapped to the grid column it fills, by header position. */
export interface CsvMapping<TRow> {
	column: GridColumn<TRow>;
	index: number;
}

/**
 * Match a parsed CSV header row against `columns` by `column.id` (exact,
 * case-sensitive; each header cell is trimmed first). Header cells with no
 * matching column id are reported in `unknown` rather than rejected — the
 * caller decides whether unmapped columns are fatal. Columns present in
 * `columns` but absent from `header` simply don't appear in `mapped`
 * (compare against `columns` to detect "missing" columns).
 */
export function mapCsvHeader<TRow>(
	header: string[],
	columns: GridColumn<TRow>[]
): { mapped: CsvMapping<TRow>[]; unknown: string[] } {
	const columnById = new Map(columns.map((column) => [column.id, column]));
	const mapped: CsvMapping<TRow>[] = [];
	const unknown: string[] = [];
	for (const [index, rawName] of header.entries()) {
		const name = rawName.trim();
		const column = columnById.get(name);
		if (column) {
			mapped.push({ column, index });
		} else {
			unknown.push(rawName);
		}
	}
	return { mapped, unknown };
}

/** Result of converting one CSV data row: successfully-parsed values plus any per-column errors. */
export interface CsvRowResult<TRow> {
	values: Partial<TRow>;
	errors: { columnId: string; message: string }[];
}

/**
 * i18n layer 1 (docs/conventions.md §13): overridable message(s) for
 * `convertCsvRow`. Mirrors @banto/forms' `validate.ts` convention (message as
 * a function, default reproduces today's Japanese literal verbatim).
 */
export interface CsvConversionMessages {
	/** Per-cell type-conversion failure, given the column header and the raw (unparsed) cell text. */
	convertError?: (header: string, raw: string) => string;
}

const defaultCsvConversionMessages: Required<CsvConversionMessages> = {
	convertError: (header, raw) => `${header}: 値を変換できません（${raw}）`
};

/**
 * Convert one CSV data row (`cells`, positioned per `mapping`'s `index`)
 * into typed row values, reusing `parseCellInput` (editor-aware type
 * conversion, same as pasting a TSV cell) and `resolveSelectValue`
 * (reconciles a 'select' cell's raw string against `column.editorOptions`'
 * original value type) plus `column.validate`. A column whose `accessor` is
 * a function is derived/read-only and is skipped — there's no row field to
 * write it back to. Conversion failures and validation failures are
 * collected into `errors` per column rather than throwing, so one bad cell
 * doesn't discard the rest of the row (the caller decides whether a row
 * with any errors is importable).
 */
export function convertCsvRow<TRow>(
	cells: string[],
	mapping: CsvMapping<TRow>[],
	messages: CsvConversionMessages = {}
): CsvRowResult<TRow> {
	const msg = { ...defaultCsvConversionMessages, ...messages };
	const values: Partial<TRow> = {};
	const errors: { columnId: string; message: string }[] = [];

	for (const { column, index } of mapping) {
		if (typeof column.accessor === 'function') continue;

		const raw = cells[index] ?? '';
		const editor: CellEditorType = column.editor ?? 'text';
		const parsed = parseCellInput(raw, editor);
		if (!parsed.ok) {
			errors.push({
				columnId: column.id,
				message: msg.convertError(column.header, raw)
			});
			continue;
		}

		const value =
			editor === 'select'
				? resolveSelectValue(parsed.value as string, column.editorOptions)
				: parsed.value;

		if (column.validate) {
			// No full row exists yet during CSV import (the row is still being
			// assembled field-by-field), so pass an empty object; column
			// validators in this codebase only inspect `value`, never `row`.
			const message = column.validate(value, {} as TRow);
			if (message) {
				errors.push({ columnId: column.id, message });
				continue;
			}
		}

		(values as Record<string, unknown>)[column.accessor as string] = value;
	}

	return { values, errors };
}
