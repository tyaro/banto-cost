<script lang="ts" generics="TRow">
	/**
	 * Test-only host (cellEditors.test.ts): provides cell editors through the
	 * context the way an app layout does (`provideCellEditors`,
	 * date-time-pickers §5.8), then renders a `BantoGrid` below it.
	 */
	import BantoGrid from '../src/BantoGrid.svelte';
	import { provideCellEditors, type CellEditors } from '../src/cellEditors';
	import type { CellEdit, GridColumn } from '../src/types';

	interface Props {
		provided?: CellEditors;
		cellEditors?: CellEditors;
		rows: TRow[];
		columns: GridColumn<TRow>[];
		getRowId: (row: TRow) => string | number;
		onCellEdit?: (edit: CellEdit<TRow>) => void | Promise<void>;
		onRowClick?: (row: TRow) => void;
		onRangePaste?: (edits: CellEdit<TRow>[], info: { skipped: number }) => void;
	}

	let {
		provided,
		cellEditors,
		rows,
		columns,
		getRowId,
		onCellEdit,
		onRowClick,
		onRangePaste
	}: Props = $props();

	// svelte-ignore state_referenced_locally
	provideCellEditors(provided ?? {});
</script>

<BantoGrid {rows} {columns} {getRowId} {onCellEdit} {onRowClick} {onRangePaste} {cellEditors} />
<button type="button">Outside</button>
