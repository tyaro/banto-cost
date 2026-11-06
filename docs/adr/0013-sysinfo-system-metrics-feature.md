# ADR-0013: CPU/メモリ使用率は `sysinfo` を feature 限定で採用して共通 API にする（ADR-0002 の例外）

> English: [0013-sysinfo-system-metrics-feature.en.md](0013-sysinfo-system-metrics-feature.en.md)

- 状態: Accepted
- 日付: 2026-09-14
- 関連: Issue #185 / conventions §3 / [ADR-0002](0002-minimal-dependencies.md) /
  feature-review-2026-08 §2.4（System Info カード「縮小版⑤」）

## コンテキスト

banto を基にした下流アプリ（banto-industrial / banto-hub）が、サーバ状態画面に
**CPU・メモリ使用率**を出したいと要望した（Issue #185）。banto には
`SystemInfoService`（DB プローブ: 方言・レイテンシ・マイグレーション版・添付容量）
と、それを REST/Tauri 対称で返す admin 専用の System Info カードがあるが、
プロセス/ホストの CPU・メモリを取る API は無い。

feature-review 2026-08 §2.4 では **disk free だけを「std では取れず sysinfo 系
クレートか FFI が要り、それだけのために §3 ゲートを通す価値がない」として
見送った**。今回は「CPU + メモリ（プロセス RSS・ホスト total/used）」が
複数の下流アプリで共通に要る、という新しい事実がある。

制約:

- conventions §3 / ADR-0002: 依存追加は設計判断であり、P1-5 の基準
  （自前実装が肥大化する・エッジケースが多い・crate が成熟・feature 限定できる・
  バイナリ増加を測定済み）に複数該当するときだけ採用し、ADR に残す。
- std だけではクロスプラットフォームに CPU 使用率・メモリを取れない
  （Linux は `/proc`、Windows は Win32 API、macOS は Mach/sysctl の FFI）。
- 3 アプリ（テンプレート + 下流 2）がそれぞれ `sysinfo` を抱えて再実装する方が
  総保守コストが高い。

## 決定

**`banto-admin-services` に opt-in feature `system-metrics` を追加し、その下で
`sysinfo`（`default-features = false, features = ["system"]`）を引く。**
状態を持つサンプラ `SystemMetricsSampler`（呼び出し間の差分で CPU 使用率を算出）
と、そのスナップショット `SystemMetrics`（ホスト CPU%・メモリ total/used・
swap total/used・プロセス CPU%・プロセス RSS・論理 CPU 数）を提供する。
`SystemMetrics` 型自体は feature 無しでもコンパイルされ、既存の System Info
ワイヤ構造体に `metrics: Option<SystemMetrics>` として載る（feature OFF /
非対応 OS では `null`）。

`banto-server` の `system_info_router` は feature を知らず、`Option<MetricsProbe>`
（`Arc<dyn Fn() -> Option<SystemMetrics> + Send + Sync>`）を受け取るだけ。
サンプラの生成と閉包の配線は app 層（`banto-serve` / `src-tauri`）が
`#[cfg(feature = "system-metrics")]` で行う。

テンプレートの app 層（`admin-template-core` と `src-tauri`）は **既定で
`system-metrics` を有効**にする。テンプレートは「配線の見本」であり、何も
有効化しない feature はテンプレートでは死んだコードになるため。外し方は
README「オプション資産の削除」に 1 行（`default` から feature を外す）。

## 検討した代替案

- **案A（採用）: `sysinfo` を feature 限定で採用。**
  P1-5 の該当: ①自前実装は OS ごとの FFI（Windows は `windows` クレート、
  macOS は Mach）になり 100〜200 行を優に超える／②`/proc` のパース・Windows の
  パフォーマンスカウンタ等エッジケースが多い／③`sysinfo` は 2015 年から
  保守され続ける成熟クレート（MSRV 1.95。ワークスペースは sqlx 0.9 で既に
  1.94 以上を要求しており実質増分なし）／④`system` feature だけで
  `component`/`disk`/`gpu`/`network`/`user` を落とせる／⑤バイナリ増分は
  実装 PR で release ビルドを測定して CHANGELOG に記録する。
  欠点: Windows では `windows` 0.62 系が新たに（`src-tauri` の 0.61 系と並存して）
  ツリーに入る。`banto-serve` 単体（LAN 常駐）にも入る。
- **案B（不採用）: 依存なしで自前実装。**
  Linux だけなら `/proc/stat` + `/proc/meminfo` + `/proc/self/statm` で
  100 行程度だが、Windows（主要ターゲット）は `windows`/`windows-sys` の
  FFI が要り、macOS はさらに別実装。「クロスプラットフォームで薄い共通
  ヘルパー」という要望を満たせず、自前で 3 OS 分の脆弱性・API 変更を追うことに
  なる。
- **案C（不採用）: 今回も見送り、下流が各自 `sysinfo` を抱える。**
  既に 2 アプリで再実装が始まっており、3 箇所目で同じ差分計算バグを 3 回直す
  形になる。P1-5 の「複数該当」を満たす以上、見送りの根拠（§2.4）は
  「disk free だけのため」という当時の前提に依存しており、前提が変わった。
- **案D（不採用）: 常時有効（feature にしない）。**
  ADR-0002 の「利用者のコピー負荷」に反する。feature なら不要なアプリは
  1 行で外せる。

## 帰結

- conventions §3 の「依存を足す側の例外」に本 ADR を追記する
  （Paraglide＝ADR-0005 に続く 2 件目）。
- **disk free は引き続き非スコープ**（`disk` feature を足せば取れるが、要望が
  出ていない。要るときは本 ADR を supersede せず、feature を 1 つ足す小 PR で
  よい旨をここに記す）。
- サンプラは**状態を持つ**（sysinfo の CPU 使用率は 2 回目以降の refresh で
  しか出ない）ため、`AppState` / `banto-serve` の起動時に 1 つ生成して共有する。
  `sysinfo::MINIMUM_CPU_UPDATE_INTERVAL` 未満の連続呼び出しでは CPU の refresh を
  スキップして前回値を返す（値が 0 に潰れないようにする）。
- `sysinfo` の refresh は同期 I/O（`/proc` 読み・Win32 API）。数 ms 程度だが、
  ハンドラは `tokio::task::spawn_blocking` 越しに呼ぶ。
- 非対応 OS（`sysinfo::IS_SUPPORTED_SYSTEM == false`）では `metrics` を `None`
  にして degrade する（カードの他の行は従来どおり出る）。
- `SystemInfo` のワイヤ形は `metrics` が増えるだけ（後方互換。古いフロントは
  無視する）。
- 下流アプリ（banto-industrial / banto-hub）は自前の `sysinfo` 実装を
  `SystemMetricsSampler` に寄せ替えられる。
