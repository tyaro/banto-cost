# ADR-0025: 入力欄と選択入力の背景は既定で透明にする

> English: [0025-transparent-control-backgrounds.en.md](0025-transparent-control-backgrounds.en.md)

- 状態: Accepted
- 日付: 2026-11-04
- 関連: [Issue #495](https://github.com/tyaro/banto/issues/495) /
  [ADR-0022](0022-settings-controls.md) / [ADR-0023](0023-shared-control-styles.md) /
  [ADR-0024](0024-schema-form-appearance.md)

## 決定

オーナーの指示により、入力・ネイティブ select の既定背景を透明にする。
ADR-0022 の薄い背景と、ADR-0024 の既定表示維持のうち背景色に関する部分を更新する。
過去の ADR 本文は履歴として残す。

- 共通 `.banto-field-control`、各 forms field（checkbox を除く）、アプリの `.banto-input` が対象。
  通常時・hover・readonly・disabled で塗りを加えず、背面のカードやページをそのまま見せる。
- 枠・下線・フォーカス、readonly の文字色、disabled の減光と破線、エラー表示は維持する。
  値・属性・操作・認可・検証・送信は変更しない。
- select の矢印・ポップアップ・option、grid editor・filter popover・overlay の背景は変更しない。
  autofill / forced-colors 等でブラウザが付ける背景を強制的に消す指定は加えない。

## 理由と帰結

薄い塗りで入力を囲う方式から、枠や下線で区切りを示す方式へ揃える。
readonly / disabled のみ塗る案も採用せず、背景以外の既存の状態表現を使う。
`appearance="default"` と field の直接利用でも、背景色だけは意図的に変わる。
明暗・glass の実際の親背景でコントラストを確認し、画像基準も更新する。
