import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/errors';
import { invalidate } from '../src/invalidate';
import { createListResource } from '../src/list.svelte';
import { createInMemoryDataProvider } from '../src/providers/inMemory';
import type { AuthProvider, DataProvider } from '../src/provider';
import { initBanto } from '../src/registry.svelte';
import { STUB_SESSION } from './stubAuth';

const authProvider: AuthProvider = {
	login: async () => ({ success: true }),
	logout: async () => {},
	...STUB_SESSION
};

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createListResource', () => {
	it('load populates rows/totalCount and toggles loading', async () => {
		const dataProvider = createInMemoryDataProvider(
			{
				items: {
					rows: [
						{ id: 1, name: 'a' },
						{ id: 2, name: 'b' }
					]
				}
			},
			{ latencyMs: 0 }
		);
		initBanto({ dataProvider, authProvider, resources: [{ name: 'items', label: 'Items' }] });

		const list = createListResource<{ id: number; name: string }>('items');
		expect(list.loading).toBe(false);
		const promise = list.load();
		expect(list.loading).toBe(true);
		await promise;
		expect(list.loading).toBe(false);
		expect(list.rows).toHaveLength(2);
		expect(list.totalCount).toBe(2);
		list.dispose();
	});

	it('reloads automatically when the resource is invalidated', async () => {
		const dataProvider = createInMemoryDataProvider(
			{ 'items-reload': { rows: [{ id: 1, name: 'a' }] } },
			{ latencyMs: 0 }
		);
		initBanto({
			dataProvider,
			authProvider,
			resources: [{ name: 'items-reload', label: 'Items' }]
		});

		const list = createListResource<{ id: number; name: string }>('items-reload');
		await list.load();
		expect(list.rows).toHaveLength(1);

		await dataProvider.create('items-reload', { name: 'b' }); // mutating directly does not auto-invalidate
		invalidate('items-reload');
		await tick(); // let the invalidate-triggered load() resolve

		expect(list.rows).toHaveLength(2);
		list.dispose();
	});

	it('dispose stops further invalidate-triggered reloads', async () => {
		const dataProvider = createInMemoryDataProvider(
			{ 'items-dispose': { rows: [{ id: 1, name: 'a' }] } },
			{ latencyMs: 0 }
		);
		initBanto({
			dataProvider,
			authProvider,
			resources: [{ name: 'items-dispose', label: 'Items' }]
		});

		const list = createListResource<{ id: number; name: string }>('items-dispose');
		await list.load();
		list.dispose();

		await dataProvider.create('items-dispose', { name: 'b' });
		invalidate('items-dispose');
		await tick();

		expect(list.rows).toHaveLength(1); // unchanged: no reload happened after dispose
	});

	it('a stale (out-of-order) resolution does not overwrite a newer load()', async () => {
		// Known race (M5): two rapid invalidates each call load(); if the
		// *first* call's promise resolves *after* the second one's, its
		// stale result must not clobber the fresher rows/totalCount.
		let resolveFirst!: (rows: { id: number; name: string }[]) => void;
		let resolveSecond!: (rows: { id: number; name: string }[]) => void;
		let call = 0;
		const dataProvider: DataProvider = {
			getList: <T>(): Promise<{ rows: T[]; totalCount: number }> =>
				new Promise((resolve) => {
					call++;
					const settle = (rows: { id: number; name: string }[]) =>
						resolve({ rows: rows as T[], totalCount: rows.length });
					if (call === 1) {
						resolveFirst = settle;
					} else {
						resolveSecond = settle;
					}
				}),
			getOne: async () => {
				throw new Error('unused');
			},
			create: async () => {
				throw new Error('unused');
			},
			update: async () => {
				throw new Error('unused');
			},
			deleteOne: async () => {}
		};
		initBanto({ dataProvider, authProvider, resources: [{ name: 'items-race', label: 'Items' }] });

		const list = createListResource<{ id: number; name: string }>('items-race');
		const firstLoad = list.load();
		const secondLoad = list.load();

		// Second (newer) call resolves first...
		resolveSecond([{ id: 2, name: 'second' }]);
		await secondLoad;
		expect(list.rows).toEqual([{ id: 2, name: 'second' }]);

		// ...then the first (stale) call resolves; it must be ignored.
		resolveFirst([{ id: 1, name: 'first' }]);
		await firstLoad;
		expect(list.rows).toEqual([{ id: 2, name: 'second' }]);
		expect(list.loading).toBe(false);
		list.dispose();
	});

	it('load() catches provider errors, stores them, and notifies', async () => {
		const seen: { kind: string; message: string }[] = [];
		const dataProvider: DataProvider = {
			getList: async () => {
				throw new ProviderError({ kind: 'other', message: 'boom' });
			},
			getOne: async () => {
				throw new Error('unused');
			},
			create: async () => {
				throw new Error('unused');
			},
			update: async () => {
				throw new Error('unused');
			},
			deleteOne: async () => {}
		};
		initBanto({
			dataProvider,
			authProvider,
			resources: [{ name: 'items-error', label: 'Items' }],
			notifier: { notify: (kind, message) => seen.push({ kind, message }) }
		});

		const list = createListResource('items-error');
		await list.load();

		expect(list.error).not.toBeNull();
		expect(list.error?.body.kind).toBe('other');
		expect(seen).toEqual([{ kind: 'error', message: 'boom' }]);
		list.dispose();
	});
});
