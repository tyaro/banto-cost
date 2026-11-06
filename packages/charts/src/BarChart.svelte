<script lang="ts" generics="TRow">
	/**
	 * Bar chart: vertical or horizontal, grouped or stacked (spec §6). Data is
	 * pre-aggregated by the caller (one row per category). The value axis
	 * ALWAYS includes 0 (rule 7 - a bar axis is never truncated), and rounds
	 * only the bar's true "data end" (top for vertical, right for horizontal)
	 * per rule 3; the opposite (baseline) end is always square.
	 *
	 * v1 scope note: the rounded-cap logic assumes non-negative values (the
	 * dashboard's stock-count / bucket-count data always is). A negative-value
	 * bar still renders correctly (0-baseline, proper stacking direction, see
	 * `core/stack.ts`) but keeps a square top rather than a rounded bottom -
	 * documented simplification, not exercised by this milestone's charts.
	 */
	import { linearScale, bandScale, niceTicks } from './core/scale';
	import { stackSeries, type StackSegment } from './core/stack';
	import { roundedTopBarPath } from './core/path';
	import { seriesColorVar } from './core/color';
	import { leftMarginFor, rightMarginForLastTick } from './core/labels';
	import { getValue, toNumber, type Accessor, type ChartMargin, type TooltipRow } from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Legend from './internal/Legend.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import type { ChartMessages } from './messages';

	interface BarSeries {
		id: string;
		label: string;
		value: Accessor<TRow>;
	}

	interface Props {
		data: TRow[];
		category: Accessor<TRow>;
		series: BarSeries[];
		stacked?: boolean;
		horizontal?: boolean;
		label: string;
		height?: number;
		formatValue?: (n: number) => string;
		/** Per-side overrides merged over the computed defaults (see `MARGIN` below). */
		margins?: Partial<ChartMargin>;
		/** i18n layer 1 (docs/conventions.md §13): overrides forwarded to `ChartContainer`'s empty-state text. Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		data,
		category,
		series,
		stacked = false,
		horizontal = false,
		label,
		height = 240,
		formatValue,
		margins,
		messages = {}
	}: Props = $props();

	const RADIUS = 4;
	const CATEGORY_PADDING = 0.3;

	const formatValueDisplay = $derived(formatValue ?? ((n: number) => n.toLocaleString()));

	const categories = $derived(data.map((row) => getValue(row, category)));
	const matrix = $derived(data.map((row) => series.map((s) => toNumber(getValue(row, s.value)))));
	const isEmpty = $derived(data.length === 0 || series.length === 0);

	const stackedSegments = $derived(stacked ? stackSeries(matrix) : null);

	// Value domain always spans at least [0, ...] (rule 7) whether stacked
	// (bounded by running stack offsets) or grouped (bounded by raw values).
	const boundaryValues = $derived.by(() => {
		if (stackedSegments) return stackedSegments.flat().flatMap((seg) => [seg.start, seg.end]);
		return matrix.flat().filter((v) => Number.isFinite(v));
	});
	const dataMin = $derived(Math.min(0, ...(boundaryValues.length ? boundaryValues : [0])));
	const dataMax = $derived(Math.max(0, ...(boundaryValues.length ? boundaryValues : [1])));
	const valueTicks = $derived(niceTicks(dataMin, dataMax, 5));
	// The value SCALE spans the nice-tick range, not the raw data extent -
	// niceTicks rounds outward (e.g. data max 293k -> last tick 300k), so
	// using the data extent as the scale domain would place trailing ticks
	// beyond the plot edge (clipped labels) and bars would touch the very
	// edge of the plot. Ticks and bars share this one scale domain.
	const domainMin = $derived(valueTicks[0]);
	const domainMax = $derived(valueTicks[valueTicks.length - 1]);

	const legendItems = $derived(
		series.map((s, i) => ({ id: s.id, label: s.label, colorVar: seriesColorVar(i) }))
	);

	// Default margins are label-aware in horizontal mode: the left margin
	// grows to fit the longest category name (end-anchored at innerLeft - 8,
	// clamped so one long name can't crush the plot), and the right margin
	// reserves half the LAST bottom value-tick label (middle-anchored, so
	// half of it overhangs the plot's right edge). Both are estimates from
	// `core/labels.ts` and can be overridden per side via the `margins` prop.
	const MARGIN = $derived.by((): ChartMargin => {
		const base = horizontal
			? {
					top: 8,
					right: rightMarginForLastTick(formatValueDisplay(valueTicks[valueTicks.length - 1] ?? 0)),
					bottom: 26,
					left: leftMarginFor(categories.map((cat) => String(cat ?? '')))
				}
			: { top: 8, right: 16, bottom: 26, left: 48 };
		return { ...base, ...margins };
	});

	interface BarRect {
		catIndex: number;
		seriesIndex: number;
		x: number;
		y: number;
		w: number;
		h: number;
		radius: number;
		value: number;
	}

	function plotMetrics(width: number, plotHeight: number) {
		const m = MARGIN;
		return {
			innerLeft: m.left,
			innerTop: m.top,
			innerWidth: Math.max(0, width - m.left - m.right),
			innerHeight: Math.max(0, plotHeight - m.top - m.bottom)
		};
	}

	/** Which segment in a stacked category is the visual "cap" (gets the rounded data-end). Assumes non-negative values (see file header note). */
	function capIndex(row: StackSegment[]): number {
		let cap = row.length - 1;
		for (let i = 0; i < row.length; i++) {
			if (row[i].value >= 0) cap = i;
		}
		return cap;
	}

	function computeBars(width: number, plotHeight: number): BarRect[] {
		const { innerLeft, innerTop, innerWidth, innerHeight } = plotMetrics(width, plotHeight);
		const bars: BarRect[] = [];

		if (horizontal) {
			const catScale = bandScale(data.length, [innerTop, innerTop + innerHeight], CATEGORY_PADDING);
			const valueScale = linearScale([domainMin, domainMax], [innerLeft, innerLeft + innerWidth]);

			data.forEach((_, catIndex) => {
				const catY = catScale.start(catIndex);
				if (stackedSegments) {
					const row = stackedSegments[catIndex];
					const cap = capIndex(row);
					row.forEach((seg, seriesIndex) => {
						const x0 = valueScale(seg.start);
						const x1 = valueScale(seg.end);
						bars.push({
							catIndex,
							seriesIndex,
							x: Math.min(x0, x1),
							y: catY,
							w: Math.abs(x1 - x0),
							h: catScale.bandwidth,
							radius: seriesIndex === cap ? RADIUS : 0,
							value: seg.value
						});
					});
				} else {
					const subScale = bandScale(series.length, [catY, catY + catScale.bandwidth], 0);
					series.forEach((_s, seriesIndex) => {
						const value = matrix[catIndex][seriesIndex];
						const x0 = valueScale(Math.min(0, value));
						const x1 = valueScale(Math.max(0, value));
						bars.push({
							catIndex,
							seriesIndex,
							x: x0,
							y: subScale.start(seriesIndex),
							w: Math.abs(x1 - x0),
							h: subScale.bandwidth,
							radius: value >= 0 ? RADIUS : 0,
							value
						});
					});
				}
			});
		} else {
			const catScale = bandScale(
				data.length,
				[innerLeft, innerLeft + innerWidth],
				CATEGORY_PADDING
			);
			const valueScale = linearScale([domainMin, domainMax], [innerTop + innerHeight, innerTop]);

			data.forEach((_, catIndex) => {
				const catX = catScale.start(catIndex);
				if (stackedSegments) {
					const row = stackedSegments[catIndex];
					const cap = capIndex(row);
					row.forEach((seg, seriesIndex) => {
						const y0 = valueScale(seg.start);
						const y1 = valueScale(seg.end);
						bars.push({
							catIndex,
							seriesIndex,
							x: catX,
							y: Math.min(y0, y1),
							w: catScale.bandwidth,
							h: Math.abs(y1 - y0),
							radius: seriesIndex === cap ? RADIUS : 0,
							value: seg.value
						});
					});
				} else {
					const subScale = bandScale(series.length, [catX, catX + catScale.bandwidth], 0);
					series.forEach((_s, seriesIndex) => {
						const value = matrix[catIndex][seriesIndex];
						const y0 = valueScale(Math.max(0, value));
						const y1 = valueScale(Math.min(0, value));
						bars.push({
							catIndex,
							seriesIndex,
							x: subScale.start(seriesIndex),
							y: y0,
							w: subScale.bandwidth,
							h: Math.max(0, y1 - y0),
							radius: value >= 0 ? RADIUS : 0,
							value
						});
					});
				}
			});
		}

		return bars;
	}

	let hovered: { catIndex: number; seriesIndex: number } | null = $state(null);

	function isHovered(bar: BarRect): boolean {
		return (
			hovered !== null &&
			hovered.catIndex === bar.catIndex &&
			hovered.seriesIndex === bar.seriesIndex
		);
	}

	function tooltipFor(bar: BarRect): { title: string; rows: TooltipRow[] } {
		return {
			title: String(categories[bar.catIndex] ?? ''),
			rows: [
				{
					label: series[bar.seriesIndex].label,
					value: formatValueDisplay(bar.value),
					colorVar: seriesColorVar(bar.seriesIndex)
				}
			]
		};
	}
</script>

<div class="banto-barchart">
	<Legend items={legendItems} />
	<ChartContainer {label} {height} empty={isEmpty} {messages}>
		{#snippet plot({ width, height: plotHeight })}
			{@const m = plotMetrics(width, plotHeight)}
			{@const bars = computeBars(width, plotHeight)}

			{#if horizontal}
				{@const valueScale = linearScale(
					[domainMin, domainMax],
					[m.innerLeft, m.innerLeft + m.innerWidth]
				)}
				{#each valueTicks as tick (tick)}
					<line
						x1={valueScale(tick)}
						x2={valueScale(tick)}
						y1={m.innerTop}
						y2={m.innerTop + m.innerHeight}
						class="gridline"
					/>
					<text
						x={valueScale(tick)}
						y={m.innerTop + m.innerHeight + 16}
						class="tick-label"
						text-anchor="middle"
					>
						{formatValueDisplay(tick)}
					</text>
				{/each}
				{#each categories as cat, i (i)}
					{@const catScale = bandScale(
						data.length,
						[m.innerTop, m.innerTop + m.innerHeight],
						CATEGORY_PADDING
					)}
					<text
						x={m.innerLeft - 8}
						y={catScale.center(i)}
						class="tick-label"
						text-anchor="end"
						dominant-baseline="middle"
					>
						{cat}
					</text>
				{/each}
				<line
					x1={m.innerLeft}
					x2={m.innerLeft}
					y1={m.innerTop}
					y2={m.innerTop + m.innerHeight}
					class="axis-line"
				/>
			{:else}
				{@const valueScale = linearScale(
					[domainMin, domainMax],
					[m.innerTop + m.innerHeight, m.innerTop]
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
				{#each categories as cat, i (i)}
					{@const catScale = bandScale(
						data.length,
						[m.innerLeft, m.innerLeft + m.innerWidth],
						CATEGORY_PADDING
					)}
					<text
						x={catScale.center(i)}
						y={m.innerTop + m.innerHeight + 16}
						class="tick-label"
						text-anchor="middle"
					>
						{cat}
					</text>
				{/each}
				<line
					x1={m.innerLeft}
					x2={m.innerLeft + m.innerWidth}
					y1={m.innerTop + m.innerHeight}
					y2={m.innerTop + m.innerHeight}
					class="axis-line"
				/>
			{/if}

			{#each bars as bar (`${bar.catIndex}-${bar.seriesIndex}`)}
				<!-- Per-mark hover highlight/tooltip (rule 6); pointer-only, see LineChart's hover-surface comment for rationale. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<path
					d={roundedTopBarPath(bar.x, bar.y, bar.w, bar.h, bar.radius, horizontal)}
					fill={seriesColorVar(bar.seriesIndex)}
					stroke="var(--banto-surface)"
					stroke-width="2"
					class="bar"
					class:hovered={isHovered(bar)}
					onpointerenter={() =>
						(hovered = { catIndex: bar.catIndex, seriesIndex: bar.seriesIndex })}
					onpointerleave={() => (hovered = null)}
				/>
			{/each}
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hovered}
				{@const bars = computeBars(width, plotHeight)}
				{@const bar = bars.find(
					(b) => b.catIndex === hovered!.catIndex && b.seriesIndex === hovered!.seriesIndex
				)}
				{#if bar}
					{@const info = tooltipFor(bar)}
					<Tooltip
						x={bar.x + (horizontal ? bar.w : bar.w / 2)}
						y={bar.y + (horizontal ? bar.h / 2 : 0)}
						containerWidth={width}
						containerHeight={plotHeight}
						title={info.title}
						rows={info.rows}
					/>
				{/if}
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-barchart {
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
</style>
