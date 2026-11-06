# @banto/attachments

Banto の添付ファイル/画像管理 UI パッケージ（M20、オプション扱い）。
`AttachmentsPanel.svelte` が一覧・アップロード・削除・サムネイル/
ダウンロード表示を提供する（docs/design/attachments-plan.md §3.7）。トランスポート
非依存で、呼び出し側が `AttachmentsClient` を注入する
（アプリ固有 import は持たない、docs/conventions.md §5）。

## 使用例

```svelte
<script lang="ts">
	import { AttachmentsPanel, type AttachmentsClient } from '@banto/attachments';

	// アプリ側で REST/Tauri 実装を用意して注入する（package はトランスポートを知らない）
	declare const attachmentsClient: AttachmentsClient;
</script>

<AttachmentsPanel resource="items" resourceId="1" client={attachmentsClient} canWrite={true} />
```

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（オプションパッケージだが他オプションにも依存しない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/design/attachments-plan.md §3.7](../../docs/design/attachments-plan.md)（M20: 添付ファイル/画像管理 計画書、`@banto/attachments`）
