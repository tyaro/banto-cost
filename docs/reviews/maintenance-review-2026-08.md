# ドキュメント整理統合と保守性再点検（2026-08）

作成日: 2026-08-13
状態: **記録（2026-08 の整理は実施済み）。本書の整理統合プランは Phase 1〜4 として反映済みで、以降の文書整理は
[Issue #312](https://github.com/tyaro/banto/issues/312) で扱う。新規の設計根拠にしない（既存の経緯参照は可）**
位置づけ: 「ドキュメントが肥大化して人にも AI にも要点がぼやけていないか（整理統合すべきか）」
「機能がある程度固まった今、コードと構成はメンテナンスしやすい状態か」の2つの問いに答える
棚卸し。docs 全42ファイル（約9,200行）とコード全域を17班の並列監査で実測し
（**全ドキュメントの被参照数を rg で実測**した点が本書の土台）、批評担当が班間の矛盾裁定と
主張の抜き取り再検証（14件、confirmed 11 / refuted 4 相当）を行った上で統合した。
所見はすべて `file:line` または計測コマンドの根拠付き。

トラック: 本書は**保守者向け（トラックA）**。
関連: [maintainability-review-2026-07.md](maintainability-review-2026-07.md)（前回・Rust中心。
本書 §1 の AI 保守性の前提はそちら §1 を引き継ぐ）、
[feature-review-2026-08.md](feature-review-2026-08.md)（機能スコープの直近棚卸し）、
[ADR-0006](../adr/0006-docs-in-repo-projects-status-only.md)（知識の in-repo 一本化）。

---

## 1. 総評

**「肥大化して要点がぼやけている」という診断は半分だけ正しい。** docs 約9,200行の大部分は
死蔵ではなく、コードが `spec §N` / `docs/*-plan.md §N` 形式で引く**現役の仕様アンカー**である
（ui-framework-spec + roadmap だけで 799 箇所の被参照。§2.2 の実測マップ参照）。したがって
「実装済み plan をまとめてアーカイブ」という素朴な統合はリンク切れを大量生産するだけで
**不可かつ不要**。本当の問題は量ではなく次の4点に集約される:

1. **存在しない文書への参照が46箇所ある**（`docs/i18n-plan.md` 43箇所 +
   `docs/plan-review-integration-2026-07.md` 3箇所。ADR-0006 が守ると宣言した参照文化の破れ）。
2. **索引（AGENTS.md）が 2026-08 の変化に未追随**で、レビュー系文書6本が索引から辿れない。
3. **完了した plan の状態ヘッダ更新漏れ**（3件）と、それに类する追随漏れの散在。
4. **改善トラッキングの3層構造（improvements / improvement-plan / archive）が破綻**
   （2026-07-27 以降更新停止。リポジトリは既に「日付付き凍結レビュー → roadmap §3 → CHANGELOG」
   のより単純な様式へ有機的に移行済み）。

**コードと構成は高水準。** 6不変条件すべてが「実装 + 機械検査 + テスト」の三点で確認でき、
サービス層純度・両経路対称（rule 8）・attachments の多層防御・認証系の敵対的テストは模範的。
直すべきは少数の具体点（§3.2, §5）で、最重要は **scaffold の tree-svelte 欠落**
（minimal プリセットでもツリーデモが残る）、**Tauri 側監査記録の31箇所手書き反復**、そして
補完監査で見つかった本監査唯一の不変条件の実違反 **audit_config 系 denied 監査の
resource 非対称**（§5.3 H-4）。

## 2. ドキュメント監査

### 2.1 被参照マップ（統合・移動の危険度、rg 実測）

移動・改名・節番号変更の可否は被参照数で決まる。計測は**パス形式**
（`docs/xxx.md`）と**ラベル/節番号形式**（`spec §N` / `M-review 2026-08 §N`）の
**両方**で行うこと（片方だけの計測が本監査でも2件の誤判定を生み、批評班が裁定した）。

| 文書 | コード被参照 | md 被参照 | 移動可否 |
| --- | --- | --- | --- |
| ui-framework-spec.md | `spec §` 511 + `spec M` 288 = **799**（M の実体は roadmap） | 3 + AGENTS | **不可** |
| roadmap.md | 「spec M*」288 + 明示 85 ≒ **373** | 65 | **不可**（§2 含め動かさない） |
| template-scope.md | 24 | 61 | **不可** |
| conventions.md | **78**（`conventions §N` 形式、+ verify-architecture の根拠） | 126行 | **不可**（節番号も不変） |
| visual-refresh-design.md | 37 | 4 | **不可** |
| attachments-plan.md | 30（+ 誤形式 `spec §3.7/3.8` 12 を含む） | 5 | **不可** |
| feature-review-2026-08.md | パス形式 0、**ラベル `M-review` 18**（14ファイル） | 7 | 不可（当面） |
| visual-refresh-plan.md | 17 | 3 | 不可 |
| report-plan.md | 16 | 2 | 不可 |
| improvement-plan-2026-07.md | 13（コメント文字列） | 46 | 条件付き可 |
| improvements.md | 4 | 13 | 条件付き可 |
| maintainability-review-2026-07.md | 5（verify-architecture / check-versions 含む） | 5 | 不可 |
| publishing.md | — | 23ファイル | 不可（文書内圧縮のみ） |
| scaffold-presets-plan.md | 3 | 5 | 不可 |
| review-2026-07-29.md | **0** | 2 | **可（アーカイブ第一候補）** |
| industrial-plan.md | **0** | 10 | 段階縮約のみ可 |
| （欠落）i18n-plan.md | **43箇所/39ファイル**が参照するが**実在しない** | ADR-0005 から5 | — |

ADR（0001〜0006）・recipes・AGENTS/CLAUDE/README は現位置固定（ADR は番号アンカー文化、
入口3点は機械検査対象）。ja/en 対訳は同一コミット同期の運用実績があり、実質ドリフトなし
（conventions.en の行数差は英文80桁折返しによるもの。段落数 60/60 一致を実測）。

### 2.2 発見された破れ（整理の前に直すもの）

1. **欠落文書2件**（git 履歴にも不在 = 一度もコミットされていない疑い）:
   - `docs/i18n-plan.md` — 43箇所/39ファイル（packages の messages.ts 群、ADR-0005 本文ほか）が
     §3.2 等を参照。内容の後継は conventions §13 と ADR-0005 に実在する。
   - `docs/plan-review-integration-2026-07.md` — CR-6/CR-7・AD-* 番号体系の定義元。
     template-acceptance.yml:1 / check-versions.mjs:3 / rename.test.mjs:2 が参照。
2. **宙に浮いた参照2系統**（参照先の節がどの文書にも無い）:
   - `spec §3.7/§3.8` 12箇所 — 実体は attachments-plan.md §3.7/§3.8（接頭辞の誤り）。
   - charts の `spec §6 design rule 1/3/5/6` 12箇所 — 番号付きデザインルール一覧が
     docs のどこにも存在しない（コードコメントから逆復元可能）。
   - ほか単発: backups.rs:5 が M17 から引く「サイズ上限 256MB」が roadmap M17 本文に無い。
3. **参照文法の分裂**: 接頭辞 `spec` が実際には4文書（ui-framework-spec / roadmap の M節 /
   attachments-plan / 消失した i18n-plan）に跨って使われ、AGENTS.md:18 の
   「spec § = ui-framework-spec」規定と乖離している。

この3点は「文書を消す/統合する際は被参照を数える」という規律が過去に破れた実例であり、
**整理統合を先に行うとこの欠落が「正常」として固定化される**。よって修復を Phase 1 に置く。

### 2.3 整理統合プラン

#### Phase 0 — 方針の裁定（着手前に決める。推奨案を太字で併記）

| # | 論点 | 推奨 |
| --- | --- | --- |
| 0-1 | アーカイブ適格の規約 | **2段階規約: コード被参照ゼロ = 無条件で docs/history/ へ移動可。非ゼロ = 参照書き換え計画を同一 PR に含める場合のみ可**（ファイル名は変えず grep 到達性を維持） |
| 0-2 | roadmap §2（M10〜M24 詳細 約490行）の扱い | **動かさない**。「spec M14」等 288 参照の実体が §2 本文。移動は死文引用を288件規模で作る（backups.rs:5 と同型） |
| 0-3 | i18n-plan 欠落の修復方式 | **コード側43箇所の参照書き換え**（§3.2 → conventions §13、§4.1/§6.1 → ADR-0005。コメントのみの機械的変更）。次点: docs/history/ にリダイレクトスタブ |
| 0-4 | publishing 経緯の切り出し先名 | **docs/history/publishing-github-packages-2026-07.md** に一本化（2案併存していた） |
| 0-5 | tree-svelte 文書の正位置 | **packages/tree-svelte/README.md 新設（grid-svelte 雛形・API/使用例）+ アプリへの配線レシピは docs/recipes/tree-svelte.md**。二重定義にしない |

**裁定（2026-08-13、保守者承認）: 0-1〜0-5 とも推奨案（太字）を採用。** 以降の
Phase 1〜4 と §4 の PR 分割はこの裁定を前提に実施する。

#### Phase 1 — 破れの修復（§2.2 の3点）

- i18n-plan 参照の書き換え（0-3 の裁定どおり、43箇所/39ファイル）。
- maintainability-review-2026-07.md 末尾に「CR-6 / CR-7（後日追補）」節を追加し、
  plan-review-integration への3参照をそこへ付け替え（宙に浮いた CR 番号体系が実在化する）。
- ui-framework-spec に **§6.4 チャートデザインルール**を新設（コードコメントから逆復元）し、
  charts の12参照を実在化。`spec §3.7/3.8` 12箇所は `attachments-plan §3.7/3.8` へ正規化。
  roadmap M17 に「アップロードサイズ上限（256MB、DefaultBodyLimit）」を1行追記。
- conventions §12 に**参照文法の対応表**を追記: `spec §N` = ui-framework-spec 限定 /
  `roadmap MN` / `<plan名> §N` / `M-review YYYY-MM §N`。あわせて「移動・改名時は
  パス形式とラベル形式の両方で rg する」を明文化。

#### Phase 2 — 追随更新とアーカイブ（機械的・低リスク）

- **状態ヘッダ3件**: visual-refresh-plan「状態: 計画」→ 実装済み（M22/PR #25）、
  visual-refresh-design「状態: 設計」→ 実装済み、scaffold-presets-plan「設計のみ」→
  実装済み + §7 未決事項に決定結果を追記（§7.1=full出荷・§7.2=scan-wedge 対象外・§7.3=--interactive 実装済み）。
- **AGENTS.md**（+ en 同一コミット）: CI 記述を実態化（7ジョブ列挙 or 網羅列挙をやめ
  「ci.yml 各ジョブ + 週次系 tauri-check / template-acceptance / visual-baselines / deploy-demo」
  粒度へ）、check:versions 挿入、オプション列挙に tree-svelte 追記、不変条件要約に
  §13（UI 文言キー経由）を1句追加。
- **conventions.md ピンポイント5点**（節番号不変・en 同一コミット追随）: §1 の rule 8 記述を
  CR-6 後の実態へ / §4 の列挙を template-scope §3 への参照に置換（列挙の二重管理が
  ドリフトの直接原因だった）/ §6「各サービスに column_map()」→「ListParams を受ける
  サービス（items / audit）に」/ §9 に適用範囲（機械検査は packages のみ、app 層は
  正当化コメント付き例外）/ §12 の「28/147」を概数か計測コマンド提示へ。
- **README**: 653-656行の箇条書き破損を修復（scan-wedge 節 540-541 と同型文へ）、
  v1.2.0 システム情報カードを「主な機能」に追記（en も）。README.en 冒頭に
  「abridged summary; Japanese is canonical」宣言 + **ライブデモ URL を追加**
  （現状 en に完全欠落 — 採用導線として最大の穴）+ Requirements 重複の一本化。
- **CHANGELOG**: 1.2.0 節の6エントリに PR #141〜#146 を追記（自己規約 9-10 行との矛盾解消）、
  末尾に版比較リンク集を追加。
- **feature-review-2026-08 §5**: 実施済み項目にチェック + 実施日を記入。冒頭に
  「通称: M-review 2026-08」の別名を明記（rg 到達性のため）。
- **publishing.md**: 決着済み経緯3節（約80行）を Phase 0-4 のファイルへ切り出し、
  「現状 v0.1.0」→ v1.2.0 系へ、タグ整合の機械検査（check:versions --tag、CR-7）に言及。
- **アーカイブ実行**: review-2026-07-29.md → docs/history/（全班一致・被参照はリンク1件更新のみ）。
  improvements.md / improvement-plan-2026-07.md は状態訂正（P4-5/P4-9 は完了済み）+
  「2026-07 サイクル完了・凍結」ヘッダ + 残課題2件（P4-8、P1-4残 = lanNote の warning 化）を
  roadmap §3 へ転記した上で docs/history/ へ移動（0-1 の規約に従い参照書き換えを同一 PR に含める）。
- 小物: adr/README.en:36 のリンクラベル、keyring_store.rs:35 の「キーリード」typo、
  スモーク/コマンド数のコメント数字3箇所を非数値表現へ、.cargo/audit.toml の rsa 再検討条件を
  現状（postgres 追加済みだが rsa は sqlx-mysql 専用で依然到達不能）に更新。

#### Phase 3 — 構造改善（判断を伴う）

- **AGENTS.md に「調査・レビュー記録」小節を新設**（約8行）: レビュー系文書と
  docs/history/ の規約を索引化（孤児6文書の解消）。docs/README.md の新設はしない
  （索引の二重化は ADR-0006 の一本化方針に反する）。
- **README のレシピ3節切り出し**（scan-wedge 78行 + 通知36行 + tree 130行 = 244行、全体の30%）
  → docs/recipes/ へ（add-resource.md の前例に倣う。節名被参照はほぼゼロを実測済み）。
  README は約590行になり「コピー → リネーム → 差し替え → 削除 → 配信」の背骨が残る。
  **「オプション資産の削除」（被参照14ファイル + scaffold 1対1アンカー）と「LANアクセス」は移動禁止。**
- **add-resource レシピ増補**（ja/en）: ① verify-architecture の DUAL_PATH / rest/mod.rs の
  Route table 更新ステップ（現状レシピ通りだと CI が落ちる）② messages/{ja,en}.json への
  キー追加 + NavLabelKey/NavIconKey union 拡張 ③「新 Tauri コマンドは _body 分割を既定とする」。
  feature-review §5 の宿題 **add-role.md 新設**も同時に。
- **ui-framework-spec の決着追記**: §14 の解決済み未決2件に決着先を記入、§15 を
  「M0〜M9 完了。M10 以降は roadmap」の完了印付き圧縮版に（§13〜§15 へのコード参照は0件で安全）。

#### Phase 4 — 機械検査の拡張（ゲート付き）

各班から新規検査7案が出た: ja/en 見出しパリティ / **コード → docs の `spec §N` 参照が
見出しに解決するか**（今回の宙に浮いた参照63件は全てこれで CI 捕捉できた）/ toComparable
鏡像一致 / migration ファイル名パリティ / §3 依存 denylist / raw-colors の app 層拡大 /
raw-jp の .ts 拡大。補完監査（§5）から **CSP 2定義のディレクティブ単位一致検査**と
**denied の resource タグ照合（rule 8 拡張）**の2案が加わり計9案。ただし maintainability-review-2026-07 §4.1 の「機械検査打ち止め3条件」
（CR-3〜5 を意図的に不採用とした判断）と正面衝突しうるため、**先に打ち止め条件を ADR 化し、
その基準で7案を選別してから実装する**（reviews 班提案の採用）。

### 2.4 恒久運用ルール（増殖パターンを止める）

1. **4層固定**: ① ui-framework-spec = アーキテクチャ基準線（追記は決着の反映のみ）
   ② roadmap = M 番号付き機能仕様の**追記型台帳**（完了後もアーカイブしない）
   ③ `*-plan.md` = 冒頭で「恒久参照される設計節」と「進行管理節（history 化候補）」を宣言分離
   ④ レビュー文書 = 判断記録。採択済み仕様の本文を roadmap へ昇格させた後に history 化
   （ファイル名不変）。これで「どこに書くか」が一意になり、レビュー文書が次々に
   仕様置き場化する現在の増殖が止まる。
2. **roadmap §7 の完了プロセスに「対応 plan の状態行更新」を1行追加**
   （M19/M20 では守られ M22/P4-9 で漏れた、という規律の穴が状態ヘッダ陳腐化の根本原因）。
3. **他文書の正準表を複製する列挙は参照に置き換える**（conventions §4 の列挙ドリフトの教訓。
   機械検査の許可リストと対になっている §7 のような記述はドリフトし得ないので残してよい）。
4. **コメントに件数を書かない**（「全シナリオ」等の非数値表現か、実行時に数える形へ）。
5. **『確定』と書いた判断を覆すときは、元の節に日付付きで反転を追記する**
   （反転の記録を別文書だけに置かない）。実例: i18n 辞書層 — template-scope
   §4.3/§5 に反転追記（2026-08-26）。
6. **定期レビューの定型節として『条件付き判断の棚卸し』を設ける**
   （次回レビューから）: ① ADR の再検討・撤退条件と見送り項目の復活条件
   （約20件）の成立/不成立を1行ずつ判定 ② 着手トリガを無視して実施した
   判断があれば逸脱理由を元の節へ追記 ③ ADR 化候補のうち前回以降に判断へ
   触れたものが無いか確認し、あれば次サイクルで1件起票。

## 3. コード・構成の保守性再点検

### 3.1 総評

前回（2026-07）レビューの方針「均一・明示・grep 可能 > 賢い抽象」「散文規約を失敗する検査に
変換する」は貫徹されており、**構造レベルで直すべきものは無い**。特筆すべき強み:

- **不変条件が三点担保**: サービス層純度は rule 1 が use 文レベルで CI 拒否（実測: 混入ゼロ）。
  両経路対称は rule 8 が DUAL_PATH 20対 + 完全性チェック + ロール床照合まで機械検査。
  attachments はマジックバイト判定 + サーバ採番パス + validate_file_name の二重防御 +
  解凍爆弾ガードまで実装済み。認証系は「ロック中は argon2 が呼ばれない」ことを
  呼び出しカウンタで証明する敵対的テストを持つ。
- **抽象の切り方が正しかった証拠**: banto-core / banto-storage は V2 の PostgreSQL 対応と
  v1.2.0 の機能ラッシュを通じて list_query.rs / db.rs ともコミット1回のまま無改修。
- **パッケージ間依存ゼロ**（不変条件4より強い状態）を rule 2/6 が動的走査で維持。
  package.json の流儀・headless core + 薄い UI の型・messages.ts 規約が10パッケージで同型。
- **「なぜ」の保存密度が高い**: 意図的例外は必ず「コード内正当化コメント + 許可リスト登録」の
  ペアで管理され、失敗から学んだ痕跡（KNOWN DRIFT + ピン留めテスト）もコードに残る。

### 3.2 指摘（重要度順）

#### high

| # | 指摘 | 根拠 | 対処 |
| --- | --- | --- | --- |
| H-1 | **scaffold に tree-svelte の remover が無い**。minimal でも /tree ルート・nav 項目・依存が残り、「コアのみ（全オプション削除）」の宣言が虚偽化。template-scope:79 と README の削除可能宣言とも矛盾（#122 と同型の再発） | scaffold.mjs:43-48,816 に tree なし（rg 0件） | README:357-369 の手動4ステップを removeTree() として1対1自動化し PRESETS へ。scaffold.test.mjs に「packages/ 一覧と REMOVERS + 除外注記の突合」を1本追加 |
| H-2 | **template-acceptance CI のトリガが scripts/ のみ**で、scaffold のアンカー対象（apps 側 markup）を編集する PR では破壊が検出されず週次まで潜伏（実害2回: 8730373, cb0f9a2）。さらに実バグ1件発見: scaffold.mjs:619-622 のパターンがカンマ欠落で verify-architecture.mjs:103 と不一致 → dropBlock が **silent no-op** | template-acceptance.yml:26-42 / 両ファイル実読で確認 | paths に remover の編集対象ファイル群を追加。カンマを修正。恒久策として pristine コピー上でのみ「見つからない=失敗」にする --strict モードを template-edit.mjs へ |
| H-3 | **list_query の PostgreSQL 実 DB テストがゼロ**（テストは cfg(sqlite) 限定、pg_smoke も ListParams::default() のみ）。LOWER(数値列) が Postgres で実行時エラーになる潜在 500 の疑い（未検証） | list_query.rs:331 / pg_smoke.rs:66-177 | SQLite テスト群をミラーした postgres モジュールを BANTO_TEST_PG_URL スキップ方式で追加し既存 storage-postgres ジョブに載せる。LIKE/LOWER・数値バインド・NULLS LAST を優先 |

#### medium

| # | 指摘 | 対処 |
| --- | --- | --- |
| M-1 | Tauri 側の監査記録が **AuditEntry 手書き31箇所**（約380行 ≒ lib.rs の14%）。REST 側 record_write 相当のヘルパー不在が両経路ドリフトの主リスク面（機械検査対象外の領域） | lib.rs 内に record_ok() ローカル関数を置き31箇所を圧縮。**着手前に両経路の detail ペイロード一致を実測確認**（本書 §5 の補完監査で実施） |
| M-2 | REST 側も record_write が entity_id: &str 固定のため4ハンドラが手書き（約60行） | Option<&str> 化（呼び出し11箇所の機械的 Some() 化）で集約完成 |
| M-3 | banto-server routes/ に in-crate テストゼロ（997行が下流 rest/tests.rs に全面依存。PR #117 の移設時にテストが移設元に残った形） | 最低限のガード検証スモーク（401/403/denied 監査）を crate 側に持たせるか、分担を conventions に明文化 |
| M-4 | クライアント起因の不正入力（未知フィルタ列等）が BantoError::Other → **500** で返る（doc は bad request と明記）。BadRequest variant が無い | variant 追加 + list_query 4箇所の移行 + ErrorBody 全 kind の形状テスト新設（現状ゼロ）。両経路のワイヤ形状確認とセット |
| M-5 | _body 分割（テスト可能化）が mutating 約26コマンド中5つのみ。残り21の認可+監査は静的解析と目視のみ | detail に判断が入るコマンド（attachments_upload/delete、items_delete、auth_config_apply、autologin_*）へ優先適用 |
| M-6 | i18n リーク2種が CI を素通り: 「Danger zone」見出しが英語直書き2箇所（ja UI に英語）、DEMO_MODE_MESSAGE 等の日本語が provider 層6ファイルに直書き（en UI に日本語エラー） | 見出しをキー化。*Admin.ts は m['error.demoMode']() の遅延解決へ（6ファイル横並びの機械的変更） |
| M-7 | settings/+page.svelte が1,595行（独立8セクション同居） | セクション単位の分割は settings 1本に限定して実施（他の肥大ページはデモ=削除対象なので現状維持） |
| M-8 | dock-svelte のインタラクション層（約46%）にテストゼロ | grid/tree で確立済みの component test パターンを流用し2シナリオ（ドラッグ移動・フロート化）を追加 |
| M-9 | admin-core ⇔ grid-svelte の toComparable 鏡像に機械検査なし（M5 で実ドリフト前歴あり） | Phase 4 の検査候補（関数本体テキスト一致の grep 検査）へ |
| M-10 | visual ベースライン更新が「dispatch → 目視 → 再 dispatch → 手動空コミット」の3〜4手（GITHUB_TOKEN push が CI を再トリガーしない仕様のため。空コミット実績2件） | ci.yml に workflow_dispatch を足して明示再トリガー、または App トークン化。最低限 e2e/visual/README.md に現手順を明文化 |
| M-11 | デモ差し替え手順（add-resource / README 表）に i18n ステップが無い。レシピ通りに items を削除すると i18n.ts:29 の items.list.empty 参照が壊れる | レシピ・表に messages 行を追記。items.list.empty は汎用値なので grid.empty へ改名しデモ依存を解消 |

#### low（要点のみ）

Pagination.limit のクランプ欠如（SQLite の負 LIMIT=無制限で全件ダンプ可能性）/
In フィルタのバインド数上限なし / banto-storage の未使用 thiserror 宣言 /
banto-core の Cargo.toml description 乖離 / SPA fallback が未知 /api/* に 200+HTML を返す
（コメントと実挙動の不一致）/ SSE の失効後継続（低機微につき判断の明文化のみ）/
logout 監査のパス文字列二重管理 / Tauri ログインにスロットルが無い**意図的**非対称の
明文化欠如 / --banto-scrim トークン欠落（生値2箇所） / SEQ_RAMP 固定 hex の例外宣言なし /
items ページの mode 変数名衝突 / fetch ラッパ名の4種分化（コピー方針の利点を fetch だけ喪失）/
eslint warn がノーゲート / Playwright ブラウザキャッシュなし / permissions.ts 等 app 層の
最小ユニットテスト or 「型 + e2e で足りる」判断の明文化。

### 3.3 やらないと決めること（明文化して判断を固定）

- ***Admin.ts 6ファイルの DRY 化はしない**（前回レビューの「均一な重複 > 賢い抽象」方針どおり。
  ただし fetch ラッパ名の再統一だけは行いコピー面を均一に戻す）。
- **BantoGrid.svelte（1,372行）/ auth.rs（1,439行）の分割は今はしない**（委譲構造・凝集性・
  テストが健全。次に大きな機能を足すときに併せて）。auth.rs は「これ以上足さない」ライン。
- **Db enum ディスパッチのマクロ化は Postgres 実配線まで見送り**（70腕超の重複は意図的
  トレードオフとして文書化済み。受け入れる判断を conventions に1行残す）。
- **visual-refresh plan/design の統合はしない**（実重複は1,137行中約100行のみ。統合は
  54箇所のコード参照書き換えに見合わない）。
- **CHANGELOG の過去節切り出しはしない**（全履歴同居が keepachangelog 慣例。1,000行超まで見送り）。
- **src-tauri lib.rs のファイル分割はしない**（rule 8/9 が単一ファイルをアンカーにしている。
  代わりに setup() 内の2関数抽出でネストのみ解消）。

## 4. 実施順序の提案

1. **PR-1（方針 + 破れの修復）**: Phase 0 裁定を本書に追記 → Phase 1 実施。
2. **PR-2（追随更新 + アーカイブ）**: Phase 2 一式（機械的変更のみ、ja/en 同一コミット）。
   §5 由来の文書分も含める: conventions §3 表の civil_from_days 3箇所化・CSP 項の追記、
   e2e/visual/README の空コミット手順、template-scope §7 ⑤ の恒久 deferral 注記、
   docs/assets スクリーンショット4枚の再撮。
3. **PR-3（scaffold / CI 健全化）**: H-1 + H-2（tree remover、paths 拡大、カンマ修正、--strict）。
4. **PR-4（監査対称 + Rust 保守性）**: **完了分** — H-4（audit config denied の
   resource 非対称是正。`audit_log_router` を2ガードに分割し両ガードをテストで固定）/
   M-15（backups entity_id を canonical 化）/ M-2（`record_write` を `Option<&str>` 化し
   entity_id 無しの4ハンドラを集約）/ M-4（`BadRequest` variant + list_query 5箇所移行 +
   `ErrorBody` ワイヤ形状テスト）。M-16（denied detail 非対称）と M-17（429 login 非記録）は
   「意図的な非対称」として conventions §1 に明文化する方針を採用（コード変更なし）。
   **繰り越し（PR-4b）** — M-1（Tauri 側 record_ok ヘルパーで31箇所の手書き `AuditEntry` を
   集約）は src-tauri がサンドボックスでコンパイル不可のため、tauri-check CI で担保する単独 PR
   に分離。両経路 detail の現状一致は §5.3 の実測（16/19 完全一致 + 食い違い3件は本 PR で是正）で
   確認済みなので、既存形状を安全に畳める状態にある。
5. **PR-5（テスト増強）**: H-3（Postgres list_query）+ M-5 + M-8 + M-12（PG import）+
   M-14（import body limit + 境界テスト）。
6. **PR-6（構造改善）**: Phase 3（README レシピ切り出し、レシピ増補、add-role、spec 決着追記）
   + M-13（api_router の Services 構造体化）。
7. **PR-7（機械検査拡張）**: 打ち止め条件の ADR 化 → Phase 4 の9案選別 → 採択分の実装。

各 PR は独立レビュー可能で、1〜2 は文書のみ、3〜5 はコード、6〜7 は判断を伴う。
検証はいずれも `pnpm check` / `pnpm verify:architecture` / `cargo test` / `pnpm e2e`
（+ 文書 PR は rule 7 の docs 参照検査が通ること）。

## 5. 補完監査（批評班が特定した空白の充足）

批評班が13班の担当割りの空白として特定した3領域を追加3班で監査した。結果、
**本監査全体で唯一の「不変条件の実違反」が両経路監査の実測比較から見つかった**（§5.3）。

### 5.1 apps/admin-template/core クレート（約5,000行 — 担当割りの谷間）

状態は良好（high なし）。`cargo test -p admin-template-core` 85 passed を実測。
監査前提の修正2点: CSV のテキスト処理は core に存在しない（解析/生成はフロント側で、
Rust 側は JSON 化済み行の一括適用のみ）。rest/attachments.rs は「自前 multipart」ではなく
**multipart 回避設計**（raw bytes + クエリメタデータ。境界パースという攻撃面が最初から無い —
欠陥ではなく強み）。items.rs（1,171行）は分割不要・現状維持が正しい（利用者が丸ごと
書き換える対象として1ファイル凝集は設計どおり）。

指摘（§3.2 の続番）:

| # | 指摘 | 対処 |
| --- | --- | --- |
| M-12 | import_apply_postgres（SQLite 版の手書き複製、items.rs:608-672）が**どのテスト・CI からも一度も実行されない** | pg_smoke.rs に import の round trip + ロールバック系を各1本（PG ジョブは既存） |
| M-13 | api_router の10位置引数が10箇所（テストヘルパー6本含む）に展開され、scaffold が字面位置依存のテキスト除去を行う。「single call site」コメントは実態と乖離 | Services 構造体に束ねて api_router(services, auth, events, allow_setup) へ。利用者のサービス追加コストと scaffold の頑健性が同時に改善 |
| M-14 | POST /api/items/import に明示 body limit がなく、仕様上有効な10,000行が axum 既定 2MB に先に当たり 422 でなく 413 で落ち得る（attachments は二段構えを明文化済みで import だけ欠落） | attachments と同型の明示 DefaultBodyLimit + 境界テスト1本 |
| low | RFC5987（非 ASCII ファイル名）の単体テスト空白 / attachments の resource/resourceId 無検証（脆弱性ではない・孤児行のみ）/ banto-serve が SIGTERM 非対応 + init_db 失敗が生 panic / **civil_from_days が3クレート目に複製されたが conventions §3 の表は2箇所のまま** | conventions §3 表の更新は PR-2 へ。「4箇所目が生えたら banto-core へ」の判断を脚注に残す |

template-scope §7 の宿題⑤（db.rs ランナー移設）は**「やらない」が正しい**と判定
（sqlx::migrate! はマクロ呼び出し側クレート相対で SQL を埋め込むため、移設は Migrator
受け渡し API 新設に対して割に合わない）。§7 の注記に恒久 deferral として1行残し閉じる。

### 5.2 Tauri CSP / deploy-demo.yml / docs/assets

- **CSP**: 実体は健全（unsafe-inline 以外は堅く絞られ、capabilities は core:default のみ・
  plugin ゼロ）。`script-src 'unsafe-inline'` の必要性は実在（app.html の first-paint テーマ
  スクリプト + adapter-static が生成するハイドレーション起動スクリプトの2系統。撤去には
  kit.csp hash mode + 両 CSP 定義へのビルド時 hash 注入が必要で「依存を足さない」制約下では
  コスト過大 → **現状維持 + 明文化が妥当**）。ただし **Tauri 側と LAN 側の2定義の
  「connect-src 以外一字一句一致」がコメントの手動運用のみ**（medium）— Phase 4 の検査候補に
  「CSP 2定義のディレクティブ単位一致検査」を追加する（8案目）。conventions のセキュリティ節に
  CSP の項が無い点も PR-2 で追記。
- **deploy-demo.yml**: 健全（SHA ピン・BASE_PATH 一点集中・デモ認証の本番隔離はサーバ側
  トークン検証が独立に効くため構造的に成立）。low のみ: visual-baselines の setup-node だけ
  古い SHA / permissions のジョブ降格と deploy の timeout / 環境判定プローブが base 非対応
  （`${location.origin}/api/auth/check` 固定 — Pages では 404 依存で偶然成立）。
- **docs/assets**: README 掲載のスクリーンショット4枚が **v1.2.0 UI と乖離ほぼ確定**（medium。
  assets 最終更新 2026-07-27 vs ツリービュー #144・積立棒グラフ #145 が 2026-08-12。ライブデモは
  最新 UI を配信中のため不一致が外部から見える）。再撮して差し替え。
  **e2e/visual/README.md に「空コミット儀式」が未文書化**（M-10 の文書側。直近1日で2回実施
  されたのに口伝のまま）— 手順1段落を追記。

### 5.3 両経路の監査記録の同一性（実測比較 — M-1 の前提確認）

verify-architecture の DUAL_PATH 全19対について AuditEntry 構築コードを対で読み比べた。
**16対は action / resource / entity_id / detail キー構成まで完全一致**（条件付き detail や
ok/failed 分岐のロジックレベルまで）。秘密の非記録・denied の「無セッションは記録しない」
ポリシー・Role 文字列表現も両経路で一貫。その上で食い違い3件 + 記録条件の差2件:

| # | 指摘 | 根拠 |
| --- | --- | --- |
| **H-4** | **audit_config_get/apply の denied 監査が Tauri=resource "settings" / REST=resource "audit_log" で非対称（不変条件1違反の実物）**。REST 内でも成功時は "settings" で denied と食い違う | lib.rs:1313,1328 vs routes/audit.rs:221-229（成功時 188-190） |
| M-15 | backups_stage_restore の entity_id が REST=Some(fileName) / Tauri=None。REST 内でも from-upload と from-existing で不揃い | backups.rs:115-124 vs lib.rs:1450-1462 |
| M-16 | denied の detail が REST={method,path} / Tauri=None で系統的に非対称（Tauri 側はどの操作の拒否か事後判別不能） | routes/mod.rs:167-182 vs lib.rs:197-211 |
| M-17 | REST のロックアウト中 login 試行（429）は login_failed が記録されず監査証跡から消える（Tauri は全失敗を記録。しかも verifier の doc は「every attempt を記録」と主張し実態と不一致） | auth.rs:432-438 / routes/audit.rs:5-7 |
| low | REST は token 無し logout でも actor NULL の ok 行を書く（Tauri は直前セッションがある時のみ） | auth.rs:835-840 / lib.rs:501-517 |

**帰結: M-1（監査ヘルパー導入）はこの3件（H-4 / M-15 / M-16）の canonical 形状を決めてから
着手する**。ヘルパーは現状の形状を規約として固定化するため、先にドリフトを決着させないと
非対称が恒久化する。M-17 は方針（記録しない=自己 DoS 防止 or "login_throttled" を1行記録）を
決めて doc と conventions §1 に明文化。denied の resource タグ照合は rule 8 への追加候補
（Phase 4 の9案目）。
