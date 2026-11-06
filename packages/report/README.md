# @banto/report

Banto の帳票/印刷パッケージ（M19、オプション扱い）。Markdown サブセットの
自前テンプレートパーサ/データバインド/レンダラ（unit A、`renderReport`）と、
プレビュー/印刷用の `ReportView.svelte`（unit B）、印刷用 CSS
（`@banto/report/print.css`）で構成する（docs/design/report-plan.md）。

## 使用例

```svelte
<script lang="ts">
	import { ReportView } from '@banto/report';

	const template = '# {{title}}\n\n合計: {{yen total}}';
	const data = { title: '日報', total: 12000 };
</script>

<ReportView {template} {data} title="日報" />
```

ヘッドレスに使う場合は `renderReport` を直接呼び出す:

```ts
import { renderReport } from '@banto/report';

const { html, warnings } = renderReport('# {{title}}', { title: '日報' });
```

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（オプションパッケージだが他オプションにも依存しない、docs/conventions.md §4・§5）。
Markdown ライブラリも使わず自前パーサ + 全エスケープで実装している
（docs/conventions.md §3）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/design/report-plan.md](../../docs/design/report-plan.md)（M19: 帳票/印刷 計画書、§3.3 renderReport）
