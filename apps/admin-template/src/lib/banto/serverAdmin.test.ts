import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isProviderError, type ProviderError } from '@banto/admin-core';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { applyServerSettings, getServerStatus, liveBind, type ServerStatus } from './serverAdmin';

describe('serverAdmin error conversion (#287)', () => {
	beforeEach(() => {
		invokeMock.mockReset();
	});

	it('converts a { kind, message } rejection into a ProviderError', async () => {
		invokeMock.mockImplementation(() =>
			Promise.reject({ kind: 'bad_request', message: 'port in use' })
		);
		let err: unknown;
		try {
			await applyServerSettings(true, '0.0.0.0', 80, false);
		} catch (e) {
			err = e;
		}
		expect(isProviderError(err)).toBe(true);
		expect((err as Error).message).toBe('port in use');
		expect((err as ProviderError).body.kind).toBe('bad_request');
	});

	it('wraps an unknown rejection as kind other', async () => {
		invokeMock.mockImplementation(() => Promise.reject('boom'));
		let err: unknown;
		try {
			await getServerStatus();
		} catch (e) {
			err = e;
		}
		expect(isProviderError(err)).toBe(true);
		expect((err as Error).message).toBe('boom');
	});
});

describe('liveBind (#459)', () => {
	const saved: ServerStatus = {
		enabled: true,
		running: true,
		bind: '127.0.0.1',
		port: 8721,
		viewerPublic: false,
		urls: [],
		qrSvgs: [],
		uiEmbedded: true
	};

	it('prefers the live listener over the saved bind', () => {
		expect(liveBind({ ...saved, live: { bind: '0.0.0.0', port: 8722 } })).toBe('0.0.0.0');
	});

	it('falls back to the saved bind when nothing serves or the host is older', () => {
		expect(liveBind({ ...saved, live: null })).toBe('127.0.0.1');
		expect(liveBind(saved)).toBe('127.0.0.1');
	});
});
