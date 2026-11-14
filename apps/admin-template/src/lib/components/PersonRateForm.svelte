<script lang="ts">
	/**
	 * A new personal-rate row (個人別単価, design 10.9, T43): the person's
	 * hourly cost rate for every project (`projectId: null`) or for one
	 * project, or the end of it ("個人の単価をやめる" - the next level applies
	 * again: the person's rate, the project's override, the company standard).
	 *
	 * Same two-step save as CalcBasisForm.svelte: "影響を確認" asks the server
	 * what the row would change (the rate before/after on the date, drafts
	 * costed with it at approval, approved entries that become 当て直しの候補),
	 * and "保存" is enabled only while the inputs still match the previewed
	 * ones. Nothing is overwritten; a reason is required. The server decides
	 * who may save (`finance.rate` + `amount.view`).
	 */
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import {
		addPersonRate,
		previewPersonRate,
		type PersonRateInput,
		type PersonRatePreview
	} from '#lib/banto/personRatesAdmin.js';
	import { formatCalcValue, isForbiddenError, todayIso } from '#lib/banto/costFormat.js';

	interface Props {
		userId: number;
		displayName: string;
		/** Projects that can carry a rate of their own. */
		projects: { value: number; label: string }[];
		onSaved: () => void;
		onCancel: () => void;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { userId, displayName, projects, onSaved, onCancel, onPendingChange }: Props = $props();

	const UNIT = 'yen_per_hour';
	/** `''` = every project. */
	let scope = $state('');
	let value = $state('');
	let ending = $state(false);
	let validFrom = $state(todayIso());
	let reason = $state('');
	let errors = $state<Record<string, string>>({});
	let preview = $state<PersonRatePreview | null>(null);
	let previewedFor = $state('');
	let busy = $state(false);

	function snapshot(): string {
		return JSON.stringify([scope, value, ending, validFrom, reason]);
	}
	const initial = snapshot();
	$effect(() => {
		onPendingChange?.({ dirty: snapshot() !== initial, busy });
	});
	const previewCurrent = $derived(preview !== null && previewedFor === snapshot());

	function buildInput(): PersonRateInput | null {
		const next: Record<string, string> = {};
		let parsed: number | null = null;
		if (!ending) {
			const trimmed = value.trim();
			const n = Number(trimmed);
			if (trimmed === '' || !Number.isInteger(n) || n <= 0) {
				next.value = m['personRates.errorRate']();
			} else {
				parsed = n;
			}
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) next.validFrom = m['calcBasis.errorDate']();
		if (reason.trim() === '') next.reason = m['calcBasis.errorReason']();
		errors = next;
		if (Object.keys(next).length > 0) return null;
		return {
			userId,
			projectId: scope === '' ? null : Number(scope),
			validFrom,
			value: parsed,
			reason: reason.trim()
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

	function fail(err: unknown) {
		if (isProviderError(err) && err.body.kind === 'validation') {
			applyServerErrors(err.body.field_errors);
		} else if (isForbiddenError(err)) {
			notify('error', m['personRates.forbiddenChange']());
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
			preview = await previewPersonRate(input);
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
			await addPersonRate(input);
			notify('success', m['personRates.saved']());
			onSaved();
		} catch (err) {
			fail(err);
		} finally {
			busy = false;
		}
	}

	const otherErrors = $derived(
		Object.entries(errors)
			.filter(([field]) => !['value', 'validFrom', 'reason', 'projectId'].includes(field))
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
	<h4>{m['personRates.changeTitle']({ name: displayName })}</h4>
	<p class="note">{m['personRates.changeDesc']()}</p>
	{#each otherErrors as message, i (i)}
		<p class="error" role="alert">{message}</p>
	{/each}
	<div class="fields">
		<label class="field">
			<span>{m['personRates.fieldScope']()}</span>
			<select class="banto-input" bind:value={scope} disabled={busy}>
				<option value="">{m['personRates.scopeAll']()}</option>
				{#each projects as p (p.value)}
					<option value={String(p.value)}>{p.label}</option>
				{/each}
			</select>
			{#if errors.projectId}<span class="error">{errors.projectId}</span>{/if}
		</label>
		<label class="check field--wide">
			<input type="checkbox" bind:checked={ending} disabled={busy} />
			{m['personRates.endRate']()}
		</label>
		{#if !ending}
			<label class="field">
				<span>{m['calcBasis.fieldValueUnit']({ unit: m['calcBasis.suffix.yenPerHour']() })}</span>
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
					<dt>{m['personRates.impactBefore']()}</dt>
					<dd>{formatCalcValue(preview.before, UNIT)}</dd>
				</div>
				<div>
					<dt>{m['personRates.impactAfter']()}</dt>
					<dd>{formatCalcValue(preview.after, UNIT)}</dd>
				</div>
				<div>
					<dt>{m['calcBasis.impactAffected']()}</dt>
					<dd>{m['calcBasis.countProjects']({ count: preview.affectedProjects })}</dd>
				</div>
				<div>
					<dt>{m['calcBasis.impactPending']()}</dt>
					<dd>{m['calcBasis.countRecords']({ count: preview.pending })}</dd>
				</div>
				<div>
					<dt>{m['personRates.impactCandidates']()}</dt>
					<dd>{m['calcBasis.countRecords']({ count: preview.correctionCandidates })}</dd>
				</div>
			</dl>
			{#if preview.includesClosed}
				<p class="error">{m['personRates.impactClosed']()}</p>
			{/if}
			<p class="note">{m['personRates.impactNote']()}</p>
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
	.field textarea,
	.field select {
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
