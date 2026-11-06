<script lang="ts">
	/**
	 * Gantt chart (spec §6, roadmap.md M24): one horizontal time-bar per task
	 * against a shared time axis, with optional per-task progress fill and a
	 * "today" marker. Bar geometry comes from the pure, unit-tested
	 * `core/gantt.ts` (fractions of the time domain); this component only maps
	 * those fractions to pixels and lays out one row per task.
	 *
	 * Scope (v1, "やりすぎない"): no dependency arrows between tasks, no drag
	 * editing. Time is epoch-ms internally (`toMs` accepts number/Date/string);
	 * axis/tooltip formatting is delegated to `formatDate` so the caller owns
	 * locale/granularity. Height is derived from `rowHeight` × task count.
	 */
	import { linearScale, niceTicks } from './core/scale';
	import { ganttDomain, ganttLayout, toMs, type GanttTask } from './core/gantt';
	import { seriesColorVar } from './core/color';
	import { leftMarginFor } from './core/labels';
	import type { ChartMargin, TooltipRow } from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import { defaultChartMessages, type ChartMessages } from './messages';

	interface Props {
		tasks: GanttTask[];
		label: string;
		/** Height per task row in px (total chart height is derived from this). */
		rowHeight?: number;
		/** Formats an epoch-ms instant for the time axis and tooltips. */
		formatDate?: (ms: number) => string;
		/** Optional "today"/now marker instant (number/Date/string). */
		today?: number | Date | string;
		/** Per-side overrides merged over the defaults (left auto-fits labels). */
		margins?: Partial<ChartMargin>;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings (and `ChartContainer`'s empty-state text). Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let { tasks, label, rowHeight = 28, formatDate, today, margins, messages = {} }: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below. Named `msg` (not
	// `t`) because `t` is already this file's per-task local variable name in
	// `tooltipRows` below.
	// svelte-ignore state_referenced_locally
	const msg = { ...defaultChartMessages, ...messages };

	const DEFAULT_MARGIN: ChartMargin = { top: 24, right: 16, bottom: 24, left: 96 };
	const MIN_TICK_SPACING = 80;
	const BAR_RATIO = 0.6;

	const formatDateValue = $derived(
		formatDate ?? ((ms: number) => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : '-'))
	);

	const domain = $derived(ganttDomain(tasks));
	const isEmpty = $derived(tasks.length === 0 || domain === null);
	const bars = $derived(domain ? ganttLayout(tasks, domain) : []);

	// Left margin auto-fits the widest task label so long names aren't clipped.
	const MARGIN = $derived.by(() => {
		const base = { ...DEFAULT_MARGIN, ...margins };
		if (margins?.left !== undefined) return base;
		return { ...base, left: Math.max(base.left, leftMarginFor(tasks.map((t) => t.label))) };
	});

	// Derived total height: header/footer margins + one row per task. Empty
	// charts still get a small box so the "no data" state is visible.
	const height = $derived(
		isEmpty ? 120 : MARGIN.top + MARGIN.bottom + Math.max(1, tasks.length) * rowHeight
	);

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

	const timeTicks = $derived.by(() => {
		if (!domain) return [] as number[];
		const maxTicks = Math.max(2, Math.min(8, Math.floor(metrics.innerWidth / MIN_TICK_SPACING)));
		return niceTicks(domain[0], domain[1], maxTicks);
	});

	const timeScale = $derived(
		domain
			? linearScale([domain[0], domain[1]], [metrics.innerLeft, metrics.innerRight])
			: linearScale([0, 1], [metrics.innerLeft, metrics.innerRight])
	);

	function rowY(index: number): number {
		return metrics.innerTop + index * rowHeight;
	}

	const barHeight = $derived(rowHeight * BAR_RATIO);
	const barOffset = $derived((rowHeight - rowHeight * BAR_RATIO) / 2);

	const todayMs = $derived(today === undefined ? null : toMs(today));
	const todayVisible = $derived(
		todayMs !== null && domain !== null && todayMs >= domain[0] && todayMs <= domain[1]
	);

	let hoveredIndex: number | null = $state(null);

	function tooltipRows(index: number): TooltipRow[] {
		const t = tasks[index];
		const rows: TooltipRow[] = [
			{ label: msg.ganttStart(), value: formatDateValue(toMs(t.start)) },
			{ label: msg.ganttEnd(), value: formatDateValue(toMs(t.end)) }
		];
		if (Number.isFinite(t.progress ?? NaN))
			rows.push({
				label: msg.ganttProgress(),
				value: `${Math.round((t.progress as number) * 100)}%`
			});
		return rows;
	}
</script>

<div class="banto-gantt">
	<ChartContainer {label} {height} empty={isEmpty} bind:width={plotWidth} {messages}>
		{#snippet plot()}
			{@const m = metrics}
			<!-- Time gridlines + top axis ticks. -->
			{#each timeTicks as tick (tick)}
				{@const tx = timeScale(tick)}
				<line x1={tx} x2={tx} y1={m.innerTop} y2={m.innerBottom} class="gridline" />
				<text x={tx} y={m.innerTop - 8} class="tick-label" text-anchor="middle">
					{formatDateValue(tick)}
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

			<!-- Task rows: label + bar (+ progress overlay). -->
			{#each bars as bar (tasks[bar.index].id)}
				{@const y = rowY(bar.index) + barOffset}
				{@const bx = m.innerLeft + bar.startFrac * m.innerWidth}
				{@const bw = Math.max(1, bar.widthFrac * m.innerWidth)}
				{@const color = seriesColorVar(bar.colorIndex)}
				<text
					x={m.innerLeft - 10}
					y={rowY(bar.index) + rowHeight / 2}
					class="task-label"
					text-anchor="end"
					dominant-baseline="middle"
				>
					{tasks[bar.index].label}
				</text>
				<rect
					x={bx}
					{y}
					width={bw}
					height={barHeight}
					rx="3"
					fill={color}
					fill-opacity="0.4"
					stroke={color}
					stroke-width="1"
				/>
				{#if bar.progressFrac > 0}
					<rect
						x={bx}
						{y}
						width={Math.max(0, bw * bar.progressFrac)}
						height={barHeight}
						rx="3"
						fill={color}
						fill-opacity="0.9"
					/>
				{/if}
				<!-- Per-row hover capture (transparent, full plot width). -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<rect
					x={m.innerLeft}
					y={rowY(bar.index)}
					width={m.innerWidth}
					height={rowHeight}
					fill="transparent"
					onpointerenter={() => (hoveredIndex = bar.index)}
					onpointerleave={() => (hoveredIndex = null)}
				/>
			{/each}

			<!-- "Today" marker (drawn last, above bars). -->
			{#if todayVisible && todayMs !== null}
				{@const tx = timeScale(todayMs)}
				<line x1={tx} x2={tx} y1={m.innerTop} y2={m.innerBottom} class="today-line" />
				<text x={tx} y={m.innerBottom + 16} class="today-label" text-anchor="middle"
					>{msg.ganttToday()}</text
				>
			{/if}
		{/snippet}
		{#snippet overlay()}
			{#if hoveredIndex !== null}
				<Tooltip
					x={metrics.innerLeft + bars[hoveredIndex].startFrac * metrics.innerWidth}
					y={rowY(hoveredIndex)}
					containerWidth={plotWidth}
					containerHeight={height}
					title={tasks[hoveredIndex].label}
					rows={tooltipRows(hoveredIndex)}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-gantt {
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

	.task-label {
		fill: var(--banto-text);
		font-size: 12px;
	}

	.tick-label {
		fill: var(--banto-text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.today-line {
		stroke: var(--banto-chart-axis);
		stroke-width: 1.5;
		stroke-dasharray: 4 3;
		pointer-events: none;
	}

	.today-label {
		fill: var(--banto-text-muted);
		font-size: 10px;
	}
</style>
