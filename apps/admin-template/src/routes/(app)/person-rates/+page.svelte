<script lang="ts">
	/**
	 * 管理設定 → 個人別単価 (design 10.9, T43, 2026-11-14): each person's
	 * hourly cost rate for every project and for single projects, on a chosen
	 * date, with the history and a form that adds a new row
	 * (PersonRateForm.svelte).
	 *
	 * A time entry is costed at approval with, in order: the person's rate for
	 * the project, the person's rate, the project's override, the company
	 * standard (計算基準). Approved entries keep the rate they were costed with.
	 * Reading and changing need `finance.rate` + `amount.view`; the server
	 * decides and a `forbidden` read shows the no-access state. No rate is
	 * 未設定, never 0. Demo mode has no backend.
	 */
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';
	import { isProviderError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import {
		getPersonRates,
		type PersonRateRow,
		type PersonRates
	} from '#lib/banto/personRatesAdmin.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { formatCalcValue, isForbiddenError, todayIso } from '#lib/banto/costFormat.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import PersonRateForm from '#lib/components/PersonRateForm.svelte';

	const UNIT = 'yen_per_hour';
	const available = isPipelineAvailable();
	const canWrite = $derived(canWriteResources(sessionStore.role));

	let on = $state(todayIso());
	let rates = $state<PersonRates | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	const forbidden = $derived(isForbiddenError(loadError));
	/** The scope choices come with the rates (every project, `ViewRates`), not
	 *  from the membership-scoped project list (PR #64 review). */
	const projects = $derived(
		(rates?.projects ?? []).map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))
	);
	/** The person whose history (and, when `editing`, change form) is open. */
	let selectedId = $state<number | null>(null);
	let editing = $state(false);
	let formPending = $state({ dirty: false, busy: false });
	const guard = guardUnsavedChanges({
		isDirty: () => editing && formPending.dirty,
		isSaving: () => formPending.busy
	});

	const selected = $derived(rates?.people.find((p) => p.userId === selectedId) ?? null);

	const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
	const onValid = $derived(DATE_RE.test(on));

	async function load() {
		if (!available || !DATE_RE.test(on)) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const result = await getPersonRates(on);
			if (token !== loadToken) return;
			rates = result;
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			rates = null;
		}
	}

	$effect(() => {
		void on;
		void load();
	});

	function open(userId: number, edit: boolean) {
		if (editing && formPending.busy) return;
		if (editing && formPending.dirty && !window.confirm(m['calcBasis.discardConfirm']())) return;
		selectedId = userId;
		editing = edit;
		formPending = { dirty: false, busy: false };
	}

	function rateLabel(row: PersonRateRow): string {
		return row.value === null ? m['personRates.ended']() : formatCalcValue(row.value, UNIT);
	}
</script>

<div class="page">
	<PageHeader
		hideTitle
		title={m['nav.personRates']()}
		description={m['personRates.description']()}
	/>

	{#if available && !forbidden}
		<div class="toolbar">
			<label class="field">
				<span>{m['calcBasis.fieldOn']()}</span>
				<input class="banto-input" type="date" bind:value={on} aria-invalid={!onValid} />
			</label>
			<p class="note" class:error={!onValid}>
				{onValid ? m['calcBasis.onNote']() : m['calcBasis.errorDate']()}
			</p>
		</div>
		<p class="note">{m['personRates.orderNote']()}</p>
	{/if}

	{#if !available}
		<EmptyState title={m['personRates.demoUnavailable']()} />
	{:else if forbidden}
		<EmptyState title={m['cost.forbiddenTitle']()} description={m['cost.forbiddenDesc']()} />
	{:else if loadError}
		<ErrorState
			title={m['cost.loadError']()}
			description={isProviderError(loadError) ? loadError.message : String(loadError)}
		>
			{#snippet action()}
				<button type="button" class="banto-btn banto-btn--secondary" onclick={() => void load()}>
					{m['common.reload']()}
				</button>
			{/snippet}
		</ErrorState>
	{:else if !rates}
		<LoadingState label={m['common.loading']()} />
	{:else}
		<section class="panel">
			<div class="table-wrap">
				<table>
					<caption class="sr-only">{m['nav.personRates']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['personRates.colPerson']()}</th>
							<th scope="col" class="num">{m['personRates.colRate']()}</th>
							<th scope="col">{m['calcBasis.colVersion']()}</th>
							<th scope="col">{m['calcBasis.colScheduled']()}</th>
							<th scope="col">{m['personRates.colProjects']()}</th>
							<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
						</tr>
					</thead>
					<tbody>
						{#each rates.people as person (person.userId)}
							<tr class:selected={person.userId === selectedId}>
								<td>{person.displayName}</td>
								<td class="num" class:unset={!person.current}>
									{person.current
										? formatCalcValue(person.current.value, UNIT)
										: m['personRates.none']()}
								</td>
								<td>
									{#if person.current}
										<div>{m['calcBasis.versionNo']({ no: person.current.versionNo })}</div>
										<div class="sub">
											{m['calcBasis.validFromLabel']({ date: person.current.validFrom })}
										</div>
									{/if}
								</td>
								<td>
									{#each person.scheduled as next (next.id)}
										<div>
											{rateLabel(next)}
											<span class="sub"
												>{m['calcBasis.validFromLabel']({ date: next.validFrom })}</span
											>
										</div>
									{/each}
								</td>
								<td>
									{#each person.projects as project (project.projectId)}
										<div>
											<span>{project.projectCode}</span>
											<span class:unset={!project.current}>
												{project.current
													? formatCalcValue(project.current.value, UNIT)
													: m['personRates.none']()}
											</span>
											{#each project.scheduled as next (next.id)}
												<span class="sub"
													>{rateLabel(next)}
													{m['calcBasis.validFromLabel']({ date: next.validFrom })}</span
												>
											{/each}
										</div>
									{/each}
								</td>
								<td>
									<div class="row-actions">
										<button
											type="button"
											class="banto-btn banto-btn--ghost"
											onclick={() => open(person.userId, false)}
										>
											{m['calcBasis.showHistory']()}
										</button>
										{#if canWrite}
											<button
												type="button"
												class="banto-btn banto-btn--secondary"
												onclick={() => open(person.userId, true)}
											>
												{m['calcBasis.change']()}
											</button>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		{#if selected}
			<section class="panel" aria-labelledby="person-rate-history-heading">
				<h2 id="person-rate-history-heading">
					{m['personRates.historyTitle']({ name: selected.displayName })}
				</h2>
				{#if selected.history.length === 0}
					<p class="note">{m['personRates.noHistory']()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th scope="col">{m['personRates.fieldScope']()}</th>
									<th scope="col">{m['calcBasis.colVersion']()}</th>
									<th scope="col">{m['calcBasis.fieldValidFrom']()}</th>
									<th scope="col" class="num">{m['personRates.colRateShort']()}</th>
									<th scope="col">{m['calcBasis.fieldReason']()}</th>
									<th scope="col">{m['calcBasis.colCreated']()}</th>
								</tr>
							</thead>
							<tbody>
								{#each selected.history as entry (entry.id)}
									<tr>
										<td>
											{entry.projectId === null
												? m['personRates.scopeAll']()
												: `${entry.projectCode ?? ''} ${entry.projectName ?? ''}`}
										</td>
										<td>{m['calcBasis.versionNo']({ no: entry.versionNo })}</td>
										<td>{entry.validFrom}</td>
										<td class="num">{rateLabel(entry)}</td>
										<td class="wrap">{entry.reason}</td>
										<td>
											<div>{entry.createdByName ?? m['cost.unset']()}</div>
											<div class="sub">{entry.createdAt}</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
				{#if editing && canWrite}
					{#key selected.userId}
						<PersonRateForm
							userId={selected.userId}
							displayName={selected.displayName}
							{projects}
							onSaved={() => {
								editing = false;
								formPending = { dirty: false, busy: false };
								void load();
							}}
							onCancel={() => {
								editing = false;
								formPending = { dirty: false, busy: false };
							}}
							onPendingChange={(pending) => (formPending = pending)}
						/>
					{/key}
				{/if}
			</section>
		{/if}
		<p class="sr-only" aria-live="polite">{guard.pending ? m['unsaved.notice']() : ''}</p>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
		max-width: 1200px;
	}

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

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--banto-space-3);
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

	.note.error {
		color: var(--banto-danger);
	}

	.note,
	.sub {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
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

	td.wrap {
		white-space: normal;
		min-width: 12rem;
	}

	tr.selected td {
		background: var(--banto-surface-subtle);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.unset {
		color: var(--banto-text-muted);
	}

	.row-actions {
		display: flex;
		gap: var(--banto-space-1);
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
