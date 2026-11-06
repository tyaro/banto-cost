# ADR-0010: GitHub Discussions は決定前検討専用レイヤとする

> English: [0010-discussions-predecision-layer.en.md](0010-discussions-predecision-layer.en.md)

- 状態: Accepted
- 日付: 2026-08-25
- 関連: [ADR-0006](0006-docs-in-repo-projects-status-only.md)、
  Discussion #173、[conventions.md §12](../conventions.md)、
  [roadmap.md §3・§7](../roadmap.md)

## コンテキスト

設計検討の場として GitHub Discussions を導入する。
[ADR-0006](0006-docs-in-repo-projects-status-only.md) は「知識は
in-repo・Projects は揮発的ステータス専用」と決めており、「未決の検討」
という第3ジャンルの置き場が未定義だった。ADR-0006 が Wiki を退けた理由
（PR レビュー不通過・grep 不能・コミット非固定・AI 委譲セッションが
読めない）は Discussions にもほぼ当てはまるため、用途の限定と還流規律を
決めないと ADR-0006 と矛盾する。

## 決定

**Discussions は「実装確定前の生煮え検討・構想専用」とする。**

還流規律:

- (a) 決定・根拠・退けた代替案は必ず PR で ADR / roadmap §3 /
  template-scope へ還流する。
- (b) 決着した Discussion は冒頭に「→ 決着: ADR-NNNN / PR #N」を
  追記してクローズする。
- (c) コード・docs 本文の正規参照に Discussion URL を使わない
  （出典メモ限定 — conventions §12 の参照文法表に追記済み）。
- (d) ADR＝規範 / Discussion＝経緯ログという役割分離を保つ
  （ADR-0006 が Projects に適用した「役割分離ゆえドリフトが原理的に
  起きない」という整理と同じもの）。

カテゴリは Design（Open-ended）+ Q&A（Answerable）の2つから開始し、
分類はタイトル接頭辞ではなくリポジトリラベルで行う。カテゴリ増設は
外部参加者の投稿が発生してから起こす（ADR-0006 の Projects 導入
トリガと同じ規律）。フローの出口は ADR / roadmap §3 バックログ /
template-scope 非スコープの3つで、Issue は着手直前にのみ切る（open
issue/PR = 0 の非滞留文化）。

## 検討した代替案

- **案A（採用）**: 上記。
- **案B（不採用）**: 5カテゴリ（Architecture/Ideas/UI-UX/Development/
  Q&A）+ タイトル接頭辞 `[Architecture]` `[GPUI]` 等。参加者1人+AI では
  分類が誰のルーティングにもならず空カテゴリが並ぶ。最初の議題からして
  Architecture と UI/UX に跨り境界が破綻する。接頭辞はラベル
  機能と重複し、`label:` 検索が効かず、分類変更が全タイトル手編集になる。
- **案C（不採用）**: Discussions を使わず `docs/*-plan.md` とレビュー
  文書のみで検討する。生煮えの構想が docs に入るたび棚卸し負債になる
  （maintenance-review-2026-08 が宙参照46箇所を実測した実績）。外部
  参加の入口も無い。
- **案D（不採用）**: Discussions を知識の置き場にも使う。ADR-0006 が
  Wiki を退けた理由がそのまま当てはまる（非バージョン管理・grep
  不能・委譲 AI が読めない）。

## 帰結

- 決着済み議論の知識は常に in-repo に在る状態が保たれる（ADR-0006 の
  帰結を Discussions 時代にも維持する）。
- **運用自体の撤退条件**: 外部参加が12ヶ月ゼロなら Discussions を閉じ、
  従来の日付付きレビュー文書様式に戻す。
- 本 ADR の出自である Discussion（関連欄参照）自身が本規律の最初の
  適用例（本 ADR + ADR-0009 + roadmap/template-scope 追記へ還流し、
  決着リンクを残してクローズする）。
