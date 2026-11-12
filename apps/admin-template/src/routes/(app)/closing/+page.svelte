<script lang="ts">
	/**
	 * 月次締め (spec §7 / §9, banto-cost P6b, T11). Accounting (finance.close)
	 * picks a month, sees what blocks the close (unapproved hours and direct
	 * costs dated in it) and what only warns (approved hours without a rate,
	 * provisionals not invoiced), closes it, or reopens a closed month with a
	 * reason. The figures saved at the latest close are compared with today's
	 * so a correction made after reopening shows (仕様9章).
	 *
	 * The server refuses every write dated in a closed month; this page only
	 * shows the state.
	 */
	import PeriodHint from '#lib/components/PeriodHint.svelte';
	import { isProviderError, notify } from '@banto/admin-core';
	import { resolve } from '$app/paths';
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import {
		closeMonth,
		getClosingMonth,
		listClosingMonths,
		previousMonth,
		reopenMonth,
		type MonthClosing,
		type MonthRow,
		type MonthStatus,
		type WarningCode
	} from '#lib/banto/closingAdmin.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { formatSignedYen, formatYen, isForbiddenError, todayIso } from '#lib/banto/costFormat.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';

	const available = isPipelineAvailable();
	const canWrite = $derived(canWriteResources(sessionStore.role));

	let month = $state(previousMonth(todayIso()));
	let view = $state<MonthClosing | null>(null);
	let months = $state<MonthRow[]>([]);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	let reason = $state('');
	let busy = $state(false);
	const forbidden = $derived(isForbiddenError(loadError));

	function statusLabel(s: MonthStatus): string {
		return m[`closing.status.${s}`]();
	}

	function warningLabel(code: WarningCode, count: number): string {
		if (code === 'missing_rate') return m['closing.warning.missing_rate']({ count });
		if (code === 'fixed_unposted') return m['closing.warning.fixed_unposted']({ count });
		if (code === 'recurring_unrecognized')
			return m['closing.warning.recurring_unrecognized']({ count });
		return m['closing.warning.provisional']({ count });
	}

	async function load() {
		if (!available) return;
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
			notify('error', m['closing.invalidMonth']());
			return;
		}
		const token = ++loadToken;
		loadError = null;
		try {
			const [result, list] = await Promise.all([
				getClosingMonth(month),
				listClosingMonths().catch(() => [] as MonthRow[])
			]);
			if (token !== loadToken) return;
			view = result;
			months = list;
		} catch (err) {
			if (token === loadToken) loadError = err;
		}
	}

	void load();

	function reportError(err: unknown) {
		if (isProviderError(err) && err.body.kind === 'validation') {
			notify('error', err.body.field_errors.map((e) => e.message).join(' / '));
		} else notify('error', isProviderError(err) ? err.message : String(err));
	}

	async function close() {
		if (!view || busy) return;
		if (!window.confirm(m['closing.closeConfirm']({ month: view.month }))) return;
		busy = true;
		try {
			view = await closeMonth(view.month, view.rowVersion);
			notify('success', m['closing.closed']({ month: view.month }));
			months = await listClosingMonths().catch(() => months);
		} catch (err) {
			reportError(err);
		} finally {
			busy = false;
		}
	}

	async function reopen() {
		if (!view || busy || reason.trim() === '') return;
		if (!window.confirm(m['closing.reopenConfirm']({ month: view.month }))) return;
		busy = true;
		try {
			view = await reopenMonth(view.month, view.rowVersion, reason.trim());
			notify('success', m['closing.reopened']({ month: view.month }));
			reason = '';
			months = await listClosingMonths().catch(() => months);
		} catch (err) {
			reportError(err);
		} finally {
			busy = false;
		}
	}

	function pick(target: string) {
		month = target;
		void load();
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.closing']()} description={m['closing.description']()}>
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
		<EmptyState title={m['cost.forbiddenTitle']()} description={m['closing.forbidden']()} />
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
	{:else}
		<form
			class="panel filters"
			onsubmit={(event) => {
				event.preventDefault();
				void load();
			}}
		>
			<label class="field">
				<span>{m['closing.month']()}<PeriodHint {month} /></span>
				<input class="banto-input" type="month" placeholder="YYYY-MM" bind:value={month} />
			</label>
			<button type="submit" class="banto-btn banto-btn--primary">{m['closing.show']()}</button>
		</form>

		{#if !view}
			<LoadingState label={m['common.loading']()} />
		{:else}
			<section class="panel" data-testid="closing-check">
				<h2>
					{view.month}
					<span class="badge" data-status={view.status}>
						{m['closing.statusLabel']({ status: statusLabel(view.status) })}
					</span>
				</h2>
				{#if view.status !== 'closed'}
					<h3>{m['closing.checkTitle']()}</h3>
					{#if view.canClose}
						<p class="note">{m['closing.ready']()}</p>
					{:else}
						{#if view.unapprovedTimeEntries > 0 || view.unapprovedCosts > 0}
							<p class="alert" role="alert">
								{m['closing.unapproved']({
									timeEntries: view.unapprovedTimeEntries,
									costs: view.unapprovedCosts
								})}
							</p>
						{/if}
						{#if view.ledgerReviewEntries > 0}
							<p class="alert" role="alert" data-testid="closing-ledger-review">
								{m['closing.ledgerReview']({ count: view.ledgerReviewEntries })}
							</p>
						{/if}
					{/if}
				{/if}
				{#if view.warnings.length > 0}
					<ul class="warnings">
						{#each view.warnings as w (w.code)}
							<li>{warningLabel(w.code, w.count)}</li>
						{/each}
					</ul>
				{/if}

				<h3>{m['closing.totalTitle']()}</h3>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col" class="num">{m['closing.colLabor']()}</th>
								<th scope="col" class="num">{m['closing.colLaborMissing']()}</th>
								<th scope="col" class="num">{m['closing.colDirect']()}</th>
								<th scope="col" class="num">{m['closing.colRevenue']()}</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td class="num">{formatYen(view.total.laborCost)}</td>
								<td class="num">{view.total.laborMissing}</td>
								<td class="num">{formatYen(view.total.directCost)}</td>
								<td class="num">{formatYen(view.total.revenue)}</td>
							</tr>
						</tbody>
					</table>
				</div>

				{#if canWrite}
					{#if view.status === 'closed'}
						<form
							class="filters"
							onsubmit={(event) => {
								event.preventDefault();
								void reopen();
							}}
						>
							<label class="field grow">
								<span>{m['closing.reopenReason']()}</span>
								<input
									class="banto-input"
									type="text"
									maxlength="1000"
									placeholder={m['closing.reopenReasonPlaceholder']()}
									bind:value={reason}
									disabled={busy}
								/>
							</label>
							<button
								type="submit"
								class="banto-btn banto-btn--secondary"
								disabled={busy || reason.trim() === ''}
							>
								{m['closing.reopen']()}
							</button>
						</form>
					{:else}
						<div>
							<button
								type="button"
								class="banto-btn banto-btn--primary"
								disabled={busy || !view.canClose}
								onclick={() => void close()}
							>
								{m['closing.close']()}
							</button>
						</div>
					{/if}
				{/if}
			</section>

			{#if view.comparison}
				<section class="panel">
					<h2>{m['closing.compareTitle']()}</h2>
					<p class="note">{m['closing.compareIntro']({ at: view.comparison.closedAt })}</p>
					{#if view.comparison.changed.length === 0}
						<p class="note">{m['closing.noChange']()}</p>
					{:else}
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th scope="col">{m['closing.colProject']()}</th>
										<th scope="col"></th>
										<th scope="col" class="num">{m['closing.colLabor']()}</th>
										<th scope="col" class="num">{m['closing.colLaborMissing']()}</th>
										<th scope="col" class="num">{m['closing.colDirect']()}</th>
										<th scope="col" class="num">{m['closing.colRevenue']()}</th>
									</tr>
								</thead>
								<tbody>
									{#each view.comparison.changed as row (row.projectId)}
										<tr>
											<td rowspan="3">
												<a href={resolve(`projects/${row.projectId}`)}>{row.projectCode}</a>
												{row.projectName}
											</td>
											<td class="muted">{m['closing.atClose']()}</td>
											<td class="num">{formatYen(row.atClose.laborCost)}</td>
											<td class="num">{row.atClose.laborMissing}</td>
											<td class="num">{formatYen(row.atClose.directCost)}</td>
											<td class="num">{formatYen(row.atClose.revenue)}</td>
										</tr>
										<tr>
											<td class="muted">{m['closing.current']()}</td>
											<td class="num">{formatYen(row.current.laborCost)}</td>
											<td class="num">{row.current.laborMissing}</td>
											<td class="num">{formatYen(row.current.directCost)}</td>
											<td class="num">{formatYen(row.current.revenue)}</td>
										</tr>
										<tr>
											<td class="muted">{m['outlook.colDifference']()}</td>
											<td class="num">
												{formatSignedYen(row.current.laborCost - row.atClose.laborCost)}
											</td>
											<td class="num">{row.current.laborMissing - row.atClose.laborMissing}</td>
											<td class="num">
												{formatSignedYen(row.current.directCost - row.atClose.directCost)}
											</td>
											<td class="num">
												{formatSignedYen(row.current.revenue - row.atClose.revenue)}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</section>
			{/if}

			<section class="panel">
				<h2>{m['closing.historyTitle']()}</h2>
				{#if view.history.length === 0}
					<p class="note">{m['closing.noHistory']()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th scope="col">{m['closing.colAction']()}</th>
									<th scope="col">{m['closing.colAt']()}</th>
									<th scope="col">{m['closing.colActor']()}</th>
									<th scope="col">{m['closing.colReason']()}</th>
								</tr>
							</thead>
							<tbody>
								{#each view.history as e (e.id)}
									<tr>
										<td>{m[`closing.action.${e.action}`]()}</td>
										<td>{e.createdAt}</td>
										<td>{e.actorName ?? '—'}</td>
										<td class="wrap">{e.reason ?? ''}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		{/if}

		<section class="panel">
			<h2>{m['closing.monthsTitle']()}</h2>
			{#if months.length === 0}
				<p class="note">{m['closing.noMonths']()}</p>
			{:else}
				<ul class="months">
					{#each months as row (row.month)}
						<li>
							<button type="button" class="link" onclick={() => pick(row.month)}>
								{row.month}
							</button>
							{statusLabel(row.status)}
						</li>
					{/each}
				</ul>
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

	.filters {
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

	.field input {
		color: var(--banto-text);
	}

	.grow {
		flex: 1 1 16rem;
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

	.badge {
		font-size: var(--banto-font-size-sm);
		font-weight: 500;
		color: var(--banto-text-muted);
	}

	.badge[data-status='closed'] {
		color: var(--banto-text);
		font-weight: 600;
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.alert {
		margin: 0;
		color: var(--banto-danger, var(--banto-text));
		font-size: var(--banto-font-size-sm);
	}

	.warnings,
	.months {
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

	td.wrap {
		white-space: normal;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.muted {
		color: var(--banto-text-muted);
	}
</style>
