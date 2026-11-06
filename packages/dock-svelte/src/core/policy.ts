/**
 * Consumer-supplied policy for a `DockHost` (spec §5.2, shared-primitives-
 * upstream-plan §3.2, #434): the clamp options used to keep floating windows
 * reachable, and per-pane capabilities (may it be closed / moved / floated).
 * `DockHost` publishes it through Svelte context so `DockWindow`, `DockedTree`
 * and the `DragController` read the same values without prop-drilling. No
 * runes here - the getters read the host's props, which are reactive.
 */
import { getContext, setContext } from 'svelte';
import type { ClampOptions } from './geometry';

/**
 * What the UI offers for one pane. Every field defaults to `true`; return
 * `false` to withhold it (e.g. an app's central canvas pane:
 * `{ close: false, move: false }`).
 *
 * These are affordances of the dock UI, not an access-control layer: a
 * programmatic `dock.close(id)` / `dock.move(...)` still works, so an app
 * that must hard-protect a pane also guards its own callers.
 */
export interface DockCapabilities {
	/** Render the close button (✕). `false` hides it. */
	close?: boolean;
	/** Allow user drag of the pane (floating title bar, docked title bar / tab): no move, no re-dock. Resizing a floating window is unaffected. */
	move?: boolean;
	/** Allow a docked pane to be floated or popped out: drop onto free space is ignored (the pane stays docked) and the pop-out button is hidden. Re-docking within the tree is governed by `move`. */
	undock?: boolean;
}

export interface DockPolicy {
	readonly clamp: ClampOptions | undefined;
	readonly capabilities: ((panelId: string) => DockCapabilities | undefined) | undefined;
}

const NO_POLICY: DockPolicy = { clamp: undefined, capabilities: undefined };

export function resolveCapabilities(
	policy: DockPolicy,
	panelId: string
): Required<DockCapabilities> {
	const c = policy.capabilities?.(panelId);
	return { close: c?.close ?? true, move: c?.move ?? true, undock: c?.undock ?? true };
}

const POLICY_KEY = Symbol('banto-dock-policy');

/** Called once by `DockHost` during initialization. */
export function setDockPolicy(policy: DockPolicy): void {
	setContext(POLICY_KEY, policy);
}

/** Must be called during a descendant component's initialization. Outside a `DockHost` tree it returns an empty policy (all defaults). */
export function getDockPolicy(): DockPolicy {
	return getContext<DockPolicy | undefined>(POLICY_KEY) ?? NO_POLICY;
}
