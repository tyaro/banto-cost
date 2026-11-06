# ADR-0028: Decide business permissions by capabilities and project scope, separately from roles, and keep the decision and the denial audit in one function

> 日本語: [0028-capability-project-scope-authz.md](0028-capability-project-scope-authz.md)

- Status: Accepted
- Date: 2026-11-06
- Related: [conventions.en.md §1, §2](../conventions.en.md), [recipes/add-role.md](../recipes/add-role.md) "Premise", [docs/project/design.md](../project/design.md) chapter 2, [docs/project/spec.md](../project/spec.md) chapter 4 and acceptance T12/T19/T20, ADR-0001

## Context

banto-cost (a project cost and profit app derived from Banto v6.10.0) is used by data-entry staff, sales, project managers, accounting, management and system administrators, often with one person holding several of these. The permissions they need are side by side, not a total order:

- Accounting sees hourly cost rates but does not manage users.
- The system administrator manages users, permissions and masters but does not see amounts or rates unless granted separately.
- A project manager sees and approves the revenue, cost and profit of their own projects only.

Banto's `Role` (viewer < editor < admin) is a total order, and `add-role.md` says side-by-side permissions need more capability predicates (a design change recorded as an ADR), not another role. The spec also requires the same permission on screens, API, CSV, search results and direct detail URLs (T12), forbids self-approval (an exception must leave a history), and requires company membership and permissions to be granted explicitly rather than inherited from another app such as a personal one (T19/T20).

## Decision

1. **Keep roles as the app-wide floor; hold business permissions as capabilities and project scope.**
   - Capabilities: `time.entry` / `pipeline.edit` / `project.manage` / `finance.rate` / `finance.close` / `report.all` / `amount.view`, any number per user in `user_capabilities` (migration `0009_authz.sql`).
   - Project scope: `project_members` (project, user, kind `sales` / `manager` / `worker`).
2. **One pure decision function, `banto_admin_services::authz::authorize(subject, operation, policy)`.** Lists, search and CSV filter with `visible_projects` / `amount_projects`, built from the same rules, so a row the detail view would refuse never appears in a list. Self-approval is refused unless `Policy.allow_self_approval`; when the exception is used, `Allowed.self_approval_exception` tells the caller to audit it.
3. **Membership of the company data is an explicit capability grant in this database only.** Nothing is derived from the role (not even admin), a grant session (no user row), the auth-disabled synthetic session, or another app's users. A project-member row alone does not make a member.
4. **REST and Tauri call one shared guard, `AuthzService::authorize_audited`.** It decides and records the denial (`action: "denied"`, `detail` with operation, reason and project); the paths differ only in `origin`. The role floor (`RoleGuard` / `require_role`) still runs first and `verify-architecture.mjs` rule 8 checks it on both paths.
5. The user row id comes from the session's `SessionStamp.account_id` on REST (falling back to a username lookup) and from `DesktopSession::Account`'s `id` on Tauri, never from a username alone where the stamp exists.

## Alternatives considered

- **A (adopted): role floor + capabilities + project scope, with the decision and the denial audit in one function in `banto-admin-services`.** Pros: expresses side-by-side permissions and per-project scope; one decision point keeps REST, Tauri, CSV and search aligned; one place fixes the denial audit shape. Cons: a deviation from conventions §2 ("services do not know actors / RBAC"), see consequences.
- **B (rejected): add roles (`accountant`, `manager`, ...).** Does not fit `rank()`'s total order; combined duties multiply roles; cannot express per-project scope.
- **C (rejected): write the decision in each wiring layer, like Banto's `RoleGuard` / `require_role`.** A role floor is a single comparison, so duplicating it rarely drifts; capability × scope × self-approval has many conditions and invites fixing one side only. CSV and search need the same rules too, which would triple the copies.
- **D (rejected): put the decision in `cost-domain`.** That crate is pure calculation rules with no DB or audit. The decision function is pure, but the guard reads grants and records denials, so the vocabulary lives in `banto-admin-services` with it.

## Consequences

- Exception to conventions §2: `AuthzService::authorize_audited` takes an actor and records denials. Services still do not depend on tauri / axum / HTTP (the `verify:architecture` service-layer check passes). Role floors and success audits stay in the wiring layers.
- A new business operation is added to `Operation` with its rule in `authorize`, and both REST and Tauri go through `authorize_audited`. Lists, search and CSV filter with `visible_projects` / `amount_projects`. Add the denial tests on both paths as a pair (T12).
- Changing a capability string changes `Capability` and the CHECK of `0009_authz.sql` together, through a new migration (conventions §11).
- `project_members.project_id` has no foreign key until the projects table arrives in P3; check referential integrity when P3 creates it.
- Granting capabilities and assigning project members has the admin floor. If project managers need to assign members of their own projects, add an `Operation` and revisit.
