# ADR-0009: UI 宣言はスキーマ駆動の漸進拡張とし、追加レンダラは REST クライアントとして境界の外に置く

> English: [0009-schema-ui-rest-renderer-boundary.en.md](0009-schema-ui-rest-renderer-boundary.en.md)

- 状態: Accepted
- 日付: 2026-08-25
- 関連: Discussion #173、[conventions.md §1・§2・§5](../conventions.md)、
  [ADR-0001](0001-rest-tauri-two-path-symmetry.md)、
  [ADR-0002](0002-minimal-dependencies.md)、
  [template-scope.md §3.1・§4.2](../template-scope.md)、
  [roadmap.md §3](../roadmap.md)（チャート性能エスカレーション梯子）、
  spec §2.2・§3.1

## コンテキスト

GPUI など Rust ネイティブ UI の登場を受け、「Core → 共通 UI 定義 →
Web/ネイティブ両レンダラ」という構想を検討した。決めるべきは
(1) UI 宣言層をどこまで共通化するか、(2) 追加レンダラをどこに接続するか
の2点。前提として、LAN ブラウザ配信はテンプレートの中核形態
（[ADR-0001](0001-rest-tauri-two-path-symmetry.md)）であり Web レンダラは
削除できない — 追加レンダラは構造的に常に「+1」であり、「置き換え」という
選択肢は存在しない。

## 決定

1. **UI 宣言層の中核は引き続きシリアライズ可能なデータに保つ。**
   フィールド型・制約・列挙・`capabilities`・列導出（spec §3.1
   `columnsFromSchema`）はこの中核に含める。既存の関数値スロット
   （forms の `FieldDef.validate`、grid の accessor/format、i18n の
   label getter 等）は**レンダラ非可搬の拡張点**であり、レンダラ間で
   共有される前提を置かない。宣言的条件（例: `visibleWhen`）を将来足す
   場合も「単純比較のデータ表現」までに限る — 閉じた演算子集合
   （`eq`/`ne`/`gt`/`lt`/`in`/`empty` 程度）、AND/OR・ネスト無し、参照
   できるのは同一レコードのフィールドのみ、評価器はレンダラごとに
   二重実装せず1箇所の純関数に置く。文字列式言語や条件の合成を入れる
   判断は本 ADR の対象外とし、別の新しい ADR を要する。
2. **追加レンダラ（ネイティブ等）は REST + SSE クライアントとして
   `banto-server` の境界の外に接続する。** サービス層
   （`banto-admin-services` 等）への直リンクは禁止する — in-process の
   直結は認可・監査・レートリミットの関所を迂回できてしまうため。
   共有してよい Rust 型は `banto-core` の wire 型のみ。
3. **汎用 UI DSL（レンダラ非依存の中間 UI 記述層）・クロスレンダラ共通
   ウィジェット層は作らない。**

## 検討した代替案

- **案A（採用）: スキーマ漸進拡張 + REST クライアント境界。** 既存投資
  （spec §3.1 の `columnsFromSchema` 等、スキーマ→フォーム/一覧導出）と
  機械検査資産をそのまま生かせる。
- **案B（不採用）: 汎用 UI DSL + マルチレンダラ同梱。** Web UI パリティ面は
  実測 27,994 行 + テスト 9,737 行（全パリティを取る場合の天井値。価値ある
  部分集合＝監視ダッシュボードのみに絞っても約 13,000 行）の二重保守が
  確定し、第2言語の学習・保守負荷が全コピー利用者に及ぶ。最小公倍数
  ウィジェットと複数実装の意味論同期は先行事例（React Native の撤退例・
  .NET MAUI の停滞）でも破綻しやすい。
- **案C（不採用）: ネイティブレンダラがサービス層へ直アクセス。**
  in-process クライアントは認可・監査・スロットルを素通しでき、
  conventions §1 の denied ペアテスト義務・機械検査 rule 8（`DUAL_PATH`）の
  三つ組化・監査 origin（現状 `"rest"`/`"tauri"` の2値、サーバ側決定）の
  拡張が全 mutating 操作に波及する。
- **案D（不採用・今回初めて検討として記録）: デスクトップも REST に
  一本化して二経路自体を畳む。** 現行デスクトップは listening socket
  ゼロが既定という強いセキュリティ特性を持ち、ループバック常時 listen は
  ローカル他プロセスからのロックアウト DoS 等へ脅威モデルを変える。
  keyring 自動ログイン・vibrancy・フォルダオープン等の desktop-only
  コマンドも REST には乗らない。将来レンダラを追加する際の再訪候補として
  記録する（[ADR-0001](0001-rest-tauri-two-path-symmetry.md) の代替案には
  無かった案）。

## 帰結

- **実測値（2026-08-25、再計測コマンド込みで記録）**:
  UI 非依存 Rust 16,117 行 = crates 10,941（banto-core 357 /
  banto-storage 1,689 / banto-server 3,581 / banto-admin-services 4,199 /
  banto-attachments 1,115）+ admin-template-core 5,176。計測:
  `for c in banto-core banto-storage banto-server banto-admin-services banto-attachments; do find crates/$c/src -name '*.rs' | xargs wc -l | tail -1; done`
  / `find apps/admin-template/core/src -name '*.rs' | xargs wc -l | tail -1`
  Web UI パリティ面 27,994 行 = `packages/*/src` + `apps/admin-template/src`
  （paraglide 除く）の `.ts`/`.svelte` 30,470 行 − 非UI（admin-core 2,036 /
  theme 78 / scan-wedge 362）。別途 `*.test.ts` 9,737 行。計測:
  `find packages/*/src \( -name '*.ts' -o -name '*.svelte' \) | xargs wc -l | tail -1`
  / `find apps/admin-template/src \( -name '*.ts' -o -name '*.svelte' \) -not -path '*paraglide*' | xargs wc -l | tail -1`
  / `find packages apps/admin-template -name '*.test.ts' -not -path '*node_modules*' | xargs wc -l | tail -1`
- ネイティブ候補の観測と昇格・撤退条件は
  [roadmap.md §3](../roadmap.md)「チャート性能エスカレーション梯子」が
  正（生きた文書に置く）。本 ADR は「手前の段＝サーバ側集約・Canvas 2D で
  要件が満たされる限り着手しない」という原則のみを持つ。
- **2026-08-25 時点の候補状況の記録**: gpui は crates.io 0.2.2
  （2025-10-22）から10ヶ月リリース停止、Zed 社はコミュニティ向け GPUI
  開発の停止を表明、フォークは gpui-ce / open-gpui / Glass-HQ の3系統に
  分裂しいずれも臨界質量未達（stars 数個〜数百・個人保守含む）。再参入
  シグナルはフォーク非依存の収斂条件 — 組織バック体制（バス係数 >1）・
  6〜12ヶ月の定期リリース・コンポーネント資産の稼働・Windows で
  production 品質 — に加え、GPUI 系は Zed 本体の活動も見る。
- **PoC を実施する場合の前提**: REST/SSE クライアントとして実施する
  （サービス層直リンク禁止 — 直結で測ると本採用時の構成と性能が乖離し
  検証目的が壊れる）・リアルタイムトレンド1画面限定・同一ワークロードで
  SVG / 使い捨て Canvas / ネイティブの3点対照・数値目標を事前固定する。
- **未解決事項（採用判断時に設計が要る）**: 監査 origin の第3値
  （クライアント申告は偽装可能なので、トークン発行時にサーバ側で
  client 種別を束縛する等）/ bearer トークンのネイティブ側保存規約
  （OS キーチェーン等）/ ループバック常時 listen の脅威モデル評価。
- PoC コードをワークスペースに入れる場合は、先に「UI クライアント
  クレート→サービス層」依存禁止の機械検査（cargo metadata、rule 4 と
  同型）を敷く。追加可否は [ADR-0008](0008-machine-check-stop-gate.md)
  の3条件ゲートで判断する。
