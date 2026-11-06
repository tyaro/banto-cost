# Recipe: Add a CRUD resource (the official procedure, using items as the model)

> The Japanese [`add-resource.md`](add-resource.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

Created: 2026-07-18 (improvement-plan-2026-07.md P1-3; a deliverable that
followed from settling the "route-derivation method" of spec §14).

Intended reader: **both app authors (Track B) and template maintainers / AI
agents (Track A)**. This is the single official procedure for when you add a new
CRUD resource (e.g., `customers`), or when you replace the bundled demo `items`
with your own resource. When delegating resource addition to an AI, use this
recipe as the instructions directly.

## The decision on method (2026-07-18)

A resource's pages are, as the official rule, **copied and rewritten from the
full set of `items` routes, not auto-derived via a dynamic route
`[resource]`** (settling the open question of spec §14). Reason: it is
consistent with the template's "everything is deletable, understandable by
copying" policy (template-scope §1), and dynamic routes would add magic that
users cannot read through.

## Checklist (in order of execution)

Proceed Rust side → frontend side. The shortest path is to copy and rewrite the
file in the "Model" column of each step.

| #   | Step                                                                                                                                                                                                                                                      | Model (the items implementation)                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Add a migration (sequentially-numbered SQL, conventions §11)                                                                                                                                                                                              | `apps/admin-template/core/migrations-sqlite/0001_items.sql` (+ the Postgres version in `migrations-postgres/`)      |
| 2   | Add the service layer (Clone + BantoError + sqlx, no tauri/axum dependence. Whitelist the sort/filter columns with `column_map()` — conventions §2, §6)                                                                                                   | `apps/admin-template/core/src/items.rs`                                                                             |
| 3   | Add the REST route (authorization/audit via `RoleGuard` + `record_write` — conventions §1)                                                                                                                                                                | `apps/admin-template/core/src/rest/items.rs` (copy it to create `rest/<yours>.rs` and register it in `rest/mod.rs`) |
| 4   | Add the Tauri command (`require_role` + `audit.record(...)` — **the same** authorization/audit as REST)                                                                                                                                                   | the `items_*` commands in `apps/admin-template/src-tauri/src/lib.rs` and `AppState.items`                           |
| 5   | **Two-path authorization symmetry tests** (success for the allowed role + a denied record, both REST/Tauri. Read operations are not audited — conventions §1)                                                                                             | `rest/tests.rs` / each service's `#[cfg(test)]`                                                                     |
| 6   | Confirm audit events (that every mutating operation passes through `record_write`/`audit.record`. Do not put secrets in detail — conventions §6)                                                                                                          | same as above                                                                                                       |
| 7   | Frontend: resource definition + schema registration (create `resources/<yours>.ts` and add it to the array in `resources/index.ts`)                                                                                                                       | `apps/admin-template/src/lib/banto/resources/items.ts` · same `resources/index.ts`                                  |
| 8   | Frontend: add pages · nav (copy the list/detail/new routes, add an entry to `navigation.ts`. Derive the list columns from the schema with `columnsFromSchema`, keeping hand-writing to schema-external columns like row links and `overrides` only — M23) | `apps/admin-template/src/routes/(app)/items/` · `src/lib/navigation.ts`                                             |
| 9   | (If needed) a dashboard panel · CSV import · one E2E smoke                                                                                                                                                                                                | `src/lib/banto/dashboard.ts` · `itemsAdmin.ts` · `e2e/tests/smoke.spec.ts`                                          |

If you also want it in the standalone browser demo (InMemory), add generated
data to `src/lib/banto/sampleData.ts` (optional; a feature not shown in the demo
follows the "demo explicitly refuses" of conventions §10).

## Keeping a list's filters and sort (optional, Issue #215)

To keep a list's filters, sort and the row opened last across a list →
detail → save → list round trip, use `@banto/admin-core`'s list view state
API (reference: `routes/(app)/items/+page.svelte` and
`items/[id]/+page.svelte`).

- The list page takes `const scope = currentSessionScope()` when it is
  created and passes it to every call (`loadListViewState`,
  `saveListViewState`, `loadLastOpenedId`, ...). The detail page calls
  `saveLastOpenedId(scope, resource, id)` on mount and
  `noteLastEditedRecord(scope, ...)` after a successful save (with the
  `scope` taken before the save started - nothing is written if the session
  changed meanwhile).
- State is saved with its owner (the signed-in account, or the public
  viewer) and only restored for the owner confirmed now. Since v2.0.0 the
  session is confirmed in one place, the SessionController (tyaro/banto#260,
  ADR-0016), and the template already has the wiring this relies on:
  `(app)/+layout.ts`'s `load` confirms with
  `resolveSettled(getSessionController())` (`grantFallback` for a
  `none`) and returns the generation it confirmed; `(app)/+layout.svelte`
  re-runs the loads and rebuilds the page when the generation changes
  (wiring ①); `#lib/session.svelte.ts`'s `sessionStore` is `$derived` from
  `controller.snapshot`; the logout confirms with `resolveSettled()` after
  `logout()` (`#lib/banto/logout.svelte.ts`). A custom `AuthProvider`
  implements `resolve()`, `credentialRevision()` and `onCredentialChanged()`
  (`resolve()` rejects when it cannot answer - the contract in
  `provider.ts`). Without it, list state is never saved or restored (no
  confirmed owner), or the previous session's screen survives a session
  change (no rebuild).

The session design is [session-controller-design.md](../design/session-controller-design.md) §6.1 (Japanese).

## Verification

```bash
pnpm check     # frontend lint/types
cargo test     # service layer + REST tests (:memory: SQLite)
pnpm e2e       # smoke (starts banto-serve; if you added an E2E)
```

`src-tauri` can sometimes not be compiled in the sandbox environment
(AGENTS.md). In that case, step 4 is covered by code review + the weekly Tauri
CI (improvement-plan P3-2), and state it explicitly as "verification not run" in
the completion report (AGENTS.md "Definition of Done").

## What you must not do (the relevant sections of conventions.md)

- Add a command to only one path (REST or Tauri) (§1)
- Bring axum/tauri/RBAC into the service layer (§2)
- Use a field name originating from the frontend in SQL without passing it
  through `ColumnMap` (§6)
- Put a password/token into audit detail (§6)
- Write a raw color value in a component's CSS (§9)

## Full list of files involved in `items`, and the `sqlx::migrate!` caveat

The Japanese [add-resource.md](add-resource.md) also carries the per-layer
table of every file that makes up the `items` demo (the deletion / replacement
target) and the note that only one crate may call `sqlx::migrate!` against the
same database pool (`_sqlx_migrations` is per-database, so two migrators collide
with `VersionMismatch`/`VersionMissing`). Both moved there from the README on
2026-10-08.

## When deleting items

Once the replacement with your own resource is done, the full set of files in
the "Model" column above becomes the deletion target (just trace it in reverse).
If you use the attachments items-demo wiring, the attachments steps in
[remove-optional-assets.md](remove-optional-assets.md) (Japanese) come first.
