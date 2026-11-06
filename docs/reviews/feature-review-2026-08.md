# 機能スコープ・レビュー（2026-08）— 外部提案の実測検証と取捨

作成日: 2026-08-11
位置づけ: 外部AIレビュー（ChatGPT）が提示した「Banto テンプレートに追加を
検討すべき機能」の一覧を、**実際のコードベース状態に照らして検証**し、何を
入れる/入れない/ドキュメントで応えるかを判定した記録。所見はすべてリポジトリ
上での実測（`file:line` 参照）に基づく。

トラック: 本書は**保守者向け（トラックA）**。スコープ判定は
[template-scope.md](../template-scope.md)、マイルストーン計画は
[roadmap.md](../roadmap.md)、不変条件は [conventions.md](../conventions.md) が一次情報。
本書はそれらへの入力（バックログ候補・宿題）を生成する棚卸しであり、確定した
判断は各一次ドキュメントへ反映する（§5 参照）。

関連: [review-2026-07-29.md](../history/review-2026-07-29.md)（利用者視点の実用性レビュー）、
[improvement-plan-2026-07.md](../history/improvement-plan-2026-07.md)（外部AIレビュー統合の
アクションプラン）。本書は同じ「外部レビューを実測で裏取りして取捨する」系譜。

実施状況（2026-08-12）: §4「今すぐ」分類は **3件すべて実装済み** —
**(a) バージョン表示 + System Info カード（§2.4 の縮小版⑤）**、
**(b) PWA installable-only（§2.8）**、**(c) `warning` kind 追加 + `Notice` 発火
レシピ（§2.5 の無料部分）**。(a) は admin 専用「システム情報」カード +
`GET /api/system/info` / Tauri `system_info` / `SystemInfoService`。(b) は
`static/manifest.webmanifest` + アイコン + `app.html` の link/meta + `banto-server`
`guess_mime` の `webmanifest` arm（HTTPS/localhost/TLS プロキシ配下でのみインストール
可、Service Worker なし）。(c) は `NotificationKind` を4種へ拡張 + `ToastHost` の
warning スタイル + `ServerEvent::Notice` の doctest/SSE テスト/README レシピ。いずれも
依存追加ゼロ（CHANGELOG [Unreleased] 参照）。**残るはバックログ昇格候補（Backup
アーカイブ・API Token・Updater）で、いずれも実需トリガ待ち**（§4）。

## 0. 結論

外部レビューの**方向性はおおむね正確**。特に「入れない方がよいリスト」
（MQTT / OPC UA / タグストア / スケジューラ / Workflow / LLM）は roadmap §4 と
template-scope §4.1 で既決の除外の追認であり、完全に同意する。

一方で本書の判断は2点で外部レビューと異なる:

1. **既存資産の見落としが複数あり、直すと優先順位が変わる。** 通知（notify API と
   Notice イベント経路）と運用監視（LANサーバ状態・バックアップ一覧）は「新機能」
   ではなく、既存配線の未使用部分・既存UIが占める割合が大きい。
2. **「M25〜M33 とマイルストーンを先回りで積む」発想自体が Banto の規律と矛盾する。**
   roadmap は「実需・採用（外部利用者）が出た時点で昇格させる実需ドリブン文化」を
   明文化しており（roadmap.md §3）、現時点で外部利用者はゼロ（roadmap.md 末尾の
   post-v2 注記）。この状況で9マイルストーン分を先回りするのは、外部レビュー自身が
   警告する「何でも入りフレームワーク化」への一歩。

したがって本書の推奨は「次に積むマイルストーン列」ではなく、**(a) 今すぐやる小粒 /
(b) 実需トリガ待ちのバックログ / (c) 実装せずレシピで応える / (d) やらない**の4分類
（§4 の優先順位表）。

## 1. 検証方法

7つの並列調査で、外部レビューの各提案について「既に何があるか」「追加は実際に何を
要するか（層・依存・不変条件との衝突）」をコードから確認した。対象領域:
認証/トークン基盤・RBAC実装・バックアップ・運用監視面・イベント/通知基盤・
コマンドパレット/updater/PWA・規約全文。以下の所見はその実測結果。

## 2. 個別項目の判定

各項目の見出しに **判定** を付す。根拠は代表的な `file:line` のみ引用（網羅は
調査ログ）。

### 2.1 バックアップ完全化（添付を含むアーカイブ）— 判定: **賛成（次の筆頭候補）**

外部レビュー提案の中で唯一「既知の制限の再発見」であり、既に v2 バックログに
**添付を含むバックアップアーカイブ**として明記されている（roadmap.md §3、
attachments-plan.md §8）。4条件（横断性/削除容易性/代替不能性/無ドメイン性）を満たす。

実測に基づく設計上の修正:

- **zip は依存追加。** ワークスペースに zip/tar クレートは無い（flate2 は png の
  推移依存のみ）。conventions §3「依存を足さない」に正面衝突するため、ADR を書いて
  採用するか、**依存ゼロのディレクトリ方式**（`backups/<timestamp>/` に DB
  スナップショット + attachments ツリー + `manifest.json`）にするか。**後者から
  始め**、単一ファイルDL需要が出た時点で zip 採用の ADR を検討する順を推す。
- **「settings.json を含める」は不要。** 設定は DB 内 `settings` テーブルなので既存
  スナップショット（`VACUUM INTO`）に既に入っている。ファイルアーカイブが拾えない
  状態は OS キーリングの自動ログイン資格情報だけで、それは意図的に DB 外
  （src-tauri/src/keyring_store.rs）。
- **create 側は安い。** manifest の sha256 checksum は既存 `sha2`、`serde_json` も
  既存依存。schema version は `_sqlx_migrations`（`VACUUM INTO` が既にコピー済み）
  から `SELECT MAX(version)` で読める。app version は `CARGO_PKG_VERSION`。
- **高いのは restore 側。** 起動時ステージング適用が「1ファイル rename」から
  「ディレクトリツリーのアトミック差し替え」に変わり、Windows のファイルロック
  semantics（backup.rs が既に苦労している領域）と orphan ファイルポリシーが本丸。
  添付を持たない利用者もリストアできるよう、検証では attachments を **OPTIONAL** に
  保つ（`REQUIRED_TABLES` から attachments を除いている既存判断のミラー）。
- 不変条件: PostgreSQL は backup 非対応（明示エラー、backup.rs）の**現行挙動を維持**。
  BackupService は attachments の**ディレクトリパス**を受け取ってよいが
  `banto-attachments` クレートに依存してはならない（core→optional 逆依存禁止、§4）。

規模: MEDIUM〜LARGE。**実需トリガ待ちのバックログ最有力**（既知の制限であるため）。

### 2.2 API Token / Service Account — 判定: **条件付き賛成（scope 設計には反対）**

外部レビューの提案の中で**最も価値が高い**。実測の結果、機械（非人間）アクセスの
手段は本当にゼロだった:

- セッショントークンは**インメモリのみ**（`AuthState` の
  `RwLock<HashMap<String, TokenRecord>>`、crates/banto-server/src/auth.rs）。プロセス
  再起動で全消失。トークン用テーブルはどのマイグレーションにも無い。
- `api_token` / `service_account` 等のコードは repo 全体で0ヒット。
- 唯一の長期資格情報は「Remember me」（30日、それでもインメモリで再起動消失）と
  keyring 自動ログイン（トークンではなく**ユーザーのパスワード**を保存し再ログイン、
  src-tauri/src/keyring_store.rs）。スクリプトが人間アカウントのパスワードで
  `POST /api/auth/login` する回避策はあるが、設計された機械アクセスではない。

「Python / Excel VBA / 別システム / PLC ゲートウェイから API アクセスしたくなる」は
LAN 業務システムという Banto のターゲットに対して横断的で、バックログにすら無い
**唯一の大物**。

設計は外部レビュー案（`inventory.read` 式の scope）ではなく、**既存ロールに紐付けた
トークン**（token = role + 有効期限 + 失効）にすべき:

- banto-server は意図的にロール文字列**非依存**で、ガード層が `Role` enum を
  パースする（rbac.rs の `FromStr` は未知値を拒否）。自由形式 scope は全ガード +
  verify-architecture の `DUAL_PATH` マニフェストに波及する。ロール紐付けなら
  波及が小さく、アーキテクチャに沿う。
- **依存追加ゼロで実装可能**（`sha2`/`uuid`/`getrandom` すべて既存。ADR-0002 の
  「新規外部クレートを増やさない」パターンに合致）。
- セキュリティ不変条件がそのまま効く: 作成時に一度だけ表示・保存はハッシュのみ・
  監査 detail にトークンを入れない（conventions §6 が bearer トークンの監査記録を
  明示的に禁止）。

要する層（実装時）: (1) マイグレーション×2方言（`api_tokens`）、(2)
`banto-admin-services` に `ApiTokensService`（サービス層は tauri/axum 非依存、§2）、
(3) banto-server の `require_auth` に DB バックの非同期トークン照合パスを追加
（今日の `verify()` は同期・インメモリのみ）+ CSRF ヘッダ免除の判断
（スクリプトは `X-Banto-Client` を送らない）、(4) admin 専用の管理 REST + 監査 +
ルートテーブル doc 更新、(5) Tauri 側の対称コマンド（§1、両経路対称は非任意）、
(6) 管理UI（users グリッドが雛形、一度だけトークン表示）。

規模: M10 + M14 級のフルマイルストーン。**判定: roadmap §3 バックログに正式追加し、
最初の外部連携需要が出た時点で昇格**（§5 で反映）。

### 2.3 Tauri Updater（自動更新）— 判定: **バックログ維持（「M25」は時期尚早）**

既に v2 バックログ（roadmap.md §3、template-scope.md §5「残す」）。方向は正しいが、
外部レビューが見落としている前提が3つ:

1. **バイナリリリースパイプラインが存在しない。** publishing.md の配布は git タグの
   ソース消費のみ。GitHub Releases も tauri build ワークフローも署名鍵管理も無い。
   updater は機能追加ではなく**リリースエンジニアリング一式の新設**。
2. **依存2件**（`tauri-plugin-updater` + npm 側 `@tauri-apps/plugin-updater`）は
   §3 の設計判断ゲート対象。前例として `tauri-plugin-dialog` が同じ理由で却下されて
   いる（attachments-plan.md）。P1-5 基準（セキュリティ境界・署名検証・成熟クレート）
   は満たしそうで通る見込みは高いが、**ADR 必須**。
3. **両 CSP が `connect-src 'self'`**（「外部に一切接続しない」姿勢を doc コメントで
   明文化、security_headers.rs / tauri.conf.json）。また**定期更新チェックは「cron
   相当を持たない」という二度記録された除外**（roadmap.md §4、template-scope.md
   §4.2）と衝突するので、**起動時チェック or 手動チェック**設計に限定する必要がある。
4. テンプレートである以上、全コピー利用者が updater エンドポイント/鍵を継承する。
   template-scope §3 の「削除容易性」に反しないよう、削除手順の明文化が前提。

**昇格トリガは「テンプレートの完成度」ではなく「Banto 製アプリを客先PCに配布し
始める予定が具体化した時」。** その予定があるなら最優先で良い。無いならバックログ維持。

### 2.4 運用監視（System Health）— 判定: **縮小して賛成（一部は今すぐ）**

外部レビュー案（`/system/health` `/system/info` `/system/metrics` の3本 + 10項目）は
過剰仕様。実測: LANサーバの稼働状態・バインド/ポート・アクセスURL・QRコード・
バックアップ一覧（日時付き）は**設定画面に既にある**（settings/+page.svelte、
`server_status` / `BackupService::list()`）。

net-new は version / migration version / DB レイテンシ / uptime / セッション数 /
添付ストレージ量のみ。これは **admin 専用 GET 1本（REST + Tauri 対称）+ 設定画面
カード1枚**、依存ゼロ、1〜2日。3エンドポイント構成は codebase の idiom に対して
過剰で、`GET /api/system/info` + `system_info` コマンドが自然。

- **disk free だけは落とす。** std では取れず、sysinfo 系クレートか FFI が必要で、
  それだけのために §3 ゲートを通す価値がない（要るなら ADR で別途）。
- uptime は起動時 `Instant` を `AppState` と `banto-serve` に持たせるだけ（小、ただし
  src-tauri はサンドボックスでコンパイル不可＝レビュー担保）。
- 未認証 liveness（`/health`）を足すなら `/api/auth/status` 同様の明示的な CSRF/認証
  免除が要る（セキュリティ面の判断であり既定ではない）。

**2026-09-14 追記**: 上の「disk free だけは落とす」判断は維持しつつ、CPU/メモリ
（ホスト total/used・スワップ・プロセス RSS・CPU%）は `sysinfo`（feature 限定、
`system` のみ）を採用して追加した（[ADR-0013](../adr/0013-sysinfo-system-metrics-feature.md)、
Issue #185）。複数の下流アプリが個別に `sysinfo` を抱え始めていたという新事実が
根拠で、当時の「disk free だけのために§3ゲートを通す価値がない」という判断
そのものは変えていない - disk free は引き続き非スコープ（要るときは本ADRを
supersedeせず feature を1つ足す小PRで足りる旨、ADR-0013の帰結節に明記）。

**特筆すべき発見（監視以前の問題）**: バージョン `1.1.0` が UI のどこにも表示されて
いない。version を返す `ping` コマンドは存在するが呼ぶ側がゼロ（src-tauri/src/lib.rs、
frontend からの invoke は0ヒット）。「なんか変」と言われた時にユーザーがバージョン
すら報告できない。**version 表示だけは即修正の価値あり**（§4 の「今すぐ」）。

### 2.5 Notification Center — 判定: **半分反対（無料の部分だけ拾う）**

外部レビューの**最大の見落とし**。実測:

- **`notify(kind, message)` API は既に存在**（admin-core の Notifier 抽象、
  registry.svelte.ts）。app は toast ストアを Notifier として3モード（tauri/server/
  demo）すべてに配線済み（setup.ts）。「app から `notify(...)` で通知」は今日できる。
- **`ServerEvent::Notice { level, message }` → SSE/Tauri イベント →
  `connectEvents` → `notify()` → toast の経路が端から端まで実装済み**で、
  **サーバ側が一度も `Notice` を発火していないだけ**（events.rs に定義はあるが構築
  0ヶ所。emit されるのは `ResourceChanged` のみ）。

本当に新規なのは永続化（migrations×2方言 + サービス + 両経路 + per-user 既読管理 +
Header へのベル追加。Header に拡張ポイントは無く直接編集）で、M14 級のフルスライス。
かつ4条件のうち**横断性が怪しい**（すべての管理画面が通知履歴を要るわけではない）。
監査ログとは機能が重複しない（監査は admin 専用・追記専用・秘密禁止のセキュリティ
証跡。通知は per-user・アプリ発・既読ライフサイクルの UX）ので audit_log の再利用は
不可。

**判定:**
- 本体に入れる: (a) `Notice` イベントの発火例 + README レシピ化（ほぼタダ）、
  (b) `NotificationKind` への `warning` 追加（小。現行は success/error/info）。
- 永続通知センターは**実需が出てから**。入れるとしても本体焼き込みではなく
  **オプションパッケージ**（`notifications` パッケージ相当、仮称。`@banto/*` 系として
  切り出す。削除可能義務つき、§3.1 方式）。

### 2.6 詳細RBAC（Role→Permission 間接層）— 判定: **反対（レシピで応える）**

実測は外部レビューの直感と逆だった:

- 決定面は実質2関数（REST `require_role_at_least`、Tauri `require_role`）+ 約44箇所の
  フロア宣言。`rank()`/`at_least()` の**全順序設計**のおかげで、4つ目のロール
  （品質担当・保全担当 等）は今日でもフォーク側で追加可能（enum + CHECK 制約
  マイグレーション + TS union + ドロップダウンの編集）。
- roadmap M10 が約束したのは**列挙の拡張性**のみで、細粒度ACLは明示的に非スコープ。
  `ResourceDefinition.capabilities` は宣言されているが**どこからも消費されていない**
  （「capabilities × role → 実効権限」導出は未実装）。
- Role→Permission 間接層が唯一買うのは「線形順序を破る権限セット」だが、テンプレート
  内にそれを要求するものが無い。導入すると verify-architecture rule 8 の正規表現群
  （`require_role(..., Role::X` を textual parse）と `DUAL_PATH` マニフェストの
  ハードコード18個、rule 9-B の settings Admin 判定を**同時に書き直す**羽目になる
  （これは設計された安全網であり事故ではない）。

**判定: 実装せず `docs/recipes/add-role.md`（ロール追加レシピ）を書く。**
add-resource.md と同じ思想（「魔法を増やさず AI に渡せるチェックリストにする」）で
同じ需要に応えられる（§5 で宿題化）。

### 2.7 Global Search（検索プロバイダ拡張点）— 判定: **設計は良い、優先度は低い**

`registerSearchProvider` 式の extension point 案は筋が良い（外部レビュー自身が
「Banto を太らせない」設計を提案しており評価する）。ただし:

- 現行パレットは**静的・nav 由来の同期検索**（admin-core `searchCommands` は純関数、
  app `buildCommands()` が nav から導出、CommandPalette.svelte が `$derived` で同期
  フィルタ）。async 検索結果の拡張点は無い。
- M16 が「ユーザー定義コマンド／コンテキスト依存コマンド」を明示的に非スコープと
  決めており、覆すには template-scope §6 の手続き（roadmap 昇格）が要る。
- 実装の本丸は CommandPalette.svelte の同期検索の async 化。データ検索は既存
  DataProvider `list()` 経由にすれば REST/Tauri 認可対称性をタダで継承できる
  （新規バックエンドエンドポイント不要）。

実アプリで横断検索需要が出るまで寝かせて良い。

### 2.8 PWA（installable-only）— 判定: **賛成（小粒タスク）**

既に v2 バックログ（roadmap.md §3、template-scope.md §5「manifest + アイコン程度で
軽い」）。installable-only なら**依存ゼロ・ほぼタダ**:

- `static/manifest.webmanifest` + PNG アイコン（192/512, maskable）+ app.html に
  `<link rel="manifest">`。adapter-static が `static/` を build へコピーし、rust-embed
  が LAN サーバへ埋め込む。
- **1つだけ実コード変更**: `guess_mime`（static_files.rs）に `webmanifest` の arm が
  無く、素だと `application/octet-stream` で配信される → `application/manifest+json`
  arm を追加。
- **正直な制約（README に1文必須）**: LAN サーバは設計上素の HTTP（ADR-0003）なので、
  インストールプロンプトが出るのは HTTPS リバースプロキシ配下か localhost のみ。
  素の HTTP LAN では inert。
- service worker（オフライン）は SvelteKit の `src/service-worker.ts` で依存ゼロだが、
  別スコープの大きめ判断。installable-only とは分ける。

### 2.9 Enterprise Auth（OIDC/AD）— 判定: **やらない（既決維持）**

template-scope §4.2 で既決の除外（認証方式はアプリ依存、AuthProvider 差し替えで
対応する設計を維持）。実装すれば §1 両経路対称・§6 スロットル/秘密禁止 + 新規依存の
§3 ゲートで HIGH コスト・HIGH 衝突。外部レビューも「今すぐ不要」で一致。

### 2.10 入れないリスト（MQTT/OPC UA/タグストア/スケジューラ/Workflow/LLM 等）— 判定: **完全同意**

roadmap §4・template-scope §4.1 で全部既決。industrial 系の別リポジトリ
（banto-industrial）分離も既決どおり。付け加えることはない。

## 3. 外部レビューの事実誤認（記録）

- **「Excel 入出力」= ネイティブ xlsx ではなく BOM 付き CSV**。`csvForExcel()` が
  UTF-8 BOM を前置するだけ（grid-svelte/src/core/csv.ts）。ネイティブ xlsx は M15 で
  明示的に却下（依存追加が必要、template-scope.md §4.2）。
- **i18n・PostgreSQL は実施済みで正しい**が注意: i18n は ja/en の2ロケール
  （汎用n言語フレームワークではない、Paraglide、ADR-0005）。backup は SQLite 専用の
  まま（PostgreSQL は明示エラー）。
- 「RBAC は admin/editor/viewer が中心」は正しいが、「service account が見当たらない」
  の含意（追加が容易）は誤り — §2.2 のとおり機械アクセス基盤は完全にゼロからの新設。

## 4. 優先順位（Fable 版）

| 分類 | 項目 | 根拠 |
|---|---|---|
| **今すぐ（小粒・依存ゼロ・既存方針と無衝突）** | バージョン表示 + System Info カード（§2.4 の縮小版）／ PWA manifest（§2.8）／ `Notice` 発火レシピ + `warning` kind 追加（§2.5 の無料部分） | 合計数日。既存資産の未使用部分を活かす |
| **バックログ昇格候補（この順、実需トリガ待ち）** | ① Backup アーカイブ（§2.1）→ ② API トークン（§2.2、ロール紐付け設計・バックログ新規）→ ③ Updater（§2.3、配布予定が立った時点でリリースパイプラインごと） | ①は既知の制限で最有力。②はバックログにすら無い唯一の大物 |
| **実装せずドキュメントで応える** | ロール追加レシピ `docs/recipes/add-role.md`（§2.6）／ Global Search は設計メモのみ（§2.7） | テンプレートを太らせず同じ需要に応える |
| **やらない（既決維持）** | Role→Permission 間接層（§2.6）／ 永続通知センターの本体焼き込み（§2.5）／ OIDC（§2.9）／ ネイティブ xlsx（§3）／ industrial 系全部（§2.10） | 外部レビューも大半同意見 |

**最重要の但し書き**: 外部利用者ゼロの現状で ①②④ の優先順位を一番正確に教えて
くれるのは、テンプレートへの機能追加ではなく **Banto で実アプリを1本作り切ること**
（industrial-plan の記録計など）。実アプリが最初に痛がった場所が次のマイルストーン。
外部レビューの結論「Core を狭く保ちながら、上で作れるアプリの範囲を広げる」自体は
正しく、その結論に最も忠実な次の一手は M25 の新設ではない。

## 5. 一次ドキュメントへの反映（この棚卸しから生じる作業）

本書は棚卸しであり、確定した判断は各一次ドキュメントへ反映する:

- [x] roadmap.md §3 v2 バックログに **API Token / Service Account**（ロール紐付け
      設計）を追加し、本書へリンク（§2.2）—（2026-08-12 反映済み）
- [x] roadmap.md §3 の既存バックログ項目（Backup アーカイブ / Tauri updater /
      PWA）に、本書の設計上の但し書き（依存ゲート・リリースパイプライン前提・
      HTTP制約）への参照を1行ずつ付す（§2.1 / §2.3 / §2.8）—（2026-08-12 反映済み）
- [x] 「今すぐ」分類（version 表示・System Info カード・PWA manifest・Notice
      レシピ）の起票 —（起票を経ず PR #140〜#142 で実装完了。冒頭の実施状況参照）
- [x] `docs/recipes/add-role.md` を新設（ロール追加チェックリスト、add-resource.md
      の姉妹編）。AGENTS.md「タスク別の入り口」から参照（§2.6）
      —（2026-08-14 実施。ja/en 両方 + AGENTS ja/en の索引追加。PR-6）
- [x] 本書を AGENTS.md / template-scope.md の関連リンクに追加（発見性・ドリフト防止）
      —（2026-08-13 反映: AGENTS.md「調査・レビュー記録」索引 + template-scope 関連リンク）

各項目は**実装ではなくドキュメント反映**。実装は実需トリガに従い roadmap §7 の
プロセスで別途着手する。
