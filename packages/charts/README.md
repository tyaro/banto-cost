# @banto/charts

Banto のチャート。依存ライブラリなしの SVG フルスクラッチ実装
（spec §6, §6.1）。折れ線/エリア・棒・円/ドーナツ・散布図・
スパークラインに加え、複合（棒+折れ線）・レーダー・ヒートマップ・
ゲージ、SPC 系（ヒストグラム・パレート図・箱ひげ図）、積立エリア・
ガントの全14種。

## 使用例

```svelte
<script lang="ts">
	import { LineChart } from '@banto/charts';

	interface Point {
		month: string;
		value: number;
	}

	const data: Point[] = [
		{ month: '1月', value: 10 },
		{ month: '2月', value: 14 }
	];
</script>

<LineChart
	{data}
	x={(d: Point) => d.month}
	series={[{ id: 'value', label: '売上', y: (d: Point) => d.value }]}
	label="月別売上"
/>
```

### 積立グラフ（積立エリア / 積立棒）

```svelte
<script lang="ts">
	import { StackedAreaChart, BarChart } from '@banto/charts';

	const data = [
		{ q: 'Q1', a: 10, b: 6 },
		{ q: 'Q2', a: 14, b: 9 }
	];
</script>

<!-- 積立折れ線（積立エリア）: series の値アクセサは `y` -->
<StackedAreaChart
	{data}
	x={(d) => d.q}
	series={[
		{ id: 'a', label: '製品A', y: (d) => d.a },
		{ id: 'b', label: '製品B', y: (d) => d.b }
	]}
	label="四半期売上（積立）"
/>

<!-- 積立棒は BarChart の stacked オプション: series の値アクセサは `value` -->
<BarChart
	{data}
	category={(d) => d.q}
	series={[
		{ id: 'a', label: '製品A', value: (d) => d.a },
		{ id: 'b', label: '製品B', value: (d) => d.b }
	]}
	stacked
	label="四半期売上（積立棒）"
/>
```

### ガントチャート

```svelte
<script lang="ts">
	import { GanttChart, type GanttTask } from '@banto/charts';

	const tasks: GanttTask[] = [
		{ id: 'design', label: '設計', start: '2026-01-05', end: '2026-01-15', progress: 1 },
		{ id: 'build', label: '実装', start: '2026-01-12', end: '2026-02-02', progress: 0.6 },
		{ id: 'test', label: '検証', start: '2026-01-28', end: '2026-02-10' }
	];
</script>

<GanttChart {tasks} label="プロジェクト工程" today="2026-01-25" />
```

`start`/`end` は `number`(epoch ms) / `Date` / 文字列のいずれでも可。行の高さは
`rowHeight`、全体の高さはタスク数から自動算出する。時間軸・ツールチップの表示は
`formatDate` で制御する（依存を足さないため日付ライブラリは同梱しない）。

### 欠測の扱い・バンドの範囲・ゲージの値なし

```svelte
<!-- gaps="break": 欠測（null/NaN）で線を分け、つながない（既定は 'join'） -->
<LineChart {data} x={...} series={...} label="温度" gaps="break" />

<!-- includeY: 左の縦軸の範囲に必ず含める値。ビット（0/1）のタグだけの推移で、目盛を 0 と 1 にそろえたいとき -->
<LineChart {data} x={...} series={...} label="運転状態" includeY={[0, 1]} />

<!-- formatTooltip: ツールチップの値だけの書式（系列ごと）。目盛は formatY のまま。bit のタグだけ True / False にしたいとき -->
<LineChart {data} x={...} series={...} label="運転状態"
	formatTooltip={(v, s) => (s.id === 'run' ? (v >= 0.5 ? 'True' : 'False') : v.toLocaleString())} />

<!-- bands: from/to が null・±Infinity なら上端/下端まで。プロット領域でクリップされる -->
<LineChart {data} x={...} series={...} label="温度"
	bands={[{ from: 80, to: null, label: '警報', colorVar: 'var(--banto-danger)' }]} />

<!-- Gauge: value に null で値の弧を描かず「—」を表示。warningLow/dangerLow は value <= で着色 -->
<Gauge value={null} min={0} max={100} label="水位"
	thresholds={{ warning: 80, danger: 90, warningLow: 20, dangerLow: 10 }} />
```

- `LineChart` の `gaps?: 'join' | 'break'`（既定 `'join'` = 従来どおり欠測を飛ばしてつなぐ）。
  `'break'` は欠測（null / undefined / NaN。0 にはしない）で `M` から別の部分パスにする。`'join'` では `null` は従来どおり 0 として描く（エリア塗りも部分ごとに閉じる）。
- `LineChart` の `includeY?: readonly number[]`（既定なし = 従来どおりデータの範囲のみ）。
  左の縦軸の範囲を「左の軸の系列のデータの範囲」と指定した値の和集合にする（データが無ければ指定値だけ）。非有限の値は無視する。
  データ点・ツールチップ・凡例・系列は増えず、データが無いチャートは空表示のまま（`includeY` はデータとして数えない）。右の軸には効かない。
- `LineChart` の `formatTooltip?: (value: number, series: { id: string; label: string; axis: 'left' | 'right' }, index: number) => string`（既定なし = 従来どおり `formatY`、右の軸の系列は `formatYRight`）。
  ツールチップの値の書式だけを系列ごとに変える。縦軸の目盛と余白の自動計算には使わない。有限の値にだけ呼ばれ、非有限は従来どおり `-`。
- `LineChart` の `bands`（`OpenThresholdBand`）の `from`/`to` は `number | null`。非有限（±Infinity を含む）は位置で開放端になる（`from` は下端、`to` は上端）。
  バンドはプロット領域にクリップされ、領域外だけのバンドは描かない。
- `Gauge` の `value` は `number | null`。値なしの文字は `messages.gaugeNoValue`（既定 `'—'`）。
  `GaugeThresholds` に `warningLow` / `dangerLow`（`value <=` で warning / danger 色）を追加。
  上側の `warning` / `danger` の挙動は変わらない。

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（オプションパッケージだが他オプションにも依存しない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/ui-framework-spec.md §6](../../docs/ui-framework-spec.md)（チャート/グラフ仕様）
