# Banto フロー図 — 認証・起動・開発・リソース追加

全体像は [architecture-overview.md](./architecture-overview.md)（特に §3 レイヤ・§6 典型フロー）を先に読む想定。

対象: ログイン／LAN／閲覧公開、初回起動、開発の3経路、CRUD 追加がどの層に載るかを知りたい人。

> **更新（2026-09-30）**: §2（`(app)` ガード）と §3（ログイン・ログアウト）は v2.0.0 の流れ（SessionController・`resolveSettled`・`grantFallback`・保護レイアウトの 3 本の配線、#260・[ADR-0016](./adr/0016-session-controller-single-writer.md)）で描いている。

> **更新（2026-10-04）**: §2 に起動判定が終わる前のガード（起動待ちの 503 とスプラッシュ、#321）を足した。

> **更新（2026-10-05）**: §2 の配線①に「ナビゲーションの途中では出さず、終わってから」を足した（#326）。

## 目次

1. [起動時の3環境と provider 選択](#1-起動時の3環境と-provider-選択)
2. [保護ルートへの入り方（`(app)` ガード）](#2-保護ルートへの入り方app-ガード)
3. [ログイン（資格情報 → トークン）とログアウト](#3-ログイン資格情報--トークンとログアウト)
4. [閲覧公開（合成 viewer）の位置づけ](#4-閲覧公開合成-viewer-の位置づけ)
5. [初回起動・セットアップ](#5-初回起動セットアップ)
6. [開発ループの3経路](#6-開発ループの3経路)
7. [add-resource × レイヤ対応](#7-add-resource--レイヤ対応)
8. [関連ドキュメント（リポジトリ）](#関連ドキュメントリポジトリ)

---

## 1. 起動時の3環境と provider 選択

`apps/admin-template/src/lib/banto/setup.ts` が `bantoReady` 解決時に一度だけ分岐する。

```mermaid
flowchart TD
  START["アプリ起動<br/>routes/+layout.svelte が bantoReady を待つ"]
  T{"isTauri()?"}
  E{"probeBackend()<br/>GET /api/auth/check プローブ<br/>(VITE_BANTO_DEMO ビルドは即 demo)"}
  TAURI["mode: tauri<br/>TauriDataProvider / TauriAuthProvider<br/>TauriEventProvider"]
  SERVER["mode: server<br/>HttpDataProvider / HttpAuthProvider<br/>SseEventProvider"]
  DEMO["mode: demo<br/>InMemoryDataProvider<br/>demo AuthProvider"]

  START --> T
  T -->|Yes| TAURI
  T -->|No| E
  E -->|server| SERVER
  E -->|"none（静的ホストの 404）"| DEMO
  E -->|"unreachable（例外・timeout・5xx）"| RETRY["接続できない画面<br/>自動再試行 → 再接続ボタン<br/>demo にはしない"] --> E
```

### 読み方

- **Tauri Webview** — `invoke()` のみ。`isTauri()` は `__TAURI_INTERNALS__` の有無に加えて `location.origin` が Tauri 自身のアセットの origin（`http(s)://tauri.localhost`・`tauri://localhost`、開発ビルドは `devUrl`）であることを見る。Tauri の窓がローカルのサービス（`http://127.0.0.1:<port>`）へ navigate した画面は内部オブジェクトがあっても server 経路（#396）。LAN 向け HTTP は別プロセス内の組み込みサーバ（設定で ON のとき）。
- **embedded server** — 同一オリジンの REST + SSE。`banto-serve` や LAN ブラウザもここ。
- **demo** — `VITE_BANTO_DEMO=1` ビルド（Pages 等）、または `vite preview` 等で静的ホストが「API なし」と明確に答えたとき。通信失敗は demo にせず再試行画面（#286）。InMemory + デモ認証。
- 画面コンポーネントは **mode を分岐しない**（`getDataProvider()` / `getAuthProvider()` 経由のみ）。

---

## 2. 保護ルートへの入り方（`(app)` ガード）

セッションの状態（誰がログインしているか）を書くのは **SessionController だけ**（v2.0.0、[ADR-0016](./adr/0016-session-controller-single-writer.md)。設計は [session-controller-design.md](design/session-controller-design.md) §6.1）。`(app)/+layout.ts` の `load` は `bantoReady` の後に controller で確認し、確認できた generation を返すだけで、ストアには書かない。

起動判定（§1）が終わる前に保護ルートを直接開いたとき、ガードは `bantoReady` を**待たない**（#321）。待つと初回の load が終わらず、SvelteKit はルートのレイアウト（スプラッシュ）も描かないため、サーバーに届かない間は真っ白で再接続もできなかった。代わりに、provider にもセッションにも触れる前に起動待ちの印付きの 503（`startupGate.ts` の `deferUntilStarted`、`App.Error.startupPending`）を投げる。子の load はすべて `await parent()` なので、保護画面の load とコンポーネントは動かない。ルートのレイアウトはこの印のあいだエラー画面ではなくスプラッシュ（「起動中…」→「サーバーに接続できません」＋再接続）を出し、`bantoReady` が解決し、その印を出したナビゲーションが終わってから `refreshAll()` でガードをやり直す（同じ URL が開く）。

```mermaid
flowchart TD
  GUARD["(app)/+layout.ts load"]
  READY{"起動判定は終わった?<br/>isBantoReady()"}
  DEFER["error 503（startupPending）<br/>ルートのレイアウトがスプラッシュ<br/>起動後に refreshAll() でやり直す（#321）"]
  RESOLVE["resolveSettled(controller)<br/>AuthProvider.resolve() を 1 往復<br/>superseded なら要求し直す（期限 10 秒）"]
  R1{"結果"}
  E503["error 503<br/>再試行画面（routes/+error.svelte）"]
  PVF["grantFallback(controller, provider, ticket, { kind: 'publicViewer' })<br/>status() → isCurrent(ticket) → enterGrant('publicViewer', { expectRevision })"]
  R2{"結果"}
  LOGIN["redirect /login"]
  ALLOW{"kind が publicViewer?"}
  NAV["publicNavItems 許可パスのみ<br/>それ以外は許可ルートへ redirect"]
  RET["return { sessionGeneration }<br/>（この load で確認できた generation）"]

  GUARD --> READY
  READY -->|No| DEFER
  DEFER -.->|"bantoReady 解決後"| GUARD
  READY -->|Yes| RESOLVE
  RESOLVE --> R1
  R1 -->|"unverified（500・到達不能・期限切れ）"| E503
  R1 -->|"confirmed / active"| ALLOW
  R1 -->|"confirmed / none"| PVF
  PVF --> R2
  R2 -->|unverified| E503
  R2 -->|"confirmed / none"| LOGIN
  R2 -->|"confirmed / active（公開閲覧）"| ALLOW
  ALLOW -->|Yes| NAV
  ALLOW -->|No| RET
  NAV --> RET
```

保護レイアウト（`(app)/+layout.svelte`）は controller のスナップショットを見て 3 本の配線を持つ:

```mermaid
flowchart LR
  SNAP["controller.snapshot<br/>（status・owner・generation・kind・pendingOwnerChange）"]
  W1["配線①: generation ≠ data.sessionGeneration<br/>→ refreshAll()（同じ generation に 1 回だけ。<br/>ログアウト中・ログインへの遷移中は出さない。<br/>ナビゲーションの途中は終わるまで待つ）"]
  W2["配線②: pendingOwnerChange かつ active<br/>→ 通知（'rebuild'）／通知して /login（'relogin'）<br/>→ acknowledgeOwnerChange()"]
  W3["配線③: 再 load が unverified<br/>→ 503 の再試行画面（自動では戻らない）"]
  GATE["世代ゲート<br/>data.sessionGeneration === snapshot.generation のときだけ<br/>key ブロックで子ルートを表示"]

  SNAP --> W1
  SNAP --> W2
  W1 --> W3
  SNAP --> GATE
```

### 読み方

- **`load` の副作用は controller の確認（と、`none` のときの公開閲覧の発行）だけ**。`sessionStore`（identity・role・publicViewer・authDisabled）は `controller.snapshot` からの `$derived` で、`load` の中で代入しない（`authDisabled` は `kind === 'local'`）。
- **有効トークン**があれば `resolve()` の答えで active を確定する（Remember me は HTTP 側の localStorage）。**無効・未ログイン**が確定し、かつ **閲覧公開 ON** の LAN だけ、確定した `none` の ticket に結び付けて合成 `viewer` トークンを発行する（ADR-0012）。Tauri ウィンドウと demo にはこの入口はない。
- 確認できない（サーバ到達不能・500・期限切れ）は **503 の再試行画面**（トークンは消さない — Issue #204）。発行の後の確認の失敗も 503 で、ログイン画面へは行かない。
- **「再試行」は `refreshAll()`**（controller を維持した画面内の再読込）。503 の間に確定したユーザーの変更（`pendingOwnerChange`）は、保護レイアウトが再び mount したときに通知される（S-81）。ページ全体の再読込では controller ごと作り直されるので、この通知は保証しない。
- 別タブのログイン・ログアウト（共有の Remember me トークンの `storage` イベント）で、このタブの active なセッションは **保留（unknown）** になり、generation が変わる → 配線①が再 load → 新しいユーザーで作り直す（none を経ない切り替えも拾う）。`onSessionEnded` は none への遷移だけを通知するので、保護レイアウトの再 load は配線①で行う。
- 配線①の再 load は**ナビゲーションの途中では始めない**（#326）。途中で `refreshAll()`（kit 3 で非推奨になった `invalidateAll()` から置き換え。#325）を始めると、SvelteKit はそのナビゲーションを途中で終わらせ（2.70 で確認。kit 3 でも同じ条件で待つ）（移動が失われる）、以後の `beforeNavigate`（未保存の変更の確認）を飛ばす。最初のナビゲーションが終わり（`afterNavigate`）、`navigating.to === null` になってから、そのナビゲーションの load が確定した世代と比べて古ければやり直す（`#lib/banto/navigationSettled.svelte.ts`。#321 の起動待ちのやり直しと共有）。
- SSE の失効（`401`）や他タブでのトークン消去は `connectEvents` が `controller.signal()` に変える。確認と退避（1 秒から倍々で 30 秒まで）は controller の中。
- `publicViewer` は **画面ナビの allowlist** 用。データアクセスの境界は RBAC の `viewer` ロール側。

---

## 3. ログイン（資格情報 → トークン）とログアウト

LAN / 組み込みサーバ経路の例。Tauri は同じ契約を `invoke(auth_login)`・`auth_resolve` に載せ替える（トークンではなく Rust 側のセッションのスロットと `seq`）。

```mermaid
sequenceDiagram
  participant U as 利用者
  participant LP as /login
  participant AP as HttpAuthProvider
  participant REST as REST auth ルート
  participant SC as SessionController
  participant GU as (app) ガード

  U->>LP: ユーザー名・パスワード
  LP->>AP: login(...)
  AP->>REST: POST /api/auth/login<br/>+ X-Banto-Client
  REST-->>AP: token
  AP->>AP: 開始時の revision・トークンのままなら保存（compare-and-set）
  alt 保存できた
    AP->>AP: revision +1
    AP-->>SC: onCredentialChanged()
    AP-->>LP: success
  else 別のログイン・ログアウトが先に確定（superseded）
    AP-->>LP: success: false, superseded: true（何も保存しない）
    LP->>U: 「別のセッションが先に確定しました」
  end
  LP->>GU: goto(/dashboard)
  GU->>SC: resolveSettled()
  SC->>AP: resolve()
  AP->>REST: GET /api/auth/identity（1 往復）
  REST-->>AP: identity / null
  AP-->>SC: { status, checked, current, identity }
  SC->>SC: 採用条件を満たせば commit（唯一の書き手）
  SC-->>GU: confirmed（generation）
```

ログアウト（`Header.svelte`・コマンドパレット → `#lib/banto/logout.svelte.ts`）:

```mermaid
sequenceDiagram
  participant U as 利用者
  participant LO as logoutAndLeave
  participant AP as HttpAuthProvider
  participant SC as SessionController
  participant L as (app) レイアウト（配線①）

  U->>LO: ログアウト
  Note over LO,L: この間は isLeavingForLogin() が真 → 配線①は refreshAll() を出さない
  LO->>AP: logout()
  AP->>AP: 開始時のトークンのままなら消去（compare-and-set）
  AP-->>SC: onCredentialChanged() → 保留（unknown）
  LO->>SC: resolveSettled({ cause: 'signal' })
  SC->>AP: resolve()（ログアウトの後に始めた probe だけが答えられる）
  AP-->>SC: none
  SC-->>LO: confirmed / none
  LO->>LO: goto(/login)
  Note over LO,SC: active（ログアウトが拒まれた、またはその間に別タブで B がログイン）なら /login へ行かず<br/>「ログアウトできませんでした」を通知し、終了後に配線①が作り直す。<br/>unverified なら「確認できませんでした」を通知し、配線①の再 load が 503
```

### 読み方

- 初回未初期化 DB では **setup** 画面（管理者作成）が先。initialized は `GET /api/auth/status` 等。
- HTTP リクエストは **CSRF 用カスタムヘッダ** + **Bearer トークン**（ログイン後）。
- **ログインの結果は画面が直接書かない**。provider は資格情報を compare-and-set で保存して通知するだけで、誰がログインしているかは次の `load` の `resolveSettled()` で controller が確定する（I-10）。
- **ログアウトも `end()` を呼ばない**。`logout()` の後の `resolveSettled()` が `none` を確定したときだけ `/login` へ移る。ログイン画面はログアウトの確定の後にしか出ない（そこで送ったログインが、まだ終わっていないログアウトの compare-and-set に負けないように）。
- デスクトップの **認証無効モード（M11）** は Tauri 専用。provider の `resolve()` が `kind: 'local'` を返し、`sessionStore.authDisabled` はそこから導く。LAN との併用ルールは設定画面と `viewer-public` 計画書が一次情報。

---

## 4. 閲覧公開（合成 viewer）の位置づけ

```mermaid
flowchart LR
  subgraph lan["LAN ブラウザ（server mode）"]
    A["ログイン無しでアクセス"]
    B["POST /api/auth/grant/publicViewer"]
    C["Bearer トークン<br/>identity.kind === 'publicViewer'"]
    D["viewer ロールで REST 読取"]
  end

  subgraph cfg["設定（デスクトップから）"]
    S["server.viewer_public = ON"]
  end

  S -.->|有効時のみ| B
  A --> B --> C --> D
```

### 読み方

- 設定トグルは **デスクトップ設定**から。OFF なら publicViewer の grant 発行は 403（[ADR-0017](./adr/0017-credential-less-grant.md)）。
- 合成セッションは **mutating を RBAC で拒否**（監査の扱いは conventions / viewer-public-plan 参照）。
- display プリセットは初回起動シード等で閲覧公開を既定 ON にする想定（[architecture-overview.md §4](./architecture-overview.md)）。

---

## 5. 初回起動・セットアップ

プロセス起動直後のシードと、初代アカウント／ログイン不要モード／LAN オプトインの関係。

### 5.1 プロセス起動（Rust）

```mermaid
flowchart TD
  RUN["src-tauri run() または banto-serve"]
  DB["DB 初期化<br/>migrations"]
  SET["SettingsService 生成"]
  SEED["seed_first_boot_settings<br/>settings が空のときだけ"]
  AUTH["Users / Auth 状態を読む"]
  LAN{"server.enabled?"}
  EMB["組み込み HTTP 起動"]
  UI["Webview または静的 UI"]

  RUN --> DB --> SET --> SEED --> AUTH
  AUTH --> LAN
  LAN -->|Yes| EMB --> UI
  LAN -->|No| UI
```

### 読み方

- **`FIRST_BOOT_SETTINGS`**（`admin-template-core` の `first_boot.rs`）はテンプレート出荷では **空**。`settings` に1行でもあればシードしない。
- `pnpm scaffold --preset display` だけが非空リストへ差し替え（認証無効・閲覧公開・LAN 公開など）。仕組み自体は常在。
- シードは **auth_config / server_config を読む前**に走るので、初回起動から既定が効く。

### 5.2 初回画面（フロント）

```mermaid
flowchart TD
  LOGIN["/login"]
  ST["AuthProvider.status()"]
  INIT{"initialized?"}
  SETUP["セットアップ UI<br/>初代 admin 作成"]
  LOGINUI["通常ログイン UI"]
  SKIP{"Tauri かつ<br/>スキップ選択?"}
  CREATE["setup() / auth_setup<br/>admin アカウント"]
  NOLOGIN["auth.disabled=true<br/>ロール admin で合成セッション"]
  APP["(app) へ"]

  LOGIN --> ST --> INIT
  INIT -->|No| SETUP
  INIT -->|Yes| LOGINUI
  SETUP --> SKIP
  SKIP -->|アカウント作成| CREATE --> APP
  SKIP -->|ログインなしで始める| NOLOGIN --> APP
  LOGINUI --> APP
```

### 読み方

- **`initialized == false`** のときだけセットアップフォーム。通常は初代 admin を `setup` で作る。
- **「ログインなしで使い始める」**は **Tauri のみ**（`docs/recipes/no-login-app.md`）。LAN 初回には出ない。
- スキップはアカウント 0 のまま `auth.disabled` を ON にし、synthetic session（`local`）でダッシュボードへ。
- demo（`pnpm dev`）は別系。本物の first_boot / LAN シードは使わない。

### 5.3 LAN オプトインとの関係

```mermaid
flowchart LR
  subgraph desk["デスクトップ設定"]
    A1["認証: 通常 / 無効"]
    A2["閲覧公開 ON/OFF"]
    A3["LAN アクセス ON/OFF<br/>bind / port"]
  end

  A1 --> A2
  A2 --> A3
  A3 -->|"保存して適用"| S["server_apply<br/>組み込みサーバ起動"]
```

### 読み方

- 組み込みサーバは **既定 OFF**。利用者が設定で ON（または display シード）。
- **認証無効 + LAN** は、閲覧公開 ON のときだけ許可（表示専用アプリの標準形）。詳細は viewer-public / no-login レシピ。
- LAN 有効化後の URL / QR は設定画面から。ブラウザ側の入り方は [§2](#2-保護ルートへの入り方app-ガード)・[§4](#4-閲覧公開合成-viewer-の位置づけ)。

---

## 6. 開発ループの3経路

フロント／バックをどの組み合わせで回すか。いずれも同じ SvelteKit アプリだが、provider と永続化が違う（[§1](#1-起動時の3環境と-provider-選択)）。

```mermaid
flowchart LR
  subgraph pathA["A. pnpm dev"]
    V["Vite :1420"]
    IM["InMemory + demo 認証"]
    V --- IM
  end

  subgraph pathB["B. banto-serve"]
    BS["admin-template-core バイナリ"]
    REST["REST + SSE + 静的 UI"]
    DBB[("SQLite / Postgres")]
    BS --- REST --- DBB
  end

  subgraph pathC["C. tauri dev"]
    TW["Tauri Webview"]
    INV["invoke → サービス"]
    DBC[("SQLite 等")]
    EMB2["組み込み HTTP<br/>設定でオプトイン"]
    TW --- INV --- DBC
    TW -.-> EMB2
  end
```

### 使い分け

| 経路 | コマンド（要約）                                                                        | mode     | 向いていること                                           |
| ---- | --------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------- |
| A    | `pnpm dev`                                                                              | `demo`   | UI だけの高速イテレーション。Rust / Tauri 不要           |
| B    | `pnpm build` → `cargo run -p admin-template-core --bin banto-serve --features embed-ui` | `server` | LAN / REST を Tauri なしで確認。CI・コンテナ向き         |
| C    | `pnpm --filter admin-template tauri dev`                                                | `tauri`  | 本番に近いデスクトップ。`invoke`・キーリング・LAN トグル |

### 読み方

- **A** はバックエンドなし。データはメモリ上のデモ。認証もデモ用。
- **B** はフルスタック HTTP。既定ポート `8721`、`BANTO_DB` / `BANTO_VIEWER_PUBLIC` / `BANTO_ALLOW_SETUP` などで挙動調整。`embed-ui` 無しだとプレースホルダ UI。
- **C** の Webview は常に開発中フロントを表示。LAN クライアントに実 UI を出す本番ビルドでは `embed-ui` が別途必要（[docs/recipes/lan-access.md「`embed-ui` フィーチャー」](./recipes/lan-access.md)）。
- 検証の常用は `pnpm check` / `cargo test` / `pnpm e2e`（e2e は多くの場合 `banto-serve`）。`src-tauri` コンパイルはこのサンドボックスでは不可なことがある。

---

## 7. add-resource × レイヤ対応

正式手順はリポジトリの `docs/recipes/add-resource.md`。ここでは [architecture-overview.md §3](./architecture-overview.md) の層に、チェックリストの各ステップがどこを触るかを対応づける索引。

| #   | レシピのステップ                   | 主に触る層           | 置き場の目安                                       |
| --- | ---------------------------------- | -------------------- | -------------------------------------------------- |
| 1   | マイグレーション                   | 永続化（DB）         | `core/migrations-sqlite/` + `migrations-postgres/` |
| 2   | サービス層                         | サービス             | `core/src/<resource>.rs`                           |
| 3   | REST ルート                        | wiring（REST）       | `core/src/rest/<resource>.rs` + `rest/mod.rs`      |
| 4   | Tauri コマンド                     | wiring（Tauri）      | `src-tauri/src/lib.rs`                             |
| 5   | 両経路の認可対称テスト             | wiring（両経路）     | `rest/tests` / サービス・コマンドのテスト          |
| 6   | 監査イベント確認                   | wiring               | 同上（mutating のみ）                              |
| 7   | リソース定義・スキーマ             | UI + admin-core 契約 | `src/lib/banto/resources/`                         |
| 8   | ページ・ナビ                       | UI                   | `routes/(app)/…`・`navigation.ts`                  |
| 9   | ダッシュボード / CSV / e2e（任意） | UI + 検証            | `dashboard.ts`・e2e 等                             |

```mermaid
flowchart LR
  subgraph recipe["add-resource 手順の流れ"]
    S1["1 DB"]
    S2["2 サービス"]
    S34["3+4 wiring 両経路"]
    S56["5+6 対称テスト"]
    S78["7+8 フロント"]
    S9["9 任意"]
    S1 --> S2 --> S34 --> S56 --> S78 --> S9
  end
```

### 読み方

- **対象読者**: 新 CRUD を足すとき「いまどの層の作業か」を overview と突き合わせたい人・エージェント。
- **順序は Rust → フロント**。3 と 4 はペア（片方だけ足さない）。5・6 が対称性のゲート。
- provider 実装自体は通常いじらない（既存の Tauri/HTTP/InMemory が `DataProvider` 契約でリソース名を運ぶ）。
- InMemory デモに出すなら任意で `sampleData.ts`（[§6](#6-開発ループの3経路) の経路 A）。出さない機能は demo で明示拒否。
- 更新1回の実行時の流れは [architecture-overview.md §6](./architecture-overview.md) と本ファイルの認証節を参照。

---

## 関連ドキュメント（リポジトリ）

| 用途                      | パス                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- |
| provider 契約             | `packages/admin-core/src/provider.ts`                                                 |
| HTTP 認証実装             | `packages/admin-core/src/providers/http.ts`                                           |
| 組成・3環境               | `apps/admin-template/src/lib/banto/setup.ts`                                          |
| 埋め込みサーバ判定        | `apps/admin-template/src/lib/banto/environment.ts`                                    |
| ルートガード              | `apps/admin-template/src/routes/(app)/+layout.ts`                                     |
| 初回シード                | `apps/admin-template/core/src/first_boot.rs`                                          |
| ログイン／セットアップ UI | `apps/admin-template/src/routes/login/+page.svelte`                                   |
| ログイン無しレシピ        | `docs/recipes/no-login-app.md`                                                        |
| display 既定              | `docs/design/display-preset-plan.md`                                                         |
| 開発コマンド              | `README.md`「開発」、`docs/recipes/lan-access.md`「`banto-serve`」                     |
| CRUD 追加手順             | `docs/recipes/add-resource.md`（本ファイル §7 は層の索引）                            |
| 閲覧公開計画              | `docs/design/viewer-public-plan.md` / `docs/adr/0012-lan-public-viewer-synthetic-session.md` |
