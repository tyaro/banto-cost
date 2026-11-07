<script lang="ts">
	/**
	 * One master of 工程・共通活動 (spec §5.2, banto-cost P4b): its rows with
	 * name, display order and in-use state, an inline editor per row and an
	 * add form. Rows are never deleted - one that is no longer used is made
	 * inactive and stays on the entries that used it (spec §10). A stale
	 * `rowVersion` (someone saved first) comes back as an error to reload.
	 */
	import { isProviderError, notify } from '@banto/admin-core';
	import { LoadingState, StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { isForbiddenError } from '#lib/banto/costFormat.js';
	import {
		listMasters,
		saveMaster,
		type MasterKind,
		type WorkMaster
	} from '#lib/banto/timeAdmin.js';

	interface Props {
		kind: MasterKind;
		title: string;
		canWrite: boolean;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { kind, title, canWrite, onPendingChange }: Props = $props();

	let rows = $state<WorkMaster[] | null>(null);
	let loadError = $state<unknown>(null);
	/** `null` = adding a row; a number = editing that row; `undefined` = no editor. */
	let editing = $state<number | null | undefined>(undefined);
	let name = $state('');
	let sortOrder = $state('0');
	let active = $state(true);
	let error = $state('');
	let busy = $state(false);
	let initial = '';
	const snapshot = () => JSON.stringify([name, sortOrder, active]);

	$effect(() => {
		onPendingChange?.({ dirty: editing !== undefined && snapshot() !== initial, busy });
	});

	async function load() {
		loadError = null;
		try {
			rows = await listMasters(kind);
		} catch (err) {
			loadError = err;
			rows = null;
		}
	}

	$effect(() => {
		void load();
	});

	function open(row: WorkMaster | null) {
		if (busy) return;
		if (editing !== undefined && snapshot() !== initial) {
			if (!window.confirm(m['workMasters.discardConfirm']())) return;
		}
		editing = row ? row.id : null;
		name = row?.name ?? '';
		const nextOrder = (rows ?? []).reduce((max, r) => Math.max(max, r.sortOrder), 0) + 10;
		sortOrder = String(row?.sortOrder ?? nextOrder);
		active = row?.active ?? true;
		error = '';
		initial = snapshot();
	}

	async function save() {
		if (busy || editing === undefined) return;
		const order = Number(sortOrder);
		if (name.trim() === '') {
			error = m['workMasters.errorName']();
			return;
		}
		if (!Number.isInteger(order)) {
			error = m['workMasters.errorOrder']();
			return;
		}
		const row = editing === null ? null : (rows ?? []).find((r) => r.id === editing);
		busy = true;
		try {
			await saveMaster(kind, editing, {
				name: name.trim(),
				sortOrder: order,
				active,
				rowVersion: row?.rowVersion
			});
			notify('success', m['workMasters.saved']());
			editing = undefined;
			void load();
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				error = err.body.field_errors.map((e) => e.message).join(' / ');
			} else if (isForbiddenError(err)) {
				error = m['workMasters.forbidden']();
			} else {
				error = isProviderError(err) ? err.message : String(err);
			}
		} finally {
			busy = false;
		}
	}
</script>

{#snippet editor()}
	<form
		class="editor"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<label class="field grow">
			<span>{m['workMasters.fieldName']()}</span>
			<input class="banto-input" bind:value={name} aria-invalid={error !== ''} />
		</label>
		<label class="field">
			<span>{m['workMasters.fieldOrder']()}</span>
			<input class="banto-input order" type="number" step="1" bind:value={sortOrder} />
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={active} />
			{m['workMasters.fieldActive']()}
		</label>
		<button type="submit" class="banto-btn banto-btn--primary" disabled={busy}>
			{m['common.save']()}
		</button>
		<button
			type="button"
			class="banto-btn banto-btn--ghost"
			disabled={busy}
			onclick={() => (editing = undefined)}
		>
			{m['common.cancel']()}
		</button>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
	</form>
{/snippet}

<section class="panel" aria-labelledby={`master-${kind}`}>
	<div class="head">
		<h2 id={`master-${kind}`}>{title}</h2>
		{#if canWrite && rows}
			<button type="button" class="banto-btn banto-btn--secondary" onclick={() => open(null)}>
				{m['workMasters.add']()}
			</button>
		{/if}
	</div>

	{#if isForbiddenError(loadError)}
		<p class="note">{m['cost.forbiddenDesc']()}</p>
	{:else if loadError}
		<p class="error" role="alert">
			{isProviderError(loadError) ? loadError.message : String(loadError)}
		</p>
	{:else if !rows}
		<LoadingState label={m['common.loading']()} />
	{:else}
		{#if editing === null}{@render editor()}{/if}
		<table>
			<caption class="sr-only">{title}</caption>
			<thead>
				<tr>
					<th scope="col" class="num">{m['workMasters.fieldOrder']()}</th>
					<th scope="col">{m['workMasters.fieldName']()}</th>
					<th scope="col">{m['workMasters.colState']()}</th>
					<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.id)}
					<tr class:inactive={!row.active}>
						<td class="num">{row.sortOrder}</td>
						<td>{row.name}</td>
						<td>
							<StatusBadge
								variant={row.active ? 'success' : 'neutral'}
								label={row.active ? m['workMasters.active']() : m['workMasters.inactive']()}
							/>
						</td>
						<td>
							{#if canWrite}
								<button type="button" class="banto-btn banto-btn--ghost" onclick={() => open(row)}
									>{m['workMasters.edit']()}</button
								>
							{/if}
						</td>
					</tr>
					{#if editing === row.id}
						<tr class="edit-row">
							<td colspan="4">{@render editor()}</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: min(var(--banto-space-5), 3%);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--banto-space-2);
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-lg);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--banto-font-size-sm);
	}

	th,
	td {
		padding: var(--banto-space-2);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		text-align: left;
		vertical-align: middle;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		width: 4rem;
	}

	tr.inactive td {
		color: var(--banto-text-muted);
	}

	.edit-row td {
		background: var(--banto-surface-subtle);
	}

	.editor {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--banto-space-2);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.field input {
		color: var(--banto-text);
	}

	.field.grow {
		flex: 1 1 12rem;
	}

	.order {
		width: 6rem;
	}

	.check {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
		flex-basis: 100%;
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
</style>
