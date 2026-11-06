# Banto 改善提案ドキュメント — 対応済み実装記録アーカイブ

本ファイルは [docs/improvements.md](improvements.md)（2026-07-08 調査）の
うち対応済みになった項目の実装記録アーカイブ。現在の未解決課題は
`docs/improvements.md`、これからやることは
[docs/improvement-plan-2026-07.md](improvement-plan-2026-07.md) にある。

節番号・見出しは移動元の `improvements.md` の番号を踏襲している
（`improvements.md` 側には1〜2行のスタブと本ファイルへのリンクが残る）。
日付・PR番号・根拠コメントは原文のまま保持している。

---

## 0. Node バージョン追従（対応済み）

**対応済み（2026-07-08）**: 2026-07時点でのActive LTSはNode 24（Node 22は
Maintenance LTSに移行済み、Node 26はCurrent・LTS移行は2026-10予定）。
ルート`package.json`の`engines.node`を`>=24`に、`.nvmrc`を新規作成
（中身`24`）、READMEの前提バージョン表記（開発セクション・Windowsセット
アップ節）を`Node 24+`に更新した。

## 1. CI/CD・自動化（対応済み）

**対応済み（2026-07-16）**: M18（PR #20, #32）で `.github/workflows/ci.yml`
が整備され、frontend（lint/format:check/check/test/build）・rust（fmt/
clippy/check/test、ubuntu-latest + windows-latest）・e2e（Playwright
スモーク + visual regression/axe-core）の3ジョブがPRをゲートしている
（`banto-attachments` を含む全クレートが対象）。以下は整備前
（2026-07-08時点）の現状記録として残す。

**現状（2026-07-08時点、整備前の記録）**: `.github/` ディレクトリが存在せず、CI が一切ない。
`pnpm check` / `vitest` / `cargo check` はすべてローカル手動実行頼み。

| 課題                                          | 提案                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR マージ時に型チェック・テストが強制されない | GitHub Actions で `pnpm install → pnpm check → pnpm -r test` + `cargo check`/`cargo test`（`-p banto-core -p banto-storage -p banto-server -p admin-template-core`）を回すワークフローを追加 |
| Windows 依存の検証漏れ                        | Tauri アプリのビルド検証はまず `ubuntu-latest`（webkit2gtk）+ `windows-latest` の2枚立てが現実的。フルビルドが重ければ `cargo check` のみでも価値がある                                      |
| フロントのビルド崩れ検知                      | `pnpm build`（SvelteKit 静的ビルド）を CI に含める                                                                                                                                           |
| リリースの再現性                              | タグ push で `tauri build` → GitHub Releases に成果物を添付するリリースワークフロー（`tauri-apps/tauri-action` が使える）                                                                    |

最小構成の `ci.yml`（check + test のみ、キャッシュ付き）から始めるだけでも
回帰検知の価値が大きい。**このリポジトリ最大の改善点。**（→ 実際に
2026-07-16に整備され、この評価は解消された）

## 2.1 セッショントークンに有効期限がない（対応済み、2026-07-08）

~~[auth.rs](../../crates/banto-server/src/auth.rs) の `AuthState` は
`HashMap<String, Identity>` にトークンを保持するのみで、
**発行後は logout されるまで永久に有効**。加えてプロセス再起動まで
無制限に蓄積する。~~

→ 実装済み: トークンごとに発行時刻・最終使用時刻を記録し、
`TokenPolicy`（デフォルト: 絶対8時間 / アイドル1時間）で失効。
`verify`/`identity_for` 時の遅延評価 + 書き込み時の機会的スイープで、
常駐タスクなしにメモリ蓄積も解消。テストはクロック注入で決定的に検証。

## 2.2 ログイン試行のレート制限がない（対応済み、2026-07-08。追補 2026-07-17）

~~`POST /api/auth/login` は無制限に試行できる。LAN 内限定とはいえ、
argon2 検証はコストが高いため DoS 的にも刺さりやすい。~~

→ 実装済み: `RateLimitPolicy`（デフォルト: 5回連続失敗で60秒ロックアウト、
成功でリセット）。キーは「クライアントIP + ユーザー名」
（`into_make_service_with_connect_info` で peer アドレスを取得。
取得不能な経路ではユーザー名のみに graceful degrade）。ロックアウト判定は
argon2 検証**前**に行うため CPU フラッディングにも効く。ロックアウト中は
429 + `Retry-After` を返し、既存フロントは無改修でエラー文言を表示できる。
外部クレート追加なし。

**追補（2026-07-17、フレッシュセキュリティレビューで検出・修正）**: 上記の
「IP + ユーザー名」複合キーだけでは、単一IPの攻撃者が `username`
フィールドを毎回変えると各試行が別キーになりロックアウトに到達せず、
（未知ユーザーでもダミーハッシュで argon2 が走るため）argon2 CPU 枯渇 DoS を
回避できた。対策として **ユーザー名非依存の per-IP 次元**（`max_ip_failures`、
デフォルト20回/60秒）を第2のロックアウト軸として追加。既存の複合キー軸
（per-account ブルートフォース対策・NAT 耐性）はそのまま残し、両軸とも
argon2 検証前に判定する。per-IP しきい値は per-account（5）より高く設定し、
共有NATの正常な打ち間違いでは発火しない。回帰テスト2件を追加
（`per_ip_dimension_bounds_a_username_rotation_flood` ほか）。

## 2.3 TLS 構成例ドキュメント（ドキュメント部分のみ対応済み、2026-07-18）

**対応済み（2026-07-18、ドキュメント部分。improvement-plan P1-4）**:
README の LAN 節に警告ボックス（HTTP 平文の明示・適用範囲）と
「リバースプロキシでの TLS 終端（Caddy 例）」節を追加した。構成例には
プロキシ経由で per-IP レート制限（`max_ip_failures`）が全クライアント
合算に縮退する注意点も明記。TLS 自体の実装（rustls オプトイン）と
設定画面内の警告強化は未了のため、`docs/improvements.md` §2.3 に残す。

## 2.4 セキュリティヘッダ（対応済み、2026-07-16）

**実装概要**: `crates/banto-server/src/security_headers.rs` に
`with_security_headers(router: Router) -> Router` を追加し、
`api_router(...).merge(static_router::<FrontendAssets>())` の**外側**
（最後）に1回だけ層として被せる方式にした（呼び出し箇所は
`apps/admin-template/core/src/bin/banto-serve.rs` と
`apps/admin-template/src-tauri/src/lib.rs` の2箇所 — どちらも同じ順序）。
これにより静的UI・`/api/*`（JSON/SSE 含む）・404/403 等のエラー応答まで、
新しいルートを足しても付け忘れが起きない一枚岩の層になっている。
`axum::middleware::from_fn` による手書きレイヤで、`tower-http` 等の新規
依存は追加していない。付与ヘッダは
`X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` /
`Referrer-Policy: same-origin` / `Content-Security-Policy`
（`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'
'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'`）の4種。
`script-src`/`style-src` の `'unsafe-inline'` は `app.html` の
first-paint テーマスクリプトと Svelte のインラインスタイルに必須という
前提・将来のnonce/hash化の余地はコード中のコメントに明記した。
`csrf.rs`（CSRFヘッダ必須化）・`response.rs`（`ApiError`のボディ整形）と
は独立で、後段のレスポンスにヘッダを追記するだけなので衝突しない。
`banto-server`側に3件のユニットテスト（静的ページ相当・JSON API相当・
SSE相当の3ルート形状それぞれで4ヘッダ確認）を追加。`curl`での実地確認
（`/`・SPAフォールバック・`/api/auth/status`成功応答・CSRF欠落403応答・
SSEストリーム応答の5パターン）でも全て4ヘッダの付与を確認済み。

## 2.5 依存監査の自動化（対応済み、2026-07-16。ignore登録 2026-07-17）

**実装概要**: `.github/workflows/ci.yml` に既存ジョブ（`frontend`/`rust`/
`e2e`）とは独立した `audit` ジョブを追加。`pnpm audit --prod
--audit-level high`（`--prod`はテンプレート利用者のCIを devDependencies
の既知アドバイザリで毎回赤にしないための意図的な絞り込み、理由はワーク
フロー内コメントに明記）と、`taiki-e/install-action@v2` でインストール
した `cargo-audit` による `cargo audit` の2本立て。Dependabot/Renovate
導入は引き続き検討事項として残す（本対応のスコープ外。→ 未解決課題として
`docs/improvements.md` §2.5 に残し、improvement-plan-2026-07.md P4-4で追跡）。

初回実行で検出された修正不能な既知アドバイザリ3件（rsa の Marvin
Attack = 修正版なし・未使用の sqlx-mysql 経由、quick-xml の High 2件 =
plist が 0.39 系を固定しており 0.41 へ上げられない・攻撃者入力に非到達）
は `.cargo/audit.toml` に**根拠と再確認条件のコメント付き**で ignore
登録した（2026-07-17）。修正可能なアドバイザリの ignore 追加は禁止
（同ファイル冒頭の規約を参照）。

## 3.1 README が認証実装の実態と不一致（対応済み、2026-07-08）

**対応済み（2026-07-08）**: [README.md](../../README.md) の4箇所
（「LANアクセス」手順・「セキュリティ注意」・「Windowsセットアップ」手順・
同節の補足）に残っていた「**認証はデモ実装（admin/admin固定）**」の記述を、
PR #9 で実装済みの argon2id 資格情報ストア + 初回セットアップフローに
合わせて書き換えた。残存する注意点（HTTPのみ・TLS未実装・トークン平文送信）は
引き続き明記している（セッション期限・レート制限は §2.1/§2.2 で実装済みとなり、
README にもデフォルト値を記載）。`pnpm dev`の
ブラウザ単体デモモード（Rustバックエンドなし）のみ、従来どおり
`admin`/`admin`固定の簡易セッション認証が残ることも明記した。

## 3.2 リポジトリ URL の不整合（対応済み、2026-07-16棚卸し）

**対応済み（2026-07-16棚卸し）**: `git remote -v` で確認したところ
`origin` は `https://github.com/tyaro/banto.git` となっており、実際に
`banto` へ改名済みだった。`Cargo.toml`（`workspace.package.repository =
"https://github.com/tyaro/banto"`）、および `packages/*/package.json`
9ファイル（`admin-core`・`attachments`・`charts`・`dock-svelte`・
`forms`・`grid-svelte`・`report`・`scan-wedge`・`theme`。M19〜M21で
`attachments`/`report`/`scan-wedge` が増えた）の `repository.url` も
`https://github.com/tyaro/banto.git` に揃っており、追従漏れなし。

**調査結果（2026-07-08時点、改名前の記録）**: GitHub リモート（`git remote -v`）は実際に
まだ `https://github.com/tyaro/my-template.git` のままで、`banto` への
改名は行われていなかった。

- 改名する場合: GitHub のリダイレクトが効くため既存クローン/リンクは
  当面壊れないが、`Cargo.toml`（workspace の `repository`）と
  `packages/*/package.json` 6ファイル（`admin-core`・`charts`・
  `dock-svelte`・`forms`・`grid-svelte`・`theme`）の `repository` フィールドは
  リダイレクト任せにせず追従更新すること（npm 公開時に古いURLのままだと
  紛らわしい）。
- 改名しない場合: 現状の `Cargo.toml`/`package.json` の記述はそのままで
  問題ない。

## 3.3 仕様書 §14「未決事項」の棚卸し（対応済み、2026-07-16）

**対応済み（2026-07-16 棚卸し実施）**: [ui-framework-spec.md](../ui-framework-spec.md)
§14 を実装状況と突き合わせ、決着済みの4項目に `[x]` と決着注記を付けた
（名称・ライセンスの既存2件に加え、下記の3件）:

- 「組み込みHTTPサーバのフレームワーク選定」→ **axum で決着済み**
  （`crates/banto-server/Cargo.toml`）
- 「grid-core/grid-svelte 分離」→ 現状 `grid-svelte` 内の `core/` に
  ヘッドレスロジックを置く形で決着（仕様 §2.1 の注記どおり。独立した
  `grid-core` パッケージは存在しない）
- 「認証雛形の想定方式」→ ローカル認証（argon2id、`users.rs`）で v1 決着

本当に未決のもの（型生成ツール `tauri-specta` 等の採用可否、外部DB接続
情報の管理方法、MQTTインジェストの位置づけ、REST APIのバージョニング
方針、ドッキングシステムの段階リリース方針、リソース定義からのルート
導出方式）は判断に確信が持てなかったため触れていない
（詳細は棚卸し作業の報告を参照）。

## 3.4 CHANGELOG がない（対応済み、2026-07-16）

**対応済み（2026-07-16）**: リポジトリルートに
[CHANGELOG.md](../../CHANGELOG.md)（Keep a Changelog形式）を新規作成した。
`[Unreleased]` 節 + `v0.1.0`/`v0.1.1` のバックフィル（M0〜M9はマイルストーン
1行要約、M10以降はマイルストーン+PR番号単位）。npm公開時にChangesetsへ
移行する計画だったが、[publishing.md](../publishing.md) は
2026-07-12に「npm/crates.ioレジストリへは公開せずgitタグ参照で配布する」
方針へ確定済み（同ドキュメントの旧「タグ運用規約」節にあった「CHANGELOGは
当面省略」の記述も、本CHANGELOG新設に伴い置き換えた）。そのため
Changesetsへの移行は当面計画しておらず、CHANGELOG.mdは手動運用とする
（当初案からの変更点）。

## 4 (E2E部分) Playwright スモーク E2E の導入（対応済み、2026-07-16）

**対応済み（2026-07-16、E2E行のみ）**: M18（PR #20, #32）でPlaywright
スモークE2E（`e2e/tests/smoke.spec.ts`、12シナリオ）+ visual regression
（`e2e/visual/visual.spec.ts`）+ axe-coreアクセシビリティスキャン
（`e2e/visual/a11y.spec.ts`、8スキャン、PR #27で除外リストも撤去）が
CIの `e2e` ジョブに組み込み済み。`docs/improvements.md` §4 の他の行
（Svelteコンポーネントテスト・PostgreSQL経路・REST結合テスト）は未確認の
まま残っている。

提案されていた対応: まずブラウザモード（`pnpm dev` + InMemory）に対して
Playwright を導入。ログイン→一覧→編集→保存の1本のスモークだけでも価値大。
Tauri 本体の E2E は WebDriver 対応が面倒なので後回しでよい、というもの
（優先度: 高）。→ 上記のとおり実施済み。

## 4.1 CI の E2E ジョブが webServer タイムアウトで恒常的に失敗（対応済み、2026-07-18、PR #37）

**事象**: CI の `e2e` ジョブが `Error: Timed out waiting 30000ms from
config.webServer` で失敗し続けていた（判明している範囲で 2026-07-15 以前
から。main の push CI は直近8 run すべて赤で、**CI ゲートが実質機能して
いない**状態のまま PR #33〜#36 がマージされていた）。ローカルでは
Node 22 / 24 とも再現しないため、当初は環境ドリフトと誤認しやすかった。

**根本原因**: GitHub ランナー上では `localhost` が IPv6 の `::1` に解決
されるため、`vite preview`（visual regression 用の第2 webServer）が
IPv6 ループバックにのみバインドしていた。一方 Playwright の readiness
監視 URL は IPv4 の `http://127.0.0.1:4173` のため 30 秒間
`ECONNREFUSED` が続きタイムアウト。`webServer` は配列で全エントリの起動
が必須のため、正常起動していた `banto-serve`（スモーク用、約100msで
ready）側のスモークまで巻き添えで一切走らなかった。ローカルで再現しな
かったのは、IPv6 無効環境では `localhost` が `127.0.0.1` に解決され偶然
一致するため。

**対応**（PR #37）: preview コマンドに `--host 127.0.0.1` を追加して
バインド先とポーリング先を常に一致させた。あわせて両 webServer の
`stdout: 'pipe'` を恒久化 — Playwright の既定（stdout 破棄）だと、この種
の起動失敗が「ログ皆無の 30 秒タイムアウト」になり診断不能だった
（実際、原因特定には `DEBUG=pw:webserver` + stdout パイプの一時有効化 PR
が必要だった）。修正後、main の push CI が全5ジョブ green
（run 29652409617）。

**教訓**:

- webServer の `url`（監視先）と `command` のバインド先は**同じリテラル
  アドレスで揃える**。`localhost` は環境によって `::1` / `127.0.0.1` の
  どちらにも解決され、暗黙の前提が CI でだけ崩れる。
- CI が赤のままマージを続けると、無関係な PR でも失敗が「いつもの」に
  見えて新規の破壊を検出できない。赤になったら**まず main 自体の失敗か
  切り分けて即修理する**（CI ゲート必須の運用が前提。roadmap §7）。
- サブプロセスの stdout/stderr は CI では黙殺せずパイプする。今回の
  `stdout: 'pipe'` 恒久化はその実装。

## 5.1 リンタ・フォーマッタ設定が一切ない（対応済み、2026-07-16）

**対応済み（2026-07-16）**: M18（PR #20）で `eslint.config.js`・
`.prettierrc.json`・`.prettierignore` がルートに導入され、`pnpm lint`
（ESLint、`eslint-plugin-svelte` + `typescript-eslint`）・
`pnpm format`/`format:check`（Prettier + `prettier-plugin-svelte`）が
CIの `frontend` ジョブでゲートされている。Rust側も `cargo fmt --check`
と `clippy -- -D warnings` がCIの `rust` ジョブに組み込み済み（設定
ファイル自体は導入時点でデフォルトのまま、提案どおり）。

**現状（2026-07-08時点、整備前の記録）**: `eslint.config.js` / `.prettierrc` / `rustfmt.toml` / `clippy.toml` のいずれも
存在しない。個人開発では回っていても、テンプレートとして配布するなら
利用者のベースラインになるため整備価値が高い。

- 提案: `prettier`（+ `prettier-plugin-svelte`）と `eslint`
  （`eslint-plugin-svelte` + `typescript-eslint`）をルートに導入し、
  `pnpm lint` を CI へ。Rust は `cargo fmt --check` と
  `cargo clippy -- -D warnings` を CI へ（設定ファイル自体はデフォルトで可）。

## 5.2 (`.gitattributes` 追加部分) 改行コードの統一（対応済み、2026-07-08）

**対応済み（2026-07-08、`.gitattributes` の追加のみ）**: `git diff` 実行時に
「LF will be replaced by CRLF」警告が出ている（現に `src-tauri/Cargo.toml`
が改行コードだけの differences としてステータスに出続けている）。
Windows/macOS 混在開発で事故りやすい。

- ルートに `.gitattributes`（`* text=auto eol=lf` + バイナリ拡張子の
  `binary` 指定）を追加した。既存ファイルの `git add --renormalize .`
  による一括正規化は未実施のため、`docs/improvements.md` §5.2 に
  引き続き残す。

## 5.3 pre-commit フック（対応済み、2026-07-16、オプトイン .githooks 方式）

**対応済み（2026-07-16、オプトイン .githooks 方式）**: `husky` /
`lint-staged` / `lefthook` は導入しなかった（依存を足さない文化を優先。
CI（§1）が既に `pnpm format:check`/`pnpm lint` をPRゲートしているため、
ローカルフックは「早期に気づく」ための任意の補助と位置づけた）。
代わりにリポジトリルートの `.githooks/pre-commit`（POSIX sh、実行属性
付与済み）が `pnpm format:check && pnpm lint` を実行し、失敗時は
`pnpm format` での自動修正を案内して非0終了する。デフォルトでは
Gitに認識されないオプトイン方式で、`git config core.hooksPath
.githooks`（README「開発」節に追記）で有効化する。1コミットだけ
スキップしたい場合は `git commit --no-verify`（フック内コメントにも
明記）。

## 5.4 ルート `package.json` のスクリプト拡充（対応済み、2026-07-08 / 2026-07-16）

**対応済み（2026-07-08 `pnpm test` / 2026-07-16棚卸しで `pnpm lint` も
現存を確認）**: ルート `package.json` の `scripts` に
`"test": "pnpm --recursive --if-present test"`（2026-07-08）に加え、
M18（PR #20）で `"lint": "eslint ."` / `"format"`/`"format:check"` /
`"e2e"`/`"e2e:visual"` が追加済み。新規参加者が「何を回せば全部検証
できるか」をREADMEではなくscriptsから辿れるようにする、という目的は
達成済み。

## 6.2 UI 設定の保存先が localStorage のまま（対応済み、2026-07-16棚卸し）

**対応済み（2026-07-16棚卸し）**: M12（PR #13、roadmap.md）で
`packages/admin-core` に `SettingsProvider` 抽象が追加され、テーマ
モード・プリセット・ドックレイアウトの保存先が localStorage から
既存 `settings` テーブル（Tauri/REST経由）へ移行済み（未認証時・
デモモードは localStorage フォールバック）。README末尾の記載は
移行前の状態を指しており更新推奨（本棚卸しでは対象外のため未変更）。

**現状（2026-07-08時点、移行前の記録）**: README 末尾にも記載のとおり、テーマ・ドックレイアウトは localStorage 保存。
仕様 §12.1 の `SettingsProvider`（ローカル SQLite 設定DB）への移行が未了。
LAN ブラウザモードだと端末ごとに設定が分かれる/消える問題に直結する。

## 6.3 スキーマ→列定義の自動導出（対応済み、2026-07-19、M23）

仕様 §3.1 の最重要ゴール「スキーマを1つ書けば一覧と編集フォームが両方生える」
について、`columns` 省略時の `schema` からの導出が実装済みか確認し、
未実装なら v1.1 の筆頭候補とする（テンプレートの体験価値の核）。

**棚卸し結果（2026-07-18、improvement-plan P1-2）**: **未実装と確認**。
フォーム側（`FormSchema` → `@banto/forms`）は実装済みだが、グリッド列は
アプリ側の手書き（`ItemsClientGrid.svelte` の `baseColumns`）で、
`admin-core`/`grid-svelte` にスキーマ→ `GridColumn[]` の導出は存在しない。
[roadmap.md](../roadmap.md) に **M23（候補）** として登録し、スコープ案も
同所に記載した。

**実装済み（2026-07-19、M23）**: `@banto/grid-svelte` の
`columnsFromSchema` として実装し、items 一覧を導出ベースへ書き換え済み
（詳細は roadmap.md M23）。本項は完了。

## 6.4 リソース定義からのルート導出（仕様 §14 未決）（対応済み、2026-07-18）

現状 `items` はルートファイル手書き。動的ルート `[resource]` 方式にするか、
`items` を「コピーして使う規約」と明文化するか、どちらかに決めて
ドキュメント化する（テンプレート利用者が最初に迷う場所）。

**対応済み（2026-07-18、improvement-plan P1-3）**: 「`items` のルート一式を
コピーして書き換える」規約で決着（spec §14 の該当項目に決着注記済み）。
正式手順を [recipes/add-resource.md](../recipes/add-resource.md) に
チェックリスト形式で固定化し、README・AGENTS.md から参照する構成にした。

## 8 (アクセシビリティ自動検査部分)（対応済み、2026-07-16棚卸し）

**対応済み（2026-07-16棚卸し）**: axe-core（`@axe-core/playwright`）が
Playwright visual regressionジョブ（`e2e/visual/a11y.spec.ts`、8ページ
スキャン）としてCIに組み込み済み。dock-svelteの「ドラッグ主体でキー
ボード代替が難しい」懸念とgrid-svelteのコントラスト不足は PR #27
（2026-07-16）で実際に検出・修正され（`role=toolbar`化、スクロール
領域への `role=region`+`tabindex=0`付与、`.cell-link`のコントラスト
調整）、除外リストなしで8スキャン全通過している。FilterPopoverの
フォーカストラップは専用のユニット/インタラクションテストとしては
未確認（axeスキャンはaria違反検出が中心でフォーカス遷移の網羅検査では
ないため）— この一点は本棚卸しでは「対応済み」と言い切らず
`docs/improvements.md` §8 に残す。i18nは[template-scope.md](../template-scope.md)
§4.3で「テンプレートに入れない」と2026-07-12に決定済み（roadmap.md §3参照）。

## 4 (Svelteコンポーネントテスト部分) BantoForm/BantoGrid のマウントテスト（対応済み、2026-07-19、P3-3）

**対応済み（2026-07-19、improvement-plan P3-3）**: ヘッドレスロジックは既に
手厚くテスト済みのため、コンポーネント側は「マウント + 基本操作」に絞った
（roadmap M2 の分離方針どおり）。`@testing-library/svelte` + `jsdom`（devDep、
ユーザー承認済み）で `BantoForm`/`BantoGrid` のマウント+基本操作テストを各5件
追加。環境は component テストのみ jsdom に opt-in。

## 8.1 FilterPopover のフォーカス境界制御（対応済み、2026-07-19、P4-1）

**対応済み（2026-07-19、improvement-plan P4-1）**: 実装を精査した結果、
FilterPopover は **Tab 巡回型のフォーカストラップは持たず**、「Escape / 外側
pointerdown で閉じる」dismiss 型の境界制御であることが判明した（当初 §8 の
「フォーカストラップ」は推測だった）。この実挙動（Escape で閉じる・外側
pointerdown で閉じる・内側は閉じない・unmount でリスナ解除・dialog
ロール/aria-label・apply/clear/Enter）を
`packages/grid-svelte/tests/FilterPopover.test.ts`（9件）で固定した。
仕様 §4.7（キーボード操作・スクリーンリーダー）の一次棚卸しも完了済み。

## 9 (bench/WAL部分) パフォーマンス・運用性（対応済み、2026-07-19、P4-2/P4-3）

**仮想スクロールのベンチ（対応済み、2026-07-19、P4-2）**: ブラウザ FPS
（非決定的・CI 不可）ではなく、仮想化のホットパスを vitest bench で計測
（`packages/grid-svelte/tests/virtual.bench.ts`、`pnpm bench` で実行）。
per-frame 処理（`computeWindow` + 可視ウィンドウ slice）が総行数に依存しない
（10k と 100k でほぼ同一 ≈0.0002ms/frame）ことを実証し、sort/filter の総行数
依存コスト（100k で sort ~235ms・filter ~32ms）も記録。代表結果と読み方は
ベンチ冒頭コメントに常設。

**SQLite の同時書き込みと WAL（対応済み、2026-07-19、P4-3）**: 調査結果、
デスクトップ + 組み込みサーバは同一プロセス・単一プール共有のため書き込みは
シリアライズされ、DB は WAL モード。README LAN 節に「同時書き込みとSQLite
（WAL）」節を追加し、別プロセスからの同時アクセスを避ける注意も明記。

## 優先度サマリ（着手順の推奨、2026-07-16 棚卸しで更新。全項目対応済みのため本アーカイブへ移動）

1. ~~**CI 導入**（§1）~~ — **対応済み（2026-07-16）**。M18（PR #20, #32）で
   `.github/workflows/ci.yml` の frontend/rust/e2e 3ジョブがPRゲート化済み
2. ~~**README の認証記述更新**（§3.1）~~ — **対応済み（2026-07-08）**。
   ~~**リポジトリ改名の要判断**（§3.2）~~ — **対応済み（2026-07-16）**。
   `tyaro/banto` へ改名済み・`Cargo.toml`/9パッケージ `package.json` とも追従確認済み
3. ~~**`.gitattributes` 追加**（§5.2）~~ — **対応済み（2026-07-08、追加のみ）**。
   既存ファイルの `git add --renormalize .` による一括正規化は統合フェーズで別途実施
4. ~~**トークン有効期限 + ログインレート制限**（§2.1, §2.2）~~ — **対応済み（2026-07-08）**
5. ~~**Playwright スモーク E2E**（§4）~~ — **対応済み（2026-07-16）**。
   スモーク12件 + visual regression + axe-core 8スキャンがCIの `e2e` ジョブに組込済み
6. ~~**lint/format 基盤**（§5.1）~~ — **対応済み（2026-07-16）**。
   ~~**pre-commit フック**（§5.3）~~ — **対応済み（2026-07-16、オプトイン `.githooks` 方式）**。
   `pnpm test`/`pnpm lint` スクリプトは対応済み（§5.4）
7. **PostgreSQL 実装 or 期待値の明記**（§6.1）— **期待値の明記は対応済み
   （2026-07-18、README + 仕様 §12.1 注記。improvement-plan P1-1）**。
   実装自体は improvement-plan P4-5 として実需ドリブンで再評価（未解決のため
   `docs/improvements.md` §6.1 に残る）
8. ~~**SettingsProvider 移行**（§6.2）~~ — **対応済み（M12、PR #13）**。
   ~~**スキーマ→列導出**（§6.3）~~ — **棚卸し済み後、2026-07-19（M23）で実装完了**

**その他対応済み（2026-07-08）**: Node LTS 追従（§0、`engines`/`.nvmrc`/README更新）。

**2026-07-16 棚卸しで追加対応済み**: CHANGELOG.md 新設（§3.4）、
仕様書§14未決事項の棚卸し（§3.3）、リポジトリ改名の確認（§3.2）、
CI導入の実態反映（§1）、lint/format基盤の実態反映（§5.1）、
pre-commitフック導入（§5.3）、`pnpm lint`スクリプトの実態反映（§5.4）、
E2E/アクセシビリティ自動検査の実態反映（§4, §8）、SettingsProvider
移行の実態反映（§6.2）。§6.1（PostgreSQL）は improvement-plan で実需
ドリブン再評価として未解決のまま残り、§6.3（スキーマ→列導出）・
§6.4（ルート導出方式）はその後 2026-07-18〜19 にそれぞれ対応済みとなった。
