/**
 * Package-internal request owner of `@banto/image-assets` (ADR-0020 §5,
 * shared-primitives-upstream-plan §3.7・§4.1・D1, Issue #436 / #438). NOT exported from the
 * package entry.
 *
 * `@banto/image-assets` cannot import `@banto/admin-core` (conventions §4・§5, plan §2.1), so
 * this file is an internal implementation of the SAME contract as admin-core's
 * `createRequestOwner` (`packages/admin-core/src/request.svelte.ts`; read its module comment
 * for the rationale of each rule: cancel vs discard, exactly-once release, why a re-entrant
 * abort listener must already see the newest state). It is a copy of the forms copy
 * (`packages/forms/src/requestOwner.svelte.ts`). The copies must not drift:
 * `tests/requestOwnerContract.test.ts` runs admin-core's contract table
 * (`packages/admin-core/tests/contracts/request-owner.json`, read by relative path) against
 * this file. When the contract changes, change the table and every copy together.
 *
 * `ImageStore` uses it for its pending `add()`s: a newer add of the same key, `cancel(key)` and
 * `dispose()` make a pending add stale, and a stale add neither stores its image nor reports its
 * error (it resolves to `null`).
 */

import { untrack } from 'svelte';

/** Key used when `begin()` / `invalidate()` / `busy()` are called without one. */
export const DEFAULT_REQUEST_KEY = '';

/** One request started by {@link RequestOwner.begin}. */
export interface RequestHandle {
	/** Aborted when the request goes stale (superseded, invalidated, owner disposed). Pass it to cancellable work. */
	readonly signal: AbortSignal;
	/**
	 * Still the latest request for its key, not invalidated, and the owner is
	 * alive. Check it right before applying a result or an error. Finishing
	 * does not change it.
	 */
	isCurrent(): boolean;
	/**
	 * Entrust a temporary resource to this request. Unless adopted, `release`
	 * is called exactly once at `finish()` or `owner.dispose()`, whichever
	 * comes first; if either already happened it is called immediately.
	 * Returns `resource` for chaining.
	 */
	hold<T>(resource: T, release: (resource: T) => void): T;
	/**
	 * Transfer a held resource to the owner's model (its release is no longer
	 * called). Returns false — and transfers nothing — when the request is not
	 * current or already finished; the resource then stays held and is
	 * released as usual. Adopting a value that was never held returns the same
	 * answer (whether the result may be applied) without side effects.
	 */
	adopt(resource: unknown): boolean;
	/**
	 * End the request (call it from `finally`). Releases resources not adopted
	 * and, if this is still the current request, clears its busy state.
	 * Returns true only in that case, so `if (handle.finish()) loading = false`
	 * never lets an old request's `finally` clear a newer request's busy flag.
	 * A second call does nothing and returns false.
	 */
	finish(): boolean;
}

/** The requests of one owner (screen / controller). `dispose()` it on unmount. */
export interface RequestOwner {
	/** Start a request for `key`. The previous request of the same key goes stale and its signal is aborted. */
	begin(key?: string): RequestHandle;
	/** The target of `key` changed (the consumer decides what counts). Its current request goes stale and stops being busy. */
	invalidate(key?: string): void;
	/** Every request goes stale and every unadopted resource is released now. Later `begin()` calls return already-stale handles. */
	dispose(): void;
	readonly disposed: boolean;
	/** The **current** request of `key` has not finished. Reactive (readable from `$derived`). Stale requests never count. */
	busy(key?: string): boolean;
}

interface Held {
	resource: unknown;
	release: (resource: unknown) => void;
}

class Request implements RequestHandle {
	readonly #controller = new AbortController();
	readonly #owner: Owner;
	#stale = false;
	#finished = false;
	#released = false;
	#held: Held[] = [];

	constructor(owner: Owner) {
		this.#owner = owner;
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	isCurrent(): boolean {
		// The owner's disposal is checked too: dispose() expires requests one by
		// one and each expire()/release can run consumer callbacks, so a request
		// whose turn has not come yet must already answer "stale" to them.
		return !this.#stale && !this.#owner.disposed;
	}

	get finished(): boolean {
		return this.#finished;
	}

	/** Owner-side: mark stale and abort. Idempotent. */
	expire(): void {
		if (this.#stale) return;
		this.#stale = true;
		this.#controller.abort();
	}

	hold<T>(resource: T, release: (resource: T) => void): T {
		const entry: Held = { resource, release: release as (resource: unknown) => void };
		if (this.#released) runReleases([entry]);
		else this.#held.push(entry);
		return resource;
	}

	adopt(resource: unknown): boolean {
		if (!this.isCurrent() || this.#finished) return false;
		this.#held = this.#held.filter((entry) => entry.resource !== resource);
		return true;
	}

	finish(): boolean {
		if (this.#finished) return false;
		this.#finished = true;
		// Release first, then ask "was I the latest?": a release callback may
		// begin() a newer request on the same key, and answering before it ran
		// would let `if (request.finish()) loading = false` clear that newer
		// request's loading. settle() runs even if a release throws.
		try {
			this.releaseHeld();
		} catch (error) {
			this.#owner.settle(this);
			throw error;
		}
		return this.#owner.settle(this);
	}

	/** Release every unadopted resource now; later `hold()`s release immediately. */
	releaseHeld(): void {
		this.#released = true;
		const held = this.#held;
		this.#held = [];
		runReleases(held);
	}
}

/** Call every release even if one throws; rethrow the first failure afterwards. */
function runReleases(held: Held[]): void {
	let failure: { error: unknown } | null = null;
	for (const entry of held) {
		try {
			entry.release(entry.resource);
		} catch (error) {
			failure ??= { error };
		}
	}
	if (failure) throw failure.error;
}

class Owner implements RequestOwner {
	#current = new Map<string, Request>();
	#live = new Set<Request>();
	#disposed = false;
	// Bumped whenever a busy answer may change, so `busy()` read inside
	// `$derived` / templates re-evaluates. The map itself stays non-reactive.
	#version = $state(0);

	// `++` reads `#version` before writing it. `begin()` is typically called
	// from an `$effect` (e.g. `ListResource.load()` on mount); a tracked read
	// there would subscribe that effect to `#version` and the write would
	// re-run it forever. Read untracked; `busy()` is the only tracked reader.
	#bump(): void {
		this.#version = untrack(() => this.#version) + 1;
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	begin(key: string = DEFAULT_REQUEST_KEY): RequestHandle {
		const request = new Request(this);
		if (this.#disposed) {
			request.expire();
			request.releaseHeld();
			return request;
		}
		// Register the new request before expiring the old one: expire() aborts
		// synchronously, and an abort listener may dispose() this owner or
		// begin() again. Committing first means such a re-entrant call sees (and
		// expires / supersedes) the new request instead of being overwritten.
		const previous = this.#current.get(key);
		this.#current.set(key, request);
		this.#live.add(request);
		this.#bump();
		previous?.expire();
		return request;
	}

	invalidate(key: string = DEFAULT_REQUEST_KEY): void {
		const request = this.#current.get(key);
		if (!request) return;
		// Remove before expire(): an abort listener that begin()s a new request
		// on this key must not have it deleted afterwards.
		this.#current.delete(key);
		this.#bump();
		request.expire();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const live = [...this.#live];
		// A finished request stays in #current (settle) and is no longer live,
		// but a caller may still hold its handle: expire it too, so disposal
		// really makes every request stale (isCurrent() false, signal aborted).
		const settled = [...this.#current.values()].filter((request) => !this.#live.has(request));
		this.#live.clear();
		this.#current.clear();
		for (const request of settled) request.expire();
		let failure: { error: unknown } | null = null;
		for (const request of live) {
			request.expire();
			try {
				request.releaseHeld();
			} catch (error) {
				failure ??= { error };
			}
		}
		this.#bump();
		if (failure) throw failure.error;
	}

	busy(key: string = DEFAULT_REQUEST_KEY): boolean {
		void this.#version;
		const request = this.#current.get(key);
		return request !== undefined && !request.finished;
	}

	/** Called once from `Request.finish()`. Returns whether it was the current request. */
	settle(request: Request): boolean {
		this.#live.delete(request);
		if (!request.isCurrent()) return false;
		// Keep it in #current (still current, just not busy) so a later
		// invalidate() of this key is a no-op for it; bump for busy().
		this.#bump();
		return true;
	}
}

/** Create an internal request owner (same contract as admin-core's `createRequestOwner`, plan §3.1・§3.7). */
export function createRequestOwner(): RequestOwner {
	return new Owner();
}
