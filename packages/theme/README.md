# @banto/theme

Banto のテーマ基盤。`--banto-*` の CSS 変数トークン一式（`./css` エクスポート
= `src/css/banto.css`）と、`ThemeMode`（light/dark/system）を
`<html data-theme="...">` へ解決・反映するランタイム、Glass/Compact の
プリセット・密度切り替えを提供する（spec §8.2）。UI 側は生値を書かず
`var(--banto-*)` トークンのみを参照する（docs/conventions.md §9）。

## 使用例

```ts
import { applyTheme, watchSystemTheme, applyPreset, applyDensity } from '@banto/theme';

applyTheme('system'); // <html data-theme="light|dark"> を反映
applyPreset('standard'); // <html data-banto-preset="...">
applyDensity('standard'); // <html data-banto-density="...">

const stop = watchSystemTheme((resolved) => {
	console.log('OS テーマが変化:', resolved);
});
// 不要になったら stop() で購読解除
```

```css
/* app.css 等で読み込む */
@import '@banto/theme/css';
```

TS / Svelte の `<script>` から副作用の import（`import '@banto/theme/css';`）で読み込んでもよい。
`./css` の export には空のモジュールの型（`src/css/banto.css.d.ts`、`export {};` だけ）を
`types` 条件で付けてあるので、TypeScript 6 の副作用 import の検査
（`noUncheckedSideEffectImports`）に対して、利用する側が `declare module` を足す必要はない
（v4.0.0 から。#325）。値は何も export しない（実行時の挙動は CSS の読み込みだけ）。
型の解決は exports の条件を読む `moduleResolution: "bundler"`（SvelteKit 3 の
`$app/tsconfig` の既定）を前提にしている。

## 入力とページナビの共通スタイル（次リリース）

`@banto/theme/css` だけで使える opt-in の HTML クラス（[ADR-0023](../../docs/adr/0023-shared-control-styles.md)）。
app.css・Tailwind・Svelte の wrapper は不要。下線型を選ばない欄の枠や配置は変わらない。
設定とログイン・初回セットアップ画面がこのクラスを利用する。

背景は通常・hover・readonly・disabled とも既定で透明（ADR-0025）。枠・下線・フォーカスと
文字色・減光・破線で状態を示し、カードやページの背景をそのまま見せる。
ブラウザが autofill / forced-colors 等で付ける背景は強制的に消さない。select の popup はネイティブのまま。

```html
<label class="banto-field">
	<input type="text" class="banto-field-control" placeholder=" " aria-describedby="host-help" />
	<span class="banto-field-label">接続先</span>
</label>
<p id="host-help">ホスト名または IP アドレスを入力してください。</p>

<label class="banto-field">
	<select class="banto-field-control">
		<option value="">選択してください</option>
		<option value="local">この端末のみ</option>
	</select>
	<span class="banto-field-label">接続範囲</span>
</label>

<label class="banto-field banto-field--stacked">
	<input type="text" class="banto-field-control" value="既存値" />
	<span class="banto-field-label">長い説明を含み、複数行に折り返して表示したい項目名</span>
</label>

<nav class="banto-section-nav" aria-label="設定カテゴリ">
	<a href="/settings/appearance" aria-current="page">外観・言語</a>
	<a href="/settings/account">アカウント</a>
</nav>
```

- `.banto-field` は実際の `label` に付け、ネイティブ control → ラベル文字列の順で、
  直下に `.banto-field-control` と `.banto-field-label` を置く。対象は text / password / number と
  単一選択 select。date / textarea は `.banto-field--stacked` を必須とし、日付のネイティブ表示と
  textarea の行数・縦リサイズを保つ。checkbox・range・複数選択は対象外。
- テキスト系で空欄のラベルを中央へ置くときは `placeholder=" "` を指定する。
  フォーカス中や値があると上がり、自動入力・プログラムからの値設定にも CSS で追従する。
  select のラベルは空 option の説明文とも重ならないよう、常に上に置く。
- 浮動表示は短い項目名向け。長い翻訳・狭い欄・文字拡大で複数行になる場合は
  `.banto-field--stacked` を付ける。ラベルを通常フローで入力の上に置き、全文の高さを確保する。
  項目の幅や配置、どちらの表示を使うかは consumer が決める。
- readonly / disabled はネイティブ属性を渡す。readonly のテキスト欄はフォーカス・選択ができ、
  disabled は減光と破線で示す。select に readonly はない。CSS はイベント、値、検証、送信や認可を制御しない。
- 説明・単位・エラーはラベル領域の外に描画し、必要な `aria-describedby` / `aria-invalid` と
  一意な ID を consumer が設定する。`aria-invalid="true"` は下線の色も変えるが、エラー文を併記する。
- `.banto-section-nav` は実際の `nav`、直下は `a[href]`。現在地は `aria-current="page"` で指定する。
  href・経路判定・文言・権限は consumer が管理する。これはページへのリンクで、ARIA tabs の
  キー操作・パネル切替は提供しない。既存の tablist や SCADA の画面切替へ自動適用しない。

通常のテーマと密度、reduced-motion、forced-colors に追従する。
スキーマフォームでは `BantoForm` の `appearance="underline"` で固定上表示を選べる
（[forms README](../forms/README.md)、ADR-0024）。省略時は従来の枠型の構造を保つ。

## スイッチとチェックボックス（次リリース、ADR-0026）

```html
<label class="banto-switch-field">
	<input type="checkbox" role="switch" class="banto-switch" name="enabled" />
	自動同期を有効にする
</label>
```

スイッチも theme CSS だけで使える。値・変更イベント・保存は consumer が扱い、
checked / disabled とラベル・Space 操作・フォーム送信はネイティブの契約を使う。
行の最小高さは `--banto-control-height-lg`。通常の checkbox にはこの class を付けない。
forced-colors のカスタム描画は system colors を使い、フォーカス枠と丸の位置で状態を識別できる。

寸法は `--banto-switch-width: 36px` / `--banto-switch-height: 20px` / `--banto-switch-inset: 2px`。
forms と列表示メニューのネイティブ checkbox は `--banto-checkbox-size: 1.1rem` を共有する。
両 package は旧 theme 向けの寸法 fallback と自分の CSS を持ち、theme 内の class に依存しない。

## オーバーレイのトークン（v6.1.0 から）

モーダル的な重ね表示が使う背景と重なり順のトークン（ADR-0018 §8）。値は light・dark・glass
で共通で、プリセットごとの上書きは無い。z-index は今までアプリが直書きしていた値と同じで、
重なり順は変わらない。

| トークン                  | 値                  | 用途                                                     |
| ------------------------- | ------------------- | -------------------------------------------------------- |
| `--banto-scrim`           | `rgb(0 0 0 / 0.35)` | オーバーレイ（CommandPalette など）の背後を暗くする背景  |
| `--banto-z-header`        | `100`               | 固定ヘッダ（ページ内の浮動要素より上、サイドバーより下） |
| `--banto-z-sidebar-scrim` | `850`               | 狭幅でサイドバーを開いたときの背後の覆い                 |
| `--banto-z-sidebar`       | `900`               | 狭幅のサイドバー（ドロワー）                             |
| `--banto-z-modal`         | `900`               | Modal / Drawer 用（ADR-0018 段階 3 で使う予約値）        |
| `--banto-z-overlay`       | `1000`              | 全画面のオーバーレイ（CommandPalette）                   |
| `--banto-z-toast`         | `1000`              | トースト                                                 |

```css
.my-overlay {
	position: fixed;
	inset: 0;
	z-index: var(--banto-z-overlay);
	background: var(--banto-scrim); /* 生の rgba() は rule `raw-colors` に掛かる */
}
```

## ランチャーのトークン（v6.8.0 から）

`@banto/ui` の `LauncherBar`（ドック風のランチャー、[nav-launcher-plan.md](../../docs/design/nav-launcher-plan.md) §5.2）が
使う寸法と重なり順。シェルの名前空間に置く（`--banto-dock-*` は `@banto/dock-svelte` のもの）。

| トークン                                    | 値                        | 用途                                                                                                         |
| ------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--banto-shell-launcher-item-size`          | `44px`                    | 項目の基準寸法（狭い画面のタブバーでは最小の当たり判定）                                                     |
| `--banto-shell-launcher-magnify-max`        | `1.5`                     | 拡大の最大倍率（単位なし。部品が JS で読む。`1` で拡大しない）                                               |
| `--banto-shell-launcher-gap`                | `6px`                     | 項目の間隔                                                                                                   |
| `--banto-shell-launcher-padding`            | `6px`                     | バーの内側の余白                                                                                             |
| `--banto-shell-launcher-offset`             | `10px`                    | 画面端からの距離                                                                                             |
| `--banto-shell-launcher-reserve`            | `calc(...)`               | 本文の下に取る余白（item-size + padding × 2 + offset）                                                       |
| `--banto-shell-launcher-tabbar-reserve`     | `calc(...)`               | 900px 以下のタブバーで本文の下に取る余白（item-size + 0.5rem + safe-area）                                   |
| `--banto-z-launcher`                        | `200`                     | ランチャーのバー（ヘッダより上、狭幅サイドバーの覆い・Modal・トーストより下）                                |
| `--banto-shell-launcher-opacity`            | `50%`                     | バーの不透明度（アプリの設定で変えるのはこの値だけ）                                                         |
| `--banto-shell-launcher-tabbar-opacity-min` | `85%`                     | 900px 以下のタブバーの不透明度の下限（設定がこれより低くても、この濃さで描く）                               |
| `--banto-shell-launcher-bg`                 | `surface-overlay` の 50%  | バーの半透明の地                                                                                             |
| `--banto-shell-launcher-backdrop`           | `blur(1px) saturate(1.5)` | バーの後ろのぼかし                                                                                           |
| `--banto-shell-launcher-tooltip-bg`         | `surface-raised` の 80%   | ツールチップの半透明の地                                                                                     |
| `--banto-shell-launcher-tooltip-backdrop`   | `blur(5px)`               | ツールチップの後ろのぼかし                                                                                   |
| `--banto-shell-launcher-tooltip-max-width`  | `10rem`                   | 左右のバーのツールチップの最大幅（これを超えると折り返す。バーはこの幅ぶん本文側を空けて切れないようにする） |
| `--banto-shell-launcher-inset-top`          | `0px`                     | 上のバーの上に空ける量（上にヘッダーがあるシェルはヘッダーの高さを入れ、バーをヘッダーの下に置く）           |

半透明の 4 つは、`prefers-reduced-transparency: reduce` のときと `backdrop-filter` が使えないブラウザでは不透明（ぼかし無し）に戻る。
ルート要素に `data-banto-shell-nav="launcher"` が付いているあいだは、`--banto-toast-bottom` をバー（900px 以下はタブバー）の上に上げる（アプリのシェルがドック表示のときに付ける）。あわせて `data-banto-shell-launcher-position` が `top` / `left` / `right` のときは下を空けたままにし、`right` ではトーストを `--banto-toast-right` でバーの左へ逃がす（900px 以下はどの位置でもタブバーの上）。

## 寸法のトークン（次の版から）

余白・文字サイズ・枠線幅の段階（[theme-dimension-tokens.md](../../docs/design/theme-dimension-tokens.md) §5.2）。
追加のみで、既存の値と画面は変わらない。生の `rem` / `px` から**任意で**置き換えられる。値はすべて `rem`
（枠線幅は `px`）なので、root の `--banto-font-size`（既定 14px）に追従する。密度（compact）では切り替えない。
部品の形（幅・高さ・列幅・アイコンの大きさ）は段階に入れない。

| トークン                      | 値         | 用途                                    |
| ----------------------------- | ---------- | --------------------------------------- |
| `--banto-space-1`             | `0.25rem`  | 余白（序数。値は名前に含めない）        |
| `--banto-space-2`             | `0.5rem`   | 余白                                    |
| `--banto-space-3`             | `0.75rem`  | 余白                                    |
| `--banto-space-4`             | `1rem`     | 余白                                    |
| `--banto-space-5`             | `1.25rem`  | 余白                                    |
| `--banto-space-6`             | `1.5rem`   | 余白                                    |
| `--banto-space-7`             | `2rem`     | 余白                                    |
| `--banto-space-8`             | `3rem`     | 余白（空状態など）                      |
| `--banto-font-size-xs`        | `0.7rem`   | バッジ・極小ラベル                      |
| `--banto-font-size-sm`        | `0.8rem`   | caption                                 |
| `--banto-font-size-md`        | `0.875rem` | 補足・表の副情報（本文より一段小さい）  |
| `--banto-font-size-base`      | `1rem`     | 本文（root と同じ。明示が要るときだけ） |
| `--banto-font-size-lg`        | `1.125rem` | 見出し                                  |
| `--banto-font-size-xl`        | `1.75rem`  | display（KPI の数値など）               |
| `--banto-border-width`        | `1px`      | 枠線の幅                                |
| `--banto-border-width-strong` | `2px`      | 選択・強調の縁                          |

本文（body）は root の `1rem` を継承するので、ふつうは何も書かない。小さい親の中で本文の大きさに戻すとき
（カードの見出しなど）だけ `--banto-font-size-base`（`1rem`）を使う。段の並びは `xs` < `sm` < `md` < `base` < `lg` < `xl`
（`md` は本文より一段小さい）。root の大きさの `--banto-font-size`（px）とは別物。

```css
.my-card {
	padding: var(--banto-space-4);
	border: var(--banto-border-width) solid var(--banto-border);
	font-size: var(--banto-font-size-md);
}
```

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（コアパッケージのためオプション側への依存も持たない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/ui-framework-spec.md §8.2](../../docs/ui-framework-spec.md)（含まれる雛形 — テーマ切替）
