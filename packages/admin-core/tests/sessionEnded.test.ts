/**
 * "The session ended while a screen was open" (Issue #241) on v2.0.0: the
 * signal (`controller.signal()`, what `connectEvents` calls for a rejected
 * stream) and `onSessionEnded` (kept, design §5.4). The pre-v2
 * `confirmSessionEnded`/`createSessionEndConfirmation` are gone; the cases
 * they covered are pinned here through the controller (the backoff itself:
 * S-33 in sessionController.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onSessionEnded } from '../src/sessionEnded';
import { initBanto } from '../src/registry.svelte';
import { loadListViewState, saveListViewState } from '../src/listViewState';
import {
	currentSessionScope,
	isCurrentSessionScope,
	type SessionScope
} from '../src/sessionScope.svelte';
import type { DataProvider } from '../src/provider';
import {
	getSessionController,
	resetDefaultSessionController,
	resolveSettled
} from '../src/sessionController.svelte';
import { ALICE, flush, makeProbeProvider } from './sessionHarness';

/** In-memory Storage stand-in: Node has no global sessionStorage. */
function makeMemoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		removeItem: (key) => void map.delete(key),
		clear: () => map.clear(),
		key: (index) => Array.from(map.keys())[index] ?? null,
		get length() {
			return map.size;
		}
	} as Storage;
}

let storage: Storage;

beforeEach(() => {
	resetDefaultSessionController();
	storage = makeMemoryStorage();
	vi.stubGlobal('sessionStorage', storage);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Alice signed in on the default controller; her list state saved. */
async function signedIn(): Promise<{
	p: ReturnType<typeof makeProbeProvider>;
	scope: SessionScope;
}> {
	const p = makeProbeProvider();
	initBanto({ dataProvider: {} as DataProvider, authProvider: p.provider, resources: [] });
	const first = resolveSettled(getSessionController());
	p.active(0, ALICE);
	await first;
	const scope = currentSessionScope();
	saveListViewState(scope, 'items:server', { sort: [], filters: [] }, storage);
	return { p, scope };
}

describe('signal() and onSessionEnded (Issue #241, v2.0.0)', () => {
	it('a signal confirmed `none` ends the session (new generation, saved state dropped) and notifies once', async () => {
		const { p, scope } = await signedIn();
		const ended = vi.fn();
		const off = onSessionEnded(ended);

		getSessionController().signal('unauthorized');
		p.none(p.probes.length - 1, { clear: true });
		await flush();

		expect(ended).toHaveBeenCalledTimes(1);
		expect(isCurrentSessionScope(scope)).toBe(false);
		expect(storage.getItem('banto.listView.items:server')).toBeNull();
		off();
	});

	it('a still-valid session is left alone (no notification, state kept)', async () => {
		const { p, scope } = await signedIn();
		const ended = vi.fn();
		const off = onSessionEnded(ended);

		getSessionController().signal('unauthorized');
		p.active(p.probes.length - 1, ALICE);
		await flush();

		expect(ended).not.toHaveBeenCalled();
		expect(isCurrentSessionScope(scope)).toBe(true);
		expect(loadListViewState(scope, 'items:server', undefined, storage)).not.toBeNull();
		off();
	});

	it('Issue #204: a confirmation that failed (500) is not a logout', async () => {
		const { p, scope } = await signedIn();
		const ended = vi.fn();
		const off = onSessionEnded(ended);

		getSessionController().signal('unauthorized');
		p.fail(p.probes.length - 1);
		await flush();

		expect(ended).not.toHaveBeenCalled();
		expect(isCurrentSessionScope(scope)).toBe(true);
		expect(loadListViewState(scope, 'items:server', undefined, storage)).not.toBeNull();
		expect(getSessionController().snapshot.verification.state).toBe('failed');
		off();
	});

	// Re-review of #242: overlapping signals. The second does not join the
	// first probe (it started before the second reason to ask, I-9): the first
	// is aborted and replaced, and an earlier `valid` cannot hide a later `none`.
	it('overlapping signals: only the newest probe decides; the earlier one is aborted; one notification', async () => {
		const { p } = await signedIn();
		const ended = vi.fn();
		const off = onSessionEnded(ended);
		const controller = getSessionController();

		controller.signal('unauthorized');
		controller.signal('credentialCleared');
		const [older, newer] = p.probes.slice(-2);
		expect(older.signal?.aborted).toBe(true);
		expect(newer.signal?.aborted).toBe(false);
		p.none(p.probes.length - 1, { clear: true });
		p.active(p.probes.length - 2, ALICE); // the aborted probe's late `valid` is discarded
		await flush();

		expect(ended).toHaveBeenCalledTimes(1);
		expect(controller.snapshot.status).toBe('none');

		// Another signal while already `none`: confirmed again, no second notification.
		controller.signal('unauthorized');
		p.none(p.probes.length - 1);
		await flush();
		expect(ended).toHaveBeenCalledTimes(1);
		off();
	});

	it('an unsubscribed listener is not called, and one throwing listener does not stop the others', async () => {
		const { p } = await signedIn();
		const removed = vi.fn();
		const offRemoved = onSessionEnded(removed);
		offRemoved();
		const offThrowing = onSessionEnded(() => {
			throw new Error('broken listener');
		});
		const ended = vi.fn();
		const off = onSessionEnded(ended);

		getSessionController().signal('unauthorized');
		p.none(p.probes.length - 1, { clear: true });
		await flush();

		expect(removed).not.toHaveBeenCalled();
		expect(ended).toHaveBeenCalledTimes(1);
		offThrowing();
		off();
	});
});
