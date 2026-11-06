/**
 * Reactive grid state (Svelte 5 runes): sort, filters, column order, column
 * widths and column visibility. This is the client-mode state today; the
 * shape is kept wire-compatible with the Rust `ListParams` type (spec §4.1,
 * §10) so the same class can drive server mode from M5 onward.
 */
import { SvelteSet } from 'svelte/reactivity';
import {
	DEFAULT_COLUMN_WIDTH,
	DEFAULT_MIN_WIDTH,
	type FilterState,
	type GridColumn,
	type SerializedGridState,
	type SortState
} from './types';

export const DEFAULT_ROW_HEIGHT = 36;

export interface GridStateOptions {
	rowHeight?: number;
}

function isSerializedGridState(value: unknown): value is SerializedGridState {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		Array.isArray(candidate.sort) &&
		Array.isArray(candidate.filters) &&
		Array.isArray(candidate.order) &&
		Array.isArray(candidate.hidden) &&
		typeof candidate.widths === 'object' &&
		candidate.widths !== null &&
		// Optional/backward-compatible: a payload serialized before M5 Phase B
		// (spec §4.3) has no `groupBy` at all - accept that as "no group".
		(candidate.groupBy === undefined ||
			candidate.groupBy === null ||
			typeof candidate.groupBy === 'string')
	);
}

export class GridState<TRow = unknown> {
	sort: SortState[] = $state([]);
	filters: FilterState[] = $state([]);
	order: string[] = $state([]);
	widths: Record<string, number> = $state({});
	/**
	 * Ids of the columns hidden from the rendered grid (spec §4.4). Seeded
	 * from each column's `hidden` flag, then owned here: the column manager
	 * UI (`ColumnsMenu`) writes through `setColumnHidden`/
	 * `toggleColumnHidden`, and `serialize()` carries the result so a user's
	 * choice survives a reload. Kept separate from `order` (which keeps a
	 * hidden column's slot) so unhiding restores the column where it was.
	 */
	hidden: string[] = $state([]);
	/** Client-mode-only group-by column id, or null for a flat view (spec §4.3). Server mode ignores this (see BantoGrid.svelte). */
	groupBy: string | null = $state(null);
	/**
	 * Which group keys are currently collapsed. Deliberately a `SvelteSet`
	 * (from `svelte/reactivity`), not a plain `Set` wrapped in `$state`:
	 * Svelte 5's `$state` proxy only intercepts property/index assignment,
	 * not `Set`/`Map` mutator methods, so `.add()`/`.delete()` on a plain
	 * `$state(new Set())` would silently fail to notify readers. Mutated
	 * in place (never reassigned) so the same reactive instance survives for
	 * the object's lifetime. Not part of `serialize()`/`hydrate()` -
	 * collapse state is ephemeral UI state, not persisted layout.
	 */
	collapsedGroups: Set<string> = new SvelteSet<string>();

	readonly rowHeight: number;

	#columns: GridColumn<TRow>[];

	constructor(columns: GridColumn<TRow>[], options: GridStateOptions = {}) {
		this.#columns = columns;
		this.order = columns.map((column) => column.id);
		this.hidden = this.#clampHidden(
			columns.filter((column) => column.hidden).map((column) => column.id)
		);
		this.widths = Object.fromEntries(
			columns.map((column) => [column.id, column.width ?? DEFAULT_COLUMN_WIDTH])
		);
		this.rowHeight = options.rowHeight ?? DEFAULT_ROW_HEIGHT;
	}

	/**
	 * VISIBLE column definitions in current display order (post drag-reorder,
	 * minus everything in `hidden`). This is what BantoGrid renders and what
	 * every field index (cell selection, TSV copy/paste) counts against, so
	 * hiding a column shifts those indices exactly like removing it would -
	 * no separate "is this one visible" bookkeeping anywhere downstream.
	 */
	get orderedColumns(): GridColumn<TRow>[] {
		return this.#inOrder().filter((column) => !this.hidden.includes(column.id));
	}

	/**
	 * EVERY column definition in display order, hidden ones included - the
	 * list a column manager UI offers (spec §4.4). Use `orderedColumns` for
	 * anything that renders data.
	 */
	get allColumns(): GridColumn<TRow>[] {
		return this.#inOrder();
	}

	/**
	 * Normalize a set of hidden ids: de-duplicated, restricted to columns
	 * that actually exist, and never covering ALL of them. "Every column
	 * hidden" is not a renderable state (see `setColumnHidden`), and both
	 * entry points into `hidden` can otherwise produce it - a column set
	 * where every definition carries `hidden: true`, and a persisted payload
	 * hiding everything - so both clamp here by keeping the first column in
	 * display order visible rather than silently rendering an empty grid.
	 */
	#clampHidden(ids: string[]): string[] {
		const known = new Set(this.#columns.map((column) => column.id));
		const unique = [...new Set(ids)].filter((id) => known.has(id));
		return unique.length < known.size ? unique : unique.filter((id) => id !== this.order[0]);
	}

	#inOrder(): GridColumn<TRow>[] {
		const byId = new Map(this.#columns.map((column) => [column.id, column]));
		const ordered: GridColumn<TRow>[] = [];
		for (const id of this.order) {
			const column = byId.get(id);
			if (column) ordered.push(column);
		}
		return ordered;
	}

	/** Whether `field` is currently hidden (spec §4.4). */
	isHidden(field: string): boolean {
		return this.hidden.includes(field);
	}

	/**
	 * Show/hide one column (spec §4.4). Hiding the LAST visible column is
	 * refused (a no-op): a grid with zero columns has no header row to
	 * re-open the column manager from, and every field index downstream
	 * would be out of range. UIs should disable that checkbox rather than
	 * rely on this, but the guard keeps the state itself always renderable.
	 * Unknown ids are ignored.
	 */
	setColumnHidden(field: string, hidden: boolean): void {
		if (!this.#columns.some((column) => column.id === field)) return;
		if (hidden === this.isHidden(field)) return;
		if (hidden) {
			if (this.orderedColumns.length <= 1) return;
			this.hidden = [...this.hidden, field];
		} else {
			this.hidden = this.hidden.filter((id) => id !== field);
		}
	}

	/** Flip one column's visibility (spec §4.4). Subject to `setColumnHidden`'s last-column guard. */
	toggleColumnHidden(field: string): void {
		this.setColumnHidden(field, !this.isHidden(field));
	}

	/** Cycle a column's sort state: asc -> desc -> removed. */
	toggleSort(field: string, additive: boolean): void {
		const existingIndex = this.sort.findIndex((entry) => entry.field === field);

		if (!additive) {
			// Non-additive click replaces the whole sort with just this field,
			// unless it was already the sole sort key (then cycle/clear it).
			if (this.sort.length === 1 && existingIndex === 0) {
				const current = this.sort[0];
				this.sort = current.direction === 'asc' ? [{ field, direction: 'desc' }] : [];
			} else {
				this.sort = [{ field, direction: 'asc' }];
			}
			return;
		}

		if (existingIndex === -1) {
			this.sort = [...this.sort, { field, direction: 'asc' }];
			return;
		}

		const current = this.sort[existingIndex];
		if (current.direction === 'asc') {
			const next = this.sort.slice();
			next[existingIndex] = { field, direction: 'desc' };
			this.sort = next;
		} else {
			this.sort = this.sort.filter((_, index) => index !== existingIndex);
		}
	}

	setFilter(filter: FilterState): void {
		const index = this.filters.findIndex((entry) => entry.field === filter.field);
		if (index === -1) {
			this.filters = [...this.filters, filter];
		} else {
			const next = this.filters.slice();
			next[index] = filter;
			this.filters = next;
		}
	}

	removeFilter(field: string): void {
		this.filters = this.filters.filter((entry) => entry.field !== field);
	}

	clearFilters(): void {
		this.filters = [];
	}

	/** Change (or clear, via null) the group-by column. Always resets collapse state (spec §4.3): stale keys from a different grouping are meaningless. */
	setGroupBy(field: string | null): void {
		this.groupBy = field;
		this.collapsedGroups.clear();
	}

	/** Toggle one group's collapsed state by its key (spec §4.3). */
	toggleGroup(key: string): void {
		if (this.collapsedGroups.has(key)) {
			this.collapsedGroups.delete(key);
		} else {
			this.collapsedGroups.add(key);
		}
	}

	/** Resize a column, clamped to its configured min/max width. */
	resizeColumn(field: string, width: number): void {
		const column = this.#columns.find((entry) => entry.id === field);
		const min = column?.minWidth ?? DEFAULT_MIN_WIDTH;
		const max = column?.maxWidth ?? Infinity;
		const clamped = Math.min(max, Math.max(min, width));
		this.widths = { ...this.widths, [field]: clamped };
	}

	/**
	 * Move a column in the display order (drag-reorder). `toIndex` is the
	 * insertion position in the PRE-removal VISIBLE order (`orderedColumns`)
	 * - what the drop indicator points at - because a hidden column has no
	 * on-screen slot to drop beside (spec §4.4). It is translated here into a
	 * position in `order`, which still carries the hidden ids: the dragged
	 * column lands immediately before the visible column currently at
	 * `toIndex`, or last when `toIndex` is past the final visible one. Hidden
	 * columns keep their own slots and may therefore end up on either side of
	 * the moved column - they have no visible position to preserve. When the
	 * column moves rightward, removing it first shifts later indices left by
	 * one, so compensate before splicing.
	 */
	moveColumn(field: string, toIndex: number): void {
		const current = this.order.slice();
		const fromIndex = current.indexOf(field);
		if (fromIndex === -1) return;
		const targetId = this.orderedColumns[toIndex]?.id;
		const insertBefore = targetId === undefined ? current.length : current.indexOf(targetId);
		current.splice(fromIndex, 1);
		const insertIndex = fromIndex < insertBefore ? insertBefore - 1 : insertBefore;
		const clampedIndex = Math.max(0, Math.min(insertIndex, current.length));
		current.splice(clampedIndex, 0, field);
		this.order = current;
	}

	/** Serialize sort/filters/order/widths/hidden/groupBy for persistence (spec §4.4, §4.3). `collapsedGroups` is deliberately excluded - it's ephemeral. */
	serialize(): string {
		const payload: SerializedGridState = {
			sort: this.sort,
			filters: this.filters,
			order: this.order,
			widths: this.widths,
			hidden: this.hidden,
			groupBy: this.groupBy
		};
		return JSON.stringify(payload);
	}

	/** Apply a previously-serialized state onto this instance. Ignores invalid/malformed input. */
	hydrate(json: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(json);
		} catch {
			return;
		}
		if (!isSerializedGridState(parsed)) return;
		this.sort = parsed.sort;
		this.filters = parsed.filters;
		this.groupBy = parsed.groupBy ?? null;
		this.collapsedGroups.clear();
		// Keep only ids that still exist in the current column set, but
		// preserve the persisted order for those that do; append any new
		// columns (added since the state was saved) at the end.
		const knownIds = new Set(this.#columns.map((column) => column.id));
		const restoredOrder = parsed.order.filter((id) => knownIds.has(id));
		const missing = this.order.filter((id) => !restoredOrder.includes(id));
		this.order = [...restoredOrder, ...missing];
		this.widths = { ...this.widths, ...parsed.widths };
		// Same "keep only ids that still exist" rule as the order above, plus
		// the de-duplication and never-hide-everything clamp `#clampHidden`
		// applies to the constructor's seed (a hand-edited or stale payload
		// can carry duplicates, or hide every column the current set still
		// has).
		this.hidden = this.#clampHidden(parsed.hidden);
	}

	/** Construct a GridState and immediately hydrate it from a serialized string. */
	static hydrate<TRow>(
		json: string,
		columns: GridColumn<TRow>[],
		options: GridStateOptions = {}
	): GridState<TRow> {
		const state = new GridState(columns, options);
		state.hydrate(json);
		return state;
	}
}
