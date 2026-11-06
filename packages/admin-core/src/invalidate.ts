/**
 * Tiny per-resource event bus so composables can invalidate cached
 * list/form state after mutations (spec §3.4).
 */

/**
 * Why a resource was invalidated. `'change'` (default) = something actually
 * changed (a mutation, a `resource_changed` event). `'resync'` = a precaution
 * after the change stream reconnected (Issue #289) - data MAY be stale but no
 * change is known. Subscribers that refetch ignore the distinction; anything
 * that announces "something changed" (e.g. an unread badge) must skip
 * `'resync'`.
 */
export type InvalidateReason = 'change' | 'resync';
type Callback = (resource: string, reason: InvalidateReason) => void;

const subscribers = new Map<string, Set<Callback>>();

/** Subscribe to invalidation of `resource`. Returns an unsubscribe function. */
export function onInvalidate(resource: string, cb: Callback): () => void {
	let set = subscribers.get(resource);
	if (!set) {
		set = new Set();
		subscribers.set(resource, set);
	}
	set.add(cb);
	return () => {
		set.delete(cb);
		if (set.size === 0) subscribers.delete(resource);
	};
}

/** Notify all subscribers of `resource` (e.g. after a create/update/delete). */
export function invalidate(resource: string, reason: InvalidateReason = 'change'): void {
	subscribers.get(resource)?.forEach((cb) => cb(resource, reason));
}

/**
 * Notify every resource that currently has subscribers, once each (Issue
 * #289: re-sync after the change stream reconnected). Same path as
 * `invalidate(resource, 'resync')` - each subscriber callback runs once per call.
 * `SnapshotListResource` has no subscriber on this bus (an append-only log
 * has no invalidation, ADR-0015), so its snapshot boundary is untouched.
 */
export function invalidateAll(): void {
	for (const resource of [...subscribers.keys()]) invalidate(resource, 'resync');
}
