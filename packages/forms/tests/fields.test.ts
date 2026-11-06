// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TextField from '../src/fields/TextField.svelte';
import PasswordField from '../src/fields/PasswordField.svelte';
import TextareaField from '../src/fields/TextareaField.svelte';
import NumberField from '../src/fields/NumberField.svelte';
import DateField from '../src/fields/DateField.svelte';
import SelectField from '../src/fields/SelectField.svelte';
import CheckboxField from '../src/fields/CheckboxField.svelte';
import DraftNumberField from '../src/fields/DraftNumberField.svelte';
import { createFormDraft } from '../src/draft.svelte';
import type { FieldDef } from '../src/types';

afterEach(cleanup);

describe('standalone fields', () => {
	it.each([
		['text', (def: FieldDef) => render(TextField, { def, value: '', onInput: vi.fn() })],
		['password', (def: FieldDef) => render(PasswordField, { def, value: '', onInput: vi.fn() })],
		['textarea', (def: FieldDef) => render(TextareaField, { def, value: '', onInput: vi.fn() })],
		['number', (def: FieldDef) => render(NumberField, { def, value: '', onInput: vi.fn() })],
		['date', (def: FieldDef) => render(DateField, { def, value: '', onInput: vi.fn() })],
		['select', (def: FieldDef) => render(SelectField, { def, value: '', onInput: vi.fn() })],
		['checkbox', (def: FieldDef) => render(CheckboxField, { def, value: false, onInput: vi.fn() })]
	] as const)(
		'%s keeps its default label target and accepts custom id and descriptions',
		async (type, renderField) => {
			const def: FieldDef = { name: 'original', label: 'Value', type };
			const view = renderField(def);
			const control = view.container.querySelector('input, textarea, select')!;
			expect(control.id).toBe('original');
			expect(control.getAttribute('aria-describedby')).toBeNull();
			await view.rerender({
				id: 'custom-id',
				class: 'custom-control',
				'aria-describedby': 'help-id error-id'
			});
			expect(control.id).toBe('custom-id');
			expect(control.classList.contains('custom-control')).toBe(true);
			await view.rerender({ def: { ...def, readonly: true } });
			expect(control.classList.contains('custom-control')).toBe(true);
			expect(control.classList.contains('muted')).toBe(true);
			expect(control.getAttribute('aria-describedby')).toBe('help-id error-id');
			expect(def.name).toBe('original');
		}
	);

	it('keeps an explicit disabled field disabled without making it readonly', async () => {
		const onInput = vi.fn();
		const onBlur = vi.fn();
		render(TextField, {
			def: { name: 'disabled', label: 'Disabled', type: 'text' },
			value: 'stored',
			disabled: true,
			onInput,
			onBlur
		});
		const control = screen.getByRole('textbox') as HTMLInputElement;
		expect(control.disabled).toBe(true);
		expect(control.readOnly).toBe(false);
		await fireEvent.input(control, { target: { value: 'changed' } });
		await fireEvent.blur(control);
		expect(onInput).not.toHaveBeenCalled();
		expect(onBlur).not.toHaveBeenCalled();
	});
});

describe('DraftNumberField', () => {
	const def: FieldDef = { name: 'qty', label: 'Quantity', type: 'number', max: 10 };
	const setup = () =>
		createFormDraft({ key: 'memo', schema: { fields: [def] }, initial: { qty: 1 } });

	it('accepts a custom id and description without changing the draft key', async () => {
		const draft = setup();
		const view = render(DraftNumberField, { def, draft });
		const control = screen.getByRole('textbox');
		expect(control.id).toBe('qty');
		await view.rerender({ id: 'draft-qty', class: 'custom-draft', 'aria-describedby': 'qty-help' });
		expect(control.id).toBe('draft-qty');
		expect(control.classList.contains('custom-draft')).toBe(true);
		expect(control.getAttribute('aria-describedby')).toBe('qty-help');
		await fireEvent.input(control, { target: { value: '7' } });
		expect(draft.raw.qty).toBe('7');
	});

	it('ignores composing Enter and commits on ordinary Enter', async () => {
		const draft = setup();
		const onCommit = vi.fn();
		render(DraftNumberField, { def, draft, onCommit });
		const control = screen.getByRole('textbox');
		await fireEvent.input(control, { target: { value: '7' } });
		await fireEvent.keyDown(control, { key: 'Enter', isComposing: true });
		expect(draft.values.qty).toBe(1);
		expect(onCommit).not.toHaveBeenCalled();
		await fireEvent.keyDown(control, { key: 'Enter' });
		expect(draft.values.qty).toBe(7);
		expect(onCommit).toHaveBeenCalledExactlyOnceWith(true);
	});

	it.each(['readonly', 'disabled'] as const)(
		'preserves an invalid draft when changed to %s before blur',
		async (mode) => {
			const draft = setup();
			const onCommit = vi.fn();
			const view = render(DraftNumberField, { def, draft, onCommit });
			const control = screen.getByRole('textbox') as HTMLInputElement;
			await fireEvent.input(control, { target: { value: '1e' } });
			await fireEvent.keyDown(control, { key: 'Enter' });
			expect(draft.errors.qty).toBeTruthy();
			const snapshot = () => ({
				values: { ...draft.values },
				raw: { ...draft.raw },
				errors: { ...draft.errors },
				baseline: { ...draft.baseline },
				revision: draft.revision,
				dirty: draft.dirty
			});
			const before = snapshot();
			onCommit.mockClear();
			await view.rerender({
				def: { ...def, readonly: mode === 'readonly' },
				disabled: mode === 'disabled'
			});
			expect(control.readOnly).toBe(mode === 'readonly');
			expect(control.disabled).toBe(mode === 'disabled');
			await fireEvent.input(control, { target: { value: '8' } });
			await fireEvent.keyDown(control, { key: 'Enter' });
			await fireEvent.blur(control);
			expect(snapshot()).toEqual(before);
			expect(onCommit).not.toHaveBeenCalled();
			await view.rerender({ def, disabled: false });
			await fireEvent.input(control, { target: { value: '8' } });
			await fireEvent.blur(control);
			expect(draft.values.qty).toBe(8);
			expect(onCommit).toHaveBeenCalledExactlyOnceWith(true);
		}
	);
});
