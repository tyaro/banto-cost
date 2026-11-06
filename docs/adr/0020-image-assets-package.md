# ADR-0020: ブラウザ側の画像の原本・取込検査・URL 寿命は、新しいオプションのパッケージ `@banto/image-assets` に置く

> English: [0020-image-assets-package.en.md](0020-image-assets-package.en.md)

- 状態: Accepted
- 日付: 2026-10-21
- 関連: Issue #438 / [shared-primitives-upstream-plan.md](../design/shared-primitives-upstream-plan.md) §2.1・§3.7・§5（PR-12〜14）・D6・D7・D11 /
  [conventions.md](../conventions.md) §3・§4・§5・§8・§13・§14 / [template-scope.md](../template-scope.md) §1・§3・§3.1 /
  [ADR-0002](0002-minimal-dependencies.md)・[ADR-0003](0003-tls-via-reverse-proxy.md)・[ADR-0018](0018-shared-ui-package.md)

## コンテキスト

SCADA Designer（temp-scada）は、ブラウザで画像を取り込み、原本の bytes のまま持ち回る仕組み
（`image-assets.ts`: `inspectImage`・`imageHeader`・`sha256`・`AssetStore` の `put` / `pin` / `collect` /
`importFrom` / `dispose`）を自前で持っている。Issue #438 はこれを banto へ戻す提案。

banto 側の現状（計画書 §3.7）:

- ブラウザ側に画像の検査は無い。`@banto/attachments` の `core/` は表示の補助で、形式の判定はサーバーの
  `banto-attachments` の `detect_mime`（マジックバイト、conventions §6）にある。
- 重なるのは「object URL を所有者が revoke する」（conventions §8）だけ。ヘッダの検査・原本の保持・
  hash の重複排除・pin / release は banto のどこにも無い。
- temp-scada の実装は上限が定数（8MiB・8192px・1600 万画素・256MiB）で、例外の文言は日本語の直書き。
- `sha256` は `crypto.subtle.digest` を使う。`crypto.subtle` は secure context（HTTPS か localhost）でしか
  使えないので、banto の LAN 配信（平文 HTTP。TLS はリバースプロキシで終端、ADR-0003）では未定義になる。

template-scope §1 の 4 条件では、横断性（1）と代替不能性（3）が △ だった。オーナーは汎用 SCADA の次に
**案件用の特化 SCADA** を作る予定で、同じ部品を要る 2 つ目の consumer が決まっている（D6、2026-10-21）。
これで「複数の派生アプリが同じ部品を要る」として △ を補える。工場の知識は持たない（4 = ○）。

## 決定

### 1. 新しいオプションのパッケージ `@banto/image-assets`（`packages/image-assets`）を作る

- **オプション**として同梱する（template-scope §3 の表に行を足す）。テンプレートのアプリ
  （`apps/admin-template`）には配線しない（デモを同梱しない拡張、template-scope §3.1。`@banto/scan-wedge` と同じ）。
- `dependencies` / `peerDependencies` は空（conventions §4、rule `empty-deps`）。素の import は
  `svelte`・`svelte/*` と相対パスだけ（conventions §5、rule `package-bare-imports`）。
- 作業は 3 つの PR に分ける（計画書 §5 の PR-12〜14）: 骨格（本 ADR・公開する型・エラーコード・上限の検証）→
  取込の検査と hash → 原本と URL の寿命。

### 2. 上限は consumer が渡す（既定値を持たない）

bytes・辺長・画素数・許可形式（取込の検査）と総容量（原本の保持）は、呼び出し側が**必須の引数**で渡す。
SCADA の 8MiB・8192px などはパッケージの既定値にしない。「既定は上限なし」にもしない（上限の渡し忘れが
無制限の取込にならないようにする）。渡された上限そのものも検証し、不正なら投げる。

### 3. 文言を持たず、エラーコードと詳細の値を返す

パッケージは日本語の直書きをしない。失敗は `ImageAssetError`（`code` と、上限・実際の値などの `detail`）で
表し、表示文言はアプリが Paraglide のキーで決める（conventions §13）。`message` はコードと同じ文字列で、
画面に出す前提の文ではない。

### 4. hash は `crypto.subtle` があれば使い、無ければ自前の SHA-256 に落とす（D11）

どちらも同じ 16 進の値になるので、重複排除の結果が配信の形（HTTPS / 平文 HTTP）で変わらない。自前の実装は
純粋な TS で、conventions §3（依存を足さない・自前実装の文化）に沿う。既知のテストベクタ（NIST の例）で
単体テストし、大きな画像での所要時間は実装の PR（PR-13）で測る。

### 5. 要求の失効の契約は内部に持つ（#436 の部品を import しない）

パッケージ間の import は禁止なので（conventions §4・§5、計画書 §2.1）、admin-core の `createRequestOwner`
（#436）は使えない。`@banto/forms` と同じく、同じ契約の内部実装を持ち、admin-core の契約の表
（`packages/admin-core/tests/contracts/request-owner.json`）を流すテストで同じ振る舞いを確かめる（PR-14）。

### 6. scaffold と外部利用 fixture

- テンプレートのアプリに配線しないので、scaffold が外すアプリ側の配線は無い。パッケージ本体は他の
  remover と同じく同梱のまま（scaffold は触れない。`scripts/scaffold.test.mjs` の除外に理由を書く）。
  本体を消すと、docs の `@banto/image-assets` の参照が rule `docs-package-refs` に落ちる。
- `.svelte.ts` を持たない間は `optimizeDeps.exclude`（conventions §14）と外部利用 fixture
  （rule `external-consumer-fixture`）の対象外。PR-14 で `.svelte.ts` を持つなら、その PR で両方に足す。

## 検討した代替案

| 案                                                   | 内容                                                    | 退けた理由                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@banto/attachments` に足す（D6-b）                  | 既存の添付パッケージにブラウザ側の画像管理を足す        | サーバーの添付とブラウザの原本の管理は目的が違う。添付の機能を要らないアプリが attachments を外すと、画像の部品も一緒に失う（逆に画像の部品だけが要るアプリに添付の部品とサーバーの crate が付いてくる） |
| banto-industrial に置く（D6-c）                      | ドメイン特化の資産の置き場（template-scope §3.1）に置く | 工場の知識を持たない（4 条件の 4 = ○）。ドメイン特化の置き場に入れる理由が無い                                                                                                                           |
| 見送る（D6-d）                                       | temp-scada に残し、#436 の部品で薄くしてもらう          | 2 つ目の consumer（案件用の特化 SCADA）が決まっていて、同じ部品を 2 つのアプリが写すことになる                                                                                                           |
| hash を secure context に限る（D11-b）               | 平文 HTTP では hash を使わない                          | LAN の派生アプリ（平文 HTTP が標準）で重複排除の挙動が変わる                                                                                                                                             |
| hash 関数を consumer が注入する（D11-c）             | 柔軟                                                    | 各アプリが同じ問題（`crypto.subtle` が無い）を解くことになる                                                                                                                                             |
| パッケージ間 import を許して admin-core の部品を使う | 契約の複製を避ける                                      | conventions §4 の不変条件の変更で、派生アプリの Git 依存（`path:packages/*`）の入れ方も変わる（計画書 §2.1・D1）                                                                                         |

## 帰結

- `@banto/*` のパッケージが 1 つ増える（12 個目）。版は他の `@banto/*` と揃える（`check:versions`）。
- 4 条件の 1・3 は「2 つ目の consumer がある」ことに支えられている。特化 SCADA の計画が無くなり、
  consumer が 1 つのままなら、オプションから外す（banto-industrial か temp-scada に戻す）ことを再検討する。
- 自前の SHA-256 は暗号の領域の自前実装で、conventions §3 の判断基準（暗号・エッジケース）に当たる。
  用途は重複排除のキーで、改ざん検知や認証には使わない（その用途を足すなら依存の採用を含めて再判断する）。
- 要求の失効の契約は admin-core・forms・image-assets の 3 か所に実装がある。契約の表を共有するテストで
  ずれを止める。
