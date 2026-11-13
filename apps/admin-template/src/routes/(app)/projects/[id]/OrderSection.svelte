<script lang="ts">
	/**
	 * 受注・売上 (spec §3.1 / §5.5, banto-cost P3b) on the project detail page.
	 *
	 * - Before the order: the 受注転換 form (ConversionForm.svelte, T23 / T24).
	 * - After: the confirmed amount (= conversion + APPROVED changes), the
	 *   pending changes (未確定追加売上, never added to it), recognized revenue
	 *   and the unrecognized remainder; the revenue plan with what each line
	 *   has had cleared (T26); order changes with approve / reject; revenue
	 *   recognitions with cancel.
	 *
	 * Access is decided by the server (design 第2章): reading needs
	 * `ViewProjectAmounts`, conversion / changes / re-planning `EditOrder`,
	 * decisions `Approve` (self-approval allowed for this one-person company,
	 * audited), recognitions `finance.close`. A refusal is shown as a
	 * notification; nothing is hidden on a guess of the caller's capabilities.
	 */
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import { StatusBadge, LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import {
		cancelOrderConversion,
		cancelRecognition,
		decideOrderChange,
		getOrder,
		recordRecognition,
		replaceRevenuePlan,
		requestOrderChange,
		type OrderChangeRow,
		type OrderSummary,
		type RecognitionRow
	} from '#lib/banto/ordersAdmin.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import {
		cancelBlockerLabel,
		changeStatusLabel,
		formatSignedYen,
		formatYen,
		isForbiddenError,
		revenueIssueLabel,
		statusLabel
	} from '#lib/banto/costFormat.js';
	import ConversionForm from './ConversionForm.svelte';
	import PlanLinesEditor, {
		newPlanLine,
		parsePlanLines,
		type PlanLineDraft
	} from './PlanLinesEditor.svelte';

	interface Props {
		projectId: number;
		code: string;
		/** The project's status as the page loaded it. */
		status: string;
		rowVersion: number;
		canWrite: boolean;
		/** The project changed (conversion): the page reloads its form. */
		onProjectChanged: () => void;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { projectId, code, status, rowVersion, canWrite, onProjectChanged, onPendingChange }: Props =
		$props();

	const available = isPipelineAvailable();
	const CONVERTIBLE = ['lead', 'quoting', 'negotiating', 'on_hold'];
	const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

	let summary = $state<OrderSummary | null>(null);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	const forbidden = $derived(isForbiddenError(loadError));

	let converting = $state(false);
	let conversionPending = $state({ dirty: false, busy: false });
	let busy = $state(false);

	// 売上予定の組み替え
	let replanning = $state(false);
	let replanLines = $state<PlanLineDraft[]>([]);
	let replanError = $state('');

	// 受注変更の登録
	let changeDelta = $state('');
	let changeMonth = $state('');
	let changeUndated = $state(false);
	let changeBasis = $state('');
	let changeErrors = $state<Record<string, string>>({});

	// 受注転換の取消 (T40)
	let cancelReason = $state('');
	let cancelReasonMissing = $state(false);

	// 売上計上
	let recognizedOn = $state('');
	let recognitionAmount = $state('');
	let recognitionBasis = $state('');
	let recognitionErrors = $state<Record<string, string>>({});

	const formsDirty = $derived(
		replanning ||
			changeDelta !== '' ||
			changeBasis !== '' ||
			recognitionAmount !== '' ||
			recognitionBasis !== '' ||
			cancelReason !== ''
	);
	$effect(() => {
		onPendingChange?.({
			dirty: formsDirty || (converting && conversionPending.dirty),
			busy: busy || conversionPending.busy
		});
	});

	async function reload() {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const result = await getOrder(projectId);
			if (token === loadToken) summary = result;
		} catch (err) {
			if (token === loadToken) {
				loadError = err;
				summary = null;
			}
		}
	}

	$effect(() => {
		untrack(() => void reload());
	});

	function errorMap(fieldErrors: FieldError[]): Record<string, string> {
		const next: Record<string, string> = {};
		for (const error of fieldErrors) {
			next[error.field] = next[error.field]
				? `${next[error.field]} / ${error.message}`
				: error.message;
		}
		return next;
	}

	/** Run a write; validation errors go to `onValidation`, others to a notification. */
	async function write(
		action: () => Promise<OrderSummary>,
		success: string,
		onValidation?: (errors: Record<string, string>) => void
	): Promise<boolean> {
		if (busy) return false;
		busy = true;
		try {
			summary = await action();
			notify('success', success);
			return true;
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation' && onValidation) {
				onValidation(errorMap(err.body.field_errors));
			} else if (isProviderError(err) && err.body.kind === 'validation') {
				notify('error', err.body.field_errors.map((e) => e.message).join(' / '));
			} else if (isForbiddenError(err)) {
				notify('error', m['orders.forbiddenAction']());
			} else {
				notify('error', isProviderError(err) ? err.message : String(err));
			}
			return false;
		} finally {
			busy = false;
		}
	}

	function startReplan() {
		if (!summary) return;
		replanLines = summary.plan
			.filter((row) => row.open !== 0)
			.map((row) => newPlanLine(row.month ?? '', String(row.open), row.month === null));
		if (replanLines.length === 0) replanLines = [newPlanLine()];
		replanError = '';
		replanning = true;
	}

	async function saveReplan() {
		if (!summary) return;
		const lines = parsePlanLines(replanLines);
		if (lines === null) {
			replanError = m['orders.errorPlanLines']();
			return;
		}
		const revenueVersion = summary.revenueVersion;
		const ok = await write(
			() => replaceRevenuePlan(projectId, { revenueVersion, lines }),
			m['orders.replanned'](),
			(errors) => (replanError = Object.values(errors).join(' / '))
		);
		if (ok) replanning = false;
	}

	async function submitChange() {
		const next: Record<string, string> = {};
		const delta = Number(changeDelta.trim());
		if (changeDelta.trim() === '' || !Number.isInteger(delta) || delta === 0) {
			next.deltaAmount = m['orders.errorDelta']();
		}
		if (!changeUndated && !MONTH_RE.test(changeMonth.trim())) {
			next.planMonth = m['pipeline.errorMonthFormat']();
		}
		if (changeBasis.trim() === '') next.basis = m['orders.errorBasisRequired']();
		changeErrors = next;
		if (Object.keys(next).length > 0) return;
		const ok = await write(
			() =>
				requestOrderChange(projectId, {
					deltaAmount: delta,
					planMonth: changeUndated ? null : changeMonth.trim(),
					basis: changeBasis.trim()
				}),
			m['orders.changeRequested'](),
			(errors) => (changeErrors = errors)
		);
		if (ok) {
			changeDelta = '';
			changeMonth = '';
			changeUndated = false;
			changeBasis = '';
		}
	}

	async function decide(change: OrderChangeRow, approve: boolean) {
		let note: string | null = null;
		if (approve) {
			const ok = await confirmAction({
				title: m['orders.approveConfirmTitle'](),
				body: m['orders.approveConfirm']({ no: change.changeNo }),
				details: [
					{ label: m['confirm.project'](), value: code },
					{ label: m['orders.fieldDelta'](), value: formatSignedYen(change.deltaAmount) },
					{ label: m['pipeline.planMonth'](), value: monthLabel(change.planMonth) }
				],
				undo: m['orders.approveUndo'](),
				confirmLabel: m['orders.approve']()
			});
			if (!ok) return;
		} else {
			note = window.prompt(m['orders.rejectPrompt']({ no: change.changeNo }));
			if (note === null) return;
		}
		await write(
			() => decideOrderChange(projectId, change.id, { approve, note }),
			approve ? m['orders.changeApproved']() : m['orders.changeRejected']()
		);
	}

	async function submitRecognition() {
		const next: Record<string, string> = {};
		if (!/^\d{4}-\d{2}-\d{2}$/.test(recognizedOn)) next.recognizedOn = m['orders.errorDate']();
		const amount = Number(recognitionAmount.trim());
		if (recognitionAmount.trim() === '' || !Number.isInteger(amount) || amount <= 0) {
			next.amount = m['orders.errorPositiveAmount']();
		}
		recognitionErrors = next;
		if (Object.keys(next).length > 0) return;
		const ok = await write(
			() =>
				recordRecognition(projectId, {
					recognizedOn,
					amount,
					basis: recognitionBasis.trim() === '' ? null : recognitionBasis.trim()
				}),
			m['orders.recognized'](),
			(errors) => (recognitionErrors = errors)
		);
		if (ok) {
			recognitionAmount = '';
			recognitionBasis = '';
		}
	}

	async function cancel(row: RecognitionRow) {
		const reason = window.prompt(m['orders.cancelPrompt']({ date: row.recognizedOn }));
		if (reason === null) return;
		await write(
			() => cancelRecognition(projectId, row.id, reason),
			m['orders.recognitionCancelled']()
		);
	}

	/** 受注転換の取消 (T40): back to the status before the conversion, with a reason. */
	async function cancelConversion() {
		const conversion = summary?.conversion;
		if (!summary || !conversion || busy) return;
		const reason = cancelReason.trim();
		cancelReasonMissing = reason === '';
		if (cancelReasonMissing) return;
		const ok = await confirmAction({
			title: m['orders.cancelConversionTitle'](),
			body: m['orders.cancelConversionConfirm']({
				status: statusLabel(conversion.previousStatus)
			}),
			details: [
				{ label: m['confirm.project'](), value: code },
				{ label: m['orders.fieldConvertedOn'](), value: conversion.convertedOn },
				{ label: m['orders.convertedAmount'](), value: formatYen(conversion.confirmedAmount) },
				{ label: m['confirm.reason'](), value: reason }
			],
			undo: m['orders.cancelConversionUndo'](),
			confirmLabel: m['orders.cancelConversionSubmit'](),
			danger: true
		});
		if (!ok) return;
		const done = await write(
			() => cancelOrderConversion(projectId, { rowVersion, reason }),
			m['orders.conversionCancelled']()
		);
		if (done) {
			cancelReason = '';
			onProjectChanged();
		}
	}

	function monthLabel(month: string | null): string {
		return month ?? m['pipeline.timeUndecided']();
	}
</script>

<section class="orders" aria-labelledby="orders-heading">
	<h2 id="orders-heading">{m['orders.sectionTitle']()}</h2>

	{#if !available}
		<p class="note">{m['pipeline.demoUnavailable']()}</p>
	{:else if forbidden}
		<p class="note">{m['orders.sectionForbidden']()}</p>
	{:else if loadError}
		<p class="error" role="alert">
			{isProviderError(loadError) ? loadError.message : String(loadError)}
		</p>
		<button type="button" class="banto-btn banto-btn--secondary" onclick={() => void reload()}>
			{m['common.reload']()}
		</button>
	{:else if !summary}
		<LoadingState label={m['common.loading']()} />
	{:else}
		{#if summary.parentProjectId !== null}
			<p class="note">
				{m['orders.remainderOf']()}
				<a href={resolve(`projects/${summary.parentProjectId}`)}>{summary.parentCode}</a>
			</p>
		{/if}

		{#if summary.conversion === null}
			{#if !CONVERTIBLE.includes(status)}
				<p class="note">{m['orders.notConvertible']({ status: statusLabel(status) })}</p>
			{:else if converting}
				<ConversionForm
					{projectId}
					{rowVersion}
					{code}
					onConverted={() => {
						// The form is unmounted before its effect reports the end of
						// the save, so its last report (busy) would stay behind.
						conversionPending = { dirty: false, busy: false };
						converting = false;
						onProjectChanged();
						void reload();
					}}
					onCancel={() => {
						conversionPending = { dirty: false, busy: false };
						converting = false;
					}}
					onPendingChange={(pending) => (conversionPending = pending)}
				/>
			{:else}
				<p class="note">{m['orders.beforeOrder']()}</p>
				{#if canWrite}
					<button
						type="button"
						class="banto-btn banto-btn--primary convert"
						onclick={() => (converting = true)}
					>
						{m['orders.startConversion']()}
					</button>
				{/if}
			{/if}
		{:else}
			{@const conversion = summary.conversion}
			<section class="tiles" aria-label={m['orders.totalsTitle']()}>
				<div class="tile">
					<span class="tile-label">{m['orders.confirmedAmount']()}</span>
					<span class="tile-value">{formatYen(summary.confirmedAmount)}</span>
				</div>
				<div class="tile">
					<span class="tile-label">{m['orders.pendingTotal']()}</span>
					<span class="tile-value">{formatSignedYen(summary.pendingTotal)}</span>
				</div>
				<div class="tile">
					<span class="tile-label">{m['orders.recognizedTotal']()}</span>
					<span class="tile-value">{formatYen(summary.recognizedTotal)}</span>
				</div>
				<div class="tile">
					<span class="tile-label">{m['orders.remaining']()}</span>
					<span class="tile-value">{formatYen(summary.remaining)}</span>
				</div>
			</section>
			<p class="note">{m['orders.totalsNote']()}</p>
			{#if summary.issues.length > 0}
				<div class="badges" role="alert">
					{#each summary.issues as issue (issue)}
						<StatusBadge variant="warning" label={revenueIssueLabel(issue)} />
					{/each}
				</div>
			{/if}

			<dl class="conversion">
				<div>
					<dt>{m['orders.fieldConvertedOn']()}</dt>
					<dd>{conversion.convertedOn}</dd>
				</div>
				<div>
					<dt>{m['orders.convertedAmount']()}</dt>
					<dd>{formatYen(conversion.confirmedAmount)}</dd>
				</div>
				<div>
					<dt>{m['orders.fieldScope']()}</dt>
					<dd>
						{conversion.scope === 'partial' ? m['orders.scopePartial']() : m['orders.scopeWhole']()}
						{#if conversion.remainderProjectId !== null}
							(<a href={resolve(`projects/${conversion.remainderProjectId}`)}
								>{conversion.remainderCode}</a
							>)
						{/if}
					</dd>
				</div>
				<div>
					<dt>{m['orders.previousStatus']()}</dt>
					<dd>
						{statusLabel(conversion.previousStatus)}
						{#if conversion.sourceVersionNo !== null}
							/ {m['pipeline.versionNo']({ no: conversion.sourceVersionNo })}
						{/if}
					</dd>
				</div>
				<div class="wide">
					<dt>{m['orders.fieldBasis']()}</dt>
					<dd>{conversion.basis}</dd>
				</div>
			</dl>

			{#if canWrite}
				<details class="cancel-conversion">
					<summary>{m['orders.cancelConversionTitle']()}</summary>
					<p class="note">{m['orders.cancelConversionDesc']()}</p>
					{#if summary.cancelBlockers.length > 0}
						<p class="note">{m['orders.cancelBlocked']()}</p>
						<ul class="blockers">
							{#each summary.cancelBlockers as blocker (blocker)}
								<li>{cancelBlockerLabel(blocker)}</li>
							{/each}
						</ul>
					{:else}
						<form
							class="inline-form"
							novalidate
							onsubmit={(event) => {
								event.preventDefault();
								void cancelConversion();
							}}
						>
							<label class="field grow">
								<span>{m['orders.cancelConversionReason']()}</span>
								<input
									class="banto-input"
									type="text"
									maxlength="1000"
									placeholder={m['orders.cancelConversionReasonPlaceholder']()}
									bind:value={cancelReason}
									disabled={busy}
								/>
								{#if cancelReasonMissing}<span class="error"
										>{m['orders.cancelConversionReasonRequired']()}</span
									>{/if}
							</label>
							<button type="submit" class="banto-btn banto-btn--danger" disabled={busy}>
								{m['orders.cancelConversionSubmit']()}
							</button>
						</form>
					{/if}
				</details>
			{/if}

			<h3>{m['orders.orderedPlanTitle']()}</h3>
			{#if replanning}
				<PlanLinesEditor
					bind:lines={replanLines}
					legend={m['orders.replanTitle']()}
					description={m['orders.replanDesc']()}
					target={summary.remaining}
					disabled={busy}
					error={replanError}
				/>
				<div class="actions">
					<button
						type="button"
						class="banto-btn banto-btn--ghost"
						disabled={busy}
						onclick={() => (replanning = false)}
					>
						{m['common.cancel']()}
					</button>
					<button
						type="button"
						class="banto-btn banto-btn--primary"
						disabled={busy}
						onclick={() => void saveReplan()}
					>
						{m['common.save']()}
					</button>
				</div>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">{m['pipeline.planMonth']()}</th>
								<th scope="col" class="num">{m['orders.colPlanned']()}</th>
								<th scope="col" class="num">{m['orders.colCleared']()}</th>
								<th scope="col" class="num">{m['orders.colOpen']()}</th>
							</tr>
						</thead>
						<tbody>
							{#each summary.plan as row (row.id)}
								<tr>
									<td>{monthLabel(row.month)}</td>
									<td class="num">{formatYen(row.amount)}</td>
									<td class="num">{formatYen(row.cleared)}</td>
									<td class="num">{formatYen(row.open)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if canWrite}
					<button
						type="button"
						class="banto-btn banto-btn--secondary inline"
						disabled={busy}
						onclick={startReplan}
					>
						{m['orders.replan']()}
					</button>
				{/if}
			{/if}

			<h3>{m['orders.changesTitle']()}</h3>
			<p class="note">{m['orders.changesDesc']()}</p>
			{#if summary.changes.length > 0}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">{m['orders.colChangeNo']()}</th>
								<th scope="col" class="num">{m['orders.fieldDelta']()}</th>
								<th scope="col">{m['pipeline.planMonth']()}</th>
								<th scope="col">{m['orders.colStatus']()}</th>
								<th scope="col">{m['orders.fieldBasis']()}</th>
								<th scope="col">{m['orders.colRequested']()}</th>
								<th scope="col">{m['orders.colDecided']()}</th>
								{#if canWrite}
									<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
								{/if}
							</tr>
						</thead>
						<tbody>
							{#each summary.changes as change (change.id)}
								<tr>
									<td>{change.changeNo}</td>
									<td class="num">{formatSignedYen(change.deltaAmount)}</td>
									<td>{monthLabel(change.planMonth)}</td>
									<td>
										<StatusBadge
											variant={change.status === 'approved'
												? 'success'
												: change.status === 'pending'
													? 'warning'
													: 'neutral'}
											label={changeStatusLabel(change.status)}
										/>
									</td>
									<td class="wrap">{change.basis}</td>
									<td>
										<div>{change.requestedByName ?? m['cost.unset']()}</div>
										<div class="sub">{change.requestedAt}</div>
									</td>
									<td>
										{#if change.decidedAt}
											<div>{change.decidedByName ?? m['cost.unset']()}</div>
											<div class="sub">{change.decidedAt}</div>
											{#if change.decisionNote}<div class="sub wrap">
													{change.decisionNote}
												</div>{/if}
										{/if}
									</td>
									{#if canWrite}
										<td>
											{#if change.status === 'pending'}
												<div class="row-actions">
													<button
														type="button"
														class="banto-btn banto-btn--secondary"
														disabled={busy}
														onclick={() => void decide(change, true)}
													>
														{m['orders.approve']()}
													</button>
													<button
														type="button"
														class="banto-btn banto-btn--ghost"
														disabled={busy}
														onclick={() => void decide(change, false)}
													>
														{m['orders.reject']()}
													</button>
												</div>
											{/if}
										</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
			{#if canWrite}
				<form
					class="inline-form"
					novalidate
					onsubmit={(event) => {
						event.preventDefault();
						void submitChange();
					}}
				>
					<label class="field">
						<span>{m['orders.fieldDelta']()}</span>
						<input
							class="banto-input"
							type="text"
							inputmode="numeric"
							bind:value={changeDelta}
							disabled={busy}
						/>
						{#if changeErrors.deltaAmount}<span class="error">{changeErrors.deltaAmount}</span>{/if}
					</label>
					<label class="field">
						<span>{m['pipeline.planMonth']()}</span>
						<input
							class="banto-input"
							type="month"
							placeholder="YYYY-MM"
							bind:value={changeMonth}
							disabled={busy || changeUndated}
						/>
						{#if changeErrors.planMonth}<span class="error">{changeErrors.planMonth}</span>{/if}
					</label>
					<label class="check">
						<input type="checkbox" bind:checked={changeUndated} disabled={busy} />
						{m['pipeline.timeUndecided']()}
					</label>
					<label class="field grow">
						<span>{m['orders.fieldBasis']()}</span>
						<input
							class="banto-input"
							type="text"
							maxlength="1000"
							bind:value={changeBasis}
							disabled={busy}
						/>
						{#if changeErrors.basis}<span class="error">{changeErrors.basis}</span>{/if}
					</label>
					<button type="submit" class="banto-btn banto-btn--secondary" disabled={busy}>
						{m['orders.requestChange']()}
					</button>
				</form>
			{/if}

			<h3>{m['orders.recognitionsTitle']()}</h3>
			<p class="note">{m['orders.recognitionsDesc']()}</p>
			{#if summary.recognitions.length > 0}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">{m['orders.fieldRecognizedOn']()}</th>
								<th scope="col" class="num">{m['orders.fieldRecognitionAmount']()}</th>
								<th scope="col">{m['orders.colClears']()}</th>
								<th scope="col">{m['orders.fieldBasis']()}</th>
								<th scope="col">{m['orders.colRecorded']()}</th>
								<th scope="col">{m['orders.colStatus']()}</th>
								{#if canWrite}
									<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
								{/if}
							</tr>
						</thead>
						<tbody>
							{#each summary.recognitions as row (row.id)}
								<tr class:cancelled={row.cancelledAt !== null}>
									<td>{row.recognizedOn}</td>
									<td class="num">{formatYen(row.amount)}</td>
									<td>
										{#each row.clears as clear (clear.planId)}
											<div class="sub">{monthLabel(clear.month)}: {formatYen(clear.amount)}</div>
										{/each}
									</td>
									<td class="wrap">{row.basis ?? ''}</td>
									<td>
										<div>{row.recordedByName ?? m['cost.unset']()}</div>
										<div class="sub">{row.recordedAt}</div>
									</td>
									<td>
										{#if row.cancelledAt}
											<StatusBadge variant="neutral" label={m['orders.cancelled']()} />
											<div class="sub">{row.cancelledByName ?? ''} {row.cancelledAt}</div>
											<div class="sub wrap">{row.cancelReason ?? ''}</div>
										{:else}
											<StatusBadge variant="success" label={m['orders.active']()} />
										{/if}
									</td>
									{#if canWrite}
										<td>
											{#if !row.cancelledAt}
												<button
													type="button"
													class="banto-btn banto-btn--ghost"
													disabled={busy}
													onclick={() => void cancel(row)}
												>
													{m['orders.cancelRecognition']()}
												</button>
											{/if}
										</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
			{#if canWrite}
				<form
					class="inline-form"
					novalidate
					onsubmit={(event) => {
						event.preventDefault();
						void submitRecognition();
					}}
				>
					<label class="field">
						<span>{m['orders.fieldRecognizedOn']()}</span>
						<input class="banto-input" type="date" bind:value={recognizedOn} disabled={busy} />
						{#if recognitionErrors.recognizedOn}<span class="error"
								>{recognitionErrors.recognizedOn}</span
							>{/if}
					</label>
					<label class="field">
						<span>{m['orders.fieldRecognitionAmount']()}</span>
						<input
							class="banto-input"
							type="text"
							inputmode="numeric"
							bind:value={recognitionAmount}
							disabled={busy}
						/>
						{#if recognitionErrors.amount}<span class="error">{recognitionErrors.amount}</span>{/if}
					</label>
					<label class="field grow">
						<span>{m['orders.fieldBasis']()}</span>
						<input
							class="banto-input"
							type="text"
							maxlength="1000"
							bind:value={recognitionBasis}
							disabled={busy}
						/>
					</label>
					<button type="submit" class="banto-btn banto-btn--secondary" disabled={busy}>
						{m['orders.recordRecognition']()}
					</button>
				</form>
			{/if}
		{/if}

		{#if summary.cancelledConversions.length > 0}
			<h3>{m['orders.cancelledConversionsTitle']()}</h3>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">{m['orders.fieldConvertedOn']()}</th>
							<th scope="col" class="num">{m['orders.convertedAmount']()}</th>
							<th scope="col">{m['orders.previousStatus']()}</th>
							<th scope="col">{m['orders.colCancelledOn']()}</th>
							<th scope="col">{m['orders.colCancelReason']()}</th>
							<th scope="col">{m['orders.colCancelledBy']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each summary.cancelledConversions as row (row.id)}
							<tr>
								<td>{row.convertedOn}</td>
								<td class="num">{formatYen(row.confirmedAmount)}</td>
								<td>{statusLabel(row.previousStatus)}</td>
								<td>{row.cancelledOn}</td>
								<td>{row.cancelReason}</td>
								<td>{row.cancelledByName ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</section>

<style>
	.orders {
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
		font-size: var(--banto-font-size-md);
	}

	.note,
	.sub {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: var(--banto-space-3);
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		padding: var(--banto-space-3);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.tile-label {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.tile-value {
		font-size: var(--banto-font-size-lg);
		font-variant-numeric: tabular-nums;
	}

	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-1);
	}

	.conversion {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-4);
		margin: 0;
	}

	.conversion dt {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.conversion dd {
		margin: 0;
	}

	.conversion .wide {
		flex-basis: 100%;
	}

	.table-wrap {
		overflow-x: auto;
	}

	.cancel-conversion {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		padding: var(--banto-space-2) var(--banto-space-3);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.cancel-conversion summary {
		cursor: pointer;
		font-size: var(--banto-font-size-sm);
	}

	.blockers {
		margin: 0;
		padding-left: var(--banto-space-5);
		font-size: var(--banto-font-size-sm);
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

	td.wrap,
	.sub.wrap {
		white-space: normal;
		min-width: 12rem;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	tr.cancelled td {
		color: var(--banto-text-muted);
	}

	.row-actions {
		display: flex;
		gap: var(--banto-space-1);
	}

	.inline-form {
		display: flex;
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

	.check {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		height: var(--banto-control-height);
		font-size: var(--banto-font-size-sm);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-2);
		justify-content: flex-end;
	}

	.convert,
	.inline {
		align-self: flex-start;
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
