# Banto（番頭） — Tauriフルスタック管理画面フレームワーク 仕様 (v0.8)

<!-- 2026-10-07: §4.1 の WindowedListResource の失敗を SnapshotListResource と同じ `failures`・
     `messages`・`notify` の形に更新し、エラーの型を共通の `ListBlockError` に改名（Issue #344、
     v6.0.0 の破壊的変更、ADR-0015 の 2026-10-07 の追記）。 -->
<!-- 2026-10-06: §11.2 にセキュリティヘッダーの CSP（既定は厳格、connect-src だけを
     要求ごとに広げられる `with_security_headers_using`、banto-industrial#505）を追記。 -->
<!-- 2026-10-06: §4.1 の SnapshotListResource の失敗を `failures`（ブロック順・コード付き）・
     `messages`・`notify` の形に更新（Issue #342、v5.0.0 の破壊的変更、ADR-0015 追記）。 -->
<!-- 2026-09-30: §3.3 の AuthProvider を v2.0.0 の形（resolve / credentialRevision /
     onCredentialChanged、Issue #260・ADR-0016）に更新。§8.1 のガードも同じ。 -->
<!-- 2026-09-29: §4.1 に SnapshotListResource（境界 asOfId 付きのブロック読み込み、
     Issue #248）を追記。 -->
<!-- v0.8（2026-08-14）: §6.4 デザインルール収載、§14 の解決済み未決事項
     （ドッキング初期スコープ / REST エラーフォーマット）に決着を追記、§15 に
     M0〜M9 完了印と roadmap への誘導を追記。v0.7 → v0.8。 -->

## 0. 名称

**Banto（番頭）**。江戸時代の商家で主人に代わって店を切り盛りした
「番頭」に由来する。管理画面（admin）フレームワークとしての役割を
そのまま表す。npmスコープは`@banto`、Rustクレートは`banto-*`。

## 1. 背景・目的

Tauri v2 (Rust backend) + Svelte (frontend) 構成のアプリで、Skeleton / Flowbite を
UIキットとして使用している。見た目・基本コンポーネントには不満はないが、以下の
高機能コンポーネントが力不足であるため、独自に開発する。

- テーブル / データグリッド
- フローティングウィンドウ（ドッキング・タブ化を含むレイアウトシステム）
- チャート / グラフ（SVG/Canvasによるフルスクラッチ実装）
- 汎用フォーム（スキーマ駆動の自動生成）

全体像は **refine (https://refine.dev/) のような管理画面フレームワークに、
独自UIコンポーネントを組み合わせたもの** とする。すなわち、

- refineが持つ「リソース定義 + データ/認証プロバイダ抽象 + UI配線フック」に
  相当するヘッドレスなフレームワークコアを Svelte 5 + Tauri 向けに実装し、
- refineにおけるAnt Design/MUI統合の位置に、自前のグリッド/フォーム/
  チャート/ドッキングを置く。

Skeleton / Flowbite は引き続き基本コンポーネント（ボタン・モーダル等）として
併用する前提。本フレームワークはそれを置き換えるものではなく、不足領域を
補完する専用パッケージ群とする。

さらに、これらのパッケージを組み合わせた **Tauri v2 + SvelteKit
（ルーティング使用）の管理画面テンプレートアプリ** を最終成果物として提供し、
新規プロジェクトの開始点（`my-template`の本体）とする。テンプレートは
オプションで組み込みWebサーバ（11章）を持ち、有効化すると同一LAN内の
他端末からブラウザでも同じ画面を利用できる。

本リポジトリは「フロントUIライブラリ集」ではなく、**Rustバックエンド
（サービス層・ストレージ・組み込みサーバ）まで含むTauriフルスタック
テンプレート**として位置づける。標準の永続化は、アプリ本体の設定が
ローカルSQLite、業務データが外部PostgreSQL（TimescaleDB拡張を含む）の
2系統とする（12章）。

## 2. スコープ

### 2.1 対象パッケージ

| パッケージ | 内容 |
|---|---|
| `@banto/admin-core` | refineライクなフレームワークコア（リソース定義・データ/認証プロバイダ・Runesコンポーザブル） |
| `@banto/grid-svelte` | Svelte 5 (Runes) 向けグリッドUI実装。ヘッドレスロジックは同パッケージ内 `src/core/` に内包（独立した `grid-core` パッケージは作らない — §14 決着） |
| `@banto/dock-svelte` | Svelte 5向けドッキングUI実装。レイアウトエンジン（ヘッドレス）は同パッケージ内 `src/core/` に内包（独立した `dock-core` パッケージは作らない — §14 に準ずる） |
| `@banto/charts` | SVG/Canvasフルスクラッチのチャートコンポーネント群 |
| `@banto/forms` | スキーマ駆動フォーム（定義オブジェクトからUI+バリデーション自動生成） |
| `@banto/theme` | Tailwind前提のデフォルトテーマ + CSS変数によるカスタマイズ層 |
| `crates/banto-core` | Rust: リソースサービス/リポジトリtrait、ソート/フィルタ/ページングのパラメータ型、エラー型 |
| `crates/banto-storage` | Rust: sqlxベースのリポジトリ実装。**SQLite/PostgreSQL 両対応**（接続ヘルパ・方言別マイグレーション・`Db`/`Dialect` 方言吸収、V2 テーマAで app 全体対応。既定は SQLite）。TimescaleDB の hypertable / `time_bucket` 集計は実需時に着手（§12.1 実装状況の注記） |
| `crates/banto-admin-services` | Rust: 汎用サービス層（設定/監査/RBAC・ユーザー/バックアップ）。V2 テーマC で `admin-template-core` から移設 |
| `crates/banto-server` | Rust: 組み込みaxumサーバ（REST・認証・静的配信、11章）+ 汎用 REST ルーター（`routes/`、V2 テーマC で移設） |
| `apps/admin-template` | 上記全パッケージ+クレートを配線したTauri v2 + SvelteKit管理画面テンプレート |

> **オプション拡張パッケージ（v1後に追加、M19〜M21）**: 上表はv1コアの対象
> パッケージ。以降のマイルストーンで `@banto/report`（M19）・
> `@banto/attachments` + `crates/banto-attachments`（M20）・`@banto/scan-wedge`
> （M21）を「独立パッケージ + 削除可能デモ」方式で追加済み。現行の完全な
> パッケージ一覧は [README](../README.md) と
> [template-scope.md](template-scope.md) を参照（本仕様は設計の基準線として
> v1スコープを保持する）。

- **2層の使い方を保証する**: 各UIコンポーネント（グリッド/フォーム/チャート/
  ドッキング）は`admin-core`を知らなくても単体ライブラリとして使える。
  `admin-core`と組み合わせたときはリソース定義からの自動配線
  （refinesの`useTable`/`useForm`相当）が効く。
- **ヘッドレス/UI分離**にする理由: グリッド・ドッキングともにロジックが複雑で、
  将来的な移植性（他フレームワーク対応やテスト容易性）を確保するため。
  ただし最初のターゲットはSvelte 5のみとし、分離は「やりすぎない」範囲に留める
  （分離のための抽象化コストが要件を上回らないように、まずは`grid-svelte`内に
  ロジックを書き、肥大化してきたら`grid-core`に切り出す方針でも可）。
- モノレポ構成（pnpm workspace + cargo workspace）で管理し、npm側の各
  パッケージは将来的に個別に`npm publish`可能な状態にする。npmパッケージ群は
  Rust側なしでも単体利用できるが、テンプレートとしての価値は「スキーマ/
  リソース定義 → フロントUI → Rustサービス層 → DB」が貫通していることに
  置く。

### 2.2 非対象（v1では扱わない）

- リッチテキストエディタ
- 複数ネイティブウィンドウ間のレイアウト自動連携（単一パネルのウィンドウ
  分離は §5.3 で実装済み。複数ウィンドウ間の状態同期は引き続き非対象）
- 3D描画・地図・ネットワーク図などの高度な可視化（チャートは6章の種別に限定）
- ドラッグ&ドロップのフォームビルダーGUI（フォームは7章のスキーマ駆動のみ）

## 3. フレームワークコア仕様（@banto/admin-core）

refineの設計をSvelte 5 + Tauriに翻訳したヘッドレス層。UIには一切依存しない。

### 3.1 リソース定義

管理対象のエンティティを「リソース」として宣言的に登録する。

```ts
defineResource({
  name: 'items',
  label: '商品',
  icon: ...,
  schema: itemFormSchema,        // 7章のフォームスキーマを共有
  columns: itemGridColumns,      // 4章のグリッド列定義（省略時はschemaから導出）
  capabilities: { list: true, show: true, create: true, edit: true, delete: true },
})
```

- リソース登録から、テンプレートアプリのナビゲーション項目・ルート・
  CRUDページが規約ベースで導出される（refineの`resources`プロップ相当）。
- `schema`から`columns`を自動導出できるようにし、「スキーマを1つ書けば
  一覧と編集フォームが両方生える」体験を最重要ゴールとする。
  → **実装済み（2026-07-19、M23）**: `@banto/grid-svelte` の
  `columnsFromSchema(schema, { overrides })`（`src/core/schema.ts`）。
  フォームと同一のルール・同一メッセージのバリデータ込みで列を導出し、
  幅・フォーマット等は `overrides` で微調整する。items 一覧
  （`routes/(app)/items/+page.svelte`）が利用手本。

### 3.2 データプロバイダ

refineの`dataProvider`に相当するCRUD抽象。バックエンドを差し替え可能にする。

```ts
interface DataProvider {
  getList(resource, { pagination, sort, filters }): Promise<{ rows, totalCount }>
  getOne(resource, id): Promise<TRow>
  create(resource, values): Promise<TRow>
  update(resource, id, values): Promise<TRow>
  deleteOne(resource, id): Promise<void>
  custom?(...): Promise<unknown>   // 任意コマンドのエスケープハッチ
}
```

- **標準実装 `TauriDataProvider`**: コマンド命名規約（例:
  `items_list` / `items_get` / `items_create` ...）で Tauri `invoke()` に
  マップする。規約はオーバーライド可能。
- **`InMemoryDataProvider`**: プレイグラウンド・テスト・モック用。
- **`HttpDataProvider`**: 組み込みWebサーバ（11章）経由のブラウザアクセス用。
  REST APIのエンドポイントと本インターフェースを1:1対応させる。
- グリッドのサーバーモード（4.1節）の`fetchRows`は`getList`の薄いラッパと
  して実装し、抽象を二重に持たない。リソース単位のソート/フィルタ/
  ページング条件型もここで一元定義する。

### 3.3 認証プロバイダ

refineの`authProvider`に相当。

```ts
interface AuthProvider {
  login(params): Promise<AuthResult>
  logout(): Promise<void>
  resolve(options?): Promise<ResolvedAuth>   // 1 往復でセッションを答える（v2.0.0。旧 check/getIdentity）
  credentialRevision(): CredentialRevision   // 資格情報の revision（不透明、等値比較だけ）
  onCredentialChanged(listener): () => void  // 資格情報の変化の通知
}
```

- テンプレートアプリの認証ガード（9.1節）は SessionController
  （`resolveSettled()`）でセッションを確定するだけにし、認証方式（ローカル
  認証/外部API/OS資格情報ストア）はプロバイダ実装の差し替えで対応する。
  2026-09-30（v2.0.0、Issue #260）: `check()`/`getIdentity()` は契約から外れ、
  `resolve()` の 1 往復に置き換わった（`onError` は未実装のまま）。詳細は
  [session-controller-design.md](design/session-controller-design.md) §5.2 と
  [ADR-0016](adr/0016-session-controller-single-writer.md)。

### 3.4 コンポーザブル（Runesベース）

refineのhooks（`useTable`/`useForm`/`useShow`...）に相当する配線層。

- `createListResource(name)` → グリッドにそのまま渡せるリアクティブ状態
  （rows・ソート/フィルタ/ページング状態・ローディング・再取得）。
- `createFormResource(name, id?)` → フォームスキーマ+初期値ロード+
  submit時のcreate/update呼び分け+サーバーエラー差し戻し。
- `createShowResource(name, id)` → 単一レコードの取得と購読。
- `invalidate(resource)` → 変更後の一覧再取得などのキャッシュ無効化。
- 通知抽象（`NotificationProvider`）: 成功/失敗トーストの発火先を差し込み
  可能にする（Skeleton/Flowbiteのtoastにも接続できる）。

### 3.5 イベント配信（EventProvider）

サーバ→クライアントの変更通知（リアルタイム更新）を扱うトランスポート抽象。

```ts
interface EventProvider {
  subscribe(topic: string, handler: (event: AppEvent) => void): Unsubscribe
}
```

- 配信するイベントは2種に限定する:
  - **リソース変更イベント**: 他クライアントの書き込み等。受信すると
    コンポーザブル（3.4節）が該当リソースの`invalidate`を自動発火する。
  - **サーバ発の通知イベント**: バックグラウンド処理の完了・警告等。
    `NotificationProvider`経由でトースト表示に接続する。
- 実装は環境ごとに差し替える（`DataProvider`と同じパターン）:
  - **`TauriEventProvider`**: Webview内。Tauriイベントを使用し、
    ネットワークを介さない。
  - **`SseEventProvider`**: リモートブラウザ。組み込みWebサーバ（11章）の
    SSEエンドポイントを購読する。認証トークン・ポートはREST APIと共用。
- 双方向通信が必要になった時点でSSEをWebSocketに格上げする
  （`EventProvider`のインターフェースは変えない）。
- MQTT（over WebSocket含む）やQUIC/WebTransportは、UIへの配信
  トランスポートとしては採用しない。対象環境（OS標準Webview+LAN内
  ブラウザ）での互換性が揃わないこと、ブローカー等の追加構成に見合う
  リターンがないことが理由。MQTTはデバイスデータの取り込み経路
  （12.4節）としてのみ扱う。

### 3.6 refineとの主な相違点

- React非依存。Svelte 5 Runesベースで実装する。
- デフォルトのバックエンドはHTTP REST/GraphQLではなく **Tauri `invoke()`
  （ローカルRust）**。
- UI統合はAntD/MUI等のラップではなく、本フレームワーク自前のグリッド/
  フォーム/チャート/ドッキング。
- i18n/アクセスコントロール等のrefine周辺機能はv1では最小限
  （文言差し込みのみ）とし、必要になったら追加する。

## 4. データグリッド仕様

### 4.1 データモデル

- TypeScriptジェネリクスで行データ型 `TRow` を受け取る（`GridColumn<TRow>` 等）。
- 列定義: `id`, `accessor` (key or 関数), `header`, `width`, `minWidth`, `maxWidth`,
  `resizable`, `sortable`, `filterable`, `pinned: 'left' | 'right' | false`,
  `visible`, `editor`, `cellRenderer`, `headerRenderer`。
- データソースは以下2モードを共通インターフェースでサポート:
  - **クライアントモード**: 全件配列を受け取り、フロント側でソート/フィルタ/
    グルーピング/ページングを行う。
  - **サーバーモード**: `fetchRows(params: { sort, filters, groupBy, range })
    => Promise<{ rows, totalCount }>` のようなコールバックを渡す。
    `admin-core`と併用する場合は`DataProvider.getList`（3.2節）が
    この実体となる。カーソルベース/オフセットベース両対応。
    `WindowedListResource.refresh()` は再取得中に現在の行と件数を保持し、
    同じ取得世代の処理中ブロックが完了した時点で新しい疎配列・件数へまとめて
    切り替える。途中の空配列で編集対象が消えたと誤判定されることを防ぐ。
    失敗したブロックは未取得として扱い、旧世代の行を混ぜない。
    ソート・フィルタ変更では従来どおり古い条件の行を直ちに破棄する。
    失敗はブロック単位で持ち（`failures`。`SnapshotListResource` と同じ形で、
    後述）、別のブロックの成功では消さない。`refresh()` の間も失敗は残り、
    取り直しが済んだブロックから更新される（行の保持とは別に、落ち着く前でも
    更新する）。取得世代に総件数がまだ無い間は、表示範囲が
    空（`{0, 0}`）でも `setParams()`/`refresh()` が先頭ブロックを取りに行き、
    応答しない要求は `requestTimeoutMs`（既定 30 秒）で失敗にする（Issue #243）。
    サーバー側は `ORDER BY` の最後に一意キーを足して並びを一意にする
    （conventions §6）。同順位の行の並び（一意キー `id` を最後の並べ替えと同じ
    向きで、並べ替え無しは `id` の昇順、NULL は最後。未知の列は向きを決める前に
    除く）は、SQL・InMemory・クライアントモードの並べ替えで共通で、モードを
    切り替えても変わらない
    （クライアントモードの並べ替え無しだけは受け取った配列の順）。新しい順の
    一覧では、同じ時刻の行も新しい（`id` の大きい）ものが先に来る。取得の合間の行の増減を吸収する世代の境界
    （スナップショット）は `getList` の API 変更を伴うため `WindowedListResource`
    には持たない。
    **通知なしに行が増減する一覧**（監査ログ）は `SnapshotListResource`
    （`createSnapshotListResource(fetcher, options)`、Issue #248、
    [ADR-0015](adr/0015-snapshot-list-resource.md)）で読む。取得関数を注入で
    受け取り（`getList` は変えない）、世代の最初の応答が返した境界 `asOfId` を
    固定して後続のブロックに渡す（ブロックの合間に行が追加されても重複・欠落
    しない）。境界が決まるまで要求は 1 本だけ。同じ境界で総件数か削除の世代
    （応答の任意の `deletionEpoch`。サーバーが削除と同じトランザクションで進める）が
    世代の最初と違う応答は採らず、その世代では続きを読まない（`expired`）。境界
    だけでは集合は固定されない（削除で減り、PostgreSQL では小さい `id` の遅れた
    コミットで増える。両方が同じ件数で重なると件数だけでは見逃すので削除の世代で
    検出する。SQLite は書き込みが 1 本ずつで遅れたコミットが無い）。
    `refresh()` が新しい世代を始め、処理中の要求は中断する（応答しない要求が
    あっても押せる）。`totalCount` は未取得のあいだ `null` で、「未取得」
    「取得失敗」「正常な 0 件」を画面が区別できる。失敗をブロック単位で持つ・
    `{0, 0}` から回復する・`requestTimeoutMs` の期限・世代の違う応答を捨てる、は
    `WindowedListResource` と同じ。サーバー側の決まりは conventions §6。
    失敗は `failures`（ブロック順、ブロックごとに 1 件。`{ block, kind: 'error',
    code, error }` か `{ block, kind: 'expired' }`）で出し、種類はコード
    （`'request'`・`'timeout'`・`'boundaryMismatch'`・`'malformed'`）で見分ける
    （文言を比べない）。取得関数が投げた `ProviderError` は同じオブジェクトのまま
    入り（`'request'`）、リソースが自分で作る失敗は `ListBlockError`（`code`
    付き）。その文言は `messages`（`timeout(ms)`・`boundaryMismatch()`・
    `malformed()`、レイヤ①の注入。既定は英語）で差し替え、失敗ごとのトーストは
    `notify`（既定 `true`・`false`・述語）で止められる（Issue #342、ADR-0015 の
    追記）。`WindowedListResource` の失敗も同じ形（Issue #344、ADR-0015 の
    2026-10-07 の追記）: `failures`（`{ block, kind: 'error', code, error }`、
    失効は無い）、コードは共通の `ListBlockFailureCode`（`'boundaryMismatch'` は
    作らない）、`getList` が投げた `ProviderError` は同じオブジェクトのまま、
    `messages`（`timeout(ms)`・`malformed()`）と `notify`。エラーの型
    `ListBlockError`・`isListBlockError` は両リソースで共通。
  - データ規模が「まだ未定/ケースによる」とのことなので、**両モードを同一API
    表面で切り替え可能**にすることを必須要件とする。閾値判断（例: 1万行を
    超えたらサーバーモード推奨、など）はドキュメントでガイドラインを示す。

### 4.2 仮想化 (Virtualization)

- 行の仮想スクロールを標準搭載（可変行高対応、`ResizeObserver`ベース）。
- 列の仮想スクロールもオプションで対応（列数が非常に多いケース向け、v1では
  優先度低）。
- 目標性能: クライアントモードで1万行・20列を60fpsでスクロール可能。

### 4.3 ソート・フィルタ・グルーピング

- **ソート**: 複数列ソート（Shift+クリックで追加）、カスタム比較関数対応。
- **フィルタ**: 列単位フィルタ（テキスト/数値範囲/日付範囲/セレクト）+
  グローバル検索。フィルタUIはヘッダーにポップオーバーで表示。
  組み込みの条件選択・値入力には個別の名前を付け、開閉ボタンは展開状態と一意な dialog ID を参照する。
  開くと値入力へ移り、内部の Escape・適用・クリア後は開閉ボタンへ戻る。
  非modalとして Tab の標準移動を維持し、外クリックや外へ移動済みのフォーカスを取り戻さない。
  空値の適用は条件解除として扱う。数値入力の空欄も解除し、数値 `0` は有効な値とする。
  変換中（`isComposing` / `keyCode === 229`）・処理済みの Enter / Escape は適用・閉じる処理へ渡さない。
  適用済みは開閉ボタンの二重下線と列固有の説明で示し、色だけに依存しない。
  ボタン幅は変えず、説明参照は適用中だけ付ける。開閉の `aria-expanded` と適用状態は独立する。
- **グルーピング**: 指定列でのグループ化、グループ行の折りたたみ、
  グループごとの集計（sum/avg/count/customAggregator）。
- クライアント/サーバー両モードで同じ設定オブジェクト（`SortState[]`,
  `FilterState[]`, `GroupState`）を使い回せるようにする。

### 4.4 列の操作性

- 列幅リサイズ（ドラッグ、ダブルクリックでオートフィット）。
- 列の並び替え（ドラッグ&ドロップ）。
- 列の固定（左右ピン留め）。
- 列の表示/非表示切り替え（列マネージャーUI）。
- レイアウト（列幅・順序・表示状態・ソート/フィルタ状態）の永続化用
  `serialize()/deserialize()` API を提供し、保存先（localStorage / Tauriの
  ファイルシステム経由で設定ファイルに保存 等）はアプリ側に委ねる。

### 4.5 セル編集

- インライン編集（ダブルクリック or Enterで開始、Escでキャンセル、
  Tab/Shift+Tabで確定して右/左へ、Enterで確定して下へ移動）。
- Enter・Tab/Shift+Tabによる確定、Escapeによる取消後はグリッド本体へ
  フォーカスを戻し、矢印キーやF2で続けて操作できること。保存待ち中に別の要素へ移動した場合や後続編集を
  始めた場合は、そのフォーカス・選択を優先する。保存エラー時は入力を保持し、
  編集を続けている場合だけエディタへフォーカスを戻す。
- 組み込みエディタ: テキスト、数値、日付、セレクト、チェックボックス。
  カスタムエディタをプラグイン可能。
- 変換中（`isComposing` / `keyCode === 229`）・処理済み（`defaultPrevented`）の keydown は
  保存・取消・セル移動を起こさず、グリッド本体への伝播も止める。pending 中の操作抑止・blur 確定は維持する。
  変換中の Tab が標準動作で blur を起こす場合を含め、blur からの保存は従来どおりとする。
- バリデーション: 列単位のバリデータ関数、セルの強調と全文を読めるエラー領域を表示する。
  エラー領域は scrollport の兄弟に重ね、表の寸法・仮想化・editor DOM を変えずに可視範囲へ収める。
  右端・下端では折返しと上下切替、極長文は領域内の標準スクロールで読む（ADR-0027）。
  Enter の失敗では入力へ残り、エラー中の Tab / Shift+Tab は再送信せずエラー領域へ移る。
  入力変更後も既存エラーがある場合は Enter で明示的に再試行する。
  エラーなしの Tab 確定が失敗した時も、同じ session とフォーカス所有権が残る場合だけ領域へ移す。
  領域内の Shift+Tab / Escape は保存・取消せず入力へ戻り、Tab は標準順序で次の操作要素へ進む。
  入力から領域への移動では blur 確定を抑止し、API 保存の二重送信を防ぐ。
- 組み込み editor の名前は列見出し（空白時は列 ID）とし、`aria-invalid` と
  グリッド単位で一意なエラー ID への `aria-describedby` を設定する。エラー解除時は参照も外す。
  保存待ちは編集中セルの `aria-busy` で示し、フォーカスや保存処理の契約は維持する。
  checkbox editor は共通の `--banto-checkbox-size`（fallback `1.1rem`）を使い、セル全体へ引き伸ばさない。
- Excelライクな範囲選択・コピー&ペースト（TSV/CSV形式でクリップボード
  連携）、非編集時のセル間移動は矢印キーで行う。
- 全編集列を送る商品デモでは、更新APIの返却行を所有する一覧へ行IDで反映してから
  無効化・再取得し、保存完了をグリッドへ返す。再取得前の次の編集でも保存済みの列を
  保持すること。一括貼り付けの部分成功も同様。既に除外された行は再挿入しない。
- 非編集時の Tab/Shift+Tab はセル選択を変えず、ブラウザー標準のフォーカス順で
  次/前の操作要素へ移る。グリッド内の見出しボタンや行リンクも順序に含め、
  Tabだけでグリッド外の操作要素へ離脱・再入場できるようにする。
  セル操作のキー処理はグリッド本体にフォーカスがある場合に限定し、見出し・
  絞り込み入力・行リンクのキー操作はそれぞれの要素に任せる。
  絞り込み入力の矢印・Home/Endは文字カーソル移動、Tab/Shift+Tabは条件欄・入力欄・
  ボタン間の標準フォーカス移動として扱う。値入力欄のEnterは条件適用だけを行い、保持中の
  セル選択をキー操作で動かしたり、セルエディタを開いたりしない。
- 編集確定時のコールバック (`onCellEdit`) で呼び出し元（Rust連携含む）に
  変更を通知。楽観的更新 or 確定待ちの両モードをサポート。

### 4.6 行操作

- 単一/複数選択（チェックボックス列 or 行クリック、Shift/Ctrl修飾）。
- 行の展開/折りたたみ（ツリーデータ/親子行対応）。
- 行の右クリックコンテキストメニュー拡張ポイント。

### 4.7 アクセシビリティ

- WAI-ARIA `grid` パターンに準拠（`role="grid"`, `row`, `gridcell`,
  `aria-sort`, `aria-selected` 等）。
- キーボードのみでの全操作（フォーカス移動、編集、選択、ソート）。
- グリッド入口・見出し・フィルタ操作子は実線のフォーカス枠を使う。
  強制配色では範囲選択に内側の破線を加え、active セルの実線と区別する。

## 5. フローティングウィンドウ / ドッキングレイアウトシステム仕様

VSCode/Rider等のエディタに近い、本格的なドッキング・タブ化レイアウトシステムを
実装する。

### 5.1 レイアウトモデル

- ツリー構造: `Layout` は `Panel`（実際のコンテンツ）と `Split`
  （水平/垂直分割コンテナ）と `TabGroup`（タブでまとめられた複数Panel）の
  再帰的な組み合わせで表現する。
- 各`Panel`は一意なID、タイトル、アイコン、コンテンツ（Svelteコンポーネント
  + props）を持つ。
- レイアウト全体をJSONにシリアライズ/デシリアライズ可能にし、Tauriの
  ファイルシステムAPI経由でウィンドウレイアウトの保存・復元をアプリ側で
  実装できるようにする（本パッケージはシリアライズ形式のみ提供し、
  永続化手段はアプリ側に委ねる）。

### 5.2 操作性

- パネルタブをドラッグして: 別グループにタブとして追加/画面端・グループ端
  にドロップして分割（上下左右スナップ）/独立フローティングウィンドウ化。
- フローティング状態のパネルは自由な位置・サイズ変更が可能（ブラウザ内の
  疑似ウィンドウとしてabsolute配置、Tauriのネイティブウィンドウは使わない
  ことをv1のデフォルトとする）。
- ドラッグ中のドロップ位置プレビュー（スナップガイド表示）。
- タブの並び替え、タブのクローズ、タブグループ全体のクローズ。
- 最小化的な挙動（パネルをサイドバーにしまう）はv1では非対応、v2以降で検討。

### 5.3 Tauriネイティブウィンドウとの関係（実装済み）

- 既定: すべて単一のWebview内で完結する「疑似ウィンドウ」として実装
  （実装コストと確実性を優先）。§5.2 のフローティングはこの疑似ウィンドウ。
- **「ウィンドウ分離」モード（実装済み）**: フローティングパネルを実際の
  Tauri `WebviewWindow` として切り出す。`@banto/dock-svelte` は `onPopOut`
  拡張ポイントを提供し、`admin-template` がそれを薄い Tauri コマンド
  `panel_open`（`apps/admin-template/src-tauri/src/lib.rs`）に配線して、
  ドックのパネルをネイティブウィンドウ（`routes/panel/[id]`）として開く。
  ウィンドウが閉じられると `banto://panel-closed` を emit し、パネルを
  ドックへ復帰させる。フロント側の配線は
  `apps/admin-template/src/lib/banto/popout.ts`（`openPanelWindow` /
  `listenPanelClosed`）。いずれも `isTauri()` ガード付きで、ブラウザ配信では
  ポップアウトボタン自体が描画されない（`onPopOut` が未配線）ため、
  両経路対称の不変条件を破らない。

## 6. チャート / グラフ仕様

依存ライブラリを使わず、SVG（+必要に応じてCanvas）でフルスクラッチ実装する。
自由度は最大だが工数も大きいため、種別と機能を明確に限定する。

### 6.1 対応チャート種別

- **v1**: 折れ線（line/area）、棒（縦/横、積み上げ対応）、円/ドーナツ、
  散布図、スパークライン（グリッドのセル内埋め込み用ミニチャート）
- ~~**v2以降**: 複合チャート（棒+折れ線）、レーダー、ヒートマップ、
  ゲージ/KPIタイル~~ → **実装済み（M13/M22）**。上記に加え複合（棒+折れ線）・
  レーダー・ヒートマップ・ゲージ、SPC系（ヒストグラム・パレート図・箱ひげ図）。
- **M24 追加**: 積立エリア（`StackedAreaChart` — 積立折れ線。積立棒は v1 から
  `BarChart` の `stacked`）、ガントチャート（`GanttChart`。時間軸バー、進捗・
  「今日」マーカー、依存線は非スコープ）。以上で全14種
  （`packages/charts/src/*.svelte`、README「主な機能」）。

### 6.2 共通アーキテクチャ

- スケール/軸計算・レイアウトなどの数値ロジックは純TypeScriptの
  `charts/core`層に置き、描画層（Svelteコンポーネント→SVG）と分離する。
  Vitestで数値ロジックを単体テスト可能にする。
- 描画はSVGを基本とし、大量データ（例: 折れ線1万点以上）の場合のみ
  Canvasレンダラに切り替えられる構造にする（v1はSVGのみでも可、
  切り替えポイントだけ設計しておく）。
- レスポンシブ: `ResizeObserver`でコンテナ追従。ドッキングパネル内・
  グリッドセル内での利用を最初から想定する。

### 6.3 共通機能

- 軸（数値/時間/カテゴリ）、目盛り自動計算、凡例、ツールチップ、
  ホバーハイライト。
- カラーパレット・フォント等は`@banto/theme`のCSS変数に従う
  （ダーク/ライト切替に自動追従）。
- データ形式はグリッドと共通の「行の配列 + accessor」スタイルにし、
  グリッドに表示中のデータをそのままチャートに渡せるようにする。
  `admin-core`の`createListResource`の結果もそのまま渡せる。
- アニメーションはv1では最小限（初回描画のトランジション程度）。
- SVGのエクスポート（SVG保存）は**実装済み（M13）**
  （`packages/charts/src/core/export.ts` の `serializeChartSvg`/`downloadSvg`）。
  PNG 保存はブラウザAPI依存のためバックログ（roadmap M13 決定）。

### 6.4 デザインルール（v1）

チャート実装が「spec §6 rule N」形式で引く番号付き規約。M13 実装時に運用されて
いた一覧の正準版（2026-08-13 に実装コメントから逆復元して本節に収載。経緯は
[maintenance-review-2026-08.md §2.2](reviews/maintenance-review-2026-08.md)）。
新規コード・コメントは本節の番号を引くこと。

1. **色スロット固定**: 系列は series index 順に `--banto-chart-1..8` を固定使用。
   循環・再割当しない（色はエンティティ=呼び出し側配列の位置に従う）。欠損・
   不正値は「スロットを維持したままゼロ扱い/スキップ」し後続系列の色をずらさない。
   9系列以上は v1 スコープ外（最終スロットへクランプ。折り返すと別系列が同色に
   エイリアスするため）。
2. **値軸は1本**: 1チャートの値軸は単一（Combo でもバーと線が同一スケールを共有）。
   二軸チャートは v1 スコープ外。
3. **マーク形状とヒット領域**: バーの角丸はデータ端のみ 4px（ベースライン側は
   直角）。ホバー対象は 8px 以上を確保する。
4. **非データ要素は退行的**: グリッド線・目盛はヘアラインで控えめに。系列の
   同一性は凡例のスウォッチ色が担う（テキストではなく）。
5. **凡例は2系列以上のみ**表示する。
6. **ツールチップ**: 共有 HTML ツールチップ（absolute 配置の div、行モデルは
   `TooltipRow`）。Sparkline はツールチップ対象外。
7. **軸アルゴリズム**: nice ticks（1/2/5×10^n）。バー系の値軸は必ず 0 を含む
   （切り詰めない）。
8. **アクセシビリティ**: ルートは `role="img"` + 必須 `label`。Sparkline は
   装飾的グラフィックとして例外（`aria-hidden`）。
9. **量のエンコード**: ヒートマップ等の「量」は単色相の明度ランプ
   （`SEQ_RAMP`）で表し、カテゴリ色スロットを流用しない（量はカテゴリではない）。
10. **ステータス色**: ゲージの帯色はテーマのステータス変数を使う（系列色を
    使わない）。

> 番号の正規化: 本節整備前のコメントに別系列の番号（「§6.1 design rule 1」=
> 本節 rule 2、「design rule 5」= rule 9、「design rule 6」= rule 10）が
> 存在したため、該当コメントは本節の番号へ正規化済み。

## 7. 汎用フォーム仕様（スキーマ駆動）

### 7.1 コンセプト

フィールド定義オブジェクト（スキーマ）から、フォームUI・バリデーション・
値の状態管理を自動生成する。CRUD管理画面の詳細/編集ページを最小コードで
作れることを最優先とする。スキーマはリソース定義（3.1節）と共有され、
「スキーマを1つ書けばグリッド列とフォームが両方生える」体験を支える。

### 7.2 スキーマ定義

- 独自のフィールド定義型を第一級とする:
  `{ name, label, type, required, default, options, validate, visible, ... }`
- `type`: text / textarea / number / date / datetime / select /
  multiselect / checkbox / radio / switch / file など。
  カスタムフィールドタイプの登録機構を持つ。
- バリデーション: フィールド単位のルール（required/min/max/pattern/
  カスタム関数）+ フォーム横断バリデーション。エラーメッセージは
  i18n差し込み可能。
- Zod/Valibot等の外部スキーマからの変換アダプタは任意のオプション
  として提供（コアは依存しない）。Rust側の型と揃える場合は10章の
  型生成方針と合わせて検討する。

### 7.3 挙動

- 設定スイッチは theme の opt-in スタイルを使い、native checked / disabled・ラベル・Space 操作を保つ。
  forms と列表示メニューの checkbox は共通寸法・実線フォーカス・無効状態の減光を揃える（ADR-0026）。
- 設定のパスワード変更は新パスワード・確認欄の入力を未保存として保護する。
  現在のパスワードのみ（手入力・自動入力とも）は本人確認情報であり、未保存の変更には数えない。
  保存中の離脱保護・失敗時の入力保持・破棄/成功時の解除は維持する。
- 入力・ネイティブ select の背景は既定で透明とし、hover / readonly でも塗りを加えない（ADR-0025）。
- `BantoForm` の `appearance` は `default`（省略時）/ `underline`。下線型は対応版 theme CSS が必要で、
  全ラベルを通常フローで入力の上に置き、checkbox はネイティブの形を使う（ADR-0024・ADR-0026）。
- 値・dirty・touched・エラーをRunesベースのフォームストアで一元管理。
- `BantoForm` の入力・エラーにはフォームごとに一意な DOM ID を割り当て、ラベルとエラー文を
  入力へ関連付ける。項目名は store / 送信データのキーとして維持する。
- text / password / textarea / number / date（および `DraftNumberField`）の readonly は
  フォーカス可能なネイティブ属性で表し、disabled と区別する。select / checkbox は readonly を
  持たないため disabled の表示を維持する。readonly 値も検証・送信対象であり、認可の代わりにはしない。
- 送信時は`onSubmit(values)`でTauri `invoke()`等に接続。`admin-core`併用時は
  `createFormResource`（3.4節）がcreate/update呼び分け・サーバーサイド
  エラー（Rustからのフィールド別エラー）の差し戻し表示まで配線する。
  送信中のボタン無効化に対応する。
- レイアウト: デフォルトは1カラム縦積み。セクション分け・複数カラムは
  スキーマの`layout`指定で制御。完全に手書きしたい場合は各フィールド
  コンポーネントを個別利用できるエスケープハッチを用意する。
- グリッドのセルエディタ（4.5節）とフィールドコンポーネントを共有し、
  「フォームで使える入力部品はグリッド内でも使える」状態にする。

## 8. 管理画面テンプレート（apps/admin-template）

Tauri v2 + SvelteKit（ファイルベースルーティング使用）で、全パッケージを
組み合わせた管理画面アプリの雛形。新規プロジェクトはこのテンプレートを
コピーして開始する。

### 8.1 SvelteKit構成

- `@sveltejs/adapter-static` + SPAモード（`ssr = false`）。Tauri v2は
  SSRサーバを持たないため、プリレンダリング/SPAフォールバックで構成する。
- ルーティング例:
  - `/login` — 認証画面
  - `/(app)/dashboard` — チャート+グリッドのダッシュボード
  - `/(app)/items` — CRUD一覧（グリッド）
  - `/(app)/items/[id]` — CRUD詳細/編集（スキーマ駆動フォーム）
  - `/(app)/settings` — 設定+テーマ切替
- `(app)`レイアウトグループに認証ガード（SessionController の
  `resolveSettled()` を使用、未ログインなら`/login`へリダイレクト。v2.0.0 までは
  `AuthProvider.check()`）を実装。
- リソース定義（3.1節）からナビゲーションとCRUDルートを導出する。
  SvelteKitのファイルベースルーティングとの整合方法（動的ルート
  `/(app)/[resource]` で汎用ページを受けるか、リソースごとに薄いルート
  ファイルを置く規約にするか）は未決事項（14章）。

### 8.2 含まれる雛形

- **シェルレイアウト**: サイドバー（折りたたみ可）+ ヘッダー +
  パンくず。ナビゲーション定義はリソース登録から自動生成しつつ、
  任意項目を追加できる。
- **CRUDページ雛形**: リソース定義+スキーマ → グリッド（一覧・ソート/
  フィルタ）→ フォーム（詳細/編集）→ `TauriDataProvider` → Rustサービス層
  → sqlxリポジトリ（PostgreSQL/SQLite、12章）まで貫通した実装例。
  新しいエンティティを「Rust側のサービス実装+リソース定義」だけで
  増やせる構成にする。
- **認証/ログイン雛形**: ログインフォーム + `AuthProvider`のローカル実装例
  （資格情報の保存は`keyring`系を利用。具体的な認証方式はアプリ依存のため、
  プロバイダ差し替えで対応）。
- **設定画面+テーマ切替**: ダーク/ライト/システム追従の切替、
  `@banto/theme`のCSS変数上書き例、設定の永続化
  （ローカルSQLiteの設定DB、12章）。組み込みWebサーバの有効化トグル+
  アクセスURL/QRコード表示（11.4節）。
- **ドッキングレイアウトの利用例**: ダッシュボードページでパネルの
  分割・タブ化・レイアウト保存/復元をデモする。
- **入力・ページナビの共有スタイル**: `@banto/theme/css` の opt-in クラスで
  浮動ラベル・長ラベルの固定上表示・ネイティブ select・下線型ページリンクを提供する。
  app.css / Tailwind に依存せず、値・イベント・権限・経路は利用側が管理する。
  設定・ログイン・初回セットアップ画面で利用するが、`@banto/forms` の既定表示や SCADA へは自動適用しない
  （[theme README](../packages/theme/README.md)、ADR-0023）。

## 9. 技術スタック

- Svelte 5（Runes: `$state`, `$derived`, `$effect`）
- SvelteKit（テンプレートアプリのルーティング。`adapter-static` + SPAモード）
- TypeScript strict mode
- Vite（ライブラリビルド、`vite-plugin-dts`で型定義出力）
- スタイリング: Tailwind CSS前提のデフォルトテーマを同梱しつつ、
  コンポーネントのクラスはCSS変数（`--grid-row-height`等）でも上書き可能に
  する（Tailwindを使わないプロジェクトでも見た目のカスタマイズができる
  ように、コアのスタイルはCSS変数駆動 + Tailwindユーティリティは
  オプション層として提供）。
- pnpm workspace + cargo workspace によるモノレポ管理。
- Rust側: DBアクセスはsqlx（SQLite/PostgreSQL両対応。TimescaleDBは
  PostgreSQL拡張として利用）、組み込みサーバはaxum想定（14章の未決参照）。
- テスト: Vitest（ロジック層のユニットテスト）+ Playwright
  （グリッド/ドッキングの操作系E2E、Tauriアプリではなく単体のプレイグラウンド
  アプリ上で実施）。

## 10. Rust連携方針

- フロントとRustの境界は`DataProvider`（3.2節）に集約する。標準の
  `TauriDataProvider`はコマンド命名規約で`invoke()`にマップし、Rust側には
  対応するコマンドハンドラの雛形（リソースごとのlist/get/create/update/
  deleteとソート/フィルタ/ページングパラメータのデシリアライズ）を
  テンプレートで提供する。
- Rust側は実ロジックを「サービス層」として`tauri::command`から分離して
  実装し、組み込みWebサーバ（11章）のRESTハンドラとも共有する。
  コマンドとRESTはいずれもサービス層を呼ぶ薄いアダプタに徹し、
  ロジックの二重実装を禁止する。
- サービス層の下はリポジトリtraitで抽象化し、sqlx実装で
  SQLite/PostgreSQL（TimescaleDB含む）を切り替える（12章）。
- v1時点ではデータ規模・取得方法が未確定のため、グリッド単体利用時の
  APIは「同期配列」と「非同期フェッチコールバック」の両方を第一級で
  サポートする抽象データソースインターフェースとして設計する。
- Tauri `invoke()` を使う場合の型安全性確保のため、Rust側のコマンド戻り値の
  型とフロント側の`TRow`型を一致させるための型生成方針（例:
  `specta` / `tauri-specta` の利用検討）を別途決める。
- 大規模データが判明した場合に備え、`getList`のAPIは最初から
  「範囲指定（offset/limit or cursor）」「ソート/フィルタ条件の受け渡し」を
  前提にした形にしておく（後からの後方互換破壊を避ける）。

## 11. 組み込みWebサーバ / リモートアクセス

デスクトップアプリのRustプロセス内にHTTPサーバを内包し、同一LAN内の
他端末からブラウザで同じ管理画面にアクセスできるようにする。
**デフォルトは無効（`invoke()`専用、攻撃面ゼロ）とし、設定画面からの
オプトインで有効化する**付加機能とする。別ウィンドウ操作（複数
ウィンドウ間のレイアウト自動連携）は本章のスコープ外（単一パネルの
ウィンドウ分離は §5.3 で実装済み）。

### 11.1 アーキテクチャ

- Rustの同一プロセス内にHTTPサーバ（axum想定、フレームワーク選定は
  14章の未決参照）を`tauri::async_runtime`上で起動する。
- SvelteKit `adapter-static`のビルド成果物を`rust-embed`等でバイナリに
  埋め込み、組み込みサーバから静的配信する。**TauriのWebviewと
  リモートブラウザが同一のフロントエンドビルドを共有する。**
- フロントは起動時に実行環境を判定し（`isTauri()`: `window.__TAURI_INTERNALS__`
  があり、かつ `location.origin` が Tauri 自身のアセットの origin
  〔`http://tauri.localhost`・`https://tauri.localhost`・`tauri://localhost`、
  開発ビルドでは `tauri.conf.json` の `build.devUrl` の origin〕であること。
  Tauri の窓がローカルのサービスの `http://127.0.0.1:<port>/` へ navigate
  した場合も `__TAURI_INTERNALS__` は注入されるが、その画面は
  `HttpDataProvider` の経路にする。Issue #396）、
  Webview内なら`TauriDataProvider`、ブラウザなら`HttpDataProvider`を
  自動選択する。UI層（グリッド/フォーム/チャート/ドッキング）は
  実行環境を一切意識しない。
- REST APIは`DataProvider`（3.2節）のCRUD操作と1:1対応させる
  （例: `GET /api/{resource}` ↔ `getList`、`POST /api/{resource}` ↔
  `create`）。エンドポイントの実体は10章のサービス層。

### 11.2 セキュリティ要件

- **サーバ機能を有効化した場合、認証（3.3節`AuthProvider`）を必須**と
  する。トークンベースの認証+CSRF対策（カスタムヘッダ方式）を実装する。
- v1は「信頼できるLAN内でのHTTP + トークン認証」と割り切る。
  TLS（自己署名証明書の生成・配布）はv2以降の検討事項。
- バインドアドレス（`127.0.0.1`のみ / LAN公開）とポート番号は設定で
  変更可能にする。デフォルトはlocalhostのみ。
- すべての応答にセキュリティヘッダー（CSP・`nosniff`・frame-deny・
  `Referrer-Policy`）を最外層で付ける（`banto-server` の
  `with_security_headers`、improvements §2.4）。CSP の既定は
  `connect-src 'self'` の厳格なもので、Tauri の窓の CSP とは connect-src の
  Tauri IPC だけが違う（conventions §6、`verify-architecture.mjs` rule 12）。
- アプリ自身のデスクトップシェルが Tauri の WebView でこのサーバーの画面へ
  移る場合だけ、`with_security_headers_using` と `SecurityHeaders` で
  connect-src に `TAURI_IPC_CONNECT_SRC` を足してよい（2026-10-06 オーナー決定、
  banto-industrial#505）。広げる相手は `request_is_loopback_local`
  （TCP の接続元がループバックで、かつ宛先の `Host`／`:authority` がループバックの
  IP リテラルか `localhost`。2026-10-06 オーナー決定で `request_from_loopback_peer`
  から推奨を替えた）で選び、LAN のブラウザへの応答は厳格なままにする。広げられるのは connect-src だけ。普通のブラウザに対して
  足したものが与える範囲（`ipc:` は無効、`http://ipc.localhost` は閲覧者自身の
  ループバックの 80 番（http）と 443 番（https。CSP では http の source が
  https にも一致し、省略した port は接続先 scheme の既定 port に一致する））は
  `security_headers.rs` 冒頭の doc に記す。
  同じホストのリバースプロキシ（ADR-0003）がループバック経由でつなぐ構成では
  すべての要求がループバックからになるので、接続元だけを見る
  `request_from_loopback_peer` は LAN の閲覧者にも広げる。`request_is_loopback_local`
  は、プロキシが `Host` を保てば（Caddy の既定）LAN の閲覧者の宛先が公開名・LAN の
  アドレスになるので厳格なままにできる。プロキシが `Host` を上流のアドレスに
  書き換える構成（Caddy の `header_up Host {upstream_hostport}`、nginx の既定の
  `proxy_set_header Host $proxy_host`）では効かないので、`Host` を保たせるか、
  広げないか、プロキシで CSP を上書きする。また「`Host` を偽る相手は自分の応答の CSP を
  変えるだけ」は、共有キャッシュが `Host` をまたいで応答を使い回さない前提で成り立つ
  （例: nginx の `proxy_cache`＋`proxy_cache_valid` を明示的に有効にし、既定の
  `proxy_cache_key` が受け取った `Host` を含まない場合、`Host: 127.0.0.1` 向けに
  広がった応答が公開名の閲覧者へ返りうる。banto の静的 HTML は `Cache-Control`・`Vary`
  を付けない）。共有キャッシュを前段に置かないか、受け取った `Host` ごとに分ける
  （`proxy_cache_key` に `$host` を含める）。公開側では想定外の `Host` を拒否するか、
  プロキシで CSP を厳格な値に上書きする。`X-Forwarded-Host` などの転送ヘッダーは
  見ない。

### 11.3 マルチクライアント考慮

- 複数クライアントからの同時書き込みに備え、SQLiteはWALモード+
  書き込みの直列化で対応する（サービス層の設計時に前提とする）。
- Tauri固有API（ファイルダイアログ・ネイティブ通知等）はブラウザ側に
  存在しないため、設定保存などは`SettingsProvider`として抽象化し
  （`DataProvider`と同じパターン）、Webview/ブラウザで実装を振り分ける
  （12章）。ブラウザから利用できない機能のUIはcapability判定で自動的に
  非表示にする。
- リアルタイム同期は`EventProvider`（3.5節）で行う。組み込みサーバは
  SSEエンドポイント（`GET /api/events`等）を提供し、リソース変更・
  サーバ通知イベントをブラウザクライアントへ配信する。配信対象イベントは
  v1では最小限（リソース変更/通知の2種）に絞り、双方向が必要になった
  時点でWebSocketへ拡張する。

### 11.4 テンプレートでのUX

- 設定画面に「LANアクセスを有効にする」トグル、稼働状態、アクセスURL、
  QRコード表示を用意する。
- ポート競合時の自動フォールバックと再表示。
- Windowsファイアウォールの許可プロンプト等、OS側の挙動について
  ドキュメントを整備する。

## 12. データ永続化と状態管理の使い分け

保存先は「ローカルSQLite（アプリ設定DB）」と「外部PostgreSQL
（TimescaleDB拡張含む、業務DB）」の2系統を標準とし、フロントのSvelte
store/runesは永続化層として扱わない。

### 12.1 永続化層の役割分担

> **実装状況の注記（2026-07-18 記載 / V2 テーマAで更新）**: v1 の実装は
> SQLite のみだったが、**V2 テーマA で app 全体を PostgreSQL 上でも動かせる
> ようにした**（`banto-storage` の `Db`/`Dialect` 方言吸収・方言別
> マイグレーション・`db::init_db_from_target` の `postgres://` 経路）。既定は
> ローカル SQLite で、`BANTO_DB` を `postgres://` URL にすると PostgreSQL 経路に
> なる（同一 trait・同一サービス層）。バックアップ/リストアは SQLite 専用
> （PostgreSQL は明示エラー）。下表の TimescaleDB（hypertable・`time_bucket`
> 集計）は引き続き将来構想。

| データ | 保存先 |
|---|---|
| アプリ設定（テーマ、組み込みサーバ設定等） | ローカルSQLite設定DB（`SettingsProvider`経由） |
| UIレイアウト（グリッド列状態、ドッキングレイアウト） | 同上（リモートブラウザ利用時はクライアント側localStorage） |
| 業務データ（CRUD対象のレコード） | 外部PostgreSQL（リポジトリtrait経由） |
| 時系列データ（計測値・ログ等） | TimescaleDB（PostgreSQL拡張、hypertable） |
| 資格情報（外部DB接続情報・認証トークン） | OSキーチェーン（`keyring`）※14章の未決参照 |

- ストレージアクセスはsqlxで統一し、リポジトリtraitの実装として
  SQLite/PostgreSQLを切り替え可能にする。外部DBを持たない小規模アプリでは
  業務データもローカルSQLiteで動かせる（同一trait・同一サービス層）。
- TimescaleDBを使う場合のダッシュボード（6章チャート）向け集計クエリ
  （`time_bucket`等）の実装例をテンプレートに含める。
- 設定DB/業務DBともスキーマ管理はsqlxのマイグレーションを利用する。

### 12.2 フロント状態とDBの使い分け基準

置き場所の判断は次の3問で行う:

1. **アプリを再起動しても残る必要があるか？**
   → なければSvelteの`$state`/store（メモリのみ）。
2. **残る必要がある場合、それは「この端末の使い勝手」か「業務上の事実」か？**
   → 前者は設定DB（`SettingsProvider`）、後者は業務DB（`DataProvider`）。
3. **他のクライアントとの共有・監査・整合性が必要か？**
   → 必要なら必ず業務DB。設定DBやフロントには置かない。

原則:

- **Svelteのstore/runesは常に「一時状態」または「サーバ状態のキャッシュ」**
  であり、フロントだけが業務上の真実を持つ状態を作らない。
- サーバ状態のキャッシュは`admin-core`のコンポーザブル（3.4節）が管理し、
  変更後は`invalidate`で再取得する。手書きのグローバルstoreに業務データを
  溜め込まない。
- フォーム編集中の値はdirtyな一時状態（メモリのみ）とし、保存＝
  `DataProvider`経由の書き込みだけを永続化経路とする。下書き保存が
  必要な画面のみ、明示的な「下書き」として保存する（暗黙の自動永続化は
  しない）。

### 12.3 具体例

| 状態 | 分類 | 置き場所 |
|---|---|---|
| モーダル開閉・ホバー・選択中タブ | 一時 | コンポーネントローカルの`$state` |
| グリッドのソート/フィルタ/ページ位置 | セッション | `createListResource`（メモリ） |
| グリッドの列幅・列順・表示列 | 端末設定 | `SettingsProvider`（設定DB / localStorage） |
| ドッキングレイアウト・テーマ | 端末設定 | 同上 |
| CRUD対象レコード | 業務データ | PostgreSQL（またはローカルSQLite） |
| センサー値等の時系列データ | 業務データ | TimescaleDB |
| 認証トークン | セキュア | `keyring` / メモリ |

### 12.4 デバイスデータの取り込み（オプション・将来拡張）

センサー・設備等のデバイスデータをTimescaleDBへ取り込む経路として、
MQTT購読をオプション構成として想定する。

- 経路: デバイス群 → MQTTブローカー → Rustサービス層（`rumqttc`で購読）
  → TimescaleDBへ書き込み → `EventProvider`（3.5節）で「新データあり」を
  UIへ通知。
- **MQTTは業務データの入口、Tauriイベント/SSEはUIへの出口**として役割を
  分離する。UI層はどちらの経路にも直接依存しない。
- ブローカーは外部運用（Mosquitto等）を基本とし、アプリプロセスへの
  ブローカー組み込み（rumqttd等）は必要になった場合に検討する。
- QUICベースの独自デバイスプロトコルはスコープ外。

## 13. 非機能要件

- 対象Webview: Tauri v2が使うOS標準Webview（Windows: WebView2 / macOS:
  WKWebView / Linux: WebKitGTK）。WebKitGTKの機能制約（CSS
  `:has()`やcontainer queries等の対応状況）を考慮し、Baseline
  "Widely available" 相当の機能を優先して使う。
- i18n: 文言はコンポーネント外部から差し込み可能にする（ハードコード
  しない）。
- パフォーマンス目標: 4.2節参照。
- ライセンス: **MIT**（OSS公開を見据える）。ルートに`LICENSE`、各npm
  パッケージの`package.json`と`Cargo.toml`ワークスペースに反映済み。

## 14. 未決事項（要相談）

- [x] 名称 → **Banto（番頭）に決定**。npmスコープ`@banto`、
      Rustクレート`banto-core`/`banto-storage`/`banto-server`
- [x] ライセンス → **MIT に決定**（OSS公開を見据える）
- [x] `grid-core`/`grid-svelte` を最初から分離するか、まず`grid-svelte`単体で
      作り始めて肥大化したら切り出すか → **決着: `grid-svelte`内の`core/`に
      ヘッドレスロジックを置く形（独立した`grid-core`パッケージは作らない）
      で決着（2026-07-16 棚卸し）**
- [ ] Rust側の型生成ツール（tauri-specta等）を採用するか
- [x] ドッキングシステムの初期スコープ（5.1-5.2の全部を最初から作るか、
      「フローティングのみ→ドッキング→タブ化」の順で段階リリースするか） →
      **決着: 段階リリースを採用。M7（フローティングウィンドウのみ）→
      M8（分割・タブ化・スナップ + ダッシュボード統合）で実装済み
      （[roadmap.md](roadmap.md) M7/M8、本仕様 §5）**
- [x] CRUD雛形のRust側ストレージ → **sqlxに決定**（SQLite/PostgreSQL
      両対応、TimescaleDBはPostgreSQL拡張として利用。12章）
- [x] 認証雛形の想定方式（ローカル認証のみか、外部API連携も見せるか） →
      **決着: ローカル認証（argon2id資格情報ストア、`users.rs`）でv1決着
      （外部API/OIDC連携は非スコープのまま）（2026-07-16 棚卸し）**
- [ ] 外部DB接続情報の管理方法（`keyring`保存 vs 暗号化して設定DBに保存）
- [ ] MQTTインジェスト（12.4節）を実装するマイルストーンの位置づけ
      （テンプレートに含めるか、利用アプリ側の実装例ドキュメントに留めるか）
- [x] リソース定義からのルート導出方式（動的ルート`[resource]`で汎用ページを
      用意するか、リソースごとに薄いルートファイルを置く規約にするか） →
      **決着: `items` のルート一式をコピーして書き換える規約で確定
      （2026-07-18、手順は [docs/recipes/add-resource.md](recipes/add-resource.md)）。
      動的ルートによる自動導出は「すべては削除可能・コピーして理解できる」
      方針と相反するため採用しない**
- [x] 組み込みHTTPサーバのフレームワーク選定（axum / actix-web 等） →
      **決着: axum（`crates/banto-server/Cargo.toml`）（2026-07-16 棚卸し）**
- [x] REST APIのエラーフォーマット → **決着: 全経路（REST/Tauri）が
      `ErrorBody`（`tag="kind"` の snake_case JSON、`crates/banto-core/src/error.rs`）を
      返し、HTTP ステータスは `crates/banto-server/src/response.rs` が
      `BantoError` から決める（not_found=404 / validation=422 / bad_request=400 /
      unauthorized=401 / forbidden=403 / storage・other=500。`bad_request` は
      2026-08 追加、issue-driven）。バージョニング（`/v1` プレフィックス等）は
      単一版のため未導入のまま（外部採用者が固定 API を必要とした時点で別途）**

## 15. マイルストーン（実装済み: M0〜M9。M10 以降は roadmap.md）

> **状態（2026-08-14 追記）**: 下記 M0〜M9 は**すべて完了済み**
> （[roadmap.md](roadmap.md) §1 が完了状態を記録）。本節は初期の設計マイルストーン
> 案であり、M10 以降（RBAC・監査・バックアップ・i18n・PostgreSQL 全体対応・
> ツリービュー等）の一次情報は [roadmap.md](roadmap.md) にある。コードの
> `spec M10`〜形式の参照先も roadmap（本仕様 §15 は M0〜M9 の初期案のみ）。

テンプレートアプリを最初からプレイグラウンドとして使い、各パッケージの
開発と並走させる。

1. **M0**: モノレポ + テンプレートアプリの骨格（SvelteKit + Tauri v2 +
   シェルレイアウト + ルーティング + テーマ切替/設定画面）
2. **M1**: グリッドコア（クライアントモード、仮想スクロール、ソート/フィルタ、
   列リサイズ/並び替え）
3. **M2**: `admin-core`（リソース定義・`DataProvider`/`AuthProvider`・
   コンポーザブル）+ スキーマ駆動フォーム + CRUDページ雛形（グリッド+
   フォーム+Rustサービス層+sqlxリポジトリ（PostgreSQL/SQLite）貫通）+
   認証/ログイン雛形
4. **M3**: グリッド セル編集・範囲選択・コピペ
5. **M4**: チャートv1（折れ線/棒/円/散布図/スパークライン）+
   ダッシュボードページ
6. **M5**: グリッド サーバーモード（`getList`経由のTauri連携）、グルーピング
7. **M6**: 組み込みWebサーバ（サービス層のREST公開、静的配信、
   `HttpDataProvider`、認証のREST対応+CSRF、`SettingsProvider`抽象、
   SSEイベント配信（`EventProvider`）、設定画面トグル+URL/QR表示）
8. **M7**: ドッキングレイアウト（フローティングウィンドウのみ）
9. **M8**: ドッキング（分割・タブ化・スナップ）+ ダッシュボードへの統合
10. **M9**: テーマ層の整理、npm公開準備、テンプレートのドキュメント整備
