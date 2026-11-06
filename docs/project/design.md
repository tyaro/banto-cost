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
- 自己承認（2026-11-06 ユーザー決定）：操作するのは1人なので、承認は依頼者本人でもよい（仕様第4章の小規模例外）。P3b では受注変更の承認に適用した（`orders::ORDER_CHANGE_POLICY`）。P4 の工数・直接費の承認にも適用する。そのときは `ORDER_CHANGE_POLICY` を会社の承認方針として共通化し、REST と Tauri の両経路に同じ値を渡す。使ったときは監査ログの詳細に `selfApproval: true` を残す。判定関数の既定（自己承認の禁止）は変えない。

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
- 受注済みの案件は受注前の状態へ戻せない。案件の編集画面では受注・進行中・作業完了の間だけ動かせる（`ProjectStatus::can_edit_to`）。精算完了は T17 の検査（P6）で扱う。
- 受注変更：差額・売上予定の月（または時期未定）・根拠で登録し、承認までは未確定追加売上（確定受注額に含めない）。承認で確定受注額と指定月の売上予定に加える。減額で予定や未計上残がマイナスになる承認は拒否する。却下は理由必須で、どちらも履歴に残る。
- 売上予定の組み替え：未計上の額だけを月（または時期未定）に配り直す。合計は未計上残に一致させ、消込済みの行は残す。
- 売上計上（T26）：`finance.close` が記録する。計上月の予定 → それより前の月 → 後の月 → 時期未定の順に自動で消し込む。受注額の超過・消し込み不足は拒否し、0円に丸めない。誤りは理由をつけて取り消し（行と消し込みは履歴に残す）、予定は未消込に戻る。
- 同時更新：受注・売上への書き込みはすべて `projects.revenue_version` の比較更新から始め、同じ状態を見た二人が両方とも検査を通ることを防ぐ（T13）。案件の編集フォームの `row_version` とは分けた。
- 月次見通し（T27、`GET /api/outlook`）：案件ごとに `outlook::monthly_outlook` で計上済み・受注済み予定（未消込分）・未受注×確度を求めて足し、三つの内訳と合計を返す。時期未定は独立の行で月の合計に入れない。未確定追加売上は別の列で合計に入れない。範囲は `amount_projects`。
- スナップショット：`report.all` が全案件の見通しを案件×月の行で保存する。後の受注転換・計上で変わらない。表示・比較（前回差異）は呼び出した人の `amount_projects` の行だけ。

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

## 4 計算モジュール（`cost-domain`）

全関数は整数の円・分を受け取り、結果に **確定度**（`complete` / `provisional` / `missing`）と除外の内訳をつけて返す。

| 関数                                   | 内容                                                                     | 受入条件      |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------- |
| `labor_cost(minutes, rate)`            | 円単位で四捨五入。単価なしは `missing`                                   | T02, T03, T04 |
| `actual_direct_cost(project, until)`   | 承認済みの工数原価＋直接費＋配分。未承認・単価なしは件数として別に返す   | T04, T10      |
| `po_remaining(po)`                     | 発注額 − 取消 − 実績化済み                                               | T05           |
| `forecast(version)`                    | 実績スナップショット＋残（発注残＋その他＋残工数×単価）                  | T06, T28      |
| `forecast_profit(order, cost)`         | 受注額が0円・未確定なら利益率は「算出不可」                              | T06, T08      |
| `budget_variance` / `forecast_overrun` | プラスが超過                                                             | T28           |
| `pipeline_totals(versions)`            | 総額・確度加重額。未設定は除外して件数・理由を返す                       | T21, T25      |
| `monthly_outlook(month)`               | 計上実績＋受注済み予定＋未受注予定×確度。内訳は三つに分けて返す          | T27           |
| `ratio(profit, sales)`                 | 合計利益÷合計売上、小数第1位。売上0は算出不可                            | 7.4           |
| `ledger::postings(entries, allocs)`    | 調整・仮計上確定・配分を検査して計上行にする。配分元は配分先だけに計上   | T10, T14      |
| `ledger::summarize(postings, project)` | 管理計上日で月別・期別・累計に集計（合計は明細合計に一致）               | T15           |
| `ledger::split_by_weights(amount, w)`  | 按分。端数は最大剰余法で配り、合計を元の金額に一致させる                 | T10           |
| `OrderedRevenue::check()`              | 未計上残と売上予定（未消込）の一致、消し込み超過、受注超過の検出         | T26, 5.5      |
| `closeout::check_closeout(state, w)`   | 精算完了の阻害項目。残額だけ理由・承認つきで解消でき、金額が変われば無効 | T17           |
| `calc_basis::impact(values, new, use)` | 基準追加時の影響案件・上書きで影響しない案件・承認待ち件数・訂正候補     | T32, T33      |

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

### 5.1 商品デモの削除とダッシュボード（2026-11-06 決定・実装）

- Banto の `items`（商品）デモを画面・REST・Tauri コマンド・デモデータごと削除した。DB の表は既存DBを壊さないよう `0001_items.sql` を残し、`0012_drop_items.sql`（SQLite/PostgreSQL）で `DROP TABLE IF EXISTS items` する。監査ログの `resource = 'items'` の行は履歴として残す。
- `/dashboard` は「案件と売上の要約」にした。表示するのは次の5つと、各画面（案件見込・月次見通し・案件台帳・顧客）へのリンク。
  - 未受注見込の総額・確度加重額：案件見込の集計（受注前の各案件の最新の採用版）。見込額・確度が未設定の件数を添える。
  - 今月・来月の売上見通し：月次見通しの合計（計上済み＋受注済みの売上予定＋未受注の確度加重見込）。受注予定月の集計とは足さない。
  - 注意が必要な案件：見込の未設定・採用版なし・売上予定の不足や不一致がある案件の数（同じ案件は1件と数える）。
  - どれも呼び出した人の案件範囲で集計する。集計を読めないときは0円にせず「権限がありません」などと表示する。デモモードでは集計がないので「—」を表示する。
- items を集計していたグラフとドックのパネル（月別・価格帯・SPC・トレンド）は削除した。ダッシュボードのメモはそのまま残し、既定はフローティング表示。旧レイアウトを読まないよう保存キーを `.v2` に変えた。
- 閲覧公開（ログイン不要の閲覧）で見られる画面はダッシュボードだけになった。
- デモモード（バックエンドなし）の in-memory データは架空の顧客8件・案件24件（`sampleData.ts`）。
- 案件台帳の一覧に列の表示切替（ColumnsMenu）を付けた。

## 6 実装の段階案

| 段階 | 内容                                                               | 完了条件                                 |
| ---- | ------------------------------------------------------------------ | ---------------------------------------- |
| P0   | リポジトリ作成、Banto コピー・リネーム・プリセット、CI             | Banto の既存検証が通る                   |
| P1   | `cost-domain` の計算と受入条件の単体テスト                         | T02, T05, T06, T08, T21, T27, T28 が通る |
| P2   | 能力・案件範囲の認可、案件・顧客・工程マスタ                       | T12, T19, T20（両経路の認可テスト）      |
| P3a  | 顧客・案件台帳・案件見込の版（下書き・採用）・案件見込一覧         | T21, T22, T25（2026-11-06）              |
| P3b  | 受注転換・部分受注・受注変更・売上予定と計上の消し込み・月次見通し | T23, T24, T26, T27（2026-11-06）         |
| P4a  | 計算基準（会社基準の版・案件ごとの上書き・影響の事前確認）         | T31〜T35（2026-11-06）                   |
| P4   | 予算版・工数・単価・直接費・発注                                   | T02〜T05, T09, T10, T14                  |
| P5   | 完了見込版・注意表示・全体一覧                                     | T06, T28, T30                            |
| P6   | 承認・締め・訂正・CSV                                              | T11, T13, T15, T17                       |
| P7   | バックアップ復元の確認、代表案件での試行                           | T18、手計算との照合                      |

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
- 「済」「営業中」「実行中」の定義と、売上計上の時点（検収・請求・月額の当月）。
- 社員の時間原価単価をどう決めるか（現行は未計上）。
- 外注先の月額固定払いの契約内容（前払か、上限つきの精算か）。
- 月次作業報告書を工数・外注実績の証憑として取り込むか。

## 10 年度と計算基準の設定（2026-11-06 決定）

### 10.1 年度

- 年度は6月開始。画面・CSV・集計条件では期番号で表示する（例：第13期＝2026年6月〜2027年5月）。
- 会社設定に「年度開始月」と「基準期（期番号と開始年の組）」を持ち、期番号は日付から計算する。月次集計・当期累計・年度またぎ（T15）はこの定義に従う。

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

| 番号 | 確認する操作・条件                             | 合格条件                                                                             |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| T31  | 会社基準の単価を適用開始日つきで変更           | 新しい版が追加され、以前の版と履歴が残る。適用開始日より前の作業日には旧版が使われる |
| T32  | ある案件だけ見込み用単価を上書き               | その案件の下書き見込だけが再計算され、他の案件と採用済みの見込版は変わらない         |
| T33  | 承認済み工数がある期間へさかのぼって単価を変更 | 承認済みの原価は自動で変わらず、再計算訂正の候補として件数と明細が出る               |
| T34  | 上書きを「会社基準に戻す」                     | 以後の対象日は会社基準の値になり、上書きの履歴は残る                                 |
| T35  | 権限のない役割で計算基準を変更                 | 画面・API のどちらからも変更できない。個人別単価は経理以外に見えない                 |

### 10.8 実装（P4a、2026-11-06）

- マイグレーション `0013_calc_basis.sql`（SQLite / Postgres）：`calc_items`（10.3 の12項目。値の種類・単位・案件で上書きできるか・責任者も上書きできるか・変更権限）と `calc_values`。項目だけを登録し、値は登録しない（未設定を0にしない）。個人別・等級別の単価（`target_kind`・`target_id`）は工数を扱う段階で足す。
- 会社基準の変更権限は、労務・外注の単価と1日の基準時間が `finance.rate`、旅費・税・入力・注意表示が `finance.close`。案件の上書きは、変更権限を持つ人ならどの案件でも、10.3 で「案件責任者」も可とした項目はその案件の責任者もできる。どれも `amount.view` が要る。
- 計算規則は `cost_domain::calc_basis`（適用値の解決、追加の検査、値の範囲 `ValueKind`、版番号、上書きで影響しない案件）。サービスは `admin_template_core::calc_basis`。
- 行は追加だけで、書き換え・削除はしない。同じ項目・範囲・適用開始日の行と、同じ版番号の行は一意索引でも拒否する（同時保存の二重登録を防ぐ、T13）。案件の「会社基準に戻す」は値なしの行（T34）。
- 影響の事前確認（10.5）：変更前後の適用値、会社基準の変更で上書き中のため影響しない案件、値が変わる案件・承認待ち・訂正候補の件数、締め済みの月を含むか。工数・費用・見込の明細は P4b 以降で足すので、それまでは明細の件数は0件になる。
- 監査ログの詳細には項目・範囲・案件・適用開始日・版番号だけを残し、値（単価）は残さない（監査ログはシステム管理者が見るため、仕様4章・11章）。
- 画面：`/calc-basis`（基準日の値・版・予定の変更・上書き中の案件数・履歴・変更フォーム）、案件詳細の「計算基準」（会社基準・この案件の適用値・出典・上書きの履歴・上書きと会社基準に戻す）。保存は「影響を確認」した入力のままのときだけできる。
