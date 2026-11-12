import { initBanto, type CredentialRevision, type DataProvider } from '@banto/admin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES, getUserCapabilities, setUserCapabilities } from './capabilitiesAdmin';

/**
 * 能力（設計案 第2章）の読み書きは、LAN では GET/PUT /api/users/{id}/capabilities、
 * Tauri では authz_capabilities_get / authz_capabilities_set を呼ぶ。
 */
const setupMock = vi.hoisted(() => ({
	mode: 'server' as 'demo' | 'server' | 'tauri',
	signalUnauthorized: vi.fn()
}));
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./setup', () => ({
	CSRF_HEADER: { 'X-Banto-Client': 'banto' },
	getBantoMode: () => setupMock.mode,
	signalUnauthorized: setupMock.signalUnauthorized
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

beforeEach(() => {
	initBanto({
		dataProvider: {} as DataProvider,
		authProvider: {
			login: async () => ({ success: true }),
			logout: async () => {},
			resolve: async () => ({
				status: 'none',
				checked: '0.0' as CredentialRevision,
				current: '0.0' as CredentialRevision
			}),
			credentialRevision: () => '0.0' as CredentialRevision,
			onCredentialChanged: () => () => {}
		},
		resources: []
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	invokeMock.mockReset();
	setupMock.mode = 'server';
});

describe('能力の読み書き', () => {
	it('7つの能力を設計案の表の順に並べる', () => {
		expect(CAPABILITIES).toEqual([
			'time.entry',
			'pipeline.edit',
			'project.manage',
			'finance.rate',
			'finance.close',
			'report.all',
			'amount.view'
		]);
	});

	it('LAN：GET と PUT /api/users/{id}/capabilities を呼ぶ', async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify(['amount.view']), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);
		await expect(getUserCapabilities(3)).resolves.toEqual(['amount.view']);
		await setUserCapabilities(3, ['amount.view']);
		const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
		expect(calls[0][0]).toBe('/api/users/3/capabilities');
		expect(calls[0][1].method).toBe('GET');
		expect(calls[1][0]).toBe('/api/users/3/capabilities');
		expect(calls[1][1].method).toBe('PUT');
		expect(JSON.parse(String(calls[1][1].body))).toEqual({ capabilities: ['amount.view'] });
	});

	it('Tauri：authz_capabilities_get / authz_capabilities_set を呼ぶ', async () => {
		setupMock.mode = 'tauri';
		invokeMock.mockResolvedValue(['time.entry']);
		await getUserCapabilities(1);
		await setUserCapabilities(1, ['time.entry']);
		expect(invokeMock).toHaveBeenNthCalledWith(1, 'authz_capabilities_get', { id: 1 });
		expect(invokeMock).toHaveBeenNthCalledWith(2, 'authz_capabilities_set', {
			id: 1,
			capabilities: ['time.entry']
		});
	});

	it('デモモードでは呼ばずに断る', async () => {
		setupMock.mode = 'demo';
		await expect(getUserCapabilities(1)).rejects.toMatchObject({
			body: { message: 'デモモードでは利用できません' }
		});
		expect(invokeMock).not.toHaveBeenCalled();
	});
});
