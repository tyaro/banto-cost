<script lang="ts">
	/**
	 * 単価の当て直し (design 10.9, T45, 2026-11-14): approved time entries
	 * whose saved rate differs from the rate that applies now - typically
	 * hours approved before the person's rate was decided (原価未確定). The
	 * caller picks entries and gives one reason; each picked entry is rerated
	 * with the same per-entry operation (runEach), which records an approved
	 * correction of it with the new rate and cost (the original stays as
	 * history, P6b-2). A refused entry does not stop the rest.
	 *
	 * Entries in a closed month (reopen it first), of a settled project or
	 * with a correction waiting are listed with the reason and cannot be
	 * picked. Entries still without any rate are only counted. The server
	 * decides (`finance.rate` + `amount.view` + `finance.close`); a forbidden
	 * read shows a note instead of the list.
	 */
	import { isProviderError, notify } from '@banto/admin-core';
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import { failureReason, runEach } from '#lib/banto/bulk.js';
	import {
		formatCalcValue,
		formatSignedYen,
		formatYen,
		isForbiddenError
	} from '#lib/banto/costFormat.js';
	import { formatMinutes } from '#lib/banto/timeFormat.js';
	import {
		listRerates,
		rerateEntry,
		type RerateCandidate,
		type RerateList
	} from '#lib/banto/timeAdmin.js';

	interface Props {
		/** Bumped by the page after a rate is saved, to read the list again. */
		reloadKey: number;
		canWrite: boolean;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { reloadKey, canWrite, onPendingChange }: Props = $props();

	const UNIT = 'yen_per_hour';
	let list = $state<RerateList | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	let picked = $state<number[]>([]);
	let reason = $state('');
	let reasonError = $state('');
	let busy = $state(false);

	$effect(() => {
		onPendingChange?.({ dirty: reason.trim() !== '' || picked.length > 0, busy });
	});

	const forbidden = $derived(isForbiddenError(loadError));
	const candidates = $derived(list?.candidates ?? []);
	const pickable = $derived(candidates.filter((c) => c.blocked === null));
	const chosen = $derived(candidates.filter((c) => picked.includes(c.entry.id)));
	const allPicked = $derived(pickable.length > 0 && chosen.length === pickable.length);
	const chosenDiff = $derived(chosen.reduce((sum, c) => sum + diffOf(c), 0));

	async function load() {
		const token = ++loadToken;
		loadError = null;
		try {
			const result = await listRerates();
			if (token !== loadToken) return;
			list = result;
			// Keep only picks that are still pickable.
			const ids = new Set(
				result.candidates.filter((c) => c.blocked === null).map((c) => c.entry.id)
			);
			picked = picked.filter((id) => ids.has(id));
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			list = null;
		}
	}

	$effect(() => {
		void reloadKey;
		untrack(() => void load());
	});

	function diffOf(c: RerateCandidate): number {
		return c.newCost - (c.entry.laborCost ?? 0);
	}

	function target(c: RerateCandidate): string {
		const e = c.entry;
		return e.projectCode !== null
			? `${e.projectCode} ${e.projectName ?? ''}`.trim()
			: (e.activityName ?? '');
	}

	function sourceLabel(source: RerateCandidate['source']): string {
		switch (source) {
			case 'personProject':
				return m['rerate.sourcePersonProject']();
			case 'person':
				return m['rerate.sourcePerson']();
			case 'projectOverride':
				return m['rerate.sourceProjectOverride']();
			default:
				return m['rerate.sourceCompany']();
		}
	}

	function blockedLabel(blocked: RerateCandidate['blocked']): string {
		switch (blocked) {
			case 'closed_month':
				return m['rerate.blockedClosedMonth']();
			case 'settled':
				return m['rerate.blockedSettled']();
			case 'correction_pending':
				return m['rerate.blockedPending']();
			default:
				return '';
		}
	}

	function toggle(id: number, on: boolean) {
		picked = on ? [...picked.filter((p) => p !== id), id] : picked.filter((p) => p !== id);
	}

	function toggleAll(on: boolean) {
		picked = on ? pickable.map((c) => c.entry.id) : [];
	}

	async function rerateChosen() {
		if (busy || chosen.length === 0) return;
		if (reason.trim() === '') {
			reasonError = m['rerate.errorReason']();
			return;
		}
		reasonError = '';
		// Rerate the rows the dialog counted, not a list reloaded while it was open.
		const rows = chosen;
		const why = reason.trim();
		const ok = await confirmAction({
			title: m['rerate.confirmTitle'](),
			body: m['rerate.confirmBody']({ count: rows.length }),
			details: [
				{ label: m['confirm.count'](), value: m['confirm.countValue']({ count: rows.length }) },
				{ label: m['rerate.colDiff'](), value: formatSignedYen(chosenDiff) },
				{ label: m['confirm.reason'](), value: why }
			],
			undo: m['rerate.confirmUndo'](),
			confirmLabel: m['rerate.run']({ count: rows.length })
		});
		if (!ok || busy) return;
		busy = true;
		try {
			const result = await runEach(rows, (c) =>
				rerateEntry(c.entry.id, { rowVersion: c.entry.rowVersion, reason: why })
			);
			if (result.done > 0) notify('success', m['rerate.done']({ count: result.done }));
			if (result.failed > 0) {
				const failure = failureReason(result.firstError, m['rerate.forbidden']());
				notify('error', m['rerate.failed']({ count: result.failed, reason: failure }));
			}
			if (result.failed === 0) reason = '';
			picked = [];
		} finally {
			busy = false;
			void load();
		}
	}
</script>

<section class="panel" aria-labelledby="rerate-heading">
	<h2 id="rerate-heading">{m['rerate.title']()}</h2>
	<p class="note">{m['rerate.description']()}</p>

	{#if forbidden}
		<p class="note">{m['rerate.forbiddenNote']()}</p>
	{:else if loadError}
		<p class="note error" role="alert">
			{m['cost.loadError']()}:
			{isProviderError(loadError) ? loadError.message : String(loadError)}
		</p>
		<div>
			<button type="button" class="banto-btn banto-btn--secondary" onclick={() => void load()}>
				{m['common.reload']()}
			</button>
		</div>
	{:else if !list}
		<p class="note">{m['common.loading']()}</p>
	{:else}
		{#if list.noRate > 0}
			<p class="note">{m['rerate.noRate']({ count: list.noRate })}</p>
		{/if}
		{#if candidates.length === 0}
			<p class="note">{m['rerate.empty']()}</p>
		{:else}
			<div class="table-wrap">
				<table>
					<caption class="sr-only">{m['rerate.title']()}</caption>
					<thead>
						<tr>
							<th scope="col">
								<input
									type="checkbox"
									aria-label={m['rerate.pickAll']()}
									checked={allPicked}
									disabled={!canWrite || busy || pickable.length === 0}
									onchange={(e) => toggleAll(e.currentTarget.checked)}
								/>
							</th>
							<th scope="col">{m['approvals.colPerson']()}</th>
							<th scope="col">{m['time.colDate']()}</th>
							<th scope="col">{m['time.colTarget']()}</th>
							<th scope="col" class="num">{m['time.colMinutes']()}</th>
							<th scope="col" class="num">{m['rerate.colSavedRate']()}</th>
							<th scope="col" class="num">{m['rerate.colNewRate']()}</th>
							<th scope="col" class="num">{m['rerate.colSavedCost']()}</th>
							<th scope="col" class="num">{m['rerate.colNewCost']()}</th>
							<th scope="col" class="num">{m['rerate.colDiff']()}</th>
							<th scope="col">{m['rerate.colState']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each candidates as c (c.entry.id)}
							<tr class:blocked={c.blocked !== null}>
								<td>
									<input
										type="checkbox"
										aria-label={m['rerate.pickOne']({
											name: c.entry.userName,
											date: c.entry.workDate
										})}
										checked={picked.includes(c.entry.id)}
										disabled={!canWrite || busy || c.blocked !== null}
										onchange={(e) => toggle(c.entry.id, e.currentTarget.checked)}
									/>
								</td>
								<td>{c.entry.userName}</td>
								<td>{c.entry.workDate}</td>
								<td>{target(c)}</td>
								<td class="num">{formatMinutes(c.entry.minutes)}</td>
								<td class="num" class:unset={c.entry.appliedRate === null}>
									{c.entry.appliedRate === null
										? m['rerate.noSavedRate']()
										: formatCalcValue(c.entry.appliedRate, UNIT)}
								</td>
								<td class="num">
									<div>{formatCalcValue(c.newRate, UNIT)}</div>
									<div class="sub">{sourceLabel(c.source)}</div>
								</td>
								<td class="num" class:unset={c.entry.laborCost === null}>
									{c.entry.laborCost === null
										? m['rerate.noSavedRate']()
										: formatYen(c.entry.laborCost)}
								</td>
								<td class="num">{formatYen(c.newCost)}</td>
								<td class="num">{formatSignedYen(diffOf(c))}</td>
								<td>{c.blocked === null ? m['rerate.ready']() : blockedLabel(c.blocked)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if canWrite}
				<div class="actions">
					<label class="field">
						<span>{m['rerate.fieldReason']()}</span>
						<input
							class="banto-input"
							type="text"
							bind:value={reason}
							disabled={busy}
							aria-invalid={reasonError !== ''}
							aria-describedby={reasonError ? 'rerate-reason-error' : undefined}
						/>
					</label>
					<button
						type="button"
						class="banto-btn banto-btn--primary"
						disabled={busy || chosen.length === 0}
						onclick={() => void rerateChosen()}
					>
						{m['rerate.run']({ count: chosen.length })}
					</button>
				</div>
				{#if reasonError}
					<p id="rerate-reason-error" class="note error">{reasonError}</p>
				{/if}
				<p class="note">{m['rerate.runNote']()}</p>
			{/if}
		{/if}
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

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-lg);
	}

	.note,
	.sub {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.note.error {
		color: var(--banto-danger);
	}

	.table-wrap {
		overflow-x: auto;
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
		vertical-align: top;
		white-space: nowrap;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	tr.blocked td {
		color: var(--banto-text-muted);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.unset {
		color: var(--banto-text-muted);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--banto-space-3);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		flex: 1 1 20rem;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.field input {
		color: var(--banto-text);
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
