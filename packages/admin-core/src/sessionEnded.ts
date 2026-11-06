/**
 * "The session ended while a screen was open" (Issue #241), as a view of the
 * default `SessionController` (Issue #260 実装-2, design §5.4).
 *
 * - `onSessionEnded(listener)` - notified when the controller commits `none`
 *   after `active`/`unknown` (a background revocation confirmed, a hold that
 *   was confirmed `none`, a logout). It is a thin wrapper over
 *   `controller.subscribe` with no state or confirmation of its own (I-1).
 *   S-34 (design §4.5): the pre-#260 "unheard ending" re-probe is gone;
 *   instead, a subscription made while the session is ALREADY `none` is
 *   notified once, asynchronously (never inside the subscribing call, which
 *   is typically a component's `$effect`), if it is still subscribed and the
 *   session is still `none` by then. Kept in v2.0.0.
 *
 * It only sees transitions THROUGH `none`: a switch of user that goes
 * `active -> unknown -> active` (another tab's login, S-79/S-80) never
 * reaches it, so a protected layout needs wiring ① (compare
 * `snapshot.generation` with its load's generation, design §6.1) rather
 * than this.
 *
 * The pre-v2 background confirmation (`confirmSessionEnded` /
 * `createSessionEndConfirmation`) was removed in v2.0.0 (design §5.4): "the
 * session may have ended" is `getSessionController().signal(reason)`, whose
 * background confirmation retries with backoff inside the controller.
 */
import { getSessionController } from './sessionController.svelte';

type Listener = () => void;

function call(listener: Listener): void {
	try {
		listener();
	} catch {
		// One broken listener must not stop the others.
	}
}

/**
 * Subscribe to "the current session was confirmed ended". Returns an
 * unsubscribe function. See the module doc for the S-34 "already ended when
 * subscribing" notification.
 */
export function onSessionEnded(listener: Listener): () => void {
	const controller = getSessionController();
	let subscribed = true;
	const off = controller.subscribe((snapshot, previous) => {
		if (snapshot.status === 'none' && previous.status !== 'none') call(listener);
	});
	if (controller.snapshot.status === 'none') {
		const generation = controller.snapshot.generation;
		queueMicrotask(() => {
			// Still subscribed, and still the same ended session (a transition
			// meanwhile was delivered by the subscription itself).
			if (
				subscribed &&
				controller.snapshot.status === 'none' &&
				controller.snapshot.generation === generation
			) {
				call(listener);
			}
		});
	}
	return () => {
		subscribed = false;
		off();
	};
}
