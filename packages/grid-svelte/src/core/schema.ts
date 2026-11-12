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
import { formatDateTimeText, isIsoDate, isIsoDateTime, isIsoTime, isOnTimeStep } from './date';
import { compareTemporal } from './sort';

/** Structural mirror of @banto/forms' `FieldType`. */
export type SchemaFieldType =
	| 'text'
	| 'textarea'
	| 'number'
	| 'date'
	| 'time'
	| 'datetime'
	| 'select'
	| 'checkbox'
	| 'password';

/** Structural mirror of the `FieldDef` properties column derivation reads. */
export interface SchemaField {
	name: string;
	label: string;
	type: SchemaFieldType;
	required?: boolean;
	readonly?: boolean;
	options?: { value: string | number; label: string }[];
	/**
	 * number: value bounds. text/textarea/password: length bounds. date /
	 * time / datetime: canonical `YYYY-MM-DD` / `HH:mm` / `YYYY-MM-DDTHH:mm`
	 * bounds, inclusive (date-time-pickers D9). A bound of the other kind is
	 * ignored, like forms.
	 */
	min?: number | string;
	max?: number | string;
	/** date / datetime: days that cannot be picked (weekends, holidays). Mirrors forms' `FieldDef.isDateDisabled`. */
	isDateDisabled?: (date: string) => boolean;
	/** time / datetime: minutes between allowed times from 00:00 (D8). Mirrors forms' `FieldDef.step`. */
	step?: number;
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
	/** date: the value is not a canonical `YYYY-MM-DD` real day (date-time-pickers §5.3). */
	dateInvalid?: (field: SchemaField) => string;
	/** date: earlier than `min` (canonical `YYYY-MM-DD`). */
	dateMin?: (field: SchemaField, min: string) => string;
	/** date: later than `max` (canonical `YYYY-MM-DD`). */
	dateMax?: (field: SchemaField, max: string) => string;
	/** date / datetime: `isDateDisabled` refused the day. */
	dateDisabled?: (field: SchemaField, date: string) => string;
	/** time: the value is not a canonical `HH:mm` (00:00-23:59). */
	timeInvalid?: (field: SchemaField) => string;
	/** time: earlier than `min` (canonical `HH:mm`). */
	timeMin?: (field: SchemaField, min: string) => string;
	/** time: later than `max` (canonical `HH:mm`). */
	timeMax?: (field: SchemaField, max: string) => string;
	/** time / datetime: the time is off the `step` grid counted from 00:00 (`step` in minutes). */
	timeStep?: (field: SchemaField, step: number) => string;
	/** datetime: the value is not a canonical `YYYY-MM-DDTHH:mm`. */
	dateTimeInvalid?: (field: SchemaField) => string;
	/** datetime: earlier than `min`; `min` is shown as `YYYY-MM-DD HH:mm`. */
	dateTimeMin?: (field: SchemaField, min: string) => string;
	/** datetime: later than `max`; `max` is shown as `YYYY-MM-DD HH:mm`. */
	dateTimeMax?: (field: SchemaField, max: string) => string;
}

const defaultColumnValidationMessages: Required<ColumnValidationMessages> = {
	required: () => '必須項目です',
	min: (_field, min) => `${min}以上で入力してください`,
	max: (_field, max) => `${max}以下で入力してください`,
	minLength: (_field, min) => `${min}文字以上で入力してください`,
	maxLength: (_field, max) => `${max}文字以内で入力してください`,
	pattern: () => '形式が正しくありません',
	dateInvalid: () => '日付を YYYY-MM-DD の形で入力してください',
	dateMin: (_field, min) => `${min}以降の日付を入力してください`,
	dateMax: (_field, max) => `${max}以前の日付を入力してください`,
	dateDisabled: () => 'この日付は選べません',
	timeInvalid: () => '時刻を HH:mm の形で入力してください',
	timeMin: (_field, min) => `${min}以降の時刻を入力してください`,
	timeMax: (_field, max) => `${max}以前の時刻を入力してください`,
	timeStep: (_field, step) => `${step}分刻みの時刻を入力してください`,
	dateTimeInvalid: () => '日時を YYYY-MM-DD HH:mm の形で入力してください',
	dateTimeMin: (_field, min) => `${min}以降の日時を入力してください`,
	dateTimeMax: (_field, max) => `${max}以前の日時を入力してください`
};

/**
 * Column-level validator with the SAME rule order and (by default) Japanese
 * messages as @banto/forms' `validateField` (required → number bounds /
 * date format, bounds and disabled days / string length → custom `validate`), so a cell edit and the resource's form
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
			// Bounds are read by the field's type, like forms (D9): numbers for
			// number / text, canonical strings for date.
			const min = typeof field.min === 'number' ? field.min : undefined;
			const max = typeof field.max === 'number' ? field.max : undefined;
			if (field.type === 'number') {
				const num = typeof value === 'number' ? value : Number(value);
				if (min !== undefined && num < min) return msg.min(field, min);
				if (max !== undefined && num > max) return msg.max(field, max);
			}
			if (field.type === 'date') {
				// Anything but a canonical real day is an error, like forms (the
				// grid's parse already refuses such text; this guards values fed
				// to the validator directly).
				if (!isIsoDate(value)) return msg.dateInvalid(field);
				if (typeof field.min === 'string' && value < field.min)
					return msg.dateMin(field, field.min);
				if (typeof field.max === 'string' && value > field.max)
					return msg.dateMax(field, field.max);
				if (field.isDateDisabled?.(value)) return msg.dateDisabled(field, value);
			}
			if (field.type === 'time') {
				if (!isIsoTime(value)) return msg.timeInvalid(field);
				if (typeof field.min === 'string' && value < field.min)
					return msg.timeMin(field, field.min);
				if (typeof field.max === 'string' && value > field.max)
					return msg.timeMax(field, field.max);
				if (field.step !== undefined && !isOnTimeStep(value, field.step))
					return msg.timeStep(field, field.step);
			}
			if (field.type === 'datetime') {
				if (!isIsoDateTime(value)) return msg.dateTimeInvalid(field);
				if (typeof field.min === 'string' && value < field.min)
					return msg.dateTimeMin(field, formatDateTimeText(field.min));
				if (typeof field.max === 'string' && value > field.max)
					return msg.dateTimeMax(field, formatDateTimeText(field.max));
				const [date, time] = value.split('T');
				if (field.isDateDisabled?.(date)) return msg.dateDisabled(field, date);
				if (field.step !== undefined && !isOnTimeStep(time, field.step))
					return msg.timeStep(field, field.step);
			}
			if (field.type === 'text' || field.type === 'textarea' || field.type === 'password') {
				// Trimmed length + raw-string pattern, same as forms' validateField.
				const str = String(value);
				const trimmedLen = str.trim().length;
				if (min !== undefined && trimmedLen < min) return msg.minLength(field, min);
				if (max !== undefined && trimmedLen > max) return msg.maxLength(field, max);
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
	time: 'time',
	datetime: 'datetime',
	select: 'select',
	checkbox: 'checkbox'
};

const FILTER_BY_TYPE: Partial<Record<SchemaFieldType, FilterType>> = {
	text: 'text',
	textarea: 'text',
	number: 'number',
	date: 'date',
	datetime: 'datetime'
};

/**
 * Derive `GridColumn`s from a form schema. Rules:
 *
 * - `password` fields are skipped entirely (a grid must never display them).
 * - `label` → `header`, `name` → `id` + `accessor`.
 * - `text`/`textarea`/`number`/`date`/`datetime` become filterable with the
 *   matching `filterType` (`date`/`datetime`: a day range, date-time-pickers
 *   §5.9); `number` is right-aligned. `time`/`select`/`checkbox` are not
 *   filterable by default - opt in via `overrides`.
 * - `date`/`time`/`datetime` sort as text (`comparator: compareTemporal`,
 *   read-only ones too): canonical strings sort in time order, as in SQL.
 * - `datetime` is shown with a space for the `T` (a default `format`).
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
		if (field.type === 'date' || field.type === 'time' || field.type === 'datetime') {
			column.comparator = compareTemporal;
		}
		// A date and time is shown with a space (`2026-11-07 09:30`, date-time-pickers
		// §5.3); the value (and a copy to the clipboard) keeps the `T`.
		if (field.type === 'datetime') {
			column.format = (value) =>
				typeof value === 'string' ? formatDateTimeText(value) : value == null ? '' : String(value);
		}

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
			if (editor === 'date' || editor === 'time' || editor === 'datetime') {
				// The picker's range / disabled days / step (date-time-pickers §5.6);
				// the validator enforces the same rules on commit.
				if (typeof field.min === 'string') column.editorMin = field.min;
				if (typeof field.max === 'string') column.editorMax = field.max;
				if (field.isDateDisabled && editor !== 'time') column.isDateDisabled = field.isDateDisabled;
				if (field.step !== undefined && editor !== 'date') column.editorStep = field.step;
			}
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
