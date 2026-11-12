import { afterEach, describe, expect, it } from 'vitest';
import {
	businessDateAt,
	businessToday,
	currentPeriod,
	monthWithPeriod,
	periodName,
	periodOfMonth,
	setBusinessCalendarForTest,
	type BusinessCalendar
} from './businessCalendar.svelte';
import { todayIso } from './costFormat';

const CAL: BusinessCalendar = {
	today: '2026-11-12',
	nowMs: Date.UTC(2026, 10, 12, 8, 0, 0),
	timeZone: 'Asia/Tokyo',
	utcOffsetMinutes: 540,
	startMonth: 6,
	basePeriod: 13,
	baseStartYear: 2026,
	currentPeriod: 13,
	periods: [
		{
			period: 13,
			label: '第13期（2026年6月〜2027年5月）',
			firstMonth: '2026-06',
			lastMonth: '2027-05'
		}
	]
};

afterEach(() => setBusinessCalendarForTest(null));

describe('businessDateAt', () => {
	it('reads the date in Asia/Tokyo, not the device time zone', () => {
		// 2026-11-30T15:00Z is 2026-12-01 00:00 in Tokyo.
		const midnight = Date.UTC(2026, 10, 30, 15, 0, 0);
		expect(businessDateAt(midnight - 1000, CAL)).toBe('2026-11-30');
		expect(businessDateAt(midnight, CAL)).toBe('2026-12-01');
	});

	it('makes todayIso the business date once the calendar is loaded', () => {
		setBusinessCalendarForTest(CAL);
		const morning = new Date(Date.UTC(2026, 10, 30, 23, 30, 0)); // 08:30 on 12-01 in Tokyo
		expect(todayIso(morning)).toBe('2026-12-01');
		expect(businessToday(morning.getTime())).toBe('2026-12-01');
	});
});

describe('device clock', () => {
	it('counts from the server clock when the device clock is off', () => {
		// The device runs 10 minutes slow: 23:55 on its clock is 00:05 on the server's.
		setBusinessCalendarForTest(CAL, 10 * 60_000);
		const device = Date.UTC(2026, 10, 30, 14, 55, 0); // 23:55 in Tokyo by the device
		expect(businessToday(device)).toBe('2026-12-01');
		setBusinessCalendarForTest(CAL, 0);
		expect(businessToday(device)).toBe('2026-11-30');
	});
});

describe('periods', () => {
	it('T15: 第13期 is 2026-06 to 2027-05', () => {
		expect(periodOfMonth('2026-06', CAL)).toBe(13);
		expect(periodOfMonth('2027-05-31', CAL)).toBe(13);
		expect(periodOfMonth('2026-05', CAL)).toBe(12);
		expect(periodOfMonth('2027-06', CAL)).toBe(14);
		expect(periodOfMonth('', CAL)).toBeNull();
	});

	it('labels a month with its period, or the month alone without a calendar', () => {
		expect(monthWithPeriod('2026-11', CAL)).toBe('2026-11（第13期）');
		expect(periodName('2027-06', CAL)).toBe('第14期');
		expect(monthWithPeriod('2026-11', null)).toBe('2026-11');
		expect(periodName('', CAL)).toBe('');
	});

	it('knows the current period only with a calendar', () => {
		const now = Date.UTC(2027, 4, 31, 15, 0, 0); // 2027-06-01 00:00 in Tokyo
		expect(currentPeriod(now)).toBeNull();
		setBusinessCalendarForTest(CAL);
		expect(currentPeriod(now)).toBe(14);
		expect(currentPeriod(now - 1000)).toBe(13);
	});
});
