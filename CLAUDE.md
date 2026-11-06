# banto-cost 固有の指針（最優先）

このリポジトリは Banto v6.10.0 から派生した会社向けの案件原価・利益管理アプリ **banto-cost** です。以下は Banto テンプレートの指針より優先します。

- 最初に [README.md](README.md)、[docs/project/spec.md](docs/project/spec.md)（仕様）、[docs/project/design.md](docs/project/design.md)（設計案）を読む。作業状況は git 管理外の `docs/STATUS.md` にあれば読み、作業区切りごとに更新する。
- **実データをコミットしない。** 会社の Excel・CSV・作業報告・口座情報などは `private/` に置くか、リポジトリ外で扱う。文書・テスト・サンプルには架空のデータだけを使い、実在の顧客名・人名・金額を書かない。
- 計算規則は `crates/cost-domain`（純粋な Rust、外部依存なし）に置き、仕様書の受入条件番号をテスト名に付ける。DB・REST・Tauri の層はこのクレートを呼ぶだけにする。
- 金額は円の整数、工数は分の整数。未設定を0円・0%にしない。利益率の分母0は算出不可。
- 年度は6月開始・期番号表示（第13期＝2026年6月〜2027年5月）。
- 時間原価単価などは計算基準として版で管理し、案件ごと・項目ごとに上書きできる（設計案 第10章）。承認済み実績・採用済み見込・承認済み予算を自動で書き換えない。
- 業務の権限は Banto の3ロールに加えて能力（capability）と案件範囲で判定する（設計案 第2章）。REST と Tauri の両経路で同じ判定を通す。
- 利用者へのまとめの報告・質問・判断の依頼は日本語で書く（2026-11-06 ユーザー指示）。
- コミットは日本語の Conventional Commits。整形は `pnpm exec prettier --write <ファイル>` と `cargo fmt --all`。
- Banto の `items`（商品）デモは削除済み（設計案 5.1）。新しいリソースは顧客・案件台帳（`customers` / `projects`）を手本にする。`scripts/scaffold.mjs` の items 除去は適用済みの状態と合わないので使わない。

以下は Banto テンプレートの元の指針です。

---

# CLAUDE.md

このリポジトリの道案内は [AGENTS.md](AGENTS.md) に集約している（ドリフトを避けるため
一本化）。作業を始める前に必ず AGENTS.md を読むこと。

要点だけ再掲:

- ドキュメントは2トラック — **保守者向け = `docs/`**（特に
  [docs/conventions.md](docs/conventions.md) の不変条件）、**アプリ作者向け = [README](README.md)**。
- 破ってはいけない不変条件は [docs/conventions.md](docs/conventions.md) に全文 —
  要約に頼らず必ず本文を読むこと（不変条件は増えることがある）。
- 検証: `pnpm check` / `cargo test` / `pnpm e2e` / `cargo audit`。
  `src-tauri` はこのサンドボックスではコンパイル不可（コードレビューで担保）。
