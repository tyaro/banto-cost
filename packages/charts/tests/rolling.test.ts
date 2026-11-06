import { describe, expect, it } from 'vitest';
import { evictBefore, rollingAppend } from '../src/core/rolling';

describe('rollingAppend', () => {
	it('appends incoming items when under the cap', () => {
		expect(rollingAppend([1, 2], [3, 4], 10)).toEqual([1, 2, 3, 4]);
	});

	it('drops the oldest items from the front once over the cap', () => {
		expect(rollingAppend([1, 2, 3], [4, 5], 4)).toEqual([2, 3, 4, 5]);
	});

	it('trims correctly even when incoming alone exceeds the cap', () => {
		expect(rollingAppend([], [1, 2, 3, 4, 5], 2)).toEqual([4, 5]);
	});

	it('returns [] for maxCount <= 0', () => {
		expect(rollingAppend([1, 2], [3], 0)).toEqual([]);
		expect(rollingAppend([1, 2], [3], -5)).toEqual([]);
	});

	it('floors a non-integer maxCount', () => {
		expect(rollingAppend([1, 2, 3], [4], 3.9)).toEqual([2, 3, 4]);
	});

	it('does not mutate the input arrays', () => {
		const data = [1, 2, 3];
		const incoming = [4, 5];
		rollingAppend(data, incoming, 2);
		expect(data).toEqual([1, 2, 3]);
		expect(incoming).toEqual([4, 5]);
	});

	it('handles empty incoming (no-op append)', () => {
		expect(rollingAppend([1, 2, 3], [], 10)).toEqual([1, 2, 3]);
	});
});

describe('evictBefore', () => {
	interface Sample {
		t: number;
	}
	const time = (s: Sample) => s.t;

	it('drops leading items with time < cutoff', () => {
		const data: Sample[] = [{ t: 1 }, { t: 2 }, { t: 3 }, { t: 4 }];
		expect(evictBefore(data, time, 3)).toEqual([{ t: 3 }, { t: 4 }]);
	});

	it('keeps everything when cutoff is before all items', () => {
		const data: Sample[] = [{ t: 5 }, { t: 6 }];
		expect(evictBefore(data, time, 0)).toEqual(data);
	});

	it('drops everything when cutoff is after all items', () => {
		const data: Sample[] = [{ t: 1 }, { t: 2 }];
		expect(evictBefore(data, time, 100)).toEqual([]);
	});

	it('handles an empty array', () => {
		expect(evictBefore<Sample>([], time, 5)).toEqual([]);
	});

	it('does not mutate the input array', () => {
		const data: Sample[] = [{ t: 1 }, { t: 2 }, { t: 3 }];
		evictBefore(data, time, 2);
		expect(data).toEqual([{ t: 1 }, { t: 2 }, { t: 3 }]);
	});

	it('keeps an item exactly at the cutoff (cutoff is exclusive on the low side)', () => {
		const data: Sample[] = [{ t: 1 }, { t: 2 }, { t: 3 }];
		expect(evictBefore(data, time, 2)).toEqual([{ t: 2 }, { t: 3 }]);
	});
});
