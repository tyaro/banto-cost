import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ReachCheckIssueResult,
	ReachCheckStatus,
	ReachRecord,
	ServerStatus
} from '#lib/banto/serverAdmin.js';
import {
	REACH_CLOCK_TICK_MS,
	REACH_POLL_INTERVAL_MS,
	REACH_STALE_AFTER_MS,
	formatRemaining,
	isReachCheckStatus,
	minutesSince,
	reachCandidateHosts,
	lanUiMissing,
	reachCheckAvailable,
	reachPolls,
	reachView,
	type IssuedReachUrl
} from './lanReachCheck';
import { ReachCheckController } from './lanReachCheckController.svelte';

const T0 = Date.UTC(2026, 9, 22, 3, 0, 0);
const TOKEN_URL = 'http://192.168.1.20:8721/reach#t=0d8b2f4e-1c3a-4b5d-9e6f-7a8b9c0d1e2f';

function server(patch: Partial<ServerStatus> = {}): ServerStatus {
	return {
		enabled: true,
		running: true,
		bind: '0.0.0.0',
		port: 8721,
		viewerPublic: false,
		live: { bind: '0.0.0.0', port: 8721 },
		urls: ['http://127.0.0.1:8721', 'http://192.168.1.20:8721', 'http://10.0.0.5:8721'],
		qrSvgs: [],
		uiEmbedded: true,
		generation: 1,
		...patch
	};
}

function record(patch: Partial<ReachRecord> = {}): ReachRecord {
	return { issueId: 1, at: T0, peerIp: '192.168.1.31', host: '192.168.1.20', port: 8721, ...patch };
}

function reach(
	outcome: 'pending' | 'recorded' | 'expired' | null,
	patch: Partial<ReachCheckStatus> = {}
): ReachCheckStatus {
	return {
		generation: 1,
		lastIssue:
			outcome === null
				? null
				: {
						issueId: 1,
						host: '192.168.1.20',
						port: 8721,
						expiresAt: T0 + 5 * 60_000,
						outcome,
						expiresInMs: outcome === 'pending' ? 5 * 60_000 : 0
					},
		selfAccessAt: null,
		records: outcome === 'recorded' ? [record()] : [],
		...patch
	};
}

const issuedUrl: IssuedReachUrl = {
	generation: 1,
	issueId: 1,
	url: TOKEN_URL,
	qrSvg: '<svg></svg>',
	issuedAt: T0
};

describe('reachCheckAvailable / reachCandidateHosts', () => {
	it('shows the block only for a running non-loopback IPv4 listener with a generation', () => {
		expect(reachCheckAvailable(server())).toBe(true);
		// Not Windows-only (design §4.1).
		expect(reachCheckAvailable(server({ platform: 'macos' }))).toBe(true);
		expect(reachCheckAvailable(null)).toBe(false);
		// Issue #478: no embedded web UI -> no check, only the note.
		expect(reachCheckAvailable(server({ uiEmbedded: false }))).toBe(false);
		expect(lanUiMissing(server({ uiEmbedded: false }))).toBe(true);
		expect(lanUiMissing(server())).toBe(false);
		expect(lanUiMissing(server({ uiEmbedded: false, running: false }))).toBe(false);
		expect(lanUiMissing(null)).toBe(false);
		expect(reachCheckAvailable(server({ running: false }))).toBe(false);
		expect(reachCheckAvailable(server({ live: null }))).toBe(false);
		expect(reachCheckAvailable(server({ live: { bind: '127.0.0.1', port: 8721 } }))).toBe(false);
		expect(reachCheckAvailable(server({ live: { bind: '::', port: 8721 } }))).toBe(false);
		expect(reachCheckAvailable(server({ generation: undefined }))).toBe(false);
	});

	it('offers the live URLs non-loopback IPv4 hosts only', () => {
		expect(reachCandidateHosts(server())).toEqual(['192.168.1.20', '10.0.0.5']);
		expect(reachCandidateHosts(server({ urls: ['http://127.0.0.1:8721'] }))).toEqual([]);
		expect(reachCandidateHosts(null)).toEqual([]);
	});
});

describe('reachView (design §4.1 states)', () => {
	it('unverified when nothing was issued', () => {
		expect(reachView(reach(null), false, null, T0).kind).toBe('unverified');
	});

	it('loading before the first answer, unreadable (never unverified) after a failure', () => {
		expect(reachView(null, false, null, T0).kind).toBe('loading');
		expect(reachView(null, true, null, T0).kind).toBe('unreadable');
		expect(reachView(reach(null), true, null, T0).kind).toBe('unreadable');
	});

	it('pending with the URL this screen issued and the remaining time', () => {
		const view = reachView(reach('pending'), false, issuedUrl, T0 + 60_000);
		expect(view).toEqual({ kind: 'pending', remainingMs: 4 * 60_000, issued: issuedUrl });
	});

	it('pending without a URL for an issuance this screen did not make', () => {
		const other = { ...issuedUrl, issueId: 9 };
		const view = reachView(reach('pending'), false, other, T0);
		expect(view).toMatchObject({ kind: 'pending', issued: null });
		const otherGeneration = { ...issuedUrl, generation: 0 };
		expect(reachView(reach('pending'), false, otherGeneration, T0)).toMatchObject({
			issued: null
		});
	});

	it('this PC itself: still pending, but marked', () => {
		const view = reachView(
			reach('pending', { selfAccessAt: T0 + 1000 }),
			false,
			issuedUrl,
			T0 + 2000
		);
		expect(view).toMatchObject({ kind: 'selfAccess', at: T0 + 1000, issued: issuedUrl });
		expect(reachPolls(view)).toBe(true);
		// A self access before this issuance belongs to an older token.
		const older = reachView(reach('pending', { selfAccessAt: T0 - 1000 }), false, issuedUrl, T0);
		expect(older.kind).toBe('pending');
	});

	it('verified, with the last issuance record first, and stale after one hour', () => {
		const status = reach('recorded', {
			records: [record({ issueId: 0, at: T0 + 10 }), record({ issueId: 1, at: T0 })]
		});
		const view = reachView(status, false, null, T0 + REACH_STALE_AFTER_MS - 1);
		expect(view.kind).toBe('verified');
		if (view.kind === 'verified') expect(view.records.map((r) => r.issueId)).toEqual([1, 0]);
		expect(reachView(status, false, null, T0 + REACH_STALE_AFTER_MS).kind).toBe('stale');
	});

	it('expired', () => {
		const view = reachView(reach('expired'), false, issuedUrl, T0);
		expect(view.kind).toBe('expired');
		expect(reachPolls(view)).toBe(false);
	});

	it('a "recorded" answer without any record is unreadable, not verified', () => {
		expect(reachView(reach('recorded', { records: [] }), false, null, T0).kind).toBe('unreadable');
	});

	it('formats the remaining time and the minutes since', () => {
		expect(formatRemaining(5 * 60_000)).toBe('5:00');
		expect(formatRemaining(61_001)).toBe('1:02');
		expect(formatRemaining(-5)).toBe('0:00');
		expect(minutesSince(T0, T0 + 3 * 60_000 + 59_000)).toBe(3);
		expect(minutesSince(T0, T0 - 1)).toBe(0);
	});

	it('rejects answers of another shape', () => {
		expect(isReachCheckStatus(reach('recorded'))).toBe(true);
		expect(isReachCheckStatus(null)).toBe(false);
		expect(isReachCheckStatus({ generation: 1, lastIssue: null, records: [] })).toBe(false);
		expect(isReachCheckStatus({ ...reach(null), records: [{ at: 1 }] })).toBe(false);
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const issued = (patch: Partial<Extract<ReachCheckIssueResult, { status: 'issued' }>> = {}) => ({
	status: 'issued' as const,
	generation: 1,
	issueId: 1,
	url: TOKEN_URL,
	qrSvg: '<svg></svg>',
	expiresInMs: 5 * 60_000,
	...patch
});

/** Flush pending promise callbacks (the controller awaits its deps). */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('ReachCheckController', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function setup(answers: { status?: () => Promise<unknown>; issue?: () => Promise<unknown> }) {
		const getStatus = vi.fn(answers.status ?? (() => Promise.resolve(reach(null))));
		const issue = vi.fn(answers.issue ?? (() => Promise.resolve(issued())));
		const refreshServer = vi.fn();
		const controller = new ReachCheckController({ getStatus, issue, refreshServer });
		return { controller, getStatus, issue, refreshServer };
	}

	it('reads on target and shows unverified without polling', async () => {
		const { controller, getStatus } = setup({});
		controller.target(1);
		await settle();
		expect(getStatus).toHaveBeenCalledTimes(1);
		expect(controller.view.kind).toBe('unverified');
		expect(controller.polling).toBe(false);
	});

	it('polls every 2 s only while pending, and stops once confirmed', async () => {
		let answer: ReachCheckStatus = reach(null);
		const { controller, getStatus } = setup({ status: () => Promise.resolve(answer) });
		controller.target(1);
		await settle();
		answer = reach('pending');
		await controller.issue('192.168.1.20');
		expect(controller.view).toMatchObject({ kind: 'pending', issued: { url: TOKEN_URL } });
		expect(controller.polling).toBe(true);
		const reads = getStatus.mock.calls.length;
		await vi.advanceTimersByTimeAsync(REACH_POLL_INTERVAL_MS);
		expect(getStatus).toHaveBeenCalledTimes(reads + 1);
		answer = reach('recorded');
		await vi.advanceTimersByTimeAsync(REACH_POLL_INTERVAL_MS);
		expect(controller.view.kind).toBe('verified');
		expect(controller.polling).toBe(false);
		await vi.advanceTimersByTimeAsync(REACH_POLL_INTERVAL_MS * 5);
		expect(getStatus).toHaveBeenCalledTimes(reads + 2);
	});

	it('stops polling once expired', async () => {
		let answer: ReachCheckStatus = reach('pending');
		const { controller } = setup({ status: () => Promise.resolve(answer) });
		controller.target(1);
		await settle();
		expect(controller.polling).toBe(true);
		answer = reach('expired');
		await vi.advanceTimersByTimeAsync(REACH_POLL_INTERVAL_MS);
		expect(controller.view.kind).toBe('expired');
		expect(controller.polling).toBe(false);
	});

	it('stops polling when the page is left (dispose) and while an apply runs', async () => {
		const { controller, getStatus } = setup({ status: () => Promise.resolve(reach('pending')) });
		controller.target(1);
		await settle();
		expect(controller.polling).toBe(true);
		controller.suspend();
		expect(controller.polling).toBe(false);
		controller.target(1);
		await settle();
		expect(controller.polling).toBe(true);
		controller.dispose();
		expect(controller.polling).toBe(false);
		const reads = getStatus.mock.calls.length;
		await vi.advanceTimersByTimeAsync(REACH_POLL_INTERVAL_MS * 3);
		expect(getStatus).toHaveBeenCalledTimes(reads);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('turns confirmed into stale after one hour without re-reading', async () => {
		const { controller, getStatus } = setup({ status: () => Promise.resolve(reach('recorded')) });
		controller.target(1);
		await settle();
		expect(controller.view.kind).toBe('verified');
		await vi.advanceTimersByTimeAsync(REACH_STALE_AFTER_MS);
		expect(controller.view.kind).toBe('stale');
		expect(getStatus).toHaveBeenCalledTimes(1);
	});

	it('advances its own clock every minute while confirmed, without re-reading', async () => {
		const { controller, getStatus } = setup({ status: () => Promise.resolve(reach('recorded')) });
		controller.target(1);
		await settle();
		expect(controller.ticking).toBe(true);
		expect(minutesSince(record().at, controller.now)).toBe(0);
		await vi.advanceTimersByTimeAsync(REACH_CLOCK_TICK_MS * 3);
		expect(minutesSince(record().at, controller.now)).toBe(3);
		await vi.advanceTimersByTimeAsync(REACH_STALE_AFTER_MS);
		expect(controller.view.kind).toBe('stale');
		// Still counting while stale.
		await vi.advanceTimersByTimeAsync(REACH_CLOCK_TICK_MS);
		expect(minutesSince(record().at, controller.now)).toBe(64);
		expect(getStatus).toHaveBeenCalledTimes(1);
		controller.dispose();
		expect(controller.ticking).toBe(false);
	});

	it('runs no clock tick while nothing is confirmed, or while an apply runs', async () => {
		const { controller } = setup({ status: () => Promise.resolve(reach('recorded')) });
		expect(controller.ticking).toBe(false);
		controller.target(1);
		await settle();
		expect(controller.ticking).toBe(true);
		controller.suspend();
		expect(controller.ticking).toBe(false);
		const pending = setup({ status: () => Promise.resolve(reach('pending')) });
		pending.controller.target(1);
		await settle();
		expect(pending.controller.ticking).toBe(false);
		pending.controller.dispose();
	});

	it('drops an answer that a newer read or an apply superseded', async () => {
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		const queue = [first, second];
		const { controller } = setup({ status: () => queue.shift()!.promise });
		controller.target(1);
		void controller.read();
		second.resolve(reach('expired'));
		await settle();
		first.resolve(reach('recorded'));
		await settle();
		expect(controller.view.kind).toBe('expired');

		// Hold A, apply, release A: A is never shown.
		const held = deferred<unknown>();
		const { controller: c2 } = setup({ status: () => held.promise });
		c2.target(1);
		c2.suspend();
		held.resolve(reach('recorded'));
		await settle();
		expect(c2.view.kind).toBe('loading');
	});

	it('drops an answer for another generation and re-reads the server when the host is newer', async () => {
		let answer: ReachCheckStatus = reach('recorded', { generation: 2 });
		const { controller, refreshServer } = setup({ status: () => Promise.resolve(answer) });
		controller.target(1);
		await settle();
		expect(controller.view.kind).toBe('loading');
		expect(refreshServer).toHaveBeenCalledTimes(1);
		answer = reach('recorded', { generation: 0 });
		await controller.read();
		expect(controller.view.kind).toBe('loading');
		expect(refreshServer).toHaveBeenCalledTimes(1);
	});

	it('discards what was shown when the listener changes', async () => {
		let answer: ReachCheckStatus = reach('pending');
		const { controller } = setup({ status: () => Promise.resolve(answer) });
		controller.target(1);
		await settle();
		await controller.issue('192.168.1.20');
		expect(controller.issued).not.toBeNull();
		answer = reach(null, { generation: 2 });
		controller.target(2);
		expect(controller.issued).toBeNull();
		expect(controller.view.kind).toBe('loading');
		await settle();
		expect(controller.view.kind).toBe('unverified');
	});

	it('shows unreadable (not unverified) when the read fails, and clears the old status', async () => {
		let fail = false;
		const { controller } = setup({
			status: () => (fail ? Promise.reject(new Error('ipc')) : Promise.resolve(reach('recorded')))
		});
		controller.target(1);
		await settle();
		expect(controller.view.kind).toBe('verified');
		fail = true;
		await controller.read();
		expect(controller.view.kind).toBe('unreadable');
		expect(controller.status).toBeNull();
	});

	it('an older host without the command (null answer) reads as unreadable', async () => {
		const { controller } = setup({ status: () => Promise.resolve(null) });
		controller.target(1);
		await settle();
		expect(controller.view.kind).toBe('unreadable');
	});

	it.each([
		'notListening',
		'unsupportedBind',
		'loopbackOnly',
		'unknownHost',
		'staleGeneration',
		'localAddressesUnavailable'
	] as const)('keeps the refusal reason %s', async (reason) => {
		const { controller, refreshServer } = setup({
			issue: () => Promise.resolve({ status: 'refused', generation: 1, reason })
		});
		controller.target(1);
		await settle();
		await controller.issue('192.168.1.20');
		expect(controller.issueProblem).toEqual({ kind: 'refused', reason });
		expect(controller.issued).toBeNull();
		expect(refreshServer).toHaveBeenCalledTimes(reason === 'staleGeneration' ? 1 : 0);
	});

	it('does not show a URL issued for another generation, or after an apply started', async () => {
		const { controller, refreshServer } = setup({
			issue: () => Promise.resolve(issued({ generation: 2 }))
		});
		controller.target(1);
		await settle();
		await controller.issue('192.168.1.20');
		expect(controller.issued).toBeNull();
		expect(controller.issueProblem).toEqual({ kind: 'changed' });
		expect(refreshServer).toHaveBeenCalledTimes(1);

		const held = deferred<unknown>();
		const { controller: c2 } = setup({ issue: () => held.promise });
		c2.target(1);
		await settle();
		const pending = c2.issue('192.168.1.20');
		expect(c2.issuing).toBe(true);
		c2.suspend();
		expect(c2.issuing).toBe(false);
		held.resolve(issued());
		await pending;
		expect(c2.issued).toBeNull();
	});

	it('a failed issuance says so', async () => {
		const { controller } = setup({ issue: () => Promise.reject(new Error('boom')) });
		controller.target(1);
		await settle();
		await controller.issue('192.168.1.20');
		expect(controller.issueProblem).toEqual({ kind: 'failed', message: null });
	});
});
