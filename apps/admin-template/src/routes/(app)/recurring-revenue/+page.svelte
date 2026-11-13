<script lang="ts">
	/**
	 * 定期売上 (design §9.4 items 2 and 6, banto-cost P7c, T38). A monthly
	 * contract is one project with one agreement (monthly amount, start and
	 * end month). Saving the agreement regenerates the project's open revenue
	 * plan month by month (monthly × months must equal the confirmed order);
	 * recognizing a month books, for every due agreement, a revenue
	 * recognition on the month's last day that clears the month's plan.
	 * Cancelling a recognition stays in the project's order section.
	 *
	 * The server decides everything (ManageRecurringRevenue: finance.close +
	 * amount.view; closed months and settled projects refuse); this page only
	 * shows the state.
	 */
	import PeriodHint from '#lib/components/PeriodHint.svelte';
	import { getDataProvider, isProviderError, notify } from '@banto/admin-core';
	import { resolve } from '$app/paths';
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import {
		getRecurringMonth,
		listRecurringAgreements,
		monthsBetween,
		recognizeRecurringMonth,
		saveRecurringAgreement,
		type RecurringAgreement,
		type RecurringAgreementInput,
		type RecurringLineState,
		type RecurringMonth
	} from '#lib/banto/recurringRevenueAdmin.js';
	import { currentMonth } from '#lib/banto/fixedCostsAdmin.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import type { Project } from '#lib/banto/resources/projects.js';
	import { formatYen, isForbiddenError, todayIso } from '#lib/banto/costFormat.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';

	const available = isPipelineAvailable();
	const canWrite = $derived(canWriteResources(sessionStore.role));
	/** The ordered side a monthly contract can be on (受注・進行中・作業完了). */
	const ORDERED_OPEN = ['ordered', 'in_progress', 'work_done'];

	interface Option {
		value: number;
		label: string;
	}

	let agreements = $state<RecurringAgreement[]>([]);
	let loadError = $state<unknown>(null);
	let loaded = $state(false);
	let projects = $state<Option[]>([]);

	let month = $state(currentMonth(todayIso()));
	let view = $state<RecurringMonth | null>(null);
	let busy = $state(false);

	const blank = (): RecurringAgreementInput => ({
		projectId: null,
		monthlyAmount: null,
		fromMonth: currentMonth(todayIso()),
		toMonth: '',
		description: null
	});
	let editingId = $state<number | null>(null);
	let form = $state<RecurringAgreementInput>(blank());
	let formOpen = $state(false);
	let fieldErrors = $state<Record<string, string>>({});

	const forbidden = $derived(isForbiddenError(loadError));
	const formMonths = $derived(monthsBetween(form.fromMonth, form.toMonth));

	async function loadPickers() {
		try {
			const result = await getDataProvider().getList<Project>('projects', {
				sort: [{ field: 'code', direction: 'asc' }],
				filters: [],
				pagination: { offset: 0, limit: 5_000 }
			});
			projects = result.rows
				.filter((p) => ORDERED_OPEN.includes(p.status))
				.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }));
		} catch {
			projects = [];
		}
	}

	async function load() {
		if (!available) return;
		loadError = null;
		try {
			const [list, monthView] = await Promise.all([
				listRecurringAgreements(),
				getRecurringMonth(month)
			]);
			agreements = list;
			view = monthView;
			loaded = true;
		} catch (err) {
			loadError = err;
		}
	}

	void load();
	void loadPickers();

	async function showMonth() {
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
			notify('error', m['closing.invalidMonth']());
			return;
		}
		try {
			view = await getRecurringMonth(month);
		} catch (err) {
			reportError(err);
		}
	}

	function reportError(err: unknown) {
		if (isProviderError(err) && err.body.kind === 'validation') {
			notify('error', err.body.field_errors.map((e) => e.message).join(' / '));
		} else notify('error', isProviderError(err) ? err.message : String(err));
	}

	function openNew() {
		editingId = null;
		form = blank();
		fieldErrors = {};
		formOpen = true;
	}

	function openEdit(a: RecurringAgreement) {
		editingId = a.id;
		form = {
			projectId: a.projectId,
			monthlyAmount: a.monthlyAmount,
			fromMonth: a.fromMonth,
			toMonth: a.toMonth,
			description: a.description,
			rowVersion: a.rowVersion
		};
		fieldErrors = {};
		formOpen = true;
	}

	async function save() {
		if (busy) return;
		busy = true;
		fieldErrors = {};
		const values: RecurringAgreementInput = {
			...form,
			description: form.description?.trim() ? form.description.trim() : null
		};
		try {
			await saveRecurringAgreement(editingId, values);
			notify('success', m['recurring.saved']());
			formOpen = false;
			await load();
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				fieldErrors = Object.fromEntries(err.body.field_errors.map((e) => [e.field, e.message]));
			}
			reportError(err);
		} finally {
			busy = false;
		}
	}

	async function recognize() {
		if (!view || busy) return;
		// Recognize the month the dialog showed, not one loaded while it was open.
		const { month: shownMonth, dueCount, recognizedOn } = view;
		const ok = await confirmAction({
			title: m['recurring.recognizeConfirmTitle'](),
			body: m['recurring.recognizeConfirm']({
				month: shownMonth,
				count: dueCount,
				date: recognizedOn
			}),
			details: [
				{ label: m['confirm.month'](), value: shownMonth },
				{ label: m['confirm.count'](), value: m['confirm.countValue']({ count: dueCount }) },
				{ label: m['recurring.recognizedOn'](), value: recognizedOn }
			],
			undo: m['recurring.recognizeUndo'](),
			confirmLabel: m['recurring.recognize']({ count: dueCount })
		});
		if (!ok || busy || view?.month !== shownMonth) return;
		busy = true;
		try {
			// Items added elsewhere while the dialog was open are not recognized
			// unconfirmed: read the month again and ask again if it changed.
			const fresh = await getRecurringMonth(shownMonth);
			if (fresh.dueCount !== dueCount || fresh.recognizedOn !== recognizedOn) {
				view = fresh;
				notify('error', m['confirm.changed']());
				return;
			}
			const result = await recognizeRecurringMonth(shownMonth);
			view = result.view;
			notify('success', m['recurring.recognized']({ month: view.month, count: result.recognized }));
			if (result.failures.length > 0) {
				notify(
					'error',
					m['recurring.failed']({
						list: result.failures.map((f) => `${f.projectCode}: ${f.message}`).join(' / ')
					})
				);
			}
			agreements = await listRecurringAgreements().catch(() => agreements);
		} catch (err) {
			reportError(err);
		} finally {
			busy = false;
		}
	}

	function stateLabel(s: RecurringLineState): string {
		if (s === 'due') return m['recurring.stateDue']();
		if (s === 'recognized') return m['recurring.stateRecognized']();
		if (s === 'no_plan') return m['recurring.stateNoPlan']();
		return m['recurring.stateProjectClosed']();
	}

	function numberOrNull(v: string): number | null {
		const n = Number(v);
		return v.trim() === '' || !Number.isFinite(n) ? null : n;
	}
</script>

<div class="page">
	<PageHeader
		hideTitle
		title={m['nav.recurringRevenue']()}
		description={m['recurring.description']()}
	>
		{#snippet actions()}
			{#if available}
				<button type="button" class="banto-btn banto-btn--secondary" onclick={() => void load()}>
					{m['common.reload']()}
				</button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if !available}
		<EmptyState
			title={m['pipeline.demoUnavailableTitle']()}
			description={m['pipeline.demoUnavailable']()}
		/>
	{:else if forbidden}
		<EmptyState title={m['cost.forbiddenTitle']()} description={m['recurring.forbidden']()} />
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
	{:else if !loaded}
		<LoadingState label={m['common.loading']()} />
	{:else}
		<section class="panel" data-testid="recurring-month">
			<h2>{m['recurring.monthTitle']()}</h2>
			<form
				class="filters"
				onsubmit={(event) => {
					event.preventDefault();
					void showMonth();
				}}
			>
				<label class="field">
					<span>{m['closing.month']()}<PeriodHint {month} /></span>
					<input class="banto-input" type="month" placeholder="YYYY-MM" bind:value={month} />
				</label>
				<button type="submit" class="banto-btn banto-btn--secondary">{m['closing.show']()}</button>
				{#if canWrite && view}
					<button
						type="button"
						class="banto-btn banto-btn--primary"
						disabled={busy || view.closed || view.dueCount === 0}
						onclick={() => void recognize()}
					>
						{m['recurring.recognize']({ count: view.dueCount })}
					</button>
				{/if}
			</form>
			{#if view}
				{#if view.closed}
					<p class="note">{m['recurring.closedNote']({ month: view.month })}</p>
				{/if}
				<p class="note">
					{m['recurring.monthSummary']({
						month: view.month,
						date: view.recognizedOn,
						due: view.dueCount,
						total: formatYen(view.dueTotal)
					})}
				</p>
				{#if view.lines.length === 0}
					<p class="note">{m['recurring.noLines']()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th scope="col">{m['recurring.colProject']()}</th>
									<th scope="col" class="num">{m['recurring.colAmount']()}</th>
									<th scope="col" class="num">{m['recurring.colMonthPlan']()}</th>
									<th scope="col">{m['recurring.colState']()}</th>
								</tr>
							</thead>
							<tbody>
								{#each view.lines as line (line.agreement.id)}
									<tr>
										<td>
											<a href={resolve(`projects/${line.agreement.projectId}`)}
												>{line.agreement.projectCode}</a
											>
											{line.agreement.projectName}
										</td>
										<td class="num">{formatYen(line.agreement.monthlyAmount)}</td>
										<td class="num">{formatYen(line.planned)}</td>
										<td data-state={line.state}>{stateLabel(line.state)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
				<p class="note">{m['recurring.cancelNote']()}</p>
			{/if}
		</section>

		<section class="panel" data-testid="recurring-agreements">
			<h2>
				{m['recurring.agreementsTitle']()}
				{#if canWrite}
					<button type="button" class="banto-btn banto-btn--secondary" onclick={openNew}>
						{m['recurring.new']()}
					</button>
				{/if}
			</h2>
			<p class="note">{m['recurring.agreementsNote']()}</p>

			{#if formOpen}
				<form
					class="agreement-form"
					onsubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<label class="field">
						<span>{m['recurring.colProject']()}</span>
						{#if editingId === null && projects.length > 0}
							<select class="banto-input" bind:value={form.projectId}>
								<option value={null}>—</option>
								{#each projects as p (p.value)}
									<option value={p.value}>{p.label}</option>
								{/each}
							</select>
						{:else}
							<input
								class="banto-input"
								type="number"
								min="1"
								disabled={editingId !== null}
								value={form.projectId ?? ''}
								oninput={(e) => (form.projectId = numberOrNull(e.currentTarget.value))}
							/>
						{/if}
						{#if fieldErrors.projectId}<small class="error">{fieldErrors.projectId}</small>{/if}
					</label>
					<label class="field">
						<span>{m['recurring.colAmount']()}</span>
						<input
							class="banto-input"
							type="number"
							min="1"
							step="1"
							value={form.monthlyAmount ?? ''}
							oninput={(e) => (form.monthlyAmount = numberOrNull(e.currentTarget.value))}
						/>
						{#if fieldErrors.monthlyAmount}<small class="error">{fieldErrors.monthlyAmount}</small
							>{/if}
					</label>
					<label class="field">
						<span>{m['recurring.fromMonth']()}<PeriodHint month={form.fromMonth} /></span>
						<input class="banto-input" type="month" bind:value={form.fromMonth} />
						{#if fieldErrors.fromMonth}<small class="error">{fieldErrors.fromMonth}</small>{/if}
					</label>
					<label class="field">
						<span>{m['recurring.toMonth']()}<PeriodHint month={form.toMonth} /></span>
						<input class="banto-input" type="month" bind:value={form.toMonth} />
						{#if fieldErrors.toMonth}<small class="error">{fieldErrors.toMonth}</small>{/if}
					</label>
					<label class="field grow">
						<span>{m['recurring.descriptionLabel']()}</span>
						<input
							class="banto-input"
							type="text"
							maxlength="1000"
							value={form.description ?? ''}
							oninput={(e) => (form.description = e.currentTarget.value)}
						/>
					</label>
					<div class="actions">
						<button type="submit" class="banto-btn banto-btn--primary" disabled={busy}>
							{m['common.save']()}
						</button>
						<button
							type="button"
							class="banto-btn banto-btn--secondary"
							onclick={() => (formOpen = false)}
						>
							{m['common.cancel']()}
						</button>
					</div>
					{#if formMonths !== null && form.monthlyAmount !== null && form.monthlyAmount > 0}
						<p class="note preview">
							{m['recurring.preview']({
								months: formMonths,
								amount: formatYen(form.monthlyAmount),
								total: formatYen(form.monthlyAmount * formMonths)
							})}
						</p>
					{/if}
					{#if editingId !== null}
						<p class="note">{m['recurring.editNote']()}</p>
					{/if}
				</form>
			{/if}

			{#if agreements.length === 0}
				<p class="note">{m['recurring.noAgreements']()}</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">{m['recurring.colProject']()}</th>
								<th scope="col" class="num">{m['recurring.colAmount']()}</th>
								<th scope="col">{m['recurring.colTerm']()}</th>
								<th scope="col" class="num">{m['recurring.colTotal']()}</th>
								<th scope="col" class="num">{m['recurring.colRecognized']()}</th>
								<th scope="col"></th>
							</tr>
						</thead>
						<tbody>
							{#each agreements as a (a.id)}
								<tr>
									<td>
										<a href={resolve(`projects/${a.projectId}`)}>{a.projectCode}</a>
										{a.projectName}
									</td>
									<td class="num">{formatYen(a.monthlyAmount)}</td>
									<td>
										{m['recurring.termLabel']({
											from: a.fromMonth,
											to: a.toMonth,
											months: a.months
										})}
									</td>
									<td class="num">{formatYen(a.contractTotal)}</td>
									<td class="num">{formatYen(a.recognizedTotal)}</td>
									<td>
										{#if canWrite}
											<button type="button" class="link" onclick={() => openEdit(a)}>
												{m['recurring.edit']()}
											</button>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: var(--banto-space-4);
	}

	.filters,
	.agreement-form {
		display: flex;
		flex-direction: row;
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

	.field input,
	.field select {
		color: var(--banto-text);
	}

	.grow {
		flex: 1 1 16rem;
	}

	.actions {
		display: flex;
		gap: var(--banto-space-2);
	}

	.preview {
		flex-basis: 100%;
	}

	.error {
		color: var(--banto-danger, var(--banto-text));
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-md);
		display: flex;
		gap: var(--banto-space-2);
		align-items: center;
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--banto-accent, inherit);
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
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
		white-space: nowrap;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	td[data-state='due'] {
		font-weight: 600;
	}

	td[data-state='project_closed'],
	td[data-state='no_plan'] {
		color: var(--banto-text-muted);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
