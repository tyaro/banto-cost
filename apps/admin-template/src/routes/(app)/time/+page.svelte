<script lang="ts">
	/**
	 * 工数入力 (spec §6.1 / §9, banto-cost P4b): the caller's own hours for a
	 * week, day by day with the day and week totals. Entries start as drafts
	 * (TimeEntryForm.svelte); a draft or a returned entry can be edited,
	 * deleted or submitted (申請), one at a time or every one of the week.
	 * Submitted and approved entries are read-only here - approval is on
	 * /approvals. An approved entry is corrected by requesting a correction
	 * (訂正, P6b-2, T11: the same form with a reason, approved again by
	 * accounting); the replaced entry stays listed but no longer counts.
	 *
	 * Needs `time.entry` (and, for a project, being one of its members); the
	 * server decides, and a `forbidden` read shows the no-access state. An
	 * approved entry without a rate shows 原価未確定 (T04); an entry not yet
	 * approved whose rate would not resolve shows 単価未登録, with a notice
	 * above the week (review U-1: a warning only, submitting is not stopped).
	 * The rate and cost themselves are not shown here. When the server marks an
	 * entry `canApprove` (the owner may approve it too - single-handed use),
	 * 申請して承認 submits it and approves it at once (review U-2): the same
	 * two operations in a row, each authorized and audited as usual (the
	 * approval as selfApproval). Entries 単価未登録 are left out of the week's
	 * 申請して承認 and asked about one by one. Demo mode has no backend.
	 */
	import { getDataProvider, isProviderError, notify } from '@banto/admin-core';
	import { PageHeader, EmptyState, ErrorState, LoadingState, StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { isForbiddenError, todayIso } from '#lib/banto/costFormat.js';
	import type { Project } from '#lib/banto/resources/projects.js';
	import {
		countsInTotals,
		decideEntry,
		deleteEntry,
		isCorrectable,
		listMasters,
		listOwnEntries,
		submitEntry,
		type TimeEntry,
		type TimeEntrySaved,
		type WorkMaster
	} from '#lib/banto/timeAdmin.js';
	import {
		addDays,
		dayLabel,
		formatMinutes,
		mondayOf,
		reworkLabel,
		timeEntryDetails,
		timeStatusLabel,
		timeStatusVariant,
		warningText,
		weekDates
	} from '#lib/banto/timeFormat.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { failureReason, runEach } from '#lib/banto/bulk.js';
	import TimeEntryForm from './TimeEntryForm.svelte';

	const available = isPipelineAvailable();
	const canWrite = $derived(canWriteResources(sessionStore.role));

	let monday = $state(mondayOf(todayIso()));
	const dates = $derived(weekDates(monday));
	let entries = $state<TimeEntry[] | null>(null);
	/** The Monday `entries` were loaded for; another week's rows are never acted on (PR #16 review). */
	let loadedFor = $state<string | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	const forbidden = $derived(isForbiddenError(loadError));

	let phases = $state<WorkMaster[]>([]);
	let activities = $state<WorkMaster[]>([]);
	let projects = $state<{ id: number; label: string }[]>([]);

	/** `undefined` = no form; `null` = a new entry; otherwise the entry being edited. */
	let formEntry = $state<TimeEntry | null | undefined>(undefined);
	/** The form requests a correction of the approved `formEntry`. */
	let formCorrecting = $state(false);
	let formKey = $state(0);
	let formDate = $state(todayIso());
	let formPending = $state({ dirty: false, busy: false });
	let warnings = $state<string[]>([]);
	let acting = $state(false);
	const guard = guardUnsavedChanges({
		isDirty: () => formEntry !== undefined && formPending.dirty,
		isSaving: () => formPending.busy || acting
	});

	async function load() {
		if (!available) return;
		const token = ++loadToken;
		const week = monday;
		loadError = null;
		try {
			const rows = await listOwnEntries(dates[0], dates[6]);
			if (token !== loadToken) return;
			entries = rows;
			loadedFor = week;
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			entries = null;
		}
	}

	async function loadChoices() {
		if (!available) return;
		try {
			[phases, activities] = await Promise.all([listMasters('phases'), listMasters('activities')]);
		} catch {
			// The entry list reports access problems; the form just has no choices.
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
		void monday;
		void load();
	});
	$effect(() => {
		void loadChoices();
	});

	const byDate = $derived.by(() => {
		const map = new Map<string, TimeEntry[]>();
		for (const d of dates) map.set(d, []);
		for (const e of entries ?? []) map.get(e.workDate)?.push(e);
		return map;
	});
	/**
	 * The week's rows that add up: not replaced, not a returned correction,
	 * and not a correction still waiting (until approved, the entry it would
	 * replace is the one that counts).
	 */
	const inTotals = (e: TimeEntry) =>
		countsInTotals(e) && (e.correctsId === null || e.status === 'approved');
	const counted = $derived((entries ?? []).filter(inTotals));
	/** The week's entries that would be approved as 原価未確定 today (review U-1). */
	const rateMissingCount = $derived((entries ?? []).filter((e) => e.rateMissing === true).length);
	const weekTotal = $derived(counted.reduce((sum, e) => sum + e.minutes, 0));
	/** A returned correction is history: it is requested again, never edited. */
	const editable = (e: TimeEntry) =>
		(e.status === 'draft' || e.status === 'returned') && e.correctsId === null;
	const pendingSubmit = $derived(loadedFor === monday ? (entries ?? []).filter(editable) : []);
	/** The owner may approve some of the week's drafts: offer 申請して承認 (review U-2). */
	const offersApprove = $derived(pendingSubmit.some((e) => e.canApprove === true));
	/** The week's 申請して承認 leaves out entries without a rate (asked one by one). */
	const pendingApprove = $derived(
		pendingSubmit.filter((e) => e.canApprove === true && e.rateMissing !== true)
	);
	const approveExcluded = $derived(
		pendingSubmit.filter((e) => e.canApprove === true && e.rateMissing === true).length
	);
	const statusTotals = $derived.by(() => {
		const totals: Record<string, number> = { draft: 0, returned: 0, submitted: 0, approved: 0 };
		for (const e of counted) totals[e.status] = (totals[e.status] ?? 0) + e.minutes;
		return totals;
	});

	function canLeaveForm(): boolean {
		if (formEntry === undefined) return true;
		if (formPending.busy) return false;
		return !formPending.dirty || window.confirm(m['time.discardConfirm']());
	}

	function openForm(entry: TimeEntry | null, date?: string, correcting = false) {
		if (!canLeaveForm()) return;
		formEntry = entry;
		formCorrecting = correcting && entry !== null;
		formDate = date ?? (dates.includes(todayIso()) ? todayIso() : dates[0]);
		formKey += 1;
		formPending = { dirty: false, busy: false };
		warnings = [];
	}

	function closeForm() {
		formEntry = undefined;
		formPending = { dirty: false, busy: false };
	}

	function moveWeek(days: number | null) {
		if (!canLeaveForm()) return;
		closeForm();
		const next = days === null ? mondayOf(todayIso()) : addDays(monday, days);
		if (next !== monday) entries = null;
		monday = next;
	}

	function onSaved(saved: TimeEntrySaved) {
		warnings = saved.warnings.map(warningText);
		notify(
			'success',
			saved.replayed
				? m['time.savedReplayed']()
				: saved.entry.correctsId !== null
					? m['time.correctionRequested']()
					: m['time.saved']()
		);
		closeForm();
		if (!dates.includes(saved.entry.workDate)) {
			entries = null;
			monday = mondayOf(saved.entry.workDate);
		} else void load();
	}

	function fail(err: unknown) {
		if (isForbiddenError(err)) notify('error', m['time.forbiddenEntry']());
		else notify('error', isProviderError(err) ? err.message : String(err));
	}

	async function submitOne(entry: TimeEntry) {
		if (acting) return;
		acting = true;
		try {
			await submitEntry(entry.id, entry.rowVersion);
			notify('success', m['time.submitted']({ count: 1 }));
		} catch (err) {
			fail(err);
		} finally {
			acting = false;
			void load();
		}
	}

	async function submitWeek() {
		if (acting || pendingSubmit.length === 0) return;
		if (!window.confirm(m['time.submitWeekConfirm']({ count: pendingSubmit.length }))) return;
		acting = true;
		let done = 0;
		try {
			for (const entry of pendingSubmit) {
				await submitEntry(entry.id, entry.rowVersion);
				done += 1;
			}
		} catch (err) {
			fail(err);
		} finally {
			acting = false;
			if (done > 0) notify('success', m['time.submitted']({ count: done }));
			void load();
		}
	}

	/** 申請 then 承認, the two existing operations in a row. */
	async function submitAndApprove(entry: TimeEntry) {
		const submitted = await submitEntry(entry.id, entry.rowVersion);
		await decideEntry(entry.id, { rowVersion: submitted.rowVersion, approve: true });
	}

	function reportApproved(done: number, failed: number, firstError: unknown) {
		if (done > 0) notify('success', m['time.submitApproved']({ count: done }));
		if (failed > 0) {
			const reason = failureReason(firstError, m['approvals.forbidden']());
			notify('error', m['time.submitApproveFailed']({ count: failed, reason }));
		}
	}

	async function submitApproveOne(entry: TimeEntry) {
		if (acting) return;
		// A warning, not a stop (as on /approvals): a missing rate can be right.
		const ok = await confirmAction({
			title: entry.rateMissing
				? m['approvals.rateMissingConfirmTitle']()
				: m['time.submitApproveConfirmTitle'](),
			body: entry.rateMissing
				? m['approvals.rateMissingConfirm']()
				: m['time.submitApproveConfirm'](),
			details: timeEntryDetails(entry),
			undo: m['approvals.approveUndo'](),
			confirmLabel: m['time.submitApprove']()
		});
		if (!ok || acting) return;
		acting = true;
		try {
			const result = await runEach([entry], submitAndApprove);
			reportApproved(result.done, result.failed, result.firstError);
		} finally {
			acting = false;
			void load();
		}
	}

	async function submitApproveWeek() {
		if (acting || pendingApprove.length === 0) return;
		// Act on the entries the dialog counted, not a list reloaded while it was open.
		const rows = pendingApprove;
		const details = [
			{
				label: m['confirm.count'](),
				value: m['confirm.countValue']({ count: rows.length })
			}
		];
		if (approveExcluded > 0) {
			details.push({
				label: m['approvals.excludedLabel'](),
				value: m['time.submitApproveExcluded']({ count: approveExcluded })
			});
		}
		const ok = await confirmAction({
			title: m['time.submitApproveConfirmTitle'](),
			body: m['time.submitApproveWeekConfirm']({ count: rows.length }),
			details,
			undo: m['approvals.approveUndo'](),
			confirmLabel: m['time.submitApproveWeek']({ count: rows.length })
		});
		if (!ok || acting) return;
		acting = true;
		try {
			const result = await runEach(rows, submitAndApprove);
			reportApproved(result.done, result.failed, result.firstError);
		} finally {
			acting = false;
			void load();
		}
	}

	async function remove(entry: TimeEntry) {
		if (acting || !window.confirm(m['time.deleteConfirm']())) return;
		acting = true;
		try {
			await deleteEntry(entry.id, entry.rowVersion);
			if (formEntry && formEntry.id === entry.id) closeForm();
			notify('success', m['time.deleted']());
		} catch (err) {
			fail(err);
		} finally {
			acting = false;
			void load();
		}
	}

	function targetLabel(e: TimeEntry): string {
		if (e.projectId !== null) return `${e.projectCode ?? ''} ${e.projectName ?? ''}`.trim();
		return m['time.activityLabel']({ name: e.activityName ?? '' });
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.time']()} description={m['time.description']()} />

	{#if !available}
		<EmptyState title={m['time.demoUnavailable']()} />
	{:else if forbidden}
		<EmptyState title={m['cost.forbiddenTitle']()} description={m['time.forbiddenDesc']()} />
	{:else}
		<div class="toolbar">
			<div class="week-nav" role="group" aria-label={m['time.weekNav']()}>
				<button type="button" class="banto-btn banto-btn--secondary" onclick={() => moveWeek(-7)}>
					{m['time.prevWeek']()}
				</button>
				<button type="button" class="banto-btn banto-btn--ghost" onclick={() => moveWeek(null)}>
					{m['time.thisWeek']()}
				</button>
				<button type="button" class="banto-btn banto-btn--secondary" onclick={() => moveWeek(7)}>
					{m['time.nextWeek']()}
				</button>
				<span class="week-label">
					{m['time.weekRange']({ from: dayLabel(dates[0]), to: dayLabel(dates[6]) })}
				</span>
			</div>
			{#if canWrite}
				<div class="week-actions">
					<button type="button" class="banto-btn banto-btn--primary" onclick={() => openForm(null)}>
						{m['time.add']()}
					</button>
					<button
						type="button"
						class="banto-btn banto-btn--secondary"
						disabled={acting || pendingSubmit.length === 0}
						onclick={() => void submitWeek()}
					>
						{m['time.submitWeek']({ count: pendingSubmit.length })}
					</button>
					{#if offersApprove}
						<button
							type="button"
							class="banto-btn banto-btn--secondary"
							disabled={acting || pendingApprove.length === 0}
							onclick={() => void submitApproveWeek()}
						>
							{m['time.submitApproveWeek']({ count: pendingApprove.length })}
						</button>
					{/if}
				</div>
			{/if}
		</div>

		{#if rateMissingCount > 0}
			<div class="warnings" role="note">
				<p>{m['time.rateMissingNotice']({ count: rateMissingCount })}</p>
			</div>
		{/if}

		{#if warnings.length > 0}
			<div class="warnings" role="status">
				{#each warnings as w (w)}<p>{w}</p>{/each}
			</div>
		{/if}

		{#if formEntry !== undefined && canWrite}
			<section class="panel">
				{#key formKey}
					<TimeEntryForm
						entry={formEntry}
						correcting={formCorrecting}
						defaultDate={formDate}
						{projects}
						{phases}
						{activities}
						{onSaved}
						onCancel={closeForm}
						onPendingChange={(pending) => (formPending = pending)}
					/>
				{/key}
			</section>
		{/if}

		{#if loadError}
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
		{:else}
			<section class="panel">
				<dl class="totals">
					<div>
						<dt>{m['time.weekTotal']()}</dt>
						<dd>{formatMinutes(weekTotal)}</dd>
					</div>
					{#each ['draft', 'returned', 'submitted', 'approved'] as s (s)}
						<div>
							<dt>{timeStatusLabel(s)}</dt>
							<dd>{formatMinutes(statusTotals[s] ?? 0)}</dd>
						</div>
					{/each}
				</dl>
				<div class="table-wrap">
					<table>
						<caption class="sr-only">{m['nav.time']()}</caption>
						<thead>
							<tr>
								<th scope="col">{m['time.colDate']()}</th>
								<th scope="col">{m['time.colTarget']()}</th>
								<th scope="col">{m['time.fieldPhase']()}</th>
								<th scope="col" class="num">{m['time.colMinutes']()}</th>
								<th scope="col">{m['time.fieldDescription']()}</th>
								<th scope="col">{m['time.colStatus']()}</th>
								<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
							</tr>
						</thead>
						<tbody>
							{#each dates as date (date)}
								{@const rows = byDate.get(date) ?? []}
								{@const dayTotal = rows.filter(inTotals).reduce((sum, e) => sum + e.minutes, 0)}
								<tr class="day">
									<th scope="rowgroup" colspan="3">{dayLabel(date)}</th>
									<td class="num">{formatMinutes(dayTotal)}</td>
									<td colspan="2"></td>
									<td>
										{#if canWrite}
											<button
												type="button"
												class="banto-btn banto-btn--ghost"
												onclick={() => openForm(null, date)}
												aria-label={m['time.addOn']({ day: dayLabel(date) })}
											>
												{m['time.addShort']()}
											</button>
										{/if}
									</td>
								</tr>
								{#each rows as e (e.id)}
									<tr class:not-counted={!inTotals(e)} class:replaced={!countsInTotals(e)}>
										<td></td>
										<td>{targetLabel(e)}</td>
										<td>
											{e.phaseName ?? ''}
											{#if e.reworkKind}<div class="sub">{reworkLabel(e.reworkKind)}</div>{/if}
										</td>
										<td class="num">{formatMinutes(e.minutes)}</td>
										<td class="wrap">
											{e.description ?? ''}
											{#if e.correctsId !== null && e.correctionReason}
												<div class="sub">
													{m['time.correctionReason']({ reason: e.correctionReason })}
												</div>
											{/if}
											{#if e.status === 'returned' && e.returnReason}
												<div class="returned">
													{m['time.returnedReason']({ reason: e.returnReason })}
												</div>
											{/if}
										</td>
										<td>
											<StatusBadge
												variant={timeStatusVariant(e.status)}
												label={timeStatusLabel(e.status)}
											/>
											{#if e.costMissing && e.replacedById === null}
												<div class="sub">{m['time.costMissing']()}</div>
											{:else if e.rateMissing}
												<div class="rate-missing">{m['time.rateMissing']()}</div>
											{/if}
											{#if e.correctsId !== null}
												<div class="sub">{m['time.isCorrection']()}</div>
											{/if}
											{#if e.replacedById !== null}
												<div class="sub">{m['time.replaced']()}</div>
											{:else if e.correctionPending}
												<div class="sub">{m['time.correctionPending']()}</div>
											{/if}
										</td>
										<td>
											{#if canWrite && editable(e)}
												<div class="row-actions">
													<button
														type="button"
														class="banto-btn banto-btn--ghost"
														disabled={acting}
														onclick={() => openForm(e)}>{m['time.edit']()}</button
													>
													<button
														type="button"
														class="banto-btn banto-btn--secondary"
														disabled={acting}
														onclick={() => void submitOne(e)}>{m['time.submit']()}</button
													>
													{#if e.canApprove}
														<button
															type="button"
															class="banto-btn banto-btn--secondary"
															disabled={acting}
															onclick={() => void submitApproveOne(e)}
															>{m['time.submitApprove']()}</button
														>
													{/if}
													<button
														type="button"
														class="banto-btn banto-btn--ghost"
														disabled={acting}
														onclick={() => void remove(e)}>{m['common.delete']()}</button
													>
												</div>
											{:else if canWrite && isCorrectable(e)}
												<button
													type="button"
													class="banto-btn banto-btn--ghost"
													disabled={acting}
													onclick={() => openForm(e, undefined, true)}>{m['time.correct']()}</button
												>
											{/if}
										</td>
									</tr>
								{/each}
							{/each}
						</tbody>
					</table>
				</div>
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

	.toolbar,
	.week-nav,
	.week-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.toolbar {
		justify-content: space-between;
	}

	.week-label {
		font-weight: 600;
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

	.totals {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-4);
		margin: 0;
	}

	.totals div {
		display: flex;
		flex-direction: column;
	}

	.totals dt {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.totals dd {
		margin: 0;
		font-size: var(--banto-font-size-lg);
		font-variant-numeric: tabular-nums;
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

	thead th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	tr.day th,
	tr.day td {
		background: var(--banto-surface-subtle);
		font-weight: 600;
	}

	td.wrap {
		white-space: normal;
		min-width: 12rem;
	}

	tr.not-counted td {
		color: var(--banto-text-muted);
	}

	tr.replaced td.num {
		text-decoration: line-through;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.sub {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-xs);
	}

	.returned,
	.rate-missing {
		color: var(--banto-warning-tint-text);
		font-size: var(--banto-font-size-xs);
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
