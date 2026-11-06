/**
 * Virtualization performance bench (spec §4.2, improvement-plan P4-2).
 *
 * Run with `pnpm --filter @banto/grid-svelte bench` (NOT part of `vitest run`
 * / CI - timing benchmarks are machine-dependent and must not gate merges).
 *
 * What it measures and why:
 *
 * - **per-frame work** (`computeWindow` + slicing the visible window out of
 *   the row array) is what BantoGrid does on every scroll frame. The whole
 *   point of virtualization is that this cost is O(visible rows), NOT
 *   O(total rows) - so the 10k and 100k cases should be ~identical. That
 *   invariant, not an absolute number, is what keeps a 100k-row grid at the
 *   spec §4.2 "1万行・20列を60fps" budget (16.7ms/frame): per-frame work must
 *   stay far under budget regardless of dataset size.
 * - **sortRows / filterRows** DO scale with total rows - they run once per
 *   sort/filter change (not per frame). Benching them at 100k shows the
 *   one-off "data operation" cost that could cause a single jank spike when
 *   the user sorts/filters a huge client-mode dataset.
 *
 * Representative results (machine-dependent; re-run to refresh - Node 22,
 * 2026-07-19 dev container):
 *
 * | bench                           |          10k |          100k | note |
 * | ------------------------------- | -----------: | ------------: | ---- |
 * | per-frame (computeWindow+slice) | ~4.2M ops/s  | ~5.1M ops/s   | flat: virtualization holds |
 * | sortRows (1 column)             | ~274 ops/s (~3.6ms) | ~4.3 ops/s (~235ms) | ~linear (O(n log n)) |
 * | filterRows (1 filter)           | ~561 ops/s (~1.8ms) | ~31 ops/s (~32ms)   | ~linear in rows |
 *
 * Reading: per-frame stays ~constant from 10k→100k (≈0.0002ms/frame, ~4–5
 * orders of magnitude under the 16.7ms budget - the 100k case is even a hair
 * faster, i.e. the difference is noise), confirming per-frame work is
 * independent of total row count. sort/filter are ~linear, so a one-time
 * sort of 100k rows costs ~235ms - acceptable as a non-per-frame event, and
 * a concrete reason server mode (spec §4.1) exists for genuinely large
 * client-side datasets.
 */
import { describe, test } from 'vitest';

/**
 * Vitest 5 removed the module-level `bench()`; a benchmark is now the `bench`
 * test-context fixture used inside a regular `test()`. This shim keeps the
 * call sites below in their original `bench(name, fn)` shape (one benchmark
 * per test, run immediately). The generous timeout covers the 100k-row cases.
 */
function bench(name: string, fn: () => void): void {
	test(
		name,
		async ({ bench: registerBench }) => {
			await registerBench(name, fn).run();
		},
		60_000
	);
}
import { computeWindow } from '../src/core/virtual';
import { sortRows } from '../src/core/sort';
import { filterRows } from '../src/core/filter';
import type { FilterState, GridColumn, SortState } from '../src/types';

interface Row {
	id: number;
	name: string;
	[key: string]: string | number;
}

// 20 columns to match spec §4.2's "1万行・20列" target: id + name + 18 mixed
// string/number columns, all key accessors.
const columns: GridColumn<Row>[] = [
	{ id: 'id', header: 'ID', accessor: 'id' },
	{ id: 'name', header: '名前', accessor: 'name' },
	...Array.from({ length: 18 }, (_, i): GridColumn<Row> => {
		const key = `c${i}`;
		return { id: key, header: key, accessor: key };
	})
];

function makeRows(count: number): Row[] {
	const rows: Row[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const row: Row = { id: i, name: `row-${(count - i) % 997}` };
		for (let c = 0; c < 18; c++) {
			// Alternate string/number columns; values chosen so sorting is not
			// already-ordered (worst-ish case for a stable sort).
			row[`c${c}`] = c % 2 === 0 ? (i * 31 + c) % 100000 : `v${(i * 7 + c) % 503}`;
		}
		rows[i] = row;
	}
	return rows;
}

const rows10k = makeRows(10_000);
const rows100k = makeRows(100_000);

const sortByC0: SortState[] = [{ field: 'c0', direction: 'asc' }];
const filterC1Contains: FilterState[] = [{ field: 'c1', op: 'contains', value: 'v1' }];

/** One scroll frame's work: find the window, then materialize its rows. */
function perFrame(rows: Row[], scrollTop: number): number {
	const win = computeWindow({
		scrollTop,
		viewportHeight: 640,
		rowHeight: 32,
		rowCount: rows.length
	});
	// Slicing the visible block is what BantoGrid feeds to the row snippet.
	return rows.slice(win.start, win.end).length;
}

describe('per-frame work (should be flat 10k vs 100k)', () => {
	let tick = 0;
	bench('10k rows', () => {
		perFrame(rows10k, (tick++ * 137) % (10_000 * 32));
	});
	bench('100k rows', () => {
		perFrame(rows100k, (tick++ * 137) % (100_000 * 32));
	});
});

describe('sortRows (one-off on sort change; ~linear in rows)', () => {
	bench('10k rows', () => {
		sortRows(rows10k, sortByC0, columns);
	});
	bench('100k rows', () => {
		sortRows(rows100k, sortByC0, columns);
	});
});

describe('filterRows (one-off on filter change; ~linear in rows)', () => {
	bench('10k rows', () => {
		filterRows(rows10k, filterC1Contains, columns);
	});
	bench('100k rows', () => {
		filterRows(rows100k, filterC1Contains, columns);
	});
});
