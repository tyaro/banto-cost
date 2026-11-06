import { describe, expect, it } from 'vitest';
import { validateAll, validateField } from '../src/validate';
import type { FieldDef, FormSchema } from '../src/types';

describe('validateField', () => {
	it('required: empty values fail, present values pass', () => {
		const def: FieldDef = { name: 'name', label: 'Name', type: 'text', required: true };
		expect(validateField(def, '', {})).toBe('必須項目です');
		expect(validateField(def, undefined, {})).toBe('必須項目です');
		expect(validateField(def, null, {})).toBe('必須項目です');
		expect(validateField(def, 'a', {})).toBeNull();
	});

	it('number min/max', () => {
		const def: FieldDef = { name: 'price', label: 'Price', type: 'number', min: 0, max: 100 };
		expect(validateField(def, -1, {})).toBe('0以上で入力してください');
		expect(validateField(def, 101, {})).toBe('100以下で入力してください');
		expect(validateField(def, 50, {})).toBeNull();
	});

	it('text/textarea length min/max', () => {
		const def: FieldDef = { name: 'name', label: 'Name', type: 'text', min: 2, max: 4 };
		expect(validateField(def, 'a', {})).toBe('2文字以上で入力してください');
		expect(validateField(def, 'abcde', {})).toBe('4文字以内で入力してください');
		expect(validateField(def, 'abc', {})).toBeNull();
	});

	it('password length min (M10 RBAC user-management create form)', () => {
		const def: FieldDef = {
			name: 'password',
			label: 'Password',
			type: 'password',
			required: true,
			min: 8
		};
		expect(validateField(def, '', {})).toBe('必須項目です');
		expect(validateField(def, 'short1', {})).toBe('8文字以上で入力してください');
		expect(validateField(def, 'longenough1', {})).toBeNull();
	});

	it('pattern', () => {
		const def: FieldDef = { name: 'code', label: 'Code', type: 'text', pattern: '^[A-Z]{3}$' };
		expect(validateField(def, 'abc', {})).toBe('形式が正しくありません');
		expect(validateField(def, 'ABC', {})).toBeNull();
	});

	it('custom validate function', () => {
		const def: FieldDef = {
			name: 'confirm',
			label: 'Confirm',
			type: 'text',
			validate: (value, values) => (value !== values.password ? 'パスワードが一致しません' : null)
		};
		expect(validateField(def, 'a', { password: 'b' })).toBe('パスワードが一致しません');
		expect(validateField(def, 'b', { password: 'b' })).toBeNull();
	});

	it('messages are overridable', () => {
		const def: FieldDef = { name: 'name', label: 'Name', type: 'text', required: true };
		expect(validateField(def, '', {}, { required: () => 'required!' })).toBe('required!');
	});

	it('skips min/max/pattern checks for empty optional values', () => {
		const def: FieldDef = { name: 'name', label: 'Name', type: 'text', min: 2 };
		expect(validateField(def, '', {})).toBeNull();
	});

	it('coerces string numeric input for number fields', () => {
		const def: FieldDef = { name: 'price', label: 'Price', type: 'number', min: 10 };
		expect(validateField(def, '5', {})).toBe('10以上で入力してください');
		expect(validateField(def, '20', {})).toBeNull();
	});

	it('required: whitespace-only strings are trimmed before the emptiness check', () => {
		const def: FieldDef = { name: 'name', label: 'Name', type: 'text', required: true };
		expect(validateField(def, '   ', {})).toBe('必須項目です');
		expect(validateField(def, '\t\n ', {})).toBe('必須項目です');
		expect(validateField(def, '  a  ', {})).toBeNull();
	});

	it('required: falsy non-string values (0, false) are not treated as empty', () => {
		const numberDef: FieldDef = { name: 'stock', label: 'Stock', type: 'number', required: true };
		expect(validateField(numberDef, 0, {})).toBeNull();
		const checkboxDef: FieldDef = { name: 'flag', label: 'Flag', type: 'checkbox', required: true };
		expect(validateField(checkboxDef, false, {})).toBeNull();
	});

	it('text max length is checked against the trimmed length', () => {
		const def: FieldDef = { name: 'name', label: 'Name', type: 'text', max: 4 };
		expect(validateField(def, 'abcd   ', {})).toBeNull();
		expect(validateField(def, 'abcde   ', {})).toBe('4文字以内で入力してください');
	});

	it('text min length is checked against the trimmed length', () => {
		const def: FieldDef = { name: 'name', label: 'Name', type: 'text', min: 3 };
		expect(validateField(def, '  ab  ', {})).toBe('3文字以上で入力してください');
		expect(validateField(def, '  abc  ', {})).toBeNull();
	});
});

describe('validateAll', () => {
	it('collects one FieldError per invalid field, in schema order', () => {
		const schema: FormSchema = {
			fields: [
				{ name: 'name', label: 'Name', type: 'text', required: true },
				{ name: 'price', label: 'Price', type: 'number', min: 0 }
			]
		};
		const errors = validateAll(schema, { name: '', price: -5 });
		expect(errors).toEqual([
			{ field: 'name', message: '必須項目です' },
			{ field: 'price', message: '0以上で入力してください' }
		]);
	});

	it('returns an empty array when all fields are valid', () => {
		const schema: FormSchema = {
			fields: [{ name: 'name', label: 'Name', type: 'text', required: true }]
		};
		expect(validateAll(schema, { name: 'ok' })).toEqual([]);
	});
});
