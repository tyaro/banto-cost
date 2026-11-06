# ADR-0019: DB に書けない監査は保留ファイルに退避し、復旧後に `pending_id` で 1 回だけ流し込む

> English: [0019-audit-spool.en.md](0019-audit-spool.en.md)

- 状態: Accepted
- 日付: 2026-10-10
- 関連: tyaro/banto-industrial#437 / [conventions.md](../conventions.md) §1・§3・§6・§11 /
  [ADR-0002](0002-minimal-dependencies.md)・[ADR-0004](0004-server-logging-eprintln.md) /
  `crates/banto-admin-services/src/audit.rs`（モジュール doc が実装の一次情報）

## コンテキスト

`AuditLogService::record` は「監査の書き込みの失敗で、監査される操作を失敗させない」ために、
失敗を `eprintln` で記録して捨てていた（spec M14）。DB が一時的に落ちている・ロックで待たされている
あいだの監査は失われ、さらに DB が応答しないときは `record` が戻らず、操作そのもの（REST の
応答や Tauri のコマンド）も待たされる。banto-industrial（#437）では、PLC への書き込みのような
「操作は済んだが監査が残らない」状態を避けたい。

求められたのは次の 2 つ:

- DB に書けない・応答しないときも、監査の行を失わない（後で必ず `audit_log` に入る）。
- そのときも要求を待たせない（一定時間で `record` から戻る）。

## 決定

`banto-admin-services` の `AuditLogService` に、**任意で付ける保留ファイル（spool）**を足す
（2026-10-10 オーナー決定「おすすめで」）。

1. **置き場所は banto**（`banto-admin-services`）。監査は banto の基盤なので、派生アプリごとに
   作らない。
2. **opt-in**: `AuditLogService::new(db)` は変えず、`.with_spool(dir, SpoolConfig)` で有効にする。
   付けなければ `record` は従来とまったく同じ（タイムアウトなし・`pending_id` なし・`ts` は列の
   既定値）。
3. **マイグレーション `0008_audit_log_pending_id.sql`**（SQLite・PostgreSQL の両方）で
   `audit_log.pending_id TEXT` と一意インデックス `idx_audit_log_pending_id` を足す。NULL どうしは
   衝突しないので、保留を通らない行（`try_record`・保留なしの `record`・既存の行）は NULL のまま。
4. **保留ありの `record` は、書く前に UUIDv4 の `pending_id` と `ts`（呼ばれた時刻）を決める。**
   INSERT は `ON CONFLICT (pending_id) DO NOTHING`。流し込みも同じ `pending_id`・`ts` で同じ
   INSERT をする。タイムアウトした INSERT が後から完了しても、流し込みと合わせて 1 行になる。
   `ts` は各 DB の既定値と同じ書式にする（SQLite は `datetime('now')` の `YYYY-MM-DD HH:MM:SS`
   UTC、PostgreSQL は UTC の時刻を `timestamptz` 経由で `text` にして `now()::text` と同じ書式）。
5. **対象は `record` を通るすべての監査。** `try_record`（監査の失敗で操作を失敗させたい呼び出し
   側）は保留しない。
6. **タイムアウトは既定 3 秒**（`SpoolConfig::timeout`）。失敗・タイムアウトで保留ファイルに書いて
   戻る。タイムアウトした INSERT は**取り消さない**（別タスクで続ける）。
7. **保留の上限は既定 10,000 件**（`SpoolConfig::max_files`）。超えた分は捨てて件数を数え
   （`SpoolBacklog::dropped`）、ログに出す。保留ファイルの書き込み自体に失敗した分も数える
   （`SpoolBacklog::failed`）。
8. **保留ファイルは 1 件 1 ファイル**（`<dir>/<pending_id>.json`）。`.json.tmp` に書いて
   `sync_all` してから rename する。`.tmp` は読まない（60 秒より古いものは流し込みのときに消す）。
   読めないファイルは `<dir>/quarantine/` に移し、他を止めない。
9. **流し込み**は古い順（`ts`、次に `pending_id`）で、行が入ったらファイルを消す（無ければ無視）。
   同じサービスでは 1 本ずつ。複数のプロセスが同じディレクトリを流し込んでも `ON CONFLICT` で
   1 行になる。きっかけは、アプリが起動時に呼ぶ `flush_spool()`、`record` の成功（自分の保留が
   あるとき、または保留ディレクトリを `flush_interval` のあいだ読んでいないとき）、
   `spawn_spool_flusher()` の定期実行（既定 30 秒）。定期実行は**自分の保留が 0 件でも毎回
   ディレクトリを読む**。同じディレクトリを使う別のプロセスが保留したまま終了した分は、
   自分のメモリ上の件数には現れないため（2026-10-10 オーナーレビューで追加。ディレクトリを読む
   のは間隔ごとに 1 回で、空ならログも出さない）。`record` の成功のほうは書き込みのたびに
   ディレクトリを読まないよう、`flush_interval` に 1 回までにした。
10. **流し込んだ行は `detail.spooled = true`**（`detail` がオブジェクトならそこに足し、それ以外は
    `{"value": <元の detail>, "spooled": true}` に包む）。
11. **HMAC などの改ざん検出は付けない。** データディレクトリに書ける者は SQLite のファイルにも
    直接書けるので、保留ファイルだけ守っても意味がない。
12. **保持期間の削除**（`prune`）は、流し込んだ行も `ts` で判定する。保持期間より古い `ts` の行は
    流し込みの直後に消え得る（`ts` は操作の時刻なので、これが正しい）。
13. 状態は `spool_backlog()`（件数・最古の `ts`・`dropped`・`failed`・最後のエラー）で見られる。
    保留したとき・流し込んだときに `eprintln` で 1 行出す（ADR-0004）。標準エラー出力を持たないアプリ
    （Windows サービス）は `AuditLogService::with_log_sink` でこれらの行（`record` の失敗を含む）を
    自前のログへ流せる（`with_spool` の前後どちらで呼んでもよい。共有済みの `AuditLogSink` は `with_shared_log_sink` で渡す。既定は `eprintln` のまま。`tracing` は
    入れない）。
14. banto-industrial の ChronoGazer への適用は後で行う。

## 検討した代替案

- **案A（採用）**: `pending_id` の一意インデックス + `ON CONFLICT DO NOTHING` + 1 件 1 ファイル。
  利点: タイムアウトした INSERT を取り消さずに済み、遅れて完了しても重複しない。複数プロセスでも
  安全。ファイルは原子的に置かれ、壊れた 1 件が他を止めない。欠点: マイグレーションが 1 本増え、
  派生アプリはそれを取り込む必要がある（経路 C）。
- **案B（不採用）**: タイムアウトで INSERT を取り消し、保留だけを正とする。
  取り消しが DB 側で効いたかは分からない（コミット済みで応答だけ遅れた場合がある）ので、重複か
  欠落のどちらかが起き得る。
- **案C（不採用）**: マイグレーションを足さず、流し込み時に「同じ内容の行」を探して重複を避ける。
  同じ人が同じ秒に同じ操作をした正当な 2 行と区別できない。
- **案D（不採用）**: 1 つのファイルへの追記（JSON Lines）。
  途中まで書かれた行・並行する書き手の扱いが難しく、流し込み済みの位置の管理も要る。
- **案E（不採用）**: 保留ファイルに HMAC を付ける。上の決定 11 のとおり守るものが無い。
- **案F（不採用）**: 保留なしでもタイムアウトだけ入れる。待たされなくはなるが、監査を捨てる
  場面が増えるだけになる。保留を付けないアプリの挙動は変えない。

## 帰結

- 保留を使うアプリは**マイグレーション 0008 を取り込む**。取り込まずに保留を有効にすると、
  すべての INSERT が失敗して保留に溜まり、流し込みも成功しない。
- アプリは配線で 3 つを呼ぶ: `with_spool(dir, config)`（DB ごとのディレクトリ）、起動時の
  `flush_spool()`（マイグレーションの後）、`spawn_spool_flusher()`（終了時にハンドルを abort）。
- 監査の一覧では、流し込んだ行は `id` が新しく `ts` が古いので、`ts` の並びと `id` の並びが
  一致しなくなる（境界付きの一覧 ADR-0015 は `id` で切るので、流し込んだ行は次の世代に現れる）。
- 保留ディレクトリの中身は監査の内容そのもの（`detail` を含む）なので、データディレクトリと
  同じ扱いで守る（conventions §6 のとおり `detail` に秘密は入れない）。
- テストは `crates/banto-admin-services/src/audit.rs` の `spool_*`・`pg_audit_spool_*` が持つ
  （失敗型 = 表の改名、応答なし型 = 接続の保持・排他ロック）。CI の app-postgres ジョブで
  PostgreSQL 版も回す。
