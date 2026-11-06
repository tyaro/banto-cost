# @banto/tree-svelte

Banto の階層データツリービュー。依存ゼロのヘッドレスコア + 薄い Svelte 5 (Runes)
UI で、展開/折りたたみ・単一/複数選択・三状態チェックボックス・遅延読み込み・
ドラッグ並べ替え/親子変更・インライン名前変更に対応する。`columns` を渡すと
階層データグリッド（tree-grid）、`TreeSelect` はポップオーバー型の選択入力になる
（[docs/roadmap.md](../../docs/roadmap.md) M-review 2026-08 の利用者要望）。

## 使用例

```svelte
<script lang="ts">
	import { BantoTree, type TreeNode } from '@banto/tree-svelte';

	const nodes: TreeNode[] = [
		{ id: 'src', label: 'src', children: [{ id: 'app', label: 'app.ts' }] },
		{ id: 'readme', label: 'README.md' }
	];
</script>

<BantoTree {nodes} expanded={['src']} onSelectionChange={(ids) => console.log('selected', ids)} />
```

複数選択 + 三状態チェックボックス・遅延読み込み・tree-grid・`TreeSelect`・
ドラッグ/リネームの各形態は
[docs/recipes/tree-svelte.md](../../docs/recipes/tree-svelte.md) を参照。

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（`@banto/grid-svelte`/`forms` の型は構造ミラーで非 import、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。派生アプリで
`pnpm dev` する場合は消費側 Vite の `optimizeDeps.exclude` が必要
（`.svelte.ts` をソース配布するため。[ADR-0007](../../docs/adr/0007-derived-app-dev-optimizer-exclude.md)。
テンプレートは設定済み）。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- アプリへの組み込みレシピ: [docs/recipes/tree-svelte.md](../../docs/recipes/tree-svelte.md)
- ツリー演算のコア（依存ゼロ純関数）: `src/core/`、テスト: `tests/`
