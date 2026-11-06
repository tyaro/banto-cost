<script lang="ts">
	/**
	 * Tiny inline trend chart for grid-cell / stat-tile embedding (spec §6
	 * v1 chart types). Deliberately minimal: no axes, no legend, no
	 * tooltip (spec rule 6 explicitly excludes Sparkline from the tooltip
	 * requirement - "it's a tiny inline trend"), no accessible label prop in
	 * its public API (spec's API table lists only values/width/height).
	 * Because of that last point it renders as a decorative `aria-hidden`
	 * graphic rather than `role="img"` + a required `label` (rule 8) - the
	 * surrounding UI (e.g. the stat tile's own text) always carries the
	 * accessible label for whatever this sparkline illustrates.
	 */
	import { linearScale } from './core/scale';
	import { linePath } from './core/path';
	import { toNumber } from './types';

	interface Props {
		values: number[];
		width?: number;
		height?: number;
	}

	let { values, width = 120, height = 32 }: Props = $props();

	const STROKE_WIDTH = 2;
	const PAD = STROKE_WIDTH;

	const points = $derived.by(() => {
		const nums = values.map(toNumber).filter((v) => Number.isFinite(v));
		if (nums.length === 0) return [];
		const min = Math.min(...nums);
		const max = Math.max(...nums);
		const xScale = linearScale(
			[0, Math.max(1, nums.length - 1)],
			[PAD, Math.max(PAD, width - PAD)]
		);
		const yScale = linearScale([min, max], [height - PAD, PAD]);
		return nums.map((v, i) => ({ x: xScale(i), y: yScale(v) }));
	});

	const d = $derived(linePath(points));
</script>

<svg
	class="banto-sparkline"
	{width}
	{height}
	viewBox={`0 0 ${width} ${height}`}
	preserveAspectRatio="none"
	aria-hidden="true"
>
	{#if d}
		<path
			{d}
			fill="none"
			stroke="var(--banto-chart-1)"
			stroke-width={STROKE_WIDTH}
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	{/if}
</svg>

<style>
	.banto-sparkline {
		display: block;
	}
</style>
