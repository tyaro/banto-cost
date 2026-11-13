<script lang="ts">
	/**
	 * 承認一覧 → 工数の訂正 (spec §4 訂正承認 / §11, banto-cost P6b-2, T11):
	 * corrections of approved hours, which accounting (`finance.close`)
	 * approves again. Each row shows the approved entry and the requested
	 * values side by side with the reason. Approving fixes the rate in effect
	 * on the corrected work date and takes the replaced entry out of every
	 * figure; returning (with a reason) leaves the approved entry as it was.
	 * Nobody else gets rows, so the section stays hidden for them.
	 */
	import { isProviderError, notify } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import { isForbiddenError } from '#lib/banto/costFormat.js';
	import {
		decideEntry,
		listPendingCorrections,
		type CorrectionPair,
		type TimeEntry
	} from '#lib/banto/timeAdmin.js';
	import { dayLabel, formatMinutes, reworkLabel } from '#lib/banto/timeFormat.js';

	interface Props {
		canWrite: boolean;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { canWrite, onPendingChange }: Props = $props();

	let pairs = $state<CorrectionPair[] | null>(null);
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
			const rows = await listPendingCorrections();
			if (token !== loadToken) return;
			pairs = rows;
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

	async function approve(c: TimeEntry) {
		if (busy) return;
		// A warning, not a stop (review U-1), as for a first approval.
		if (
			c.rateMissing &&
			!(await confirmAction({
				title: m['approvals.rateMissingConfirmTitle'](),
				body: m['approvals.rateMissingConfirm'](),
				undo: m['approvals.approveUndo'](),
				confirmLabel: m['approvals.approve']()
			}))
		)
			return;
		busy = true;
		try {
			const result = await decideEntry(c.id, { rowVersion: c.rowVersion, approve: true });
			notify(
				'success',
				result.costMissing ? m['approvals.approvedNoRate']() : m['corrections.approved']()
			);
		} catch (err) {
			fail(err);
		} finally {
			busy = false;
			void load();
		}
	}

	function startReturn(c: TimeEntry) {
		if (returning !== null && reason.trim() !== '' && returning !== c.id) {
			if (!window.confirm(m['approvals.discardConfirm']())) return;
		}
		returning = c.id;
		reason = '';
		reasonError = '';
	}

	async function sendReturn(c: TimeEntry) {
		if (busy) return;
		if (reason.trim() === '') {
			reasonError = m['approvals.errorReason']();
			return;
		}
		busy = true;
		try {
			await decideEntry(c.id, { rowVersion: c.rowVersion, approve: false, reason: reason.trim() });
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

	function targetLabel(e: TimeEntry): string {
		if (e.projectId !== null) return `${e.projectCode ?? ''} ${e.projectName ?? ''}`.trim();
		return m['time.activityLabel']({ name: e.activityName ?? '' });
	}

	function phaseLabel(e: TimeEntry): string {
		const phase = e.phaseName ?? '';
		return e.reworkKind ? `${phase} ${reworkLabel(e.reworkKind)}`.trim() : phase;
	}
</script>

{#if loadError}
	<section class="panel" aria-labelledby="correction-approvals-heading">
		<h2 id="correction-approvals-heading">{m['corrections.title']()}</h2>
		<p class="error" role="alert">{loadError}</p>
	</section>
{:else if pairs && pairs.length > 0}
	<section class="panel" aria-labelledby="correction-approvals-heading">
		<h2 id="correction-approvals-heading">{m['corrections.title']()}</h2>
		<p class="note">{m['corrections.description']()}</p>
		<div class="table-wrap">
			<table>
				<caption class="sr-only">{m['corrections.title']()}</caption>
				<thead>
					<tr>
						<th scope="col">{m['approvals.colPerson']()}</th>
						<th scope="col">{m['corrections.colWhich']()}</th>
						<th scope="col">{m['time.colDate']()}</th>
						<th scope="col">{m['time.colTarget']()}</th>
						<th scope="col">{m['time.fieldPhase']()}</th>
						<th scope="col" class="num">{m['time.colMinutes']()}</th>
						<th scope="col">{m['time.fieldDescription']()}</th>
						<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
					</tr>
				</thead>
				<tbody>
					{#each pairs as { correction: c, original: o } (c.id)}
						<tr class="before">
							<td rowspan="3">{c.userName}</td>
							<th scope="row">{m['corrections.before']()}</th>
							<td>{dayLabel(o.workDate)}</td>
							<td>{targetLabel(o)}</td>
							<td>{phaseLabel(o)}</td>
							<td class="num">{formatMinutes(o.minutes)}</td>
							<td class="wrap">
								{o.description ?? ''}
								{#if o.costMissing}<div class="sub">{m['time.costMissing']()}</div>{/if}
							</td>
							<td rowspan="3">
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
						<tr>
							<th scope="row">{m['corrections.after']()}</th>
							<td>{dayLabel(c.workDate)}</td>
							<td>{targetLabel(c)}</td>
							<td>{phaseLabel(c)}</td>
							<td class="num">{formatMinutes(c.minutes)}</td>
							<td class="wrap">
								{c.description ?? ''}
								{#if c.rateMissing}<div class="sub">{m['time.rateMissing']()}</div>{/if}
							</td>
						</tr>
						<tr class="reason">
							<th scope="row">{m['corrections.reason']()}</th>
							<td colspan="5" class="wrap">{c.correctionReason ?? ''}</td>
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

	tr.before td,
	tr.before th {
		border-bottom-style: dashed;
	}

	tr.before td.num {
		text-decoration: line-through;
		color: var(--banto-text-muted);
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
