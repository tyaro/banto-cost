# @banto/dock-svelte

Banto のフローティングウィンドウ/ドッキングレイアウト（spec §5）。
分割・タブ化・ドラッグでの再配置・スナップ、レイアウトの JSON
保存/復元を提供する。M7 でフローティングウィンドウ、M8 でドッキング
ツリー（分割/タブ）を追加した。

## 使用例

```svelte
<script lang="ts">
	import { DockHost, createDockState } from '@banto/dock-svelte';

	const dock = createDockState({
		version: 2,
		floating: [
			{ id: 'trend', title: 'トレンド', x: 40, y: 40, width: 360, height: 240, open: true }
		],
		docked: null
	});
</script>

<DockHost {dock}>
	{#snippet panel(content)}
		<p>{content.title} の中身</p>
	{/snippet}
</DockHost>
```

## host の縮小と浮動 window の到達性

浮動 window は「保存してある希望の配置（layout の x / y / width / height）」と「いま描く配置」を分けて扱う
（shared-primitives-upstream-plan §3.2、#434）。host が縮むと、描く配置だけが host 内に収まるよう補正され、
**保存した希望は書き換わない**（host が戻れば希望の位置へ戻る。`serialize()` の結果も縮小の前後で同じ）。
move / resize は描いている位置から始まり、確定した結果が新しい希望になる。

`DockHost` の `clamp` で、補正の方針を consumer が渡す（省略時は汎用の既定値 `DEFAULT_MIN_*`。アプリ固有の数値は
パッケージに固定しない）:

```svelte
<DockHost {dock} {panel} clamp={{ minW: 280, minH: 240, minVisible: 64, narrowHost: 'fit' }} />
```

- `minW` / `minH` — 最小の幅・高さ。
- `minVisible` — host 内に必ず残す px（タイトルバーを掴み直せる量）。
- `narrowHost` — host が最小寸法より狭いとき。`'overflow'`（既定。最小寸法を保ち、`minVisible` だけ到達可能）／
  `'fit'`（その軸は host の大きさに縮め、window 全体を見せる）。

純関数 `clampWindowToHost`（操作の結果の補正）と `displayWindowGeometry`（描画用。host が未計測の間は保存値のまま）も
export している。

## pane の能力（必須 pane の保護）

`DockHost` の `capabilities` で pane ごとに UI の操作を絞れる（省略時はすべて可）:

```svelte
<DockHost
	{dock}
	{panel}
	capabilities={(id) =>
		id === 'canvas' ? { close: false, move: false, undock: false } : undefined}
/>
```

- `close: false` — 閉じるボタンを出さない。
- `move: false` — タイトルバー / タブのドラッグによる移動・再配置をしない（浮動 window の resize は別）。
- `undock: false` — docked pane を浮動化・pop-out しない（空き領域へのドロップは無視され、pop-out ボタンも出ない）。

これは UI の口であって権限の仕組みではない。`dock.close(id)` などをコードから呼べば動くので、守りたい pane は
アプリ側の呼び出しも絞ること。アプリ固定の標準配置は、独自の default layout を `createDockState(layout)` に渡す
（パッケージは SCADA などの panel ID を持たない）。

## 操作の確定と取消（ドラッグ・resize・divider）

`DockHost` の中のポインタ操作（タイトルバー / タブのドラッグ、浮動 window の resize、分割の
divider）は、host ごとに 1 つの持ち主が 1 回の操作として扱う（#433）。

- 同時に 1 つの操作だけ。操作中のほかの pointer（2 本目の指など）は動かさず、確定もさせない。
- **確定**は、操作を始めた pointer の `pointerup` だけ。確定の直前に host の寸法を測り直す
  （window の resize の通知が来る前に離しても、古い寸法では確定しない）。
- **取消**は、Esc（ほかの層が `preventDefault` 済みなら譲る。受けたら `preventDefault` する。IME 変換中は
  見ない）・`pointercancel`・`lostpointercapture`・window の `blur`・タブが隠れたとき・`DockHost` の
  unmount。resize は対象の window の位置と寸法だけ、divider は対象の split の比率だけを押す前に戻す
  （操作中にアプリが layout を変えていても、その変更は残る）。押した window が前面に来るのは押したこと
  （フォーカス）の結果なので、取消でも前面のまま。ドラッグは確定まで layout を書かないので、取消では何も変えない。
- 浮動 window は `pointerdown` に加えて `focusin`（Tab や中の入力欄へのフォーカス）でも前面に来る。
  前面化は `z-index` で行い、DOM の順（= Tab の順）は変えない。

## キーボード操作と操作の hook

キーは、フォーカスが dock の中の操作要素（divider・タブ・浮動 window のモードのボタン）にあるときだけ
受ける（window の keydown では受けない）。入力欄の中のキー、IME 変換中（`isComposing` / `keyCode 229`）、
Ctrl / Alt / Meta との組み合わせ、ほかが `preventDefault` 済みのキーは受けない。

| 対象                                                                                                                                                               | キー                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| divider（WAI-ARIA の Window Splitter。フォーカスできる `separator` で、`aria-valuenow` / `-valuemin` / `-valuemax` は区切る 2 つの pane のうち先の pane の割合 %） | 矢印（横並びは ← →、縦並びは ↑ ↓）で split の 2%、Shift で 10%。Home / End で最小 / 最大                                                                                                                                                            |
| タブ（roving tabindex。Tab で止まるのは選択中のタブだけ）                                                                                                          | ← →（端で折り返す）・Home / End で選んでフォーカスを移す                                                                                                                                                                                            |
| 浮動 window の移動 / サイズ変更                                                                                                                                    | タイトルバーのボタン（フォーカスが来たときだけ見える）でモードに入る → 矢印で 10px、Shift で 50px（サイズ変更は右下の角から）→ Enter かボタンをもう一度で確定、Esc で取消（その window の位置と寸法だけを戻す）。フォーカスがボタンから外れても取消 |

`DockHost` の props で、アプリが操作をつなげる（どれも省略できる）:

```ts
canStartGesture?: (kind: DockGestureKind, panelId: string | null) => boolean; // false で始めない
onGestureEnd?: (kind: DockGestureKind, outcome: 'commit' | 'cancel', reason?: DockCancelReason) => void; // 1 回だけ
isEscapeBlocked?: (activeLayer: HTMLElement | null) => boolean; // true で Esc を上位の層に譲る
```

- `canStartGesture` は操作が始まる前に聞く。タイトルバー / タブの押下はクリック（タブの選択）かもしれない
  ので、閾値を越えたときに `drag` として聞く（拒否したらその押下の残りは何もしない）。divider のキー 1 回は
  `divider` として聞く。
- `onGestureEnd` は操作が閉じた後（確定した、または対象を戻した後）に 1 回だけ呼ぶ。中で次の操作を
  始めても `DockHost` を unmount してもよい。
- `isEscapeBlocked` の `activeLayer` は、浮動 window の操作ならその root（`role="dialog"`）、docked の
  pane・divider なら `null`。浮動 window はどれも**非モーダルの** `role="dialog"` なので、どの dialog でも
  数える判定では Esc で取り消せなくなる。`@banto/ui` を使うアプリは次をつなぐ（dock-svelte は `@banto/ui`
  を import できないので、つなぐのはアプリ。apps/admin-template の `dockEscape.ts`）:

```ts
import { hasVisibleLayerAbove, hasVisibleMenuLayer, hasVisibleModalLayer } from '@banto/ui';
const isEscapeBlocked = (el: HTMLElement | null) =>
	el ? hasVisibleLayerAbove({ except: el }) : hasVisibleModalLayer() || hasVisibleMenuLayer();
```

見える文言（モードのボタンの `aria-label`）は `messages` の `moveWindow` / `resizeWindow` で差し替える。

## pane の lifecycle（構造変更の前の確認・中身の保持・hide と close）

中身の寿命に関わる**構造変更**（dock / undock / docked pane の移動 / タブの切替 / hide / close）の前に、アプリが
確かめて止められる（#432。設計は docs/design/shared-primitives-upstream-plan.md の §3.5・§4.2・D3・D4）。

```ts
type DockPanelChange =
	| { kind: 'dock' | 'undock' | 'move-docked'; panelId: string; remount: true }
	| { kind: 'tab-switch'; groupId: string; from: string; to: string; remount: boolean }
	| { kind: 'hide'; panelId: string; remount: boolean }
	| { kind: 'close'; panelId: string };

beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>; // true のときだけ変える
keepMounted?: (panelId: string) => boolean; // 見えないあいだも中身を mount したままにする pane
isStructureChangeDeferred?: () => boolean; // true のあいだ構造変更を保留（省略時は IME 変換中）
```

- **`beforePanelChange`**: `true`（または `true` に解決）のときだけ layout を変える。`false`・ほかの値・例外・
  reject では変えない（変えないのは対象だけで、layout 全体を戻すことはしない）。確認の UI はアプリが出す。
  ドラッグでは、操作が閉じた後（確定の一点）に聞くので、確認を待つあいだ pointer の操作は残らない。拒否
  されると pane は元の場所のまま。**非同期の答え**は、適用の直前に確かめ直し、次のどれかなら採らずに
  `stale` を返す: 待つあいだに layout の構造（docked の形・選択中のタブ・浮動 window の有無と open）が一度でも
  変わった（`DockState.structureRevision` の世代で見るので、close → open やタブ A → B → A で同じ形に戻っても
  `stale`。位置・寸法・split の比率・前後関係の変化は数えない）、または今の状態で組み立て直した変更が聞いた
  ものと違う（`keepMounted` が変わって `remount` が変わった、`tab-switch` の `from` が変わった）。`DockHost` が
  unmount されたら、答えを待っている要求（解決しない Promise を含む）はすぐに `disposed` になる。
  **同じ要求**は、変更と行き先（ドロップ先と領域・undock の位置）が同じもの。答えを待つあいだの同じ要求
  （✕ の二度押し）はもう一度聞かない。行き先が違う要求（X へのドロップを待つあいだに Y へドロップ）は別に
  聞き、先に許可されたほうが適用され、もう一方は構造が変わったので `stale` になる。浮動 window の移動・
  resize・divider（幾何だけの変更）と、アプリが `DockState` を直接呼ぶ変更は聞かない。
- **`remount`**: `true` は中身がいったん unmount され、あとで別に mount されること（draft を capture しておけば
  次の mount で戻せる）。`false` は DOM が残ること。`tab-switch` では `from` の pane のこと。dock / undock は
  docked の木と浮動の層をまたぐので、`keepMounted` でも常に `true`。
- **`keepMounted`**: その pane の中身を、表示していないタブのあいだ・hide した浮動 window のあいだ、
  `hidden` + `inert` で同じ DOM のまま残す（IME・選択・scroll・未完成の入力が残る）。そのぶんメモリと effect は
  常にかかる。`keepMounted` でない pane は今までどおり、見えなくなると unmount する。

### hide と close（D4）

| 操作                              | 中身                                                                                                           | `beforePanelChange` |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| ✕ ボタン（`keepMounted` の pane） | **hide**: 浮動 window は中身を保ったまま隠す。docked の pane は閉じた浮動 window になる（そこで mount し直す） | `hide`              |
| ✕ ボタン（それ以外）              | **close**: 中身を捨てる（今までと同じ）                                                                        | `close`             |
| `host.hidePanel(id)`              | hide（上と同じ）                                                                                               | `hide`              |
| `host.closePanel(id)`             | close。`keepMounted` の pane でも中身を捨てる（隠れている中身も捨てる）。次に開くと新しく mount する           | `close`             |

どれも window の位置と寸法は残す（次の `dock.open(id)` で同じ場所に出る）。`hidePanel` / `closePanel` /
`resumeDeferredChange` は `bind:this` で得た `DockHost` から呼び、結果（`DockPanelChangeOutcome`:
`applied` / `refused` / `stale` / `superseded` / `disposed`）を返す。中身を捨てる close を ✕ 以外（メニュー・
コマンド）に置くのはアプリ。アプリでのつなぎ方（hide・tab-switch・dock は draft の capture だけ、close は
確認して apply / discard / cancel）は計画書 §3.5 の遷移ごとの表を見る。

### IME 変換中は構造変更を保留する

`isStructureChangeDeferred()` が `true` のあいだ（省略時: document で `compositionstart` があって
`compositionend` がまだ来ておらず、その要素がまだ文書にあってフォーカスを持つあいだ）:

- `drag`（dock / undock になりうるドラッグ）は始めない。浮動 window の resize・キーボードの移動 / サイズ変更・
  divider は始める（中身の DOM を壊さない）。
- 構造変更の要求（タブのクリック・✕・`closePanel` など、変換中に確定したドラッグも）は、聞かず・変えずに 1 つ
  だけ持っておき（要求を作った順で新しいほうを残し、古いほうは `superseded`。遅れて許可が返った古い要求が、持っている新しい要求を追い出すことはない。すでに古くなった許可は持たずに `stale`）、document の `compositionend` / `focusout` の次の
  タスクで改めて `beforePanelChange` に聞いて進める。独自の判定を渡したときは、判定が `false` になったら
  `resumeDeferredChange()` を呼ぶ（`compositionend` / `focusout` でも試す）。DOM を壊して変換を戻せるとは仮定しない。
- 保留は、非同期の答えが返ったときにも確かめ直す。答えを待つあいだに変換が始まったら、許可は同じように持って
  おき、変換が終わってから（聞き直さずに）適用する。持っているあいだにアプリが構造を変えたら、その要求は
  `stale` になる（保留した時点の構造の世代と比べる）。

### どれが先に効くか

1. `capabilities` — 操作の口そのもの（✕ を出さない・ドラッグにしない）。
2. `isStructureChangeDeferred` — `drag` を始めない（変換中）。
3. `canStartGesture` — 操作を始めるか（`drag` は閾値を越えたとき）。
4. `beforePanelChange` — 操作が確定したとき・ボタンを押したときに、layout を変えるか。

## 保存の約束（serialize / hydrate と書き込みは別）

`serialize()` は文字列を返すだけで、`hydrate(json)` は文字列を検証して layout に採るだけ。**実ストレージへの書き込み
（localStorage・設定 DB など）はアプリの責任**で、このパッケージは永続化を持たない。

- 書き込みが失敗したら「保存済み」の印（最後に成功した snapshot）を更新しない。失敗した内容を保存済みとして
  扱うと、次の起動や再試行で古い内容を新しいものと取り違える。
- 失敗した書き込みは、次の変更または再試行で最新の `serialize()` を改めて書く。成功した snapshot だけを
  読み戻しの元にする。
- `hydrate` の戻り値（`boolean`）が `false` のときは現行 layout が残っている。読み込み元（ストレージ）の値を
  「保存済み」と見なしてよいかは、この戻り値で決める。

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（オプションパッケージだが他オプションにも依存しない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/ui-framework-spec.md §5](../../docs/ui-framework-spec.md)（フローティングウィンドウ/ドッキングレイアウトシステム仕様）
