# ADR-0015: 通知なしに増減する一覧は、境界（`asOfId`）付きの別クラス `SnapshotListResource` で読み、取得関数を注入する

> English: [0015-snapshot-list-resource.en.md](0015-snapshot-list-resource.en.md)

- 状態: Accepted
- 日付: 2026-09-29
- 関連: Issue #248・#243（PR #246）/ spec §4.1 / conventions §6 /
  banto-industrial #410・#427・#428・#448・#463・#464（同じ直し方の先行例）

## コンテキスト

admin-template の監査ログ画面は、`WindowedListResource` を使わずに画面の中へ
縮小コピー（`AuditLogWindow`）を持っていた。監査ログは `usersAdmin.ts` と同じ
理由（専用のワイヤ形状・Tauri コマンド名）で `DataProvider` の外にあり、
`WindowedListResource` は `getDataProvider()` を前提にしていたからである。
#243 で `WindowedListResource` 側を直したが、コピーには同じ欠陥が残っていた
（修正前のクラスを逐語で写して再現した）:

1. 失敗がトーストでしか見えず、「未取得」「取得失敗」「正常な 0 件」を区別
   できない。再試行の手段も無い。
2. 表示範囲が `{0, 0}`（最初の取得の失敗の後、絞り込みで 0 件になった後）だと
   要求を 1 本も出さず、回復できない。
3. 応答しない要求に期限が無く、`loading` が降りない。
4. 取得の合間に行が増える・消える。監査ログは通知（`invalidate`）なしに増え、
   保持期間の削除で減る。境界が無いので、ブロックの境目で重複・欠落する
   （行が 3 件増えると、次のブロックの先頭 3 行が前のブロックの末尾と重複した）。

1〜3 は `WindowedListResource` に取得関数を注入できれば直る（Issue の A 案）。
4 は世代のスナップショット境界が要る（B 案、オーナー決定）。

## 決定

- `@banto/admin-core` に**別のクラス** `SnapshotListResource`
  （`createSnapshotListResource(fetcher, options)`、`snapshot.svelte.ts`）を足す。
  **取得関数を注入で受け取り**、`DataProvider.getList` の型は変えない。
- 世代の最初の応答が返した境界 `asOfId` を固定し、後続のブロックに渡す。境界が
  決まるまで要求は 1 本だけ。同じ境界で**総件数か削除の世代（`deletionEpoch`）**が
  世代の最初の応答と違う応答は採らず、その世代では続きを読まない（失効）。自動では
  世代を切り直さず、`refresh()`（画面の「再読み込み」）で新しい世代にする。
- **境界だけでは集合は固定されない**（#256 レビューで追記）。境界の中の集合は、
  削除（保持期間）で減り、PostgreSQL では**小さい `id` を採番した書き込みの遅れた
  コミット**で増える（`IDENTITY` の採番はトランザクションの外で進むため）。要求ごとの
  `REPEATABLE READ` は 1 回の応答の中の整合しか保たない。遅れたコミットと同じ件数の
  削除が重なると件数は変わらないまま集合が入れ替わり、件数だけでは見逃す（`[5,3,3,2]`
  のように重複する）。そこでサーバーは**削除の世代**を持つ: 保持期間の削除が行を
  消したときに、削除と同じトランザクションで `settings` の `audit.deletion_epoch` を
  1 進め、一覧は行・件数と同じ読み取りトランザクションでそれを読んで応答に入れる。
  クライアントは件数と削除の世代の両方を世代の最初の値と照合する:

  | 境界の中で起きたこと                      | 件数   | 削除の世代 | 検出             |
  | ----------------------------------------- | ------ | ---------- | ---------------- |
  | 遅れたコミットだけ                        | 増える | 同じ       | 件数で検出       |
  | 削除だけ                                  | 減る   | 進む       | 両方で検出       |
  | 遅れたコミット + 同じ件数の削除           | 同じ   | 進む       | 削除の世代で検出 |
  | 遅れたコミット + それより多い／少ない削除 | 変わる | 進む       | 両方で検出       |

  SQLite は書き込みが 1 本ずつなので、境界より小さい `id` の行が後からコミット
  されることは無い（件数だけでも検出できる）が、同じ仕組みで動かす。行を消すのは
  `prune` だけという前提に立つ（バックアップの復元はデータベースごと差し替えて
  再起動する）。

- 失敗をブロック単位で持つ・`{0, 0}` から回復する・期限・世代の違う応答を捨てる、は
  `WindowedListResource`（#243）と同じ約束にする。判断の小さい部品（配列長の検査・
  期限の文言・`ProviderError` への変換）は `blockFetch.ts` に出して両方で使う。
- サーバー（監査ログの一覧）は `asOfId` を任意で受け取り、応答に使った境界を返す。
  境界付きの取得では保持期間の削除を走らせない。サーバー側の決まりは
  [conventions §6](../conventions.md) に置く。

## 検討した代替案

- **案A（採用）: 別クラス + 取得関数の注入**。既存の `WindowedListResource` と
  それを使う CRUD 画面の挙動（#212 の再取得中の表示保持、#243 の約束）を一切
  変えない。境界の要る一覧は少なく、専用 API を持つので、注入が自然。
  欠点: ブロック読み込みの判断が 2 クラスに分かれる（小さい部品は共有したが、
  取る・採る・止めるの判断は別）。
- **案B（不採用）: `WindowedListResource` に取得関数の注入と境界のオプションを
  足す**。1 クラスに保てるが、境界付きでは要求の出し方が違う（境界が決まるまで
  1 本だけ・件数の変化で世代を止める・自動で取り直さない）ため、オプションごとに
  分岐が入り、#246 で 2 回のレビューを経た状態遷移に手を入れることになる。また
  `WindowedListResource` は `invalidate` で自動的に取り直す前提（`refresh()` は
  前の表示を保ったまま差し替える）で、「通知が無いので手で新しい世代にする」
  一覧とは `refresh()` の意味が違う。
- **案C（不採用）: `DataProvider.getList` に `asOfId`（任意の引数・応答の任意の
  フィールド）を足し、`WindowedListResource` がそれを使う**。互換は保てるが、
  InMemory / Tauri / HTTP の 3 プロバイダと、派生アプリが自作したプロバイダの
  すべてに「境界を解釈するか黙って無視するか」の判断を持ち込む。無視された境界は
  失効と区別できず、境界が要らない CRUD 一覧にも費用がかかる。
- 削除の世代について（#256 レビュー）、代わりに検討した検出方法:
  - **境界の中の `SUM(id)`（や集合のハッシュ）を件数と一緒に返す（不採用）**。
    書き込み側に手を入れずに済み、件数と同じ走査で求まるので費用はほぼ同じ。
    ただし検出は確率的で、遅れたコミットと削除が 2 行ずつ重なり、`id` の和が
    等しいと見逃す（例: `{2,5}` が入り `{3,4}` が消える）。ハッシュにすれば
    衝突は減るが、SQL で安く・両方言で同じに計算できる集合ハッシュが無い。
  - **`(max(id), count, min(id))` の組（不採用）**。行数による削除は古い順なので
    `min(id)` が動くことが多いが、絞り込みの中に消えた行が無いときや、日数による
    削除（`ts` の順と `id` の順は一致を保証しない）では動かないことがある。
    絞り込み付きの `min(id)` は件数と同じ走査が要る。
  - **削除の世代（採用）**。費用は、削除が行を消したときの `settings` の 1 行の
    更新（削除と同じトランザクション）と、一覧ごとの主キー 1 行の読み取り。
    削除の経路が `prune` に限られる前提の下で、見逃しが無い（上の表）。マイグレー
    ションは要らない（`settings` は Banto の基盤の表）。
- **案D（不採用）: 画面ごとに縮小コピーを直す**（banto-industrial #427 の
  `blockCache.ts` は複製 + 一致テストで保っている）。テンプレートの利用者が
  同じ種類の一覧を作るたびにコピーすることになり、#248 のようにコピーだけが
  直り損ねる。

## 帰結

- 通知なしに増減する一覧を新しく作るときは `SnapshotListResource` を使い、
  サーバー側は conventions §6 の決まり（1 つの読み取りトランザクション、境界の
  中で数える、`id` は単調で再利用しない、行を消す処理は削除の世代を同じ
  トランザクションで進める、境界付きの取得で削除系の副作用を走らせない、省略時は
  従来どおり）を守る。書き込みが並行してコミットされるデータベースで削除がある
  一覧は、`deletionEpoch` を返さなければならない。
- `WindowedListResource` と `SnapshotListResource` は、失敗の持ち方・回復・期限の
  約束をそろえておく。片方を直すときはもう片方も見る（共有部品は `blockFetch.ts`）。
- 画面は境界を固定している間、新しい記録を自動では出さない。「再読み込み」を
  常に押せる状態で置く（処理中でも押せる。処理中の要求は中断する）。
- PostgreSQL では、小さい `id` を採番した書き込みが後からコミットすると、同じ
  境界の件数が増える。これも失効として扱われる（読み直せば正しい）。削除と重なって
  件数が相殺されても、削除の世代で失効になる。

---

## 追記（2026-10-06、Issue #342）: 失敗の種類・文言・通知

本文の決定（別クラス・注入・境界・失効）は変えない。変えるのは、失敗を画面に
渡す形である。オーナー決定（2026-10-06）により後方互換は保たず、v5.0.0
（major）で出す。互換用の別名は残さない。

### コンテキスト

- 派生アプリ（banto-industrial の監査ログ）は、文言を日本語にするために
  取得関数の側で 15 秒の期限を先に掛けていた（banto の期限 30 秒の文言が英語の
  固定文で、差し替えられないため）。境界の食い違いは `message` を
  `SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE` と文字列比較して置き換えていた。
- ChronoGazer の `/events` は、種類の違う失敗（サーバーが答えた「読み取れ
  なかった」と、往復の失敗・期限切れ）を同時に出す（種類ごとに最も前の
  ブロック）。失敗のトーストは出さない。「読み取れなかった」はアプリが取得関数
  から投げる `ProviderError` の派生（`readout` を持つ）で表す。
- `error`（最新の 1 件）だけでは、種類の違う失敗を同時に出せない。文言の比較
  でしか種類を見分けられない。

### 決定

- 状態は `failures`（ブロック順、ブロックごとに 1 件）で出す。
  `{ block, kind: 'error', code, error }` か `{ block, kind: 'expired' }`。
  そのブロックの取得が成功すると消え、`setParams()` で空になる（本文の約束の
  まま）。`error`・`failedBlocks` は削除した（`failures` から導ける）。
  `expired` は「今の世代が止まっている」を表し、前の世代の失効の記録とは
  区別が要るので残す。
- 失敗の種類はコード `SnapshotListFailureCode`（`'request'`・`'timeout'`・
  `'boundaryMismatch'`・`'malformed'`）で持つ。リソースが自分で作る失敗は
  `SnapshotListError`（`ProviderError` の派生、`code` を持つ）。取得関数が
  投げた `ProviderError` は**同じオブジェクトのまま**（`'request'`）入れる。
  アプリの派生クラスが持つ情報（`readout` など）が残る。`ProviderError` で
  ないものは `SnapshotListError('request')` に包み、投げた値を `cause` に置く。
- リソースが作る失敗の文言は、`messages` オプション（`timeout(ms)`・
  `boundaryMismatch()`・`malformed()`）で差し替える。レイヤ①の注入
  （[ADR-0005](0005-i18n-paraglide.md)、conventions §13）と同じで、パッケージは
  辞書を持たず、関数で受け取る（Paraglide の文言関数をそのまま渡せる）。
  既定は英語（`defaultSnapshotListMessages`）。`SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE`
  は削除した。文言の関数が投げたら既定の文言にする（期限切れが確定しなくなる
  のを防ぐ）。
- `notify` オプション（既定 `true`、`false`、または失敗ごとの述語）で、
  失敗ごとのトーストを止められる。失効は従来どおり通知しない。

### 検討した代替案

- **文言の差し替えだけ（不採用）**: 種類の見分けは文言の比較に残る。
- **コードだけ（不採用）**: トーストの文言はリソースが出すので、通知を止めない
  画面では英語のままトーストに出る。コードと文言の両方を持つ。
- **パッケージに辞書を持つ（不採用）**: conventions §5・§13 に反する。
- **`error`（最新の 1 件）を残す（不採用）**: `failures` から導ける別名を
  増やすだけで、種類の違う失敗を同時に出す画面には足りない。

### 帰結

- `WindowedListResource` は今回変えない（既定の英語の文言は `blockFetch.ts` で
  共有する）。本文の帰結「失敗の持ち方をそろえる」に対する一時的な差であり、
  同じ形（コード・`messages`・`notify`・`failures`）にそろえるのは別の Issue
  で行う。`WindowedListResource` は `refresh()` の表示保持（#212）の状態遷移が
  別で、今の利用者（CRUD 画面のサーバーモード）に失敗の種類を見分ける需要が
  まだ無いため、破壊的変更の範囲を広げなかった。

---

## 追記（2026-10-07、Issue #344）: `WindowedListResource` の失敗も同じ形にし、型の名前を共通にする

2026-10-06 の追記の帰結に残した差を埋める。本文と 2026-10-06 の追記の決定は
変えない。オーナー決定（2026-10-07）により後方互換は保たず、v6.0.0（major）で
出す。互換用の別名は残さず、移行の手順書も用意しない。

### コンテキスト

- `WindowedListResource` は `error`（最新の 1 件）・`failedBlocks`・英語の
  固定文のままで、`SnapshotListResource` と失敗の見分け方が違っていた。
  CRUD 画面のトーストは英語の固定文で、差し替える手段が無かった。
- 2026-10-06 の追記で決めた型の名前（`SnapshotListError` など）は
  `SnapshotListResource` に結び付いており、そのまま `WindowedListResource` で
  使うと名前が中身と合わない。

### 決定

- `WindowedListResource` の失敗を `failures`（ブロック順、ブロックごとに 1 件、
  `{ block, kind: 'error', code, error }`）で出す。`error`・`failedBlocks` は
  削除した。消える条件は従来と同じ（そのブロックの取得の成功、`setParams()`）。
- `refresh()` の表示保持（#212）は変えない。行と件数は世代のブロックが
  すべて落ち着くまで前のままで、`failures` は落ち着く前でも、取り直しが
  済んだブロックから更新する（成功なら消え、失敗なら新しい失敗に置き換わる）。
  行と失敗を一緒に保つと、取り直しの失敗が世代の終わりまで見えず、前の
  失敗が残って見える。失敗の記録は行を書かないので、途中の行の欠けで
  編集対象が消えたと誤判定させる #212 の問題は起きない。
- 失敗の種類と扱いは 2026-10-06 の追記と同じ。`getList`（と
  `getDataProvider()`）が投げた `ProviderError` は同じオブジェクトのまま
  `'request'`、`ListBlockError` は自分の `code` のまま、それ以外の値は
  `ListBlockError('request')` に包み `cause` に置く。期限切れ・応答の形の
  不正は `'timeout'`・`'malformed'`。`messages`（`timeout(ms)`・`malformed()`）
  と `notify`（既定 `true`・`false`・述語）を受ける。`'boundaryMismatch'` は
  作らない（境界を持たないため）。
- 型の名前を両リソースで共通にする: `SnapshotListError` → `ListBlockError`、
  `isSnapshotListError` → `isListBlockError`、`SnapshotListFailureCode` →
  `ListBlockFailureCode`、`SnapshotListErrorFailure` → `ListBlockErrorFailure`。
  文言は共通の `ListBlockMessages`（`timeout`・`malformed`、既定
  `defaultListBlockMessages`）を `SnapshotListMessages` が拡張して
  `boundaryMismatch` を足す。`SnapshotListFailure`・`SnapshotListExpiredFailure`・
  `SnapshotListMessages`・`defaultSnapshotListMessages` は失効と境界の食い違いが
  `SnapshotListResource` だけのものなので名前を残す。投げた値の扱い・文言の
  解決・`notify` の判定は `blockFetch.ts` の 1 か所で両リソースが共有する。

### 検討した代替案

- **`WindowedListError` を別に作る（不採用）**: 同じ形のクラス・コードの型・
  判定関数が 2 組になる。アプリは失敗を見分けるのにリソースごとに別の
  `instanceof` を書くことになり、同じデータソースを両方で使うと、片方の
  リソースが作ったエラーをもう片方が `code` を保たずに `'request'` として
  扱う。
- **`SnapshotListError` の名前のまま `WindowedListResource` でも使う
  （不採用）**: 破壊的変更は小さいが、境界を持たないリソースの失敗が
  `SnapshotList` の名前になり、読み手を誤らせる。v6.0.0 は既に破壊的変更なので、
  ここで名前を直す。
- **コードの型をリソースごとに分ける（`'boundaryMismatch'` を除いた型を
  `WindowedListResource` に使う）（不採用）**: データソースが投げた
  `ListBlockError` は自分の `code` を保つので、`WindowedListResource` でも
  `'boundaryMismatch'` は現れうる。型が実際に起きうる値より狭くなる。
- **`refresh()` の間は失敗も前のまま保ち、世代の終わりにまとめて出す
  （不採用）**: 上の決定の理由のとおり。

### 帰結

- 本文の帰結「失敗の持ち方をそろえる」がそろった。以後、失敗の形を変えるときは
  両リソースを同時に変える。
- banto-industrial は `WindowedListResource` を使っておらず、名前の変更の
  影響は `isSnapshotListError` を使うテストだけである。
