# ADR-0011: 配布は git タグ参照とし npm/crates.io 公開は保留する

> English: [0011-git-tag-distribution.en.md](0011-git-tag-distribution.en.md)

- 状態: Accepted
- 日付: 2026-08-26
- 関連: [publishing.md](../publishing.md)、[ADR-0002](0002-minimal-dependencies.md)、
  [ADR-0007](0007-derived-app-dev-optimizer-exclude.md)、
  [template-scope.md §3.1](../template-scope.md#31-今後の機能拡張の提供形態2026-07-15-決定)、
  [history/industrial-plan.md §2](../history/industrial-plan.md)

## コンテキスト

配布方式は publishing.md（2026-07-12、M18 Phase C）で「npm も Rust も git
タグ参照 + `path:` 依存」と決定済みで、2026-07-13 に別リポジトリ
（banto-industrial）が本リポジトリの `v0.1.1` を実際に消費し、
`pnpm install` / `cargo check` / `cargo test --workspace` が通ることまで
検証済みである。

一方、当時の非公開判断の根拠づけには揺れがあった。crates.io を発行しない
理由として publishing.md は「私設配布・権利留保の方針
（industrial-plan.md §2）」を引用していたが、industrial-plan.md §2 は
2026-07-12 に「banto は public + MIT とし、防衛線は非公開の
banto-industrial 側に一本化する」へ改訂済みで、**banto 自体を私設・権利
留保にする理由は同時期に失効していた**。つまり industrial-plan.md の
「banto は公開する方が働く」という現行方針と、publishing.md が引用する
非公開理由が矛盾したまま残っていた。

この矛盾を解消し、レジストリ非公開という判断自体は今も有効な別の理由
（消費者数・スコープ制約・保守コスト）で支えられていることを ADR として
明文化する。

## 決定

npm / crates.io のレジストリへは公開せず、**git タグ参照**
（npm は git URL + `path:` 指定、cargo は `git` + `tag` + パッケージ指定）を
正式な配布経路とする。テンプレート本体の主配布経路は引き続き GitHub の
「Use this template」（コピー型）であり、これは変更しない。

## 検討した代替案

- **案A（採用）: git タグ依存。** 消費者は現状 banto-industrial の1件のみで、
  リリースパイプライン・公開手順の保守コストがゼロ。GitHub organization
  `banto` が取得不能という `@banto` npm スコープの実務問題を回避できる
  （経緯は history/publishing-github-packages-2026-07.md）。ソース配布方針
  （[ADR-0007](0007-derived-app-dev-optimizer-exclude.md)）とも整合する。
- **案B（不採用）: npm + crates.io へ正式公開。** 利点は発見面と semver
  range 解決だが、前者は「外部採用者の獲得を能動目標とするか」という
  別の決定が先に要る（未決）。後者は複数消費者という実需がまだ無い。
  加えて `@banto` スコープの改名（`@tyaro/*` 等）を強いられ、影響範囲が
  `admin-template` の全 import に及ぶ（history 文書 §「`@banto` スコープと
  GitHub Packages の制約」参照）。
- **案C（不採用・検証済み）: GitHub Packages。** 2026-07 に実装検証まで
  行った上で棚上げした。消費側に `.npmrc` + `GITHUB_TOKEN`（`read:packages`）
  の認証設定が必須になり、git 依存に対して摩擦が大きい割に得るものが
  少ない（経緯は history/publishing-github-packages-2026-07.md）。
- **案D（不採用）: giget/degit 型のテンプレート取得ツール。** コピー型の
  主経路（GitHub「Use this template」+ `rename.mjs`）で既に摩擦が低く、
  取得ツールを追加導入する価値がない。

## 帰結

- publishing.md の crates.io 非公開理由から「私設配布・権利留保」の引用を
  外し、本 ADR への参照に置き換える（本 PR で実施）。GitHub Packages 棚上げ
  節の再検討条件も本 ADR に統合する。
- **再検討条件**（いずれか1つでも満たしたら再検討する）:
  1. 外部消費者が複数件になり、semver range 解決が実際に必要になったとき。
  2. 「外部採用者の獲得」を能動目標とする決定がなされ、レジストリでの
     発見面が必要になったとき。
  3. `@banto` 相当のスコープ改名（例: `@tyaro/*`）を許容する判断をしたとき。

  GitHub Packages の棚上げ条件（publishing.md 旧記載）はこの3条件に統合し、
  以後は本 ADR の再検討条件のみを参照する。

- 本 ADR は
  [roadmap.md §3](../roadmap.md#3-v2--将来構想バックログ)（本 PR で追加）の
  「外部採用者のみを発火源とするトリガの12ヶ月時限」という一般則の対象で
  もある。上記の再検討条件は同時限のもとで評価する。
