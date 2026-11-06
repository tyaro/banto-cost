/**
 * `DraftCoordinator` (spec §7; shared-primitives-upstream-plan §3.5・§4.2・D3,
 * Issue #432): apply / discard / cancel for several forms with ONE prompt,
 * and keep unapplied input across a pane re-mount.
 *
 * The coordinator knows nothing about the dock (`@banto/forms` cannot import
 * `@banto/dock-svelte`, plan §2.1). The app connects them per transition
 * (plan §3.5 table):
 *
 * - dock / undock / move-docked (content re-mounts, input is KEPT):
 *   `capture([panelId])`, then let the change happen. When the re-mounted pane
 *   registers the same key, the captured state is `restore`d (rebind). No
 *   prompt. A pane built on `FormDraft` needs nothing - the draft outlives it.
 * - tab-switch / hide: keep the DOM (dock's `keepMounted`) or capture as above.
 *   No prompt.
 * - close (content is DISCARDED): `settle([panelId], ask)`; close only for
 *   `'clean'` / `'applied'` / `'discarded'`.
 *
 * Guarantees of `settle`:
 *
 * - `ask` is called at most once per call, with every dirty key.
 * - `'applied'` / `'discarded'` mean every target was clean WHEN settle
 *   resolved: after the awaits each source's `isDirty()` is checked again;
 *   input typed while an apply was awaited makes it `'dirty-again'` (the input
 *   is kept, never discarded).
 * - A failed / thrown / cancelled apply never discards input (`'failed'`).
 * - `'stale'`: the target changed while settle was awaiting - a source of a
 *   target key was unregistered or replaced (rebind), another `settle` of the
 *   same key started, or the coordinator was disposed. Nothing is reported as
 *   resolved. This uses the package-internal request owner, which runs the same
 *   contract table as admin-core's `createRequestOwner` (plan §4.1・D1).
 *
 * Every registration also joins `guardUnsavedChanges`' registry, so a router
 * leave and `hasUnsavedChanges()` (desktop window close) see the same drafts.
 * Double prompts are prevented by the existing "one prompt per navigation"
 * rule (every guard checks the whole registry once per navigation). The
 * registry is read only by mounted guards: a page that wants router leaves
 * covered mounts one, e.g. `guardUnsavedChanges({ isDirty: () => coordinator.pending, ... })`.
 *
 * Re-entrancy: own state is committed before any consumer callback (`ask`,
 * `apply`, `discard`, `capture`, `restore`) runs, and checked again after it
 * returns, so a callback that registers, disposes or settles again cannot be
 * overwritten or rolled back.
 */
import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { createRequestOwner, type RequestHandle } from './requestOwner.svelte';
import { joinUnsavedChangesRegistry, type UnsavedChangesSource } from './unsavedChanges.svelte';

/** 既存の自作フォームをつなぐ adapter（BantoForm 化を必須にしない。plan §3.5）。 */
export interface DraftSource {
	readonly key: string;
	isDirty(): boolean;
	/** Apply. Resolve false on a validation / apply failure and keep the input dirty. A throw counts as a failure. */
	apply(): Promise<boolean>;
	discard(): void;
	/**
	 * Take the unapplied input out of the pane before it re-mounts (dock /
	 * undock). Not needed for a `FormDraft`, which outlives the pane.
	 */
	capture?(): unknown;
	/** Put what `capture` returned back into the re-mounted source of the same key. */
	restore?(captured: unknown): void;
}

/** What the consumer's confirm UI answers. */
export type DraftSettleChoice = 'apply' | 'discard' | 'cancel';

/**
 * - `clean`: nothing was dirty; `ask` was not called.
 * - `applied` / `discarded`: every target is clean now.
 * - `cancelled`: the user cancelled; nothing changed.
 * - `failed`: some apply resolved false or threw (sources that applied are clean, the rest stay dirty).
 * - `dirty-again`: applied / discarded, but input arrived during the awaits and is still dirty.
 * - `stale`: the target changed while awaiting (see module doc); nothing is reported as resolved.
 *
 * Only `clean` / `applied` / `discarded` allow throwing the content away.
 */
export type DraftSettleResult =
	'clean' | 'applied' | 'discarded' | 'cancelled' | 'failed' | 'dirty-again' | 'stale';

/** 複数フォームの適用 / 破棄 / キャンセル。確認は 1 回だけ出す（plan §3.5）。 */
export interface DraftCoordinator {
	/**
	 * Register a source (replacing one of the same key). When a capture of
	 * the key is held, `restore` is called with it (rebind) and it is dropped.
	 * Returns the unregister function (it only removes this very source).
	 */
	register(source: DraftSource): () => void;
	/** Some registered source is dirty, or a held capture was dirty. Reactive. */
	readonly pending: boolean;
	/** A `settle` is running. Reactive. */
	readonly settling: boolean;
	/**
	 * Before a move that keeps the content (dock / undock): take each target
	 * source's `capture()` and hold it until the next `register` of that key.
	 * No prompt, no apply, no discard.
	 */
	capture(keys: readonly string[]): void;
	/** Resolve the targets (`undefined` = all) with one `ask`. See {@link DraftSettleResult}. */
	settle(
		keys: readonly string[] | undefined,
		ask: (dirtyKeys: readonly string[]) => Promise<DraftSettleChoice>
	): Promise<DraftSettleResult>;
	/** Drop every source and capture, leave the unsaved-changes registry; running settles turn `stale`. */
	dispose(): void;
}

export interface DraftCoordinatorOptions {
	/**
	 * Prompt text shown when a router leave finds these drafts pending
	 * (resolved string, i18n layer ①; conventions §13). Required because the
	 * coordinator always joins `guardUnsavedChanges`' registry.
	 */
	message: () => string;
}

interface Capture {
	value: unknown;
	dirty: boolean;
}

class Coordinator implements DraftCoordinator {
	readonly #sources = new SvelteMap<string, DraftSource>();
	readonly #captures = new SvelteMap<string, Capture>();
	readonly #owner = createRequestOwner();
	readonly #entry: UnsavedChangesSource;
	#leaveRegistry: (() => void) | null = null;
	#disposed = false;
	#settling = $state(0);

	constructor(options: DraftCoordinatorOptions) {
		this.#entry = {
			isPending: () => this.pending || this.settling,
			message: options.message
		};
	}

	get pending(): boolean {
		for (const source of this.#sources.values()) if (source.isDirty()) return true;
		for (const capture of this.#captures.values()) if (capture.dirty) return true;
		return false;
	}

	get settling(): boolean {
		return this.#settling > 0;
	}

	// Called from mutators, which may run inside an `$effect` (a pane
	// registering on mount): reads are untracked (conventions §8).
	#syncRegistry(): void {
		untrack(() => {
			const needed = !this.#disposed && (this.#sources.size > 0 || this.#captures.size > 0);
			if (needed && !this.#leaveRegistry) {
				this.#leaveRegistry = joinUnsavedChangesRegistry(this.#entry);
			} else if (!needed && this.#leaveRegistry) {
				const leave = this.#leaveRegistry;
				this.#leaveRegistry = null;
				leave();
			}
		});
	}

	#addSettling(delta: number): void {
		this.#settling = untrack(() => this.#settling) + delta;
	}

	register(source: DraftSource): () => void {
		const key = source.key;
		const held = untrack(() => {
			if (this.#disposed) return undefined;
			this.#sources.set(key, source);
			// A settle awaiting the previous source of this key must not report
			// on the new one.
			this.#owner.invalidate(key);
			const capture = this.#captures.get(key);
			if (capture) this.#captures.delete(key);
			return capture;
		});
		this.#syncRegistry();
		if (held && source.restore) {
			try {
				source.restore(held.value);
			} catch (error) {
				// Keep the capture for a later attempt unless something newer replaced it.
				untrack(() => {
					if (!this.#disposed && !this.#captures.has(key)) this.#captures.set(key, held);
				});
				this.#syncRegistry();
				throw error;
			}
		}
		return () => {
			untrack(() => {
				if (this.#sources.get(key) !== source) return;
				this.#sources.delete(key);
				this.#owner.invalidate(key);
			});
			this.#syncRegistry();
		};
	}

	capture(keys: readonly string[]): void {
		const targets = untrack(() =>
			this.#disposed
				? []
				: keys
						.map((key) => this.#sources.get(key))
						.filter((s): s is DraftSource => s?.capture !== undefined)
		);
		for (const source of targets) {
			const value = source.capture!();
			const dirty = source.isDirty();
			untrack(() => {
				// The callback may have registered a replacement under the same key.
				if (!this.#disposed && this.#sources.get(source.key) === source) {
					this.#captures.set(source.key, { value, dirty });
				}
			});
		}
		this.#syncRegistry();
	}

	async settle(
		keys: readonly string[] | undefined,
		ask: (dirtyKeys: readonly string[]) => Promise<DraftSettleChoice>
	): Promise<DraftSettleResult> {
		// Commit the targets and their requests before calling anything outside.
		const plan = untrack(() => {
			if (this.#disposed) return null;
			const all = new Set([...this.#sources.keys(), ...this.#captures.keys()]);
			const wanted = keys === undefined ? [...all] : keys.filter((key) => all.has(key));
			const targets = [...new Set(wanted)];
			const dirty: { key: string; source: DraftSource | undefined }[] = [];
			for (const key of targets) {
				const source = this.#sources.get(key);
				const isDirty = source ? source.isDirty() : this.#captures.get(key)?.dirty === true;
				if (isDirty) dirty.push({ key, source });
			}
			if (dirty.length === 0) return null;
			// Only the dirty ones are asked about / applied / discarded, but every
			// wanted target (clean ones too) is tracked: it must still be clean at the
			// end, and replacing / unregistering it makes the settle stale.
			const handles = targets.map((key) => this.#owner.begin(key));
			return { dirty, targets, handles };
		});
		if (!plan) return 'clean';
		const { dirty, targets, handles } = plan;
		const stale = () => handles.some((handle: RequestHandle) => !handle.isCurrent());
		const allClean = () =>
			untrack(() =>
				targets.every((key) => {
					const source = this.#sources.get(key);
					return source ? !source.isDirty() : this.#captures.get(key)?.dirty !== true;
				})
			);
		this.#addSettling(1);
		try {
			const choice = await ask(dirty.map(({ key }) => key));
			if (stale()) return 'stale';
			if (choice === 'cancel') return 'cancelled';

			if (choice === 'discard') {
				for (const { key, source } of dirty) {
					if (source) source.discard();
					else untrack(() => this.#captures.delete(key));
					if (stale()) return 'stale';
				}
				this.#syncRegistry();
				return allClean() ? 'discarded' : 'dirty-again';
			}

			// Start every apply first (each snapshots its own input at its start), then
			// await them, so input typed during a slow apply is never saved by a later one.
			// Each apply runs consumer code synchronously up to its first await, which
			// may dispose the coordinator or replace / unregister a target: check
			// before starting the next one, and never start an apply after that.
			const started: Promise<boolean>[] = [];
			for (const { source } of dirty) {
				if (stale()) return 'stale';
				// A capture without its form cannot be applied.
				if (!source) {
					started.push(Promise.resolve(false));
					continue;
				}
				try {
					started.push(
						Promise.resolve(source.apply()).then(
							(r) => r === true,
							() => false
						)
					);
				} catch {
					started.push(Promise.resolve(false));
				}
			}
			if (stale()) return 'stale';
			const results = await Promise.all(started);
			if (stale()) return 'stale';
			const failed = results.some((ok) => !ok);
			if (failed) return 'failed';
			return allClean() ? 'applied' : 'dirty-again';
		} finally {
			for (const handle of handles) handle.finish();
			this.#addSettling(-1);
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		untrack(() => {
			this.#sources.clear();
			this.#captures.clear();
		});
		this.#syncRegistry();
		this.#owner.dispose();
	}
}

/** Create a coordinator for the drafts of one screen (shared-primitives-upstream-plan §3.5). */
export function createDraftCoordinator(options: DraftCoordinatorOptions): DraftCoordinator {
	return new Coordinator(options);
}
