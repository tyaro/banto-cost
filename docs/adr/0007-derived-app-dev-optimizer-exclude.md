# ADR-0007: `.svelte.ts` のソース配布と派生アプリ dev の両立は消費側 `optimizeDeps.exclude` で解く

> English: [0007-derived-app-dev-optimizer-exclude.en.md](0007-derived-app-dev-optimizer-exclude.en.md)

- 状態: Accepted
- 日付: 2026-08-14
- 関連: [conventions.md §3](../conventions.md)（依存を足さない）、
  [ADR-0002](0002-minimal-dependencies.md)（依存最小化）、
  [publishing.md](../publishing.md)（ソース配布・git 依存）、issue #150

## コンテキスト

Banto の `@banto/*` パッケージは**ソース配布**（`exports` が `./src/index.ts` を
指し、`.svelte.ts`（runes モジュール）を生のまま出荷。`files: ["src"]`。
publishing.md の M18 決定）。テンプレートを git タグ + `path:` 依存で消費する
派生アプリでは、これらが **node_modules の実体パッケージ**になる。

issue #150: 派生アプリで `pnpm dev` すると、Vite 8 の依存オプティマイザ
（Rolldown）が `@banto/admin-core` 等を prebundle する際、`.svelte.ts` を
`import type` 等の TS 専用構文で「Unexpected token」（js_parse_error）にして
HTTP 500 になる。`pnpm build` / `pnpm check` は成功する。

根本原因（ソース解析 + 実測再現で確定）:

- `vite-plugin-svelte` は dev で `prebundleSvelteLibraries` を既定 true にし
  （`options.js:152` `!isBuild`）、有効時は svelte ライブラリの自動 exclude を
  空にクリアする（`options.js:527`）。svelte export 条件を持つ `@banto` は
  framework パッケージ判定され、node_modules 実体である派生アプリでは prebundle
  対象になる。
- オプティマイザのモジュール経路（`setup-optimizer.js` の
  `compileSvelteModule`）は `.svelte.ts` を **preprocess せず** `svelte.compileModule`
  に生コードを渡すため、TS 専用構文で落ちる。通常の dev transform 経路
  （`compile-module.js` の `enforce:'post'`）は Vite コアが先に TS を剥がすので
  問題ない。
- テンプレート本体は `@banto/*` を `packages/` への workspace symlink（realpath が
  node_modules 外）で解決するため prebundle されず無害。build は `isBuild` で
  prebundle 無効、check は Vite 非経由。

## 決定

**消費側テンプレートの `apps/admin-template/vite.config.ts` に
`optimizeDeps.exclude` を置き、`.svelte.ts` をソース配布する `@banto/*` を dev
オプティマイザの prebundle 対象から外す**（案D）。ソース配布方針は維持する。

## 検討した代替案

- **案D（採用）: 消費側 `optimizeDeps.exclude`。** 利点: ソース配布方針
  （publishing.md）と最小依存（ADR-0002）を保ったまま、消費側設定だけで完結。
  除外されたパッケージは通常の dev transform 経路に載り正しく処理される。
  実測で issue の4件 js_parse_error が解消（exit 0）。テンプレート本体は元々
  prebundle されないので no-op（無回帰）。欠点: 除外パッケージが dev で個別
  モジュール配信になり cold start がやや遅い（機能・正しさに影響なし）。列挙の
  保守が要る（→ 機械検査で担保、下記帰結）。
- **案B（不採用）: dist 配布。** `@sveltejs/package` で `.svelte.ts` を
  コンパイル済み JS に変換すれば dev オプティマイザは TS で落ちないが、
  publishing.md の**ソース配布方針を反転**させ、ビルドパイプラインという新規依存
  （ADR-0002 の「no」）と dist の二重管理を招く。総保守コストに見合わない。
- **案C（不採用・すでに充足）: `svelte` export 条件の付与。** 全 `@banto/*` は
  既に svelte 条件を持つが、`prebundleSvelteLibraries` 既定 true が exclude を
  クリアするため**単独では効かない**。
- **案D-alt（フォールバック）: `svelte.config.js` の `vitePlugin:
{ prebundleSvelteLibraries: false }`。** 列挙不要で将来の `.svelte.ts`
  パッケージ追加にも自動追随するが、`@lucide/svelte` まで prebundle されなくなり
  cold start が更に遅い。列挙 exclude が漏れる/効かない場合の次善策として残す。

## 帰結

- **保守ルール（不変条件）**: `.svelte.ts` を src/ にソース配布する `@banto/*`
  パッケージは、`apps/admin-template/vite.config.ts` の `optimizeDeps.exclude` に
  必ず列挙する。新規追加時も同期する。`.svelte` コンポーネントのみのパッケージ
  （charts/attachments/report）は preprocess 経路を通るので対象外。この不変条件は
  conventions.md に1項として記載し、`verify:architecture`（rule
  `optimizedeps-svelte-source`）が「admin-template が依存し `.svelte.ts` を持つ
  `@banto/*`」と exclude リストの一致を機械検査する。
- **検証限界**: 本 ADR の担保は `vite-plugin-svelte` のソース解析と、node_modules
  実体を模した再現（`vite optimize --force` で issue と同一の4件 js_parse_error →
  exclude 付与で exit 0）まで。issue が起きる本物の経路（`pnpm add
"github:tyaro/banto#<tag>&path:packages/*"` の git タグ依存を実 dev 起動する
  end-to-end）は private タグ認証と実起動を要し未実施。恒久的な担保は
  `verify:architecture` のリスト一致検査が担う。
  - **2026-10-01 更新（#271）**: end-to-end を CI で担保するようにした。
    [external-consumer.yml](../../.github/workflows/external-consumer.yml) が
    `fixtures/external-consumer/` に `@banto/*` を Git 依存（PR の head SHA・
    リリースタグ等）で導入し、`vite dev` をブラウザで開いて描画を確かめる
    （exclude あり = 合格条件）。exclude を外した診断ジョブ（成功条件にしない）が
    #150 の再現の有無を毎回記録する。実測では v1.7.3 で 11 件、main（212c3a0）で
    14 件の js_parse_error が exclude 無しで再現し、exclude ありでは 0 件。
    **診断ジョブが「再現しなかった」と報告したら、上流で直った可能性があるので
    本 ADR を見直す。** fixture の exclude 一覧も `verify:architecture`（rule
    `external-consumer-fixture`）が同じ集合との一致を検査する。
- **配布方針との結合**: publishing.md に「ソース配布された `.svelte.ts` は消費側
  dev の設定（`optimizeDeps.exclude`）とセットで初めて機能する」を明記した。
  pack のみを検証していた従来の配布検証には dev optimizer 経路が含まれていな
  かった。
