import { describe, expect, it } from 'vitest';
import { getValue, toNumber } from '../src/types';

interface Row {
	name: string;
	amount: number;
}

describe('getValue', () => {
	it('reads via a key accessor', () => {
		expect(getValue<Row>({ name: 'a', amount: 5 }, 'amount')).toBe(5);
	});

	it('reads via a function accessor', () => {
		expect(getValue<Row>({ name: 'a', amount: 5 }, (row) => row.name.toUpperCase())).toBe('A');
	});
});

describe('toNumber', () => {
	it('coerces numeric-looking values', () => {
		expect(toNumber(5)).toBe(5);
		expect(toNumber('5')).toBe(5);
		expect(toNumber('5.5')).toBe(5.5);
	});

	it('returns NaN for non-numeric values (caller skips the row)', () => {
		expect(Number.isNaN(toNumber('abc'))).toBe(true);
		expect(Number.isNaN(toNumber(undefined))).toBe(true);
		expect(Number.isNaN(toNumber(null))).toBe(false); // Number(null) === 0, matches spec's plain `Number(value)` rule
	});
});
