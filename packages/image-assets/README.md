# @banto/image-assets

ブラウザ側で画像を取り込み、原本の bytes のまま持ち回るための部品（オプション扱い、
[ADR-0020](../../docs/adr/0020-image-assets-package.md)・Issue #438）。取込の前にヘッダを検査し、
原本を hash で重複排除して保持し、表示用の object URL の寿命を所有者が管理する。
デザイナのように「取り込んだ画像を原本のまま保存・再利用する」画面のためのもので、サーバーへの
添付（`@banto/attachments`）とは目的が違う。テンプレート本体には配線しておらず、使うアプリが
直接組み込む。

## 状態（段階的に入る）

| PR    | 中身                                                                                                                                                            | 状態       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| PR-12 | 骨格: 形式（`IMAGE_FORMATS`）、上限の型と検証（`ImageImportLimits`・`validateImageImportLimits`）、エラーコード（`ImageAssetError`・`IMAGE_ASSET_ERROR_CODES`） | 入っている |
| PR-13 | 取込の検査: decode 前のヘッダ検査（PNG / JPEG の形式・寸法・画素数）と decode 後の確認、hash（`crypto.subtle` があれば使い、無ければ自前の SHA-256。同じ値）    | 入っている |
| PR-14 | 原本と URL の寿命: 原本 bytes の保持、hash による重複排除、object URL の共有と解放、pin / release、要求の失効の契約                                             | 入っている |

計画は [docs/design/shared-primitives-upstream-plan.md](../../docs/design/shared-primitives-upstream-plan.md) §3.7・§5。

## 約束

- **上限は呼び出し側が渡す**: bytes・辺長・画素数・許可形式は必須の引数で、パッケージは既定値を持たない
  （「上限なし」も既定にしない）。渡された上限は `validateImageImportLimits` で検証し、不正なら
  `ImageAssetError('invalid-limits', { field })` を投げる。
- **文言を持たない**: 失敗は `ImageAssetError` の `code` と `detail`（上限・実際の値など）で返す。
  画面の文言はアプリが Paraglide のキーで決める（docs/conventions.md §13）。`message` はコードと同じ
  文字列で、そのまま画面に出すものではない。

```ts
import { inspectImage, isImageAssetError, validateImageImportLimits } from '@banto/image-assets';

const limits = validateImageImportLimits({
	maxBytes: 8 * 1024 * 1024,
	maxEdge: 8192,
	maxPixels: 16_000_000,
	formats: ['png', 'jpeg']
});

try {
	const image = await inspectImage(file, limits); // file: File / Blob / Uint8Array / ArrayBuffer
	// image: { format, mimeType, width, height, transposed, byteLength, hasAlpha, sha256 }
} catch (e) {
	if (isImageAssetError(e)) showError(m[`imageAssets.error.${e.code}`](e.detail));
	else throw e;
}
```

## 取込の検査（PR-13）

| API                                              | 中身                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspectImage(input, limits, { decode? })`       | 下の 3 つを順に通す。`Blob` は `size` で `maxBytes` を見てから読み、読み取りの失敗は `read-failed`。バイト列は `maxBytes` を見てから 1 度だけ複製し、ヘッダ・decode・hash に同じ複製を使う（decode を待つあいだに呼び出し側が書き換えても食い違わない）。ヘッダで落ちたら decode しない |
| `inspectImageHeader(bytes, limits)`              | decode 前のヘッダ検査。順に bytes（`too-large`）→ 形式（`unsupported-format`）→ 構造（`malformed-header`）→ 辺（`dimensions-too-large`）→ 画素数（`too-many-pixels`）                                                                                                                   |
| `verifyDecodedImage(bytes, header, { decode? })` | ブラウザで実際に decode し、寸法がヘッダと一致するか確かめる（`decode-failed`・`dimensions-mismatch`）。decode した画像は必ず `close()` する                                                                                                                                            |
| `sha256Hex(bytes)`                               | SHA-256 の 16 進（小文字 64 桁）。`crypto.subtle` があれば使い、無ければ（平文 HTTP の LAN）自前の SHA-256。同じ値（D11）                                                                                                                                                               |

- **サーバーの検査の代わりではない**: 取込の画面で早く断るための検査。アップロードを受けるサーバーは自分で
  マジックバイトを判定する（docs/conventions.md §6）。
- **上限は毎回検証する**: `inspectImageHeader` と `inspectImage` は受け取った上限を
  `validateImageImportLimits` に通し直す。検証していない上限を渡しても無検査にはならない。
- **形式は中身で決める**: ファイル名や `Blob.type` は見ない。decode に渡す `Blob` の type もヘッダから決めた
  MIME にする。
- **decode の注入**: 既定は `createImageBitmap(blob, { imageOrientation: 'from-image' })`。テスト（node / jsdom）
  や別の decode を使うアプリは `decode: (blob) => Promise<{ width, height, close?() }>` を渡す。投げる・拒否する・
  正の整数でない寸法を返すのはどれも `decode-failed`。
- **hash の用途は重複排除のキー**: 改ざん検知や認証には使わない（ADR-0020「帰結」）。自前の SHA-256 は
  8MiB で約 50ms（node 25 / V8 の計測。`crypto.subtle` は約 13ms）。

### ヘッダ検査の範囲

- **PNG**: 静止画だけ。最初のチャンクが正しい IHDR（長さ 13、幅・高さが 1〜2^31-1、色の型とビット深度の
  組が仕様どおり、圧縮・フィルタが 0、インタレースが 0 か 1）。全チャンクの長さが範囲内で、IDAT があり、
  IEND で終わり、その後ろに何も無いこと。`acTL`（APNG）は `unsupported-format`。CRC は見ない（decoder が見る）。
  `hasAlpha` は色の型 4・6 か `tRNS` チャンクがあるとき `true`。
- **JPEG**: 最初のフレームヘッダ（SOFn）までマーカーを走査する。ベースライン（SOF0）・拡張シーケンシャル（SOF1）・
  **プログレッシブ（SOF2）を受け入れる**。8 ビットで成分数 1・3・4（グレー・YCbCr / RGB・**CMYK / YCCK を受け入れる**）。
  ロスレス・階層・算術符号化のフレームと 12 ビットは `unsupported-format`（ブラウザが decode しない）。
  セグメント長は 2 以上で残りの長さに収まること、フレームヘッダの長さは成分数と一致することを確かめ、
  壊れた・悪意のある入力でも範囲外を読まず、走査は必ず前に進む（無限ループしない）。高さ 0（DNL で後から
  決まる）は `malformed-header`。フレームヘッダより後ろ（スキャンのデータ）は decode 後の確認に任せる。
  `hasAlpha` は常に `false`。
- **EXIF の向きは読まない**: ヘッダ検査の寸法は保存された寸法。90 度の回転は幅と高さを入れ替えるだけで
  `maxEdge`（各辺に同じ上限）と `maxPixels` の判定は変わらない。decode 後の確認は入れ替わった寸法も一致と
  みなし、`transposed: true` で返す（`width` / `height` は表示される向きの寸法）。PNG の `eXIf` も同じ扱い。

## 原本と URL の寿命（PR-14）

```ts
import { createImageStore, isImageAssetError } from '@banto/image-assets';

const store = createImageStore({ maxTotalBytes: 256 * 1024 * 1024 }); // 総容量は必須
const image = await store.add(file, limits, { key: 'background' }); // 新しい add が古い add を失効させる
if (!image) return; // 失効した add は null（結果もエラーも出さない）
const lease = store.acquireUrl(image.sha256); // <img src={lease.url}>
// 表示をやめるとき: lease.release()（最後の release で revoke）
const release = store.pin([image.sha256]); // 書き出し中は collect / delete / dispose で消えない
try {
	await exportProject(store.blob(image.sha256)); // 原本（ヘッダの MIME の Blob）
} finally {
	release();
}
store.collect(usedHashes); // 今の内容と Undo / Redo が参照する hash の和集合を渡す
store.dispose(); // 画面を閉じるとき
```

| API                                                | 中身                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createImageStore({ maxTotalBytes, objectUrls? })` | 原本の store を作る。`maxTotalBytes`（保持する原本の合計バイト数の上限）は必須で、正の安全な整数でなければ `invalid-limits`（`field` は `options`・`maxTotalBytes`・`objectUrls`）。`objectUrls` は `{ create(blob), revoke(url) }` の注入（既定は `URL.createObjectURL` / `URL.revokeObjectURL`）                                                                        |
| `add(input, limits, { key?, decode? })`            | `inspectImage` と同じ検査を通し、原本を保持する。入力（呼び出し側のメモリ）は 1 度だけ複製し、ヘッダの MIME の `Blob` として持つ（再 encode しない）。同じ内容（SHA-256 が同じ）は 1 件で、既に持っている metadata を返す。失敗は検査のコード・`store-full`・`store-disposed`（dispose 後の呼び出し）。**失効した add は `null`** で、保持も失敗の報告もしない            |
| `busy(key)` / `cancel(key)`                        | `key` の add が処理中か（reactive）/ `key` の add を失効させる（対象が変わったとき）                                                                                                                                                                                                                                                                                      |
| `has(hash)` / `metadata(hash)` / `blob(hash)`      | 保持しているか（reactive）/ metadata（凍結済み）/ 原本の `Blob`。無い hash は `unknown-asset`（`detail.hash`）                                                                                                                                                                                                                                                            |
| `count` / `totalBytes` / `disposed`                | 件数 / 合計バイト数 / dispose 済みか（どれも reactive）                                                                                                                                                                                                                                                                                                                   |
| `acquireUrl(hash)`                                 | object URL の利用を 1 つ借りる（`{ url, release() }`）。URL は原本ごとに 1 つを共有し、最初の借用で作り、**最後の `release()` で revoke** する。`release()` の 2 回目は何もしない。注入した `create` の実行中は原本を貸出中として扱い（`delete` / `collect` / `dispose` で消えない）、その中から同じ原本の `acquireUrl` は `url-pending`（`create` が失敗すれば元に戻す） |
| `pin(hashes)`                                      | 原本を `collect` / `delete` / `dispose` から守り、解除の関数を返す（2 回目は何もしない）。全 hash を確かめてから pin する（1 つでも無ければ何も pin せず `unknown-asset`）。同じ hash を 2 回渡しても 1 回の pin                                                                                                                                                          |
| `collect(retained)` / `delete(hash)`               | `retained` に無い・pin されていない・URL を貸していない原本を捨てる（件数を返す）/ 1 件を捨てる（pin 中・URL 貸出中・無い hash は `false`）                                                                                                                                                                                                                               |
| `importFrom(source, hash)`                         | 別の store の原本をこちらでも持つ（同じ不変の `Blob` を共有し、bytes は複製しない。重複排除・総容量の判定はこちらの store）。取込の候補を一時 store に置き、採用したときだけ本体へ移す使い方のため                                                                                                                                                                        |
| `dispose()`                                        | 処理中の add をすべて失効させ、pin も URL の貸出も無い原本を捨てる。pin・貸出中の原本は読めるまま残り、最後の解除で消える。以後の `add` / `importFrom` / `pin` / `acquireUrl` は `store-disposed`（`collect` / `delete` / `cancel` / 2 回目の `dispose` は何もしない）                                                                                                    |

- **要求の失効**: 処理中の add は、admin-core の `createRequestOwner` と同じ契約の内部の写し
  （`src/requestOwner.svelte.ts`）が持つ。パッケージ間の import は禁止なので（docs/conventions.md §4・§8）、
  admin-core の契約の表（`packages/admin-core/tests/contracts/request-owner.json`）を自分のテストで流してずれを止める。
  同じ `key` の新しい add・`cancel(key)`・`dispose()` で失効する。`key` の無い add は `dispose()` でだけ失効する。
- **再入**: `revoke` などの外部の関数を呼ぶ前に store の状態を確定する（`revoke` の中から `delete` を呼んでも
  正しく動く）。
- **`$effect` から呼んでよい**: 書き込む method は reactive な版を追跡して読まないので、`$effect` の中から
  呼んでも effect が自分を再実行し続けない。
- **失敗はすべて `ImageAssetError`**: ただし `importFrom` に store 以外を渡したときは `TypeError`（バイト列の型を
  間違えたときと同じ扱い）。

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ（docs/conventions.md §4・§5）。
SHA-256 も自前（docs/conventions.md §3。ADR-0020 §4）。

**`.svelte.ts` を持つ**（store と要求の所有者が `$state` を使う）。使うアプリは `vite.config.ts` の
`optimizeDeps.exclude` に `@banto/image-assets` を足す（docs/conventions.md §14、ADR-0007。足さないと派生アプリの
dev が 500 になる）。テンプレートのアプリは依存しないので、`apps/admin-template/vite.config.ts` には無い。
外部利用 fixture（`fixtures/external-consumer/`）には足してある。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、外部リポジトリからは git
サブディレクトリ依存で消費する。詳細は [../../docs/publishing.md](../../docs/publishing.md) を参照。
