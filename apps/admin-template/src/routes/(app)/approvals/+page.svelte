<script lang="ts">
	/**
	 * 承認一覧 (spec §8 step 4 / §9, banto-cost P4b): submitted hours the
	 * caller may decide - those of the projects they manage
	 * (`project.manage`), or every project and the common activities for
	 * accounting (`finance.close`). Each entry is approved, or returned with
	 * a reason. Approving fixes the hourly rate in effect on the work date
	 * and the labor cost; without a rate the entry is approved as 原価未確定
	 * (T04), never as 0 yen. Entries whose rate would not resolve are marked
	 * 単価未登録 beforehand and approving one asks first (review U-1; a
	 * warning, not a stop). 表示中をすべて承認 approves the listed entries
	 * one after another with the same per-entry operation, leaving out those
	 * 単価未登録 (review U-2); a refused entry does not stop the rest.
	 *
	 * The company runs single-handed, so approving one's own submission is
	 * allowed and recorded in the audit log (design 2.4). The server decides
	 * each entry; nothing the caller may not decide is listed. Submitted
	 * direct costs (P4d) are listed below (CostApprovals.svelte), and for
	 * accounting the corrections of approved hours (P6b-2,
	 * CorrectionApprovals.svelte). Demo mode has no backend.
	 */
	import { isProviderError, notify } from '@banto/admin-core';
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { isForbiddenError } from '#lib/banto/costFormat.js';
	import { decideEntry, listApprovals, type TimeEntry } from '#lib/banto/timeAdmin.js';
	import { dayLabel, formatMinutes, reworkLabel } from '#lib/banto/timeFormat.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { runEach } from '#lib/banto/bulk.js';
	import CostApprovals from './CostApprovals.svelte';
	import CorrectionApprovals from './CorrectionApprovals.svelte';
	import { resolve } from '$app/paths';

	const available = isPipelineAvailable();
	const canWrite = $derived(canWriteResources(sessionStore.role));

	let entries = $state<TimeEntry[] | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	let busy = $state(false);
	/** The entry whose return reason is being typed. */
	let returning = $state<number | null>(null);
	let reason = $state('');
	let reasonError = $state('');
	let costsPending = $state({ dirty: false, busy: false });
	let correctionsPending = $state({ dirty: false, busy: false });
	const guard = guardUnsavedChanges({
		isDirty: () =>
			(returning !== null && reason.trim() !== '') ||
			costsPending.dirty ||
			correctionsPending.dirty,
		isSaving: () => busy || costsPending.busy || correctionsPending.busy
	});

	async function load() {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const rows = await listApprovals();
			if (token !== loadToken) return;
			entries = rows;
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			entries = null;
		}
	}

	$effect(() => {
		void load();
	});

	/** Entries that would be approved as 原価未確定 now (review U-1). */
	const rateMissingCount = $derived((entries ?? []).filter((e) => e.rateMissing === true).length);
	/** What 表示中をすべて承認 approves: every listed entry with a rate. */
	const approvable = $derived((entries ?? []).filter((e) => e.rateMissing !== true));
	const totalMinutes = $derived((entries ?? []).reduce((sum, e) => sum + e.minutes, 0));

	function fail(err: unknown) {
		if (isForbiddenError(err)) notify('error', m['approvals.forbidden']());
		else notify('error', isProviderError(err) ? err.message : String(err));
	}

	async function approve(entry: TimeEntry) {
		if (busy) return;
		// A warning, not a stop: a missing rate can be right (e.g. a person
		// paid by a monthly fixed cost), so the approver decides.
		if (entry.rateMissing && !window.confirm(m['approvals.rateMissingConfirm']())) return;
		busy = true;
		try {
			const result = await decideEntry(entry.id, { rowVersion: entry.rowVersion, approve: true });
			notify(
				'success',
				result.costMissing ? m['approvals.approvedNoRate']() : m['approvals.approved']()
			);
		} catch (err) {
			fail(err);
		} finally {
			busy = false;
			void load();
		}
	}

	async function approveAll() {
		if (busy || returning !== null || approvable.length === 0) return;
		let question: string = m['approvals.approveAllConfirm']({ count: approvable.length });
		if (rateMissingCount > 0) {
			question += '\n' + m['approvals.approveAllExcluded']({ count: rateMissingCount });
		}
		if (!window.confirm(question)) return;
		busy = true;
		try {
			const result = await runEach(approvable, (e) =>
				decideEntry(e.id, { rowVersion: e.rowVersion, approve: true })
			);
			if (result.done > 0) notify('success', m['approvals.approvedCount']({ count: result.done }));
			if (result.failed > 0) {
				const err = result.firstError;
				const reason = isForbiddenError(err)
					? m['approvals.forbidden']()
					: isProviderError(err)
						? err.message
						: String(err);
				notify('error', m['approvals.approveAllFailed']({ count: result.failed, reason }));
			}
		} finally {
			busy = false;
			void load();
		}
	}

	function startReturn(entry: TimeEntry) {
		if (returning !== null && reason.trim() !== '' && returning !== entry.id) {
			if (!window.confirm(m['approvals.discardConfirm']())) return;
		}
		returning = entry.id;
		reason = '';
		reasonError = '';
	}

	async function sendReturn(entry: TimeEntry) {
		if (busy) return;
		if (reason.trim() === '') {
			reasonError = m['approvals.errorReason']();
			return;
		}
		busy = true;
		try {
			await decideEntry(entry.id, {
				rowVersion: entry.rowVersion,
				approve: false,
				reason: reason.trim()
			});
			notify('success', m['approvals.returned']());
			returning = null;
			reason = '';
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				reasonError = err.body.field_errors.map((e) => e.message).join(' / ');
			} else {
				fail(err);
			}
		} finally {
			busy = false;
			void load();
		}
	}

	function targetLabel(e: TimeEntry): string {
		if (e.projectId !== null) return `${e.projectCode ?? ''} ${e.projectName ?? ''}`.trim();
		return m['time.activityLabel']({ name: e.activityName ?? '' });
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.approvals']()} description={m['approvals.description']()} />

	{#if !available}
		<EmptyState title={m['time.demoUnavailable']()} />
	{:else if isForbiddenError(loadError)}
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
	{:else if !entries}
		<LoadingState label={m['common.loading']()} />
	{:else if entries.length === 0}
		<EmptyState title={m['approvals.empty']()} description={m['approvals.emptyDesc']()} />
	{:else}
		<section class="panel">
			<div class="list-head">
				<p class="note">
					{m['approvals.summary']({ count: entries.length, total: formatMinutes(totalMinutes) })}
				</p>
				{#if canWrite}
					<button
						type="button"
						class="banto-btn banto-btn--primary"
						disabled={busy || returning !== null || approvable.length === 0}
						onclick={() => void approveAll()}
					>
						{m['approvals.approveAll']({ count: approvable.length })}
					</button>
				{/if}
			</div>
			{#if rateMissingCount > 0}
				<div class="warnings" role="note">
					<p>{m['approvals.rateMissingNotice']({ count: rateMissingCount })}</p>
					<p><a href={resolve('calc-basis')}>{m['approvals.rateMissingLink']()}</a></p>
				</div>
			{/if}
			<div class="table-wrap">
				<table>
					<caption class="sr-only">{m['nav.approvals']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['approvals.colPerson']()}</th>
							<th scope="col">{m['time.colDate']()}</th>
							<th scope="col">{m['time.colTarget']()}</th>
							<th scope="col">{m['time.fieldPhase']()}</th>
							<th scope="col" class="num">{m['time.colMinutes']()}</th>
							<th scope="col">{m['time.fieldDescription']()}</th>
							<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
						</tr>
					</thead>
					<tbody>
						{#each entries as e (e.id)}
							<tr>
								<td>{e.userName}</td>
								<td>{dayLabel(e.workDate)}</td>
								<td>{targetLabel(e)}</td>
								<td>
									{e.phaseName ?? ''}
									{#if e.reworkKind}<div class="sub">{reworkLabel(e.reworkKind)}</div>{/if}
								</td>
								<td class="num">
									{formatMinutes(e.minutes)}
									{#if e.rateMissing}<div class="rate-missing">{m['time.rateMissing']()}</div>{/if}
								</td>
								<td class="wrap">{e.description ?? ''}</td>
								<td>
									{#if canWrite}
										<div class="row-actions">
											<button
												type="button"
												class="banto-btn banto-btn--primary"
												disabled={busy}
												onclick={() => void approve(e)}>{m['approvals.approve']()}</button
											>
											<button
												type="button"
												class="banto-btn banto-btn--secondary"
												disabled={busy}
												onclick={() => startReturn(e)}>{m['approvals.return']()}</button
											>
										</div>
									{/if}
								</td>
							</tr>
							{#if returning === e.id}
								<tr class="return-row">
									<td colspan="7">
										<form
											class="return-form"
											onsubmit={(ev) => {
												ev.preventDefault();
												void sendReturn(e);
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
												onclick={() => (returning = null)}
											>
												{m['common.cancel']()}
											</button>
										</form>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
	{#if available}
		<CorrectionApprovals {canWrite} onPendingChange={(p) => (correctionsPending = p)} />
		<CostApprovals {canWrite} onPendingChange={(p) => (costsPending = p)} />
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

	.list-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--banto-space-2);
	}

	.note {
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

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.sub {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-xs);
	}

	.warnings {
		color: var(--banto-warning-tint-text);
		background: var(--banto-warning-tint);
		border-radius: var(--banto-radius-md);
		padding: var(--banto-space-2) var(--banto-space-3);
		font-size: var(--banto-font-size-sm);
	}

	.warnings p {
		margin: 0;
	}

	.warnings a {
		color: inherit;
	}

	.rate-missing {
		color: var(--banto-warning-tint-text);
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
