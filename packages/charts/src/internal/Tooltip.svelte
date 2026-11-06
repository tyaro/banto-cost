<script lang="ts">
	/**
	 * Shared hover tooltip (spec §6 rule 6): absolutely-positioned HTML div
	 * inside the chart container, positioned near the cursor and flipped to
	 * stay inside the container's bounds. Values are right-aligned with
	 * tabular-nums; a colored swatch (not colored text) marks each series.
	 */
	import type { TooltipRow } from '../types';

	interface Props {
		/** Anchor point (usually the cursor / nearest-mark position), in container-local px. */
		x: number;
		y: number;
		containerWidth: number;
		containerHeight: number;
		title?: string;
		rows: TooltipRow[];
	}

	let { x, y, containerWidth, containerHeight, title, rows }: Props = $props();

	const OFFSET = 12;
	// Rough size estimate for flip decisions; exact pixel overflow doesn't
	// matter here since we always clamp to >= 0 below too.
	const ESTIMATED_WIDTH = 180;
	const estimatedHeight = $derived(28 + rows.length * 18 + (title ? 16 : 0));

	const left = $derived(
		x + OFFSET + ESTIMATED_WIDTH > containerWidth
			? Math.max(0, x - OFFSET - ESTIMATED_WIDTH)
			: x + OFFSET
	);
	const top = $derived(
		y + OFFSET + estimatedHeight > containerHeight
			? Math.max(0, y - OFFSET - estimatedHeight)
			: y + OFFSET
	);
</script>

<div class="chart-tooltip" style:left={`${left}px`} style:top={`${top}px`}>
	{#if title}<div class="tt-title">{title}</div>{/if}
	{#each rows as row (row.label)}
		<div class="tt-row">
			{#if row.colorVar}<span class="tt-swatch" style:background={row.colorVar}></span>{/if}
			<span class="tt-label">{row.label}</span>
			<span class="tt-value">{row.value}</span>
		</div>
	{/each}
</div>

<style>
	.chart-tooltip {
		position: absolute;
		pointer-events: none;
		z-index: 20;
		max-width: 220px;
		background: var(--banto-surface-overlay);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		padding: 0.45rem 0.6rem;
		font-size: 12px;
		color: var(--banto-text);
		box-shadow: var(--banto-shadow-md);
		/* Glass preset: the overlay surface goes translucent there - blur what's
		   behind so the text stays readable. No-op under standard. */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}

	.tt-title {
		color: var(--banto-text-muted);
		margin-bottom: 0.25rem;
		white-space: nowrap;
	}

	.tt-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.tt-swatch {
		width: 8px;
		height: 8px;
		border-radius: 2px;
		flex: 0 0 auto;
	}

	.tt-label {
		color: var(--banto-text-muted);
		white-space: nowrap;
	}

	.tt-value {
		margin-left: auto;
		padding-left: 0.75rem;
		color: var(--banto-text);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
</style>
