<script lang="ts" generics="TRow">
	/**
	 * Pie / donut chart (spec §6). Each row is one slice; slice color follows
	 * the row's index in `data` (rule 1 - fixed order, never reassigned/
	 * cycled if a row disappears between renders).
	 */
	import { pieSlices, arcPath } from './core/pie';
	import { seriesColorVar } from './core/color';
	import { getValue, toNumber, type Accessor, type TooltipRow } from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Legend from './internal/Legend.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import type { ChartMessages } from './messages';

	interface Props {
		data: TRow[];
		category: Accessor<TRow>;
		value: Accessor<TRow>;
		donut?: boolean;
		label: string;
		height?: number;
		formatValue?: (n: number) => string;
		/** i18n layer 1 (docs/conventions.md §13): overrides forwarded to `ChartContainer`'s empty-state text. Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		data,
		category,
		value,
		donut = false,
		label,
		height = 240,
		formatValue,
		messages = {}
	}: Props = $props();

	const formatValueDisplay = $derived(formatValue ?? ((n: number) => n.toLocaleString()));

	const categories = $derived(data.map((row) => getValue(row, category)));
	const values = $derived(data.map((row) => toNumber(getValue(row, value))));
	const isEmpty = $derived(data.length === 0 || values.every((v) => !Number.isFinite(v) || v <= 0));

	const slices = $derived(pieSlices(values));

	const legendItems = $derived(
		categories.map((cat, i) => ({
			id: `${i}-${String(cat)}`,
			label: String(cat ?? ''),
			colorVar: seriesColorVar(i)
		}))
	);

	const PADDING = 8;

	function geometry(width: number, plotHeight: number) {
		const cx = width / 2;
		const cy = plotHeight / 2;
		const rOuter = Math.max(0, Math.min(width, plotHeight) / 2 - PADDING);
		const rInner = donut ? rOuter * 0.6 : 0;
		return { cx, cy, rOuter, rInner };
	}

	let hoveredIndex: number | null = $state(null);

	function tooltipRows(index: number): TooltipRow[] {
		return [
			{
				label: String(categories[index] ?? ''),
				value: formatValueDisplay(values[index]),
				colorVar: seriesColorVar(index)
			}
		];
	}
</script>

<div class="banto-piechart">
	<Legend items={legendItems} />
	<ChartContainer {label} {height} empty={isEmpty} {messages}>
		{#snippet plot({ width, height: plotHeight })}
			{@const g = geometry(width, plotHeight)}
			{#each slices as slice, i (i)}
				<!-- Per-mark hover highlight/tooltip (rule 6); pointer-only, see LineChart's hover-surface comment for rationale. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<path
					d={arcPath(g.cx, g.cy, g.rOuter, g.rInner, slice.startAngle, slice.endAngle)}
					fill={seriesColorVar(i)}
					stroke="var(--banto-surface)"
					stroke-width="2"
					class="slice"
					class:hovered={hoveredIndex === i}
					onpointerenter={() => (hoveredIndex = i)}
					onpointerleave={() => (hoveredIndex = null)}
				/>
			{/each}
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hoveredIndex !== null}
				{@const g = geometry(width, plotHeight)}
				{@const slice = slices[hoveredIndex]}
				{@const mid = (slice.startAngle + slice.endAngle) / 2}
				{@const rad = (mid * Math.PI) / 180}
				{@const anchorR = (g.rOuter + g.rInner) / 2}
				<Tooltip
					x={g.cx + anchorR * Math.cos(rad)}
					y={g.cy + anchorR * Math.sin(rad)}
					containerWidth={width}
					containerHeight={plotHeight}
					rows={tooltipRows(hoveredIndex)}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-piechart {
		width: 100%;
	}

	.slice {
		cursor: default;
		transition: opacity 0.1s ease;
	}

	.slice.hovered {
		opacity: 0.85;
	}
</style>
