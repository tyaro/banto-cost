# Architecture Decision Records (ADR)

> English: [README.en.md](README.en.md)

作成日: 2026-07-19（improvement-plan-2026-07.md P4-7）

このディレクトリは Banto の**基盤的な設計判断**を、代替案の比較込みで
記録する。トラックA（保守者向け）の資産であり、ハードフォークするなら
`docs/` ごと削除してよい（「すべては削除可能」方針）。

## なぜ ADR か — ドキュメントの3分類

Banto の「なぜこう書くか」は3つの置き場に役割分担する。**同じ「なぜ」を
2箇所に書かない**（変更時の同期コストを避ける）。

| 置き場                                  | 何を書くか                                                                             | 例                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **コードコメント**                      | その場・その行でしか意味を持たない局所的な理由                                         | 「object URL は `finally` で revoke」「この effect は untrack で囲う」 |
| **[conventions.md](../conventions.md)** | プロジェクト横断の**不変条件**（守らないと壊れる規約）                                 | 「両経路対称」「サービス層は axum/tauri を知らない」「生色値は禁止」   |
| **ADR（本ディレクトリ）**               | **代替案を比較して1つを選んだ設計判断**（今も有効な「なぜ Z か、X/Y をなぜ退けたか」） | 「なぜ二経路か」「なぜ依存最小化か」                                   |

conventions.md が「**ルール**（何を守るか）」なのに対し、ADR は
「**判断**（なぜそのルールにしたか・他の選択肢をなぜ捨てたか）」を残す。
conventions.md の各不変条件の背後にある判断は、対応する ADR があれば
そこから辿れる。

## 運用

- **バックフィルは一括でしない。** 既存判断の ADR 化は、その判断に次に
  触れる（見直す・関連機能を足す）タイミングで1件ずつ起こす。下の
  「ADR 化候補」は未着手のバックログ。
- 新しい基盤判断（代替案があり、片方向に倒した決定）をするときは、
  そのタイミングで ADR を1件書く。
- ファイル名: `NNNN-kebab-title.md`（連番）。書式は
  [0000-template.md](0000-template.md)。
- 状態は `Proposed` / `Accepted` / `Superseded by ADR-NNNN` / `Deprecated`。
  - `Proposed` はレビュー中。レビューが済みオーナーが承認したら `Accepted`
    に変える。`Proposed` の間は実装を始めない。レビューの指摘はその ADR を
    直接直して反映してよい。
  - `Accepted` のあとは、覆すときに `Superseded by ADR-NNNN`、使わなくなった
    ときに `Deprecated` にする。
  - **`Accepted` になった過去の ADR は書き換えず、覆すときは新しい ADR で
    supersede する**（判断の履歴を残すのが ADR の価値）。

## 索引

| #                                                   | タイトル                                                                                                                                                                                        | 状態                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| [0001](0001-rest-tauri-two-path-symmetry.md)        | REST と Tauri を同格の二経路にし、単一サービス層を対称に通す                                                                                                                                    | Accepted                   |
| [0002](0002-minimal-dependencies.md)                | 依存を足さず自前実装を既定にする（総保守コスト最小化）                                                                                                                                          | Accepted                   |
| [0003](0003-tls-via-reverse-proxy.md)               | LAN の TLS はリバースプロキシ終端を正式とし組み込み TLS は保留                                                                                                                                  | Accepted                   |
| [0004](0004-server-logging-eprintln.md)             | サーバのログは `eprintln!` を既定に据え `tracing` は保留                                                                                                                                        | Accepted                   |
| [0005](0005-i18n-paraglide.md)                      | UI i18n ランタイムに Paraglide JS を採用（ADR-0002 の例外）                                                                                                                                     | Accepted                   |
| [0006](0006-docs-in-repo-projects-status-only.md)   | 知識ドキュメントは in-repo に集約し GitHub Projects は揮発的ステータス専用に限定する                                                                                                            | Accepted                   |
| [0007](0007-derived-app-dev-optimizer-exclude.md)   | `.svelte.ts` ソース配布と派生アプリ dev の両立は消費側 `optimizeDeps.exclude` で解く                                                                                                            | Accepted                   |
| [0008](0008-machine-check-stop-gate.md)             | 機械検査を足すかは「3条件ゲート」で判断し無限追加を止める                                                                                                                                       | Accepted                   |
| [0009](0009-schema-ui-rest-renderer-boundary.md)    | UI 宣言はスキーマ駆動の漸進拡張とし追加レンダラは REST クライアントとして境界の外に置く                                                                                                         | Accepted                   |
| [0010](0010-discussions-predecision-layer.md)       | GitHub Discussions は決定前検討専用レイヤとする                                                                                                                                                 | Accepted                   |
| [0011](0011-git-tag-distribution.md)                | 配布は git タグ参照とし npm/crates.io 公開は保留する                                                                                                                                            | Accepted                   |
| [0012](0012-lan-public-viewer-synthetic-session.md) | LAN の閲覧公開は viewer 固定の合成セッション発行で実現し認証バイパスの公開ルータは作らない                                                                                                      | Accepted                   |
| [0013](0013-sysinfo-system-metrics-feature.md)      | CPU/メモリ使用率は `sysinfo` を feature 限定で採用して共通 API にする（ADR-0002 の例外）                                                                                                        | Accepted                   |
| [0014](0014-account-bound-session-revocation.md)    | セッションは行 id + 認証の世代に結び付け、要求ごとに DB で確かめて失効させる                                                                                                                    | Accepted                   |
| [0015](0015-snapshot-list-resource.md)              | 通知なしに増減する一覧は境界（`asOfId`）付きの別クラス `SnapshotListResource` で読み、取得関数を注入する                                                                                        | Accepted                   |
| [0016](0016-session-controller-single-writer.md)    | フロントのセッションの確定は 1 つの書き手（SessionController）に寄せ、provider は 1 往復で答え、資格情報の書き込みは compare-and-set にする                                                     | Accepted                   |
| [0017](0017-credential-less-grant.md)               | 資格情報なしのセッション発行は「grant」に一本化し、閲覧公開を 1 種類目・派生アプリの試運転を 2 種類目にする（v3.0.0。認証を迂回する口は作らない。`adopt()`/`end()` は削除）                     | Accepted                   |
| [0018](0018-shared-ui-package.md)                   | 汎用 UI 部品は新パッケージ `@banto/ui` へ段階的に切り出し、文言・アイコン・状態・操作は呼び出し側から注入する                                                                                   | Accepted（段階 1〜5 完了） |
| [0019](0019-audit-spool.md)                         | DB に書けない監査は保留ファイルに退避し、復旧後に `pending_id` で 1 回だけ流し込む                                                                                                              | Accepted                   |
| [0020](0020-image-assets-package.md)                | ブラウザ側の画像の原本・取込検査・URL 寿命は、新しいオプションのパッケージ `@banto/image-assets` に置く（上限は consumer が渡す・エラーコードで返す・hash は `crypto.subtle` か自前の SHA-256） | Accepted                   |
| [0021](0021-firewall-elevated-helper.md)            | 段階 2 のファイアウォールの許可は、UAC で昇格する補助プログラムが実行ファイル単位のルール 1 本だけを足し外しする                                                                                | Accepted                   |
| [0022](0022-settings-controls.md)                   | 設定カテゴリは下線型ナビゲーション、入力は移動型ラベルと下線を使う                                                                                                                              | Accepted                   |
| [0023](0023-shared-control-styles.md)               | 設定で採用した入力とページナビのスタイルをテーマで共有する                                                                                                                                      | Accepted                   |
| [0024](0024-schema-form-appearance.md)              | スキーマフォームの下線型表示は任意指定とし、ラベルを上に固定する                                                                                                                                | Accepted                   |
| [0025](0025-transparent-control-backgrounds.md)     | 入力欄と選択入力の背景は既定で透明にする                                                                                                                                                        | Accepted                   |
| [0026](0026-shared-boolean-controls.md)             | スイッチとネイティブ checkbox のスタイルを共有する                                                                                                                                              | Accepted                   |
| [0027](0027-grid-error-reader.md)                   | セルエラーを局所オーバーレイで読み、参照と再試行を分ける                                                                                                                                        | Accepted                   |

## ADR 化候補（未着手・バックフィルはしない）

次にその判断へ触れるときに1件ずつ起こす（P4-7）:

- なぜ SQLite を既定にし PostgreSQL を後回しにするか（仕様 §12.1 / P4-5）
- なぜ Provider 方式（Tauri/HTTP/InMemory の3環境吸収）か（仕様 §11.1）
- なぜ「コピー型テンプレート」で runtime プラグイン機構を作らないか
  （template-scope §3.1）→ ADR-0009 と template-scope §4.2（2026-08-25
  追記）で実質記録済み。独立 ADR は起こさない
- なぜリソースのルートを動的化せず「items をコピーする規約」にしたか
  （recipes/add-resource.md、spec §14 決着）
