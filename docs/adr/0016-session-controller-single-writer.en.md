# ADR-0016: Give the front end's session one writer (SessionController), make the provider answer in one round trip, and write credentials only by compare-and-set

> 日本語: [0016-session-controller-single-writer.md](0016-session-controller-single-writer.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted (2026-09-30, with the implementation-3 PR; the open points were decided by the owner on 2026-09-29; implemented by #264, #265 and implementation-3; details settled during implementation are in §10 of the design body)
- Date: 2026-09-29
- Related: Issue #260, #255, #257, #259, #241, #204 / spec §3.3, §8.1 / conventions §10 /
  ADR-0014 (account-bound revocation) / ADR-0012 (synthetic viewer session) /
  design body: [docs/design/session-controller-design.md](../design/session-controller-design.md) (Japanese only)

## Context

PR #255 (#215: keeping list view state) went through six review rounds over asynchronous
races. Every finding in rounds 5 and 6 had the same shape - "a stale authentication answer
starts, ends or overwrites the current session" - and every fix was "capture the scope when
the request starts and compare it in the same continuation the answer arrives in, before
applying it". In `019f6e9` (main after #255) that comparison lives in four places
(`sessionGate.ts`, `sessionLifecycle.ts`, `sessionEnded.ts`, and the app's `sessionStore`).
The derived app banto-hub rebuilds the same comparison on its own in `sessionRecheck.ts`.

Two root causes (the design body §1 backs them with code):

1. Module singletons are written from inside SvelteKit `load`. SvelteKit discards the result
   of an overtaken navigation but cannot stop its side effects.
2. An `AuthProvider` answer does not say which credential it is about. `check()` and
   `getIdentity()` make separate round trips, and `check()` has the side effect of clearing
   the credential.

The owner also pointed out that the **Tauri Rust side** has the same shape, and the code
confirms it: `auth_login` (lines 646-647) and `auth_setup` (622-623) write `state.auth`
unconditionally after an `.await`, and `auth_logout` (690-691) clears it unconditionally
after an `.await`. "Login starts -> logout completes -> the slow login completes" revives
the Rust session; the reverse order erases a login that had already been confirmed. In the
same file, `auth_config_apply_body`, `change_own_password` and `settle_session` already
compare before writing.

Constraints:

- It must hold on both the REST and the Tauri path (ADR-0001). The REST server keeps a
  per-token map, so there is no shared single slot there; the single slots are the browser's
  token storage (#259) and Tauri's `state.auth`.
- The two derived apps (banto-industrial's chronogazer and banto-hub) are pinned to `v1.7.3`
  and should migrate once (plan A′).
- No new dependencies (ADR-0002), no new package.
- "Could not verify" is never evidence of "ended" (#204, a consequence of ADR-0014).

## Decision

1. **One writer.** Only `commit()` inside `SessionController` changes the front end's
   confirmed session state (`status`, `owner`, `generation`, `identity`, `kind`). The public
   entry points are four: `resolve()` (applying a verification), `adopt(…, ticket)` (an
   app-policy synthetic session), `end(…, ticket)` (a policy-driven end), and the suspension
   caused by a credential change. **Only the controller moves the confirmed state to its ended
   state**; disposing of credentials and revoking on the backend belong to the provider and the
   backend. Logout does not go through `end()`: the provider clears the credential and notifies,
   the controller suspends, and `resolve()` confirms `none` (so a session confirmed while the
   logout was pending is not erased). `epoch` (private, for freshness checks) advances on every
   `commit`; `generation` (public, for rebuilding screens) advances **only when the
   (status, owner, kind) triple changes** (none→none, unknown→unknown and re-adopting the same
   commissioning session leave it unchanged).
2. **Two different `resolve()`s.** `AuthProvider.resolve()` answers
   `{ status: 'none' | 'active', checked, current, identity?, kind? }` in one round trip and
   **rejects** when it cannot obtain an answer. `checked` is the revision of the credential it
   verified; `current` is the revision after this call's own clearing, and **a clearing inside
   `resolve()` is carried in the answer, never notified**. Providers come in exactly **two
   tiers**: standard (`resolve`, `credentialRevision`, `onCredentialChanged`, all three required
   by the type) and the compatibility adapter (a legacy provider has none of the three; the
   adapter fills in the shape). There is no "revision only" tier. The HTTP provider calls the **existing
   `GET /api/auth/identity` once** (it goes through the same re-validation as `require_auth`:
   `200` with an identity → active, `200 null` / `401` → none, anything else → reject; when a
   token was sent and the answer is none, that token is cleared by compare-and-set). No
   `GET /api/auth/session` is added. Support for legacy providers (`check()`/`getIdentity()`) is
   split into an explicit compatibility adapter whose guarantees and non-guarantees are written
   down; a legacy implementation is never silently treated as fully supported.
   `SessionController.resolve()` **never rejects**; it returns, for this request,
   `confirmed` / `unverified` / `superseded`. Callers do not infer the outcome from the shared
   snapshot's `lastError`. A `load` that receives `superseded` does not return the current
   generation; within a deadline it joins the latest verification and returns only a generation
   it **actually confirmed** (otherwise the retry page). Policies such as the public-viewer
   fallback also return a `ResolveResult`, and the caller handles `unverified` before using
   `status`/`generation`. admin-template's demo provider is rewritten to the standard tier.
3. **Freshness enforced by structure.** A provider answer may be committed only if all of
   these hold: the probe was not abandoned, the controller transition count equals the one
   captured when the probe started, no signal arrived after the probe started, the answer's
   `checked` equals the revision at probe start, and the current revision equals the answer's
   `current`. **Fulfilment, rejection and timeout all pass the same check**; a stale failure is
   discarded without touching the state or the verification status. A discarded answer that
   carried a clearing sets the background need (`pendingBackground`) so that `none` is confirmed
   by a fresh probe. A difference between the revision the controller last applied and the
   current one is, even without a notification, grounds for suspension (a defence). Suspension
   itself applies **only to an active session that is not adopted**; for none / unknown /
   adopted sessions only the background need is recorded. One `AbortController` per probe, with
   one rule: **a probe that can no longer be adopted is always aborted** (when it is discarded,
   when its deadline abandons it). It frees resources; it is not a correctness mechanism, and a
   single waiter's deadline does not abort it. A stale answer (the provider's `StaleAnswerError`)
   is told apart from a communication failure: the verification status is left alone and a new
   probe re-verifies. The comparison and the `commit` happen in one
   continuation. Verification is single-flight with a wait deadline. Whether a request is
   satisfied is judged by the transition count captured when the probe started, so a request's
   own commit never makes it `superseded` (`superseded` is decided at the moment of an external
   transition). A `cause: 'signal'` request advances the signal stamp itself and never joins a
   probe started before the request. A discarded probe is not re-issued only when there is
   neither a waiting request from a screen nor an unprocessed background need (a signal or a
   credential change); the number of waiters alone does not decide it.
4. **Credential writes and clears are compare-and-set.** Both the HTTP provider's token
   storage (#259) and Tauri's `state.auth` (an `AuthSlot` with a `seq`) write only when the
   revision / seq read at the start of the operation still matches. Issuing the public-viewer
   session is bound to the revision at which the caller confirmed `none` (`expectRevision`).
   Rust's `seq` advances on **operations that intend to change the binding** (installing on
   login/setup, clearing on logout even when None→None) and **not** on a refresh of the same
   binding (`settle_session` updating the display name; a role change advances `auth_epoch`,
   so it is a revocation and `seq` does advance). Operations that change state (login / setup /
   logout / change_password) return `seq` in their response, and the provider fixes its revision
   and fires `onCredentialChanged` in the continuation of that response **only when the revision
   changed** (never depending on a follow-up identity check succeeding; not on the auth-disabled
   logout no-op). `auth_resolve` reads `seq_at_entry` before its first `.await`, and
   `settle_session` returns **stale without writing anything** when the seq has moved (the
   provider rejects). The provider's revision is an opaque `(observedSeq, local)` pair that the
   controller compares only for equality: `observedSeq` is the max of the seqs observed from
   Rust and never decreases (a late, old response cannot roll it back); `local` advances only when
   a state-changing operation's invoke rejects, or when that operation's pending entry passes its
   deadline (`opPendingTimeoutMs`) and becomes "outcome unknown". A `resolve()` rejected by a
   communication failure never advances it. Every public type is the opaque `CredentialRevision`
   (`credentialRevision()`, the answer's `checked`/`current`, the ticket's `revision`,
   `expectRevision`); arithmetic happens only inside the provider. A **stale** answer (Rust's
   `stale`, or an answer that arrives while at least one state-changing operation is still
   pending, whether that operation started before or after the probe's entry) is rejected by the
   provider with `StaleAnswerError`; the controller tells it apart
   from a communication failure and re-verifies with a new probe without touching the verification
   status. A "wait for in-flight operations" rule is not adopted (an unresponsive old operation
   would block every later verification).
   Authentication operations (login / logout / setup / enterPublicViewer) are not queued behind
   the controller, their return values are not committed directly, and the session is confirmed
   by the following `resolve()`.
5. **A credential switch suspends.** As soon as a switch is known, **an active session that
   is not adopted** becomes `unknown`, ownerless, `generation + 1`; a later failed verification
   does not fall back to the previous owner's active state (for none / unknown / adopted sessions
   only the background need is recorded). This is distinct from a transient failure with the same
   credential (which keeps the confirmed state). The default for a user switch in another tab
   (#257) is: stop the old screen's actions → verify → once a change to a different user is
   confirmed, notify and rebuild the screen with the new permissions (unsaved input is not carried
   over) → if verification fails, stay in the retry state. This never clears the shared token and
   never logs other tabs out. An app that needs re-authentication can inject a "notify and go to
   login" policy instead.
6. **SvelteKit boundary.** The only side effect in `load` is `controller.resolve()`.
   `{#key generation}`, the public-viewer fallback and commissioning's `adopt()` are app-layer
   policies. `adopt()` is limited to derived-app-specific synthetic sessions (commissioning); the
   public-viewer fallback and Tauri's login-not-required mode are answered by the provider's
   `resolve()` (Rust's `auth_identity` re-reads the mode and role on every call). The
   `enterPublicViewer` call leaves core's `sessionGate.ts`. Re-loading the screen is one wire:
   the layout's `$effect` compares `snapshot.generation !== data.sessionGeneration` and calls
   `invalidateAll()` (never twice for the same generation). The old "unheard" re-confirmation in
   `sessionEnded.ts` stops re-probing: `onSessionEnded` notifies once, asynchronously, when the
   snapshot is already `none` at subscription time (kept in v2; the removal of the re-probe and
   its replacement land in the same PR). Notifying an owner change is wired separately, and the
   last active owner is reset to null on a transition to none. A derived app's commissioning runs
   as a policy runner (ticket → fetch the status with the policy's own AbortSignal →
   `adopt`/`end` → `resolveSettled`) that retries with a fresh ticket, under a deadline, when the
   ticket has expired. The runner has two modes, `guard` (the initial route guard; a failed fetch
   falls to "no bypass", as in v1.7.3) and `recheck` (the stream re-check; a failed fetch is
   `unverified` and neither ends nor adopts), and on its deadline or round limit it returns
   `unverified` with the existing snapshot instead of falling through to `resolveSettled`. The
   deadline is fixed as an absolute time at the start and the remainder is handed to the ordinary
   verification. Wire ① (re-load on a generation change) is pulled forward into implementation PR 2
   so that generation changes that never pass through none (a login in another tab, a re-login as
   the same owner) do not leave the child screen hidden. An unprocessed user change
   (`pendingOwnerChange`) is kept by the controller separately from the previous owner, while the
   notification and the move to the login screen are executed by the layout (owner's decision).
   It is **kept** while the state is `unknown` and across a re-verification of the same user. It
   **ends** when `none` is confirmed (the unprocessed change is discarded too; nothing is carried
   across the end of a session) or when the layout has handled it and called
   `acknowledgeOwnerChange()`. The **retry** that is guaranteed is an in-page reload that keeps
   the controller (the 503 screen's "retry" becomes `invalidateAll()`); after a full page reload
   the notification is not guaranteed.
7. **Version.** #255 and this change ship together as **v2.0.0** (publishing.md: a change of
   meaning is a major). The state-updating legacy API (`establishSession` / `beginSession` /
   `endSession` / `resolveProtectedSession` / `confirmSessionEnded` / `SessionChangedError`, ...)
   is **removed**. The read/subscribe API (`sessionGeneration` / `onSessionEnded`, ...) stays but
   holds no state or verification logic of its own; it delegates to the controller (design body
   §5.4).
8. **Audit.** Recording `login_superseded` is out of this round's required scope. Today both REST
   and Tauri record `login` at the moment "credentials were verified" (design body §1.7).
   Observing that Rust refused to install a session because of a sequence mismatch can be added
   later as a separate event if needed.
9. **The ticket principle (principles 1 and 4 made concrete).** An asynchronous decision or
   operation takes a ticket when it starts (controller: transition count, revision, signal;
   provider: revision; app policy: `SessionTicket`; Rust: `seq`), carries it to the end, and
   compares it **synchronously** right before applying the result. No `await` sits between the
   comparison and the application. A result that fails the comparison is discarded. `adopt` /
   `end` take the ticket as a required argument and a `confirmed` result returns one. A ticket
   taken while a session is adopted carries no revision and is compared by epoch only
   (commissioning is not decided by the token). The "state-writing entry point × asynchronous
   boundary" table (design body §4.9) is used to hunt for gaps in this principle during the
   implementation PR reviews too.

The invariants (I-1 to I-24), the race scenario tables (S-1 to S-83), the generation table
(§3.1), the API sketch, the migration and PR split, and the test design live in the design body.
The implementation PRs reference those numbers from test names.

## Alternatives considered

- **Option A (adopted): concentrate confirmation in a SessionController and add a
  one-round-trip `resolve()` plus compare-and-set to the provider.** Pros: one place compares,
  `load` loses its side effects, derived apps stop assembling authentication. The Rust side
  aligns with the shape it already has in `settle_session`. Cons: the public API changes
  meaning (major); the derived apps migrate once.
- **Option B (rejected): keep adding comparisons to the four existing places (#255
  continued).** Six rounds showed the gaps cannot be prevented structurally (split
  continuations, forgotten calls). Derived apps keep their own copies.
- **Option C (rejected): wrap `AuthProvider` in a `Proxy` to observe login / logout and write
  state there.** Tried and dropped in #255 rounds 2-3 (breaks class receivers and frozen
  objects; cannot see other tabs).
- **Option D (rejected): serialize every authentication operation through the controller's
  queue.** A slow login would block retry and logout, hurting safety and retryability. What is
  needed is not ordering but "never apply a stale answer", which compare-and-set gives.
- **Option E (rejected): use the Web Locks API for atomic `localStorage` updates.** Cross-tab
  compare-and-set is impossible in principle with storage alone, but the guarantee we want is
  "no tab keeps using the previous owner as active", and suspension on the storage event gives
  that. Browser support would also need checking. What is and is not guaranteed is written down
  in design body §4.6.
- **Option F (rejected): hold the Rust `Mutex` across `.await` to serialize.** Tauri commands
  run concurrently; holding the lock across awaits would also serialize `current_session`'s DB
  re-validation. The "compare and write under one lock" shape from PR #182 suffices and matches
  the three existing sites.
- **Option G (rejected): add `GET /api/auth/session` (check + identity in one response) to
  REST.** The existing `GET /api/auth/identity` already goes through `authenticated_session` →
  `AuthState::authenticate`, the same re-validation as `require_auth`, and reports revocation as
  `200 null`, so it already satisfies the one-round-trip requirement. A new route is decided only
  when a concrete requirement the existing one cannot meet appears.
- **Option H (rejected): have the app `adopt()` the synthetic identity of Tauri's
  login-not-required mode.** Rust synthesizes it and `auth_identity` re-reads the mode and role
  on every call; synthesizing it in the front end would miss role changes and add a writer.
- **Option I (rejected): return the current generation from a `load` that received
  `superseded`.** An unverified result would pass the generation gate and the previous user's
  page data would ride on the new generation. Instead, join the latest verification and return
  only a confirmed generation, within a deadline.
- **Option J (rejected): keep an `end()` after logout, with a comparison.** Another session can
  be confirmed between the provider finishing `logout()` and the caller's continuation resuming.
  The TS `logout` returns `Promise<void>`, and even a boolean cannot express "cleared, but a
  different login was confirmed afterwards". Unifying on provider notification → suspension →
  `resolve()` removes one entry point instead.
- **Option K (rejected): advance Rust's `seq` on every write to `state.auth`.** `settle_session`
  writes a refresh every time it reads a valid session, so `auth_resolve` itself would change the
  revision and the controller would keep discarding correct answers. Advance it only on
  operations that intend to change the binding.
- **Option L (rejected): allow a middle tier of providers with a revision but no
  notification.** In that tier, "discard the stale answer on revision mismatch → the re-issued
  probe rejects" leaves the previous owner active although the change was detected. Two tiers
  only: standard with all three, compatibility adapter with none.
- **Option M (rejected): use the probe's `AbortSignal` as a correctness mechanism (skip the
  comparison on the assumption that an aborted probe never answers).** Tauri's `invoke` cannot
  be interrupted, and a `fetch` can be aborted after its response has arrived. The discard
  decision stays independent of abort; abort only frees resources.

## Consequences

- Three implementation PRs (provider + backend / controller / admin-template wiring and
  v2.0.0), then one migration PR in banto-industrial that both migrates the two apps and moves
  their references to the final tag, after verifying on a candidate commit.
- Derived apps read `controller.snapshot` whole instead of assembling "check -> identity ->
  generation -> state"; role is derived from the identity.
- Any new verification path is demoted to `controller.signal()`. No new code outside the
  controller calls `check()` / `getIdentity()` and writes state (a review checkpoint).
- On the Rust side, every write to `state.auth` goes through `cas_session` (binding-changing
  operations) or `refresh_same_binding` (same-binding updates), including in new commands.
  State-changing commands include `seq` in their response.
- Reviews look for three shapes: "write unconditionally after an `await`", "decide from a
  boolean return value alone", and "compare and apply in different continuations" (design body
  §4.9 table).
- What is not guaranteed is documented: which of two simultaneous tabs wins, and requests sent
  in the milliseconds before the credential-change event is delivered.
- The compatibility behavior of collapsing failures into `null` is not kept as the standard of
  the new shared code.
- A derived app that uses the compatibility adapter does so knowing what it does not guarantee
  (not one round trip, `check()` side effects, no cross-tab detection) and says so in its
  migration PR. A hand-written provider fails to type-check under v2.
- Handling a user switch in another tab never clears the shared token, in any app. A logout
  happens only through the user's own action or a backend revocation.
- Stopping the "unheard" re-probe changes the expectations of the `sessionEndUnheard` tests
  (`onSessionEnded` notifies once, asynchronously, when the snapshot is already `none` at
  subscription time). It goes into the CHANGELOG's behaviour-compatibility section.
- The generation increments come from the §3.1 table (derived mechanically from the rule);
  scenario expectations and tests are read off it. Changing the rule means changing the table and
  the scenarios in the same PR.
