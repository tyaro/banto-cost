# Banto テンプレートスコープ整理 — 必要な物と除外すべき物

作成日: 2026-07-11（M10〜M17 時点の棚卸しとして作成、以後追随更新。
最終更新 2026-10-07）
位置づけ: [roadmap.md](roadmap.md) の「スコープ方針」を、実装済み資産の全量に
対して適用し直した結果の記録。今後の機能追加・削除の判断基準として使う。
判定基準の最新の適用例は [feature-review-2026-08.md](reviews/feature-review-2026-08.md)
（外部提案の実測検証と取捨。詳細RBAC反対・PWA賛成などの判定記録）。

トラック: 本書は**保守者向け（トラックA）**。何を入れる/入れないの判定と、
実装不変条件（[conventions.md](conventions.md)）とは役割が別 — こちらは「スコープ」、
向こうは「作法」。アプリ作者向けの削除手順・導入手順は [README](../README.md) と
[recipes/](recipes/)（トラックB）にあり、本書 §6 の宿題や §3 の各削除手順はその README 側成果物を
指す（＝2トラックが同一事項の表裏で交差する箇所）。トラック分けの全体像は
[README「ドキュメントの2トラック」](../README.md#ドキュメントの2トラック)。

## 1. テンプレートの定義（何であるか / 何でないか）

Banto は **Tauri デスクトップ + LAN ブラウザ配信の二形態で動く、汎用の
管理画面テンプレート**である（仕様 §1, §11）。利用者はこのリポジトリを
コピーして個別アプリを作る。したがってテンプレートに入れた物はすべて
「全利用者が継承・理解・保守し、不要なら削除する対象」になる。

### 判定基準（機能を入れる/残すための4条件）

| # | 基準 | 落ちる例 |
|---|---|---|
| 1 | **横断性**: どんな管理画面でも必要になるか | タグストア（SCADA専用） |
| 2 | **削除容易性**: 不要な利用者が安全に外せるか | シェルに深く絡む常時機能 |
| 3 | **代替不能性**: 実績ある外部ソフトで済まないか | MQTTブローカー、KVサーバ |
| 4 | **無ドメイン性**: 特定業種の知識を持ち込まないか | アラーム管理、帳票 |

4条件を満たす → コア（§2）。1〜2を条件付きで満たす → オプション（§3）。
満たさない → 除外（§4）。

## 2. コア — テンプレートの背骨（削除を想定しない）

これが無いと「管理画面テンプレート」として成立しない層。

### 2.1 フレームワーク層（パッケージ / クレート）

| 資産 | 役割 | 判定理由 |
|---|---|---|
| `@banto/admin-core` | リソース定義・データ/認証/設定/イベントプロバイダ | 全ページの配線基盤 |
| `@banto/grid-svelte` | データグリッド（仮想化・編集・クリップボード・CSVコア） | 一覧は管理画面の中核 |
| `@banto/forms` | スキーマ駆動フォーム | CRUD の入力側の中核 |
| `@banto/theme` | 明暗テーマ・CSS変数 | 全UIの土台 |
| `@banto/ui` | 汎用 UI 部品（PageHeader・SurfaceCard・StatusBadge・IconButton・Empty/Error/LoadingState、メニュー部品 `Menu`/`MenuGroup`/`MenuItem`/`MenuSeparator`、`CommandPalette`）。文言・アイコン・状態・操作は注入で受け取り、依存は空（ADR-0018） | シェル（Header・Sidebar）と全ページが使う。他の `@banto/*` を import しないのでコア→オプションの逆依存は起きない |
| `crates/banto-core` | サービス/リポジトリ trait・ListParams・エラー型 | Rust側の共通語彙 |
| `crates/banto-storage` | sqlx リポジトリ・list_query（SQLite/PostgreSQL、`Db`/`Dialect` で方言吸収） | 永続化の標準経路 |
| `crates/banto-server` | axum 組み込みサーバ（REST・認証・静的配信）+ 汎用 REST ルーター（`routes/`、V2 テーマC で移設） | LAN形態の成立条件 |
| `crates/banto-admin-services` | 汎用サービス層（設定/監査/RBAC・ユーザー/バックアップ）。V2 テーマC で `admin-template-core` から移設 | 汎用ロジックのコピー面積を削減（§7） |
| `admin-template-core` | items（デモリソース）固有のサービス層 + REST + 汎用ルーターの `.merge()` 組み立て（Tauri と二経路で同一判定） | 「フロント→サービス→DB貫通」がテンプレートの価値そのもの。**クレート自体はコア**（`.merge()` 組み立て・`first_boot`・`db`・`assets` が常在）だが、その中の `items` 一式は §3 のデモリソース（`display` で削除可） |

> `@banto/ui`（Issue #220・[ADR-0018](adr/0018-shared-ui-package.md)）は段階 1 で
> `apps/admin-template/src/lib/components/ui/` の 7 部品を切り出した。段階 2 は 2a（テーマの
> トークン + `components/menu/` のメニュー部品）・2b（CommandPalette の表示と操作）・2c（トーストの
> `createToastStore()` と `ToastHost`）が済み、段階 2 は完了（Modal / Drawer と層の補助は段階 2 に入れない）。
> admin-template の `CommandPalette.svelte` はアプリ側の薄い包み（コマンドの一覧・検索・セッションの
> スコープ・最近使った記録・通知・文言）で、表示と操作は `@banto/ui` にある。`toast.svelte.ts` と
> `ToastHost.svelte` も薄い包み（ストアの生成と文言だけ）。scaffold の `commandPalette` オプションが
> 消すファイルは変わらない。`@banto/ui` は `.svelte.ts` を持つので `optimizeDeps.exclude` に載り、
> scaffold はこの行を残す（常に使うため）。

### 2.2 横断機能（M10〜M17 で追加した運用系）

| 機能 | 判定理由 |
|---|---|
| 認証 + RBAC（admin/editor/viewer）+ ユーザー管理（M10） | 複数人で使う管理画面の前提。LAN形態がある以上必須 |
| 監査ログ + 保持ポリシー（M14） | RBAC を入れた時点で「誰が何をしたか」は標準装備が筋 |
| 設定基盤（settings テーブル + SettingsProvider、M12） | 全機能の設定の置き場。localStorage 依存からの脱却済み |
| CSV エクスポート/インポート（M15） | 「データをファイルで出し入れしたい」は業種を問わない |
| SQLite バックアップ/リストア（M17） | データを持つアプリの運用最低限。外部ツール代替が難しい（ステージング適用は起動シーケンスと不可分） |
| LAN Remember me + TokenPolicy（M11の一部） | LAN形態の実用性に直結 |
| シェル（サイドバー/ヘッダー/ログイン/設定画面） | テンプレートの骨格 |
| ナビの表示形式（サイドバー / ドック、nav-launcher-plan.md D3-a） | シェルの一部。重い部分は `@banto/ui` の `LauncherBar` にあり、アプリ側は配線と設定だけ。既定はサイドバー（`NAV_LAYOUT_DEFAULT`）で、選ばせないならカード 1 枚とキーを消すだけ（README） |

## 3. オプション — 同梱するが「消せる」ことを保証する

横断性または削除容易性が条件付きの物。**削除しても他が壊れない構造を
維持する義務**をテンプレート側が負う（依存方向: シェル→オプション は可、
オプション→コア は可、コア→オプション は不可）。

| 資産/機能 | 条件・削除方法 | 備考 |
|---|---|---|
| `@banto/dock-svelte` | 独立パッケージ。ダッシュボードページごと差し替えれば外れる | 全管理画面がドッキングを要るわけではない |
| `@banto/charts` | 独立パッケージ。デモパネル削除で参照が消える | SPC系3種（ヒストグラム/パレート/箱ひげ）は生産管理寄りだが、汎用ライブラリの一部として妥当（M13判断を維持） |
| Glass テーマ + Windows vibrancy（M12） | プリセット未選択なら不活性。CSS 1ファイル + オプトイン設定 | 見た目のオプション。standard だけで完結する |
| 認証無効モード / デスクトップ自動ログイン（M11） | 設定オプトイン。既定OFF | キオスク用途限定。LANサーバとの排他は維持必須 |
| コマンドパレット（M16） | ナビ定義から自動導出のため保守コストほぼゼロ。コンポーネント1つ+シェルの数行 | 無くても操作は成立するが、削除する動機も薄い |
| デモコンテンツ（items 1万件、ダッシュボード各パネル、SPC/トレンドデモ） | **利用開始時に置き換える前提**。テンプレートの「見本」として同梱 | 雛形の理解材料。README/導入手順で差し替え箇所を明示すべき（→ §6 宿題) |
| **`items` デモリソース一式**（2026-09 再分類、Issue #190 / display-preset-plan §2 原則 2） | `pnpm scaffold --preset display` が丸ごと削除する。手作業なら: `core/src/items.rs`・`core/src/rest/items.rs`・`core/migrations-{sqlite,postgres}/0001_items.sql`・`core/src/{lib,db}.rs` と `core/src/rest/{mod,tests}.rs`・`src-tauri/src/lib.rs` の `// [scaffold:items]` マーカー区画・`src/routes/(app)/items/**`・`#lib/banto/{itemsAdmin,resources/items,sampleData,dashboard}.ts`・`src/lib/navigation.ts` / `navIcons.ts` の items 行・`messages/{ja,en}.json` の `items.*`/`nav.items`・`scripts/verify-architecture.mjs` の items マニフェスト行（DUAL_PATH 4 / TAURI_READ 2 / REST_READ 2 / DESKTOP_ONLY 1）を外す | 長く §2.2「コア」扱いだったが、実体は**差し替え前提のデモリソース**。削除経路を機械検査（template-acceptance の `display` matrix）で保証するため §3 に移した。**削除しても壊れない義務**は他のオプション資産と同じ。区画にマーカーコメントを置いてあるので、items 側を大きく動かす PR はマーカーの内外が正しいか確認すること |
| `@banto/attachments` + items 添付デモ（M20） | 独立パッケージ + `crates/banto-attachments`。`items/[id]/+page.svelte` のパネル配線・`attachmentsClient.ts`・`package.json` 依存・REST/Tauri ルータ/コマンド・`core/migrations-sqlite/0006_attachments.sql`（+ `migrations-postgres/0006_attachments.sql`）を外せば削除できる（[recipes/remove-optional-assets.md](recipes/remove-optional-assets.md) に手順） | §3.1 の「パッケージ + 削除可能デモ」方式の初適用例。デモモード（ブラウザ単体）では非表示。バックアップ非対象（§8 既知の制限） |
| `@banto/report` + 日報デモ（M19） | 独立パッケージ（DB/バックエンド依存なし）。items 一覧の「日報」ボタン1行・`items/report/+page.svelte`・`#lib/banto/reports/daily.md?raw`・`package.json` 依存を外せば削除できる（[recipes/remove-optional-assets.md](recipes/remove-optional-assets.md) に手順） | §3.1 の「パッケージ + 削除可能デモ」方式。M20と異なりバックエンド/DB配線を持たない最小デモ（roadmap.md M19〜M21の提供形態）。印刷CSSの `.report-body` はテーマ非依存の白地・黒文字固定（帳票の再現性優先、report-plan.md §3.4） |
| `@banto/tree-svelte` + ツリーデモ（M-review 2026-08） | 独立パッケージ（DB/バックエンド依存なし）。ナビ1行（`navigation.ts` の union + navItems、`navIcons.ts` の対応アイコン）・`routes/(app)/tree/+page.svelte`・`#lib/banto/treeSample.ts`・`i18n.ts` の `treeMessages()`・`messages/{ja,en}.json` の `nav.tree`/`tree.*` キー・`package.json` 依存を外せば削除できる（[recipes/remove-optional-assets.md](recipes/remove-optional-assets.md) に手順） | §3.1 の「パッケージ + 削除可能デモ」方式。report と同じくバックエンド/DB 非依存。ナビ追加でサイドバーが写る認証ページの視覚回帰ベースラインを再生成する（`.github/workflows/visual-baselines.yml` を dispatch）。デモページ自体は e2e/visual の撮影対象外 |
| `@banto/image-assets`（Issue #438、[ADR-0020](adr/0020-image-assets-package.md)） | 独立パッケージ（DB/バックエンド依存なし、依存は空）。**テンプレートのアプリには配線しない**（デモを同梱しない拡張、§3.1）ので、アプリ側に外す配線は無い。要らなければ `packages/image-assets` を消し、docs の `@banto/image-assets` 参照も外す（[recipes/remove-optional-assets.md](recipes/remove-optional-assets.md) に手順）。scaffold はどのプリセットでも触れない | ブラウザ側の画像の原本・取込検査・object URL の寿命。4 条件の 1（横断性）・3（代替不能性）は「2 つ目の consumer（案件用の特化 SCADA）がある」ことで補う（shared-primitives-upstream-plan §3.7・D6）。consumer が 1 つのままならオプションから外すことを再検討する（ADR-0020 帰結） |
| システムメトリクス（`sysinfo`、ADR-0013・Issue #185） | `banto-admin-services` の opt-in feature `system-metrics`（`sysinfo` 依存の実体）。テンプレート側 `admin-template-core`/`src-tauri` の `Cargo.toml` は `default` でこれを有効化しており、`default` から外すだけで削除できる（[recipes/remove-optional-assets.md](recipes/remove-optional-assets.md) に手順） | System Info カードの CPU/メモリ行のみが対象。`SystemMetrics` 型自体は feature 無しでも常時コンパイルされるため、`banto_server::routes::SystemInfo.metrics` は削除後も `null` を返す形でワイヤ互換を保つ |

### 3.1 今後の機能拡張の提供形態（2026-07-15 決定）

M19〜M21 以降の機能拡張は、テンプレート本体へ焼き込まず
**「パッケージ + 削除可能デモ + レシピ」方式**で提供する
（詳細と個別判断は [roadmap.md](roadmap.md)「M19〜M21 の提供形態」）。

- 拡張の実装単位は `packages/@banto/*`（必要なら `crates/banto-*` との
  ペア）。runtime プラグイン機構は作らない — パッケージに切ること自体が
  配布手段であり、`initBanto({ resources })` が拡張ポイントである
- テンプレートアプリへの同梱はデモ配線としてのみ行い、同梱する場合は
  本節の表へ行を追加して「消せる」義務（削除しても他が壊れない構造 +
  削除手順の明文化）を負う
- デモを同梱しない拡張（例: M21 wedge 入力 `@banto/scan-wedge`）は
  README のレシピで組み込み方法を示す（本体アプリへ配線しない = 本表の
  「削除可能デモ」義務も負わない）。ナビ/デモページを足すとサイドバー変化で
  全ビジュアル回帰ベースラインが drift するため、汎用 UI パッケージは
  recipe-only を既定とする。ただしショーケース価値が高いものは、ベースライン
  再生成（`.github/workflows/visual-baselines.yml` の dispatch）を受け入れて
  デモ配線してよい — ツリービュー `@banto/tree-svelte` は `/tree` デモとして
  配線した（上表に行あり。2026-08 決定）
- 別リポジトリへの分離はドメイン特化（banto-industrial）に限る。
  汎用拡張は本体モノレポに置き、拡張増加で本体 CI が圧迫され始めた
  時点で banto-extensions への分離を再検討する

## 4. 除外 — テンプレートに入れない物

### 4.1 既決（roadmap §4 を再確認、変更なし）

MQTTブローカー / MQTTクライアント / 汎用KVサーバ / リアルタイムタグストア /
cron的定時実行基盤 / アラーム管理 — いずれも SCADA 等の**個別アプリ
（または将来の拡張リポジトリ）**で開発する。設計指針は roadmap §5 に記録済み。

### 4.2 実装過程で非スコープと判断した物（今回明文化して確定）

| 機能 | 理由 | 初出 |
|---|---|---|
| 外部IdP連携（OIDC/SAML） | 認証方式はアプリ依存。AuthProvider 差し替えで対応する設計を維持 | M10 |
| リソース/行単位の細粒度ACL | 3ロール固定で大半の用途が足りる。複雑さが全利用者の荷物になる | M10 |
| ネイティブ .xlsx 生成 | 依存追加が必要。BOM付きCSVで Excel は開ける | M15 |
| チャートの PNG エクスポート | ブラウザAPI依存。SVGで足りる | M13 |
| スケジュールバックアップ | cron相当を持たない方針（§4.1）と同根。手動+外部スケジューラで賄う | M17 |
| リストアのホットスワップ | 稼働中プール差し替えはリスクに見合わない。起動時適用で十分 | M17 |
| 改ざん防止監査ログ（署名チェーン）/ SIEM連携 | 要求される業種が限定的。必要なら個別アプリで | M14 |
| リッチテキスト / 3D・地図 / フォームビルダーGUI | 仕様 §2.2 のまま | v1 |
| ネイティブプラグイン機構（DLL動的ロード） | Rust に安定ABIがなく境界コストが過大。全権限で動きRBAC/監査の関所を迂回する。代替: サイドカープロセス（既存REST/SSE/MQTT境界）→ WASM | 2026-07-11 議論 |
| フロントエンドWASM（チャート計算等の WASM 化） | チャートの実コストはDOMでありWASMは効かない。代替: サーバ側集約/間引き（Rustバックエンド活用）→ Canvas レンダラ | 2026-07-11 議論 |
| クロスレンダラ共通ウィジェット DSL（レンダラ非依存の中間 UI 記述層） | 宣言層は既存スキーマ駆動定義（resources/forms/columns、M23 導出）の漸進拡張で賄う。第2言語は全コピー利用者の学習・保守負荷になり、最小公倍数ウィジェットと複数実装の意味論同期は破綻しやすい。代替: スキーマ宣言の拡張（シリアライズ可能な中核 + レンダラ非可搬の関数スロット、ADR-0009）→ レンダラ固有コードは各アプリ側 | 2026-08-25 / ADR-0009 |
| 画面エディタ / コードレスビルダー（GUI デザイナ全般） | 対象ユーザー（非開発者）がテンプレート利用者（コピーして書き換える開発者）と異なり、§1 4条件の横断性・削除容易性・代替不能性を満たさない（Retool 等実績多数）。既存「フォームビルダーGUI」（spec §2.2）の一般化。代替: recipes/*.md の AI 向けチェックリスト拡充 → 実需が出たら別プロダクトとして検討 | 2026-08-25 / ADR-0009 |

### 4.3 見送り（バックログからも外す提案）

- **汎用 i18n 辞書層**: テンプレート本体は日本語UIで完結しており、
  多言語要件は利用側アプリの都合。入れると全文言がキー化され
  可読性を落とす割に、必要な利用者は自前の仕組みを選びたがる領域。
  → **2026-07-12 バックログから削除確定**（必要になった実例が出たら再考）。
  → **2026-07-22 反転**: 段階導入へ方針転換（レイヤ① #81、レイヤ②/③は V2
  テーマBで実装済み。経緯は roadmap §3、規約は conventions §13、採用判断は
  ADR-0005）。本節の当初判断は歴史的記録として残す。

## 5. バックログの取捨（残す物の優先順位付け）

| 項目 | 判定 | 理由 |
|---|---|---|
| Playwright スモークE2E + lint/format 基盤 | **M18 に昇格済み**（+ パッケージ配布整備） | 機能ではなく品質基盤。M10〜M17 で機能が積み上がった今、回帰防止の効果が最大 |
| 帳票/印刷 `@banto/report` | **M19 に昇格済み** | 過去アプリ棚卸し（2026-07-11）で出現頻度最多（4〜5本）。MDテンプレート方式で日報・写真帳・時系列帳票を統一 |
| 添付ファイル/画像管理 | **M20 に昇格済み** | 写真帳・現品写真・検査記録・ドキュメント管理に横断 |
| バーコード/QR wedge 入力 | **M21 に昇格済み** | 倉庫・生産系で必須。小粒 |
| Tauri updater | 残す | デスクトップ「配布形態」の完成度。テンプレートの二形態の一方を担う |
| PWA 対応 | 残す | LAN「配信形態」の完成度。manifest + アイコン程度で軽い |
| PostgreSQL / TimescaleDB リポジトリ | 残す（条件付き） | 仕様 §12.1 が業務データの標準に位置づけるが、現状 SQLite で完結。**Timescale が要る用途は SCADA 寄り**のため、昇格は実需が出た時点。テンプレート既定は SQLite のまま |
| i18n 辞書層 | ~~外す（確定）~~ → **2026-07-22 段階導入へ反転**（V2 テーマBで実装済み。conventions §13 / ADR-0005） | §4.3 の反転追記参照 |

ドメイン寄りの再利用資産（タグレジストリ・SLMP・MQTT・時系列収集/読み出し）
は本テンプレートではなく**拡張リポジトリ banto-industrial** に置く
（2026-07-12 決定、別リポジトリ）。banto-industrial は banto の `@banto/*` /
`banto-*` を git タグ参照で消費する側で（配布方針は [publishing.md](publishing.md)、
[ADR-0011](adr/0011-git-tag-distribution.md)）、banto 本体は public + MIT。
banto-industrial 側の現行の計画・実装状況は同リポジトリの `docs/plan.md`
（文書地図は `docs/README.md`）が正とし、本書では複製しない。2026-07 時点の
初期構想は経緯として [history/industrial-plan.md](history/industrial-plan.md)
に残す（新規の設計根拠にしない）。

## 6. 今後の運用ルールと宿題

**機能追加時のチェックリスト**（roadmap のマイルストーン昇格時に確認）:

1. §1 の4条件を満たすか。満たさないなら個別アプリ/拡張リポジトリへ
2. オプション扱いなら「削除方法」をこのドキュメント §3 に追記できるか
3. コア→オプションの依存を作っていないか
4. REST / Tauri 両経路で同一の判定・記録を通しているか（M10/M14 の原則）
5. admin 専用機能は 403 + UI 非表示の両方をテストしているか

**宿題**（このドキュメントの結論から生じる作業）:

- [x] README / 導入ドキュメントに「デモコンテンツの差し替え手順」を書く
      （items リソース一式を自リソースに置換する手順。§3 の前提の明文化）
      → **M18 で実施済み**（README §2「デモコンテンツ（`items`）を自リソースに
      差し替える」に層別ファイル一覧と進め方を記載、2026-07-16 確認。
      2026-10-08 に層別ファイル一覧は [recipes/add-resource.md](recipes/add-resource.md) へ移動）
- [x] roadmap バックログから i18n を削除（2026-07-12 実施）
- [x] オプション資産の削除手順（dock / charts / glass / パレット）を
      それぞれ数行で README か本ドキュメントに追記 → **M18 で実施済み**
      （README §3「オプション資産の削除」（2026-10-08 以降は
      [recipes/remove-optional-assets.md](recipes/remove-optional-assets.md)）に dock-svelte・charts・
      Glassテーマ+vibrancy・コマンドパレットの4節が揃っており、
      添付機能（M20）・帳票デモ（M19）の削除手順も同節に追加済み。
      2026-07-16 に全節の存在を確認 — 追記不要だった）
- [x] コピー面積縮小（admin-template-core のロジックをクレート側へ寄せる）
      の方針文書化 → **M18 Phase C で §7 に記録**（実施は必要時）
- [x] リソース追加/差し替えの正式手順の一本化（spec §14「ルート導出方式」の
      決着）→ **2026-07-18 決定: 動的ルート `[resource]` は採用せず、
      「items のルート一式をコピーして書き換える」規約で確定。手順は
      [docs/recipes/add-resource.md](recipes/add-resource.md) に固定化し、
      README・AGENTS.md から参照**（improvement-plan-2026-07.md P1-3）

## 7. コピー面積縮小方針（M18 Phase C 記録 → V2 テーマC で ①〜④ 実施済み）

> **実施状況（2026-07-29 時点）**: 下記「移行順序」の ①〜④ は V2 テーマC
> （PR-C1 #114 = settings/audit、PR-C2 #115 = users、PR-C3 #116 = backup、
> PR-C4 = `rest/` の汎用ルーター）で完了。サービス層は
> `crates/banto-admin-services`、汎用 REST ルーター
> （`/api/auth/*` の extras・`/api/users/*`・`/api/audit-log/*`・
> `/api/backups/*`・`/api/ui-settings/*`）は
> `crates/banto-server/src/routes/` にある。`admin-template-core::rest` に
> 残るのは `/api/items/*`（アプリ固有）・`attachments`（M20）・Route table
> の doc・`api_router()` の `.merge()` 組み立てのみ。⑤（`db.rs` ランナー基盤の
> `banto-storage` 移設）は**「やらない」判断で確定**（2026-08-13 判定:
> 核心の `sqlx::migrate!` は呼び出し側クレートの manifest 相対で SQL を埋め込む
> マクロのため、移設は Migrator 受け渡し API の新設に対して割に合わない。
> maintenance-review-2026-08 §5.1）。⑥（Tauri コマンドの定型整理・優先度低）は
> 未実施のまま。
> 下表の行数は 2026-07-12 時点のスナップショットで、移設後の現況ではない。

**2026-08-26 現況**（`find apps/admin-template/core/src -name '*.rs' |
xargs wc -l` で再計測）: 合計 5,176 行（2026-07-12 の約8,600行から約40%減）。
内訳主成分: `rest/tests.rs` 2,428（47%）/ `items.rs` 1,173（23%。V2 テーマAの
Db/Dialect 対応で 925 から +27%）/ `db.rs` 398 / `rest/{mod,attachments,items}.rs`
計839 / `bin/banto-serve.rs` 207。次の縮小候補はテスト資産とデモリソース
（items）のジェネレータ化だが、着手トリガは本節の既存3条件のまま。

`admin-template-core`（`apps/admin-template/core/src/`）は現状
テンプレート利用者が**コピーしてそのまま書き換える**前提のアプリ固有
クレートだが、中身の大半はどの利用アプリでも同じ形になる汎用ロジック
（RBAC・監査・設定・バックアップ）で、`items`（デモリソース）固有なのは
一部だけ、というのが実装量の内訳から見えている
（2026-07-12 時点のファイル行数）:

| ファイル | 行数 | 性質 |
|---|---|---|
| `rest.rs` → `rest/`（P3-1 で分割済み） | 3304→4097 | ルーター構築・ミドルウェア配線（汎用）+ items ルート（固有）。**P3-1（2026-07-18）でリソース別モジュール（`rest/mod.rs` 汎用 + `rest/items.rs`・`rest/users.rs`… 固有）に分割済み**。下記「対象候補 2」の汎用/固有の分離はクレート内では実施済みで、残る作業はクレート移設のみ |
| `users.rs` | 1017 | ユーザー管理・RBAC（M10）— 完全に汎用 |
| `backup.rs` | 1018 | バックアップ/リストア（M17）— 完全に汎用 |
| `settings.rs` | 766 | 設定基盤・SettingsProvider（M12）— 完全に汎用 |
| `items.rs` | 925 | デモリソース — アプリ固有（利用者が書き換える対象そのもの） |
| `audit.rs` | 498 | 監査ログ（M14）— 完全に汎用 |
| `db.rs` | 275 | マイグレーション実行/シード基盤（汎用）+ items シード（固有）が混在 |

`items.rs` 以外はテンプレート利用者が「読んで理解はするが、実質書き換え
ない」コードであり、コピー面積（＝利用者が保守責任を負う行数）を
不必要に太らせている。**段階的にクレート側へ寄せる**方針とし、対象候補と
移行順序を以下に記録する（4条件判定は §1 のコア/オプション判定ではなく
「アプリ固有 vs 汎用実装の置き場」の話であり、§2.1 の
`admin-template-core`（コア）自体の判定は変えない — コアのままクレートを
1枚追加する、という整理）。

### 対象候補

1. **`banto-admin-services`（仮称）クレート**: `users.rs`/`audit.rs`/
   `settings.rs`/`backup.rs` のサービス層（`banto-core`/`banto-storage`
   に依存、`sqlx::SqlitePool` を受け取る形は現行のまま）をこのクレートへ
   移す。RBAC判定・監査記録・保持ポリシー・ステージング適用ロジックは
   すべてドメイン非依存（`items` はおろかどんなリソースを持つアプリでも
   同一実装で足りる）。`admin-template-core` はこのクレートに
   `banto-storage` 同様の `workspace.dependencies` として依存する形になる
2. **`rest.rs` のルーター構築の汎用部**: 認証ミドルウェア配線・CSRF
   ヘッダ検査・SSE配線・`/api/auth/*`・`/api/users/*`・`/api/audit-log/*`・
   `/api/backups/*`・`/api/ui-settings/*` のルート定義は
   `banto-admin-services` の各サービスと一緒に `banto-server` 側（または
   `banto-admin-services` 自身）へ移し、`Router` を返す関数として提供する。
   `admin-template-core::rest` に残るのは `/api/items/*`（アプリ固有）と、
   上記の汎用ルーターを `.merge()` する数行の組み立てコードのみになる
3. **`db.rs` のマイグレーション/シード実行基盤**: 「埋め込みマイグレーション
   を実行し、空なら seed 関数を呼ぶ」というランナー自体（`init_db`/
   `run_migrations_and_seed` の骨組み）は `banto-storage` 側へ、
   `items` 固有のシード生成（`SEED_ROW_COUNT`・行データ生成ロジック）は
   `admin-template-core` に残す
4. **Tauri コマンドの定型パターン（`src-tauri/src/lib.rs`）**: 「`require_role`
   → サービス呼び出し → 監査記録」の反復は上記3つより後回しでよい
   （優先度低）。Tauri コマンドはアプリごとの `#[tauri::command]` 境界を
   跨げず共有クレート化の効果が薄いため、マクロ化や薄いヘルパー関数化を
   検討する程度に留める

### 移行順序（実施時の目安、依存の少ない順）

1. **[実施済 PR-C1 #114]** `settings.rs` + `audit.rs`（他の3つより依存が
   少なく自己完結的。`backup.rs`/`users.rs` の監査記録がこの2つに依存する
   ため先に動かす）
2. **[実施済 PR-C2 #115]** `users.rs`（RBAC判定の中心。REST/Tauri 両経路の
   テストが多いため移行時の回帰確認コストが最大 — 2番目に置くことで
   テスト済みの監査基盤の上に乗せられる）
3. **[実施済 PR-C3 #116]** `backup.rs`（ファイルI/O・ステージング適用が
   あり db.rs のランナー整理と合わせて動かすのが自然）
4. **[実施済 PR-C4]** `rest.rs` の汎用ルーター部分（1〜3のサービスが
   クレート化された後、ルート定義も一緒に持っていく）→ 移設先は
   `banto-server`（既に axum ホスト基盤クレートで
   `AuthState`/`ServerEvent`/`ApiError` を持つため、ルーターの自然な置き場。
   `banto-server → banto-admin-services` の依存を新設。逆向きは無く循環しない）
5. `db.rs` のランナー基盤の `banto-storage` 移設
6. （優先度低・任意）Tauri コマンドの定型パターン整理

### 非スコープ（今回は記録のみ）

- 上記の実施そのもの（コード移動・新クレート作成）は M18 Phase C の
  スコープ外。**必要になった時点**で着手する。着手トリガは以下のいずれか:
  - banto-industrial 側が `banto-admin-services` 相当を必要とする
  - 2本目のテンプレート利用アプリが立ち上がり実際に重複コピーが発生する
  - **外部採用者から、コピー面積（重複コピーの保守負担）に関する
    フィードバックが出る**
- `items.rs`/`items` 関連のフロント資産は対象外（アプリ固有のデモの
  ままでよい、§3「デモコンテンツ」の扱いを維持）
