# レシピ: オプション資産の削除（scaffold プリセットと手動手順）

作成日: 2026-10-08（README「3. オプション資産の削除」から切り出し。トラックB＝
アプリ作者向け）

Banto の同梱物のうち「同梱するが削除できる」ことが保証されたオプション資産
（[template-scope.md §3](../template-scope.md)）を外す手順。まず `pnpm scaffold` の
プリセットでまとめて外し、scaffold が触らない資産や独自に削りたいものは
後半の手動手順で外す。**表示専用アプリを作るなら、まず [`--preset display`](#--preset-display表示専用アプリ) を読む。**

## scaffold プリセット

```bash
pnpm scaffold --preset <preset>    # minimal | standard | full | display
pnpm install                       # 外れた依存の反映（lockfile も更新される）
# --interactive で資産ごとに対話選択、--dry-run で変更内容の確認のみ
```

各プリセットが**残す**オプション資産（✓＝残す / ✗＝外す。コアは全プリセットで常在）:

| オプション資産                                                           | minimal | standard | full |    display    |
| ------------------------------------------------------------------------ | :-----: | :------: | :--: | :-----------: |
| `@banto/charts` / `@banto/dock-svelte` / Glass テーマ / コマンドパレット |    ✗    |    ✓     |  ✓   |       ✗       |
| `@banto/attachments` / `@banto/report` / `@banto/tree-svelte` のデモ     |    ✗    |    ✗     |  ✓   |       ✗       |
| `items` デモリソース一式                                                 |    ✓    |    ✓     |  ✓   | ✗（追加削除） |

- テンプレートは `full` 相当で出荷され、scaffold は基本「引く」だけ。`display` だけが
  「足す」工程も持つ（下記）。
- `@banto/scan-wedge` はレシピのみ・テンプレート未配線のため scaffold は触れない
  （[scan-wedge.md](scan-wedge.md)）。
- `@banto/image-assets` もテンプレート未配線（アプリが依存しない）のため scaffold は触れない
  （下記「`@banto/image-assets`」、[ADR-0020](../adr/0020-image-assets-package.md)）。
- 設計は [design/scaffold-presets-plan.md](../design/scaffold-presets-plan.md)、
  受け入れ検査は `.github/workflows/template-acceptance.yml`（4 プリセットの
  scaffold → verify:architecture → check → build → cargo test）。

## `--preset display`（表示専用アプリ）

```bash
pnpm scaffold --preset display
pnpm install          # 外れた依存の反映（lockfile も更新される）
```

カンバン（アンドン）・常設ダッシュボード・展示デモのように、**画面を出しっぱなしに
して眺めるだけ**のアプリ向けの初期状態にする。唯一「外す」だけでなく「足す」も
行うプリセット（他は削除のみ）。設計は
[design/display-preset-plan.md](../design/display-preset-plan.md)（Issue #190）。

**外れるもの**

| 区分               | 内容                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| オプション資産     | `minimal` と同じ（charts / dock / Glass / コマンドパレット / 添付 / 帳票 / ツリー）                                                                                                                                                                                                                                                                                        |
| items デモリソース | `core/src/items.rs`・`core/src/rest/items.rs`・`migrations-{sqlite,postgres}/0001_items.sql`・`src-tauri` の `items_*` コマンド・`routes/(app)/items/**`・`#lib/banto/{itemsAdmin,resources/items,sampleData,dashboard}.ts`・ナビ項目・`messages` の `items.*`／`nav.items`・`verify-architecture` の items マニフェスト行                                                 |
| 管理画面           | `routes/(app)/users/**` と `routes/(app)/audit-log/**`（**画面だけ**。サービス層・REST・Tauri コマンドは残るので、ルートを足し直せば戻せる）                                                                                                                                                                                                                               |
| ダッシュボード     | `routes/(app)/dashboard/**`。ホーム（`/`）とログイン後の遷移先は `/monitor` になる                                                                                                                                                                                                                                                                                         |
| e2e / ビジュアル   | 同梱スモークは items/users 画面前提なので、**シナリオ1本**のスモークに差し替わる（未ログインの `/` が `/monitor` に着く）。`e2e/tests-public-viewer/`・`e2e/visual/`（ベースライン画像を含む）・`playwright.config.ts` の該当 project／webServer・ルート `package.json` の `e2e:visual`／`e2e:public-viewer`・`ci.yml` の該当ステップ・`visual-baselines.yml` は削除される |

**足されるもの / 既定値が変わるもの**

- `src/routes/(app)/monitor/+page.svelte` — 時計と「最終更新」だけの最小ページ。
  `$effect` + 世代トークンのポーリング雛形が入っているので、`load()` を自分の
  **読み取り専用**の取得に差し替えて使う。ナビは `{ publicViewer: true }` で登録される。
- **初回起動の既定**（`apps/admin-template/core/src/first_boot.rs` の
  `FIRST_BOOT_SETTINGS`。`settings` テーブルが空のときだけ書き込まれる）:
  `auth.disabled=true` / `auth.disabled_role=admin` / `server.viewer_public=true` /
  `server.enabled=true` / `server.bind=0.0.0.0`。
  つまり**コピーして起動した瞬間から、LAN の未ログイン端末が合成 `viewer`
  セッションで `/monitor` を見られる**（[ADR-0012](../adr/0012-lan-public-viewer-synthetic-session.md)）。
  書き込みは RBAC の `viewer` 床で 403 のまま。既定を変えたければこの const を編集する。
- **キオスクシェル既定 ON**（`src/lib/settings.svelte.ts` の `KIOSK_DEFAULT`）:
  サイドバー折り畳み・ヘッダのコンパクト化・全画面ボタン。設定画面「外観」で戻せる。
- **`banto.i18n = "raw"`**（`apps/admin-template/package.json`）: 単一言語アプリとして
  UI 文言を直書きしてよい opt-out。`verify:architecture` の `raw-jp-in-app` と
  `check-i18n-nonempty` が自身をスキップする（[conventions.md §13](../conventions.md#i18n-messages)）。
  多言語に戻したいときは `"keys"` に戻し、`/monitor` の文言を `messages/{ja,en}.json` へ移す。

**注意**

- **セキュリティ**: 初回起動の既定は「LAN に閲覧公開する」設定。社外ネットワークに
  出す用途では、`first_boot.rs` の `server.viewer_public` / `server.bind` を見直すこと
  （[lan-access.md](lan-access.md) のセキュリティ注意）。
- [add-resource.md](add-resource.md) は **items がある前提**で書かれている。display では
  items 一式が無いので、「items をコピーして書き換える」ステップは「レシピ本文のコード片を
  新規ファイルとして起こす」と読み替える（層別のファイル一覧と配線先はそのまま使える）。
- `pnpm install --frozen-lockfile` は通らない（`apps/admin-template/package.json` から
  workspace 依存が5つ消えるため）。scaffold 直後は `pnpm install` を使う。

## 手動手順（資産別）

scaffold の各 remover はこの手順を 1 対 1 で自動化したもの（`scripts/scaffold.mjs`）。
scaffold が触らない箇所（`src-tauri` 側のポップアウト配線・システムメトリクス）は
ここだけに手順がある。

### `@banto/dock-svelte`（ダッシュボードのドッキングレイアウト）

`apps/admin-template/src/routes/(app)/dashboard/+page.svelte` の
`DockHost`/`dock`/`onPopOut` 関連コード、`src/lib/banto/panels.ts`・
`src/lib/banto/popout.ts`・`src/lib/banto/dockEscape.ts` とその `.test.ts`（dock の gesture の
Esc をどの層に譲るか。#433）・`src/routes/panel/[id]/`（ポップアウト先の
スタンドアロンウィンドウ用ルート）、メモ pane の draft と確認ダイアログ
（`src/lib/banto/dashboardMemo.svelte.ts`・`src/lib/banto/settlePrompt.svelte.ts` と
それぞれの `.test.ts`、`src/lib/components/DashboardMemoField.svelte`・
`src/lib/components/DraftSettleDialog.svelte`。#432。メモの Ctrl+S の登録もここ。#435）を削除し、ダッシュボードページを固定
レイアウトのパネル羅列に置き換える。`apps/admin-template/package.json` の
`@banto/dock-svelte` 依存と、`apps/admin-template/vite.config.ts` の
`optimizeDeps.exclude` にある `'@banto/dock-svelte'` 行を外す（残すと
`pnpm verify:architecture` の `optimizedeps-svelte-source` が「不要なのに
登録」で落ちる。[ADR-0007](../adr/0007-derived-app-dev-optimizer-exclude.md)）。

あわせて **`src-tauri` 側**の以下も外す。ポップアウト専用の配線であり、
残すと呼び出し元のない孤立コード + 不要なウィンドウ権限になる
（`pnpm scaffold` は `src-tauri` を書き換えないため、ここは常に手作業）:

- `apps/admin-template/src-tauri/src/lib.rs` の `panel_open` コマンド
  （関数本体と `invoke_handler` への登録の2箇所）
- `apps/admin-template/src-tauri/capabilities/default.json` の `"windows"`
  配列内 `"panel-*"` エントリ（ポップアウトウィンドウのケイパビリティ許可）

### `@banto/charts`（SVGチャート）

`apps/admin-template/src/routes/(app)/dashboard/+page.svelte` の
チャートデモ（トレンド/SPC系パネル）と `src/lib/components/DashboardPanel.svelte`・
`src/lib/banto/dashboard.ts` の集計処理を削除。`items`
自体は他機能（CSVエクスポート等）で使うため残してよい。
`package.json` の `@banto/charts` 依存を外す。

### Glassテーマ + Windows vibrancy（M12）

`packages/theme/src/css/banto-glass.css` を削除し
`packages/theme/src/css/banto.css` の `@import './banto-glass.css'`
を外す。`packages/theme/src/index.ts` の `ThemePreset` から `'glass'` を
除去。設定画面（`apps/admin-template/src/routes/(app)/settings/AppearanceSection.svelte`）
のプリセット選択肢から「ガラス」を外す。デスクトップの本物のガラス感
（Windows Acrylic）も併せて外す場合は `src/lib/banto/vibrancy.ts`、
`src-tauri/src/lib.rs` の `vibrancy_apply`/`vibrancy_status`/
`set_window_vibrancy` と `window-vibrancy` 依存
（`src-tauri/Cargo.toml`）、設定画面のvibrancyトグルを削除する。
プリセット未選択（`standard`のみ）ならCSSは不活性のため、見た目だけ
気にしないなら削除自体は必須ではない。

### コマンドパレット（Ctrl+K、M16）

`apps/admin-template/src/lib/components/CommandPalette.svelte`・
`src/lib/commandPalette.svelte.ts`・`src/lib/commands.ts`・`src/lib/commands.test.ts`・
`src/lib/recentCommands.ts`・`src/lib/recentCommands.test.ts` を削除し
（テストを残すと、消したモジュールを import して `pnpm --filter admin-template test` が落ちる）、
`src/routes/(app)/+layout.svelte` と `src/lib/components/Header.svelte`
からの参照（`commandPaletteStore`・Ctrl+K の command の登録とパレットの host・パレット起動
ボタンと鍵帽の表示）を外す。キーの dispatcher（`src/lib/shortcuts.ts`、#435）はページの command
（ダッシュボードの Ctrl+S）のために残す。ナビ定義（`navigation.ts`）からの自動導出のみで構成
されるため、削除してもナビ自体には影響しない。

### 添付ファイル機能（`@banto/attachments` + items 添付デモ、M20）

以下の順で外すとビルド・テストが引き続き通る（依存の少ない順）。

1. `apps/admin-template/src/routes/(app)/items/[id]/+page.svelte` の
   `AttachmentsPanel` 配線（`M20 demo wiring` コメントのブロック）と
   関連 import（`@banto/attachments`・`isAttachmentsAvailable`・
   `attachmentsClient`）を削除。
2. `apps/admin-template/src/lib/banto/attachmentsClient.ts`・
   `src/lib/banto/attachmentsAdmin.ts` を削除。
3. `apps/admin-template/core/src/rest/attachments.rs`（`attachments_router`
   一式（`attachments_list`/`attachments_upload`/`attachments_delete`等）と
   `items_delete` からの `delete_for_record` 呼び出し・`ItemsWriteState`
   の `attachments` フィールドを外す。`src-tauri/src/lib.rs` も同様に
   `attachments_*` コマンドと `AppState` の `attachments`/`attachments_dir`
   フィールド、`items_delete` の `delete_for_record` 呼び出しを外す。
4. `apps/admin-template/core/src/rest/tests.rs` から attachments 参照を外す
   （`api_router` から attachments 引数が消えるのに追随。外さないと
   `cargo test` がコンパイルできない）: `unused_attachments_service` ヘルパと
   その各呼び出し・`api_router(...)` 実引数の `attachments,`、末尾の
   `// --- M20: attachments` テストブロック（EOF まで、独自の実サービスを含む）を削除。
5. `apps/admin-template/package.json` の `@banto/attachments` 依存、
   ワークスペースの `crates/banto-attachments`（`Cargo.toml` の
   `members` と `admin-template-core`/`admin-template` の依存）を外す。
6. `apps/admin-template/core/migrations-sqlite/0006_attachments.sql`（および
   `migrations-postgres/0006_attachments.sql`）を削除（`attachments` テーブルは
   他のテーブルから参照されないため、単独で安全に外せる）。

### 帳票デモ（`@banto/report` + 日報デモ、M19）

DB/バックエンド配線を一切持たない最小デモのため、以下だけで外せる。

1. `apps/admin-template/src/routes/(app)/items/+page.svelte` の「日報」
   ボタン（`M19 report demo` コメントの1ブロック）と `FileText` の import
   を削除。
2. `apps/admin-template/src/routes/(app)/items/report/`（ルート丸ごと）と
   `src/lib/banto/reports/`（`daily.md`・`raw.d.ts`）を削除。
3. `apps/admin-template/package.json` の `@banto/report` 依存、
   `src/app.css` の `@import '@banto/report/print.css'` と
   `.banto-report-active` 用の `@media print` ブロックを外す。
   `@banto/report` パッケージ自体（`packages/report`）はテンプレートに
   同梱したままでも他に影響しないが、完全に外す場合は
   `pnpm-workspace.yaml` の対象から漏れないことを確認する。

### ツリーデモ（`@banto/tree-svelte` + `/tree` デモ、M-review 2026-08）

DB/バックエンド配線を持たない最小デモ。`pnpm scaffold` の minimal / standard
プリセット（または `--interactive`）で自動削除できる。手動で外す場合は以下。

1. `apps/admin-template/src/routes/(app)/tree/`（ルート丸ごと）と
   `src/lib/banto/treeSample.ts` を削除。
2. `src/lib/navigation.ts` の `'tree'`/`'nav.tree'`（`NavIconKey`/`NavLabelKey`
   の union と navItems の `/tree` 行）、`src/lib/components/navIcons.ts` の
   `tree:` エントリと `ListTree` の import を削除（union とアイコンマップは
   型で連結しているため対で外す）。
3. `src/lib/banto/i18n.ts` の `treeMessages()` と `TreeMessages` import、
   `messages/{ja,en}.json` の `nav.tree`・`tree.*` キーを削除。
4. `apps/admin-template/package.json` の `@banto/tree-svelte` 依存を外す。
   パッケージ本体（`packages/tree-svelte`）は同梱のままでも他に影響しないが、
   ナビが1項目減るぶんサイドバーが写る認証ページのビジュアル回帰ベースライン
   を再生成する（`.github/workflows/visual-baselines.yml` を dispatch）。

### `@banto/image-assets`（ブラウザ側の画像の原本・取込検査、Issue #438）

テンプレートのアプリには配線していない（`apps/admin-template/package.json` に依存が無い）ので、
アプリ側に外す配線は無く、`pnpm scaffold` もどのプリセットでも触れない。パッケージ本体を
同梱のままにしても他に影響しない。リポジトリから消したい場合は以下。

1. `packages/image-assets/` を削除し、`pnpm install` で lockfile を更新する。
2. `docs/` と README の `@banto/image-assets` の参照（template-scope §3 の行・本節・
   ADR-0020 など）を消すか、スコープ無しの書き方に直す（`verify:architecture` の
   rule `docs-package-refs` が実在しないパッケージの参照を落とす）。
3. banto 本体のリポジトリで消す場合は、外部利用 fixture（`fixtures/external-consumer/`）の
   `package.json` の依存・`src/routes/+page.svelte` の import・`vite.config.ts` の
   `optimizeDeps.exclude` からも外す（`verify:architecture` の rule `external-consumer-fixture`。
   scaffold した派生アプリでは fixture ごと除去済み）。

### システムメトリクス（`sysinfo`）を外す（ADR-0013、Issue #185）

`apps/admin-template/core/Cargo.toml` と `apps/admin-template/src-tauri/Cargo.toml`
の `default` から `system-metrics` を外す。System Info カードの CPU/メモリの
行は `metrics` が `null` になり自動的に消える（他の行は従来どおり）。
`banto-admin-services` 自体の `system-metrics` feature（`sysinfo` 依存の実体）
はそのまま残しておいて構わない（無効化されたテンプレート側から到達しなく
なるだけ）。

## 関連

- デモリソース `items` 自体の差し替え・削除は [add-resource.md](add-resource.md)
  （`attachments` の items デモ配線を使っている場合は本書の添付の手順が先）。
- ログイン無しの小さなアプリとして始めるなら [no-login-app.md](no-login-app.md)。
