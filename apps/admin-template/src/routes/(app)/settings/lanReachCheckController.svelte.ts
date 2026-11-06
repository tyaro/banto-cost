/**
 * Spec §11.4 (LAN settings UX). The state of the settings screen's
 * "connection check from another device" block (Issue #219 stage 1 /
 * PR-C3, lan-reach-check-design §4.1 - §4.2, D9, D10), kept out of
 * `LanReachCheckPanel.svelte` so the ordering and the re-read interval can
 * be tested without a component.
 *
 * Old answers never put the block back (§4.2, the same idea as
 * `serverStatusRequests.ts` / `FirewallStatusRequests`):
 *
 * - **Request order**: every status read and every issuance gets a ticket;
 *   an apply starting (`suspend`), the listener changing (`target`), the
 *   block going away (`dispose`) or a newer read make older tickets stale,
 *   and a stale answer is dropped.
 * - **Server generation**: an answer is shown only when its `generation` is
 *   the one of the server snapshot the screen shows. A newer one means the
 *   screen is behind: the server status is re-read (`refreshServer`), and
 *   the new generation then comes back through `target`, which discards
 *   everything shown for the old listener (design §4.1: old results are
 *   not kept as "previous results").
 *
 * The status is re-read every {@link REACH_POLL_INTERVAL_MS} only while a
 * check is pending (design D9); it stops once the check is confirmed or
 * expired, while an apply runs, and when the block is disposed. While a
 * confirmation (fresh or stale) is shown, only the local clock advances,
 * every {@link REACH_CLOCK_TICK_MS}, so the "n minutes ago" text keeps
 * counting without any IPC.
 *
 * Every method may be called from a `$effect` (the panel's), so the state
 * it reads is read under `untrack` (conventions §8).
 */
import { untrack } from 'svelte';
import { isProviderError } from '@banto/admin-core';
import type { ReachCheckRefusal, ReachCheckStatus } from '#lib/banto/serverAdmin.js';
import {
	REACH_CLOCK_TICK_MS,
	REACH_POLL_INTERVAL_MS,
	REACH_STALE_AFTER_MS,
	isReachCheckIssueResult,
	isReachCheckStatus,
	reachPolls,
	reachView,
	type IssuedReachUrl,
	type ReachView
} from './lanReachCheck';

/** Why the last "issue a check URL" did not show a URL. */
export type ReachIssueProblem =
	/** The host refused, with its reason code. */
	| { kind: 'refused'; reason: ReachCheckRefusal }
	/** The listener changed while issuing: nothing shown (the screen re-reads). */
	| { kind: 'changed' }
	/** The call failed or answered another shape. */
	| { kind: 'failed'; message: string | null };

export interface ReachCheckDeps {
	/** `getReachCheckStatus` (resolves to whatever the host answered). */
	getStatus: () => Promise<unknown>;
	/** `issueReachCheck`. */
	issue: (host: string) => Promise<unknown>;
	/** Re-read the server status (the host is past the snapshot shown). */
	refreshServer: () => void;
	/** Epoch milliseconds (defaults to `Date.now`). */
	clock?: () => number;
}

export class ReachCheckController {
	status = $state<ReachCheckStatus | null>(null);
	unreadable = $state(false);
	issued = $state<IssuedReachUrl | null>(null);
	issuing = $state(false);
	issueProblem = $state<ReachIssueProblem | null>(null);
	/** The clock the view is judged at (advanced by the re-read interval, the clock tick and the stale timer). */
	now = $state(0);
	readonly view: ReachView = $derived(
		reachView(this.status, this.unreadable, this.issued, this.now)
	);

	readonly #deps: ReachCheckDeps;
	readonly #clock: () => number;
	/** The generation of the server snapshot shown (`null` until `target`). */
	#generation: number | null = null;
	#readTicket = 0;
	#issueTicket = 0;
	#suspended = false;
	#disposed = false;
	#poll: ReturnType<typeof setInterval> | undefined;
	#staleTimer: ReturnType<typeof setTimeout> | undefined;
	#tick: ReturnType<typeof setInterval> | undefined;

	constructor(deps: ReachCheckDeps) {
		this.#deps = deps;
		this.#clock = deps.clock ?? (() => Date.now());
		this.now = this.#clock();
	}

	/** Whether the re-read interval is running (tests). */
	get polling(): boolean {
		return this.#poll !== undefined;
	}

	/** Whether the local clock tick (no IPC) is running (tests). */
	get ticking(): boolean {
		return this.#tick !== undefined;
	}

	/**
	 * The screen shows server snapshot `generation` (and no apply runs).
	 * A different generation than before discards everything shown; the
	 * status is (re-)read either way.
	 */
	target(generation: number): void {
		if (this.#disposed) return;
		if (generation !== this.#generation) {
			this.#generation = generation;
			this.status = null;
			this.unreadable = false;
			this.issued = null;
			this.issueProblem = null;
		}
		this.#suspended = false;
		void this.read();
	}

	/** An apply started: pending answers are dropped and the re-read interval stops. */
	suspend(): void {
		this.#suspended = true;
		this.#invalidate();
		this.#sync();
	}

	/** The block went away: nothing is read or shown any more. */
	dispose(): void {
		this.#disposed = true;
		this.#invalidate();
		this.#stopTimers();
	}

	/** Reads the status and shows it if it is still the latest read for the snapshot shown. */
	async read(): Promise<void> {
		if (this.#disposed || this.#suspended || this.#generation === null) return;
		const ticket = ++this.#readTicket;
		let value: unknown;
		try {
			value = await this.#deps.getStatus();
		} catch {
			if (ticket !== this.#readTicket) return;
			this.#showUnreadable();
			return;
		}
		if (ticket !== this.#readTicket) return;
		if (!isReachCheckStatus(value)) {
			this.#showUnreadable();
			return;
		}
		const shown = this.#generation;
		if (value.generation !== shown) {
			if (shown !== null && value.generation > shown) this.#deps.refreshServer();
			return;
		}
		this.status = value;
		this.unreadable = false;
		this.now = this.#clock();
		this.#sync();
	}

	/** "Issue a check URL" for `host` (one of `reachCandidateHosts`). */
	async issue(host: string): Promise<void> {
		const busy = untrack(() => this.issuing);
		if (this.#disposed || this.#suspended || this.#generation === null || busy) return;
		const ticket = ++this.#issueTicket;
		this.issuing = true;
		this.issueProblem = null;
		let value: unknown;
		try {
			value = await this.#deps.issue(host);
		} catch (error) {
			if (ticket !== this.#issueTicket) return;
			this.issuing = false;
			this.issueProblem = {
				kind: 'failed',
				message: isProviderError(error) ? error.message : null
			};
			return;
		}
		if (ticket !== this.#issueTicket) return;
		this.issuing = false;
		if (!isReachCheckIssueResult(value)) {
			this.issueProblem = { kind: 'failed', message: null };
			return;
		}
		const shown = this.#generation;
		if (value.generation !== shown) {
			if (shown !== null && value.generation > shown) this.#deps.refreshServer();
			this.issueProblem = { kind: 'changed' };
			return;
		}
		if (value.status === 'refused') {
			if (value.reason === 'staleGeneration') this.#deps.refreshServer();
			this.issueProblem = { kind: 'refused', reason: value.reason };
			return;
		}
		this.issued = {
			generation: value.generation,
			issueId: value.issueId,
			url: value.url,
			qrSvg: value.qrSvg,
			issuedAt: this.#clock()
		};
		await this.read();
	}

	#invalidate(): void {
		this.#readTicket++;
		if (untrack(() => this.issuing)) {
			this.#issueTicket++;
			this.issuing = false;
		}
	}

	/** A failed read clears the previous status (it is never shown next to the error). */
	#showUnreadable(): void {
		this.status = null;
		this.unreadable = true;
		this.#sync();
	}

	/** Starts or stops the re-read interval and the "stale" timer for the view now shown. */
	#sync(): void {
		const view = untrack(() => this.view);
		const active = !this.#disposed && !this.#suspended;
		if (active && reachPolls(view)) {
			this.#poll ??= setInterval(() => {
				this.now = this.#clock();
				void this.read();
			}, REACH_POLL_INTERVAL_MS);
		} else if (this.#poll !== undefined) {
			clearInterval(this.#poll);
			this.#poll = undefined;
		}
		if (active && (view.kind === 'verified' || view.kind === 'stale')) {
			this.#tick ??= setInterval(() => {
				this.now = this.#clock();
			}, REACH_CLOCK_TICK_MS);
		} else if (this.#tick !== undefined) {
			clearInterval(this.#tick);
			this.#tick = undefined;
		}
		clearTimeout(this.#staleTimer);
		this.#staleTimer = undefined;
		if (active && view.kind === 'verified') {
			// Design D10: turn "confirmed" into "stale" on time even when nothing is re-read.
			const wait = view.records[0].at + REACH_STALE_AFTER_MS - untrack(() => this.now);
			this.#staleTimer = setTimeout(
				() => {
					this.#staleTimer = undefined;
					this.now = this.#clock();
				},
				Math.max(0, wait)
			);
		}
	}

	#stopTimers(): void {
		clearInterval(this.#poll);
		this.#poll = undefined;
		clearTimeout(this.#staleTimer);
		this.#staleTimer = undefined;
		clearInterval(this.#tick);
		this.#tick = undefined;
	}
}
