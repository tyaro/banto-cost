/**
 * `FormStore` (spec §7.3): Runes-based value/dirty/touched/error state for a
 * schema-driven form. `BantoForm` reads/writes this directly; `admin-core`'s
 * `createFormResource` supplies server-side errors via `setServerErrors`.
 */
import type { FieldDef, FieldError, FormSchema } from './types';
import { validateAll, validateField, type ValidationMessages } from './validate';

function defaultsFrom(schema: FormSchema): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of schema.fields) {
		if (field.default !== undefined) values[field.name] = field.default;
		else if (field.type === 'checkbox') values[field.name] = false;
		else values[field.name] = '';
	}
	return values;
}

export class FormStore {
	values: Record<string, unknown> = $state({});
	errors: Record<string, string> = $state({});
	touched: Record<string, boolean> = $state({});

	#schema: FormSchema;
	#messages: ValidationMessages;
	// `$state` (issue #214): `markClean()` moves the baseline without touching
	// `values`, so `isDirty` must also track the snapshot itself - otherwise an
	// "unsaved changes" indicator would keep showing after a successful save.
	#initialSnapshot = $state('');

	constructor(
		schema: FormSchema,
		initial?: Record<string, unknown>,
		messages: ValidationMessages = {}
	) {
		this.#schema = schema;
		this.#messages = messages;
		this.values = { ...defaultsFrom(schema), ...initial };
		this.#initialSnapshot = JSON.stringify(this.values);
	}

	/** True when `values` differs from the snapshot taken at construction/last reset. */
	get isDirty(): boolean {
		return JSON.stringify(this.values) !== this.#initialSnapshot;
	}

	#fieldDef(name: string): FieldDef | undefined {
		return this.#schema.fields.find((field) => field.name === name);
	}

	setValue(name: string, value: unknown): void {
		this.values = { ...this.values, [name]: value };
		if (this.errors[name]) {
			const next = { ...this.errors };
			delete next[name];
			this.errors = next;
		}
	}

	/** Mark a field as touched and validate just that field (e.g. on blur). */
	touch(name: string): void {
		this.touched = { ...this.touched, [name]: true };
		const def = this.#fieldDef(name);
		if (!def) return;
		const message = validateField(def, this.values[name], this.values, this.#messages);
		const next = { ...this.errors };
		if (message) next[name] = message;
		else delete next[name];
		this.errors = next;
	}

	/** Validate every field, populate `errors`, and return whether the form is valid. */
	validateAll(): boolean {
		const errors = validateAll(this.#schema, this.values, this.#messages);
		this.errors = Object.fromEntries(errors.map((error) => [error.field, error.message]));
		return errors.length === 0;
	}

	/** Merge server-side field errors (e.g. from a failed submit) onto the current errors. */
	setServerErrors(fieldErrors: FieldError[]): void {
		this.errors = {
			...this.errors,
			...Object.fromEntries(fieldErrors.map((e) => [e.field, e.message]))
		};
	}

	/**
	 * Adopt the current `values` as the clean baseline without changing them
	 * (issue #214: call right after a successful save, so `isDirty` - and an
	 * unsaved-changes guard reading it - stops reporting the saved values as
	 * unsaved). Unlike `reset()`, values/errors/touched are left as they are.
	 */
	markClean(): void {
		this.#initialSnapshot = JSON.stringify(this.values);
	}

	/** Reset values to schema defaults merged with `newInitial`, and clear errors/touched. */
	reset(newInitial?: Record<string, unknown>): void {
		this.values = { ...defaultsFrom(this.#schema), ...newInitial };
		this.#initialSnapshot = JSON.stringify(this.values);
		this.errors = {};
		this.touched = {};
	}
}

export function createFormStore(
	schema: FormSchema,
	initial?: Record<string, unknown>,
	messages?: ValidationMessages
): FormStore {
	return new FormStore(schema, initial, messages);
}
