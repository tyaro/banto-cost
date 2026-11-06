import { describe, expect, it } from 'vitest';
import { parseCellInput, parseTsv, rangeToTsv, resolveSelectValue } from '../src/core/clipboard';
import { getColumnValue } from '../src/core/sort';
import type { GridColumn } from '../src/types';

interface Row {
	id: number;
	name: string;
	price: number;
}

const columns: GridColumn<Row>[] = [
	{ id: 'id', header: 'ID', accessor: 'id' },
	{ id: 'name', header: 'Name', accessor: 'name' },
	{ id: 'price', header: 'Price', accessor: 'price', format: (v) => `¥${v}` }
];

const rows: Row[] = [
	{ id: 1, name: 'Green Tea', price: 140 },
	{ id: 2, name: 'Coffee', price: 300 },
	{ id: 3, name: 'Roasted Tea\tSpecial', price: 150 }
];

describe('rangeToTsv', () => {
	it('builds a single-cell TSV', () => {
		const text = rangeToTsv(
			rows,
			columns,
			{ rowStart: 0, rowEnd: 0, fieldStart: 1, fieldEnd: 1 },
			getColumnValue
		);
		expect(text).toBe('Green Tea');
	});

	it('builds a multi-row, multi-column TSV with tabs between columns and newlines between rows', () => {
		const text = rangeToTsv(
			rows,
			columns,
			{ rowStart: 0, rowEnd: 1, fieldStart: 0, fieldEnd: 2 },
			getColumnValue
		);
		expect(text).toBe('1\tGreen Tea\t140\n2\tCoffee\t300');
	});

	it('copies the RAW value, not column.format (round-trip fidelity)', () => {
		const text = rangeToTsv(
			rows,
			columns,
			{ rowStart: 0, rowEnd: 0, fieldStart: 2, fieldEnd: 2 },
			getColumnValue
		);
		expect(text).toBe('140');
		expect(text).not.toContain('¥');
	});

	it('treats null/undefined values as empty cells', () => {
		type NullableRow = { id: number; note: string | null };
		const nullableColumns: GridColumn<NullableRow>[] = [
			{ id: 'id', header: 'ID', accessor: 'id' },
			{ id: 'note', header: 'Note', accessor: 'note' }
		];
		const nullableRows: NullableRow[] = [{ id: 1, note: null }];
		const text = rangeToTsv(
			nullableRows,
			nullableColumns,
			{ rowStart: 0, rowEnd: 0, fieldStart: 0, fieldEnd: 1 },
			getColumnValue
		);
		expect(text).toBe('1\t');
	});
});

describe('parseTsv', () => {
	it('parses a single cell with no delimiters', () => {
		expect(parseTsv('hello')).toEqual([['hello']]);
	});

	it('splits tabs within a row and newlines between rows', () => {
		expect(parseTsv('1\tGreen Tea\t140\n2\tCoffee\t300')).toEqual([
			['1', 'Green Tea', '140'],
			['2', 'Coffee', '300']
		]);
	});

	it('normalizes \\r\\n line endings', () => {
		expect(parseTsv('a\tb\r\nc\td')).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('ignores a single trailing newline', () => {
		expect(parseTsv('a\tb\n')).toEqual([['a', 'b']]);
	});

	it('preserves empty cells', () => {
		expect(parseTsv('a\t\tc')).toEqual([['a', '', 'c']]);
	});

	it('returns a single empty row for empty input', () => {
		expect(parseTsv('')).toEqual([[]]);
	});
});

describe('parseCellInput', () => {
	it('text passes the raw string through unchanged', () => {
		expect(parseCellInput('hello', 'text')).toEqual({ ok: true, value: 'hello' });
	});

	it('date/select pass the raw string through unchanged', () => {
		expect(parseCellInput('2026-07-02', 'date')).toEqual({ ok: true, value: '2026-07-02' });
		expect(parseCellInput('opt-a', 'select')).toEqual({ ok: true, value: 'opt-a' });
	});

	it('number parses a valid numeric string', () => {
		expect(parseCellInput('140', 'number')).toEqual({ ok: true, value: 140 });
		expect(parseCellInput('-3.5', 'number')).toEqual({ ok: true, value: -3.5 });
	});

	it('number rejects empty string and non-numeric input (NaN)', () => {
		expect(parseCellInput('', 'number')).toEqual({ ok: false });
		expect(parseCellInput('abc', 'number')).toEqual({ ok: false });
		expect(parseCellInput('  ', 'number')).toEqual({ ok: false });
	});

	it("checkbox accepts 'true'/'1' and 'false'/'0'", () => {
		expect(parseCellInput('true', 'checkbox')).toEqual({ ok: true, value: true });
		expect(parseCellInput('1', 'checkbox')).toEqual({ ok: true, value: true });
		expect(parseCellInput('false', 'checkbox')).toEqual({ ok: true, value: false });
		expect(parseCellInput('0', 'checkbox')).toEqual({ ok: true, value: false });
	});

	it('checkbox rejects anything else', () => {
		expect(parseCellInput('yes', 'checkbox')).toEqual({ ok: false });
		expect(parseCellInput('', 'checkbox')).toEqual({ ok: false });
	});
});

describe('resolveSelectValue', () => {
	const numericOptions = [
		{ value: 1, label: 'One' },
		{ value: 2, label: 'Two' }
	];

	it("resolves a raw string to the matching option's (numeric) value, not a string", () => {
		const resolved = resolveSelectValue('1', numericOptions);
		expect(resolved).toBe(1);
		expect(typeof resolved).toBe('number');
	});

	it('is idempotent: re-resolving an already-resolved (numeric) value still finds the match', () => {
		expect(resolveSelectValue(String(2), numericOptions)).toBe(2);
	});

	it('falls back to the raw string when no option matches', () => {
		expect(resolveSelectValue('999', numericOptions)).toBe('999');
	});

	it('falls back to the raw string when editorOptions is undefined', () => {
		expect(resolveSelectValue('1', undefined)).toBe('1');
	});

	it('resolves string-valued options unchanged', () => {
		const stringOptions = [
			{ value: 'a', label: 'A' },
			{ value: 'b', label: 'B' }
		];
		expect(resolveSelectValue('b', stringOptions)).toBe('b');
	});
});
