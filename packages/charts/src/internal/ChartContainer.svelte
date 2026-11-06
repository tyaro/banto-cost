<script lang="ts">
	/**
	 * Shared chart shell (spec §6.2): measures the container width via
	 * `bind:clientWidth` (a plain reactive binding is enough per spec - no
	 * separate ResizeObserver wiring needed), sets up an SVG whose `viewBox`
	 * exactly matches the rendered pixel size (so the coordinate space used by
	 * `plot` is 1:1 with real pixels, with no scale distortion), and hosts an
	 * absolutely-positioned HTML `overlay` snippet for tooltips (spec rule 6).
	 *
	 * Accessibility (spec rule 8): the root gets `role="img"` and the
	 * required `label` prop as `aria-label`. A table-view fallback for
	 * screen-reader users is out of scope for v1 (later milestone).
	 */
	import type { Snippet } from 'svelte';
	import { defaultChartMessages, type ChartMessages } from '../messages';

	export interface PlotMetrics {
		width: number;
		height: number;
	}

	interface Props {
		label: string;
		height?: number;
		empty?: boolean;
		plot: Snippet<[PlotMetrics]>;
		overlay?: Snippet<[PlotMetrics]>;
		/**
		 * Optional read-out of the measured container width. Charts that keep
		 * their scale/path math in script-level `$derived` (e.g. `LineChart`'s
		 * zoom/decimation pipeline) bind this so the width lives in component
		 * state rather than only inside the `plot` snippet scope. Purely an
		 * output - charts that don't need it simply omit the binding.
		 */
		width?: number;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's empty-state text. Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		label,
		height = 240,
		empty = false,
		plot,
		overlay,
		width = $bindable(0),
		messages = {}
	}: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultChartMessages, ...messages };
</script>

<div
	class="chart-container"
	role="img"
	aria-label={label}
	style:height={`${height}px`}
	bind:clientWidth={width}
>
	{#if empty}
		<div class="empty-state">{t.emptyState()}</div>
	{:else if width > 0}
		<svg class="chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
			{@render plot({ width, height })}
		</svg>
		{#if overlay}
			{@render overlay({ width, height })}
		{/if}
	{/if}
</div>

<style>
	.chart-container {
		position: relative;
		width: 100%;
	}

	.chart-svg {
		display: block;
		width: 100%;
		height: 100%;
	}

	.empty-state {
		height: 100%;
		display: grid;
		place-items: center;
		color: var(--banto-text-muted);
		font-size: 0.85rem;
	}
</style>
