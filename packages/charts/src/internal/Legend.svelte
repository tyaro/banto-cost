<script lang="ts">
	/**
	 * Series legend (spec §6 rule 5): rendered only when there are >= 2
	 * series - a single-series chart's identity is already named by the card
	 * title, so no legend is shown. Text is always --banto-text-muted; the
	 * colored swatch (not the text) carries series identity (rule 4).
	 */
	interface LegendItem {
		id: string;
		label: string;
		colorVar: string;
	}

	interface Props {
		items: LegendItem[];
	}

	let { items }: Props = $props();
</script>

{#if items.length >= 2}
	<div class="chart-legend">
		{#each items as item (item.id)}
			<span class="legend-item">
				<span class="legend-swatch" style:background={item.colorVar}></span>
				<span class="legend-label">{item.label}</span>
			</span>
		{/each}
	</div>
{/if}

<style>
	.chart-legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-3);
		font-size: var(--banto-font-size-sm);
		line-height: 1;
		color: var(--banto-text-muted);
		padding: 0 var(--banto-space-1) var(--banto-space-2);
	}

	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-1);
	}

	.legend-swatch {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		flex: 0 0 auto;
	}

	.legend-label {
		white-space: nowrap;
	}
</style>
