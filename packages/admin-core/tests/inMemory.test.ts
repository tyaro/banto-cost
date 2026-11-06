import { describe, expect, it } from 'vitest';
import { isProviderError } from '../src/errors';
import { createInMemoryDataProvider } from '../src/providers/inMemory';

interface Item {
	id: number;
	name: string;
	price: number;
	updatedAt?: string;
	// Index signature so test fixtures satisfy InMemorySeed's
	// `Record<string, unknown>[]` row type.
	[key: string]: unknown;
}

function seedItems(): Item[] {
	return [
		{ id: 1, name: 'Green Tea', price: 140, updatedAt: '2024-01-01' },
		{ id: 2, name: 'Coffee', price: 130, updatedAt: '2024-01-02' },
		{ id: 3, name: 'Black Tea', price: 160, updatedAt: '2024-01-03' }
	];
}

async function expectNotFound(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
		expect.unreachable('expected a ProviderError to be thrown');
	} catch (err) {
		expect(isProviderError(err)).toBe(true);
		if (isProviderError(err)) expect(err.body.kind).toBe('not_found');
	}
}

describe('createInMemoryDataProvider', () => {
	it('getList filters, sorts, and paginates; totalCount reflects the pre-pagination filtered length', async () => {
		const provider = createInMemoryDataProvider({ items: { rows: seedItems() } }, { latencyMs: 0 });

		const result = await provider.getList<Item>('items', {
			sort: [{ field: 'price', direction: 'asc' }],
			filters: [{ field: 'name', op: 'contains', value: 'tea' }],
			pagination: { offset: 0, limit: 1 }
		});

		expect(result.totalCount).toBe(2); // "Green Tea" and "Black Tea" both contain "tea"
		expect(result.rows).toEqual([
			{ id: 1, name: 'Green Tea', price: 140, updatedAt: '2024-01-01' }
		]);
	});

	it('getList with no pagination returns all matching rows', async () => {
		const provider = createInMemoryDataProvider({ items: { rows: seedItems() } }, { latencyMs: 0 });
		const result = await provider.getList<Item>('items', { sort: [], filters: [] });
		expect(result.rows).toHaveLength(3);
		expect(result.totalCount).toBe(3);
	});

	it('sorts numerically by a numeric field', async () => {
		const provider = createInMemoryDataProvider({ items: { rows: seedItems() } }, { latencyMs: 0 });
		const result = await provider.getList<Item>('items', {
			sort: [{ field: 'price', direction: 'desc' }],
			filters: []
		});
		expect(result.rows.map((row) => row.id)).toEqual([3, 1, 2]);
	});

	it('create assigns the next numeric id and stamps updatedAt when the seed uses it', async () => {
		const provider = createInMemoryDataProvider({ items: { rows: seedItems() } }, { latencyMs: 0 });
		const created = await provider.create<Item>('items', { name: 'New Tea', price: 150 });
		expect(created.id).toBe(4);
		expect(created.updatedAt).toBeTruthy();
	});

	it('create does not stamp updatedAt when the resource has no such field', async () => {
		const provider = createInMemoryDataProvider(
			{ plain: { rows: [{ id: 1, name: 'a' }] } },
			{ latencyMs: 0 }
		);
		const created = await provider.create<Record<string, unknown>>('plain', { name: 'b' });
		expect(created.updatedAt).toBeUndefined();
	});

	it('update merges values and refreshes updatedAt', async () => {
		const provider = createInMemoryDataProvider({ items: { rows: seedItems() } }, { latencyMs: 0 });
		const updated = await provider.update<Item>('items', 2, { price: 999 });
		expect(updated.price).toBe(999);
		expect(updated.name).toBe('Coffee'); // untouched fields survive the merge
		expect(updated.updatedAt).not.toBe('2024-01-02');
	});

	it('getOne/update/deleteOne throw ProviderError(not_found) for a missing id', async () => {
		const provider = createInMemoryDataProvider({ items: { rows: seedItems() } }, { latencyMs: 0 });
		await expectNotFound(provider.getOne('items', 999));
		await expectNotFound(provider.update('items', 999, {}));
		await expectNotFound(provider.deleteOne('items', 999));
	});

	it('deleteOne removes the row', async () => {
		const provider = createInMemoryDataProvider({ items: { rows: seedItems() } }, { latencyMs: 0 });
		await provider.deleteOne('items', 1);
		const result = await provider.getList<Item>('items', { sort: [], filters: [] });
		expect(result.rows.map((row) => row.id)).toEqual([2, 3]);
	});

	it('matches ids loosely across string/number (URL params arrive as strings)', async () => {
		const provider = createInMemoryDataProvider({ items: { rows: seedItems() } }, { latencyMs: 0 });
		const row = await provider.getOne<Item>('items', '2');
		expect(row.name).toBe('Coffee');
	});

	// Comparator drift fix (M5): toComparable/compareNonNull must handle
	// Date-valued fields the same way grid-svelte's core/filter.ts and
	// core/sort.ts do.
	interface DatedItem {
		id: number;
		label: string;
		createdAt: Date;
		[key: string]: unknown;
	}

	function seedDatedItems(): DatedItem[] {
		return [
			{ id: 1, label: 'oldest', createdAt: new Date('2024-01-01') },
			{ id: 2, label: 'newest', createdAt: new Date('2024-06-01') },
			{ id: 3, label: 'middle', createdAt: new Date('2024-03-01') }
		];
	}

	it('sorts ascending by a Date-valued field', async () => {
		const provider = createInMemoryDataProvider(
			{ dated: { rows: seedDatedItems() } },
			{ latencyMs: 0 }
		);
		const result = await provider.getList<DatedItem>('dated', {
			sort: [{ field: 'createdAt', direction: 'asc' }],
			filters: []
		});
		expect(result.rows.map((row) => row.label)).toEqual(['oldest', 'middle', 'newest']);
	});

	it('sorts descending by a Date-valued field', async () => {
		const provider = createInMemoryDataProvider(
			{ dated: { rows: seedDatedItems() } },
			{ latencyMs: 0 }
		);
		const result = await provider.getList<DatedItem>('dated', {
			sort: [{ field: 'createdAt', direction: 'desc' }],
			filters: []
		});
		expect(result.rows.map((row) => row.label)).toEqual(['newest', 'middle', 'oldest']);
	});

	it('relational filter (gt) compares Date-valued fields by time', async () => {
		const provider = createInMemoryDataProvider(
			{ dated: { rows: seedDatedItems() } },
			{ latencyMs: 0 }
		);
		const result = await provider.getList<DatedItem>('dated', {
			sort: [],
			filters: [{ field: 'createdAt', op: 'gt', value: new Date('2024-02-01') }]
		});
		expect(result.rows.map((row) => row.label).sort()).toEqual(['middle', 'newest']);
	});
});
