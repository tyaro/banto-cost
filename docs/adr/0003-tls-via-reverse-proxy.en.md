# ADR-0003: Officially support LAN TLS via reverse-proxy termination and defer built-in TLS

> The Japanese [`0003-tls-via-reverse-proxy.md`](0003-tls-via-reverse-proxy.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-07-19
- Related: [conventions.md §3](../conventions.en.md), [ADR-0002](0002-minimal-dependencies.en.md),
  spec §11.2, improvements.md §2.3, improvement-plan-2026-07.md P1-4/B,
  README "LAN access" (the procedure itself lives in
  [docs/recipes/lan-access.md](../recipes/lan-access.md) since 2026-10-08)

## Context

In v1, the embedded web server (`banto-server`) makes the pragmatic trade-off
of **plaintext HTTP + token authentication**, so login information and session
tokens flow across the LAN unencrypted (spec §11.2). Operation outside a
trusted LAN, or use spanning multiple sites, requires TLS. How to provide TLS
became a foundational decision that carries a trade-off between dependency
minimization (ADR-0002) and security.

## Decision

**Do not build TLS into Banto itself; make termination at a reverse proxy
(Caddy, etc.) the officially supported path.** Banto itself stays on HTTP,
bound narrowly to `127.0.0.1`, and a front-facing proxy terminates TLS. The
README already documents a Caddy configuration example and a caveat that
per-IP rate limiting degrades when going through a proxy (P1-4). Built-in TLS
(opt-in rustls) is **deferred**, to be judged again once the re-examination
conditions below are met.

## Alternatives considered

- **Option A (adopted): reverse-proxy termination.** Pros: zero new
  dependencies (consistent with ADR-0002); delegates the complexity of TLS
  configuration, certificate renewal, OCSP, etc. to a proven proxy; automatic
  HTTPS (Let's Encrypt / internal CA) takes only a few lines of Caddy. Cons:
  the operator must run one more process, which is not zero-config for desktop
  users.
- **Option B (deferred): opt-in built-in rustls + automatic self-signed
  certificate generation (rcgen, etc.).** Pros: zero-config, friendly to the
  desktop. Cons: (1) a **heavy dependency addition** of rustls + certificate
  generation (a restraint target of ADR-0002; binary bloat, expanded audit
  surface); (2) self-signed certificates trigger warnings in every browser,
  saddling Banto with the **trust-UX problem** of users manually installing a
  CA; (3) added maintenance surface of a TLS configuration UI and certificate
  rotation. Against the appeal of zero-config the cost is large, and since
  Option A already satisfies production TLS, it is passed over for now.
- **Option C (rejected): plaintext only, with no TLS path provided.** Does not
  work outside a fully trusted LAN and leaves real operators no escape hatch.
  Rejected as irresponsible (Option A provides the escape hatch).

## Consequences

- The README "LAN access" (now [recipes/lan-access.md](../recipes/lan-access.md))
  carries reverse-proxy TLS via Caddy as a procedure.
  It presupposes narrowing the bind to `127.0.0.1` (with `0.0.0.0`, plaintext
  HTTP that bypasses the proxy would also be reachable).
- If built-in TLS is implemented, it should be a separate milestone, done in an
  environment where you can build Tauri and field-verify the TLS handshake
  (in this template's sandbox, src-tauri cannot be compiled, so it would ship
  unverified).
- **Re-examination conditions**: when there is strong demand for "zero-config
  desktop TLS" and agreement is reached that Banto will take on the trust UX of
  self-signed certificates (CA distribution or an internal-CA premise). At that
  point, feature-gate rustls so that the minimal build keeps zero dependencies
  (the general rule of ADR-0002).
- The pragmatic trade-off in spec §11.2 that "v1 is plaintext HTTP" is now
  ratified by this ADR.
