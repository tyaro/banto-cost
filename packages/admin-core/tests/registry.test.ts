import { describe, expect, it } from 'vitest';
import {
	getAuthProvider,
	getDataProvider,
	getResource,
	initBanto,
	listResources,
	notify
} from '../src/registry.svelte';
import type {
	AuthProvider,
	CredentialRevision,
	DataProvider,
	Notifier,
	ResolvedAuth
} from '../src/provider';
import { adaptLegacyAuthProvider } from '../src/providers/legacyAdapter';
import { STUB_SESSION } from './stubAuth';

function makeProviders(): { dataProvider: DataProvider; authProvider: AuthProvider } {
	const dataProvider: DataProvider = {
		getList: async () => ({ rows: [], totalCount: 0 }),
		getOne: async () => ({}) as never,
		create: async () => ({}) as never,
		update: async () => ({}) as never,
		deleteOne: async () => {}
	};
	const authProvider: AuthProvider = {
		login: async () => ({ success: true }),
		logout: async () => {},
		...STUB_SESSION
	};
	return { dataProvider, authProvider };
}

describe('registry', () => {
	// Must run before any initBanto() call in this file/module instance.
	it('throws a helpful error before initBanto is called', () => {
		expect(() => getDataProvider()).toThrow(/initBanto/);
		expect(() => getAuthProvider()).toThrow(/initBanto/);
	});

	it('registers providers/resources and exposes them', () => {
		const { dataProvider, authProvider } = makeProviders();
		initBanto({
			dataProvider,
			authProvider,
			resources: [{ name: 'items', label: '商品' }]
		});

		expect(getDataProvider()).toBe(dataProvider);
		expect(getAuthProvider()).toBe(authProvider);
		expect(getResource('items').label).toBe('商品');
		expect(listResources()).toHaveLength(1);
	});

	// Issue #215/#255 (4th review): initBanto stores the AuthProvider exactly
	// as given - no wrapper. Earlier rounds of #255 wrapped it (a shallow
	// copy, then a Proxy) to hook login/logout, which broke class-based
	// providers, `this`-sharing providers and - via the Proxy invariants -
	// frozen ones. These pin every shape so a wrapper cannot come back
	// unnoticed.
	describe('keeps the AuthProvider as given (#215/#255)', () => {
		const { dataProvider } = makeProviders();

		it('a frozen object provider', async () => {
			const authProvider: AuthProvider = Object.freeze({
				login: async () => ({ success: true }),
				logout: async () => {},
				...STUB_SESSION
			});
			initBanto({ dataProvider, authProvider, resources: [] });
			expect(getAuthProvider()).toBe(authProvider);
			await expect(getAuthProvider().resolve()).resolves.toMatchObject({ status: 'none' });
			await expect(getAuthProvider().logout()).resolves.toBeUndefined();
		});

		it('a class-based provider (prototype methods, state on `this`)', async () => {
			const revision = '1.0' as CredentialRevision;
			class MyAuth implements AuthProvider {
				private signedIn = false;
				async login() {
					this.signedIn = true;
					return { success: true };
				}
				async logout() {
					this.signedIn = false;
				}
				async resolve(): Promise<ResolvedAuth> {
					return this.signedIn
						? {
								status: 'active',
								checked: revision,
								current: revision,
								identity: { id: 'alice', name: 'Alice' }
							}
						: { status: 'none', checked: revision, current: revision };
				}
				credentialRevision() {
					return revision;
				}
				onCredentialChanged() {
					return () => {};
				}
			}
			const authProvider = new MyAuth();
			initBanto({ dataProvider, authProvider, resources: [] });
			expect(getAuthProvider()).toBe(authProvider);
			await getAuthProvider().login({});
			await expect(getAuthProvider().resolve()).resolves.toMatchObject({
				status: 'active',
				identity: { id: 'alice', name: 'Alice' }
			});
		});

		it('a plain object sharing state through `this`', async () => {
			const revision = '1.0' as CredentialRevision;
			const authProvider = {
				signedIn: false,
				async login() {
					this.signedIn = true;
					return { success: true };
				},
				async logout() {
					this.signedIn = false;
				},
				async resolve(): Promise<ResolvedAuth> {
					return this.signedIn
						? {
								status: 'active',
								checked: revision,
								current: revision,
								identity: { id: 'alice', name: 'Alice' }
							}
						: { status: 'none', checked: revision, current: revision };
				},
				credentialRevision: () => revision,
				onCredentialChanged: () => () => {}
			};
			initBanto({ dataProvider, authProvider, resources: [] });
			await getAuthProvider().login({});
			await expect(getAuthProvider().resolve()).resolves.toMatchObject({ status: 'active' });
			await getAuthProvider().logout();
			await expect(getAuthProvider().resolve()).resolves.toMatchObject({ status: 'none' });
		});
	});

	// Issue #260 実装-3 (design §5.2, owner decision 2): the three methods are
	// required. A pre-v2 provider is not silently adapted any more.
	it('rejects a provider without resolve/credentialRevision/onCredentialChanged, replacing nothing', () => {
		const { dataProvider, authProvider } = makeProviders();
		initBanto({ dataProvider, authProvider, resources: [] });
		const legacy = {
			login: async () => ({ success: true }),
			logout: async () => {},
			check: async () => true,
			getIdentity: async () => null
		};
		expect(() =>
			initBanto({
				dataProvider,
				authProvider: legacy as unknown as AuthProvider,
				resources: []
			})
		).toThrow(TypeError);
		expect(getAuthProvider()).toBe(authProvider);
	});

	it('accepts a pre-v2 provider wrapped in adaptLegacyAuthProvider', async () => {
		const { dataProvider } = makeProviders();
		const authProvider = adaptLegacyAuthProvider({
			login: async () => ({ success: true }),
			logout: async () => {},
			check: async () => false,
			getIdentity: async () => null
		});
		initBanto({ dataProvider, authProvider, resources: [] });
		await expect(getAuthProvider().resolve()).resolves.toMatchObject({ status: 'none' });
	});

	it('getResource throws for an unknown resource', () => {
		const { dataProvider, authProvider } = makeProviders();
		initBanto({ dataProvider, authProvider, resources: [] });
		expect(() => getResource('missing')).toThrow(/missing/);
	});

	it('notify is a no-op without a notifier and forwards to one when set', () => {
		const { dataProvider, authProvider } = makeProviders();
		const seen: { kind: string; message: string }[] = [];
		const notifier: Notifier = { notify: (kind, message) => seen.push({ kind, message }) };

		initBanto({ dataProvider, authProvider, resources: [] });
		expect(() => notify('success', 'ignored')).not.toThrow();

		initBanto({ dataProvider, authProvider, resources: [], notifier });
		notify('success', 'ok');
		expect(seen).toEqual([{ kind: 'success', message: 'ok' }]);
	});
});
