# @banto/ui

Banto の汎用 UI 部品（Svelte 5）。管理画面のページ見出し・カード・状態表示など、
アプリのコードに依存しない小さな部品を共有する（Issue #220、
[ADR-0018](../../docs/adr/0018-shared-ui-package.md)）。文言・アイコン・状態・操作は
props / snippet / コールバックで受け取り、アプリのストア・`$app/*`・Tauri・他の `@banto/*`・
サードパーティのパッケージは import しない（`verify:architecture` の rule
`package-bare-imports` が `svelte`・`svelte/*`・相対パス以外を落とす）。

段階 1 の部品は次の 7 つ。段階 2a でメニュー部品（4 つ、下の表の後）、段階 2b で
`CommandPalette`（その後）、段階 2c でトースト（`createToastStore()` + `ToastHost`、その後の節）を足した
（段階 2 は完了。ADR-0018 §8）。段階 4 で `Modal`・`Drawer` と Esc・フォーカスの層の補助を足した
（トーストの後の節。ADR-0018 §10）。段階 5 でドック風のランチャー `LauncherBar` を足した
（層の補助の後の節。ADR-0018 §11）。

| 部品           | 役割                                                      | props / snippet                                         |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `PageHeader`   | ページの `<h1>` + 説明 + 操作（`view-transition-name`）   | `title` `hideTitle?` `description?` `actions?`(snippet) |
| `SurfaceCard`  | 区画・カードの面（`<h2>` 見出し + 本文 + フッタ）         | `title?` `description?` `children` `footer?`            |
| `StatusBadge`  | 状態/ロールのバッジ（色だけに頼らず常にアイコンを出す）   | `variant` `label` `icon?`                               |
| `IconButton`   | アイコンだけのボタン（`label` が `aria-label`・`title`）  | `label` `icon` `size?`(`'sm'`/`'md'`) `onclick`         |
| `EmptyState`   | ページ単位の「データなし」                                | `icon?` `title` `description?` `action?`(snippet)       |
| `ErrorState`   | ページ単位のエラー（`role="alert"`）                      | `icon?` `title` `description?` `action?`(snippet)       |
| `LoadingState` | ページ単位の読み込み中（スケルトン + `aria-live` の文言） | `label?` `lines?`                                       |

`PageHeader` の `hideTitle` は既定 `false`。シェルに同じタイトルがある画面では `true` にすると、
内容側の `<h1>` を読み上げ用に残し、説明と操作だけを表示する。説明も操作もない場合は可視の行を作らない。
テンプレートのシェル内画面はこの指定を使う。ログイン・帳票本文・UI 部品の見本にはそれぞれの見出しを表示する。

メニュー部品（段階 2a。`popover` API を前提にする）:

| 部品            | 役割                                                                                       | props / snippet                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `Menu`          | トリガーから開く 1 階層のドロップダウン（`popover="auto"` + `role="menu"`、↑↓・Home・End） | `label` `placement?`(`'bottom-start'`/`'bottom-end'`) `trigger`(snippet) `children` |
| `MenuGroup`     | 見出し付きの項目グループ（`role="group"`）                                                 | `label` `children`                                                                  |
| `MenuItem`      | メニュー項目（`role="menuitem"`、ローヴィングフォーカス。`disabled` は `aria-disabled`）   | `label` `icon?` `danger?` `disabled?` `onSelect`                                    |
| `MenuSeparator` | 区切り線                                                                                   | なし                                                                                |

`trigger` snippet は `aria-haspopup`・`aria-expanded`・`onclick`・`onkeydown` を props で受け取る
ので、ボタンに `{...props}` で展開する。項目を選ぶとメニューは閉じ、フォーカスはトリガーへ戻る。

日付・時刻の入力（[date-time-pickers.md](../../docs/design/date-time-pickers.md) PR-1・PR-2・PR-5・PR-6。`popover` API を前提にする）:

| 部品             | 役割                                                                                                                                                      | props                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DateInput`      | 直接打てる入力欄 ＋ 横のボタンで開くカレンダー（`role="dialog"` + `aria-modal`、矢印・Home・End・PageUp/Down・Enter・Esc）                                | `value`(`'YYYY-MM-DD'`/`null`、bindable) `onValueChange?` `text?` `onTextInput?` `id?` `label?` `describedBy?` `invalid?` `disabled?` `readonly?` `min?` `max?` `isDateDisabled?` `locale?` `weekStartsOn?` `messages?` `onkeydown?` `onblur?` `inputEl`(bindable)                                                                         |
| `TimeInput`      | 直接打てる入力欄 ＋ 時刻の一覧（`role="combobox"` + `role="listbox"`、フォーカスは入力欄のまま `aria-activedescendant`。↓・Alt+↓ で開く、↑↓・Enter・Esc） | `value`(`'HH:mm'`/`null`、bindable) `onValueChange?` `text?` `onTextInput?` `id?` `label?` `describedBy?` `invalid?` `disabled?` `readonly?` `min?` `max?` `step?` `messages?` `onkeydown?` `onblur?` `inputEl`(bindable)                                                                                                                  |
| `DateTimeInput`  | 入力欄 1 つ ＋ カレンダーと時刻の一覧を並べたダイアログ 1 枚（`role="dialog"`。日を選ぶと一覧へ、時刻を選ぶと値が決まって閉じる）                         | `value`(`'YYYY-MM-DDTHH:mm'`/`null`、bindable) `onValueChange?` `text?` `onTextInput?` `id?` `label?` `describedBy?` `invalid?` `disabled?` `readonly?` `min?` `max?` `isDateDisabled?` `step?` `locale?` `weekStartsOn?` `messages?` `onkeydown?` `onblur?` `inputEl`(bindable)                                                           |
| `DateRangeInput` | 開始日・終了日の 2 つの `DateInput` を `role="group"` でまとめる（両端とも含む日。範囲の強調表示はしない）                                                | `value`(`{ from, to }`、各端は `'YYYY-MM-DD'`/`null`、bindable) `onValueChange?` `onTextInput?(end, text)` `id?` `label?` `labelledBy?` `describedBy?` `invalid?` `disabled?` `readonly?` `min?` `max?` `isDateDisabled?` `locale?` `weekStartsOn?` `messages?` `orientation?` `onkeydown?` `onblur?` `fromInputEl`・`toInputEl`(bindable) |

値は `YYYY-MM-DD`（タイムゾーンを持たない日付）か `null`。手入力は blur・Enter で解析し、通れば正規の形に直す
（`2026/11/7`・`20261107`・全角・`11/7`（今年）も可。`11/07/2026` のような年月日の順でない形は受け付けない）。
通らない文字列はそのまま残し、値は変えない（エラーの表示は親が `invalid` で出す）。`min`・`max`・`isDateDisabled` の日は
カレンダーで選べない（手入力の範囲検査は親の役目）。閉じるとフォーカスは入力欄へ戻る。月名・曜日名・読み上げの日付は
`Intl.DateTimeFormat(locale)`（既定 `'ja-JP'`）、週の始まりは `weekStartsOn` → ロケールの週の情報 → 日曜。
文言（`datePicker*`・`dateFormatHint`）の既定は日本語で、多言語化するアプリは `messages` で渡す。
`onblur` は入力欄・ボタン・カレンダーの全体からフォーカスが出たときだけ呼ぶ。カレンダーの中のキーと、部品の中の
`pointerdown` は外へ伝えない（グリッドのセル編集に組み込むための約束。設計書 §5.8）。

時刻の値は `HH:mm`（00:00〜23:59、24 時間、タイムゾーンなし）か `null`。手入力は `9:30`・`0930`・`930`・`9`・全角も可で、
blur・Enter で正規の形に直す。表示は全ロケールで `HH:mm`（ロケールの 12 時間制に従わない）。`step`（分）を指定すると一覧は
0:00 からその刻み、省略すると 30 分刻み（どちらも 23:59 を越えて翌日へは回らない）。手入力は任意の分を受け付け、刻み・`min`・`max` の
検査は親の役目（`isOnTimeStep`・`isOutOfRange`）。一覧では `min`・`max` の外の時刻を `aria-disabled` にして選べなくする。
一覧を開くと値（打ちかけの文字列が解析できればそれ）に一番近い項目を指し、一覧の中だけをスクロールして見せる。横のボタンは
マウス用（`tabindex="-1"`）。文言（`timePickerOpen`・`timePickerList`・`timeFormatHint`）の既定は日本語。`onblur`・`pointerdown` の
約束は `DateInput` と同じ（一覧を開いてもフォーカスは入力欄から動かない）。

日時の値は `YYYY-MM-DDTHH:mm`（タイムゾーンを持たない壁時計の時刻）か `null`。入力欄は空白区切り（`2026-11-07 09:30`）で
見せ、手入力は日付と時刻を空白か `T` でつないだもの（`2026/11/7 9:30`・`11/7 930`・全角も可。秒付き・日付だけは受け付けない）。
ダイアログはカレンダー（`DateInput` と同じ。内部の `MonthCalendar.svelte` を共有）と時刻の一覧（`role="listbox"`、フォーカスが
入る。↑↓・Home・End・Enter・Space）。日を選ぶ（「今日」も）と値は変えずに一覧へ移り、時刻を選ぶとその日の時刻を値にして閉じる。
`min`／`max` は日時で、カレンダーではその日付の外を、一覧では端の日のはみ出す時刻を選べなくする。刻み・範囲の検査は親の役目。
文言（`dateTimePicker*`・`dateTimeFormatHint`、カレンダーと一覧は `datePicker*`・`timePickerList`）の既定は日本語。約束は
`DateInput` と同じ。

期間（PR-6）は `DateRangeInput`。2 つの入力欄の名前は `dateRangeStart`・`dateRangeEnd`（既定「開始日」「終了日」）、まとまりの
名前は `label`（`aria-label`）か `labelledBy`（`aria-labelledby`、こちらが優先）。値は両端とも含む日の `{ from, to }` で、
開始と終了の前後は検査しない（親の役目。グリッドの絞り込みは「終了日は開始日以降」を出して適用しない）。半開区間への
変換（終了日の翌日を送る）は部品の外、`@banto/grid-svelte` の `dateRangeToBetween` の 1 か所で行う。各入力欄の挙動・約束は
`DateInput` のまま。`onblur` は 2 つの入力欄の全体からフォーカスが出たときだけ、`pointerdown` はまとまりの外へ伝えない。
`orientation="vertical"` で縦に積む（幅の狭いポップオーバー向け）。

入力欄の幅は CSS カスタムプロパティで調整できる（公開の調整点）: `DateInput` と `DateRangeInput` の各欄は
`--banto-date-input-width`（既定 `11em`）、`TimeInput` は `--banto-time-input-width`（`7.5em`）、`DateTimeInput` は
`--banto-datetime-input-width`（`15em`）。祖先の要素で上書きする（`100%` で親の幅に合わせる）。高さは `--banto-control-height`。
`@banto/grid-svelte` のセル編集はこの 3 つの幅を `100%` にし、高さを行に収める。

解析・暦の純粋関数（`parseDateText`・`parseIsoDate`・`isIsoDate`・`addDays`・`addMonths`・`addYears`・`dayOfWeek`・
`monthGrid`・`clampDate`・`isOutOfRange`・`todayDate`・`resolveWeekStart`・`formatFullDate` など、時刻は `parseTimeText`・
`parseIsoTime`・`isIsoTime`・`timeOptions`・`isOnTimeStep`・`nearestTime`・`timeToMinutes`・`minutesToTime` など）も公開する
（`Date.parse` を使わず、文字列の大小 = 日付・時刻の前後で比べる）。

コマンドパレット（段階 2b）:

| 部品             | 役割                                                                              | props                                                                                               |
| ---------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `CommandPalette` | 検索欄 + グループ見出し付きの一覧のモーダル（`role="dialog"` + combobox/listbox） | `open`(bindable) `items` `search?` `recentIds?` `onExecute` `onClose?` `focusFallback?` `messages?` |

パッケージが持つのは**表示と操作だけ**。どのコマンドがあるか・実行のしかた・`Ctrl+K` の配線・
セッションごとの扱い・最近使った項目の記録・失敗の通知はアプリが持ち、props とコールバックで渡す。

- **項目**（`CommandPaletteItem`）: `id`・`title`・`group?`（見出し）・`keywords?`（検索だけに使う語）・
  `icon?`・`disabled?`（表示するが選べない。↑↓ で飛ばす）・`shortcut?`（右端の表示だけ）。
  `@banto/admin-core` の `PaletteCommand` と構造的に合うので、その配列をそのまま渡せる
  （`onExecute` には渡した同じオブジェクトが返る）。表示してよい項目だけを渡す（権限の判定はアプリ）。
- **検索**: 既定は `defaultCommandPaletteSearch`（`title`・`keywords` の大文字小文字を区別しない
  部分一致、並びは渡した順）。`search(query, items)` で差し替えられる（admin-template は admin-core の
  `searchCommands` で点数順・最近使ったものを優先）。結果はグループごとに、最初に出た順でまとめる。
- **最近使ったもの**: `recentIds` を渡すと、検索が空のときにその順で先頭へ「最近使ったもの」の
  見出しで出す（同じ項目は元のグループに重ねて出さない）。記録はアプリのストアで持つ。
- **実行**: Enter かクリックで `onExecute(item)`。Promise を返せば終わるまで行を無効にし、その後に
  閉じる。失敗の扱い（通知など）は `onExecute` の中で行う（reject はパッケージで捕まえない）。
  実行の完了前に Esc で閉じて開き直した場合、古い実行の完了は新しいパレットを閉じない。
- **閉じる**: Esc・パレットの外の pointerdown・実行の後に `open` を `false` にし、`onClose(reason)`
  （`'escape' | 'outside' | 'execute'`）を呼ぶ。開くたびに中身を作り直す（検索語・選択は残らない）。
- **キーボード**: ↑↓ で選択（端で折り返す。`disabled` は飛ばす。選べる項目が無いときは何も選ばず Enter も何もしない）、Enter で実行。マウスを乗せた行が
  選択になる（キーボードの選択と同じ見た目、`--banto-surface-hover`）。Home/End は検索欄の
  カーソル移動のまま（奪わない）。
- **フォーカス（標準の振る舞い）**: 開いている間は**フォーカスを閉じ込める**（Tab は中で折り返し、
  外へ出たフォーカスは検索欄へ引き戻す）。閉じたら**開いた時にフォーカスがあった要素へ戻す**
  （消えている・`inert` の中・見えないなら `focusFallback()` の要素へ。無ければ動かさない）。
  **Esc は window で受ける**のでフォーカスの位置に関係なく閉じる。閉じるときは
  `preventDefault()` する（下の層は `event.defaultPrevented` を見て譲れる）。すでに消費された Esc と、
  手前に見えている層（`role="dialog"`・`role="menu"`・`data-esc-layer` で z-index が大きいもの、
  開いている popover、z-index が同じなら文書順で後ろのもの）があるときは譲る。
- **置き場所**: オーバーレイは `position: fixed`。`transform`・`filter`・`backdrop-filter` を持つ
  要素（glass のカードなど）の中に置くと、その要素が基準になって画面全体を覆わなくなるので、
  レイアウトの直下など外側に置く。

`StatusBadgeVariant`（`'neutral' | 'success' | 'warning' | 'danger' | 'info'`）と
`UiIconComponent`（`icon` に渡せる部品の型）、`UiMessages` / `defaultUiMessages`、
`CommandPaletteItem`・`CommandPaletteCloseReason`・`defaultCommandPaletteSearch`、トーストの
`createToastStore`・`DEFAULT_TOAST_DURATION_MS` と型 `Toast`・`ToastAction`・`ToastKind`・`ToastPushOptions`・`ToastStore`・
`ToastStoreOptions`、`Modal`・`Drawer` の型 `ModalProps`・`DrawerProps`・`OverlayProps` と層の補助
（下の「層の補助」）も export する。

トースト（段階 2c。**パッケージ唯一の `.svelte.ts`** を含む）:

| 部品 / 関数          | 役割                                                      | 引数                                |
| -------------------- | --------------------------------------------------------- | ----------------------------------- |
| `createToastStore()` | トーストのストア（runes）。`toasts`・`push`・`dismiss`    | `{ autoDismissMs?, maxToasts? }`    |
| `ToastHost`          | ストアを固定表示する部品（ルートのレイアウトに 1 つ置く） | `store` `messages?`（`toastClose`） |

- **`push(kind, message, options?)`** は id（文字列）を返す。`kind` は `'success' | 'error' | 'info' | 'warning'`
  （admin-core の `NotificationKind` と構造的に同じ）。`options`: `action?: { label, onAction }`・
  `durationMs?`・`id?`。
- **自動で消す**: 既定 4000ms（`autoDismissMs` か `durationMs` で変える。`0`・負・`Infinity` は消さない）。
  `dismiss` すると時間の数えも止まる。既に出ている `id` を渡すと、その場で置き換えて時間を数え直す
  （明示の `id` は意図した置き換え用。`id` を省くと `toast-N` を自動で振り、いま出ているどの `id` とも重ならない）。
  `maxToasts` を超えると古いものから消す（既定は無制限）。
- **アクション**: 押すと `onAction` を呼び、例外でもそのあとで閉じる。閉じた後（時間切れ・二度押し）は呼ばない。
  ボタンは `data-testid="toast-action-<id>"`。
- **読み上げ**: 常設の 2 つの領域に分ける。`error`・`warning` は `role="alert"`（`aria-live="assertive"`）、
  `success`・`info` は `role="status"`（`aria-live="polite"`）。閉じるボタンは `messages.toastClose()` の名前。
  アクション・閉じるはどちらも普通の `<button>`（Tab で届く）。
- **置き場所**: 右下の固定。CSS 変数 `--banto-toast-right`・`--banto-toast-bottom`（既定 `1rem`）で動かす。
  重なりは `--banto-z-toast`。
- **ストアが `.svelte.ts`**: `@banto/ui` を使う派生アプリは Vite の **`optimizeDeps.exclude` に `'@banto/ui'` を足す**
  （[ADR-0007](../../docs/adr/0007-derived-app-dev-optimizer-exclude.md)）。足さないと `pnpm dev` が 500 になる。

```ts
// アプリ側: ストアを 1 つ作り、admin-core の Notifier につなぐ
import { createToastStore } from '@banto/ui';
export const toastStore = createToastStore();
// setup.ts: const notifier = { notify: (kind, message) => toastStore.push(kind, message) };
toastStore.push('info', '削除しました', { action: { label: '取り消し', onAction: undo } });
```

```svelte
<ToastHost store={toastStore} messages={{ toastClose: () => '閉じる' }} />
```

モーダルとドロワー（段階 4。banto-industrial の banto-hub の部品を props ごと移したもの）:

| 部品     | 役割                                                                                       | 既定の `width` |
| -------- | ------------------------------------------------------------------------------------------ | -------------- |
| `Modal`  | 中央のダイアログ（fade + scale）。作成のウィザードなど、前後の画面を見ずに済む一方向の作業 | `'560px'`      |
| `Drawer` | 右端の全高のパネル（fade + 横から）。一覧を見ながら直す編集                                | `'480px'`      |

props は 2 つで同じ（型 `OverlayProps`）:

| prop                   | 型                                       | 意味                                                                                                     |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `open`                 | `boolean`                                | 出すか。**親が持つ**（部品は書き換えない。`onclose` で `false` にする）                                  |
| `title?`               | `string`                                 | 見出し（`<h3>`）とダイアログの名前（`aria-label`）。名前が要るので渡す                                   |
| `width?`               | `string`                                 | CSS の長さ（`'36rem'` など）。画面の幅から 2rem 引いた値を超えない（狭い画面でも収まる）                 |
| `closeOnOverlayClick?` | `boolean`                                | 背景（スクリム）そのもののクリックで閉じるか。既定 `true`。パネルの中のクリックでは閉じない              |
| `onclose?`             | `() => void`                             | 閉じてよいと決まったときに 1 回呼ぶ                                                                      |
| `onRequestClose?`      | `() => boolean`                          | Esc・背景・× のどれでも閉じる前に聞く。`false` で開いたまま（未保存の破棄確認・処理中の抑止）            |
| `dirty?`               | `boolean`                                | 未保存の入力があるか。`true` の間は **Esc と背景のクリックでは閉じず** `onBlockedClose` を呼ぶ。× は通す |
| `onBlockedClose?`      | `() => void`                             | `dirty` で Esc・背景が止められたことの通知（トーストで「× で閉じる」と案内するなど）                     |
| `focusFallback?`       | `() => HTMLElement \| null \| undefined` | 閉じたときに開いた元が消えている・`inert`・見えないときのフォーカスの行き先。無ければ動かさない          |
| `messages?`            | `UiMessages`                             | `overlayClose`（× の名前と title。既定 `'閉じる'`）                                                      |
| `children?`            | snippet                                  | 本文                                                                                                     |

- **閉じる経路は 1 つ**: Esc・背景のクリック・× は同じ処理を通り、`onRequestClose` → `onclose` の順。
  閉じると決めた後（閉じる動きの最中）に × をもう一度押しても、`onRequestClose` は二度聞かない。
- **フォーカス**: 開いたら最初のフォーカスできる要素（見出しの ×）へ移す。開いている間は閉じ込める
  （Tab は中で折り返し、外へ出たフォーカスは引き戻す）。閉じたら開いた時にフォーカスがあった要素へ戻す
  （同じ更新で消えた要素へは戻さず `focusFallback()` へ）。
- **Esc は手前の層から 1 つずつ**: Esc は window で受け、閉じるときは `preventDefault()` する。消費済みの
  Esc と、手前に見えている層（z-index が大きい・同じなら文書で後ろ・中に置いた自分の z-index を持つ層・
  開いている popover）には譲る。`Drawer` の本文の中に `Modal` を置けば、Esc はまず `Modal` を閉じる。
  `CommandPalette`（`--banto-z-overlay`）は `Modal`・`Drawer`（`--banto-z-modal`）より手前。
- **見た目**: 背景 `--banto-scrim`、面 `--banto-surface-overlay`（glass の `--banto-backdrop` が効く）、
  影 `--banto-shadow-lg`。動きは CSS で、長さと緩急はテーマの `--banto-duration-fast`・`--banto-duration-base`・
  `--banto-ease-out`（`prefers-reduced-motion` では 0ms）。閉じる動きのあいだは層を残し、もう無い層として扱う
  （`inert` にするので Tab・クリックも届かない）。止まっているパネルは `transform: none` なので、本文に置いた
  `Modal` は画面全体を覆って中央に出る。
- **置き場所**: `CommandPalette` と同じく `position: fixed`。`transform`・`filter`・`backdrop-filter` を
  持つ要素の中に置かない（glass のカードの中など）。`Drawer` の本文に `Modal` を置く場合、パネルが固定の子孫の
  基準になる環境（パネルに `transform`・`filter` を足したアプリの CSS や、`backdrop-filter` をそう扱う
  ブラウザ）では `Modal` の背景が `Drawer` の範囲になり、その外側のクリックは `Drawer` 自身の背景に当たる。
  それでも**手前に層がある間は背景のクリックでは閉じない**（Esc と同じく
  譲る）ので、中の `Modal` の `dirty`・`onRequestClose` を飛ばして一緒に閉じることはない。
- **非モーダルの右ペインは持たない**: banto-hub のタグ編集の右ペイン（広い画面）はページ側の分割表示で、
  この部品ではない。狭い画面ではページが `Modal`・`Drawer` に切り替える。

```svelte
<script lang="ts">
	import { Drawer } from '@banto/ui';

	let open = $state(false);
	let draft = $state('');
	const dirty = $derived(draft !== '');
</script>

<button type="button" onclick={() => (open = true)}>編集</button>
<Drawer
	{open}
	title="接続の編集"
	{dirty}
	onRequestClose={() => !dirty || window.confirm('変更を破棄しますか？')}
	onBlockedClose={() =>
		toastStore.push('info', '未保存の変更があります。閉じるには × を押してください。')}
	onclose={() => {
		open = false;
		draft = '';
	}}
>
	<input bind:value={draft} />
</Drawer>
```

### 層の補助

`CommandPalette`・`Modal`・`Drawer` が使う Esc とフォーカスの補助（`src/layering.ts`）を、アプリが自前の層
（狭い画面で退避するツリー・コンテキストメニュー・ページの Esc）に使えるよう公開している。仕組みは 1 つで、
層の約束（banto-industrial #378 / #381 の 7 項目）はファイル冒頭にある。

| export                                  | 役割                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hasVisibleLayerAbove({ except? })`     | 手前に見えている層があるか。`except` に自分の層の要素を渡す。省くと（自分が層でないとき）層が 1 つでもあれば真                                                                                     |
| `hasVisibleMenuLayer({ except? })`      | 見えている `role="menu"` があるか（メニューの上にパレットを開かない、など）。`except` を渡すとその層より手前のものだけ                                                                             |
| `hasVisibleModalLayer({ except? })`     | 見えている**モーダルな層**（`aria-modal="true"`）があるか。非モーダルの `role="dialog"`（dock の浮動 window）・`data-esc-layer`・メニューは数えない。`except` を渡すとその層自身と下の層は数えない |
| `attachFocusTrap(panel)`                | フォーカスを閉じ込める。外す関数を返す                                                                                                                                                             |
| `focusablesIn(panel)`                   | Tab で届く要素（`tabindex="-1"`・`:disabled`（無効な `fieldset` の中も）・`inert`・レイアウトされていないものを除く）                                                                              |
| `restoreFocus(target, fallback?)`       | `target` へ戻す。戻せなければ `fallback()` が返す要素へ（何も返さない `fallback` は自分で動かしてよい）                                                                                            |
| `canRestoreFocusTo(el)`                 | 戻せるか（接続・`<body>` でない・`inert` の外・見える）                                                                                                                                            |
| `effectiveZIndex(el)`                   | 祖先をたどった実際の z-index                                                                                                                                                                       |
| `isCloseAllowed(source, dirty)`         | `dirty` のとき Esc・背景では閉じない判定（型 `OverlayCloseSource`）                                                                                                                                |
| `LAYER_SELECTOR`・`MENU_LAYER_SELECTOR` | 層とみなす要素（`role="dialog"`・`role="menu"`・`data-esc-layer`）                                                                                                                                 |
| `MODAL_LAYER_SELECTOR`                  | モーダルな層（`[aria-modal="true"]`）                                                                                                                                                              |
| `LAYER_MARKER_ATTR`                     | `data-esc-layer`。role を名乗らない層に、開いている間だけ付ける                                                                                                                                    |
| `LAYER_INACTIVE_ATTR`                   | `data-layer-inactive`。閉じる動きの最中の層に付ける（もう無い層として扱う）                                                                                                                        |
| `FOCUSABLE_SELECTOR`                    | フォーカスできる要素のセレクタ                                                                                                                                                                     |

### コマンドとショートカット（#435-a）

操作の定義（`CommandSpec`）と、キーを受けてよいかの判定・dispatcher（`src/shortcut.ts`、
docs/design/shared-primitives-upstream-plan.md §3.6）。キーの配線（window の `keydown`）と command の一覧は
アプリが持つ。`@banto/admin-core` の `PaletteCommand` はそのまま `CommandSpec` として渡せる（構造的に互換）。

```ts
import { createShortcutDispatcher, formatShortcut } from '@banto/ui';

const shortcuts = createShortcutDispatcher(); // platform は navigator から（'mac' | 'other' を渡してもよい）
const off = shortcuts.register('page', [
	{
		id: 'record.save',
		title: m['record.save'](),
		shortcut: 'Mod+S', // Mod = Windows/Linux は Ctrl、macOS は Meta
		allowInEditable: true, // 入力欄の中でも受ける
		enabled: () => form.dirty, // 実行の直前にもう一度呼ばれる
		preventDefaultWhenDisabled: true, // 無効でもブラウザの「ページを保存」は出さない
		run: () => form.submit()
	}
]);
// <svelte:window onkeydown={(e) => shortcuts.handle(e)} />
formatShortcut('Mod+S', 'mac'); // '⌘S'（記号だけ。文言は持たない）
```

受けないとき（キーはブラウザと他のリスナーに残る）: IME の変換中（`isComposing`・`keyCode 229`）、
`defaultPrevented`、`repeat`（`allowRepeat` で受ける）、入力欄（文字入力の `input`・`textarea`・`select`・
`contenteditable`。`allowInEditable` で受ける）、モーダルな層かメニューが出ているとき（非モーダルの
`role="dialog"` では止めない。`ownerLayer` を渡した command は自分の層と下の層を数えない — パレットを開いた
まま Ctrl+K で閉じる、など）。後から `register` した scope が優先し、`visible` が偽のものは次へ譲る。

| export                                                 | 役割                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `createShortcutDispatcher({ platform? })`              | `register(scope, commands)`（外す関数を返す）と `handle(event)`（処理したら `preventDefault` して真） |
| `shouldHandleShortcut(event, spec)`                    | 上の保護だけを判定する（自前のキー処理用）                                                            |
| `parseShortcut`・`matchShortcut`・`formatShortcut`     | `'Mod+Shift+K'` の解釈・照合・表示                                                                    |
| `isEditableTarget(target)`・`detectShortcutPlatform()` | 入力欄の判定・`'mac' \| 'other'`                                                                      |

## LauncherBar（段階 5）

macOS のドックのようなアイコンのランチャー（[nav-launcher-plan.md](../../docs/design/nav-launcher-plan.md)、
ADR-0018 §11）。画面下に浮いたバーで、マウスを近づけたアイコンほど大きくなり、ホバーとキーボードの
フォーカスで名前のツールチップを出す。**表示と操作だけ**を持ち、ナビの定義・どの項目を出すか（権限）・
現在のページの判定（`active`）・バッジの件数・文言はすべて呼び出し側が渡す。リンクは素の `<a href>` なので、
SvelteKit のクライアント遷移は呼び出し側のアプリでそのまま効く（このパッケージは `$app/*` を知らない）。

| props       | 型                 | 既定       | 内容                                                                                                                                                                                                                                                             |
| ----------- | ------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groups`    | `LauncherGroup[]`  | （必須）   | `{ id, ariaLabel, items }`。グループごとに `<nav aria-label>` を 1 つ描き、あいだに区切り線                                                                                                                                                                      |
| `position`  | `LauncherPosition` | `'bottom'` | `'bottom'`（下端の中央）・`'top'`（上端の中央。`--banto-shell-launcher-inset-top` だけ下げる。拡大は下向き、ツールチップは下）・`'left'` / `'right'`（その端の縦中央の縦向きのバー。拡大は縦の軸、ツールチップは本文側の横）。900px 以下はどれでも下端のタブバー |
| `magnify`   | `boolean`          | `true`     | 拡大する。`prefers-reduced-motion`・`(hover: none)`・900px 以下・マウス以外では自動で止まる                                                                                                                                                                      |
| `ariaLabel` | `string`           | なし       | バー全体の名前（付けると全体が `role="group"`）                                                                                                                                                                                                                  |

`LauncherItem` は `{ id, href, label, icon, active?, badge?: { text, label } }`。`label` がツールチップ・
狭い画面の小さなラベル・アクセシブルな名前（視覚的に隠した実テキスト。`badge.label` も名前に入る）になり、
`active` のリンクに `aria-current="page"` が付く。ツールチップは `aria-hidden` で、Esc はフォーカスの位置に
よらず閉じる（手前に `hasVisibleLayerAbove()` の層があるときは譲る。イベントは奪わない）。
900px 以下では画面下端いっぱいのタブバー（アイコン + 小さなラベル、拡大なし、最小 44×44px、
`env(safe-area-inset-bottom)`、入り切らなければ横スクロール）になる。

寸法・倍率・重なり順はトークン（`--banto-shell-launcher-*`・`--banto-z-launcher`、
[@banto/theme](../theme/README.md)）で、`@banto/theme/css` を読み込むこと（倍率のトークンが読めなければ
拡大しない）。バーは `position: fixed` なので、本文の下（上・左右に置くならその側）に
`--banto-shell-launcher-reserve` の余白を取るのは呼び出し側の仕事（900px 以下はどの位置でも下に
`--banto-shell-launcher-tabbar-reserve`）。上に置くときは、シェルのヘッダーの高さを
`--banto-shell-launcher-inset-top` に入れるとバーがヘッダーの下に来る（ヘッダーのメニューは
`popover` の最上位の層なのでバーより手前に出る）。拡大の曲線は純粋関数 `magnifyScale(distance, range, max)` として公開している。

```svelte
<script lang="ts">
	import { LauncherBar, type LauncherGroup } from '@banto/ui';
	import { House, Package, Users } from '@lucide/svelte';
	import { page } from '$app/state';

	const groups: LauncherGroup[] = $derived([
		{
			id: 'main',
			ariaLabel: '主要ナビゲーション',
			items: [
				{ id: 'home', href: '/', label: 'ホーム', icon: House, active: page.url.pathname === '/' },
				{
					id: 'items',
					href: '/items',
					label: '品目',
					icon: Package,
					active: page.url.pathname.startsWith('/items'),
					badge: { text: '3', label: '3 件の更新' }
				}
			]
		},
		// 権限で出し分けるのは呼び出し側（例: 管理者だけに渡す）
		{
			id: 'admin',
			ariaLabel: '管理ナビゲーション',
			items: [{ id: 'users', href: '/users', label: 'ユーザー', icon: Users }]
		}
	]);
</script>

<LauncherBar {groups} />
```

## 使用例

```svelte
<script lang="ts">
	import { PageHeader, StatusBadge, SurfaceCard, LoadingState, EmptyState } from '@banto/ui';
</script>

<PageHeader title="商品" description="登録済みの商品の一覧です。">
	{#snippet actions()}
		<button type="button">新規作成</button>
	{/snippet}
</PageHeader>

<SurfaceCard title="状態">
	<StatusBadge variant="success" label="稼働中" />
</SurfaceCard>

<LoadingState label="商品を読み込み中…" />
<EmptyState title="商品がありません" />
```

```svelte
<script lang="ts">
	import { Menu, MenuGroup, MenuItem, MenuSeparator } from '@banto/ui';
</script>

<Menu label="ユーザーメニュー">
	{#snippet trigger(props)}
		<button {...props} type="button">メニュー</button>
	{/snippet}
	<MenuGroup label="アカウント">
		<MenuItem label="設定" onSelect={openSettings} />
	</MenuGroup>
	<MenuSeparator />
	<MenuItem label="ログアウト" danger onSelect={logout} />
</Menu>
```

`Menu` は項目が多くてトリガーの上下どちらにも収まらないとき、広い側の可用高（余白・枠線込み）に高さを抑えて中をスクロールする。メニュー自身のスクロール（ホイールや End・矢印で項目へ移ったときの自動スクロール）では閉じず、外側のスクロールでは従来どおり閉じる。

```svelte
<script lang="ts">
	import { CommandPalette, type CommandPaletteItem } from '@banto/ui';

	let open = $state(false);
	const items: CommandPaletteItem[] = [
		{ id: 'nav.items', title: '商品', group: 'ナビゲーション', keywords: ['items'] },
		{ id: 'theme.dark', title: 'ダークテーマにする', group: 'テーマ', shortcut: 'Ctrl+D' }
	];
</script>

<button type="button" onclick={() => (open = true)}>コマンド</button>
<CommandPalette
	bind:open
	{items}
	onExecute={async (item) => {
		await runCommand(item.id);
	}}
/>
```

`LoadingState` の `label`（読み上げ文言）を省くとパッケージ既定の `defaultUiMessages.loading()`
（`'読み込み中…'`）になる。多言語化するアプリ（admin-template は Paraglide）は、
**既定に頼らず `label` を明示する**（英語表示で日本語が出ないように）。`CommandPalette` の
文言（`commandPaletteLabel`・`commandPalettePlaceholder`・`commandPaletteListLabel`・
`commandPaletteEmpty`・`commandPaletteRecent`）も同じで、既定は日本語。多言語化するアプリは
`messages` で渡す。

## アイコン

`icon` には `size` と `aria-hidden` を受ける Svelte 部品なら何でも渡せる（型は
`UiIconComponent`）。`@lucide/svelte` の部品はそのまま渡せる。このパッケージは lucide に
依存しない。**既定のアイコン**（Inbox・OctagonAlert・Circle・CircleCheck・TriangleAlert・
CircleAlert・Info の 7 つと、`Modal`・`Drawer` の × に使う X、`DateInput` の Calendar・ChevronLeft・ChevronRight・
ChevronsLeft・ChevronsRight、`TimeInput` の Clock）は lucide の SVG を `src/icons/` に同梱した
もので、アイコン集としては公開しない。同梱アイコンは ISC（一部は Feather 由来の MIT）で、表記は各ファイルの先頭と
[src/icons/LICENSE](src/icons/LICENSE) にある。

## テーマ

スタイルは各部品のスコープ付き `<style>` に置き、`--banto-*` トークンだけを参照する。
消費側が `@banto/theme/css` を読み込むこと（無いとトークンが解決されず、色や寸法が
崩れる）。オーバーレイの背景と重なり順は `--banto-scrim`・`--banto-z-*` トークンを使う
（[@banto/theme](../theme/README.md)）。

```css
/* app.css 等 */
@import '@banto/theme/css';
```

## 依存

`dependencies`/`peerDependencies` は空。`svelte` も宣言しない（消費側の解決に任せる）。
`@banto/*` 間の import もゼロ（コアパッケージ、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 見本

admin-template の `/ui-demo`（デモモードのときだけナビに出る）に各部品の主要な状態を
並べてある（メニュー・コマンドパレット・モーダル・ドロワーはボタンから開く）。

## 関連ドキュメント

- [ADR-0018: 汎用 UI 部品は新パッケージ `@banto/ui` へ段階的に切り出す](../../docs/adr/0018-shared-ui-package.md)
- 本体リポジトリ: https://github.com/tyaro/banto
