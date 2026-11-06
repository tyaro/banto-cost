import { describe, expect, it, vi } from 'vitest';
import { isProviderError } from '../src/errors';
import { createTauriAuthProvider, createTauriDataProvider } from '../src/providers/tauri';

interface Item {
	id: number;
	name: string;
	price: number;
}

describe('createTauriDataProvider', () => {
	it('getList calls `${resource}_list` with { params }', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValue({ rows: [{ id: 1, name: 'a', price: 10 }], totalCount: 1 });
		const provider = createTauriDataProvider({ invoke });

		const params = { sort: [], filters: [], pagination: { offset: 0, limit: 10 } };
		const result = await provider.getList<Item>('items', params);

		expect(invoke).toHaveBeenCalledWith('items_list', { params });
		expect(result).toEqual({ rows: [{ id: 1, name: 'a', price: 10 }], totalCount: 1 });
	});

	it('getOne calls `${resource}_get` with { id }', async () => {
		const invoke = vi.fn().mockResolvedValue({ id: 1, name: 'a', price: 10 });
		const provider = createTauriDataProvider({ invoke });

		await provider.getOne<Item>('items', 1);

		expect(invoke).toHaveBeenCalledWith('items_get', { id: 1 });
	});

	it('create calls `${resource}_create` with { values }', async () => {
		const invoke = vi.fn().mockResolvedValue({ id: 1, name: 'a', price: 10 });
		const provider = createTauriDataProvider({ invoke });

		await provider.create<Item>('items', { name: 'a', price: 10 });

		expect(invoke).toHaveBeenCalledWith('items_create', { values: { name: 'a', price: 10 } });
	});

	it('update calls `${resource}_update` with { id, values }', async () => {
		const invoke = vi.fn().mockResolvedValue({ id: 1, name: 'a', price: 20 });
		const provider = createTauriDataProvider({ invoke });

		await provider.update<Item>('items', 1, { price: 20 });

		expect(invoke).toHaveBeenCalledWith('items_update', { id: 1, values: { price: 20 } });
	});

	it('deleteOne calls `${resource}_delete` with { id }', async () => {
		const invoke = vi.fn().mockResolvedValue(undefined);
		const provider = createTauriDataProvider({ invoke });

		await provider.deleteOne('items', 1);

		expect(invoke).toHaveBeenCalledWith('items_delete', { id: 1 });
	});

	it('rethrows a rejected invoke() carrying an ErrorBody as a ProviderError', async () => {
		const invoke = vi.fn().mockRejectedValue({ kind: 'not_found', resource: 'items', id: '42' });
		const provider = createTauriDataProvider({ invoke });

		try {
			await provider.getOne('items', 42);
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) {
				expect(err.body).toEqual({ kind: 'not_found', resource: 'items', id: '42' });
			}
		}
	});

	it('rethrows every ErrorBody kind faithfully', async () => {
		const bodies = [
			{ kind: 'not_found', resource: 'items', id: '1' },
			{ kind: 'validation', field_errors: [{ field: 'name', message: '必須項目です' }] },
			{ kind: 'unauthorized' },
			{ kind: 'forbidden' },
			{ kind: 'storage', message: 'db is locked' },
			{ kind: 'other', message: 'boom' }
		];

		for (const body of bodies) {
			const invoke = vi.fn().mockRejectedValue(body);
			const provider = createTauriDataProvider({ invoke });
			try {
				await provider.getOne('items', 1);
				expect.unreachable('expected a ProviderError to be thrown');
			} catch (err) {
				expect(isProviderError(err)).toBe(true);
				if (isProviderError(err)) expect(err.body).toEqual(body);
			}
		}
	});

	it('wraps a non-conforming rejection as ProviderError kind "other"', async () => {
		const invoke = vi.fn().mockRejectedValue(new Error('network exploded'));
		const provider = createTauriDataProvider({ invoke });

		try {
			await provider.getOne('items', 1);
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) {
				expect(err.body.kind).toBe('other');
				expect(err.body).toMatchObject({ kind: 'other', message: 'network exploded' });
			}
		}
	});

	it('wraps a rejected plain string/object without a recognized `kind`', async () => {
		const invoke = vi.fn().mockRejectedValue('plain string failure');
		const provider = createTauriDataProvider({ invoke });

		try {
			await provider.getOne('items', 1);
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err))
				expect(err.body).toEqual({ kind: 'other', message: 'plain string failure' });
		}
	});
});

describe('createTauriAuthProvider', () => {
	it('login calls auth_login with the given params', async () => {
		const invoke = vi.fn().mockResolvedValue({ success: true });
		const provider = createTauriAuthProvider({ invoke });

		const result = await provider.login({ username: 'admin', password: 'admin' });

		expect(invoke).toHaveBeenCalledWith('auth_login', { username: 'admin', password: 'admin' });
		expect(result).toEqual({ success: true });
	});

	it('login surfaces a failure result without throwing', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValue({ success: false, error: 'ユーザー名またはパスワードが違います' });
		const provider = createTauriAuthProvider({ invoke });

		const result = await provider.login({ username: 'admin', password: 'wrong' });

		expect(result).toEqual({ success: false, error: 'ユーザー名またはパスワードが違います' });
	});

	it('logout calls auth_logout with no args', async () => {
		const invoke = vi.fn().mockResolvedValue(undefined);
		const provider = createTauriAuthProvider({ invoke });

		await provider.logout();

		expect(invoke).toHaveBeenCalledWith('auth_logout', undefined);
	});

	// v2.0.0 (design §5.4): no check()/getIdentity() - resolve() asks
	// `auth_resolve` once (tauriRevision.test.ts has the revision cases).
	it('has no check()/getIdentity(); resolve() passes the identity and role through (spec M10 RBAC)', async () => {
		const invoke = vi.fn().mockResolvedValue({
			identity: { id: 'owner', name: 'オーナー', role: 'admin' },
			kind: 'account',
			checked: 1,
			current: 1,
			stale: false
		});
		const provider = createTauriAuthProvider({ invoke });

		expect('check' in provider).toBe(false);
		expect('getIdentity' in provider).toBe(false);
		await expect(provider.resolve()).resolves.toMatchObject({
			status: 'active',
			kind: 'account',
			identity: { id: 'owner', name: 'オーナー', role: 'admin' }
		});
		expect(invoke).toHaveBeenCalledWith('auth_resolve', undefined);
	});

	it('resolve() maps a null identity (logged out) to none', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValue({ identity: null, kind: null, checked: 2, current: 2, stale: false });
		const provider = createTauriAuthProvider({ invoke });

		await expect(provider.resolve()).resolves.toMatchObject({ status: 'none' });
	});

	it('a rejected invoke() carrying a forbidden ErrorBody (spec M10 RBAC) rethrows faithfully', async () => {
		const invoke = vi.fn().mockRejectedValue({ kind: 'forbidden' });
		const provider = createTauriDataProvider({ invoke });

		try {
			await provider.deleteOne('users', 1);
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) {
				expect(err.body).toEqual({ kind: 'forbidden' });
				expect(err.message).toBe('この操作を行う権限がありません');
			}
		}
	});

	it('status calls auth_status and returns its initialized flag', async () => {
		const invoke = vi.fn().mockResolvedValue({ initialized: false });
		const provider = createTauriAuthProvider({ invoke });

		await expect(provider.status?.()).resolves.toEqual({ initialized: false });
		expect(invoke).toHaveBeenCalledWith('auth_status', undefined);
	});

	it('setup calls auth_setup with the given params and returns the result on success', async () => {
		const invoke = vi.fn().mockResolvedValue({ success: true });
		const provider = createTauriAuthProvider({ invoke });

		const result = await provider.setup?.({
			username: 'owner',
			password: 'password123',
			displayName: 'オーナー'
		});

		expect(invoke).toHaveBeenCalledWith('auth_setup', {
			username: 'owner',
			password: 'password123',
			displayName: 'オーナー'
		});
		expect(result).toEqual({ success: true });
	});

	it('setup maps a rejected validation ErrorBody to { success: false, error: <first field message> }', async () => {
		const invoke = vi.fn().mockRejectedValue({
			kind: 'validation',
			field_errors: [{ field: 'password', message: 'パスワードは8文字以上で入力してください' }]
		});
		const provider = createTauriAuthProvider({ invoke });

		const result = await provider.setup?.({
			username: 'owner',
			password: 'short',
			displayName: 'オーナー'
		});

		expect(result).toEqual({ success: false, error: 'パスワードは8文字以上で入力してください' });
	});

	it('changePassword calls auth_change_password with camelCase args and returns success', async () => {
		const invoke = vi.fn().mockResolvedValue(undefined);
		const provider = createTauriAuthProvider({ invoke });

		const result = await provider.changePassword?.('old-password', 'new-password1');

		expect(invoke).toHaveBeenCalledWith('auth_change_password', {
			currentPassword: 'old-password',
			newPassword: 'new-password1'
		});
		expect(result).toEqual({ success: true });
	});

	it('changePassword maps a rejected validation ErrorBody to { success: false, error: <first field message> }', async () => {
		const invoke = vi.fn().mockRejectedValue({
			kind: 'validation',
			field_errors: [{ field: 'currentPassword', message: '現在のパスワードが違います' }]
		});
		const provider = createTauriAuthProvider({ invoke });

		const result = await provider.changePassword?.('wrong', 'new-password1');

		expect(result).toEqual({ success: false, error: '現在のパスワードが違います' });
	});
});
