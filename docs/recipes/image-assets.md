# レシピ: 画像の取り込みと表示（`@banto/image-assets`）

作成日: 2026-10-21（Issue #438。トラックB＝アプリ作者向け）

ブラウザで画像を取り込み、**原本の bytes のまま**持ち回って表示する部品。取り込みの前にヘッダを検査し、
原本を hash で重複排除して保持し、表示用の object URL の寿命を管理する。デザイナのように「取り込んだ画像を
原本のまま保存・再利用する」画面のためのもので、サーバーへの添付（`@banto/attachments`）とは目的が違う。
テンプレート本体には配線していない（オプション。使うアプリが直接組み込む）。API の全量・エラーコード・
再入や dispose の約束は
[packages/image-assets/README.md](../../packages/image-assets/README.md) を正とし、ここには組み込みの流れだけを書く。

## 1. 導入

依存に足す（モノレポ内は `workspace:*`、外部リポジトリは git サブディレクトリ依存。
[consume-as-git-dependency.md](consume-as-git-dependency.md)）:

```json
{ "dependencies": { "@banto/image-assets": "workspace:*" } }
```

`.svelte.ts` を含むので、`vite.config.ts` の `optimizeDeps.exclude` にも足す（足さないと dev が 500 になる。
[conventions §14](../conventions.md)）:

```ts
// vite.config.ts
export default defineConfig({
	// ...
	optimizeDeps: {
		exclude: ['@banto/image-assets' /* ほかの @banto/* */]
	}
});
```

## 2. 取り込みの検査（`inspectImage`）

上限は**呼び出し側が決めて渡す**（パッケージは既定値を持たない）。失敗は `ImageAssetError` の `code` と
`detail` で返るので、画面の文言はアプリが Paraglide のキーで決める（[conventions §13](../conventions.md)）。

```ts
import { inspectImage, isImageAssetError, validateImageImportLimits } from '@banto/image-assets';

const limits = validateImageImportLimits({
	maxBytes: 8 * 1024 * 1024,
	maxEdge: 8192,
	maxPixels: 16_000_000,
	formats: ['png', 'jpeg']
});

try {
	const image = await inspectImage(file, limits); // File / Blob / Uint8Array / ArrayBuffer
	// image: { format, mimeType, width, height, transposed, byteLength, hasAlpha, sha256 }
} catch (e) {
	if (isImageAssetError(e)) showError(m[`imageAssets.error.${e.code}`](e.detail));
	else throw e;
}
```

## 3. 原本の保持と表示（`createImageStore`）

store は検査を通した原本を不変の `Blob` で保持し、同じ内容（SHA-256 が同じ）は 1 件にまとめる。
`<img>` には `acquireUrl` で借りた object URL を渡し、表示をやめたら `release()` で返す
（最後の `release()` で revoke）。

```svelte
<script lang="ts">
	import { createImageStore, isImageAssetError } from '@banto/image-assets';
	import { onDestroy } from 'svelte';

	const store = createImageStore({ maxTotalBytes: 256 * 1024 * 1024 }); // 総容量は必須
	let lease = $state<{ url: string; release(): void } | null>(null);

	async function onPick(file: File) {
		try {
			const image = await store.add(file, limits, { key: 'background' });
			if (!image) return; // 新しい add に追い越された（結果もエラーも出ない）
			lease?.release();
			lease = store.acquireUrl(image.sha256);
		} catch (e) {
			if (isImageAssetError(e)) showError(m[`imageAssets.error.${e.code}`](e.detail));
			else throw e;
		}
	}

	onDestroy(() => {
		lease?.release();
		store.dispose(); // 処理中の add を失効させ、借りていない原本を捨てる
	});
</script>

{#if lease}<img src={lease.url} alt="" />{/if}
```

要点:

- **同じ `key` の新しい `add` が古い `add` を失効させる**（古い方は `null`）。対象が変わったら `store.cancel(key)`。
- **書き出し中は `pin`**: `const release = store.pin([hash])` の間は `collect` / `delete` / `dispose` で消えない。
  `try { … } finally { release(); }` で必ず解除する。原本は `store.blob(hash)`（ヘッダの MIME の `Blob`）。
- **不要になった原本は `collect(retained)`**: 今の内容と Undo / Redo が参照する hash の和集合を渡す。
  pin 中・URL 貸出中の原本は捨てない。
- **`acquireUrl` の貸出は必ず `release()` する**（返さないと URL が revoke されない）。
- **平文 HTTP の LAN でも動く**: hash は `crypto.subtle` があれば使い、無ければ自前の SHA-256 に落ちる
  （[ADR-0020](../adr/0020-image-assets-package.md)）。
- 別の store の原本を取り込む `importFrom(source, hash)`、`url-pending`・`store-disposed` などの
  エラーの詳細は、パッケージの README の表を参照。
