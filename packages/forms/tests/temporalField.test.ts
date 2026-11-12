// @vitest-environment jsdom
/**
 * Time and date-and-time fields (date-time-pickers §5.3 / §5.6 / §5.7, PR-5):
 * the parsing copied from `@banto/ui` (run through both, like the date one in
 * dateField.test.ts - a relative import: a test may read another package's
 * source, `src` may not, conventions §4), the shared edge-case table with
 * Rust (`crates/banto-core/tests/datetime-cases.json`, run by
 * `validateField` here and by `banto_core::datetime` there), empty = `null`,
 * the draft's normalisation, and the injected inputs / native fallback.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import cases from '../../../crates/banto-core/tests/datetime-cases.json';
import * as uiDatetime from '../../ui/src/datetime';
import DateTimeInput from '../../ui/src/DateTimeInput.svelte';
import TimeInput from '../../ui/src/TimeInput.svelte';
import {
	formatDateTimeText,
	isIsoDate,
	isIsoDateTime,
	isIsoTime,
	isOnTimeStep,
	parseDateTimeText,
	parseTimeText
} from '../src/date';
import { createFormDraft } from '../src/draft.svelte';
import { createFormStore } from '../src/store.svelte';
import type { FieldDef, FieldType, FormSchema } from '../src/types';
import { validateField } from '../src/validate';
import FieldInputsHarness from './FieldInputsHarness.svelte';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as PopoverElement;
	proto.showPopover = function (this: HTMLElement) {
		this.dataset.popoverOpen = 'true';
		this.style.display = 'block';
	};
	proto.hidePopover = function (this: HTMLElement) {
		delete this.dataset.popoverOpen;
		this.style.removeProperty('display');
	};
});

afterEach(cleanup);

const at: FieldDef = { name: 'at', label: 'At', type: 'time' };
const starts: FieldDef = { name: 'starts', label: 'Starts', type: 'datetime' };

describe('time / datetime parsing mirrors @banto/ui datetime.ts', () => {
	const times = [
		'09:30',
		'9:30',
		'930',
		'0930',
		'9',
		'00:00',
		'23:59',
		'24:00',
		'9:60',
		'９：３０'
	];
	const extra = ['09:30:00', '9 AM', '', ' 7 ', '-1', '123456'];
	it.each([...times, ...extra])('parseTimeText(%j) is the same as ui', (text) => {
		expect(parseTimeText(text)).toBe(uiDatetime.parseTimeText(text));
	});
	it.each([...times, ...extra])('isIsoTime(%j) is the same as ui', (text) => {
		expect(isIsoTime(text)).toBe(uiDatetime.isIsoTime(text));
	});

	const dateTimes = [
		'2026-11-07T09:30',
		'2026-11-07 09:30',
		'2026/11/7 9:30',
		'20261107T0930',
		'2026.11.07   930',
		'11/7 9',
		'2/29 0:00',
		'２０２６／１１／７　９：３０',
		'2026-11-07',
		'2026-11-07 09:30:00',
		'2026-11-07 24:00',
		'2025-02-29 09:00',
		'11/07/2026 09:30',
		'2026-11-07T 09:30',
		'2026-11-07t09:30',
		'2026-11-07T09:30Z',
		''
	];
	it.each(dateTimes)('parseDateTimeText(%j) is the same as ui', (text) => {
		expect(parseDateTimeText(text, 2026)).toBe(uiDatetime.parseDateTimeText(text, 2026));
	});
	it.each(dateTimes)('isIsoDateTime / formatDateTimeText(%j) are the same as ui', (text) => {
		expect(isIsoDateTime(text)).toBe(uiDatetime.isIsoDateTime(text));
		expect(formatDateTimeText(text)).toBe(uiDatetime.formatDateTimeText(text));
	});
	it.each([
		['09:15', 15],
		['09:10', 15],
		['23:45', 25],
		['23:59', 25],
		['12:00', 0],
		['12:00', 1.5],
		['12:00', undefined]
	] as [string, number | undefined][])('isOnTimeStep(%j, %j) is the same as ui', (time, step) => {
		expect(isOnTimeStep(time, step)).toBe(uiDatetime.isOnTimeStep(time, step));
	});
	it('the checks refuse non-strings', () => {
		expect(isIsoTime(930)).toBe(false);
		expect(isIsoDateTime(null)).toBe(false);
	});
});

describe('the edge-case table shared with Rust (datetime-cases.json)', () => {
	const check: Record<string, (value: string) => boolean> = {
		date: isIsoDate,
		time: isIsoTime,
		datetime: isIsoDateTime
	};
	it.each(cases.canonical)('$type $value is canonical: $valid', ({ type, value, valid }) => {
		expect(check[type](value)).toBe(valid);
		expect(check[type](value)).toBe(
			type === 'date'
				? uiDatetime.isIsoDate(value)
				: type === 'time'
					? uiDatetime.isIsoTime(value)
					: uiDatetime.isIsoDateTime(value)
		);
	});

	it.each(cases.rules)('validateField: $type $value -> $error', (rule) => {
		const { type, value, error } = rule;
		const { min, max, step } = rule as { min?: string; max?: string; step?: number };
		const def: FieldDef = { name: 'f', label: 'F', type: type as FieldType, min, max, step };
		expect(validateField(def, value, {})).toBe(error);
	});
});

describe('validateField for time / datetime', () => {
	it('empty is not checked unless required; a number bound is ignored', () => {
		expect(validateField({ ...at, min: 9 }, null, {})).toBeNull();
		expect(validateField({ ...at, required: true }, null, {})).toBe('必須項目です');
		expect(validateField({ ...at, min: 9 }, '08:00', {})).toBeNull();
	});

	it('a datetime on a disabled day is refused with the date message', () => {
		const weekend = (date: string) => date === '2026-11-07';
		const def: FieldDef = { ...starts, isDateDisabled: weekend };
		expect(validateField(def, '2026-11-07T09:00', {})).toBe('この日付は選べません');
		expect(validateField(def, '2026-11-06T09:00', {})).toBeNull();
	});

	it('messages are overridable', () => {
		const messages = {
			timeInvalid: () => 'bad time',
			timeStep: (_def: FieldDef, step: number) => `every ${step}`,
			dateTimeMin: (_def: FieldDef, min: string) => `from ${min}`
		};
		expect(validateField(at, 'x', {}, messages)).toBe('bad time');
		expect(validateField({ ...at, step: 15 }, '09:10', {}, messages)).toBe('every 15');
		expect(
			validateField({ ...starts, min: '2026-11-07T09:00' }, '2026-11-07T08:00', {}, messages)
		).toBe('from 2026-11-07 09:00');
	});
});

describe('empty time / datetime is null (D6) and the draft normalises text', () => {
	const schema: FormSchema = { fields: [at, starts] };

	it('the store and the draft start with null', () => {
		expect(createFormStore(schema).values).toEqual({ at: null, starts: null });
		expect(createFormDraft({ key: 'k', schema }).values).toEqual({ at: null, starts: null });
	});

	it('commit normalises lenient text; blank is null; an invalid text is an error', () => {
		const draft = createFormDraft({ key: 'k', schema });
		draft.setRaw('at', '930');
		expect(draft.commit('at')).toBe(true);
		expect(draft.values.at).toBe('09:30');
		draft.setRaw('starts', '2026/11/7 9:30');
		expect(draft.commit('starts')).toBe(true);
		expect(draft.values.starts).toBe('2026-11-07T09:30');
		draft.setRaw('starts', ' ');
		expect(draft.commit('starts')).toBe(true);
		expect(draft.values.starts).toBeNull();
		draft.setRaw('at', '24:00');
		expect(draft.commit('at')).toBe(false);
		expect(draft.errors.at).toBe('時刻を HH:mm の形で入力してください');
		draft.setRaw('starts', '2026-11-07');
		expect(draft.commit('starts')).toBe(false);
		expect(draft.errors.starts).toBe('日時を YYYY-MM-DD HH:mm の形で入力してください');
	});

	it('the step is checked after the text parses', () => {
		const draft = createFormDraft({ key: 'k', schema: { fields: [{ ...at, step: 15 }] } });
		draft.setRaw('at', '9:10');
		expect(draft.commit('at')).toBe(false);
		expect(draft.errors.at).toBe('15分刻みの時刻を入力してください');
	});
});

describe('native fallback (D3-a) and the injected inputs (D1-a)', () => {
	const schema: FormSchema = {
		fields: [
			{ ...at, min: '09:00', step: 15 },
			{ ...starts, max: '2026-12-31T18:00', step: 30 }
		]
	};

	it('without injected inputs: native time / datetime-local, step in seconds', () => {
		const store = createFormStore(schema, { at: '09:15', starts: '2026-11-07T09:30' });
		render(FieldInputsHarness, { schema, store });
		const time = screen.getByLabelText('At') as HTMLInputElement;
		const dateTime = screen.getByLabelText('Starts') as HTMLInputElement;
		expect(time.type).toBe('time');
		expect(time.min).toBe('09:00');
		expect(time.step).toBe('900');
		expect(time.value).toBe('09:15');
		expect(dateTime.type).toBe('datetime-local');
		expect(dateTime.max).toBe('2026-12-31T18:00');
		expect(dateTime.step).toBe('1800');
		expect(dateTime.value).toBe('2026-11-07T09:30');
	});

	it('each type gets its own injected input (FormStore path)', () => {
		const store = createFormStore(schema, { at: '09:15', starts: '2026-11-07T09:30' });
		render(FieldInputsHarness, {
			providedInputs: { time: TimeInput, datetime: DateTimeInput },
			schema,
			store
		});
		const time = screen.getByLabelText(/^At/) as HTMLInputElement;
		const dateTime = screen.getByLabelText(/^Starts/) as HTMLInputElement;
		expect(time.getAttribute('role')).toBe('combobox');
		expect(dateTime.classList.contains('datetime-input-text')).toBe(true);
		expect(dateTime.value).toBe('2026-11-07 09:30');

		dateTime.focus();
		fireEvent.input(dateTime, { target: { value: '2026/12/24 18:30' } });
		flushSync();
		screen.getByRole('button', { name: 'Outside' }).focus();
		flushSync();
		expect(store.values.starts).toBe('2026-12-24T18:30');
		expect(dateTime.value).toBe('2026-12-24 18:30');
		expect(store.errors.starts).toBeUndefined();

		dateTime.focus();
		fireEvent.input(dateTime, { target: { value: '2026-12-31 18:30' } });
		flushSync();
		screen.getByRole('button', { name: 'Outside' }).focus();
		flushSync();
		expect(store.values.starts).toBe('2026-12-31T18:30');
		expect(store.errors.starts).toBe('2026-12-31 18:00以前の日時を入力してください');
	});

	it('typing the canonical form is not rewritten mid-typing; blur shows it with a space', () => {
		const store = createFormStore(schema);
		render(FieldInputsHarness, { providedInputs: { datetime: DateTimeInput }, schema, store });
		const dateTime = screen.getByLabelText(/^Starts/) as HTMLInputElement;
		dateTime.focus();
		fireEvent.input(dateTime, { target: { value: '2026-11-07T09:30' } });
		flushSync();
		expect(store.values.starts).toBe('2026-11-07T09:30');
		expect(dateTime.value).toBe('2026-11-07T09:30');
		screen.getByRole('button', { name: 'Outside' }).focus();
		flushSync();
		expect(dateTime.value).toBe('2026-11-07 09:30');
		expect(store.values.starts).toBe('2026-11-07T09:30');
	});

	it('an invalid typed time stays the value and is an error (§5.3)', () => {
		const store = createFormStore(schema, { at: '09:15' });
		render(FieldInputsHarness, { providedInputs: { time: TimeInput }, schema, store });
		const time = screen.getByLabelText(/^At/) as HTMLInputElement;
		time.focus();
		fireEvent.input(time, { target: { value: '9:10' } });
		flushSync();
		screen.getByRole('button', { name: 'Outside' }).focus();
		flushSync();
		expect(store.values.at).toBe('09:10');
		expect(store.errors.at).toBe('15分刻みの時刻を入力してください');
	});

	it('an off-grid min leaves the native step off (native steps count from min)', () => {
		const offGrid: FormSchema = {
			fields: [
				{ ...at, min: '09:10', step: 15 },
				{ ...starts, min: '2026-11-02T09:10', step: 30 }
			]
		};
		render(FieldInputsHarness, { schema: offGrid, store: createFormStore(offGrid) });
		expect((screen.getByLabelText('At') as HTMLInputElement).hasAttribute('step')).toBe(false);
		expect((screen.getByLabelText('Starts') as HTMLInputElement).hasAttribute('step')).toBe(false);
	});

	it('the date input is not given to a time field', () => {
		const store = createFormStore(schema);
		render(FieldInputsHarness, { providedInputs: { date: TimeInput }, schema, store });
		expect((screen.getByLabelText('At') as HTMLInputElement).type).toBe('time');
	});
});

describe('DraftDateField for a datetime (FormDraft path)', () => {
	it('shows the committed value with a space and commits typed text once', () => {
		const draft = createFormDraft({
			key: 'k',
			schema: { fields: [starts] },
			initial: { starts: '2026-11-07T09:30' }
		});
		const onCommit = vi.fn();
		render(FieldInputsHarness, {
			providedInputs: { datetime: DateTimeInput },
			draft,
			draftDef: starts,
			onCommit
		});
		const input = screen.getByLabelText('Starts') as HTMLInputElement;
		expect(input.value).toBe('2026-11-07 09:30');
		input.focus();
		fireEvent.input(input, { target: { value: '11/8 10' } });
		flushSync();
		screen.getByRole('button', { name: 'Outside' }).focus();
		flushSync();
		expect(draft.values.starts).toBe(`${new Date().getFullYear()}-11-08T10:00`);
		expect(draft.raw.starts).toBeUndefined();
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenLastCalledWith(true);
	});
});
