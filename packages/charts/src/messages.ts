/**
 * i18n layer 1 (docs/conventions.md §13): package-level overridable UI string
 * bundle for @banto/charts. One bundle covers every chart component plus the
 * internal `ChartContainer`'s empty-state, mirroring @banto/grid-svelte's
 * `messages.ts` convention - every message is a function (parameterized ones
 * take the relevant arguments, static ones take none) so callers always call
 * `t.key(...)` uniformly; `defaultChartMessages` holds the current Japanese
 * literals verbatim, so passing nothing reproduces today's output exactly.
 */

export interface ChartMessages {
	/** `ChartContainer`'s empty-state message, shown by every chart when it has no data. */
	emptyState?: () => string;

	/** GanttChart tooltip's "start" row label. */
	ganttStart?: () => string;
	/** GanttChart tooltip's "end" row label. */
	ganttEnd?: () => string;
	/** GanttChart tooltip's "progress" row label. */
	ganttProgress?: () => string;
	/** GanttChart's "today" axis marker label. */
	ganttToday?: () => string;

	/** BoxPlot tooltip's "max" row label. */
	boxplotMax?: () => string;
	/** BoxPlot tooltip's "median" row label. */
	boxplotMedian?: () => string;
	/** BoxPlot tooltip's "min" row label. */
	boxplotMin?: () => string;
	/** BoxPlot tooltip's "outliers" row label. */
	boxplotOutliers?: () => string;
	/** BoxPlot tooltip's outlier-count value, given the outlier count. */
	boxplotOutlierCount?: (count: number) => string;

	/** Histogram's series-label/tooltip-row label for the bar series. */
	histogramFrequency?: () => string;
	/** Histogram's series-label for the optional normal-distribution overlay. */
	histogramNormal?: () => string;

	/** ParetoChart's series-label/tooltip-row label for the bar series. */
	paretoValue?: () => string;
	/** ParetoChart's series-label/tooltip-row label for the cumulative-% line. */
	paretoCumulativePct?: () => string;

	/** StackedAreaChart tooltip's running-total row label. */
	stackedAreaTotal?: () => string;

	/** Gauge's hero-value placeholder when `value` is `null`/non-finite. */
	gaugeNoValue?: () => string;

	/** LineChart's zoom-reset button title (hover tooltip). */
	lineResetZoomTitle?: () => string;
	/** LineChart's zoom-reset button label. */
	lineReset?: () => string;
}

export const defaultChartMessages: Required<ChartMessages> = {
	emptyState: () => 'データがありません',

	ganttStart: () => '開始',
	ganttEnd: () => '終了',
	ganttProgress: () => '進捗',
	ganttToday: () => '今日',

	boxplotMax: () => '最大',
	boxplotMedian: () => '中央値',
	boxplotMin: () => '最小',
	boxplotOutliers: () => '外れ値',
	boxplotOutlierCount: (count) => `${count}件`,

	histogramFrequency: () => '度数',
	histogramNormal: () => '正規分布',

	paretoValue: () => '値',
	paretoCumulativePct: () => '累積%',

	stackedAreaTotal: () => '合計',

	gaugeNoValue: () => '—',

	lineResetZoomTitle: () => 'ズームをリセット',
	lineReset: () => 'リセット'
};
