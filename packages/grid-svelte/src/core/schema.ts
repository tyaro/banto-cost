/**
 * Schema → column derivation (spec §3.1, roadmap M23): "write the schema
 * once and both the list and the form grow out of it". Turns the same
 * schema object an app already passes to @banto/forms into `GridColumn`
 * definitions, so a resource's grid no longer needs hand-written columns
 * that duplicate the schema's labels/types/validation rules.
 *
 * Dependency-free by design: `SchemaField`/`ColumnsSchema` are STRUCTURAL
 * mirrors of @banto/forms' `FieldDef`/`FormSchema` (the exact same
 * convention as admin-core's `ResourceDefinition.schema?: unknown` - no
 * `@banto/*` package imports another, conventions.md §4). A `FormSchema`
 * value is assignable to `ColumnsSchema` as-is; keep the field list here in
 * sync with `packages/forms/src/types.ts` when that type grows.
 *
 * No Svelte imports — usable standalone and easy to unit test.
 */
import type { CellEditorType, FilterType, GridColumn } from '../types';

/** Structural mirror of @banto/forms' `FieldType`. */
export type SchemaFieldType =
	'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox' | 'password';

/** Structural mirror of the `FieldDef` properties column derivation reads. */
export interface SchemaField {
	name: string;
	label: string;
	type: SchemaFieldType;
	required?: boolean;
	readonly?: boolean;
	options?: { value: string | number; label: string }[];
	/** number: value bounds. text/textarea/password: length bounds. */
	min?: number;
	max?: number;
	/** text: RegExp source. */
	pattern?: string;
	/** Custom validation; return an error message, or null when valid. */
	validate?: (value: unknown, values: Record<string, unknown>) => string | null;
}

/** Structural mirror of @banto/forms' `FormSchema`. */
export interface ColumnsSchema {
	fields: SchemaField[];
}

export interface ColumnsFromSchemaOptions<TRow> {
	/**
	 * Per-field partial `GridColumn` overrides, merged (shallow) on top of
	 * the derived column - the escape hatch for everything derivation cannot
	 * know (widths, `format`, `aggregate`, turning `filterable` off, ...).
	 * Keyed by `SchemaField.name`; keys not present in the schema are
	 * ignored (they belong to hand-written columns composed alongside).
	 */
	overrides?: Record<string, Partial<GridColumn<TRow>>>;
	/**
	 * Explicit column order, by `SchemaField.name` (spec §4.4). Listed ids
	 * come first in this order; every other derived column follows in schema
	 * order. Ids that are not in the schema are ignored.
	 *
	 * Exists because the list's column order and the form's field order are
	 * different concerns that the schema alone conflates: moving an
	 * auto-numbered field to the end of the FORM (fewer keystrokes) would
	 * otherwise move it to the end of the GRID too. Note this is the
	 * DERIVATION order - the user's own drag-reorder lives in
	 * `GridState.order` and overrides it once a persisted state is hydrated.
	 */
	order?: string[];
	/**
	 * Default true. Set false to derive a read-only grid (no cell editors at
	 * all) regardless of per-field `readonly` - e.g. a list page whose edits
	 * happen only on a detail form.
	 */
	editable?: boolean;
	/**
	 * i18n layer 1 (docs/conventions.md §13): validator message overrides,
	 * applied to every derived column's validator. Defaults reproduce
	 * today's Japanese messages verbatim.
	 */
	messages?: ColumnValidationMessages;
}

/**
 * Matches @banto/forms' `isEmpty` (validate.ts) - and therefore Rust's
 * `input.name.trim()` semantics: whitespace-only strings are empty, but
 * non-string falsy values (`0`, `false`) are NOT.
 */
function isEmpty(value: unknown): boolean {
	if (typeof value === 'string') return value.trim() === '';
	return value === undefined || value === null;
}

/**
 * i18n layer 1 (docs/conventions.md §13): overridable validator messages,
 * structurally mirroring @banto/forms' `ValidationMessages` (same keys/
 * signatures, `SchemaField` in place of `FieldDef`) - deliberately NOT
 * imported from forms (no `@banto/*` cross-package imports, conventions.md
 * §4/§5; see this module's doc comment on the structural-mirror
 * convention). Defaults reproduce today's Japanese messages verbatim.
 */
export interface ColumnValidationMessages {
	required?: (field: SchemaField) => string;
	min?: (field: SchemaField, min: number) => string;
	max?: (field: SchemaField, max: number) => string;
	minLength?: (field: SchemaField, min: number) => string;
	maxLength?: (field: SchemaField, max: number) => string;
	pattern?: (field: SchemaField) => string;
}

const defaultColumnValidationMessages: Required<ColumnValidationMessages> = {
	required: () => '必須項目です',
	min: (_field, min) => `${min}以上で入力してください`,
	max: (_field, max) => `${max}以下で入力してください`,
	minLength: (_field, min) => `${min}文字以上で入力してください`,
	maxLength: (_field, max) => `${max}文字以内で入力してください`,
	pattern: () => '形式が正しくありません'
};

/**
 * Column-level validator with the SAME rule order and (by default) Japanese
 * messages as @banto/forms' `validateField` (required → number bounds /
 * string length → custom `validate`), so a cell edit and the resource's form
 * reject the same input with the same message. MUST be kept in sync with
 * `packages/forms/src/validate.ts` (structural-mirror convention, see
 * module doc). The row itself is passed as the cross-field `values` record,
 * mirroring the form passing all current values.
 */
function fieldValidator<TRow>(
	field: SchemaField,
	messages: ColumnValidationMessages = {}
): (value: unknown, row: TRow) => string | null {
	const msg = { ...defaultColumnValidationMessages, ...messages };
	return (value, row) => {
		if (field.required && isEmpty(value)) return msg.required(field);

		if (!isEmpty(value)) {
			if (field.type === 'number') {
				const num = typeof value === 'number' ? value : Number(value);
				if (field.min !== undefined && num < field.min) return msg.min(field, field.min);
				if (field.max !== undefined && num > field.max) return msg.max(field, field.max);
			}
			if (field.type === 'text' || field.type === 'textarea' || field.type === 'password') {
				// Trimmed length + raw-string pattern, same as forms' validateField.
				const str = String(value);
				const trimmedLen = str.trim().length;
				if (field.min !== undefined && trimmedLen < field.min)
					return msg.minLength(field, field.min);
				if (field.max !== undefined && trimmedLen > field.max)
					return msg.maxLength(field, field.max);
				if (field.pattern && !new RegExp(field.pattern).test(str)) return msg.pattern(field);
			}
		}

		return field.validate?.(value, row as Record<string, unknown>) ?? null;
	};
}

const EDITOR_BY_TYPE: Partial<Record<SchemaFieldType, CellEditorType>> = {
	text: 'text',
	textarea: 'text',
	number: 'number',
	date: 'date',
	select: 'select',
	checkbox: 'checkbox'
};

const FILTER_BY_TYPE: Partial<Record<SchemaFieldType, FilterType>> = {
	text: 'text',
	textarea: 'text',
	number: 'number'
};

/**
 * Derive `GridColumn`s from a form schema. Rules:
 *
 * - `password` fields are skipped entirely (a grid must never display them).
 * - `label` → `header`, `name` → `id` + `accessor`.
 * - `text`/`textarea`/`number` become filterable with the matching
 *   `filterType`; `number` is right-aligned. `date`/`select`/`checkbox` are
 *   not filterable by default (FilterPopover only offers text/number ops) -
 *   opt in via `overrides`.
 * - Non-`readonly` fields get the matching cell editor + a validator with
 *   the same rules/messages the form applies (see [`fieldValidator`]);
 *   `readonly` fields derive as display-only columns.
 * - `select` fields render the option LABEL for the stored value (raw value
 *   shown when no option matches), and pass their options to the editor.
 *
 * The result is a plain array: compose freely with hand-written columns
 * (row-link/actions columns, columns for fields outside the schema) via
 * array spread, and fine-tune per field via `options.overrides` - including
 * `{ hidden: true }` for a column that should exist but not show by default
 * (spec §4.4), which is what a derived app wants instead of filtering the
 * column out of the array (a filtered-out column can never be brought back
 * by the user).
 */
export function columnsFromSchema<TRow>(
	schema: ColumnsSchema,
	options: ColumnsFromSchemaOptions<TRow> = {}
): GridColumn<TRow>[] {
	const allowEdit = options.editable !== false;
	const columns: GridColumn<TRow>[] = [];

	for (const field of schema.fields) {
		if (field.type === 'password') continue;

		const column: GridColumn<TRow> = {
			id: field.name,
			header: field.label,
			accessor: field.name as keyof TRow
		};

		const filterType = FILTER_BY_TYPE[field.type];
		if (filterType) {
			column.filterable = true;
			column.filterType = filterType;
		}
		if (field.type === 'number') column.align = 'right';

		if (field.type === 'select' && field.options) {
			const labels = new Map(field.options.map((option) => [option.value, option.label]));
			column.format = (value) => {
				const label = labels.get(value as string | number);
				return label ?? (value === null || value === undefined ? '' : String(value));
			};
		}

		const editor = EDITOR_BY_TYPE[field.type];
		if (allowEdit && !field.readonly && editor) {
			column.editable = true;
			column.editor = editor;
			if (editor === 'select' && field.options) column.editorOptions = field.options;
			column.validate = fieldValidator<TRow>(field, options.messages);
		}

		columns.push({ ...column, ...options.overrides?.[field.name] });
	}

	return options.order ? applyOrder(columns, options.order) : columns;
}

/** Listed ids first (in `order`), everything else after in derivation order. */
function applyOrder<TRow>(columns: GridColumn<TRow>[], order: string[]): GridColumn<TRow>[] {
	const byId = new Map(columns.map((column) => [column.id, column]));
	const ordered: GridColumn<TRow>[] = [];
	for (const id of order) {
		const column = byId.get(id);
		if (column) {
			ordered.push(column);
			byId.delete(id);
		}
	}
	return [...ordered, ...byId.values()];
}
