/**
 * Command palette recency (spec M16: "最近使ったコマンドの並び上げ（localStorage）"),
 * kept per signed-in user (Issue #258).
 *
 * A flat list of command ids in localStorage - deliberately NOT going through
 * `UiSettingsProvider` (non-scope: "履歴の設定DB保存"), a per-device
 * convenience with no server round-trip. But localStorage belongs to the
 * BROWSER, not to whoever is signed in, so the entry is stored as
 * `{ owner, ids }` and follows the same rules as admin-core's
 * `listViewState.ts` (Issue #215/#255), keyed by the `SessionScope` the caller
 * captured (`currentSessionScope()`):
 *
 * - a READ returns only ids saved for the scope's owner - another user's
 *   history (and the old ownerless `string[]` format, whose owner is unknown)
 *   is invisible and dropped;
 * - a WRITE happens only while the scope is still the live session - a command
 *   that logs out (or an in-flight run that outlived its session) cannot
 *   write the old session's history;
 * - a scope with no confirmed owner (`owner === null`) neither reads nor
 *   writes: the feature is off rather than guessing. `publicViewer` and
 *   `local` (login-not-required) are owners like any other key.
 *
 * `watchRecentCommandOwner` is the hygiene half (listViewState's
 * `onActive`/`onNone` in the controller): drop the entry when `none` is
 * confirmed, and drop another owner's entry once an owner is confirmed. The
 * owner check above is the safety boundary; this only avoids lingering data.
 *
 * Everything is best-effort: a full/disabled/private-mode localStorage
 * silently no-ops. `options.storage`/`options.isCurrent` exist for tests.
 */
import {
	isCurrentSessionScope,
	type SessionController,
	type SessionScope,
	type SessionSnapshot
} from '@banto/admin-core';

export const RECENT_KEY = 'banto.commandPaletteRecent';
const MAX_RECENT = 10;

export interface RecentOptions {
	/** Defaults to the global `localStorage` (`null`/absent when unavailable). */
	storage?: Storage | null;
	/** Defaults to `isCurrentSessionScope`. */
	isCurrent?: (scope: SessionScope) => boolean;
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
	if (storage !== undefined) return storage;
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

interface OwnedRecent {
	owner: string;
	ids: string[];
}

function readRaw(store: Storage): string | null {
	try {
		return store.getItem(RECENT_KEY);
	} catch {
		return null;
	}
}

function parseEntry(raw: string | null): OwnedRecent | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const candidate = parsed as Record<string, unknown>;
		if (typeof candidate.owner !== 'string' || candidate.owner === '') return null;
		if (!Array.isArray(candidate.ids)) return null;
		return {
			owner: candidate.owner,
			ids: candidate.ids.filter((entry): entry is string => typeof entry === 'string')
		};
	} catch {
		return null;
	}
}

function removeEntry(store: Storage): void {
	try {
		store.removeItem(RECENT_KEY);
	} catch {
		// Ignore.
	}
}

/** Ordered most-recent-first ids saved for `scope`'s owner; `[]` for anyone else, an ownerless scope, or an old-format/corrupt entry (which is dropped). */
export function loadRecentCommandIds(scope: SessionScope, options: RecentOptions = {}): string[] {
	const store = resolveStorage(options.storage);
	if (!store || scope.owner === null) return [];
	const raw = readRaw(store);
	const entry = parseEntry(raw);
	if (entry === null) {
		// Unreadable or the old ownerless format: nobody can claim it.
		if (raw !== null) removeEntry(store);
		return [];
	}
	return entry.owner === scope.owner ? entry.ids : [];
}

/** Move `id` to the front (or insert it), capped at `MAX_RECENT`. No-op unless `scope` is the live session with a confirmed owner. Another owner's entry is replaced. */
export function recordRecentCommand(
	scope: SessionScope,
	id: string,
	options: RecentOptions = {}
): void {
	const store = resolveStorage(options.storage);
	const isCurrent = options.isCurrent ?? isCurrentSessionScope;
	if (!store || scope.owner === null || !isCurrent(scope)) return;
	const ids = [id, ...loadRecentCommandIds(scope, options).filter((existing) => existing !== id)];
	const next: OwnedRecent = { owner: scope.owner, ids: ids.slice(0, MAX_RECENT) };
	try {
		store.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// Best-effort convenience feature - never block command execution on it.
	}
}

/**
 * Hygiene wiring (listViewState's controller hooks): on a confirmed `none`
 * drop the history; once an owner is confirmed drop an entry owned by anyone
 * else (ownerless old-format entries included). Applies the current snapshot
 * once, then follows every change. Returns the unsubscribe function.
 */
export function watchRecentCommandOwner(
	controller: SessionController,
	options: RecentOptions = {}
): () => void {
	const apply = (snapshot: SessionSnapshot): void => {
		const store = resolveStorage(options.storage);
		if (!store) return;
		if (snapshot.status === 'none') {
			removeEntry(store);
		} else if (snapshot.status === 'active' && snapshot.owner !== null) {
			if (parseEntry(readRaw(store))?.owner !== snapshot.owner) removeEntry(store);
		}
	};
	apply(controller.snapshot);
	return controller.subscribe((snapshot) => apply(snapshot));
}
