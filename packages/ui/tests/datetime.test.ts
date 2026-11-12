/**
 * datetime.ts (docs/design/date-time-pickers.md §5.1 / §5.3 / §5.5): lenient
 * parsing of typed dates (D7), the integer calendar (leap years, month
 * clamping, weekdays), the 6-week month grid, range helpers and the `Intl`
 * names / week start (D15).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	addDays,
	addMonths,
	addYears,
	civilFromDays,
	clampDate,
	dayOfWeek,
	daysFromCivil,
	daysInMonth,
	endOfWeek,
	formatFullDate,
	formatMonthYear,
	isBlankDateText,
	isIsoDate,
	isLeapYear,
	isOutOfRange,
	monthGrid,
	parseDateText,
	parseIsoDate,
	resolveWeekStart,
	startOfWeek,
	todayDate,
	weekdayNames
} from '../src/datetime';

describe('parseDateText (D7)', () => {
	it.each([
		['2026-11-07', '2026-11-07'],
		['2026/11/07', '2026-11-07'],
		['2026.11.07', '2026-11-07'],
		['20261107', '2026-11-07'],
		['2026-1-7', '2026-01-07'],
		['2026/1/7', '2026-01-07'],
		['  2026-11-07  ', '2026-11-07'],
		['２０２６／１１／７', '2026-11-07'],
		['２０２６－１１－０７', '2026-11-07'],
		['0001-01-01', '0001-01-01'],
		['9999-12-31', '9999-12-31']
	])('accepts %j as %s', (text, expected) => {
		expect(parseDateText(text)).toBe(expected);
	});

	it('fills the current year for M/D and M-D', () => {
		expect(parseDateText('11/7', 2026)).toBe('2026-11-07');
		expect(parseDateText('1-31', 2025)).toBe('2025-01-31');
		expect(parseDateText('１１／７', 2026)).toBe('2026-11-07');
		expect(parseDateText('2/29', 2025)).toBeNull();
		expect(parseDateText('2/29', 2024)).toBe('2024-02-29');
	});

	it.each([
		'',
		'abc',
		'11/07/2026', // month-day-year: locale-dependent, refused
		'07.11.2026',
		'2026-13-01',
		'2026-02-30',
		'2025-02-29',
		'0000-01-01',
		'2026-11/07', // mixed separators
		'2026117',
		'2026-11-07T09:00',
		'1/2/3'
	])('refuses %j', (text) => {
		expect(parseDateText(text, 2026)).toBeNull();
	});

	it('isBlankDateText treats null, empty and white space as empty (D6)', () => {
		expect(isBlankDateText(null)).toBe(true);
		expect(isBlankDateText(undefined)).toBe(true);
		expect(isBlankDateText('')).toBe(true);
		expect(isBlankDateText('  ')).toBe(true);
		expect(isBlankDateText('2026-11-07')).toBe(false);
	});
});

describe('canonical dates', () => {
	it('parseIsoDate / isIsoDate are strict', () => {
		expect(parseIsoDate('2026-11-07')).toEqual({ year: 2026, month: 11, day: 7 });
		expect(isIsoDate('2026-11-07')).toBe(true);
		expect(isIsoDate('2026/11/07')).toBe(false);
		expect(isIsoDate('2026-1-7')).toBe(false);
		expect(isIsoDate('2026-02-29')).toBe(false);
		expect(isIsoDate('2024-02-29')).toBe(true);
	});

	it('leap years and month lengths', () => {
		expect([1900, 2000, 2024, 2025, 2100].map(isLeapYear)).toEqual([
			false,
			true,
			true,
			false,
			false
		]);
		expect(daysInMonth(2024, 2)).toBe(29);
		expect(daysInMonth(2025, 2)).toBe(28);
		expect(daysInMonth(2026, 4)).toBe(30);
		expect(daysInMonth(2026, 12)).toBe(31);
	});
});

describe('calendar arithmetic', () => {
	it('day numbers round-trip and match the epoch', () => {
		expect(daysFromCivil({ year: 1970, month: 1, day: 1 })).toBe(0);
		expect(daysFromCivil({ year: 2000, month: 3, day: 1 })).toBe(11017);
		for (const days of [-719162, -1, 0, 59, 11016, 20399, 2932896]) {
			expect(daysFromCivil(civilFromDays(days))).toBe(days);
		}
	});

	it('addDays crosses months, years and leap days', () => {
		expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
		expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2026-11-07', -7)).toBe('2026-10-31');
	});

	it('addDays clamps to 0001-01-01..9999-12-31', () => {
		expect(addDays('0001-01-01', -1)).toBe('0001-01-01');
		expect(addDays('9999-12-31', 1)).toBe('9999-12-31');
	});

	it('addMonths / addYears clamp the day to the target month', () => {
		expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
		expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
		expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
		expect(addMonths('2026-11-07', 2)).toBe('2027-01-07');
		expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
		expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
		expect(addYears('2026-11-07', -1)).toBe('2025-11-07');
		expect(addMonths('0001-01-15', -1)).toBe('0001-01-01');
		expect(addMonths('9999-12-15', 1)).toBe('9999-12-31');
	});

	it('dayOfWeek', () => {
		expect(dayOfWeek('1970-01-01')).toBe(4);
		expect(dayOfWeek('2026-11-07')).toBe(6); // Saturday
		expect(dayOfWeek('2026-11-08')).toBe(0);
		expect(dayOfWeek('2000-02-29')).toBe(2);
		expect(dayOfWeek('0001-01-01')).toBe(1);
	});

	it('start / end of week honour weekStartsOn', () => {
		expect(startOfWeek('2026-11-07', 0)).toBe('2026-11-01');
		expect(endOfWeek('2026-11-07', 0)).toBe('2026-11-07');
		expect(startOfWeek('2026-11-07', 1)).toBe('2026-11-02');
		expect(endOfWeek('2026-11-07', 1)).toBe('2026-11-08');
		expect(startOfWeek('2026-11-01', 1)).toBe('2026-10-26');
	});

	it('monthGrid: 6 weeks of 7 days from the week start on or before the 1st', () => {
		const sunday = monthGrid('2026-11-07', 0);
		expect(sunday).toHaveLength(6);
		expect(sunday.every((week) => week.length === 7)).toBe(true);
		expect(sunday[0][0]).toBe('2026-11-01'); // 2026-11-01 is a Sunday
		expect(sunday[5][6]).toBe('2026-12-12');
		const monday = monthGrid('2026-11-30', 1);
		expect(monday[0][0]).toBe('2026-10-26');
		expect(monday.flat()).toContain('2026-11-30');
	});

	it('monthGrid: positions before 0001-01-01 / after 9999-12-31 are empty slots, not clamped', () => {
		// 0001-01-01 was a Monday.
		const first = monthGrid('0001-01-15', 0);
		expect(first[0][0]).toBeNull();
		expect(first[0][1]).toBe('0001-01-01');
		expect(first.flat().filter((d) => d === '0001-01-01')).toHaveLength(1);
		expect(monthGrid('0001-01-15', 1)[0][0]).toBe('0001-01-01');
		const last = monthGrid('9999-12-15', 0);
		const cells = last.flat();
		expect(cells.filter((d) => d === '9999-12-31')).toHaveLength(1);
		const end = cells.indexOf('9999-12-31');
		expect(cells.slice(end + 1).every((d) => d === null)).toBe(true);
		expect(cells.slice(0, end + 1).every((d) => d !== null)).toBe(true);
		// Weekday columns stay true: the cell's column is its weekday.
		expect(end % 7).toBe(dayOfWeek('9999-12-31'));
		// An ordinary month has no empty slot.
		expect(monthGrid('2026-11-07', 0).flat().includes(null)).toBe(false);
	});

	it('range helpers compare canonical strings, bounds inclusive', () => {
		expect(isOutOfRange('2026-11-07', '2026-11-07', '2026-11-07')).toBe(false);
		expect(isOutOfRange('2026-11-06', '2026-11-07')).toBe(true);
		expect(isOutOfRange('2026-11-08', undefined, '2026-11-07')).toBe(true);
		expect(isOutOfRange('2026-11-08')).toBe(false);
		expect(clampDate('2026-01-01', '2026-03-01', '2026-04-01')).toBe('2026-03-01');
		expect(clampDate('2026-05-01', '2026-03-01', '2026-04-01')).toBe('2026-04-01');
		expect(clampDate('2026-03-15', '2026-03-01', '2026-04-01')).toBe('2026-03-15');
	});

	describe('todayDate', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it('is the local calendar date', () => {
			expect(todayDate(new Date(2026, 10, 7, 23, 59))).toBe('2026-11-07');
			vi.useFakeTimers();
			vi.setSystemTime(new Date(2026, 0, 2, 0, 1));
			expect(todayDate()).toBe('2026-01-02');
		});
	});
});

describe('Intl names (§5.5)', () => {
	it('full dates and month headings follow the locale', () => {
		expect(formatFullDate('2026-11-07', 'ja-JP')).toBe('2026年11月7日土曜日');
		expect(formatFullDate('2026-11-07', 'en-US')).toBe('Saturday, November 7, 2026');
		expect(formatMonthYear('2026-11-07', 'ja-JP')).toBe('2026年11月');
		expect(formatMonthYear('2026-11-07', 'en-US')).toBe('November 2026');
	});

	it('does not shift the day in any time zone (UTC noon) and handles years below 100', () => {
		expect(formatFullDate('0050-03-01', 'en-US')).toContain('50');
		expect(formatFullDate('0050-03-01', 'en-US')).toContain('March 1');
	});

	it('always uses the Gregorian calendar, whatever the locale default (fa-IR, -u-ca-japanese)', () => {
		const fa = formatMonthYear('2026-11-07', 'fa-IR');
		expect(fa).toBe(
			new Intl.DateTimeFormat('fa-IR', {
				year: 'numeric',
				month: 'long',
				calendar: 'gregory',
				timeZone: 'UTC'
			}).format(new Date(Date.UTC(2026, 10, 7, 12)))
		);
		// Not the Persian year (1405) - the Gregorian 2026 in Persian digits.
		expect(fa).not.toMatch(/۱۴۰۵|1405/);
		expect(fa).toMatch(/۲۰۲۶|2026/);
		expect(formatMonthYear('2026-11-07', 'ja-JP-u-ca-japanese')).toBe('2026年11月');
		expect(formatFullDate('2026-11-07', 'ja-JP-u-ca-japanese')).toBe('2026年11月7日土曜日');
		expect(formatFullDate('2026-11-07', 'th-TH')).toContain('2026');
	});

	it('weekday names start at weekStartsOn', () => {
		const ja = weekdayNames('ja-JP', 0);
		expect(ja.map((d) => d.short)).toEqual(['日', '月', '火', '水', '木', '金', '土']);
		expect(ja[0].long).toBe('日曜日');
		const en = weekdayNames('en-US', 1);
		expect(en[0]).toEqual({ weekday: 1, short: 'Mon', long: 'Monday' });
		expect(en[6].weekday).toBe(0);
	});

	it('resolveWeekStart: prop, then the locale, then Sunday (D15)', () => {
		expect(resolveWeekStart('ja-JP', 1)).toBe(1);
		expect(resolveWeekStart('ja-JP', 0)).toBe(0);
		// An out-of-range prop is ignored.
		expect([0, 1]).toContain(resolveWeekStart('en-GB', 9));
		const gb = resolveWeekStart('en-GB');
		// Node with week info says Monday for en-GB; without it, Sunday.
		expect([0, 1]).toContain(gb);
		expect(resolveWeekStart('not a locale tag!!')).toBe(0);
	});

	it('resolveWeekStart falls back to Sunday when Intl.Locale has no week info', () => {
		const proto = Intl.Locale.prototype as unknown as Record<string, unknown>;
		const original = Object.getOwnPropertyDescriptor(proto, 'getWeekInfo');
		const originalGetter = Object.getOwnPropertyDescriptor(proto, 'weekInfo');
		try {
			Object.defineProperty(proto, 'getWeekInfo', { value: undefined, configurable: true });
			Object.defineProperty(proto, 'weekInfo', { get: () => undefined, configurable: true });
			expect(resolveWeekStart('en-GB')).toBe(0);
		} finally {
			if (original) Object.defineProperty(proto, 'getWeekInfo', original);
			else delete proto.getWeekInfo;
			if (originalGetter) Object.defineProperty(proto, 'weekInfo', originalGetter);
			else delete proto.weekInfo;
		}
	});

	it('resolveWeekStart maps firstDay 7 (Sunday) to 0 and 1 (Monday) to 1', () => {
		const proto = Intl.Locale.prototype as unknown as Record<string, unknown>;
		const original = Object.getOwnPropertyDescriptor(proto, 'getWeekInfo');
		try {
			Object.defineProperty(proto, 'getWeekInfo', {
				value() {
					return { firstDay: (this as Intl.Locale).language === 'fr' ? 1 : 7 };
				},
				configurable: true
			});
			expect(resolveWeekStart('fr-FR')).toBe(1);
			expect(resolveWeekStart('ja-JP')).toBe(0);
		} finally {
			if (original) Object.defineProperty(proto, 'getWeekInfo', original);
			else delete proto.getWeekInfo;
		}
	});
});
