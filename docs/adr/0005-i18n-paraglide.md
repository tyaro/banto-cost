# ADR-0005: UI i18n ランタイムに Paraglide JS を採用する（ADR-0002 の意図的な例外）

> English: [0005-i18n-paraglide.en.md](0005-i18n-paraglide.en.md)

- 状態: Accepted
- 日付: 2026-07-29
- 関連: [conventions.md §3](../conventions.md)、[ADR-0002](0002-minimal-dependencies.md)、
  docs/i18n-plan.md（§3.5 / §5 / §6.1）、docs/conventions.md §5・§10、テーマB PR-B1

## コンテキスト

UI 多言語化（i18n）の②土台（`t()` 相当・ロケール解決・永続化・言語切替）を
実装するにあたり、i18n ランタイムを**自前実装するか外部ライブラリを引くか**を
決める必要があった（i18n-plan §3.5 / §6.1 の未決事項1）。

Banto は「コピーして使うテンプレート」であり、依存はすべて利用者が継承・監査・
更新する（[ADR-0002](0002-minimal-dependencies.md)）。したがって i18n ランタイムの
選定は、機能要件（型安全・SSG/クライアント解決・実行時コスト）と依存最小化の
トレードオフを伴う基盤判断になる。前提となる構成は Svelte 5 / SvelteKit 2 /
Vite 6 / `@sveltejs/adapter-static`（SSG・SPA フォールバック）で、サーバ
ランタイムを持たない（ロケール解決はクライアント側で完結させる、i18n-plan §3.3）。

ADR-0002 の判断基準（P1-5）は「依存ゼロが目的ではなく**総保守コストの最小化**」で
あり、①自前実装が肥大化する ②セキュリティ境界 ③Unicode・日時・複数形等の
エッジケースが多い領域 ④crate/パッケージが十分成熟 ⑤feature 限定で引ける
⑥バンドル増を測定済み、の複数該当なら依存採用を前向きに検討する、としている。
i18n は③（複数形・言語タグ・将来の ICU）に該当し始める領域である。

## 決定

**UI i18n ランタイムに [Paraglide JS (inlang)](https://paraglidejs.com/) を採用する**
（`@inlang/paraglide-js`、devDependency）。これは ADR-0002「依存を足さない」に対する
**意図的な例外**であり、本 ADR がその判断と代替案比較を記録する。

- **一次言語（base-locale）= 英語**、対象ロケール = en + ja（i18n-plan §6.1）。
- 依存は**コンパイル時のみ**。Paraglide はメッセージ JSON をツリーシェイク可能な
  メッセージ関数（`src/lib/paraglide/`）に**コンパイル**し、生成物は自己完結で
  `@inlang/paraglide-js` へのランタイム依存を持たない（＝利用者が継承する
  「実行時依存」は実質ゼロ、バイナリ/バンドルは使用メッセージ分のみ）。
- 生成物は**コミットせず gitignore**。CI/ローカルとも `paraglide:compile` が
  build/check の前段で生成する（Vite プラグイン + `pnpm check` 用の CLI 前段）。
- i18n は **app 層のみ**（conventions §5）。`@banto/*` は Paraglide を import せず、
  文言は既存の props 注入（i18n レイヤ①）経由で受け取る。ロケール解決・永続化は
  provider/設定層に閉じる（conventions §10）— 既定表示ロケールは日本語のまま
  （視覚回帰ゼロ）、base-locale が英語でも初期表示は ja（カスタム
  クライアントストラテジ `custom-banto` が localStorage 既定 ja で解決）。

## 検討した代替案

- **案A（採用）: Paraglide JS。** 利点: **コンパイル時 i18n で実行時依存が極小**
  （生成物は自己完結・ツリーシェイク可能、利用者が継承する依存ツリーが増えない
  ＝ADR-0002 の懸念点の大半を回避）、**完全な型安全**（メッセージ関数の引数・
  ロケールが型付き、`pnpm check` で検査）、SvelteKit 公式の i18n 統合で Vite
  プラグインが用意されている、カスタムストラテジで adapter-static のクライアント
  解決に素直に載る。将来の ICU MessageFormat（複数形・性）も同一ランタイムで
  拡張できる。欠点: 外部依存を1つ増やす（ADR-0002 の抑制対象）、コンパイル
  ステップをビルド/CI に配線する必要、生成物ディレクトリの管理（gitignore）。
- **案B（不採用）: 自前実装（フラット辞書 + `{name}` 補間）。** 利点: 依存ゼロで
  ADR-0002 と最も整合、小さく把握しやすい。欠点: **型安全を自前で用意する
  負担**が重く、キー欠落・ロケール網羅の検査を手作りすることになる。JA+EN の
  単純辞書のうちは妥当だが（i18n-plan §3.5 もそう評価していた）、②土台として
  provider 配線・言語タグ・将来の複数形/ICU まで見据えると、成熟した
  コンパイラ（案A）の方が**総保守コストが低い**（P1-5 の③④に該当）。①だけの
  レイヤ①（props 注入）は依存不要のまま維持できるため、自前 vs 依存の判断は
  ②土台に限定してよく、そこでは案A が優る。
- **案C（不採用）: `svelte-i18n`。** ランタイム辞書ロード方式で**型安全が弱く**
  （キーは文字列、コンパイル時検査なし）、実行時に辞書を持つためツリーシェイクが
  効かない。テンプレート利用者に実行時依存とバンドルを継承させる点で案A に劣る。
- **案D（不採用）: `typesafe-i18n`。** 型安全は得られるが、メンテナンスの停滞
  （エコシステムの活性が Paraglide/inlang に比べ低い）と、SvelteKit/Vite への
  一次サポートの薄さから、テンプレートが長期に継承する基盤としては案A を選ぶ。

## 帰結

- **ADR-0002 の表・原則は維持する**。本 ADR は「i18n ランタイムに限った例外」で
  あり、他領域（日付・MIME・markdown・ログ 等）の自前実装方針は変えない。
  conventions §3 に本 ADR への参照を1行足し、「i18n は Paraglide を引く意図的な
  例外」であることを辿れるようにする。
- **依存の性質を最小に保つ義務**: Paraglide は devDependency（コンパイル時のみ）に
  留め、生成物へのランタイム依存を増やす使い方（サーバミドルウェア・URL
  ストラテジ等 SSR 前提の機能）は adapter-static の制約もあり採らない。
  クライアント解決（localStorage/設定）に閉じる。
- **compile ステップの配線を保つ**: `src/lib/paraglide/` は gitignore。`pnpm build`
  は Vite プラグインが、`pnpm check` は `paraglide:compile` 前段が生成する。
  `strategy` は Vite プラグイン設定と CLI スクリプトで**二重管理**になるため、
  両者を同じ値（`custom-banto` + `baseLocale`）に保つ（vite.config.ts にコメントで
  明記）。
- **不変条件との整合を保つ義務**: i18n を `@banto/*` に持ち込まない（§5、
  `verify:architecture` の no-app-import が機械検査）。ロケール分岐は provider/
  設定層に閉じる（§10）。既定表示日本語で視覚回帰ゼロを維持する。
- **再評価条件**: Paraglide のメンテ停滞・破壊的変更でコンパイル配線の保守が
  重くなった場合、または要件が「実行時辞書ロード」等 Paraglide の設計と噛み合わ
  なくなった場合は、本 ADR を supersede して再判断する（ADR は書き換えない）。

---

追記（2026-08-13）: 本文・関連欄が参照する `docs/i18n-plan.md` はリポジトリに
存在しない（履歴切り詰め以前に消失。経緯は
[maintenance-review-2026-08.md §2.2](../reviews/maintenance-review-2026-08.md)）。
現行の一次情報は [conventions.md §13](../conventions.md#i18n-messages)
（レイヤ①注入・文言キー経由の規約）と本 ADR（層構成の決定）。コード内の旧参照は
同日に conventions §13 / ADR-0005 へ書き換え済み。本文は ADR の不変原則に従い
書き換えない。
