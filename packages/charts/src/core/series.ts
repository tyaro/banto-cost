/**
 * LineChart series value conversion + gap segmentation (pure, unit-tested).
 *
 * `gaps="join"` (default) keeps the original behaviour byte-for-byte: values go
 * through `Number(...)` (so `null` is `0`), non-finite points are skipped and
 * the neighbours are connected. `gaps="break"` treats `null` / `undefined` /
 * NaN as MISSING (NaN) BEFORE numeric coercion, and splits the line there.
 */
import type { Point } from './path';

export type GapMode = 'join' | 'break';

/** Raw accessor result -> number. `break`: null/undefined become NaN (missing) instead of `Number(null) === 0`. `join`: plain `Number(raw)`. */
export function seriesNumber(raw: unknown, gaps: GapMode = 'join'): number {
	if (gaps === 'break' && (raw === null || raw === undefined)) return NaN;
	return Number(raw);
}

/**
 * Point segments for the (possibly decimated, ascending) visible `indices`.
 * `join`: one segment of all finite points. `break`: a new segment after every
 * non-finite point, and also where decimation jumped over a non-finite point
 * between two kept indices (so a hole is never bridged).
 */
export function seriesSegments(
	vals: number[],
	indices: number[],
	xAt: (index: number) => number,
	yAt: (value: number) => number,
	gaps: GapMode = 'join'
): Point[][] {
	if (gaps !== 'break') {
		const pts: Point[] = [];
		for (const idx of indices) {
			const v = vals[idx];
			if (Number.isFinite(v)) pts.push({ x: xAt(idx), y: yAt(v) });
		}
		return [pts];
	}
	const segs: Point[][] = [];
	let cur: Point[] = [];
	let prev = -1;
	for (const idx of indices) {
		let hole = false;
		for (let k = prev + 1; prev >= 0 && k < idx; k++) {
			if (!Number.isFinite(vals[k])) {
				hole = true;
				break;
			}
		}
		if (hole && cur.length > 0) {
			segs.push(cur);
			cur = [];
		}
		const v = vals[idx];
		if (Number.isFinite(v)) cur.push({ x: xAt(idx), y: yAt(v) });
		else if (cur.length > 0) {
			segs.push(cur);
			cur = [];
		}
		prev = idx;
	}
	if (cur.length > 0) segs.push(cur);
	return segs;
}
