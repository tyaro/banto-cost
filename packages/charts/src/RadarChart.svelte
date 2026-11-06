<script lang="ts" generics="TRow">
	/**
	 * Radar (spider) chart (spec §6.1 v2 chart types). Each row of `data` is
	 * one spoke/axis (3..12 spokes is the intended range, though nothing here
	 * hard-fails outside it); each entry of `series` is one closed polygon
	 * across all spokes. Values share a single radial scale (0..max) across
	 * all series and axes - there is no per-axis independent scale (that
	 * would make polygon area meaningless to compare).
	 */
	import { niceTicks } from './core/scale';
	import { radarPoints, ringPolygon, spokeAngle, spokeLabelAnchor } from './core/radar';
	import { seriesColorVar } from './core/color';
	import { getValue, toNumber, type Accessor, type TooltipRow } from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Legend from './internal/Legend.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import type { ChartMessages } from './messages';

	interface RadarSeries<TRow> {
		id: string;
		label: string;
		value: Accessor<TRow>;
	}

	interface Props {
		data: TRow[];
		axis: Accessor<TRow>;
		series: RadarSeries<TRow>[];
		label: string;
		height?: number;
		max?: number;
		formatValue?: (n: number) => string;
		/** i18n layer 1 (docs/conventions.md §13): overrides forwarded to `ChartContainer`'s empty-state text. Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		data,
		axis,
		series,
		label,
		height = 240,
		max,
		formatValue,
		messages = {}
	}: Props = $props();

	const LABEL_PADDING = 34;
	const LABEL_GAP = 10;
	const RING_RATIOS = [0.25, 0.5, 0.75, 1];
	const VERTEX_RADIUS = 4;

	const formatValueDisplay = $derived(formatValue ?? ((n: number) => n.toLocaleString()));

	const axisLabels = $derived(data.map((row) => getValue(row, axis)));
	const valueMatrix = $derived(
		series.map((s) => data.map((row) => toNumber(getValue(row, s.value))))
	);

	const isEmpty = $derived(data.length === 0 || series.length === 0);

	// Scale 0..(max ?? data max, nice-rounded) - niceTicks' last tick gives a
	// "nice" round ceiling instead of the raw (often ugly) data maximum.
	const maxValue = $derived.by(() => {
		if (max !== undefined) return max;
		const finite = valueMatrix.flat().filter((v) => Number.isFinite(v));
		if (finite.length === 0) return 1;
		const dataMax = Math.max(0, ...finite);
		const ticks = niceTicks(0, dataMax, 4);
		return ticks[ticks.length - 1];
	});

	const legendItems = $derived(
		series.map((s, i) => ({ id: s.id, label: s.label, colorVar: seriesColorVar(i) }))
	);

	function geometry(width: number, plotHeight: number) {
		const cx = width / 2;
		const cy = plotHeight / 2;
		const radius = Math.max(0, Math.min(width, plotHeight) / 2 - LABEL_PADDING);
		return { cx, cy, radius };
	}

	let hovered: { seriesIndex: number; axisIndex: number } | null = $state(null);

	function tooltipRows(axisIndex: number): TooltipRow[] {
		return series.map((s, i) => {
			const raw = valueMatrix[i][axisIndex];
			return {
				label: s.label,
				value: Number.isFinite(raw) ? formatValueDisplay(raw) : '-',
				colorVar: seriesColorVar(i)
			};
		});
	}
</script>

<div class="banto-radarchart">
	<Legend items={legendItems} />
	<ChartContainer {label} {height} empty={isEmpty} {messages}>
		{#snippet plot({ width, height: plotHeight })}
			{@const g = geometry(width, plotHeight)}

			<!-- Radial grid: concentric rings + spokes (hairline, recessive - rule 4). -->
			{#each RING_RATIOS as ratio (ratio)}
				{@const ring = ringPolygon(data.length, ratio, g.cx, g.cy, g.radius)}
				<polygon points={ring.map((p) => `${p.x},${p.y}`).join(' ')} class="ring" />
			{/each}
			{#each data as _row, i (i)}
				{@const outer = ringPolygon(data.length, 1, g.cx, g.cy, g.radius)[i]}
				<line x1={g.cx} y1={g.cy} x2={outer?.x ?? g.cx} y2={outer?.y ?? g.cy} class="spoke" />
			{/each}

			<!-- Perimeter axis labels, anchored by angle octant so they read outward (rule: never overlap the plot). -->
			{#each axisLabels as axisLabel, i (i)}
				{@const angle = spokeAngle(i, data.length)}
				{@const anchor = spokeLabelAnchor(angle)}
				{@const labelPoint =
					g.radius > 0
						? ringPolygon(data.length, (g.radius + LABEL_GAP) / g.radius, g.cx, g.cy, g.radius)[i]
						: { x: g.cx, y: g.cy }}
				<text
					x={labelPoint.x}
					y={labelPoint.y}
					class="axis-label"
					text-anchor={anchor.textAnchor}
					dominant-baseline={anchor.dominantBaseline}
				>
					{String(axisLabel ?? '')}
				</text>
			{/each}

			<!-- Series polygons: 2px stroke, ~15% fill (rule: text never takes a series color; only the mark does). -->
			{#each series as s, seriesIndex (s.id)}
				{@const points = radarPoints(valueMatrix[seriesIndex], maxValue, g.cx, g.cy, g.radius)}
				<polygon
					points={points.map((p) => `${p.x},${p.y}`).join(' ')}
					fill={seriesColorVar(seriesIndex)}
					fill-opacity="0.15"
					stroke={seriesColorVar(seriesIndex)}
					stroke-width="2"
				/>
				{#each points as p, axisIndex (axisIndex)}
					<!-- Per-vertex hover target (>= 8px, rule 3) driving the per-axis-point tooltip. -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<circle
						cx={p.x}
						cy={p.y}
						r={VERTEX_RADIUS}
						fill={seriesColorVar(seriesIndex)}
						stroke="var(--banto-surface)"
						stroke-width="2"
						class="vertex"
						onpointerenter={() => (hovered = { seriesIndex, axisIndex })}
						onpointerleave={() => (hovered = null)}
					/>
				{/each}
			{/each}
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hovered}
				{@const g = geometry(width, plotHeight)}
				{@const anchor = radarPoints(
					valueMatrix[hovered.seriesIndex],
					maxValue,
					g.cx,
					g.cy,
					g.radius
				)[hovered.axisIndex]}
				<Tooltip
					x={anchor.x}
					y={anchor.y}
					containerWidth={width}
					containerHeight={plotHeight}
					title={String(axisLabels[hovered.axisIndex] ?? '')}
					rows={tooltipRows(hovered.axisIndex)}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-radarchart {
		width: 100%;
	}

	.ring {
		fill: none;
		stroke: var(--banto-chart-grid);
		stroke-width: 1;
	}

	.spoke {
		stroke: var(--banto-chart-grid);
		stroke-width: 1;
	}

	.axis-label {
		fill: var(--banto-text-muted);
		font-size: 11px;
	}

	.vertex {
		cursor: default;
	}
</style>
