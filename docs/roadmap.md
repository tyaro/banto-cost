# Banto 機能拡張ロードマップ（M10〜）

作成日: 2026-07-08（同日改訂: スコープをテンプレート汎用機能に限定）
状態: **M10〜M24 完了（v1 スコープ完了）。以降の拡張は §3「v2 / 将来構想
バックログ」に集約（実需・採用が出たらマイルストーンへ昇格）**

[ui-framework-spec.md](ui-framework-spec.md) の M0〜M9（完了）に続く機能拡張計画。

**スコープ方針**: 本リポジトリはあくまで**汎用の管理画面テンプレート**として
保つ。テンプレートに入れた機能は全利用者が継承・理解・（不要なら）削除する
対象になるため、「どんな管理画面でも必要になる横断機能」だけを追加する。
ドメイン寄りの基盤（SCADA向けタグストア・MQTT・定時実行・アラーム等）は
**テンプレートを利用する個別アプリ側**（または将来の拡張リポジトリ）で
開発する（§5 に設計指針として記録）。

## 1. マイルストーン一覧

| # | 内容 | 依存 | 規模 | 状態 |
|---|---|---|---|---|
| M10 | ユーザー管理UI + RBAC（ロール） | — | M | 完了 (PR #11) |
| M11 | 自動ログイン（デスクトップ + LAN） | M10（表示専用ロール） | M | 完了 (PR #12) |
| M12 | Glassテーマプリセット + SettingsProvider移行 | — | M | 完了 (PR #13) |
| M13 | チャート拡張（トレンド操作性 + SPC系3種） | — | M–L | 完了 (PR #14) |
| M14 | 監査ログ | M10（ロール・ユーザー基盤） | M | 完了 (PR #15) |
| M15 | CSV/Excel エクスポート・インポート | — | M | 完了 (PR #16) |
| M16 | コマンドパレット（Ctrl+K） | — | S–M | 完了 (PR #17) |
| M17 | SQLite バックアップ/リストア | — | M | 完了 (PR #18) |
| M18 | 基盤整備（E2E + lint/format + パッケージ配布） | — | M | 完了（2026-07-16） |
| M19 | 帳票/印刷 `@banto/report`（MDテンプレート方式） | — | M–L | 完了 |
| M20 | 添付ファイル/画像管理 | — | M | 完了 |
| M21 | バーコード/QR wedge 入力検出 | — | S | 完了 |
| M22 | ビジュアルリフレッシュ（Modern Operations Console 化） | — | L | 完了 (PR #25) |
| M23 | スキーマ→グリッド列の自動導出 | — | M | 完了（2026-07-19） |
| M24 | チャート追加（積立エリア・ガント、全14種） | M13 | M | 完了（2026-07-21） |

M14〜M17 はバックログから順次昇格。M18〜M21 は 2026-07-12 の
テンプレートスコープ整理（[template-scope.md](template-scope.md)）と
過去アプリ棚卸しに基づく計画。拡張リポジトリ（banto-industrial）と
記録計アプリの計画は別リポジトリ（境界は [template-scope.md](template-scope.md) §5）に分離。

---

## 2. 各マイルストーン詳細

### M10: ユーザー管理UI + RBAC

**目的**: 現状 users テーブルは初回セットアップの1アカウントのみ。複数ユーザーの
CRUD と、ロールによる権限制御を導入する。M11 自動ログインを「権限を絞った
アカウント」で安全に使うための前提。

**スコープ**:
- `users` テーブルに `role` 列を追加（マイグレーション）。ロールは
  `admin` / `editor` / `viewer` の3種から開始（列挙は拡張可能に）。
- ユーザー管理ページ（一覧グリッド + 作成/編集/削除、パスワードリセット）。
  admin ロールのみアクセス可。
  編集・リセットの非同期操作は開始時の対象IDと選択世代に結び付ける。
  一覧で別のユーザーを選んだ後（元のユーザーを選び直した場合も含む）は、
  古い応答で編集対象や新しい入力を変更しない。保存後も新しく入力した下書きを
  維持し、一覧は更新する。削除成功時は選び直しの有無によらず、現在の対象IDが
  削除対象と同じなら編集パネルを閉じ、選択世代を進めて保留中の保存応答を無効化する。
  別ユーザーを選択している場合は、その選択と入力を維持する。
- 最後の管理者を残す判定と降格・削除は、同じDBトランザクションで行う。
  SQLiteは `BEGIN IMMEDIATE`、PostgreSQLは `READ COMMITTED` と
  `users` テーブルの `SHARE ROW EXCLUSIVE` ロックで、対象ロールを読む前から
  更新を直列化する。別接続・別プロセスからの同時操作でも管理者を最低1名残し、
  拒否された変更は表示名も含めて反映しない。自己削除の拒否も維持する。
- 権限の適用点は**サービス層**（`admin-template-core`）に置く:
  - `viewer`: list/show のみ
  - `editor`: + create/update/delete
  - `admin`: + ユーザー管理・設定変更・サーバ制御
- リソース定義の `capabilities` とロールを掛け合わせて実効権限を導出。
  フロントは実効権限でボタン/ナビを出し分け（`Identity` に role を追加）。
- REST 側（LANブラウザ）と Tauri コマンド側の両方で同じ判定を通す。

**非スコープ**: リソース単位・行単位の細粒度ACL、外部IdP連携（OIDC等）。

**完了条件**: viewer アカウントで編集系 API が 403 相当で拒否される
（REST/Tauri 両経路のテスト）。管理ページから CRUD 一巡が動く。
最後の admin を削除/降格できないガードがある。

### M11: ログイン不要モード + 自動ログイン

**目的**: キオスク端末・常設ダッシュボード・単体ツール等、認証の重さが
用途に合わない環境に対応する。「認証そのものを外す」「認証は残して
無人化する」の両方をカバーする（2026-07-08 決定: 両方を M11 に含める）。

**スコープ**:
- **ログイン不要モード（認証無効化）**: 設定でオプトイン。有効時は
  ログイン画面を出さず、既定のローカルアイデンティティ（admin 相当、
  M10 のロール指定可）で即起動する。
  - **v1 では Tauri ウィンドウのみに限定**し、「認証無効 + LANサーバ有効」の
    組合せは設定バリデーションで拒否する（LAN側を無認証公開しない。
    LANのキオスク端末は viewer ロール + 下記 Remember me で賄う）。
  - 有効化時は設定画面に警告表示（信頼できる端末専用である旨）。
- **デスクトップ自動ログイン（Tauri）**: 設定画面にオプトインのトグル
  「起動時に自動ログイン」。資格情報は `keyring` クレートで OS キーリング
  （Windows資格情報マネージャー / macOS Keychain / Linux secret-service）に
  保存し、設定DBには**保存しない**。起動時に取得 → 既存 `users.verify()` を
  通してセッション確立（パスワード変更で自然に無効化される）。
- **LANブラウザ Remember me**: ログイン画面に「ログイン状態を保持」
  チェックボックス。ON のときトークンを sessionStorage → localStorage に
  切替え、サーバ側は長期 `TokenPolicy`（絶対30日/アイドル7日、設定可能）で
  発行。
- `AuthProvider.login()` に `remember?: boolean` を追加（3プロバイダ互換）。
- 設定画面に自動ログイン対象アカウントの表示と解除ボタン。

**非スコープ**: サーバ再起動をまたぐ remembered トークンの永続化
（トークンはサーバ側メモリ保持のまま。切れたら再ログイン。2026-07-08 決定）。
LANブラウザ側の認証無効化。

**完了条件**: 認証無効モードでログイン画面なしに起動し、LANサーバ有効化と
排他になる（バリデーションのテスト）。アプリ再起動で無操作ログインが成立
（Tauri）。LAN側はブラウザ再起動後もセッション継続。トグルOFF/パスワード
変更で自動ログインが無効化される。keyring 不在環境（一部Linux）で機能が
安全に degrade する。

**2026-09-14 追記（閲覧公開、Issue #189）**: 「認証を外す」を書き込み軸と
閲覧公開軸の 2 軸に分けた（[docs/design/viewer-public-plan.md](design/viewer-public-plan.md)、
[ADR-0012](adr/0012-lan-public-viewer-synthetic-session.md)）。
`server.viewerPublic` を ON にすると LAN クライアントは
`POST /api/auth/grant/publicViewer`（v3.0.0 で grant に一本化、[ADR-0017](adr/0017-credential-less-grant.md)）で **`viewer` 固定の合成セッション**を得て
ログイン無しで閲覧でき、上記の「認証無効 + LAN 有効」の排他は閲覧公開 ON の
ときだけ緩む。LAN からの無認証**書き込み**は引き続き不可（2026-07-08 決定の
意図を維持）。

### M12: Glassテーマプリセット + SettingsProvider移行

**目的**: 半透明・グラデーションを使った現代的なテーマの追加と、
UI設定の保存先を localStorage から SQLite 設定DBへ移行（仕様 §12.1 の宿題）。

**スコープ**:
- テーマ軸の直交化: 明暗（`data-theme`）× プリセット
  （`data-banto-preset="standard" | "glass"`）。`@banto/theme` に
  `banto-glass.css` を追加:
  - サーフェス系変数を半透明化 + `backdrop-filter: blur()`
  - アクセントにグラデーション変数（`--banto-accent-gradient`）
  - 適用は**シェルのみ**（サイドバー・ヘッダー・ドックパネル・モーダル）。
    グリッドのセル/行は不透明を維持（1万行仮想スクロールの再描画性能）
  - `prefers-reduced-transparency` / `backdrop-filter` 非対応環境で
    不透明フォールバック
- デスクトップの本物のガラス感（オプション）: Tauri ウィンドウ透過 +
  `window-vibrancy` クレートで Windows Acrylic/Mica。設定でON/OFF。
  **対象は Windows のみ**（macOS vibrancy は非スコープ、2026-07-08 決定）。
- **SettingsProvider**: `packages/admin-core` に設定抽象を追加し、
  テーマモード・プリセット・ドックレイアウトの保存先を
  localStorage → 既存 `settings` テーブル（Tauri/REST 経由）に移行。
  未認証時・デモモードは localStorage フォールバック。

**非スコープ**: ユーザー定義テーマエディタ、プリセット3種目以降。

**完了条件**: 設定画面で standard/glass を切替でき、再起動後も維持
（Tauri/LAN両方、設定DBに保存）。ダーク×glass 等4組合せで視認性が
成立。グリッド10k行のスクロールfpsが standard と有意差なし。

### M13: チャート拡張（`@banto/charts` v3）

**目的**: テンプレートを太らせずに価値を積める場所として `@banto/charts` を
強化する。監視ダッシュボード・ヒストリカルトレンド・生産管理（利用側アプリの
想定用途）に効き、かつ汎用ライブラリとしても意味のある範囲に限定する。

**スコープ**:

トレンド操作性（既存 LineChart/ComboChart の強化）:
- **ズーム/パン**: ホイールズーム + ドラッグパン、ダブルクリックでリセット。
  ヘッドレスコア（`core/`）に viewport 状態として実装し、テスト可能に
- **十字カーソル + 値読み出し**: カーソル位置の全系列の値をツールチップ/
  凡例に表示。時間軸スナップ
- **しきい値バンド / 注釈**: 上下限の帯（管理限界）、縦線イベントマーカー
  + ラベル
- **第2Y軸**: 異単位系列の重ね描き（温度×圧力など）
- **ストリーミング更新**: ローリング時間窓への追記API。全再描画を避ける
  差分更新で、1秒間隔更新×複数チャートのダッシュボードが破綻しないこと

新チャート種（SPC/QC の定番3種 — 生産管理デモかつ汎用）:
- **ヒストグラム**（ビン自動計算 + 指定、正規分布カーブ重ね描きオプション）
- **パレート図**（棒 + 累積折れ線、80%線）
- **箱ひげ図**（外れ値プロット付き）

その他:
- チャートの **SVG エクスポート**（一次スコープ。PNG はブラウザAPI依存の
  ため非スコープ → バックログ。2026-07-08 決定）
- ダッシュボードページに新機能を使ったデモパネルを追加

**非スコープ**: Canvas/WebGL 描画への移行（SVGフルスクラッチ方針を維持、
仕様 §6.2）、3D・地図等（仕様 §2.2 の非対象のまま）。

**完了条件**: 既存チャートのAPIに破壊的変更なし。ズーム/パン・
ストリーミングがヘッドレスコアのユニットテストで検証される。
10系列×1万点のトレンドでズーム操作が実用フレームレートを維持。
新3種は既存チャートと同じテーマ変数・Tooltip/Legend 基盤を使う。

### M14: 監査ログ

**目的**: 誰が・いつ・何をしたかの追跡。M10 RBAC で複数ユーザー・複数
ロールが操作する前提になったため、管理画面テンプレートの横断機能として
監査証跡を標準装備する（2026-07-10 バックログから昇格）。

**スコープ**:
- `audit_log` テーブル追加（マイグレーション）: 時刻、user_id +
  username スナップショット（ユーザー削除後も読める）、ロール、
  アクション、リソース、エンティティID、要約 detail(JSON)、
  経路（tauri/rest）、結果（成功/権限拒否）
- 記録点は**サービス層**（RBAC 判定と同じチョークポイント）:
  create/update/delete、ユーザー管理操作、設定変更、ログイン成功/失敗・
  ログアウト、権限拒否も記録。REST / Tauri 両経路で同一の記録を通す
- 保持ポリシー: 日数 or 上限行数で自動剪定（設定可能）
- 監査ログ閲覧ページ（admin のみ）: 既存グリッドで一覧・フィルタ
  （期間・ユーザー・アクション・リソース）

**非スコープ**: 改ざん防止（署名チェーン）、外部SIEM連携、行レベル
完全差分（detail は要約）、CSVエクスポート（バックログのCSV機能で対応）。

**完了条件**: 各ロールの操作・認証イベント・権限拒否が REST/Tauri 両経路で
記録される（テスト）。admin 以外は閲覧ページ・APIにアクセス不可。
剪定が動作する。読み取り系（list/show）は記録しない（ノイズ抑制）。

### M15: CSV エクスポート・インポート

**目的**: グリッドの一覧データをファイルとして持ち出し/取り込みできるように
する。既存クリップボード処理（TSVコピペ）の流用で費用対効果が高い
（2026-07-11 バックログから昇格）。

**スコープ**:
- **CSVコア**（`@banto/grid-svelte` の core、ヘッドレス + テスト）:
  RFC 4180 準拠のシリアライズ/パース（引用符・改行・カンマ）、
  Excel 日本語環境対策（UTF-8 BOM + CRLF）、ヘッダ行と列IDのマッピング、
  既存 `parseCellInput` / 列 `validate` を通す型変換・検証
- **バルクインポートAPI**（items で実演）: `POST /api/items/import` +
  Tauri `items_import`。トランザクション一括（id あり=update / なし=create）、
  行別エラーを返却。editor 以上。監査ログは `action='import'` で
  件数サマリ付き **1件** 記録（行単位で膨らませない）
- **UI**（items 一覧ページ）: page-header-actions に「エクスポート」
  （全ロール可、表示中のフィルタ/ソートを反映した全件）と「インポート」
  （editor 以上、ファイル選択 → 件数・エラーのプレビュー確認 → 実行）

**非スコープ**: ネイティブ .xlsx 生成（依存追加が必要 → バックログ。
Excel は BOM 付き CSV で開ける）。エクスポートの監査記録（クライアント側
処理のためサーバから区別不能、list と同じ読み取り扱い）。

**完了条件**: Excel(日本語Windows)で文字化けなく開ける CSV が出力される。
引用符・改行入りセルがラウンドトリップする（コアのユニットテスト）。
インポートのプレビューで検証エラーが行番号付きで見える。viewer では
インポート不可（REST/Tauri 両経路 403 + UI非表示）。監査ログに import が
1件記録される。

### M16: コマンドパレット（Ctrl+K）

**目的**: キーボード主導の横断ナビゲーション/操作。ナビゲーション定義から
自動導出し、テンプレート利用側がページを足すだけでパレットに載るようにする
（2026-07-11 バックログから昇格）。

**スコープ**:
- **コマンドレジストリ**（`@banto/admin-core`、ヘッドレス + テスト）:
  コマンド型（id, title, keywords, group, run, 可視条件）、ナビ定義からの
  自動導出、あいまい検索（前方一致 > 部分一致のスコアリング、日本語対応）、
  最近使ったコマンドの並び上げ（localStorage）
- **UIコンポーネント**: モーダルパレット、Ctrl+K / Cmd+K で開閉、
  ↑↓/Enter/Esc、グループ見出し表示。テーマ変数のみで両テーマ対応
- **標準コマンド**: 全ナビ項目へのページ遷移、テーマ切替（明暗/プリセット）、
  ログアウト
- **RBAC連動**: ロールに応じて見えるコマンドを絞る（admin専用ページは
  admin のみ。サイドバーの出し分けと同一条件）

**非スコープ**: コンテキスト依存コマンド（選択行への操作等）、履歴の
設定DB保存（localStorage で足りる）、コマンドのユーザー定義。

**完了条件**: Ctrl+K で開閉し検索 → Enter で遷移する。viewer に admin
専用コマンドが出ない。レジストリ/検索がユニットテストで検証される。
pnpm check / test 全パス。

### M17: SQLite バックアップ/リストア

**目的**: 運用中の設定・業務・監査データを守る基本機能。DB が items /
users / settings / audit_log と増えた今、テンプレート標準の運用機能として
装備する（2026-07-11 バックログから昇格）。

**スコープ**（すべて admin 専用）:
- **バックアップ作成**: `VACUUM INTO`（WAL 稼働中でも安全なオンライン
  バックアップ）で DB ファイル横の `backups/` に
  タイムスタンプ付きファイルを作成
- **一覧/取得**: バックアップ一覧（ファイル名・サイズ・作成日時）、
  LAN ブラウザ向けダウンロード（REST）。デスクトップはフォルダを開く
- **リストア（ステージング方式）**: アップロード or 一覧から選択 →
  `PRAGMA integrity_check` + スキーマ妥当性検証 → pending ファイルとして
  ステージ → **次回起動時に適用**（適用直前に現DBを自動バックアップ）。
  稼働中のプール差し替えはしない（v1 の安全側判断）。アップロードには
  サイズ上限（例256MB）を設ける（`DefaultBodyLimit`。axum 既定の 2MB は
  DB ファイルには不足するため明示指定）
- **監査**: backup / restore_staged / restore_applied を M14 監査ログに記録
- **UI**: 設定画面に admin 専用セクション（作成ボタン・一覧・
  リストアの確認ダイアログ・「再起動後に適用」の明示）

**非スコープ**: スケジュールバックアップ（cron 相当はテンプレート外の
方針、§4）、バックアップの自動世代管理、外部ストレージ転送、
稼働中ホットスワップ。

**完了条件**: バックアップファイルが作成・ダウンロードでき、壊れた
ファイルのリストアが検証で拒否される。ステージ → 再起動で適用され、
適用前の自動バックアップが残る。admin 以外は全 API 403 + UI 非表示。
REST/Tauri 両経路のテスト。監査ログに記録される。

### M18: 基盤整備（品質 + 配布）

**目的**: M10〜M17 で機能が揃ったため、機能追加を一旦止めて回帰防止と
外部消費の基盤を整える。拡張リポジトリ（banto-industrial、別リポジトリ）が
本リポジトリのパッケージ/クレートを参照する前提条件でもある
（2026-07-12 決定: E2E/lint と配布整備を1マイルストーンに束ねる）。

**スコープ**:
- **lint/format**: Prettier（svelteプラグイン）+ ESLint（svelte/TS）を
  ワークスペース全体に導入し、既存コードを一括整形。Rust は
  `cargo fmt --check` + `clippy` を CI に追加（improvements.md §5.1）
- **Playwright スモークE2E**: `banto-serve --features embed-ui` に対して
  ログイン → ダッシュボード → items CRUD 一巡 → 監査ログ表示の最小シナリオ。
  CI に E2E ジョブ追加（improvements.md §4）
- **パッケージ配布可能化**: `@banto/*` を GitHub Packages（私設npm）へ
  発行できる状態に（publishConfig・files・バージョニング規約）。
  Rust クレートは git タグ参照で消費する規約を文書化
- **コピー面積縮小方針の明文化**: `admin-template-core` のロジックを
  段階的にクレート側へ寄せる方針と対象候補を template-scope.md に追記
- **導入ドキュメント**: README にデモコンテンツ差し替え手順・
  オプション資産（dock/charts/glass/パレット）の削除手順を記載
  （template-scope.md §6 の宿題を回収）

**非スコープ**: E2E の網羅拡大（スモークのみ）、CI での自動 publish
（初回は手動）、コピー面積縮小の実施（方針文書化のみ、実施は必要時）。

**完了条件**: `pnpm lint` / `pnpm format:check` がゼロ指摘で通り CI ゲートに
入る。E2E スモークが CI で安定して通る。`pnpm publish --dry-run` が
全パッケージで成功する。README の手順に従い新規利用者がデモを
自リソースに差し替えられる。

**完了サマリ（2026-07-16）**: lint/format 基盤・スモークE2E・README差し替え/
削除手順・全パッケージ `publishConfig` は先行フェーズで整備済みだった。
残っていた4ギャップを本セッションで解消:

1. `.github/workflows/ci.yml` の rust ジョブ `-p` リストに、CI 導入後に
   M20 で追加された `banto-attachments` クレートが漏れていたのを追加
   （`cargo check`/`clippy`/`test`）
2. `e2e` ジョブに `pnpm e2e:visual`（Playwright visual regression +
   axe-core、40シナリオ）のステップを追加。既存 `pnpm build` の
   静的出力に対する `vite preview`（`playwright.config.ts` の
   `webServer` 配列2本目）でベースライン照合。失敗時の差分画像確認用に
   `e2e/test-results/` のアーティファクトアップロード（retention-days: 3）
   を追加
3. `pnpm -r publish --dry-run --no-git-checks` を全9パッケージ
   （admin-core/attachments/charts/dock-svelte/forms/grid-svelte/
   report/scan-wedge/theme）で実行し成功を確認（修正不要 — 各tarballは
   `LICENSE`（ルートMITの自動同梱）+ `package.json` + `src/**` のみで
   publishing.md の想定どおり）
4. `docs/template-scope.md` §6 の宿題2件（README のデモ差し替え/
   オプション資産削除手順）を確認したところ既に README §2/§3 に
   dock・charts・glass・コマンドパレット（パレット）・attachments・report
   すべての削除手順が揃っていたため追記なしで `[x]` 化

副産物として `pnpm format:check` が既存コード11ファイルで失敗していたのを
発見し、Prettier の自動整形（空白/改行のみ、挙動変更なし）で解消した。
`pnpm check`/`lint`/`format:check`/`test`/`build`/`cargo check`/`clippy`/
`test`/`e2e`（12件）/`e2e:visual`（40件）/`publish --dry-run`（9パッケージ）
すべて成功を確認済み。

### M19〜M21 の提供形態（2026-07-15 決定）

M19〜M21 はテンプレート本体へ焼き込まず、**「パッケージ + 削除可能デモ +
レシピ」方式**で提供する。runtime プラグイン機構は新設しない — 本リポジトリ
では `packages/`・`crates/` に切ること自体が配布手段であり
（publishing.md の git サブディレクトリ依存）、`setup.ts` の
`initBanto({ resources })` が事実上の拡張ポイントとして機能している。
別リポジトリへの分離も現時点では行わない（分離が正当なのは
banto-industrial のようなドメイン特化。汎用機能は本体モノレポの方が
CI・バージョン同期・E2E の維持コストが低い。拡張が本体 CI を圧迫し始めた
時点で banto-extensions への分離を再検討する）。

| | 実装単位 | テンプレートへの同梱 |
|---|---|---|
| M19 帳票 | `@banto/report` | 削除可能な最小デモページ（items から日報1枚） |
| M20 添付 | `banto-attachments` クレート + `@banto/attachments` | 削除可能なデモ配線（items への添付） |
| M21 wedge入力 | `@banto/scan-wedge`（仮称） | なし（README レシピのみ） |

同梱判断の基準: M20 は core/Tauri/REST 三経路の配線
（template-scope.md §2.1）こそが利用者の欲しい見本のためデモ配線を同梱、
M19 はデモ価値（「帳票も出せる」ことの可視化）のため最小デモのみ、
M21 は使う業種が限られるヘッドレス小粒機能のため同梱なし。
デモを同梱するものは template-scope.md §3 の「同梱するが消せる」義務
（削除しても他が壊れない・削除手順の明文化）を負う。

### M19: 帳票/印刷 `@banto/report`（完了）

MDテンプレート + データバインド → 印刷CSS HTML（→ 将来PDF）。
日報・写真帳・時系列帳票を同一エンジンの帳票定義違いとして扱う。
記録計 R3（banto-industrial 側の計画）が消費予定。詳細計画は
[report-plan.md](design/report-plan.md)。

実装: `@banto/report`（`parse`/`bind`/`html` のヘッドレスコア +
`renderReport` + `ReportView.svelte` + 印刷用 `print.css`）+ items
データから日報1枚を出す削除可能なデモ配線（`items/report/+page.svelte`、
`#lib/banto/reports/daily.md?raw` テンプレート、items 一覧の「日報」ghost
ボタン）。印刷時は `ReportView` がマウント中だけ `<body>` に付与する
`banto-report-active` クラスを介して、アプリ側 `app.css` の
`@media print` がシェル（サイドバー/ヘッダー）を非表示にする（帳票面
自体はテーマ非依存の白地・黒文字固定）。スモークE2Eは12シナリオ
（items → 日報 → 見出し・集計値・カテゴリ表の行を確認、`window.print()`
は呼ばない）。提供形態は上記のとおりパッケージ + 削除可能な最小デモページ
（削除手順は [recipes/remove-optional-assets.md](recipes/remove-optional-assets.md) / template-scope.md §3）。

### M20: 添付ファイル/画像管理（完了）

アップロード・保存・サムネイル・一覧（写真帳/現品写真/検査記録の土台）。
唯一のフルスタック拡張（DBマイグレーション・Rustストレージサービス・
REST・Tauriコマンド・UI）のため、クレート + パッケージのペアで実装し、
三経路配線の見本としてテンプレートに削除可能なデモを同梱する（上記提供
形態の表を参照）。詳細計画は [attachments-plan.md](design/attachments-plan.md)。

実装: `crates/banto-attachments`（サービス・ストレージ・サムネイル）+
`@banto/attachments`（AttachmentsClient 注入方式の AttachmentsPanel）+
REST/Tauri 配線・監査・items デモ配線（削除手順は README /
template-scope.md §3）。単位D のE2Eシナリオ追加が `AttachmentsPanel` の
`$effect` 無限ループを検出し、`untrack()` で解消済み
（attachments-plan.md §9 に経緯を記録）。スモークE2Eは11シナリオ
（添付のアップロード/サムネイル/削除 + viewer 読み取り専用確認を含む）。

### M21: バーコード/QR wedge 入力検出（完了）

ハードウェアスキャナのキーボードウェッジ入力を人間のタイプと区別して
1コードとして通知するヘッドレスコア + フォーカス管理アクション。小粒。
バックエンド・DB・UI 依存ゼロのため純粋なパッケージとして提供し、
テンプレートには同梱しない（README のレシピのみ）。

実装: `@banto/scan-wedge`（`packages/attachments` と同一の devDependencies
構成・config一式、新規依存追加なし）。

- `src/core/detector.ts`: DOM非依存のヘッドレスコア
  `createWedgeDetector({ onScan, minLength?, maxInterKeyMs?, terminators? })`。
  既定値は `minLength` 4文字 / `maxInterKeyMs` 35ms / `terminators`
  `['Enter']`。`Date.now()`・タイマーを一切使わず `event.timeStamp` のみで
  経過時間を判定するためテストが決定的。印字1文字キーのみバッファし、
  直前キーとの間隔が `maxInterKeyMs` を超えたら今回の1文字にバッファを
  リセット。Ctrl/Alt/Meta押下中・IME変換中・Shift等の非印字多文字キーは
  バッファを壊さず無視（Shiftキー自体のkeydownは大文字スキャンを妨げない）。
- `src/listen.ts`: DOMラッパー `listenWedge(target, options)`。
  capture フェーズ `keydown` をコアへ転送し、スキャン成立時は既定で
  終端キーの `preventDefault()`、`ignoreEditable` で入力欄フォーカス中の
  検出を抑止。「スキャン中の文字はフォーカス中の入力欄に混入済みで
  後から抑止できない」制約と回避策をJSDocに明記。
- `src/actions.ts`: Svelte 5 アクション `wedgeInput`（専用入力欄でスキャン
  検知しクリア + `bind:value` と整合する `input` イベント発火）、
  `keepFocused`（キオスク向けのフォーカス維持、副作用をJSDocに明記）。
- `src/index.ts` で全公開APIを named export。
- テスト（vitest、26件）: コア10件（高速バースト・80ms不発・minLength未満・
  途中リセット・Shift混在・Ctrlコンボ・IME・連続2スキャン・reset()・
  terminatorsカスタム）、listen 7件、actions 9件。ワークスペース全体が
  `environment: 'node'`（jsdom/happy-dom 不使用、新規依存も禁止のため）
  のため、`listen.ts`/`actions.ts` のテストは `EventTarget`/`HTMLElement`
  の手製スタンドインで実DOM相当の経路を検証。
- README に「バーコード/QRスキャナ入力」レシピ節を追加（グローバル検出・
  `use:wedgeInput`・キオスク`use:keepFocused`の3例）。
- `apps/admin-template` への配線・依存追加は行っていない
  （`pnpm check`/`lint`/`test`/`build`/`e2e` 全通過、既存11件のE2Eに影響なし）。

### M22: ビジュアルリフレッシュ（完了）

計画: [visual-refresh-plan.md](design/visual-refresh-plan.md) /
設計: [visual-refresh-design.md](design/visual-refresh-design.md)。
機能・API・DB を変えずにフロントエンド表示層のみを刷新する
「Modern Operations Console」化。テーマトークン拡張（面階層・状態色
3系統・影・モーション）、密度軸 `data-banto-density`、Tailwind `@theme`
橋渡し、共通UI（PageHeader/StatusBadge/状態表示/Popover API メニュー）、
`@lucide/svelte` によるアイコン統一、シェル刷新（900px オーバーレイ・
ユーザーメニュー・検索ピル）、ログイン2ペイン、View Transitions、
全画面のトークン統一。実装単位1〜6を PR #25 でマージ。

**完了条件**: visual-refresh-plan.md §8 の8項目（絵文字ゼロ・トークン
統一・コントラスト数値基準・768px 対応・回帰なし・reduced-motion/
transparency・全自動確認成功・追加バックエンドなし）。検証基盤
（Playwright ビジュアルリグレッション + axe-core、計画 Phase 0/§7.1）は
後続PRで追加。

### M23: スキーマ→グリッド列の自動導出（完了 2026-07-19）

**背景**: 仕様 §3.1 の最重要ゴール「スキーマを1つ書けば一覧と編集フォームが
両方生える」のうち、フォーム側（`FormSchema` → `@banto/forms`）は実装済み
だが、**一覧側（スキーマ → `GridColumn[]` の導出）は未実装**であることを
2026-07-18 の棚卸しで確認した（improvements.md §6.3、
improvement-plan-2026-07.md P1-2）。現状グリッド列はアプリ側で手書きする
（`ItemsClientGrid.svelte` の `baseColumns` 等）。

**スコープ案**: `@banto/grid-svelte`（または `admin-core`）に
`columnsFromSchema(schema: FormSchema): GridColumn[]` 相当の純関数を追加し、
`FieldType` → `CellEditorType`/フォーマッタの既定対応を定義。手書き列との
併用（導出結果を差分上書き）を許す。既存の `items` デモを導出ベースに
書き換えて手本にする。

**位置づけ**: テンプレートの体験価値の核（v1.1 筆頭候補）。

**実装（2026-07-19）**: `@banto/grid-svelte` に `columnsFromSchema<TRow>(
schema, { overrides, editable })`（`src/core/schema.ts`、Svelte 非依存の
純関数）を追加。`SchemaField`/`ColumnsSchema` は @banto/forms の
`FieldDef`/`FormSchema` の**構造的ミラー**（パッケージ間 import ゼロの
規約を維持 — admin-core の `schema?: unknown` と同じ流儀）。password
フィールドはスキップ、text/number は filterable、readonly は表示専用、
select は値→ラベルの format と editorOptions を導出。バリデータは forms
`validateField` と同一のルール順・同一の日本語メッセージ（required →
bounds/length → custom。「MUST be kept in sync」コメントで同期義務を明記）。
items 一覧の name/price/stock/updatedAt 列を導出ベースへ書き換えて手本化
（手書きが残るのは行リンクの 操作 列と DB 採番の id 列 + 幅/¥フォーマット
の overrides のみ）。ユニットテスト9件（tests/schema.test.ts）。

### M24: チャート追加 — 積立エリア・ガント（完了 2026-07-21）

**背景**: `@banto/charts` に積立グラフとガントチャートを追加。積立棒は v1 から
`BarChart` の `stacked` で対応済みだったため、不足していた **積立折れ線（積立
エリア）** と **ガント** を実装（spec §6.1 に反映、全14種）。

**実装（2026-07-21）**:

- `StackedAreaChart.svelte`（`generics="TRow"`）: 既存の `core/stack.ts`
  （`stackSeries`）を再利用し、隣接する累積境界の間を塗る。`LineChart` の
  ズーム/第2Y軸/デシメーションとは累積ベースラインの意味が衝突するため、
  フラグではなく専用コンポーネントにした（設計判断はファイル doc に明記）。
  境界間バンドは新規純関数 `core/path.ts` `bandAreaPath(top, bottom)`。
- `GanttChart.svelte` + `core/gantt.ts`（純関数 `toMs`/`ganttDomain`/
  `ganttLayout`、時間ドメインに対する 0..1 分率を返しピクセルを知らない）。
  時間軸バー・進捗オーバーレイ・「今日」マーカー。依存線・ドラッグ編集は
  非スコープ（「やりすぎない」）。時刻は epoch ms 内部表現、表示は `formatDate`
  委譲で日付ライブラリを同梱しない（依存を足さない、§3）。
- ユニットテスト: `bandAreaPath` 2件 + `gantt` 12件。依存追加なし・生色値なし
  （テーマトークンのみ、verify:architecture 緑）。
- **デモ配線は別途**: ダッシュボードのデモは visual regression でスナップショット
  されており、ベースライン再生成が必要なため、本追加はコンポーネント/コア/
  テスト/エクスポートに留めた（ダッシュボードへの組み込みは下記の別 PR）。

**デモ配線（2026-07-22）**:

- `apps/admin-template` のダッシュボードに「チャート拡張（M24）」セクションを
  追加（`routes/(app)/dashboard/+page.svelte`）。既存の `.card`/`.chart-grid`
  を流用し新規 CSS なし、`.primary`/`.secondary` を付けずフル幅で 1 枚ずつ
  並べる（積立エリアは月次で点数が多く、ガントは時間軸が横に広いため、
  4/12 カラムではどちらも潰れる）。
- データ生成は `src/lib/banto/dashboard.ts` の純関数 2 本:
  `categoryTrendByMonth`（積立エリア＝上位カテゴリ別更新件数の月次積み上げ、
  欠測を 0 で埋めて面の破綻を防ぐ）/ `inventorySchedule`（ガント＝棚卸し工程の
  見立てタスクと「今日」マーカー）。どちらも壁時計（`Date.now()` / 引数なし
  `new Date()`）を使わず、`updatesByMonth` が返すデータセット由来の月リスト
  だけからタイムラインを組む — visual regression が実行日に依存しないため。
  `formatDate` も `toLocaleDateString()` 既定ではなく UTC ゲッタで明示指定。
- ドックパネル定義（`panels.ts`）と `DashboardPanel.svelte` は変更していない
  （保存済みドックレイアウトを壊さない）。
- **ベースライン再生成が必要**: ダッシュボードの全 12 スナップショットが差し替え
  になる。ベースラインは Linux 生成のみ（`-linux.png`）なので、Windows/macOS の
  作業機では `--update-snapshots` を実行してはいけない（`-win32`/`-darwin` が
  併存して増えるだけ）。手動ワークフロー
  `.github/workflows/visual-baselines.yml` を対象ブランチで dispatch して
  ubuntu-latest 上で再生成する。

## 3. v2 / 将来構想バックログ

v1（M0〜M24）で汎用管理画面テンプレートとしての機能は出そろった。以下は
**v2 の設計テーマ**。優先度は付けず、実需・採用が出た時点で本ドキュメントの
マイルストーンに昇格させる実需ドリブン文化に従う。実需の供給源は3系統ある
— (a) 外部採用者 (b) banto-industrial / 記録計アプリ
（[template-scope.md](template-scope.md) §5） (c) メンテナ自身の実案件 —
であり、**当面の第一供給源は (b)**。あわせて以下の2つの運用則を置く:

- トリガ未発火のままメンテナ判断で昇格・実施する場合は、当該項目に
  **「判断昇格（トリガ未発火）」**と明記して記録する（V2 テーマA〜C は
  この例外経路の前例 — 遡及記録として本文に1語追記してよい）。
- **外部採用者のみを発火源とするトリガには12ヶ月の時限を付す**:
  未発火のまま12ヶ月経過したら、項目を削除するか内部観測トリガへ
  書き換える（ADR-0010 の撤退条項と同じ様式）。

V2 ではテーマA（PostgreSQL アプリ全体対応、#106-109）・テーマB（i18n レイヤ②/③、
#110-113）・テーマC（コピー面積縮小、#114-117）を**実施済み**（下記に反映）。

**進捗管理**: このバックログが並行実行フェーズに入る（複数テーマが同時進行、
または外部採用者から issue が立ち始める）までは、計画・状態とも本ドキュメントで
足りる。その段階になったら GitHub Projects を**ステータス専用レイヤ**として
起こしてよい — ただし知識（不変条件・仕様・判断）は in-repo docs に据え置き、
Projects へ移さない。線引きと退けた代替案は
[ADR-0006](adr/0006-docs-in-repo-projects-status-only.md)。

**外部レビューの棚卸し（2026-08）**: 外部AIレビューが提案した機能群を実測で裏取り
し、本バックログへの取捨を [feature-review-2026-08.md](reviews/feature-review-2026-08.md) に
記録した。下記バックログ項目のうち updater / PWA / バックアップアーカイブ /
API Token はそのレビューの設計上の但し書き（依存ゲート・リリースパイプライン前提・
HTTP制約・ロール紐付け設計）を参照。version 表示・System Info カード・PWA manifest・
`Notice` 発火レシピは「今すぐ着手できる小粒（依存ゼロ）」として同 §4 に分類。

- Tauri updater（自動更新。**依存2件**は §3 設計判断ゲート＝ADR、**バイナリ
  リリースパイプライン新設**が前提、定期チェックは「cron 相当を持たない」除外と
  衝突するため起動時/手動チェックに限定。詳細は
  [feature-review-2026-08.md](reviews/feature-review-2026-08.md) §2.3）
- ~~PWA 対応（LANブラウザモードに manifest）~~ → **実装済み（2026-08）**:
  installable-only（manifest + アイコン + `guess_mime` の webmanifest arm）。
  Service Worker なし。HTTPS/localhost/TLS プロキシ配下でのみインストール可。
  [feature-review-2026-08.md](reviews/feature-review-2026-08.md) §2.8 / CHANGELOG
- **チャート性能エスカレーション梯子**
  （[ADR-0009](adr/0009-schema-ui-rest-renderer-boundary.md)。手前の段で
  要件が満たされる限り次の段に進まない）:
  - 第0段: 現行 SVG の実測ベースライン（`packages/charts/tests/trend.bench.ts`、
    `pnpm bench` — 2026-08 新設）
  - 第1段: サーバ側集約/間引き（バケットごと min/max 保存 — 現行 stride
    間引きのスパイク欠落は `decimate.ts` が自認しており、SCADA 的には
    データ忠実性の課題でもある）+ サンプル配送経路の設計（現行 SSE は
    `ResourceChanged`→全件リフェッチのみでストリーミング用途の経路が無い。
    テンプレート本体か banto-industrial かのスコープ判定を含む）
  - 第2段: Canvas 2D レンダラ（同一チャート API の裏に差す。
    core/scale・viewport・decimate はレンダラ非依存の純関数で流用可）
  - 第3段: WebGL/WebGPU（Tauri WebView 実環境での確認必須 — 特に Linux
    webkit2gtk は WebGPU 未対応。WebView エンジン差し替え経路として
    tauri-runtime-verso を定点観測）
  - 第4段: ネイティブレンダラ候補ウォッチ（テンプレート外の研究。接続は
    REST/SSE クライアント限定 — ADR-0009）
  - 第4段の着手条件: 第2段の実測性能限界に当たる実案件 + 複数回の再発 +
    候補がフォーク非依存の収斂条件（組織バック体制・6〜12ヶ月の定期
    リリース・コンポーネント資産の稼働・Windows で production 品質。
    GPUI 系は Zed 本体の活動も見る）を満たすこと。撤退条件: 手前の段で
    要件充足 / 候補の停滞継続 / PoC 予算超過。2026-08 時点の候補状況は
    ADR-0009 帰結に記録。
- **[V2 テーマA 実施済み #106-109] PostgreSQL アプリ全体対応**: 接続ヘルパ
  `banto-storage/postgres.rs`（#93・実 `postgres:16` CI 検証）に加え、service 層を
  `Db`/`Dialect` で汎用化し、方言別マイグレーション（`migrations-{sqlite,postgres}/`）
  と `db::init_db_from_target` の `postgres://` 経路を実装。backup は SQLite 専用の
  まま（PostgreSQL は明示エラー）。（V2 判断 D3: VACUUM INTO と起動時ファイル
  差し替えに PostgreSQL の対応物が無く、論理バックアップは pg_dump が定石の
  ため。運用案内は [recipes/database-backup.md](recipes/database-backup.md)）。既定は SQLite 維持。仕様 §12.1。
- **[V2 テーマB 実施済み #110-113] i18n レイヤ②/③**: Paraglide JS を採用し
  （[ADR-0005](adr/0005-i18n-paraglide.md)）、app 層の可視文言を全キー化した
  （`messages/{en,ja}.json`・`locale.ts`・設定画面の言語切替 UI）。レイヤ①
  （パッケージ文言の外部化）は #81。規約は conventions §13、機械検査は
  `verify:architecture` rule `raw-jp-in-app`。
- **[V2 テーマC 実施済み #114-117] コピー面積縮小**: 汎用サービス層を
  `crates/banto-admin-services` へ、汎用 REST ルーターを
  `crates/banto-server/src/routes/` へ移設した（`admin-template-core` には items
  固有分のみ残置）。方針は [template-scope.md](template-scope.md) §7。
- 設定画面 LAN 節の注意書きを warning 表示へ格上げ（2026-07 サイクルの P1-4 残。
  ブロッカーだったベースライン再生成環境は `visual-baselines.yml` で解消済み。
  経緯は [history/improvement-plan-2026-07.md](history/improvement-plan-2026-07.md) P1-4 ※2）
- 実務寄りサンプルアプリの追加（2026-07 サイクルの P4-8。着手前に
  [template-scope.md §4](template-scope.md) の4条件でスコープ判定を行うこと）
- 添付を含むバックアップアーカイブ（M17 バックアップは SQLite ファイルのみ
  で添付の実ファイルを含まない。attachments-plan.md §8 の既知の制限）。設計上の
  但し書き（zip は依存追加＝ADR、依存ゼロのディレクトリ方式から始める、restore の
  ツリー差し替えが本丸）は [feature-review-2026-08.md](reviews/feature-review-2026-08.md) §2.1
- API Token / Service Account（機械・非人間アクセス。現状トークンはインメモリの
  人間セッションのみで機械アクセス手段はゼロ。**自由形式 scope ではなく既存ロールに
  紐付けたトークン**が設計指針。依存追加ゼロで実装可、規模は M10+M14 級。
  最初の外部連携需要が出た時点で昇格。詳細は
  [feature-review-2026-08.md](reviews/feature-review-2026-08.md) §2.2）

**post-v2（採用が出てから）**: 中核（conventions / AGENTS / ADR 全件 / README）は
#119 で英語化済み（2026-08-26 追記、新設 ADR-0011 分は同日追随で翻訳済み）。
残りは docs 本体13ファイル（roadmap / template-scope / ui-framework-spec /
publishing / `*-plan.md` 系 / レビュー系）・recipes 3ファイル（notifications /
scan-wedge / tree-svelte）・history 5ファイルの計21ファイルで、着手は採用が
生まれた段階（12ヶ月時限の対象。実測は `ls docs/*.en.md docs/adr/*.en.md
docs/recipes/*.en.md`、2026-08-26）。

除外を決めた項目: i18n **辞書層**は 2026-07-12 に一度バックログから削除したが、
2026-07-22 に「段階導入」へ方針転換（レイヤ①実装済み #81、②/③は上記 v2
バックログ。理由は template-scope.md §4.3）。Playwright E2E / lint・format は
M18 に昇格済み。

## 4. テンプレートに入れないと決めたもの

2026-07-08 の設計判断。**個別アプリ（または将来のテンプレート拡張
リポジトリ）で開発する**:

| 機能 | 理由 |
|---|---|
| MQTTブローカー | 外部運用（Mosquitto/EMQX等）が定石。自前実装は保守コストに見合わない（仕様 §12.4 の既定方針どおり） |
| MQTTクライアント（購読/発行） | SCADA系アプリ専用の入口。テンプレート全利用者への荷物になる |
| 汎用KVサーバ | 必要なら Redis 等の実績あるものを使う領域 |
| リアルタイムタグストア（現在値） | SCADA ドメイン基盤。テンプレートの SSE/イベント基盤の上に利用側で構築 |
| cron的定時実行基盤 | 同上（必要アプリ側で tokio ベースに実装） |
| アラーム管理 | タグストア前提のドメイン機能 |

## 5. 付録: SCADA系アプリを構築する際の設計指針

上記を個別アプリで開発する日のための、議論済みアーキテクチャの記録:

- **データフロー**: デバイス → 外部ブローカー → MQTTクライアント（rumqttc、
  購読）→ タグストア（現在値、品質 Good/Bad/Stale、デッドバンド）→
  テンプレートの SSE / Tauri イベントで UI へ（仕様 §12.4「MQTTは業務データの
  入口、SSEはUIへの出口」）
- **履歴**: 定時実行（cron式 + SQLite に履歴、取りこぼしポリシー選択制）が
  タグ現在値をロールアップして PostgreSQL/TimescaleDB へ書き込み。
  ヒストリカルトレンドは M13 のズーム/パン付きチャートで表示
- **アラーム**: タグ条件（閾値・不感帯・遅延でチャタリング抑制）→ 状態遷移
  （正常→警報→ACK→復帰）→ 履歴。ACK は RBAC（M10）の権限を通す
- **秘匿情報**: ブローカー/DB接続のパスワードは M11 で導入する keyring に
  保存（設定DBに平文で置かない）
- **プロセス構成**: デスクトップ + 組み込みサーバは同一プロセスなので、
  スケジューラ/タグストアは単一インスタンスで足りる（分散ロック不要）

## 6. 未決事項 → 決定済み（2026-07-08）

- [x] **M11 のスコープ** → ログイン不要モード + keyring自動ログイン +
      LAN Remember me の**全部を M11 に含める**。認証無効は Tauri のみ
      （LANサーバとの併用は拒否）
- [x] **LAN側 Remember me** → サーバ再起動でセッションが切れる仕様を
      v1 では許容（切れたら再ログイン）
- [x] **ロールの粒度**（M10）→ admin/editor/viewer の3ロール固定で開始。
      リソース単位の上書きは将来拡張
- [x] **`window-vibrancy` の対象OS**（M12）→ **Windows のみ**
- [x] **チャートエクスポート形式**（M13）→ **SVGのみ**を一次スコープ、
      PNG はバックログ

## 7. 実施プロセス

各マイルストーンは以下の流れで進める（モデル委譲ルールに従う）:

1. 司令塔が設計を固め、タスク分割（Phase A/B 程度に分割、M8 方式）
2. 調査は Explore(haiku)、実装・テストは general-purpose(sonnet)、
   難所（並行処理・性能チューニング等）は general-purpose(opus) に委譲
3. 成果物を司令塔がレビューし、`pnpm check` / `cargo test` / CI で検証
4. マイルストーンごとに PR を作成しマージ（CI ゲート必須）。同じ PR で、対応する plan / design
   文書の冒頭の `状態:` 行（あれば `最終検証日:` も）を更新する（状態ヘッダの陳腐化を防ぐ）
