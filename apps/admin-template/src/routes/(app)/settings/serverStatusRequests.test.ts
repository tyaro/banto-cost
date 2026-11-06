import { describe, expect, it } from 'vitest';
import type { ServerStatus } from '#lib/banto/serverAdmin.js';
import { ServerStatusRequests, isOlderStatus } from './serverStatusRequests';
import { firewallCopyCheck, firewallGuide, type FirewallInfo } from './firewallInfo';

const ID = 'dev.banto.admin';

function status(port: number, generation: number | undefined): ServerStatus {
	return {
		enabled: true,
		running: true,
		bind: '0.0.0.0',
		port,
		viewerPublic: false,
		live: { bind: '0.0.0.0', port },
		urls: [`http://192.168.1.20:${port}/`],
		qrSvgs: [],
		uiEmbedded: true,
		generation,
		executablePath: 'C:\\banto-admin.exe',
		platform: 'windows'
	};
}

const A = status(8721, 1);
const B = status(8722, 2);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A stand-in for the section: its shown status, and the tracker over it. */
function section(initial: ServerStatus | null) {
	const state = { shown: initial, writes: 0 };
	const requests = new ServerStatusRequests(
		() => state.shown,
		(next) => {
			state.shown = next;
			state.writes++;
		}
	);
	return { state, requests };
}

function shownInfo(s: ServerStatus): FirewallInfo {
	const guide = firewallGuide(s, ID);
	if (guide.kind !== 'show') throw new Error('expected show');
	return guide.info;
}

describe('isOlderStatus (owner review on PR #463)', () => {
	it('is older only when both generations are known and the incoming one is lower', () => {
		expect(isOlderStatus(B, A)).toBe(true);
		expect(isOlderStatus(A, B)).toBe(false);
		expect(isOlderStatus(A, A)).toBe(false);
		expect(isOlderStatus(null, A)).toBe(false);
	});

	it('cannot compare a snapshot without generation (older host), so does not call it older', () => {
		expect(isOlderStatus(B, status(8721, undefined))).toBe(false);
		expect(isOlderStatus(status(8721, undefined), A)).toBe(false);
	});
});

describe('ServerStatusRequests (owner review on PR #463)', () => {
	it('A held -> B applied -> A released: neither the screen nor the copy goes back to A', async () => {
		const { state, requests } = section(A);
		const shown = shownInfo(A);

		// 1. Copy pressed while A is shown; its re-read (A) is held.
		const readA = deferred<ServerStatus>();
		const copyRead = requests.refresh(() => readA.promise);

		// 2. Apply to B; its response is shown.
		const applied = await requests.apply(() => Promise.resolve(B));
		expect(applied).toBe(B);
		expect(state.shown).toBe(B);

		// 3. The held A arrives.
		readA.resolve(A);
		const result = await copyRead;
		expect(result).toEqual({ kind: 'superseded' });
		expect(state.shown).toBe(B);
		// The copy refuses (and asks to check again) instead of copying A's command.
		expect(firewallCopyCheck(shown, result, ID)).toBe('stale');
	});

	it('drops a read held across an apply that is still running', async () => {
		const { state, requests } = section(A);
		const readA = deferred<ServerStatus>();
		const copyRead = requests.refresh(() => readA.promise);
		const applyB = deferred<ServerStatus>();
		const applying = requests.apply(() => applyB.promise);

		readA.resolve(A);
		expect(await copyRead).toEqual({ kind: 'superseded' });
		applyB.resolve(B);
		expect(await applying).toBe(B);
		expect(state.shown).toBe(B);
	});

	it('drops an older read when a newer read was started after it', async () => {
		const { state, requests } = section(A);
		const first = deferred<ServerStatus>();
		const older = requests.refresh(() => first.promise);
		const newer = await requests.refresh(() => Promise.resolve(B));
		expect(newer).toEqual({ kind: 'ok', status: B });
		first.resolve(A);
		expect(await older).toEqual({ kind: 'superseded' });
		expect(state.shown).toBe(B);
	});

	it('never shows a snapshot with a lower generation than the one shown', async () => {
		const { state, requests } = section(B);
		expect(await requests.refresh(() => Promise.resolve(A))).toEqual({ kind: 'superseded' });
		expect(await requests.apply(() => Promise.resolve(A))).toBeNull();
		expect(state.shown).toBe(B);
		expect(state.writes).toBe(0);
	});

	it('reports a failed read only while it is still the latest', async () => {
		const { requests } = section(A);
		const error = new Error('boom');
		expect(await requests.refresh(() => Promise.reject(error))).toEqual({
			kind: 'unavailable',
			error
		});
		const held = deferred<ServerStatus>();
		const stale = requests.refresh(() => held.promise);
		await requests.apply(() => Promise.resolve(B));
		held.reject(error);
		expect(await stale).toEqual({ kind: 'superseded' });
	});

	it('lets an apply error through after making pending reads stale', async () => {
		const { state, requests } = section(A);
		const held = deferred<ServerStatus>();
		const pending = requests.refresh(() => held.promise);
		await expect(requests.apply(() => Promise.reject(new Error('port in use')))).rejects.toThrow(
			'port in use'
		);
		held.resolve(A);
		expect(await pending).toEqual({ kind: 'superseded' });
		expect(state.writes).toBe(0);
	});
});

describe('firewallCopyCheck', () => {
	const shown = shownInfo(A);

	it('copies when the re-read describes the same listener', () => {
		expect(firewallCopyCheck(shown, { kind: 'ok', status: A }, ID)).toBe('copy');
	});

	it('refuses when the listener changed before the copy (change, then copy)', () => {
		expect(firewallCopyCheck(shown, { kind: 'ok', status: B }, ID)).toBe('stale');
		// Same port but a newer generation: still re-check.
		expect(firewallCopyCheck(shown, { kind: 'ok', status: status(8721, 2) }, ID)).toBe('stale');
	});

	it('refuses when the read was dropped or failed', () => {
		expect(firewallCopyCheck(shown, { kind: 'superseded' }, ID)).toBe('stale');
		expect(firewallCopyCheck(shown, { kind: 'unavailable', error: null }, ID)).toBe('unavailable');
	});
});
