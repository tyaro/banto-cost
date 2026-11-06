# レシピ: RBAC ロールを追加する（admin/editor/viewer に足す正式手順）

> English: [add-role.en.md](add-role.en.md)

作成日: 2026-08-14（feature-review-2026-08.md §2.6 の宿題。
[add-resource.md](add-resource.md) の姉妹編）

対象読者: **テンプレート保守者・AI エージェント（トラックA）**。Banto の
RBAC は `viewer < editor < admin` の3ロール固定（spec M10）で、大半のアプリは
これで足りる。実需で4つ目のロール（例: `auditor` = 監査ログ閲覧専用、
`manager` = editor + ユーザー管理の一部）が必要になったときの唯一の正式手順。

## 前提: まず「本当にロールを足すか」を判断する

ロールは**全経路の認可床に影響する横断的な語彙**（`Role` enum が REST の
`RoleGuard`・Tauri の `require_role`・DB の CHECK 制約・フロントの選択 UI で
共有される）。足す前に次を検討する:

- **既存3ロールの床で表現できないか。** 「特定リソースだけ書ける」程度なら、
  ロールを増やすより該当ルートの `RoleGuard { min }` を調整する方が影響が
  小さい。
- **順序付き（全順序）に収まるか。** `Role::rank()` は全順序（`at_least` が
  それに乗る）。新ロールが「editor と admin の中間」のように既存の間に
  挟まるなら素直に足せる。「editor でも admin でもない横並びの権限」
  （非全順序）は本モデルに載らず、`can_write_resources()` のような**能力述語**を
  増やす設計に切り替える必要がある（その場合は本レシピではなく設計変更＝ADR）。

## チェックリスト（実施順）

`Role` の定義（`crates/banto-admin-services/src/rbac.rs`）を単一の真実源として、
そこから DB・認可床・フロントへ広げる。

| #   | ステップ                                                                                                                                                                                   | 変更箇所                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Role` enum にバリアントを追加し、`as_str` / `rank`（全順序の位置）/ `from_str` / 能力述語（`can_write_resources` 等）を更新。`#[serde(rename_all = "lowercase")]` と `Display` は自動追随 | `crates/banto-admin-services/src/rbac.rs`                                                                                   |
| 2   | DB の CHECK 制約に新ロール文字列を追加する**新しいマイグレーション**を足す（既存 `0004_user_roles.sql` は改変しない。SQLite/Postgres 両方、conventions §11）                               | `apps/admin-template/core/migrations-{sqlite,postgres}/` に連番 SQL 追加                                                    |
| 3   | 認可床の設定: 新ロールで守るべきルート/コマンドの `RoleGuard { min: Role::X }`（REST）と `require_role(state, Role::X, ..)`（Tauri）を**両経路対称**に設定（conventions §1）               | `crates/banto-server/src/routes/*.rs`・`apps/admin-template/core/src/rest/*.rs`・`apps/admin-template/src-tauri/src/lib.rs` |
| 4   | `verify-architecture.mjs` の rule 8 ロール床照合（`DUAL_PATH` の `role` / `ROLE_READ`）を新しい床に追随。新ロールで床が変わる対があれば期待値を更新                                        | `scripts/verify-architecture.mjs`                                                                                           |
| 5   | フロント: ロール選択 UI の選択肢と i18n ロール名キーを追加（`role.<yours>`）                                                                                                               | `apps/admin-template/src/routes/(app)/users/+page.svelte` の `ROLES` 配列・`messages/{ja,en}.json` の `role.*`              |
| 6   | フロント型: `UserRole` union / `provider.ts` の Role 記述に新ロールを追加                                                                                                                  | `packages/admin-core/src/provider.ts` ほかの Role 型                                                                        |
| 7   | **両経路の認可対称テスト**: 新ロールが「床を満たすルートで成功・満たさないルートで 403 + denied 記録」を REST/Tauri 双方で（conventions §1）。RBAC の順序テスト（`at_least`）も更新        | `crates/banto-admin-services/src/rbac.rs` の `#[cfg(test)]`・`apps/admin-template/core/src/rest/tests.rs`                   |

## 検証

```bash
pnpm check                 # フロント lint/型（ロール union の網羅性）
pnpm verify:architecture   # rule 8 のロール床照合
cargo test                 # rbac の順序テスト + REST の認可テスト
```

`src-tauri` はサンドボックスでコンパイルできないことがある（AGENTS.md）。
その場合ステップ3の Tauri 側はコードレビュー + 週次 Tauri CI で担保し、
完了報告に「未実行の検証」として明記する（AGENTS.md「Definition of Done」）。

## やってはいけないこと

- 片方の経路（REST or Tauri）だけに新ロールの床を設定する（conventions §1）。
- 既存マイグレーション `0004_user_roles.sql` を書き換えて CHECK 制約を変える
  （適用済み DB と食い違う。必ず新しい連番マイグレーションで足す。conventions §11）。
- 非全順序の権限を無理に `rank()` へ押し込む（前提の判断に戻る。設計変更なら ADR）。
- 認証設定の `disabled_role`（`SettingsService.AuthSettings`）が新ロールと
  整合するか未確認のまま出す（`Role` を参照しているため影響する）。
