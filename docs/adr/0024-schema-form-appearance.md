# ADR-0024: スキーマフォームの下線型表示は任意指定とし、ラベルを上に固定する

> English: [0024-schema-form-appearance.en.md](0024-schema-form-appearance.en.md)

- 状態: Accepted
- 日付: 2026-11-04
- 関連: [Issue #495](https://github.com/tyaro/banto/issues/495) /
  [ADR-0023](0023-shared-control-styles.md) / [conventions.md](../conventions.md) §4・§5・§9

## コンテキスト

共通スタイルを設定とログインへ適用し、次の展開として商品・ユーザー管理のフォームを扱う。
これらはスキーマ駆動の `BantoForm` と手書きの入力が混在する。既存利用者の表示を保ちながら、
同じ画面の作成・編集・パスワード再設定で共通の見た目を選べるようにする必要がある。

## 決定

- `BantoForm` に `appearance?: 'default' | 'underline'` を追加する。省略時は既存表示を維持する。
  underline は対応版の `@banto/theme/css` を利用するが、パッケージ間 import や依存は追加しない。
- underline のラベルは常に通常フローで入力の上に置く。text / password / number / select に加え、
  date / textarea も固定上表示で扱う。ネイティブの日付 UI、textarea の行数・縦リサイズを維持し、
  checkbox は従来の表示を残す。number を `DraftNumberField` に置き換えることはしない。
- 各 field の任意 `class` はネイティブ要素へ転送し、既存の readonly のクラスと共存させる。
  `BantoForm` は共通クラスを付けるだけで、テーマの CSS を読み込む責任は利用側にある。
- 生成 ID・label の for・必須印・入力配線は両表示で共有し、エラー文は label の外へ置く。
  schema / store / draft / 検証・送信・readonly の契約は変更しない。
- 商品の作成・編集、ユーザーの作成・編集・再設定に明示指定して採用する。
  一覧の select、グリッド内編集、SCADA はこの変更へ含めない。

## 検討した代替案

- **既定表示を一括変更する:** 外部 consumer と独自画面の密度・見た目を暗黙に変えるため採用しない。
- **スキーマフォームも浮動ラベルにする:** 任意の長い項目名、placeholder、date / textarea の構造を
  一律には扱えない。固定上表示なら schema に表示用の属性を増やさず全文の高さを確保できる。
- **forms に共通 CSS をコピーする:** theme と二重に保守することになるため、公開クラスで連携する。

## 帰結

- `FormAppearance` と field の `class` は追加 API。既存利用者は変更不要。
  採用する場合は forms と theme を同じ対応版へ更新する。
- default / underline の両方でラベル・エラー・ID・送信・readonly の回帰を検証する。
  CSS の詳細度、等幅数字、複数行入力は実ブラウザでも確認する。
