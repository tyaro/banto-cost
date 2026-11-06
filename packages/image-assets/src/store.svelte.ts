/**
 * The store of image originals and their object URLs (ADR-0020, shared-primitives-upstream-plan
 * §3.7, PR-14, Issue #438).
 *
 * - **Originals**: `add()` runs the import check (`inspectImage`) and keeps the original bytes as
 *   an immutable `Blob` typed with the MIME type from the header. Nothing re-encodes them.
 * - **De-duplication**: the key is the SHA-256 of the original (D11). The same content is kept
 *   once; adding it again returns the metadata already stored.
 * - **Total size**: `maxTotalBytes` is a required option (ADR-0020 §2: no default, and "no limit"
 *   is not a default either). Going over it is `ImageAssetError('store-full')`.
 * - **Object URLs** are shared per original and counted: `acquireUrl()` creates the URL on the
 *   first lease, and the last `release()` revokes it (conventions §8: the owner revokes).
 * - **pin / release** keeps originals that asynchronous work still reads (an export, a pending
 *   replacement) through `collect()`, `delete()` and `dispose()`. An open URL lease keeps its
 *   original the same way. After `dispose()`, a kept original goes away with its last release.
 * - **Stale requests** (conventions §8, plan §2.1): pending `add()`s belong to an internal copy of
 *   admin-core's request owner (`requestOwner.svelte.ts`). A newer add of the same `key`,
 *   `cancel(key)` and `dispose()` make a pending add stale: it stores nothing and reports nothing
 *   (it resolves to `null`, even when its check failed).
 *
 * Every failure is an `ImageAssetError` (no display text, conventions §13), except passing
 * something that is not a store to `importFrom` (a `TypeError`, like bytes of the wrong type).
 *
 * Reactivity: `count`, `totalBytes`, `has()`, `disposed` and `busy()` can be read from
 * `$derived` / templates. Every method that writes may be called from an `$effect`: none of
 * them reads the reactive version tracked (a tracked read there would make the effect re-run
 * itself forever).
 */
import { untrack } from 'svelte';
import {
	inspectOwnedBytes,
	readImageInput,
	type DecodeOptions,
	type ImageMetadata
} from './decode';
import { ImageAssetError } from './errors';
import type { ImageBytes } from './header';
import { validateImageImportLimits, type ImageImportLimits } from './limits';
import { createRequestOwner, type RequestOwner } from './requestOwner.svelte';

/** How the store makes and revokes object URLs. Defaults to `URL.createObjectURL` / `URL.revokeObjectURL`. */
export interface ObjectUrlFunctions {
	create(blob: Blob): string;
	revoke(url: string): void;
}

export interface ImageStoreOptions {
	/** Largest total byte length of the originals kept at once (required, a positive safe integer). */
	readonly maxTotalBytes: number;
	/** Injected object URL functions (tests, or an app that tracks its URLs). */
	readonly objectUrls?: ObjectUrlFunctions;
}

export interface AddImageOptions extends DecodeOptions {
	/**
	 * Adds with the same key supersede each other (a newer add makes the pending one stale), and
	 * `busy(key)` / `cancel(key)` refer to it. Without a key an add is superseded only by `dispose()`.
	 */
	readonly key?: string;
}

/** One use of an original's object URL. */
export interface ImageUrlLease {
	readonly url: string;
	/** Ends this use. The last release of the URL revokes it. A second call does nothing. */
	release(): void;
}

export interface ImageStore {
	/** Number of originals kept. Reactive. */
	readonly count: number;
	/** Total byte length of the originals kept. Reactive. */
	readonly totalBytes: number;
	/** `dispose()` was called. Reactive. */
	readonly disposed: boolean;
	/** The store keeps an original with this hash. Reactive. */
	has(hash: string): boolean;
	/** Metadata of a kept original (frozen). Throws `unknown-asset`. */
	metadata(hash: string): ImageMetadata;
	/** The original bytes as an immutable `Blob` (type from the header). Throws `unknown-asset`. */
	blob(hash: string): Blob;
	/**
	 * Checks the image (`inspectImage`) and keeps the original. Resolves to the metadata (the one
	 * already kept when the content is a duplicate), or `null` when the add went stale while it
	 * ran. Rejects with `ImageAssetError`: the import check's codes, `store-full`, and
	 * `store-disposed` when called after `dispose()`.
	 */
	add(
		input: Blob | ImageBytes,
		limits: ImageImportLimits,
		options?: AddImageOptions
	): Promise<ImageMetadata | null>;
	/** The add of `key` is pending and current. Reactive. */
	busy(key: string): boolean;
	/** Makes the pending add of `key` stale (its target changed). No-op without one. */
	cancel(key: string): void;
	/**
	 * Keeps `source`'s original `hash` here too (the same immutable `Blob`, no copy of the bytes;
	 * de-duplicated, counted against this store's total). Returns its metadata. Throws
	 * `unknown-asset` (not in `source`), `store-full`, `store-disposed`.
	 */
	importFrom(source: ImageStore, hash: string): ImageMetadata;
	/**
	 * Keeps the originals through `collect()` / `delete()` / `dispose()` until the returned
	 * release is called (a second call does nothing). Every hash is checked before anything is
	 * pinned. Throws `unknown-asset`, `store-disposed`.
	 */
	pin(hashes: Iterable<string>): () => void;
	/** Shares the original's object URL (created on the first lease). Throws `unknown-asset`, `store-disposed`. */
	acquireUrl(hash: string): ImageUrlLease;
	/** Drops every original that is not in `retained`, not pinned and has no URL lease. Returns how many. */
	collect(retained: Iterable<string>): number;
	/** Drops one original unless it is pinned or has a URL lease. Returns whether it was dropped. */
	delete(hash: string): boolean;
	/**
	 * Makes pending adds stale and drops every original that is not pinned and has no URL lease.
	 * The rest stays readable and goes away with its last release. Later `add` / `importFrom` /
	 * `pin` / `acquireUrl` throw `store-disposed`. A second call does nothing.
	 */
	dispose(): void;
}

interface Entry {
	readonly metadata: ImageMetadata;
	readonly blob: Blob;
	pins: number;
	leases: number;
	url: string | null;
	/** `create` is running for this original (a re-entrant `acquireUrl` of it is refused). */
	creating: boolean;
}

const defaultObjectUrls: ObjectUrlFunctions = {
	create: (blob) => URL.createObjectURL(blob),
	revoke: (url) => URL.revokeObjectURL(url)
};

function validateOptions(options: ImageStoreOptions): {
	maxTotalBytes: number;
	urls: ObjectUrlFunctions;
} {
	if (typeof options !== 'object' || options === null)
		throw new ImageAssetError('invalid-limits', { field: 'options' });
	const maxTotalBytes: unknown = options.maxTotalBytes;
	if (
		typeof maxTotalBytes !== 'number' ||
		!Number.isSafeInteger(maxTotalBytes) ||
		maxTotalBytes <= 0
	)
		throw new ImageAssetError('invalid-limits', { field: 'maxTotalBytes' });
	const given: unknown = options.objectUrls;
	if (given === undefined) return { maxTotalBytes, urls: defaultObjectUrls };
	const urls = given as Partial<ObjectUrlFunctions> | null;
	if (
		typeof urls !== 'object' ||
		urls === null ||
		typeof urls.create !== 'function' ||
		typeof urls.revoke !== 'function'
	)
		throw new ImageAssetError('invalid-limits', { field: 'objectUrls' });
	// Snapshot the functions: the consumer's object may change later.
	return {
		maxTotalBytes,
		urls: { create: urls.create.bind(urls), revoke: urls.revoke.bind(urls) }
	};
}

/** Keys of the internal request owner: consumer keys and anonymous adds never collide. */
const keyed = (key: string) => `=${key}`;

class Store implements ImageStore {
	readonly #maxTotalBytes: number;
	readonly #urls: ObjectUrlFunctions;
	readonly #owner: RequestOwner = createRequestOwner();
	readonly #entries = new Map<string, Entry>();
	#total = 0;
	#disposed = false;
	#anonymous = 0;
	// Bumped whenever a reactive answer may change. The map and the counters stay non-reactive.
	#version = $state(0);

	constructor(options: ImageStoreOptions) {
		const { maxTotalBytes, urls } = validateOptions(options);
		this.#maxTotalBytes = maxTotalBytes;
		this.#urls = urls;
	}

	// `++` would read `#version` tracked; a write method called from an `$effect` would then
	// subscribe that effect to the version it writes and re-run it forever. Read untracked.
	#bump(): void {
		this.#version = untrack(() => this.#version) + 1;
	}

	get count(): number {
		void this.#version;
		return this.#entries.size;
	}

	get totalBytes(): number {
		void this.#version;
		return this.#total;
	}

	get disposed(): boolean {
		void this.#version;
		return this.#disposed;
	}

	has(hash: string): boolean {
		void this.#version;
		return this.#entries.has(hash);
	}

	#entry(hash: string): Entry {
		const entry = this.#entries.get(hash);
		if (!entry) throw new ImageAssetError('unknown-asset', { hash: String(hash) });
		return entry;
	}

	metadata(hash: string): ImageMetadata {
		return this.#entry(hash).metadata;
	}

	blob(hash: string): Blob {
		return this.#entry(hash).blob;
	}

	async add(
		input: Blob | ImageBytes,
		limits: ImageImportLimits,
		options: AddImageOptions = {}
	): Promise<ImageMetadata | null> {
		if (this.#disposed) throw new ImageAssetError('store-disposed');
		const checked = validateImageImportLimits(limits);
		const anonymous = options.key === undefined;
		const key = anonymous ? `#${++this.#anonymous}` : keyed(options.key as string);
		const request = this.#owner.begin(key);
		try {
			let metadata: ImageMetadata;
			let blob: Blob;
			try {
				const bytes = await readImageInput(input, checked);
				metadata = await inspectOwnedBytes(bytes, checked, options);
				blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: metadata.mimeType });
			} catch (error) {
				// A stale request reports nothing, not even its failure.
				if (!request.isCurrent()) return null;
				throw error;
			}
			// Superseded, cancelled or disposed while the check ran: keep nothing.
			if (!request.isCurrent()) return null;
			return this.#insert(metadata, blob);
		} finally {
			request.finish();
			// An anonymous key is never asked about again; do not keep it in the owner.
			if (anonymous) this.#owner.invalidate(key);
		}
	}

	busy(key: string): boolean {
		return this.#owner.busy(keyed(key));
	}

	cancel(key: string): void {
		this.#owner.invalidate(keyed(key));
	}

	/** Keeps an original (or returns the one already kept). Writes only; no tracked reads. */
	#insert(metadata: ImageMetadata, blob: Blob): ImageMetadata {
		const existing = this.#entries.get(metadata.sha256);
		if (existing) return existing.metadata;
		const total = this.#total + blob.size;
		if (total > this.#maxTotalBytes)
			throw new ImageAssetError('store-full', { limit: this.#maxTotalBytes, actual: total });
		this.#entries.set(metadata.sha256, {
			metadata,
			blob,
			pins: 0,
			leases: 0,
			url: null,
			creating: false
		});
		this.#total = total;
		this.#bump();
		return metadata;
	}

	importFrom(source: ImageStore, hash: string): ImageMetadata {
		if (this.#disposed) throw new ImageAssetError('store-disposed');
		if (!(source instanceof Store)) throw new TypeError('source must be an image store');
		const entry = source.#entry(hash);
		return this.#insert(entry.metadata, entry.blob);
	}

	pin(hashes: Iterable<string>): () => void {
		if (this.#disposed) throw new ImageAssetError('store-disposed');
		const list = Array.from(hashes);
		const entries = new Set<Entry>();
		// Check every hash before pinning any (index loop: a hole is an unknown hash, not skipped).
		for (let i = 0; i < list.length; i++) entries.add(this.#entry(list[i]));
		for (const entry of entries) entry.pins++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (const entry of entries) entry.pins--;
			if (this.#disposed) this.#dropUnheld(entries);
		};
	}

	acquireUrl(hash: string): ImageUrlLease {
		if (this.#disposed) throw new ImageAssetError('store-disposed');
		const entry = this.#entry(hash);
		if (entry.url === null) {
			if (entry.creating) throw new ImageAssetError('url-pending', { hash });
			// Hold the original and mark it before calling out: `create` is external and may call
			// back in (`delete` / `collect` / `dispose` must not drop it, a nested `acquireUrl` must
			// not make a second URL). If `create` throws, undo both.
			entry.creating = true;
			entry.leases++;
			let created: string;
			try {
				created = this.#urls.create(entry.blob);
			} catch (error) {
				entry.creating = false;
				entry.leases--;
				if (this.#disposed) this.#dropUnheld([entry]);
				throw error;
			}
			entry.creating = false;
			entry.url = created;
		} else {
			entry.leases++;
		}
		const url = entry.url;
		let released = false;
		return Object.freeze({
			url,
			release: () => {
				if (released) return;
				released = true;
				entry.leases--;
				if (entry.leases > 0) return;
				// Settle the store before calling out: `revoke` is external and may call back in.
				entry.url = null;
				if (this.#disposed) this.#dropUnheld([entry]);
				this.#urls.revoke(url);
			}
		});
	}

	collect(retained: Iterable<string>): number {
		const keep = new Set<string>();
		const list = Array.from(retained);
		for (let i = 0; i < list.length; i++) keep.add(list[i]);
		return this.#drop((hash) => !keep.has(hash));
	}

	delete(hash: string): boolean {
		return this.#drop((candidate) => candidate === hash) > 0;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#bump();
		this.#owner.dispose();
		this.#drop(() => true);
	}

	/** Drops the matching originals that nothing holds. Unheld ones have no URL to revoke. */
	#drop(matches: (hash: string) => boolean): number {
		let dropped = 0;
		for (const [hash, entry] of [...this.#entries]) {
			if (entry.pins > 0 || entry.leases > 0 || !matches(hash)) continue;
			this.#entries.delete(hash);
			this.#total -= entry.blob.size;
			dropped++;
		}
		if (dropped > 0) this.#bump();
		return dropped;
	}

	/** After `dispose()`: drop these entries once nothing holds them (if still the kept ones). */
	#dropUnheld(entries: Iterable<Entry>): void {
		let dropped = false;
		for (const entry of entries) {
			const hash = entry.metadata.sha256;
			if (entry.pins > 0 || entry.leases > 0 || this.#entries.get(hash) !== entry) continue;
			this.#entries.delete(hash);
			this.#total -= entry.blob.size;
			dropped = true;
		}
		if (dropped) this.#bump();
	}
}

/**
 * Creates a store of image originals (PR-14). `maxTotalBytes` is required; invalid options throw
 * `ImageAssetError('invalid-limits', { field })` (`options`, `maxTotalBytes` or `objectUrls`).
 */
export function createImageStore(options: ImageStoreOptions): ImageStore {
	return new Store(options);
}
