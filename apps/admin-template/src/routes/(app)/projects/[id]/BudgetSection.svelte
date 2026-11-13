<script lang="ts">
	/**
	 * 案件詳細 → 予算 (spec §5.3, T09, banto-cost P4c): the original budget
	 * (版1), the current approved budget and the actuals side by side by cost
	 * type and by phase × cost type, the approved versions, and the draft.
	 *
	 * A draft starts as a copy of the current budget. Labor lines take planned
	 * hours (amount = hours × the budget rate on the draft's date); the other
	 * cost types take a planned amount. Approving numbers the draft; a change
	 * (版2 on) needs its reason, and approved versions never change. The actuals
	 * are approved hours (labor) and approved direct costs (P4d); either side
	 * still pending or provisional shows 暫定・不足あり.
	 *
	 * Reading needs `ViewProjectAmounts`; drafting is the project manager's
	 * (`ManageProject`), approving the manager's or accounting's
	 * (`ApproveBudget`). A `forbidden` read hides the section.
	 */
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import { LoadingState, StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { formatSignedYen, formatYen, isForbiddenError } from '#lib/banto/costFormat.js';
	import {
		COST_TYPES,
		approveBudgetDraft,
		createBudgetDraft,
		deleteBudgetDraft,
		getProjectBudget,
		saveBudgetDraft,
		type BudgetOverview,
		type BudgetVersion,
		type CostType
	} from '#lib/banto/budgetAdmin.js';
	import {
		costTypeLabel,
		hoursToMinutes,
		minutesToHours,
		versionLabel
	} from '#lib/banto/budgetFormat.js';
	import { listMasters, type WorkMaster } from '#lib/banto/timeAdmin.js';

	interface Props {
		projectId: number;
		canWrite: boolean;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { projectId, canWrite, onPendingChange }: Props = $props();

	interface LineRow {
		phaseId: string;
		costType: CostType;
		hours: string;
		amount: string;
	}

	const available = isPipelineAvailable();
	let overview = $state<BudgetOverview | null>(null);
	let loadError = $state<unknown>(null);
	let phases = $state<WorkMaster[]>([]);
	let loadToken = 0;

	let rows = $state<LineRow[]>([]);
	let reason = $state('');
	let baseline = $state('');
	let busy = $state(false);
	let errors = $state<Record<string, string>>({});

	const draft = $derived(overview?.draft ?? null);
	const dirty = $derived(draft !== null && JSON.stringify({ rows, reason }) !== baseline);

	$effect(() => {
		onPendingChange?.({ dirty, busy });
	});

	function toRows(v: BudgetVersion): LineRow[] {
		return v.lines.map((l) => ({
			phaseId: l.phaseId === null ? '' : String(l.phaseId),
			costType: l.costType,
			hours: minutesToHours(l.plannedMinutes),
			amount: l.amount === null || l.costType === 'labor' ? '' : String(l.amount)
		}));
	}

	function resetEditor(d: BudgetVersion | null) {
		errors = {};
		rows = d ? toRows(d) : [];
		reason = d?.reason ?? '';
		baseline = JSON.stringify({ rows, reason });
	}

	async function load(id: number) {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const got = await getProjectBudget(id);
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
			// The phase names already on the lines are enough to read the budget.
		}
	}

	$effect(() => {
		void load(projectId);
	});

	/** Phases offered for a line: active ones, plus the line's own. */
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
			notify('error', m['budget.forbiddenEdit']());
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
			await createBudgetDraft(projectId);
			await load(projectId);
		});
	}

	/** Client-side check of the hours / amounts; the server checks the rest. */
	function build(): BudgetDraftLines | null {
		const next: Record<string, string> = {};
		const lines = rows.map((r, i) => {
			const labor = r.costType === 'labor';
			let plannedMinutes: number | null = null;
			let amount: number | null = null;
			if (labor) {
				plannedMinutes = hoursToMinutes(r.hours);
				if (plannedMinutes === null || plannedMinutes <= 0) {
					next[`lines.${i}.plannedMinutes`] = m['budget.errorHours']();
				}
			} else {
				const text = r.amount.trim();
				if (!/^\d+$/.test(text)) next[`lines.${i}.amount`] = m['budget.errorAmount']();
				else amount = Number(text);
			}
			return {
				phaseId: r.phaseId === '' ? null : Number(r.phaseId),
				costType: r.costType,
				plannedMinutes,
				amount
			};
		});
		errors = next;
		return Object.keys(next).length === 0 ? lines : null;
	}

	type BudgetDraftLines = {
		phaseId: number | null;
		costType: CostType;
		plannedMinutes: number | null;
		amount: number | null;
	}[];

	function save() {
		const d = draft;
		if (!d) return;
		const lines = build();
		if (!lines) return;
		void run(async () => {
			await saveBudgetDraft(d.id, {
				reason: reason.trim() === '' ? null : reason.trim(),
				lines,
				rowVersion: d.rowVersion
			});
			notify('success', m['budget.saved']());
			await load(projectId);
		});
	}

	async function approve() {
		const d = draft;
		if (!d || dirty) return;
		const ok = await confirmAction({
			title: m['budget.approveConfirmTitle'](),
			body: m['budget.approveConfirm'](),
			undo: m['budget.approveUndo'](),
			confirmLabel: m['budget.approve']()
		});
		if (!ok) return;
		void run(async () => {
			const v = await approveBudgetDraft(d.id, d.rowVersion);
			notify('success', m['budget.approved']({ version: versionLabel(v.versionNo) }));
			await load(projectId);
		});
	}

	function discard() {
		const d = draft;
		if (!d) return;
		if (!window.confirm(m['budget.discardConfirm']())) return;
		void run(async () => {
			await deleteBudgetDraft(d.id, d.rowVersion);
			await load(projectId);
		});
	}

	function addLine() {
		rows = [...rows, { phaseId: '', costType: 'labor', hours: '', amount: '' }];
	}

	function removeLine(index: number) {
		rows = rows.filter((_, i) => i !== index);
	}

	/** Field errors no input owns (a stale `rowVersion`, the status, the lines as a whole). */
	const otherErrors = $derived(
		Object.entries(errors)
			.filter(([field]) => !/^lines\.\d+\./.test(field) && field !== 'reason')
			.map(([, message]) => message)
	);

	function lineError(i: number): string | null {
		const found = Object.entries(errors)
			.filter(([field]) => field.startsWith(`lines.${i}.`))
			.map(([, message]) => message);
		return found.length > 0 ? found.join(' / ') : null;
	}

	function varianceClass(v: number | null): string {
		if (v === null) return '';
		return v > 0 ? 'over' : 'under';
	}
</script>

<section class="budget" aria-labelledby="budget-heading">
	<h2 id="budget-heading">{m['budget.sectionTitle']()}</h2>
	{#if !available}
		<p class="note">{m['budget.demoUnavailable']()}</p>
	{:else if isForbiddenError(loadError)}
		<p class="note">{m['budget.forbidden']()}</p>
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
				<span class="label">{m['budget.original']()}</span>
				<span class="value">{overview.original ? formatYen(overview.original.total) : '—'}</span>
			</div>
			<div>
				<span class="label">{m['budget.current']()}</span>
				<span class="value">{overview.current ? formatYen(overview.current.total) : '—'}</span>
				{#if overview.current}
					<span class="label">{versionLabel(overview.current.versionNo)}</span>
				{/if}
			</div>
			<StatusBadge
				variant={overview.laborActualComplete ? 'success' : 'warning'}
				label={overview.laborActualComplete
					? m['budget.laborActualComplete']()
					: m['budget.laborActualProvisional']()}
			/>
			<StatusBadge
				variant={overview.directActualComplete ? 'success' : 'warning'}
				label={overview.directActualComplete
					? m['budget.directActualComplete']()
					: m['budget.directActualProvisional']()}
			/>
		</div>
		{#if !overview.current}
			<p class="note">{m['budget.noApproved']()}</p>
		{/if}

		<div class="table-wrap">
			<table>
				<caption>{m['budget.byCostType']()}</caption>
				<thead>
					<tr>
						<th scope="col">{m['budget.colCostType']()}</th>
						<th scope="col" class="num">{m['budget.original']()}</th>
						<th scope="col" class="num">{m['budget.current']()}</th>
						<th scope="col" class="num">{m['budget.colActual']()}</th>
						<th scope="col" class="num">{m['budget.colVariance']()}</th>
					</tr>
				</thead>
				<tbody>
					{#each overview.totals as t (t.costType)}
						<tr>
							<td>{costTypeLabel(t.costType)}</td>
							<td class="num">{t.original === null ? '—' : formatYen(t.original)}</td>
							<td class="num">{t.current === null ? '—' : formatYen(t.current)}</td>
							<td class="num">{t.actual === null ? '—' : formatYen(t.actual)}</td>
							<td class="num {varianceClass(t.variance)}">
								{t.variance === null ? '—' : formatSignedYen(t.variance)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">{m['budget.actualNote']()}</p>

		{#if overview.comparison.length > 0}
			<div class="table-wrap">
				<table>
					<caption>{m['budget.byPhase']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['budget.colPhase']()}</th>
							<th scope="col">{m['budget.colCostType']()}</th>
							<th scope="col" class="num">{m['budget.original']()}</th>
							<th scope="col" class="num">{m['budget.current']()}</th>
							<th scope="col" class="num">{m['budget.colActual']()}</th>
							<th scope="col" class="num">{m['budget.colVariance']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each overview.comparison as r (`${r.phaseId}-${r.costType}`)}
							<tr>
								<td>{phaseName(r.phaseId, r.phaseName)}</td>
								<td>{costTypeLabel(r.costType)}</td>
								<td class="num">{r.original === null ? '—' : formatYen(r.original)}</td>
								<td class="num">{r.current === null ? '—' : formatYen(r.current)}</td>
								<td class="num">{r.actual === null ? '—' : formatYen(r.actual)}</td>
								<td class="num {varianceClass(r.variance)}">
									{r.variance === null ? '—' : formatSignedYen(r.variance)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if overview.history.length > 0}
			<div class="table-wrap">
				<table>
					<caption>{m['budget.history']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['budget.colVersion']()}</th>
							<th scope="col" class="num">{m['budget.colTotal']()}</th>
							<th scope="col">{m['budget.colReason']()}</th>
							<th scope="col">{m['budget.colApprovedBy']()}</th>
							<th scope="col">{m['budget.colApprovedAt']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each overview.history as v (v.id)}
							<tr>
								<td>{versionLabel(v.versionNo)}</td>
								<td class="num">{formatYen(v.total)}</td>
								<td class="wrap">{v.reason ?? '—'}</td>
								<td>{v.approvedByName ?? '—'}</td>
								<td>{v.approvedAt ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<h3>{m['budget.draftTitle']()}</h3>
		{#if !draft}
			<p class="note">{m['budget.noDraft']()}</p>
			{#if canWrite}
				<div class="actions">
					<button
						type="button"
						class="banto-btn banto-btn--secondary"
						disabled={busy}
						onclick={startDraft}
					>
						{overview.current ? m['budget.startChange']() : m['budget.startOriginal']()}
					</button>
				</div>
			{/if}
		{:else}
			<p class="note">
				{m['budget.draftInfo']({
					date: draft.createdOn,
					by: draft.updatedByName ?? '—'
				})}
			</p>
			{#if draft.rateMissing}
				<p class="warn">{m['budget.rateMissing']()}</p>
			{/if}
			{#each otherErrors as message, i (i)}
				<p class="error" role="alert">{message}</p>
			{/each}
			<div class="table-wrap">
				<table>
					<caption class="sr-only">{m['budget.draftTitle']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['budget.colPhase']()}</th>
							<th scope="col">{m['budget.colCostType']()}</th>
							<th scope="col" class="num">{m['budget.colHours']()}</th>
							<th scope="col" class="num">{m['budget.colPlannedAmount']()}</th>
							<th scope="col" class="num">{m['budget.colSavedAmount']()}</th>
							<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row, i (i)}
							{@const savedLine = draft.lines[i]}
							<tr>
								<td>
									<select
										class="banto-input"
										bind:value={row.phaseId}
										disabled={!canWrite || busy}
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
										disabled={!canWrite || busy}
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
											disabled={!canWrite || busy}
											aria-label={m['budget.colHours']()}
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
											disabled={!canWrite || busy}
											aria-label={m['budget.colPlannedAmount']()}
										/>
									{/if}
								</td>
								<td class="num">
									{savedLine && savedLine.costType === row.costType
										? formatYen(savedLine.amount)
										: '—'}
								</td>
								<td>
									{#if canWrite}
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
									<td colspan="6" class="error">{lineError(i)}</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
			<p class="note">
				{m['budget.draftTotal']()}: {formatYen(draft.total)}
				{#if dirty}<span class="warn">{m['budget.unsaved']()}</span>{/if}
			</p>
			<label class="field">
				<span>{m['budget.fieldReason']()}</span>
				<textarea
					class="banto-input"
					rows="2"
					bind:value={reason}
					disabled={!canWrite || busy}
					aria-invalid={errors.reason !== undefined}></textarea>
				{#if errors.reason}<span class="error">{errors.reason}</span>{/if}
			</label>
			{#if canWrite}
				<div class="actions">
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
					<button
						type="button"
						class="banto-btn banto-btn--secondary"
						disabled={busy || dirty}
						title={dirty ? m['budget.saveFirst']() : undefined}
						onclick={approve}
					>
						{m['budget.approve']()}
					</button>
					<button
						type="button"
						class="banto-btn banto-btn--ghost"
						disabled={busy}
						onclick={discard}
					>
						{m['budget.discard']()}
					</button>
				</div>
			{/if}
		{/if}
	{/if}
</section>

<style>
	.budget {
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
		align-items: center;
		gap: var(--banto-space-4);
	}

	.headline div {
		display: flex;
		flex-direction: column;
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

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		max-width: 40rem;
		font-size: var(--banto-font-size-sm);
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
