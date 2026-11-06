import { describe, expect, it } from 'vitest';
import { createFormStore } from '../src/store.svelte';
import type { FormSchema } from '../src/types';

const schema: FormSchema = {
	fields: [
		{ name: 'name', label: 'Name', type: 'text', required: true, default: '' },
		{ name: 'price', label: 'Price', type: 'number', min: 0, default: 0 }
	]
};

describe('FormStore', () => {
	it('seeds values from field defaults, overridden by initial', () => {
		const store = createFormStore(schema, { name: 'a' });
		expect(store.values).toEqual({ name: 'a', price: 0 });
	});

	it('setValue updates a field and clears its error', () => {
		const store = createFormStore(schema);
		store.validateAll();
		expect(store.errors.name).toBeTruthy();
		store.setValue('name', 'x');
		expect(store.values.name).toBe('x');
		expect(store.errors.name).toBeUndefined();
	});

	it('touch validates just that field', () => {
		const store = createFormStore(schema);
		store.touch('name');
		expect(store.errors.name).toBe('必須項目です');
		expect(store.errors.price).toBeUndefined();
	});

	it('validateAll populates all errors and returns whether the form is valid', () => {
		const store = createFormStore(schema);
		expect(store.validateAll()).toBe(false);
		expect(store.errors.name).toBeTruthy();

		store.setValue('name', 'ok');
		expect(store.validateAll()).toBe(true);
		expect(store.errors).toEqual({});
	});

	it('setServerErrors merges field errors from the server', () => {
		const store = createFormStore(schema);
		store.setServerErrors([{ field: 'name', message: 'サーバー側エラー' }]);
		expect(store.errors.name).toBe('サーバー側エラー');
	});

	it('reset restores defaults/new initial and clears errors/touched', () => {
		const store = createFormStore(schema);
		store.setValue('name', 'x');
		store.touch('name');
		store.reset({ name: 'y' });
		expect(store.values).toEqual({ name: 'y', price: 0 });
		expect(store.errors).toEqual({});
		expect(store.touched).toEqual({});
	});

	it('isDirty reflects whether values differ from the initial snapshot', () => {
		const store = createFormStore(schema, { name: 'a' });
		expect(store.isDirty).toBe(false);
		store.setValue('name', 'b');
		expect(store.isDirty).toBe(true);
		store.setValue('name', 'a');
		expect(store.isDirty).toBe(false);
	});

	// Issue #214: after a successful save the saved values become the new
	// baseline, without clearing what is on screen.
	it('markClean adopts the current values as the clean baseline', () => {
		const store = createFormStore(schema, { name: 'a' });
		store.setValue('name', 'b');
		store.setServerErrors([{ field: 'price', message: 'x' }]);
		store.markClean();
		expect(store.isDirty).toBe(false);
		expect(store.values).toEqual({ name: 'b', price: 0 });
		expect(store.errors.price).toBe('x');
		store.setValue('name', 'a');
		expect(store.isDirty).toBe(true);
	});
});
