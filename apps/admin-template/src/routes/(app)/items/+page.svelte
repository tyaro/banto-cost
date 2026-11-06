<script lang="ts">
	import {
		ColumnsMenu,
		GridState,
		convertCsvRow,
		csvFilename,
		csvForExcel,
		filterRows,
		mapCsvHeader,
		parseCsv,
		toCsv,
		columnsFromSchema,
		type CellEdit,
		type GridColumn
	} from '@banto/grid-svelte';
	import {
		currentSessionScope,
		getDataProvider,
		getResource,
		invalidate,
		isProviderError,
		loadActiveListMode,
		loadLastOpenedId,
		loadListViewState,
		notify,
		saveActiveListMode,
		saveListViewState,
		takeLastEditedRecord
	} from '@banto/admin-core';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Download, Plus, Upload } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { columnValidationMessages, gridMessages } from '#lib/banto/i18n.js';
	import type { Item } from '#lib/banto/sampleData.js';
	import { itemsSchema } from '#lib/banto/resources/items.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { exportCsvToFolder, importItems, isItemsImportAvailable } from '#lib/banto/itemsAdmin.js';
	import { getBantoMode } from '#lib/banto/setup.js';
	import { PageHeader, StatusBadge, type StatusBadgeVariant } from '@banto/ui';
	import ItemsClientGrid from './ItemsClientGrid.svelte';
	import ItemsServerGrid from './ItemsServerGrid.svelte';
	import {
		importRowKind,
		previewRows,
		toImportPayload,
		type ImportRowPreview
	} from './importPreview';
	import { toItemRow, type ItemRow } from './itemRow';
	import { createRowSaveQueue } from './rowSaveQueue';

	const resource = getResource('items');

	// Spec M10 RBAC: `viewer` gets a read-only items page (no 新規作成 button,
	// no inline cell editing below); `editor`/`admin` are unchanged from
	// before M10.
	const canWrite = $derived(canWriteResources(sessionStore.role));

	// Issue #215: a list -> detail -> save/cancel -> list round trip must
	// restore the filter/sort the user had, not reset to the page's own
	// defaults. Persistence is `@banto/admin-core`'s `saveListViewState`/
	// `loadListViewState` (sessionStorage-backed, spec docs/... see that
	// module's doc comment) keyed per grid mode - クライアント and サーバー
	// keep independent GridStates/column sets (spec §4.1/§4.3), so their
	// saved sort/filters/groupBy must not bleed into each other.
	const RESOURCE_NAME = 'items';
	const CLIENT_VIEW_KEY = `${RESOURCE_NAME}:client`;
	const SERVER_VIEW_KEY = `${RESOURCE_NAME}:server`;

	// Issue #215/#255 (4th review): the session this page instance was built
	// for. Every list-state read/write below passes it: reads only return
	// state saved by this scope's owner (another account's - or the public
	// viewer's - search terms are never restored, however the identity
	// changed), and writes stop the moment the session ends or changes
	// owner, so this instance cannot save its (old session's) GridState back
	// on behalf of the next session. `(app)/+layout.svelte` rebuilds the page
	// for the new session, which captures a fresh scope.
	const scope = currentSessionScope();

	// M5 Phase A (spec §4.1, §10): the items page demonstrates both grid data
	// modes side by side via a toggle. Restored from the last mode the user
	// had (#215) - without this, `lastOpenedId`/the restored filters of
	// whichever mode was actually active on save would silently go unused,
	// since the page would always come back up in サーバー (the intrinsic
	// default below) regardless. Falls back to サーバー the same as before
	// #215 when nothing was saved yet (first visit this session).
	let mode: 'client' | 'server' = $state(
		loadActiveListMode(scope, RESOURCE_NAME) === 'client' ? 'client' : 'server'
	);
	$effect(() => {
		saveActiveListMode(scope, RESOURCE_NAME, mode);
	});

	const baseColumns: GridColumn<Item>[] = [
		{
			id: 'open',
			// axe-core wcag2a aria-command-name (visual-refresh-plan.md §7.1):
			// HeaderCell.svelte always renders its cell-body as role="button"
			// (even for non-sortable columns like this one), so an empty header
			// left it with no accessible name at all.
			header: m['items.colActions'](),
			accessor: () => '',
			width: 70,
			resizable: false,
			sortable: false,
			cell: (row) => ({ text: m['items.open'](), href: resolve(`items/${row.id}`) })
		},
		{
			id: 'id',
			header: 'ID',
			accessor: 'id',
			width: 80,
			align: 'right',
			filterable: true,
			filterType: 'number'
		},
		// M23 (spec §3.1): every schema-backed column (name/price/stock/
		// updatedAt) is DERIVED from the same itemsSchema the create/edit forms
		// use - header labels, editors, and validation rules (the integer
		// checks, the trimmed-length name bounds, the exact Japanese messages)
		// all come from that one definition instead of being duplicated here.
		// `overrides` carries only the presentation tuning derivation cannot
		// know (widths, the ¥ price format). Hand-written columns remain for
		// everything outside the schema: the row-link 操作 column above and the
		// DB-generated id.
		...columnsFromSchema<Item>(itemsSchema, {
			overrides: {
				name: { width: 260 },
				price: { width: 120, format: (value) => `¥${(value as number).toLocaleString()}` },
				stock: { width: 100 },
				updatedAt: { width: 140 }
			},
			// i18n layer ② (ADR-0005): feed the inline-edit validator the same
			// Paraglide-backed messages the create/edit form uses.
			messages: columnValidationMessages()
		})
	];

	/**
	 * Force every column's `editable` off for `viewer` (spec M10 RBAC):
	 * `editable: false` disables BantoGrid's inline cell editor for that
	 * column entirely, same mechanism already used for naturally read-only
	 * columns like `updatedAt`/`open`. `editor`/`admin` get `baseColumns`
	 * unchanged.
	 */
	function withWritePermission(cols: GridColumn<Item>[]): GridColumn<Item>[] {
		if (canWrite) return cols;
		return cols.map((column) => (column.editable ? { ...column, editable: false } : column));
	}

	const columns = $derived(withWritePermission(baseColumns));

	function columnById(id: string): GridColumn<Item> {
		return columns.find((column) => column.id === id)!;
	}

	// M5 Phase B (spec §4.3) grouping demo: the CLIENT grid only gets an extra
	// 「カテゴリ」 column (ItemsClientGrid derives it from `name`) plus
	// per-column aggregates, so its own column array is built separately from
	// the shared `columns` above (which stays exactly as-is for サーバー mode -
	// grouping has no server-mode equivalent yet, spec §4.3). `$derived.by`
	// (rather than a plain `const`, pre-M10) since it now reads `columns`,
	// itself derived from `canWrite`/`sessionStore.role`.
	const clientColumns = $derived.by((): GridColumn<ItemRow>[] => [
		columnById('open'),
		{ ...columnById('id'), aggregate: 'count' },
		columnById('name'),
		{
			id: 'category',
			header: m['items.groupCategory'](),
			accessor: 'category',
			width: 140,
			filterable: true,
			filterType: 'text',
			groupable: true
		},
		{ ...columnById('price'), aggregate: 'avg' },
		{ ...columnById('stock'), aggregate: 'sum' },
		columnById('updatedAt')
	]);

	// Owned here (not inside ItemsClientGrid) so the shared header's group-by
	// <select> below can call `.setGroupBy(...)` directly - same wiring
	// pattern ItemsServerGrid already uses for its own externally-owned
	// GridState (spec §4.1/§4.3).
	// svelte-ignore state_referenced_locally
	const clientGridState = new GridState<ItemRow>(clientColumns);

	// M15 Phase C: owned here (not inside ItemsServerGrid) so the CSV export
	// button below can read `.sort`/`.filters` directly and reproduce the
	// exact same ListParams the server-mode grid is currently showing - same
	// externally-owned-GridState pattern as clientGridState above.
	// svelte-ignore state_referenced_locally
	const serverGridState = new GridState<Item>(columns);

	// Issue #215: restore whatever sort/filters/groupBy this session last
	// left each mode with, BEFORE either grid's first render (plain
	// synchronous assignment, not inside an $effect - `state.svelte.ts`'s
	// setters below are perfectly ordinary property writes, no different
	// from the constructor's own seeding a few lines up). Deliberately NOT
	// `GridState.hydrate()`: that also restores column order/widths/hidden,
	// which is issue #168's scope, not this one's - mixing the two would
	// silently start persisting column layout as a side effect of this fix.
	// `knownFields` (#255 review): drop any restored sort/filter whose field
	// isn't one of THIS session's actual columns - a schema/column change
	// between sessions must not resurrect a filter/sort the current screen
	// has no column for (`loadListViewState`'s own doc comment has the full
	// reasoning). `groupBy` gets the same treatment inline below, since it's
	// a single field id outside the array `loadListViewState` already checks.
	// svelte-ignore state_referenced_locally
	const clientFieldIds = clientColumns.map((column) => column.id);
	const clientSnapshot = loadListViewState(scope, CLIENT_VIEW_KEY, clientFieldIds);
	if (clientSnapshot) {
		clientGridState.sort = clientSnapshot.sort;
		clientGridState.filters = clientSnapshot.filters;
		if (clientSnapshot.groupBy && clientFieldIds.includes(clientSnapshot.groupBy)) {
			clientGridState.setGroupBy(clientSnapshot.groupBy);
		}
	}
	// svelte-ignore state_referenced_locally
	const serverSnapshot = loadListViewState(
		scope,
		SERVER_VIEW_KEY,
		columns.map((column) => column.id)
	);
	if (serverSnapshot) {
		serverGridState.sort = serverSnapshot.sort;
		serverGridState.filters = serverSnapshot.filters;
	}

	// Persist on every sort/filter/groupBy change - cheap (a small JSON blob
	// into sessionStorage) and keeps the saved snapshot live even if the user
	// never leaves this page instance before closing the tab mid-session.
	$effect(() => {
		saveListViewState(scope, CLIENT_VIEW_KEY, {
			sort: clientGridState.sort,
			filters: clientGridState.filters,
			groupBy: clientGridState.groupBy
		});
	});
	$effect(() => {
		saveListViewState(scope, SERVER_VIEW_KEY, {
			sort: serverGridState.sort,
			filters: serverGridState.filters
		});
	});

	// The row most recently opened for this RESOURCE (#215's "直前の作業位置
	// を見つけられるようにする" - via `rowClass` highlighting below, rather
	// than scroll restoration). Deliberately ONE value shared by both grid
	// modes (admin-core's `saveLastOpenedId` doc comment explains why), and
	// deliberately NOT set from `handleRowClick` below: the items page's
	// "開く" cell is a plain link (`cell: (row) => ({ text, href })`), so
	// clicking it navigates via its own `href` and never runs `onRowClick` at
	// all once the grid has editable columns
	// (`packages/grid-svelte/src/BantoGrid.svelte`'s `handleCellClick` doc
	// comment) - `handleRowClick` only fires from a double-click on a
	// read-only cell (spec §4.5's "dedicated affordance" alternative). The
	// one place every way of reaching the detail page actually passes
	// through is that page itself, so it calls `saveLastOpenedId` on mount
	// instead. Reading it once here (a plain `const`, not `$state`) is
	// enough - the list page never mutates it itself, and a NEW value only
	// ever matters on a fresh mount of this page (returning from the
	// detail page always remounts it).
	const lastOpenedId = loadLastOpenedId(scope, RESOURCE_NAME);

	type GroupByOption = '' | 'category' | 'updatedAt';

	function handleGroupByChange(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value as GroupByOption;
		clientGridState.setGroupBy(value === '' ? null : value);
	}

	function handleRowClick(item: Item) {
		goto(resolve(`items/${item.id}`));
	}

	/** Issue #215: highlight whichever row was last opened (any mode, any navigation path - see `lastOpenedId` above) - same `rowClass` mechanism audit-log's `+page.svelte` already uses for its selected-row accent. */
	function clientRowClass(row: ItemRow): string | undefined {
		return lastOpenedId !== null && row.id === lastOpenedId ? 'items-row-last-opened' : undefined;
	}
	function serverRowClass(row: Item): string | undefined {
		return lastOpenedId !== null && row.id === lastOpenedId ? 'items-row-last-opened' : undefined;
	}

	// Issue #215: "編集結果が絞り込みの条件から外れた場合も、フィルタを勝手に
	// 解除しない" - a detail page that just saved leaves a one-shot marker
	// (admin-core's `noteLastEditedRecord`/`takeLastEditedRecord`) with the
	// row's values AT SAVE TIME. Reusing `filterRows` (the exact function
	// BantoGrid's own client mode filters with) against the CURRENT mode's
	// restored filters answers "does this row still match?" without a round
	// trip - if not, explain it instead of silently clearing the filter.
	// Naturally one-shot and idempotent: `takeLastEditedRecord` clears the
	// marker on read, so a later re-run of this effect (e.g. `mode` toggled)
	// finds nothing and leaves `filterExclusionNotice` alone.
	let filterExclusionNotice: { id: string | number } | null = $state(null);
	$effect(() => {
		const record = takeLastEditedRecord(scope, RESOURCE_NAME);
		if (!record) return;
		// #255 review: the CLIENT grid never filters the raw saved row - it
		// filters `toItemRow(row)` (ItemsClientGrid.svelte, shared via
		// `itemRow.ts`), which adds the synthetic `category` field a category
		// filter/group-by actually matches against. Checking `record.values`
		// (no `category` at all) here would report every category-filtered
		// row as "excluded" even when it's still plainly visible on screen -
		// the exclusion check must run through the exact same derivation the
		// grid renders/filters with.
		const activeColumns = mode === 'client' ? clientColumns : columns;
		const activeFilters = mode === 'client' ? clientGridState.filters : serverGridState.filters;
		const row = mode === 'client' ? toItemRow(record.values as Item) : (record.values as Item);
		const matches = filterRows([row], activeFilters, activeColumns as GridColumn<Item>[]);
		if (matches.length === 0) {
			filterExclusionNotice = { id: record.id };
		}
	});

	/** Merge changed columns onto the base row's other values (DataProvider.update expects the full editable value set). */
	function mergedValues(row: Item, changes: Record<string, unknown>): Record<string, unknown> {
		return { name: row.name, price: row.price, stock: row.stock, ...changes };
	}

	// Issue #284: inline edits and range pastes share ONE per-row save queue.
	// Saves for the same row run in order, and each request body is composed at
	// send time from the previous save's confirmed row + only that save's
	// changed columns - never from the stale `edit.row` snapshot, which used to
	// make an overlapping save revert the earlier one's column.
	let currentRowLookup: ((rowId: string | number) => Item | undefined) | undefined;
	const registerCurrentRow = (lookup: typeof currentRowLookup): void => {
		currentRowLookup = lookup;
	};
	const saveQueue = createRowSaveQueue<Item>({
		save: (rowId, values) => getDataProvider().update<Item>('items', rowId, values),
		compose: mergedValues,
		currentRow: (rowId) => currentRowLookup?.(rowId)
	});

	// M3 (spec §4.5): commit a single inline cell edit. A validation error
	// from the provider is re-thrown as a plain Error so BantoGrid re-enters
	// edit mode on that cell and shows the message inline; any other
	// provider error is unexpected, so it's also toasted before rethrowing.
	//
	// BantoGrid's onCellEdit contract only understands `Error.message` - a
	// cell can display exactly one message, no structured shape - so when the
	// provider returns several field_errors (mergedValues always sends the
	// full row, so an edit to one field can surface a violation on another),
	// we must pick just one. Priority: the entry for the field the user
	// actually edited wins if present (that's the one they can see and fix
	// inline); only fall back to the first entry when the edited field itself
	// has no violation (rare - e.g. some other field was already invalid).
	// This is a known limitation of the current onCellEdit contract, pending
	// a richer (multi-field) error shape in a later milestone.
	//
	// Return the saved row to the resource-owning grid. It publishes that
	// row before invalidating, so the next edit merges against confirmed
	// values even while the follow-up list request is still in flight (spec §4.5).
	async function handleCellEdit(edit: CellEdit<Item>): Promise<Item> {
		try {
			return await saveQueue.enqueue(edit.rowId, edit.row, { [edit.field]: edit.value });
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				const fieldError =
					err.body.field_errors.find((fe) => fe.field === edit.field) ?? err.body.field_errors[0];
				throw new Error(fieldError?.message ?? err.message, { cause: err });
			}
			notify('error', isProviderError(err) ? err.message : String(err));
			throw err;
		}
	}

	// M3 (spec §4.5): a pasted TSV range can touch several rows/columns at
	// once. Group by row so multi-column pastes on one row become a single
	// queued save with all of that row's edited fields merged.
	async function handleRangePaste(
		edits: CellEdit<Item>[],
		info: { skipped: number }
	): Promise<Item[]> {
		const byRow = new Map<string | number, { row: Item; changes: Record<string, unknown> }>();
		for (const edit of edits) {
			const entry = byRow.get(edit.rowId) ?? { row: edit.row, changes: {} };
			entry.changes[edit.field] = edit.value;
			byRow.set(edit.rowId, entry);
		}

		// Enqueue every row first (rows are independent lanes), then settle in
		// row order. A failed row only toasts; it never poisons later saves.
		const results = await Promise.allSettled(
			[...byRow].map(([rowId, entry]) => saveQueue.enqueue(rowId, entry.row, entry.changes))
		);
		const saved: Item[] = [];
		for (const result of results) {
			if (result.status === 'fulfilled') {
				saved.push(result.value);
			} else {
				const err = result.reason;
				notify('error', isProviderError(err) ? err.message : String(err));
			}
		}

		if (saved.length > 0) {
			notify('success', m['items.updatedCount']({ count: saved.length }));
		}
		if (info.skipped > 0) {
			notify('info', m['items.skippedCells']({ count: info.skipped }));
		}
		return saved;
	}

	// --- M15 Phase C: CSV export/import ------------------------------------

	/** CSV columns: every real `items` column except the synthetic 「開く」 link column (its accessor is `() => ''` - a blank, useless CSV cell/header). Shared by export (toCsv) and import (mapCsvHeader) so a round-tripped export re-imports cleanly. */
	const csvColumns = $derived(columns.filter((column) => column.id !== 'open'));

	/** Trigger a browser download of `content` named `filename` via a temporary Blob object URL - same pattern as `packages/charts/src/core/export.ts`'s `downloadSvg`. */
	function downloadTextFile(content: string, filename: string, mimeType: string): void {
		const blob = new Blob([content], { type: mimeType });
		const url = URL.createObjectURL(blob);
		try {
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	let exporting = $state(false);

	// Export always reflects whichever grid mode is currently on screen: the
	// server-mode grid's sort/filters are sent straight through to
	// getDataProvider().getList() (they ARE ListParams already); the
	// client-mode grid instead applies sort/filters itself inside BantoGrid,
	// so its GridState is read the same way and forwarded through the same
	// getList() call - the DataProvider (InMemory/Tauri/REST) reproduces
	// identical filtering to what BantoGrid shows client-side (spec §4.1/§4.2
	// keep both implementations in lockstep). One exception: filter out any
	// sort/filter entry whose field isn't a real `items` column - the client
	// grouping demo's synthetic 'category' column (ItemsClientGrid.svelte)
	// has no server-side equivalent, and forwarding it would silently match
	// zero rows instead of the rows actually shown.
	async function handleExport(): Promise<void> {
		exporting = true;
		try {
			const active = mode === 'client' ? clientGridState : serverGridState;
			const validFields = new Set(csvColumns.map((column) => column.id));
			const sort = active.sort.filter((entry) => validFields.has(entry.field));
			const filters = active.filters.filter((entry) => validFields.has(entry.field));

			const result = await getDataProvider().getList<Item>('items', {
				pagination: { offset: 0, limit: 20_000 },
				sort,
				filters
			});
			const csv = csvForExcel(toCsv(csvColumns, result.rows, { formulaSafe: true }));
			const filename = csvFilename('items');
			if (getBantoMode() === 'tauri') {
				// Desktop (finding⑤ Option A): WebView2 has no visible save
				// dialog for `<a download>`, so write into the app's
				// `exports/` folder and reveal it in Explorer instead - same
				// "no native save dialog in v1" fallback as
				// `openBackupsFolder`/backups' folder UX.
				const folderResult = await exportCsvToFolder(csv, filename);
				// Always show the saved path (the folder opens on success, but
				// the toast makes the location explicit so the file is never
				// "missing"). `opened: false` = non-Windows, where no folder opens.
				notify(
					'success',
					folderResult.opened
						? m['items.exportedToPath']({ count: result.rows.length, path: folderResult.path })
						: m['items.exportedToPathClosed']({
								count: result.rows.length,
								path: folderResult.path
							})
				);
			} else {
				downloadTextFile(csv, filename, 'text/csv;charset=utf-8');
				notify('success', m['items.exported']({ count: result.rows.length }));
			}
		} catch (err) {
			notify('error', isProviderError(err) ? err.message : String(err));
		} finally {
			exporting = false;
		}
	}

	interface ImportPreviewState {
		fileName: string;
		/** Header cells that matched no known column - shown as "無視される列". */
		ignoredHeaders: string[];
		/** Required columns (name/price/stock) missing from the header entirely - fatal, `rows` is left empty. */
		missingRequired: string[];
		rows: ImportRowPreview[];
		/** Populated after a submitted import comes back with row errors (all-or-nothing rollback, spec M15) - null before the first submit attempt. */
		serverErrors: { row: number; message: string }[] | null;
	}

	let importPreview: ImportPreviewState | null = $state(null);
	let importSubmitting = $state(false);
	let importFileInput: HTMLInputElement | undefined = $state();

	// Display-only classification of the current import preview into the
	// success/warning/danger status-panel tokens (design.md §Phase 4 CSV
	// result panel). Purely derived from state that already drives the
	// existing conditional markup below - no import/validation logic changes.
	const importStatusVariant = $derived.by((): StatusBadgeVariant => {
		if (!importPreview) return 'neutral';
		if (importPreview.missingRequired.length > 0) return 'danger';
		if (importPreview.serverErrors && importPreview.serverErrors.length > 0) return 'danger';
		if (importPreview.rows.some((row) => row.errors.length > 0)) return 'warning';
		return 'success';
	});

	const importStatusLabel = $derived.by((): string => {
		if (!importPreview) return '';
		if (importPreview.missingRequired.length > 0) return m['items.importMissingRequired']();
		if (importPreview.serverErrors && importPreview.serverErrors.length > 0)
			return m['items.importFailedShort']();
		if (importPreview.rows.some((row) => row.errors.length > 0))
			return m['items.importNeedsReview']();
		return m['items.importReady']();
	});

	const REQUIRED_IMPORT_COLUMN_IDS = ['name', 'price', 'stock'] as const;

	/** Column header label for an error's `columnId`, falling back to the raw id if unrecognized (e.g. a synthetic 'id' entry - see parseIdCell below). */
	function columnLabel(columnId: string): string {
		return columns.find((column) => column.id === columnId)?.header || columnId;
	}

	/**
	 * `convertCsvRow`'s per-cell errors come in two shapes: a parse failure
	 * already embeds `"${column.header}: "` (core/csv.ts), a `column.validate`
	 * failure does not. Normalize both to the same `"label: message"` shape
	 * for display, without doubling up the label when it's already there.
	 */
	function formatCsvError(columnId: string, message: string): string {
		const label = columnLabel(columnId);
		const prefix = `${label}: `;
		return message.startsWith(prefix) ? message : `${prefix}${message}`;
	}

	/**
	 * The `id` column isn't run through `convertCsvRow` (see buildImportPreview
	 * below) - its editor defaults to 'text' (baseColumns sets no `editor` on
	 * it), which would pass an empty cell through as `ok:false` under 'number'
	 * semantics or as a literal string under 'text' semantics, neither of
	 * which is "no id -> INSERT" (spec M15: "id あり→UPDATE / なし→INSERT").
	 * Parsed by hand instead: blank means "no id", anything else must be an
	 * integer.
	 */
	function parseIdCell(raw: string): { id?: number; error?: string } {
		const trimmed = raw.trim();
		if (trimmed === '') return {};
		const num = Number(trimmed);
		if (!Number.isFinite(num) || !Number.isInteger(num)) {
			return { error: m['items.importIdInvalid']() };
		}
		return { id: num };
	}

	/**
	 * Parse `text` (a selected CSV file's contents) into a preview the user
	 * confirms before anything is sent to the server. `id`/`updatedAt` are
	 * deliberately pulled out of the mapping passed to `convertCsvRow`: `id`
	 * needs its own optional-integer handling (parseIdCell, above) and
	 * `updatedAt` is a read-only column that must never be written back - both
	 * still count as recognized columns though (mapCsvHeader sees the FULL
	 * `csvColumns` set), so a header that names them is never misreported as
	 * an unrecognized/"無視される列" column.
	 */
	function buildImportPreview(fileName: string, text: string): ImportPreviewState | null {
		const parsed = parseCsv(text);
		if (parsed.length === 0) {
			notify('error', m['items.csvEmpty']());
			return null;
		}
		const [header, ...dataRows] = parsed;
		const { mapped, unknown } = mapCsvHeader<Item>(header, csvColumns);

		const missingRequired = REQUIRED_IMPORT_COLUMN_IDS.filter(
			(id) => !mapped.some((entry) => entry.column.id === id)
		);

		const idMapping = mapped.find((entry) => entry.column.id === 'id');
		const valueMapping = mapped.filter(
			(entry) => entry.column.id !== 'id' && entry.column.id !== 'updatedAt'
		);

		const rows: ImportRowPreview[] =
			missingRequired.length > 0
				? []
				: dataRows.map((cells, index) => {
						const csvLine = index + 2;
						const { values, errors } = convertCsvRow<Item>(cells, valueMapping);
						const rowErrors = errors.map((e) => ({ columnId: e.columnId, message: e.message }));

						let id: number | undefined;
						if (idMapping) {
							const idResult = parseIdCell(cells[idMapping.index] ?? '');
							if (idResult.error) rowErrors.push({ columnId: 'id', message: idResult.error });
							id = idResult.id;
						}

						return {
							csvLine,
							id,
							name: values.name,
							price: values.price,
							stock: values.stock,
							errors: rowErrors
						};
					});

		return { fileName, ignoredHeaders: unknown, missingRequired, rows, serverErrors: null };
	}

	function handleImportButtonClick(): void {
		if (!isItemsImportAvailable()) {
			notify('info', m['items.demoImportUnavailable']());
			return;
		}
		importFileInput?.click();
	}

	async function handleImportFileChange(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allow re-selecting the same file (e.g. after fixing it) later
		if (!file) return;
		const text = await file.text();
		importPreview = buildImportPreview(file.name, text);
	}

	function cancelImport(): void {
		importPreview = null;
	}

	// Guarded a second time here (not just via the button's `disabled`, spec
	// M15: 実行ボタンを無効化) - the server runs the whole batch
	// all-or-nothing, so sending it with known-bad rows would just get every
	// row rejected together.
	async function executeImport(): Promise<void> {
		if (!importPreview) return;
		if (importPreview.missingRequired.length > 0) return;
		if (importPreview.rows.some((row) => row.errors.length > 0)) return;

		// Same validated rows the preview table above renders (issue #218).
		const payload = toImportPayload(importPreview.rows);

		importSubmitting = true;
		try {
			const result = await importItems(payload);
			if (result.errors.length > 0) {
				// Rolled back server-side (all-or-nothing) - keep the preview open
				// so the user can see exactly what to fix and retry.
				importPreview = { ...importPreview, serverErrors: result.errors };
				notify('error', m['items.importFailedCount']({ count: result.errors.length }));
			} else {
				notify(
					'success',
					m['items.importSucceeded']({ created: result.created, updated: result.updated })
				);
				invalidate('items');
				importPreview = null;
			}
		} catch (err) {
			notify('error', isProviderError(err) ? err.message : String(err));
		} finally {
			importSubmitting = false;
		}
	}
</script>

<div class="page">
	<PageHeader hideTitle title={resource.label} description={m['items.description']()}>
		{#snippet actions()}
			<div class="mode-toggle" role="group" aria-label={m['items.modeToggleAria']()}>
				<button
					type="button"
					class="banto-btn banto-btn--ghost"
					class:active={mode === 'client'}
					aria-pressed={mode === 'client'}
					onclick={() => (mode = 'client')}
				>
					{m['items.modeClient']()}
				</button>
				<button
					type="button"
					class="banto-btn banto-btn--ghost"
					class:active={mode === 'server'}
					aria-pressed={mode === 'server'}
					onclick={() => (mode = 'server')}
				>
					{m['items.modeServer']()}
				</button>
			</div>
			<label class="group-by">
				{m['items.groupByLabel']()}
				<select
					class="banto-input"
					disabled={mode !== 'client'}
					title={mode !== 'client' ? m['items.groupByClientOnly']() : undefined}
					onchange={handleGroupByChange}
				>
					<option value="">{m['items.groupNone']()}</option>
					<option value="category">{m['items.groupCategory']()}</option>
					<option value="updatedAt">{m['items.fieldUpdatedAt']()}</option>
				</select>
			</label>
			<!-- Column manager (spec §4.4, issue #168): takes the SAME GridState
			     the active grid was handed, so hiding a column here immediately
			     drops it from that grid. Deliberately per-mode - クライアント and
			     サーバー own separate GridStates (and separate column sets), so
			     one shared menu would show the wrong list for whichever mode is
			     not active. -->
			<ColumnsMenu
				state={mode === 'client' ? clientGridState : serverGridState}
				messages={gridMessages()}
			/>

			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={handleExport}
				disabled={exporting}
			>
				<Download size={16} aria-hidden="true" />
				{exporting ? m['items.exporting']() : m['items.exportCsv']()}
			</button>
			{#if canWrite}
				<button
					type="button"
					class="banto-btn banto-btn--secondary"
					onclick={handleImportButtonClick}
				>
					<Upload size={16} aria-hidden="true" />
					{m['items.importCsv']()}
				</button>
				<input
					class="file-input"
					type="file"
					accept=".csv,.txt"
					aria-label={m['items.importCsv']()}
					bind:this={importFileInput}
					onchange={handleImportFileChange}
				/>
				<button
					type="button"
					class="banto-btn banto-btn--primary new-item-btn"
					onclick={() => goto(resolve(`items/new`))}
				>
					<Plus size={16} aria-hidden="true" />
					{m['items.create']()}
				</button>
			{/if}
		{/snippet}
	</PageHeader>

	<p class="note">{m['items.note']()}</p>

	<!-- Issue #215: the row just saved may no longer match the filter the
	     user still has active (restored from this session, above). Never
	     clear that filter for them - explain the mismatch instead, and let
	     them dismiss the notice once they've seen it. -->
	{#if filterExclusionNotice}
		<div class="filter-exclusion-notice" role="status">
			<span>{m['items.filterExcludedNotice']({ id: filterExclusionNotice.id })}</span>
			<button
				type="button"
				class="banto-btn banto-btn--ghost"
				onclick={() => (filterExclusionNotice = null)}
			>
				{m['common.close']()}
			</button>
		</div>
	{/if}

	{#if importPreview}
		<section class="import-panel import-panel--{importStatusVariant}">
			<header class="import-panel-header">
				<StatusBadge variant={importStatusVariant} label={importStatusLabel} />
				<h3>{importPreview.fileName}</h3>
			</header>
			{#if importPreview.missingRequired.length > 0}
				<p class="panel-text">
					{m['items.importMissingRequiredDetail']({
						columns: importPreview.missingRequired.map(columnLabel).join('、')
					})}
				</p>
			{:else}
				{@const errorRows = importPreview.rows.filter((row) => row.errors.length > 0)}
				{@const createCount = importPreview.rows.filter((row) => row.id === undefined).length}
				{@const updateCount = importPreview.rows.filter((row) => row.id !== undefined).length}
				<p class="panel-text summary">
					{m['items.importSummary']({
						create: createCount,
						update: updateCount,
						error: errorRows.length,
						total: importPreview.rows.length
					})}
				</p>
				{#if importPreview.ignoredHeaders.length > 0}
					<p class="panel-text muted">
						{m['items.importIgnored']({ columns: importPreview.ignoredHeaders.join('、') })}
					</p>
				{/if}
				{#if importPreview.rows.length > 0}
					{@const shown = previewRows(importPreview.rows)}
					<p class="panel-text muted">
						{m['items.importPreviewShown']({
							shown: shown.length,
							total: importPreview.rows.length
						})}
					</p>
					<div class="preview-table-wrap">
						<table class="preview-table">
							<caption class="sr-only">{m['items.importPreviewCaption']()}</caption>
							<thead>
								<tr>
									<th scope="col">{m['items.importPreviewLine']()}</th>
									<th scope="col">{m['items.importPreviewKind']()}</th>
									<th scope="col">ID</th>
									<th scope="col">{columnLabel('name')}</th>
									<th scope="col" class="num">{columnLabel('price')}</th>
									<th scope="col" class="num">{columnLabel('stock')}</th>
								</tr>
							</thead>
							<tbody>
								{#each shown as row (row.csvLine)}
									<tr class:has-error={row.errors.length > 0}>
										<td>{row.csvLine}</td>
										<td>
											<span class="kind kind--{importRowKind(row)}">
												{importRowKind(row) === 'update'
													? m['items.importKindUpdate']()
													: m['items.importKindCreate']()}
											</span>
										</td>
										<td>{row.id ?? '—'}</td>
										<td>{row.name ?? '—'}</td>
										<td class="num">{row.price ?? '—'}</td>
										<td class="num">{row.stock ?? '—'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if updateCount > 0}
						<p class="panel-text muted">{m['items.importUpdateNote']({ count: updateCount })}</p>
					{/if}
				{/if}
				{#if errorRows.length > 0}
					<ul class="error-list">
						{#each errorRows.slice(0, 20) as row (row.csvLine)}
							<li>
								{m['items.importErrorLine']({
									line: row.csvLine,
									message: row.errors.map((e) => formatCsvError(e.columnId, e.message)).join(' / ')
								})}
							</li>
						{/each}
					</ul>
					{#if errorRows.length > 20}
						<p class="panel-text muted">
							{m['items.importMore']({ count: errorRows.length - 20 })}
						</p>
					{/if}
				{/if}
				{#if importPreview.serverErrors}
					<p class="panel-text">{m['items.importServerRollback']()}</p>
					<ul class="error-list">
						{#each importPreview.serverErrors.slice(0, 20) as serverError, i (i)}
							<li>
								{m['items.importErrorLine']({
									line: importPreview.rows[serverError.row]?.csvLine ?? serverError.row + 2,
									message: serverError.message
								})}
							</li>
						{/each}
					</ul>
					{#if importPreview.serverErrors.length > 20}
						<p class="panel-text muted">
							{m['items.importMore']({ count: importPreview.serverErrors.length - 20 })}
						</p>
					{/if}
				{/if}
			{/if}
			<div class="actions">
				<button
					type="button"
					class="banto-btn banto-btn--primary"
					onclick={executeImport}
					disabled={importSubmitting ||
						importPreview.missingRequired.length > 0 ||
						importPreview.rows.some((row) => row.errors.length > 0)}
				>
					{importSubmitting ? m['items.importRunning']() : m['items.importRun']()}
				</button>
				<button
					type="button"
					class="banto-btn banto-btn--ghost"
					onclick={cancelImport}
					disabled={importSubmitting}
				>
					{m['common.cancel']()}
				</button>
			</div>
		</section>
	{/if}

	{#if mode === 'client'}
		<ItemsClientGrid
			columns={clientColumns}
			state={clientGridState}
			onRowClick={handleRowClick}
			onCellEdit={handleCellEdit}
			onRangePaste={handleRangePaste}
			rowClass={clientRowClass}
			{registerCurrentRow}
		/>
	{:else}
		<ItemsServerGrid
			{columns}
			state={serverGridState}
			onRowClick={handleRowClick}
			onCellEdit={handleCellEdit}
			onRangePaste={handleRangePaste}
			rowClass={serverRowClass}
			{registerCurrentRow}
		/>
	{/if}
</div>

<style>
	.page {
		height: calc(100vh - var(--banto-shell-header-height) - 2.5rem);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	/* Priority-ordered toolbar (design.md §Phase 4): view-mode/group-by stay
	   ghost, export/import are secondary, 新規作成 is the sole primary
	   action. DOM order is left as it always was (existing convention
	   preserved per the implementation brief); only 新規作成 is pulled to
	   the front once the toolbar wraps under 768px, below. */
	.mode-toggle {
		display: inline-flex;
		border: 1px solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		overflow: hidden;
	}

	.mode-toggle .banto-btn {
		height: var(--banto-control-height-sm);
		padding: 0 0.75rem;
		border-radius: 0;
		font-size: 0.8rem;
	}

	.mode-toggle .banto-btn.active {
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
	}

	.group-by {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
		color: var(--banto-text-muted);
	}

	.group-by select {
		height: var(--banto-control-height-sm);
		font-size: 0.8rem;
	}

	.group-by select:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* 768px 前後で折り返した際、主要操作（新規作成）を先頭に維持する
	   (design.md §Phase 4)。 */
	@media (max-width: 48rem) {
		.new-item-btn {
			order: -1;
		}
	}

	.note {
		flex: 0 0 auto;
		margin: 0 0 0.75rem;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	/* Issue #215: same info-tint idiom as the import panel's success/warning/
	   danger variants below, but neutral - this isn't an error, just context
	   the user should know about before it's dismissed. */
	.filter-exclusion-notice {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--banto-primary);
		border-radius: var(--banto-radius-sm);
		background: color-mix(in srgb, var(--banto-primary) 8%, transparent);
		font-size: 0.85rem;
	}

	/* Issue #215: highlights whichever row this mode's grid was last
	   opened/saved from (`rowClass` -> BantoGrid's `.row` element,
	   packages/grid-svelte/src/BantoGrid.svelte) - same left-accent idiom and
	   `:global()` requirement as audit-log's `.audit-row-selected`
	   (apps/admin-template/src/routes/(app)/audit-log/+page.svelte). */
	:global(.row.items-row-last-opened) {
		background: color-mix(in srgb, var(--banto-primary) 10%, transparent);
		border-left: 3px solid var(--banto-primary);
	}

	/* Visually hidden but still focusable/clickable via the CSVインポート
	   button's importFileInput?.click() - same "real file input, no fake
	   input" approach as a plain native file picker, just not shown itself. */
	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* CSV import result panel (design.md §Phase 4): success/warning/danger
	   distinguishable via the tint token pairs, StatusBadge carries the
	   variant icon so the state never depends on color alone. */
	.import-panel {
		flex: 0 0 auto;
		margin: 0 0 0.75rem;
		padding: 0.85rem 1rem;
		border-radius: var(--banto-radius-lg);
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
	}

	.import-panel--success {
		background: var(--banto-success-tint);
		border-color: transparent;
	}

	.import-panel--warning {
		background: var(--banto-warning-tint);
		border-color: transparent;
	}

	.import-panel--danger {
		background: var(--banto-danger-tint);
		border-color: transparent;
	}

	.import-panel-header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0 0 0.5rem;
	}

	.import-panel-header h3 {
		margin: 0;
		font-size: 0.9rem;
		color: var(--banto-text-muted);
	}

	.panel-text {
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
	}

	.panel-text.summary {
		font-weight: 600;
	}

	.panel-text.muted {
		color: var(--banto-text-muted);
	}

	.import-panel--success .panel-text {
		color: var(--banto-success-tint-text);
	}

	.import-panel--warning .panel-text {
		color: var(--banto-warning-tint-text);
	}

	.import-panel--danger .panel-text {
		color: var(--banto-danger-tint-text);
	}

	.error-list {
		margin: 0 0 0.5rem;
		padding-left: 1.25rem;
		max-height: 220px;
		overflow-y: auto;
		font-size: 0.8rem;
		color: var(--banto-text);
	}

	.error-list li {
		margin-bottom: 0.25rem;
	}

	.preview-table-wrap {
		margin: 0 0 0.5rem;
		overflow-x: auto;
	}

	.preview-table {
		border-collapse: collapse;
		font-size: 0.8rem;
		color: var(--banto-text);
		background: var(--banto-surface);
	}

	.preview-table th,
	.preview-table td {
		padding: 0.25rem 0.6rem;
		border-bottom: 1px solid var(--banto-border);
		text-align: left;
		white-space: nowrap;
	}

	.preview-table .num {
		text-align: right;
	}

	.preview-table tr.has-error td {
		background: var(--banto-danger-tint);
	}

	/* 新規/更新は文字ラベル + 枠線の形（更新は破線）で区別し、色だけに依存しない。 */
	.kind {
		display: inline-block;
		padding: 0 0.4rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		font-weight: 600;
	}

	.kind--update {
		border-style: dashed;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.import-panel .actions {
		display: flex;
		gap: 0.75rem;
	}
</style>
