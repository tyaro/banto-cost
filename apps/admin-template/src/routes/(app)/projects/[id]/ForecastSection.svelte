<script lang="ts">
	/**
	 * 案件詳細 → 完了見込 (spec §6.5・§6.6・§7.1, T06・T28・T30, banto-cost P5):
	 * the latest adopted version against the confirmed order, the budgets and
	 * the previous version; 見込更新要 when actuals came in after its base date,
	 * an earlier actual was corrected, the forecast rate or the order changed;
	 * the adopted versions; and the draft.
	 *
	 * A draft holds a base date, the planned end, the reason and the remaining
	 * input only (残工数 for labor, それ以外に必要な見込み for the rest). Its
	 * actuals (approved up to the base date) and 発注済み未実績 (the purchase
	 * orders' remainders at that date) come from the server on every read, so
	 * the same cost is never typed in twice. Adopting fixes the set; the
	 * latest actuals stay in their own column and are never added to an old
	 * version's remaining costs.
	 *
	 * Reading needs `ViewProjectAmounts`; drafting is the project manager's
	 * (`ManageProject`), adopting the manager's or accounting's
	 * (`AdoptForecast`). A `forbidden` read hides the section.
	 */
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import { LoadingState, StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import {
		formatPct,
		formatSignedYen,
		formatYen,
		isForbiddenError,
		todayIso
	} from '#lib/banto/costFormat.js';
	import { COST_TYPES, type CostType } from '#lib/banto/budgetAdmin.js';
	import { costTypeLabel, hoursToMinutes, minutesToHours } from '#lib/banto/budgetFormat.js';
	import {
		adoptForecastDraft,
		createForecastDraft,
		deleteForecastDraft,
		getProjectForecast,
		saveForecastDraft,
		type ForecastLineInput,
		type ForecastOverview,
		type ForecastVersion
	} from '#lib/banto/forecastAdmin.js';
	import {
		formatPermille,
		forecastVersionLabel,
		updateReasonLabel
	} from '#lib/banto/forecastFormat.js';
	import { listMasters, type WorkMaster } from '#lib/banto/timeAdmin.js';

	interface Props {
		projectId: number;
		/** The project code, shown in confirmation dialogs. */
		code: string;
		/** May start, edit, save and discard the draft (the project's manager). */
		canEdit: boolean;
		/** May adopt the draft (the manager or accounting). */
		canApprove: boolean;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { projectId, code, canEdit, canApprove, onPendingChange }: Props = $props();

	interface InputRow {
		phaseId: string;
		costType: CostType;
		hours: string;
		amount: string;
	}

	const available = isPipelineAvailable();
	let overview = $state<ForecastOverview | null>(null);
	let loadError = $state<unknown>(null);
	let phases = $state<WorkMaster[]>([]);
	let loadToken = 0;

	let rows = $state<InputRow[]>([]);
	let baseDate = $state('');
	let plannedEnd = $state('');
	let reason = $state('');
	let baseline = $state('');
	let busy = $state(false);
	let errors = $state<Record<string, string>>({});

	const draft = $derived(overview?.draft ?? null);
	const latest = $derived(overview?.latest ?? null);
	const snapshot = () => JSON.stringify({ rows, baseDate, plannedEnd, reason });
	const dirty = $derived(
		draft !== null && JSON.stringify({ rows, baseDate, plannedEnd, reason }) !== baseline
	);

	$effect(() => {
		onPendingChange?.({ dirty, busy });
	});

	function toRows(v: ForecastVersion): InputRow[] {
		return v.inputs.map((l) => ({
			phaseId: l.phaseId === null ? '' : String(l.phaseId),
			costType: l.costType,
			hours: minutesToHours(l.remainingMinutes),
			amount: l.amount === null || l.costType === 'labor' ? '' : String(l.amount)
		}));
	}

	function resetEditor(d: ForecastVersion | null) {
		errors = {};
		rows = d ? toRows(d) : [];
		baseDate = d?.baseDate ?? '';
		plannedEnd = d?.plannedEnd ?? '';
		reason = d?.reason ?? '';
		baseline = snapshot();
	}

	async function load(id: number) {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const got = await getProjectForecast(id);
			if (token !== loadToken) return;
			overview = got;
			resetEditor(got.draft);
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			overview = null;
		}
		try {
			const list = await listMasters('phases');
			if (token === loadToken) phases = list;
		} catch {
			// The phase names already on the lines are enough to read the forecast.
		}
	}

	$effect(() => {
		void load(projectId);
	});

	function phaseOptions(current: string): WorkMaster[] {
		return phases.filter((p) => p.active || String(p.id) === current);
	}

	function phaseName(id: number | null, name: string | null): string {
		if (id === null) return m['budget.noPhase']();
		return name ?? phases.find((p) => p.id === id)?.name ?? `#${id}`;
	}

	function applyServerErrors(fieldErrors: FieldError[]) {
		const next: Record<string, string> = {};
		for (const error of fieldErrors) {
			next[error.field] = next[error.field]
				? `${next[error.field]} / ${error.message}`
				: error.message;
		}
		errors = next;
	}

	function handleError(err: unknown) {
		if (isProviderError(err) && err.body.kind === 'validation') {
			applyServerErrors(err.body.field_errors);
		} else if (isForbiddenError(err)) {
			notify('error', m['forecast.forbiddenEdit']());
		} else {
			notify('error', isProviderError(err) ? err.message : String(err));
		}
	}

	async function run(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		errors = {};
		try {
			await action();
		} catch (err) {
			handleError(err);
		} finally {
			busy = false;
		}
	}

	function startDraft() {
		void run(async () => {
			await createForecastDraft(projectId);
			await load(projectId);
		});
	}

	/** Client-side check of the hours / amounts; the server checks the rest. */
	function build(): ForecastLineInput[] | null {
		const next: Record<string, string> = {};
		const lines = rows.map((r, i) => {
			const labor = r.costType === 'labor';
			let remainingMinutes: number | null = null;
			let amount: number | null = null;
			if (labor) {
				remainingMinutes = hoursToMinutes(r.hours);
				if (remainingMinutes === null || remainingMinutes <= 0) {
					next[`lines.${i}.remainingMinutes`] = m['forecast.errorHours']();
				}
			} else {
				const text = r.amount.trim();
				if (!/^\d+$/.test(text)) next[`lines.${i}.amount`] = m['budget.errorAmount']();
				else amount = Number(text);
			}
			return {
				phaseId: r.phaseId === '' ? null : Number(r.phaseId),
				costType: r.costType,
				remainingMinutes,
				amount
			};
		});
		errors = next;
		return Object.keys(next).length === 0 ? lines : null;
	}

	function save() {
		const d = draft;
		if (!d) return;
		const lines = build();
		if (!lines) return;
		void run(async () => {
			await saveForecastDraft(d.id, {
				baseDate: baseDate.trim(),
				plannedEnd: plannedEnd.trim() === '' ? null : plannedEnd.trim(),
				reason: reason.trim() === '' ? null : reason.trim(),
				lines,
				rowVersion: d.rowVersion
			});
			notify('success', m['forecast.saved']());
			await load(projectId);
		});
	}

	async function adopt() {
		const d = draft;
		if (!d || dirty) return;
		const ok = await confirmAction({
			title: m['forecast.adoptConfirmTitle'](),
			body: m['forecast.adoptConfirm'](),
			details: [
				{ label: m['confirm.project'](), value: code },
				{ label: m['forecast.fieldBaseDate'](), value: d.baseDate },
				{ label: m['forecast.costTotal'](), value: formatYen(d.costTotal) },
				{ label: m['forecast.profit'](), value: formatSignedYen(d.profit) }
			],
			undo: m['forecast.adoptUndo'](),
			confirmLabel: m['forecast.adopt']()
		});
		if (!ok) return;
		void run(async () => {
			const v = await adoptForecastDraft(d.id, d.rowVersion);
			notify('success', m['forecast.adopted']({ version: forecastVersionLabel(v.versionNo) }));
			await load(projectId);
		});
	}

	function discard() {
		const d = draft;
		if (!d) return;
		if (!window.confirm(m['forecast.discardConfirm']())) return;
		void run(async () => {
			await deleteForecastDraft(d.id, d.rowVersion);
			await load(projectId);
		});
	}

	function addLine() {
		rows = [...rows, { phaseId: '', costType: 'labor', hours: '', amount: '' }];
	}

	function removeLine(index: number) {
		rows = rows.filter((_, i) => i !== index);
	}

	const OWNED = new Set(['reason', 'baseDate', 'plannedEnd']);
	/** Field errors no input owns (a stale `rowVersion`, the status, the lines as a whole). */
	const otherErrors = $derived(
		Object.entries(errors)
			.filter(([field]) => !/^lines\.\d+\./.test(field) && !OWNED.has(field))
			.map(([, message]) => message)
	);

	function lineError(i: number): string | null {
		const found = Object.entries(errors)
			.filter(([field]) => field.startsWith(`lines.${i}.`))
			.map(([, message]) => message);
		return found.length > 0 ? found.join(' / ') : null;
	}

	function signClass(v: number | null): string {
		if (v === null) return '';
		return v > 0 ? 'over' : '';
	}

	function lossClass(v: number | null): string {
		return v !== null && v < 0 ? 'over' : '';
	}

	function money(v: number | null): string {
		return v === null ? '—' : formatYen(v);
	}

	const midway = $derived(
		overview !== null && ['ordered', 'in_progress', 'work_done'].includes(overview.projectStatus)
	);
</script>

<section class="forecast" aria-labelledby="forecast-heading">
	<h2 id="forecast-heading">{m['forecast.sectionTitle']()}</h2>
	{#if !available}
		<p class="note">{m['forecast.demoUnavailable']()}</p>
	{:else if isForbiddenError(loadError)}
		<p class="note">{m['forecast.forbidden']()}</p>
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
	{:else if !overview}
		<LoadingState label={m['common.loading']()} />
	{:else}
		<div class="headline">
			<div>
				<span class="label">{m['forecast.orderAmount']()}</span>
				<span class="value">{formatYen(overview.orderAmount)}</span>
			</div>
			<div>
				<span class="label">{m['forecast.currentBudget']()}</span>
				<span class="value">{money(overview.budgetCurrentTotal)}</span>
			</div>
			<div>
				<span class="label"
					>{overview.targetMarginPct === null
						? m['forecast.fundsLabel']()
						: m['forecast.funds']({ pct: formatPct(overview.targetMarginPct) })}</span
				>
				<span class="value"
					>{overview.targetMarginPct === null ? m['cost.unset']() : money(overview.funds)}</span
				>
				{#if overview.targetMarginPct === null}
					<span class="label">{m['forecast.fundsUnsetRate']()}</span>
				{:else if overview.targetMarginOn}
					<span class="label">{m['forecast.fundsRateOn']({ date: overview.targetMarginOn })}</span>
				{:else}
					<span class="label">{m['forecast.fundsRateToday']()}</span>
				{/if}
			</div>
			<div>
				<span class="label">{m['forecast.costTotal']()}</span>
				<span class="value">{money(latest?.costTotal ?? null)}</span>
				{#if latest}
					<span class="label"
						>{forecastVersionLabel(latest.versionNo)} · {m['forecast.baseDateShort']({
							date: latest.baseDate
						})}</span
					>
				{/if}
			</div>
			<div>
				<span class="label">{m['forecast.profit']()}</span>
				<span class="value {lossClass(overview.currentProfit)}"
					>{money(overview.currentProfit)}</span
				>
				<span class="label">{formatPermille(overview.currentProfitRatioPermille)}</span>
			</div>
			<div>
				<span class="label">{m['forecast.overrun']()}</span>
				<span class="value {signClass(overview.currentOverrun)}">
					{overview.currentOverrun === null ? '—' : formatSignedYen(overview.currentOverrun)}
				</span>
			</div>
			<div>
				<span class="label">{m['forecast.changeFromPrevious']()}</span>
				<span class="value {signClass(overview.changeFromPrevious)}">
					{overview.changeFromPrevious === null
						? '—'
						: formatSignedYen(overview.changeFromPrevious)}
				</span>
			</div>
			<div>
				<span class="label">{m['forecast.latestActual']()}</span>
				<span class="value">{formatYen(overview.latestActualTotal)}</span>
			</div>
		</div>
		{#if overview.pendingAddition !== 0}
			<p class="note">
				{m['forecast.pendingAddition']({ amount: formatSignedYen(overview.pendingAddition) })}
			</p>
		{/if}
		{#if midway}
			<p class="note">{m['forecast.midwayNote']()}</p>
		{/if}
		{#if !latest}
			<p class="note">{m['forecast.noAdopted']()}</p>
		{:else if overview.updateReasons.length > 0}
			<div class="update" role="status">
				<StatusBadge variant="warning" label={m['forecast.needsUpdate']()} />
				<span class="warn">
					{m['forecast.needsUpdateDetail']({
						date: latest.baseDate,
						reasons: overview.updateReasons.map(updateReasonLabel).join('・')
					})}
				</span>
			</div>
		{:else}
			<StatusBadge variant="success" label={m['forecast.upToDate']()} />
		{/if}
		{#if latest && !latest.actualComplete}
			<p class="warn">{m['forecast.provisionalVersion']()}</p>
		{/if}

		<div class="table-wrap">
			<table>
				<caption>{m['forecast.comparisonTitle']()}</caption>
				<thead>
					<tr>
						<th scope="col">{m['budget.colCostType']()}</th>
						<th scope="col" class="num">{m['budget.original']()}</th>
						<th scope="col" class="num">{m['budget.current']()}</th>
						<th scope="col" class="num">{m['forecast.colPrevious']()}</th>
						<th scope="col" class="num">{m['forecast.colLatest']()}</th>
						{#if draft}<th scope="col" class="num">{m['forecast.colDraft']()}</th>{/if}
						<th scope="col" class="num">{m['forecast.colLatestActual']()}</th>
					</tr>
				</thead>
				<tbody>
					{#each overview.comparison as r (r.costType)}
						<tr>
							<td>{costTypeLabel(r.costType)}</td>
							<td class="num">{money(r.originalBudget)}</td>
							<td class="num">{money(r.currentBudget)}</td>
							<td class="num">{money(r.previous)}</td>
							<td class="num">{money(r.latest)}</td>
							{#if draft}<td class="num">{money(r.draft)}</td>{/if}
							<td class="num">{formatYen(r.latestActual)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">{m['forecast.comparisonNote']()}</p>

		{#snippet linesTable(v: ForecastVersion, caption: string)}
			<div class="table-wrap">
				<table>
					<caption>{caption}</caption>
					<thead>
						<tr>
							<th scope="col">{m['budget.colPhase']()}</th>
							<th scope="col">{m['budget.colCostType']()}</th>
							<th scope="col" class="num">{m['forecast.colActual']()}</th>
							<th scope="col" class="num">{m['forecast.colCommitted']()}</th>
							<th scope="col" class="num">{m['forecast.colRemainingHours']()}</th>
							<th scope="col" class="num">{m['forecast.colLaborRemaining']()}</th>
							<th scope="col" class="num">{m['forecast.colOtherRemaining']()}</th>
							<th scope="col" class="num">{m['forecast.colRemaining']()}</th>
							<th scope="col" class="num">{m['forecast.colTotal']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each v.lines as l (`${l.phaseId}-${l.costType}`)}
							<tr>
								<td>{phaseName(l.phaseId, l.phaseName)}</td>
								<td>{costTypeLabel(l.costType)}</td>
								<td class="num">{formatYen(l.actual)}</td>
								<td class="num">{formatYen(l.committed)}</td>
								<td class="num">
									{l.remainingMinutes === null ? '—' : minutesToHours(l.remainingMinutes)}
								</td>
								<td class="num">
									{l.costType === 'labor' ? formatYen(l.laborRemaining) : '—'}
								</td>
								<td class="num">{money(l.otherRemaining)}</td>
								<td class="num">{formatYen(l.remaining)}</td>
								<td class="num">{formatYen(l.total)}</td>
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr>
							<th scope="row" colspan="2">{m['forecast.sum']()}</th>
							<td class="num">{formatYen(v.actualTotal)}</td>
							<td class="num">{formatYen(v.committedTotal)}</td>
							<td colspan="3"></td>
							<td class="num">{formatYen(v.remainingTotal)}</td>
							<td class="num">{formatYen(v.costTotal)}</td>
						</tr>
					</tfoot>
				</table>
			</div>
		{/snippet}

		{#if latest && latest.lines.length > 0}
			{@render linesTable(
				latest,
				m['forecast.linesTitle']({
					version: forecastVersionLabel(latest.versionNo),
					date: latest.baseDate
				})
			)}
		{/if}

		{#if overview.history.length > 0}
			<div class="table-wrap">
				<table>
					<caption>{m['forecast.history']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['budget.colVersion']()}</th>
							<th scope="col">{m['forecast.colBaseDate']()}</th>
							<th scope="col" class="num">{m['forecast.colOrder']()}</th>
							<th scope="col" class="num">{m['forecast.colTotal']()}</th>
							<th scope="col" class="num">{m['forecast.colProfit']()}</th>
							<th scope="col" class="num">{m['forecast.colRatio']()}</th>
							<th scope="col">{m['forecast.colReason']()}</th>
							<th scope="col">{m['forecast.colAdoptedBy']()}</th>
							<th scope="col">{m['forecast.colAdoptedAt']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each overview.history as v (v.id)}
							<tr>
								<td>
									{forecastVersionLabel(v.versionNo)}
									{#if !v.actualComplete}<span class="warn">{m['forecast.provisionalShort']()}</span
										>{/if}
								</td>
								<td>{v.baseDate}</td>
								<td class="num">{formatYen(v.orderAmount)}</td>
								<td class="num">{formatYen(v.costTotal)}</td>
								<td class="num {lossClass(v.profit)}">{money(v.profit)}</td>
								<td class="num">{formatPermille(v.profitRatioPermille)}</td>
								<td class="wrap">{v.reason ?? '—'}</td>
								<td>{v.adoptedByName ?? '—'}</td>
								<td>{v.adoptedAt ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<h3>{m['forecast.draftTitle']()}</h3>
		{#if !draft}
			<p class="note">{m['forecast.noDraft']()}</p>
			{#if canEdit && midway}
				<div class="actions">
					<button
						type="button"
						class="banto-btn banto-btn--secondary"
						disabled={busy}
						onclick={startDraft}
					>
						{latest ? m['forecast.startUpdate']() : m['forecast.startFirst']()}
					</button>
				</div>
			{/if}
		{:else}
			<p class="note">
				{m['forecast.draftInfo']({ by: draft.updatedByName ?? '—' })}
			</p>
			{#if draft.rateMissing}
				<p class="warn">{m['forecast.rateMissing']()}</p>
			{/if}
			{#if !draft.actualComplete}
				<p class="warn">
					{m['forecast.actualIncomplete']({
						pending: draft.pendingCount,
						provisional: draft.provisionalCount,
						missing: draft.missingRateCount
					})}
				</p>
			{/if}
			{#each otherErrors as message, i (i)}
				<p class="error" role="alert">{message}</p>
			{/each}
			<div class="fields">
				<label class="field">
					<span>{m['forecast.fieldBaseDate']()}</span>
					<input
						class="banto-input"
						type="date"
						max={todayIso()}
						bind:value={baseDate}
						disabled={!canEdit || busy}
						aria-invalid={errors.baseDate !== undefined}
					/>
					{#if errors.baseDate}<span class="error">{errors.baseDate}</span>{/if}
				</label>
				<label class="field">
					<span>{m['forecast.fieldPlannedEnd']()}</span>
					<input
						class="banto-input"
						type="date"
						bind:value={plannedEnd}
						disabled={!canEdit || busy}
						aria-invalid={errors.plannedEnd !== undefined}
					/>
					{#if errors.plannedEnd}<span class="error">{errors.plannedEnd}</span>{/if}
				</label>
			</div>
			<p class="note">{m['forecast.inputNote']()}</p>
			<div class="table-wrap">
				<table>
					<caption>{m['forecast.inputTitle']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['budget.colPhase']()}</th>
							<th scope="col">{m['budget.colCostType']()}</th>
							<th scope="col" class="num">{m['forecast.colRemainingHours']()}</th>
							<th scope="col" class="num">{m['forecast.colOtherRemaining']()}</th>
							<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row, i (i)}
							<tr>
								<td>
									<select
										class="banto-input"
										bind:value={row.phaseId}
										disabled={!canEdit || busy}
										aria-label={m['budget.colPhase']()}
									>
										<option value="">{m['budget.noPhase']()}</option>
										{#each phaseOptions(row.phaseId) as p (p.id)}
											<option value={String(p.id)}>{p.name}</option>
										{/each}
									</select>
								</td>
								<td>
									<select
										class="banto-input"
										bind:value={row.costType}
										disabled={!canEdit || busy}
										aria-label={m['budget.colCostType']()}
									>
										{#each COST_TYPES as t (t)}
											<option value={t}>{costTypeLabel(t)}</option>
										{/each}
									</select>
								</td>
								<td class="num">
									{#if row.costType === 'labor'}
										<input
											class="banto-input short"
											inputmode="decimal"
											bind:value={row.hours}
											disabled={!canEdit || busy}
											aria-label={m['forecast.colRemainingHours']()}
										/>
									{:else}
										—
									{/if}
								</td>
								<td class="num">
									{#if row.costType === 'labor'}
										—
									{:else}
										<input
											class="banto-input short"
											inputmode="numeric"
											bind:value={row.amount}
											disabled={!canEdit || busy}
											aria-label={m['forecast.colOtherRemaining']()}
										/>
									{/if}
								</td>
								<td>
									{#if canEdit}
										<button
											type="button"
											class="banto-btn banto-btn--ghost"
											disabled={busy}
											onclick={() => removeLine(i)}
										>
											{m['budget.removeLine']()}
										</button>
									{/if}
								</td>
							</tr>
							{#if lineError(i)}
								<tr>
									<td colspan="5" class="error">{lineError(i)}</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
			{@render linesTable(draft, m['forecast.draftLinesTitle']({ date: draft.baseDate }))}
			<p class="note">
				{m['forecast.draftResult']({
					cost: formatYen(draft.costTotal),
					profit: formatYen(draft.profit),
					ratio: formatPermille(draft.profitRatioPermille)
				})}
				{#if dirty}<span class="warn">{m['budget.unsaved']()}</span>{/if}
			</p>
			<label class="field wide">
				<span>{m['forecast.fieldReason']()}</span>
				<textarea
					class="banto-input"
					rows="2"
					bind:value={reason}
					disabled={!canEdit || busy}
					aria-invalid={errors.reason !== undefined}></textarea>
				{#if errors.reason}<span class="error">{errors.reason}</span>{/if}
			</label>
			{#if canEdit || canApprove}
				<div class="actions">
					{#if canEdit}
						<button
							type="button"
							class="banto-btn banto-btn--ghost"
							disabled={busy}
							onclick={addLine}
						>
							{m['budget.addLine']()}
						</button>
						<button
							type="button"
							class="banto-btn banto-btn--primary"
							disabled={busy || !dirty}
							onclick={save}
						>
							{m['common.save']()}
						</button>
					{/if}
					{#if canApprove}
						<button
							type="button"
							class="banto-btn banto-btn--secondary"
							disabled={busy || dirty}
							title={dirty ? m['budget.saveFirst']() : undefined}
							onclick={adopt}
						>
							{m['forecast.adopt']()}
						</button>
					{/if}
					{#if canEdit}
						<button
							type="button"
							class="banto-btn banto-btn--ghost"
							disabled={busy}
							onclick={discard}
						>
							{m['forecast.discard']()}
						</button>
					{/if}
				</div>
			{/if}
		{/if}
	{/if}
</section>

<style>
	.forecast {
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
		align-items: flex-start;
		gap: var(--banto-space-4);
	}

	.headline div {
		display: flex;
		flex-direction: column;
	}

	.update {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.label,
	.note,
	caption {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	caption {
		text-align: left;
		padding-bottom: var(--banto-space-1);
	}

	.value {
		font-size: var(--banto-font-size-lg);
		font-variant-numeric: tabular-nums;
	}

	.warn {
		margin: 0;
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

	.over {
		color: var(--banto-danger);
	}

	.short {
		width: 8rem;
		text-align: right;
	}

	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-3);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
	}

	.field.wide {
		max-width: 40rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-2);
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
