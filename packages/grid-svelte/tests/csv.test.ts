import { describe, expect, it } from 'vitest';
import {
	convertCsvRow,
	csvFilename,
	csvForExcel,
	mapCsvHeader,
	parseCsv,
	toCsv,
	type CsvMapping
} from '../src/core/csv';
import type { GridColumn } from '../src/types';

interface Row {
	id: number;
	name: string;
	note: string | null;
	price: number;
	active: boolean;
	category: string;
}

const columns: GridColumn<Row>[] = [
	{ id: 'id', header: 'ID', accessor: 'id', editor: 'number' },
	{ id: 'name', header: 'Name', accessor: 'name' },
	{ id: 'note', header: 'Note', accessor: 'note' },
	{ id: 'price', header: 'Price', accessor: 'price', editor: 'number', format: (v) => `¥${v}` },
	{ id: 'active', header: 'Active', accessor: 'active', editor: 'checkbox' },
	{
		id: 'category',
		header: 'Category',
		accessor: 'category',
		editor: 'select',
		editorOptions: [
			{ value: 1, label: 'Drink' },
			{ value: 2, label: 'Food' }
		]
	}
];

const rows: Row[] = [
	{
		id: 1,
		name: 'Green Tea',
		note: null,
		price: 140,
		active: true,
		category: 1 as unknown as string
	},
	{
		id: 2,
		name: 'Say "Hi", Bob',
		note: 'multi\nline',
		price: 300,
		active: false,
		category: 2 as unknown as string
	}
];

describe('toCsv', () => {
	it('emits a header row of column ids by default', () => {
		const csv = toCsv(columns.slice(0, 2), [{ id: 1, name: 'Green Tea' } as Row]);
		expect(csv).toBe('id,name\r\n1,Green Tea');
	});

	it('omits the header row when headers: false', () => {
		const csv = toCsv(columns.slice(0, 2), [{ id: 1, name: 'Green Tea' } as Row], {
			headers: false
		});
		expect(csv).toBe('1,Green Tea');
	});

	it('quotes fields containing a comma, double quote (doubled), or newline; CRLF between rows', () => {
		const csv = toCsv(columns.slice(0, 3), rows, { headers: false });
		expect(csv).toBe('1,Green Tea,\r\n2,"Say ""Hi"", Bob","multi\nline"');
	});

	it('copies the RAW value, not column.format', () => {
		const csv = toCsv([columns[3]], [rows[0]], { headers: false });
		expect(csv).toBe('140');
		expect(csv).not.toContain('¥');
	});

	it('treats null/undefined values as empty fields', () => {
		const csv = toCsv([columns[2]], [rows[0]], { headers: false });
		expect(csv).toBe('');
	});

	it('leaves a raw tab unquoted (ordinary CSV field data)', () => {
		const tabColumns: GridColumn<{ v: string }>[] = [{ id: 'v', header: 'V', accessor: 'v' }];
		const csv = toCsv(tabColumns, [{ v: 'a\tb' }], { headers: false });
		expect(csv).toBe('a\tb');
	});
});

describe('toCsv formulaSafe', () => {
	const col: GridColumn<{ v: unknown }>[] = [{ id: 'v', header: 'V', accessor: 'v' }];
	const out = (v: unknown, formulaSafe = true) =>
		toCsv(col, [{ v }], { headers: false, formulaSafe });

	it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx', '\nx', '＝1', '＋1', '－1', '＠a'])(
		'prefixes a quote for formula-start string %j',
		(v) => {
			expect(parseCsv(out(v))[0][0]).toBe(`'${v}`);
		}
	);

	it('neutralizes the issue example', () => {
		expect(out('=HYPERLINK("https://example.org","Open")')).toBe(
			'"\'=HYPERLINK(""https://example.org"",""Open"")"'
		);
	});

	it('leaves ordinary strings, Japanese, quotes, commas and newlines alone', () => {
		expect(out('abc')).toBe('abc');
		expect(out('緑茶')).toBe('緑茶');
		expect(out('a=b')).toBe('a=b');
		expect(out(' =1')).toBe(' =1');
		expect(out('say "hi", bob\nx')).toBe('"say ""hi"", bob\nx"');
		expect(out('')).toBe('');
	});

	it('does not touch numbers (incl. negative), booleans, null, undefined', () => {
		expect(out(-5)).toBe('-5');
		expect(out(140)).toBe('140');
		expect(out(true)).toBe('true');
		expect(out(null)).toBe('');
		expect(out(undefined)).toBe('');
	});

	it('default toCsv output is unchanged (no quote prefix)', () => {
		expect(out('=1+1', false)).toBe('=1+1');
		expect(toCsv(col, [{ v: '=1' }], { headers: false })).toBe('=1');
	});

	it('does not alter headers', () => {
		expect(toCsv([{ id: '=h', header: 'H', accessor: 'v' }], [], { formulaSafe: true })).toBe('=h');
	});
});

describe('toCsv -> parseCsv round trip', () => {
	it('round-trips quoted commas, quoted quotes, and embedded newlines/tabs', () => {
		const csv = toCsv(columns.slice(0, 3), rows);
		const parsed = parseCsv(csv);
		expect(parsed).toEqual([
			['id', 'name', 'note'],
			['1', 'Green Tea', ''],
			['2', 'Say "Hi", Bob', 'multi\nline']
		]);
	});
});

describe('csvForExcel', () => {
	it('prepends a UTF-8 BOM', () => {
		const withBom = csvForExcel('a,b\r\n1,2');
		expect(withBom.charCodeAt(0)).toBe(0xfeff);
		expect(withBom.slice(1)).toBe('a,b\r\n1,2');
	});

	it('does not double-prepend when the BOM is already present', () => {
		const once = csvForExcel('a,b');
		const twice = csvForExcel(once);
		expect(twice).toBe(once);
		// U+FEFF here is the literal BOM under test, not stray whitespace.
		// eslint-disable-next-line no-irregular-whitespace
		expect(twice.match(/﻿/g)?.length).toBe(1);
	});
});

describe('csvFilename', () => {
	it('builds a timestamped filename from a fixed date', () => {
		const name = csvFilename('items', new Date(2026, 6, 11, 14, 30));
		expect(name).toBe('items-20260711-1430.csv');
	});

	it('zero-pads month/day/hour/minute', () => {
		const name = csvFilename('items', new Date(2026, 0, 2, 3, 4));
		expect(name).toBe('items-20260102-0304.csv');
	});
});

describe('parseCsv', () => {
	it('parses a simple unquoted row', () => {
		expect(parseCsv('a,b,c')).toEqual([['a', 'b', 'c']]);
	});

	it('handles quoted commas and newlines inside a field', () => {
		expect(parseCsv('"a,b","c\nd"')).toEqual([['a,b', 'c\nd']]);
	});

	it('unescapes doubled quotes inside a quoted field', () => {
		expect(parseCsv('"say ""hi""",b')).toEqual([['say "hi"', 'b']]);
	});

	it('accepts CRLF and bare LF row separators, even mixed in the same input', () => {
		expect(parseCsv('a,b\r\nc,d\ne,f')).toEqual([
			['a', 'b'],
			['c', 'd'],
			['e', 'f']
		]);
	});

	it('accepts bare CR row separators', () => {
		expect(parseCsv('a,b\rc,d')).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('strips a leading BOM', () => {
		expect(parseCsv('﻿a,b\r\n1,2')).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});

	it('drops a wholly-empty trailing row from a trailing newline, but keeps one mid-data', () => {
		expect(parseCsv('a,b\n\nc,d\n')).toEqual([['a', 'b'], [''], ['c', 'd']]);
	});

	it('reads an unterminated quoted field through to end of input rather than erroring', () => {
		expect(parseCsv('a,"bc')).toEqual([['a', 'bc']]);
	});

	it('preserves empty fields', () => {
		expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
	});

	it('returns an empty array for empty input', () => {
		expect(parseCsv('')).toEqual([]);
	});

	it('parses a header-only input as a single row', () => {
		expect(parseCsv('id,name')).toEqual([['id', 'name']]);
	});
});

describe('mapCsvHeader', () => {
	it('maps header cells to columns by id, trimming whitespace', () => {
		const { mapped, unknown } = mapCsvHeader([' id ', 'name'], columns);
		expect(mapped.map((m) => [m.column.id, m.index])).toEqual([
			['id', 0],
			['name', 1]
		]);
		expect(unknown).toEqual([]);
	});

	it('maps out-of-order headers by their actual position', () => {
		const { mapped } = mapCsvHeader(['name', 'id'], columns);
		expect(mapped.map((m) => [m.column.id, m.index])).toEqual([
			['name', 0],
			['id', 1]
		]);
	});

	it('reports headers with no matching column id as unknown', () => {
		const { mapped, unknown } = mapCsvHeader(['id', 'bogus'], columns);
		expect(mapped.map((m) => m.column.id)).toEqual(['id']);
		expect(unknown).toEqual(['bogus']);
	});

	it('simply omits columns missing from the header (no entry in mapped)', () => {
		const { mapped } = mapCsvHeader(['id'], columns);
		expect(mapped.map((m) => m.column.id)).toEqual(['id']);
		expect(mapped.some((m) => m.column.id === 'name')).toBe(false);
	});
});

describe('convertCsvRow', () => {
	const idNameMapping: CsvMapping<Row>[] = [
		{ column: columns[0], index: 0 },
		{ column: columns[1], index: 1 }
	];

	it('converts plain text/number cells', () => {
		const priceMapping: CsvMapping<Row>[] = [{ column: columns[3], index: 0 }];
		const result = convertCsvRow(['140'], priceMapping);
		expect(result).toEqual({ values: { price: 140 }, errors: [] });
	});

	it('rejects a non-numeric value for a number column (NaN)', () => {
		const priceMapping: CsvMapping<Row>[] = [{ column: columns[3], index: 0 }];
		const result = convertCsvRow(['abc'], priceMapping);
		expect(result.values).toEqual({});
		expect(result.errors).toEqual([
			{ columnId: 'price', message: 'Price: 値を変換できません（abc）' }
		]);
	});

	it('rejects an empty value for a number column', () => {
		const priceMapping: CsvMapping<Row>[] = [{ column: columns[3], index: 0 }];
		const result = convertCsvRow([''], priceMapping);
		expect(result.errors).toEqual([
			{ columnId: 'price', message: 'Price: 値を変換できません（）' }
		]);
	});

	it('resolves a checkbox cell to a boolean', () => {
		const activeMapping: CsvMapping<Row>[] = [{ column: columns[4], index: 0 }];
		expect(convertCsvRow(['true'], activeMapping)).toEqual({
			values: { active: true },
			errors: []
		});
		expect(convertCsvRow(['0'], activeMapping)).toEqual({ values: { active: false }, errors: [] });
	});

	it('rejects an unrecognized checkbox value', () => {
		const activeMapping: CsvMapping<Row>[] = [{ column: columns[4], index: 0 }];
		const result = convertCsvRow(['yes'], activeMapping);
		expect(result.values).toEqual({});
		expect(result.errors[0].columnId).toBe('active');
	});

	it('resolves a select cell to its editorOptions value type (number, not string)', () => {
		const categoryMapping: CsvMapping<Row>[] = [{ column: columns[5], index: 0 }];
		const result = convertCsvRow(['2'], categoryMapping);
		expect(result.values).toEqual({ category: 2 });
		expect(typeof (result.values as Row).category).toBe('number');
	});

	it('falls back to the raw string for an unmatched select value', () => {
		const categoryMapping: CsvMapping<Row>[] = [{ column: columns[5], index: 0 }];
		const result = convertCsvRow(['999'], categoryMapping);
		expect(result.values).toEqual({ category: '999' });
	});

	it('collects a column.validate error without discarding the rest of the row', () => {
		const validated: GridColumn<Row> = {
			id: 'name',
			header: 'Name',
			accessor: 'name',
			validate: (value) => (String(value).length === 0 ? '必須項目です' : null)
		};
		const mapping: CsvMapping<Row>[] = [
			{ column: columns[0], index: 0 },
			{ column: validated, index: 1 }
		];
		const result = convertCsvRow(['1', ''], mapping);
		expect(result.values).toEqual({ id: 1 });
		expect(result.errors).toEqual([{ columnId: 'name', message: '必須項目です' }]);
	});

	it('skips a column whose accessor is a function (derived, not writable)', () => {
		const derived: GridColumn<Row> = {
			id: 'label',
			header: 'Label',
			accessor: (r) => `${r.name} (${r.price})`
		};
		const mapping: CsvMapping<Row>[] = [{ column: derived, index: 0 }];
		expect(convertCsvRow(['whatever'], mapping)).toEqual({ values: {}, errors: [] });
	});

	it('treats a missing trailing cell as an empty string', () => {
		const result = convertCsvRow(['1'], idNameMapping);
		expect(result.values).toEqual({ id: 1, name: '' });
		expect(result.errors).toEqual([]);
	});

	it('converts an ordinary two-column row cleanly', () => {
		expect(convertCsvRow(['1', 'Green Tea'], idNameMapping)).toEqual({
			values: { id: 1, name: 'Green Tea' },
			errors: []
		});
	});
});
