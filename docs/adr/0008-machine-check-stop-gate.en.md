# ADR-0008: Gate new machine checks on a three-condition test, to stop unbounded growth

> The Japanese [`0008-machine-check-stop-gate.md`](0008-machine-check-stop-gate.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-08-15
- Related: [conventions.md §6](../conventions.md) (security) / [§11](../conventions.md) (migration dialects),
  [maintainability-review-2026-07.md §4.1](../reviews/maintainability-review-2026-07.md) (the stop decision, CR-3–5),
  [maintenance-review-2026-08.md](../reviews/maintenance-review-2026-08.md) Phase 4 (the 9 candidates),
  `scripts/verify-architecture.mjs` (where checks live), [ADR-0002](0002-minimal-dependencies.md) (minimize total maintenance cost)

## Context

Banto has a culture of "turning prose conventions into failing CI checks"
(`verify-architecture.mjs` rules 1–14). That culture has a natural growth
pressure: every review produces new "could this be machine-checked too?"
candidates.

A machine check has not just an implementation cost but a **continuation cost**:
it can false-positive / constrains future refactors / needs maintenance / a new
maintainer (human or AI) must understand it. Add too many and **the guardrail
itself becomes a maintenance burden, and a green pass creates false confidence
that "everything is covered."**

maintainability-review-2026-07 §4.1 resolved this tension by deciding "machine
checks stop here," backed by three conditions it held only as folklore. But the
2026-08 maintenance review's Phase 4 produced **9 new candidate checks**, which,
if adopted unconditionally, collide head-on with that stop stance. With the
criterion left as folklore, the next agent/review would re-litigate it or add
checks without a basis. **The criterion must be promoted into a durable ADR.**

## Decision

**Whether to add a new machine check is decided by whether it satisfies ALL
THREE of the following conditions simultaneously (the three-condition gate).
If even one fails, do not machine it.**

1. **It is a backbone** — breaking it is serious (a core invariant: build,
   runtime, or an authz/security guarantee gives way).
2. **It breaks silently** — review and build will not catch it (the load-bearing
   condition; something that breaks in a visible diff has low machining value).
3. **An AI can break it unknowingly** — an agent easily trips over it.

Additionally, **do not adopt a check that is false-positive-prone** (where a grep
cannot make the legitimate/illegitimate call) — a check needing a large allowlist
becomes a formality, and is rejected even if it meets the three conditions.

This ADR is both the criterion and the **ledger of accept/reject decisions** (see
"Selection of the 9 candidates" below). Future candidates are appended here one
at a time with their verdict and rationale (no backfill). Checks themselves live
in `scripts/verify-architecture.mjs` and the rule prose in the relevant
`conventions.md` section; this ADR does not duplicate them.

## Alternatives considered

- **Option A (adopted) — the three-condition gate.** Machine only what satisfies
  backbone + silent + AI-breakable. Pro: only checks worth their continuation
  cost survive, and green keeps its meaning. Con: some "nice to have" checks
  (heading parity, etc.) are deliberately skipped, lowering the sense of coverage
  (which is the intended trade to avoid FALSE coverage).
- **Option B (rejected) — machine everything that can be machined.** Rejected
  because continuation cost (false positives, refactor constraints, maintenance,
  cognitive load) grows linearly, and **shallow proxy checks** (heading counts
  matching while the content has drifted) guarantee nothing while passing green —
  precisely the **false confidence** this culture names as an anti-goal.
- **Option C (rejected) — add no more machine checks at all.** Rejected because
  the 9 candidates included **two genuinely-silent backbones** (a missing
  migration on one dialect is invisible because Postgres CI is smoke-only; CSP
  drift between the two definitions is invisible because there is no cross-check
  test and src-tauri does not compile). A blanket freeze misses those two real
  losses. "Stop" means "select by a criterion," not "stop thinking."

## Selection of the 9 candidates (first application of this ADR, 2026-08)

Applying the three-condition gate to maintenance-review-2026-08 Phase 4's 9
candidates. **Only two are adopted.**

| #   | Candidate                                                        | Verdict            | Reason (which condition decided it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Migration-dialect filename parity**                            | ✅ Adopt (rule 11) | Meets all three. Postgres CI is smoke-only and each `sqlx::migrate!` embeds its dir independently → a one-dialect add goes **genuinely silent**. ~12 lines, zero false-positive surface, no allowlist → near-zero continuation cost                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | **CSP two-definition directive match**                           | ✅ Adopt (rule 12) | §6 security invariant. No cross-check test + src-tauri does not compile = **strongly silent**. Compares both formats except the connect-src IPC delta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | Code→docs `spec §N` reference resolution                         | ⏸ Defer            | §12 was already rated "low AI-break risk, small machining room." This round's 63 dangling refs were a one-time archival/rename **event** (visible diffs), not steady-state drift. Weak backbone (condition 1). If revived, only the narrow slice (`spec §N` / `roadmap MN` / `ADR-000N`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 4   | §3 dependency-addition detection (CR-3)                          | ⏸ Keep deferring   | A dependency add is the **most-reviewed manifest diff** = does not break silently (fails condition 2). Keeps §4.1's "lightweight version when a real need appears." Measured: deps have not grown from baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5   | denied resource-tag cross-check (extend rule 8)                  | ❌ Reject          | Audit-label hygiene, not a backbone (condition 1). §1 already states audit-record identity is guaranteed by code + tests, **outside** machine-checking. H-4 is fixed + pinned by tests. Split-guard routers also raise the false-positive surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | toComparable mirror match                                        | ❌ Reject          | The real invariant is **three-way** (2× TS + Rust `list_query`). Checking only TS passes green while missing Rust-side drift = **false confidence**. The "Must stay in sync" comments + NULLS LAST behavior are the guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 7   | raw-jp extended to .ts                                           | ❌ Reject          | Most Japanese in app `.ts` is legitimate demo data. A large file-level allowlist would be needed, which itself hides real regressions inside those files (formality via false positives)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8   | raw-colors extended to the app layer                             | ❌ Reject          | §9 scopes rule 5 to `packages/` **by explicit design**. All 19 app-layer raw colors are §9's named legitimate cases (login brand surface, static theme-preview swatches). Needs a brittle per-value allowlist (later note: the theme-preview swatches were removed with the colour-mode cards in #458; the current cases are the login brand surface and the white backing of the settings QR code)                                                                                                                                                                                                                                                                                                                                                      |
| 9   | ja/en heading parity                                             | ❌ Reject          | English is a secondary translation = tidiness, not a backbone. Heading-count parity is a **shallow proxy** (green while content drifts) → false confidence, and false-positives on legitimate translation restructuring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 10  | **Bare imports: `svelte` only**                                  | ✅ Adopt (rule 2b) | Meets all 3 conditions (ADR-0018 §5, #220). Packages cannot declare deps (`empty-deps`), so hoisting hides violations in the monorepo and they break only derived apps = **truly silent**. Zero violations, no allowlist. Comments stripped; self-checks a sample violation on every run                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 11  | **External-consumer fixture version ranges match**               | ✅ Adopt (rule 13) | Meets all 3 conditions. Checks that the range strings for svelte / @sveltejs/kit / vite / svelte-check etc. in `fixtures/external-consumer/package.json` are string-identical to admin-template's. Dependabot does not follow the fixture, so it **drifts silently** (happened twice: #404, #406). An AI can bump only admin-template and miss it. Ranges are compared as raw strings, no normalisation = narrow false-positive surface                                                                                                                                                                                                                                                                                                                  |
| 12  | **scaffold edit targets are covered by the acceptance-CI paths** | ✅ Adopt (rule 14) | Meets all 3 conditions. The files scaffold edits by literal anchors are obtained from scaffold itself (`--dry-run` over every preset) and must match a glob in both the push and pull_request `paths` of `template-acceptance.yml`. Scaffold is a **backbone** (how derived apps are made). `paths` is hand-written, and a missing entry means anchor breakage skips the acceptance CI and **breaks silently** (twice: #122, 8730373; the `vite.config.ts` and `core/Cargo.toml` gaps were found by measurement). An AI adding an anchored file can **break it unknowingly**, never noticing `paths`. The list comes from scaffold, never hand-written / globs are only `**` and `*` / removal-only targets are excluded = narrow false-positive surface |

## Consequences

- **Every future candidate is run through the three-condition gate BEFORE
  implementation, and its verdict + rationale is appended as a row to this ADR's
  table** (no backfill = one at a time when next touched).
- **A "defer" is overturned only when actual _steady-state_ drift is observed** —
  a one-time bulk-rename event (like candidate 3's 63 refs) is not grounds to
  overturn.
- Adopted checks retain room for intentional exceptions via a **reason-carrying
  allowlist** (same idiom as existing rules). rules 11/12 currently need none —
  their false-positive surface is that narrow.
- Do not read machine-check coverage as "green = everything is protected." This
  ADR's table is the source of truth for "what the machine sees vs. what review
  and tests see."
- Obligation to state each check's limits: rule 11 covers filename/sequence
  parity only (type differences within a same-named pair are §11's intended
  divergence, review-guaranteed). rule 12 depends on extracting the Rust const
  string (reformatting the const to a single line, a raw string, or `concat!`
  breaks extraction → but then it fails with "update the check," so it does not
  break silently).
