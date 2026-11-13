<script lang="ts">
	/**
	 * 月額固定原価 (design §9.4 items 3 and 5, banto-cost P7b, T37). One
	 * person's fixed monthly amount - an employee (labor) or a vendor
	 * (outsourcing) - is booked every month to the monthly-contract project
	 * the person serves. This page registers and changes the contracts, posts
	 * a month (each due contract once, booked on the month's last day) and
	 * cancels a posting with a reason.
	 *
	 * The server decides everything (ManageFixedCosts: finance.rate +
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
		cancelFixedCostPosting,
		currentMonth,
		getFixedCostMonth,
		listFixedCostContracts,
		postFixedCostMonth,
		saveFixedCostContract,
		termLabel,
		type FixedCostContract,
		type FixedCostContractInput,
		type FixedCostMonth,
		type LineState,
		type PayeeKind
	} from '#lib/banto/fixedCostsAdmin.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { listMasters, type WorkMaster } from '#lib/banto/timeAdmin.js';
	import { listUserNames, userNameOptions } from '#lib/banto/userNames.js';
	import type { Project } from '#lib/banto/resources/projects.js';
	import { formatYen, isForbiddenError, todayIso } from '#lib/banto/costFormat.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';

	const available = isPipelineAvailable();
	const canWrite = $derived(canWriteResources(sessionStore.role));

	interface Option {
		value: number;
		label: string;
	}

	let contracts = $state<FixedCostContract[]>([]);
	let loadError = $state<unknown>(null);
	let loaded = $state(false);
	let projects = $state<Option[]>([]);
	let vendors = $state<Option[]>([]);
	let users = $state<Option[] | null>(null);

	let month = $state(currentMonth(todayIso()));
	let view = $state<FixedCostMonth | null>(null);
	let busy = $state(false);

	const blank = (): FixedCostContractInput => ({
		projectId: null,
		payeeKind: 'vendor',
		userId: null,
		vendorId: null,
		monthlyAmount: null,
		fromMonth: currentMonth(todayIso()),
		toMonth: null,
		description: null
	});
	let editingId = $state<number | null>(null);
	let form = $state<FixedCostContractInput>(blank());
	let formOpen = $state(false);
	let fieldErrors = $state<Record<string, string>>({});

	const forbidden = $derived(isForbiddenError(loadError));

	async function loadPickers() {
		try {
			const result = await getDataProvider().getList<Project>('projects', {
				sort: [{ field: 'code', direction: 'asc' }],
				filters: [],
				pagination: { offset: 0, limit: 5_000 }
			});
			projects = result.rows.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }));
		} catch {
			projects = [];
		}
		try {
			const rows: WorkMaster[] = await listMasters('vendors');
			vendors = rows.filter((v) => v.active).map((v) => ({ value: v.id, label: v.name }));
		} catch {
			vendors = [];
		}
		try {
			const names = await listUserNames();
			users = names.length > 0 ? userNameOptions(names) : null;
		} catch {
			users = null;
		}
	}

	async function load() {
		if (!available) return;
		loadError = null;
		try {
			const [list, monthView] = await Promise.all([
				listFixedCostContracts(),
				getFixedCostMonth(month)
			]);
			contracts = list;
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
			view = await getFixedCostMonth(month);
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

	function openEdit(c: FixedCostContract) {
		editingId = c.id;
		form = {
			projectId: c.projectId,
			payeeKind: c.payeeKind,
			userId: c.userId,
			vendorId: c.vendorId,
			monthlyAmount: c.monthlyAmount,
			fromMonth: c.fromMonth,
			toMonth: c.toMonth,
			description: c.description,
			rowVersion: c.rowVersion
		};
		fieldErrors = {};
		formOpen = true;
	}

	async function save() {
		if (busy) return;
		busy = true;
		fieldErrors = {};
		const values: FixedCostContractInput = {
			...form,
			userId: form.payeeKind === 'employee' ? form.userId : null,
			vendorId: form.payeeKind === 'vendor' ? form.vendorId : null,
			toMonth: form.toMonth ? form.toMonth : null,
			description: form.description?.trim() ? form.description.trim() : null
		};
		try {
			await saveFixedCostContract(editingId, values);
			notify('success', m['fixedCosts.saved']());
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

	async function post() {
		if (!view || busy) return;
		// Post the month the dialog showed, not one loaded while it was open.
		const { month: shownMonth, dueCount } = view;
		const ok = await confirmAction({
			title: m['fixedCosts.postConfirmTitle'](),
			body: m['fixedCosts.postConfirm']({ month: shownMonth, count: dueCount }),
			details: [
				{ label: m['confirm.month'](), value: shownMonth },
				{ label: m['confirm.count'](), value: m['confirm.countValue']({ count: dueCount }) }
			],
			undo: m['fixedCosts.postUndo'](),
			confirmLabel: m['fixedCosts.post']({ count: dueCount })
		});
		if (!ok || busy || view?.month !== shownMonth) return;
		busy = true;
		try {
			const result = await postFixedCostMonth(shownMonth);
			view = result.view;
			notify('success', m['fixedCosts.posted']({ month: view.month, count: result.posted }));
			contracts = await listFixedCostContracts().catch(() => contracts);
		} catch (err) {
			reportError(err);
		} finally {
			busy = false;
		}
	}

	async function cancel(postingId: number) {
		if (busy) return;
		const reason = window.prompt(m['fixedCosts.cancelPrompt']());
		if (reason === null) return;
		if (reason.trim() === '') {
			notify('error', m['fixedCosts.cancelReasonRequired']());
			return;
		}
		busy = true;
		try {
			view = await cancelFixedCostPosting(postingId, reason.trim());
			notify('success', m['fixedCosts.cancelled']());
			contracts = await listFixedCostContracts().catch(() => contracts);
		} catch (err) {
			reportError(err);
		} finally {
			busy = false;
		}
	}

	function payeeKindLabel(kind: PayeeKind): string {
		return kind === 'employee' ? m['fixedCosts.payeeEmployee']() : m['fixedCosts.payeeVendor']();
	}

	function costTypeLabel(t: string): string {
		return t === 'labor' ? m['fixedCosts.typeLabor']() : m['fixedCosts.typeOutsource']();
	}

	function stateLabel(s: LineState): string {
		if (s === 'posted') return m['fixedCosts.statePosted']();
		if (s === 'due') return m['fixedCosts.stateDue']();
		return m['fixedCosts.stateProjectClosed']();
	}

	function numberOrNull(v: string): number | null {
		const n = Number(v);
		return v.trim() === '' || !Number.isFinite(n) ? null : n;
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.fixedCosts']()} description={m['fixedCosts.description']()}>
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
		<EmptyState title={m['cost.forbiddenTitle']()} description={m['fixedCosts.forbidden']()} />
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
		<section class="panel" data-testid="fixed-cost-month">
			<h2>{m['fixedCosts.monthTitle']()}</h2>
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
						onclick={() => void post()}
					>
						{m['fixedCosts.post']({ count: view.dueCount })}
					</button>
				{/if}
			</form>
			{#if view}
				{#if view.closed}
					<p class="note">{m['fixedCosts.closedNote']({ month: view.month })}</p>
				{/if}
				<p class="note">
					{m['fixedCosts.monthSummary']({
						month: view.month,
						total: formatYen(view.postedTotal),
						due: view.dueCount
					})}
				</p>
				{#if view.lines.length === 0}
					<p class="note">{m['fixedCosts.noLines']()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th scope="col">{m['fixedCosts.colProject']()}</th>
									<th scope="col">{m['fixedCosts.colPayee']()}</th>
									<th scope="col">{m['fixedCosts.colType']()}</th>
									<th scope="col" class="num">{m['fixedCosts.colAmount']()}</th>
									<th scope="col">{m['fixedCosts.colState']()}</th>
									<th scope="col"></th>
								</tr>
							</thead>
							<tbody>
								{#each view.lines as line (line.contract.id)}
									<tr>
										<td>
											<a href={resolve(`projects/${line.contract.projectId}`)}
												>{line.contract.projectCode}</a
											>
											{line.contract.projectName}
										</td>
										<td>{line.contract.payeeName ?? '—'}</td>
										<td>{costTypeLabel(line.contract.costType)}</td>
										<td class="num">
											{formatYen(line.posting?.amount ?? line.contract.monthlyAmount)}
										</td>
										<td data-state={line.state}>{stateLabel(line.state)}</td>
										<td>
											{#if canWrite && line.posting && !view.closed}
												<button
													type="button"
													class="link"
													disabled={busy}
													onclick={() => line.posting && void cancel(line.posting.id)}
												>
													{m['fixedCosts.cancel']()}
												</button>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
				{#if view.cancelled.length > 0}
					<h3>{m['fixedCosts.cancelledTitle']()}</h3>
					<ul class="history">
						{#each view.cancelled as c (c.id)}
							<li>
								{formatYen(c.amount)} · {c.cancelledAt ?? ''} · {c.cancelReason ?? ''}
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</section>

		<section class="panel" data-testid="fixed-cost-contracts">
			<h2>
				{m['fixedCosts.contractsTitle']()}
				{#if canWrite}
					<button type="button" class="banto-btn banto-btn--secondary" onclick={openNew}>
						{m['fixedCosts.new']()}
					</button>
				{/if}
			</h2>
			<p class="note">{m['fixedCosts.contractsNote']()}</p>

			{#if formOpen}
				<form
					class="contract-form"
					onsubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<label class="field">
						<span>{m['fixedCosts.colProject']()}</span>
						{#if projects.length > 0}
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
								value={form.projectId ?? ''}
								oninput={(e) => (form.projectId = numberOrNull(e.currentTarget.value))}
							/>
						{/if}
						{#if fieldErrors.projectId}<small class="error">{fieldErrors.projectId}</small>{/if}
					</label>
					<label class="field">
						<span>{m['fixedCosts.payeeKind']()}</span>
						<select class="banto-input" bind:value={form.payeeKind}>
							<option value="vendor">{payeeKindLabel('vendor')}</option>
							<option value="employee">{payeeKindLabel('employee')}</option>
						</select>
						{#if fieldErrors.payeeKind}<small class="error">{fieldErrors.payeeKind}</small>{/if}
					</label>
					{#if form.payeeKind === 'vendor'}
						<label class="field">
							<span>{m['fixedCosts.vendor']()}</span>
							<select class="banto-input" bind:value={form.vendorId}>
								<option value={null}>—</option>
								{#each vendors as v (v.value)}
									<option value={v.value}>{v.label}</option>
								{/each}
							</select>
							{#if fieldErrors.vendorId}<small class="error">{fieldErrors.vendorId}</small>{/if}
						</label>
					{:else}
						<label class="field">
							<span>{m['fixedCosts.employee']()}</span>
							{#if users}
								<select class="banto-input" bind:value={form.userId}>
									<option value={null}>—</option>
									{#each users as u (u.value)}
										<option value={u.value}>{u.label}</option>
									{/each}
								</select>
							{:else}
								<input
									class="banto-input"
									type="number"
									min="1"
									placeholder={m['fixedCosts.userIdPlaceholder']()}
									value={form.userId ?? ''}
									oninput={(e) => (form.userId = numberOrNull(e.currentTarget.value))}
								/>
							{/if}
							{#if fieldErrors.userId}<small class="error">{fieldErrors.userId}</small>{/if}
						</label>
					{/if}
					<label class="field">
						<span>{m['fixedCosts.colAmount']()}</span>
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
						<span>{m['fixedCosts.fromMonth']()}<PeriodHint month={form.fromMonth} /></span>
						<input class="banto-input" type="month" bind:value={form.fromMonth} />
						{#if fieldErrors.fromMonth}<small class="error">{fieldErrors.fromMonth}</small>{/if}
					</label>
					<label class="field">
						<span>{m['fixedCosts.toMonth']()}<PeriodHint month={form.toMonth} /></span>
						<input
							class="banto-input"
							type="month"
							value={form.toMonth ?? ''}
							oninput={(e) => (form.toMonth = e.currentTarget.value || null)}
						/>
						{#if fieldErrors.toMonth}<small class="error">{fieldErrors.toMonth}</small>{/if}
					</label>
					<label class="field grow">
						<span>{m['fixedCosts.descriptionLabel']()}</span>
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
					{#if editingId !== null}
						<p class="note">{m['fixedCosts.editNote']()}</p>
					{/if}
				</form>
			{/if}

			{#if contracts.length === 0}
				<p class="note">{m['fixedCosts.noContracts']()}</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">{m['fixedCosts.colProject']()}</th>
								<th scope="col">{m['fixedCosts.colPayee']()}</th>
								<th scope="col">{m['fixedCosts.colType']()}</th>
								<th scope="col" class="num">{m['fixedCosts.colAmount']()}</th>
								<th scope="col">{m['fixedCosts.colTerm']()}</th>
								<th scope="col">{m['fixedCosts.colPosted']()}</th>
								<th scope="col"></th>
							</tr>
						</thead>
						<tbody>
							{#each contracts as c (c.id)}
								<tr>
									<td>
										<a href={resolve(`projects/${c.projectId}`)}>{c.projectCode}</a>
										{c.projectName}
									</td>
									<td>{c.payeeName ?? '—'}</td>
									<td>{costTypeLabel(c.costType)}</td>
									<td class="num">{formatYen(c.monthlyAmount)}</td>
									<td>{termLabel(c)}</td>
									<td>
										{m['fixedCosts.postedSummary']({
											count: c.postedCount,
											last: c.lastPostedMonth ?? '—'
										})}
									</td>
									<td>
										{#if canWrite}
											<button type="button" class="link" onclick={() => openEdit(c)}>
												{m['fixedCosts.edit']()}
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
	.contract-form {
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

	h3 {
		margin: var(--banto-space-2) 0 0;
		font-size: var(--banto-font-size-sm);
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.history {
		margin: 0;
		padding-left: 1.25rem;
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

	td[data-state='project_closed'] {
		color: var(--banto-text-muted);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
