import { initBanto, type CredentialRevision, type DataProvider } from '@banto/admin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #248: `listAuditLog` carries the snapshot boundary on both paths -
 * REST as `?asOfId=` (the body stays `ListParams`), Tauri as the command's
 * `asOfId` argument - and leaves it out entirely when there is none, so the
 * server answers exactly as before (and runs its retention prune).
 */
const setupMock = vi.hoisted(() => ({ mode: 'server' as 'demo' | 'server' | 'tauri' }));
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/banto/setup.js', () => ({
	CSRF_HEADER: { 'X-Banto-Client': 'banto' },
	getBantoMode: () => setupMock.mode
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const params = {
	pagination: { offset: 200, limit: 200 },
	sort: [{ field: 'ts', direction: 'desc' as const }],
	filters: []
};
const answer = { rows: [], totalCount: 0, asOfId: 0 };

afterEach(() => {
	vi.unstubAllGlobals();
	invokeMock.mockReset();
});

describe('listAuditLog (Issue #248)', () => {
	it.each([
		['without a boundary', null, '/api/audit-log/list'],
		['with a boundary', 42, '/api/audit-log/list?asOfId=42']
	])('REST %s', async (_name, asOfId, path) => {
		setupMock.mode = 'server';
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
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const { listAuditLog } = await import('./auditLogAdmin');
		const controller = new AbortController();

		await expect(listAuditLog(params, asOfId, controller.signal)).resolves.toEqual(answer);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(path);
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual(params);
		expect(init.signal).toBe(controller.signal);
	});

	it.each([
		['without a boundary', null, { params }],
		['with a boundary', 42, { params, asOfId: 42 }]
	])('Tauri %s', async (_name, asOfId, args) => {
		setupMock.mode = 'tauri';
		invokeMock.mockResolvedValue(answer);
		const { listAuditLog } = await import('./auditLogAdmin');

		await expect(listAuditLog(params, asOfId)).resolves.toEqual(answer);
		expect(invokeMock).toHaveBeenCalledWith('audit_log_list', args);
	});
});
