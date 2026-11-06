# ADR-0016: フロントのセッションの確定は 1 つの書き手（SessionController）に寄せ、provider は 1 往復で答え、資格情報の書き込みは compare-and-set にする

> English: [0016-session-controller-single-writer.en.md](0016-session-controller-single-writer.en.md)

- 状態: Accepted（2026-09-30、実装-3 の PR。判断点はオーナーの決定 2026-09-29。実装は実装-1 #264・実装-2 #265・実装-3。実装で決めた細部は設計の本文 §10）
- 日付: 2026-09-29
- 関連: Issue #260・#255・#257・#259・#241・#204 / spec §3.3・§8.1 / conventions §10 /
  ADR-0014（アカウントに結び付けた失効）/ ADR-0012（合成 viewer セッション）/
  設計の本文: [docs/design/session-controller-design.md](../design/session-controller-design.md)

## コンテキスト

PR #255（#215：一覧の状態の保持）は、非同期の競合をめぐってレビューが 6 往復した。
5〜6 回目の指摘はすべて「古い認証の応答が、今のセッションを開始・終了・上書きする」
形で、直し方は毎回「開始時の scope を覚えて、答えが返った同じ継続で照合してから
反映する」だった。`019f6e9`（#255 マージ後）のコードで、その照合は 4 か所に散っている
（`sessionGate.ts`・`sessionLifecycle.ts`・`sessionEnded.ts`・アプリの `sessionStore`）。
派生アプリの banto-hub は同じ照合を `sessionRecheck.ts` で独自に作り直している。

根本の原因は 2 つ（設計の本文 §1 でコードの事実を示した）:

1. SvelteKit の `load` の中からモジュールのシングルトンを書き換えている。追い越された
   navigation の副作用は SvelteKit には止められない。
2. `AuthProvider` の答えが「どの資格情報についての答えか」を持たない。`check()` と
   `getIdentity()` は別々に往復し、`check()` には資格情報を消す副作用がある。

さらに、オーナーの指摘で、**Tauri の Rust 側**にも同じ形があることをコードで確かめた:
`auth_login`（646-647 行）・`auth_setup`（622-623 行）は `.await` の後に `state.auth` を
無条件で書き、`auth_logout`（690-691 行）は `.await` の後に無条件で消す。
「ログイン開始 → ログアウト完了 → 遅いログイン完了」で Rust 側のセッションが復活し、
逆の順序では確定したログインが消える。同じファイルの `auth_config_apply_body`・
`change_own_password`・`settle_session` はすでに照合してから書いている。

制約:

- REST と Tauri の両経路に効く（ADR-0001）。REST のサーバ側はトークンごとの map で
  共有の 1 スロットは無い。1 スロットに当たるのは、ブラウザのトークン保存先（#259）と
  Tauri の `state.auth` の 2 つ。
- 派生アプリ 2 本（banto-industrial の chronogazer・banto-hub）は `v1.7.3` に固定されて
  いて、移行は 1 回で済ませたい（A′ 案）。
- 依存を足さない（ADR-0002）。別パッケージも作らない。
- 「取得できない」を「終了」の証拠にしない（#204、ADR-0014 の帰結）。

## 決定

1. **単一の書き手**: フロントの確定したセッションの状態（`status`・`owner`・`generation`・
   `identity`・`kind`）を変えるのは、`SessionController` 内部の `commit()` だけにする。
   公開の入口は `resolve()`（確認の適用）・`adopt(…, ticket)`（アプリの方針による合成セッション）・
   `end(…, ticket)`（方針による終了）・資格情報の変化による保留の 4 つ。**終了の状態へ移すのは
   controller だけ**で、資格情報の破棄とバックエンドの失効の処理は provider とバックエンドが担う。
   ログアウトは `end()` ではなく、provider が資格情報を消した通知 → 保留 → `resolve()` で
   `none` を確定する経路で終わる（ログアウト待ちの間に確定した別のセッションを消さないため）。
   `epoch`（鮮度の照合用、非公開）は `commit` ごとに +1、`generation`（画面の作り直し用、公開）は
   **(status, owner, kind) の組が変わったときだけ** +1（none→none・unknown→unknown・同じ試運転の
   再 adopt は据え置き）。
2. **2 種類の `resolve()` を書き分ける**: `AuthProvider.resolve()` は 1 往復で
   `{ status: 'none' | 'active', checked, current, identity?, kind? }` を答え、取得できないときは
   **reject する**。`checked` は検証した資格情報の revision、`current` はこの呼び出し自身の消去を
   反映した後の revision で、**`resolve()` の中の消去は通知せず答えで運ぶ**。provider は **2 階層**
   だけ: 標準（`resolve`・`credentialRevision`・`onCredentialChanged` の 3 つを型で必須）と、
   互換 adapter（旧 provider は 3 つとも持たず、adapter が形だけ埋める）。「revision だけある」
   階層は作らない。HTTP は**既存の `GET /api/auth/identity` を 1 回**呼ぶ（`require_auth` と
   同じ再検証を通る。`200` で identity → active、`200 null` / `401` → none、それ以外 → reject。
   トークンを送って none なら compare-and-set でそのトークンを消す）。`GET /api/auth/session` は
   新設しない。旧 provider（`check()`/`getIdentity()`）への対応は明示的な互換 adapter に分離し、
   保証する範囲・しない範囲を明記して、旧実装を黙って完全対応扱いしない。admin-template の
   demo provider も標準に書き換える。
   `SessionController.resolve()` は **reject せず**、呼び出し元が「今回の要求について」
   `confirmed` / `unverified` / `superseded` を区別できる結果を返す。共有スナップショットの
   `lastError` で判断させない。`superseded` を受けた `load` は今の generation を返さず、期限内に
   最新の確認に合流して**実際に確認できた** generation だけを返す（確認できなければ再試行画面）。
   公開閲覧の fallback などの方針も `ResolveResult` を返し、呼び出し元が `unverified` を先に
   処理してから `status`/`generation` を使う。
3. **鮮度の照合を構造で守る**: provider の答えは、打ち切っていない・問い合わせを始めた時点の
   遷移回数と同じ・始めた後に signal が来ていない・答えの `checked` が開始時の revision・今の
   revision が答えの `current`、のすべてを満たすときだけ `commit` できる。**成功・失敗・期限切れの
   すべて**が同じ照合を通り、古い失敗は状態も確認の状況も変えずに捨てる。捨てた答えが消去を
   伴っていれば背景の確認（`pendingBackground`）で none を確定する。controller が最後に反映した
   revision と今の revision の差は、通知が無くても保留に移す根拠にする（防御）。ただし**保留に
   移すのは `status === 'active'` かつ adopt 中でないときだけ**で、none／unknown／adopt 中は
   背景の確認の必要を記録するだけ。`AbortController` は問い合わせごとに 1 つで、規則は 1 つ:
   **採用できないことが確定した問い合わせは必ず abort する**（捨てたとき、期限で打ち切ったとき。
   資源の解放であって、正しさの手段ではない。待機者 1 人の期限では止めない）。stale な答え
   （provider の `StaleAnswerError`）は通信の障害と区別し、確認の状況を変えずに新しい問い合わせで
   確認し直す。照合と `commit` は同じ継続で行う。確認は single-flight とし、待機の
   期限を設ける。要求が満たされるかは問い合わせの開始時の遷移回数で判定し、自分の確定で自分を
   追い越したことにしない（`superseded` は外からの遷移の時点で決まる）。`cause: 'signal'` の
   要求は自分で signal の stamp を進め、要求より前に始めた問い合わせには合流しない。
   破棄した確認を出し直さないのは、画面からの待機要求も未処理の背景の確認の必要も無いときだけ
   （待機者の数だけで判断しない）。
4. **資格情報の書き込み・消去は compare-and-set**: HTTP provider のトークン保存（#259）も、
   Tauri の Rust 側 `state.auth`（seq 付きの `AuthSlot`）も、操作を始めたときの revision / seq と
   一致するときだけ書く。公開閲覧の発行は、呼び出し元が `none` を確認した時点の revision
   （`expectRevision`）に結び付ける。Rust の `seq` は**結び付きを変える意図の操作**（login/setup の
   設置、logout の消去は None→None でも）で進め、**同じ結び付きの refresh**（`settle_session` の
   display_name の更新）では進めない（role の変更は `auth_epoch` を進めるので失効であり、`seq` は
   進む）。`auth_resolve` は最初の `.await` の前に `seq_at_entry` を読み、`settle_session` は 1 つの
   ロックの中で seq が動いていれば**何も書かず stale** を返す（provider は reject）。状態を変えた
   操作（login / setup / logout / change_password）の応答は `seq` を返し、provider はその応答の
   継続で revision を確定し、**前と違うときだけ** `onCredentialChanged` を出す（追加の identity の
   確認の成功に依存しない。auth-disabled の logout の no-op では出ない）。provider の revision は
   不透明な `(observedSeq, local)` の組で、controller は等値比較だけで扱う。`observedSeq` は観測した
   `seq` の max で決して減らさず（遅れて届いた古い応答で巻き戻さない）、`local` は状態を変える操作の
   invoke が reject したとき、またはその操作の pending が期限（`opPendingTimeoutMs`）を過ぎて「結果が
   分からない」になったときだけ +1 する。`resolve()` の通信の障害の reject では進めない。公開型は
   すべて不透明な `CredentialRevision`（`credentialRevision()`・答えの `checked`/`current`・ticket の
   `revision`・`expectRevision`）で、足し算は provider の内部だけ。**stale**（Rust の `stale`、または
   答えが届いた時点で未完了の状態を変える操作が 1 つでもある答え。操作の開始が問い合わせの前か後かは
   問わない）は provider が `StaleAnswerError` で reject し、
   controller は通信の障害と区別して確認の状況を変えずに新しい問い合わせで確認し直す。
   「操作の完了を待つ」規則は採らない（応答しない古い操作が後続の確認を塞ぐため）。認証の操作（login / logout / setup / enterPublicViewer）は controller の
   待ち行列に入れず、操作の戻り値を直接 `commit` せず、その後の `resolve()` で確定する。
5. **資格情報の切り替えは保留に移す**: 切り替えを知った時点で、**active のセッション（adopt 中を
   除く）だけ**を `unknown`・owner なし・generation + 1 にし、その後の確認に失敗しても旧 owner の
   active には戻さない（none／unknown／adopt 中は背景の確認の必要を記録するだけ）。
   同じ資格情報での一時的な失敗（確定状態を保つ）とは区別する。別タブでの切り替え（#257）の
   既定は「旧画面の操作を止める → 確認する → 別ユーザーへの変更が確認できたら通知して新しい権限で
   作り直す（未保存の入力は引き継がない）→ 確認できなければ再試行の状態に留める」で、この処理で
   共有のトークンを消さず、他のタブをログアウトさせない。再認証が要るアプリは「通知してログインへ
   移す」方針を注入できる。
6. **SvelteKit との境界**: `load` の副作用は `controller.resolve()` だけ。`{#key generation}` と
   公開閲覧への fallback・試運転の `adopt()` はアプリ層の方針として注入する。`adopt()` は派生アプリ
   固有の合成セッション（試運転）に限り、公開閲覧の fallback と Tauri のログイン不要モードは
   provider の `resolve()` が答える（Rust の `auth_identity` はそのたびにモードと権限を読み直す）。
   core の `sessionGate.ts` から `enterPublicViewer` の呼び出しを外す。画面の再確認は、レイアウトの
   `$effect` が `snapshot.generation !== data.sessionGeneration` を照合して再 load する 1 本で行い
   （同じ generation に二重に出さない）。旧 `sessionEnded.ts` の「unheard の再確認」は再 probe を
   やめ、`onSessionEnded` が購読した時点で `none` なら非同期に 1 回通知する形にする（v2 でも
   そのまま残す。再 probe の廃止と代替を同じ PR に置く）。owner の差分の通知はそれとは別に配線し、
   直近の active の owner は none への遷移で null に戻す。派生アプリの試運転は、ticket → 状態の取得
   （方針自身の AbortSignal）→ `adopt`/`end` → `resolveSettled` の policy runner で行い、ticket が
   失効したら新しい ticket で期限付きにやり直す。runner は `guard`（初回のルートガード。取得の失敗は
   迂回しない側に倒す＝v1.7.3 と同じ）と `recheck`（ストリームの再確認。取得の失敗は `end`/`adopt`
   せず `unverified`）の 2 mode を持ち、期限・回数の上限では既存の snapshot を保ったまま
   `unverified` を返す（`resolveSettled` に落とさない）。期限は開始時に絶対時刻で固定し、通常の確認へ
   引き継ぐときも残りの期限を渡す。配線①（generation の照合による再 load）は実装-2 に前倒しし、
   none を経ない世代の変化（別タブのログイン、同じ owner の再ログイン）でも子画面が隠れたままに
   ならないようにする。未処理のユーザーの変更（`pendingOwnerChange`）は直前の owner とは別に controller が
   保持し、通知やログイン画面への遷移はレイアウトが実行する（オーナー決定）。**保持する**のは `unknown` の
   ときと同じユーザーの再確認のとき。**終わる**のは `none` が確定したとき（未処理の変更も破棄し、セッションの
   終了を越えて持ち越さない）と、レイアウトが処理して `acknowledgeOwnerChange()` を呼んだとき。保証する
   **再試行**は controller を維持した画面内の再読込（503 画面の「再試行」は `invalidateAll()` に変える）
   だけで、ページ全体の再読込では通知を保証しない。
7. **版**: #255 とこの変更をまとめて **v2.0.0** にする（publishing.md：意味の変更はメジャー）。
   状態を更新する旧 API（`establishSession` / `beginSession` / `endSession` /
   `resolveProtectedSession` / `confirmSessionEnded` / `SessionChangedError` など）は**削除**する。
   参照・購読の API（`sessionGeneration` / `onSessionEnded` など）は残すが、独自の状態や確認処理は
   持たせず controller への委譲に統一する（設計の本文 §5.4）。
8. **監査**: `login_superseded` の記録は今回の必須要件から外す。今の `login` の監査は REST・Tauri
   とも「資格情報の検証に成功した」時点で記録している（設計の本文 §1.7）。Rust が世代の不一致で
   確定を拒否したことの観測は、必要になったら別のイベントとして後で足す。
9. **ticket の原則（原則 1・4 の具体化）**: 非同期の判定・操作は、始めたときに ticket
   （controller: 遷移回数・revision・signal、provider: revision、アプリの方針: `SessionTicket`、
   Rust: `seq`）を取り、最後まで持ち回り、適用する直前に**同期で**照合する。照合と適用の間に
   `await` を置かない。照合に失敗した結果は捨てる。`adopt`/`end` は ticket を必須の引数にし、
   `confirmed` の結果は ticket を返す。adopt 中に取った ticket は revision を持たず epoch だけで
   照合する（試運転はトークンで決まらない）。「状態を書き換える入口 × 非同期の境界」の表
   （設計の本文 §4.9）で、この原則の抜けを実装の PR のレビューでも洗う。

不変条件の一覧（I-1〜I-24）、競合のシナリオの表（S-1〜S-83）、generation の数え方の表（§3.1）、
API の案、移行と実装の分割、テストの設計は設計の本文に置く。実装の PR はその番号をテスト名から
参照する。

## 検討した代替案

- **案A（採用）: SessionController に確定を寄せ、provider に 1 往復の `resolve()` と
  compare-and-set を足す。** 利点: 照合が 1 か所になり、`load` から副作用が消え、派生アプリが
  認証処理を組み立てなくてよい。Rust 側も同じ形（すでにある `settle_session` の形）に揃う。
  欠点: 公開 API の意味が変わりメジャーになる。派生アプリの移行が 1 回要る。
- **案B（不採用）: 今の 4 か所にそれぞれ照合を足し続ける（#255 の延長）。** 6 往復の実績が
  示すとおり、照合の抜けは構造では防げない（別の継続に分かれる・呼び忘れる）。派生アプリも
  同じ照合を自前で持ち続ける。
- **案C（不採用）: `AuthProvider` を `Proxy` で包んで login / logout を検知し、そこで状態を
  書く。** #255 の 2〜3 回目で試して退けた（クラス実装の receiver・凍結オブジェクトで壊れる。
  別タブの変化は見えない）。
- **案D（不採用）: 認証の操作もすべて controller の待ち行列に入れて直列化する。** 遅い
  ログインが詰まると再試行もログアウトもできず、安全性と再試行のしやすさを損なう。
  必要なのは順序の保証ではなく「古い答えを適用しないこと」なので、compare-and-set で足りる。
- **案E（不採用）: `localStorage` の原子的な更新に Web Locks API を使う。** タブ間の
  compare-and-set は原理的に必要だが、保証したいのは「旧 owner を active として使い続けない」
  ことで、それは storage イベントからの保留で足りる。対応ブラウザの確認も要り、この設計では
  採らない（保証する範囲・しない範囲を設計の本文 §4.6 に明記）。
- **案F（不採用）: Rust 側は `Mutex` を `.await` をまたいで保持して直列化する。** Tauri の
  コマンドは並行に走り、ロックを await にまたがせると `current_session` の再検証（DB 読み）
  まで直列になる。PR #182 で採った「1 つのロックの中で照合して書く」形（compare-and-set）で
  十分で、既存の 3 か所と揃う。
- **案G（不採用）: REST に `GET /api/auth/session`（check + identity を 1 応答に）を新設する。**
  既存の `GET /api/auth/identity` が `authenticated_session` → `AuthState::authenticate` で
  `require_auth` と同じ再検証を通し、失効を `200 null` で返すので、1 往復の要件をすでに満たす。
  既存ルートで満たせない具体的な要件が出たときに新設を判断する。
- **案H（不採用）: Tauri のログイン不要モードの合成 identity をアプリ側で `adopt()` する。**
  Rust が合成し、`auth_identity` がそのたびにモードと権限を読み直している。フロントで合成すると
  権限の変更を追えず、書き手が増える。
- **案I（不採用）: `superseded` を受けた `load` に今の generation を返す。** 確認していない結果が
  世代ゲートを通り、旧ユーザーのページデータが新しい世代に載る。最新の確認に合流して確認できた
  generation だけを返す（期限付き）。
- **案J（不採用）: ログアウト後の `end()` を、照合付きで残す。** `logout()` の完了後に
  呼び出し側の継続が再開するまでに別のセッションが確定しうる。TS の `logout` は `Promise<void>` で
  戻り値では判断できず、boolean を返しても「消せたが、その後に別のログインが確定した」は防げない。
  provider の通知 → 保留 → `resolve()` の 1 本に統一する方が、入口が 1 つ減る。
- **案K（不採用）: Rust の `seq` を `state.auth` への書き込みごとに進める。** `settle_session` は
  有効なセッションを読むたびに refresh で書くので、`auth_resolve` 自身が revision を変え、正常な
  応答を controller が捨て続ける。「結び付きを変える意図の操作」でだけ進める。
- **案L（不採用）: provider に「revision はあるが通知は無い」中間の階層を認める。** その階層では
  「古い答えを revision 不一致で捨てる → 出し直した答えが reject」の順序で、変更を検知済みなのに
  旧 owner が active に残る。標準は 3 つとも必須、互換 adapter は 3 つとも無し、の 2 階層にする。
- **案M（不採用）: 問い合わせの `AbortSignal` を正しさの手段にする（abort したら答えは来ない前提で
  照合を省く）。** Tauri の `invoke` は中断できず、`fetch` も応答が届いてから abort されうる。
  答えを捨てる判定は abort と独立に残し、abort は資源の解放に限る。

## 帰結

- 実装の PR は 3 本（provider とバックエンド / controller / admin-template の配線と v2.0.0）に
  分け、候補版で派生アプリ 2 本を検証してから、正式版への参照の更新まで 1 本の移行 PR で行う。
- 派生アプリは「チェック → identity → 世代 → 状態」を組み立てず、`controller.snapshot` を
  丸ごと読む。役割の解釈（role）は identity から導く。
- 新しい確認の経路を足すときは、必ず `controller.signal()` の入口に格下げする。controller の外で
  `check()` / `getIdentity()` を呼んで状態を書くコードを増やさない（レビューの観点にする）。
- Rust 側で `state.auth` を書くときは `cas_session`（結び付きを変える操作）か
  `refresh_same_binding`（同じ結び付きの更新）を通す。新しいコマンドを足すときも同じ。状態を
  変えるコマンドの応答には `seq` を含める。
- レビューでは「`await` の後に無条件で書く」「戻り値の boolean だけで判断する」「照合と適用が
  別の継続」の 3 つの形を探す（設計の本文 §4.9 の表）。
- 保証しないことを文書に残す: タブ間の同時操作でどちらが勝つか、切り替えのイベントが届くまでの
  ミリ秒の間に送られる要求。
- 互換のために「障害を `null` に潰す」挙動を、新しい共通処理の標準として残さない。
- 互換 adapter を使う派生アプリは、保証しない範囲（1 往復でない・`check()` の副作用・別タブの
  検知なし）を承知のうえで使い、移行 PR にその旨を書く。自前の provider は v2 で型エラーになる。
- 別タブの切り替えの処理は、どのアプリでも共有のトークンを消さない。ログアウトは利用者の操作か
  バックエンドの失効だけで起こる。
- unheard の再 probe をやめることで `sessionEndUnheard` のテストの期待が変わる（購読した時点で
  `none` なら `onSessionEnded` が非同期に 1 回通知する）。CHANGELOG の「挙動の互換性が変わる変更」に
  載せる。
- generation の増分は §3.1 の表（規則から機械的に導く）を正とし、シナリオの期待とテストはそこから
  引く。規則を変えるときは表とシナリオを同じ PR で直す。
