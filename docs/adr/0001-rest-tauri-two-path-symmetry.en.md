# ADR-0001: Make REST and Tauri two peer paths and route a single service layer symmetrically through both

> The Japanese [`0001-rest-tauri-two-path-symmetry.md`](0001-rest-tauri-two-path-symmetry.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-07-19 (the decision itself was established at M6/M10/M14; recorded retroactively)
- Related: [conventions.md §1・§2](../conventions.en.md), spec §11,
  `apps/admin-template/core/src/rest/mod.rs`, `src-tauri/src/lib.rs`

## Context

Banto provides the same admin UI in two forms: (1) a Tauri desktop app
(the webview calls local Rust via `invoke()`), and (2) a browser on another
device on the same LAN (REST + SSE to an embedded axum server). Both forms
must provide the same CRUD, authorization, and audit. This "the front end →
service layer → DB runs straight through" is exactly the value of the template
(spec §2.1), and how to make the two forms coexist became a foundational
decision.

## Decision

**Route every mutating operation through a single transport-independent
service layer (`ItemsService`, etc.). Attach authorization and audit
symmetrically on both the REST path (`RoleGuard` + `record_write` in
`rest/mod.rs`) and the Tauri path (`require_role` + `audit.record` in
`lib.rs`), varying only `origin` (`"rest"`/`"tauri"`).** The service layer
knows nothing of axum/tauri/RBAC/HTTP (the invariant of conventions §1・§2).

## Alternatives considered

- **Option A (adopted): single service layer + symmetric wiring on both paths.**
  Keep the service as a pure domain layer returning `Result<_, BantoError>`,
  with the thin wiring of each path attaching authorization and audit. Pros:
  zero logic duplication; the service can be tested directly against a
  `:memory:` pool. Cons: each new mutating operation incurs the obligation to
  write both paths plus the denied tests for both paths as a pair.
- **Option B (rejected): support only Tauri and drop the LAN form.**
  Minimal to implement, but it loses Banto's core value of "usable from
  another device on the same LAN" (spec §11). Rejected because the template's
  differentiator disappears.
- **Option C (rejected): independent handlers per path, each with its own
  logic.** Fast out of the gate, but the authorization, audit, and validation
  of REST and Tauri drift apart over time, producing the class of
  inconsistency where "it passes on the LAN but is rejected on Tauri."
  Preventing exactly this is the purpose of this ADR, so it is rejected.

## Consequences

- A new mutating command (create/update/delete/import/…) **cannot be added to
  only one path**. Both paths plus the denied for both paths must always be
  implemented and tested as a pair (conventions §1, the checklist steps 3–6 of
  recipes/add-resource.en.md).
- Bringing `use axum` / `use tauri` into the service layer would break the
  symmetry, so it is prohibited and mechanically checked by the
  `service-layer` rule of `pnpm verify:architecture` (conventions §2
  [mechanically checked]).
- The decision that read operations (list/get) are audited on neither path is
  also kept aligned on both sides.
- The maintenance cost of upholding this symmetry (the duplicated tests) is
  accepted in exchange for the permanent consistency of the two forms.
