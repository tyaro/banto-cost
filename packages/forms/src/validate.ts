/**
 * Pure validation functions for schema-driven forms (spec §7.2). No Svelte
 * imports — usable standalone and easy to unit test. Default messages are
 * Japanese; override via the `messages` param for i18n injection.
 */
import type { FieldDef, FieldError, FormSchema } from './types';

export interface ValidationMessages {
	required?: (def: FieldDef) => string;
	min?: (def: FieldDef, min: number) => string;
	max?: (def: FieldDef, max: number) => string;
	minLength?: (def: FieldDef, min: number) => string;
	maxLength?: (def: FieldDef, max: number) => string;
	pattern?: (def: FieldDef) => string;
	/** number: the raw text is not a number (only `FormDraft.commit` parses raw text; shared-primitives-upstream-plan §3.5). */
	notANumber?: (def: FieldDef) => string;
}

const defaultMessages: Required<ValidationMessages> = {
	required: () => '必須項目です',
	min: (_def, min) => `${min}以上で入力してください`,
	max: (_def, max) => `${max}以下で入力してください`,
	minLength: (_def, min) => `${min}文字以上で入力してください`,
	maxLength: (_def, max) => `${max}文字以内で入力してください`,
	pattern: () => '形式が正しくありません',
	notANumber: () => '数値を入力してください'
};

/**
 * Matches Rust's `input.name.trim()` semantics (items.rs's
 * `validate_item_input`): a whitespace-only string is empty. Only strings are
 * trimmed - non-string falsy values (`0`, `false`) must NOT be treated as
 * empty.
 */
function isEmpty(value: unknown): boolean {
	if (typeof value === 'string') return value.trim() === '';
	return value === undefined || value === null;
}

/** Validate a single field. Returns an error message, or null when valid. */
export function validateField(
	def: FieldDef,
	value: unknown,
	values: Record<string, unknown>,
	messages: ValidationMessages = {}
): string | null {
	const msg = { ...defaultMessages, ...messages };

	if (def.required && isEmpty(value)) {
		return msg.required(def);
	}

	// min/max/pattern only apply to values actually present; `required`
	// above already covers the "must not be empty" case.
	if (!isEmpty(value)) {
		if (def.type === 'number') {
			const num = typeof value === 'number' ? value : Number(value);
			if (def.min !== undefined && num < def.min) return msg.min(def, def.min);
			if (def.max !== undefined && num > def.max) return msg.max(def, def.max);
		}

		if (def.type === 'text' || def.type === 'textarea' || def.type === 'password') {
			const str = String(value);
			// Length bounds are checked against the TRIMMED length, matching
			// Rust's `trimmed_name.chars().count() > MAX_NAME_LEN` (items.rs)
			// exactly. `pattern` still tests the raw (untrimmed) string.
			//
			// 'password' shares this branch (M10 RBAC's user-management create
			// form uses `min: 8` for its password field) - trimming a password
			// is a little odd in principle, but matches every other field's
			// semantics and a password that is only whitespace should be
			// rejected either way.
			const trimmedLen = str.trim().length;
			if (def.min !== undefined && trimmedLen < def.min) return msg.minLength(def, def.min);
			if (def.max !== undefined && trimmedLen > def.max) return msg.maxLength(def, def.max);
			if (def.pattern && !new RegExp(def.pattern).test(str)) return msg.pattern(def);
		}
	}

	if (def.validate) {
		const custom = def.validate(value, values);
		if (custom) return custom;
	}

	return null;
}

/** Validate every field in the schema, returning one FieldError per invalid field, in schema order. */
export function validateAll(
	schema: FormSchema,
	values: Record<string, unknown>,
	messages: ValidationMessages = {}
): FieldError[] {
	const errors: FieldError[] = [];
	for (const def of schema.fields) {
		const message = validateField(def, values[def.name], values, messages);
		if (message) errors.push({ field: def.name, message });
	}
	return errors;
}

/** Message for raw number text that does not parse (used by `FormDraft.commit`). */
export function notANumberMessage(def: FieldDef, messages: ValidationMessages = {}): string {
	return (messages.notANumber ?? defaultMessages.notANumber)(def);
}
