<script lang="ts" generics="TRow">
	/**
	 * Combo (bar + line) chart (spec §6.1 v2 chart types). Bars are always
	 * vertical and grouped when there is more than one bar series (no stacked
	 * mode here - that's `BarChart`'s job); lines are drawn OVER the bars,
	 * sampled at the same band centers as the bars' x positions.
	 *
	 * ONE Y AXIS ONLY (spec §6.4 rule 2): bars and lines share a single
	 * linear y-scale, always zero-baselined because bars are present (same
	 * rule `BarChart` follows). This means every bar series and every line
	 * series plotted here MUST share one unit/magnitude - if a line's values
	 * live on a fundamentally different scale (e.g. a percentage overlaid on a
	 * yen amount), a second axis would be needed and this component does NOT
	 * support that; use two separate charts instead.
	 *
	 * Series color follows the combined index across BOTH arrays: bars take
	 * slots 0..bars.length-1, then lines continue from bars.length onward
	 * (spec rule: "color follows the entity", by position in the caller's
	 * combined series list).
	 */
	import { linearScale, bandScale, niceTicks } from './core/scale';
	import { leftMarginForTicks } from './core/labels';
	import { roundedTopBarPath, linePath } from './core/path';
	import { everyNthIndex } from './core/ticks-time';
	import { seriesColorVar } from './core/color';
	import {
		getValue,
		toNumber,
		type Accessor,
		type ChartMargin,
		type EventMarker,
		type ThresholdBand,
		type TooltipRow
	} from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Legend from './internal/Legend.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import type { ChartMessages } from './messages';

	interface ComboBarSeries<TRow> {
		id: string;
		label: string;
		value: Accessor<TRow>;
	}

	interface ComboLineSeries<TRow> {
		id: string;
		label: string;
		y: Accessor<TRow>;
	}

	interface Props {
		data: TRow[];
		x: Accessor<TRow>;
		bars: ComboBarSeries<TRow>[];
		lines: ComboLineSeries<TRow>[];
		label: string;
		height?: number;
		formatY?: (n: number) => string;
		formatX?: (v: unknown) => string;
		/** Per-side overrides merged over the defaults below. */
		margins?: Partial<ChartMargin>;
		/** Shaded horizontal threshold/control-limit bands (M13 しきい値バンド). */
		bands?: ThresholdBand[];
		/** Vertical event markers at category indices (M13 注釈). */
		markers?: EventMarker[];
		/** i18n layer 1 (docs/conventions.md §13): overrides forwarded to `ChartContainer`'s empty-state text. Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		data,
		x,
		bars,
		lines,
		label,
		height = 240,
		formatY,
		formatX,
		margins,
		bands = [],
		markers = [],
		messages = {}
	}: Props = $props();

	const DEFAULT_MARGIN: ChartMargin = { top: 12, right: 16, bottom: 26, left: 48 };
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
				valueTicks.map((t) => formatYValue(t)),
				m.left,
				{ totalWidth: plotWidth }
			)
		};
	});
	const RADIUS = 4;
	const CATEGORY_PADDING = 0.3;
	const MIN_TICK_SPACING = 60;

	const formatYValue = $derived(formatY ?? ((n: number) => n.toLocaleString()));
	const formatXValue = $derived(formatX ?? ((v: unknown) => String(v ?? '')));

	const categories = $derived(data.map((row) => getValue(row, x)));
	const barMatrix = $derived(data.map((row) => bars.map((s) => toNumber(getValue(row, s.value)))));
	const lineMatrix = $derived(data.map((row) => lines.map((s) => toNumber(getValue(row, s.y)))));

	const isEmpty = $derived(data.length === 0 || (bars.length === 0 && lines.length === 0));

	// The value domain ALWAYS includes 0 (rule 7-equivalent for this chart,
	// same reasoning as BarChart: bars are always present in a combo chart,
	// so a truncated axis would misrepresent bar magnitude).
	const allValues = $derived(
		[...barMatrix.flat(), ...lineMatrix.flat()].filter((v) => Number.isFinite(v))
	);
	const dataMin = $derived(Math.min(0, ...(allValues.length ? allValues : [0])));
	const dataMax = $derived(Math.max(0, ...(allValues.length ? allValues : [1])));
	const valueTicks = $derived(niceTicks(dataMin, dataMax, 5));
	const domainMin = $derived(valueTicks[0]);
	const domainMax = $derived(valueTicks[valueTicks.length - 1]);

	const legendItems = $derived([
		...bars.map((s, i) => ({ id: s.id, label: s.label, colorVar: seriesColorVar(i) })),
		...lines.map((s, i) => ({
			id: s.id,
			label: s.label,
			colorVar: seriesColorVar(bars.length + i)
		}))
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

	// Categories are laid out as a uniform band scale, so the band boundary
	// between index i and i+1 is always at a fixed step - no need to search,
	// just floor-divide (mirrors LineChart's `indexFromX`, adapted for bands).
	function indexFromX(localX: number, innerLeft: number, innerWidth: number): number {
		if (data.length === 0) return 0;
		const step = innerWidth / data.length;
		const idx = Math.floor((localX - innerLeft) / step);
		return Math.max(0, Math.min(data.length - 1, idx));
	}

	function handlePointerMove(event: PointerEvent, innerLeft: number, innerWidth: number) {
		const target = event.currentTarget as SVGRectElement;
		const bounds = target.getBoundingClientRect();
		const localX = innerLeft + (event.clientX - bounds.left);
		hoveredIndex = indexFromX(localX, innerLeft, innerWidth);
	}

	function tooltipRows(index: number): TooltipRow[] {
		const barRows = bars.map((s, i) => ({
			label: s.label,
			value: Number.isFinite(barMatrix[index][i]) ? formatYValue(barMatrix[index][i]) : '-',
			colorVar: seriesColorVar(i)
		}));
		const lineRows = lines.map((s, i) => ({
			label: s.label,
			value: Number.isFinite(lineMatrix[index][i]) ? formatYValue(lineMatrix[index][i]) : '-',
			colorVar: seriesColorVar(bars.length + i)
		}));
		return [...barRows, ...lineRows];
	}
</script>

<div class="banto-combochart">
	<Legend items={legendItems} />
	<ChartContainer {label} {height} empty={isEmpty} bind:width={plotWidth} {messages}>
		{#snippet plot({ width, height: plotHeight })}
			{@const m = plotMetrics(width, plotHeight)}
			{@const valueScale = linearScale(
				[domainMin, domainMax],
				[m.innerTop + m.innerHeight, m.innerTop]
			)}
			{@const catScale = bandScale(
				data.length,
				[m.innerLeft, m.innerLeft + m.innerWidth],
				CATEGORY_PADDING
			)}

			<!-- Threshold bands (drawn first, under the bars/lines). Bands read
			     against the single shared value scale (spec §6.4 rule 2). -->
			{#each bands as band, bi (bi)}
				{@const yTop = valueScale(Math.max(band.from, band.to))}
				{@const yBottom = valueScale(Math.min(band.from, band.to))}
				{@const bandColor = band.colorVar ?? 'var(--banto-chart-axis)'}
				<rect
					x={m.innerLeft}
					y={yTop}
					width={m.innerWidth}
					height={Math.max(0, yBottom - yTop)}
					fill={bandColor}
					fill-opacity="0.1"
				/>
				<line
					x1={m.innerLeft}
					x2={m.innerLeft + m.innerWidth}
					y1={yTop}
					y2={yTop}
					class="band-edge"
					stroke={bandColor}
				/>
				<line
					x1={m.innerLeft}
					x2={m.innerLeft + m.innerWidth}
					y1={yBottom}
					y2={yBottom}
					class="band-edge"
					stroke={bandColor}
				/>
				{#if band.label}
					<text x={m.innerLeft + 6} y={yTop + 11} class="band-label" fill={bandColor}
						>{band.label}</text
					>
				{/if}
			{/each}

			<!-- Gridlines + y ticks (shared axis, spec §6.4 rule 2) -->
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
					{formatYValue(tick)}
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

			<!-- X category labels, thinned when crowded (same everyNthIndex convention as LineChart). -->
			{@const xTickIndices = everyNthIndex(data.length, maxXTicksFor(m.innerWidth))}
			{#each xTickIndices as i (i)}
				<text
					x={catScale.center(i)}
					y={m.innerTop + m.innerHeight + 18}
					class="tick-label"
					text-anchor="middle"
				>
					{formatXValue(categories[i])}
				</text>
			{/each}

			<!-- Bars (grouped when > 1 bar series), zero-baselined. -->
			{#each data as _row, catIndex (catIndex)}
				{@const catX = catScale.start(catIndex)}
				{@const subScale = bandScale(bars.length, [catX, catX + catScale.bandwidth], 0)}
				{#each bars as _s, seriesIndex (seriesIndex)}
					{@const value = barMatrix[catIndex][seriesIndex]}
					{@const y0 = valueScale(Math.max(0, value))}
					{@const y1 = valueScale(Math.min(0, value))}
					<path
						d={roundedTopBarPath(
							subScale.start(seriesIndex),
							y0,
							subScale.bandwidth,
							Math.max(0, y1 - y0),
							value >= 0 ? RADIUS : 0
						)}
						fill={seriesColorVar(seriesIndex)}
						stroke="var(--banto-surface)"
						stroke-width="2"
						class="bar"
					/>
				{/each}
			{/each}

			<!-- Lines/points drawn OVER the bars, sampled at the band centers. -->
			{#each lines as s, i (s.id)}
				{@const points = lineMatrix
					.map((row, idx) => ({ v: row[i], idx }))
					.filter((p) => Number.isFinite(p.v))
					.map((p) => ({ x: catScale.center(p.idx), y: valueScale(p.v) }))}
				<path
					d={linePath(points)}
					fill="none"
					stroke={seriesColorVar(bars.length + i)}
					stroke-width="2"
				/>
				{#each points as p, idx (idx)}
					<circle
						cx={p.x}
						cy={p.y}
						r="3"
						fill={seriesColorVar(bars.length + i)}
						stroke="var(--banto-surface)"
						stroke-width="2"
					/>
				{/each}
			{/each}

			<!-- Event markers (vertical dashed line + label) at category centers. -->
			{#each markers as marker, mi (mi)}
				{#if marker.at >= 0 && marker.at < data.length}
					{@const mx = catScale.center(marker.at)}
					{@const markColor = marker.colorVar ?? 'var(--banto-chart-axis)'}
					<line
						x1={mx}
						x2={mx}
						y1={m.innerTop}
						y2={m.innerTop + m.innerHeight}
						class="marker-line"
						stroke={markColor}
					/>
					{#if marker.label}
						<text
							x={mx}
							y={m.innerTop + 10}
							class="marker-label"
							fill={markColor}
							text-anchor="middle"
						>
							{marker.label}
						</text>
					{/if}
				{/if}
			{/each}

			<!-- Shared crosshair (rule 6): hover anywhere snaps to the nearest category. -->
			{#if hoveredIndex !== null}
				<line
					x1={catScale.center(hoveredIndex)}
					x2={catScale.center(hoveredIndex)}
					y1={m.innerTop}
					y2={m.innerTop + m.innerHeight}
					class="crosshair"
				/>
			{/if}

			<!-- Hover capture surface (pointer-only, see LineChart's hover-surface comment for rationale). -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<rect
				x={m.innerLeft}
				y={m.innerTop}
				width={m.innerWidth}
				height={m.innerHeight}
				fill="transparent"
				onpointermove={(event) => handlePointerMove(event, m.innerLeft, m.innerWidth)}
				onpointerleave={() => (hoveredIndex = null)}
			/>
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hoveredIndex !== null}
				{@const m = plotMetrics(width, plotHeight)}
				{@const catScale = bandScale(
					data.length,
					[m.innerLeft, m.innerLeft + m.innerWidth],
					CATEGORY_PADDING
				)}
				<Tooltip
					x={catScale.center(hoveredIndex)}
					y={m.innerTop}
					containerWidth={width}
					containerHeight={plotHeight}
					title={formatXValue(categories[hoveredIndex])}
					rows={tooltipRows(hoveredIndex)}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-combochart {
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

	.crosshair {
		stroke: var(--banto-chart-axis);
		stroke-width: 1;
		pointer-events: none;
	}

	.band-edge {
		stroke-width: 1;
		stroke-opacity: 0.5;
		pointer-events: none;
	}

	.band-label {
		font-size: 10px;
		opacity: 0.8;
	}

	.marker-line {
		stroke-width: 1;
		stroke-dasharray: 4 3;
		stroke-opacity: 0.8;
		pointer-events: none;
	}

	.marker-label {
		font-size: 10px;
		opacity: 0.85;
	}

	.tick-label {
		fill: var(--banto-text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.bar {
		cursor: default;
	}
</style>
