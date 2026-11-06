/**
 * `createSavedSetting` (spec §12.1 UI settings, §3 headless composables;
 * shared-primitives-upstream-plan §3.4・§4.1・D8, Issue #437): keep a UI
 * setting's **current** value (what the user is editing) apart from its
 * **saved** value (the last value the provider confirmed), on top of an
 * existing {@link UiSettingsProvider}. The provider is not replaced.
 *
 * What it owns
 * - `current` / `saved` / `saving` / `error` / `dirty`, and the
 *   explicit-vs-immediate choice (`mode`).
 * - `saved` changes only after `provider.set` succeeds, and then to the
 *   snapshot that was **actually sent**. A failed save keeps `current` and
 *   the previous `saved`, and records `error` (cleared by the next success).
 * - Which old answers to drop: stale loads, and answers after `dispose()`
 *   (through {@link createRequestOwner}, keys `'load'` and `'save'`).
 *
 * What the consumer owns: the wording of any notification (read `error` /
 * `save()`'s result), what the value applies to, the default value
 * (`fallback`), and how a raw string is validated (`parse`; corrupted or
 * unknown-version data is `undefined` / a throw, never an exception out of
 * `load()`).
 *
 * Concurrency contract (saves are **serialized and coalesced**)
 * - At most one `provider.set` is in flight. A `save()` (or an immediate-mode
 *   `set()`) during that send does not start a second one: it queues **one**
 *   follow-up save, and every `save()` call made meanwhile shares that
 *   follow-up's result (`Promise<boolean>`). So provider answers can never
 *   arrive out of order.
 * - The snapshot is taken when a send **starts** (for the queued follow-up:
 *   when the previous send settles), so a queued save carries the latest
 *   `current`. An edit made during a send is never marked saved; the setting
 *   stays `dirty` and the follow-up (if any) sends it.
 * - A failed send does not cancel the queued follow-up (it sends the latest
 *   value, which doubles as a retry).
 * - `save()` always sends, even when not `dirty` (it can overwrite a stored
 *   value that `load()` reported `'invalid'`). It never rejects: failure is
 *   `false` plus `error`.
 * - `save()` / `set()` in immediate mode, a save settling, and a newer
 *   `load()` all make an older in-flight `load()` stale (`'stale'`, its
 *   result is not applied): the stored value it read may predate the write.
 * - `dispose()` drops the queue (resolves `false`), ignores answers still in
 *   flight, and makes later `save()` / `load()` do nothing.
 *
 * Loading: `load()` never overwrites an edit made since it started. The
 * stored value (if usable) still becomes `saved` (so `dirty` is right), but
 * `current` is only replaced when untouched.
 *
 * Re-entrancy: callbacks (`provider.set`, `parse`, `serialize`, `fallback`)
 * may call back into the setting. State is committed before the provider is
 * called and again in one synchronous step after each callback returns, and
 * every re-check (`isCurrent()`, edit version) happens after the callbacks.
 *
 * Reactive state is bumped through one `$state` counter, read untracked, so
 * calling `set()` from an `$effect` cannot re-run that effect (conventions §8,
 * same pattern as `createRequestOwner`).
 */
import { untrack } from 'svelte';
import type { UiSettingsProvider } from './providers/uiSettings';
import { createRequestOwner } from './request.svelte';

/** `'explicit'` sends only on `save()`; `'immediate'` also sends after every `set()` (coalesced). */
export type SavedSettingMode = 'explicit' | 'immediate';

/**
 * Outcome of `load()`:
 * - `'loaded'`: a usable stored value (now `saved`; `current` too unless edited meanwhile)
 * - `'missing'`: nothing stored (`saved` undefined, `current` = `fallback()` unless edited)
 * - `'invalid'`: stored but `parse` refused it (corrupt / unknown version); same as `'missing'`
 * - `'failed'`: the provider failed (`error` is set; `current` and `saved` untouched)
 * - `'stale'`: a newer load / a save / `dispose()` made this answer obsolete; nothing applied
 */
export type SavedSettingLoad = 'loaded' | 'missing' | 'invalid' | 'failed' | 'stale';

export interface SavedSettingOptions<T> {
	provider: UiSettingsProvider;
	key: string;
	/** Interpret a stored string. Return `undefined` (or throw) for corrupted / unknown-version data. */
	parse: (raw: string) => T | undefined;
	/** Value → string. Equal strings mean equal values (drives `dirty`). Must be deterministic. */
	serialize: (value: T) => string;
	/** The value when nothing usable is stored. Wording and defaults belong to the consumer. */
	fallback: () => T;
	/** Default `'explicit'`. */
	mode?: SavedSettingMode;
}

export interface SavedSetting<T> {
	/** The value being edited. */
	readonly current: T;
	/** The last value saved (or loaded) successfully; `undefined` while none. */
	readonly saved: T | undefined;
	/** A `provider.set` is in flight. */
	readonly saving: boolean;
	/** A `load()` is in flight. */
	readonly loading: boolean;
	/** Last provider failure (load or save); `null` after the next success. */
	readonly error: unknown;
	/** `serialize(current)` differs from the saved (or, with none, the default) value. */
	readonly dirty: boolean;
	/** Change `current`. In immediate mode this also queues a save. */
	set(value: T): void;
	load(): Promise<SavedSettingLoad>;
	/** Send a snapshot of `current` (see the concurrency contract). Resolves `true` iff that snapshot was saved. */
	save(): Promise<boolean>;
	/** `current` back to `saved` (or `fallback()` when nothing is saved). Does not save. */
	revert(): void;
	/** `current` to `fallback()`. Does not save (call `save()` to persist the standard value). */
	resetToDefault(): void;
	/** Drop pending work and ignore answers in flight. Call on unmount. */
	dispose(): void;
}

interface Deferred {
	promise: Promise<boolean>;
	resolve: (ok: boolean) => void;
}

function deferred(): Deferred {
	let resolve!: (ok: boolean) => void;
	const promise = new Promise<boolean>((r) => (resolve = r));
	return { promise, resolve };
}

class Impl<T> implements SavedSetting<T> {
	readonly #options: SavedSettingOptions<T>;
	readonly #owner = createRequestOwner();
	// Bumped on every observable change; getters read it, mutators never do.
	#rev = $state(0);

	#value: T;
	#raw: string;
	#saved: T | undefined = undefined;
	#hasSaved = false;
	/** Serialized baseline `dirty` compares against. */
	#baseRaw: string;
	#saving = false;
	#error: unknown = null;
	/** Bumped by user edits (not by load/save); lets `load()` tell "untouched". Not reactive. */
	#editVersion = 0;
	#inflight = false;
	#queued: Deferred | null = null;

	constructor(options: SavedSettingOptions<T>) {
		this.#options = options;
		const value = options.fallback();
		this.#value = value;
		this.#raw = options.serialize(value);
		this.#baseRaw = this.#raw;
	}

	#bump(): void {
		this.#rev = untrack(() => this.#rev) + 1;
	}

	get current(): T {
		void this.#rev;
		return this.#value;
	}
	get saved(): T | undefined {
		void this.#rev;
		return this.#saved;
	}
	get saving(): boolean {
		void this.#rev;
		return this.#saving;
	}
	get loading(): boolean {
		return this.#owner.busy('load');
	}
	get error(): unknown {
		void this.#rev;
		return this.#error;
	}
	get dirty(): boolean {
		void this.#rev;
		return this.#raw !== this.#baseRaw;
	}

	#edit(value: T, raw: string): void {
		this.#value = value;
		this.#raw = raw;
		this.#editVersion++;
		this.#bump();
	}

	set(value: T): void {
		const raw = this.#options.serialize(value);
		this.#edit(value, raw);
		if (this.#options.mode !== 'immediate') return;
		// Nothing to send when it equals what is saved and nothing is in flight.
		if (this.#hasSaved && raw === this.#baseRaw && !this.#inflight && !this.#queued) return;
		void this.save();
	}

	revert(): void {
		if (this.#hasSaved) {
			// current gets its own copy: editing it must not change `saved`.
			this.#edit(this.#independent(this.#baseRaw, this.#saved as T), this.#baseRaw);
			return;
		}
		const value = this.#options.fallback();
		this.#edit(value, this.#options.serialize(value));
	}

	resetToDefault(): void {
		const value = this.#options.fallback();
		this.#edit(value, this.#options.serialize(value));
	}

	save(): Promise<boolean> {
		if (this.#owner.disposed) return Promise.resolve(false);
		if (this.#inflight) {
			this.#queued ??= deferred();
			return this.#queued.promise;
		}
		return this.#send();
	}

	/** A copy of the sent value that the caller cannot mutate: parse the sent text again. */
	#independent(raw: string, value: T): T {
		try {
			const copy = this.#options.parse(raw);
			return copy === undefined ? value : copy;
		} catch {
			return value;
		}
	}

	async #send(): Promise<boolean> {
		// Everything below up to the first `await` is synchronous: the snapshot
		// and the in-flight flag are fixed before the provider can re-enter.
		const value = this.#value;
		const raw = this.#raw;
		this.#inflight = true;
		this.#saving = true;
		this.#owner.invalidate('load');
		const request = this.#owner.begin('save');
		this.#bump();
		let ok = false;
		try {
			await this.#options.provider.set(this.#options.key, raw);
			// Expose what was actually sent, not the caller's object: a mutable
			// value may have been changed while the provider call was pending.
			// The copy runs the consumer's parse, which may re-enter (dispose):
			// make it first, then check the request right before committing.
			const sent = request.isCurrent() ? this.#independent(raw, value) : value;
			if (request.isCurrent()) {
				this.#saved = sent;
				this.#hasSaved = true;
				this.#baseRaw = raw;
				this.#error = null;
				ok = true;
			}
		} catch (error) {
			if (request.isCurrent()) this.#error = error;
		} finally {
			request.finish();
			this.#inflight = false;
			this.#saving = false;
			this.#owner.invalidate('load');
			this.#bump();
		}
		const queued = this.#queued;
		this.#queued = null;
		if (queued) {
			if (this.#owner.disposed) queued.resolve(false);
			else void this.#send().then(queued.resolve);
		}
		return ok;
	}

	async load(): Promise<SavedSettingLoad> {
		if (this.#owner.disposed) return 'stale';
		// A read started while a save is in flight may return the value from
		// before that write and roll `current` back; the save's own result is
		// authoritative. (A save that starts during a load invalidates it.)
		if (this.#inflight) return 'stale';
		const request = this.#owner.begin('load');
		const editVersion = this.#editVersion;
		try {
			let stored: string | null;
			try {
				stored = await this.#options.provider.get(this.#options.key);
			} catch (error) {
				if (!request.isCurrent()) return 'stale';
				this.#error = error;
				this.#bump();
				return 'failed';
			}
			if (!request.isCurrent()) return 'stale';

			let parsed: { value: T; raw: string; current: T } | undefined;
			if (stored !== null) {
				try {
					const value = this.#options.parse(stored);
					if (value !== undefined) {
						const text = this.#options.serialize(value);
						// current gets its own copy so editing it cannot change `saved`.
						parsed = { value, raw: text, current: this.#independent(text, value) };
					}
				} catch {
					parsed = undefined; // a throwing validator means "corrupted"
				}
			}
			let fallback: { value: T; raw: string } | undefined;
			if (!parsed) {
				const value = this.#options.fallback();
				fallback = { value, raw: this.#options.serialize(value) };
			}
			// Callbacks above may have re-entered (set / save / dispose): decide now.
			if (!request.isCurrent()) return 'stale';
			const untouched = this.#editVersion === editVersion;
			this.#error = null;
			if (parsed) {
				this.#saved = parsed.value;
				this.#hasSaved = true;
				this.#baseRaw = parsed.raw;
				if (untouched) {
					this.#value = parsed.current;
					this.#raw = parsed.raw;
				}
				this.#bump();
				return 'loaded';
			}
			const standard = fallback as { value: T; raw: string };
			this.#saved = undefined;
			this.#hasSaved = false;
			this.#baseRaw = standard.raw;
			if (untouched) {
				this.#value = standard.value;
				this.#raw = standard.raw;
			}
			this.#bump();
			return stored === null ? 'missing' : 'invalid';
		} finally {
			request.finish();
		}
	}

	dispose(): void {
		if (this.#owner.disposed) return;
		this.#owner.dispose();
		const queued = this.#queued;
		this.#queued = null;
		queued?.resolve(false);
		this.#bump();
	}
}

/** Create a saved setting on an existing provider (shared-primitives-upstream-plan §3.4). */
export function createSavedSetting<T>(options: SavedSettingOptions<T>): SavedSetting<T> {
	return new Impl(options);
}
