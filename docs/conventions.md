# Banto 保守者向け規約 — 変えてはいけない不変条件

> English: [conventions.en.md](conventions.en.md)

対象読者: **このテンプレート自体を保守・機能拡張する人**（トラックA）。
テンプレートから自分のアプリを作る利用者向けの手順は
[README](../README.md) 側（トラックB）にある。両トラックの区別は
[README「ドキュメントの2トラック」](../README.md#ドキュメントの2トラック)を参照。

位置づけ: 各モジュール冒頭の doc コメントに散在していた「なぜこう書くか」の
規約を、機能追加のたびに参照できるよう1箇所に集めたもの。ここに書いた項目は
**機械（lint/型/CI）では強制しきれず、レビューで守る不変条件**に限る。一般的な
言語スタイル（命名・整形）は eslint/prettier/clippy/rustfmt に委ねており、本書の
対象外。

ドキュメントの3分類（2026-07-19 追記、improvement-plan P4-7）: 「なぜ」は
3つに役割分担する — **コードコメント**（その場でしか意味を持たない局所的な
理由）/ **本書**（横断的な不変条件＝守るべきルール）/
**[ADR](adr/README.md)**（代替案を比較して1つを選んだ設計判断＝なぜその
ルールにしたか）。本書の各不変条件の背後にある「なぜ」で、代替案の比較を
伴うものは対応する ADR から辿れる（例: §1・§2 → [ADR-0001](adr/0001-rest-tauri-two-path-symmetry.md)、
§3 → [ADR-0002](adr/0002-minimal-dependencies.md)）。同じ「なぜ」を2箇所に
書かない。

機械検査（2026-07-19 追記、improvement-plan P3-5）: 本書のうち機械検査
可能な項目は `pnpm verify:architecture`（`scripts/verify-architecture.mjs`、
CI の frontend ジョブで強制）が検査する。対象は各節に **[機械検査済み]** と
注記した — それ以外は引き続きレビューで守る。意図的な例外はコード内の
正当化コメント + スクリプトの許可リスト（理由付き）のペアで管理する。

削除可能性: 本書はトラックA の資産であり、アップストリームを追わず
**ハードフォークして独自進化させる**なら丸ごと削除してよい（テンプレートの
「すべては削除可能」方針に従う）。アップストリームを追い続ける／テンプレートを
保守し続けるなら残す。

参照の書き方: 行番号は変化するため、本書は原則**ファイル + シンボル名 + 仕様節**で
参照する。実際のコードが一次情報であり、食い違いがあればコードを正とする。

---

## 1. REST と Tauri の判定対称性 [機械検査済み: mutating 操作の両経路存在]

すべての mutating 操作（create/update/delete/import/login/logout/setup）は、
**REST 経路と Tauri 経路の両方で同一の認可と同一の監査を通す**。origin
（`"rest"` / `"tauri"`）だけが異なる。

- REST: `banto-server` `routes/mod.rs` の `RoleGuard` / `require_role_at_least`
  + `record_write`（V2 テーマC PR-C4 で `admin-template-core` `rest/mod.rs` から
  移設。アプリ側 `rest/items.rs`・`rest/attachments.rs` はこれを import して使う）。
- Tauri: `src-tauri/src/lib.rs` の `require_role`（doc コメントに
  「mirrors REST's `RoleGuard`」と明記）+ 各コマンドの `audit.record(...)`。
- 対応表は `rest/mod.rs` のモジュール doc（仕様 M14）にある。
- **読み取り系（list/get）は両経路とも監査しない**。denied 記録は
  「認証済みだがロール不足」のみ。無セッション（Unauthorized）は記録しない
  — この判断も両側で揃える。

機能追加時: 新しい mutating コマンドを片方の経路にだけ足さない。両経路 +
両経路の denied を必ずペアで実装・テストする（template-scope §6 チェックリスト④⑤）。

**機械検査（`verify:architecture` rule 8、CR-1）**: mutating 操作が REST/Tauri
両経路に存在することを、`scripts/verify-architecture.mjs` の `DUAL_PATH`
マニフェスト + 完全性チェックで担保する。新しい Tauri コマンド / REST ルートを
分類（dual-path / desktop-only / read）に足さない限り CI が落ちるため、**片方の
経路にだけ足すミスは必ず捕捉される**。宣言済みの対は**ロール床（認可レベル）も
rule 8 が両経路で照合する**（CR-6。`DUAL_PATH` の `role` フィールド +
読み取り系の `ROLE_READ`）。機械検査の対象外は**監査記録の同一性**
（同じ `AuditEntry` 形状か）のみで、そこはコード + テストで担保する。
desktop-only / read の分類判断は maintainability-review-2026-07.md §3 に根拠。

**監査記録の canonical 形状**（機械検査外＝コード+テストで揃える規約。逸脱は
maintenance-review-2026-08 §5.3 で実測・是正済み）:

- **`resource` は操作対象で決める。** audit-log の**保持ポリシー設定**
  （`audit_config_get`/`apply`）は監査ログ本体ではなく設定の読み書きなので、
  成功・denied とも `resource: "settings"`（監査ログ本体を読む
  `audit-log/list` だけが `"audit_log"`）。REST では `audit_log_router` を
  list / config の2ガードに分けて実現。denied と成功で `resource` を揃えると、
  管理者が resource でフィルタしたとき拒否と成功が同じ束に入る。
- **`entity_id` は「対象の実体名」。** backup 系は必ずバックアップファイルの
  実名（`backups_create` / 既存ファイルからの restore は `Some`、アップロード
  からの restore はサーバ採番前で実体名が無いので `None` + `detail.fileName`）。
- **denied の `detail` は経路で非対称を許容する。** REST は RoleGuard
  ミドルウェアの都合で `{method, path}` が付くが Tauri は `None`。denied は
  「操作が実行されなかった」記録なので監査の主眼は「誰がどの `resource` へ
  拒否されたか」であり、個別操作の特定は不要（実行された操作は成功時の
  `action`/`entity_id` に残る）。この非対称は意図的。
- **REST のログインは argon2 前スロットルでロックアウト中の試行（429）を
  記録しない**（`login_failed` は verifier 到達時のみ）。監査ログ自己 DoS を
  避けるための意図的な非対称で、Tauri 経路（ローカル入力・スロットル無し）は
  全失敗を記録する。ロックアウト自体はレート制限器の状態として別途観測できる。
- **資格情報なしで叩ける認証系は監査を増幅させない**（Issue #278）。REST の
  `POST /api/auth/logout` は**実際にセッションを終えたとき（有効トークンで actor が
  解決できたとき）だけ**記録する（トークン無し・無効・失効済みは記録しない。Tauri の
  `auth_logout` も元から「クリアしたときだけ」記録で同じ）。`login_failed` の
  `actor_username` は呼び出し側指定で実在アカウントとは限らないため、
  `users::bound_username_for_audit` で作成時上限（`MAX_USERNAME_LEN`＝32 文字）まで
  char 境界で切り詰め、末尾 `…` で切り詰めを明示する（REST・Tauri 共通）。
  上限超の username は `UsersService::verify` で DB を引かず、ダミー hash の検証だけ
  行って `None` を返す（存在しないユーザーと同じ応答・同程度の時間）。スロットルの
  キーも username 64 文字で打ち切る。保持処理（起動時・一覧取得時）は書き込みごとの
  上限保証ではないので、書き込み側でこの 2 経路を絞ることが容量の守りになる。

## 2. サービス層は tauri / axum / RBAC / HTTP を知らない [機械検査済み: tauri/axum 非依存のみ]

全サービス（`ItemsService` / `AuditLogService` / `BackupService` /
`SettingsService` / `UsersService` / `banto-attachments` の
`AttachmentsService`）は同じ形を守る:

- `#[derive(Clone)]`（`Db`（Arc-backed なプールの enum ラッパ）/
  `broadcast::Sender` / `PathBuf` は Arc-backed か read-only で clone が安い）。
- `Result<_, BantoError>` を返す。`tauri` / `axum` に依存しない。
- 認可・監査・イベント通知は**呼び出し側（REST/Tauri の wiring 層）が付ける**。
  サービスは actor / RBAC / HTTP を知らない（`audit.rs` doc:
  「This service does not know about actors, RBAC, or HTTP」）。

効果: サービスは `cargo test` で `:memory:` プールから直接叩ける。各サービスの
`#[cfg(test)] mod tests` がこの形を前提にしている。新サービスもこの契約を守る。

意図的なトレードオフ: `Db` は `Db::Sqlite(..)` / `Db::Postgres(..)` の enum で、各サービスのメソッドが
match で両バックエンドの SQL を書き分ける（約 50 対）。マクロや trait では畳まない — 両バックエンドの
SQL の違いが読めることを優先する。match の片方の腕だけを直して両バックエンドの挙動がずれた不具合
（パリティの回帰）は 2026-10 時点で履歴に無い（片方のバックエンドに固有の不具合は別で、合図に数えない）。
見直しの合図は 3 つ目のバックエンドを足すとき、またはそのパリティの回帰が出たとき
（maintenance-review-2026-10 §5。前回の約束は maintenance-review-2026-08 §3.3）。

## 3. 依存を足さない（自前実装の文化）

ワークスペース（ルート `Cargo.toml`）は依存を厳選し、以下を**入れていない**。
それぞれ自前実装で代替している:

| 引きたくなる依存 | 代わりに | 実装箇所 |
|---|---|---|
| `chrono` / `time` | 手書きの日付変換 | `backup.rs` の `iso_datetime_from_system_time` / `compact_stamp`。Howard Hinnant の `civil_from_days` は3箇所に移植（`banto-attachments`・`backup.rs`・app `core/src/db.rs`。4箇所目が生えたら `banto-core` への一本化を判断する） |
| MIME 検出ライブラリ | マジックバイト判定 | `banto-attachments` `detect_mime`（下記§6） |
| `multipart` | 生バイト body + `?fileName=` クエリ | `banto-server` `routes/backups.rs`・app `rest/attachments.rs` のアップロード |
| `tower-http` | `axum::middleware::from_fn` の手書き | `security_headers.rs` / `csrf.rs` |
| markdown ライブラリ | 自前パーサ + エスケープ | `packages/report/src/core/{parse,bind,html}.ts`（deps 空） |
| `tracing` | `eprintln!` | `audit.rs` |

規約: 上記のどれかを引きたくなったら、それは設計判断であり**議論の対象**。
安易に追加しない（バイナリ肥大・監査面拡大・利用者のコピー負荷を避ける）。

判断基準（2026-07-18 追記、improvement-plan-2026-07.md P1-5）: 目的は
「依存ゼロ」ではなく**総保守コストの最小化**。以下に複数当てはまる場合は
依存の採用を前向きに検討する:

- 自前実装が肥大化する（目安: 100〜200行超、または仕様拡張が始まった）
- セキュリティ境界に関係する（自前だと脆弱性修正を自力で追う必要がある）
- Unicode・日時・暗号・パーサ等、エッジケースが多い領域
- crate/パッケージが十分成熟している（メンテ実績・依存の少なさ）
- feature 限定で必要部分だけ引ける
- バイナリ/バンドルの増加量を測定して許容範囲と確認済み

逆に、どれにも当てはまらない小さな自前実装は現状維持でよい。既存の
自前実装（§3 の表）を予防的に置き換えることはしない — 各実装が上記に
実際に該当し始めた時点で個別に判断する。

個別の「足すか否か」の保留判断は ADR に残す（代替案比較込み）:
**サーバログ（`tracing` を入れず `eprintln!`）は [ADR-0004](adr/0004-server-logging-eprintln.md)**、
**LAN の TLS（rustls を入れずリバースプロキシ終端）は [ADR-0003](adr/0003-tls-via-reverse-proxy.md)**。
いずれも「今は足さない・再検討条件つき」の Accepted。

**依存を足す側の例外も ADR に残す**: UI i18n ランタイムに Paraglide JS を引く判断は
[ADR-0005](adr/0005-i18n-paraglide.md)（本表・本方針は維持したまま、i18n に限った
意図的な例外。コンパイル時 i18n で実行時依存は極小・型安全という P1-5 基準での採用）。
i18n は app 層のみで、`@banto/*` には辞書も i18n 依存も入れない（§5）。
System Info カードの CPU/メモリ取得に `sysinfo` を feature 限定で引く判断は
[ADR-0013](adr/0013-sysinfo-system-metrics-feature.md)（Paraglide に続く2件目の
「足す」側の例外。P1-5 の複数基準該当 - std だけではクロスプラットフォームに
取れない・3アプリで再実装済み・`system` feature 限定・成熟クレート・バイナリ
増分を実装 PR で測定 - を根拠に採用。`banto-admin-services` の opt-in feature
`system-metrics` に限定し、`SystemMetrics` 型自体は feature 無しでも常時
コンパイルされる）。
Windows のファイアウォールの許可（Issue #219 段階 2）で昇格する補助プログラムに
`windows-sys` と `embed-resource` を直接の依存として足す判断は
[ADR-0021](adr/0021-firewall-elevated-helper.md)（3 件目。既に `Cargo.lock` に推移的に入っている版に
揃え、ビルドに入る crate は増えない。補助プログラムと起動のモジュールに限る。Proposed）。

## 4. コア → オプションの逆依存禁止 [機械検査済み]

コア（`admin-core` / `grid-svelte` / `forms` / `theme` / `ui`）はオプションを import
しない。依存方向は「シェル→オプション 可、オプション→コア 可、
**コア→オプション 不可**」。**コア/オプションの正準リストは
[template-scope.md §3](template-scope.md) の表**（ここに列挙を複製しない —
複製はドリフト源。機械検査 rule 2/6 は `packages/` を動的走査するため
新パッケージも自動で対象になる）。

現状の担保:

- 全 `packages/@banto/*` の `dependencies` / `peerDependencies` は空。
- パッケージ間の `from '@banto/...'` import はゼロ。
- `theme/banto.css` の「charts/dock がこのトークンを消費する」等はコメントで
  あって import ではない。

オプションを同梱するときは template-scope §3 の表に行を追加し、
**削除手順（外すファイル一覧）を明文化する義務**を負う。削除して他が壊れない
構造を保つ（§6 チェックリスト②③）。

## 5. パッケージはアプリ固有 import を持たない [機械検査済み: `#lib`（旧 `$lib`）import のみ]

`packages/@banto/*` のコンポーネントは `sessionStore` や
`@banto/admin-core` の `ProviderError` 等の**アプリ固有シンボルを import しない**。
transport は `client: XxxClient` のように注入する（例: `AttachmentsPanel` は
`AttachmentsClient` を受け取り、`attachmentsAdmin.ts`（アプリ側＝コピーして
書き換える層）を package からは決して import しない）。

機械検査: `verify:architecture` の rule `no-app-import` が、`packages/` の import に
アプリのエイリアス（SvelteKit 3 の subpath imports `#lib`。SvelteKit 2 までの `$lib`
も引き続き検出する）が無いことを grep で確かめる（#325）。あわせて rule
`package-bare-imports` が、`packages/*/src` の素の import 指定子を `svelte`・`svelte/*`
（と相対パス）だけに限る（コメントは除いて検査。`$app/`・`@tauri-apps/`・`@lucide/svelte` などで落ちる。
依存を宣言できない§4 のもとで、モノレポでは巻き上げで通り、依存を持たない派生アプリでだけ壊れるのを防ぐ。
ADR-0018 §5）。transport の注入の形はレビューで担保する。

状態所有権: ロード/空/エラー状態はコンポーネント内部が所有し、ホストページに
分岐を漏らさない（grid-svelte と同じ規則）。

## 6. セキュリティ不変条件（横断）[機械検査済み: 一部（mime 無し / settings 対称）]

これらは「守らないと脆弱性になる」種類の規約。ランタイムガードが無い項目は
**全 call site のレビューで担保する**。

- **MIME はマジックバイト判定。クライアント申告を使わない。** `banto-attachments`
  `detect_mime` は `image::guess_format` のマジックバイトで4フォーマットに限定、
  それ以外は `application/octet-stream`。`NewAttachment` は `mime` フィールドを
  持たない（申告を受け取りすらしない）。**[機械検査済み: `NewAttachment` に
  mime フィールド無し（rule 9）]**
- **ファイルパスにユーザー入力を使わない。** 添付本体は行 id で命名し、`file_name`
  は表示専用。バックアップは `safe_backup_path` がセパレータ・`..`・
  `[A-Za-z0-9._-]` 外を全拒否（Content-Disposition 注入・Windows 予約名も同時に
  封じる）。保存先ディレクトリは DB ファイル名ごと（`backups/<DBファイル名>/`、
  設定された DB パス由来でリクエスト入力ではない）で、`scope_dir` の1関数に集約し
  `scope_name` が不正名を明示エラーにする（同一フォルダの複数 DB の混線防止、#280）。
  添付は `validate_file_name` が同種の検査。
- **重い検証（argon2）の前にスロットルする。** `auth/state.rs` `login_rate_limited` は
  per-(IP+username) と per-IP の2次元スロットルを argon2 verifier の**前**に通す
  （username ローテーション flood での DoS 対策）。回帰テスト
  `per_ip_dimension_bounds_a_username_rotation_flood` が「ロックアウト中は argon2 を
  呼ばない」ことを検証。このチェックは**verifier を await する前に検証の枠を
  原子的に予約**する（Issue #279）: 処理中の試行は失敗件数と同様に
  per-(IP+username)・per-IP のしきい値判定に数え、`MAX_IN_FLIGHT_PER_IP`（4）・
  `MAX_CONCURRENT_VERIFICATIONS`（8）で同時実行数も直接制限する。上限超過は待たせず
  通常の `RateLimited` で即時拒否。枠は RAII ガードで、成功・失敗・エラー・
  future のキャンセルのいずれでも解放される。verifier のハッシュ計算は tokio の
  blocking プールで行う。適用範囲は REST のネットワーク境界（`POST /api/auth/login`）
  で、Tauri の `auth_login` はローカル入力のためスロットル対象外（§1 の非対称）。
- **`DefaultBodyLimit` は service 層チェックの上に置く。** transport 上限は
  service 層の実チェック（`MAX_ATTACHMENT_BYTES` 等）より「快適に上」であればよい
  という順序（`rest/mod.rs` の doc とルータ各所）。
- **security headers ミドルウェアは最外層（LAST）に適用する。** `/api/*` と静的
  フォールバックを merge した後に付けることで、新ルートが opt-in を忘れても
  ヘッダが漏れない構造にする（`security_headers.rs`）。
- **監査 detail に秘密を入れない。** password / hash / bearer token を `detail` に
  絶対入れない。ランタイムガードは無く**レビューで担保**。key/value ストアは
  key のみ記録し value は入れない（`settings_set`）。
- **settings の生 key/value 読み取りは admin 対称。** `settings_get` は
  `settings_set` と対称に admin ゲート（任意 key を読めるのは書けるのと同格の
  権限）。UI 設定だけは別コマンド `ui_settings_get`（viewer 可・自名前空間限定）に
  分離する。「同一ストアでも権限の非対称を作らない」。**[機械検査済み:
  `settings_get`/`settings_set` が同一 Admin ゲート（rule 9）]**
- **SQL 列はホワイトリスト経由のみ。** フロント由来のフィールド名は必ず
  `ColumnMap`（`list_query.rs`）で SQL 列に解決し、値は必ずバインドする（文字列
  補間しない）。未知フィールドの sort は無視、filter は hard error。
  `ListParams` を受けるサービス（現状 items / audit）に `column_map()` を置く
  （固定 ORDER BY のみのサービスには不要）。
  **`ORDER BY` の最後には一意キーが付く**（Issue #243）: `append_order_by` は
  `ColumnMap` の一意キー（既定は登録された `id`、別名なら
  `ColumnMap::unique_key`、無いなら `without_unique_key`）を最後の並べ替えと
  同じ向き（並べ替えが無ければ昇順）で足し、`LIMIT`/`OFFSET` のページングで
  同順位の行が重複・欠落しないようにする。`column_map()` の `id` は**一意な列に
  だけ**割り当てる。
  **この並びの決まりは 3 つの実装で共通**（#243 レビュー対応）: SQL
  （`banto-storage`）・InMemory の `DataProvider`（`idField`、既定 `id`）・grid の
  client sort（行の `id`、無ければ `getRowId`）は、**未知の列（SQL は `ColumnMap`
  に無い列、grid は列定義に無い列、InMemory はどの行にも無いフィールド）を先に
  除いてから**、同順位の行を一意キーで残った最後の並べ替えと同じ向きに並べ、NULL はどちらの向きでも最後、並べ替えが無ければ
  一意キーの昇順（grid の client sort だけは、受け取った配列の順を保つ）。
  共通の fixture `crates/banto-storage/testdata/list-order-parity.json` を 3 つの
  テストが読むので、どれかを変えるときは fixture と 3 つを同時に直す。
  **境界（`asOfId`）付きの一覧**（Issue #248、[ADR-0015](adr/0015-snapshot-list-resource.md)）:
  通知なしに行が増減する一覧（監査ログ）は `@banto/admin-core` の
  `SnapshotListResource` で読み、サーバー側は次を守る — 境界の決定・行・件数を
  **1 つの読み取りトランザクション**で行う（PostgreSQL は `REPEATABLE READ`。既定の
  `READ COMMITTED` は文ごとに別の時点を読む）、件数は境界の中で数える、`id` は単調
  増加で再利用しない・行を書き換えない、**行を消す処理は削除の世代（監査ログは
  `settings` の `audit.deletion_epoch`）を削除と同じトランザクションで進め、一覧は
  それを行・件数と同じ読み取りトランザクションで読んで `deletionEpoch` として返す**
  （PostgreSQL では小さい `id` の遅れたコミットと同じ件数の削除が重なると件数が
  変わらない。#256 レビュー）、**境界付きの取得では削除系の副作用（保持期間の
  削除など）を走らせない**（境界の中の削除は画面側で失効として扱うため、取得のたびに
  削除すると 2 ブロック目以降がいつも失効する）。`asOfId` を省略した取得は従来と同じ
  結果にする。
- **CSP は2定義を同期する。** デスクトップは `tauri.conf.json` の
  `app.security.csp`、LAN は `banto-server` の `security_headers.rs`
  `CONTENT_SECURITY_POLICY`。**意図的な差分は connect-src のみ**（Tauri IPC）で、
  それ以外はディレクティブ単位で一字一句一致させる（根拠と `unsafe-inline` が
  必要な理由は `security_headers.rs` 冒頭の doc が一次情報）。編集自体は手動だが、
  **connect-src 以外のディレクティブのドリフトは `verify-architecture.mjs` rule 12 が
  CI で捕捉する**（[ADR-0008](adr/0008-machine-check-stop-gate.md)。src-tauri は
  非コンパイルのため、静かに片方だけ緩む退行を防ぐ）。加えて
  `apps/admin-template/core/tests/tauri_window_csp.rs` が、窓の CSP を
  `SecurityHeaders::new().extra_connect_src(TAURI_IPC_CONNECT_SRC)` の
  `content_security_policy()` と文字列で照合する — どちらかを変えるときは両方を更新する。
- **LAN 応答の connect-src を広げるのは `with_security_headers_using` だけ。**
  アプリ自身のデスクトップシェルが Tauri の WebView で自分の HTTP の画面へ移る場合
  （例: banto-industrial の banto-hub シェル）、その画面には窓の CSP ではなく応答の
  CSP が掛かるので、Tauri IPC が `connect-src 'self'` に止められる。このときは
  `SecurityHeaders` で `TAURI_IPC_CONNECT_SRC` を足し、`request_is_loopback_local`
  で**接続元と宛先（`Host`／`:authority`）の両方がループバックの要求に限る**
  （2026-10-06。LAN のブラウザは厳格なまま）。広げられるのは connect-src だけで、
  ほかのディレクティブとヘッダーは変わらない。リクエストのヘッダー・クエリ・`Host`
  **だけ**で選ばない（相手が決められるため。接続元のループバックとの AND なら狭める
  方向にしか働かない）。接続元だけを見る `request_from_loopback_peer` は、**同じ
  ホストのリバースプロキシがループバック経由でつなぐ構成では、すべての要求の接続元が
  ループバックになり LAN の閲覧者にも広がる**（閲覧者自身の端末の 80 番（http）と
  443 番（https。CSP では http の source が https にも一致する）に届くようになる）
  ので使わない。`request_is_loopback_local` でも、プロキシが `Host` を上流の
  アドレスに書き換える設定（Caddy の `header_up Host {upstream_hostport}`、nginx の
  既定の `proxy_set_header Host $proxy_host`）では効かないので、`Host` を保たせる
  か、広げる設定を入れない。また「`Host` を偽る相手は自分の応答を変えるだけ」は、
  共有キャッシュが `Host` をまたいで応答を使い回さない前提（例: nginx の
  `proxy_cache`＋`proxy_cache_valid`。既定の `proxy_cache_key` は受け取った `Host` を
  含まない）なので、共有キャッシュを前段に置かないか、受け取った `Host` ごとに分ける
  （`proxy_cache_key` に `$host` を含める）。公開側では想定外の `Host` を拒否するか、
  プロキシで CSP を厳格な値に上書きする。影響の分析は `security_headers.rs` 冒頭の doc が一次情報。
- **grant（資格情報なしのセッション発行、ADR-0017。閲覧公開はその 1 種類目
  `publicViewer`）。** 資格情報を持たないクライアントに、登録済みの種類の
  **固定 identity** のセッションを発行する
  （[ADR-0017](adr/0017-credential-less-grant.md)。閲覧公開は
  [ADR-0012](adr/0012-lan-public-viewer-synthetic-session.md)、
  [viewer-public-plan §2.2](design/viewer-public-plan.md)）。認証をバイパスする公開
  ルータは作らない — 発行後のトークンは既存の `require_auth` + `RoleGuard` +
  監査 + SSE の再検証にそのまま乗る。以下はレビューで担保する規約:
  - **発行口は `POST /api/auth/grant/{kind}` だけで、登録済みの `GrantSpec`
    （`GrantSpec::public_viewer` など）から固定の identity を発行する。** ルートは
    クライアントから identity・role を一切受け取らない（**昇格経路を作らない**。
    レビューはまずここを見る）。未登録の種類は 404、条件が偽なら 403 `forbidden`。
  - **条件は要求ごとに評価する**（閲覧公開なら `server.viewer_public`。再起動不要。
    banto-serve と Tauri 組み込みサーバで同一挙動）。状態 `grants.<kind>` と発行は
    同じ `GrantRegistry::availability` を使う。
  - **種類ごとの同時セッション数の上限 `max_sessions`（既定 256）は FIFO。**
    資格情報無しで発行できるので、レート制限ではなく上限で無限増殖を防ぐ。上限到達でも
    発行は失敗せず**その種類の最古のトークンを失効**させる（壁のモニターの再読み込みが
    閲覧を止めない）。他の種類・実ログインセッションは巻き込まない。
  - **寿命は既定 8 時間／アイドル 1 時間で、remember しない。**
  - **管理者相当の種類は `require_loopback_peer` を付ける。** 接続元が不明なら拒否する。
  - **条件を閉じるときは「条件を永続化してから `revoke_grant_tokens(kind)`」を同じ関数の
    中で行う**（世代が、止まっている発行との競合を直列化する。`revokedGrants: n` は監査の
    detail に載せてよい）。実ログインセッションは対象外。
  - **発行は監査しない**（資格情報の検証ではなく、再読み込みのたびに `login`
    を積むと監査ログが埋まる）。grant セッションが mutating を叩いた際の
    `denied` は既存の `RoleGuard` が actor `public` などで記録する。
  - **`POST /api/auth/logout` は自分のトークンだけ失効する**（他の端末に影響しない）。
  - **`change-password` は grant セッションを明示的に拒否する。** 同名の通常
    アカウントが存在しても対象にしない。grant セッションでアカウント系 UI を出さない。
  - **種類名 `account`・`local` は予約**（identity の `kind` に使われる）。
  - **リバースプロキシの注意（ADR-0017 §6）。** 同一ホストのプロキシの後ろでは接続元が
    すべてループバックに見え、`require_loopback_peer` は何も守らない。外部公開の前に
    管理者相当の grant はロックダウンし、再試運転の間も `/api/auth/grant/{kind}` を
    プロキシから外へ公開しない。これは運用ルールで、banto が技術的に強制できるものではない。
  - 「認証無効 + LAN 有効」は**閲覧公開 ON のときだけ**許可する
    （`SettingsService` の両方向ガード、viewer-public-plan §2.3）。OFF のときの
    排他は 2026-07-08 決定のまま。
- **到達確認の口（Issue #219 段階 1、[lan-reach-check-design](design/lan-reach-check-design.md)）。**
  管理者の画面が発行した使い捨てのトークンで「別の端末からこの待受に届いた」ことを記録する、
  grant と並ぶ**もう 1 つの未認証の口 `POST /api/reach-check`** の規約（`banto_server::reach_check`）。
  以下はレビューで担保する（テストは `reach_check/tests.rs`）:
  - **セッションを発行しない。** 応答は `{ "result": "<コード>" }` だけ（コードは Rust、文言は
    クライアント — §13）。`AuthState`・grant・`require_auth` に触らず、成功しても他の `/api/*` は 401 のまま。
    閲覧公開・ログイン不要モードの設定に左右されない。
  - **トークンの条件**: `uuid` v4、期限 5 分（単調な時計）、1 回限り（照合と消費は同じロックの中）、
    同時に 1 つ（新しい発行で前のものを失効）、比較は定数時間（自前の `constant_time_eq`。依存を足さない）。
    期限・世代・ホストの判定は比較で一致した後だけ。使用済み・期限切れ・別の世代・形の不正は同じ `unusable`。
  - **世代で失効する。** トークン・その要求を受けた待受のルーター・保管所の世代が一致するときだけ通す。
    待受の世代を進める側は、同じロックの中で `begin_generation` を呼び、トークンと結果を捨てる
    （適用の失敗で旧 listener を戻すときも同じ）。発行は観測した世代が今の世代のときだけ。
  - **`Host` は発行時のホストと受けた待受のポートに一致させる**（不一致は `hostMismatch` で消費しない）。
    これは貼り替えの検出で、届いた NIC の証明ではない。
  - **接続元はソケットの値（`ConnectInfo`）だけ。** `X-Forwarded-For` 等は読まない。接続元が不明なら拒否
    （fail closed）。loopback と、発行時に列挙したこのPCのアドレスは「このPC自身」として記録も消費もしない。
  - **失敗した照合は接続元 IP ごとに回数制限**（1 分に 10 回で 1 分止め、照合せずに 429 ＋ `Retry-After`。
    表は 256 件で古いものから捨てる）。成功・このPC自身は数えない。
  - **監査しない・トークンを残さない。** 発行も到達も監査せず（資格情報なしの口で監査を増幅させない — §1）、
    トークンは記録・応答・ログ・`Debug` のどれにも出さない。記録はメモリだけ（最新 8 件）。
  - **CSRF の層をルーター自身が持つ**（`X-Banto-Client`）。アプリの `/api` の層の外で merge しても効く。
    未認証の口を増やさないため、発行する画面の無いサーバ（`banto-serve`）には載せない。
- **セッションは要求ごとにアカウントと照合する（Issue #204）。** セッションは
  確立時のアカウントの行 id と `auth_epoch` を持ち、REST の `require_auth`
  （`AuthState::authenticate`）と Tauri の `require_role`（`current_session`）が
  毎回 `users` の行を読み直す。アカウントが無い・どちらかの値が違えば失効させ、
  一致すれば**今の**ロールで認可する
  （[ADR-0014](adr/0014-account-bound-session-revocation.md)）。レビューで担保する規約:
  - **セッションを終わらせるべき書き込みは、同じ `UPDATE` で `auth_epoch` を
    増やす**（ロール変更・パスワード変更・パスワードリセット）。同種の操作
    （アカウントの無効化など）を足すときも同じにする。
  - **アクセスの判断に同期の `verify`/`identity_for` を使わない。**
    `authenticate`（`require_auth`）を通す。`require_auth` の外にあるルート
    （`check`/`identity`/`change-password`）は自分で呼ぶ。
  - **実アカウントの REST `AuthState` は `SessionValidation::Lookup` で組み立てる**
    （`user_auth_state`）。`SessionValidation` はコンストラクタの必須引数で既定値は
    無い。`DisabledNoRevocation` はアカウントの保存先を持たないテスト・公開閲覧専用
    サーバ以外で使わない。照合付きの状態で「作ってそのままログイン」させる経路は
    `issue_account_token` を使う（世代を持たないトークンは拒否される）。
  - **Tauri のウィンドウのセッションは `DesktopSession` の enum で持つ**
    （`Account` / `AuthDisabledLocal`）。読むのは `current_session` だけで、合成
    セッションを `id` などの値で見分けない。
  - 保存先が答えられないときは要求を失敗させる。失効も素通りもさせない。

## 7. `{@html}` は自前生成の全エスケープ済み出力のみ [機械検査済み: 使用箇所の許可リスト]

`{@html}` の使用は最小限に留め、**自前で生成・全エスケープした安全な文字列**に
限る。現状の2箇所:

- `report/src/ReportView.svelte`: 自前エンジン `renderHtml` の出力のみ。
  `html.ts` は全 text/attribute を例外なくエスケープし、`javascript:` src も
  ブロック（「no 'trusted' string anywhere in this module」）。
- `settings/ConnectivitySection.svelte`: `qrcode` クレート生成の SVG（LAN 接続 QR と、到達確認の URL の QR。後者も `LanReachCheckPanel.svelte` へ渡す snippet としてこのファイルで描く — Issue #219 PR-C3。
  settings-split で `settings/+page.svelte` から移動、choiapp-feedback-2026-09 §3.1）。

外部由来・未エスケープの文字列を `{@html}` に流さない。

## 8. Svelte 5 runes の落とし穴

`@banto/*` のコンポーネントで踏みやすい罠。`AttachmentsPanel.svelte` が実例:

- **`$effect` は意図した依存だけを追い、副作用は `untrack` で囲う。** effect 内で
  読み書きする state がトラッキング対象に入ると `effect_update_depth_exceeded`
  （無限ループ）になる。reload 系の同期プレフィックスは `untrack()` で囲む。
- **object URL は所有者が revoke する。** `createObjectURL` した URL は reload /
  teardown / download の `finally` で必ず revoke（`attachmentsAdmin.ts`:
  「Callers own the returned URL's lifetime」）。
- **非同期レースは要求の所有者で無効化する。** admin-core と、admin-core を import できるアプリは
  `createRequestOwner`（`request.svelte.ts`、shared-primitives-upstream-plan §3.1）を使う:
  失効した要求の結果・エラーを反映しない、旧要求の `finally` で新要求の busy を解かない、一時資源は
  `hold` して成功・失敗・失効のどの経路でも一度だけ解放し、採用したものは `adopt` で移す。
  admin-core を import できないパッケージ（§4）は同じ契約を内部に持ち、契約の表
  （`packages/admin-core/tests/contracts/request-owner.json`）を自分のテストで流す。
  `AttachmentsPanel.svelte` の `++loadToken`（superseded な結果を破棄して URL を revoke）は
  この契約の手書きの実例で、置き換えない。

## 9. テーマトークンのみ・生値は theme に集約 [機械検査済み: packages の色値のみ。寸法は未検査]

UI CSS は `var(--banto-*)` トークンのみを使い、色・寸法の**生値をコンポーネントに
書かない**。生値の集約先は `packages/theme/src/css/banto.css`。glass プリセットは
`backdrop-filter: var(--banto-backdrop, none)` のようにオプトインで効かせる
（visual-refresh-design.md）。適用範囲の注記: 機械検査（rule 5 raw-colors）が
走査するのは `packages/` のみ。app 層（`apps/admin-template/src`）の生値は
**正当化コメント付きの意図的例外としてのみ**許容する（login のブランド面・
設定の QR コードの白地（暗い配色でも読み取れるよう固定）等が既存例。理由コメント無しの生値は書かない）。

**寸法**とは、余白・文字サイズ・枠線幅の段階のこと。トークンは `--banto-space-1`〜`-8`・
`--banto-font-size-xs`/`sm`/`md`/`lg`/`xl`・`--banto-border-width`/`-strong`（値と丸めの規則は
[theme-dimension-tokens.md](design/theme-dimension-tokens.md) §5.2）。本文の文字サイズは root の `1rem` を
継承し、トークンを付けない。次は「寸法」に含めず、トークンにしなくてよい（理由コメントも不要）:

- `0`、`em` 単位の値（文脈相対。アイコンと文字の間隔など）、`1px` 未満の調整やヘアラインのオフセット
  （`-1px` の margin など）、`calc()` の中で部品の形から導く値。
- 部品の形（幅・高さ・列幅・アイコンの大きさ）。部品ごとのローカルなカスタムプロパティか、2 つ以上の
  部品・アプリが共有するときだけ用途名のトークン（既存の `--banto-shell-*` のような）にする。
- `3px`・`4px` の縁（左端の強調バーなど）。部品の形として扱う。

寸法の機械検査はまだ無い（レビューで守る）。既存の生の寸法は範囲ごとの PR で段階のトークンへ移している
途中で、移行が終わった範囲から `font-size` と `border-width` の生値だけを検査に足す予定
（theme-dimension-tokens.md §6・D8）。

## 10. 3-way provider 分岐 + demo は明示拒否

環境分岐は `tauri` / `server` / `demo` の3種を `getBantoMode()` で判定し、
**provider 層（`*Admin.ts` / setup）に閉じる**。UI コンポーネントは環境分岐を
持たない。demo モードは InMemory 実装を作らず `DEMO_MODE_MESSAGE` で拒否する
（ブラウザ単体で backend 機能を使わせない）。一部操作のモード制限
（download/upload は server 限定、folder は tauri 限定 等）も provider 層で表現。

LAN 閲覧公開（#189）の `publicViewer` は**4番目のモードではない**。これは
`server` モードの中で「ログイン済みか、合成 viewer セッションか」を区別する
**session 層の状態**（発行元が返す `identity.kind === 'publicViewer'`）であり、provider の
選択には影響しない（grant の種類は provider のモードではない） — 公開閲覧端末も通常の http provider が bearer トークンで
既存 API を叩く（[ADR-0012](adr/0012-lan-public-viewer-synthetic-session.md)
案B の不採用理由）。
通常アカウントも `public` という username を持てるため、identity の id・name・role
から合成セッションを推測しない。属性がない provider は通常セッションとして扱う。

## 11. マイグレーションの流儀

- 連番ファイル名（`0001_items.sql` … `0008_audit_log_pending_id.sql`）を `sqlx::migrate!`
  で埋め込み実行。V2「PostgreSQL アプリ全体対応」以降、方言ごとに2系統に分岐:
  `apps/admin-template/core/migrations-sqlite/`（従来の DDL を後方互換のため
  byte 等価で維持）と `.../migrations-postgres/`（同一スキーマの Postgres 厳密
  型版: `BIGINT GENERATED BY DEFAULT AS IDENTITY` / `BOOLEAN` / TEXT 時刻列は
  `now()::text` 既定 等）。`db::run_migrations` が接続のバックエンドで振り分け。
  **2系統のファイル名/連番の対称は `verify-architecture.mjs` rule 11 が CI で
  捕捉する**（[ADR-0008](adr/0008-machine-check-stop-gate.md)。PG CI は smoke のみで
  各 `sqlx::migrate!` はディレクトリ独立のため、片系統だけ足すと静かに欠落する。
  同名ペア内の型差は上記の意図的分岐でレビュー担保）。
- **リリース済みの migration は追記のみ**（本文・コメントとも 1 バイトも変えない。
  削除・改名もしない）。SQLx は適用した migration の本文をコメント込みで checksum
  して DB に記録し、起動時に照合するため、書き換えるとその版以前に作った DB が
  `VersionMismatch(<version>)` で起動しなくなる。変更は新しい連番で足す。
  **HEAD から辿れる最新の `v*` タグに含まれる `migrations*/` 配下のファイルが
  作業ツリーで不変なことは `pnpm verify:migrations`
  （`scripts/verify-migrations-frozen.mjs`）が CI で捕捉する**（#312 で docs の
  移動に伴いコメント内のパスを書き換えて起きかけた事故の再発防止）。
- **テーブル定義はアプリが所有**。`banto-attachments` は自前マイグレーションを
  持たず、テスト内の `CREATE TABLE` を `0006_attachments.sql` と同期させる
  （「MUST be kept in sync」）。
- リストア検証（`REQUIRED_TABLES`）は Banto 基盤が所有する `settings` / `users` /
  `audit_log` の**テーブル存在のみ**確認し、列は見ない（粗いが安価な「Banto の
  DB か」判定）。派生アプリが差し替え・削除する `items` 等のドメインテーブルは
  必須にしない。
- 検証で開いた接続は全パスで `conn.close()`（Windows のファイルロック残り対策）。

## 12. doc コメントは仕様節を参照する

モジュール冒頭と個別の設計判断で仕様節を引き、設計の「なぜ」を仕様に紐付ける
文化を維持する。新モジュールも冒頭で該当仕様節を引く（参照ファイル数は
`rg -l 'spec §|spec M'` で測る。2026-08 時点で Rust 約40 / TS+Svelte 約159）。

**参照の文法**（接頭辞と参照先の対応）。文書を統合・移動・改名する前に、被参照を
**パス形式（`docs/xxx.md`）とラベル/節番号形式（`spec §N` 等）の両方**で `rg`
して数えること（片形式のみの計測は誤判定の実績あり、maintenance-review-2026-08 §2.1）:

| 表記 | 参照先 |
| --- | --- |
| `spec §N` | `ui-framework-spec.md` の §N（**この表記は ui-framework-spec 限定**） |
| `roadmap MN` / `spec MN` | `roadmap.md` の MN 節（M10 以降の実体は roadmap。spec §15 は初期案 M0〜M9 のみ。新規は `roadmap MN` 表記を推奨） |
| `<文書名> §N` / `<文書名> <節ラベル>` | `docs/design/<文書名>.md` または `docs/reviews/<文書名>.md` の該当節（例 `attachments-plan §3.7`・`session-controller-design §5.2`・`display-preset-plan D1-c`・`choiapp-feedback-2026-09 §3.2`）。文書名はファイル名の拡張子抜きで、配置ディレクトリが変わっても表記は変わらない |
| `conventions §N` | 本書の §N（節番号は不変に保つ） |
| `M-review YYYY-MM §N` | `docs/reviews/feature-review-YYYY-MM.md` の §N |
| `CR-N` / `AD-N` | `docs/reviews/maintainability-review-2026-07.md`（§4 と §7 追補） |
| `ADR-000N` | `adr/000N-*.md` |
| `Discussion #N` | GitHub Discussion（**出典メモ限定** — ADR の「関連」欄・レビュー文書の経緯注のみ可。コード・docs 本文の正規参照には使わない。本文は Discussion を読まずに自立していること。[ADR-0010](adr/0010-discussions-predecision-layer.md)） |

## 13. UI 文言はキー経由（Paraglide）で持つ [機械検査済み: app 層の生日本語リテラル] {#i18n-messages}

§9（色・寸法の生値は theme に集約）の**文言版**。UI に出すテキストは
`messages/{en,ja}.json` のキーに置き、コンポーネントは **Paraglide 経由**
（`import * as m from '#lib/paraglide/messages.js'` → `m['key']()`。`#lib` は
package.json の `imports` による subpath import で、拡張子が必須）で参照する。
生の文言（日本語リテラル等）をコンポーネントに直書きしない
（[ADR-0005](adr/0005-i18n-paraglide.md)）。

- **対象は app 層のみ**（`apps/admin-template/src`）。`@banto/*` パッケージは
  辞書も i18n 依存も `#lib` import も持たず（§5）、文言は**レイヤ①の
  `messages` props 経由**で注入された解決済み文字列として受け取る
  （レイヤ①注入方式、[ADR-0005](adr/0005-i18n-paraglide.md)）。パッケージに
  `messages/*.json` を置かない。
- base/source ロケールは英語（メッセージの真実源）、既定**表示**ロケールは
  日本語（`locale.ts` の custom-banto 戦略で視覚回帰ゼロ、ADR-0005）。
- ロケール解決・永続化は provider/設定層（`locale.ts`）に閉じる（§10）。
  UI コンポーネントはロケール分岐を持たない。
- ブランド名 "Banto" は翻訳しない。ロケール表示名（日本語 / English）は
  各言語のネイティブ名で持ち翻訳しない（両ロケールで同値のキー）。

現状の担保: `apps/admin-template/src` の `.svelte`（生成物 `paraglide/` と
辞書 `messages/*.json` を除く）にコメント外の日本語リテラルが無いことを
`verify:architecture`（rule `raw-jp-in-app`）が grep で検査する（§9 の
生色値検査と同型）。正当な例外はスクリプトの許可リストに理由付きで追加する。

**app 層は preset ごとに opt-out できる**（display-preset-plan.md D1-c、
Issue #190）: `apps/admin-template/package.json` の `banto.i18n` が
`"raw"`（既定は `"keys"` = 今日の挙動）のとき、単一言語アプリとして UI 文言を
直書きしてよい（キオスク／常設ダッシュボードのような display プリセット向け）。
`@banto/*` パッケージ側は無関係— レイヤ①の `messages` props 注入方式は不変。
`banto.i18n = "raw"` のときは `verify:architecture`（rule `raw-jp-in-app`）と
`scripts/check-i18n-nonempty.mjs` が**自身をスキップし、理由を出力**する
（`scripts/lib/i18n-mode.mjs` の `readI18nMode` を両者が共有）。

## 14. `.svelte.ts` ソース配布パッケージは dev optimizer から除外する [機械検査済み]

`@banto/*` はソース配布（`exports` が `./src/index.ts`、`.svelte.ts` を生で出荷。
[publishing.md](publishing.md) / [ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.md)）。
派生アプリでは node_modules 実体になり、Vite dev の依存オプティマイザが `.svelte.ts` を
preprocess せず `svelte.compileModule` に渡して `import type` 等で 500 になる（issue #150）。

不変条件: **`.svelte.ts` を `src/` にソース配布する `@banto/*` パッケージのうち
`apps/admin-template` が依存するものは、`apps/admin-template/vite.config.ts` の
`optimizeDeps.exclude` に必ず列挙する**（新規追加時も同期）。`.svelte` コンポーネント
のみのパッケージ（charts/attachments/report）は preprocess 経路を通るため対象外。`@banto/ui` は
`createToastStore()`（`toast.svelte.ts`、#220 段階 2c）を持つので**対象**（トーストを使わない派生アプリでも、
`@banto/ui` を足すなら exclude に加える）。
`verify:architecture`（rule `optimizedeps-svelte-source`）が「admin-template が依存し
`.svelte.ts` を持つ `@banto/*`」と exclude リストの一致を機械検査する。
外部利用 fixture（`fixtures/external-consumer/`、#271）も同じ集合を dependencies・
`+page.svelte` の import・exclude に持つ（rule `external-consumer-fixture`。`crates/*` の
全 crate が fixture の Rust 側の Git 依存にあることも同じ rule が検査する）。新しい
`.svelte.ts` 同梱パッケージ・公開 crate を足したら fixture にも足す。

---

## プロセス（別ドキュメントに既出）

- **実施プロセス**（司令塔設計 → タスク分割 → モデル委譲 → 検証 → PR + CI ゲート）:
  [roadmap.md §7](roadmap.md#7-実施プロセス)。
- **機能追加チェックリスト**（4条件判定 / 削除手順明文化 / 逆依存禁止 /
  両経路対称 / admin は 403 + UI 非表示の両方をテスト）:
  [template-scope.md §6](template-scope.md#6-今後の運用ルールと宿題)。
- **拡張の提供形態**（パッケージ + 削除可能デモ + レシピ、runtime プラグイン機構は
  作らない）: [template-scope.md §3.1](template-scope.md#31-今後の機能拡張の提供形態2026-07-15-決定)。
- **配布**（git tag / `path:` 依存での消費）: [publishing.md](publishing.md)。
