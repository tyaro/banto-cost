<script lang="ts">
	/**
	 * 直接費の入力フォーム (spec §6.3 / §6.4, banto-cost P4d), used by /costs
	 * and 案件詳細 → 直接費. Three shapes:
	 *
	 * - a cost of its own (通常 or 仮計上): the project, or a split over two or
	 *   more projects (配分, T10, the lines must add up to the amount), the
	 *   phase, the cost type, the vendor, an order of the project, the
	 *   tax-exclusive amount, the tax kind, the voucher;
	 * - the invoice replacing an approved provisional (`confirms`): the
	 *   invoiced amount and why (the provisional no longer counts);
	 * - a return / cancel / discount of an approved record (`adjustment`): the
	 *   reduction as a positive amount and why (T14, never a negative cost).
	 *
	 * Records are saved as drafts and submitted from the list. The server
	 * checks the rest (the order's remainder, the project scope, inactive
	 * masters) and answers with field errors. A create carries a
	 * `clientRequestId` kept until the save succeeds (T13).
	 */
	import { untrack } from 'svelte';
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import {
		ADJUSTMENT_KINDS,
		DIRECT_COST_TYPES,
		TAX_KINDS,
		saveCost,
		type AdjustmentKind,
		type DirectCost,
		type DirectCostInput,
		type DirectCostSaved,
		type DirectCostType,
		type PurchaseOrder,
		type TaxKind
	} from '#lib/banto/costsAdmin.js';
	import { newRequestId, type WorkMaster } from '#lib/banto/timeAdmin.js';
	import { costTypeLabel } from '#lib/banto/budgetFormat.js';
	import {
		adjustmentLabel,
		allocationRest,
		kindLabel,
		parseYen,
		taxLabel
	} from '#lib/banto/costsFormat.js';
	import { formatSignedYen, formatYen, isForbiddenError } from '#lib/banto/costFormat.js';

	interface Choice {
		id: number;
		label: string;
	}

	interface Props {
		/** The record to edit, or `null` for a new one. */
		cost: DirectCost | null;
		/** For a new confirm / adjustment: the approved record it refers to. */
		target?: DirectCost | null;
		mode?: 'cost' | 'confirms' | 'adjustment';
		defaultDate: string;
		defaultProjectId?: number | null;
		/** A new cost starts against this order (案件詳細 → 発注 → 実績化). */
		defaultOrderId?: number | null;
		projects: Choice[];
		phases: WorkMaster[];
		vendors: WorkMaster[];
		/** Orders a cost of the default project may realize (案件詳細 only). */
		orders?: PurchaseOrder[];
		onSaved: (saved: DirectCostSaved) => void;
		onCancel: () => void;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let {
		cost,
		target = null,
		mode = 'cost',
		defaultDate,
		defaultProjectId = null,
		defaultOrderId = null,
		projects,
		phases,
		vendors,
		orders = [],
		onSaved,
		onCancel,
		onPendingChange
	}: Props = $props();

	// The parent keys this form on the record, so its starting values are read once.
	const start = untrack(() => cost);
	const shape: 'cost' | 'confirms' | 'adjustment' = untrack(() =>
		start
			? start.entryKind === 'confirms' || start.entryKind === 'adjustment'
				? start.entryKind
				: 'cost'
			: mode
	);
	const ref = untrack(() => target);
	const yenText = (v: number | null | undefined) =>
		v === null || v === undefined ? '' : String(v);

	let bookedOn = $state(start?.bookedOn ?? untrack(() => defaultDate));
	let provisional = $state(start?.entryKind === 'provisional');
	let split = $state(start ? start.projectId === null : false);
	let projectId = $state(
		start?.projectId != null
			? String(start.projectId)
			: untrack(() => (defaultProjectId != null ? String(defaultProjectId) : ''))
	);
	let phaseId = $state(start?.phaseId != null ? String(start.phaseId) : '');
	let costType = $state<DirectCostType | ''>(start?.costType ?? '');
	let vendorId = $state(start?.vendorId != null ? String(start.vendorId) : '');
	let orderId = $state(
		start?.purchaseOrderId != null
			? String(start.purchaseOrderId)
			: untrack(() => (defaultOrderId != null ? String(defaultOrderId) : ''))
	);
	let amount = $state(yenText(start?.amount));
	let taxKind = $state<TaxKind | ''>(start?.taxKind ?? '');
	let amountInTax = $state(yenText(start?.amountInTax));
	let voucherNo = $state(start?.voucherNo ?? '');
	let description = $state(start?.description ?? '');
	let reason = $state(start?.reason ?? '');
	let adjustmentKind = $state<AdjustmentKind | ''>(start?.adjustmentKind ?? '');
	let basis = $state(start?.allocationBasis ?? '');
	let lines = $state<{ projectId: string; amount: string }[]>(
		start && start.allocations.length > 0
			? start.allocations.map((a) => ({ projectId: String(a.projectId), amount: String(a.amount) }))
			: [
					{ projectId: '', amount: '' },
					{ projectId: '', amount: '' }
				]
	);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let requestId = newRequestId();
	let requestFor: string | null = null;

	function snapshot(): string {
		return JSON.stringify([
			bookedOn,
			provisional,
			split,
			projectId,
			phaseId,
			costType,
			vendorId,
			orderId,
			amount,
			taxKind,
			amountInTax,
			voucherNo,
			description,
			reason,
			adjustmentKind,
			basis,
			lines
		]);
	}
	const initial = snapshot();
	$effect(() => {
		onPendingChange?.({ dirty: snapshot() !== initial, busy });
	});

	function choices(rows: WorkMaster[], current: number | null | undefined) {
		return rows.filter((row) => row.active || row.id === current);
	}
	const phaseChoices = $derived(choices(phases, start?.phaseId));
	const vendorChoices = $derived(choices(vendors, start?.vendorId));
	const orderChoices = $derived(
		orders.filter(
			(o) => String(o.projectId) === projectId && (o.remaining > 0 || String(o.id) === orderId)
		)
	);
	const rest = $derived(
		allocationRest(
			parseYen(amount),
			lines.map((l) => parseYen(l.amount))
		)
	);

	function optionalText(v: string): string | null {
		return v.trim() === '' ? null : v.trim();
	}

	function build(): DirectCostInput | null {
		const next: Record<string, string> = {};
		if (!/^\d{4}-\d{2}-\d{2}$/.test(bookedOn)) next.bookedOn = m['costs.errorDate']();
		const yen = parseYen(amount);
		if (yen === null || (shape !== 'confirms' && yen <= 0)) next.amount = m['costs.errorAmount']();
		const inTax = amountInTax.trim() === '' ? null : parseYen(amountInTax);
		if (amountInTax.trim() !== '' && inTax === null) next.amountInTax = m['costs.errorAmount']();
		if (shape !== 'cost' && reason.trim() === '') next.reason = m['costs.errorReason']();
		if (shape === 'adjustment' && adjustmentKind === '')
			next.adjustmentKind = m['costs.errorAdjustment']();
		const allocations: { projectId: number; amount: number }[] = [];
		if (shape === 'cost') {
			if (costType === '' && orderId === '') next.costType = m['costs.errorCostType']();
			if (split) {
				lines.forEach((l, i) => {
					const a = parseYen(l.amount);
					if (l.projectId === '') next[`allocations.${i}.projectId`] = m['costs.errorProject']();
					if (a === null || a <= 0) next[`allocations.${i}.amount`] = m['costs.errorAmount']();
					if (l.projectId !== '' && a !== null)
						allocations.push({ projectId: Number(l.projectId), amount: a });
				});
				if (rest !== 0 && rest !== null) {
					next.allocations = m['costs.errorAllocationRest']({ rest: formatSignedYen(rest) });
				}
			} else if (projectId === '') {
				next.projectId = m['costs.errorProject']();
			}
		}
		errors = next;
		if (Object.keys(next).length > 0 || yen === null) return null;
		const common = {
			bookedOn,
			amount: yen,
			taxKind: taxKind === '' ? null : taxKind,
			amountInTax: inTax,
			voucherNo: optionalText(voucherNo),
			description: optionalText(description),
			reason: optionalText(reason)
		};
		if (shape !== 'cost') {
			return {
				...common,
				entryKind: shape,
				refId: start?.refId ?? ref?.id ?? null,
				adjustmentKind: shape === 'adjustment' && adjustmentKind !== '' ? adjustmentKind : null,
				projectId: null,
				phaseId: null,
				costType: null,
				vendorId: null,
				purchaseOrderId: null,
				allocationBasis: null,
				allocations: []
			};
		}
		return {
			...common,
			entryKind: provisional ? 'provisional' : 'normal',
			projectId: split ? null : Number(projectId),
			phaseId: phaseId === '' ? null : Number(phaseId),
			costType: costType === '' ? null : costType,
			vendorId: vendorId === '' ? null : Number(vendorId),
			purchaseOrderId: split || orderId === '' ? null : Number(orderId),
			allocationBasis: split ? optionalText(basis) : null,
			allocations: split ? allocations : []
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

	async function save() {
		if (busy) return;
		const values = build();
		if (!values) return;
		const sending = JSON.stringify(values);
		if (requestFor !== null && requestFor !== sending) requestId = newRequestId();
		requestFor = sending;
		busy = true;
		try {
			const saved = start
				? await saveCost(start.id, { ...values, rowVersion: start.rowVersion })
				: await saveCost(null, { ...values, clientRequestId: requestId });
			requestId = newRequestId();
			requestFor = null;
			onSaved(saved);
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				applyServerErrors(err.body.field_errors);
			} else if (isForbiddenError(err)) {
				notify('error', m['costs.forbiddenEntry']());
			} else {
				notify('error', isProviderError(err) ? err.message : String(err));
			}
		} finally {
			busy = false;
		}
	}

	const OWN_FIELDS = [
		'bookedOn',
		'amount',
		'amountInTax',
		'projectId',
		'phaseId',
		'costType',
		'vendorId',
		'purchaseOrderId',
		'taxKind',
		'voucherNo',
		'description',
		'reason',
		'adjustmentKind',
		'allocationBasis',
		'allocations'
	];
	const otherErrors = $derived(
		Object.entries(errors)
			.filter(([field]) => !OWN_FIELDS.includes(field) && !field.startsWith('allocations.'))
			.map(([, message]) => message)
	);

	const title = $derived(
		shape === 'confirms'
			? m['costs.confirmTitle']()
			: shape === 'adjustment'
				? m['costs.adjustTitle']()
				: start
					? m['costs.editTitle']()
					: m['costs.addTitle']()
	);
	const refInfo = $derived(ref ?? null);
</script>

<form
	class="entry-form"
	aria-labelledby="cost-form-heading"
	onsubmit={(e) => {
		e.preventDefault();
		void save();
	}}
>
	<h2 id="cost-form-heading">{title}</h2>
	{#if refInfo}
		<p class="note">
			{m['costs.refInfo']({
				kind: kindLabel(refInfo),
				date: refInfo.bookedOn,
				amount: formatYen(refInfo.amount),
				target: refInfo.projectCode ?? ''
			})}
		</p>
	{/if}
	{#if start?.status === 'returned' && start.returnReason}
		<p class="returned" role="note">{m['time.returnedReason']({ reason: start.returnReason })}</p>
	{/if}
	{#each otherErrors as message (message)}
		<p class="error" role="alert">{message}</p>
	{/each}

	<div class="grid">
		<label class="field">
			<span>{m['costs.fieldBookedOn']()}</span>
			<input
				class="banto-input"
				type="date"
				bind:value={bookedOn}
				aria-invalid={!!errors.bookedOn}
			/>
			{#if errors.bookedOn}<span class="error">{errors.bookedOn}</span>{/if}
		</label>

		{#if shape === 'adjustment'}
			<label class="field">
				<span>{m['costs.fieldAdjustment']()}</span>
				<select
					class="banto-input"
					bind:value={adjustmentKind}
					aria-invalid={!!errors.adjustmentKind}
				>
					<option value="">{m['time.choose']()}</option>
					{#each ADJUSTMENT_KINDS as k (k)}
						<option value={k}>{adjustmentLabel(k)}</option>
					{/each}
				</select>
				{#if errors.adjustmentKind}<span class="error">{errors.adjustmentKind}</span>{/if}
			</label>
		{/if}

		{#if shape === 'cost'}
			<fieldset class="field kind">
				<legend>{m['costs.fieldTarget']()}</legend>
				<label
					><input type="radio" bind:group={split} value={false} />{m['costs.oneProject']()}</label
				>
				<label
					><input type="radio" bind:group={split} value={true} />{m['costs.splitProjects']()}</label
				>
			</fieldset>
			{#if !split}
				<label class="field">
					<span>{m['time.fieldProject']()}</span>
					<select class="banto-input" bind:value={projectId} aria-invalid={!!errors.projectId}>
						<option value="">{m['time.choose']()}</option>
						{#each projects as project (project.id)}
							<option value={String(project.id)}>{project.label}</option>
						{/each}
					</select>
					{#if errors.projectId}<span class="error">{errors.projectId}</span>{/if}
				</label>
				{#if orderChoices.length > 0}
					<label class="field">
						<span>{m['costs.fieldOrder']()}</span>
						<select
							class="banto-input"
							bind:value={orderId}
							aria-invalid={!!errors.purchaseOrderId}
						>
							<option value="">{m['costs.noOrder']()}</option>
							{#each orderChoices as o (o.id)}
								<option value={String(o.id)}
									>{m['costs.orderChoice']({
										date: o.orderedOn,
										vendor: o.vendorName ?? '',
										remaining: formatYen(o.remaining)
									})}</option
								>
							{/each}
						</select>
						{#if errors.purchaseOrderId}<span class="error">{errors.purchaseOrderId}</span>{/if}
					</label>
				{/if}
			{/if}
			<label class="field">
				<span>{m['costs.fieldCostType']()}</span>
				<select
					class="banto-input"
					bind:value={costType}
					disabled={orderId !== ''}
					aria-invalid={!!errors.costType}
				>
					<option value="">{orderId !== '' ? m['costs.fromOrder']() : m['time.choose']()}</option>
					{#each DIRECT_COST_TYPES as t (t)}
						<option value={t}>{costTypeLabel(t)}</option>
					{/each}
				</select>
				{#if errors.costType}<span class="error">{errors.costType}</span>{/if}
			</label>
			<label class="field">
				<span>{m['time.fieldPhase']()}</span>
				<select class="banto-input" bind:value={phaseId} aria-invalid={!!errors.phaseId}>
					<option value="">{m['budget.noPhase']()}</option>
					{#each phaseChoices as phase (phase.id)}
						<option value={String(phase.id)}>{phase.name}</option>
					{/each}
				</select>
				{#if errors.phaseId}<span class="error">{errors.phaseId}</span>{/if}
			</label>
			<label class="field">
				<span>{m['costs.fieldVendor']()}</span>
				<select class="banto-input" bind:value={vendorId} aria-invalid={!!errors.vendorId}>
					<option value="">{m['costs.noVendor']()}</option>
					{#each vendorChoices as v (v.id)}
						<option value={String(v.id)}>{v.name}</option>
					{/each}
				</select>
				{#if errors.vendorId}<span class="error">{errors.vendorId}</span>{/if}
			</label>
			<label class="field check">
				<input type="checkbox" bind:checked={provisional} disabled={split} />
				<span>{m['costs.fieldProvisional']()}</span>
			</label>
		{/if}

		<label class="field">
			<span>{shape === 'adjustment' ? m['costs.fieldReduction']() : m['costs.fieldAmount']()}</span>
			<input
				class="banto-input num"
				inputmode="numeric"
				bind:value={amount}
				aria-invalid={!!errors.amount}
			/>
			{#if errors.amount}<span class="error">{errors.amount}</span>{/if}
		</label>
		{#if shape !== 'adjustment'}
			<label class="field">
				<span>{m['costs.fieldTaxKind']()}</span>
				<select class="banto-input" bind:value={taxKind}>
					<option value="">{taxLabel(null)}</option>
					{#each TAX_KINDS as k (k)}
						<option value={k}>{taxLabel(k)}</option>
					{/each}
				</select>
				{#if errors.taxKind}<span class="error">{errors.taxKind}</span>{/if}
			</label>
			<label class="field">
				<span>{m['costs.fieldAmountInTax']()}</span>
				<input
					class="banto-input num"
					inputmode="numeric"
					bind:value={amountInTax}
					aria-invalid={!!errors.amountInTax}
				/>
				{#if errors.amountInTax}<span class="error">{errors.amountInTax}</span>{/if}
			</label>
		{/if}
		<label class="field">
			<span>{m['costs.fieldVoucher']()}</span>
			<input class="banto-input" bind:value={voucherNo} />
			{#if errors.voucherNo}<span class="error">{errors.voucherNo}</span>{/if}
		</label>

		{#if shape === 'cost' && split}
			<div class="field wide">
				<span id="cost-alloc-label">{m['costs.fieldAllocations']()}</span>
				<div class="alloc" role="group" aria-labelledby="cost-alloc-label">
					{#each lines as line, i (i)}
						<div class="alloc-line">
							<select
								class="banto-input"
								bind:value={line.projectId}
								aria-label={m['time.fieldProject']()}
								aria-invalid={!!errors[`allocations.${i}.projectId`]}
							>
								<option value="">{m['time.choose']()}</option>
								{#each projects as project (project.id)}
									<option value={String(project.id)}>{project.label}</option>
								{/each}
							</select>
							<input
								class="banto-input num"
								inputmode="numeric"
								bind:value={line.amount}
								aria-label={m['costs.fieldAllocationAmount']()}
								aria-invalid={!!errors[`allocations.${i}.amount`]}
							/>
							{#if lines.length > 2}
								<button
									type="button"
									class="banto-btn banto-btn--ghost"
									onclick={() => (lines = lines.filter((_, j) => j !== i))}
									>{m['budget.removeLine']()}</button
								>
							{/if}
							{#if errors[`allocations.${i}.projectId`] || errors[`allocations.${i}.amount`]}
								<span class="error"
									>{errors[`allocations.${i}.projectId`] ?? errors[`allocations.${i}.amount`]}</span
								>
							{/if}
						</div>
					{/each}
					<div class="alloc-foot">
						<button
							type="button"
							class="banto-btn banto-btn--secondary"
							onclick={() => (lines = [...lines, { projectId: '', amount: '' }])}
							>{m['costs.addAllocation']()}</button
						>
						<span class:error={rest !== 0 && rest !== null}
							>{m['costs.allocationRest']({
								rest: rest === null ? '—' : formatSignedYen(rest)
							})}</span
						>
					</div>
					{#if errors.allocations}<span class="error">{errors.allocations}</span>{/if}
				</div>
				<label class="field">
					<span>{m['costs.fieldAllocationBasis']()}</span>
					<input class="banto-input" bind:value={basis} />
				</label>
			</div>
		{/if}

		{#if shape !== 'cost'}
			<label class="field wide">
				<span>{m['costs.fieldReason']()}</span>
				<input class="banto-input" bind:value={reason} aria-invalid={!!errors.reason} />
				{#if errors.reason}<span class="error">{errors.reason}</span>{/if}
			</label>
		{/if}
		<label class="field wide">
			<span>{m['costs.fieldDescription']()}</span>
			<textarea class="banto-input" rows="2" bind:value={description}></textarea>
			{#if errors.description}<span class="error">{errors.description}</span>{/if}
		</label>
	</div>

	<div class="actions">
		<button type="submit" class="banto-btn banto-btn--primary" disabled={busy}>
			{start ? m['time.saveChanges']() : m['time.saveDraft']()}
		</button>
		<button type="button" class="banto-btn banto-btn--ghost" disabled={busy} onclick={onCancel}>
			{m['common.cancel']()}
		</button>
	</div>
</form>

<style>
	.entry-form {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-lg);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: var(--banto-space-3);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
		border: 0;
		margin: 0;
		padding: 0;
	}

	.field input,
	.field select,
	.field textarea {
		color: var(--banto-text);
	}

	.field.wide {
		grid-column: 1 / -1;
	}

	.field.check {
		flex-direction: row;
		align-items: center;
		gap: var(--banto-space-2);
		color: var(--banto-text);
	}

	.kind label {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-1);
		margin-right: var(--banto-space-3);
		color: var(--banto-text);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.alloc {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
	}

	.alloc-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.alloc-line select {
		flex: 1 1 16rem;
	}

	.alloc-line input {
		width: 10rem;
	}

	.alloc-foot {
		display: flex;
		align-items: center;
		gap: var(--banto-space-3);
		color: var(--banto-text);
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

	.returned {
		margin: 0;
		color: var(--banto-warning-tint-text);
		font-size: var(--banto-font-size-sm);
	}

	.actions {
		display: flex;
		gap: var(--banto-space-2);
	}
</style>
