/**
 * The single owner of every pointer gesture inside one `DockHost` (spec §5.2:
 * drag / resize / divider; shared-primitives-upstream-plan §3.3 and §4.2, #433).
 *
 * Before this module the four paths - floating resize (`DockWindow`), the
 * title-bar / tab drag threshold (`DockWindow`, `DockedTree`), the split
 * divider (`DockedTree`) and the dock drag itself (`DragController`) - each
 * added their own window listeners and each decided on their own when a
 * gesture ended. None of them could undo a live change, none of them listened
 * for Esc / pointercancel / blur / unmount, and the drag committed on ANY
 * pointer's `pointerup`. Now every path starts a session here and only
 * supplies what is specific to it (what a move does, what a commit does);
 * this owner holds the listeners, the pointer identity and the snapshot.
 *
 * ## The contract
 *
 * - **One session at a time.** `begin` refuses (returns `false`) while a
 *   session is active, for a non-primary pointer (`isPrimary === false`) and
 *   for a non-main button. The caller then does nothing (no preventDefault, no
 *   live change).
 * - **Only the owning pointer counts.** `pointermove` / `pointerup` /
 *   `pointercancel` / `lostpointercapture` with another `pointerId` are
 *   ignored: they neither move nor commit nor cancel.
 * - **Commit** happens on exactly one event: the owning pointer's `pointerup`.
 *   The session's `commit(event)` runs after the session is closed and its
 *   listeners are removed. It is the place to re-measure the host
 *   (`measureHost()`, a synchronous layout read - never the reactive size
 *   binding, which only updates when the ResizeObserver delivers, so a
 *   pointerup that arrives before the window-resize notification would
 *   otherwise commit against the old size).
 * - **Cancel** happens on: Esc that nobody has consumed (`defaultPrevented`
 *   false, the `isEscapeBlocked` hook - if given - returns false, and not
 *   during IME composition; the owner then calls `preventDefault`), the owning
 *   pointer's `pointercancel` or `lostpointercapture` (the latter only while
 *   its target is still connected - a node moved/removed by the DOM is not an
 *   abort), window `blur`, `visibilitychange` to hidden, `dispose()` (the
 *   `DockHost` unmounting) and an explicit `cancel()`. For a kind that writes
 *   the layout live (`resize`, `divider`, `move`),
 *   cancel undoes only the gesture's own target from the snapshot taken at
 *   `begin` (`GestureSpec.restore`: the resized window's geometry, the
 *   divider's split sizes), so a layout change the app made during the
 *   gesture is kept. `drag-candidate` / `drag` never write the layout before commit, so
 *   they restore nothing (and cannot clobber a concurrent app change).
 * - **Re-entrancy.** Before any session callback (`commit` / `cancel`) or the
 *   `onEnd` hook runs, the session is already `null` and every listener is
 *   removed, so a callback may start a new gesture or dispose the host
 *   without leaking listeners or resurrecting the old session.
 *
 * ## Keyboard sessions and hooks (#433-b, plan PR-5 / §4.3 / D5)
 *
 * - **Keyboard mode** (`beginKeyboard`): the floating window's explicit move /
 *   resize mode is a `move` / `resize` session with `pointerId: null`. It
 *   listens only for Esc, window `blur` and `visibilitychange` (no pointer
 *   event can own or commit it); the component that started it feeds the
 *   arrows itself (from a keydown on its own focused control - never a
 *   window-level keydown, so the shortcut dispatcher of #435 keeps every
 *   other key) and commits with `commitKeyboard()` (Enter). Cancel restores
 *   only the target, exactly like a pointer session.
 * - **Instant changes** (`instant`): one keyboard step on a divider (the
 *   WAI-ARIA Window Splitter's arrows / Home / End) is a session that begins
 *   and commits at once - it asks `canStart`, applies, and reports `commit` to
 *   `onEnd`, but leaves nothing to cancel.
 * - **Hooks** (`GestureOwnerOptions`, wired by `DockHost`'s
 *   `canStartGesture` / `onGestureEnd` / `isEscapeBlocked` props): `canStart`
 *   is asked before a session exists - except for `drag-candidate` (a press
 *   that may still turn out to be a plain click, such as a tab selection):
 *   that one is asked as `drag` when the threshold is crossed (`setKind`
 *   returns `false`, and the caller then ignores the rest of the press).
 *   `onEnd` runs once after the session closed; `isEscapeBlocked` on every
 *   unconsumed Esc of an active session.
 */
import { getContext, setContext } from 'svelte';
import type { DockState } from '../state.svelte';
import type { DockLayout } from '../types';

/**
 * What a session is doing. `move` is the floating window's keyboard move mode;
 * `resize` is a pointer resize or the keyboard resize mode (`pointerId: null`
 * tells them apart); `divider` is a pointer divider drag or one keyboard step.
 * The plan's draft `keyboard` kind is not used: a keyboard session keeps the
 * kind of what it changes (shared-primitives-upstream-plan §3.3).
 */
export type GestureKind = 'move' | 'resize' | 'divider' | 'drag-candidate' | 'drag';

/** Why a session was cancelled (see the module doc for each trigger). */
export type GestureCancelReason =
	'escape' | 'pointercancel' | 'lostpointercapture' | 'blur' | 'hidden' | 'unmount' | 'api';

export interface GestureSession {
	readonly kind: GestureKind;
	/** The owning pointer. `null` for a keyboard session. */
	readonly pointerId: number | null;
	readonly panelId: string | null;
	/** The layout before the gesture (a plain deep copy). Cancel of a live-writing kind restores it. */
	readonly snapshot: DockLayout;
	/** The floating window's root while the gesture is on a floating window; `null` for docked panes and dividers. Passed to `isEscapeBlocked`. */
	readonly activeLayer: HTMLElement | null;
}

export interface GestureSpec {
	kind: GestureKind;
	panelId?: string | null;
	activeLayer?: HTMLElement | null;
	/** The owning pointer moved. */
	move?: (event: PointerEvent) => void;
	/** The owning pointer was released. Runs after the session closed (see the module doc). */
	commit?: (event: PointerEvent) => void;
	/** The session was cancelled. Runs after the session closed and after the snapshot was restored. */
	cancel?: (reason: GestureCancelReason) => void;
	/**
	 * Undo what this live-writing gesture changed, from the layout taken at
	 * `begin` - only its own target (one window's geometry, one split's sizes),
	 * so a layout change the app made meanwhile is kept. Absent = the whole
	 * layout is restored (fallback for a live kind that has no narrower undo).
	 */
	restore?: (snapshot: DockLayout) => void;
}

/** A keyboard-mode session (`beginKeyboard`): no pointer, committed by `commitKeyboard()`. */
export interface KeyboardGestureSpec {
	kind: 'move' | 'resize';
	panelId?: string | null;
	activeLayer?: HTMLElement | null;
	/** `commitKeyboard()` was called. Runs after the session closed. */
	commit?: () => void;
	cancel?: (reason: GestureCancelReason) => void;
	restore?: (snapshot: DockLayout) => void;
}

export interface GestureOwnerOptions {
	/**
	 * `false` = do not start this gesture (exclusion with drawing, another
	 * DnD or a higher layer). Asked before the session exists; for a
	 * `drag-candidate` press it is asked as `drag` at the threshold (module doc).
	 */
	canStart?: (kind: GestureKind, panelId: string | null) => boolean;
	/**
	 * `true` = a higher layer owns Esc right now, so the gesture yields it (plan
	 * §4.3). Consulted only when the event is not `defaultPrevented`. Absent =
	 * only `defaultPrevented` is honoured.
	 */
	isEscapeBlocked?: (activeLayer: HTMLElement | null) => boolean;
	/** Called once per session, after it closed and after its own `commit` / `cancel` callback. */
	onEnd?: (
		session: GestureSession,
		outcome: 'commit' | 'cancel',
		reason?: GestureCancelReason
	) => void;
}

/** Kinds that write the layout before commit, so a cancel has something to undo. */
const LIVE_KINDS: ReadonlySet<GestureKind> = new Set(['move', 'resize', 'divider']);

interface ActiveSpec {
	move?: (event: PointerEvent) => void;
	commit?: (event: PointerEvent | null) => void;
	cancel?: (reason: GestureCancelReason) => void;
	restore?: (snapshot: DockLayout) => void;
}

const CAPTURE: AddEventListenerOptions = { capture: true };

export class GestureOwner {
	#dock: DockState;
	#getHostEl: () => HTMLElement | null;
	#getOptions: () => GestureOwnerOptions;
	#spec: ActiveSpec | null = null;
	#disposed = false;

	/** The active session, or `null`. Reactive (`$state.raw`) so chrome can reflect it later. */
	session: GestureSession | null = $state.raw(null);

	constructor(
		dock: DockState,
		getHostEl: () => HTMLElement | null,
		getOptions: () => GestureOwnerOptions = () => ({})
	) {
		this.#dock = dock;
		this.#getHostEl = getHostEl;
		this.#getOptions = getOptions;
	}

	get active(): boolean {
		return this.session !== null;
	}

	/**
	 * Start a pointer session from a `pointerdown`. Returns `false` (and does
	 * nothing) when another session is active, the owner is disposed, the
	 * pointer is not primary, the button is not the main one or the
	 * `canStart` hook refuses (not asked for `drag-candidate`, see `setKind`).
	 */
	begin(event: PointerEvent, spec: GestureSpec): boolean {
		if (this.#disposed || this.session) return false;
		if (event.button !== 0 || event.isPrimary === false) return false;
		const panelId = spec.panelId ?? null;
		if (spec.kind !== 'drag-candidate' && !this.#allowed(spec.kind, panelId)) return false;
		const { commit } = spec;
		this.#open(spec.kind, event.pointerId, panelId, spec.activeLayer ?? null, {
			move: spec.move,
			commit: commit && ((e) => commit(e as PointerEvent)),
			cancel: spec.cancel,
			restore: spec.restore
		});
		window.addEventListener('pointermove', this.#onMove, CAPTURE);
		window.addEventListener('pointerup', this.#onUp, CAPTURE);
		window.addEventListener('pointercancel', this.#onPointerCancel, CAPTURE);
		window.addEventListener('lostpointercapture', this.#onLostCapture, CAPTURE);
		return true;
	}

	/**
	 * Start a keyboard-mode session (`pointerId: null`; see the module doc).
	 * Same refusals as `begin` (active session, disposed, `canStart`).
	 */
	beginKeyboard(spec: KeyboardGestureSpec): boolean {
		if (this.#disposed || this.session) return false;
		const panelId = spec.panelId ?? null;
		if (!this.#allowed(spec.kind, panelId)) return false;
		const { commit } = spec;
		this.#open(spec.kind, null, panelId, spec.activeLayer ?? null, {
			commit: commit && (() => commit()),
			cancel: spec.cancel,
			restore: spec.restore
		});
		return true;
	}

	/** Commit the active KEYBOARD session (Enter). No-op for a pointer session or without one. */
	commitKeyboard(): void {
		if (!this.session || this.session.pointerId !== null) return;
		const ended = this.#close();
		if (!ended) return;
		ended.spec.commit?.(null);
		this.#getOptions().onEnd?.(ended.session, 'commit');
	}

	/**
	 * One change that begins and commits at once (a keyboard step on a
	 * divider). Refused - `apply` not called, `false` returned - while a
	 * session is active, after dispose, or when `canStart` says no; otherwise
	 * `apply` runs and `onEnd` reports a `commit`.
	 */
	instant(kind: GestureKind, panelId: string | null, apply: () => void): boolean {
		if (this.#disposed || this.session) return false;
		if (!this.#allowed(kind, panelId)) return false;
		const snapshot = $state.snapshot(this.#dock.layout) as DockLayout;
		apply();
		this.#getOptions().onEnd?.(
			{ kind, pointerId: null, panelId, snapshot, activeLayer: null },
			'commit'
		);
		return true;
	}

	/**
	 * Change the active session's kind (the drag threshold was crossed:
	 * `drag-candidate` → `drag`). Crossing INTO `drag` asks `canStart`; on a
	 * refusal the session is discarded silently - listeners removed, no
	 * `commit` / `cancel` callback and no `onEnd` (a vetoed gesture never
	 * started, so it must not report an end) - and `false` is returned; the
	 * rest of the press neither drags nor counts as a click.
	 */
	setKind(kind: GestureKind): boolean {
		const session = this.session;
		if (!session) return false;
		if (kind === 'drag' && session.kind !== 'drag') {
			const canStart = this.#getOptions().canStart;
			if (canStart && canStart(kind, session.panelId) === false) {
				if (this.session === session) this.#close();
				return false;
			}
			// A re-entrant hook may have ended the session meanwhile.
			if (this.session !== session) return false;
		}
		this.session = { ...session, kind };
		return true;
	}

	/** The host's CURRENT client size, read synchronously from layout (not the reactive binding). */
	measureHost(): { width: number; height: number } {
		const el = this.#getHostEl();
		return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 };
	}

	/** Cancel the active session (no-op without one). */
	cancel(reason: GestureCancelReason = 'api'): void {
		const ended = this.#close();
		if (!ended) return;
		const { session, spec } = ended;
		if (LIVE_KINDS.has(session.kind)) {
			if (spec.restore) spec.restore(session.snapshot);
			else this.#dock.layout = session.snapshot;
		}
		spec.cancel?.(reason);
		this.#getOptions().onEnd?.(session, 'cancel', reason);
	}

	/** `DockHost` unmounts: cancel the active session and refuse new ones. */
	dispose(): void {
		// Refuse new sessions BEFORE the cancel callbacks run: a cancel / onEnd
		// that begin()s again must not leave a live session after disposal.
		this.#disposed = true;
		this.cancel('unmount');
	}

	/** Ask the `canStart` hook (absent = allowed) before a session exists. */
	#allowed(kind: GestureKind, panelId: string | null): boolean {
		const canStart = this.#getOptions().canStart;
		if (!canStart) return true;
		const ok = canStart(kind, panelId) !== false;
		// The hook may have started a session or disposed the host (re-entrancy).
		return ok && !this.#disposed && !this.session;
	}

	#open(
		kind: GestureKind,
		pointerId: number | null,
		panelId: string | null,
		activeLayer: HTMLElement | null,
		spec: ActiveSpec
	): void {
		this.session = {
			kind,
			pointerId,
			panelId,
			snapshot: $state.snapshot(this.#dock.layout) as DockLayout,
			activeLayer
		};
		this.#spec = spec;
		window.addEventListener('keydown', this.#onKeydown);
		window.addEventListener('blur', this.#onBlur);
		document.addEventListener('visibilitychange', this.#onVisibility);
	}

	/** Close the session and remove every listener BEFORE any callback runs (re-entrancy). */
	#close(): { session: GestureSession; spec: ActiveSpec } | null {
		const session = this.session;
		const spec = this.#spec;
		if (!session || !spec) return null;
		this.session = null;
		this.#spec = null;
		if (session.pointerId !== null) {
			window.removeEventListener('pointermove', this.#onMove, CAPTURE);
			window.removeEventListener('pointerup', this.#onUp, CAPTURE);
			window.removeEventListener('pointercancel', this.#onPointerCancel, CAPTURE);
			window.removeEventListener('lostpointercapture', this.#onLostCapture, CAPTURE);
		}
		window.removeEventListener('keydown', this.#onKeydown);
		window.removeEventListener('blur', this.#onBlur);
		document.removeEventListener('visibilitychange', this.#onVisibility);
		return { session, spec };
	}

	#owns(event: PointerEvent): boolean {
		return (
			this.session !== null &&
			this.session.pointerId !== null &&
			event.pointerId === this.session.pointerId
		);
	}

	#onMove = (event: PointerEvent): void => {
		if (!this.#owns(event)) return;
		this.#spec?.move?.(event);
	};

	#onUp = (event: PointerEvent): void => {
		if (!this.#owns(event)) return;
		const ended = this.#close();
		if (!ended) return;
		ended.spec.commit?.(event);
		this.#getOptions().onEnd?.(ended.session, 'commit');
	};

	#onPointerCancel = (event: PointerEvent): void => {
		if (this.#owns(event)) this.cancel('pointercancel');
	};

	#onLostCapture = (event: PointerEvent): void => {
		if (!this.#owns(event)) return;
		// Moving a node (e.g. a keyed each reordering) releases an implicit
		// capture without the user aborting anything; only a capture lost by an
		// element that is still in the document is treated as an abort.
		const target = event.target;
		if (!(target instanceof Node) || target === document || !target.isConnected) return;
		this.cancel('lostpointercapture');
	};

	#onKeydown = (event: KeyboardEvent): void => {
		if (event.key !== 'Escape' || !this.session) return;
		if (event.isComposing || event.keyCode === 229) return;
		if (event.defaultPrevented) return;
		if (this.#getOptions().isEscapeBlocked?.(this.session.activeLayer)) return;
		event.preventDefault();
		this.cancel('escape');
	};

	#onBlur = (): void => {
		this.cancel('blur');
	};

	#onVisibility = (): void => {
		if (document.visibilityState === 'hidden') this.cancel('hidden');
	};
}

const GESTURE_CONTEXT_KEY = Symbol('banto-dock-gesture');

/** Called once by `DockHost`. */
export function setGestureOwner(owner: GestureOwner): void {
	setContext(GESTURE_CONTEXT_KEY, owner);
}

/** Must be called during a descendant component's initialization. */
export function getGestureOwner(): GestureOwner {
	const owner = getContext<GestureOwner | undefined>(GESTURE_CONTEXT_KEY);
	if (!owner) {
		throw new Error(
			'getGestureOwner() called outside a DockHost tree - no GestureOwner in context.'
		);
	}
	return owner;
}
