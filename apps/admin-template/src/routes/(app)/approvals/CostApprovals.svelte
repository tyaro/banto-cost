<script lang="ts">
	/**
	 * 承認一覧 → 直接費 (spec §8 step 5, banto-cost P4d): submitted direct
	 * costs the caller may decide - the projects they manage
	 * (`project.manage`), or every project for accounting (`finance.close`),
	 * with `amount.view` (a split record needs the right on each project it
	 * lands on). Approving checks the approved ledger again: an adjustment
	 * within its original, one invoice per provisional, an order's remainder
	 * (T05, T14); a refusal comes back as the reason. Self-approval follows
	 * the company policy and is audited (design 2.4). 表示中をすべて承認
	 * decides the listed costs one after another with the same operation
	 * (review U-2); a refused one (its reason shown) does not stop the rest.
	 */
	import { isProviderError, notify } from '@banto/admin-core';
	import { LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import { formatSignedYen, isForbiddenError } from '#lib/banto/costFormat.js';
	import { decideCost, listCostApprovals, type DirectCost } from '#lib/banto/costsAdmin.js';
	import { costTypeLabel } from '#lib/banto/budgetFormat.js';
	import { kindLabel, signedAmount } from '#lib/banto/costsFormat.js';
	import { failureReason, runEach } from '#lib/banto/bulk.js';

	interface Props {
		canWrite: boolean;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { canWrite, onPendingChange }: Props = $props();

	let costs = $state<DirectCost[] | null>(null);
	let loadError = $state<string | null>(null);
	let loadToken = 0;
	let busy = $state(false);
	let returning = $state<number | null>(null);
	let reason = $state('');
	let reasonError = $state('');

	$effect(() => {
		onPendingChange?.({ dirty: returning !== null && reason.trim() !== '', busy });
	});

	async function load() {
		const token = ++loadToken;
		loadError = null;
		try {
			const rows = await listCostApprovals();
			if (token !== loadToken) return;
			costs = rows;
		} catch (err) {
			if (token !== loadToken) return;
			loadError = isProviderError(err) ? err.message : String(err);
		}
	}

	$effect(() => {
		void load();
	});

	function fail(err: unknown) {
		if (isForbiddenError(err)) notify('error', m['approvals.forbidden']());
		else if (isProviderError(err) && err.body.kind === 'validation') {
			notify('error', err.body.field_errors.map((e) => e.message).join(' / '));
		} else notify('error', isProviderError(err) ? err.message : String(err));
	}

	async function approve(c: DirectCost) {
		if (busy) return;
		busy = true;
		try {
			await decideCost(c.id, { rowVersion: c.rowVersion, approve: true });
			notify('success', m['approvals.approved']());
		} catch (err) {
			fail(err);
		} finally {
			busy = false;
			void load();
		}
	}

	async function approveAll() {
		if (busy || returning !== null || !costs || costs.length === 0) return;
		const rows = costs;
		const ok = await confirmAction({
			title: m['costs.approveAllConfirmTitle'](),
			body: m['costs.approveAllConfirm']({ count: rows.length }),
			details: [
				{ label: m['confirm.count'](), value: m['confirm.countValue']({ count: rows.length }) }
			],
			undo: m['costs.approveUndo'](),
			confirmLabel: m['approvals.approveAll']({ count: rows.length })
		});
		if (!ok || busy) return;
		busy = true;
		try {
			const result = await runEach(rows, (c) =>
				decideCost(c.id, { rowVersion: c.rowVersion, approve: true })
			);
			if (result.done > 0) notify('success', m['approvals.approvedCount']({ count: result.done }));
			if (result.failed > 0) {
				notify(
					'error',
					m['approvals.approveAllFailed']({
						count: result.failed,
						reason: failureReason(result.firstError, m['approvals.forbidden']())
					})
				);
			}
		} finally {
			busy = false;
			void load();
		}
	}

	function startReturn(c: DirectCost) {
		if (returning !== null && reason.trim() !== '' && returning !== c.id) {
			if (!window.confirm(m['approvals.discardConfirm']())) return;
		}
		returning = c.id;
		reason = '';
		reasonError = '';
	}

	async function sendReturn(c: DirectCost) {
		if (busy) return;
		if (reason.trim() === '') {
			reasonError = m['approvals.errorReason']();
			return;
		}
		busy = true;
		try {
			await decideCost(c.id, { rowVersion: c.rowVersion, approve: false, reason: reason.trim() });
			notify('success', m['approvals.returned']());
			returning = null;
			reason = '';
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				reasonError = err.body.field_errors.map((e) => e.message).join(' / ');
			} else fail(err);
		} finally {
			busy = false;
			void load();
		}
	}

	function targetLabel(c: DirectCost): string {
		if (c.projectId !== null) return `${c.projectCode ?? ''} ${c.projectName ?? ''}`.trim();
		return c.allocations.map((a) => `${a.projectCode} ${formatSignedYen(a.amount)}`).join(' / ');
	}
</script>

<section class="panel" aria-labelledby="cost-approvals-heading">
	<h2 id="cost-approvals-heading">{m['costs.approvalsTitle']()}</h2>
	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{:else if !costs}
		<LoadingState label={m['common.loading']()} />
	{:else if costs.length === 0}
		<p class="note">{m['costs.approvalsEmpty']()}</p>
	{:else}
		{#if canWrite}
			<div class="list-head">
				<button
					type="button"
					class="banto-btn banto-btn--primary"
					disabled={busy || returning !== null}
					onclick={() => void approveAll()}
				>
					{m['approvals.approveAll']({ count: costs.length })}
				</button>
			</div>
		{/if}
		<div class="table-wrap">
			<table>
				<caption class="sr-only">{m['costs.approvalsTitle']()}</caption>
				<thead>
					<tr>
						<th scope="col">{m['approvals.colPerson']()}</th>
						<th scope="col">{m['costs.fieldBookedOn']()}</th>
						<th scope="col">{m['costs.colKind']()}</th>
						<th scope="col">{m['time.colTarget']()}</th>
						<th scope="col">{m['costs.fieldCostType']()}</th>
						<th scope="col" class="num">{m['costs.colAmount']()}</th>
						<th scope="col">{m['costs.fieldVoucher']()}</th>
						<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
					</tr>
				</thead>
				<tbody>
					{#each costs as c (c.id)}
						<tr>
							<td>{c.userName}</td>
							<td>{c.bookedOn}</td>
							<td>
								{kindLabel(c)}
								{#if c.reason}<div class="sub wrap">{c.reason}</div>{/if}
							</td>
							<td class="wrap">
								{targetLabel(c)}
								{#if c.description}<div class="sub">{c.description}</div>{/if}
							</td>
							<td>{costTypeLabel(c.costType)}</td>
							<td class="num">{formatSignedYen(signedAmount(c))}</td>
							<td>{c.voucherNo ?? ''}</td>
							<td>
								{#if canWrite}
									<div class="row-actions">
										<button
											type="button"
											class="banto-btn banto-btn--primary"
											disabled={busy}
											onclick={() => void approve(c)}>{m['approvals.approve']()}</button
										>
										<button
											type="button"
											class="banto-btn banto-btn--secondary"
											disabled={busy}
											onclick={() => startReturn(c)}>{m['approvals.return']()}</button
										>
									</div>
								{/if}
							</td>
						</tr>
						{#if returning === c.id}
							<tr class="return-row">
								<td colspan="8">
									<form
										class="return-form"
										onsubmit={(ev) => {
											ev.preventDefault();
											void sendReturn(c);
										}}
									>
										<label class="field">
											<span>{m['approvals.fieldReason']()}</span>
											<input
												class="banto-input"
												bind:value={reason}
												aria-invalid={reasonError !== ''}
											/>
											{#if reasonError}<span class="error">{reasonError}</span>{/if}
										</label>
										<button type="submit" class="banto-btn banto-btn--primary" disabled={busy}>
											{m['approvals.sendReturn']()}
										</button>
										<button
											type="button"
											class="banto-btn banto-btn--ghost"
											disabled={busy}
											onclick={() => (returning = null)}>{m['common.cancel']()}</button
										>
									</form>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
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

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.list-head {
		display: flex;
		justify-content: flex-end;
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

	.wrap {
		white-space: normal;
		min-width: 12rem;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.sub {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-xs);
	}

	.row-actions {
		display: flex;
		gap: var(--banto-space-1);
	}

	.return-row td {
		background: var(--banto-surface-subtle);
	}

	.return-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--banto-space-2);
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

	.error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
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
