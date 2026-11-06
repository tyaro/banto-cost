<script lang="ts">
	/**
	 * 案件見込 (spec §5.4, banto-cost P3a) on the project detail page: the
	 * version history, a form that saves a NEW version (draft, or adopted
	 * directly), and "adopt" on drafts. Versions are append-only - nothing
	 * here edits a saved version, and adopting never rewrites its figures
	 * (banto-cost CLAUDE.md).
	 *
	 * Access: reading needs `ViewProjectAmounts` on the project, saving
	 * `EditPipeline` (design 第2章). A `forbidden` read hides the section
	 * behind a short notice; demo mode has no pipeline at all
	 * (pipelineAdmin.ts rejects, conventions §10). Unset amounts /
	 * probabilities / months stay `null` and are shown as 未設定, never 0.
	 */
	import { untrack } from 'svelte';
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import { Plus, Trash2 } from '@lucide/svelte';
	import { StatusBadge, LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import {
		adoptPipelineVersion,
		createPipelineVersion,
		isPipelineAvailable,
		listPipelineVersions,
		VERSION_STAGES,
		type PipelineVersion,
		type PipelineVersionInput,
		type VersionStage
	} from '#lib/banto/pipelineAdmin.js';
	import {
		formatOptional,
		formatPct,
		formatYen,
		isForbiddenError,
		issueLabel,
		stageLabel
	} from '#lib/banto/costFormat.js';

	interface Props {
		projectId: number;
		/** Ordered-side projects keep their history but take no new versions. */
		ordered: boolean;
		canWrite: boolean;
	}

	let { projectId, ordered, canWrite }: Props = $props();

	const available = isPipelineAvailable();

	let versions = $state<PipelineVersion[] | null>(null);
	let loading = $state(false);
	let loadError = $state<unknown>(null);
	let loadToken = 0;
	const forbidden = $derived(isForbiddenError(loadError));

	// ---- new-version form (plain inputs: numbers are kept as text until save) ----
	interface PlanRow {
		key: number;
		month: string;
		undecided: boolean;
		amount: string;
	}

	let stage = $state<VersionStage>('lead');
	let expectedAmount = $state('');
	let probabilityPct = $state('');
	let expectedOrderMonth = $state('');
	let expectedStartMonth = $state('');
	let expectedEndMonth = $state('');
	let estCostAtOrder = $state('');
	let basis = $state('');
	let nextAction = $state('');
	let confirmedOn = $state('');
	let plan = $state<PlanRow[]>([]);
	let planKey = 0;
	let errors = $state<Record<string, string>>({});
	let saving = $state(false);
	let adoptingId = $state<number | null>(null);
	let prefilled = false;

	const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

	function text(value: number | null): string {
		return value === null ? '' : String(value);
	}

	/** Start the form from the newest version so a revision only changes what moved. */
	function prefill(from: PipelineVersion) {
		stage = from.stage;
		expectedAmount = text(from.expectedAmount);
		probabilityPct = text(from.probabilityPct);
		expectedOrderMonth = from.expectedOrderMonth ?? '';
		expectedStartMonth = from.expectedStartMonth ?? '';
		expectedEndMonth = from.expectedEndMonth ?? '';
		estCostAtOrder = text(from.estCostAtOrder);
		basis = '';
		nextAction = from.nextAction ?? '';
		confirmedOn = from.confirmedOn ?? '';
		plan = from.revenuePlan.map((line) => ({
			key: ++planKey,
			month: line.month ?? '',
			undecided: line.month === null,
			amount: String(line.amount)
		}));
	}

	async function reload() {
		if (!available) return;
		const token = ++loadToken;
		loading = true;
		loadError = null;
		try {
			const result = await listPipelineVersions(projectId);
			if (token !== loadToken) return;
			versions = result;
			if (!prefilled && result.length > 0) {
				prefilled = true;
				prefill(result[0]);
			}
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			versions = null;
		} finally {
			if (token === loadToken) loading = false;
		}
	}

	$effect(() => {
		untrack(() => void reload());
	});

	function addPlanLine() {
		plan = [...plan, { key: ++planKey, month: '', undecided: false, amount: '' }];
	}

	function removePlanLine(key: number) {
		plan = plan.filter((line) => line.key !== key);
	}

	/** '' -> null; anything else must be a non-negative integer. */
	function parseAmount(raw: string, field: string, next: Record<string, string>): number | null {
		const trimmed = raw.trim();
		if (trimmed === '') return null;
		const value = Number(trimmed);
		if (!Number.isInteger(value) || value < 0) {
			next[field] = m['pipeline.errorNonNegativeInteger']();
			return null;
		}
		return value;
	}

	function parseMonth(raw: string, field: string, next: Record<string, string>): string | null {
		const trimmed = raw.trim();
		if (trimmed === '') return null;
		if (!MONTH_RE.test(trimmed)) next[field] = m['pipeline.errorMonthFormat']();
		return trimmed;
	}

	function buildInput(adopt: boolean): PipelineVersionInput | null {
		const next: Record<string, string> = {};
		const probability = parseAmount(probabilityPct, 'probabilityPct', next);
		if (probability !== null && probability > 99) {
			next.probabilityPct = m['pipeline.errorProbabilityRange']();
		}
		const input: PipelineVersionInput = {
			stage,
			expectedAmount: parseAmount(expectedAmount, 'expectedAmount', next),
			probabilityPct: probability,
			expectedOrderMonth: parseMonth(expectedOrderMonth, 'expectedOrderMonth', next),
			expectedStartMonth: parseMonth(expectedStartMonth, 'expectedStartMonth', next),
			expectedEndMonth: parseMonth(expectedEndMonth, 'expectedEndMonth', next),
			estCostAtOrder: parseAmount(estCostAtOrder, 'estCostAtOrder', next),
			basis: basis.trim() === '' ? null : basis.trim(),
			nextAction: nextAction.trim() === '' ? null : nextAction.trim(),
			confirmedOn: confirmedOn === '' ? null : confirmedOn,
			revenuePlan: [],
			adopt
		};
		if (adopt && input.basis === null) next.basis = m['pipeline.errorBasisRequired']();
		for (const line of plan) {
			const amount = line.amount.trim();
			const value = Number(amount);
			if (amount === '' || !Number.isInteger(value) || value < 0) {
				next.revenuePlan = m['pipeline.errorPlanAmount']();
				continue;
			}
			if (!line.undecided && !MONTH_RE.test(line.month.trim())) {
				next.revenuePlan = m['pipeline.errorPlanMonth']();
				continue;
			}
			input.revenuePlan.push({ month: line.undecided ? null : line.month.trim(), amount: value });
		}
		errors = next;
		return Object.keys(next).length === 0 ? input : null;
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

	async function save(adopt: boolean) {
		if (!canWrite || saving) return;
		const input = buildInput(adopt);
		if (!input) return;
		saving = true;
		try {
			await createPipelineVersion(projectId, input);
			notify('success', adopt ? m['pipeline.savedAdopted']() : m['pipeline.savedDraft']());
			basis = '';
			await reload();
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				applyServerErrors(err.body.field_errors);
			} else {
				notify('error', isProviderError(err) ? err.message : String(err));
			}
		} finally {
			saving = false;
		}
	}

	async function adopt(version: PipelineVersion) {
		if (!canWrite || adoptingId !== null) return;
		if (!window.confirm(m['pipeline.adoptConfirm']({ no: version.versionNo }))) return;
		adoptingId = version.id;
		try {
			await adoptPipelineVersion(projectId, version.id);
			notify('success', m['pipeline.adopted']());
			await reload();
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				notify('error', err.body.field_errors.map((e) => e.message).join(' / '));
			} else {
				notify('error', isProviderError(err) ? err.message : String(err));
			}
		} finally {
			adoptingId = null;
		}
	}

	/** Server field names that this form shows next to an input; the rest go in the summary. */
	const SHOWN_FIELDS = new Set([
		'stage',
		'expectedAmount',
		'probabilityPct',
		'expectedOrderMonth',
		'expectedStartMonth',
		'expectedEndMonth',
		'estCostAtOrder',
		'basis',
		'nextAction',
		'confirmedOn',
		'revenuePlan'
	]);
	const otherErrors = $derived(
		Object.entries(errors)
			.filter(([field]) => !SHOWN_FIELDS.has(field))
			.map(([, message]) => message)
	);
</script>

<section class="pipeline" aria-labelledby="pipeline-heading">
	<h2 id="pipeline-heading">{m['pipeline.sectionTitle']()}</h2>

	{#if !available}
		<p class="note">{m['pipeline.demoUnavailable']()}</p>
	{:else if forbidden}
		<p class="note">{m['pipeline.sectionForbidden']()}</p>
	{:else if loadError}
		<p class="error" role="alert">
			{isProviderError(loadError) ? loadError.message : String(loadError)}
		</p>
		<button type="button" class="banto-btn banto-btn--secondary" onclick={() => void reload()}>
			{m['common.reload']()}
		</button>
	{:else if versions === null}
		<LoadingState label={m['common.loading']()} />
	{:else}
		<h3>{m['pipeline.historyTitle']()}</h3>
		{#if versions.length === 0}
			<p class="note">{m['pipeline.noVersions']()}</p>
		{:else}
			<div class="table-wrap">
				<table>
					<caption class="sr-only">{m['pipeline.historyTitle']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['pipeline.colVersion']()}</th>
							<th scope="col">{m['pipeline.colKind']()}</th>
							<th scope="col">{m['pipeline.fieldStage']()}</th>
							<th scope="col" class="num">{m['pipeline.fieldExpectedAmount']()}</th>
							<th scope="col" class="num">{m['pipeline.fieldProbability']()}</th>
							<th scope="col">{m['pipeline.fieldExpectedOrderMonth']()}</th>
							<th scope="col">{m['pipeline.colIssues']()}</th>
							<th scope="col">{m['pipeline.colCreated']()}</th>
							<th scope="col">{m['pipeline.colAdopted']()}</th>
							{#if canWrite && !ordered}
								<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
							{/if}
						</tr>
					</thead>
					<tbody>
						{#each versions as version (version.id)}
							<tr>
								<td>{m['pipeline.versionNo']({ no: version.versionNo })}</td>
								<td>
									{#if version.kind === 'adopted'}
										<StatusBadge variant="success" label={m['pipeline.kindAdopted']()} />
									{:else}
										<StatusBadge variant="neutral" label={m['pipeline.kindDraft']()} />
									{/if}
								</td>
								<td>{stageLabel(version.stage)}</td>
								<td class="num" class:unset={version.expectedAmount === null}>
									{formatYen(version.expectedAmount)}
								</td>
								<td class="num" class:unset={version.probabilityPct === null}>
									{formatPct(version.probabilityPct)}
								</td>
								<td class:unset={!version.expectedOrderMonth}>
									{formatOptional(version.expectedOrderMonth)}
								</td>
								<td>
									<div class="badges">
										{#each version.issues as issue (issue)}
											<StatusBadge variant="warning" label={issueLabel(issue)} />
										{/each}
									</div>
								</td>
								<td>
									<div>{version.createdByName ?? m['cost.unset']()}</div>
									<div class="sub">{version.createdAt}</div>
								</td>
								<td>
									{#if version.adoptedAt}
										<div>{version.adoptedByName ?? m['cost.unset']()}</div>
										<div class="sub">{version.adoptedAt}</div>
									{/if}
								</td>
								{#if canWrite && !ordered}
									<td>
										{#if version.kind === 'draft'}
											<button
												type="button"
												class="banto-btn banto-btn--secondary"
												disabled={adoptingId !== null}
												onclick={() => void adopt(version)}
											>
												{m['pipeline.adopt']()}
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

		{#if ordered}
			<p class="note">{m['pipeline.orderedNotice']()}</p>
		{:else if canWrite}
			<h3>{m['pipeline.newVersionTitle']()}</h3>
			<p class="note">{m['pipeline.newVersionDesc']()}</p>
			{#each otherErrors as message, i (i)}
				<p class="error" role="alert">{message}</p>
			{/each}
			<form
				class="version-form"
				novalidate
				onsubmit={(event) => {
					event.preventDefault();
					void save(false);
				}}
			>
				<div class="fields">
					<label class="field">
						<span>{m['pipeline.fieldStage']()}</span>
						<select class="banto-input" bind:value={stage} disabled={saving}>
							{#each VERSION_STAGES as value (value)}
								<option {value}>{stageLabel(value)}</option>
							{/each}
						</select>
						{#if errors.stage}<span class="error">{errors.stage}</span>{/if}
					</label>
					<label class="field">
						<span>{m['pipeline.fieldExpectedAmount']()}</span>
						<input
							class="banto-input"
							type="text"
							inputmode="numeric"
							placeholder={m['cost.unset']()}
							bind:value={expectedAmount}
							disabled={saving}
							aria-invalid={!!errors.expectedAmount}
						/>
						{#if errors.expectedAmount}<span class="error">{errors.expectedAmount}</span>{/if}
					</label>
					<label class="field">
						<span>{m['pipeline.fieldProbability']()}</span>
						<input
							class="banto-input"
							type="text"
							inputmode="numeric"
							placeholder={m['cost.unset']()}
							bind:value={probabilityPct}
							disabled={saving}
							aria-invalid={!!errors.probabilityPct}
						/>
						{#if errors.probabilityPct}<span class="error">{errors.probabilityPct}</span>{/if}
					</label>
					<label class="field">
						<span>{m['pipeline.fieldExpectedOrderMonth']()}</span>
						<input
							class="banto-input"
							type="month"
							placeholder="YYYY-MM"
							bind:value={expectedOrderMonth}
							disabled={saving}
							aria-invalid={!!errors.expectedOrderMonth}
						/>
						{#if errors.expectedOrderMonth}<span class="error">{errors.expectedOrderMonth}</span
							>{/if}
					</label>
					<label class="field">
						<span>{m['pipeline.fieldExpectedStartMonth']()}</span>
						<input
							class="banto-input"
							type="month"
							placeholder="YYYY-MM"
							bind:value={expectedStartMonth}
							disabled={saving}
							aria-invalid={!!errors.expectedStartMonth}
						/>
						{#if errors.expectedStartMonth}<span class="error">{errors.expectedStartMonth}</span
							>{/if}
					</label>
					<label class="field">
						<span>{m['pipeline.fieldExpectedEndMonth']()}</span>
						<input
							class="banto-input"
							type="month"
							placeholder="YYYY-MM"
							bind:value={expectedEndMonth}
							disabled={saving}
							aria-invalid={!!errors.expectedEndMonth}
						/>
						{#if errors.expectedEndMonth}<span class="error">{errors.expectedEndMonth}</span>{/if}
					</label>
					<label class="field">
						<span>{m['pipeline.fieldEstCostAtOrder']()}</span>
						<input
							class="banto-input"
							type="text"
							inputmode="numeric"
							placeholder={m['cost.unset']()}
							bind:value={estCostAtOrder}
							disabled={saving}
							aria-invalid={!!errors.estCostAtOrder}
						/>
						{#if errors.estCostAtOrder}<span class="error">{errors.estCostAtOrder}</span>{/if}
					</label>
					<label class="field">
						<span>{m['pipeline.fieldConfirmedOn']()}</span>
						<input
							class="banto-input"
							type="date"
							bind:value={confirmedOn}
							disabled={saving}
							aria-invalid={!!errors.confirmedOn}
						/>
						{#if errors.confirmedOn}<span class="error">{errors.confirmedOn}</span>{/if}
					</label>
					<label class="field field--wide">
						<span>{m['pipeline.fieldBasis']()}</span>
						<textarea
							class="banto-input textarea"
							rows="2"
							maxlength="1000"
							bind:value={basis}
							disabled={saving}
							aria-invalid={!!errors.basis}></textarea>
						{#if errors.basis}<span class="error">{errors.basis}</span>{/if}
					</label>
					<label class="field field--wide">
						<span>{m['pipeline.fieldNextAction']()}</span>
						<textarea
							class="banto-input textarea"
							rows="2"
							maxlength="1000"
							bind:value={nextAction}
							disabled={saving}
							aria-invalid={!!errors.nextAction}></textarea>
						{#if errors.nextAction}<span class="error">{errors.nextAction}</span>{/if}
					</label>
				</div>

				<fieldset class="plan">
					<legend>{m['pipeline.planTitle']()}</legend>
					<p class="note">{m['pipeline.planDesc']()}</p>
					{#each plan as line, index (line.key)}
						<div class="plan-row">
							<label class="field">
								<span>{m['pipeline.planMonth']()}</span>
								<input
									class="banto-input"
									type="month"
									placeholder="YYYY-MM"
									bind:value={line.month}
									disabled={saving || line.undecided}
								/>
							</label>
							<label class="check">
								<input type="checkbox" bind:checked={line.undecided} disabled={saving} />
								{m['pipeline.timeUndecided']()}
							</label>
							<label class="field">
								<span>{m['pipeline.planAmount']()}</span>
								<input
									class="banto-input"
									type="text"
									inputmode="numeric"
									bind:value={line.amount}
									disabled={saving}
								/>
							</label>
							<button
								type="button"
								class="banto-btn banto-btn--ghost"
								aria-label={m['pipeline.planRemove']({ line: index + 1 })}
								disabled={saving}
								onclick={() => removePlanLine(line.key)}
							>
								<Trash2 size={16} aria-hidden="true" />
							</button>
						</div>
					{/each}
					{#if errors.revenuePlan}<p class="error">{errors.revenuePlan}</p>{/if}
					<button
						type="button"
						class="banto-btn banto-btn--ghost"
						disabled={saving}
						onclick={addPlanLine}
					>
						<Plus size={16} aria-hidden="true" />
						{m['pipeline.planAdd']()}
					</button>
				</fieldset>

				<div class="actions">
					<button type="submit" class="banto-btn banto-btn--secondary" disabled={saving}>
						{m['pipeline.saveDraft']()}
					</button>
					<button
						type="button"
						class="banto-btn banto-btn--primary"
						disabled={saving}
						onclick={() => void save(true)}
					>
						{m['pipeline.saveAdopted']()}
					</button>
				</div>
			</form>
		{/if}
		{#if loading}
			<p class="sub" role="status">{m['common.loading']()}</p>
		{/if}
	{/if}
</section>

<style>
	.pipeline {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
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
		border-bottom: 1px solid var(--banto-border);
		text-align: left;
		vertical-align: top;
		white-space: nowrap;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.unset {
		color: var(--banto-text-muted);
	}

	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-1);
	}

	.version-form {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: var(--banto-space-3);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.field input,
	.field select,
	.field textarea {
		color: var(--banto-text);
	}

	.field--wide {
		grid-column: 1 / -1;
	}

	.textarea {
		height: auto;
		padding: var(--banto-space-2);
	}

	.plan {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		margin: 0;
		padding: var(--banto-space-3);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.plan legend {
		padding: 0 var(--banto-space-1);
		font-weight: 600;
	}

	.plan-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--banto-space-3);
	}

	.check {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		height: var(--banto-control-height);
		font-size: var(--banto-font-size-sm);
	}

	.plan > .banto-btn {
		align-self: flex-start;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-2);
		justify-content: flex-end;
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
