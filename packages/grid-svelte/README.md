# @banto/grid-svelte

Banto のデータグリッド。仮想スクロール・複数列ソート・列フィルタ・
列リサイズ/並び替え・Excel ライクなセル編集/範囲選択/コピー&ペースト・
クライアント/サーバー両モード・グルーピング+集計を提供する（spec §4）。
フォームスキーマから列を自動導出する `columnsFromSchema`（M23）も含む。

## 使用例

```svelte
<script lang="ts">
	import { BantoGrid, GridState, type GridColumn } from '@banto/grid-svelte';

	interface Row {
		id: number;
		name: string;
	}

	const rows: Row[] = [{ id: 1, name: 'ペン' }];
	const columns: GridColumn<Row>[] = [{ id: 'name', header: '商品名', accessor: 'name' }];
	const state = new GridState<Row>(columns);
</script>

<BantoGrid {rows} {columns} {state} getRowId={(row) => row.id} />
```

## セル編集の名前・エラー・保存状態（次リリース）

組み込み editor の名前は列の `header`、空白の見出しは列 `id` を使う。
入力の `aria-invalid` と、グリッドごとに一意なエラー要素への `aria-describedby` を設定し、
エラーがなくなったら参照も外す。既存の `role="alert"` とセルの枠は維持する。
保存待ちの状態は編集中セルの `aria-busy` で示す。pending の操作抑止・フォーカス所有権・
保存結果の反映・検証・session 判定を維持する。

checkbox editor は `--banto-checkbox-size`（fallback `1.1rem`）で native の形を保ち、
セル全幅・全高へは伸ばさない。フォーカスは既存の編集セル枠で示す。
行高・列幅・仮想化・native の checked / Space / 即時確定は維持する。

変換中（`isComposing` または互換用の `keyCode === 229`）と処理済み（`defaultPrevented`）の
keydown は保存・取消・セル移動へ渡さず、グリッド本体へも伝播させない。
通常のキーは確定・取消・エラー参照の規則に従う。pending 中の操作抑止と blur による確定は維持するため、
変換中の Tab がブラウザの標準動作で blur を起こした場合まで保存を止める契約ではない。

### 長いエラーの全文を読む（次リリース、ADR-0027）

エラーはスクロール領域の外側に重ねる。幅を可視範囲に収め、右端・下端や入れ子の
スクロール領域でも折返し・上下の切替・高さ制限を行う。極長文はエラー領域自身をスクロールして読める。
表の寸法・行配置・編集中の入力 DOM を変えず、表示位置だけを更新する。

| 操作                                    | 結果                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Enter で検証・保存に失敗                | 入力欄とドラフトを保持する                                                |
| エラーがある時の Tab / Shift+Tab        | 再送信せず、全文を読む領域へ移る。入力変更後も Enter で明示的に再試行する |
| エラーなしで Tab 確定し失敗             | 同じ編集とフォーカス所有権が残る場合だけエラー領域へ移る                  |
| エラー領域の矢印・Home/End・PageUp/Down | ブラウザの標準動作で全文をスクロールする                                  |
| エラー領域の Shift+Tab / Escape         | 保存・取消せず、同じ入力欄へ戻る                                          |
| エラー領域の Tab                        | 標準の順序で次の操作要素へ進む                                            |

入力欄とエラー領域の往復は blur 保存を起こさない。外クリック・別の編集・window blur が
先行した場合、保存失敗後にフォーカスを取り戻さない。領域が表示範囲から外れた時も強制復帰しない。
本文の `role="alert"` と入力欄の説明 ID を維持し、フォーカスできる領域の名前・操作ヒントを
`messages.inlineEditErrorLabel(header)` / `inlineEditErrorHint()` で上書きできる。
表の外側には常設の `.banto-grid-frame` が入る。独自 CSS で直下構造を参照する場合は
[移行の注意](../../docs/upgrading.md#グリッドのエラー領域次リリースadr-0027) を参照。

## フィルタ・選択範囲の操作性（次リリース）

列フィルタの条件選択と値入力の名前は `messages.filterOperatorLabel` /
`filterValueLabel` で上書きできる。省略時は日本語を使い、placeholder は名前と独立して維持する。
開閉ボタンは `aria-haspopup="dialog"`、`aria-expanded` と、開いている間だけ一意な dialog ID への
`aria-controls` を持つ。開くと値入力へ移り、内部の Escape・適用・クリア後はボタンへ戻る。
同じボタンの再クリックでも閉じる。外クリックは閉じるだけでフォーカスを取り戻さず、
Tab / Shift+Tab はブラウザの標準移動を使う非modalのまま。
値を空にして適用すると条件を解除する。数値入力の空欄も解除し、数値 `0` は値として維持する。
値入力の Enter と内部の Escape も、変換中（`isComposing` / `keyCode === 229`）や処理済みのキーを奪わない。

適用済みのフィルタはボタンの二重下線で示す。文字色や背景色に加えて形でも区別し、
強制配色でも印を残す。ボタン幅・列幅・見出しの省略幅は変えない。
適用中だけ列固有の説明へ `aria-describedby` を付け、hover の title にも同じ文言を出す。
説明は任意の `messages.filterAppliedDescription(header)` で上書きできる。
`aria-expanded` はポップオーバーの開閉を表し、適用状態とは独立する。
入力途中やキャンセルは適用状態を変えず、条件を適用すると印が付き、解除すると印と説明参照が外れる。

グリッド入口・見出し・フィルタ操作子のフォーカスは実線枠で示す。
強制配色では範囲選択を内側の破線、active セルを実線で区別する。選択計算・通常配色・
ソートやフィルタの値・セル編集・仮想スクロールの契約は維持する。

## 日付のセルと注入（date-time-pickers PR-4）

`editor: 'date'` のセルの値は `YYYY-MM-DD`（実在の日）か、空なら **`null`**（`''` ではない。
[docs/design/date-time-pickers.md](../../docs/design/date-time-pickers.md) D6）。

- **解析**: `parseCellInput(raw, 'date')`（セルの確定・貼り付け・CSV 取り込みの共通の入口）は、寛容な形
  （`2026/11/7`・`2026.11.7`・`20261107`・全角）を `YYYY-MM-DD` に直し、空白だけなら `null`、それ以外（実在しない日・
  `11/07/2026` のような別の順・時刻付き）は失敗にする。年を省いた `11/7` は、セルで打って確定したときだけ今年として
  受け付け、貼り付けと CSV では失敗にする（どの年か決まらないため）。
- **検証**: `columnsFromSchema` の date の列は forms の `validateField` と同じ規則・文言で、形式 → `min` / `max`
  （正規の文字列、両端を含む）→ `isDateDisabled` を検査する。文言は `ColumnValidationMessages` の任意の
  `dateInvalid` / `dateMin` / `dateMax` / `dateDisabled`。範囲と無効日は列の `editorMin` / `editorMax` /
  `isDateDisabled` にも入り、注入したピッカーのカレンダーで選べなくなる。
- **ピッカーの注入**: grid は `@banto/ui` を import しない（docs/conventions.md §4）。アプリが部品を渡す。

  ```svelte
  <!-- +layout.svelte: 下のすべての BantoGrid に効く -->
  <script lang="ts">
  	import { provideCellEditors } from '@banto/grid-svelte';
  	import CellDateInput from '#lib/components/CellDateInput.svelte'; // DateInput + messages + locale

  	provideCellEditors({ date: CellDateInput });
  </script>
  ```

  グリッドごとに替えるときは `<BantoGrid cellEditors={{ date: OtherInput }} … />`（型ごとに context より優先）。
  渡される props は `CellDateEditorProps`（`@banto/ui` の `DateInput` の props の一部。`inputEl` は bindable で、grid が
  フォーカスを置く先）。注入が無ければネイティブの `<input type="date">` のまま。

- **セル編集の約束**（§5.8）: 編集の状態遷移は変わらない。カレンダーで日を選んでも下書きに入るだけで確定しない
  （確定は Enter・Tab・セルの外を押したとき）。Esc の 1 回目はカレンダーを閉じて入力欄へ戻り、2 回目で編集を
  取り消す。ボタンやカレンダーの日をマウスで押しても、選ぶ前に確定したり編集欄が消えたりしない。注入する部品は
  `DateInput` と同じく、ポップオーバーの中のキーと `pointerdown` を外へ出さず、自分で処理したキーは
  `preventDefault` してから `onkeydown` に渡し、`onblur` は部品全体からフォーカスが出たときだけ呼ぶこと。

## 時刻・日時のセル（date-time-pickers PR-5）

`editor: 'time'`（`HH:mm`）と `editor: 'datetime'`（`YYYY-MM-DDTHH:mm`、タイムゾーンなし）。空は `null`。

- **解析**: `parseCellInput(raw, 'time' | 'datetime')` は `930`・`9:30`・全角や、Excel の `2026/11/7 9:30` を正規の形に
  直す。秒付き・`24:00`・日付だけの datetime は失敗。年を省いた `11/7 9:30` はセルで打ったときだけ今年。
- **検証**: `columnsFromSchema` の列は forms と同じ規則・文言（`timeInvalid` / `timeMin` / `timeMax` / `timeStep` /
  `dateTimeInvalid` / `dateTimeMin` / `dateTimeMax`）。範囲・刻み・（datetime の）無効日は `editorMin` / `editorMax` /
  `editorStep` / `isDateDisabled` にも入る。datetime の列は既定の `format` で空白区切りに見せる（値とコピーは `T`）。
- **ピッカーの注入**: `provideCellEditors({ date, time, datetime })`。props は `CellTimeEditorProps` /
  `CellDateTimeEditorProps`。注入が無ければネイティブの `time` / `datetime-local`。§5.8 の約束は date と同じで、
  `DateTimeInput` では日を選ぶと時刻の一覧へ移り、時刻を選ぶと下書きに入って入力欄へ戻る（確定は次の Enter・Tab・外を押す）。

## 期間の絞り込み（date-time-pickers PR-6）

`filterType: 'date' | 'datetime'` の列は、絞り込みが演算子と値ではなく期間（開始日・終了日）になる。

- **値の形**: `FilterOp` の `'between'`。値は `[from | null, to | null]` で、意味は**半開区間 `from <= v && v < to`**
  （文字列の大小で比べる）。`null` の端はその側の条件を省き、両方 `null` は条件なし（`null` のセルも残る）。
  Rust の `FilterOp::Between`（`banto-storage` の `list_query.rs` が `>=` と `<` の 2 つの束縛に展開。PostgreSQL では
  `CAST(列 AS TEXT) COLLATE "C"` で比べ、DB の照合順序に左右されない）・admin-core の InMemory と同じ規則で、共通の
  ケースは `crates/banto-storage/testdata/filter-between-parity.json`。形の崩れた値はサーバーでは 400、クライアントでは
  一致なし、保存した状態の復元（`GridState.hydrate`）では捨てる。
- **画面と値の変換は 1 か所**: FilterPopover は両端とも含む日を見せ、適用すると終了日の**翌日**を `to` にして送る
  （`dateRangeToBetween`。月末・年末・うるう日を繰り上げ、`9999-12-31` は開いた端になる）。開き直すと
  `betweenToDateRange` で含む日に戻して見せる。日時の列でも同じ日の範囲になり、秒が付いた値も取りこぼさない。
  終了日が開始日より前・日付でない入力は、ポップオーバーにエラーを出して適用しない。両方空で適用すると絞り込みを外す。
- **部品の注入**: `provideCellEditors({ dateRange })`（`BantoGrid` の `cellEditors.dateRange` も可）。props は
  `FilterDateRangeInputProps`（`@banto/ui` の `DateRangeInput` がそのまま合う）。注入が無ければ 2 つのネイティブの
  `<input type="date">`。カレンダーを開いた状態の Esc はカレンダーだけを閉じ、次の Esc でポップオーバーが閉じる。
- **既定の変化**: `columnsFromSchema` は date・datetime の列を絞り込みできるようにする（以前は不可。読み取り専用の列も）。
  date・time・datetime の列は並べ替えと `lt`／`gt` などの比較も文字列の大小で行う（`comparator: compareTemporal`、
  手書きの列は `editor`／`filterType` が日付・時刻なら同じ）。
- **文言**: `GridMessages` に `filterRangeLabel`・`filterRangeStart`・`filterRangeEnd`・`filterRangeInvalid`・
  `filterRangeOrder`。
- 選択中のセルがあっても、FilterPopover の入力欄への貼り付けはその入力欄のもの（範囲の貼り付けにしない）。

## 依存

`ColumnsMenu` の checkbox はネイティブ描画を使い、`--banto-checkbox-size`（既定・fallback は `1.1rem`）で
forms と寸法・実線フォーカス・無効状態を揃える。ラベル行の最小高さは `--banto-control-height-sm`。
最後の表示列を隠せない制約やキーボード操作は維持する（ADR-0026）。

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（コアパッケージのためオプション側への依存も持たない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/ui-framework-spec.md §4](../../docs/ui-framework-spec.md)（データグリッド仕様）

## CSV export: spreadsheet formula safety (`formulaSafe`)

`toCsv(columns, rows, { formulaSafe: true })` is an opt-in mode for CSV files
that people open in Excel-style spreadsheets (use together with `csvForExcel`,
which only adds the UTF-8 BOM).

- Only values that are JavaScript **strings** are affected. If one starts with
  `=` `+` `-` `@`, TAB, CR, LF, or the full-width `＝` `＋` `－` `＠`, a leading
  `'` is added before RFC 4180 quoting. Numbers (including negative ones),
  booleans, null/undefined and header cells are never changed.
- The default (`formulaSafe` omitted/`false`) output is unchanged and re-imports
  losslessly. The safe output is **not** the raw value: `parseCsv` keeps the
  leading `'`, so strip it on import if you need the original text.
- This is a mitigation for Excel-style software, not a guarantee for every way
  of consuming CSV. Leading-space forms such as `" =1"` are not changed.
