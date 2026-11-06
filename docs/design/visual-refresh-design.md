# Banto ビジュアルリフレッシュ設計書

作成日: 2026-07-15  
状態: **実装済み**（M22 完了。本書はコンポーネント API・DOM・キーボード挙動の
仕様アンカーとして現役。2026-11-04: 重複タイトル非表示、boolean control の共有化と狭幅対応を追補）

対応計画: [visual-refresh-plan.md](visual-refresh-plan.md)（M22）  
運用: 以後トークン値を変える場合は `banto.css` と計画書付録 A を同時更新する
（値の正は付録 A、本書 §2.1 は再掲）

本書は計画書の各 Phase を実装可能なレベルまで具体化する。トークンの確定値は
計画書の付録 A を正とし、本書では CSS・型・コンポーネント API・DOM 構造・
キーボード挙動・検証設定を定義する。計画書と本書が矛盾した場合は計画書
（スコープ・完了条件）が優先する。

## 1. 変更ファイルマップ

実装単位（計画 §6）ごとの新規/変更ファイル一覧。

| 単位 | 新規 | 変更 |
|---|---|---|
| 0 VR基盤 | `e2e/visual/*.spec.ts`、`e2e/visual/README.md` | `e2e/playwright.config.ts`、`src/lib/banto/sampleData.ts`（PRNG シード化） |
| 1 テーマ/共通UI | `src/lib/components/ui/`（PageHeader ほか）、`src/lib/components/menu/`、`src/lib/components/navIcons.ts` | `packages/theme/src/css/banto.css`、`packages/theme/src/index.ts`、`app.css`、`app.html` |
| 2 シェル/ログイン | — | `Sidebar.svelte`、`Header.svelte`、`(app)/+layout.svelte`、`navigation.ts`、`login/+page.svelte` |
| 3 ダッシュボード | — | `dashboard/+page.svelte`、`DashboardPanel.svelte`、`packages/charts`（クローム）、`packages/dock-svelte`（クローム） |
| 4 一覧/グリッド/フォーム | — | `items/**`、`audit-log/**`、`packages/grid-svelte`（スタイル）、`packages/forms`（スタイル） |
| 5 設定/ユーザー管理 | — | `settings/+page.svelte`、`users/**`、`settings.svelte.ts`（密度） |
| 6 状態/モーション/QA | `src/lib/components/ui/EmptyState.svelte` ほか状態系 | 全画面、`(app)/+layout.svelte`（View Transitions） |

パスは断りがない限り `apps/admin-template/src/` 起点。

## 2. テーマトークン（`packages/theme/src/css/banto.css`）

### 2.1 追加トークン

`:root` に追加（値は計画書付録 A）。既存トークンは削除しない。

```css
:root {
	/* 面の階層（付録 A.1） */
	--banto-surface-subtle: #f1f3f6;
	--banto-surface-hover: #eef1f5;
	--banto-surface-overlay: var(--banto-surface);
	--banto-border-strong: #848b96;

	/* 状態色 3 系統（付録 A.3）。既存 --banto-primary 等は「text 系」の
	   既定として温存し、塗り/淡色ペアを追加する。 */
	--banto-primary-solid: #2563eb;
	--banto-primary-solid-hover: #1d4ed8;
	--banto-on-solid: #ffffff;
	--banto-danger-solid: #dc2626;
	--banto-danger-solid-hover: #b91c1c;
	--banto-success-solid: #15803d;
	--banto-danger-tint: #fee2e2;
	--banto-danger-tint-text: #991b1b;
	--banto-success-tint: #dcfce7;
	--banto-success-tint-text: #166534;
	--banto-warning-tint: #fef3c7;
	--banto-warning-tint-text: #92400e;

	/* 形状・影（付録 A.4） */
	--banto-radius-sm: 4px;
	--banto-radius-md: 6px;
	--banto-radius-lg: 10px;
	--banto-shadow-sm: 0 1px 2px rgb(0 0 0 / 0.06);
	--banto-shadow-md: 0 2px 8px rgb(0 0 0 / 0.1);
	--banto-shadow-lg: 0 8px 24px rgb(0 0 0 / 0.18);

	/* 寸法（付録 A.4。密度軸 §4 が上書きする） */
	--banto-control-height: 36px;
	--banto-control-height-sm: 28px;
	--banto-control-height-lg: 40px;

	/* モーション（付録 A.6） */
	--banto-duration-fast: 120ms;
	--banto-duration-base: 160ms;
	--banto-duration-slow: 240ms;
	--banto-ease-out: cubic-bezier(0.2, 0, 0, 1);
	--banto-ease-spring: linear(0, 0.35 12%, 0.8 24%, 1.04 40%, 0.99 65%, 1);
}
```

`[data-theme='dark']` には付録 A の dark 列を同名で定義する
（`--banto-surface-subtle: #23262d` など。solid 系は
`--banto-primary-solid: #3b82f6` + `--banto-on-solid: var(--banto-text-inverse)`、
danger solid は `#dc2626` + 白文字を維持 — 付録 A.3 の判定どおり）。

### 2.2 エイリアスと後方互換

- `--banto-radius` は値を `var(--banto-radius-md)` に変更（6px のまま、意味は不変）。
- `--banto-dock-shadow` は `var(--banto-shadow-lg)` を参照するよう変更
  （dark の濃い影は dark ブロックで `--banto-shadow-lg` 自体を上書き）。
- 既存トークンの削除・改名は行わない。テンプレート利用者のオーバーライドを
  壊さないため（計画 Phase 1）。

### 2.3 reduced-motion

```css
@media (prefers-reduced-motion: reduce) {
	:root {
		--banto-duration-fast: 0ms;
		--banto-duration-base: 0ms;
		--banto-duration-slow: 0ms;
	}
}
```

コンポーネントは duration をトークン経由でのみ使うこと。これで
「非本質的アニメーションの無効化」（計画 Phase 6）が一括で効く。

## 3. Tailwind `@theme` 橋渡し（`app.css`）

Tailwind v4 の `@theme inline`（他変数を参照する値は `inline` が必須）で
`--banto-*` をユーティリティへ公開する。

```css
@import 'tailwindcss';
@import '@banto/theme/css';

@theme inline {
	--color-surface: var(--banto-surface);
	--color-surface-subtle: var(--banto-surface-subtle);
	--color-border: var(--banto-border);
	--color-primary: var(--banto-primary);
	--color-danger: var(--banto-danger);
	--color-muted: var(--banto-text-muted);
	--radius-sm: var(--banto-radius-sm);
	--radius-md: var(--banto-radius-md);
	--radius-lg: var(--banto-radius-lg);
	--shadow-sm: var(--banto-shadow-sm);
	--shadow-md: var(--banto-shadow-md);
	--shadow-lg: var(--banto-shadow-lg);
}
```

これにより `bg-surface`、`text-muted`、`rounded-lg` 等が
Light/Dark/Glass/密度に自動追従する。**パッケージ（`packages/*`）は
引き続き Tailwind 非依存**で、scoped `<style>` + `--banto-*` のみを使う。

### 3.1 共通クラス（汎用ラッパーを作らない代わり）

`Button`/`Card` コンポーネントは作らず（計画の方針）、`app.css` に
最小限の共通クラスを定義する。トークン以外の生値は書かない。

```css
.banto-btn {
	height: var(--banto-control-height);
	padding: 0 0.9rem;
	border-radius: var(--banto-radius-md);
	border: 1px solid transparent;
	transition: background var(--banto-duration-fast) var(--banto-ease-out);
}
.banto-btn--primary { background: var(--banto-primary-solid); color: var(--banto-on-solid); }
.banto-btn--secondary { background: var(--banto-surface); border-color: var(--banto-border-strong); }
.banto-btn--ghost { background: transparent; color: var(--banto-text-muted); }
.banto-btn--danger { background: var(--banto-danger-solid); color: #ffffff; }
.banto-input {
	height: var(--banto-control-height);
	border: 1px solid var(--banto-border-strong);
	border-radius: var(--banto-radius-md);
	background: var(--banto-surface);
}
```

（hover/focus/disabled 状態は実装時に同ファイルへ揃えて定義する。
focus は既存 `--banto-focus-ring` を使用。）

## 4. 密度軸（standard / compact）

### 4.1 CSS（`banto.css`）

```css
[data-banto-density='compact'] {
	--banto-control-height: 32px;
	--banto-control-height-lg: 36px;
	--banto-grid-row-height: 32px;
	--banto-grid-header-height: 36px;
}
```

グリッドは行高トークンを既に参照しているため、仮想化ロジックの変更は不要。

### 4.2 ランタイム（`packages/theme/src/index.ts`）

`ThemePreset` と完全に同型のミニマル API を追加する。

```ts
export type ThemeDensity = 'standard' | 'compact';
export function applyDensity(density: ThemeDensity): void {
	document.documentElement.dataset.bantoDensity = density;
}
export function isThemeDensity(value: unknown): value is ThemeDensity;
```

### 4.3 永続化（`settings.svelte.ts` / `app.html`）

既存のテーマ/プリセットと同じ 2 層方式に載せる:

- localStorage キー: `banto.density`（FOUC キャッシュ）
- `UiSettingsProvider` キー: `theme.density`
- `Settings` クラスに `themeDensity` state + `setThemeDensity()` +
  `#applyThemeDensity()` を preset と同型で追加し、`init()` と
  `syncFromProvider()` に組み込む。
- `app.html` の first-paint スクリプトに 1 行追加:
  `document.documentElement.dataset.bantoDensity = localStorage.getItem('banto.density') === 'compact' ? 'compact' : 'standard';`

設定画面には「表示密度」として standard/compact の選択 UI を追加する（§10）。

## 5. アイコン（`@lucide/svelte`）

### 5.1 ナビゲーション定義の変更（`navigation.ts`）

絵文字文字列を**意味のあるキー**へ置き換える。アイコンコンポーネントへの
解決は表示層のみが行い、`navigation.ts` は UI 非依存を保つ。

```ts
export type NavIconKey = 'dashboard' | 'items' | 'users' | 'audit-log' | 'settings';
export interface NavItem {
	path: string;
	label: string;
	icon: NavIconKey;
	adminOnly?: boolean;
}
```

### 5.2 アイコン解決マップ（`src/lib/components/navIcons.ts`）

```ts
import { LayoutDashboard, Package, Users, ScrollText, Settings } from '@lucide/svelte';
export const NAV_ICONS: Record<NavIconKey, Component> = {
	dashboard: LayoutDashboard,
	items: Package,
	users: Users,
	'audit-log': ScrollText,
	settings: Settings
};
```

シェル以外（ダッシュボード KPI、設定カード、状態表示等）も同様に
named import で使用する。**`import * as` 形式は禁止**（ツリーシェイク
検証 §12.3 の前提）。サイズは 16px（インライン）/ 20px（ナビ・ボタン）に
統一し、`stroke-width` は既定値 2 を維持する。

## 6. 共通 UI コンポーネント（`src/lib/components/ui/`)

すべて Svelte 5 runes（`$props()` + snippet）。アプリ固有ストアへの依存は
持たせない（昇格可能性のため。データは props で受ける）。

### 6.1 PageHeader

```svelte
<PageHeader title="商品" description="在庫と価格を管理します">
	{#snippet actions()} ... {/snippet}
</PageHeader>
```

- DOM: `<header class="page-header"><div><h1/><p/></div><div class="actions"/></header>`
- 狭幅ではタイトル行と操作行を縦積みに折り返す（`flex-wrap`）。
  操作の並び順は DOM 順を維持し、Primary が先頭。
- `view-transition-name: page-header` を持つ（§11.1）。操作欄の stacking context は
  シェルヘッダーより1段下とし、列表示 popup が sticky grid header の背面へ隠れないようにする。
- `hideTitle`（既定 `false`）で内容側のタイトルを読み上げ用の `<h1>` にできる。
  シェルがタイトルを表示するテンプレートの画面では `true` を使い、説明・操作のみ表示する。
  説明も操作もなければ可視の header 行を省き、タイトル分の余白も作らない。
  説明の上余白は非表示時に除く。既定の部品表示・ログイン・帳票本文・部品見本は維持する。

### 6.2 StatusBadge

- props: `variant: 'neutral' | 'success' | 'warning' | 'danger' | 'info'`、
  `label: string`、`icon?: Component`
- 色は淡色ペアトークン（`--banto-*-tint` / `--banto-*-tint-text`）のみ使用。
- 色だけに依存しない: variant 既定アイコン（success=Check 等）を必ず表示
  （計画 Phase 5「ロールは色だけに依存しないバッジ」に対応）。

### 6.3 IconButton

- props: `label: string`（必須 → `aria-label`）、`icon: Component`、
  `size?: 'sm' | 'md'`、`onclick`
- `label` を省略できない型にすることでアクセシブルネームを強制する。

### 6.4 SurfaceCard

- props: `title?`、`description?`、children snippet、`footer?` snippet
- `--banto-surface` + `--banto-border`（弱）+ `--banto-radius-lg` +
  `--banto-shadow-sm`。Glass ではプリセット CSS が面変数を上書きするため
  コンポーネント側の分岐は不要。

### 6.5 状態表示（EmptyState / ErrorState / LoadingState)

- 共通 DOM: アイコン、見出し、補足、任意の操作ボタン（snippet）。
- 所有権境界（計画 Phase 1）: これらは**ページレベル**の状態専用。
  グリッド内部の空状態・セルエラーは `grid-svelte` が自前で持ち、
  同じトークンだけを参照する。
- LoadingState はスケルトン（`--banto-surface-subtle` のパルス）を既定とし、
  `prefers-reduced-motion` ではパルスを止めて静的表示にする。

## 7. メニューコンポーネント（`src/lib/components/menu/`)

計画 Phase 1 の追記事項に対応する、本設計書の中心項目。

> 2026-10-07 追記: この 5 ファイルは `@banto/ui`（`packages/ui/src/`）へ移った（#220 段階 2a、
> [ADR-0018](../adr/0018-shared-ui-package.md)）。以下の設計と DOM・CSS は変わらない。

### 7.1 構成ファイル

| ファイル | 役割 |
|---|---|
| `Menu.svelte` | トリガー + ポップオーバー + キーボード制御の土台 |
| `MenuItem.svelte` | 項目（`danger` variant あり） |
| `MenuSeparator.svelte` | 区切り線 |
| `MenuGroup.svelte` | グループ見出し（`role="group"` + `aria-label`） |
| `menuContext.ts` | Menu→Item 間の Svelte context（close 関数と項目登録） |

**アプリ固有 import（sessionStore 等）は禁止**（レビュー条件、計画 Phase 1）。
利用側がデータを閉じ込める。

### 7.2 API

```svelte
<Menu label="ユーザーメニュー">
	{#snippet trigger(props)}
		<button {...props} class="user-chip">{identity.displayName}</button>
	{/snippet}
	<MenuGroup label={identity.username}>
		<MenuItem icon={Settings} label="設定" onSelect={() => goto('/settings')} />
	</MenuGroup>
	<MenuSeparator />
	<MenuItem icon={LogOut} label="ログアウト" danger onSelect={logout} />
</Menu>
```

- `Menu` props: `label: string`（ポップオーバーの `aria-label`）、
  `placement?: 'bottom-start' | 'bottom-end'`（既定 `bottom-end`）、
  `trigger` snippet、children snippet
- `trigger` snippet はスプレッド用 props を受け取る:
  `{ 'aria-haspopup': 'menu', 'aria-expanded', onclick, onkeydown }`。
  トリガーの見た目は利用側が完全に決める。
- `MenuItem` props: `label: string`、`icon?: Component`、`danger?: boolean`、
  `disabled?: boolean`、`onSelect: () => void`。選択時は必ずメニューを閉じる。

### 7.3 表示: Popover API

- ポップオーバー要素は `popover="auto"`（light dismiss: 外側クリック・
  `Escape` はブラウザが処理）+ `role="menu"`。
- 開閉は `showPopover()`/`hidePopover()`。状態同期は `toggle` イベントで行い、
  light dismiss で閉じた場合も `aria-expanded` とフォーカス返却が漏れない
  ようにする。
- top-layer 表示のため `z-index` 管理は不要。既存の CommandPalette /
  モーダルとの重なり順の個別調整は行わない。

### 7.4 位置決め

CSS Anchor Positioning は LAN 側ブラウザの対応差があるため使わない（v2 検討）。

- 開いた時点で `trigger.getBoundingClientRect()` から `position: fixed` の
  座標を計算。既定は trigger 直下・右端揃え（`bottom-end`）。
- 下に入らない場合は上へフリップ。左右はビューポートへクランプ。
- `resize` で再計算。`scroll`（capture）では**閉じる**（追従はしない —
  メニューは短命であり、追従実装のコストに見合わない）。

### 7.5 キーボードとフォーカス

| キー | 挙動 |
|---|---|
| `Enter` / `Space` / `ArrowDown`（トリガー上） | 開いて最初の項目へフォーカス |
| `ArrowUp`（トリガー上） | 開いて最後の項目へフォーカス |
| `ArrowDown` / `ArrowUp`（項目上） | 次/前の項目へ（端でラップ） |
| `Home` / `End` | 最初/最後の項目へ |
| `Enter` / `Space`（項目上） | `onSelect` 実行 → 閉じる → トリガーへフォーカス |
| `Escape` | 閉じる（native）→ `toggle` ハンドラでトリガーへフォーカス |
| `Tab` | 閉じて通常のタブ順へ抜ける |

- 項目は `role="menuitem"` + `tabindex="-1"` のロービングフォーカス。
- `disabled` 項目は `aria-disabled="true"` でフォーカス走査からスキップ。
- typeahead（先頭文字ジャンプ）は v1 では実装しない。

### 7.6 スタイル

- 面: `--banto-surface-overlay` + `--banto-shadow-lg` +
  `--banto-radius-md`、項目ホバー/フォーカス: `--banto-surface-hover`。
- `danger` 項目: 文字色 `--banto-danger`（text 系）、フォーカス時の地は
  `--banto-danger-tint`。
- 開閉モーション: `--banto-duration-fast` のフェード + 4px スライド。
  reduced-motion では §2.3 により自動で 0ms。

### 7.7 利用箇所

1. ヘッダーのユーザーメニュー（Phase 2、§9.2）
2. ツールバーのオーバーフローメニュー「…」（Phase 4、狭幅時）
3. （将来・v2）grid-svelte の行コンテキストメニュー、dock のタブメニュー —
   その時点で `packages/` への昇格を判断する。

## 8. アプリシェル（`(app)/+layout.svelte` / Sidebar / Header)

### 8.1 レイアウトとブレークポイント

- 900px 超: 現行どおり `flex` の 2 カラム（サイドバー + メイン）。
- **900px 以下**: サイドバーを `position: fixed` のオーバーレイに切り替え、
  既定は閉。ハンバーガーで開閉し、背後に `--banto-shadow-lg` +
  半透明バックドロップ。`Escape` とバックドロップクリックで閉じる。
- `settings.sidebarCollapsed`（折りたたみ）とオーバーレイ開閉は別状態とする
  （オーバーレイ状態は一時的でありセッションをまたいで保存しない）。
- 切替後に**保存済みドックレイアウトの復元**を確認する（計画 Phase 2 の
  前倒し確認項目）。

### 8.2 Header

DOM 順: ハンバーガー(≤900px のみ) → ページ名表示 → スペーサー →
検索ピル → 配色モードの切替ボタン → ユーザーメニュー。900px 超の折りたたみボタンはヘッダーに置かず、
サイドバー最上段のロゴの左に置く（§8.3）ので、900px 超ではヘッダーはページ名から始まる。

ページ名表示は**見出し要素にしない**（`<p>` 等）。文書の `h1` は各ページの
`PageHeader`（§6.1）が持つ。シェル側も `h1` にすると 1 ページに h1 が
2 つ並ぶため（実装時に E2E の strict mode 違反として検出済み）。

- 検索ピル: `IconButton` ではなくボタン内に `Search` アイコン +
  「検索…」 + `kbd` で `Ctrl K` を常時表示。`commandPaletteStore.show()` を
  呼ぶだけで、パレット自体の実装（M16）には触れない。768px 以下では
  アイコンのみに縮小。
- 配色モードの切替ボタン: `IconButton`（全画面ボタンと同じ見た目・寸法）に lucide の
  `Sun` / `Moon`。**いま表示している配色の反対**を示し（ライト表示なら月、ダーク表示なら太陽）、
  押すと反対の配色に**固定**する（以後は OS に連動しない。初期状態は「システムに従う」）。
  サイドバー / ドック・900px 以下のどれでも出す。ラベルは `shell.switchToDarkMode` /
  `shell.switchToLightMode`。設定画面の外観カードに配色モードの選択肢は無い（プリセットと
  表示密度だけ）。保存値（`theme.mode` = light / dark / system）の形は変えない。
- ユーザーメニュー: §7 の `Menu` を使用。トリガーは
  `identity.displayName`（なければ username）+ ロールを示す
  `StatusBadge`。項目は「設定」「ログアウト（danger）」。
  `sessionStore.authDisabled` の場合はメニュー自体を出さない（現行の
  ログアウトボタン非表示条件を踏襲）。追加 API は呼ばない。

### 8.3 Sidebar

- 構造を 3 区画に分ける: ブランド / 主要ナビ（ダッシュボード・商品）/
  管理ナビ（`adminOnly` 項目、「管理」見出し付き）。最上段は
  `[折りたたみボタン][ロゴマーク] Banto` の並び（900px 超のみ。ボタンはロゴの左で、ロゴは押しても
  何も起きない）。折りたたんだ状態は最上段をボタンだけにし（ロゴは隠す）、ボタンは展開時と同じ位置に
  残るので同じ場所をもう一度押せば戻る。900px 以下はヘッダーのハンバーガーがドロワーを開閉し、
  サイドバー側のボタンは描画しない（操作の部品は常に 1 つ。どちらを出すかは CSS ではなく
  `narrowViewport` で決める）。ドックのレイアウトでは出さない。区画間は `--banto-border`（弱）で区切る。
- ブランド: 絵文字 `🏮` を廃し、小さな SVG 提灯マーク（インライン、
  暖色グラデーション `--banto-accent-gradient` 使用箇所はここに限定）+
  ワードマーク。
- アクティブ項目: 背景 tint（現行踏襲）+ 左端 2px のアクセントライン +
  アイコン色 `--banto-primary` + `aria-current="page"`。
- 折りたたみ: アイコンの X 座標を固定（`padding` ではなく grid で
  アイコン列を固定幅化）し、ラベルは `opacity` + `width` を
  `--banto-duration-base` で同期トランジション。折りたたみ時は
  `title` ツールチップ（現行踏襲）。

## 9. ログイン画面

- 960px 超: `grid-template-columns: 5fr 4fr` の 2 ペイン。
  左=ブランド、右=フォーム。960px 以下は 1 カラムカード（現行の外枠）。
- ブランドペインは **3 スロット固定**: ロゴマーク（SVG）、アプリ名、
  キャッチコピー 1 行。README のリネーム手順から差し替え箇所が
  この 3 つで済む構造を守る（計画 Phase 5）。
- 背景（画像アセットなし）:

```css
.brand-pane {
	background:
		radial-gradient(60% 80% at 20% 20%, color-mix(in srgb, var(--banto-primary) 28%, transparent), transparent),
		radial-gradient(50% 60% at 80% 90%, rgb(237 106 52 / 0.18), transparent), /* 提灯の暖色はここのみ */
		conic-gradient(from 210deg at 60% 40%, #171c26, #10131a);
}
.brand-pane::after { /* SVG feTurbulence ノイズ(data URI)を透過重ね */ }
```

- デモ認証情報（ブラウザデモモードの admin/admin）はフォーム説明文から
  `SurfaceCard` の補足パネルへ移す。初回セットアップも同じ外枠を使う。
  認証処理・初回セットアップ判定は変更しない。

## 10. 設定・ユーザー管理・ダッシュボード（構造のみ）

- 設定: セクションを `SurfaceCard` のグリッド
  （`repeat(auto-fill, minmax(360px, 1fr))`）へ。外観カードは
  プリセット（Standard / Glass）の選択と、密度トグル（§4.3）の「表示密度」。
  配色モード（ライト / ダーク / システム）の選択カードは置かない（ヘッダーの
  太陽 / 月のボタンに移した。§8.2。#458）。認証無効化・リストア系は `ErrorState` 系
  トークンで囲った Danger zone カードへ分離。
- ユーザー管理: ≥1100px で一覧+編集の 2 カラム、未満で縦積み。
  ロールは `StatusBadge`（admin=info、editor=neutral、viewer=neutral +
  各既定アイコン）。削除/パスワードリセットは編集フォーム下部の
  Danger zone に分離。
- ダッシュボード: 先頭の技術説明は `<details>` ベースの
  「このデモについて」へ移動。KPI カードは `SurfaceCard` +
  display 数値（`tabular-nums`）+ Lucide アイコン。チャートグリッドは
  12 カラムで主要 8 / 補助 4 の非対称。ドック領域は「分析ワークスペース」
  見出し + `--banto-surface-subtle` の地で通常カードと分離。
  パネル ID・保存形式・集計は不変。

## 11. モーション

### 11.1 View Transitions（`(app)/+layout.svelte`）

```ts
import { onNavigate } from '$app/navigation';
onNavigate((navigation) => {
	if (!document.startViewTransition) return; // 非対応: 即時切替
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	return new Promise((resolve) => {
		document.startViewTransition(async () => {
			resolve();
			await navigation.complete;
		});
	});
});
```

- `::view-transition-old(root)` / `new(root)` は
  `--banto-duration-slow` のクロスフェード。
- `PageHeader` に `view-transition-name: page-header` を与え、ページ間で
  見出しが連続して見えるようにする。名前はこの 1 つに留める
  （多用すると保守コストが上がる）。
- シェル（サイドバー・ヘッダー）は `(app)` レイアウトに属するため
  遷移対象にならない（SvelteKit のレイアウト維持により再描画されない）。

### 11.2 個別モーション

| 対象 | 効果 | トークン |
|---|---|---|
| サイドバー開閉 | width + ラベル opacity | base / ease-spring |
| メニュー・ポップオーバー | fade + 4px slide | fast / ease-out |
| モーダル・パレット | fade + scale(0.98→1) | slow / ease-spring |
| トースト | 右から slide-in | base / ease-spring |
| KPI 数値 | `@property` 補間カウントアップ | slow |

すべて duration トークン経由（§2.3 の reduced-motion 一括無効の前提）。

## 12. 検証基盤

### 12.1 ビジュアルリグレッション（`e2e/visual/`）

- `e2e/playwright.config.ts` に project `visual` を追加。既存スモーク
  （serial・実サーバ・新規 DB）とは独立し、**ブラウザデモモード**
  （`pnpm build` + `vite preview`、InMemory データ）を対象にする。
  認証はデモモードの固定 admin/admin を使い、実サーバのシード差異を排除する。
- 決定性のため `sampleData.ts` の生成を **mulberry32 等のシード付き PRNG**
  に変更する（表示専用データ生成の決定化。件数 1 万・スキーマ・分布は不変。
  機能変更には当たらないが、単位 0 の PR で単独レビューする）。
- 撮影マトリクス（計画 Phase 0 の間引きルール）:
  - ログイン・ダッシュボード: 4 テーマ組 × 3 ビューポート
  - 商品一覧・ユーザー管理・設定・コマンドパレット: Light/Standard と
    Dark/Glass の対角 2 組 × 1440×900
- `use: { reducedMotion: 'reduce' }` + `toHaveScreenshot({ animations: 'disabled' })`
  で時間依存を排除。`maxDiffPixelRatio: 0.001`。
- テーマ切替は localStorage（`banto.theme` / `banto.preset` /
  `banto.density`）を `addInitScript` で注入(app.html の FOUC スクリプトが
  first paint 前に反映する)。
- ベースラインはコミットする。意図した見た目変更の PR は
  `--update-snapshots` の差分を同 PR に含める。

### 12.2 アクセシビリティ自動検査

- `@axe-core/playwright` を `visual` project 内で各画面 1 回実行
  （Light/Standard と Dark/Glass）。
- `wcag2a`, `wcag2aa` タグで violation 0 を assert。コントラストは
  計画書付録 A の計算値が根拠、axe は回帰検知として使う。

### 12.3 バンドル検査

- `pnpm build` 後、クライアントチャンクに対して未使用 Lucide アイコンが
  混入していないことを確認する（`build/` 内のチャンクを対象に、使用予定
  アイコン数と `lucide` 由来モジュール数の乖離をチェックする小スクリプトを
  `e2e/` 併設。しきい値超過で CI 失敗）。

## 13. 完了条件との対応

| 計画 §8 | 本書の該当設計 |
|---|---|
| 1 絵文字廃止 | §5、§8.3 |
| 2 トークン統一 | §2、§3.1、§6 |
| 3 コントラスト数値基準 | §2.1（付録 A 値）、§12.2 |
| 4 768px 幅 | §8.1、§8.2、PageHeader 折り返し |
| 5 回帰なし | §12.1、§8.1（ドック復元）、各 Phase のスタイル限定変更 |
| 6 reduced-motion / transparency | §2.3、§11.1、既存 glass フォールバック維持 |
| 7 自動確認 | §12 全体 |
| 8 追加バックエンド/アセットなし | §5（npm 同梱）、§9（CSS 生成背景） |
