/**
 * banto-cost P4b display rules of the time screens: minutes as h:mm, weeks
 * from Monday, hours+minutes input to integer minutes.
 */
import { describe, expect, it } from 'vitest';
import * as m from '#lib/paraglide/messages.js';
import {
	addDays,
	dayLabel,
	formatMinutes,
	mondayOf,
	reworkLabel,
	timeStatusLabel,
	toMinutes,
	weekDates,
	warningText
} from './timeFormat';

describe('timeFormat', () => {
	it('formats minutes as h:mm', () => {
		expect(formatMinutes(0)).toBe('0:00');
		expect(formatMinutes(450)).toBe('7:30');
		expect(formatMinutes(140 * 60)).toBe('140:00');
		expect(formatMinutes(-15)).toBe('-0:15');
	});

	it('turns hours and minutes into whole minutes', () => {
		expect(toMinutes('7', '30')).toBe(450);
		expect(toMinutes('', '45')).toBe(45);
		expect(toMinutes(1.5, 0)).toBeNull();
		expect(toMinutes('-1', '0')).toBeNull();
	});

	it('walks weeks from Monday across months and years', () => {
		expect(mondayOf('2026-11-09')).toBe('2026-11-09');
		expect(mondayOf('2026-11-15')).toBe('2026-11-09');
		expect(mondayOf('2027-01-01')).toBe('2026-12-28');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
		expect(weekDates('2026-11-09')).toEqual([
			'2026-11-09',
			'2026-11-10',
			'2026-11-11',
			'2026-11-12',
			'2026-11-13',
			'2026-11-14',
			'2026-11-15'
		]);
		expect(addDays('not-a-date', 1)).toBe('not-a-date');
	});

	it('labels days, statuses, rework and warnings', () => {
		expect(dayLabel('2026-11-09')).toContain('11');
		expect(timeStatusLabel('approved')).toBe(m['time.status.approved']());
		expect(timeStatusLabel('x')).toBe('x');
		expect(reworkLabel(null)).toBe(m['time.rework.none']());
		expect(warningText({ code: 'day_standard', total: 240, standard: 480 })).toContain('4:00');
	});
});
