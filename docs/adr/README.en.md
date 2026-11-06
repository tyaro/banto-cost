# Architecture Decision Records (ADR)

> The Japanese [`README.md`](README.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

Created: 2026-07-19 (improvement-plan-2026-07.md P4-7)

This directory records Banto's **foundational design decisions**, including the
comparison of alternatives. It is a Track A (maintainer-facing) asset; if you
hard-fork, you may delete all of `docs/` ("everything is deletable" policy).

## Why ADRs — the three categories of documentation

Banto's "why we write it this way" is split by role across three places. **Do
not write the same "why" in two places** (to avoid the sync cost on changes).

| Place                                      | What to write                                                                                                                 | Example                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Code comments**                          | Local reasons that only make sense at that spot, on that line                                                                 | "revoke the object URL in `finally`" / "wrap this effect in untrack"                                        |
| **[conventions.md](../conventions.en.md)** | Cross-project **invariants** (rules that break things if not upheld)                                                          | "both paths symmetric" / "the service layer knows nothing of axum/tauri" / "raw color values are forbidden" |
| **ADR (this directory)**                   | **Design decisions where alternatives were compared and one was chosen** (the still-valid "why Z, and why X/Y were rejected") | "why two paths" / "why dependency minimization"                                                             |

Whereas conventions.md is the "**rules** (what to uphold)," the ADR records the
"**decisions** (why that rule was chosen, and why the other options were
discarded)." The decision behind each invariant in conventions.md can, if a
corresponding ADR exists, be traced from there.

## Operation

- **Do not backfill in bulk.** Turning an existing decision into an ADR is
  raised one at a time, at the moment you next touch that decision (revisit it,
  or add a related feature). The "ADR candidates" below are an unstarted
  backlog.
- When you make a new foundational decision (one with alternatives, tipped in
  one direction), write one ADR at that moment.
- File name: `NNNN-kebab-title.md` (sequential number). The format is
  [0000-template.en.md](0000-template.en.md).
- Status is `Proposed` / `Accepted` / `Superseded by ADR-NNNN` / `Deprecated`.
  - `Proposed` means under review. Once the review is done and the owner
    approves, change it to `Accepted`. Do not start implementation while it is
    `Proposed`. Review findings may be applied by editing that ADR directly.
  - After `Accepted`, it becomes `Superseded by ADR-NNNN` when overturned, or
    `Deprecated` when no longer used.
  - **Do not rewrite a past ADR once it is `Accepted`; when overturning one,
    supersede it with a new ADR** (retaining the history of decisions is the
    value of ADRs).

## Index

| #                                                      | Title                                                                                                                                                                                                    | Status                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| [0001](0001-rest-tauri-two-path-symmetry.en.md)        | Make REST and Tauri two peer paths and route a single service layer symmetrically through both                                                                                                           | Accepted                   |
| [0002](0002-minimal-dependencies.en.md)                | Add no dependencies and make in-house implementation the default (minimize total maintenance cost)                                                                                                       | Accepted                   |
| [0003](0003-tls-via-reverse-proxy.en.md)               | Officially support LAN TLS via reverse-proxy termination and defer built-in TLS                                                                                                                          | Accepted                   |
| [0004](0004-server-logging-eprintln.en.md)             | Set `eprintln!` as the default for server logging and defer `tracing`                                                                                                                                    | Accepted                   |
| [0005](0005-i18n-paraglide.en.md)                      | Adopt Paraglide JS as the UI i18n runtime (an exception to ADR-0002)                                                                                                                                     | Accepted                   |
| [0006](0006-docs-in-repo-projects-status-only.en.md)   | Consolidate knowledge docs in-repo and confine GitHub Projects to ephemeral status only                                                                                                                  | Accepted                   |
| [0007](0007-derived-app-dev-optimizer-exclude.en.md)   | Reconcile source-shipped `.svelte.ts` with derived-app dev via consumer `optimizeDeps.exclude`                                                                                                           | Accepted                   |
| [0008](0008-machine-check-stop-gate.en.md)             | Gate new machine checks on a three-condition test to stop unbounded growth                                                                                                                               | Accepted                   |
| [0009](0009-schema-ui-rest-renderer-boundary.en.md)    | Make UI declaration a schema-driven incremental extension and place additional renderers outside the boundary as REST clients                                                                            | Accepted                   |
| [0010](0010-discussions-predecision-layer.en.md)       | Make GitHub Discussions a pre-decision deliberation-only layer                                                                                                                                           | Accepted                   |
| [0011](0011-git-tag-distribution.en.md)                | Distribute via git tag references and defer npm/crates.io registry publishing                                                                                                                            | Accepted                   |
| [0012](0012-lan-public-viewer-synthetic-session.en.md) | Implement LAN viewer-public as a viewer-only synthetic session, not an auth-bypassing public router                                                                                                      | Accepted                   |
| [0013](0013-sysinfo-system-metrics-feature.en.md)      | Provide CPU/memory usage as a shared API by adopting `sysinfo` behind a feature (an exception to ADR-0002)                                                                                               | Accepted                   |
| [0014](0014-account-bound-session-revocation.en.md)    | Bind sessions to account row id + authentication epoch and revoke them by checking the database per request                                                                                              | Accepted                   |
| [0015](0015-snapshot-list-resource.en.md)              | Read lists that change without events through a separate bounded (`asOfId`) class, `SnapshotListResource`, with an injected fetcher                                                                      | Accepted                   |
| [0016](0016-session-controller-single-writer.en.md)    | Give the front end's session one writer (SessionController), make the provider answer in one round trip, and write credentials only by compare-and-set                                                   | Accepted                   |
| [0017](0017-credential-less-grant.en.md)               | Unify credential-less session issuance into "grants", with viewer-public as the first kind and a derived app's commissioning mode as the second (v3.0.0; no auth-bypass hook; `adopt()`/`end()` removed) | Accepted                   |
| [0018](0018-shared-ui-package.en.md)                   | Move general-purpose UI components into a new `@banto/ui` package in stages, and have callers inject text, icons, state and actions                                                                      | Accepted (phases 1-5 done) |
| [0019](0019-audit-spool.en.md)                         | Spool an audit entry the database cannot take to a file, and flush it exactly once by `pending_id` after recovery                                                                                        | Accepted                   |
| [0020](0020-image-assets-package.en.md)                | Keep browser-side image originals, import checks and URL lifetimes in a new optional package, `@banto/image-assets` (consumer-supplied limits, error codes, `crypto.subtle` or an in-house SHA-256)      | Accepted                   |
| [0021](0021-firewall-elevated-helper.en.md)            | For stage 2, a UAC-elevated helper adds and removes a single per-executable firewall rule                                                                                                                | Accepted                   |
| [0022](0022-settings-controls.en.md)                   | Use underline navigation and moving labels for settings controls                                                                                                                                         | Accepted                   |
| [0023](0023-shared-control-styles.en.md)               | Share the adopted control and page-navigation styles through the theme                                                                                                                                   | Accepted                   |
| [0024](0024-schema-form-appearance.en.md)              | Make schema-form underline styling opt-in and keep labels above controls                                                                                                                                 | Accepted                   |
| [0025](0025-transparent-control-backgrounds.en.md)     | Use transparent backgrounds by default for inputs and selects                                                                                                                                            | Accepted                   |
| [0026](0026-shared-boolean-controls.en.md)             | Share switch and native checkbox styling                                                                                                                                                                 | Accepted                   |
| [0027](0027-grid-error-reader.en.md)                   | Read cell errors in a local overlay and separate reading from retrying                                                                                                                                   | Accepted                   |

## ADR candidates (unstarted; do not backfill)

Raise one at a time when you next touch the decision (P4-7):

- Why make SQLite the default and defer PostgreSQL (spec §12.1 / P4-5)
- Why the Provider approach (absorbing the three environments Tauri/HTTP/InMemory) (spec §11.1)
- Why not build a runtime plugin mechanism in a "copy-type template"
  (template-scope §3.1) → already effectively recorded by ADR-0009 and
  template-scope §4.2 (added 2026-08-25). No separate ADR will be raised.
- Why we did not make resource routes dynamic but chose "a convention of copying
  items" (recipes/add-resource.en.md, spec §14 resolution)
