<script lang="ts">
	/**
	 * 案件詳細 → 精算完了 (spec §5.1, T17, banto-cost P6a): what still blocks
	 * the settlement of a work-done project, and the settlement once recorded.
	 *
	 * Unapproved hours and direct costs, approved hours without a rate,
	 * unconfirmed provisionals and undecided order changes must be processed
	 * on their own screens first. The remaining amounts (未実績発注残 per
	 * purchase order, the forecast's remaining cost besides the orders, the
	 * unrecognized revenue) may be waived here with a reason; the settler
	 * (accounting) approves them. A waiver is sent with the amount shown, so
	 * an amount that changed meanwhile is refused and the check is read again.
	 *
	 * Records processed in the other sections do not notify this one: 「確認し
	 * 直す」 reads the check again and keeps the reasons typed so far.
	 *
	 * A settled project may be reopened (精算完了の取消) back to 作業完了 with
	 * a reason; the settlement and its waivers stay and are listed as
	 * history, and settling again runs the check anew.
	 *
	 * Reading needs `ViewProjectAmounts`; settling and reopening
	 * `SettleProject` (the project's manager or accounting). A `forbidden`
	 * read hides the section's content.
	 */
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import { LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { formatYen, isForbiddenError, statusLabel } from '#lib/banto/costFormat.js';
	import { minutesToHours } from '#lib/banto/budgetFormat.js';
	import {
		blockerKey,
		getProjectCloseout,
		reopenProject,
		settleProject,
		type CloseoutBlocker,
		type CloseoutCheck,
		type CloseoutWaiver
	} from '#lib/banto/closeoutAdmin.js';

	interface Props {
		projectId: number;
		/** The project code, shown in confirmation dialogs. */
		code: string;
		/** May settle and reopen (the project's manager or accounting). */
		canSettle: boolean;
		/** The project's status changed (settled): the page reloads it. */
		onProjectChanged?: () => void;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { projectId, code, canSettle, onProjectChanged, onPendingChange }: Props = $props();

	const available = isPipelineAvailable();
	let check = $state<CloseoutCheck | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	let reasons = $state<Record<string, string>>({});
	let note = $state('');
	let busy = $state(false);
	let errors = $state<string[]>([]);
	let missing = $state<Set<string>>(new Set());
	let reopenReason = $state('');
	let reopenMissing = $state(false);

	const dirty = $derived(
		note.trim() !== '' ||
			reopenReason.trim() !== '' ||
			Object.values(reasons).some((r) => r.trim() !== '')
	);

	$effect(() => {
		onPendingChange?.({ dirty, busy });
	});

	async function load(id: number) {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const got = await getProjectCloseout(id);
			if (token !== loadToken) return;
			check = got;
			const kept: Record<string, string> = {};
			for (const b of got.blockers) {
				const key = blockerKey(b);
				if (b.waivable) kept[key] = reasons[key] ?? '';
			}
			reasons = kept;
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			check = null;
		}
	}

	$effect(() => {
		void load(projectId);
	});

	function label(b: CloseoutBlocker): string {
		switch (b.kind) {
			case 'unapproved':
				return m['closeout.kind.unapproved']({
					timeEntries: String(b.timeEntries ?? 0),
					hours: minutesToHours(b.minutes ?? 0) || '0',
					costs: String(b.costs ?? 0)
				});
			case 'missing_rate':
				return m['closeout.kind.missingRate']({ count: String(b.count ?? 0) });
			case 'provisional':
				return m['closeout.kind.provisional']({ count: String(b.count ?? 0) });
			case 'pending_order_changes':
				return m['closeout.kind.pendingOrderChanges']({ count: String(b.count ?? 0) });
			case 'purchase_remaining':
				return m['closeout.kind.purchaseRemaining']({
					label: b.purchaseOrderLabel ?? `#${b.purchaseOrderId}`
				});
			case 'forecast_remaining':
				return m['closeout.kind.forecastRemaining']();
			case 'revenue_difference':
				return m['closeout.kind.revenueDifference']();
		}
	}

	function waiverLabel(w: CloseoutWaiver): string {
		return label({
			kind: w.kind,
			waivable: true,
			amount: null,
			purchaseOrderId: w.purchaseOrderId,
			purchaseOrderLabel: w.purchaseOrderLabel,
			count: null,
			timeEntries: null,
			minutes: null,
			costs: null
		});
	}

	const blocked = $derived(check?.blockers.some((b) => !b.waivable) ?? false);

	function showErrors(fieldErrors: FieldError[]) {
		errors = fieldErrors.map((e) => e.message);
	}

	async function settle() {
		const c = check;
		if (!c || busy || blocked) return;
		const empty = new Set(
			c.blockers.filter((b) => b.waivable && !reasons[blockerKey(b)]?.trim()).map(blockerKey)
		);
		missing = empty;
		if (empty.size > 0) return;
		const ok = await confirmAction({
			title: m['closeout.settleConfirmTitle'](),
			body: m['closeout.settleConfirm'](),
			details: [
				{ label: m['confirm.project'](), value: code },
				{
					label: m['closeout.colWaivers'](),
					value: m['confirm.countValue']({
						count: c.blockers.filter((b) => b.waivable).length
					})
				}
			],
			undo: m['closeout.settleUndo'](),
			confirmLabel: m['closeout.settle']()
		});
		if (!ok || busy) return;
		busy = true;
		errors = [];
		void (async () => {
			try {
				await settleProject(projectId, {
					rowVersion: c.rowVersion,
					note: note.trim() === '' ? null : note.trim(),
					waivers: c.blockers
						.filter((b) => b.waivable)
						.map((b) => ({
							kind: b.kind,
							purchaseOrderId: b.purchaseOrderId,
							amount: b.amount ?? 0,
							reason: reasons[blockerKey(b)].trim()
						}))
				});
				notify('success', m['closeout.settled']());
				note = '';
				reasons = {};
				onProjectChanged?.();
				await load(projectId);
			} catch (err) {
				await failed(err);
			} finally {
				busy = false;
			}
		})();
	}

	async function failed(err: unknown) {
		if (isProviderError(err) && err.body.kind === 'validation') {
			showErrors(err.body.field_errors);
			await load(projectId);
		} else if (isForbiddenError(err)) {
			notify('error', m['closeout.forbiddenEdit']());
		} else {
			notify('error', isProviderError(err) ? err.message : String(err));
		}
	}

	async function reopen() {
		const c = check;
		if (!c || busy) return;
		const reason = reopenReason.trim();
		reopenMissing = reason === '';
		if (reopenMissing) return;
		const ok = await confirmAction({
			title: m['closeout.reopenConfirmTitle'](),
			body: m['closeout.reopenConfirm'](),
			details: [
				{ label: m['confirm.project'](), value: code },
				{ label: m['confirm.reason'](), value: reason }
			],
			undo: m['closeout.reopenUndo'](),
			confirmLabel: m['closeout.reopen'](),
			danger: true
		});
		if (!ok || busy) return;
		busy = true;
		errors = [];
		void (async () => {
			try {
				await reopenProject(projectId, { rowVersion: c.rowVersion, reason });
				notify('success', m['closeout.reopened']());
				reopenReason = '';
				onProjectChanged?.();
				await load(projectId);
			} catch (err) {
				await failed(err);
			} finally {
				busy = false;
			}
		})();
	}
</script>

<section class="closeout" aria-labelledby="closeout-heading">
	<h2 id="closeout-heading">{m['closeout.sectionTitle']()}</h2>
	{#if !available}
		<p class="note">{m['closeout.demoUnavailable']()}</p>
	{:else if isForbiddenError(loadError)}
		<p class="note">{m['closeout.forbidden']()}</p>
	{:else if loadError}
		<p class="error" role="alert">
			{isProviderError(loadError) ? loadError.message : String(loadError)}
		</p>
		<button
			type="button"
			class="banto-btn banto-btn--secondary"
			onclick={() => void load(projectId)}
		>
			{m['common.reload']()}
		</button>
	{:else if !check}
		<LoadingState label={m['common.loading']()} />
	{:else if check.closeout}
		{@const rec = check.closeout}
		<div class="headline">
			<span>{m['closeout.settledOn']({ date: rec.settledOn })}</span>
			<span class="note">{m['closeout.settledBy']({ name: rec.settledByName ?? '—' })}</span>
			<span class="note"
				>{m['closeout.previousStatus']({ status: statusLabel(rec.previousStatus) })}</span
			>
		</div>
		{#if rec.note}
			<p class="note">{m['closeout.note']()}: {rec.note}</p>
		{/if}
		<h3>{m['closeout.waiversTitle']()}</h3>
		{#if rec.waivers.length === 0}
			<p class="note">{m['closeout.noWaivers']()}</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">{m['closeout.colItem']()}</th>
							<th scope="col" class="num">{m['closeout.colAmount']()}</th>
							<th scope="col">{m['closeout.colReason']()}</th>
							<th scope="col">{m['closeout.colApprover']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each rec.waivers as w, i (i)}
							<tr>
								<td>{waiverLabel(w)}</td>
								<td class="num">{formatYen(w.amount)}</td>
								<td>{w.reason}</td>
								<td>{w.approvedByName ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#each errors as message, i (i)}
			<p class="error" role="alert">{message}</p>
		{/each}
		{#if canSettle}
			<label class="field">
				<span class="label">{m['closeout.reopenReason']()}</span>
				<input
					type="text"
					class="banto-input"
					placeholder={m['closeout.reopenReasonPlaceholder']()}
					disabled={busy}
					bind:value={reopenReason}
				/>
				{#if reopenMissing && !reopenReason.trim()}
					<span class="error">{m['closeout.reasonRequired']()}</span>
				{/if}
			</label>
			<div class="actions">
				<button
					type="button"
					class="banto-btn banto-btn--secondary"
					disabled={busy}
					onclick={reopen}
				>
					{m['closeout.reopen']()}
				</button>
			</div>
		{/if}
	{:else if !check.settleable}
		<p class="note">{m['closeout.notYet']()}</p>
	{:else}
		{#if check.blockers.length === 0}
			<p class="note">{m['closeout.ready']()}</p>
		{:else}
			<p class="note">{m['closeout.blockersIntro']()}</p>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">{m['closeout.colItem']()}</th>
							<th scope="col" class="num">{m['closeout.colAmount']()}</th>
							<th scope="col">{m['closeout.colReason']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each check.blockers as b (blockerKey(b))}
							{@const key = blockerKey(b)}
							<tr>
								<td>{label(b)}</td>
								<td class="num">{b.amount === null ? '—' : formatYen(b.amount)}</td>
								<td>
									{#if b.waivable}
										<input
											type="text"
											class="banto-input"
											aria-label={`${m['closeout.colReason']()} ${label(b)}`}
											placeholder={m['closeout.reasonPlaceholder']()}
											disabled={!canSettle || busy}
											bind:value={reasons[key]}
										/>
										{#if missing.has(key) && !reasons[key]?.trim()}
											<span class="error">{m['closeout.reasonRequired']()}</span>
										{/if}
									{:else}
										<span class="warn">{m['closeout.needsProcessing']()}</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#each errors as message, i (i)}
			<p class="error" role="alert">{message}</p>
		{/each}
		{#if canSettle}
			<label class="field">
				<span class="label">{m['closeout.note']()}</span>
				<input type="text" class="banto-input" disabled={busy} bind:value={note} />
			</label>
		{/if}
		<div class="actions">
			{#if canSettle}
				<button
					type="button"
					class="banto-btn banto-btn--primary"
					disabled={busy || blocked}
					onclick={settle}
				>
					{m['closeout.settle']()}
				</button>
			{/if}
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				disabled={busy}
				onclick={() => void load(projectId)}
			>
				{m['closeout.recheck']()}
			</button>
		</div>
	{/if}
	{#if check && check.history.length > 0}
		<h3>{m['closeout.historyTitle']()}</h3>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col">{m['closeout.colSettledOn']()}</th>
						<th scope="col">{m['closeout.colSettledBy']()}</th>
						<th scope="col" class="num">{m['closeout.colWaivers']()}</th>
						<th scope="col">{m['closeout.colReopenedOn']()}</th>
						<th scope="col">{m['closeout.colReopenReason']()}</th>
						<th scope="col">{m['closeout.colReopenedBy']()}</th>
					</tr>
				</thead>
				<tbody>
					{#each check.history as h (h.id)}
						<tr>
							<td>{h.settledOn}</td>
							<td>{h.settledByName ?? '—'}</td>
							<td class="num">{h.waivers.length}</td>
							<td>{h.reopening?.reopenedOn ?? '—'}</td>
							<td>{h.reopening?.reason ?? '—'}</td>
							<td>{h.reopening?.reopenedByName ?? '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.closeout {
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

	h3 {
		margin: var(--banto-space-2) 0 0;
		font-size: var(--banto-font-size-md, 1rem);
	}

	.headline {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--banto-space-3);
	}

	.label,
	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.warn {
		color: var(--banto-warning-tint-text);
		font-size: var(--banto-font-size-sm);
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
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
		padding: var(--banto-space-1) var(--banto-space-2);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		text-align: left;
		vertical-align: top;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	td input {
		width: 100%;
		min-width: 12rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		max-width: 40rem;
	}

	.actions {
		display: flex;
		gap: var(--banto-space-2);
	}
</style>
