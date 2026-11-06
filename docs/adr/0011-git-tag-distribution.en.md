# ADR-0011: Distribute via git tag references and defer npm/crates.io registry publishing

> The Japanese [`0011-git-tag-distribution.md`](0011-git-tag-distribution.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-08-26
- Related: [publishing.md](../publishing.md), [ADR-0002](0002-minimal-dependencies.en.md),
  [ADR-0007](0007-derived-app-dev-optimizer-exclude.en.md),
  [template-scope.md §3.1](../template-scope.md),
  [history/industrial-plan.md §2](../history/industrial-plan.md)

## Context

The distribution method was already decided in publishing.md
(2026-07-12, M18 Phase C): "both npm and Rust go through git tag
references + `path:` dependencies." On 2026-07-13 a separate repository
(banto-industrial) actually consumed this repository's `v0.1.1`, and it
was verified that `pnpm install` / `cargo check` /
`cargo test --workspace` all pass.

At the same time, the reasoning behind the original non-publish decision
had drifted. publishing.md cited "the policy of private distribution and
reserved rights (industrial-plan.md §2)" as the reason for not
publishing to crates.io, but industrial-plan.md §2 had already been
revised on 2026-07-12 to "make banto public + MIT, and consolidate the
defensive line on the private banto-industrial side instead" — the
reason for treating banto itself as privately distributed with reserved
rights had **lapsed at the same time**. In other words,
industrial-plan.md's current policy that "banto works better published"
and the non-publish reasoning quoted by publishing.md remained in
contradiction.

This ADR resolves that contradiction and records, formally, that the
decision not to publish to a registry is still supported today — by
different, currently valid reasons (consumer count, scope constraints,
maintenance cost).

## Decision

Do not publish to the npm or crates.io registries. Make **git tag
references** (a git URL + `path:` for npm; `git` + `tag` + package
selection for cargo) the official distribution channel. The template's
primary distribution route remains GitHub's "Use this template"
(copy-type); this decision does not change that.

## Alternatives considered

- **Option A (adopted): git tag dependencies.** The only consumer today
  is banto-industrial (one case), so there is zero maintenance cost for
  a release pipeline or publish procedure. It sidesteps the practical
  problem that the `@banto` npm scope is unobtainable because the GitHub
  organization `banto` is already taken (see
  history/publishing-github-packages-2026-07.md). It is also consistent
  with the source-distribution policy
  ([ADR-0007](0007-derived-app-dev-optimizer-exclude.en.md)).
- **Option B (rejected): publish formally to npm + crates.io.** The
  benefit would be discoverability and semver range resolution, but the
  former requires a prior, still-undecided call on whether acquiring
  external adopters becomes an active goal, and the latter has no real
  need yet (no multiple consumers). It would also force a scope rename
  (e.g. to `@tyaro/*`) whose blast radius covers every import in
  `admin-template` (see the history doc's "`@banto` scope and GitHub
  Packages constraints" section).
- **Option C (rejected, already verified): GitHub Packages.** Verified
  through implementation in 2026-07 and then shelved. It requires
  mandatory `.npmrc` + `GITHUB_TOKEN` (`read:packages`) auth setup on
  the consumer side — high friction relative to git dependencies for
  little gain (history in
  history/publishing-github-packages-2026-07.md).
- **Option D (rejected): a giget/degit-style template-fetch tool.** The
  primary copy-type route (GitHub "Use this template" + `rename.mjs`)
  already has low friction; adding a fetch tool adds no value.

## Consequences

- publishing.md's crates.io non-publish reasoning drops the "private
  distribution / reserved rights" citation and instead references this
  ADR (done in this PR). The GitHub Packages shelving section's
  re-examination conditions are also folded into this ADR.
- **Re-examination conditions** (revisit if any one is met):
  1. External consumers grow to multiple cases and semver range
     resolution actually becomes necessary.
  2. A decision is made to treat "acquiring external adopters" as an
     active goal, making registry discoverability necessary.
  3. A decision is made to accept a `@banto`-equivalent scope rename
     (e.g. `@tyaro/*`).

  GitHub Packages' shelving conditions (formerly in publishing.md) are
  folded into these three; going forward, only this ADR's
  re-examination conditions apply.

- This ADR is also subject to the general rule (added in this PR) in
  [roadmap.md §3](../roadmap.md) of a "12-month time limit on triggers
  whose only firing source is external adopters." The re-examination
  conditions above are evaluated under that same time limit.
