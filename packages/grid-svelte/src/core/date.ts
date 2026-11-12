/**
 * Dates and times for grid cells (date-time-pickers §5.1 / §5.3 / §5.6 /
 * §5.10): the canonical `YYYY-MM-DD` / `HH:mm` / `YYYY-MM-DDTHH:mm` checks,
 * the lenient parse of typed, pasted and imported text and the time step,
 * used by `parseCellInput` (cell commit, paste, CSV import) and the schema
 * column validator (`fieldValidator`).
 *
 * A copy of `@banto/ui`'s `datetime.ts` (and of `@banto/forms`' `date.ts`) -
 * grid cannot import either (conventions §4, shared-primitives-upstream-plan
 * §2.1) - kept in lockstep by `tests/date.test.ts` and
 * `tests/temporal.test.ts`, which run the same cases through ui's and
 * forms' copies (and the latter the edge-case table shared with Rust,
 * `crates/banto-core/tests/datetime-cases.json`). Change them together.
 *
 * - Canonical: `YYYY-MM-DD`, years 0001-9999, a real calendar day. String
 *   order = date order, so `min` / `max` are plain string comparisons.
 * - Lenient (D7): year-month-day with `-` `/` `.` or no separator, one-digit
 *   month / day, full-width digits and signs through NFKC. Other orders are
 *   refused. The year-less `M/D` / `M-D` (current year) is for typed text
 *   only: {@link parseCellDate} refuses it for paste and CSV import (§5.10,
 *   "this year" is ambiguous for imported data).
 * - Times: canonical `HH:mm` (00:00-23:59, no seconds); typed / pasted
 *   `H:mm`, `HHmm`, `Hmm`, `H`. A date and time is canonical
 *   `YYYY-MM-DDTHH:mm` (D4), read as a date, a space or `T`, and a time
 *   (Excel's `2026/11/7 9:30`); shown with a space.
 */

const MIN_YEAR = 1;
const MAX_YEAR = 9999;

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeapYear(year) ? 29 : 28;
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidParts(year: number, month: number, day: number): boolean {
	return (
		Number.isInteger(year) &&
		Number.isInteger(month) &&
		Number.isInteger(day) &&
		year >= MIN_YEAR &&
		year <= MAX_YEAR &&
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= daysInMonth(year, month)
	);
}

export const pad = (n: number, width: number) => String(n).padStart(width, '0');

const CANONICAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEARLESS_DATE = /^(\d{1,2})([-/])(\d{1,2})$/;

/** Is `value` a canonical `YYYY-MM-DD` real calendar day? Strict: no lenient forms. */
export function isIsoDate(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const match = CANONICAL_DATE.exec(value);
	return !!match && isValidParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * Typed text -> canonical `YYYY-MM-DD`, or `null` when it is not a date
 * (blank text is also `null`; callers check blank first). `currentYear` fills
 * the year of `M/D` / `M-D` (defaults to the local current year).
 */
export function parseDateText(text: string, currentYear?: number): string | null {
	const s = text.normalize('NFKC').trim();
	let match = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(s);
	let parts: [number, number, number] | null = null;
	if (match) {
		parts = [Number(match[1]), Number(match[3]), Number(match[4])];
	} else if ((match = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
		parts = [Number(match[1]), Number(match[2]), Number(match[3])];
	} else if ((match = YEARLESS_DATE.exec(s))) {
		const year = currentYear ?? new Date().getFullYear();
		parts = [year, Number(match[1]), Number(match[3])];
	}
	if (!parts || !isValidParts(...parts)) return null;
	return `${pad(parts[0], 4)}-${pad(parts[1], 2)}-${pad(parts[2], 2)}`;
}

/**
 * A cell's text -> canonical `YYYY-MM-DD`, or `null` when it is not a date.
 * Pasted and imported text (`typed` false) never fills in "this year": the
 * year-less form is refused (§5.10). Typed text (`typed` true, the editor's
 * commit) takes it like the injected input does - Tab commits the draft
 * before the input's own blur would have normalised it.
 */
export function parseCellDate(text: string, typed = false): string | null {
	if (!typed && YEARLESS_DATE.test(text.normalize('NFKC').trim())) return null;
	return parseDateText(text);
}

const CANONICAL_TIME = /^(\d{2}):(\d{2})$/;

function isValidTime(hour: number, minute: number): boolean {
	return (
		Number.isInteger(hour) &&
		Number.isInteger(minute) &&
		hour >= 0 &&
		hour <= 23 &&
		minute >= 0 &&
		minute <= 59
	);
}

/** Is `value` a canonical `HH:mm` (00:00-23:59)? Strict: no lenient forms. */
export function isIsoTime(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const match = CANONICAL_TIME.exec(value);
	return !!match && isValidTime(Number(match[1]), Number(match[2]));
}

/**
 * Typed text -> canonical `HH:mm`, or `null` when it is not a time (blank
 * text is also `null`). `H:mm` / `HH:mm`, `HHmm`, `Hmm`, `H` / `HH` alone;
 * full-width through NFKC; no `AM` / `PM`, no `24:00`, no seconds.
 */
export function parseTimeText(text: string): string | null {
	const s = text.normalize('NFKC').trim();
	const match =
		/^(\d{1,2}):(\d{2})$/.exec(s) ?? /^(\d{1,2})(\d{2})$/.exec(s) ?? /^(\d{1,2})()$/.exec(s);
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = match[2] === '' ? 0 : Number(match[2]);
	return isValidTime(hour, minute) ? `${pad(hour, 2)}:${pad(minute, 2)}` : null;
}

const CANONICAL_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

/** Is `value` a canonical `YYYY-MM-DDTHH:mm` (a real day, 00:00-23:59)? Strict. */
export function isIsoDateTime(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const match = CANONICAL_DATETIME.exec(value);
	return !!match && isIsoDate(match[1]) && isIsoTime(match[2]);
}

/** A canonical date and time shown with a space (`2026-11-07 09:30`); anything else unchanged. */
export function formatDateTimeText(value: string): string {
	return isIsoDateTime(value) ? value.replace('T', ' ') : value;
}

const DATETIME_TEXT = /^([^\sT]+)(?:T|\s+)([^\sT]+)$/;

/**
 * Typed text -> canonical `YYYY-MM-DDTHH:mm`, or `null` when it is not one:
 * a date as {@link parseDateText} reads it, a space or `T`, a time as
 * {@link parseTimeText} reads it. `currentYear` fills the year of `M/D`.
 */
export function parseDateTimeText(text: string, currentYear?: number): string | null {
	const match = DATETIME_TEXT.exec(text.normalize('NFKC').trim());
	if (!match) return null;
	const date = parseDateText(match[1], currentYear);
	const time = parseTimeText(match[2]);
	return date !== null && time !== null ? `${date}T${time}` : null;
}

/** `step` as minutes (a positive integer), else `undefined` (not given / invalid: no step check, D8). */
export function normalizeTimeStep(step: number | null | undefined): number | undefined {
	return typeof step === 'number' && Number.isInteger(step) && step > 0 ? step : undefined;
}

/** Is the canonical `HH:mm` `time` on the `step` grid counted from 00:00 (D8)? No (valid) step: true. */
export function isOnTimeStep(time: string, step?: number): boolean {
	const by = normalizeTimeStep(step);
	if (by === undefined) return true;
	const match = CANONICAL_TIME.exec(time);
	if (!match) return false;
	return (Number(match[1]) * 60 + Number(match[2])) % by === 0;
}

/**
 * The `step` attribute (seconds) for the native `time` / `datetime-local`
 * fallback (D3-a), or `undefined` to leave it off. A native input counts its
 * step from `min` (or, for `datetime-local` without one, from 1970-01-01T00:00),
 * while the validator counts it from each day's 00:00 (D8). They agree only
 * when the base is on the step grid - `min` absent or on it, and for a date
 * and time the step dividing the day - so otherwise no native step is given
 * (the validator still checks the step; the input simply offers every minute).
 */
export function nativeTimeStep(
	type: 'time' | 'datetime',
	step: number | undefined,
	min: string | undefined
): number | undefined {
	const by = normalizeTimeStep(step);
	if (by === undefined) return undefined;
	if (type === 'datetime' && (24 * 60) % by !== 0) return undefined;
	if (min !== undefined) {
		const time = type === 'datetime' ? (isIsoDateTime(min) ? min.slice(11) : null) : min;
		if (time === null || !isOnTimeStep(time, by)) return undefined;
	}
	return by * 60;
}

/**
 * A cell's text -> canonical `YYYY-MM-DDTHH:mm`, or `null`. Like
 * {@link parseCellDate}, a year-less date part (`11/7 9:30`) is taken only
 * when `typed` (paste and CSV import never guess the year, §5.10).
 */
export function parseCellDateTime(text: string, typed = false): string | null {
	if (!typed) {
		const match = DATETIME_TEXT.exec(text.normalize('NFKC').trim());
		if (match && YEARLESS_DATE.test(match[1])) return null;
	}
	return parseDateTimeText(text);
}
