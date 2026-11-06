/**
 * Session-scoped list view state (Issue #215): so a "list -> detail -> save
 * -> list" round trip restores the sort/filters the user had set instead of
 * starting over, and the row just opened/edited can be found again.
 *
 * Deliberately generic - keyed by an opaque `key` string the caller composes
 * (e.g. `${resource}:${mode}`), not tied to `@banto/grid-svelte`'s
 * `GridState` or any one resource - so any list screen (admin-template's
 * items/users/audit-log, or a derived app's own resource) can reuse the same
 * mechanism instead of each wiring its own ad hoc persistence.
 *
 * Backed by `sessionStorage`, not `localStorage`: this is working context for
 * the CURRENT tab/session (spec's own "同一セッション" framing for #215), not
 * a durable per-user preference synced to a backend - that role already
 * belongs to `UiSettingsProvider` (providers/uiSettings.ts). Column layout
 * (order/widths/hidden) is deliberately NOT part of `ListViewSnapshot` -
 * that's issue #168's scope; this only carries what changes which rows/order
 * are shown (sort/filters/groupBy) plus a lightweight work-position marker
 * (`lastOpenedId`).
 *
 * Ownership (Issue #215/#255, 4th review - redesign): `sessionStorage`
 * belongs to the TAB, not to whoever is signed in, and the tab's identity
 * can change behind its back (another tab replaces the shared "Remember me"
 * token; a session ends and the guard moves the tab to the public viewer).
 * So every entry is written as `{ owner, data }` and every function takes
 * the caller's `SessionScope` (`sessionScope.svelte.ts`, captured with
 * `currentSessionScope()` when the screen/operation started):
 *
 * - a READ returns only an entry whose `owner` is the scope's owner - state
 *   saved for anyone else is invisible, however the identity changed;
 * - a WRITE happens only while the scope is still the live session
 *   (`isCurrentSessionScope`) - a screen or an in-flight save that outlived
 *   its session (a new generation, even for the same account) cannot write
 *   the old session's state back;
 * - a scope with no confirmed owner (`owner === null`: before the route
 *   guard confirmed a session, after the session ended, or an identity
 *   without an id) neither reads nor writes - the
 *   feature is simply off rather than guessing.
 *
 * The `SessionController` additionally deletes entries owned by anyone else
 * when it confirms an owner, and everything when it confirms `none` (its
 * `onActive`/`onNone`) - hygiene, not the safety boundary: the owner check
 * above holds even if those never ran.
 *
 * Every read/write is best-effort: a full, disabled, or private-mode
 * `sessionStorage` silently no-ops rather than breaking the page (same
 * stance as `providers/uiSettings.ts`'s localStorage backend and
 * `apps/admin-template/src/lib/banto/locale.ts`'s FOUC cache). `storage` is
 * an optional override (defaults to the global `sessionStorage`) purely so
 * tests can inject a fake without touching global state - same convention as
 * `LocalUiSettingsOptions.storage`.
 */
import { isCurrentSessionScope, type SessionScope } from './sessionScope.svelte';
import type { FilterOp, FilterState, SortDirection, SortState } from './types';

/** Every key this module ever writes starts with this - `clearAllListViewState` sweeps by it alone. */
const NAMESPACE = 'banto.listView.';
const SNAPSHOT_PREFIX = NAMESPACE;
const MODE_PREFIX = `${NAMESPACE}mode.`;
const LAST_OPENED_PREFIX = `${NAMESPACE}lastOpened.`;
const LAST_EDITED_PREFIX = `${NAMESPACE}lastEdited.`;

export interface ListViewSnapshot {
	sort: SortState[];
	filters: FilterState[];
	/** Client-mode-only grouping column id (grid-svelte `GridState.groupBy`). Omit for a list with no grouping concept. */
	groupBy?: string | null;
}

const SORT_DIRECTIONS: ReadonlySet<SortDirection> = new Set(['asc', 'desc']);
// Mirrors `FilterOp` (types.ts) exactly - kept as its own literal list (not
// derived from the type, which doesn't exist at runtime) so an op added to
// one and not the other is a compile error at the call site below, not a
// silently-accepted new string here.
const FILTER_OPS: ReadonlySet<FilterOp> = new Set([
	'eq',
	'ne',
	'lt',
	'lte',
	'gt',
	'gte',
	'contains',
	'starts_with',
	'in',
	'is_null',
	'not_null'
]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

/**
 * A saved payload is untrusted input (#215/#255 review): a column can be
 * renamed/removed between sessions, a hand-edited/corrupted `sessionStorage`
 * entry can carry any shape at all, and a future version of this module
 * could change `FilterOp`'s members. Validate every ELEMENT's shape, not
 * just "the arrays exist" - a single malformed sort/filter entry (missing
 * `field`, an unrecognized `op`, a `direction` that isn't `asc`/`desc`, no
 * `value` key at all) rejects the WHOLE snapshot rather than risk feeding a
 * half-formed `FilterState`/`SortState` into `DataProvider.getList` or
 * `@banto/grid-svelte`'s `filterRows` (an unknown `op` there matches
 * nothing, silently emptying the grid instead of failing loudly - #215).
 */
function isSortState(value: unknown): value is SortState {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		isNonEmptyString(candidate.field) &&
		typeof candidate.direction === 'string' &&
		SORT_DIRECTIONS.has(candidate.direction as SortDirection)
	);
}

function isFilterState(value: unknown): value is FilterState {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		isNonEmptyString(candidate.field) &&
		typeof candidate.op === 'string' &&
		FILTER_OPS.has(candidate.op as FilterOp) &&
		'value' in candidate
	);
}

function isSnapshot(value: unknown): value is ListViewSnapshot {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	if (!Array.isArray(candidate.sort) || !candidate.sort.every(isSortState)) return false;
	if (!Array.isArray(candidate.filters) || !candidate.filters.every(isFilterState)) return false;
	if (
		candidate.groupBy !== undefined &&
		candidate.groupBy !== null &&
		typeof candidate.groupBy !== 'string'
	) {
		return false;
	}
	return true;
}

/** The global `sessionStorage`, or `null` when unavailable (SSR, disabled storage, ...). Never throws. */
function defaultStorage(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
	return storage === undefined ? defaultStorage() : storage;
}

function readJson(storage: Storage, key: string): unknown {
	let raw: string | null;
	try {
		raw = storage.getItem(key);
	} catch {
		return undefined;
	}
	if (!raw) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function writeJson(storage: Storage, key: string, value: unknown): void {
	try {
		storage.setItem(key, JSON.stringify(value));
	} catch {
		// Ignore: quota exceeded, disabled storage, private mode, ...
	}
}

/** What is actually stored under every key: the data plus the `sessionOwnerKey` it was saved for. */
interface OwnedEntry {
	owner: string;
	data: unknown;
}

function isOwnedEntry(value: unknown): value is OwnedEntry {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return isNonEmptyString(candidate.owner) && 'data' in candidate;
}

/** May `scope` touch storage at all? Only a confirmed owner of the LIVE session. */
function isUsableScope(scope: SessionScope): scope is SessionScope & { owner: string } {
	return scope.owner !== null && isCurrentSessionScope(scope);
}

function writeOwned(
	scope: SessionScope,
	key: string,
	data: unknown,
	storage: Storage | null | undefined
): void {
	const store = resolveStorage(storage);
	if (!store || !isUsableScope(scope)) return;
	const entry: OwnedEntry = { owner: scope.owner, data };
	writeJson(store, key, entry);
}

/** The stored data for `key` if it belongs to `scope`'s owner, else `undefined`. */
function readOwned(scope: SessionScope, key: string, storage: Storage | null | undefined): unknown {
	const store = resolveStorage(storage);
	if (!store || !isUsableScope(scope)) return undefined;
	const parsed = readJson(store, key);
	if (!isOwnedEntry(parsed) || parsed.owner !== scope.owner) return undefined;
	return parsed.data;
}

function removeKey(store: Storage, key: string): void {
	try {
		store.removeItem(key);
	} catch {
		// Ignore.
	}
}

function namespaceKeys(store: Storage): string[] {
	const keys: string[] = [];
	try {
		for (let i = 0; i < store.length; i++) {
			const key = store.key(i);
			if (key && key.startsWith(NAMESPACE)) keys.push(key);
		}
	} catch {
		// Ignore: an unreadable storage has nothing we could remove anyway.
	}
	return keys;
}

/**
 * Persist `snapshot` for `key` (caller-composed, e.g. `items:server`) on
 * behalf of `scope`'s owner. A no-op unless `scope` is the live session with
 * a confirmed owner (see the module doc comment).
 * `storage` is for tests only - omit it in application code.
 */
export function saveListViewState(
	scope: SessionScope,
	key: string,
	snapshot: ListViewSnapshot,
	storage?: Storage | null
): void {
	writeOwned(scope, `${SNAPSHOT_PREFIX}${key}`, snapshot, storage);
}

/**
 * Load the snapshot `scope`'s owner saved for `key`, or `null` if there is
 * none, it belongs to someone else, `scope` is no longer the live session,
 * or it's invalid (see `isSnapshot`'s doc comment).
 *
 * `knownFields`, when given, drops any `sort`/`filters` entry whose `field`
 * isn't in it (#215/#255 review: a column removed/renamed since the
 * snapshot was saved must not restore a filter/sort the current screen has
 * no column for) - the REST of the snapshot still loads; only the stale
 * entries disappear. Omit it to skip this check (the caller has no fixed
 * column set to check against, or already trusts the source).
 */
export function loadListViewState(
	scope: SessionScope,
	key: string,
	knownFields?: readonly string[],
	storage?: Storage | null
): ListViewSnapshot | null {
	const parsed = readOwned(scope, `${SNAPSHOT_PREFIX}${key}`, storage);
	if (!isSnapshot(parsed)) return null;
	if (!knownFields) return parsed;
	const known = new Set(knownFields);
	return {
		...parsed,
		sort: parsed.sort.filter((entry) => known.has(entry.field)),
		filters: parsed.filters.filter((entry) => known.has(entry.field))
	};
}

/** Drop a saved snapshot for `key` (e.g. a caller offering its own "reset filters" action that should also forget the saved state). Removing is always safe, so no scope is needed. */
export function clearListViewState(key: string, storage?: Storage | null): void {
	const store = resolveStorage(storage);
	if (!store) return;
	removeKey(store, `${SNAPSHOT_PREFIX}${key}`);
}

/**
 * Drop EVERY key this module has ever written - every snapshot (any
 * resource/mode), every active-mode marker, every last-opened-id marker,
 * and any pending last-edited-record marker, whoever owns it.
 * The `SessionController` calls this on every commit to `none` (I-6).
 */
export function clearAllListViewState(storage?: Storage | null): void {
	const store = resolveStorage(storage);
	if (!store) return;
	for (const key of namespaceKeys(store)) removeKey(store, key);
}

/**
 * Drop every entry NOT owned by `owner` (malformed/legacy entries without
 * an owner included); `owner === null` drops everything.
 * The `SessionController` calls this once an owner is confirmed, so another identity's search terms do not linger in this tab
 * even though reads would never return them.
 */
export function purgeListViewStateNotOwnedBy(owner: string | null, storage?: Storage | null): void {
	const store = resolveStorage(storage);
	if (!store) return;
	for (const key of namespaceKeys(store)) {
		const parsed = owner === null ? undefined : readJson(store, key);
		if (!isOwnedEntry(parsed) || parsed.owner !== owner) removeKey(store, key);
	}
}

/**
 * Remember which named view (e.g. `'client' | 'server'`) was last active for
 * `resource`, so a page offering more than one presentation of the same list
 * (admin-template's items page: クライアント/サーバー toggle) reopens the
 * one the user had, not always its default - otherwise the restored
 * filters/sort of the OTHER mode would silently go unused.
 */
export function saveActiveListMode(
	scope: SessionScope,
	resource: string,
	mode: string,
	storage?: Storage | null
): void {
	writeOwned(scope, `${MODE_PREFIX}${resource}`, mode, storage);
}

/** The last mode `scope`'s owner saved with `saveActiveListMode` for `resource`, or `null` if none. */
export function loadActiveListMode(
	scope: SessionScope,
	resource: string,
	storage?: Storage | null
): string | null {
	const parsed = readOwned(scope, `${MODE_PREFIX}${resource}`, storage);
	return typeof parsed === 'string' ? parsed : null;
}

/**
 * Remember the row most recently opened for `resource` (any detail/edit
 * screen for it - list navigation, a direct URL visit, whatever got there),
 * so a list page can highlight/find it again once the user comes back
 * (Issue #215's "直前の作業位置を見つけられるようにする"). Deliberately
 * ONE value per resource, not per list mode: only one of a page's
 * presentations (e.g. admin-template items' クライアント/サーバー grids) is
 * ever on screen at a time, and whichever the user returns to is the one
 * that should show the mark - there's nothing to disambiguate.
 *
 * Callers should set this from the DESTINATION screen (the detail/edit
 * page, on mount), not from the list's row-click handler: a link-styled
 * "開く" cell navigates via its own `href` and never runs a grid's
 * `onRowClick` callback when the grid also has editable columns
 * (`packages/grid-svelte/src/BantoGrid.svelte`'s `handleCellClick` doc
 * comment) - the detail page is the one place every "how did I get here"
 * path (a grid link click, a double-click on a read-only cell, a pasted
 * URL, the browser back button) reliably passes through.
 */
export function saveLastOpenedId(
	scope: SessionScope,
	resource: string,
	id: string | number | null,
	storage?: Storage | null
): void {
	const key = `${LAST_OPENED_PREFIX}${resource}`;
	if (id !== null) {
		writeOwned(scope, key, id, storage);
		return;
	}
	const store = resolveStorage(storage);
	if (store && isUsableScope(scope)) removeKey(store, key);
}

/** The id `scope`'s owner saved with `saveLastOpenedId` for `resource`, or `null` if none (or it's malformed). */
export function loadLastOpenedId(
	scope: SessionScope,
	resource: string,
	storage?: Storage | null
): string | number | null {
	const parsed = readOwned(scope, `${LAST_OPENED_PREFIX}${resource}`, storage);
	return typeof parsed === 'string' || typeof parsed === 'number' ? parsed : null;
}

export interface LastEditedRecord {
	id: string | number;
	/**
	 * The row's field values AT SAVE TIME, so a list page can check them
	 * against its own restored filters (`@banto/grid-svelte`'s
	 * `filterRows`) without a round trip to the server: does this row still
	 * match the condition the user still has active? If not, the list must
	 * explain that instead of silently clearing the filter (#215's
	 * "編集結果が絞り込みの条件から外れた場合も、フィルタを勝手に解除しない"
	 * requirement).
	 */
	values: Record<string, unknown>;
}

function isLastEditedRecord(value: unknown): value is LastEditedRecord {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		(typeof candidate.id === 'string' || typeof candidate.id === 'number') &&
		typeof candidate.values === 'object' &&
		candidate.values !== null
	);
}

/**
 * Record the row a detail screen just saved. One-shot by design:
 * `takeLastEditedRecord` clears it on read, so a later revisit (without a
 * fresh save) shows nothing.
 *
 * Pass the scope the detail screen captured when it STARTED (not a fresh
 * `currentSessionScope()` taken after the save resolves): a save still in
 * flight when the session ended - or ended and began again, even as the
 * same account - must not leave its marker for the new session (#255
 * review).
 */
export function noteLastEditedRecord(
	scope: SessionScope,
	resource: string,
	record: LastEditedRecord,
	storage?: Storage | null
): void {
	writeOwned(scope, `${LAST_EDITED_PREFIX}${resource}`, record, storage);
}

/** Read and clear `scope`'s owner's last-edited-record marker for `resource` (see `noteLastEditedRecord`). A stale or ownerless `scope` neither reads nor clears anything. */
export function takeLastEditedRecord(
	scope: SessionScope,
	resource: string,
	storage?: Storage | null
): LastEditedRecord | null {
	const store = resolveStorage(storage);
	if (!store || !isUsableScope(scope)) return null;
	const key = `${LAST_EDITED_PREFIX}${resource}`;
	const parsed = readOwned(scope, key, store);
	removeKey(store, key);
	return isLastEditedRecord(parsed) ? parsed : null;
}
