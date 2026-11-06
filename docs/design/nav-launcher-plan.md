# ナビゲーションの「ドック」表示（ランチャー）計画書

作成日: 2026-10-20
状態: **v6.8.0 でリリース済み**（2026-10-21、#429）。§9 の論点 D1〜D6 は 2026-10-20 にオーナー決定済み（すべて推奨案 a）。
PR-2（トークン + `LauncherBar`、`@banto/ui` と `banto.css`）を実装（ui-demo のカードは見送り、§8）。
PR-1（ナビの絞り込みの切り出し、#422）と PR-2（#423）はマージ済み。PR-3（シェルへの配線と設定、
ストア・`ShellLauncher`・レイアウトとヘッダの分岐・外観カード・e2e / a11y / visual のテスト）を実装
（visual のベースラインは visual-baselines.yml の dispatch で作る）。PR-3 で計画から変えた点は §8 の表の注記。
PR-3（#424）はマージ済み。PR-4（左右の位置、D4 を b に変更）を実装。
PR-4 はマージ済み。PR-6（上の位置、2026-10-21 オーナー決定。§8 の表と D4 の注記）を実装
（visual の基準画像 `dashboard-launcher-top-*` は visual-baselines.yml の dispatch で作る）。
トラック: 保守者向け（トラックA）
関連: [visual-refresh-design.md](visual-refresh-design.md)（§5 ナビのアイコン、§8 シェル）、
[display-preset-plan.md](display-preset-plan.md)（D1-b キオスクシェル）、
[scaffold-presets-plan.md](scaffold-presets-plan.md)、
[ADR-0018](../adr/0018-shared-ui-package.md)（`@banto/ui`）、ADR-0005（i18n）、
conventions §4 / §5 / §8 / §9 / §13 / §14、template-scope §1 / §3 / §7

## 1. 目的と範囲

admin-template の左のサイドバーの**代わりに**、macOS のドックのような**アイコンを並べたランチャー**を
利用者が選べるようにする。サイドバーは残し、既定もサイドバーのままにする（既存アプリの見た目も、
既存の visual ベースラインも動かさない）。

範囲に入れるもの: 切り替えの設定、ランチャーの部品と配線、テーマのトークン、テスト、文書。
入れないもの: 自動で隠す（macOS の「自動的に表示/非表示」）、項目の並べ替え・ピン留め、
ドラッグでの追加、ナビ定義へのグループ（セクション）機能の追加（§4.5）、サイドバー自体の `@banto/ui` への移設（§5.3）。

## 2. 現状の調査結果

### 2.1 ナビとシェル

- **ナビの定義** `apps/admin-template/src/lib/navigation.ts`: `NavItem`（`path` / `labelKey: NavLabelKey` /
  `icon: NavIconKey` / `adminOnly` / `badgeResource` / `publicViewer` / `demoOnly`）の**平らな配列**。
  グループの概念は無い。UI に依存しない（アイコンはキーだけ）。scaffold の remover が union と配列を
  **文字列の完全一致で**書き換える（`[scaffold:items]` の印も入っている）。
- **アイコン** `lib/components/navIcons.ts`: `NAV_ICONS: Record<NavIconKey | DemoNavIconKey, Component>`（lucide）。
- **サイドバー** `lib/components/Sidebar.svelte`（384 行）: ブランド / 主要ナビ / 管理ナビ（`adminOnly`、
  見出し付き）/ 折り畳みボタンの 4 区画。表示する項目の絞り込み（`publicViewer` セッションなら
  `publicNavItems()` だけ、管理ナビは `isAdmin` かつ非 publicViewer）を**コンポーネントの中で**
  `$derived` している。未読バッジ（`navBadges.count(path)`、99+ で頭打ち）、`aria-current="page"`、
  2 つの `<nav>` に `m['shell.mainNav']()` / `m['shell.adminNav']()` のラベル。
  900px 以下では固定のドロワーになり、開閉は `(app)/+layout.svelte` の `overlayOpen` が持つ。
- **シェル** `routes/(app)/+layout.svelte`: `.shell { display: flex }` に `Sidebar` と `.main`（Header + main）。
  オーバーレイの幕、Esc でドロワーを閉じる、`Ctrl+K`、View Transitions（reduced-motion で開始しない）。
- **ヘッダ** `lib/components/Header.svelte`: 900px 以下のハンバーガー（ドロワー開閉。900px 超の折りたたみボタンはサイドバー最上段のロゴの左）、ページ名、
  状態チップ、検索ピル。キオスク時はコンパクト。
- **e2e** はナビを `getByRole('navigation', { name: '主要ナビゲーション' })` で掴む（`e2e/tests/smoke.spec.ts`）。
  `aside` やクラス名には依存していない。

### 2.2 外観の設定

- **ストア** `lib/settings.svelte.ts`: 設定 1 つにつき 2 層 — localStorage（同期の書き込み、デモでは
  これだけ）と `UiSettingsProvider`（`theme.mode` / `theme.preset` / `theme.density` / `shell.kiosk`。
  ユーザーごと、REST `/api/ui-settings/*` と Tauri の `ui_settings_*`、キーは汎用でサーバーに
  許可リストは無い）。ログインごとに `syncFromProvider()` で読み戻す。キオスクの既定は
  `KIOSK_DEFAULT` 定数で、display プリセットはこの定数**だけ**を書き換える。
- **画面** `routes/(app)/settings/AppearanceSection.svelte`: テーマ（ミニプレビュー付きのラジオ）/
  プリセット / 密度 / 言語 / キオスク / vibrancy のカード群。scaffold の glass の remover がここを編集する。
- `app.html` の inline script は `banto.theme` / `preset` / `density` / `locale` を描画前に当てる
  （FOUC 対策）。`(app)` は `ssr = false` なので、シェルの形は最初の描画でストアから読めば足り、
  ナビの形のために `app.html` を触る必要は無い。

### 2.3 テーマのトークン（`packages/theme/src/css/banto.css`）

- シェル: `--banto-shell-sidebar-width(-collapsed)` / `--banto-shell-header-height(-compact)`。
- z: `--banto-z-header: 100` / `--banto-z-sidebar-scrim: 850` / `--banto-z-sidebar: 900` /
  `--banto-z-modal: 900` / `--banto-z-overlay: 1000` / `--banto-z-toast: 1000`。
- 動き: `--banto-duration-fast/base/slow`、`--banto-ease-out`、`--banto-ease-spring`。
  `prefers-reduced-motion: reduce` で duration が 0ms になる（動きの停止は 1 か所）。
- **`--banto-dock-*` は既に `@banto/dock-svelte`（ダッシュボードのドッキング窓）が使っている**
  （`--banto-dock-titlebar-height` / `-shadow` / `-divider` / `-snap-*` / `-tab-active-bg` / `-ghost-*`）。
- トーストの位置は `--banto-toast-bottom` / `--banto-toast-right` で祖先から上書きできる（`@banto/ui` の `ToastHost`）。

### 2.4 「dock」という名前の衝突

「dock」はこのリポジトリで既に**別物**を指している: `@banto/dock-svelte`（ドッキング窓）、
scaffold の資産名 `dock`（`OPTIONAL_ASSETS`、`removeDock`、minimal が外す）、
`--banto-dock-*` トークン、remove-optional-assets.md の節、template-scope §3 の行。
ランチャーを `dock` と名付けると、scaffold の説明（「dock を外す」）・トークン・grep・文書の
すべてで取り違えが起きる。→ 論点 D1。

### 2.5 共有 UI パッケージ（ADR-0018）

`@banto/ui` はコア。部品は文言・アイコン・状態・操作を props / snippet / コールバックで受け取り、
`svelte` 以外を import しない（rule `package-bare-imports`・`no-app-import`）。CSS は `--banto-*` だけ。
サイドバーそのものは `@banto/ui` に**無く**、banto-industrial の banto-hub・chronogazer も
それぞれ `Sidebar.svelte` を自前で持っている。

## 3. 切り替えの方法（設定と保存先）

- **設定画面「外観」に「ナビゲーション」カードを足す**。ラジオ 2 択「サイドバー / ドック」
  （テーマのカードと同じ形の小さなプレビュー付き。プレビューはトークンで描き、生値を使わない）。
  D4 で位置を選べるようにする場合は、ドックを選んだときだけ「上 / 下 / 左 / 右」の副ラジオを出す（上は PR-6）。
- **保存先は既存の 2 層をそのまま使う**: localStorage `banto.navLayout`（と `banto.launcherPosition`）、
  `UiSettingsProvider` のキー `shell.navLayout`（値 `sidebar` | `launcher`）と `shell.launcherPosition`
  （値 `bottom` | `top` | `left` | `right`。`top` は PR-6 で追加。既存の保存値はそのまま読める）。`setKiosk` と同じく「適用 + ローカル保存」と「プロバイダへの
  fire-and-forget の書き込み」を分け、`syncFromProvider()` で読み戻す。**ユーザーごと**の設定になる
  （テーマと同じ。管理者が全員に強制する仕組みは作らない）。
- **既定値は定数 1 つ**: `NAV_LAYOUT_DEFAULT = 'sidebar'`（`KIOSK_DEFAULT` と同じ書き方と doc コメント）。
  アプリ作者が「うちはドックが既定」にしたいときは、この定数だけを変える。サーバー側の変更は無い
  （キーは汎用。Rust の変更が要らないので src-tauri のコンパイル制約も効かない）。
- 値の検証は `isNavLayout()` / `isLauncherPosition()` の型ガードで行い、知らない値は既定に戻す
  （`isThemeMode` と同じ流儀）。
- **プロバイダに値が無いときは既定に戻す**（#421 レビュー）: 今の `syncFromProvider()` は `get()` が
  `null`（未保存）なら localStorage の値を残す。localStorage はユーザーで分かれていないので、同じ
  ブラウザで A がドックを選んだ後に未保存の B がログインすると、B にも A のドックが出てしまう。
  そこで `navLayout` / `launcherPosition` は、プロバイダの読み出しが**成功して値が無い**ときに
  `NAV_LAYOUT_DEFAULT`（と `bottom`）を当て直す（ローカル保存はするがプロバイダには書き戻さない）。
  読み出しが**失敗**したとき（オフライン・未認証・デモ）は今と同じくローカルの値を残す。
  テーマ・密度・キオスクも同じ漏れ方をするが、今回は変えない（既存の挙動の変更になるので、
  直すなら別の issue にする）。
- **ドックの透け具合（D7）**: ドックを選んだときだけ、「ナビゲーション」カードにスライダーを出す
  （`<input type="range">`、40〜100%・5% 刻み・既定 50%。ラベルと現在値の表示は辞書のキー経由）。
  保存は他の設定と同じ 2 層（localStorage `banto.launcherOpacity`、`UiSettingsProvider` の
  `shell.launcherOpacity`、値は整数のパーセント）。プロバイダに値が無ければ既定に戻す規則も
  `navLayout` と同じ。値は `document.documentElement` の `--banto-shell-launcher-opacity` に書き込む
  （アプリが書くのはこの 1 つのトークンだけで、色の式はテーマが持つ）。動かしている間もその場で
  実際のドックに反映する。
  - **プレビュー**: スライダーの横に小さな見本を置く。縞模様の本文の上に、アイコン 3 つの小さな
    バーを重ね、スライダーの値で地の濃さが変わる（見本の要素に `--banto-shell-launcher-opacity` を
    上書きし、地は `color-mix(in srgb, var(--banto-surface-overlay) var(--banto-shell-launcher-opacity), transparent)`
    で塗る。トークンだけで描き、生の色は使わない）。設定画面ではドックが本文の下端にあって
    透け方が見えにくいので、見本で確かめられるようにする。プレビューは `aria-hidden`。
  - `prefers-reduced-transparency: reduce` のときは、スライダーの値にかかわらず不透明（テーマの
    フォールバックが `--banto-shell-launcher-bg` を直接上書きする）。このときスライダーは出したまま、
    「OS の設定で透明度を下げているため不透明で表示しています」と添える（辞書のキー）。

## 4. ランチャーの見た目と振る舞い

### 4.1 配置

- **下**（既定）: 画面下端の中央に浮いた角丸のバー。`position: fixed`、下端から少し離す。
  本文が隠れないよう、ドック表示のときは `main` の下に余白（`--banto-shell-launcher-reserve`）を取り、
  トーストはドックの上に逃がす。`ToastHost` はルートの `routes/+layout.svelte` で `(app)` のシェルの
  **兄弟**として描かれるので、シェルに置いた変数は届かない（#421 レビュー）。そこで
  `(app)/+layout.svelte` がドック表示のあいだだけ `document.documentElement` に
  `data-banto-shell-nav="launcher"` を付け（`$effect` の後始末で外す。ログイン画面などドックの無い
  画面ではトーストは元の位置）、`banto.css` に
  `:root[data-banto-shell-nav='launcher'] { --banto-toast-bottom: … }` を置く（下のバーの高さ +
  余白。900px 以下はタブバーの高さ + `env(safe-area-inset-bottom)` の値を別に持つ）。
  生値はテーマに集まる（§9）。
- **上**（D4、PR-6）: 下のバーの上下反転。**ヘッダの下**の中央に浮いたバー（ヘッダは最上段のまま）。
  部品はトークン `--banto-shell-launcher-inset-top`（既定 `0px`）だけ下げ、シェルがそこにヘッダの高さ
  （キオスクではコンパクトの高さ）を入れる。本文の上に `--banto-shell-launcher-reserve` の余白を取り、
  トーストは右下のまま（下を空けたまま）。重なり順は `--banto-z-launcher`（200）のままで、ヘッダの
  ユーザーメニューは `popover` の最上位の層なのでバーより手前に出る。
- **左 / 右**（D4）: 縦向きのバー、画面の縦中央。本文の左右に余白を取る。
  ヘッダは画面いっぱいの幅になる（サイドバーが無いので）。
- サイドバーが持っていたブランド（ロゴ + "Banto"）は、ドック表示ではヘッダの左端に小さく出す
  （ブランドの文字列は既存どおりコンポーネント定数で、キーにしない）。
- 折り畳みボタンはドックには無い（`settings.sidebarCollapsed` はサイドバー専用のまま）。
- z は新しいトークン `--banto-z-launcher`（ヘッダ 100 と幕 850 のあいだ、例 200）。
  コマンドパレット（overlay 1000）・トースト・Modal はドックより手前に来る。
  ダッシュボードの `DockHost` の浮き窓は本文の中の層なので、ドックの下になる。

### 4.2 拡大のアニメーション（macOS の magnification）

- ポインタが近い項目ほど大きくする。各項目の拡大率 = `1 + (最大倍率 − 1) × f(d)`。`d` は項目の中心と
  ポインタの主軸方向の距離、`f` は影響範囲（項目約 2.5 個分）で 1 → 0 に滑らかに落ちる関数（余弦）。
  計算は**純粋関数**（`magnifyScale(distance, range, max)`）にして部品の外のモジュールに置く（単体テスト用）。
- 実装: `pointermove`（`pointerType === 'mouse'` のときだけ）を `requestAnimationFrame` で間引き、
  各項目に `--_scale` を inline の CSS 変数で渡す。項目の寸法は
  `calc(var(--banto-shell-launcher-item-size) * var(--_scale, 1))`。基準の寸法と最大倍率は
  トークン（§5.2）で、部品には生値を書かない（§9）。**寸法を変える**（transform ではない）ので、
  macOS と同じく隣が押し広げられ、バーも伸びる。下のドックは上に、上のドックは下に、左は右に、右は左に伸びる。
- `pointerleave` で全項目を `--banto-duration-base` で 1 に戻す。
- **止める条件**: `prefers-reduced-motion: reduce`（JS で `matchMedia` を見て拡大の計算そのものをしない。
  `change` にも追従。トークンの 0ms と二重の守り。View Transitions と同じ考え方）、
  `(hover: none)` / 粗いポインタ（タッチ）、900px 以下（§4.6）、D6 で設定を足した場合はその OFF。
- キーボードのフォーカスでは拡大しない（フォーカスの輪とツールチップだけ）。隣が動くと
  フォーカス位置が読みにくいため。

### 4.3 アクティブの表示

- 現在のページの項目は、アイコンの下（左右配置ならアイコンの外側）に**小さな点**
  （`--banto-primary`。非テキストのコントラスト 3:1 を満たす）と、薄い背景
  （サイドバーと同じ `color-mix(in srgb, var(--banto-primary) 14%, transparent)`）。
  glass プリセットではサイドバーと同じくアクセントのグラデーションを使う。
- リンクに `aria-current="page"` を付ける（判定はサイドバーと同じ `isPathActive`）。

### 4.4 ツールチップ

- ホバーと `:focus-visible` で項目の外側（下のドックなら上、上のドックなら下）に名前を出す。
  `--banto-surface-raised` / `--banto-text` / `--banto-border` / `--banto-shadow-md` / `--banto-radius-md`。
- ツールチップ要素は `aria-hidden="true"`。アクセシブルな名前はリンク内の
  視覚的に隠したテキスト（ラベル + バッジ件数）で持つ（音声操作で「品目をクリック」が通るよう、
  `aria-label` より実テキストを選ぶ）。`title` 属性は使わない（二重に出るため）。
- WCAG 1.4.13（#421 レビューで具体化）:
  - **ホバーを保つ**: ツールチップは項目の包み（`<li>`）の子に置き、表示は包みの `:hover` /
    `:focus-within`（`:focus-visible` のとき）で決める。ツールチップは `pointer-events: auto` にし、
    項目とツールチップのすき間は包みの疑似要素（`::before` の透明な橋）で埋める。これでポインタを
    アイコンからツールチップの文字の上へ動かしても消えない。ツールチップはリンクではなく、
    クリックしても何もしない（下の本文は、ツールチップが出ている小さな範囲だけ一時的に隠れる）。
  - **Esc はフォーカスの位置によらず受ける**: ツールチップを出しているあいだだけ `window` に
    `keydown` を登録し（消えたら外す）、Esc で閉じる。ほかの層が優先: パレットや Modal・Drawer・
    メニューが出ているとき（同じパッケージの `hasVisibleLayerAbove()`）か、`event.defaultPrevented`
    のときは何もしない。閉じるときも `preventDefault` / `stopPropagation` はしない（シェルの Esc の
    処理を奪わない）。Esc で閉じた後は、ポインタが項目から出るかフォーカスが移るまで出し直さない
    （同じ位置でポインタが少し動いただけで再表示しない）。
  - **時間で消さない**: ホバーかフォーカスが続くあいだは出し続ける。

### 4.5 グループ（セクション）

- 今のナビは「主要」と「管理（`adminOnly`）」の 2 つだけ。ドックでは**区切り線**で分ける
  （macOS のアプリとゴミ箱のあいだの線と同じ）。見出しは出さない。
- ランドマークはサイドバーと同じく **2 つの `<nav>`**（`shell.mainNav` / `shell.adminNav` のラベル）にする。
  e2e のロケーター（`getByRole('navigation', { name: '主要ナビゲーション' })`）がドック表示でもそのまま使える。
- 部品の API は「グループの配列」（`{ id, ariaLabel, items }[]`）を受け取り、グループのあいだに区切りを描く。
  ナビ定義にグループの概念を足すのは範囲外（必要になったら navigation.ts に `group` を足し、
  サイドバーとドックの両方が使う別計画にする）。
- **項目が多いとき**: 幅（高さ）が足りなければバーの中で横（縦）にスクロールする。
  拡大は可視の項目に対してだけ効く。

### 4.6 狭い画面（900px 以下）とタッチ

- 推奨（D5-a）: 位置の設定にかかわらず、**画面下端いっぱいのタブバー**にする（拡大なし、
  アイコン + 小さなラベル、ラベルは省略記号で切る、`env(safe-area-inset-bottom)` を足す）。
  ハンバーガーとドロワーは使わない（ドック表示ではヘッダのハンバーガーを出さない）。
- 項目は最小 44×44px（WCAG 2.5.8 の 24px を大きく上回る。タッチ前提）。

### 4.7 キーボード操作

- 各項目はふつうのリンク（`<a href>`）で、Tab の順にそのまま並ぶ（ロービング tabindex にはしない。
  ナビのリンク集であって toolbar ではないため。APG の disclosure/menu の型にも当てはめない）。
- DOM の位置はサイドバーと同じく `.main` の**前**に置く（フォーカス順でナビが本文より先に来る。
  今のサイドバーと同じ体験）。見た目が下でも、ランドマークで飛べる。
- `Ctrl+K`（コマンドパレット）は今と同じ。ドック固有のショートカットは足さない。

### 4.8 アクセシビリティのまとめ

- ランドマーク 2 つ・`aria-current`・実テキストの名前・バッジの件数を名前に含める（サイドバーの
  `shell.navUpdates` を流用）・フォーカスの輪（既存トークン）・コントラスト（アクティブの文字色は
  サイドバーと同じ理由で `--banto-primary-hover`）。
- 動き: 拡大・ツールチップの出入り・項目の戻りはすべて duration トークン経由（reduced-motion で 0ms）+
  拡大自体を JS でも止める。
- axe（`e2e/visual/a11y.spec.ts`）にドック表示の走査を足す（§7.3）。

### 4.9 キオスク・閲覧公開との関係

- キオスク（`shell.kiosk`）は今と同じくヘッダのコンパクト化。ドック表示中はサイドバーの折り畳みが
  関係なくなるだけで、組み合わせに特別な処理は入れない。
- 閲覧公開（publicViewer）セッションは、サイドバーと**同じ絞り込み**（`publicNavItems()` だけ、
  管理ナビ無し）。このため絞り込みを共通の関数に切り出す（§5.1、PR-1）。

## 5. 部品の分け方と置き場

### 5.1 アプリ側（admin-template、コピーされる側）

- `lib/navigation.ts` に純粋関数 `navSections({ publicViewer, role })` を足し、
  「主要 / 管理」の 2 グループを返す。`Sidebar.svelte` の `mainItems` / `adminItems` の `$derived` を
  これに置き換える（**挙動は同じ**、画面も変わらない）。navigation.ts は UI 非依存のまま
  （セッションは引数で受け、`sessionStore` は import しない）。`navigation.test.ts` に表のテストを足す。
- `lib/components/ShellLauncher.svelte`（新規、約 50 行）: `navSections()`・`NAV_ICONS`・`navBadges`・
  `page.url.pathname`・`m[...]` を読んで、`@banto/ui` の部品に props として渡すだけの配線。
  Sidebar と並ぶ「シェルの部品」。
- `lib/settings.svelte.ts`: `navLayout` / `launcherPosition` と set/apply/sync（§3）。
- `routes/(app)/+layout.svelte`: `settings.navLayout` で `Sidebar` と `ShellLauncher` を出し分け、
  シェルにドック用のクラス（本文の余白）を付ける。トーストの位置はルート要素の
  `data-banto-shell-nav` 属性で動かす（§4.1）。
- `Header.svelte`: ドック表示ではハンバーガーを出さず、ブランドを出す。
- `AppearanceSection.svelte`: 「ナビゲーション」カード。
- `messages/{ja,en}.json`: `settings.navLayout*`（見出し・説明・選択肢・グループの aria）、
  `settings.launcherPosition*`（D4-b のとき）、`shell.launcherAria` 程度。
  UI ラベルは ja「ドック」/ en「Dock」（コード上の名前とは別。D1）。

### 5.2 テーマ（`@banto/theme`）

`banto.css` の `:root` に**シェルの名前空間で**足す（`--banto-dock-*` は使わない。§2.4）:

| トークン | 例 | 用途 |
|---|---|---|
| `--banto-shell-launcher-item-size` | 44px | 項目の基準寸法 |
| `--banto-shell-launcher-magnify-max` | 1.5 | 拡大の最大倍率（単位なし） |
| `--banto-shell-launcher-gap` | 6px | 項目の間隔 |
| `--banto-shell-launcher-padding` | 6px | バーの内側の余白 |
| `--banto-shell-launcher-offset` | 10px | 画面端からの距離 |
| `--banto-shell-launcher-reserve` | calc(...) | 本文に取る余白（item-size + padding×2 + offset） |
| `--banto-z-launcher` | 200 | 重なり順 |
| `--banto-shell-launcher-opacity` | 50% | バーの不透明度。設定のスライダーが変えるのはこの値だけ（D7） |
| `--banto-shell-launcher-bg` | `surface-overlay` を opacity で薄めた色 | バーの半透明の地（D7） |
| `--banto-shell-launcher-backdrop` | `blur(1px) saturate(1.5)` | バーの後ろのぼかし（D7） |
| `--banto-shell-launcher-tooltip-bg` | `surface-raised` の 80% | ツールチップの半透明の地（D7） |
| `--banto-shell-launcher-tooltip-backdrop` | `blur(5px)` | ツールチップの後ろのぼかし（D7） |

背景・枠・影・角丸・glass は既存のトークン（`--banto-surface` / `--banto-border` / `--banto-shadow-lg` /
`--banto-radius-lg` / `--banto-backdrop`）を使い、新しい色は足さない。密度 `compact` で
item-size を小さくするかは実装時に見た目で決める（足すなら `[data-banto-density='compact']` の上書き 1 行）。
倍率を JS が読むので、部品は `getComputedStyle` で `--banto-shell-launcher-magnify-max` を読む
（読めなければ 1 = 拡大しない、として安全側に倒す）。

### 5.3 共有 UI（`@banto/ui`）に置くもの — 推奨（D2-a）

- `LauncherBar.svelte`（表示と操作だけ）と `launcher.ts`（`magnifyScale` などの純粋関数と型）。
  props:
  - `groups: { id: string; ariaLabel: string; items: LauncherItem[] }[]`
  - `LauncherItem = { id: string; href: string; label: string; icon: UiIconComponent; active?: boolean; badge?: { text: string; label: string } }`
  - `position?: 'bottom' | 'left' | 'right'`（既定 `bottom`）、`magnify?: boolean`（既定 `true`）、
    `ariaLabel?: string`（バー全体の要素に付ける場合）
  - 文言は全部 props で受けるので `UiMessages` は増やさない（増やす場合も既定値は ADR-0018 §2 と同じ形）。
- **`.svelte.ts` を足さない**（状態は `.svelte` の中の `$state` で持つ）。足すと conventions §14 の
  `optimizeDeps.exclude` と外部利用 fixture の更新が要る。`@banto/ui` は既に exclude 済みなので
  実害は無いが、足さない方針で設計する。
- `svelte` 以外を import しない（§5、rule `package-bare-imports`）。アイコンは呼び出し側が
  lucide の部品を渡す（`NAV_ICONS` をそのまま使える）。リンクは素の `<a href>` で、
  SvelteKit のクライアント遷移は呼び出し側の文書で効く（パッケージは `$app/*` を知らない）。
- 狭い画面のタブバー化（§4.6）も部品の CSS の中で行う（`@media (max-width: 900px)`。
  ブレークポイントは既存のシェルと同じ値で、今もコンポーネントの CSS に書いている）。

**理由**: (1) コピー面積を増やさない — 拡大の計算・ツールチップ・Esc・a11y の約 250 行を
派生アプリが写さずに済み、修正が伝わる（ADR-0018 の動機そのもの）。(2) banto-industrial の
2 アプリも自前の Sidebar を持っており、同じ部品を使える。(3) 部品はナビ定義（`NavItem`）を知らず、
汎用の「リンクの並び」として切れる（§5 を守れる）。

**サイドバーは今回 `@banto/ui` に移さない**: 挙動が変わらない大きな移設になり、ベースラインと
banto-industrial への影響が大きい。必要になったら別計画（ADR-0018 の次の段階）。

### 5.4 ADR

置き場の判断は ADR-0018 の延長なので、新しい ADR は作らず、ADR-0018 に「§11 段階 5:
LauncherBar」を足す（判断・props の形・`.svelte.ts` を持たない理由・サイドバーは移さない理由）。
D2 で別案になったときは、その結論を同じ節に書く。

## 6. scaffold のプリセットとコピー面積

- **推奨（D3-a）: コアの機能として全プリセットに残す**（新しい scaffold 資産を作らない）。
  - アプリ側に足すのは約 150〜200 行（ShellLauncher 約 50、設定ストア約 40、外観カード約 50、
    レイアウトとヘッダの分岐約 20、辞書のキー約 10 × 2）。重い部分はパッケージにあり、写されない。
  - 消す仕組み（remover・acceptance の matrix・remove-optional-assets.md の節）を足すより、
    残す方が保守も利用者の理解も軽い。不要なアプリ作者は外観カードを消せば選べなくなる
    （既定はサイドバーなので、消すのはカード 1 枚と辞書のキーだけ）。この手順を
    remove-optional-assets.md ではなく README か recipes に 3 行で書く。
  - display プリセットの既定値は**変えない**（キオスクはサイドバー折り畳みのまま）。
    display でドックを既定にしたい要望が出たら、`NAV_LAYOUT_DEFAULT` を display の
    `displayDefaults` で書き換える（`KIOSK_DEFAULT` と同じ流儀）で足りる。
- D3-b（オプション資産 `launcher` にして minimal / display で外す）を選んだ場合: `OPTIONAL_ASSETS` に足し、
  remover が layout・Header・AppearanceSection・settings ストア・辞書から外す。ShellLauncher と
  ストアの該当部分に `[scaffold:launcher]` の印を置く。template-scope §3 に行と削除手順を足す。
  acceptance の 4 プリセットで確かめる。PR が 1 つ増える。
- **どちらでも必要なこと**: 変更するファイルの多くが scaffold のアンカー対象（`(app)/+layout.svelte`・
  `Header.svelte`・`AppearanceSection.svelte`・`settings.svelte.ts`・`navigation.ts`）。
  remover は文字列の完全一致で編集するので、各 PR で **4 プリセットの `--dry-run`** をコピーに対して
  走らせ、アンカーを壊していないことを確かめる（template-acceptance は paths で起動するが、
  PR の中で自分で確かめてから出す）。
- template-scope §2.2（横断機能）に「ナビの表示形式（サイドバー / ドック）」を 1 行足す。

## 7. テストの方針

### 7.1 単体（vitest / jsdom）

- `packages/ui/tests/launcher.test.ts`: `magnifyScale` の表（距離 0 で最大、範囲外で 1、単調減少、
  最大倍率 1 なら常に 1）。
- `packages/ui/tests/LauncherBar.test.ts`（`@testing-library/svelte`）: グループごとの `<nav>` と
  `aria-label`、リンクの `href` と実テキストの名前、`active` → `aria-current="page"`、
  グループのあいだの区切り、バッジの名前、ツールチップが `aria-hidden`、Esc でツールチップが消える（フォーカスがドックの外でも。`window` の listener が表示中だけ登録され、消えたら外れる）、層が出ているときの Esc では閉じない、
  `position` のクラス、`matchMedia('(prefers-reduced-motion: reduce)')` が真なら
  `pointermove` で `--_scale` が付かない、`pointerType: 'touch'` でも付かない。
  jsdom には寸法が無いので、拡大の見た目は §7.3 の visual で見る。
- `apps/admin-template/src/lib/navigation.test.ts`: `navSections()` の表（通常 viewer / editor / admin /
  publicViewer、`demoOnly` の除外）。
- 設定ストア: `navLayout` の読み込み（知らない値 → 既定）、set で localStorage とプロバイダに書く、
  `syncFromProvider()` で上書きされる、**プロバイダが `null` を返したら localStorage が `launcher` でも
  既定に戻る**、プロバイダが失敗したらローカルの値を残す（既存のストアのテストの形に合わせる。
  無ければ新規 `settings.test.ts`）。
- トーストの位置: ドック表示の `(app)` レイアウトを出すとルート要素に `data-banto-shell-nav` が付き、
  外すと消える。

### 7.2 e2e（`pnpm e2e`、banto-serve）

`e2e/tests/smoke.spec.ts` に 1 本:
外観でドックを選ぶ → 主要ナビ（同じロケーター）のリンクで遷移でき `aria-current` が移る →
再読み込みしても保たれる（localStorage）→ 同じブラウザで未保存の別ユーザーにログインし直すと既定のサイドバーに戻る（§3）→ トーストがドックに重ならない →
サイドバーに戻す。狭い画面（`setViewportSize` 768×1024）でタブバーになり、ハンバーガーが無いこと。
publicViewer のスイート（`e2e/tests-public-viewer`）には、ドック表示でも許可リストの項目だけが
出ることを 1 本足す（localStorage を事前に入れる）。

ツールチップ（§4.4、WCAG 1.4.13）は実ブラウザでしか確かめられないので、e2e に 2 本足す:

1. **ホバーの維持**: 項目にホバーしてツールチップを出す → ポインタをツールチップの文字の上へ動かす
   （すき間を通る）→ 消えていない。ポインタを外へ出すと消える。
2. **フォーカスが本文にあるときの Esc**: 本文の入力欄にフォーカスを置いたまま項目にホバー →
   Esc でツールチップが消え、入力欄のフォーカスと入力は残る → 同じ位置でポインタを少し動かしても
   再表示しない。あわせて、パレット（`Ctrl+K`）を開いた状態の Esc はパレットが閉じ、
   ツールチップの処理は動かないこと。
3. **キーボードフォーカスで出したツールチップの Esc**（#423 レビュー）: マウスをバーの外に置いたまま
   Tab で項目にフォーカス → ツールチップの computed `visibility` が `visible` → Esc で `hidden` になり、
   フォーカスはその項目に残る → Tab で次の項目へ移ると、次の項目のツールチップが出る。
   `:focus-visible` と CSS の詳細度に関わるので、jsdom ではなく実ブラウザで確かめる。PR-2 の時点では
   バーがアプリに出ていないため、自動テストは PR-3 で足す（PR-2 では一時的な確認用ページを作り、
   実ブラウザで手で確かめた）。

### 7.3 visual（ベースラインは Linux でだけ生成）

- **既存のベースラインは動かない見込み**: 既定はサイドバーのまま。ただし設定画面の外観カテゴリに
  カードが 1 枚増えるので `settings-light-standard` / `settings-dark-glass` は作り直しになる。
  `ui-demo` に LauncherBar のカードを足すなら `ui-demo-*` も作り直し。
- **足すもの**: `dashboard-launcher-light-standard-1440x900`、`dashboard-launcher-dark-glass-1440x900`、
  `dashboard-launcher-light-standard-768x1024`（タブバー）。キオスクの撮影と同じく、localStorage を
  事前に入れて撮る。拡大中の 1 枚（ポインタを項目の上に置いた状態）を
  `dashboard-launcher-magnify-light-standard-1440x900` として足すかは実装時に安定性を見て決める
  （アニメーションの終わりを待つ必要がある）。
- 作業機には WSL / Docker が無いので、ベースラインは `.github/workflows/visual-baselines.yml` を
  PR のブランチに dispatch して作り、そのコミットを PR に入れる。差分が「増えた/変えたつもりの
  画像だけ」であることを PR の説明で確かめる。
- `e2e/visual/a11y.spec.ts` にドック表示の dashboard の axe 走査を足す（light-standard / dark-glass）。

### 7.4 そのほかの検証

`pnpm check`・`pnpm lint`・`pnpm verify:architecture`（raw-colors・package-bare-imports・no-app-import・
raw-jp-in-app）・`pnpm format:check`。Rust の変更は無いので `cargo test` は影響しない見込みだが、
最後に 1 回回す。外部利用 fixture は `@banto/ui` を既に使っており、`.svelte.ts` を足さないので変更不要
（external-consumer のワークフローが packages を触る PR で自動で走る）。

## 8. PR の分け方と順番

| # | PR | 中身 | 画面の変化 / ベースライン |
|---|---|---|---|
| 0 | 計画（本書） | 本書の追加。オーナー決定を §9 に書き込む | なし |
| 1 | ナビの絞り込みの切り出し | `navSections()` を navigation.ts に足し、Sidebar をそれで書き直す。テスト。挙動は同じ | なし（visual が変わらないことを確かめる） |
| 2 | トークン + `LauncherBar`（下のみ） | `banto.css` に §5.2 のトークン、`@banto/ui` に `LauncherBar` / `launcher.ts`、単体テスト、README、ADR-0018 §11。**計画からの変更**: `ui-demo` のカードは見送った（固定配置のバーが見本ページの上に浮き、`ui-demo-*` の作り直しが要るため。実ブラウザの見た目は 3 の visual で見る） | なし |
| 3 | シェルへの配線と設定 | 設定ストア、ShellLauncher、レイアウト・ヘッダの分岐、外観カード、辞書、e2e、a11y、visual 追加。**計画からの変更**: (1) デモモードの `UiSettingsProvider` は localStorage（`banto.ui.` 接頭辞）で読み出しが**成功**するので、§3 の「失敗したらローカルを残す」はデモには当たらない（デモでは `banto.ui.shell.navLayout` が真実源。テストは両方のキーを事前に入れる）。(2) スライダーは `input` でその場に反映し（ローカル保存だけ）、プロバイダへの書き込みは `change` の 1 回にした（ドラッグ中の書き込みが前後して届くのを避ける）。(3) 900px 以下のタブバーの高さはトークン `--banto-shell-launcher-tabbar-reserve` を `@banto/theme` に足して表した（本文の余白とトーストの位置で共有）。(4) ShellLauncher の単体テストは、アプリの vitest が node 環境で部品を描けないので足さず、`navSections()` の表（PR-1）と e2e（閲覧公開の許可リスト）で見る。トーストの位置の単体テスト（§7.1 の最後）も同じ理由で e2e（バーとトーストの位置の比較）にした | `settings-*` 作り直し + `dashboard-launcher-*` 追加 |
| 4 | 左 / 右（D4-b のとき） | 部品の `position`、設定の副ラジオ、visual 2 枚追加。**実装の注記**: (1) 位置はルートの 2 つ目の属性 `data-banto-shell-launcher-position` で表し（`data-banto-shell-nav="launcher"` はそのまま）、右のバーではトーストを `--banto-toast-right` でバーの左へ逃がす。(2) 縦のバーのツールチップは横に出て折り返すので、最大幅をトークン `--banto-shell-launcher-tooltip-max-width`（10rem）にし、スクロールするトラックが本文側にその幅ぶんの余白を持つ（切れないように）。端の項目の内寄せは要らない（ツールチップが項目より低い）。(3) ダッシュボードの浮き窓（`role="dialog"`、本文の中の層）が出ているとツールチップの Esc を譲っていたので、`hasVisibleLayerAbove` をバー自身の z-index と比べるようにした（e2e のキーボードの Esc がときどき落ちていた原因）。(4) 外観カードの説明文（「画面下のドック」→「画面の端のドック」）を直したので `settings-*` も作り直し | `settings-*` 作り直し + `dashboard-launcher-left-*` / `-right-*` 追加 |
| 6 | 上（2026-10-21 オーナー決定） | 部品の `position` に `'top'`、トークン `--banto-shell-launcher-inset-top`、設定の副ラジオ「上」、辞書、e2e、visual 1 枚追加。**判断**: (1) 上のバーはヘッダの下（§4.1）。(2) 900px 以下はほかの位置と同じく下端のタブバー（D5 のまま。親指の届く位置で、上にはヘッダがあり、上にタブバーを積むとヘッダと二段になって本文が狭くなる）。(3) アクティブの点は左右と同じく画面の端の側（上） | `settings-*` 作り直し + `dashboard-launcher-top-*` 追加 |
| 5 | 文書 | README / recipes（不要なら外す 3 行）、template-scope §2.2、CHANGELOG の未リリース節、upgrading.md（派生アプリが取り込む手順）、本書の状態行 | なし |

- 1 は 2 と独立なので並行できる。3 は 1 と 2 の後。4 は 3 の後。5 は 3（4）の後でも各 PR に分けて
  入れてもよい（CHANGELOG は各 PR で 1 行ずつ足す方が今の運用に合う）。
- D3-b を選んだ場合は、3 の後に「scaffold の remover と acceptance」の PR を 1 つ足す。
- 版: パッケージの公開 API の追加だけなので minor（v6.8.0 を想定）。
- 各 PR で 4 プリセットの scaffold `--dry-run` を確かめる（§6）。自作の PR はセルフマージしない。

## 9. 論点とオーナー決定（2026-10-20）

**決定: D1〜D6 はすべて推奨案（a）で確定**。

| 論点 | 決定 |
|---|---|
| D1 コード上の名前 | a: コード・トークン・設定値は `launcher`、画面の表示は ja「ドック」/ en「Dock」 |
| D2 部品の置き場 | a: 表示と操作は `@banto/ui` の `LauncherBar`、配線は admin-template の `ShellLauncher` |
| D3 コアかオプションか | a: コア。全プリセットに残す。既定はサイドバー |
| D4 位置 | a: 最初は下だけ。`position` は API に最初から持たせ、左右は要望を見て PR-4 で足す。**2026-10-20 に左右も足すことにした（PR-4）**: 設定「ドックの位置」下 / 左 / 右（既定は下）、900px 以下はどの位置でも下のタブバー（D5）。**2026-10-21 に上も足すことにした（PR-6）**: 上 / 下 / 左 / 右、上はヘッダの下、ツールチップと拡大は下向き |
| D5 狭い画面 | a: 下端いっぱいのタブバー（アイコン + 小さなラベル、拡大なし） |
| D6 拡大の ON / OFF | a: 拡大は ON。reduced-motion・タッチ・狭い画面では自動で OFF。設定項目は足さない |
| D7 背景の透け具合（#423 で追加） | バーとツールチップの地を半透明にし、後ろをぼかす。既定値はオーナーが実ブラウザで調整した値（バー 50%・ぼかし 1px・彩度 1.5、ツールチップ 80%・ぼかし 5px）。`prefers-reduced-transparency` と `backdrop-filter` 非対応では不透明。**ユーザーが設定のスライダーで調整できる**（2026-10-20 決定、PR-3）: バーの不透明度だけを 40〜100%・5% 刻み・既定 50% で選ぶ。ツールチップは 80% で固定（名前の読みやすさ）。スライダーの横にプレビューを置く（§3）。**900px 以下のタブバーは不透明度 85% を下限にする**（2026-10-21 オーナー決定。小さなラベルが本文の上に乗るため。トークン `--banto-shell-launcher-tabbar-opacity-min`） |

これにより、§8 の PR-4 は要望が出るまで保留（のちに D4 の注記のとおり実施）、D3-b の scaffold PR は作らない。以下は検討の記録として残す。

### D1. コード上の名前

- **a（推奨）**: コード・トークン・設定値は `launcher`（`LauncherBar` / `ShellLauncher` /
  `--banto-shell-launcher-*` / `shell.navLayout = 'launcher'`）。画面の表示は ja「ドック」/ en「Dock」。
  既存の `dock`（dock-svelte・scaffold 資産・`--banto-dock-*`）と grep でも文書でも取り違えない。
- b: `NavDock` / `--banto-shell-navdock-*` / 値 `dock`。表示とコードが揃うが、`dock` を含む grep と
  scaffold の説明で紛れる。
- c: そのまま `Dock` / `--banto-dock-*`。トークンが dock-svelte と衝突するので不可に近い。

### D2. 部品の置き場

- **a（推奨）**: 表示と操作は `@banto/ui` の `LauncherBar`、配線（ナビ定義・権限・バッジ・辞書）は
  admin-template の `ShellLauncher`（§5.3 の理由）。
- b: 全部 admin-template に置く。パッケージの API を固めずに試せるが、約 250 行が写される側に増え、
  banto-industrial は使えない。後で移すと二度手間。
- c: サイドバーも合わせて `@banto/ui` に移す。範囲が大きく、今回の目的から外れる（別計画）。

### D3. コアかオプションか（scaffold）

- **a（推奨）**: コア。全プリセットに残す。既定はサイドバー（§6）。
- b: オプション資産 `launcher`。minimal / display で外す。remover と acceptance の PR が 1 つ増える。

### D4. 位置

- **a（推奨）**: 最初は**下だけ**を出し（PR-3）、部品の API には `position` を最初から持たせる。
  左右は要望を見て PR-4 で足す（API を壊さない）。業務アプリは表の縦幅が大事なので、
  左右の需要が出る可能性はあるが、最初の見た目の確認とベースラインを小さく保てる。
- b: 最初から下 / 左 / 右を設定で選べるようにする（PR-3 と PR-4 を一緒に出す）。

### D5. 狭い画面（900px 以下）

- **a（推奨）**: 下端いっぱいのタブバー（アイコン + 小さなラベル、拡大なし）。
- b: 狭い画面ではサイドバーのドロワーに戻す（ドックはデスクトップ幅だけ）。実装は軽いが、
  設定と見た目が画面幅で食い違う。

### D6. 拡大の ON / OFF

- **a（推奨）**: ドックを選ぶと拡大は ON。reduced-motion・タッチ・狭い画面では自動で OFF。
  設定項目は足さない（設定の数を増やさない）。
- b: 外観に「拡大する」のトグル（`shell.launcherMagnify`）を足す。
- c: 拡大しない（ホバーで色が変わるだけ）。いちばん軽いが「macOS のドックのような」から遠い。

## 10. 委譲するときの注意（実装の指示に入れる）

- ファイルは grep で位置を探してから行の範囲を指定して読む（Sidebar.svelte・scaffold.mjs・
  banto.css・設計書は丸ごと読まない）。
- テストは名前で絞って走らせ、全体は最後に 1 回。ビルド・テストの出力は `tail` / `grep` で絞る。
- `pnpm format:check` も回す。scaffold の 4 プリセットの `--dry-run` を確かめる。
- 部品の CSS に生値を書かない（§9）、`svelte` 以外を import しない（§5）、app の `.svelte` に
  生の日本語を書かない（§13）、`.svelte.ts` を足さない（§14）。
- モデル: PR-1・PR-5 は軽い（sonnet）。PR-2・PR-3 は a11y と動きの設計を含むので上位のモデル。
