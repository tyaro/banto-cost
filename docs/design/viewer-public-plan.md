# 閲覧公開モード（viewer-public）計画書 — Issue #189

作成日: 2026-09-14
状態: **実装済み（v1.7 系）。2026-10-02 オーナー決定（2026-10-03 改訂）で §2.2 の発行の仕組みは
「資格情報なしの grant 発行」に一本化する（[ADR-0017](../adr/0017-credential-less-grant.md)、
v3.0.0 で実装・破壊的変更）。閲覧公開は grant の 1 種類目 `publicViewer` になり、本書の
閲覧公開専用の API 名・URL・フィールド（`/api/auth/public-viewer`、`viewerPublic`、
`identity.publicViewer`、`issue_public_viewer_token` など）は v3.0.0 で削除される。
設定キー `server.viewerPublic`・§2.3 の両方向ガード・画面の許可リストは残る**
トラック: 保守者向け（トラックA）
関連: [ADR-0012](../adr/0012-lan-public-viewer-synthetic-session.md)（方式の選定理由）、
[ADR-0017](../adr/0017-credential-less-grant.md)（grant への一般化。閲覧公開はその 1 種類目）、
roadmap M10 / M11、conventions §1 / §6 / §10、
[docs/recipes/no-login-app.md](../recipes/no-login-app.md)、Issue #189（本書）、
Issue #190（`--preset display`。本書が前提）

## 1. 目的

カンバン（アンドン）・常設ダッシュボード・展示デモのような**表示専用アプリ**を、
「書き込みは 1 台のデスクトップ、閲覧は LAN 上のタブレットや壁のモニターが
ログイン無しで眺める」形で配れるようにする。

M11 ログイン不要モードは v1 で Tauri ウィンドウ限定であり、
「認証無効 + LAN サーバ有効」は設定バリデーションで拒否される
（2026-07-08 決定「LAN 側を無認証公開しない」）。その決定の意図＝
**書き込み面を無認証で LAN に出さない**は維持したまま、**閲覧面だけ**を
明示オプトインで公開できる軸を足す。

## 2. 設計の要点 — 「認証を外す」を 2 軸に分ける

| 軸                   | 内容                                                                                                                    | 既存との関係                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **書き込み権限**     | 従来どおり。無認証で書けるのはデスクトップ（M11 の synthetic session）のみ。LAN からの mutating は常にログイン必須      | M11 の護りをそのまま維持                            |
| **閲覧公開**（新設） | `server.viewerPublic`（既定 OFF）。ON のとき LAN クライアントは**ログイン無しで `viewer` ロールの合成セッション**を得る | M11 の排他を「閲覧公開 ON なら LAN 併用可」に緩める |

### 2.1 方式: 合成 viewer セッションの自動発行（ADR-0012）

Issue #189 の当初案は「認証をバイパスする read-only ルータを merge する口」
だったが、本計画は **`POST /api/auth/public-viewer` で `viewer` ロール固定の
bearer トークンを発行する**方式を採る。理由の要約（詳細は ADR-0012）:

- 既存の `require_auth` + `RoleGuard` + 監査がそのまま効く。**新しい認可経路を
  作らない**ので conventions §1（両経路対称）と §6 に穴が開かない。
- M10 の `viewer` は「表示専用ロール」として定義済みで、M11 は M10 を前提に
  「LAN のキオスクは viewer ロールで賄う」と書いている。足りなかったのは
  「ログイン無しで viewer になる入口」だけ。
- SSE / ui-settings / 添付サムネイル等、閲覧に必要な既存 API が
  無改造で動く（バイパス方式だと公開ルータに読み取り API を複製することになる）。
- M11 のデスクトップ synthetic session（`local`）と同じ語彙（合成 identity +
  role）で説明できる。

### 2.2 合成 viewer セッションの規約（conventions §6 に追記）

> **grant への一本化（2026-10-02、2026-10-03 改訂、[ADR-0017](../adr/0017-credential-less-grant.md)）**:
> v3.0.0 で grant に一本化済み（実装 PR）。以下の規約は「grant」の規約の `publicViewer` 種別への適用で、
> 閲覧公開専用の名前は削除された。旧名と新名の対応は — 発行口 `POST /api/auth/public-viewer` → `POST /api/auth/grant/publicViewer`、
> `issue_public_viewer_token()` → `issue_grant_token(&spec, observed)`（判定の前に世代を読み、`None` は拒否。手順は ADR-0017 決定 §2「発行と失効の直列化」）、
> `revoke_public_viewer_tokens()` → `revoke_grant_tokens("publicViewer")`、
> `MAX_PUBLIC_VIEWER_SESSIONS` → その `GrantSpec.max_sessions`（種別ごとの FIFO、既定 256）、
> 「viewerPublic OFF で 403」→ `GrantSpec.enabled`（要求ごとに評価）、
> 「発行は監査しない」「寿命は既定 8h / idle 1h」「logout は自分だけ」「change-password は拒否」は
> grant 全種別に共通。閲覧公開は `require_loopback_peer: false`（LAN に出す前提）。
> 画面側は `publicViewerFallback` → `grantFallback(…, { kind: 'publicViewer' })`、
> `enterPublicViewer` → `enterGrant('publicViewer')`、`/api/auth/status` の `viewerPublic` →
> `grants.publicViewer`、`identity.publicViewer` → `identity.kind === 'publicViewer'`。
> 規約本文は conventions §6 に反映済み。

- **role は常に `viewer`。** `GrantSpec::public_viewer`（発行は `POST /api/auth/grant/publicViewer`）は
  クライアントから identity を受け取らず、`{ id: "public", name: "public", role: "viewer" }`
  を固定で発行する。昇格経路は存在しない。
- **条件（`server.viewerPublic`。状態は `grants.publicViewer`）が偽のとき発行は 403 `forbidden`。** 判定は毎回
  `SettingsService::server_config()` を読む（サーバ再起動不要。banto-serve と
  Tauri 組み込みサーバで同じ挙動）。
- **同時セッション数を上限 `max_sessions`（既定 256）で抑える**
  （古いものから失効）。発行は資格情報を伴わず安価なので、レート制限ではなく
  上限で無限増殖（メモリ）を防ぐ。上限に達しても発行自体は失敗しない
  （最古を追い出す）ので、タブレットの再読み込みで閲覧が止まることはない。
- **発行は監査しない。** 資格情報の検証ではなく、タブレットの再読み込みごとに
  `login` を記録すると監査ログが埋まる。合成 viewer が mutating を叩いた場合の
  `denied` は既存の `RoleGuard` がそのまま記録する（actor `public`）。
- **`POST /api/auth/logout` は自分のトークンだけ失効する**（他の公開閲覧端末に
  影響しない）。
- **`change-password` は合成セッションを明示的に拒否する**（同名の通常アカウントの
  存在に依存しない）。フロントは公開閲覧
  セッションでアカウント系 UI を出さない。
- ui-settings は `ui.public.*` 名前空間を**全公開閲覧端末で共有**する
  （デスクトップ M11 の `ui.local.*` と同じ）。壁のモニターが同じレイアウトを
  共有するのは表示専用アプリでは望ましい挙動として受け入れる。

### 2.3 設定バリデーションの変更（`SettingsService`）

| 組合せ                                                  | 従来 | 変更後                             |
| ------------------------------------------------------- | ---- | ---------------------------------- |
| `auth.disabled` + `server.enabled` + `viewerPublic=OFF` | 拒否 | **拒否（変更なし）**               |
| `auth.disabled` + `server.enabled` + `viewerPublic=ON`  | 拒否 | **許可**（表示専用アプリの標準形） |
| `!auth.disabled` + `server.enabled` + `viewerPublic=ON` | —    | 許可（ログイン運用 + 匿名閲覧）    |

`set_server_config` / `set_auth_config` の両方向で判定する（片方だけ通る状態を
作らない）。エラーメッセージは「認証無効モード中は、閲覧公開を有効にした場合のみ
LANアクセスを有効化できます」（逆方向も同旨）。

## 3. スコープ

### 3.1 やること

1. **設定**: `ServerSettings.viewer_public: bool`（key `server.viewer_public`、
   既定 `false`）。§2.3 のバリデーション。
2. **REST**（`banto-server` `routes/auth.rs`）:
   - `GET /api/auth/status` → `{ initialized, viewerPublic }`。
     加えて**アプリ固有フィールドの拡張点** `AuthStatusExtras`
     （`Arc<dyn Fn() -> serde_json::Map<String, Value> + Send + Sync>`、同期）
     を `extra_auth_router` の引数に足す（app 層が応答加工レイヤーを挟まずに
     済むようにする。テンプレート自身は `None`）。
   - `POST /api/auth/public-viewer` → `{ success, token }`（§2.2）。
   - `UsersAuthState` に `SettingsService` を追加（`viewerPublic` を毎回読む）。
3. **`AuthState`**（`banto-server` `auth.rs`）: `issue_public_viewer_token()` と
   上限付きプール。`identity_for` / `verify` / `logout` は既存のまま。
4. **Tauri**（`src-tauri/src/lib.rs`）: `server_apply(enabled, bind, port, viewerPublic)`、
   `ServerStatusResult.viewer_public`。バリデーションはサービス層に委ねる。
   `auth_status` は `viewerPublic: false` を返す（Tauri ウィンドウ内に公開閲覧は
   存在しない）。
5. **banto-serve**: `BANTO_VIEWER_PUBLIC=1` で起動時に設定を seed
   （`BANTO_ALLOW_SETUP` と同じ dev/e2e 用の入口）。
6. **フロント**:
   - `AuthProvider.status()` の戻り値に `viewerPublic?: boolean`、
     `enterPublicViewer?(): Promise<boolean>` を追加（http provider のみ実装。
     tauri / demo は未定義＝非対応）。
   - `(app)/+layout.ts`: `check()` が false のとき `status().viewerPublic` なら
     `enterPublicViewer()` を試み、成功したらそのまま通す。失敗時は従来どおり
     `/login` へ。
   - `sessionStore.publicViewer` は `identity.publicViewer === true` で判定する。
     REST の identity 応答はトークン発行時の種別からこの属性を返す。通常ログインは
     false、公開閲覧は true。属性を持たない Tauri/demo/provider は false とする。
     `PUBLIC_VIEWER_ID = 'public'` は表示・監査用の識別子で、通常アカウントの
     username と重複し得るため、セッションの判定には使わない（#209）。
     更新時はサーバーとコピーした session store、admin-core の型を合わせて取り込む。
     旧サーバーの属性欠落をユーザー名で補完しない。データアクセスの境界は引き続き
     RBAC であり、この属性は公開閲覧用 UI の識別に用いる。
   - `NavItem.publicViewer?: boolean`（**opt-in 許可リスト**）。公開閲覧
     セッションでは `publicViewer: true` の項目だけをナビに出し、それ以外の
     パスは `(app)/+layout.ts` で先頭の公開項目へリダイレクトする（RBAC が
     データ面を守り、この許可リストは画面面を絞る）。テンプレートの既定は
     `/dashboard` と `/items` のみ。
   - Header: 公開閲覧セッションではユーザーメニューの代わりに「ログイン」
     ボタン（`/login` へ）。ロールチップは既存どおり「閲覧者」。
   - login 画面: `status().viewerPublic` のとき「閲覧のみで続ける」リンク
     （`/dashboard` へ。ゲートが合成セッションを発行する）。
   - 設定画面「サーバ・接続」: 「閲覧公開（ログイン無しで LAN から閲覧を
     許可）」チェックと警告文（LAN 上の誰でも閲覧できる旨）。ログイン不要
     モード中は LAN トグルを「閲覧公開 ON のときだけ有効化可」に。
     「セキュリティ」カードの注記も同旨に更新。
   - i18n: `messages/ja.json` / `en.json` に新キー（conventions §13）。
7. **`verify-architecture`**: `POST /api/auth/public-viewer` を新設の
   `REST_ONLY` セット（Tauri 側は M11 の synthetic session が等価であり
   対を持たないのが正しい）に分類。rule 8 (c) の判定に加える。
8. **e2e**: `e2e/tests/public-viewer.spec.ts`（`BANTO_VIEWER_PUBLIC=1` で
   起動した**別ポートの 2 本目の banto-serve**、Playwright の `webServer`
   配列と `projects` で分離）。シナリオ: 未ログインで `/` → dashboard が
   見える／ヘッダに「ログイン」／items 一覧は見えるが作成ボタンは無い／
   公開トークンで `POST /api/items` → 403／`/users` へ直接遷移 → dashboard へ
   戻される／「ログイン」から admin でログインすると通常 UI に戻る。
9. **ドキュメント**: README「LANアクセス」節、`recipes/no-login-app.md` に
   「表示専用アプリ（LAN 閲覧公開）」節、roadmap M11 に追記、
   conventions §6（§2.2 の規約）と §10（`publicViewer` は provider 層ではなく
   session 層の状態である旨）、CHANGELOG、ADR-0012、ADR 索引。

### 3.2 やらないこと（v1 非スコープ）

- LAN からのログイン無し**書き込み**（従来どおり不可。役割は `viewer` 固定）。
- 閲覧公開画面の認可粒度（ロール別の見せ分け等）。v1 は「公開 or 非公開」の 2 値。
- 公開閲覧セッションの永続化（トークンは既定 `TokenPolicy`（8h/1h idle）で
  失効し、ゲートが透過的に再発行する。Remember me は適用しない）。
- Tauri ウィンドウ内での公開閲覧（M11 で既にカバー）。
- `--preset display`（Issue #190、別 PR）。
- 「viewer 以外の role を資格情報なしで配る」こと。v1 では非スコープだったが、
  2026-10-02 に **grant への一本化**として採ることにした（[ADR-0017](../adr/0017-credential-less-grant.md)、v3.0.0。
  派生アプリの試運転 = admin 相当の grant。固定 identity・要求ごとの条件・
  `require_loopback_peer`・種別ごとの失効を伴う。本書の閲覧公開の仕様は変えず、API 名だけが
  grant のものに置き換わる）。

## 4. 実装単位

| 単位 | 内容                                                                                                                               | 主な触れどころ                                                                                                                                                                                                                                                                               | 委譲先                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| U1   | Rust: 設定 + バリデーション、`AuthState` 発行/上限、REST 2 ルート + extras hook、banto-serve seed、rest/tests、verify-architecture | `crates/banto-admin-services/src/settings.rs`、`crates/banto-server/src/{auth.rs,routes/auth.rs}`、`apps/admin-template/core/src/rest/{mod.rs,tests.rs}`、`core/src/bin/banto-serve.rs`、`scripts/verify-architecture.mjs`                                                                   | opus（セキュリティ境界） |
| U2   | Tauri: `server_apply` / `server_status` / `auth_status`                                                                            | `src-tauri/src/lib.rs`、`src/lib/banto/serverAdmin.ts`                                                                                                                                                                                                                                       | U1 と同一エージェント    |
| U3   | フロント: provider / ゲート / session / nav / Header / login / settings / i18n                                                     | `packages/admin-core/src/{provider.ts,providers/http.ts,index.ts}`、`apps/admin-template/src/{routes/(app)/+layout.ts,lib/session.svelte.ts,lib/navigation.ts,lib/components/{Header,Sidebar}.svelte,routes/login/+page.svelte,routes/(app)/settings/+page.svelte}`、`messages/{ja,en}.json` | sonnet                   |
| U4   | e2e + ドキュメント + CHANGELOG                                                                                                     | `e2e/`、README、docs                                                                                                                                                                                                                                                                         | 司令塔 + sonnet          |

U1 と U3 はワイヤ契約（§3.1 の 2・6）を本書で固定した上で並行に進める。

## 5. テスト

- `crates/banto-admin-services` `settings.rs`: §2.3 の 3 組合せ × 2 方向。
- `crates/banto-server` `auth.rs`: 発行トークンの role が viewer／上限到達で最古が
  失効／logout が自分だけ失効。
- `apps/admin-template/core/src/rest/tests.rs`:
  `viewerPublic` OFF で 403／ON で発行 → `identity` が `public`/`viewer`／
  `POST /api/items` が 403 + `denied` 監査／`change-password` が失敗／
  `status` に `viewerPublic` が載る／extras hook の値が flatten される。
- `packages/admin-core` vitest: http provider の `status()` 拡張と
  `enterPublicViewer()`（トークン保存先は sessionStorage）。
- e2e: §3.1-8。
- `pnpm check` / `pnpm lint` / `pnpm verify:architecture` / `cargo test` /
  `pnpm e2e`。src-tauri は `tauri-check.yml`（CI）で担保。

## 6. 完了条件

- `viewerPublic` OFF の既存インストールは挙動が一切変わらない（既定 false、
  `status` に `viewerPublic: false` が増えるのみ）。
- `viewerPublic` ON の banto-serve に未ログインのブラウザでアクセスすると、
  ログイン画面を経ずに `/dashboard` が表示され、mutating は UI 非表示 + REST 403。
- 「認証無効 + LAN 有効」は閲覧公開 ON のときだけ通る（両方向のテスト）。
- `verify-architecture` rule 8 が新ルートを分類済みとして通る。
