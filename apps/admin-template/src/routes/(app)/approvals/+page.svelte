<script lang="ts">
	/**
	 * 承認一覧 (spec §8 step 4 / §9, banto-cost P4b): submitted hours the
	 * caller may decide - those of the projects they manage
	 * (`project.manage`), or every project and the common activities for
	 * accounting (`finance.close`). Each entry is approved, or returned with
	 * a reason. Approving fixes the hourly rate in effect on the work date
	 * and the labor cost; without a rate the entry is approved as 原価未確定
	 * (T04), never as 0 yen.
	 *
	 * The company runs single-handed, so approving one's own submission is
	 * allowed and recorded in the audit log (design 2.4). The server decides
	 * each entry; nothing the caller may not decide is listed. Demo mode has
	 * no backend.
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
	const guard = guardUnsavedChanges({
		isDirty: () => returning !== null && reason.trim() !== '',
		isSaving: () => busy
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

	const totalMinutes = $derived((entries ?? []).reduce((sum, e) => sum + e.minutes, 0));

	function fail(err: unknown) {
		if (isForbiddenError(err)) notify('error', m['approvals.forbidden']());
		else notify('error', isProviderError(err) ? err.message : String(err));
	}

	async function approve(entry: TimeEntry) {
		if (busy) return;
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
			<p class="note">
				{m['approvals.summary']({ count: entries.length, total: formatMinutes(totalMinutes) })}
			</p>
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
								<td class="num">{formatMinutes(e.minutes)}</td>
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
