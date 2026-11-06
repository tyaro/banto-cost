# ADR-0028: 業務の権限をロールとは別に能力と案件範囲で判定し、判定と拒否の監査を一つの関数に集める

> English: [0028-capability-project-scope-authz.en.md](0028-capability-project-scope-authz.en.md)

- 状態: Accepted
- 日付: 2026-11-06
- 関連: [conventions.md §1・§2](../conventions.md)、[recipes/add-role.md](../recipes/add-role.md)「前提」、[docs/project/design.md](../project/design.md) 第2章、[docs/project/spec.md](../project/spec.md) 第4章・受入条件 T12/T19/T20、ADR-0001

## コンテキスト

banto-cost（Banto v6.10.0 から派生した案件原価・利益管理アプリ）では、入力担当者・営業担当者・案件責任者・経理担当者・経営者・システム管理者が兼務しながら使う。必要な権限は次のように横並びで、全順序にならない。

- 経理担当者は時間原価単価を見られるが、利用者管理はしない。
- システム管理者は利用者・権限・マスタを管理するが、金額・単価は別に付与されない限り見ない。
- 案件責任者は担当案件だけの売上・原価・利益を見て承認する。担当外の案件は見えない。

Banto の `Role`（viewer < editor < admin）は全順序で、`add-role.md` も「横並びの権限はロール追加ではなく能力述語を増やす設計変更（ADR）」としている。さらに仕様は、画面・API・CSV・検索結果・明細の直接URLのすべてに同じ権限を適用すること（T12）、自己承認の禁止（例外は履歴に残す）、会社用の所属と権限は明示的に付与し個人用アプリなど他の権限を引き継がないこと（T19/T20）を求めている。

## 決定

1. **ロールはアプリ全体の床として残し、業務の権限は能力（capability）と案件範囲で別に持つ。**
   - 能力: `time.entry` / `pipeline.edit` / `project.manage` / `finance.rate` / `finance.close` / `report.all` / `amount.view`。`user_capabilities`（マイグレーション `0009_authz.sql`）に利用者ごとに複数付与する。
   - 案件範囲: `project_members`（案件・利用者・担当種別 `sales` / `manager` / `worker`）。
2. **判定は純粋関数 `banto_admin_services::authz::authorize(subject, operation, policy)` 一つに集める。** 一覧・検索・CSV の絞り込みは同じ規則から作る `visible_projects` / `amount_projects` を使い、明細で拒否される行が一覧に出ないようにする。自己承認は `Policy.allow_self_approval` が無い限り拒否し、例外で通したときは `Allowed.self_approval_exception` で呼び出し側に監査を求める。
3. **会社データへの所属は、この DB での能力の明示付与だけで決まる。** ロール（admin でも）、grant セッション（利用者行が無い）、認証無効モードの合成セッション、他アプリの利用者からは何も導出しない。案件メンバーの行だけがあっても所属にならない。
4. **REST と Tauri は共通のガード `AuthzService::authorize_audited` を呼ぶ。** 判定と拒否の監査（`action: "denied"`、`detail` に操作・理由・案件）を同じ関数が行い、経路の差は `origin` だけにする。ロール床（`RoleGuard` / `require_role`）はこれまで通り先に通し、`verify-architecture.mjs` rule 8 で両経路の床を照合する。
5. 利用者の行 ID は REST ではセッションの `SessionStamp.account_id`（無ければ username で引く）、Tauri では `DesktopSession::Account` の `id` を使う。username だけで他の行の付与を引き継がない。

## 検討した代替案

- **案A（採用）: ロールの床 + 能力 + 案件範囲。判定と拒否の監査を `banto-admin-services` の一つの関数に置く。** 利点: 横並びの権限と案件単位の範囲を表せる。判定が一か所なので REST・Tauri・CSV・検索でずれない。拒否の監査形状も一か所で決まる。欠点: conventions §2「サービス層は actor / RBAC を知らない」からの逸脱になる（下の帰結）。
- **案B（不採用）: ロールを増やす（`accountant`・`manager` など）。** 全順序の `rank()` に載らない。兼務を表すには組み合わせのロールが増え続ける。案件単位の範囲は表せない。
- **案C（不採用）: 判定を REST と Tauri の配線層にそれぞれ書く（Banto の `RoleGuard` / `require_role` と同じ形）。** ロール床は1つの値の比較なので二重実装でもずれにくいが、能力 × 案件範囲 × 自己承認は条件が多く、片方だけ直す事故が起きやすい。CSV・検索の絞り込みにも同じ規則が要るため、配線層に置くと三重以上になる。
- **案D（不採用）: 判定を `cost-domain` に置く。** `cost-domain` は計算規則の純粋クレートで、DB・監査を持たない。判定関数そのものは純粋だが、拒否の監査と付与の読み出しを伴うガードは DB 層が要るため、能力の語彙ごと `banto-admin-services` に置いた。

## 帰結

- conventions §2 の例外: `AuthzService::authorize_audited` は actor を受け取り、拒否を監査に記録する。サービス層が tauri / axum / HTTP に依存しない点は守る（`verify:architecture` の service-layer 検査は通る）。ロール床の判定と成功時の監査は引き続き配線層が行う。
- 新しい業務の操作を足すときは、`Operation` に追加して `authorize` に規則を書き、REST と Tauri の両方から `authorize_audited` を通す。一覧・検索・CSV は `visible_projects` / `amount_projects` で絞る。両経路の拒否テストを対で足す（T12）。
- 能力の文字列を変えるときは `Capability` と `0009_authz.sql` の CHECK を新しいマイグレーションで同時に変える（conventions §11）。
- `project_members.project_id` は P3 で案件テーブルができるまで外部キーを持たない。P3 で案件テーブルを作るときに参照の整合を確認する。
- 能力の付与と案件メンバーの割当は admin のロール床とした。案件責任者が自分の案件のメンバーを割り当てる運用が必要になったら、`Operation` に追加して見直す。
