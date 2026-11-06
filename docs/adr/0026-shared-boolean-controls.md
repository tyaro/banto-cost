# ADR-0026: スイッチとネイティブ checkbox のスタイルを共有する

> English: [0026-shared-boolean-controls.en.md](0026-shared-boolean-controls.en.md)

- 状態: Accepted
- 日付: 2026-11-04
- 関連: [Issue #495](https://github.com/tyaro/banto/issues/495) / [ADR-0023](0023-shared-control-styles.md)

## 決定

設定専用スイッチを `@banto/theme/css` の opt-in スタイルにする。
`label.banto-switch-field` 内の `input.banto-switch[type="checkbox"][role="switch"]` を対象にし、
ラベル、checked / disabled、Space 操作、送信はネイティブのまま維持する。
状態・保存・認可を CSS で制御しない。

- `--banto-switch-width` / `-height` / `-inset` で形を定義する。
  ラベル行の最小高さは `--banto-control-height-lg` とする。
- forced-colors のカスタム描画だけ `forced-color-adjust: none` と system colors を使う。
  checked は丸の位置でも示す。作者色の shadow は消し、実線のフォーカス枠を残す。
- forms と列表示メニューの checkbox はネイティブ描画を使う。
  `--banto-checkbox-size: 1.1rem`、実線のフォーカス枠・既存 ring・無効状態の減光を揃える。
  各 package に scoped CSS と寸法 fallback を残し、旧 theme・独自トークン利用にも対応する。
- checkbox の readonly→disabled、最後の表示列を隠せない制約、イベント・送信は維持する。

## 理由と帰結

JS wrapper や checkbox の完全な独自描画より、既存操作と単独利用の契約を保つ範囲で共有する。
外部コード・フォント・新規依存・package 間 import は追加しない。
更新された設定 markup は対応版 theme と組み合わせる。

全設定カテゴリを日英・320px・文字 200% で確認する。カード・ボタン・長いラベル・QR・
説明と値の並びを収まる構造にし、保存・破棄・離脱確認とネイティブ操作を回帰検証する。
