# ADR-0023: 設定で採用した入力とページナビのスタイルをテーマで共有する

> English: [0023-shared-control-styles.en.md](0023-shared-control-styles.en.md)

- 状態: Accepted
- 日付: 2026-11-04
- 関連: [Issue #495](https://github.com/tyaro/banto/issues/495) /
  [ADR-0022](0022-settings-controls.md) / [conventions.md](../conventions.md) §4・§5・§9

## コンテキスト

設定画面のデザインを正式採用し、共通フォームのエラー関連付けと readonly の改善も完了した。
オーナーから残項目の継続指示を受け、次は設定で使っている見た目を他の画面でも選べる形にする。
現在は入力の基礎スタイルが app.css、浮動ラベルが settings.css、ページナビが設定 layout に分散している。
SCADA は theme / ui を利用しているが forms は直接利用しておらず、編集・確定や画面切替の操作も異なる。

## 決定

- `@banto/theme/css` に opt-in のクラスを追加し、設定画面をその利用箇所に移行する。
  基礎スタイルも含め、app.css・Tailwind・Svelte の wrapper なしで利用できるようにする。
  ADR-0022 の見た目と適用範囲を保ち、その CSS の配置だけを共有側へ移す。
- 入力は `label.banto-field` 内に、ネイティブの `.banto-field-control`、
  `.banto-field-label` の順で置く。対象は text / password / number と単一選択 select。
  text 系では空欄のラベルが中央にあり、フォーカス・値があると上がる。select は常に上へ置き、
  空 option の説明文とも重ねない。ネイティブの矢印とポップアップは維持する。
- 長いラベルや狭い欄には `.banto-field--stacked` を使う。ラベルを通常フローに戻して全文を折り返し、
  control の上に高さを確保する。absolute の位置だけを固定して多行の高さを失う方式にはしない。
- ページナビは `nav.banto-section-nav > a[href]` とし、選択状態は `aria-current="page"` を使う。
  折返し・フォーカス枠・forced-colors の選択表示を保つ。ARIA tabs の動作は提供しない。
- 値、イベント、readonly / disabled、説明・エラーの描画と ARIA、文言、権限、href と経路判定は
  consumer が所有する。説明・単位・エラーは浮動ラベルの領域の外に置く。
  CSS は値の更新や送信を制御せず、readonly は認可の代わりにはならない。

## 検討した代替案

- **`@banto/ui` に Svelte wrapper を追加する:** 今回の共有対象はネイティブ HTML とスタイルだけ。
  wrapper に値やイベントを再公開する契約を増やすより、既存 theme のクラスで利用可能にする。
- **`@banto/forms` の既定表示を変更する:** スキーマフォームは別のラベル構造と独自スタイルを持つ。
  密度・長い項目名・外部利用への影響をまとめて広げず、今回の既定表示は維持する。
- **SCADA のスタイルを同時に置換する:** 独自の密度・IME・確定・画面切替を持つため、
  共有クラスを提供する段階と実画面へ採用する段階を分ける。

## 帰結

- 新規依存、パッケージ間 import、export の追加は不要。既存のテーマ読み込みだけでクラスを使える。
  専用クラスを付けない既存 UI は変わらない。表・チェックボックス・スイッチも今回の対象外。
- 設定のフォーム幅・カード配置・保存処理・権限・未保存ガードはアプリに残る。
- theme README に HTML と責務を記載し、app.css のない外部 consumer と設定画面の両方で検証する。
  実機の読み上げ・タッチや SCADA の採用確認は、ブラウザ自動検査とは別に扱う。
