/**
 * Schema types for @banto/forms (spec §7.2). A `FormSchema` is shared with
 * a resource definition's `schema` (spec §3.1) so one definition drives both
 * the grid columns (@banto/grid-svelte's `columnsFromSchema`, M23 - a
 * STRUCTURAL mirror of these types, kept dependency-free) and the form UI.
 */

export type FieldType =
	'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox' | 'password';

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
	/** number: value bounds. text/textarea/password: length bounds. */
	min?: number;
	max?: number;
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
