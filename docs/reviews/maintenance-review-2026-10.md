# リファクタ要否の再点検（2026-10）

作成日: 2026-10-20
状態: **判断の記録**。§3 の「やる」（R-1〜R-5）は 2026-10-20 にすべて実施済み（§3 末尾の表）。
§4・§5 は見直しの合図が来るまで判断を固定する。2026-11-05 の再点検の結果は §7。
位置づけ: 「リファクタをするべきか、このままでよいか」に答える棚卸し。前回の
[maintenance-review-2026-08.md](maintenance-review-2026-08.md)（以下「前回」）§3.3 の
「やらないと決めること」と、その見直し条件が今も成り立つかを、2026-08-13 以降の変更履歴で
確かめた。Rust・フロントエンド・ツール/CI の3領域を並列に調べ、主要な主張は手元で再計測した。

トラック: 本書は**保守者向け（トラックA）**。
関連: [maintenance-review-2026-08.md](maintenance-review-2026-08.md)（前回・§3.3 が本書の出発点）、
[ADR-0008](../adr/0008-machine-check-stop-gate.md)（機械検査の打ち止め条件）、
[conventions](../conventions.md)。

---

## 1. 結論

**大規模なリファクタは不要。** 2026-08-13 以降、コミットは全体で 637 件、Rust 側は
126 件のうち fix が 51 件（約 40%）だった。ただし fix の集まり方を見ると、原因は
ファイル構成ではなく、**非同期の保存とセッションの寿命という本質的な並行性**にある
（§2）。ファイルを分けても不具合は減らない。分割で得られるのは読みやすさだけで、
その代わりに scaffold・機械検査のアンカー（字面への依存）を壊すリスクを負う。

したがって判断は3つに分ける。

- **やる（§3）**: 前回の見直し条件を越えたもの、前回約束して未実施のもの、ほぼ費用ゼロで
  静かな破れを防げるもの。いずれも挙動を変えない小さな PR。
- **保留（§4）**: 価値はあるが、直近の fix で安定したばかりの領域。次にその領域を触る
  issue に併せて行い、分割だけを目的にした PR は作らない。
- **やらない（§5）**: 前回の判断を維持するもの。

## 2. 計測の要点

### 2.1 大きいファイルの伸び（基準 = 2026-08-13 以前の最終コミット c60b967）

| ファイル | 基準 | 現在 | 内訳・備考 |
| --- | --- | --- | --- |
| `crates/banto-server/src/auth.rs` | 1,439 | 3,448 | 本体 1–1754 行、テスト 1755–3448 行。前回「これ以上足さない」ライン |
| `apps/admin-template/src-tauri/src/lib.rs` | 2,696 | 6,830 | 本体 +1,293 行（約 1.5 倍）、テスト 439 → 3,280 行（約 7.5 倍） |
| `crates/banto-admin-services/src/audit.rs` | 659 | 2,672 | テストが約 64%（954 行目から） |
| `apps/admin-template/core/src/rest/tests.rs` | 2,374 | 4,020 | テスト専用 |
| `crates/banto-storage/src/list_query.rs` | 802 | 1,812 | テストが約 75%（本体 448 行） |
| `packages/grid-svelte/src/BantoGrid.svelte` | 1,372 | 1,562 | 8/13 以降 10 コミット、うち fix 8 |
| `packages/admin-core/src/sessionController.svelte.ts` | — | 1,191 | `createCore` が約 670 行の1クロージャ。11 コミット、うち fix 6 |

伸びの多くはテストである。本体が大きく伸びたのは auth.rs と lib.rs の2つ。

### 2.2 fix が集まっている場所

- **一覧の編集・保存・状態の復元**: `apps/admin-template/src/routes/(app)/items/+page.svelte`
  （15 コミット中 fix 9。保存の行単位の直列化、drain 後の古いスナップショット、一覧状態の
  所有者、詳細往復後の復元など）と、BantoGrid のインライン編集（#205 行 ID への固定、
  #210 非同期保存を編集セッションごとに分離、#211、#212、#236）。同じ関心事でつながっている。
- **認証設定・セッション失効**: src-tauri `lib.rs`（35 コミット中 fix 22）と `auth.rs`
  （13 コミット中 fix 8）。#204（セッション失効）、#266（ログイン不要モード、P1 の再レビュー
  4 件）、#279（並行ログインのスロットル）、#287/#294（LAN・認証設定の直列化）。

どちらも「ファイルが大きいから壊れた」のではなく、並行する操作の順序を取り違えた不具合である。

### 2.3 手元で再計測したこと

- `pnpm exec eslint .` は errors 0 / warnings 0（2026-10-20）。
- [ADR-0008](../adr/0008-machine-check-stop-gate.md) の採否台帳に rule 13
  （external-consumer-fixture）の記載は無い。
- Db enum ディスパッチの重複を受け入れる判断は、conventions にも ADR にも書かれていない
  （`docs/` を grep して、前回のレビュー本文にしか出てこない）。
- `scripts/scaffold.mjs` は `apps/admin-template/vite.config.ts` にアンカーを張っている（405 行目・
  1079 行目）が、`template-acceptance.yml` の `paths` にこのファイルは無い（R-3）。
- `auth.rs` は `scripts/scaffold.mjs` と `scripts/verify-architecture.mjs` のどちらからも
  パスで参照されていない（分割しても道具は壊れない）。

## 3. やる（小さな PR に分ける）

番号は本書内の通し番号（R-N）。上から費用の小さい順。

| # | 内容 | 根拠 | 範囲 |
| --- | --- | --- | --- |
| R-1 | 前回の約束の片付け: (a) Db enum ディスパッチの重複（約 50 対の match）を意図的なトレードオフとして conventions（ja/en）に 1 行書く、(b) ADR-0008 の採否台帳に rule 13 を追記する | 前回 §3.3 で「conventions に1行残す」と決めて未実施。ADR-0008 は新しい rule ごとに採否と理由を追記する義務がある | 文書のみ |
| R-2 | `pnpm lint` に `--max-warnings=0` を付ける | 前回 §3.2 の「eslint warn がノーゲート」。現在 warnings 0 なので、付けても何も落ちず、今後の warn の積み上がりだけを止める | package.json 1 行 |
| R-3 | scaffold のアンカー対象のファイル一覧と、`template-acceptance.yml` の `paths` が一致することを機械で検査する。あわせて、今ある抜け（`apps/admin-template/vite.config.ts`）を `paths` に足す | 8/13 以降、scaffold のアンカー切れの修正が約 10 件（8eb0e45、3fbd691、3df7e45 など）。`paths` は手書きで、足し忘れると受け入れ CI が走らず静かに壊れる（template-acceptance.yml:26-30 に再発 2 回の記録）。実際に、scaffold.mjs:405 と :1079 が `vite.config.ts` にアンカーを張っているのに、このファイルは `paths` に無い（vite の設定だけを変える PR では受け入れ CI が走らない）。ADR-0008 の3条件を満たすので、採否台帳にも追記する | scripts + template-acceptance.yml + ADR |
| R-4 | `auth.rs` をモジュールに分ける（移動のみ）: 型（Identity・Session*）／ポリシー（TokenPolicy・RateLimitPolicy・FailureRecord・InFlight）／`AuthState`／axum のハンドラ／テスト | 前回 §3.3 の見直し条件（「これ以上足さない」「次に大きな機能を足すときに併せて」）を越えた。基準の 2.4 倍で、ADR-0014（セッション失効）と ADR-0017（grant 一本化）の2つの大きな機能が入った | Rust。公開 API は `auth::` の re-export で保つ。ロジックは触らない |
| R-5 | fetch ラッパ名の再統一（`*Admin.ts` の http 側が `httpJson` / `httpRequest` / `httpPostJson` / `httpGet` の 4 種） | 前回 §3.3 で「fetch ラッパ名の再統一だけは行う」と決めて未実施。4 種のまま。`authAdmin.ts` の `call` は Tauri のコマンドを呼ぶ補助関数で fetch のラッパではないので、対象に含めない（invoke 側は全ファイルで `invokeCommand` にそろっている） | 機械的な rename。挙動は変わらない |

R-4 の注意: 並行性まわりのコードなので、**移動だけ**にして差分を読みやすく保つ。`Inner` の
private フィールドを使うテストには `pub(super)` が要る。`cargo test -p banto-server` の
件数が前後で一致することを確認する。

### 実施結果（2026-10-20）

| # | PR | 実施内容 |
| --- | --- | --- |
| R-1 | #412 | conventions §2（ja/en）に Db ディスパッチの判断を追記。見直しの合図は「パリティの回帰」（match の片方の腕だけを直して両バックエンドの挙動がずれた不具合）に絞った。ADR-0008 の採否台帳に rule 13 を追記 |
| R-2 | #413 | `pnpm lint` を `eslint . --max-warnings=0` にした |
| R-3 | #417 | rule 14（scaffold-acceptance-paths）を追加。scaffold の `--dry-run --list-touched` から編集対象を得て、`template-acceptance.yml` の push / pull_request 両方の `paths` との一致を検査する。`vite.config.ts` と `core/Cargo.toml` の抜けを `paths` に足した。banto 本体でだけ動く（本体専用の fixture があり、ルート `package.json` の `name` が `banto` のとき）。ADR-0008 の採否台帳に追記 |
| R-4 | #415 | `auth.rs` を `auth/{mod,session,policy,state,routes,tests}.rs` に分けた（移動のみ。テスト件数は前後で一致） |
| R-5 | #414 | http 側のラッパを全ファイル `httpRequest(path, init: HttpInit)` にそろえた。名前だけでなく引数の形もそろえ、他ファイルの呼び出しをコピーしたとき init が本文として送られる取り違えを防いだ |

あわせて、Windows CI で不安定だった `spool_after_a_hang_does_not_duplicate_the_late_insert`
（流し込みの INSERT が 200 ms の timeout で中断していた）を #416 で直した。

## 4. 保留（見直しの合図を決めて固定する）

| 対象 | 価値 | 今やらない理由 | 見直しの合図 |
| --- | --- | --- | --- |
| BantoGrid のインライン編集（`startEditing` / `commit*` / エディタのイベント）を `.svelte.ts` のコントローラに出す | fix が集まった領域の見通しが良くなる | 9 月の fix（#205・#210）で状態遷移が安定したばかり。動かすリスクのほうが大きい | 次にインライン編集・保存の issue に着手するとき、その PR の前段として |
| items ページの保存の直列化とスナップショット追従を1か所にまとめる | §2.2 の fix 9 件の根にある | テンプレート本体とデモを兼ねるページで、コピー面積の方針（V2 テーマ C）とも関わる。設計が要る | 同じ種類の fix がもう1件入ったとき |
| 認証設定の判断（`auth_config_lock` の下での判断）を1モジュールに集め、不変条件を conventions に書く | §2.2 の fix の集まりに効く可能性が最も高い | リファクタではなく設計の論点。design 文書を先に書くべき | 認証設定・セッションの次の issue に着手するとき（R-4 とは別に） |
| `sessionController.svelte.ts` の `resolveSettled`（1046 行目付近）と `grantFallback`（1149 行目付近）を別ファイルへ出す | 低リスク | 急ぐ理由が無い。`createCore` 本体の分割はテストで固めた状態機械なのでしない | 次に sessionController に機能を足すとき |
| `audit.rs` と src-tauri `lib.rs` のテストだけを別ファイル（`mod tests;`）に出す | ファイルの見通しが良くなる | lib.rs はサンドボックスでコンパイルできず、tauri-check CI でしか確かめられない。急ぐ理由が無い | どちらかのファイルの本体に大きな機能を足すとき |
| ワークフローの setup（pnpm + node + install）を composite action にまとめる | 重複が減る（ci.yml だけで pnpm/node の setup が 5〜6 回） | scaffold が ci.yml の字面を編集する。dependabot の `directories` に `.github/actions/` を足さないと SHA の追従から漏れる | setup の手順を全ジョブで変える必要が出たとき（同じ PR で dependabot と scaffold も直す） |

## 5. やらない（判断を維持する）

- **src-tauri `lib.rs` 本体の分割**: verify-architecture の rule 8/9 が今も単一ファイルを前提にしている
  （`scripts/verify-architecture.mjs` の `tauriLib` と `libFile`）。前回の判断を維持する。
- **`rest/tests.rs` の分割**: scaffold.mjs が強く依存している（マーカー、列 0 の位置、`use super::*;`）。
- **`*Admin.ts` の DRY 化**: 前回の「均一な重複 > 賢い抽象」を維持する。ファイルは 6 → 8 に増えたが、
  重複するヘルパー（`demoModeError`・`isErrorBody`・`toProviderError`・`currentToken`）による
  不具合や fix の集中は見つからなかった。コピーして使う利用者には、各ファイルが自己完結しているほうがよい。
- **Db enum ディスパッチのマクロ化**: 前回の見直し条件（Postgres の実配線）は満たしたが、match の
  片方の腕だけを直して両バックエンドの挙動がずれた不具合（パリティの回帰）は履歴に無い（Postgres 関連の
  fix 59f33df・44b9fbd はどちらも片方のバックエンドに固有の問題で、パリティの回帰ではない）。マクロ化すると
  両バックエンドの SQL の違いが読みにくくなる。R-1 で判断を文書に残す。次の見直しの合図は、3つ目の
  バックエンドか、パリティの回帰の発生。
- **`verify-architecture.mjs` の分割**（1,057 行、13 rule）: scaffold.mjs がこのファイルの字面にも
  アンカーを張っている。rule 同士が干渉した形跡も無い。
- **scaffold のアンカー方式の全面書き換え**: 1,973 行・約 250 の編集呼び出しで費用が大きい。
  R-3 で足し忘れを防ぎ、変更の多いアンカーから順に `cutMarked`（本体側に埋めたタグで囲む方式）へ
  寄せていく。
- **docs 参照検査と i18n 検査の統合**: 重複は見つからなかった（rule 7、rule 10、
  `check-i18n-nonempty.mjs` はそれぞれ別のものを見ている）。
- **list_query.rs・users.rs・settings.rs・BantoGrid.svelte のファイル分割**: 本体は健全で、伸びはテスト。

## 6. 前回の指摘で実施済みと確認したもの

- M-1（Tauri 側の `record_ok` ヘルパー）: 実施済み。手書きの `AuditEntry {` は 31 → 9 箇所。
- M-7（settings ページの分割）: 実施済み。`+layout.svelte` と 5 つのセクションのコンポーネントに分かれた。
- M-13（`api_router` の `Services` 構造体化）: 実施済み（`apps/admin-template/core/src/rest/mod.rs` の
  `pub struct Services`）。

## 7. 2026-11-05 の再点検

対象は 2026-10-20 以降の変更（main の b8caf0b まで）。**大規模なリファクタは引き続き不要。**
§2.2 で不具合が集まっていた場所は落ち着いている: `sessionController.svelte.ts` は 0 コミット、
items ページは 1 コミット（#503）、`auth/state.rs` は 1 コミット（fix なし）。
`auth_config_lock` は firewall と reach-check の本体では使っていない。

やったこと（どちらも挙動を変えない小さな PR）:

| PR | 内容 | 根拠 |
| --- | --- | --- |
| #510 | BantoGrid のセルエディタ 3 分岐のテンプレートを `CellEditor.svelte` に切り出す | §4 の合図（#505・#507・#508 がインライン編集に着手した）。#505 では同じ aria 属性を 3 か所に足した |
| #511 | `firewall_status.rs` の識別子検証・ルール名・PowerShell の引用・`-EncodedCommand` を helper（`apps/admin-template/elev`）の関数に一本化する | 段階 1 の読み取りが段階 2 のルールを見つけられるかが、コメントの同期の約束に頼っていた |

§4 の判断の更新:

- **BantoGrid の編集の状態遷移を `.svelte.ts` に出す**: 保留を続ける。#505〜#508 の変更の中心はテンプレート・
  キー処理・エラー表示で、`commitValue` などの状態遷移ではなかった。合図を「編集の状態遷移・保存の issue に
  着手するとき」に絞る。
- **`lib.rs` のテストの分離**: 合図は来た（本体が約 3,550 行から 4,387 行に増えた）が、見送る。テスト部分に
  scaffold の `[scaffold:items]` マーカーが 8 件と M20 の文字列アンカーがあり、§4 の想定より費用が大きい。
  10/20 以降の fix もファイルの大きさが原因ではない。合図を「scaffold のアンカーをテストから外すとき」に改める。
- そのほかの §4 の項目は合図が来ていないので変えない。§5 も維持する。

新しい観察（今は動かない）:

- `.banto-input` は app の `app.css` だけが定義し、`packages/tree-svelte/src/TreeSelect.svelte` も class として
  指定している。派生アプリでの見た目への影響は未確認。
- `settings` の手書きのマークアップの繰り返し（スイッチ 5 か所、選択入力 4 か所）は、#496〜#504 で揃えたばかりで
  不具合も無いので、共通部品にしない。
