# レシピ: ツリービュー（`@banto/tree-svelte`）

作成日: 2026-08-14（README から切り出し。トラックB＝アプリ作者向け）

階層データのツリービュー。**依存ゼロのヘッドレスコア + 薄い Svelte 5 (Runes) UI**
で、展開/折りたたみ・単一/複数選択・三状態チェックボックス・遅延読み込み・
ドラッグ並べ替え/親子変更・インライン名前変更に対応する。`columns` を渡すと
階層データグリッド（tree-grid）、`TreeSelect` はポップオーバー型の選択入力になる。
テンプレート本体では**サイドバーの「ツリービュー」= `/tree` デモページ**として
配線済み（削除可能。外し方は [remove-optional-assets.md](remove-optional-assets.md) の「ツリーデモ」、
または `pnpm scaffold --preset minimal|standard`）。ライブデモでも上記の全形態を
触れる。自分のアプリへ組み込むには以下のレシピを使う。パッケージ単体の API 概要は
[packages/tree-svelte/README.md](../../packages/tree-svelte/README.md) を参照。

利用するアプリの `package.json` に依存を追加する（モノレポ内なら
`workspace:*`、本リポジトリ外から消費する場合は
[../publishing.md](../publishing.md) の git 依存と `path:` 指定）:

```jsonc
{ "dependencies": { "@banto/tree-svelte": "workspace:*" } }
```

`ja` 文言（既定は日本語）はアプリ側の解決済み文字列を `messages` prop で上書きできる
（`@banto/grid-svelte` 等と同じ i18n レイヤ①方式）。

**(a) 基本のツリー**（展開・単一選択・アクティブ化）:

```svelte
<script lang="ts">
	import { BantoTree, type TreeNode } from '@banto/tree-svelte';

	const nodes: TreeNode[] = [
		{
			id: 'src',
			label: 'src',
			children: [
				{ id: 'app', label: 'app.ts' },
				{ id: 'lib', label: 'lib', children: [{ id: 'util', label: 'util.ts' }] }
			]
		},
		{ id: 'readme', label: 'README.md' }
	];
</script>

<BantoTree
	{nodes}
	expanded={['src']}
	onSelectionChange={(ids) => console.log('selected', ids)}
	onActivate={(node) => console.log('open', node.id)}
/>
```

**(b) 複数選択 + チェックボックス**（三状態。親チェックで子も連動）:

```svelte
<BantoTree {nodes} selectionMode="multi" checkboxes onCheckChange={(ids) => (picked = ids)} />
```

**(c) 遅延読み込み**（`hasChildren: true` の枝を初回展開時に取得）:

```svelte
<script lang="ts">
	import { BantoTree, type TreeNode } from '@banto/tree-svelte';

	const roots: TreeNode[] = [{ id: 'root', label: 'ルート', hasChildren: true }];

	async function loadChildren(node: TreeNode): Promise<TreeNode[]> {
		const res = await dataProvider.list('categories', { filter: { parentId: node.id } });
		return res.rows.map((r) => ({ id: r.id, label: r.name, hasChildren: r.childCount > 0 }));
	}
</script>

<BantoTree nodes={roots} {loadChildren} />
```

**(d) 階層データグリッド（tree-grid）**（`columns` を渡す）:

```svelte
<script lang="ts">
	import { BantoTree, type TreeColumn } from '@banto/tree-svelte';

	const columns: TreeColumn<{ size: number }>[] = [
		{ id: 'size', header: 'サイズ', accessor: 'size', align: 'right' }
	];
</script>

<BantoTree {nodes} {columns} />
```

**(e) ツリー選択の入力欄（tree-select）** — `@banto/forms` の `FormStore` へは
`bind:value` + `store.setValue` で手配線する（パッケージ間 import は禁止のため、
アプリ側で合成する）:

```svelte
<script lang="ts">
	import { TreeSelect } from '@banto/tree-svelte';

	let categoryId = $state<string | null>(null);
</script>

<label class="field">
	カテゴリ
	<TreeSelect
		{nodes}
		bind:value={categoryId}
		onChange={(v) => store.setValue('categoryId', v as string)}
		onBlur={() => store.touch('categoryId')}
	/>
</label>
```

**(f) ドラッグ並べ替え + インライン名前変更**（`draggable` / `editable`。F2 または
ダブルクリックでリネーム。`onMove`/`onRename` を渡すとデータ更新をアプリが持つ。
未指定なら内部の不変操作で反映する）:

```svelte
<BantoTree
	{nodes}
	draggable
	editable
	onMove={(dragId, targetId, position) => persistMove(dragId, targetId, position)}
	onRename={(id, label) => persistRename(id, label)}
/>
```

ツリー演算（可視行のフラット化・move/reparent・三状態計算・リネーム patch）は
すべて `packages/tree-svelte/src/core/` の依存ゼロ純関数で、DOM 無しで単体テスト
できる（`packages/tree-svelte/tests/`）。詳細な API は
`packages/tree-svelte/src/index.ts` の re-export と各 JSDoc を参照。

このパッケージを使わない場合は `packages/tree-svelte/` ごと削除してよい
（本体はこのパッケージに一切依存していない）。
