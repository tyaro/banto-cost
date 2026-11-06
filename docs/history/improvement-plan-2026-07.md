# Banto 改善計画（2026-07 AIレビュー統合版）

作成日: 2026-07-18（同日改訂: ChatGPT レビュー本文を取込・統合済み）
位置づけ: 2026-07-18 に実施した外部AIレビュー2本（Claude によるフルレビュー +
ChatGPT によるレビュー）の所見を、[improvements.md](improvements.md)
（2026-07-08 調査・07-16 棚卸し）の残課題と統合し、**実施可能なアクション
プラン**として整理したもの。improvements.md が「調査記録と対応履歴」なのに
対し、本書は「これから何をどの順でやるか」の計画。各項目が完了したら
improvements.md 側にも対応履歴として反映し、本書の状態列を更新する。

トラック: 本書は**保守者向け（トラックA）**。

> **凍結（2026-08-13）**: 2026-07 改善サイクルは完了し、本書は凍結した
> （経緯は [maintenance-review-2026-08.md](../reviews/maintenance-review-2026-08.md) §2）。
> 現役のバックログは [roadmap.md §3](../roadmap.md#3-v2--将来構想バックログ) に
> 一本化する。未消化のまま引き継いだのは P4-8（実務サンプル、要スコープ判定）と
> P1-4残（設定画面 LAN 警告の warning 化。ブロッカーだったベースライン再生成環境は
> `visual-baselines.yml` で解消済み）の2点で、roadmap §3 へ転記済み。

---

## 1. レビュー総括

### 1.1 Claude レビュー（2026-07-18、ローカル全展開 + テスト実行込み）

実測に基づく評価。テストはレビューセッション内で実際に実行して確認した。

| 視点                 | 評価  | 根拠（実測）                                                                                                                                                                             |
| -------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| コード品質           | ★★★★★ | 全10 tsconfig で `strict: true`。`: any` は全リポジトリで2箇所、TODO/FIXME/HACK は1箇所。clippy `-D warnings` ゲート。ヘッドレス/UI分離（`grid-svelte/src/core/` は Svelte import ゼロ） |
| テスト・CI           | ★★★★★ | TS テストファイル57本 + Rust テスト関数247本、**全件パスを実行確認**。E2E スモーク12 + VR + axe 8スキャン（除外なし）。CI 4ジョブ（frontend / rust ubuntu+windows / e2e / audit）        |
| セキュリティ         | ★★★★☆ | conventions.md §6 の不変条件と実装の一致を確認。減点は TLS 未実装（既知の割り切り、§2.3 の構成例ドキュメントが未対応）                                                                   |
| ドキュメント         | ★★★★★ | 2トラック分離、`spec §` 参照168ファイル、improvements.md の自己監査サイクル。ただし日本語限定                                                                                            |
| AI協働性             | ★★★★★ | AGENTS.md の索引化、不変条件の圧縮列挙、検証コマンドとサンドボックス制約の明記、runes の罠の文書化                                                                                       |
| テンプレート利用体験 | ★★★☆☆ | リネーム8箇所+差し替え13ファイルが全手作業。スキーマ→列導出の達成状況未確認。PostgreSQL の期待値未明記。パッケージ別 README なし                                                         |
| コーディング指針     | ★★★★☆ | 両経路対称・サービス層非依存・逆依存禁止は実効的で実装と一致。「依存を足さない」文化は妥当だがセキュリティ絡みの自前実装は監査コスト増と表裏。`rest.rs` 4,069行の単調成長が構造的懸念    |

### 1.2 ChatGPT レビュー（2026-07-18、GitHub API 経由の設計・品質レビュー）

総合 **8.3 / 10**。全ソース展開・全テスト実行は行っていない旨の留保付き。

| 観点                 | 評価 | コメント（要旨）                                                                               |
| -------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| アーキテクチャ       | 9.0  | 境界と依存方向が明確。REST/Tauri 同格・transport 非依存サービス層・3環境 Provider 吸収を高評価 |
| コード品質           | 8.5  | 型・「なぜ」コメント・責務分離が良好。ただしコメント量の同期コストを懸念                       |
| テスト・CI           | 8.5  | 幅広いが **Tauri 本体のコンパイル検証に穴**                                                    |
| セキュリティ         | 8.5  | 意識が高い。LAN HTTP の警告強化を要望                                                          |
| 利用者の使いやすさ   | 7.0  | 高機能ゆえ導入時の情報量・選択負荷が大きい                                                     |
| 保守性               | 8.0  | 規約は強いが自前実装文化が将来負債になり得る                                                   |
| AI開発のしやすさ     | 9.2  | 「個人開発リポジトリの中でも上位」。AGENTS.md と設計文書の接続を高評価                         |
| OSS・配布品質        | 7.5  | 正式配布体験（スキャフォールド）に改善余地                                                     |
| 拡張性               | 8.5  | Provider・サービス層・オプション分離が良い                                                     |
| 初見での理解しやすさ | 7.0  | 全体像は明確だが規模が大きい                                                                   |

### 1.3 両レビューの合意点

両者が独立に同じ結論に達した項目は優先度判断の強い根拠とする:

- **強み**: REST/Tauri 対称性、transport 非依存サービス層、AGENTS.md による
  AI 道案内、セキュリティ不変条件、CI の充実。
- **弱点**: (a) テンプレート導入体験（手作業リネーム・情報過多・スキャ
  フォールド不在）、(b) **src-tauri が CI でコンパイルされない検証ギャップ**、
  (c) LAN HTTP の警告・TLS ガイド不足、(d) 自前実装文化の将来保守負担、
  (e) 英語ドキュメント不在。
- **総括の一致**: 「次の段階は新機能追加より、導入体験・検証ギャップ・
  不変条件の機械化・自前実装方針の再評価に投資すべき」。

## 2. 改善項目一覧

優先度: 高＝テンプレートの価値・信頼性に直結 / 中＝品質・保守性の向上 /
低＝余裕があれば。規模: S（〜半日）/ M（〜数日）/ L（それ以上）。
出典: C=Claude レビュー、G=ChatGPT レビュー、I=improvements.md 残課題
（§番号）。C と G が並ぶ項目は両レビュー一致（§1.3）。

| ID   | 項目                                                                                                                         | 優先度 | 規模    | 出典        | 状態                                                                                                                                                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------ | ------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 | README に「v1 は SQLite のみ、PostgreSQL は feature 定義のみ」を明記                                                         | 高     | S       | C, I§6.1    | **完了（2026-07-18）**                                                                                                                                                                                                                                                                   |
| P1-2 | スキーマ→列定義の自動導出の実装状況を確認し、未実装なら v1.1 筆頭候補として roadmap に登録                                   | 高     | S(調査) | C, I§6.3    | **完了（2026-07-18、未実装と確認・M23 候補登録）**                                                                                                                                                                                                                                       |
| P1-3 | リソース追加を正式手順化: ルート導出方式の決定 + `docs/recipes/add-resource.md`（チェックリスト形式のレシピ）新設            | 高     | S–M     | C, G, I§6.4 | **完了（2026-07-18、コピー規約で決着）**                                                                                                                                                                                                                                                 |
| P1-4 | LAN HTTP の警告強化（README 警告ボックス + 設定画面内警告）+ TLS 終端構成例（Caddy 等）                                      | 高     | S       | C, G, I§2.3 | **ドキュメント部分完了（2026-07-18）。設定画面内警告のみ未了**※2                                                                                                                                                                                                                         |
| P1-5 | 依存追加の判断基準を conventions.md §3 に明文化（「原則禁止」から「総保守コスト基準」へ）                                    | 中     | S       | C, G        | **完了（2026-07-18）**                                                                                                                                                                                                                                                                   |
| P1-6 | AGENTS.md に Definition of Done 節を追加（AI 委譲時の報告様式）                                                              | 中     | S       | G           | **完了（2026-07-18）**                                                                                                                                                                                                                                                                   |
| P1-7 | README 冒頭に「5分クイックスタート + 次に編集する3ファイル」を追加                                                           | 高     | S       | G           | **完了（2026-07-18）**                                                                                                                                                                                                                                                                   |
| P2-1 | リネーム/初期化の自動化（`scripts/` の Node 単体スクリプト。将来の対話式スキャフォールドの土台）                             | 高     | M       | C, G        | **v1 完了（2026-07-19、`scripts/rename.mjs`）。v2（対話式/プリセット）は P4-9 と合流**                                                                                                                                                                                                   |
| P2-2 | 英語版 README（要約1枚。全訳はしない）                                                                                       | 中     | S–M     | C, G        | **完了（2026-07-19、`README.en.md`）**                                                                                                                                                                                                                                                   |
| P2-3 | 各 `packages/@banto/*` に短い README（1パッケージ1枚、役割・入口・依存ゼロ方針）                                             | 中     | S–M     | C, I§7      | **完了（2026-07-19、9パッケージ）**                                                                                                                                                                                                                                                      |
| P3-1 | `rest.rs`（4,069行）のリソース別モジュール分割（`rest/items.rs`・`rest/users.rs`・… + ルート表 doc はモジュール doc に維持） | 中     | M       | C           | **完了（2026-07-18）**                                                                                                                                                                                                                                                                   |
| P3-2 | src-tauri の CI コンパイル検証（週次 or main push の `cargo check -p admin-template`、apt で webkit2gtk 導入）               | **高** | M       | C, G        | **完了（2026-07-18、`tauri-check.yml`）**                                                                                                                                                                                                                                                |
| P3-3 | Svelte コンポーネントテスト（`BantoGrid`/`BantoForm` のマウント+基本操作のみ）                                               | 中     | M       | I§4         | **完了（2026-07-19、各5件。ユーザー承認のうえ devDep 追加）**                                                                                                                                                                                                                            |
| P3-4 | `setup.ts`（258行）の分割: リソース定義・環境判定・Provider 構築を `resources/` / `environment.ts` / `providers/` へ         | 中     | M       | G           | **完了（2026-07-18）**                                                                                                                                                                                                                                                                   |
| P3-5 | アーキテクチャ規約の機械検査 `pnpm verify:architecture`（禁止 import・`{@html}`・生色値・unwrap 等）                         | 中     | M       | G           | **完了（2026-07-19、6ルール。unwrap 検査は見送り）**                                                                                                                                                                                                                                     |
| P3-6 | CI Action のコミット SHA 固定（サプライチェーン対策。テンプレート利用者へ配布される CI のため）                              | 低     | S       | G           | **完了（2026-07-19、7アクション固定・rust-toolchain は意図的例外）**                                                                                                                                                                                                                     |
| P4-1 | FilterPopover フォーカストラップの専用テスト                                                                                 | 低     | S       | I§8         | **完了（2026-07-19、9件。実挙動は dismiss 型と判明）**                                                                                                                                                                                                                                   |
| P4-2 | 仮想スクロールの計測ベンチ（10万行 fps/初期描画、items ページ + 行数パラメータ）                                             | 低     | S–M     | I§9         | **完了（2026-07-19、vitest bench でホットパス計測。`pnpm bench`）**                                                                                                                                                                                                                      |
| P4-3 | SQLite 同時書き込み(Tauri + LAN 併用時)の挙動と WAL の有無を README LAN 節に記載                                             | 低     | S       | I§9         | **完了（2026-07-19、同一プロセス単一プール + WAL と判明）**                                                                                                                                                                                                                              |
| P4-4 | Dependabot/Renovate の導入検討                                                                                               | 低     | S       | I§2.5       | **完了（2026-07-19、`dependabot.yml`。actions/npm/cargo をグループ化週次）**                                                                                                                                                                                                             |
| P4-5 | PostgreSQL リポジトリ実装（`sqlite.rs` を雛形に `postgres.rs`）                                                              | 低※    | L       | I§6.1       | **完了（v1.0.0 #93 で `postgres.rs`、V2 テーマA #106-109 でアプリ全体対応。CHANGELOG 参照）**                                                                                                                                                                                            |
| P4-6 | improvements.md の履歴分離（未解決課題のみ残し、対応済みは `docs/history/` へ）                                              | 低     | S       | G           | **完了（2026-07-27）**。残っていた解決済みインライン項目（P3-3/P4-1/P4-2/P4-3）を archive へ移設しスタブ化。全解決済み項目がスタブ様式に統一。※受け入れ条件「100行程度」は 2026-07-19 確定の「スタブは残す」設計（本文冒頭の3ファイル役割分担）が優先され、スタブ保持のまま 295 行で運用 |
| P4-7 | ADR（Architecture Decision Record）導入 + コメントの3分類整理（コード内/conventions/ADR）                                    | 低     | M       | G           | **完了（2026-07-19、`docs/adr/` + テンプレート + ADR 2件）**                                                                                                                                                                                                                             |
| P4-8 | 実務寄りサンプルアプリの追加（例: 設備保全管理）— **template-scope 4条件との整合判定が先**                                   | 低     | L       | G           | 要スコープ判定                                                                                                                                                                                                                                                                           |
| P4-9 | プリセット構成（minimal / standard / full）の生成 — P2-1 の発展形                                                            | 低     | L       | G           | **完了（`scripts/scaffold.mjs` + `--interactive`。CHANGELOG v1.0.0 feat(P4-9)。設計は [scaffold-presets-plan.md](../design/scaffold-presets-plan.md)）**                                                                                                                                 |

※ P4-5 は P1-1 で期待値を明記すれば緊急性が下がる、という関係。実需
（外部 PostgreSQL を使う個別アプリ）が出た時点で優先度を再評価する。

※2 P1-4 の残作業（設定画面の LAN 節の note を warning 化）: 設定ページは
visual regression の fullPage スナップショット対象のため、UI 変更には
ベースライン再生成（CI と同一の Playwright Chromium + フォント環境）が
必要。ベースラインを再生成できる環境での実施に持ち越し
（improvements.md §2.3 にも記録）。

補足（2026-07-19、「B. セキュリティ・運用の v2 検討事項」の決着）: 当初
v2 検討事項としていた TLS 本体と `tracing` 導入は、いずれも conventions §3 が
退けた依存を足す判断のため、実装ではなく **ADR で決定を記録**した —
TLS は [ADR-0003](../adr/0003-tls-via-reverse-proxy.md)（リバースプロキシ終端を
正式・組み込みは保留）、ログは [ADR-0004](../adr/0004-server-logging-eprintln.md)
（`eprintln!` 継続・`tracing` は保留）。改行コード一括正規化（improvements §5.2）は
CRLF 混入 0 件で実質完了と確認。

## 3. 各項目の詳細

### P1-1: PostgreSQL の期待値明記

README「構成」表の `banto-storage` 行には既に「PostgreSQL は feature 定義
のみで実装未着手」とあるが、仕様 §12.1 が「業務データは外部 PostgreSQL
（TimescaleDB）を標準」と述べたままで乖離が残る。仕様側にも「v1 は SQLite
のみ」の注記を入れ、README の主機能節にも1行明記する。
**受け入れ条件**: 仕様 §12.1 と README の記述が現状と一致する。

### P1-2: スキーマ→列導出の棚卸し

仕様 §3.1 の核心価値「スキーマを1つ書けば一覧と編集フォームが両方生える」
の達成状況が2度の棚卸し（improvements.md）でも未確認のまま。
`grid-svelte` の `columns` 省略時挙動と `forms` の `FormSchema` 共有度を
調査し、(a) 実装済みなら README で明示的に売りとして書く、(b) 未実装なら
roadmap に M23 候補として登録する。
**受け入れ条件**: improvements.md §6.3 が「対応済み」または「roadmap 登録
済み」に更新される。

### P1-3: リソース追加の正式手順化（レシピ新設）

テンプレート利用者が最初に迷う場所（improvements.md §6.4）。両レビューが
一致して指摘。決定肢は (a) 動的ルート `[resource]` 化、(b) 「items を
コピーする」を正式な規約として明文化。テンプレートの「すべては削除可能・
コピーして理解できる」方針とは (b) が整合的（動的ルート化は魔法を増やす）。
**推奨: (b) で決着させ、成果物として `docs/recipes/add-resource.md` を
新設する**。内容は ChatGPT レビュー提案のチェックリスト形式:

1. migration 追加
2. サービス層追加
3. REST route 追加
4. Tauri command 追加
5. REST/Tauri 認可対称テスト追加（denied 含む、conventions §1）
6. audit event 追加
7. ResourceDefinition 登録
8. ナビ/ページ追加
9. E2E 追加（必要なら）

README の既存13ファイル対応表はこのレシピへの参照に置き換え、AI への
委譲指示にもレシピをそのまま使えるようにする。
**受け入れ条件**: template-scope.md に決定を記録し、レシピが README と
AGENTS.md の両方から辿れる。

### P1-4: LAN HTTP の警告強化 + TLS 終端構成例

両レビュー一致。2つの成果物:

1. **警告の明示化**: README の LAN 節に警告ボックス（「標準では HTTP。
   信頼できないネットワークで使用しない。LAN 外・VPN 外は TLS 終端必須」）
   を置き、**設定画面の LAN 有効化トグル付近にも同旨の警告を表示**する
   （現状の README 内注記より視認性を上げる）。
2. **構成例**: Caddy（自動 HTTPS）を前段に置く10行程度の Caddyfile 例と
   注意点 — `X-Forwarded-For` とレート制限キーの関係（`auth.rs` の per-IP
   次元がプロキシ経由で単一 IP に縮退する点）を含める。

**受け入れ条件**: README と設定画面の両方に警告があり、構成例に per-IP
スロットルへの影響が明記される。

### P1-5: 依存追加の判断基準の明文化

conventions.md §3 は現状「引きたくなったら議論の対象」とだけ書いており、
判断基準がない。両レビューとも「自前の日付変換・Markdown パーサ・
セキュリティミドルウェアは将来の保守負債・監査コストと表裏」と指摘。
全面禁止の文化は維持しつつ、ChatGPT レビュー提案の採用基準を §3 に追記:

> 依存追加は原則抑制するが、以下を満たす場合は採用を検討する:
> 自前実装が肥大化する（目安100〜200行超）/ セキュリティ境界に関係する /
> Unicode・日時・暗号・パーサ等エッジケースが多い / crate が十分成熟 /
> feature を限定できる / バイナリ増加量を測定済み

つまり「依存ゼロ」を目的にせず**総保守コストの最小化**を目的として明文化
する。既存の自前実装を今すぐ置き換えるものではない（§5 参照）。
**受け入れ条件**: conventions.md §3 に基準が追記され、既存表と矛盾しない。

### P1-6: AGENTS.md に Definition of Done 節

AI へタスク委譲した際の成果物報告の様式を AGENTS.md に追加する
（ChatGPT レビュー提案）:

> 変更完了時、以下を報告する: 触れた不変条件 / REST・Tauri 双方への影響 /
> 追加・更新したテスト / 実行した検証コマンドと結果 / 実行できなかった
> 検証（src-tauri 等）/ ドキュメント更新の有無

roadmap §7 の実施プロセス（委譲→レビュー）の受け入れ側の規律を明文化する
もの。**受け入れ条件**: AGENTS.md に節が追加され、P1-3 のレシピと相互
参照される。

### P1-7: README 冒頭のクイックスタート

ChatGPT レビュー指摘: README は正確だが初見利用者には情報過多。冒頭に
「5分で動かす」（`git clone` → `pnpm install` → `pnpm dev`）と
「次に編集する場所」（リソース定義 / migration / サービス層の3ファイル →
P1-3 レシピへのリンク）を置き、既存の詳細節はその下に維持する。
**受け入れ条件**: 初見利用者が README の最初の1画面で起動と最初の変更
箇所に到達できる。

### P2-1: リネーム/初期化の自動化

両レビュー一致（Claude: リネームスクリプト、ChatGPT: `pnpm create
banto-app` 対話式スキャフォールド）。段階的に実施する:

- **v1（本項目のスコープ）**: `node scripts/rename.mjs --name my-app
--identifier com.example.myapp --title "My App"` で `package.json`×2・
  `tauri.conf.json`・`app.html`・表示文言・`Cargo.toml` repository・
  `packages/*/package.json` repository を一括書き換え（依存を足さない文化
  に従い Node 標準ライブラリのみ）。
- **v2（P4-9 と合流する将来形）**: 対話式でオプション資産（添付/帳票/
  チャート/ドック等）の採否を選び、README「オプション資産の削除」手順を
  自動実行するスキャフォールド。プリセット（minimal/standard/industrial）
  はこの発展形。

デモ差し替え（items）は自動化せず、P1-3 のレシピを正式手順とする。
**受け入れ条件**: クリーンなコピーに対しスクリプト実行 → `pnpm check` /
`cargo check` が通る。README の手動手順は「スクリプトが書き換える箇所の
一覧」として残す。

### P2-2: 英語版 README

両レビュー一致。コードコメント・識別子は既に英語で、日本語なのは
docs/README のみ。`README.en.md`（要約1枚: What it is / feature list /
quick start / 「詳細は日本語 README」）を追加し、README 冒頭から相互
リンクする。docs/ の全訳はしない（保守コストが利益を上回る。ハード
フォーク時に削除される層でもある）。OSS として利用者を広げる段階になったら
Architecture overview / Contributing / Security policy の英語版を追加検討
（ChatGPT レビュー優先度C）。
**受け入れ条件**: GitHub 上で英語話者が3分でプロジェクトの性質を判断できる。

### P2-3: パッケージ別 README

各 `packages/@banto/*` に 30〜50 行の README（役割1段落・最小コード例・
「依存ゼロ」の明示・本体リポジトリへのリンク）。npm 公開はしない方針
（publishing.md）だが、git 依存で単体消費する利用者と、パッケージ単位で
コードを読む人間/AI の入口になる。
**受け入れ条件**: 9パッケージ全てに README があり、内容が `index.ts` の
公開 API と一致する。

### P3-1: rest.rs の分割

`rest.rs` は4,069行で、リソース追加のたびに単調成長する。モジュール doc
のルート表・認可設計の解説は価値が高いので `rest/mod.rs` に残し、
`items` / `users` / `auth` / `audit` / `backups` / `attachments` /
`ui_settings` の各ルータ+テストをサブモジュールへ移す。**機械的な移動に
限定し、挙動変更を混ぜない**（両経路対称の不変条件に触れない）。
テンプレート利用者にとっても「自リソースのルータを足す場所」が
`rest/items.rs` のコピーとして明確になる利点がある（P1-3 レシピとも整合）。
**受け入れ条件**: `cargo test` 全通過・公開シンボルの後方互換維持・
モジュール doc のルート表が引き続き1箇所で読める。

### P3-2: src-tauri の CI コンパイル検証（優先度引き上げ: 中→高）

両レビュー一致で、ChatGPT レビューは「現在の最大の品質上の穴」と指摘。
現状 src-tauri は CI 対象外（コードレビューのみで担保、AGENTS.md 明記）
のため、Tauri command の引数変更・invoke 名の不一致・feature 設定・
Tauri API 更新・Windows 固有問題・capability 設定の破壊を検出できない。

実施形態（ChatGPT レビューの選択肢から）: **毎 PR では回さず、
`on: schedule`（週次）+ main push で ubuntu（apt で webkit2gtk 系導入）+
windows の `cargo check -p admin-template` を実行**する別ワークフローを
追加。壊れたら Issue を自動起票する。フルビルド（`tauri build`）は
リリース時のみで十分。
**受け入れ条件**: Tauri コマンド側のコンパイルエラーが1週間以内に CI で
検知される。

**実施済み（2026-07-18、`.github/workflows/tauri-check.yml`）**: 週次
スケジュール + main push + PR（いずれも Tauri 側/依存グラフのパスに触れた
場合のみ）+ 手動実行で `cargo check -p admin-template --all-targets` を
ubuntu/windows マトリクスで実行。パスフィルタにより Tauri 側を触る PR は
**マージ前に**検知される（計画の「週次で事後検知」より強い）。週次 run の
失敗時は `tauri-check-failure` ラベルの Issue を自動起票（既存の open
Issue があればコメントで再発を記録し重複起票しない）。

### P3-4: setup.ts の分割

ChatGPT レビュー指摘: `setup.ts`（258行）が環境判定・Provider 生成・
UI 設定・認証デモ・リソース定義・スキーマ・イベント接続を1ファイルに
持ち、アプリ作者が最初に触るファイルとして重い。Composition Root の
責務は維持しつつ分割する:

```
src/lib/banto/
├─ setup.ts        # bootstrap（従来の入口、re-export で後方互換）
├─ environment.ts  # isTauri / isEmbeddedServer / getBantoMode
├─ providers/      # tauri / server / demo の Provider 構築
└─ resources/
   ├─ index.ts     # initBanto への登録
   └─ items.ts     # itemsSchema / itemsResource（差し替え単位）
```

特に `resources/items.ts` の分離は「items を自リソースに置き換える」作業
（P1-3 レシピ）の対象ファイルを1つに絞る効果が大きい。conventions §10
（provider 分岐は provider 層に閉じる）は分割後も維持。
**受け入れ条件**: `pnpm check` / E2E 全通過。README・レシピの参照
ファイル名を追随更新。

### P3-5: アーキテクチャ規約の機械検査

ChatGPT レビュー指摘: conventions.md 自身が「機械では強制しきれず
レビューで守る」と述べている項目のうち、機械化可能なものを少しずつ
`pnpm verify:architecture`（Node 標準のみの自前スクリプト）に移す:

- サービス層（`core/src/*.rs`）に `tauri` / `axum` の use がない
- コアパッケージからオプションパッケージへの import がない（conventions §4）
- `packages/@banto/*` にアプリ固有 import がない（conventions §5）
- `{@html}` の使用箇所が許可リスト（conventions §7 の2箇所）に限られる
- コンポーネント CSS に生の色値がない（conventions §9）
- REST ルート表と Tauri コマンドの対応表の突き合わせ（conventions §1）

将来的には machine-readable な `architecture.yaml`（層と依存許可の宣言）
へ発展させる余地もある（ChatGPT レビュー提案）が、まずはスクリプト1本
から始める。CI の frontend ジョブに追加。
**受け入れ条件**: 上記のうち3項目以上が CI で検査され、conventions.md の
該当節に「機械検査済み」の注記が付く。

### P3-6: CI Action の SHA 固定

`actions/checkout@v4` 等のタグ参照をコミット SHA 固定に変更する
（ChatGPT レビュー指摘）。テンプレート利用者へそのまま配布される CI で
あるため、サプライチェーン対策としての価値が通常のリポジトリより高い。
Dependabot（P4-4）を入れる場合は SHA の追従更新も自動化できるため、
P4-4 と同時に実施するのが効率的。
**受け入れ条件**: 全ワークフローの `uses:` が SHA 固定 + バージョン
コメント付きになる。

**実施済み（2026-07-19、P4-4 と同時）**: サードパーティ 7 アクション
（checkout/pnpm-action-setup/setup-node/rust-cache/upload-artifact/
install-action/github-script）を、各メジャータグが現在解決するコミット
SHA に固定し `# vX.Y.Z` コメントを付与した（`git ls-remote` で解決し、
最新パッチと一致することを交差検証。挙動はアップグレードせず現行のまま
凍結）。**例外: `dtolnay/rust-toolchain@stable` は非固定** — この Action は
git ref がツールチェーンのチャンネル選択を兼ねる仕様（`@stable` = Rust
stable を追う）で、SHA 固定するとツールチェーンが凍結してしまうため、
意図的にタグ参照のまま残した（ci.yml 冒頭のポリシーコメントに明記）。
追従は Dependabot（P4-4、`github-actions` エコシステム）が担う。

### P4-6: improvements.md の履歴分離

ChatGPT レビュー指摘: improvements.md（現410行超）は対応済み項目の履歴が
成長し、「現在の未解決課題 / 過去の課題 / 実装記録」が混在し始めている。
未解決課題のみを improvements.md に残し、対応済みの詳細記録は
`docs/history/improvements-2026-07.md` へ移す（利用者影響の変更は既に
CHANGELOG.md が担う）。本書 §2 の状態列と重複しないよう、役割分担
（本書=計画、improvements.md=未解決課題の調査記録、history=完了記録）を
各ファイル冒頭に明記する。
**受け入れ条件**: improvements.md が未解決課題のみで100行程度になる。

### P4-7: ADR 導入 + コメント3分類

ChatGPT レビュー指摘: 詳細な設計判断が conventions.md と実装コメントの
両方にあり、変更時の同期コストが高い。判断の「代替案比較」を ADR
（`docs/adr/NNNN-*.md`）に移し、3分類を規約化する:

- コードコメント: その場でしか理解できない理由
- conventions.md: プロジェクト横断の不変条件（現行どおり）
- ADR: 代替案を比較した設計判断（なぜ二経路か / なぜ依存最小化か /
  なぜ SQLite か / なぜ Provider 方式か / なぜコピー型テンプレートか /
  なぜ git 依存配布か）

既存判断の ADR 化は一括では行わず、該当判断に次に触れるタイミングで
1件ずつ起こす（バックフィルの工数を避ける）。
**受け入れ条件**: ADR テンプレートと最初の1件が存在し、conventions.md
から参照される。

**実施済み（2026-07-19）**: `docs/adr/` を新設。`README.md`（3分類の
役割分担・運用・索引・バックフィル候補）+ `0000-template.md` + 最初の
ADR 2件（`0001` REST/Tauri 二経路対称、`0002` 依存最小化）。ADR は
conventions.md が持たない「**退けた代替案とその理由**」を残すことに絞り、
規約本文は複製しない。conventions.md 冒頭に3分類と ADR 参照を追記。
残りの候補（SQLite/Provider/コピー型/git 依存配布/ルート導出）は README の
「ADR 化候補」に列挙し、計画どおり次に触れる時に1件ずつ起こす。

### P4-8: 実務寄りサンプルアプリ（要スコープ判定）

ChatGPT レビュー提案: items デモに加え、設備保全管理（equipment /
inspections / attachments / reports / audit log）のような実務寄り小型
サンプル。Banto の強みが一通り見える題材ではあるが、**template-scope §1
の4条件（特に無ドメイン性）と「デモは差し替え前提」方針に緊張がある**ため、
着手前に template-scope の判定を通す。判定の結果、テンプレート本体では
なく banto-industrial（industrial-plan.md）側の題材とするのが自然な
可能性が高い。
**受け入れ条件**: template-scope.md に判定結果が記録される（採否どちらでも）。

### P3-3: Svelte コンポーネントテスト（実施済み 2026-07-19）

ヘッドレスロジックは既に手厚くテスト済みのため、コンポーネント側は
「マウント + 基本操作」に絞った（roadmap M2 の分離方針どおり）。

- **依存追加（ユーザー承認済み）**: `@testing-library/svelte` + `jsdom` を
  `packages/{forms,grid-svelte}` の **devDependencies** に追加。conventions
  §3（依存を足さない）の判断基準（P1-5）に照らし、UI コンポーネントの
  レンダリング検証を自前実装する総保守コストは外部ライブラリを大きく
  上回るため採用が妥当と判断。**dependencies/peerDependencies は空のまま**
  なので §4 の不変条件（verify:architecture の empty-deps）は保持。
- **構成**: 各パッケージの `vite.config.ts` に公式ヘルパー
  `@testing-library/svelte/vite` の `svelteTesting()` を追加（browser
  resolve 条件 + auto-cleanup）。デフォルト環境は `node` のままにし、
  コンポーネントテストのみ `// @vitest-environment jsdom` の docblock で
  opt-in するため、既存の純ロジックテストは環境も速度も不変。
- **BantoForm**（5件）: フィールド描画・入力の store 反映・valid 時 submit・
  required 空での submit ブロック + エラー表示 + `aria-invalid`・submitting
  時の disabled。
- **BantoGrid**（5件）: grid ロールと `aria-colcount`・列ヘッダ描画・
  `column.format`/`cell` を適用した本体セル描画・リンク列の `href`・空状態。
  jsdom に無い `ResizeObserver` と 0 になる要素寸法をスタブして仮想化
  ウィンドウに行を出す（レイアウトエンジンの代替ではなく描画に必要な最小限）。

### P4-1: FilterPopover の dismiss 挙動テスト（実施済み 2026-07-19）

improvements.md §8 は「フォーカストラップ」の未検証を課題にしていたが、
実装を精査すると FilterPopover は **Tab 巡回型のトラップを持たず**、
「Escape / 外側 pointerdown で閉じる」dismiss 型の境界制御だった。存在
しないトラップをテストするのではなく、**実際の契約を文書化 + 固定**する
方針で P4-1 を解決:

- `packages/grid-svelte/tests/FilterPopover.test.ts`（9件）: Escape で
  閉じる・他キーでは閉じない・外側 pointerdown で閉じる・内側 pointerdown
  では閉じない・unmount で window リスナ解除・dialog ロール + aria-label・
  適用ボタンでの apply・空値の適用は clear 扱い・Enter での apply。
- `pointerdown` は jsdom に `PointerEvent` コンストラクタが無いため、
  コンポーネントが読むのは `event.target`/`type` のみである点を踏まえ
  素の `Event('pointerdown')` をディスパッチして capture-phase リスナを
  検証している。
- improvements.md §8 の記述を「dismiss 型 + テスト済み」に訂正済み。

### P4-2: 仮想スクロールの計測ベンチ（実施済み 2026-07-19）

計画当初は「items ページ + 行数パラメータでブラウザ FPS を計測」する案
だったが、ブラウザ FPS は**非決定的・CI で回せない・手動**で、テンプレート
にベンチ用デモルートを焼き込む負債もある。代わりに**仮想化のホットパスを
vitest bench で計測**する方針にした（既存 vitest のみ・依存追加なし・
再現可能・回帰の目視が容易）。

- `packages/grid-svelte/tests/virtual.bench.ts`: (1) per-frame 処理
  （`computeWindow` + 可視ウィンドウ slice）が総行数に依存しないこと
  （仮想化の本質＝1フレームの処理量が O(visible) であること）を 10k/100k で
  実証、(2) sort/filter の総行数依存コスト（sort/filter 変更時に一度走る）を
  計測。`pnpm bench`（root）/ `pnpm --filter @banto/grid-svelte bench`。
- CI には**組み込まない**（timing ベンチは環境依存でマージをゲートすべき
  でない）。`vitest run`（test スクリプト）は `.bench.ts` を拾わないため
  既存テストにも影響なし。
- 代表結果（machine-dependent）と読み方はベンチ冒頭コメントに常設し、
  再実行で更新する運用。spec §4.2 の「1万行・20列 60fps」目標に対し、
  per-frame ≈0.0002ms/frame（16.7ms 予算の4〜5桁下）で余裕を確認。

### P4-3〜P4-5 / P4-9

- P4-3〜P4-5: improvements.md の該当節（§9, §2.5, §6.1）を
  そのまま実施内容とする。
- P4-9（プリセット構成）: **設計完了**（[docs/design/scaffold-presets-plan.md](../design/scaffold-presets-plan.md)）。
  プリセットは §3 オプション資産の削除手順の自動実行であり、コアや runtime
  機構には手を入れない。命名は当初案の "industrial"（別リポジトリ
  `banto-industrial` と混同）を避け `minimal`/`standard`/`full` に是正。
  実装は P2-1 v2（対話式スキャフォールドの CLI 土台）に乗せるのが自然で、
  その土台が未着手のため設計を先行確定。設計書 §7 の未決事項を実装着手時に
  決めてから進める。

## 4. 実施順序の推奨

1. **フェーズ1（ドキュメントのクイックウィン、合計2〜3日）**:
   P1-7 → P1-1 → P1-2 → P1-3 → P1-4 → P1-5 → P1-6。コードをほぼ触らず
   期待値と迷いを解消する。P1-2/P1-3 の結果次第で roadmap に新マイル
   ストーンが増える。P1-3（レシピ）と P1-6（DoD）は AI 委譲の品質に直結
   するため、以降のフェーズの効率にも効く。
2. **フェーズ2（検証ギャップと配布体験、1〜2週間目安）**: P3-2（Tauri CI、
   両レビュー一致の最重要ギャップ）→ P2-1 → P2-3 → P2-2。P2-1 は
   リネーム後ビルド検証まで含めて1 PR。
3. **フェーズ3（構造・機械化、必要になった時点で）**: P3-4（setup.ts
   分割は P1-3 レシピの対象ファイルを簡潔にするため早めが望ましい）→
   P3-5 → P3-1（rest.rs 分割はリソース追加の実需が出る直前が移動コスト
   最小）→ P3-6 → P3-3。
4. **フェーズ4（低優先バックログ）**: P4 群。P4-5（PostgreSQL）は実需
   ドリブン、P4-8 はスコープ判定が先、P4-9 は P2-1 v2 の後。

各 PR は roadmap §7 の実施プロセス（CI ゲート必須）と template-scope §6 の
チェックリストに従う。conventions.md の不変条件（特に「依存を足さない」
— P2-1/P3-5 のスクリプトも Node 標準のみ）を破らないこと。

## 5. レビューで確認した「変えない」こと

レビューの過程で妥当性を再確認し、**現状維持と判断**した設計判断。
改善項目に混ぜないための記録。

- **「依存を足さない」文化そのもの**: バイナリ肥大・監査面・コピー利用者の
  負荷の論拠は妥当（両レビューとも利点を認めている）。P1-5 は文化の廃止
  ではなく**判断基準の明文化**であり、既存の自前実装（日付変換・Markdown
  パーサ等）を予防的に置き換えることはしない。置き換えは各実装が P1-5 の
  基準に照らして実際に肥大化・複雑化した時点で個別に判断する。
- **e2e スモークの状態共有型シリアル実行**: smoke.spec.ts の doc に規律が
  明文化されており、スモークの目的（1画面1シナリオ）に対して合理的。
  独立テスト化はしない。
- **runtime プラグイン機構を作らない**（template-scope §3.1）: 「パッケージ
  - 削除可能デモ + レシピ」方式を維持。プリセット（P4-9）もこの枠内
    （スキャフォールドによる削除の自動化）で実現し、動的なプラグイン化は
    しない。
- **npm/crates.io へ公開しない**（publishing.md 2026-07-12 決定）: git tag
  参照配布を維持。P2-3 のパッケージ README はこの方針と矛盾しない。
- **アプリ内文言の日本語ハードコード**（テンプレートアプリ層のみ）:
  template-scope §4.3 の i18n 非導入決定を維持。
- **ディレクトリ単位の AGENTS.md**（ChatGPT レビュー提案）: 現時点では
  導入しない。CLAUDE.md→AGENTS.md 一本化（PR #35)で解消したばかりの
  ドリフト問題を再発させるリスクが、現リポジトリ規模での利益を上回る。
  リポジトリがさらに成長し「領域固有の情報だけを書く」規律を維持できる
  見通しが立った時点で再検討する。

## 6. ChatGPT レビューの統合結果（2026-07-18 実施）

レビュー本文を入手し、以下のとおり仕分け・統合した。

**両レビュー一致（§2 の出典に G を追記、うち P3-2 は優先度を中→高へ
引き上げ）**: スキャフォールド/リネーム自動化（P2-1）、src-tauri の CI
検証ギャップ（P3-2）、リソース追加手順の固定化（P1-3）、LAN HTTP 警告 +
TLS ガイド（P1-4）、英語ドキュメント（P2-2）、自前実装文化の保守負担
懸念（P1-5 として基準明文化に落とし込み）。

**ChatGPT 固有の新規項目**: P1-6（DoD 節）、P1-7（クイックスタート）、
P3-4（setup.ts 分割）、P3-5（規約の機械検査）、P3-6（Action SHA 固定）、
P4-6（improvements.md 履歴分離）、P4-7（ADR + コメント3分類）、
P4-8（実務サンプル、要スコープ判定）、P4-9（プリセット構成）。

**採用しなかった提案**: ディレクトリ単位 AGENTS.md（§5 に理由を記録）。

**評価の記録**: 総合 8.3/10 と観点別評価は §1.2 に転記。「AI にとっての
使いやすさは個人開発リポジトリの中でも上位」「次の段階は新機能より導入
体験・検証ギャップ・機械化・自前実装方針の再評価に投資すべき」との総括は
Claude レビューと一致し、本計画のフェーズ構成（§4）に反映した。

---

## 続き — 保守性コードレビュー（2026-07-21）

本計画（外部AIレビュー統合版）の項目が概ね完了した後、Rustサービス+サーバ層を
対象に**AI中心保守を前提とした保守性コードレビュー**を実施した。所見と、そこから
導いた不変条件の機械検査化ロードマップ（CR-1〜CR-5）は
[maintainability-review-2026-07.md](../reviews/maintainability-review-2026-07.md) に分離して
記録する。最優先は CR-1（REST/Tauri 両経路対称の機械検査）。
