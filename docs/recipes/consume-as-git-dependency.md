# レシピ: 別リポジトリから git 依存として消費する

作成日: 2026-10-08（README「4. 別リポジトリから git 依存として消費する場合」から
切り出し。トラックB＝アプリ作者向け）

[rename.md](rename.md) → [add-resource.md](add-resource.md) →
[remove-optional-assets.md](remove-optional-assets.md) はすべて「banto 自体を
コピー/フォークして 1 リポジトリ内で使い続ける」手順。これに対し、**別リポジトリ
（例: 社内の案件アプリ）がコピーせずに `@banto/*`/`banto-*` を git 依存として参照する**
構成も取れる。git 依存の記法そのものと配布方針は [publishing.md](../publishing.md)
（[ADR-0011](../adr/0011-git-tag-distribution.md)）を参照。ここでは、コピー系の手順を
流用する際に**追加で必要になる作業**を挙げる。

## 初回導入で必要になる作業

- **npm: `workspace:*` → git 依存への書き換え**: モノレポ内で
  `"@banto/admin-core": "workspace:*"` と参照している箇所を、
  `"@banto/admin-core": "github:tyaro/banto#v7.0.0&path:packages/admin-core"`
  のような git 依存にパッケージ単位で書き換える。
- **Rust: path 依存 → git タグ依存への書き換え**: 消費側 root `Cargo.toml`
  の `[workspace.dependencies]` に
  `banto-core = { git = "https://github.com/tyaro/banto.git", tag = "v7.0.0" }`
  等を追加し、各クレートの依存を `{ workspace = true }` に揃える。特に
  `apps/admin-template/src-tauri/Cargo.toml` の
  `banto-core = { path = "../../../crates/banto-core" }` は**同一リポジトリ内
  であることを前提にした相対パス参照**で、コピー先には `crates/banto-core`
  が存在せず即ビルド不能になる。必ず `{ workspace = true }` に書き換える。
- **`[workspace.package]` に `repository` が必要**: コピーしたクレートの
  `Cargo.toml` は `repository.workspace = true` を持つ。消費側 root
  `Cargo.toml` の `[workspace.package]` に `repository` が無いとビルドエラーに
  なるので、`repository` を追加するか `repository.workspace = true` ごと削除
  する。
- **root `package.json` の devDependencies**: ルートの `eslint.config.js` は
  `@eslint/js`・`typescript-eslint`・`eslint-plugin-svelte`・
  `eslint-config-prettier`・`globals` を import する。lint 設定ごと持ち込む
  なら、この5つを消費側 root の devDependency に入れる。加えて banto 自身は
  `typescript` をパッケージ単位に置いている（root には無い）ため、pnpm の
  非 hoist なワークスペース構成では `typescript-eslint` のパーサ解決のために
  root にも `typescript` が要る場合がある。
- **prettier を新規導入するなら `.prettierignore` を先に整える**: 既存の
  別リポジトリに `.prettierrc.json` を初めて持ち込むと、既存ファイル全部
  （特に `pnpm-lock.yaml`）が整形対象になり巨大な差分が出る。本リポジトリ
  直下の `.prettierignore` を出発点にすること。
- **Vite `optimizeDeps.exclude`**: `@banto/*` はソース配布（未コンパイルの
  `.svelte`/`.svelte.ts`）のため、git 依存として実 node_modules パッケージに
  なると Vite の依存事前バンドルが `.svelte.ts` を解析できず、`pnpm dev` が
  `js_parse_error` で失敗する（`pnpm build`/`pnpm check` は通るため気づき
  にくい）。テンプレートの `apps/admin-template/vite.config.ts` には対策済みの
  `optimizeDeps.exclude` が同梱されているので、**vite 設定を自前で書く場合は
  この exclude を移植する**こと。背景と判断は
  [ADR-0007](../adr/0007-derived-app-dev-optimizer-exclude.md)。
- **コピー・リネーム後は `cargo fmt --all` と clippy を通す**: クレート名の
  リネームで `use` 文の並び順が変わったり、デモ（`items`）削除で未使用 import
  が残ったりする。`cargo fmt --all` と
  `cargo clippy --all-targets -- -D warnings` を一度通せば機械的に拾える。
- **e2e スイート（`e2e/`）も移植できる**: `e2e/playwright.config.ts`・
  `global-teardown.ts`・`tsconfig.json` は、ポート番号・クレート名
  （`--filter` / `-p <core-crate>`）・一時DBのプレフィックス程度の差し替えで、
  `PORT`/`BANTO_DB`/`BANTO_ALLOW_SETUP` の環境変数契約（`banto-serve` 由来）
  のまま持っていける。spec 側の落とし穴として、
  `getByRole('heading', { name: '...' })` を `level` 指定なしで使うと、
  ページ本体に同名の見出しを足した画面で Header 側の `<h1>` と二重マッチして
  strict mode violation になる — `{ level: 2, name: '...' }` のようにレベルを
  指定して本体側に絞ること。

## 同一 DB への `sqlx::migrate!` は 1 クレートまで

消費側が自作の共通クレートを同じ DB プールに併用する場合に踏む罠。詳細は
[add-resource.md「`sqlx::migrate!` は同一DBに1クレートまで」](add-resource.md#sqlxmigrate-は同一dbに1クレートまで)。

## 新しい版への更新

依存タグの上げ方、コピーしたテンプレート部分の取り込み、DB 移行、基準版の記録は
[upgrading.md](../upgrading.md)。**依存タグを上げるだけではコピー済みのテンプレートは
更新されない。**
