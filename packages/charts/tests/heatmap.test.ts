import { describe, expect, it } from 'vitest';
import { heatmapCellKey, heatmapGrid } from '../src/core/heatmap';

interface Row {
	x: string;
	y: string;
	v: number;
}

describe('heatmapGrid', () => {
	it('orders categories by first appearance, not sorted', () => {
		const rows: Row[] = [
			{ x: 'b', y: 'Z', v: 1 },
			{ x: 'a', y: 'A', v: 2 },
			{ x: 'b', y: 'A', v: 3 }
		];
		const grid = heatmapGrid(
			rows,
			(r) => r.x,
			(r) => r.y,
			(r) => r.v
		);
		expect(grid.xCats).toEqual(['b', 'a']);
		expect(grid.yCats).toEqual(['Z', 'A']);
	});

	it('does not duplicate a category seen more than once', () => {
		const rows: Row[] = [
			{ x: 'a', y: '1', v: 1 },
			{ x: 'a', y: '2', v: 2 }
		];
		const grid = heatmapGrid(
			rows,
			(r) => r.x,
			(r) => r.y,
			(r) => r.v
		);
		expect(grid.xCats).toEqual(['a']);
		expect(grid.yCats).toEqual(['1', '2']);
	});

	it('stores each (x, y) cell value, retrievable via heatmapCellKey', () => {
		const rows: Row[] = [{ x: 'mon', y: 'wk1', v: 42 }];
		const grid = heatmapGrid(
			rows,
			(r) => r.x,
			(r) => r.y,
			(r) => r.v
		);
		expect(grid.cells.get(heatmapCellKey('mon', 'wk1'))).toBe(42);
	});

	it('keeps the LAST value when the same (x, y) combination repeats', () => {
		const rows: Row[] = [
			{ x: 'a', y: 'b', v: 1 },
			{ x: 'a', y: 'b', v: 2 },
			{ x: 'a', y: 'b', v: 3 }
		];
		const grid = heatmapGrid(
			rows,
			(r) => r.x,
			(r) => r.y,
			(r) => r.v
		);
		expect(grid.cells.get(heatmapCellKey('a', 'b'))).toBe(3);
	});

	it('computes min/max across all stored cell values', () => {
		const rows: Row[] = [
			{ x: 'a', y: '1', v: 5 },
			{ x: 'b', y: '1', v: -3 },
			{ x: 'c', y: '1', v: 10 }
		];
		const grid = heatmapGrid(
			rows,
			(r) => r.x,
			(r) => r.y,
			(r) => r.v
		);
		expect(grid.min).toBe(-3);
		expect(grid.max).toBe(10);
	});

	it('handles empty data: empty category lists, no cells, min/max both 0', () => {
		const grid = heatmapGrid<Row>(
			[],
			(r) => r.x,
			(r) => r.y,
			(r) => r.v
		);
		expect(grid.xCats).toEqual([]);
		expect(grid.yCats).toEqual([]);
		expect(grid.cells.size).toBe(0);
		expect(grid.min).toBe(0);
		expect(grid.max).toBe(0);
	});

	it('drops non-finite values (NaN) rather than storing them as a cell', () => {
		const rows: Row[] = [{ x: 'a', y: 'b', v: NaN }];
		const grid = heatmapGrid(
			rows,
			(r) => r.x,
			(r) => r.y,
			(r) => r.v
		);
		expect(grid.cells.has(heatmapCellKey('a', 'b'))).toBe(false);
		expect(grid.xCats).toEqual(['a']);
	});
});
