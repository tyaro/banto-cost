# Recipe: Add an RBAC role (the official procedure for extending admin/editor/viewer)

> The Japanese [`add-role.md`](add-role.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

Created: 2026-08-14 (the follow-up from feature-review-2026-08.md §2.6; a sibling
of [add-resource.md](add-resource.en.md)).

Intended reader: **template maintainers / AI agents (Track A)**. Banto's RBAC is
three fixed roles, `viewer < editor < admin` (spec M10), which is enough for
most apps. This is the single official procedure for when a real need arises for
a fourth role (e.g., `auditor` = audit-log read-only, `manager` = editor plus
some user management).

## Prerequisite: first decide whether to add a role at all

A role is a **cross-cutting vocabulary that affects every path's authorization
floor** (the `Role` enum is shared by REST's `RoleGuard`, Tauri's
`require_role`, the DB CHECK constraint, and the frontend picker UI). Before
adding one, consider:

- **Can the existing three-role floor express it?** If it's just "can write one
  specific resource," adjusting that route's `RoleGuard { min }` is smaller than
  adding a role.
- **Does it fit an ordered (total-order) model?** `Role::rank()` is a total
  order (`at_least` builds on it). A role that sits "between editor and admin"
  slots in cleanly. A "sideways" permission that is neither editor nor admin
  (not a total order) does not fit this model and requires switching to
  **capability predicates** (like `can_write_resources()`) instead — that is a
  design change (an ADR), not this recipe.

## Checklist (in order)

Treat the `Role` definition (`crates/banto-admin-services/src/rbac.rs`) as the
single source of truth and spread out from there to the DB, authz floors, and
frontend.

| #   | Step                                                                                                                                                                                                                                             | Where                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Add the variant to the `Role` enum and update `as_str` / `rank` (its total-order position) / `from_str` / capability predicates (`can_write_resources`, etc.). `#[serde(rename_all = "lowercase")]` and `Display` follow automatically           | `crates/banto-admin-services/src/rbac.rs`                                                                                     |
| 2   | Add a **new migration** that extends the DB CHECK constraint with the new role string (do NOT edit the existing `0004_user_roles.sql`; both SQLite/Postgres, conventions §11)                                                                    | new sequential SQL in `apps/admin-template/core/migrations-{sqlite,postgres}/`                                                |
| 3   | Set authz floors: configure `RoleGuard { min: Role::X }` (REST) and `require_role(state, Role::X, ..)` (Tauri) **symmetrically on both paths** (conventions §1) for the routes/commands the new role guards                                      | `crates/banto-server/src/routes/*.rs` · `apps/admin-template/core/src/rest/*.rs` · `apps/admin-template/src-tauri/src/lib.rs` |
| 4   | Update rule 8's role-floor cross-check (`DUAL_PATH`'s `role` / `ROLE_READ`) in `verify-architecture.mjs` for any pair whose floor changed                                                                                                        | `scripts/verify-architecture.mjs`                                                                                             |
| 5   | Frontend: add the role option to the picker UI and the i18n role-name key (`role.<yours>`)                                                                                                                                                       | `apps/admin-template/src/routes/(app)/users/+page.svelte`'s `ROLES` array · `messages/{ja,en}.json`'s `role.*`                |
| 6   | Frontend types: add the role to the `UserRole` union / the `Role` description in `provider.ts`                                                                                                                                                   | `packages/admin-core/src/provider.ts` and other Role types                                                                    |
| 7   | **Two-path authz-symmetry tests**: that the new role succeeds on routes whose floor it meets and gets 403 + a denied record where it doesn't, on BOTH the REST and Tauri paths (conventions §1). Also update the RBAC ordering test (`at_least`) | `crates/banto-admin-services/src/rbac.rs`'s `#[cfg(test)]` · `apps/admin-template/core/src/rest/tests.rs`                     |

## Verification

```bash
pnpm check                 # frontend lint/types (exhaustiveness of the role union)
pnpm verify:architecture   # rule 8's role-floor cross-check
cargo test                 # rbac ordering tests + REST authz tests
```

`src-tauri` may not compile in the sandbox (AGENTS.md). If so, cover the Tauri
side of step 3 with code review plus the weekly Tauri CI, and note it as
"verification not run" in the completion report (AGENTS.md "Definition of Done").

## What not to do

- Set the new role's floor on only one path (REST or Tauri) (conventions §1).
- Rewrite the existing `0004_user_roles.sql` to change the CHECK constraint (it
  would diverge from already-applied DBs; always add a new sequential migration,
  conventions §11).
- Force a non-total-order permission into `rank()` (go back to the prerequisite
  decision; if it's a design change, write an ADR).
- Ship without checking that the auth setting `disabled_role`
  (`SettingsService.AuthSettings`) is consistent with the new role (it
  references `Role`, so it is affected).
