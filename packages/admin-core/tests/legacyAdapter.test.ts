import { describe, expect, it, vi } from 'vitest';
import { isProviderError } from '../src/errors';
import type { Identity, LegacyAuthProvider } from '../src/provider';
import { ADAPTER_REVISION, adaptLegacyAuthProvider } from '../src/providers/legacyAdapter';

/**
 * Issue #260 実装-1 (docs/design/session-controller-design.md §5.2 adapter table,
 * §8.2): `adaptLegacyAuthProvider` guarantees the SHAPE of the v2 contract
 * only. These tests pin down both what it guarantees and what it
 * deliberately does not (fixed revision, no notifications).
 */

function legacy(overrides: Partial<LegacyAuthProvider> = {}): LegacyAuthProvider {
	return {
		login: vi.fn(async () => ({ success: true })),
		logout: vi.fn(async () => {}),
		check: vi.fn(async () => true),
		getIdentity: vi.fn(async (): Promise<Identity | null> => ({ id: 'a', name: 'A' })),
		...overrides
	};
}

describe('adaptLegacyAuthProvider: guaranteed', () => {
	it('check() false resolves none without calling getIdentity()', async () => {
		const old = legacy({ check: vi.fn(async () => false) });
		const auth = adaptLegacyAuthProvider(old);

		await expect(auth.resolve()).resolves.toEqual({
			status: 'none',
			checked: ADAPTER_REVISION,
			current: ADAPTER_REVISION
		});
		expect(old.getIdentity).not.toHaveBeenCalled();
	});

	it('check() true + an identity resolves active', async () => {
		const auth = adaptLegacyAuthProvider(legacy());

		await expect(auth.resolve()).resolves.toEqual({
			status: 'active',
			checked: ADAPTER_REVISION,
			current: ADAPTER_REVISION,
			identity: { id: 'a', name: 'A' }
		});
	});

	it('check() true + getIdentity() null rejects (not an active session without identity)', async () => {
		const auth = adaptLegacyAuthProvider(legacy({ getIdentity: vi.fn(async () => null) }));

		await expect(auth.resolve()).rejects.toSatisfy(isProviderError);
	});

	it('a rejection of check() or getIdentity() rejects resolve()', async () => {
		const failure = new Error('500');
		await expect(
			adaptLegacyAuthProvider(
				legacy({ check: vi.fn(async () => Promise.reject(failure)) })
			).resolve()
		).rejects.toBe(failure);
		await expect(
			adaptLegacyAuthProvider(
				legacy({ getIdentity: vi.fn(async () => Promise.reject(failure)) })
			).resolve()
		).rejects.toBe(failure);
	});

	it('login/logout/setup/changePassword/status pass through', async () => {
		const old = legacy({
			status: vi.fn(async () => ({ initialized: true })),
			setup: vi.fn(async () => ({ success: false, error: 'x' })),
			changePassword: vi.fn(async () => ({ success: true }))
		});
		const auth = adaptLegacyAuthProvider(old);

		await expect(auth.login({ username: 'a' })).resolves.toEqual({ success: true });
		await auth.logout();
		await expect(auth.setup?.({ username: 'o' })).resolves.toEqual({ success: false, error: 'x' });
		await expect(auth.changePassword?.('a', 'b')).resolves.toEqual({ success: true });
		await expect(auth.status?.()).resolves.toEqual({ initialized: true });
		expect(auth.enterGrant).toBeUndefined();
		expect(old.login).toHaveBeenCalledWith({ username: 'a' });
		expect(old.logout).toHaveBeenCalledTimes(1);
		expect(old.changePassword).toHaveBeenCalledWith('a', 'b');
	});

	it('optional methods the legacy provider lacks stay absent', () => {
		const auth = adaptLegacyAuthProvider(legacy());

		expect(auth.status).toBeUndefined();
		expect(auth.setup).toBeUndefined();
		expect(auth.changePassword).toBeUndefined();
		expect(auth.enterGrant).toBeUndefined();
	});
});

describe('adaptLegacyAuthProvider: NOT guaranteed (pinned down)', () => {
	it('the revision is the constant ADAPTER_REVISION, before and after any operation', async () => {
		const auth = adaptLegacyAuthProvider(legacy());
		expect(auth.credentialRevision()).toBe(ADAPTER_REVISION);

		await auth.login({ username: 'b' });
		await auth.logout();
		const answer = await auth.resolve();

		expect(auth.credentialRevision()).toBe(ADAPTER_REVISION);
		expect(answer.checked).toBe(ADAPTER_REVISION);
		expect(answer.current).toBe(ADAPTER_REVISION);
	});

	it('onCredentialChanged accepts a listener but never calls it', async () => {
		const auth = adaptLegacyAuthProvider(legacy());
		const listener = vi.fn();
		const unsubscribe = auth.onCredentialChanged(listener);

		await auth.login({ username: 'b' });
		await auth.logout();
		await auth.resolve();
		unsubscribe();

		expect(listener).not.toHaveBeenCalled();
	});

	it('resolve() is two round trips: check() and getIdentity() are separate calls', async () => {
		const old = legacy();
		const auth = adaptLegacyAuthProvider(old);

		await auth.resolve();

		expect(old.check).toHaveBeenCalledTimes(1);
		expect(old.getIdentity).toHaveBeenCalledTimes(1);
	});
});
