<script lang="ts">
	/**
	 * 直接費入力 (spec §6.3 / §6.4 / §9, banto-cost P4d): the caller's own
	 * material, outsourcing, travel and other costs of a month, by their
	 * booked date (管理計上日). A record is a draft until submitted; the
	 * project's manager or accounting approves it (/approvals). Only approved
	 * records are actuals.
	 *
	 * A reduction is never a negative amount: an approved record gets a
	 * return / cancel / discount record, and an approved provisional (仮計上)
	 * gets the invoice that replaces it (請求確定, T14). A cost shared by
	 * several projects is split over them (T10). Orders are registered in 案件
	 * 詳細 → 直接費. The server decides every entry (the project scope, the
	 * order's remainder). Demo mode has no backend.
	 *
	 * When the server marks a record `canApprove` (the owner may approve it
	 * too - single-handed use), 申請して承認 submits it and approves it at
	 * once, one record or every draft of the month (review U-2, as on 工数入力):
	 * the same two operations in a row, each authorized and audited as usual
	 * (the approval as selfApproval).
	 */
	import { monthWithPeriod } from '#lib/banto/businessCalendar.svelte.js';
	import { getDataProvider, isProviderError, notify } from '@banto/admin-core';
	import { PageHeader, EmptyState, ErrorState, LoadingState, StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import { failureReason, runEach } from '#lib/banto/bulk.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { formatSignedYen, isForbiddenError, todayIso } from '#lib/banto/costFormat.js';
	import type { Project } from '#lib/banto/resources/projects.js';
	import {
		decideCost,
		deleteCost,
		listOwnCosts,
		submitCost,
		type DirectCost,
		type DirectCostSaved
	} from '#lib/banto/costsAdmin.js';
	import { listMasters, type WorkMaster } from '#lib/banto/timeAdmin.js';
	import { timeStatusLabel, timeStatusVariant } from '#lib/banto/timeFormat.js';
	import { costTypeLabel } from '#lib/banto/budgetFormat.js';
	import { kindLabel, monthRange, shiftMonth, signedAmount } from '#lib/banto/costsFormat.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import CostEntryForm from '#lib/components/CostEntryForm.svelte';

	const available = isPipelineAvailable();
	const canWrite = $derived(canWriteResources(sessionStore.role));

	let month = $state(todayIso().slice(0, 7));
	let costs = $state<DirectCost[] | null>(null);
	let loadedFor = $state<string | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;

	let phases = $state<WorkMaster[]>([]);
	let vendors = $state<WorkMaster[]>([]);
	let projects = $state<{ id: number; label: string }[]>([]);

	/** `undefined` = no form; otherwise what the form edits or refers to. */
	let form = $state<
		| {
				cost: DirectCost | null;
				target: DirectCost | null;
				mode: 'cost' | 'confirms' | 'adjustment';
		  }
		| undefined
	>(undefined);
	let formKey = $state(0);
	let formPending = $state({ dirty: false, busy: false });
	let acting = $state(false);
	const guard = guardUnsavedChanges({
		isDirty: () => form !== undefined && formPending.dirty,
		isSaving: () => formPending.busy || acting
	});

	async function load() {
		if (!available) return;
		const token = ++loadToken;
		const target = month;
		loadError = null;
		try {
			const { from, to } = monthRange(target);
			const rows = await listOwnCosts(from, to);
			if (token !== loadToken) return;
			costs = rows;
			loadedFor = target;
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			costs = null;
		}
	}

	async function loadChoices() {
		if (!available) return;
		try {
			[phases, vendors] = await Promise.all([listMasters('phases'), listMasters('vendors')]);
		} catch {
			// The list reports access problems; the form just has no choices.
		}
		try {
			const result = await getDataProvider().getList<Project>('projects', {
				sort: [{ field: 'code', direction: 'asc' }],
				filters: [],
				pagination: { offset: 0, limit: 5_000 }
			});
			projects = result.rows
				.filter((p) => p.status !== 'settled')
				.map((p) => ({ id: p.id, label: `${p.code} ${p.name}` }));
		} catch {
			projects = [];
		}
	}

	$effect(() => {
		void month;
		void load();
	});
	$effect(() => {
		void loadChoices();
	});

	function confirmDiscard(): boolean {
		return (
			!(form !== undefined && formPending.dirty) || window.confirm(m['costs.discardConfirm']())
		);
	}

	function open(next: NonNullable<typeof form>) {
		if (!confirmDiscard()) return;
		form = next;
		formKey += 1;
	}

	function changeMonth(delta: number) {
		month = shiftMonth(month, delta);
	}

	function saved(result: DirectCostSaved) {
		notify('success', result.replayed ? m['costs.replayed']() : m['costs.saved']());
		form = undefined;
		void load();
	}

	function fail(err: unknown) {
		if (isForbiddenError(err)) notify('error', m['costs.forbiddenEntry']());
		else if (isProviderError(err) && err.body.kind === 'validation') {
			notify('error', err.body.field_errors.map((e) => e.message).join(' / '));
		} else notify('error', isProviderError(err) ? err.message : String(err));
	}

	async function act(run: () => Promise<unknown>, message: string) {
		if (acting) return;
		acting = true;
		try {
			await run();
			notify('success', message);
		} catch (err) {
			fail(err);
		} finally {
			acting = false;
			void load();
		}
	}

	function remove(c: DirectCost) {
		if (!window.confirm(m['costs.deleteConfirm']())) return;
		void act(() => deleteCost(c.id, c.rowVersion), m['costs.deleted']());
	}

	const editable = (c: DirectCost) => c.status === 'draft' || c.status === 'returned';
	const canConfirm = (c: DirectCost) =>
		c.status === 'approved' && c.entryKind === 'provisional' && c.confirmedBy === null;
	const canAdjust = (c: DirectCost) =>
		c.status === 'approved' &&
		c.entryKind !== 'adjustment' &&
		c.projectId !== null &&
		c.confirmedBy === null;
	const shown = $derived(loadedFor === month ? (costs ?? []) : []);
	const pendingSubmit = $derived(shown.filter(editable));
	/** The month's drafts the owner may also approve: offer 申請して承認 (review U-2). */
	const pendingApprove = $derived(pendingSubmit.filter((c) => c.canApprove === true));

	/** 申請 then 承認, the two existing operations in a row. */
	async function submitAndApprove(c: DirectCost) {
		const submitted = await submitCost(c.id, c.rowVersion);
		await decideCost(c.id, { rowVersion: submitted.rowVersion, approve: true });
	}

	function costDetails(c: DirectCost): { label: string; value: string }[] {
		return [
			{ label: m['costs.fieldBookedOn'](), value: c.bookedOn },
			{ label: m['time.colTarget'](), value: targetLabel(c) },
			{ label: m['costs.fieldCostType'](), value: costTypeLabel(c.costType) },
			{ label: m['costs.colAmount'](), value: formatSignedYen(signedAmount(c)) }
		];
	}

	async function runSubmitApprove(rows: DirectCost[]) {
		acting = true;
		try {
			const result = await runEach(rows, submitAndApprove);
			if (result.done > 0) notify('success', m['costs.submitApproved']({ count: result.done }));
			if (result.failed > 0) {
				const reason = failureReason(result.firstError, m['costs.forbiddenEntry']());
				notify('error', m['costs.submitApproveFailed']({ count: result.failed, reason }));
			}
		} finally {
			acting = false;
			void load();
		}
	}

	async function submitApproveOne(c: DirectCost) {
		if (acting) return;
		const ok = await confirmAction({
			title: m['costs.submitApproveConfirmTitle'](),
			body: m['costs.submitApproveConfirm'](),
			details: costDetails(c),
			undo: m['costs.approveUndo'](),
			confirmLabel: m['costs.submitApprove']()
		});
		if (!ok || acting) return;
		await runSubmitApprove([c]);
	}

	async function submitApproveAll() {
		if (acting || pendingApprove.length === 0) return;
		// Act on the records the dialog counted, not a list reloaded while it was open.
		const rows = pendingApprove;
		const excluded = pendingSubmit.length - rows.length;
		// Each record that becomes an actual (PR #62 review): date, target, type, amount.
		const details = [
			{ label: m['confirm.count'](), value: m['confirm.countValue']({ count: rows.length }) },
			{
				label: m['costs.colAmount'](),
				value: formatSignedYen(rows.reduce((sum, c) => sum + signedAmount(c), 0))
			},
			...rows.map((c) => ({
				label: `${c.bookedOn} #${c.id}`,
				value: `${targetLabel(c)} / ${costTypeLabel(c.costType)} / ${formatSignedYen(signedAmount(c))}`
			}))
		];
		if (excluded > 0) {
			details.push({
				label: m['approvals.excludedLabel'](),
				value: m['costs.submitApproveExcluded']({ count: excluded })
			});
		}
		const ok = await confirmAction({
			title: m['costs.submitApproveConfirmTitle'](),
			body: m['costs.submitApproveAllConfirm']({ count: rows.length }),
			details,
			undo: m['costs.approveUndo'](),
			confirmLabel: m['costs.submitApproveAll']({ count: rows.length })
		});
		if (!ok || acting) return;
		await runSubmitApprove(rows);
	}

	async function submitAll() {
		if (acting || pendingSubmit.length === 0) return;
		acting = true;
		let done = 0;
		try {
			for (const c of pendingSubmit) {
				await submitCost(c.id, c.rowVersion);
				done += 1;
			}
			notify('success', m['costs.submittedAll']({ count: done }));
		} catch (err) {
			fail(err);
		} finally {
			acting = false;
			void load();
		}
	}

	function targetLabel(c: DirectCost): string {
		if (c.projectId !== null) return `${c.projectCode ?? ''} ${c.projectName ?? ''}`.trim();
		return c.allocations.map((a) => a.projectCode).join(' / ');
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.costs']()} description={m['costs.description']()} />

	{#if !available}
		<EmptyState title={m['time.demoUnavailable']()} />
	{:else}
		<div class="toolbar">
			<button type="button" class="banto-btn banto-btn--secondary" onclick={() => changeMonth(-1)}
				>{m['costs.prevMonth']()}</button
			>
			<span class="month" aria-live="polite">{monthWithPeriod(month)}</span>
			<button type="button" class="banto-btn banto-btn--secondary" onclick={() => changeMonth(1)}
				>{m['costs.nextMonth']()}</button
			>
			{#if canWrite}
				<button
					type="button"
					class="banto-btn banto-btn--primary"
					onclick={() => open({ cost: null, target: null, mode: 'cost' })}
					>{m['costs.add']()}</button
				>
				<button
					type="button"
					class="banto-btn banto-btn--secondary"
					disabled={acting || pendingSubmit.length === 0}
					onclick={() => void submitAll()}
					>{m['costs.submitAll']({ count: pendingSubmit.length })}</button
				>
				{#if pendingApprove.length > 0}
					<button
						type="button"
						class="banto-btn banto-btn--secondary"
						disabled={acting}
						onclick={() => void submitApproveAll()}
						>{m['costs.submitApproveAll']({ count: pendingApprove.length })}</button
					>
				{/if}
			{/if}
		</div>

		{#if form !== undefined}
			<section class="panel">
				{#key formKey}
					<CostEntryForm
						cost={form.cost}
						target={form.target}
						mode={form.mode}
						defaultDate={todayIso()}
						{projects}
						{phases}
						{vendors}
						onSaved={saved}
						onCancel={() => (form = undefined)}
						onPendingChange={(p) => (formPending = p)}
					/>
				{/key}
			</section>
		{/if}

		{#if isForbiddenError(loadError)}
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
		{:else if !costs}
			<LoadingState label={m['common.loading']()} />
		{:else if shown.length === 0}
			<EmptyState title={m['costs.empty']()} description={m['costs.emptyDesc']()} />
		{:else}
			<section class="panel">
				<div class="table-wrap">
					<table>
						<caption class="sr-only">{m['nav.costs']()}</caption>
						<thead>
							<tr>
								<th scope="col">{m['costs.fieldBookedOn']()}</th>
								<th scope="col">{m['costs.colKind']()}</th>
								<th scope="col">{m['time.colTarget']()}</th>
								<th scope="col">{m['costs.fieldCostType']()}</th>
								<th scope="col" class="num">{m['costs.colAmount']()}</th>
								<th scope="col">{m['costs.fieldVoucher']()}</th>
								<th scope="col">{m['costs.colStatus']()}</th>
								<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
							</tr>
						</thead>
						<tbody>
							{#each shown as c (c.id)}
								<tr>
									<td>{c.bookedOn}</td>
									<td>
										{kindLabel(c)}
										{#if c.confirmedBy !== null}<div class="sub">{m['costs.confirmed']()}</div>{/if}
									</td>
									<td>
										{targetLabel(c)}
										{#if c.description}<div class="sub wrap">{c.description}</div>{/if}
									</td>
									<td>{costTypeLabel(c.costType)}</td>
									<td class="num">{formatSignedYen(signedAmount(c))}</td>
									<td>{c.voucherNo ?? ''}</td>
									<td>
										<StatusBadge
											variant={timeStatusVariant(c.status)}
											label={timeStatusLabel(c.status)}
										/>
										{#if c.status === 'returned' && c.returnReason}
											<div class="sub wrap">{c.returnReason}</div>
										{/if}
									</td>
									<td>
										{#if canWrite}
											<div class="row-actions">
												{#if editable(c)}
													<button
														type="button"
														class="banto-btn banto-btn--secondary"
														disabled={acting}
														onclick={() => open({ cost: c, target: null, mode: 'cost' })}
														>{m['costs.edit']()}</button
													>
													<button
														type="button"
														class="banto-btn banto-btn--primary"
														disabled={acting}
														onclick={() =>
															void act(
																() => submitCost(c.id, c.rowVersion),
																m['costs.submitted']()
															)}>{m['costs.submit']()}</button
													>
													{#if c.canApprove}
														<button
															type="button"
															class="banto-btn banto-btn--secondary"
															disabled={acting}
															onclick={() => void submitApproveOne(c)}
															>{m['costs.submitApprove']()}</button
														>
													{/if}
													<button
														type="button"
														class="banto-btn banto-btn--ghost"
														disabled={acting}
														onclick={() => remove(c)}>{m['costs.delete']()}</button
													>
												{/if}
												{#if canConfirm(c)}
													<button
														type="button"
														class="banto-btn banto-btn--secondary"
														onclick={() => open({ cost: null, target: c, mode: 'confirms' })}
														>{m['costs.confirm']()}</button
													>
												{/if}
												{#if canAdjust(c)}
													<button
														type="button"
														class="banto-btn banto-btn--ghost"
														onclick={() => open({ cost: null, target: c, mode: 'adjustment' })}
														>{m['costs.adjust']()}</button
													>
												{/if}
											</div>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	{/if}
	<p class="sr-only" aria-live="polite">{guard.pending ? m['unsaved.notice']() : ''}</p>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
		max-width: 1200px;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.month {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		min-width: 5rem;
		text-align: center;
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

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.sub {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-xs);
	}

	.wrap {
		white-space: normal;
		max-width: 20rem;
	}

	.row-actions {
		display: flex;
		flex-wrap: wrap;
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
