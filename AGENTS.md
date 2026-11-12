# banto-cost 固有の指針（最優先）

このリポジトリは Banto v6.10.0 から派生した会社向けの案件原価・利益管理アプリ **banto-cost** です。以下は Banto テンプレートの指針より優先します。

- 最初に [README.md](README.md)、[docs/project/spec.md](docs/project/spec.md)（仕様）、[docs/project/design.md](docs/project/design.md)（設計案）を読む。作業状況は git 管理外の `docs/STATUS.md` にあれば読み、作業区切りごとに更新する。
- **実データをコミットしない。** 会社の Excel・CSV・作業報告・口座情報などは `private/` に置くか、リポジトリ外で扱う。文書・テスト・サンプルには架空のデータだけを使い、実在の顧客名・人名・金額を書かない。
- 計算規則は `crates/cost-domain`（純粋な Rust、外部依存なし）に置き、仕様書の受入条件番号をテスト名に付ける。DB・REST・Tauri の層はこのクレートを呼ぶだけにする。
- 金額は円の整数、工数は分の整数。未設定を0円・0%にしない。利益率の分母0は算出不可。
- 年度は6月開始・期番号表示（第13期＝2026年6月〜2027年5月）。
- 時間原価単価などは計算基準として版で管理し、案件ごと・項目ごとに上書きできる（設計案 第10章）。承認済み実績・採用済み見込・承認済み予算を自動で書き換えない。
- 業務の権限は Banto の3ロールに加えて能力（capability）と案件範囲で判定する（設計案 第2章）。REST と Tauri の両経路で同じ判定を通す。
- コミットは日本語の Conventional Commits。整形は `pnpm exec prettier --write <ファイル>` と `cargo fmt --all`。
- Banto の `items`（商品）デモは削除済み（設計案 5.1）。新しいリソースは顧客・案件台帳（`customers` / `projects`）を手本にする。`scripts/scaffold.mjs` の items 除去は適用済みの状態と合わないので使わない。

以下は Banto テンプレートの元の指針です。

---

# AGENTS.md — Banto で作業する AI エージェント向けの道案内

> English: [AGENTS.en.md](AGENTS.en.md)

Banto（番頭）は **PC1台から始めて、必要に応じて LAN 内へ共有できる業務アプリ開発
テンプレート**（Tauri デスクトップ + LAN ブラウザ配信の二形態で同じ画面・業務処理が動く）。Rust（axum + sqlx。SQLite 既定・PostgreSQL 対応）バックエンドと SvelteKit（Svelte 5 runes）
フロントのモノレポ。利用者はこれをコピーして個別アプリを作る。

このファイルは「どのタスクで何を読むか」の索引。中身の規約は各ドキュメントにある。

## ドキュメントは2トラック

読者が違うので分けている。**自分のタスクがどちらかを最初に見極める。**

- **トラックA（保守者向け）= `docs/`**: テンプレート自体を保守・機能拡張する人向け。
  不変条件・スコープ判定・実装計画・配布規約。
  - [docs/conventions.md](docs/conventions.md) — 変えてはいけない不変条件（**最重要**）
  - [docs/ui-framework-spec.md](docs/ui-framework-spec.md) — 仕様書（`spec §` の参照先）
  - [docs/architecture-overview.md](docs/architecture-overview.md) — 全体構成図（二形態・レイヤ・機能マップ）
  - [docs/roadmap.md](docs/roadmap.md) — マイルストーン計画と §7 実施プロセス
  - [docs/template-scope.md](docs/template-scope.md) — 何を入れる/入れない、削除可能性の判定
  - [docs/publishing.md](docs/publishing.md) — 配布（git tag / `path:` 依存）
  - [docs/design/](docs/design/) — 個別機能の実装計画・設計書（attachments-plan /
    report-plan / visual-refresh-plan・design / display-preset-plan /
    session-controller-design 等。実装完了後もコードが `§` 参照する現役仕様アンカー。
    ファイル名は `<名前>-plan.md` / `-design.md`）
  - [docs/reviews/](docs/reviews/) — **調査・レビュー記録**（棚卸し・機能レビュー・
    保守性レビュー・フィードバック対応の記録。`M-review` / `CR-N` / `AD-N` の定義元。
    ファイル名は `<名前>-review-YYYY-MM.md` 等）:
    [docs/reviews/maintenance-review-2026-10.md](docs/reviews/maintenance-review-2026-10.md)
    （最新のリファクタ要否の判断。やる/保留/やらないと見直しの合図）、
    [docs/reviews/maintenance-review-2026-08.md](docs/reviews/maintenance-review-2026-08.md)
    （前回の棚卸し + 整理統合プラン）、
    [docs/reviews/feature-review-2026-08.md](docs/reviews/feature-review-2026-08.md)（通称
    M-review 2026-08）、
    [docs/reviews/maintainability-review-2026-07.md](docs/reviews/maintainability-review-2026-07.md)
    （CR 番号体系の定義元）、
    [docs/reviews/choiapp-feedback-2026-09.md](docs/reviews/choiapp-feedback-2026-09.md)
    （チョイアプリ・フィードバック対応の記録。シェル固定/設定カテゴリ/
    ナビバッジの `choiapp-feedback-2026-09 §N` 参照の実体）。
    **対応が完了して凍結した文書は [docs/history/](docs/history/) へ移す**
    （移動前にコード被参照を `rg` で確認 — conventions §12 の文法表参照）。
    **寿命のルール**: [docs/history/](docs/history/) の文書と、状態行で「現行の根拠ではない」と明示された文書は
    新規の設計根拠にしない（既存の経緯参照・コード内の `§` 参照は残してよい）。現役のレビュー文書（`CR-N`・
    `AD-N`・`M-review` などで正式に参照される定義元・台帳）はこの対象ではなく、引き続き参照してよい。plan / design 文書は、実装状況が変わる PR で
    冒頭の `状態:` 行（あれば `最終検証日:`）を同時に更新する
- **トラックB（アプリ作者向け）= [README](README.md) + [docs/recipes/](docs/recipes/)**:
  このテンプレートから自分のアプリを作る人向け。README は入口と背骨（コピー →
  リネーム → プリセット選択 → 実装 → 配信）、手順の全量は `docs/recipes/` の各レシピ
  （rename / add-resource / remove-optional-assets / consume-as-git-dependency /
  lan-access / database-backup / windows-setup / no-login-app / scan-wedge /
  notifications / tree-svelte / image-assets / add-role）。

## タスク別の入り口

- **CRUD リソースを追加する / items を差し替える** →
  [docs/recipes/add-resource.md](docs/recipes/add-resource.md)（チェックリスト形式の正式手順）。
- **RBAC ロールを追加する（admin/editor/viewer に足す）** →
  [docs/recipes/add-role.md](docs/recipes/add-role.md)。
- **利用パッケージをアプリへ組み込む**（scan-wedge / 通知トースト / tree-svelte / 画像の取込）→
  [docs/recipes/](docs/recipes/)（README から切り出したトラックB レシピ群）。
- **オプション資産を一括で外す（dock/charts/glass/コマンドパレット/添付/帳票/ツリー）** →
  `pnpm scaffold --preset minimal|standard|full|display`（`--interactive` / `--dry-run`
  あり。手動手順は [docs/recipes/remove-optional-assets.md](docs/recipes/remove-optional-assets.md)）。
  scan-wedge はレシピのみ・未配線のため scaffold は触れない。
- **表示専用アプリ（カンバン/常設ダッシュボード/展示デモ）の初期状態を作る** →
  `pnpm scaffold --preset display`。minimal の削除に加えて items デモ一式・
  users/audit-log **画面**・`/dashboard` を外し、`/monitor` と初回起動シード
  （閲覧公開）・キオスク既定・i18n `raw` を入れる唯一の「足す」プリセット。
  設計は [docs/design/display-preset-plan.md](docs/design/display-preset-plan.md)、利用者向け説明は
  [docs/recipes/remove-optional-assets.md「`--preset display`」](docs/recipes/remove-optional-assets.md#--preset-display表示専用アプリ)。
- **機能を追加/変更する** → まず [docs/conventions.md](docs/conventions.md) の不変条件を
  読み、[template-scope.md §6](docs/template-scope.md#6-今後の運用ルールと宿題) の
  チェックリストで是非を判断。実装計画は `docs/design/*-plan.md` に倣う。
- **バグ修正/リファクタ** → [docs/conventions.md](docs/conventions.md) の該当節を確認
  （特にセキュリティ不変条件・逆依存禁止・両経路対称）。
- **「使い方」を説明する/導入手順を直す** → トラックB（README が入口、手順の全量は
  `docs/recipes/`。LAN 配信・TLS・PWA は
  [docs/recipes/lan-access.md](docs/recipes/lan-access.md)、DB/バックアップは
  [docs/recipes/database-backup.md](docs/recipes/database-backup.md)）。
- **仕様の意図を知りたい** → `docs/ui-framework-spec.md`（doc コメントの `spec §N` が指す先）。
- **全体構成・配信形態・レイヤを一望したい** →
  [docs/architecture-overview.md](docs/architecture-overview.md)。
  認証・初回起動・開発3経路・add-resource の層対応は
  [docs/architecture-flows.md](docs/architecture-flows.md)。
- **設計判断の「なぜ・代替案」を知りたい/残したい** → [docs/adr/](docs/adr/README.md)。
  「なぜ」の置き場は3分類（コードコメント / conventions.md / ADR）。代替案を
  比較して倒した判断は ADR に書く（規約本文は conventions.md、局所理由はコード内）。

## 絶対に破ってはいけない不変条件（詳細は conventions.md）

1. mutating 操作は **REST と Tauri の両経路で同一の認可 + 同一の監査**を通す。
2. **サービス層は tauri/axum/RBAC/HTTP 非依存**（Clone + BantoError + sqlx）。認可・監査は
   wiring 層が付ける。
3. **依存を足さない**（tower-http/multipart/tracing/markdown 等は自前実装。`chrono` は日時の文字列変換のみ
   [ADR-0029](docs/adr/0029-chrono-datetime-formatting.md) の例外）。
   引きたくなったら設計判断として議論。
4. **コア → オプションの逆依存禁止**。オプション同梱時は削除手順を明文化。
5. セキュリティ: MIME はマジックバイト判定・**ファイルパスにユーザー入力を使わない**・
   argon2 の前にスロットル・**監査 detail に秘密を入れない**・SQL 列は ColumnMap
   ホワイトリスト経由のみ・`{@html}` は自前生成の全エスケープ済み出力のみ。
6. UI は `--banto-*` トークンのみ（生値は theme に集約）。**UI 文言もキー経由**
   （conventions §13、CI の raw-jp-in-app 検査対象）。provider 分岐は
   tauri/server/demo の3種で provider 層に閉じる。

## ビルドと検証

```bash
pnpm check          # フロントの型検査（各パッケージ svelte-check / tsc）。
                    # lint は pnpm lint、build は pnpm build が別（CI frontend
                    # ジョブは lint→verify:architecture→verify:migrations→
                    # check:versions→format→check→test→build を順に回す）
cargo test          # Rust ワークスペース全テスト
pnpm e2e            # Playwright スモーク（e2e/playwright.config.ts、banto-serve 起動）
cargo audit         # 依存監査（.cargo/audit.toml の ignore 付き）
```

注意: `src-tauri` はこのサンドボックスでは webkit2gtk 不在によりコンパイル不可。
Tauri コマンド側の変更はコードレビュー + `tauri-check.yml`（Tauri 側/依存
グラフを触る PR と main push、および週次スケジュールで
`cargo check -p admin-template` + `cargo test -p admin-template` を
ubuntu/windows で実行）で担保する。
CI は `.github/workflows/ci.yml` の各ジョブ（frontend（i18n の CDN 遮断検査を含む） / rust /
storage-postgres / app-postgres / e2e / audit）に加えて、週次+トリガ型の
`template-acceptance.yml`（copy→rename→check + scaffold 4プリセットの受け入れ）、
`visual-baselines.yml`（Linux visual ベースライン再生成、dispatch）、
`external-consumer.yml`（外部利用 fixture: `@banto/*`・`banto-*` を Git 依存で導入して
dev 起動・描画・check・build・cargo check。packages/crates を触る PR・タグ・dispatch、
docs/upgrading.md §8。必須チェックではないが、赤なら PR をマージしない）、
`deploy-demo.yml`（GitHub Pages ライブデモ配信）が回る。ジョブの増減は
ci.yml を一次情報とする。

## Definition of Done（委譲タスクの完了報告様式）

変更を完了したら、以下を必ず報告する（roadmap §7 のレビュー工程の入力になる）:

- **触れた不変条件**: conventions.md のどの節に関わる変更か（なければ「なし」）
- **REST / Tauri 双方への影響**: mutating 操作を触った場合、両経路 + denied を
  ペアで実装・テストしたか（conventions §1）
- **追加・更新したテスト**: ファイルとテスト名
- **実行した検証コマンドと結果**: `pnpm check` / `cargo test` / `pnpm e2e` 等
- **実行できなかった検証**: src-tauri のコンパイル等、環境制約で飛ばしたもの
- **ドキュメント更新の有無**: README / docs / CHANGELOG への反映

## 進め方（roadmap §7）

司令塔が設計を固め、タスク分割し、調査/実装を委譲、成果物をレビューして
`pnpm check` / `cargo test` / CI で検証、マイルストーンごとに PR を作成してマージ
（CI ゲート必須）。詳細は [docs/roadmap.md §7](docs/roadmap.md#7-実施プロセス)。
