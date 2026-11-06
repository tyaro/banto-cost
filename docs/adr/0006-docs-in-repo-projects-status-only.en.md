# ADR-0006: Consolidate knowledge docs in-repo and confine GitHub Projects to ephemeral status only

> The Japanese [`0006-docs-in-repo-projects-status-only.md`](0006-docs-in-repo-projects-status-only.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-07-30
- Related: [conventions.md §12](../conventions.en.md) (the `spec §` reference culture),
  [AGENTS.md](../../AGENTS.en.md) (single source of navigation),
  [template-scope.md §3.1](../template-scope.md) (how extensions ship),
  [roadmap.md §3](../roadmap.md) (the v2 backlog),
  [ADR-0002](0002-minimal-dependencies.en.md) (the general rule of minimizing total maintenance cost)

## Context

As the template grew from M10 through M24 and its assets accumulated, we
considered whether to adopt GitHub **Projects (work boards) / Wiki**. The
current practice is:

- Documentation is **consolidated in-repo** (CLAUDE.md's opening line, "unified
  to avoid drift"; AGENTS.md is the single source of navigation). The "why" is
  split three ways (code comments / conventions.md / ADR) and **the same reason
  is never written in two places**.
- **Code references the docs heavily.** References of the form `spec §N` /
  `spec M14` / `docs/*-plan.md §` number **794 occurrences across 205 files**
  (measured 2026-07-30, `rg 'spec (§|M)\d|docs/[a-z-]+\.md'`) — this is exactly
  the conventions §12 culture of "cite the spec section at the top of each
  module." References are anchored by **file + symbol name + spec section**,
  not line numbers (conventions preamble).
- Part of conventions.md is **machine-checked** by `verify:architecture` (CI),
  and legitimate exceptions are managed as a **pair** of an in-code comment and
  a script allowlist entry.
- Planning lives in roadmap.md / template-scope.md / `*-plan.md`, and decisions
  live in ADRs. Issues/PRs are **not left lingering** — they are merged and
  closed as milestone PRs (open issues/PRs = 0 as of 2026-07-30).

Two questions were raised: (1) from an AI's viewpoint, which is better,
"docs only" or "using Projects"; and (2) what is better for human-AI
collaboration. A further proposal — "consolidate everything except the README
into Projects" — was also put on the table. What needs deciding is **which
medium holds Banto's knowledge**, and because that becomes a cross-cutting
operating rule, it is recorded as an ADR.

## Decision

**Knowledge (invariants, spec, scope judgments, design decisions,
implementation plans, recipes) continues to be consolidated in the in-repo
`docs/`. GitHub Wiki is not adopted.**

**GitHub Projects, if adopted at all, is confined to an "ephemeral execution
status / coordination" layer** — roadmap milestone status tracking, future task
management, and the like. **Knowledge is not moved into Projects.** The dividing
line is not "README vs docs" but the one running _through_ the docs:
**durable knowledge (in-repo) vs mutable status (Projects allowed).**

The adoption trigger (the condition to stand Projects up as a status layer) is
when the v2 backlog (roadmap §3) **enters a concurrent-execution phase**, when
**external adopters start filing issues**, or when cross-cutting work coupled
with banto-industrial arises. Until then, docs alone suffice.

## Alternatives considered

- **Option A (adopted): knowledge in in-repo docs, Projects an optional
  status-only layer.** Pros: preserves the 794 references, machine checks, PR
  atomicity (a rule change is reviewed in the same diff as the code), and
  version-coupling (the docs at a commit describe that commit's invariants).
  The AI can always read the in-repo docs with **zero API and commit
  consistency**. Only status — the area docs are bad at — is offloaded to a
  board with structured fields. Cons: two media, one for knowledge and one for
  status — but their roles are separated and no fact is held in both, so drift
  is impossible by construction.
- **Option B (rejected): put docs in the Wiki.** The Wiki is a **separate git
  repository**, not versioned with the code, not passing through PR review, and
  not co-located with code. The 794 `spec §N` references would degrade into
  external links that cannot be grepped and are not commit-pinned, breaking
  conventions §12 and the "code is the primary source" practice. The existing
  `docs/` — versioned, PR-reviewed, co-located, cross-referenced — is a
  **strict superset of a Wiki**, so a Wiki adds nothing.
- **Option C (rejected): consolidate everything but the README into Projects.**
  It inherits every drawback of Option B and is worse. Projects can hold text
  in draft issues, but cross-linking is weak and it cannot express the ADR
  genre of "numbered, immutable, append-only." It breaks the 794 references,
  version-coupling, and PR atomicity, and the AI would have to hit a (possibly
  down) API every time it reads an invariant. Moreover, Projects' strength —
  **filterable structured fields (status/priority/assignee)** — is meaningless
  for timeless knowledge, so this uses the board as a **mere text bucket** while
  inheriting only its weaknesses. That a status table (roadmap milestone state)
  fits Projects is correct, but that applies to the **status portion within**
  the docs, not the docs as a whole.

## Consequences

- **An obligation to preserve the conventions §12 reference culture and machine
  checks.** Code keeps anchoring `spec §` / `docs/*-plan.md §` into the in-repo
  docs. Knowledge docs are not taken outside the repository.
- **Lane discipline if Projects is adopted**: the board holds "status + the
  discussion scoped to that task" only. **Any reasoning that generalizes beyond
  one task graduates from the issue into an ADR / conventions edit via a PR.**
  No durable knowledge is left existing only in an issue/board (upholding, in
  board operation, the reasons Options B/C were rejected).
- **AI consumption**: knowledge is in-repo, so it is always at hand with **zero
  API and commit consistency** (reading an invariant does not depend on an
  external service's availability). Status is inherently live, so going through
  an API is fine — the medium matches the role.
- **Human-AI collaboration**: once Projects is stood up, it becomes the
  **shared coordination surface** for humans and AI (status, ownership,
  handoff), while the docs remain **the single source of truth both read**. The
  delegation model (roadmap §7: lead → task split → delegation) maps naturally
  onto issues.
- **Re-examination conditions**: once the "adoption trigger" above is met, this
  ADR does not prevent standing Projects up as a status layer (that is within
  this ADR's intent, not a reversal). Conversely, deciding to move knowledge
  into Projects/Wiki requires a new ADR that supersedes this one.
