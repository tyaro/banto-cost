import { describe, expect, it } from 'vitest';
import { CellSelection } from '../src/selection.svelte';

const fields = ['id', 'name', 'price', 'stock'];

describe('CellSelection', () => {
	describe('setActive', () => {
		it('non-extending click collapses to a single cell (anchor === active, no rangeEnd)', () => {
			const selection = new CellSelection();
			selection.setActive(2, 'name', false);
			expect(selection.active).toEqual({ rowIndex: 2, field: 'name' });
			expect(selection.anchor).toEqual({ rowIndex: 2, field: 'name' });
			expect(selection.rangeEnd).toBeNull();
		});

		it('extending click keeps the prior anchor and sets rangeEnd', () => {
			const selection = new CellSelection();
			selection.setActive(2, 'name', false);
			selection.setActive(5, 'price', true);
			expect(selection.anchor).toEqual({ rowIndex: 2, field: 'name' });
			expect(selection.active).toEqual({ rowIndex: 5, field: 'price' });
			expect(selection.rangeEnd).toEqual({ rowIndex: 5, field: 'price' });
		});

		it('extending click with no prior anchor seeds the anchor from active (no-op active)', () => {
			const selection = new CellSelection();
			selection.setActive(3, 'id', true);
			expect(selection.anchor).toEqual({ rowIndex: 3, field: 'id' });
			expect(selection.active).toEqual({ rowIndex: 3, field: 'id' });
		});

		it('a later non-extending click collapses back to a single cell', () => {
			const selection = new CellSelection();
			selection.setActive(2, 'name', false);
			selection.setActive(5, 'price', true);
			selection.setActive(1, 'id', false);
			expect(selection.anchor).toEqual({ rowIndex: 1, field: 'id' });
			expect(selection.active).toEqual({ rowIndex: 1, field: 'id' });
			expect(selection.rangeEnd).toBeNull();
		});
	});

	describe('moveActive', () => {
		it('moves the active cell by (dRow, dField)', () => {
			const selection = new CellSelection();
			selection.setActive(2, 'name', false);
			selection.moveActive(1, 1, false, 10, fields);
			expect(selection.active).toEqual({ rowIndex: 3, field: 'price' });
			expect(selection.anchor).toEqual({ rowIndex: 3, field: 'price' });
		});

		it('clamps row movement at 0 and rowCount - 1', () => {
			const selection = new CellSelection();
			selection.setActive(0, 'name', false);
			selection.moveActive(-5, 0, false, 10, fields);
			expect(selection.active?.rowIndex).toBe(0);

			selection.setActive(9, 'name', false);
			selection.moveActive(5, 0, false, 10, fields);
			expect(selection.active?.rowIndex).toBe(9);
		});

		it('clamps field movement at the first and last ordered field (Tab does not wrap rows)', () => {
			const selection = new CellSelection();
			selection.setActive(4, 'id', false);
			selection.moveActive(0, -5, false, 10, fields);
			expect(selection.active).toEqual({ rowIndex: 4, field: 'id' });

			selection.setActive(4, 'stock', false);
			selection.moveActive(0, 5, false, 10, fields);
			expect(selection.active).toEqual({ rowIndex: 4, field: 'stock' });
		});

		it('is a no-op when there is no active cell', () => {
			const selection = new CellSelection();
			selection.moveActive(1, 0, false, 10, fields);
			expect(selection.active).toBeNull();
		});

		it('extend=true grows a range instead of collapsing it', () => {
			const selection = new CellSelection();
			selection.setActive(2, 'name', false);
			selection.moveActive(2, 1, true, 10, fields);
			expect(selection.anchor).toEqual({ rowIndex: 2, field: 'name' });
			expect(selection.active).toEqual({ rowIndex: 4, field: 'price' });
			expect(selection.rangeEnd).toEqual({ rowIndex: 4, field: 'price' });
		});
	});

	describe('getRange', () => {
		it('returns null when there is no anchor', () => {
			const selection = new CellSelection();
			expect(selection.getRange(fields)).toBeNull();
		});

		it('a single-cell selection normalizes to a 1x1 range', () => {
			const selection = new CellSelection();
			selection.setActive(3, 'price', false);
			expect(selection.getRange(fields)).toEqual({
				rowStart: 3,
				rowEnd: 3,
				fieldStart: 2,
				fieldEnd: 2
			});
		});

		// Excel-like drag can go in any of the 4 diagonal directions; getRange
		// must normalize all of them to the same rowStart<=rowEnd/fieldStart<=fieldEnd shape.
		it('normalizes a down-right drag (anchor top-left, end bottom-right)', () => {
			const selection = new CellSelection();
			selection.setActive(1, 'name', false); // anchor: row 1, field 1
			selection.setActive(4, 'stock', true); // end: row 4, field 3
			expect(selection.getRange(fields)).toEqual({
				rowStart: 1,
				rowEnd: 4,
				fieldStart: 1,
				fieldEnd: 3
			});
		});

		it('normalizes an up-left drag (anchor bottom-right, end top-left)', () => {
			const selection = new CellSelection();
			selection.setActive(4, 'stock', false); // anchor: row 4, field 3
			selection.setActive(1, 'name', true); // end: row 1, field 1
			expect(selection.getRange(fields)).toEqual({
				rowStart: 1,
				rowEnd: 4,
				fieldStart: 1,
				fieldEnd: 3
			});
		});

		it('normalizes a down-left drag (anchor top-right, end bottom-left)', () => {
			const selection = new CellSelection();
			selection.setActive(1, 'stock', false); // anchor: row 1, field 3
			selection.setActive(4, 'name', true); // end: row 4, field 1
			expect(selection.getRange(fields)).toEqual({
				rowStart: 1,
				rowEnd: 4,
				fieldStart: 1,
				fieldEnd: 3
			});
		});

		it('normalizes an up-right drag (anchor bottom-left, end top-right)', () => {
			const selection = new CellSelection();
			selection.setActive(4, 'name', false); // anchor: row 4, field 1
			selection.setActive(1, 'stock', true); // end: row 1, field 3
			expect(selection.getRange(fields)).toEqual({
				rowStart: 1,
				rowEnd: 4,
				fieldStart: 1,
				fieldEnd: 3
			});
		});
	});

	describe('isSelected', () => {
		it('is true only for cells inside the normalized range', () => {
			const selection = new CellSelection();
			selection.setActive(1, 'name', false);
			selection.setActive(3, 'price', true);

			expect(selection.isSelected(1, 1, fields)).toBe(true); // top-left corner
			expect(selection.isSelected(3, 2, fields)).toBe(true); // bottom-right corner
			expect(selection.isSelected(2, 2, fields)).toBe(true); // interior
			expect(selection.isSelected(0, 1, fields)).toBe(false); // above range
			expect(selection.isSelected(1, 0, fields)).toBe(false); // left of range
			expect(selection.isSelected(4, 2, fields)).toBe(false); // below range
		});

		it('is false for every cell when there is no selection', () => {
			const selection = new CellSelection();
			expect(selection.isSelected(0, 0, fields)).toBe(false);
		});
	});

	describe('clear', () => {
		it('resets active/anchor/rangeEnd to null', () => {
			const selection = new CellSelection();
			selection.setActive(1, 'name', false);
			selection.setActive(3, 'price', true);
			selection.clear();
			expect(selection.active).toBeNull();
			expect(selection.anchor).toBeNull();
			expect(selection.rangeEnd).toBeNull();
			expect(selection.getRange(fields)).toBeNull();
		});
	});
});
