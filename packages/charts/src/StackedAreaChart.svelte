<script lang="ts" generics="TRow">
	/**
	 * Stacked area chart (spec §6, roadmap.md M24 "積立グラフ・折れ線"): each
	 * series is stacked on top of the previous one, the band between adjacent
	 * cumulative boundaries filled, and the top boundary drawn as a line.
	 *
	 * This is the line/area counterpart of `BarChart`'s `stacked` option (which
	 * already covers 積立棒). It is a dedicated component rather than a
	 * `LineChart` flag on purpose: `LineChart` carries zoom/pan, a second
	 * y-axis and decimation whose semantics conflict with a single shared
	 * cumulative baseline, so keeping the stack math in its own simpler shell
	 * (no zoom, single left axis) avoids entangling the two.
	 *
	 * X is an index-spaced ordered category axis (same convention as
	 * `LineChart`; see `core/ticks-time.ts` for why a real time scale is out of
	 * v1 scope). The stacking offsets come from the shared, unit-tested
	 * `core/stack.ts` so positive/negative mixed stacks and NaN handling match
	 * `BarChart` exactly. Tooltips show each series' RAW (un-stacked) value plus
	 * the running total.
	 */
	import { linearScale, niceTicks } from './core/scale';
	import { leftMarginForTicks } from './core/labels';
	import { stackSeries } from './core/stack';
	import { bandAreaPath, linePath, type Point } from './core/path';
	import { everyNthIndex } from './core/ticks-time';
	import { seriesColorVar } from './core/color';
	import { getValue, toNumber, type Accessor, type ChartMargin, type TooltipRow } from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Legend from './internal/Legend.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import { defaultChartMessages, type ChartMessages } from './messages';

	interface AreaSeries {
		id: string;
		label: string;
		y: Accessor<TRow>;
	}

	interface Props {
		data: TRow[];
		x: Accessor<TRow>;
		series: AreaSeries[];
		label: string;
		height?: number;
		formatY?: (n: number) => string;
		formatX?: (v: unknown) => string;
		/** Per-side overrides merged over the defaults. */
		margins?: Partial<ChartMargin>;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings (and `ChartContainer`'s empty-state text). Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		data,
		x,
		series,
		label,
		height = 240,
		formatY,
		formatX,
		margins,
		messages = {}
	}: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultChartMessages, ...messages };

	const DEFAULT_MARGIN: ChartMargin = { top: 12, right: 16, bottom: 28, left: 48 };
	const MIN_TICK_SPACING = 70;

	const formatYValue = $derived(formatY ?? ((n: number) => n.toLocaleString()));
	const formatXValue = $derived(formatX ?? ((v: unknown) => String(v ?? '')));

	const count = $derived(data.length);
	const xLabels = $derived(data.map((row) => getValue(row, x)));

	// matrix[categoryIndex][seriesIndex] - one row per data point, one column
	// per series, exactly the shape `stackSeries` expects.
	const matrix = $derived(data.map((row) => series.map((s) => toNumber(getValue(row, s.y)))));
	// segments[categoryIndex][seriesIndex] = { value, start, end } running offsets.
	const segments = $derived(stackSeries(matrix));

	// Domain spans every running boundary (min start .. max end) so negative
	// series stack below 0 without clipping; falls back to [0, 1] when empty.
	const valueExtent = $derived.by<[number, number]>(() => {
		let min = Infinity;
		let max = -Infinity;
		for (const row of segments) {
			for (const seg of row) {
				if (seg.start < min) min = seg.start;
				if (seg.end < min) min = seg.end;
				if (seg.start > max) max = seg.start;
				if (seg.end > max) max = seg.end;
			}
		}
		if (!Number.isFinite(min)) return [0, 1];
		return [Math.min(0, min), Math.max(0, max)];
	});

	const isEmpty = $derived(count === 0 || series.length === 0);

	const ticks = $derived(niceTicks(valueExtent[0], valueExtent[1], 5));

	let plotWidth: number = $state(0);

	// Left margin auto-expands to fit the y tick labels (never below the
	// caller's/default left margin, so labels that already fit are unchanged).
	const MARGIN = $derived.by(() => {
		const m = { ...DEFAULT_MARGIN, ...margins };
		return {
			...m,
			left: leftMarginForTicks(
				ticks.map((t) => formatYValue(t)),
				m.left,
				{ totalWidth: plotWidth }
			)
		};
	});

	const metrics = $derived.by(() => {
		const innerLeft = MARGIN.left;
		const innerTop = MARGIN.top;
		const innerWidth = Math.max(0, plotWidth - MARGIN.left - MARGIN.right);
		const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);
		return {
			innerLeft,
			innerTop,
			innerWidth,
			innerHeight,
			innerRight: innerLeft + innerWidth,
			innerBottom: innerTop + innerHeight
		};
	});

	const scale = $derived(
		linearScale([ticks[0], ticks[ticks.length - 1]], [metrics.innerBottom, metrics.innerTop])
	);

	function xAt(index: number): number {
		if (count <= 1) return metrics.innerLeft + metrics.innerWidth / 2;
		return metrics.innerLeft + (index / (count - 1)) * metrics.innerWidth;
	}

	// Per-series filled band + top line. Depends on data/scale/size only (never
	// on hover), so moving the crosshair does not rebuild these paths.
	const seriesPaths = $derived.by(() =>
		series.map((_, i) => {
			const top: Point[] = [];
			const bottom: Point[] = [];
			for (let idx = 0; idx < count; idx++) {
				const seg = segments[idx][i];
				const px = xAt(idx);
				top.push({ x: px, y: scale(seg.end) });
				bottom.push({ x: px, y: scale(seg.start) });
			}
			return {
				color: seriesColorVar(i),
				area: bandAreaPath(top, bottom),
				line: linePath(top)
			};
		})
	);

	const legendItems = $derived(
		series.map((s, i) => ({ id: s.id, label: s.label, colorVar: seriesColorVar(i) }))
	);

	function maxXTicksFor(innerWidth: number): number {
		return Math.max(2, Math.min(8, Math.floor(innerWidth / MIN_TICK_SPACING)));
	}

	let hoveredIndex: number | null = $state(null);

	function handlePointerMove(event: PointerEvent) {
		const bounds = (event.currentTarget as SVGRectElement).getBoundingClientRect();
		if (metrics.innerWidth <= 0 || count === 0) return;
		const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / metrics.innerWidth));
		hoveredIndex = Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
	}

	function handlePointerLeave() {
		hoveredIndex = null;
	}

	function tooltipRows(index: number): TooltipRow[] {
		const rows: TooltipRow[] = series.map((s, i) => {
			const raw = matrix[index][i];
			return {
				label: s.label,
				value: Number.isFinite(raw) ? formatYValue(raw) : '-',
				colorVar: seriesColorVar(i)
			};
		});
		const last = segments[index][series.length - 1];
		if (last) rows.push({ label: t.stackedAreaTotal(), value: formatYValue(last.end) });
		return rows;
	}
</script>

<div class="banto-stackedarea">
	<Legend items={legendItems} />
	<ChartContainer {label} {height} empty={isEmpty} bind:width={plotWidth} {messages}>
		{#snippet plot()}
			{@const m = metrics}
			<!-- Gridlines + y ticks (recessive, rule 4). -->
			{#each ticks as tick (tick)}
				<line
					x1={m.innerLeft}
					x2={m.innerRight}
					y1={scale(tick)}
					y2={scale(tick)}
					class="gridline"
				/>
				<text
					x={m.innerLeft - 8}
					y={scale(tick)}
					class="tick-label"
					text-anchor="end"
					dominant-baseline="middle"
				>
					{formatYValue(tick)}
				</text>
			{/each}

			<!-- Left + bottom axis lines. -->
			<line
				x1={m.innerLeft}
				x2={m.innerLeft}
				y1={m.innerTop}
				y2={m.innerBottom}
				class="axis-line"
			/>
			<line
				x1={m.innerLeft}
				x2={m.innerRight}
				y1={m.innerBottom}
				y2={m.innerBottom}
				class="axis-line"
			/>

			<!-- X labels. -->
			{@const xTicks = everyNthIndex(count, maxXTicksFor(m.innerWidth))}
			{#each xTicks as i (i)}
				<text
					x={xAt(i)}
					y={m.innerBottom + 18}
					class="tick-label"
					text-anchor={i === count - 1 ? 'end' : 'middle'}
				>
					{formatXValue(xLabels[i])}
				</text>
			{/each}

			<!-- Stacked bands (bottom series first) + top boundary lines. -->
			{#each series as s, i (s.id)}
				<path
					d={seriesPaths[i].area}
					fill={seriesPaths[i].color}
					fill-opacity="0.55"
					stroke="none"
				/>
			{/each}
			{#each series as s, i (s.id)}
				<path d={seriesPaths[i].line} fill="none" stroke={seriesPaths[i].color} stroke-width="2" />
			{/each}

			<!-- Crosshair + per-series boundary markers. -->
			{#if hoveredIndex !== null}
				{@const hx = xAt(hoveredIndex)}
				<line x1={hx} x2={hx} y1={m.innerTop} y2={m.innerBottom} class="crosshair" />
				{#each series as s, i (s.id)}
					<circle
						cx={hx}
						cy={scale(segments[hoveredIndex][i].end)}
						r="3.5"
						fill={seriesColorVar(i)}
						stroke="var(--banto-surface)"
						stroke-width="2"
					/>
				{/each}
			{/if}

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<rect
				x={m.innerLeft}
				y={m.innerTop}
				width={m.innerWidth}
				height={m.innerHeight}
				fill="transparent"
				onpointermove={handlePointerMove}
				onpointerleave={handlePointerLeave}
			/>
		{/snippet}
		{#snippet overlay()}
			{#if hoveredIndex !== null}
				<Tooltip
					x={xAt(hoveredIndex)}
					y={metrics.innerTop}
					containerWidth={plotWidth}
					containerHeight={height}
					title={formatXValue(xLabels[hoveredIndex])}
					rows={tooltipRows(hoveredIndex)}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-stackedarea {
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

	.tick-label {
		fill: var(--banto-text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
</style>
