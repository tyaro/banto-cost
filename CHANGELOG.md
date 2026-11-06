# Changelog

このリポジトリの注目すべき変更を記録する。フォーマットは
[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠する。
バージョン番号はタグ運用規約（[docs/publishing.md](docs/publishing.md)
「タグ運用規約」節）に従う。**1.0.0（安定版）以降は SemVer 準拠**
（`major` = 破壊的変更 / `minor` = 機能追加 / `patch` = 修正）。0.x 系は
`minor` = 破壊的変更 / `patch` = 追加・修正で運用していた。バージョンタグ
導入前の M0〜M9 はマイルストーン単位で、M10以降はマイルストーン + PR番号
単位で記録し、コミット単位までは分解しない。

**運用規約**:

- PR ごとに `[Unreleased]` へ変更点を1行追記する。
- リリース（バージョンタグの更新）のタイミングで `[Unreleased]`
  の内容を新しいバージョン節に切り出し、日付を入れる。
- 配布方式はgitタグ参照（npm/crates.ioレジストリへは公開しない、
  [docs/publishing.md](docs/publishing.md)）のため、Changesets 等の
  自動生成ツールは導入しない。本ファイルは手動運用を継続する
  （publishing.md「タグ運用規約」に以前あった「CHANGELOGは当面省略」の
  記述は本ファイルの新設により本節に置き換え）。

## [Unreleased]

## [6.10.0] - 2026-11-05

**v6.10.0 — グリッド・フォーム・設定画面のアクセシビリティ修正と、共通の入力スタイル（`@banto/theme` の opt-in クラス、`BantoForm` の `appearance="underline"`）の追加。** 版の種類: minor（機能追加。公開 API の削除・改名なし。挙動変更は下の「移行注意」を参照。[docs/publishing.md](docs/publishing.md)「バージョニング規約」）。
派生アプリへの影響: git 依存のタグは `v6.9.1` から `v6.10.0` に上げられるが、`BantoForm` の入力 ID・入力の既定背景・グリッドのセルエラー表示は挙動が変わるため、該当する画面の確認が要る。コピーしたテンプレートは、設定画面・ログイン・ユーザー管理・商品作成などの取り込みが任意で可能。

| 経路                             | 影響         | 内容                                                                                                                                                                      |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり         | `v6.9.1` → `v6.10.0`（npm と Rust を同じタグに）。追加 API あり、公開 API の削除・改名なし。挙動変更（入力 ID・既定背景・セルエラー・optional message）は下の「移行注意」 |
| B. コピーしたテンプレート        | あり（任意） | 設定画面・ログイン・ユーザー管理・商品作成/編集・メッセージ辞書・CSS・ファイアウォール補助プログラム（`elev`）の変更。取り込まなくても動く                                |
| C. DB・設定・配布資産            | なし         | マイグレーション、`tauri.conf.json`（版数以外）、設定キーの変更は無い                                                                                                     |

### A. 共通パッケージ・クレート

- 対象: `@banto/grid-svelte`・`@banto/forms`・`@banto/theme`・`@banto/ui`（実装変更あり）、`banto-admin-services`（`sysinfo` 0.40 対応。公開 API は不変）。他のパッケージ・クレートは版数と `svelte` の範囲（`^5.57.3`）のみ。
- 更新: `v6.9.1` → `v6.10.0`（npm と Rust を同じタグに）。
- 追加 API（いずれも任意。既定の挙動は維持）:
  - `@banto/forms`: 型 `FormAppearance`（`'default' | 'underline'`）、`BantoForm` の `appearance` プロパティ（既定 `'default'`）、8 種類の field コンポーネントの `id`・`aria-describedby`・`class` プロパティ（`id` 未指定なら従来どおり項目名）。
  - `@banto/ui`: `PageHeader` の `hideTitle`（見出しを読み上げ用に残し、表示は非表示にする）。
  - `@banto/theme/css`: opt-in クラス `.banto-field`（`-control`・`-label`・`--stacked`）、`.banto-switch-field`、`.banto-section-nav`。
  - `@banto/grid-svelte`: 任意の messages `filterAppliedDescription`・`filterOperatorLabel`・`filterValueLabel`・`inlineEditErrorLabel`・`inlineEditErrorHint`。
- 移行注意（消費側に影響する挙動変更。どれも型エラーにはならない）:
  1. **`BantoForm` 内部の入力 ID**: 入力の `id` が項目名（`def.name`）から、フォームごとに一意な生成 ID に変わる。`document.getElementById(項目名)` や `#項目名` のセレクタで入力を参照しているテストやスクリプトは、ラベル経由（`getByLabel` など）に置き換える（#498）。なお readonly のテキスト系項目は `disabled` ではなくネイティブの `readonly` になる（select・checkbox は従来どおり `disabled`）。
  2. **入力・ネイティブ select の既定背景が透明になる**: `@banto/forms` の各 field の背景が不透明な塗りから `transparent` になる。不透明な背景を前提にした画面は、親の背景との重なりで読みにくくならないか確認する（[ADR-0025](docs/adr/0025-transparent-control-backgrounds.md)、#502）。
  3. **グリッドのセルエラー**: `BantoGrid` が `.banto-grid-frame` の wrapper を持つようになり、セルエラーは表の可視範囲に収まるキーボード読み取り可能な領域で表示される。エラー中の Tab はエラー領域へ移動し（再送信しない）、再試行は Enter で行う。`.banto-grid` の直下構造やエラー中の Tab に依存する CSS・テストは見直す（[ADR-0027](docs/adr/0027-grid-error-reader.md)、#505・#507・#508）。
  4. **optional message の追加**: `@banto/grid-svelte` の messages に上記 5 件を追加した（既定の日本語文言あり。未指定でも動く）。多言語化している派生アプリは辞書に追加する（#505・#506・#508・#509）。
- 依存を上げずに留まれるか: できる（`v6.9.1` のまま使える）。

### B. コピーしたテンプレート

- 対象: `apps/admin-template/src/routes/(app)/settings/`（`+layout.svelte`・各 `*Section.svelte`・`LanReachCheckPanel.svelte`・`settings.css`）、`login/+page.svelte`、`(app)/users`・`items`・`items/new`・`items/[id]`・`audit-log`・`dashboard`・`tree`・`ui-demo`、`src/lib/`（`Header.svelte`・`navigation.ts`・`i18n.ts`）、`src/app.css`、`messages/ja.json`・`en.json`（`grid.*` の追加ほか）、`elev/src/powershell.rs`・`rules.rs`、`src-tauri/src/firewall_status.rs`、`e2e/`。
- 関連 Issue・PR: Issue #495、PR #496、#497、#499〜#511。
- 手で取り込む変更: 設定画面の下線型入力・ナビゲーション・スイッチ（[ADR-0022](docs/adr/0022-settings-controls.md)、[ADR-0023](docs/adr/0023-shared-control-styles.md)）、`BantoForm appearance="underline"`（[ADR-0024](docs/adr/0024-schema-form-appearance.md)）、透明な入力背景（ADR-0025）、共通のスイッチ・checkbox（[ADR-0026](docs/adr/0026-shared-boolean-controls.md)）、グリッドのエラー読み取り（ADR-0027）。ファイアウォール支援の段階 1 は、識別子検証・ルール名・PowerShell 変換を段階 2 の `elev` の関数に共有した（#511）。外から見える挙動は変えない。
- 派生側の独自変更と衝突しやすい箇所: 設定画面の各セクションとその CSS、ログイン画面の入力、`app.css` の入力スタイル、`elev` と `firewall_status.rs`。
- 取り込まなくても動くか: 動く（A の移行注意 1〜3 の確認は要る）。
- 手本: 上記の `apps/admin-template/` のファイル。

### C. DB・設定・配布資産

- マイグレーション: 不要。
- 設定キー・`tauri.conf.json`・配布物: 変更なし（`tauri.conf.json` は版数のみ）。
- 戻せる条件: DB・設定は変わらないため、タグを戻すだけで戻せる。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。
2. `BantoForm` の入力を ID で参照している箇所、入力の背景を前提にした画面、グリッドのセル編集エラーの表示と Enter での再試行、設定の各カテゴリの表示と保存。
3. Rust: `cargo check` / `cargo test`。

### セキュリティ

- なし。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認する。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の SHA、`workflow_dispatch`）: タグ後に確定する。
  - タグの push（`v6.10.0`）: タグ後に確定する。
  - Node.js・pnpm・Svelte・SvelteKit・Vite・Rust の版: 2 つの run の確認後に確定する。

### 変更点

- **refactor(firewall):** 段階 1（読み取り）の識別子検証・グループ名・プログラムルール名・PowerShell 単一引用符・`-EncodedCommand` 変換を、段階 2 の helper（`admin-template-fw-elev`）の関数へ一本化した。段階 1 が段階 2 のルールを見つけられる条件をコメントの約束ではなくコンパイルで保つ。移動のみで挙動・Tauri コマンド・TS 側は変えない。

- **refactor(grid):** `BantoGrid` のセルエディタ（select / checkbox / text・number・date）のテンプレートを `CellEditor.svelte` へ切り出した。DOM・属性・挙動は変えず、編集の状態遷移・キー/blur 処理・フォーカス処理は `BantoGrid` に残す。公開 API は変えない。

- **fix(grid):** 適用済みフィルタに二重下線と列固有の説明を追加。強制配色でも色以外の印を残し、ボタン幅と開閉・条件適用・フォーカス処理を維持する。説明は optional message 経由で日英へ対応（#495）。

- **fix(grid):** 長いセルエラーを表の可視範囲に収め、折返し・上下切替・領域内スクロールで全文を読めるようにした。scrollport と editor DOM を保ち、Tab でエラー参照、領域の Shift+Tab / Escape で入力へ戻る。エラー中の再試行は Enter とし、読み直しによる再送信を防ぐ。新しい wrapper とメッセージの移行注意を記載（#495、ADR-0027）。

- **fix(grid):** セル編集で変換中（`isComposing` / `keyCode 229`）・処理済みのキーによる保存・取消・移動を防ぐ。フィルタの Enter / Escape にも229互換判定を追加。通常キーと pending 抑止・blur 確定・編集セッションは維持する（#495）。

- **fix(grid):** フィルタの条件・値へ個別の名前を追加し、展開状態・dialog 参照・開閉フォーカスを整えた。同じボタンで閉じ、内部の Escape・適用・クリア後は元へ戻り、外クリックではフォーカスを奪わない。グリッド・見出し・フィルタに実線フォーカス、強制配色の選択範囲に破線枠を追加（#495）。
- **fix(grid):** 数値フィルタを空にして適用すると `NaN` の条件が残る不具合を修正。数値の `0` は維持し、空欄は既存の仕様どおり条件解除として扱う。

- **fix(grid):** セル editor の入力名・検証状態・エラー関連付けを追加し、保存待ちを編集中セルの `aria-busy` で示す。エラー ID はグリッドごとに一意とし、checkbox editor の寸法を共通トークンへ揃えた。編集・保存・選択・フォーカス処理は維持する（#495）。

- **feat(theme):** 設定のスイッチを theme CSS の opt-in class に共通化。native 状態・ラベル・Space 操作を保ち、forced-colors でもトラック・丸・フォーカスを識別できるようにした（#495、ADR-0026）。
- **style(forms):** フォームと列表示メニューの native checkbox の寸法・実線フォーカス・無効状態を統一。最後の表示列のロックや readonly の扱いは維持する。
- **fix(ui):** 設定全カテゴリの320px・文字200%表示に対応。カード幅、ボタン高さ、長いラベル、QR、ファイアウォール情報の折返しとヘッダーの省略表示を調整。列表示メニューが表ヘッダーの背面へ隠れる問題も修正した。

- **fix(settings):** 現在のパスワードだけが入力・自動入力された場合に未保存の変更と表示しない。新パスワードまたは確認欄の入力を未保存として保護し、失敗・破棄・保存中のガードは維持する。

- **style(ui):** シェル内のページは内容側の重複タイトルを非表示にする。`PageHeader hideTitle` で読み上げ用の見出しと説明・操作を残し、商品作成・編集のタイトルはシェルへ表示する。部品単独の既定表示は維持する。

- **style(forms):** 入力・ネイティブ select の既定背景を透明にし、hover / readonly でも塗りを加えない。共通下線型、`appearance="default"`、各 field の直接利用、従来の `.banto-input` が対象。枠・下線・フォーカス・文字色・無効状態の減光や破線は維持する（#495、ADR-0025）。

- **feat(forms):** `BantoForm` に任意の `appearance="underline"` を追加し、対応版 theme の共通スタイルを商品・ユーザー管理のフォームで採用した。ラベルは上に固定し、checkbox と既定表示は維持する。各 field の `class` 転送、固定ラベルでの date / textarea 対応も追加。値・検証・送信・エラー関連付けは変わらない（#495、ADR-0024）。

- **refactor(login):** ログイン・初回セットアップの入力を theme の共通スタイルへ移行し、長いパスワード項目名は入力の上に表示する。フォーム全体のエラーを alert として通知し、認証処理・自動入力用属性・LAN のログイン保持条件は維持する（#495）。

- **refactor(theme):** 設定で採用した下線型入力・浮動ラベル・ページナビを `@banto/theme/css` の opt-in クラスとして共有し、設定画面を移行した。app.css / Tailwind なしでも利用でき、長いラベルには通常フローで上に表示する形式を用意した。既存フォームの既定表示・SCADA 側の採用範囲は維持する（#495、ADR-0023）。

- **fix(forms):** `BantoForm` のラベル・入力・エラーをフォームごとに一意な ID で関連付けた。内部の入力 ID は項目名から生成 ID に変わるため、DOM 参照はラベル経由へ移行する。各 field の直接利用では既定 ID を維持し、任意の `id`・`aria-describedby` を追加した。テキスト系の readonly を disabled から分離し、読み取り専用欄の blur や数値ドラフトの確定が状態を変えないようにした。select / checkbox の disabled 表示と、readonly 値の検証・送信は維持する。forced-colors でもフォーカス枠が残るようにした（#495）。

- **chore(deps):** Svelte・Paraglide・Lucide・typescript-eslint を更新し、外部利用 fixture の Svelte 範囲と lockfile を管理アプリに揃えた（#494）。
- **chore(deps):** `uuid` を 1.28.0 から 1.29.0 に更新した（#492）。
- **ci:** `taiki-e/install-action` を 2.88.0 のコミット SHA に更新した（#491）。

- **ui:** 設定カテゴリの下線型ナビゲーションと、移動型ラベル・下線付きのテキスト系入力およびネイティブ select を設定画面の正式デザインとして採用した（#495、[ADR-0022](docs/adr/0022-settings-controls.md)）。
- **ui:** 設定画面でヘッダーと重複していた内容側のタイトルを非表示にし、説明文とカテゴリナビゲーションから始まる構成にした。読み上げ用のページ見出しは維持した。

- **chore(deps):** `sysinfo` を 0.39.6 から 0.40.1 に更新し、初期化 API の `Result` 化に対応した。初期化できない場合はアプリの起動を止めず、従来の `metrics: null` に退避する。公開 API、CPU の更新間隔、`system` feature 限定を維持する（#493）。

## [6.9.1] - 2026-10-26

**v6.9.1 — RustSec の依存監査で検出された `ctutils` の脆弱性を修正し、既存の Dependabot 更新を取り込む。** 版の種類: patch（公開 API・アプリの機能・DB スキーマの変更なし。後方互換）。
派生アプリへの影響: git 依存のタグを `v6.9.0` から `v6.9.1` に上げられる。テンプレートをコピーして使う場合、依存と CI の更新は必要に応じて取り込む。

| 経路                             | 影響         | 内容                                                                                                                        |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり（任意） | npm と Rust の git 依存を同じ `v6.9.1` タグへ更新できる。公開 API は変わらない                                              |
| B. コピーしたテンプレート        | あり（任意） | `Cargo.lock`・`pnpm-lock.yaml`・Vite の範囲指定・GitHub Actions の更新を取り込める。`Cargo.lock` の更新は脆弱性の修正に必要 |
| C. DB・設定・配布資産            | なし         | マイグレーション、設定キー、配布形式の変更は無い                                                                            |

### 変更点

- **security:** `ctutils` 0.4.2 → 0.4.4。`digest` 0.11.3 を経由する依存に対し、[RUSTSEC-2026-0385](https://rustsec.org/advisories/RUSTSEC-2026-0385) の修正を `Cargo.lock` に取り込んだ（#487、#488、#489）。
- **chore(deps):** npm の minor/patch グループ（Vite 8.3.5 など）と Cargo の minor/patch グループ（Tokio、Tauri など）を更新した。外部 consumer fixture の Vite 範囲と lockfile も管理アプリと一致させた（#488、#489）。
- **ci:** `Swatinem/rust-cache` と `taiki-e/install-action` を更新した（#487）。

### 消費側への注意

- 公開 API・DB スキーマ・設定キーの変更は無い。git 依存を使う派生アプリは、更新する場合に npm と Rust のタグを一緒に `v6.9.1` へ上げる。
- テンプレートをコピーした派生アプリには、今回の lockfile と CI の更新を必要に応じて取り込む。特に `Cargo.lock` の `ctutils` 0.4.4 は依存監査の修正に必要。

## [6.9.0] - 2026-10-22

**v6.9.0 — LAN 公開のファイアウォール支援（#219。状態の確認・別の端末からの到達確認・昇格の補助プログラムによる許可と解除）と、Windows のインストーラの既定を perMachine にして補助プログラムを同梱。** 版の種類: minor（機能追加。後方互換。公開 API の削除・改名なし）。
中身は 3 つ: (1) ファイアウォール支援の段階 1（設定 > サーバ・接続の情報・「Windows ファイアウォールの状態」・「別の端末からの接続確認」。#459 ほか）、(2) 段階 2（昇格の補助プログラム `admin-template-fw-elev` による「ファイアウォールで許可する」「許可を外す」。[ADR-0021](docs/adr/0021-firewall-elevated-helper.md)）と、そのための **Windows のインストーラの既定の perMachine 化・補助プログラムの同梱**、(3) 配布用ビルドへの LAN の Web UI の埋め込み（`tauri:build:windows` に `--features embed-ui`、#478）と、適用状態・Program Files の外のコピーの表示の見直し（#479〜#482）。
派生アプリへの影響: タグを上げるだけで動く（経路 A は追加のみ）。ただしテンプレートを写している派生アプリは、**インストーラの既定が perMachine になり補助プログラムを同梱した**ので、コピー部分（`tauri.conf.json`・`src-tauri/tauri.fw-elev.conf.json`・`scripts/build-fw-elev.mjs`・`apps/admin-template/elev`・NSIS のフック・設定画面ほか）の取り込みが要る。取り込まなければ従来どおり動くが、ファイアウォール支援は使えない。手順と既存の per-user のインストールからの移り方は [docs/upgrading.md §4.1](docs/upgrading.md#41-windows-のインストール形態が-permachine-に変わる219-段階-2)。

| 経路                             | 影響         | 内容                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり（任意） | `v6.8.0` → `v6.9.0`（npm と Rust を同じタグに）。追加のみ: `banto-server` の `reach_check` モジュール（到達確認の保管所と口）・`bind_without_fallback`、`@banto/theme` の寸法トークン（`--banto-space-*`・`--banto-font-size-*`・`--banto-border-width*`）。既存の API・挙動は変わらない                                                                |
| B. コピーしたテンプレート        | あり（任意） | ファイアウォール支援の設定画面・Tauri コマンド（`firewall_rule_status`・`firewall_rule_change`・`reach_check_*`）・`/reach` ページ・`apps/admin-template/elev`・`tauri.conf.json` の `installMode: "perMachine"`・`tauri.fw-elev.conf.json`・`scripts/build-fw-elev.mjs`・`windows/fw-elev-hooks.nsh`・`server_status` の項目追加。取り込まなくても動く |
| C. DB・設定・配布資産            | あり（配布） | DB のマイグレーションは無い。インストーラの既定が perMachine に変わる（インストール先が Program Files、インストール時に UAC。データは `%APPDATA%\<identifier>\` のまま）。配布用ビルドは `tauri:build:windows`（NSIS のみ）                                                                                                                             |

### A. 共通パッケージ・クレート

- 対象: `banto-server`（`reach_check` の追加・`bind_without_fallback` の追加）、`@banto/theme`（寸法トークンの追加）。他は版数のみ。
- 更新: `v6.8.0` → `v6.9.0`（npm と Rust を同じタグに）。
- 追従: なし（追加のみ。削除・改名した API は無い）。`reach_check_router` はテンプレートの Tauri 組み込みサーバーにだけ載せる（`banto-serve` には載せない）。
- 依存を上げずに留まれるか: できる。

### B. コピーしたテンプレート

- 対象: `apps/admin-template/` の設定 > サーバ・接続（ファイアウォールの情報・状態・許可と解除・別の端末からの接続確認）、`/reach`、`src-tauri`（コマンド・昇格の起動のモジュール・`tauri.conf.json`・`tauri.fw-elev.conf.json`・`windows/fw-elev-hooks.nsh`）、`elev`（`admin-template-fw-elev`）、`scripts/build-fw-elev.mjs`・`scripts/rename.mjs`、CI の該当ジョブ。
- 関連 PR: #219 の各 PR（段階 1 の PR-A・PR-B・PR-C1〜C3、段階 2 の E1〜E4）、#459、#478、#481、#482。
- 手で取り込む変更: 手順は [docs/upgrading.md §4.1](docs/upgrading.md#41-windows-のインストール形態が-permachine-に変わる219-段階-2)。配布用ビルドは `pnpm --filter <app> tauri:build:windows` に切り替え、`server_status` の必須項目 `uiEmbedded` を画面側が読むようにする。
- 派生側の独自変更と衝突しやすい箇所: 設定 > サーバ・接続の画面、`tauri.conf.json` の `bundle`、インストーラの独自のフック。
- 取り込まなくても動くか: 動く（ファイアウォール支援が無いだけ）。ただしインストール形態を変えないなら per-user のままになり、段階 2 は使えない。
- 手本: `apps/admin-template/` の上記ファイル。

### C. DB・設定・配布資産

- マイグレーション: 不要。
- 戻せる条件: DB・設定は変わらない。インストール形態の移り方・戻し方は upgrading.md §4.1。
- 設定キー・`tauri.conf.json`・配布物: `bundle.windows.nsis.installMode` が `"perMachine"`、補助プログラムが本体 exe の隣に入る。`settings_set` は `server.` で始まるキーを拒否する（書き込みは `server_apply` だけ）。
- 順序: A・B を先に完成 → 検証用の環境でインストール・アンインストール（UAC とルールの解除を含む）→ 配布。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。
2. 設定 > サーバ・接続の表示、「ファイアウォールで許可する」「許可を外す」、別の端末からの接続確認、perMachine のインストーラのインストール・アンインストール。
3. Rust: `cargo check` / `cargo test`。

### セキュリティ

- なし。昇格の補助プログラムは本体 exe の隣の固定名だけを起動し、Program Files の外のコピーでは UAC を出さずに止める（[ADR-0021](docs/adr/0021-firewall-elevated-helper.md)）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `1bd12fe`、`workflow_dispatch`）: [run 39761779831](https://github.com/tyaro/banto/actions/runs/39761779831)（success）。
  - タグの push（`v6.9.0`、main の `1bd12fe`）: [run 39762214432](https://github.com/tyaro/banto/actions/runs/39762214432)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。Node.js はジョブで違う（`node-version: 24` で最新の 24.x を引くため）: npm のジョブが 24.21.0、diagnostic のジョブが 24.22.0。

    | 項目               | 版                                 |
    | ------------------ | ---------------------------------- |
    | Node.js            | 24.21.0（diagnostic のみ 24.22.0） |
    | pnpm               | 10.33.0                            |
    | Svelte             | 5.57.2                             |
    | SvelteKit          | 3.1.0                              |
    | Vite               | 8.3.4                              |
    | vite-plugin-svelte | 7.3.1                              |
    | TypeScript         | 6.0.3                              |
    | Rust               | 1.99.1（58cf8f9c3 2026-10-13）     |

  - 出所: Node.js は `node: v24.21.0`・`node: v24.22.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.2` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.1`。

### Added

- 設定 > サーバ・接続に「ファイアウォールの許可に必要な情報」を追加した（#219 段階 1 の PR-A、Windows のみ・昇格なし）。稼働中のサーバーの値（`live`）から、実行ファイルの絶対パス・受信・TCP・待ち受け中のポート・プライベート・LocalSubnet を表示・コピーでき、管理者向けの `New-NetFirewallRule`（実行ファイル単位とポート単位の 2 形。ルール名は Tauri の `identifier`、文字列は単一引用符のリテラルにエスケープ）をコピーできる。同じ名前のルールが既にあるときは、コマンドは何も変えずに警告を出して止まる（既存のルールを消したり書き換えたりしない）。コピーの直前に状態を読み直し、適用や新しい読み直しの後に届いた古い応答は表示にもコピーにも使わない。停止中・loopback のみのときは不要と表示する。`server_status`（admin 専用）に省略可能な項目 `executablePath`・`platform` を足した（REST は変更なし）。
- 設定 > サーバ・接続のファイアウォールの欄に「Windows ファイアウォールの状態」を追加した（#219 段階 1 の PR-B、Windows のみ・昇格なし・読み取りだけ）。決まった名前のルール（`<identifier>.lan.tcp.program` / `.port`）ごとに「ルール無し」「あり（期待どおり）」「あり（期待と違う: 項目と値）」「確認できない（理由）」を出し、ルールがあることと LAN から接続できることは別だと明記する。新しい Tauri コマンド `firewall_rule_status`（admin 専用・読み取り・REST なし）は、Windows PowerShell に固定のスクリプトを `-EncodedCommand` で渡して読み、同じ `server_status` の snapshot（`generation`）の実行ファイル・待ち受け中のポートと照合する。照合するのは ActiveStore のその名前のルールで、`EnforcementStatus` が `Full` のときだけ「適用されている」とし、ほかの値は「存在するが適用されていない（理由）」、読めない・未知の値は「適用状態は不明」と分ける。出どころは `-TracePolicyStore` で読み、種別（グループポリシー・MDM・Dynamic など）ごとに添え、取れなければ「出どころ不明」とする。ローカルのルールが無い・値が違うときもそれを添える。コマンドが無い・読み込めないときは「ルール無し」ではなく「確認できない」にする。古い応答や、失敗した再確認の前の結果は表示しない。
- 別の端末からの接続確認（LAN の到達確認）の保管所と口を `banto-server` に追加した（#219 段階 1 の PR-C1、UI なし）。新しいモジュール `reach_check`（`ReachCheckState`・`reach_check_router` ほか、公開 API は追加のみ）は、管理者の画面が発行する使い捨てのトークン（`uuid` v4・期限 5 分・1 回限り・同時に 1 つ・定数時間の比較・待受の世代と `Host` に結び付け）を照合し、別の端末から届いたことをメモリにだけ記録する。未認証の口 `POST /api/reach-check` はセッションを発行せず `{ "result": "<コード>" }` だけを返し、接続元はソケットの値だけで判定し（`X-Forwarded-For` は読まない）、このPC自身（loopback・自分のアドレス）は記録も消費もせず、失敗した照合は接続元 IP ごとに回数制限する（1 分 10 回で 429）。発行も到達も監査しない。テンプレートの Tauri 組み込みサーバーにだけ載せる（`banto-serve` には載せない）。発行のコマンドと画面は後続（PR-C2・PR-C3）で、それまでこの口は常に `unusable` を返す。派生アプリへの影響: 追加のみ（既存の API・挙動は変わらない）。
- 到達確認の Tauri コマンドを追加した（#219 段階 1 の PR-C2、画面は後続の PR-C3）。`reach_check_issue({ host })`（admin 専用・desktop-only・REST なし）は、稼働中の listener の loopback 以外の URL の host に対してトークンを発行し、`{ status: "issued", generation, issueId, url, qrSvg, expiresInMs }`（トークンは `url` の `#t=` の後ろだけ）を返す。発行しないとき（停止中・loopback のみ・IPv6 などの bind・候補に無い host・世代の不一致・自分のアドレスを列挙できない）は `{ status: "refused", generation, reason }` のコードを返す。`reach_check_status()`（admin 専用・読み取り）は最後の発行・このPC自身からのアクセス・別の端末からの記録を返す。`server_apply` は世代を進めるとき（成功時も、適用に失敗して元の listener を戻すときも）同じロックの中で保管所の世代も進め、発行済みのトークンと記録を捨てる。発行も到達も監査しない。
- 設定 > サーバ・接続に「別の端末からの接続確認」の欄と、端末側のページ `/reach` を追加した（#219 段階 1 の PR-C3。ファイアウォールの欄とは別の欄で、Windows 以外でも出る）。稼働中の待受の LAN の URL の候補から選んで確認用の URL と QR を発行し、確認待ちの間だけ 2 秒おきに `reach_check_status` を読み直して、未確認・確認待ち（残り時間）・このPC自身・確認済み（時刻・接続元 IP・使った URL と「その時点・その端末」の注記）・古い（1 時間）・期限切れ（届かないとは断定せず、ネットワーク・ファイアウォール・ベンダー製品・AP の端末間の分離を案内）・読めない（「未確認」にしない）を出し分ける。古い応答や別の世代の応答は出さず、待受が変わったら表示を捨てて読み直す。`/reach` は `(app)` の外（認証の guard の外）で、`#t=` のトークンを読んだらすぐ `history.replaceState` で URL から消し、`X-Banto-Client` 付きの `POST /api/reach-check` の結果コードだけを短い文言（en / ja）で出す。ログイン・セッションは作らない。手順と保証すること・しないことは `docs/recipes/lan-access.md`。
- `@banto/theme` に汎用の寸法トークンを追加した（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) の PR-1、追加のみ・後方互換）。余白の段階 `--banto-space-1`〜`-8`、文字サイズの段階 `--banto-font-size-xs`/`sm`/`md`/`lg`/`xl`（本文は root の `1rem` を継承）、枠線幅 `--banto-border-width`（1px）/`--banto-border-width-strong`（2px）。密度では切り替えない。消費側はまだ使っておらず画面は変わらない。conventions §9 に「寸法」の範囲と例外を明記した。
- ファイアウォールの許可を昇格して行う補助プログラムの crate `apps/admin-template/elev`（`admin-template-fw-elev`、bin + lib）を追加した（#219 段階 2 の E1、[ADR-0021](docs/adr/0021-firewall-elevated-helper.md)。まだどこからも起動されず、画面・インストーラは変わらない）。受ける引数は操作名 1 つ（`firewall-allow` / `firewall-remove` / `firewall-status`）だけで、終了コード 0/1/2/3/4/5/64 で結果を返す。identifier はビルド時の定数（`tauri.conf.json` と一致をテストで確かめる）、ルールは本体 exe 単位の 1 本（受信・許可・TCP・ポート指定なし・Private・LocalSubnet）で、同じ名前でも中身が一つでも違えば「競合」として変えない。helper と隣の本体 exe とそこから Program Files（既知のフォルダ）までの各フォルダを、ハンドルを開いてから所有者・書き込み系の ACE・reparse point で検査し、通らなければ何もせず「前提が無い」で止まる（この判定は lib の純関数で、本体の昇格前の検査からも使う）。ファイアウォールの操作は System32 の Windows PowerShell に固定のスクリプトを `-EncodedCommand` で渡し、環境を作り直して行う。`requireAdministrator` のマニフェストは bin にだけ埋め込む。依存は `windows-sys`・`embed-resource` を直接の依存に足した（どちらも `Cargo.lock` に既にある版で、ビルドに入る crate は増えない）。CI の rust ジョブ（ubuntu / windows）の check・clippy・test の対象にこの crate を足した。
- 昇格の起動のモジュールと Tauri のコマンド `firewall_rule_change({ operation: "allow" | "remove", target: { executablePath, generation } })` を追加した（#219 段階 2 の E2、[ADR-0021](docs/adr/0021-firewall-elevated-helper.md)。画面は後続の E3）。admin 専用・desktop-only・REST なし。昇格を求める前に helper の lib と同じ配置の判定（`placement::check_placement`）を本体側でも行い、通らなければ helper を起動せず UAC も出さずに「前提が無い」を返す。確認画面に出した対象（本体 exe のパスとサーバーの generation）を起動の直前と helper の終了後に照合し、起動前に違えば起動せず再確認を求め（`targetChanged`）、終了後に違えば `stale` にする。UAC の待ちの間はロックを持たない。helper は本体 exe の隣の固定名だけを `ShellExecuteExW` の `runas` で起動し（banto-industrial の `launch.rs` を還元）、UAC の取消（1223）・終了コードを結果のコードにし、どの結果でも段階 1 の読み取りで読み直して返す（終了コード 0 は `done` で、「接続できる」とは言わない）。監査の action `firewall_change`（resource `firewall`）を新設し、成功・失敗・UAC の取消を記録する（監査ログの画面の表示名も追加）。`src-tauri` の依存に helper の lib と `windows-sys`（`Cargo.lock` に既にある 0.61.2、起動のモジュール用の feature だけ）を足した。
- 設定 > サーバ・接続の「Windows ファイアウォールの状態」に、段階 2 の「ファイアウォールで許可する」「許可を外す」を追加した（#219 段階 2 の E3、[ADR-0021](docs/adr/0021-firewall-elevated-helper.md)。admin・デスクトップのみ）。ルールが無ければ許可、あれば解除、状態を読めなければ両方を出す。押すと確認画面に決定 1 の 2 文（全 TCP ポートをプライベート ネットワークから許可する／ローカル サブネットは複数のアダプター・VPN のサブネットを含みうる）、対象の実行ファイルとルール名、この後に UAC が出ることを出し、承認で表示していた `expected.executablePath` と `generation` を付けて `firewall_rule_change` を呼ぶ。待っている間はボタンを止めて UAC 待ちと表示し、結果のコードごとの文言（en / ja）と、結果に付いて返る読み直しで状態の表示を更新する。完了でも「接続できる」とは言わず、到達確認へ案内する。前提が無いときは理由と段階 1 のコマンドへ案内する。

### Changed

- **Windows のインストーラの既定を perMachine にし、ファイアウォールの helper を同梱した**（#219 段階 2 の E4、[ADR-0021](docs/adr/0021-firewall-elevated-helper.md) 決定 2・3・7・8）。`tauri.conf.json` の `bundle.windows.nsis.installMode` を `"perMachine"` にしたので、インストール先が Program Files に変わり、インストール時に UAC が出る（データは `%APPDATA%\<identifier>\` のまま）。インストーラは `pnpm --filter admin-template tauri:build:windows`（`tauri build --config src-tauri/tauri.fw-elev.conf.json`）で作る: その `beforeBuildCommand` が `scripts/build-fw-elev.mjs` で helper を先にビルドし、Tauri の `externalBin` として本体 exe の隣に `admin-template-fw-elev.exe` の固定名で置く（素の `tauri build`・`tauri dev`・`cargo check` は helper を要求しない）。この設定は `bundle.targets` を `["nsis"]` に絞る: ルールを外すアンインストールのフックは NSIS にしか無く、MSI ではアンインストール後もルールが残るので、段階 2 では MSI に対応しない。NSIS の PREUNINSTALL のフック（`src-tauri/windows/fw-elev-hooks.nsh`）が所有するルールだけを外し（フックは先に Tauri の「アプリが動いていれば閉じる」確認を行うので、そこで取り消してもルールは残る。起動するのはインストール先の helper ではなく、ビルド時にアンインストーラへ埋め込んで `$PLUGINSDIR` に展開した写しで、helper に足した `firewall-remove-installed <インストール先>` で Program Files の下の本体 exe の自分のルールだけを外す。インストール先の helper の exe だけが一般利用者に書き換えられる場合に、それを管理者として動かさないため）、外せなくてもアンインストールは止めずにルール名（`<identifier>.lan.tcp.program`）と手で外す方法を表示する（インストール時にはルールを作らない。Tauri の更新ではルールを残す）。`scripts/rename.mjs` が helper の `IDENTIFIER` を `--identifier` に追随させるようにした。CI: tauri-check（Windows）で helper を externalBin の場所へ置いてその設定で `cargo check`、template-acceptance でリネーム後の helper のテストを回す。**派生アプリへの影響**: 既存の per-user のインストールからの移り方、portable・per-user では段階 2 が使えず段階 1 の案内になることは [docs/upgrading.md §4.1](docs/upgrading.md#41-windows-のインストール形態が-permachine-に変わる219-段階-2)。
- 設定 > サーバ・接続の「Windows ファイアウォールの状態」で、ルールの中身が一致して適用状態（`EnforcementStatus`）だけが `Full` でないとき（例: 他社ファイアウォールが有効で `CategoryOff`）、「違う項目」ではなく「あり（内容は期待どおり。ただし Windows ファイアウォールとしては適用されていません）」の見出しを出すようにした（#481、#479）。`CategoryOff` のときは接続確認へ案内する。見出しは警告の色にした（#484）。
- Program Files の外のコピー（per-user・ポータブル・移動したコピー）で「ファイアウォールで許可する」を押したとき、拒否の理由を「補助プログラムが無い」ではなく「Program Files の下にない」にした（#482、#480）。UAC を出さずに止める判断は変わらない。

### Fixed

- **配布用の Windows ビルド（`pnpm --filter admin-template tauri:build:windows`）に LAN 向けの Web UI が入らなかったのを直した**（#478）。`--features embed-ui` を付けたので、別端末が `http://<PC>:<port>/` を開くと実際の画面が出る。`server_status` に `uiEmbedded`（必須）を足し、UI が埋め込まれていないビルド（素の `tauri build`・`tauri dev`）では設定画面が URL・QR・「別の端末からの接続確認」を出さず、確認できない旨だけを出す。
- 内蔵サーバー（LAN アクセス）の `server_status` が、保存した設定と稼働中のサーバーの値を混ぜて返し得たのを直した（#459、#219 の監査）。汎用の `settings_set` は `server.` で始まるキーを拒否し（書き込みは `server_apply` だけ）、status は保存値（`enabled`・`bind`・`port`・`viewerPublic`、フォームの初期値）と、実際の listener の値（`live` の bind・port、`urls`・`qrSvgs`）を同じロックの中で読んだ 1 つの snapshot として返す。新しい省略可能な項目 `generation`（適用のたびに変わる）・`applyFailure`（ポート使用中・bind の失敗・保存の失敗と、元のサーバーを戻せたか）を足した。`server_apply` の失敗時は、保存値ではなく稼働していた listener のアドレスとポートで戻す。`banto-server` に、ポート使用中をほかの失敗と分けて返す `bind_without_fallback` を追加（追加のみ）。

## [6.8.0] - 2026-10-21

**v6.8.0 — サイドバーの代わりに選べるドック（ランチャー）、temp-scada からの共有部品の還元、シェルと設定の UI の見直し。** 版の種類: minor（機能追加。後方互換。公開 API の削除・改名なし）。
中身は 3 つ: (1) ドック（ランチャー。画面の上下左右に置ける。#421〜#431・#456）、(2) 共有部品の還元（#432〜#438 の計画。`@banto/admin-core` の `createRequestOwner`・`createSavedSetting`、`@banto/dock-svelte` の表示用の補正・`capabilities`・pane の lifecycle・キーボード操作と hook、`@banto/forms` の `FormDraft` / `DraftCoordinator`、`@banto/ui` のショートカットの dispatcher・操作の持ち主の整理、新しいオプションのパッケージ `@banto/image-assets`。#439〜#454）、(3) シェルと設定の UI の変更（設定のカテゴリを内容の上へ #455、サイドバーの折りたたみボタンをロゴの左へ #457、配色モードの切替をヘッダーへ #458）と、内蔵サーバーの起動時のポートの自動選択（#460）。
派生アプリへの影響: タグを上げるだけで動く。ただし `@banto/dock-svelte` の挙動の変化（下の「消費側への注意」）を確かめる。新しい部品・ドック・UI の変更は、使うとき・写すときだけ取り込む（取り込みの組み立ては [docs/upgrading.md](docs/upgrading.md) の例 5）。

| 経路                             | 影響         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 依存（`@banto/*`・`banto-*`） | あり（確認） | `v6.7.2` → `v6.8.0`（npm と Rust を同じタグに）。追加のみ: `@banto/ui` の `LauncherBar`・`magnifyScale`・`CommandSpec`・`createShortcutDispatcher` など（#423・#426・#456・#444）、`@banto/theme` の `--banto-shell-launcher-*`・`--banto-z-launcher` などのトークン、`@banto/admin-core` の `createRequestOwner`・`createSavedSetting`（#441・#442）、`@banto/forms` の `createFormDraft`・`createDraftCoordinator`・`DraftNumberField`（#447）、`@banto/dock-svelte` の `clamp`・`capabilities`・`beforePanelChange`・`keepMounted`・キーボード操作（#443・#446・#448）、`banto-server` の `bind_with_port_fallback`・`PortFallbackError`・`PORT_FALLBACK_SPAN`（#460）。新しいオプションのパッケージ `@banto/image-assets`（#451〜#453。使うアプリだけ依存に足し、`optimizeDeps.exclude` に加える）。**`@banto/dock-svelte` は挙動が変わる箇所がある**（復元 layout の検証と `hydrate` の戻り値 #440、操作の確定 / 取消 #445、IME 変換中の構造変更の保留 #448） |
| B. コピーしたテンプレート        | あり（任意） | 取り込まなくても動く。写すなら: ドック（`ShellLauncher.svelte`・設定ストアの `shell.navLayout` / `shell.launcherOpacity` / `shell.launcherPosition`・外観設定の「ナビゲーション」カード・`(app)/+layout.svelte` と Header。#424・#426・#456）、ダッシュボードのメモ pane の draft 化（#449）、Ctrl+K / Ctrl+S の shortcut dispatcher への配線（`#lib/shortcuts.ts`、#450）、設定のカテゴリの横並び（#455）、ロゴの左の折りたたみボタン（#457）、ヘッダーの配色の切替と外観設定の配色カードの撤去（#458）、起動時のポートの自動選択（`src-tauri/src/lib.rs`・`serverPortNotice.ts`、#460）。それぞれ文言キーの追加・削除を伴う                                                                                                                                                                                                                                                                                                                                      |
| C. DB・設定・配布資産            | なし         | DB のマイグレーションは無い。ユーザーごとの設定キー（`shell.*`・`dashboard.memo`）の追加のみで、未保存のユーザーは既定（サイドバー・静的なメモ）。#460 を取り込んだアプリは、保存したポートが使用中のとき起動時に選んだポートを `server.port` に保存する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 消費側への注意

- 既定のナビゲーションは `NAV_LAYOUT_DEFAULT = 'sidebar'` のままで、ドックを選ばなければ見た目は変わらない。ドックを取り込む派生アプリは `@banto/ui`・`@banto/theme` を v6.8.0 にそろえること（`LauncherBar` とトークンが無いと動かない）。
- **`@banto/dock-svelte` の復元 layout の検証**（#440）: `DockState` の `hydrate` と constructor の初期値が、不正な layout（重複 ID・`x=1e999`・`width=-1`・`height=0` など）を拒否して現行 layout を変えない（constructor は空の layout で始める）。従来は通っていた壊れた保存データが読めなくなる（正常な v1 / v2 は従来どおり）。`hydrate` の戻り値が `void` → `boolean`（採用されたか）。戻り値を使わない呼び出しはそのまま動く。
- **`@banto/dock-svelte` の操作の確定と取消**（#445）: ドラッグは、操作を始めた pointer の `pointerup` でだけ確定する。resize・divider も Esc・`pointercancel`・`lostpointercapture`・window の `blur` などで取り消される（取消は対象の window / split だけを戻す）。これらのイベントに依存した独自の操作やテストは見直す。
- **`@banto/dock-svelte` の IME 変換中の構造変更の保留**（#448）: props を渡さなくても、`DockHost` は IME 変換中にドラッグを始めず、dock / undock / タブの切り替えなどの構造変更を `compositionend` まで保留する（見た目は変わらない）。
- `@banto/image-assets` は `.svelte.ts` を含むので、使うアプリは `vite.config.ts` の `optimizeDeps.exclude` に加える（足さないと dev が 500 になる。`pnpm build` / `pnpm check` では気づけない）。
- テンプレートを写すアプリ向け: 配色モード（ライト / ダーク / システム）のカードを外観設定から外し、ヘッダーの太陽 / 月のボタンにした（#458。保存値の形は変えない。文言キー `settings.modeLight` / `modeDark` / `modeSystem` を消し、`shell.switchToDarkMode` / `shell.switchToLightMode` を足した）。設定のカテゴリの切替は内容の上の横並びに、サイドバーの折りたたみボタンはロゴの左に移った（#455・#457）。visual の基準画像を持つ派生アプリは再生成が要る。
- テンプレートを写すアプリ向け: 内蔵サーバーを起動時に自動で始めるとき、保存したポートが使用中なら +1〜+19 の範囲の空きポートで起動し、そのポートを `server.port` に保存して管理者にトーストで知らせる（監査は `settings_change`、`detail.reason: "portInUse"`）（#460）。固定のポートを前提にした運用（ファイアウォールの許可・ブックマーク）は見直す。設定画面の「保存して適用」は従来どおり自動で選ばない。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: 今回はタグを打つ前の main の SHA での `workflow_dispatch` はしていない。代わりにリリース PR の head の `pull_request` の run と、タグの push の run で `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - リリース PR の head（`release/v6.8.0` の `35134f5`、`pull_request`）: [run 39587964047](https://github.com/tyaro/banto/actions/runs/39587964047)（success）。
  - タグの push（`v6.8.0`、main の `85cb860`）: [run 39588604443](https://github.com/tyaro/banto/actions/runs/39588604443)（success）。
  - 2 つの run の版は、Node.js 以外は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。Node.js は run とジョブで違う（`node-version: 24` で最新の 24.x を引くため）: リリース PR の run は 2 ジョブとも 24.21.0、タグの push の run は npm のジョブが 24.21.0、diagnostic のジョブが 24.22.0。

    | 項目               | 版                                        |
    | ------------------ | ----------------------------------------- |
    | Node.js            | 24.21.0（タグの diagnostic のみ 24.22.0） |
    | pnpm               | 10.33.0                                   |
    | Svelte             | 5.57.2                                    |
    | SvelteKit          | 3.1.0                                     |
    | Vite               | 8.3.4                                     |
    | vite-plugin-svelte | 7.3.1                                     |
    | TypeScript         | 6.0.3                                     |
    | Rust               | 1.99.1（58cf8f9c3 2026-10-13）            |

  - 出所: Node.js は `node: v24.21.0`・`node: v24.22.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.2` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.1`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### Added

- `@banto/ui` にドック風のランチャー `LauncherBar`（グループごとの `<nav>`・近いアイコンほど大きくなる拡大・Esc で閉じるツールチップ・900px 以下のタブバー）と `magnifyScale` / `LauncherItem` などの型を追加し、`@banto/theme` に `--banto-shell-launcher-*`・`--banto-z-launcher` のトークンを追加した（シェルへの配線は次の PR。nav-launcher-plan.md PR-2、ADR-0018 §11）（#423）。
- 設定の「外観」に「ナビゲーション」カードを追加し、サイドバーの代わりに画面下のドック（`LauncherBar` を配線した `ShellLauncher`）を選べるようにした。ユーザーごとに保存し（`shell.navLayout` / `shell.launcherOpacity`、未保存のユーザーは既定のサイドバー）、ドックの不透明度をスライダー（40〜100%）とプレビューで調整できる。既定は `NAV_LAYOUT_DEFAULT = 'sidebar'`。ドック表示中はトーストをバーの上に上げる（`@banto/theme` に `--banto-shell-launcher-tabbar-reserve` を追加）（nav-launcher-plan.md PR-3）（#424）。
- ドックを画面の左右にも置けるようにした（`LauncherBar` の `position` に `'left' | 'right'`、設定の「ドックの位置」下 / 左 / 右、`shell.launcherPosition`。900px 以下はどの位置でも下端のタブバー。`@banto/theme` に `--banto-shell-launcher-tooltip-max-width` を追加）。あわせて、ダッシュボードの浮き窓（`role="dialog"`）が出ているとツールチップが Esc で閉じなかったのを直した（nav-launcher-plan.md PR-4）（#426）。
- ドックを画面の上にも置けるようにした（`LauncherBar` の `position` に `'top'`、設定の「ドックの位置」上 / 下 / 左 / 右、保存値 `shell.launcherPosition` は既存の `bottom` / `left` / `right` もそのまま読める）。上のバーはヘッダーの下に出し（`@banto/theme` に `--banto-shell-launcher-inset-top` を追加し、シェルがヘッダーの高さを入れる）、拡大とツールチップは下向き。900px 以下はほかの位置と同じく下端のタブバー（nav-launcher-plan.md PR-6）（#456）。
- 900px 以下のドック（タブバー）は、透け具合の設定にかかわらず不透明度 85% を下限にし、ラベルを読みやすくした（`--banto-shell-launcher-tabbar-opacity-min`、#428）。
- ドックの設計と段取りを `docs/design/nav-launcher-plan.md` にまとめた（#421）。
- `@banto/admin-core` に、古い非同期結果を捨てて一時資源を一度だけ解放する `createRequestOwner`（`begin` / `invalidate` / `dispose` / `busy`、要求ごとの `signal`・`isCurrent`・`hold`・`adopt`・`finish`）と、他パッケージが同じ契約を流すための契約の表（`tests/contracts/request-owner.json`）を追加した。`ListResource` の要求番号をこれに置き換えた（挙動の変更なし。shared-primitives-upstream-plan PR-3、#436）（#441）。
- `@banto/dock-svelte` に、host の縮小でも浮動 window を操作できるようにする表示用の補正と、consumer が渡す方針を追加した（#434、計画書 PR-2）。`DockHost` に `clamp`（最小寸法・`minVisible`・狭い host での `narrowHost: 'overflow' | 'fit'`）と `capabilities`（pane ごとの `close` / `move` / `undock`）を追加し、純関数 `displayWindowGeometry` と型 `DockCapabilities` を export。host の寸法が変わっても保存した希望の x / y / width / height は書き換えない（描くときだけ補正。move / resize は描いている位置から始まり、結果が新しい希望になる）。`DockState.move` / `resize` に任意の `clamp` 引数、README に書き込み失敗時の約束（保存済み snapshot を更新しない）を追記した（#443）。
- `@banto/admin-core` に、UI 設定の現在値と保存に成功した snapshot を分ける `createSavedSetting`（`current` / `saved` / `saving` / `error` / `dirty`、明示保存と即時保存、保存は直列・合流、失敗しても編集中の値と前の保存値を保つ、破損・未知の version は `parse` / `fallback` へ委譲）を追加した。既存の `UiSettingsProvider` の上に乗る helper で、既存の画面は変えない（shared-primitives-upstream-plan PR-6、#437）（#442）。
- `@banto/ui` に操作の定義 `CommandSpec` とショートカットの保護・dispatcher（`shouldHandleShortcut` / `createShortcutDispatcher`、IME 変換中・`defaultPrevented`・`repeat`・入力欄・モーダルな層とメニューでは受けない、`ownerLayer`・実行直前の `enabled` の再確認・`preventDefaultWhenDisabled`）、キーの `parseShortcut` / `matchShortcut` / `formatShortcut`（`Mod` = Ctrl / macOS は Meta）と、`aria-modal="true"` の層だけを見る `hasVisibleModalLayer`（非モーダルの浮動 window では止めない）を追加した。`@banto/admin-core` の `PaletteCommand` に任意の `enabled` / `checked` / `shortcut` を足した（アプリへの配線は PR-11。shared-primitives-upstream-plan PR-7、#435）（#444）。
- `@banto/dock-svelte` にキーボード操作と操作の hook を追加した（#433、計画書 PR-5）。divider は WAI-ARIA の Window Splitter（フォーカスでき、矢印・Shift・Home / End で動かし、`aria-valuenow` などを持つ）、タブは矢印・Home / End で選ぶ（roving tabindex）、浮動 window はタイトルバーのボタンで移動 / サイズ変更のモードに入り、矢印・Shift で動かして Enter で確定、Esc で取消。`DockHost` に `canStartGesture` / `onGestureEnd` / `isEscapeBlocked(activeLayer)` の props と型 `DockGestureKind` / `DockCancelReason`、`messages` に `moveWindow` / `resizeWindow` を足した。ダッシュボードは `isEscapeBlocked` に `@banto/ui` の層の判定をつなぎ、浮動 window を開いたままの divider の操作も Esc で戻る（#446）。
- `@banto/forms` に、pane より長生きする未適用入力 `createFormDraft`（生の入力文字列・確定・適用を始めた時点の snapshot を成功後だけ baseline にする `snapshotForApply` / `markApplied`）と、複数フォームを 1 回の確認で適用 / 破棄 / キャンセルする `createDraftCoordinator`（`register` / `capture` と再登録での `restore`、`settle` の `'applied'` / `'discarded'` / `'dirty-again'` / `'stale'` など、`guardUnsavedChanges` の登録簿への接続）、`draftSourceFrom`、生の文字列を残す `DraftNumberField` を追加した。適用中に対象が変わった結果は admin-core と同じ契約の内部実装で捨て、`request-owner.json` の表を forms のテストでも流す。既存の `FormStore`・`guardUnsavedChanges`・`NumberField` は変えない（shared-primitives-upstream-plan PR-8、#432）（#447）。
- `@banto/dock-svelte` に pane の lifecycle を追加した（#432、計画書 PR-9）。`DockHost` の `beforePanelChange(change)`（dock / undock / move-docked / tab-switch / hide / close の前に聞き、`true` のときだけ変える。非同期の答えは、待つあいだに layout の構造が一度でも変わったら（`DockState.structureRevision` の世代で見るので、同じ形に戻っても）・`keepMounted` が変わって変更の中身が変わったら・IME 変換中に返ったら変換が終わるまで持ち、unmount したら答え待ちの要求もすぐに `disposed` を返す。同じ要求の重複除去は変更と行き先（ドロップ先）が同じときだけ）、`keepMounted(panelId)`（表示していないタブ・hide した浮動 window の中身を `hidden` + `inert` で同じ DOM のまま残す）、`isStructureChangeDeferred()`（省略時は IME 変換中。変換中はドラッグを始めず、構造変更を `compositionend` まで保留する）と、`hidePanel` / `closePanel` / `resumeDeferredChange`、型 `DockPanelChange` / `DockPanelChangeOutcome` と `structureKey`・`DockState.structureRevision`。`keepMounted` の pane では ✕ が hide（中身を保つ）になり、中身を捨てるのは `closePanel`（D4-a）。props を渡さないアプリで変わるのは、IME 変換中のドラッグと構造変更の保留だけ（見た目は変わらない。アプリへの配線は PR-10）（#448）。
- テンプレートのダッシュボードのメモ pane を、未適用の入力を持てる入力欄にした（#432、計画書 PR-10）。draft と `DraftCoordinator` はページが持ち、dock / undock / タブの切替では入力と未保存の状態が残る。✕・ツールバーでの close と pop-out は「保存して閉じる / 破棄して閉じる / キャンセル」を聞き（`@banto/ui` の `Modal`）、保存の待機中に入力があれば閉じずに残す。保存先は UI 設定（`dashboard.memo`、REST / Tauri / デモの各 provider）。未保存のままの画面離脱は既存の確認を出す。コピーして使っている派生アプリ（経路 B）は `dashboard/+page.svelte` と新しいファイル（`#lib/banto/dashboardMemo.svelte.ts`・`settlePrompt.svelte.ts`、`DashboardMemoField.svelte`・`DraftSettleDialog.svelte`）、文言キー `dashboard.memo*` を取り込めば同じ配線になる（取り込まなければ従来どおり静的なメモ）（#449）。
- テンプレートのキー操作を `@banto/ui` の shortcut dispatcher につないだ（#435、計画書 PR-11）。Ctrl+K / Cmd+K は `#lib/shortcuts.ts` の command になり、パレットを開いたまま検索欄で閉じられるのは同じで、ほかの Modal・Drawer・メニューが出ている間と IME 変換中は開かない。ダッシュボードのメモは Ctrl+S / Cmd+S で保存する（入力欄の中でも。保存ボタンと同じ command・同じ直列の保存で、保存するものが無いときもブラウザの「ページを保存」は出さない。ほかのページの Ctrl+S はブラウザのまま）。ヘッダーの検索ピルの鍵帽は OS に合わせて `Ctrl+K` / `⌘K` と出す。コピーして使っている派生アプリ（経路 B）は `#lib/shortcuts.ts`（新規）・`(app)/+layout.svelte`・`Header.svelte`・`dashboard/+page.svelte`・`dashboardMemo.svelte.ts`・`DashboardMemoField.svelte` と文言キー `common.withShortcut` を取り込めば同じ配線になる（#450）。
- 新しいオプションのパッケージ `@banto/image-assets`（`packages/image-assets`）の骨格を追加した（#438、計画書 PR-12、[ADR-0020](docs/adr/0020-image-assets-package.md)）。ブラウザ側の画像の原本・取込検査・object URL の寿命のための部品で、この PR では形式（`IMAGE_FORMATS`）、consumer が必ず渡す上限の型と検証（`ImageImportLimits`・`validateImageImportLimits`。既定値は持たない）、文言を持たないエラーコード（`ImageAssetError` の `code` と `detail`）だけを公開する。依存は空で、テンプレートのアプリには配線しない（scaffold は触れない。template-scope §3 の行と削除手順を足した）。取込の検査と hash は PR-13、原本と URL の寿命は PR-14（#451）。
- `@banto/image-assets` に取込の検査と hash を追加した（#438、計画書 PR-13）。`inspectImageHeader`（decode 前に bytes から PNG / JPEG の形式・寸法・画素数を読み、consumer の上限と照らす。壊れた・切り詰めた入力も `ImageAssetError` で返す）、`verifyDecodedImage`（ブラウザで decode して寸法がヘッダと一致するか確かめる。decoder は注入でき、既定は `createImageBitmap`）、両方と hash を順に通す `inspectImage`、`sha256Hex`（`crypto.subtle` が無い平文 HTTP では自前の SHA-256 に落ち、同じ値。D11）。プログレッシブと CMYK の JPEG は受け入れ、APNG・ロスレス / 算術符号化の JPEG は `unsupported-format`（#452）。
- `@banto/image-assets` に原本の store を追加した（#438、計画書 PR-14）。`createImageStore({ maxTotalBytes })`（総容量は必須、超えると `store-full`）が `add()` で取込の検査を通した原本を不変の `Blob` として保持し、SHA-256 で重複排除する。object URL は原本ごとに共有して最後の `release()` で revoke し（`acquireUrl`）、`pin` / `collect` / `delete` / `dispose` は pin 中・URL 貸出中の原本を消さない（dispose 後は最後の解除で消える）。処理中の add は admin-core の `createRequestOwner` と同じ契約の内部の写しが持ち（同じ `key` の新しい add・`cancel`・`dispose` で失効し、`null` を返す）、admin-core の契約の表を自分のテストで流す。エラーコードに `unknown-asset`・`store-disposed` を足した。`.svelte.ts` を持つようになったので、使うアプリは `optimizeDeps.exclude` に足す（外部利用 fixture には足した）（#453）。
- 配色モード（ライト / ダーク）の切替をヘッダーの太陽 / 月のアイコンボタンへ移した。表示中の配色の反対を示し、押すと反対の配色に固定する（初期は OS に従う。保存値の形は変えない）。設定画面（外観・言語）のテーマのカードから配色モードの 3 枚を外し、プリセットと表示密度を残した。不要になった `settings.modeLight` / `modeDark` / `modeSystem` を消し、`shell.switchToDarkMode` / `shell.switchToLightMode` を足した。visual の基準画像の再生成が要る（Linux で `visual-baselines.yml` を dispatch）（#458）。
- 内蔵サーバー（LAN アクセス）を起動時に自動で始めるとき、保存したポートが使用中なら、すぐ後ろの決まった範囲（+1〜+19、65535 まで）から空いているポートを選んで起動し、そのポートを `server.port` に保存して管理者にトーストで知らせるようにした（監査は操作者なしの `settings_change`、`detail.reason: "portInUse"`）。`banto-server` に `bind_with_port_fallback`・`PortFallbackError`・`PORT_FALLBACK_SPAN` を追加し、`server_status` の応答に `portNotice` を足した。設定画面の「保存して適用」は従来どおり自動で選ばない（#460）。
- docs: 共有部品の還元（#432〜#438）の完了を文書に反映した（計画書 PR-15）。`docs/upgrading.md` に例 5（派生アプリの取り込み手順。破壊的変更は無いが、dock の復元 layout の検証とドラッグの確定に挙動の変化がある点、`@banto/image-assets` の `optimizeDeps.exclude`）、レシピ `docs/recipes/image-assets.md`（画像の取り込みと表示）を足し、計画書の状態行・§5.1 を「実装完了（v6.8.0 のリリース待ち）」に更新した。コードの変更なし（#454）。

### Changed

- 設定画面のカテゴリ切り替えを、広い画面でも左の縦レールではなく内容の上の横並び（ピル型）にした。サイドバーと合わせて内容の幅が狭くなるのを避ける（visual の基準画像の再生成が要る）（#455）。
- サイドバーの折りたたみボタンを、ヘッダー左端からサイドバー最上段のロゴの左へ移した（900px 超）。最上段は `[ボタン][ロゴ] Banto` で、折りたたむとボタンだけが同じ位置に残り（ロゴは隠れる）、同じ場所をもう一度押せば戻る。900px 以下はこれまでどおりヘッダーのボタンでドロワーを開閉し、ドックのレイアウトでは出さない。visual の基準画像（サイドバー・ヘッダーを含むもの）は再生成が要る（#457）。
- サイドバーの折りたたみボタンを、サイドバー下端からヘッダーの左端へ移した。900px 以下のハンバーガーと 1 つのボタンに統合し（900px 超は折りたたみ、以下はドロワーの開閉）、`aria-expanded` / `aria-controls` を付けた。`IconButton` に `expanded` / `controls` を追加（#431）。
- サイドバーの表示項目の絞り込み（RBAC・閲覧公開の許可リスト）を `navSections()` に切り出し（挙動の変更なし、nav-launcher-plan PR-1）（#422）

### Fixed

- `@banto/dock-svelte` の復元 layout を検証するようにした（#434、計画書 PR-1）。`DockState` の `hydrate`（JSON）と constructor の初期値（文字列・オブジェクト）が、version・構造・panel / node ID の一意性・有限の座標・正の寸法・split の `sizes`・tabs の `activeIndex` を全体として検証し、不正（`x=1e999`・`width=-1`・`height=0`・重複 ID など）なら拒否して現行 layout を変えない（constructor は空の layout で始める）。`hydrate` の戻り値を `void` → `boolean`（採用されたか）にし、検証の純関数 `validateDockLayout` と型を追加。**挙動の変化**: 従来は通っていた不正な layout が拒否される。正常な v1 / v2 は従来どおり読める。host 縮小時の到達性・能力指定は PR-2。（#440）
- `@banto/dock-svelte` のドラッグ・resize・divider・開始閾値の追跡を 1 つの操作の持ち主にまとめた（#433、計画書 PR-4）。**挙動の変化**: 操作を始めた pointer の `pointerup` でだけ確定し、別の pointer の `pointerup` ではドラッグが確定しなくなった。resize・divider も Esc（ほかの層が `preventDefault` 済みなら譲り、受けたら `preventDefault`）・`pointercancel`・`lostpointercapture`・window の `blur`・タブが隠れたとき・`DockHost` の unmount で取り消され（resize は対象の window の位置と寸法、divider は対象の split の比率だけを戻し、操作中のアプリの変更は残す）、listener が残らない。確定の直前に host の寸法を測り直す。浮動 window は `focusin` でも前面に来て、前面化は `z-index` で行い DOM（Tab）の順を変えない。公開 API の変更なし（keyboard 操作と hook は PR-5）（#445）。
- scaffold の dock の除去（`removeDock`）が、#446 で足した `#lib/banto/dockEscape.ts` とそのテスト・ダッシュボードの import を外していなかったのを直した（dock を外すプリセットで、使われない import と呼び出し元の無いファイルが残っていた）（#450）。
- 閲覧公開（LAN）セッションの Ctrl+K コマンドパレットが、開けない画面（許可リスト外）まで一覧に出していたのを直した。ナビゲーションのコマンドもサイドバー・ドックと同じ `navSections()` で絞る（ADR-0012）（#425）。
- `@banto/ui` の `Menu` で、項目がトリガーの上下の可用高を超えると下端が画面外に残り届かなかったのを直した。広い側の可用高（余白・枠線込み）に高さを抑えて中をスクロールし（`overscroll-behavior: contain`）、メニュー自身のスクロールでは閉じない（外側のスクロールでは従来どおり閉じる）。あわせて、開いた瞬間は項目がまだ不可視のためフォーカスが項目へ移らず、ブラウザでは開いた後の ↑↓・Home・End が効かなかったのを直した（#427、#430）。

## [6.7.2] - 2026-10-20

**v6.7.2 — 保守のみのリリース（CI の高速化、テストの安定化、内部の整理）。** 版の種類: patch（挙動の変更なし。公開 API の変更なし。後方互換）。
派生アプリへの影響: タグを上げるだけ。

| 経路                             | 影響         | 内容                                                                                                                                                                                                                                       |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 依存（`@banto/*`・`banto-*`） | なし         | `v6.7.1` → `v6.7.2`（npm と Rust を同じタグに）。公開 API は変わらない。banto-server の `auth` はモジュールに分けたが `banto_server::auth::…` の名前はそのまま                                                                             |
| B. コピーしたテンプレート        | あり（任意） | `apps/admin-template/src/lib/banto/` の `attachmentsAdmin.ts`・`backupsAdmin.ts`・`itemsAdmin.ts`・`systemAdmin.ts` の内部の fetch ラッパを `httpRequest(path, init: HttpInit)` にそろえた。送る要求は同じで、取り込まなくても動く（#414） |
| C. DB・設定・配布資産            | なし         | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                    |

### 消費側への注意

- 公開 API・挙動の変更は無い（保守のみ）。タグを上げるだけで済む。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `ea6a602`、`workflow_dispatch`）: [run 39377708546](https://github.com/tyaro/banto/actions/runs/39377708546)（success）。
  - タグの push（`v6.7.2`）: [run 39377903663](https://github.com/tyaro/banto/actions/runs/39377903663)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.22.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.2                         |
    | SvelteKit          | 3.1.0                          |
    | Vite               | 8.3.4                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.1（58cf8f9c3 2026-10-13） |

  - 出所: Node.js は `node: v24.22.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.2` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.1`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- CI の E2E のうち visual + axe-core を別ジョブ `E2E (visual + axe-core)` に分け、`BANTO_E2E_SERVERS=visual` で `vite preview` だけを起動できるようにして E2E を速くした（#410）。CI のみの変更で、公開 API と手元の `pnpm e2e*` の挙動は変わらない。
- 監査の保留ファイルのテスト 2 件が、Windows CI で `sync_all` を含む経過時間の上限で不安定に落ちるのを直した（#399、#401）。公開 API の変更は無い。
- CI の Rust のビルドを速くするため、ワークフロー（`ci.yml`・`tauri-check.yml`）でデバッグ情報を行番号だけにした（`CARGO_PROFILE_DEV_DEBUG=line-tables-only`、#408）。CI のみの変更で、公開 API の変更は無い。
- CI と手元の `cargo test` を速くするため、dev/test プロファイルで依存の argon2・blake2 だけを opt-level 3 でビルドするようにした（`rest::tests` が Windows CI で 79 秒だったのが数秒に。#409）。公開 API の変更は無い（release と利用アプリには影響しない）。
- `banto-server` の `auth.rs` をモジュールに分けた（#415）。コードの移動のみで、`banto_server::auth::…` の名前と挙動は変わらない。
- `apps/admin-template/src/lib/banto/` の `attachmentsAdmin.ts`・`backupsAdmin.ts`・`itemsAdmin.ts`・`systemAdmin.ts` の内部の fetch ラッパを `httpRequest(path, init: HttpInit)` にそろえた（#414）。送る要求は同じで、公開 API の変更は無い。
- eslint を `--max-warnings=0` で走らせるようにした（#413）。警告も CI を落とす。
- scaffold-acceptance-paths の検査（rule 14）を足し、template-acceptance の `paths` を追加した（#417）。
- conventions と ADR-0008 に追記した（#412）。
- Windows で不安定だった監査のテストを直した（#416）。
- 保守レビューの記録を追加・更新した（#411・#418）。
- npm の devDependencies を更新した（#405・#407、dependabot。fixture の範囲を揃えた）。
- `Cargo.lock` を更新した（#403）。
- CI の action を更新した（#402）。

## [6.7.1] - 2026-10-15

**v6.7.1 — `isTauri()` が `location.origin` も見るようにし、サービスへ navigate した Tauri の窓を server 経路にした（#396）。版の種類: patch（修正のみ。公開 API の変更は無い。後方互換）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B は `environment.ts` を写している場合に取り込むと直る（任意）。経路 C は変更なし。**

| 経路                             | 影響         | 内容                                                                                                                                                                                                     |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | なし         | `v6.7.0` → `v6.7.1`（npm と Rust を同じタグに）。タグを上げるだけで、`optimizeDeps.exclude` の変更は不要。`isTauri()` は `admin-template` のコードで `@banto/*` には無いため、依存の差し替えでは直らない |
| B. コピーしたテンプレート        | あり（任意） | `environment.ts` の `isTauri()` に origin の判定を取り込むと直る（下の注意）。取り込まなければ従来どおり                                                                                                 |
| C. DB・設定・配布資産            | なし         | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                  |

### 消費側への注意

- 公開 API は変わらない（修正のみ）。`isTauri()` は、Tauri 自身の origin（`http://tauri.localhost`・`https://tauri.localhost`・`tauri://localhost`、開発ビルドのみ `tauri.conf.json` の `build.devUrl` の origin）でないときは false を返すようになった。シェルが WebView をローカルのサービス（`http://127.0.0.1:<port>/`）へ navigate する構成では、その窓が server 経路を使う。
- `environment.ts` を写して使っている派生（経路 B）は、純関数 `isTauriOrigin(origin, devOrigin?)` と `TAURI_ORIGINS`・`TAURI_DEV_ORIGIN` を取り込むことを推奨する。シェルが自前のサービスへ navigate しない派生は、取り込んでも挙動は変わらない。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `a3a1d37`、`workflow_dispatch`）: [run 38610452739](https://github.com/tyaro/banto/actions/runs/38610452739)（success）。
  - タグの push（`v6.7.1`）: [run 38610678688](https://github.com/tyaro/banto/actions/runs/38610678688)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.2                         |
    | SvelteKit          | 3.0.1                          |
    | Vite               | 8.3.4                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.2` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 修正

- `isTauri()`（`apps/admin-template/src/lib/banto/environment.ts`）が `__TAURI_INTERNALS__` の有無だけでなく `location.origin` も見るようにした
  （#396）。Tauri のシェルが WebView をローカルのサービス（`http://127.0.0.1:<port>/`）へ navigate すると、Tauri はその窓にも
  `__TAURI_INTERNALS__` を注入するため、以前は invoke の経路を選んで壊れていた。Tauri 自身の origin（`http://tauri.localhost`・
  `https://tauri.localhost`・`tauri://localhost`、開発ビルドのみ `tauri.conf.json` の `build.devUrl` の origin）のときだけ true になる。
  純関数 `isTauriOrigin(origin, devOrigin?)` と定数 `TAURI_ORIGINS`・`TAURI_DEV_ORIGIN` を足した。
  派生アプリへの影響: `environment.ts` を写している経路 B・C の派生は同じ直しを取り込む。シェルが自前のサービスへ navigate しない派生は挙動が変わらない。

## [6.7.0] - 2026-10-11

**v6.7.0 — `@banto/ui` に `Modal`・`Drawer` と、Esc・フォーカスの層の補助（`layering.ts`）を足した（ADR-0018 段階 4）。`CommandPalette` も同じ補助を使う。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                 |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.6.0` → `v6.7.0`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。`Modal`・`Drawer`・層の補助を使わなければ挙動は変わらない（`CommandPalette` の振る舞いも同じ） |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                                                             |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                              |

### 消費側への注意

- 既存の公開 API は変わらない（追加のみ）。`CommandPalette` の Esc・フォーカスの扱いは共通の補助に移ったが、振る舞いは同じ（配置されていない層を手前の層と数えなくなった、という端の違いだけ）。
- 自前の Modal・Drawer やフォーカスの閉じ込めの写しを持つアプリは、`@banto/ui` の `Modal`・`Drawer`・`hasVisibleLayerAbove` などに置き換えられる（props は banto-industrial の banto-hub と同じ。`LAYER_ABOVE_SELECTOR` → `LAYER_SELECTOR`、`DrawerCloseSource` → `OverlayCloseSource`）。面は `--banto-surface-overlay`、z は `--banto-z-modal`。
- 開発用の依存を更新した（Playwright 1.64、Svelte 5.57.2、SvelteKit 3.0.1、Vite 8.3.3、jsdom 30.1.2 など）。external-consumer の fixture の版の範囲も admin-template に揃えた。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `1ffe507`、`workflow_dispatch`）: [run 38131322412](https://github.com/tyaro/banto/actions/runs/38131322412)（success）。
  - タグの push（`v6.7.0`）: [run 38131442603](https://github.com/tyaro/banto/actions/runs/38131442603)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.2                         |
    | SvelteKit          | 3.0.1                          |
    | Vite               | 8.3.4                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.2` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加

- `@banto/ui`: `Modal`（中央）・`Drawer`（右端）と、Esc・フォーカスの層の補助（`hasVisibleLayerAbove`・`hasVisibleMenuLayer`・`attachFocusTrap`・`focusablesIn`・`restoreFocus`・`canRestoreFocusTo`・`effectiveZIndex`・`isCloseAllowed` と `LAYER_*`・`FOCUSABLE_SELECTOR`、型 `ModalProps`・`DrawerProps`・`OverlayProps`・`OverlayCloseSource`）を追加（ADR-0018 段階 4、2026-10-11 オーナー決定。追加のみ。後方互換）。banto-industrial の banto-hub の部品の props（`open`・`title`・`width`・`closeOnOverlayClick`・`onclose`・`onRequestClose`・`dirty`・`onBlockedClose`・`focusFallback`）をそのまま持ち、× の名前は `UiMessages.overlayClose`（既定 `'閉じる'`）。重なりは `--banto-z-modal`、背景は `--banto-scrim`。派生アプリへの影響: 経路 A はタグを上げるだけ（`@banto/ui` は既に `optimizeDeps.exclude` の対象で、変更は不要）。経路 B・C は変更なし。
- `@banto/ui`: `CommandPalette` の Esc・フォーカスの扱いは、`Modal`・`Drawer` と同じ 1 つの補助（`layering.ts`。段階 2b の内部の `overlayFocus.ts` を置き換えた）を使うようにした。パレットの振る舞いは変わらない（違いは、レイアウトされていない層・`display: none` の中の層を手前の層と数えなくなったことだけ）。admin-template の `/ui-demo` に `Modal`・`Drawer` の見本を足した。

## [6.6.0] - 2026-10-10

**v6.6.0 — `banto-admin-services` の監査に、記録の失敗と保留（spool）の警告行をアプリ自前のログへ流す `with_log_sink` / `with_shared_log_sink` と型 `AuditLogSink` を足した（ADR-0019、tyaro/banto-industrial#437 の続き）。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                          |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.5.0` → `v6.6.0`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。`with_log_sink` / `with_shared_log_sink` を呼ばなければ挙動は変わらない |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                                      |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                       |

### 消費側への注意

- 既存の公開 API は変わらない（追加のみ）。`with_log_sink` / `with_shared_log_sink` を呼ばない `AuditLogService` は v6.5.0 と同じく `eprintln!` に出す（文言も同じ）。
- 標準エラー出力がどこにも届かない構成（Windows サービスなど）では、`with_log_sink(|line| ...)` でアプリのログに流す。1 つの sink を複数のサービスで共有するときは `AuditLogSink`（`Arc`）を `with_shared_log_sink` に渡す。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `4da9930`、`workflow_dispatch`）: [run 38038323977](https://github.com/tyaro/banto/actions/runs/38038323977)（success）。
  - タグの push（`v6.6.0`）: [run 38038425290](https://github.com/tyaro/banto/actions/runs/38038425290)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加

- `banto-admin-services`: `AuditLogService::with_log_sink`（クロージャ）・`with_shared_log_sink`（共有済みの `Arc`）と型 `AuditLogSink` を追加（追加のみ。後方互換）。`record` の失敗と保留（spool）の警告行を、既定の `eprintln!` の代わりにアプリ自前のログへ流せる（標準エラー出力を持たない Windows サービス向け。`with_spool` の前後どちらでも可。呼ばなければ従来どおり `eprintln!`、文言も同じ。ADR-0019）。

## [6.5.0] - 2026-10-10

**v6.5.0 — `@banto/charts` の `LineChart` にツールチップ専用の書式 `formatTooltip` を足した（#376）。`banto-admin-services` に、DB に書けない監査を保留ファイルに退避し、復旧後に 1 回だけ流し込む保留（spool）を足した（tyaro/banto-industrial#437、ADR-0019）。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 C は、監査の保留を使うアプリだけ migration 0008 の取り込みが必要。経路 B は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                            |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.4.0` → `v6.5.0`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。`formatTooltip`・`with_spool` を使わなければ挙動は変わらない                                                              |
| B. コピーしたテンプレート        | なし | 変更なし（admin-template の配線は変えていない）                                                                                                                                                                 |
| C. DB・設定・配布資産            | あり | DB のマイグレーション `0008_audit_log_pending_id.sql`（SQLite・PostgreSQL）を追加。**監査の保留（`with_spool`）を使うアプリは取り込む必要がある**。使わないアプリは取り込まなくても動く（取り込んでも害はない） |

### 消費側への注意

- 既存の公開 API は変わらない（追加のみ）。`formatTooltip` を指定しない `LineChart`、`with_spool` を呼ばない `AuditLogService`（`record` / `try_record`）は v6.4.0 と同じ。
- `with_spool` を使うときは、migration `0008_audit_log_pending_id.sql` を自分の migrations にそのまま写してから使う（`audit_log.pending_id` が無いと、保留を付けた `record` の INSERT が失敗し続け、すべて保留に回る）。起動時（migration の後）に `flush_spool()` を 1 回呼び、`spawn_spool_flusher()` のハンドルを持って終了時に止める。保留の状態は `spool_backlog()` で見られる。
- 保留ファイルには監査の内容（ユーザー名・操作の要約）が残る。データディレクトリと同じ権限で守る（ADR-0019）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `c8b5d34`、`workflow_dispatch`）: [run 38010407324](https://github.com/tyaro/banto/actions/runs/38010407324)（success）。
  - タグの push（`v6.5.0`）: [run 38010538144](https://github.com/tyaro/banto/actions/runs/38010538144)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加

- `@banto/charts`: `LineChart` に任意の `formatTooltip?: (value, series, index) => string` を追加した。ツールチップの値の書式だけを、系列の情報（`id` / `label` / `axis`）とデータの添字を受け取って系列ごとに変えられる。縦軸の目盛と余白の自動計算には使わず、有限の値にだけ呼ばれる（非有限は従来どおり `-`）。bit と数値のタグが混ざったグループでツールチップの bit だけを `True` / `False` にしたり、縦軸を `False` / `True` だけにしたままツールチップでは区間の中点も出したりするためのもの（tyaro/banto#376、tyaro/banto-industrial#551）。指定しなければ描画は従来と同じ（`formatY`、右の軸の系列は `formatYRight`）。
- `banto-admin-services`: DB に書けない監査を保留ファイルに退避し、復旧後に 1 回だけ `audit_log` へ流し込む保留（spool）を追加した（tyaro/banto-industrial#437、[ADR-0019](docs/adr/0019-audit-spool.md)）。`AuditLogService::new(db).with_spool(dir, SpoolConfig::default())?` で有効にすると、`record` は書く前に `pending_id`（UUIDv4）と `ts` を決め、INSERT が失敗するか 3 秒（`SpoolConfig::timeout`）で応答しなければ、その 1 件を `<dir>/<pending_id>.json` に書いて戻る（要求を待たせない。タイムアウトした INSERT は取り消さない）。流し込みは `flush_spool()`（起動時にアプリが呼ぶ）・`record` の成功（保留があるとき、または保留ディレクトリを `flush_interval` のあいだ読んでいないとき）・`spawn_spool_flusher()` の定期実行（既定 30 秒。自分の保留が 0 件でも毎回ディレクトリを読むので、同じディレクトリを使う別のプロセスが残した分も拾う）で行い、`ON CONFLICT (pending_id) DO NOTHING` なので、遅れて完了した INSERT と流し込みが重なっても、複数のプロセスが流し込んでも 1 行になる。流し込んだ行は `detail.spooled = true`、`ts` は `record` を呼んだ時刻（保持期間の削除はこの `ts` で判定するので、古い行は流し込みの直後に消え得る）。保留は既定で 10,000 件まで（超えた分は捨てて `spool_backlog().dropped` に数える）、状態は `spool_backlog()` で見られる。`try_record` は保留しない。**DB のマイグレーション `0008_audit_log_pending_id.sql`（`audit_log.pending_id` と一意インデックス、SQLite・PostgreSQL の両方）を追加した（経路 C）。保留を使うアプリはこれを取り込む必要がある。** `with_spool` を呼ばなければ `record` は従来と同じで、マイグレーションを取り込まなくても動く。

## [6.4.0] - 2026-10-09

**v6.4.0 — `@banto/charts` の `LineChart` に、左の縦軸の範囲に必ず含める値を指定する `includeY` を足した（tyaro/banto-industrial#554）。版の種類: minor（追加のみ。後方互換。指定しなければ描画は変わらない）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                            |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.3.2` → `v6.4.0`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。`includeY` を使わなければ描画は変わらない |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                        |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                         |

### 消費側への注意

- 既存の `@banto/*` の公開 API は変わらない（追加のみ）。`includeY` を指定しない `LineChart` の描画は v6.3.2 と同じ。
- `includeY` は左の軸の目盛の範囲だけを広げる。データ点・ツールチップ・凡例・系列は増えず、データが無いチャートは空表示のまま。右の軸には効かない。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `d972480`、`workflow_dispatch`）: [run 37946218576](https://github.com/tyaro/banto/actions/runs/37946218576)（success）。
  - タグの push（`v6.4.0`）: [run 37952598880](https://github.com/tyaro/banto/actions/runs/37952598880)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加

- `@banto/charts`: `LineChart` に任意の `includeY?: readonly number[]` を追加した。左の縦軸の範囲に必ず含める値を指定でき、左の軸の系列のデータの範囲との和集合で目盛を決める（データが無ければ指定値だけ。非有限の値は無視する）。ビット（0/1）のタグだけの推移で、見えている値が 0.5 の 1 点だけのときに目盛が 0.2〜0.8 になり、0 と 1 しか書かない書式で目盛がすべて空になる問題を、偽のデータ点を入れずに避けるためのもの（tyaro/banto-industrial#554）。データ点・ツールチップ・凡例・系列は増えず、データが無いチャートの空表示も変わらない。指定しなければ描画は従来と同じ。右の軸には効かない。

## [6.3.2] - 2026-10-09

**v6.3.2 — `@banto/charts` の `LineChart` / `ComboChart` / `StackedAreaChart` / `ScatterChart` の左の余白が、左の軸の目盛の文字の幅に合わせて自動で広がるようにした（長い目盛が左で見切れていたのを直した）。版の種類: patch（修正のみ。公開 API の変更は無い）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                           |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.3.1` → `v6.3.2`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。目盛が長いチャートの左の余白が広がる（配線の変更は不要） |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                       |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                        |

### 消費側への注意

- 公開 API は変わらない（修正のみ）。`margins.left` は引き続き指定でき、最小値として扱われる。
- 目盛が左の余白に収まっていたチャートの描画は変わらない。ただし文字幅は推定で見積もるため、6 文字の目盛を持つチャートは余白が約 1px 広がることがある。スナップショットテストや画素比較をしているアプリは、この差を確認する。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `a25b233`、`workflow_dispatch`）: [run 37927931064](https://github.com/tyaro/banto/actions/runs/37927931064)（success）。
  - タグの push（`v6.3.2`）: [run 37928088362](https://github.com/tyaro/banto/actions/runs/37928088362)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 修正

- `@banto/charts`: `LineChart` / `ComboChart` / `StackedAreaChart` / `ScatterChart` の左の余白が、左の軸の目盛（`formatY` を通した後）の文字の幅に合わせて自動で広がるようにした。これまで 48px 固定で、`800,000,000` のような長い目盛が左で見切れていた（tyaro/banto-industrial#550）。余白は左の軸の目盛の幅に合わせて広がるが、上限は 140px とチャート幅の 40% のうち小さい方（巨大な目盛でプロットが消えないようにする）。`LineChart` の右の軸にも同じ上限を付けた。目盛が収まっていたチャートの描画は変わらない（ただし 6 文字の目盛は、文字幅を推定で見積もるため約 1px 広がることがある）。呼び出し側の `margins.left` は最小値として扱う。

## [6.3.1] - 2026-10-09

**v6.3.1 — `banto_server::static_files::static_router` が、どの API ルートにも一致しなかった `/api`・`/api/...` の要求を、SPA の HTML（200）ではなく JSON の 404 で返すようにした。版の種類: patch（修正のみ。公開 API の変更は無い。ただし 1 点、見える挙動が変わる: 存在しない `/api/...` の応答が 200 の HTML から 404 の JSON になる）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                           |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.3.0` → `v6.3.1`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。**見える挙動が 1 点変わる**: 存在しない `/api/...` を呼ぶと、200 の HTML ではなく 404 の JSON が返る（配線の変更は不要） |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                                                                                       |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                        |

### 消費側への注意

- 公開 API は変わらない（修正のみ）。`static_router` を merge しているアプリは、配線の変更なしで反映される。
- **存在しない API パスを呼んでいた画面・クライアントは、応答が変わる**: 従来は 200 の HTML（SPA の `index.html`）が返り、JSON として読もうとして別の場所で失敗していた。今後は 404 の JSON（`{"kind":"not_found","resource":"api","id":"<パス>"}`）が返る。404 を前提にしていなかった呼び出し側は、エラー処理を確認する。`/apiary` など `/api/` で始まらないパスと画面のルートは従来どおり `index.html`。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `8841504`、`workflow_dispatch`）: [run 37896295455](https://github.com/tyaro/banto/actions/runs/37896295455)（success）。
  - タグの push（`v6.3.1`）: [run 37896660250](https://github.com/tyaro/banto/actions/runs/37896660250)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 修正

- `banto_server::static_files::static_router` が、どの API ルートにも一致しなかった `/api`・`/api/...` の要求を SPA のフォールバック（`index.html` を 200 で返す）に落とさず、JSON の 404（`{"kind":"not_found","resource":"api","id":"<パス>"}`）で返すようにした。どのメソッドでも同じ。`/apiary` など `/api/` で始まらないパスと画面のルートは従来どおり `index.html`。派生アプリへの影響: 存在しない `/api/...` が 200 の HTML ではなく 404 になる（`static_router` を merge しているアプリは配線の変更なしで反映される）。banto-industrial#547

## [6.3.0] - 2026-10-08

**v6.3.0 — `@banto/charts` の欠測・開放端しきい値・値なしの表示を足した（#369）: `LineChart` の `gaps`（欠測で線を分ける）、開放端を持てる `OpenThresholdBand`（`bands` のクリップ）、`Gauge` の `value: number | null` と下側しきい値 `warningLow` / `dangerLow`、文字 `messages.gaugeNoValue`。docs のみの変更として ADR-0018 の段階 3 の記録（#367）と README の再構成（#368）を含む。版の種類: minor（追加のみ。後方互換。ただし 1 点、既定の見た目が変わる: プロット領域の外だけのバンドは描かなくなる）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`.svelte.ts` の追加は無く、`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.2.0` → `v6.3.0`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要（charts に `.svelte.ts` は無い）。**既定の見た目が 1 点変わる**: `LineChart` の `bands` のうち、y 軸の範囲の外だけにあるバンドは、描かれなくなる（領域内に収まる有限のバンドは変わらない） |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                                                                                                                                                        |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                                                         |

### 消費側への注意

- 既存の `@banto/*` の公開 API は変わらない（追加のみ）。`Gauge` の `value` の型が `number | null` に広がるが、`number` を渡す既存の呼び出しはそのまま動く。
- **`LineChart` の `bands` は、プロット領域にクリップされる**。y 軸の範囲の外にあるバンドは描かれなくなる（範囲にまたがるバンドは範囲内だけが描かれ、はみ出さない）。バンドを軸の範囲の外に置いて見せていた画面は、軸の範囲を広げるか、開放端（`from` / `to` に `null`）で書き直す。
- docs のみの変更: ADR-0018 の段階 3 の記録（#367）、README の再構成（#368）。コード・公開 API への影響は無い。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `be031a4`、`workflow_dispatch`）: [run 37755291733](https://github.com/tyaro/banto/actions/runs/37755291733)（success）。
  - タグの push（`v6.3.0`）: [run 37755468457](https://github.com/tyaro/banto/actions/runs/37755468457)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（どちらの run も runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加（minor、追加のみ）

- feat(charts): `LineChart` に `gaps?: 'join' | 'break'`（既定 `'join'` = 従来どおり）を足した。`'break'` は欠測（null / undefined / NaN。数値化の前に欠測として扱い、0 にはしない）で線とエリアを別の部分パスに分け、欠測をまたいでつながない。軸の範囲とツールチップも欠測を無視する。`'join'`（既定）の値の扱い（`null` は従来どおり 0）は変えていない。純関数 `linePathSegments` / `areaPathSegments` を公開
- feat(charts): `LineChart` の `bands` を `OpenThresholdBand`（`from`/`to` が `number | null`）にし、null・非有限（±Infinity を含む。順序より前に位置で決める: `from` は下端、`to` は上端）を開放端（プロット端まで）として扱い、バンドをプロット領域にクリップする。領域内に収まる有限のバンドの出力は変わらない（領域外だけのバンドは描かなくなる）。純関数 `resolveBand` を公開
- feat(charts): `Gauge` の `value` を `number | null` にした。null・非有限は値の弧を描かず「—」を表示する（文字は `messages.gaugeNoValue`）。`GaugeThresholds` に下側のしきい値 `warningLow` / `dangerLow`（`value <=` で着色）を足した。上側の `warning` / `danger` は変わらない

## [6.2.0] - 2026-10-08

**v6.2.0 — `@banto/ui` の段階 2（#220）: メニュー部品（`Menu`・`MenuGroup`・`MenuItem`・`MenuSeparator`、#361）、フォーカストラップ・フォーカス復帰・window の Esc を備えた `CommandPalette`（#363）、トーストのストア `createToastStore()` と、アクション付きボタンを持つ `ToastHost`（#364）、テーマのトークン `--banto-scrim` と z-index の層（#361）を足した。[ADR-0018](docs/adr/0018-shared-ui-package.md) の段階 1・2 の決定を Accepted にした。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A は `@banto/ui` を使っているなら **Vite の `optimizeDeps.exclude` に `'@banto/ui'` を足す必要がある**（`@banto/ui` が初めて `.svelte.ts` を持つ。[ADR-0007](docs/adr/0007-derived-app-dev-optimizer-exclude.md)・#478）。経路 B は admin-template から写したメニュー・CommandPalette・トーストを `@banto/ui` からの import に替えられる。経路 C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                           |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.1.0` → `v6.2.0`（npm と Rust を同じタグに）。**`@banto/ui` を使う派生アプリは Vite の `optimizeDeps.exclude` に `'@banto/ui'` を足す**（必須。足さないと `pnpm dev` が 500 になる）。既存の `@banto/*` の公開 API は変わらない（追加のみ） |
| B. コピーしたテンプレート        | 任意 | admin-template のメニュー・CommandPalette・トーストの写しは `@banto/ui` から import できる。直書きのオーバーレイの値はトークンに置き換えられる。トーストの id は文字列で、アクションの prop は `onAction`                                      |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                        |

### 消費側への注意

- 既存の `@banto/*` の公開 API は変わらない（追加のみ）。
- **`@banto/ui` を使う派生アプリは、Vite の `optimizeDeps.exclude` に `'@banto/ui'` を足す**（`toast.svelte.ts` のため。トーストを使わなくても同じ。[ADR-0007](docs/adr/0007-derived-app-dev-optimizer-exclude.md)、[docs/upgrading.md](docs/upgrading.md) 3.1）。`pnpm build` と `pnpm check` ではこの漏れは分からない。`pnpm dev` で画面を開いて確かめる。
- 経路 B の写しは、取り込むなら `@banto/ui` から import し、トークン（`--banto-scrim`・`--banto-z-*`）で直書きを置き換える。トーストの id は数値から文字列、アクションの prop は `onClick` から `onAction`。詳細は下の「追加」の各項と [docs/upgrading.md](docs/upgrading.md) 3.2。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `021c71e`、`workflow_dispatch`）: [run 37706871381](https://github.com/tyaro/banto/actions/runs/37706871381)（success）。
  - タグの push（`v6.2.0`）: [run 37707052116](https://github.com/tyaro/banto/actions/runs/37707052116)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（どちらの run も runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加（minor、追加のみ）

- feat(ui): メニュー部品（`Menu`・`MenuGroup`・`MenuItem`・`MenuSeparator`）を admin-template の `components/menu/` から `@banto/ui` へ移した（#220 段階 2a、[ADR-0018](docs/adr/0018-shared-ui-package.md)）。DOM・CSS・props は変えていない（`MenuItem` の `icon` の型だけ `UiIconComponent` にした。lucide の部品はそのまま渡せる）。admin-template の `Header` は `@banto/ui` から import し、`components/menu/` は削除した。jsdom テストを足し、`/ui-demo` に Menu の見本を足した（開いていない状態のトリガーだけが画面に出る）。
- feat(theme): オーバーレイのスクリムと z-index の層のトークンを足した（#220 段階 2a）。`--banto-scrim`（`rgb(0 0 0 / 0.35)`。light・dark・glass で共通）と `--banto-z-header`（100）・`--banto-z-sidebar-scrim`（850）・`--banto-z-sidebar`（900）・`--banto-z-modal`（900。Modal / Drawer 用の予約）・`--banto-z-overlay`（1000）・`--banto-z-toast`（1000）。admin-template の直書き（`rgba(0, 0, 0, 0.35)` と z-index）をトークンに置き換えた。値は同じで、見た目も重なり順も変わらない。
  - 消費側への注意: 既存の `@banto/*` の公開 API は変わらない（追加のみ）。**経路 A**: `@banto/ui` を使っていれば、更新だけでメニュー部品が使える。トークンは `@banto/theme/css` を読み込んでいれば自動で入る。**経路 B**: admin-template から写した `components/menu/`（5 ファイル）はそのまま残しても動く。取り込むなら `@banto/ui` から import して写しを消す（[docs/upgrading.md](docs/upgrading.md) 3.2）。生の `rgba()` や z-index の直書きがあれば、新しいトークンへ置き換えられる（任意）。
- feat(ui): コマンドパレットの表示と操作を `@banto/ui` の `CommandPalette` にした（#220 段階 2b、[ADR-0018](docs/adr/0018-shared-ui-package.md) §8・決定 8）。props は `open`（bindable）・`items`・`search?`・`recentIds?`・`onExecute`・`onClose?`・`focusFallback?`・`messages?`。項目の型 `CommandPaletteItem` は admin-core の `PaletteCommand` と構造的に合う。既定の検索 `defaultCommandPaletteSearch` と、文言 `UiMessages` の `commandPalette*`（既定は日本語）を足した。banto-hub（banto-industrial #381）のフォーカストラップ・閉じたら開いた元へフォーカスを戻す・window で受ける Esc（消費済みの Esc と手前の層には譲る）を標準の振る舞いにした。見た目は admin-template の現行のまま。admin-template の `CommandPalette.svelte` は、コマンドの一覧・`searchCommands`・セッションのスコープ（#258）・最近使った記録・通知・Paraglide の文言だけを持つ包みになった。jsdom テストを足し、`/ui-demo` にコマンドパレットの見本（開くボタン）を足した。
  - 利用者に見える違い（admin-template）: 開いている間 Tab がパレットの外へ出ない。閉じると開く前にフォーカスがあった要素（ヘッダーの検索ボタンなど）へフォーカスが戻る（これまでは `<body>` に落ちていた）。フォーカスがパレットの外にあっても Esc で閉じる。それ以外の見た目・並び・操作は同じ。
  - 消費側への注意: 既存の `@banto/*` の公開 API は変わらない（追加のみ）。**経路 A**: `@banto/ui` を使っていれば、更新だけで `CommandPalette` が使える（CommandPalette 自体は `.svelte.ts` を持たないが、同じ v6.2.0 のトーストのストア（#364）で `optimizeDeps.exclude` への `@banto/ui` の追加が必要になった。上の「消費側への注意」を参照）。オーバーレイは `position: fixed` なので、`backdrop-filter` などを持つ要素の外に置く。**経路 B**: 写した `CommandPalette.svelte` はそのまま残しても動く。取り込むなら admin-template の新しい包みを差分として当てる（[docs/upgrading.md](docs/upgrading.md) 3.2）。banto-industrial の写しは段階 3 で置き換える。

- feat(ui): トーストのストアと表示を `@banto/ui` に移した（#220 段階 2c、[ADR-0018](docs/adr/0018-shared-ui-package.md) §8・決定 9。**段階 2 が完了**）。`createToastStore({ autoDismissMs?, maxToasts? })`（runes の `.svelte.ts`）と `ToastHost`（`store`・`messages?`）。`push(kind, message, options?)` は id を返し、`options` は `action?: { label, onAction }`（banto-hub の取り消しボタンを標準にした。`onClick` から改名）・`durationMs?`（既定 4000。`0`・負・`Infinity` は消さない）・`id?`（既存の id は置き換え）。アクションは押すと処理のあとで（例外でも）閉じ、閉じた後は呼ばない。`kind` は `success`・`error`・`info`・`warning`（admin-core の `NotificationKind` と構造的に同じ）。文言は `UiMessages.toastClose`、置き場所は CSS 変数 `--banto-toast-right`・`--banto-toast-bottom`、重なりは `--banto-z-toast`。admin-template の `toast.svelte.ts` は `createToastStore()` の 1 行、`ToastHost.svelte` は `@banto/ui` の薄い包み（Paraglide の「閉じる」）になり、`setup.ts` の `notify` の配線と各画面の `toastStore.push(...)` は変わらない。jsdom テスト（自動で消す時間・置き換え・上限・アクション・読み上げの領域）を足し、`/ui-demo` にトーストの見本（種類ごとのボタンとアクション付き）を足した。
  - 利用者に見える違い（admin-template）: 読み上げが 2 つの常設の領域に分かれた（`error`・`warning` は `role="alert"`、`success`・`info` は `role="status"`。以前は常設の 1 つの `role="status"`）。時間切れ前に閉じたトーストのタイマーは止まる。見た目・出現位置・4000ms は同じ。
  - **消費側への注意（`optimizeDeps.exclude`）**: `@banto/ui` が初めて `.svelte.ts`（`toast.svelte.ts`）を持つ。**`@banto/ui` を使う派生アプリは、Vite の `optimizeDeps.exclude` に `'@banto/ui'` を足す**（足さないと `pnpm dev` の依存オプティマイザが `import type` で 500 になる。[ADR-0007](docs/adr/0007-derived-app-dev-optimizer-exclude.md)、[docs/upgrading.md](docs/upgrading.md) 3.1）。トーストを使わなくても同じ。admin-template の `vite.config.ts`・外部利用 fixture・scaffold（`@banto/ui` は常に残るので `tree-svelte` を外すときの消し方を行ごとにした）・`verify:architecture` の rule `optimizedeps-svelte-source` を同じ変更で更新した。`pnpm build` と `pnpm check` ではこの漏れは分からない。**`pnpm dev` で画面を開いて確かめる。**
  - 消費側への注意: 既存の `@banto/*` の公開 API は変わらない（追加のみ）。**経路 A**: `@banto/ui` を使っていれば、更新と exclude の 1 行でトーストが使える。**経路 B**: 写した `toast.svelte.ts`・`ToastHost.svelte` はそのまま残しても動く。取り込むなら admin-template の薄い版に替え、exclude を足す（[docs/upgrading.md](docs/upgrading.md) 3.2）。banto-industrial の写し（banto-hub・chronogazer）は段階 3 で置き換える（`onClick` → `onAction`、id が数値から文字列）。外部利用 fixture は、v6.2.0 のタグを打つまで（`v6.1.0` に `createToastStore` が無いため）タグの経路だけ落ちていた。v6.2.0 で解消する。

## [6.1.0] - 2026-10-07

**v6.1.0 — 新パッケージ `@banto/ui`（`packages/ui`）を追加し、admin-template の汎用 UI 部品 7 つをそこへ移した（#220 段階 1。`/ui-demo` 見本ページと、`verify:architecture` の rule `package-bare-imports` を含む）。[ADR-0018](docs/adr/0018-shared-ui-package.md) の段階 1 を Accepted にした。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A は `@banto/ui` を任意の追加依存として足せる。経路 B は admin-template から写した `components/ui/` を `@banto/ui` からの import に替えられる（見本ページの取り込みも任意）。経路 C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                  |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | 任意 | `v6.0.0` → `v6.1.0`（npm と Rust を同じタグに）。新パッケージ `@banto/ui` を任意の追加依存として足せる（既存の `@banto/*` の公開 API は変わらない）   |
| B. コピーしたテンプレート        | 任意 | admin-template のコピーは `components/ui/` を `@banto/ui` から import するように替えられる（`LoadingState` の `label` は明示する）。`/ui-demo` は任意 |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                               |

### 消費側への注意

- 既存の `@banto/*` の公開 API は変わらない。`@banto/ui` を使うときは Git 依存で足す（`.svelte.ts` を持たないので `optimizeDeps.exclude` は増やさない）。詳細は下の「追加」の項と [docs/upgrading.md](docs/upgrading.md) 3.2。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `f8418fa`、`workflow_dispatch`）: [run 37619255296](https://github.com/tyaro/banto/actions/runs/37619255296)（success）。
  - タグの push（`v6.1.0`）: [run 37622287549](https://github.com/tyaro/banto/actions/runs/37622287549)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（どちらの run も runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加（minor、追加のみ）

- feat(ui): 新パッケージ `@banto/ui`（`packages/ui`）を追加し、admin-template の `components/ui/` にあった汎用 UI 部品 7 つ（EmptyState・ErrorState・IconButton・LoadingState・PageHeader・StatusBadge・SurfaceCard）を移した（#220 段階 1、[ADR-0018](docs/adr/0018-shared-ui-package.md)）。DOM・CSS・props は変えていない。依存は空で、既定のアイコン（lucide の 7 つ）は ISC 表記付きで同梱し、`icon` の型は `UiIconComponent`（lucide の部品もそのまま渡せる）。`LoadingState` の `label` の既定はパッケージの `defaultUiMessages.loading()`（日本語）。admin-template は `@banto/ui` から import し（`components/ui/` は削除）、`LoadingState` の `label` を全箇所で明示する。`/ui-demo` に 7 部品の主要な状態を並べた見本ページを足した（ナビには `VITE_BANTO_DEMO=1` のビルドのときだけ出る。ビジュアル回帰の対象）。`verify:architecture` に rule `package-bare-imports`（`packages/*/src` の素の import は `svelte`・`svelte/*` だけ）を足した。外部利用 fixture に `@banto/ui` を足した。
  - 消費側への注意: 既存の `@banto/*` の公開 API は変わらない。**経路 A**: `@banto/ui` は任意の追加依存（使うなら Git 依存で足す。`.svelte.ts` を持たないので `optimizeDeps.exclude` は増やさない）。**経路 B**: admin-template から写した `components/ui/` はそのまま残しても動く。取り込むなら `@banto/ui` から import し、`LoadingState` の `label` を明示する（[docs/upgrading.md](docs/upgrading.md) 3.2）。

### その他

- docs(adr): 共通 UI 部品を新パッケージ `@banto/ui`（`packages/ui`）に切り出す設計を [ADR-0018](docs/adr/0018-shared-ui-package.md)（段階 1 の判断は 2026-10-07 にオーナー決定で Accepted。段階 2 は未決）として記録した（#220 段階 0）。admin-template の `components/ui/` の 7 部品と、段階 2 の候補（メニュー部品・CommandPalette・ToastHost、banto-industrial の写しとの違い）の棚卸し、公開 API・アイコンの同梱・文言の注入・検査と配布の更新・オーナー判断事項を含む。コードは動かしていない。ADR が名指しする `@banto/ui` を、段階 1 まで `verify-architecture.mjs` の `DOCS_PACKAGE_REF_ALLOWLIST` に入れた。`docs/template-scope.md` §2.1 に提案中の注記を足した。

## [6.0.0] - 2026-10-07

**v6.0.0 — `WindowedListResource` の失敗を、`SnapshotListResource` と同じ形（`failures`・`messages`・`notify`）に変え、2 つのリソースのエラーの型を共通の `ListBlockError` にした（#344。破壊的変更）。あわせて、`tauri-check` への clippy の追加（#346）、`apps/admin-template/core/build.rs` の `rerun-if-changed`（#340）、`industrial-plan` の history 化（#312）。版の種類: major（`WindowedListResource` の `error`・`failedBlocks` の削除と、`SnapshotListError` などの改名）。
派生アプリへの影響: 経路 A は `WindowedListResource` の `error`・`failedBlocks` と、改名した 4 つの型・関数を使っている箇所を置き換える。経路 B は商品一覧のサーバーモードなどコピー済みの利用箇所と `core/build.rs` の取り込みが要る。経路 C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v5.1.0` → `v6.0.0`（npm と Rust を同じタグに）。`WindowedListResource` の `error`・`failedBlocks` を削除（`failures`・`messages`・`notify` に置き換え）。`SnapshotListError`・`isSnapshotListError`・`SnapshotListFailureCode`・`SnapshotListErrorFailure` を `ListBlockError`・`isListBlockError`・`ListBlockFailureCode`・`ListBlockErrorFailure` に改名（互換用の別名なし） |
| B. コピーしたテンプレート        | あり | 商品一覧のサーバーモード（`ItemsServerGrid.svelte`。`messages` と新しい Paraglide キー `items.loadTimeout`・`items.malformedResult`）、`apps/admin-template/core/build.rs`（#340。migration の `rerun-if-changed`）。詳細は下の「その他」の各項                                                                                                                                 |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                                                                                                                                                         |

### 消費側への注意

- 移行の手順書（docs/upgrading.md の例）は v6.0.0 では用意しない。後方互換も保たない（オーナー決定 2026-10-07）。下の「その他」の `WindowedListResource` の項（削除・名前の変更・追加・置き換え先）に従う。banto-industrial は、テストの `isSnapshotListError` を `isListBlockError` に替えるだけで済む。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `bb4bd76`、`workflow_dispatch`）: [run 37577202472](https://github.com/tyaro/banto/actions/runs/37577202472)（success）。
  - タグの push（`v6.0.0`）: [run 37577385697](https://github.com/tyaro/banto/actions/runs/37577385697)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（タグ前の run では runner に入っていた 1.98.1 から更新された後の版。タグの push の run では更新済みで変更なし）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- docs(layout): `docs/industrial-plan.md` を `docs/history/industrial-plan.md` へ移動した（#312 の industrial-plan の history 化）。2026-07-12 時点の初期構想で、banto-industrial の現行の計画は別リポジトリ側（`docs/plan.md`）が持つため、状態行を「履歴」に確定した。banto 側の現行の境界は `docs/template-scope.md` §5 末尾、配布方針は `docs/publishing.md` を参照する。ファイル名は不変なので `industrial-plan.md §2` のようなラベル参照はそのまま有効。参照は同じ PR で新パスに更新済み。過去の節に書かれた旧パスは書き換えない。GitHub 上の旧 blob リンクは追従しない（スタブは置かない）。`.prettierignore` に `docs/history/industrial-plan.md` を追加（移動前と同じく整形対象外）。旧 → 新の対応表:

  | 旧                        | 新                                |
  | ------------------------- | --------------------------------- |
  | `docs/industrial-plan.md` | `docs/history/industrial-plan.md` |

- admin-template の src-tauri の doc コメントが Rust 1.98 の clippy（`doc_lazy_continuation`）に掛かるのを直し、`tauri-check` に `cargo clippy -p admin-template` を足した（#346）。

- fix(admin-template): `apps/admin-template/core` に `build.rs` を足し、`migrations-sqlite`・`migrations-postgres` に `cargo:rerun-if-changed` を出すようにした（#340）。安定版の `sqlx::migrate!` は既存の migration ファイルを `include_str!` で追跡するが、新しい migration ファイルの追加は検知しないため、migration を足しただけの増分ビルドがそれを含まないバイナリを作りうる状態だった。リリース済みの migration ファイルは変えていない（`verify:migrations` 通過）。`sqlx::migrate!` を使う crate は、このリポジトリではこの crate だけ。
  - 派生アプリへの影響: 経路 B は、admin-template の `core` をコピーしたアプリ（banto-industrial など）は `apps/admin-template/core/build.rs` もコピーし、自分の migration のディレクトリ名に合わせる（banto-industrial は `Migrator::dangerous_set_table_name` で独自の migration のディレクトリを使うので、そのディレクトリを `rerun-if-changed` に書く）。scaffold の各プリセットは `core` を残すので `build.rs` も残る。経路 A・C は変更なし。

- feat(admin-core, admin-template)!: **破壊的変更（v6.0.0 で出す）** `WindowedListResource` の失敗を、`SnapshotListResource`（#342）と同じ形にした。種類（コード）で見分けられ、文言を差し替えられ、トーストを止められ、全ブロック分を見られる（#344、[ADR-0015 の追記](docs/adr/0015-snapshot-list-resource.md)）。あわせて、2 つのリソースのエラーの型を共通の名前 `ListBlockError` にした。オーナー決定（2026-10-07）により後方互換は保たず、互換用の別名は残さない。移行の手順書は用意しない（下の置き換え先に従う）。
  - 削除: `WindowedListResource` の `error`（最新の失敗 1 件）と `failedBlocks`。
  - 名前の変更（`SnapshotListResource` の型。中身は同じ）: `SnapshotListError` → `ListBlockError`（`name` も `'ListBlockError'`）、`isSnapshotListError` → `isListBlockError`、`SnapshotListFailureCode` → `ListBlockFailureCode`、`SnapshotListErrorFailure` → `ListBlockErrorFailure`。`SnapshotListFailure`・`SnapshotListExpiredFailure`・`SnapshotListMessages`・`defaultSnapshotListMessages` は名前も中身も変えていない（`SnapshotListMessages` は `ListBlockMessages` を拡張する形にした）。
  - 追加（`WindowedListResource` の状態）: `failures: readonly ListBlockErrorFailure[]`。ブロック順・ブロックごとに 1 件で、`{ block, kind: 'error', code, error }`。消える条件は従来の `failedBlocks` と同じ（そのブロックの取得の成功、`setParams()`）。`refresh()` の間も残り、取り直しが済むと成功なら消え、失敗なら新しい失敗に置き換わる。`refresh()` が表示中の行を世代が落ち着くまで保つ挙動（#212）は変えていない（`failures` は落ち着く前にも更新される）。
  - 追加（`WindowedListResource` のオプション）: `messages`（`timeout(ms)`・`malformed()`。リソースが自分で作る失敗の文言。既定は今の英語の文言。関数が投げたら既定の文言）、`notify`（`true` が既定、`false`、または `ListBlockErrorFailure` を受ける述語。投げた述語は `false` 扱い）。
  - 追加（型・値）: `ListBlockMessages`（`timeout`・`malformed`）と `defaultListBlockMessages`、`ListBlockNotify`（`notify` の型）。
  - 挙動の変更（`WindowedListResource`）: `getList` が投げた `ProviderError` は同じオブジェクトのまま `failures` に入る（`code: 'request'`。これまでも同じオブジェクトだった）。`ProviderError` でない値（`getDataProvider()` が投げた場合も）は、これまでの `ProviderError` の代わりに `ListBlockError('request')` に包む（`message` は従来どおり `String(thrown)`、投げた値は `cause`）。期限切れ・応答の形の不正は `ListBlockError`（`code` が `'timeout'`・`'malformed'`）になる（既定の `message` は従来と同じ）。`getList` が投げた `ListBlockError` は自分の `code` のまま入る。`WindowedListResource` が自分で `'boundaryMismatch'` を作ることは無い。
  - 共通の型にした理由: 2 つのリソースは同じ「ブロックの失敗」を出すので、アプリは `isListBlockError()` と `code` の 1 つの見分け方でどちらの失敗も扱える。`requestFailure`（投げた値の扱い）・文言の解決・`notify` の判定は `blockFetch.ts` の 1 か所に寄せた（`SnapshotListResource` にあった実装を共有にした）。`WindowedListError` を別に作ると、同じ形のクラス・型・判定関数が 2 組になり、`ProviderError` を投げ分けるデータソース（同じ取得関数を両方で使う場合など）で `code` の保ち方が食い違う。
  - admin-template: 商品一覧のサーバーモード（`ItemsServerGrid.svelte`）は `messages` に Paraglide の文言（新しいキー `items.loadTimeout`・`items.malformedResult`、ja/en）を渡し、読み込み失敗の帯を `failures` が空でないときに出す（以前は `error`。トーストの文言が英語の固定文だった）。
  - 派生アプリへの影響: 経路 A は `WindowedListResource` の `failedBlocks`・`error` と、名前を変えた 4 つ（`SnapshotListError`・`isSnapshotListError`・`SnapshotListFailureCode`・`SnapshotListErrorFailure`）を使っている箇所がコンパイルエラーになるので、`failures`・`ListBlockError`・`isListBlockError`・`ListBlockFailureCode`・`ListBlockErrorFailure` に置き換える（`error.name === 'SnapshotListError'` で見分けている箇所はコンパイルエラーにならないので検索して直す）。banto-industrial は `WindowedListResource` を使っておらず、名前の変更の影響は `isSnapshotListError` → `isListBlockError`（banto-hub と ChronoGazer のテスト 3 ファイル）だけ（`SnapshotListMessages`・`SnapshotListFailure` はそのまま）。経路 B は商品一覧（`src/routes/(app)/items/ItemsServerGrid.svelte`）と `messages/{ja,en}.json` の 2 キーを写す。経路 C は変更なし（DB・設定の変更は無い）。

## [5.1.0] - 2026-10-07

**v5.1.0 — banto-server の CSP の `connect-src` を広げる選び方に、接続元と要求の宛先（authority）の両方がループバックの要求だけを選ぶ `request_is_loopback_local` を足した（#349、banto-industrial#505 の続き）。同じホストのリバースプロキシ配下でも、アプリ自身のデスクトップシェルの要求だけを広げられる。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A は任意（自分のデスクトップシェルが自分の HTTP の画面を開くアプリは、`extra_connect_src_when` の選び方を `request_is_loopback_local` に替えることを推奨）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | 任意 | `v5.0.0` → `v5.1.0`（npm と Rust を同じタグに）。`banto-server` に `request_is_loopback_local` を追加（追加のみ）。banto-hub などは `extra_connect_src_when(request_from_loopback_peer)` を `extra_connect_src_when(request_is_loopback_local)` に替える（同じホストのプロキシ配下でも LAN の閲覧者は厳格なままになる） |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                                                                                                                                                                                                |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                                                                                                 |

### 消費側への注意

- `request_is_loopback_local` は、プロキシが `Host` を上流のアドレスに書き換える設定では効かない（Caddy の `header_up Host {upstream_hostport}` など）。詳細は下の「その他」の安全性の項。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `076c6a7`、`workflow_dispatch`）: [run 37497619879](https://github.com/tyaro/banto/actions/runs/37497619879)（success）。
  - タグの push（`v5.1.0`）: [run 37497813180](https://github.com/tyaro/banto/actions/runs/37497813180)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- feat(banto-server): セキュリティヘッダーの CSP の `connect-src` を広げる選び方に、接続元と要求の宛先（authority）の両方がループバックの要求だけを選ぶ `request_is_loopback_local` を足した（banto-industrial#505 の続き、2026-10-06 オーナー決定）。版の種類: minor（追加のみ。後方互換。v5.1.0 で出す）。v5.0.0 の `request_from_loopback_peer` だけでは、banto-hub の運用手引きが勧める同じホストの Caddy（`reverse_proxy 127.0.0.1:8722`）の配下ですべての要求の接続元がループバックになり、LAN の閲覧者への応答も広がっていた。
  - 追加: `request_is_loopback_local(&Request) -> bool`。`request_from_loopback_peer` が真で、かつ宛先が `127.0.0.0/8`・`[::1]`・IPv4 射影のループバック（`[::ffff:127.0.0.1]`）の IP リテラルか `localhost`（大文字小文字は区別しない）のときだけ真。宛先は `Host` ヘッダーと URI の authority（HTTP/2 の `:authority`、HTTP/1.1 の絶対形式）から読み、片方だけならそれ、両方あれば一致（大文字小文字は区別しない）が条件で、食い違い・どちらも無い・`Host` が複数・解釈できない（ポートが空や数字以外、閉じていない `[`、userinfo など）は偽（厳格なまま）。`localhost.`（末尾のドット）と `*.localhost` は受け付けない（シェルは自分が bind したアドレスへ移るので要らず、受け付ける名前が増えるほどプロキシ経由の要求がローカルに見える道が増えるため）。`X-Forwarded-Host`・`Forwarded` は見ない。`request_from_loopback_peer` はそのまま残す。
  - 安全性: `Host` は相手が決められるので、それだけで広げる理由にはしない。接続元のループバックとの AND なら狭める方向にしか働かない。ブラウザは移った URL から `Host` を付けるので、`Host` を保つ同じホストのプロキシ（Caddy の既定）経由の LAN の閲覧者は公開名や LAN のアドレスを出して厳格なまま、デスクトップシェルは `http://127.0.0.1:<port>` へ移るので広がる。`Host` を偽る相手は、自分が受け取る応答の CSP を変えるだけ（ただし共有キャッシュが `Host` をまたいで応答を使い回さない前提。下の「共有キャッシュ」を参照）。残る注意: プロキシが `Host` を上流のアドレスに書き換える設定（Caddy の `header_up Host {upstream_hostport}`、nginx の既定の `proxy_set_header Host $proxy_host` で `proxy_pass` が `127.0.0.1`・`localhost` を指す場合）では効かないので、`Host` を保つ（nginx は `proxy_set_header Host $host`）か、広げる設定を入れないか、プロキシで CSP を上書きする。共有キャッシュ: nginx の `proxy_cache`＋`proxy_cache_valid` を明示的に有効にし、公開名とループバックの `Host` を同じ location で受けると、既定の `proxy_cache_key`（`$scheme$proxy_host$request_uri`）は受け取った `Host` を含まないので、`Host: 127.0.0.1` 向けに広がった応答が公開名の閲覧者へ返りうる（banto の静的 HTML は `Cache-Control`・`Vary` を付けない）。共有キャッシュを前段に置かないか、受け取った `Host` ごとに分ける（`proxy_cache_key` に `$host` を含める）。公開側では想定外の `Host` を拒否するか、プロキシで CSP を厳格な値に上書きする（nginx のキャッシュは既定で無効、Caddy の標準構成は影響なし）。詳しくは `security_headers.rs` 冒頭の doc と spec §11.2。
  - 派生アプリへの影響: 経路 A は、自分のデスクトップシェルが自分の HTTP の画面を開くアプリ（banto-industrial の banto-hub など）で `extra_connect_src_when(request_from_loopback_peer)` を `extra_connect_src_when(request_is_loopback_local)` に替える（同じホストのプロキシ配下でも LAN の閲覧者は厳格なままになる）。シェルが `127.0.0.1`・`[::1]`・`localhost` 以外の名前（例: LAN の IP）で自分の画面を開く場合は広がらないので、ループバックのアドレスで開く。経路 B・C は変更なし。

## [5.0.0] - 2026-10-06

**v5.0.0 — `SnapshotListResource` の失敗を、種類（コード）で見分けられ、文言を差し替えられ、トーストを止められ、全ブロック分を見られる形に変えた（#342。破壊的変更）。あわせて、banto-server の CSP の `connect-src` の拡張（#345）、`BASE_PATH` 付きビルドのナビの修正（#332）、docs の `design/`・`reviews/` への移動（#312）、外部利用 fixture の前提の記載（#337）、CI の `verify:migrations`（#339 P1）。版の種類: major（`SnapshotListResource` の `error`・`failedBlocks`・`SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE` の削除）。
派生アプリへの影響: 経路 A は `SnapshotListResource` を使っている箇所を `failures`・`code`・`messages` に置き換える。経路 B は監査ログ画面などコピー済みの利用箇所の取り込みが要る。経路 C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                             |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v4.0.0` → `v5.0.0`（npm と Rust を同じタグに）。`SnapshotListResource` の `error`・`failedBlocks`・`SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE` を削除（`failures`・`messages`・`notify` に置き換え）。`banto-server` に `with_security_headers_using` など（追加のみ） |
| B. コピーしたテンプレート        | あり | 監査ログ画面（`SnapshotListResource` の利用箇所。`messages` と新しい Paraglide キー）、`BASE_PATH` のナビの修正（#332）、CSP の照合テスト `core/tests/tauri_window_csp.rs`（#345）。詳細は下の「その他」の各項                                                   |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                                          |

### 消費側への注意

- 移行の手順書（docs/upgrading.md の例）は v5.0.0 では用意しない（オーナー決定 2026-10-06）。下の「変更」の `SnapshotListResource` の項（削除・追加・置き換え先）に従う。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `3419112`、`workflow_dispatch`）: [run 37397240508](https://github.com/tyaro/banto/actions/runs/37397240508)（success）。
  - タグの push（`v5.0.0`）: [run 37397380175](https://github.com/tyaro/banto/actions/runs/37397380175)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- feat(banto-server): セキュリティヘッダーの CSP の `connect-src` を、要求ごとに広げられるようにした（banto-industrial#505、2026-10-06 オーナー決定）。アプリ自身のデスクトップシェルが Tauri の WebView でこのサーバーの HTTP の画面へ移ると、その画面には窓の CSP ではなく応答の CSP（`connect-src 'self'`）が掛かり、Tauri IPC（`http://ipc.localhost`）の fetch が止められる（banto-industrial の banto-hub シェルの `/status` で、読み込みのたびに違反が 2 件出ていた。Tauri が postMessage に切り替えるので動作はしていた）。既定の `with_security_headers` は変えていない。
  - 追加: `with_security_headers_using(router, SecurityHeaders)`。`SecurityHeaders::new()` が既定の厳格な CSP で、`extra_connect_src(sources)` で connect-src に足す（`Result<_, InvalidCspSource>`。空・`;`・`,`・空白・制御文字・ASCII 以外は組み立ての時点で拒む）。`extra_connect_src_when(selector)` を付けると、選ばれた要求の応答にだけ足す（付けなければすべての応答）。広げられるのは connect-src だけで、ほかのディレクティブと 3 つのヘッダーは変わらない。
  - 追加: `request_from_loopback_peer`（TCP の接続元がループバックかを `ConnectInfo<SocketAddr>` から見る選び方。無ければ厳格なまま）、`TAURI_IPC_CONNECT_SRC`（`ipc:`・`http://ipc.localhost`）、`CONTENT_SECURITY_POLICY` を公開し、`SecurityHeaders::content_security_policy()` で広げた後の値をそのまま取れるようにした（窓の CSP と比べるテストで、文字列の置き換えが要らない）。
  - 安全性: 普通のブラウザが広げた CSP を受け取っても、`ipc:` は扱えない scheme なので何も起きず、`http://ipc.localhost` は閲覧者自身のループバックの 80 番（http）と 443 番（https。CSP では http の source が https にも一致し、省略した port は接続先 scheme の既定 port に一致する）を指すだけ（外部への持ち出し先にはならない）。それでも LAN のブラウザは厳格なままにするため、`request_from_loopback_peer` で選ぶのを推奨する。リクエストのヘッダー・クエリ・`Host` は相手が決められるので選ぶ材料にしない。詳しくは `security_headers.rs` 冒頭の doc と spec §11.2。
  - admin-template: 窓の CSP（`src-tauri/tauri.conf.json`）を、上の API で作った「応答の CSP ＋ Tauri IPC」と文字列で照合するテスト `core/tests/tauri_window_csp.rs` を足した（`verify-architecture.mjs` rule 12 のディレクティブ単位の検査はそのまま）。admin-template 自身のサーバーの組み立ては変えていない（窓は Tauri のアセットを表示し、HTTP の画面へは移らないため）。
  - 派生アプリへの影響: 経路 A は不要（既定は同じ）。自分のデスクトップシェルが自分の HTTP の画面を開くアプリ（banto-industrial の banto-hub など）は、`with_security_headers(app)` を `with_security_headers_using(app, SecurityHeaders::new().extra_connect_src(TAURI_IPC_CONNECT_SRC)?.extra_connect_src_when(request_from_loopback_peer))` に替える。窓の CSP を比べるテストは、`connect-src 'self'` の置き換えをやめて `content_security_policy()` を使える。注意: 同じホストのリバースプロキシ（ADR-0003 の TLS 終端など）がループバック経由でこのサーバーへつなぐ構成では、すべての要求の接続元がループバックになるので、`request_from_loopback_peer` は LAN のブラウザへの応答も広げてしまう（LAN の閲覧者の画面に注入されたスクリプトから、その閲覧者自身の端末の 80 番（http）と 443 番（https。理由は上と同じ）に届くようになる）。その構成では広げる設定を入れない（シェルは postMessage で動き、残るのは CSP の違反の報告だけ）か、プロキシがループバック以外のアドレスからつなぐようにする。`X-Forwarded-For` などの転送ヘッダーで選ぶのも、プロキシが上書きしない限り相手が決められるので不可。経路 B は、admin-template の CSP の照合テストを写すなら `core/tests/tauri_window_csp.rs` をコピーする。経路 C は変更なし（DB・設定の変更は無い）。

- feat(admin-core, admin-template)!: **破壊的変更（v5.0.0 で出す）** `SnapshotListResource` の失敗を、種類（コード）で見分けられ、文言を差し替えられ、トーストを止められ、全ブロック分を見られる形にした（#342、[ADR-0015 の追記](docs/adr/0015-snapshot-list-resource.md)）。オーナー決定（2026-10-06）により後方互換は保たず、互換用の別名は残さない。`WindowedListResource` は変えていない（同じ形にそろえるのは別 Issue。既定の英語の文言は `blockFetch.ts` で共有した）。
  - 削除: `SnapshotListResource` の `error`（最新の失敗 1 件）と `failedBlocks`、定数 `SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE`。
  - 追加（状態）: `failures: readonly SnapshotListFailure[]`。ブロック順・ブロックごとに 1 件で、`{ block, kind: 'error', code, error }` か `{ block, kind: 'expired' }`。消える条件は従来の `failedBlocks` と同じ（そのブロックの取得の成功、`setParams()`、縮んだ件数の外）。`expired`（今の世代が止まっている）は残した。
  - 追加（型・値）: `SnapshotListFailureCode`（`'request'`・`'timeout'`・`'boundaryMismatch'`・`'malformed'`）、`SnapshotListError`（`ProviderError` の派生、`code` を持つ）と `isSnapshotListError`、`SnapshotListFailure`・`SnapshotListErrorFailure`・`SnapshotListExpiredFailure`、`SnapshotListMessages` と `defaultSnapshotListMessages`。
  - 追加（オプション）: `messages`（`timeout(ms)`・`boundaryMismatch()`・`malformed()`。リソースが自分で作る失敗の文言。関数で受け取り、既定は今の英語の文言。関数が投げたら既定の文言）、`notify`（`true` が既定、`false`、または `SnapshotListErrorFailure` を受ける述語。投げた述語は `false` 扱い。失効は従来どおり通知しない）。
  - 挙動の変更: 取得関数が投げた `ProviderError` は同じオブジェクトのまま `failures` に入る（`code: 'request'`。アプリの派生クラスの情報が残る）。`ProviderError` でない値は、これまでの `ProviderError` の代わりに `SnapshotListError('request')` に包む（`message` は従来どおり `String(thrown)`、投げた値は `cause`）。期限切れ・境界の食い違い・応答の形の不正は `SnapshotListError`（`code` 付き）になる（既定の `message` は従来と同じ）。取得関数が投げた `SnapshotListError` は自分の `code` のまま入る。
  - admin-template: 監査ログ画面は `messages` に Paraglide の文言（新しいキー `audit.loadTimeout`・`audit.boundaryMismatch`・`audit.malformedResult`、ja/en）を渡し、失敗の表示を `failures` の最も前のブロックの `'error'` から出す（以前は英語の固定文がそのまま出ていた）。
  - 派生アプリへの影響: 経路 A は `failedBlocks`・`error`・`SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE` を使っている箇所がコンパイルエラーになるので、`failures`・`code`・`messages` に置き換える（文言のための期限の二重掛けや文字列比較は要らなくなる）。経路 B は監査ログ画面（`src/routes/(app)/audit-log/+page.svelte`）と `messages/{ja,en}.json` の 3 キーを写す。経路 C は変更なし（DB・設定の変更は無い）。

- fix(admin-template): `BASE_PATH`（Pages のデモ）を付けたビルドでも、サイドバーの選択表示・ページ見出し・ナビのバッジが合うようにする（#332）。base を含まない表のパス（`/dashboard`）と base 込みの `page.url.pathname`（`/banto/dashboard`）を直接比べていたため、デモでは一致しなかった。比較を `isPathActive(path, pathname)`（新設 `src/lib/appPath.ts`、`navigation.ts` が再エクスポート）に一本化し、表のパスを `resolveAppPath()` で base 込みにしてから比べる（公開ビューアのガード・設定カテゴリの選択も同じ関数に寄せた）。base が空なら従来と同じ挙動。派生アプリへの影響: 経路 A は不要。経路 B は `navigation.ts` / `Sidebar.svelte` / `navBadges.svelte.ts` をコピーしているなら、新設の `appPath.ts` も一緒にコピーする（`base` を使わない派生アプリでは挙動は変わらない）。
- docs(fixture): 外部利用 fixture の `pnpm check` は、ルートで `pnpm install` 済みでないと `playwright.config.ts` の `@playwright/test` を解決できず失敗する（CI は先にルートを入れるので通る）。前提を docs/upgrading.md 8.3 と fixture の tsconfig.json に明記した。fixture に `@playwright/test` は足さない（2 つ入ると Playwright が二重読み込みで落ちるため）。
- docs(layout): 設計文書 8 本を `docs/` 直下から `docs/design/` へ移動した（#312 の design/ への移動。ファイル名は不変なので `attachments-plan §3.7` のようなラベル参照はそのまま有効）。コード・scripts・CI・docs 内の参照は同じ PR で新パスに更新済み。ただしリリース済みの migration（`apps/admin-template/core/migrations-sqlite/0006_attachments.sql` と `migrations-postgres/0006_attachments.sql`）のコメントは旧パス `docs/attachments-plan.md` のまま残す。SQLx は migration 本文をコメント込みで checksum して DB に記録するため、コメント 1 行の書き換えでも v4.0.0 以前に作った DB が `VersionMismatch(6)` で起動しなくなる。旧パスの残存検索ではこの 2 ファイルを既知の例外として扱う（リリース済み migration の書き換えは新設の `pnpm verify:migrations` が CI で検出する）。過去の節に書かれた旧パスは書き換えない。GitHub 上の旧 blob リンクは追従しない（スタブは置かない）。`.prettierignore` に `docs/design/*.md` を追加（移動前と同じく整形対象外）。旧 → 新の対応表:

  | 旧パス                              | 新パス                                     |
  | ----------------------------------- | ------------------------------------------ |
  | `docs/attachments-plan.md`          | `docs/design/attachments-plan.md`          |
  | `docs/display-preset-plan.md`       | `docs/design/display-preset-plan.md`       |
  | `docs/report-plan.md`               | `docs/design/report-plan.md`               |
  | `docs/scaffold-presets-plan.md`     | `docs/design/scaffold-presets-plan.md`     |
  | `docs/session-controller-design.md` | `docs/design/session-controller-design.md` |
  | `docs/viewer-public-plan.md`        | `docs/design/viewer-public-plan.md`        |
  | `docs/visual-refresh-design.md`     | `docs/design/visual-refresh-design.md`     |
  | `docs/visual-refresh-plan.md`       | `docs/design/visual-refresh-plan.md`       |

- docs(layout): レビュー・調査記録 4 本を `docs/` 直下から `docs/reviews/` へ移動した（#312 の reviews/ への移動。ファイル名は不変なので `M-review 2026-08 §2.1`・`CR-N`・`AD-N`・`choiapp-feedback-2026-09 §3.2` のようなラベル参照はそのまま有効）。コード・scripts・CI・docs 内の参照は同じ PR で新パスに更新済み。過去の節に書かれた旧パスは書き換えない。GitHub 上の旧 blob リンクは追従しない（スタブは置かない）。`.prettierignore` に `docs/reviews/*.md` を追加（移動前と同じく整形対象外）。旧 → 新の対応表:

  | 旧パス                                   | 新パス                                           |
  | ---------------------------------------- | ------------------------------------------------ |
  | `docs/choiapp-feedback-2026-09.md`       | `docs/reviews/choiapp-feedback-2026-09.md`       |
  | `docs/feature-review-2026-08.md`         | `docs/reviews/feature-review-2026-08.md`         |
  | `docs/maintainability-review-2026-07.md` | `docs/reviews/maintainability-review-2026-07.md` |
  | `docs/maintenance-review-2026-08.md`     | `docs/reviews/maintenance-review-2026-08.md`     |

## [4.0.0] - 2026-10-05

**v4.0.0 — SvelteKit 3（`@sveltejs/kit` 3・`@sveltejs/adapter-static` 4）と TypeScript 6（`^6.0.0`）への移行（#325）、配線①のナビゲーション待ちの修正（#326）、docs の誤った spec 参照の修正（#312 PR-B）。版の種類: major（破壊的変更。`@banto/*` の中身は変わらないが、peer の前提が SvelteKit 3・TypeScript 6 に変わる）。
派生アプリへの影響: 経路 A は依存の範囲（`@sveltejs/kit` ^3・`@sveltejs/adapter-static` ^4・`typescript` ^6.0.0）を合わせる。経路 B はコピーしたテンプレートを SvelteKit 3 の形に移す作業が要る（`npx sv migrate sveltekit-3 --tasks all --confirm` の後に写すもの、見直すものがある。下の「消費側への注意」と docs/upgrading.md の例 4）。経路 C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v3.0.1` → `v4.0.0`（npm と Rust を同じタグに）。`@banto/*` の中身は変わらない（theme の `./css` の型の追加を除く）が、peer の前提が変わる: `@sveltejs/kit` ^3・`@sveltejs/adapter-static` ^4・`typescript` ^6.0.0（7 は kit 3 の対象外）。Rust（`banto-*`）は版数のみ                                                                                                        |
| B. コピーしたテンプレート        | あり | `vite.config.ts`（`svelte.config.js` を廃止して設定を移す）・`tsconfig.json`・`package.json` の `imports`（`#lib`。拡張子必須）・`navigation.ts` の `AppPath` / `resolveAppPath`・`(app)/+layout.ts` の閲覧公開のガード。自動移行の `resolve('')`・`.slice(1)` を見直す。#326 の `navigationSettled.svelte.ts` と配線①。`@banto/theme/css` の `declare module` はもう要らない |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                                                                                                                                                       |

### 消費側への注意

- 経路 A・B とも SvelteKit 3 への移行が前提になる。手順は [docs/upgrading.md](docs/upgrading.md) の「例 4（v3.0.x → v4.0.0）」（経路 A/B/C、`sv migrate sveltekit-3` の後に写すもの、自動移行の `resolve('')`・`.slice(1)` の見直し）に従う。
- SvelteKit 2 に留まる派生アプリは v3.0.x のままにする（v4.0.0 の `@banto/*` は kit 3 を前提にする）。#326 の修正だけが欲しい場合は、経路 B の `navigationSettled.svelte.ts` と配線①の写しを v3.0.1 のまま取り込める（詳細は「修正」の #326 の項）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `4df169c`、`workflow_dispatch`）: [run 37272937503](https://github.com/tyaro/banto/actions/runs/37272937503)（success）。
  - タグの push（`v4.0.0`）: [run 37273113295](https://github.com/tyaro/banto/actions/runs/37273113295)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- docs: コード内のコメントにある誤った `spec §3.x` 参照（実体は `attachments-plan` / `report-plan` の節）を
  `attachments-plan §N` / `report-plan §N` に修正した（Rust・TS・Svelte・CSS・e2e のコメントのみ、動作変更なし、#312 PR-B）
- docs: SvelteKit 3 の形に合わせた（#325 PR3）。conventions §5 の機械検査の対象を `#lib`（旧 `$lib`）に、§13 の例を `#lib/paraglide/messages.js` にし、現役の docs・README・コード内のコメントの `$lib` を `#lib` にした（`docs/history/` と ADR・設計記録の当時の記述は凍結のまま）。`docs/architecture-flows.md` の再 load を `refreshAll()` に。`docs/upgrading.md` に v3 → v4 の移行手順（例 4。経路 A/B/C、`sv migrate sveltekit-3` の後に写すもの、自動移行の `resolve('')`・`.slice(1)` の見直し）と、確認する組み合わせに SvelteKit `^3.0`・TypeScript `^6.0` を足した

### 変更

- feat(admin-template)!: **破壊的変更** テンプレートを SvelteKit 3（`@sveltejs/kit` 3.0・`@sveltejs/adapter-static` 4.0）と TypeScript 6（`^6.0.0` に固定。7 は kit 3 の対象外）に上げた（#325 PR1）。`svelte.config.js` を廃止して設定を `vite.config.ts` の `sveltekit({...})` に移し、`$lib` を `#lib`（package.json の `imports`。拡張子が必須）に、`base` を `resolve()` に置き換えた。ナビ・設定カテゴリの表の `path` は `AppPath`（`` `/${Path}` ``）で型付けし、URL にするときは `resolveAppPath()`（`src/lib/navigation.ts`）を通す。自動移行（`sv migrate sveltekit-3`）が閲覧公開のガード（`(app)/+layout.ts`）を `resolve('')`（kit 3 では `base + '/'`）で書き換え、全画面が最初の項目へ戻される（その項目自身でリダイレクトのループ）不具合は直し、単体（`guard.test.ts`）と E2E（public-viewer）で押さえた。非推奨の `invalidateAll`・`error(status, { message })` は #325 PR3 で置き換えた（下の項）。
  - 派生アプリへの影響: **経路 A** の `@banto/*`・`banto-*` は、この項では中身の変更なし（packages の devDependency の `typescript` だけ。theme の型の追加は下の #325 PR3 の項）。**経路 B** はコピーしたテンプレートを kit 3 の形に移す: `npx sv migrate sveltekit-3 --tasks all` を流したうえで、この版の `vite.config.ts`・`tsconfig.json`・`package.json` の `imports`・`navigation.ts` の `AppPath` / `resolveAppPath`・`(app)/+layout.ts` の閲覧公開のガードを写す。自動移行が入れる `resolve('')` や ``resolve(`${path}`.slice(1))`` は必ず見直す。TS 6 は副作用 import を検査するが、`@banto/theme/css` の型は theme が持つようになった（下の #325 PR3 の項）ので、TS から `import '@banto/theme/css'` していても宣言は要らない（v3.x に合わせて自前で置いた `declare module '@banto/theme/css'` は外してよい）。経路 C（DB・設定）は変更なし。
- feat(theme): `@banto/theme/css` の型を theme 自身に持たせた（#325 PR3）。`./css` の export に `types` 条件（`src/css/banto.css.d.ts`、`export {};` だけの空のモジュール）を先頭で足し、`default` は従来どおり CSS。TypeScript 6 の副作用 import の検査（`noUncheckedSideEffectImports`）に対して、利用する側が `declare module` を足さずに `import '@banto/theme/css'` できる。架空の default export やクラス名の型は作らない（実行時の挙動は変えない）。型の解決は `moduleResolution: "bundler"`（kit 3 の `$app/tsconfig` の既定）が前提。外部利用 fixture の `src/ambient.d.ts` は外した（既定状態の fixture は v4.0.0 のタグ後に ref を上げるまでローカルの check が通らない。docs/publishing.md）。
  - 派生アプリへの影響: **経路 A**（theme をタグで上げるだけ。自前の `declare module '@banto/theme/css'` は残っていても害はなく、外してよい）。
- refactor(admin-template): kit 3 で非推奨になった API を置き換えた（#325 PR3）。`$app/navigation` の `invalidateAll()` → `refreshAll()`（`routes/+layout.svelte` の起動待ちのやり直し、`routes/+error.svelte` の「再試行」、`(app)/+layout.svelte` の配線①、`settings/SecuritySection.svelte` の認証設定の保存後）、`error(status, { message, …})` → `error(status, message, { … })`（`#lib/banto/startupGate.ts`・`(app)/+layout.ts`）。kit 3.0 の `refreshAll()` は `invalidateAll()` と同じ `_invalidate()` を通り、違いは `page.state` を消さないことだけ（テンプレートは shallow routing を使わない）。`error()` が投げる本体（`{ status, message, startupPending? }`）も同じ。#326 の `isNavigationSettled()` と #321 の起動待ちのやり直しの条件はそのまま。`@banto/admin-core` の同名の `invalidateAll()`（一覧の再取得の通知）は SvelteKit の API ではないので変えていない。
  - 派生アプリへの影響: **経路 B のみ**。コピーしたテンプレートで同じ置き換えをする（`invalidateAll` は import と呼び出しの名前を変えるだけ。shallow routing の `page.state` を使っている派生アプリは、`refreshAll()` では消えなくなる点だけ確かめる）。
- ci: SvelteKit 3 への移行に合わせた（#325 PR3）。`external-consumer.yml` の PR の paths から廃止した `apps/admin-template/svelte.config.js` を外し（`vite.config.ts` は既に対象）、`deploy-demo.yml` のコメントの `svelte.config.js` を `vite.config.ts` に。`ci.yml` の audit ジョブにあった cookie 0.6.0（GHSA-pxg6-pf52-xh8x、#282）の据え置きの記録を外した: kit 3 で cookie 2.0.1 になり、`pnpm audit`（全依存）は 0 件（2026-10-05 確認）

### 修正

- fix(scripts): scaffold の削除パターン・display の置き換えを SvelteKit 3 の書き方（`#lib`、`.ts` の import は `.js` 付き、`resolve()`）に合わせ、削除パターンが見つからないときに黙って「適用済み」にせず失敗するようにした（初回の適用のみ。工程の印が既に消えている再実行は従来どおり冪等。#325 PR2）。経路 B（scaffold を再実行する派生のみ）。
- fix(admin-template): ナビゲーションの途中でセッションの世代が変わると（別のタブでのログイン・Remember me の切り替え、バックグラウンドで確定した失効など）、移動が失われ、その後の未保存の変更の確認が効かなくなる問題を修正（#326、#321 の続き）。`(app)/+layout.svelte` の配線①（世代が変わったら `invalidateAll()` で確定し直す）がナビゲーションの途中に当たると、SvelteKit 2.70 はそのナビゲーションを途中で終わらせ（URL は元の画面のまま）、内部の「ナビゲーション中」の印を残すため、次のナビゲーションで `beforeNavigate` が呼ばれなかった。配線①は、ナビゲーションが終わるまで（最初のナビゲーションの `afterNavigate` の後、かつ `navigating.to === null`）やり直しを待つ。この判定は新しい `src/lib/banto/navigationSettled.svelte.ts` にまとめ、#321 のルートのレイアウトのやり直しと共有する。世代が変わったら確定し直す本来の動き・ログアウト中（`isLeavingForLogin()`）の抑止は従来どおり。SvelteKit 側の同じ現象は [sveltejs/kit#17114](https://github.com/sveltejs/kit/issues/17114)（3 系の開発版で修正。2.70 には入っていない）。E2E: smoke `13j`（項目の画面から一覧への移動を止めている間に別のタブでログインし直す → 移動が完了し、未保存の確認が出る）。単体: `src/lib/banto/navigationSettled.test.ts`。
  - 派生アプリへの影響: **経路 B のみ**（A の `@banto/*`・`banto-*` と C の DB・設定は変更なし）。配線①をコピーしている派生アプリ（banto-industrial など）は、この修正の入った版の admin-template から次を写す: `src/lib/banto/navigationSettled.svelte.ts`（新規）、`src/routes/+layout.svelte`（`trackFirstNavigation()` の呼び出しと、起動待ちのやり直しの条件を `isNavigationSettled()` に）、`src/routes/(app)/+layout.svelte`（配線①の `$effect` に `if (!isNavigationSettled()) return;`）。#321 を取り込んでいない派生アプリも、ルートのレイアウトで `trackFirstNavigation()` を 1 回呼ぶ（配線①の判定に最初のナビゲーションの終わりが要るため）。

## [3.0.1] - 2026-10-05

**v3.0.1 — 保護画面を直接開いたときのスプラッシュと再接続の修正（#321）と依存の更新。版の種類: patch（後方互換の修正のみ。公開 API の追加・削除・改名は無い）。
派生アプリへの影響: 経路 A はタグの更新だけで済む。保護ルートのガードで `await bantoReady` している派生アプリは、コピーしたテンプレートの 5 ファイルの取り込みが要る（経路 B）。DB・設定の変更は無い。**

| 経路                             | 影響 | 内容                                                                                                                                                                                           |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v3.0.0` → `v3.0.1`（npm と Rust を同じタグに）。版数のみ（API 変更なし）。tauri 2.12.1（#318）など依存の更新は workspace 内で完結する                                                         |
| B. コピーしたテンプレート        | あり | #321: `src/lib/banto/startupGate.ts`（新規）・`setup.ts`・`app.d.ts`・`routes/+layout.svelte`・`routes/(app)/+layout.ts`。保護ルートの子の load は `await parent()` してから provider に触れる |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                        |

### 消費側への注意

- 経路 A はタグを上げるだけでよい。経路 B は、保護ルートのガードで `await bantoReady` している派生アプリだけが対象（詳細は「修正」の #321 の項）。取り込まなくても動くが、サーバーに届かない間に保護画面を直接開くと真っ白のままになる従来の挙動が残る。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `7eea5bc`、`workflow_dispatch`）: [run 37245443236](https://github.com/tyaro/banto/actions/runs/37245443236)（success）。
  - タグの push（`v3.0.1`）: [run 37245561619](https://github.com/tyaro/banto/actions/runs/37245561619)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 2.70.3                         |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- **chore(security)（依存監査・JavaScript 側）**: lockfile の変更なし（依存追加・overrides なし）。2026-10-04 時点の `pnpm audit` は low 1 件（cookie 0.6.0、GHSA-pxg6-pf52-xh8x）のみ、`pnpm audit --prod` は 0 件、informational は 0 件。issue 時点の high 2 / moderate 1（brace-expansion 5.0.9）は main で既に 5.0.12 に更新済み（9cb0f5d）。残る cookie は開発依存（@sveltejs/kit 2.70.3 の `cookie ^0.6.0`。adapter-static の配布物に含まれる経路は確認していない）で、0.7.0 以降へは @sveltejs/kit 3.0.0（`cookie ^2.0.1`、typescript ^6 を peer に要求）への移行が必要なため据え置き。根拠と再検討条件は `.github/workflows/ci.yml` の audit ジョブのコメントに記録。dependabot #320（npm-minor-patch 8 件）は @sveltejs/kit・cookie を含まないため、この件とは重複せず、解消にも寄与しない（#282）。
- docs: 文書整理の第 1 弾（#312 PR-A）。`.cargo/audit.toml`・`.gitattributes`・`.githooks/pre-commit` と
  `docs/history/improvements.md` に残っていた旧パス・壊れた相対リンクを修正し、industrial-plan・maintenance-review
  の状態行を実態に合わせ、AGENTS（ja/en）に文書の寿命ルール、roadmap §7 に状態行更新の 1 行を追加。

- chore(deps): 依存の更新。tauri 2.12.1（#318、cargo minor-patch）、taiki-e/install-action（#319）、npm の minor-patch 8 件（#320）。

### 修正

- fix(admin-template): ログインが必要な画面（`(app)` の配下）を直接開いたとき、サーバーに届かない間は真っ白のままで再接続もできなかった問題を修正（#321、#286 の続き）。ガードの `load` が `await bantoReady` で起動判定を待ち、初回の load が終わらないため SvelteKit がルートのレイアウト（スプラッシュ）も描かなかった。ガードは起動判定を待たず、終わっていなければ provider にもセッションにも触れる前に起動待ちの印付きの 503（`startupGate.ts` の `deferUntilStarted`、`App.Error.startupPending`）を投げる。子の load はすべて `await parent()` なので、保護画面の load とコンポーネントは起動判定とセッションの確定より前に動かない。ルートのレイアウトはこの印のあいだエラー画面ではなくスプラッシュ（「起動中…」→「サーバーに接続できません」＋再接続）を出し、起動判定が終わり、その印を出したナビゲーションが終わってから `invalidateAll()` でガードをやり直す（同じ URL が開く。ナビゲーションの途中でやり直すと SvelteKit 2.70 の `beforeNavigate` が以後呼ばれなくなり、未保存の変更の確認が効かなくなるため）。demo への誤判定（#286）・Tauri・demo ビルド・閲覧公開の grant・セッション確認の 503 の再試行は従来どおり。E2E: smoke `13a2`・public-viewer `2a`（`/api` を止めて保護画面を直接開く → 再接続 → その画面に入る）。
  - 派生アプリへの影響: **経路 B のみ**（A の `@banto/*`・`banto-*` と C の DB・設定は変更なし。`resolveStartupTarget`/`startupState` の API も変えていない）。保護ルートのガードで `await bantoReady` している派生アプリは、この修正の入った版（v3.0.0 の次）の admin-template から次を写す: `src/lib/banto/startupGate.ts`（新規）、`src/lib/banto/setup.ts`（`isBantoReady()`）、`src/app.d.ts`（`App.Error.startupPending`）、`src/routes/+layout.svelte`（スプラッシュの継続とやり直し）、`src/routes/(app)/+layout.ts`（`await bantoReady` を `deferUntilStarted(isBantoReady(), …)` に）。保護ルートの子の load は `await parent()` してから provider・セッションに触れること（テンプレートはすべてそうなっている）。単体テストは `src/lib/banto/startupGate.test.ts`・`src/routes/(app)/guard.test.ts`。

## [3.0.0] - 2026-10-04

**v3.0.0 — 資格情報なしのセッション発行を grant に一本化（ADR-0017）。版の種類: major（破壊的変更。閲覧公開専用の API・URL・フィールドと `SessionController.adopt()`/`end()` を削除し、互換用のラッパ・エイリアスは残さない）。
派生アプリへの影響: 経路 A（`@banto/admin-core`・`banto-server`・`banto-admin-services`）の追従と、それを呼ぶ経路 B（コピーした `rest.rs`・保護レイアウト・ログイン画面・e2e）の書き換えがセット。A だけ上げると型エラーになる。DB の移行は無い。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v2.1.1` → `v3.0.0`（npm と Rust を同じタグに）。`banto-server`（grant の型・ルーター・`AuthState`/`AuthenticatedSession` の変更）、`banto-admin-services`（`delete_user` の引数・`has_admin`）、`@banto/admin-core`（`grantFallback`・`enterGrant`・`Identity.kind`、`adopt()`/`end()` の削除）。他は版数のみ                                                        |
| B. コピーしたテンプレート        | あり | `apps/admin-template/core/src/rest/mod.rs`（`GrantRegistry` の組み立てと `extra_auth_router` の新シグネチャ）、`src-tauri/src/lib.rs`（`revoke_grant_tokens`・`delete_user`）、`src/routes/(app)/+layout.ts`・`src/routes/login/+page.svelte`・`src/lib/session.svelte.ts`、`e2e/`、`scripts/verify-architecture.mjs`。手本は v3.0.0 の admin-template の同名ファイル |
| C. DB・設定・配布資産            | なし | マイグレーション・設定キーの追加は無い（`server.viewer_public` は従来どおり閲覧公開の条件として使う）                                                                                                                                                                                                                                                                 |

### A. 共通パッケージ・クレート — 削除した公開 API と移行先（ADR-0017「削除するもの」）

| 削除                                                                                    | 置き換え                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/public-viewer`                                                          | `POST /api/auth/grant/publicViewer`（`grant_router`。未登録の kind は 404、条件 false・peer 不可・世代不一致は 403）                                                                            |
| `GET /api/auth/status` の `viewerPublic`                                                | `grants: { publicViewer: bool, … }`（`GrantRegistry::availability(peer)`。status と発行で同じ判定）                                                                                             |
| `GET /api/auth/identity` の `publicViewer`                                              | `kind`（`"publicViewer"` / アプリの kind / `"account"`）                                                                                                                                        |
| `AuthenticatedSession.public_viewer: bool`                                              | `AuthenticatedSession.grant: Option<GrantKind>`                                                                                                                                                 |
| `AuthState::issue_public_viewer_token()` / `revoke_public_viewer_tokens()`              | `grant_generation(&kind)` → 判定 → `issue_grant_token(&GrantSpec, GrantGeneration) -> Option<String>` / `revoke_grant_tokens(&GrantKind) -> usize`（世代で直列化。「条件の保存 → revoke」の順） |
| `MAX_PUBLIC_VIEWER_SESSIONS`                                                            | `GrantSpec.max_sessions`（既定 `DEFAULT_GRANT_MAX_SESSIONS` = 256、kind ごとの FIFO）                                                                                                           |
| `extra_auth_router(users, auth, audit, allow_setup, settings, extras)`                  | `extra_auth_router(users, auth, audit, allow_setup, Arc<GrantRegistry>, extras)`（`grant_router` を内包。テンプレートは `GrantSpec::public_viewer(settings)` を登録）                           |
| `UsersService::delete_user(id, acting_user_id: i64)`                                    | `delete_user(id, acting_user_id: Option<i64>)`（`None` は検証済み grant セッションだけ。最後の admin 禁止は維持）。追加: `UsersService::has_admin()`                                            |
| `publicViewerFallback(controller, provider, ticket)` / `DEFAULT_PUBLIC_VIEWER_RETRIES`  | `grantFallback(controller, provider, ticket, { kind: 'publicViewer', available?, maxRetries? })` / `DEFAULT_GRANT_RETRIES`                                                                      |
| `AuthProvider.enterPublicViewer(options?)` / `status().viewerPublic`                    | `enterGrant(kind, options?)` / `status().grants`（HTTP provider は無ければ `{}`）                                                                                                               |
| `Identity.publicViewer` / TS `PUBLIC_VIEWER_ID`                                         | `Identity.kind`（発行元の印。`kindOfResolvedAuth` は `identity.kind` を最優先）                                                                                                                 |
| `sessionOwnerKey` の `public-viewer` と adopt の `${kind}:${id}`                        | grant kind 単独のキー（`publicViewer`・`commissioning`。保存状態の owner が 1 回変わる）                                                                                                        |
| `SessionController.adopt()` / `end()`、epoch だけの `SessionTicket`、「adopt 中」の分岐 | `grantFallback` + provider の答え（S-42 の経路）。`ticket()` は常に `{ epoch, revision }`                                                                                                       |
| `verify-architecture` rule 8 `REST_ONLY` の `POST /api/auth/public-viewer`              | `POST /api/auth/grant/{kind}`                                                                                                                                                                   |

- 追加（Rust、`banto-server`）: `grant` モジュール — `GrantKind`（`[A-Za-z][A-Za-z0-9_-]{0,31}`、`account`/`local` は予約語）・`GrantSpec`（固定 identity・要求ごとの条件・`max_sessions`・`policy`・`require_loopback_peer`）・`GrantRegistry`（登録時に予約語・重複・`max_sessions == 0` を拒否、`availability(peer)`）・`grant_router`・`GrantGeneration`・`is_loopback_peer`。grant セッションはアカウント照合（ADR-0014）を飛ばし、`change-password` を拒否し、SSE の再検証は `revoke_grant_tokens` の後の次の再検証でストリームを閉じる。peer 不明は拒否（status では `false`、発行では 403）。IPv4 射影 IPv6 の loopback も loopback に数える。
- 追加（TS、`@banto/admin-core`）: `grantFallback`・`DEFAULT_GRANT_RETRIES`・`GrantFallbackOptions`・`GrantStatus`、`AuthProvider.enterGrant`。
- 競合テスト（ADR の必須項目）: `auth.rs` の `an_issuance_parked_before_the_insert_loses_to_a_revocation_that_completed_meanwhile`（閲覧公開・任意 kind）、`grant.rs` の `an_issuance_parked_between_the_judgment_and_the_insert_loses_to_a_revocation`（実ルート）。
- 派生アプリの移行手順: [docs/upgrading.md 例 3](docs/upgrading.md#例-3-v21x--v300grant-への一本化a-と-b-がセット破壊的変更)（経路 A/B/C の組み立て）、[ADR-0017「v3.0.0 への移行手順」](docs/adr/0017-credential-less-grant.md)（banto-hub・chronogazer の書き換え箇所）。試運転を grant にする派生アプリは `require_loopback_peer: true`・小さい `max_sessions` を既定にし、同一ホストのリバースプロキシ配下の運用条件（ADR-0017 §6 の 2 点）を導入手順に書く。

### 消費側への注意

- A だけ上げると型エラーになる（削除した API を B のコピーが呼ぶ）。A と B を同じ作業で終え、`docs/upgrading.md` の例 3 の順（A → B → 検証用 DB で起動 → 本番）で進める。DB の移行は無いので、戻すときは依存タグと B のコピーを戻せばよい。
- 閲覧公開（`publicViewer`）を使わない派生アプリも、`SessionController.adopt()`/`end()` を呼んでいれば追従が要る（`grantFallback` + provider の答えへ）。
- 保存状態の `owner` が 1 回変わる（`sessionOwnerKey` の形が変わるため）。初回起動で「別のユーザーでログインされました」が出ないかを確認する。

### セキュリティ（v3.0.0）

- あり。認証なしで通る要求が `POST /api/auth/grant/{kind}` の 1 本に縮み、派生アプリの独自の認証迂回を無くせる（ADR-0017）。影響する利用形態: LAN 公開・閲覧公開・派生アプリの試運転。修正は A（`banto-server`）と B（コピーした `rest.rs`）の両方。admin 相当の grant を `require_loopback_peer: false` で LAN bind に載せない（注意点 2）。リバースプロキシ配下では peer が常にプロキシなので、外部公開の前にロックダウンし、`/api/auth/grant/{kind}` をプロキシから外へ出さない（README「リバースプロキシでのTLS終端」）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `f0dcece`、`workflow_dispatch`）: [run 37133897926](https://github.com/tyaro/banto/actions/runs/37133897926)（success）。
  - タグの push（`v3.0.0`）: [run 37134004905](https://github.com/tyaro/banto/actions/runs/37134004905)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 2.70.3                         |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### ドキュメント

- docs(adr): ADR-0017「資格情報なしのセッション発行は grant に一本化し、閲覧公開を 1 種類目・派生アプリの試運転を 2 種類目にする」を追加（2026-10-02 オーナー決定、2026-10-03 のレビュー #313 で細目を決定し、後方互換を捨てて **v3.0.0（major）** で一本化する形に改訂。実装は v3.0.0 の PR）。閲覧公開専用の API・URL・フィールド（`/api/auth/public-viewer`、`viewerPublic`、`identity.publicViewer`、`issue_public_viewer_token` など）と `SessionController.adopt()`/`end()` を v3.0.0 で削除し、移行手順を ADR に記載、session-controller-design.md §4.7・§6.2・I-13・I-21 と viewer-public-plan.md に注記。

## [2.1.1] - 2026-10-02

**v2.1.1 — 試運転セッションへの切り替えで誤通知が出る問題（#308）の修正。版の種類: patch（後方互換の修正のみ。公開 API の追加・削除・改名は無い）。
派生アプリへの影響: `@banto/admin-core` を取り込めば解消する。コピーしたテンプレートや DB・設定の変更は無い。**

| 経路                             | 影響 | 内容                                                                                                                                                   |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v2.1.0` → `v2.1.1`（npm と Rust を同じタグに）。`@banto/admin-core` のみ後方互換の修正（#308、`SessionController` の owner 変化の判定）。他は版数のみ |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                               |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                |

### 消費側への注意

- banto-hub など `adopt` で commissioning（試運転）を使う派生アプリは、経路 A（`@banto/admin-core` を v2.1.1 に）だけで取り込める。`ownerChange.ts` などコピー側の変更は不要。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `34e65bd`、`workflow_dispatch`）: [run 37005359727](https://github.com/tyaro/banto/actions/runs/37005359727)（success）。
  - タグの push（`v2.1.1`）: [run 37005850859](https://github.com/tyaro/banto/actions/runs/37005850859)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 2.70.3                         |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 修正

- fix(admin-core): 試運転（`kind: 'commissioning'`、アプリが `adopt()` で確定する合成セッション）への切り替えで「別のユーザーでログインされました」が出ないようにした（#308、S-108。#291 の続き）。`SessionController` は owner の変化を比べる対象を `kind === 'account'` の active だけにした（v2.1.0 までは `publicViewer` と `local` だけを列挙して除外していた）。`account` 以外の active（`publicViewer`・`local`・`commissioning`・今後増える kind）は `pendingOwnerChange` を立てず、最後の具体的な owner も更新しない。`kind` を持たない provider の答えは従来どおり `account` として比べる。本物の別ユーザーへの切り替え（account A → account B）は従来どおり通知する。派生アプリ（banto-industrial の banto-hub など）への取り込み: 経路 A のみ（`@banto/admin-core` を新しいタグへ。`ownerChange.ts` などコピー側の変更は不要）。経路 B の変更は無い。DB・設定の移行なし。

## [2.1.0] - 2026-10-02

**v2.1.0 — レビュー起票分（#277〜#291）の修正とセキュリティ強化。版の種類: minor（後方互換の公開 API 追加 + 消費側に影響する挙動変更）。
派生アプリへの影響: 依存タグの更新だけでも取り込める修正が大半。ただし（1）バックアップの保存先が変わる（#280）、（2）静的ホスティングでデモを公開するアプリはビルド時の設定を推奨（#286）、（3）Excel 向け CSV は opt-in の指定を推奨（#281）。DB の移行は無い。**
公開 API の追加（`toCsv` の `formulaSafe`、`@banto/admin-core` の `invalidateAll`・`InvalidateReason`、`banto_server::bind`・`BoundServer`・`AuthState::revoke_public_viewer_tokens`、`banto_admin_services::settings::auth_server_combination_allowed`・`validate_server_config`・`users::bound_username_for_audit`）はすべて後方互換。
バックアップの保存先の変更（#280）は API の削除・改名を伴わない運用上の挙動変更なので、[publishing.md のバージョニング規約](docs/publishing.md#バージョニング規約)に今回明文化した「2.x 以降の運用上の変更」に従い、消費側の移行手順（下の「消費側への注意」）を明記した上で `minor` とする（旧ファイルは削除せず残るため、手動で移せば失われない）。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v2.0.0` → `v2.1.0`（npm と Rust を同じタグに）。`@banto/admin-core`（`invalidateAll`・`InvalidateReason`・購読コールバックの `reason`、`kind: 'local'` を owner の変化の判定から除外）、`@banto/grid-svelte`（`toCsv` の `formulaSafe`）、`banto-server`（SSE 中の `stop()`、`bind`・`BoundServer`、`AuthState::revoke_public_viewer_tokens`）、`banto-admin-services`（初回セットアップ・ログインのスロットル・監査・バックアップ・設定の検証）、`banto-attachments`（サムネイル更新失敗）は後方互換の追加・修正。他は版数のみ |
| B. コピーしたテンプレート        | あり | 起動時の判定（`environment.ts`・`startup.ts`・`StartupSplash.svelte`・`+layout.svelte`、#286）、items 画面（CSV 出力・行単位の保存の直列化・詳細間の遷移、#281・#284・#290）、ナビのバッジ（`navBadges`、#289）、設定の LAN 適用（`serverAdmin.ts`・`ConnectivitySection.svelte`・`src-tauri` の `server_apply`、#287・#288・#294）、`src-tauri` のログイン失敗の監査（`login_body`、#278）。いずれも取り込まなくても動くが、取り込むと修正が入る（セキュリティ関連は推奨）                                                      |
| C. DB・設定・配布資産            | あり | DB のマイグレーションは無い（SQLite・PostgreSQL とも）。設定キーの追加は無い。**SQLite のバックアップ・リストア予約の保存先が変わる（#280。依存タグの更新で入り、旧配置のファイルは自動では引き継がれないので手動で移す）**。デモ配信のビルドは `VITE_BANTO_DEMO=1` を推奨（#286）。`src-tauri/Cargo.toml` にテスト用の dev-dependency（`sqlx`）が増えた（既にグラフ内）                                                                                                                                                         |

### 消費側への注意（必ず確認）

1. **バックアップの保存先が変わった（#280、経路 A・C。本体は `banto-admin-services` の `backup.rs` のみで、コピー側の本番コードの変更は無い）。** SQLite のバックアップ・適用前の安全バックアップ・リストア予約は、DB ファイルごとの
   `<DBの親フォルダ>/backups/<DBファイル名>/`（予約は同ディレクトリの `restore-pending.sqlite3`）へ分離した。**旧共有領域**（`backups/` 直下の `*.sqlite3`・
   親フォルダ直下の `restore-pending.sqlite3`）の既存バックアップ・予約は、所属 DB を判断できないため**一覧に出ず、取得できず、自動適用もされない**
   （削除もしない。起動時に stderr へ警告）。引き続き使うバックアップは新ディレクトリへ**手動で移す**こと。
   手順は [README「SQLite バックアップの保存先」](README.md)。暫定回避策として DB ごとに親フォルダを分ける運用も有効。PostgreSQL は従来どおりバックアップ非対応。
2. **静的ホスティング（GitHub Pages 等）でデモを公開する派生アプリは、ビルド時に `VITE_BANTO_DEMO=1` を設定することを推奨**（#286、経路 B）。
   未設定でも静的ホストの明確な 404 応答で従来どおり demo になる。一方、Tauri・LAN 配信のビルドでは、接続失敗を demo とみなさなくなった（「サーバーに接続できません」画面で再試行する）。
   本リポジトリの `deploy-demo.yml` は設定済み。
3. **Excel 向けの CSV を出力する派生アプリは `toCsv(..., { formulaSafe: true })` を推奨**（#281、経路 A・B。`formulaSafe` は A。items のエクスポートでの有効化は B で、admin-template では有効化済み）。
   既定の出力は不変。再インポート（`parseCsv`）では先頭の `'` が値に残る。Windows 11 + Microsoft 365 の Excel で、数式が評価されず文字列として開かれることを確認済み（#303）。Excel で開くと先頭の `'` はセルに表示されたまま残る。
4. **invalidate の購読コールバックに `(resource, reason)` が渡るようになった**（#289・#297、経路 A）。既存の引数なしコールバックは互換（そのまま動く）。
   ナビの未読バッジ・通知を `onInvalidate` で自作している場合は、`reason === 'resync'`（SSE 再接続後の再取得）を無視すること
   （実変更なしの再接続でバッジが増えるのを防ぐ）。admin-template の `navBadges.noteInvalidation` が手本。
5. **#291（ログイン不要モードの有効化・役割変更で「別のユーザーでログインされました」が出る）は `@banto/admin-core` を上げるだけで取り込める**（経路 A のみ。`ownerChange.ts` などコピー側の変更は不要、経路 B・C の変更は無い）。
6. **セキュリティ修正（#277・#278・#279・#280・#281・#283）は下の「セキュリティ」を参照。** #277・#279・#280・#283 は経路 A（`banto-*` を同じタグに。#280 は加えて C の手動移行）で入る。#278 は A に加え、`src-tauri` の `login_body`（失敗ログインの `actor_username` の切り詰め）が B。
   REST と Tauri の両方を持つアプリは、`src-tauri` の `login_body` のコピー側も確認すること。
7. **LAN 設定の適用**（#287・#288・#294、経路 A・B。#283 の SSE 中の停止は A のみ）: `banto_server::start` は互換のまま、`bind` / `BoundServer::serve` を足した。デスクトップの `server_apply` を自前で持つ派生アプリは、
   「新 listener の bind 成功 → 設定保存 → serve 開始」の順に取り込むこと（失敗時に保存値・実稼働・表示が食い違わない）。認証無効 + LAN 有効 + 閲覧公開の許可判定は
   `auth_server_combination_allowed` に一本化したので、独自に同じ判定を書いている場合はこれへ寄せる。
8. 経路 A の更新で依存の lockfile も更新するとよい（`devalue`・`brace-expansion` の修正版、`event-listener`・`spin`。#282・#295）。

### A. 共通パッケージ・クレート

- 対象:
  - `@banto/admin-core`: `invalidateAll()` と型 `InvalidateReason` を追加・export（#289）。購読コールバックが `(resource, reason)` を受ける（既存の引数なしは互換、#297）。
    `createSseEventProvider` の購読フックに `onReconnected` を追加（#289）。`SessionController` は `kind === 'local'` を owner の変化の判定から外す（#291）。
  - `@banto/grid-svelte`: `toCsv` に opt-in の `formulaSafe`（#281）。
  - `banto-server`: `bind` / `BoundServer` の追加（`start` は互換、#294）、`AuthState::revoke_public_viewer_tokens`、SSE 接続中でも完了する `RunningServer::stop()`（#283）、未認証ログアウトの監査抑止（#278）、ログインの同時検証の上限（#279）。
  - `banto-admin-services`: `settings::auth_server_combination_allowed`・`validate_server_config`（#288・#294）、`users::bound_username_for_audit`（#278）、初回セットアップの原子化（#277）、バックアップの保存先の分離（#280、挙動の変更）。
  - `banto-attachments`: サムネイルの `has_thumbnail` 更新失敗を補助処理の失敗として扱う（#285）。
  - 他の `@banto/*`（attachments・charts・dock-svelte・forms・report・scan-wedge・theme・tree-svelte）と `banto-core`・`banto-storage` は版数のみ。
- 更新: `v2.0.0` → `v2.1.0`（npm と Rust を同じタグに）。
- 追従: 型エラーになる変更は無い。追従が要るのは上の「消費側への注意」1（C の手動移行）・4・7。
- 依存を上げずに留まれるか: できる（`v2.0.0` に固定したままなら従来どおり動く。ただしセキュリティ修正は入らない）。

### B. コピーしたテンプレート

- 対象ファイル・ルート:
  - 起動: `apps/admin-template/src/lib/banto/environment.ts`（`probeBackend`・`isDemoBuild`）・`startup.ts`・`startupState.svelte.ts`・`setup.ts`、`src/lib/components/StartupSplash.svelte`、`src/routes/+layout.svelte`、`messages/{ja,en}.json`（`app.startup.*`）（#286）。
  - items: `src/routes/(app)/items/+page.svelte`・`ItemsClientGrid.svelte`・`ItemsServerGrid.svelte`・`rowSaveQueue.ts`・`[id]/+page.svelte`、`src/routes/(app)/+layout.svelte`（`{#key}` に params、#290）。
  - ナビのバッジ: `src/lib/navBadges.svelte.ts`（#289）。
  - 設定の LAN 適用: `src/lib/banto/serverAdmin.ts`・`src/routes/(app)/settings/ConnectivitySection.svelte`（#287）、`src-tauri/src/lib.rs`（`server_apply`・`start_embedded_server`・`login_body`、#278・#287・#288・#294。#277・#279・#280・#283・#285 の `src-tauri` 側はテストのみで本番コードの変更は無い）。
- 関連 PR: #299（#286）、#298（#284）、#303（#281）、#300（#290）、#297（#289）、#296（#291。テンプレートの変更なし）、#294（#287・#288。#283 は A のみ）、#292（#277）、#293（#278・#279）、#302（#280）、#301（#285）。
- 手で取り込む変更: 上の「消費側への注意」2・3・4・6（`login_body`）・7。
- 派生側の独自変更と衝突しやすい箇所: `src-tauri` の `login_body`・`server_apply`、起動時の demo 判定（`isEmbeddedServer` の独自利用）、`onInvalidate` で作ったバッジ。
- 取り込まなくても動くか: 動く（A だけ上げても動く。ただし B 側のセキュリティ関連（#278 の `src-tauri` の `login_body`・#281 の items の CSV）の修正は入らない）。
- 手本: admin-template の同名ファイル。

### C. DB・設定・配布資産

- マイグレーション: 不要（スキーマの変更は無い。SQLite・PostgreSQL とも）。
- 追加された設定キー: なし。
- 戻せる条件: DB に変更が無いので、依存タグとコピー部分を戻せば戻せる。ただし #280 の新構成で作成したバックアップは新ディレクトリにあるため、旧構成へ戻すと見えない。
- 設定キー・配布物: SQLite のバックアップ・リストア予約の保存先が変わる（#280）。デモ配信のビルドに `VITE_BANTO_DEMO=1` を設定（#286）。配布する `tauri.conf.json` の変更は版数のみ。
- 順序: A・B を先に完成 → 検証用 DB で起動（旧バックアップがある場合は stderr の警告を確認して手動で移す）→ 本番。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画されること。静的デモを公開するアプリは `VITE_BANTO_DEMO=1` を付けたビルドで demo が出ること）。
2. バックアップ: 作成・一覧・取得・リストア予約が新ディレクトリで動くこと。旧配置のファイルが残っていれば移すこと。
3. Excel 向け CSV: 先頭が `=` `+` `-` `@` の文字列を含むデータで、出力の先頭に `'` が付くこと。
4. LAN 設定: 設定画面で LAN を有効・無効にし、失敗時に表示が実際の状態と一致すること。
5. Rust: `cargo check` / `cargo test`。

### セキュリティ

アプリ固有のコードには、既知の CVE を直接修正する変更はない。一方、依存関係では公開 advisory への更新を含む（`devalue` の GHSA-j22f-vq7h-c4qm / GHSA-mcm9-63f2-9j32 / GHSA-x5rw-q4pp-hg5g、`brace-expansion`、`event-listener` の RUSTSEC-2026-0221 等。#295・#282/#305。下の「依存の脆弱性」）。アプリ固有のコードでは、レビューで見つかった次の問題を修正した。LAN 公開・複数ユーザー・同じフォルダに複数 DB を置く運用のアプリは更新を推奨する。

- 初回セットアップの並行実行で複数の admin が作られる問題（#277。経路 A。`UsersService::setup_first_user` の空確認と INSERT を DB 側で原子化）。
- 未認証リクエストによる監査ログの増幅（#278。経路 A・B（`src-tauri` の `login_body`）。有効なセッションを終えない `POST /api/auth/logout` は記録しない、失敗ログインの `actor_username` は 32 文字で切り詰める）。
- 並行ログインが失敗確定前のスロットルを通過する問題（#279。経路 A。試行枠の事前予約と、IP 単位 4・全体 8 の同時検証数の上限）。
- 同じフォルダの複数 SQLite DB でバックアップ・リストア予約が共有され、他 DB のバックアップの閲覧や他 DB の次回起動での適用が起き得た問題（#280。経路 A・C。保存先を DB ごとに分離。**消費側への注意 1**）。
- Excel 向け CSV エクスポートの数式（CSV）インジェクション（#281。経路 A・B。`formulaSafe` は A、items のエクスポートでの有効化は B。**消費側への注意 3**）。
- SSE 接続が開いたままだと LAN サーバーの停止が終わらない問題（#283。可用性。経路 A）。
- 依存の脆弱性: `devalue` の high 3 件ほか・`brace-expansion`（#282・#295）、`event-listener`（RUSTSEC-2026-0221）・`spin`（yanked）（#282）。派生アプリは自分の lockfile でも更新するとよい。
- 推奨: A を上げ、B のうち #278（`login_body`）・#281（items の CSV）を取り込み、#280 は C の手動移行を行う。A だけ上げても、コピー済みのテンプレートの部分（B）の修正は入らない。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `463a097`、`workflow_dispatch`）: [run 36987799449](https://github.com/tyaro/banto/actions/runs/36987799449)（success）。
  - タグの push（`v2.1.0`）: [run 36989197884](https://github.com/tyaro/banto/actions/runs/36989197884)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 2.70.3                         |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### Fixed

- fix(auth): 初回セットアップ（`UsersService::setup_first_user`）の並行実行で複数の admin が作られる問題を修正（#277）。空確認と INSERT を DB 側で原子的にした（SQLite は条件付き単一 INSERT、PostgreSQL は `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE` + 条件付き INSERT）。負けた側は従来どおり「既に初期化されています」を返し、REST/Tauri とも成功監査・セッション発行は起きない。DB マイグレーション不要。
- fix(audit): 未認証リクエストによる監査ログの増幅を防止（#278）。有効なセッションを終えない `POST /api/auth/logout` は監査に記録しない。失敗ログインの `actor_username` は作成時の長さ上限（32 文字）まで切り詰め（末尾 `…`、REST・Tauri 共通）、上限超の username は DB を引かずダミー検証のみ行う。`banto_admin_services::users::bound_username_for_audit` を追加。
- fix(auth): 並行ログインが失敗確定前のスロットルを通過する問題を修正（#279）。verifier を await する前に試行枠を原子的に予約し、処理中の試行も失敗件数と同様にしきい値判定へ数える。IP 単位（4）・全体（8）の同時検証数上限を追加（超過は即時 `RateLimited`）。argon2 の検証は blocking プールで実行。
- fix(backup)（保存先の変更・消費側への注意）: 同一フォルダに複数の SQLite DB を置くと `backups/` と `restore-pending.sqlite3` が共有され、一方のバックアップが他方から一覧・取得でき、一方のリストア予約が他方の次回起動で適用され得た不具合を修正した（#280）。バックアップ・適用前の安全バックアップ・リストア予約を DB ファイルごとの `<親>/backups/<DBファイル名>/`（予約は `<親>/backups/<DBファイル名>/restore-pending.sqlite3`）へ分離し、作成・一覧・取得・予約・状態取得・取消・起動時適用の全てが `scope_dir` の1関数でディレクトリを解決する（REST / Tauri 共通。認可・denied・監査は不変）。**既存配置からの移行**: 旧共有領域（`backups/` 直下の `*.sqlite3`・親フォルダ直下の `restore-pending.sqlite3`）は所属 DB を判断できないため、一覧に出さず・取得させず・自動適用せず（削除もしない）、起動時に stderr へ警告する。必要なバックアップは新ディレクトリへ手動で移動すること（詳細は README「SQLite バックアップの保存先」）。暫定回避策は DB ごとに親フォルダを分けること。PostgreSQL は従来どおりバックアップ非対応。
- fix(security): items の Excel 向け CSV エクスポートで、利用者入力の文字列が数式として評価され得た問題（CSV インジェクション）に対処した（#281）。`@banto/grid-svelte` の `toCsv` に opt-in の `formulaSafe: true` を追加し、**文字列値**の先頭が `=` `+` `-` `@`・TAB・CR・LF・全角 `＝` `＋` `－` `＠` のとき先頭に `'` を付ける（数値・真偽値・null・ヘッダーは対象外）。既定の `toCsv` の出力は不変。items のエクスポート（REST / Tauri / demo 共通の `handleExport`。LAN ダウンロードと Tauri のフォルダ保存は同じ `csv` 文字列を使う）で有効化。注意: 再インポート（`parseCsv`）では先頭 `'` が値に残る。全ての CSV 利用方法に安全な方式ではなく Excel 系ソフト向けの緩和策。Windows 11 + Microsoft 365 の Excel で確認済み（既定出力は `HasFormula=True`、`formulaSafe` では `HasFormula=False`。#303 のコメント）。
- LAN サーバーのライフサイクル修正（#283 / #288 / #287）:
  - `banto-server`: SSE 接続が開いたままでも `RunningServer::stop()` が完了する（サーバ停止シグナルを SSE ストリームへ伝え、安全網として5秒で待ちを打ち切りタスクを中断）。公開 API の変更なし。
  - `banto-admin-services`: 認証無効/LAN 有効/閲覧公開の許可判定を `auth_server_combination_allowed` に一本化し、保存時（`set_server_config`/`set_auth_config`）と起動時で共有（閲覧公開ありの構成が再起動後も LAN 起動する）。`set_server_config` の4キー保存を1トランザクション化し、保存せず検証だけ行う `validate_server_config` を追加。
  - デスクトップ `server_apply`: 新サーバーの bind 成功を確認 → 設定保存 → serve 開始の順で適用し（保存完了までは新 listener がリクエストを受け付けない。`banto-server` に `bind` / `BoundServer::serve` を追加、`start` は互換）、失敗時は未保存のまま旧サーバーを復帰して失敗を監査（`settings_change` / `failed`）。閲覧公開を OFF にする適用の成功時は発行済みの公開閲覧トークンを失効（`AuthState::revoke_public_viewer_tokens`）。最終検証・保存・トークン失効は `auth_config_lock` の下で行い（ロック順は `state.server` → `auth_config_lock`）、認証設定の変更との並行実行で禁止組合せが成立しないようにした。設定画面は失敗後に実際の状態を再取得する（失敗が `[object Object]` と表示される問題の修正を含む、#287）。
- fix(startup): 起動時の一時的な API 接続失敗で実データ用画面が demo モードになる問題を修正（#286）。配信形態と通信状態を分離した: Tauri は従来どおり、意図したデモは `VITE_BANTO_DEMO=1` ビルド（GitHub Pages ワークフローで設定）または静的ホストの明確な 404 応答、実サーバー配信は Banto の応答で判定する。ネットワーク例外・timeout（`PROBE_TIMEOUT_MS`=5s）・Banto 形式でない 5xx（プロキシの HTML 503 等）は demo にせず、上限付き自動再試行（2 回）の後「サーバーに接続できません」画面（再接続ボタン）で待機し、復旧後は実データ provider で初期化する。`environment.ts` に `probeBackend` / `isDemoBuild`、`startup.ts`（純粋な解決ロジック）、`StartupSplash.svelte`、i18n キー `app.startup.*` を追加。派生アプリで Pages 等へ静的デモを公開する場合はビルド時に `VITE_BANTO_DEMO=1` を設定すること。
- fix(admin-core): 変更通知 SSE が切れて再接続した後、切断中に他端末が更新したデータが次の変更通知まで古いまま残る問題を修正（#289）。`createSseEventProvider` の購読フックに `onReconnected`（切断後の再接続成功ごとに1回。初回接続・401/トークン消失/再ログイン後の最初の接続・接続中にトークンが変わった場合は呼ばない）を追加し、`connectEvents` がこれを受けて購読中の全リソースを `resource_changed` と同じ経路で1回ずつ再取得（`invalidateAll()` を新設・export）。セッション終了（`none`）後は再取得しない。サーバー側の履歴再送はしない。`SnapshotListResource` は invalidate 購読を持たないため境界は変わらない。再同期は `invalidate(resource, 'resync')`（新型 `InvalidateReason`、既定 `'change'`、購読コールバックは `(resource, reason)` を受ける）で流し、アプリ層のナビ未読バッジ（`navBadges.noteInvalidation`）は `'resync'` を数えない（実変更なしの再接続でバッジが増えない）。派生アプリで `onInvalidate` を使いバッジ・通知を自作している場合は `reason === 'resync'` を無視すること。
- fix(admin-core): ログイン不要モード（`kind: 'local'` の合成セッション）の有効化・役割の変更で「別のユーザーでログインされました」が出ないようにした（#291、S-107）。`SessionController` は `kind === 'local'` の active を、公開閲覧（S-93）と同じく owner の変化の判定の対象外にし、最後の具体的な owner も更新しない。本物の別ユーザーへの切り替えは従来どおり通知する。派生アプリへの取り込み: 経路 A（`@banto/admin-core` を新しいタグへ。`ownerChange.ts` などコピー側の変更は不要）。経路 B の変更は無い。DB・設定の移行なし。
- fix(items): 商品詳細から別の商品詳細へクライアント遷移（`/items/2` → `/items/1` など同一ルート内の移動）すると、URL だけが切り替わり、フォーム・添付・保存先 ID が直前の商品のまま残り、誤った商品へ保存され得た不具合を修正した（#290）。SvelteKit は同一ルートの別パラメータ間でページコンポーネントを再利用する（`params` が更新されるだけ）ため、`(app)/+layout.svelte` の `{#key}` にルート params を含めて ID ごとにページを作り直す（旧 ID の load 応答は破棄され、未保存変更ガードも従来どおり働く）。回帰 e2e smoke 3f を追加。
- fix(items): 同じ行へ続けて貼り付け/inline 編集すると、後続の保存が古い行スナップショットから全列を送り、先行保存の列を巻き戻す問題を修正（#284）。保存を行 id ごとの直列キュー（`rowSaveQueue.ts`）に集約し、実際の送信直前に直前の確定値へ今回の変更列だけを合成する。失敗した保存は自分の呼び出し元にのみ伝わり、後続は確定値を基に続行する。client / server グリッド共通（ページ側ハンドラ）。
- fix(attachments): 画像添付の本体・メタデータ保存後にサムネイルの `has_thumbnail` DB 更新だけが失敗すると upload 全体がエラーになり、保存済みの添付が残ったまま REST / Tauri の成功監査・変更通知が抜ける問題を修正（#285）。この更新失敗はサムネイルのファイル書込失敗と同じく補助処理の失敗として扱い、警告ログ + 生成済みサムネイルの best-effort 削除のうえ `has_thumbnail = false` で成功を返す（SQLite / PostgreSQL 共通）。本体保存失敗時の行削除クリーンアップは従来どおり。DB マイグレーション不要。

### その他の変更

- chore(deps): `pnpm audit --prod --audit-level high` が新規公開の advisory（devalue の high 3件・moderate 2・low 1）で落ちていたため、ルート `pnpm-lock.yaml` の推移的依存 devalue を 5.9.4（修正版 5.9.3 以降）、brace-expansion を修正版へ更新した（lockfile のみ。`package.json` の変更・overrides の追加は無し。上流 svelte / @sveltejs/kit の範囲内で解決）。派生アプリへの影響なし。#282 の一部（#295）。
- chore(security)（依存監査・Rust 側）: lockfile のみ更新（依存追加なし）— `event-listener` 5.4.1→5.4.2（RUSTSEC-2026-0221 解消、`concurrent-queue` を除去）、`spin` 0.9.8→0.9.9（yanked 解消）。`.cargo/audit.toml` から、依存グラフに存在しなくなった RUSTSEC-2023-0071（rsa）の除外を削除。残存除外は quick-xml 0.39.4（RUSTSEC-2026-0194/0195、plist 1.9.0 が `^0.39.2` で固定、開発者管理の plist のみ処理）。除外なしの警告は glib 0.18.5（unsound）・proc-macro-error 1.0.4（unmaintained）の2件で、いずれも Linux の tauri→gtk 0.18 経由の上流制約（`cargo audit` は警告では失敗しない）。JS 側は `pnpm audit --prod` 0件、開発依存は cookie 0.6.0（low、@sveltejs/kit の上流待ち）のみ（#282、#305）。
- test(admin-template): `systemInfoStore` のテストを import-once にして、負荷時のタイムアウトを解消（#304）。
- docs(publishing): バージョニング規約に「2.x 以降の運用上の変更」を追記した。API の削除・改名を伴わない運用上の挙動変更は、移行手順を「消費側への注意」に明記した上でオーナー判断で `minor` としてよい（v2.1.0 の #280 に適用。#306）。

## [2.0.0] - 2026-10-01

**v2.0.0 — セッション確定の単一書き手化（SessionController）。版の種類: major（破壊的）。
派生アプリへの影響: 依存タグの更新だけでは済まない。旧セッション API の削除と `AuthProvider` の契約変更（A）に加え、
コピー済みのログインガード・ログアウト・503 画面などの取り込み（B）が必要。DB の移行は無い。**
詳細は下の「SessionController 実装-3」の節（削除した公開 API と移行先・挙動の互換性が変わる変更・派生アプリの移行の手順）と、
[upgrading.md 例 2](docs/upgrading.md#例-2-v17x--v200sessioncontroller-a-と-b-がセット破壊的変更)。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v1.7.3` → `v2.0.0`（npm と Rust を同じタグに）。`@banto/admin-core` は破壊的変更（旧セッション API の削除、`AuthProvider` の `resolve`・`credentialRevision`・`onCredentialChanged` が必須）と一覧状態の保持 API の追加（#215）。`banto-server`・`banto-admin-services` は後方互換の追加・修正（#216 `lan_urls_for_bind`、#248 監査ログのスナップショット取得 `list_as_of`）。他は版数のみ |
| B. コピーしたテンプレート        | あり | `session.svelte.ts`、`(app)/+layout.ts`・`+layout.svelte`、ログイン・ログアウト、503 画面、`providers/demo.ts`、`src-tauri` の認証コマンド（#260・#264〜#266）。一覧の状態の保持（#215・#255）、LAN 接続先 URL の bind に応じた案内（#216）、監査ログ画面のスナップショット取得（#248）、items の CSV 取込プレビュー（#218）、パレット・ヘッダー検索（#258・#217）                          |
| C. DB・設定・配布資産            | あり | DB のマイグレーションは無い（既存の DB をそのまま使える）。設定キー `audit.deletion_epoch` の追加（#248。保持期間で削除したときに書かれ、無ければ 0 として扱う）。認証設定の更新経路の変更（`settings_set` の `auth.` キー拒否、`set_auth_config` の 4 キーを 1 トランザクションで書く）。Tauri のログイン不要モードの有効化・解除でセッションの挙動が変わる                                |

### A. 共通パッケージ・クレート

- 対象:
  - `@banto/admin-core`: 破壊的変更（SessionController、#260）。一覧の状態を保持する API の追加（#215・#255）。
  - `banto-server`: 後方互換の追加。`lan_urls_for_bind(bind, port)`（#216。bind に合う LAN の接続先 URL を返す。旧 `lan_urls(port)` は残るが、bind に合わない URL を案内しうるので `lan_urls_for_bind` へ移ることを推奨）。監査ログの一覧に `?asOfId=`（#248）。
  - `banto-admin-services`: 後方互換の追加。`AuditLogService::list_as_of`・`AuditLogList`・削除の epoch（設定キー `audit.deletion_epoch`。スキーマの変更は無い）（#248）。`SettingsService::is_auth_key`。
  - 他の `@banto/*`（attachments・charts・dock-svelte・forms・grid-svelte・report・scan-wedge・theme・tree-svelte）と `banto-core`・`banto-storage`・`banto-attachments` は版数のみ（charts・grid-svelte はテストの変更だけ）。
- 更新: `v1.7.3` → `v2.0.0`（npm と Rust を同じタグに）。
- 追従: 旧 API（`resolveProtectedSession`・`establishSession`・`beginSession`・`endSession`・`confirmSessionEnded` など）の
  呼び出しが型エラーになる。移行先は下の「削除した公開 API と移行先」の表。`AuthProvider` は `resolve`・`credentialRevision`・
  `onCredentialChanged` が必須（`initBanto`・`createSessionController` は欠けていると `TypeError`）。
  一時的に `adaptLegacyAuthProvider(...)` で包める（移行 PR に「adapter 使用中」と明記）。
- 依存を上げずに留まれるか: できる（`v1.7.3` に固定したままなら従来どおり動く。ただし #255 の一覧状態の所有者照合などの恩恵は受けられない）。

### B. コピーしたテンプレート

- 対象ファイル・ルート: `apps/admin-template/src/lib/session.svelte.ts`・`src/routes/(app)/+layout.ts`・`+layout.svelte`・
  ログイン・ログアウト（`Header.svelte`・コマンドパレット）・503 画面・`providers/demo.ts`、`src-tauri`（認証コマンド）、
  items の CSV 取込、コマンドパレット、ヘッダーの検索表示。一覧画面の状態の保持（#215・#255）、設定の接続先 URL の表示と `src-tauri` の `server_status`（#216）、監査ログ画面（#248）。
- 関連 PR: #260（#264・#265・#266）、#215（#255）、#216（#254）、#248（#256）、#218、#258・#217。
- 手で取り込む変更: 下の「派生アプリの移行の手順」1〜7。
- 派生側の独自変更と衝突しやすい箇所: 自前の `AuthProvider`（手順 7）、独自のセッション再確認（banto-hub の `sessionRecheck.ts` など）、
  独自の認証コマンドを持つ `src-tauri`（`settings_set` が `auth.` キーを拒否する）。
- 取り込まなくても動くか: 動かない（A を上げると旧 API を使うコピー済みコードが型エラーになる）。
- 手本: admin-template の同名ファイル。

### C. DB・設定・配布資産

- マイグレーション: 不要（スキーマの変更は無い）。
- 追加された設定キー: `audit.deletion_epoch`（#248。監査ログの保持期間による削除の世代。既存の settings テーブルに保存し、保持期間で削除したときに書かれる。無ければ 0 として扱う）。
- 戻せる条件: DB に変更が無いので、依存タグとコピー部分を戻せば戻せる。
- 設定キー・配布物: Tauri の設定画面でログイン不要モードを有効にすると、管理者のアカウントのセッションがその場でローカルユーザーに
  置き換わり、解除するとローカルユーザーのセッションが終わる（監査ログに `logout` が残る）。ログイン不要モード中の `auth_login`・`auth_setup`
  は拒否する。汎用の `settings_set` は `auth.` で始まるキーを拒否する（認証モードは `auth_config_apply`、自動ログインは
  `autologin_enable`／`autologin_disable`）。`set_auth_config` は 4 つのキーを 1 トランザクションで書く。
- 順序: A・B を先に完成 → 検証用 DB で起動 → 本番。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（demo 用の `AuthProvider` を持つアプリは白画面にならないこと）。
2. ログイン・ログアウト（ログアウト後に /login へ移る）、別タブでのログイン・ログアウト、503 画面の「再試行」。
3. Tauri: 設定画面のログイン不要モードの有効化・解除、役割の変更。
4. Rust: `cargo check` / `cargo test`。

### セキュリティ

公表済みの脆弱性の修正は無い。ただし、利用者の切り替え（同じブラウザ・同じ端末での別ユーザーのログイン）で情報が分離されない問題の修正を含むので、複数の利用者が同じ端末を使うアプリは更新を推奨する。

- 影響する利用形態: 同じブラウザや同じ端末で、複数のユーザーがログインする運用（共有 PC、Remember me、公開閲覧と併用する構成）。
- 前のユーザーの一覧の状態（並び・絞り込み）が、次のユーザーに残らないようにした（#255。経路 A と B）。
- 別のタブでユーザーが切り替わったら、このタブも保留して確認し直す。前のユーザーの表示が残らない（#257。経路 A と B）。
- 公開閲覧のトークンの発行が、応答待ちの間に済んだ別のログインのトークンを上書きしないようにした（#259。経路 A）。
- コマンドパレットの「最近使った項目」をユーザーごとに分けた。開いたままユーザーが切り替わったらパレットを閉じる（#258。経路 B）。
- Tauri: 汎用の `settings_set` は `auth.` で始まるキーを拒否する。ログイン不要モードの間は `auth_login`・`auth_setup` でアカウントのセッションを作らない（経路 B の `src-tauri`）。
- 推奨: A と B の両方を取り込む。A だけ上げても、コピー済みのテンプレートの部分（B）の修正は入らない。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `dc61fc1`、`workflow_dispatch`）: [run 36873119458](https://github.com/tyaro/banto/actions/runs/36873119458)（success）。
  - タグの push（`v2.0.0`、`check-versions --tag`）: [run 36873338314](https://github.com/tyaro/banto/actions/runs/36873338314)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 2.70.3                         |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他の変更

- chore(deps): tauri 2.11.5 → 2.12.0・tauri-build・thiserror 2.0.21・window-vibrancy 0.8.1（Cargo の minor-patch グループ、#267）。
- 外部利用 fixture の CI（#271）、items の CSV 取込プレビュー（#218）、コマンドパレットの最近使った項目のユーザー別化（#258）・
  ヘッダー検索の文言（#217）。詳細は以降の項目。

- ci(release): 外部利用 fixture を CI 化した（#271）。`fixtures/external-consumer/`（最小の SvelteKit と最小の crate）に
  `@banto/*` を `github:tyaro/banto#<sha>&path:packages/<x>`、`banto-*` を `git` + `rev` で導入し、
  `.github/workflows/external-consumer.yml` が `vite dev` をブラウザ（Playwright）で開いて描画を確かめたうえで
  `pnpm check`・`pnpm build`・`cargo check`（`--all-features` も）を流す。PR は head SHA（同じリポジトリのブランチ
  だけ、`packages/**`・`crates/**` 等を変えたとき）、`workflow_dispatch`、リリースタグの push で走る。
  `optimizeDeps.exclude` を外した診断ジョブ（成功条件にしない）が #150 の再現の有無を step summary に残す。
  対象の一覧（`.svelte.ts` を持つパッケージ・`crates/*`）は `verify:architecture` の rule
  `external-consumer-fixture` が workspace から洗い出して fixture と突き合わせる。ref の書き換えは
  `scripts/external-fixture-set-ref.mjs`。`docs/upgrading.md` §8、`docs/publishing.md`（タグを打つ前に main の SHA
  で workflow_dispatch する。`crates/*` = 公開、`apps/*` = 対象外）、ADR-0007 の検証限界を更新。SSR ありの構成は
  検証対象外。
- fix(admin-template): コマンドパレットの「最近使った項目」をユーザーごとに分けた（#258）。保存時に所有者
  （`sessionOwnerKey`）を記録し、今のユーザーと一致するときだけ読み出す（一覧の状態 `listViewState` と同じ規則。
  owner が null のときは読み書きしない）。旧形式（所有者なし）の履歴は読み出し時に破棄する。ログアウト確定で消し、
  別ユーザー確定で他人の履歴を消す。
- fix(admin-template): ヘッダーの「検索…」を「画面・操作を検索」（英語 "Search pages & actions"）に改め、
  パレットの placeholder・アイコンボタンのラベル・title も用語を揃えた（#217）。Ctrl K の表示は維持。
  visual のスクリーンショット基準（Linux）はヘッダー文言の変更に合わせて再生成した。
- feat(admin-template): items の CSV 取込の確認パネルに、実行前に先頭10行（`IMPORT_PREVIEW_ROW_LIMIT`）の
  プレビュー表（新規/更新・ID・商品名・価格・在庫）と「全N行中 先頭M行を表示」「K件は既存レコードの更新」の
  表示を追加（#218）。表と送信は同じ検証済み行から作る（`importPreview.ts`）。新規/更新は文字ラベルで区別。
  変更前後の比較は、既存値を追加通信なしに得られないため見送り。
- feat(admin-core, admin-template)!: SessionController 実装-3（#260、**v2.0.0 の破壊的変更**。
  [docs/session-controller-design.md](docs/session-controller-design.md) §5.4・§6.1・§6.2、
  [ADR-0016](docs/adr/0016-session-controller-single-writer.md) は Accepted）。セッションの状態（誰がログインして
  いるか）を書くのは SessionController だけになり、状態を書く旧 API を削除した。admin-template は §6.1 の形に
  配線し直した。**下の「削除した公開 API と移行先」「挙動の互換性が変わる変更」「派生アプリの移行の手順」を参照。**
  - **削除した公開 API と移行先**（§5.4）:

    | 削除した名前                                                                                         | 移行先                                                                                                                                                                                                                     |
    | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `resolveProtectedSession`・`ProtectedSessionOutcome`                                                 | `resolveSettled(getSessionController())` → `unverified` は 503、`confirmed` の `none` だけ（公開閲覧があるなら）`publicViewerFallback(controller, provider, result.ticket)` → その `unverified` も 503、`none` なら /login |
    | `establishSession`                                                                                   | `resolveSettled(controller)`。identity・role は `controller.snapshot` から読む（`load` でストアに書かない）                                                                                                                |
    | `beginSession`・`endSession`                                                                         | 画面からは呼ばない。ログイン・ログアウトの後は `resolveSettled()` で確定する（I-10）。アプリ独自の合成セッション（試運転など）だけ `adopt(identity, kind, ticket)`・`end(reason, ticket)`                                  |
    | `confirmSessionEnded`・`createSessionEndConfirmation`・`SessionEndOutcome`・`SessionEndConfirmation` | `getSessionController().signal(reason)`（同期。確認と退避は controller の中）。`connectEvents` は内部でこれを呼ぶ                                                                                                          |
    | `MAX_STALE_RETRIES`                                                                                  | `createSessionController(provider, { maxStaleRetries })`（既定 3）                                                                                                                                                         |
    | `SessionChangedError`（投げる側）                                                                    | もう投げない。`unverified` の `error` に同名のエラーとして入る（`SessionChangedError` の export は残した）                                                                                                                 |
    | `AuthProvider.check`・`AuthProvider.getIdentity`                                                     | 契約から削除（`LegacyAuthProvider` と `adaptLegacyAuthProvider` にだけ残る）。HTTP・Tauri の provider からも削除。答えは `resolve()` の 1 往復                                                                             |

    残した名前: `onSessionEnded`（`subscribe` の上の薄い関数）、`sessionGeneration`・`currentSessionScope`・
    `isCurrentSessionScope`・`isSessionEstablished`（既定の controller の読み取り）、`sessionOwnerKey`。
    `StandardAuthProvider` は `AuthProvider` と同じ型の別名として残した。

  - **挙動の互換性が変わる変更（要対応の可能性あり）**:
    - `AuthProvider` の `resolve`・`credentialRevision`・`onCredentialChanged` は**型で必須**。v1.8 の `initBanto` は
      3 つの無い provider を黙って互換 adapter で包んでいたが、v2.0.0 では `initBanto`・`createSessionController` が
      **`TypeError`** にする（何も置き換えない）。包むならアプリが `adaptLegacyAuthProvider(...)` を明示する。
    - 「確認できない」は reject ではなく `unverified`（`resolveSettled`・`publicViewerFallback` は reject しない）。
      `resolveProtectedSession` の reject（→ 503）に頼っていたガードは `outcome === 'unverified'` を先に処理する。
    - 公開閲覧の方針（`publicViewerFallback`）は、ticket の後に現れたトークンが確認で `none` に戻るたびに方針を
      やり直す（既定 3 回＝最大 4 回）。上限に達したら最後の確定した `none` を返す（/login へ）。旧
      `resolveProtectedSession` は同じ状況で `SessionChangedError` を投げていた（503 だった）。戻り値の型は
      `superseded` を含まない `ResolveResult` に狭めた。
    - **ログアウト**: `logout()` の後に `endSession()` を呼ばず、`resolveSettled()` の確定が `none` のときだけ /login へ
      移る。その間に別タブのログインが確定していれば（S-51）画面は新しいユーザーで作り直され、/login へは行かない。
    - `connectEvents` の失効の確認（`401`・他タブでのトークン消去）は**既定の controller（`getSessionController()`）宛てに
      `signal()` する**背景の確認になり、**`connectEvents` の購読解除では止まらない**（確定すれば止まる。退避は 1 秒から倍々で 30 秒まで、probe の期限 10 秒）。
    - **`sessionEndUnheard` の期待の変化**（実装-2 からの継続、v2.0.0 で確定）: 保護レイアウトの mount 前に確定した
      終了は、再確認（再 probe）ではなく「`onSessionEnded` を購読した時点で `none` なら非同期に 1 回通知」で届く（S-34）。
      `onSessionEnded` は `none` への**遷移**だけを通知し、none を経ない切り替え（別タブのログイン A → unknown → B）は
      通知しない。保護レイアウトの再 load は generation の照合（配線①）で行う。
    - admin-template: `(app)/+layout.ts` はストアに書かない（`sessionStore.load()` は削除。`sessionStore` の
      identity・role・publicViewer・authDisabled は `controller.snapshot` からの `$derived`、`authDisabled` は
      `snapshot.kind === 'local'`＝ Tauri の `auth_resolve` の答え。`auth_config_get` の別読みはしない、S-61）。
      保護レイアウトは 3 本の配線（① generation の照合 → `invalidateAll()`、② 未処理のユーザーの変更
      `pendingOwnerChange` → 通知して `acknowledgeOwnerChange()`、③ 再 load の `unverified` → 503）。②の方針は
      `$lib/banto/ownerChange.ts` の `OWNER_CHANGE_POLICY`（既定 `'rebuild'`＝通知だけ、`'relogin'`＝通知して /login）。
      どちらも共有のトークンは消さない（I-17）。
    - admin-template: 503 画面の「再試行」は `location.reload()` ではなく `invalidateAll()`（controller を維持した画面内の
      再読込。503 の間に確定したユーザーの変更は、再試行で保護レイアウトが mount したときに通知される、S-81。ページ全体の
      再読込では保証しない）。確認できない間は、別タブで切り替わった後も 503 のまま自動では戻らない（S-36・S-60）。
    - admin-template: ログイン・初回セットアップが `superseded`（別のログイン・ログアウトが先に確定）なら、エラーではなく
      「別のセッションが先に確定しました」を通知して /dashboard へ移る（ガードが今の資格情報で確定する）。
    - admin-template: ログアウトが /login に届かなかったとき（`logoutAndLeave` の戻り値 `'stayed'`＝ログインしたまま、
      `'unverified'`＝確認できない）はエラーのトーストで知らせる。`logoutAndLeave` は投げ直さず、戻り値
      `'left' | 'stayed' | 'unverified'` を返す（引数は `(goToLogin, { notify?, provider?, controller? })`）。
    - 公開閲覧から自分でログインした（同じタブ・別タブ）ときは「ユーザーの変更」として扱わない（通知も
      `'relogin'` も出ない、S-93）。
    - **Tauri: 設定画面でログイン不要モードを有効にすると、管理者のアカウントのセッションはその場でローカルユーザー
      （合成セッション）に置き換わる**（#266 オーナーレビュー P1、S-94）。以前はスロットが空のときだけ合成セッションを
      入れていたので、設定は「ログイン不要」なのにアカウントのセッションが残り、`sessionStore.authDisabled` が偽のままだった
      （ログアウトのメニューやパスワード変更欄が残る）。`auth.disabled == true` ⇔ 合成セッション ⇔ `auth_resolve` の
      `kind == "local"` ⇔ `sessionStore.authDisabled` が常に成り立つ。監査ログには `settings_change` に続けて、置き換えた
      アカウントの `logout`（`detail: { "reason": "auth_disabled" }`＝利用者の操作ではない終了）と合成の `login` が残る。
      その間に始まっていたログインは合成セッションを戻さない。
      ログイン不要モードのまま役割（`disabled_role`）だけを変えたときも、合成セッションの役割を書き換えて `seq` を進める
      （古い `auth_resolve` が前の役割を書き戻さない、S-96）。同じ役割の再適用は何も変えない。
      逆に**認証を再び有効にすると（ログイン不要モードを解除）、ローカルユーザーのセッションはその場で終了する**（S-99。以前は
      次の確認まで残っていた）。監査ログには合成ユーザーの `logout`（`detail: { "reason": "auth_enabled" }`）が残り、画面は
      ログイン画面へ移る。
    - **Tauri: 汎用の `settings_set` は `auth.` で始まるキーを拒否する**（BadRequest。認証モードは `auth_config_apply`、自動ログインは
      `autologin_enable`／`autologin_disable` で変える。S-103）。`set_auth_config` は 4 つのキーを 1 トランザクションで書く（S-104）。
    - HTTP provider: `changePassword` が `401` を受けたら、送ったトークンを消して資格情報の変化を通知する（S-106）。`resolve()` は
      答えが届いた時点で保存されているトークンが送ったものと違えば、古いトークンについての答えとして捨てる（S-105）。
    - **Tauri: ログイン不要モード中の `auth_login`／`auth_setup` は拒否する**（#266 オーナー決定、S-95）。
      `LoginResult { success: false, superseded: false, error: "ログイン不要モード中はアカウントでログインできません…" }`
      を返し、スロットも `seq` も変えない（provider は revision を進めず通知しない。ログイン画面はエラーを出す）。入口で
      モードが有効なら検証・アカウントの作成の前に拒否し（監査なし、setup はアカウントを作らない）、検証・作成の後にも
      `auth_config_lock` の中で読み直して、有効になっていれば設置しない（監査は従来どおり検証成功の `login`／作成の `setup`
      が残る）。これで `auth.disabled == true` ⇔ 合成セッション ⇔ `sessionStore.authDisabled` が例外なく成り立つ。
    - admin-template: demo provider（`demo.ts`）は標準の provider（メモリ上の revision、`login`/`logout` で revision を
      進めて通知）。パネルの別ウィンドウ（`routes/panel/[id]`）は `check()` の代わりに `resolveSettled()` で確認する。
  - **派生アプリの移行の手順**（§6.2。banto-industrial の 2 アプリは候補版のコミット参照で検証してから v2.0.0 へ）:
    1. `session.svelte.ts` の `load()` を削除し、identity・role・authDisabled を `getSessionController().snapshot` からの
       `$derived` にする。
    2. `(app)/+layout.ts` を §6.1 の形にする（`resolveSettled` → `unverified` は 503 → `none` は（公開閲覧があれば
       `publicViewerFallback`）/login）。返す generation は、その `load` で確認できたものだけ。
    3. 保護レイアウトに配線①（`controller.snapshot.generation` と `data.sessionGeneration` の照合 → `invalidateAll()`）と
       配線②（`pendingOwnerChange` の通知と `acknowledgeOwnerChange()`）を入れる。`onSessionEnded` だけでは none を経ない
       切り替えを拾えない。
    4. ログアウトは `await provider.logout(); const r = await resolveSettled(controller, { cause: 'signal' });` →
       `r` が `confirmed` かつ `none` のときだけ /login。ログアウトと /login への遷移の間は配線①の `invalidateAll()` を
       止める（`invalidateAll()` が遷移に勝つ競合）。`end()` は呼ばない。
    5. 503 画面の「再試行」を `invalidateAll()` にする。
       任意: ログイン・初回セットアップが `superseded` を返したら、エラーではなく通知して /dashboard へ移す
       （admin-template の `routes/login/+page.svelte` を参照）。
    6. 独自の再確認（banto-hub の `sessionRecheck.ts`）は `controller.signal(...)` と `resolveSettled(...)` に置き換え、
       試運転は `adopt`/`end` の policy runner にする（§6.2）。
    7. **自前の `AuthProvider` を持つ場合**: v2 の `AuthProvider` は `resolve`・`credentialRevision`・
       `onCredentialChanged` が必須なので型エラーになる。(a) 3 つを実装する（推奨。HTTP なら `GET /api/auth/identity`
       を 1 回、`none` で送ったトークンを compare-and-set で消し、答えの `current` で運ぶ。自分の書き込みと別タブの
       `storage` イベントで revision を進めて通知する）、または (b) 一時的に `adaptLegacyAuthProvider(...)` で包む
       （別タブの切り替えの検知・compare-and-set・1 往復は保証されない。§5.2 の表。移行 PR に「adapter 使用中」と明記）。
       メモリ上の demo 用 provider なら admin-template の `src/lib/banto/providers/demo.ts`（標準の 3 つ、revision と通知）を
       手本にできる（banto-industrial では chronogazer の `setup.ts` の `demoAuthProvider` が該当し、放置すると型エラーのうえ
       demo 起動時に `initBanto` の `TypeError` で白画面になる）。
       `getAuthProvider().getIdentity()`／`check()` を直接呼んでいる箇所（banto-hub・chronogazer の `session.svelte.ts`）は、
       `getSessionController().snapshot`（`$derived`）か `resolveSettled(controller)` に置き換える。
       adapter で包んだ provider の `logout()` は、旧 `check()` が `false` を返す状態にすること（ログアウトの確定は
       その後の `resolve()` が行う）。
- feat(admin-core, admin-template): SessionController 実装-2（#260、controller。
  [docs/session-controller-design.md](docs/session-controller-design.md) §5.1・§7.1）。
  **追加 API**: `createSessionController(provider, deps?)`・`getSessionController()`（`initBanto` が
  `authProvider` に結び付ける既定の controller。`resolve`/`credentialRevision`/`onCredentialChanged` を
  持たない provider は `adaptLegacyAuthProvider` で包む）・`resolveSettled(controller, { cause?, deadlineMs? })`・
  `publicViewerFallback(controller, provider, ticket, { maxRetries? })`・`DEFAULT_PUBLIC_VIEWER_RETRIES`・
  `SessionTimeoutError`・`SessionProviderMissingError`、型 `SessionController`・`SessionControllerDeps`・
  `SessionResolveOptions`・`SessionSnapshot`・`SessionTicket`・`ResolveResult`。controller は状態を書く唯一の
  場所で（`commit`）、`resolve()` は reject せず `confirmed`/`unverified`/`superseded` を返し、同時の確認は
  1 本にまとめ（single-flight）、答えは失敗も含めて同じ鮮度の条件で採否を決める。
  **委譲化**: `establishSession`・`beginSession`・`endSession`・`resolveProtectedSession`・
  `confirmSessionEnded`・`createSessionEndConfirmation`・`onSessionEnded`・`sessionGeneration`・
  `currentSessionScope`・`isCurrentSessionScope`・`isSessionEstablished`・`sessionOwnerKey` は既定の controller
  への委譲になった（公開名・呼び方は同じ。v2.0.0 で状態を書く旧 API は削除予定）。**挙動の変化**:
  セッションの確認は `check()` + `getIdentity()` の 2 往復ではなく `AuthProvider.resolve()` の 1 往復
  （HTTP は `GET /api/auth/identity`、Tauri は `auth_resolve`）。`resolveProtectedSession` は発行した公開閲覧の
  セッションも controller で確定する。確認には期限（10 秒）があり、超えたら「確認できない」（再試行画面）。
  別タブのログイン・ログアウト（共有の Remember me トークンの `storage` イベント）で、このタブの active な
  セッションは保留（unknown）になり、確認し直す。**`sessionEndUnheard` の期待の変更**: 保護レイアウトの
  mount 前に確定した終了は、再確認（再 probe）ではなく「購読した時点で `none` なら非同期に 1 回通知」で
  届く（S-34）。`onSessionEnded` は `none` への**遷移**だけを通知する（すでに `none` のときの再確認では通知しない）。
  **admin-template**: `(app)/+layout.svelte` の `onSessionEnded(() => invalidateAll())` を、generation の照合
  （`snapshot.generation !== data.sessionGeneration` なら `invalidateAll()`、同じ generation に二重に出さない）に
  置き換えた（配線①。none を経ない切り替え S-79・同じユーザーの再ログイン S-80 でも画面を作り直す）。ログアウト
  （`Header.svelte`・コマンドパレット）は `logout()` → `endSession()` → `/login` の順で、その間は配線①が再 load しない
  （再 load が公開閲覧を発行して遷移を上書きしないように）。`endSession()` はログアウトの前に取った ticket が
  current のときだけ呼ぶ（その間に別タブのログインなどで確定したセッションを終わらせない）。`initBanto` を**別の** `authProvider` で
  呼び直すと、それまでのセッションは保留（unknown）になり新しい provider で確認し直す（同じ provider なら何もしない）。
  **派生アプリへの申し送り**: 保護レイアウトに配線①（`getSessionController().snapshot.generation` と `load` が
  返した generation の照合 → `invalidateAll()`）を入れること。`onSessionEnded` だけでは、別タブのログインなど
  unknown → active（none を経ない）の切り替えで世代ゲートが画面を隠したままになる。
- feat(admin-core, admin-template): SessionController 実装-1（#260、provider とバックエンド。
  [docs/session-controller-design.md](docs/session-controller-design.md) §7.1）。
  **追加 API**（すべて追加。v1.x では任意）: `AuthProvider.resolve({ signal })`（1 往復で
  `{ status, checked, current, identity?, kind? }` を返す）・`credentialRevision()`・
  `onCredentialChanged(listener)`、型 `CredentialRevision`・`ResolvedAuth`・`SessionKind`・
  `AuthOperationResult`・`LegacyAuthProvider`・`StandardAuthProvider`・`TauriAuthProviderOptions`
  （`opPendingTimeoutMs`）、`StaleAnswerError`/`isStaleAnswerError`、互換 adapter
  `adaptLegacyAuthProvider`/`ADAPTER_REVISION`。`login`/`setup` の戻り値に `superseded?` を追加。
  **変更**: `AuthProvider.enterPublicViewer` は `(options?: { expectRevision? }) =>
Promise<{ success, superseded? }>` になった（旧 `Promise<boolean>`。`resolveProtectedSession` は
  `.success` で判定し、`superseded` なら確認し直す）。HTTP provider は `resolve()` で
  `GET /api/auth/identity` を 1 回だけ呼び（`200 null`/`401` はそのトークンを compare-and-set で
  消す）、`login`/`setup`/`logout`/`enterPublicViewer` のトークンの書き込みを開始時の revision との
  compare-and-set にした（#259。追い越された書き込みは何もしない。`logout` の要求は開始時の
  トークンで送る）。別タブの `storage` イベント（`storageKey` のもの）で revision を進めて通知する。
  **Tauri コマンドの戻り値の変更**（`createTauriAuthProvider` が吸収）: `auth_login`/`auth_setup` の
  `LoginResult` に `superseded`・`seq`、`auth_logout` は `()` から `LogoutResult { seq }`、
  `auth_change_password` は `()` から `ChangePasswordResult { seq }`。`auth_resolve` を追加
  （`{ identity, kind, checked, current, stale }`）。Rust の `state.auth` は `AuthSlot { session, seq }`
  になり、`auth_login`/`auth_setup`/`auth_logout` は入口で読んだ `seq` との compare-and-set で書く
  （遅いログインが完了済みのログアウトを取り消す・遅いログアウトが後のログインを消す、を防ぐ。
  S-16〜S-19）。REST のルートは変えていない。
- chore(deps): 開発依存の vitest を 4.1 から 5.0 へ更新（10 パッケージ/アプリ、dependabot #203 を置き換え）。
  Vitest 5 でモジュールレベルの `bench()` が廃止されたため、`packages/charts/tests/trend.bench.ts` と
  `packages/grid-svelte/tests/virtual.bench.ts` を `bench` フィクスチャ（`test()` の中で使う）へ移行し、
  `bench` スクリプトに `--reporter=verbose` を足して結果表を表示する。利用側の API・版は変わらない。
- docs: 全体構成図とフロー図を追加（`docs/architecture-overview.md` /
  `docs/architecture-flows.md`）。デスクトップと LAN の二形態、レイヤ、
  機能マップ、パッケージ依存、認証・初回起動・開発3経路・add-resource の
  層対応を Mermaid で俯瞰。README / AGENTS からリンク。
- docs(admin-core): セッションの確定を 1 か所（SessionController）に寄せる設計
  （#260）。ADR-0016（Proposed）と設計の本文
  [docs/session-controller-design.md](docs/session-controller-design.md)
  （不変条件 I-1〜I-24・競合のシナリオ S-1〜S-83・generation の数え方の表・API の
  案・実装の分割・テストの設計）。Tauri の Rust 側で `.await` の後に `state.auth` を無条件で書いている
  箇所（`auth_login`・`auth_setup`・`auth_logout`）を特定した。判断点はオーナーの決定
  （2026-09-29）を反映済み（旧 API は削除、`AuthProvider.resolve` 必須、
  `GET /api/auth/session` は新設せず `GET /api/auth/identity` を 1 回、`superseded` の
  `load` は確認できた世代だけを返す、#257 の既定の流れ）。同日のレビュー 10 件も
  反映済み（ticket の原則 I-18、ログアウトは `resolve()` で確定、`seq` は結び付きを
  変える操作でだけ進める、操作の応答で revision を確定して通知、失敗も同じ鮮度の
  照合、Rust のテストはコマンド本体で順序を固定）。統合修正 19 項目（3 回目の
  オーナーレビュー 5 件 ＋ 独立レビュー ＋ 第三者の補足）も反映済み: provider の
  `resolve()` は `{ status, checked, current, identity?, kind? }` を返し中の消去は
  通知しない、provider は標準（3 つ必須）と互換 adapter の 2 階層、adopt 中の ticket は
  epoch だけ、generation は (status, owner, kind) が変わったときだけ +1、画面の再確認は
  レイアウトの `$effect` の generation 照合に統一。4 回目のレビュー（Astra 6 件 ＋
  独立の再レビュー）も反映済み: 保留に移すのは active かつ adopt 中でないときだけ、
  Tauri の revision は不透明な `(observedSeq, local)` の組で `settle_session` は
  `seq_at_entry` と一致しなければ何も書かず stale、policy runner は期限・上限で
  `unverified` かつ `guard`/`recheck` の 2 mode、abort の規則は「採用できないことが
  確定した probe は必ず abort」の 1 つ。5 回目のレビュー（6 件）も反映済み: stale な
  答え（Rust の stale、pending の操作をまたいだ答え）は待たずに `StaleAnswerError` で捨て
  新しい probe で確認し直す（操作の pending には期限）、配線①（generation の照合）は
  実装-2 に前倒し、未処理の owner の変更は `pendingOwnerChange` として同値の再確認で
  上書きしない、policy runner の絶対期限を通常の確認にも引き継ぐ、revision の公開型は
  すべて `CredentialRevision`。6 回目のレビュー（3 件 ＋ オーナーの決定）も反映済み: stale の
  判定は「答えが届いた時点で未完了の状態を変える操作があるか」（開始の前後を問わない）、
  未処理のユーザーの変更は unknown・同じユーザーの再確認で保持し none の確定で破棄、
  503 画面の「再試行」は controller を維持した `invalidateAll()` に変える（ページ全体の
  再読込では通知を保証しない）。**実装時の挙動の変更の予告**: 旧
  `sessionEnded.ts` の「unheard の再確認」は再 probe をやめ、`onSessionEnded` が
  購読した時点で `none` なら非同期に 1 回通知する形に変わる（`sessionEndUnheard` の
  テストの期待は「購読時に none なら 1 回通知」に）。コードの変更は無い。
- feat(admin-core, admin-template)（**挙動の互換性が変わる変更を含む** —
  下の「挙動の互換性が変わる変更」と「派生アプリの移行の手順」を参照）:
  一覧→詳細→保存/戻る→一覧の往復で
  絞り込み・並び順・直前に開いた行を復元する（#215）。一覧を絞り込んで
  複数行を順に確認・修正する操作で、1件保存するたびに一覧条件が
  リセットされ作業対象を探し直す必要があった。
  - 保存先は `sessionStorage`（同一タブ・同一セッションの作業文脈。列設定の
    保存は対象外 — #168 の範囲）。各エントリは**所有者（ログイン中の
    アカウント、または公開閲覧者）付き**で書き、**確定した今の所有者と
    一致するときだけ**復元する。別タブで Remember me のユーザーが切り替わった
    後の再読み込み・公開閲覧者への自動移行・同じタブでの別ユーザーの
    ログインのいずれでも、前のユーザーの検索語・並び順・強調行は出ない。
    所有者が確定しない（`getIdentity()` が `null`・id なし）ときは保存も
    復元もしない（fail closed）。
  - 画面や保存中の処理は、作られたときの**セッションの世代**を持ち、世代が
    変わった後（セッション終了・所有者の変更。同じアカウントの再ログインも
    新しい世代）は書き込めない。admin-template の `(app)/+layout.svelte` は
    世代が変わるとページを作り直す（SvelteKit は load を再実行してもページを
    作り直さないため、旧セッションの GridState・強調行・通知・未保存の入力が
    次のセッションに残っていた）。
  - 編集結果が絞り込み条件から外れた場合はフィルタを解除せず、「商品 #{id}
    は現在の絞り込み条件に当てはまりません」と説明する通知を表示
    （`items.filterExcludedNotice`）。クライアントモードの判定はグリッドと
    同じ派生行（`itemRow.ts` の `toItemRow()`）で行う。直前に開いた行は
    `rowClass`（`items-row-last-opened`）で強調表示。
  - 副次的なバグ修正: `ItemsServerGrid`（サーバーモード）は `GridState` を
    外部から事前設定しても `WindowedListResource.params` が既定値のまま最初の
    取得を行っていたため、復元した条件が取得に効いていなかった。マウント時に
    `windowed.setParams()` で同期する。
  - **派生アプリへの影響（API の追加）**: `@banto/admin-core` に次を追加。
    - 一覧状態: `saveListViewState`/`loadListViewState`/`clearListViewState`/
      `clearAllListViewState`、`saveActiveListMode`/`loadActiveListMode`、
      `saveLastOpenedId`/`loadLastOpenedId`、`noteLastEditedRecord`/
      `takeLastEditedRecord`、型 `ListViewSnapshot`/`LastEditedRecord`。
      `clear*` 以外は**第1引数に `SessionScope` を取る**。
    - セッションの所有者と世代: `establishSession(auth, apply?)`（identity を
      取得し、今のセッションについての応答だと確かめたのと同じ継続で
      `beginSession` と `apply(identity)` を行い、確立した `scope` を返す。古い
      応答は捨てる）/`beginSession(identity)`/`endSession()`、
      `SessionChangedError`/`MAX_STALE_RETRIES`、`currentSessionScope()`/
      `isCurrentSessionScope(scope)`/`sessionGeneration()`/
      `isSessionEstablished()`/`sessionOwnerKey()`、型 `SessionScope`。
    - `initBanto` は `AuthProvider` を**ラップしない**（`getAuthProvider()` は
      渡したオブジェクトそのものを返す。main と同じ）。
  - **挙動の互換性が変わる変更（要対応の可能性あり）**:
    1. **`AuthProvider.getIdentity()` の約束の変更**: `null` を返すのは
       「セッションがない（トークンなし・`401`）か、identity の概念がない」
       ときだけ。サーバーの失敗（`500`）や通信の失敗など、**取得できない
       ときは reject** する（`check()` と同じ分け方。`provider.ts` の doc）。
    2. **HTTP provider（`createHttpAuthProvider`）の `getIdentity()`** は、
       これまで通信の例外・非 2xx をすべて `null` にしていたが、**`401` 以外の
       失敗で `ProviderError` を投げて reject する**ようになった（Tauri
       provider は元から reject）。
    3. **`resolveProtectedSession`** は、`check()` 中にセッションが変わり続けた
       とき（`MAX_STALE_RETRIES` 回）に **`SessionChangedError` で reject
       しうる**。また、セッション無効が確定したときに `endSession()` を呼び、
       `check()` の `false` が確認中に変わった前のセッションについての答えなら
       終了せずに今のセッションを確かめ直す。`confirmSessionEnded` も同じく
       確定したときに `endSession()` を呼び、前のセッションへの `false` では
       終了・通知しない（戻り値の種類は従来どおり）。
    4. **`beginSession(null)`**（所有者を持たないセッション）は、世代を進めて
       保存・復元を止めるが、**他の所有者の保存分は消さない**（消すのは具体的な
       新しい所有者が確定したときと `endSession()` だけ）。
    5. **admin-template**: identity の取得だけが失敗したとき、従来は閲覧者
       扱いの画面になっていたが、**ガードの再試行画面**（「ログイン状態を
       確認できませんでした」、`check()` の失敗と同じ #204 の扱い）になる。
       セッションの所有者・世代・一覧状態は変わらず、再試行で同じ identity が
       確かめられればそのまま復元される。
  - **派生アプリの移行の手順**:
    - `getAuthProvider().getIdentity()` を自前の sessionStore やガードで直接
      呼んでいるアプリは、**reject を受け止める**（ガードの再試行画面に
      つなぐ。admin-template の `(app)/+layout.ts` が `sessionStore.load()` を
      `try` で囲んで `error(503, …)` にしている形を写す）か、
      **`establishSession(getAuthProvider(), apply)` に移す**。reject を
      受け止めないと、identity のエンドポイントが一時的に失敗しただけで
      未処理の例外になる。
    - `resolveProtectedSession` を呼ぶガードは、既存の reject と同じく
      `SessionChangedError` も「確認できない」として扱う（admin-template の
      ガードは変更不要）。
    - 独自の `AuthProvider` は、取得できないときに `null` ではなく reject
      するよう直すことを推奨（`null` のままでも動くが、その間は所有者なしの
      扱いになり、一覧状態の保存・復元が止まり、画面も作り直される）。
    - 一覧状態を使う場合は、ガードで `establishSession`、ログアウト成功後に
      `endSession()`、一覧・詳細ページは生成時に `currentSessionScope()` を
      取って各 API に渡し、画面の作り直しは `(app)/+layout.ts`/
      `+layout.svelte` の配線を写す。手順は
      [docs/recipes/add-resource.md](docs/recipes/add-resource.md)「一覧の
      絞り込み・並び順の保持」。`establishSession`（または `beginSession`）を
      呼ばないアプリでは、一覧状態は保存も復元もされない（安全側に倒れる）。
    - **依存の版だけを先に上げない**こと。上の対応を含む追従の PR として
      上げる。
    - 版の上げ方（メジャーにするか段階的に移行するか）は**リリースのときに
      判断する**（この変更では版を変えていない）。
    - セッション管理（sessionStore・ガード・レイアウトの世代ゲート）の
      共通化は tyaro/banto#260 で扱う。
  - テスト: `packages/admin-core/tests/listViewState.test.ts`（所有者の照合・
    古い世代からの書き込み拒否・形の検証ほか）、`registry.test.ts`（凍結した・
    クラスの・`this` を共有する `AuthProvider` をそのまま保持）、
    `sessionGate.test.ts`/`sessionEnded.test.ts`。E2E はシナリオ 3c〜3e・6・
    6a（同じブラウザの2タブで Remember me のユーザーを切り替え、元のタブを
    再読み込み）と公開閲覧シナリオ 7（失効 → 公開閲覧者 → 並べ替え → 往復）。
  - 経緯: レビュー 2〜3 回目の対応では認証の各経路（`AuthProvider` の
    `Proxy` ラップ・ガード・失効確定）で**消す**方式だったが、経路の見落とし
    （別タブでの切り替え・作り直されない画面からの再保存）と凍結した
    `AuthProvider` での `TypeError` が続いたため、4 回目で上記の
    **所有者で照合する**方式に切り替えた（#255）。5 回目では、scope を始める・
    終わらせる認証の非同期応答（identity の取得・`check()`）も、開始時の
    世代・対象と照合してから適用するようにした（旧セッションへの遅れた応答で
    新しいセッションの所有者・保存状態・画面が失われていた）。6 回目では、
    応答が今のセッションについてのものかの確認と、その適用（`endSession`・
    identity の記録）を間に await を挟まない同じ継続で行うようにし、identity
    を一時的に取れないことを「所有者なし」と区別した。
- fix(admin-template, banto-server): バインドアドレス（`config.bind`）に
  合わないLAN URL・QRを表示する問題を修正（#216）。127.0.0.1（または
  `::1`）にバインドしたまま「LANアクセスを有効にする」を保存・適用しても、
  設定画面が非loopbackのLAN URLと最初のLAN用QRを案内していた——他端末は
  そのURLへ接続できないため、利用者が原因を切り分けにくかった。
  **派生アプリへの影響**: `server_status`/`server_apply`（Tauri コマンド）
  と `banto-serve` の起動時ログが返す/出力する URL 一覧・QR は、これからは
  `bind` に実際に合うものだけになる（形状は変わらず、値のみ補正 —
  loopback bind なら loopback URL のみ、`0.0.0.0` なら従来どおり
  loopback + 非loopback IPv4、特定 IP ならその IP のみ）。この一覧を
  「常にLAN到達可能」という前提で読んでいた派生アプリは読み直しが必要。
  **`banto_server::lan_urls_for_bind` を追加**（`(bind: &str, port: u16) ->
Vec<String>` の純関数）。**派生アプリで `lan_urls(port)` を使って URL を
  案内しているなら、bind を渡す新しい関数に切り替えないと、同じ誤案内が
  残る** — `lan_urls(port)` は互換性のため旧シグネチャ・旧挙動（常に
  `0.0.0.0` 相当）のまま残しており、公開関数の型は変えていない
  （`banto-server` は git タグ/`path:` 依存で消費されるため、シグネチャ
  変更だけで派生アプリのビルドが壊れる。`#[deprecated]` も付けていない —
  派生アプリの多くが `-D warnings` でビルドしており、依存更新だけで
  ビルドが壊れるのを避けるため）。
  - bind の種類（loopback IPv4 / `0.0.0.0` / 特定 IPv4）ごとに URL 集合を
    切り替える（**IPv6 の待受は当面、案内の対象外** — オーナー判断、
    2026-09-29。詳細は本項末尾）。回帰テストを bind の表で追加
    （カウンタープルーフで旧実装への揺り戻しが落ちることも確認済み）。旧
    `lan_urls(port)` の挙動が変わっていないことのテストと、その反証も
    追加。
  - 設定画面（`ConnectivitySection.svelte`）は状態表示を「このPC内で稼働中」
    「同じネットワークの端末から接続できる設定で稼働中」に分け、
    ファイアウォール等による到達性は保証しない旨の注記を追加。バインド
    選択肢の文言を「このPCのみ（127.0.0.1）」「同じネットワークの端末
    （0.0.0.0）」に変更（初期値は変更なし）。判定はプレーンな純関数
    `connectivityScope`（`connectivityScope.ts`）に切り出し、vitest で
    表テスト + カウンタープルーフを追加。
  - `banto-serve`（LANサーバ単体起動バイナリ）の起動時ログも同じ
    修正の対象（`BANTO_BIND` をloopbackに上書きした場合に誤ってLAN URLを
    印字していた）。
  - オーナーレビュー対応（2026-09-28）: 状態表示とQR選択のloopback判定が
    ずれていた問題を修正。`127.0.0.2`（`127.0.0.0/8` のうち代表アドレス
    以外）は状態表示では`'lan'`扱いのまま、QRは`!url.includes('127.0.0.1')`
    という部分文字列一致で選んでいたため、loopbackのURLをLAN用QRに選んで
    しまっていた。`localhost`/`::1` は逆に状態は`'local'`なのにQRは表示
    されていた。`connectivityScope.ts` に単一の loopback 判定
    （`isLoopbackHost` — IPv4 `127.0.0.0/8` 全域・IPv6 loopback・
    `localhost` を正しく判定）を用意し、状態表示（`connectivityScope`）と
    QR選択（`pickPrimaryLanUrl`）の両方がそれを使うようにした（判断: バック
    エンドに loopback フラグを追加する案も検討したが、入力はフロント側で
    完結して判定できるため、状態のJSONは変更していない）。表テスト + 反証
    (旧実装に戻すと落ちる) を追加。
  - オーナーレビュー対応（2026-09-28）: `lan_urls(port)` の互換テストが
    実機のNIC構成に依存していた問題を修正。インターフェース列挙とURL
    組み立てを分離し、固定fixtureでテストするように変更（反証も追加）。
  - オーナーレビュー対応（2026-09-28、3巡目）: 角括弧付きのIPv6ワイルド
    カード（`bind = "[::]"`）を正規化せずURLを組み立てていた問題を修正。
    `start`のリスナーはこの値を有効な待受アドレスとして受け付けるが、
    `"[::]".parse::<IpAddr>()`は失敗するため未知の文字列扱いのfallbackに
    落ち、`["http://[::]:8721"]`という未指定アドレスそのものを返して
    いた（未指定アドレスは接続先に使えない、RFC 4291 §2.5.2）。
    `banto_server::server`に`parse_bind`を追加し、パース前の前後空白
    除去・`[...]`除去・IPv4マップ済みIPv6アドレス（`::ffff:127.0.0.1`等）
    のIPv4への正規化を行うようにした（この正規化自体は以降も残る —
    IPv4マップ済みIPv6アドレスはIPv4として扱われる）。
  - **オーナー判断（2026-09-29、4巡目レビュー後）: IPv6の待受は当面、
    接続先URL・QRの案内対象から外した。** 3巡目の修正でIPv6のwildcard
    （`::`）にloopback + 非loopback IPv4・IPv6の両方を案内するように
    したところ、4巡目のレビューで実装のバグが2件見つかった:
    (1) `start`は`IPV6_V6ONLY=0`を設定しないため、Windowsでは`::`バインド
    がIPv4接続を受け付けず、IPv4のURLを案内すると誤案内になる。
    (2) ゾーンIDの無いリンクローカルIPv6（`fe80::/10`）はどの経路からも
    実際には接続できず、NIC列挙からQRに選ばれてしまう経路があった。
    IPv6を正しく案内し続けるには待受側のdual-stack対応など追加の設計判断
    が要ること、かつこのアプリはIPv6経路を他に何もサポートしていないこと
    から、IPv6固有の案内ロジックを都度直し続けるより「IPv6には今は案内
    しない」方針に倒した方が単純で安全と判断した。
    - `banto_server::lan_urls_for_bind`はIPv4のみを案内する
      （loopback・`0.0.0.0`・特定IPv4）。bindがIPv6（loopback・wildcard・
      特定アドレスいずれも）または解析できない文字列のときはURLを一切
      返さない（生の文字列をそのままURLにしていた旧fallbackも廃止 —
      接続先として使えないURLを案内しないため）。IPv6のNIC列挙・
      dual-stack案内・リンクローカル除外の実装は削除し、コードを縮小。
    - 画面側（`connectivityScope.ts`）も`isLoopbackHost`/
      `isUnspecifiedHost`/`pickPrimaryLanUrl`をIPv4専用に単純化し、
      新設の`isIpv4Bind`でIPv6バインドを判定して「IPv6の待受は接続先の
      案内対象外」という専用の状態文言・注記を表示し、URL一覧・QRは
      出さないようにした（初期値は変更なし）。
    - 固定fixtureの表テスト・反証（Rust・フロント双方）をIPv4専用の設計に
      合わせて全面的に更新。

- fix(admin-core, banto-admin-services, banto-server, admin-template): 監査ログ画面の
  縮小コピー（`AuditLogWindow`）に残っていた #243 と同じ欠陥を直し、ブロックの合間の
  行の増減で重複・欠落しないよう**境界（`asOfId`）付きのブロック読み込み**を入れる
  （#248、[ADR-0015](docs/adr/0015-snapshot-list-resource.md)）。**派生アプリへの影響:
  API の破壊的変更は無い（追加のみ）。ただし監査ログ画面と Tauri の `audit_log_list`
  コマンドは組で更新すること**（新しい画面は応答の `asOfId` を必須とする）。
  - `@banto/admin-core`（追加）: `SnapshotListResource` / `createSnapshotListResource(fetcher,
options)` / `SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE` と型 `SnapshotListFetcher` /
    `SnapshotListRequest` / `SnapshotListResult` / `CreateSnapshotListResourceOptions`。
    取得関数を注入で受け取り（`DataProvider.getList` は変えない）、世代の最初の応答の
    境界を後続のブロックに渡す。境界が決まるまで要求は 1 本だけ。同じ境界の総件数が
    変わったら失効（`expired`）として続きを読まず、`refresh()` で新しい世代にする。
    失敗はブロック単位（`failedBlocks` / `error`）、`{0, 0}` からも回復、応答しない
    要求は `requestTimeoutMs`（既定 30 秒）で失敗にして `AbortSignal` を中断、新しい
    世代は処理中の要求を中断し、世代の違う応答は捨てる。`totalCount` は未取得のあいだ
    `null`（「未取得」「取得失敗」「正常な 0 件」を区別できる）。応答の任意の
    `deletionEpoch` が世代の最初と違っても失効にする。`WindowedListResource`
    の公開 API・挙動は変えていない（内部の小さい判断を `blockFetch.ts` へ共有化）。
  - `banto-admin-services`（追加）: `AuditLogService::list_as_of(params, as_of_id)` と
    `AuditLogList`（`rows` / `totalCount` + `asOfId`）。境界の決定・行・件数を 1 つの
    読み取りトランザクションで行う（PostgreSQL は `REPEATABLE READ, READ ONLY`）。
    `list(params)` の型と結果は従来どおり。並びは `ColumnMap` の一意キー `id` で
    一意（同じ時刻の行も `id` の順。SQLite / PostgreSQL の両方でテスト）。
    **削除の世代**（`AuditLogList::deletion_epoch` / `deletionEpoch`、定数
    `DELETION_EPOCH_KEY` = `settings` の `audit.deletion_epoch`）: `prune` は削除を
    1 つのトランザクションで行い、行を消したときは同じトランザクションで世代を
    1 進める（行数の上限の削除は件数を数える `SELECT` と削除を 1 つの文にまとめた）。
    一覧は行・件数と同じ読み取りトランザクションでそれを読んで返す。PostgreSQL で
    小さい `id` の遅れたコミットと同じ件数の削除が重なっても、件数は同じまま集合が
    入れ替わったことを検出できる（#256 レビュー）。マイグレーションは不要。
  - `banto-server`: `POST /api/audit-log/list` が任意の `?asOfId=` を受け取り、応答に
    `asOfId` と `deletionEpoch` を足す（`rows` / `totalCount` は従来どおり）。**`asOfId` 付きの取得では
    保持期間の削除を走らせない**（上限に張り付くと 2 ブロック目以降がいつも失効する
    ため。banto-industrial #448 / #464 と同じ）。不正な `asOfId` は 400 `bad_request`。
    admin 限定は変えていない。
  - admin-template: Tauri の `audit_log_list` に任意の `asOfId` 引数（REST と同じ
    挙動）。`listAuditLog(params, asOfId?, signal?)` は `AuditLogList` を返す。監査ログ
    画面は `createSnapshotListResource` に置き換え、読み込み失敗の表示・常に押せる
    「再読み込み」・失効の説明・「未取得」「取得失敗」「0 件」の出し分けを追加
    （i18n キー 7 件を ja / en に追加）。
  - banto-industrial（chronogazer / banto-hub）: 自前の `AuditLogService` と
    `blockCache.ts` を持ち、banto の監査ログ API・`AuditLogService` は使っていない
    ため影響なし。`auditBlocks.ts` の失効判定も件数だけに頼っているが、どちらも
    SQLite（書き込みが 1 本ずつで遅れたコミットが無い）なので実害は無い。
    PostgreSQL に移すときは削除の世代が要る。`@banto/admin-core` を上げたあと、`blockCache.ts` /
    `auditBlocks.ts` を `SnapshotListResource` に置き換えるかは任意。

## [1.7.3] - 2026-09-28

**v1.7.3 — 一覧のページングの重複・欠落を直す修正。派生アプリへの影響: 一覧の並びが変わりうる（API の破壊的変更は無い）。**
`banto-storage` の `ORDER BY` に一意キー（既定 `id`）を足すようになり、
`LIMIT`/`OFFSET` を使う一覧で同じ値の行が多い列でも重複・欠落しなくなる。
並べ替えの指定が無いときは一意キーの昇順（従来と同じ向き）。InMemory の
`DataProvider` と grid の client sort も同じ規則にそろえた。追加 API:
`ColumnMap::unique_key` / `without_unique_key` / `unique_key_column`、
`WindowedListResource` の `failedBlocks` / `requestTimeoutMs`。あわせて、
`systemInfoStore.available` がモジュール読み込み時に固定される不具合の
修正と、Dependabot 依存更新を含む。

- 依存更新（Dependabot・#200/#201/#202）: pnpm/action-setup / taiki-e/install-action
  / uuid / npm minor-patch グループ（@playwright/test・eslint・prettier・
  typescript-eslint・vite・jsdom・@lucide/svelte・@inlang/paraglide-js・
  @inlang/plugin-m-function-matcher）。
- fix(admin-template): `systemInfoStore.available` がモジュール読み込み時に
  1 回だけ判定され、`bantoReady` がモードを `'server'` にする前に評価される
  と `false` のまま固定される問題を修正（#244）。System Info のカードが
  出ず、読み込みの effect も走らなかった（E2E 11a がモジュール評価順次第で
  落ちる原因）。`available` をゲッターにして読むたびに再評価する。回帰
  テストを追加（`systemInfoStore.test.ts`、admin-template に vitest 一式を
  新設）。
- fix(banto-storage, admin-core): 一覧のページングで行が重複・欠落する問題と、
  `WindowedListResource` が失敗から回復できなくなる問題を修正（#243）。
  **派生アプリへの影響: 一覧の並びが変わりうる**（API の破壊的変更は無い）。
  - `banto-storage`: `append_order_by`（`apply_list_params`）は `ORDER BY` の
    最後に一意キーを、最後の並べ替えと同じ向きで足す（すでにその列で並べて
    いれば足さない）。並べ替えの指定が無ければ一意キーの昇順で並べる（従来は
    `ORDER BY` 無し。SQLite の rowid 順・InMemory の挿入順と同じ向き）。同じ値の
    行が多い列で `LIMIT`/`OFFSET` を使うと、PostgreSQL では実際にブロック間で
    重複・欠落していた（3000 行・3 値の列で 771 行）。
  - 一意キーは既定で `ColumnMap` に登録された `id`。**`id` が一意でない
    `ColumnMap` は `.without_unique_key()` で外す**か、別の列を
    `.unique_key("field")` で宣言する（追加 API。`unique_key_column()` で確認
    できる）。`id` を登録していない `ColumnMap` は従来どおり（一意キー無し）。
  - `WindowedListResource`: 失敗をブロック単位で持つ（追加: `failedBlocks`。
    `error` はまだ回復していない最新の失敗で、別のブロックの成功では消えない。
    `setParams()` で消え、`refresh()` では再取得が成功するまで残る）。取得世代に
    総件数がまだ無い間は、表示範囲が `{0, 0}` でも先頭ブロックを取りに行く
    （最初の取得の失敗や 0 件の後に、`refresh()`・通知・絞り込みの解除が要求を
    出さなかった）。`setParams()` は最後の範囲を自分で取り直す（呼び出し側の
    `ensureRange()` はその要求に合流する）。`ensureRange()` の Promise は、範囲に
    かかる処理中のブロックの完了も待つ。応答しない要求は `requestTimeoutMs`
    （追加オプション、既定 `DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS` = 30 秒）で
    失敗にし、`loading` が降りなくなることを防ぐ。
  - 取得の合間の行の増減による `OFFSET` のずれ（世代のスナップショット境界）は
    `DataProvider.getList` の API 変更を伴うため入れていない。一般の CRUD 画面は
    SSE の `invalidate` で取り直される。
  - admin-template: `ItemsServerGrid` に読み込み失敗の表示と「再読み込み」を追加。
  - **並びの決まりを JS 側にもそろえた**（レビュー対応）: InMemory の
    `DataProvider` は同順位の行を `idField`（既定 `id`）で最後の並べ替えと同じ
    向きに並べ、並べ替えが無ければ `idField` の昇順で返す（従来は挿入順）。
    grid の client sort（`sortRows`）も同順位の行を行の `id`（無ければ新しい
    第 4 引数 `getRowId`。`BantoGrid` は自分の `getRowId` を渡す）で同じ向きに
    並べる（従来は元の配列の順。並べ替えが無いときは従来どおり配列の順）。
    SQL・InMemory・grid の 3 つが共通の fixture
    （`crates/banto-storage/testdata/list-order-parity.json`）で一致を確かめる。
    **派生アプリへの影響: クライアントモード・InMemory でも、同じ値の行の並びが
    変わりうる**（降順では `id` の大きい行が先）。未知の列の並べ替え（SQL は
    `ColumnMap` に無い列、grid は列定義に無い列、InMemory はどの行にも無い
    フィールド）は、向きを決める前に 3 つとも除く。
  - `WindowedListResource`（レビュー対応）: `getList` が同期的に throw しても、
    処理中の記録が残って `loading` が降りなくなることは無い（記録を先に作って
    から要求を始め、同期の throw は reject した Promise として扱う）。通知
    （`notifier`）の throw や、形の崩れた応答（`rows` が配列でない・`totalCount`
    が 0 以上の整数でない・`totalCount` や書き込み先の末尾が配列の長さの上限
    `2 ** 32 - 1` を超える）もそのブロックの失敗として扱い、状態を取り残さない
    （公開する `totalCount` は常に配列の長さとして有効な値に保つ）。

## [1.7.2] - 2026-09-26

**v1.7.2 — セッション失効（強制ログアウト・パスワード変更・降格）を、開いている画面に即座に伝える修正。破壊的変更は無い。**
`admin-core` の `EventProvider`（SSE）が、失効したセッションで再試行を止め、
`/api/auth/check` の `200 false` でもトークンを消すようになった。**開いている
画面をログイン画面へ移すには、保護ルートのレイアウトに `onSessionEnded` の
購読を 1 行足す**必要がある（下記参照）。足さない場合も、失効したセッションでの
API はサーバーが `401` で拒否するので認可は破られないが、画面への反映は次に
ルートガードが再評価されるとき（再読み込みや明示的な `invalidateAll()` など）に
なる。同じレイアウトの中の通常の画面遷移だけでは、ログイン画面へ移ることは
保証されない（SvelteKit はレイアウトの `load` を再実行しない場合がある）。

- fix(admin-core): 失効したセッションで、SSE（`/api/events`）が再試行を続け、
  `/api/auth/check` の `200 false` でもトークンが残る問題を修正（#241）。
  - `check()`（`createHttpAuthProvider`）は、`401` に加えて `200 false`（失効が
    確認できた）でも保存しているトークンを消す（Remember me の localStorage も）。
    消すのは確認したトークンがまだ保存されているときだけ（確認中に新しくログイン
    したトークンは消さない）。`500`・到達不能では従来どおり消さずに reject する。
  - SSE のクライアントは、再接続が `401` なら、そのトークンでの再試行をやめ、
    別のトークン（再ログイン）が現れるまで要求しない。`500`・到達不能・
    ストリームの終了は従来どおり 3 秒ごとに再試行する。
  - `connectEvents` は SSE の `401` を受けると `check()` で確認し（ここで
    トークンが消える）、`false` のときだけ新しい `onSessionEnded` の購読者に
    知らせる。SSE は失効したトークン・消えたトークンごとに 1 回だけ知らせ、重なった
    確認は、先に通知したあとなら通知しないので、同じ失効の通知は 1 回。確認の
    途中で届いた新しい知らせは、その確認の結果（`valid` を含む）では打ち消さず
    もう一度確認する（#242 の再レビュー対応）。画面の遷移で失効に気付いた経路は
    ルートガードが自分でログイン画面へ移し、トークンの消去は確認したトークンに
    限るので、2 つの経路が互いを巻き戻さない。
  - 確認が照合できない（`500`・到達不能・10 秒応答なし）ときは、失効した
    トークンでの SSE の再送は止めたまま、確認だけを 1 秒から倍々（上限 30 秒）の
    間隔で再試行する（`createSessionEndConfirmation`）。10 秒を過ぎて届いた
    `200 false` はトークンを消し、次の再試行がトークン無しで（要求を送らずに）
    失効を確定して知らせる。`confirmSessionEnded` の戻り値は
    `'ended' | 'valid' | 'unknown'`。
  - 別のタブが Remember me の共有トークン（localStorage）を先に消した場合:
    SSE は再接続のときに「使っていたトークンが消えた」ことを検知し
    （`EventSubscriptionHooks.onTokenCleared`）、同じ確認に渡すので、後のタブも
    ログイン画面へ移る。初回のログイン前の待機と、新しいログインによる置き換えは
    これに当たらない。
  - 購読者がいないとき（最初の保護ルートの読み込み中・ログイン画面）に確定した
    失効は覚えておき、次に `onSessionEnded` を購読したときに `check()` で確認し
    直してから知らせる（#242 の 3 回目のレビュー対応）。確認し直すので、その間に
    新しくログインしていれば古い失効では追い出さない。購読の呼び出しの中では
    購読者を呼ばない（`$effect` の中から購読してよい）。
  - **派生アプリ**: タグを上げるだけで、再試行の停止とトークンの消去は効く。
    **開いている画面をログイン画面へ移すには、保護ルートのレイアウトに
    `onSessionEnded` の購読を 1 行足す**（admin-template は
    `routes/(app)/+layout.svelte` の
    `$effect(() => onSessionEnded(() => void invalidateAll()));`）。ルートガード
    （`resolveProtectedSession`）が再実行され、ログイン画面（公開閲覧が ON なら
    閲覧者セッション）へ移る。足さない場合、画面への反映は次にルートガードが
    再評価されるとき（再読み込みや明示的な `invalidateAll()` など）になり、同じ
    レイアウトの中の通常の画面遷移だけではログイン画面へ移ることは保証されない
    （失効したセッションでの API は、サーバーが `401` で拒否する）。
    `EventProvider` を自前で実装している場合、`subscribe` の第 2 引数
    （`EventSubscriptionHooks`、任意）は無視してかまわない。`connectEvents` の
    戻り値の関数は、購読の解除と一緒に確認の再試行も止める。
  - E2E: 別のブラウザで Remember me ログインした閲覧者の画面が、管理者による
    パスワードのリセットのあとログイン画面へ移り、トークンが消え、SSE の再試行が
    止まることを確かめるシナリオ 13b と、同じブラウザの 2 つのタブで Remember me の
    トークンを共有し、片方が消したあと両方がログイン画面へ移ることを確かめる
    シナリオ 13c、最初の保護ルートの読み込み中（レイアウトが購読を始める前）に
    失効が確定してもログイン画面へ移ることを確かめるシナリオ 13d を追加。

## [1.7.1] - 2026-09-25

**v1.7.1 — グリッドの初回クリック取りこぼしの修正と、`AuthState::revalidate` の公開。破壊的変更は無い。**
v1.7.0 から上げるだけで直り、`@banto/grid-svelte` を使っている派生アプリの
追従作業は不要。`revalidate` の公開は可視性を広げるだけの追加で、派生アプリは
自前の長時間ストリームの再検証に使える（使わなければ変更不要）。

- feat(banto-server): `AuthState::revalidate` を `pub` にした（#239）。
  `authenticate` と同じ照合（再バインドの扱いを含む）をしつつ、無操作期限
  （idle）のタイマーを延ばさない再検証で、`/api/events` の定期再検証
  （#231）が使っているのと同じもの。派生アプリが自前の長時間ストリーム
  （banto-industrial の `/api/tag-stream`・`/api/v1/stream`、
  banto-industrial#430）で同様の再検証をできるようにするための公開。破壊的
  変更ではない（既存の可視性を広げるだけ）。

- fix(grid): グリッドの下端が画面の外に出ているとき（画面を開いた直後に多い）、
  行をクリックするとセルは選択されるのに `onRowClick` が呼ばれない問題を修正
  （#236）。セルの `pointerdown` でグリッドにフォーカスを移す際、グリッドを
  見せようとページがスクロールし、ボタンを離した位置が別の要素になって `click` が
  セルに届いていなかった。フォーカスの移動を `preventScroll` にした（キー操作での
  選択移動のスクロールは従来どおり）。v1.6.0 以前からある挙動で、#222〜#227 の
  変更は原因ではない。単体テスト（読み込み直後・再取得中のクリック）と、ユーザー
  一覧を開いた直後のクリックで編集パネルが開く E2E を追加。

## [1.7.0] - 2026-09-24

**v1.7.0 — セッション失効・添付ストレージの堅牢化とグリッド操作の安定化リリース。**
v1.6.0（2026-09-14）以降の PR #222〜#234（12 件、#204/#205/#206/#207/#208/#209/
#210/#211/#212/#213/#214/#231）をまとめる。

**破壊的変更（派生アプリはタグを上げる前に確認）**:

- **`banto_server::AuthState` の全コンストラクタ（`new`/`with_policy`/
  `with_policies`）が `SessionValidation` を必須引数に取るようになった**（#204）。
  タグを上げると既存の呼び出しはコンパイルエラーになる。**実アカウントを持つ
  アプリでは、アカウントと照合する `SessionValidation::Lookup` を組み込む。**
  `SessionValidation::DisabledNoRevocation` はアカウントの保存先を持たない
  テスト・公開閲覧専用サーバ向けで、削除・降格・パスワード変更によるセッション
  失効は行われない（コンパイルエラーを消すためだけに選ばないこと）。移行手順は
  下記 #204 の項目に手順 1〜6 で記載。
- **PostgreSQL では環境変数 `BANTO_ATTACHMENTS_DIR` が必須になった**（#208）。
  未設定だと `banto-serve` は起動しない（作業ディレクトリ基準の既定値は廃止）。
  SQLite は変更なし。移行手順（旧保存先からのコピー）は下記 #208 の項目に記載。

- feat(forms/settings): 保存型の画面で未保存の変更を示し、保存せずに離れようとしたら
  確認する（#214、P2）。対象は商品の新規作成・詳細、設定の「サーバ・接続」
  「セキュリティ」と「アカウント」のパスワード変更。未保存の間は保存ボタンの横に
  「未保存の変更があります」を出し、商品フォームには「一覧へ戻る」（＝取り消し）、
  設定には「変更を取り消す」を足した。「サーバ・接続」「セキュリティ」には、
  「保存して適用」を押すまで反映されない（外観・言語はすぐ反映される）ことを短く書いた。
  確認は既存の削除確認と同じ `window.confirm`。再読み込み・タブを閉じるは
  ブラウザ標準の確認、Tauri のウィンドウを閉じるときも確認する（未保存の間だけ
  close-requested を購読。capability に `core:window:allow-destroy` を追加）。
  変更なし・値を元に戻した・保存に成功した・取り消した後は確認しない。保存中の
  離脱は確認し、離脱後に保存が終わっても元の画面へ引き戻さない。ログイン画面への
  移動（ログアウト・セッション失効）は確認しない。ドラフトの復元はしない（保存先・
  古いドラフト・複数タブの扱いが要るため、確認のみ）。

  **`@banto/forms` の追加 API**（破壊的変更なし）: `guardUnsavedChanges(options)`
  （コンポーネント初期化中に呼ぶ）、`hasUnsavedChanges()`（リアクティブ。どれか
  1 つでも未保存なら `true`）、`UnsavedChangesNotice`（未保存マーカー）、
  `FormStore.markClean()`（今の値を「保存済み」にする）。判定表は純関数
  `decideLeave` / `runLeaveCheck` で公開。パッケージは SvelteKit に依存しないため、
  `beforeNavigate` は呼び出し側が渡す。同じ画面に複数のガードがあっても、確認は
  1 回だけ出る。`guard.canAutoNavigate` は、離脱を承認して遷移中の間（遷移先の
  読み込み中を含む）とアンマウント後に `false` になり、遷移が中止・失敗すると
  `true` に戻る。保存後の自動遷移はこれを見て行う（`guard.leaving` /
  `guard.disposed` も個別に読める）。

  **保存済みの値を読み込んで下書きと比べる画面**（「サーバ・接続」「セキュリティ」）は、
  保存済みの値が取れるまで入力と保存を無効にし、取得に失敗したら「再読み込み」を出す。
  取得前の下書きは比べる相手がないため、編集を許すと未保存として検知できない。
  派生アプリで同じ作りの画面を守るときも、同じようにすること。

  **派生アプリでの使い方**（タグを上げたあと、保存型の画面ごとに）:

  ```ts
  import { beforeNavigate, goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { guardUnsavedChanges } from '@banto/forms';

  const guard = guardUnsavedChanges({
  	isDirty: () => store.isDirty, // 自前の下書きなら「下書き !== 保存済みの値」
  	isSaving: () => saving, // 保存中も離脱を確認する
  	beforeNavigate,
  	message: () => '保存していない変更があります。変更を破棄してこの画面から移動しますか？',
  	isForced: (nav) => nav.to?.url.pathname === `${base}/login` // ログアウト等は確認しない
  });

  // 保存に成功したら、移動の前に「未保存でない」状態にする（保存中フラグも先に下ろす。
  // 立ったままだと、この goto にも確認が出る）
  store.markClean(); // FormStore の場合。自前の下書きは保存済みの値に揃える
  // 利用者が別の画面を選んだあと（遷移先の読み込み中も含む）は、保存後の自動遷移をしない
  if (guard.canAutoNavigate) await goto(`${base}/list`);
  ```

  マーカーは `<UnsavedChangesNotice pending={guard.pending} label="未保存の変更があります" />`。
  admin-template では `$lib/unsavedChanges.ts` が `beforeNavigate`・文言・
  `isForced` を束ねた薄い包みなので、これを写して使うのが早い。Tauri の
  ウィンドウ終了も確認するなら、`$lib/banto/windowCloseGuard.ts` と
  `(app)/+layout.svelte` の `$effect`（`hasUnsavedChanges()` が `true` の間だけ
  `guardWindowClose` を登録）を写し、capability に `core:window:allow-destroy`
  を足す（close-requested を JS で購読すると、閉じる処理を JS の `destroy()` が
  行うため。足さないと未保存の間はウィンドウが閉じられなくなる）。

- fix(attachments): `BANTO_DB` が PostgreSQL の接続 URL のときも、その文字列を
  ファイルパスとみなして添付の保存先を作っていた問題を修正（#208、P2）。同じ
  サーバーの別の DB（`…/banto_a` と `…/banto_b`）が同じ保存先を共有して、
  id が同じ添付の本体を上書きしていた。パスワードを変えると保存先が変わって
  既存の添付を見失い、保存先のパスには接続の資格情報が入っていた。
  - **PostgreSQL では新しい環境変数 `BANTO_ATTACHMENTS_DIR` が必須**。その下に
    DB ごとのサブディレクトリ `pg_<ホスト>_<ポート>_<DB名>_<ハッシュ16桁>` を作る
    （ユーザー名・パスワードは含めない。変えても保存先は変わらない。ホスト名の
    書き方 `localhost`/`127.0.0.1`、ポート、DB 名を変えると別の保存先になる）。
    **未指定なら `banto-serve` は起動しない**（作業ディレクトリ基準の既定値は
    作らない）。**SQLite は変更なし**（DB ファイルの隣の `attachments`。
    `BANTO_ATTACHMENTS_DIR` は使わず、設定されていれば警告だけ出す）。
  - **本体を上書きしない**: 本体は `create_new` で書き、同じ id のファイルが
    既にあればアップロードを失敗させる（行も残さない）。
  - `banto-serve` の起動ログ（`DB at …`）と、`postgres` feature 無しで PostgreSQL
    URL を渡したときのエラーから、接続の資格情報を除いた（`db::display_target`）。
    形が曖昧な URL（資格情報にエスケープされていない `?`/`#`/`/`/`@` がある等）や、
    スキームの誤った接続文字列は、入力を含まない固定の表記（`postgres://<redacted>` /
    `<redacted>`）で表示する。
  - 追加 API（`banto-attachments`）: `base_dir_for_target` / `postgres_storage_key` /
    `sqlite_base_dir` / `legacy_base_dir`、`AttachmentsService::import_legacy_files`
    と `LegacyImportReport`。`admin-template-core`: `db::display_target`。既存の
    API の変更は無い。

  **移行手順**（PostgreSQL で `banto-serve` を動かしていた場合。SQLite は不要）:
  1. 添付の保存先にするディレクトリを決め、`BANTO_ATTACHMENTS_DIR` に設定する
     （絶対パスを推奨。相対パスは作業ディレクトリ基準になる）。
  2. **これまでと同じ作業ディレクトリ・同じ `BANTO_DB`** で起動する。起動時に、
     旧保存先（作業ディレクトリ下の、接続 URL から作られた `postgres:` /
     `postgresql:` で始まるディレクトリ）から、その DB の添付を新しい保存先へ
     **コピー**する。各ファイルは DB に記録した sha256 と照合し、一致したものだけ
     移す（旧保存先は複数の DB で共有されていたため、別の DB のファイルや上書き
     されたファイルは移さない）。旧保存先のファイルは成功しても失敗しても**消さない**。
     コピーは処理ごとに一意な一時ファイルに書いてからハードリンクで確定するので、
     複数のプロセスが同時に移行しても、既存のファイルを上書きせず、書きかけの
     ファイルも残さない（ハードリンクが使えないファイルシステムでは「失敗」に数え、
     旧保存先に残す）。新しい保存先に既にある本体も sha256 を照合し、DB の値と
     違えば上書きせずに警告として数える。結果は件数でログに出る。移せなかった分
     （サムネイルだけ欠けた分も含む）は、原因を直して再起動すれば再試行される
     （移行済みの分は飛ばす）。旧保存先は**いまの** `BANTO_DB` から求めるので、
     以前ユーザー名やパスワードを変えていて旧保存先が複数あるときは、古いほうの
     中身をいまの旧保存先へコピー（上書きしない）してから再起動する。
  3. 同じ接続先の DB をすべて起動し終え、添付が開けることを確かめたら、旧保存先の
     ディレクトリを手で消す（ディレクトリ名に接続の資格情報が入っている）。
     「別の DB のファイル」が残った添付は、#208 の上書きですでに本体が失われて
     いる可能性がある。
  - **派生アプリ**（`banto-attachments` をタグで使い、自前で `AttachmentsService::new`
    を呼ぶアプリ）: PostgreSQL で動かすなら、保存先を `base_dir_for_target` で
    求め、旧保存先がある場合は `import_legacy_files` を起動時に呼ぶ（`banto-serve.rs`
    の該当箇所が手本）。SQLite だけなら対応は不要。

- fix(auth): ユーザーの削除・降格・パスワード変更・パスワードリセットで既存の
  セッションが失効しなかった問題を修正（#204、P1）。`users.auth_epoch`（認証の世代、
  migration `0007`）を追加し、セッションを確立時の「行 id + 世代」に結び付けて、
  REST（`require_auth`）と Tauri（`require_role`）の両経路で**要求ごとに DB と照合**
  する。アカウントが無い・世代が違えば失効（401）、一致すれば DB の今のロールで
  認可する。変更はどちらの経路から行っても、他方の経路・別プロセス・Remember me の
  セッションにも効く。自分のパスワード変更では、変更した当のセッションだけ残る
  （[ADR-0014](docs/adr/0014-account-bound-session-revocation.md)、conventions §6）。
  **Rust API の破壊的変更（タグを上げると必ずコンパイルエラーになる）**:
  `banto_server::AuthState` のすべてのコンストラクタ（`new`/`with_policy`/
  `with_policies`）が `SessionValidation` を**必須の引数**に取る（既定値は無い）。
  `SessionValidation::Lookup`（アカウントと照合する。実アカウントでは唯一の選択肢）か、
  `SessionValidation::DisabledNoRevocation`（照合しない＝従来の挙動。アカウントの
  保存先を持たないテスト・公開閲覧専用サーバのためだけ）を名前で選ぶ。ほかに
  `banto_admin_services::users::UserIdentity` に `auth_epoch` を追加、
  `UsersService::change_password` が新しい世代（`i64`）を返す、
  `banto_server::LoginOutcome` に `Unavailable` を追加（`POST /api/auth/login` が
  503 を返し得る）。`/api/auth/{check,identity}` は照合中の DB エラーを 500 で
  返す。

  **フロントエンド（`@banto/admin-core`）の挙動変更**: `AuthProvider.check()` は、
  セッションが無効と**確認できたとき**（トークン無し・`401`・`200 false`）だけ
  `false` を返し、サーバーが照合できなかったとき（`500`・接続不能）は
  `ProviderError` で**reject** する（従来は `false`。一時的な DB エラーで
  ログイン画面へ飛ぶ・閲覧公開 ON なら閲覧者トークンで元のトークンを上書きする、
  が起きていた）。保護ルートの判断は新しい `resolveProtectedSession(auth)` に
  まとめた（`'session' | 'publicViewer' | 'login'` を返し、照合できなければ
  reject。reject 時は `status()`・`enterPublicViewer()` を呼ばず、トークンにも
  触れない）。admin-template の `(app)/+layout.ts` は reject を 503 のエラー画面
  （新設の `routes/+error.svelte`、再試行ボタン付き）にし、`panel/[id]` は
  「確認できませんでした」を表示する。Tauri の `auth_check` も DB エラーは
  `Err`（reject）で、同じ区別になる。

  **派生アプリの移行手順**（`banto-server` をタグで使い、`users` テーブル・
  サービス・`src-tauri` を自前で持つアプリ）: タグを上げると `AuthState::new(verifier)`
  などの呼び出しが**コンパイルエラー**になる。そこで、**照合を組み込む**（手順 1〜5）
  か、**明示的に無効化する**（`SessionValidation::DisabledNoRevocation` を渡す。
  失効は起きないまま。実アカウントを持つアプリでは選ばない）かを選ぶ。

  1. **マイグレーション**: 両方の方言に 1 本ずつ足す（既存の行は 0 で始まる。
     セッションはメモリにしか無いので既存セッションの移行は不要）。
     SQLite: `ALTER TABLE users ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;`
     / PostgreSQL: `ALTER TABLE users ADD COLUMN auth_epoch BIGINT NOT NULL DEFAULT 0;`
  2. **ユーザーサービス**（自前の `users.rs` を持つ場合。`banto_admin_services` の
     `UsersService` を使うなら不要）: `UserIdentity` に `auth_epoch` を持たせ、
     `verify`・`get_by_username` の `SELECT` と作成時の `RETURNING` で読む。
     ロール変更（`auth_epoch = auth_epoch + CASE WHEN role = ? THEN 0 ELSE 1 END`）・
     パスワード変更・パスワードリセットの **`UPDATE` と同じ文で**増やす。
     パスワード変更は `RETURNING auth_epoch` で新しい世代を返す。
  3. **REST の `AuthState`**: `AuthState::new(verifier, SessionValidation::lookup(lookup))`
     にする。`lookup` はユーザー名から `SessionAccount { identity（今のロール）,
stamp: SessionStamp { account_id: 行 id, auth_epoch } }` を返す（無ければ
     `Ok(None)`、DB エラーは `Err`。ログイン時は入力どおりのユーザー名で呼ばれるので、
     ユーザー名を正規化する検証関数なら lookup も同じ正規化をする）。
     `banto_admin_services::UsersService` なら
     `banto_server::routes::user_auth_state(users, audit)` で済む。テストで固定の
     検証関数を使う箇所は `SessionValidation::DisabledNoRevocation` でよい。
  4. **REST のハンドラ**: `require_auth` の**外**でトークンから本人を引く箇所
     （自前の `change-password` など）は `auth.identity_for(token)` をやめ、
     `auth.authenticate(token).await?` を使う。`require_auth` の後ろの
     `identity_for`・自前のロールガードはそのままでよい（照合のたびに今の値へ
     書き戻される。ガードは `req.extensions()` の `AuthenticatedSession` も読める）。
     初期セットアップで作ったアカウントをそのままログインさせる箇所は
     `issue_token` を `issue_account_token(SessionAccount { .. }, false)` に替える
     （世代の無いトークンは拒否される）。自分のパスワード変更の後、そのセッションを
     残すなら `new_epoch == stamp.auth_epoch + 1` のときだけ
     `auth.rotate_session_epoch(token, stamp, new_epoch)` を呼ぶ。
  5. **`src-tauri`**（banto の型では強制できないので、ここは移行手順どおりに行う）:
     ウィンドウのセッションを `Mutex<Option<UserIdentity>>` から admin-template の
     `DesktopSession`（`Account` / `AuthDisabledLocal` の enum）に替える。こうすると
     セッションを作る箇所・読む箇所がすべてコンパイルエラーになり、種類の選択と
     照合の通し忘れを型で拾える。`require_role` の先頭で `current_session` を通し、
     `Account` は `users.get_by_username` で読み直して行 id と `auth_epoch` が
     一致しなければキャッシュを消して `Unauthorized`、一致すれば**読み直した値**
     （今のロール）で判定する。`AuthDisabledLocal` はログイン不要モードが今も ON かを
     読み直す（OFF なら消す）。合成セッションを `id == 0` のような値で判定しない。
     キャッシュの書き換えは、読む前の値と比べてから行う。`auth_check`・
     `auth_identity` も同じ照合を通す `async` コマンドにし、`change_own_password` は
     新しい世代へキャッシュを付け替える（合成セッションからは `Forbidden`）。
     admin-template の `DesktopSession` / `current_session` / `require_role` /
     `change_own_password`（`apps/admin-template/src-tauri/src/lib.rs`）をそのまま
     写せる。組み込みサーバの `rest_auth` も手順 3 の状態で作る。
  6. **フロントのルートガード**（`@banto/admin-core` を更新すると `check()` が
     reject し得るようになる）: `(app)/+layout.ts` をコピーして持っている場合は、
     `check()` → `status()` → `enterPublicViewer()` の手書きの分岐を
     `resolveProtectedSession(getAuthProvider())` に置き換え、reject は
     `/login` への遷移にも閲覧者への切り替えにもせず、エラー画面と再試行にする
     （admin-template の `(app)/+layout.ts` と `routes/+error.svelte`、メッセージ
     キー `app.sessionCheckFailed.*`・`app.error.*` を写せる）。そのままでも
     reject は SvelteKit の既定のエラー画面になり、トークンは消えない。
     `check()` を直接呼ぶ他の画面（admin-template では `panel/[id]`）も reject を
     「未ログイン」と区別する。

- fix(auth): 失効したセッションで開いたままの SSE（`/api/events`）が通知を受け
  続けた問題を修正（#231、#204 の既知の制約）。開いているストリームは keepalive と
  同じ 15 秒（`banto_server::events::REVALIDATE_INTERVAL`）ごとにセッションを
  照合し直し、アカウントの削除・降格・パスワード変更/リセット・ログアウト・期限切れで
  失効していればストリームを終える（失効から最大 1 間隔）。DB が照合に答えられない
  ときは終えず、次の間隔で照合し直す（#204 の「照合できないときはセッションを残す」）。
  照合は 5 秒（`REVALIDATE_TIMEOUT`）で打ち切り、打ち切りも同じ扱い。次の照合は
  前の照合が終わってから 1 間隔後なので、照合が遅くても通知の配信は止まらない。
  照合中に自分のパスワード変更で付け替えられたセッションは、要求と同じ判断で残る。
  この照合はセッションの無操作期限（idle）を延ばさない（開いたタブが無操作の
  セッションを生かし続けない）。公開閲覧のセッションと
  `SessionValidation::DisabledNoRevocation` は DB を読まず、アカウントの変更では
  終わらない（トークン自体が終わったときだけ終わる）。照合するのは
  `SessionValidation::Lookup` のアカウントのセッションで、開いているストリーム 1 本
  につき 15 秒に 1 回の索引読み。**派生アプリの対応は不要**（`sse_route` の
  シグネチャは同じ。フロントの `createSseEventProvider` は、終わったストリームを
  従来どおり再接続し、失効したトークンは `401` になる）
  （[ADR-0014](docs/adr/0014-account-bound-session-revocation.md)）。

- fix(users): 管理者の同時降格・削除で管理者が0人になる競合を修正（#207）。
  SQLite・PostgreSQLの両方で判定から更新までをDBトランザクションで保護し、
  最後の管理者への変更を拒否する。REST・Tauri共通のユーザーサービスに適用。

- fix(auth-ui): username が `public` の通常アカウントを公開閲覧セッションと
  誤判定する問題を修正（#209）。トークン発行元が返す `publicViewer` 属性で区別し、
  通常アカウントは自身のロールで操作できる。合成セッションのパスワード変更も
  同名アカウントの有無によらず拒否する。サーバー・admin-core の型と、派生側に
  コピーした session store の変更を合わせて取り込む必要がある。

- test(grid): 絞り込み入力の矢印・Tab・Enterをセル操作から分離する既存修正
  （PR #224）に、専用の回帰検証を追加（#213）。入力・条件選択の標準キー操作と
  条件適用を保護し、文字カーソル・フォーカス移動はブラウザーE2Eでも確認する。

- fix(users-ui): ユーザーの保存待ち中に選択を切り替えても、古い応答が現在の
  編集対象を戻さないよう修正（#206）。同じユーザーを選び直した場合や新しい入力も
  保護し、パスワードリセットの応答も後続の選択へ反映しない。削除成功時は
  同じユーザーを選び直していても編集パネルを閉じ、別ユーザーの選択と入力は維持する。

- fix(grid): インライン編集を行IDに結び付け、一覧の再取得・並べ替え・前方行の削除で
  入力が別レコードへ保存される問題を修正（#205）。編集対象が一覧から消えた場合は
  編集を中止する。保存待ち中にクリックした別セルの選択は維持し、サーバー表示の
  編集対象検索は取得済み行に限定する。クライアント・サーバー表示とグループ化、
  遅延保存中の選択、疎配列の回帰テストを追加。
- fix(grid): 保存待ち中に別の編集を始めた際、先行保存の成功・失敗で新しい入力が
  消去・上書きされる問題を修正（#210）。保存結果と確定後の移動を編集セッションに
  結び付け、同じセルを開き直した場合も古い応答が干渉しないようにする。
- fix(grid): 非編集時のTab/Shift+Tabでフォーカスがグリッド内に閉じ込められる
  問題を修正（#211）。ブラウザー標準の順序で見出しボタン・行リンクを経て
  グリッド外へ移動できるようにする。セル間移動は矢印キーを使い、編集中の
  Tab/Shift+Tabによる確定・左右移動は維持する。
  移動先の見出し・絞り込み・行リンクのキー操作が選択セルの編集や移動に
  奪われないよう、セル操作をグリッド本体からのキーイベントに限定する。
- fix(grid): Enter・Tabでの編集確定やEscapeでの取消後にフォーカスが外れ、
  キーボードだけで連続操作できない問題を修正（#212）。保存待ち中に他の要素へ
  移動した場合や新しい編集を始めた場合は、そのフォーカスと選択を維持する。
  商品の更新APIが返した行を次の編集へ反映し、一覧再取得が遅れても異なる列の
  連続保存で直前の変更を古い値に戻さない。
  サーバー一覧の再取得結果はまとめて切り替え、途中の空配列で編集・選択が
  解除されることを防ぐ。旧世代の行と新しい取得結果は混在させない。

## [1.6.0] - 2026-09-14

**v1.6.0 — 設定画面のページ分割。** v1.5.0（同日）以降の PR #197・#198 をまとめる。
変更は app 層（`apps/admin-template`）のみで、**`@banto/*` パッケージと `banto-*`
クレートは版数が 1.6.0 に上がるだけで実装内容は v1.5.0 と同一**（公開 API の
変更なし。タグ参照で消費している側に追従作業は無く、v1.5.0 のまま留まっても
差は無い。テンプレートを再同期する派生アプリだけが対象）。後方互換の機能追加の
ため minor。

- 設定画面をカテゴリごとのルート `/settings/{appearance,account,connectivity,data,security}`
  に分割（共通レイアウトに sticky の左レール / 狭い画面は横タブ、`/settings` と
  非可視カテゴリは先頭の可視カテゴリへリダイレクト）。派生アプリは「ルートを足す」
  形で設定を拡張できる。段階 1（section コンポーネント分割、挙動不変）を経て実施
  （[docs/choiapp-feedback-2026-09.md §3.1/§3.2](docs/choiapp-feedback-2026-09.md)）。

- refactor(settings): 設定画面をカテゴリごとの section コンポーネントに分割
  （`AppearanceSection` / `AccountSection` / `ConnectivitySection` /
  `DataSection` / `SecuritySection` + `settings.css` + 共有ストア 2 本。
  `+page.svelte` 1,812 行 → 約 110 行）。挙動・DOM・e2e/visual は不変
  （`main` の outerHTML 比較で `settings-page` クラス追加とコンポーネント境界の
  コメントノード以外に差分なし）。scaffold の glass remover の anchor を
  `AppearanceSection.svelte` に追従（4 プリセット `--dry-run --strict` 通過）。
  ページ分割（カテゴリごとのルート化）の前段
  （[docs/choiapp-feedback-2026-09.md §3.1](docs/choiapp-feedback-2026-09.md)）。
- feat(settings): 設定画面の5カテゴリ（外観・言語/アカウント/サーバ・接続/
  データ管理/セキュリティ）を実ルート（`/settings/{appearance,account,
connectivity,data,security}`）に分割。`/settings` は先頭の可視カテゴリへ
  307 redirect、非可視カテゴリへの直接遷移も同様に先頭へ redirect（挙動:
  URL 構造が変わる - ブックマーク/ディープリンクは新しいパスを使うこと）。
  カテゴリナビは ≥1024px で左レール（sticky）・それ未満で横タブ。
  section コンポーネント/`settings.css`/ストアは移動なし。e2e smoke
  シナリオ 11 と visual/a11y の settings 系エントリを更新
  （[docs/choiapp-feedback-2026-09.md §3.2](docs/choiapp-feedback-2026-09.md)）。

## [1.5.0] - 2026-09-14

**v1.5.0 — 「表示専用アプリを配れる」リリース。** v1.4.0（2026-08-29）以降に
main へ積まれた PR #182〜#184・#191〜#195 と dependabot 更新をまとめる。
**JSON ワイヤは項目追加のみ**（`GET /api/auth/status` の `viewerPublic`、
`SystemInfo.metrics`）で既定挙動は不変だが、**Rust 消費側にはソース互換の
破壊がある**（下記「消費側への注意」の 4 点。いずれもテンプレートからコピーした
`src-tauri/src/lib.rs` / `core/src/rest/mod.rs` が直接触る箇所）。公開 API の
削除・改名は無く、v1.4.0（sqlx 0.9 移行）と同じくオーナー判断で **minor** とする
（1.x 系では「消費側の追従作業を CHANGELOG のリード文に明記した上で minor」
を運用とする。docs/publishing.md「バージョニング規約」参照）。主な内容:

- **閲覧公開モード**（#189、ADR-0012）: LAN 端末がログイン無しで `viewer` 固定の
  合成セッションを得て閲覧できる。書き込みは常にログイン必須。
- **CPU/メモリ使用率の共通 API**（#185、ADR-0013）: `sysinfo` を feature
  `system-metrics` 限定で採用。下流アプリは自前の `sysinfo` 実装を
  `SystemMetricsSampler` に寄せ替えられる。
- **`pnpm scaffold --preset display`**（#190）: items 雛形・管理画面・
  ダッシュボードを外し、ログイン不要 + 閲覧公開 + キオスク表示を初期状態にする
  表示専用アプリ向けプリセット。本体側にはキオスク表示トグル・初回起動 seed 機構・
  `banto.i18n` opt-out が既定 OFF で入る。
- チョイアプリ・フィードバック対応（#182〜#184）: 固定シェル・設定カテゴリ・
  ナビバッジ・「ログインなしで使い始める」。

**消費側への注意（Rust、v1.4.0 → v1.5.0 の追従作業）:**

- `banto_admin_services::settings::ServerSettings` に `viewer_public: bool` が増えた。
  構造体リテラルで組み立てている箇所（テンプレートの `server_apply`）は
  `viewer_public` を足すか `..Default::default()` を使う。
- `banto_server::routes::SystemInfo` に `metrics: Option<SystemMetrics>` が増えた。
  Tauri 側の `system_info` コマンドで組み立てている箇所は `metrics: None`（または
  `system-metrics` feature の `SystemMetricsSampler` で取得した値）を足す。
- `banto_server::routes::extra_auth_router(users, auth, audit, allow_setup)` が
  `(…, allow_setup, settings: SettingsService, status_extras: Option<AuthStatusExtras>)`
  になった。テンプレートどおり `settings.clone()` と `None` を渡す。
- `banto_server::routes::system_info_router(service, auth, audit)` が
  `(…, audit, metrics: Option<MetricsProbe>)` になった。`None` で従来どおり。
- `sysinfo` は Windows で `windows` 0.62 系を引く（`src-tauri` の 0.61 系と並存）。
  不要なら `system-metrics` feature を `default` から外す（README「オプション資産の
  削除」）。

- feat(scaffold): `pnpm scaffold --preset display`（#190、PR-D2、
  [docs/display-preset-plan.md](docs/display-preset-plan.md) §3.2）— カンバン/常設
  ダッシュボード/展示デモ向けの**表示専用アプリ**を1コマンドで作れるようにした。
  `minimal` の7資産に加えて、新 remover **`items`**（デモリソース一式: サービス層・
  REST・Tauri コマンド・マイグレーション・画面・ナビ・文言・`verify-architecture` の
  マニフェスト行）、**`adminPages`**（users / audit-log の**画面のみ**。サービス層・
  REST・Tauri は escape hatch として残す）、**`dashboard`**（`/dashboard` を外し
  ホームを `/monitor` へ）を削除し、唯一の「足す」工程 **`displayDefaults`** が
  `/monitor` ページ雛形（`$effect` + 世代トークンのポーリング例）・ナビ項目
  （`publicViewer: true`）と、PR-D1 で本体に入れたトグルの既定値の反転
  （`FIRST_BOOT_SETTINGS` = 認証無効 + 閲覧公開 + LAN 有効 / `KIOSK_DEFAULT` /
  `banto.i18n = "raw"`）を適用する。e2e は items/users 前提のスイート
  （`tests/smoke.spec.ts` の全シナリオ・`tests-public-viewer/`・`visual/`）を
  シナリオ1本（未ログインの `/` が `/monitor` に着く）に差し替える。
  `template-acceptance.yml` の `presets` matrix に `display` を追加。
  `template-scope.md` §3 は `items` を「デモリソース（display で削除可）」に再分類。
- fix(scaffold): attachments remover が `core/src/rest/tests.rs` を
  「M20 章から EOF まで」削っていたため、その後に追記された閲覧公開スイート
  （Issue #189）まで巻き添えで消えていたのを修正（終端マーカーで範囲を閉じた）。
  `minimal` / `standard` プリセットの `cargo test -p admin-template-core` に
  閲覧公開の 6 テストが戻る。
- feat(shell/scaffold): `--preset display`（#190）の準備 PR-D1 — テンプレート本体に
  既定 OFF のトグルを足す（[docs/display-preset-plan.md](docs/display-preset-plan.md)
  §2「display が足すものは先に本体のトグルにする」）。①初回起動 seed 機構
  `admin_template_core::first_boot::FIRST_BOOT_SETTINGS`（既定は空。`settings`
  テーブルが空のときだけ書き込む。`banto-serve` / Tauri 起動時に M11 の判定より前に
  実行）、②キオスク表示トグル（UI 設定 `shell.kiosk`。ON でサイドバー折り畳み既定・
  ヘッダーコンパクト（`--banto-shell-header-height-compact`）・全画面ボタン
  （ブラウザ Fullscreen API / Tauri `setFullscreen`、capability
  `core:window:allow-set-fullscreen` を追加）。設定画面「外観・言語」に追加、
  visual スペック 1 枚追加 — ベースラインは `visual-baselines.yml` で生成）、
  ③`apps/admin-template/package.json` の `banto.i18n = "keys" | "raw"`
  （`raw` で `raw-jp-in-app` と `check-i18n-nonempty` を理由付きでスキップ、
  conventions §13）、④items デモ区画に `// [scaffold:items] begin/end` マーカー
  （`rest/tests.rs` の items テストを 1 ブロックに集約。挙動不変、テスト件数不変）。
  付随: コマンドパレット remover の Header.svelte anchor をキオスク分岐に追従
  （3 プリセットの `--dry-run --strict` で確認）。

- feat(auth): 閲覧公開モード（viewer-public、#189）— 「認証を外す」を書き込み軸
  （従来の M11、デスクトップ限定）と閲覧公開軸（新設）に分けた。
  `server.viewerPublic` を ON にすると LAN クライアントは
  `POST /api/auth/public-viewer` で **`viewer` 固定の合成セッション**
  （ユーザー名 `public`、同時 256 まで・古い順に失効）を得てログイン無しで
  閲覧でき、`GET /api/auth/status` が `viewerPublic` を返す（アプリ固有
  フィールドを足す `AuthStatusExtras` フックも追加）。「認証無効 + LAN 有効」の
  排他は閲覧公開 ON のときだけ緩む（両方向のバリデーション）。フロントは
  `(app)` のゲートが合成セッションを透過的に取得し、`NavItem.publicViewer`
  の許可リスト（既定 dashboard / items）で画面を絞り、ヘッダは「ログイン」
  ボタンに切り替わる。書き込みは合成セッションから常に 403 + `denied` 監査。
  設計は [docs/viewer-public-plan.md](docs/viewer-public-plan.md)、方式選定は
  [ADR-0012](docs/adr/0012-lan-public-viewer-synthetic-session.md)、
  手順は [docs/recipes/no-login-app.md](docs/recipes/no-login-app.md)。
  `banto-serve` は `BANTO_VIEWER_PUBLIC=1` で seed 可。e2e に
  `public-viewer` プロジェクト（別ポートの 2 本目の banto-serve）を追加。

- feat(system-info): System Info カードに CPU/メモリ（ホスト total/used・
  スワップ・プロセス RSS・CPU%・論理コア数）を追加（Issue #185、
  [ADR-0013](docs/adr/0013-sysinfo-system-metrics-feature.md)）。`sysinfo`
  （`default-features = false, features = ["system"]`）を `banto-admin-services`
  の opt-in feature `system-metrics` に限定して採用 - conventions §3
  「依存を足す側の例外」の2件目（Paraglide/ADR-0005 に続く）。
  `banto_server::routes::SystemInfo` に `metrics: Option<SystemMetrics>` が
  増えるのみで既存フィールドは不変（後方互換、REST/Tauri 対称は維持）。
  テンプレート側（`admin-template-core`/`src-tauri`）は既定でこの feature を
  有効化（README「オプション資産の削除」に外し方）。実測バイナリ増分:
  `admin-template-core --bin banto-serve` の release ビルド（`embed-ui` 無し）
  で 8,996,864 → 9,048,576 bytes（+51,712 bytes、約 +50.5 KiB、+0.6%）。

- ci(visual): スクリーンショット比較の許容を比率から絶対値へ
  （`maxDiffPixelRatio: 0.001` → `maxDiffPixels: 250`）。比率は fullPage の総画素
  基準だったため縦長ページほど検知が甘く（dashboard 約4,700px / items 約1,300px）、
  実測 568〜828px のヘッダチップ追加が全ページで見逃されていた
  （[docs/choiapp-feedback-2026-09.md §6](docs/choiapp-feedback-2026-09.md)）。
  同一環境の再描画差分は 0px のため 250 はアンチエイリアス用のバッファ。
  以後 Playwright/Chromium/ランナー更新で描画が変わるとスイートは赤くなる
  （意図した挙動。差分確認後に `visual-baselines.yml` で再生成する）。

- ci(visual): ベースライン再生成を `--update-snapshots=all` に変更し、通過中の
  スナップショットも必ず作り直すようにした。既定の `changed` モードは失敗した
  分しか書き換えないため、`maxDiffPixelRatio`（0.001）に収まる小さな変更は
  ベースラインが古いまま残り、ズレが蓄積していた（実例: 2026-09 のヘッダ
  ステータスチップは dashboard/items/users で可視だったが許容内で通過し、
  ベースラインは存在しないヘッダを写したままだった）。許容量が fullPage の
  総画素比であることに由来する検知限界も `e2e/visual/README.md` に明記。

- feat(shell/settings): チョイアプリ・フィードバック対応
  （[docs/choiapp-feedback-2026-09.md](docs/choiapp-feedback-2026-09.md)）—
  ①ヘッダ/サイドバーを sticky 化（本文スクロールから独立）、②設定ページを
  5カテゴリ節 + カテゴリジャンプナビに再編（旧 Danger zone は解体し
  データ管理/セキュリティへ、警告色は `.danger-card` で維持）、③サイドバーの
  未確認更新バッジ（`NavItem.badgeResource` + `$lib/navBadges.svelte.ts`、
  smoke シナリオ 13 で SSE 実経路を検証）とヘッダのステータスチップ
  （デモ/ロール）を追加、④初回セットアップ画面（Tauri）に
  「ログインなしで使い始める」を追加 — `auth_config_apply` にユーザー0人の
  ブートストラップ窓を開け、synthetic session をその場で合成して再起動なしで
  M11 ログイン不要モードに入れる（オーナー承認済み、手順は
  [docs/recipes/no-login-app.md](docs/recipes/no-login-app.md)）。ログイン
  不要モードはチョイアプリの常態のためヘッダにチップは出さない（オーナー
  決定）。付随して `StatusBadge` info 変種のコントラスト不足（4.1:1）を
  `--banto-primary-hover` で修正。

## [1.4.0] - 2026-08-29

**v1.4.0 — `sqlx` 0.8→0.9 移行を主とするリリース。** オーナー判断により
**minor** とするが、消費側にとっては破壊的変更を含む: `banto_storage::connect_sqlite`/
`connect_postgres` の戻り値・`storage_error`/`not_found` が受ける `sqlx::Error` は
sqlx 0.9 の型になるため、消費側（banto-industrial 等）は同じ sqlx 0.9 系へ追従する
必要がある。スキーマ・SQL 文の意味・公開 API の形自体は変更なし。また sqlx 0.9 は
**rustc 1.94.0 以上**を要求するため、消費側のツールチェーンにも影響する。

### 追加

- **グリッドの列表示/非表示（列マネージャー UI）**（issue #168、spec §4.4）。
  `GridColumn.hidden` で「定義は持つが既定では出さない」列を表現でき、
  `GridState` が `setColumnHidden` / `toggleColumnHidden` / `isHidden` /
  `allColumns` で表示状態を所有する（`orderedColumns` は可視列のみを返すため、
  セル選択やコピー&ペーストの列インデックスも自動的に追随する）。切り替え UI は
  新コンポーネント `ColumnsMenu`（ページ側ツールバーに置く。BantoGrid のヘッダ行は
  可視列幅から `grid-template-columns` を組むため、ヘッダ内には入れない）。
  admin-template の商品ページのツールバーに配線済み。
- **`columnsFromSchema` の `order` オプション**（issue #168）。一覧の列順を
  スキーマの定義順（＝フォームの入力順）から切り離して指定できる。列の既定非表示は
  `overrides: { code: { hidden: true } }` で表現する。
- **UI 宣言境界と Discussions 運用の ADR 化 + チャート性能ベンチ**。UI 宣言は
  スキーマ駆動の漸進拡張・追加レンダラは REST
  クライアント境界と決めた判断を ADR-0009 に、Discussions を決定前検討専用と
  する運用を ADR-0010 に記録。roadmap §3 のバックログを「チャート性能
  エスカレーション梯子」（SVG 実測→サーバ側間引き→Canvas→WebGL→ネイティブ
  候補ウォッチ）へ拡張し、template-scope §4.2 に非スコープ2行（クロス
  レンダラ共通ウィジェット DSL / 画面エディタ）、conventions §12 に
  Discussion 参照の文法行を追加。`packages/charts/tests/trend.bench.ts` を
  新設し、ルートの `pnpm bench` を recursive 化した。
- **初期ルールの棚卸し（ADR-0011 + トリガー修正 + PG バックアップ案内）**。
  ADR-0011（git タグ配布）を新設して publishing.md の失効理由を修正し、
  roadmap §3 に実需の供給源3系統（外部採用者/banto-industrial/メンテナ実案件）
  の明示と、判断昇格の記録ルール・12ヶ月時限の運用則を追加した。
  template-scope には i18n 辞書層の反転記録（§4.3/§5）と §7 の2026-08 現況を
  追記し、maintenance-review-2026-08 §2.4 に反転プロトコルと「条件付き判断の
  棚卸し」の定型節を追加した。README（ja/en）に PostgreSQL のバックアップ
  運用（`pg_dump`/`pg_restore`）を案内し、設定画面のバックアップ節も
  PostgreSQL 利用時の出し分け表示に対応した。
- **AI 対話による機能作成の設計方向を記録**。タグ定義・トレンドグループ構成・
  帳票テンプレートをシリアライズ可能な DB データとして持ち、AI アシスタント
  （claude CLI サイドカー + MCP → REST）が対話で作成できるようにする設計方向を
  industrial-plan §5 に追記した（宣言データの範囲 = 対話で作れる範囲、
  ADR-0009 の境界と同一線）。

### 変更

- **`sqlx` を 0.8 系から 0.9 系へ移行**。banto-industrial 側の 0.9 移行が
  `banto-storage` の 0.8 固定でブロックされていたための追従。
  `QueryBuilder<'a, DB>` のライフタイム引数削除（`QueryBuilder<DB>`）に
  伴う内部シグネチャ変更と、`sqlx::query`/`query_as`/`query_scalar` が
  `impl SqlSafeStr` を要求するようになったことに伴う `sqlx::AssertSqlSafe`
  ラップ（動的に組み立てる SQL 文のうち、埋め込む断片が `Dialect`
  由来のプレースホルダ／内部定数のみで外部入力を含まないことを確認した
  箇所のみ）を追加。**破壊的変更**: `banto_storage::connect_sqlite`/
  `connect_postgres` の戻り値・`storage_error`/`not_found` が受ける
  `sqlx::Error` は sqlx 0.9 の型になる（消費側の追従が必要）。
  スキーマ・SQL 文の意味・公開 API の形は変更なし。
- **`SerializedGridState` に `hidden: string[]` を追加（破壊的）**。
  `GridState.serialize()` の出力に列の表示状態が含まれるようになり、
  `hydrate()` は `hidden` を持たない旧ペイロードを**受け付けない**（不正な
  ペイロードと同じく無視され、レイアウトは既定値のまま）。永続化した
  グリッドレイアウトを持つ派生アプリは、保存済みの値が一度リセットされる。

### 修正

- **`items` デモを削除した派生アプリでバックアップをリストアできない問題を修正**。
  リストア検証の `REQUIRED_TABLES` を Banto 基盤所有の `settings` / `users` /
  `audit_log` に限定し、派生アプリが差し替え・削除するドメインテーブルを必須条件から
  除外した。ドメインテーブル無しの有効な Banto DB を受理する回帰テストを追加。

## [1.3.0] - 2026-08-20

**v1.3.0 — 保守レビュー 2026-08 の反映テーマ。** 新機能の追加は無く、
maintenance-review 2026-08 で洗い出した修正・対称性是正・テスト増強・
機械検査の追加が中心。**後方互換**（既存の公開 API は削除・改名とも無し、
依存追加ゼロ）のため minor リリース。以下は v1.2.0 以降のマージ分。

なお、クライアントから見えるステータスコードが2箇所変わる（不正な
フィルタ入力が 500 → 400、items import の大きなペイロードが 413 → 422）。
いずれも誤ったレスポンスの是正だが、ステータスコードで分岐している消費側は
確認すること。また `banto-core` の `BantoError` に `BadRequest`
バリアントが増えたため、この enum を網羅 `match` している消費側は
追随が必要（`ErrorBody` 経由で扱っている場合は影響なし）。

### 修正

- **Postgres で数値カラムへの `contains`/`starts_with` フィルタが 500 になるバグを修正**
  （maintenance-review PR-5 / H-3）。`list_query` の LIKE が `LOWER(<数値カラム>)` を
  生成し、Postgres の `lower()` は text 専用のため実行時エラー（500）になっていた
  （SQLite は動的型で暗黙変換するため既存テストが素通り）。`LOWER(CAST(col AS TEXT))`
  に変更（text カラムでは no-op、両バックエンド一致）。SQLite 回帰テスト + 実 Postgres の
  `postgres_tests`（LIKE/数値バインド/NULLS LAST、storage-postgres CI）を新設。
- **items import に明示 body limit を追加し 413 でなく 422 を返す**（maintenance-review
  PR-5 / M-14）。仕様上有効な最大行数のペイロードが axum 既定 2MB に先に当たり 413 で
  落ち得たのを、`items_write_router` に `DefaultBodyLimit::max(MAX_IMPORT_ROWS *
IMPORT_BODY_LIMIT_BYTES_PER_ROW)`（10MiB）を層付けして service 層の行数チェック
  （422）へ到達させる。境界テスト1本（修正を外すと 413 で落ちる回帰ガード）。

- **派生アプリの `pnpm dev` が `.svelte.ts` で 500 になる問題を修正**（issue #150 /
  [ADR-0007](docs/adr/0007-derived-app-dev-optimizer-exclude.md)）。`@banto/*` は
  ソース配布（`.svelte.ts` を生で出荷）のため、git 依存で node_modules 化した派生
  アプリでは Vite 8 dev の依存オプティマイザ（Rolldown）が preprocess せず
  `svelte.compileModule` に渡し `import type` 等で「Unexpected token」→ 500 になって
  いた（`pnpm build`/`check` は成功）。`apps/admin-template/vite.config.ts` の
  `optimizeDeps.exclude` に `.svelte.ts` を持つ5パッケージ（admin-core / dock-svelte /
  forms / grid-svelte / tree-svelte）を列挙して回避。テンプレート本体は workspace
  symlink 解決で元々 prebundle されないため no-op。列挙漏れの再発を
  `verify:architecture`（新 rule `optimizedeps-svelte-source`）で機械検査。
  publishing.md / conventions §14 に不変条件を明文化。

- **両経路の監査記録の非対称を是正**（maintenance-review PR-4 / H-4・M-15）。
  `audit-log/config` の denied 監査が REST=`resource:"audit_log"` /
  Tauri=`resource:"settings"` と食い違い、REST 内でも成功時（`settings`）と
  denied が不一致だった不変条件1違反を是正: REST の `audit_log_router` を
  list（`audit_log`）と config（`settings`）の2ガードに分割し、成功・denied・
  両経路すべてを `settings` に統一（`audit-log/list` は `audit_log` 維持）。
  両ガードの resource タグを `rest/tests.rs` でピン留め。backups restore の
  `entity_id` を canonical 化（対象ファイルの実名。upload は実体名が無いため
  `None`）。conventions §1 に監査 canonical 形状（resource / entity_id /
  denied detail 非対称 / 429 login 非記録）を明文化（ja/en）。
- **クライアント起因の不正入力を 500 でなく 400 で返す**（maintenance-review
  PR-4 / M-4）。`BantoError::BadRequest`（→ HTTP 400）を新設し、`list_query` の
  未知フィルタ列・不正なフィルタ値・`in` の非配列など5箇所を `Other`（500）から
  移行。`ErrorBody` に `bad_request` kind を追加し、フロント（`errors.ts` +
  全 `ERROR_KINDS`）とワイヤ形状パリティテスト（`error.rs`）を追随。サーバ
  エラー監視がクライアント起因の 500 で汚染されなくなる。

### 変更

- **`api_router` の10位置引数を `Services` 構造体へ集約**（maintenance-review M-13）。
  `api_router(items, users, …, auth, events, allow_setup)` を
  `api_router(services, auth, events, allow_setup)` に変更し、7つのサービスハンドル
  （items/users/settings/audit/backup/attachments/system_info）を `rest::Services`
  に束ねた。アプリ作者がサービスを足すコストが「位置引数を全呼び出し箇所へ波及」から
  「構造体フィールド1つ」に下がり、scaffold の attachments 除去も位置依存スロットから
  名前付きフィールドの除去になった。呼び出し箇所（`bin/banto-serve` / `src-tauri` の
  `start_embedded_server` / `rest::tests` の各ルータヘルパ）を追随。振る舞いの変更なし。
- **Tauri 側の監査記録に `record_ok` ヘルパーを導入**（maintenance-review M-1）。
  `src-tauri/lib.rs` の手書き `AuditEntry` 31箇所のうち、成功・アクター付き書き込み
  24箇所を REST の `record_write` に対応する `record_ok(&audit, &actor, action,
resource, entity_id, detail)` へ集約（`origin: "tauri"` / `result: "ok"` を固定）。
  両経路が各サイドのヘルパー経由になり、監査記録の形状ドリフト（conventions §1）を
  抑止。形状が異なる7箇所（import の ok/failed、login_failed、認証無効モードの
  エスケープハッチ書き込み、起動時 restore_applied、denied）は REST 同様に手書きのまま。
  振る舞いの変更なし（着手前提の両経路 detail 一致は maintenance-review §5.3 で実測済み）。

- **`record_write` の `entity_id` を `Option<&str>` に**（maintenance-review
  PR-4 / M-2）。entity_id を持たない mutating ハンドラ4箇所（audit config /
  backups restore-upload・cancel）が手書き `AuditEntry` を複製していたのを
  `record_write` ヘルパーに集約。

- **scaffold にツリーデモの remover を追加**（maintenance-review PR-3 / H-1）。
  v1.2.0 で追加された `@banto/tree-svelte` + `/tree` デモが scaffold 未登録で、
  minimal プリセットでもツリーデモが残っていた（#122 と同型のプリセット定義
  ドリフト）。README の手動4ステップを 1 対 1 で `removeTree()` 化し
  minimal / standard へ登録。`packages/` と scaffold の判断（remover / コア /
  除外）の同期を `scaffold.test.mjs` のトリップワイヤで機械検査化。
- **scaffold のアンカードリフト対策**（maintenance-review PR-3 / H-2）:
  (a) `verify-architecture.mjs` 対象ディレクトリ除去アンカーのカンマ欠落で
  dropBlock が無音スキップしていた実バグを修正。(b) `template-edit.mjs` に
  `--strict` モードを追加（pristine コピーでは「適用済み扱い」= アンカー不一致
  として失敗）し、template-acceptance の presets ジョブで有効化。
  (c) template-acceptance の paths トリガに scaffold のアンカー対象
  （アプリ側ファイル群）を追加 — アプリ側 PR でアンカーが壊れても週次まで
  潜伏せず毎 PR で検出される。

### テスト

- **Tauri の6コマンドを `_body` 分割し監査記録テストを追加**（maintenance-review PR-5 /
  M-5）。items_delete / auth_config_apply / autologin_enable / autologin_disable /
  attachments_upload / attachments_delete を `<cmd>_body(&AppState, …)` に切り出し（1行
  アダプタ）、各 body の監査エントリ（actor/action/resource/detail）を検証。attachments
  テストは scaffold で minimal/standard から除去（cutRegion 1本追加）。
- **pg_smoke に import の round-trip + rollback を追加**（maintenance-review PR-5 /
  M-12）。未実行だった `import_apply_postgres` の commit / rollback 両ブランチを実 Postgres で検証。
- **dock-svelte にドラッグ移動・フロート化のコンポーネントテストを追加**
  （maintenance-review PR-5 / M-8）。grid/tree の @testing-library/svelte + jsdom
  パターンを流用（devDeps + svelteTesting プラグイン追加）。

### 機械検査

- **機械検査を足すかの判断基準を [ADR-0008](docs/adr/0008-machine-check-stop-gate.md)
  に昇格し、rule を2本追加**（maintenance-review PR-7）。maintainability-review §4.1 が
  口伝で持っていた「打ち止め3条件」（背骨 / 静かに壊れる / AI が壊しうる を全て満たす）を
  ADR 化し、保守レビューの9案を選別（採用2・見送り2・却下5。全採否を ADR の台帳に記録）。
  採用分を `verify-architecture.mjs` に実装:
  - **rule 11 `migration-dialect-parity`**: `migrations-{sqlite,postgres}/` のファイル名/
    連番が1対1（片系統だけ足すと PG は smoke CI のみのため静かに欠落。中身の型差は §11 の
    意図的分岐でレビュー担保）。
  - **rule 12 `csp-two-definitions`**: `security_headers.rs` の const と `tauri.conf.json` の
    `app.security.csp` を connect-src の IPC 差分を除きディレクティブ単位で照合（cross-check
    テスト無し + src-tauri 非コンパイルのため片方だけ緩む退行を静かに見逃していた）。
    conventions §6/§11 に機械検査済みの旨を追記。両 rule とも意図的破壊で fail することを実測確認。

### ドキュメント

- **README の利用パッケージ別レシピ3節を `docs/recipes/` へ切り出し**
  （maintenance-review PR-6）。scan-wedge / 通知（トースト）/ tree-svelte の各節
  （計約240行）を `docs/recipes/{scan-wedge,notifications,tree-svelte}.md` へ移し、
  README には紹介 + リンクのスタブを残した（README は「コピー→リネーム→差し替え→
  削除→配信」の背骨に集中。節アンカーへの被参照ゼロを実測して切り出し）。
  欠落していた `packages/tree-svelte/README.md` を新設（他9パッケージと同形式）。
- **`docs/recipes/add-role.md`（ja/en）を新設**（feature-review-2026-08 §2.6 の宿題）。
  RBAC ロール追加のチェックリスト（Role enum → DB CHECK → 両経路の認可床 → rule 8 →
  フロント選択 UI/i18n → 対称テスト）。add-resource.md の姉妹編。AGENTS（ja/en）の
  「タスク別の入り口」に add-role とレシピ群を索引追加。
- **ui-framework-spec の §14/§15 に決着を追記**（maintenance-review PR-6）。§14 の
  解決済み未決2件（ドッキング初期スコープ→M7/M8 段階リリース、REST エラー
  フォーマット→ErrorBody + response.rs のステータス写像。バージョニングは未導入と明記）
  に [x] と決着先を記入。§15 に M0〜M9 完了印と「M10 以降は roadmap」の誘導。
  ヘッダを v0.7 → v0.8。

- 保守レビュー 2026-08（ドキュメント整理統合の実測プラン + 保守性再点検）を
  [docs/maintenance-review-2026-08.md](docs/maintenance-review-2026-08.md) に追加（#148）。
- 消失文書への参照46箇所を実在参照へ修復（#149、maintenance-review PR-1）:
  i18n-plan 参照を conventions §13 / ADR-0005 へ、CR-6/CR-7/AD 系の定義を
  maintainability-review §7 追補へ、spec §6.4「チャートデザインルール」新設、
  `spec §3.7/3.8` → `attachments-plan §3.7/3.8` 正規化、conventions §12 に
  参照文法表。Cargo.lock の v1.2.0 追随も同 PR。
- 追随更新とアーカイブ（maintenance-review PR-2）: review-2026-07-29 /
  improvements / improvement-plan-2026-07 を `docs/history/` へ凍結移動し、
  現役バックログを roadmap §3 に一本化。publishing.md の決着済み経緯を
  `docs/history/publishing-github-packages-2026-07.md` へ切り出し。
  visual-refresh plan/design・scaffold-presets-plan の状態ヘッダを実装済みに
  更新（§7 未決事項の決定結果を追記）。AGENTS.md の CI 記述・オプション一覧・
  不変条件要約（§13）を実態化しレビュー記録の索引を新設。conventions
  §1/§3/§4/§6/§9 のピンポイント追随（CR-6 後の rule 8・CSP 2定義同期・app 層
  生値の例外規約ほか、en 同時）。README の壊れた箇条書き修復 + システム情報
  カード追記、README.en にライブデモ URL と要約宣言。CHANGELOG v1.2.0 節に
  PR 番号を対応付け、版比較リンクを新設。

## [1.2.0] - 2026-08-12

**v1.2.0 — UI / デモ拡充テーマ。** ツリービュー（新規オプションパッケージ
`@banto/tree-svelte` + 削除可能なデモ配線）、システム情報カード + バージョン表示、
PWA（installable-only）、通知 `warning` 種別 + サーバ発通知（`Notice`）レシピ、
積立棒グラフのデモを追加。**いずれも後方互換（追加的で破壊的変更なし。既存の
公開 API・両経路の挙動は不変、依存追加ゼロ）** のため minor リリース。以下は
v1.1.0 以降のマージ分。

### Added

- **積立棒グラフのデモを追加**（#145、`@banto/charts` の `BarChart` stacked）。ダッシュボードに
  「カテゴリ別在庫（価格帯積立）」パネルを追加し、上位カテゴリの在庫を価格帯(低/中/高)で
  積み上げる（集計は `dashboard.ts` の `stockByCategoryPriceBand`、純関数・壁時計非依存）。
  これで README が挙げる全14チャート種が Pages ライブデモで実際に描画される（従来は積立が
  `StackedAreaChart` のみで、棒の stacked バリアントだけデモ未掲載だった）。
- **ツリービュー `@banto/tree-svelte`**（#143 パッケージ + #144 デモ配線。新規オプションパッケージ、利用者要望）。
  依存ゼロのヘッドレスコア（`core/` の純関数: 可視行フラット化・move/reparent・
  三状態チェック計算・リネーム patch、全て単体テスト済み）+ 薄い Svelte 5 (Runes)
  UI。`BantoTree` は展開/折りたたみ・単一/複数選択・三状態チェックボックス・
  遅延読み込み・ドラッグ並べ替え/親子変更・インライン名前変更に対応し、`columns`
  で階層データグリッド（tree-grid）化。`TreeSelect` はポップオーバー型の選択入力
  （`popover="auto"` でトップレイヤ + light-dismiss）。**依存追加ゼロ・パッケージ間
  import なし**（`@banto/grid-svelte`/`forms` の型は構造ミラーで非 import）。
  テンプレート本体には**削除可能なデモ配線**付き（サイドバー「ツリービュー」=
  `/tree` デモページ。ライブデモでも到達可。サンプルデータ `treeSample.ts`・
  `treeMessages()` ブリッジ・`nav.tree`/`tree.*` 文言を含む）。ナビ追加に伴い
  サイドバーが写る認証ページのビジュアル回帰ベースラインを再生成
  （`.github/workflows/visual-baselines.yml`）。テスト 37 件（コア/状態/コンポーネント）。
- **システム情報カード + バージョン表示**（#140、M-review 2026-08 §2.4「縮小版⑤」）。
  設定画面に admin 専用の「システム情報」カードを追加し、稼働中バージョン・
  マイグレーション版・DB 方言/レイテンシ・稼働時間・アクティブ LAN セッション数・
  添付ファイル容量を表示する。バックエンドは新サービス
  `banto_admin_services::system_info::SystemInfoService`（DB 専用・transport 非依存、
  best-effort 項目は None に劣化）と、両経路対称な `GET /api/system/info`（admin、
  読み取りのため非監査）+ Tauri `system_info` コマンド。`AuthState::session_count()`
  を追加。**依存追加ゼロ**（`std::time::Instant` でレイテンシ/稼働時間、既存 sqlx で
  クエリ）。従来 UI のどこにも出ていなかったバージョンをこのカードで可視化。
  なお CI の rust ジョブ（check/clippy/test）に欠落していた `-p banto-admin-services`
  を追加した（theme C でのクレート追加時からの漏れ）。
- **PWA（installable-only）**（#141、M-review 2026-08 §2.8）。LAN ブラウザ配信に
  Web マニフェスト（`static/manifest.webmanifest`）+ アイコン（192/512/512-maskable、
  提灯モチーフ）を同梱し、「ホーム画面に追加」/インストールでアプリのように起動可能に。
  `app.html` に manifest link・apple-touch-icon・theme-color・apple-mobile-web-app
  メタを追加。埋め込み LAN サーバが `.webmanifest` を正しく配信するよう
  `banto-server` の `guess_mime` に `application/manifest+json` arm を追加。
  Service Worker（オフライン）は非対応。**依存追加ゼロ**（アイコンはコミット済み静的
  アセット）。ブラウザはセキュアコンテキストでのみインストールを提供するため、標準の
  平文 HTTP LAN では機能せず HTTPS/localhost/TLS リバースプロキシ配下が前提
  （ADR-0003）。`rename.mjs` が manifest の name/short_name も追随。
- **通知に `warning` 種別を追加 + サーバ発通知（`ServerEvent::Notice`）のレシピ化**
  （#142、M-review 2026-08 §2.5 の「無料部分」）。`@banto/admin-core` の `NotificationKind`
  を `success`/`error`/`info` に **`warning`** を加えた4種に拡張（後方互換な union
  拡張。`events.ts` の `notice` レベル照合と `ToastHost` の `.toast.warning`
  スタイル（warning トークン）を追加）。既に配線済みだが未使用だった
  `ServerEvent::Notice { level, message }` の**発火例**を `banto-server` の doc
  コメント（doctest）+ SSE 配信テストで示し、README に「通知（トースト）」レシピ節
  （自タブ `notify('warning', …)` / 全クライアント一斉 `ServerEvent::Notice`
  ブロードキャスト）を追加。永続通知センターは引き続き非スコープ（§2.5）。**依存追加ゼロ**。

### ドキュメント

- 外部AIレビュー（ChatGPT）の機能スコープ提案を実測で検証・取捨した棚卸しを
  [docs/feature-review-2026-08.md](docs/feature-review-2026-08.md) に追加（#139）。
  roadmap §3 v2 バックログに **API Token / Service Account**（既存ロール紐付け設計）
  を追加し、updater / バックアップアーカイブへ設計上の但し書き参照を付した
  （実装は伴わない実需ドリブンのバックログ整理）。

## [1.1.0] - 2026-07-30

**v1.1.0 — V2 拡張テーマ（PostgreSQL アプリ全体対応 / i18n レイヤ② / コピー面積
縮小）を完了。** [roadmap.md](docs/roadmap.md) §3 の v2 バックログ3テーマを実装。
いずれも**後方互換**（既定は SQLite・表示ロケールは日本語のまま挙動 byte 等価、
移設したサービスは再エクスポートで旧パス保持）のため minor リリース。以下は
v1.0.0 以降のマージ分。

### Added

- **テーマA: PostgreSQL アプリ全体対応**（#106–#109）。サービス層を
  `sqlx::SqlitePool` から `banto_storage::Db`（enum ディスパッチ）へ抽象化し、
  `Dialect` で SQL 方言差（プレースホルダ・日付関数）を吸収。マイグレーションを
  `migrations-sqlite/` + `migrations-postgres/` に方言分割し、`db::init_db_from_target`
  が `BANTO_DB=postgres://…` で PostgreSQL 経路を選択（既定は SQLite で無改変）。
  CI に実 `postgres:16` で app 層 CRUD を検証する `app-postgres` スモークを追加。
  backup/restore は SQLite 専用として維持（Postgres ハンドルは明示エラー）。
- **テーマB: i18n レイヤ②**（#110–#113, #75, [ADR-0005](docs/adr/0005-i18n-paraglide.md)）。
  UI 多言語化ランタイムに **Paraglide JS (inlang)** を採用（ADR-0002 の意図的例外）。
  app 層の可視文言を全キー化（`messages/{en,ja}.json`・英語一次）、設定画面に
  言語切替 UI、ロケール解決/永続化を `locale.ts`（既存 provider 層に相乗り）。
  既定表示は日本語で視覚回帰ゼロ。conventions §13 +「app 層に生の日本語リテラルなし」
  の機械検査 `raw-jp-in-app` を追加。visual ベースライン手動再生成ワークフロー
  `visual-baselines.yml` を追加。
- M24 デモ配線（#74）: `@banto/charts` の積立エリア/ガントをダッシュボードデモに追加。
- 保守者向け中核ドキュメントの英語版（#119）: `conventions.en.md` / `AGENTS.en.md` /
  `recipes/add-resource.en.md` / ADR 各 `.en.md`（日本語一次・英語追随）。

### Changed

- **テーマC: コピー面積縮小**（#114–#117）。テンプレート採用者がコピー保守する
  汎用サービス層を新クレート **`banto-admin-services`**（settings/audit/rbac/users/backup）
  へ、汎用 REST ルータ（auth/users/audit/backups/ui_settings）を **`banto-server::routes`**
  へ移設（約4,700行）。`admin-template-core` は再エクスポートで旧パスを保持し
  REST/Tauri wiring は無改修、両経路対称（rule 8）は移設前と数値一致。依存方向
  `admin-template-core → banto-server → banto-admin-services → banto-storage → banto-core`。
  `items.rs`（デモ固有）は据え置き。
- ドキュメント整合（#118）: V2 リファクタ後の canonical ドキュメント/コード doc
  コメントを実装に合わせて更新（マイグレーションパス・DB 対応状況・クレート一覧・
  移設サービスの所在・`SqlitePool`→`Db`）。
- 依存更新（Dependabot・#47/#50/#55/#57/#59/#96/#97/#105）: vite / vite-plugin-svelte /
  sha2 / npm・cargo minor-patch グループ / GitHub Actions 各種。

### Fixed

リリース前のテンプレート実用性レビュー（`docs/review-2026-07-29.md`）で発見した所見に対応。

- **[出荷ブロッカー] i18n ビルドの CDN 依存 + fail-open**（#121）。inlang/Paraglide の
  コンパイル時プラグインが `project.inlang/settings.json` で jsdelivr CDN URL 参照になっており
  （lockfile 外・毎ビルド取得）、取得失敗時に空カタログを exit 0 で出力（fail-open）→ 実行時に
  画面が落ちる問題を修正。プラグインを devDependency（コンパイル時のみ・実行時依存ゼロ）として
  ローカル化、`scripts/check-i18n-nonempty.mjs` で「メッセージ0件なら異常終了」する fail-closed
  ガードを追加、CI に CDN 遮断ビルドの `i18n-offline` ジョブを追加。閉域網/社内プロキシ（README の
  ターゲット）でのビルド再現性を確保。
- **Tauri コマンドのテストがどの CI でも実行されていなかった**（#122）。`tauri-check.yml` に
  `cargo test -p admin-template` を追加（`cargo check` だけで実行されていなかった 8 テストが
  走るように。両経路対称の認可/監査の実行検証が復活）。
- **`scaffold.mjs` のプリセット除去パターンのドリフト**（#122）。#74（M24 デモ配線）と i18n
  キー化で `removeCharts`/`removeGlass`/report ボタン除去のアンカーが陳腐化し、`--preset
minimal`/`standard` が失敗していたのを現行コードに追随させて修正（3プリセットで
  scaffold→check 緑）。`template-acceptance` がフロントのみの変更で起動しないため潜在していた。
- scaffold をユーザー導線に露出（#122）: `pnpm scaffold` スクリプト + README（日英）/AGENTS
  （日英）に導線。e2e の `afterAll` を `page?.close()` 化、README にセッション再起動消失の注記。

## [1.0.0] - 2026-07-28

**v1.0.0 — 安定版リリース。** 仕様 M0〜M9 + ロードマップ M10〜M24 までの
汎用管理画面テンプレートとしての機能が出そろい、v1 スコープを完了。以降の
拡張テーマ（PostgreSQL アプリ全体対応 / i18n レイヤ②③ / コピー面積縮小）は
[roadmap.md](docs/roadmap.md) §3「v2 / 将来構想バックログ」に集約。0.1.2 からの
差分は破壊的変更なし（安定版としての昇格）。以下は 0.1.2 以降のマージ分。

- feat (P4-5): `banto-storage` に PostgreSQL 接続ヘルパ `postgres.rs`（`connect`、
  接続プール、feature `postgres`）を追加。`list_query` の Postgres 対応（既存）
  と合わせて storage クレートが Postgres 接続可能に（接続のみ）。アプリ層
  （`apps/admin-template/core`）は仕様どおり SQLite 専任のまま（§12.1/§548）。
  CI に `postgres:16` サービスコンテナで実接続する `storage-postgres` ジョブを追加
- feat (P4-9): プリセット・スキャフォールダ `scripts/scaffold.mjs`
  （`--preset minimal|standard|full`）を追加。コピー直後にプリセットで不要な
  オプション資産（charts / dock / Glass+vibrancy / コマンドパレット / 添付 /
  帳票）を README「オプション資産の削除」手順どおりに削除する（ship-full /
  remove-only、コアは非対象）。rename.mjs のファイル編集エンジンを
  `scripts/lib/template-edit.mjs` に共有抽出。`template-acceptance.yml` に
  3プリセット × ビルド緑（scaffold → install → check/build/cargo check /
  verify:architecture）の受け入れマトリクスを追加（依存追加なし）
- fix (P4-9, follow-up #94): `scaffold.mjs` の attachments 除去を
  `apps/admin-template/core/src/rest/tests.rs` にも適用し、全プリセットで
  `cargo test` が緑になるよう修正（従来は minimal/standard で削除済みクレート
  参照によりテストがコンパイル不能だった）。`template-edit.mjs` に章末ブロックを
  EOF ごと消す冪等ヘルパ `cutToEnd` を追加。`template-acceptance.yml` の
  presets マトリクスを `cargo check` → `cargo test` に強化
- feat (scaffold-presets-plan §7.3): `scripts/scaffold.mjs` に `--interactive`
  （`-i`）を追加。プリセット（minimal/standard/full）または資産ごとの
  残す/削除を対話で選ばせた上で、`--preset` と全く同じ削除ロジック・確認表示
  を実行する（`--preset` の非対話動作はバイト単位で不変）。依存追加なし
  （`node:readline/promises` のみ、conventions §3）。pipe された非 TTY stdin
  でも `question()` の既知の取りこぼしを避けるため async イテレータで
  1行ずつ読む方式を採用し、軽量テスト `scripts/scaffold.test.mjs` から
  駆動できるようにした
- feat (#89, AD-2): **GitHub Pages ライブデモを公開**（<https://tyaro.github.io/banto/>、
  InMemory デモ・admin/admin）。アプリを **base-path 対応**にし（`$app/paths` の
  `base` を全内部遷移へ付与。`BASE_PATH` 既定 `''` で Tauri/LAN ビルドは完全不変）、
  `deploy-demo.yml` ワークフロー（`BASE_PATH=/banto` ビルド → deploy-pages）を追加。
  README 冒頭にライブデモリンクを追加
- docs (#90, AD-3): OG ソーシャルプレビュー画像 `docs/assets/og-image.png` を追加
- ci (#91): `deploy-demo.yml` の Pages アクションを Node 24 版へ bump（Node 20 deprecation 解消）
- ci (#92): 全ワークフローの `checkout` / `setup-node` を Node 24（v7）へ bump（Node 20 警告解消）
- ci (#99): `pnpm/action-setup` を v6 へ bump（最後の Node 20 警告を解消）
- docs (#101): `ui-framework-spec.md` §5.3 ウィンドウ分離を「実装済み」に追随更新
  （`panel_open` の real `WebviewWindow` + `popout.ts`、`isTauri()` ガードで両経路対称）
- docs (#102, P4-6): `improvements.md` の履歴分離を完了。解決済み4項目（P3-3/P4-1/
  P4-2/P4-3）を `docs/history/improvements-archive.md` へ移設しスタブ化
- docs (#103): `roadmap.md` §3「v2 / 将来構想バックログ」を新設し大物残項目
  （PostgreSQL 全体対応 / i18n ②③ / コピー面積縮小）を隔離。**v1（M0〜M24）スコープ完了**を宣言

## [0.1.2] - 2026-07-23

- fix (#77, CR-6): `audit_config_get` の両経路ロールを Admin に統一（Tauri が
  Viewer・REST が Admin という看板不変条件「両経路対称」の実バグを修正）。
  `verify:architecture` rule 8 に**ロール床照合**（`require_role`/`RoleGuard` の
  期待ロールを DUAL_PATH/ROLE_READ 宣言と静的照合）を追加
- docs/tooling (#78, CR-7): ドキュメントと実装の整合を是正（チャート14種・
  scan-wedge 記述・`pnpm check` 説明、scan-wedge を tsc 化）+ **バージョン整合検査**
  `check:versions`（全マニフェスト version の相互一致 / タグモードでタグ名照合）を追加
- ci (#79, AD-5): テンプレート受け入れ CI（copy→rename→check）+ `rename.mjs` の
  統合テスト（Node 標準 `node:test`）を追加
- i18n (#81, AD-6 レイヤ①): `@banto/*` 全パッケージの可視文言を**注入対応化**。
  現行日本語をデフォルトに残した `messages` props / メッセージ引数で上書き可能にし
  （`forms/validate.ts` の既存パターンを横展開）、辞書・`t()`・依存追加なし・
  byte-identical・後方互換。②仕組み・③辞書・docs 英語化は実需ドリブンで保留
- docs (#82, AD-4): template-scope §7 コピー面積縮小の着手トリガに「外部採用者
  フィードバック」を追加
- fix (#83, PR-C): Tauri デスクトップ Webview に **CSP を設定**（`app.security.csp` を
  null → LAN 側 `security_headers.rs` と対称。差分は `connect-src` の Tauri IPC のみ）。
  実機 Windows のビルド + スモークで確認。app.html インラインスクリプトは SvelteKit
  ブートストラップのビルド毎ハッシュ変動のため `'unsafe-inline'` を踏襲（LAN と同じ）
- fix (#84): デスクトップの CSV エクスポートを `exports/` フォルダ書き出し +
  フォルダを開く方式に（WebView2 が保存ダイアログを出さない問題。backup と同じ
  流儀・依存追加なし。Tauri コマンド `items_export_csv_to_folder`、`DESKTOP_ONLY` 分類）
- docs (#85, AD-1/AD-2): README に「対象読者 / 非対象」ポジショニング宣言と
  スクリーンショット3枚（`docs/assets/`）を追加（採用者向け導線）
- chore (#86, CR-7): 全マニフェストの version を **0.1.1 に整合**（既存 v0.1.1 タグ /
  CHANGELOG [0.1.1] とのドリフトを解消）

- M24: `@banto/charts` に **積立エリア（`StackedAreaChart`）** と
  **ガントチャート（`GanttChart`）** を追加（全14種）。積立棒は従来どおり
  `BarChart` の `stacked`。積立エリアは既存 `core/stack.ts` を再利用し、境界間
  バンドの新規純関数 `bandAreaPath` で塗る（`LineChart` のズーム/第2Y軸と
  衝突するため専用コンポーネント）。ガントは純関数 `core/gantt.ts`
  （`toMs`/`ganttDomain`/`ganttLayout`）+ 時間軸バー・進捗・「今日」マーカー
  （依存線は非スコープ）。日付は `formatDate` 委譲で日付ライブラリ非同梱
  （依存を足さない）。ユニットテスト14件追加、生色値なし。ダッシュボードデモ
  への配線は visual baseline 再生成が要るため別 PR（roadmap M24）

- docs: 保守性コードレビューの不変条件機械検査化を **CR-1 / CR-2 で打ち止め**と
  決定し、理由を maintainability-review-2026-07.md §4.1 に記録。機械検査の3条件
  （背骨 / 静かに壊れる / AI が無自覚に壊す）に照らし、CR-4 は不採用、CR-5 は
  機会的、CR-3 は実需ドリブンで見送り。ガードレール自体が保守負担・偽の安心感に
  なる手前で止める判断

- ci: `verify:architecture` に rule 9「§6 セキュリティ不変条件」を追加（CR-2）。
  §6 のうち静的テキストで低誤検知に検査できる2件を機械化: (A) `NewAttachment` に
  `mime` フィールドが無い（クライアント申告 MIME を受け取らず、判定は
  `detect_mime` のマジックバイトのみ）、(B) `settings_get`/`settings_set` が同一
  Admin ゲート（「同一ストアでも権限の非対称を作らない」）。順序依存・
  セマンティックな項目（body limit の順序・監査 detail に秘密を入れない等）は
  レビュー/テスト担保のまま。conventions §6 の該当2箇所を [機械検査済み] に更新

- ci: `verify:architecture` に rule 8「REST/Tauri 両経路対称」を追加（CR-1、
  conventions §1）。このテンプレートの背骨の不変条件でありながら従来は機械検査が
  無く、AI が mutating 操作を片方の経路にだけ足しても落ちる検査が無かった
  （`src-tauri` は非コンパイル環境で実行検証も不可）。`DUAL_PATH` マニフェスト
  （20対、所有者確認済み分類）+ 完全性チェックで、未分類の Tauri コマンド /
  REST ルート追加を CI で捕捉する。アンカーは Tauri コマンド定義と
  `rest/mod.rs` の Route table（実 `.route()` 宣言との doc-sync 併設）。依存追加
  なし。conventions §1 を [機械検査済み] に更新

- docs: 保守性コードレビュー（Rustサービス+サーバ層、AI中心保守が前提）の所見と
  不変条件の機械検査化ロードマップ（CR-1〜CR-5）を
  [maintainability-review-2026-07.md](docs/maintainability-review-2026-07.md) に
  記録。人間の保守性とAI保守性の分岐点を整理し、conventions.md のうち機械検査に
  落ちていない不変条件（特に §1 両経路対称）を優先的に検査化する方針。
  improvement-plan-2026-07.md から参照

- ci/docs: `verify:architecture` に「ドキュメント整合性」ルール（rule 7）を追加。
  `docs/`・README・AGENTS・CLAUDE 内の `@banto/*` 参照が実在パッケージのみで
  あることを機械検査し、実在しない `@banto/grid-core` 等の掲載（今回修正した
  ドリフト）を CI で防ぐ。実在パッケージ名は `packages/*/package.json` から
  動的取得するため追加/改名に自動追従。依存追加なし（Node 標準のみ）

- docs: ドキュメントと実装の不整合を修正。(1) ui-framework-spec §2.1 の対象
  パッケージ表から実在しない `@banto/grid-core`/`@banto/dock-core` を除去し、
  ヘッドレスロジックは各 `-svelte` パッケージ内 `src/core/` に内包（§14 決着）と
  明記。(2) 同表の `banto-storage` の PostgreSQL 記述を実装状況（v1 は SQLite
  のみ、postgres は feature 定義止まり — §12.1 注記）に整合。(3) v1後追加の
  オプション拡張パッケージ（report/attachments/scan-wedge、M19〜21）への参照を
  追記。(4) AGENTS.md/CLAUDE.md の E2E 検証コマンドを実在しない
  `pnpm -C apps/admin-template test:e2e` から実際の `pnpm e2e` に修正。
  (5) template-scope のクレート化計画表に、`rest.rs` が P3-1 で `rest/` へ
  分割済みである旨を反映

- P4-9: スキャフォールド・プリセット（`minimal`/`standard`/`full`）の**設計を
  確定**（[docs/scaffold-presets-plan.md](docs/scaffold-presets-plan.md)、設計のみ・
  実装は P2-1 v2 の後）。プリセットは §3 オプション資産の削除手順の自動実行で
  あり、コア（auth/audit/settings/backup/CSV/shell）や runtime 機構には触れない。
  ChatGPT レビュー当初案の "industrial"（別リポジトリ `banto-industrial` と混同）を
  避け命名を是正。remover 関数群 + rename.mjs のエンジン再利用・依存追加なしで
  構成し、各プリセットのビルド緑を受け入れ条件にする方針を明記

- docs: v2 検討事項の決着とドキュメント棚卸し。TLS 本体（組み込み rustls）と
  サーバログ（`tracing`）は、いずれも conventions §3 が退けた依存追加のため
  実装ではなく ADR で決定を記録（[ADR-0003](docs/adr/0003-tls-via-reverse-proxy.md)
  リバースプロキシ終端を正式・組み込み TLS は保留、
  [ADR-0004](docs/adr/0004-server-logging-eprintln.md) `eprintln!` 継続・
  `tracing` は保留）。あわせて improvements.md の「まとめ」から完了済み項目
  （Dependabot/コンポーネントテスト）を除去、改行正規化を実質完了（CRLF 0件）と
  確認、spec §6.1/§6.3 の陳腐化した「v2以降」注記（複合/レーダー/ヒートマップ/
  ゲージ・SVGエクスポート＝M13/M22 で実装済み）を訂正

- P4-2: 仮想スクロールの計測ベンチを追加（`@banto/grid-svelte`、
  `pnpm bench`）。per-frame 処理（`computeWindow` + 可視ウィンドウ slice）が
  総行数に依存しないこと（10k/100k でほぼ同一）を実証し、sort/filter の
  総行数依存コストも計測。vitest bench でホットパスを計測する方式（ブラウザ
  FPS ではなく決定的・CI 非ゲート・依存追加なし）。代表結果はベンチ冒頭に常設

- P4-3: README LAN 節に「同時書き込みとSQLite（WAL）」節を追加。
  デスクトップ + 組み込みサーバは同一プロセス・単一プール共有で書き込みが
  シリアライズされ、DB は WAL モードで開くこと（別プロセスからの同時
  アクセスは避けるべき点も）を明記

- P4-7: ADR（Architecture Decision Record）を `docs/adr/` に導入。README
  （ドキュメント3分類の役割分担: コードコメント / conventions.md / ADR）+
  テンプレート + 最初の ADR 2件（0001 REST/Tauri 二経路対称、0002 依存
  最小化）。ADR は「退けた代替案とその理由」に絞り、conventions.md 冒頭
  から参照。既存判断のバックフィルは一括せず次に触れる時に1件ずつ起こす

- P4-1: `FilterPopover` の dismiss 挙動テストを追加（`@banto/grid-svelte`、
  9件）。実装精査の結果 Tab 巡回型フォーカストラップではなく「Escape /
  外側 pointerdown で閉じる」dismiss 型と判明したため、その実挙動
  （dialog 意味論・apply/clear/Enter 含む）を固定。improvements.md §8 の
  記述も実態に訂正

- fix(backup): `BackupService::create` の `created_at` を、生成した
  ファイルの mtime（`list()` と同一の取得源）から算出するよう修正。
  従来は `datetime('now')` 由来で、`VACUUM INTO` が秒境界をまたぐと
  create と list で最大1秒ずれる不整合があり、Windows で決定論的に
  `create_then_list_then_read_round_trips` を落としていた（P3-3 の CI で
  顕在化）
- P3-3: Svelte コンポーネントテストを導入（`@banto/forms` の `BantoForm`・
  `@banto/grid-svelte` の `BantoGrid` にマウント+基本操作テストを各5件）。
  `@testing-library/svelte` + `jsdom` を両パッケージの devDependencies に
  追加し、component テストのみ `// @vitest-environment jsdom` で opt-in
  （純ロジックテストの環境は不変、dependencies/peerDependencies は空を維持）
- P3-6/P4-4: CI の全サードパーティ Action をコミット SHA に固定し
  （checkout/pnpm-action-setup/setup-node/rust-cache/upload-artifact/
  install-action/github-script の7種。`dtolnay/rust-toolchain@stable` は
  ref がツールチェーン選択を兼ねる仕様のため意図的に非固定）、Dependabot
  （`.github/dependabot.yml`、github-actions/npm/cargo をグループ化週次）を
  導入して追従を自動化
- P4-6: `docs/improvements.md` を「未解決課題の調査記録」に絞り、対応済み
  項目の実装記録を `docs/history/improvements-archive.md` へ分離
  （各項目にスタブ + アーカイブリンクを残し追跡可能に）
- P3-5: アーキテクチャ規約の機械検査 `pnpm verify:architecture` を新設し
  CI の frontend ジョブで強制（サービス層の tauri/axum 非依存・パッケージ間
  import ゼロ・`$lib` import 禁止・`{@html}`/生色値の理由付き許可リスト・
  依存空の6ルール。conventions.md に [機械検査済み] 注記）。charts の
  ズームリセットボタンの生 box-shadow をトークン化
- P2-2: 英語版 README（`README.en.md`、1ページ要約）を追加
- P2-3: 全9パッケージに README を追加（役割・最小コード例・依存ゼロ方針・
  git サブディレクトリ依存での消費方法）
- P2-1: テンプレート初期化スクリプト `scripts/rename.mjs` を新設
  （`--name`/`--title`/`--identifier`/`--repo` で package.json×2・
  `--filter` 参照・tauri.conf.json・ブランド表示・E2E アサーション・
  リポジトリ URL を一括書き換え。Node 標準ライブラリのみ・`--dry-run`
  対応・再実行安全。README「コピーとリネーム」をスクリプト前提に改訂）
- M23: スキーマ→グリッド列の自動導出 `columnsFromSchema` を
  `@banto/grid-svelte` に追加（フォームと同一ルール・同一メッセージの
  バリデータ込み。items 一覧を導出ベースへ書き換え、仕様 §3.1 の
  「スキーマを1つ書けば一覧と編集フォームが両方生える」を実装）
- refactor: `rest.rs`（4,069行）をリソース別モジュールへ分割
  （`rest/mod.rs` = ルート表 doc + 共有ガード + `api_router`、
  `rest/{items,users,auth,ui_settings,audit,backups,attachments}.rs`、
  テストは `rest/tests.rs`。公開 API（`api_router` /
  `audited_credential_verifier`）のパスは不変。improvement-plan P3-1）
- refactor: `setup.ts` を分割し、リソース定義を `resources/items.ts` +
  `resources/index.ts` へ、環境判定を `environment.ts` へ、デモ認証を
  `providers/demo.ts` へ分離（既存の公開エクスポートは `setup.ts` から
  re-export され後方互換。improvement-plan P3-4）
- ci: Tauri compile check ワークフロー `tauri-check.yml` を新設
  （`cargo check -p admin-template` を ubuntu/windows で、Tauri側を触る
  PR/main push + 週次スケジュールで実行。週次失敗時は Issue 自動起票。
  improvement-plan P3-2）
- docs: 改善計画フェーズ1（README 5分クイックスタート・SQLite期待値明記・
  リソース追加レシピ `docs/recipes/add-resource.md` 新設・LAN HTTP警告 +
  Caddy TLS終端例・依存判断基準・AGENTS.md Definition of Done・roadmap
  M23候補登録）
- fix(e2e): vite preview を 127.0.0.1 に明示バインドし、CIのE2Eジョブが
  恒常失敗していた webServer タイムアウトを解消（webServer stdout の
  パイプ化も恒久化）(#37)
- docs: AIレビュー統合の改善計画 `docs/improvement-plan-2026-07.md` を
  新設し、E2E障害の事後記録を improvements.md §4.1 に追記 (#36, #38)
- M18: 基盤整備の残ギャップ解消（M18 完了。CIのRustジョブへ
  `banto-attachments` 追加、E2E visual regression + axe-coreジョブ追加、
  全9パッケージの `publish --dry-run` 確認、template-scope.md §6の
  チェック消込）(#32)
- M19: 帳票/印刷 `@banto/report`（MDテンプレート + データバインド +
  印刷CSS + items日報デモ）(#31)
- M21: バーコード/QR wedge入力検出 `@banto/scan-wedge`（キーボード
  ウェッジ検出ヘッドレスコア + Svelteアクション、テンプレート本体には
  未配線・レシピのみ）(#30)
- M20: 添付ファイル/画像管理 `banto-attachments` + `@banto/attachments`
  （アップロード/サムネイル/一覧 + REST/Tauri/監査ログ配線 + items
  デモ配線）(#29)
- docs: M19〜M21の提供形態を「パッケージ + 削除可能デモ + レシピ」方式に
  決定 (#28)
- a11y: dock-svelte/grid-svelteの既知アクセシビリティ2件を改修し、
  axe-coreスキャンの除外リストを撤去（8スキャン全通過）(#27)
- M22: ビジュアルリフレッシュ検証基盤（Playwright visual regression +
  axe-core、Phase 0）を追加しM22をroadmapに登録 (#26)
- M22: ビジュアルリフレッシュ実装（実装単位1〜6。Modern Operations
  Console化 — トークン拡張・密度軸・共通UI・アイコン統一・シェル刷新・
  View Transitions）(#25)
- docs: メニュー一式を計画へ追記し、実装レベルの設計書
  （visual-refresh-design.md）を新規作成 (#24)
- docs: visual-refresh-plan をレビュー反映で改訂 (#23)

## [0.1.1] - 2026-07-12

- chore: リポジトリ公開化に向けて全パッケージのライセンス表記をMITに
  統一（`packages/*/package.json` の `license` を `UNLICENSED` から
  `MIT` へ戻し、パッケージ個別の `LICENSE` ファイルを削除）(#22)
- docs: パッケージ配布方式をgitサブディレクトリ依存に確定（`@banto`
  スコープがGitHub Packagesで使えないと判明したため、GitHub Packages案は
  棚上げ）(#21)

## [0.1.0] - 2026-07-12

最初のタグ付きリリース。M0〜M18の累積。

**M0〜M9**（[ui-framework-spec.md](docs/ui-framework-spec.md) §15。
バージョンタグ導入前のためPR番号なし、1行要約）:

- M0: モノレポ + テンプレートアプリの骨格（SvelteKit + Tauri v2 +
  シェルレイアウト + ルーティング + テーマ切替/設定画面）
- M1: グリッドコア（クライアントモード、仮想スクロール、ソート/フィルタ、
  列リサイズ/並び替え）
- M2: `admin-core`（リソース定義・`DataProvider`/`AuthProvider`・
  コンポーザブル）+ スキーマ駆動フォーム + CRUDページ雛形（グリッド+
  フォーム+Rustサービス層+sqlxリポジトリ貫通）+ 認証/ログイン雛形
- M3: グリッド セル編集・範囲選択・コピー&ペースト
- M4: チャートv1（折れ線/棒/円/散布図/スパークライン）+
  ダッシュボードページ
- M5: グリッド サーバーモード（`getList`経由のTauri連携）、グルーピング
- M6: 組み込みWebサーバ（サービス層のREST公開、静的配信、
  `HttpDataProvider`、認証のREST対応+CSRF、`SettingsProvider`抽象、
  SSEイベント配信、設定画面トグル+URL/QR表示）
- M7: ドッキングレイアウト（フローティングウィンドウのみ）
- M8: ドッキング（分割・タブ化・スナップ）+ ダッシュボードへの統合
- M9: テーマ層の整理、MITライセンス、npm公開準備、テンプレートの
  ドキュメント整備

補足（M9〜M10のあいだ、2026-07-08、マイルストーン番号なし）: CI導入
（GitHub Actions）、リポジトリを `my-template` から `banto` へ改名、
セッション有効期限・ログインレート制限の実装、Node 24 LTS対応
（[improvements.md](docs/history/improvements.md) §0/§1/§2.1/§2.2/§3.2）。

**M10〜M18**（[roadmap.md](docs/roadmap.md)、PR番号付き）:

- M10（#11）: ユーザー管理UI + RBAC（admin/editor/viewerの3ロール）
- M11（#12）: 自動ログイン（ログイン不要モード + デスクトップkeyring
  自動ログイン + LAN Remember me）
- M12（#13）: Glassテーマプリセット + SettingsProvider移行（UI設定を
  localStorageからSQLite設定DBへ）
- M13（#14）: チャート拡張（ズーム/パン・十字カーソル・しきい値バンド・
  第2Y軸・ストリーミング更新 + ヒストグラム/パレート図/箱ひげ図）
- M14（#15）: 監査ログ（`audit_log`テーブル・サービス層記録点・
  保持ポリシー・閲覧ページ）
- M15（#16）: CSV/Excelエクスポート・インポート（RFC 4180準拠コア +
  バルクインポートAPI + itemsページUI）
- M16（#17）: コマンドパレット（Ctrl+K、ナビ定義からの自動導出 +
  RBAC連動）
- M17（#18）: SQLiteバックアップ/リストア（`VACUUM INTO` +
  ステージング方式リストア）
- M18（#20）: 基盤整備 Phase A〜C（lint/format基盤・Playwrightスモーク
  E2E・パッケージ配布可能化）— 残ギャップは `[Unreleased]` の #32 で解消

[unreleased]: https://github.com/tyaro/banto/compare/v6.9.1...HEAD
[6.10.0]: https://github.com/tyaro/banto/compare/v6.9.1...v6.10.0
[6.9.1]: https://github.com/tyaro/banto/compare/v6.9.0...v6.9.1
[6.9.0]: https://github.com/tyaro/banto/compare/v6.8.0...v6.9.0
[6.8.0]: https://github.com/tyaro/banto/compare/v6.7.2...v6.8.0
[6.7.2]: https://github.com/tyaro/banto/compare/v6.7.1...v6.7.2
[6.7.1]: https://github.com/tyaro/banto/compare/v6.7.0...v6.7.1
[6.7.0]: https://github.com/tyaro/banto/compare/v6.6.0...v6.7.0
[6.6.0]: https://github.com/tyaro/banto/compare/v6.5.0...v6.6.0
[6.5.0]: https://github.com/tyaro/banto/compare/v6.4.0...v6.5.0
[6.4.0]: https://github.com/tyaro/banto/compare/v6.3.2...v6.4.0
[6.3.2]: https://github.com/tyaro/banto/compare/v6.3.1...v6.3.2
[6.3.1]: https://github.com/tyaro/banto/compare/v6.3.0...v6.3.1
[6.3.0]: https://github.com/tyaro/banto/compare/v6.2.0...v6.3.0
[6.2.0]: https://github.com/tyaro/banto/compare/v6.1.0...v6.2.0
[6.1.0]: https://github.com/tyaro/banto/compare/v6.0.0...v6.1.0
[6.0.0]: https://github.com/tyaro/banto/compare/v5.1.0...v6.0.0
[5.1.0]: https://github.com/tyaro/banto/compare/v5.0.0...v5.1.0
[5.0.0]: https://github.com/tyaro/banto/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/tyaro/banto/compare/v3.0.1...v4.0.0
[3.0.1]: https://github.com/tyaro/banto/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/tyaro/banto/compare/v2.1.1...v3.0.0
[2.1.1]: https://github.com/tyaro/banto/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/tyaro/banto/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/tyaro/banto/compare/v1.7.3...v2.0.0
[1.7.3]: https://github.com/tyaro/banto/compare/v1.7.2...v1.7.3
[1.7.2]: https://github.com/tyaro/banto/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/tyaro/banto/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/tyaro/banto/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/tyaro/banto/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/tyaro/banto/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/tyaro/banto/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/tyaro/banto/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/tyaro/banto/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/tyaro/banto/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tyaro/banto/compare/v0.1.2...v1.0.0
[0.1.2]: https://github.com/tyaro/banto/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tyaro/banto/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tyaro/banto/releases/tag/v0.1.0
