# ADR-0002: Add no dependencies and make in-house implementation the default (minimize total maintenance cost)

> The Japanese [`0002-minimal-dependencies.md`](0002-minimal-dependencies.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-07-19 (the decision itself was established through practice from M0 onward; recorded retroactively)
- Related: [conventions.md §3](../conventions.en.md),
  improvement-plan-2026-07.md P1-5

## Context

Banto is **a template you copy and use**, and every dependency becomes
something the user inherits, audits, and updates. What you put into (or keep
out of) the workspace directly affects binary size, the audit surface, and the
user's update burden — a foundational policy that requires a judgment every
time a feature is added.

## Decision

**Do not add "a dependency you were tempted to pull in" by default; substitute
an in-house implementation.** Representative examples currently kept out and
their substitutes (the table in conventions §3): `chrono`/`time` → hand-written
date conversion, MIME-detection library → magic-byte detection, `multipart` →
raw-byte body + `?fileName=`, `tower-http` → hand-written middleware, markdown
library → an in-house parser + escaping, `tracing` → `eprintln!`.

The goal, however, is not "zero dependencies" but **minimizing total
maintenance cost**; adoption is judged by the P1-5 criteria (the in-house
implementation would bloat / it touches a security boundary / it is a domain
with many edge cases such as Unicode, date-time, crypto, parsers / the crate is
sufficiently mature / it can be scoped to a single feature / the binary
increase has been measured — several of these applying together).

## Alternatives considered

- **Option A (adopted): in-house implementation by default, dependency
  adoption as a criteria-gated exception.** Pros: keeps binary bloat, audit
  surface, and the user's update burden down / lets you grasp the whole
  codebase. Cons: the maintenance burden of carrying edge-case-heavy areas
  (dates, MIME, parsers) in-house and chasing security fixes yourself.
- **Option B (rejected): just pull crates when needed (the common approach).**
  Fast to implement, but every template user then inherits and audits that
  dependency tree, which does not fit the "copy and use" premise. Rejected
  because it would normalize the dependency tree swelling for the sake of a
  small utility.
- **Option C (considered but rejected, a generalization): ban dependencies
  uniformly.** Too rigid. Banning even areas where an in-house implementation
  is actually higher-risk and higher-cost — such as Unicode normalization or
  crypto — raises total maintenance cost. Hence, not a "uniform ban" but a
  "criteria-gated restraint" (Option A).

## Consequences

- Whenever you are tempted to pull any of the entries in the table above, that
  is a design decision and **subject to discussion**. Weigh it against the P1-5
  criteria, and if you adopt it, record the reason (conventions §3).
- We do not preemptively replace existing in-house implementations. Each is
  re-evaluated individually only when it actually starts to meet the criteria
  (bloat, spec expansion, vulnerability-tracking becoming heavy, etc.).
- Not putting `husky`/`lint-staged` into the pre-commit hook and using plain
  POSIX sh instead (README "pre-commit hook") is also a concrete application of
  this ADR.
