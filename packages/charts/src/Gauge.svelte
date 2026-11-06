<script lang="ts">
	/**
	 * Gauge / KPI dial (spec §6.1 v2 chart types). A single value on a 270deg
	 * arc, not a data series - no legend, no tooltip (a gauge is a stat-like
	 * display, not something you hover to read individual points). Threshold
	 * colors use the THEME status vars (spec §6.4 rule 10: never a chart series
	 * slot) - crossing `warning` or `danger` recolors the value arc, with
	 * danger taking precedence when both are crossed. Optional lower thresholds
	 * (`warningLow`/`dangerLow`) recolor when the value falls to or below them.
	 * `value: null` (no reading) draws no value arc and shows a placeholder.
	 */
	import { arcPath, polarToCartesian } from './core/pie';
	import { gaugeAngle, gaugeColorVar, GAUGE_START_DEG, type GaugeThresholds } from './core/gauge';
	import ChartContainer from './internal/ChartContainer.svelte';
	import { defaultChartMessages, type ChartMessages } from './messages';

	interface Props {
		/** `null`/non-finite draws no value arc and shows the `gaugeNoValue` placeholder ("—") instead of a number. */
		value: number | null;
		min?: number;
		max: number;
		label: string;
		formatValue?: (n: number) => string;
		thresholds?: GaugeThresholds;
		height?: number;
		/** i18n layer 1 (docs/conventions.md §13): overrides forwarded to `ChartContainer`'s empty-state text. Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		value,
		min = 0,
		max,
		label,
		formatValue,
		thresholds,
		height = 160,
		messages = {}
	}: Props = $props();

	const TRACK_WIDTH = 14;
	const SIDE_PAD = 16;
	const TOP_PAD = 16;
	const BOTTOM_PAD = 30;
	const LABEL_GAP = 14;
	// Vertical extent (relative to rOuter) of the 270deg arc's bounding box:
	// top point sits at r above center, the two open-mouth ends sit at
	// r*sin(45deg) below center (see core/gauge.ts's angle-convention note).
	const ARC_VERTICAL_FACTOR = 1 + Math.sin(Math.PI / 4);

	// svelte-ignore state_referenced_locally
	const t = { ...defaultChartMessages, ...messages };

	const formatValueDisplay = $derived(formatValue ?? ((n: number) => n.toLocaleString()));

	function geometry(width: number, plotHeight: number) {
		const rOuter = Math.max(
			10,
			Math.min(
				(width - SIDE_PAD * 2) / 2,
				(plotHeight - TOP_PAD - BOTTOM_PAD) / ARC_VERTICAL_FACTOR
			)
		);
		const cx = width / 2;
		const cy = TOP_PAD + rOuter;
		const rInner = Math.max(1, rOuter - TRACK_WIDTH);
		return { cx, cy, rOuter, rInner };
	}

	const hasValue = $derived(value !== null && Number.isFinite(value));
	const endAngle = $derived(gaugeAngle(hasValue ? (value as number) : min, min, max));
	const colorVar = $derived(gaugeColorVar(hasValue ? (value as number) : NaN, thresholds));
</script>

<div class="banto-gauge">
	<ChartContainer {label} {height} {messages}>
		{#snippet plot({ width, height: plotHeight })}
			{@const g = geometry(width, plotHeight)}
			{@const minPoint = polarToCartesian(g.cx, g.cy, g.rOuter + LABEL_GAP, GAUGE_START_DEG)}
			{@const maxPoint = polarToCartesian(g.cx, g.cy, g.rOuter + LABEL_GAP, GAUGE_START_DEG + 270)}

			<!-- Track (full 270deg sweep). -->
			<path
				d={arcPath(g.cx, g.cy, g.rOuter, g.rInner, GAUGE_START_DEG, GAUGE_START_DEG + 270)}
				class="track"
			/>

			<!-- Value arc, clamped into [min, max] for the geometry (raw value still shown in the hero number below). -->
			{#if hasValue}
				<path
					d={arcPath(g.cx, g.cy, g.rOuter, g.rInner, GAUGE_START_DEG, endAngle)}
					fill={colorVar}
				/>
			{/if}

			<text
				x={minPoint.x}
				y={minPoint.y}
				class="range-label"
				text-anchor="middle"
				dominant-baseline="hanging"
			>
				{formatValueDisplay(min)}
			</text>
			<text
				x={maxPoint.x}
				y={maxPoint.y}
				class="range-label"
				text-anchor="middle"
				dominant-baseline="hanging"
			>
				{formatValueDisplay(max)}
			</text>

			<text x={g.cx} y={g.cy} class="hero-value" text-anchor="middle" dominant-baseline="middle">
				{hasValue ? formatValueDisplay(value as number) : t.gaugeNoValue()}
			</text>
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-gauge {
		width: 100%;
	}

	.track {
		fill: var(--banto-chart-grid);
	}

	.range-label {
		fill: var(--banto-text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.hero-value {
		fill: var(--banto-text);
		font-size: 1.6rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
</style>
