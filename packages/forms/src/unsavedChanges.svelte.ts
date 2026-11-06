/**
 * Unsaved-changes guard (spec §7, issue #214): warn before an in-app
 * navigation, a reload/tab close, or (via the host's own wiring) a desktop
 * window close would silently throw away an edit that has not been saved.
 *
 * Design:
 * - **Confirm, don't restore.** The page keeps its draft in memory only; the
 *   guard asks before leaving instead of persisting a draft to come back to.
 *   Restoring would need a storage location, an expiry rule for stale drafts
 *   and a multi-tab story - a confirm prompt needs none of those.
 * - **No SvelteKit / Tauri dependency.** This package has no dependencies
 *   (conventions §3/§4/§5), so the host injects `beforeNavigate` from
 *   `$app/navigation` (a structural subset is typed below). The same
 *   callback also covers reload / tab close: SvelteKit calls it with
 *   `type: 'leave'` from its own `beforeunload` listener, where cancelling
 *   makes the browser show its native (non-customisable) prompt.
 * - **One prompt per navigation, however many guards are on screen.** Every
 *   mounted guard registers in a module-level registry; the first guard
 *   callback SvelteKit invokes for a navigation checks the WHOLE registry
 *   and answers for all of them (SvelteKit hands every callback the same
 *   navigation object, which is what `handled` keys on). A page with two
 *   save-type sections therefore prompts once if either one is unsaved.
 * - **The decision is a pure table** (`decideLeave`) so every state
 *   combination is unit-tested without a router.
 */
import { onMount, untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

/** Structural subset of SvelteKit's `BeforeNavigate` that the guard reads. */
export interface LeaveNavigation {
	/** `'leave'` = reload / tab close / external unload (`beforeunload`). */
	type: string;
	from: { url: URL } | null;
	to: { url: URL } | null;
	cancel(): void;
	/**
	 * Settles when the navigation finishes: resolves on success, rejects when
	 * it is cancelled, superseded or fails (SvelteKit's `Navigation.complete`).
	 * Used to know how long "the user already agreed to leave" lasts.
	 */
	complete?: Promise<void>;
}

/** Structural type of SvelteKit's `beforeNavigate` from `$app/navigation`. */
export type BeforeNavigateHook = (callback: (navigation: LeaveNavigation) => void) => void;

/**
 * - `allow`: navigate without asking.
 * - `confirm`: ask with the host's confirm dialog; cancel if the user says no.
 * - `block`: cancel so the browser shows its own `beforeunload` prompt
 *   (`window.confirm` is not allowed during unload).
 */
export type LeaveDecision = 'allow' | 'confirm' | 'block';

export interface LeaveDecisionInput {
	/** Some guard on screen has unsaved edits, or a save is still in flight. */
	pending: boolean;
	/** A forced move (logout, session end) - never hold the user back. */
	forced: boolean;
	/** Same pathname + search: the page (and its draft) stays mounted. */
	samePage: boolean;
	/** `LeaveNavigation.type`. */
	type: string;
}

/** The whole "ask or not" table (issue #214). Pure; see tests/unsavedChanges.test.ts. */
export function decideLeave(input: LeaveDecisionInput): LeaveDecision {
	if (!input.pending || input.forced) return 'allow';
	if (input.type === 'leave') return 'block';
	if (input.samePage) return 'allow';
	return 'confirm';
}

/** True when `navigation` stays on the same pathname + search (e.g. a hash change, or re-clicking the current nav entry). */
export function isSamePage(navigation: Pick<LeaveNavigation, 'from' | 'to'>): boolean {
	const from = navigation.from?.url;
	const to = navigation.to?.url;
	if (!from || !to) return false;
	return from.origin === to.origin && from.pathname === to.pathname && from.search === to.search;
}

/** What each mounted guard contributes to the shared registry. */
export interface UnsavedChangesSource {
	/** Unsaved edits, or a save still in flight. */
	isPending(): boolean;
	/** Resolved prompt text for this source (i18n layer ①: the host passes a resolved string). */
	message(): string;
}

export interface LeaveCheckOptions {
	/** Host confirm dialog. Default: `window.confirm` (Banto's existing confirm UI). */
	confirm?: (message: string) => boolean;
	/** Navigations that must never be held back (logout, session end). */
	isForced?: (navigation: LeaveNavigation) => boolean;
}

export type LeaveCheckResult = LeaveDecision | 'confirmed' | 'kept' | 'already-handled';

// Navigations one guard has already answered for, with the answer (see
// module doc comment): later guards reuse it to learn whether the user agreed
// to leave.
const handled = new WeakMap<object, LeaveCheckResult>();

function defaultConfirm(message: string): boolean {
	return typeof window === 'undefined' ? true : window.confirm(message);
}

/**
 * Evaluate one navigation against `sources` and act on it: cancel it for
 * `block`, or ask and cancel on "stay" for `confirm`. Exported for tests;
 * `guardUnsavedChanges` is the normal entry point.
 *
 * Returns what happened: `'allow'`, `'block'` (cancelled for the native
 * prompt), `'confirmed'` (asked, user chose to leave), `'kept'` (asked, user
 * chose to stay - navigation cancelled), or `'already-handled'` (another
 * guard answered this same navigation).
 */
export function runLeaveCheck(
	navigation: LeaveNavigation,
	sources: Iterable<UnsavedChangesSource>,
	options: LeaveCheckOptions = {}
): LeaveCheckResult {
	if (handled.has(navigation)) return 'already-handled';
	const result = decideAndAct(navigation, sources, options);
	handled.set(navigation, result);
	return result;
}

/** The answer the first guard gave for `navigation` (`undefined` if none yet). */
export function leaveCheckOutcome(navigation: LeaveNavigation): LeaveCheckResult | undefined {
	return handled.get(navigation);
}

/**
 * True when `outcome` means the page is about to be left: the navigation
 * goes ahead (asked-and-agreed, or nothing to ask) to another page, and its
 * end can be observed (`complete`). Reloads/tab closes (`type: 'leave'`) are
 * excluded: if the browser's unload is called off, nothing would ever end the
 * "leaving" state. Pure; see tests/unsavedChanges.test.ts.
 */
export function isApprovedExit(
	outcome: LeaveCheckResult | undefined,
	navigation: LeaveNavigation
): boolean {
	if (outcome !== 'allow' && outcome !== 'confirmed') return false;
	if (navigation.type === 'leave' || navigation.complete === undefined) return false;
	return !isSamePage(navigation);
}

function decideAndAct(
	navigation: LeaveNavigation,
	sources: Iterable<UnsavedChangesSource>,
	options: LeaveCheckOptions
): LeaveCheckResult {
	let firstPending: UnsavedChangesSource | undefined;
	for (const source of sources) {
		if (source.isPending()) {
			firstPending = source;
			break;
		}
	}
	const decision = decideLeave({
		pending: firstPending !== undefined,
		forced: options.isForced?.(navigation) ?? false,
		samePage: isSamePage(navigation),
		type: navigation.type
	});
	if (decision === 'allow') return 'allow';
	if (decision === 'block') {
		navigation.cancel();
		return 'block';
	}
	const leave = (options.confirm ?? defaultConfirm)(firstPending!.message());
	if (leave) return 'confirmed';
	navigation.cancel();
	return 'kept';
}

// Every guard currently mounted anywhere in the app. Reactive (`SvelteSet`)
// so `hasUnsavedChanges()` can drive an `$effect` (e.g. registering a
// desktop window-close listener only while something is unsaved).
const registry = new SvelteSet<UnsavedChangesSource>();

/**
 * True while any mounted guard has unsaved edits or a save in flight.
 * Reactive: reading it inside `$effect`/`$derived` re-runs on changes. Use it
 * for exits the router never sees - e.g. a Tauri window close request.
 */
export function hasUnsavedChanges(): boolean {
	for (const source of registry) {
		if (source.isPending()) return true;
	}
	return false;
}

/**
 * Package-internal: put a source into the shared registry outside a
 * component (not exported from the package entry). `DraftCoordinator`
 * (shared-primitives-upstream-plan §3.5) joins the registry this way so a
 * router leave, a mounted guard and `hasUnsavedChanges()` see the same drafts;
 * "one prompt per navigation" still holds because every guard checks the
 * whole registry once per navigation. Returns the removal function.
 */
export function joinUnsavedChangesRegistry(source: UnsavedChangesSource): () => void {
	untrack(() => registry.add(source));
	return () => {
		untrack(() => registry.delete(source));
	};
}

export interface UnsavedChangesGuardOptions extends LeaveCheckOptions {
	/** Current draft differs from what was loaded/saved (e.g. `() => store.isDirty`). */
	isDirty: () => boolean;
	/** A save is in flight - leaving now could drop it, so it counts as pending. */
	isSaving?: () => boolean;
	/** `beforeNavigate` from `$app/navigation`. */
	beforeNavigate: BeforeNavigateHook;
	/** Prompt text (resolved string, i18n layer ①). */
	message: () => string;
}

export interface UnsavedChangesGuard {
	/** `isDirty() || isSaving()` right now. */
	readonly pending: boolean;
	/** True once the owning component was destroyed. */
	readonly disposed: boolean;
	/**
	 * True from the moment a navigation away from this page goes ahead (the
	 * user agreed to leave, or there was nothing to ask) until it settles.
	 * If it is cancelled, superseded or fails, this turns false again.
	 */
	readonly leaving: boolean;
	/**
	 * `!disposed && !leaving`. Check it before a post-save `goto`: a save
	 * that finishes after the user chose another screen - while that screen
	 * is still loading, or after this page is gone - must not override the
	 * user's choice.
	 */
	readonly canAutoNavigate: boolean;
}

/**
 * Register an unsaved-changes guard for the calling component. Must be
 * called during component initialisation (same rule as `beforeNavigate`).
 *
 * After a successful save, make `isDirty` false BEFORE navigating (for a
 * `FormStore`: `store.markClean()`), and to discard, restore the draft (or
 * just navigate and let the prompt ask). Forced moves are exempted through
 * `isForced`.
 */
export function guardUnsavedChanges(options: UnsavedChangesGuardOptions): UnsavedChangesGuard {
	const source: UnsavedChangesSource = {
		isPending: () => options.isDirty() || (options.isSaving?.() ?? false),
		message: options.message
	};
	let disposed = false;
	// The navigation this page is currently being left by (null = staying).
	let leavingBy: LeaveNavigation | null = null;

	onMount(() => {
		registry.add(source);
		return () => {
			registry.delete(source);
			disposed = true;
		};
	});

	options.beforeNavigate((navigation) => {
		runLeaveCheck(navigation, registry, options);
		if (!isApprovedExit(leaveCheckOutcome(navigation), navigation)) return;
		leavingBy = navigation;
		const settle = () => {
			// Only the latest exit may clear it (an older, superseded one
			// settles after a newer one started).
			if (leavingBy === navigation) leavingBy = null;
		};
		navigation.complete!.then(settle, settle);
	});

	return {
		get pending() {
			return source.isPending();
		},
		get disposed() {
			return disposed;
		},
		get leaving() {
			return leavingBy !== null;
		},
		get canAutoNavigate() {
			return !disposed && leavingBy === null;
		}
	};
}
