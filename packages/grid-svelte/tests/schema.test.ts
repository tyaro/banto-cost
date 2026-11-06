/**
 * columnsFromSchema (spec §3.1, roadmap M23): schema → GridColumn
 * derivation rules, and validator parity with @banto/forms' validateField
 * (same rule order, same Japanese messages).
 */
import { describe, expect, it } from 'vitest';
import { columnsFromSchema, type ColumnsSchema } from '../src/core/schema';

interface Row {
	name: string;
	price: number;
	updatedAt: string;
	category: string;
	active: boolean;
	secret: string;
}

const schema: ColumnsSchema = {
	fields: [
		{ name: 'name', label: '商品名', type: 'text', required: true, min: 1, max: 40 },
		{
			name: 'price',
			label: '価格',
			type: 'number',
			required: true,
			min: 0,
			max: 99999,
			validate: (value) => (Number.isInteger(Number(value)) ? null : '整数で入力してください')
		},
		{ name: 'updatedAt', label: '更新日', type: 'date', readonly: true },
		{
			name: 'category',
			label: 'カテゴリ',
			type: 'select',
			options: [
				{ value: 'a', label: '食品' },
				{ value: 'b', label: '雑貨' }
			]
		},
		{ name: 'active', label: '有効', type: 'checkbox' },
		{ name: 'secret', label: 'パスワード', type: 'password' }
	]
};

const row = {} as Row;

describe('columnsFromSchema', () => {
	const columns = columnsFromSchema<Row>(schema);
	const byId = (id: string) => columns.find((c) => c.id === id)!;

	it('maps name/label and skips password fields, preserving schema order', () => {
		expect(columns.map((c) => c.id)).toEqual(['name', 'price', 'updatedAt', 'category', 'active']);
		expect(byId('name').header).toBe('商品名');
		expect(byId('name').accessor).toBe('name');
	});

	it('derives filterable text/number columns and right-aligns numbers', () => {
		expect(byId('name').filterable).toBe(true);
		expect(byId('name').filterType).toBe('text');
		expect(byId('price').filterType).toBe('number');
		expect(byId('price').align).toBe('right');
		// date/select/checkbox: not filterable by default (FilterPopover has
		// no ops for them).
		expect(byId('updatedAt').filterable).toBeUndefined();
		expect(byId('category').filterable).toBeUndefined();
	});

	it('derives editors for non-readonly fields only', () => {
		expect(byId('name').editable).toBe(true);
		expect(byId('name').editor).toBe('text');
		expect(byId('price').editor).toBe('number');
		expect(byId('active').editor).toBe('checkbox');
		expect(byId('updatedAt').editable).toBeUndefined();
		expect(byId('updatedAt').editor).toBeUndefined();
	});

	it('wires select options into editor and formats stored values as labels', () => {
		const category = byId('category');
		expect(category.editor).toBe('select');
		expect(category.editorOptions).toEqual(schema.fields[3].options);
		expect(category.format?.('a', row)).toBe('食品');
		expect(category.format?.('zzz', row)).toBe('zzz'); // unknown value: raw fallback
		expect(category.format?.(null, row)).toBe('');
	});

	it('validator matches forms semantics: required → bounds → custom, same messages', () => {
		const name = byId('name');
		expect(name.validate?.('', row)).toBe('必須項目です');
		expect(name.validate?.('   ', row)).toBe('必須項目です'); // trimmed emptiness
		expect(name.validate?.('x'.repeat(41), row)).toBe('40文字以内で入力してください');
		expect(name.validate?.('ふつうの名前', row)).toBeNull();

		const price = byId('price');
		expect(price.validate?.(-1, row)).toBe('0以上で入力してください');
		expect(price.validate?.(100000, row)).toBe('99999以下で入力してください');
		expect(price.validate?.(10.5, row)).toBe('整数で入力してください'); // custom runs last
		expect(price.validate?.(1200, row)).toBeNull();
		// required uses isEmpty semantics: 0 is a present value, not empty.
		expect(price.validate?.(0, row)).toBeNull();
	});

	it('editable: false derives a fully read-only grid', () => {
		const readOnly = columnsFromSchema<Row>(schema, { editable: false });
		expect(readOnly.every((c) => c.editable === undefined && c.editor === undefined)).toBe(true);
	});

	it('derives a hidden column from an override instead of dropping it', () => {
		const derived = columnsFromSchema<Row>(schema, { overrides: { updatedAt: { hidden: true } } });
		const updatedAt = derived.find((c) => c.id === 'updatedAt')!;
		expect(updatedAt.hidden).toBe(true);
		// Still derived in full: hiding is a display decision, not a removal.
		expect(updatedAt.header).toBe(byId('updatedAt').header);
	});

	it('reorders derived columns via the order option, keeping unlisted ones after', () => {
		const ids = columnsFromSchema<Row>(schema, { order: ['updatedAt', 'price'] }).map((c) => c.id);
		const rest = columnsFromSchema<Row>(schema)
			.map((c) => c.id)
			.filter((id) => id !== 'updatedAt' && id !== 'price');
		expect(ids).toEqual(['updatedAt', 'price', ...rest]);
	});

	it('ignores order entries that are not derived columns', () => {
		const ids = columnsFromSchema<Row>(schema, { order: ['nope', 'price'] }).map((c) => c.id);
		expect(ids[0]).toBe('price');
		expect(ids).not.toContain('nope');
	});

	it('applies per-field overrides on top of the derivation', () => {
		const overridden = columnsFromSchema<Row>(schema, {
			overrides: {
				price: { width: 120, format: (v) => `¥${v}` },
				updatedAt: { width: 140 },
				missing: { width: 999 } // not in schema: ignored
			}
		});
		const price = overridden.find((c) => c.id === 'price')!;
		expect(price.width).toBe(120);
		expect(price.format?.(1200, row)).toBe('¥1200');
		expect(price.editor).toBe('number'); // derivation preserved underneath
		expect(overridden.some((c) => c.width === 999)).toBe(false);
	});
});
