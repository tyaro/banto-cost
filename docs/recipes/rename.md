# レシピ: コピーとリネーム（`scripts/rename.mjs`）

作成日: 2026-10-08（README「1. コピーとリネーム」から切り出し。トラックB＝
アプリ作者向け）

Banto は**コピーして使う**前提のテンプレート（[template-scope.md §1](../template-scope.md)）。
コピーした直後に、名称・識別子をリネームスクリプトで一括書き換えする手順と、
スクリプトが書き換える箇所・書き換えない箇所の全量を記す。
次のステップ（デモ `items` の差し替え・オプション資産の削除）は
[README「テンプレートから自分のアプリを作る」](../../README.md#テンプレートから自分のアプリを作る)。

## 手順

1. リポジトリをコピー（GitHub の「Use this template」、または
   `git clone` 後に `rm -rf .git && git init` で履歴を切り離す）。
2. **リネームスクリプトを実行**（P2-1。名称・識別子の一括書き換え）:

   ```sh
   node scripts/rename.mjs \
     --name my-app \
     --title "My App" \
     --identifier com.example.myapp \
     --repo https://github.com/me/my-app   # 省略可
   # --dry-run を付けると書き換え内容の事前確認のみ
   ```

3. スクリプトが**やらない**こと（下記）を手で済ませる。実行後に案内も表示される。
4. `packages/*` は現状 `@banto/*` のままモノレポ内 `workspace:*` 参照で使う分には
   リネーム不要（配布する場合のみ検討）。

## スクリプトが書き換える箇所（手動でやる場合のチェックリスト）

- ルート `package.json` の `name`/`description`
- `apps/admin-template/package.json` の `name`（`<name>-app`）と、ルート `package.json`・
  `e2e/playwright.config.ts` の `--filter` 参照の追随
- `apps/admin-template/src-tauri/tauri.conf.json` の `productName`/`identifier`
  （`dev.banto.admin` を自分の逆順ドメイン識別子に）・`app.windows[0].title`
- アプリ内の表示文言（`src/app.html` の `<title>`、`src/lib/components/Sidebar.svelte`・
  `src/routes/login/+page.svelte` 等の「Banto」表記）と、E2E のログイン見出しアサーション
- OS keyring のサービス名: `apps/admin-template/src-tauri/src/keyring_store.rs` の
  `SERVICE_NAME`（既定 `"dev.banto.admin-template"` → `--identifier` の値。手動でやる場合に
  見落とすと、新アプリの資格情報が旧テンプレートの keyring 識別子のまま同居する）
- ファイアウォールの許可を昇格して行う helper（Issue #219 段階 2、[ADR-0021](../adr/0021-firewall-elevated-helper.md)）の
  identifier: `apps/admin-template/elev/src/lib.rs` の `IDENTIFIER`（`tauri.conf.json` の
  `identifier` と同じ値。食い違うと本体が helper を起動しない。`cargo test -p admin-template-fw-elev`
  の `identifier_matches_tauri_conf` が検出する）。NSIS のフック
  （`src-tauri/windows/fw-elev-hooks.nsh`）は Tauri の定義から名前を作るので書き換え不要
- Rust ワークスペース `Cargo.toml` の `workspace.package.repository` と各
  `packages/*/package.json` の `repository.url`（`--repo` 指定時。`@banto/*` パッケージを
  独自に配布する場合は [publishing.md](../publishing.md) の scope 問題も参照）
- Web マニフェスト（`static/manifest.webmanifest`）の `name`/`short_name`
  （PWA の「ホーム画面に追加」で使う表示名。アイコン画像は差し替えが必要 — 下記
  「やらないこと」）

> **リネームしてはいけないもの**: `X-Banto-Client: banto` CSRF ヘッダは「Banto」の
> 文字列に見えるが、LAN REST の固定プロトコル値であってブランド名ではない。
> 送信側（`packages/admin-core/src/providers/http.ts` 等の `CLIENT_HEADER_NAME`）と
> 検証側（`crates/banto-server/src/csrf.rs`）の両方にハードコードされており、`banto` を
> 機械的に一括置換すると LAN REST 認証が 403 で全滅する。リネームスクリプトは対象
> ファイルを明示列挙するため安全だが、手動置換や `sed -i` での一括置換をする場合は
> このヘッダを除外すること。

## スクリプトがやらないこと

- アイコン: `pnpm --filter <name>-app tauri icon <画像>`（Windows では `tauri dev`/
  `tauri build` に `icons/icon.ico` が必須。同梱済みで、独自アイコンに差し替えるとこの
  コマンドで全形式を再生成できる — [windows-setup.md](windows-setup.md)）
- ルート `README.md`/`LICENSE`（著作権者名）の文言
- visual regression スナップショットの再生成（旧ブランドの見た目で撮られているため
  `pnpm e2e:visual --update-snapshots`）
- トラックA の文書（`docs/`・`AGENTS.md`・`CLAUDE.md`）の削除。アップストリームを
  追わずハードフォークするなら不要になれば削除してよい（テンプレートの「すべては
  削除可能」方針、[README「ドキュメントの2トラック」](../../README.md#ドキュメントの2トラック)）

## 別リポジトリから git 依存として参照する場合

ここまでは「banto 自体をフォークして 1 リポジトリ内で使い続ける」場合の手順。
**別リポジトリが `@banto/*`/`banto-*` を git 依存として参照する**（コピーせず消費する）
場合は追加の作業が要る — [consume-as-git-dependency.md](consume-as-git-dependency.md)。

リネーム後に Banto の新しい版を取り込むとき、何が置き換わるか（ファイル名・クレート名の
読み替え）は本書の「書き換える箇所」を基準にする（[upgrading.md §3.2](../upgrading.md)）。
