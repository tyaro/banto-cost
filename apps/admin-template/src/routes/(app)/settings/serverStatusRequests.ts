/**
 * Which `server_status` / `server_apply` responses the settings section may
 * show (Issue #219, owner review on PR #463).
 *
 * Each IPC response is a consistent snapshot, but the responses can arrive
 * in any order. Without this, a slow status read started for a copy (A,
 * generation 1) that lands after an apply (B, generation 2) was shown would
 * put the screen back to A - the URL/QR, the "unsaved" state of the form,
 * and the firewall command about to be copied. Two checks, both needed:
 *
 * - **Request order**: every read gets a ticket; starting or finishing an
 *   apply, or starting a newer read, makes the older tickets stale. A
 *   response is only shown while its ticket is still the latest.
 * - **Server generation**: a snapshot whose `generation` is lower than the
 *   one already shown is never shown (`isOlderStatus`).
 *
 * The section keeps the status in `$state`; this class only reads and writes
 * it through the two callbacks, so the ordering can be tested without a
 * component.
 */
import type { ServerStatus } from '#lib/banto/serverAdmin.js';

/** What a status read came to. */
export type StatusRefresh =
	/** Read, still the latest, and shown (`status` is now the section's status). */
	| { kind: 'ok'; status: ServerStatus }
	/** Read, but an apply or a newer read came after it, or it was older than what is shown: dropped. */
	| { kind: 'superseded' }
	/** The read failed (while it was still the latest). */
	| { kind: 'unavailable'; error: unknown };

/**
 * Whether `incoming` is older than the `current` snapshot: both report a
 * `generation` and the incoming one is lower.
 *
 * A snapshot without `generation` (an older host or mock - a host either
 * always sends it or never does) cannot be compared, so it is not called
 * older; the request order alone decides it. The firewall copy still
 * refuses it whenever the generation differs from the one shown
 * (`sameFirewallTarget`).
 */
export function isOlderStatus(current: ServerStatus | null, incoming: ServerStatus): boolean {
	const seen = current?.generation;
	const got = incoming.generation;
	return typeof seen === 'number' && typeof got === 'number' && got < seen;
}

export class ServerStatusRequests {
	#latest = 0;
	readonly #read: () => ServerStatus | null;
	readonly #write: (status: ServerStatus) => void;

	constructor(read: () => ServerStatus | null, write: (status: ServerStatus) => void) {
		this.#read = read;
		this.#write = write;
	}

	/** Makes every read started so far stale (their responses are dropped). */
	invalidate(): void {
		this.#latest++;
	}

	/**
	 * Reads the status with `get` and shows it (`write`) only if no apply or
	 * newer read started meanwhile and it is not older than what is shown.
	 */
	async refresh(get: () => Promise<ServerStatus>): Promise<StatusRefresh> {
		const ticket = ++this.#latest;
		let status: ServerStatus;
		try {
			status = await get();
		} catch (error) {
			return ticket === this.#latest ? { kind: 'unavailable', error } : { kind: 'superseded' };
		}
		if (ticket !== this.#latest || isOlderStatus(this.#read(), status)) {
			return { kind: 'superseded' };
		}
		this.#write(status);
		return { kind: 'ok', status };
	}

	/**
	 * Runs an apply. Its start and its end both make pending reads stale; its
	 * result is the saved state, so it is shown unless it is older than what
	 * is shown already. Returns the result when it was shown (the caller
	 * resets its drafts to it), `null` when it was dropped. Errors from `run`
	 * propagate (after the pending reads are made stale).
	 */
	async apply(run: () => Promise<ServerStatus>): Promise<ServerStatus | null> {
		this.invalidate();
		try {
			const status = await run();
			if (isOlderStatus(this.#read(), status)) return null;
			this.#write(status);
			return status;
		} finally {
			this.invalidate();
		}
	}
}
