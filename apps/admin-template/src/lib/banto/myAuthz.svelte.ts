/**
 * The signed-in person's own capabilities and project memberships (review
 * D-4, §8-15), read once per confirmed session from `authz/me`.
 *
 * DISPLAY ONLY: the sidebar, the dock and the command palette hide the
 * screens the person has no capability for (`navigation.ts`'s
 * `NavItem.capabilities`). The server stays the one that decides every read
 * and write (ADR-0028); a screen opened by URL still asks it and shows its
 * refusal.
 *
 * The grants belong to one session: they are kept with the session
 * generation they were read for (design §6.1 wiring ①), and a newer session
 * (another account, a re-login) reads them again. Unknown - demo mode, a
 * public-viewer session, a failed or not-yet-finished read - is `null`, and
 * the nav then hides nothing (the server's refusal remains the answer).
 */
import { getSessionController } from '@banto/admin-core';
import type { Capability } from './capabilitiesAdmin';
import { isPipelineAvailable } from './pipelineAdmin';
import { getMyAuthz, type MyAuthz } from './projectMembersAdmin';

/** How long the app layout waits for the grants before going on without them. */
export const MY_AUTHZ_WAIT_MS = 3000;

let loaded = $state.raw<{ generation: number; authz: MyAuthz } | null>(null);
let loading: { generation: number; promise: Promise<void>; abort: () => void } | null = null;
/**
 * A request given up on at the end of the wait that has not settled yet (a
 * Tauri command cannot be cancelled; an aborted HTTP one settles at once).
 * While it runs, no second one is started for the same session (PR #60
 * review: requests must not pile up while the server does not answer); a new
 * session (a sign-in again) always asks.
 */
let givenUp: { generation: number; settled: Promise<unknown> } | null = null;
/**
 * The held grants are known to be out of date (a reload was asked for and has
 * not succeeded yet): they stay in use, and the next load reads them again
 * (PR #60 review).
 */
let stale = false;

function currentGeneration(): number {
	return getSessionController().snapshot.generation;
}

/**
 * Read the grants for session `generation` unless they are already held
 * (the app layout calls this after the session is confirmed). A failure is
 * not an error for the page: the nav shows everything, and the next call
 * tries again. The wait is bounded like the business calendar's.
 */
export function loadMyAuthz(
	generation: number,
	waitMs: number = MY_AUTHZ_WAIT_MS,
	force = false
): Promise<void> {
	if (!force && !stale && loaded?.generation === generation) return Promise.resolve();
	if (!isPipelineAvailable()) return Promise.resolve();
	// Another session's grants are never kept past the start of this one's
	// read, even if the read fails (PR #60 review): the nav and the dashboard
	// go back to "unknown" rather than the previous person's capabilities.
	if (loaded && loaded.generation !== generation) {
		loaded = null;
		stale = false;
	}
	if (force || loading?.generation !== generation) {
		// The earlier read is for another session, or replaced by a reload.
		loading?.abort();
		loading = null;
		if (givenUp?.generation === generation) return Promise.resolve();
		const controller = new AbortController();
		const request = getMyAuthz(controller.signal);
		const promise = request
			.then((authz) => {
				// A newer session started (or a newer read was asked for) while
				// this one was in flight: drop it.
				if (currentGeneration() === generation && loading?.promise === promise) {
					loaded = { generation, authz };
					stale = false;
				}
			})
			.catch(() => {})
			.finally(() => {
				if (loading?.promise === promise) loading = null;
			});
		loading = { generation, promise, abort: () => controller.abort() };
	}
	const current = loading;
	const pending = current.promise;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			// A read that has not answered in time is given up (PR #60 review):
			// it is cancelled (HTTP), its late answer is not used (the `loading`
			// check above), and the next navigation asks again - once it has
			// settled, so a stalled Tauri command is never doubled.
			if (loading === current) {
				loading = null;
				current.abort();
				const settled: Promise<unknown> = pending.finally(() => {
					if (givenUp?.settled === settled) givenUp = null;
				});
				givenUp = { generation: current.generation, settled };
			}
			resolve();
		}, waitMs);
	});
	return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Read the grants again for the current session (after an admin changed
 * capabilities). The held ones stay in use until the new ones arrive.
 */
export function reloadMyAuthz(): Promise<void> {
	stale = true;
	return loadMyAuthz(currentGeneration(), MY_AUTHZ_WAIT_MS, true);
}

/** The current session's grants, or `null` when unknown. Reactive. */
export function myAuthz(): MyAuthz | null {
	const held = loaded;
	return held && held.generation === currentGeneration() ? held.authz : null;
}

/** The current session's capabilities, or `null` when unknown. Reactive. */
export function myCapabilities(): ReadonlySet<Capability> | null {
	const authz = myAuthz();
	return authz ? new Set(authz.capabilities) : null;
}

/** Test hook: set (or clear) the held grants. */
export function setMyAuthzForTest(value: { generation: number; authz: MyAuthz } | null): void {
	loaded = value;
	loading = null;
	givenUp = null;
	stale = false;
}
