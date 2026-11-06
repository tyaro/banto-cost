/**
 * Unified dock-drag controller (M8 Phase B, spec §5.2: drag a panel to dock/
 * undock/retab it, with a live snap-guide preview). Both `DockedTree.svelte`
 * (docked panes/tabs) and `DockWindow.svelte` (floating titlebars) start a
 * drag through this ONE controller so there's a single place that knows how
 * to resolve a drop - no duplicated hit-testing or drop logic in either
 * component (the task's explicit ask: "Keep the drag controller in ONE
 * place").
 *
 * Hit-testing choice: `document.elementFromPoint` + `closest
 * ('[data-dock-drop-id]')`, NOT a manual registry of `{id, getRect}`. Reasons:
 *  - It's automatically correct about DOM stacking/occlusion: a floating
 *    window painted on top of the docked tree (or another floating window)
 *    naturally wins the hit test without this module having to track z-order
 *    itself.
 *  - Docked drop targets are exactly the elements `DockedTree` already
 *    stamps with `data-dock-drop-id` (one per panel-pane or tabs-group -
 *    see that file); no separate registration/unregistration lifecycle to
 *    leak.
 *  - The "floating area" fallback is just "inside the host but didn't hit a
 *    `[data-dock-drop-id]` element" - one more `.contains()` check, no extra
 *    bookkeeping.
 * The one thing this requires of callers: the drag ghost and the snap-guide
 * overlay MUST be `pointer-events: none` (see `DockHost.svelte`), otherwise
 * they'd be the element under the cursor and everything below would be
 * unreachable.
 *
 * No live mutation during the drag: `dock.move`/`dockPanel`/etc. are only
 * ever called once, from `commit()` on the owning pointer's pointerup (a
 * structure change - dock / undock / move a docked pane - only once the host's
 * pane lifecycle agrees, #432: refused = the pane stays where it was). Every intermediate
 * pointermove only updates this controller's own `$state` snapshot (read by
 * `DockHost` to position the ghost chip + snap-guide overlay) - the real
 * panel never moves mid-drag, matching the task's explicit ask.
 *
 * Listeners: this controller has none of its own. The `GestureOwner`
 * (`core/gesture.svelte.ts`, shared-primitives-upstream-plan §3.3, #433)
 * owns the pointer and routes the owning pointer's moves to `update`, its
 * release to `commit`, and Esc / pointercancel / blur / unmount to `cancel` -
 * so a different pointer's pointerup can no longer finish a drag, and an Esc
 * that a higher layer already consumed is no longer taken.
 */
import { getContext, setContext } from 'svelte';
import { displayWindowGeometry, dropRegionRect, type Rect } from './geometry';
import type { DockPanelChange, PanelLifecycle } from './lifecycle';
import { resolveCapabilities, type DockPolicy } from './policy';
import { findParent } from './tree';
import type { DockState } from '../state.svelte';
import type { DropRegion } from '../types';
import { computeDropRegion } from './dropzones';

/** Where a drag originated - determines which `DockState` method finishes it (see `#finish`). */
export type DragSource = 'floating' | 'docked';

export interface DragStartOptions {
	panelId: string;
	title: string;
	icon?: string;
	source: DragSource;
	/** Size to give the resulting floating window if this drag ends over empty floating space (the dragged pane/window's own current size). */
	width: number;
	height: number;
	/** Pointer position (client/viewport coords) at the moment the drag actually starts (i.e. once the move threshold is crossed, not the original pointerdown). */
	clientX: number;
	clientY: number;
	/** The dragged element's own bounding-rect top-left (client coords) at drag start - preserves the original "grab point" when the panel lands in floating space (see `grabDx`/`grabDy` below). */
	originClientX: number;
	originClientY: number;
}

/** Reactive snapshot of the in-progress drag, read by `DockHost` to render the ghost chip + snap-guide overlay. `null` when no drag is active. */
export interface DragSnapshot {
	panelId: string;
	title: string;
	icon?: string;
	source: DragSource;
	clientX: number;
	clientY: number;
	width: number;
	height: number;
	/** Pointer-to-origin offset captured at drag start (see `DragStartOptions`). */
	grabDx: number;
	grabDy: number;
	/** `data-dock-drop-id` of the hovered docked pane/tabs-group, if any. */
	hoverTargetId: string | null;
	hoverRegion: DropRegion | null;
	/** True when hovering the host's empty floating area (not over any docked pane). */
	hoverFloating: boolean;
	/** Host-relative snap-guide rectangle to render, or `null` if nothing to show (e.g. dragged outside the host entirely). */
	guideRect: Rect | null;
}

export class DragController {
	#dock: DockState;
	#getHostEl: () => HTMLElement | null;
	state: DragSnapshot | null = $state(null);

	#getPolicy: () => DockPolicy | undefined;
	#getLifecycle: () => PanelLifecycle | undefined;

	/**
	 * `getPolicy` supplies the host's clamp options and pane capabilities (see
	 * `core/policy.ts`); absent = package defaults, everything allowed.
	 * `getLifecycle` is the host's pane lifecycle (`core/lifecycle.ts`, #432):
	 * a drop that changes the structure (dock / undock / move a docked pane)
	 * goes through its `request`; absent = applied directly.
	 */
	constructor(
		dock: DockState,
		getHostEl: () => HTMLElement | null,
		getPolicy: () => DockPolicy | undefined = () => undefined,
		getLifecycle: () => PanelLifecycle | undefined = () => undefined
	) {
		this.#dock = dock;
		this.#getHostEl = getHostEl;
		this.#getPolicy = getPolicy;
		this.#getLifecycle = getLifecycle;
	}

	/**
	 * A structure change: asked through the lifecycle (`beforePanelChange`, IME
	 * hold) when there is one. `target` (where it is dropped) is part of the
	 * request's identity, so a drop on Y while a drop on X waits is asked on
	 * its own instead of being taken for the X request (`core/lifecycle.ts`).
	 */
	#structural(change: DockPanelChange, target: unknown, apply: () => void): void {
		const lifecycle = this.#getLifecycle();
		if (lifecycle) void lifecycle.request(change, apply, { target });
		else apply();
	}

	/** True while a drag is in progress - handy guard for consumers that don't need the full snapshot. */
	get active(): boolean {
		return this.state !== null;
	}

	start(opts: DragStartOptions): void {
		// The GestureOwner allows one session at a time, so a second start
		// cannot normally happen; bail defensively anyway.
		if (this.state) return;

		this.state = {
			panelId: opts.panelId,
			title: opts.title,
			icon: opts.icon,
			source: opts.source,
			clientX: opts.clientX,
			clientY: opts.clientY,
			width: opts.width,
			height: opts.height,
			grabDx: opts.clientX - opts.originClientX,
			grabDy: opts.clientY - opts.originClientY,
			hoverTargetId: null,
			hoverRegion: null,
			hoverFloating: false,
			guideRect: null
		};
		this.#recomputeHover(opts.clientX, opts.clientY);
	}

	/** The owning pointer moved (routed by the `GestureOwner`). */
	update(clientX: number, clientY: number): void {
		this.#recomputeHover(clientX, clientY);
	}

	/**
	 * The owning pointer was released (routed by the `GestureOwner`): resolve
	 * the drop at the release point and apply it - the only `DockState` write
	 * of the whole drag. The ghost is cleared FIRST, so the layout change and
	 * anything it triggers never see a half-finished drag.
	 */
	commit(clientX: number, clientY: number): void {
		if (!this.state) return;
		this.#recomputeHover(clientX, clientY);
		const snapshot = this.state;
		this.state = null;
		if (snapshot) this.#finish(snapshot);
	}

	/** Cancel the current drag with no side effects (spec §5.2: Esc cancels / an invalid drop is a no-op). */
	cancel(): void {
		this.state = null;
	}

	#recomputeHover(clientX: number, clientY: number): void {
		if (!this.state) return;
		const hostEl = this.#getHostEl();
		const hitEl = document.elementFromPoint(clientX, clientY);
		const paneEl = (hitEl as Element | null)?.closest<HTMLElement>('[data-dock-drop-id]') ?? null;

		let hoverTargetId: string | null = null;
		let hoverRegion: DropRegion | null = null;
		let hoverFloating = false;
		let guideRect: Rect | null = null;

		if (hostEl && paneEl && hostEl.contains(paneEl)) {
			const paneRect = paneEl.getBoundingClientRect();
			const hostRect = hostEl.getBoundingClientRect();
			const localX = clientX - paneRect.left;
			const localY = clientY - paneRect.top;
			hoverTargetId = paneEl.dataset.dockDropId ?? null;
			hoverRegion = computeDropRegion(localX, localY, paneRect.width, paneRect.height);
			const hostRelative: Rect = {
				x: paneRect.left - hostRect.left,
				y: paneRect.top - hostRect.top,
				width: paneRect.width,
				height: paneRect.height
			};
			guideRect = dropRegionRect(hostRelative, hoverRegion);
		} else if (hostEl && hitEl && hostEl.contains(hitEl)) {
			hoverFloating = true;
			const hostRect = hostEl.getBoundingClientRect();
			guideRect = {
				x: clientX - hostRect.left - this.state.grabDx,
				y: clientY - hostRect.top - this.state.grabDy,
				width: this.state.width,
				height: this.state.height
			};
		}

		this.state = {
			...this.state,
			clientX,
			clientY,
			hoverTargetId,
			hoverRegion,
			hoverFloating,
			guideRect
		};
	}

	#finish(snapshot: DragSnapshot): void {
		const {
			panelId,
			source,
			hoverTargetId,
			hoverRegion,
			hoverFloating,
			width,
			height,
			clientX,
			clientY,
			grabDx,
			grabDy
		} = snapshot;
		const hostEl = this.#getHostEl();

		if (hoverTargetId && hoverRegion) {
			// Dropping a docked panel back onto its OWN group/pane, dead center,
			// is a no-op ("dropped back where it started") rather than a
			// pointless remove+reinsert - see the module doc on why this is the
			// one self-drop case worth guarding explicitly.
			if (source === 'docked' && hoverRegion === 'center') {
				const parent = findParent(this.#dock.layout.docked, panelId);
				const ownContainerId = parent?.id ?? panelId;
				if (ownContainerId === hoverTargetId) return;
			}
			const dock = this.#dock;
			if (source === 'floating')
				this.#structural(
					{ kind: 'dock', panelId, remount: true },
					{ to: hoverTargetId, region: hoverRegion },
					() => dock.dockPanel(panelId, hoverTargetId, hoverRegion)
				);
			else
				this.#structural(
					{ kind: 'move-docked', panelId, remount: true },
					{ to: hoverTargetId, region: hoverRegion },
					() => dock.dockExisting(panelId, hoverTargetId, hoverRegion)
				);
			return;
		}

		if (hoverFloating && hostEl) {
			const hostRect = hostEl.getBoundingClientRect();
			const x = clientX - hostRect.left - grabDx;
			const y = clientY - hostRect.top - grabDy;
			const policy = this.#getPolicy();
			if (source === 'docked') {
				// `undock: false` panes stay docked: a drop on free space is ignored.
				if (policy && !resolveCapabilities(policy, panelId).undock) return;
				const dock = this.#dock;
				this.#structural({ kind: 'undock', panelId, remount: true }, { x, y, width, height }, () =>
					dock.undockPanel(panelId, { x, y, width, height })
				);
			} else {
				const win = this.#dock.layout.floating.find((w) => w.id === panelId);
				if (win) {
					const hostW = hostEl.clientWidth;
					const hostH = hostEl.clientHeight;
					// The drag started from where the window was DRAWN (clamped to the
					// host), so the delta is measured from there, not the saved x/y.
					const shown = displayWindowGeometry(win, hostW, hostH, policy?.clamp);
					this.#dock.move(panelId, x - shown.x, y - shown.y, hostW, hostH, policy?.clamp);
				}
			}
			return;
		}

		// No valid target (dragged outside the host entirely, or the host isn't
		// mounted) - snap back: no DockState call at all.
	}
}

export function createDragController(
	dock: DockState,
	getHostEl: () => HTMLElement | null,
	getPolicy?: () => DockPolicy | undefined,
	getLifecycle?: () => PanelLifecycle | undefined
): DragController {
	return new DragController(dock, getHostEl, getPolicy, getLifecycle);
}

const DRAG_CONTEXT_KEY = Symbol('banto-dock-drag');

/** Called once by `DockHost` so its descendants (`DockedTree`, `DockWindow`) can reach the same controller instance without prop-drilling through every recursive `DockedTree` level. */
export function setDragController(controller: DragController): void {
	setContext(DRAG_CONTEXT_KEY, controller);
}

/** Must be called during a descendant component's own initialization (top-level `<script>`), per Svelte context rules - not inside an event handler. */
export function getDragController(): DragController {
	const controller = getContext<DragController | undefined>(DRAG_CONTEXT_KEY);
	if (!controller) {
		throw new Error(
			'getDragController() called outside a DockHost tree - no DragController in context.'
		);
	}
	return controller;
}
