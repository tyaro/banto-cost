# scaffold `--preset display` 計画書 — Issue #190

作成日: 2026-09-14
状態: **PR-D1 / PR-D2 とも実装済み**（PR-D1 = 本体準備、PR-D2 =
`scripts/scaffold.mjs --preset display`）。前提の Issue #189（閲覧公開、PR #191）は
マージ済み。利用者向けの説明は [recipes/remove-optional-assets.md「`--preset display`」](../recipes/remove-optional-assets.md)（2026-10-08 に README から移動）、
受け入れ検査は `.github/workflows/template-acceptance.yml` の `presets` matrix
（`[minimal, standard, full, display]`）。
トラック: 保守者向け（トラックA）
関連: [scaffold-presets-plan.md](scaffold-presets-plan.md)（P4-9、minimal/standard/full の
設計）、[viewer-public-plan.md](viewer-public-plan.md)、ADR-0012、
[recipes/no-login-app.md](../recipes/no-login-app.md)、template-scope §3 / §7、
conventions §13

## 1. 目的

カンバン（アンドン）・常設ダッシュボード・展示デモのような**表示専用アプリ**を
「コピーして起動」できる初期状態にする。現状の `minimal` はオプション資産を
外すだけで、items 雛形（約 4,000 行）・users / audit-log 画面・Paraglide 必須が
残り、表示専用アプリでは保守面積として乗り続ける（Issue #190 の実測）。

## 2. 設計原則 — 「display で足すものは、まずテンプレート本体のトグルにする」

scaffold-presets-plan §1 の是正（プリセットが動かせるのは「オプション資産」と
「設定の既定値」だけ）を display にも適用する。display 固有の挙動を scaffold の
出力にだけ存在するコードにすると、テンプレート本体の CI（e2e / visual /
verify-architecture）で一切検証されない。したがって:

1. **display が「足す」もの**（初回起動の設定 seed、キオスク向けシェル、i18n
   opt-out）は、**まずテンプレート本体に既定 OFF のトグルとして実装**し、
   本体の e2e / visual で検証する。scaffold は既定値を反転するだけ。
2. **display が「外す」もの**（items 一式、users / audit-log 画面）は、
   既存 remover と同じ `drop` / `cutRegion` / `removeFile` 方式。items は
   コア扱い（template-scope §2.2）だったが、「デモリソース」として
   **削除可能資産に再分類**する（§6 で template-scope §3 に行追加）。
3. 前提として、items 関連コードが**ファイル境界で分離されている**ほど
   remover は薄くなる。`rest/tests.rs`（items テストと auth / users / backups
   テストが同居、約 2,400 行）は先に分割する。

## 3. スコープ

### 3.1 PR-D1: テンプレート本体の準備（scaffold は触らない、挙動は既定で不変）

| 項目 | 内容 | 触れどころ |
| --- | --- | --- |
| D1-a 初回起動 seed | app 層に `FIRST_BOOT_SETTINGS: &[(&str, &str)]`（既定は空）を置き、`settings` テーブルが空のときだけ書き込む。汎用機構（派生アプリが LAN 既定 ON 等にも使える） | `src-tauri/src/lib.rs` `run()` の `SettingsService` 生成直後、`banto-serve.rs` も同じ関数を呼ぶ（`admin-template-core` に `seed_first_boot_settings` を置く） |
| D1-b キオスクシェル | UI 設定 `shell.kiosk`（既定 OFF、UiSettingsProvider 永続化、設定画面「外観」にトグル）。ON で: サイドバー折り畳み既定・ヘッダのコンパクト化（検索ピル非表示・高さ縮小）・ヘッダに全画面ボタン（ブラウザ `requestFullscreen` / Tauri `setFullscreen`） | `settings.svelte.ts`、`Header.svelte`、`Sidebar.svelte`、`settings/+page.svelte`、i18n キー、visual スナップショット 1 枚追加 |
| D1-c i18n opt-out | `apps/admin-template/package.json` の `"banto": { "i18n": "keys" \| "raw" }`（既定 `keys`）。`raw` のとき `verify-architecture` の `raw-jp-in-app` と `check-i18n-nonempty` をスキップ（理由を出力）。conventions §13 に「app 層は preset で opt-out 可」を明記。`@banto/*` 側の messages 注入方式は不変 | `scripts/verify-architecture.mjs`、`scripts/check-i18n-nonempty.mjs`、conventions §13 |
| D1-d items の分離 | `core/src/rest/tests.rs` → `rest/tests/{mod,items,attachments}.rs` に分割（items / attachments テストを別ファイルへ。挙動不変）。`dashboard.ts` / `sampleData.ts` / `navigation.ts` / `src-tauri/src/lib.rs` の items 区画に既存流儀のマーカーコメントを付ける | 上記ファイル。`cargo test` の件数が前後で一致することを確認 |

### 3.2 PR-D2: `--preset display`

| 区分 | 内容 |
| --- | --- |
| 外す（minimal と同じ） | charts / dock / glass / commandPalette / attachments / report / tree |
| 外す（新 remover `items`） | `core/src/items.rs`、`rest/items.rs`、`rest/tests/items.rs`、`migrations-{sqlite,postgres}/0001_items.sql`、`src-tauri` の `items_*` コマンド + `AppState.items`、`#lib/banto/{itemsAdmin,resources/items,sampleData}.ts`、`routes/(app)/items/**`、`dashboard.ts` の items 集計、nav の items、`verify-architecture` の DUAL_PATH / TAURI_READ / REST_READ / DESKTOP_ONLY の items 行、`db.rs` のデモ seed、e2e smoke の items シナリオ（display は e2e 対象外にするため削除ではなく「scaffold 出力では e2e を走らせない」） |
| 外す（新 remover `adminPages`） | `routes/(app)/{users,audit-log}/**` と nav 行・コマンドパレット項目（サービス層・REST・Tauri コマンドは残す = 設定画面から戻せる escape hatch を維持） |
| 足す | `routes/(app)/monitor/+page.svelte`（`$effect` + 世代トークンでポーリングする最小例、`publicViewer: true` の nav 項目、ホームを `/monitor` に）。`scripts/lib/templates/monitor.svelte` から複製 |
| 既定値を反転 | `FIRST_BOOT_SETTINGS` = `auth.disabled=true` / `auth.disabled_role=admin` / `server.viewer_public=true` / `server.enabled=true` / `server.bind=0.0.0.0`、`shell.kiosk` 既定 ON、`banto.i18n = "raw"` |
| 検証 | `scaffold.test.mjs` に display の dry-run 計画テスト、`template-acceptance.yml` の matrix に `display` を追加（scaffold → verify:architecture → check → build → cargo test）、README「オプション資産の削除」と AGENTS.md のプリセット一覧を更新 |

#### PR-D2 の実装結果（2026-09、確定した差分）

計画からの差分と、実装時に決めたことを記録する（表の記述が一次情報ではなく、
`scripts/scaffold.mjs` の `removeItems` / `removeAdminPages` / `removeDashboard` /
`applyDisplayDefaults` が一次情報）。

- **remover の実装単位**は計画どおり `items` / `adminPages` / `dashboard` の3つ。
  これに加えて**唯一の「足す」工程** `displayDefaults`（`applyDisplayDefaults`）を
  `ORDER` の末尾に置いた。`--dry-run` の計画表示にも `--strict` にも removers と
  同じ編集エンジンで乗る（`scripts/lib/template-edit.mjs` に `addFile` を追加）。
- **`ORDER` は display で順序依存**になる（`items` は attachments/report/tree の
  後、`adminPages`/`dashboard` は `items` の後、`displayDefaults` は最後）。
  理由は `navigation.ts` の union を段階的に縮めるためと、attachments remover が
  先に外す行に依存するアンカーが1箇所あるため。
- **アンカーは `// [scaffold:items]` マーカーを一次手段にした。** PR-D1 が入れた
  マーカーに加えて PR-D2 で追加した箇所: `core/src/db.rs` の `SEED_ROW_COUNT`、
  `core/src/rest/tests.rs` の3区画（setup テストの items ガード確認 / M14 の
  items 監査ステップ / 閲覧公開の items シナリオ）、`src-tauri/src/lib.rs` の7区画
  （`start_embedded_server` の引数と `Services` リテラル、`server_apply` と `setup`
  の実引数、`AppState` 構築リテラル、M15 CSV テスト章、`items_delete` 監査テスト）。
- **PR-D1 の積み残しの是正**: attachments remover が `rest/tests.rs` を
  「`// --- M20: attachments` から EOF まで」削っていたため、その後ろに追記された
  閲覧公開スイート（Issue #189）まで巻き添えで消えていた。終端マーカー
  （`// --- end M20 attachments`）を置いて範囲を閉じた。`minimal`/`standard` でも
  閲覧公開テストが残るようになる（`cargo test -p admin-template-core` は
  minimal で 92 件）。
- **`rest/mod.rs` の import 整理**: `rest/{items,attachments}.rs` が `use super::*;`
  で借りていた import が両方消えると unused_imports 警告が10件以上出るため、
  `removeItemsFromRestModImports()` で絞り、テストだけが使う `StatusCode` /
  `ListParams` / `Role` は `rest/tests.rs` の直接 import に移した（display の
  scaffold 出力は `cargo test` が**警告ゼロ**で緑）。
- **e2e の扱い（§3.3 の「非スコープ」の具体化）**: display の出力では e2e を
  「走らせない」のではなく、**items/users 画面を前提としたスイートを外し、
  シナリオ1本のスモークに差し替える**ことにした
  （`scripts/lib/templates/display/smoke.spec.ts`: 未ログインの `/` が `/monitor` に
  着く = 初回起動シード + 合成 viewer + `/monitor` の結線確認）。
  `e2e/tests-public-viewer/`・`e2e/visual/`（ベースライン画像含む）・
  `playwright.config.ts` の該当 project/webServer・ルート `package.json` の
  `e2e:visual`/`e2e:public-viewer`・`ci.yml` の該当ステップ・`visual-baselines.yml`
  は削除する。
- **`--interactive` の custom モード**はオプション資産7種のみを対象に保った
  （items/画面削除・追加は一括適用。プロンプト文にその旨を明記）。
- **`messages` の扱い**: JSON をパース→キー接頭辞でフィルタ→
  `JSON.stringify(…, null, 2)` で書き戻す（prettier 整形とバイト等価なことを確認済み）。
  `audit.*` は設定画面の保持ポリシー表示が使う4キー
  （`audit.retention{Days,Rows}Value` / `audit.retentionRowsUnlimited` /
  `audit.retentionUnlimited`）だけ残す。

### 3.3 非スコープ

- display 出力に対する e2e / visual（本体側 D1-b の visual で担保）。
- Paraglide 自体の除去（`raw` opt-out で二重作業だけ解消。辞書は空のまま残る）。
- ダッシュボードの残置（display では `/dashboard` を外し `/monitor` をホームにする。
  dock / charts / items 集計を失ったダッシュボードに残す価値が無いため）。

## 4. 検討事項への回答（Issue #190）

- **REQUIRED_TABLES**: `settings` / `users` / `audit_log` のみ（`backup.rs`）。items を
  外しても restore 検証に影響なし。確認済み。
- **verify-architecture rule 8**: items の 4 対 + read 2 + desktop-only 1 を
  マニフェストから外せば通る（`fs.existsSync` ガードで欠損ファイルは許容）。
  scaffold の後処理で `pnpm verify:architecture` を実行して検証（既存プリセットと同じ）。
- **e2e / visual の分け方**: preset ごとには分けない。display 固有の見た目は本体の
  `shell.kiosk` トグルで visual に載せる（§2 原則 1）。

## 5. 実装単位と委譲

| 単位 | 委譲先 |
| --- | --- |
| D1-a / D1-c / D1-d | sonnet（挙動不変の準備） |
| D1-b | sonnet（シェル UI + visual 1 枚） |
| D2 remover `items` / `adminPages` + `monitor` テンプレート | opus（scaffold.mjs の最大 remover、`--strict` の anchor 設計） |
| D2 検証・CI・docs | 司令塔 |

## 6. ドキュメント更新

- template-scope §2.2 / §3: items を「デモリソース（display で削除可）」に再分類。
- scaffold-presets-plan §3: display 列を追加。
- README「オプション資産の削除」: display の説明と `pnpm scaffold --preset display`。
- AGENTS.md「タスク別の入り口」: `minimal|standard|full|display`。
- conventions §13: opt-out の明記。
- CHANGELOG。
