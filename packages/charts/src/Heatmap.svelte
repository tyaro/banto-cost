<script lang="ts" generics="TRow">
	/**
	 * Heatmap (spec §6.1 v2 chart types): two categorical axes (x, y), one
	 * numeric value per (x, y) cell, encoded as a SEQUENTIAL (single-hue,
	 * light -> dark) color ramp (spec §6.4 rule 9) - never the categorical
	 * `seriesColorVar` slots, since a cell's color here is a magnitude, not an
	 * entity. Category order on both axes is FIRST-APPEARANCE order in `data`
	 * (see `core/heatmap.ts`); callers wanting a specific order (e.g. a fixed
	 * weekday sequence) control it by pre-sorting `data`.
	 */
	import { bandScale } from './core/scale';
	import { heatmapGrid, heatmapCellKey } from './core/heatmap';
	import { sequentialColor, SEQ_RAMP } from './core/color';
	import { everyNthIndex } from './core/ticks-time';
	import { leftMarginFor } from './core/labels';
	import type { Accessor, ChartMargin } from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import type { ChartMessages } from './messages';

	interface Props {
		data: TRow[];
		x: Accessor<TRow>;
		y: Accessor<TRow>;
		value: Accessor<TRow>;
		label: string;
		height?: number;
		formatValue?: (n: number) => string;
		ramp?: string[];
		/** i18n layer 1 (docs/conventions.md §13): overrides forwarded to `ChartContainer`'s empty-state text. Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		data,
		x,
		y,
		value,
		label,
		height = 260,
		formatValue,
		ramp,
		messages = {}
	}: Props = $props();

	const MIN_X_TICK_SPACING = 32;

	const formatValueDisplay = $derived(formatValue ?? ((n: number) => n.toLocaleString()));
	const rampColors = $derived(ramp ?? [...SEQ_RAMP]);

	const grid = $derived(heatmapGrid(data, x, y, value));
	const isEmpty = $derived(grid.xCats.length === 0 || grid.yCats.length === 0);

	const MARGIN = $derived.by((): ChartMargin => {
		return { top: 8, right: 16, bottom: 26, left: leftMarginFor(grid.yCats) };
	});

	function maxXTicksFor(innerWidth: number): number {
		return Math.max(2, Math.floor(innerWidth / MIN_X_TICK_SPACING));
	}

	function plotMetrics(width: number, plotHeight: number) {
		return {
			innerLeft: MARGIN.left,
			innerTop: MARGIN.top,
			innerWidth: Math.max(0, width - MARGIN.left - MARGIN.right),
			innerHeight: Math.max(0, plotHeight - MARGIN.top - MARGIN.bottom)
		};
	}

	let hovered: { xIndex: number; yIndex: number } | null = $state(null);

	function cellValue(xIndex: number, yIndex: number): number | undefined {
		return grid.cells.get(heatmapCellKey(grid.xCats[xIndex], grid.yCats[yIndex]));
	}
</script>

<div class="banto-heatmap">
	<ChartContainer {label} {height} empty={isEmpty} {messages}>
		{#snippet plot({ width, height: plotHeight })}
			{@const m = plotMetrics(width, plotHeight)}
			{@const xScale = bandScale(grid.xCats.length, [m.innerLeft, m.innerLeft + m.innerWidth], 0)}
			{@const yScale = bandScale(grid.yCats.length, [m.innerTop, m.innerTop + m.innerHeight], 0)}

			<!-- Cells: sequential single-hue encoding (rule 5), 1px surface-color gap between cells via stroke. -->
			{#each grid.yCats as _yCat, yIndex (yIndex)}
				{#each grid.xCats as _xCat, xIndex (xIndex)}
					{@const v = cellValue(xIndex, yIndex)}
					{#if v !== undefined}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<rect
							x={xScale.start(xIndex)}
							y={yScale.start(yIndex)}
							width={xScale.bandwidth}
							height={yScale.bandwidth}
							fill={sequentialColor(v, grid.min, grid.max, rampColors)}
							stroke={hovered && hovered.xIndex === xIndex && hovered.yIndex === yIndex
								? 'var(--banto-text)'
								: 'var(--banto-surface)'}
							stroke-width={hovered && hovered.xIndex === xIndex && hovered.yIndex === yIndex
								? 1.5
								: 1}
							class="cell"
							onpointerenter={() => (hovered = { xIndex, yIndex })}
							onpointerleave={() => (hovered = null)}
						/>
					{/if}
				{/each}
			{/each}

			<!-- Y labels (left), X labels (bottom, thinned when crowded). -->
			{#each grid.yCats as yCat, i (i)}
				<text
					x={m.innerLeft - 8}
					y={yScale.center(i)}
					class="tick-label"
					text-anchor="end"
					dominant-baseline="middle"
				>
					{yCat}
				</text>
			{/each}
			{@const xTickIndices = everyNthIndex(grid.xCats.length, maxXTicksFor(m.innerWidth))}
			{#each xTickIndices as i (i)}
				<text
					x={xScale.center(i)}
					y={m.innerTop + m.innerHeight + 16}
					class="tick-label"
					text-anchor="middle"
				>
					{grid.xCats[i]}
				</text>
			{/each}
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hovered}
				{@const m = plotMetrics(width, plotHeight)}
				{@const xScale = bandScale(grid.xCats.length, [m.innerLeft, m.innerLeft + m.innerWidth], 0)}
				{@const yScale = bandScale(grid.yCats.length, [m.innerTop, m.innerTop + m.innerHeight], 0)}
				{@const v = cellValue(hovered.xIndex, hovered.yIndex)}
				{#if v !== undefined}
					<Tooltip
						x={xScale.center(hovered.xIndex)}
						y={yScale.center(hovered.yIndex)}
						containerWidth={width}
						containerHeight={plotHeight}
						rows={[
							{
								label: `${grid.yCats[hovered.yIndex]} / ${grid.xCats[hovered.xIndex]}`,
								value: formatValueDisplay(v)
							}
						]}
					/>
				{/if}
			{/if}
		{/snippet}
	</ChartContainer>
	{#if !isEmpty}
		<div class="ramp-legend">
			<span class="ramp-label">{formatValueDisplay(grid.min)}</span>
			<span
				class="ramp-bar"
				style:background={`linear-gradient(to right, ${rampColors.join(', ')})`}
			></span>
			<span class="ramp-label">{formatValueDisplay(grid.max)}</span>
		</div>
	{/if}
</div>

<style>
	.banto-heatmap {
		width: 100%;
	}

	.cell {
		cursor: default;
	}

	.tick-label {
		fill: var(--banto-text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.ramp-legend {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.25rem 0;
	}

	.ramp-label {
		color: var(--banto-text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		flex: 0 0 auto;
	}

	.ramp-bar {
		flex: 1 1 auto;
		height: 8px;
		border-radius: 4px;
		max-width: 160px;
	}
</style>
