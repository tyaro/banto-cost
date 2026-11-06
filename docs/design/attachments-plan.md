# M20: 添付ファイル/画像管理 計画書

作成日: 2026-07-15  
状態: 実装済み（単位A〜D完了。単位Dで検出した effect ループは §9 のとおり解消済み。
2026-09-24: PostgreSQL の保存先を §3.3 のとおり変更、#208）  
提供形態: `banto-attachments` クレート + `@banto/attachments` パッケージ +
削除可能なデモ配線（roadmap.md「M19〜M21 の提供形態」の決定に従う）

## 1. 目的

任意のリソースのレコードに対するファイル添付（アップロード・一覧・
ダウンロード・削除）と、画像のサムネイル表示を提供する。写真帳・現品写真・
検査記録（industrial-plan.md）の土台となる汎用機能であり、テンプレートには
items への添付として「core/Tauri/REST 三経路配線の見本」を削除可能な形で
同梱する。

## 2. スコープ

### 2.1 やること

- 汎用の添付メタデータテーブルとファイルストレージ（リソース名 +
  レコードIDに紐づく複数ファイル）
- 画像（JPEG/PNG/WebP/GIF）のサムネイル自動生成
- REST（LAN ブラウザ）と Tauri コマンドの両経路
- RBAC（閲覧 = viewer 以上、追加/削除 = editor 以上）と監査ログ記録
- `@banto/attachments` の UI（添付パネル: 一覧・サムネイルグリッド・
  アップロード・削除）
- items 詳細ページへのデモ配線（削除可能。template-scope.md §3 へ行追加）

### 2.2 やらないこと（v1 非スコープ）

- 添付ファイルのバックアップ同梱（M17 バックアップは SQLite ファイルのみ。
  §8 の既知の制限として明記し、バックログへ「添付を含むアーカイブ形式」を
  積む）
- 画像編集・回転・EXIF 処理、動画サムネイル
- 全文検索・タグ付け・添付単独の一覧画面
- ブラウザデモモードでの動作（backups と同様「この機能は Tauri/LAN で
  利用できます」の案内を表示。InMemory 実装は作らない)
- クラウドストレージ（S3 等）対応（AttachmentStore の抽象は切らない。
  必要になった時点でサービス層ごと差し替える方が薄い)

## 3. 設計

### 3.1 配置と責務分担

| 層 | 場所 | 責務 |
|---|---|---|
| サービス | `crates/banto-attachments`（新クレート） | メタデータ CRUD、ファイル保存/削除、サムネイル生成。リソース非依存（`resource: &str` + `resource_id: &str`）。tauri/axum 非依存で cargo test 可能 |
| マイグレーション | `apps/admin-template/core/migrations-sqlite/0006_attachments.sql`（+ `migrations-postgres/0006_attachments.sql`） | テーブル定義はアプリが所有（既存方針どおり）。クレートは要求スキーマをドキュメントで規定 |
| 配線 | `core/src/rest.rs`・`src-tauri/src/lib.rs` | ルータ/コマンド、認証・RBAC（RoleGuard / require_role）、監査記録。既存 items/backups と同型 |
| フロント通信 | `apps/admin-template/src/lib/banto/attachmentsAdmin.ts` | backupsAdmin.ts と同型の 3-way 分岐（tauri/server/demo）。アプリ側（コピーして書き換える対象） |
| UI | `packages/attachments`（`@banto/attachments`） | AttachmentsPanel ほか。通信は `AttachmentsClient` インターフェース経由で受け取り、アプリ固有 import なし（昇格済みパッケージの規律) |
| デモ配線 | `items/[id]/+page.svelte` | `.form-panel` 直後に AttachmentsPanel を挿入。削除可能 |

クレート化の判断: 添付はリソース非依存の汎用機能で banto-industrial 側の
消費も見込まれるため、items/audit のような core モジュールではなく
決定済み方針どおり共有クレートとする。クレートの依存は
`banto-core`（BantoError）+ `sqlx` + `tokio` + `image` に限定する。

### 3.2 DB スキーマ（0006_attachments.sql）

```sql
CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  resource    TEXT    NOT NULL,           -- 'items' など
  resource_id TEXT    NOT NULL,           -- 汎用化のため TEXT（items は i64 を文字列化）
  file_name   TEXT    NOT NULL,           -- 表示用の元ファイル名（パスには使わない）
  mime        TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT    NOT NULL,           -- 整合性確認・将来の重複検出用
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,           -- ISO 8601（既存の日付自前実装を流用）
  created_by  TEXT                        -- username（監査と同様、表示用）
);
CREATE INDEX idx_attachments_record ON attachments(resource, resource_id);
```

`backup.rs` の `REQUIRED_TABLES` には**追加しない**（attachments を持たない
古いバックアップのリストアを塞がないため）。

### 3.3 ファイルストレージ

- 保存先: `db_path.parent()/attachments/`（`backup.rs` の `base_dir()`
  パターンを踏襲。Tauri は app_data_dir、banto-serve は BANTO_DB の隣）。
  **PostgreSQL のときは別規則**（2026-09-24、#208）: 接続 URL はパスではない
  ので、`BANTO_ATTACHMENTS_DIR`（必須。未指定なら banto-serve は起動しない）の
  下に、DB ごとのサブディレクトリ `pg_<ホスト>_<ポート>_<DB名>_<ハッシュ16桁>`
  を作る（`banto_attachments::base_dir_for_target` / `postgres_storage_key`）。
  ユーザー名・パスワードは含めない（変えても保存先は変わらない）。以前の版が
  URL から作った資格情報入りの旧保存先は、起動のたびに sha256 を照合して新しい
  保存先へコピーする（`import_legacy_files`。旧保存先のファイルは消さない。
  一時ファイルは処理ごとに一意、確定はハードリンクで既存を上書きしない。既にある
  本体も sha256 を照合し、サムネイルは本体と別に欠けていれば再試行する）
- **本体は上書きしない**（#208）: `{id}` が既にあればアップロードを失敗させる
  （`create_new`）。id はどちらのバックエンドでも再利用されないので、既存の
  ファイルは保存先の共有か、古い DB の復元でしか起きない
- ファイル名は **サーバ採番の `{id}` のみ**（本体 `{id}`、サムネイル
  `{id}.thumb.jpg`）。ユーザー入力の `file_name` はパスに一切使わない
  （パストラバーサル対策。表示と Content-Disposition のみに使用し、
  ヘッダ出力時はエスケープする）
- 削除はメタデータ行 → ファイルの順（ファイル削除失敗は警告ログのみ。
  孤児ファイルは致命でない）

### 3.4 サムネイル

- 対象: `image::guess_format` がマジックバイトで JPEG/PNG/WebP/GIF と
  判定したもの（クライアント申告 MIME は信用しない。判定結果を `mime` に
  正規化して保存）
- 非対象ファイルは汎用ファイル扱い（`has_thumbnail = 0`、UI は種別
  アイコン表示）
- 生成: 長辺 256px に縮小、JPEG（品質 80）で `{id}.thumb.jpg` に保存。
  アルファは白地に合成。生成失敗（破損画像等）はアップロード自体を
  失敗させず `has_thumbnail = 0` で続行
- サムネイルのファイル書込失敗に加え、**`has_thumbnail` を 1 にする DB 更新の失敗**
  （SQLite / PostgreSQL 共通）も補助処理の失敗として扱う（#285）: 本体・
  メタデータは確定済みなのでアップロードは成功（`has_thumbnail = 0`）とし、
  警告ログを出して生成済みの `{id}.thumb.jpg` を best-effort で削除する
  （参照されない孤児を残さない。削除失敗も警告のみ）。これにより呼び出し側
  （REST / Tauri）は成功監査と変更通知まで到達し、利用者の再試行による
  重複登録も起きない。本体保存自体の失敗時は従来どおり行を削除してエラー
- **新規依存**: `image` クレート（features を jpeg/png/webp/gif に限定)。
  ワークスペースの「依存を足さない」方針の明示的な例外とする — 画像
  サムネイルは M20 の中核価値で自前実装は非現実的。依存は
  `banto-attachments` クレートのみが持つ。あわせて `sha256` 計算のため
  `sha2`（transitive に既存）を直接依存へ格上げ

### 3.5 API

REST（`attachments_router`、read = Viewer / write = Editor の RoleGuard、
既存 items ルータと同じ2分割構成）:

| メソッド/パス | 権限 | 内容 |
|---|---|---|
| `POST /api/attachments/list` | Viewer | `{resource, resourceId}` → メタ一覧（作成日降順） |
| `GET /api/attachments/{id}/download` | Viewer | 本体バイト列 + Content-Disposition |
| `GET /api/attachments/{id}/thumbnail` | Viewer | サムネ JPEG（無ければ 404） |
| `POST /api/attachments?resource=&resourceId=&fileName=` | Editor | raw `Bytes`（`application/octet-stream`）→ 作成済みメタ JSON |
| `DELETE /api/attachments/{id}` | Editor | 削除 |

- アップロードは **multipart を使わず** backups リストアと同じ
  raw Bytes + クエリメタデータ方式（既存の設計判断を踏襲、依存追加なし）
- サイズ上限: `DefaultBodyLimit::max(MAX_ATTACHMENT_BYTES)` =
  **25MB/ファイル**（定数。備考として計画書に明記し、変更はコード1箇所）

Tauri コマンド（AppState に `attachments: AttachmentsService` を追加）:

- `attachments_list` / `attachments_delete` / `attachments_thumbnail`（`Vec<u8>` 返却）/
  `attachments_download_to`（保存ダイアログの代替として §3.6 参照）
- `attachments_upload`: バイナリは Tauri v2 の raw payload
  （`tauri::ipc::Request`、フロントから `Uint8Array` を invoke body で送る)
  を第一候補とする。実装検証で不安定な場合のフォールバックは base64 JSON
  （実装は attachmentsAdmin.ts とコマンド内に隔離されるため差し替え可能）

監査: upload → `action:"create"`, delete → `action:"delete"`,
`resource:"attachments"`, `detail: {fileName, sizeBytes, parentResource, parentId}`。
ファイル内容は記録しない（既存の鉄則どおり）。

### 3.6 Tauri でのダウンロード

webview にダウンロード機構がないため（backups と同じ制約）:

- 画像はサムネイル/本体をパネル内で直接表示（object URL）
- 「保存」は v1 では `attachments_open_folder`（backups_open_folder と
  同型、attachments ディレクトリをエクスプローラで開く）で代替。
  ネイティブ保存ダイアログ（tauri-plugin-dialog）は依存追加になるため
  v1 では見送り、必要が確認されたら追加

### 3.7 `@banto/attachments`（UI パッケージ）

- `packages/attachments`（forms/charts と同じ生ソース参照構成）
- エクスポート: `AttachmentsPanel.svelte`、`AttachmentMeta` 型、
  `AttachmentsClient` インターフェース（list/upload/delete/thumbnailUrl/
  downloadUrl または download バイト取得。実装はアプリ側の
  attachmentsAdmin.ts が提供し props で注入）
- パネル構成: サムネイルグリッド（画像）+ ファイル行（非画像）、
  アップロードボタン（`<input type="file">`、`canWrite` で制御）、
  削除（確認付き）、進行中/空/エラーの内部状態はパッケージが所有
  （所有権境界の既存ルール）
- スタイルは `--banto-*` トークンのみ。Glass では不透明面を維持

### 3.8 デモ配線（削除可能）

- `items/[id]/+page.svelte` の `.form-panel` 直後に
  `<AttachmentsPanel client={...} resource="items" resourceId={parsedId} {canWrite} />`
  を追加（`idValid && !isNotFoundError` でガード。新規作成ページには
  置かない — id 未確定のため）
- items 削除時に `delete_for_record("items", id)` を REST/Tauri 両
  ハンドラから呼び、孤児メタデータを掃除（配線例として同梱）
- template-scope.md §3 の表へ行追加 + README「オプション資産の削除」節へ
  削除手順（パッケージ依存・パネル・attachmentsAdmin・ルータ/コマンド・
  マイグレーションの外し方）を追記

## 4. 実装単位

| 順序 | 内容 | 主な対象 | 規模 |
|---|---|---|---|
| A | クレート本体（サービス・ストレージ・サムネイル・単体テスト）+ マイグレーション | `crates/banto-attachments`, `core/migrations-sqlite/0006`（+ `migrations-postgres/0006`） | M |
| B | 配線（REST ルータ・Tauri コマンド・監査・attachmentsAdmin.ts） | `rest.rs`, `src-tauri/lib.rs`, `attachmentsAdmin.ts` | M |
| C | UI パッケージ + items デモ配線 + ドキュメント | `packages/attachments`, `items/[id]`, template-scope/README | M |
| D | E2E（スモークにシナリオ追加: アップロード→一覧→サムネ→削除）+ 全体 QA | `e2e/tests/smoke.spec.ts` | S |

A→B→C→D の順に依存。各単位でレビューと検証（既存の司令塔レビュー体制）を
挟む。

## 5. 検証計画

- クレート単体テスト: メタ CRUD、パストラバーサル拒否（file_name に
  `../` 等を含むケース）、サムネイル生成（小さな実画像フィクスチャ）、
  非画像・破損画像の分岐、25MB 超の拒否
- 既存全スイート: `pnpm check` / `lint` / `test` / `build`、
  `cargo test`（workspace）、スモーク E2E 10件 + 新シナリオ、visual 40件
  （items 詳細は VR マトリクス外のため基準画像追加は不要。パネル追加で
  既存32枚に差分が出ないことを確認）
- LAN セキュリティ観点: 認可なしアクセスが 401/403 になること、
  id 総当たりで他リソースの添付が読めるのは仕様上許容
  （viewer は全添付閲覧可。レコード単位の行レベル認可は v1 非スコープ)

## 6. 完了条件

1. items 詳細で editor がファイルを添付・削除でき、viewer は閲覧のみできる
2. 画像添付にサムネイルが表示され、非画像はファイル行で表示される
3. Tauri・LAN ブラウザの両経路で同一動作（デモモードは案内表示）
4. アップロード/削除が監査ログに記録される
5. 25MB 超・パストラバーサル・破損画像が安全に拒否/処理される
6. デモ配線を README の手順どおり外すとビルド・テストが引き続き通る
7. 既存スイート（check/lint/test/build/E2E/visual）に回帰がない

## 7. 規定値一覧（レビュー時の確認ポイント）

| 項目 | 値 | 根拠 |
|---|---|---|
| ファイルサイズ上限 | 25MB | LAN 内の写真運用を想定した保守的な値。定数1箇所 |
| サムネイル | 長辺 256px JPEG 品質80 | 一覧グリッド用途に十分・生成コスト小 |
| サムネイル対象 | JPEG/PNG/WebP/GIF（マジックバイト判定） | image クレートの安定サポート範囲 |
| 保存先 | `<DBの親>/attachments/` | backups と同じ base_dir 慣行 |
| RBAC | 閲覧 viewer / 追加・削除 editor | items と同じ床 |
| 新規 Rust 依存 | `image`（クレート内限定）、`sha2` 格上げ | §3.4 の明示的例外判断 |

## 8. 既知の制限（v1）

- M17 バックアップに添付ファイル本体は含まれない（SQLite のみ）。
  古い DB をリストアすると添付メタと実ファイルに不整合が生じ得る
  （UI は 404 サムネ/DL をエラー表示で吸収する）。「添付を含む
  バックアップアーカイブ」を roadmap バックログへ追加する
- レコード単位の行レベル認可はない（viewer は任意の添付を閲覧可能）
- デモモード（ブラウザ単体）では利用不可

## 9. 単位D（E2E）で検出したブロッキング不具合（解消済み）

**解消（2026-07-15）**: 下記の推定原因はレビューで確定し、`$effect` 内の
`reload()` 呼び出しを Svelte の `untrack()` で包む修正を適用した
（effect の依存を props の `resource`/`resourceId` の2読取だけに限定し、
`clearThumbnails()` の `thumbnails` 読み書きを追跡外へ出す）。修正後、
スモークE2E 11シナリオ（添付シナリオ含む）を3回連続で全件成功させ、
本節の検出記録は経緯として保存する。

### 検出時の記録（原文）

2026-07-15、スモークE2Eへのシナリオ追加作業中に、items 詳細ページで
`AttachmentsPanel` をマウントすると即座に Svelte の
`effect_update_depth_exceeded` が発生し、`/api/attachments/list` への
リクエストが際限なく（実測1000回以上/数秒）発火し続け、ブラウザタブが
クラッシュする不具合を検出した。

- **再現条件**: items 詳細ページを開くだけ（`idValid && storeReady &&
  isAttachmentsAvailable()` が真になった時点）で発生。role（admin/viewer）・
  添付の有無を問わず再現する。既存のスモークE2E（旧10シナリオ）でこれまで
  検出されなかったのは、item 詳細ページへの滞在時間が短く（編集して即座に
  一覧へ戻る）、ページ遷移でパネルがアンマウントされ都度ループが中断されて
  いたため（`git stash` で旧10シナリオのみに戻し再検証し、22秒で10/10成功
  することを確認済み）。滞在時間が伸びる操作（添付のアップロード/削除を
  行うシナリオ、またはページに留まる viewer 閲覧シナリオ）で必ず露呈する。
- **推定原因**: `packages/attachments/src/AttachmentsPanel.svelte` の
  `$effect`（`resource`/`resourceId` を読んで `reload()` を呼ぶブロック）が
  `reload()` を `await` なしで同期的に呼び出しており、`reload()` 冒頭の
  `clearThumbnails()` が同一 `$state`（`thumbnails`）を
  `for (const url of thumbnails.values())` で**読み**、直後に
  `thumbnails = new Map()` で**書く**。この読み書きが `$effect` の同期実行
  区間内で起きるため、`thumbnails` への書き込みが同じ `$effect` 自身を
  再スケジュールし、無限ループになっていると推測される（未確定・要検証）。
- **対応**: 本セッションはテスト/ドキュメントのみに限定されていたため、
  `packages/attachments` のコード修正は行っていない。次のセッションで
  上記の推定原因を起点に修正し、`e2e/tests/smoke.spec.ts` のシナリオ6
  （viewer の読み取り専用確認）・シナリオ8（アップロード/サムネイル/削除）
  を3回連続成功させてから、roadmap.md M20 を「完了」に更新すること。
