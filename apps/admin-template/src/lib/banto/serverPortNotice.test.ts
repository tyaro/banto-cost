import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStatus } from './serverAdmin';
import {
	notifyServerPortNoticeOnce,
	resetServerPortNoticeForTest,
	serverPortNoticeMessage
} from './serverPortNotice';

function status(portNotice: ServerStatus['portNotice']): ServerStatus {
	return {
		enabled: true,
		running: portNotice?.kind !== 'exhausted',
		bind: '0.0.0.0',
		port: portNotice?.kind === 'fallback' ? portNotice.port : 8721,
		viewerPublic: false,
		urls: [],
		qrSvgs: [],
		uiEmbedded: true,
		portNotice
	};
}

describe('serverPortNoticeMessage', () => {
	it('names both ports, as plain digits', () => {
		const text = serverPortNoticeMessage({
			kind: 'fallback',
			requestedPort: 18721,
			port: 18722,
			saved: true
		});
		// No locale digit grouping ("18,721").
		expect(text).toContain('18721');
		expect(text).toContain('18722');
	});

	it('uses a distinct message when the new port was not saved, and when the range ran out', () => {
		const saved = serverPortNoticeMessage({
			kind: 'fallback',
			requestedPort: 8721,
			port: 8722,
			saved: true
		});
		const notSaved = serverPortNoticeMessage({
			kind: 'fallback',
			requestedPort: 8721,
			port: 8722,
			saved: false
		});
		const exhausted = serverPortNoticeMessage({
			kind: 'exhausted',
			requestedPort: 8721,
			lastPort: 8740,
			allInUse: true
		});
		// Some candidate failed for another reason (e.g. reserved by the OS):
		// the text must not claim every port was in use.
		const noUsable = serverPortNoticeMessage({
			kind: 'exhausted',
			requestedPort: 8721,
			lastPort: 8740,
			allInUse: false
		});
		expect(new Set([saved, notSaved, exhausted, noUsable]).size).toBe(4);
		for (const text of [exhausted, noUsable]) {
			expect(text).toContain('8721');
			expect(text).toContain('8740');
		}
	});
});

describe('notifyServerPortNoticeOnce', () => {
	beforeEach(() => {
		resetServerPortNoticeForTest();
	});

	it('toasts a saved fallback as info, once per page load', async () => {
		const notify = vi.fn();
		const getStatus = vi.fn(async () =>
			status({ kind: 'fallback', requestedPort: 8721, port: 8722, saved: true })
		);
		await notifyServerPortNoticeOnce({ getStatus, notify });
		await notifyServerPortNoticeOnce({ getStatus, notify });
		expect(getStatus).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toBe('info');
		expect(notify.mock.calls[0][1]).toContain('8722');
	});

	it('warns when the new port was not saved and errors when nothing started', async () => {
		const notify = vi.fn();
		await notifyServerPortNoticeOnce({
			getStatus: async () =>
				status({ kind: 'fallback', requestedPort: 8721, port: 8722, saved: false }),
			notify
		});
		resetServerPortNoticeForTest();
		await notifyServerPortNoticeOnce({
			getStatus: async () =>
				status({ kind: 'exhausted', requestedPort: 8721, lastPort: 8740, allInUse: true }),
			notify
		});
		expect(notify.mock.calls.map((call) => call[0])).toEqual(['warning', 'error']);
	});

	it('stays silent without a notice or when the status read fails', async () => {
		const notify = vi.fn();
		await notifyServerPortNoticeOnce({ getStatus: async () => status(null), notify });
		resetServerPortNoticeForTest();
		await notifyServerPortNoticeOnce({ getStatus: async () => status(undefined), notify });
		resetServerPortNoticeForTest();
		await notifyServerPortNoticeOnce({
			getStatus: () => Promise.reject(new Error('forbidden')),
			notify
		});
		expect(notify).not.toHaveBeenCalled();
	});
});
