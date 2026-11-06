# パッケージ配布手順（M18 Phase C）

作成日: 2026-07-11。2026-07-12（M18 Phase C）に全面改訂: 配布方式を
「公開 npm レジストリ + crates.io」から「npm も Rust も **git タグ参照**」へ
変更した。banto-industrial（別リポジトリ、
境界は [template-scope.md](template-scope.md) §5）が本リポジトリの
`@banto/*` パッケージ/`banto-*` クレートを消費する前提条件。

> 決着済みの経緯（UNLICENSED 化と取り消し・GitHub Packages 案の棚上げ・
> `@banto` スコープ制約・再開時の手順）は
> [history/publishing-github-packages-2026-07.md](history/publishing-github-packages-2026-07.md)
> に切り出した。本書は現行の規範のみを保持する。

## 決定: npm パッケージも git 依存で配布する（2026-07-12）

GitHub の organization 名 `banto` が取得不能（既存アカウントが存在）のため、
npm 側も**レジストリを使わず git 依存（サブディレクトリ参照）で配布する**。
`@banto/*` のパッケージ名はそのまま維持できる。消費側（banto-industrial 等）は
pnpm の git 依存 + `path:` 指定で導入する。レジストリ・`.npmrc`・トークン設定は
不要（private リポジトリへの git 認証のみ。ローカルは gh/資格情報マネージャ、
CI は checkout 用 PAT）:

```sh
# ブランチ/タグ + モノレポ内サブディレクトリを指定（機構は 2026-07-12 に動作検証済み）
pnpm add "github:tyaro/banto#v6.10.0&path:packages/admin-core"
pnpm add "github:tyaro/banto#main&path:packages/theme"
```

- インストール結果はパッケージ名 `@banto/admin-core` のままで、
  中身は `files: ["src"]` に従い `src/` + `package.json` + `LICENSE` のみ
  （pnpm は git 依存でも pack 相当の `files` フィルタを通す — 実測確認済み。
  `LICENSE` はルートの MIT を pnpm が自動同梱する）
- 参照の固定は Rust クレートと同じ **git タグ**（`vX.Y.Z`、下記タグ運用
  規約を共用）。npm/Rust が同一タグで揃うのはむしろ管理が単純
- GitHub Packages 案は**棚上げ**（`publishConfig` は package.json に残すが
  不活性。将来、外部配布や複数消費者で semver range 解決が必要になったら
  再検討 — その時はスコープ改名の判断も同時に行う。経緯と再開手順は上記
  history 文書。再検討条件は [ADR-0011](adr/0011-git-tag-distribution.md)
  に統合）

## 消費実績と消費側の手順

2026-07-13、別リポジトリが本リポジトリの `v0.1.1` を実際に消費し、npm git
依存（`&path:` 指定）・Rust git タグ依存とも `pnpm install`/`cargo check`/
`cargo test --workspace` が通ることを確認した。この配布形態は動作する。

**新しい版への更新手順（依存とコピー部分の違い・DB 移行・基準版の記録・外部利用の検証）は
[upgrading.md](upgrading.md)。** 初回導入で必要になる作業の一覧は
[recipes/consume-as-git-dependency.md](recipes/consume-as-git-dependency.md)
（README「4. 別リポジトリから git 依存として消費する場合」から 2026-10-08 に移動）にまとめてある（npm/Rust の依存書き換え、`[workspace.package].repository`、
lint 設定の持ち込み、e2e スイートの移植など）。消費者はアプリ作者なので、
手順そのものはトラックB（README / recipes）側が正となる。

このとき最初に踏んだ罠が2点あり、どちらも既に本体で手当て済み:

- **ソース配布パッケージが Vite の依存事前バンドルで壊れる**（issue #150）→
  テンプレートの `apps/admin-template/vite.config.ts` に
  `optimizeDeps.exclude` を同梱して解決。判断の経緯は
  [ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.md)。なお
  「`packages/*/package.json` に `svelte` フィールドを足せば自動除外される」
  という案は**採らない** — `svelte` export condition は既に付いており、
  ADR-0007 の調査どおり、それこそが `vite-plugin-svelte` に
  「Svelte ライブラリなので事前バンドルしてよい」と判断させる原因側だった。
- **同一DBに対する `sqlx::migrate!` の二重使用**（`_sqlx_migrations` が
  DB 全体で1つしか無いことによるバージョン衝突）→
  [recipes/add-resource.md「`sqlx::migrate!` は同一DBに1クレートまで」](recipes/add-resource.md#sqlxmigrate-は同一dbに1クレートまで)
  を参照。

## 前提: ソース配布のまま

Banto の `@banto/*` パッケージは**モノレポ内でソース直接参照**
（`package.json` の `exports` が `./src/index.ts` を指す）で使われており、
これを崩さない。ビルド成果物（`dist`）は生成せず、`files` フィールドで
`src/`（+ 自動同梱される `package.json`/`LICENSE`）のみを配布物に含める。
理由:

- 実際の利用形態（テンプレートをコピーして使う）に最も合う
- `admin-template` 側の `workspace:*` 参照・Vite/SvelteKitのビルドが
  そのまま動き続ける（`dist` 切り替えによる二重管理を避ける）
- ビルドパイプライン（`@sveltejs/package` 導入等）を追加しない分、
  M18 のスコープ（配布可能化の最小限）に収まる

**消費側 dev の注意（issue #150 / [ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.md)）**:
ソース配布された `.svelte.ts`（runes モジュール）は、派生アプリでは node_modules
実体になり、Vite dev の依存オプティマイザが preprocess せず `svelte.compileModule`
に渡すため `import type` 等で 500 になる。消費アプリの Vite 設定で当該 `@banto/*` を
`optimizeDeps.exclude` する必要がある（テンプレートは `apps/admin-template/vite.config.ts`
で設定済み。`.svelte.ts` を持つのは admin-core/dock-svelte/forms/grid-svelte/image-assets/tree-svelte/ui。`@banto/ui` は #220 段階 2c の `createToastStore()` で `.svelte.ts` を持つようになった）。
`pnpm build`（`isBuild` で prebundle 無効）と `pnpm check`（Vite 非経由）はこの経路を
通らないため無影響。従来この配布検証は `pnpm publish --dry-run`（pack 構成）までで、
dev optimizer 経路は含まれていなかった。

各パッケージの `package.json` の現行設定:

```jsonc
{
  "license": "MIT", // リポジトリ全体でルート LICENSE（MIT）に統一
  "files": ["src"],
  "publishConfig": {
    // GitHub Packages 案の名残（不活性のまま残置）
    "registry": "https://npm.pkg.github.com",
    "access": "restricted"
  }
}
```

`files: ["src"]` により `tests/`・`svelte.config.js`・`vite.config.ts`・
`tsconfig.json`（消費側には不要な開発時専用ファイル）はパッケージから
除外される。package-local の `LICENSE` は置かない（pnpm がルートの
MIT を自動同梱する。UNLICENSED 期に置いていた経緯は history 文書）。

## バージョニング規約

- 現行バージョンは **v6.10.0**（全 `@banto/*` パッケージ・`banto-*` クレート・
  `tauri.conf.json`・git タグで統一）。バージョンとタグの整合は
  `pnpm check:versions`（CR-7、`scripts/check-versions.mjs`）が機械検査する
- 相互依存は無い（`admin-template` からの依存のみ、パッケージ間の依存関係は
  ゼロ）ため依存順の publish 制約はない
- **0.x の間（〜0.1.2、履歴）**: `minor` = 破壊的変更、`patch` = 追加・修正
  （SemVer の 1.0 未満の慣例）
- **1.0.0 以降（現行）**: 標準の SemVer。`major` = 破壊的変更、
  `minor` = 後方互換の機能追加、`patch` = 後方互換の修正。
  **1.x 系の運用上の例外**（v1.4.0 / v1.5.0 で適用）: 公開 API の削除・改名を
  伴わない「フィールド追加・引数追加」によるソース互換の破壊は、消費側の追従
  作業を CHANGELOG のリード文（「消費側への注意」）に明記した上で `minor` と
  してよい（オーナー判断）。`major` は API の削除・改名・意味変更に使う。
  **2.x 以降の運用上の変更**（v2.1.0 で適用、#306）: 公開 API の削除・改名を
  伴わない**運用上の挙動変更**（例: バックアップの保存先の変更で既存ファイルの
  手動移行が要る #280）は、消費側の移行手順を CHANGELOG の「消費側への注意」に
  明記した上で `minor` としてよい（オーナー判断）。上の 1.x 系の例外（フィールド
  追加・引数追加によるソース互換の破壊）も 2.x 以降で引き続き同じ扱いとする。
  データを失う・自動で戻せない変更や、移行手順なしでは動かなくなる変更は `major`
  とする。v1.0.0 は v1
  スコープ（仕様 M0〜M9 + roadmap M10〜M24）完了に伴う**安定版宣言**として
  発行した（0.1.2 からの破壊的変更はなし。2026-07-28）

## Rust クレート: git タグ参照（crates.io へは発行しない）

`banto-core` / `banto-storage` / `banto-server` / `banto-admin-services` /
`banto-attachments` は **crates.io へ発行しない**。
理由と再検討条件は [ADR-0011](adr/0011-git-tag-distribution.md)。
消費側（banto-industrial 等）は `Cargo.toml` で **git タグ参照**する:

```toml
[dependencies]
banto-core = { git = "https://github.com/tyaro/banto.git", tag = "v6.10.0" }
banto-storage = { git = "https://github.com/tyaro/banto.git", tag = "v6.10.0", features = ["sqlite"] }
banto-server = { git = "https://github.com/tyaro/banto.git", tag = "v6.10.0" }
```

private リポジトリの場合、消費側の Cargo/Git 認証（SSH鍵 or
`GIT_ASKPASS`/資格情報マネージャ）が別途要る。

### タグ運用規約

- タグ形式は `vX.Y.Z`（`workspace.package.version`、ルート `Cargo.toml`
  と揃える。現行 `v6.10.0`）。タグとマニフェストの整合は
  `pnpm check:versions --tag` が機械検査する（CR-7）
- **タグはリリース単位で打つ**（CHANGELOG の `[Unreleased]` を版節に
  切り出すとき。v1.1.0 以降の実運用）。**マイルストーンマージ毎には打たない**。
  消費側（banto-industrial 等）が追従作業を要するのは、リード文に
  「消費側への注意」がある版だけ（trait シグネチャ変更・`ListParams`/エラー型・
  公開 struct のフィールド追加など `banto-core`/`banto-storage`/`banto-server`/
  `banto-admin-services` の公開 API に影響する変更）
- タグは **npm 側（`@banto/*` の git 依存）と共用**（2026-07-12 決定節）。
  したがって `@banto/*` パッケージの公開APIの破壊的変更もタグ更新の
  対象になる
- 破壊的変更判定・バージョン番号の上げ方は npm 側と同じ規約（上記
  「バージョニング規約」）を踏襲する
- **タグを打つ前に**、main の SHA で `External consumer`
  （[external-consumer.yml](../.github/workflows/external-consumer.yml)）を
  `workflow_dispatch` し、緑を確認する（Git 依存での導入・dev 起動とブラウザ
  での描画・check・build・`cargo check`。[upgrading.md §8.2](upgrading.md)）。
  タグの push でも同じワークフローが走る。タグ後の実行は fixture の依存に
  **タグ名**を書いて（npm `#vX.Y.Z&path:`、Cargo `tag = "vX.Y.Z"`）タグ名での
  解決を確かめ、`check-versions.mjs --tag` でタグ名と version の一致も検査する。
  失敗すれば tracking issue（ラベル `external-consumer-failure`）が起票される。
  タグの経路の確認は、`workflow_dispatch` の入力に既存のタグ名（例 `v1.7.3`）を
  渡しても行える（ブランチ名・SHA を渡したときは SHA の経路）。タグの経路では
  fixture とスクリプトは workflow を起動した commit（dispatch なら通常 main）の
  ものを使い、依存だけをタグ名にするので、fixture の無い古いタグも検証できる。
  ただし今の fixture が import する export がそのタグに無ければ失敗しうる
- **タグを打ったら外部利用 fixture の ref を新しいタグに上げる**:
  `node scripts/external-fixture-set-ref.mjs vX.Y.Z` → `fixtures/external-consumer/`
  で `pnpm install --no-frozen-lockfile` → `package.json`・`rust/Cargo.toml`・
  `pnpm-lock.yaml` を commit（PR 経由）。fixture が commit している ref は現行
  リリースタグなので、新しい `.svelte.ts` 同梱パッケージを main に足すと
  （`verify:architecture` が fixture への import を求める一方で）既定状態の fixture は
  ローカルで install できなくなる。CI は検証する SHA に書き換えるので影響しない。
  同じ理由で、**fixture 側の手当てを外す変更**を入れると、次のタグで ref を上げるまで既定状態の fixture は
  ローカルで通らない期間ができる（例: v4.0.0 の #325 PR3 で `@banto/theme/css` の型を theme が持つように
  なり fixture の `src/ambient.d.ts` を外したので、v4.0.0 のタグ後に ref を上げるまで、v3.0.1 を参照する
  fixture の `pnpm check` はローカルで失敗する。PR の SHA に差し替える CI では通る）
- タグは軽量タグ（`git tag v6.10.0`）で可。変更履歴は
  [CHANGELOG.md](../CHANGELOG.md) で手動管理する（PR ごとに `[Unreleased]` へ
  追記 → リリース時に版節へ切り出し）

`admin_template_core`/`src-tauri` はアプリ固有のためタグ参照の対象外
（`admin-template` は banto リポジトリそのものをクローンして使う前提）。
**公開対象はパスで決める: `crates/*` = 公開 crate、`apps/*` = 対象外**
（`publish = false` では区別していない。外部利用 fixture と
`verify:architecture` の rule `external-consumer-fixture` はこの規約で公開
crate を洗い出す。2026-10-01、#271）。

## 公開しない選択

社内テンプレートとして使い続ける間は、上記の消費側設定は不要。
`workspace:*` のソース参照のままで、`pnpm --filter admin-template tauri dev` /
`build` はそのまま動く。Rust クレートも `path` 依存のまま本リポジトリ内で
完結する。
