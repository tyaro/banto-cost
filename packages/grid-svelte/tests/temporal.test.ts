/**
 * Time and date-and-time cells (date-time-pickers §5.3 / §5.6 / §5.10,
 * PR-5): the parsing copied from `@banto/ui` / `@banto/forms` (a relative
 * import - a test may read another package's source, `src` may not), the
 * edge-case table shared with Rust (`crates/banto-core/tests/datetime-cases.json`)
 * run through the schema validator and checked against forms'
 * `validateField`, `parseCellInput` for typed / pasted text, the CSV import,
 * and what `columnsFromSchema` derives.
 */
import { describe, expect, it } from 'vitest';
import cases from '../../../crates/banto-core/tests/datetime-cases.json';
import * as formsDate from '../../forms/src/date';
import { validateField } from '../../forms/src/validate';
import type { FieldDef } from '../../forms/src/types';
import * as uiDatetime from '../../ui/src/datetime';
import { parseCellInput } from '../src/core/clipboard';
import { convertCsvRow } from '../src/core/csv';
import {
	formatDateTimeText,
	isIsoDateTime,
	isIsoTime,
	isOnTimeStep,
	nativeTimeStep,
	parseCellDateTime,
	parseDateTimeText,
	parseTimeText
} from '../src/core/date';
import { columnsFromSchema, type SchemaField } from '../src/core/schema';
import type { GridColumn } from '../src/types';

describe('time / datetime parsing mirrors @banto/ui (and forms)', () => {
	const times = [
		'09:30',
		'9:30',
		'930',
		'9',
		'00:00',
		'23:59',
		'24:00',
		'９：３０',
		'09:30:00',
		''
	];
	it.each(times)('parseTimeText / isIsoTime(%j)', (text) => {
		expect(parseTimeText(text)).toBe(uiDatetime.parseTimeText(text));
		expect(parseTimeText(text)).toBe(formsDate.parseTimeText(text));
		expect(isIsoTime(text)).toBe(uiDatetime.isIsoTime(text));
	});
	const dateTimes = [
		'2026-11-07T09:30',
		'2026/11/7 9:30',
		'20261107 0930',
		'11/7 9',
		'２０２６／１１／７　９：３０',
		'2026-11-07',
		'2026-11-07 09:30:00',
		'2025-02-29 9:00',
		'11/07/2026 9:30',
		''
	];
	it.each(dateTimes)('parseDateTimeText / isIsoDateTime / formatDateTimeText(%j)', (text) => {
		expect(parseDateTimeText(text, 2026)).toBe(uiDatetime.parseDateTimeText(text, 2026));
		expect(parseDateTimeText(text, 2026)).toBe(formsDate.parseDateTimeText(text, 2026));
		expect(isIsoDateTime(text)).toBe(uiDatetime.isIsoDateTime(text));
		expect(formatDateTimeText(text)).toBe(uiDatetime.formatDateTimeText(text));
	});
	it.each([
		['09:15', 15],
		['23:59', 25],
		['12:00', 0],
		['12:00', undefined]
	] as [string, number | undefined][])('isOnTimeStep(%j, %j)', (time, step) => {
		expect(isOnTimeStep(time, step)).toBe(uiDatetime.isOnTimeStep(time, step));
	});
	it('nativeTimeStep gives a native step only when its base agrees with 00:00 (forms’ copy too)', () => {
		const cases: [
			'time' | 'datetime',
			number | undefined,
			string | undefined,
			number | undefined
		][] = [
			['time', 15, undefined, 900],
			['time', 15, '09:00', 900],
			['time', 15, '09:10', undefined],
			['time', 25, undefined, 1500],
			['time', 0, undefined, undefined],
			['time', undefined, '09:00', undefined],
			['datetime', 30, undefined, 1800],
			['datetime', 30, '2026-11-02T09:00', 1800],
			['datetime', 30, '2026-11-02T09:10', undefined],
			['datetime', 25, undefined, undefined],
			['datetime', 30, '2026-11-02', undefined]
		];
		for (const [type, step, min, expected] of cases) {
			expect(nativeTimeStep(type, step, min), `${type} ${step} ${min}`).toBe(expected);
			expect(formsDate.nativeTimeStep(type, step, min)).toBe(expected);
		}
	});

	it('parseCellDateTime refuses a year-less date unless typed', () => {
		expect(parseCellDateTime('11/7 9:30')).toBeNull();
		expect(parseCellDateTime('11/7 9:30', true)).toBe(`${new Date().getFullYear()}-11-07T09:30`);
		expect(parseCellDateTime('2026/11/7 9:30')).toBe('2026-11-07T09:30');
	});
});

describe('the edge-case table shared with Rust (datetime-cases.json)', () => {
	it.each(cases.rules)('column validator: $type $value -> $error', (rule) => {
		const { type, value, error } = rule;
		const { min, max, step } = rule as { min?: string; max?: string; step?: number };
		const field = { name: 'f', label: 'F', type, min, max, step } as SchemaField;
		const [column] = columnsFromSchema<Record<string, unknown>>({ fields: [field] });
		expect(column.validate!(value, {})).toBe(error);
		// The same as forms' validateField (structural mirror, schema.ts).
		expect(validateField(field as FieldDef, value, {})).toBe(error);
	});
});

describe('parseCellInput for time / datetime (§5.10)', () => {
	it('normalises lenient text, blank is null', () => {
		expect(parseCellInput('930', 'time')).toEqual({ ok: true, value: '09:30' });
		expect(parseCellInput('２３：５９', 'time')).toEqual({ ok: true, value: '23:59' });
		expect(parseCellInput(' ', 'time')).toEqual({ ok: true, value: null });
		expect(parseCellInput('2026/11/7 9:30', 'datetime')).toEqual({
			ok: true,
			value: '2026-11-07T09:30'
		});
		expect(parseCellInput('2026-11-07T00:00', 'datetime')).toEqual({
			ok: true,
			value: '2026-11-07T00:00'
		});
		expect(parseCellInput('', 'datetime')).toEqual({ ok: true, value: null });
	});

	it('rejects seconds, 24:00, a date alone, impossible days, the year-less form when pasted', () => {
		for (const raw of ['24:00', '09:30:00', '9:60', 'abc']) {
			expect(parseCellInput(raw, 'time'), raw).toEqual({ ok: false });
		}
		for (const raw of [
			'2026-11-07',
			'2026/11/7 9:30:00',
			'2025/2/29 9:00',
			'11/07/2026 9:30',
			'11/7 9:30'
		]) {
			expect(parseCellInput(raw, 'datetime'), raw).toEqual({ ok: false });
		}
		expect(parseCellInput('11/7 9:30', 'datetime', { typed: true }).ok).toBe(true);
	});
});

describe('columnsFromSchema for time / datetime', () => {
	const fields: SchemaField[] = [
		{ name: 'at', label: 'At', type: 'time', min: '09:00', max: '18:00', step: 15 },
		{
			name: 'starts',
			label: 'Starts',
			type: 'datetime',
			min: '2026-11-02T09:00',
			step: 30,
			isDateDisabled: () => false
		}
	];
	const [at, starts] = columnsFromSchema<Record<string, unknown>>({ fields });

	it('gives the editor, its range, step and disabled days', () => {
		expect(at).toMatchObject({
			editor: 'time',
			editorMin: '09:00',
			editorMax: '18:00',
			editorStep: 15
		});
		expect(at.isDateDisabled).toBeUndefined();
		expect(starts).toMatchObject({
			editor: 'datetime',
			editorMin: '2026-11-02T09:00',
			editorStep: 30
		});
		expect(starts.isDateDisabled).toBeTypeOf('function');
		// A date and time filters by a day range (§5.9); a time does not.
		expect(starts).toMatchObject({ filterable: true, filterType: 'datetime' });
		expect(at.filterable).toBeUndefined();
	});

	it('shows a date and time with a space', () => {
		expect(starts.format!('2026-11-07T09:30', {})).toBe('2026-11-07 09:30');
		expect(starts.format!(null, {})).toBe('');
		expect(at.format).toBeUndefined();
	});

	it('the messages are overridable', () => {
		const [column] = columnsFromSchema<Record<string, unknown>>(
			{ fields: [fields[0]] },
			{ messages: { timeStep: (_f, step) => `every ${step}` } }
		);
		expect(column.validate!('09:10', {})).toBe('every 15');
	});
});

describe('CSV import of time / datetime columns', () => {
	const columns = columnsFromSchema<Record<string, unknown>>({
		fields: [
			{ name: 'at', label: 'At', type: 'time', step: 15 },
			{ name: 'starts', label: 'Starts', type: 'datetime', max: '2026-12-31T23:59' }
		]
	}) as GridColumn<Record<string, unknown>>[];
	const mapping = columns.map((column, index) => ({ column, index }));

	it('normalises Excel’s forms; blank is null', () => {
		expect(convertCsvRow(['9:15', '2026/11/7 9:30'], mapping)).toMatchObject({
			values: { at: '09:15', starts: '2026-11-07T09:30' },
			errors: []
		});
		expect(convertCsvRow(['', ''], mapping)).toMatchObject({
			values: { at: null, starts: null },
			errors: []
		});
	});

	it('an invalid or year-less value is a conversion error; a rule breach a validation error', () => {
		const result = convertCsvRow(['9:10', '11/7 9:30'], mapping);
		expect(result.errors.map((error) => error.columnId)).toEqual(['at', 'starts']);
		expect(result.errors[0].message).toBe('15分刻みの時刻を入力してください');
		const late = convertCsvRow(['09:00', '2027/1/1 0:00'], mapping);
		expect(late.errors[0].message).toBe('2026-12-31 23:59以前の日時を入力してください');
	});
});
