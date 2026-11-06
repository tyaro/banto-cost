/**
 * Unseen-change badge counts for sidebar navigation entries
 * (choiapp-feedback-2026-09 §4.1; Svelte 5 runes). Same "module singleton
 * populated by the app shell" pattern as `#lib/settings.svelte.ts` /
 * `#lib/toast.svelte.ts`.
 *
 * Ownership split:
 * - `routes/(app)/+layout.svelte` WIRES the store: it subscribes to
 *   admin-core's `onInvalidate` bus (spec §3.4 - fired both by this
 *   client's own mutations and by `resource_changed` server events, spec
 *   §3.5) for every `NavItem` that declares a `badgeResource`
 *   (#lib/navigation.ts), increments while the user is elsewhere, and
 *   clears a path's count when navigation lands on it.
 * - `Sidebar.svelte` only READS `count(path)` to render the badge.
 *
 * App authors who want a badge on their own nav entry set `badgeResource`
 * on the entry (anything that goes through admin-core's `invalidate()` -
 * form saves, `resource_changed` SSE/Tauri events - feeds it), or call
 * `increment(path)` themselves from any provider-layer code for sources
 * outside the invalidate bus.
 *
 * Deliberately NOT persisted: a badge is a "changed since you last
 * looked in this session" hint, not durable unread state.
 */

import type { InvalidateReason } from '@banto/admin-core';
import { isPathActive, type AppPath } from '#lib/appPath.js';

/** `/items` owns `/items` and `/items/...`; base-aware (#332), see `isPathActive`. */
const pathOwns = isPathActive;

class NavBadgeStore {
	/** Keyed by `NavItem.path`. Missing key = 0 = no badge rendered. */
	#counts = $state<Record<string, number>>({});

	count(path: AppPath): number {
		return this.#counts[path] ?? 0;
	}

	increment(path: AppPath): void {
		this.#counts[path] = (this.#counts[path] ?? 0) + 1;
	}

	/**
	 * Handle an invalidate-bus event for the nav entry `path`: count it as an
	 * unseen change unless the entry's page is on screen (its own list
	 * refetches live) or the event is a reconnect 'resync' (#289 - no known
	 * change, so no badge).
	 */
	noteInvalidation(path: AppPath, pathname: string, reason: InvalidateReason): void {
		if (reason === 'resync' || pathOwns(path, pathname)) return;
		this.increment(path);
	}

	/** Clear the badge of the nav entry that owns `pathname` (if any). */
	clearFor(pathname: string): void {
		for (const key of Object.keys(this.#counts)) {
			if (pathOwns(key as AppPath, pathname)) delete this.#counts[key];
		}
	}
}

export const navBadges = new NavBadgeStore();
export { pathOwns };
