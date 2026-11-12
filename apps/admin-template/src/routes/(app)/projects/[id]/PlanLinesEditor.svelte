<script lang="ts" module>
	/** One editable revenue-plan line; amounts stay text until the caller parses them. */
	export interface PlanLineDraft {
		key: number;
		month: string;
		undecided: boolean;
		amount: string;
	}

	const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
	let nextKey = 0;

	export function newPlanLine(month = '', amount = '', undecided = false): PlanLineDraft {
		return { key: ++nextKey, month, undecided, amount };
	}

	/**
	 * Parse the drafts. Returns `null` when a line is invalid (amount not a
	 * non-negative integer, or a month that is neither `YYYY-MM` nor 時期未定).
	 */
	export function parsePlanLines(
		lines: readonly PlanLineDraft[]
	): { month: string | null; amount: number }[] | null {
		const out: { month: string | null; amount: number }[] = [];
		for (const line of lines) {
			const raw = line.amount.trim();
			const amount = Number(raw);
			if (raw === '' || !Number.isInteger(amount) || amount < 0) return null;
			if (!line.undecided && !MONTH_RE.test(line.month.trim())) return null;
			out.push({ month: line.undecided ? null : line.month.trim(), amount });
		}
		return out;
	}

	/** Sum of the parseable amounts (for the running total next to the target). */
	export function planTotal(lines: readonly PlanLineDraft[]): number {
		return lines.reduce((sum, line) => {
			const value = Number(line.amount.trim());
			return Number.isInteger(value) ? sum + value : sum;
		}, 0);
	}
</script>

<script lang="ts">
	/**
	 * Revenue-plan lines (month or 時期未定 + amount) for the order conversion
	 * and re-planning forms (banto-cost P3b). 時期未定 is its own line and is
	 * never spread over months (spec §7.5).
	 */
	import { Plus, Trash2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { formatYen } from '#lib/banto/costFormat.js';

	interface Props {
		lines: PlanLineDraft[];
		legend: string;
		description?: string;
		/** The total the lines must add up to (shown with the running sum). */
		target?: number | null;
		disabled?: boolean;
		error?: string;
	}

	let {
		lines = $bindable(),
		legend,
		description,
		target = null,
		disabled = false,
		error
	}: Props = $props();

	const total = $derived(planTotal(lines));
</script>

<fieldset class="plan">
	<legend>{legend}</legend>
	{#if description}<p class="note">{description}</p>{/if}
	{#each lines as line, index (line.key)}
		<div class="plan-row">
			<label class="field">
				<span>{m['pipeline.planMonth']()}</span>
				<input
					class="banto-input"
					type="month"
					placeholder="YYYY-MM"
					bind:value={line.month}
					disabled={disabled || line.undecided}
				/>
			</label>
			<label class="check">
				<input type="checkbox" bind:checked={line.undecided} {disabled} />
				{m['pipeline.timeUndecided']()}
			</label>
			<label class="field">
				<span>{m['pipeline.planAmount']()}</span>
				<input
					class="banto-input"
					type="text"
					inputmode="numeric"
					bind:value={line.amount}
					{disabled}
				/>
			</label>
			<button
				type="button"
				class="banto-btn banto-btn--ghost"
				aria-label={m['pipeline.planRemove']({ line: index + 1 })}
				{disabled}
				onclick={() => (lines = lines.filter((l) => l.key !== line.key))}
			>
				<Trash2 size={16} aria-hidden="true" />
			</button>
		</div>
	{/each}
	<p class="note" class:mismatch={target !== null && total !== target}>
		{#if target !== null}
			{m['orders.planTotalVsTarget']({ total: formatYen(total), target: formatYen(target) })}
		{:else}
			{m['orders.planTotal']({ total: formatYen(total) })}
		{/if}
	</p>
	{#if error}<p class="error">{error}</p>{/if}
	<button
		type="button"
		class="banto-btn banto-btn--ghost"
		{disabled}
		onclick={() => (lines = [...lines, newPlanLine()])}
	>
		<Plus size={16} aria-hidden="true" />
		{m['pipeline.planAdd']()}
	</button>
</fieldset>

<style>
	.plan {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		margin: 0;
		padding: var(--banto-space-3);
		border: var(--banto-border-width) solid var(--banto-border);
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

	.check {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		height: var(--banto-control-height);
		font-size: var(--banto-font-size-sm);
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.mismatch {
		color: var(--banto-warning-tint-text);
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
	}

	.plan > .banto-btn {
		align-self: flex-start;
	}
</style>
