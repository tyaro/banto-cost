# SCADA Designer の共有部品を banto へ戻す計画書（Issue #432〜#438）

作成日: 2026-10-21
状態: **v6.8.0 でリリース済み**。D1〜D11 はすべて決定（2026-10-21、§9。D6・D10 はオーナーの選択、ほかは推奨どおり）。PR-1〜PR-14（段階 1〜5。dock / forms の部品、#432 のアプリ統合と #435 のアプリの配線、#438 の新パッケージ `@banto/image-assets` の骨格・ADR-0020・取込の検査と hash・原本と URL の寿命）はすべてマージ済みで、PR-15（文書: upgrading・recipes・本書の状態行）で完了する（§5.1）。Issue #432〜#438 に対応する PR はすべてマージ済み。v6.8.0 は #429 でリリース済み（2026-10-21）。
トラック: 保守者向け（トラックA）
関連: Issue #432〜#438 / [nav-launcher-plan.md](nav-launcher-plan.md)（書式の手本）/
[ADR-0018](../adr/0018-shared-ui-package.md)（`@banto/ui`。§10 の層の約束）/
[ADR-0002](../adr/0002-minimal-dependencies.md) / [ADR-0007](../adr/0007-derived-app-dev-optimizer-exclude.md) /
conventions §2 / §3 / §4 / §5 / §8 / §12 / §13 / §14、template-scope §1 / §2.1 / §3 / §3.1 /
spec §5（ドック）・§7（フォーム）・§12.1（UI 設定の永続化）・spec M16（コマンドパレット）

コードの行番号は main `d5c0777` 時点。行は動くので、本文はシンボル名も併記する（conventions の
「参照の書き方」）。

## 1. 目的と範囲

7 件の Issue は、どれも派生アプリ tyaro/temp-scada（SCADA Designer）で作った仕組みを、汎用の部品として
banto に戻したいという提案である。どの Issue も「公開 API の名前・置くパッケージは未決定。上流で検討
したい」としている。本書は 7 件を一つの計画にまとめ、置き場所・API の形・順番・PR の分け方・リリースとの
関係を決めるための材料と推奨を出す。

| Issue | 要旨 | 種類 |
| --- | --- | --- |
| #432 | 未適用入力の保持と pane 切替前の guard（`@banto/forms` の拡張 + `@banto/dock-svelte` の lifecycle 連携）。Issue 自身が最優先とする | feat |
| #433 | 移動・resize・divider の取消と pointer 所有者の統一、keyboard 操作、focusin での前面化 | fix（+ 一部 feat） |
| #434 | 復元 layout の幾何・ID 検証、host 縮小時の到達性（表示用 clamp と保存希望の分離） | fix（+ 一部 feat） |
| #435 | 操作定義とショートカット保護（`PaletteCommand` / `searchCommands` と連携） | feat |
| #436 | 古い非同期結果の不採用と一時資源の解放（小さな primitive） | feat |
| #437 | UI 設定の現在値と保存成功 snapshot の管理（`UiSettingsProvider` の上の helper） | feat |
| #438 | ブラウザ画像の原本・取込検査・URL 寿命管理 | feat |

前提（全 Issue 共通）: banto から temp-scada へ依存を作らない。SCADA の Project・Undo・作図・業務判断は
callback 側に残し、banto は最小の再現と共通契約を自分のテストへ抽出する。全機能を一度に移す前提にしない。

**対象外**（各 Issue の「対象外」と本文の除外をまとめたもの）:

- ディスクへの draft 永続化・期限・複数タブ同期（#432。現行の「Confirm, don't restore」の理由は §2.1）。
- 全フォームの `BantoForm` 化の強制（#432。既存の自作フォームは adapter で接続する）。
- 永続ストレージ自体を `@banto/dock-svelte` に足すこと（#434。serialize と書き込みの区別を文書化するだけ）。
- SCADA の panel ID・最小寸法（280×240 など）・左右固定の標準配置を banto に固定すること（#434）。
- SCADA の図形整列・削除・Project 保存の中身、Undo の実装、独自のコマンドパレットの新設（#435）。
- 認証の整合性（credential revision）を汎用の要求番号に置き換えること（#436）。
- 既存の即時保存の UX（テーマ設定など）を一律に明示保存へ変えること（#437）。
- Project 内の Asset 宣言、Undo の参照 roots、SCADA のパッケージ形式、crop / fit / 配置座標、添付の
  アップロードとサーバーの認可、WebP / SVG / APNG への対応（#438）。現行 `AssetStore` の丸ごとの移植もしない。
- サーバー側の検査の代替（#438。ブラウザ側の検査はサーバーの `detect_mime` を置き換えない。conventions §6）。

## 2. 前提となる制約（全 Issue にかかる）

### 2.1 パッケージ間の import は禁止（conventions §4・§5、ADR-0018 §5）

`packages/*` の `dependencies` / `peerDependencies` は空で（rule `empty-deps`）、`packages/*/src` の素の
import 指定子は `svelte`・`svelte/*` と相対パスだけ（rule `package-bare-imports`）。**`@banto/forms` は
`@banto/admin-core` を、`@banto/dock-svelte` は `@banto/forms` や `@banto/ui` を import できない。**

この制約が置き場所の判断の大半を決める:

- #436 の primitive をどこに置いても、別のパッケージ（forms・dock-svelte・画像）は import できない。
  使えるのはアプリと、同じパッケージの中だけ（§4.1、D1）。
- #432 の「forms と dock の連携」は、どちらかがもう一方を知る形にできない。dock は汎用の lifecycle hook を
  出し、forms は汎用の「保留中か・確認するか」の口を出し、**アプリが両者をつなぐ**（§4.2）。
- #433・#435 の「上位の Menu / Modal の Esc を奪わない」は、`@banto/ui` の `layering.ts` を dock-svelte から
  呼べない。dock-svelte は `event.defaultPrevented` と注入された判定（hook）で譲る（§4.3）。

これを変える（パッケージ間 import を許す）のは §4 の不変条件の変更で、派生アプリの Git 依存
（`path:packages/*`）の入れ方も変わる。本計画では採らない（D1 の c）。

### 2.2 template-scope §1 の 4 条件

| # | 基準 | 本計画での読み方 |
| --- | --- | --- |
| 1 | 横断性 | どんな管理画面でも要るか。ドック・フォーム・コマンド・UI 設定は既にコア / オプションとして入っている機能の不足を埋めるもの |
| 2 | 削除容易性 | 既存パッケージの中に足すなら、そのパッケージの削除手順（recipes/remove-optional-assets.md）に乗る。新パッケージなら §3 の表に行と削除手順が要る |
| 3 | 代替不能性 | 外部ソフトで済まないか。UI の内部の仕組みなので外部ソフトでは代替しにくい。ただし依存を足す案は conventions §3 で不可 |
| 4 | 無ドメイン性 | SCADA の語彙（タグ・作図・Project）を持ち込まないか |

### 2.3 そのほか

- **UI 文言はキー経由**（conventions §13）: パッケージは辞書を持たず、`messages` props で解決済みの文字列を
  受け取る。temp-scada の実装は日本語の例外メッセージを直書きしている（例: `image-assets.ts` の
  `inspectImage`）。banto へ移すときは**エラーコード**を返し、文言はアプリが決める。
- **`.svelte.ts` のソース配布**（conventions §14）: 新しく `.svelte.ts` を持つパッケージが出たら
  `optimizeDeps.exclude` と外部利用 fixture に足す。#436・#435・#437・#432・#433・#434 は既に exclude にある
  admin-core・dock-svelte・forms・ui の中で完結する。新パッケージは #438 の `image-assets` だけ（D6-a）で、
  `.svelte.ts` を持つようになった PR で exclude と fixture に足す（ADR-0020 §6）。
- **Svelte 5 runes の落とし穴**（conventions §8）: object URL は所有者が revoke、非同期レースは token で
  無効化、`$effect` の中の副作用は `untrack`。#436・#438 はこの節の 2・3 番目の箇条を部品にする提案で、
  実装したら §8 の本文を部品への参照に書き換える。
- **doc コメントは仕様節を参照**（conventions §12）: 新モジュールの冒頭は `spec §N` と本書の節
  （`shared-primitives-upstream-plan §N`）を引く。

## 3. Issue ごとの調査と提案

### 3.1 #436 古い非同期結果の不採用と一時資源の解放

**現状**: 同じ考え方が少なくとも 3 か所に別々に書かれている。

- `packages/admin-core/src/list.svelte.ts:33-61`（`ListResource` の `#requestToken`）: `++token` で開始し、
  結果の反映前に照合し、`finally` では自分が最新のときだけ `loading = false`（旧要求の `finally` が新要求の
  busy を解かない）。#436 の受入候補の 2 番目そのもの。
- `packages/attachments/src/AttachmentsPanel.svelte:71-111`（`loadToken`）: 失効した結果の object URL を
  revoke する（一時資源の解放）。conventions §8 の「非同期レースは loadToken で無効化する」の実例。
- `packages/admin-core/src/sessionController.svelte.ts:913-917`（`ticket()` / `isCurrent()`）: epoch と
  credential revision の照合。**認証用で、汎用化の対象ではない**（Issue も「置き換えない」と明記）。
- `packages/forms/src/unsavedChanges.svelte.ts:236-`（`guardUnsavedChanges` の `canAutoNavigate`）: 保存後の
  遅延 navigate を抑止する。要求番号ではなく「離脱が決まったか」の判定で、別の概念。

足りないもの: cancel（`AbortSignal`）と「abort できない処理の結果を捨てる」の区別、対象の変化による失効
（consumer が決める鍵）、unmount による一括失効、一時資源の「成功・失敗・失効のどの経路でも一度だけ解放、
採用したら所有者へ移譲」。temp-scada では `image-import.svelte.ts` が request 番号・owner generation・
対象 epoch の 3 つを手で照合している（`++imageReadRequest`、`if (request === imageReadRequest) imageBusy = false`）。

**4 条件**: 1 ○（一覧・添付・設定・フォームの適用で既に必要。§3 の 3 か所が証拠）/ 2 ○（既存パッケージの
1 モジュール。使わなければ tree-shake される）/ 3 ○（依存を足さない。`AbortController` は標準）/ 4 ○。

**置き場所（推奨 D1-a）**: `@banto/admin-core` に 1 モジュール（仮称 `request.svelte.ts`）。
admin-core は既に headless な非同期の仕組み（list・snapshot・sessionController）の家で、#437 も同じ
パッケージに入るので直接使える。forms は import できないので、#432 の適用処理は**同じ契約の内部実装**を
forms の中に持つ（数十行。conventions §3 の `civil_from_days` を 3 か所に移植した前例と同じ扱いにし、
契約の表を両方のテストで共有する）。

**API の草案**（名前はすべて仮。シグネチャは実装 PR で確定）:

```ts
/** 1 つの所有者（画面・controller）に属する要求の束。unmount で dispose する。 */
export interface RequestOwner {
	/** `key` ごとに新しい要求を始める。同じ key の前の要求は失効し、その signal は abort される。 */
	begin(key?: string): RequestHandle;
	/** 対象が変わった（consumer が決める）。その key の現在の要求を失効させる。 */
	invalidate(key?: string): void;
	/** 全要求を失効させ、未採用の一時資源を解放する。以後の begin は即失効の handle を返す。 */
	dispose(): void;
	readonly disposed: boolean;
	/** その key の**最新の**要求が未完了なら true（旧要求の finish では false にならない）。 */
	busy(key?: string): boolean;
}

export interface RequestHandle {
	/** 失効（新要求・invalidate・dispose）で abort される。fetch 等に渡す。 */
	readonly signal: AbortSignal;
	/** まだ最新で、所有者も生きているか。結果を反映する直前に見る。 */
	isCurrent(): boolean;
	/** 一時資源を預ける。finish 時に未採用なら release を一度だけ呼ぶ（失効・失敗・dispose の経路も）。 */
	hold<T>(resource: T, release: (resource: T) => void): T;
	/** 預けた資源を所有者へ移す（release を呼ばなくなる）。isCurrent() が false なら false を返し移さない。 */
	adopt(resource: unknown): boolean;
	/** 要求を終える（try/finally で必ず呼ぶ）。未採用の資源を解放し、最新なら busy を解く。二度目は何もしない。 */
	finish(): void;
}

export function createRequestOwner(): RequestOwner;
```

- abort できない処理（`createImageBitmap` など）は signal を無視して最後まで走り、`isCurrent()` が false なら
  結果を捨てる。失効した要求はモデル・履歴・busy・エラー表示を上書きしない。
- clipboard など user activation が要る処理は、**要求の開始を同期で行う**（`begin` 自体は同期で、
  activation を消費しない）。完了済みの OS clipboard 書き込みは巻き戻せないので、失効時に約束するのは
  「古い切り取り元を削除しない」まで（Issue の受入候補どおり）。この区別は doc に書く。
- busy を `$state` にするかは実装 PR で決める（反応性が要るのは表示だけなので、`busy()` を `$derived` から
  読める形にする想定。**未確認**: `SvelteMap` で足りるか）。

**既存 API との関係**: 追加だけ（minor）。`ListResource` の `#requestToken` を内部でこの部品に置き換えて
最初の consumer にする（挙動は同じ。既存の `list.test.ts` で確かめる）。`sessionController` は触らない。

**テスト**: 単体（vitest、node 環境で足りる。DOM 不要）— 後から始めた要求が先に終わる、対象変更、
dispose、失敗、`hold` の解放が成功・失敗・失効の各経路で一度だけ、`adopt` 後は解放しない、旧要求の
`finish` が新要求の busy を解かない。表駆動にして、forms の内部実装（§3.5）のテストと同じ表を使う。

### 3.2 #434 復元 layout の幾何・ID 検証と host 縮小時の到達性

**現状**:

- `packages/dock-svelte/src/state.svelte.ts:42-107`（`isFloatingWindow` / `isDockNode` / `isDockLayoutV2` /
  `isDockLayoutV1`）は `typeof === 'number'` しか見ない。`JSON.parse` は `1e999` を `Infinity` にするので
  通り、負の幅・0 の高さ・重複 ID・`activeIndex` の範囲外も通る（Issue の観測と一致）。
- 同 `:134-141`（constructor）は `DockLayout` のオブジェクトを**検証せずに**そのまま入れる。
- 同 `:330-345`（`hydrate`）は不正なら黙って無視し（戻り値 `void`）、呼び出し側は採用されたか分からない。
- `packages/dock-svelte/src/core/geometry.ts:30-56`（`clampWindowToHost`）の doc は「host の縮小でも
  window が到達不能にならない」と書くが、clamp は `move` / `resize` / 新規配置のときだけ呼ばれ、結果を
  layout に**書き戻す**。`DockHost.svelte:79`（`bind:clientWidth`）で host の寸法が変わっても再 clamp は
  無く、`DockWindow.svelte` は `win.x` をそのまま描く。doc と実装が食い違っている（本 PR で直す）。
- 必須 pane（中央の canvas など）を閉じられない・動かせないようにする口が無い。閉じるボタンは
  `DockWindow.svelte:198` / `DockedTree.svelte:66-67` が直接 `dock.close` を呼ぶ。
- 永続化はアプリ側（`apps/admin-template/src/routes/(app)/dashboard/+page.svelte:152-245`。localStorage に
  即時、`UiSettingsProvider` に 500ms のデバウンスで fire-and-forget）。書き込み失敗時の約束は無い。

**4 条件**: 既存のオプション `@banto/dock-svelte` の不具合修正と小さな拡張。1〜4 とも既存の判定のまま。

**置き場所**: `@banto/dock-svelte`（既存）。

**API の草案**:

```ts
export type DockLayoutIssueCode =
	| 'version'
	| 'shape'
	| 'duplicate-id'
	| 'non-finite'
	| 'non-positive-size'
	| 'split-sizes'
	| 'active-index';
export interface DockLayoutIssue {
	readonly code: DockLayoutIssueCode;
	/** 例: `floating[2].width`、`docked.children[1]` */
	readonly path: string;
}
export type DockLayoutValidation =
	| { readonly ok: true; readonly layout: DockLayout } // v1 は v2 へ移し、sizes は normalizeSizes 済み
	| { readonly ok: false; readonly issues: readonly DockLayoutIssue[] };

/** 純関数。constructor・hydrate・アプリの検査で共有する。 */
export function validateDockLayout(value: unknown): DockLayoutValidation;

class DockState {
	/** 不正なら現行 layout を変えずに false（従来どおり部分的には壊さない）。 */
	hydrate(json: string): boolean; // 従来は void
}

// DockHost の props に足す
interface DockHostProps {
	/** 表示用の clamp の方針（最小寸法・最低限見える幅）。省略時は geometry の既定値。 */
	clamp?: ClampOptions;
	/** pane ごとの能力。省略時はすべて可。 */
	capabilities?: (panelId: string) => { close?: boolean; move?: boolean; undock?: boolean };
}
```

- **表示用 clamp と保存希望の分離**: `DockWindow` は `clampWindowToHost(win, hostW, hostH, clamp)` の結果を
  **描くだけ**で、layout には書き戻さない。host が広がれば保存希望の位置へ戻る。操作（move / resize）は
  表示位置から始め、確定した値を layout に書く（「操作したら、その結果が新しい希望」）。
- **constructor のオブジェクト**: 不正なら空の layout で始める（例外は投げない。`hydrate` と同じく
  「部分的に壊さない」）。**破壊的になり得る点**: 今まで通っていた不正なオブジェクト（NaN 座標など）を
  渡していたアプリは空の layout になる。正常な v1 / v2 は従来どおり（回帰テストで確かめる）。
- 未知の panel ID は検証で落とさない（従来どおり、描画時に consumer の registry が決める。
  `hydrate` の doc の方針を維持）。
- **書き込みの約束**（README に書く）: `serialize()` は文字列を返すだけで、書き込みはアプリの責任。
  書き込みが失敗したら「保存済み」の印を更新しない。これを部品にするのが #437（§3.4）。

**既存 API との関係**: `hydrate` の戻り値 `void` → `boolean` は、呼び出し側のコードを壊さない（戻り値を
無視していれば同じ）。`validateDockLayout`・`clamp`・`capabilities` は追加。厳しくなった検証は不具合修正の
扱い。合わせて minor。

**テスト**: 単体 — `state.test.ts` に不正値の表（`1e999`・負・0・重複 ID・split の `sizes` 不一致・
`activeIndex` 範囲外・constructor のオブジェクト）、正常な v1 / v2 の回帰。`geometry.test.ts` に表示用 clamp
（host 1000→400px で左端が host 内に戻り、layout の x は変わらない）。jsdom — `DockHost.test.ts` に
`capabilities` で閉じるボタンが出ない・押せないこと。e2e は不要（host の縮小はブラウザの幅で
`pnpm e2e` に足せるが、jsdom の寸法の注入で足りる。**未確認**: jsdom で `clientWidth` を注入できるか。
できなければ e2e に回す）。

### 3.3 #433 gesture の所有者・取消・keyboard・focusin

**現状**（Issue の 4 つの観測はすべてコードで説明がつく）:

- gesture の経路が 4 つに分かれている。`DockWindow.svelte:58`（`trackPointer`。resize）、`:86`
  （`handleTitlebarPointerDown`。開始閾値の追跡）、`DockedTree.svelte:80`（`armDrag`。閾値）・`:131`
  （`startDivider`）、`core/drag.svelte.ts:97`（`DragController.start`。ゴーストと吸着）。
- resize と divider は pointermove ごとに `dock.resize` / `dock.resizeSplit` を**直接**書く。開始前の
  snapshot が無いので Esc で戻せない。Esc・`pointercancel`・`lostpointercapture`・window の `blur`・
  unmount のどれも見ていない（listener が残る）。
- `DragController` の `#onUp`（`drag.svelte.ts:136`）は `pointerId` を照合しない。別の pointer の
  pointerup で確定する（Issue の `pointerId=999` の観測）。`#onKeydown`（`:141`）は Esc を
  `defaultPrevented` も見ずに奪い、自分も `preventDefault` しない（ADR-0018 §10 の層の約束 1 に合わない）。
- 前面化は `DockWindow.svelte:158`（`onpointerdown={focusThis}`）だけで、Tab でのフォーカス移動
  （`focusin`）では前面に来ない。
- keyboard: divider は `role="separator"`（`DockedTree.svelte:318`）だがフォーカスできず操作もできない。
  window の移動・resize は「v1 は pointer のみ」と明記（`DockWindow.svelte` のテンプレートのコメント）。
  tab の keyboard 操作のハンドラは見当たらない（**未確認**: 標準の button 操作で足りている範囲）。
- resize の寸法 `hostW` / `hostH` は `bind:clientWidth` の値で、window resize の通知より前の pointerup では
  古い値になり得る（Issue の受入候補 3）。

**4 条件**: 既存の `@banto/dock-svelte` の不具合修正と a11y の拡張。判定は既存のまま。

**置き場所**: `@banto/dock-svelte`（既存）。gesture の所有者は内部（`core/gesture.svelte.ts` 仮称）で、
公開するのは hook だけ。temp-scada の controller をそのまま写さず、既存の `DragController` と
`geometry.ts` の演算を残したまま transaction・cleanup・hook を足す（Issue の方針どおり）。

**内部の形（草案）**:

```ts
type GestureKind = 'move' | 'resize' | 'divider' | 'drag-candidate' | 'drag' | 'keyboard';
interface GestureSession {
	readonly kind: GestureKind;
	readonly pointerId: number | null; // keyboard は null
	readonly panelId: string | null;
	readonly snapshot: DockLayout; // 開始前。cancel で戻す
}
// DockHost が 1 つだけ持つ。同時に 1 つの session だけ。
// 確定: 所有 pointer の pointerup（primary のみ）/ keyboard の Enter
// 取消: Esc（未消費のときだけ。消費したら preventDefault）/ pointercancel / lostpointercapture /
//       window blur / visibilitychange(hidden) / DockHost の unmount
// 確定の直前に host の寸法を getBoundingClientRect で測り直す（古い寸法で確定しない）
```

**公開する hook（DockHost の props、草案）**:

```ts
interface DockHostProps {
	/** gesture を始めてよいか（作図・他の DnD・上位の層との排他）。false で始めない。 */
	canStartGesture?: (kind: DockGestureKind, panelId: string | null) => boolean;
	/** gesture の結末の通知（commit / cancel と理由）。 */
	onGestureEnd?: (kind: DockGestureKind, outcome: 'commit' | 'cancel', reason?: DockCancelReason) => void;
	/** Esc を dock が受けてはいけないか（true で譲る）。`activeLayer` は gesture 中の浮動 window の
	 *  root（`role="dialog"` を持つ要素。docked の pane・divider の gesture では null）。
	 *  `DockWindow` は浮動 window ごとに `role="dialog"` を付けるので、引数なしの
	 *  `hasVisibleLayerAbove()` は **gesture 中の window 自身**を上位の層に数え、Esc で常に譲ってしまう。
	 *  アプリは `(el) => el ? hasVisibleLayerAbove({ except: el }) : hasVisibleModalLayer() || hasVisibleMenuLayer()`
	 *  をつなぐ。浮動 window の gesture は自分より上の層だけで譲り、docked の pane・divider の gesture（null）は
	 *  **モーダルとメニューの層だけ**で譲る（非モーダルの別の浮動 window は `role="dialog"` でも数えない。
	 *  `hasVisibleLayerAbove({ except: null })` はそれも数えて Esc の取消を止めてしまう）。
	 *  省略時は defaultPrevented だけを見る。 */
	isEscapeBlocked?: (activeLayer: HTMLElement | null) => boolean;
}
```

- **keyboard**（キーの割り当ては D5）: divider は WAI-ARIA の Window Splitter（フォーカスできる
  `separator`、矢印で動かす、`aria-valuenow`）。window の移動・resize は明示のモード（タイトルバーの
  ボタン → 矢印で動かし、Shift で大きく、Enter で確定、Esc で取消）。tab は既存の tablist に矢印の移動を
  足す。input・textarea・contenteditable の中のキーと IME 変換中（`isComposing` / `keyCode 229`）は
  受けない。
- **focusin での前面化**: `DockWindow` の root に `onfocusin` で `dock.focus(id)`。`bringToFront` は
  配列の順を変えるので、`{#each openWindows as win (win.id)}`（`DockHost.svelte:88`）の keyed each が DOM を
  動かす。**DOM の移動でフォーカスが外れたり Tab の順が変わったりしないかは未確認**（keyed each の移動で
  フォーカスは保たれる想定だが、IME 変換中の移動は別。§4.2）。前面化を z-index の付け替えだけにして
  DOM の順を変えない案も実装 PR で比べる（描画順 = z 順という `DockHost` の doc の前提を変えることになる）。

**既存 API との関係**: 不具合修正（pointerId・取消・cleanup・寸法・focusin）は API を変えないので patch
相当。keyboard と hook は追加（minor）。Esc で resize が戻るのは挙動の変化だが、不具合修正として扱う。

**テスト**: 単体 — gesture 所有者の状態遷移（開始・別 pointer の move / up を無視・各取消の理由で
snapshot に戻る・二重開始の拒否・dispose で listener が残らない）。jsdom — `DockHost.test.ts` に合成の
PointerEvent で Esc 取消・`pointerId` 違い・blur、`focusin` での前面化、divider の矢印。e2e — 実ブラウザの
ドラッグ・resize と Esc（`pnpm e2e` のダッシュボード）。手での確認 — タッチ（複数 pointer）と Windows 実機の
IME（§10）。

### 3.4 #437 UI 設定の現在値と保存成功 snapshot

**現状**:

- `packages/admin-core/src/providers/uiSettings.ts:25-30`（`UiSettingsProvider`）は `get` / `set` だけ。
  エラーは `ProviderError`（`errors.ts:63`）に正規化される。Local / Tauri / HTTP の 3 実装。
- アプリの使い方は 2 通りあり、どちらも「保存に成功したか」を持たない:
  `apps/admin-template/src/lib/settings.svelte.ts`（テーマ等。localStorage に即時 + provider に
  fire-and-forget、失敗は握りつぶす）と、ダッシュボードの dock layout（§3.2。デバウンス + 握りつぶし）。
- 足りないもの: current / saved / saving / error の区別、保存中に current が変わったときの扱い、
  破損値・未知 version の扱いの委譲、明示保存と即時保存の選択。

**4 条件**: 1 ○（UI 設定は spec §12.1 の全アプリ共通の仕組み）/ 2 ○（admin-core の 1 モジュール）/
3 ○ / 4 ○（SCADA の浮動配置は consumer の一例にすぎない）。

**置き場所**: `@banto/admin-core`（`UiSettingsProvider` と同じパッケージ。#436 の部品を直接使える）。

**API の草案**（名前は仮）:

```ts
export interface SavedSettingOptions<T> {
	provider: UiSettingsProvider;
	key: string;
	/** 保存値を解釈する。破損・未知の version は undefined（→ fallback）。 */
	parse: (raw: string) => T | undefined;
	serialize: (value: T) => string;
	/** 保存値が無い・壊れているときの値。文言や標準値は consumer が決める。 */
	fallback: () => T;
	/** 'explicit'（save() を呼ぶまで送らない）/ 'immediate'（set のたびに送る。連続は合流）。既定 'explicit'。 */
	mode?: 'explicit' | 'immediate';
}

export type SavedSettingLoad = 'loaded' | 'missing' | 'invalid' | 'failed';

export interface SavedSetting<T> {
	readonly current: T;
	/** 最後に保存（または読込）に成功した値。まだ無ければ undefined。 */
	readonly saved: T | undefined;
	readonly saving: boolean;
	/** 最後の失敗（ProviderError など）。次の成功で消える。 */
	readonly error: unknown;
	/** serialize(current) !== serialize(saved) */
	readonly dirty: boolean;
	set(value: T): void;
	load(): Promise<SavedSettingLoad>;
	/** 呼んだ時点の current の snapshot を送る。成功時だけ saved をその snapshot にする。 */
	save(): Promise<boolean>;
	/** current を saved に戻す。 */
	revert(): void;
	/** current を fallback() にする（保存はしない）。 */
	resetToDefault(): void;
}

export function createSavedSetting<T>(options: SavedSettingOptions<T>): SavedSetting<T>;
```

- **並行の契約（推奨）**: 同時に送るのは 1 つ。送信中の `save()` は「最新の snapshot を 1 つだけ待たせる」
  （合流）。送信中に current が変わっても、成功時の saved は**送った snapshot**で、後の編集は dirty の
  まま。古い応答（遅れて返った前の送信）は #436 の handle で捨てる。
- 失敗しても current と旧 saved は残す。通知はしない（`error` を読んだ consumer が出す。文言は §13）。

**既存 API との関係**: 追加だけ（minor）。`settings.svelte.ts` の即時保存は変えない（対象外）。ダッシュボードの
dock layout をこの部品に載せ替えるかは D8（推奨は別 PR で、#434 の `validateDockLayout` を `parse` に使う）。

**テスト**: 単体 — 注入した provider（成功・失敗・遅延・順序の入れ替わり）で、成功後だけ saved が
変わる、失敗で current と旧 saved が残る、送信中の編集は dirty のまま、合流、破損値・未知 version で
fallback と `'invalid'`。Local / Tauri / HTTP の実装は既存の `uiSettings.test.ts` が見ているので、ここでは
provider の interface に対して確かめる（Issue の「SCADA の失敗試験だけで全 provider 確認済みとはしない」）。

### 3.5 #432 未適用入力の保持と pane 切替前の guard

**現状**:

- `packages/forms/src/store.svelte.ts:19-45`（`FormStore`）は values / errors / touched と baseline
  （`#initialSnapshot`、JSON 比較で `isDirty`）を持ち、`markClean()`（`:93`）・`reset()`（`:98`）がある。
  **store はコンポーネントの外で作れる**ので、pane より長く生かすこと自体は今でもできる。
- ただし生の入力文字列は持てない。`fields/NumberField.svelte:19-20` は `Number(raw)` に変換して渡す。
  `<input type="number">` は不正な文字列を `value` で返さない（HTML の仕様で `''` になり、
  `validity.badInput` が立つ）ので、「未完成・不正な数値の生の文字列」は DOM を保つ以外に残せない
  （**実ブラウザでの確認は未実施**。PR の e2e で確かめる）。
- `packages/forms/src/unsavedChanges.svelte.ts:7-10` の契約は「Confirm, don't restore」。登録簿
  （`:182` の `registry`、`hasUnsavedChanges()` `:189`）はルーターの離脱（`beforeNavigate`）と Tauri の
  window close に使われ、ルーターを通らない pane の切替には使われていない。
- dock 側: タブは表示中の 1 枚だけを描く（`DockedTree.svelte:268`・`:297` の `{@render panel(active)}`）。
  浮動 window は `open` のものだけを描く（`DockHost.svelte:66`・`:88`）。dock / undock は `DockedTree` と
  `DockWindow` という別の木の間の移動。**どれも pane の中身を unmount する**ので、中の component の
  状態（store を component の中で作っていれば store ごと）と DOM（IME の変換・選択位置・scroll）が消える。
  浮動の中の move は同じ DOM のまま（Issue の観測と一致）。
- dock には変更前の hook が無い（`close` は `DockState.close` を直接呼ぶ。§3.2）。

**4 条件**: 1 ○（入力を持つ pane はドックを使うどのアプリでも起きる。admin-template のダッシュボードの
メモ pane は今は静的な文で、再現していない）/ 2 ○（forms と dock-svelte の中に足す。使わなければ従来
どおり）/ 3 ○ / 4 ○（SCADA の対象 ID・世代・validator・適用コマンドは callback に残す）。

**方式（推奨 D3-c、混合）**:

- **タブの切替と hide は DOM を保つ**: 表示していないタブ・閉じた（hide）浮動 window の中身を
  `hidden` + `inert` で残す（opt-in。DockHost の prop で pane ごとに選ぶ）。IME・選択・scroll・未完成の
  数値がそのまま残る。コストは常に mount しておく分のメモリと effect。
- **dock / undock と close → open は draft を戻す**: 木をまたぐ移動で DOM を保つには DOM の付け替え
  （portal 相当）が要る。ADR-0018 §10 が portal を採らなかったのと同じ理由（Svelte 5 に標準が無い・
  層の判定とフォーカストラップの `contains` が壊れる・CSS の継承が変わる）に加え、フォーカス中の要素を
  動かすと blur と IME の確定が起きる。そこで forms 側に「pane より長生きする draft」を持ち、再 mount で
  戻す。
- **IME 変換中は構造変更を保留する**: 変換中（`compositionstart`〜`compositionend`）に dock / undock / close の
  要求が来たら、gesture を始めない・確定を `compositionend` まで遅らせる。DOM を壊して変換を戻せると
  仮定しない（Issue の受入候補 4）。**実 OS の IME での確認が要る**（§10）。

**API の草案**（forms 側。名前は仮）:

```ts
/** pane の寿命から独立した draft。ページ（または controller）が作り、pane は mount のたびに借りる。 */
export interface FormDraft<V = Record<string, unknown>> {
	readonly key: string;
	readonly values: V; // 解釈済みの値
	readonly raw: Readonly<Record<string, string>>; // 未完成・不正を含む生の入力（数値欄など）
	readonly baseline: V;
	readonly dirty: boolean;
	readonly errors: Readonly<Record<string, string>>;
	setRaw(field: string, text: string): void;
	/** 確定（blur / Enter）。検証に通れば values を更新する。 */
	commit(field: string): boolean;
	/** 入力・確定のたびに増える版番号。 */
	readonly revision: number;
	/** 適用を始める時点の values と revision を取る（非同期の apply に渡す）。 */
	snapshotForApply(): { readonly values: V; readonly revision: number };
	/** 適用に成功した snapshot を baseline にする（適用成功後だけ呼ぶ）。適用中に追加入力があれば
	 *  （`revision` が進んでいれば）dirty のまま残る。今の values を baseline にするのではない。 */
	markApplied(applied: { readonly values: V; readonly revision: number }): void;
	discard(): void;
	/** pane が戻ったときの補助（選択位置・scroll）。DOM を保つ方式では使わない。 */
	view: { selection?: { field: string; start: number; end: number }; scrollTop?: number };
}

/** 既存の自作フォームをつなぐ adapter（BantoForm 化を必須にしない）。 */
export interface DraftSource {
	readonly key: string;
	isDirty(): boolean;
	/** 適用。検証失敗・適用失敗は false を返し、dirty を保つ。 */
	apply(): Promise<boolean>;
	discard(): void;
	/** 未適用の入力を pane の外へ取り出す（dock / undock で再 mount される前）。FormDraft を使う
	 *  フォームは draft 自体が pane より長生きするので不要。 */
	capture?(): unknown;
	/** capture したものを、再 mount 後の同じ key の source に戻す。 */
	restore?(captured: unknown): void;
}

/** 複数フォームの適用 / 破棄 / キャンセル。確認は 1 回だけ出す。 */
export interface DraftCoordinator {
	/** 同じ key の capture が残っていれば、登録時に `restore` を呼んで戻す（rebind）。 */
	register(source: DraftSource): () => void;
	readonly pending: boolean;
	/** 保持したまま移動する前に呼ぶ。対象の source の `capture()` を取り、次の register まで持つ。
	 *  確認は出さない（適用も破棄もしない）。 */
	capture(keys: readonly string[]): void;
	/** 対象の key（省略で全部）を確かめる。'apply' | 'discard' | 'cancel' を consumer の確認 UI が返す。
	 *  `'applied'` と `'discarded'` は「解決した時点で対象の source がすべて clean」を保証する: apply を
	 *  await したあと各 source の `isDirty()` を確かめ直し、適用中に追加入力があって dirty が残れば
	 *  `'dirty-again'` を返す（追加入力は失わない）。呼び出し側は `'applied'` / `'discarded'` / `'clean'` の
	 *  ときだけ中身を捨ててよい。 */
	settle(
		keys: readonly string[] | undefined,
		ask: (dirtyKeys: readonly string[]) => Promise<'apply' | 'discard' | 'cancel'>
	): Promise<'clean' | 'applied' | 'discarded' | 'cancelled' | 'failed' | 'dirty-again'>;
}

export function createFormDraft(/* schema, initial, messages */): FormDraft;
export function createDraftCoordinator(): DraftCoordinator;
```

- 適用は**成功したときだけ** baseline を更新する。検証失敗・適用失敗・キャンセルでは dirty を失わない。
  baseline にするのは**適用を始めた時点の snapshot**（`snapshotForApply()`）で、今の values ではない。
  v1 の適用を始めたあと同じ対象を v2 に編集し、v1 が成功した場合、baseline は v1 になり v2 は dirty のまま
  残る（§3.4 の「実際に送った snapshot を基準にする」と同じ考え方。#439 のレビュー）。
  適用中に対象が変わったときの古い結果は、#436 と同じ契約の forms 内部の実装で捨てる（§2.1）。
- `DraftCoordinator` の登録は既存の `guardUnsavedChanges` の登録簿にもつなぐ（ルーターの離脱でも同じ draft が
  確認の対象になる。二重の確認は既存の「1 つの navigation に 1 回」の仕組みで防ぐ）。
- 有効な数値の通常の blur / Enter 確定は今のまま。配置の変更は業務の変更・Undo を作らない（dock の操作は
  draft に触らない）。

**dock 側の lifecycle hook（草案）**:

```ts
type DockPanelChange =
	| { kind: 'dock' | 'undock' | 'move-docked'; panelId: string } // 中身は再 mount（draft を戻す）
	| { kind: 'tab-switch'; groupId: string; from: string; to: string } // keepMounted なら DOM を保つ
	| { kind: 'hide'; panelId: string } // 中身を保つ（keepMounted のとき）
	| { kind: 'close'; panelId: string }; // 中身を捨てる

interface DockHostProps {
	/** 構造変更の前に呼ぶ。false（または false に解決）で変更しない。確認 UI はアプリが出す。 */
	beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
	/** タブの非表示・hide のあいだ中身を mount したままにする pane。 */
	keepMounted?: (panelId: string) => boolean;
	/** IME 変換中など、構造変更を保留すべきとき true。省略時は document の composition を見る。 */
	isStructureChangeDeferred?: () => boolean;
}
```

- **hide と close の意味を分ける**: 今の `DockState.close` は layout 上は「幾何を残して隠す」なのに中身は
  捨てる。`keepMounted` の pane では close ボタンの既定を hide（中身を保つ）にし、捨てる close は
  `beforePanelChange` の `close` を通す。名前と既定はこの PR で決める（D4）。
- アプリでのつなぎ方は**遷移ごとに契約を分ける**（#439 のレビュー）:

  | 遷移 | 中身 | つなぎ方 |
  | --- | --- | --- |
  | `dock` / `undock` / `move-docked` | 再 mount するが未適用の入力は**保持**する | `coordinator.capture([panelId])` だけを呼んで `true` を返す。再 mount した pane が同じ key で register すると `restore` で戻る（rebind）。FormDraft を使う pane は何もしなくてよい。確認は出さない |
  | `tab-switch` / `hide` | keepMounted なら DOM を保つ。keepMounted でなければ上と同じく capture / rebind | 確認は出さない |
  | `close` | 中身を**捨てる** | `coordinator.settle([panelId], 確認UI)`。`apply` / `discard` / `cancel` を選ばせ、`clean` / `applied` / `discarded` のときだけ `true` を返して閉じる。`cancelled` / `failed` / `dirty-again`（適用の待機中に追加入力があり、成功後も dirty が残った）では `false` を返して閉じない。適用の成功応答だけを閉じてよい条件にしない（#439 のレビュー） |

  配置の変更は業務の変更・Undo を作らず、dirty も失わない。e2e では「`unsaved` を入力 → dock → undock →
  まだ `unsaved` で dirty」と、「close で apply を選ぶ → 適用の待機中に v2 を入力 → v1 の成功後も pane と
  v2 が残り dirty」を確かめる（後者は snapshot の単体テストでは拾えない、close の配線との組み合わせの境界）。

**既存 API との関係**: すべて追加（minor）。`FormStore`・`guardUnsavedChanges` の挙動は変えない。
`NumberField` の生の文字列を保つには `type="text"` + `inputmode="decimal"` に変える案があるが、これは見た目と
操作（スピンボタン）の変更になるので、`FormDraft` を使うときだけの別の欄にするか、DOM を保つ方式で
済ませるかを実装 PR で決める（**未決**。D3 の帰結として扱う）。

**テスト**: 単体 — `FormDraft`（生の文字列・確定・`markApplied` の条件・discard。**遅延した適用の最中に
同じ対象へ追加入力 → 適用成功後も追加入力が dirty のまま**）、`capture` / rebind（dock / undock で入力と
dirty が残る）、`DraftCoordinator`
（複数の dirty・適用の一部失敗・キャンセル・確認が 1 回・適用の await 後に dirty が戻ったら `dirty-again`）、dock の `beforePanelChange` の拒否で layout が
変わらない。jsdom — `keepMounted` の pane がタブ切替で同じ DOM ノードのまま。e2e — 統合はアプリで見る
（ダッシュボードのメモ pane を入力欄にして、`unsaved` を入れて dock / undock / タブ / close→open で残る、
D9）。手での確認 — 実 OS の IME（変換中の dock 操作）、Windows 実機、左右同時の draft、両テーマ。

### 3.6 #435 操作定義とショートカット保護

**現状**:

- `packages/admin-core/src/commands.ts:12-23`（`PaletteCommand`: `id` / `title` / `group` / `keywords` /
  `visible` / `run`）と `:58`（`searchCommands`）。検索と表示の可否だけで、enabled / checked / ショートカット・
  実行前の再検証は無い。
- `packages/ui/src/commandPalette.ts:15-31`（`CommandPaletteItem`）は `PaletteCommand` と構造的に互換で、
  `disabled` と表示だけの `shortcut` を持つ（ui は admin-core を import しない）。
- キーの受け付けはアプリに散在: `apps/admin-template/src/routes/(app)/+layout.svelte:238-247`
  （Ctrl+K と Esc。入力欄・IME・Modal の判定は無い）、`packages/grid-svelte/src/BantoGrid.svelte:723`
  （Ctrl+C）。入力欄・IME の保護は `packages/scan-wedge/src/core/detector.ts:96-101` に別の実装がある。
- 層の判定は `packages/ui/src/layering.ts:162`（`hasVisibleLayerAbove`）・`:174`（`hasVisibleMenuLayer`）。
  **注意**: `LAYER_SELECTOR`（`:69`）は `[role="dialog"]` を含み、dock の浮動 window
  （`DockWindow.svelte` の `role="dialog"`、非モーダル）も層に数える。`except` 無しで
  `hasVisibleLayerAbove()` を見るショートカットは、浮動 window が 1 枚出ているだけで全部止まる
  （nav-launcher-plan の PR-4 の注記 (3) と同じ種類の問題）。モーダルな層（`aria-modal="true"`）と
  メニューだけで止める判定が要る。

**4 条件**: 1 ○（メニュー・toolbar・右クリック・ショートカットを持つデスクトップ型の画面全般）/
2 ○（既存パッケージの追加。使わなければ従来どおり）/ 3 ○ / 4 ○（SCADA の action builder は
ドメイン語彙が多く、そのままは持ち込まない。汎用部分だけを抜く）。

**置き場所（推奨 D2-a、DOM の有無で分ける）**:

- **`@banto/ui`**: キーの解釈・照合・表示（`parseShortcut` / `matchShortcut` / `formatShortcut`）、
  入力欄・IME・層の保護（`shouldHandleShortcut`）、dispatcher（`createShortcutDispatcher`）。層の判定
  （`layering.ts`）と同じパッケージでないと使えないため。`layering.ts` にモーダルの層だけを見る判定
  （仮称 `hasVisibleModalLayer`）を足す。
- **`@banto/admin-core`**: `PaletteCommand` に任意の欄（`enabled?` / `checked?` / `shortcut?`）を足すだけ。
  検索（`searchCommands`）は変えない。ui の型と構造的に互換に保つ（今の `CommandPaletteItem` と同じやり方）。

**API の草案**（ui 側。名前は仮）:

```ts
export interface CommandSpec {
	readonly id: string;
	readonly title: string;
	readonly shortcut?: string; // 'Mod+S'（Mod = Windows/Linux は Ctrl、macOS は Meta）
	/** 表示時の可否。実行の直前にも必ずもう一度呼ぶ（古い選択や closure への誤適用を防ぐ）。 */
	readonly enabled?: () => boolean;
	readonly checked?: () => boolean;
	readonly visible?: () => boolean;
	/** 入力欄の中でも受けるか（Ctrl+S など）。既定 false = ネイティブの編集・clipboard・Undo を守る。 */
	readonly allowInEditable?: boolean;
	/** 無効なときにブラウザの既定動作を止めるか（例: 無効でも Ctrl+S の「ページを保存」は止める）。 */
	readonly preventDefaultWhenDisabled?: boolean;
	/** この command が属する層の root（例: コマンドパレットの `aria-modal="true"` の dialog）。
	 *  指定すると、層の判定はその層**より上**のモーダル・メニューだけで止める
	 *  （`hasVisibleLayerAbove({ except: ownerLayer() })` と同じ考え方）。パレットの Ctrl+K のように、
	 *  自分の層が開いている間も受ける command に使う。未指定ならモーダル・メニューが出ていれば止める。 */
	readonly ownerLayer?: () => Element | null;
	run(): void | Promise<void>;
}

/** 受けてよいキーか: isComposing / keyCode 229 / defaultPrevented / repeat（既定は拒否）/
 *  編集可能な要素（input・textarea・select・contenteditable）/ モーダル・メニューの層（`ownerLayer`
 *  があればその層自身と、それより下の層は数えない）。 */
export function shouldHandleShortcut(
	event: KeyboardEvent,
	spec: Pick<CommandSpec, 'allowInEditable' | 'ownerLayer'>
): boolean;

export interface ShortcutDispatcher {
	/** scope（ページ・pane）の command を足す。後から足した scope が優先。戻り値で外す。 */
	register(scope: string, commands: readonly CommandSpec[]): () => void;
	/** window の keydown から呼ぶ。処理したら preventDefault して true。 */
	handle(event: KeyboardEvent): boolean;
}
export function createShortcutDispatcher(options?: { platform?: 'mac' | 'other' }): ShortcutDispatcher;
export function formatShortcut(shortcut: string, platform: 'mac' | 'other'): string; // 表示用。文言キーは使わない記号のみ
```

- メニュー・toolbar・右クリックは同じ `CommandSpec` の `id` から `MenuItem` の props（disabled・checked・
  ショートカットの表示）を導く。右クリックメニューを閉じた後のフォーカスの戻しは `layering.ts` の
  `restoreFocus` に従う。
- Ctrl+S と forms の連携: `allowInEditable: true` の command が `DraftCoordinator.settle` または適用を呼ぶ
  （アプリでつなぐ。ui は forms を知らない）。

**既存 API との関係**: 追加だけ（minor）。`PaletteCommand` の欄は任意なので既存のコマンド定義はそのまま。
アプリの Ctrl+K は dispatcher へ移す（挙動は同じ）。パレットの `CommandPalettePanel.svelte` 自身が
`aria-modal="true"` の dialog なので、開いている間の Ctrl+K（閉じる）は層の判定で止まってしまう。
`ownerLayer` にパレットの dialog を渡してその層自身を数えないようにし、検索欄の中でも閉じられる今の約束は
`allowInEditable: true` で保つ。e2e で「開く → 検索欄にフォーカスしたまま Ctrl+K で閉じる」を確かめる（PR-11）。

**テスト**: 単体（ui、jsdom）— `shouldHandleShortcut` の表（IME・229・repeat・修飾キー・各編集要素・
defaultPrevented・モーダル / メニュー / 非モーダルの dialog）、dispatcher の scope の優先と実行前の再検証、
`formatShortcut`。e2e — Ctrl+K が入力欄の中でも動く・Modal の中では Esc が Modal を閉じる・入力欄の
Ctrl+C / Ctrl+Z がネイティブのまま。手での確認 — macOS の Meta 表記、Windows 実機の IME（§10）。

### 3.7 #438 ブラウザ画像の原本・取込検査・URL 寿命

**現状**:

- banto のブラウザ側に画像の検査は無い。`@banto/attachments` の `core/`（`errors.ts`・`fileType.ts`・
  `format.ts`・`list.ts`）は表示の補助で、形式の判定はサーバーの `banto-attachments` の `detect_mime`
  （マジックバイト、conventions §6）にある。サムネイルの object URL の寿命は
  `AttachmentsPanel.svelte:71-111`（`loadToken` と revoke）が自前で持つ。
- **重複は小さい**: 共通するのは「object URL を所有者が revoke する」だけ（conventions §8 の箇条）。
  ヘッダの検査・原本の保持・hash の重複排除・pin / release は banto のどこにも無い。
- temp-scada の `image-assets.ts`（255 行）は `inspectImage`・`imageHeader`・`sha256`・`AssetStore`
  （`put` / `pin` / `collect` / `importFrom` / `dispose`）。上限は定数（8MiB・8192px・1600 万画素・
  256MiB）で、例外の文言は日本語の直書き。
- **LAN 配信で効く制約**: `sha256` は `crypto.subtle.digest` を使う。`crypto.subtle` は secure context
  （HTTPS か localhost）でしか使えないので、banto の LAN 配信（平文 HTTP。TLS はリバースプロキシで終端、
  ADR-0003）では**未定義になる**。移すなら hash の代替（自前の SHA-256 は conventions §3 の判断が要る）か、
  secure context に限る機能として文書化するかを決める必要がある。

**4 条件の判定**:

| # | 判定 | 理由 |
| --- | --- | --- |
| 1 横断性 | △ | 画像を取り込んで原本のまま持ち回る画面（デザイナ・帳票の画像・製品写真の事前検査）は一部。一般的な管理画面は添付のアップロード（サーバー検査）で足りる |
| 2 削除容易性 | ○ | 独立したモジュールにできる |
| 3 代替不能性 | △ | decode は標準 API。検査のヘッダの読み取りは小さい。hash は上記の制約あり |
| 4 無ドメイン性 | ○ | 工場の知識は無い。**banto-industrial（ドメイン特化の資産の置き場、template-scope §3.1）に置く理由は無い** |

**決定（D6-a、2026-10-21）**: **新しいオプションのパッケージとして作る**（仮称 `image-assets`（予定のパッケージ名）、
`packages/image-assets`）。オーナーは汎用 SCADA の次に案件用の特化 SCADA を作る予定で、2 つ目の consumer が
決まっている。これで 4 条件の 1（横断性）と 3（代替不能性）の △ は「複数の派生アプリが同じ部品を要る」で補える。

- **パッケージの境界**: サーバーの添付（`@banto/attachments`）とは目的が違うので分ける（D6-b を採らない理由）。
  オプション扱い（template-scope §3 の表に行を足す）。テンプレートのアプリには配線しないので、scaffold では
  削除せず、scan-wedge と同じく除外のリストに理由付きで登録する（PR-12 で決定。§5.1）。
- **#436 の部品は import できない**（§2.1）。image-assets は D1 の forms と同じく、要求の失効の契約を
  内部に持ち、admin-core の `createRequestOwner` と同じ契約の表のテストを共有する。
- **上限は consumer が渡す**（bytes・辺長・画素数・総容量・許可形式）。SCADA の 8MiB・8192px などは既定値に
  しない（既定は「上限なし」ではなく、必須の引数にする）。
- **例外の文言**: 日本語の直書きをやめ、エラーコード（`'unsupported-format' | 'too-large' | ...`）と
  詳細の値を返す。表示文言はアプリ側の Paraglide のキー（conventions §13）。
- **hash**: LAN の平文 HTTP で `crypto.subtle` が無い問題は D11。
- 必要な作業: ADR-0020（D7）、template-scope §3 の行と削除手順、外部利用 fixture への import の追加
  （`verify:architecture` の rule `external-consumer-fixture`）、`.svelte.ts` を持つなら
  `optimizeDeps.exclude`（conventions §14。`.svelte.ts` を持つ場合）、scaffold の除外のリスト。

## 4. 横断する設計

### 4.1 #436 の部品を誰がどう使うか

| 使う側 | 使い方 | 部品への届き方 |
| --- | --- | --- |
| admin-core `ListResource` | `#requestToken` の置き換え（最初の consumer、挙動は同じ） | 同じパッケージ |
| admin-core #437 `createSavedSetting` | 送信の古い応答を捨てる・dispose で失効 | 同じパッケージ |
| forms #432 `DraftCoordinator` | 適用中に対象が変わったら結果を捨て、dirty を残す | **import できない** → 同じ契約の内部実装（数十行）。契約の表のテストを共有 |
| アプリ（画像・Project 読込・clipboard） | 各 controller が `createRequestOwner()` を持ち、unmount で `dispose()` | アプリから admin-core を import |
| attachments `AttachmentsPanel` | `loadToken` の置き換えは**しない**（import できない。今の実装で足りている） | — |
| dock-svelte | 使わない（非同期の処理を持たない） | — |

### 4.2 dock の lifecycle hook（#432）と gesture の所有者（#433）の境界

- **gesture の所有者（#433）**: pointer / keyboard の 1 回の操作（transaction）を持つ。開始前の snapshot、
  所有 pointer の照合、取消（Esc・pointercancel・capture 喪失・blur・unmount）、listener の解放。
  幾何だけの変更（浮動の move / resize、divider）はここで完結し、lifecycle hook は呼ばない（中身は
  壊れない）。
- **lifecycle hook（#432）**: 中身の寿命に関わる構造変更（dock / undock / docked の移動 / タブの切替 /
  hide / close）を「適用してよいか」決める。gesture が確定したとき、構造変更を伴うなら gesture の
  所有者は**構造変更の要求を作って lifecycle に渡し、自分は終わる**（pointer は離されているので、確認
  ダイアログの待ちを gesture の中に持ち込まない）。lifecycle が拒否したら layout は変わらない（ゴーストは
  既に消えているので、見た目は「元の位置に戻る」）。
- **IME**: gesture の開始時に `isStructureChangeDeferred()` が true なら構造変更を伴う gesture を始めない。
  幾何だけの gesture は始めてよい（DOM を壊さない）。
- **順番**: #433 で gesture の所有者と「確定の一点」を作ってから、#432 でそこに hook を差す。逆の順だと
  hook を 4 つの経路（§3.3）それぞれに差すことになる。

### 4.3 Esc とキーの優先順位

上から順に判定し、受けた層が `preventDefault` する（ADR-0018 §10 の層の約束 1・2 と同じ考え方）。

| 順 | 誰が | 条件 |
| --- | --- | --- |
| 0 | だれも受けない | IME 変換中（`isComposing` / `keyCode 229`） |
| 1 | 進行中の dock の gesture（#433） | pointer が押されている間、または keyboard の移動モードの間。gesture 中は Menu が開かない（pointerdown で閉じる）ので衝突は少ないが、`isEscapeBlocked()` が true なら譲る |
| 2 | 最前の層（Modal / Drawer / Menu / CommandPalette） | 既存の `layering.ts` の約束どおり |
| 3 | ショートカット dispatcher（#435） | `defaultPrevented` でない・編集可能な要素の中なら `allowInEditable` のものだけ・**モーダルな層とメニュー**が出ていれば止める（非モーダルの浮動 window では止めない。`ownerLayer` を持つ command は自分の層より上だけを見る。§3.6 の注意） |
| 4 | ページの Esc（サイドバーのオーバーレイを閉じる等） | 既存の `+layout.svelte` の `handleKeydown` |

- dock-svelte は `@banto/ui` を import できないので、1 の「譲る」はアプリが `isEscapeBlocked` に
  §3.3 の判定（浮動 window なら `hasVisibleLayerAbove({ except: el })`、docked・divider なら
  `hasVisibleModalLayer() || hasVisibleMenuLayer()`）をつなぐ。gesture 中の浮動 window 自身も、別の非モーダルの
  浮動 window も `role="dialog"` なので、どちらも数えると Esc の取消が効かなくなる。回帰条件:「浮動 window を
  開いたまま divider を操作 → Esc で開始前に戻る」。既定は `defaultPrevented` だけを見る。
  `hasVisibleModalLayer` は §3.6 で `layering.ts` に足す判定で、PR-7（#435-a、ui）が足す。PR-5（#433-b）のアプリ側の配線と回帰テストはそれを使うので、PR-5 は 4 と 7 に依存する。
- dock の keyboard 操作（#433）のキーと、#435 の dispatcher に登録するショートカットが衝突しないよう、
  dock は「フォーカスが dock の中の操作要素にあるとき」だけキーを受ける（window の keydown で奪わない）。

## 5. 順番と PR の分け方

見立ての順（(1) #434・#436 → (2) #433・#437 → (3) #432 → (4) #435 → (5) #438）を検証した結果、
**大筋は正しい**。直した点は 3 つ:

1. **#437 は独立ではなく #436 に依存する**（古い応答の破棄。同じ admin-core に置くので順に積める）。
2. **#435 の大半（dispatcher と保護）は #432 を待たなくてよい**。#432 に依存するのは Ctrl+S と forms の
   連携だけなので、#435 を 2 つに分け、前半を段階 2 に前倒しする。
3. **#432 の #436 への依存は契約の依存**（forms は import できない、§2.1）。#436 の契約が固まってから
   forms の内部実装を書く、という順は変わらない。

| # | 段階 | PR | 中身 | 触るパッケージ | 依存 | 版 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | — | 計画（本書） | 本書の追加。オーナー決定を §9 に書き込む | なし | — | — |
| 1 | 1 | #434-a layout の検証 | `validateDockLayout`、`hydrate` の戻り値、constructor の検証、テスト | dock-svelte | — | minor（追加 + 修正） |
| 2 | 1 | #434-b 到達性と能力 | 表示用 clamp（保存希望を書き換えない）、`clamp` / `capabilities` props、`clampWindowToHost` の doc の修正、README に書き込みの約束 | dock-svelte | 1（同じテストを触る） | minor |
| 3 | 1 | #436 要求の所有者 | `createRequestOwner`、`ListResource` の内部の置き換え、conventions §8 の箇条を部品への参照に | admin-core、docs | — | minor |
| 4 | 2 | #433-a gesture の所有者 | 4 経路を 1 つの所有者へ、pointerId、snapshot と取消、寸法の測り直し、focusin の前面化 | dock-svelte | 2（`DockWindow` を触るため衝突を避ける） | patch 相当（API なし） |
| 5 | 2 | #433-b keyboard と hook | divider の Window Splitter、window の移動モード、tab の矢印、`canStartGesture` / `onGestureEnd` / `isEscapeBlocked(activeLayer)`、ダッシュボードでの Esc の配線と回帰（浮動 window を開いたまま divider → Esc） | dock-svelte、admin-template | 4・7 | minor |
| 6 | 2 | #437 保存 snapshot | `createSavedSetting`、テスト | admin-core | 3 | minor |
| 7 | 2 | #435-a dispatcher と保護 | `shouldHandleShortcut` / `createShortcutDispatcher` / `formatShortcut`、`hasVisibleModalLayer`、`PaletteCommand` の任意の欄 | ui、admin-core | — | minor |
| 8 | 3 | #432-a forms の draft | `FormDraft` / `DraftSource` / `DraftCoordinator`、内部の要求の契約、`guardUnsavedChanges` との接続 | forms | 3（契約） | minor |
| 9 | 3 | #432-b dock の lifecycle | `beforePanelChange` / `keepMounted` / `isStructureChangeDeferred`、hide と close の分離 | dock-svelte | 5 | minor |
| 10 | 3 | #432-c アプリの統合 | ダッシュボードのメモ pane を入力欄にして draft と lifecycle をつなぐ（D9）、e2e、visual の作り直し | admin-template、e2e | 8・9 | minor（アプリ） |
| 11 | 4 | #435-b アプリの配線 | Ctrl+K を dispatcher へ、Ctrl+S を forms の適用へ、メニューと command の id の共有、e2e | admin-template | 7・8 | minor（アプリ） |
| 12 | 5 | #438-a 新パッケージの骨格 | ADR-0020、`packages/image-assets` の骨格、template-scope §3 の行と削除手順、scaffold の削除対象、外部利用 fixture への import | image-assets、docs、scripts、fixtures | 3 | minor |
| 13 | 5 | #438-b 取込の検査と hash | decode 前のヘッダ検査（PNG / JPEG の形式・寸法・画素数）と decode 後の確認、エラーコード、hash（D11） | image-assets | 12 | minor |
| 14 | 5 | #438-c 原本と URL の寿命 | 原本 bytes の保持、hash による重複排除、object URL の共有と解放、pin / release、失効の契約（§2.1。admin-core と同じ契約の表のテスト） | image-assets | 13 | minor |
| 15 | 随時 | 文書 | upgrading.md（派生アプリの取り込み手順）、recipes、本書の状態行。CHANGELOG は各 PR で 1 行ずつ | docs | 各 PR | — |

- 段階の中は並行できる（1・3 は独立。4〜7 は 4→5、7→5、3→6 の鎖のほかは独立）。
- `@banto/*` の版は全パッケージで揃っている（`check:versions`）ので、リリースの版は中身の最大（minor）で決まる。
- 委譲の単位は 1 PR = 1 エージェント（ユーザーの指示どおり小さく分ける）。設計の判断が要るのは 4・8・9
  （gesture と lifecycle の境界、draft の形）で、残りはテストと軽い実装が中心。
- 各 PR で `pnpm check`・該当パッケージの `pnpm test`（名前で絞る）・`pnpm verify:architecture`・
  `format:check`。dock-svelte を触る PR は外部利用 fixture（external-consumer.yml）が回る。
- 自作の PR はセルフマージしない。


### 5.1 実施状況（2026-10-21 時点）

実装とレビューで、計画から変えたこと・決めたことを残す（詳細は各 PR と CHANGELOG）。

| # | PR | 状態 | 計画から変えたこと・決めたこと |
| --- | --- | --- | --- |
| 1 | #440 | マージ済み | `validateDockLayout`。ID の一意性は浮動・docked の panel と split / tabs の node をまとめて 1 つの集合で見る。穴あきの配列・自分を含む object・合計が溢れる sizes も拒否。ダッシュボードは受け入れた layout だけをキャッシュする |
| 2 | #443 | マージ済み（#434 を閉じた） | 狭い host の退避方針は `narrowHost: 'overflow' \| 'fit'`。`capabilities` は close / move / undock（UI 上の制限で、コードからの呼び出しは止めない） |
| 3 | #441 | マージ済み（#436 を閉じた） | `finish()` は最新の要求だったかを返す。外部コールバックの前に状態を確定する順序（begin は新しい要求を先に登録、finish は release のあとに判定）。`isCurrent()` は owner の破棄も見る。`$state` の読みは `untrack`（effect の無限ループを起こした）。契約の表は `packages/admin-core/tests/contracts/request-owner.json` |
| 4 | #445 | マージ済み | `GestureOwner` は内部。取消は操作の対象だけを戻す（`GestureSpec.restore`。layout 全体は戻さない）。押した window の前面化はフォーカスの結果なので取消でも残す。前面化は z-index で行い DOM の順を変えない。dispose は取消の前に新しい操作を拒む |
| 5 | #446 | マージ済み（#433 を閉じた） | `keyboard` の kind は作らず、`move` / `resize` / `divider` を `pointerId: null` で区別。`canStartGesture` はドラッグの閾値を越えた時点で `drag` として聞き、拒んだら黙って捨てる。キーボードのモードは window やボタンが消えたら終える（Firefox は削除で blur を出さない） |
| 6 | #442 | マージ済み（#437 を閉じた） | 保存は直列で、保存中の save は 1 つにまとめる。保存中の load は読まずに `stale`。`saved` と `current` は parse し直した別の値（オブジェクトをその場で書き換えても混ざらない） |
| 7 | #444 | マージ済み | `allowRepeat` を追加。保護で拒んだ command は下の scope に落とさない。名前の表は自分のプロパティだけを引く（`constructor+K` を拒否）。Space は Shift を無視する記号に含めない |
| 8 | #447 | マージ済み | `DraftNumberField`（`type="text"` + `inputmode="decimal"`）を足し、既存の `NumberField` は変えない。`settle` の結果に `'stale'`。`commitAll` は全欄を解釈してから検証し、失敗したら何も確定しない。FormDraft の source はページの寿命で登録する（pane が見えなくても離脱の確認の対象）。並列の apply は 1 つずつ失効を確かめてから始める。forms は request owner の写しを内部に持ち、契約の表を流す |
| 9 | #448 | マージ済み | `DockPanelChange` に `remount`。非同期の答えは `DockState.structureRevision`（構造の世代）で古さを判断する。重複除去のキーにドロップ先を含める。IME の保留と `keepMounted` は適用の直前にも確かめる。保留枠は作った順で新しい要求を残し、古くなった許可は持たない |
| 10 | #449 | マージ済み（#432 を閉じた） | `keepMounted` は使わない（draft がページ寿命なので再 mount で戻り、✕ を中身を捨てる close のまま確認に通す。IME は構造変更の保留で守る）。適用先は UiSettingsProvider の `dashboard.memo`（`createSavedSetting` 経由）。ツールバーの開閉と pop-out も `closePanel` / close と同じ確認を通す。確認 UI は `@banto/ui` の `Modal`、e2e は smoke の 13l |
| 11 | #450 | マージ済み（#435 を閉じた） | dispatcher はアプリに 1 つ（`#lib/shortcuts.ts`）。Ctrl+K はパレットの dialog を `ownerLayer` に、狭い画面のサイドバーの上でも受ける（モーダルではない。パレットが上に開き、Esc はパレットが先に取る）。Ctrl+S はダッシュボードのメモだけ（保存ボタンと同じ `CommandSpec` = 同じ直列の保存、`preventDefaultWhenDisabled: true`、ほかのページはブラウザのまま）。押しっぱなしは `allowRepeat` で受けて無効扱いにし、ブラウザへ渡さない（`firstPressOnly`）。id から `CommandSpec` を引く口は作らない（共有はオブジェクトを渡す形で足り、ショートカットを持つメニュー項目がまだ無い）。ヘッダーの鍵帽は `formatShortcut` |
| 12 | #451 | マージ済み | パッケージ名は `@banto/image-assets`。骨格は形式（`IMAGE_FORMATS`）・上限の型と検証（`ImageImportLimits`・`validateImageImportLimits`。辺長は `maxEdge` 1 つ、総容量は PR-14 の store の option）・エラーコード（`ImageAssetError` の `code` と `detail`、PR-13・14 の分も 1 つの union に先に置く）だけで、中身の無い関数は export しない。scaffold は**触れない**（アプリに配線しないので外す配線が無く、パッケージ本体を消すと docs の参照が rule `docs-package-refs` に落ちる。他の remover と同じく本体は同梱のまま。`scaffold.test.mjs` の除外に理由を書いた）。外部利用 fixture には足さない（rule `external-consumer-fixture` と conventions §14 の対象は `.svelte.ts` を持つパッケージで、骨格は型と検証だけ。PR-14 で `.svelte.ts` を持つならその PR で fixture と `optimizeDeps.exclude` に足す） |
| 13 | #452 | マージ済み | `inspectImageHeader`（decode 前）・`verifyDecodedImage`（decode 後。decoder は注入でき、既定は `createImageBitmap`）・`inspectImage`（両方と hash を順に通す。`Blob` は読む前に size を見る）・`sha256Hex`（D11-a。自前は 8MiB で約 50ms）。JPEG はプログレッシブと CMYK を受け入れ、ロスレス・算術符号化・12 ビットは `unsupported-format`。APNG は `unsupported-format`。EXIF の向きは読まず、decode 後は幅と高さの入れ替えも一致とみなす（`transposed`）。上限は関数の中でも検証し直す。`ImageAssetErrorDetail` に `width` / `height` を足した |
| 14 | #453 | マージ済み | `createImageStore({ maxTotalBytes, objectUrls? })`。原本は取込の検査を通した bytes を 1 度だけ複製し、ヘッダの MIME の不変の `Blob` で持つ（`importFrom` は同じ `Blob` を共有）。object URL は原本ごとに 1 つを共有し、`acquireUrl` の貸出の数で寿命を決める（最後の `release()` で revoke）。URL の貸出中は pin と同じく `collect` / `delete` / `dispose` から守る。dispose 後も pin・貸出中の原本は読めて、最後の解除で消える（書き出し中の原本を失わない）。dispose 後の `add` / `importFrom` / `pin` / `acquireUrl` は `store-disposed`、`collect` / `delete` / `cancel` は何もしない。要求の失効は request owner の写し（`src/requestOwner.svelte.ts`、forms の写しと同じ本文）を `add()` に使う: 同じ `key` の新しい add・`cancel(key)`・`dispose()` で失効し、失効した add は保持も失敗の報告もせず `null` を返す。エラーコードに `unknown-asset`（`detail.hash`）と `store-disposed` を足した。`.svelte.ts` を持つので外部利用 fixture（依存・import・exclude）に足した。`apps/admin-template/vite.config.ts` の `optimizeDeps.exclude` には足さない（conventions §14 と rule `optimizedeps-svelte-source` の対象はアプリが依存するパッケージで、テンプレートは依存しない。ADR-0020 §6 の「両方」のうち fixture だけが該当）。fixture の依存は v6.7.2 のタグにパッケージが無いので、次のリリースまでタグの経路で落ちる（SHA の経路は通る。`@banto/ui` の toast と同じ扱い）。レビューで `url-pending` を足した（注入した `create` の実行中に同じ原本の `acquireUrl` を呼ぶと断る。生成中は原本を貸出中として扱い、`delete` / `collect` / `dispose` で消えない）。temp-scada の `put` の `expected`（宣言との照合）は入れていない（consumer が `metadata.sha256` を比べて `delete` できる） |
| 15 | #454 | マージ済み | 文書。`docs/upgrading.md` に例 5（次のリリースの取り込み手順）、`docs/recipes/image-assets.md`（取込と表示）を足し、AGENTS の recipes 一覧に載せた。コードは変えない |
## 6. リリースとの関係（v6.8.0、draft の #429）

v6.8.0 の中身（ドックのランチャー、#421〜#426・#428・#430・#431）は揃っており、#429 は main の取り込み待ち。
オーナーは「#219 以外の Issue を片付けてからリリース」の予定。#432〜#438 は本計画で 15 PR 前後（#438 の 3 本を含む）になる。

- **a**: v6.8.0 を今の中身で出す。7 件は v6.9.0 以降。ランチャーを待たせないが、#434 の修正も後になる。
- **b**: 7 件がすべて済むまで v6.8.0 を止める。ランチャーが数週間止まり、1 つのリリースが大きくなる
  （upgrading.md の手順も 1 回に集まる）。
- **c**: **#434（PR-1・PR-2）だけを v6.8.0 に入れて出す**。残りは v6.9.0（段階 1 の #436 + 段階 2）、
  v6.10.0（段階 3・4）に分ける。

**決定: b（2026-10-21）**。7 件をすべて片付けてから 1 回で出す。版は中身の最大（新パッケージと API の追加 =
minor）なので v6.8.0 のまま。draft の #429 は、全 PR のマージ後に main を取り込み、CHANGELOG の版節に
各 PR の行と「派生アプリへの影響」（新パッケージ・forms / dock-svelte / ui / admin-core の追加 API・
テンプレートの配線）をまとめ直してから下書きを解除する。#436 の API も consumer（#437・#432・#438）と
同じリリースで出るので、c で心配した「consumer より先に公開して後で major」は起きない。

（以下は決定前の推奨の理由。記録として残す）c の理由: #434 は小さく独立した不具合修正で、dock の利用者に効く。一方 #436 は **consumer（#437・#432）より
先に公開すると、API を直したくなったときに破壊的変更（major）になる**ので、最初の consumer と同じリリースで
出したい。#433 以降は設計の判断（D3〜D5）が要り、v6.8.0 を待たせる理由にしない。v6.8.0 の
「Issue を片付ける」は、7 件を本計画に載せて順番と版を決めたことで満たす（#434 は閉じる、他は計画済み）。

## 7. CI で守るもの / 手で確かめるもの

| 項目 | CI で守る（どこで） | 手で確かめる（誰が・いつ） |
| --- | --- | --- |
| #436 の契約（失効・busy・解放が一度） | 単体（admin-core、forms の内部実装も同じ表） | — |
| #434 の検証（不正値・v1/v2 の回帰） | 単体（`state.test.ts`） | — |
| #434 の表示用 clamp と保存希望 | 単体（`geometry.test.ts`）+ jsdom（寸法の注入。無理なら e2e） | 実ブラウザで幅を縮める（実装者が PR-2 で 1 回） |
| #433 の pointerId・取消・cleanup | 単体 + jsdom（合成 PointerEvent） | タッチの複数 pointer（オーナー、v6.8.0 のリリース前に実機で 1 回） |
| #433 の keyboard 操作 | jsdom + e2e（矢印・Enter・Esc）+ axe（既存の a11y） | スクリーンリーダーの読み上げ（任意） |
| #433 の focusin の前面化 | jsdom | Tab の順が変わらないこと（実装者が PR-4 で 1 回） |
| #437 の保存の契約 | 単体（注入 provider の成功・失敗・遅延・順序の入れ替わり） | Tauri（Windows）の設定 DB への実書き込み（オーナー、v6.8.0 のリリース前） |
| #432 の draft・coordinator | 単体 | — |
| #432 のタブ / hide で DOM を保つ | jsdom（同じノードか） | — |
| #432 の dock / undock / close→open で入力が戻る | e2e（Chromium、メモ pane） | 両テーマ・左右同時の draft（実装者が PR-10 で） |
| **#432 の IME 変換中の構造変更の保留** | **CI では守れない**（合成の composition イベントで分岐だけ単体で見る） | **Windows 実機の Microsoft IME と WebView2（Tauri）で、変換中に dock / undock / タブ / close を試す（オーナー、PR-9・10 のマージ前）** |
| #435 の入力欄・IME・層の保護 | jsdom（判定の表）+ e2e（入力欄の Ctrl+C / Ctrl+Z がネイティブ、Modal の Esc） | **Windows 実機の IME 変換中のショートカット**・macOS の Meta 表記（オーナー、PR-11 のマージ前） |
| #435 の右クリック後のフォーカスの戻し | e2e | 両テーマの見た目（実装者） |
| 見た目の変化（PR-10 のメモ pane など） | visual（ベースラインは visual-baselines.yml の dispatch で Linux 生成） | 作り直した画像の確認（オーナー、PR のレビュー） |
| 性能（keepMounted の pane が多いとき） | なし | 必要になったら計測（未定） |

## 8. ADR と文書の更新

- #436・#435・#437・#432・#433・#434 は既存のパッケージ（admin-core・ui・forms・dock-svelte）の中で完結する。
  **#438 は D6-a で新パッケージ（`image-assets`（予定のパッケージ名））になるので、ADR-0020 を書く**（D7）。
- forms に #436 の契約の内部実装を持つ（複製を受け入れる）判断は、conventions §8 の箇条の更新と本書で記録し、
  ADR にはしない（§4 の不変条件を変えないので）。
- ADR-0020 の中身: 決定（`image-assets`（予定のパッケージ名） をオプションのパッケージとして作る）、代替案（attachments への
  追加・banto-industrial・見送り）と退けた理由、hash の扱い（D11）、上限を consumer が渡すこと、
  #436 の契約を内部に持つこと（§2.1）。あわせて template-scope §3 の行・削除手順・外部利用 fixture・
  `optimizeDeps.exclude`（`.svelte.ts` を持つなら）。
- 実装 PR ごとに本書の `状態:` 行を更新する（AGENTS.md の寿命のルール）。

## 9. 論点（D1〜D11、すべて決定済み 2026-10-21）

| 論点 | 推奨 |
| --- | --- |
| D1 #436 の primitive の置き場所 | **決定: a: admin-core。forms は同じ契約の内部実装を持つ** |
| D2 #435 の置き場所 | **決定: a: キーと保護と dispatcher は ui、`PaletteCommand` の任意の欄は admin-core** |
| D3 #432 の方式 | **決定: c: タブ / hide は DOM を保つ、dock / undock / close→open は draft を戻す、IME 変換中は保留** |
| D4 hide と close の意味 | **決定: a: keepMounted の pane の × は hide（中身を保つ）、捨てる close は確認を通す** |
| D5 dock の keyboard のキー割り当て | **決定: a: divider は Window Splitter、window は明示の移動 / サイズ変更モード** |
| D6 #438 の扱い | **決定: a**（新しいオプションのパッケージとして作る。汎用 SCADA の次に案件用の特化 SCADA を作る予定で、2 つ目の consumer がある） |
| D7 新パッケージと ADR | **決定**（D6-a の帰結）: #438 の新パッケージだけ ADR（ADR-0020）を書く。#436・#435 は既存パッケージの中で完結（新パッケージは作らない） |
| D8 ダッシュボードの dock layout を #437 に載せ替えるか | **決定: b: 載せ替えない（別 Issue。見本として後で）** |
| D9 #432 の統合をどこで見るか | **決定: a: ダッシュボードのメモ pane を入力欄にして e2e** |
| D10 v6.8.0 との関係 | **決定: b**（7 件をすべて片付けてから 1 回で出す） |
| D11 #438 の hash（平文 HTTP の LAN で `crypto.subtle` が無い） | **決定: a: `crypto.subtle` があれば使い、無ければ自前の SHA-256（同じ値）に落とす** |

### D1. #436 の primitive の置き場所

- **a（推奨）**: `@banto/admin-core` に置く。headless な非同期の仕組みの家で、#437 と `ListResource` が直接使う。
  forms は import できないので同じ契約を内部に持つ（数十行の複製。契約の表のテストを共有して食い違いを防ぐ）。
- b: 新パッケージ（仮称 `packages/async`）。名前は分かりやすいが、他のパッケージは結局 import できず
  （§2.1）、ADR・template-scope の行・外部利用 fixture が増えるだけ。
- c: パッケージ間の import を許す（§4 の不変条件と rule の変更）。複製は消えるが、派生アプリの Git 依存の
  入れ方が変わり、全パッケージの削除可能性の前提が崩れる。採らない。
- d: 部品にせず、conventions §8 の書き方の規約だけ強める。複製は今のまま増え続ける。

### D2. #435 の置き場所

- **a（推奨）**: キーの照合・保護・dispatcher は `@banto/ui`（`layering.ts` を使うため）。
  `PaletteCommand` には任意の欄だけを足し、ui の型と構造的に互換に保つ。
- b: 全部 admin-core。層の判定を使えない（ui を import できない）ので、層の判定の写しが要る。採らない。
- c: 全部 ui。`PaletteCommand` の型を ui の型で置き換える。admin-core の公開 API を動かす意味が薄い。

### D3. #432 の方式

- a: DOM を保つだけ（全部の pane を常に mount、木をまたぐ移動は DOM の付け替え）。IME・選択・scroll が
  自然に残るが、付け替えは ADR-0018 §10 で退けた portal と同じ問題を持ち、フォーカス中の要素は blur する。
- b: draft を戻すだけ。仕組みは単純だが、タブの切替のたびに IME・scroll・未完成の数値が消える。
- **c（推奨）**: 混合（§3.5）。安いところ（タブ / hide）は DOM を保ち、木をまたぐ移動は draft、IME 変換中は保留。

### D4. hide と close の意味

- **a（推奨）**: `keepMounted` の pane では × を hide（中身を保つ）にし、中身を捨てる close は
  `beforePanelChange` の `close` を通す（確認は 1 回）。`keepMounted` でない pane は今のまま。
- b: × は常に close（今の意味）にし、hide は別のボタンを足す。見た目が変わり、ボタンの文言が増える。

### D5. dock の keyboard のキー割り当て

- **a（推奨）**: divider は WAI-ARIA の Window Splitter（フォーカスできる separator + 矢印）。window の移動・
  resize は明示のモード（タイトルバーのボタンで入り、矢印・Shift・Enter・Esc）。入力欄のキーを奪わない。
- b: window にフォーカスがあるあいだ常に Alt + 矢印で移動。速いが、OS・ブラウザのショートカットと衝突しやすい。

### D6. #438 の扱い

- a: 新しいオプションのパッケージ（仮称 `packages/image-assets`）。ADR・template-scope §3 の行・削除手順・
  外部利用 fixture が要り、LAN の平文 HTTP で `crypto.subtle` が無い問題（§3.7）を解く必要がある。
- b: `@banto/attachments` に足す。サーバーの添付とブラウザの原本の管理は目的が違い、attachments を外すと
  一緒に消える。
- c: banto-industrial。工場の知識は無いので、ドメイン特化の置き場に入れる理由が無い。
- d: 見送り。temp-scada に残し、#436 の部品で薄くしてもらう。2 つ目の consumer が出たら a で再判断。

**決定: a（2026-10-21、オーナー）**。汎用 SCADA の次に案件用の特化 SCADA を作るので、2 つ目の consumer がある。
詳細は §3.7。

### D7. 新パッケージと ADR

- a: 新パッケージは作らない（D1-a・D2-a・D6-d の帰結）。ADR は不要。複製の判断は conventions §8 と本書に書く。
- **D6-a の決定後の推奨**: #438 の `image-assets`（予定のパッケージ名） だけ新パッケージにし、**ADR-0020** を書く（§8）。
  #436・#435 は a のとおり既存パッケージの中で完結させる。
- b: #436・#435 をまとめて新パッケージにし、ADR を書く。D1-b と同じ理由で得が少ない。

### D8. ダッシュボードの dock layout を #437 に載せ替えるか

- a: PR-6 で載せ替える。部品の見本になるが、今の即時保存（localStorage + デバウンス）の UX が変わる。
- **b（推奨）**: 載せ替えない。#437 は部品と単体テストまで。見本が要るなら別 Issue で（対象外の
  「既存 UX を一律に明示保存へ変えない」に合わせる）。

### D9. #432 の統合をどこで見るか

- **a（推奨）**: ダッシュボードのメモ pane（今は静的な文、`DashboardPanel.svelte` の `memo`）を入力欄にし、
  e2e で dock / undock / タブ / close→open を見る。visual の作り直しが要る。
- b: e2e 専用の見本ページ（`/ui-demo` にドックのカードを足す）。本番のダッシュボードは変わらないが、
  `ui-demo` の基準画像の作り直しと、ドックを見本ページに載せる手間がある。
- c: 統合は temp-scada の受入に任せ、banto は単体と jsdom だけ。上流の回帰が見えなくなる。

### D10. v6.8.0 との関係

§6 のとおり。決定前の推奨は c（#434 だけを入れて出す）だった。

**決定: b（2026-10-21、オーナー）**。7 件をすべて片付けてから v6.8.0 を 1 回で出す。

### D11. #438 の hash（平文 HTTP の LAN で `crypto.subtle` が無い）

banto の LAN 配信は平文 HTTP（ADR-0003）で、`crypto.subtle` は secure context でしか使えない（§3.7）。

- **a（推奨）**: `crypto.subtle` があれば使い、無ければ自前の SHA-256（純粋な TS、数十行）に落とす。どちらも
  同じ 16 進の値になるので、重複排除の結果が配信の形で変わらない。自前実装は conventions §3（依存を足さない・
  自前実装の文化）に沿い、既知のテストベクタ（NIST の例）で単体テストする。8MiB の画像でも数十〜百ミリ秒程度の
  見込み（未計測。PR で測る）。
- b: secure context に限る機能として文書化し、平文 HTTP では hash を使わない（重複排除をしない、またはバイト列の
  比較だけ）。実装は小さいが、LAN の派生アプリで挙動が変わる。
- c: hash 関数を consumer が注入する。柔軟だが、各アプリが同じ問題を解くことになる。

## 10. 未確認の点

- temp-scada の fixture（10 ケース）と回帰テストは本書の作成で実行していない（Issue の記録に依る）。
- jsdom で `DockHost` の `clientWidth` を注入して表示用 clamp を確かめられるか（§3.2）。
- `bringToFront` による keyed each の DOM の移動で、フォーカス・Tab の順・IME 変換が保たれるか（§3.3）。
- `<input type="number">` の不正な入力が実ブラウザで `''` になること（HTML の仕様上はそうなる。§3.5）。
- 実 OS の IME（Windows の Microsoft IME、WebView2）での変換中の構造変更とショートカット（§7）。
- `busy` の反応性を `SvelteMap` で持てるか（§3.1）。
- dock の tab の keyboard 操作が今どこまで効くか（§3.3）。
