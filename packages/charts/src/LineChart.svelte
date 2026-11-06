<script lang="ts" generics="TRow">
	/**
	 * Line/area chart (spec §6). X is treated as an ordered category axis
	 * (index-spaced, see `core/ticks-time.ts` for why a real time scale is
	 * out of scope for v1) - a shared vertical crosshair + tooltip (spec rule
	 * 6) snaps to the nearest data index on hover anywhere over the plot.
	 *
	 * M13 (roadmap.md) trend upgrades, all opt-in and API-compatible:
	 *  - `zoomable`: wheel-zoom (cursor as fixed point) + drag-pan + double-click
	 *    reset, driven by the pure `core/viewport` window math.
	 *  - `bands` / `markers`: threshold/control-limit bands and vertical event
	 *    markers (annotations).
	 *  - per-series `axis: 'right'`: an independent second y-scale + right axis.
	 *  - streaming: heavy scale/decimation/path math is coarse-grained `$derived`
	 *    that recomputes on data/zoom changes but NOT on hover, and a rolling
	 *    data feed only re-renders the changed paths.
	 *
	 * Performance: when the visible window still holds more points than the plot
	 * is pixels wide, points are decimated (`core/decimate`) so a 10k x 10-series
	 * trend stays at an interactive frame rate while panning/zooming.
	 *
	 * With all M13 options at their defaults (`zoomable=false`, no bands/markers,
	 * every series on the left axis) the output is byte-identical to the pre-M13
	 * chart - the viewport stays pinned to the full domain, so x positions and
	 * the (never-triggered) decimation reduce to the original index spacing.
	 */
	import { linearScale, niceTicks } from './core/scale';
	import { mergeExtent } from './core/extent';
	import { linePathSegments, areaPathSegments } from './core/path';
	import { seriesNumber, seriesSegments } from './core/series';
	import { resolveBand } from './core/band';
	import { everyNthIndex } from './core/ticks-time';
	import { seriesColorVar } from './core/color';
	import { leftMarginForTicks, rightMarginForTicks } from './core/labels';
	import {
		fullViewport,
		isFullViewport,
		panViewport,
		visibleRange,
		zoomViewport,
		type Viewport
	} from './core/viewport';
	import { untrack } from 'svelte';
	import { decimatedIndices } from './core/decimate';
	import {
		getValue,
		type Accessor,
		type ChartAxis,
		type ChartMargin,
		type EventMarker,
		type OpenThresholdBand,
		type TooltipRow
	} from './types';
	import { formatTooltipValue, type FormatTooltip } from './core/tooltip';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Legend from './internal/Legend.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import { defaultChartMessages, type ChartMessages } from './messages';

	interface LineSeries {
		id: string;
		label: string;
		y: Accessor<TRow>;
		/** Which y-scale to draw against (M13 第2Y軸). Default 'left'. */
		axis?: ChartAxis;
	}

	interface Props {
		data: TRow[];
		x: Accessor<TRow>;
		series: LineSeries[];
		area?: boolean;
		label: string;
		height?: number;
		formatY?: (n: number) => string;
		formatX?: (v: unknown) => string;
		/** Per-side overrides merged over the defaults below. */
		margins?: Partial<ChartMargin>;
		/**
		 * Enable wheel-zoom / drag-pan / double-click-reset (M13). Default false
		 * keeps the original fully-static behavior - no API break for callers.
		 */
		zoomable?: boolean;
		/** Shaded horizontal threshold/control-limit bands (M13 しきい値バンド). */
		bands?: OpenThresholdBand[];
		/** Vertical event markers at data indices (M13 注釈). */
		markers?: EventMarker[];
		/** Formatter for the RIGHT y-axis tick/tooltip values; defaults to `formatY`. */
		formatYRight?: (n: number) => string;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings (and `ChartContainer`'s empty-state text). Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
		/**
		 * How non-finite points (null/NaN/missing) are handled: `'join'` (default)
		 * skips them and connects the neighbours across the gap (the original
		 * behavior); `'break'` splits the line (and area) into separate subpaths
		 * so the gap stays visible.
		 */
		gaps?: 'join' | 'break';
		/**
		 * Values that the LEFT y-axis extent must always include (e.g. `[0, 1]`
		 * for bit tags). Merged into the axis extent only: it adds no data
		 * point, tooltip entry, legend item or series, and does not make an
		 * otherwise empty chart non-empty. Non-finite entries are ignored.
		 */
		includeY?: readonly number[];
		/**
		 * Tooltip-only value formatter, called per series with the finite value,
		 * the series info and the data index. Omitted → `formatY` (right-axis
		 * series: `formatYRight`) as before. Never used for axis tick labels or
		 * the auto margins; non-finite values stay `'-'` and skip it.
		 */
		formatTooltip?: FormatTooltip;
	}

	let {
		data,
		x,
		series,
		area = false,
		label,
		height = 240,
		formatY,
		formatX,
		margins,
		zoomable = false,
		bands = [],
		markers = [],
		formatYRight,
		messages = {},
		gaps = 'join',
		includeY,
		formatTooltip
	}: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultChartMessages, ...messages };

	const DEFAULT_MARGIN: ChartMargin = { top: 12, right: 16, bottom: 28, left: 48 };
	// Minimum px per x-axis tick label so dense datasets don't overlap; the
	// actual tick count is derived per-render from the measured plot width.
	const MIN_TICK_SPACING = 70;
	// Wheel-zoom step: one notch up narrows the window to 80%, one notch down
	// widens it by the exact inverse so zoom in/out are symmetric.
	const ZOOM_IN = 0.8;
	const ZOOM_OUT = 1 / ZOOM_IN;

	const formatYValue = $derived(formatY ?? ((n: number) => n.toLocaleString()));
	const formatYRightValue = $derived(formatYRight ?? formatYValue);
	const formatXValue = $derived(formatX ?? ((v: unknown) => String(v ?? '')));

	const count = $derived(data.length);
	const xLabels = $derived(data.map((row) => getValue(row, x)));

	const isRight = (s: LineSeries): boolean => (s.axis ?? 'left') === 'right';
	const hasRight = $derived(series.some(isRight));

	// Per-series full numeric arrays. Recomputed only when `data`/`series`
	// change (e.g. a streaming append) - NOT on hover or zoom. The pixel mapping
	// that depends on the viewport lives in `seriesPaths` below, so a rolling
	// data feed re-derives arrays once and the crosshair never rebuilds paths.
	const seriesValues = $derived(
		series.map((s) => data.map((row) => seriesNumber(getValue(row, s.y), gaps)))
	);

	// Value extents via an explicit loop rather than `Math.min(...arr)` so a
	// 10k x 10-series dataset can't overflow the argument-spread stack limit.
	function extentOf(pick: (s: LineSeries) => boolean): [number, number] {
		let min = Infinity;
		let max = -Infinity;
		for (let i = 0; i < series.length; i++) {
			if (!pick(series[i])) continue;
			const arr = seriesValues[i];
			for (let k = 0; k < arr.length; k++) {
				const v = arr[k];
				if (Number.isFinite(v)) {
					if (v < min) min = v;
					if (v > max) max = v;
				}
			}
		}
		return [min, max];
	}

	const leftExtent = $derived(extentOf((s) => !isRight(s)));
	const rightExtent = $derived(extentOf(isRight));

	const isEmpty = $derived(
		count === 0 ||
			series.length === 0 ||
			(!Number.isFinite(leftExtent[0]) && !Number.isFinite(rightExtent[0]))
	);

	// Y domains are pinned to the FULL data extent (not the visible window), so
	// panning/zooming x never makes the y-axis jump - matches the pre-M13 static
	// scaling exactly when there is no second axis.
	// `includeY` widens the tick extent only; `isEmpty` above still looks at the
	// data extent, so forced values never turn an empty chart into a plot.
	const leftTickExtent = $derived(mergeExtent(leftExtent, includeY));
	const leftTicks = $derived(
		Number.isFinite(leftTickExtent[0]) ? niceTicks(leftTickExtent[0], leftTickExtent[1], 5) : [0, 1]
	);
	const rightTicks = $derived(
		hasRight && Number.isFinite(rightExtent[0])
			? niceTicks(rightExtent[0], rightExtent[1], 5)
			: [0, 1]
	);

	// Both margins auto-expand to fit y tick labels. Left: never below the
	// caller's (or default) left margin, so labels that already fit keep the
	// exact previous layout. Right: with no right series it stays exactly the
	// caller's (or default) right margin, so the classic single-axis layout is
	// unchanged.
	const MARGIN = $derived.by(() => {
		const base = { ...DEFAULT_MARGIN, ...margins };
		const left = leftMarginForTicks(leftTicks.map(formatYValue), base.left, {
			totalWidth: plotWidth
		});
		if (!hasRight) return { ...base, left };
		const right = rightMarginForTicks(rightTicks.map(formatYRightValue), base.right, {
			totalWidth: plotWidth
		});
		return { ...base, left, right };
	});

	// Measured plot width, bound from ChartContainer so all scale/path math can
	// live in script-level `$derived` (decoupled from the hover state).
	let plotWidth: number = $state(0);

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

	const leftScale = $derived(
		linearScale(
			[leftTicks[0], leftTicks[leftTicks.length - 1]],
			[metrics.innerBottom, metrics.innerTop]
		)
	);
	const rightScale = $derived(
		linearScale(
			[rightTicks[0], rightTicks[rightTicks.length - 1]],
			[metrics.innerBottom, metrics.innerTop]
		)
	);

	let hoveredIndex: number | null = $state(null);

	// Viewport is a window into INDEX space (core/viewport). It starts full and,
	// with zoom disabled, stays full - so `xAt` reduces to the original spacing.
	// The initial data length is read untracked: this is a one-time seed, the
	// `$effect` below owns all subsequent viewport updates when `data` changes.
	const initialCount = untrack(() => data.length);
	let viewport: Viewport = $state(fullViewport(initialCount));
	let lastCount = initialCount;

	// Streaming behavior (roadmap.md M13): follow the leading edge only while
	// fully zoomed out; keep the current window (clamped into the new domain)
	// while zoomed in. Guarded on a real count change so writing `viewport`
	// here can't feed back into a loop.
	$effect(() => {
		const c = data.length;
		if (c === lastCount) return;
		viewport = isFullViewport(viewport, lastCount) ? fullViewport(c) : panViewport(viewport, 0, c);
		if (hoveredIndex !== null && hoveredIndex > c - 1) hoveredIndex = null;
		lastCount = c;
	});

	function xAt(index: number): number {
		if (count <= 1) return metrics.innerLeft + metrics.innerWidth / 2;
		const span = viewport.end - viewport.start;
		if (span <= 0) return metrics.innerLeft + metrics.innerWidth / 2;
		return metrics.innerLeft + ((index - viewport.start) / span) * metrics.innerWidth;
	}

	// Visible data indices, then decimated to at most ~1 sample per plot pixel.
	const range = $derived(visibleRange(viewport, count));
	const renderIndices = $derived(
		decimatedIndices(range[0], range[1], Math.max(1, Math.round(metrics.innerWidth)))
	);

	// Path strings per series. Coarse-grained on purpose: depends on data,
	// viewport, plot size and scales - NEVER on `hoveredIndex` - so moving the
	// crosshair does not rebuild these (potentially thousands-of-segment) paths.
	const seriesPaths = $derived.by(() =>
		series.map((s, i) => {
			const scale = isRight(s) ? rightScale : leftScale;
			const vals = seriesValues[i];
			const segs = seriesSegments(vals, renderIndices, xAt, scale, gaps);
			return {
				color: seriesColorVar(i),
				line: linePathSegments(segs),
				area: area ? areaPathSegments(segs, metrics.innerBottom) : ''
			};
		})
	);

	const legendItems = $derived(
		series.map((s, i) => ({ id: s.id, label: s.label, colorVar: seriesColorVar(i) }))
	);

	const zoomed = $derived(zoomable && !isFullViewport(viewport, count));

	function maxXTicksFor(innerWidth: number): number {
		return Math.max(2, Math.min(8, Math.floor(innerWidth / MIN_TICK_SPACING)));
	}

	// X tick indices restricted to the visible window (offset the relative
	// `everyNthIndex` layout by the window's low edge).
	function xTickIndices(maxTicks: number): number[] {
		const [lo, hi] = range;
		const n = hi - lo + 1;
		if (n <= 0) return [];
		return everyNthIndex(n, maxTicks).map((r) => lo + r);
	}

	// --- Pointer interaction -------------------------------------------------
	// ChartContainer sets the <svg> viewBox to the exact pixel size, so 1 unit
	// == 1 screen px and the capture rect's bounding-box left edge sits at
	// `innerLeft`; `clientX - bounds.left` is therefore the px offset into the
	// inner plot width, needing no reference to the outer <svg>.
	function ratioFromClientX(clientX: number, boundsLeft: number): number {
		if (metrics.innerWidth <= 0) return 0;
		return Math.max(0, Math.min(1, (clientX - boundsLeft) / metrics.innerWidth));
	}

	function indexFromRatio(ratio: number): number {
		const idx = Math.round(viewport.start + ratio * (viewport.end - viewport.start));
		return Math.max(0, Math.min(count - 1, idx));
	}

	let panning = $state(false);
	let panPointerId = -1;
	let panStartClientX = 0;
	let panStartViewport: Viewport = { start: 0, end: 1 };

	function handleWheel(event: WheelEvent) {
		if (!zoomable) return;
		// Non-passive by default on a non-root element, so this actually stops
		// the page from scrolling while zooming the chart.
		event.preventDefault();
		const bounds = (event.currentTarget as SVGRectElement).getBoundingClientRect();
		const ratio = ratioFromClientX(event.clientX, bounds.left);
		const focus = viewport.start + ratio * (viewport.end - viewport.start);
		viewport = zoomViewport(viewport, focus, event.deltaY < 0 ? ZOOM_IN : ZOOM_OUT, count);
	}

	function handlePointerDown(event: PointerEvent) {
		if (!zoomable || event.button !== 0) return;
		const target = event.currentTarget as SVGRectElement;
		target.setPointerCapture(event.pointerId);
		panning = true;
		panPointerId = event.pointerId;
		panStartClientX = event.clientX;
		panStartViewport = viewport;
	}

	function handlePointerMove(event: PointerEvent) {
		const bounds = (event.currentTarget as SVGRectElement).getBoundingClientRect();
		if (panning) {
			const span = panStartViewport.end - panStartViewport.start;
			const dxPx = event.clientX - panStartClientX;
			// Dragging the plot rightward reveals earlier data, so the window
			// moves backward (negative delta).
			const delta = metrics.innerWidth > 0 ? -(dxPx / metrics.innerWidth) * span : 0;
			viewport = panViewport(panStartViewport, delta, count);
			return; // don't move the crosshair while actively panning
		}
		hoveredIndex = indexFromRatio(ratioFromClientX(event.clientX, bounds.left));
	}

	function endPan(event: PointerEvent) {
		if (!panning || event.pointerId !== panPointerId) return;
		const target = event.currentTarget as SVGRectElement;
		if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
		panning = false;
		panPointerId = -1;
	}

	function handlePointerLeave() {
		if (!panning) hoveredIndex = null;
	}

	function resetZoom() {
		viewport = fullViewport(count);
	}

	function handleDblClick() {
		if (zoomable) resetZoom();
	}

	function tooltipRows(index: number): TooltipRow[] {
		return series.map((s, i) => {
			const raw = seriesValues[i][index];
			return {
				label: s.label,
				value: formatTooltipValue(
					raw,
					{ id: s.id, label: s.label, axis: isRight(s) ? 'right' : 'left' },
					index,
					formatTooltip,
					formatYValue,
					formatYRightValue
				),
				colorVar: seriesColorVar(i)
			};
		});
	}
</script>

<div class="banto-linechart">
	<Legend items={legendItems} />
	<ChartContainer {label} {height} empty={isEmpty} bind:width={plotWidth} {messages}>
		{#snippet plot()}
			{@const m = metrics}
			<!-- Threshold bands (drawn first, under the data). -->
			{#each bands as band, bi (bi)}
				{@const scale = band.axis === 'right' ? rightScale : leftScale}
				{@const rb = resolveBand(
					band.from,
					band.to,
					band.axis === 'right'
						? [rightTicks[0], rightTicks[rightTicks.length - 1]]
						: [leftTicks[0], leftTicks[leftTicks.length - 1]]
				)}
				{#if rb}
					{@const yTop = scale(rb.high)}
					{@const yBottom = scale(rb.low)}
					{@const bandColor = band.colorVar ?? 'var(--banto-chart-axis)'}
					<rect
						x={m.innerLeft}
						y={yTop}
						width={m.innerWidth}
						height={Math.max(0, yBottom - yTop)}
						fill={bandColor}
						fill-opacity="0.1"
					/>
					{#if rb.highEdge}
						<line
							x1={m.innerLeft}
							x2={m.innerRight}
							y1={yTop}
							y2={yTop}
							class="band-edge"
							stroke={bandColor}
						/>
					{/if}
					{#if rb.lowEdge}
						<line
							x1={m.innerLeft}
							x2={m.innerRight}
							y1={yBottom}
							y2={yBottom}
							class="band-edge"
							stroke={bandColor}
						/>
					{/if}
					{#if band.label}
						<text x={m.innerLeft + 6} y={yTop + 11} class="band-label" fill={bandColor}
							>{band.label}</text
						>
					{/if}
				{/if}
			{/each}

			<!-- Gridlines + left y ticks (recessive, rule 4). -->
			{#each leftTicks as tick (tick)}
				<line
					x1={m.innerLeft}
					x2={m.innerRight}
					y1={leftScale(tick)}
					y2={leftScale(tick)}
					class="gridline"
				/>
				<text
					x={m.innerLeft - 8}
					y={leftScale(tick)}
					class="tick-label y-tick"
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

			<!-- Right axis (only when a series opts into axis:'right'). -->
			{#if hasRight}
				<line
					x1={m.innerRight}
					x2={m.innerRight}
					y1={m.innerTop}
					y2={m.innerBottom}
					class="axis-line"
				/>
				{#each rightTicks as tick (tick)}
					{@const ry = rightScale(tick)}
					<line x1={m.innerRight} x2={m.innerRight + 4} y1={ry} y2={ry} class="axis-line" />
					<text
						x={m.innerRight + 8}
						y={ry}
						class="tick-label y-tick"
						text-anchor="start"
						dominant-baseline="middle"
					>
						{formatYRightValue(tick)}
					</text>
				{/each}
			{/if}

			<!-- X labels. The right-edge tick is anchored 'end' so it doesn't
			     overhang the right margin and clip. -->
			{@const xTicks = xTickIndices(maxXTicksFor(m.innerWidth))}
			{#each xTicks as i (i)}
				<text
					x={xAt(i)}
					y={m.innerBottom + 18}
					class="tick-label x-tick"
					text-anchor={i === range[1] ? 'end' : 'middle'}
				>
					{formatXValue(xLabels[i])}
				</text>
			{/each}

			<!-- Series areas/lines (decimated, viewport-clipped). -->
			{#each series as s, i (s.id)}
				{#if area && seriesPaths[i].area}
					<path
						d={seriesPaths[i].area}
						fill={seriesPaths[i].color}
						fill-opacity="0.16"
						stroke="none"
					/>
				{/if}
				<path d={seriesPaths[i].line} fill="none" stroke={seriesPaths[i].color} stroke-width="2" />
			{/each}

			<!-- Event markers (vertical dashed line + label), only when visible. -->
			{#each markers as marker, mi (mi)}
				{#if marker.at >= range[0] && marker.at <= range[1]}
					{@const mx = xAt(marker.at)}
					{@const markColor = marker.colorVar ?? 'var(--banto-chart-axis)'}
					<line
						x1={mx}
						x2={mx}
						y1={m.innerTop}
						y2={m.innerBottom}
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

			<!-- Crosshair + per-series hover markers (uses each series' own scale). -->
			{#if hoveredIndex !== null}
				{@const hx = xAt(hoveredIndex)}
				<line x1={hx} x2={hx} y1={m.innerTop} y2={m.innerBottom} class="crosshair" />
				{#each series as s, i (s.id)}
					{@const raw = seriesValues[i][hoveredIndex]}
					{#if Number.isFinite(raw)}
						<circle
							cx={hx}
							cy={(isRight(s) ? rightScale : leftScale)(raw)}
							r="4"
							fill={seriesColorVar(i)}
							stroke="var(--banto-surface)"
							stroke-width="2"
						/>
					{/if}
				{/each}
			{/if}

			<!--
				Hover/zoom/pan capture surface. Pointer-only by design (the tooltip
				is a supplementary aid, not the sole way to read a value - see the
				ChartContainer role="img" note on the planned table fallback), so no
				keyboard equivalent is required here.
			-->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<rect
				x={m.innerLeft}
				y={m.innerTop}
				width={m.innerWidth}
				height={m.innerHeight}
				fill="transparent"
				class:zoomable
				class:panning
				onpointermove={handlePointerMove}
				onpointerleave={handlePointerLeave}
				onpointerdown={handlePointerDown}
				onpointerup={endPan}
				onpointercancel={endPan}
				onwheel={handleWheel}
				ondblclick={handleDblClick}
			/>
		{/snippet}
		{#snippet overlay()}
			{#if zoomed}
				<button type="button" class="reset-zoom" onclick={resetZoom} title={t.lineResetZoomTitle()}>
					{t.lineReset()}
				</button>
			{/if}
			{#if hoveredIndex !== null && !panning}
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
	.banto-linechart {
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

	/* Zoom/pan affordance: grab cursor when enabled, grabbing while dragging. */
	.zoomable {
		cursor: grab;
	}

	.panning {
		cursor: grabbing;
	}

	.reset-zoom {
		position: absolute;
		top: 6px;
		right: 6px;
		z-index: 21;
		padding: 0.15rem 0.5rem;
		font-size: 11px;
		color: var(--banto-text);
		background: var(--banto-surface-raised, var(--banto-surface));
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius);
		cursor: pointer;
		box-shadow: var(--banto-shadow-sm);
	}

	.reset-zoom:hover {
		border-color: var(--banto-chart-axis);
	}
</style>
