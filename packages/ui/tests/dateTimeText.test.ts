/**
 * datetime.ts dates and times (docs/design/date-time-pickers.md §5.1 / §5.3,
 * D4 / D7, PR-5): the canonical `YYYY-MM-DDTHH:mm`, the shown form with a
 * space, and the lenient parse of typed text (a date, a space or `T`, a time).
 */
import { describe, expect, it } from 'vitest';
import {
	formatDateTimeText,
	isIsoDateTime,
	isOutOfRange,
	joinDateTime,
	parseDateTimeText,
	parseIsoDateTime
} from '../src/datetime';

describe('canonical dates and times', () => {
	it('parses YYYY-MM-DDTHH:mm with a real day and 00:00..23:59 only', () => {
		expect(parseIsoDateTime('2026-11-07T09:30')).toEqual({ date: '2026-11-07', time: '09:30' });
		expect(parseIsoDateTime('2024-02-29T00:00')).toEqual({ date: '2024-02-29', time: '00:00' });
		expect(parseIsoDateTime('9999-12-31T23:59')).toEqual({ date: '9999-12-31', time: '23:59' });
		for (const bad of [
			'2026-11-07 09:30',
			'2026-11-07t09:30',
			'2026-11-07T09:30:00',
			'2026-11-07T9:30',
			'2026-11-07T24:00',
			'2026-11-07T23:60',
			'2025-02-29T09:00',
			'0000-01-01T00:00',
			'2026-11-07',
			'2026-11-07T09:30Z',
			'2026-11-07T09:30+09:00',
			''
		]) {
			expect(parseIsoDateTime(bad), bad).toBeNull();
			expect(isIsoDateTime(bad), bad).toBe(false);
		}
	});

	it('joins and shows with a space; anything else is shown unchanged', () => {
		expect(joinDateTime('2026-11-07', '09:30')).toBe('2026-11-07T09:30');
		expect(formatDateTimeText('2026-11-07T09:30')).toBe('2026-11-07 09:30');
		expect(formatDateTimeText(null)).toBe('');
		expect(formatDateTimeText(undefined)).toBe('');
		expect(formatDateTimeText('2026/11/7 9')).toBe('2026/11/7 9');
	});

	it('string order is time order (isOutOfRange works on them)', () => {
		expect('2026-11-07T09:30' < '2026-11-07T10:00').toBe(true);
		expect('2026-11-07T23:59' < '2026-11-08T00:00').toBe(true);
		expect(isOutOfRange('2026-11-07T08:59', '2026-11-07T09:00')).toBe(true);
		expect(isOutOfRange('2026-11-07T09:00', '2026-11-07T09:00', '2026-11-07T18:00')).toBe(false);
		expect(isOutOfRange('2026-11-07T18:00', undefined, '2026-11-07T18:00')).toBe(false);
		expect(isOutOfRange('2026-11-07T18:01', undefined, '2026-11-07T18:00')).toBe(true);
	});
});

describe('parseDateTimeText (§5.3, D7)', () => {
	it('takes a lenient date and a lenient time joined by a space or T', () => {
		const cases: [string, string][] = [
			['2026-11-07T09:30', '2026-11-07T09:30'],
			['2026-11-07 09:30', '2026-11-07T09:30'],
			['2026/11/7 9:30', '2026-11-07T09:30'],
			['2026.11.07   0930', '2026-11-07T09:30'],
			['20261107 930', '2026-11-07T09:30'],
			['20261107T0930', '2026-11-07T09:30'],
			['2026/11/7 9', '2026-11-07T09:00'],
			['2026-11-07 00:00', '2026-11-07T00:00'],
			['2026-11-07 23:59', '2026-11-07T23:59'],
			['2024/2/29 12:00', '2024-02-29T12:00'],
			['２０２６／１１／７　９：３０', '2026-11-07T09:30'],
			['  2026-11-07 09:30  ', '2026-11-07T09:30']
		];
		for (const [text, expected] of cases) expect(parseDateTimeText(text), text).toBe(expected);
	});

	it('fills the year of M/D from currentYear (typed text only)', () => {
		expect(parseDateTimeText('11/7 9:30', 2026)).toBe('2026-11-07T09:30');
		expect(parseDateTimeText('2/29 0:00', 2024)).toBe('2024-02-29T00:00');
		expect(parseDateTimeText('2/29 0:00', 2025)).toBeNull();
	});

	it('refuses a missing part, seconds, other orders and impossible values', () => {
		for (const bad of [
			'',
			'   ',
			'2026-11-07',
			'09:30',
			'2026-11-07 09:30:00',
			'2026-11-07 24:00',
			'2026-11-07 9:60',
			'2025/2/29 9:00',
			'11/07/2026 09:30',
			'2026-11-07 9:30 AM',
			'2026-11-07T 09:30',
			'2026-11-07t09:30',
			'2026-11-07 09:30Z'
		]) {
			expect(parseDateTimeText(bad, 2026), bad).toBeNull();
		}
	});
});
