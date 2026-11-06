# レシピ: バーコード/QRスキャナ入力（`@banto/scan-wedge`）

作成日: 2026-08-14（README から切り出し。トラックB＝アプリ作者向け）

キーボードウェッジ型のバーコード/QRスキャナは、コード内容を高速なキー
入力列 + 終端キー（通常 Enter）として送る。`@banto/scan-wedge`
（[../roadmap.md](../roadmap.md) M21）は、これを人間のタイプと
区別して「1スキャン = 1文字列」で通知するヘッドレスパッケージ。
バックエンド・DB・UI依存ゼロの小粒機能のため**テンプレート本体には
一切配線していない**（デモページ等なし）。使う場合は以下のレシピを
参考に、自分のアプリのコードへ直接組み込む。

利用するアプリの `package.json` に依存を追加する（モノレポ内なら
`workspace:*`、本リポジトリ外から消費する場合は
[../publishing.md](../publishing.md) の git 依存 + `path:` 指定）:

```jsonc
{ "dependencies": { "@banto/scan-wedge": "workspace:*" } }
```

**(a) ページ全体でのグローバル検出**（`+layout.svelte` 等。フォーム入力
中は無視し、スキャンをアプリ全体のショートカット的に扱いたい場合）:

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

**(b) 検索ボックスへの `use:wedgeInput`**（スキャンを専用の入力欄で
受ける場合。スキャン完了時に自動で欄をクリアする）:

```svelte
<script lang="ts">
	import { wedgeInput } from '@banto/scan-wedge';

	let query = $state('');
</script>

<input
	bind:value={query}
	use:wedgeInput={{ onScan: (code) => search(code) }}
	placeholder="バーコードをスキャン"
/>
```

**(c) キオスク端末での `use:keepFocused`**（常に同じ入力欄にフォーカスを
保ち、スキャナからのキー入力が確実にその欄へ届くようにする）:

```svelte
<script lang="ts">
	import { wedgeInput, keepFocused } from '@banto/scan-wedge';

	let kioskMode = true;
</script>

<input
	use:wedgeInput={{ onScan: (code) => search(code) }}
	use:keepFocused={{ enabled: kioskMode }}
/>
```

`createWedgeDetector`（DOM非依存のヘッドレスコア、既定値: `minLength` 4文字
/ `maxInterKeyMs` 35ms / `terminators` `['Enter']`）を直接呼び出すことも
できる（Node/テスト環境や独自のイベントソースから使いたい場合）。詳細な
挙動・オプションは `packages/scan-wedge/src/core/detector.ts` の JSDoc、
制約（スキャン中の文字はフォーカス中の入力欄に混入済みで後から抑止でき
ない点とその回避策）は `packages/scan-wedge/src/listen.ts` の JSDoc を参照。
