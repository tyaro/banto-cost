<script lang="ts">
	/**
	 * Histogram (roadmap.md M13, SPC/QC "ヒストグラム"): raw `values` are binned
	 * inside the component via `core/bins.ts#histogramBins` (auto bin count via
	 * Freedman-Diaconis, or an exact `binCount` override) and drawn as a
	 * continuous bar strip - bins are contiguous ranges, not independent
	 * categories, so bars touch edge-to-edge (no band padding) with only the
	 * `stroke="var(--banto-surface)"` separator BarChart already uses between
	 * bars for the same visual effect.
	 *
	 * The value (count) axis ALWAYS includes 0 (same "a bar axis is never
	 * truncated" rule `BarChart` follows) and uses `roundedTopBarPath` with the
	 * same data-end-only rounding rule (top rounded, baseline square).
	 *
	 * Optional `normalCurve` overlays a normal-distribution curve fit to
	 * `values`' own mean/stddev (sample stddev, n-1): `core/bins.ts#normalCurvePoints`
	 * returns a raw density curve, which this component scales to the same
	 * COUNT axis as the bars (density * binWidth * n - see that function's doc
	 * comment) so the two are visually comparable on one y-scale.
	 */
	import { histogramBins, normalCurvePoints } from './core/bins';
	import { linearScale, niceTicks } from './core/scale';
	import { linePath, roundedTopBarPath } from './core/path';
	import { seriesColorVar } from './core/color';
	import type { ChartMargin, TooltipRow } from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Legend from './internal/Legend.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import { defaultChartMessages, type ChartMessages } from './messages';

	interface Props {
		values: number[];
		label: string;
		height?: number;
		/** Forces an exact bin count; omitted means auto (Freedman-Diaconis, Sturges fallback). */
		binCount?: number;
		/** Overlay a normal-distribution curve fit to `values`' mean/stddev. Default false. */
		normalCurve?: boolean;
		/** Formats bin-edge values (x-axis ticks, tooltip range). Counts are always plain integers. */
		formatValue?: (n: number) => string;
		/** Per-side overrides merged over the computed defaults. */
		margins?: Partial<ChartMargin>;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings (and `ChartContainer`'s empty-state text). Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		values,
		label,
		height = 240,
		binCount,
		normalCurve = false,
		formatValue,
		margins,
		messages = {}
	}: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultChartMessages, ...messages };

	const DEFAULT_MARGIN: ChartMargin = { top: 8, right: 16, bottom: 26, left: 48 };
	const MARGIN = $derived({ ...DEFAULT_MARGIN, ...margins });
	const RADIUS = 4;
	const CURVE_SAMPLES = 64;

	const formatValueDisplay = $derived(formatValue ?? ((n: number) => n.toLocaleString()));
	const formatCount = (n: number) => n.toLocaleString();

	const bins = $derived(histogramBins(values, { binCount }));
	const isEmpty = $derived(bins.length === 0);

	const domain = $derived.by((): [number, number] => {
		if (bins.length === 0) return [0, 1];
		return [bins[0].x0, bins[bins.length - 1].x1];
	});

	/** Sample mean + stddev (n-1) of the finite values, for the optional normal-curve overlay. `stdDev` is 0 for < 2 finite points (no spread to fit). */
	function computeMeanStdDev(vals: number[]): { mean: number; stdDev: number } {
		const finite = vals.filter((v) => Number.isFinite(v));
		const n = finite.length;
		if (n === 0) return { mean: 0, stdDev: 0 };
		const mean = finite.reduce((sum, v) => sum + v, 0) / n;
		if (n < 2) return { mean, stdDev: 0 };
		const variance = finite.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
		return { mean, stdDev: Math.sqrt(variance) };
	}

	// Curve points expressed on the COUNT axis (density * binWidth * n - see
	// `normalCurvePoints`' doc comment) so it shares the bars' y-scale exactly.
	// All bins share one width except the single-bin degenerate-domain case
	// (see histogramBins), which is still correct here (there is nothing to
	// compare it against).
	const curveCounts = $derived.by((): { x: number; y: number }[] => {
		if (!normalCurve || bins.length === 0) return [];
		const { mean, stdDev } = computeMeanStdDev(values);
		if (stdDev <= 0) return [];
		const finiteCount = values.filter((v) => Number.isFinite(v)).length;
		const binWidth = bins[0].x1 - bins[0].x0;
		const density = normalCurvePoints(mean, stdDev, domain, CURVE_SAMPLES);
		return density.map((p) => ({ x: p.x, y: p.y * binWidth * finiteCount }));
	});

	const maxBinCount = $derived(bins.reduce((max, b) => Math.max(max, b.count), 0));
	const maxCurveCount = $derived(curveCounts.reduce((max, p) => Math.max(max, p.y), 0));

	// Count axis always includes 0 (rule 7 - a bar axis is never truncated);
	// the curve's peak is folded into the ceiling too so an overlay never clips.
	const valueTicks = $derived(niceTicks(0, Math.max(1, maxBinCount, maxCurveCount), 5));
	const domainMax = $derived(valueTicks[valueTicks.length - 1]);

	const xTicks = $derived(
		bins.length === 0
			? []
			: niceTicks(domain[0], domain[1], 6).filter((t) => t >= domain[0] && t <= domain[1])
	);

	const legendItems = $derived([
		{ id: 'freq', label: t.histogramFrequency(), colorVar: seriesColorVar(0) },
		...(normalCurve && curveCounts.length > 0
			? [{ id: 'normal', label: t.histogramNormal(), colorVar: seriesColorVar(1) }]
			: [])
	]);

	function plotMetrics(width: number, plotHeight: number) {
		return {
			innerLeft: MARGIN.left,
			innerTop: MARGIN.top,
			innerWidth: Math.max(0, width - MARGIN.left - MARGIN.right),
			innerHeight: Math.max(0, plotHeight - MARGIN.top - MARGIN.bottom)
		};
	}

	let hoveredIndex: number | null = $state(null);

	function tooltipFor(index: number): { title: string; rows: TooltipRow[] } {
		const bin = bins[index];
		return {
			title: `${formatValueDisplay(bin.x0)} - ${formatValueDisplay(bin.x1)}`,
			rows: [
				{
					label: t.histogramFrequency(),
					value: formatCount(bin.count),
					colorVar: seriesColorVar(0)
				}
			]
		};
	}
</script>

<div class="banto-histogram">
	<Legend items={legendItems} />
	<ChartContainer {label} {height} empty={isEmpty} {messages}>
		{#snippet plot({ width, height: plotHeight })}
			{@const m = plotMetrics(width, plotHeight)}
			{@const xScale = linearScale(domain, [m.innerLeft, m.innerLeft + m.innerWidth])}
			{@const valueScale = linearScale([0, domainMax], [m.innerTop + m.innerHeight, m.innerTop])}

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
					{formatCount(tick)}
				</text>
			{/each}
			{#each xTicks as tick (tick)}
				<text
					x={xScale(tick)}
					y={m.innerTop + m.innerHeight + 16}
					class="tick-label"
					text-anchor="middle"
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

			{#each bins as bin, i (i)}
				{@const x0 = xScale(bin.x0)}
				{@const x1 = xScale(bin.x1)}
				{@const y0 = valueScale(bin.count)}
				<!-- Per-mark hover highlight/tooltip (rule 6); pointer-only, see BarChart's hover-surface comment for rationale. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<path
					d={roundedTopBarPath(
						x0,
						y0,
						Math.max(0, x1 - x0),
						Math.max(0, m.innerTop + m.innerHeight - y0),
						RADIUS
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

			{#if normalCurve && curveCounts.length > 0}
				{@const points = curveCounts.map((p) => ({ x: xScale(p.x), y: valueScale(p.y) }))}
				<path
					d={linePath(points)}
					fill="none"
					stroke={seriesColorVar(1)}
					stroke-width="2"
					class="curve"
				/>
			{/if}
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hoveredIndex !== null}
				{@const m = plotMetrics(width, plotHeight)}
				{@const xScale = linearScale(domain, [m.innerLeft, m.innerLeft + m.innerWidth])}
				{@const valueScale = linearScale([0, domainMax], [m.innerTop + m.innerHeight, m.innerTop])}
				{@const bin = bins[hoveredIndex]}
				{@const info = tooltipFor(hoveredIndex)}
				<Tooltip
					x={(xScale(bin.x0) + xScale(bin.x1)) / 2}
					y={valueScale(bin.count)}
					containerWidth={width}
					containerHeight={plotHeight}
					title={info.title}
					rows={info.rows}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-histogram {
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

	.bar {
		cursor: default;
		transition: opacity 0.1s ease;
	}

	.bar.hovered {
		opacity: 0.85;
	}

	.curve {
		pointer-events: none;
	}
</style>
