/**
 * `FormDraft` (spec §7; shared-primitives-upstream-plan §3.5・D3, Issue #432):
 * unapplied form input that outlives the pane showing it.
 *
 * A page (or controller) creates the draft; a pane borrows it each time it
 * mounts. Docking / undocking a pane re-mounts its content (plan §3.5: the two
 * trees are separate and a portal is not used, ADR-0018 §10), so state kept in
 * the component would be lost - the draft is kept outside it instead.
 *
 * What the draft keeps:
 *
 * - `raw`: the text being typed, including incomplete or invalid numbers
 *   (`"1e"`, `"-"`). It becomes a value only on `commit(field)` (blur / Enter),
 *   and only when it parses and validates. A `<input type="number">` cannot
 *   report such text (its `value` is `''`), so a field that wants it uses a
 *   text input - `DraftNumberField` (plan §3.5 "未決" decided in this PR).
 * - `values` / `baseline` / `dirty` / `errors` like `FormStore`, but `baseline`
 *   is never the same object as `values` (in-place mutation of one never moves
 *   the other; the #437 review).
 * - `revision`: bumped on every input / commit / discard.
 *
 * Applying (plan §3.5 "baseline にするのは適用を始めた時点の snapshot"):
 * take `snapshotForApply()` when the apply STARTS, send its values, and call
 * `markApplied(snapshot)` only after the apply succeeded. The baseline becomes
 * that snapshot - not the current values - so input typed while the apply was
 * awaited stays dirty. A failed / cancelled apply changes nothing.
 * `draftSourceFrom` wires all of this for `DraftCoordinator`.
 *
 * Not persisted to disk, no expiry, no multi-tab sync (Issue #432: out of scope).
 */
import { untrack } from 'svelte';
import type { FieldDef, FormSchema } from './types';
import { notANumberMessage, validateField, type ValidationMessages } from './validate';
import type { DraftSource } from './draftCoordinator.svelte';

/** What `snapshotForApply()` returns and `markApplied()` accepts. */
export interface FormDraftSnapshot<V = Record<string, unknown>> {
	readonly values: V;
	readonly revision: number;
}

/** pane の寿命から独立した draft（shared-primitives-upstream-plan §3.5）。ページ（または controller）が作り、pane は mount のたびに借りる。 */
export interface FormDraft<V = Record<string, unknown>> {
	readonly key: string;
	/** Parsed, committed values. Reactive. A fresh object on every change; never the baseline object. */
	readonly values: V;
	/** Uncommitted text per field (incomplete / invalid numbers included). A field is absent once committed. */
	readonly raw: Readonly<Record<string, string>>;
	/** The values last applied (or the initial values). A separate copy: mutating `values` never changes it. */
	readonly baseline: V;
	/** `values` differ from `baseline`, or some `raw` text differs from its committed value. */
	readonly dirty: boolean;
	readonly errors: Readonly<Record<string, string>>;
	/** Bumped on every input, commit and discard. */
	readonly revision: number;
	/** Keep `text` as the field's raw input (does not change `values`). Clears the field's error. */
	setRaw(field: string, text: string): void;
	/** Set a value directly (checkbox / select / programmatic), dropping the field's raw text. */
	setValue(field: string, value: unknown): void;
	/**
	 * Commit (blur / Enter). Parses the raw text by the field type and
	 * validates it; on success `values` gets the value and the raw text is
	 * dropped. On failure the raw text stays and `errors` gets the message.
	 * Returns whether the field is valid now.
	 */
	commit(field: string): boolean;
	/**
	 * Interpret every raw field into one final `values`, then validate every
	 * schema field against it. All or nothing: when anything fails, nothing is
	 * committed (raw stays) and `errors` lists every failing field.
	 */
	commitAll(): boolean;
	/** A copy of the values and the revision at the START of an apply (commit first). */
	snapshotForApply(): FormDraftSnapshot<V>;
	/**
	 * After the apply of `applied` SUCCEEDED, make (a copy of) its values the
	 * baseline. Input made during the apply (a higher `revision`) stays dirty.
	 * Ignored - returns false - for a snapshot older than the current baseline
	 * (a slower, earlier apply finishing last) or one this draft never issued.
	 */
	markApplied(applied: FormDraftSnapshot<V>): boolean;
	/** Back to the baseline: values = a copy of it, raw text and errors cleared. */
	discard(): void;
	/**
	 * Free slot for the pane to put back selection / scroll after a re-mount
	 * (plan §3.5). The draft never reads it. Not used when the DOM is kept.
	 */
	view: { selection?: { field: string; start: number; end: number }; scrollTop?: number };
}

export interface FormDraftOptions {
	/** Identifies the form; the same key as its `DraftSource` (usually the pane / panel id). */
	key: string;
	schema: FormSchema;
	initial?: Record<string, unknown>;
	/** Resolved validation messages (i18n layer ①). */
	messages?: ValidationMessages;
}

type Values = Record<string, unknown>;

/** A deep copy that never shares objects with its source ($state.snapshot clones plain objects / arrays). */
function copy<T>(value: T): T {
	return $state.snapshot(value) as T;
}

function defaultsFrom(schema: FormSchema): Values {
	const values: Values = {};
	for (const field of schema.fields) {
		if (field.default !== undefined) values[field.name] = field.default;
		else if (field.type === 'checkbox') values[field.name] = false;
		else values[field.name] = '';
	}
	return values;
}

/** Key-order independent serialisation for the dirty comparison. */
function stable(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v as Values).sort(([a], [b]) => (a < b ? -1 : 1)))
			: v
	);
}

/** How a committed value is shown as text (what an untouched input displays). */
export function formatDraftValue(value: unknown): string {
	return value === '' || value === undefined || value === null ? '' : String(value);
}

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

function parse(def: FieldDef | undefined, text: string, messages: ValidationMessages): Parsed {
	if (!def) return { ok: true, value: text };
	switch (def.type) {
		case 'number': {
			const trimmed = text.trim();
			if (trimmed === '') return { ok: true, value: '' };
			const num = Number(trimmed);
			return Number.isFinite(num)
				? { ok: true, value: num }
				: { ok: false, message: notANumberMessage(def, messages) };
		}
		case 'checkbox':
			return { ok: true, value: text === 'true' };
		case 'select': {
			const option = def.options?.find((o) => String(o.value) === text);
			return { ok: true, value: option ? option.value : text };
		}
		default:
			return { ok: true, value: text };
	}
}

function without<T>(record: Readonly<Record<string, T>>, field: string): Record<string, T> {
	if (!(field in record)) return record as Record<string, T>;
	const next = { ...record };
	delete next[field];
	return next;
}

class Draft implements FormDraft<Values> {
	readonly key: string;
	view: FormDraft['view'] = {};

	readonly #schema: FormSchema;
	readonly #messages: ValidationMessages;
	// `$state.raw` + whole-object replacement: no deep proxies, so the objects
	// handed out are plain and `copy()` is the only way values reach baseline.
	#values = $state.raw<Values>({});
	#baseline = $state.raw<Values>({});
	#raw = $state.raw<Record<string, string>>({});
	#errors = $state.raw<Record<string, string>>({});
	#revision = $state(0);
	// Revision of the snapshot the baseline came from (0 = initial values).
	#baselineRevision = 0;

	constructor(options: FormDraftOptions) {
		this.key = options.key;
		this.#schema = options.schema;
		this.#messages = options.messages ?? {};
		const initial = { ...defaultsFrom(options.schema), ...copy(options.initial ?? {}) };
		this.#values = copy(initial);
		this.#baseline = copy(initial);
	}

	get values(): Values {
		return this.#values;
	}
	get baseline(): Values {
		return this.#baseline;
	}
	get raw(): Readonly<Record<string, string>> {
		return this.#raw;
	}
	get errors(): Readonly<Record<string, string>> {
		return this.#errors;
	}
	get revision(): number {
		return this.#revision;
	}

	get dirty(): boolean {
		const values = this.#values;
		for (const [field, text] of Object.entries(this.#raw)) {
			if (text !== formatDraftValue(values[field])) return true;
		}
		return stable(values) !== stable(this.#baseline);
	}

	#def(field: string): FieldDef | undefined {
		return this.#schema.fields.find((def) => def.name === field);
	}

	// Mutators may be called from an `$effect` (a pane restoring its draft on
	// mount). Every read of our own state inside them is untracked, otherwise
	// the effect would subscribe to what it writes and re-run forever
	// (conventions §8; same as admin-core `request.svelte.ts` `#bump()`).
	#bump(): void {
		this.#revision = untrack(() => this.#revision) + 1;
	}

	setRaw(field: string, text: string): void {
		untrack(() => {
			this.#raw = { ...this.#raw, [field]: text };
			this.#errors = without(this.#errors, field);
		});
		this.#bump();
	}

	setValue(field: string, value: unknown): void {
		untrack(() => {
			this.#values = { ...this.#values, [field]: value };
			this.#raw = without(this.#raw, field);
			this.#errors = without(this.#errors, field);
		});
		this.#bump();
	}

	commit(field: string): boolean {
		return untrack(() => {
			const def = this.#def(field);
			const text = this.#raw[field];
			let values = this.#values;
			if (text !== undefined) {
				const parsed = parse(def, text, this.#messages);
				if (!parsed.ok) {
					this.#errors = { ...this.#errors, [field]: parsed.message };
					return false;
				}
				values = { ...values, [field]: parsed.value };
			}
			const message = def ? validateField(def, values[field], values, this.#messages) : null;
			if (message) {
				this.#errors = { ...this.#errors, [field]: message };
				return false;
			}
			this.#errors = without(this.#errors, field);
			if (text !== undefined) {
				this.#values = values;
				this.#raw = without(this.#raw, field);
				this.#bump();
			}
			return true;
		});
	}

	commitAll(): boolean {
		return untrack(() => {
			const rawFields = Object.keys(this.#raw);
			const names = new Set([...rawFields, ...this.#schema.fields.map((d) => d.name)]);
			const errors: Record<string, string> = {};
			// Interpret every raw field first, so that a validator that reads
			// another field sees that field's final value, not a stale one.
			let values = this.#values;
			for (const field of rawFields) {
				const parsed = parse(this.#def(field), this.#raw[field]!, this.#messages);
				if (parsed.ok) values = { ...values, [field]: parsed.value };
				else errors[field] = parsed.message;
			}
			for (const field of names) {
				if (field in errors) continue;
				const def = this.#def(field);
				const message = def ? validateField(def, values[field], values, this.#messages) : null;
				if (message) errors[field] = message;
			}
			if (Object.keys(errors).length > 0) {
				// All or nothing: nothing is committed against a combination that failed.
				this.#errors = errors;
				return false;
			}
			this.#errors = {};
			if (rawFields.length > 0) {
				this.#values = values;
				this.#raw = {};
				this.#bump();
			}
			return true;
		});
	}

	snapshotForApply(): FormDraftSnapshot<Values> {
		return untrack(() => ({ values: copy(this.#values), revision: this.#revision }));
	}

	markApplied(applied: FormDraftSnapshot<Values>): boolean {
		return untrack(() => {
			if (applied.revision < this.#baselineRevision || applied.revision > this.#revision) {
				return false;
			}
			this.#baseline = copy(applied.values);
			this.#baselineRevision = applied.revision;
			return true;
		});
	}

	discard(): void {
		untrack(() => {
			this.#values = copy(this.#baseline);
			this.#raw = {};
			this.#errors = {};
		});
		this.#bump();
	}
}

/** Create a draft that outlives its pane (shared-primitives-upstream-plan §3.5). */
export function createFormDraft(options: FormDraftOptions): FormDraft {
	return new Draft(options);
}

/**
 * A `DraftSource` for a `FormDraft`, for `DraftCoordinator.register`
 * (plan §3.5). `apply` sends the values and resolves true on success.
 *
 * Its `apply()`: commit every field (a validation failure resolves false and
 * keeps everything), take the snapshot, call `apply` with a separate copy of
 * its values (so the consumer mutating what it got cannot move the baseline),
 * and `markApplied` only on success. No `capture` / `restore`: the draft
 * itself outlives the pane.
 */
export function draftSourceFrom(
	draft: FormDraft,
	apply: (values: Record<string, unknown>) => Promise<boolean>
): DraftSource {
	return {
		key: draft.key,
		isDirty: () => draft.dirty,
		async apply() {
			if (!draft.commitAll()) return false;
			const snapshot = draft.snapshotForApply();
			if ((await apply(copy(snapshot.values))) !== true) return false;
			draft.markApplied(snapshot);
			return true;
		},
		discard: () => draft.discard()
	};
}
