import { describe, expect, it } from 'vitest';
import { validation } from '../src/errors';
import { createFormResource } from '../src/form.svelte';
import type { AuthProvider, DataProvider } from '../src/provider';
import { initBanto } from '../src/registry.svelte';
import { STUB_SESSION } from './stubAuth';

const authProvider: AuthProvider = {
	login: async () => ({ success: true }),
	logout: async () => {},
	...STUB_SESSION
};

function unusedProvider(overrides: Partial<DataProvider> = {}): DataProvider {
	return {
		getList: async () => ({ rows: [], totalCount: 0 }),
		getOne: async () => {
			throw new Error('unused');
		},
		create: async () => {
			throw new Error('unused');
		},
		update: async () => {
			throw new Error('unused');
		},
		deleteOne: async () => {},
		...overrides
	};
}

describe('createFormResource', () => {
	it('load() with no id sets empty initialValues', async () => {
		initBanto({
			dataProvider: unusedProvider(),
			authProvider,
			resources: [{ name: 'items', label: 'Items' }]
		});
		const form = createFormResource('items');
		await form.load();
		expect(form.initialValues).toEqual({});
	});

	it('load() with an id fetches the row via getOne', async () => {
		initBanto({
			dataProvider: unusedProvider({ getOne: async <T>() => ({ id: 1, name: 'a' }) as T }),
			authProvider,
			resources: [{ name: 'items', label: 'Items' }]
		});
		const form = createFormResource('items', 1);
		await form.load();
		expect(form.initialValues).toEqual({ id: 1, name: 'a' });
	});

	it('load() catches a not-found error without throwing', async () => {
		initBanto({
			dataProvider: unusedProvider(),
			authProvider,
			resources: [{ name: 'items', label: 'Items' }]
		});
		const form = createFormResource('items', 999);
		await form.load();
		expect(form.initialValues).toBeNull();
		expect(form.error?.body.kind).toBe('other'); // unusedProvider's getOne throws a plain Error
	});

	it('submit() calls create when there is no id and notifies success', async () => {
		const seen: { kind: string; message: string }[] = [];
		const created = { id: 1, name: 'a' };
		initBanto({
			dataProvider: unusedProvider({ create: async <T>() => created as T }),
			authProvider,
			resources: [{ name: 'items', label: 'Items' }],
			notifier: { notify: (kind, message) => seen.push({ kind, message }) }
		});

		const form = createFormResource('items');
		const result = await form.submit({ name: 'a' });

		expect(result).toEqual({ ok: true, row: created });
		expect(seen).toEqual([{ kind: 'success', message: '保存しました' }]);
	});

	it('submit() calls update when an id is present', async () => {
		let calledWith: unknown;
		initBanto({
			dataProvider: unusedProvider({
				update: async <T>(
					_resource: string,
					id: string | number,
					values: Record<string, unknown>
				) => {
					calledWith = { id, values };
					return { id, ...values } as T;
				}
			}),
			authProvider,
			resources: [{ name: 'items', label: 'Items' }]
		});

		const form = createFormResource('items', 42);
		await form.submit({ name: 'b' });
		expect(calledWith).toEqual({ id: 42, values: { name: 'b' } });
	});

	it('submit() surfaces field errors on validation failure without throwing', async () => {
		initBanto({
			dataProvider: unusedProvider({
				create: async () => {
					throw validation([{ field: 'name', message: '必須項目です' }]);
				}
			}),
			authProvider,
			resources: [{ name: 'items', label: 'Items' }]
		});

		const form = createFormResource('items');
		const result = await form.submit({ name: '' });
		expect(result).toEqual({
			ok: false,
			fieldErrors: [{ field: 'name', message: '必須項目です' }]
		});
	});

	it('submit() notifies and returns empty fieldErrors for non-validation errors', async () => {
		const seen: { kind: string; message: string }[] = [];
		initBanto({
			dataProvider: unusedProvider({
				create: async () => {
					throw new Error('network down');
				}
			}),
			authProvider,
			resources: [{ name: 'items', label: 'Items' }],
			notifier: { notify: (kind, message) => seen.push({ kind, message }) }
		});

		const form = createFormResource('items');
		const result = await form.submit({ name: 'a' });
		expect(result).toEqual({ ok: false, fieldErrors: [] });
		expect(seen).toEqual([{ kind: 'error', message: 'Error: network down' }]);
	});

	it('remove() deletes, notifies, and returns true; false without an id', async () => {
		const seen: { kind: string; message: string }[] = [];
		let deletedId: unknown;
		initBanto({
			dataProvider: unusedProvider({
				deleteOne: async (_resource, id) => {
					deletedId = id;
				}
			}),
			authProvider,
			resources: [{ name: 'items', label: 'Items' }],
			notifier: { notify: (kind, message) => seen.push({ kind, message }) }
		});

		const withoutId = createFormResource('items');
		expect(await withoutId.remove()).toBe(false);

		const withId = createFormResource('items', 7);
		expect(await withId.remove()).toBe(true);
		expect(deletedId).toBe(7);
		expect(seen).toEqual([{ kind: 'success', message: '削除しました' }]);
	});
});
