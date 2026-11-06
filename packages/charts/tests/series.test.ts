import { describe, expect, it } from 'vitest';
import { seriesNumber, seriesSegments } from '../src/core/series';
import { decimatedIndices } from '../src/core/decimate';
import { areaPathSegments, linePath, linePathSegments } from '../src/core/path';

const xAt = (i: number) => i * 10;
const yAt = (v: number) => 100 - v;
const all = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('seriesNumber', () => {
	it('join keeps Number() coercion byte-identical (null -> 0)', () => {
		expect(seriesNumber(null)).toBe(0);
		expect(seriesNumber(null, 'join')).toBe(0);
		expect(seriesNumber(undefined, 'join')).toBeNaN();
		expect(seriesNumber('7', 'join')).toBe(7);
	});

	it('break turns null/undefined/NaN into missing (NaN), not 0', () => {
		expect(seriesNumber(null, 'break')).toBeNaN();
		expect(seriesNumber(undefined, 'break')).toBeNaN();
		expect(seriesNumber(NaN, 'break')).toBeNaN();
		expect(seriesNumber('abc', 'break')).toBeNaN();
	});

	it('break keeps real values, including 0', () => {
		expect(seriesNumber(0, 'break')).toBe(0);
		expect(seriesNumber(12, 'break')).toBe(12);
		expect(seriesNumber('7', 'break')).toBe(7);
	});
});

describe('entry point: accessor result -> values -> path', () => {
	const rows: unknown[] = [10, null, 20, undefined, 30, NaN, 40];
	const run = (gaps: 'join' | 'break', indices = all(rows.length)) => {
		const vals = rows.map((r) => seriesNumber(r, gaps));
		return linePathSegments(seriesSegments(vals, indices, xAt, yAt, gaps));
	};

	it('break: null/undefined/NaN each split the line (no 0 point)', () => {
		expect(run('break')).toBe('M 0 90 M 20 80 M 40 70 M 60 60');
	});

	it('join: null still plots as 0 (unchanged); undefined/NaN skipped', () => {
		expect(run('join')).toBe('M 0 90 L 10 100 L 20 80 L 40 70 L 60 60');
	});

	it('join output equals linePath of the finite points (byte-identical)', () => {
		const vals = rows.map((r) => seriesNumber(r, 'join'));
		const pts = vals.flatMap((v, i) => (Number.isFinite(v) ? [{ x: xAt(i), y: yAt(v) }] : []));
		expect(run('join')).toBe(linePath(pts));
	});

	it('area closes one subpath per segment under break', () => {
		const vals = [10, null, 20, 30].map((r) => seriesNumber(r, 'break'));
		const segs = seriesSegments(vals, all(4), xAt, yAt, 'break');
		expect(areaPathSegments(segs, 200)).toBe(
			'M 0 90 L 0 200 Z M 20 80 L 30 70 L 30 200 L 20 200 Z'
		);
	});

	it('break: all-missing yields no segments / empty path', () => {
		const vals = [null, undefined].map((r) => seriesNumber(r, 'break'));
		expect(seriesSegments(vals, all(2), xAt, yAt, 'break')).toEqual([]);
	});
});

describe('seriesSegments with decimation', () => {
	it('break: a hole between two kept (strided) indices still splits', () => {
		const n = 100;
		const vals = all(n).map((i) => (i === 51 ? NaN : i));
		const idx = decimatedIndices(0, n - 1, 10); // stride 10 -> 0,10,...,90,99
		expect(idx).not.toContain(51);
		const segs = seriesSegments(vals, idx, xAt, yAt, 'break');
		expect(segs).toHaveLength(2);
		expect(segs[0][segs[0].length - 1].x).toBe(xAt(50));
		expect(segs[1][0].x).toBe(xAt(60));
	});

	it('join: the same decimated hole is bridged (original behaviour)', () => {
		const n = 100;
		const vals = all(n).map((i) => (i === 51 ? NaN : i));
		const idx = decimatedIndices(0, n - 1, 10);
		expect(seriesSegments(vals, idx, xAt, yAt, 'join')).toHaveLength(1);
	});

	it('break without a hole in the decimated window stays one segment', () => {
		const vals = all(100);
		const idx = decimatedIndices(0, 99, 10);
		expect(seriesSegments(vals, idx, xAt, yAt, 'break')).toHaveLength(1);
	});
});
