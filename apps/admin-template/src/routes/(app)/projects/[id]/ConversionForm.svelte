<script lang="ts">
	/**
	 * 受注転換 (spec §5.5, banto-cost P3b, T23 / T24). Switches THIS project
	 * to 受注 with the confirmed amount, the basis and the ordered revenue
	 * plan (whose total must equal the confirmed amount). Nothing is
	 * recognized as revenue here, and the pipeline versions stay as history.
	 *
	 * 一部受注 keeps the ordered scope on this project and registers the rest
	 * as a NEW pre-order project with its own adopted version, so the ordered
	 * part is never also left in the pipeline.
	 */
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/banto/confirmAction.svelte.js';
	import { convertOrder, type ConversionRequest } from '#lib/banto/ordersAdmin.js';
	import { VERSION_STAGES, type VersionStage } from '#lib/banto/pipelineAdmin.js';
	import { formatYen, stageLabel, todayIso } from '#lib/banto/costFormat.js';
	import PlanLinesEditor, {
		newPlanLine,
		parsePlanLines,
		type PlanLineDraft
	} from './PlanLinesEditor.svelte';

	interface Props {
		projectId: number;
		/** The project's `rowVersion` the page loaded (T13). */
		rowVersion: number;
		code: string;
		onConverted: () => void;
		onCancel: () => void;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { projectId, rowVersion, code, onConverted, onCancel, onPendingChange }: Props = $props();

	const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

	let convertedOn = $state(todayIso());
	let confirmedAmount = $state('');
	let basis = $state('');
	let plannedStart = $state('');
	let plannedEnd = $state('');
	let orderNo = $state('');
	let plan = $state<PlanLineDraft[]>([newPlanLine()]);
	let scope = $state<'whole' | 'partial'>('whole');
	// 一部受注: the remainder project.
	let restCode = $state('');
	let restName = $state('');
	let restStage = $state<VersionStage>('negotiating');
	let restAmount = $state('');
	let restProbability = $state('');
	let restOrderMonth = $state('');
	let restRevenueMonth = $state('');
	let restUndated = $state(false);
	let restBasis = $state('');

	let errors = $state<Record<string, string>>({});
	let saving = $state(false);
	let touched = $state(false);

	$effect(() => {
		onPendingChange?.({ dirty: touched, busy: saving });
	});

	const confirmedTarget = $derived.by(() => {
		const value = Number(confirmedAmount.trim());
		return confirmedAmount.trim() !== '' && Number.isInteger(value) ? value : null;
	});

	function optionalInt(raw: string, field: string, next: Record<string, string>, max?: number) {
		const trimmed = raw.trim();
		if (trimmed === '') return null;
		const value = Number(trimmed);
		if (!Number.isInteger(value) || value < 0 || (max !== undefined && value > max)) {
			next[field] =
				max === undefined
					? m['pipeline.errorNonNegativeInteger']()
					: m['pipeline.errorProbabilityRange']();
			return null;
		}
		return value;
	}

	function optional(raw: string): string | null {
		const trimmed = raw.trim();
		return trimmed === '' ? null : trimmed;
	}

	function build(): ConversionRequest | null {
		const next: Record<string, string> = {};
		const amount = Number(confirmedAmount.trim());
		if (confirmedAmount.trim() === '' || !Number.isInteger(amount) || amount <= 0) {
			next.confirmedAmount = m['orders.errorPositiveAmount']();
		}
		if (basis.trim() === '') next.basis = m['orders.errorBasisRequired']();
		if (plannedStart === '') next.plannedStart = m['orders.errorPlannedDates']();
		if (plannedEnd === '') next.plannedEnd = m['orders.errorPlannedDates']();
		const lines = parsePlanLines(plan);
		if (lines === null || lines.length === 0) next.revenuePlan = m['orders.errorPlanLines']();
		let remainder: ConversionRequest['remainder'] = null;
		if (scope === 'partial') {
			if (restCode.trim() === '') next['remainder.code'] = m['orders.errorRequired']();
			if (restName.trim() === '') next['remainder.name'] = m['orders.errorRequired']();
			if (restBasis.trim() === '') next['remainder.basis'] = m['pipeline.errorBasisRequired']();
			const expected = optionalInt(restAmount, 'remainder.expectedAmount', next);
			const probability = optionalInt(restProbability, 'remainder.probabilityPct', next, 99);
			const orderMonth = optional(restOrderMonth);
			if (orderMonth !== null && !MONTH_RE.test(orderMonth)) {
				next['remainder.expectedOrderMonth'] = m['pipeline.errorMonthFormat']();
			}
			const revenueMonth = restUndated ? null : optional(restRevenueMonth);
			if (revenueMonth !== null && !MONTH_RE.test(revenueMonth)) {
				next['remainder.revenuePlan'] = m['pipeline.errorMonthFormat']();
			}
			remainder = {
				code: restCode.trim(),
				name: restName.trim(),
				version: {
					stage: restStage,
					expectedAmount: expected,
					probabilityPct: probability,
					expectedOrderMonth: orderMonth,
					expectedStartMonth: null,
					expectedEndMonth: null,
					estCostAtOrder: null,
					basis: optional(restBasis),
					nextAction: null,
					confirmedOn: convertedOn || null,
					// The whole expected amount on one month (or 時期未定) when both are given.
					revenuePlan:
						expected !== null && (restUndated || revenueMonth !== null)
							? [{ month: revenueMonth, amount: expected }]
							: [],
					adopt: true
				}
			};
		}
		errors = next;
		if (Object.keys(next).length > 0 || lines === null) return null;
		return {
			rowVersion,
			convertedOn,
			confirmedAmount: amount,
			basis: optional(basis),
			plannedStart: optional(plannedStart),
			plannedEnd: optional(plannedEnd),
			orderNo: optional(orderNo),
			revenuePlan: lines,
			scope,
			remainder
		};
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

	async function submit() {
		if (saving) return;
		const input = build();
		if (!input) return;
		const ok = await confirmAction({
			title: m['orders.convertConfirmTitle'](),
			body: m['orders.convertConfirm'](),
			details: [
				{ label: m['confirm.project'](), value: code },
				{ label: m['orders.fieldConvertedOn'](), value: input.convertedOn },
				{ label: m['orders.confirmedAmount'](), value: formatYen(input.confirmedAmount) },
				{
					label: m['orders.fieldScope'](),
					value: input.scope === 'partial' ? m['orders.scopePartial']() : m['orders.scopeWhole']()
				}
			],
			undo: m['orders.convertUndo'](),
			confirmLabel: m['orders.convertSubmit']()
		});
		if (!ok) return;
		saving = true;
		try {
			await convertOrder(projectId, input);
			touched = false;
			notify('success', m['orders.converted']());
			onConverted();
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

	const SHOWN = new Set([
		'convertedOn',
		'confirmedAmount',
		'basis',
		'plannedStart',
		'plannedEnd',
		'orderNo',
		'revenuePlan',
		'remainder.code',
		'remainder.name',
		'remainder.expectedAmount',
		'remainder.probabilityPct',
		'remainder.expectedOrderMonth',
		'remainder.revenuePlan',
		'remainder.basis'
	]);
	const otherErrors = $derived(
		Object.entries(errors)
			.filter(([field]) => !SHOWN.has(field))
			.map(([, message]) => message)
	);
</script>

<form
	class="convert-form"
	novalidate
	oninput={() => (touched = true)}
	onsubmit={(event) => {
		event.preventDefault();
		void submit();
	}}
>
	<p class="note">{m['orders.convertDesc']()}</p>
	{#each otherErrors as message, i (i)}
		<p class="error" role="alert">{message}</p>
	{/each}
	<div class="fields">
		<label class="field">
			<span>{m['orders.fieldConvertedOn']()}</span>
			<input class="banto-input" type="date" bind:value={convertedOn} disabled={saving} />
			{#if errors.convertedOn}<span class="error">{errors.convertedOn}</span>{/if}
		</label>
		<label class="field">
			<span>{m['orders.fieldConfirmedAmount']()}</span>
			<input
				class="banto-input"
				type="text"
				inputmode="numeric"
				bind:value={confirmedAmount}
				disabled={saving}
				aria-invalid={!!errors.confirmedAmount}
			/>
			{#if errors.confirmedAmount}<span class="error">{errors.confirmedAmount}</span>{/if}
		</label>
		<label class="field">
			<span>{m['projects.fieldOrderNo']()}</span>
			<input
				class="banto-input"
				type="text"
				maxlength="30"
				bind:value={orderNo}
				disabled={saving}
			/>
			{#if errors.orderNo}<span class="error">{errors.orderNo}</span>{/if}
		</label>
		<label class="field">
			<span>{m['projects.fieldPlannedStart']()}</span>
			<input class="banto-input" type="date" bind:value={plannedStart} disabled={saving} />
			{#if errors.plannedStart}<span class="error">{errors.plannedStart}</span>{/if}
		</label>
		<label class="field">
			<span>{m['projects.fieldPlannedEnd']()}</span>
			<input class="banto-input" type="date" bind:value={plannedEnd} disabled={saving} />
			{#if errors.plannedEnd}<span class="error">{errors.plannedEnd}</span>{/if}
		</label>
		<label class="field field--wide">
			<span>{m['orders.fieldBasis']()}</span>
			<textarea
				class="banto-input textarea"
				rows="2"
				maxlength="1000"
				bind:value={basis}
				disabled={saving}
				aria-invalid={!!errors.basis}></textarea>
			{#if errors.basis}<span class="error">{errors.basis}</span>{/if}
		</label>
	</div>

	<PlanLinesEditor
		bind:lines={plan}
		legend={m['orders.orderedPlanTitle']()}
		description={m['orders.orderedPlanDesc']()}
		target={confirmedTarget}
		disabled={saving}
		error={errors.revenuePlan}
	/>

	<fieldset class="scope">
		<legend>{m['orders.fieldScope']()}</legend>
		<label class="check">
			<input type="radio" name="scope" value="whole" bind:group={scope} disabled={saving} />
			{m['orders.scopeWhole']()}
		</label>
		<label class="check">
			<input type="radio" name="scope" value="partial" bind:group={scope} disabled={saving} />
			{m['orders.scopePartial']()}
		</label>
		{#if scope === 'partial'}
			<p class="note">{m['orders.remainderDesc']()}</p>
			<div class="fields">
				<label class="field">
					<span>{m['orders.remainderCode']()}</span>
					<input
						class="banto-input"
						type="text"
						maxlength="30"
						bind:value={restCode}
						disabled={saving}
					/>
					{#if errors['remainder.code']}<span class="error">{errors['remainder.code']}</span>{/if}
				</label>
				<label class="field">
					<span>{m['orders.remainderName']()}</span>
					<input
						class="banto-input"
						type="text"
						maxlength="100"
						bind:value={restName}
						disabled={saving}
					/>
					{#if errors['remainder.name']}<span class="error">{errors['remainder.name']}</span>{/if}
				</label>
				<label class="field">
					<span>{m['pipeline.fieldStage']()}</span>
					<select class="banto-input" bind:value={restStage} disabled={saving}>
						{#each VERSION_STAGES as value (value)}
							<option {value}>{stageLabel(value)}</option>
						{/each}
					</select>
				</label>
				<label class="field">
					<span>{m['pipeline.fieldExpectedAmount']()}</span>
					<input
						class="banto-input"
						type="text"
						inputmode="numeric"
						placeholder={m['cost.unset']()}
						bind:value={restAmount}
						disabled={saving}
					/>
					{#if errors['remainder.expectedAmount']}<span class="error"
							>{errors['remainder.expectedAmount']}</span
						>{/if}
				</label>
				<label class="field">
					<span>{m['pipeline.fieldProbability']()}</span>
					<input
						class="banto-input"
						type="text"
						inputmode="numeric"
						placeholder={m['cost.unset']()}
						bind:value={restProbability}
						disabled={saving}
					/>
					{#if errors['remainder.probabilityPct']}<span class="error"
							>{errors['remainder.probabilityPct']}</span
						>{/if}
				</label>
				<label class="field">
					<span>{m['pipeline.fieldExpectedOrderMonth']()}</span>
					<input
						class="banto-input"
						type="month"
						placeholder="YYYY-MM"
						bind:value={restOrderMonth}
						disabled={saving}
					/>
					{#if errors['remainder.expectedOrderMonth']}<span class="error"
							>{errors['remainder.expectedOrderMonth']}</span
						>{/if}
				</label>
				<label class="field">
					<span>{m['orders.remainderRevenueMonth']()}</span>
					<input
						class="banto-input"
						type="month"
						placeholder="YYYY-MM"
						bind:value={restRevenueMonth}
						disabled={saving || restUndated}
					/>
					{#if errors['remainder.revenuePlan']}<span class="error"
							>{errors['remainder.revenuePlan']}</span
						>{/if}
				</label>
				<label class="check">
					<input type="checkbox" bind:checked={restUndated} disabled={saving} />
					{m['pipeline.timeUndecided']()}
				</label>
				<label class="field field--wide">
					<span>{m['pipeline.fieldBasis']()}</span>
					<textarea
						class="banto-input textarea"
						rows="2"
						maxlength="1000"
						bind:value={restBasis}
						disabled={saving}></textarea>
					{#if errors['remainder.basis']}<span class="error">{errors['remainder.basis']}</span>{/if}
				</label>
			</div>
		{/if}
	</fieldset>

	<div class="actions">
		<button type="button" class="banto-btn banto-btn--ghost" disabled={saving} onclick={onCancel}>
			{m['common.cancel']()}
		</button>
		<button type="submit" class="banto-btn banto-btn--primary" disabled={saving}>
			{m['orders.convertSubmit']()}
		</button>
	</div>
</form>

<style>
	.convert-form {
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

	.scope {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		margin: 0;
		padding: var(--banto-space-3);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.scope legend {
		padding: 0 var(--banto-space-1);
		font-weight: 600;
	}

	.check {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		min-height: var(--banto-control-height);
		font-size: var(--banto-font-size-sm);
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-2);
		justify-content: flex-end;
	}
</style>
