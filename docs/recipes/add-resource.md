# レシピ: CRUD リソースを追加する（items を手本にする正式手順）

> English: [add-resource.en.md](add-resource.en.md)

作成日: 2026-07-18（improvement-plan-2026-07.md P1-3。spec §14 の
「ルート導出方式」の決着に伴う成果物）

対象読者: **アプリ作者（トラックB）と、テンプレート保守者・AI エージェント
（トラックA）の両方**。新しい CRUD リソース（例: `customers`）を追加する
とき、または同梱デモの `items` を自リソースに差し替えるときの唯一の正式
手順。AI にリソース追加を委譲するときは、本レシピをそのまま指示に使う。

## 方式の決定（2026-07-18）

リソースのページは**動的ルート `[resource]` による自動導出ではなく、
`items` のルート一式をコピーして書き換える**方式を正式な規約とする
（spec §14 の未決事項を決着）。理由: テンプレートの「すべては削除可能・
コピーして理解できる」方針（template-scope §1）と整合し、動的ルート化は
利用者が読み解けない魔法を増やすため。

## チェックリスト（実施順）

Rust 側 → フロント側の順に進める。各ステップの「手本」列のファイルを
コピーして書き換えるのが最短。

| #   | ステップ                                                                                                                                                                                                         | 手本（items の実装）                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | マイグレーション追加（連番 SQL、conventions §11）                                                                                                                                                                | `apps/admin-template/core/migrations-sqlite/0001_items.sql`（+ Postgres 版を `migrations-postgres/` に） |
| 2   | サービス層追加（Clone + BantoError + sqlx、tauri/axum 非依存。`column_map()` でソート/フィルタ列をホワイトリスト化 — conventions §2, §6）                                                                        | `apps/admin-template/core/src/items.rs`                                                                  |
| 3   | REST ルート追加（`RoleGuard` + `record_write` で認可・監査 — conventions §1）                                                                                                                                    | `apps/admin-template/core/src/rest/items.rs`（コピーして `rest/<yours>.rs` を作り `rest/mod.rs` に登録） |
| 4   | Tauri コマンド追加（`require_role` + `audit.record(...)` — REST と**同一の**認可・監査）                                                                                                                         | `apps/admin-template/src-tauri/src/lib.rs` の `items_*` コマンドと `AppState.items`                      |
| 5   | **両経路の認可対称テスト**（許可ロールの成功 + denied の記録、REST/Tauri 双方。読み取り系は監査しない — conventions §1）                                                                                         | `rest/tests.rs` / 各サービスの `#[cfg(test)]`                                                            |
| 6   | 監査イベントの確認（mutating 操作すべてが `record_write`/`audit.record` を通ること。detail に秘密を入れない — conventions §6）                                                                                   | 同上                                                                                                     |
| 7   | フロント: リソース定義 + スキーマ登録（`resources/<yours>.ts` を作り `resources/index.ts` の配列に追加）                                                                                                         | `apps/admin-template/src/lib/banto/resources/items.ts`・同 `resources/index.ts`                          |
| 8   | フロント: ページ・ナビ追加（一覧/詳細/新規のルートをコピー、`navigation.ts` にエントリ。一覧の列はスキーマから `columnsFromSchema` で導出し、手書きは行リンク等のスキーマ外列と `overrides` のみに留める — M23） | `apps/admin-template/src/routes/(app)/items/`・`src/lib/navigation.ts`                                   |
| 9   | （必要なら）ダッシュボードパネル・CSV インポート・E2E スモーク1本                                                                                                                                                | `src/lib/banto/dashboard.ts`・`itemsAdmin.ts`・`e2e/tests/smoke.spec.ts`                                 |

ブラウザ単体デモ（InMemory）にも出したい場合は
`src/lib/banto/sampleData.ts` に生成データを足す（任意。デモに出さない
機能は conventions §10 の「demo は明示拒否」に従う）。

## items の関与ファイル全量（層別）

`items`（商品）は「一覧・詳細・新規作成・CSVインポート/エクスポート・
ダッシュボード集計」を貫通させたお手本として同梱している
（[template-scope.md §3](../template-scope.md)）。上のチェックリストの「手本」列を
層別に展開した全量は以下のとおり（差し替え・削除の対象もこの表）。

| 層                       | ファイル                                                                                                                                | 内容                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Rust: マイグレーション   | `apps/admin-template/core/migrations-sqlite/0001_items.sql`（+ `migrations-postgres/0001_items.sql`）                                   | `items` テーブル定義                                                                                   |
| Rust: シード             | `apps/admin-template/core/src/db.rs`（`SEED_ROW_COUNT`・`seed_if_empty`）                                                               | 初回起動時の1,000件デモ投入                                                                            |
| Rust: サービス層         | `apps/admin-template/core/src/items.rs`                                                                                                 | `Item`/`ItemInput`/`ItemImportRow`・CRUD・CSVインポート                                                |
| Rust: REST               | `apps/admin-template/core/src/rest/items.rs`                                                                                            | `items` のルーティング（LANブラウザ向け）                                                              |
| Rust: Tauriコマンド      | `apps/admin-template/src-tauri/src/lib.rs`                                                                                              | `items_list`/`items_get`/`items_create`/`items_update`/`items_delete`/`items_import`、`AppState.items` |
| フロント: リソース定義   | `apps/admin-template/src/lib/banto/resources/items.ts`・同 `resources/index.ts`                                                         | `itemsSchema`/`itemsResource` の定義と `resources` 配列への登録（`setup.ts` が `initBanto` へ渡す）    |
| フロント: デモデータ     | `apps/admin-template/src/lib/banto/sampleData.ts`                                                                                       | ブラウザ単体デモモード（InMemory）用の生成データ                                                       |
| フロント: ページ         | `apps/admin-template/src/routes/(app)/items/`                                                                                           | 一覧（`ItemsClientGrid.svelte`/`ItemsServerGrid.svelte`）・詳細・新規                                  |
| フロント: CSVインポート  | `apps/admin-template/src/lib/banto/itemsAdmin.ts`                                                                                       | バルクインポートAPIクライアント（M15）                                                                 |
| フロント: ナビ           | `apps/admin-template/src/lib/navigation.ts`                                                                                             | `/items` エントリ（`pageTitleResource` と作成・編集の `pageTitles` も差し替える）                      |
| フロント: ダッシュボード | `apps/admin-template/src/lib/banto/dashboard.ts`・`src/lib/components/DashboardPanel.svelte`・`src/routes/(app)/dashboard/+page.svelte` | `items` から集計するスタットタイル/カテゴリ別在庫等のパネル定義                                        |

`admin-template-core`/Tauri/REST の三経路で同一のサービス層を通す構造
（[template-scope.md §2.1](../template-scope.md)）は維持すること。

## `sqlx::migrate!` は同一DBに1クレートまで

`apps/admin-template/core/src/db.rs` はアプリ自身のスキーマを
`sqlx::migrate!("./migrations-sqlite")` /
`sqlx::migrate!("./migrations-postgres")` で適用する。`sqlx` の
マイグレーション管理テーブル（`_sqlx_migrations`）は**データベース全体で
1つ**であり、クレートごとにテーブル名を分ける機能は無い。そのため
`_sqlx_migrations` を内部で使う別クレート（自作の共通クレート等）を
**同一プール**に対して併用すると、バージョン番号が衝突して
`MigrateError::VersionMismatch`/`VersionMissing` で必ず失敗する
（空DBへの初回実行から発生する）。回避策は次のどちらか:

- 併用するクレート側を `sqlx::migrate!` ではなく冪等な DDL
  （`CREATE TABLE IF NOT EXISTS`、列追加は存在確認してから
  `ALTER TABLE`）にする
- アプリ側の `db.rs` を冪等 DDL に寄せ、`sqlx::migrate!` を使うクレートを
  1つに絞る

いずれにせよ「同一プールに対して `sqlx::migrate!` を呼ぶクレートは常に
1つまで」を保つこと（[publishing.md](../publishing.md)「消費実績と消費側の手順」で
実際に踏んだ罠）。

## 一覧の絞り込み・並び順の保持（任意、Issue #215）

一覧 → 詳細 → 保存 → 一覧と往復しても絞り込み・並び順・直前に開いた行を
残したい場合は、`@banto/admin-core` の一覧状態 API を使う（手本は
`routes/(app)/items/+page.svelte` と `items/[id]/+page.svelte`）。

- 一覧ページは生成時に `const scope = currentSessionScope()` を取り、
  `loadListViewState`/`saveListViewState`/`loadLastOpenedId` などすべてに
  渡す。詳細ページは mount 時に `saveLastOpenedId(scope, resource, id)`、
  保存成功時に `noteLastEditedRecord(scope, …)` を呼ぶ（保存開始前に取った
  `scope` を渡す。保存中にセッションが変わると書かれない）。
- 状態は所有者（ログイン中のアカウント／公開閲覧者）付きで保存され、確定した
  今の所有者にしか復元されない。セッションの確定は SessionController（v2.0.0、
  tyaro/banto#260・ADR-0016）が 1 か所で行い、前提の配線はテンプレートに入っている:
  `(app)/+layout.ts` の `load` が `resolveSettled(getSessionController())` で確認し
  （`none` なら `grantFallback`）、確認できた generation を返す／
  `(app)/+layout.svelte` が世代の変化で再 load してページを作り直す（配線①）／
  `#lib/session.svelte.ts` の `sessionStore` は `controller.snapshot` からの `$derived`／
  ログアウトは `logout()` の後に `resolveSettled()` で確定する（`#lib/banto/logout.svelte.ts`）。
  自前の `AuthProvider` は `resolve()`・`credentialRevision()`・`onCredentialChanged()` を
  実装する（`resolve()` は取得できないときに reject する — `provider.ts` の契約）。
  これを外すと、一覧状態は保存も復元もされないか（所有者が確定しない）、
  セッションが変わっても前の画面が残る（作り直しなし）。

セッション管理の設計は [session-controller-design.md](../design/session-controller-design.md) §6.1。

## 検証

```bash
pnpm check     # フロント lint/型
cargo test     # サービス層 + REST のテスト（:memory: SQLite）
pnpm e2e       # スモーク（banto-serve 起動、E2E を足した場合）
```

`src-tauri` はサンドボックス環境ではコンパイルできないことがある
（AGENTS.md）。その場合、ステップ4はコードレビュー + 週次の Tauri CI
（improvement-plan P3-2）で担保し、完了報告に「未実行の検証」として明記
する（AGENTS.md「Definition of Done」）。

## やってはいけないこと（conventions.md の該当節）

- 片方の経路（REST or Tauri）だけにコマンドを足す（§1）
- サービス層に axum/tauri/RBAC を持ち込む（§2）
- フロント由来のフィールド名を `ColumnMap` を通さず SQL に使う（§6）
- 監査 detail にパスワード・トークンを入れる（§6）
- コンポーネント CSS に生の色値を書く（§9）

## items を削除する場合

自リソースへの差し替えが済んだら、上表の「手本」列のファイル一式が
削除対象になる（逆向きに辿ればよい）。`attachments` の items デモ配線を
使っている場合は [remove-optional-assets.md](remove-optional-assets.md) の添付の手順が先。
