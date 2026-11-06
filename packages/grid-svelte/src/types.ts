/**
 * Public types for @banto/grid-svelte.
 *
 * `SortState` / `FilterOp` / `FilterState` mirror the Rust types in
 * `crates/banto-core/src/params.rs` field-for-field so the same
 * client-side state can later drive server mode (spec §4.1, §10) without a
 * shape change. Keep these two definitions in sync by hand.
 */

export type SortDirection = 'asc' | 'desc';

export interface SortState {
	field: string;
	direction: SortDirection;
}

export type FilterOp =
	| 'eq'
	| 'ne'
	| 'lt'
	| 'lte'
	| 'gt'
	| 'gte'
	| 'contains'
	| 'starts_with'
	| 'in'
	| 'is_null'
	| 'not_null';

export interface FilterState {
	field: string;
	op: FilterOp;
	value: unknown;
}

export type FilterType = 'text' | 'number';

/** Built-in per-group aggregate functions for a column (spec §4.3, client mode only). */
export type AggregateKind = 'sum' | 'avg' | 'count';

/** Built-in cell editor kinds (spec §4.5). */
export type CellEditorType = 'text' | 'number' | 'date' | 'select' | 'checkbox';

/**
 * One committed (or about-to-be-committed) cell edit, passed to
 * `onCellEdit`/`onRangePaste` (spec §4.5). `value` is already parsed to the
 * editor's native type (number for 'number', boolean for 'checkbox', string
 * otherwise); `oldValue` is the raw value read via the column's accessor
 * before the edit.
 */
export interface CellEdit<TRow> {
	row: TRow;
	rowId: string | number;
	field: string;
	value: unknown;
	oldValue: unknown;
}

/**
 * Normalized, inclusive rectangular selection, expressed as row indices into
 * the current (filtered+sorted) row array and field indices into the
 * current column *display* order (spec §4.5). Shared by `CellSelection`
 * (src/selection.svelte.ts) and `core/clipboard.ts`.
 */
export interface CellRange {
	rowStart: number;
	rowEnd: number;
	fieldStart: number;
	fieldEnd: number;
}

export interface GridColumn<TRow> {
	/** Stable identifier; used as SortState.field / FilterState.field. */
	id: string;
	header: string;
	accessor: keyof TRow | ((row: TRow) => unknown);
	/** Width in px. Default 150. */
	width?: number;
	/** Default 60. */
	minWidth?: number;
	maxWidth?: number;
	/** Default true. */
	resizable?: boolean;
	/** Default true. */
	sortable?: boolean;
	/** Default false. */
	filterable?: boolean;
	/** Default 'text'; controls which ops FilterPopover offers. */
	filterType?: FilterType;
	align?: 'left' | 'right' | 'center';
	format?: (value: unknown, row: TRow) => string;
	comparator?: (a: unknown, b: unknown) => number;
	/** Default false. Function form lets editability depend on the row (spec §4.5). */
	editable?: boolean | ((row: TRow) => boolean);
	/** Default 'text'. */
	editor?: CellEditorType;
	/** Options for `editor: 'select'`. */
	editorOptions?: { value: string | number; label: string }[];
	/** Column-level validator; return a Japanese error message, or null when valid. */
	validate?: (value: unknown, row: TRow) => string | null;
	/**
	 * Minimal cellRenderer escape hatch (the `cellRenderer` mentioned in spec
	 * §4.1): returns display text and an optional link href, rendered as an
	 * `<a>` when `href` is present. A column defining `cell` is never
	 * editable regardless of `editable` (see `isColumnEditable` in
	 * `core/edit.ts`), so its rendered link/text and an inline editor can
	 * never both apply to the same cell.
	 */
	cell?: (row: TRow) => { text: string; href?: string };
	/**
	 * Per-group aggregate shown as a chip in the group header row (spec
	 * §4.3, client mode grouping only - a later milestone wires the server
	 * mode SQL GROUP BY equivalent). 'sum'/'avg' coerce each row's value to a
	 * number (skipping non-numeric values); 'count' is the group's row
	 * count regardless of this column's values; the function form receives
	 * every row's raw accessor value plus the row itself and returns the
	 * already-formatted display string.
	 */
	aggregate?: AggregateKind | ((values: unknown[], rows: TRow[]) => string);
	/**
	 * Whether this column may be offered as a group-by candidate (spec
	 * §4.3). Default true. Purely informational: BantoGrid itself does not
	 * read this flag anywhere - it exists only for the caller's own group-by
	 * picker UI (e.g. a <select>) to filter its option list against.
	 */
	groupable?: boolean;
	/**
	 * Default false: the column starts hidden (spec §4.4 "列の表示/非表示
	 * 切り替え"). Lets a definition exist without occupying screen width -
	 * internal ids, auto-numbered codes, anything "rarely read but
	 * occasionally needed" - instead of the caller dropping the column from
	 * the array entirely (which also drops the user's ability to bring it
	 * back).
	 *
	 * This is the INITIAL value only: `GridState` seeds `hidden` from it and
	 * owns live visibility from then on (`setColumnHidden`/
	 * `toggleColumnHidden`, persisted through `serialize()`). Reading
	 * `column.hidden` to decide whether a column renders is therefore always
	 * wrong - ask `GridState.isHidden(id)`, or iterate
	 * `GridState.orderedColumns`, which already excludes hidden columns.
	 */
	hidden?: boolean;
}

/** Resolved defaults applied on top of a user-supplied GridColumn. */
export const DEFAULT_COLUMN_WIDTH = 150;
export const DEFAULT_MIN_WIDTH = 60;

/** Shape persisted by GridState.serialize() (spec §4.4, §4.3). */
export interface SerializedGridState {
	sort: SortState[];
	filters: FilterState[];
	order: string[];
	widths: Record<string, number>;
	/** Ids of the columns currently hidden (spec §4.4). Ids absent here are visible. */
	hidden: string[];
	/** Client-mode group-by column id, or null (spec §4.3). `collapsedGroups` is deliberately NOT persisted - it's ephemeral UI state. */
	groupBy: string | null;
}
