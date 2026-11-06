# Banto 改善提案ドキュメント

作成日: 2026-07-08（コードベース調査に基づく）

本ドキュメントは、リポジトリ全体（`packages/`・`crates/`・`apps/admin-template/`・
`docs/`・リポジトリ運用）を多角的に調査し、改善点を視点別に整理したもの。
各項目には優先度（高/中/低）を付す。

> **凍結（2026-08-13）**: 2026-07 改善サイクルは完了し、本書は調査記録として
> 凍結した（経緯は [maintenance-review-2026-08.md](../reviews/maintenance-review-2026-08.md) §2）。
> 現役のバックログは [roadmap.md §3](../roadmap.md#3-v2--将来構想バックログ) に
> 一本化する。

> **3ファイルの役割分担（2026-07-19 追記）**: このリポジトリの改善関連
> ドキュメントは3つに分かれている。
>
> - **本書（`docs/improvements.md`）**: 未解決課題の調査記録。対応済みに
>   なった項目は本文から詳細を外し、1〜2行のスタブ + アーカイブへのリンク
>   のみ残す。
> - **[docs/history/improvements-archive.md](improvements-archive.md)**:
>   対応済みになった項目の実装記録アーカイブ（日付・PR番号・根拠を保持）。
> - **[improvement-plan-2026-07.md](improvement-plan-2026-07.md)**: 外部AI
>   レビューと本書の残課題を統合した「これから何をどの順でやるか」の
>   アクションプラン。一次情報はこちら。

> **2026-07-18 追記**: 本書の残課題と外部AIレビュー（Claude / ChatGPT）の
> 所見を統合したアクションプランを
> [improvement-plan-2026-07.md](improvement-plan-2026-07.md) に新設した。
> 「これから何をやるか」はそちらが一次情報。本書は調査記録として
> 引き続き更新する。

**現状の総評**: 仕様書（[ui-framework-spec.md](../ui-framework-spec.md)）の
マイルストーン M0〜M9 はすべて完了しており、パッケージ単位のユニットテスト
（TS 35ファイル + Rust 側 `#[cfg(test)]` 多数）、ヘッドレス/UI分離、
コメントの質など、コードそのものの品質は高い。改善余地は主に
**「コードの外側」**（CI・リリース運用・セキュリティ運用・E2E検証）に集中している。

---

## 0. Node バージョン追従 — 対応済み

**対応済み（2026-07-08）**: `engines.node >=24` / `.nvmrc` / README を
Node 24+ に更新済み。詳細は
[history/improvements-archive.md §0](improvements-archive.md#0-node-バージョン追従対応済み)。

## 1. CI/CD・自動化 — 対応済み

**対応済み（2026-07-16）**: M18（PR #20, #32）で `.github/workflows/ci.yml`
が整備され、frontend/rust（ubuntu+windows）/e2e の3ジョブがPRをゲートして
いる。整備前の現状記録・検討していた課題表は
[history/improvements-archive.md §1](improvements-archive.md#1-cicd自動化対応済み)
参照。

## 2. セキュリティ（優先度: 高）

M6/M9 で認証は argon2id 資格情報ストア + 初回セットアップまで実装済みだが、
LAN サーバ（`banto-server`）のセッション/運用面に残課題がある。

### 2.1 セッショントークンに有効期限がない — 対応済み（2026-07-08）

トークンごとに発行時刻・最終使用時刻を記録し、`TokenPolicy`（デフォルト:
絶対8時間 / アイドル1時間）で失効する実装が入っている。詳細は
[history/improvements-archive.md §2.1](improvements-archive.md#21-セッショントークンに有効期限がない対応済み2026-07-08)。

### 2.2 ログイン試行のレート制限がない — 対応済み（2026-07-08。追補 2026-07-17）

`RateLimitPolicy`（per-account 複合キー + per-IP 次元の2軸ロックアウト）を
argon2 検証前に判定する実装が入っている。詳細は
[history/improvements-archive.md §2.2](improvements-archive.md#22-ログイン試行のレート制限がない対応済み2026-07-08追補-2026-07-17)。

### 2.3 TLS 未対応（既知・方針は ADR-0003 で決定。構成例ドキュメントは対応済み）

仕様 §11.2 の割り切りどおり、TLS は**リバースプロキシ終端を正式サポート
経路**とし、組み込み TLS（`rustls` オプトイン + 自己署名証明書）は保留する
ことを [ADR-0003](../adr/0003-tls-via-reverse-proxy.md) で決定した（2026-07-19、
代替案比較込み・再検討条件つき）。

**対応済み（2026-07-18、ドキュメント部分。improvement-plan P1-4）**:
README の LAN 節に警告ボックス（HTTP 平文の明示・適用範囲）と
「リバースプロキシでの TLS 終端（Caddy 例）」節を追加した。詳細は
[history/improvements-archive.md §2.3](improvements-archive.md#23-tls-構成例ドキュメントドキュメント部分のみ対応済み2026-07-18)。

**未了**: 設定画面内の警告強化（既存 note の warning 化）— 設定ページは
visual regression の fullPage スナップショット対象のため、ベースライン
再生成ができる環境（CI と同一の Playwright Chromium + フォント）での実施
が必要（improvement-plan P1-4 の※2に追跡あり）。

### 2.4 セキュリティヘッダ — 対応済み（2026-07-16）

`with_security_headers` レイヤで4種のヘッダ（`X-Content-Type-Options` /
`X-Frame-Options` / `Referrer-Policy` / `Content-Security-Policy`）を全
ルートに一枚岩で付与済み。詳細は
[history/improvements-archive.md §2.4](improvements-archive.md#24-セキュリティヘッダ対応済み2026-07-16)。

追補（2026-10-06）: アプリ自身のデスクトップシェルが Tauri の WebView で
この HTTP の画面へ移る場合のために、`with_security_headers_using` と
`SecurityHeaders` で connect-src だけを要求ごとに広げられるようにした
（推奨はループバックの接続元に限る `request_from_loopback_peer`。
banto-industrial#505）。既定の `with_security_headers` は変わらない。
同日、同じホストのリバースプロキシ配下でも LAN の閲覧者を厳格なままにするため、
接続元と宛先（`Host`／`:authority`）の両方がループバックの要求だけを選ぶ
`request_is_loopback_local` を足し、推奨をこちらに替えた。

### 2.5 依存監査の自動化 — 対応済み（2026-07-16。ignore登録 2026-07-17）

CI に `audit` ジョブ（`pnpm audit --prod --audit-level high` +
`cargo audit`）を追加済み。詳細は
[history/improvements-archive.md §2.5](improvements-archive.md#25-依存監査の自動化対応済み2026-07-16ignore登録-2026-07-17)。

**Dependabot 導入も対応済み（2026-07-19、P4-4）**: `.github/dependabot.yml`
（github-actions/npm/cargo をグループ化週次）を導入し、SHA ピン留め
（P3-6）の追従を自動化した。

## 3. ドキュメントの鮮度 — 対応済み（全項目）

以下4項目はすべて対応済み。詳細な調査結果・書き換え箇所は
[history/improvements-archive.md](improvements-archive.md) 参照。

- **3.1 README が認証実装の実態と不一致** — 対応済み（2026-07-08）。
  argon2id 資格情報ストア + 初回セットアップフローに合わせて書き換え済み。
  [詳細](improvements-archive.md#31-readme-が認証実装の実態と不一致対応済み2026-07-08)
- **3.2 リポジトリ URL の不整合** — 対応済み（2026-07-16棚卸し）。
  `tyaro/banto` へ改名済み・`Cargo.toml`/9パッケージ `package.json` とも
  追従確認済み。
  [詳細](improvements-archive.md#32-リポジトリ-url-の不整合対応済み2026-07-16棚卸し)
- **3.3 仕様書 §14「未決事項」の棚卸し** — 対応済み（2026-07-16棚卸し）。
  決着済み項目に `[x]` と決着注記を付けた。
  [詳細](improvements-archive.md#33-仕様書-14未決事項の棚卸し対応済み2026-07-16)
- **3.4 CHANGELOG がない** — 対応済み（2026-07-16）。
  [CHANGELOG.md](../../CHANGELOG.md) 新設済み（Keep a Changelog形式）。
  [詳細](improvements-archive.md#34-changelog-がない対応済み2026-07-16)

## 4. テスト（優先度: 中〜高。E2Eは対応済み）

**対応済み（2026-07-16、E2E行のみ）**: Playwright スモークE2E + visual
regression + axe-core が CI の `e2e` ジョブに組み込み済み。詳細は
[history/improvements-archive.md §4](improvements-archive.md#4-e2e部分-playwright-スモーク-e2e-の導入対応済み2026-07-16)。
Svelte コンポーネントテストも対応済み（P3-3、詳細は
[history/improvements-archive.md §4（Svelteコンポーネントテスト部分）](improvements-archive.md)）。
残るは PostgreSQL 経路・REST 結合テストで、いずれも実需・実装待ち。

**現状**: ヘッドレスロジックのユニットテストは充実
（packages 35 テストファイル、Rust 側も `auth`/`csrf`/`events`/`sqlite` 等
62 テスト関数）。一方で以下が空白。

| 空白                                                     | 提案                                                                                                                                                                                                                     | 優先度 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| PostgreSQL 経路のテストなし（そもそも未実装、§6.1 参照） | 実装時に testcontainers か CI のサービスコンテナで統合テスト                                                                                                                                                             | 中     |
| REST API の結合テスト                                    | `banto-serve` バイナリがあるので、axum の `oneshot` ベースの結合テスト（auth → CRUD → SSE）を `admin-template-core` に追加しやすい。`rest.rs` に一部あるが、認可漏れ（未認証で各エンドポイントを叩く）の網羅があると安心 | 中     |

### 4.1 CI の E2E ジョブが webServer タイムアウトで恒常的に失敗 — 対応済み（2026-07-18、PR #37）

GitHub ランナー上の IPv4/IPv6 バインド不一致（`vite preview` が IPv6
ループバックのみバインド、Playwright の監視 URL は IPv4）が原因で `e2e`
ジョブが恒常的にタイムアウトしていた事象。`--host 127.0.0.1` 指定と
`stdout: 'pipe'` 恒久化で修正済み。詳細な事象・根本原因・教訓は
[history/improvements-archive.md §4.1](improvements-archive.md#41-ci-の-e2e-ジョブが-webserver-タイムアウトで恒常的に失敗対応済み2026-07-18pr-37)
参照（CI運用上の教訓として一読の価値あり）。

## 5. コード品質基盤・開発体験（優先度: 中）

### 5.1 リンタ・フォーマッタ設定が一切ない — 対応済み（2026-07-16）

`eslint.config.js`・`.prettierrc.json`・Rust側 `cargo fmt --check` /
`clippy -- -D warnings` がCIでゲートされている。詳細は
[history/improvements-archive.md §5.1](improvements-archive.md#51-リンタフォーマッタ設定が一切ない対応済み2026-07-16)。

### 5.2 改行コードの統一（`.gitattributes` がない）

**対応済み（2026-07-08、`.gitattributes` の追加のみ）**: ルートに
`.gitattributes`（`* text=auto eol=lf` + バイナリ拡張子の `binary` 指定）
を追加済み。詳細は
[history/improvements-archive.md §5.2](improvements-archive.md#52-gitattributes-追加部分-改行コードの統一対応済み2026-07-08)。

**実質完了（2026-07-19 確認）**: 一括正規化を要する CRLF 混入ファイルは
現時点で **0 件**（`git grep -lI $'\r'` が空、`git add --renormalize .` の
変更も 0）。prettier / CI の LF 強制で既に全 LF に収束しているため、
明示的な `--renormalize` 実行は不要。

### 5.3 pre-commit フック — 対応済み（2026-07-16、オプトイン .githooks 方式）

`.githooks/pre-commit`（`pnpm format:check && pnpm lint`）をオプトイン
方式（`git config core.hooksPath .githooks`）で導入済み。詳細は
[history/improvements-archive.md §5.3](improvements-archive.md#53-pre-commit-フック対応済み2026-07-16オプトイン-githooks-方式)。

### 5.4 ルート `package.json` のスクリプト拡充 — 対応済み（2026-07-08 / 2026-07-16）

`test`/`lint`/`format`/`format:check`/`e2e`/`e2e:visual` が揃っている。
詳細は
[history/improvements-archive.md §5.4](improvements-archive.md#54-ルート-packagejson-のスクリプト拡充対応済み2026-07-08--2026-07-16)。

## 6. アーキテクチャ・機能の残課題（優先度: 中）

### 6.1 PostgreSQL リポジトリが未実装 → **V2 テーマAで解決済み（#106-109）**

> **状況更新**: 本項は V2 テーマA「PostgreSQL アプリ全体対応」で解決済み。
> `banto-storage` に `postgres.rs`（接続ヘルパ）と `db.rs` の `Db`/`Dialect`
> 方言吸収が入り、app 層は方言別マイグレーション（`migrations-{sqlite,postgres}/`）
> と `db::init_db_from_target` の `postgres://` 経路で end-to-end に PostgreSQL 上で
> 動く。以下は着手前の記述として残す。

`banto-storage` に `postgres` feature は定義されているが、
`src/` には `sqlite.rs` しかなく **Postgres 実装モジュールが存在しない**。
仕様 §12.1 は「業務データは外部 PostgreSQL（TimescaleDB）」を標準と
位置づけているため、仕様と実装の乖離が最も大きい箇所。

- 提案: `list_query.rs`（ホワイトリスト式クエリビルダ）は方言差が小さいはず
  なので、`sqlite.rs` を雛形に `postgres.rs` を追加。プレースホルダ
  （`?` vs `$1`）と `RETURNING` 周りの差分吸収が主作業。

**期待値の明記は対応済み（2026-07-18、README + 仕様 §12.1 注記。
improvement-plan P1-1）**: 「v1 は SQLite のみ、PostgreSQL は feature
定義のみ」と明記し期待値を合わせた。実装自体は improvement-plan P4-5
として実需ドリブンで再評価する方針（未解決のまま残す）。

### 6.2 UI 設定の保存先が localStorage のまま — 対応済み（2026-07-16棚卸し）

M12（PR #13）で `SettingsProvider` 抽象が追加され、保存先が localStorage
から `settings` テーブル（Tauri/REST経由）へ移行済み。詳細は
[history/improvements-archive.md §6.2](improvements-archive.md#62-ui-設定の保存先が-localstorage-のまま対応済み2026-07-16棚卸し)。

### 6.3 スキーマ→列定義の自動導出 — 対応済み（2026-07-19、M23）

仕様 §3.1 の最重要ゴール「スキーマを1つ書けば一覧と編集フォームが両方生える」
のうち未実装だったグリッド列導出を、`@banto/grid-svelte` の
`columnsFromSchema` として実装し、items 一覧を導出ベースへ書き換え済み。
詳細は
[history/improvements-archive.md §6.3](improvements-archive.md#63-スキーマ列定義の自動導出対応済み2026-07-19m23)（roadmap.md M23参照）。

### 6.4 リソース定義からのルート導出（仕様 §14 未決）— 対応済み（2026-07-18）

「`items` のルート一式をコピーして書き換える」規約で決着し、
[recipes/add-resource.md](../recipes/add-resource.md) にチェックリスト形式で
固定化済み。詳細は
[history/improvements-archive.md §6.4](improvements-archive.md#64-リソース定義からのルート導出仕様-14-未決対応済み2026-07-18)。

## 7. npm 公開準備（優先度: 低〜中、公開する場合のみ）

[publishing.md](../publishing.md) に手順は整理済み。追加で:

- `@banto` スコープの npm org を**先に確保**しておく（名前スクワッティング対策。
  公開予定がなくても取得だけは早めに）。
- 各パッケージに `README.md` がない（npm ページが空になる）。最低限
  1パッケージ1枚の短い README を用意。
- `exports` がソース `.ts` 直指しのため、公開時の `dist` 切替は
  publishing.md どおりだが、`publishConfig.exports` 方式にすれば
  モノレポ開発とデュアル運用できる（doc 内でも言及済み — 実際に仕込んでおくと
  公開時の作業がゼロになる）。
- ~~Changesets 導入（§3.4 と共通）。~~ → **2026-07-16時点の判断**:
  [publishing.md](../publishing.md) が2026-07-12に「npm/crates.ioレジストリ
  へは公開せずgitタグ参照で配布する」方針へ確定したため、Changesets
  導入は当面見送り（§3.4参照）。この節自体（npm公開準備一式）も
  同方針次第では前提が変わる。

## 8. アクセシビリティ・i18n（優先度: 中。アクセシビリティ自動検査は対応済み）

**対応済み（2026-07-16棚卸し）**: axe-core（`@axe-core/playwright`）が
Playwright visual regressionジョブ（8ページスキャン）としてCIに組み込み
済み。dock-svelteのキーボード代替・grid-svelteのコントラスト不足はPR #27
で検出・修正され、除外リストなしで8スキャン全通過している。詳細は
[history/improvements-archive.md §8](improvements-archive.md#8-アクセシビリティ自動検査部分対応済み2026-07-16棚卸し)。
i18nは[template-scope.md](../template-scope.md) §4.3で
「テンプレートに入れない」と2026-07-12に決定済み（roadmap.md §3参照）。

- **i18n**: パッケージ側は日本語ハードコードなし（仕様 §13 遵守）を確認。
  ただし **Rust 側にユーザー向け日本語文言が埋まっている**
  （例: [auth.rs:190](../../crates/banto-server/src/auth.rs) の
  「ユーザー名またはパスワードが違います」）。ライブラリクレートとして
  公開するなら、エラーは kind コードで返しフロントで翻訳する形に寄せる。
  テンプレートアプリ自体は日本語のみだが、これは用途上許容範囲。
- **アクセシビリティ**: FilterPopover のフォーカス境界制御 — 対応済み
  （2026-07-19、P4-1）。実挙動（dismiss 型・Escape / 外側 pointerdown で
  閉じる）を `packages/grid-svelte/tests/FilterPopover.test.ts`（9件）で固定。
  詳細は
  [history/improvements-archive.md §8.1](improvements-archive.md)。

## 9. パフォーマンス・運用性（優先度: 低）

- 仮想スクロールの計測ベンチ — 対応済み（2026-07-19、P4-2）。vitest bench
  （`packages/grid-svelte/tests/virtual.bench.ts`、`pnpm bench`）で per-frame
  処理が総行数非依存であることを実証。詳細は
  [history/improvements-archive.md §9](improvements-archive.md)。
- `banto-server` のログ基盤（`tracing` 導入の可否）は
  [ADR-0004](../adr/0004-server-logging-eprintln.md) で決定（2026-07-19）:
  当面 `eprintln!` を既定に据え、`tracing` は保留（再検討条件つき）。
  依存を足さない方針（§3 / ADR-0002）との衝突を代替案比較込みで記録。
- SQLite の同時書き込みと WAL — 対応済み（2026-07-19、P4-3）。同一プロセス・
  単一プール共有で書き込みはシリアライズ、DB は WAL モード。README LAN 節に
  該当節を追加。詳細は
  [history/improvements-archive.md §9](improvements-archive.md)。

---

## まとめ: 凍結時点（2026-08-13）の残課題

上記の各節から対応済み項目を除いた最終状態。方針を ADR で決定済みの保留項目
（TLS・ログ）は「実装保留・方針は確定」であって未決ではない点に注意:

- **§2.3**: TLS 実装本体（組み込み rustls）— 方針は [ADR-0003](../adr/0003-tls-via-reverse-proxy.md)
  で「リバースプロキシ終端を正式・組み込みは保留」と決定済み
- **§7**: npm 公開準備一式（公開する場合のみ。現状は非公開方針、
  [publishing.md](../publishing.md)）
- **§9**: ログ基盤（`tracing`）— 方針は [ADR-0004](../adr/0004-server-logging-eprintln.md)
  で「`eprintln!` 継続・`tracing` は保留」と決定済み

2026-07-19 時点で未解決としていた §4（PostgreSQL 経路テスト）と §6.1
（PostgreSQL リポジトリ実装）は V2 テーマA（#106-109）と CI の
storage-postgres / app-postgres ジョブで解決済み。improvement-plan 側の
未消化として引き継ぐのは P4-8（実務サンプル、要スコープ判定）と
P1-4残（設定画面 LAN 警告の warning 化）の2点のみで、
[roadmap.md §3](../roadmap.md#3-v2--将来構想バックログ) へ転記済み。

着手順の推奨・優先度付けは [improvement-plan-2026-07.md](improvement-plan-2026-07.md)
が一次情報（本書の「優先度サマリ」節は全項目対応済みとなったため
[history/improvements-archive.md](improvements-archive.md) へ移動した）。
