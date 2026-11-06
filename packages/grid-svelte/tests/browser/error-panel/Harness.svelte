<script lang="ts">
	import { BantoGrid, type CellEdit, type GridColumn, type GridMessages } from '../../../src/index';
	import type { ErrorFixtureSettings } from './settings';

	let { settings }: { settings: ErrorFixtureSettings } = $props();
	type Row = { id: number; name: string; spacer: string; notes: string };
	let rows = $state<Row[]>(
		Array.from({ length: 30 }, (_, i) => ({
			id: i + 1,
			name: `Name ${i + 1}`,
			spacer: 'Read only',
			notes: `Notes ${i + 1}`
		}))
	);
	// The fixture intentionally captures settings once, like a consumer's message bundle.
	// svelte-ignore state_referenced_locally
	const columns: GridColumn<Row>[] = [
		{ id: 'id', header: 'ID', accessor: 'id', width: 60 },
		{
			id: 'name',
			header: 'Name',
			accessor: 'name',
			editable: true,
			width: 140,
			validate: (value) => (value === 'invalid' ? settings.error : null)
		},
		{ id: 'spacer', header: 'Read only', accessor: 'spacer', width: 200 },
		{
			id: 'notes',
			header: settings.header,
			accessor: 'notes',
			editable: true,
			width: 120,
			validate: (value) => (value === 'invalid' ? settings.error : null)
		}
	];
	const messages: Partial<GridMessages> = {
		inlineEditErrorLabel: (header) => settings.errorLabel.replace('{header}', header),
		inlineEditErrorHint: () => settings.errorHint
	};
	let behavior = $state('success');
	let calls = $state(0);
	let finish: (() => void) | undefined;
	let fail: (() => void) | undefined;
	async function save(edit: CellEdit<Row>) {
		calls += 1;
		if (behavior === 'reject') throw new Error(settings.error);
		if (behavior === 'defer')
			await new Promise<void>((resolve, reject) => {
				finish = resolve;
				fail = () => reject(new Error(settings.error));
			});
		rows = rows.map((row) => (row.id === edit.rowId ? { ...row, [edit.field]: edit.value } : row));
	}
</script>

<main>
	<h1>Grid error fixture</h1>
	<label
		>Save behavior <select bind:value={behavior}
			><option value="success">Success</option><option value="reject">Reject</option><option
				value="defer">Defer</option
			></select
		></label
	>
	<output aria-label="Save calls">{calls}</output>
	<button id="resolve-save" onclick={() => finish?.()}>Resolve save</button>
	<button id="reject-save" onclick={() => fail?.()}>Reject save</button>
	<button onclick={() => (rows = rows.filter((row) => row.id !== 30))}>Remove last row</button>
	<section aria-label="First grid">
		<h2>First grid</h2>
		<div class="frame">
			<BantoGrid
				{rows}
				{columns}
				{messages}
				mode={settings.mode}
				totalRows={rows.length}
				getRowId={(row) => row.id}
				onCellEdit={save}
			/>
		</div>
	</section>
	<button>After first grid</button>
	<section aria-label="Second grid">
		<h2>Second grid</h2>
		<div class="frame">
			<BantoGrid
				{rows}
				{columns}
				{messages}
				mode={settings.mode}
				totalRows={rows.length}
				getRowId={(row) => row.id}
				onCellEdit={save}
			/>
		</div>
	</section>
	<button>After second grid</button>
</main>

<style>
	main {
		padding: 1rem;
	}
	.frame {
		height: 200px;
		width: 100%;
		max-width: 760px;
	}
	button,
	select,
	output {
		margin: 0.25rem;
	}
</style>
