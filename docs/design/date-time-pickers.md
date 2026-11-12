# 日付・時刻ピッカーの設計（日付・時刻・日時・期間）

作成日: 2026-11-07
状態: **完了**。§7 の D1〜D17 は推奨 a で合意（2026-11-07）。PR-1（ui: `datetime.ts`・位置決めの切り出し・`DateInput`・`UiMessages`・ui-demo）完了（#520）。PR-2（ui: `TimeInput`・時刻の解析と刻み）完了（#522）。PR-3（forms への組み込み）完了（#523）。PR-4（grid への組み込み）完了（#527）。PR-5（時刻・日時の型・`DateTimeInput`・banto-core の検証関数）完了（#530）。PR-6（期間: `DateRangeInput`・`FilterOp::between`・FilterPopover、#532）で全 PR が揃い、本書の範囲は**完了**（§8 の未確認の点のうち実機に関わるものは残る）。
トラック: 保守者向け（トラックA）
関連: [conventions](../conventions.md) §3（依存を足さない）・§4／§5（パッケージ間の import 禁止）・§9（寸法トークン）・
§13（文言はキー経由）/ [ADR-0018](../adr/0018-shared-ui-package.md)（`@banto/ui`）/
[ADR-0026](../adr/0026-shared-boolean-controls.md)（共通部品の前例）/
[shared-primitives-upstream-plan.md](shared-primitives-upstream-plan.md) §2.1（パッケージをまたぐ部品の渡し方の前例）/
[theme-dimension-tokens.md](theme-dimension-tokens.md)（書式の手本）

コードの位置は main `075a842` 時点。

## 1. 経緯

日付の入力は `@banto/forms` の `DateField` と `@banto/grid-svelte` のセル編集の両方が `<input type="date">` の
ままで、時刻・日時・期間の入力は無い。ネイティブの date 入力は WebView（WebView2・WebKitGTK・WKWebView）と
LAN から開くブラウザで見た目・操作・表示の書式がばらばらで、テーマトークンも `UiMessages` の文言も効かない。

オーナーとは次のことを合意している（2026-11）:

- 部品は `@banto/ui` に置き、`@banto/forms` のフィールドと `@banto/grid-svelte` のセル編集の両方で使う。
- 形は「キーボードで直接打てる入力欄 ＋ 横のボタンでポップオーバー（カレンダー／時刻の一覧）を開く」。
- 範囲は 4 つすべて: 日付（YYYY-MM-DD、既存の date 型を置き換え）、時刻（HH:mm、刻み指定）、
  日時（日付＋時刻、新しい型）、期間（開始～終了。一覧の絞り込みなど）。
- 設計書を先に書いて合意し、PR を分けて実装する。

## 2. 現状

### 2.1 forms

- `FieldType` は `'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox' | 'password'`
  （`packages/forms/src/types.ts`）。`min` / `max` は `number` のみ（number は値、文字列は長さ）。
- `BantoForm.svelte` の `fieldComponent(def)` が型ごとに部品を選び、`date` は `fields/DateField.svelte`
  （`<input type="date">`、値は `YYYY-MM-DD`、入力のたびに `onInput(value)`、消すと `''`）。
- `validate.ts` の `validateField` は date の形式を検査しない（`required` と `validate` だけ）。
- `draft.svelte.ts` の `FormDraft` は打ちかけの文字列を `raw` に持ち、`commit(field)`（blur・Enter）で
  `parse(def, text)` → `validateField` を通ったときだけ `values` に入れる。今は number だけが `raw` を使う
  （`DraftNumberField`）。

### 2.2 grid-svelte

- `core/schema.ts` は forms の型の**構造的な鏡像**（パッケージ間 import をしないため手で同期する）。
  `EDITOR_BY_TYPE` で `date → 'date'`、`FILTER_BY_TYPE` は text・textarea・number だけ（date は既定で絞り込み不可）。
  `fieldValidator` は forms の `validateField` と同じ規則・文言を鏡像で持つ。
- `CellEditor.svelte` は見た目だけで、`date` は `<input type="date">`。編集の状態遷移は `BantoGrid.svelte` が持つ:
  - `handleEditorKeydown`: すべてのキーの伝播を止める。`event.defaultPrevented`・IME 変換中は何もしない。
    Esc = 取り消してコンテナにフォーカス、Enter = 確定して下へ、Tab = 確定して左右へ（エラー中はエラー表示へ）。
  - `handleEditorBlur`: フォーカスの行き先（`relatedTarget`）がエラー表示の中でなければ確定する。
  - `commitFromEditor`: `parseCellInput(draft, editorType)` を通す。`date` は文字列を素通しする（`core/clipboard.ts`）。
- 絞り込み: `FilterType = 'text' | 'number'`。`FilterState`（`types.ts`）と `FilterOp` は
  `crates/banto-core/src/params.rs` の鏡像で、1 つの列に 1 つの条件（`state.svelte.ts` の `setFilter` は列で置き換える）。
  クライアント側の比較 `core/filter.ts` の `toComparable` は文字列を `Date.parse` する
  （`YYYY-MM-DD` は UTC、`YYYY-MM-DDTHH:mm` はローカル時刻として解釈されるので、型が混ざると比較がずれる）。
- 並べ替え `core/sort.ts` は文字列を `localeCompare`。CSV の取り込みは `core/csv.ts` の `convertCsvRow`。

### 2.3 ui

- `Menu.svelte` はネイティブの Popover API（`popover="auto"`）で、開くときに起点の `getBoundingClientRect()` から
  `position: fixed` の位置を計算し、上下の反転・横のはみ出し防止・祖先のスクロールで閉じる、を自前で持つ。
- `layering.ts` が Esc とフォーカスの規則（上の層から 1 枚ずつ閉じる・消費した Esc に譲る・`aria-modal` は
  フォーカスを閉じ込める `attachFocusTrap`・開いた元へ戻す `restoreFocus`）を一本化している。
- 文言は `messages.ts` の `UiMessages`（`messages?: UiMessages` で差し替え。既定は日本語）。

### 2.4 Rust・DB・CSV・scaffold

- Rust 側には汎用の「フィールドの型」は無い。検証はリソースごとの手書き（例: app の `core/src/items.rs` の
  `validate_item_input` が forms の `validateAll` の鏡像）。日付を検証している場所はまだ無い。
- 日時の文字列変換は `banto-core::datetime` の 1 か所が `chrono` で行う（conventions §3 の表・ADR-0029。手書きの `civil_from_days` は無い）。
- `items.updated_at` は SQLite・PostgreSQL とも **TEXT** の `YYYY-MM-DD`（Rust の `local_today()` が求めたローカル日付をパラメータで束縛。PR #533 より前は `date('now')` /
  `CURRENT_DATE::text`）。forms 側は `type: 'date', readonly: true`。
- 絞り込みの SQL は `crates/banto-storage/src/list_query.rs`（`FilterOp` ごとに `push_binop`。値は文字列か数値で束縛）。
- `scripts/scaffold.mjs` はフィールドの型を生成しない。items のデモを外すプリセットがあるので、デモに列を
  足すときだけ影響する。

### 2.5 一番効く制約: パッケージ間の import 禁止

`packages/*` の `dependencies` / `peerDependencies` は空で（rule `empty-deps`）、`packages/*/src` の素の import は
`svelte` と相対パスだけ（rule `package-bare-imports`）。**forms と grid-svelte は `@banto/ui` を import できない。**
「ui に置いて forms と grid の両方で使う」は、shared-primitives-upstream-plan §2.1 と同じく
**アプリが両者をつなぐ**形でしか実現できない（D1）。

## 3. 範囲

| 部品 | 値 | ポップオーバー | 使う場所 |
| --- | --- | --- | --- |
| `DateInput` | `YYYY-MM-DD` | 月のカレンダー（APG の date picker dialog） | forms `date`、grid の `date` セル |
| `TimeInput` | `HH:mm` | 時刻の一覧（刻みごと。APG の combobox ＋ listbox） | forms `time`（新）、grid の `time` セル |
| `DateTimeInput` | `YYYY-MM-DDTHH:mm` | カレンダー ＋ 時刻の一覧を 1 枚に | forms `datetime`（新）、grid の `datetime` セル |
| `DateRangeInput` | `{ from, to }`（片側だけ可） | 開始・終了それぞれの `DateInput` | grid の絞り込み、アプリの一覧の絞り込み |

範囲外: 秒・ミリ秒、タイムゾーンの選択、祝日の表示、週番号、和暦の入力、繰り返しの予定。

## 4. 選択肢

### 4.1 作り方

- **A. 自作（推奨）**: カレンダーの計算は整数の暦計算（`days_from_civil` / `civil_from_days` の TS 版）で持ち、
  月名・曜日名・読み上げ用の日付は `Intl.DateTimeFormat` に任せる。位置決めは `Menu` のものを ui の中で共通化する。
- **B. 依存を足す**（日付ライブラリ・headless UI のピッカー）: conventions §3 の「日時はエッジケースが多い」には
  当たるが、`empty-deps` と `package-bare-imports` で packages には入れられず、入れるなら §4 の不変条件の変更になる。
  タイムゾーンを持たない暦の計算は小さく、難しいのは a11y とキー操作のほうで、そこはどのみち grid の状態遷移に
  合わせて自前で書く必要がある。
- **C. ネイティブ input のまま**: 何も足さない。見た目・書式・文言・刻みの表示がブラウザ任せのまま。
  時刻の刻みは `step` 属性で検証はできるが一覧は出ない。合意した形（入力欄 ＋ ボタン）にならない。

### 4.2 forms と grid への渡し方（D1）

- **a. アプリが注入する（推奨）**: forms と grid-svelte は「この props を受け取る部品」という**構造的な契約**だけを
  持ち、アプリが `@banto/ui` の部品を Svelte の context（各パッケージが出す `provide…` 関数）で渡す。
  渡されなければ今のネイティブ input に戻る。型の一致はアプリのコンパイルで確かめられる
  （TypeScript の構造的な型付け）。
- **b. forms・grid から ui を import できるようにする**: §4 の不変条件と派生アプリの Git 依存の入れ方を変える。
  shared-primitives-upstream-plan D1 で採らなかった案。
- **c. 部品を各パッケージに複製する**: 同じものを 2 つ保守することになる。

### 4.3 日時を 1 部品にするか 2 部品にするか（D5）

- **a. 入力欄 1 つ ＋ ポップオーバー 1 枚（推奨）**: 入力欄は `YYYY-MM-DD HH:mm` を打つ 1 つ。ポップオーバーは
  カレンダーと時刻の一覧を並べる（中身は DateInput・TimeInput と同じ内部部品）。
- **b. DateInput と TimeInput を並べる**: forms ではきれいだが、grid のセル編集では Tab が「確定して右のセルへ」
  なので、2 つの入力欄の間を Tab で移れない。セルの幅にも収まりにくい。

### 比較

| 観点 | A 自作 | B 依存 | C ネイティブ |
| --- | --- | --- | --- |
| 不変条件（§3・§4） | 変えない | 変える | 変えない |
| 見た目・トークン・文言 | 揃う | ライブラリ次第 | 揃わない |
| grid の状態遷移との整合 | 合わせて作れる | 包み直しが要る | 今のまま（ただし時刻・期間が無い） |
| 実装量 | 大（ui に 1,000 行前後の見込み） | 中（包む層と a11y の補い） | 無 |
| 保守 | 自前（暦の計算は小さく安定） | 追従が要る | 無 |

### 推奨: A（自作）＋ 4.2 の a（注入）＋ 4.3 の a（日時は 1 部品）

ネイティブ input は「注入されないときのフォールバック」として forms と grid に残す（D3）。テンプレートのアプリは
既定で注入するので、利用者から見ると date 型はピッカーに置き換わる。

## 5. 推奨案の具体

### 5.1 値の表現

| 型 | 正規の文字列 | 補足 |
| --- | --- | --- |
| 日付 | `YYYY-MM-DD` | 0001〜9999 年。今の date 型と同じ |
| 時刻 | `HH:mm`（00:00〜23:59、24 時間） | 秒は持たない |
| 日時 | `YYYY-MM-DDTHH:mm` | **タイムゾーンを持たない壁時計の時刻**（`datetime-local` の値と同じ形）。区切りは `T` |
| 期間 | `{ from: string \| null, to: string \| null }` | 各端は日付か日時。片側が `null` なら片側だけの期間 |
| 空 | `null` | `''` も空として扱う（`isEmpty` と同じ）が、部品が出すのは `null`（D6） |

- **タイムゾーン（D4）**: 日時は「その現場の時計で何時何分」を表す。工場・事務所の LAN で使う管理画面では、
  入力した人と見る人が同じ地域にいる前提が自然で、UTC に直すと日付の境目（日本時間の 0〜9 時）で一覧の絞り込みが
  ずれる。瞬間（UTC）を扱う型が要るときは別の型として足す（`datetime` の意味は変えない）。
  DB が打つ時刻（SQLite の `datetime('now')` = UTC・区切りが空白）はこの型ではなく、表示専用の列として扱う。
- 固定幅の文字列なので、**文字列の大小 = 時刻の前後**になる。並べ替え・絞り込み・SQL はすべて文字列の比較で揃える
  （`Date.parse` は使わない。§2.2 の UTC／ローカルのずれを避ける）。
- DB の列は SQLite・PostgreSQL とも TEXT（D16）。PostgreSQL の `DATE` / `TIMESTAMP` を sqlx で読むには chrono か
  time の feature が要り、§3 に当たる。`items.updated_at` も TEXT で前例がある。

### 5.2 部品と props（`@banto/ui`）

共通の props（4 部品で同じ名前を使う）:

- `value: string | null`、`onValueChange(value: string | null)`
- `text?: string`、`onTextInput?(text: string)` — 打ちかけの文字列を親が持つとき（forms の draft、grid の draft）。
  渡されなければ部品の中で持つ。
- `id`・`label`（`aria-label`）・`describedBy`・`invalid`・`disabled`・`readonly`
- `min?` / `max?`（正規の文字列）、`isDateDisabled?(date: string) => boolean`、`step?`（分、TimeInput・DateTimeInput）
- `locale?`（BCP 47、既定 `'ja-JP'`）、`weekStartsOn?`（0〜6）、`messages?: UiMessages`
- `onkeydown?`・`onblur?` — 部品の中で処理しなかったキーと、**部品全体（入力欄・ボタン・ポップオーバー）から
  フォーカスが出たとき**だけの blur。grid はこの 2 つで今の状態遷移をそのまま使える（§5.7）。
- `inputEl`（bindable） — grid がフォーカスを戻す先。

中身:

- `ui/src/datetime.ts`（Svelte 非依存の純粋関数）: 解析・正規化・暦の計算・月のマス目の生成・刻みの一覧・
  `Intl` による名前。単体テストの主な対象。
- 位置決めは `Menu.svelte` から ui の内部モジュールに切り出して共有する（Menu の挙動は変えない）。
  ポップオーバーは Popover API の top layer に出し、grid のセルの `overflow` に切られないようにする。
- 寸法は §9 の段階トークン（`--banto-space-*`・`--banto-font-size-*`・`--banto-border-width`）。
  カレンダーのマスの大きさ・ポップオーバーの幅は部品の形なので、部品ローカルのカスタムプロパティにする。
  forced-colors・`prefers-reduced-motion`・文字 200%・幅 320px を確かめる（ADR-0026 と同じ確認項目）。
- 入力欄の幅は公開の調整点（CSS カスタムプロパティ）: DateInput `--banto-date-input-width`（既定 11em）、TimeInput
  `--banto-time-input-width`（7.5em）、DateTimeInput `--banto-datetime-input-width`（15em）。DateRangeInput は中の
  DateInput 2 つの幅（`--banto-date-input-width`）に従い、狭いと折り返す。grid のセル編集（`.cell-editor-host`）は 3 つとも
  `100%` にしてセル幅に合わせ、高さも行の内側（行の下罫線 1px を引いた値）に収まるよう `--banto-control-height` を上書きする
  （部品は grid を知らない。下限は `--banto-control-height-sm`）。

### 5.3 手入力の解析と検証

- 受け付ける形（D7）: 日付は `YYYY-MM-DD`・`YYYY/MM/DD`・`YYYY.MM.DD`・`YYYYMMDD`（月・日は 1 桁も可）、
  手入力に限り年を省いた `M/D`・`M-D`（今年）。時刻は `H:mm`・`HHmm`・`Hmm`・`H`（`9` → `09:00`）。日時は
  日付と時刻を空白か `T` でつないだもの。全角の数字・記号は NFKC で半角にしてから解析する（IME で打った
  `２０２６／１１／７` も通す）。**年・月・日の順以外（`MM/DD/YYYY` など）は受け付けない** — ロケールで意味が
  変わる書式は、表示を ISO に固定することで避ける。
- 表示は全ロケールで正規の形（`2026-11-07`、`2026-11-07 09:30`）。日時は表示と入力で空白区切り、値は `T`。
- 打ちかけの値: 入力中は値を変えない。blur か Enter（ポップオーバーが閉じているとき）で解析し、
  通れば入力欄を正規の形に直して `onValueChange`、通らなければ文字列を残して親に伝える。
- forms: `validateField` に date・time・datetime の形式の検査と、`min`・`max`（文字列の比較）・`isDateDisabled`・
  `step` の検査を足す。FormStore の経路では、解析できない文字列はそのまま値として持ち、形式の検査で
  エラーにする（**古い値が黙って送信されることを防ぐ**）。FormDraft の経路では `raw` に持ち、`commit` の
  `parse(def, text)` に date・time・datetime の正規化を足す（number と同じ流れ）。
- grid: `parseCellInput` の date・time・datetime を素通しから正規化に変える。失敗は今と同じ `inlineEditInvalid`。
  `schema.ts` の `fieldValidator` は forms の検査の鏡像として同時に直す。
- Rust: `banto-core` に純粋関数（`YYYY-MM-DD`・`HH:mm`・`YYYY-MM-DDTHH:mm` の形式と暦の妥当性、うるう年）を
  置き、リソースごとの検証から呼ぶ。Rust は**正規の形だけ**を受け付ける（寛容な解析は UI と CSV 取り込みの役目）。
  日数への変換は要らないので、暦の計算を自前で足すことにはならない。

### 5.4 a11y（WAI-ARIA APG）

日付（APG の Date Picker Dialog）:

- 入力欄は普通の `textbox`。`aria-describedby` に書式の案内（`YYYY-MM-DD`、文言は `UiMessages`）。
- 横のボタン: `aria-haspopup="dialog"`・`aria-expanded`。名前は値が無いとき「日付を選択」、あるとき
  「日付を変更、2026年11月7日 土曜日」（日付は `Intl` の `dateStyle: 'full'`）。
- ポップオーバー: `role="dialog"`・`aria-modal="true"`・`aria-label`。`attachFocusTrap` でフォーカスを閉じ込め、
  Esc は `layering.ts` の規則（消費した Esc に譲る、上に層があれば譲る）に従う。受け口は 2 つで、閉じる処理は
  1 つの関数 `closeOnEscape(event)`（`defaultPrevented` か `hasVisibleLayerAbove({ except: panel })` なら何もしない。
  それ以外は `preventDefault` → 閉じる → 入力欄へフォーカスを戻す）にまとめる:
  - **ポップオーバーの `keydown`**（フォーカスが中にあるとき）: §5.8 の約束 1 で伝播を止める**前に**
    `closeOnEscape` を呼ぶ。伝播を止めるので window の受け口には届かず、二重には閉じない。
  - **window の `keydown`**（規則 3。フォーカスが何かの拍子に外へ出たとき）: 同じ `closeOnEscape` を呼ぶ。
    フォーカスがポップオーバーの中にあるときのキーはここに届かないので、この受け口は外にあるときだけ働く。
  - 捕獲（capture）の段階の window の受け口は使わない。捕獲は Modal・Drawer の bubble の受け口より先に走り、
    「上の層から 1 枚ずつ」の順序を `hasVisibleLayerAbove` だけに頼ることになるため。
- 見出し（「2026年11月」）は `aria-live="polite"`。前年・前月・翌月・翌年のボタン。
- マス目は `role="grid"`（`aria-labelledby` = 見出し）、曜日の列見出しは短い名前を表示し `abbr` に長い名前。
  日のマスは roving tabindex（タブで入るのは 1 マス）、`aria-selected`、今日は `aria-current="date"`、
  選べない日は `aria-disabled="true"`（フォーカスは移せる）。読み上げの名前は長い日付。
- キー: 矢印 = 前後の日・週、Home／End = 週の頭・終わり、PageUp／PageDown = 前後の月、
  Shift+PageUp／PageDown = 前後の年、Enter／Space = 選ぶ、Esc = 閉じる。入力欄で Alt+↓ でも開く。
- 開いたときのフォーカス: 値の日 → 無ければ今日 → `min`・`max` の中へ寄せた日。
- 閉じたときのフォーカス: **入力欄に戻す**（D10。APG の例はボタンに戻すが、grid では入力欄が編集の主体なので、
  forms と揃えて入力欄にする）。

時刻（APG の combobox ＋ listbox）:

- 入力欄が `role="combobox"`（`aria-autocomplete="none"`・`aria-expanded`・`aria-controls`）。一覧は `role="listbox"`、
  項目は `role="option"`。**フォーカスは入力欄に残したまま** `aria-activedescendant` で項目を指す
  （一覧を開いても blur が起きないので grid の状態遷移とぶつからない）。
- ↓／Alt+↓ = 開く・次へ、↑ = 前へ、Enter = 選んで閉じる（入力欄の値を置き換える）、Esc = 閉じる。
  横のボタンは一覧の開け閉めだけ（`tabindex="-1"`、マウス用）。
- 開いたときは値に一番近い刻みの項目を指してスクロールする。値が空のときは**今の時刻**に一番近い項目（刻み・
  min / max の範囲に収める）を指してスクロールする。指すだけで値は変えない（選ぶのは Enter / クリック）。
  「今」は端末の時計（`currentTime()`、テストは fake timers で固定する）。

日時は日付のダイアログの中に時刻の listbox を並べる（ダイアログの中なのでフォーカスは移る）。
期間は開始・終了の 2 つの DateInput を `role="group"`（`aria-labelledby`）でまとめ、それぞれ「開始日」「終了日」の名前。

### 5.5 i18n

- 月名・曜日名・読み上げの日付は `Intl.DateTimeFormat(locale, …)`。パッケージは辞書を持たない（§13）ので、
  `locale` はアプリが渡す（テンプレートでは Paraglide の現在のロケール）。既定は `'ja-JP'`（既定の文言が
  日本語なのと揃える）。ロケールで分岐するコードは書かず、`Intl` に文字列を渡すだけにする。
- 週の始まりは `weekStartsOn` で明示でき、省略時は `Intl.Locale` の週の情報（`getWeekInfo()`）、使えない環境では
  日曜（D15）。
- `UiMessages` に足す文言（案）: `datePickerOpen`・`datePickerChange(date)`・`datePickerDialog`・
  `datePickerPrevMonth`・`datePickerNextMonth`・`datePickerPrevYear`・`datePickerNextYear`・`datePickerToday`・
  `datePickerClear`・`dateFormatHint`・`timePickerOpen`・`timePickerList`・`timeFormatHint`・`dateTimeFormatHint`・
  `dateRangeStart`・`dateRangeEnd`。
- 検証の文言: forms の `ValidationMessages` に `invalidDate`・`invalidTime`・`invalidDateTime`・`minDate(def, min)`・
  `maxDate(def, max)`・`disabledDate`・`stepTime(def, step)`。grid の `ColumnValidationMessages` に同じ鍵の鏡像。
  `GridMessages` に絞り込みの「開始」「終了」。Rust の検証の文言は既存の `required_message` などと同じく日本語。
- テンプレートのアプリは `messages/{en,ja}.json` に鍵を足して `messages` で渡す。

### 5.6 最小値・最大値・無効日・刻み

- `FieldDef` の `min` / `max` を `number | string` に広げ、date・time・datetime では正規の文字列として読む（D9）。
  カレンダーでは範囲外の日を `aria-disabled` にし、前月・翌月のボタンは範囲外の月へ行けないようにする。
- 無効日は `isDateDisabled?(date: string) => boolean`（`FieldDef` にも足す）。週末・休業日などはアプリが関数で渡す。
  Rust には関数が渡らないので、必要ならリソースの検証に同じ規則を書く（今の `validate` と同じ扱い）。
- 時刻の刻み（D8）: `step`（分）を指定したときは、一覧がその刻みになり、値も 0:00 からの刻みに合うことを検証する。
  省略したときは、一覧は 30 分刻み、値は任意の分を受け付ける。

### 5.7 forms への組み込み

- forms は `provideFieldInputs({ date, time, datetime })`（context）と `BantoForm` の同名の prop を出す。
  受け取った部品が無い型は今のネイティブ input（`date` / `time` / `datetime-local`）を使う。
- `FieldType` に `'time' | 'datetime'` を足す（grid の `SchemaFieldType` も鏡像で同時に）。
- FormDraft では部品に `text` / `onTextInput` を渡して `raw` を使い、`commit` を blur・Enter で呼ぶ。
- 期間は `FieldType` に足さない（D14）。開始・終了の 2 つのフィールドにして、終了側の `validate` で前後を検査する
  （`validate(value, values)` は既に全値を受け取る）。

### 5.8 grid のセル編集

- grid は `provideCellEditors({ date, time, datetime })` と `BantoGrid` の prop を出し、`CellEditorType` に
  `'time' | 'datetime'` を足す。無ければネイティブ input。
- 状態遷移は変えない。部品側が次の約束を守る:
  1. **ポップオーバーの中のキーは部品が処理して伝播を止める**（Popover API の top layer は見た目だけで、DOM の
     位置はセルの中なので、止めないと grid のコンテナのセル移動に届く）。Esc は止める前に §5.4 の
     `closeOnEscape` で部品自身が閉じる（window の受け口にも `handleEditorKeydown` にも頼らない。
     `handleEditorKeydown` は入力欄の `onkeydown` で、しかも無条件に `stopPropagation` するので、ここへ渡しても
     閉じる経路にはならない）。閉じたあとフォーカスは入力欄に戻り、次の Esc は約束 2 の側で編集の取り消しになる。
  2. **入力欄で部品が処理したキー（ポップオーバーが開いている間の Esc・Enter・矢印、Alt+↓）は
     `preventDefault` してから `onkeydown` に渡す**。`handleEditorKeydown` は `defaultPrevented` なら何もしないので、
     「Esc 1 回目 = ポップオーバーを閉じる、2 回目 = 編集の取り消し」「時刻の一覧で Enter = 選ぶ、次の Enter = 確定」
     になる。
  3. **`onblur` は部品全体からフォーカスが出たときだけ**呼ぶ。カレンダーのダイアログへフォーカスが移っても
     確定しない（`handleEditorBlur` の `relatedTarget` の判定を grid に足さずに済む）。
  4. **`pointerdown` は部品全体（入力欄・ボタン・ポップオーバー）で伝播を止める**。今の `CellEditor.svelte` は
     入力欄でだけ止めていて、止めないとセルの `handleCellPointerDown` がコンテナにフォーカスを移し、その場で
     blur → 確定 → 編集欄が消える（ボタンや日を押した瞬間に選ぶ前に確定してしまう）。ポップオーバーは DOM では
     セルの子なので、top layer に出していても同じく届く。部品の根の要素で `onpointerdown` を止める。
     あわせて grid の `relinquishFocus`（document の capture の `pointerdown`）の `editFocus.owned` の判定を
     「`target === editorEl`」から「注入された部品の根が `target` を含む」に広げる（PR-4 で grid 側を直す）。
- カレンダーで日を選んだら、draft に入れてポップオーバーを閉じ、入力欄にフォーカスを戻す。**確定はしない**
  （D11）。確定は今と同じ Enter・Tab・blur。マウスでセルの外を押せば blur で確定する。
- `editFocus.owned`（フォーカスの持ち主）: ダイアログから入力欄へ戻ったときの `focusin` で今の仕組みが
  持ち主を取り直すことを、実装の PR のテストで確かめる。
- grid のスクロールでポップオーバーを閉じる（`Menu` と同じ。行は仮想化されていて、編集中の行が DOM から
  外れることがある）。セルの幅より広いポップオーバーは画面の中に収まるよう位置決めの共通部品で寄せる。

### 5.9 grid の絞り込み（期間）

- `FilterType` に `'date' | 'datetime'` を足す。`columnsFromSchema` は date・datetime の列を既定で絞り込みできるようにする
  （今は不可。既存の派生アプリの見た目が変わるので CHANGELOG に書く）。
- 1 つの列に 1 つの条件のまま、`FilterOp` に **`between`** を足す（D12）。値は `[from | null, to | null]`、
  意味は **`from <= v AND v < to` の半開区間**。UI では終了日を含む期間として見せ、終了日の翌日を `to` にして送る。
  日付の列でも日時の列でも同じ意味になり、日時の値に秒が付いていても取りこぼさない。片側が `null` ならその側の条件を省く。
- `types.ts` の `FilterOp` と `crates/banto-core/src/params.rs` の `FilterOp` を同時に足す（鏡像の約束。
  `filter_state_matches_ts_shape` のテストも）。`list_query.rs` は `between` を `>=` と `<` の 2 つの束縛に展開する。
- クライアント側の `filter.ts` は date・datetime を文字列の比較で行う。並べ替え `sort.ts` も型が date・time・datetime の
  列は `localeCompare` ではなく文字列の大小で比べる。
- FilterPopover の中で DateRangeInput を開くと、層が 2 枚重なる（FilterPopover の dialog の上にカレンダーの dialog）。
  `layering.ts` の「上の層から 1 枚ずつ」に乗る。

### 5.10 CSV・貼り付け

- 書き出しは正規の文字列のまま。
- 取り込み（`convertCsvRow`）と貼り付け（`parseCellInput`）は §5.3 の寛容な解析を通して正規化する。
  Excel で開いて保存した CSV は `2026/11/7`・`2026/11/7 9:30` になるので、これを受け付けるのが要点。
  年を省いた形は受け付けない（取り込みでは「今年」が曖昧なため）。

### 5.11 Rust・DB・scaffold への波及

| 範囲 | 日付（置き換え） | 時刻・日時（新しい型） | 期間（絞り込み） |
| --- | --- | --- | --- |
| forms・grid の型と鏡像 | 検証・解析を足す | `FieldType` / `SchemaFieldType` / `CellEditorType` に追加 | `FilterType`・`FilterOp` に追加 |
| Rust | 検証の関数（banto-core） | 同じ | `params.rs`・`list_query.rs` に `between` |
| DB | 変更なし（TEXT） | 列を足すアプリは TEXT | 変更なし |
| CSV | 取り込みの正規化 | 同じ | — |
| scaffold | 影響なし | デモに列を足さなければ影響なし（D17） | 影響なし |

構造を変える PR では `pnpm scaffold --dry-run` を自分で流して確かめる（フロントだけの変更では template-acceptance が
再実行されないため）。

## 6. PR の分け方

| PR | 内容 | 画面・テスト |
| --- | --- | --- |
| PR-1 | ui: `datetime.ts`（解析・暦・`Intl`）、位置決めを Menu から切り出し（挙動不変）、`DateInput`、`UiMessages` の追加、ui-demo への掲載 | 単体テスト（解析・暦・キー操作・フォーカス）。ui-demo のベースラインを再生成（開いた状態を 1 枚足す） |
| PR-2 | ui: `TimeInput`（combobox ＋ listbox、刻み） | 同上 |
| PR-3 | forms: 注入の口、date の形式・`min`／`max`・無効日の検証、draft の正規化、空値を `null` に。アプリが注入 | forms の単体テスト。forms の画面のベースライン再生成。docs/upgrading.md・CHANGELOG |
| PR-4 | grid: 注入の口、§5.8 の約束、`parseCellInput`・CSV の正規化、`fieldValidator` の鏡像。アプリが注入 | grid の単体テスト（Esc 2 段・Enter 2 段・blur で確定しない・ボタンや日をマウスで押しても選ぶ前に確定も unmount もしない）。e2e: 一覧のセルで日付を編集 |
| PR-5 | 時刻・日時の型: `FieldType` の追加（forms・grid の鏡像）、`DateTimeInput`、Rust の検証関数（banto-core） | 単体テスト・`cargo test`。scaffold の dry-run |
| PR-6 | 期間: `DateRangeInput`、`FilterType` の追加、`FilterOp::between`（TS・Rust・SQLite・PostgreSQL）、FilterPopover | 単体テスト・`cargo test`（両方言）。e2e: items の更新日で期間の絞り込み |

- 基準画像は Linux でだけ作る。各 PR で `visual-baselines.yml` を dispatch して再生成し、差分を目で確かめてから入れる。
  ポップオーバーを開いた状態は ui-demo で撮る（明暗 2 枚。密度・文字サイズの組み合わせは既存の対角の組に合わせる）。
- e2e は Playwright の既存の構成（`e2e/tests`）に足す。キー操作は単体テストで網羅し、e2e は通しの確認に絞る。
- 各 PR で本書の `状態:` 行を更新する。

## 7. 判断が要る点（D1〜D17）

**2026-11-07 にオーナーと合意: D1〜D17 はすべて下の表の推奨（a）で進める。** 各節の b・c は検討の記録として残す。

| 論点 | 推奨 |
| --- | --- |
| D1 forms・grid への渡し方 | **a: アプリが context／prop で注入**（パッケージ間 import は足さない） |
| D2 自作か依存か | **a: 自作**（暦は整数計算、名前は `Intl`） |
| D3 ネイティブ input | **a: 注入が無いときのフォールバックとして残す** |
| D4 日時のタイムゾーン | **a: タイムゾーンを持たない壁時計の時刻 `YYYY-MM-DDTHH:mm`** |
| D5 日時の部品 | **a: 入力欄 1 つ ＋ ポップオーバー 1 枚** |
| D6 空値 | **a: 部品が出すのは `null`（`''` も空として読む）** |
| D7 書式 | **a: 表示は全ロケールで ISO、解析は年月日の順だけ寛容に（全角・区切り・年の省略は手入力のみ）** |
| D8 時刻の刻み | **a: `step` 指定時は一覧と検証、省略時は一覧 30 分・任意の分** |
| D9 最小・最大の指定 | **a: 既存の `min`／`max` を `number \| string` に広げる** |
| D10 閉じた後のフォーカス | **a: 入力欄に戻す** |
| D11 grid で日を選んだとき | **a: draft に入れて入力欄へ戻る。確定は Enter・Tab・blur** |
| D12 期間の絞り込みの表し方 | **a: `FilterOp::between`、半開区間 `[from, to)`、UI は終了日を含めて見せる** |
| D13 期間の部品 | **a: 開始・終了の 2 つの DateInput から始める（範囲の強調表示は後で）** |
| D14 forms に期間の型 | **a: 足さない（2 フィールド ＋ `validate`）** |
| D15 ロケールと週の始まり | **a: `locale` 既定 `'ja-JP'`、週の始まりは prop → `Intl` → 日曜** |
| D16 DB の列型 | **a: TEXT（SQLite・PostgreSQL とも）** |
| D17 デモ（items）に列を足すか | **a: 足さない**（ui-demo と items の更新日で確かめる） |

### D1. forms・grid への渡し方

- **a（推奨）**: §4.2 の a。shared-primitives-upstream-plan §2.1 と同じ「アプリがつなぐ」。
  context を使うのは、`BantoForm`・`BantoGrid` を置くたびに prop を書かずに済むようにするため（prop は上書き用）。
- b: §4 の不変条件を変える。派生アプリの依存の入れ方にも響く。
- c: 複製。2 か所の保守。

### D2. 自作か依存か

- **a（推奨）**: 自作。packages に依存は入れられず（§2.5）、タイムゾーンを持たない暦の計算は小さい。
- b: 依存を足す。§3・§4 の両方の例外になり、ADR が要る。

### D3. ネイティブ input

- **a（推奨）**: 残す。forms・grid を単独で使う派生アプリが壊れない。
- b: 消してピッカーだけにする。forms・grid が ui に依存する形になり D1 の a と両立しない。

### D4. 日時のタイムゾーン

- **a（推奨）**: 壁時計の時刻（オフセット無し）。§5.1 の理由。
- b: UTC の瞬間（`Z` 付き）を値にして表示でローカルに直す。複数の地域から使うアプリ向けだが、日付の境目で
  絞り込みと表示がずれ、DB の文字列比較も表示と食い違う。要るときに別の型で足す。

### D5. 日時の部品

- **a（推奨）**: 1 つ。grid の Tab と両立する。
- b: 2 つ並べる。forms だけなら良いが grid で使えない。

### D6. 空値

- **a（推奨）**: `null`。TEXT の列に `''` が入ると並べ替えと絞り込みで先頭に混ざる。今の DateField は `''` を出すので
  利用者向けの変更になる（docs/upgrading.md に書く）。
- b: `''` のまま。互換は保てるが、新しい型も合わせて `''` にすることになる。

### D7. 書式

- **a（推奨）**: §5.3。ISO を全ロケールの表示にして、ロケールで意味が変わる書式を受け付けない。
- b: ロケールの書式（`11/7/2026` など）で表示・入力。英語の UI で自然だが、解析がロケールで分岐し
  （§13 のロケール分岐を持たない約束に触れる）、CSV・貼り付けとも食い違う。

### D8. 時刻の刻み

- **a（推奨）**: §5.6。刻みを指定しないフィールドで 10:15 が拒まれる驚きを避ける。
- b: 刻みを常に検証（既定 30 分）。ネイティブの `step` に近いが、既定で厳しすぎる。

### D9. 最小・最大の指定

- **a（推奨）**: `min`／`max` を `number | string` に広げる。HTML の `min`／`max` 属性と同じ名前で覚えやすい。
  number の列に文字列を書いても型では止まらないので、validate で型ごとに読む。
- b: `minDate`／`maxDate` など別の名前。型は厳しくなるが、時刻・日時ごとに名前が増える。

### D10. 閉じた後のフォーカス

- **a（推奨）**: 入力欄。grid では入力欄が編集の主体で、Enter・Tab がそこで効く必要がある。forms も揃える。
- b: APG の例どおりボタンへ。forms だけ b にすると 2 つの振る舞いになる。

### D11. grid で日を選んだとき

- **a（推奨）**: draft に入れるだけ。1 回の Enter が 1 つの操作になり、選び直しもできる。
- b: 選んだら即確定。マウスでは 1 手減るが、キーボードではカレンダーの Enter とセルの確定が混ざる。

### D12. 期間の絞り込みの表し方

- **a（推奨）**: `between`（半開区間）。1 列 1 条件のままで、保存した表示の状態（`state.svelte.ts` の直列化）の形も変えない。
- b: 1 つの列に複数の条件（`gte` と `lt`）を許す。`FilterOp` は増えないが、`setFilter` の意味と保存した状態の
  読み込みが変わり、FilterPopover の「今の条件」も 2 つになる。

### D13. 期間の部品

- **a（推奨）**: 2 つの DateInput。a11y はそれぞれの部品で済む。
- b: 1 枚のカレンダーで開始・終了を続けて選び、間を強調する。見た目は良いが、キー操作と読み上げ（「範囲の中」）の
  設計が別に要る。要望が出たら足す。

### D14. forms に期間の型

- **a（推奨）**: 足さない。値が 2 つの列に分かれるのが普通で、Rust・DB の形も変わらない。
- b: `daterange` 型を足して 1 つの値（オブジェクト）にする。DB の列の対応が決まらない。

### D15. ロケールと週の始まり

- **a（推奨）**: §5.5。既定を `'ja-JP'` にして、既定の見た目を日本語の文言と揃える。
- b: 既定をブラウザのロケールにする。文言（既定は日本語）と月名がずれることがある。

### D16. DB の列型

- **a（推奨）**: TEXT。§5.1 の理由（sqlx の feature が §3 に当たる。前例がある）。
- b: PostgreSQL では `DATE`／`TIMESTAMP`。型の検査は DB でも効くが、読み書きに依存が要り、SQLite と食い違う。

### D17. デモ（items）に列を足すか

- **a（推奨）**: 足さない。ピッカーは ui-demo、期間の絞り込みは items の更新日（既存の date 列）で確かめられる。
  時刻・日時の Rust の検証は `cargo test` の単体テストで確かめる。
- b: items に日時の列を 1 つ足す。通しで確かめられるが、マイグレーション（2 方言）・CSV・scaffold のプリセットに波及する。

## 8. 未確認の点

- `Intl.Locale.prototype.getWeekInfo()` が WebKitGTK（Linux の Tauri）と LAN から開く Firefox で使えるか。
  使えないときは日曜に倒す前提（D15）。 → PR-1 では `getWeekInfo()` と古い `weekInfo` の両方を見て、
  どちらも無ければ日曜に倒す（単体テストで確認）。実機の WebKitGTK・Firefox での値は未確認。
- Popover API の top layer に出したダイアログを、`Modal`（`aria-modal` の div）と FilterPopover（`role="dialog"`）の
  上に重ねたときの層の判定（`effectiveZIndex`・`hasVisibleLayerAbove`）が期待どおりか。`popover="auto"` だと
  入れ子でない別の auto ポップオーバーを閉じるので、`manual` にして閉じる操作を自前で持つほうが良いかもしれない。
  → PR-1 では `DateInput` を `popover="manual"` にし、外側の `pointerdown` で閉じる処理を部品が持つ形にした
  （開いている Menu などの `auto` を閉じない）。閉じている間はポップオーバーの要素自体を描かない（ページに見えない
  `role="dialog"` を残さない）。Modal・FilterPopover の上に重ねたときの確認は、つなぎ込む PR-3／PR-4 で行う。
  → PR-3 で Modal の中を確かめた。カレンダーにフォーカスがあるときの Esc はポップオーバーの中で止まり（カレンダーだけが
  閉じて入力欄へ戻る）、2 回目の Esc で Modal が閉じる（`packages/ui/tests/dateInput.test.ts` と
  `e2e/visual/ui-overlays.spec.ts`。ui の変更は不要だった）。FilterPopover の上は PR-4 で確かめる。
  → PR-4 の時点では FilterPopover の中に日付の入力が無い（期間の絞り込みは PR-6）ので、カレンダーと FilterPopover は
  重ならない。PR-4 では同じグリッドで、カレンダーを開いたまま見出しの絞り込みボタンを押すとカレンダーが閉じて編集が
  確定し、開いた FilterPopover の Esc は FilterPopover だけを閉じることを確かめた（`e2e/visual/ui-overlays.spec.ts` の
  ui-demo のグリッド）。FilterPopover の上にカレンダーを重ねたときの Esc は PR-6 で確かめる。
  → PR-6 で確かめた。FilterPopover の中の `DateRangeInput` でカレンダーを開くと、カレンダーの Esc はパネルの中で止まって
  カレンダーだけが閉じ（入力欄へ戻る）、次の Esc で FilterPopover が閉じてフォーカスは絞り込みボタンへ戻る。カレンダーの
  `pointerdown` は DOM では FilterPopover の根の中なので、FilterPopover の外側判定（window の capture）にも掛からない
  （`packages/grid-svelte/tests/filterRange.test.ts` と e2e の smoke `3g`。ui・FilterPopover の Esc の経路の変更は不要だった）。
- `editFocus.owned` が「ダイアログ → 入力欄」へ戻ったときに正しく取り直されるか（§5.8）。
  → PR-4 で `relinquishFocus` の判定を部品の根（grid が注入した部品を包む要素）に広げ、ボタン・カレンダーの日を押しても、
  カレンダーへフォーカスが移っても持ち主のままにした。カレンダーを開いたままセルの外を押すと、`DateInput` が閉じる
  ときに入力欄へフォーカスを戻すが、同じ `pointerdown` の中のその `focusin` では持ち主を取り直さない（確定に失敗しても
  フォーカスを奪い返さない、#212 の規則）。`packages/grid-svelte/tests/cellEditors.test.ts` で確かめた。
- PostgreSQL の TEXT の比較が照合順序（collation）の影響を受けないか。固定幅の ISO 文字列なら順序は保たれる
  見込みだが、`between` では `COLLATE "C"` を付けるかを実装の PR で確かめる。
  → PR-6 で付けた。PostgreSQL の既定の照合順序（`en_US.UTF-8` など）は記号を後回しにして比べるので、正規の形どうしなら
  順は保たれるが、形の違う値（秒付き、`T` と空白）や英字を含む値でクライアントの文字列比較（JS の `<`）と食い違いうる。
  `between` は `CAST(列 AS TEXT) COLLATE "C" >= $1 AND ... < $2` で比べる（SQLite の既定 `BINARY` は既に符号単位の順）。
  キャストは `DATE`／`TIMESTAMP` の列でも動かすため。代わりにその列の通常の索引は効かない（`COLLATE "C"` の索引が要る）。
  → 対応済み（#536）: admin-template の `items.updated_at` に同じ式の索引（migration `0009_items_updated_at_index.sql`）を張り、`pg_smoke` の `EXPLAIN` で使われることを確かめる。派生アプリは自前の date 列に同じ式の索引を張る。なお lt/lte/gt/gte は列そのものを比べる（`COLLATE "C"` は `between` だけ）。
  CI の `storage-postgres`（既定の照合順序のコンテナ）で共通ケースを流す。
- スクリーンリーダーの実機での読み上げ（NVDA ＋ WebView2、VoiceOver ＋ WKWebView）。
- 既存の基準画像のうち、ネイティブの date 入力が写っているものの数（PR-3 で再生成する範囲）。
- 派生アプリ（banto-industrial など）が date 型の空値を `''` として扱っていないか（D6 の影響）。
- `items.updated_at` の `date('now')` は SQLite では UTC の日付で、ピッカーの「今日」（ブラウザのローカル日付）と
  日本時間の 0〜9 時に食い違う。本設計の範囲外だが、期間の絞り込みの確認で目に付くはず。
  → **対応済み**（PR #533）。保存側で、アプリのプロセスが動く PC のローカル日付を Rust（chrono の `Local`）で求め、
  SQL にはパラメータで束縛するようにした（SQLite・PostgreSQL 共通）。既存の行は書き換えない。
