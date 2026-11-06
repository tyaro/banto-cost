# SessionController 設計（Issue #260）

- 状態: v2.0.0 でリリース（2026-10-01。実装-1（#264）・実装-2（#265）・実装-3（#266、admin-template の v2 配線と破壊的変更）を含む。§9 の判断点はオーナーの決定済み 2026-09-29、同日のレビュー 10 件と統合修正 19 項目を反映。§10 の宿題 2 件は実装-2 で決定、2026-09-30。実装-3 の扱いは §10 に追記、2026-09-30。ADR-0016 は実装-3 で Accepted。派生アプリの移行（§6.2・§7.2）は別リポジトリの PR。**2026-10-02 オーナー決定・2026-10-03 改訂（[ADR-0017](../adr/0017-credential-less-grant.md)）: 試運転は `adopt()`/`end()` ではなく「資格情報なしの grant」（閲覧公開の一般化、provider が答える S-42 の経路）で確定する。`adopt()`/`end()` と「adopt 中」の分岐は v3.0.0 で削除（grant に置き換え）。§4.7・§6.2・I-13・I-21 に注記。grant のシナリオは S-109 以降に足す。**v3.0.0 の実装 PR で実施済み**: `adopt()`/`end()`・epoch だけの ticket・「adopt 中」の分岐を削除、`publicViewerFallback` → `grantFallback(…, { kind })`、`enterPublicViewer` → `enterGrant(kind)`、`identity.publicViewer` → `identity.kind`、owner key は grant kind 単独。S-44〜S-46・S-53・S-62・S-69〜S-71 のテストは削除し、S-109〜S-114 を `sessionController.test.ts` に追加（§4.7）**）
- 日付: 2026-09-29
- 関連: Issue #260・#255・#257・#258・#259・#241・#204 / ADR-0016 /
  ADR-0014（アカウントに結び付けた失効）/ ADR-0012（合成 viewer セッション）/
  spec §3.3・§8.1 / conventions §6・§10
- 対象コード: banto `019f6e9`（#255 マージ後の main）

このドキュメントは、admin-core のセッションの確定を 1 か所（SessionController）に
寄せるための**設計**を書く。決定の記録は [ADR-0016](../adr/0016-session-controller-single-writer.md)、
ここには不変条件・競合のシナリオ・API の案・移行と実装の分割・テストの設計を置く。
実装の PR は、このドキュメントのシナリオ番号（S-n）と不変条件番号（I-n）をテスト名から
参照する。

## 1. 今のコードの事実（診断の裏付け）

Issue #260 本文の診断を、`019f6e9` のコードで確かめた結果。**推測には（推測）と付ける。**

### 1.1 セッションの状態を書く場所が 4 か所ある

| 場所                                                | 書くもの                            | 何を根拠に書くか                                                         |
| --------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `sessionGate.ts` `resolveProtectedSession`          | `endSession()`                      | `check()` が `false`、かつ開始時の scope が今も current                  |
| `sessionLifecycle.ts` `establishSession`            | `beginSession(identity)` と `apply` | `getIdentity()` の答え、かつ sequence と scope が current                |
| `sessionEnded.ts` `runConfirmation`                 | `endSession()` と listener 通知     | `check()` が `false`、かつ scope が current、かつ通知の重複なし          |
| アプリ（`Header.svelte`・`commands.ts`）            | `endSession()`                      | `logout()` が完了した後（照合なし）                                      |
| アプリ（`session.svelte.ts` `sessionStore.load()`） | identity・role・publicViewer        | `establishSession` の `apply` の中（6 回目のレビューで同じ継続に移した） |

`transitionSessionScope` 自体は 1 か所（`sessionScope.svelte.ts`）だが、それを呼ぶ判断は
上の 4 か所に散っていて、それぞれが「開始時の scope を覚えて後で照合する」処理を持つ
（`sessionGate.ts` 51-68 行、`sessionLifecycle.ts` 114-125 行、`sessionEnded.ts` 121-165 行）。
#255 の 5〜6 回目の指摘は、この照合の抜け（別の継続に分かれていた）だった。
`sessionGate.ts` 67-68 行は `enterPublicViewer()` の `boolean` をそのまま結果にしている
（§5.2 で戻り値の形が変わるので、実装-1 の受け入れ条件に入れる、§7.1）。

### 1.2 provider の答えは「どの資格情報についての答えか」を持たない

- HTTP: `check()`（`providers/http.ts` 285-289 行）と `getIdentity()`（298-313 行）は、
  それぞれ呼ばれた瞬間の `getToken()` で別々に往復する。`check()` は `401`/`200 false`
  で `clearTokenIfCurrent(token)` を呼ぶ（223・235 行）＝ **確認に資格情報を消す副作用がある**。
  `getIdentity()` は `200 null` でもトークンを消さない。
  `login`・`setup`・`enterPublicViewer` の `setToken(...)`（256・355・404 行）と `logout` の
  `setToken(null)`（267 行）は**無条件**。#259 はこの `enterPublicViewer` の無条件書き込みを
  指している。`setToken(token, remember=false)` は `localStorage` の remember トークンを消す
  （190 行）＝通常のログインが別タブの remember セッションを消す既存の挙動（§4.6）。
- Tauri: `check()`/`getIdentity()` は `auth_check`/`auth_identity` を別々に呼ぶ
  （`providers/tauri.ts` 127-134 行）。答えは呼んだ時点の Rust 側 `state.auth` について。
- demo（`apps/admin-template/src/lib/banto/providers/demo.ts`）: `check()`/`getIdentity()` を
  持つメモリ上の provider。v2 の契約に合わせて書き換える対象（実装-3、§7.1）。
- 「check は成功、identity だけ 500」は、この 2 往復から生まれる（`sessionRaces.test.ts`
  242-283 行が再現している）。

**REST の `GET /api/auth/identity` はすでに 1 往復で足りる答えを返している**
（`crates/banto-server/src/auth.rs` 1483-1509 行）。`identity_handler` は
`authenticated_session` → `AuthState::authenticate(token)` を通り、`require_auth` と同じ
再検証（#204、ADR-0014）を行う。答えは次の 3 つ:

- `200` で identity（`Identity & { publicViewer }`）: 有効。
- `200 null`: トークンが無い、または**失効している**（`authenticate` が `None`）。失効した
  トークンは `401` ではなく `200 null` で返る。role の変更も `auth_epoch` を進めるので
  （`crates/banto-admin-services/src/users.rs` 656-673 行、ADR-0014）、**role を変えた後の
  identity は新しい role ではなく `200 null`**。
- それ以外（`500`・到達不能）: 確認できない。

つまり provider の `resolve()` は、この 1 ルートを 1 回呼べばよい（§2.1、§5.2。
オーナーの決定 3）。

### 1.3 Tauri の Rust 側：非同期の処理の後に認証状態を無条件で上書きしている箇所

`apps/admin-template/src-tauri/src/lib.rs`（`019f6e9`）。`AppState.auth` は
`Mutex<Option<DesktopSession>>`（67 行）で、書き込みの世代や操作の識別子は持たない。

| コマンド                                   | 行      | 直前の `.await`                                              | 書き方                                                                                                                                     |
| ------------------------------------------ | ------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth_login`                               | 646-647 | `users.verify(...)`（argon2 の検証、遅い）→ `record_ok(...)` | `*state.auth.lock() = Some(Account(identity))`：**無条件**                                                                                 |
| `auth_setup`                               | 622-623 | `users.setup_first_user(...)` → `record_ok(...)`             | 同上：**無条件**                                                                                                                           |
| `auth_logout`                              | 690-691 | `settings.auth_config()`                                     | `previous = lock().clone()` → `*lock() = None`：**無条件**（2 回の別ロック）。auth-disabled モードでは何もせず `Ok`（687-689 行）          |
| `auth_config_apply_body`（参考：正しい形） | 902-906 | `settings.set_auth_config(...)` ほか                         | `if auth.is_none() { *auth = Some(..) }` を 1 つのロックの中で（PR #182 の指摘）                                                           |
| `change_own_password`（参考：正しい形）    | 752-757 | `users.change_password(...)`                                 | `id` と `auth_epoch` が一致するときだけ `auth_epoch` を進める（compare-and-set）                                                           |
| `settle_session`（参考：正しい形）         | 309-326 | （`current_session` の DB 読み出しの後）                     | `unchanged`（`cached` と一致）のときだけ消す。**有効なら毎回 `*auth = valid.clone()` で refresh する**（同じ結び付きの role・name の更新） |

壊れる順序（オーナーの指摘。Rust 側だけで成立する。フロントの await の有無に依らない）:

1. **遅いログインが、完了済みのログアウトを取り消す**:
   `auth_login(B)` が `verify().await` で待つ → `auth_logout` が完了（`auth = None`）→
   `auth_login` が再開し 646 行で `auth = Some(B)`。Rust 側のセッションが復活する。
   フロントはログイン画面にいるが、次に保護ルートへ行くと `auth_check` が `true` を返す。
2. **遅いログアウトが、その後に確定したログインを消す**:
   `auth_logout` が `auth_config().await` で待つ → `auth_login(B)` が完了（`auth = Some(B)`、
   フロントは B として画面を出す）→ `auth_logout` が再開し 690-691 行で `previous = Some(B)`、
   `auth = None`。B の Rust 側セッションが消え、次のコマンドが `Unauthorized` になる
   （監査には B の `logout` が記録される）。
3. `auth_setup` は 1 と同じ形（初回のセットアップだけなので頻度は低いが、コードは同じ）。

いずれも、**書き込みが「操作を始めたときの状態」と照合していない**ことが原因で、
`auth_config_apply_body`・`change_own_password`・`settle_session` はすでに照合している。
同じ形に揃えるのが §5.3 の案。

Tauri には公開閲覧のセッションの発行は無い（`auth_status` は `viewer_public: false` 固定、
594-600 行。`createTauriAuthProvider` は `enterPublicViewer` を持たない）。
`run()` の起動時の自動ログイン（2367 行〜）はコマンドを受け付ける前に決まるので、競合しない。
ログイン不要モード（auth-disabled）の合成 identity は Rust が持ち（`id: LOCAL_SESSION_ID = 0`、
204 行）、`auth_identity` は呼ばれるたびに `current_session` → `read_session_source`（270-279 行）で
モードと権限を読み直す。**フロントが合成する必要は無い**（オーナーの決定 4）。一方、フロントの
`sessionStore.authDisabled` は `load` の中で `getAuthSettings()` を await した後に**照合なしで代入**
している（`session.svelte.ts` 91-95 行）＝ §4.9 の洗い出しで見つけた同じ型（S-61）。

### 1.4 REST 側（`crates/banto-server/src/auth.rs`）には共有の 1 スロットが無い

`AuthState` はトークンごとの map（`tokens: RwLock<HashMap<String, TokenRecord>>`、495 行）。
`login`/`issue_*` は新しいトークンを**追加**し（858-890 行）、`logout(token)` は**そのトークン
だけ**を消す（904 行、`logout_handler` 1471-1476 行）。遅い応答で別のセッションを消す形は
REST のサーバ側には無い。REST 経路で「1 スロット」に当たるのは**ブラウザ側のトークンの保存先**
（`setToken`、§1.2）で、その compare-and-set が #259。

### 1.5 SvelteKit の `load` から状態を書いている

`apps/admin-template/src/routes/(app)/+layout.ts` は `resolveProtectedSession`（`endSession` を
呼びうる）と `sessionStore.load()`（`establishSession` → `beginSession` → `apply`）を `load` の
中で呼ぶ。SvelteKit は追い越された navigation の**結果**は捨てるが、`load` の中で走った
**副作用**は取り消せない（#255 の 5〜6 回目の指摘の 3 件はすべてこの形）。
また、`load` の中からは「この navigation はもう追い越されたか」を知る手段が無い。

### 1.6 派生アプリ（banto-industrial、`@banto/admin-core` は `v1.7.3` に固定）

| アプリ      | ファイル                          | 今の形                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| banto-hub   | `src/lib/session.svelte.ts`       | `load()` が `getIdentity()` を**直接**呼ぶ（`establishSession` を使っていない＝所有者・世代の照合なし）。`enterCommissioningMode()` で合成 identity を直接代入                                                                                           |
| banto-hub   | `src/lib/banto/sessionGuard.ts`   | `resolveProtectedSession` を包み `'session' / 'login' / 'unverified'` に写す                                                                                                                                                                             |
| banto-hub   | `src/lib/banto/sessionRecheck.ts` | ストリーム切断後の再確認を**独自に**実装（開始時の token を覚えて終了時に照合、single-flight、10 秒の期限、`AbortController`）＝ core と同じ照合の作り直し。`/api/auth/check` を `fetch` で直接呼ぶ。`assumedCommissioning` を見て試運転の状態を先に取る |
| banto-hub   | `src/routes/(app)/+layout.ts`     | `fetchCommissioningStatusOrNull()` を **await した後**に `enterCommissioningMode()`（照合なし）、そうでなければガード → `sessionStore.load()`                                                                                                            |
| chronogazer | `src/lib/session.svelte.ts`       | `load()` が `getIdentity()` を直接呼ぶ                                                                                                                                                                                                                   |

派生アプリは `beginSession`/`endSession`/`sessionGeneration` を使っていないので、
一覧状態の所有者照合（#255）の恩恵も、世代ゲートも、まだ効いていない（v1.7.3 固定のため当然）。
どちらも admin-core の `createHttpAuthProvider`/`createTauriAuthProvider` を使っていて、
自前の `AuthProvider` 実装は持たない（`session.svelte.ts`・`sessionGuard.ts` が
`getAuthProvider()` の戻り値をそのまま使っていることからの推測。`setup.ts` の全文は未読）。
**（実装-3 の独立監査で訂正、2026-09-30）** 推測は誤り: chronogazer の `src/lib/banto/setup.ts`（132〜160 行）に
`check()`/`getIdentity()` だけの自前の `demoAuthProvider` がある（v2 では型エラー、かつブラウザの demo 起動時に
`initBanto` が `TypeError` を投げて白画面になる）。また banto-hub と chronogazer の `session.svelte.ts`（41 行）は
`getAuthProvider().getIdentity()` を**直接**呼んでいる（v2 の `AuthProvider` には無い）。§6.2 の表を参照。

### 1.7 ログインの監査は、REST と Tauri のどちらも「資格情報の検証に成功した」時点で記録している

オーナーの決定 7 の前提として調べた。

| 経路  | 場所                                                                                | 記録する時点                                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST  | `crates/banto-server/src/routes/audit.rs` `audited_credential_verifier`（15-64 行） | `users.verify()` が成功した直後、**トークンを発行する前**（`origin: "rest"`）。REST にはスロットが無いので、検証の成功＝セッションの発行と同じ                          |
| Tauri | `apps/admin-template/src-tauri/src/lib.rs` `auth_login`（645 行）                   | `users.verify()` が成功した直後、**`state.auth` を書く前**（`origin: "tauri"`）。今は無条件に書くので検証の成功＝確定と同じだが、§5.3 の compare-and-set の後は違いうる |

つまり今はどちらも「検証に成功した」を `login` として記録していて、意味は揃っている。
§5.3 で Tauri に compare-and-set を入れると、「検証には成功したが、世代の不一致で確定を
拒否した」場合が生まれ、`login` の記録と実際のセッションが食い違う。これをどう記録するかは
今回の必須要件から外す（決定 7、§9）。ログアウトの監査は、REST は middleware で
（`routes/audit.rs` 150-172 行、トークンの有効性に関わらず記録）、Tauri は `previous` が
あるときだけ記録する（`auth_logout` 692-701 行）。

REST の `audited_credential_verifier` は **検証処理を closure として `AuthState::new` に注入**
している（`banto-serve` と Tauri の組み込みサーバが共有）。Tauri の `auth_login` は
`state.users.verify()` を直接呼ぶ。§8.3 の「制御できる非同期の境界」は、この REST 側の形を
Tauri のコマンドにも持ち込む。

## 2. 責務と原則（#260 本文の確定形）

責務の表は Issue 本文のとおり。ここでは、オーナーのコメント（2026-09-29）で明確化を求められた
2 点と、レビューで求められた共通の原則（ticket）を確定する。

### 2.1 2 種類の `resolve()`

| 層         | 名前                          | 失敗の表し方                                                                                                                      | 答えの種類                                                                           |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| provider   | `AuthProvider.resolve()`      | **reject する**（`ProviderError`）。取得できない＝サーバが確認できない（500）・到達不能・応答の形が違う                           | `{ status: 'none' \| 'active', checked, current, identity?, kind? }`（1 往復。§5.2） |
| controller | `SessionController.resolve()` | **reject しない**。呼び出し元は戻り値の `outcome` で**今回の要求について**判断する。共有スナップショットの `lastError` は補助情報 | `confirmed` / `unverified` / `superseded`（§5.1）                                    |

- provider の `resolve()`（HTTP）は `GET /api/auth/identity` を**1 回だけ**呼ぶ（§1.2 の事実。
  `GET /api/auth/session` は新設しない、決定 3）: `200` で identity → `active`、`200 null`
  または `401` → `none`、それ以外 → reject。**トークンを送って `none` が返ったら失効が確定した**
  とみなし、compare-and-set で**そのトークンだけ**を消す（今の `check()` の
  `clearTokenIfCurrent` と同じ副作用を `resolve()` に移す）。この消去は **`onCredentialChanged`
  では通知せず、答えの `current`（消去後の revision）で運ぶ**（統合修正 2）。Tauri は
  `auth_resolve`（§5.3）。
- 答えの `checked` は「この答えが検証した資格情報の revision」（入口で読む）、`current` は
  「この呼び出し自身の消去を反映した後の revision」（消去していなければ `checked` と同じ）。
  controller は両方を照合に使う（§5.1 手順 4）。
- controller の `resolve()` は「この要求は、確認できた（none か active のどちらかが確定した）／
  確認できなかった（確定状態は変えていない。再試行できる）／**外からの遷移**に追い越された
  （**この確認の結果は採用できない**。navigation が破棄されたとは限らない）」を返す。
  呼び出し元が `snapshot.lastError` を見て推理することはしない。
- `superseded` は、要求が待っている間に**外からの遷移**（`end`・`adopt`・資格情報の変化による
  保留・別の probe による別 owner の確定）が起きたときに、その時点で決まる。要求自身が待って
  いた probe が確定して epoch が進むことは「追い越し」ではない（I-20、S-57）。
- `superseded` を受けた呼び出し元は、まだ有効なら**最新の確認に合流するか要求し直し**、
  **実際に確認できた結果の generation** だけを使う。今の generation を代わりに返さない
  （決定 5、I-16）。再確認には期限がある（§5.1 `resolveSettled`）。
- `confirmed` の結果は、その確定を表す `ticket`（§2.3）を持つ。後続の非同期の方針
  （公開閲覧の fallback など）はこの ticket を最後まで持ち回り、**方針の結果も `ResolveResult`
  として返す**（呼び出し元が `unverified` を先に処理する、統合修正 5、S-66）。

### 2.2 原則 7 の範囲

> フロントの確定したセッションの状態（owner・generation・identity）を終了の状態に移すのは
> controller だけ。資格情報の破棄とバックエンドの失効の処理は、provider とバックエンドが担う。

具体的には:

- controller が担う: `status`・`owner`・`generation`・`identity`・`kind` の遷移、保存状態の
  全消去の指示（`none` への遷移）、listener への通知。
- provider が担う: トークンの保存・消去（compare-and-set）、`resolve()` が `none` を確定した
  ときの**そのトークン**の消去（答えの `current` で運ぶ）、別タブの変化の検知、**自分が行った
  操作の結果の revision を操作の応答から確定し、revision が変わったときだけ即座に通知すること**
  （I-19）。
- バックエンドが担う: セッションの失効の判定（ADR-0014）、Rust 側 `state.auth` の
  compare-and-set（§5.3）、状態を変えた操作（login / setup / logout / change_password）の応答で
  `seq` を返すこと。
- provider が資格情報を消しても、controller の確定状態はそれだけでは変わらない。
  provider は `onCredentialChanged` で controller に**知らせ**、controller が §3 の
  I-5 に従って遷移する。**ログアウトも同じ経路**で終わる: アプリは `logout()` の後に `end()` を
  呼ばず、`resolve()` で `none` を確定する（I-10、S-51）。
- 別タブの切り替え（#257）の処理で、controller も provider も**共有のトークンを勝手に消さない**
  （決定 8、I-17）。

### 2.3 共通の原則: ticket（原則 1・4 の具体化）

> **非同期の判定・操作は、始めたときに ticket を取り、結果を適用する直前に、同期で
> `isCurrent(ticket)` を照合する。** ticket は層ごとに中身が違うが、「何と照合するか」を
> 開始時に固定し、`await` をまたいで持ち回り、適用と照合を同じ継続で行う点は同じ。

| 層           | ticket の中身                                                              | 取る場所                                                      | 照合する場所（同期）                                                                 | 照合に失敗したら                                                                                  |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| controller   | probe: `{ epochAtStart, revisionAtStart, startedAt, abandoned }`           | probe を出す前                                                | probe の fulfill・reject・timeout の**すべて**の継続の先頭（§5.1 手順 4 の採用条件） | 答えを捨てる（状態も `verification` も変えない）。消去を伴う答えなら `pendingBackground` を立てる |
| provider     | `revision`（操作の開始時、または呼び出し元から渡された `expectRevision`）  | `login`/`logout`/`setup`/`enterPublicViewer`/`resolve` の入口 | トークンを書く・消す直前（compare-and-set）                                          | 書かない。`superseded: true` を返す                                                               |
| アプリの方針 | `SessionTicket`（controller の `epoch` と、adopt 中でなければ `revision`） | 非同期の判定（`status()`・試運転状態の取得）を始める前        | `adopt(…, ticket)`・`end(…, ticket)`・発行の直前の `isCurrent(ticket)`               | 何もしない（`false`）。新しい ticket で方針を期限付きでやり直す                                   |
| Rust         | `seq`                                                                      | コマンドの入口（最初の `.await` の前）                        | `cas_session(expected_seq, …)` の 1 つのロックの中                                   | 書かない。`superseded: true` / no-op                                                              |

この原則を破る形（「`await` の後に無条件で書く」「戻り値の boolean だけで判断する」「照合と適用が
別の継続」）は、#255 の 6 往復と今回のレビューのすべてに共通する。§4.9 に
「状態を書き換える入口 × 非同期の境界」の表を置き、実装の PR のレビューでも同じ表で洗う。

## 3. 不変条件（テストから参照する番号）

| 番号 | 不変条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 由来                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| I-1  | **単一の書き手**: 確定状態（`status`・`owner`・`generation`・`identity`・`kind`）を変える関数は controller 内部の `commit()` 1 つ。公開の入口は `resolve` の適用・`adopt(…, ticket)`・`end(…, ticket)`・資格情報の変化による保留（I-5）の 4 つだけ。参照・購読の API（`sessionGeneration`・`onSessionEnded` など）は独自の状態や確認処理を持たず controller に委譲する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 原則 1・7、決定 1                           |
| I-2  | **epoch と generation**: `epoch` は `commit` ごとに +1（鮮度の照合用、非公開）。`generation` は `commit` で **(status, owner, kind) の組が変わったときだけ** +1（画面の作り直し用、公開）。none→none、unknown→unknown、同じ owner・kind の active→active（再確認）、同じ C の再 adopt は据え置き。単調増加。§3.1 の表はこの規則から機械的に導く。**probe の答えによる純粋な再確認**（同じ (status, owner, kind)・同じ内容の identity・同じ revision）は commit しない＝ epoch も据え置き（`verification` だけ戻す。取った ticket を無効にしない、実装-2 で決定、S-88）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `transitionSessionScope`、統合修正 6        |
| I-3  | **鮮度**: provider の答え（fulfill・reject・timeout の**いずれも**）は §5.1 手順 4 の採用条件（打ち切っていない・epoch が同じ・signal が後に無い・答えの `checked` が開始時の revision・今の revision が答えの `current`）を満たすときだけ状態に触れられる。満たさなければ**状態も `verification` も変えずに**捨てる。捨てた答えが消去を伴っていれば `pendingBackground` を立てる。provider の `StaleAnswerError`（Rust の `stale`、pending の操作をまたいだ答え）も**通信の障害と区別して**同じく捨てる（`verification` を変えず、新しい probe で確認し直す）。出し直しは I-9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 原則 1、統合修正 2                          |
| I-4  | **取得不能は状態を変えない**: 同じ資格情報で確認に失敗しても、確定状態と保存状態は変えない。変わるのは `verification` だけ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 原則 2・#204                                |
| I-5  | **資格情報の切り替えで active の旧 owner は active でなくなる**: 切り替えを知った時点（`onCredentialChanged`、または controller が最後に反映した revision と今の revision の差を見つけた時点）（期限切れや置き換えで捨てた probe の答えが遅れて届き、provider がそこから seq を観測した時点も含む。S-101）で、**`status === 'active'` かつ adopt 中でなければ** `status: 'unknown'`・`owner: null` にする（保留）。none／unknown／adopt 中は保留せず `pendingBackground` を立てるだけ（守るべき active の旧 owner が無い）。その後の確認に失敗しても旧 owner の active には戻さない。保存状態は消さない（owner 照合で読めないだけ）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 原則 6、オーナー 3 回目 3、4 回目 1         |
| I-6  | **`none` への遷移だけが保存状態を全消去する**: `commit(none)`（`resolve` が none を確定、または `end(…, ticket)`）は `clearAllListViewState()`。他の遷移は全消去しない（新しい owner の確定で他人の分を purge するのは今のまま）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `endSession`                                |
| I-7  | **資格情報の書き込み・消去は compare-and-set**: provider（トークン）も Rust 側（`state.auth`）も、操作を始めたとき（または呼び出し元が渡した ticket の時点）の revision / seq と一致するときだけ書く。controller は資格情報を書かない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 原則 4・#259                                |
| I-8  | **controller の `resolve()` は reject しない**: 3 つの `outcome` のどれかを必ず返す。期限は 2 種類で分ける: **probe の期限**（probe が始まってから `deps.timeoutMs`。打ち切って abort、I-22）と**待機者の期限**（`resolveSettled` の `deadlineMs`。その waiter が `unverified` を受け取って離れるだけで、probe は止めない）。`superseded` の後の再確認にも期限があり、いつまでも待たない・再試行し続けない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | オーナーのコメント 1、決定 5、4 回目 P3-9   |
| I-9  | **single-flight と鮮度の下限**: 同時の `resolve()` で provider への問い合わせは最大 1 本。`cause: 'signal'` の要求は**その要求の時点**より後に始めた問い合わせでしか満たされない（要求自体が signal の stamp を進める）。破棄した問い合わせを**出し直さないのは、画面からの待機要求も、未処理の背景の確認の必要（`pendingBackground`）も無いときだけ**。待機者の数だけで判断しない。`unverified` の背景の確認は S-33 の退避で続ける                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 本文、決定 6、統合修正 14                   |
| I-10 | **認証の操作は待ち行列に入れず、結果は `resolve()` で確定する**: `login`/`logout`/`setup`/`enterPublicViewer` は provider を直接呼ぶ。操作の戻り値を直接 `commit` せず、**ログアウトの後も `end()` を呼ばず**、その後の `resolve()` で確定する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 本文、レビュー 1                            |
| I-11 | **Rust 側の `state.auth` は seq 付き**: `seq` は**結び付きを変える意図の操作**（login/setup の設置（ログイン不要モード中は設置しない、S-95）、config-apply(false) の Local の終了（S-99）、config-apply の rebind（None・Account → Local、#266 オーナーレビュー P1、S-94）、logout/settle の消去、change_password の rebind）で、**値が変わらなくても**（logout の None→None を含む）+1 する。**同じ結び付きの refresh**（`settle_session` の display_name の更新）では進めない（同じ binding の refresh が 2 つ並ぶと、先に読んだ方が後に書いて display_name を一時的に戻しうる。表示だけで認可（role・epoch）は戻せず、次の確認で直るので許容する。S-102 の補足）。`auth.` の設定を書くのは `auth_config_apply`／`autologin_*` だけ（汎用の `settings_set` は拒否、S-103）で、`set_auth_config` は 1 トランザクション（途中の失敗でもセッションは保存済みの値に従わせる、S-104）。config-apply の Local → Local は、role が変わるなら（認可の文脈が変わる）`seq` を +1、同じ role なら何も書かない（S-96。すべての Local は `same_binding` で同じ binding なので、`seq` だけが「読んだ後に書かれた」を在中の settle に伝える）。role が変わったかは**保存前の設定**と比べて決め、保存と rebind の間に settle の refresh が slot を新しい role にしていても apply は必ず `seq` を +1 する（S-98。settle の refresh は role を書くが `seq` は進めない＝I-23 の「`current ≠ checked` ⇔ この呼び出しが消した」を保つため）。auth-disabled モードの logout の no-op は進めない。書き込みは、コマンドが最初の `.await` の前に読んだ `seq` と一致するときだけ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | §1.3、レビュー 4、統合修正 11・12           |
| I-12 | **スナップショットは丸ごと**: `SessionSnapshot` は凍結したオブジェクトで、使う側は `owner`・`generation`・`identity`・`kind` を別々のストアから読まない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 原則 5                                      |
| I-13 | **adopt したセッションは provider の答えで終わらない**: アプリが `adopt(…, ticket)` したセッション（派生アプリ固有の試運転など）は `end(…, ticket)` か別の `adopt` でだけ終わる。`resolve()` は provider に問い合わせず `confirmed` を返す。adopt 中は `onCredentialChanged` も手順 0 の revision の差の検知も保留（unknown）にせず、`pendingBackground` を立てるだけ。`adopt`/`end` は ticket が current でなければ何もしない。公開閲覧の fallback と Tauri のログイン不要モードは `adopt()` の対象ではない（provider が答える）。**（2026-10-02、2026-10-03 改訂、ADR-0017）`adopt()`/`end()` は v3.0.0 で削除し、grant に置き換える。試運転は grant（`grantFallback` + provider の答え。S-42 と同じ経路）で確定するので、この不変条件と「adopt 中」の分岐は v3.0.0 で消える。v3.0.0 で削除済み（この行は履歴）**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 本文、決定 4、レビュー 3、4 回目 1          |
| I-14 | **controller は SvelteKit を知らない**: `load` は `controller.resolve()` を await して結果を返すだけ。`{#key generation}` と generation の照合はアプリ層                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 本文                                        |
| I-15 | **待機を打ち切った後の遅い答えは無効**: 期限で `unverified` を返した問い合わせの答えが後で届いても `commit` しない（I-3 の照合で捨てる）。provider 側の副作用（`none` でのトークン消去）は答えの `current` に載り、捨てられた場合は `pendingBackground` の背景の確認で none を確定する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | オーナーのコメント、統合修正 2              |
| I-16 | **確認していない generation を画面に渡さない**: `superseded` を受けた呼び出し元は、その要求で**実際に確認できた**結果の generation しか返せない。今の generation を代わりに返さない。旧 owner のページデータを新しい世代へ引き継がない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 決定 5                                      |
| I-17 | **別タブの切り替えの処理は、共有のトークンを消さず、他のタブをログアウトさせない**: 資格情報の変化を検知したタブがすることは、旧画面の操作を止める → 新しいセッションを確認する → 変更が確認できたら通知して作り直す（または、注入された方針でログインへ移す）まで。トークンの消去は provider の `resolve()` が `none` を確定したときの compare-and-set だけ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 決定 8                                      |
| I-18 | **ticket の原則**: 非同期の判定・操作は開始時に ticket（controller: epoch/revision/signal、provider: revision、方針: `SessionTicket`、Rust: `seq`）を取り、最後まで持ち回り、適用の直前に同期で照合する。照合と適用の間に `await` を置かない。照合に失敗した結果は捨てる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §2.3、レビュー 1〜5                         |
| I-19 | **資格情報の変化の通知は、追加の確認の成功に依存せず、revision が変わったときだけ出す**: provider は、状態を変えた操作（login/logout/setup/enterPublicViewer/changePassword）の**応答**から revision（Tauri は `seq`）を確定し、**前の revision と違うときだけ**その継続で `onCredentialChanged` を出す（auth-disabled の logout の no-op や CAS 不成立では出ない）。**状態を変える操作**の応答が得られないとき（Tauri の `invoke` の reject で、エラーの本体が識別できない形）、または応答がスロットを消した可能性のある失効系のエラー（`unauthorized`。`change_own_password` は失効したセッションを消してから `Unauthorized` を返す）のときだけ `local` を進めて出す（安全側）。それ以外の構造化されたエラー（`validation`＝現在のパスワード違いなど・`forbidden`・`storage`・`other`）は、Rust がスロットに書く前に返すので進めない（実装-1）。**`resolve()` の reject では進めない**（DB の一時的な障害で保留に入り I-4/S-26 を破るため。HTTP は応答が無いときも進めなくてよい）。`resolve()` の中の消去は通知せず答えで運ぶ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | レビュー 5、統合修正 2・11、4 回目 P2-8     |
| I-20 | **自分の確定で自分を追い越さない**: 要求が満たされるかは、probe の `epochAtStart`（= 要求時の epoch）で判定し、確定後の snapshot を `confirmed` として返す。`superseded` は、要求が待つ間に**外からの遷移**が起きた時点で決まる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | レビュー 8                                  |
| I-21 | **adopt 中の ticket は epoch だけ**: adopt 中に取った `SessionTicket` は `revision` を持たず、`isCurrent` は epoch だけで照合する（試運転はトークンで決まらない。S-46 と整合）。通常の確認と公開閲覧の発行の ticket は revision を持つ。**（2026-10-02、2026-10-03 改訂、ADR-0017）grant 化した試運転はトークンで決まるので ticket は revision を持つ（公開閲覧の発行と同じ）。epoch だけの ticket は `adopt()` と共に v3.0.0 で削除。v3.0.0 で削除済み: `ticket()` は常に `{ epoch, revision }`、`isCurrent` は両方の一致（この行は履歴）**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 統合修正 1                                  |
| I-22 | **abort は資源の解放であって、正しさの手段ではない。規則は 1 つ: 採用できないことが確定した probe は必ず abort する**（採用条件を満たさず捨てたとき、`timeoutMs` で `abandoned` にしたとき）。新しい確認が要るなら**新しい** probe を出す。`AbortController` は probe ごとに 1 つ、`settled` フラグで abort に伴う reject を二重に処理しない。1 人の waiter の期限（`resolveSettled` の `deadlineMs`）では abort しない（waiter が離れるだけ）。中断できない処理があるので、答えを捨てる判定（I-3）は abort と独立に残す。方針の通信は方針自身の signal を使い、controller の probe に渡さない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 統合修正 7・8、4 回目 4・P3-9               |
| I-23 | **provider の revision は不透明な `(observedSeq, local)` の組で、controller は等値比較だけで扱う**: `credentialRevision()` の型は不透明（`CredentialRevision`、文字列 `${observedSeq}.${local}` でよい）。Tauri provider の `observedSeq` は Rust から観測した `seq`（操作の応答も `auth_resolve` の `current` も）の **max** で更新し、決して減らさない（Rust の `stale: true` の答えの `current` も、pending の操作が無ければ reject の前に観測する（S-97）。pending の操作があるときに見えた `current` は捨てずに `deferredSeq` に max で保留し、最後の pending の操作が終わったとき（応答・reject・期限切れのどれでも）、その操作自身の `seq`／`local` の反映と同じ継続で回収して、組が変わったら 1 回だけ通知する（S-100）。seq を返さずに失敗する操作（`changePassword` の forbidden など）でも前進を失わない）。`local` は**状態を変える操作**の `invoke` の reject のうち、応答が得られないもの（識別できない形）と失効系（`unauthorized`）のときだけ +1（I-19）。`resolve()` は入口で `(s0, l)` を読み、答えの `checked`/`current` には入口の `l` を貼る。Rust の `auth_resolve` は最初の `.await` の前に `seq_at_entry` を読み、`settle_session` が 1 つのロックの中で seq が動いていれば何も書かず `stale` を返す。よって「`current !== checked` ⇔ この呼び出しが消した」が成り立つ（足し算は provider 内部の数値カウンタだけで行い、その後に不透明な値へ変換する）。HTTP は `observedSeq` をメモリ上のカウンタとして持つ（`local` は使わない）。HTTP の `resolve()` は、答えが届いた時点で保存されているトークンが送ったものと違えば（別タブの書き換えで storage イベント未着）`StaleAnswerError` で reject する（S-105）。**公開型はすべて `CredentialRevision`**（`credentialRevision()`、`ResolvedAuth.checked/current`、`SessionTicket.revision`、`enterPublicViewer` の `expectRevision`、controller の `appliedRevision`/`revisionAtStart`）。**stale**（Rust の `stale: true`、および**答えが届いた時点で未完了の状態を変える操作が 1 つでもある**答え。操作の開始が `resolve()` の入口の前か後かを問わない。§5.3 の表）は provider が `StaleAnswerError` で reject し、controller は通信の障害と区別して `verification` を変えずに新しい probe で確認し直す（上限あり）。状態を変える操作の pending には期限（`opPendingTimeoutMs`）があり、期限を過ぎたら「結果が分からない」として `local` を進めて通知し、確認を塞ぐ対象から外す。元の invoke が後から結果を返したら `observe(seq)`／通知で扱う（CAS は Rust 側で済んでいる） | 4 回目 5、Fable P1-1、5 回目 1・5、6 回目 1 |
| I-24 | **未処理のユーザーの変更（`pendingOwnerChange`）の寿命**: active(B) の `commit` で `previousActiveOwner` が null でも B でもなければ `{ from, to }` を立てる。**保持する**のは `unknown` のとき、同じユーザー（同じ owner）の再確認のとき、レイアウトの unmount 中。**終わる**のは `none` が確定したとき（未処理の変更も破棄。セッションの終了を越えて持ち越さない）と、レイアウトが処理して `acknowledgeOwnerChange()` を呼んだとき。ページ全体の再読込では controller ごと消えるので**保証しない**（保証するのは controller を維持した画面内の再読込だけ）。§6.1 の寿命の表                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 6 回目 オーナー決定・2・3                   |

### 3.1 generation の数え方（I-2 から機械的に導いた表）

規則は 1 つ: **`commit` で (status, owner, kind) の組が変われば +1、変わらなければ据え置き**。
シナリオの期待（+1 / +2 / 据え置き）はこの表から引く。

| 遷移（前 → 後）                                                      | 組が変わるか | generation              | 使う場所                     |
| -------------------------------------------------------------------- | ------------ | ----------------------- | ---------------------------- |
| unknown → active(A)                                                  | status       | +1                      | S-57、S-24                   |
| active(A) → active(A)（再確認、display_name の更新）                 | 変わらない   | 据え置き                | S-8、S-13、S-54              |
| active(A) → active(owner null)（id の無い identity）                 | owner        | +1                      | S-10                         |
| active(A) → active(B)                                                | owner        | +1                      | S-6（保留を経ない provider） |
| active(A) → unknown（保留）                                          | status       | +1                      | S-23、S-35、S-59             |
| unknown → active(A)（同じ A の再ログイン。保留を経て）               | status       | +1（保留と合わせて +2） | S-59                         |
| unknown → unknown（保留中に再度の変化。保留は commit しない）        | 変わらない   | 据え置き                | S-63（2 度目の変化）         |
| none／unknown／adopt 中に資格情報の変化を知る（保留に移さない、I-5） | commit なし  | 据え置き                | S-42 の発行後、S-46、S-62    |
| active(A) → none                                                     | status       | +1                      | S-5、S-25、S-51              |
| none → none（none の再確認、ログイン画面の再 load）                  | 変わらない   | 据え置き                | S-42 の前段                  |
| none → active(P)（公開閲覧の発行。none は保留に移さない）            | status       | +1                      | S-42                         |
| none → active(A)（`end` の後の背景の確認で A を確定）                | status       | +1                      | S-62                         |
| none → active(C)（adopt）                                            | status       | +1                      | S-44                         |
| active(C) → active(C)（同じ C の再 adopt）                           | 変わらない   | 据え置き                | S-44                         |
| active(C) → none（`end`）                                            | status       | +1                      | S-45、S-53、S-62             |
| active(A, account) → active(local)（モードの切り替え）               | owner・kind  | +1                      | S-47、S-61                   |

## 4. 競合のシナリオ

記法: `A`/`B` はアカウント、`P` は公開閲覧、`C` は試運転。`probe(n)` は provider の
`resolve()` の n 本目、`→` は時間の順、`‖` は**同じターン（同じマイクロタスクの並び）で
解決する**ことを表す。「期待」は controller の最終スナップショットと、要求ごとの `outcome`。
generation の増分は §3.1 の表から引く。

### 4.1 #255 の既存シナリオ（そのまま保つ。`sessionRaces.test.ts` ほか）

| 番号 | 順序                                                                                                                                       | 期待                                                                                                                                                                                                                                                   | 不変条件       | 元のテスト            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | --------------------- |
| S-1  | A の `resolve()` が probe(1) を待つ → `end()`（方針の終了）→ B の `resolve()` が probe(2) で確定 → probe(1) が A を返す                    | A の要求は `superseded`（`end()` の時点で決まる）。B の owner・generation・保存状態は変わらない。probe(1) は捨てる                                                                                                                                     | I-1・I-3・I-20 | `sessionRaces` 117 行 |
| S-2  | A の `resolve()` が probe(1) を待つ → 資格情報の変化を**互換 adapter**（revision も通知も無い）越しには検知できない → probe(1) が A を返す | adapter では I-5 は効かない（§5.2 の表）。標準 provider なら `onCredentialChanged` で保留に入り、probe(1) は epoch の不一致で捨てる。probe(2) を出し直し、その答えで確定（reject なら S-63）                                                           | I-3・I-9       | `sessionRaces` 129 行 |
| S-3  | A の確認（probe(1)）を待つ間に B が確定 → probe(1) が `none` を返す                                                                        | B は終わらない。probe(1) は破棄                                                                                                                                                                                                                        | I-3            | `sessionRaces` 146 行 |
| S-4  | SSE の 401 の signal → probe(1) 待ち → B が確定 → probe(1) が `none`                                                                       | B は終わらない。`onSessionEnded` は呼ばれない。背景の確認が未処理なので B の資格情報で probe(2)                                                                                                                                                        | I-3・I-9       | `sessionRaces` 160 行 |
| S-5  | A が active → signal → probe(1) が `none`（遷移なし。`checked = current`）                                                                 | 1 回の `commit(none)`、generation +1、保存状態の全消去、listener 通知。待機者は `confirmed`                                                                                                                                                            | I-6            | `sessionRaces` 179 行 |
| S-6  | probe(1)（A の確認）と B のログイン後の `resolve()`（probe(2)）が在中 → probe(1) `none` ‖ probe(2) `B`                                     | 最終 owner は B。どちらが先に適用されても、I-3 の照合が同じ継続で行われるので順序に依らない                                                                                                                                                            | I-1・I-3       | `sessionRaces` 197 行 |
| S-7  | S-6 の signal 版                                                                                                                           | 同上。通知は出ない                                                                                                                                                                                                                                     | I-3            | `sessionRaces` 215 行 |
| S-8  | A が active → `resolve()` で provider が reject（500 / 到達不能）→ 再試行で A                                                              | 1 回目は `unverified`、owner・generation・保存状態は不変。2 回目は `confirmed`（同じ generation）。保存状態は復元される                                                                                                                                | I-4            | `sessionRaces` 242 行 |
| S-9  | provider の `resolve()`: HTTP で `200 null` または `401`                                                                                   | `{ status: 'none' }`（reject ではない）。トークンを送っていたなら、そのトークンを compare-and-set で消し、`current` を `checked` の次の不透明な値（内部カウンタ +1）で運ぶ（通知しない）。**role を変更した後の identity も `200 null`**（§1.2、S-64） | §2.1           | `sessionRaces` 284 行 |
| S-10 | A が active → id の無い identity で確定                                                                                                    | owner は `null`（`unknown` ではなく active・owner なし）、generation +1。A の保存状態は消さない。次に A が確定すれば読める                                                                                                                             | I-2・I-6       | `sessionRaces` 289 行 |
| S-11 | `sessionGate`・`sessionEnded`・`sessionEndIntegration` の各テスト                                                                          | 期待は変えない。呼び口だけ controller に置き換える（§6.1）。`sessionEndUnheard` は S-34 の新しい期待に書き換える                                                                                                                                       | —              | 各ファイル            |

### 4.2 同じターンで解決する組み合わせ

| 番号 | 順序                                                                                           | 期待                                                                                                                                                                                                                                    | 不変条件             |
| ---- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| S-12 | 旧い確認 probe(1)（`end()` の前に開始）‖ 新しい確立 probe(2)（`end()` の後に開始）が同時に解決 | probe(1) は遷移回数が変わっているので破棄。probe(2) の答えで確定。最終状態は probe(2) の答えだけで決まる                                                                                                                                | I-3                  |
| S-13 | 1 本の probe の答えを 2 つの `resolve()` 要求（navigation ×2）が待つ ‖ 答えが返る              | 両方 `confirmed`（同じ snapshot）。provider への問い合わせは 1 本（single-flight）                                                                                                                                                      | I-9                  |
| S-14 | 2 つの要求が同じ probe を待つ → `end()` → probe が返る                                         | `end()` の時点で両方に `superseded` を返す（待機者はいなくなる）。probe の答えは破棄。`pendingBackground` が立っていれば出し直し、無ければ出し直さず abort する（I-22）。`resolveSettled` が要求し直せば、その要求が新しい probe を出す | I-3・I-9・I-20・I-22 |
| S-15 | `adopt(C, ticket)` ‖ 在中の probe が `none` を返す                                             | C が active のまま。probe の答えは破棄（遷移回数が変わった）                                                                                                                                                                            | I-13                 |

### 4.3 Tauri の Rust 側まで含めた両方向

| 番号 | 順序                                                                                                                                                | 期待（Rust）                                                                                                                                                                                                                                         | 期待（フロント）                                                                                                                                       | 不変条件        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| S-16 | `auth_login(B)` 開始（`verify` 待ち）→ `auth_logout` 完了 → `auth_login` 再開                                                                       | `state.auth` は `None` のまま。`LoginResult { success: false, superseded: true, seq }`。監査は今のまま `login`（検証成功。§1.7、決定 7）                                                                                                             | ログインの戻り値を `commit` しない（I-10）。provider は応答の `seq` で revision を更新（I-19）。`resolve()` → `none` → ログイン画面のまま              | I-7・I-11・I-19 |
| S-17 | `auth_logout` 開始（`auth_config` 待ち）→ `auth_login(B)` 完了・`resolve()` で B 確定 → `auth_logout` 再開 → **ログアウトを始めた画面の継続が再開** | `state.auth` は `Some(B)` のまま。logout は何もせず `{ seq }` を返す（監査に B の `logout` を**残さない**）。`auth_change_password` の rebind と同時のログアウトも同じ形（rebind が先なら logout の CAS は不成立で、セッションは active のまま残る） | ログアウトの継続は `end()` を呼ばず `resolveSettled()`（S-51）。応答の `seq` は前と同じなので通知は出ない（I-19）。B は active のまま、generation 不変 | I-7・I-10・I-11 |
| S-18 | `auth_setup` で S-16 と同じ順序                                                                                                                     | アカウントは作られる（DB）。セッションは入れない。戻り値は `superseded`                                                                                                                                                                              | 同 S-16                                                                                                                                                | I-11            |
| S-19 | `auth_setup` で S-17 と同じ順序（setup 中に別のログイン完了。初期化前なので実際には起きにくい。推測）                                               | S-17 と同じ形で守る                                                                                                                                                                                                                                  | 同 S-17                                                                                                                                                | I-11            |
| S-20 | HTTP: ガードが `none` を確定 → 公開閲覧の発行 `enterPublicViewer()` 待ち → ヘッダーからログイン B 完了 → 発行の応答が届く                           | （REST 側は map への追加。B のトークンは消えない）                                                                                                                                                                                                   | provider の `setToken` は revision 不一致で**書かない**（#259）。`resolve()` → B。公開閲覧トークンは使われない                                         | I-7             |
| S-21 | HTTP: ログアウト開始（`POST /logout` 待ち）→ ログイン B 完了（トークン書き込み）→ ログアウトの `setToken(null)`                                     | （サーバ側は旧トークンだけ失効）                                                                                                                                                                                                                     | `setToken(null)` は revision 不一致で**消さない**。B は active のまま                                                                                  | I-7             |
| S-22 | Tauri の自動ログイン（`run()` 起動時）とコマンドの競合                                                                                              | 起動時に決まり、コマンド受付前。競合しない（事実 §1.3）                                                                                                                                                                                              | —                                                                                                                                                      | —               |

S-16〜S-19 は Rust の**コマンド本体**のテストで完了の順序を固定して（§8.3）、S-20〜S-21 は
provider のテストで、それぞれ**フロントの順序に依らず**成り立つことを確かめる。

### 4.4 資格情報が切り替わった後に確認が失敗した場合

| 番号 | 順序                                                                                           | 期待                                                                                                                                                                                                    | 不変条件 |
| ---- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S-23 | A が active → 資格情報が B に切り替わる（`onCredentialChanged`）→ `resolve()` が reject（500） | 切り替えを知った時点で `unknown`・`owner: null`・generation +1（保留）。要求は `unverified`。**A の active には戻らない**。A の画面は世代ゲートで消え、A の保存中の処理は書けない。再試行の状態に留める | I-5      |
| S-24 | S-23 の後、再試行で B が確定                                                                   | `confirmed`・active(B)・generation はさらに +1（unknown → active）。A の保存状態は purge                                                                                                                | I-2・I-5 |
| S-25 | S-23 の後、再試行で `none`（B のトークンがすでに失効していた）                                 | `confirmed`・`none`（1 回の `commit(none)`、+1）。全消去                                                                                                                                                | I-6      |
| S-26 | A が active → **同じ資格情報**で `resolve()` が reject                                         | active(A) のまま、`verification.state: 'failed'`。要求は `unverified`。**S-23 と区別する**（原則 2）                                                                                                    | I-4      |
| S-27 | A が active → 切り替えの検知 → 確定前に A の画面から保存の書き込み                             | 書き込みは `isCurrent(scope)` が偽なので落ちる（今の `listViewState` の書き込み条件と同じ）                                                                                                             | I-5      |

### 4.5 鮮度と待機の期限

| 番号 | 順序                                                                                                                 | 期待                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 不変条件  |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| S-28 | probe(1) 開始 → 失効の signal（SSE 401）→ その signal を起点にした `resolve()` 要求 → probe(1) が `active(A)` を返す | probe(1) では要求を満たさない（要求より前に始めた）。probe(1) の答えは破棄し probe(2) を出す。probe(2) の答えで確定                                                                                                                                                                                                                                                                                                                                                                                              | I-3・I-9  |
| S-29 | probe(1) 開始（navigation）→ signal → probe(1) が `active(A)` を返す（signal 起点の要求は無い）                      | probe(1) は破棄し、**`pendingBackground` が立っているので** probe(2) を出す（`createSessionEndConfirmation` の「答えが何であれ確かめ直す」を保つ）                                                                                                                                                                                                                                                                                                                                                               | I-3・I-9  |
| S-30 | `resolve()` が期限（既定 10 秒、`sessionEnded.ts` の `CONFIRM_TIMEOUT_MS` を引き継ぐ）を過ぎる                       | `unverified`（`error` は timeout）。確定状態は不変。その probe は `abandoned` にして、待機者が 0 かつ `pendingBackground` が偽なら abort する（I-22）                                                                                                                                                                                                                                                                                                                                                            | I-8・I-22 |
| S-31 | S-30 の後、遅れて probe が `none`（`current !== checked`、トークンを消した）を返す                                   | 採用条件を満たさない（`abandoned`）ので捨てる。**消去を伴う答えなので `pendingBackground` を立て**、背景の確認（probe(2)）が `none` を確定する。`onCredentialChanged` は使わない                                                                                                                                                                                                                                                                                                                                 | I-3・I-15 |
| S-32 | S-30 の後、遅れて probe が `active(A)` を返す（A は今も同じ資格情報）                                                | 捨てる。次の `resolve()`（新しい probe）で確定する。遅い答えで「確認済み」に見せない                                                                                                                                                                                                                                                                                                                                                                                                                             | I-15      |
| S-33 | signal 起点の確認（`signal()` または `resolve({ cause: 'signal' })`）が `unverified` のまま                          | 退避（backoff、`CONFIRM_RETRY_INITIAL_MS`→`CONFIRM_RETRY_MAX_MS`）で問い合わせ直す。`confirmed` になるまで。購読の終了で止める（今の `createSessionEndConfirmation` と同じ）。**`resolve({ cause: 'signal' })` もこのループを起こす**                                                                                                                                                                                                                                                                            | I-9       |
| S-34 | 保護レイアウトが mount する前に `none` が確定した（旧 unheard）                                                      | **再 probe をやめ、購読時の状態で決める**: `onSessionEnded` は購読した時点で `snapshot.status === 'none'` なら**非同期に 1 回**通知する（実装-2 で入れ、v2 でもそのまま残す）。実装-3 以降はレイアウトの `$effect`（§6.1 配線①）も mount 時に `snapshot.generation !== data.sessionGeneration` を見て `invalidateAll()` する。その間に新しいログインがあれば `load` がそれを確定する。再 probe はしない（`sessionEndUnheard.test.ts` の期待を「購読時に none なら 1 回通知」に書き換える）。実装-2 単独では S-74 | I-14      |

### 4.6 別のタブ（#257）と、複数タブでの同時のログイン・ログアウト

前提: 「Remember me」のトークンは `localStorage`（タブ間で共有）、通常のトークンは
`sessionStorage`（タブごと）。タブ間の検知は provider の adapter が `storage` イベントで行い、
`onCredentialChanged` を controller に渡す。

**既定の流れ**（決定 8）: ① 資格情報の変更を検知したら旧画面の操作を止める（I-5 の保留）→
② 新しいセッションを確認する（`resolve()`）→ ③ 別のユーザーへの変更が確認できたら**通知**し、
新しい権限で画面を作り直す（世代ゲート）→ ④ 旧ユーザーの未保存の入力や選択は引き継がない →
⑤ 確認に失敗したら旧画面へ戻さず、再試行の状態に留める → ⑥ この処理で**共有のトークンを
勝手に消さず、別のタブまでログアウトさせない**。共用の端末などで再認証が必要なアプリは、
「通知してログインへ移す」方針を注入できる（§6.1 `ownerChangePolicy`）。
画面側の配線は 3 本に分ける（§6.1、レビュー 7）: **generation の照合 → 再 load**、
**owner の差分 → 通知**、**再 load の `unverified` → 再試行画面**。

| 番号 | 順序                                                                         | 保証すること                                                                                                                                                                                                                         | 保証しないこと                                                                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-35 | タブ 1 が A（remember）→ タブ 2 が B でログイン（remember）                  | タブ 1 は `storage` イベントで保留に入り A を active として使わない → generation の照合で再 load → `resolve()` で B を確定 → owner の差分で**通知**、B の権限で作り直す。A の未保存の入力は引き継がない。タブ 1 はトークンを消さない | イベントが届くまでの間（ミリ秒〜）に A の画面から送った要求が B のトークンで飛ぶことは止められない（送信時点のトークンを使うため。今もそう）                                                                                              |
| S-36 | S-35 で、`resolve()` が reject（500）                                        | 保留の generation の変化で再 load が走り、`resolveSettled` が `unverified` → **503 の再試行画面**（空画面にしない）。A へ戻さない。B のトークンは消さない                                                                            | **503 の画面から自動では復帰しない**（利用者が再試行する。背景の退避ループは走るが、確定しても 503 の画面を勝手に置き換えない）                                                                                                           |
| S-37 | S-35 で、アプリが `ownerChangePolicy: 'relogin'` を注入している              | 通知してログイン画面へ移す。**トークンは消さない**（タブ 2 の B はログインしたまま）。タブ 1 のログイン画面からの扱い（B として続けるか、再認証を求めるか）はそのアプリのログイン画面側の要件                                        | —                                                                                                                                                                                                                                         |
| S-38 | タブ 1 と タブ 2 が**同時に**別のユーザーでログイン（remember）              | 各タブは**自分のログインの戻り値ではなく**、その後の `resolve()`（保存されているトークン）で確定する。両タブが同じ owner に収束する                                                                                                  | どちらのトークンが残るか（`localStorage` の最後の書き込みが勝つ。タブ間の compare-and-set は原理的にできない）                                                                                                                            |
| S-39 | タブ 1 がログアウト（`localStorage` を消す）と同時に、タブ 2 が B でログイン | 両タブとも保存されている資格情報に従う（B が残れば両方 B、消えていれば両方ログイン画面）。旧 owner A のまま残るタブは無い                                                                                                            | タブ 1 が「ログイン画面で終わる」こと                                                                                                                                                                                                     |
| S-40 | 同じタブで、ログイン中に別タブが `localStorage` を書き換える                 | このタブのログインの `setToken` は revision 不一致で書かない（I-7）。`resolve()` で保存されているトークンの owner を確定                                                                                                             | このタブのログインが「勝つ」こと                                                                                                                                                                                                          |
| S-41 | `sessionStorage`（通常ログイン）のタブ同士                                   | 互いに影響しない（今のまま）                                                                                                                                                                                                         | **通常のログインの `setToken` は `localStorage` の remember トークンを消す**（既存の挙動、§1.2）。別タブの remember セッションはその時点で終わる（それは「切り替えの処理」ではなくログインの副作用で、I-17 の対象外）。変えるかは別 issue |

原理的な限界: `localStorage` の読み→比較→書きはタブをまたいで原子的にできない（Web Locks API を
使えば近づくが、ADR-0002 の「依存を足さない」の範囲内でも実装が増え、Safari の対応も要確認。
**この設計では採らない**）。したがって保証するのは「**どのタブも、旧 owner を active として
使い続けない**」と「**各タブは自分の意図ではなく保存された資格情報に従う**」と「**切り替えの
処理が他のタブをログアウトさせない**」までで、「同時操作のどちらが勝つか」と「503 からの自動復帰」は
保証しない。**ページ全体の再読込**（`location.reload()`・F5）では controller が作り直されるので、未処理の
ユーザーの変更（`pendingOwnerChange`）の通知は保証しない（保証するのは controller を維持した画面内の
再読込だけ、S-81・I-24）。banto-hub の**初回のルートガード**（policy runner の `guard` mode）で、試運転を adopt 中に
試運転状態の取得に失敗（`status === null`）すると `end` して通常の確認へ倒す挙動は **v1.7.3 と同じ**で、
この設計では変えない（保証しないことに含める。ストリームの再確認 `recheck` は `unverified` で
画面を保つ、S-71）。

### 4.7 公開閲覧への fallback と試運転（grant。v2.x の `adopt()` は削除済み）

> **2026-10-02 オーナー決定・2026-10-03 改訂（[ADR-0017](../adr/0017-credential-less-grant.md)）、v3.0.0 で実装**: 試運転は
> `adopt()` ではなく **grant**（資格情報なしの発行。閲覧公開の一般化）で確定する。
> `adopt()`/`end()` は **v3.0.0 で削除**し、S-44〜S-46・S-53・S-62・S-69〜S-71 の「adopt 中」の
> シナリオも削除した（下の表の該当行は v2.x の記録として残す。テストは無い）。grant 化した試運転は
> S-42 と同じ形になる — `resolve()` → `none` → 方針が `status().grants.commissioning` を見る →
> `isCurrent(t0)` → `enterGrant('commissioning', { expectRevision })` → `resolveSettled()`。
> ticket は revision を持ち（I-21 の例外は不要）、SSE の 401 は `signal()` → provider への確認で
> 試運転の終了（ロックダウン = サーバー側の `revoke_grant_tokens`）を検出できる（S-45 の
> 「adopt 中は問い合わせない」が不要になる）。grant のシナリオは **S-109 以降**（下の 2 つ目の表、v3.0.0 で追加）。
> 閲覧公開の S-42・S-43・S-66 は `grantFallback(…, { kind: 'publicViewer' })`・`enterGrant('publicViewer', …)`・owner `publicViewer` に読み替える（テストもそのとおり改名済み）。

| 番号 | 順序                                                                                                                                                                                                                                                                                 | 期待                                                                                                                                                                                                                                                                                                                                                                                        | 不変条件         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| S-42 | `resolve()` → `confirmed`・`none`（ticket t0 = `{ epoch e0, revision r0 }`）→ 方針が `status()` を await → `isCurrent(t0)` → `enterPublicViewer({ expectRevision: r0 })` → 成功（provider が通知。**none なので保留には移らず** `pendingBackground` だけ、I-5） → `resolveSettled()` | 方針は `ResolveResult` を返す。`confirmed`・active(P)、`kind: 'publicViewer'`、owner `public-viewer`。generation は none → active(P) で **+1**（§3.1）。`adopt()` は使わない。t0 は none を確認した時点のもので、`status()` の後と発行の中の両方で照合する                                                                                                                                  | I-10・I-13・I-18 |
| S-43 | S-42 の発行待ちの間にログイン B                                                                                                                                                                                                                                                      | 発行の `setToken` は `expectRevision: r0` と不一致で書かない（S-20）。`resolveSettled()` → active(B)                                                                                                                                                                                                                                                                                        | I-7              |
| S-44 | banto-hub: ticket t0 を取る → `fetchCommissioningStatusOrNull(signal)` を await → 迂回 → `adopt(C, 'commissioning', t0)`                                                                                                                                                             | active(C)、`kind: 'commissioning'`、owner `commissioning:commissioning`、none からなら +1。provider には問い合わせない。同じ C の再 `adopt`（ticket は current）は generation 据え置き                                                                                                                                                                                                      | I-13・I-2・I-18  |
| S-45 | S-44 の後、SSE の 401 などの signal                                                                                                                                                                                                                                                  | adopt 中は signal で provider に問い合わせない（`confirmed` のまま）。試運転の終了（lock-down）は**アプリの方針**が、判定の前に取った ticket で `end('commissioning-locked', ticket)` を呼んでから `resolveSettled()`                                                                                                                                                                       | I-13             |
| S-46 | S-44 の後、`adopt` 中に別タブで A がログイン（`storage` イベント）                                                                                                                                                                                                                   | adopt 中の `onCredentialChanged` は `pendingBackground` を立てるだけで保留にしない（試運転はトークンで決まらない。generation 据え置き）。**その後に `resolve()` を呼んでも、手順 0 の差の検知は adopt 中なので保留せず、C を `confirmed` で返す**（S-69）。`end()` 後の `resolve()` で A を確定。**adopt 中に取った ticket は revision を持たないので、この変化で失効しない**（I-21、S-62） | I-13・I-9・I-21  |
| S-47 | Tauri のログイン不要モード（auth-disabled）                                                                                                                                                                                                                                          | Rust が合成した identity と `kind: 'local'` を `auth_resolve` が返す（`auth_identity` と同じく、そのたびにモードと権限を読み直す）。provider の `resolve()` で active、owner key は `local`（`account:0` と衝突させない）。**`adopt()` しない**（決定 4）                                                                                                                                   | I-13             |

**grant のシナリオ（v3.0.0、ADR-0017。`sessionController.test.ts` §4.7）**。kind は任意の文字列（`'publicViewer'`・`'commissioning'` など）で、owner key は kind 単独。

| 番号  | 順序                                                                                                                                                                                                                                      | 期待                                                                                                                                                                                                         | 不変条件   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| S-109 | S-42 の kind 一般化: `none`（ticket t0）→ `grantFallback(…, { kind: 'commissioning' })` → `status().grants.commissioning === true` → `isCurrent(t0)` → `enterGrant('commissioning', { expectRevision })` → `resolveSettled()`             | `confirmed`・active、`kind: 'commissioning'`、owner `commissioning`、generation +1。provider の答えの `identity.kind` が kind を決める                                                                       | I-10・I-18 |
| S-110 | 条件 false（`grants.commissioning === false`、または kind が無い）                                                                                                                                                                        | `enterGrant` を呼ばない。確定済みの `none` と同じ ticket をそのまま返す（generation 不変）。発行口の 403 も同じ扱い                                                                                          | I-18       |
| S-111 | provider に `enterGrant` が無い（Tauri・demo・互換 adapter）                                                                                                                                                                              | `none` のまま返す（例外にしない）                                                                                                                                                                            | —          |
| S-112 | `available(status)` を差し替える                                                                                                                                                                                                          | 既定の `grants[kind] === true` の代わりにアプリの判定を使う                                                                                                                                                  | —          |
| S-113 | 失効 → 401 → 黙って取り直す: active(C) → SSE の 401 で `signal()` → provider が `none`（失効したトークンを消去）→ `grantFallback` が条件 true で再発行                                                                                      | `none` の確定の ticket は revision を持つ（epoch だけの ticket は無い）。再発行後は active(C)。ロックダウンの検出はサーバーの `revoke_grant_tokens` → 次の要求の 401 で足りる（S-45 の例外は不要）           | I-5・I-18  |
| S-114 | S-113 の続きで条件が閉じている（ロックダウン後、`grants.commissioning === false`）                                                                                                                                                        | `none` のまま（ガードは /login へ）。試運転は復活しない                                                                                                                                                      | —          |

### 4.8 `superseded` を受けた `load`

| 番号 | 順序                                                                                                      | 期待                                                                                                                                                                                   | 不変条件  |
| ---- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| S-48 | `load` の `resolve()` が probe(1) 待ち → 別のログイン B（provider が通知 → 保留）→ 要求は `superseded`    | `load` は今の generation を返さない。`resolveSettled` が要求し直し（probe(2)）、B が `confirmed` になったら**B の generation** を返す。旧 owner のページデータは作り直す（世代ゲート） | I-16      |
| S-49 | S-48 で、確認が期限（`resolveSettled` の `deadlineMs`）内に確定しない（遷移が続く、または reject が続く） | `unverified` として再試行画面へ。generation は返さない                                                                                                                                 | I-8・I-16 |
| S-50 | S-48 で、`load` を出した navigation を SvelteKit がすでに破棄している                                     | `resolveSettled` の結果は捨てられる（SvelteKit の挙動）。controller の状態はどの場合も最新の確認だけで決まっているので、破棄されても害は無い                                           | I-1・I-16 |

### 4.9 レビューで加わった順序と、「状態を書き換える入口 × 非同期の境界」の洗い出し

| 番号 | 順序                                                                                                                                                                                                                                                 | 期待                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 不変条件        | 由来                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------- |
| S-51 | ヘッダーのログアウト: `await provider.logout()`（遅い）→ その間にログイン B が完了し `resolve()` で B 確定 → ログアウトの継続が再開                                                                                                                  | 継続は `end()` を**呼ばない**。`resolveSettled()` を呼ぶ → B が `confirmed` → `goto(login)` もしない（`snapshot.status === 'active'` なので画面はそのまま）。provider の logout は CAS 不成立でトークンを消していない。B の保存状態も残る                                                                                                                                                                                                                                                                                        | I-10・I-18      | レビュー 1             |
| S-52 | `resolve()` → `none`（t0）→ `status()` 待ち → ログイン B 完了・`resolve()` で B 確定 → `status()` が `viewerPublic: true` を返す                                                                                                                     | 発行を**始める前**の `isCurrent(t0)` が偽 → 発行しない → `resolveSettled()` の `ResolveResult` を返す → B のまま。仮に照合を通ってしまっても `enterPublicViewer({ expectRevision: r0 })` の CAS が B のトークンを守る（二重の防御）                                                                                                                                                                                                                                                                                              | I-7・I-18       | レビュー 2             |
| S-53 | banto-hub: ticket t0 → `fetchCommissioningStatusOrNull()` 開始 → 別の判定が lock-down を確定し `end('commissioning-locked', t1)` → 古い取得が「迂回可」を返す → `adopt(C, 'commissioning', t0)`                                                      | `adopt` は t0 が current でない（`end` で epoch が進んだ）ので**何もしない**（`false`）。試運転は復活しない。方針は**新しい ticket で方針の確認から期限付きでやり直す**（§6.2 の policy runner）。やり直しの上限に達したら `PolicyExhaustedError` の `unverified`（S-70 と同じ。`resolveSettled()` には落とさない）                                                                                                                                                                                                              | I-13・I-18      | レビュー 3             |
| S-54 | 同じセッション A で `resolve()` を続けて 3 回呼ぶ。間に A の **display_name** を変える（Tauri。`auth_resolve` のたびに `settle_session` が refresh で書く）                                                                                          | 3 回とも `confirmed`、generation は同じ、identity の name は更新される。`seq` は refresh では進まない（`checked === current`、`credentialRevision` 不変）ので probe は破棄されない。（`seq` を書き込みごとに進めると、自分の応答を破棄し続けて上限に達する）                                                                                                                                                                                                                                                                     | I-11・I-2       | レビュー 4、統合修正 9 |
| S-55 | Tauri: `auth_login(B)` が成功（応答に `seq`）→ provider は応答の `seq` で revision を更新し `onCredentialChanged` → 続く `auth_resolve` が 500 / 無応答                                                                                              | 通知は済んでいるので controller は保留（`unknown`、+1）。`resolve()` は `unverified`。**A は active に残らない**（S-23 と同じ）。再試行で B が確定                                                                                                                                                                                                                                                                                                                                                                               | I-5・I-19       | レビュー 5             |
| S-56 | A の probe(1) 待ち → 資格情報が B に → probe(2) で B 確定 → **古い probe(1) が reject（500）で遅れて届く**                                                                                                                                           | probe(1) は採用条件（epoch・revision 不一致）で捨てる。B の確定状態も `verification` も変えない（`unknown` に戻さない、`failed` にしない）。期限切れの probe の reject も同じ                                                                                                                                                                                                                                                                                                                                                    | I-3             | レビュー 6             |
| S-57 | 起動直後（epoch 0）に最初の `resolve()` → probe(1) が A を返す → `commit` で epoch 1                                                                                                                                                                 | 要求は `confirmed`（判定は probe の `epochAtStart` = 要求時の epoch で行う）。返す snapshot は commit 後（generation 1、owner A）。`superseded` にならない                                                                                                                                                                                                                                                                                                                                                                       | I-20            | レビュー 8             |
| S-58 | 最後の signal → probe(1) 開始 → `resolve({ cause: 'signal' })` を**直接**呼ぶ（banto-hub の `probeSessionAfterReconnectFailures` の移行の形）                                                                                                        | 要求自体が signal の stamp を進めるので、probe(1) には合流しない。probe(2) を出し、その答えで確定。`unverified` なら S-33 の退避ループが続く                                                                                                                                                                                                                                                                                                                                                                                     | I-9             | レビュー 9             |
| S-59 | 別タブで**同じ A** として再ログイン（remember の書き換え）                                                                                                                                                                                           | 保留（unknown、+1）→ generation の照合で再 load → A を確定（+1、合わせて +2）→ 画面は新しい generation で作り直される。owner は同じなので**通知しない**。世代ゲートが画面を隠し続けない                                                                                                                                                                                                                                                                                                                                          | I-2・I-5        | レビュー 7             |
| S-60 | A → B の背景の確認（`storage` イベント起点）が 500                                                                                                                                                                                                   | 保留の generation の変化で再 load → `resolveSettled` が `unverified` → `error(503)` の再試行画面。空画面で止まらない（S-36 と同じ。自動では復帰しない）                                                                                                                                                                                                                                                                                                                                                                          | I-5             | レビュー 7             |
| S-61 | Tauri: `load` が `getAuthSettings()`（`auth_config_get`）を await → その間にログイン不要モードが切り替わる → 古い応答で `sessionStore.authDisabled` を代入                                                                                           | `authDisabled` を別読みしない。`auth_resolve` が `kind: 'local'` を返し、`authDisabled` は `snapshot.kind === 'local'` からの `$derived` にする（§5.3、§6.1）。洗い出しで見つけた同じ型                                                                                                                                                                                                                                                                                                                                          | I-12・I-18      | 洗い出し               |
| S-62 | **S-53 の逆向き**: C が active → ticket t（adopt 中なので epoch だけ）→ 状態の取得を開始 → 別タブのログインで `credentialRevision` が変わる（S-46: C は維持、`pendingBackground` だけ）→ 「lock-down 済み」の応答 → `end('commissioning-locked', t)` | `end` は t の epoch が current なので**成功する**（revision の変化では失効しない、I-21）→ none（+1）→ `resolveSettled()` が `pendingBackground` の確認と合わせて A を確定（none は保留に移らないので unknown を経ず、none → active(A) で +1。合わせて +2、§3.1）。終了条件を取得できたのに試運転が続くことは無い                                                                                                                                                                                                                 | I-21・I-13      | オーナー 3 回目 1      |
| S-63 | **S-2 の出し直しが reject**: A active（r0）→ probe(1) 待ち → 資格情報が B（r1）に。provider は `onCredentialChanged` を出す → 保留（unknown）→ probe(1) は捨てる → 出し直した probe(2) が 500                                                        | A は `unknown` のまま（保留が先に立っている）。要求は `unverified`。**A が active に残らない**。仮に provider が通知を怠っても、controller は手順 0 の「最後に反映した revision と今の revision の差」で保留に移す（防御）                                                                                                                                                                                                                                                                                                       | I-5・I-3        | オーナー 3 回目 3      |
| S-64 | Tauri: ログイン済み A の **role** を `users_update` で変える → `resolve_body`                                                                                                                                                                        | `UsersService::update_user` は `auth_epoch` を進める（ADR-0014）ので、`settle_session` は失効として `None` を書き、`seq` は**進む**。`resolve_body` は `none`（新しい role の active ではない）。REST も `200 null`（S-9）。**refresh（S-54）とは別のテスト**                                                                                                                                                                                                                                                                    | I-11            | オーナー 3 回目 4      |
| S-65 | HTTP: `resolve()` が none を確定してトークンを消した（`current !== checked`）答えが**採用される**（S-5・S-25 と同じ状況）                                                                                                                            | 1 回の `commit(none)`（+1）。`onCredentialChanged` は出ていないので保留を経ない。待機者は `confirmed`                                                                                                                                                                                                                                                                                                                                                                                                                            | I-3・I-19       | 統合修正 2             |
| S-66 | none を確認 → 公開閲覧トークンの発行に成功（provider が通知。none なので保留せず `pendingBackground` だけ）→ 最後の `resolveSettled()` が 500                                                                                                        | 方針は `{ outcome: 'unverified', snapshot: none }` を返し、呼び出し元は `outcome` を先に見て **503 の再試行画面**（`status === 'none'` だからといってログイン画面へ redirect しない）。ticket が失効したときの再確認（S-52）も同じ扱い                                                                                                                                                                                                                                                                                           | I-4・I-8        | オーナー 3 回目 2      |
| S-67 | Tauri の auth-disabled モードで `auth_logout`（no-op、`{ seq }` は同じ値）                                                                                                                                                                           | provider は revision が変わらないので通知しない（I-19）。controller は保留に入らず、`local` の active のまま                                                                                                                                                                                                                                                                                                                                                                                                                     | I-11・I-19      | 統合修正 11            |
| S-68 | Tauri: `auth_change_password` 成功（rebind、応答の `seq` は進む）→ provider が通知 → 保留 → `resolve()` で同じ A を確定                                                                                                                              | generation は unknown を経て +2、owner は同じなので通知しない（S-59 と同型）。REST 側は自分のトークンが `AuthState` で rebind されるので `resolve()` は A のまま                                                                                                                                                                                                                                                                                                                                                                 | I-11・I-19      | 統合修正 12            |
| S-69 | S-46 の続き: C が adopt 中 → 別タブのログインで revision が r0→r1（`pendingBackground` だけ）→ **次の `resolve()`**                                                                                                                                  | 手順 0 の差の検知は adopt 中なので保留しない（`pendingBackground` を立てるだけ）→ 手順 1 で C を `confirmed`。C は `unknown` にならず generation も据え置き。`end()` の後の `resolve()` で初めて A を確定                                                                                                                                                                                                                                                                                                                        | I-13・I-21      | 4 回目 1               |
| S-70 | policy runner: C が adopt 中 → 試運転状態の取得が応答しない → 期限（`deadlineMs`）で方針の abort、または `maxRounds` を使い切る                                                                                                                      | runner は `{ outcome: 'unverified', error: PolicyTimeoutError \| PolicyExhaustedError, snapshot }` を返す（既存の snapshot は保つ）。`resolveSettled()` に落として active(C) を `confirmed` にしない。`guard` では `load` が 503 の再試行画面、`recheck` では「確認できない」（再接続を続ける）                                                                                                                                                                                                                                  | I-8・I-13       | 4 回目 2               |
| S-71 | ストリームの再確認（`probeSessionAfterReconnectFailures`）: C が adopt 中 → 試運転状態の取得が失敗（通信の失敗・500 → `null`）                                                                                                                       | **`mode: 'recheck'` は `status === null` で `end` も `adopt` もせず `unverified`** を返す（取得の失敗と「終了が確定した」を区別する。今の `sessionRecheck.ts` 86-97 行と同じ）。C と保存状態は残る。`mode: 'guard'`（ルートガード）は今のとおり取得の失敗を「迂回しない」に倒し、adopt 中なら `end` してから通常の確認へ                                                                                                                                                                                                         | I-4・I-13       | 4 回目 3               |
| S-72 | `pendingBackground` が立った状態で HTTP の `resolve()` が応答しない → `timeoutMs` で打ち切り → 退避 → 新しい probe → また応答しない（繰り返し）                                                                                                      | 打ち切った probe は**そのたびに abort**される（`pendingBackground` が立っていても）。未完了の `fetch` は常に 1 本以下。背景の確認は新しい probe で続く                                                                                                                                                                                                                                                                                                                                                                           | I-22            | 4 回目 4               |
| S-73 | Tauri: A の `auth_resolve`（`seq_at_entry` 1）の応答が遅れる → B の `auth_login` が seq 2 で完了・provider は `observedSeq` を 2 にして通知・controller が B を確定 → **古い応答（`checked: 1, current: 1`）が届く**                                 | provider の revision `(observedSeq, local)` は `(2, l)` のまま（`observedSeq` は max でしか動かない）。答えの `checked` は `(1, l)` で `revisionAtStart` `(2, l)` と不一致 → 捨てる。次の `resolve()` の手順 0 は差を検出しない（B のまま）。操作の応答が逆順で届いても同じ（`observedSeq` は max）                                                                                                                                                                                                                              | I-23・I-3       | 4 回目 5               |
| S-75 | Tauri: `auth_login(B)` を invoke（Rust では seq 1→2 で完了）→ 同時に出していた `auth_resolve`（`seq_at_entry` 1、Rust では login より前に settle 済みで none、`current: 1`）の**応答が login の応答より先に届く**                                    | provider は「待たない」。login は答えが届いた時点で `pendingOps` に残っている（開始が入口の前でも後でも。S-82 は後の順序）ので、resolve の答えは **stale** として `StaleAnswerError` で reject → controller は通信の障害と区別し、`verification` を変えずに新しい probe を出す（退避・上限あり）。login の応答で `observedSeq` が 2 になり通知（none なので保留せず `pendingBackground`）→ 新しい probe で **B を確定**。**none は採らない**                                                                                     | I-23・I-3・I-19 | Fable P1-1、5 回目 1   |
| S-76 | 同じタブで A がログアウト（none、`previousActiveOwner` は null に戻る）→ B でログイン → active(B)                                                                                                                                                    | `previousActiveOwner` は null なので `pendingOwnerChange` は立たず、owner の差分の通知（#257）は**出ない**（別タブの切り替えではなく、このタブの操作）。unknown を挟む S-59/S-35 では `previousActiveOwner` を保つので `pendingOwnerChange` が立つ                                                                                                                                                                                                                                                                               | I-12            | Fable P2-1             |
| S-77 | Tauri: `auth_resolve` が `seq_at_entry` を読んだ後、DB を読む間に別のコマンドが `seq` を進めた                                                                                                                                                       | `settle_session` は 1 つのロックの中で seq の一致を見て、動いていれば**何も書かず** `stale` を返す。応答は `{ stale: true }` で provider が `StaleAnswerError` で reject → controller は**通信の障害と区別**し、`verification` を変えずに新しい probe で確認し直す（S-75 と同じ経路）。`current !== checked` ⇔ この呼び出しが消した、が常に成り立つ                                                                                                                                                                              | I-11・I-23・I-3 | Fable P1-1、5 回目 1   |
| S-78 | Tauri: `auth_login(A)` の invoke が**応答しない** → その間に `auth_login(B)` が成功（seq 2、応答が届く）→ `resolve()`                                                                                                                                | A は `pendingOps` に残っているので resolve の答えは stale → 出し直し…が、**A の pending は `opPendingTimeoutMs` で期限切れ**になり「結果が分からない」として `local` を +1・通知・塞ぐ対象から外れる → 次の probe で **B を確定**。A の invoke が後から応答したら `observe(seq)`（max なので動かない）と CAS の結果（Rust は superseded）で扱う。**A が応答しないまま、B の成功後の状態を確認できる**。後続の logout の確認も塞がれない                                                                                          | I-23・I-19      | 5 回目 1               |
| S-79 | **実装-2 を単独でマージした状態**で S-35 の順序: A/g1 を表示中 → 別タブのログイン → `storage` 通知で unknown/g2 → 背景の確認で B/g3（none を一度も経ない）                                                                                           | 実装-2 に前倒しした配線①（`$effect` の generation の照合）が g1 ≠ g3 を見て `invalidateAll()` → `load`（委譲版）が B を確定。`onSessionEnded` は呼ばれないが、世代ゲートが子画面を隠し続けない                                                                                                                                                                                                                                                                                                                                   | I-14            | 5 回目 2               |
| S-80 | **実装-2 を単独でマージした状態**で S-59 の順序: 別タブで同じ A として再ログイン（unknown を経て A/g+2）                                                                                                                                             | 配線①が再 load、画面は新しい generation で作り直される。通知は出ない                                                                                                                                                                                                                                                                                                                                                                                                                                                             | I-14            | 5 回目 2               |
| S-81 | A → B の確認が 500 → 503 の画面（保護レイアウトは unmount、購読なし）→ 背景の確認で B が確定（`pendingOwnerChange = { from: A, to: B }`）→ 利用者が再試行 → guard が B を**同じ値で再確認** → レイアウトが mount                                     | 同じ値の再確認は `pendingOwnerChange` を**上書きしない**（`previousActiveOwner` は「今の状態の直前の owner」で B に更新されるが、未処理の変更は別に保持）。mount 時に `snapshot.pendingOwnerChange` を見て通知／`ownerChangePolicy: 'relogin'` を実行し、`acknowledgeOwnerChange()` で消す。**保証する「再試行」は controller を維持した画面内の再読込**（503 画面の「再試行」ボタンを `invalidateAll()` にする、§6.1）**だけ**。ページ全体の再読込（`location.reload()`）では controller ごと消えるので通知を保証しない（I-24） | I-12            | 5 回目 3               |
| S-82 | **S-75 の逆の開始順**: `auth_resolve` が Rust で `none, checked=1, current=1, stale=false` に settle（応答はまだ）→ **その後に** `auth_login(B)` が始まり Rust で seq 2 に設置（応答はまだ）→ 古い resolve の応答だけが先に届く                      | login は `resolve()` の入口の**後**に始まったが、答えが届いた時点で `pendingOps` に残っているので **stale**（`StaleAnswerError`）→ 古い none を採らない。login の応答で `observedSeq` 2・通知 → 新しい probe で B を確定。（`startedAt < entryAt` の条件では、`observedSeq` も 1 のままで採用条件を通ってしまい、保存状態の消去とログイン画面への遷移を起こす）                                                                                                                                                                  | I-23・I-3       | 6 回目 1               |
| S-83 | 未処理の変更あり（`pendingOwnerChange = { A → B }`、503 の画面で購読なし）→ 別タブのログアウトを背景で確認して **none** が確定 → 503 画面のホームリンク（同じ document）→ guard → /login → 本人が **C** で明示的にログイン → C のレイアウトが mount  | `none` の確定で `pendingOwnerChange` は**破棄**される（I-24）。C の確定では `previousActiveOwner` が null なので新しい変更も立たない。mount 時に通知も `ownerChangePolicy: 'relogin'` も**実行しない**（成功したばかりの C のログインをログイン画面へ戻さない）                                                                                                                                                                                                                                                                  | I-24・I-12      | 6 回目 2               |
| S-74 | **実装-2 を単独でマージした状態**で S-34 の順序: `load` が A/世代 g を返す → mount 前に none/g+1 が確定 → レイアウトが mount                                                                                                                         | 実装-2 に前倒しした配線①が mount 時に g ≠ g+1 を見て `invalidateAll()` → `load` が `none` → ログイン画面へ。`onSessionEnded` の購読時の通知（none なら非同期に 1 回）も同じ結果を出すが、実装-2 の `+layout.svelte` は配線①を使う。世代ゲートが子画面を隠したままにならない                                                                                                                                                                                                                                                      | I-14            | 4 回目 6、5 回目 2     |
| S-84 | Tauri: webview の再読み込みで provider の `observedSeq` が 0 に戻った（Rust の `seq` は 5）→ 最初の `resolve()` の答えは `checked: 5`・`current: 5` で、provider はそれを観測して revision が `5.x` になる | 答えは `checked` ≠ `revisionAtStart` で**捨てる**（I-3 のまま）が、今の revision が答えの `current` と一致する（provider が観測で追いついた）ので、次の probe は `maxStaleRetries` を**消費しない**（1 回の要求の連鎖で 1 回だけ、`catchUpUsed`）。次の probe の答えで確定 | I-3・I-23 | 実装-2（§10 (a)） |
| S-85 | Tauri: A が active → 通常のデータ系コマンドが失効した A を Rust で消して `seq` を進めた（provider は観測していない）→ `resolve()` の答えは `none`・`checked = current = 新しい seq` | 捨てた直後の差の検知（手順 0 と同じ）で**先に保留**（unknown、I-5）→ 要求は `superseded`（`resolveSettled` は要求し直す）→ 背景の確認で `none` を確定。上限は消費しない。確認が失敗しても A は active に戻らない | I-5・I-23 | 実装-2（§10 (a)） |
| S-86 | S-84 の追いつきの後も revision が動き続ける | 追いつきの無償の出し直しは 1 回だけ。以降は通常どおり数え、上限で `unverified`（`SessionChangedError`）。無限に出し直さない | I-3・I-9 | 実装-2（§10 (a)） |
| S-87 | `kind` を返さない provider（HTTP・互換 adapter）の `active` | `identity.publicViewer === true` なら `publicViewer`（owner `public-viewer`。provider の `kind` より優先）、それ以外は provider の `kind`、無ければ `account`。Tauri の `local` はそのまま（owner `local`） | I-2・I-12 | 実装-2（§10 (b)） |
| S-88 | none を確認（ticket t）→ 方針が `status()` を待つ間に、別の `load` が同じ none を再確認 | 純粋な再確認は commit しない（epoch 据え置き）ので t は current のまま。2 つの方針が互いの ticket を無効にし合って上限を使い切る（livelock）ことが無い。E2E のログアウト（ログアウトの遷移と配線①の再 load の同時実行）で見つかった | I-18・I-2 | 実装-2 |
| S-89 | provider A で Alice が active → `initBanto({ authProvider: B })`（別の provider への再 bind）→ B は none | 再 bind は**外からの遷移**: 在中の probe は abort・待機者は `superseded`、旧 provider の購読を解除、`commit(unknown)`（epoch が進み旧 ticket は失効、active からなので generation +1）、`appliedRevision` は B のもの、`pendingBackground` で B に確認。A からの遅れた答えは provider の照合で採用しない。B の答えで none（+1） | I-1・I-18・I-20 | #265 オーナーレビュー P1 |
| S-90 | S-89 で B が Bob を返す | Bob を確定（+2）。`previousActiveOwner`・`pendingOwnerChange` は持ち越さない（別の認証源の owner は比べない）ので通知の対象にならない。A の `onCredentialChanged` はもう届かない | I-24・I-12 | #265 オーナーレビュー P1 |
| S-91 | 同じ provider で再 bind（`initBanto` の再呼び出し） | 何もしない（snapshot・epoch・probe は据え置き）。最初の bind（まだ provider が無い）も遷移にしない | I-2 | #265 オーナーレビュー P1 |
| S-92 | `active(A) → active(owner なし) → active(B)`、および `A → owner なし → A` | owner の無い active（S-10）は owner の変化の判定の対象外（最後の具体的な owner を保つ）。前者は `{ A → B }`、後者は立てない（`A → B → owner なし → A` なら未処理の変更は消える） | I-24・I-12 | #265 オーナーレビュー P2 |
| S-93 | 公開閲覧（P、S-42）の画面からヘッダーの「ログイン」で A として自分でログイン（同じタブ。ログインの通知で保留 → `active(A)`）。または公開閲覧のタブに別タブの A のログインが届く | `pendingOwnerChange` を**立てない**（公開閲覧はユーザーではない。owner の変化の判定の対象外で、最後の具体的な owner を更新しない）。通知も `'relogin'` も出ない。逆向き（A → P）は必ず none を経るので影響なし | I-24 | 実装-3 の独立監査 P2-1 |
| S-107 | ログイン不要モード（`kind: 'local'` の合成セッション）の `active`：`A → local`（Tauri の設定でログイン不要を有効化、S-94）、`local → local`（役割の変更、S-96）、`local → B`（その前に具体的な owner が無い場合）、`A → local → A` | `pendingOwnerChange` を**立てない**（合成セッションはユーザーではなく端末の状態。S-93 の公開閲覧と同じ扱いで、判定の対象外・最後の具体的な owner を更新しない）。「別のユーザーでログインされました」は出ない。`A → local → B`（none を経ない）が起きれば、最後の具体的な owner の A と B を比べて `{ A → B }`。ログイン不要の解除は none を経る（S-99）ので履歴は消える | I-24 | #291 |
| S-108 | `kind !== 'account'` の active 全般（公開閲覧 S-93、ログイン不要 S-107 に続き、アプリが `adopt()` で確定する試運転の合成セッション `kind: 'commissioning'`、今後増える kind）：`A → commissioning`（none を経ない `adopt`）、`commissioning → A`（`end` の後の確認が none を挟まずに A を返す場合を含む）、`commissioning → commissioning` | `pendingOwnerChange` を**立てない**（比べるのは `kind === 'account'` の active だけで、列挙で除外しないので kind が増えても漏れない。判定の対象外・最後の具体的な owner を更新しない）。「別のユーザーでログインされました」は出ない。`A → commissioning → A` は何も出ない。`A → commissioning → B`（none を経ない）は最後の具体的な owner の A と B を比べて `{ A → B }`。`end` は none を確定するので履歴は消え、その後の `none → B` は立てない（S-76）。`kind` を持たない provider の答えは `account` として従来どおり比べる | I-24 | #308 |
| S-94 | Tauri: 管理者 A がアカウントでログイン中（`Account(A)`、seq N）→ 設定画面で `auth_config_apply(true, role)` （保存の直後、`await` を挟まずに rebind）→ 画面の `invalidateAll()` → `auth_resolve` | スロットは `AuthDisabledLocal(role)`、seq N+1。監査は `settings_change`・A の `logout`（`detail: { reason: "auth_disabled" }`）・合成の `login`。provider はこの前進を観測していないので最初の答えは捨てられ、S-84 の追いつきの後の確認で `kind: "local"` が確定し `sessionStore.authDisabled` が真。`login` の開始（seq N を読む）→ この rebind → `login` の完了、の順なら login は `superseded` で Local を Account に戻さない。`Local → Local` は role が変わるなら seq +1、同じ role なら何も書かない（S-96） | I-11・I-12・I-7 | #266 オーナーレビュー P1 |
| S-95 | Tauri: ログイン不要モード中に `auth_login`／`auth_setup`（入口で disabled）。または `auth_login(A)` の検証中・`auth_setup` のアカウント作成中に `auth_config_apply(true)` が完了 | 入口で disabled なら検証・作成の前に拒否（`LoginResult { success: false, superseded: false, error }`、seq 不変、監査なし、setup はアカウントを作らない）。検証・作成の後は `auth_config_lock` の中でモードを読み直し、disabled なら設置せず拒否（Local のまま、seq 不変。監査は決定 7 のまま検証成功の `login`／作成の `setup` が残り、setup のアカウントは作られたまま）。login が先に確定したときは Account → apply(true) の rebind で Local（S-94）。どちらの順序でも`auth.disabled` ⇔ Local が成り立つ | I-11・I-7 | #266 オーナー決定 |
| S-96 | Tauri: Local(admin)、seq N → 古い `auth_resolve` がスロット（seq N）と設定（role admin）を読んで保留 → `auth_config_apply(true, viewer)` → 古い resolve が settle | role の変更は seq を N+1 に進めるので、古い settle は `Stale` で何も書かず、Local(viewer) に admin を書き戻さない。provider は `StaleAnswerError` で捨てて新しい probe で viewer を確定する。同じ role の再適用は何も書かない（seq 不変）。監査は apply の `settings_change` だけ（Local のままなので logout/login は無い） | I-3・I-11・I-23 | #266 再レビュー P1 |
| S-97 | Tauri: S-96 の順序で、古い `auth_resolve` の答えが `stale: true, current: N+1` で届く（provider に pending の操作は無い）→ 次の確認が失敗（IPC の失敗・500） | provider は `current` を観測して revision を N+1 にしてから `StaleAnswerError` で reject（通知しない）。controller は捨てた直後の差の検知（revision ≠ `appliedRevision`）で Local(admin) を保留（unknown、generation +1、待機者は `superseded`）し、背景の確認を出す。それが失敗しても admin は active に戻らない（unknown・`verification.failed`）。stale が続いても、保留の後は`maxStaleRetries` で数えられ、上限の後は退避で続く（無限ループしない）。答えが probe の期限の後に届いた場合も同じ（S-101） | I-3・I-5・I-23 | #266 再レビュー P1 |
| S-98 | Tauri: Local(admin)、seq N → 古い resolve A が admin を読んで保留 → `auth_config_apply(true, viewer)` が保存した直後（rebind の前）に、別の resolve B が設定から viewer を読み、settle の refresh で slot を Local(viewer) にする（seq N のまま）→ apply の rebind → A の settle | apply は保存前の設定（disabled・admin）と比べて役割が変わったので、slot が既に viewer でも seq を N+1 に進める。A の settle は `Stale` で admin を書き戻さない。settle の refresh 側で seq を進める案は I-23 の「`current ≠ checked` ⇔ この呼び出しが消した」を壊すので採らない | I-3・I-11・I-23 | #266 再レビュー P1 |
| S-99 | Tauri: disabled=true・Local(admin)、seq N → 古い resolve が slot と設定（disabled=true）を読んで保留 → `auth_config_apply(false)` → 設定画面の `invalidateAll()` → 古い resolve の settle | apply(false) は保存の直後に await を挟まず Local を終了（None、seq N+1、監査 `logout` の `detail: { reason: "auth_enabled" }`）。古い settle は `Stale` で `local` を確定しない。次の resolve は `none`（provider は S-84 で追いつく）→ /login。`false` の再保存（既に false）は何もしない（seq 不変）。slot が None・Account なら触らない | I-3・I-11 | #266 再レビュー P1 |
| S-100 | Tauri: Account(admin)、revision N → `changePassword` が pending → Rust で seq N+1（apply(true) 相当）→ `auth_resolve` が `stale: true, current: N+1` → `changePassword` が forbidden で失敗（seq の応答なし）→ 次の確認が失敗 | provider は pending 中の `current` を `deferredSeq` に保留し、最後の pending の操作の終了時に回収して revision を N+1 にし、通知を 1 回出す → controller は Account(admin) を保留（unknown）→ 次の確認の失敗でも admin は active に戻らない。操作が `{ seq }` を返すときは、その観測の後に回収するので通知は 1 回（seq が保留より新しくても同じでも）。期限切れ（local +1）とも 1 回にまとめる。pending が複数なら最後の 1 つまで保留 | I-5・I-19・I-23 | #266 再レビュー P1 |
| S-101 | Tauri: Local(admin) active（appliedRevision 5.0）→ resolve の probe が期限切れ（unverified、active のまま）→ apply(true, viewer) で seq 6 → 遅れて `stale: true, current: 6`（または非 stale の `checked = current = 6`） | 捨てた probe の答えでも provider が seq を観測したら、`onProbeSettled` の `probe.done` の分岐でも差の検知を行い、active なら保留（unknown）、そうでなければ背景の確認を出す（この答え自身の消去か差のあるときだけ。既存の退避は崩さない） | I-5・I-23 | #266 鮮度の集中監査 P2-1 |
| S-102 | Tauri: 確認が Local(admin) を読んだ後に apply(true, viewer) → 通常のコマンドの `current_session` の settle が `Stale` | `valid_now` は読み値の `fresh` ではなく slot の今の値（Local(viewer)）を返す（binding が同じとき）。admin 専用のコマンドが古い role で 1 回だけ通ることがない | I-3 | #266 鮮度の集中監査 P3-2 |
| S-103 | Tauri: admin が汎用の `settings_set` で `auth.disabled`／`auth.disabled_role` などを直接書こうとする | `auth.` 前置のキーは `BadRequest` で拒否（`auth_config_apply`／`autologin_*` を案内）。それ以外のキーは従来どおり。`apply(true)` は (disabled, role) の組が変わったら slot が既に Local でも必ず seq +1 | I-11 | #266 鮮度の集中監査 P2-2 |
| S-104 | Tauri: `auth_config_apply` の保存が途中で失敗（`auth.disabled` だけ書けてエラー） | `set_auth_config` は 1 トランザクション（`set_many`）。それでも保存の失敗時は保存済みの設定を読み直して rebind／Local の終了を行ってからエラーを返す（防御） | I-11 | #266 鮮度の集中監査 P2-3 |
| S-105 | HTTP: 確認の要求中に別タブがトークンを書き換え、storage イベントがまだ届かない | 答えは古いトークンについてなので `StaleAnswerError`（revision は動かさない）。controller は新しい probe で確認し直す | I-3・I-23 | #266 鮮度の集中監査 P3-3 |
| S-106 | HTTP: `changePassword` が 401 | 送ったトークンを compare-and-set で消して通知する（Tauri の unauthorized と同じ扱い） | I-19 | #266 鮮度の集中監査 P3-4 |

**「状態を書き換える入口 × 非同期の境界」の表**（今回の指摘と同じ型が残っていないかを洗った。
実装の PR のレビューでも同じ表を使う）:

| 入口（状態を書く場所）                                 | 直前の非同期の境界                                                        | ticket / 照合                                                                                                                                          | シナリオ                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| controller `commit`（probe の fulfill）                | provider `resolve()`                                                      | probe ticket + 答えの `checked`/`current`（採用条件）                                                                                                  | S-1〜S-7・S-12・S-28・S-65 |
| controller `commit`（probe の reject / timeout）       | 同上                                                                      | 同上（**失敗も同じ照合**）                                                                                                                             | S-56・S-30〜S-32           |
| controller `commit`（保留、`onCredentialChanged`）     | provider の操作の応答 / `storage` イベント                                | provider が応答から revision を確定（変わったときだけ通知）                                                                                            | S-55・S-35・S-67           |
| controller `commit`（保留、revision の差の検知）       | `resolve()` の入口 / 答えの破棄                                           | 最後に反映した revision と今の revision。**adopt 中は保留せず `pendingBackground` だけ**                                                               | S-63・S-69                 |
| controller probe の abort                              | `timeoutMs` / 答えの破棄 / 待機者の消失                                   | 打ち切った probe はその時点で abort（`pendingBackground` が立っていても）。waiter の期限では止めない                                                   | S-72                       |
| provider `rev` の更新（Tauri の `seq` の写像）         | `auth_resolve` / 操作の応答（逆順に届きうる）                             | `seq → rev` の対応表。新しく観測した `seq` でだけ `rev` を進め、古い応答で戻さない。`invoke` 失敗は `rev` 側だけ                                       | S-73                       |
| 方針 runner の `end`/`adopt`（試運転状態の取得の後）   | `fetchCommissioningStatusOrNull(signal)`                                  | `SessionTicket` に加え、**`status === null`（取得の失敗）は `recheck` では `unverified`**、`guard` では「迂回しない」に倒す。期限・上限は `unverified` | S-53・S-62・S-70・S-71     |
| controller `pendingBackground` → 背景の `commit(none)` | 捨てた答え（消去を伴う）                                                  | `pendingBackground`（答えでは commit しない）                                                                                                          | S-31                       |
| controller `adopt`                                     | 試運転状態の取得                                                          | `SessionTicket`（adopt 中は epoch だけ）                                                                                                               | S-44・S-53・S-62           |
| controller `end`                                       | lock-down の判定                                                          | `SessionTicket`（adopt 中は epoch だけ）                                                                                                               | S-45・S-53・S-62           |
| （旧）ログアウト後の `endSession()`                    | `provider.logout()`                                                       | **入口を無くす**（`resolve()` で確定）                                                                                                                 | S-17・S-51                 |
| `onSessionEnded` の購読時の通知（旧 unheard の再確認） | レイアウトの mount                                                        | **再 probe をやめ、購読時の `snapshot.status === 'none'` で決めて非同期に 1 回通知**（実装-3 以降は配線①の generation の照合も）                       | S-34・S-74                 |
| provider `setToken`（login / setup）                   | `fetch` / `invoke`                                                        | 開始時の revision                                                                                                                                      | S-40・S-21                 |
| provider `setToken`（enterPublicViewer）               | `status()` → `fetch`                                                      | **呼び出し元の ticket の revision**（`expectRevision`）                                                                                                | S-20・S-42・S-52           |
| provider `setToken(null)`（logout）                    | `fetch` / `invoke`                                                        | 開始時の revision                                                                                                                                      | S-21・S-17                 |
| provider `clearTokenIfCurrent`（resolve が none）      | `fetch`                                                                   | 送ったトークンとの一致。答えの `current` で運ぶ                                                                                                        | S-9・S-31・S-65            |
| provider revision の更新（操作の応答）                 | 操作の応答（login / logout / setup / changePassword / enterPublicViewer） | 応答の `seq` / 自分の書き込み。変わったときだけ通知。応答が無いときは進めて通知                                                                        | S-55・S-67・S-68           |
| 方針の通信（`status()`・試運転状態の取得）             | 方針自身の `AbortSignal`                                                  | 方針の中断は資源の解放。適用の可否は ticket で決める                                                                                                   | S-53・S-62                 |
| Rust `install`（login / setup）                        | `verify` / `setup_first_user` / `record_ok`                               | 入口の `seq`                                                                                                                                           | S-16・S-18                 |
| Rust `clear`（logout）                                 | `auth_config`                                                             | 入口の `seq`（None→None でも進める。auth-disabled の no-op は進めない）。消せたらモードを読み直し、disabled なら消去後の `seq` のまま None のときだけ local を設置                                                                                | S-17・S-19・S-67           |
| Rust `refresh`（settle_session、同じ結び付き）         | `users.get_by_username` / `auth_config`                                   | `unchanged` の照合（既存）。**`seq` は進めない**。同じロックで `(session, seq_before, seq_after)`                                                      | S-54                       |
| Rust `clear`（settle_session、失効。role 変更を含む）  | 同上                                                                      | `unchanged` の照合（既存）。`seq` は進める                                                                                                             | S-64                       |
| Rust `rebind`（auth_config_apply_body）                | `set_auth_config`                                                         | 保存の直後に `await` を挟まず `rebind_local_session`: None・Account(A) → Local で `seq` を進め、Local → Local は role が変われば `seq` +1・同じなら何もしない（入口の `seq` の一致は条件にしない。PR #264 P1。#266 オーナーレビュー P1 で「`is_none()` のときだけ設置」から変更） | —                          |
| Rust `end local`（auth_config_apply_body、false） | `set_auth_config` | true → false のとき保存の直後に `await` を挟まず Local → None（`seq` +1、S-99）。None・Account と false の再保存は何もしない | — |
| Rust `rebind`（change_own_password）                   | `change_password`                                                         | id + auth_epoch（既存）→ `seq` を進め、応答で返す                                                                                                      | S-68                       |
| アプリ `sessionStore.authDisabled`                     | `auth_config_get`                                                         | **入口を無くす**（snapshot の `kind` から導く）                                                                                                        | S-61                       |
| アプリ `load` が返す `sessionGeneration`               | `resolveSettled` / 方針の `ResolveResult`                                 | 確認できた結果の generation だけ。`unverified` を先に処理                                                                                              | S-48〜S-50・S-66           |
| アプリ 配線①の `invalidateAll`                         | `$effect`（generation の照合）                                            | `requestedFor` で同じ generation に二重に出さない                                                                                                      | S-34・S-59                 |
| アプリ `listViewState` の書き込み                      | 画面の操作・保存の応答                                                    | `isCurrent(scope)`（既存）                                                                                                                             | S-27                       |
| アプリ `settings.syncFromProvider()`（M12 の設定）     | UiSettings の読み                                                         | セッション状態ではないが同じ型。**範囲外**（別 issue 候補、§10）                                                                                       | —                          |

## 5. 公開 API の案（型のスケッチ）

名前は仮。**確定するのは契約で、名前は実装の PR で直してよい。**

### 5.1 controller

```ts
export type SessionKind = 'account' | 'publicViewer' | 'local' | (string & {}); // 'local' = Tauri ログイン不要モード。grant の kind はサーバーの登録で増える（'commissioning' など。v3.0.0、ADR-0017）

export interface SessionSnapshot {
	/** unknown = 起動直後、または資格情報の切り替えを知って確認待ち（I-5） */
	readonly status: 'unknown' | 'none' | 'active';
	readonly owner: string | null; // sessionOwnerKey()。active でも id の無い identity なら null
	readonly generation: number; // (status, owner, kind) が変わったときだけ +1（I-2）
	readonly identity: Identity | null;
	readonly kind: SessionKind | null;
	/**
	 * 今の状態の直前に active だった owner。規則: commit で prev.status === 'active' なら
	 * previousActiveOwner = prev.owner、none への commit なら null（unknown を挟むときだけ保つ）。
	 * 値が変わらない commit では listener を呼ばない（S-76）
	 */
	readonly previousActiveOwner: string | null;
	/**
	 * まだ処理していないユーザーの変更（#257 の通知／ownerChangePolicy の対象）。active(B) を commit した
	 * ときに**最後の具体的な owner**（owner の無い active は飛ばす。実装-2、#265 P2、S-92）が null でも B でも
	 * なければ { from, to } を立てる。別の provider への再 bind でも消える（S-90）。同じ値の再確認では
	 * 上書きしない。unknown・同じユーザーの再確認・レイアウトの unmount 中は保持する。消えるのは
	 * none の確定（セッションの終了を越えて持ち越さない。S-83）と acknowledgeOwnerChange() だけ
	 * （レイアウトの寿命に依存しない。S-81。ページ全体の再読込では controller ごと消える = 保証しない）。I-24
	 */
	readonly pendingOwnerChange: { readonly from: string | null; readonly to: string | null } | null;
	/** 直近の確認の状況。確定状態とは別に持つ（原則 2） */
	readonly verification: {
		readonly state: 'idle' | 'verifying' | 'failed';
		readonly lastError: unknown | null;
	};
}

/** SessionScope は今のまま（{ generation, owner }）。保存状態の API との互換のため残す */
export type SessionScope = { readonly generation: number; readonly owner: string | null };

/**
 * 非同期の方針が持ち回る ticket（I-18）。不透明。`epoch`（controller の遷移回数）と `revision`。
 * `isCurrent(ticket)` は両方の一致（v3.0.0: epoch だけの ticket は無い、I-21 の注記）。
 */
export type SessionTicket = { readonly epoch: number; readonly revision?: CredentialRevision };

export type ResolveResult =
	| { outcome: 'confirmed'; snapshot: SessionSnapshot; ticket: SessionTicket } // status は none か active。ticket はこの確定の時点
	| { outcome: 'unverified'; error: unknown; snapshot: SessionSnapshot } // 確定状態は変えていない
	| { outcome: 'superseded'; snapshot: SessionSnapshot }; // 外からの遷移に追い越された（I-16・I-20）

export interface SessionController {
	/** $state に裏打ちされた読み取り。凍結オブジェクト（I-12） */
	readonly snapshot: SessionSnapshot;
	subscribe(listener: (snapshot: SessionSnapshot, previous: SessionSnapshot) => void): () => void;
	/**
	 * この要求について確定を試みる。reject しない（I-8）。
	 * `cause: 'signal'` は signal の stamp を進め、この呼び出しより後に始めた問い合わせでしか
	 * 満たされない（I-9）。`unverified` なら退避付きの背景の確認（S-33）も始まる。
	 * `superseded` は待つ間に外からの遷移が起きたときに、その時点で返る。
	 */
	resolve(options?: {
		cause?: 'navigation' | 'signal';
		timeoutMs?: number;
		signal?: AbortSignal; // 実装-2 で追加: この待機者が離れる（timeoutMs の期限切れと同じ。probe は止めない、I-22）。resolveSettled の deadlineMs が使う
	}): Promise<ResolveResult>;
	/** 失効の可能性の通知。退避付きで確認を回す（今の createSessionEndConfirmation）。同期。reason は自由な文字列（'unauthorized' / 'credentialCleared' / 'app:stream-closed' など） */
	signal(reason: string): void;
	/** 非同期の方針を始める前に取る ticket（I-18）。同期 */
	ticket(): SessionTicket;
	isCurrent(ticket: SessionTicket | SessionScope): boolean;
	// v2.x の adopt(identity, kind, ticket) / end(reason, ticket) は v3.0.0 で削除（ADR-0017）。
	// 資格情報なしのセッションは grantFallback + provider の enterGrant で確定する（§6.1）。
	/** 未処理のユーザーの変更（snapshot.pendingOwnerChange）を処理済みにする。アプリの方針（通知／relogin）が呼ぶ。同期 */
	acknowledgeOwnerChange(): void;
	/** 保存状態の API に渡す scope（今の currentSessionScope / isCurrentSessionScope） */
	scope(): SessionScope;
}

/**
 * `load` 向け: `superseded` の間は要求し直し、`confirmed` か `unverified` だけを返す。
 * `deadlineMs`（既定 timeoutMs と同じ 10 秒）を過ぎたら `unverified`（error は deadline）。
 * 返す generation は、この呼び出しで実際に確認できたものだけ（I-16）。
 */
export function resolveSettled(
	controller: SessionController,
	options?: { cause?: 'navigation' | 'signal'; deadlineMs?: number }
): Promise<Exclude<ResolveResult, { outcome: 'superseded' }>>;

export interface SessionControllerDeps {
	scheduler?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
	/** 単調増加のスタンプ。既定は内部カウンタ。テストが順序を決めるために差し替える */
	clock?: () => number;
	timeoutMs?: number; // 既定 10_000
	maxStaleRetries?: number; // 既定 3（今の MAX_STALE_RETRIES）
	retry?: { initialMs: number; maxMs: number }; // 既定 1_000 / 30_000
	/** none への遷移で保存状態を全消去する関数。既定は listViewState.clearAllListViewState */
	onNone?: () => void;
}

export function createSessionController(
	provider: AuthProvider,
	deps?: SessionControllerDeps
): SessionController;

/** initBanto({ authProvider }) が作る既定の controller。アプリは通常これを使う。`resolve` を持たない provider は initBanto が互換 adapter で包む（実装-2 の時点の足場） */
export function getSessionController(): SessionController;
// initBanto の再呼び出し（実装-2、#265 P1）: 同じ provider なら何もしない。最初の bind は遷移にしない。
// 別の provider への bind は外からの遷移（probe を abort・待機者は superseded・commit(unknown)・新しい provider で確認・
// owner の履歴は持ち越さない。S-89〜S-91）
```

内部の骨格（実装の指針。公開しない）:

```ts
// 1 つの書き手（I-1）。同期。ここ以外で status/owner/generation/identity/kind を書かない。
// epoch は毎回 +1、generation は (status, owner, kind) が変わったときだけ +1（I-2）。
function commit(next: { status; owner; identity; kind }, cause: string): void;
let epoch = 0;
// controller が最後に状態へ反映した provider の revision（保留の検知に使う、I-5・S-63）
let appliedRevision: CredentialRevision | undefined; // 等値比較だけ（I-23）
// 在中の問い合わせ（single-flight、I-9）。abandoned = 期限で打ち切った（I-15）。abort は probe ごと（I-22）
let inflight: {
	startedAt;
	epochAtStart;
	revisionAtStart;
	abandoned: boolean;
	waiters: Request[];
	abort: AbortController;
} | null;
// 直近の signal のスタンプ（I-9）と、まだ新しい probe で処理していない背景の確認の必要
let latestSignalAt = 0;
let pendingBackground = false; // signal / onCredentialChanged / 消去を伴う答えの破棄 で true、確定した probe で false
```

`resolve()` の判定は**同じ継続の中**で行う（`await` を挟まない）:

0. **revision の差の検知（防御）**: `provider.credentialRevision() !== appliedRevision` で、まだ
   保留に入っていなければ、`onCredentialChanged` が来なかったものとして扱う: **adopt 中でなければ**
   保留に入る（I-5、S-63）。**adopt 中は保留せず `pendingBackground = true` だけ**（試運転は
   トークンで決まらない。`onCredentialChanged` の受け口と同じ分岐、I-13、S-46・S-69）。
1. 要求のスタンプ `requestedAt` を取る。`cause: 'signal'` なら `latestSignalAt = requestedAt` にする
   （I-9、S-58）。adopt 中なら `confirmed` を即返す（I-13）。
2. 在中の probe があり、`probe.epochAtStart === epoch` かつ `probe.startedAt > latestSignalAt`
   かつ `!abandoned` なら合流（waiters に加える）。なければ新しい probe を出す（`epochAtStart = epoch`、
   `revisionAtStart = provider.credentialRevision()`、`abort = new AbortController()`、
   `provider.resolve({ signal: abort.signal })`）。
3. **外からの遷移**（`commit` を伴う `end`・`adopt`・保留・別 owner の確定）が起きたら、その
   `commit` の中で、在中の probe の waiters すべてに `superseded`（今の snapshot）を返して空にする
   （I-20、S-14）。probe 自体はそのまま返ってくるのを待ち、4 で捨てる。
4. probe が**fulfill・reject・timeout のどれで**終わっても、まず同じ**採用条件**を見る:

   ```text
   !abandoned
   && epoch === epochAtStart
   && latestSignalAt <= startedAt
   && (fulfill なら answer.checked === revisionAtStart、reject/timeout なら provider.credentialRevision() === revisionAtStart)
   && (fulfill なら provider.credentialRevision() === answer.current)
   ```

   満たさなければ**捨てる**（状態も `verification` も触らない。S-56）。**捨てた答えが消去を
   伴っていれば**（`answer.current !== answer.checked`）`pendingBackground = true`（S-31）。
   **provider が `StaleAnswerError` で reject した**（Rust の `stale`、または pending の操作をまたいだ
   答え。S-75・S-77）ときも同じく捨てる: 通信の障害（手順 6）と区別し、`verification` は変えない。
   捨てた probe は**その時点で abort する**（採用できないと決めた古い通信を残さない、I-22）。
   捨てたら、waiters が残っているか `pendingBackground` なら**新しい probe**を出し直す（上限
   `maxStaleRetries`。超えたら waiters に `unverified`、error は `SessionChangedError`）。
   どちらも無ければ出し直さない。

5. 採用した fulfill: `commit()`（世代の規則は I-2）、`appliedRevision = answer.current`、
   `pendingBackground = false`、waiters 全員に `confirmed`（commit 後の snapshot と `ticket()`）。
   **自分の commit で epoch が進んでも superseded にはしない**（判定は 4 の `epochAtStart` で
   済んでいる。S-57）。
6. 採用した reject: `verification = failed` だけ更新し、waiters に `unverified`。保留の判断は
   ここではしない（保留は `onCredentialChanged` か手順 0 が先に行う）。
7. probe の timeout（`timeoutMs`）: `abandoned = true` にして**その時点で abort し**、waiters に
   `unverified`（error は timeout）。`pendingBackground` が立っていても abort する（背景の確認が
   求めるのは**新しい**確認で、退避の後に新しい probe を出す。古い fetch を残さない、S-72）。
   遅れて届く答えは 4 で捨てる（S-31・S-32）。**1 人の waiter の期限**（`resolveSettled` の
   `deadlineMs`）はこれとは別で、その waiter が離れるだけ。probe は続き、残りの waiters か
   `pendingBackground` が無くなった時点で abort する（I-22）。

`onCredentialChanged` の受け口（provider から同期に呼ばれる）と手順 0 は同じ分岐: **`status === 'active'`
かつ adopt 中でなければ** `commit(unknown)`（保留、I-5、waiters は `superseded`）。それ以外
（none／unknown／adopt 中）は commit せず `pendingBackground = true` だけ（S-42・S-46・S-62・S-69）。
どちらの場合も退避付きの背景の確認を始める（adopt 中は probe を出さず、`end` の後に出る）。
`signal()` も adopt 中は `pendingBackground` と `latestSignalAt` を更新するだけ（4 回目 P3-10）。
`commit` で値が変わらないときは listener を呼ばない（`previousActiveOwner` の規則は §5.1）。

**「adopt 中」と「取得の失敗」の分岐の総点検**（4 回目のレビューの 1〜3 はどれもこの 2 つの分岐の
抜けだった。手順 0〜7・受け口・policy runner のすべてについて確かめた）:

| 手順 / 分岐                           | adopt 中（`kind` が app の adopt）                                                          | 取得の失敗（provider の reject / `status === null`）                                     | シナリオ         |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------- |
| 手順 0 revision の差の検知            | **保留しない**。`pendingBackground` だけ（none／unknown でも同じ。保留は active だけ、I-5） | —（revision の読みは同期で失敗しない）                                                   | S-69・S-42       |
| 手順 1 入口                           | `confirmed` を即返す（probe を出さない）                                                    | —                                                                                        | S-45             |
| 手順 2 合流 / 新 probe                | 到達しない                                                                                  | —                                                                                        | —                |
| 手順 3 外からの遷移                   | `end`/`adopt` 自体は ticket 付きの外からの遷移。waiters は `superseded`                     | —                                                                                        | S-15・S-53       |
| 手順 4 採用条件                       | adopt 中に届いた古い probe の答えは epoch 不一致で捨てる                                    | reject/timeout も同じ条件。捨てるときは状態も `verification` も触らない                  | S-15・S-56       |
| 手順 5 採用した fulfill               | 到達しない（adopt 中は probe を出さない）                                                   | —                                                                                        | —                |
| 手順 6 採用した reject                | 到達しない                                                                                  | `verification.failed` だけ。確定状態は不変（I-4）。保留は作らない                        | S-8・S-26        |
| 手順 7 timeout                        | 到達しない                                                                                  | `abandoned` + abort。`unverified`。確定状態は不変                                        | S-30・S-72       |
| `onCredentialChanged` の受け口        | **保留しない**。`pendingBackground` だけ（none／unknown でも同じ。保留は active だけ、I-5） | —                                                                                        | S-46・S-42・S-66 |
| `signal()`                            | `pendingBackground` と `latestSignalAt` の更新だけ（probe は出さない、P3-10）               | —                                                                                        | S-45             |
| policy runner: 状態の取得             | ticket は epoch だけ（I-21）                                                                | `recheck`: `unverified`（`end`/`adopt` しない）。`guard`: 迂回しない側に倒す（今の挙動） | S-71             |
| policy runner: 期限・上限             | `resolveSettled` に落とさず `unverified`（C を `confirmed` にしない）                       | 同左                                                                                     | S-70             |
| policy runner: `adopt`/`end` が false | 新しい ticket でやり直す（上限あり）                                                        | —                                                                                        | S-53・S-62       |
| `publicViewerFallback`                | 対象外（adopt 中は `none` にならない）                                                      | `status()` の失敗は発行しないだけ。`none` は確定済みで、失敗が終了を作らない             | S-52・S-66       |
| ログアウトの継続                      | `resolveSettled` は `confirmed`（C のまま。試運転にログアウトは無い）                       | `unverified` なら再試行の表示（`end()` しない）                                          | S-51             |

### 5.2 provider 契約（v2 の標準契約、2 階層）

provider は **2 階層**だけ（統合修正 4）: **標準**（`resolve`・`credentialRevision`・
`onCredentialChanged` の 3 つを**型で必須**）と、**互換 adapter**（旧 provider は 3 つとも持たず、
adapter が形だけ埋める）。「revision だけある」階層は作らない。

```ts
/** 不透明な revision。controller は等値比較（===）だけで扱う（I-23）。HTTP: `${counter}.0`、Tauri: `${observedSeq}.${local}` */
export type CredentialRevision = string & { readonly __brand: 'CredentialRevision' };

export type ResolvedAuth =
	| { status: 'none'; checked: CredentialRevision; current: CredentialRevision }
	| {
			status: 'active';
			checked: CredentialRevision;
			current: CredentialRevision;
			identity: Identity;
			kind?: SessionKind;
	  };

export interface AuthProvider {
	// 既存: login / logout / status? / setup? / changePassword?
	// v2 で削除: check / getIdentity（controller は呼ばない。互換 adapter だけが使う）

	/**
	 * 【必須】1 往復でセッションを答える。取得できないときは reject する（§2.1）。
	 * checked = 入口で読んだ revision（この答えが検証した資格情報）。
	 * current = この呼び出し自身の消去を反映した後の revision（消去していなければ checked と同じ）。
	 * none で消去したときは onCredentialChanged を出さず、current で運ぶ。
	 * HTTP: GET /api/auth/identity を 1 回。200 で identity → active、200 null / 401 → none、
	 *       それ以外 → reject。トークンを送って none なら、そのトークンを compare-and-set で消す。
	 * Tauri: auth_resolve（§5.3）。kind を返す（'account' | 'local'）。
	 * stale: 「Rust の stale: true」または「答えが届いた時点で、未完了の状態を変える操作が 1 つでもある」
	 *        （操作の開始が入口の前でも後でも）ときは StaleAnswerError で reject する（通信の障害とは別の型。
	 *        controller は verification を変えずに新しい probe で確認し直す。S-75・S-77・S-82）。待たない。
	 *        操作の pending には期限があるので、永久に stale が続くことはない（S-78）。
	 * signal: controller の probe ごとの AbortSignal（I-22）。中断できなければ無視してよい。
	 * reject しても revision は進めない（I-19、S-26）。
	 */
	resolve(options?: { signal?: AbortSignal }): Promise<ResolvedAuth>;

	/**
	 * 【必須】資格情報の revision（不透明、等値比較だけ。I-23）。
	 * HTTP: メモリ上のカウンタ。自分が書く・消すたびに +1、storage イベントは storageKey のものだけで +1。
	 * Tauri: (observedSeq, local)。observedSeq は観測した seq の max、local は状態を変える操作の
	 *        invoke の reject のうち、識別できない形と失効系（unauthorized）のときだけ +1（I-19）。
	 * 秘密（トークン本体）は返さない。
	 */
	credentialRevision(): CredentialRevision;

	/**
	 * 【必須】資格情報が変わったら呼ぶ（#257、I-19）: 自分の操作の応答を受けた継続で
	 * （revision の組が変わったときだけ）、別タブの storage イベント（storageKey のものだけ）で、
	 * Rust 側の seq の変化で。resolve() の中の消去と resolve() の reject では呼ばない。戻り値は購読解除
	 */
	onCredentialChanged(listener: () => void): () => void;

	/**
	 * 公開閲覧の発行（HTTP だけ）。`expectRevision` を渡すと、その revision のときだけトークンを
	 * 書く（呼び出し元の ticket に結び付ける、S-42・S-52）。省略時は呼び出しの開始時の revision。
	 */
	enterPublicViewer?(options?: {
		expectRevision?: CredentialRevision;
	}): Promise<{ success: boolean; superseded?: boolean }>;
}
```

`enterPublicViewer` の戻り値は `boolean` から `{ success, superseded? }` に変える（**公開引数を
1 つ足す**。S-52 の保証のため）。

書き込みの compare-and-set（#259、I-7）は provider の**内部**で行う:

- `login`/`setup`: 呼び出しの開始時に `revision` を読み、応答を書くときに一致するときだけ
  `setToken`。一致しなければ書かず、戻り値は `{ success: false, superseded: true }`（`error` も付ける）。
- `enterPublicViewer`: `expectRevision`（無ければ開始時の revision）と一致するときだけ `setToken`。
  加えて**開始時と書き込み直前の両方でトークンが null** であることを条件にする（公開閲覧は資格情報が無いときだけ
  発行する。開始時にトークンがあれば通信せずに `superseded`。ticket の作成後に別タブが書いた窓を塞ぐ、PR #264 再レビュー P1）。
- `logout`: 開始時の revision と一致するときだけ `setToken(null)`。一致しなければ消さない
  （別のログインが済んでいる）。`POST /api/auth/logout` は開始時のトークンで送る（今の
  `headers(false)` は送信時の `getToken()` を読むので、**開始時に固定する**）。戻り値は
  `Promise<void>` のまま（アプリは戻り値で判断せず `resolve()` で確定する、I-10）。
- 上の 4 つとも、**トークンの一致も条件にする**: 開始時の `getToken()` を記録し、書く直前の
  `getToken()` がそれと同じときだけ書く（`expectRevision` を渡された `enterPublicViewer` も開始時の値で
  比べる）。別タブの書き込みは `storage` イベントより先に見えるので、revision だけでは古い操作が書ける
  （storage イベントの遅延対策、PR #264 P2）。
- `resolve()` の `none` でのトークン消去は `clearTokenIfCurrent(token)`（今の `check()` と同じ）。
  消したら内部の数値カウンタを +1 し、その値を不透明な `current` に変換して運ぶ（`current !== checked`）。
  **通知しない**。足し算は provider の内部だけ、外へ出るのは `CredentialRevision`（I-23）。
- **revision の更新と通知**（I-19・I-23）: HTTP は自分が `setToken` した継続でカウンタを +1 し
  `onCredentialChanged` を呼ぶ。`storage` イベントは **`storageKey` のものだけ**で +1（4 回目 P3-11）。
  `key === null`（別タブの `localStorage.clear()`。このトークンも消える）も同じく +1 して通知する（実装-1）。
  旧 `check()`（v1.x で残す）が `401`/`200 false` でトークンを消したときも +1 して通知する（答えで運べない
  変化のため。`resolve()` の中の消去とは扱いが違う。実装-1）。
  Tauri は操作の応答の `seq` で `observedSeq` を max 更新し、**組が変わったときだけ**呼ぶ
  （auth-disabled の logout の no-op、CAS 不成立、逆順に届いた古い応答では呼ばない、S-67・S-73）。
  **状態を変える操作**の応答が得られないとき（Tauri の `invoke` の reject で、エラーの本体が識別できない形）、または応答がスロットを消した可能性のある失効系のエラー（`unauthorized`。`change_own_password` は失効したセッションを消してから `Unauthorized` を返す）のときだけ `local` を +1 して呼ぶ（安全側。controller は
  active なら保留 → `resolve()` で確定する）。それ以外の構造化されたエラーはスロットに書く前に返るので
  進めない（Rust の各 `*_body` と `change_own_password` の doc に「消去の後に返りうるエラー」を明記）。`resolve()` の reject では進めない（I-4/S-26 を破るため。
  HTTP は応答が無いときも進めなくてよい、4 回目 P2-8）。

**互換 adapter**（`adaptLegacyAuthProvider(legacy: LegacyAuthProvider): AuthProvider`、別の
export。自前の `AuthProvider` を持つ派生アプリ向け。決定 2）:

| 保証すること                                                                                                                                                                                                           | 保証しないこと                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve()` の形（`check()` が `false` → `none`、`true` → `getIdentity()` を呼び identity → `active`、どちらかの reject → reject。`checked = current = ADAPTER_REVISION`（定数の `CredentialRevision`、`'0.0'`）固定） | **1 往復ではない**: `check()` と `getIdentity()` の間に資格情報が変わりうる。旧 provider に revision が無いので adapter は検知できない（2 往復の答えが別の資格情報についてのものになりうる） |
| `check()` の `true` と `getIdentity()` の `null` の組み合わせは reject にする（「id の無い active」に潰さない）                                                                                                        | **`check()` の副作用の安全性**: 旧 `check()` がトークンを消す・別のことをするかは adapter には分からない。compare-and-set も保証しない                                                       |
| `login`/`logout`/`setup`/`enterPublicViewer` はそのまま通す（`enterPublicViewer` の `boolean` は `{ success }` に写す）                                                                                                | それらの書き込みが compare-and-set であること（#259 の型の競合は残る）。`expectRevision` は無視される                                                                                        |
| `credentialRevision()` は常に `ADAPTER_REVISION`（`CredentialRevision` 型の定数）、`onCredentialChanged` は購読だけ受けて**呼ばない**（型を満たすだけ）                                                                | 別タブの切り替えの検知（I-5・I-17・I-19 の既定の流れは効かない。手順 0 の防御も効かない）                                                                                                    |

adapter は「型を通すための移行の足場」であり、**旧実装を完全対応として扱わない**。
使う派生アプリは、移行の手順（§6.2）に従って自前の provider に 3 つを実装するか、
admin-core の provider に乗り換える。admin-template の **demo provider（`demo.ts`）は標準に
書き換える**（メモリ上の revision と、`login`/`logout` での通知。実装-3）。

### 5.3 Tauri の Rust 側の API の変更の案

```rust
/// state.auth の置き換え。
struct AuthSlot {
    session: Option<DesktopSession>,
    /// 結び付きを変える意図の操作で +1（I-11）。同じ結び付きの refresh では進めない。
    seq: u64,
}
// AppState { auth: Mutex<AuthSlot>, .. }

/// 1 つのロックの中で「期待した seq のときだけ書き、seq を進める」。値が同じでも進める
/// （logout の None→None は、先に始まった login を無効にするために必要）。
fn cas_session(state: &AppState, expected_seq: u64, next: Option<DesktopSession>) -> (bool, u64);

/// settle_session の置き換え。auth_resolve は最初の .await の前に seq_at_entry（と cached）を読み、
/// DB を読んだ後にこれを呼ぶ。1 つのロックの中で:
/// - seq が seq_at_entry から動いていれば、**何も書かず** Stale を返す（今の 314-325 行は
///   auth != cached なら「消さずに None」を返し、checked/current の意味がずれる。それをやめる）。
/// - 一致していれば、同じ結び付き（same_binding）なら refresh（値だけ置き換え、seq はそのまま）、
///   失効（結び付きが違う、行が無い、auth_epoch が進んだ = role 変更を含む）なら clear（seq を +1）。
/// よって「seq_after == seq_at_entry + 1 ⇔ この呼び出しが消した」が成り立つ（I-23、S-77）。
enum Settled { Stale, Settled { session: Option<DesktopSession>, seq_after: u64 } }
fn settle_session(state: &AppState, cached: &DesktopSession, fresh: Option<DesktopSession>, seq_at_entry: u64) -> Settled;
// Stale のときの扱い（実装-1）: 通常のコマンドの current_session は、今のセッションの結び付きが fresh と
// 一致すれば従来どおり有効として返す（何も書かない。自分の change_own_password の rebind と同時の確認を
// 失効扱いにしないため、#230 のレビュー対応を保つ）。stale を返すのは auth_resolve だけ。
// 実装では Stale { valid_now } として今の結び付きでの判定結果を持たせた。

/// フロントの provider.resolve() の相手。
#[tauri::command]
async fn auth_resolve(state) -> Result<AuthResolveResult, BantoError>;
// AuthResolveResult { identity: Option<Identity>, kind: Option<SessionKind>, checked: u64, current: u64, stale: bool }
//   checked = seq_at_entry（最初の .await の前）、current = seq_after、stale = settle_session が Stale
//   （provider は stale なら reject する）。
//   ログイン不要モードの合成 identity もそのたびにモードと権限を読み直し、kind = "local" を返す。

// 状態を変えるコマンドの応答は seq を含む（I-19）:
// LoginResult  { success, error, superseded: bool, seq: u64 }   -- auth_login / auth_setup
// LogoutResult { seq: u64 }                                     -- auth_logout（今の () から変更。auth-disabled の no-op でも今の seq を返す）
// ChangePasswordResult { seq: u64 }                             -- auth_change_password（rebind で seq を進める。今の () から変更）

// 既存コマンドの変更: 最初の .await の前に seq を読み、書くときに cas_session。
// auth_login  : seq を読む → auth.disabled なら拒否（検証しない。LoginResult { success: false, superseded: false,
//               error, seq: now }、監査なし）→ verify().await → 成功なら監査 "login"（検証成功の時点、§1.7・決定 7）→
//               auth_config_lock を取る（検証の後。argon2 の間は持たない）→ auth.disabled を読み直す → true なら設置せず
//               同じ拒否、false なら cas_session(seq, Some(Account))（書けなければ superseded: true）。順序は
//               auth_config_lock → state.auth（#266 オーナー決定、S-95）。
// auth_setup  : 同上。入口で disabled ならアカウントを作らずに拒否。作成の後に disabled になっていたら、アカウントは
//               作られたまま（監査 "setup"）セッションだけ入れない（superseded と同じ扱い）。
//               これで Account を設置する経路（login・setup。autologin は起動時に disabled と排他、change_password の
//               rebind は Account のときだけ、settle は同じ binding の refresh だけ）はすべて disabled 中は書かない。
// auth_logout : seq を読む → auth_config().await → disabled なら LogoutResult { seq }（no-op、進めない）→
//               cas_session(seq, None) → 書けなければ LogoutResult { seq: now }（何もしない。監査も残さない）。
// auth_config_apply_body: disabled = true の保存の直後（await を挟まず、auth_config_lock の中）に
//               rebind_local_session(role): None → Local と Account(A) → Local は seq +1、Local → Local は role が変われば
//               seq +1（S-96。役割の変化は保存前の設定と比べて決め、slot が先に refresh されていても +1、S-98）、同じ role なら何も書かない（#266 オーナーレビュー P1。以前は is_none() のときだけ設置し、管理者の
//               Account が残って kind が "account" のままだった）。監査は settings_change の後に、置き換えた Account の
//               "logout"（detail: { reason: "auth_disabled" }）と合成の "login"。入口の seq の一致は条件にしない
//               （並行の logout が seq を進めると disabled なのに None が残るため、PR #264 P1）。
//               これで常に auth.disabled == true ⇔ AuthDisabledLocal ⇔ auth_resolve の kind == "local"
//               ⇔ snapshot.kind == "local" ⇔ sessionStore.authDisabled（S-61・S-94）。apply の戻り値に seq は足さない
//               （画面の invalidateAll() の auth_resolve で、観測していない seq の前進に S-84 の追いつきで合わせる）。
// auth_logout の補完: CAS で消せたら認証モードを読み直し、disabled なら「消去後の seq のまま（＝ None）」の
//               ときだけ同じ rebind_local_session で local を設置する（古いモードを読んだ logout が消した後の穴を塞ぐ。どちらの経路も
//               1 ロック内で is_none() を見るので二重に設置しない。読み直しの失敗は設置せず logout は成功）。
// auth_config_lock（tokio::sync::Mutex<()>、PR #264 再レビュー P2）: config-apply は最初の設定読み取りから保存・local の
//               設置まで、logout は消去後の読み直し〜設置を、autologin の切替は設定の読み書きを、このロックの中で行う
//               （設置の根拠にした設定値と設置の間に別の apply が割り込まない）。順序は auth_config_lock → state.auth で固定。
//               apply(false) は true → false の変更なら、保存の直後（await を挟まず）に Local をその場で終了する（Local → None、
//               seq +1、監査 "logout"（detail: { reason: "auth_enabled" }）。S-99、#266 再レビュー P1）。以前は「apply の応答が
//               seq を運ばないので自分では消さず、次の settle に任せる」としていたが、その間に古い settle が local を確定できた
//               ので撤回（フロントは観測していない seq の前進に S-84 の追いつきで合わせる）。false の再保存は何もしない。
//               保存（set_auth_config）は 4 キーを 1 トランザクションで書く。保存が失敗しても、保存済みの設定を読み直して同じ
//               rebind／終了を行ってからエラーを返す（S-104）。apply(true) の seq の強制 +1 は (disabled, disabled_role) の組の変化で
//               判定する（false → true を含む、S-103）。汎用の settings_set は auth. のキーを拒否する（S-103）。
// change_own_password: id + auth_epoch の照合はそのまま、rebind で seq を進め、応答で返す。
```

`LoginResult` の `superseded`/`seq`、`LogoutResult`、`ChangePasswordResult` は wire の追加
（TS 側は無ければ `false`/undefined と読む）。REST の `/api/auth/*` は変えない（REST 側には
1 スロットが無い、§1.4）。

「Rust が世代の不一致でセッションの確定を拒否した」ことの観測（画面側が応答を捨てただけの場合や
通常の認証失敗とは別のイベント）は**任意・後で**（決定 7）。入れるなら `login` とは別の action に
し、REST 側と `login` の意味を揃える議論（§1.7）を先にする。

フロント側の `createTauriAuthProvider` は、Rust の `seq` と**数値の空間を分けた**
`(observedSeq, local)` の組を revision にする（I-23、S-73・S-75・S-77）:

```ts
let observedSeq = 0; // Rust から観測した seq の max。決して減らさない
let local = 0; // 状態を変える操作の invoke の reject が識別できない形か失効系（unauthorized）のとき、または pending が期限切れになったときだけ +1
const revision = (s = observedSeq, l = local) => `${s}.${l}` as CredentialRevision; // 不透明、等値比較だけ
// 在中の状態を変える操作（login/logout/setup/changePassword）。操作ごとに開始時刻と期限を持つ
const pendingOps = new Set<{ startedAt: number; deadline: number }>();
function observe(seq: number): void {
	const before = revision();
	observedSeq = Math.max(observedSeq, seq); // 古い応答（逆順）では動かない
	if (revision() !== before) emitCredentialChanged(); // 組が変わったときだけ通知（I-19）
}
function bumpLocal(): void {
	local += 1;
	emitCredentialChanged();
}
```

- `login`/`logout`/`setup`/`changePassword`: `op = { startedAt: now, deadline: now + opPendingTimeoutMs }`
  を `pendingOps` に入れて invoke。**応答の `seq`** を `observe()` に通す（進んだときだけ通知。S-55・
  S-67・S-68。逆順に届いても戻らない）。`invoke` が reject したら、エラーの本体が識別できない形（応答が無い）
  か失効系（`unauthorized`。スロットを消した後に返りうる）なら `bumpLocal()`（状態が変わったかもしれない）。
  それ以外の構造化されたエラーは進めない（スロットに書く前に返る）。どちらでも `pendingOps` から外す。**期限（`opPendingTimeoutMs`、既定 10 秒）を
  過ぎたら取り消しではなく「結果が分からない」**: `bumpLocal()` して `pendingOps` から外す（確認を塞ぐ
  対象から外れる、S-78）。その後に元の invoke が結果を返したら、`observe(seq)` と通知で扱う（CAS の
  結果は Rust 側で決まっている。フロントは戻り値の `superseded` を読むだけ）。後から届いた reject では
  `local` を再び進めない（期限切れで進め済み。PR #264 P3）。
- `resolve()`: 入口で `(s0, l)` と `entryAt` を読む → `auth_resolve` を invoke → 答えが届いた時点で
  **`pendingOps` が空でなければ `current` を `deferredSeq` に保留して `StaleAnswerError` で reject**（操作の開始が入口の前か後かを問わない。
  待たない。S-75・S-82。controller は新しい probe で確認し直す。操作の期限があるので永久には続かない）→ Rust が `stale: true` なら、**先に `current` を max で観測してから**（通知はしない。I-23: `observedSeq` は auth_resolve の `current` も含めた max）`StaleAnswerError`（S-77・S-97。#266 再レビュー P1: 観測しないと revision が動かず、controller の差の検知が古い active を保留できない。`pendingOps` が空でない答えの `current` はその場では観測せず `deferredSeq` に保留し、最後の pending の操作の終了時に、その操作の観測の**後**で回収して通知を 1 回にまとめる（S-100。先に観測すると操作の応答の通知が消え、捨てると seq を返さない失敗で前進を失う）→
  `observe(current)`（進んだ分は答えの `current` として controller に渡るので、**ここでは通知しない**。
  S-65）→ `{ status, checked: revision(checked, l), current: revision(current, l), identity, kind }`。
  通信の障害などの reject では `observedSeq` も `local` も動かさない（I-19）。
- 遅れて届いた古い `auth_resolve` の応答（S-73）: `checked` が `revisionAtStart` と不一致で controller が
  捨て、`observe()` は max なので revision は戻らない。

**stale の判定の網羅**（「操作の開始が resolve の前か後か」×「応答の到着の順序」。6 回目 1）:

| 操作の開始                            | 到着の順序                      | 答えを受け取った時点                                  | 結果                                                                                                        | シナリオ    |
| ------------------------------------- | ------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------- |
| resolve の入口より前                  | 操作の応答が先 → resolve の答え | `pendingOps` は空、`observedSeq` は進んでいる         | stale ではないが、`current`（入口時点の seq）≠ `credentialRevision()` で controller が捨てる → 新しい probe | S-73        |
| resolve の入口より前                  | resolve の答えが先 → 操作の応答 | `pendingOps` に残っている                             | **stale**（`StaleAnswerError`）→ 新しい probe。操作の応答で `observe(seq)`・通知                            | S-75        |
| resolve の途中（Rust の settle の後） | resolve の答えが先 → 操作の応答 | `pendingOps` に残っている（開始は入口の後）           | **stale** → 新しい probe（`startedAt < entryAt` だけでは古い none を採ってしまう順序）                      | S-82        |
| resolve の途中（Rust の settle の前） | どちらでも                      | Rust の `settle_session` が seq の変化を見る          | Rust の `stale: true` → `StaleAnswerError`                                                                  | S-77        |
| resolve の途中                        | 操作の応答が先 → resolve の答え | `pendingOps` は空、`observedSeq` は進んでいる         | `current` ≠ `credentialRevision()` で捨てる                                                                 | S-73 と同型 |
| どこでも                              | 操作が**応答しない**            | `pendingOps` に残る → `opPendingTimeoutMs` で期限切れ | 期限までは stale、期限後は「結果が分からない」として `local` +1・通知・塞がない。後着は `observe`           | S-78        |
| 操作なし                              | —                               | `pendingOps` は空                                     | 通常の採用条件（epoch・signal・`checked`・`current`）だけ                                                   | S-54 ほか   |

### 5.4 既存の公開名の移行（決定 1）

| 今の公開名                                                                                           | v2.0.0 での扱い                                                                                                                                                                                                                                    | 理由                                                                                |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `resolveProtectedSession`                                                                            | **削除**（`resolveSettled()` + アプリの方針に分かれる）                                                                                                                                                                                            | `enterPublicViewer` の呼び出しを core から外す。意味が変わる                        |
| `establishSession`・`beginSession`・`endSession`                                                     | **削除**（`resolve()`・`adopt(…, ticket)`・`end(…, ticket)`。ログアウト後の `endSession()` は `resolveSettled()` に）                                                                                                                              | 呼び出し側に状態更新の組み立てを求める入口。単一の書き手（I-1）                     |
| `confirmSessionEnded`・`createSessionEndConfirmation`・`SessionEndOutcome`・`SessionEndConfirmation` | **削除**（`controller.signal()` に格下げ。`connectEvents` は内部で `signal` を呼ぶ）                                                                                                                                                               | 本文「signal の入口に格下げ」                                                       |
| `SessionChangedError`・`MAX_STALE_RETRIES`                                                           | **削除**（`unverified` の `error` に同名のエラーを入れる。上限は deps）。`SessionChangedError` の export は残す（`unverified.error` を `instanceof` で見分けるため、実装-3）                                                                        | reject しない契約（I-8）                                                            |
| `ProtectedSessionOutcome`                                                                            | **削除**                                                                                                                                                                                                                                           | `resolveProtectedSession` と一緒                                                    |
| `AuthProvider.check` / `getIdentity`                                                                 | **契約から削除**（`LegacyAuthProvider` と互換 adapter にだけ残る）                                                                                                                                                                                 | controller が呼ばない（§5.2）                                                       |
| `AuthProvider.enterPublicViewer`                                                                     | **形を変える**（`(options?) => Promise<{ success, superseded? }>`）                                                                                                                                                                                | ticket に結び付けた発行（S-52）                                                     |
| `onSessionEnded`                                                                                     | **残す**: `subscribe` の上の薄い関数（active/unknown → none の遷移を通知。**購読した時点で `snapshot.status === 'none'` なら非同期に 1 回通知**。再 probe はしない）。独自のカウンタは持たず controller に委譲。実装-2 で入れ、v2 でもそのまま残す。**これだけでは none を経ない切り替え（別タブのログインの unknown → active、S-79・S-80）を拾えない**ので、保護レイアウトには配線①（generation の照合 → `invalidateAll()`）が要る | アプリの `invalidateAll()` 配線がそのまま使える。mount 前の終了も拾う（S-34・S-74） |
| `sessionGeneration`・`currentSessionScope`・`isCurrentSessionScope`・`isSessionEstablished`          | **残す**: 既定の controller の `snapshot`/`scope()`/`isCurrent()` への委譲。読み取りだけ                                                                                                                                                           | `listViewState` と画面の書き込み条件が使う。意味は変わらない                        |
| `sessionOwnerKey`                                                                                    | **残す**。`kind` ごとの名前空間を足す（v2.x: `publicViewer` は `public-viewer`、`local` は `local`、adopt は `${kind}:${id}`。**v3.0.0（ADR-0017）: grant の kind は kind 単独のキー（`publicViewer`・`commissioning`）**）。`kind` を返さない provider の答えは v2.x では `identity.publicViewer`、v3.0.0 では `identity.kind` から導く（実装-2、§10 (b)・S-87）                                                                                                                    | 保存状態の互換。`account:0` との衝突を避ける（統合修正 13）                         |

参照・購読の API は**独自の状態や確認処理を持たない**（I-1）。`sessionScope.svelte.ts` の
モジュール変数は controller の中に移り、これらの関数は既定の controller を読むだけになる。

## 6. SvelteKit との接続と、派生アプリの移行

### 6.1 admin-template の配線（v2.0.0 の形）

- `(app)/+layout.ts` の `load`:

  ```ts
  const controller = getSessionController();
  let result = await resolveSettled(controller, { cause: 'navigation' }); // superseded は中で要求し直す
  if (result.outcome === 'unverified') error(503, ...); // 再試行の画面（今のまま。期限切れも同じ）
  if (result.snapshot.status === 'none') {
  	result = await publicViewerFallback(controller, authProvider, result.ticket); // アプリの方針（下）。ResolveResult を返す
  	if (result.outcome === 'unverified') error(503, ...); // 発行後の確認の失敗も 503（S-66）。ログイン画面へは行かない
  	if (result.snapshot.status !== 'active') redirect(307, `${base}/login`);
  }
  if (result.snapshot.kind === 'publicViewer') { /* 許可リストの redirect（今のまま） */ }
  return { sessionGeneration: result.snapshot.generation }; // この load で確認できた generation だけ（I-16）
  ```

  `load` の副作用は `controller.resolve()`（と方針の `enterPublicViewer`）だけ。`sessionStore` への
  代入は `load` から消える（`authDisabled` の別読みも消える、S-61）。`superseded` のまま
  `sessionGeneration()` を返す今の 105 行の形は**無くす**（S-48〜S-50）。

- `publicViewerFallback(controller, provider, ticket, options?: { maxRetries?: number }): Promise<ResolveResult>`
  （admin-core の**任意の**ヘルパー。controller の外。**ticket を最後まで持ち回り、`ResolveResult` を返す**、
  S-42・S-52・S-66）。再試行の上限 `maxRetries` は**このヘルパーが所有する**（既定 3。定数
  `DEFAULT_PUBLIC_VIEWER_RETRIES` として admin-core から export）。controller の `deps.maxStaleRetries` とは
  共有しない: あちらは 1 回の `resolve()` の中で stale な答えを捨て直す回数、こちらは方針（status → 発行 →
  確定）をやり直す回数で、数えるものが違う。1 回のやり直しの中の `resolveSettled` は、それぞれ controller の
  上限の下で動く（最悪の往復は両者の積で抑えられる）:

  ```ts
  for (let retries = 0; ; retries++) {
  	const status = await provider.status?.();
  	let result: ResolveResult;
  	if (!controller.isCurrent(ticket)) {
  		// 同期の照合、この後 await まで無し。ticket の後で資格情報が変わった（storage イベント到着済み）
  		result = await resolveSettled(controller);
  	} else if (!status?.viewerPublic) {
  		return { outcome: 'confirmed', snapshot: controller.snapshot, ticket }; // none のまま
  	} else {
  		const entered = await provider.enterPublicViewer?.({ expectRevision: ticket.revision }); // 発行の中の CAS も ticket の revision
  		result = await resolveSettled(controller); // issued の成否に依らず、今の資格情報で確定。unverified はそのまま返す
  		if (!entered?.superseded) return result; // 発行の失敗（403・通信）は再試行しない
  		// superseded: ticket の後で資格情報が変わった（storage イベント未着）
  	}
  	// ここに来るのは「ticket の後で資格情報が変わった」ときだけ（イベントの到着の前後を問わない）。
  	// 現れたトークンが失効していれば resolveSettled が消して confirmed none になる。そのときだけ
  	// 新しい ticket で方針をやり直す（上限あり）。active・unverified・superseded はそのまま返す
  	if (result.outcome !== 'confirmed' || result.snapshot.status !== 'none') return result;
  	// 初回 + 再試行 maxRetries 回（既定 3 なら方針は最大 4 回走る。maxRetries = 0 で再試行なし）
  	if (retries >= (options?.maxRetries ?? DEFAULT_PUBLIC_VIEWER_RETRIES)) return result;
  	ticket = result.ticket;
  }
  ```

  実装-2 の実装では、発行の**純粋な失敗**（403・通信の失敗。`success: false` かつ `superseded` でない）のとき、
  ticket がまだ current なら最後の `resolveSettled` を省いて確定済みの `none` をそのまま返す。安全である理由:
  ticket が current ⇒ epoch も revision も動いていない（provider はトークンを書いていない）。発行の最中にトークンが
  現れていれば provider が `superseded` を返すので、この近道には入らない。

  この再試行は、今の `resolveProtectedSession` の `continue`（上限 `MAX_STALE_RETRIES`）と同じ役割
  （#264 再レビュー）。これが無いと、ticket の作成後に現れた失効トークンを `resolveSettled` が消して
  `confirmed none` を返し、呼び出し側が `/login` へ移るので、実装-1 の `sessionGate` では通る S-20 系の
  順序で公開閲覧への fallback を失う。**storage イベントが `isCurrent` の前に届いた場合（ticket が失効）と、
  届く前に発行した場合（`enterPublicViewer` が `superseded`）を同じ規則で扱う**。発行そのものの失敗
  （403・通信の失敗）は資格情報の変化ではないので再試行しない。上限を使い切ったら最後の結果（`none`
  なら `/login`）を返す。実装-3 のテストに S-20 系の 3 本を入れる: 「イベント未着で発行の前に現れた
  失効トークン → 消えて公開閲覧に入る」「イベント到着済み（`isCurrent` が false）の失効トークン → 同じく
  公開閲覧に入る」「毎回現れる → 上限で抜ける」。最後のテストは呼び出し回数まで固定する（`maxRetries` = 3
  で `status()`/`resolveSettled` が 4 回、`maxRetries` = 0 で 1 回。off-by-one を防ぐ）。

  `adopt()` は使わない。

- `sessionStore`（`#lib/session.svelte.ts`）: `identity`・`role`・`publicViewer`・`authDisabled` は
  `controller.snapshot` からの `$derived`（`authDisabled = snapshot.kind === 'local'`）。
  派生アプリの `sessionStore` も同じ形（`load()` は無くなる）。
- `Header.svelte`・`commands.ts` のログアウト（I-10、S-17・S-51）:

  ```ts
  await provider.logout(); // 消せたなら provider が revision を進めて通知 → controller は保留
  const result = await resolveSettled(controller, { cause: 'signal' }); // ログアウトの後に始めた probe だけが答える（I-9）。none なら commit(none) = 保存状態の全消去
  if (result.outcome === 'confirmed' && result.snapshot.status === 'none') goto(`${base}/login`);
  // active のまま（別のログインが確定していた）なら何もしない。unverified なら再試行の表示
  ```

  `end()` は呼ばない。

- `events.ts` `connectEvents`: `onUnauthorized` → `controller.signal('unauthorized')`、
  `onTokenCleared` → `controller.signal('credentialCleared')`。退避は controller の中。
- `+layout.svelte` の配線は **3 本に分ける**（レビュー 7、統合修正 6、S-34・S-36・S-59・S-60）:

  ```ts
  // ① 世代の照合 → 再 load。$effect で snapshot と data を比べる（subscribe ではない）。
  //    同じ generation に invalidateAll を二重に出さない（requestedFor）。unheard の再確認は無い。
  let requestedFor = -1;
  $effect(() => {
  	const g = controller.snapshot.generation;
  	if (g !== data.sessionGeneration && requestedFor !== g) {
  		requestedFor = g;
  		void invalidateAll();
  	}
  });
  // ② 未処理のユーザーの変更 → 通知。controller が pendingOwnerChange を持つ（レイアウトの寿命に依存しない、
  //    統合修正 16・5 回目 3・6 回目 オーナー決定）。mount 時と、その後の変化の両方で扱い、処理したら acknowledge で消す。
  //    同じ値の再確認では上書きされない（S-81）。none の確定で破棄される（S-83、I-24）。none への commit で previousActiveOwner が null に戻るので、
  //    同じタブのログアウト → 別ユーザーのログインでは立たない（S-76）
  $effect(() => {
  	const handle = (s: SessionSnapshot) => {
  		if (s.pendingOwnerChange && s.status === 'active') {
  			ownerChanged(s); // ownerChangePolicy: 'rebuild' は通知だけ、'relogin' は通知して goto(login)
  			controller.acknowledgeOwnerChange();
  		}
  	};
  	handle(controller.snapshot); // mount 時（503 の画面の間に確定した変更も拾う）
  	return controller.subscribe((s) => handle(s));
  });
  );
  // ③ 再 load の unverified → 503 は load の中（上）。自動では復帰しない（S-36）
  ```

  ① により、mount 時の照合（旧 unheard、S-34）、同じ A の再ログイン（S-59）、切り替え後の確認の
  失敗（S-60、再 load の `resolveSettled` が `unverified` → `error(503)`）のどれも、画面が空のまま
  止まらない。世代ゲート `{#if data.sessionGeneration === controller.snapshot.generation}{#key ...}`
  は**そのまま**（I-14）。`onSessionEnded(() => void invalidateAll())` は ① に含まれるので、
  admin-template では使わなくなる（公開名としては残す、§5.4）。
  `ownerChanged(s)` は `ownerChangePolicy`（`initBanto` か layout で注入。`'rebuild'`（既定）|
  `'relogin'`）: `'rebuild'` は `notify('info', 別のユーザーでログインされました)` だけ（作り直しは ① が
  する）。`'relogin'` は通知して `goto(login)`。**どちらもトークンは消さない**（I-17）。

- **503 画面の「再試行」**（`routes/+error.svelte` 13-15 行、今は `location.reload()`）は、**controller を
  維持したクライアント側の再読込**（`invalidateAll()`）に変える（実装-3。6 回目 3）。ページ全体の再読込では
  controller が作り直され、`pendingOwnerChange` も `previousActiveOwner` も消えるので、S-81 の通知は
  保証できない。ホームへのリンク（26 行）は同じ document の中の navigation なので controller は残る。

**未処理のユーザーの変更（`pendingOwnerChange`）の寿命**（状態遷移 × 画面の出来事。I-24、
6 回目 オーナー決定）:

| 出来事                                                | 作る                                                    | 保持する                                | 消える                                           | シナリオ              |
| ----------------------------------------------------- | ------------------------------------------------------- | --------------------------------------- | ------------------------------------------------ | --------------------- |
| active(B) の確定（直前の active が A ≠ B）            | `{ from: A, to: B }`                                    | —                                       | —                                                | S-35・S-81            |
| active(B) の確定（直前の active が null。none の後）  | 立てない                                                | —                                       | —                                                | S-76・S-83            |
| unknown への保留                                      | —                                                       | 保持                                    | —                                                | S-81（500 の間）      |
| 同じユーザー（B）の再確認                             | —                                                       | 保持（上書きしない）                    | —                                                | S-81                  |
| 別のユーザー（C）の確定（B を処理する前）             | `{ from: A, to: C }` に置き換える（最初の from を保つ） | —                                       | —                                                | —                     |
| 元のユーザー（A）の確定（A → B を処理する前、A → B → A） | 未処理の変更を**消す**（`from === to` は「ユーザーは変わっていない」。`{ A → A }` を通知しない、実装-2） | —                                       | null に戻る                                      | —                     |
| owner の無い active（S-10、id の無い identity）             | —（owner の変化の判定の対象外。比べる相手は最後の具体的な owner のまま） | 保持                                    | —                                                | S-92                  |
| active(P) → active(A)（公開閲覧から自分でログイン、同じタブでも別タブのログインでも） | 立てない（公開閲覧はユーザーではない。owner の変化の判定の対象外、実装-3 の独立監査 P2-1） | —                                       | —                                                | S-93                  |
| active(A) → active(local)（ログイン不要モードの有効化）、local → local（役割の変更）、local → active(B)（その前に具体的な owner が無い場合。`kind === 'local'` の合成セッションは端末の状態でありユーザーではない。owner の値ではなく `kind` で判定する。最後の具体的な owner は更新しない。A → local → B は none を経ない経路が実際には無いが、起きれば A → B を比べて通知する。Issue #291） | 立てない | — | — | S-107 |
| active(A) → active(commissioning)（アプリが `adopt()` で確定する試運転の合成セッション）、commissioning → active(A)、commissioning → commissioning（比べる対象は `kind === 'account'` の active だけなので、`kind !== 'account'` の active は `local`・`commissioning`・今後の kind を列挙せずにまとめて対象外。最後の具体的な owner は更新しない。A → commissioning → B は none を経ない経路が実際には無いが、起きれば A → B を比べて通知する。Issue #308） | 立てない | — | — | S-108 |
| 別の provider への再 bind（`initBanto` の差し替え）         | —                                                       | —                                       | **破棄**（別の認証源の owner は比べない）        | S-90                  |
| **none の確定**                                       | —                                                       | —                                       | **破棄**（セッションの終了を越えて持ち越さない） | S-83                  |
| レイアウトの mount                                    | —                                                       | —                                       | 処理して `acknowledgeOwnerChange()`              | S-81                  |
| レイアウトの unmount（503 画面へ）                    | —                                                       | 保持（controller にあるので）           | —                                                | S-81                  |
| 画面内の再読込（`invalidateAll()`、503 の「再試行」） | —                                                       | 保持                                    | —                                                | S-81                  |
| ページ全体の再読込（`location.reload()`）             | —                                                       | **保証しない**（controller ごと消える） | —                                                | S-81 の保証しないこと |

- `login/+page.svelte`: `login()` 成功後の `goto(dashboard)` はそのまま（`load` の `resolveSettled()`
  で確定）。`superseded: true` が返ったら「別のセッションが確定しました」を出して `goto(dashboard)`
  （`load` が確定する）。

### 6.2 派生アプリ（banto-industrial）の移行の手順の案

A′ 案のとおり、**候補版で検証したうえで、正式版への参照の更新まで 1 本の移行 PR** で行う。
両アプリとも `github:tyaro/banto#v1.7.3&path:...` → `#v2.0.0`。

| 対象                                                                          | 置き換え                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/*/src/lib/session.svelte.ts` の `load()`                                | 削除。`identity`/`role`/`authDisabled` は `getSessionController().snapshot` からの `$derived`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/*/src/lib/banto/sessionGuard.ts`                                        | `resolveProtectedSession` → `resolveSettled(controller)`。`'unverified'` は `outcome === 'unverified'`、`'login'` は `confirmed && status === 'none'`                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/*/src/routes/(app)/+layout.ts`                                          | §6.1 の形（公開閲覧の fallback は両アプリとも無い）。返す generation はこの `load` で確認できたものだけ。**保護レイアウト（`+layout.svelte`）には配線①（generation の照合 → `invalidateAll()`）を必ず入れる**: `onSessionEnded` だけでは、別タブのログインなど none を経ない切り替えで世代ゲートが画面を隠したままになる（実装-2 の CHANGELOG と同じ申し送り）                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| banto-hub `sessionStore.enterCommissioningMode()`                             | **試運転の policy runner**（下）に置き換える。`adopt()` を使うのはこれだけ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| banto-hub `sessionRecheck.ts`                                                 | `recheckSessionAfterStreamClose` → `controller.signal('app:stream-closed')` + `invalidateAll()`。`probeSessionAfterReconnectFailures` → **`kind === 'commissioning'` なら試運転の policy runner を先に走らせ**（統合修正 7）、そうでなければ `resolveSettled(controller, { cause: 'signal' })`（要求自体が signal の stamp を進める、S-58）。結果を `SessionProbeResult` に写す（`confirmed/none → 'login'`、`confirmed/active → 'session'`、`unverified → 'unverified'`）。独自の token 照合・single-flight・期限・`/api/auth/check` の直接 `fetch` は削除 |
| banto-hub `(app)/+layout.svelte`・`monitor/+page.svelte`                      | §6.1 の 3 本の配線（世代の照合 → 再 load、owner → 通知、unverified → 再試行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 各アプリの `Header`/ログアウト                                                | `await provider.logout(); await resolveSettled(controller)`（`end()` は呼ばない、S-51）                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **自前の `AuthProvider` を持つ場合**                                          | v2 の `AuthProvider` は `resolve`・`credentialRevision`・`onCredentialChanged` が必須なので**型エラーになる**。対応は 2 つ: (a) 3 つを実装する（推奨。HTTP なら `GET /api/auth/identity` 1 回、§2.1）、(b) 一時的に `adaptLegacyAuthProvider(...)` で包む（保証しない範囲を §5.2 の表で確認し、移行 PR の本文に「adapter 使用中」と明記する）。**banto-industrial では chronogazer の `demoAuthProvider`（`setup.ts` 132〜160 行、`check`/`getIdentity` だけ）が該当する**（admin-template の `demo.ts` を手本に 3 つを実装する。§1.6 の訂正）。また両アプリの `session.svelte.ts` の `getAuthProvider().getIdentity()` の直接呼び出しは、`controller.snapshot`（`$derived`）／`resolveSettled` に置き換える                                                                                                         |
| 各アプリの 503 画面（`src/routes/+error.svelte` 14 行の `location.reload()`） | **controller を維持したクライアント側の再読込**（`invalidateAll()`）に変える（admin-template と同じ、§6.1。6 回目 3）。ページ全体の再読込のままなら S-81 の通知は保証されない                                                                                                                                                                                                                                                                                                                                                                               |
| `#216` の `lan_urls` 3 か所・`#248` の監査ログ                                | 同じ移行 PR に含める（Issue #260「進め方」3）。セッションとは独立                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

> **2026-10-02、2026-10-03 改訂（[ADR-0017](../adr/0017-credential-less-grant.md)）、v3.0.0 で実施**: 下の policy runner は
> `adopt()`/`end()` を使う v2.x の形で、`adopt()`/`end()` は **v3.0.0 で削除済み**（grant に置き換え。v2.x の記録として残す）。
> 移行後の banto-hub は `grantFallback(controller, provider, ticket, { kind: 'commissioning' })`
> を `+layout.ts` の `none` の後に置く（admin-template の `publicViewerFallback` と同じ位置、
> §6.1）。「取得の失敗と終了の確定を区別する」要件は grant では `status()` の失敗 =
> 発行しない（`none` のまま。S-52/S-66 と同じ）、ロックダウン = サーバーの
> `revoke_grant_tokens` → 次の要求が 401 → `resolve()` が `none` を確定、に写る。
> `'recheck'`（ストリームの再確認）は `controller.signal()` → 通常の確認で足り、
> アプリ固有の runner は要らなくなる。

**試運転の policy runner**（banto-hub のアプリ層。S-44・S-45・S-53・S-62・S-70・S-71）。
**2 つの mode** を持つ: `'guard'`（初回のルートガード。取得の失敗は「迂回しない」に倒す＝今の
`+layout.ts` と同じ安全側）と `'recheck'`（ストリームの再確認。取得の失敗は `unverified` で
画面を保つ＝今の `sessionRecheck.ts` 86-97 行と同じ）。**取得の失敗（`status === null`）と
「終了が確定した」（`lockedDown: true`）は区別する**:

```ts
async function runCommissioningPolicy(
	controller,
	{
		mode,
		deadlineMs = 10_000,
		maxRounds = 3
	}: { mode: 'guard' | 'recheck'; deadlineMs?: number; maxRounds?: number }
): Promise<ResolveResult> {
	const abort = new AbortController(); // 方針自身の signal。controller の probe には渡さない（I-22）
	const timer = setTimeout(() => abort.abort(), deadlineMs);
	// 既存の snapshot は保つ。confirmed にはしない（S-70）。resolveSettled() には落とさない
	const incomplete = (why: 'deadline' | 'rounds' | 'status-unavailable'): ResolveResult => ({
		outcome: 'unverified',
		error:
			why === 'deadline'
				? new PolicyTimeoutError()
				: why === 'rounds'
					? new PolicyExhaustedError()
					: new PolicyStatusUnavailableError(),
		snapshot: controller.snapshot
	});
	// 期限は開始時に絶対時刻で固定し、方針の取得と通常の確認の**全体**で共有する（今の sessionRecheck.ts
	// 33-35・126-146 行と同じ。5 回目 4）。通常の確認へ引き継ぐときは残りを resolveSettled の deadlineMs に渡す
	const deadlineAt = clock() + deadlineMs;
	const remaining = () => deadlineAt - clock();
	const handOff = async (): Promise<ResolveResult> => {
		if (remaining() <= 0) return incomplete('deadline');
		const r = await resolveSettled(controller, { deadlineMs: remaining() }); // 方針の signal は共有の probe に渡さない
		return r.outcome === 'unverified' && remaining() <= 0 ? incomplete('deadline') : r;
	};
	try {
		for (let round = 0; round < maxRounds; round++) {
			const t = controller.ticket(); // adopt 中なら epoch だけ（I-21）
			const status = await fetchCommissioningStatusOrNull(abort.signal); // 方針の通信はすべてこの signal
			if (abort.signal.aborted || remaining() <= 0) return incomplete('deadline'); // S-70: resolveSettled に落とさない
			if (status === null) {
				// 取得の失敗。終了の確定ではない（S-71）
				if (mode === 'recheck') return incomplete('status-unavailable'); // end も adopt もしない
				// guard: 迂回しない側に倒す（今の +layout.ts と同じ）。adopt 中なら end してから通常の確認
			} else if (shouldBypassLoginForCommissioning(status)) {
				if (controller.adopt(COMMISSIONING_IDENTITY, 'commissioning', t)) return await handOff();
				continue; // ticket が失効（S-53）: 新しい ticket で方針の確認からやり直す
			}
			// ここに来るのは「lockedDown が確定」か「guard で取得に失敗」
			if (controller.snapshot.kind === 'commissioning') {
				if (controller.end('commissioning-locked', t)) return await handOff(); // S-62: revision の変化では失効しない
				continue; // epoch が進んでいた（別の判定が先に end/adopt した）: やり直す
			}
			return await handOff(); // 試運転ではない: 通常の確認（残りの期限で）
		}
		return incomplete('rounds'); // S-70・S-53: 上限到達も unverified（PolicyExhaustedError）
	} finally {
		clearTimeout(timer); // `return await` なので、引き継いだ確認が終わるまで finally は走らない
	}
}
```

`(app)/+layout.ts` は毎回 `mode: 'guard'` で、`probeSessionAfterReconnectFailures` は
`kind === 'commissioning'` のとき `mode: 'recheck'` でこの runner を呼ぶ（試運転の判断そのもの、
`shouldBypassLoginForCommissioning` は変えない）。`unverified` の `PolicyTimeoutError` /
`PolicyExhaustedError` / `PolicyStatusUnavailableError` は、`guard` では `load` が 503 の再試行画面、
`recheck` では `'unverified'`（画面を保ち、再接続を続ける）になる。

同じ型（取得の失敗を終了にしない）の点検: `publicViewerFallback` の `status()` は HTTP provider が
失敗を `{ initialized: true }`（`viewerPublic` 無し）に潰すので、失敗時は発行せず `none` のまま
`confirmed` を返す（none はすでに確定済みで、失敗が終了を**作る**わけではない）。`resolve()` の
reject は I-4 で状態を変えない。方針の経路で「取得の失敗 → `end`/`adopt`」になるのはこの runner の
`guard` mode だけで、それは今の挙動の維持（オーナー判断で変えるなら別 issue）。

## 7. 実装の分割と、候補版での検証

### 7.1 実装の PR

**各 PR は単独でマージしても不変条件を満たす**（統合修正 3）。そのために「既存の呼び出し側の
互換」の列を置く。

| PR     | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 受け入れ条件                                                                                                                                                                                                                                                                                                                                                                                                   | 既存の呼び出し側の互換                                                                                                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実装-1 | **provider とバックエンド**: `AuthProvider.resolve`/`credentialRevision`/`onCredentialChanged`（この PR では任意で追加、実装-3 で必須化）、`enterPublicViewer` の新しい形、HTTP provider の `resolve()`（`GET /api/auth/identity` 1 回、`none` で compare-and-set 消去、`checked`/`current`）と書き込みの compare-and-set（#259）と `storage` 監視と**操作の応答での revision 更新と通知**、`adaptLegacyAuthProvider`、Rust に `AuthSlot`（seq の規則 I-11）・`settle_session` の `(session, seq_before, seq_after)`・`auth_resolve`（kind・checked・current）・`LoginResult`/`LogoutResult`/`ChangePasswordResult` の `seq`・login/setup/logout の compare-and-set・**検証と設定取得の注入点**（§8.3）。**REST のルートは足さない**                                                                                                                                                                                                                                             | S-9・S-16〜S-21・S-40・S-54・S-55（provider 側）・S-64・S-67・S-68 のテスト（Rust は `cargo test` でコマンド本体の順序を固定、TS は vitest）、adapter の保証する範囲のテスト。**`sessionGate.ts` 67-68 行を `.success` での判定に直し、`superseded` なら `continue` で確認し直す**（`enterPublicViewer` の戻り値が変わるため）。既存テスト全緑。controller はまだ無く、公開 API は追加だけ。**タグは打たない** | `check()`/`getIdentity()` は残す（`sessionGate`/`sessionLifecycle`/`sessionEnded` が使う）。`resolve` は任意。`enterPublicViewer` の呼び出し側（`sessionGate.ts`）だけ同じ PR で追従。Tauri の `auth_logout`/`auth_change_password` の戻り値の変更は TS の `createTauriAuthProvider` が同じ PR で吸収                        |
| 実装-2 | **controller**: `sessionController.svelte.ts`（`commit`・`resolve`・`signal`・`ticket`・`adopt`・`end`・deps 注入、§5.1 の手順 0〜7、probe ごとの `AbortController`）、`resolveSettled`、テストのハーネス（§8.1）、S-1〜S-15・S-23〜S-34・S-42〜S-50・S-53・S-56〜S-58・S-62・S-63・S-65・S-66 のテスト。既存の `establishSession` 等は**この PR では controller への委譲に書き換えて残す**（admin-template を壊さないため）。**`initBanto` は `resolve` を持たない provider を互換 adapter で包む**（統合修正 15）。**unheard の再 probe をやめ、代替として `onSessionEnded` が購読時に `snapshot.status === 'none'` なら非同期に 1 回通知する**（同じ PR。4 回目 6・Fable。v2 でもそのまま残す）。**配線①（`(app)/+layout.svelte` の `$effect` による generation の照合 → `invalidateAll()`）をこの PR に前倒しする**（5 回目 2。55 行の `onSessionEnded(...)` を配線①に置き換える。世代ゲート 160 行はそのまま。保留・active の確定を含むすべての世代の変化で再 load できる） | 全シナリオが S 番号付きで通る。既存の `sessionRaces`/`sessionGate`/`sessionEnded*` テストが呼び口の変更だけで通る（`sessionEndUnheard` は S-34 の新しい期待「購読時に none なら 1 回通知」に書き換える）。**実装-2 を単独でマージした状態で S-74・S-79（A → unknown → B）・S-80（同じ owner の再ログイン）を E2E で検証する**                                                                                  | 旧 API は委譲で動く。`resolveProtectedSession` は内部で `resolveSettled` + `publicViewerFallback` を呼ぶ。**S-11 の「`check()` が reject」は委譲版では「`resolve()` が reject → `unverified`」に写り、旧 API はそれを reject（throw）で表す**（4 回目 P3-12）。mount 前の終了と none を経ない世代の変化は配線①が拾う（§7.3） |
| 実装-3 | **admin-template の配線と v2.0.0**: §6.1（`load`、`publicViewerFallback` の `ResolveResult`、ログアウトの `resolveSettled`、3 本の配線、`authDisabled` の導出）、`connectEvents` の `signal` 化、`ownerChangePolicy`、§5.4 の削除と 3 つの必須化、**demo provider（`demo.ts`）の標準への書き換え**、S-35〜S-39・S-51・S-52・S-59〜S-61・S-81・S-83 のテスト（`storage` イベントのモック）、**503 画面（`routes/+error.svelte`）の「再試行」を `location.reload()` から controller を維持した `invalidateAll()` に変える**（6 回目 3）、E2E（`session-check-outage`・`public-viewer` を保つ。同じアカウントの再ログインと S-36、S-81 は実際の「再試行」ボタンを押す）、CHANGELOG の「挙動の互換性が変わる変更」と移行表（`sessionEndUnheard` の期待の変更を含む）                                                                                                                                                                                                                 | `pnpm check`/`test`/`e2e`/`e2e:public-viewer` 全緑。Tauri check 緑。CHANGELOG に §5.4 の表と §6.2 の自前 provider の項                                                                                                                                                                                                                                                                                         | 互換は切る（v2.0.0）。派生アプリは v1.7.3 のまま                                                                                                                                                                                                                                                                             |
| 移行   | **banto-industrial**（候補版の検証後）: §6.2 と参照の `v2.0.0` 化を 1 本で                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 両アプリの `check`/`test`/E2E、実機 smoke（banto-hub のローカル smoke 手順）、試運転の入退場（S-53・S-62 を含む）、ストリーム切断後の再確認（S-58）、別タブでの切り替えの通知                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                                                                                            |

実装-1 と実装-2 は並列に進められる（実装-2 は interface だけに依存）。実装-3 は両方の後。

実装-3 では、`docs/architecture-flows.md` の §2（`(app)` ガード）と §3（ログイン）の図と説明も、新しい流れ（`controller.resolve`／`resolveSettled`・`publicViewerFallback`・3 本の配線）で描き直す（v1.7.x 時点の流れである旨の注記を外す）。

### 7.2 候補版で派生アプリ 2 本を検証する手順

publishing.md は git タグ参照なので、候補版は**タグではなくコミット参照**で試す
（タグを打つのはオーナー）:

1. 実装-3 のマージ後、banto の main のコミット `X` を候補にする。
2. banto-industrial に**マージしない**検証ブランチを切り、両アプリの `package.json` の 5 パッケージを
   `github:tyaro/banto#X&path:...` に変え、`pnpm install`。
3. §6.2 の置き換えを行い、`pnpm check` → `pnpm test` → E2E → 実機 smoke（1 本ずつ）。
4. 見つかった問題は banto 側で直し、`X` を進めて 2 からやり直す。
5. 問題が無くなったら、オーナーが `v2.0.0` を打つ → 検証ブランチの参照を `v2.0.0` に置き換えて
   移行 PR にする（同じ PR に #216・#248 の分も入れる）。

### 7.3 段階ごとの「単独でマージしても不変条件を満たす」の確認

| 段階（main の状態）      | 状態を確定する経路                                                                                                                                                                                                                                                              | 危うい順序と、それを守るもの                                                                                                                                                                                                                                                                                        | 検証                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 実装-1 だけ              | 旧 API（`sessionGate`/`sessionLifecycle`/`sessionEnded`）のまま。provider と Rust だけ新しい                                                                                                                                                                                    | Rust の復活・消失（S-16〜S-19）は CAS で守られる。`enterPublicViewer` の戻り値の変更は `sessionGate.ts` 67-68 行を同じ PR で `.success` 判定に直す（`superseded` は `continue`）。provider の通知は旧 API には届かないが、旧 API は今の照合（scope）で今の強さを保つ                                                | Rust の順序固定テスト、provider テスト、既存テスト全緑                      |
| 実装-1 + 実装-2          | controller が確定。旧 API は委譲。`+layout.svelte` は 55 行の `onSessionEnded(...)` を**配線①（`$effect` の generation の照合）に置き換える**（160 行の世代ゲートはそのまま）。unheard の再 probe は無く、`onSessionEnded` は購読時の `none` を 1 回通知（公開 API として残る） | mount 前の終了（S-34/S-74）も、none を経ない世代の変化（別タブのログイン A → unknown → B: S-79、同じ A の再ログイン: S-80）も配線①が再 load する。`load` はまだ旧 `resolveProtectedSession`（委譲）だが、`superseded` は委譲の中で `resolveSettled` に落ち、`resolve()` の reject は旧 API の reject（→ 503）に写る | **実装-2 単独で S-74・S-79・S-80 を E2E**、S-1〜S-15 ほか controller テスト |
| 実装-1 + 実装-2 + 実装-3 | v2.0.0 の形                                                                                                                                                                                                                                                                     | §6.1 のとおり                                                                                                                                                                                                                                                                                                       | 全テスト・E2E・Tauri check                                                  |
| 移行（banto-industrial） | 派生アプリが v2.0.0                                                                                                                                                                                                                                                             | policy runner の 2 mode（S-70・S-71）、S-53・S-62                                                                                                                                                                                                                                                                   | 両アプリの検証（§7.2）                                                      |

unheard の再 probe をやめる変更と、その代替（`onSessionEnded` の購読時の通知）と、**配線①の前倒し**を
**同じ PR（実装-2）に置く**（4 回目 6・5 回目 2）。実装-1+実装-2 の時点で別タブのログインは新しい
controller に届き、none を一度も経ずに世代が変わる（A/g1 → unknown/g2 → B/g3、同じ A の再ログイン）。
`onSessionEnded` だけでは拾えないので、実装-2 を実装-3 より先に単独でマージしても子画面が隠れたままに
ならないよう、配線①をここで入れる。

## 8. テストの設計

### 8.1 順序をテストから決める仕組み（TS）

- `createSessionController(provider, { scheduler, clock })` に、テストの `scheduler`（手動で
  進めるタイマー）と `clock`（手動のカウンタ）を渡す。vitest の fake timers に頼らず、
  「どの順で解決するか」をテストの文で書けるようにする。
- `makeProbeProvider()`（`sessionRaces.test.ts` の `makeAuth` の後継。標準の 3 つを持つ）:
  - `resolve()` の答えを `deferred` の配列に積む（`probes[n].resolve({ status: 'active', identity, checked, current })`
    / `.reject(err)`）。受け取った `signal` を記録し、abort されたかを見られる（I-22）。
  - `revision` をテストが上げ下げでき、`emitCredentialChanged()` で listener を呼べる。
    「revision だけ上げて通知しない」も作れる（手順 0 の防御、S-63）。
  - `login`/`logout`/`setup`/`enterPublicViewer` も `deferred` で、完了のタイミングを決められる。
    `enterPublicViewer` は受け取った `expectRevision` を記録する（S-52）。
- 「同じターン」（S-6・S-7・S-12〜S-15）は、複数の `deferred` を**同じ同期ブロックで**解決してから
  `await` する。既存テストと同じ書き方。
- `resolveSettled`（S-48〜S-50）は、`superseded` の後に要求し直すこと、返す generation が
  要求し直した確認のものであること、`deadlineMs` で `unverified` になることを `scheduler` を進めて確かめる。
- 出し直しと abort の条件（I-9・I-22、S-14・S-29・S-30・S-46・S-72）: 採用できないことが確定した
  **古い probe は必ず abort される**（`probes[n].signal.aborted === true`）こと。そのうえで、「待機要求
  あり」または「`pendingBackground` あり」なら**別の signal を持つ新しい probe** が 1 本出ること
  （`probes.length` が +1、新しい probe の `signal.aborted === false`）、どちらも無ければ新しい probe が
  出ないこと。古い probe と新しい probe の signal を分けて確かめる。
- 失敗の鮮度（S-56）: B 確定後に古い probe を `reject` し、`snapshot` と `verification` が
  **同一参照**のままであることを確かめる。
- 消去を伴う答えの破棄（S-31）: `abandoned` の probe が `current !== checked` の答えを返す →
  `pendingBackground` が立ち、次の probe が none を確定する。`emitCredentialChanged` は呼ばれない。
- 最初の 1 往復（S-57）: 新しい controller で `resolve()` → probe を fulfill → `confirmed`。
- ticket（S-52・S-53・S-62）: `ticket()` → `end`/`adopt`/保留を起こす → `adopt(…, t)`/`end(…, t)` が
  `false` で状態が変わらないこと。adopt 中の ticket は revision の変化で失効しないこと（S-62）。
  `publicViewerFallback` は `status` の `deferred` を B の確定の後に解決し、`enterPublicViewer` が
  **呼ばれない**ことと、最後の確認の reject が `unverified` として返ること（S-66）を確かめる。
- generation（§3.1）: 表の各行を 1 つのテストにし、`generation` の増分と `epoch` の増分を別々に
  確かめる（none→none・unknown→unknown・同じ C の再 adopt は generation 据え置き）。
- テスト名は `S-n: ...` で始め、`describe` に `I-n` を書く。表と食い違ったら表を直す
  （表が正）。

- adopt 中の分岐（S-69）: `adopt(C)` → `revision` を上げて `emitCredentialChanged()`（または通知なしで
  上げるだけ）→ `resolve()` → `confirmed` で C のまま、`snapshot` は同一参照、`pendingBackground` だけ
  立つ（次に `end` した後の probe が 1 本出る）。
- 打ち切りの abort（S-72）: `pendingBackground` を立て、probe を `timeoutMs` で 5 回続けて打ち切る
  → 各 probe の `signal.aborted` が真、`probes.filter(p => !p.signal.aborted && !p.settled).length <= 1`。
  waiter の `deadlineMs` だけが切れた場合は abort されないこと（別テスト）。背景の確認で期限切れを
  繰り返しても、abort されていない `fetch` が 1 本を超えないこと（S-72）。
- policy runner（S-70・S-71、admin-core 外のテストだが同じハーネス）: `fetchCommissioningStatusOrNull`
  を `deferred` にし、期限で `unverified`（`PolicyTimeoutError`、snapshot は C のまま）、
  `maxRounds` 到達で `unverified`（`PolicyExhaustedError`）、`recheck` の `null` で `unverified`
  （`PolicyStatusUnavailableError`）かつ `end` が呼ばれないこと（banto-hub の `sessionRecheck.test.ts`
  287-292 行の期待を S-71 として引き継ぐ）、`guard` の `null` で `end` が呼ばれることを確かめる。
- `pendingOwnerChange`（S-81）: active(A) → unknown → active(B)（購読なし）→ 同じ B の再確認 → 購読
  （mount）で `pendingOwnerChange` が `{ from: A, to: B }` のまま残っていて通知が 1 回出ること、
  `acknowledgeOwnerChange()` の後は出ないこと。
- `pendingOwnerChange` の破棄（S-83、I-24）: `{ A → B }` が残った状態で `none` を確定 → `pendingOwnerChange`
  が null になること → C を確定しても立たないこと（通知も `'relogin'` も走らない）。§6.1 の寿命の表の
  各行を 1 つずつテストにする（unknown・同値・別ユーザー・none・acknowledge）。
- `previousActiveOwner`（S-76）: active(A) → none → active(B) で owner の差分の通知が出ないこと。
  active(A) → unknown → active(B) では出ること。値の変わらない `commit` で listener が呼ばれないこと。

### 8.2 provider のテスト

- HTTP `resolve()`: `fetchFn` のモックで `200 identity` / `200 null` / `401` / `500` / 通信例外の
  5 通り。`200 null` と `401` でトークンを送っていたときだけ `clearTokenIfCurrent` が効き
  `current !== checked`（かつ `current === credentialRevision()`）になること、応答待ちの間に別のトークンに変わっていたら消さないこと、
  **どの場合も `onCredentialChanged` を呼ばない**こと（S-9・S-65）。
- HTTP の書き込み: 応答の解決の前に別の `setToken`（別のログイン）や `storage` イベントを入れ、
  書き込みが起きないこと（S-20・S-21・S-40）を `storage` の中身で確かめる。`enterPublicViewer`
  は `expectRevision` が今の revision と違えば書かないこと（S-52）。
- revision と通知（I-19）: `login` の応答の継続で `credentialRevision()` が進み listener が 1 回
  呼ばれること。**`logout` の要求が失敗（送信後の失敗を含む）しても、ローカルのトークンを消したなら**
  進んで呼ばれること。CAS 不成立の `logout` では呼ばれないこと。`login`/`setup` の `fetch` が
  失敗したとき（応答が無い）は進めず呼ばない（I-19「HTTP は応答が無いときも進めなくてよい」。
  トークンを書いていないので revision も変わらない）。
- 互換 adapter: `check() true` + `getIdentity() null` が reject になること、`credentialRevision()` と
  答えの `checked`/`current` が常に `ADAPTER_REVISION`（`CredentialRevision` 型の定数）で等しいこと、
  `onCredentialChanged` の listener が呼ばれないこと（保証しない範囲を「テストで固定」する）。
- demo provider: 標準の 3 つを満たすこと（`login`/`logout` で revision が進み通知が出る）。
- Tauri provider: `invoke` のモックで `login`/`logout`/`changePassword` の**応答の `seq`** が
  `credentialRevision()` に反映され、**前と違うときだけ**その継続で `onCredentialChanged` が
  呼ばれること（S-55・S-67・S-68）。続く `auth_resolve` が reject しても通知が済んでいること（S-55）。
  `auth_resolve` の `checked === current` なら listener は呼ばれないこと（S-54）。

- Tauri provider の revision（I-23）の回帰 2 本: **S-73**（`auth_resolve` seq 1 の答えを seq 2 の
  `login` 応答の**後**に解決 → `credentialRevision()` は `2.0` のまま、答えの `checked` は `1.0` で
  `revisionAtStart` `2.0` と不一致、`onCredentialChanged` は login の 1 回だけ）と **S-75**（`auth_resolve`
  の答えを `login` の応答より**先**に解決 → login が `pendingOps` に残っているので `StaleAnswerError` で
  reject、none は採られず、login の応答の後の新しい probe で B が確定）と **S-82**（逆の開始順: `auth_resolve`
  の invoke を先に出し、その後で `login(B)` の invoke を出し、resolve の答えを先に解決 → `pendingOps` が
  空でないので `StaleAnswerError`。`startedAt < entryAt` の判定なら通ってしまうことを、失敗するテストで
  固定してから直す）。**S-78**（`login(A)` の invoke を
  解決しないまま `login(B)` を解決 → `opPendingTimeoutMs` を進めると `local` が +1 して通知、その後の
  `resolve()` は stale にならず B を確定。後で A の invoke を解決しても組は動かない）。加えて: 操作の
  応答が逆順（`logout` seq 3 の応答より `login` seq 2 の応答が後）でも `observedSeq` は戻らない、`invoke`
  の reject で `local` が +1（`2.1`）した後に seq 2 の応答が届いても組は `2.1` のまま、`resolve()` の
  通信の障害の reject では組が動かない（S-26）、`stale: true` は `StaleAnswerError`（S-77）。

### 8.3 Rust 側の競合のテスト（`apps/admin-template/src-tauri/src/lib.rs` の `#[cfg(test)]`）

レビュー 10 のとおり、**コマンド本体で完了の順序を固定する**。そのために、コマンドが
`.await` する 2 つの処理に**注入点**を設ける（REST の `audited_credential_verifier` が
`AuthState::new` に closure を注入しているのと同じ形、§1.7）:

```rust
/// login/setup が await する検証。production は UsersService を包む。テストは gate 付きの実装を渡す。
type CredentialVerifier = Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<Option<UserIdentity>, BantoError>> + Send + Sync>;
/// logout が await する設定の読み。production は SettingsService::auth_config。
type AuthModeSource = Arc<dyn Fn() -> BoxFuture<'static, Result<AuthSettings, BantoError>> + Send + Sync>;
/// setup が await する初回アカウントの作成（実装-1 で追加）。setup は verify ではなく setup_first_user を
/// 待つので、S-18/S-19 の順序の固定にはこの注入点が要る。production は UsersService::setup_first_user。
type FirstUserSetup = Arc<dyn Fn(String, String, String) -> BoxFuture<'static, Result<UserIdentity, BantoError>> + Send + Sync>;
// AppState { verifier: CredentialVerifier, auth_mode: AuthModeSource, .. }

// コマンドは薄い adapter、本体はテストから呼べる関数:
async fn login_body(state: &AppState, username: &str, password: &str) -> Result<LoginResult, BantoError>;
async fn logout_body(state: &AppState) -> Result<LogoutResult, BantoError>;
async fn resolve_body(state: &AppState) -> Result<AuthResolveResult, BantoError>;
```

テストの gate: `tokio::sync::oneshot` を持つ verifier / auth_mode。`tokio::spawn` で本体を走らせ、
gate を**テストが決めた順**で開ける。

- **S-16**（復活しない）: `login_body(B)` を spawn（verifier の gate で止まる）→ `logout_body()` を
  完了させる（`None`、`seq` 進む）→ gate を開ける → `login_body` の戻りが
  `{ success: false, superseded: true }`、`state.auth.session` は `None`、監査は `login`（検証成功）
  1 件と `logout` 0 件（`previous` が無かった場合）。
- **S-17**（消えない）: `logout_body()` を spawn（auth_mode の gate で止まる）→ `login_body(B)` を
  完了させる（`Some(B)`）→ gate を開ける → `logout_body` の戻りは `{ seq }`（login 後と同じ値）、
  `state.auth.session` は `Some(B)`、監査に `logout` が**無い**。
- **配線の検出**: `seq` を `.await` の後に読む誤りを検出するため、gate が開くまでの間に
  `cas_session` を 1 回進める（別の操作）→ 正しい配線なら CAS は失敗する。この「gate の間に seq を
  進める」テストを S-16/S-17 それぞれに持つ。
- **S-18/S-19**: `auth_setup` の本体（`setup_body`）で同じ 2 本（`setup_first_user` は実 DB で 1 回）。
- **S-54**（refresh）: `resolve_body` を 3 回続けて呼び、`checked === current` で `seq` が変わらないこと。
  間に A の **display_name** だけを変えて `resolve_body` を呼ぶと identity の name は変わるが `seq` は
  変わらないこと。
- **S-64**（失効）: 間に A の **role** を `update_user` で変えると（`auth_epoch` が進む、ADR-0014）、
  `resolve_body` は `identity: None` で `current > checked`（失効の clear で `seq` が進む）。
  S-54 とは**別のテスト**にする。
- **S-47**: ログイン不要モードで `auth_config` を書き換えた後の `resolve_body` が新しい権限と
  `kind: "local"` を返すこと。**S-67**: そのモードで `logout_body` が `seq` を進めないこと。
- **S-68**: `change_own_password` の後の `ChangePasswordResult.seq` が進んでいること。
- **補助（非決定的）**: `tokio::join!` で `login_body` と `logout_body` を同時に走らせる。**両方が
  入口で `seq` を読み終えるまで待つ gate**（`tokio::sync::Barrier(2)` を注入点の直前に置く）を
  入れて開始をそろえたうえで、終わったあとの `state.auth` が「`None` かつ login が `superseded`」か
  「`Some(B)` かつ logout が no-op」の**どちらか**であることを複数回回す（gate が無いと、login が
  正常完了してから logout が入口で新しい `seq` を読む正当な逐次の順序が二択に入らず誤って失敗する、
  オーナー 3 回目 5）。順序を固定する上のテストの補助として置く。

### 8.4 E2E

- 既存の `e2e/tests/session-check-outage.ts`（500 の再試行）と `e2e/tests-public-viewer/` は保つ。
- 追加: 「別タブで B がログイン → 元タブが通知を出して B の権限で作り直され、A の未保存入力が
  残らない。B のタブはログインしたまま」（S-35、I-17）を Playwright の 2 ページ（同じ
  context）で。`storage` イベントは同じ origin の 2 ページで実際に飛ぶ。
- 追加: 「別タブで**同じ A** として再ログイン → 元タブが作り直され、通知は出ない」（S-59）。
- 追加: 「identity の 500 の後、別タブでログイン → 元タブが旧ユーザーの画面を出さず、503 の
  再試行画面になる」（S-36・S-60）。
- 追加: 「ログアウトを押した直後に（別タブで）ログイン → 元タブはログイン画面に行かず、
  新しいセッションの画面になる」（S-51。`logout` の応答を route の遅延で遅らせる）。
- **実装-2 を単独でマージした状態で**: 「`load` が A を返した後、mount 前に none が確定 →
  レイアウトが mount → 配線①がログイン画面へ送る。子画面が隠れたまま残らない」（S-74・S-34）、
  「A を表示中に別タブで B がログイン → unknown → B。none を経ずに世代が変わっても再 load される」
  （S-79）、「別タブで同じ A として再ログイン → 再 load、通知なし」（S-80）。
- **503 の画面をまたぐ owner の変更**: 「A → B の確認が 500 → 503 → 背景で B 確定 → **実際の
  「再試行」ボタン**（実装-3 で `invalidateAll()` に変えたもの）を押す → B の再確認 → mount 時に通知が
  1 回出る（`'relogin'` ならログイン画面へ）」（S-81）。ページ全体の再読込（F5）では通知が出ないことは
  仕様（保証しない）で、テストにはしない。
- **none を越えて持ち越さない**: 「未処理の変更あり → 別タブのログアウトで none → 503 画面のホームリンク →
  /login → C で明示的にログイン → 通知も `'relogin'` も出ない」（S-83）。
- banto-hub（移行 PR）: 「試運転中にサーバを止める → ストリームの再確認は `unverified` で画面を保つ
  （lock-down しない）。サーバが戻って lock-down 済みなら終了」（S-71）。

## 9. オーナーの決定（2026-09-29。第三者のレビューを受けて採用）

設計の PR（#261）の判断点に対する決定。本文の各節はこの決定に合わせてある。

1. **旧 API は v2 で削除する。** 状態を更新する旧 API（`establishSession` / `beginSession` /
   `endSession` / `resolveProtectedSession` / `confirmSessionEnded` / `SessionChangedError` など、
   呼び出し側に状態更新の組み立てを求める入口）は削除。参照・購読の API（`sessionGeneration` /
   `onSessionEnded` など）は残すが、独自の状態や確認処理は持たせず controller への委譲に統一する
   （§5.4、I-1）。
2. **`AuthProvider.resolve` は v2 の標準契約で必須（型で必須）。** 旧 provider への対応は明示的な
   互換 adapter に分離する。旧 `check()`/`getIdentity()` を包むだけでは資格情報との対応や副作用の
   安全性は保証できないので、保証する範囲・しない範囲を明記し（§5.2 の表）、旧実装を黙って
   完全対応扱いしない。派生アプリの自前 provider が型エラーになることを移行手順に書く（§6.2）。
   統合修正 4 で、`credentialRevision`・`onCredentialChanged` も必須にして 2 階層にした。
3. **`GET /api/auth/session` は新設しない。** 既存の `GET /api/auth/identity` が `require_auth` と
   同じ再検証（#204）を通るので、HTTP の `resolve()` はこれを 1 回だけ呼ぶ: `200` で identity →
   active、`200 null` または `401` → none、それ以外 → reject。無効なトークンは `401` ではなく
   `200 null` で返る。トークンを送って none が返ったら失効が確定したとみなし、compare-and-set で
   そのトークンを消す（§1.2・§2.1・§5.2）。実装-1 の範囲から `GET /api/auth/session` を外す。
   **新設を判断する条件**: 既存ルートで満たせない具体的な要件が出たとき（例: identity と一緒に
   返さなければ整合が取れない値が増えたとき）。それまでは足さない。
4. **Tauri のログイン不要モードは provider の `resolve()` に任せる**（Rust の `auth_identity` は
   そのたびにモードと権限を読み直す、§1.3）。アプリ側で合成 admin を `adopt()` しない。`adopt()` は
   派生アプリ固有の試運転などに限り、公開閲覧の fallback とは分ける（I-13、S-42・S-47）。
5. **`superseded` になった `load` に今の generation を返さない。** `superseded` は「この確認結果は
   採用できない」であって、navigation が破棄されたとは限らない。まだ有効な `load` は最新の確認に
   合流するか要求し直し、実際に確認できた結果の generation を返す。確認できなければ再試行画面へ。
   旧ユーザーのページデータを新しい世代へ引き継がない。再確認には期限を設ける
   （I-16、S-48〜S-50、`resolveSettled` §5.1）。
6. **確認を出し直さないのは、画面からの待機要求も、背景の確認の必要（SSE の失効通知や資格情報の
   変更の後の、まだ処理していない確認）も無いときだけ。** 待機者の数だけで判断しない
   （I-9、S-14・S-29・S-46、§5.1 の `pendingBackground`）。
7. **`login_superseded` の監査は今回の必須要件から外す。** 今の login の監査は REST・Tauri とも
   「資格情報の検証に成功した」時点で記録している（§1.7）。Tauri に compare-and-set を入れると
   「検証成功・確定拒否」が生まれるので、記録の意味を REST と揃える議論を先にする。観測が必要なら、
   「Rust が世代の不一致で確定を拒否した」ことを、画面側が応答を捨てただけの場合や通常の認証失敗とは
   区別した別のイベントとして記録する（任意、後で）。
8. **別タブでユーザーが切り替わったとき（#257）の既定の流れ**: 検知したら旧画面の操作を止める →
   新しいセッションを確認する → 別のユーザーへの変更が確認できたら通知し、新しい権限で画面を
   作り直す → 旧ユーザーの未保存の入力や選択は引き継がない → 確認に失敗したら旧画面へ戻さず
   再試行の状態に留める → 共有のトークンを勝手に消さず、別のタブまでログアウトさせない。
   共用の端末などで再認証が必要なアプリのために「通知してログインへ移す」方針も注入で選べる
   （I-17、§4.6、§6.1 `ownerChangePolicy`）。

### 9.1 オーナーのレビュー（2026-09-29、`63ca79d` 対象、10 件）への対応

| #   | 指摘                                             | 対応                                                                                                                                                           | 反映先                             |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | logout 後の `end` にも照合が要る                 | ログアウト後に `end()` を呼ぶ入口を無くし、`resolveSettled()` で今の資格情報を確定する契約に統一。`end` は方針専用で ticket 必須                               | I-10、S-17・S-51、§5.1、§6.1       |
| 2   | none 確認時の対象を fallback 全体に結び付ける    | `confirmed` の結果に `ticket` を含め、`status()` の後の同期の照合と `enterPublicViewer({ expectRevision })` の両方で照合。「公開引数は増やさない」を改めた     | I-18、S-42・S-52、§5.2、§6.1       |
| 3   | 非同期の試運転判定からの `adopt` に鮮度の条件    | `adopt(identity, kind, ticket)`・`end(reason, ticket)`。判定の前に `ticket()` を取り、stale なら何もしない                                                     | I-13・I-18、S-44・S-45・S-53、§6.2 |
| 4   | 同値 refresh で `seq` を進めない                 | `seq` の規則を「結び付きを変える意図の操作で進める（値が同じでも）、同じ結び付きの refresh では進めない」と定義                                                | I-11、S-54、§5.3、§8.3             |
| 5   | 変更の通知を追加の確認の成功に依存させない       | 操作の応答に `seq` を含め、provider は応答の継続で revision を確定して通知。応答が無いときも進めて通知。identity の再確認は独立                                | I-19、S-55、§5.2、§5.3、§8.2       |
| 6   | reject も同じ鮮度の判定を通す                    | fulfill・reject・timeout のすべてを同じ照合（手順 4）に通し、古い失敗は状態も `verification` も変えずに捨てる                                                  | I-3、S-56、§5.1                    |
| 7   | owner 変更の通知とは別に画面の再確認を配線       | 配線を 3 本に分けた（世代 → 再 load、owner の差分 → 通知、`unverified` → 503）                                                                                 | S-36・S-59・S-60、§6.1、§8.4       |
| 8   | 自分の commit で自分を superseded にしない       | 判定は probe の `epochAtStart` で行い、`superseded` は外からの遷移の時点で決める                                                                               | I-20、S-14・S-57、§2.1、§5.1       |
| 9   | `cause: 'signal'` の合流判定に要求の時点を含める | `cause: 'signal'` の要求自体が signal の stamp を進める                                                                                                        | I-9、S-58、§5.1                    |
| 10  | Rust のテストでコマンド本体の完了順序を固定      | 検証と設定の読みを注入点にし（REST と同じ形）、gate 付きの実装でコマンド本体の順序を固定。「gate の間に seq を進める」で配線の誤りも検出。非決定的テストは補助 | §1.7、§8.3                         |
| —   | 全体の確認（共通の原則・洗い出し）               | ticket の原則を §2.3 と I-18 に定義。「状態を書き換える入口 × 非同期の境界」の表を §4.9 に置き、同じ型を 1 件追加で見つけた（`authDisabled` の別読み、S-61）   | §2.3、§4.9                         |

### 9.2 統合修正（19 項目、2026-09-29。オーナー 3 回目 5 件 ＋ 独立レビュー ＋ 第三者の補足）

| #   | 修正                                                                                                                                                                                                                                                                                        | 反映先                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | adopt 中の ticket に revision を含めない。S-53 の逆向きを回帰に                                                                                                                                                                                                                             | I-21、`SessionTicket`（§5.1）、S-46・S-62、§2.3 の表                                                                         |
| 2   | provider `resolve()` の戻り値を `{ status, checked, current, identity?, kind? }` に。resolve の中の消去は通知しない。採用条件の書き直し。消去を伴う破棄は `pendingBackground`。Tauri は同じロックで `seq_before`/`seq_after`                                                                | §2.1、`ResolvedAuth`（§5.2）、§5.1 手順 4、I-3・I-15・I-19、S-5・S-9・S-25・S-31・S-65、§5.3 `settle_session`/`auth_resolve` |
| 3   | 実装-1 の受け入れ条件に `sessionGate.ts` 67-68 行の `.success` 判定と `superseded` → `continue`。§7.1 に「単独マージで不変条件」と「既存の呼び出し側の互換」の列                                                                                                                            | §1.1、§7.1                                                                                                                   |
| 4   | provider を 2 階層に（標準は 3 つとも必須／互換 adapter は 3 つともなし）。demo provider を対象に                                                                                                                                                                                           | §5.2、S-2、§1.2、§7.1 実装-3、§6.2                                                                                           |
| 5   | `publicViewerFallback` は `ResolveResult` を返す。呼び出し元が `unverified` を先に処理                                                                                                                                                                                                      | §2.1、§6.1、S-52・S-66                                                                                                       |
| 6   | 配線①を `$effect` の照合に。unheard は「再 probe をやめ、購読時の状態で決める」に（4 回目 6 で確定）。I-2 を「epoch は commit ごと、generation は (status, owner, kind) が変わったときだけ」に。`requestedFor`。`pendingBackground` は残す。`sessionEndUnheard` の期待の変更を CHANGELOG に | I-2、§3.1 の表、§6.1、S-34、S-11、§7.1 実装-2/3、CHANGELOG                                                                   |
| 7   | banto-hub の試運転の方針を先に走らせる（ticket → 状態の取得 → lockedDown なら `end` → `resolveSettled`）。方針の通信に方針自身の AbortSignal                                                                                                                                                | §6.2 の policy runner、S-53・S-62、I-22                                                                                      |
| 8   | `AuthProvider.resolve({ signal })`。AbortController は probe ごと。abort は 2 条件だけ。捨てる判定は残す                                                                                                                                                                                    | I-22、§5.1 手順 2・4・7、§5.2、S-14・S-30                                                                                    |
| 9   | S-54 は display_name だけ。role の変更は none と seq の増加の別テスト。S-9 に注記                                                                                                                                                                                                           | S-54・S-64・S-9、§1.2、§8.3                                                                                                  |
| 10  | 補助テストで両コマンドの seq の取得を gate でそろえる                                                                                                                                                                                                                                       | §8.3 補助                                                                                                                    |
| 11  | 通知は revision / seq が変わったときだけ。auth-disabled の logout の no-op で保留を起こさない                                                                                                                                                                                               | I-19、I-11、S-67、§5.2・§5.3                                                                                                 |
| 12  | `auth_change_password` の応答に `seq`（rebind で進める）。同時のログアウトが CAS 不成立なら active のまま                                                                                                                                                                                   | S-17（注記）・S-68、§5.3、§4.9 の表                                                                                          |
| 13  | `kind: 'local'` の owner key は `local`                                                                                                                                                                                                                                                     | S-47、§5.4 `sessionOwnerKey`                                                                                                 |
| 14  | `resolve({ cause: 'signal' })` は S-33 の退避ループを起こす                                                                                                                                                                                                                                 | I-9、S-33、S-58、§5.1                                                                                                        |
| 15  | 実装-2 の時点で `resolve` の無い provider には `initBanto` で adapter                                                                                                                                                                                                                       | §5.1 `getSessionController`、§7.1 実装-2                                                                                     |
| 16  | `lastActiveOwner` はレイアウトのインスタンスの外                                                                                                                                                                                                                                            | `SessionSnapshot.previousActiveOwner`（§5.1）、§6.1 配線②                                                                    |
| 17  | 「通常のログインの `setToken` が remember のトークンを消す」既存の挙動を保証しないことに                                                                                                                                                                                                    | S-41、§1.2                                                                                                                   |
| 18  | ticket の表から `epochAtRequest` を削除。`SessionSignal` の種別は reason の文字列                                                                                                                                                                                                           | §2.3 の表、§5.1 `signal(reason: string)`                                                                                     |
| 19  | S-36/S-60 の 503 から自動で復帰しないことを保証しないことに                                                                                                                                                                                                                                 | S-36・S-60、§4.6、§6.1 配線③                                                                                                 |

### 9.3 4 回目のレビュー（`7aca87b` 対象。Astra 6 件 ＋ 独立レビュー（Fable）の再レビュー）への対応

| #     | 指摘                                                                    | 対応                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 反映先                                                           |
| ----- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| P1-1  | 手順 0（差の防御）も adopt 中は保留にしない（Astra 1）                  | 保留に移すのは **`status === 'active'` かつ adopt 中でないときだけ**（手順 0 と `onCredentialChanged` の両方）。none／unknown／adopt 中は `pendingBackground` だけ。§3.1 から none→unknown の行を消し、S-42（+1）・S-62（none→active +1）を規則どおりに                                                                                                                                                                                                                           | I-5、§5.1 手順 0・受け口、§3.1、S-42・S-62、S-46・S-69           |
| P1-2  | Tauri の revision の契約（Fable P1-1 ＋ Astra 5）                       | `auth_resolve` は最初の `.await` の前に `seq_at_entry`。`settle_session(…, seq_at_entry)` は 1 ロック内で、seq が動いていれば何も書かず `stale`、一致なら refresh（seq そのまま）か clear（+1）。応答 `{ identity, kind, checked, current, stale }`、stale は reject。provider の revision は不透明な `(observedSeq, local)` の組（`observedSeq` は max、`local` は状態を変える操作の invoke の reject だけ）。`resolve()` は入口の `l` を貼り、在中の操作の完了を待つ。回帰 2 本 | I-23、`CredentialRevision`（§5.2）、§5.3、S-73・S-75・S-77、§8.2 |
| P1-3  | runner の期限・上限は `unverified`（Astra 2）                           | `PolicyTimeoutError` / `PolicyExhaustedError`（snapshot は保つ）。`resolveSettled()` に落とさない。guard は 503、recheck は「確認できない」                                                                                                                                                                                                                                                                                                                                       | §6.2 runner、S-70                                                |
| P2-4  | runner に `mode: 'guard' \| 'recheck'`（Astra 3）                       | recheck の `status === null` は `end`/`adopt` せず `unverified`（`PolicyStatusUnavailableError`。`sessionRecheck.test.ts` 287-292 行 → S-71）。guard の adopt 中の `null` → `end` は v1.7.3 と同じ、を「保証しないこと」に                                                                                                                                                                                                                                                        | §6.2、S-71、§4.6                                                 |
| P2-5  | abort の規則を 1 つに（Astra 4）                                        | 「採用できないことが確定した probe は必ず abort」（捨てたとき・`abandoned` にしたとき）。「待機者 0 かつ pendingBackground 偽」の条件は削除。`settled` フラグ。テスト: 未 abort の fetch が 1 本を超えない                                                                                                                                                                                                                                                                        | I-22、§5.1 手順 4・7、S-72、§8.1                                 |
| P2-6  | unheard の廃止と mount 時の代替を同じ PR に（Astra 6）                  | `onSessionEnded` は購読時に `snapshot.status === 'none'` なら非同期に 1 回通知（再 probe なし）。実装-2 で入れ v2 でも残す。「unheard の廃止」→「再 probe をやめ、購読時の状態で決める」。実装-2 単独で S-34 を検証。`+layout.svelte` は実装-2 では変えない                                                                                                                                                                                                                       | S-34・S-74、§5.4、§7.1 実装-2、§7.3                              |
| P2-7  | `previousActiveOwner` の更新規則（Fable P2-1）                          | commit で `prev.status === 'active'` なら `previousActiveOwner = prev.owner`、**none への commit なら null**（unknown を挟むときだけ保つ）。値が変わらない commit では listener を呼ばない                                                                                                                                                                                                                                                                                        | §5.1、§6.1 配線②、S-76                                           |
| P2-8  | revision を進めるのは状態を変える操作の応答が無いときだけ（Fable P2-2） | `resolve()` の reject では進めない（I-4/S-26）。HTTP は応答が無いときも進めなくてよい                                                                                                                                                                                                                                                                                                                                                                                             | I-19、§5.2 の bullet・doc                                        |
| P3-9  | probe の期限と待機者の期限を分ける                                      | I-8 に 2 種類を明記。待機者は `unverified` を受け取って離れるだけ                                                                                                                                                                                                                                                                                                                                                                                                                 | I-8、§5.1 手順 7                                                 |
| P3-10 | adopt 中の `signal()`                                                   | `pendingBackground` と `latestSignalAt` の更新だけ                                                                                                                                                                                                                                                                                                                                                                                                                                | §5.1 受け口、総点検の表                                          |
| P3-11 | `storage` イベントは `storageKey` だけ                                  | §5.2 の doc と bullet                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §5.2                                                             |
| P3-12 | 実装-2 の委譲版 `resolveProtectedSession` と S-11                       | 「`check()` が reject」は「`resolve()` が reject → `unverified`」に写り、旧 API は reject（throw）で表す                                                                                                                                                                                                                                                                                                                                                                          | §7.1 実装-2 の互換の列、§7.3                                     |
| —     | 全体の確認                                                              | 「adopt 中」と「取得の失敗」の総点検の表（§5.1 の後）を更新。§7.3 の段階ごとの表を更新                                                                                                                                                                                                                                                                                                                                                                                            | §5.1、§7.3                                                       |

### 9.4 5 回目のレビュー（`48b51a6` 対象、6 件）への対応

| #    | 指摘                                                    | 対応                                                                                                                                                                                                                                                                                                                                                                                                                          | 反映先                                                                                |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| P1-1 | S-75 の「待つ」規則をやめる                             | provider は待たない。入口より前に始まった状態を変える操作が pending のまま届いた答えは **stale**（`StaleAnswerError`）として reject し、controller は通信の障害と区別して `verification` を変えずに新しい probe で確認し直す。操作ごとの pending に期限（`opPendingTimeoutMs`）を置き、期限切れは取り消しではなく「結果が分からない」として `local` を進めて通知し、塞ぐ対象から外す。後着の結果は `observe(seq)`／通知で扱う | I-3・I-23、§5.1 手順 4、§5.2 doc、§5.3 provider、S-75・S-77・**S-78**、§8.2           |
| P2-2 | 実装-2 にも generation の変化で再 load する処理を入れる | 配線①（`$effect` の generation の照合）を実装-2 に前倒し（55 行の `onSessionEnded(...)` を置き換え）。段階単独の検証に **S-79**（A → unknown → B）・**S-80**（同じ owner の再ログイン）を追加                                                                                                                                                                                                                                 | §7.1 実装-2、§7.3、S-74・S-79・S-80、§8.4                                             |
| P2-3 | 未処理の owner の変更を同値の再確認で上書きしない       | 「今の状態の直前の owner」（`previousActiveOwner`）と「まだ処理していない変更」（`pendingOwnerChange`）を分ける。後者は active(B) の commit で立て、同値の再確認では上書きせず、`acknowledgeOwnerChange()` だけが消す（controller 側に置き、レイアウトの寿命に依存しない）。**判断**: 方針の実行はレイアウトに残す（`notify`/`goto` は UI）が、mount 時に `snapshot.pendingOwnerChange` を必ず見る                            | `SessionSnapshot`（§5.1）、`acknowledgeOwnerChange`、§6.1 配線②、S-76・**S-81**、§8.1 |
| P2-4 | runner から通常の確認へ引き継ぐときも残りの期限を使う   | 開始時に絶対期限 `deadlineAt` を固定し、`resolveSettled(controller, { deadlineMs: remaining })` に渡す。残りが無ければ `PolicyTimeoutError`。`return await` にして `finally` の `clearTimeout` が引き継ぎの前に走らないようにした。方針の signal は共有の probe に渡さない                                                                                                                                                    | §6.2 runner                                                                           |
| P2-5 | revision の型と受け渡しを `CredentialRevision` に揃える | `expectRevision`・`SessionTicket.revision`・`appliedRevision`・adapter の `checked`/`current`/`credentialRevision()`（`ADAPTER_REVISION` 定数）を `CredentialRevision` に。「`current = checked + 1`」の表記を「`current !== checked`（内部の数値カウンタで +1 してから不透明な値へ）」に全箇所で置き換え                                                                                                                     | I-23、§5.1 型、§5.2 型・bullet・adapter 表、S-9・S-31・S-65・S-77、§8.1・§8.2         |
| P3-6 | 古い規則のまま残っている受け入れ条件を直す              | §8.1 の出し直し／abort の期待を「古い probe は必ず abort、新しい probe は別の signal」に。S-53 の上限を `PolicyExhaustedError` の `unverified` に。文書全体を grep（`resolveSettled() の結果に従う`・`abort されない`・`checked + 1`・`常に 0`・`完了を待`・`inflightOps`）して残りを消した                                                                                                                                   | §8.1、S-53                                                                            |

**4 つの契約 × 6 つの置き場所の照合**（今回の 5 件は、前の修正が一部の箇所にしか届いていない型だった）:

| 契約                                                                                                         | 本文（§2/§4/§5.3）                                                | API のスケッチ（§5.1/§5.2）                                                                                                 | 表（§3/§4.9）                                 | 受け入れ条件（§8）                     | §7 の段階表                    | ADR       |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------- | ------------------------------ | --------- |
| **型**: revision は不透明な `CredentialRevision`、等値比較だけ                                               | §2.1、§5.3 provider（`revision()`）                               | `CredentialRevision`、`ResolvedAuth`、`credentialRevision()`、`SessionTicket.revision`、`expectRevision`、`appliedRevision` | I-23、S-9・S-31・S-65・S-73・S-77             | §8.1 S-31、§8.2 HTTP・adapter・Tauri   | 実装-1（provider）             | 決定 4    |
| **期限**: probe の期限／待機者の期限／pending の操作の期限／方針の絶対期限                                   | §2.1（resolveSettled）、§5.3（`opPendingTimeoutMs`）、§6.2 runner | `timeoutMs`・`deadlineMs`（deps／`resolveSettled`）、`opPendingTimeoutMs`                                                   | I-8・I-22・I-23、S-30・S-49・S-70・S-72・S-78 | §8.1 abort・runner、§8.2 S-78          | 移行（runner の期限）          | 決定 3・6 |
| **世代の変化**: (status, owner, kind) が変わったときだけ +1。変化は配線①で再 load                            | §6.1 配線①、§7.3                                                  | `SessionSnapshot.generation`                                                                                                | I-2、§3.1、S-34・S-59・S-74・S-79・S-80       | §8.1 generation の表、§8.4 実装-2 単独 | 実装-1+実装-2（配線①の前倒し） | 決定 1・6 |
| **owner の変化**: `previousActiveOwner`（直前）と `pendingOwnerChange`（未処理）を分け、`acknowledge` で消す | §6.1 配線②                                                        | `SessionSnapshot.previousActiveOwner`／`pendingOwnerChange`、`acknowledgeOwnerChange()`                                     | I-12、S-35・S-59・S-76・S-81                  | §8.1 S-76・S-81、§8.4 S-81             | 実装-3（配線②）                | 決定 6    |

### 9.5 6 回目のレビュー（`b23f2e1` 対象、3 件 ＋ オーナーの決定）への対応

**オーナーの決定（P2-3 の置き場所）**: 今の形を採る。変更の記録は controller が持ち、通知やログイン画面への
遷移はレイアウトが実行する。契約に明記した 3 点（I-24、§6.1 の寿命の表、ADR 決定 6）:
**保持する**＝`unknown` のとき、同じユーザーの再確認のとき。**終わらせる**＝`none` が確定したら未処理の
変更も破棄。通常はレイアウトが処理して `acknowledgeOwnerChange()` で消す。**再試行**＝S-81 で保証するのは
controller を維持した画面内の再読込だけ。ページ全体の再読込では通知を保証しない。

| #    | 指摘                                                              | 対応                                                                                                                                                                                                                                                 | 反映先                                                |
| ---- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| P1-1 | resolve を始めた後に始まった操作も stale の判定に含める           | stale ＝「答えが届いた時点で未完了の状態を変える操作が 1 つでもある」（開始が入口の前か後かを問わない）。操作ごとの期限（`opPendingTimeoutMs`）と後着の観測はそのまま（永久に待たない）。「開始の前後 × 到着の順序」の網羅表を §5.3 に               | I-23、§5.2 doc、§5.3 bullet・表、S-75・**S-82**、§8.2 |
| P2-2 | 確定した none を経た後のログインへ古い owner の変更を持ち越さない | `none` の確定で `pendingOwnerChange` を破棄（I-24）。受け入れ条件「未処理の変更あり → none → 明示的に C でログイン → 通知も relogin もしない」を **S-83** と E2E に                                                                                  | I-24、§5.1 doc、§6.1 寿命の表、S-83、§8.1・§8.4       |
| P2-3 | S-81 の再試行を実際の 503 画面のボタンとそろえる                  | §6.1 と実装-3 に「503 画面の再試行を controller を維持した `invalidateAll()` に変える」を追加。S-81 の E2E は実際の「再試行」ボタンを押す。ページ全体の再読込では保証しないことを S-81・§4.6・I-24 に。派生アプリの `+error.svelte` を §6.2 の移行に | §6.1、§7.1 実装-3、§6.2、S-81、§4.6、§8.4             |

**照合したこと**: 未処理の変更の寿命を「状態遷移（none・unknown・同じ値・別の owner）× 画面の出来事（mount・
unmount・画面内の再読込・ページ全体の再読込）」の表（§6.1）にし、I-24・S-76・S-81・S-83・§8.1・§8.4・
ADR 決定 6 を同じ規則にそろえた。stale の判定を「操作の開始が resolve の前か後か × 応答の到着の順序」の
表（§5.3）で網羅し、I-23・§5.2・S-73・S-75・S-77・S-78・S-82・§8.2 をそろえた。

## 10. 未確認の点

- Rust の壊れる順序（§1.3）は**コードの読みで特定**した。実機・テストでの再現はしていない
  （実装-1 の S-16/S-17 のテストが再現を兼ねる）。
- `GET /api/auth/identity` が `401` を返す経路は、コードの読みでは見つからなかった
  （`bearer_token` が無ければ `200 null`）。決定 3 のとおり `401` も none として扱うので、
  実装には影響しない。
- `sessionRecheck.ts` の `probeSessionAfterReconnectFailures` の 3 値を `resolveSettled()` の結果に
  写す対応（§6.2）は、`monitor/+page.svelte` の使い方（`streamClose.ts`）を読み切っていない。
  移行 PR で確認する。
- banto-industrial の 2 アプリが自前の `AuthProvider` を持たないことは、`session.svelte.ts` と
  `sessionGuard.ts` が admin-core の provider を使っていることから推測した。`setup.ts` の全文は
  読んでいない。**（実装-3 の独立監査で確認、2026-09-30）推測は誤り**: chronogazer の
  `src/lib/banto/setup.ts` 132〜160 行に `check()`/`getIdentity()` だけの `demoAuthProvider` がある（移行で
  admin-template の `demo.ts` を手本に標準の 3 つを実装する）。banto-hub・chronogazer の `session.svelte.ts` 41 行は
  `getAuthProvider().getIdentity()` を直接呼ぶ（`controller.snapshot`／`resolveSettled` に置き換える）。§1.6・§6.2。
- **（実装-3 の独立監査 P2-2 (c)、別 issue の候補）** HTTP の `logout()` は `POST /api/auth/logout` が失敗しても
  ローカルのトークンを消すので、サーバ側のセッション（トークンの記録）が残ったまま /login へ移りうる。v1 から同じ挙動で、
  この PR では直さない（失効はトークンの期限か、アカウントの `auth_epoch` を進める操作で行われる）。
- `storage` イベントの発火は同じ origin の**別の**ドキュメントに限られる（同じタブでは飛ばない）。
  同じタブの別ログインは provider 自身の `setToken` で revision を上げるので問題ないはずだが、
  Tauri の webview（WebView2）での `storage` イベントの挙動は未確認（Tauri は `sessionStorage`
  も使わないので影響は無いはず。推測）。
- Web Locks API による `localStorage` の原子化は不採用としたが（§4.6）、対応ブラウザの
  範囲は調べていない。
- §4.9 の表で `settings.syncFromProvider()`（M12 の UI 設定の同期）も「`await` の後に照合なしで
  ストアを書く」型に当たるが、セッションの状態ではないので範囲外にした。別の issue の候補。
  「通常のログインが remember のトークンを消す」既存の挙動（S-41）も同様に別の issue の候補。
- Rust の注入点（`CredentialVerifier`・`AuthModeSource`）を `AppState` に足すと、`run()` の
  bootstrap と既存の 23 本のテストの `AppState` 構築が変わる。実装-1 で規模を見る。
- `AuthProvider.resolve({ signal })` の `signal` を HTTP の `fetch` に渡すのは容易だが、Tauri の
  `invoke` は中断できない（I-22 の「中断できない処理」）。Rust 側のコマンドは走り切る。
- **（実装-2 で決定、2026-09-30）provider が観測していない `seq` の前進**: Tauri の webview の再読み込みで provider の `observedSeq` は 0 に
  戻るが Rust の `seq` は進んだまま、また通常のデータ系コマンド（`require_role` → `current_session`）が失効した
  セッションを消して `seq` を進めても provider は観測しない。どちらも次の `resolve()` は `checked` が
  `revisionAtStart` と一致せず捨てられる（`observedSeq` は max で追いつくので次の probe で一致する）。
  実装-2 の controller がこの前進を上限回数（`maxStaleRetries`）を消費せずに救えるか、あるいは provider が
  データ系コマンドの失効系エラーを見て `observe`/`bumpLocal` すべきかを実装-2 で決める。
  **決定**: controller 側の「追いつき」で救う（S-84〜S-86）。捨てた答えについて、同じ回（epoch・signal・provider が
  同じ）で、捨てた理由が `answer.checked !== revisionAtStart` だけで、かつ今の `credentialRevision()` が答えの
  `current` と一致する（provider が答えの `seq` を観測して追いついた）ときは、次の probe を `maxStaleRetries` に
  数えない。無償の出し直しは**要求の連鎖ごとに 1 回**（`catchUpUsed`）なので、revision が動き続けても上限で止まる
  （無限ループしない）。**答え自体は採用しない**（I-3・I-23 は変えない。採用条件は緩めない）。加えて、捨てた直後に
  手順 0 と同じ差の検知を行い、active（adopt 中でない）なら**先に保留**する（I-5。データ系コマンドが A を消した
  場合に、次の probe が失敗しても A が active に残らない、S-85）。provider がデータ系コマンドの失効系エラーで
  `observe`/`bumpLocal` する案は、全コマンドの呼び出し口に手を入れるうえ、エラーの本体に `seq` が無いので
  `bumpLocal`（通知 → 保留）しかできず、controller 側の対処と重複するので採らない（必要なら別 issue）。
  数え方の統一（独立監査 P3-1）: **捨てた答え**からの出し直し（`reissue`）だけが `+1`。新しい出来事（signal・資格情報の
  変化・`end()`・合流できない要求）による在中 probe の置き換えは、`staleCount` と `catchUpUsed` を**そのまま引き継ぐ**
  （数えず、追いつきの無償の枠も増やさない。`kickBackground` と `resolve()` の手順 2 で同じ規則）。
- **（実装-2 で決定、2026-09-30）** HTTP と互換 adapter の `resolve()` は `kind` を返さない（実装-1）。publicViewer の `kind` の決め方
  （`identity.publicViewer` から導くか、provider が返すか）は実装-2 で詰める。
  **決定**: controller が答えから導く（provider は変えない）。`identity.publicViewer === true` なら `publicViewer`
  （発行者の印が唯一の信頼できる判別。ADR-0012。provider が別の `kind` を返してもこちらを優先）、それ以外は
  provider の `kind`（Tauri の `account`/`local`）、無ければ `account`。owner key は `sessionOwnerKey(identity, kind)`
  （`public-viewer` / `local` / `${kind}:${id}` / `account:${id}`、統合修正 13）。HTTP の identity には必ず
  `publicViewer` の印が付くので（§1.2）、provider に `kind` を足す必要は無い（S-87）。
- **（実装-2 で見つけた、実装-3 への申し送り）配線①と「遷移の直前の `invalidateAll()`」の競合**: 配線①の
  `$effect` はログアウトの保留（generation の変化）を見て `invalidateAll()` を出す。SvelteKit は、その直後に
  始めた `goto('/login')` よりも先に出た invalidation を**勝たせる**（`_invalidate` が 1 マイクロタスク後に
  ナビゲーションの token を取り直す）。公開閲覧が有効なサーバでは、再 load が `none` → 公開閲覧の発行に進み、
  ログアウトしたタブがログイン画面ではなく公開閲覧の画面に残った（E2E `public-viewer` 5a で検出）。
  最初は「先に `goto('/login')` → `logout()`」にしたが、ログイン画面が logout の応答より先に出るので、そこで送った
  ログインが pending の logout に provider の compare-and-set で負けた（「別のセッションが先に確定した」。#265 の CI の
  smoke 7。describe.serial の retry で 1 も巻き添えで落ちた）。**実装-2 の最終形は独立監査の代案**: `logout()` →
  `endSession()`（logout の**前に取った ticket**が current のときだけ。別タブのログインなど、その間に確定した
  セッションを終わらせない。`try/finally` で reject も同じ扱い。標準 provider では自分の消去の通知で保留に入り
  ticket は失効する＝controller が自分で none を確定し、`endSession()` が走るのは互換 adapter のときだけ。I-18・I-10）
  → `goto('/login')` の順で、その間は `isLoggingOut()`（`#lib/banto/logout.svelte.ts`、`$state`）が真。配線①は
  ログアウト中は `invalidateAll()` を出さない（反応的に読むので、失敗して画面に残る場合は終了後に照合し直す）。
  §6.1 の v2 の形（`await provider.logout(); await resolveSettled(); goto(login)`）も同じ抑止で順序を保てる（実装-3）。
  **（実装-3 で決定、2026-09-30）** v2 の形にした: `logout()` → `resolveSettled(controller, { cause: 'signal' })` →
  確定が `none` のときだけ `goto('/login')`（`#lib/banto/logout.svelte.ts` の `logoutAndLeave`）。`endSession()` は v2 で
  削除したので、互換 adapter のための「ticket で守った `endSession()`」も無くなった（adapter でも `resolve()` が
  旧 `check()` に聞き直すので、`logout()` が旧 `check()` を `false` にする provider なら `none` が確定する。S-17 の
  テスト）。確認は `cause: 'signal'`（ログアウトの**後**に始めた probe でしか満たされない、I-9）なので、ログアウトの
  前から在中の古い probe の `active` を採らない。抑止は `isLoggingOut()` を `isLeavingForLogin()` に改名して
  ログアウトの全体（`logout()`・確認・`goto`）にかけ、`ownerChangePolicy: 'relogin'` の `goto('/login')` にも
  同じ抑止（`leaveForLogin`）をかけた（同じ「遷移の直前の `invalidateAll()`」の競合を持つため）。2 つの競合は
  どちらも再発しない: 5a（配線①の `invalidateAll()` が `/login` への遷移に勝つ）は、ログアウトの間は配線①が
  `invalidateAll()` を出さないことで、CI の smoke 7（ログアウトの完了前にログイン画面が出て CAS に負ける）は、
  ログイン画面へ移るのが `logout()` と確認の**両方の後**であることで防ぐ（E2E の smoke・public-viewer 5a・6 が緑）。
  確定が `active`（その間に別タブで B がログインした、S-51）なら `/login` へ行かず、抑止が解けた後に配線①が B で
  作り直す。`unverified` ならその場に残り、配線①の再 load が 503 の再試行画面を出す。`logout()` が reject した
  ときも同じく確認する。**（独立監査 P2-2 で変更）** `logoutAndLeave` は投げ直さず `'left' | 'stayed' | 'unverified'`
  を返し、`'stayed'`（ログインしたまま）と `'unverified'`（確認できない）はエラーのトーストで知らせる（以前は投げ直した
  エラーを誰も受けず、画面は無言だった）。
- **（実装-3 以降の改善候補、独立監査 P3-4）** `StaleAnswerError`（pending の操作をまたいだ答え）で即座に出し直すと、
  操作が pending の間は出し直しのたびに同じ理由で捨てられ、`maxStaleRetries` を往復で消費しうる。操作の完了
  （`onCredentialChanged`）を待ってから出し直す、などを検討する。
  **（実装-3 で判断、2026-09-30）v2.0.0 には入れず、ここに残す**。理由: (1) 起きるのは Tauri で、状態を変える操作
  （login/setup/logout/changePassword）の応答待ちと画面の確認が重なったときだけで、admin-template の流れでは
  ログインとログアウトは操作の完了の後に確認するので重ならない（残るのは設定画面のパスワード変更中の画面遷移
  くらい）。(2) 上限に達した結果は `unverified`（`SessionChangedError`）＝ 503 の再試行画面か背景の確認の退避で、
  誤った状態を確定する側ではなく安全側に倒れる（I-4）。(3) 直すには「操作の完了」を知らせる合図が要るが、
  revision が変わらない完了（CAS 不成立・auth-disabled の logout の no-op）では `onCredentialChanged` が来ないので、
  待ち方の設計（provider に「pending が空になった」通知を足すか、短い退避で出し直すか）がもう一段要る。
  (4) 公開 API を壊さずに後から足せる（v2.x の minor で入れられる）。
- **（実装-2 の実装上の判断）** `SessionSnapshot.verification.state` の `'verifying'` は publish しない
  （probe の開始で立てると、捨てた probe が `verification` を触らないという S-56 の約束と両立しない）。
  `resolve()` の options に `signal`（待機者の離脱）を足した（§5.1。`resolveSettled` の `deadlineMs` が使う）。
  互換のために残した旧 API（`beginSession`/`endSession`）は controller の内部の入口（`legacyBegin`/`legacyEnd`、
  外からの遷移として `commit` を通る）に委譲した。単一の書き手（`commit`）は保つが、公開の入口は v2 で消えるまで
  4 つより多い。**（実装-3 で解消）** 旧 API と `legacyBegin`/`legacyEnd`/`legacyResolveSignal` を削除し、公開の
  入口は I-1 の 4 つ（`resolve` の適用・`adopt`・`end`・資格情報の変化による保留）と、別の provider への再 bind
  （`initBanto` の差し替え、実装-2 の #265 P1）になった。
- **（実装-3 の実装上の判断、2026-09-30）**
  - **3 つの必須化と互換 adapter**: `AuthProvider` の `resolve`・`credentialRevision`・`onCredentialChanged` を型で
    必須にし、`check`・`getIdentity` を契約から外した（`LegacyAuthProvider` と `adaptLegacyAuthProvider` にだけ残る。
    HTTP・Tauri の provider からも削除）。実装-2 の「`initBanto` が `resolve` の無い provider を黙って互換 adapter で
    包む」（統合修正 15、実装-2 の時点の足場）はやめ、3 つが無い provider は `initBanto`／`createSessionController` が
    `TypeError` にする（何も置き換えない）。adapter で包むかはアプリが明示的に決める（決定 2）。
    `StandardAuthProvider` は `AuthProvider` と同じ型の別名として残した（v1.8 の型名で書いたコードを壊さない）。
  - **`SessionChangedError`**: §5.4 の表のとおり投げる API は無くなった（`establishSession` などの削除）。
    `unverified` の `error` に入る同名のエラーとして、`SessionTimeoutError` と並べて export は残した（`instanceof` で
    見分けられるように）。`MAX_STALE_RETRIES` は削除（上限は `deps.maxStaleRetries`、既定 3）。
  - **`publicViewerFallback` の戻り値**: 型を `Exclude<ResolveResult, { outcome: 'superseded' }>` に狭めた（中で
    `resolveSettled` を使うので `superseded` は返らない。`ResolveResult` の部分型なので §6.1 の形と両立する）。
  - **`connectEvents`**: `onUnauthorized` → `signal('unauthorized')`、`onTokenCleared` → `signal('credentialCleared')`。
    確認の退避は controller のもので、`connectEvents` の購読解除では止まらない（「失効したかもしれない」を答えのないまま
    にしない。確定すれば止まる）。v1 の `createSessionEndConfirmation` は購読解除で止まっていた（CHANGELOG に記載）。
  - **ログイン画面の `superseded`**: §6.1 のとおり「別のセッションが先に確定しました」を通知して `goto(dashboard)`
    （`load` が今の資格情報で確定する）。setup の `superseded` も同じ。
  - **`ownerChangePolicy`**: admin-template の `#lib/banto/ownerChange.ts` の定数 `OWNER_CHANGE_POLICY`（既定
    `'rebuild'`）。`initBanto` の設定にはしなかった（通知と遷移はアプリの UI の仕事で、admin-core は記録
    `pendingOwnerChange` だけを持つ。§9.5 のオーナーの決定と同じ分担）。処理済みにする
    `acknowledgeOwnerChange()` は通知の**前**に呼ぶ（通知の処理が投げても同じ変更を二重に出さない）。
  - **503 の「再試行」**: `invalidateAll()`。押している間もボタンを無効にしない（固まった再試行が出口ごと塞がない。
    ブラウザの再読込も残る）。
  - **パネルの別ウィンドウ（`routes/panel/[id]`）**: `check()` の代わりに、そのウィンドウの controller の
    `resolveSettled()` で確認する（`unverified` は「確認できない」の表示のまま）。
