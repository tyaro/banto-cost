<script lang="ts">
	/**
	 * The fiscal period of a month, shown next to a month field's label as
	 * `（第13期）` (banto-cost P8d, review §3.2 U-5). The period comes from the
	 * server's calendar; nothing is shown before it is loaded, in demo mode,
	 * or while the month is empty or incomplete.
	 */
	import { periodName } from '#lib/banto/businessCalendar.svelte.js';

	let { month }: { month: string | null | undefined } = $props();

	const name = $derived(month ? periodName(month) : '');
</script>

{#if name}<span class="period-hint">（{name}）</span>{/if}

<style>
	.period-hint {
		color: var(--banto-text-muted);
		font-weight: normal;
	}
</style>
