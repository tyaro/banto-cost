<script lang="ts">
	/**
	 * Pareto chart (roadmap.md M13, SPC/QC "パレート図"): bars sorted descending
	 * (via `core/pareto.ts#paretoData`, computed inside the component from raw
	 * `items`) plus a cumulative-percent line read against an independent right
	 * axis, and a dashed 80% reference line - the classic Pareto layout.
	 *
	 * Unlike `ComboChart` (spec §6.1 rule: bars and lines share ONE y-axis),
	 * this chart's whole point IS the second axis - percent (0-100, fixed
	 * range) is a fundamentally different unit from the bars' raw values - so
	 * it is implemented independently rather than reusing ComboChart.
	 *
	 * Color follows `ComboChart`'s "bars first, then lines" slot convention:
	 * the single bar series takes slot 0, the cumulative line takes slot 1.
	 */
	import { paretoData } from './core/pareto';
	import { linearScale, bandScale, niceTicks } from './core/scale';
	import { roundedTopBarPath, linePath } from './core/path';
	import { everyNthIndex } from './core/ticks-time';
	import { seriesColorVar } from './core/color';
	import type { ChartMargin, TooltipRow } from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Legend from './internal/Legend.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import { defaultChartMessages, type ChartMessages } from './messages';

	interface ParetoInputItem {
		label: string;
		value: number;
	}

	interface Props {
		items: ParetoInputItem[];
		label: string;
		height?: number;
		formatValue?: (n: number) => string;
		/** Per-side overrides merged over the defaults below. */
		margins?: Partial<ChartMargin>;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings (and `ChartContainer`'s empty-state text). Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let { items, label, height = 240, formatValue, margins, messages = {} }: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultChartMessages, ...messages };

	const DEFAULT_MARGIN: ChartMargin = { top: 12, right: 40, bottom: 26, left: 48 };
	const MARGIN = $derived({ ...DEFAULT_MARGIN, ...margins });
	const RADIUS = 4;
	const CATEGORY_PADDING = 0.3;
	const MIN_TICK_SPACING = 60;
	const THRESHOLD_PERCENT = 80;

	const formatValueDisplay = $derived(formatValue ?? ((n: number) => n.toLocaleString()));
	const formatPercent = (n: number) => `${Math.round(n)}%`;

	const data = $derived(paretoData(items));
	const isEmpty = $derived(data.length === 0);

	const categories = $derived(data.map((d) => d.label));
	const values = $derived(data.map((d) => d.value));

	// Left (value) axis always includes 0 - bars are always present here, same
	// "a bar axis is never truncated" rule BarChart/ComboChart follow.
	const dataMin = $derived(Math.min(0, ...(values.length ? values : [0])));
	const dataMax = $derived(Math.max(0, ...(values.length ? values : [1])));
	const valueTicks = $derived(niceTicks(dataMin, dataMax, 5));
	const domainMin = $derived(valueTicks[0]);
	const domainMax = $derived(valueTicks[valueTicks.length - 1]);

	// Right (cumulative %) axis is a fixed 0-100 range - unlike the value axis,
	// its scale never depends on the data.
	const percentTicks = $derived(niceTicks(0, 100, 5));

	const legendItems = $derived([
		{ id: 'value', label: t.paretoValue(), colorVar: seriesColorVar(0) },
		{ id: 'cumulative', label: t.paretoCumulativePct(), colorVar: seriesColorVar(1) }
	]);

	function maxXTicksFor(innerWidth: number): number {
		return Math.max(2, Math.min(8, Math.floor(innerWidth / MIN_TICK_SPACING)));
	}

	function plotMetrics(width: number, plotHeight: number) {
		return {
			innerLeft: MARGIN.left,
			innerTop: MARGIN.top,
			innerWidth: Math.max(0, width - MARGIN.left - MARGIN.right),
			innerHeight: Math.max(0, plotHeight - MARGIN.top - MARGIN.bottom)
		};
	}

	let hoveredIndex: number | null = $state(null);

	function tooltipRows(index: number): TooltipRow[] {
		const d = data[index];
		return [
			{ label: t.paretoValue(), value: formatValueDisplay(d.value), colorVar: seriesColorVar(0) },
			{
				label: t.paretoCumulativePct(),
				value: formatPercent(d.cumulativePercent),
				colorVar: seriesColorVar(1)
			}
		];
	}
</script>

<div class="banto-paretochart">
	<Legend items={legendItems} />
	<ChartContainer {label} {height} empty={isEmpty} {messages}>
		{#snippet plot({ width, height: plotHeight })}
			{@const m = plotMetrics(width, plotHeight)}
			{@const valueScale = linearScale(
				[domainMin, domainMax],
				[m.innerTop + m.innerHeight, m.innerTop]
			)}
			{@const percentScale = linearScale([0, 100], [m.innerTop + m.innerHeight, m.innerTop])}
			{@const catScale = bandScale(
				data.length,
				[m.innerLeft, m.innerLeft + m.innerWidth],
				CATEGORY_PADDING
			)}

			<!-- Gridlines + left (value) ticks - the right axis mirrors LineChart's
			     hasRight treatment (tick labels + axis line only, no gridlines of
			     its own, to avoid a double grid). -->
			{#each valueTicks as tick (tick)}
				<line
					x1={m.innerLeft}
					x2={m.innerLeft + m.innerWidth}
					y1={valueScale(tick)}
					y2={valueScale(tick)}
					class="gridline"
				/>
				<text
					x={m.innerLeft - 8}
					y={valueScale(tick)}
					class="tick-label"
					text-anchor="end"
					dominant-baseline="middle"
				>
					{formatValueDisplay(tick)}
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

			<!-- Right axis (cumulative %). -->
			<line
				x1={m.innerLeft + m.innerWidth}
				x2={m.innerLeft + m.innerWidth}
				y1={m.innerTop}
				y2={m.innerTop + m.innerHeight}
				class="axis-line"
			/>
			{#each percentTicks as tick (tick)}
				{@const ry = percentScale(tick)}
				<line
					x1={m.innerLeft + m.innerWidth}
					x2={m.innerLeft + m.innerWidth + 4}
					y1={ry}
					y2={ry}
					class="axis-line"
				/>
				<text
					x={m.innerLeft + m.innerWidth + 8}
					y={ry}
					class="tick-label y-tick"
					text-anchor="start"
					dominant-baseline="middle"
				>
					{formatPercent(tick)}
				</text>
			{/each}

			<!-- 80% reference line (the classic Pareto threshold), dashed. -->
			{@const thresholdY = percentScale(THRESHOLD_PERCENT)}
			<line
				x1={m.innerLeft}
				x2={m.innerLeft + m.innerWidth}
				y1={thresholdY}
				y2={thresholdY}
				class="threshold-line"
			/>
			<text
				x={m.innerLeft + m.innerWidth - 4}
				y={thresholdY - 4}
				class="threshold-label"
				text-anchor="end"
			>
				{THRESHOLD_PERCENT}%
			</text>

			<!-- X category labels, thinned when crowded (same everyNthIndex convention as ComboChart). -->
			{@const xTickIndices = everyNthIndex(data.length, maxXTicksFor(m.innerWidth))}
			{#each xTickIndices as i (i)}
				<text
					x={catScale.center(i)}
					y={m.innerTop + m.innerHeight + 18}
					class="tick-label"
					text-anchor="middle"
				>
					{categories[i]}
				</text>
			{/each}

			<!-- Bars (descending, zero-baselined on the left axis). -->
			{#each data as d, i (i)}
				{@const y0 = valueScale(Math.max(0, d.value))}
				{@const y1 = valueScale(Math.min(0, d.value))}
				<!-- Per-mark hover highlight/tooltip (rule 6); pointer-only, see BarChart's hover-surface comment for rationale. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<path
					d={roundedTopBarPath(
						catScale.start(i),
						y0,
						catScale.bandwidth,
						Math.max(0, y1 - y0),
						d.value >= 0 ? RADIUS : 0
					)}
					fill={seriesColorVar(0)}
					stroke="var(--banto-surface)"
					stroke-width="2"
					class="bar"
					class:hovered={hoveredIndex === i}
					onpointerenter={() => (hoveredIndex = i)}
					onpointerleave={() => (hoveredIndex = null)}
				/>
			{/each}

			<!-- Cumulative-% line, drawn OVER the bars, on the right axis. -->
			{@const linePoints = data.map((d, i) => ({
				x: catScale.center(i),
				y: percentScale(d.cumulativePercent)
			}))}
			<path d={linePath(linePoints)} fill="none" stroke={seriesColorVar(1)} stroke-width="2" />
			{#each linePoints as p, i (i)}
				<!-- Per-mark hover highlight/tooltip (rule 6); pointer-only, see BarChart's hover-surface comment for rationale. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<circle
					cx={p.x}
					cy={p.y}
					r={hoveredIndex === i ? 5 : 3}
					fill={seriesColorVar(1)}
					stroke="var(--banto-surface)"
					stroke-width="2"
					class="point"
					onpointerenter={() => (hoveredIndex = i)}
					onpointerleave={() => (hoveredIndex = null)}
				/>
			{/each}
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hoveredIndex !== null}
				{@const m = plotMetrics(width, plotHeight)}
				{@const catScale = bandScale(
					data.length,
					[m.innerLeft, m.innerLeft + m.innerWidth],
					CATEGORY_PADDING
				)}
				{@const percentScale = linearScale([0, 100], [m.innerTop + m.innerHeight, m.innerTop])}
				{@const d = data[hoveredIndex]}
				<Tooltip
					x={catScale.center(hoveredIndex)}
					y={percentScale(d.cumulativePercent)}
					containerWidth={width}
					containerHeight={plotHeight}
					title={d.label}
					rows={tooltipRows(hoveredIndex)}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-paretochart {
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

	.threshold-line {
		stroke: var(--banto-chart-axis);
		stroke-width: 1;
		stroke-dasharray: 4 3;
		stroke-opacity: 0.8;
		pointer-events: none;
	}

	.threshold-label {
		fill: var(--banto-text-muted);
		font-size: 10px;
		opacity: 0.85;
	}

	.bar {
		cursor: default;
		transition: opacity 0.1s ease;
	}

	.bar.hovered {
		opacity: 0.85;
	}

	.point {
		cursor: default;
		transition: r 0.1s ease;
	}
</style>
