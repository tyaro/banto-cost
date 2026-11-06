<script lang="ts">
	/**
	 * Shared body renderer for a single dashboard dock panel (spec §5.3 v2
	 * pop-out): extracted from the dashboard page's `dockPanel` snippet so the
	 * SAME markup can render inside the dashboard's `DockHost` (docked pane or
	 * floating pseudo-window) AND, unmodified, as the standalone content of a
	 * REAL Tauri `WebviewWindow` at `routes/panel/[id]` once a panel is popped
	 * out - that route has no access to the dashboard page's own locals, so
	 * this component is fully self-contained: it loads its own `items` data
	 * rather than receiving already-aggregated rows as props.
	 *
	 * NOTE (perf): this loads the full item list (up to 20,000 rows, same
	 * `initialParams` as the dashboard page) independently, once per
	 * component instance. That means a popped-out panel's native window loads
	 * its own copy on top of whatever the main window already holds - fine
	 * here since each Tauri window is its own document/JS heap with no shared
	 * cache between them (no cross-window `admin-core` cache exists yet); an
	 * app with a heavier data provider would want to add one before relying on
	 * this pattern for many simultaneous pop-out windows.
	 */
	import {
		BoxPlot,
		downloadSvg,
		Histogram,
		LineChart,
		ParetoChart,
		PieChart,
		rollingAppend
	} from '@banto/charts';
	import { createListResource } from '@banto/admin-core';
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { Item } from '#lib/banto/sampleData.js';
	import {
		categoryCounts,
		nextTrendPoint,
		priceBuckets,
		priceByCategoryGroups,
		priceValues,
		seedTrendPoints,
		updatesByMonth,
		type TrendPoint
	} from '#lib/banto/dashboard.js';

	interface Props {
		id: string;
		/** Chart height in px; the caller measures its own container (dashboard: the dock pane's body; `/panel/[id]`: the route's viewport). */
		height?: number;
	}

	let { id, height = 280 }: Props = $props();

	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: 20_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	const monthCounts = $derived(updatesByMonth(list.rows));
	const buckets = $derived(priceBuckets(list.rows));

	// M13 SPC panel demo data (roadmap.md M13, `#lib/banto/dashboard.ts`):
	// price distribution (histogram + normal curve), category Pareto, price
	// spread per top category (box plot).
	const prices = $derived(priceValues(list.rows));
	const paretoItems = $derived(categoryCounts(list.rows));
	const boxGroups = $derived(priceByCategoryGroups(list.rows));

	// M13 trend panel demo (roadmap.md M13): 1 point/sec streaming via
	// `rollingAppend` (window capped so the chart never grows unbounded),
	// started/stopped with this component's own lifecycle - each dock
	// pane/floating window/popped-out Tauri window gets its own instance and
	// therefore its own interval (see `core/rolling.ts`, `LineChart`'s
	// streaming doc comment).
	const TREND_WINDOW = 120;
	const TREND_INTERVAL_MS = 1000;
	let trendData: TrendPoint[] = $state(seedTrendPoints(40));
	let trendTimer: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		if (id !== 'trend') return;
		trendTimer = setInterval(() => {
			const next = nextTrendPoint(trendData[trendData.length - 1]);
			trendData = rollingAppend(trendData, [next], TREND_WINDOW);
		}, TREND_INTERVAL_MS);
	});

	onDestroy(() => clearInterval(trendTimer));

	const trendBands = [
		{ from: 66, to: 70, label: m['dashboard.trendBandControl'](), colorVar: 'var(--banto-success)' }
	];
	const trendMarkers = [
		{ at: 10, label: m['dashboard.trendMarkerInspect'](), colorVar: 'var(--banto-warning)' }
	];

	// M13 SVG export demo (roadmap.md M13, `core/export.ts`): the chart
	// components don't expose their `<svg>` via a prop/ref, so the caller
	// grabs it with a plain DOM query on the wrapping element instead (the
	// pattern `core/export.ts`'s doc comment describes for "利用側").
	let histogramWrapper: HTMLElement | undefined = $state();
	function exportHistogram(): void {
		const svg = histogramWrapper?.querySelector('svg');
		if (svg) downloadSvg(svg, 'price-histogram.svg');
	}

	const countLabel = (n: number) => m['dashboard.countUnit']({ count: n.toLocaleString() });
	const yen = (n: number) => `¥${n.toLocaleString()}`;
</script>

{#if list.loading && list.rows.length === 0}
	<p class="status">{m['common.loading']()}</p>
{:else if id === 'monthly'}
	<LineChart
		data={monthCounts}
		x={(row) => row.month}
		series={[{ id: 'count', label: m['dashboard.seriesUpdates'](), y: (row) => row.count }]}
		area
		label={m['dashboard.monthlyAria']()}
		{height}
		formatY={(n) => n.toLocaleString()}
	/>
{:else if id === 'priceBuckets'}
	<PieChart
		data={buckets}
		category={(row) => row.bucket}
		value={(row) => row.count}
		donut
		label={m['dashboard.priceBucketAria']()}
		{height}
		formatValue={countLabel}
	/>
{:else if id === 'spc'}
	<div class="spc-panel">
		<section class="spc-chart" bind:this={histogramWrapper}>
			<div class="spc-chart-header">
				<h3>{m['dashboard.spcHistogramTitle']()}</h3>
				<button type="button" class="export-btn" onclick={exportHistogram}
					>{m['dashboard.svgExport']()}</button
				>
			</div>
			<Histogram
				values={prices}
				label={m['dashboard.spcHistogramAria']()}
				height={220}
				normalCurve
				formatValue={yen}
			/>
		</section>
		<section class="spc-chart">
			<h3>{m['dashboard.spcParetoTitle']()}</h3>
			<ParetoChart
				items={paretoItems}
				label={m['dashboard.spcParetoAria']()}
				height={220}
				formatValue={countLabel}
			/>
		</section>
		<section class="spc-chart">
			<h3>{m['dashboard.spcBoxTitle']()}</h3>
			<BoxPlot
				groups={boxGroups}
				label={m['dashboard.spcBoxAria']()}
				height={220}
				formatValue={yen}
			/>
		</section>
	</div>
{:else if id === 'trend'}
	<LineChart
		data={trendData}
		x={(row) => row.t}
		series={[
			{ id: 'temperature', label: m['dashboard.trendTemp'](), y: (row) => row.temperature },
			{
				id: 'pressure',
				label: m['dashboard.trendPressure'](),
				y: (row) => row.pressure,
				axis: 'right'
			}
		]}
		label={m['dashboard.trendAria']()}
		{height}
		zoomable
		bands={trendBands}
		markers={trendMarkers}
		formatX={(v) => `#${v}`}
		formatY={(n) => `${n.toFixed(1)}℃`}
		formatYRight={(n) => `${n.toFixed(2)}MPa`}
	/>
{:else if id === 'memo'}
	<p class="memo">{m['dashboard.panelMemoBody']()}</p>
{:else}
	<p class="status">{m['dashboard.unknownPanel']()}</p>
{/if}

<style>
	/* Caption-style status/memo text (dashboard page's .card-caption, spec §10). */
	.status,
	.memo {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
		text-wrap: pretty;
	}

	.memo {
		line-height: 1.6;
	}

	.spc-panel {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		height: 100%;
		overflow-y: auto;
	}

	/* Sub-chart card (dashboard page's .card, spec §10): same face/border/
	   radius/shadow so the SPC panel's stacked charts read as the same kind
	   of card as the top-level dashboard grid. */
	.spc-chart {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: 0.85rem 1rem;
	}

	.spc-chart h3 {
		margin: 0 0 0.25rem;
		font-size: 1rem;
		font-weight: 600;
		color: var(--banto-text);
		font-feature-settings: 'palt';
	}

	.spc-chart-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.spc-chart-header h3 {
		margin: 0;
	}

	.export-btn {
		border: 1px solid var(--banto-border);
		border-radius: 999px;
		background: var(--banto-surface);
		color: var(--banto-text);
		padding: 0.2rem 0.7rem;
		font-size: 0.75rem;
		cursor: pointer;
		transition:
			border-color var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.export-btn:hover {
		border-color: var(--banto-primary);
		color: var(--banto-primary);
	}

	.export-btn:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}
</style>
