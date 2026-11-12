<script lang="ts" generics="TRow">
	/**
	 * Client-mode data grid (spec §4): filter -> sort -> virtualize -> render.
	 * Single scroll container for header + body; the header row is
	 * `position: sticky` so horizontal scroll stays in sync automatically
	 * and vertical scroll drives the virtualization window.
	 *
	 * M3 (spec §4.5) adds cell navigation/selection, inline editing, and
	 * TSV copy/paste on top of the M1/M2 read-only grid. All of it lives in
	 * this component (not `state.svelte.ts`) because it's UI-event-driven
	 * (pointer/keyboard/clipboard handlers), not derived reactive state; the
	 * pure decision logic it calls into (`prepareCommit`, TSV helpers) is
	 * factored into `core/*.ts` and unit-tested there.
	 */
	import { tick, untrack } from 'svelte';
	import {
		DEFAULT_COLUMN_WIDTH,
		type CellEdit,
		type CellRange,
		type FilterState,
		type GridColumn,
		type SortState
	} from './types';
	import CellEditor from './CellEditor.svelte';
	import { GridState } from './state.svelte';
	import { CellSelection } from './selection.svelte';
	import { getColumnValue, sortRows } from './core/sort';
	import { filterRows } from './core/filter';
	import { computeWindow } from './core/virtual';
	import { parseCellInput, parseTsv, rangeToTsv, resolveSelectValue } from './core/clipboard';
	import { prepareCommit, isColumnEditable } from './core/edit';
	import { buildGroupedView, type FlatEntry } from './core/group';
	import HeaderCell from './HeaderCell.svelte';
	import CellEditError from './CellEditError.svelte';
	import { defaultGridMessages, type GridMessages } from './messages';
	import { getCellEditors, type CellEditors } from './cellEditors';

	interface Props {
		/**
		 * Client mode: the full row set (filter/sort/paging happen in this
		 * component). Server mode (spec §4.1, M5): a SPARSE array aligned to
		 * ABSOLUTE row indices - `rows[i]` is row `i`'s data once loaded,
		 * `undefined` (a hole) otherwise; the caller (typically
		 * `@banto/admin-core`'s windowed list resource) owns fetching and
		 * writes into it as blocks arrive.
		 */
		rows: (TRow | undefined)[];
		columns: GridColumn<TRow>[];
		state?: GridState<TRow>;
		getRowId: (row: TRow) => string | number;
		rowHeight?: number;
		/**
		 * Default 'client'. Row grouping (spec §4.3, `state.groupBy`/
		 * `setGroupBy`/`toggleGroup`) only runs in 'client' mode - a later
		 * milestone adds the server-mode SQL GROUP BY equivalent. If
		 * `state.groupBy` is set while `mode === 'server'`, it is ignored
		 * (rows render as a flat list) and a single `console.warn` fires as a
		 * dev aid.
		 */
		mode?: 'client' | 'server';
		/** Server mode only: total row count backing the virtual scroller (NOT `rows.length`, which is just the sparse array's current extent). */
		totalRows?: number;
		onRowClick?: (row: TRow) => void;
		onCellEdit?: (edit: CellEdit<TRow>) => void | Promise<void>;
		onRangePaste?: (edits: CellEdit<TRow>[], info: { skipped: number }) => void | Promise<void>;
		/**
		 * Optional extra class name(s) for a data row's outer `.row` element,
		 * computed per-row (spec M14: the audit-log viewer uses this to give
		 * `result: 'denied' | 'failed'` rows a subdued left border via a
		 * `:global()` selector in the caller's own stylesheet - see that
		 * page's doc comment). Returning `''`/`undefined` adds nothing. Not
		 * applied to placeholder (unloaded server-mode) rows or group header
		 * rows, since neither has a real `TRow` to compute a class from.
		 */
		rowClass?: (row: TRow) => string | undefined;
		/** Server mode: fires after a sort toggle / filter apply / filter clear so the caller can re-fetch. */
		onParamsChange?: (params: { sort: SortState[]; filters: FilterState[] }) => void;
		/** Server mode: fires when the virtualized window's [start, end) actually changes (not on every scroll tick). */
		onVisibleRangeChange?: (range: { start: number; end: number }) => void;
		/**
		 * i18n layer 1 (docs/conventions.md §13): overrides for this component's
		 * visible strings, threaded down to HeaderCell and (through it) to
		 * FilterPopover. Defaults reproduce today's Japanese output.
		 */
		messages?: Partial<GridMessages>;
		/**
		 * Injected cell editors (date-time-pickers §5.8, D1-a), per editor type,
		 * and the filter's day-range input (`dateRange`, §5.9); wins over
		 * `provideCellEditors` (context). A type with neither keeps the native
		 * input (D3-a).
		 */
		cellEditors?: CellEditors;
	}

	// Aliased to avoid clashing with the `$state` rune (a local binding named
	// exactly `state` makes the compiler treat `$state(...)` calls below as
	// store-subscription syntax instead of rune usage).
	let {
		rows,
		columns,
		state: externalState,
		getRowId,
		rowHeight,
		mode = 'client',
		totalRows,
		onRowClick,
		onCellEdit,
		onRangePaste,
		onParamsChange,
		onVisibleRangeChange,
		rowClass,
		messages = {},
		cellEditors
	}: Props = $props();

	const providedCellEditors = getCellEditors();
	const editors = $derived<CellEditors>({ ...providedCellEditors, ...cellEditors });

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultGridMessages, ...messages };
	// Only one editor is mounted per grid; keep its error reference local to
	// this instance without deriving DOM IDs from row or column identifiers.
	const gridId = $props.id();
	const editErrorId = `${gridId}-edit-error`;

	// Created once per component instance. If the caller passes `state`, that
	// instance is the single source of truth (including its own rowHeight);
	// otherwise we own one internally, seeded from the `rowHeight` prop.
	// Capturing only the initial prop values here is by design.
	// svelte-ignore state_referenced_locally
	const gridState: GridState<TRow> = externalState ?? new GridState(columns, { rowHeight });

	const OVERSCAN = 8;

	let containerEl: HTMLDivElement | undefined = $state();
	let frameEl: HTMLDivElement | undefined = $state();
	let errorRegionEl: HTMLDivElement | undefined = $state();
	let headerRowEl: HTMLDivElement | undefined = $state();
	let editorEl: HTMLInputElement | HTMLSelectElement | undefined = $state();
	// An injected editor's wrapper (button and calendar included); the native
	// editors have none and are their own root.
	let editorRootEl: HTMLElement | null | undefined = $state();

	let scrollTop = $state(0);
	let viewportHeight = $state(0);
	let headerHeight = $state(40);

	$effect(() => {
		if (!containerEl) return;
		viewportHeight = containerEl.clientHeight;
		const observer = new ResizeObserver(() => {
			viewportHeight = containerEl!.clientHeight;
		});
		observer.observe(containerEl);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!headerRowEl) return;
		headerHeight = headerRowEl.offsetHeight;
		const observer = new ResizeObserver(() => {
			headerHeight = headerRowEl!.offsetHeight;
		});
		observer.observe(headerRowEl);
		return () => observer.disconnect();
	});

	// spec §4.5 / #212: removing a saved editor can leave body focused.
	// Track explicit user intent separately from that incidental focus loss,
	// including clicks on non-focusable elements. Never reclaim abandoned focus.
	let editFocus: { sessionId: number; owned: boolean } | null = null;
	$effect(() => {
		const container = containerEl;
		if (!container) return;
		const document = container.ownerDocument;
		// The whole editor counts (date-time-pickers §5.8 promise 4): pressing
		// an injected editor's button or a calendar day, or focus moving into
		// its calendar, keeps the session's claim on focus.
		function insideEditor(target: EventTarget | null): boolean {
			const root = editorRootEl ?? editorEl;
			return !!root && target instanceof Node && root.contains(target);
		}
		// A press outside can make an injected editor park focus on its own text
		// box while it dismisses its popover (DateInput's light dismiss), in the
		// same pointerdown dispatch: that focusin is not the user coming back.
		let pressedOutside = false;
		let pressTimer: ReturnType<typeof setTimeout> | undefined;
		function relinquishFocus(event: Event) {
			if (!editFocus) return;
			const inside = insideEditor(event.target);
			if (event.type === 'pointerdown') {
				if (inside) return;
				editFocus.owned = false;
				pressedOutside = true;
				clearTimeout(pressTimer);
				pressTimer = setTimeout(() => (pressedOutside = false));
				return;
			}
			if (inside && pressedOutside) return;
			editFocus.owned = inside;
		}
		function leaveWindow() {
			if (editFocus) editFocus.owned = false;
		}
		document.addEventListener('pointerdown', relinquishFocus, true);
		document.addEventListener('focusin', relinquishFocus, true);
		document.defaultView?.addEventListener('blur', leaveWindow);
		return () => {
			document.removeEventListener('pointerdown', relinquishFocus, true);
			document.removeEventListener('focusin', relinquishFocus, true);
			document.defaultView?.removeEventListener('blur', leaveWindow);
			clearTimeout(pressTimer);
			if (editFocus) editFocus.owned = false;
		};
	});

	// Focus a new editor or a failed draft only while this session still owns
	// focus. In particular, pending/error assignments must not steal it back.
	$effect(() => {
		const current = editing;
		const editor = editorEl;
		if (current && editor && !current.pending) {
			untrack(() => {
				if (editFocus?.sessionId !== current.sessionId || !editFocus.owned) return;
				editor.focus();
				if (editor instanceof HTMLInputElement && editor.type !== 'checkbox') editor.select();
			});
		}
	});

	function handleScroll(event: Event) {
		scrollTop = (event.currentTarget as HTMLDivElement).scrollTop;
	}

	// Server mode (spec §4.1, M5): sort/filter already happened in the
	// DataProvider, so `rows` (sparse, absolute-index-aligned) is used
	// as-is - running it back through the client filter/sort pipeline would
	// be wrong (holes aren't real rows, and the order is already final).
	const sorted = $derived(
		mode === 'server'
			? rows
			: sortRows(
					filterRows(rows as TRow[], gridState.filters, columns),
					gridState.sort,
					columns,
					getRowId
				)
	);

	// Client-mode-only row grouping (spec §4.3): filter -> sort -> group ->
	// virtualize. `null` (not grouped, or server mode - see the console.warn
	// effect below) means the ungrouped `sorted`/`rows` array drives
	// rendering exactly as before M5 Phase B.
	const groupedEntries: FlatEntry<TRow>[] | null = $derived(
		mode === 'client' && gridState.groupBy
			? buildGroupedView(sorted as TRow[], columns, gridState.groupBy, (key) =>
					gridState.collapsedGroups.has(key)
				)
			: null
	);

	// Dev aid (spec §4.3): grouping has no server-mode equivalent yet, so a
	// `groupBy` set while `mode === 'server'` is silently ignored for
	// rendering - warn once per "entering" the misconfigured state (not on
	// every reactive recompute) so it doesn't spam the console.
	let warnedServerGroupBy = false;
	$effect(() => {
		if (mode === 'server' && gridState.groupBy) {
			if (!warnedServerGroupBy) {
				warnedServerGroupBy = true;
				console.warn(
					'[BantoGrid] state.groupBy is ignored in server mode (spec §4.3: grouping has no server-mode equivalent yet).'
				);
			}
		} else {
			warnedServerGroupBy = false;
		}
	});

	// Row count driving the virtual scroller: server mode sizes from
	// `totalRows` (the sparse array's current `.length` is just how much of
	// it has been fetched so far, not the true total); client mode from the
	// grouped flat-entry count when grouped, otherwise the actual
	// (filtered+sorted) row count.
	const effectiveRowCount = $derived(
		mode === 'server' ? (totalRows ?? 0) : (groupedEntries?.length ?? sorted.length)
	);

	const rowsViewportHeight = $derived(Math.max(0, viewportHeight - headerHeight));
	const effectiveScrollTop = $derived(Math.max(0, scrollTop - headerHeight));

	const windowResult = $derived(
		computeWindow({
			scrollTop: effectiveScrollTop,
			viewportHeight: rowsViewportHeight,
			rowHeight: gridState.rowHeight,
			rowCount: effectiveRowCount,
			overscan: OVERSCAN
		})
	);

	// In server mode, always render exactly (end - start) row slots even if
	// the sparse array hasn't been extended that far yet - those slots
	// render as placeholder ("loading") rows rather than being skipped.
	const visibleRows = $derived(
		mode === 'server'
			? Array.from(
					{ length: windowResult.end - windowResult.start },
					(_, i) => rows[windowResult.start + i]
				)
			: sorted.slice(windowResult.start, windowResult.end)
	);

	// Grouped-mode counterpart of `visibleRows`: the virtualized window
	// slices `groupedEntries` (group headers + rows) instead of `sorted`.
	const visibleEntries = $derived(
		groupedEntries ? groupedEntries.slice(windowResult.start, windowResult.end) : []
	);

	// Server mode only: notify the caller when the virtualized window
	// actually moves to a new [start, end) (not on every scroll tick -
	// `windowResult` only changes when the computed window changes, and this
	// guard further skips re-firing for an unchanged start/end pair).
	let lastReportedRange: { start: number; end: number } | null = null;
	$effect(() => {
		if (mode !== 'server' || !onVisibleRangeChange) return;
		const { start, end } = windowResult;
		if (lastReportedRange && lastReportedRange.start === start && lastReportedRange.end === end)
			return;
		lastReportedRange = { start, end };
		onVisibleRangeChange({ start, end });
	});

	/** Server mode: called after a header sort toggle or filter apply/clear (spec §4.1, §4.3). */
	function notifyParamsChange() {
		if (mode === 'server') {
			onParamsChange?.({ sort: gridState.sort, filters: gridState.filters });
		}
	}

	const showSortPriority = $derived(gridState.sort.length > 1);

	function widthOf(column: GridColumn<TRow>): number {
		return gridState.widths[column.id] ?? column.width ?? DEFAULT_COLUMN_WIDTH;
	}

	const templateColumns = $derived(
		gridState.orderedColumns.map((column) => `${widthOf(column)}px`).join(' ')
	);
	const totalColumnsWidth = $derived(
		gridState.orderedColumns.reduce((sum, column) => sum + widthOf(column), 0)
	);
	const orderedFieldIds = $derived(gridState.orderedColumns.map((column) => column.id));

	/** Keyed `{#each}` block key for a (possibly sparse-hole) visible row. */
	function rowKeyFor(row: TRow | undefined, rowIndex: number): string | number {
		return row === undefined ? `__hole_${rowIndex}` : getRowId(row);
	}

	/** Keyed `{#each}` block key for a grouped-mode flat entry (spec §4.3). */
	function entryKeyFor(entry: FlatEntry<TRow>): string | number {
		return entry.kind === 'group' ? `__group_${entry.key}` : getRowId(entry.row);
	}

	/**
	 * Resolve the concrete row at a "display" row index - i.e. an index into
	 * whichever list is currently driving rendering/selection (`groupedEntries`
	 * when grouped, `rows` in server mode, `sorted` otherwise). Every place
	 * that used to read `sorted[selection.active.rowIndex]` goes through this
	 * instead, so cell selection/editing/copy-paste keep working unchanged
	 * whether or not grouping is active (spec §4.3). Returns undefined for a
	 * group header row or an out-of-range index.
	 */
	function rowAtDisplayIndex(index: number): TRow | undefined {
		if (groupedEntries) {
			const entry = groupedEntries[index];
			return entry && entry.kind === 'row' ? entry.row : undefined;
		}
		return mode === 'server' ? rows[index] : sorted[index];
	}

	/** Whether the entry at this display row index is a group header (spec §4.3). */
	function isGroupHeaderAt(index: number): boolean {
		return groupedEntries?.[index]?.kind === 'group';
	}

	/** The group key at this display row index, or null when it's not a group header row. */
	function groupKeyAt(index: number): string | null {
		const entry = groupedEntries?.[index];
		return entry && entry.kind === 'group' ? entry.key : null;
	}

	/** Click (or Enter/Space via the container's keydown handler) toggles a group header's collapsed state (spec §4.3). */
	function handleGroupHeaderClick(rowIndex: number, key: string) {
		containerEl?.focus();
		selection.setActive(rowIndex, selection.active?.field ?? orderedFieldIds[0], false);
		gridState.toggleGroup(key);
	}

	function renderCell(column: GridColumn<TRow>, row: TRow): string {
		const raw = getColumnValue(row, column);
		if (column.format) return column.format(raw, row);
		if (raw === null || raw === undefined) return '';
		return String(raw);
	}

	// .cell is a flex container with a single text node, so horizontal
	// alignment must go through justify-content (text-align has no effect
	// on flex layout).
	function justifyFor(align: GridColumn<TRow>['align']): string {
		if (align === 'right') return 'flex-end';
		if (align === 'center') return 'center';
		return 'flex-start';
	}

	// --- Column drag-reorder (pointer events, driven from HeaderCell) ---
	let dragColumnId: string | null = $state(null);
	let dropIndex: number | null = $state(null);

	function handleDragStart(columnId: string) {
		dragColumnId = columnId;
		// A VISIBLE-order index, like the one handleDragMove computes below
		// and the one `moveColumn` expects - `gridState.order` also carries
		// hidden ids (spec §4.4), so an index into it would point at the
		// wrong drop slot as soon as a column is hidden.
		dropIndex = orderedFieldIds.indexOf(columnId);
	}

	function handleDragMove(clientX: number) {
		if (!headerRowEl) return;
		const rect = headerRowEl.getBoundingClientRect();
		const x = clientX - rect.left;
		let cumulative = 0;
		const cols = gridState.orderedColumns;
		let index = cols.length;
		for (let i = 0; i < cols.length; i++) {
			const w = widthOf(cols[i]);
			if (x < cumulative + w / 2) {
				index = i;
				break;
			}
			cumulative += w;
		}
		dropIndex = index;
	}

	function handleDragEnd() {
		if (dragColumnId !== null && dropIndex !== null) {
			gridState.moveColumn(dragColumnId, dropIndex);
		}
		dragColumnId = null;
		dropIndex = null;
	}

	const dropIndicatorX = $derived.by(() => {
		if (dropIndex === null) return null;
		let x = 0;
		const cols = gridState.orderedColumns;
		for (let i = 0; i < dropIndex && i < cols.length; i++) {
			x += widthOf(cols[i]);
		}
		return x;
	});

	// --- Cell selection / navigation (spec §4.5) ---
	const selection = new CellSelection();

	/**
	 * Hiding a column (spec §4.4) can strand cell state that names it: the
	 * active/anchor cell and an open editor are stored by FIELD ID, so a
	 * column leaving `orderedColumns` would otherwise leave `getRange`
	 * returning null (copy/paste silently stops) and Enter/F2 acting on a
	 * cell with no DOM node. Drop whatever points at a now-invisible column.
	 * Only `orderedFieldIds` is a tracked dependency - the writes read and
	 * mutate the very state they touch, so they run inside `untrack`
	 * (conventions §8).
	 */
	$effect(() => {
		const visible = new Set(orderedFieldIds);
		untrack(() => {
			const stale = (pos: { field: string } | null) => pos !== null && !visible.has(pos.field);
			if (stale(selection.active)) {
				selection.clear();
			} else if (stale(selection.anchor) || stale(selection.rangeEnd)) {
				// The active cell survived but a range corner did not: collapse
				// to the single active cell rather than keep a rectangle whose
				// edge no longer exists.
				if (selection.active) {
					selection.setActive(selection.active.rowIndex, selection.active.field, false);
				} else {
					selection.clear();
				}
			}
			if (editing && !visible.has(editing.field)) editing = null;
		});
	});

	/**
	 * Any VISIBLE column that could ever be editable switches the row-open
	 * interaction (see handleCellClick/handleCellDoubleClick below). Read off
	 * `orderedColumns`, not the `columns` prop: with every editable column
	 * hidden (spec §4.4) the grid on screen is read-only, and single click
	 * should open the row again instead of being reserved for cell selection.
	 */
	const hasEditableColumns = $derived(
		gridState.orderedColumns.some((column) => Boolean(column.editable))
	);

	// Pre-merge review fix (deferred): delegates to the pure, unit-tested
	// `isColumnEditable` (core/edit.ts), whose whole point is that a column
	// with a `cell` renderer is never editable - see its doc comment for why.
	function isEditable(column: GridColumn<TRow>, row: TRow): boolean {
		return isColumnEditable(column, row);
	}

	/**
	 * Bring the active cell into view. Computed directly from row-height
	 * math / column widths rather than `Element.scrollIntoView` because the
	 * active row may not exist in the DOM yet (row virtualization) at the
	 * moment a keyboard move happens; columns are never virtualized (spec
	 * §4.2), so the horizontal computation can safely assume every column's
	 * DOM width equals `widthOf(column)`.
	 */
	function scrollActiveIntoView() {
		if (!containerEl || !selection.active) return;
		const { rowIndex, field } = selection.active;

		const rowTop = rowIndex * gridState.rowHeight;
		const rowBottom = rowTop + gridState.rowHeight;
		if (rowTop < effectiveScrollTop) {
			containerEl.scrollTop = rowTop + headerHeight;
		} else if (rowBottom > effectiveScrollTop + rowsViewportHeight) {
			containerEl.scrollTop = rowBottom - rowsViewportHeight + headerHeight;
		}

		const fieldIndex = orderedFieldIds.indexOf(field);
		if (fieldIndex === -1) return;
		let x = 0;
		for (let i = 0; i < fieldIndex; i++) x += widthOf(gridState.orderedColumns[i]);
		const w = widthOf(gridState.orderedColumns[fieldIndex]);
		if (x < containerEl.scrollLeft) {
			containerEl.scrollLeft = x;
		} else if (x + w > containerEl.scrollLeft + containerEl.clientWidth) {
			containerEl.scrollLeft = x + w - containerEl.clientWidth;
		}
	}

	/**
	 * A11y fix (spec §4.7; known regression confirmed in the M3 review):
	 * Enter/Space on the active cell previously did nothing useful when the
	 * grid has editable columns and the active column is not editable - a
	 * link column (e.g. the items page's "open" column, rendered via
	 * `column.cell`) could only be reached with the mouse. Rather than
	 * reimplementing routing here (BantoGrid doesn't own it), this finds the
	 * `<a>` DOM node BantoGrid itself already rendered for the active cell
	 * and issues a real click on it, so the browser's native anchor
	 * navigation (or an app router that intercepts link clicks) takes it
	 * from there - identical to what a mouse click on that link does. Only
	 * ever finds an anchor for a currently-rendered row (guaranteed for the
	 * active cell, since every navigation keeps it in view via
	 * `scrollActiveIntoView`). Returns whether a link was found and clicked.
	 */
	function navigateActiveLink(): boolean {
		if (!containerEl || !selection.active) return false;
		const { rowIndex, field } = selection.active;
		const cellEl = containerEl.querySelector<HTMLElement>(
			`[data-cell-row="${rowIndex}"][data-cell-field="${CSS.escape(field)}"]`
		);
		const anchor = cellEl?.querySelector<HTMLAnchorElement>('a.cell-link');
		if (!anchor) return false;
		anchor.click();
		return true;
	}

	function handleCellPointerDown(event: PointerEvent, rowIndex: number, field: string) {
		if (event.button !== 0) return;
		// Move real DOM focus to the grid container so keyboard navigation
		// keeps working after a click. This synchronously blurs whatever was
		// previously focused (e.g. another cell's editor <input>), which is
		// exactly the "blur commits" behavior we want (spec §4.5).
		//
		// #236: `preventScroll` is load-bearing. A plain focus() scrolls the page
		// (every scrolling ancestor) to bring the container into view, so when the
		// grid sits partly below the fold (e.g. right after a page loads, before
		// the content above it settles) the page moves between pointerdown and
		// pointerup. The pointer is then released over a different element, the
		// browser dispatches `click` to their common ancestor instead of this
		// cell, and onRowClick never runs although the cell was selected here.
		// The clicked cell is already under the pointer, so nothing needs to
		// be scrolled into view; keyboard moves scroll via scrollActiveIntoView.
		containerEl?.focus({ preventScroll: true });
		selection.setActive(rowIndex, field, event.shiftKey);

		const pointerId = event.pointerId;
		function onMove(moveEvent: PointerEvent) {
			if (moveEvent.pointerId !== pointerId) return;
			// Dragging beyond the visible viewport does not auto-scroll in v1
			// (spec-noted limitation) — elementFromPoint only ever resolves to
			// cells currently rendered in the DOM.
			const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
			const cellEl = (target as HTMLElement | null)?.closest<HTMLElement>('[data-cell-row]');
			if (!cellEl?.dataset.cellField) return;
			const r = Number(cellEl.dataset.cellRow);
			if (Number.isNaN(r)) return;
			selection.setActive(r, cellEl.dataset.cellField, true);
		}
		function onUp(upEvent: PointerEvent) {
			if (upEvent.pointerId !== pointerId) return;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		}
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	// Single click: select the cell (already done on pointerdown above); for
	// grids with no editable columns at all, also preserve the M2 row-click
	// behavior. For grids with editable columns, opening a record needs a
	// dedicated affordance instead (see the items page's `cell` link column
	// and the double-click handler below), so a plain click never fires
	// onRowClick there.
	function handleCellClick(row: TRow) {
		if (!hasEditableColumns) onRowClick?.(row);
	}

	function handleCellDoubleClick(rowIndex: number, column: GridColumn<TRow>, row: TRow) {
		if (isEditable(column, row)) {
			startEditing(rowIndex, column, row);
		} else if (hasEditableColumns) {
			onRowClick?.(row);
		}
	}

	// --- Keyboard navigation (grid container; spec §4.5, §4.7) ---
	function handleContainerKeydown(event: KeyboardEvent) {
		// Header controls, filter inputs and row links own their keyboard
		// actions. A retained cell selection must not intercept bubbled keys.
		if (event.target !== event.currentTarget) return;
		// While editing, the editor input/select's own onkeydown owns Escape/
		// Enter/Tab/typing and stops propagation for every key, so this never
		// runs; the guard is a defensive no-op if that ever changes.
		if (editing) return;
		// Outside an editor, Tab/Shift+Tab follow the browser's focus order,
		// including header controls and row links, so focus can leave the grid.
		if (event.key === 'Tab') return;
		if (!selection.active) return;

		const rowCount = effectiveRowCount;
		const activeColumn = gridState.orderedColumns.find((c) => c.id === selection.active!.field);
		const activeRow = rowAtDisplayIndex(selection.active!.rowIndex);

		switch (event.key) {
			case 'ArrowUp':
				event.preventDefault();
				// Group headers are just another row slot in `groupedEntries`, so
				// up/down "moves through them" for free - no special-casing
				// needed (spec §4.3).
				selection.moveActive(-1, 0, event.shiftKey, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			case 'ArrowDown':
				event.preventDefault();
				selection.moveActive(1, 0, event.shiftKey, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			case 'ArrowLeft':
				event.preventDefault();
				// A group header renders as one full-width unit with no
				// per-column cells (spec §4.3), so there is no field to move
				// between while active sits on one - simplification: left/right
				// are a no-op there instead of trying to model a "field" concept
				// that doesn't visually exist.
				if (!isGroupHeaderAt(selection.active.rowIndex)) {
					selection.moveActive(0, -1, event.shiftKey, rowCount, orderedFieldIds);
					scrollActiveIntoView();
				}
				break;
			case 'ArrowRight':
				event.preventDefault();
				if (!isGroupHeaderAt(selection.active.rowIndex)) {
					selection.moveActive(0, 1, event.shiftKey, rowCount, orderedFieldIds);
					scrollActiveIntoView();
				}
				break;
			case 'Home':
				event.preventDefault();
				selection.setActive(selection.active.rowIndex, orderedFieldIds[0], false);
				scrollActiveIntoView();
				break;
			case 'End':
				event.preventDefault();
				selection.setActive(
					selection.active.rowIndex,
					orderedFieldIds[orderedFieldIds.length - 1],
					false
				);
				scrollActiveIntoView();
				break;
			case 'PageDown': {
				event.preventDefault();
				const step = Math.max(1, Math.round(rowsViewportHeight / gridState.rowHeight));
				selection.moveActive(step, 0, false, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			}
			case 'PageUp': {
				event.preventDefault();
				const step = Math.max(1, Math.round(rowsViewportHeight / gridState.rowHeight));
				selection.moveActive(-step, 0, false, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			}
			case 'Enter': {
				event.preventDefault();
				const enterGroupKey = groupKeyAt(selection.active.rowIndex);
				if (enterGroupKey !== null) {
					gridState.toggleGroup(enterGroupKey);
					break;
				}
				if (!activeColumn || !activeRow) break;
				if (isEditable(activeColumn, activeRow)) {
					startEditing(selection.active.rowIndex, activeColumn, activeRow);
				} else if (!hasEditableColumns && onRowClick) {
					onRowClick(activeRow);
				} else if (navigateActiveLink()) {
					// A11y fix (spec §4.7, M3 review regression): the active
					// column isn't editable but renders a link (e.g. the items
					// page's "open" column) - navigate it, same as a mouse
					// click on the rendered <a> would.
				} else {
					selection.moveActive(1, 0, false, rowCount, orderedFieldIds);
					scrollActiveIntoView();
				}
				break;
			}
			case 'F2':
				if (activeColumn && activeRow && isEditable(activeColumn, activeRow)) {
					event.preventDefault();
					startEditing(selection.active.rowIndex, activeColumn, activeRow);
				}
				break;
			case ' ': {
				const spaceGroupKey = groupKeyAt(selection.active.rowIndex);
				if (spaceGroupKey !== null) {
					event.preventDefault();
					gridState.toggleGroup(spaceGroupKey);
					break;
				}
				if (!hasEditableColumns && onRowClick && activeRow) {
					event.preventDefault();
					onRowClick(activeRow);
				} else if (
					activeColumn &&
					activeRow &&
					!isEditable(activeColumn, activeRow) &&
					navigateActiveLink()
				) {
					// Same a11y fix as Enter above; editable columns are
					// deliberately left alone (Space starts nothing for them
					// today, unchanged).
					event.preventDefault();
				}
				break;
			}
			default:
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
					event.preventDefault();
					void copySelection();
				}
				break;
		}
	}

	// --- Inline editing (spec §4.5) ---
	interface EditingState {
		sessionId: number;
		rowId: string | number;
		field: string;
		draft: unknown;
		error: string | null;
		pending: boolean;
	}

	let editing: EditingState | null = $state(null);
	// spec §4.5 / conventions §8 / #210: even reopening the same cell
	// starts a new session. Keep the counter after a session closes so a
	// delayed post-commit navigation cannot move a newer selection.
	let editSessionId = 0;
	// Saving/validation replaces `editing`; keep those state changes from
	// invalidating the row lookup or taking over a user's newer selection.
	const editingRowId = $derived.by(() => editing?.rowId);
	const editingField = $derived.by(() => editing?.field);
	let previousEditingPosition: { rowId: string | number; field: string; rowIndex: number } | null =
		null;

	// spec §4.1 / #205: a server array's extent includes unloaded holes.
	// Enumerate present slots only; findIndex/forEach would visit or test
	// every index and create reactive dependencies on the missing rows.
	// Object.keys also tracks additions/deletions in a caller's $state array.
	const serverRowIndexById = $derived.by(() => {
		const indices = new Map<string | number, number>();
		const rowCount = effectiveRowCount;
		for (const key of Object.keys(rows)) {
			const index = Number(key);
			if (!Number.isInteger(index) || index < 0 || index >= rowCount) continue;
			const row = rows[index];
			if (row !== undefined) indices.set(getRowId(row), index);
		}
		return indices;
	});

	// spec §4.5 / #205: an edit belongs to a record, not a display slot.
	// Resolve against the full displayed dataset (including loaded server
	// rows), so virtualization alone does not cancel an off-screen edit.
	const editingRowIndex = $derived.by(() => {
		const rowId = editingRowId;
		if (rowId === undefined) return -1;
		if (mode === 'server') return serverRowIndexById.get(rowId) ?? -1;
		const index = groupedEntries
			? groupedEntries.findIndex((entry) => entry.kind === 'row' && getRowId(entry.row) === rowId)
			: sorted.findIndex((row) => row !== undefined && getRowId(row) === rowId);
		return index < effectiveRowCount ? index : -1;
	});

	$effect(() => {
		const rowId = editingRowId;
		const rowIndex = editingRowIndex;
		const field = editingField;
		untrack(() => {
			const previous = previousEditingPosition;
			previousEditingPosition =
				rowId === undefined || field === undefined ? null : { rowId, field, rowIndex };
			if (rowId === undefined || field === undefined) return;
			// Follow an edit only while its previous cell is still selected.
			// A click elsewhere during blur-save owns the new selection.
			const followsEdit =
				previous !== null &&
				previous.rowId === rowId &&
				previous.field === field &&
				selection.active?.rowIndex === previous.rowIndex &&
				selection.active.field === field;
			if (rowIndex < 0) {
				// Deleted, filtered out, collapsed, or unloaded: never leave a
				// draft waiting to attach to a replacement row at the old index.
				editing = null;
				if (followsEdit) selection.clear();
			} else if (followsEdit && previous.rowIndex !== rowIndex) {
				selection.setActive(rowIndex, field, false);
			}
		});
	});

	function startEditing(rowIndex: number, column: GridColumn<TRow>, row: TRow) {
		if (!isEditable(column, row)) return;
		const rowId = getRowId(row);
		selection.setActive(rowIndex, column.id, false);
		previousEditingPosition = { rowId, field: column.id, rowIndex };
		editFocus = { sessionId: ++editSessionId, owned: true };
		editing = {
			sessionId: editSessionId,
			rowId,
			field: column.id,
			draft: getColumnValue(row, column),
			error: null,
			pending: false
		};
	}

	/** Runs prepareCommit and, if it decides to commit, awaits onCellEdit. Returns whether the edit session should close. */
	async function commitValue(
		column: GridColumn<TRow>,
		row: TRow,
		value: unknown
	): Promise<boolean> {
		if (!editing || editing.rowId !== getRowId(row) || editing.field !== column.id) return false;
		const { sessionId, rowId } = editing;
		// Re-resolve at the commit boundary too: a removed editor can emit
		// blur before the cancellation effect runs, carrying its old row.
		const currentRow = rowAtDisplayIndex(editingRowIndex);
		if (currentRow === undefined || getRowId(currentRow) !== rowId) return false;
		const result = prepareCommit(column, currentRow, rowId, value);

		if (result.kind === 'noop') {
			editing = null;
			return true;
		}
		if (result.kind === 'invalid') {
			editing = {
				sessionId,
				rowId,
				field: column.id,
				draft: value,
				error: result.message,
				pending: false
			};
			return false;
		}

		if (!onCellEdit) {
			editing = null;
			return true;
		}
		editing = { sessionId, rowId, field: column.id, draft: value, error: null, pending: true };
		try {
			await onCellEdit(result.edit);
			// The caller's save still completes, but only the session that
			// submitted it owns these UI updates (including the failure path).
			if (editing?.sessionId !== sessionId) return false;
			editing = null;
			return true;
		} catch (err) {
			if (editing?.sessionId !== sessionId) return false;
			const message = err instanceof Error ? err.message : String(err);
			editing = {
				sessionId,
				rowId,
				field: column.id,
				draft: value,
				error: message,
				pending: false
			};
			return false;
		}
	}

	/** Parse the current draft text and commit; optionally move the active cell afterward on success. */
	async function commitFromEditor(
		column: GridColumn<TRow>,
		row: TRow,
		moveAfter?: 'down' | 'left' | 'right'
	) {
		if (!editing || editing.pending) return;
		const sessionId = editing.sessionId;
		const focus = editFocus;
		const editorType = column.editor ?? 'text';
		let value: unknown;
		if (editorType === 'select') {
			// Never round-trip a select's draft through parseCellInput: it only
			// passes strings through unchanged, which would undo the onchange
			// handler's editorOptions resolution below. Re-resolving here is
			// idempotent (and also covers the paste path never reaching this
			// function at all), and is what makes `prepareCommit`'s `draft ===
			// oldValue` no-op check work for select columns with non-string
			// (e.g. numeric) option values.
			value = resolveSelectValue(String(editing.draft ?? ''), column.editorOptions);
		} else {
			// Typed: a year-less date is this year's (the injected date input's
			// rule); a paste or CSV cell never guesses it (date-time-pickers §5.10).
			const parsed = parseCellInput(String(editing.draft ?? ''), editorType, { typed: true });
			if (!parsed.ok) {
				editing = { ...editing, error: t.inlineEditInvalid() };
				if (moveAfter === 'left' || moveAfter === 'right') await focusEditError(sessionId);
				return;
			}
			value = parsed.value;
		}
		const closed = await commitValue(column, row, value);
		if (!closed && (moveAfter === 'left' || moveAfter === 'right')) {
			await focusEditError(sessionId);
		}
		// A newer session may start between commitValue closing this one
		// and this continuation running, including after a synchronous save.
		if (
			closed &&
			moveAfter &&
			editSessionId === sessionId &&
			focus?.owned &&
			containerEl?.isConnected
		) {
			const rowCount = effectiveRowCount;
			if (moveAfter === 'down') selection.moveActive(1, 0, false, rowCount, orderedFieldIds);
			else if (moveAfter === 'left') selection.moveActive(0, -1, false, rowCount, orderedFieldIds);
			else selection.moveActive(0, 1, false, rowCount, orderedFieldIds);
			scrollActiveIntoView();
			containerEl.focus({ preventScroll: true });
		}
	}

	function handleCheckboxToggle(column: GridColumn<TRow>, row: TRow, checked: boolean) {
		if (!editing || editing.pending) return;
		void commitValue(column, row, checked);
	}

	function canFocusEditError(sessionId: number) {
		return (
			editing?.sessionId === sessionId &&
			!!editing.error &&
			editFocus?.sessionId === sessionId &&
			editFocus.owned &&
			editorEl?.isConnected &&
			editorEl.ownerDocument.activeElement === editorEl
		);
	}

	async function focusEditError(sessionId: number) {
		if (!canFocusEditError(sessionId)) return;
		// The error/position must be rendered first. A newer edit, outside click
		// or focus departure during that wait owns the focus instead.
		await tick();
		if (
			canFocusEditError(sessionId) &&
			errorRegionEl?.isConnected &&
			!errorRegionEl.hidden &&
			errorRegionEl.dataset.editSession === String(sessionId)
		) {
			errorRegionEl.focus({ preventScroll: true });
		}
	}

	function returnFromEditError(sessionId: number): boolean {
		if (editing?.sessionId !== sessionId || !editing.error || !editorEl?.isConnected) return false;
		editorEl.focus({ preventScroll: true });
		return true;
	}

	function handleEditorKeydown(event: KeyboardEvent, column: GridColumn<TRow>, row: TRow) {
		// Stop every key from bubbling to the container's navigation handler
		// (typing "5", moving the text cursor with arrow keys, etc. must not
		// move the active cell).
		event.stopPropagation();
		if (!editing || editing.pending) {
			event.preventDefault();
			return;
		}
		// IME confirmation/cancellation and keys already handled elsewhere do
		// not own a grid edit command. Some engines report composition as 229
		// even when isComposing is false. Native blur keeps its existing contract.
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
		// Returning from another window need not emit focusin on the editor.
		// A fresh key action on the focused, non-pending draft renews ownership.
		if (
			editFocus?.sessionId === editing.sessionId &&
			editorEl?.ownerDocument.activeElement === event.currentTarget
		)
			editFocus.owned = true;
		if (event.key === 'Escape') {
			event.preventDefault();
			const restoreFocus = editFocus?.owned;
			editing = null;
			if (restoreFocus) containerEl?.focus({ preventScroll: true });
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			void commitFromEditor(column, row, 'down');
			return;
		}
		if (event.key === 'Tab') {
			event.preventDefault();
			// Reading an existing failure must not retry a rejected API request,
			// even if the user has since changed the draft. Enter retries it.
			if (editing.error) void focusEditError(editing.sessionId);
			else void commitFromEditor(column, row, event.shiftKey ? 'left' : 'right');
			return;
		}
	}

	function handleEditorBlur(event: FocusEvent, column: GridColumn<TRow>, row: TRow) {
		if (!editing || editing.rowId !== getRowId(row) || editing.field !== column.id) return;
		if (
			event.relatedTarget instanceof Node &&
			errorRegionEl?.contains(event.relatedTarget) &&
			errorRegionEl.dataset.editSession === String(editing.sessionId)
		)
			return;
		void commitFromEditor(column, row);
	}

	/**
	 * Grouped-mode counterpart of `rangeToTsv` (spec §4.3): a range spanning a
	 * group header simply skips that line entirely (not an empty TSV line,
	 * unlike a server-mode sparse-array hole) - simplification documented in
	 * the spec itself ("TSV copy of a range spanning a header just skips
	 * that line").
	 */
	function groupedRangeToTsv(range: CellRange): string {
		const entries = groupedEntries!;
		const lines: string[] = [];
		for (let r = range.rowStart; r <= range.rowEnd; r++) {
			const entry = entries[r];
			if (!entry || entry.kind === 'group') continue;
			const cells: string[] = [];
			for (let f = range.fieldStart; f <= range.fieldEnd; f++) {
				const column = gridState.orderedColumns[f];
				if (!column) {
					cells.push('');
					continue;
				}
				const raw = getColumnValue(entry.row, column);
				cells.push(raw === null || raw === undefined ? '' : String(raw));
			}
			lines.push(cells.join('\t'));
		}
		return lines.join('\n');
	}

	// --- Copy / paste (TSV; spec §4.5) ---
	async function copySelection() {
		const range = selection.getRange(orderedFieldIds);
		if (!range) return;
		const text = groupedEntries
			? groupedRangeToTsv(range)
			: rangeToTsv(sorted, gridState.orderedColumns, range, getColumnValue);

		if (navigator.clipboard?.writeText) {
			try {
				await navigator.clipboard.writeText(text);
				return;
			} catch {
				// fall through to the execCommand fallback below
			}
		}
		// Fallback for webviews without navigator.clipboard (or a rejected
		// write permission): a hidden textarea + execCommand('copy'), which
		// works synchronously with no clipboard-write permission prompt.
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.select();
		try {
			document.execCommand('copy');
		} finally {
			document.body.removeChild(textarea);
		}
	}

	// We deliberately use the DOM 'paste' event instead of
	// `navigator.clipboard.readText()`: readText requires a clipboard-read
	// permission grant that isn't available (or is inconsistent) across every
	// target webview (WebView2 / WKWebView / WebKitGTK) and remote-browser
	// mode, whereas the 'paste' event fires on the focused element for a
	// plain Ctrl/Cmd+V with no extra permission.
	function handlePaste(event: ClipboardEvent) {
		if (editing) return; // let the focused editor input's native paste behavior run instead
		// A paste into a header control - the filter popover's value or date
		// boxes - is that control's own, like a bubbled key (handleContainerKeydown).
		if (event.target !== event.currentTarget) return;
		if (!onRangePaste) return;
		if (!selection.active) return;
		const text = event.clipboardData?.getData('text/plain') ?? '';
		if (!text) return;
		event.preventDefault();

		const grid = parseTsv(text);
		const orderedColumns = gridState.orderedColumns;
		const startRowIndex = selection.active.rowIndex;
		const startFieldIndex = orderedFieldIds.indexOf(selection.active.field);
		if (startFieldIndex === -1) return;

		const edits: CellEdit<TRow>[] = [];
		let skipped = 0;

		grid.forEach((lineCells, rOffset) => {
			// Grouped mode (spec §4.3): a pasted line landing on a group header
			// row resolves to `undefined` here too (same as a server-mode
			// sparse-array hole), so it falls into the existing skip branch
			// below - consistent with copy's "skip group header lines" rule.
			const row = rowAtDisplayIndex(startRowIndex + rOffset);
			if (!row) {
				skipped += lineCells.length;
				return;
			}
			lineCells.forEach((cellText, fOffset) => {
				const column = orderedColumns[startFieldIndex + fOffset];
				if (!column || !isEditable(column, row)) {
					skipped += 1;
					return;
				}
				const parsed = parseCellInput(cellText, column.editor ?? 'text');
				if (!parsed.ok) {
					skipped += 1;
					return;
				}
				// parseCellInput's 'select' case is a string pass-through (it has
				// no access to column.editorOptions), so a pasted select-column
				// cell needs the same value-type reconciliation the interactive
				// onchange handler gets (see commitFromEditor above) - otherwise a
				// numeric editorOptions value would be committed as a string.
				const value =
					column.editor === 'select'
						? resolveSelectValue(String(parsed.value), column.editorOptions)
						: parsed.value;
				const result = prepareCommit(column, row, getRowId(row), value);
				if (result.kind === 'invalid') {
					skipped += 1;
					return;
				}
				if (result.kind === 'commit') edits.push(result.edit);
				// 'noop' (unchanged value): nothing to do, and not counted as skipped.
			});
		});

		if (edits.length > 0 || skipped > 0) {
			void onRangePaste(edits, { skipped });
		}
	}
</script>

<div class="banto-grid-frame" bind:this={frameEl}>
	<div
		class="banto-grid"
		bind:this={containerEl}
		role="grid"
		tabindex="0"
		aria-rowcount={effectiveRowCount + 1}
		aria-colcount={gridState.orderedColumns.length}
		onscroll={handleScroll}
		onkeydown={handleContainerKeydown}
		onpaste={handlePaste}
	>
		<div class="scroll-content" role="presentation" style:width={`${totalColumnsWidth}px`}>
			<div
				class="header-row"
				role="row"
				aria-rowindex={1}
				bind:this={headerRowEl}
				style:grid-template-columns={templateColumns}
			>
				{#each gridState.orderedColumns as column (column.id)}
					<HeaderCell
						{column}
						state={gridState}
						width={widthOf(column)}
						showPriority={showSortPriority}
						onDragStart={handleDragStart}
						onDragMove={handleDragMove}
						onDragEnd={handleDragEnd}
						onSortOrFilterChange={notifyParamsChange}
						{messages}
						dateRangeInput={editors.dateRange}
					/>
				{/each}
			</div>

			{#if dropIndicatorX !== null}
				<div
					class="drop-indicator"
					style:left={`${dropIndicatorX}px`}
					style:height={`${headerHeight + windowResult.totalHeight}px`}
				></div>
			{/if}

			{#snippet dataRow(row: TRow, rowIndex: number)}
				<div
					class="row {rowClass?.(row) ?? ''}"
					role="row"
					aria-rowindex={rowIndex + 2}
					style:grid-template-columns={templateColumns}
					style:height={`${gridState.rowHeight}px`}
					style:--banto-grid-editor-height={`min(var(--banto-control-height), calc(${gridState.rowHeight}px - var(--banto-border-width)))`}
				>
					{#each gridState.orderedColumns as column, fieldIndex (column.id)}
						{@const isActiveCell =
							selection.active?.rowIndex === rowIndex && selection.active?.field === column.id}
						{@const isInRange = selection.isSelected(rowIndex, fieldIndex, orderedFieldIds)}
						{@const isEditingCell =
							editing?.rowId === getRowId(row) && editing?.field === column.id}
						{@const linkInfo = column.cell?.(row)}
						<!--
						Keyboard focus/activation for cells is handled at the grid
						container level (roving "virtual" focus via `selection.active`
						+ handleContainerKeydown), not per-cell DOM focus/tabindex:
						row/cell DOM nodes come and go under virtualization, so a
						literal per-cell tabindex would be meaningless as soon as a
						row scrolls out. Mouse users still get click/dblclick here.
					-->
						<!-- svelte-ignore a11y_interactive_supports_focus -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<div
							class="cell"
							role="gridcell"
							aria-selected={isInRange}
							aria-busy={isEditingCell ? !!editing?.pending : undefined}
							data-cell-row={rowIndex}
							data-cell-field={column.id}
							style:justify-content={justifyFor(column.align)}
							class:active={isActiveCell}
							class:in-range={isInRange && !isActiveCell}
							class:editing={isEditingCell}
							class:error={isEditingCell && !!editing?.error}
							onpointerdown={(event) => handleCellPointerDown(event, rowIndex, column.id)}
							onclick={() => handleCellClick(row)}
							ondblclick={() => handleCellDoubleClick(rowIndex, column, row)}
						>
							{#if linkInfo}
								{#if linkInfo.href}
									<a
										class="cell-link"
										href={linkInfo.href}
										onclick={(event) => event.stopPropagation()}
										ondblclick={(event) => event.stopPropagation()}>{linkInfo.text}</a
									>
								{:else}
									{linkInfo.text}
								{/if}
							{:else if isEditingCell && editing}
								<!-- `editing?.`: Esc / a commit can end the session and move focus
								     synchronously, before this block is removed - an injected editor
								     reads its props in its own blur (date-time-pickers §5.8). -->
								<CellEditor
									editor={column.editor}
									label={column.header.trim() || column.id}
									invalid={!!editing?.error}
									describedBy={editing?.error ? editErrorId : undefined}
									pending={!!editing?.pending}
									draft={editing?.draft}
									options={column.editorOptions}
									dateEditor={editors.date}
									timeEditor={editors.time}
									dateTimeEditor={editors.datetime}
									min={column.editorMin}
									max={column.editorMax}
									isDateDisabled={column.isDateDisabled}
									step={column.editorStep}
									bind:editorEl
									bind:editorRootEl
									onDraftChange={(value) => {
										if (editing) editing.draft = value;
									}}
									onToggle={(checked) => handleCheckboxToggle(column, row, checked)}
									onKeydown={(event) => handleEditorKeydown(event, column, row)}
									onBlur={(event) => handleEditorBlur(event, column, row)}
								/>
							{:else}
								{renderCell(column, row)}
							{/if}
						</div>
					{/each}
				</div>
			{/snippet}

			{#if effectiveRowCount === 0}
				<div class="empty-row">{t.emptyState()}</div>
			{:else}
				<div
					class="rows-viewport"
					role="presentation"
					style:height={`${windowResult.totalHeight}px`}
				>
					<div
						class="rows-block"
						role="rowgroup"
						style:transform={`translateY(${windowResult.offsetY}px)`}
					>
						{#if groupedEntries}
							<!-- Client mode, grouped (spec §4.3): group headers + rows flattened by buildGroupedView. -->
							{#each visibleEntries as entry, i (entryKeyFor(entry))}
								{@const rowIndex = windowResult.start + i}
								{#if entry.kind === 'group'}
									<!--
									role="row" (not "button"): this is still a grid row
									semantically (spec §4.3 asks for role="row" +
									aria-expanded), just one that toggles on click/Enter/
									Space. Keyboard activation goes through the container's
									existing roving-focus keydown handler (same pattern as
									the per-cell divs above), not a per-element tabindex, so
									the interactive-role a11y lint is suppressed rather than
									"fixed" by adding a real tabindex here.
								-->
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_interactive_supports_focus -->
									<div
										class="row group-header-row"
										role="row"
										aria-rowindex={rowIndex + 2}
										aria-expanded={!entry.collapsed}
										style:height={`${gridState.rowHeight}px`}
										onclick={() => handleGroupHeaderClick(rowIndex, entry.key)}
									>
										<span class="disclosure" aria-hidden="true">{entry.collapsed ? '▸' : '▾'}</span>
										<span class="group-label"
											>{entry.label}{t.groupCountSuffix(entry.count.toLocaleString())}</span
										>
										{#each gridState.orderedColumns.filter((c) => c.aggregate) as aggColumn (aggColumn.id)}
											<span class="agg-chip"
												>{aggColumn.header}: {entry.aggregates[aggColumn.id] ?? ''}</span
											>
										{/each}
									</div>
								{:else}
									{@render dataRow(entry.row, rowIndex)}
								{/if}
							{/each}
						{:else}
							{#each visibleRows as row, i (rowKeyFor(row, windowResult.start + i))}
								{@const rowIndex = windowResult.start + i}
								{#if row === undefined}
									<!--
									Server mode (spec §4.1, M5): this absolute row
									index hasn't been fetched yet (a hole in the
									sparse `rows` array) - render an inert
									placeholder at the right height so the
									scrollbar/virtualization math stays correct,
									with no click/edit interactions and its content
									hidden from assistive tech (there's nothing
									meaningful to announce yet).
								-->
									<div
										class="row placeholder-row"
										role="row"
										aria-rowindex={rowIndex + 2}
										aria-hidden="true"
										style:grid-template-columns={templateColumns}
										style:height={`${gridState.rowHeight}px`}
									>
										{#each gridState.orderedColumns as column, fieldIndex (column.id)}
											<div
												class="cell placeholder-cell"
												style:justify-content={justifyFor(column.align)}
											>
												{#if fieldIndex === 0}…{/if}
											</div>
										{/each}
									</div>
								{:else}
									{@render dataRow(row, rowIndex)}
								{/if}
							{/each}
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>
	{#if editing?.error}
		<CellEditError
			frame={frameEl}
			grid={containerEl}
			editor={editorEl}
			bind:element={errorRegionEl}
			sessionId={editing.sessionId}
			anchorLayout={`${editingRowIndex}:${orderedFieldIds.indexOf(editing.field)}:${templateColumns}:${headerHeight}`}
			errorId={editErrorId}
			message={editing.error}
			label={t.inlineEditErrorLabel(
				columns.find((column) => column.id === editing?.field)?.header.trim() || editing.field
			)}
			hint={t.inlineEditErrorHint()}
			onReturn={returnFromEditError}
		/>
	{/if}
</div>

<style>
	.banto-grid-frame {
		position: relative;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}
	.banto-grid {
		position: relative;
		height: 100%;
		width: 100%;
		overflow: auto;
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: calc(var(--banto-radius) * 2);
		font-size: var(--banto-font-size-md);
	}

	.banto-grid:focus {
		outline: none;
	}

	.banto-grid:focus-visible {
		outline: var(--banto-border-width-strong, 2px) solid var(--banto-primary);
		outline-offset: calc(-1 * var(--banto-border-width-strong, 2px));
	}

	@media (forced-colors: active) {
		.banto-grid:focus-visible {
			outline-color: Highlight;
		}

		.cell.in-range {
			outline: var(--banto-border-width-strong, 2px) dashed Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong, 2px));
		}
	}

	.scroll-content {
		min-width: 100%;
		position: relative;
	}

	.header-row {
		position: sticky;
		top: 0;
		z-index: 10;
		display: grid;
		height: var(--banto-grid-header-height);
		background: var(--banto-surface-subtle);
		border-bottom: var(--banto-border-width) solid var(--banto-border-strong);
	}

	.drop-indicator {
		position: absolute;
		top: 0;
		width: 2px;
		background: var(--banto-primary);
		pointer-events: none;
	}

	.rows-viewport {
		position: relative;
	}

	.rows-block {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
	}

	.row {
		display: grid;
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		box-sizing: border-box;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.row:hover {
		background: var(--banto-surface-hover);
	}

	/* Server mode (spec §4.1, M5): a not-yet-fetched sparse-array hole. */
	.placeholder-row:hover {
		background: none;
	}

	.placeholder-cell {
		display: flex;
		align-items: center;
		padding: 0 var(--banto-space-2);
		color: var(--banto-text-muted);
		user-select: none;
	}

	/* Client-mode grouping (spec §4.3): a collapsible group header row, spanning full width (overrides .row's `display: grid`). */
	.group-header-row {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		padding: 0 var(--banto-space-2);
		background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
		font-weight: 600;
		cursor: pointer;
		user-select: none;
	}

	.group-header-row:hover {
		background: color-mix(in srgb, var(--banto-primary) 10%, transparent);
	}

	.disclosure {
		width: 1em;
		flex: 0 0 auto;
		text-align: center;
		color: var(--banto-primary);
	}

	.group-label {
		flex: 0 0 auto;
	}

	.agg-chip {
		font-weight: 400;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: 999px;
		padding: var(--banto-space-1) var(--banto-space-2);
		white-space: nowrap;
	}

	.cell {
		position: relative;
		padding: 0 var(--banto-space-2);
		display: flex;
		align-items: center;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--banto-text);
		font-variant-numeric: tabular-nums;
	}

	.cell.active {
		outline: var(--banto-border-width-strong) solid var(--banto-primary);
		outline-offset: calc(-1 * var(--banto-border-width-strong));
		z-index: 1;
	}

	.cell.in-range {
		background: color-mix(in srgb, var(--banto-primary) 12%, transparent);
	}

	/* Editing uses the solid primary (vs. active's text-toned primary) so the
	   two states stay visually distinct within the same primary family. */
	.cell.editing {
		padding: 0;
		overflow: visible;
		z-index: 2;
		outline: var(--banto-border-width-strong) solid var(--banto-primary-solid);
		outline-offset: calc(-1 * var(--banto-border-width-strong));
		background: var(--banto-surface);
	}

	.cell.editing.error {
		outline: var(--banto-border-width-strong) solid var(--banto-danger-solid);
		outline-offset: calc(-1 * var(--banto-border-width-strong));
	}

	.cell-link {
		/* --banto-primary text on the cell background falls short of 4.5:1 on
		   the dark theme (~4.38:1). --banto-primary-hover is the same
		   already-defined token used for this exact contrast bump elsewhere
		   (e.g. Sidebar.svelte's active nav-item text): light #1d4ed8 = 6.7:1,
		   dark #60a5fa = 6.3:1. */
		color: var(--banto-primary-hover);
		text-decoration: none;
	}

	.cell-link:hover {
		text-decoration: underline;
	}

	.empty-row {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 8rem;
		padding: var(--banto-space-6);
		text-align: center;
		color: var(--banto-text-muted);
	}
</style>
