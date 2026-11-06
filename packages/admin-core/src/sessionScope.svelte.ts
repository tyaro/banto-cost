/**
 * Who this tab's session belongs to, and which "generation" of it is live
 * (Issue #215/#255, 4th review - redesign; Issue #260 実装-2).
 *
 * State saved on behalf of a signed-in identity (today: `listViewState.ts`'s
 * list filter/sort/last-opened-row memory) must never surface for a
 * DIFFERENT identity. Two values describe the live session:
 *
 * - `owner` - a stable key for the CONFIRMED identity (`sessionOwnerKey`),
 *   or `null` while no identity is confirmed. Saved state carries the owner
 *   it was saved for, and is only handed back to the SAME owner.
 * - `generation` - bumped whenever `(status, owner, kind)` of the session
 *   changes (I-2). A screen (or an async operation) captures
 *   `currentSessionScope()` when it starts and may only write while
 *   `isCurrentSessionScope()` still holds.
 *
 * Since Issue #260 (実装-2) these are read-only views of the default
 * `SessionController` (`getSessionController()`, design §5.4): this module
 * keeps no state of its own and runs no confirmation (I-1). The controller
 * is the only writer.
 */
import type { Identity } from './provider';
import {
	getSessionController,
	sessionOwnerKey as ownerKey,
	type SessionKind,
	type SessionScope as ControllerSessionScope
} from './sessionController.svelte';

/** A snapshot of the live session, taken when a screen/operation starts. Compare with `isCurrentSessionScope` before acting on its behalf. */
export type SessionScope = ControllerSessionScope;

/**
 * Stable owner key for `identity` (design §5.4, ADR-0017): a grant kind on
 * its own (`publicViewer` for the LAN viewer-public session - a real account
 * may share its `id`, Issue #209 - or an app's kind such as `commissioning`;
 * the identity is fixed per kind, so the id adds nothing), `local` for the
 * Tauri auth-disabled session, `account:${id}` for an account, `null` when
 * there is no identity or it has no usable `id` (fail closed).
 */
export function sessionOwnerKey(
	identity: Identity | null | undefined,
	kind?: SessionKind | null
): string | null {
	return ownerKey(identity, kind);
}

/** Reactive (`$state`-backed): the default controller's `snapshot.generation`. */
export function sessionGeneration(): number {
	return getSessionController().snapshot.generation;
}

/** Reactive: `true` while the default controller's session is `active`. */
export function isSessionEstablished(): boolean {
	return getSessionController().snapshot.status === 'active';
}

/** The live session's `{ generation, owner }`, frozen. Capture it when a screen/operation starts. */
export function currentSessionScope(): SessionScope {
	return getSessionController().scope();
}

/** Is `scope` still the live session (same generation AND same owner)? */
export function isCurrentSessionScope(scope: SessionScope): boolean {
	return getSessionController().isCurrent(scope);
}
