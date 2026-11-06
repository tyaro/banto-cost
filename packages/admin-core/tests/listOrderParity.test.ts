/**
 * List-order contract parity (Issue #243 review): the InMemory DataProvider
 * must order rows exactly like banto-storage's SQL - ties broken by the
 * unique key `id` in the direction of the last sort key, unsorted lists by
 * `id` ascending, NULLs last. The expectations live in one fixture shared
 * with the Rust tests (`crates/banto-storage/testdata/list-order-parity.json`)
 * and the grid's client-sort tests, so the implementations cannot drift.
 */
import { describe, expect, it } from 'vitest';
import parityFixture from '../../../crates/banto-storage/testdata/list-order-parity.json';
import { createInMemoryDataProvider } from '../src/providers/inMemory';
import type { SortState } from '../src/types';

interface ParityRow {
	id: number;
	grp: number;
	score: number | null;
}

const fixture = parityFixture as {
	rows: ParityRow[];
	cases: { sort: SortState[]; expectedIds: number[] }[];
};

describe('InMemory list order matches the shared SQL contract', () => {
	const provider = createInMemoryDataProvider(
		{ parity: { rows: fixture.rows as unknown as Record<string, unknown>[] } },
		{ latencyMs: 0 }
	);

	for (const { sort, expectedIds } of fixture.cases) {
		const label = sort.map((s) => `${s.field} ${s.direction}`).join(', ') || '(unsorted)';

		it(`orders ${label}`, async () => {
			const result = await provider.getList<ParityRow>('parity', { sort, filters: [] });
			expect(result.rows.map((row) => row.id)).toEqual(expectedIds);
		});

		it(`pages ${label} without duplicates or gaps`, async () => {
			const ids: number[] = [];
			for (let offset = 0; offset < fixture.rows.length; offset += 5) {
				const page = await provider.getList<ParityRow>('parity', {
					sort,
					filters: [],
					pagination: { offset, limit: 5 }
				});
				ids.push(...page.rows.map((row) => row.id));
			}
			expect(ids).toEqual(expectedIds);
		});
	}
});
