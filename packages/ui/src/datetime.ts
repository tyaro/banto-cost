/**
 * Dates for the pickers (date-time-pickers §5.1 / §5.3 / §5.5): parsing,
 * the calendar arithmetic, the month grid and the `Intl` names. Pure
 * functions, no Svelte - the main unit-test target.
 *
 * - A date is the canonical string `YYYY-MM-DD` (years 0001-9999), a wall
 *   date with no time zone. Fixed width, so string order = date order;
 *   nothing here goes through `Date.parse` (§2.2's UTC / local mix-up).
 * - The arithmetic is integer days since 1970-01-01 (Howard Hinnant's
 *   `days_from_civil` / `civil_from_days`) - no `Date`, so no time zone and
 *   no two-digit-year quirks. `Date` is used only to hand a day to `Intl`,
 *   always at UTC noon with `timeZone: 'UTC'`.
 * - Lenient parsing is for typed input only (D7): year-month-day order with
 *   `-` `/` `.` or no separator, one-digit month / day, `M/D` / `M-D` for the
 *   current year, full-width digits and signs through NFKC. Other orders
 *   (`MM/DD/YYYY`) are refused - their meaning depends on the locale - and
 *   display is always ISO.
 * - Names come from `Intl.DateTimeFormat(locale)`; there is no locale branch
 *   here (conventions §13) - the caller passes the BCP 47 tag.
 */

/** Weekday index: 0 = Sunday ... 6 = Saturday (the `Date#getDay` numbering). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface DateParts {
	year: number;
	month: number; // 1-12
	day: number; // 1-31
}

const MIN_YEAR = 1;
const MAX_YEAR = 9999;

export function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in `month` (1-12) of `year`. */
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

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** `YYYY-MM-DD` from parts (no validation - pass valid parts). */
export function formatDate(parts: DateParts): string {
	return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

const CANONICAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parts of a canonical `YYYY-MM-DD` that is a real calendar day, else `null`. Strict: no lenient forms. */
export function parseIsoDate(value: string): DateParts | null {
	const match = CANONICAL_DATE.exec(value);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	return isValidParts(year, month, day) ? { year, month, day } : null;
}

/** Is `value` a canonical `YYYY-MM-DD` real calendar day? */
export function isIsoDate(value: string): boolean {
	return parseIsoDate(value) !== null;
}

/** Empty for the pickers: `null`, `undefined`, `''` or only white space (D6). */
export function isBlankDateText(text: string | null | undefined): boolean {
	return text == null || text.trim() === '';
}

/**
 * Typed text -> canonical `YYYY-MM-DD`, or `null` when it is not a date
 * (blank text is also `null` - check {@link isBlankDateText} first to tell
 * "empty" from "invalid"). `currentYear` fills the year of `M/D` / `M-D`
 * (defaults to the local current year).
 */
export function parseDateText(text: string, currentYear?: number): string | null {
	const s = text.normalize('NFKC').trim();
	let match = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(s);
	let parts: [number, number, number] | null = null;
	if (match) {
		parts = [Number(match[1]), Number(match[3]), Number(match[4])];
	} else if ((match = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
		parts = [Number(match[1]), Number(match[2]), Number(match[3])];
	} else if ((match = /^(\d{1,2})([-/])(\d{1,2})$/.exec(s))) {
		const year = currentYear ?? new Date().getFullYear();
		parts = [year, Number(match[1]), Number(match[3])];
	}
	if (!parts || !isValidParts(...parts)) return null;
	return formatDate({ year: parts[0], month: parts[1], day: parts[2] });
}

// --- Day numbers (Howard Hinnant, http://howardhinnant.github.io/date_algorithms.html) ---

/** Days since 1970-01-01 of a proleptic Gregorian date. */
export function daysFromCivil({ year, month, day }: DateParts): number {
	const y = month <= 2 ? year - 1 : year;
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const mp = (month + 9) % 12; // March = 0
	const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

/** Inverse of {@link daysFromCivil}. */
export function civilFromDays(days: number): DateParts {
	const z = days + 719468;
	const era = Math.floor(z / 146097);
	const doe = z - era * 146097;
	const yoe = Math.floor(
		(doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
	);
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp < 10 ? mp + 3 : mp - 9;
	return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function requireDate(value: string): DateParts {
	const parts = parseIsoDate(value);
	if (!parts) throw new RangeError(`not a YYYY-MM-DD date: ${value}`);
	return parts;
}

const FIRST_DAY = daysFromCivil({ year: MIN_YEAR, month: 1, day: 1 });
const LAST_DAY = daysFromCivil({ year: MAX_YEAR, month: 12, day: 31 });

function fromDays(days: number): string {
	return formatDate(civilFromDays(Math.min(Math.max(days, FIRST_DAY), LAST_DAY)));
}

/** `date` + `n` days (clamped to 0001-01-01..9999-12-31). */
export function addDays(date: string, n: number): string {
	return fromDays(daysFromCivil(requireDate(date)) + n);
}

/** `date` + `n` months; the day is clamped to the target month's length (01-31 + 1 month = 02-28/29). */
export function addMonths(date: string, n: number): string {
	const { year, month, day } = requireDate(date);
	const index = year * 12 + (month - 1) + n;
	const targetYear = Math.floor(index / 12);
	if (targetYear < MIN_YEAR) return formatDate({ year: MIN_YEAR, month: 1, day: 1 });
	if (targetYear > MAX_YEAR) return formatDate({ year: MAX_YEAR, month: 12, day: 31 });
	const targetMonth = (index % 12) + 1;
	return formatDate({
		year: targetYear,
		month: targetMonth,
		day: Math.min(day, daysInMonth(targetYear, targetMonth))
	});
}

/** `date` + `n` years (02-29 -> 02-28 in a common year). */
export function addYears(date: string, n: number): string {
	return addMonths(date, n * 12);
}

/** Weekday of `date` (0 = Sunday). */
export function dayOfWeek(date: string): Weekday {
	// 1970-01-01 was a Thursday (4).
	const days = daysFromCivil(requireDate(date));
	return ((((days + 4) % 7) + 7) % 7) as Weekday;
}

/** The first day of `date`'s week, the week starting on `weekStartsOn`. */
export function startOfWeek(date: string, weekStartsOn: Weekday): string {
	const offset = (dayOfWeek(date) - weekStartsOn + 7) % 7;
	return addDays(date, -offset);
}

/** The last day of `date`'s week. */
export function endOfWeek(date: string, weekStartsOn: Weekday): string {
	return addDays(startOfWeek(date, weekStartsOn), 6);
}

/** `YYYY-MM-01` of `date`'s month. */
export function startOfMonth(date: string): string {
	const { year, month } = requireDate(date);
	return formatDate({ year, month, day: 1 });
}

/** Same year and month? */
export function isSameMonth(a: string, b: string): boolean {
	return a.slice(0, 7) === b.slice(0, 7);
}

/** Is `date` outside `[min, max]` (each bound optional, inclusive)? Plain string comparison (§5.1). */
export function isOutOfRange(date: string, min?: string | null, max?: string | null): boolean {
	return (!!min && date < min) || (!!max && date > max);
}

/** `date` moved into `[min, max]`. */
export function clampDate(date: string, min?: string | null, max?: string | null): string {
	if (min && date < min) return min;
	if (max && date > max) return max;
	return date;
}

/**
 * The month grid shown by the calendar: 6 weeks x 7 days of canonical dates,
 * starting on the `weekStartsOn` day on or before the 1st of the month of
 * `date` (so the leading / trailing days of the neighbouring months fill the
 * rows). Always 6 rows - the popover does not change height between months.
 * Positions before 0001-01-01 or after 9999-12-31 are `null` (empty slots):
 * clamping them would put 0001-01-01 under the wrong weekday or repeat
 * 9999-12-31.
 */
export function monthGrid(date: string, weekStartsOn: Weekday): (string | null)[][] {
	const first = daysFromCivil(requireDate(startOfMonth(date)));
	const offset = (((((first + 4) % 7) + 7) % 7) - weekStartsOn + 7) % 7;
	const start = first - offset;
	const weeks: (string | null)[][] = [];
	for (let w = 0; w < 6; w++) {
		const week: (string | null)[] = [];
		for (let d = 0; d < 7; d++) {
			const day = start + w * 7 + d;
			week.push(day < FIRST_DAY || day > LAST_DAY ? null : formatDate(civilFromDays(day)));
		}
		weeks.push(week);
	}
	return weeks;
}

/** The local time of day now as `HH:mm` (the device clock; where an empty time list starts, §5.4). */
export function currentTime(now: Date = new Date()): string {
	return minutesToTime(now.getHours() * 60 + now.getMinutes());
}

/** Today's local calendar date (the device clock, like the native date input). */
export function todayDate(now: Date = new Date()): string {
	return formatDate({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
}

// --- Intl -----------------------------------------------------------------

interface WeekInfoLocale {
	getWeekInfo?: () => { firstDay?: number };
	weekInfo?: { firstDay?: number };
}

/**
 * The first day of the week (D15): `explicit` if given, else the locale's
 * (`Intl.Locale#getWeekInfo()`, or the older `weekInfo` getter; `firstDay`
 * is 1 = Monday ... 7 = Sunday), else Sunday where neither exists.
 */
export function resolveWeekStart(locale: string, explicit?: number): Weekday {
	if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0 && explicit <= 6) {
		return explicit as Weekday;
	}
	try {
		const loc = new Intl.Locale(locale) as unknown as WeekInfoLocale;
		const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
		const firstDay = info?.firstDay;
		if (typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7) {
			return (firstDay % 7) as Weekday;
		}
	} catch {
		// An invalid tag or no Intl.Locale: fall through.
	}
	return 0;
}

/** A `Date` for `Intl` only: UTC noon of the day (years below 100 included). */
function utcDate(parts: DateParts): Date {
	const d = new Date(Date.UTC(2000, 0, 1, 12));
	d.setUTCFullYear(parts.year, parts.month - 1, parts.day);
	return d;
}

// Always the Gregorian calendar: the grid, the values and the parser are
// Gregorian, so a locale whose default calendar differs (`fa-IR` Persian,
// `ja-JP-u-ca-japanese`, `th-TH` Buddhist) must not label the same day as
// another calendar's month / year in the heading and the spoken name.
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const fixed: Intl.DateTimeFormatOptions = { ...options, calendar: 'gregory', timeZone: 'UTC' };
	try {
		return new Intl.DateTimeFormat(locale, fixed);
	} catch {
		return new Intl.DateTimeFormat(undefined, fixed);
	}
}

/** Long date for screen readers and the button name: `dateStyle: 'full'` ("2026年11月7日土曜日"). */
export function formatFullDate(date: string, locale: string): string {
	return formatter(locale, { dateStyle: 'full' }).format(utcDate(requireDate(date)));
}

/** The calendar heading: year and month ("2026年11月", "November 2026"). */
export function formatMonthYear(date: string, locale: string): string {
	return formatter(locale, { year: 'numeric', month: 'long' }).format(utcDate(requireDate(date)));
}

/** Weekday column headers in display order from `weekStartsOn`: short (shown) and long (`abbr`). */
export function weekdayNames(
	locale: string,
	weekStartsOn: Weekday
): { weekday: Weekday; short: string; long: string }[] {
	const short = formatter(locale, { weekday: 'short' });
	const long = formatter(locale, { weekday: 'long' });
	// 2023-01-01 was a Sunday.
	return Array.from({ length: 7 }, (_, i) => {
		const weekday = ((weekStartsOn + i) % 7) as Weekday;
		const date = utcDate({ year: 2023, month: 1, day: 1 + weekday });
		return { weekday, short: short.format(date), long: long.format(date) };
	});
}

// --- Times (date-time-pickers §5.1 / §5.3 / §5.6, D7 / D8) ------------------
//
// A time is the canonical string `HH:mm` (00:00-23:59, 24-hour, no seconds),
// a wall-clock time with no time zone. Fixed width, so string order = time
// order (`isOutOfRange` / `clampDate` work on it too). Display is always this
// form in every locale - no `Intl`, so neither the locale's `hourCycle`
// (`h12` "9:30 AM") nor its digits change what is shown (D7).

export interface TimeParts {
	hour: number; // 0-23
	minute: number; // 0-59
}

/** Minutes in a day: the step list ends before this (no wrap past 23:59). */
const MINUTES_PER_DAY = 24 * 60;

/** The list step when `step` is not given (D8: the list only; any minute is accepted). */
export const DEFAULT_TIME_STEP = 30;

function isValidTimeParts(hour: number, minute: number): boolean {
	return (
		Number.isInteger(hour) &&
		Number.isInteger(minute) &&
		hour >= 0 &&
		hour <= 23 &&
		minute >= 0 &&
		minute <= 59
	);
}

/** `HH:mm` from parts (no validation - pass valid parts). */
export function formatTime(parts: TimeParts): string {
	return `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}`;
}

const CANONICAL_TIME = /^(\d{2}):(\d{2})$/;

/** Parts of a canonical `HH:mm` (00:00-23:59), else `null`. Strict: no lenient forms. */
export function parseIsoTime(value: string): TimeParts | null {
	const match = CANONICAL_TIME.exec(value);
	if (!match) return null;
	const [hour, minute] = [Number(match[1]), Number(match[2])];
	return isValidTimeParts(hour, minute) ? { hour, minute } : null;
}

/** Is `value` a canonical `HH:mm` (00:00-23:59)? */
export function isIsoTime(value: string): boolean {
	return parseIsoTime(value) !== null;
}

/**
 * Typed text -> canonical `HH:mm`, or `null` when it is not a time (blank
 * text is also `null` - check {@link isBlankDateText} first). Accepted (§5.3):
 * `H:mm` / `HH:mm`, `HHmm`, `Hmm`, and `H` / `HH` alone (`9` -> `09:00`);
 * full-width digits and `：` through NFKC. 24-hour only: no `AM` / `PM`, no
 * `24:00`, no seconds.
 */
export function parseTimeText(text: string): string | null {
	const s = text.normalize('NFKC').trim();
	const match =
		/^(\d{1,2}):(\d{2})$/.exec(s) ?? /^(\d{1,2})(\d{2})$/.exec(s) ?? /^(\d{1,2})()$/.exec(s);
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = match[2] === '' ? 0 : Number(match[2]);
	return isValidTimeParts(hour, minute) ? formatTime({ hour, minute }) : null;
}

/** Minutes since 00:00 of a canonical `HH:mm`. */
export function timeToMinutes(time: string): number {
	const parts = parseIsoTime(time);
	if (!parts) throw new RangeError(`not an HH:mm time: ${time}`);
	return parts.hour * 60 + parts.minute;
}

/** Canonical `HH:mm` of `minutes` since 00:00 (0-1439; out-of-day values throw). */
export function minutesToTime(minutes: number): string {
	if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) {
		throw new RangeError(`not a minute of the day: ${minutes}`);
	}
	return formatTime({ hour: Math.floor(minutes / 60), minute: minutes % 60 });
}

/** `step` as a usable step in minutes (a positive integer), else `undefined` (not given / invalid). */
export function normalizeTimeStep(step: number | null | undefined): number | undefined {
	return typeof step === 'number' && Number.isInteger(step) && step > 0 ? step : undefined;
}

/**
 * The times of the list: from 00:00 every `step` minutes (default
 * {@link DEFAULT_TIME_STEP}; an invalid step falls back to it), up to the
 * last one on or before 23:59 - a step that does not divide the day ends
 * early (step 25: ... 23:45, not 00:10) instead of wrapping into the next day, and a
 * step of a day or more leaves 00:00 alone.
 */
export function timeOptions(step?: number): string[] {
	const by = normalizeTimeStep(step) ?? DEFAULT_TIME_STEP;
	const times: string[] = [];
	for (let m = 0; m < MINUTES_PER_DAY; m += by) times.push(minutesToTime(m));
	return times;
}

/** Is `time` on the `step` grid counted from 00:00 (D8)? No (valid) step: always true. */
export function isOnTimeStep(time: string, step?: number): boolean {
	const by = normalizeTimeStep(step);
	return by === undefined || timeToMinutes(time) % by === 0;
}

/**
 * The candidate nearest to `time` (smallest distance in minutes; a tie goes
 * to the earlier one), or `null` when there is none. Used to point the list
 * at the value when it opens (§5.4) - the value may be off the list's step.
 */
export function nearestTime(time: string, candidates: readonly string[]): string | null {
	const target = timeToMinutes(time);
	let best: string | null = null;
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const distance = Math.abs(timeToMinutes(candidate) - target);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
}

// --- Date and time ----------------------------------------------------------
//
// A date and time is the canonical string `YYYY-MM-DDTHH:mm` (§5.1, D4): a
// wall-clock time with no time zone and no seconds - the `datetime-local`
// value. Fixed width, so string order = time order. It is shown and typed with
// a space in place of the `T` (`2026-11-07 09:30`, §5.3); the value keeps the
// `T`.

export interface DateTimeParts {
	/** Canonical `YYYY-MM-DD`. */
	date: string;
	/** Canonical `HH:mm`. */
	time: string;
}

const CANONICAL_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

/** Date and time of a canonical `YYYY-MM-DDTHH:mm` (a real day, 00:00-23:59), else `null`. Strict. */
export function parseIsoDateTime(value: string): DateTimeParts | null {
	const match = CANONICAL_DATETIME.exec(value);
	if (!match || !isIsoDate(match[1]) || !isIsoTime(match[2])) return null;
	return { date: match[1], time: match[2] };
}

/** Is `value` a canonical `YYYY-MM-DDTHH:mm`? */
export function isIsoDateTime(value: string): boolean {
	return parseIsoDateTime(value) !== null;
}

/** `YYYY-MM-DDTHH:mm` from a canonical date and time (no validation). */
export function joinDateTime(date: string, time: string): string {
	return `${date}T${time}`;
}

/**
 * How a value is shown in the text box: a canonical date and time with a
 * space for the `T` (`2026-11-07 09:30`, §5.3); anything else unchanged
 * (`null` -> `''`).
 */
export function formatDateTimeText(value: string | null | undefined): string {
	if (value == null) return '';
	const parts = parseIsoDateTime(value);
	return parts ? `${parts.date} ${parts.time}` : value;
}

/** A date part, then `T` or white space, then a time part (after NFKC, so a full-width space is a space). */
const DATETIME_TEXT = /^([^\sT]+)(?:T|\s+)([^\sT]+)$/;

/**
 * Typed text -> canonical `YYYY-MM-DDTHH:mm`, or `null` when it is not a date
 * and time (blank text is also `null` - check {@link isBlankDateText} first).
 * Accepted (§5.3): a date as {@link parseDateText} reads it, then a space or
 * `T`, then a time as {@link parseTimeText} reads it (`2026/11/7 9:30`,
 * `20261107 0930`, `11/7 9` for this year, full-width). Both parts are
 * required; seconds are refused like {@link parseTimeText} does.
 */
export function parseDateTimeText(text: string, currentYear?: number): string | null {
	const match = DATETIME_TEXT.exec(text.normalize('NFKC').trim());
	if (!match) return null;
	const date = parseDateText(match[1], currentYear);
	const time = parseTimeText(match[2]);
	return date !== null && time !== null ? joinDateTime(date, time) : null;
}
