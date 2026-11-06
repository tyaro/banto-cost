import { describe, expect, it } from 'vitest';
import { resolveBand } from '../src/core/band';

describe('resolveBand', () => {
	const domain: [number, number] = [0, 100];

	it('returns a finite in-range band unchanged, both edges drawn', () => {
		expect(resolveBand(20, 60, domain)).toEqual({
			low: 20,
			high: 60,
			lowEdge: true,
			highEdge: true
		});
	});

	it('accepts from/to in either order', () => {
		expect(resolveBand(60, 20, domain)).toEqual(resolveBand(20, 60, domain));
	});

	it('keeps a band touching the domain edges unchanged with edges drawn', () => {
		expect(resolveBand(0, 100, domain)).toEqual({
			low: 0,
			high: 100,
			lowEdge: true,
			highEdge: true
		});
	});

	it('treats null / NaN / infinities as open toward the plot edge (no edge line)', () => {
		expect(resolveBand(null, 40, domain)).toEqual({
			low: 0,
			high: 40,
			lowEdge: false,
			highEdge: true
		});
		expect(resolveBand(70, null, domain)).toEqual({
			low: 70,
			high: 100,
			lowEdge: true,
			highEdge: false
		});
		expect(resolveBand(-Infinity, 40, domain)).toEqual(resolveBand(null, 40, domain));
		expect(resolveBand(70, Infinity, domain)).toEqual(resolveBand(70, null, domain));
		expect(resolveBand(NaN, NaN, domain)).toEqual({
			low: 0,
			high: 100,
			lowEdge: false,
			highEdge: false
		});
	});

	it('clips a partly outside band to the domain and drops the clipped edge line', () => {
		expect(resolveBand(-50, 40, domain)).toEqual({
			low: 0,
			high: 40,
			lowEdge: false,
			highEdge: true
		});
		expect(resolveBand(80, 500, domain)).toEqual({
			low: 80,
			high: 100,
			lowEdge: true,
			highEdge: false
		});
	});

	it('returns null for a band entirely outside the domain', () => {
		expect(resolveBand(-20, -5, domain)).toBeNull();
		expect(resolveBand(120, 200, domain)).toBeNull();
	});

	it('works with an inverted domain', () => {
		expect(resolveBand(20, 60, [100, 0])).toEqual(resolveBand(20, 60, [0, 100]));
	});
});

describe('resolveBand: ±Infinity is open by position (before ordering)', () => {
	const domain: [number, number] = [0, 100];
	const open = (low: number, high: number, lowEdge: boolean, highEdge: boolean) => ({
		low,
		high,
		lowEdge,
		highEdge
	});

	it('a non-finite from is the low edge even when +Infinity', () => {
		expect(resolveBand(Infinity, 40, domain)).toEqual(open(0, 40, false, true));
	});

	it('a non-finite to is the high edge even when -Infinity', () => {
		expect(resolveBand(70, -Infinity, domain)).toEqual(open(70, 100, true, false));
	});

	it('both open (any infinities) is the full band', () => {
		expect(resolveBand(Infinity, Infinity, domain)).toEqual(open(0, 100, false, false));
		expect(resolveBand(-Infinity, -Infinity, domain)).toEqual(open(0, 100, false, false));
		expect(resolveBand(undefined, undefined, domain)).toEqual(open(0, 100, false, false));
	});
});
