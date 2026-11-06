# ADR-0012: LAN の閲覧公開は「viewer 固定の合成セッション発行」で実現し、認証バイパスの公開ルータは作らない

> English: [0012-lan-public-viewer-synthetic-session.en.md](0012-lan-public-viewer-synthetic-session.en.md)

- 状態: Accepted
- 日付: 2026-09-14
- 関連: Issue #189 / [docs/design/viewer-public-plan.md](../design/viewer-public-plan.md) /
  conventions §1・§6・§10 / roadmap M10・M11 / ADR-0001（両経路対称）

## コンテキスト

表示専用アプリ（アンドン・常設ダッシュボード・展示デモ）は「書き込みは 1 台の
デスクトップ、閲覧は LAN 上の端末がログイン無し」が標準形だが、M11 ログイン
不要モードは Tauri ウィンドウ限定で、「認証無効 + LAN 有効」は拒否される
（2026-07-08 決定「LAN 側を無認証公開しない」）。個別案件では app 層に
`server.viewerPublic` 設定・読み取り専用 REST `/api/viewer/*`・ログインゲートの
拡張・`auth/status` の応答加工レイヤーを毎回再発明していた。

決めるべきは「LAN クライアントにログイン無しで閲覧を許す**機構**」。制約:

- 書き込み面（mutating）は LAN から無認証で到達できてはならない（元決定の意図）。
- conventions §1（mutating は REST/Tauri 両経路で同一の認可 + 監査）と §6 を
  弱めない。新しい認可経路を増やすほど機械検査（rule 8）の外側が広がる。
- 閲覧に必要な既存 API（SSE `/api/events`、`/api/ui-settings/*`、添付の
  サムネイル/ダウンロード、items の list/get）がそのまま使えること。

## 決定

**`server.viewerPublic` が ON のとき、`POST /api/auth/public-viewer` が
`{ id: "public", role: "viewer" }` 固定の bearer トークンを発行する。**
LAN クライアントはこのトークンで既存の `require_auth` + `RoleGuard` を通り、
`viewer` ロールとして読み取り API を使う。mutating は既存の RBAC が 403 で
拒否し `denied` を監査する。認証をバイパスするルータは作らない。
規約の本文は conventions §6（合成 viewer セッションの規約）に置く。

## 検討した代替案

- **案A（採用）: viewer 固定の合成セッション発行。**
  利点: 認可・監査・SSE・ui-settings が無改造で効く。M10 の「viewer = 表示専用
  ロール」と M11 の「synthetic identity + role」の語彙で説明できる。verify-
  architecture への追加は REST-only ルート 1 本の分類のみ。
  欠点: 匿名端末が `viewer` に許された読み取り**すべて**に到達する（画面側の
  許可リスト `NavItem.publicViewer` は UI を絞るだけ）。表示専用アプリでは
  viewer の読み取り面がそのまま公開面なので受容する。トークン発行が無資格で
  可能なため、同時セッション数の上限で無限増殖を防ぐ。
- **案B（不採用）: 認証をバイパスする read-only 公開ルータを `api_router` に
  差し込む（Issue #189 当初案）。**
  公開したい読み取り API を公開ルータ側に**複製**することになり（items list を
  公開するなら `/api/public/items/list` を別に生やす）、RBAC の外側に第 2 の
  読み取り経路が生まれる。フロントも「トークン無し状態」を provider 層に
  持ち込む必要があり（SSE・ui-settings・添付が 401 になる）、`getBantoMode()`
  の 3 分岐に事実上 4 番目のモードを足すことになる。mutating が誤って公開
  ルータに入るのを機械検査で止める必要も生じる。
- **案C（不採用）: `require_auth` 自体が「viewerPublic ON かつ bearer 無し」を
  合成 viewer として通す。**
  トークン無しで全 GET が通るため、案A と同じ公開面になるが、`actor_identity`/
  `identity_for` がトークン前提で書かれており、ミドルウェアに「暗黙の identity」
  分岐を足すのは §6 の「認可は明示」の流儀に反する。案A なら通常セッションと
  同じ経路（bearer）に乗るので特別扱いが不要。
- **案D（不採用）: M11 を LAN に拡張し、synthetic session のロールを LAN
  側にも適用する。**
  ロールが `admin`/`editor` になり得るため、書き込み面が LAN に出る。元決定の
  意図に反する。

## 帰結

- 合成 viewer トークンは**常に `viewer`**。`issue_public_viewer_token()` に
  `Identity`/role を渡す口を作らない（昇格経路を持たない）。レビュー時は
  ここを最初に見る。
- 発行は監査しない（資格情報の検証ではない）。mutating の `denied` は既存の
  `RoleGuard` が actor `public` で記録する。LAN 上の誰でも `denied` を積めるが、
  監査保持（M14 の prune）で有界。
- 「認証無効 + LAN 有効」は閲覧公開 ON のときだけ許可する。OFF のときの排他は
  2026-07-08 決定のまま。
- 公開閲覧の画面面は `NavItem.publicViewer` の**許可リスト**で絞る（既定は
  dashboard と items）。データ面の境界はあくまで RBAC の `viewer`。
  「viewer に見せたくない読み取り」があるなら、それは viewerPublic ではなく
  RBAC（ロール床）で解くべき問題。
- ui-settings は `ui.public.*` を全公開端末で共有する（デスクトップ M11 の
  `ui.local.*` と同じ性質）。
- 同時セッション上限 `MAX_PUBLIC_VIEWER_SESSIONS`（256）を超えると最古が失効
  する。トークン失効時はフロントのゲートが透過的に再発行する。
