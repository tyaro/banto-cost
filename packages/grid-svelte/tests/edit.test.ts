import { describe, expect, it } from 'vitest';
import { isColumnEditable, prepareCommit } from '../src/core/edit';
import { resolveSelectValue } from '../src/core/clipboard';
import type { GridColumn } from '../src/types';

interface Row {
	id: number;
	name: string;
	price: number;
}

const row: Row = { id: 1, name: 'Green Tea', price: 140 };

describe('prepareCommit', () => {
	it('returns noop when the draft equals the current value', () => {
		const column: GridColumn<Row> = {
			id: 'name',
			header: 'Name',
			accessor: 'name',
			editable: true
		};
		expect(prepareCommit(column, row, 1, 'Green Tea')).toEqual({ kind: 'noop' });
	});

	it('returns invalid with the validator message when validation fails', () => {
		const column: GridColumn<Row> = {
			id: 'name',
			header: 'Name',
			accessor: 'name',
			editable: true,
			validate: (value) => (String(value).length === 0 ? '必須項目です' : null)
		};
		expect(prepareCommit(column, row, 1, '')).toEqual({ kind: 'invalid', message: '必須項目です' });
	});

	it('returns a commit edit with row/rowId/field/value/oldValue when the value changed and validates', () => {
		const column: GridColumn<Row> = {
			id: 'name',
			header: 'Name',
			accessor: 'name',
			editable: true,
			validate: () => null
		};
		expect(prepareCommit(column, row, 1, 'Roasted Tea')).toEqual({
			kind: 'commit',
			edit: { row, rowId: 1, field: 'name', value: 'Roasted Tea', oldValue: 'Green Tea' }
		});
	});

	it('commits without a validate function at all', () => {
		const column: GridColumn<Row> = {
			id: 'price',
			header: 'Price',
			accessor: 'price',
			editable: true
		};
		expect(prepareCommit(column, row, 1, 200)).toEqual({
			kind: 'commit',
			edit: { row, rowId: 1, field: 'price', value: 200, oldValue: 140 }
		});
	});

	it('supports accessor functions, not just keyof', () => {
		const column: GridColumn<Row> = {
			id: 'label',
			header: 'Label',
			accessor: (r) => `${r.name} (${r.price})`,
			editable: true
		};
		expect(prepareCommit(column, row, 1, 'Green Tea (140)')).toEqual({ kind: 'noop' });
	});

	it('validate receives both the candidate value and the row', () => {
		const column: GridColumn<Row> = {
			id: 'price',
			header: 'Price',
			accessor: 'price',
			editable: true,
			validate: (value, r) =>
				Number(value) > 99999 || r.id < 0 ? '0〜99999で入力してください' : null
		};
		expect(prepareCommit(column, row, 1, 999999)).toEqual({
			kind: 'invalid',
			message: '0〜99999で入力してください'
		});
	});

	it('a select column with numeric editorOptions commits a numeric value, not a string (BantoGrid resolves via resolveSelectValue before calling prepareCommit)', () => {
		interface CategoryRow {
			id: number;
			categoryId: number;
		}
		const categoryRow: CategoryRow = { id: 1, categoryId: 1 };
		const column: GridColumn<CategoryRow> = {
			id: 'categoryId',
			header: 'Category',
			accessor: 'categoryId',
			editable: true,
			editor: 'select',
			editorOptions: [
				{ value: 1, label: 'Drinks' },
				{ value: 2, label: 'Snacks' }
			]
		};

		// Simulates the <select>'s onchange / a pasted TSV cell: only ever a
		// raw string is available before BantoGrid resolves it.
		const resolved = resolveSelectValue('2', column.editorOptions);
		expect(resolved).toBe(2);
		expect(typeof resolved).toBe('number');

		const result = prepareCommit(column, categoryRow, 1, resolved);
		expect(result).toEqual({
			kind: 'commit',
			edit: { row: categoryRow, rowId: 1, field: 'categoryId', value: 2, oldValue: 1 }
		});
		if (result.kind === 'commit') {
			expect(typeof result.edit.value).toBe('number');
		}
	});

	it('without resolution, a select column would incorrectly see every unchanged edit as a commit (string !== numeric oldValue)', () => {
		interface CategoryRow {
			id: number;
			categoryId: number;
		}
		const categoryRow: CategoryRow = { id: 1, categoryId: 1 };
		const column: GridColumn<CategoryRow> = {
			id: 'categoryId',
			header: 'Category',
			accessor: 'categoryId',
			editable: true,
			editor: 'select',
			editorOptions: [{ value: 1, label: 'Drinks' }]
		};

		// The raw (unresolved) string '1' does not `===` the numeric oldValue
		// 1, so without resolveSelectValue this would wrongly be a 'commit'
		// instead of a 'noop' - demonstrating why BantoGrid must resolve
		// before calling prepareCommit.
		expect(prepareCommit(column, categoryRow, 1, '1').kind).toBe('commit');
		expect(
			prepareCommit(column, categoryRow, 1, resolveSelectValue('1', column.editorOptions)).kind
		).toBe('noop');
	});
});

describe('isColumnEditable', () => {
	it('is true when editable: true and no cell renderer', () => {
		const column: GridColumn<Row> = {
			id: 'name',
			header: 'Name',
			accessor: 'name',
			editable: true
		};
		expect(isColumnEditable(column, row)).toBe(true);
	});

	it('is false when editable is unset/false', () => {
		const column: GridColumn<Row> = { id: 'name', header: 'Name', accessor: 'name' };
		expect(isColumnEditable(column, row)).toBe(false);
	});

	it('respects a function-form editable based on the row', () => {
		const column: GridColumn<Row> = {
			id: 'price',
			header: 'Price',
			accessor: 'price',
			editable: (r) => r.price > 0
		};
		expect(isColumnEditable(column, row)).toBe(true);
		expect(isColumnEditable(column, { ...row, price: 0 })).toBe(false);
	});

	it('is always false when the column defines a cell renderer, even if editable: true (pre-merge review fix: a link cell must never become editable, or its editor could never render behind the link)', () => {
		const column: GridColumn<Row> = {
			id: 'open',
			header: 'Open',
			accessor: 'id',
			editable: true,
			cell: (r) => ({ text: '開く', href: `/items/${r.id}` })
		};
		expect(isColumnEditable(column, row)).toBe(false);
	});

	it('a cell-only column (no editable at all) is also non-editable, unaffected by the rule (items page open column shape)', () => {
		const column: GridColumn<Row> = {
			id: 'open',
			header: 'Open',
			accessor: 'id',
			cell: (r) => ({ text: '開く', href: `/items/${r.id}` })
		};
		expect(isColumnEditable(column, row)).toBe(false);
	});
});
