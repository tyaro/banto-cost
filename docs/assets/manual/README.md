# 取扱説明書の画面画像

トップの [README](../../../README.md)（取扱説明書）で使う画面画像です。すべて架空のサンプルデータで撮影しています。実データの画面を入れないでください。

## 撮り直す手順

画面を変えたら、次の手順で撮り直します（`scripts/manual-screenshots.mjs`）。空のデータベースに架空のデータを登録してから撮影します。

```sh
pnpm build
cargo build -p admin-template-core --bin banto-serve --features embed-ui
PORT=8811 BANTO_DB=/tmp/manual.sqlite3 BANTO_ALLOW_SETUP=1 target/debug/banto-serve
```

別の端末で:

```sh
node scripts/manual-screenshots.mjs
```

- `BANTO_DB` には毎回新しいファイルを指定します（初回設定から始めるため）。
- Playwright 同梱以外の Chromium を使うときは `CHROMIUM_PATH` を指定します。
- 「今月」「今週」を基準に表示する画面（ダッシュボード・工数入力・直接費入力など）は、撮影した日によって内容が変わります。サンプルデータは 2026年11月 の撮影を想定しています。
