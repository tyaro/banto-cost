/**
 * Pure aggregation helpers for the M4 dashboard (spec §6 integration): all
 * derived from the `items` list resource, kept side-effect free so they stay
 * type-checked and trivially testable even though this milestone only wires
 * them into `+page.svelte` (no dedicated Vitest suite for this app-level
 * glue - the chart math itself is covered in @banto/charts).
 *
 * D1-d note (display-preset-plan.md, Issue #190 prep): every export in this
 * file takes `Item[]` - there is no non-items content to carve out with a
 * `cutRegion`. A future `display`/`items` remover should `removeFile` this
 * whole module (same treatment as `sampleData.ts`) rather than mark internal
 * regions here.
 */
import type { GanttTask } from '@banto/charts';
import type { Item } from './sampleData';

export interface StatTiles {
	count: number;
	stockTotal: number;
	avgPrice: number;
	lowStockCount: number;
}

const LOW_STOCK_THRESHOLD = 50;

/** 商品数 / 在庫合計 / 平均価格 (rounded mean) / 在庫僅少 (stock < 50) counts. */
export function computeStatTiles(items: Item[]): StatTiles {
	const count = items.length;
	const stockTotal = items.reduce((sum, item) => sum + item.stock, 0);
	const avgPrice =
		count === 0 ? 0 : Math.round(items.reduce((sum, item) => sum + item.price, 0) / count);
	const lowStockCount = items.filter((item) => item.stock < LOW_STOCK_THRESHOLD).length;
	return { count, stockTotal, avgPrice, lowStockCount };
}

export interface CategoryStock {
	category: string;
	stock: number;
}

/** Category = the item name's first whitespace-separated token (e.g. "緑茶 500ml" -> "緑茶"). */
export function categoryOf(name: string): string {
	return name.split(/\s+/)[0] || name;
}

/**
 * Sum of stock per category, ALL categories, sorted desc. No 「その他」 fold:
 * the demo dataset's category set is small and bounded (12), and folding the
 * tail into a single bar summed several categories into one bar ~5x longer
 * than any real one - a misleading chart. Folding is only warranted when the
 * category count is unbounded. Note the 8-color-slot design rule constrains
 * SERIES count, not bar count; this feeds a single-series (single-hue) bar
 * chart, so any number of bars is fine.
 */
export function byCategory(items: Item[]): CategoryStock[] {
	const totals = new Map<string, number>();
	for (const item of items) {
		const cat = categoryOf(item.name);
		totals.set(cat, (totals.get(cat) ?? 0) + item.stock);
	}
	return [...totals.entries()]
		.map(([category, stock]) => ({ category, stock }))
		.sort((a, b) => b.stock - a.stock);
}

export interface CategoryPriceBandStock {
	category: string;
	/** price <= 99 の在庫合計。 */
	low: number;
	/** 100 <= price <= 199 の在庫合計。 */
	mid: number;
	/** price >= 200 の在庫合計。 */
	high: number;
}

const STACKED_BAR_TOP_N = 5;

/**
 * §6 積立棒(BarChart stacked)デモ用: 在庫合計が上位 `topN` のカテゴリについて、
 * その在庫を価格帯(低/中/高)で積み上げる。積立エリア(`categoryTrendByMonth`,
 * 時系列)とは別軸の「構成比」ビューにするため、x をカテゴリ・積層を価格帯にした。
 * 系列は3(低/中/高)で 8 色スロット規則(byCategory の doc 参照: 制約は系列数)に
 * 収まる。壁時計非依存・純関数なのでビジュアル回帰でも決定的。
 */
export function stockByCategoryPriceBand(
	items: Item[],
	topN: number = STACKED_BAR_TOP_N
): CategoryPriceBandStock[] {
	const top = byCategory(items)
		.slice(0, topN)
		.map((c) => c.category);
	const topSet = new Set(top);
	const acc = new Map<string, { low: number; mid: number; high: number }>(
		top.map((c) => [c, { low: 0, mid: 0, high: 0 }])
	);
	for (const item of items) {
		const cat = categoryOf(item.name);
		if (!topSet.has(cat)) continue;
		const band = item.price <= 99 ? 'low' : item.price <= 199 ? 'mid' : 'high';
		acc.get(cat)![band] += item.stock;
	}
	return top.map((category) => ({ category, ...acc.get(category)! }));
}

export interface PriceBucket {
	bucket: string;
	count: number;
}

const PRICE_BUCKET_LABELS = ['〜¥99', '¥100〜149', '¥150〜199', '¥200〜'] as const;

/** 〜¥99 / ¥100〜149 / ¥150〜199 / ¥200〜 item counts. */
export function priceBuckets(items: Item[]): PriceBucket[] {
	const counts = [0, 0, 0, 0];
	for (const item of items) {
		if (item.price <= 99) counts[0]++;
		else if (item.price <= 149) counts[1]++;
		else if (item.price <= 199) counts[2]++;
		else counts[3]++;
	}
	return PRICE_BUCKET_LABELS.map((bucket, i) => ({ bucket, count: counts[i] }));
}

export interface MonthCount {
	/** `YYYY-MM`. */
	month: string;
	count: number;
}

/**
 * Count of items per updatedAt MONTH (`YYYY-MM` = first 7 chars of the ISO
 * date), ascending; lexicographic sort of `YYYY-MM` is chronological. Daily
 * granularity (~900 points over the demo dataset's 2.5-year span) rendered
 * as an unreadable noise band in a ~300px-wide card, so the dashboard
 * aggregates monthly (~30 points) instead.
 */
export function updatesByMonth(items: Item[]): MonthCount[] {
	const counts = new Map<string, number>();
	for (const item of items) {
		const month = item.updatedAt.slice(0, 7);
		counts.set(month, (counts.get(month) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([month, count]) => ({ month, count }))
		.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

const SCATTER_SAMPLE_SIZE = 500;

/** First N rows, deterministic (no shuffling) - a stable sample for the scatter chart. */
export function scatterSample(items: Item[], limit: number = SCATTER_SAMPLE_SIZE): Item[] {
	return items.slice(0, limit);
}

export interface MonthWithMovingAvg {
	/** `YYYY-MM`. */
	month: string;
	count: number;
	/** Trailing average of `count` over this month and up to the 2 preceding
	 * months, rounded to 1 decimal. The first 2 months of the series have
	 * fewer than 3 months of history, so their window is shorter (2, then 1) -
	 * a documented simplification rather than leaving them undefined. */
	avg3: number;
}

const MOVING_AVG_WINDOW = 3;

/** §6.1 ComboChart demo data: monthly update counts plus their 3-month trailing moving average (spec §6.1 dashboard integration). */
export function monthlyWithMovingAvg(items: Item[]): MonthWithMovingAvg[] {
	const months = updatesByMonth(items);
	return months.map((m, i) => {
		const windowStart = Math.max(0, i - (MOVING_AVG_WINDOW - 1));
		const window = months.slice(windowStart, i + 1);
		const avg = window.reduce((sum, w) => sum + w.count, 0) / window.length;
		return { month: m.month, count: m.count, avg3: Math.round(avg * 10) / 10 };
	});
}

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

export interface WeekdayMonthCount {
	/** `日`..`土`, fixed order (spec §6.1 Heatmap demo: y-axis order is not sorted alphabetically, it's the calendar week order). */
	weekday: (typeof WEEKDAY_LABELS)[number];
	/** `YYYY-MM`. */
	month: string;
	count: number;
}

const HEATMAP_MONTHS = 12;

/**
 * §6.1 Heatmap demo data: item-update counts by weekday x month, for the
 * LAST 12 months only (all ~30 months would make an unreadably narrow-column
 * heatmap). Every (weekday, month) combination in that window gets an
 * explicit row - including a `count` of 0 - so the heatmap renders a full
 * rectangle instead of leaving genuinely-zero cells indistinguishable from
 * "no data" gaps. Row order is deliberately weekday-major (all of 日's months,
 * then all of 月's, ...) and month-ascending within each weekday, so
 * `heatmapGrid`'s first-appearance category ordering comes out as
 * `weekday: 日..土` / `month: ascending` with no extra sorting needed downstream.
 */
export function weekdayMonthHeat(items: Item[]): WeekdayMonthCount[] {
	const lastMonths = updatesByMonth(items)
		.map((m) => m.month)
		.slice(-HEATMAP_MONTHS);
	const monthSet = new Set(lastMonths);

	const key = (weekday: string, month: string) => `${weekday} ${month}`;
	const counts = new Map<string, number>();
	for (const weekday of WEEKDAY_LABELS) {
		for (const month of lastMonths) counts.set(key(weekday, month), 0);
	}

	for (const item of items) {
		const month = item.updatedAt.slice(0, 7);
		if (!monthSet.has(month)) continue;
		// `updatedAt` is a UTC-generated `YYYY-MM-DD` (see sampleData.ts); read
		// it back as UTC so the weekday doesn't shift with the local timezone.
		const weekday = WEEKDAY_LABELS[new Date(`${item.updatedAt}T00:00:00Z`).getUTCDay()];
		const k = key(weekday, month);
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}

	const rows: WeekdayMonthCount[] = [];
	for (const weekday of WEEKDAY_LABELS) {
		for (const month of lastMonths) {
			rows.push({ weekday, month, count: counts.get(key(weekday, month)) ?? 0 });
		}
	}
	return rows;
}

export interface CategoryCount {
	category: string;
	count: number;
}

/** §6.1 RadarChart demo data: top-N categories by ITEM COUNT (not stock, unlike `byCategory`), desc. */
export function categoryCountsTop(items: Item[], n: number = 5): CategoryCount[] {
	const counts = new Map<string, number>();
	for (const item of items) {
		const cat = categoryOf(item.name);
		counts.set(cat, (counts.get(cat) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([category, count]) => ({ category, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, n);
}

// --- M13 SPC panel demo data (roadmap.md M13: histogram / Pareto / box plot) ---

/** All item prices, unfiltered - `Histogram` bins these itself (`core/bins.ts`). */
export function priceValues(items: Item[]): number[] {
	return items.map((item) => item.price);
}

export interface CategoryCountItem {
	label: string;
	value: number;
}

/** ALL categories with their item counts, unsorted - `ParetoChart` sorts descending itself (`core/pareto.ts`). Unlike `categoryCountsTop` this is not truncated: a Pareto chart's whole point is showing the full distribution against the 80% line. */
export function categoryCounts(items: Item[]): CategoryCountItem[] {
	const counts = new Map<string, number>();
	for (const item of items) {
		const cat = categoryOf(item.name);
		counts.set(cat, (counts.get(cat) ?? 0) + 1);
	}
	return [...counts.entries()].map(([label, value]) => ({ label, value }));
}

export interface PriceGroup {
	label: string;
	values: number[];
}

const BOX_PLOT_TOP_CATEGORIES = 6;

/** Top-N categories by item count (reuses `categoryCountsTop`), each with its raw price array - `BoxPlot` computes five-number summaries itself (`core/boxplot.ts`). Truncated to keep the box plot legible (unlike `categoryCounts` above). */
export function priceByCategoryGroups(
	items: Item[],
	topN: number = BOX_PLOT_TOP_CATEGORIES
): PriceGroup[] {
	const top = categoryCountsTop(items, topN).map((c) => c.category);
	const byCategory = new Map<string, number[]>(top.map((cat) => [cat, []]));
	for (const item of items) {
		const cat = categoryOf(item.name);
		byCategory.get(cat)?.push(item.price);
	}
	return top.map((label) => ({ label, values: byCategory.get(label) ?? [] }));
}

// --- M13 trend panel demo data (roadmap.md M13: zoom/pan, bands, markers, second axis, streaming) ---

export interface TrendPoint {
	/** Sequential sample index - the trend panel's x-axis is an ordered category (`core/ticks-time.ts`), not real elapsed time. */
	t: number;
	/** °C, plotted on the left axis. */
	temperature: number;
	/** MPa, plotted on the right axis (different unit - the M13 第2Y軸 demo). */
	pressure: number;
}

const TREND_BASE_TEMPERATURE = 68;
const TREND_BASE_PRESSURE = 1.2;

/**
 * One streaming sample: a small random walk from `prev` (or the baseline
 * when `prev` is undefined, i.e. the first seeded point) so the demo trend
 * has plausible SPC-like noise instead of a flat line. `random` is injectable
 * (defaults to `Math.random`) so the walk can be made deterministic in tests.
 */
export function nextTrendPoint(
	prev: TrendPoint | undefined,
	random: () => number = Math.random
): TrendPoint {
	return {
		t: (prev?.t ?? -1) + 1,
		temperature: (prev?.temperature ?? TREND_BASE_TEMPERATURE) + (random() - 0.5) * 1.5,
		pressure: (prev?.pressure ?? TREND_BASE_PRESSURE) + (random() - 0.5) * 0.05
	};
}

/** Seed `count` consecutive trend points (see `nextTrendPoint`), for the panel's initial (pre-streaming) render. */
export function seedTrendPoints(count: number, random: () => number = Math.random): TrendPoint[] {
	const points: TrendPoint[] = [];
	let prev: TrendPoint | undefined;
	for (let i = 0; i < count; i++) {
		prev = nextTrendPoint(prev, random);
		points.push(prev);
	}
	return points;
}

// --- M24 chart demo data (roadmap.md M24: 積立エリア / ガント) ---

export interface MonthCategoryCount {
	/** `YYYY-MM`. */
	month: string;
	/** カテゴリ名 -> その月の更新件数。上位カテゴリのみを持ち、欠測は 0 で埋める。 */
	values: Record<string, number>;
}

export interface StackedCategoryTrend {
	/** 積立の系列順（＝上位カテゴリを件数降順）。 */
	categories: string[];
	rows: MonthCategoryCount[];
}

const STACKED_TREND_TOP_N = 4;
const STACKED_TREND_MONTHS = 12;

/**
 * §6.1 StackedAreaChart demo data (M24): 上位 `topN` カテゴリの更新件数を、
 * 直近 `months` ヶ月にわたって月次で積み上げる。上位カテゴリの選定は
 * `categoryCountsTop`（件数降順）を再利用し、月の窓は `weekdayMonthHeat` と
 * 同じ「直近Nヶ月のみ」（`updatesByMonth` の末尾を切り出す）。積立エリアは
 * 面の上端がその月までの累積値を表すため、欠測（あるカテゴリがその月に
 * 1件も更新されない）を undefined のまま残すと面のトップ境界が不連続に
 * 落ち込みグラフが破綻する — 全 (month × 上位カテゴリ) の組み合わせを先に
 * 0 で初期化してから加算する。系列数の既定を4に絞るのは `byCategory` の
 * doc コメントにある「8色スロットは SERIES 数の制約であって bar 数の制約
 * ではない」という区別に従ったもの: 積立エリアは各カテゴリが専用の色を持つ
 * "系列" なので、8色スロットに余裕を持って収まる数（4）を既定にした。
 */
export function categoryTrendByMonth(
	items: Item[],
	topN: number = STACKED_TREND_TOP_N,
	months: number = STACKED_TREND_MONTHS
): StackedCategoryTrend {
	const categories = categoryCountsTop(items, topN).map((c) => c.category);
	const lastMonths = updatesByMonth(items)
		.map((m) => m.month)
		.slice(-months);

	const rows: MonthCategoryCount[] = lastMonths.map((month) => ({
		month,
		values: Object.fromEntries(categories.map((c) => [c, 0]))
	}));
	const rowByMonth = new Map(rows.map((row) => [row.month, row]));
	const categorySet = new Set(categories);
	const monthSet = new Set(lastMonths);

	for (const item of items) {
		const cat = categoryOf(item.name);
		if (!categorySet.has(cat)) continue;
		const month = item.updatedAt.slice(0, 7);
		if (!monthSet.has(month)) continue;
		rowByMonth.get(month)!.values[cat] += 1;
	}

	return { categories, rows };
}

export interface InventorySchedule {
	tasks: GanttTask[];
	/** GanttChart の `today` にそのまま渡す固定インスタント（`YYYY-MM-DD`）。tasks が空のときは undefined。 */
	today?: string;
}

const SCHEDULE_MONTHS = 6;
const SCHEDULE_TASK_LABELS = [
	'棚卸準備',
	'実地棚卸',
	'差異調査',
	'価格改定',
	'レポート作成'
] as const;

/**
 * §6.1 GanttChart demo data (M24): 棚卸し工程の見立てタスクを、データセット
 * から導出した固定タイムライン上に配置する。壁時計（`Date.now()` / 引数なし
 * `new Date()`）は絶対に使わない — ビジュアル回帰スナップショットは実行日に
 * 依存すると壊れてしまう（sampleData.ts の `updatedAt` は固定シード PRNG +
 * 固定の `UPDATED_AT_END` 基準日から生成済みなので、ここでも同様に
 * `updatesByMonth` の集計結果という「データセット由来の値」だけからタイム
 * ラインを組み、`Date` は文字列組み立てにも一切使わない）。直近
 * `SCHEDULE_MONTHS` ヶ月の月初（`YYYY-MM-DD`、日付ライブラリを使わない
 * 単純な文字列連結）を基準点に、5つの工程を月をまたいで少しずつ重なる形で
 * 配置する。`today` マーカーはその窓のちょうど中ほどの月初にする（tasks と
 * 同じ月リストから導出するので、必ず tasks の期間内に収まる）。データセットの
 * 月数が `SCHEDULE_MONTHS` 未満でも配列外参照しないよう、月インデックスは
 * 末尾でクランプする。items が空（月リストが空）のときは tasks・today とも
 * 空/undefined。
 */
export function inventorySchedule(items: Item[]): InventorySchedule {
	const months = updatesByMonth(items)
		.map((m) => m.month)
		.slice(-SCHEDULE_MONTHS);
	if (months.length === 0) return { tasks: [] };

	const at = (i: number) => months[Math.min(i, months.length - 1)];
	const day = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`;

	const tasks: GanttTask[] = [
		{
			id: 'prep',
			label: SCHEDULE_TASK_LABELS[0],
			start: day(at(0), 1),
			end: day(at(0), 15),
			progress: 1
		},
		{
			id: 'count',
			label: SCHEDULE_TASK_LABELS[1],
			start: day(at(0), 10),
			end: day(at(1), 5),
			progress: 1
		},
		{
			id: 'review',
			label: SCHEDULE_TASK_LABELS[2],
			start: day(at(1), 1),
			end: day(at(2), 15),
			progress: 0.6
		},
		{
			id: 'reprice',
			label: SCHEDULE_TASK_LABELS[3],
			start: day(at(2), 10),
			end: day(at(3), 20),
			progress: 0.3
		},
		{
			id: 'report',
			label: SCHEDULE_TASK_LABELS[4],
			start: day(at(4), 1),
			end: day(at(5), 15)
		}
	];

	const today = day(at(Math.floor(months.length / 2)), 1);
	return { tasks, today };
}
