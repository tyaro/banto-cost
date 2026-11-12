/**
 * The day range of a column filter (date-time-pickers §5.9, D12): the one
 * place that turns the range the user sees - both ends inclusive days - into
 * the `between` value the grid filters and the server queries with - the
 * half-open `[from, to)` - and back. Everything that builds or reads a
 * `between` value for a day range (FilterPopover, a host that sets a filter
 * itself) goes through here, so "the end day is included" holds the same
 * everywhere.
 *
 * - `to` is the day AFTER the inclusive end day (month end, year end and the
 *   leap day roll over), so a date column and a date-and-time column -
 *   `2026-11-07T23:59`, even with seconds - keep the whole end day.
 * - `null` is an open end. The inclusive end `9999-12-31` has no next day in
 *   the canonical range (years 0001-9999), so it becomes an open end too -
 *   it already includes every canonical value.
 * - Pure, no Svelte: `filter.ts` (the client filter), `state.svelte.ts`
 *   (restoring a saved state) and the popover share it.
 */
import { daysInMonth, isIsoDate, pad } from './date';

/** A `between` filter value: `[from | null, to | null]`, the half-open `[from, to)`. */
export type BetweenValue = [string | null, string | null];

/** A day range as the user sees it: inclusive canonical `YYYY-MM-DD` ends, `null` when open. */
export interface DateRangeValue {
	from: string | null;
	to: string | null;
}

/** Is `value` well formed for `between`: a two-element array of strings or `null`s. */
export function isBetweenValue(value: unknown): value is BetweenValue {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		value.every((end) => end === null || typeof end === 'string')
	);
}

function format(year: number, month: number, day: number): string {
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function parts(date: string): [number, number, number] {
	return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

/** The canonical day after `date`, or `null` after `9999-12-31` (or for a non-canonical `date`). */
export function nextDay(date: string): string | null {
	if (!isIsoDate(date)) return null;
	const [year, month, day] = parts(date);
	if (day < daysInMonth(year, month)) return format(year, month, day + 1);
	if (month < 12) return format(year, month + 1, 1);
	return year < 9999 ? format(year + 1, 1, 1) : null;
}

/** The canonical day before `date`, or `null` before `0001-01-01` (or for a non-canonical `date`). */
export function previousDay(date: string): string | null {
	if (!isIsoDate(date)) return null;
	const [year, month, day] = parts(date);
	if (day > 1) return format(year, month, day - 1);
	if (month > 1) return format(year, month - 1, daysInMonth(year, month - 1));
	return year > 1 ? format(year - 1, 12, 31) : null;
}

/**
 * Inclusive days -> the `between` value: `from` as is, `to` the day after
 * the end day (`null` stays open; so does `9999-12-31`, see the module doc).
 */
export function dateRangeToBetween(range: DateRangeValue): BetweenValue {
	return [range.from, range.to === null ? null : nextDay(range.to)];
}

/**
 * A `between` value -> the inclusive days to show, or `null` when it is not
 * a day range this module made (a malformed value, an end that is not a
 * canonical date - a date and time set by a host - or `to` = `0001-01-01`,
 * which has no day before it). The popover then starts empty.
 */
export function betweenToDateRange(value: unknown): DateRangeValue | null {
	if (!isBetweenValue(value)) return null;
	const [from, to] = value;
	if (from !== null && !isIsoDate(from)) return null;
	if (to === null) return { from, to: null };
	const end = previousDay(to);
	return end === null ? null : { from, to: end };
}

/**
 * Does `value` (a cell's raw value) fall in the half-open `between` range?
 * Text comparison (canonical strings sort in time order); a `null` end drops
 * that side, both `null` keeps every row (`null` cells too); otherwise a
 * `null` cell is out. A malformed range matches nothing. Must stay in sync
 * with the InMemory provider (`@banto/admin-core`) and banto-storage's
 * `push_between` - shared cases in
 * `crates/banto-storage/testdata/filter-between-parity.json`.
 */
export function matchesBetween(value: unknown, range: unknown): boolean {
	if (!isBetweenValue(range)) return false;
	const [from, to] = range;
	if (from === null && to === null) return true;
	if (value === null || value === undefined) return false;
	const text = String(value);
	return (from === null || text >= from) && (to === null || text < to);
}
