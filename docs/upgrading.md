# 派生アプリの更新レシピ（Banto の新版を取り込む）

作成日: 2026-10-01（Issue #221）

Banto を使うアプリ（banto-industrial の banto-hub・chronogazer など）が、Banto の新しいリリースを取り込む
ための手順書。対象読者は**派生アプリの作者**。Banto 側のリリース手順ではない
（タグ運用は [publishing.md](publishing.md)「タグ運用規約」、配布方式の判断は
[ADR-0011](adr/0011-git-tag-distribution.md)）。

> 本書は日本語のみ。リリースごとの案内の雛形は [release-notes-template.md](release-notes-template.md)、
> 版ごとの実際の変更は [CHANGELOG.md](../CHANGELOG.md)。

## 1. 最初に知ること: 取り込み経路は 3 種類ある

Banto の成果物は更新の届き方が違う。リリースノートの項目も、この 3 つに分けて読む。

| 経路                      | 何が対象か                                                                                                                                                        | 更新の仕方                                                             | 派生側の独自変更との衝突                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| A. 依存（Git タグ）       | `@banto/*`（npm、`github:tyaro/banto#vX.Y.Z&path:packages/...`）と `banto-*` クレート（Cargo の `git` + `tag`）                                                   | タグを書き換えて install / build。API 追従があれば手で直す             | 起きない（実体は node_modules / cargo の checkout） |
| B. コピーしたテンプレート | `apps/admin-template` 配下（画面・ルート・`src/lib`・`core/`・`src-tauri/`・`messages/`・`e2e/`）と、付随する設定（`vite.config.ts`、コピーした `scripts/` など） | 派生側が**差分を読んで手で取り込む**。タグを上げても自動では変わらない | 起きる。派生側で変えた箇所は人が調整する            |
| C. DB・設定・配布資産     | DB マイグレーション（`apps/admin-template/core/migrations-{sqlite,postgres}/`。実体は B のファイルだが順序と戻し方が別）、設定キー、`tauri.conf.json`、配布物     | 変更がある版だけ。順序とバックアップは 4 節                            | -                                                   |

要点:

- **依存タグだけ上げても B は更新されない。** 例: v1.6.0 は設定画面の分割（B）だけの変更で、`@banto/*` と
  `banto-*` の実装は v1.5.0 と同一だった。タグ依存で v1.5.0 のまま留まっても差はない。
- 逆に、`@banto/*` の API が変わる版（例: v2.0.0）は、A の追従と、そのパッケージを使う B のコード
  （保護レイアウト・`session.svelte.ts` など）の書き換えが**セット**になる。A だけ上げると型エラーか実行時エラーになる。
- 自動マージや強制上書きの仕組みは**ない**。差分は人が読んで取り込む（取り込み漏れを防ぐ記録の取り方は 5 節）。
- ここで扱うのは**依存・コピー部分の更新**だけ。アプリ実行ファイルの自動更新（Tauri updater）は別の課題。

## 2. 標準の流れ

1. **リリースノートを読む。** [CHANGELOG.md](../CHANGELOG.md) の該当版の冒頭（「消費側への注意」・影響範囲）と、
   各項目の A / B / C の別を確認する。複数版を跨ぐなら、間の全版を読む（破壊的変更は 1 つの版にしか書かれない）。
2. **自分の基準版を確認する。** 派生リポジトリの同期記録（5 節）で、依存タグとテンプレートの同期元を別々に確認する。
3. **ブランチを切り、バックアップを取る**（4 節。DB・設定を触る版だけでなく、実機があるなら習慣にする）。
4. **A: 依存タグを更新する**（3.1）。まず**タグだけ**上げ、型検査・build が通る状態にする。
5. **B: テンプレートの変更を取り込む**（3.2）。該当しない版は飛ばす。
6. **C: 移行がある版は順序どおりに適用する**（4 節）。
7. **更新後の確認**（6 節）を、その版に関係する範囲で実施する。
8. **同期記録を更新する**（5 節）。一部だけ取り込んだなら、取り込んだ項目と見送った項目を残す。

**1 つの PR にまとめすぎない。** 依存タグの更新（A）とテンプレート取り込み（B）は、可能なら別コミット
（理想は別 PR）にする。壊れたときにどちらが原因か切り分けられる。

## 3. 経路別の手順

### 3.1 A: 共通パッケージ・クレートの更新

Banto の全 `@banto/*` と `banto-*` は**同じタグで揃える**（バージョンは統一されている。
[publishing.md](publishing.md)「バージョニング規約」）。npm と Rust のタグを別々の版にしない。

```sh
# 書き換え対象の洗い出し（派生リポジトリで。見つかった全部が対象）
grep -rn "tyaro/banto" --include=package.json --include=Cargo.toml . --exclude-dir=node_modules --exclude-dir=target

# npm: package.json の "@banto/admin-core": "github:tyaro/banto#v1.7.3&path:packages/admin-core" などを
# 新しいタグへ書き換えてから
pnpm install
pnpm check                  # 型検査（API 変更はここで落ちる）

# Rust: Cargo.toml の tag = "v1.7.3" を全て書き換えてから
cargo update -p banto-core  # 使っているクレート分。git 依存は tag の書き換えだけでは Cargo.lock が追従しない場合がある
cargo check --workspace
```

注意:

- 該当版の CHANGELOG に「削除した公開 API と移行先」のような表があれば、型エラーをその表で解消する。
- A の修正（不具合・セキュリティ）はタグを上げれば入る。B の修正は入らない（7 節）。
- Vite の `optimizeDeps.exclude` は、ソース配布の `.svelte.ts` を持つ `@banto/*`
  （admin-core・dock-svelte・forms・grid-svelte・tree-svelte・ui）を**新しく使い始めるとき**に増やす。更新だけなら
  据え置きでよいが、版の注意に書かれていれば従う（[ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.md)）。
  `pnpm check` と `pnpm build` はこの経路を通らないので、**`pnpm dev` で必ず画面を開く**（6 節）。
- `@banto/ui`（v6.1.0 で追加）は任意の追加依存。使い始めるなら `@banto/ui` を Git 依存（`#<tag>&path:packages/ui`）で足し、
  `@banto/theme/css` を読み込んでいること（トークンが解決される）を確かめる。**トースト（`createToastStore()`、#220 段階 2c）を
  含む版からは `.svelte.ts` を持つので、`optimizeDeps.exclude` に `'@banto/ui'` を必ず足す**（足さないと `pnpm dev` が 500 になる。
  ADR-0007）。ストアを使わなくても、`@banto/ui` を足すなら exclude に入れておく。使わなければ何も要らない
  （既存の `@banto/*` の API は変わらない）。
- 次の版から `@banto/theme` に余白・文字サイズ・枠線幅の段階のトークン（`--banto-space-1`〜`-8`・
  `--banto-font-size-xs`/`sm`/`md`/`lg`/`xl`・`--banto-border-width`/`-strong`。後の版で本文の大きさの `--banto-font-size-base` を追加）がある。**追加のみ・後方互換**で、
  タグを上げても画面は変わらない。派生側の CSS の生の `rem` / `px` は、**任意で**これらに置き換えられる
  （値と丸めの目安は [design/theme-dimension-tokens.md](design/theme-dimension-tokens.md) §5.2、一覧は
  `packages/theme/README.md`）。置き換えると 1〜2px 動くことがあるので、画面を開いて確かめる。

#### 共通フォームの ID と readonly（次リリース）

`BantoForm` 内の入力 ID は項目名そのものからフォームごとの生成 ID に変わる。
`#name` のような CSS / テスト / DOM 参照をしている場合は、ラベルやフォーム内の要素からの参照へ移す。
`FieldDef.name` と検証・送信のキーは変わらない。各 field を直接使う場合の既定 ID は従来どおりで、
任意の `id` と `aria-describedby` を渡せる。

テキスト系の readonly は disabled と分離され、フォーカスできるようになる。
select / checkbox はネイティブ readonly がないため disabled を維持する。
readonly / disabled 時の入力・blur・数値ドラフトの確定は抑止するが、値は引き続き検証・送信対象。
詳細と直接利用の契約は [forms README](../packages/forms/README.md#ラベルエラー読み取り専用issue-495) を参照。

`BantoForm` の `appearance="underline"`（ADR-0024）は任意指定で、対応版の forms と theme CSS を
組み合わせる。省略時は従来の枠型の構造・配置を維持し、背景は ADR-0025 により透明になる。
商品・ユーザー管理の更新された markup を取り込む場合も
両方を同じ対応版へ更新する。各 field の追加 `class` はネイティブ要素へ渡される。

#### グリッドのエラー領域（次リリース、ADR-0027）

`BantoGrid` の外側に常設の `.banto-grid-frame` が入り、スクロールする `.banto-grid` と
エラーを読む `.cell-error-region` が兄弟になる。表の寸法や入力 DOM は維持するが、
独自 CSS / DOM / テストが `親 > .banto-grid` や `.banto-grid .cell-error` に依存する場合は更新する。
表は子孫の `.banto-grid`、本文は入力の `aria-describedby` が参照する要素から探す。
既存のエラー本文 ID と `role="alert"` は維持する。

エラーがある時の Tab / Shift+Tab は再送信せず全文を読む領域へ進む。
入力変更後も Enter が明示的な再試行となる。エラーなしの Tab は従来の確定・セル移動を保ち、
失敗した場合だけ同じ編集のエラー領域へ進む。領域の Shift+Tab / Escape は入力へ戻り、取消しない。
入力と領域の往復では blur 保存を抑止する。外部の操作先からフォーカスを奪わない。

新しい `GridMessages.inlineEditErrorLabel(header)` / `inlineEditErrorHint()` は省略可能で、日本語が既定。
多言語アプリは message bundle も更新する。admin-template では対応する日英の辞書と bridge を取り込む。
詳細は [grid README](../packages/grid-svelte/README.md#長いエラーの全文を読む次リリースadr-0027) を参照。

適用済みフィルタの説明にも、任意の `GridMessages.filterAppliedDescription(header)` を追加した。
既定は日本語なので、多言語利用は対応する辞書と bridge も取り込む。
適用状態は二重下線・説明で示し、ボタン名や `aria-expanded` の開閉契約は維持する。

#### 日付のフィールド（v7.0.0、date-time-pickers PR-3）

**空の日付は `''` ではなく `null` になる**（[design/date-time-pickers.md](design/date-time-pickers.md) D6）。
`@banto/forms` の `type: 'date'` について、次の 3 か所が変わる。

- `DateField`（`BantoForm` の中も直接利用も）が、入力を消したときに `onInput(null)` を呼ぶ（今までは `''`）。
- `createFormStore` / `createFormDraft` の初期値で、`default` の無い date の項目が `null` になる（今までは `''`）。
- `FormDraft.commit` が、空の date を `null` として確定する。

送信する値・`values` の date を `=== ''` や `.length` で見ている箇所は、`null` も空として扱うように直す
（`value == null || value === ''` など）。Rust 側の入力の型が `String` で date を受け取っている場合は `Option<String>` にする
（`null` は `String` に deserialize できない）。DB の TEXT の列に `''` が入らなくなるので、並べ替え・絞り込みで空が先頭に
混ざることも無くなる。既存の行の `''` はそのまま残るので、必要なら `NULL` に揃える。

あわせて次が増える（後方互換。指定しなければ今までどおり）。

- date の**形式の検証**: `validateField` が、値が `YYYY-MM-DD` の実在の日でなければエラーにする。ネイティブの
  `<input type="date">` は常にこの形を返すので、ネイティブのままのアプリでは結果は変わらない。値を自分で入れている場合
  （`store.setValue`・`initial`）は正規の形にする。
- `FieldDef` の `min` / `max` が `number | string` になる。date では `'2026-11-02'` のような正規の文字列で範囲を指定する
  （両端を含む）。型に合わない側の値は無視する（number の項目の文字列、date の項目の数値）。`isDateDisabled(date)` で
  選べない日を指定できる。新しい文言は `ValidationMessages` の任意の `dateInvalid` / `dateMin` / `dateMax` /
  `dateDisabled`（既定は日本語）で、多言語アプリは辞書と bridge にも足す（admin-template の `validation.date*` と
  `formValidationMessages()`）。
- **日付ピッカーの注入**: `provideFieldInputs({ date })`（context。レイアウトで 1 回）か `BantoForm` の `fieldInputs`
  prop（フォームごとの上書き）で、`@banto/ui` の `DateInput` などを date の項目に使える。注入しなければネイティブの
  入力のまま。admin-template はルートの `+layout.svelte` で `FormDateInput.svelte`（`DateInput` に文言と locale を足す
  薄い包み）を注入している。取り込むと date の項目の見た目が変わる（入力欄 ＋ カレンダーのボタン。`appearance="underline"`
  のフォームでも枠のある入力欄のまま）。FormDraft には `DraftDateField` を使う。詳細は
  [forms README](../packages/forms/README.md#日付の入力と注入date-time-pickers-pr-3)。

`@banto/grid-svelte` の `SchemaField` の `min` / `max` も `number | string` に広げた（構造の鏡像）。

#### グリッドの日付のセル（v7.0.0、date-time-pickers PR-4）

`@banto/grid-svelte` の `editor: 'date'` も forms に揃える。

- **空の日付は `null`**: セルを空にして確定・空のセルを貼り付け・CSV の空の欄で、`onCellEdit` / `onRangePaste` /
  `convertCsvRow` の値が `''` から `null` になる。受け取る側（保存・Rust の入力の型）は上の「日付のフィールド」と同じに直す。
- **正規化**: `parseCellInput(raw, 'date')` が素通しをやめ、`2026/11/7`（Excel で保存した CSV の形）・全角などを
  `YYYY-MM-DD` に直す。実在しない日・別の順（`11/07/2026`）・時刻付き・年を省いた `11/7`（貼り付けと CSV のみ）は
  失敗（`inlineEditInvalid`・貼り付けはスキップ・CSV は `convertError`）になる。今まで素通しで入っていた不正な文字列が
  入らなくなる。
- **検証**: `columnsFromSchema` の date の列に、forms と同じ形式・`min` / `max`・`isDateDisabled` の検証が付く
  （`SchemaField` に `isDateDisabled` を追加。文言は `ColumnValidationMessages` の任意の `dateInvalid` / `dateMin` /
  `dateMax` / `dateDisabled`。多言語アプリは admin-template の `columnValidationMessages()` のように bridge へ足す）。
- **日付ピッカーの注入**: `provideCellEditors({ date })`（context）か `BantoGrid` の `cellEditors` prop で、`@banto/ui` の
  `DateInput` などをセルの編集に使える。注入しなければネイティブの入力のまま。admin-template はルートの
  `+layout.svelte` で `CellDateInput.svelte` を注入している。`GridColumn` に任意の `editorMin` / `editorMax` /
  `isDateDisabled`（カレンダーの範囲と無効日）を追加。詳細は
  [grid README](../packages/grid-svelte/README.md#日付のセルと注入date-time-pickers-pr-4)。

#### 時刻・日時の型（v7.0.0、date-time-pickers PR-5）

追加のみで、既存の型の挙動は変わらない。使うときは次を揃える。

- **型**: `FieldType`（forms）・`SchemaFieldType`／`CellEditorType`（grid）に `'time'`（`HH:mm`）と `'datetime'`
  （`YYYY-MM-DDTHH:mm`、タイムゾーンを持たない壁時計の時刻）。空は `null`。`min`／`max` は正規の文字列、`step` は分
  （省略時は一覧 30 分刻み・任意の分を受け付ける）。datetime の入力欄・グリッドの表示は空白区切り、値は `T`。
- **ピッカーの注入**: `provideFieldInputs({ date, time, datetime })`・`provideCellEditors({ date, time, datetime })`。
  admin-template はルートの `+layout.svelte` で `FormTimeInput`・`FormDateTimeInput`・`CellTimeInput`・
  `CellDateTimeInput`（`src/lib/components/`）を注入している。注入しなければネイティブの `time`／`datetime-local`。
- **文言**: 多言語アプリは `ValidationMessages`／`ColumnValidationMessages` の `timeInvalid`・`timeMin`・`timeMax`・
  `timeStep`・`dateTimeInvalid`・`dateTimeMin`・`dateTimeMax` と、`UiMessages` の `dateTimePicker*`・`dateTimeFormatHint` を
  bridge へ足す（admin-template の `i18n.ts` の `timeInputMessages()`・`dateTimeInputMessages()`）。
- **DB と Rust**: 列は SQLite・PostgreSQL とも TEXT。リソースの入力の検証から `banto_core::datetime::validate_time` /
  `validate_datetime`（date は `validate_date`）を呼ぶと、フロントと同じ規則・同じ既定の文言でエラーを返す（正規の形だけを
  受け付ける。空の扱いと `isDateDisabled` に当たる規則はリソース側で書く）。

#### 期間の絞り込み（v7.0.0、date-time-pickers PR-6）

- **PostgreSQL で期間の絞り込みを速くするには索引を張る**: `between` は `CAST(列 AS TEXT) COLLATE "C"` で比べるので、列の通常の
  索引は効かない。自前の date・datetime 列で絞り込むなら、同じ式の索引を migration で足す
  （`CREATE INDEX ... ON テーブル ((CAST(列 AS TEXT) COLLATE "C"));`。例は admin-template の
  `migrations-postgres/0009_items_updated_at_index.sql`）。SQLite は通常の列の索引でよい。
  **この索引は TEXT の列に限る**（banto の既定どおり日付を TEXT で持つ列）。PostgreSQL の `DATE`・`TIMESTAMP` の列では、
  text への変換が IMMUTABLE でないため式の索引を作れず、migration が `functions in index expression must be marked
  IMMUTABLE` で失敗する。そうした列は、TEXT（`YYYY-MM-DD`・`YYYY-MM-DDTHH:mm`）で持つように移すか、期間の絞り込みは
  索引なし（全件走査）で受け入れるか、自前の DataProvider で列の型のまま比べる。

- **見た目が変わる**: `columnsFromSchema` が date・datetime の列を絞り込みできるようにする（見出しに ▾ が出る。読み取り
  専用の列も）。出したくない列は `overrides` で `{ filterable: false }`。date・time・datetime の列の並べ替えは
  `localeCompare` から文字列の大小に変わる（正規の形なら順は同じ）。
- **`FilterOp` に `'between'`**（`@banto/grid-svelte`・`@banto/admin-core`・`banto_core` の鏡像）。値は
  `[from | null, to | null]` の半開区間。`banto-storage` の `ColumnMap` 経由の一覧は何もしなくても受け付ける。
  **自前の `DataProvider` や、`FilterOp` を `match`／`switch` で網羅している派生アプリのコードは `between` を足す**
  （Rust は `match` が網羅でなくなりコンパイルが止まる。規則は grid README の「期間の絞り込み」）。
- **期間の部品の注入**: admin-template はルートの `+layout.svelte` で `provideCellEditors({ ..., dateRange:
  FilterDateRangeInput })` を渡している（`src/lib/components/FilterDateRangeInput.svelte`）。注入しなければ
  ネイティブの日付入力 2 つ。
- **文言**: 多言語アプリは `GridMessages` の `filterRange*` と `UiMessages` の `dateRangeStart`・`dateRangeEnd` を
  bridge へ足す（admin-template の `i18n.ts` の `gridMessages()`・`dateRangeInputMessages()`）。

### 3.2 B: コピーしたテンプレート部分の取り込み

設定のスイッチ共有化（次リリース、ADR-0026）は `banto-switch-field` / `banto-switch` を使う。
更新済み markup と対応版の theme CSS を同時に取り込む。forms / 列表示メニューの checkbox は
package 内の CSS と `1.1rem` fallback を持ち、旧 theme でも寸法を保つ。

シェルにページタイトルを表示する画面は `PageHeader hideTitle`（次リリース）を使い、
内容側の重複タイトルを表示しない。読み上げ用の `<h1>`、説明・操作は維持する。
更新済みの markup と同じ対応版の `@banto/ui` を取り込む。部品単独の既定表示は変わらない。

入力背景の透明化（次リリース、ADR-0025）は `appearance="default"` と field の直接利用にも適用する。
従来の `.banto-input` も透明になる。枠・下線・レイアウト・状態属性は維持し、背景色だけを意図的に更新する。
独自の親背景を使う画面では、文字や下線の読みやすさを確認する。

共有スタイルへの移行（次リリース、ADR-0023）では、設定の入力・ページナビとログイン・初回セットアップの入力が
`@banto/theme/css` の専用クラスを使う。更新された画面の markup を取り込む場合は theme も
同じ版へ更新する。従来の `.banto-input` や `@banto/forms` の既定の枠・配置は維持し、背景は ADR-0025 により透明になる。
他画面での利用は [theme README](../packages/theme/README.md#入力とページナビの共通スタイル次リリース) を参照。

**v6.1.0 以降の admin-template は `components/ui/` の 7 部品（EmptyState・ErrorState・IconButton・LoadingState・PageHeader・
StatusBadge・SurfaceCard）を持たず、`@banto/ui` から import する**（#220）。派生側が写した `components/ui/` はそのまま
残しても動く（移行は任意）。取り込むなら、`@banto/ui` を依存に足して import 文を `#lib/components/ui/X.svelte` から
`@banto/ui` へ差し替え、写した 7 ファイルを消す。`LoadingState` の `label` の既定は `@banto/ui` では
`defaultUiMessages.loading()`（日本語）になるので、多言語化している派生側は全呼び出しで `label` を明示する
（admin-template は `m['common.loading']()` を渡している）。

**メニュー部品（`Menu`・`MenuGroup`・`MenuItem`・`MenuSeparator`）も同じ版から `@banto/ui` にある**（#220 段階 2a）。
admin-template の `components/menu/` は無くなった。派生側が写した `components/menu/` はそのまま残しても動く。取り込むなら
`import Menu from './menu/Menu.svelte'` などを `import { Menu, MenuGroup, MenuItem, MenuSeparator } from '@banto/ui'` へ
差し替え、写した 5 ファイル（`menuContext.ts` を含む）を消す。props と DOM・CSS は同じ。あわせて、オーバーレイの背景・
重なり順に生の `rgba()` や z-index を直書きしているなら、`@banto/theme` の新しいトークン `--banto-scrim`・`--banto-z-*` に
置き換えられる（任意）。

**コマンドパレットの表示と操作も次の版から `@banto/ui` の `CommandPalette` にある**（#220 段階 2b）。admin-template の
`components/CommandPalette.svelte` は、コマンドの一覧（`#lib/commands`）・admin-core の `searchCommands`・セッションの
スコープで閉じる処理（#258）・最近使った記録・失敗の通知・Paraglide の文言だけを持つ薄い包みになり、`@banto/ui` の
`CommandPalette` を `open`・`items`・`search`・`onExecute`・`onClose`・`messages` で呼ぶ。`commandPalette.svelte.ts`
（開閉のストア）と `(app)/+layout.svelte` の `Ctrl+K` の配線は変わらない。派生側が写した `CommandPalette.svelte` は
そのまま残しても動く。取り込むなら admin-template の新しい `CommandPalette.svelte` を差分として当て、写しの検索欄・
一覧・キー操作・CSS を消す。取り込むと、開いている間のフォーカストラップ・閉じたときに開いた元へのフォーカスの戻し・
フォーカスの位置に関係なく効く Esc が標準で付く（見た目は同じ）。banto-industrial の 2 アプリ（banto-hub・chronogazer）の
写しは段階 3 で `@banto/ui` に置き換える（banto-hub の層の印 `role="dialog"`・`data-esc-layer`・`data-layer-inactive` は
そのまま読む）。

**トーストのストアと表示（`createToastStore()`・`ToastHost`）も次の版から `@banto/ui` にある**（#220 段階 2c）。admin-template の
`lib/toast.svelte.ts` は `export const toastStore = createToastStore();` の 1 行になり、`components/ToastHost.svelte` は
`@banto/ui` の `ToastHost` を `store`・`messages`（`toastClose` に Paraglide の「閉じる」）で呼ぶ薄い包みになった。
`setup.ts` の `notify: (kind, message) => toastStore.push(kind, message)` の配線と、各画面の `toastStore.push(...)` は変わらない。
アクション付き（取り消しなど）は `push(kind, message, { action: { label, onAction }, durationMs })`（banto-hub の `onClick` から
`onAction` に改名。戻り値の id は数値から文字列になった）。派生側が写した `toast.svelte.ts`・`ToastHost.svelte` はそのまま残しても動く。
取り込むなら写した 2 ファイルを admin-template の新しい薄い版に替える。**取り込む派生アプリは `@banto/ui` を
`vite.config.ts` の `optimizeDeps.exclude` に足す**（`.svelte.ts` を持つ `@banto/*` の不変条件。[ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.md)、
`verify:architecture` の rule `optimizedeps-svelte-source` が落とす）。

テンプレート側の変更は、同期元の版と新しい版の**差分**を見て、派生側へ適用する。

```sh
# banto を派生リポジトリの外にクローンしておく
git clone https://github.com/tyaro/banto.git ../banto-upstream && cd ../banto-upstream

# 同期元(vFROM)と取り込み先(vTO)の差分を、テンプレート部分に絞って確認
git diff --stat   vFROM vTO -- apps/admin-template e2e scripts
git diff          vFROM vTO -- apps/admin-template/src/routes
git log --oneline vFROM..vTO -- apps/admin-template e2e scripts   # 関連コミット・PR を拾う（記録に使う）
```

- 派生側で**ファイル名・クレート名を変えている場合**（`rename.mjs` による変更など）は、差分のパスを読み替える。
  何が置き換わるかは [recipes/rename.md](recipes/rename.md)「スクリプトが書き換える箇所」を参照。
- 派生側で**削除済みの機能**（プリセットで外した `items`・attachments・users など）の差分は読み飛ばす。
- 派生側で**独自に変えたファイルと同じファイルが変わっている**ときは、機械適用せず手で突き合わせる。
  rename 済みのパスでは `git apply` が当たらないことが多く、手で移すほうが速い場合も多い。
- 見る場所: `src/routes/`、`src/lib/`、`core/src/`、`src-tauri/`、`messages/*.json`、`e2e/`、
  `vite.config.ts`（v3.x までは `svelte.config.js` も。v4.0.0 で廃止）、`package.json` の依存範囲と `imports`。`scripts/scaffold.mjs` のアンカーが変わる版は、
  派生側で scaffold を再実行しない限り影響しない。
- 取り込み可否と関連 PR を同期記録に残す（5 節）。

## 4. DB・設定・配布資産の移行

テンプレートの DB マイグレーション（`apps/admin-template/core/migrations-{sqlite,postgres}/`）は
**アプリの起動時に自動適用**される（`sqlx::migrate!`、`core/src/db.rs`）。つまり**新しいバイナリを本番 DB で
最初に起動した時点で DB が進む**。ここが戻せなくなる境界。

**要否の判断**: リリースノートの C に「マイグレーション」「設定キー」「配布物」が書かれた版だけが対象。
`@banto/*` の更新だけの版（v1.6.0 など）は不要。

**順序（要対応の版）**:

1. **バックアップ**: SQLite は、アプリを止めて DB ファイル（`-wal`・`-shm` があればそれも）をコピーする
   （または設定画面のバックアップ節。SQLite 専用）。PostgreSQL は `pg_dump -Fc <db> > before-upgrade.dump`。
   設定ファイル、`tauri.conf.json`、配布物（インストーラ・同梱資産）も取っておく。
2. **コード（A と B）を先に完成させる。** 型検査・build・テストが通る状態にしてから DB に触る。
3. **マイグレーション SQL を取り込む**（B の一部）。sqlite・postgres の**両方言**に同じ番号で入れる
   （`verify-architecture` の rule 11 `migration-dialect-parity` が揃っているか検査する）。
   **適用済みのマイグレーションは編集しない**（sqlx が内容の不一致を検出して起動に失敗する）。
4. **検証用の DB コピーで起動して適用結果を確認**してから、本番に当てる。
5. 設定キー・`tauri.conf.json`（CSP など）・配布物の変更は、更新したアプリを起動した後で確認する。

**戻せる条件**: マイグレーションは**前進のみ**（down は無い）。戻すには「1 のバックアップを復元し、旧版のバイナリで
起動する」しかない。新版で一度でも書き込みが走ると、復元でその分は失われる。したがって
**戻せる境界は「新版を本番 DB で最初に起動するまで」**。リリースノートでは、マイグレーションの有無と、
戻せる条件を明記する。

### 4.1 Windows のインストール形態が perMachine に変わる（#219 段階 2）

[ADR-0021](adr/0021-firewall-elevated-helper.md) の決定 2・3 により、テンプレートの
`apps/admin-template/src-tauri/tauri.conf.json` は NSIS の `bundle.windows.nsis.installMode` を
`"perMachine"` にし、アンインストール時のフック（`installerHooks`、`src-tauri/windows/fw-elev-hooks.nsh`）を
持つ。B（コピーしたテンプレート部分）でこれを取り込むと、派生アプリの配布物に次の影響が出る。

- **インストール先が Program Files に変わる**（既定は `C:\Program Files\<productName>`。以前の既定は
  per-user の `%LOCALAPPDATA%\<productName>`）。
- **インストール時（とアンインストール時）に UAC が出る**。管理者の承認が無いとインストールできない。
- **データは移動しない**。DB・設定は `%APPDATA%\<identifier>\` にあり、インストール先とは別なので、
  identifier を変えない限りそのまま使われる。
- **helper の同梱**: ファイアウォールの許可を昇格して行う helper（`<本体の exe 名>-fw-elev.exe`）を
  本体 exe の隣に置くには、インストーラを `pnpm --filter <アプリ名> tauri:build:windows`
  （= `tauri build --features embed-ui --config src-tauri/tauri.fw-elev.conf.json`。helper を先にビルドして
  `externalBin` で同梱する）で作る。この設定は `bundle.targets` を `["nsis"]` に絞るので、MSI は
  作られない（MSI には helper のルールを外すアンインストールのフックが無く、アンインストールしても
  ルールが残るため、段階 2 では MSI に対応しない）。素の `tauri build` で作ったインストーラには helper が入らず、
  段階 2 は「前提が無い」で止まって段階 1 の案内になる（アンインストールのフックは、helper が無い旨と
  手で外す方法を表示して続行する）。
- **LAN 向けの Web UI の埋め込み（#478）**: `tauri:build:windows` は `--features embed-ui` も付けるので、
  別の端末が LAN から開く画面（と `/reach` の接続確認）が入る。素の `tauri build` には入らず、別の端末には
  仮のページが返る。そのビルドの設定画面は URL・QR・接続確認を出さず、入っていない旨を出す。
- **portable・per-user では段階 2 は使えない**。`installMode` を `"currentUser"`・`"both"` に戻した
  派生アプリや、exe をコピーして配る運用では、helper の配置の検査（Program Files の下・管理者だけが
  書ける）に通らず、画面は段階 1 の案内（コピーする PowerShell のコマンド）だけになる。段階 2 が要らない
  ならそれでよい（`tauri.conf.json` の `installMode` を戻すだけで、ほかは変えなくてよい）。
- **インストール時にはルールを作らない**。許可はアプリの設定画面で admin が行う。アンインストール時は
  アンインストーラに埋め込んだ helper の写し（インストール先の helper は起動しない）でアプリが作ったルール
  （`<identifier>.lan.tcp.program`）だけを外し、
  外せなくても（helper が無い・管理者が変えたルール・失敗）アンインストールは止めずに、ルール名と手で
  外す方法をアンインストールの詳細に表示する。Tauri の更新（`/UPDATE`）ではルールを残す。

**既存の per-user インストールからの移り方**: perMachine のインストーラは per-user のインストールを
見つけず（登録先が HKCU と HKLM で違う）、上書きもしない。そのままでは 2 つのコピーが並ぶので、次の順で移る。

1. アプリを終了し、念のため DB をバックアップする（上の「順序」の 1）。
2. 旧版（per-user）を「設定 > アプリ」からアンインストールする。**アプリのデータを消す選択肢は選ばない**
   （選ぶと `%APPDATA%\<identifier>\` の DB も消える）。
3. 新版（perMachine）をインストールする（UAC が出る）。DB・設定はそのまま引き継がれる。
4. 段階 1 でコピーしたコマンドでファイアウォールのルールを手で作っていた場合、そのルールは旧パスの exe を
   指しているので、設定画面の状態は「あり（コマンドで作る内容と違う項目があります）」になり、プログラムの
   項目に旧パスが出る。「ここから許可を変更する」の欄には「許可を外す…」だけが出て、許可のボタンは出ない。
   それを押して UAC を承認しても「競合」（同じ名前で、このアプリが作ったものではないルールがあるため、
   作りも消しもしていません）になり、ルールは残る。管理者の PowerShell で
   `Remove-NetFirewallRule -Name '<identifier>.lan.tcp.program'` を実行して外し、「再確認」を押して状態が
   「ルール無し」になったのを確かめてから、設定画面で改めて許可する。
5. スタートメニュー・デスクトップのショートカットは新しいインストール先のもの（全ユーザー共通）に変わる。

## 5. 派生アプリの基準版の記録（同期記録）

派生リポジトリに、Banto のどの版を基準にしているかを**依存とコピーで別々に**残す。ツールは作らず、
派生リポジトリの README（または `docs/banto-sync.md`）に次の節を置いて手で更新する。

```markdown
## Banto 同期記録

| 対象                          | 基準                     | 備考                                                  |
| ----------------------------- | ------------------------ | ----------------------------------------------------- |
| 依存（`@banto/*`・`banto-*`） | タグ `v1.7.3`            | package.json と Cargo.toml の全てが同じタグ（確認日） |
| テンプレートの同期元          | タグ `v1.5.0`（`<sha>`） | `apps/admin-template` からコピーした日。rename 済み   |

### テンプレート取り込み状況（部分適用の記録）

| Banto 版 | 項目（関連 PR）                            | 状態   | 派生側の PR / メモ              |
| -------- | ------------------------------------------ | ------ | ------------------------------- |
| v1.6.0   | 設定画面のページ分割（#197・#198）         | 取込済 | #34。独自の節は connectivity へ |
| v1.7.3   | 一覧の並び（unique key）                   | 不要   | A のみ。B の変更なし            |
| v2.0.0   | SessionController 配線（#260・#264〜#266） | 一部   | #41。手順 1〜4 済み、5〜7 未    |
```

- **単一の基準版を「全部適用済み」と読まない。** 依存を v2.0.0 に上げても、テンプレートの同期元が v1.5.0 のままなら、
  v1.6.0 以降の B の変更は未取り込みの可能性がある。2 行を別に持つのはそのため。
- 部分適用（一部の画面だけ取り込む、特定の変更を見送る）は、下の表に**項目単位**で書く。状態は
  `取込済` / `一部` / `見送り` / `不要`（A のみ）の 4 種で足りる。見送りには理由を書く。
- 同期元の commit は `git rev-parse vX.Y.Z` で得られる。リリース版はタグで足りる。候補版（未リリースの
  commit）を検証・採用したときは commit を書く（8 節）。
- 全部を取り込み終えたら「テンプレートの同期元」の行を新しい版に更新する（途中は上げない）。

## 6. 更新後の確認

**その版に関係する範囲に絞る。** 毎回全画面を見る必要はない。リリースノートの「確認項目」を優先する。最低限は次の 4 つ。

1. `pnpm install --frozen-lockfile`・`pnpm check`・`pnpm build`（A の追従漏れ・型エラー）。
2. **`pnpm dev`（Vite の dev サーバ）でブラウザを開き、主要画面が描画されること。** `check`・`build` は dev の
   依存事前バンドルを通らないため、#150（`js_parse_error`／500）のような不具合は dev でしか出ない。
3. `cargo check` / `cargo test`（Rust の追従。PostgreSQL を使うテストは DB が要る）。
4. 変更に関係する操作（認証を触った版ならログイン・ログアウト・別タブの切り替え、設定画面を触った版なら各カテゴリの
   保存、など）。Tauri なら `pnpm tauri dev` でも一度。

## 7. セキュリティ修正の扱い

- Banto 側の修正は、リリースノートに**影響する利用形態**（LAN 公開・Tauri のみ・PostgreSQL 利用 など）と
  **推奨対応**を書く。派生側は、自分の利用形態が該当するかをまず判断する。
- **A の修正はタグを上げれば入る。B の修正は自動では入らない。** 修正が B のファイルにあるときは、リリースノートに
  「コピー側の取り込みが必要」と明記する。派生側は優先して取り込み、同期記録に残す。
- 修正だけを取り込みたいときは、全版の B を追わず、その修正のコミットだけを `git diff` / `cherry-pick` で適用し、
  同期記録を `一部` にする（残りは通常のタイミングで追う）。
- Banto の CI（`pnpm audit` / `cargo audit`）は Banto 自身の依存が対象。派生固有の依存は派生側の CI でも監査する。

## 8. 外部利用の互換性確認（Banto 側の検証と手順）

派生アプリの更新が成り立つことを、Banto 側でどこまで機械的に保証し、何を手順で補うか。

### 8.1 CI が保証しているもの

| 経路                                                                    | 何を保証するか                                                                                                       | 外部利用（Git 依存 + サブディレクトリ）を通るか |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [ci.yml](../.github/workflows/ci.yml)                                   | モノレポ内（`workspace:*`・`path` 依存）の lint・型検査・test・build・Rust・PostgreSQL・e2e・audit                   | いいえ（ソース直接参照）                        |
| [template-acceptance.yml](../.github/workflows/template-acceptance.yml) | コピー → rename → 型検査・cargo check、各プリセットの scaffold → build・cargo test                                   | いいえ（コピー後も `workspace:*` のまま）       |
| [tauri-check.yml](../.github/workflows/tauri-check.yml)                 | `src-tauri` のビルド                                                                                                 | いいえ                                          |
| [external-consumer.yml](../.github/workflows/external-consumer.yml)     | 外部利用 fixture に Git 依存で導入 → `vite dev` を起動してブラウザで描画 → `pnpm check`・`pnpm build`・`cargo check` | **はい**（8.2）                                 |

「Git 依存 + `path:` で `@banto/*` を導入し、`pnpm dev` を起動する」経路は、`files: ["src"]` による配布物の
絞り込み、サブディレクトリの解決、node_modules 実体になったときの Vite の dev 事前バンドル（#150、ADR-0007）を
含む。`pnpm build`・`pnpm check` だけでは見つからないので、external-consumer.yml がブラウザで確かめる。

### 8.2 外部利用 fixture の CI（external-consumer.yml、#271）

[fixtures/external-consumer/](../fixtures/external-consumer/) に最小の派生アプリを置き、CI で外部利用の経路を
通す（2026-10-01 に CI 化。それまでは手順だけだった）。

- **fixture**: SvelteKit（adapter-static・SSR なし）。`.svelte.ts` をソース配布する 5 パッケージ（admin-core・
  dock-svelte・forms・grid-svelte・tree-svelte）と theme と ui（`.svelte` と `.ts` だけで `.svelte.ts` を持たないので exclude の対象外。
Git 依存の導入と svelte-check・vite build を確かめるために、部品を 1 つ描画する）を `github:tyaro/banto#<ref>&path:packages/<x>` で入れ、
  `+page.svelte` で import して `data-testid="banto-loaded"` に描画する。Rust 側（`rust/`）は公開対象の 5 crate
  （`crates/*`）を `git = ..., rev = "<ref>"` で入れる。対象の一覧は `verify:architecture`（rule
  `external-consumer-fixture`）が workspace から洗い出して突き合わせ、漏れがあれば落とす。
- **検証する commit**: PR は head SHA（同じリポジトリのブランチからの PR だけ。fork からの PR はスキップ）、
  `workflow_dispatch` は入力の ref。fixture の依存には SHA（Cargo は `rev`）を書く。リリースタグの push（と
  dispatch に既存のタグ名を渡したとき）は、依存に**タグ名**を書き（npm `#vX.Y.Z&path:`、Cargo `tag = "vX.Y.Z"`。
  派生アプリと同じ形）、タグ名での解決を確かめる。このとき fixture とスクリプトは workflow を起動した commit
  （tag push ならタグの commit、dispatch なら通常 main）のものを使う。fixture の無い古いタグも検証できるが、今の
  fixture が import する export がそのタグに無ければ失敗しうる。あわせてタグ名と**タグの commit** の各
  マニフェストの version の一致を `check-versions.mjs --tag` で検査する。PR は `packages/**`・`crates/**`・Vite／svelte／pnpm／Cargo の設定・
  fixture・ワークフロー自身を変えたときだけ走る。
- **合格条件**（job `npm`）: `vite dev` で開いたページにマーカーが描画される、`console.error`・`pageerror` が
  ゼロ、dev ログに依存オプティマイザのエラー（`error while updating dependencies`・`js_parse_error`）が無い、
  続けて `pnpm check`・`pnpm build` が通る。#150 が再現しても dev の `/` は 200 のまま（動的 import が 504 →
  クライアント側の 500 画面）なので、HTTP の応答では判定しない。job `rust` は `cargo check` と
  `cargo check --all-features`（postgres・system-metrics の feature の経路）。
- **診断**（job `npm-no-exclude`、成功条件にしない）: `optimizeDeps.exclude` を外して dev + Playwright だけを流し、
  #150 が再現したかを step summary に残す。再現しなくなったら exclude が不要になった可能性があり、ADR-0007 を
  見直す合図。
- **ネットワーク**: github.com（codeload）からの取得は 3 回まで再試行、cargo は `CARGO_NET_RETRY=5`。fixture の
  lockfile は commit してあり、ref を書き換えた後は `--no-frozen-lockfile` で入れる（再解決されるのは `@banto/*`
  だけで、推移依存は lockfile のまま）。Rust の `Cargo.lock` は commit しない（新しい派生アプリと同じく、その
  時点の crates.io で解決する）。
- **失敗時**: PR は赤になる（必須チェックにはしていない。赤ならマージしない）。タグで失敗したときは tracking
  issue（ラベル `external-consumer-failure`）を起票する。dev ログと Playwright のレポートは artifact に残す。
- **検証した組み合わせ**: step summary に Node.js・pnpm・Svelte・SvelteKit・Vite・Rust の実際の版と検証した
  commit を出す（下の表は範囲。実際の版は run の summary が正）。
- **対象外**: SSR ありの構成（adapter-node 等）は検証しない。派生アプリは adapter-static の SPA 構成を前提に
  している。
- **banto 本体専用**: fixture・ワークフロー・`scripts/external-fixture-set-ref.mjs` は scaffold した派生アプリには
  含まれない（`scripts/scaffold.mjs` が全プリセット共通で除去する）。コピー・rename しただけのリポジトリでは、
  ワークフローは `tyaro/banto` 以外では走らない。

### 8.3 候補 commit・リリースタグの検証手順

通常は CI（8.2）に任せる。**リリースタグを打つ前**に main の SHA で `external-consumer` を `workflow_dispatch`
し、緑を確認する（[publishing.md](publishing.md)「タグ運用規約」）。ローカルで同じことを確かめるときは、Banto
リポジトリの中で次を流す（`<ref>` は GitHub に push 済みの commit SHA かタグ）。

```sh
# ルート: Playwright を使うためにルートの依存を入れておく（fixture の `pnpm check` も
# playwright.config.ts の型解決にこれを使う。無いと Cannot find module '@playwright/test'）
pnpm install
node scripts/external-fixture-set-ref.mjs <ref>

cd fixtures/external-consumer
pnpm install --no-frozen-lockfile
pnpm dev            # 手で開く場合（http://127.0.0.1:4319/）
pnpm check && pnpm build
cd rust && cargo check && cargo check --all-features

# ブラウザでの判定（ルートから。exclude 無しの診断は BANTO_FIXTURE_NO_EXCLUDE=1 を付ける）
pnpm exec playwright test --config=fixtures/external-consumer/playwright.config.ts
```

fixture は自分の `pnpm-workspace.yaml`（`packages: []`）でルートの workspace から独立している。
`--ignore-workspace` は要らない（これが無いと fixture で `pnpm install` してもルートのインストールに化ける）。
確認が済んだら `node scripts/external-fixture-set-ref.mjs <現行リリースタグ>` で戻し、fixture の
`pnpm-lock.yaml` の差分は commit しない（commit する値は現行リリースタグ）。
fixture が commit している ref は現行リリースタグなので、**main にしか無いパッケージ（新しく足した `.svelte.ts`
同梱パッケージなど）を試すときは、ref を main の SHA に書き換えてから** install する（既定の状態ではそのパッケージ
の `path:` がタグに無く、install が失敗する）。リリース時に fixture の ref を新しいタグへ上げる手順は
[publishing.md](publishing.md)「タグ運用規約」。

**確認する組み合わせ**（Banto の現行の基準。ルート `package.json`・`apps/admin-template/package.json`・CI）:

| 項目       | 範囲                                                    |
| ---------- | ------------------------------------------------------- |
| Node.js    | `>=24`（CI は 24）                                      |
| pnpm       | 10.x（`packageManager: pnpm@10.33.0`）                  |
| Svelte     | `^5.57`（runes 前提）                                   |
| SvelteKit  | `^3.0`（v4.0.0 から。v3.x までは `^2.70`）              |
| TypeScript | `^6.0`（kit 3 の peer。7 は対象外）                     |
| Vite       | `^8.3`                                                  |
| Rust       | stable（`dtolnay/rust-toolchain@stable`、edition 2021） |

組み合わせを変える版（Vite のメジャーなど）は、リリースノートにその旨を書き、fixture の依存の版も揃える
（fixture の Vite／Svelte 系の devDependencies は `apps/admin-template/package.json` と同じ範囲指定に揃え、
`verify:architecture` の rule `external-consumer-fixture` が文字列の一致を検査する）。

### 8.4 役割分担

| 担い手                               | 範囲                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banto の CI（ci.yml ほか）           | 共通契約（モノレポ内のビルド・テスト・scaffold・セキュリティ監査）                                                                                   |
| Banto の CI（external-consumer.yml） | 外部利用の経路（Git 依存での導入・dev 起動とブラウザでの描画・check・build・`cargo check`）。タグ後の実行はタグ名での解決と version の一致を確かめる |
| 派生アプリの CI                      | 各アプリ固有のテスト・画面・実機。Banto の CI へは集約しない                                                                                         |
| 手順（8.3）                          | リリース前の `workflow_dispatch` と、ローカルでの切り分け                                                                                            |

## 9. 共通 UI のパッケージ化（#220）への適用

共通 UI を `@banto/*` のパッケージとして切り出す場合、**その UI は経路 B から A へ移る**。同じ案内の形で書ける。

- リリースノートでは、その UI を使っている派生アプリに「コピー済みのファイルを削除し、パッケージの import に
  置き換える」移行を B の項目として書く（v2.0.0 の SessionController のように A と B がセットになる）。
- 置き換えが済むまでは、同じ UI がコピー側と依存側に二重にある。同期記録の表で、**どの派生アプリがどちらを
  使っているか**（`コピー` / `パッケージ`）を持つ。
- 以降の修正は A を上げるだけで入る。コピー側が残っている間だけ B の取り込みが要る（7 節）。
- `.svelte.ts` を含むパッケージなら、`optimizeDeps.exclude` に加える案内を B の項目に必ず入れる（3.1）。

## 10. 具体例

### 例 1: v1.5.0 → v1.6.0（設定画面の分割。B のみ）

CHANGELOG の [1.6.0](../CHANGELOG.md) 冒頭のとおり、`@banto/*`・`banto-*` は版数が上がるだけで実装は v1.5.0 と
同一。**A は「タグを上げてもよいし、上げなくてもよい」。対象は B（テンプレートの設定画面）だけ。**

| 経路      | 項目                                                         | 取り込み                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A         | `@banto/*`・`banto-*`                                        | 不要（実装は同一）。揃えたければタグを 1.6.0 へ                                                                                                                                                                                                                               |
| B         | 設定画面（`apps/admin-template/src/routes/(app)/settings/`） | `+page.svelte`（1,812 行）を廃止し、`+layout.svelte`・`+layout.ts`・`categories.ts`・`shared.ts`・`settings.css`・`*Section.svelte` 5 本・カテゴリごとの `+page.svelte` / `+page.ts`・共有ストア 2 本（`authSettingsStore.svelte.ts`・`systemInfoStore.svelte.ts`）に置き換え |
| B         | `src/lib/session.svelte.ts`                                  | コメントの参照先のみ（機能変更なし）                                                                                                                                                                                                                                          |
| B         | `e2e/`（`tests/smoke.spec.ts`・`visual/*`）                  | 設定の URL が `/settings/<category>` になったため、シナリオと visual のエントリを更新                                                                                                                                                                                         |
| B（任意） | `scripts/scaffold.mjs`・`verify-architecture.mjs`            | scaffold を再実行する派生のみ。glass remover のアンカーが `AppearanceSection.svelte` へ                                                                                                                                                                                       |
| C         | DB・設定キー・配布資産                                       | 変更なし（マイグレーション不要）                                                                                                                                                                                                                                              |

派生側の調整箇所:

- **独自に設定画面へ項目を足している場合**: 旧 `+page.svelte` に足した節を、該当カテゴリの `*Section.svelte`
  （または新しいカテゴリの `+page.svelte` と `categories.ts` への登録）へ移す。v1.6.0 の主眼は「ルートを足す形で設定を
  拡張できる」こと。
- **設定へのリンク・ブックマーク**: `/settings` は先頭の可視カテゴリへ 307 リダイレクトされる。ディープリンクは
  `/settings/{appearance,account,connectivity,data,security}` を使う。

確認項目（この版に関係するものだけ）:

1. `pnpm check`・`pnpm build`・`pnpm dev`（`/settings` が先頭カテゴリに遷移して描画される）。
2. 5 カテゴリそれぞれで、設定の保存・読み込みが従来どおりできる。非可視カテゴリへ直接遷移しても先頭へ戻る。
3. 画面幅 1024px 以上（左レール）と未満（横タブ）の表示。
4. e2e の smoke・visual / a11y の settings 系（派生側にコピーしているなら）。
5. 同期記録に「設定画面のページ分割 取込済（PR 番号）」を書く。

### 例 2: v1.7.x → v2.0.0（SessionController。A と B がセット・破壊的変更）

v2.0.0 は admin-core の旧セッション API を削除し、`AuthProvider` の `resolve`・`credentialRevision`・
`onCredentialChanged` を必須にする**破壊的変更**。詳細な移行表と手順は CHANGELOG の
[2.0.0「SessionController 実装-3」](../CHANGELOG.md#200---2026-10-01)が正で、
ここには**取り込みの組み立て**だけを書く。設計は [session-controller-design.md](design/session-controller-design.md)、判断は
[ADR-0016](adr/0016-session-controller-single-writer.md)。

| 経路 | 項目                                                                                                                   | 取り込み                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A    | `@banto/admin-core` を v2.0.0 へ                                                                                       | 他の `@banto/*`・`banto-*` も同じタグへ。旧 API（`resolveProtectedSession` など）の呼び出しが型エラーになる             |
| A    | 自前の `AuthProvider`                                                                                                  | 3 メソッド必須（CHANGELOG の手順 7）。一時的に `adaptLegacyAuthProvider` で包める（移行 PR に「adapter 使用中」と明記） |
| B    | `src/lib/session.svelte.ts`、`(app)/+layout.ts`・`+layout.svelte`、ログイン・ログアウト、503 画面、`providers/demo.ts` | CHANGELOG の「派生アプリの移行の手順」1〜6。admin-template の同名ファイルが手本                                         |
| B    | Tauri 側（`src-tauri` の認証コマンド、設定の `auth.*` キー）                                                           | `settings_set` が `auth.` キーを拒否する等の挙動変更。派生が独自の認証コマンドを持つなら確認                            |
| C    | DB・設定                                                                                                               | マイグレーション不要（セッションはメモリのみ）。ログイン不要モードの挙動が変わるので、使っている運用は確認              |

進め方:

1. 先に**候補版のコミット参照で検証**する（`github:tyaro/banto#<sha>&path:...`、Cargo は `rev`）。Banto 側の
   fixture（8.2・8.3）で同じ SHA が緑かを見ておくと切り分けやすい。その後に v2.0.0 のタグへ移す。
2. A を上げて型エラーを一覧にする。次に B を 1 つずつ（`session.svelte.ts` → `(app)/+layout.ts` → 保護レイアウト →
   ログアウト → 503 画面）取り込む。
3. 複数アプリ（banto-hub・chronogazer）がある場合は、**1 アプリずつ**移行する（同期記録もアプリごとに持つ）。

確認項目（認証に関係する範囲）:

1. `pnpm check`・`pnpm build`・`pnpm dev`。**demo 用の `AuthProvider` を持つアプリは、dev 起動で白画面にならないこと**
   （3 メソッドが無いと `initBanto` が `TypeError`）。
2. ログイン・ログアウト（ログアウト後に /login へ移る。確認できない場合はエラーが通知される）。
3. 別タブでのログイン・ログアウト（保護レイアウトの作り直し、ユーザー切り替えの通知）。
4. バックエンドを止めた状態の 503 画面と「再試行」。
5. ログイン不要モード（Tauri）を使うアプリは、有効・無効の切り替え。
6. 同期記録に、取り込んだ手順（1〜7）を書く。途中なら残りも書く。

### 例 3: v2.1.x → v3.0.0（grant への一本化。A と B がセット・破壊的変更）

v3.0.0 は「資格情報なしのセッション発行」を **grant** に一本化し（[ADR-0017](adr/0017-credential-less-grant.md)）、
閲覧公開専用の API・URL・フィールド（`POST /api/auth/public-viewer`、`status.viewerPublic`、`identity.publicViewer`、
`issue_public_viewer_token` など）と `SessionController.adopt()`/`end()` を**削除**する破壊的変更。閲覧公開は grant の
1 種類目（kind `publicViewer`）になり、派生アプリの試運転（banto-hub）は 2 種類目（アプリが登録する kind）になる。
削除した名前と移行先の表は CHANGELOG の v3.0.0 節が正。ここには**取り込みの組み立て**だけを書く。

| 経路 | 項目                                                                                                    | 取り込み                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `banto-server`・`banto-admin-services`・`@banto/admin-core` を v3.0.0 へ                                | 他の `@banto/*`・`banto-*` も同じタグへ。`AuthenticatedSession { public_viewer }`・`issue_public_viewer_token`・`extra_auth_router` の旧シグネチャ・`delete_user(id, i64)`・`publicViewerFallback`・`enterPublicViewer`・`identity.publicViewer`・`adopt()`/`end()` の呼び出しが型エラーになる                                                              |
| B    | コピーした `core/src/rest.rs`（`extra_auth_router` 相当）                                               | `GrantRegistry` を組み立てて `GrantSpec::public_viewer(settings)` を登録し、新シグネチャに渡す。自分で status を持つなら `GrantRegistry::availability(peer)` を `grants` として載せ、`grant_router(auth, registry)` を merge する。手本: `apps/admin-template/core/src/rest/mod.rs`                                                                         |
| B    | `users_delete`（REST・Tauri）                                                                           | 検証済み grant セッション（`AuthenticatedSession.grant.is_some()`）なら acting id を `None`、それ以外は従来どおり行 id。手本: `banto_server::routes::users`・`src-tauri/src/lib.rs` の `users_delete_body`                                                                                                                                                  |
| B    | 条件を閉じる処理（閲覧公開 OFF の保存関数、試運転のロックダウン）                                       | 「条件の保存 → **同じ関数内で直後に** `revoke_grant_tokens(&kind)`」の順。戻り値を監査の `detail` に `revokedGrants: n` として足せる。手本: `save_server_config_locked`                                                                                                                                                                                     |
| B    | `src/routes/(app)/+layout.ts`・`src/routes/login/+page.svelte`・`src/lib/session.svelte.ts`・ログアウト | `publicViewerFallback(controller, provider, ticket)` → `grantFallback(controller, provider, ticket, { kind: 'publicViewer' })`、`status?.viewerPublic` → `status?.grants?.publicViewer === true`、`identity.publicViewer` → `snapshot.kind === 'publicViewer'`。自前の `AuthProvider` は `enterGrant`・`status().grants` を実装する                         |
| B    | 試運転を `adopt()`/`end()` で確定していたアプリ（banto-hub）                                            | policy runner を捨て、サーバーに試運転の `GrantSpec`（kind `commissioning`、admin 固定 identity、条件 = 未ロックダウン、`require_loopback_peer: true`、小さい `max_sessions`）を登録し、`grantFallback(…, { kind: 'commissioning' })` を `none` の後に置く。ロックダウン後は次の要求が 401 → `none`。ADR-0017「v3.0.0 への移行手順」の banto-hub の項を参照 |
| B    | `e2e/`・`scripts/verify-architecture.mjs`                                                               | 閲覧公開の e2e は新 URL と `kind`/`grants` に。rule 8 の `REST_ONLY` は `POST /api/auth/grant/{kind}`                                                                                                                                                                                                                                                       |
| C    | DB・設定・配布資産                                                                                      | 変更なし（マイグレーション不要。`server.viewer_public` は閲覧公開の条件として残る）                                                                                                                                                                                                                                                                         |

進め方:

1. 先に**候補版のコミット参照で検証**する（例 2 と同じ）。A を上げて型エラーを一覧にし、CHANGELOG の表で移行先を引く。
2. B は「サーバー（`rest.rs` の registry と `grant_router`、`users_delete`、ロックダウンの順序）→ 画面（`+layout.ts`・ログイン・
   `session.svelte.ts`）→ e2e」の順。複数アプリ（banto-hub・chronogazer）は **1 アプリずつ**。
3. 試運転を grant にするアプリは、ADR-0017 が必須にしている**統合テスト**（`enabled()` が true を返した発行要求を保留 →
   ロックダウン完了 → 再開で 403、直後の `GET /api/auth/identity` が `200 null`（認証が必要なリソースへの要求は 401）、開いていたストリームが再検証で閉じる）を
   移行 PR に入れる。

確認項目（認証に関係する範囲）:

1. `pnpm check`・`pnpm build`・`pnpm dev`、`cargo check`・`cargo test`。
2. 閲覧公開 ON/OFF: ON で LAN ブラウザが `/dashboard` に合成 viewer で入り、`GET /api/auth/identity` が `kind: "publicViewer"` を返す。
   OFF にした直後に、開いていた閲覧公開の画面が /login へ戻る（トークンが失効する）。
3. `GET /api/auth/status` の `grants` が、その端末に発行できる kind だけ `true`。
4. 試運転を grant にしたアプリ: ロックダウン → 直後の要求が 401 → 画面が /login（または通常ログイン）へ。再試運転で再発行できる。
   LAN の端末から `/api/auth/grant/commissioning` が 403 になる（`require_loopback_peer`）。
5. リバースプロキシ配下で運用するアプリは、外部公開の前にロックダウンし、`/api/auth/grant/{kind}` をプロキシの外へ出さない
   （ADR-0017 §6。技術的には防げないので運用手順に書く）。
6. 同期記録に「v3.0.0 grant 取込済（PR 番号）」を書く。

### 例 4: v3.0.x → v4.0.0（SvelteKit 3 / TypeScript 6。B が中心・破壊的変更）

v4.0.0 はテンプレートを SvelteKit 3（`@sveltejs/kit` 3.0・`@sveltejs/adapter-static` 4.0）と TypeScript 6（`^6.0.0`。
7 は kit 3 の対象外）に上げる**破壊的変更**（#325）。変わるのはほぼ B（コピーしたテンプレート）で、A の `@banto/*`・
`banto-*` は API の変更が無い。項目の一覧は CHANGELOG の v4.0.0 節が正。ここには**取り込みの組み立て**だけを書く。

| 経路 | 項目                                                | 取り込み                                                                                                                                                                                                                                                                       |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A    | `@banto/*`・`banto-*` を v4.0.0 へ                  | タグを上げるだけ（API の変更は無い）。`@banto/theme/css` に型が付いたので、TS から `import '@banto/theme/css'` するために自前で置いた `declare module '@banto/theme/css'` は外してよい（残っていても害は無い）。型の解決は `moduleResolution: "bundler"`（kit 3 の既定）が前提 |
| B    | 依存（`package.json`）                              | `@sveltejs/kit` `^3.0.0`・`@sveltejs/adapter-static` `^4.0.0`・`typescript` `^6.0.0`。Svelte・Vite・vite-plugin-svelte はこの版の `apps/admin-template/package.json` に揃える                                                                                                  |
| B    | 設定（`svelte.config.js` → `vite.config.ts`）       | `svelte.config.js` を廃止し、`kit` の設定（adapter・`paths.base`・preprocess）を `vite.config.ts` の `sveltekit({...})` に移す。手本: この版の `apps/admin-template/vite.config.ts`                                                                                            |
| B    | `tsconfig.json`・`package.json` の `imports`        | `tsconfig.json` は `"extends": "$app/tsconfig"`。`package.json` に `"imports": { "#lib": "./src/lib/index.js", "#lib/*": "./src/lib/*" }`。`process` や `node:*` を使う設定ファイルがあれば `types` に `node` を足すか、そのファイルの中だけで宣言する                         |
| B    | `$lib` → `#lib`（全ファイル）                       | `#lib` は Node の subpath import なので**拡張子が必須**（`#lib/banto/setup.js`、`#lib/paraglide/messages.js`。`.svelte` はそのまま）                                                                                                                                           |
| B    | `base` → `resolve()`、`navigation.ts` の `AppPath`  | ナビ・設定カテゴリの表の `path` は `AppPath`（`` `/${Path}` ``）、URL にするときは `resolveAppPath()`（`src/lib/navigation.ts`）。手本: この版の `navigation.ts`・`settings/categories.ts`                                                                                     |
| B    | ガード（`(app)/+layout.ts` の閲覧公開の許可リスト） | `url.pathname` と、各項目を `resolveAppPath()` で解決したパスとを比べる形を写す（下の「必ず見直すもの」）                                                                                                                                                                      |
| B    | 非推奨の API                                        | `invalidateAll()` → `refreshAll()`（`page.state` を消さない点だけが違う）、`error(status, { message, … })` → `error(status, message, { … })`                                                                                                                                   |
| B    | `scripts/`（scaffold を再実行する派生のみ）         | この版の `scripts/scaffold.mjs` と `scripts/lib/`（パターンが `#lib` の書き方になった）                                                                                                                                                                                        |
| C    | DB・設定・配布資産                                  | 変更なし（マイグレーション不要）                                                                                                                                                                                                                                               |

進め方:

1. 先に**候補版のコミット参照で検証**する（例 2 と同じ）。A を上げるだけなら型エラーは出ない。
2. B は公式の自動移行を流してから、この版のテンプレートと突き合わせる:

   ```sh
   # 派生リポジトリのテンプレート部分（vite.config.ts のあるディレクトリ）で
   npx sv migrate sveltekit-3 --tasks all --confirm
   ```

   自動移行は `svelte.config.js` の統合・`$lib` → `#lib`・`base` → `resolve()` の大半を書き換え、手で直す箇所を
   TODO として出す。そのうえで、この版の `vite.config.ts`・`tsconfig.json`・`package.json` の `imports`・
   `navigation.ts` の `AppPath` / `resolveAppPath`・`(app)/+layout.ts` のガードを写す。

3. **自動移行の出力で必ず見直すもの**（Banto の移行で実際に踏んだ）:
   - **`resolve('')`**: `url.pathname.startsWith(base) ? … slice(base.length)` のような「base を外す」処理は
     `resolve('')` に書き換えられる。kit 3 の `resolve('')` は `base + '/'` を返すので、先頭の `/` まで削られる。
     Banto ではこれで閲覧公開のガードがどの画面にも一致せず、最初の項目へ戻されてループした（500）。
     `url.pathname` と `resolveAppPath()` の結果を比べる形に直す。
   - **``resolve(`${path}`.slice(1))``**: 表の `path` を URL にする箇所に入る。`resolveAppPath()` に置き換え、
     `path` を `AppPath` で型付けする（存在しないルートが型エラーになる）。
   - **`resolve('login/')` など末尾の `/`**: 比較は `resolve('login')` と `` `${login}/` `` にする。
   - 残りの `resolve(...)` は、元の `${base}/...` と同じ URL になるかを 1 件ずつ確かめる（`BASE_PATH` を付けた
     ビルドで開くと確かめやすい）。
   - `#lib` の import に拡張子が付いているか（paraglide の生成物への import も `.js` が要る）。
4. #326 の `navigationSettled.svelte.ts`（ナビゲーションの途中では再 load を始めない）と #321 の起動待ちのやり直しは
   kit 3 でも残す。`refreshAll()` に変えても同じ条件で待つ。
5. 複数アプリ（banto-hub・chronogazer）は **1 アプリずつ**。

確認項目:

1. `pnpm check`（TS 6）・`pnpm build`・`pnpm dev`、`cargo check`・`cargo test`。
2. `BASE_PATH` を使うアプリは、その値でビルドしてリンクがすべて base 付きになること。
3. 閲覧公開を使うアプリは、閲覧公開で許可した画面が開き、許可していない画面が先頭の項目へ戻ること（ループしない）。
4. 起動前に保護画面を直接開く（スプラッシュ → 起動後に同じ URL が開く）、別タブでのログイン中の移動（移動が完了し、
   未保存の確認が出る）。
5. 同期記録に「v4.0.0 SvelteKit 3 取込済（PR 番号）」を書く。

### 例 5: v6.7.x → v6.8.0（共有部品の追加。A が中心・破壊的変更なし）

Issue #432〜#438（temp-scada からの共有部品の還元。計画は
[design/shared-primitives-upstream-plan.md](design/shared-primitives-upstream-plan.md)）で、`@banto/*` に部品が増える。
**v6.8.0** で出した。項目の全量は CHANGELOG の 6.8.0 の節（ドック・シェルと設定の UI の変更・起動時のポートの自動選択も同じ版に入っている）。
ここには取り込みの組み立てだけを書く。

**破壊的変更は無い**（公開 API の削除・改名なし。既存のオプションは従来どおり）。ただし**挙動が変わる箇所が 3 つ**ある。
`@banto/dock-svelte` を使う派生アプリは、A を上げたあとに確かめる:

- **復元 layout の検証**（#434）: `DockState` の `hydrate` と constructor の初期値が、不正な layout（重複 ID・`x=1e999`・
  `width=-1`・`height=0` など）を拒否する。従来は通っていた壊れた保存データが読めなくなる（正常な v1 / v2 は従来どおり）。
  `hydrate` の戻り値が `void` → `boolean`（採用されたか）。戻り値を使わない呼び出しはそのまま動く。
- **操作の確定**（#433）: ドラッグは、操作を始めた pointer の `pointerup` でだけ確定する。resize・divider も Esc・
  `pointercancel`・window の `blur` などで取り消される（取消は対象の window / split だけを戻す）。これらのイベントに
  依存した独自の操作やテストは見直す。
- **IME 変換中の構造変更**（#432）: props を渡さなくても、`DockHost` は IME 変換中（pane の中の入力で
  `compositionstart` 〜 `compositionend`）にドラッグを始めず、dock / undock / タブの切り替えなどの構造変更を
  `compositionend` まで保留する（見た目は変わらない）。変換中の操作に依存した独自の処理や E2E は見直す。

| 経路 | 項目                                                    | 取り込み                                                                                                                                                                                      |
| ---- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `@banto/*`・`banto-*` を v6.8.0 へ                      | タグを上げるだけで、既存の挙動は保たれる（上の 3 点を除く）。新しい部品は**使うときだけ**取り込む                                                                                             |
| A    | `@banto/admin-core`（#436・#437）                       | `createRequestOwner`（古い非同期結果の不採用と一時資源の解放）、`createSavedSetting`（現在値と保存に成功した snapshot を分ける UI 設定）。どちらも追加のみ                                    |
| A    | `@banto/forms`（#432）                                  | `createFormDraft` / `DraftCoordinator`（pane より長生きする未適用入力）、`DraftNumberField`。既存の `NumberField` は変えていない                                                              |
| A    | `@banto/dock-svelte`（#432〜#434）                      | `DockHost` の `beforePanelChange`（pane の lifecycle）・`clamp` / `narrowHost`（縮小時の到達性）・`capabilities`（close / move / undock の制限）。キーボード操作と divider の ARIA は自動で入る |
| A    | `@banto/ui`（#433・#435）                               | `CommandSpec`・`createShortcutDispatcher` / `shouldHandleShortcut` / `formatShortcut`（ショートカットの保護）。追加のみ                                                                        |
| A    | `@banto/image-assets`（#438。新しいオプションのパッケージ） | 使うアプリだけ依存に足す。**`.svelte.ts` を含むので `optimizeDeps.exclude` に足す**（下）。使い方は [recipes/image-assets.md](recipes/image-assets.md)                                         |
| B    | コピーしたテンプレート                                  | 取り込みは任意。ダッシュボードのメモ pane の draft 化（#432）、Ctrl+K / Ctrl+S の配線（#435、`#lib/shortcuts.ts`）、ドックの設定（#437）。差分を読んで写す                                     |
| C    | DB・設定・配布資産                                      | 変更なし（マイグレーション不要）                                                                                                                                                              |

進め方:

1. A のタグを上げ、`pnpm check` と dock の画面（保存済みの layout が読めること、ドラッグ・resize）を確かめる。
2. 新しい部品は、**そのパッケージの README を正**として、必要なものだけ取り込む。使わない部品は何もしなくてよい。
3. `@banto/image-assets` を使うアプリは、依存に足し（`github:tyaro/banto#v6.8.0&path:packages/image-assets`）、
   `vite.config.ts` の `optimizeDeps.exclude` に `@banto/image-assets` を加える（足さないと dev が 500 になる。3.1・
   [conventions §14](conventions.md)）。`pnpm build` と `pnpm check` はこの経路を通らないので、dev で画面を開いて確かめる。
4. 派生側に同じ処理を自作していた（draft・request owner・ショートカットの保護・画像の取込）場合も、置き換えは**任意**。
   置き換えるなら 1 つずつ、各 README の約束と突き合わせる。

確認項目:

1. `pnpm check`・`pnpm build`・`pnpm dev`（image-assets を入れたアプリは dev で画面を開く）。
2. dock を使うアプリは、保存済みの layout が復元されること（拒否されたら現行の layout のまま。空にならないこと）。
3. 同期記録に「共有部品（#432〜#438）取込済・使った部品」を書く。
