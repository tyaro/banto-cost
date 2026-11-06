# @banto/scan-wedge

キーボードウェッジ型バーコード/QR スキャナの入力検出（M21、オプション
扱い）。コード内容を高速なキー入力列 + 終端キー（既定 Enter）として送る
入力を、人間のタイプと区別して「1スキャン = 1文字列」で通知する、
バックエンド・DB・UI 依存ゼロのヘッドレスパッケージ（docs/roadmap.md M21）。
テンプレート本体には配線しておらず、レシピとして自分のアプリに直接組み込む。

## 使用例

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { listenWedge } from '@banto/scan-wedge';

	onMount(() => {
		const stop = listenWedge(window, {
			ignoreEditable: true, // 通常のフォーム入力中はスキャン検出しない
			onScan: (code) => {
				console.log('scanned:', code);
			}
		});
		return stop; // アンマウント時にリスナーを解除
	});
</script>
```

専用入力欄には `use:wedgeInput`、DOM 非依存のヘッドレスコアが必要なら
`createWedgeDetector` を直接呼び出せる。詳細は [docs/recipes/scan-wedge.md](../../docs/recipes/scan-wedge.md) と `src/core/detector.ts`/`src/listen.ts` の JSDoc を参照。

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（オプションパッケージだが他オプションにも依存しない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/roadmap.md M21](../../docs/roadmap.md)（バーコード/QR wedge 入力検出）
