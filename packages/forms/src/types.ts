/**
 * Schema types for @banto/forms (spec §7.2). A `FormSchema` is shared with
 * a resource definition's `schema` (spec §3.1) so one definition drives both
 * the grid columns (@banto/grid-svelte's `columnsFromSchema`, M23 - a
 * STRUCTURAL mirror of these types, kept dependency-free) and the form UI.
 */

/**
 * `time` is a canonical `HH:mm`, `datetime` a canonical `YYYY-MM-DDTHH:mm`
 * wall-clock time with no time zone (date-time-pickers §5.1, D4); like
 * `date`, an empty one is `null` (D6).
 */
export type FieldType =
	| 'text'
	| 'textarea'
	| 'number'
	| 'date'
	| 'time'
	| 'datetime'
	| 'select'
	| 'checkbox'
	| 'password';

/** The types whose value is a canonical date / time string, or `null` when empty (date-time-pickers D6). */
export function isTemporalType(type: FieldType): type is 'date' | 'time' | 'datetime' {
	return type === 'date' || type === 'time' || type === 'datetime';
}

/** Underline is opt-in and needs matching @banto/theme/css (ADR-0024). */
export type FormAppearance = 'default' | 'underline';

export interface FieldOption {
	value: string | number;
	label: string;
}

export interface FieldDef {
	name: string;
	label: string;
	type: FieldType;
	required?: boolean;
	default?: unknown;
	placeholder?: string;
	/** UI-only: native readonly for text-like fields; select/checkbox remain disabled. Values still validate and submit. */
	readonly?: boolean;
	/** select */
	options?: FieldOption[];
	/**
	 * number: value bounds. text/textarea/password: length bounds. date /
	 * time / datetime: the earliest / latest value as a canonical string
	 * (`YYYY-MM-DD` / `HH:mm` / `YYYY-MM-DDTHH:mm`), inclusive
	 * (date-time-pickers §5.6, D9). Read by the field's type: a bound of the
	 * other kind (a string on a number field, a number on a date field) is
	 * ignored.
	 */
	min?: number | string;
	max?: number | string;
	/**
	 * date / datetime: days that cannot be chosen (weekends, holidays); `date`
	 * is canonical `YYYY-MM-DD` (for datetime, the value's day) (§5.6).
	 */
	isDateDisabled?: (date: string) => boolean;
	/**
	 * time / datetime: minutes between allowed times, counted from 00:00
	 * (§5.6, D8). Given: the picker lists every `step` minutes and a value off
	 * the step is an error. Omitted: a 30-minute list and any minute accepted.
	 */
	step?: number;
	/** text: RegExp source. */
	pattern?: string;
	/** Custom validation; return an error message, or null when valid. */
	validate?: (value: unknown, values: Record<string, unknown>) => string | null;
}

export interface FormSchema {
	fields: FieldDef[];
}

export interface FieldError {
	field: string;
	message: string;
}
