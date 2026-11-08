import { initBanto, type CredentialRevision, type DataProvider } from '@banto/admin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * テンプレートの管理 API（利用者・監査ログ・バックアップ・システム情報・
 * 認証設定・サーバー設定）も、業務 API（pipelineAdmin.ts）と同じく 401 で
 * セッションの確認を求める（signalUnauthorized）。403 など他の失敗では求めない。
 */
const setupMock = vi.hoisted(() => ({
	mode: 'server' as 'demo' | 'server' | 'tauri',
	signalUnauthorized: vi.fn()
}));
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/banto/setup.js', () => ({
	CSRF_HEADER: { 'X-Banto-Client': 'banto' },
	getBantoMode: () => setupMock.mode,
	signalUnauthorized: setupMock.signalUnauthorized
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/app', () => ({ getIdentifier: async () => 'test' }));

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
	setupMock.signalUnauthorized.mockReset();
});

function errorResponse(status: number, kind: string): Response {
	return new Response(JSON.stringify({ kind, message: 'x' }), { status });
}

const restCalls: [string, () => Promise<unknown>][] = [
	['利用者一覧', async () => (await import('./usersAdmin')).listUsers()],
	['監査ログの設定', async () => (await import('./auditLogAdmin')).getAuditConfig()],
	['システム情報', async () => (await import('./systemAdmin')).getSystemInfo()],
	['バックアップ一覧', async () => (await import('./backupsAdmin')).listBackups()],
	[
		'バックアップのダウンロード',
		async () => (await import('./backupsAdmin')).downloadBackup('a.db')
	]
];

const tauriCalls: [string, () => Promise<unknown>][] = [
	['利用者一覧', async () => (await import('./usersAdmin')).listUsers()],
	['監査ログの設定', async () => (await import('./auditLogAdmin')).getAuditConfig()],
	['システム情報', async () => (await import('./systemAdmin')).getSystemInfo()],
	['バックアップ一覧', async () => (await import('./backupsAdmin')).listBackups()],
	['認証設定', async () => (await import('./authAdmin')).getAuthSettings()],
	['サーバー設定', async () => (await import('./serverAdmin')).getServerStatus()]
];

describe('管理 API の 401（REST）', () => {
	it.each(restCalls)('%s：401 でセッションの確認を求める', async (_name, call) => {
		setupMock.mode = 'server';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => errorResponse(401, 'unauthorized'))
		);
		await expect(call()).rejects.toMatchObject({ body: { kind: 'unauthorized' } });
		expect(setupMock.signalUnauthorized).toHaveBeenCalledTimes(1);
	});

	it.each(restCalls)('%s：403 では求めない', async (_name, call) => {
		setupMock.mode = 'server';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => errorResponse(403, 'forbidden'))
		);
		await expect(call()).rejects.toMatchObject({ body: { kind: 'forbidden' } });
		expect(setupMock.signalUnauthorized).not.toHaveBeenCalled();
	});
});

describe('管理 API の unauthorized（Tauri）', () => {
	it.each(tauriCalls)('%s：unauthorized でセッションの確認を求める', async (_name, call) => {
		setupMock.mode = 'tauri';
		invokeMock.mockRejectedValue({ kind: 'unauthorized', message: 'x' });
		await expect(call()).rejects.toMatchObject({ body: { kind: 'unauthorized' } });
		expect(setupMock.signalUnauthorized).toHaveBeenCalledTimes(1);
	});

	it.each(tauriCalls)('%s：forbidden では求めない', async (_name, call) => {
		setupMock.mode = 'tauri';
		invokeMock.mockRejectedValue({ kind: 'forbidden', message: 'x' });
		await expect(call()).rejects.toMatchObject({ body: { kind: 'forbidden' } });
		expect(setupMock.signalUnauthorized).not.toHaveBeenCalled();
	});
});
