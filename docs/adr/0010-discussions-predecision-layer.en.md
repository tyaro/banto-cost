# ADR-0010: Make GitHub Discussions a pre-decision deliberation-only layer

> The Japanese [`0010-discussions-predecision-layer.md`](0010-discussions-predecision-layer.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-08-25
- Related: [ADR-0006](0006-docs-in-repo-projects-status-only.en.md),
  Discussion #173, [conventions.md §12](../conventions.en.md),
  [roadmap.md §3, §7](../roadmap.md)

## Context

GitHub Discussions is being introduced as a venue for design deliberation.
[ADR-0006](0006-docs-in-repo-projects-status-only.en.md) decided
that "knowledge lives in-repo; Projects is confined to ephemeral status,"
leaving undefined where a third genre — "undecided deliberation" — should
live. The reasons ADR-0006 rejected the Wiki (it fails PR review, is not
greppable, is not commit-pinned, and cannot be read by an AI delegation
session) apply almost as-is to Discussions, so without deciding a scope and
a feedback discipline this would contradict ADR-0006.

## Decision

**Discussions is for "raw, pre-implementation deliberation and ideation
only."**

Feedback discipline:

- (a) Decisions, their rationale, and rejected alternatives must always be
  fed back via PR into an ADR / roadmap §3 / template-scope.
- (b) A settled Discussion is closed after prepending
  "→ Resolved: ADR-NNNN / PR #N" at its top.
- (c) Discussion URLs are not used as the canonical reference in code or
  docs body text (provenance notes only — already added to conventions
  §12's reference-syntax table).
- (d) Keep the role split of ADR = norm / Discussion = provenance log (the
  same reasoning ADR-0006 applied to Projects: "drift cannot occur in
  principle because the roles are separated").

Start with two categories, Design (open-ended) and Q&A (answerable), and
classify by repository label rather than title prefix. Add categories only
once external participants start posting (the same discipline as
ADR-0006's trigger for standing up Projects). The flow has three exits — an
ADR, the roadmap §3 backlog, or template-scope out-of-scope — and an Issue
is cut only right before work starts (the culture of zero open issues/PRs
at rest).

## Alternatives considered

- **Option A (adopted)**: as above.
- **Option B (rejected)**: five categories (Architecture/Ideas/UI-UX/
  Development/Q&A) plus title prefixes like `[Architecture]` `[GPUI]`. With
  one participant plus AI, classification routes to no one and empty
  categories pile up. Even the first topic straddles Architecture and
  UI/UX, breaking the boundary. Prefixes duplicate the label feature,
  don't work with `label:` search, and turn any reclassification into
  editing every title by hand.
- **Option C (rejected)**: skip Discussions and deliberate only in
  `docs/*-plan.md` and review documents. Every raw idea that lands in docs
  becomes inventory debt (maintenance-review-2026-08 measured 46 dangling
  references in practice). It also has no entry point for external
  participants.
- **Option D (rejected)**: also use Discussions as a place to store
  knowledge. The reasons ADR-0006 rejected the Wiki apply as-is (not
  version-controlled, not greppable, unreadable by a delegated AI).

## Consequences

- Knowledge from settled discussions stays in-repo at all times (ADR-0006's
  consequence is upheld into the Discussions era too).
- **Retreat condition for the practice itself**: if external participation
  stays at zero for 12 months, close Discussions and revert to the
  traditional dated-review-document style.
- The Discussion this ADR settles (see the Related line) is itself the
  first application of this discipline (fed back into this ADR plus
  ADR-0009 and the roadmap/template-scope additions, then closed with a
  resolution link).
