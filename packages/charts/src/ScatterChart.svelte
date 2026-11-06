<script lang="ts" generics="TRow">
	/**
	 * Scatter chart (spec §6): single series of x/y points. Points render at
	 * 60% opacity by default (helps overlapping points stay legible in dense
	 * datasets) with an 8px-diameter mark, meeting rule 3's >= 8px hover-target
	 * minimum without a separate invisible hit-circle.
	 */
	import { linearScale, niceTicks } from './core/scale';
	import { leftMarginForTicks } from './core/labels';
	import { seriesColorVar } from './core/color';
	import { getValue, toNumber, type Accessor, type ChartMargin } from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import type { ChartMessages } from './messages';

	interface Props {
		data: TRow[];
		x: Accessor<TRow>;
		y: Accessor<TRow>;
		pointLabel?: (row: TRow) => string;
		label: string;
		height?: number;
		formatX?: (v: unknown) => string;
		formatY?: (v: unknown) => string;
		/** Per-side overrides merged over the defaults below. */
		margins?: Partial<ChartMargin>;
		/** i18n layer 1 (docs/conventions.md §13): overrides forwarded to `ChartContainer`'s empty-state text. Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		data,
		x,
		y,
		pointLabel,
		label,
		height = 240,
		formatX,
		formatY,
		margins,
		messages = {}
	}: Props = $props();

	const DEFAULT_MARGIN: ChartMargin = { top: 12, right: 16, bottom: 28, left: 48 };
	// Left margin auto-expands to fit the y tick labels (never below the
	// caller's/default left margin, so labels that already fit are unchanged).
	// Measured container width (bound from ChartContainer) so the margin cap can
	// be relative to it, same as LineChart/StackedAreaChart.
	let plotWidth: number = $state(0);
	const MARGIN = $derived.by(() => {
		const m = { ...DEFAULT_MARGIN, ...margins };
		return {
			...m,
			left: leftMarginForTicks(
				yTicks.map((t) => formatYValue(t)),
				m.left,
				{ totalWidth: plotWidth }
			)
		};
	});
	const POINT_RADIUS = 4;
	const HOVER_RADIUS = 6;

	const formatXValue = $derived(formatX ?? ((v: unknown) => String(v ?? '')));
	const formatYValue = $derived(formatY ?? ((v: unknown) => String(v ?? '')));

	interface Sample {
		row: TRow;
		xValue: number;
		yValue: number;
	}

	const samples = $derived.by(() => {
		const result: Sample[] = [];
		for (const row of data) {
			const xValue = toNumber(getValue(row, x));
			const yValue = toNumber(getValue(row, y));
			if (Number.isFinite(xValue) && Number.isFinite(yValue)) result.push({ row, xValue, yValue });
		}
		return result;
	});

	const isEmpty = $derived(samples.length === 0);

	const xTicks = $derived(
		isEmpty
			? [0, 1]
			: niceTicks(
					Math.min(...samples.map((s) => s.xValue)),
					Math.max(...samples.map((s) => s.xValue)),
					5
				)
	);
	const yTicks = $derived(
		isEmpty
			? [0, 1]
			: niceTicks(
					Math.min(...samples.map((s) => s.yValue)),
					Math.max(...samples.map((s) => s.yValue)),
					5
				)
	);

	function plotMetrics(width: number, plotHeight: number) {
		return {
			innerLeft: MARGIN.left,
			innerTop: MARGIN.top,
			innerWidth: Math.max(0, width - MARGIN.left - MARGIN.right),
			innerHeight: Math.max(0, plotHeight - MARGIN.top - MARGIN.bottom)
		};
	}

	let hoveredIndex: number | null = $state(null);
</script>

<div class="banto-scatterchart">
	<ChartContainer {label} {height} empty={isEmpty} bind:width={plotWidth} {messages}>
		{#snippet plot({ width, height: plotHeight })}
			{@const m = plotMetrics(width, plotHeight)}
			{@const xScale = linearScale(
				[xTicks[0], xTicks[xTicks.length - 1]],
				[m.innerLeft, m.innerLeft + m.innerWidth]
			)}
			{@const yScale = linearScale(
				[yTicks[0], yTicks[yTicks.length - 1]],
				[m.innerTop + m.innerHeight, m.innerTop]
			)}

			{#each yTicks as tick (tick)}
				<line
					x1={m.innerLeft}
					x2={m.innerLeft + m.innerWidth}
					y1={yScale(tick)}
					y2={yScale(tick)}
					class="gridline"
				/>
				<text
					x={m.innerLeft - 8}
					y={yScale(tick)}
					class="tick-label"
					text-anchor="end"
					dominant-baseline="middle"
				>
					{formatYValue(tick)}
				</text>
			{/each}
			{#each xTicks as tick (tick)}
				<line
					x1={xScale(tick)}
					x2={xScale(tick)}
					y1={m.innerTop}
					y2={m.innerTop + m.innerHeight}
					class="gridline"
				/>
				<text
					x={xScale(tick)}
					y={m.innerTop + m.innerHeight + 16}
					class="tick-label"
					text-anchor="middle"
				>
					{formatXValue(tick)}
				</text>
			{/each}

			<line
				x1={m.innerLeft}
				x2={m.innerLeft}
				y1={m.innerTop}
				y2={m.innerTop + m.innerHeight}
				class="axis-line"
			/>
			<line
				x1={m.innerLeft}
				x2={m.innerLeft + m.innerWidth}
				y1={m.innerTop + m.innerHeight}
				y2={m.innerTop + m.innerHeight}
				class="axis-line"
			/>

			{#each samples as sample, i (i)}
				<!-- Per-mark hover highlight/tooltip (rule 6); pointer-only, see LineChart's hover-surface comment for rationale. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<circle
					cx={xScale(sample.xValue)}
					cy={yScale(sample.yValue)}
					r={hoveredIndex === i ? HOVER_RADIUS : POINT_RADIUS}
					fill={seriesColorVar(0)}
					fill-opacity="0.6"
					class="point"
					class:hovered={hoveredIndex === i}
					onpointerenter={() => (hoveredIndex = i)}
					onpointerleave={() => (hoveredIndex = null)}
				/>
			{/each}
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hoveredIndex !== null}
				{@const m = plotMetrics(width, plotHeight)}
				{@const xScale = linearScale(
					[xTicks[0], xTicks[xTicks.length - 1]],
					[m.innerLeft, m.innerLeft + m.innerWidth]
				)}
				{@const yScale = linearScale(
					[yTicks[0], yTicks[yTicks.length - 1]],
					[m.innerTop + m.innerHeight, m.innerTop]
				)}
				{@const sample = samples[hoveredIndex]}
				{@const rows = [
					{ label: 'X', value: formatXValue(sample.xValue) },
					{ label: 'Y', value: formatYValue(sample.yValue) }
				]}
				<Tooltip
					x={xScale(sample.xValue)}
					y={yScale(sample.yValue)}
					containerWidth={width}
					containerHeight={plotHeight}
					title={pointLabel ? pointLabel(sample.row) : undefined}
					{rows}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-scatterchart {
		width: 100%;
	}

	.gridline {
		stroke: var(--banto-chart-grid);
		stroke-width: 1;
	}

	.axis-line {
		stroke: var(--banto-chart-axis);
		stroke-width: 1;
	}

	.tick-label {
		fill: var(--banto-text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.point {
		cursor: default;
		transition: r 0.1s ease;
	}
</style>
