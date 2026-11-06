import { describe, expect, it } from 'vitest';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

interface Row {
	id: number;
	name: string;
	price: number;
}

const columns: GridColumn<Row>[] = [
	{ id: 'id', header: 'ID', accessor: 'id', width: 80, minWidth: 60, maxWidth: 120 },
	{ id: 'name', header: 'Name', accessor: 'name' },
	{ id: 'price', header: 'Price', accessor: 'price', width: 100 }
];

describe('GridState', () => {
	it('initializes order and widths from columns', () => {
		const state = new GridState(columns);
		expect(state.order).toEqual(['id', 'name', 'price']);
		expect(state.widths).toEqual({ id: 80, name: 150, price: 100 });
		expect(state.rowHeight).toBe(36);
	});

	it('accepts a custom rowHeight option', () => {
		const state = new GridState(columns, { rowHeight: 48 });
		expect(state.rowHeight).toBe(48);
	});

	describe('toggleSort', () => {
		it('non-additive click cycles asc -> desc -> removed for a single column', () => {
			const state = new GridState(columns);
			state.toggleSort('name', false);
			expect(state.sort).toEqual([{ field: 'name', direction: 'asc' }]);
			state.toggleSort('name', false);
			expect(state.sort).toEqual([{ field: 'name', direction: 'desc' }]);
			state.toggleSort('name', false);
			expect(state.sort).toEqual([]);
		});

		it('non-additive click on a different column replaces the whole sort', () => {
			const state = new GridState(columns);
			state.toggleSort('name', false);
			state.toggleSort('price', false);
			expect(state.sort).toEqual([{ field: 'price', direction: 'asc' }]);
		});

		it('additive click appends a new sort key and preserves existing ones', () => {
			const state = new GridState(columns);
			state.toggleSort('name', false);
			state.toggleSort('price', true);
			expect(state.sort).toEqual([
				{ field: 'name', direction: 'asc' },
				{ field: 'price', direction: 'asc' }
			]);
		});

		it('additive click cycles an existing key in place then removes it', () => {
			const state = new GridState(columns);
			state.toggleSort('name', true);
			state.toggleSort('price', true);
			state.toggleSort('name', true); // name: asc -> desc, keeps position
			expect(state.sort).toEqual([
				{ field: 'name', direction: 'desc' },
				{ field: 'price', direction: 'asc' }
			]);
			state.toggleSort('name', true); // name: desc -> removed
			expect(state.sort).toEqual([{ field: 'price', direction: 'asc' }]);
		});
	});

	describe('filters', () => {
		it('setFilter adds and replaces by field', () => {
			const state = new GridState(columns);
			state.setFilter({ field: 'name', op: 'contains', value: 'tea' });
			expect(state.filters).toEqual([{ field: 'name', op: 'contains', value: 'tea' }]);
			state.setFilter({ field: 'name', op: 'eq', value: 'exact' });
			expect(state.filters).toEqual([{ field: 'name', op: 'eq', value: 'exact' }]);
		});

		it('removeFilter and clearFilters', () => {
			const state = new GridState(columns);
			state.setFilter({ field: 'name', op: 'contains', value: 'tea' });
			state.setFilter({ field: 'price', op: 'gte', value: 100 });
			state.removeFilter('name');
			expect(state.filters).toEqual([{ field: 'price', op: 'gte', value: 100 }]);
			state.clearFilters();
			expect(state.filters).toEqual([]);
		});
	});

	describe('resizeColumn', () => {
		it('clamps to the column min/max width', () => {
			const state = new GridState(columns);
			state.resizeColumn('id', 10); // below minWidth 60
			expect(state.widths.id).toBe(60);
			state.resizeColumn('id', 500); // above maxWidth 120
			expect(state.widths.id).toBe(120);
			state.resizeColumn('id', 90);
			expect(state.widths.id).toBe(90);
		});

		it('falls back to the default min width when unspecified', () => {
			const state = new GridState(columns);
			state.resizeColumn('name', 10);
			expect(state.widths.name).toBe(60);
		});
	});

	describe('moveColumn', () => {
		// toIndex is expressed in PRE-removal coordinates (the drop indicator
		// position), so rightward moves must account for the removal shift.
		// Base order: [id, name, price] = [A, B, C].

		it('moving rightward past one column: A -> index 2 gives [B, A, C]', () => {
			const state = new GridState(columns);
			state.moveColumn('id', 2);
			expect(state.order).toEqual(['name', 'id', 'price']);
		});

		it('moving rightward to the end: A -> index 3 gives [B, C, A]', () => {
			const state = new GridState(columns);
			state.moveColumn('id', 3);
			expect(state.order).toEqual(['name', 'price', 'id']);
		});

		it('moving leftward to the front: C -> index 0 gives [C, A, B]', () => {
			const state = new GridState(columns);
			state.moveColumn('price', 0);
			expect(state.order).toEqual(['price', 'id', 'name']);
		});

		it('moving a column to its own position is a no-op', () => {
			const state = new GridState(columns);
			state.moveColumn('name', 1);
			expect(state.order).toEqual(['id', 'name', 'price']);
			// Dropping just after itself is also a no-op.
			state.moveColumn('name', 2);
			expect(state.order).toEqual(['id', 'name', 'price']);
		});

		it('is a no-op for an unknown field', () => {
			const state = new GridState(columns);
			state.moveColumn('missing', 0);
			expect(state.order).toEqual(['id', 'name', 'price']);
		});
	});

	describe('groupBy / collapsedGroups', () => {
		it('defaults to null groupBy and an empty collapsedGroups', () => {
			const state = new GridState(columns);
			expect(state.groupBy).toBeNull();
			expect(state.collapsedGroups.size).toBe(0);
		});

		it('setGroupBy sets the field and resets collapsedGroups', () => {
			const state = new GridState(columns);
			state.toggleGroup('a');
			state.setGroupBy('name');
			expect(state.groupBy).toBe('name');
			expect(state.collapsedGroups.size).toBe(0);
		});

		it('setGroupBy(null) clears grouping', () => {
			const state = new GridState(columns);
			state.setGroupBy('name');
			state.setGroupBy(null);
			expect(state.groupBy).toBeNull();
		});

		it('toggleGroup adds then removes a key', () => {
			const state = new GridState(columns);
			state.toggleGroup('tea');
			expect(state.collapsedGroups.has('tea')).toBe(true);
			state.toggleGroup('tea');
			expect(state.collapsedGroups.has('tea')).toBe(false);
		});

		it('toggleGroup tracks multiple independent keys', () => {
			const state = new GridState(columns);
			state.toggleGroup('a');
			state.toggleGroup('b');
			expect(state.collapsedGroups.has('a')).toBe(true);
			expect(state.collapsedGroups.has('b')).toBe(true);
			state.toggleGroup('a');
			expect(state.collapsedGroups.has('a')).toBe(false);
			expect(state.collapsedGroups.has('b')).toBe(true);
		});
	});

	describe('column visibility (spec §4.4)', () => {
		it("seeds hidden from the columns' own flag and drops them from orderedColumns", () => {
			const state = new GridState([
				columns[0],
				{ ...columns[1], hidden: true },
				columns[2]
			] as GridColumn<Row>[]);

			expect(state.hidden).toEqual(['name']);
			expect(state.orderedColumns.map((c) => c.id)).toEqual(['id', 'price']);
			// allColumns keeps the full set (that is what a column manager lists).
			expect(state.allColumns.map((c) => c.id)).toEqual(['id', 'name', 'price']);
			expect(state.isHidden('name')).toBe(true);
		});

		it('keeps the first column visible when every definition is hidden', () => {
			const state = new GridState(
				columns.map((column) => ({ ...column, hidden: true })) as GridColumn<Row>[]
			);

			// A column set that hides everything is not renderable - clamped the
			// same way hydrate() and setColumnHidden() clamp.
			expect(state.hidden).toEqual(['name', 'price']);
			expect(state.orderedColumns.map((c) => c.id)).toEqual(['id']);
		});

		it("toggles visibility and keeps the column's slot in the display order", () => {
			const state = new GridState(columns);
			state.moveColumn('price', 0);

			state.toggleColumnHidden('price');
			expect(state.orderedColumns.map((c) => c.id)).toEqual(['id', 'name']);
			expect(state.order).toEqual(['price', 'id', 'name']);

			state.toggleColumnHidden('price');
			expect(state.orderedColumns.map((c) => c.id)).toEqual(['price', 'id', 'name']);
		});

		it('refuses to hide the last visible column', () => {
			const state = new GridState(columns);
			state.setColumnHidden('id', true);
			state.setColumnHidden('name', true);

			state.setColumnHidden('price', true);

			expect(state.orderedColumns.map((c) => c.id)).toEqual(['price']);
			expect(state.isHidden('price')).toBe(false);
		});

		it('ignores unknown column ids', () => {
			const state = new GridState(columns);
			state.setColumnHidden('nope', true);
			expect(state.hidden).toEqual([]);
		});
	});

	describe('moveColumn with hidden columns', () => {
		it('treats toIndex as a VISIBLE position, not an index into order', () => {
			const state = new GridState(columns);
			state.setColumnHidden('name', true); // order stays [id, name, price]

			// Visible order is [id, price]; drop `id` past the last visible column.
			// An index into `order` would have read as "before price" and left the
			// visible order unchanged.
			state.moveColumn('id', 2);

			expect(state.orderedColumns.map((c) => c.id)).toEqual(['price', 'id']);
			expect(state.order).toEqual(['name', 'price', 'id']);
		});

		it('inserts before the visible column at toIndex', () => {
			const state = new GridState(columns);
			state.setColumnHidden('id', true); // visible: [name, price]

			state.moveColumn('price', 0);

			expect(state.orderedColumns.map((c) => c.id)).toEqual(['price', 'name']);
			// The hidden column keeps its own slot in the full order.
			expect(state.order).toContain('id');
		});

		it('matches plain order semantics when nothing is hidden', () => {
			const state = new GridState(columns);
			state.moveColumn('price', 0);
			expect(state.order).toEqual(['price', 'id', 'name']);
		});
	});

	describe('serialize / hydrate round-trip', () => {
		it('restores sort, filters, order, widths and groupBy', () => {
			const state = new GridState(columns);
			state.toggleSort('price', false);
			state.setFilter({ field: 'name', op: 'contains', value: 'tea' });
			state.moveColumn('price', 0);
			state.resizeColumn('name', 200);
			state.setGroupBy('name');

			const json = state.serialize();

			const restored = new GridState(columns);
			restored.hydrate(json);

			expect(restored.sort).toEqual(state.sort);
			expect(restored.filters).toEqual(state.filters);
			expect(restored.order).toEqual(state.order);
			expect(restored.widths).toEqual(state.widths);
			expect(restored.groupBy).toBe('name');
		});

		it('restores hidden columns', () => {
			const state = new GridState(columns);
			state.setColumnHidden('id', true);

			const restored = GridState.hydrate(state.serialize(), columns);

			expect(restored.hidden).toEqual(['id']);
			expect(restored.orderedColumns.map((c) => c.id)).toEqual(['name', 'price']);
		});

		it('drops hidden ids that no longer exist in the column set', () => {
			const state = new GridState(columns);
			state.setColumnHidden('id', true);
			const json = state.serialize();

			const restored = GridState.hydrate(json, [
				{ id: 'name', header: 'Name', accessor: 'name' },
				{ id: 'price', header: 'Price', accessor: 'price' }
			] as GridColumn<Row>[]);

			expect(restored.hidden).toEqual([]);
		});

		it('clamps a payload that would hide every current column', () => {
			const state = new GridState(columns);
			const json = JSON.stringify({
				...JSON.parse(state.serialize()),
				hidden: ['id', 'name', 'price']
			});

			state.hydrate(json);

			expect(state.hidden).toEqual(['name', 'price']);
			expect(state.orderedColumns.map((c) => c.id)).toEqual(['id']);
		});

		it('de-duplicates a payload\'s hidden ids instead of reading them as "all hidden"', () => {
			const state = new GridState(columns);
			const json = JSON.stringify({
				...JSON.parse(state.serialize()),
				hidden: ['id', 'id', 'name']
			});

			state.hydrate(json);

			expect(state.hidden).toEqual(['id', 'name']);
			expect(state.orderedColumns.map((c) => c.id)).toEqual(['price']);
		});

		it('rejects a payload with no hidden list at all', () => {
			const state = new GridState(columns);
			state.hydrate(JSON.stringify({ sort: [], filters: [], order: [], widths: {} }));
			expect(state.order).toEqual(['id', 'name', 'price']);
		});

		it('does NOT persist collapsedGroups (ephemeral UI state)', () => {
			const state = new GridState(columns);
			state.setGroupBy('name');
			state.toggleGroup('tea');
			const json = state.serialize();
			expect(JSON.parse(json)).not.toHaveProperty('collapsedGroups');

			const restored = new GridState(columns);
			restored.hydrate(json);
			expect(restored.collapsedGroups.size).toBe(0);
		});

		it('static hydrate constructs and applies in one step', () => {
			const state = new GridState(columns);
			state.toggleSort('id', false);
			const json = state.serialize();

			const restored = GridState.hydrate(json, columns);
			expect(restored.sort).toEqual([{ field: 'id', direction: 'asc' }]);
		});

		it('ignores malformed JSON without throwing', () => {
			const state = new GridState(columns);
			expect(() => state.hydrate('not json')).not.toThrow();
			expect(state.sort).toEqual([]);
		});

		it('defaults groupBy to null when hydrating a payload saved before M5 Phase B', () => {
			const state = new GridState(columns);
			state.toggleSort('id', false);
			const legacyJson = JSON.stringify({
				sort: state.sort,
				filters: state.filters,
				order: state.order,
				widths: state.widths
			});

			const restored = new GridState(columns);
			restored.hydrate(legacyJson);
			expect(restored.groupBy).toBeNull();
		});

		it('drops columns that no longer exist and appends unknown-at-save-time new columns', () => {
			const state = new GridState(columns);
			const json = state.serialize();

			const fewerColumns = columns.filter((c) => c.id !== 'price');
			const restored = new GridState(fewerColumns);
			restored.hydrate(json);
			expect(restored.order).toEqual(['id', 'name']);
		});
	});
});
