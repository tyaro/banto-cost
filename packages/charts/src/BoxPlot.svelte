<script lang="ts">
	/**
	 * Box plot (roadmap.md M13, SPC/QC "箱ひげ図"): each group's raw `values`
	 * are summarized inside the component via `core/boxplot.ts#boxStats`
	 * (five-number summary + Tukey 1.5x IQR whiskers/outliers). Groups are laid
	 * out with `bandScale` (same categorical x-axis as `BarChart`); a group
	 * whose `boxStats` is `null` (no finite values) still reserves its band
	 * (so category labels/spacing stay stable) but draws no box - "空表示
	 * スキップ" per the spec.
	 *
	 * Single implicit series (one visual per group, not multiple named
	 * series), so no `Legend` - same precedent as `ScatterChart`. The value
	 * axis is NOT forced to include 0 (unlike the bar-family charts): a box
	 * plot describes a distribution's spread, not a zero-baselined magnitude,
	 * so its axis follows `ScatterChart`'s "niceTicks over the actual data
	 * extent" convention instead of BarChart's rule 7.
	 */
	import { boxStats, type BoxStats } from './core/boxplot';
	import { linearScale, bandScale, niceTicks } from './core/scale';
	import { seriesColorVar } from './core/color';
	import type { ChartMargin, TooltipRow } from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import { defaultChartMessages, type ChartMessages } from './messages';

	interface BoxGroup {
		label: string;
		values: number[];
	}

	interface Props {
		groups: BoxGroup[];
		label: string;
		height?: number;
		formatValue?: (n: number) => string;
		/** Per-side overrides merged over the defaults below. */
		margins?: Partial<ChartMargin>;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings (and `ChartContainer`'s empty-state text). Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let { groups, label, height = 240, formatValue, margins, messages = {} }: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultChartMessages, ...messages };

	const DEFAULT_MARGIN: ChartMargin = { top: 12, right: 16, bottom: 26, left: 48 };
	const MARGIN = $derived({ ...DEFAULT_MARGIN, ...margins });
	const CATEGORY_PADDING = 0.35;
	const CAP_RATIO = 0.5; // whisker cap width as a fraction of the band width
	const OUTLIER_RADIUS = 3;

	const formatValueDisplay = $derived(formatValue ?? ((n: number) => n.toLocaleString()));

	const stats = $derived(groups.map((g) => boxStats(g.values)));
	const isEmpty = $derived(groups.length === 0 || stats.every((s) => s === null));

	// Value axis spans the actual data extent (min/max already include
	// outliers - see boxStats' doc comment), not a forced zero baseline.
	const valueTicks = $derived.by(() => {
		const finite = stats.filter((s): s is BoxStats => s !== null);
		if (finite.length === 0) return [0, 1];
		const lo = Math.min(...finite.map((s) => s.min));
		const hi = Math.max(...finite.map((s) => s.max));
		return niceTicks(lo, hi, 5);
	});

	function plotMetrics(width: number, plotHeight: number) {
		return {
			innerLeft: MARGIN.left,
			innerTop: MARGIN.top,
			innerWidth: Math.max(0, width - MARGIN.left - MARGIN.right),
			innerHeight: Math.max(0, plotHeight - MARGIN.top - MARGIN.bottom)
		};
	}

	let hoveredIndex: number | null = $state(null);

	function tooltipRows(s: BoxStats): TooltipRow[] {
		return [
			{ label: t.boxplotMax(), value: formatValueDisplay(s.max), colorVar: seriesColorVar(0) },
			{ label: 'Q3', value: formatValueDisplay(s.q3) },
			{ label: t.boxplotMedian(), value: formatValueDisplay(s.median) },
			{ label: 'Q1', value: formatValueDisplay(s.q1) },
			{ label: t.boxplotMin(), value: formatValueDisplay(s.min) },
			{ label: t.boxplotOutliers(), value: t.boxplotOutlierCount(s.outliers.length) }
		];
	}
</script>

<div class="banto-boxplot">
	<ChartContainer {label} {height} empty={isEmpty} {messages}>
		{#snippet plot({ width, height: plotHeight })}
			{@const m = plotMetrics(width, plotHeight)}
			{@const valueScale = linearScale(
				[valueTicks[0], valueTicks[valueTicks.length - 1]],
				[m.innerTop + m.innerHeight, m.innerTop]
			)}
			{@const catScale = bandScale(
				groups.length,
				[m.innerLeft, m.innerLeft + m.innerWidth],
				CATEGORY_PADDING
			)}

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
			{#each groups as g, i (i)}
				<text
					x={catScale.center(i)}
					y={m.innerTop + m.innerHeight + 16}
					class="tick-label"
					text-anchor="middle"
				>
					{g.label}
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

			{#each stats as s, i (i)}
				{#if s}
					{@const bandX = catScale.start(i)}
					{@const bandW = catScale.bandwidth}
					{@const cx = catScale.center(i)}
					{@const capHalf = (bandW * CAP_RATIO) / 2}
					{@const yQ1 = valueScale(s.q1)}
					{@const yQ3 = valueScale(s.q3)}
					{@const yMedian = valueScale(s.median)}
					{@const yWhiskerLow = valueScale(s.whiskerLow)}
					{@const yWhiskerHigh = valueScale(s.whiskerHigh)}
					<!-- Per-group hover highlight/tooltip (rule 6); pointer-only, see BarChart's hover-surface comment for rationale. -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<g
						class="box-group"
						class:hovered={hoveredIndex === i}
						onpointerenter={() => (hoveredIndex = i)}
						onpointerleave={() => (hoveredIndex = null)}
					>
						<!-- Invisible full-height hit area so hover works over the whole band, not just the box/whiskers. -->
						<rect
							x={bandX}
							y={m.innerTop}
							width={bandW}
							height={m.innerHeight}
							fill="transparent"
							class="hit-area"
						/>
						<!-- Whiskers: vertical line + end caps. -->
						<line
							x1={cx}
							x2={cx}
							y1={yWhiskerHigh}
							y2={yQ3}
							class="whisker"
							stroke={seriesColorVar(0)}
						/>
						<line
							x1={cx}
							x2={cx}
							y1={yQ1}
							y2={yWhiskerLow}
							class="whisker"
							stroke={seriesColorVar(0)}
						/>
						<line
							x1={cx - capHalf}
							x2={cx + capHalf}
							y1={yWhiskerHigh}
							y2={yWhiskerHigh}
							class="whisker"
							stroke={seriesColorVar(0)}
						/>
						<line
							x1={cx - capHalf}
							x2={cx + capHalf}
							y1={yWhiskerLow}
							y2={yWhiskerLow}
							class="whisker"
							stroke={seriesColorVar(0)}
						/>
						<!-- Box (Q1-Q3). -->
						<rect
							x={bandX}
							y={yQ3}
							width={bandW}
							height={Math.max(0, yQ1 - yQ3)}
							fill={seriesColorVar(0)}
							fill-opacity="0.25"
							stroke={seriesColorVar(0)}
							stroke-width="1.5"
						/>
						<!-- Median line. -->
						<line
							x1={bandX}
							x2={bandX + bandW}
							y1={yMedian}
							y2={yMedian}
							class="median"
							stroke={seriesColorVar(0)}
						/>
						<!-- Outliers. -->
						{#each s.outliers as v, oi (oi)}
							<circle
								{cx}
								cy={valueScale(v)}
								r={OUTLIER_RADIUS}
								fill={seriesColorVar(0)}
								fill-opacity="0.6"
								class="outlier"
							/>
						{/each}
					</g>
				{/if}
			{/each}
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hoveredIndex !== null && stats[hoveredIndex]}
				{@const m = plotMetrics(width, plotHeight)}
				{@const valueScale = linearScale(
					[valueTicks[0], valueTicks[valueTicks.length - 1]],
					[m.innerTop + m.innerHeight, m.innerTop]
				)}
				{@const catScale = bandScale(
					groups.length,
					[m.innerLeft, m.innerLeft + m.innerWidth],
					CATEGORY_PADDING
				)}
				{@const s = stats[hoveredIndex]!}
				<Tooltip
					x={catScale.center(hoveredIndex)}
					y={valueScale(s.median)}
					containerWidth={width}
					containerHeight={plotHeight}
					title={groups[hoveredIndex].label}
					rows={tooltipRows(s)}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-boxplot {
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

	.box-group {
		cursor: default;
	}

	.hit-area {
		pointer-events: all;
	}

	.whisker {
		stroke-width: 1.5;
		fill: none;
		pointer-events: none;
	}

	.median {
		stroke-width: 2;
		pointer-events: none;
	}

	.outlier {
		pointer-events: none;
	}

	.box-group.hovered rect:not(.hit-area) {
		fill-opacity: 0.4;
	}
</style>
