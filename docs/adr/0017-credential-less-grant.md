# ADR-0017: 資格情報なしのセッション発行は「grant」に一本化し、閲覧公開をその 1 種類目、派生アプリの試運転を 2 種類目にする（v3.0.0。認証を迂回する口は banto に作らない）

> English: [0017-credential-less-grant.en.md](0017-credential-less-grant.en.md)

- 状態: Accepted（オーナー決定 2026-10-02。2026-10-03 のオーナーのレビュー（tyaro/banto#313。grant への一般化に賛成）で細目 6 件を決定し、同日の追加決定で**後方互換を捨てて v3.0.0（major）で一本化**する形に改めた。同 PR の 2 回目のレビュー（`0df014d` 対象、3 件）で発行と失効の直列化の契約・#431 の停止例外の保持・管理 WebSocket の接続を追記。**実装: v3.0.0 の実装 PR（本 PR。banto 側の決定 §1〜§4 と移行手順の admin-template の項を実装、派生アプリの移行は tyaro/banto-industrial 側の PR）**）
- 日付: 2026-10-02（改訂 2026-10-03）
- 関連: [ADR-0012](0012-lan-public-viewer-synthetic-session.md)（閲覧公開 = viewer 固定の合成セッション。本 ADR はこれを一般化する。方式の判断は生きているので supersede はしない）/
  [ADR-0003](0003-tls-via-reverse-proxy.md)（同一ホストのリバースプロキシ。決定 §6 の前提）/
  [ADR-0014](0014-account-bound-session-revocation.md)（アカウント照合。grant セッションは対象外）/
  [ADR-0016](0016-session-controller-single-writer.md)・[docs/design/session-controller-design.md](../design/session-controller-design.md) §4.7・§6.2・I-13・I-21（`adopt()`/`end()` を削除する）/
  [docs/design/viewer-public-plan.md](../design/viewer-public-plan.md) §2.2 / conventions §1・§6・§10 /
  [docs/upgrading.md](../upgrading.md)（移行手順の置き場）/
  派生アプリ: tyaro/banto-industrial の banto-hub「試運転モード」・chronogazer
- 対象コード: banto v2.1.1（`25f2291`）。本文の `ファイル:行` はこの版のもの

## コンテキスト

banto には「資格情報なしでセッションを得る」入口が 1 つある。閲覧公開（ADR-0012）の
`POST /api/auth/public-viewer` で、`server.viewer_public` が ON のとき
`{ id: "public", role: "viewer" }` 固定の bearer トークンを発行する
（`crates/banto-server/src/routes/auth.rs:95-105`、`crates/banto-server/src/auth.rs:890-926`）。
発行後は通常のログインと同じ `require_auth` + `RoleGuard` + 監査に乗り、アカウント照合
（ADR-0014）だけを飛ばす（`auth.rs:1131-1135`）。実装は閲覧公開に特化している:

- `TokenRecord.public_viewer: bool`（`auth.rs:424-425`）と
  `AuthenticatedSession.public_viewer: bool`（`auth.rs:255-262`）という **1 ビット**の出自。
- 公開トークンだけの FIFO `Inner::public_tokens`（`auth.rs:577`）と上限
  `MAX_PUBLIC_VIEWER_SESSIONS = 256`（`auth.rs:154`）。
- 発行の条件は handler に直書き（`routes/auth.rs:98`、`SettingsService::server_config().viewer_public`）。
- OFF にしたときの失効は `revoke_public_viewer_tokens`（`auth.rs:936-953`）を
  アプリの `save_server_config_locked` が呼ぶ（`apps/admin-template/src-tauri/src/lib.rs:2155-2166`）。
- クライアントは `publicViewerFallback`（`packages/admin-core/src/sessionController.svelte.ts:1150-1218`）、
  `AuthProvider.enterPublicViewer`・`status().viewerPublic`（`packages/admin-core/src/provider.ts:129,166-168`、
  `providers/http.ts:537-562`）、`kindOfResolvedAuth` は `identity.publicViewer` の印で
  `kind: 'publicViewer'` を導く（`sessionController.svelte.ts:225-229`）。

派生アプリ banto-hub（tyaro/banto-industrial）の「試運転モード」は、同じ「資格情報なしで
セッションを得る」要求を**別の形**で解いている: サーバーがロックダウンされるまでの間、
**全要求を認証なしで合成 admin として通す**独自の認可を 34 か所に持ち、画面側は
`SessionController.adopt()`/`end()`（設計 §4.7 S-44〜S-46、§6.2 の policy runner）で
provider を介さずに試運転セッションを確定する。この形には 2 つの問題がある:

1. **認証の迂回が派生アプリの 34 か所に散っている。** banto の `require_auth`・`RoleGuard`・
   監査・SSE の再検証（`crates/banto-server/src/events.rs:210`）のどれも通らない要求が
   存在し、ロックダウンの判定漏れがそのまま無認証の admin 面になる。conventions §6 の
   「認可は明示」「認証をバイパスする公開ルータは作らない」（ADR-0012 の案 B・C を退けた理由）
   を派生アプリで破っている。
2. **画面側の `adopt()` はトークンを持たないセッション**なので、`resolve()` が provider に
   聞けず（I-13）、ticket は epoch だけ（I-21）、SSE の 401 でも確認に行けない（S-45）。
   SessionController の「provider が 1 往復で答える」原則（ADR-0016）の例外を、利用者
   1 つのために controller 本体に抱えている。

決めるべきは「**派生アプリが『資格情報なしの admin 相当セッション』を必要とするとき、
banto は何を提供するか**」。制約:

- 迂回の口（「この条件のとき認証を飛ばす」フック）を banto に作らない。認可の入口は
  bearer 1 本のままにする（ADR-0012 の決定を弱めない）。
- 発行の条件・上限・失効・寿命は閲覧公開と同じ型で表せる（違うのは identity と条件だけ）。
- 版の扱い: 既知の利用者は admin-template と banto-industrial の 2 アプリ（banto-hub・
  chronogazer）だけ。後方互換の接続コード（旧型・ラッパ・旧 URL のエイリアス）を増やすより、
  **一括で書き換える方が単純**（2026-10-03 オーナー判断）。SemVer どおり互換を壊すので
  **major = v3.0.0**。

## 決定

**閲覧公開の「条件つき・資格情報なしのトークン発行」を `grant` として一般化し、閲覧公開を
その 1 種類目（`publicViewer`）、派生アプリの試運転を 2 種類目（アプリ定義、例 `commissioning`）
にする。閲覧公開専用の API・URL・フィールドは削除し、grant の API に一本化する（v3.0.0）。**
grant は「発行」だけを一般化し、発行後は従来どおり通常の bearer セッションとして
`require_auth` + `RoleGuard` + 監査 + SSE 再検証に乗る。迂回の口は作らない。
画面側は `adopt()`/`end()` を削除し、閲覧公開と同じ fallback（grant を取りに行き、provider が
答える）で試運転セッションを確定する。

### 1. 版（v3.0.0、major）

後方互換は持たない。旧 API・旧 URL・旧フィールドは**削除**し、互換用の関数・旧型・エイリアスは
残さない（削除一覧は「削除するもの」節、派生アプリの書き換えは「v3.0.0 への移行手順」節）。

### 2. サーバー（`crates/banto-server`）

```rust
/// grant の種類。アプリが定義する開いた集合（閉じた enum にしない）。
/// `[A-Za-z][A-Za-z0-9_-]{0,31}`。URL・status・identity.kind・client の SessionKind で同じ文字列を使う。
pub struct GrantKind(/* Arc<str> */);
impl GrantKind { pub const PUBLIC_VIEWER: &str = "publicViewer"; }

pub type GrantCondition =
    Arc<dyn Fn() -> BoxFuture<'static, Result<bool, BantoError>> + Send + Sync>;

pub struct GrantSpec {
    pub kind: GrantKind,
    /// 固定。発行口は identity/role を受け取らない（ADR-0012 と同じ昇格経路なしの性質）。
    pub identity: Identity,
    /// 発行の条件。要求ごとに評価する（閲覧公開は `server_config().viewer_public`）。
    pub enabled: GrantCondition,
    /// 種別ごとの FIFO 上限。既定 256。超えたら最古を失効。
    pub max_sessions: usize,
    /// `None` = `AuthState` の既定 `token_policy`（8h / idle 1h）。remembered は常に false。
    pub policy: Option<TokenPolicy>,
    /// true なら発行口は peer が loopback でないとき（peer 不明を含む）403。
    pub require_loopback_peer: bool,
}
impl GrantSpec {
    /// 閲覧公開: identity `public`/`viewer`、条件 `server_config().viewer_public`、上限 256、loopback 不要。
    pub fn public_viewer(settings: SettingsService) -> GrantSpec;
}

/// `require_auth` が extensions に入れる検証結果（旧 `public_viewer: bool` を `grant` に改名）。
pub struct AuthenticatedSession {
    pub identity: Identity,
    pub grant: Option<GrantKind>,
    pub stamp: Option<SessionStamp>,
}

/// grant 種別ごとの失効の世代（決定 §2「発行と失効の直列化」）。
pub struct GrantGeneration(u64);

impl AuthState {
    /// 発行の判定を始める前に読む世代。
    pub fn grant_generation(&self, kind: &GrantKind) -> GrantGeneration;
    /// 内部ロックの中で `observed` が今の世代と一致するときだけ挿入する。
    /// 一致しなければ挿入せず `None`（発行口は 403、または判定からやり直す）。
    pub fn issue_grant_token(&self, spec: &GrantSpec, observed: GrantGeneration) -> Option<String>;
    /// 同じ内部ロックの中で世代を進め、その種別のトークンを全部消す。
    pub fn revoke_grant_tokens(&self, kind: &GrantKind) -> usize;
}

/// grant の登録と「この peer がいま発行を受けられるか」の評価（公開部品 (2)）。
pub struct GrantRegistry;
impl GrantRegistry {
    /// 名前の衝突・予約語（`account`・`local`、登録済みの kind、識別子の文法違反）は Err。
    pub fn register(&mut self, spec: GrantSpec) -> Result<(), BantoError>;
    /// status と発行で共有する判定。peer 不明は `require_loopback_peer` の kind を false。
    pub async fn availability(&self, peer: Option<SocketAddr>) -> BTreeMap<GrantKind, bool>;
}
/// 発行ルーター（公開部品 (1)）: `POST /api/auth/grant/{kind}` だけ。
pub fn grant_router(auth: AuthState, registry: Arc<GrantRegistry>) -> Router;
```

- **改名**: `TokenRecord.public_viewer: bool` → `grant: Option<GrantKind>`（`auth.rs:424-425`）、
  `AuthenticatedSession.public_viewer: bool` → `grant: Option<GrantKind>`（`auth.rs:255-262`。
  全フィールド `pub` の struct なので、直接構築している利用者は書き換える — 移行手順）。
  `Inner::public_tokens`（`auth.rs:577`）→ `HashMap<GrantKind, VecDeque<String>>`
  （種別ごとの FIFO。閲覧公開の上限・最古追い出し・「実ログインは巻き込まない」
  `auth.rs:2641-2690` のテストは種別ごとに成り立つ）。
- **削除**: `issue_public_viewer_token`・`revoke_public_viewer_tokens`（`auth.rs:890,936`）・
  `MAX_PUBLIC_VIEWER_SESSIONS`（`GrantSpec.max_sessions` の既定 256 に吸収）。
  `PUBLIC_VIEWER_ID`（`"public"`）は `GrantSpec::public_viewer` の identity の id として残す。
- `GET /api/auth/identity` の JSON は `Identity & { kind: string }`（`kind` = grant の文字列 |
  `"account"`。`publicViewer` フィールドは**削除**）。
- アカウント照合の分岐（`auth.rs:1131-1135` の `if session.public_viewer`）は
  `if session.grant.is_some()` に。grant セッションは stamp を持たず、`SessionLookup` を
  引かない（ADR-0014 の対象外。固定 identity なので再読の対象が無い）。
  SSE の再検証 `revalidate`（`auth.rs:1114-1119`、`events.rs:210`）は同じ関数を通るので、
  `revoke_grant_tokens` の後の次の再検証でストリームが終わる（`events.rs:702-713` のテストを
  grant に一般化）。
- `change-password` の拒否（`routes/auth.rs:227`）は `grant.is_some()` に。
  grant セッションは資格情報の持ち主ではない（同名のアカウントがあっても対象にしない）。
- **発行口は `POST /api/auth/grant/{kind}` の 1 本**（`grant_router`。`X-Banto-Client` 必須は
  `crate::csrf` で従来どおり）。**`POST /api/auth/public-viewer` は削除**（閲覧公開は
  `/api/auth/grant/publicViewer`）。順に: 登録されていない `kind` → 404 `not_found`；
  **判定の前に `grant_generation(kind)` を読む**；`GrantRegistry::availability` と同じ判定を
  **発行時にも必ず再評価**し、`require_loopback_peer` かつ peer が loopback でない**または
  peer が分からない** → 403 `forbidden`（fail closed）；`enabled()` が `Ok(false)` → 403、
  `Err` → その `BantoError`（`ApiError`）；通れば `issue_grant_token(spec, observed)` →
  世代が進んでいなければ `{ success: true, token }`（閲覧公開と同じ応答形）、進んでいれば
  `None` → 403（判定の間に条件が閉じられた。次の節）。
  **発行は監査しない**（既存方針、`routes/auth.rs:88-94`）。
- **kind の識別子は camelCase のまま URL にも使う**（`/api/auth/grant/publicViewer`）。
  固定のルート名ではなく kind 識別子なので、`identity.kind`・`status.grants`・URL・
  client の `SessionKind` で**同じ表記**にする（変換表を持たない。別表記のエイリアスは
  作らない）。**名前の衝突は登録時に拒否**する: 既存のセッション種別 `account`・`local`、
  登録済みの kind（`publicViewer` を 2 回登録するのも拒否）、識別子の文法違反は
  `GrantRegistry::register` が `Err`。
- **peer の検査**: `ConnectInfo<SocketAddr>` は **banto の標準の起動経路**（`BoundServer::bind`/
  `serve`、`crates/banto-server/src/server.rs:128-131` の
  `into_make_service_with_connect_info::<SocketAddr>()`）**では常に供給される** —
  banto-serve の `server::start`（`server.rs:174`）、Tauri 組み込みサーバ
  （`apps/admin-template/src-tauri/src/lib.rs:1887` の `bound.serve(router)`）とも。
  公開の `Router` を独自に起動する利用者（`axum::serve` を直接呼ぶ、`tower::oneshot` の
  テスト — `auth.rs:1515-1536` の `MaybePeerAddr` が `None` になる経路）までは保証しない。
  だから **peer 不明は「拒否」**（status では `false`、発行では 403）。
  `rest/tests.rs` は `req.extensions_mut().insert(ConnectInfo(addr))` で明示する。
  loopback 判定は IPv4 射影 IPv6（`::ffff:127.0.0.1`）も loopback に数える
  （`server.rs:264` 付近の正規化と同じ扱い。IPv6 自体は対象外）。
- `/api/auth/status`（`routes/auth.rs:37-66`）は `{ initialized, grants: { <kind>: bool }, …extras }`。
  **`viewerPublic` は削除**（`grants.publicViewer`）。値は `GrantRegistry::availability(peer)`
  （**status と発行処理で同じ判定を共有**）= `enabled()` かつ（`require_loopback_peer` なら）
  peer が loopback。status は**その時点の情報**なので、発行時にも必ず再判定する（上記）。
  **grant ごとの判定の `Err` はその kind を `false` にする**（閲覧公開の「読めなければ
  発行しない」と同じ fail closed）が、**status 全体の失敗の仕方は変えない**
  （`is_initialized` などの DB 障害は従来どおりエラー応答。「status は絶対に失敗しない」とは
  広げない）。
- **公開する部品は 2 つだけ**: (1) 発行ルーター `grant_router`、(2) 登録と発行可否の評価
  `GrantRegistry`。status ルート本体は含めず、既存の status（テンプレートの
  `auth_status_handler`、派生アプリがコピーした status）が `availability(peer)` の結果を
  `grants` として載せる。汎用のプラグイン機構は作らない。
  `extra_auth_router`（`routes/auth.rs:296-320`）は `registry: Arc<GrantRegistry>` を受ける
  **新しいシグネチャに変える**（旧シグネチャは削除）。テンプレートは
  `GrantSpec::public_viewer(settings.clone())` だけを登録する。派生アプリは
  `extra_auth_router` を**コピーして持っている**（banto-hub `core/src/rest.rs:983`、
  chronogazer `core/src/rest.rs:770`）ので、コピー側は `grant_router` を merge し、自分の
  status に `availability` を載せる。
- **失効と監査**: 条件を閉じる操作（閲覧公開 OFF、試運転のロックダウン）が
  `revoke_grant_tokens(kind)` を呼び、戻り値 `usize` を自分の監査 `detail` に
  `revokedGrants: n` として足せるようにする（発行は監査しない代わりに、閉じた側に件数を残す）。
  テンプレートの `save_server_config_locked`（`src-tauri/src/lib.rs:2160-2165`）は
  `revoke_grant_tokens(&GrantKind::PUBLIC_VIEWER)` に書き換える。
- **発行と失効の直列化（契約。#313 の 2 回目のレビュー P1）**。発行時の再判定だけでは次の
  競合が閉じない: 発行 A が `enabled() == true` を取得 → ロックダウン B がフラグ保存と
  `revoke_grant_tokens` を完了 → A が `issue_grant_token`。A のトークンは失効の時点で存在
  しなかったので残り、grant は発行後にアカウント照合も `enabled` の再確認もしないので
  ロックダウン後も使える。現行の閲覧公開（`routes/auth.rs:95-105`）も判定と発行が分かれて
  いて、`save_server_config_locked` の `auth_config_lock` を発行側は取っていない。契約:
  - **`AuthState` が grant 種別ごとの世代（`GrantGeneration`）を持つ。** 発行は
    「判定の前に世代を読む → 判定（`availability`、DB を待ってよい）→ `AuthState` の
    **内部ロックの中で**世代が変わっていなければ挿入、変わっていれば挿入せず `None`」。
    失効 `revoke_grant_tokens(kind)` は「**同じ内部ロックの中で**世代を進めて、その種別の
    トークンを全部消す」。true を取得済みの発行が一時停止し、その間にロックダウンが完了して
    から再開しても、世代が変わっているので挿入されない。発行口は `None` を 403 にする
    （判定からやり直してもよいが、閉じた直後に取り直す理由は無い）。
  - **条件を閉じる側（アプリ）は「条件の保存 → `revoke_grant_tokens`」の順を守る。**
    逆（先に revoke、後で保存）だと、revoke から保存までの間に `enabled()` がまだ true を
    返し、その発行は revoke 後の世代で挿入されて残る。保存が先なら、保存後の判定は false、
    保存前に true を取った発行は revoke の世代の前進で弾かれ、どちらも残らない。
    「フラグ保存の直後、同じ関数内で revoke」はこの順序の実装であって、直列化そのものは
    世代が担う。
  - 比較した代替: **共有の非同期ロックで判定〜発行の全体を包む**（条件を閉じる側も同じ
    ロックを取る）。正しいが、発行が `enabled()` の DB 読みを待つ間ロックを握るので、
    ロックダウンが発行の DB 待ちに引きずられ、閲覧公開の「発行は安価で頻繁（再読み込みごと）」
    と相性が悪い。ロックの所有者がアプリと `AuthState` にまたがる（banto-hub の
    `auth_config_lock` 相当をアプリごとに正しく取る義務が残る）。世代方式は `AuthState` に
    閉じ、アプリの義務は「保存 → revoke の順」だけで済む。採らない。
  - **競合テストを必須にする**（実装 PR と移行 PR のマージ条件）: banto 側の単体テスト
    （`auth.rs`。true を取得済みの発行を `issue_grant_token` の直前で一時停止 → 別タスクで
    `revoke_grant_tokens` → 発行を再開 → `None` が返り、有効なトークンが 1 つも無い。
    閲覧公開・任意 kind の両方）と、派生アプリ（banto-hub）側の統合テスト（`enabled()` が
    true を返した発行要求を保留 → ロックダウン（保存＋revoke）完了 → 発行要求を再開 →
    403 で、直後の `GET /api/auth/identity` が `200 null`（認証が必要なリソースへの要求は 401）、開いていたストリームが閉じる）。

### 3. ユーザー削除の自己削除ガード

`routes/users.rs:69-84` の `acting_user` は token → `identity_for` → `users.get_by_username`
で呼び手の行を解決するが、grant セッションの固定 identity はアカウントを持たないので
`Unauthorized` になり、admin 相当の grant（試運転）がユーザーを削除できない。決定:

- `UsersService::delete_user`（`crates/banto-admin-services/src/users.rs:843`）は acting id を
  `Option<i64>` で受ける形にする（関数名はこの PR の範囲で実装 PR が決める。互換のための
  旧関数は残さない）。
- **actor 無し（acting id 無し）を許すのは、検証済みの grant セッションの場合に限る。**
  判定は `require_auth` が extensions に入れた `AuthenticatedSession` の `grant.is_some()`
  で行い、token から username を引けなかっただけの場合は従来どおり `Unauthorized`。
- **admin の認可（`require_role_at_least(Admin)`）と「最後の admin は消せない」
  （`ensure_admin_removal_allowed`）は維持する。** grant で緩むのは自己削除ガードの
  「自分の行 id」の照合だけ（grant には行が無い）。
- 派生アプリは `UsersService` もコピーしている（banto-hub `core/src/users.rs:634`）ので、
  この変更はテンプレート取り込み（経路 B）で届く。

### 4. クライアント（`@banto/admin-core`）

- `AuthProvider.status()` → `{ initialized, grants: Record<string, boolean> }`（`viewerPublic` は
  **削除**）。HTTP provider（`providers/http.ts:434-456`）は応答に `grants` が無ければ `{}`
  （fail closed）。
- `AuthProvider.enterGrant?(kind, { expectRevision })`（`enterPublicViewer` は**削除**）。
  HTTP provider は `POST /api/auth/grant/{kind}` を叩き、今の `enterPublicViewer`
  （`http.ts:537-562`）と**同じ compare-and-set**（開始時に token が無いこと・revision が
  `expectRevision` のまま）で保存する。Tauri provider・demo provider は未実装のまま
  （閲覧公開と同じ理由、`provider.ts:154-164`）。
- `grantFallback(controller, provider, ticket, { kind, available?, maxRetries? })`
  （`publicViewerFallback`・`DEFAULT_PUBLIC_VIEWER_RETRIES` は**削除**。
  `DEFAULT_GRANT_RETRIES` に改名）。`available(status)` は既定
  `status.grants[kind] === true`。ループの形（`status()` → `isCurrent(ticket)` →
  `enterGrant({ expectRevision })` → `resolveSettled()`、失敗は再試行しない、`superseded` の
  ときだけ上限つきでやり直す）は `sessionController.svelte.ts:1150-1218` のまま。
  `provider.enterGrant` が無ければ `none` のまま返す（例外にしない）。
- `Identity.publicViewer` は**削除**し、`Identity.kind?: string`（発行元が返す印）にする。
  `kindOfResolvedAuth`（`sessionController.svelte.ts:225-229`）は **サーバーの `identity.kind`
  を最優先**、無ければ provider の `kind`（Tauri の `'account'`/`'local'`）、無ければ `'account'`。
  `PUBLIC_VIEWER_ID`（TS、`provider.ts:48`）は削除（識別は `kind` で行う。id で推測しない
  conventions §10 のとおり）。
- `sessionOwnerKey`（`sessionController.svelte.ts:200-213`）: grant の kind は **kind 単独の
  キー**（`publicViewer`・`commissioning` など。固定 identity なので id を足しても情報が
  増えない）。`local` → `local`、`account:${id}` は不変。旧 `public-viewer` キーと adopt の
  `${kind}:${id}` は消える（保存状態の owner が 1 回変わるだけで、消えはしない）。
- owner 変化の比較は `kind === 'account'` の active だけ（S-108、v2.1.1 #308）なので変更なし。
  grant セッションは「端末／アプリの状態」であり「別のユーザー」ではない。
- **`SessionController.adopt()`/`end()` は v3.0.0 で削除**（利用者は banto-hub の
  `commissioningPolicy.ts` だけ）。`SessionTicket` の「adopt 中は epoch だけ」（I-21）、
  手順 0〜7 の「adopt 中」分岐（I-13、S-44〜S-46・S-53・S-62・S-69〜S-71）、
  `SessionController` の `adopt`/`end` も削除する。grant 化した試運転は S-42 と同じ経路
  （provider が答える、ticket は revision を持つ、SSE 401 で確認に行ける）になる
  （[session-controller-design.md](../design/session-controller-design.md) に注記）。

### 5. 派生アプリ側の取り決め（参考。banto の規約ではない）

banto-hub がこの ADR で決めた形（banto には規約として置かない。移行 PR の設計の出発点）:

- ロックダウンは「フラグ保存 → **同じ関数内で直後に** `revoke_grant_tokens("commissioning")`」
  の順（閲覧公開 OFF の `save_server_config_locked` と同じ型）。並行する発行との競合は
  `AuthState` の世代が閉じる（決定 §2「発行と失効の直列化」）。順序を逆にしない
  （先に revoke すると、保存までの間に発行されたトークンが残る）。
- **#431 の「書き込みを止める操作」の障害時方針は移行後も banto-hub の責務として残す**
  （移行手順の banto-hub の項）。banto に移さない。
- 管理 WebSocket（`/api/tag-stream`）のトークン受け取り（`Sec-WebSocket-Protocol`）と
  `SessionStreamCredential` による接続中の再検証は残し、grant トークンを共通の `AuthState`
  の検証に接続する（移行手順の banto-hub の項）。
- ログアウトはトークンを捨てるだけ。試運転中は次の遷移で `grantFallback` が無言で再発行する
  （試運転は「ログアウト」で終わらない。終わるのはロックダウンだけ）。
- elev（昇格）で試運転に戻しても、既存トークンは失効させない。
- bootstrap の自己発行（Rust 側）は試運転の admin grant を `issue_grant_token` で行う。
- `max_sessions` は閲覧公開の 256 より小さくしてよい（admin 相当のトークンの数は少ないほどよい）。
- リバースプロキシ配下の運用条件（§6）を運用ガイドに書く。

### 6. 同一ホストのリバースプロキシ配下（注意書きで対応。技術的には防げない）

loopback 判定で分かるのは**直近の接続元**だけで、外部のクライアントは識別できない。banto は
同一ホストのリバースプロキシ（ADR-0003。TLS 終端）を既に対応構成として想定しているので、
その配下では全要求が loopback に見え、`require_loopback_peer` は保護にならない。
`X-Forwarded-For` は偽装できるので見ない。決定:

- **注意書きで対応し、`trusted_proxies` などの仕組みは今は追加しない**（将来の選択肢として
  記録: `GrantSpec` に信頼するプロキシのアドレスを持たせ、そのときだけ `X-Forwarded-For` を
  読む。依存は増えないが面が増えるので、実需が出るまで足さない）。
- **これは誤設定の防止を運用側に委ねる判断であり、警告を書いても技術的に防げるわけではない。**
  ADR として正直にそう書く。
- 対応構成・導入手順に、最低限次の 2 点を明記する:
  1. **外部公開（プロキシから外へ出す）の前にロックダウンする。**
  2. **再試運転の間も、管理者相当の grant の発行口（`/api/auth/grant/{kind}`）をプロキシから
     外部へ公開しない**（プロキシ側でそのパスを遮断するか、試運転中はプロキシを止める）。
- 書く場所: **banto 側**は README の LAN 配信／リバースプロキシの節（ADR-0003 の対応構成。
  2026-10-08 以降は [recipes/lan-access.md](../recipes/lan-access.md)）と
  conventions §6 の grant 項（実装 PR で書く）。**派生アプリ側の義務**（banto の PR では
  触れない）: banto-hub の運用ガイド §19 と tag-server-design §5.6 に同じ 2 点を書く。
- banto-hub は設定未登録なら試運転 ON（＝初回起動時は admin 相当の grant が発行できる）。
  これを既定 OFF に変えるかは**別の設計判断**で、本 ADR の範囲外。

## セキュリティ

- **入口が 1 ルートに縮む。** 「認証なしで通る要求」は `POST /api/auth/grant/{kind}` の
  発行だけになり、その後は bearer として既存の `require_auth`・`RoleGuard`・監査・SSE 再検証
  （`events.rs:210`）に例外なく乗る。派生アプリの 34 か所の迂回は、trust の判断を
  1 か所（`GrantSpec.enabled`）に集めることで消せる。
- **条件が明示される。** 何が発行を許すかは `GrantSpec`（kind・固定 identity・条件・上限・
  寿命・loopback）に全部書いてあり、レビューはまずそこを見る。閲覧公開の「identity/role を
  引数に取らない」（`auth.rs:872-877`）はそのまま: 発行口はクライアントから identity も role も
  受け取らない。
- **種別ごとの失効。** `revoke_grant_tokens(kind)` は該当 kind だけを消し、実ログイン・他の
  grant を巻き込まない（`auth.rs:2595-2612` のテストの一般化）。`AuthState` はサーバー
  再起動をまたいで共有される（`lib.rs:2162` のコメント）ので、条件を閉じる操作は必ず失効も行う。
- **寿命は既定のまま**（8h / idle 1h、remembered にしない）。切れたら画面が黙って取り直す
  （閲覧公開と同じ。`auth.rs:2629` のテストの一般化）。長生きトークンを配らない。
- **ストリームの再検証は 1 経路。** `revalidate` → `authenticate_with` → `session_for_with`
  なので、失効後の次の再検証で grant のストリームも閉じる。adopt 方式ではここが効かなかった。
  派生アプリの WebSocket（`Sec-WebSocket-Protocol` で bearer を運ぶ）も、取り出したトークンを
  同じ `AuthState` の検証に接続する限り同じ経路に乗る（移行手順）。
- **発行と失効は世代で直列化する。** 発行時の再判定だけでは「true を取得済みの発行が
  ロックダウン完了後に挿入される」競合が残る。`AuthState` の内部ロックの中で、発行は世代の
  一致を確かめて挿入し、失効は世代を進めて消す（決定 §2）。条件を閉じる側は
  「保存 → revoke」の順。競合テストは banto・派生アプリの両方で必須。
- **DB 障害時に「書き込みを止める操作」だけ通す例外（banto-industrial #431）は banto に
  持ち込まない。** grant セッションはアカウント照合を飛ばすので、DB 障害時でも試運転の
  grant からの停止は通常の検証で通る。アカウントのセッションに対する例外（照合不能と
  失効確認済みの区別・照合の期限・停止専用）は banto-hub の責務のまま（移行手順）。
- **注意点 1: ブラウザに admin 相当の bearer が保存される。** 試運転 grant のトークンは
  閲覧公開と同じく `sessionStorage` に入る。ロックダウン後にそれが使えてはならないので、
  **派生アプリは「ロックダウン → 直後の要求が 401 → SSE が閉じる」をテストで固定する**
  （banto 側は `revoke_grant_tokens` の単体テストと SSE の再検証テストまで）。
- **注意点 2: `require_loopback_peer` を付けないと、保護は起動時の bind 制約だけ。**
  試運転 grant を `require_loopback_peer: false` で LAN bind のサーバーに載せると、LAN の
  誰でも admin 相当のトークンを得る。banto は条件を強制しない（アプリの `GrantSpec` が決める）
  ので、ADR の帰結として派生アプリの移行 PR のレビュー項目に置く。
- **注意点 3: リバースプロキシ配下では peer はプロキシ。** 決定 §6 のとおり注意書きで対応し、
  技術的には防げないことを明記する。
- 監査: 発行は監査しない（既存方針）。grant セッションの操作は固定 identity の id が actor
  として残る（閲覧公開の `public` と同じ）。ui-settings は `ui.<identity.id>.*` を同じ kind の
  端末で共有する（`routes/ui_settings.rs:31-36`。閲覧公開の `ui.public.*` と同じ性質）。

## 削除するもの（v3.0.0）

| 削除                                                                                                                | 置き換え                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /api/auth/public-viewer`                                                                                      | `POST /api/auth/grant/publicViewer`                                                       |
| `GET /api/auth/status` の `viewerPublic`                                                                            | `grants.publicViewer`                                                                     |
| `GET /api/auth/identity` の `publicViewer`                                                                          | `kind`（`"publicViewer"` / `"commissioning"` / `"account"`）                              |
| `AuthenticatedSession.public_viewer: bool`                                                                          | `AuthenticatedSession.grant: Option<GrantKind>`                                           |
| `AuthState::issue_public_viewer_token` / `revoke_public_viewer_tokens`                                              | `issue_grant_token(&GrantSpec, GrantGeneration)` / `revoke_grant_tokens(&GrantKind)`      |
| `MAX_PUBLIC_VIEWER_SESSIONS`                                                                                        | `GrantSpec.max_sessions`（既定 256）                                                      |
| `extra_auth_router(users, auth, audit, allow_setup, settings, extras)`                                              | `registry: Arc<GrantRegistry>` を受けるシグネチャ（+ `grant_router`）                     |
| `UsersService::delete_user(id, i64)`                                                                                | acting id を `Option<i64>` で受ける形（名前は実装 PR）                                    |
| `publicViewerFallback` / `DEFAULT_PUBLIC_VIEWER_RETRIES`                                                            | `grantFallback(…, { kind })` / `DEFAULT_GRANT_RETRIES`                                    |
| `AuthProvider.enterPublicViewer` / `status().viewerPublic`                                                          | `enterGrant(kind, …)` / `status().grants`                                                 |
| `Identity.publicViewer` / TS `PUBLIC_VIEWER_ID`                                                                     | `Identity.kind`                                                                           |
| `sessionOwnerKey` の `public-viewer` キーと adopt の `${kind}:${id}`                                                | grant kind 単独のキー                                                                     |
| `SessionController.adopt()` / `end()`、epoch だけの `SessionTicket`、「adopt 中」の分岐                             | `grantFallback` + provider の答え（S-42 の経路）                                          |
| `verify-architecture` rule 8 `REST_ONLY` の `POST /api/auth/public-viewer`（`scripts/verify-architecture.mjs:326`） | `POST /api/auth/grant/{kind}`（Tauri 窓に「grant に入る」操作は無い。閲覧公開と同じ理由） |

`server.viewer_public` の設定キー・`SettingsService` の両方向ガード（viewer-public-plan §2.3）・
`NavItem` の公開画面の許可リストは**残す**（閲覧公開の仕様であって API ではない。許可リストの
フィールド名を `kind` ベースにするかは admin-template の実装 PR で決める）。
`conventions §6` の「合成 viewer セッション」項と `viewer-public-plan §2.2` の規約本文は、
実装 PR で「grant（閲覧公開はその 1 種類）」に書き換える（本 ADR は判断、規約本文は conventions）。

## v3.0.0 への移行手順（派生アプリが書き換えるもの）

正式な手順書は実装 PR で [docs/upgrading.md](../upgrading.md) の「具体例」に足す（例 2 の
v2.0.0 と同じ型: 経路 A（`@banto/*`・`banto-*` の版）と経路 B（コピーしたテンプレート）が
セット・破壊的変更）。ここには**何を書き換えるか**を利用者ごとに挙げる。

共通（Rust）:

1. `AuthenticatedSession { public_viewer, .. }` の直接構築・参照 → `grant: Option<GrantKind>`。
2. `issue_public_viewer_token()` → 決定 §2「発行と失効の直列化」の手順（判定の前に `grant_generation(kind)` で世代を読む → 条件を判定 → `issue_grant_token(&spec, observed)` → `None` は拒否として扱う）。発行口は `grant_router` が持つので、自前で呼ぶのはコピーしたルーターの場合だけ。
   `revoke_public_viewer_tokens()` → `revoke_grant_tokens(&GrantKind::PUBLIC_VIEWER)`。
3. `extra_auth_router(...)` → `GrantRegistry` を組み立てて新シグネチャに渡す。コピーして
   持っている場合は `grant_router(auth, registry)` を merge し、自分の status 応答に
   `availability(peer)` を `grants` として載せ、`viewerPublic` を消す。
4. `users_delete` の acting id の解決を `AuthenticatedSession.grant` で分岐
   （grant なら `None`）。`UsersService::delete_user` の新しい形に合わせる。

共通（TS）:

5. `publicViewerFallback(controller, provider, ticket)` →
   `grantFallback(controller, provider, ticket, { kind: 'publicViewer' })`。
6. `provider.enterPublicViewer(...)` → `provider.enterGrant('publicViewer', ...)`、
   `status().viewerPublic` → `status().grants.publicViewer`。自前の `AuthProvider` を持つなら
   `enterGrant`・`status().grants` を実装する。
7. `identity.publicViewer` の参照（ログアウト導線・ヘッダ・ナビの出し分け）→
   `snapshot.kind`（`'publicViewer'`）。TS の `PUBLIC_VIEWER_ID` の参照を消す。
8. `sessionOwnerKey` の `public-viewer` を前提にした保存状態のキーがあれば `publicViewer` に。

admin-template（banto 本体。実装 PR で同時に書き換える）: `apps/admin-template/core/src/rest/mod.rs:335`
（`extra_auth_router` の呼び出し）、`core/src/rest/tests.rs:2958-3160,3280`（`public_viewer_*` /
`auth_status_reports_viewer_public_*` のテスト）、`core/src/bin/banto-serve.rs`・
`core/src/first_boot.rs`（display プリセットの初回起動シード。設定キーは残る）、
`src-tauri/src/lib.rs:2160-2165,4531,6765`（`save_server_config_locked`・`extra_auth_router`・
テスト）、`src/routes/(app)/+layout.ts:6,44`（`publicViewerFallback`）、`src/lib/session.svelte.ts`・
`src/lib/banto/logout.svelte.ts`・`src/lib/components/{Header,Sidebar}.svelte`・
`src/lib/navigation.ts`・`src/lib/recentCommands.ts`・`src/routes/(app)/+layout.svelte`・
`src/routes/login/+page.svelte`・`src/routes/(app)/settings/{Account,Connectivity}Section.svelte`
（`identity.publicViewer`／`viewerPublic` の参照）、`packages/admin-core`（`provider.ts`・
`providers/http.ts`・`providers/legacyAdapter.ts`・`sessionController.svelte.ts`・
`sessionScope.svelte.ts`・`index.ts`・`tests/*`）、`scripts/verify-architecture.mjs:326`、
`scripts/lib/templates/display/{monitor/+page.svelte,smoke.spec.ts}`・`scripts/scaffold.mjs`、
`e2e/tests-public-viewer/public-viewer.spec.ts`・`e2e/tests/{smoke,tauri-settings-drafts}.spec.ts`・
`e2e/playwright.config.ts`。

banto-hub（tyaro/banto-industrial）:

- Rust: `core/src/stream.rs:1670-1676`（`AuthenticatedSession { public_viewer: false, .. }` →
  `grant: None`）、`core/src/rest.rs:983`（コピーした `extra_auth_router` に `grant_router` を
  merge し、status に `grants`。試運転の `GrantSpec`（kind `commissioning`、admin 固定 identity、
  条件 = 未ロックダウン、`require_loopback_peer: true`、小さい `max_sessions`）を登録）、
  `core/src/rest.rs:773`・`core/src/users.rs:634`（`delete_user` の acting id）、
  ロックダウンの保存関数に「保存 → `revoke_grant_tokens("commissioning")`」の順で失効、
  bootstrap の自己発行。
- Rust（`require_auth_or_commissioning`、`core/src/rest.rs:171-344`）: **削除するのは
  「資格情報なしで通す commissioning 分岐」だけ**（`!is_locked_down()` の早期 return と
  `CommissioningStreamCredential`、合成 identity の要求ごとの返却 — 34 か所の迂回の実体）。
  **残すもの（banto-industrial #431。banto に移さない）**: `OperationKind::StopWrites`、
  `SessionCheck` の「照合不能（`Unverified`）」と「失効確認済み（`Revoked`）」の区別、
  `session_gate_decision` の表、`STOP_SESSION_CHECK_TIMEOUT`（5 秒）、
  `UnverifiedStopException` の監査の印、`POST /api/write-control/disable` だけへの適用
  （`rest.rs:1765-1824`、`WRITE_CONTROL_DISABLE_OPERATION`）。banto の `require_auth`
  （`auth.rs:1562-1572`）は `authenticate` のエラーをそのまま返し照合の期限も無いので、
  一律に置き換えると通常運用中の DB 障害で書き込み停止が拒否される／待ち続ける #431 の
  問題を再導入する。ロックダウン後の判定はこのゲートが `AuthState::authenticate` を呼ぶ形の
  まま（grant セッションは照合を飛ばすので、DB 障害時でも試運転の grant からの停止は
  `Valid` で通る）。既存テスト — 失効が確認できたセッションは拒否、例外を再開
  （`/api/write-control/enable`）などへ広げない、5 秒で打ち切る — は維持する。
- Rust（管理 WebSocket `/api/tag-stream`）: ブラウザの WebSocket は `Authorization` を
  付けられないので、`extract_ws_protocol_token`（`Sec-WebSocket-Protocol: bearer, <token>`、
  パスの厳密一致の許可リスト、`rest.rs:259-269,297-299`）による bearer の取り出しを**残し**、
  通過した要求に `SessionStreamCredential`（`rest.rs:327-335`）を載せる処理も**残す**
  （`ws_upgrade`（`stream.rs:529-552`）はこの拡張から `Revalidator` を作り、無ければ接続中の
  再検証をしない。取り出しだけ直してこの接続を落とすと、ロックダウン後も開いたストリームが
  残る）。取り出した grant トークンは共通の `AuthState` の検証（`authenticate`／`revalidate`）に
  接続する。`CommissioningStreamCredential`（#440、トークン無しのストリーム）は不要になる
  （試運転のストリームも grant トークンで開き、`SessionStreamCredential` で再検証する）。
  テスト: ブラウザ相当（`Sec-WebSocket-Protocol`）で grant トークンの接続が成功すること、
  ロックダウン（保存 → revoke）後の再検証で切断されること。
- Rust（競合テスト、必須）: `enabled()` が true を返した発行要求を保留 → ロックダウン完了 →
  発行要求を再開 → 403、直後の `GET /api/auth/identity` が `200 null`（認証が必要なリソースへの要求は 401）、開いていた SSE／WebSocket が
  再検証で閉じる（決定 §2「発行と失効の直列化」）。
- TS: `src/lib/banto/commissioningPolicy.ts`・`commissioningLockDown.ts`（+ `.test.ts`）・
  `sessionRecheck.abort.test.ts`（policy runner と `adopt()`/`end()` の廃止 →
  `grantFallback(…, { kind: 'commissioning' })` を `src/routes/(app)/+layout.ts` の `none` の後に。
  ロックダウンは `revoke` → 次の要求 401 → `resolve()` が `none`）、`src/lib/session.svelte.ts`・
  `src/lib/banto/logout.svelte.ts`・`hubLogout.test.ts`（`identity.publicViewer` →
  `snapshot.kind`。ログアウトはトークンを捨てるだけ）。
- 運用文書: 運用ガイド §19・tag-server-design §5.6 に決定 §6 の 2 点。

chronogazer（tyaro/banto-industrial）:

- Rust: `core/src/rest.rs:538`（`delete_user` の acting id）、`core/src/rest.rs:770`
  （コピーした `extra_auth_router` → `grant_router` + status の `grants`。grant は
  `publicViewer` だけ）。
- TS: `src/routes/(app)/+layout.ts`・`src/lib/session.svelte.ts`（+ `session.test.ts`）・
  `src/lib/banto/logout.svelte.ts`・`src/lib/banto/{hubAdmin,sessionGuard}.test.ts`
  （`identity.publicViewer`／`viewerPublic`／`publicViewerFallback` の参照）。

## 検討した代替案

- **案 A（採用）: 閲覧公開の発行を grant に一般化し、試運転を 2 種類目にして、閲覧公開専用の
  API は削除して一本化する（v3.0.0）。**
  利点: 認証なしの入口が発行の 1 ルートに縮む。条件・上限・失効・寿命・再検証が閲覧公開と
  同じコードで効き、テスト（`auth.rs:2550-2700`、`rest/tests.rs:3023-3160`、
  `events.rs:702`）が kind をパラメータにした一般化で済む。画面側は `adopt()` の例外経路が
  消えて S-42 の 1 本になる。閲覧公開と試運転が同じコードを通るので、片方だけ直す退行が
  起きない。欠点: 利用者全員が一度書き換える（移行手順）。admin 相当の bearer がブラウザに
  置かれる（注意点 1）。`GrantSpec` に書かれた条件が弱ければそのまま弱い（注意点 2・3）—
  ただしそれは「迂回が 34 か所にある」今より検査しやすい。
- **案 A′（不採用、2026-10-03 オーナー判断）: 後方互換の minor（v2.2.0）で入れる。** 旧 API・
  旧 URL・旧フィールドをラッパ／エイリアスで残し、`AuthenticatedSession` を変えずに grant 情報を
  持つ新しい検証結果型を足し、閲覧公開は旧経路のまま新 kind だけ新 API を使う。
  退けた理由: 利用者は admin-template と banto-industrial の 2 アプリに限られ、互換の接続
  コード（旧型と新型の並存、2 本の fallback、2 本の URL、新旧の組み合わせ表）を増やすより、
  一括で書き換える方が単純。互換を保つなら全フィールド公開の `AuthenticatedSession` には
  手を付けられず（改名も追加も直接構築を壊す）、閲覧公開と試運転が別のコードを通り続ける。
- **案 B（不採用）: `require_auth` に「条件が真なら認証を飛ばして合成 identity を入れる」
  フックを足す**（banto-hub の今の形を banto に移す）。
  ADR-0012 の案 C と同じ理由で退ける: ミドルウェアに「暗黙の identity」分岐が入り、
  `actor_identity`/`identity_for`（`routes/mod.rs:93`）がトークン前提で書かれている所に
  第 2 の経路が生える。SSE の再検証（トークン単位）が効かず、ロックダウンの「即時失効」が
  `revoke_*` 1 回で表せない。失効の対象（トークン）が無いので「切れたら取り直す」も無い。
  verify-architecture の外側が増える。
- **案 C（不採用）: 何もしない（派生アプリが独自に持ち続ける）。**
  34 か所の迂回と `adopt()` の controller 内の例外分岐（§5.1 手順 0〜7 の「adopt 中」列、
  I-13・I-21、S-44〜S-71）を banto が利用者 1 つのために保守し続ける。試運転の終了が
  SSE の再検証・401 で確認できないまま（S-45）。banto-industrial の「重複実装は banto に
  寄せる」方針にも反する。
- **案 D（不採用）: 試運転専用の 2 本目の発行口（`/api/auth/commissioning`）を banto に足す。**
  閲覧公開と条件・identity 以外が同じコードの複製になり、3 種類目が来たらまた複製する。
  banto が派生アプリのドメイン語（試運転）を持つことにもなる。一般化（案 A）の方が小さい。
- **案 E（不採用、将来の選択肢）: `trusted_proxies` を `GrantSpec` に足して `X-Forwarded-For`
  を信頼する。** リバースプロキシ配下の loopback 判定を技術的に補えるが、面が増える。
  実需が出るまで足さず、注意書きで対応する（決定 §6）。

## 帰結

- **grant の発行口はクライアントから identity も role も受け取らない。** `GrantSpec.identity`
  は固定で、発行口は `kind` しか受けない。レビューはまずここを見る（ADR-0012 と同じ）。
- **条件を閉じる操作は必ず「条件の保存 → `revoke_grant_tokens(kind)`」の順で、同じ関数内で
  呼ぶ。** 発行の条件（`enabled`）と失効の呼び出しは対になる（テンプレートは閲覧公開 OFF、
  派生アプリはロックダウン）。並行する発行との競合は `AuthState` の世代が閉じる。
  **競合テスト（true を取得済みの発行を一時停止 → 失効完了 → 再開しても有効なトークンが
  残らない）は banto の単体テストと派生アプリの統合テストの両方で必須。**
  監査の detail に `revokedGrants: n` を足せる。
- **DB 障害時の「書き込みを止める操作」の例外（#431）と、管理 WebSocket のトークン受け取り・
  接続中の再検証は banto-industrial の責務のまま。** 移行で消すのは資格情報なしの
  commissioning 分岐だけ。
- **admin 相当の grant は `require_loopback_peer: true` と小さい `max_sessions` を既定にし、
  リバースプロキシ配下の運用条件（決定 §6 の 2 点）を導入手順に書く**
  （派生アプリの移行 PR のレビュー項目）。
- **閲覧公開と試運転は同じコードを通る。** 閲覧公開の変更は grant 全体の変更として扱い、
  kind をパラメータにしたテストで両方を同時に確かめる。
- 画面側の試運転は `grantFallback` + provider の答えで確定する。`adopt()`/`end()` と
  「adopt 中」の分岐は削除する（controller は「provider が 1 往復で答える」1 本に戻る）。
- 新しい kind を足すのは `GrantSpec` を 1 つ `GrantRegistry` に登録するだけで、banto の
  ルート・verify-architecture の分類は増えない（`/api/auth/grant/{kind}` が 1 本）。
  名前の衝突・予約語は登録時に `Err`。
- v3.0.0 は経路 A（版）と経路 B（コピーしたテンプレート）がセットの破壊的変更。
  [docs/upgrading.md](../upgrading.md) に具体例を足し、CHANGELOG に削除一覧と移行手順を載せる。
- テスト（S 番号の方針）: session-controller-design.md の S 番号は **S-109 以降**を
  grant に充てる（S-42 の kind 一般化、S-44〜S-46 の grant 版、「失効 → 401 → fallback が
  黙って取り直す」、「条件 false → 403 → `none` のまま」、「`enterGrant` の無い provider →
  `none`」）。Rust は `auth.rs` の `public_viewer_*` テストを kind パラメータ化し、
  `rest/tests.rs` に `grant/{kind}` の 404／loopback 403／peer 不明 403／条件 403／発行 →
  identity の `kind`／予約語の登録拒否／status の `grants` と発行の判定が一致すること／
  `users_delete` を grant セッションで（最後の admin は拒否）、`events.rs` に revoke 後の
  再検証でストリームが閉じること。E2E `e2e/tests-public-viewer/public-viewer.spec.ts` は
  新 URL・`grants` に書き換えて通す。

## 未決

なし（2026-10-03 決定。レビュー tyaro/banto#313 の 6 件の行き先: ① → 決定 §1・§2・案 A′、
② → 決定 §2「公開する部品は 2 つだけ」、③ → 決定 §6・案 E、④ → 決定 §2「kind の識別子」、
⑤ → 決定 §2「`/api/auth/status`」、⑥ → 決定 §3）。関数の命名（`delete_user` の新しい形、
`extra_auth_router` の新シグネチャ）は実装 PR で決める（設計の未決ではない）。
