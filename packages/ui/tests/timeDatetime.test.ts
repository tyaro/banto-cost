/**
 * datetime.ts times (docs/design/date-time-pickers.md §5.1 / §5.3 / §5.6,
 * D7 / D8): the canonical `HH:mm`, lenient parsing of typed times, the step
 * list (edge values 00:00 / 23:59, steps that do not divide the day), the
 * step check and the nearest option.
 */
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TIME_STEP,
	formatTime,
	isIsoTime,
	isOnTimeStep,
	isOutOfRange,
	minutesToTime,
	nearestTime,
	normalizeTimeStep,
	parseIsoTime,
	parseTimeText,
	timeOptions,
	timeToMinutes
} from '../src/datetime';

describe('canonical times', () => {
	it('parses HH:mm in 00:00..23:59 only', () => {
		expect(parseIsoTime('00:00')).toEqual({ hour: 0, minute: 0 });
		expect(parseIsoTime('23:59')).toEqual({ hour: 23, minute: 59 });
		for (const bad of ['24:00', '23:60', '9:30', '09:3', '0930', '09:30:00', ' 09:30', '']) {
			expect(parseIsoTime(bad), bad).toBeNull();
			expect(isIsoTime(bad), bad).toBe(false);
		}
	});

	it('formats parts with two digits each', () => {
		expect(formatTime({ hour: 9, minute: 5 })).toBe('09:05');
	});

	it('converts to and from minutes of the day', () => {
		expect(timeToMinutes('00:00')).toBe(0);
		expect(timeToMinutes('23:59')).toBe(1439);
		expect(minutesToTime(0)).toBe('00:00');
		expect(minutesToTime(1439)).toBe('23:59');
		expect(() => minutesToTime(1440)).toThrow(RangeError);
		expect(() => minutesToTime(-1)).toThrow(RangeError);
		expect(() => timeToMinutes('24:00')).toThrow(RangeError);
	});

	it('string order is time order (isOutOfRange works on times)', () => {
		expect(isOutOfRange('08:59', '09:00', '18:00')).toBe(true);
		expect(isOutOfRange('09:00', '09:00', '18:00')).toBe(false);
		expect(isOutOfRange('18:00', '09:00', '18:00')).toBe(false);
		expect(isOutOfRange('18:01', '09:00', '18:00')).toBe(true);
	});
});

describe('parseTimeText (D7)', () => {
	it.each([
		['9:30', '09:30'],
		['09:30', '09:30'],
		['0930', '09:30'],
		['930', '09:30'],
		['9', '09:00'],
		['12', '12:00'],
		['0', '00:00'],
		['000', '00:00'],
		['2359', '23:59'],
		['  23:59 ', '23:59'],
		['０９：３０', '09:30'],
		['９', '09:00']
	])('%s -> %s', (text, expected) => {
		expect(parseTimeText(text)).toBe(expected);
	});

	it.each(['24:00', '2400', '24', '9:5', '9:60', '12345', '9:30 AM', '09:30:00', 'abc', '-1', ''])(
		'refuses %s',
		(text) => {
			expect(parseTimeText(text)).toBeNull();
		}
	);
});

describe('time steps (§5.6, D8)', () => {
	it('defaults the list to every 30 minutes, 00:00..23:30', () => {
		const list = timeOptions();
		expect(DEFAULT_TIME_STEP).toBe(30);
		expect(list).toHaveLength(48);
		expect(list[0]).toBe('00:00');
		expect(list[1]).toBe('00:30');
		expect(list.at(-1)).toBe('23:30');
	});

	it('a step of 1 lists every minute up to 23:59', () => {
		const list = timeOptions(1);
		expect(list).toHaveLength(1440);
		expect(list.at(-1)).toBe('23:59');
	});

	it('a step that does not divide the day ends before midnight instead of wrapping', () => {
		const list = timeOptions(25);
		expect(list.at(-1)).toBe('23:45');
		expect(new Set(list).size).toBe(list.length);
		expect([...list].sort()).toEqual(list);
		expect(timeOptions(7).at(-1)).toBe('23:55');
		expect(timeOptions(90).at(-1)).toBe('22:30');
	});

	it('a step of a day or more leaves 00:00 alone', () => {
		expect(timeOptions(1440)).toEqual(['00:00']);
		expect(timeOptions(5000)).toEqual(['00:00']);
	});

	it('an invalid step falls back to the default list and does not restrict values', () => {
		for (const bad of [0, -15, 7.5, Number.NaN, Infinity]) {
			expect(normalizeTimeStep(bad), String(bad)).toBeUndefined();
			expect(timeOptions(bad)).toHaveLength(48);
			expect(isOnTimeStep('10:17', bad)).toBe(true);
		}
		expect(normalizeTimeStep(undefined)).toBeUndefined();
		expect(normalizeTimeStep(null)).toBeUndefined();
		expect(normalizeTimeStep(15)).toBe(15);
	});

	it('isOnTimeStep counts from 00:00; without a step any minute passes', () => {
		expect(isOnTimeStep('10:15', 15)).toBe(true);
		expect(isOnTimeStep('10:20', 15)).toBe(false);
		expect(isOnTimeStep('00:00', 25)).toBe(true);
		expect(isOnTimeStep('23:20', 25)).toBe(true);
		expect(isOnTimeStep('23:44', 25)).toBe(false);
		expect(isOnTimeStep('10:17')).toBe(true);
	});
});

describe('nearestTime', () => {
	const list = timeOptions(30);

	it('picks the nearest option; a tie goes to the earlier one', () => {
		expect(nearestTime('10:00', list)).toBe('10:00');
		expect(nearestTime('10:14', list)).toBe('10:00');
		expect(nearestTime('10:15', list)).toBe('10:00');
		expect(nearestTime('10:16', list)).toBe('10:30');
	});

	it('does not wrap around midnight: 23:59 -> the last option', () => {
		expect(nearestTime('23:59', list)).toBe('23:30');
		expect(nearestTime('00:00', list)).toBe('00:00');
	});

	it('works on a filtered (min / max) list and returns null for none', () => {
		const inRange = list.filter((t) => !isOutOfRange(t, '09:00', '18:00'));
		expect(nearestTime('07:00', inRange)).toBe('09:00');
		expect(nearestTime('23:00', inRange)).toBe('18:00');
		expect(nearestTime('12:00', [])).toBeNull();
	});
});
