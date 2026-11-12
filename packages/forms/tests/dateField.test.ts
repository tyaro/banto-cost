// @vitest-environment jsdom
/**
 * Dates in schema forms (date-time-pickers §5.3 / §5.6 / §5.7, PR-3): the
 * format / `min` / `max` / disabled-day checks, `null` for an empty date (D6),
 * the draft's normalisation of typed text, and the injected date input
 * (`provideFieldInputs` / `fieldInputs`, D1-a) with the native fallback (D3-a).
 *
 * The integration cases inject the real `@banto/ui` `DateInput` (a relative
 * import - a test may read another package's source; `src` may not,
 * conventions §4), so the blur / Enter commit and the focus rules of PR-1 are
 * exercised through forms. jsdom has no Popover API: the stand-in from the ui
 * tests is installed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as uiDatetime from '../../ui/src/datetime';
import DateInput from '../../ui/src/DateInput.svelte';
import { isIsoDate, parseDateText } from '../src/date';
import { createFormDraft } from '../src/draft.svelte';
import DateField from '../src/fields/DateField.svelte';
import { createFormStore } from '../src/store.svelte';
import type { FieldDef, FormSchema } from '../src/types';
import { validateField } from '../src/validate';
import FieldInputsHarness from './FieldInputsHarness.svelte';
import StubDateInput from './StubDateInput.svelte';

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

const due: FieldDef = { name: 'due', label: 'Due', type: 'date' };

describe('date parsing mirrors @banto/ui datetime.ts', () => {
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
		'2026-13-01',
		'0000-01-01',
		'9999-12-31',
		'11/07/2026',
		'2026-11',
		'abc',
		''
	];
	it.each(typed)('parseDateText(%j) is the same as ui', (text) => {
		expect(parseDateText(text, 2026)).toBe(uiDatetime.parseDateText(text, 2026));
	});
	it.each(typed)('isIsoDate(%j) is the same as ui', (text) => {
		expect(isIsoDate(text)).toBe(uiDatetime.isIsoDate(text));
	});
	it('isIsoDate refuses non-strings', () => {
		expect(isIsoDate(20261107)).toBe(false);
		expect(isIsoDate(null)).toBe(false);
	});
});

describe('validateField for date', () => {
	it('needs a canonical real day; empty is fine unless required', () => {
		expect(validateField(due, '2026-11-07', {})).toBeNull();
		expect(validateField(due, null, {})).toBeNull();
		expect(validateField(due, '', {})).toBeNull();
		expect(validateField(due, '2026/11/7', {})).toBe('日付を YYYY-MM-DD の形で入力してください');
		expect(validateField(due, '2026-02-30', {})).toBe('日付を YYYY-MM-DD の形で入力してください');
		expect(validateField(due, 20261107, {})).toBe('日付を YYYY-MM-DD の形で入力してください');
		expect(validateField({ ...due, required: true }, null, {})).toBe('必須項目です');
	});

	it('min / max are canonical strings, inclusive (D9)', () => {
		const def: FieldDef = { ...due, min: '2026-11-02', max: '2026-11-27' };
		expect(validateField(def, '2026-11-02', {})).toBeNull();
		expect(validateField(def, '2026-11-27', {})).toBeNull();
		expect(validateField(def, '2026-11-01', {})).toBe('2026-11-02以降の日付を入力してください');
		expect(validateField(def, '2026-11-28', {})).toBe('2026-11-27以前の日付を入力してください');
	});

	it('isDateDisabled refuses a day; the custom validate runs last', () => {
		const validate = vi.fn(() => null);
		const def: FieldDef = { ...due, isDateDisabled: (d) => d === '2026-11-07', validate };
		expect(validateField(def, '2026-11-07', {})).toBe('この日付は選べません');
		expect(validate).not.toHaveBeenCalled();
		expect(validateField(def, '2026-11-08', {})).toBeNull();
		expect(validate).toHaveBeenCalledWith('2026-11-08', {});
	});

	it('a bound of the other kind is ignored', () => {
		expect(validateField({ ...due, min: 5 }, '2026-11-07', {})).toBeNull();
		const qty: FieldDef = { name: 'qty', label: 'Qty', type: 'number', min: '2026-01-01' };
		expect(validateField(qty, 1, {})).toBeNull();
		const text: FieldDef = { name: 'name', label: 'Name', type: 'text', max: 'x' };
		expect(validateField(text, 'long enough', {})).toBeNull();
	});

	it('messages can be overridden', () => {
		const def: FieldDef = { ...due, min: '2026-11-02' };
		const messages = {
			dateInvalid: () => 'bad',
			dateMin: (_d: FieldDef, min: string) => `>= ${min}`
		};
		expect(validateField(def, 'x', {}, messages)).toBe('bad');
		expect(validateField(def, '2026-11-01', {}, messages)).toBe('>= 2026-11-02');
	});
});

describe('empty date is null (D6)', () => {
	const schema: FormSchema = { fields: [due, { name: 'note', label: 'Note', type: 'text' }] };

	it('FormStore and FormDraft default a date to null', () => {
		expect(createFormStore(schema).values).toEqual({ due: null, note: '' });
		expect(createFormDraft({ key: 'k', schema }).values).toEqual({ due: null, note: '' });
	});

	it('the native DateField reports null when cleared, the date otherwise', async () => {
		const onInput = vi.fn();
		const { container } = render(DateField, {
			def: { ...due, min: '2026-01-01', max: 7 },
			value: '2026-11-07',
			onInput
		});
		const input = container.querySelector('input')!;
		expect(input.type).toBe('date');
		expect(input.min).toBe('2026-01-01');
		expect(input.max).toBe('');
		await fireEvent.input(input, { target: { value: '' } });
		expect(onInput).toHaveBeenLastCalledWith(null);
		await fireEvent.input(input, { target: { value: '2026-11-08' } });
		expect(onInput).toHaveBeenLastCalledWith('2026-11-08');
	});
});

describe('FormDraft normalises date text on commit (§5.3)', () => {
	const schema: FormSchema = { fields: [{ ...due, max: '2026-12-31' }] };

	it('lenient text -> canonical, blank -> null, unparsable stays raw with an error', () => {
		const draft = createFormDraft({ key: 'k', schema });
		draft.setRaw('due', '２０２６／１１／７');
		expect(draft.commit('due')).toBe(true);
		expect(draft.values.due).toBe('2026-11-07');
		expect(draft.raw.due).toBeUndefined();

		draft.setRaw('due', ' ');
		expect(draft.commit('due')).toBe(true);
		expect(draft.values.due).toBeNull();

		draft.setRaw('due', '2026/13/1');
		expect(draft.commit('due')).toBe(false);
		expect(draft.raw.due).toBe('2026/13/1');
		expect(draft.errors.due).toBe('日付を YYYY-MM-DD の形で入力してください');
		expect(draft.values.due).toBeNull();
	});

	it('the parsed day is validated (max) and commitAll does the same', () => {
		const draft = createFormDraft({ key: 'k', schema });
		draft.setRaw('due', '2027/1/1');
		expect(draft.commit('due')).toBe(false);
		expect(draft.errors.due).toBe('2026-12-31以前の日付を入力してください');
		draft.setRaw('due', '2026/1/1');
		expect(draft.commitAll()).toBe(true);
		expect(draft.values.due).toBe('2026-01-01');
	});
});

describe('injected date input (D1-a) and the native fallback (D3-a)', () => {
	const schema: FormSchema = { fields: [{ ...due, min: '2026-11-02', max: 9 }] };

	it('without an injected input the form keeps the native input', () => {
		const store = createFormStore(schema);
		render(FieldInputsHarness, { schema, store });
		expect((screen.getByLabelText('Due') as HTMLInputElement).type).toBe('date');
	});

	it('the provided input is used, gets the label target and only string bounds', () => {
		const store = createFormStore(schema);
		render(FieldInputsHarness, { provided: StubDateInput, schema, store });
		const input = screen.getByLabelText('Due');
		expect(input.dataset.testid).toBe('stub-date');
		expect(input.dataset.min).toBe('2026-11-02');
		expect(input.dataset.max).toBeUndefined();
	});

	it('the fieldInputs prop wins over the context', () => {
		const store = createFormStore(schema);
		render(FieldInputsHarness, {
			provided: StubDateInput,
			fieldInputs: { date: DateInput },
			schema,
			store
		});
		const input = screen.getByLabelText('Due');
		expect(input.dataset.testid).toBeUndefined();
		expect(input.classList.contains('date-input-text')).toBe(true);
	});
});

describe('BantoForm with @banto/ui DateInput injected (FormStore path)', () => {
	const schema: FormSchema = { fields: [{ ...due, required: true }] };

	function setup(initial?: Record<string, unknown>) {
		const store = createFormStore(schema, initial);
		const onSubmit = vi.fn();
		render(FieldInputsHarness, { provided: DateInput, schema, store, onSubmit });
		const input = screen.getByLabelText(/^Due/) as HTMLInputElement;
		const outside = screen.getByRole('button', { name: 'Outside' });
		return { store, onSubmit, input, outside };
	}

	function type(input: HTMLInputElement, text: string) {
		input.focus();
		fireEvent.input(input, { target: { value: text } });
		flushSync();
	}

	it('typed text is normalised on blur and validated once focus leaves', () => {
		const { store, input, outside } = setup();
		type(input, '2026/11/7');
		expect(store.values.due).toBe('2026/11/7');
		outside.focus();
		flushSync();
		expect(input.value).toBe('2026-11-07');
		expect(store.values.due).toBe('2026-11-07');
		expect(store.errors.due).toBeUndefined();
		expect(store.touched.due).toBe(true);
	});

	it('text that does not parse stays the value and is an error, never the old date (§5.3)', () => {
		const { store, input, outside } = setup({ due: '2026-11-07' });
		type(input, '2026/02/30');
		outside.focus();
		flushSync();
		expect(input.value).toBe('2026/02/30');
		expect(store.values.due).toBe('2026/02/30');
		expect(store.errors.due).toBe('日付を YYYY-MM-DD の形で入力してください');
		expect(input.getAttribute('aria-invalid')).toBe('true');
		const errorId = input.getAttribute('aria-describedby')!.split(' ').pop()!;
		expect(document.getElementById(errorId)?.textContent).toBe(store.errors.due);
	});

	it('clearing gives null (D6)', () => {
		const { store, input, outside } = setup({ due: '2026-11-07' });
		type(input, '');
		outside.focus();
		flushSync();
		expect(store.values.due).toBeNull();
		expect(store.errors.due).toBe('必須項目です');
	});

	it('Enter commits the text before the form is submitted', async () => {
		const { onSubmit, input } = setup();
		type(input, '20261107');
		await fireEvent.keyDown(input, { key: 'Enter' });
		await fireEvent.submit(input.closest('form')!);
		expect(onSubmit).toHaveBeenCalledWith({ due: '2026-11-07' });
	});

	it('a day picked in the calendar is the value; focus returns to the text box (D10)', () => {
		const { store, input } = setup({ due: '2026-11-07' });
		fireEvent.click(document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!);
		flushSync();
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		flushSync();
		expect(store.values.due).toBe('2026-11-08');
		expect(document.activeElement).toBe(input);
		// Moving focus into the calendar and back was not a blur of the field.
		expect(store.touched.due).toBeUndefined();
	});
});

describe('DraftDateField with @banto/ui DateInput injected (FormDraft path)', () => {
	const schema: FormSchema = { fields: [due] };

	function setup() {
		const draft = createFormDraft({ key: 'k', schema });
		const onCommit = vi.fn();
		render(FieldInputsHarness, { provided: DateInput, draft, draftDef: due, onCommit });
		const input = screen.getByLabelText('Due') as HTMLInputElement;
		const outside = screen.getByRole('button', { name: 'Outside' });
		return { draft, onCommit, input, outside };
	}

	it('typed text lives in draft.raw and is committed on blur', () => {
		const { draft, onCommit, input, outside } = setup();
		input.focus();
		fireEvent.input(input, { target: { value: '2026/1/2' } });
		flushSync();
		expect(draft.raw.due).toBe('2026/1/2');
		expect(draft.values.due).toBeNull();
		outside.focus();
		flushSync();
		expect(draft.values.due).toBe('2026-01-02');
		expect(draft.raw.due).toBeUndefined();
		expect(input.value).toBe('2026-01-02');
		// One blur, one commit (the component's own commit is not repeated).
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenLastCalledWith(true);
	});

	it('Enter commits typed text once', async () => {
		const { draft, onCommit, input } = setup();
		input.focus();
		fireEvent.input(input, { target: { value: '2026/1/2' } });
		flushSync();
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(draft.values.due).toBe('2026-01-02');
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenLastCalledWith(true);
		// A later blur of the already committed field still validates it (an ordinary blur).
		screen.getByRole('button', { name: 'Outside' }).focus();
		flushSync();
		expect(onCommit).toHaveBeenCalledTimes(2);
	});

	it('unparsable text stays raw with an error after blur', () => {
		const { draft, onCommit, input, outside } = setup();
		input.focus();
		fireEvent.input(input, { target: { value: 'next week' } });
		outside.focus();
		flushSync();
		expect(draft.raw.due).toBe('next week');
		expect(draft.errors.due).toBe('日付を YYYY-MM-DD の形で入力してください');
		expect(input.value).toBe('next week');
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenLastCalledWith(false);
	});

	it('a day picked in the calendar is committed at once', () => {
		const { draft, onCommit, input } = setup();
		input.focus();
		fireEvent.input(input, { target: { value: '2026-11-07' } });
		flushSync();
		fireEvent.click(document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!);
		flushSync();
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
		fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		flushSync();
		expect(draft.values.due).toBe('2026-11-06');
		expect(draft.raw.due).toBeUndefined();
		expect(document.activeElement).toBe(input);
		expect(onCommit).toHaveBeenCalledTimes(1);
	});
});
