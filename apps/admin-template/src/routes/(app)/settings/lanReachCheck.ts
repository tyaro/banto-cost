/**
 * Spec §11.4 (LAN settings UX). Pure decisions behind the settings screen's
 * "connection check from another device" block (Issue #219 stage 1 / PR-C3,
 * lan-reach-check-design §4): whether to show it, which hosts a check URL
 * may name, and which of the §4.1 states the last `reach_check_status`
 * answer is in. `LanReachCheckPanel.svelte` renders the result and
 * `lanReachCheckController.svelte.ts` keeps the requests in order; nothing
 * here touches the DOM, Tauri, timers or the message catalog
 * (conventions §13).
 *
 * This block is kept apart from the firewall blocks on purpose (design
 * §4.1): the firewall state is never inferred from a reach result, and a
 * reach result is never inferred from the firewall state.
 */
import type {
	ReachCheckIssueResult,
	ReachCheckStatus,
	ReachLastIssue,
	ReachRecord,
	ServerStatus
} from '#lib/banto/serverAdmin.js';
import { isIpv4Bind, isLoopbackHost, isUnspecifiedHost } from './connectivityScope';

/** Design D10: a confirmed reach older than this reads as "stale". */
export const REACH_STALE_AFTER_MS = 60 * 60 * 1000;

/** Design D9: while a check is pending, `reach_check_status` is re-read this often. */
export const REACH_POLL_INTERVAL_MS = 2000;

/**
 * How often the screen's own clock advances while a confirmation is shown,
 * so "n minutes ago" keeps counting (a local clock only - nothing is
 * re-read over IPC, design D9).
 */
export const REACH_CLOCK_TICK_MS = 60_000;

/**
 * Whether the block is shown for `status` (design §4.1: the same gate as
 * the firewall information, minus "Windows only" - reaching a port does not
 * depend on the OS): the live listener runs on a non-loopback IPv4 bind and
 * the host reports a `generation` (a reach answer is only ever matched
 * against one). The caller adds "inside the Tauri window".
 */
export function reachCheckAvailable(status: ServerStatus | null): boolean {
	if (status === null || !status.running || !status.uiEmbedded) return false;
	const live = status.live;
	if (!live || !isIpv4Bind(live.bind) || isLoopbackHost(live.bind)) return false;
	return typeof status.generation === 'number';
}

/**
 * Issue #478: the listener is serving but this build has no web UI embedded
 * (plain `tauri build` / `tauri dev`), so another device would only get a
 * placeholder page: the settings screen shows no URL, QR or connection
 * check, only a note saying why.
 */
export function lanUiMissing(status: ServerStatus | null): boolean {
	return status !== null && status.running && !status.uiEmbedded;
}

/**
 * The hosts a check URL may name: the IPv4, non-loopback hosts of the live
 * listener's URLs (`status.urls`, already scoped to the live bind on the
 * Rust side). `reach_check_issue` refuses any other host (`unknownHost`).
 */
export function reachCandidateHosts(status: ServerStatus | null): string[] {
	if (status === null) return [];
	const hosts: string[] = [];
	for (const url of status.urls) {
		let hostname: string;
		try {
			hostname = new URL(url).hostname;
		} catch {
			continue;
		}
		if (!isIpv4Bind(hostname) || isLoopbackHost(hostname) || isUnspecifiedHost(hostname)) {
			continue;
		}
		if (!hosts.includes(hostname)) hosts.push(hostname);
	}
	return hosts;
}

const OUTCOMES = new Set(['pending', 'recorded', 'expired']);

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isLastIssue(value: unknown): value is ReachLastIssue {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		isFiniteNumber(v.issueId) &&
		typeof v.host === 'string' &&
		isFiniteNumber(v.port) &&
		isFiniteNumber(v.expiresAt) &&
		typeof v.outcome === 'string' &&
		OUTCOMES.has(v.outcome) &&
		isFiniteNumber(v.expiresInMs)
	);
}

function isRecord(value: unknown): value is ReachRecord {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		isFiniteNumber(v.issueId) &&
		isFiniteNumber(v.at) &&
		typeof v.peerIp === 'string' &&
		typeof v.host === 'string' &&
		isFiniteNumber(v.port)
	);
}

/**
 * Whether the host answered `reach_check_status`'s shape. Anything else (an
 * older host without the command answers `null`) reads as "could not read",
 * never as "unverified" (design §4.1, like PR-B's "unreadable ≠ no rule").
 */
export function isReachCheckStatus(value: unknown): value is ReachCheckStatus {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		isFiniteNumber(v.generation) &&
		(v.lastIssue === null || isLastIssue(v.lastIssue)) &&
		(v.selfAccessAt === null || isFiniteNumber(v.selfAccessAt)) &&
		Array.isArray(v.records) &&
		v.records.every(isRecord)
	);
}

/** Whether the host answered `reach_check_issue`'s shape. */
export function isReachCheckIssueResult(value: unknown): value is ReachCheckIssueResult {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	if (!isFiniteNumber(v.generation)) return false;
	if (v.status === 'issued') {
		return (
			isFiniteNumber(v.issueId) &&
			typeof v.url === 'string' &&
			typeof v.qrSvg === 'string' &&
			isFiniteNumber(v.expiresInMs)
		);
	}
	return v.status === 'refused' && typeof v.reason === 'string';
}

/**
 * The URL and QR code of the issuance this screen made. Only the issue
 * answer carries them (the status never returns the token), so a pending
 * issuance made before the screen was opened shows no QR.
 */
export interface IssuedReachUrl {
	generation: number;
	issueId: number;
	url: string;
	qrSvg: string;
	/** Epoch milliseconds when the answer arrived (a self access before it is an older token's). */
	issuedAt: number;
}

/** What the block shows (lan-reach-check-design §4.1's table). */
export type ReachView =
	/** Nothing read yet (the first read is in flight). */
	| { kind: 'loading' }
	/** The status could not be read, or the answer had another shape. Never "unverified". */
	| { kind: 'unreadable' }
	/** Nothing issued for the live listener. */
	| { kind: 'unverified' }
	/** Waiting for another device. `issued` is `null` when this screen did not issue it. */
	| { kind: 'pending'; remainingMs: number; issued: IssuedReachUrl | null }
	/** Still waiting - but this PC itself opened the URL, which does not count. */
	| { kind: 'selfAccess'; remainingMs: number; issued: IssuedReachUrl | null; at: number }
	/** Another device reached the listener (`records`: newest first, the last issuance's first). */
	| { kind: 'verified'; records: ReachRecord[] }
	/** Same as verified, but older than {@link REACH_STALE_AFTER_MS}. */
	| { kind: 'stale'; records: ReachRecord[] }
	/** No other device opened the URL in time. Not a proof that it cannot. */
	| { kind: 'expired' };

/**
 * The state of the last status answer at `now` (epoch milliseconds - the
 * server and this screen run on the same PC, design §4.1). `issued` is only
 * used when it is for the same generation and issuance.
 */
export function reachView(
	status: ReachCheckStatus | null,
	unreadable: boolean,
	issued: IssuedReachUrl | null,
	now: number
): ReachView {
	if (unreadable) return { kind: 'unreadable' };
	if (status === null) return { kind: 'loading' };
	const last = status.lastIssue;
	if (last === null) return { kind: 'unverified' };
	if (last.outcome === 'pending') {
		const own =
			issued !== null && issued.generation === status.generation && issued.issueId === last.issueId
				? issued
				: null;
		const remainingMs = Math.max(0, last.expiresAt - now);
		const self = status.selfAccessAt;
		if (self !== null && (own === null || self >= own.issuedAt)) {
			return { kind: 'selfAccess', remainingMs, issued: own, at: self };
		}
		return { kind: 'pending', remainingMs, issued: own };
	}
	if (last.outcome === 'expired') return { kind: 'expired' };
	// `recorded`: the last issuance's record first, then the others (newest first).
	const mine = status.records.filter((record) => record.issueId === last.issueId);
	const others = status.records.filter((record) => record.issueId !== last.issueId);
	const records = [...mine, ...others];
	if (records.length === 0) return { kind: 'unreadable' };
	return now - records[0].at >= REACH_STALE_AFTER_MS
		? { kind: 'stale', records }
		: { kind: 'verified', records };
}

/** Whether `view` keeps the screen re-reading the status (design D9: only while pending). */
export function reachPolls(view: ReachView): boolean {
	return view.kind === 'pending' || view.kind === 'selfAccess';
}

/** `m:ss` for a remaining time (rounded up, so "0:00" only once it is over). */
export function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Whole minutes from `at` to `now` (never negative). */
export function minutesSince(at: number, now: number): number {
	return Math.max(0, Math.floor((now - at) / 60_000));
}

/** `http://<host>:<port>` - the URL a record was reached through (without the token). */
export function recordUrl(record: ReachRecord): string {
	return `http://${record.host}:${record.port}`;
}
