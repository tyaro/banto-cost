# 会社向け案件原価・利益管理アプリ 設計案（D0）

版：D0 設計案（仕様書0.3に対応）  
作成日：2026年11月6日  
状態：設計のみ。コード・リポジトリは未作成。第8章の未決事項は仕様書の初期案で仮置き。

## 1 調査結果：Bantoの再利用範囲

2026-11-06時点の `tyaro/banto` main（v6.10.0）と、アーカイブ済み `tyaro/banto-business`（個人用、Banto `f471ff1` から派生）を読み取りで確認した。

### 1.1 Banto v6.10.0 にあるもの

| 機能           | Bantoの実装                                                                             | 会社用アプリでの扱い                                                                          |
| -------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 構成           | Tauri v2 + SvelteKit（Svelte 5）+ Rust、SQLite標準・PostgreSQL対応（`BANTO_DB`）        | そのまま採用。複数人利用のためPostgreSQLを本番候補にする                                      |
| 配信           | 組み込みWebサーバ（REST + SSE）でLANブラウザに同じ画面を配信。TLSはリバースプロキシ終端 | 社内LANのブラウザ利用を主経路にする                                                           |
| 認証           | argon2id、初回セットアップ、セッション失効（ADR-0014）                                  | 採用。ログイン不要モードは会社用では使わない                                                  |
| RBAC           | `viewer < editor < admin` の全順序3ロール。`add-role.md` で追加手順あり                 | **不足**。仕様の役割は全順序でない（第2.2節）                                                 |
| 監査ログ       | 書込操作を `record_write` / `audit.record` で記録（M14、ADR-0019）                      | 採用。変更前後の値は業務テーブル側の履歴で別に持つ                                            |
| データグリッド | 仮想スクロール、列フィルタ、グルーピング＋集計、セル編集                                | 一覧・工数入力・明細入力に採用                                                                |
| フォーム       | スキーマ駆動（`@banto/forms`）、`columnsFromSchema`                                     | 採用                                                                                          |
| チャート       | SVG 14種（棒・積立・ガント等）                                                          | 月次見通し・予算実績比較に採用                                                                |
| 帳票・添付     | `@banto/report`、`banto-attachments`                                                    | 帳票は後回し。添付は証憑参照で検討                                                            |
| 両経路対称     | REST と Tauri で同じ認可・監査（ADR-0001、`verify-architecture`）                       | 規約として維持                                                                                |
| 追加手順       | `add-resource.md`（9ステップ）、`items` をコピーして書き換える方式                      | 案件・工数等の各リソースをこの手順で作る。`items` デモは削除済み（5.1）。手本は顧客・案件台帳 |

### 1.2 banto-business（個人用）から参考にできる設計

コードとデータは取り込まない（仕様書2.3）。次の設計判断だけ参考にする。

- 金額は円の `INTEGER`（税抜）で保持する規約。
- 原価レートを工数記録へスナップショット保存する（`work_logs.applied_rate`）。仕様6.2の「承認時に適用単価を保存」と同じ考え方。
- 税計算・端数処理の整理（`docs/tax-calculation.md`）。

個人用は「顧客→案件→工数/経費→請求→入金」が中心で、確度つきの営業見込、予算版、完了見込版、承認・締め、複数ユーザーの権限がない。会社用の中核は新規設計になる。

### 1.3 推奨構成

1. **新規リポジトリ**（仮称 `tyaro/banto-cost`）に Banto v6.10.0 をコピーし、`rename.mjs` と `scaffold --preset standard` で開始する。
   - 個人用 banto-business の派生ではなく、Banto 本体から派生する。個人用データとの混入（T19/T20）を構造的に防ぐ。
   - `@banto/*` を git タグ依存で使う方式（`consume-as-git-dependency.md`）も候補。テンプレート部分の更新を追いやすいが、初期の手数は増える。どちらにするかはリポジトリ作成時に決める。
2. DBは開発・社内運用とも SQLite（2026-11-06 ユーザー決定：小さい会社で操作するのは1人、ほかのDBを入れない）。PostgreSQL 版のマイグレーションは Banto規約§11 に合わせて同名で保つが、検証の主対象は SQLite とする。
3. 計算ロジックは Rust の純粋なドメインクレート（仮称 `cost-domain`）にまとめる。tauri / axum / sqlx に依存させず、受入条件の計算（T02, T05, T06, T21, T27, T28 など）を単体テストで固定する。

## 2 権限モデル

### 2.1 仕様の役割

入力担当者、営業担当者、案件責任者、経理担当者、経営者・管理者、システム管理者。兼務あり。

### 2.2 Banto RBACとの差

Bantoの3ロールは全順序で、「経理は単価を見られるが利用者管理はしない」「システム管理者は利用者管理をするが金額は見ない」のような横並びの権限を表せない。`add-role.md` も、この場合はロール追加ではなく**能力述語を増やす設計変更**が必要としている。

### 2.3 設計案

- Banto の `Role` はアプリ全体の床として残す（viewer＝ログイン可、editor＝業務入力可、admin＝システム管理）。
- 業務の権限は **能力（capability）** として別テーブルに持ち、利用者に複数付与する。

| 能力             | 主な内容                                         |
| ---------------- | ------------------------------------------------ |
| `time.entry`     | 自分の工数・経費を入力・申請                     |
| `pipeline.edit`  | 担当営業案件の見込を更新・採用                   |
| `project.manage` | 担当案件の予算案・残見込・承認                   |
| `finance.rate`   | 時間原価単価の閲覧・登録                         |
| `finance.close`  | 売上計上・費用確認・月次締め・訂正承認           |
| `report.all`     | 全案件の集計と明細の閲覧                         |
| `amount.view`    | 金額の閲覧（システム管理者には既定で付与しない） |

- 案件単位の範囲は `project_members`（案件・利用者・担当種別）で決める。サービス層の一つの関数で「能力 × 案件範囲」を判定し、REST・Tauri・CSV・検索・詳細URLのすべてが同じ関数を通る（T12）。
- 自己承認は判定関数で禁止する。例外設定は監査ログに残す。
- この拡張は Banto の RBAC 規約からの逸脱になるため、派生アプリ側の ADR に記録する。

### 2.4 実装（P2、2026-11-06）

[ADR-0028](../adr/0028-capability-project-scope-authz.md) に判断と代替案を記録した。

- 判定関数：`crates/banto-admin-services/src/authz.rs` の `authorize`。一覧・検索・CSV の絞り込みは同じ規則から作る `visible_projects` / `amount_projects`。
- 会社データへの所属は、この DB での能力の明示付与だけで決まる。admin ロールでも能力が無ければ業務データを見られない。grant セッションと認証無効モードの合成セッションは所属を持たない（T19/T20）。
- 判定の既定：担当種別 `worker` は案件の基本情報と自分の工数入力だけで、金額は見ない。金額は `amount.view` に加えて、`manager`・`sales` の担当か、`report.all`・`finance.close` が要る。個人別単価は `finance.rate` だけ。
- テーブル：`user_capabilities`・`project_members`（マイグレーション `0009_authz.sql`、SQLite / Postgres）。`project_members.project_id` は外部キーを持たない（SQLite では既存の表に後から外部キーを足せないため）。代わりに `AuthzService::add_project_member` が案件の存在を確かめる（P3a）。
- 操作：`GET /api/authz/me`、`GET・PUT /api/users/{id}/capabilities`（admin）、`GET /api/projects/{id}/members`（admin か案件範囲）、`PUT・DELETE /api/projects/{id}/members/{userId}/{kind}`（admin）。Tauri は `authz_*`・`project_members_*`。画面は P3 で作る。
- P3b で操作 `EditOrder` を足した（受注転換・受注変更の登録・売上予定の組み替え）。範囲は `EditProject` と同じ（担当営業の `pipeline.edit` か責任者の `project.manage`）で、加えて `amount.view` が要る。
- P4a で計算基準の操作を足した（10.8）。`ViewCalcBasis`（会社基準の閲覧：`amount.view` に加えて `finance.rate`・`finance.close`・`report.all`・`project.manage` のどれか）、`EditCalcBasis`（会社基準の変更：`amount.view`＋項目ごとの変更権限）、`OverrideCalcBasis`（案件の上書き：`amount.view`＋項目の変更権限、または項目が許す場合はその案件の責任者の `project.manage`）。案件の適用値の閲覧は `ViewProjectAmounts`。
- 自己承認（2026-11-06 ユーザー決定）：操作するのは1人なので、承認は依頼者本人でもよい（仕様第4章の小規模例外）。会社の承認方針 `approval::APPROVAL_POLICY` に一本化し（P4b。P3b の `orders::ORDER_CHANGE_POLICY` を置き換え）、受注変更と工数の承認で REST と Tauri の両経路に同じ値を渡す。直接費の承認も同じ値を使う。使ったときは監査ログの詳細に `selfApproval: true` を残す。判定関数の既定（自己承認の禁止）は変えない。
- 一括承認・申請して承認（P8b、レビュー §8-3）：承認一覧の「表示中をすべて承認」と工数入力の「申請して承認」は、既存の申請・承認の操作を1件ずつ順に呼ぶだけで、新しい承認の流れや一括の API は作らない（認可・締め・監査は1件ずつと同じ）。工数の一括承認と週の「申請して承認」は単価未登録の行を含めない。「申請して承認」は、自分の工数の応答の下書き・差戻しの行に付く `canApprove`（承認と同じ `authorize(approve_op, APPROVAL_POLICY)`、`time_access::shown_own`）が真のときだけ出す。
- P4c で予算版の操作を足した。下書きは `ManageProject`（`amount.view` も要求するよう変えた。それまで使っていなかった）、承認は `ApproveBudget`（`Approve`＋`amount.view`、`APPROVAL_POLICY`）。
- P5 で完了見込の採用 `AdoptForecast` を足した（`ApproveBudget` と同じ範囲＋`amount.view`、`APPROVAL_POLICY`）。下書きは `ManageProject`。
- P6a で精算完了 `SettleProject` を足した（`amount.view` に加えて、その案件の責任者の `project.manage` か `finance.close`（全案件）。2026-11-07 ユーザー決定で案件責任者にも許可）。精算完了の取消（再開）も同じ `SettleProject` で判定する。残額の解消の承認者は実施者（操作するのは1人）。
- P4b で工数の操作を足した。案件の工数入力は `EnterTime`（`time.entry`＋案件のメンバー）、共通活動は `EnterCommonTime`（`time.entry` だけ）。承認は案件なら `Approve`（その案件の責任者の `project.manage` か `finance.close`）、共通活動は `ApproveCommon`（`finance.close`）。承認一覧の範囲は `approval_projects`。工数1件の単価・労務原価は個人の単価が分かるので `sees_record_costs`（`finance.rate`＋`amount.view`）だけに見せ、案件責任者には案件の集計（`ViewProjectAmounts`）だけを見せる。

### 2.5 1人で使う間のログイン（2026-11-12 ユーザー決定・実装）

基本は1人で使う。ユーザーを追加して分けたときだけログインを求める。

- デスクトップ版は、起動時にアカウントが1件だけならその本人としてログインする（パスワードを聞かない。監査に `login`・`via: "sole_user"`）。2件以上なら従来どおりログイン画面。判定は `admin_template_core::sole_user::sole_account`、起動処理は `src-tauri` の `run()`（ログイン不要モード・自動ログインが先、その後に1人の判定）。
- 1人の間はヘッダーとコマンドパレットのログアウトを出さない（Tauri `auth_sole_user`、画面は `soleUser.svelte.ts`）。2人目を作ると出し、次の起動からログインが要ることを知らせる。
- LAN のブラウザ（REST）は対象外で、常にログインが要る。
- 初回の設定画面は残す（ユーザー名・表示名・パスワード）。パスワードは2人目を追加した後のログインで使う。
- 初回の設定で作った管理者には能力をすべて付ける（`sole_user::grant_initial_capabilities`、監査に `update`・`capabilities`・`reason: "setup"`）。REST は `rest::first_setup` のミドルウェア（共通の `extra_auth_router` の外側）、Tauri は `setup_body`。既に能力がある利用者には付けない。
- Banto のログイン不要モード（認証無効）は、所属を持たない合成セッションで業務の能力がないため（2.4、T20）、この目的には使わない。

## 3 データモデル案

金額は円の `INTEGER`（税抜）、工数は分の `INTEGER`。確度は `0〜99` の整数パーセント（受注済みは状態で表す）。不明は `NULL` で持ち、0円・0%に置き換えない。

### 3.1 案件と営業見込

```
customers(id, name, active, …)
projects(id, code, name, customer_id, manager_user_id, status,
         planned_start, planned_end, order_no, department, note,
         row_version, created_at, updated_at)
  status: lead | quoting | negotiating | ordered | in_progress
          | work_done | settled | lost | cancelled | on_hold

pipeline_versions(id, project_id, version_no, kind{draft|adopted},
         expected_amount NULL, stage, probability_pct NULL,
         expected_order_month NULL, expected_start_month NULL, expected_end_month NULL,
         basis, next_action, confirmed_on, est_cost_at_order NULL,
         is_scope{whole|partial|addition}, parent_project_id NULL,
         created_by, created_at)
pipeline_revenue_plan(pipeline_version_id, month NULL, amount)   -- month NULL = 時期未定
quotes(id, project_id, version_no, amount, is_selected, note, …)
```

- 集計対象は「案件ごとの最新 `adopted` 版」一つ（T22）。
- `pipeline_revenue_plan` の合計は `expected_amount` と一致させる（不一致は不足ありで表示）。

#### 3.1.1 実装（P3a、2026-11-06）

- マイグレーション `0010_projects.sql`（SQLite / Postgres）：`customers`・`projects`・`pipeline_versions`・`pipeline_revenue_plan`。`quotes`・`is_scope`・`parent_project_id` は部分受注・追加見込を扱う P3b で足す。
- 顧客は削除せず `active` で使用中止にする。使用中止の顧客は新しい案件には選べないが、既に使っている案件ではそのまま残る。
- 案件の責任者 `manager_user_id` は必須とし、同じトランザクションで `project_members` の `manager` 行も更新する（認可はこの表を読む。ADR-0028）。営業担当（`pipeline.edit`）が登録した案件では、登録者を `sales` メンバーにする。
- 責任者の選択（2026-11-08）：業務用の利用者一覧 `GET /api/user-names`（Tauri `user_names_list`）が全アカウントの ID と表示名だけを返す（ログイン名・ロール・日時は返さない）。判定は顧客と同じ `ViewMasters`（会社の能力を持つ人）か `admin` ロール。案件の責任者と月額固定原価の社員はこの一覧から選び、表示名が重なるときは `#ID` を添える。能力がない・デモモードではユーザーID入力に戻る。
- 案件の状態は、編集画面では受注前の状態（引合・見積中・交渉中）と失注・中止・保留だけを選べる。受注済みの側（受注・進行中・作業完了・精算完了）へは P3b の受注転換で移す。受注後は予定開始日・完了日を必須にする（`cost_domain::project::validate_project`）。
- 案件見込の版は保存後に書き換えない。変更は新しい版にし、下書きを採用するときは根拠を必須にする（T29）。版に記録できる営業段階は引合・見積中・交渉中・内示ありだけで、失注・中止・保留・受注は案件の状態で表す（集計段階は `ProjectStatus::pipeline_stage`、T24）。受注済みの案件には版を記録しない。
- 不足あり：金額・確度・受注予定月の未設定、売上予定なし、売上予定の合計と見込受注額の不一致、採用版なし。いずれも0円・0%に置き換えず、案件見込一覧に表示する（T25）。
- 案件見込一覧（`GET /api/pipeline/overview`）は `amount_projects` の範囲だけを返す。受注予定月別（`pipeline::by_order_month`）と売上予定月別（`outlook::monthly_outlook` の未受注の売上見込）を分けて返し、足し合わせない。
- 同時編集：顧客と案件は `row_version` で楽観ロックし、古い版での更新は `rowVersion` の入力エラーで拒否する（T13）。Postgres では版番号の採番を案件行の `FOR UPDATE` で直列化する。

### 3.2 受注・売上

```
order_conversions(id, source_pipeline_version_id, project_id, converted_on,
         confirmed_amount, scope{whole|partial}, remainder_project_id NULL, basis, …)
order_changes(id, project_id, version_no, delta_amount, status{pending|approved},
         basis, approved_by, approved_at)        -- pending = 未確定追加売上
revenue_plan(id, project_id, month NULL, amount, row_version)      -- 受注済みの売上予定
revenue_recognitions(id, project_id, recognized_on, amount, basis,
         approved_by, approved_at, corrects_id NULL, revenue_plan_id NULL)
```

- 確定受注額 ＝ 受注転換額 ＋ 承認済み受注変更の合計。
- 未計上残 ＝ 確定受注額 − 計上済み合計。`revenue_plan` の合計と一致を検査（マイナス残は不整合）。

#### 3.2.1 実装（P3b、2026-11-06）

- マイグレーション `0011_orders.sql`（SQLite / Postgres）：`order_conversions`・`order_changes`・`revenue_plan`・`revenue_recognitions`・`revenue_clearings`・`outlook_snapshots`・`outlook_snapshot_rows`。`projects` に `parent_project_id`（一部受注の残りの元）と `revenue_version` を足した。設計案の `quotes` は使っていない（見積の版は案件見込の版で足りている）。
- 計算規則は `cost_domain::order`（転換の検査・確定受注額・未確定追加売上）と `cost_domain::revenue`（`replan`・`apply_change`・`auto_clear`・`with_sale`・`without_sale`。いずれも結果を `OrderedRevenue::check` に通す）。サービスは `admin_template_core::orders`。
- 受注転換（T23）：受注前で有効な状態（引合・見積中・交渉中・保留）だけ。同じ案件を `ordered` にし、受注日・確定受注額・根拠・予定開始日と完了日・売上予定（合計＝確定受注額）を記録する。案件見込の版は書き換えず、転換前の状態と直前の採用版を `order_conversions` に残す。売上は計上しない。案件の `row_version` で楽観ロックする。
- 一部受注（T24）：受注分は元の案件、残りは新しい受注前の案件（`parent_project_id`、元の担当営業・責任者を引き継ぐ）にし、その案件見込を採用版1として同じトランザクションで記録する。受注分は未受注見込に残らない。
- 受注済みの案件は案件の編集画面からは受注前の状態へ戻せない（誤った受注転換の取消は 3.2.2）。案件の編集画面では受注・進行中・作業完了の間だけ動かせる（`ProjectStatus::can_edit_to`）。精算完了は T17 の検査（P6a、3.5.1）で扱い、精算完了の案件には受注変更・売上予定の組み替え・売上の計上と取消を記録しない。
- 受注変更：差額・売上予定の月（または時期未定）・根拠で登録し、承認までは未確定追加売上（確定受注額に含めない）。承認で確定受注額と指定月の売上予定に加える。減額で予定や未計上残がマイナスになる承認は拒否する。却下は理由必須で、どちらも履歴に残る。
- 売上予定の組み替え：未計上の額だけを月（または時期未定）に配り直す。合計は未計上残に一致させ、消込済みの行は残す。
- 売上計上（T26）：`finance.close` が記録する。計上月の予定 → それより前の月 → 後の月 → 時期未定の順に自動で消し込む。受注額の超過・消し込み不足は拒否し、0円に丸めない。誤りは理由をつけて取り消し（行と消し込みは履歴に残す）、予定は未消込に戻る。
- 同時更新：受注・売上への書き込みはすべて `projects.revenue_version` の比較更新から始め、同じ状態を見た二人が両方とも検査を通ることを防ぐ（T13）。案件の編集フォームの `row_version` とは分けた。
- 月次見通し（T27、`GET /api/outlook`）：案件ごとに `outlook::monthly_outlook` で計上済み・受注済み予定（未消込分）・未受注×確度を求めて足し、三つの内訳と合計を返す。時期未定は独立の行で月の合計に入れない。未確定追加売上は別の列で合計に入れない。範囲は `amount_projects`。
- スナップショット：`report.all` が全案件の見通しを案件×月の行で保存する。後の受注転換・計上で変わらない。表示・比較（前回差異）は呼び出した人の `amount_projects` の行だけ。

#### 3.2.2 受注転換の取消（P8f、2026-11-13、レビュー U-3・§8-14、T40）

- 案件の取り違えなど、受注転換の誤りを直すための操作。受注後の業務がまだ始まっていない転換だけを、理由をつけて取り消す。精算完了の取消・月次締めの再開と同じく、記録は書き換えず履歴に残す。
- 取り消せる条件（`cost_domain::order::check_conversion_cancel`）：案件の状態が「受注」（進行中・作業完了・精算完了でない）、転換前の状態が受注前の有効な状態か保留、一部受注なら残りの範囲の案件がまだ受注転換されていない（受注前・保留・失注・中止）。かつ、その案件に受注変更・売上計上（取消済みを含む。消し込みの履歴が売上予定を参照するため）・予算版・工数・直接費（発注・配分を含む）・完了見込版・月額固定（取り決め・計上）・定期売上の取り決めがない。満たさない理由は `OrderSummary.cancelBlockers` に符号で返し、画面は取消欄にその一覧を出す。
- 一部受注の取消（2026-11-13 ユーザー決定、範囲・金額の入力誤りを直すため）：元の案件を転換前の状態に戻すと採用版（転換前の全体の見込額）が未受注の集計に戻るので、残りの範囲の案件を同じトランザクションで「中止」にする（`ProjectStatus::remainder_closed_to`。失注・中止ならそのまま）。残りの案件は削除せず、版・親案件・履歴は残る。これで見込は二重にならない。残りの案件が受注転換済みなら取り消さない（`remainder_ordered`）。
- 取消（`OrdersService::cancel_conversion`、`POST /api/projects/{id}/order/conversion/cancel`・Tauri `order_conversion_cancel`、`EditOrder`）：案件の状態を転換前に戻し、転換が作った売上予定（`revenue_plan`、計上がないので消し込みもない）を削除し、`order_conversions` の行に取消日（業務日付）・理由・実施者・時刻を記録する。予定開始日・完了日・注文番号は入力のまま残す。案件見込の版は転換で書き換えていないので、採用版がふたたび未受注の集計に入る（T23 の逆）。
- 同時更新：案件の `row_version` と `revenue_version` の両方で比較更新する。案件の行を書いたあと、同じトランザクションで記録の有無を数え直す（SQLite ではその書き込みでデータベースの書き込み錠を取るので、検査のあとに記録が割り込まない。T13）。Postgres（READ COMMITTED）では、工数・直接費などを書く側が案件の行を錠で押さえないので、取消の検査と同時に別のトランザクションが記録を足すと両方が通りうる。利用者1人・SQLite の運用（2026-11-06 決定、レビュー §8「Postgres 側の作り込みはやらない」）なので対策していない。PC に不慣れな利用者が主な対象で Postgres を入れられないため、Postgres は将来対応とする（2026-11-13 ユーザー決定）。2人目や Postgres で使う前に、記録を書く操作と取消が同じ案件単位の錠（案件の行の `FOR SHARE`／`FOR UPDATE` など）を取るようにする（PR #46 のレビュー指摘）。
- マイグレーション `0025_order_conversion_cancel.sql`：`order_conversions` に `cancelled_on`・`cancel_reason`・`cancelled_by`・`cancelled_at`（取消の4列はそろって空かそろって入る CHECK）を足し、`project_id` の一意制約を「取り消していない行」の部分一意索引（`order_conversions_active`）に変えた。取り消した案件はもう一度受注転換できる。SQLite は列内の UNIQUE を外せないので表を作り直す（参照する表はない）。
- 監査：`cancel_conversion`（`orders`）に取り消した転換の ID・受注転換額・戻した状態を記録する。理由は記録しない（精算完了の取消と同じ）。

#### 3.2.3 受注日・根拠の訂正（2026-11-13、PR #46 の後、T41）

- 受注転換の受注日（`converted_on`）・根拠（`basis`）の入力誤りを、理由をつけて直す操作。取消（3.2.2）と違い、受注変更・売上計上・予算・工数・直接費などの記録が付いた後でも直せる。受注日と根拠はどの金額・集計にも使っていない（月次見通し・目標粗利率の検収日・帳票は受注日を見ない）ので、訂正で数値は変わらず、締め済みの月も関係しない。確定受注額・範囲・売上予定の誤りは受注変更・組み替え、または取消で直す。
- 直せる条件（`cost_domain::order::check_conversion_correction`）：取り消していない受注転換があり、案件の状態が受注・進行中・作業完了（精算完了は先に精算完了を取り消す。受注変更などを精算完了の案件に記録しないのと同じ）。受注日は YYYY-MM-DD、根拠と理由は必須、受注日か根拠の少なくとも一方が今の値と違う。
- 訂正（`OrdersService::correct_conversion`、`POST /api/projects/{id}/order/conversion/correct`・Tauri `order_conversion_correct`、`EditOrder`）：`order_conversions` の行を新しい値に書き換え、`order_conversion_corrections` に前後の値・理由・訂正日（業務日付）・実施者・時刻を残す。訂正の行は書き換えも削除もしない。応答の `conversion.corrections`（新しい順）を画面の「受注日・根拠の訂正履歴」に出す。取り消した転換の訂正履歴は画面に出さない（表には残る）。
- 同時更新：画面が読んだ `revenue_version` で比較更新し（状態が受注・進行中・作業完了であることも同じ UPDATE で確かめる）、転換の行も読んだときの受注日・根拠のままのときだけ書き換える（T13）。
- マイグレーション `0026_order_conversion_corrections.sql`：`order_conversion_corrections`（受注日か根拠のどちらかが変わる CHECK）。
- 監査：`correct_conversion`（`orders`）に転換・訂正の ID、どちらが変わったか、受注日の前後を記録する。根拠の文言と理由は記録しない。
- 受注転換の取消の権限（PR #46 のレビュー指摘）：一部受注の取消は残りの範囲の案件を中止にするので、REST・Tauri とも元の案件の `EditOrder` に加えて残りの案件の `EditProject` を判定する。判定した残りの案件をサービスに渡し、取消の時点の転換の残りの案件と違えば古い版として拒否する。

### 3.3 予算・工数・直接費

```
budget_versions(id, project_id, version_no, status{draft|approved}, reason,
         approved_by, approved_at)
budget_lines(budget_version_id, phase_id, cost_type, planned_minutes NULL,
         budget_rate NULL, amount)
phases(id, name, active)                 -- 設計 / ソフト開発 / 製作 / 試験 / 現地調整 / 管理・打合せ
common_activities(id, name, active)      -- 社内会議・教育・営業・待機

-- 時間原価単価などは第10章の calc_items / calc_values で管理する（旧案の cost_rates を置き換え）
time_entries(id, work_date, user_id, project_id NULL, activity_id NULL, phase_id,
         minutes, description, rework_kind NULL, status{draft|submitted|approved|returned},
         applied_rate_id NULL, labor_cost NULL, approved_by, approved_at,
         client_request_id UNIQUE, row_version)
```

- `labor_cost` は承認時に計算して保存し、`ROUND(minutes × rate / 60)` の円で持つ。単価がなければ `NULL`（原価未確定、T04）。
- `client_request_id` で送信の再試行による二重登録を防ぐ（T13）。

#### 3.3.1 実装（P4b、2026-11-07）

- マイグレーション `0014_time_entries.sql`（SQLite / Postgres）：`phases`（仕様5.2の初期候補6件）・`common_activities`（社内会議・教育・営業・待機）・`time_entries`。マスタは削除せず使用中止にする（使用中止は新しい工数に選べない）。案件ごとに使う工程を絞る機能は予算版（P4c）で検討する。
- 計算規則は `cost_domain::time`（入力の検査・24時間・重複候補と所定時間との差の警告・承認時の原価・集計）。サービスは `admin_template_core::time_entries` と `work_masters`。
- 工数は案件（工程は必須）か共通活動（工程・手直し区分なし）のどちらか一つに付ける。手直し区分は社内起因・顧客起因・その他（未指定は当初作業）。
- 検査：0分以下・入力単位（計算基準 `time_unit`。未設定なら単位の検査はしない）の倍数でない・同じ人の同じ日の合計が24時間を超える・精算完了の案件（入力・申請・承認のどれでも）・使用中止のマスタは拒否。ただし差し戻された工数を直すときは、元から付いている工程・共通活動が使用中止でもそのまま使える（使用中止は新しい工数に選べなくするだけ。2026-11-07 ユーザー決定）。同じ日・同じ付け先と工程の重複と、1日の合計が所定時間（`day_minutes`）と違うことは警告だけ（仕様6.1）。Postgres では保存時に本人の users 行を `FOR UPDATE` で押さえ、24時間の検査を直列化する。
- 状態：下書き → 申請 → 承認、または差戻し（理由必須）。本人は下書きと差戻しだけを直す・消す・申請できる。他人の工数は本人向けの操作では「見つからない」と扱う。承認済みは書き換えない（訂正は P6b-2、3.5.3）。
- 承認時に、作業日に適用される `emp_rate`（案件の上書きを含む、10.2）の `calc_values.id`・単価・労務原価（`ROUND(分 × 単価 / 60)`）を保存する。単価がなければ労務原価は NULL（原価未確定）で承認する（T04）。後から単価を変えても承認済みは変わらず、計算基準の影響確認で訂正候補に数える（T03・T33）。個人別・等級別の単価（10.4 の `target_kind`）は、操作するのが1人のため今回は足していない。
- 集計（案件詳細の「工数」、`GET /api/projects/{id}/time-summary`）：承認済みだけを実績にし、原価未確定・申請中・未申請の件数と時間を別に示す。どれかが残る間は「暫定・不足あり」と表示する。工程別と手直しの時間も出す。
- 画面：`/time`（週表示の入力・申請）、`/approvals`（承認・差戻し）、`/work-masters`（工程・共通活動）、案件詳細の「工数」。

#### 3.3.2 実装（P4c、2026-11-07）

- マイグレーション `0015_budgets.sql`（SQLite / Postgres）：`budget_versions`（版番号は承認時に付ける。下書きは版番号なし）と `budget_lines`（工程×費目。工程なしは「工程指定なし（案件全体）」）。案件ごとの下書きは一つだけ（部分一意索引）、同じ版の同じ工程・費目は一行だけ。
- 計算規則は `cost_domain::budget`（明細の検査・労務費・承認の検査・版番号・比較）。費目は `cost_domain::forecast::CostType`（労務・材料・外注・旅費・その他）。サービスは `admin_template_core::budgets`。
- 流れ：下書きは現在の承認予算の写しから始め、責任者が自由に直す。承認で次の版番号を付け（版1＝当初予算、最大の版＝現在の承認予算）、以後は書き換え・削除しない。変更（版2以降）は理由が必須（T09）。下書きは破棄できる。受注前の案件でも下書きは作れるが、承認は受注・進行中・作業完了の案件だけ。精算完了・失注・中止の案件は下書きも変えられない。
- 労務費は予定工数 × 予算用単価（`budget_rate`、案件の上書きを含む）。単価は予算版の作成日（`created_on`）の値で、下書きは読むたびに今の計算基準で計算し、承認時に `calc_values.id`・単価・金額と合計を保存する（10.5：承認済みは変えない）。単価がない労務の明細があると承認できない（金額を0円にしない）。計算基準の影響確認では予算の下書きを「承認待ち」に数え、承認済みの版は訂正候補にしない。
- 認可：閲覧は `ViewProjectAmounts`。下書きの作成・保存・破棄は `ManageProject`（その案件の責任者の `project.manage`。P4c から `amount.view` も要求）。承認は新しい `ApproveBudget`（`Approve` と同じ範囲＋`amount.view`。依頼者は最後に保存した人で、`APPROVAL_POLICY` で自己承認可・監査に `selfApproval`）。監査の詳細には案件・版番号・状態・明細数だけを残し、金額は残さない。
- 比較（案件詳細の「予算」、`GET /api/projects/{id}/budget`）：費目別と工程×費目で当初予算・現在の承認予算・実績・差異（実績 − 現在の承認予算、プラスが超過）を並べる。実績は承認済み工数の労務原価だけで、未承認・原価未確定が残る間は「暫定・不足あり」。材料・外注・旅費・その他の実績は直接費（P4d）からなので「—」（0円にしない）。予算と実績は足さない（仕様3.3）。
- 同時編集：下書きの保存・破棄・承認は `row_version` で比較し、承認は版番号の採番を確かめる（Postgres では案件行を `FOR UPDATE`）。二度目の「予算案を作る」は既存の下書きを返す（T13）。
- 案件ごとに使う工程を絞る機能は入れていない（予算の明細に出る工程で足りるか、試行で確かめる）。

```
purchase_orders(id, project_id, vendor_id, cost_type, phase_id, amount,
         cancelled_amount, status, …)
direct_costs(id, project_id, phase_id, cost_type, vendor_id, description,
         booked_on, amount_ex_tax, tax_kind, amount_in_tax, voucher_no,
         purchase_order_id NULL, provisional BOOLEAN, corrects_id NULL,
         adjustment_kind NULL{return|cancel|discount}, status, client_request_id UNIQUE)
cost_allocations(source_cost_id, project_id, amount, basis, reason)
```

- 未実績発注残 ＝ 発注額 − 取消額 − 実績化済み額（対応する `direct_costs` の合計）。保存値ではなく計算で求める。
- 請求書の登録は仮計上の **置き換え訂正** として扱い、新規原価を作らない（T05、12.2）。

#### 3.3.3 実装（P4d、2026-11-07）

- マイグレーション `0016_direct_costs.sql`（SQLite / Postgres）：`vendors`（取引先マスタ。工程と同じく削除せず使用中止）・`purchase_orders`・`purchase_order_changes`（発注額の見直しと取消の履歴、理由必須）・`direct_costs`・`cost_allocations`。設計の `status` 付き発注・`adjustment_kind` の考え方は保ち、明細の種類を `entry_kind`（通常・仮計上・確定・調整）と参照先 `ref_id` で表した。
- 計算規則は `cost_domain::direct_cost`（入力の検査、承認済みの台帳に候補を加えた検査、発注の実績化済み額・取消・見直し）・`cost_domain::ledger`（計上行に工程と発注を持たせた）・`cost_domain::purchase`。サービスは `admin_template_core::direct_costs`、両経路の認可の写像は `cost_access`。
- 流れは工数と同じ（下書き → 申請 → 承認／差戻し）。承認済みは書き換えず、訂正は元の明細を参照する新しい明細（返品・取消・値引き、または仮計上の請求確定）を承認する（仕様11、T14）。確定・調整は元の明細の案件・工程・費目・取引先・発注を引き継ぐ。確定済みの仮計上は調整できない（確定の明細を調整する）。仮計上の確定は1回だけ（部分一意索引）。
- 複数案件の費用は案件を付けず配分する（2案件以上、合計＝金額）。配分した明細は調整できない（取消して配分し直す）。配分元は配分先だけに計上する（T10）。
- 発注は原価ではない。実績化済み額は発注にひもづく承認済み明細の計上行の合計（確定済みの仮計上は置き換え後、返品等は減額）で、保存しない。発注残を超える実績化は承認時に拒否し、発注額の見直し（理由つき）を先に求める（仕様6.3）。取消は未実績残まで、見直し後の額は取消済み＋実績化済み以上。
- 同時更新（T13）：明細・発注の更新は `row_version`、作成は `client_request_id`。承認は自分の行を先に書いてから同じトランザクションで承認済みの台帳を読み直して検査する（SQLite は最初の書き込みで書き込みロックを持つ。Postgres は発注と参照先の行を `FOR UPDATE`）。発注の見直し・取消も同じ形。台帳は会社全体を読み込む（小さい会社で件数が少ない前提）。
- 認可（ADR-0028 の追加）：入力は `EnterCost`（案件メンバーの `time.entry`、責任者の `project.manage`、または `finance.close`）を明細が付くすべての案件で。他人の明細への確定・調整と発注のひもづけは、その案件の `ViewProjectAmounts` も要る。承認は `ApproveCost`（`ApproveBudget` と同じ範囲＋`amount.view`、`APPROVAL_POLICY`）を全案件で。発注は `EditPurchaseOrder`（責任者か経理、`amount.view`）。閲覧は `ViewProjectAmounts`、承認一覧は `cost_approval_projects`。監査には種類・案件・日付・状態だけを残し、金額は残さない。
- 予算比較（3.3.2）の材料・外注・旅費・その他の実績を承認済みの直接費で埋めた。未承認・仮計上が残る間は「直接費実績 暫定」。
- 画面：`/costs`（自分の直接費を月ごとに入力・申請、請求確定・返品取消値引き）、承認一覧の「直接費の承認」、案件詳細の「直接費・発注」（費目別・月別（期番号つき）の累計、未承認・仮計上の件数、発注と未実績発注残、発注の登録・見直し・取消、明細）、工程・共通活動・取引先の画面に取引先。
- 未対応：締め後の訂正（P6）、完了見込での発注残の利用（P5）、税込からの税抜の自動計算、証憑の添付。精算完了の検査での発注残は P6a（3.5.1）。
- 台帳の要確認（P8e、2026-11-13、レビュー M-2・§8-6、T39）：承認済みの直接費と月額固定の計上の行で、種別・参照先・調整の種類・費目・管理計上日が読めないもの、台帳の検査（`ledger::postings`）で不整合になるものを黙って落とさない。`cost_domain::ledger::resolve` が、その記録を参照（確定・調整）でつながる系列ごと集計から外し、残りを計上して、外した記録が帰属・配分される案件を「要確認」として返す。参照先が読めない・存在しない確定・調整（または種別の読めない行）で、系列のどの記録にも案件・配分がないときは、どの案件の原価が欠けたか分からないので、すべての案件を要確認にする（PR #45 のレビュー指摘）。種別の読める通常・仮計上の明細で案件も配分もないもの（読めない行を含む）は、どの元明細にも帰属しないので一覧に出すだけで、ほかの案件の表示は止めない（2026-11-13 ユーザー決定。アプリの操作では登録できず、DB を直接書き換えたときにしか起きない）。以前は読めない行を捨て（利益が良く見える方向にずれる）、不整合が1件でもあると全案件の画面が止まった。
  - 要確認の案件：案件詳細の直接費・予算比較・完了見込・案件の月別収支・その案件の発注は、外した明細の ID を挙げて「集計できない」と返す（0円や外した残りの額を出さない）。全体一覧の行は実績原価・完了見込の判定を空欄にし、注意表示「直接費要確認」だけを出す（確定受注額・予算は出す。完了見込の列も空欄。案件詳細の要約は「完了見込なし」と見えるが、注意表示は「直接費要確認」だけ）。他の案件はそのまま表示・集計する。
  - 一覧：`GET /api/portfolio`（Tauri `portfolio_overview`）の `ledgerProblems` に、外した記録の出どころ（直接費の明細／月額固定の計上）・ID・案件・理由（読めない列、不整合の種類、同じ系列）を返す。金額は返さない。各記録の案件は確定・調整でつながる系列（元の明細とその配分を含む）から求め、案件を持たない確定・調整も元の明細の案件の利用者に見えるようにする。出すのは記録の案件がすべて金額を見られる案件のものと、案件のない記録は全案件の金額を見られる利用者にだけ。全体一覧の上に「直接費の台帳の要確認」として表示する。
  - 書き込み：関係のない承認は止めない。外した記録を元にする確定・調整の承認、外した記録がひもづく発注への実績化の承認と発注の見直し・取消は拒否する。月次締めは、要確認の記録が1件でもあれば締められない（会社全体の件数を表示。締めと同じトランザクションで台帳を読み直して数える）。その間、締めの画面の月の数値と締め時点との比較は「集計できない」とし、欠けた値を出さない（応答の `total`・`comparison` が `null`）。期の月別収支 CSV は要確認の案件を除き、除いた案件コードを集計条件に書く。
  - 直し方の画面はない（アプリの操作では読めない行・不整合は作られない。手作業の SQL や将来の取り込みで起きる）。行を直せば次の読み込みから元どおり集計される。案件単位の読み出しの絞り込み（M-2 (b)）は見送り（台帳は今も会社全体を読む）。

### 3.4 完了見込

```
forecast_versions(id, project_id, version_no, kind{draft|adopted}, base_date,
         order_amount_snapshot, budget_version_id, actual_cost_snapshot,
         planned_end, reason, created_by, confirmed_by, created_at)
forecast_lines(forecast_version_id, phase_id, cost_type,
         actual_amount, remaining_minutes NULL, forecast_rate NULL,
         committed_po_amount, other_remaining_amount)
```

- 基準日時点の実績を版に **スナップショット保存** する。後から実績が増えても旧版の完了見込原価は変わらない（T28、T30）。
- 最新実績 ≠ 版の実績スナップショットのとき「見込更新要」とする。

#### 3.4.1 実装（P5、2026-11-07）

- マイグレーション `0017_forecasts.sql`（SQLite / Postgres）：`forecast_versions`（版番号は採用時に付ける。下書きは案件ごとに一つ）と `forecast_lines`（工程×費目）。設計案の `kind{draft|adopted}` は `status`、`order_amount_snapshot`・`actual_cost_snapshot` は `order_amount`・`actual_total` とし、発注残・残原価・完了見込原価・現在の承認予算の版と額・実績の確定度（`actual_complete`）も版に持たせた。
- 計算規則は `cost_domain::forecast`（残見込みの入力の検査、実績・発注残・入力の結合、行ごとの残工数の金額、採用の検査、見込更新要の理由）と `cost_domain::alerts`（注意表示）。サービスは `admin_template_core::forecasts` と `portfolio`。
- 下書きが持つのは基準日・完了予定日・更新理由と残見込みの入力（労務は残工数、ほかは「それ以外に必要な見込み」）だけ。基準日までの承認済み実績（工数の作業日・直接費の管理計上日）と発注済み未実績は読むたびに求める。発注残は「基準日までに発注した発注の、現在の発注額 − 取消 − 基準日までの実績化」で、見直し・取消の時点は区別しない。新しい下書きは前回の採用版の入力を出発点にし、見積り直す（足し込まない）。
- 採用（確認者）：受注・進行中・作業完了の案件だけ。更新理由は毎回必須。基準日は今日以前で、前回の採用版の基準日以降。残工数があるのに見込み用単価がなければ採用できない（0円にしない）。基準日までに未承認・仮計上・単価未設定の実績が残る場合は採用できるが、版に「暫定・不足あり」を残す。採用で実績・発注残・単価（`calc_values.id`）・確定受注額・現在の承認予算を同じ基準日の組として保存し、以後は変えない（T28）。
- 見込更新要（T30）：最新実績 ≠ 基準日までの実績（基準日後の実績）、基準日までの実績を今読み直した額 ≠ 版の実績（過去実績の訂正）、見込み用単価の変更（残工数がある版だけ、設計10.5）、確定受注額の変更。採用版は変えず、理由を表示する。
- 利益：版の利益は版の受注額で、案件の「現在の完了見込直接利益」は現在の確定受注額 − 最新採用版の完了見込原価（仕様7.1）。未確定追加売上は含めない（T07）。超過額は現在の承認予算と比べる。
- 認可：閲覧は `ViewProjectAmounts`、下書きは `ManageProject`、採用は新しい `AdoptForecast`（`ApproveBudget` と同じ範囲＋`amount.view`、`APPROVAL_POLICY` で自己採用可・監査に `selfApproval`）。監査には案件・版番号・状態・基準日・行数だけを残す。
- 計算基準の影響確認で、完了見込の下書きを見込み用単価の「承認待ち」に数える。採用済みの版は訂正候補にしない。
- 全体一覧（`GET /api/portfolio`）：行は閲覧できる案件（admin は全件）、金額と注意表示は `amount_projects` の案件だけ（注意表示も金額を示すため）。案件台帳の画面に列（確定受注額・原価予算・実績原価・完了見込原価・利益・利益率・見込基準日・注意表示）と全体の要約（受注済みの件数と受注額、完了見込利益の合計と率＝利益合計÷受注合計、見込更新要・見込なしの件数、注意の件数、最も古い基準日）を出す。
- 注意表示の判定（閾値は計算基準 `review_delay_days`・`low_margin_pct`。未設定なら判定しない）：受注前は受注予定月超過・確認遅れ（確認日なしを含む）・確度・時期未設定。受注済みで精算前は完了見込赤字・予算超過見込み・低利益率（赤字のときは出さない）・未承認・未確定追加売上・見込更新要・完了見込なし・未精算発注残（作業完了で発注残あり）。失注・中止・保留・精算完了は出さない。「未入力」は検出していない。
- 未対応：締め後の訂正（P6）、見通しスナップショットへの完了見込版の参照、月次確認日の設定（今は最も古い基準日の表示だけ）。精算完了の検査での残見込みは P6a（3.5.1）。

### 3.5 締め・履歴・スナップショット

```
closing_periods(month, status{open|closed|reopened}, closed_by, closed_at, reopen_reason)
change_history(entity, entity_id, op, before_json, after_json, reason, actor, at)
outlook_snapshots(id, report_date, conditions_json, created_by, created_at)
outlook_snapshot_rows(snapshot_id, project_id, pipeline_version_id NULL,
         forecast_version_id NULL, month, recognized, ordered_plan, weighted_pipeline, undated)
```

- 締め済み月の明細は、サービス層で更新を拒否する。訂正は `corrects_id` つきの新しい行と再承認で行う（T11）。
- 楽観ロック用の `row_version` を全更新対象に持たせる（T13）。

#### 3.5.1 実装：精算完了（P6a、2026-11-07）

P6 は 精算完了（P6a、T17）→ 月次締めと締め後の訂正（T11）→ CSV と年度またぎの集計（T15）の順に分けて進める。

- マイグレーション `0018_closeouts.sql`（SQLite / Postgres）：`project_closeouts`（精算1回ごとに1行、精算前の状態・精算完了日（業務日付）・備考・実施者）と `closeout_waivers`（解消した残額の種類・発注・金額・理由・承認者）。行は書き換え・削除しない。
- 精算完了の取消（再開、2026-11-07 ユーザー決定）：マイグレーション `0019_closeout_reopenings.sql` で案件ごとの一意索引を外し、`closeout_reopenings`（取り消した精算・取消日（業務日付）・理由・実施者。精算1回につき1行）を足した。精算完了の案件だけを理由必須で作業完了に戻す（`ProjectStatus::reopened_to`）。精算と解消の記録は消さずに履歴として残し、もう一度精算完了にするときは検査と解消をやり直して新しい行を作る。案件の `row_version` で楽観ロックし、`row_version` と `revenue_version` を進める。
- 計算規則は `cost_domain::closeout`（`blockers`・`check_closeout`）と `ProjectStatus::settleable`（作業完了だけ）。判断待ちの受注変更を処理が必要な項目に足した。サービスは `admin_template_core::closeouts`。
- 処理が必要な項目（理由では解消できない）：未承認（下書き・申請中・差戻し）の工数と直接費（配分先を含む）、承認済みで単価未設定の工数、請求確定していない仮計上、判断待ちの受注変更。単価未設定の工数は、単価を登録してから訂正（P6b-2、3.5.3）を承認すると解消する（承認時に単価を決め直す）。申請中の訂正は未承認に数え、差し戻した訂正は数えない。
- 理由つきで解消できる残額：発注ごとの未実績発注残、最新の採用見込版の残見込みのうち発注済み未実績を除いた分（残工数の金額＋それ以外の見込み。発注残は発注ごとに数えるので重ねない）、未計上残（確定受注額 − 累計売上計上額。受注超過のマイナスも止める）。残見込みは、残りを0にした見込版を採用すれば消える。解消は画面に出た金額を添えて送り、金額が変わっていれば一致せず拒否する。承認者は実施者。
- 同時更新（T13）：精算は案件の `row_version` と `revenue_version` を比べて状態を `settled` にし、同じトランザクションで工数・直接費・発注・見込版の指紋（件数・版番号の合計・最大ID）を読み直して、検査の前に読んだものと違えば拒否する。工数・直接費・発注の登録と変更は、精算前かを事前に確かめたうえで、自分の書き込みの後に同じトランザクションで案件の状態を読み直し（Postgres は `FOR SHARE`）、精算完了なら取り消す（事前の確認と書き込みの間に精算が確定した場合を防ぐ）。
- 精算完了の案件には、工数・直接費・発注・予算の下書き・完了見込の下書き（既存の検査）に加えて、受注変更・売上予定の組み替え・売上の計上と取消も記録しない。
- 認可：検査の閲覧は `ViewProjectAmounts`、精算と取消は `SettleProject`（`amount.view`＋その案件の責任者の `project.manage` か `finance.close`）。REST は `POST /api/projects/{id}/closeout` と `…/closeout/reopen`、Tauri は `project_closeout_settle` と `project_closeout_reopen`。監査には案件・精算前の状態・精算完了日・解消した種類だけを残し、金額は残さない。取消（action `reopen`）は案件・取り消した精算とその精算完了日・取消日だけを残し、理由（自由記述）と金額は残さない。
- 画面：案件詳細の「精算完了」（受注済みの案件に表示）。ほかの欄で処理しても自動では再確認しないので「確認し直す」で読み直す（入力した理由は残す）。作業完了の案件で残っている項目を並べ、残額には理由の入力欄、処理が必要な項目には「処理が必要です」を出す。精算後は精算完了日・実施者・精算前の状態と解消した残額の一覧を表示し、理由を入力して「精算完了を取り消す」ができる。取り消した精算完了は「取り消した精算完了」（精算完了日・実施者・解消した残額の件数・取消日・理由・取り消した人）に並べる。

#### 3.5.2 実装：月次締め（P6b-1、2026-11-07）

P6b は 月次締め（P6b-1、この節）→ 締め後の訂正（P6b-2、`corrects_id`＋再承認）に分けて進める。

- マイグレーション `0020_closing_periods.sql`（SQLite / Postgres）：`closing_periods`（月 `YYYY-MM`・状態 `open|closed|reopened`・`row_version`）、`closing_events`（締め・再開の1回ごとに1行。再開は理由必須。書き換え・削除しない）、`closing_snapshot_rows`（締めの1回ごとの案件別の月の数値：労務費・単価未設定の件数・直接費・売上計上。0の案件は保存しない）。
- 計算規則は `cost_domain::closing`（`MonthStatus`・`check_close`・`check_reopen`・`warnings`・`compare`）。サービスは `admin_template_core::closing`。
- 締めの条件：その月に日付がある未承認（下書き・申請中・差戻し）の工数と直接費が0件。単価未設定の承認済み工数と請求確定していない仮計上は締めを止めず注意として出す（仮計上は月末の未請求分を計上する仕組みで、翌月以降の確定で置き換わる）。締めは月ごとで、前の月が未締めでも締められる。
- 締め済みの月に業務日付（工数の作業日・直接費の計上日・売上の計上日）がある工数・直接費・売上計上は、登録・変更・削除・申請・承認・差戻し・売上計上の取消を受け付けない。開いている月の明細を締め済みの月へ移す変更も拒否する。発注・受注変更・売上予定は実績ではないので対象外。仮計上の確定と返品・値引きの調整は、自分の計上日が開いている月なら記録できる（翌月調整）。
- 締め後の訂正（2026-11-07 決定、9章「再開は経理のみ」）：経理が理由を付けて月を再開し、通常の流れで直して、もう一度締める。締めた時点の数値は残り、画面で今の数値との違い（案件ごと）を示す（仕様9章）。承認済み工数そのものの訂正行（`corrects_id`）は P6b-2（3.5.3）。
- 月の数値：労務費と単価未設定の件数は承認済み工数（案件の分）、売上は取り消していない売上計上、直接費は「その月末までの台帳 − 前月末までの台帳」（`Ledger::until`）。後の月で確定した仮計上は、仮計上の月の数値を変えない。
- 同時更新（T13）：書き込む側は、自分の書き込みの後に同じトランザクションで月の `open` 行を作り（`ON CONFLICT DO NOTHING`）読み直す（Postgres は `FOR SHARE`）。締める側は同じ行を作って `FOR UPDATE` で押さえ、`row_version` を比べ、未承認件数を数え直し、数値を求める前に読んだ月の工数・直接費・売上計上の指紋（件数・版番号の合計・最大ID）と比べる。違えば古い版として拒否する。
- 計算基準の影響の事前確認（10.5）：締め済みの月の工数を `closed` として数え、「締め済みの月を含む」を出す。
- 認可：一覧・月の表示・締め・再開はすべて操作 `CloseMonth`（`finance.close`＋`amount.view`。月の全社の労務費・直接費・売上を示すため、PR #23 レビュー）。REST は読み取りが任意のロール、書き込みが editor 以上。REST は `GET /api/closing`・`GET /api/closing/{month}`・`POST /api/closing/{month}/close`・`…/reopen`、Tauri は `closing_months`・`closing_get`・`closing_close`・`closing_reopen`。監査には月と操作だけを残し、再開の理由（自由記述）と数値は残さない。
- 画面：`/closing`（月次締め）。対象月（既定は前月）・状態・締めの確認（未承認の件数、注意）・この月の数値・締めるボタン、締め済みなら再開の理由と再開ボタン、締めた時点との違い、締め・再開の履歴、締め済み・再開中の月の一覧。

#### 3.5.3 実装：承認済み工数の訂正（P6b-2、2026-11-07）

- マイグレーション `0021_time_corrections.sql`（SQLite / Postgres）：`time_entries` に `corrects_id`（置き換える元の工数）と `correction_reason`（理由。Postgres は CHECK、SQLite はサービスで必須）を足した。部分一意索引 `time_entries_one_correction`（`corrects_id`、状態が申請中・承認済み）で、1件の工数に申請中か承認済みの訂正を1件だけにする。差し戻した訂正は履歴として何件でも残る。
- 計算規則は `cost_domain::time`（`check_correction`・`counts`）。サービスは `admin_template_core::time_entries::correct`（申請）・`decide`（承認・差戻し、通常の工数と同じ）・`pending_corrections`（経理の承認待ち）・`corrections_of`（本人の訂正の履歴、新しい順）。
- 流れ：承認済みの工数は書き換えない。本人が正しい値（作業日・付け先・工程・時間・作業内容・手直し区分）と理由を入力すると、元の工数を参照する新しい行が申請中で作られる。経理が承認すると、訂正後の作業日に適用される単価（案件の上書きを含む）で労務原価を決め直して保存し（単価未設定の承認済み工数もこれで原価が付く）、元の工数は「置き換わった」扱いになる。元の行の値は残し、`row_version` だけを進める（精算完了・月次締めの指紋が変化を拾う、T13）。差し戻すと元の工数がそのまま生きる。訂正は編集・削除・再申請できず、差し戻されたら新しい訂正を申請する。置き換わった工数は訂正できず、次は承認済みの訂正の方を訂正する（鎖の最新の行だけが数える）。
- 訂正できない場合（`CorrectionIssue`）：承認済みでない（承認前は差戻し後に直す）、置き換わった工数、申請中の訂正がある、理由がない。ほかに通常の入力と同じ検査（入力単位・24時間・使用中止のマスタ（元の工数が付いているものは使える）・精算完了の案件）をする。24時間の検査では置き換える元の工数を数えない。申請中の訂正は日の検査に数えず（承認までは元の工数が数える）、訂正の承認時に元の工数の代わりに訂正を入れた日の合計を検査し直して、24時間を超えるなら承認を拒否する（PR #24 レビュー）。
- 集計に数える行（`counts`、SQL は `time_entries::COUNTS`）：承認済みの訂正で置き換わった元の行と、差し戻した訂正は数えない。申請中の訂正は申請中（未承認）に数え、元の行は承認済みのまま数える。工数集計（案件詳細）・予算比較の労務実績・完了見込の基準日実績・精算完了の検査・月次締めの未承認件数と数値・計算基準の影響確認（承認待ち・訂正候補）に適用した。工数画面の週・日の合計は、申請中の訂正も足さない（元の行が数えている）。
- 締め・精算との関係：申請中の訂正は、訂正後の案件・月に加えて、置き換える元の工数の案件と月でも未承認に数える（別の案件・月へ移す訂正の申請中に元の案件を精算したり元の月を締めたりすると、その訂正を承認できなくなるため。PR #24 レビュー）。申請時にも元の工数の `row_version` を進め、精算・締めの指紋が拾う。元の工数の月と訂正の月のどちらかが締め済みなら、申請・承認・差戻しを拒否する（締め済みの月の訂正は経理が月を再開してから。再開は経理だけなので「締め済み月の訂正は経理のみ」を満たす）。元の工数と訂正のどちらかの案件が精算完了なら申請・承認を拒否する。
- 認可：申請は本人の承認済み工数だけ（他人の工数は「見つからない」）で、訂正後の付け先に `EnterTime`／`EnterCommonTime`。承認・差戻しは新しい操作 `ApproveCorrection`（`finance.close`、仕様4の「訂正承認」。案件の責任者は通常の工数は承認できるが訂正は承認できない。`APPROVAL_POLICY` で自己承認可・監査に `selfApproval`）。承認一覧の通常の工数には訂正を出さず、経理には「工数の訂正の承認」に訂正前・訂正後・理由を並べる。REST は `POST /api/time-entries/{id}/correct`・`GET /api/time-entries/{id}/corrections`・`GET /api/time-entries/corrections`、Tauri は `time_entries_correct`・`time_entries_corrections`・`time_entries_pending_corrections`。監査（action `correct`）には日付・時間・付け先・状態・`correctsId` だけを残し、理由（自由記述）と単価・原価は残さない。
- 画面：工数画面の承認済みの行に「訂正」（同じ入力欄に理由を足したもの）。置き換わった行は「訂正済み（集計に含めません）」、訂正の行は「訂正」と理由、申請中は「訂正を申請中」を出す。承認一覧に「工数の訂正の承認」（経理だけに行が出る）。
- 未対応：訂正による取消（時間を0にする）。誤って入力した工数そのものを消す手段はまだない（正しい付け先への訂正で対応する）。直接費の訂正は従来どおり調整（返品・取消・値引き）と月の再開で行う。

#### 3.5.4 実装：CSV と年度またぎの月別・累計（P6c、2026-11-07）

- マイグレーションなし。計算規則は `cost_domain::report`（`monthly`・`deltas`・`Amounts`）と `cost_domain::csv`（`CsvTable`・`Cell`・`neutralize`）。サービスは `admin_template_core::reports`。
- 月の数値は月次締め（3.5.2）と同じ基準：労務費と単価未設定の件数は承認済み工数の作業日（置き換わった工数は数えない）、売上は取り消していない売上計上の計上日、直接費は各月末時点の台帳の差分（`Ledger::until`、`report::deltas`）。後の月で確定した仮計上は仮計上の月に残り、確定した月に差額だけが入る。案件詳細の直接費の月別（`project_costs` の `months`）も同じ基準に揃えた（以前は今の台帳を計上日で振り分けており、確定した仮計上が確定した月へ移っていた）。月の合計は今の台帳・承認済み工数・売上計上の合計に一致する（T15）。
- `report::monthly`：記録のある最初の月から最後の月まで、記録のない月は0円の行で埋める。期（6月開始）ごとの小計、当期累計（期首で振り出しに戻る）、案件累計（期をまたいで続く）、粗利（売上 − 労務費 − 直接費）と粗利率（売上0は算出不可）。単価未設定の工数は労務費に含めず件数で示し「原価未確定」とする。
- CSV（仕様9章）：先頭に UTF-8 の BOM、1行目に「出力日時」、続けて「集計条件」の行（帳票・対象・期・集計基準・原価未確定など）、空行、見出し、明細。行区切りは CRLF。文字列の欄は先頭が `=` `+` `-` `@`・タブ・改行・全角の `＝` `＋` `－` `＠` なら `'` を付けて無害化し、集計条件（案件名など利用者の入力を含む）にも当てる。数値の欄（負の金額）は変えない。未設定・算出不可・権限外の欄は空欄で、0にしない。率は百分率の小数第1位。
- 帳票：案件の月別収支（`project_monthly_csv`）、全体一覧（`portfolio_csv`、画面の列と注意表示）、期の月別収支（案件×月、`period_monthly_csv`。案件累計は前の期から数える）。CSV は JSON（`CsvExport`：ファイル名・内容・行数）で返し、ブラウザと Tauri で同じ方法で保存する。
- 認可（T12）：案件の月別収支とその CSV は `ViewProjectAmounts`。全体一覧の CSV は画面と同じく行が `visible_projects`（admin は全件）、金額と注意表示が `amount_projects`（範囲外は空欄）。期の月別収支は `amount_projects` の案件だけ。REST は `GET /api/projects/{id}/monthly`・`…/monthly.csv`・`GET /api/reports/portfolio.csv`・`GET /api/reports/period-monthly.csv?period=N`（任意のロール）、Tauri は `project_monthly`・`project_monthly_csv`・`portfolio_csv`・`period_monthly_csv`。CSV の出力は監査（action `export`、resource `reports`）に帳票の種類・案件IDか期番号・行数だけを残し、金額・名前は残さない。
- 画面：案件詳細に「月別収支（年度またぎ・累計）」（月・売上・労務費・直接費・原価計・粗利・粗利率・当期累計粗利・案件累計粗利、期の小計行、案件累計行、CSV出力）。全体一覧に「全体一覧をCSV出力」と期番号（既定は当期）つきの「期の月別収支（案件×月）をCSV出力」。
- 未対応：Tauri のデスクトップでの保存は WebView のダウンロード（Blob）に任せており、実機で未確認。顧客別・責任者別・費目別の帳票、期間を指定した累計（期単位のみ）。

### 3.6 日付・月の形式と売上予定の一意制約（2026-11-13、レビュー §8-16・M-1・M-5）

- 業務の日付は `TEXT` の `YYYY-MM-DD`、月は `YYYY-MM` で持つ。締めの判定・月別集計・期間の比較はこの文字列を切り出し・大小比較するので、`2026-6-1` のような行が入ると月から静かに外れる。サービスは必ず解釈してから書くが、手作業の SQL や将来の Excel からの取り込み（9章）には歯止めがなかった。
- マイグレーション `0027_date_formats.sql`：業務の日付・月の列を持つ22表（案件の予定開始・終了、見込の版と売上予定、受注転換とその訂正、受注変更、売上予定、売上計上、見通しスナップショット、計算基準の値、工数、予算の版、発注、直接費、完了見込の版、精算完了とその取消、月次締めと履歴、月額固定の契約と計上、定期売上）で、形式の違う値の書き込みを DB が拒否する。
  - SQLite は表を作り直さずに足すため、表ごとに `BEFORE INSERT` と `BEFORE UPDATE OF <列>` のトリガー（`<表>_dates_insert`・`<表>_dates_update`）を置く。値が `date(値, '+0 days')` で同じ文字列に戻ること（月はその月の1日として）を求めるので、`2026-02-30` のような暦にない日も拒否する（`'+0 days'` は、古い SQLite が月末を超える日を正規化せずにそのまま返すのを防ぐ。PR #54 のレビュー指摘）。
  - Postgres は関数 `banto_cost_check_dates()` を表ごとの `BEFORE INSERT OR UPDATE OF <列>` のトリガー（`<表>_dates`）から呼ぶ。`to_date()` で同じ文字列に戻ることを求め、SQLite と同じく暦にない日も拒否する。CHECK 制約にしないのは、`NOT VALID` で足しても以後の更新では既存の行にかかり、形式の違う日付が残った行は関係のない列の更新まで失敗するため（PR #54 のレビュー指摘）。
  - どちらも既にある行は検査し直さない（形式の違う行があっても起動を止めない）。更新では値を変えた列だけを検査するので、そうした行も他の列は直せる。空（NULL）は検査しない。記録の時刻（`*_at`）は業務の日付ではないので対象外。
  - 注意：これらの表を後のマイグレーションで作り直す（新しい表を作って写し、元を消して改名する）と、SQLite ではトリガーも消えるので作り直す。
- 売上予定（`revenue_plan`）と案件見込の売上予定（`pipeline_revenue_plan`）は (案件または版, 月) に1行（時期未定も1行まで）。サービスの重複の拒否（`duplicate_plan_month`）を DB でも守るため、同じ組の2行目を作る追加・更新をトリガー（SQLite は `<表>_month_insert`・`<表>_month_update`、Postgres は関数 `banto_cost_check_plan_month()` を呼ぶ `<表>_month`）で拒否する。一意索引にしないのは、手作業の SQL などで重複が既に残っていると索引の作成が失敗し、アプリが起動しなくなるため（PR #54 のレビュー指摘）。日付と同じく既にある行は検査し直さない。Postgres のトリガーは、検査の前に案件（版）の行を錠で押さえる。同じ案件に同時に行を足す2つのトランザクションを順番に通し、後の方が先の方の確定した行を見られるようにするため（READ COMMITTED が前提。サービスはこの設定で、売上予定を書く前に案件の行を更新するので、錠は既に持っている。PR #54 のレビュー指摘、`pg_smoke` で確認）。SQLite は書き込みが1本ずつなので錠は要らない。
- 拒否は DB のエラーとして返り、画面の入力検査の文言にはならない（通常の経路ではサービスの検査が先に止める）。

## 4 計算モジュール（`cost-domain`）

全関数は整数の円・分を受け取り、結果に **確定度**（`complete` / `provisional` / `missing`）と除外の内訳をつけて返す。

| 関数                                    | 内容                                                                     | 受入条件      |
| --------------------------------------- | ------------------------------------------------------------------------ | ------------- |
| `labor_cost(minutes, rate)`             | 円単位で四捨五入。単価なしは `missing`                                   | T02, T03, T04 |
| `actual_direct_cost(project, until)`    | 承認済みの工数原価＋直接費＋配分。未承認・単価なしは件数として別に返す   | T04, T10      |
| `po_remaining(po)`                      | 発注額 − 取消 − 実績化済み                                               | T05           |
| `forecast(version)`                     | 実績スナップショット＋残（発注残＋その他＋残工数×単価）                  | T06, T28      |
| `forecast_profit(order, cost)`          | 受注額が0円・未確定なら利益率は「算出不可」                              | T06, T08      |
| `budget_variance` / `forecast_overrun`  | プラスが超過                                                             | T28           |
| `pipeline_totals(versions)`             | 総額・確度加重額。未設定は除外して件数・理由を返す                       | T21, T25      |
| `monthly_outlook(month)`                | 計上実績＋受注済み予定＋未受注予定×確度。内訳は三つに分けて返す          | T27           |
| `ratio(profit, sales)`                  | 合計利益÷合計売上、小数第1位。売上0は算出不可                            | 7.4           |
| `ledger::postings(entries, allocs)`     | 調整・仮計上確定・配分を検査して計上行にする。配分元は配分先だけに計上   | T10, T14      |
| `ledger::resolve(entries, allocs, bad)` | 読めない行・不整合の記録を系列ごと外して計上し、要確認の案件を返す       | T39           |
| `order::check_conversion_cancel(facts)` | 受注転換を取り消せるか（受注・残りの案件が受注前・記録なし）             | T40           |
| `order::check_conversion_correction(c)` | 受注日・根拠を直せるか（精算完了でない・理由あり・値が変わる）           | T41           |
| `ledger::summarize(postings, project)`  | 管理計上日で月別・期別・累計に集計（合計は明細合計に一致）               | T15           |
| `report::monthly(cal, months)`          | 月別（空き月は0）・期の小計・当期累計・案件累計。月の合計と必ず一致      | T15           |
| `csv::CsvTable::render()`               | BOM・出力日時・集計条件つきの CSV。式として実行される文字列を無害化      | T12, 9章      |
| `ledger::split_by_weights(amount, w)`   | 按分。端数は最大剰余法で配り、合計を元の金額に一致させる                 | T10           |
| `OrderedRevenue::check()`               | 未計上残と売上予定（未消込）の一致、消し込み超過、受注超過の検出         | T26, 5.5      |
| `closeout::check_closeout(state, w)`    | 精算完了の阻害項目。残額だけ理由・承認つきで解消でき、金額が変われば無効 | T17           |
| `calc_basis::impact(values, new, use)`  | 基準追加時の影響案件・上書きで影響しない案件・承認待ち件数・訂正候補     | T32, T33      |

利益率は分母0のとき `None` を返し、画面は「算出不可」と表示する。四捨五入の規則は明細ごと（7.4）に固定し、集計時に再計算しない。

## 5 画面構成

Banto の `(app)` ルート配下に置く。一覧はデータグリッド、入力はスキーマ駆動フォーム。

| ルート           | 画面                                                     | 主に使う能力                       |
| ---------------- | -------------------------------------------------------- | ---------------------------------- |
| `/pipeline`      | 案件見込一覧                                             | `pipeline.edit` / `report.all`     |
| `/outlook`       | 月次見通し                                               | `report.all`                       |
| `/projects`      | 全体一覧（注意表示つき）                                 | `project.manage` / `report.all`    |
| `/projects/[id]` | 案件詳細（売上段階・予算版・完了見込・明細・履歴のタブ） | 案件範囲                           |
| `/time`          | 工数入力（週表示）                                       | `time.entry`                       |
| `/costs`         | 直接費・発注                                             | `time.entry` / `finance.close`     |
| `/approvals`     | 承認一覧                                                 | `project.manage` / `finance.close` |
| `/admin/*`       | 利用者・能力・顧客・工程・費目・単価・締め               | admin / `finance.rate`             |

画面の動きは付属の画面プロトタイプ（サンプルデータ）で確認する。

案件詳細はタブでなく縦に並べている（レビュー D-1）。P8c で先頭に「利益の要約」と節の目次を置いた。要約は全体一覧の同じ案件の行（確定受注額・現在の承認予算・最新実績・完了見込原価・完了見込直接利益と率・原資・注意表示）を `GET /api/projects/{id}/summary`（Tauri `project_summary`、`ViewProjectAmounts`）で返すもので、計算と注意の判定は全体一覧と同じ `PortfolioService` を通り、画面に規則を複製しない。金額を見られない利用者には要約を出さず目次だけを出す。節の操作が終わるたびに要約を読み直す。タブ化と基本情報の折りたたみは見送り（目次で足りるかを試行で確かめる）。

### 5.1 商品デモの削除とダッシュボード（2026-11-06 決定・実装）

- Banto の `items`（商品）デモを画面・REST・Tauri コマンド・デモデータごと削除した。DB の表は既存DBを壊さないよう `0001_items.sql` を残し、`0012_drop_items.sql`（SQLite/PostgreSQL）で `DROP TABLE IF EXISTS items` する。監査ログの `resource = 'items'` の行は履歴として残す。
- `/dashboard` は「案件と売上の要約」にした。表示するのは次の5つと、各画面（案件見込・月次見通し・案件台帳・顧客）へのリンク。
  - 未受注見込の総額・確度加重額：案件見込の集計（受注前の各案件の最新の採用版）。見込額・確度が未設定の件数を添える。
  - 今月・来月の売上見通し：月次見通しの合計（計上済み＋受注済みの売上予定＋未受注の確度加重見込）。受注予定月の集計とは足さない。
  - 注意が必要な案件：見込の未設定・採用版なし・売上予定の不足や不一致がある案件の数（同じ案件は1件と数える）。
  - どれも呼び出した人の案件範囲で集計する。集計を読めないときは0円にせず「権限がありません」などと表示する。デモモードでは集計がないので「—」を表示する。
- 確認すること（P8g、2026-11-13、レビュー U-4・§8-10）：要約の下に、今日手を付けることの件数をカードで並べ、各カードはそれを直す画面へのリンクにする。赤字見込み・予算超過見込み・見込更新要（全体一覧 `GET /api/portfolio` の注意表示の件数。金額を見られる案件だけ）、承認待ち（承認一覧の工数・直接費・工数の訂正の件数）、月額固定原価・定期売上の未計上（今月の件数、前月の件数を添える）。件数のあるカードは枠を警告色にする。項目ごとに別々に読み、読めない項目だけ「権限がありません」とする。直接費の台帳に要確認があると、集計できない案件の件数を添える。サーバーの変更はない。
- items を集計していたグラフとドックのパネル（月別・価格帯・SPC・トレンド）は削除した。ダッシュボードのメモはそのまま残し、既定はフローティング表示。旧レイアウトを読まないよう保存キーを `.v2` に変えた。
- 閲覧公開（ログイン不要の閲覧）で見られる画面はダッシュボードだけになった。
- デモモード（バックエンドなし）の in-memory データは架空の顧客8件・案件24件（`sampleData.ts`）。
- 案件台帳の一覧に列の表示切替（ColumnsMenu）を付けた。

## 6 実装の段階案

| 段階  | 内容                                                               | 完了条件                                 |
| ----- | ------------------------------------------------------------------ | ---------------------------------------- |
| P0    | リポジトリ作成、Banto コピー・リネーム・プリセット、CI             | Banto の既存検証が通る                   |
| P1    | `cost-domain` の計算と受入条件の単体テスト                         | T02, T05, T06, T08, T21, T27, T28 が通る |
| P2    | 能力・案件範囲の認可、案件・顧客・工程マスタ                       | T12, T19, T20（両経路の認可テスト）      |
| P3a   | 顧客・案件台帳・案件見込の版（下書き・採用）・案件見込一覧         | T21, T22, T25（2026-11-06）              |
| P3b   | 受注転換・部分受注・受注変更・売上予定と計上の消し込み・月次見通し | T23, T24, T26, T27（2026-11-06）         |
| P4a   | 計算基準（会社基準の版・案件ごとの上書き・影響の事前確認）         | T31〜T35（2026-11-06）                   |
| P4b   | 工程・共通活動マスタと工数（申請・承認・労務原価）                 | T02〜T04（2026-11-07）                   |
| P4c   | 予算版（当初・変更・承認、予算と実績の比較）                       | T09（2026-11-07）                        |
| P4d   | 直接費・発注                                                       | T05, T10, T14（2026-11-07）              |
| P5    | 完了見込版・注意表示・全体一覧                                     | T06, T28, T30（2026-11-07）              |
| P6a   | 精算完了（作業完了の案件の検査と、残額の理由つき解消）             | T17（2026-11-07）                        |
| P6b-1 | 月次締め（締め・再開・締め済み月の書き込み拒否・締め時点の数値）   | T11 の一部（2026-11-07）                 |
| P6    | 締め後の訂正（P6b-2）・CSV と年度またぎ（P6c）                     | T11, T13, T15                            |
| P7a   | 目標粗利率（計算基準）と原資の表示                                 | T36（2026-11-07）                        |
| P7b   | 月額固定原価（取り決め・月ごとの計上・取消）                       | T37（2026-11-07）                        |
| P7c   | 定期売上（月額契約の月別売上予定の生成・月末の計上）               | T38（2026-11-08）                        |
| P8e   | 直接費の台帳で読めない・不整合の行を落とさず報告（3.3.3）          | T39（2026-11-13）                        |
| P8f   | 取り返しにくい操作の確認ダイアログ・受注転換の取消（3.2.2）        | T40（2026-11-13）                        |
| P8f+  | 受注日・根拠の訂正（3.2.3）                                        | T41（2026-11-13）                        |
| P8g   | ダッシュボードの確認すること（5.1）・業務の流れの E2E と axe       | E2E・axe（2026-11-13）                   |
| P7    | バックアップ復元の確認、代表案件での試行                           | T18、手計算との照合                      |

## 7 画面プロトタイプの位置づけ

単一HTMLのクリック可能なモックで、仕様書12章の数値をサンプルデータにしている。計算は第4章の関数と同じ規則でブラウザ内に実装しており、入力値を変えると再計算する。保存・認証・権限はない。Banto の実画面ではないため、見た目は実装時に Banto のテーマへ合わせる。

## 8 未決事項（仕様書14章から、実装前に決める）

| 優先   | 事項                                      | この設計での仮置き                                                                                          |
| ------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 必須   | リポジトリ名・派生方式（コピー／git依存） | 新規リポジトリへコピー                                                                                      |
| 必須   | 本番DB・配備先                            | PostgreSQL、社内LANのサーバ1台                                                                              |
| 必須   | 能力モデルの採用（Banto RBAC の拡張）     | 第2.3節の案                                                                                                 |
| 必須   | 時間原価単価の単位                        | 個人別・等級別・一律のどれでも持てる構造にする                                                              |
| 必須   | 確度の段階別目安                          | 引合10・見積中30・交渉中50・内示80                                                                          |
| 必須   | 締め後訂正（再開方式か翌月調整か）        | 訂正行＋再承認。再開は経理のみ                                                                              |
| 決定   | 年度開始月・表示                          | **6月開始・期番号表示**（第13期＝2026年6月〜2027年5月）。2026-11-06 ユーザー決定                            |
| 決定   | 計算基準の変更                            | **管理画面で会社基準を変更でき、案件ごと・項目ごとに後から上書きできる**（第10章）。2026-11-06 ユーザー決定 |
| 必須   | 締め日・タイムゾーン                      | 月末締め・Asia/Tokyo                                                                                        |
| 必須   | 試行する案件と人数                        | 未定                                                                                                        |
| 次段階 | 共通費配賦、外部システム連携              | MVP外                                                                                                       |

## 9 現行Excel運用からの示唆（2026-11-06 受領の参考資料）

参考資料2点（売上・請求予定一覧、ジョブ別収支計算一式）は実データのため、リポジトリ・公開ページに置かない。本章は構造だけを匿名化して記録し、顧客名・人名・金額は書かない。

### 9.1 資料の構造

| 資料                          | 構造                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 売上・請求予定一覧（1シート） | 行＝請求単位。ジョブ№、検収年度（期番号）、顧客名、案件名、状態（済／営業中／実行中）、請求日、入金予定日、金額。月額保守・業務提携は同じジョブ№で月ごとに12行           |
| ジョブ別収支計算              | 受注額と原価明細（購入品は税込÷1.1、謝礼等は税抜そのまま、外注は日額×人日、旅費は別シート参照、社員の宿泊・旅費・高速・燃料は単価×回数）から粗利と粗利率を算出           |
| 外注先の請求管理              | 個人外注先の時間単価（社内作業／現地作業の2種、8時間＝1日）×人日を、ジョブ別・作業別に計上。月額固定の振込と作業額の差を残金として管理。社内の営業支援作業も同じ表にある |
| 交通宿泊明細                  | 出張ごと・人ごとの交通・宿泊と人日                                                                                                                                       |
| 月次作業報告書                | 日付・場所・案件・作業内容・開始・終了・休憩・作業時間。外注先が月ごとに提出                                                                                             |

### 9.2 設計への反映

1. **社員の労務原価が現行の収支計算に入っていない。** 社員の旅費・宿泊は計上されているが、作業時間の原価がない。アプリで労務原価を入れると、同じ案件の粗利率は現行より下がる。導入時に関係者へ説明しておく。
2. **年度は期番号で、6月開始の可能性が高い**（月額契約が6月〜翌5月）。第8章の仮置き「4月開始」は「6月開始・期番号表示」に変更候補。要確認。
3. **顧客と最終客先が分かれる。** 顧客名は元請・商社で、案件名に最終客先が入っている。`projects` に `end_customer` を追加する。
4. **案件区分が必要。** 開発、年間保守（月額）、運用支援、SV派遣、物販、成功報酬、ツール利用料。月額のものは一つのジョブから月別の売上予定を生成する機能（定期売上）を追加する。
5. **「営業中」が二つの意味で使われている。** 未受注の見込と、契約済みで未請求の将来月が同じ状態になっている。移行時は、契約済みの将来月を受注済み売上予定、未受注を案件見込に分ける。現行の「済」が請求済みか売上計上済みかも確認が必要。
6. **外注先は月額固定払いと作業実績が別に動く。** 支払額を原価にせず、作業報告（検収）に基づいて原価計上し、支払との差を外注先ごとの前払・未払残として管理する（仕様3.2「支払で新しい原価を作らない」）。外注単価は作業種別（社内／現地）を持つ。
7. **一人の外注先の作業が複数ジョブと社内活動に分かれる。** 外注の作業明細を案件・共通活動へ配分する入力を用意する（仕様5.2の共通活動）。
8. **見込と実績が一つの表に混在している。** 単価×回数の概算行と確定額の行が区別されていない。アプリでは実績明細と残見込みを分ける（仕様3.3）。
9. **税込÷1.1で端数のある円が出ている。** 証憑単位で税抜額を確定し、整数円で保存する。謝礼など課税区分が異なるものは税区分を持たせる。
10. **取込の検証が必要。** 見出しのない金額列、別の列に入った金額、ジョブ№のない行、状態列と見出しの不一致がある。初期移行のCSV取込は行ごとに検査し、不明な行は取込せず一覧で返す。

### 9.3 追加で確認すること

- 年度開始月と期番号の扱い。
- ~~「済」「営業中」「実行中」の定義と、売上計上の時点~~（9.4 で決定：検収時、月額契約は月末）。
- 社員の時間原価単価をどう決めるか（現行は未計上）。
- 外注先の月額固定払いの契約内容（前払か、上限つきの精算か）。
- 月次作業報告書を工数・外注実績の証憑として取り込むか。

### 9.4 追加資料と決定（2026-11-07）

追加資料（期ごとの案件一覧1シート＋状態の凡例）も実データのため、リポジトリ・公開ページに置かない。構造だけを記録する。

| 列のまとまり | 内容                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| 識別         | 担当社員ごとの関与フラグ、ジョブ№、期、顧客名、案件名                                              |
| 状態・日付   | 状態（電子帳簿上の状態：済／営業中／実行中／確定）、受注日、請求日、入金予定日                     |
| 金額         | 見込み（未受注の額）、受注金額、粗利＝受注金額×目標粗利率（表全体で一つの率）、原資＝受注金額−粗利 |
| 原価         | 社員ごとの円額、社外個人への支払、月額固定の支払、購入品、その他外注、原価計、実粗利率・実粗利額   |

ユーザー決定（2026-11-07）：

1. **状態の対応。** 電子帳簿上の状態で、営業中＝未受注（案件見込）、確定＝受注、実行中＝受注済み（作業中）、済＝精算完了。移行時は 確定→`ordered`、実行中→`in_progress`、済→`settled`、営業中→受注前の状態（段階は個別に確認）に写す。9.2 の5で懸念した「営業中」の二重の意味は、この資料では「確定」が分かれているので生じない。
2. **月額契約。** 同じジョブ№で月ごとに並ぶ行は、1つの案件と月別の売上予定にまとめる（9.2 の4の定期売上）。月ごとに案件を分けない。
3. **原価は「月額固定＋案件ごとの追加分」の二段にする（社員・外注とも同じ）。** 基本は人ごとの月額固定の円額で、資料では月額契約の案件の行に毎月同じ額が入っている。それとは別に、案件ごとの追加作業を工数×時間原価単価で計上する（資料で同じ人に「月額固定」の列と案件ごとの金額の列が並ぶのはこのため）。月額固定は承認済みの明細として月ごとに案件へ計上し、追加分は工数（3.3）から出す。同じ作業を月額固定と追加分の両方に入れない。どちらも未入力を0円にしない。
4. **目標粗利率と原資を表示する。** 目標粗利率は計算基準の項目（第10章、案件で上書き可）とし、原資＝確定受注額−確定受注額×目標粗利率（円未満は切り捨て）を案件ごとに表示する。原資は予算の上限の目安として予算・完了見込と並べ、承認済み予算を自動で書き換えない。目標粗利率が未設定なら原資は「未設定」とし、0%で計算しない。
5. **月額固定の支払列は、外注先の月額固定払い（9.2 の6）にあたる。** 3. の月額固定の一つとして扱い、9.2 の6の案（支払額を原価にせず作業報告から計上する）は、月額固定を原価として計上する形に改める。月額固定は、その人が担う月額契約の案件に毎月計上する（資料どおり。2026-11-07 決定）。複数案件・共通活動への配分は初期版では持たない。
6. **売上の計上は検収時。** 月額契約は各月の月末を検収日として計上する。月別の売上予定もこの月に置く。

#### 9.4.1 実装：目標粗利率と原資（P7a、2026-11-07）

- マイグレーション `0022_target_margin.sql`（SQLite / Postgres）：計算基準の項目 `target_margin_pct`（区分 `profit`、整数パーセント 0〜100、案件で上書き可・責任者は不可、変更は `finance.close`）。値は登録しない。
- 計算は `cost_domain::funds`：目標粗利＝確定受注額×目標粗利率（円未満は切り捨て）、原資＝確定受注額−目標粗利。受注前と率の未設定は `None`（画面は「—」「未設定」）。0% は設定値として扱う。
- 適用日は案件ごとの検収日（最初の売上計上日、取消を除く）。まだ検収していない案件は業務日付（2026-11-07 ユーザー決定）。検収後に会社基準を変えても、検収済みの案件の率・原資は変わらない。案件の上書きがあればそれ、なければ会社基準。円未満は目標粗利の側で切り捨てる（同日ユーザー確認）。完了見込の見出しに、どの日の率かを示す。
- 表示：案件詳細の完了見込の見出しに「原資（目標粗利率 N%）」、全体一覧に原資の列、全体一覧 CSV に「目標粗利率(%)」「原資」の列。金額を見られない案件は率も原資も出さない（T12）。承認済み予算・完了見込は書き換えない。
- 既知：原資と予算・完了見込の差額の表示、目標粗利率による注意表示はない。

#### 9.4.2 実装：月額固定原価（P7b、2026-11-07）

- マイグレーション `0023_fixed_costs.sql`（SQLite / Postgres）：`fixed_cost_contracts`（取り決め：案件・支払先の種類（社員／外注先）と社員または取引先・費目（社員は労務費、外注先は外注費）・月額（正の整数円）・開始月・終了月（空は継続）・備考・`row_version`）と `fixed_cost_postings`（計上：取り決め・月・案件・費目・金額・管理計上日（月末）・状態（承認済み／取消）・計上者・取消の理由と者）。同じ取り決め・同じ月の承認済みの計上は一つだけ（部分一意索引）。
- 計算規則は `cost_domain::fixed_cost`（支払先の種類と費目、期間、取り決めの検査、月の計上の振り分け）。サービスは `admin_template_core::fixed_costs`。
- 計上：操作するのは1人なので、申請・承認の流れは持たず、計上がそのまま承認済みになる（2026-11-07 ユーザー確認）。経理が月を選んで「この月を計上」すると、その月を期間に含み、案件が受注・進行中・作業完了で、まだ計上していない取り決めを、取り決めのその時点の月額で承認済みの明細にする（自己承認と同じ扱い。承認の流れは持たない）。二度目の計上は何も足さない（`ON CONFLICT … DO NOTHING`）。受注前・失注・中止・保留・精算完了の案件の取り決めは「対象外」として一覧に出し、計上しない。
- 集計：承認済みの計上は直接費の台帳（`LEDGER_SQL`）に負の ID の通常の明細として合流し（直接費の ID と重ならない。工程・発注なし）、予算比較・完了見込・全体一覧・月別収支・月次締めにそのまま入る。社員の月額固定は労務費として、月別収支・月次締めでも労務費の欄に入れる。案件詳細の「直接費・発注」の合計には労務費を入れない。
- 変更：月額の変更は未計上の月からだけ効き、計上済みの額は変えない。計上済みの月がある取り決めは案件・支払先を変えられず、期間は計上済みの月を含んだままにする（450,000円→300,000円の切り替えは、月額の変更でも、終了月を決めて新しい取り決めを登録してもよい）。更新は `row_version` で比較し、同じトランザクションで計上済みの月を読み直す。
- 取消：理由必須。取り消した計上は集計に入らず、その月は再び計上できる。締め済みの月は計上・取消を拒否する（`refuse_closed!`）。月次締めに、未計上の月額固定の件数を注意として出す（締めは止めない）。締めの指紋に計上・取消を加えた。
- 認可：すべての操作が新しい `ManageFixedCosts`（`finance.rate`＋`amount.view`。金額が人ごとのため個人単価と同じ能力）。REST は読み取りが任意のロール、書き込みが editor 以上。`GET/POST /api/fixed-costs/contracts`・`PUT /api/fixed-costs/contracts/{id}`・`GET /api/fixed-costs/months/{month}`・`POST …/months/{month}/post`・`POST /api/fixed-costs/postings/{id}/cancel`、Tauri は `fixed_cost_*`。監査には操作・取り決め・月・案件だけを残し、金額と取消の理由は残さない。
- 画面：`/fixed-costs`（月の計上と取消、取り決めの一覧・登録・変更）。社員は業務用の利用者一覧から選ぶ（案件の責任者と同じ、3.1.1）。
- 既知：複数案件・共通活動への配分はない（9.4 の5）。同じ作業を月額固定と工数の両方に入れることは検出しない（画面で注意するだけ）。完了見込の残見込みに今後の月額固定を自動で入れない（下書きの「それ以外の見込み」に入力する）。

#### 9.4.3 実装：定期売上（P7c、2026-11-08）

- マイグレーション `0024_recurring_revenue.sql`（SQLite / Postgres）：`recurring_revenues`（取り決め：案件（1案件に1つ）・月額（正の整数円）・開始月・終了月（必須）・備考・`row_version`）。売上計上は既存の `revenue_recognitions` に記録し、取り決めの表には金額の実績を持たない。
- 計算規則は `cost_domain::recurring`（期間、入力の検査、月別売上予定の作り直し `regenerate`、月の状態 `month_state`）。サービスは `admin_template_core::recurring_revenue`。
- 取り決めの登録・変更：受注済みで精算前（受注・進行中・作業完了）の案件だけ。月額×月数が確定受注額と一致しないと登録・変更できない（受注変更で確定受注額を直すか、月額・期間を見直す）。保存すると、未計上の売上予定を期間の月ごとに「月額 − その月の消込済み額」で作り直し、期間外の未消込の予定（時期未定を含む）は無くす。計上済みの月を期間から外すこと、計上済みの額より小さい月額にすることはできない。予定の書き換えと取り決めの保存は同じトランザクションで、`projects.revenue_version` の比較更新と取り決めの `row_version` で行き違いを拒否する（T13）。案件は変えられない。
- 月の計上：経理が月を選んで「この月を計上」すると、その月を期間に含み、案件が受注済みで精算前で、その月の売上予定に未消込がある取り決めごとに、月末日（検収日）・未消込額・根拠「定期売上（月末検収）」の売上計上を記録し、その月の予定だけを消し込む。計上は通常の売上計上（`OrdersService::recognize`）と同じ検査を通る。消込済みの月は飛ばすので、二度押しても計上は増えない。行き違いで計上できなかった案件は一覧で返し、他の案件は計上する。締め済みの月は計上を拒否する。取消は案件詳細の受注・売上から理由をつけて行う（取り消すとその月は再び未計上になる）。
- 目標粗利率：月額契約も、最初の検収日（最初に計上した月の月末）の率を使う（2026-11-08 ユーザー決定。9.4.1 の読み方のまま）。
- 月次締めに、未計上の定期売上の件数を注意として出す（締めは止めない）。
- 認可：すべての操作が新しい `ManageRecurringRevenue`（`finance.close`＋`amount.view`。売上計上は経理の操作で、月額契約の金額を全社分表示するため）。REST は読み取りが任意のロール、書き込みが editor 以上。`GET/POST /api/recurring-revenue/agreements`・`PUT /api/recurring-revenue/agreements/{id}`・`GET /api/recurring-revenue/months/{month}`・`POST …/months/{month}/recognize` と Tauri の `recurring_revenue_*`。監査は操作・取り決め・月・案件だけで、金額は残さない。
- 画面：`/recurring-revenue`（月の計上、取り決めの一覧・登録・変更、月額×月数の表示）。
- 既知：月額の途中変更（例：月額を途中から下げる）は1つの取り決めでは表せない（受注変更と売上予定の組み替えで扱う。その後に取り決めを保存すると月額で作り直すため注意）。取り決めの削除はない。案件見込（受注前）の月別予定は生成しない。

取込の注意（10. に追加）：未受注の状態なのに受注日・受注額がある行、年の欠けた日付・請求日より前の入金予定日、精算完了なのに請求日がない行がある。行ごとに検査して一覧で返す。

## 10 年度と計算基準の設定（2026-11-06 決定）

### 10.1 年度

- 年度は6月開始。画面・CSV・集計条件では期番号で表示する（例：第13期＝2026年6月〜2027年5月）。
- 会社設定に「年度開始月」と「基準期（期番号と開始年の組）」を持ち、期番号は日付から計算する。月次集計・当期累計・年度またぎ（T15）はこの定義に従う。
- 実装（P8d、2026-11-12）：会社が1つの間、年度は `cost_domain::FiscalCalendar::COMPANY_DEFAULT`、業務日付のタイムゾーンは `BusinessTimeZone::COMPANY_DEFAULT`（Asia/Tokyo、夏時間がないので UTC+9:00 固定）の定数1か所に置く。core の `business_date` が業務日付（`today`）・帳票の出力日時（`now_local`）・暦（`calendar`）を作り、見込の基準日・予算の下書き日・精算完了日と取消日・計算基準の適用日・帳票の出力日時はすべてここから取る（以前は SQLite の `date('now','localtime')`／Postgres の `CURRENT_DATE` で、実行環境の地域設定まかせだった）。画面はレイアウトで最大3秒だけ待って `GET /api/calendar`（Tauri `business_calendar_get`、ログインしていれば誰でも。金額・氏名なし）で今日・期の定義・第1期から次の期までの名前（`第13期（2026年6月〜2027年5月）`）を受け取り、TypeScript に会社の数字を持たない。今日はサーバーの時刻（応答の `nowMs` と端末の時計の差で補正）と UTC との差から計算するので、端末の時計がずれていてもサーバーと同じ日になり、日付をまたいでも開き直さずに進む。月次見通しの「今期」は押したときの期を使う。デモモード・読み込み失敗のときは端末の日付で、期は出さない。
- 画面（P8d）：月次見通し・月次締め・月額固定原価・定期売上の月の欄の見出しに期（`（第13期）`）、直接費入力の月に期を添える。期の月別収支 CSV の期は選択肢、月次見通しに「今期」。案件詳細の中の月の欄（見込・受注・売上予定）には添えていない。

### 10.2 方針

時間原価単価などの計算の土台は、管理画面で変更できる **計算基準** として持つ。案件ごとに事情が違うため、**会社基準を案件ごと・項目ごとに後から上書き** できるようにする。

適用値は次の順で決まる。

1. 明細で個別に指定できる項目（外注先・契約ごとの単価、個人別・等級別の時間原価単価）があれば、それを使う。
2. なければ、その案件の上書きのうち、適用開始日が対象日以前で最も新しいもの。
3. なければ、会社基準のうち、適用開始日が対象日以前で最も新しい版。

対象日は、工数・費用なら作業日・管理計上日、見込なら基準日、予算なら予算版の作成日とする。

### 10.3 項目（初期案）

| 区分     | 項目                           | 単位         | 案件で上書き   | 変更権限                         |
| -------- | ------------------------------ | ------------ | -------------- | -------------------------------- |
| 労務     | 社員の時間原価単価（標準）     | 円/時        | 可             | 経理                             |
| 労務     | 見込み用単価（残工数）         | 円/時        | 可             | 経理・案件責任者                 |
| 労務     | 予算用単価                     | 円/時        | 可             | 経理・案件責任者                 |
| 外注     | 外注単価（社内作業／現地作業） | 円/時        | 可             | 経理・案件責任者                 |
| 換算     | 1日の基準時間（人日換算）      | 時間         | 可             | 経理                             |
| 旅費     | 宿泊費・車両費の見込単価       | 円/泊・円/km | 可             | 経理・案件責任者                 |
| 税・入力 | 標準消費税率、工数の入力単位   | %・分        | 不可           | 経理                             |
| 注意表示 | 確認遅れ日数、低利益率の閾値   | 日・%        | 低利益率のみ可 | 経理（低利益率は案件責任者も可） |
| 利益     | 目標粗利率（原資の算出、9.4）  | %            | 可             | 経理                             |

項目は `calc_items` に定義し、後から追加できるようにする。項目ごとに「案件で上書きできるか」「変更できる能力」を持つ。個人別の時間原価単価は `finance.rate` を持つ人だけが閲覧・変更できる。

### 10.4 データ

```
calc_items(key, label, group, unit, value_type, project_overridable, edit_capability, active)
calc_values(id, item_key, scope{company|project}, project_id NULL,
            target_kind NULL{user|grade|vendor|work_type}, target_id NULL,
            valid_from, value NULL, version_no, reason, created_by, created_at,
            approved_by NULL, approved_at NULL)
```

- 変更は上書き更新ではなく、適用開始日つきの新しい行として追加する。履歴をすべて残す。
- 案件の上書きを解除するときは `value = NULL`（会社基準に戻す）の行を追加する。
- 同じ対象・同じ適用開始日の行は一つだけにする。
- 工数・直接費・見込・予算の各明細は、計算に使った `calc_values.id` と値を保存する。

### 10.5 後から変更したときの影響

| 対象                 | 扱い                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| 下書き・申請中の工数 | 承認時に新しい適用値で計算する                                                                           |
| 承認済みの工数・費用 | 自動では変えない。適用開始日以降の該当明細を「再計算訂正の候補」として一覧に出し、経理が訂正・再承認する |
| 締め済みの月         | 締め後訂正の規則（再開または翌月調整）に従う                                                             |
| 下書きの見込版       | 新しい値で再計算する                                                                                     |
| 採用済みの見込版     | 変えない。「見込更新要」を表示する                                                                       |
| 承認済みの予算版     | 変えない。次の予算案から使う                                                                             |

保存前の画面で、上の影響件数（対象案件数、上書き済みで影響しない案件数、未承認・承認済みの件数、締め済み月を含むか）を表示する。理由の入力は必須とし、変更は監査ログにも記録する。

### 10.6 画面

- **管理設定 → 計算基準**：会社基準の一覧（現在値・版・適用開始日・上書きしている案件数・変更権限）、変更フォーム（新しい値・適用開始日・理由・影響の確認）、変更履歴。
- **案件詳細 → 計算基準タブ**：項目ごとに会社基準・この案件の適用値・出典を並べ、上書き値・適用開始日・理由を入れて保存する。「会社基準に戻す」と上書きの履歴を表示する。

### 10.7 受入条件の追加

| 番号 | 確認する操作・条件                                                               | 合格条件                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T31  | 会社基準の単価を適用開始日つきで変更                                             | 新しい版が追加され、以前の版と履歴が残る。適用開始日より前の作業日には旧版が使われる                                                                                                                                                                                                                                                                                                                             |
| T32  | ある案件だけ見込み用単価を上書き                                                 | その案件の下書き見込だけが再計算され、他の案件と採用済みの見込版は変わらない                                                                                                                                                                                                                                                                                                                                     |
| T33  | 承認済み工数がある期間へさかのぼって単価を変更                                   | 承認済みの原価は自動で変わらず、再計算訂正の候補として件数と明細が出る                                                                                                                                                                                                                                                                                                                                           |
| T34  | 上書きを「会社基準に戻す」                                                       | 以後の対象日は会社基準の値になり、上書きの履歴は残る                                                                                                                                                                                                                                                                                                                                                             |
| T35  | 権限のない役割で計算基準を変更                                                   | 画面・API のどちらからも変更できない。個人別単価は経理以外に見えない                                                                                                                                                                                                                                                                                                                                             |
| T36  | 目標粗利率15%・確定受注2,000,000円                                               | 目標粗利300,000円・原資1,700,000円。率が未設定・受注前は原資を出さず、0%で計算しない。案件の上書きはその案件だけに効く。承認済み予算は変わらない                                                                                                                                                                                                                                                                 |
| T37  | 外注先の月額固定300,000円（2026年6月〜）を12月に計上                             | 案件の外注費実績・12月の月別収支に300,000円が一度だけ入る。社員の月額固定は労務費。月額の変更は未計上の月だけに効く。締め済みの月は計上・取消できない。月額未入力・0円は登録できない                                                                                                                                                                                                                             |
| T38  | 月額300,000円・2026年6月〜2027年5月の定期売上（確定受注3,600,000円）を12月に計上 | 期間の月ごとに300,000円の売上予定ができ、12月の計上は2026-12-31の売上計上として12月の予定を一度だけ消し込む。月額×月数が確定受注額と合わない取り決めは登録できない。取り決めの変更で計上済みの月は残る。締め済みの月は計上できない。目標粗利率は最初の月の検収日の値                                                                                                                                             |
| T39  | 承認済みの直接費の1行の管理計上日が読めない（手作業の SQL など）                 | その行と同じ系列の明細を集計から外し、ID・案件・理由を一覧に出す。その案件は直接費・予算比較・完了見込を「集計できない」とし、残りの額を実績として出さない。他の案件の表示・承認は止まらない。要確認がある間は月を締められない                                                                                                                                                                                   |
| T40  | 受注後の記録がない案件で、受注転換を理由つきで取り消す                           | 案件は転換前の状態に戻り、受注済みの売上予定は消え、採用版の見込が未受注の集計に戻る。転換は取消日・理由・実施者つきで履歴に残り、もう一度受注転換できる。受注変更・売上計上・予算・工数・直接費・完了見込・月額固定・定期売上のどれかがある案件、進行中以降の案件、残りの範囲の案件が受注転換済みの一部受注は取り消せず、理由を一覧で示す。一部受注の取消では残りの範囲の案件が中止になり、見込は二重にならない |
| T41  | 売上計上・工数などの記録が付いた進行中の案件で、受注日・根拠を理由つきで訂正する | 受注転換の受注日・根拠が新しい値になり、前後の値・理由・訂正日・実施者が訂正履歴に残る。確定受注額・売上予定・集計は変わらない。精算完了の案件、値が変わらない訂正、理由のない訂正は拒否する                                                                                                                                                                                                                     |

### 10.8 実装（P4a、2026-11-06）

- マイグレーション `0013_calc_basis.sql`（SQLite / Postgres）：`calc_items`（10.3 の12項目。値の種類・単位・案件で上書きできるか・責任者も上書きできるか・変更権限）と `calc_values`。項目だけを登録し、値は登録しない（未設定を0にしない）。個人別・等級別の単価（`target_kind`・`target_id`）は工数を扱う段階で足す。
- 会社基準の変更権限は、労務・外注の単価と1日の基準時間が `finance.rate`、旅費・税・入力・注意表示が `finance.close`。案件の上書きは、変更権限を持つ人ならどの案件でも、10.3 で「案件責任者」も可とした項目はその案件の責任者もできる。どれも `amount.view` が要る。
- 計算規則は `cost_domain::calc_basis`（適用値の解決、追加の検査、値の範囲 `ValueKind`、版番号、上書きで影響しない案件）。サービスは `admin_template_core::calc_basis`。
- 行は追加だけで、書き換え・削除はしない。同じ項目・範囲・適用開始日の行と、同じ版番号の行は一意索引でも拒否する（同時保存の二重登録を防ぐ、T13）。案件の「会社基準に戻す」は値なしの行（T34）。
- 影響の事前確認（10.5）：変更前後の適用値、会社基準の変更で上書き中のため影響しない案件、値が変わる案件・承認待ち・訂正候補の件数、締め済みの月を含むか。P4b から工数（`emp_rate`）、P4c から予算の下書き（`budget_rate`）の件数を数える。費用・見込の明細はそれぞれの段階で足す。P6b-1 から締め済みの月の工数を「締め済みの月を含む」に数える。
- 監査ログの詳細には項目・範囲・案件・適用開始日・版番号だけを残し、値（単価）は残さない（監査ログはシステム管理者が見るため、仕様4章・11章）。
- 画面：`/calc-basis`（基準日の値・版・予定の変更・上書き中の案件数・履歴・変更フォーム）、案件詳細の「計算基準」（会社基準・この案件の適用値・出典・上書きの履歴・上書きと会社基準に戻す）。保存は「影響を確認」した入力のままのときだけできる。
