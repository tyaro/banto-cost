/**
 * Dates in grid cells (date-time-pickers §5.3 / §5.6 / §5.10, PR-4): the copy
 * of the date parse kept in lockstep with `@banto/ui`'s `datetime.ts` (a
 * relative import - a test may read another package's source, `src` may not,
 * conventions §4), `parseCellInput`'s normalisation for typed / pasted text,
 * the CSV import, and the schema validator mirroring forms' date checks.
 */
import { describe, expect, it } from 'vitest';
import * as uiDatetime from '../../ui/src/datetime';
import * as formsDate from '../../forms/src/date';
import { validateField } from '../../forms/src/validate';
import type { FieldDef } from '../../forms/src/types';
import { parseCellInput } from '../src/core/clipboard';
import { convertCsvRow } from '../src/core/csv';
import { isIsoDate, parseCellDate, parseDateText } from '../src/core/date';
import { columnsFromSchema, type SchemaField } from '../src/core/schema';
import type { GridColumn } from '../src/types';

const typed = [
	'2026-11-07',
	'2026/11/7',
	'2026.1.2',
	'20261107',
	'２０２６／１１／７',
	' 2026-11-07 ',
	'11/7',
	'1-2',
	'2026-02-29',
	'2028-02-29',
	'2000-02-29',
	'1900-02-29',
	'2026-13-01',
	'2026-04-31',
	'0000-01-01',
	'0001-01-01',
	'9999-12-31',
	'10000-01-01',
	'11/07/2026',
	'2026-11',
	'2026-11-07T09:30',
	'abc',
	''
];

describe('date parsing mirrors @banto/ui datetime.ts (and forms date.ts)', () => {
	it.each(typed)('parseDateText(%j) is the same as ui and forms', (text) => {
		expect(parseDateText(text, 2026)).toBe(uiDatetime.parseDateText(text, 2026));
		expect(parseDateText(text, 2026)).toBe(formsDate.parseDateText(text, 2026));
	});
	it.each(typed)('isIsoDate(%j) is the same as ui and forms', (text) => {
		expect(isIsoDate(text)).toBe(uiDatetime.isIsoDate(text));
		expect(isIsoDate(text)).toBe(formsDate.isIsoDate(text));
	});
	it('isIsoDate refuses non-strings', () => {
		expect(isIsoDate(20261107)).toBe(false);
		expect(isIsoDate(null)).toBe(false);
	});
	it('parseCellDate refuses the year-less form unless typed', () => {
		expect(parseCellDate('11/7')).toBeNull();
		expect(parseCellDate('１１／７')).toBeNull();
		expect(parseCellDate('11/7', true)).toBe(parseDateText('11/7'));
		expect(parseCellDate('2026/11/7')).toBe('2026-11-07');
	});
});

describe('parseCellInput for date (§5.10)', () => {
	it('normalises lenient text, Excel’s 2026/11/7 and full-width digits', () => {
		expect(parseCellInput('2026-07-02', 'date')).toEqual({ ok: true, value: '2026-07-02' });
		expect(parseCellInput('2026/11/7', 'date')).toEqual({ ok: true, value: '2026-11-07' });
		expect(parseCellInput('２０２６／１１／７', 'date')).toEqual({ ok: true, value: '2026-11-07' });
		expect(parseCellInput(' 20261107 ', 'date')).toEqual({ ok: true, value: '2026-11-07' });
	});
	it('blank is null (D6)', () => {
		expect(parseCellInput('', 'date')).toEqual({ ok: true, value: null });
		expect(parseCellInput('   ', 'date')).toEqual({ ok: true, value: null });
	});
	it('leap days follow the calendar', () => {
		expect(parseCellInput('2028-02-29', 'date')).toEqual({ ok: true, value: '2028-02-29' });
		expect(parseCellInput('2000-02-29', 'date')).toEqual({ ok: true, value: '2000-02-29' });
		expect(parseCellInput('2026-02-29', 'date')).toEqual({ ok: false });
		expect(parseCellInput('1900-02-29', 'date')).toEqual({ ok: false });
	});
	it('rejects impossible days, other orders, a time, and the year-less form when pasted', () => {
		for (const raw of ['2026-02-30', '0000-01-01', '11/07/2026', '2026-11-07 9:30', '11/7', 'x']) {
			expect(parseCellInput(raw, 'date')).toEqual({ ok: false });
		}
	});
	it('a typed year-less day is this year’s', () => {
		const year = new Date().getFullYear();
		expect(parseCellInput('1/2', 'date', { typed: true })).toEqual({
			ok: true,
			value: `${year}-01-02`
		});
	});
});

interface Row {
	name: string;
	due: string | null;
}

describe('CSV import of a date column', () => {
	const due: GridColumn<Row> = { id: 'due', header: '期日', accessor: 'due', editor: 'date' };
	const mapping = [{ column: due, index: 0 }];

	it('normalises the cell, blank is null', () => {
		expect(convertCsvRow<Row>(['2026/11/7'], mapping)).toEqual({
			values: { due: '2026-11-07' },
			errors: []
		});
		expect(convertCsvRow<Row>([''], mapping)).toEqual({ values: { due: null }, errors: [] });
	});
	it('an invalid or year-less date is a conversion error', () => {
		for (const raw of ['2026/2/30', '11/7']) {
			expect(convertCsvRow<Row>([raw], mapping)).toEqual({
				values: {},
				errors: [{ columnId: 'due', message: `期日: 値を変換できません（${raw}）` }]
			});
		}
	});
	it('the derived validator rejects a day out of range', () => {
		const [column] = columnsFromSchema<Row>({
			fields: [{ name: 'due', label: '期日', type: 'date', min: '2026-11-01' }]
		});
		expect(convertCsvRow<Row>(['2026/10/31'], [{ column, index: 0 }]).errors).toEqual([
			{ columnId: 'due', message: '2026-11-01以降の日付を入力してください' }
		]);
	});
});

describe('the schema validator mirrors forms’ date checks', () => {
	const isSunday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
	const field: SchemaField = {
		name: 'due',
		label: '期日',
		type: 'date',
		min: '2026-11-02',
		max: '2026-11-27',
		isDateDisabled: isSunday
	};
	const [column] = columnsFromSchema<Row>({ fields: [field] });
	const row: Row = { name: 'x', due: null };
	const cases: unknown[] = [
		null,
		'',
		'2026-11-02',
		'2026-11-27',
		'2026-11-01',
		'2026-11-28',
		'2026-11-08',
		'2026-11-10',
		'2026/11/10',
		'2026-02-30',
		20261110
	];

	it.each(cases)('validate(%j) is the same as forms’ validateField', (value) => {
		expect(column.validate?.(value, row)).toBe(validateField(field as FieldDef, value, {}) ?? null);
	});
	it('the bounds are inclusive and the messages name them', () => {
		expect(column.validate?.('2026-11-02', row)).toBeNull();
		expect(column.validate?.('2026-11-27', row)).toBeNull();
		expect(column.validate?.('2026-11-01', row)).toBe('2026-11-02以降の日付を入力してください');
		expect(column.validate?.('2026-11-28', row)).toBe('2026-11-27以前の日付を入力してください');
		expect(column.validate?.('2026-11-08', row)).toBe('この日付は選べません');
		expect(column.validate?.('2026-11-31', row)).toBe('日付を YYYY-MM-DD の形で入力してください');
	});
	it('required, a number bound ignored, messages overridable', () => {
		const [required] = columnsFromSchema<Row>({
			fields: [{ name: 'due', label: '期日', type: 'date', required: true, min: 3 }]
		});
		expect(required.validate?.(null, row)).toBe('必須項目です');
		expect(required.validate?.('0001-01-01', row)).toBeNull();
		const [custom] = columnsFromSchema<Row>(
			{ fields: [field] },
			{
				messages: {
					dateInvalid: () => 'bad',
					dateMin: (_f, min) => `>= ${min}`,
					dateMax: (_f, max) => `<= ${max}`,
					dateDisabled: (_f, date) => `no ${date}`
				}
			}
		);
		expect(custom.validate?.('x', row)).toBe('bad');
		expect(custom.validate?.('2026-11-01', row)).toBe('>= 2026-11-02');
		expect(custom.validate?.('2026-11-28', row)).toBe('<= 2026-11-27');
		expect(custom.validate?.('2026-11-08', row)).toBe('no 2026-11-08');
	});
	it('hands the calendar the range and the disabled days', () => {
		expect(column.editor).toBe('date');
		expect(column.editorMin).toBe('2026-11-02');
		expect(column.editorMax).toBe('2026-11-27');
		expect(column.isDateDisabled).toBe(isSunday);
		const [plain] = columnsFromSchema<Row>({
			fields: [{ name: 'due', label: '期日', type: 'date', min: 1 }]
		});
		expect(plain.editorMin).toBeUndefined();
		expect('isDateDisabled' in plain).toBe(false);
	});
});
