# ADR-0029: 日時の文字列変換は `banto-core` の 1 か所で `chrono`（feature なし）を使う（ADR-0002 の例外）

> English: [0029-chrono-datetime-formatting.en.md](0029-chrono-datetime-formatting.en.md)

- 状態: Accepted
- 日付: 2026-11-09
- 関連: conventions §3 / [ADR-0002](0002-minimal-dependencies.md) /
  [ADR-0028](https://github.com/tyaro/banto/blob/v7.0.0/docs/adr/0028-chrono-local-date.md)（「共通クレートには足さない」の範囲をこの ADR で広げる）

> banto-cost 注: Banto v7.0.0 から取り込んだ ADR。本文の「ADR-0028」は Banto 本体の ADR-0028（商品 `items.updated_at` のローカル日付。banto-cost には商品がないので取り込んでいない）を指し、banto-cost の [ADR-0028](0028-capability-project-scope-authz.md)（能力と案件範囲の判定）とは別物。

## コンテキスト

`SystemTime` やエポックからの日数を `YYYY-MM-DD...` の文字列にする処理を、Howard Hinnant の
`civil_from_days` の手書きの移植として 3 か所に持っていた（`banto-attachments`・
`banto-admin-services` の `backup.rs`・app の `core/src/db.rs`）。conventions §3 は
「4 箇所目が生えたら `banto-core` への一本化を判断する」としていた。

ADR-0028 で app の core が `chrono`（`clock`）を使うことが決まり、`chrono` は既に
ロックファイルにも `src-tauri` にも入っている。オーナーが 2026-11-09 に、日付と時刻での
`chrono` の使用を許可した。

## 決定

**`banto-core` に `chrono`（`default-features = false`、feature なし）を足し、
`banto-core::datetime` に 3 つの関数を置く。3 つの手書きの変換は削除して、これを呼ぶ。**
オーナーが 2026-11-09 に承認。

- `iso_datetime_from_system_time`（`YYYY-MM-DD HH:MM:SS`、UTC。SQLite の `datetime('now')` と同じ文字列）
- `iso8601_utc_from_system_time`（`YYYY-MM-DDTHH:MM:SSZ`）
- `iso_date_from_days_since_epoch`（`YYYY-MM-DD`）

出力の形式と境界の挙動は従来と同じ: エポック前はエポック、小数秒は切り捨て、負の日数も扱う。
`DateTime::<Utc>::from(SystemTime)` は範囲外で panic し得る（バックアップの一覧は
ファイルの mtime という外部の値を渡す）ので使わず、`Option` を返す
`DateTime::from_timestamp` / `NaiveDate::from_num_days_from_ce_opt` で受け、範囲外はエポックに
する（panic しない）。`compact_stamp` は文字列処理なので手を付けない。

feature は何も有効にしない。`clock`（現在時刻・ローカル TZ）は `banto-core` に不要で、
ローカル日付を求める app の core だけが従来どおり `clock` を足す（ADR-0028）。
ルートの `[workspace.dependencies]` に `default-features = false` で宣言し、足す側が必要な
feature だけを足す。`Cargo.lock` に新しい crate は増えない。

## 検討した代替案

- **案A（採用）: `banto-core` に `chrono` を足して 1 か所にまとめる。**
  conventions §3 の判断基準（P1-5）の該当: ①日時はエッジケースが多い領域（暦・うるう年・
  範囲外）／②自前実装が 3 か所に複製されている／③`chrono` は成熟し、既に依存グラフに入って
  いるので実質の増分はほぼ無い／④feature なしに絞れる。欠点: 共通クレートの依存が 1 つ増え、
  派生アプリが推移的に `chrono` を持つ。
- **案B（不採用）: 手書きのまま 3 か所を維持。** 暦の計算を 3 つ保守し続け、境界の
  扱い（範囲外・負の日数）の修正が 3 回要る。4 箇所目の危険も残る。
- **案C（不採用）: 手書きの変換を `banto-core` に集約するだけ。** 複製は 1 つになるが、
  暦の自前実装の保守は残る。`chrono` が既に入っているので、残す理由が弱い。

## 帰結

- 手書きの `civil_from_days` は無くなり、日時の文字列変換は `banto-core::datetime` だけにある。
  境界のテストもそこにある。
- conventions §3 の表の `chrono` / `time` の行を現状に直した。ADR-0028 の「共通クレートには
  足さない」はこの ADR で広げた（ADR-0028 本文は書き換えない）。
- 外し方: `chrono` を外すなら、`banto-core::datetime` の 3 関数の中身だけを手書きに戻せば
  よい（呼び出し側は変わらない）。
