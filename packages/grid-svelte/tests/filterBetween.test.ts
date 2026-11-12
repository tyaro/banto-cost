/**
 * The `between` filter and the day range (date-time-pickers §5.9, D12, PR-6):
 *
 * - the client filter against the cases shared with banto-storage's SQL
 *   (SQLite + PostgreSQL) and the InMemory provider
 *   (`crates/banto-storage/testdata/filter-between-parity.json`);
 * - the one conversion between the inclusive days the user sees and the
 *   half-open value (`dateRangeToBetween` / `betweenToDateRange`): month end,
 *   year end, the leap day, the last canonical day, open ends;
 * - dates / times / dates and times sorted and compared as text;
 * - a malformed saved `between` dropped when a state is restored.
 */
import { describe, expect, it } from 'vitest';
import betweenFixture from '../../../crates/banto-storage/testdata/filter-between-parity.json';
import {
	betweenToDateRange,
	dateRangeToBetween,
	isBetweenValue,
	matchesBetween,
	nextDay,
	previousDay
} from '../src/core/dateRange';
import { filterRows } from '../src/core/filter';
import { columnsFromSchema } from '../src/core/schema';
import { sortRows } from '../src/core/sort';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

interface RangeRow {
	id: number;
	day: string | null;
	at: string | null;
}

const fixture = betweenFixture as {
	rows: RangeRow[];
	cases: { name: string; field: string; value: unknown; expectedIds: number[] }[];
	invalid: { name: string; value: unknown }[];
};

const rangeColumns: GridColumn<RangeRow>[] = [
	{ id: 'id', header: 'ID', accessor: 'id' },
	{ id: 'day', header: 'Day', accessor: 'day', filterable: true, filterType: 'date' },
	{ id: 'at', header: 'At', accessor: 'at', filterable: true, filterType: 'datetime' }
];

describe('between: the shared parity fixture', () => {
	for (const testCase of fixture.cases) {
		it(testCase.name, () => {
			const ids = filterRows(
				fixture.rows,
				[{ field: testCase.field, op: 'between', value: testCase.value }],
				rangeColumns
			).map((row) => row.id);
			expect(ids).toEqual(testCase.expectedIds);
		});
	}

	for (const testCase of fixture.invalid) {
		it(`a malformed value matches nothing: ${testCase.name}`, () => {
			expect(isBetweenValue(testCase.value)).toBe(false);
			expect(
				filterRows(
					fixture.rows,
					[{ field: 'day', op: 'between', value: testCase.value }],
					rangeColumns
				)
			).toEqual([]);
		});
	}

	it('matchesBetween reads a value as text', () => {
		expect(matchesBetween('2026-11-07T09:30', ['2026-11-07', '2026-11-08'])).toBe(true);
		expect(matchesBetween('2026-11-08T00:00', ['2026-11-07', '2026-11-08'])).toBe(false);
		expect(matchesBetween(undefined, ['2026-11-07', null])).toBe(false);
		expect(matchesBetween(undefined, [null, null])).toBe(true);
	});
});

describe('the inclusive day range and the half-open value', () => {
	it.each([
		['2026-11-07', '2026-11-08'],
		['2026-01-31', '2026-02-01'],
		['2026-02-28', '2026-03-01'],
		['2024-02-28', '2024-02-29'],
		['2024-02-29', '2024-03-01'],
		['2100-02-28', '2100-03-01'],
		['2000-02-28', '2000-02-29'],
		['2026-04-30', '2026-05-01'],
		['2025-12-31', '2026-01-01'],
		['0001-01-01', '0001-01-02']
	])('the day after %s is %s, and back', (day, next) => {
		expect(nextDay(day)).toBe(next);
		expect(previousDay(next)).toBe(day);
	});

	it('has no day after 9999-12-31 or before 0001-01-01', () => {
		expect(nextDay('9999-12-31')).toBeNull();
		expect(previousDay('0001-01-01')).toBeNull();
	});

	it('refuses a day that is not canonical', () => {
		expect(nextDay('2026-02-30')).toBeNull();
		expect(nextDay('2026/11/07')).toBeNull();
		expect(previousDay('2026-11-07T09:30')).toBeNull();
	});

	it('sends the day after the end day, an open end as null', () => {
		expect(dateRangeToBetween({ from: '2026-11-01', to: '2026-11-30' })).toEqual([
			'2026-11-01',
			'2026-12-01'
		]);
		expect(dateRangeToBetween({ from: '2024-02-01', to: '2024-02-29' })).toEqual([
			'2024-02-01',
			'2024-03-01'
		]);
		expect(dateRangeToBetween({ from: null, to: '2025-12-31' })).toEqual([null, '2026-01-01']);
		expect(dateRangeToBetween({ from: '2026-11-01', to: null })).toEqual(['2026-11-01', null]);
		// The last canonical day already includes every canonical value.
		expect(dateRangeToBetween({ from: '2026-11-01', to: '9999-12-31' })).toEqual([
			'2026-11-01',
			null
		]);
	});

	it('shows the end day of a value it sent', () => {
		expect(betweenToDateRange(['2026-11-01', '2026-12-01'])).toEqual({
			from: '2026-11-01',
			to: '2026-11-30'
		});
		expect(betweenToDateRange([null, '2024-03-01'])).toEqual({ from: null, to: '2024-02-29' });
		expect(betweenToDateRange(['2026-11-01', null])).toEqual({ from: '2026-11-01', to: null });
		expect(betweenToDateRange([null, null])).toEqual({ from: null, to: null });
	});

	it('round-trips any inclusive range', () => {
		for (const range of [
			{ from: '2024-02-29', to: '2024-02-29' },
			{ from: '2025-12-31', to: '2026-01-01' },
			{ from: null, to: '2026-03-31' }
		]) {
			expect(betweenToDateRange(dateRangeToBetween(range))).toEqual(range);
		}
	});

	it('cannot show a value it did not make', () => {
		expect(betweenToDateRange('2026-11-01')).toBeNull();
		expect(betweenToDateRange(['2026-11-01T09:00', null])).toBeNull();
		expect(betweenToDateRange([null, '2026-11-02T00:00'])).toBeNull();
		expect(betweenToDateRange([null, '0001-01-01'])).toBeNull();
	});

	it('the end day is kept whole on a date-and-time column', () => {
		const value = dateRangeToBetween({ from: '2025-12-31', to: '2025-12-31' });
		const ids = filterRows(fixture.rows, [{ field: 'at', op: 'between', value }], rangeColumns).map(
			(row) => row.id
		);
		expect(ids).toEqual([4]);
	});
});

describe('dates and times compare as text', () => {
	interface Row {
		id: number;
		at: string;
		time: string;
	}
	const columns = columnsFromSchema<Row>({
		fields: [
			{ name: 'at', label: 'At', type: 'datetime', readonly: true },
			{ name: 'time', label: 'Time', type: 'time', readonly: true }
		]
	});
	const rows: Row[] = [
		{ id: 1, at: '2026-11-07T09:30', time: '09:30' },
		{ id: 2, at: '2026-11-07', time: '10:00' },
		{ id: 3, at: '2026-11-06T23:59', time: '08:15' }
	];

	it('sorts read-only temporal columns as text', () => {
		expect(sortRows(rows, [{ field: 'at', direction: 'asc' }], columns).map((r) => r.id)).toEqual([
			3, 2, 1
		]);
		expect(
			sortRows(rows, [{ field: 'time', direction: 'desc' }], columns).map((r) => r.id)
		).toEqual([2, 1, 3]);
	});

	it('sorts a hand-written column with a temporal filterType or editor as text', () => {
		const handWritten: GridColumn<Row>[] = [
			{ id: 'at', header: 'At', accessor: 'at', filterType: 'datetime' },
			{ id: 'time', header: 'Time', accessor: 'time', editor: 'time' }
		];
		expect(
			sortRows(rows, [{ field: 'at', direction: 'asc' }], handWritten).map((r) => r.id)
		).toEqual([3, 2, 1]);
		expect(
			sortRows(rows, [{ field: 'time', direction: 'asc' }], handWritten).map((r) => r.id)
		).toEqual([3, 1, 2]);
	});

	it('compares lt / gte on a temporal column as text, not as a parsed time', () => {
		const ids = (op: 'lt' | 'gte', field: 'at' | 'time', value: string) =>
			filterRows(rows, [{ field, op, value }], columns).map((r) => r.id);
		// `Date.parse` would read `2026-11-07` as UTC midnight and the others
		// as local time.
		expect(ids('lt', 'at', '2026-11-07')).toEqual([3]);
		expect(ids('gte', 'at', '2026-11-07')).toEqual([1, 2]);
		// `Date.parse('09:30')` is NaN: every comparison would be false.
		expect(ids('lt', 'time', '09:30')).toEqual([3]);
	});
});

describe('restoring a saved state', () => {
	const columns: GridColumn<RangeRow>[] = rangeColumns;

	it('keeps a well-formed between and drops a malformed one', () => {
		const state = new GridState<RangeRow>(columns);
		state.hydrate(
			JSON.stringify({
				sort: [],
				filters: [
					{ field: 'day', op: 'between', value: ['2026-11-01', '2026-12-01'] },
					{ field: 'at', op: 'between', value: '2026-11-01' },
					{ field: 'id', op: 'eq', value: 1 }
				],
				order: ['id', 'day', 'at'],
				widths: {},
				hidden: []
			})
		);
		expect(state.filters).toEqual([
			{ field: 'day', op: 'between', value: ['2026-11-01', '2026-12-01'] },
			{ field: 'id', op: 'eq', value: 1 }
		]);
	});

	it('round-trips a between through serialize / hydrate', () => {
		const state = new GridState<RangeRow>(columns);
		state.setFilter({ field: 'at', op: 'between', value: [null, '2026-01-01'] });
		const restored = new GridState<RangeRow>(columns);
		restored.hydrate(state.serialize());
		expect(restored.filters).toEqual([{ field: 'at', op: 'between', value: [null, '2026-01-01'] }]);
	});
});
