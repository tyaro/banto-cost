# レシピ: データベースとバックアップ（SQLite / PostgreSQL）

作成日: 2026-10-08（README「主な機能」の DB・バックアップ項から切り出し。
トラックB＝アプリ作者向け）

Banto の対応 DB は **SQLite（既定）と PostgreSQL**。V2 でアプリ全体を PostgreSQL 上でも
動かせるようにした（`banto-storage` の `Db`/`Dialect` による方言吸収 + 方言別
マイグレーション `apps/admin-template/core/migrations-{sqlite,postgres}/`）。仕様は
`docs/ui-framework-spec.md` §12.1。本書は、どちらを使うかの切り替えと、
バックアップ/リストアの運用上の注意をまとめる。

## DB の選択（`BANTO_DB`）

- 既定はローカル SQLite。デスクトップ（Tauri）では
  `%APPDATA%\dev.banto.admin\admin-template.sqlite3`（Windows、識別子はリネーム後の値）、
  `banto-serve` では `./banto-dev.sqlite3`。
- `banto-serve` の環境変数 `BANTO_DB` を `postgres://` URL にすると PostgreSQL 経路になる。
- **PostgreSQL のときは添付ファイルの保存先 `BANTO_ATTACHMENTS_DIR` の指定が必須**
  （DB ごとに `pg_<ホスト>_<ポート>_<DB名>_<ハッシュ>` のサブディレクトリを分ける。
  未指定なら起動しない。#208）。SQLite では使わず、添付は DB ファイルの隣の
  `attachments` に置く。
- 環境変数の一覧（`PORT` / `BANTO_BIND` / `BANTO_VIEWER_PUBLIC` 等）は
  [lan-access.md「`banto-serve`」](lan-access.md#banto-servetauri不要の開発用バイナリ)。

## SQLite バックアップ/リストア（設定画面、M17）

内蔵のバックアップ/リストア（設定画面のバックアップ節。`VACUUM INTO` と起動時の
ファイル差し替えで実装）は **SQLite 専用**。PostgreSQL では明示エラーになる（下記）。

### 保存先は DB ファイルごと（#280 で変更）

バックアップ・適用前の安全バックアップ・リストア予約は **DB ファイルごと** に
`<DBの親フォルダ>/backups/<DBファイル名>/`（例: `data/a.sqlite3` なら
`data/backups/a.sqlite3/`。予約は同ディレクトリの `restore-pending.sqlite3`）へ
置く。同じフォルダに複数の SQLite DB を置いても、互いのバックアップは一覧・取得・
リストアの対象にならず、予約も他 DB の起動時に適用されない。DB ファイル名は
設定されたパスから決まり（リクエスト入力は使わない）、パス区切り・制御文字・
`:*?"<>|` などを含む名前は明示エラーになる。

**旧配置（`backups/` 直下のバックアップ・親フォルダ直下の `restore-pending.sqlite3`）
からの移行**: 旧ファイルは所属 DB を判断できないため一覧・取得・自動適用の対象に
ならず（削除もされない）、起動時に stderr へ警告が出る。引き続き使うバックアップは
新ディレクトリへ手動で移動する（例: `mv data/backups/*.sqlite3 data/backups/a.sqlite3/`）。
旧 `restore-pending.sqlite3` は自動適用されないので、適用したいなら新ディレクトリへ
移すか、設定画面から改めて予約し直す。暫定回避策として DB ごとに親フォルダを
分ける運用も有効（新構成でも安全）。

### バックアップの対象外

添付ファイルの実体（`attachments` ディレクトリ）は内蔵バックアップの対象外
（[design/attachments-plan.md §8](../design/attachments-plan.md) 既知の制限）。ファイルごと
別途コピーする。

## PostgreSQL 利用時のバックアップ運用

内蔵バックアップ/リストアは PostgreSQL では明示エラーになる。PostgreSQL の
バックアップは `pg_dump`（例: `pg_dump -Fc banto > banto.dump`）、復元は `pg_restore`
（または平文形式なら `psql`）を使う。理由（`VACUUM INTO` / 起動時ファイル差し替えの
PG 対応物が無い）は [roadmap.md](../roadmap.md) §3 の V2 テーマA 項（D3）参照。

## 同時アクセスと SQLite（WAL）

デスクトップアプリと組み込み LAN サーバは同一プロセス内で単一のプールを共有するため、
Tauri ウィンドウからの書き込みと LAN ブラウザからの書き込みはそのプールでシリアライズ
される。**同じ SQLite ファイルに別プロセスから同時アクセスしない**こと（WAL が保証する
のは単一ライタまで）。詳細は
[lan-access.md「同時書き込みと SQLite（WAL）」](lan-access.md#同時書き込みとsqlitewal)。

## 新しい版への DB 移行

マイグレーションはアプリ起動時に自動適用され、**前進のみ**（down は無い）。
新版を本番 DB で最初に起動する前にバックアップを取る手順と戻せる境界は
[upgrading.md §4](../upgrading.md)。
