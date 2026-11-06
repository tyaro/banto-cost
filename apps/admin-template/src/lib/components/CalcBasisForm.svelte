<script lang="ts">
	/**
	 * A new calc-basis row (design 第10章, banto-cost P4a): the company value
	 * of an item (`projectId: null`) or a project's override / revert.
	 *
	 * Saving is a two-step action: "影響を確認" asks the server what the row
	 * would change (design 10.5 - value before/after, projects kept by their
	 * own override, records costed with it), and "保存" is enabled only while
	 * the inputs still match the previewed ones. Nothing is overwritten: the
	 * row is added with its effective date and the old ones stay as history.
	 * A reason is required. The server decides who may save (the item's
	 * capability, or the project's manager where the item allows it); a
	 * refusal is shown as a notice.
	 */
	import { untrack } from 'svelte';
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import {
		addCalcValue,
		previewCalcValue,
		type CalcItem,
		type CalcValueInput,
		type ImpactPreview
	} from '#lib/banto/calcBasisAdmin.js';
	import {
		calcItemLabel,
		calcUnitSuffix,
		formatCalcValue,
		isForbiddenError,
		todayIso
	} from '#lib/banto/costFormat.js';

	interface Props {
		item: CalcItem;
		/** `null` = the company basis. */
		projectId: number | null;
		/** Project only: start in "back to the company basis" mode. */
		revert?: boolean;
		onSaved: () => void;
		onCancel: () => void;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { item, projectId, revert = false, onSaved, onCancel, onPendingChange }: Props = $props();

	let value = $state('');
	// The parent keys this form on the item and mode, so the initial mode is read once.
	let reverting = $state(untrack(() => revert && projectId !== null));
	let validFrom = $state(todayIso());
	let reason = $state('');
	let errors = $state<Record<string, string>>({});
	let preview = $state<ImpactPreview | null>(null);
	let previewedFor = $state('');
	let busy = $state(false);

	function snapshot(): string {
		return JSON.stringify([value, reverting, validFrom, reason]);
	}
	const initial = snapshot();
	$effect(() => {
		onPendingChange?.({ dirty: snapshot() !== initial, busy });
	});
	const previewCurrent = $derived(preview !== null && previewedFor === snapshot());

	function buildInput(): CalcValueInput | null {
		const next: Record<string, string> = {};
		let parsed: number | null = null;
		if (!reverting) {
			const trimmed = value.trim();
			const n = Number(trimmed);
			if (trimmed === '' || !Number.isInteger(n)) {
				next.value = m['calcBasis.errorInteger']();
			} else {
				parsed = n;
			}
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) next.validFrom = m['calcBasis.errorDate']();
		if (reason.trim() === '') next.reason = m['calcBasis.errorReason']();
		errors = next;
		if (Object.keys(next).length > 0) return null;
		return { itemKey: item.key, validFrom, value: parsed, reason: reason.trim() };
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

	function fail(err: unknown) {
		if (isProviderError(err) && err.body.kind === 'validation') {
			applyServerErrors(err.body.field_errors);
		} else if (isForbiddenError(err)) {
			notify('error', m['calcBasis.forbiddenChange']());
		} else {
			notify('error', isProviderError(err) ? err.message : String(err));
		}
	}

	async function checkImpact() {
		if (busy) return;
		const input = buildInput();
		if (!input) return;
		busy = true;
		try {
			preview = await previewCalcValue(projectId, input);
			previewedFor = snapshot();
		} catch (err) {
			preview = null;
			fail(err);
		} finally {
			busy = false;
		}
	}

	async function save() {
		if (busy || !previewCurrent) return;
		const input = buildInput();
		if (!input) return;
		busy = true;
		try {
			await addCalcValue(projectId, input);
			notify('success', m['calcBasis.saved']());
			onSaved();
		} catch (err) {
			fail(err);
		} finally {
			busy = false;
		}
	}

	const otherErrors = $derived(
		Object.entries(errors)
			.filter(([field]) => !['value', 'validFrom', 'reason'].includes(field))
			.map(([, message]) => message)
	);
</script>

<form
	class="calc-form"
	novalidate
	onsubmit={(event) => {
		event.preventDefault();
		void (previewCurrent ? save() : checkImpact());
	}}
>
	<h4>
		{projectId === null
			? m['calcBasis.changeCompanyTitle']({ item: calcItemLabel(item) })
			: m['calcBasis.changeProjectTitle']({ item: calcItemLabel(item) })}
	</h4>
	<p class="note">{m['calcBasis.changeDesc']()}</p>
	{#each otherErrors as message, i (i)}
		<p class="error" role="alert">{message}</p>
	{/each}
	<div class="fields">
		{#if projectId !== null}
			<label class="check field--wide">
				<input type="checkbox" bind:checked={reverting} disabled={busy} />
				{m['calcBasis.revertToCompany']()}
			</label>
		{/if}
		{#if !reverting}
			<label class="field">
				<span>{m['calcBasis.fieldValueUnit']({ unit: calcUnitSuffix(item.unit) })}</span>
				<input
					class="banto-input"
					type="text"
					inputmode="numeric"
					bind:value
					disabled={busy}
					aria-invalid={!!errors.value}
				/>
				{#if errors.value}<span class="error">{errors.value}</span>{/if}
			</label>
		{/if}
		<label class="field">
			<span>{m['calcBasis.fieldValidFrom']()}</span>
			<input
				class="banto-input"
				type="date"
				bind:value={validFrom}
				disabled={busy}
				aria-invalid={!!errors.validFrom}
			/>
			{#if errors.validFrom}<span class="error">{errors.validFrom}</span>{/if}
		</label>
		<label class="field field--wide">
			<span>{m['calcBasis.fieldReason']()}</span>
			<textarea
				class="banto-input textarea"
				rows="2"
				maxlength="1000"
				bind:value={reason}
				disabled={busy}
				aria-invalid={!!errors.reason}></textarea>
			{#if errors.reason}<span class="error">{errors.reason}</span>{/if}
		</label>
	</div>

	{#if preview && previewCurrent}
		<div class="impact" role="status">
			<h5>{m['calcBasis.impactTitle']()}</h5>
			<dl>
				<div>
					<dt>{m['calcBasis.impactBefore']()}</dt>
					<dd>{formatCalcValue(preview.before, item.unit)}</dd>
				</div>
				<div>
					<dt>{m['calcBasis.impactAfter']()}</dt>
					<dd>{formatCalcValue(preview.after, item.unit)}</dd>
				</div>
				<div>
					<dt>{m['calcBasis.impactAffected']()}</dt>
					<dd>{m['calcBasis.countProjects']({ count: preview.affectedProjects })}</dd>
				</div>
				{#if projectId === null}
					<div>
						<dt>{m['calcBasis.impactShielded']()}</dt>
						<dd>
							{m['calcBasis.countProjects']({ count: preview.shieldedProjects.length })}
							{#if preview.shieldedProjects.length > 0}
								<span class="sub"
									>{m['calcBasis.shieldedCodes']({
										codes: preview.shieldedProjects.map((p) => p.code).join(', ')
									})}</span
								>
							{/if}
						</dd>
					</div>
				{/if}
				<div>
					<dt>{m['calcBasis.impactPending']()}</dt>
					<dd>{m['calcBasis.countRecords']({ count: preview.pending })}</dd>
				</div>
				<div>
					<dt>{m['calcBasis.impactCorrections']()}</dt>
					<dd>{m['calcBasis.countRecords']({ count: preview.correctionCandidates })}</dd>
				</div>
			</dl>
			{#if preview.includesClosed}
				<p class="error">{m['calcBasis.impactClosed']()}</p>
			{/if}
			<p class="note">{m['calcBasis.impactNote']()}</p>
		</div>
	{/if}

	<div class="actions">
		<button type="button" class="banto-btn banto-btn--ghost" disabled={busy} onclick={onCancel}>
			{m['common.cancel']()}
		</button>
		<button
			type="button"
			class="banto-btn banto-btn--secondary"
			disabled={busy}
			onclick={() => void checkImpact()}
		>
			{m['calcBasis.checkImpact']()}
		</button>
		<button
			type="button"
			class="banto-btn banto-btn--primary"
			disabled={busy || !previewCurrent}
			onclick={() => void save()}
		>
			{m['common.save']()}
		</button>
	</div>
</form>

<style>
	.calc-form {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		padding: var(--banto-space-3);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	h4,
	h5 {
		margin: 0;
		font-size: var(--banto-font-size-md);
	}

	h5 {
		font-size: var(--banto-font-size-sm);
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

	.check {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
	}

	.impact {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		padding: var(--banto-space-3);
		background: var(--banto-surface-subtle);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.impact dl {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: var(--banto-space-2);
		margin: 0;
	}

	.impact dt {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.impact dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-2);
		justify-content: flex-end;
	}
</style>
