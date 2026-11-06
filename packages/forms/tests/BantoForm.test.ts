// @vitest-environment jsdom
/**
 * BantoForm component test (spec §7.3, improvement-plan P3-3): mount + basic
 * interaction only. The validation RULES themselves are covered by the
 * headless validate.ts tests; here we prove the component renders one field
 * per schema entry, wires input back to the store, blocks submit on invalid
 * input while surfacing the error, and submits the collected values when
 * valid.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, type ComponentProps } from 'svelte';
import BantoForm from '../src/BantoForm.svelte';
import { createFormStore } from '../src/store.svelte';
import type { FieldDef, FormSchema } from '../src/types';

afterEach(cleanup);

const schema: FormSchema = {
	fields: [
		{ name: 'name', label: '商品名', type: 'text', required: true, min: 1, max: 40 },
		{ name: 'note', label: '備考', type: 'text' }
	]
};

describe.each(['default', 'underline'] as const)('BantoForm (%s)', (appearance) => {
	const renderForm = (props: ComponentProps<typeof BantoForm>) =>
		render(BantoForm, {
			...props,
			appearance: appearance === 'underline' ? appearance : undefined
		});
	it('renders one labelled field per schema entry and a submit button', () => {
		renderForm({ schema, store: createFormStore(schema), onSubmit: vi.fn() });

		expect(screen.getByText('商品名')).toBeTruthy();
		expect(screen.getByText('備考')).toBeTruthy();
		// The generated input id remains associated with its visible label.
		expect(screen.getByLabelText(/商品名/)).toBeTruthy();
		const control = screen.getByLabelText(/商品名/);
		expect(control.classList.contains('banto-field-control')).toBe(appearance === 'underline');
		expect(control.closest('label')?.classList.contains('banto-field--stacked') ?? false).toBe(
			appearance === 'underline'
		);
		expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
	});

	it('writes input back into the store', async () => {
		const store = createFormStore(schema);
		renderForm({ schema, store, onSubmit: vi.fn() });

		await fireEvent.input(screen.getByLabelText(/商品名/), { target: { value: 'ペン' } });

		expect(store.values.name).toBe('ペン');
	});

	it('submits collected values when valid', async () => {
		const store = createFormStore(schema);
		const onSubmit = vi.fn();
		renderForm({ schema, store, onSubmit });

		await fireEvent.input(screen.getByLabelText(/商品名/), { target: { value: 'ペン' } });
		await fireEvent.click(screen.getByRole('button', { name: '保存' }));

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'ペン' }));
	});

	it('blocks submit and surfaces the error when a required field is empty', async () => {
		const store = createFormStore(schema);
		const onSubmit = vi.fn();
		renderForm({ schema, store, onSubmit });

		await fireEvent.click(screen.getByRole('button', { name: '保存' }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(await screen.findByText('必須項目です')).toBeTruthy();
		// aria-invalid is reflected onto the field for assistive tech.
		expect(screen.getByLabelText(/商品名/).getAttribute('aria-invalid')).toBe('true');
		const input = screen.getByLabelText(/商品名/);
		const error = document.getElementById(input.getAttribute('aria-describedby')!);
		expect(error?.textContent).toBe('必須項目です');
	});

	it('disables inputs and submit while submitting', () => {
		renderForm({
			schema,
			store: createFormStore(schema),
			onSubmit: vi.fn(),
			submitting: true
		});

		expect((screen.getByLabelText(/商品名/) as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('keeps labels and server errors local to each form, including unusual field names', () => {
		const fields: FieldDef[] = [
			{ name: 'shared key', label: 'Text', type: 'text' },
			{ name: 'x', label: 'Password', type: 'password' },
			{ name: 'x-error', label: 'Notes', type: 'textarea' },
			{ name: 'qty', label: 'Quantity', type: 'number' },
			{ name: 'day', label: 'Day', type: 'date' },
			{ name: 'choice', label: 'Choice', type: 'select', options: [{ value: 0, label: 'Zero' }] },
			{ name: 'enabled', label: 'Enabled', type: 'checkbox' }
		];
		const names = fields.map((field) => field.name);
		const sharedSchema = { fields };
		const stores = [createFormStore(sharedSchema), createFormStore(sharedSchema)];
		const forms = stores.map((store) =>
			renderForm({ schema: sharedSchema, store, onSubmit: vi.fn() })
		);
		const ids: string[] = [];
		flushSync(() => {
			stores.forEach((store, index) =>
				store.setServerErrors(
					fields.map((field) => ({ field: field.name, message: `${index}: ${field.label}` }))
				)
			);
		});
		forms.forEach(({ container }, index) => {
			fields.forEach((field) => {
				const control = within(container).getByLabelText(field.label);
				const errorId = control.getAttribute('aria-describedby')!;
				expect(errorId).not.toMatch(/\s/);
				const error = document.getElementById(errorId)!;
				expect(container.contains(error)).toBe(true);
				expect(error.textContent).toBe(`${index}: ${field.label}`);
				expect(control.getAttribute('aria-invalid')).toBe('true');
				expect(control.closest('label')?.contains(error) ?? false).toBe(false);
				expect(control.classList.contains('banto-field-control')).toBe(
					appearance === 'underline' && field.type !== 'checkbox'
				);
				ids.push(control.id, errorId);
			});
		});
		expect(new Set(ids).size).toBe(ids.length);
		expect(fields.map((field) => field.name)).toEqual(names);

		const control = within(forms[0].container).getByLabelText('Text');
		const oldErrorId = control.getAttribute('aria-describedby')!;
		flushSync(() => stores[0].setValue('shared key', 'corrected'));
		expect(control.getAttribute('aria-describedby')).toBeNull();
		expect(control.getAttribute('aria-invalid')).toBe('false');
		expect(document.getElementById(oldErrorId)).toBeNull();
		expect(within(forms[1].container).getByLabelText('Text').getAttribute('aria-invalid')).toBe(
			'true'
		);
	});

	it.each([
		['text', 'stored text'],
		['password', 'stored password'],
		['textarea', 'stored notes'],
		['number', 12],
		['date', '2026-11-04'],
		['select', 'a'],
		['checkbox', true]
	] as const)(
		'preserves readonly %s values and errors on interaction, and still submits the value',
		async (type, value) => {
			const readonlySchema: FormSchema = {
				fields: [
					{
						name: 'value',
						label: 'Stored',
						type,
						readonly: true,
						options: [{ value: 'a', label: 'A' }]
					}
				]
			};
			const store = createFormStore(readonlySchema, { value });
			store.setServerErrors([{ field: 'value', message: 'Server error' }]);
			const onSubmit = vi.fn();
			renderForm({ schema: readonlySchema, store, onSubmit });
			const control = screen.getByLabelText('Stored') as
				HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
			const nativeReadonly = type !== 'select' && type !== 'checkbox';
			expect(control.disabled).toBe(!nativeReadonly);
			if (nativeReadonly) {
				expect((control as HTMLInputElement).readOnly).toBe(true);
				control.focus();
				expect(document.activeElement).toBe(control);
			}
			// Synthetic events also exercise callbacks that native readonly/disabled normally blocks.
			await fireEvent.input(control, { target: { value: type === 'date' ? '2027-01-01' : '99' } });
			await fireEvent.change(control, {
				target: type === 'checkbox' ? { checked: false } : { value: 'b' }
			});
			await fireEvent.blur(control);
			expect(store.values.value).toBe(value);
			expect(store.touched).toEqual({});
			expect(store.errors).toEqual({ value: 'Server error' });
			await fireEvent.click(screen.getByRole('button', { name: '保存' }));
			expect(onSubmit).toHaveBeenCalledWith({ value });
		}
	);

	it('still validates readonly values on submit', async () => {
		const readonlySchema: FormSchema = {
			fields: [{ name: 'qty', label: 'Quantity', type: 'number', readonly: true, min: 5 }]
		};
		const store = createFormStore(readonlySchema, { qty: 1 });
		const onSubmit = vi.fn();
		renderForm({ schema: readonlySchema, store, onSubmit });
		await fireEvent.click(screen.getByRole('button', { name: '保存' }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(store.errors.qty).toBe('5以上で入力してください');
		expect(screen.getByLabelText('Quantity').getAttribute('aria-describedby')).toBeTruthy();
	});
});
