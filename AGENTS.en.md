# AGENTS.en.md — Guide for AI agents working on Banto

> The Japanese [`AGENTS.md`](AGENTS.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

Banto (番頭) is a **template for building line-of-business apps that start on
a single PC and can later be shared to browsers on the LAN** (the same screens
and logic run in two forms: a Tauri desktop app and a browser UI served over the
LAN). It is a monorepo
with a Rust backend (axum + sqlx; SQLite by default, PostgreSQL supported) and
a SvelteKit (Svelte 5 runes) frontend. Users copy it to build their own apps.

This file is an index of "which docs to read for which task." The rules
themselves live in the individual documents.

## Documentation comes in two tracks

The tracks are split because the readers differ. **First figure out which
track your task belongs to.**

- **Track A (for maintainers) = `docs/`**: for people who maintain and extend
  the template itself. Invariants, scope decisions, implementation plans,
  distribution rules.
  - [docs/conventions.en.md](docs/conventions.en.md) — the invariants you must
    not break (**most important**)
  - [docs/ui-framework-spec.md](docs/ui-framework-spec.md) — the specification
    (the target of `spec §` references)
  - [docs/architecture-overview.md](docs/architecture-overview.md) — architecture
    overview diagrams (dual delivery, layers, feature map; Japanese)
  - [docs/roadmap.md](docs/roadmap.md) — the milestone plan and the §7
    execution process
  - [docs/template-scope.md](docs/template-scope.md) — what to include / not
    include, and how deletability is judged
  - [docs/publishing.md](docs/publishing.md) — distribution (git tag / `path:`
    dependency)
  - [docs/design/](docs/design/) — implementation plans and design documents
    for individual features (attachments-plan / report-plan /
    visual-refresh-plan and -design / display-preset-plan /
    session-controller-design, etc. — living spec anchors that code keeps
    referencing by `§` even after implementation; files are named
    `<name>-plan.md` / `-design.md`)
  - [docs/reviews/](docs/reviews/) — **survey / review records** (inventories,
    feature reviews, maintainability reviews and feedback-handling records; the
    definitions behind `M-review` / `CR-N` / `AD-N`; files are named
    `<name>-review-YYYY-MM.md` etc.):
    [docs/reviews/maintenance-review-2026-10.md](docs/reviews/maintenance-review-2026-10.md)
    (latest refactoring decision: do / defer / don't, with the triggers for revisiting),
    [docs/reviews/maintenance-review-2026-08.md](docs/reviews/maintenance-review-2026-08.md)
    (previous inventory + consolidation plan),
    [docs/reviews/feature-review-2026-08.md](docs/reviews/feature-review-2026-08.md) (a.k.a.
    M-review 2026-08),
    [docs/reviews/maintainability-review-2026-07.md](docs/reviews/maintainability-review-2026-07.md)
    (defines the CR numbering),
    [docs/reviews/choiapp-feedback-2026-09.md](docs/reviews/choiapp-feedback-2026-09.md)
    (the "choi-app" feedback record — the target of
    `choiapp-feedback-2026-09 §N` references from the pinned shell /
    settings categories / nav badges code).
    **Documents that are fully resolved and frozen move to
    [docs/history/](docs/history/)** (count inbound code references with `rg`
    before moving — see the grammar table in conventions §12).
    **Lifetime rule**: documents under [docs/history/](docs/history/) and documents whose status line
    explicitly says they are no longer a current basis are not to be used as the basis for new design
    (existing historical references and `§` references in code may stay). Active review documents (the
    defining sources / ledgers formally referenced as `CR-N`, `AD-N`, `M-review` and the like) are not
    covered by this rule and may still be referenced. A PR that changes implementation status also updates the leading `状態:` line of the
    affected plan / design document (and `最終検証日:` if present)
- **Track B (for app authors) = [README](README.en.md) + [docs/recipes/](docs/recipes/)**:
  for people building their own app from this template. The README is the
  entry point and the backbone (copy → rename → pick a preset → implement → serve); the
  full procedures live in `docs/recipes/` (rename / add-resource /
  remove-optional-assets / consume-as-git-dependency / lan-access /
  database-backup / windows-setup / no-login-app / scan-wedge / notifications /
  tree-svelte / image-assets / add-role; mostly Japanese).

## Entry points by task

- **Add a CRUD resource / replace items** →
  [docs/recipes/add-resource.en.md](docs/recipes/add-resource.en.md) (the
  official checklist-form procedure).
- **Add an RBAC role (extend admin/editor/viewer)** →
  [docs/recipes/add-role.en.md](docs/recipes/add-role.en.md).
- **Integrate a package into your app** (scan-wedge / toast notifications /
  tree-svelte / image import) → [docs/recipes/](docs/recipes/) (Track-B recipes split out of
  the README; Japanese).
- **Drop the optional assets as a batch (dock/charts/glass/command
  palette/attachments/reporting/tree)** → `pnpm scaffold --preset
minimal|standard|full|display` (`--interactive` / `--dry-run` available; the manual
  steps live in [docs/recipes/remove-optional-assets.md](docs/recipes/remove-optional-assets.md)
  (Japanese) — `pnpm scaffold --interactive` is the equivalent for English readers).
  scan-wedge is recipe-only / unwired, so scaffold never touches it.
- **Bootstrap a display-only app (andon board / always-on dashboard / kiosk
  demo)** → `pnpm scaffold --preset display`. On top of what `minimal`
  removes it drops the `items` demo resource, the users / audit-log **screens**
  and `/dashboard`, then adds `/monitor` plus the first-boot seed (LAN public
  viewing), kiosk defaults and `banto.i18n = "raw"`. It is the only preset that
  adds anything. Design: [docs/design/display-preset-plan.md](docs/design/display-preset-plan.md)
  (Japanese); user-facing notes live in the "`--preset display`" section of
  [docs/recipes/remove-optional-assets.md](docs/recipes/remove-optional-assets.md)
  (Japanese).
- **Add / change a feature** → first read the invariants in
  [docs/conventions.en.md](docs/conventions.en.md), then decide whether to do
  it with the [template-scope.md §6](docs/template-scope.md#6-今後の運用ルールと宿題)
  checklist. Follow `docs/design/*-plan.md` for the implementation plan.
- **Bug fix / refactor** → check the relevant section of
  [docs/conventions.en.md](docs/conventions.en.md) (especially the security
  invariants, the ban on reverse dependencies, and two-path symmetry).
- **Explain "how to use it" / fix the setup steps** → Track B (the README is
  the entry point; the full procedures live in `docs/recipes/`, e.g.
  [lan-access.md](docs/recipes/lan-access.md) for LAN / TLS / PWA and
  [database-backup.md](docs/recipes/database-backup.md) for DB / backup).
- **Understand the intent of the spec** → `docs/ui-framework-spec.md` (the
  target of the `spec §N` in doc comments).
- **See the overall architecture (dual delivery, layers, packages)** →
  [docs/architecture-overview.md](docs/architecture-overview.md). Auth,
  first-boot, the three dev paths, and the add-resource layer map live in
  [docs/architecture-flows.md](docs/architecture-flows.md) (Japanese; the
  diagrams are language-light).
- **Understand / record the "why and alternatives" of a design decision** →
  [docs/adr/](docs/adr/README.en.md). The "why" lives in one of three places
  (code comments / conventions.md / ADR). A decision made by comparing and
  rejecting alternatives goes in an ADR (the rule text itself is in
  conventions.md; local reasons are in the code).

## Invariants you must never break (details in conventions.md)

1. A mutating operation passes through **the same authorization + the same
   audit on both the REST and Tauri paths**.
2. **The service layer knows nothing of tauri/axum/RBAC/HTTP** (Clone +
   BantoError + sqlx). Authorization and audit are attached by the wiring
   layer.
3. **Do not add dependencies** (chrono/time/tower-http/multipart/tracing/markdown,
   etc. are hand-implemented). If you want to pull one in, discuss it as a
   design decision.
4. **No reverse dependency from core → options.** When an option is bundled,
   document its removal procedure.
5. Security: detect MIME by magic bytes, **never use user input in file
   paths**, throttle before argon2, **never put secrets in audit detail**, SQL
   columns only through the ColumnMap whitelist, and `{@html}` only with
   self-generated, fully escaped output.
6. The UI uses only `--banto-*` tokens (raw values are consolidated in the
   theme). **UI text also goes through message keys** (conventions §13,
   enforced by the raw-jp-in-app CI check). Provider branching is confined to
   the provider layer across the three kinds tauri/server/demo.

## Build and verification

```bash
pnpm check          # frontend type checks (svelte-check / tsc per package).
                    # lint is pnpm lint, build is pnpm build separately (the CI
                    # frontend job runs lint→verify:architecture→
                    # verify:migrations→check:versions→format→check→test→build
                    # in order)
cargo test          # all tests in the Rust workspace
pnpm e2e            # Playwright smoke (e2e/playwright.config.ts, starts banto-serve)
cargo audit         # dependency audit (with ignores from .cargo/audit.toml)
```

Note: `src-tauri` cannot be compiled in this sandbox because webkit2gtk is
absent. Changes on the Tauri command side are covered by code review +
`tauri-check.yml` (which runs `cargo check -p admin-template` +
`cargo test -p admin-template` on ubuntu/windows for PRs that touch the Tauri
side / dependency graph and on main pushes, plus a weekly schedule). CI runs
the jobs in `.github/workflows/ci.yml` (frontend / i18n-offline / rust /
storage-postgres / app-postgres / e2e / audit), plus the weekly/triggered
workflows `template-acceptance.yml` (copy→rename→check + the four scaffold
presets), `visual-baselines.yml` (Linux visual-baseline regeneration,
dispatch), `external-consumer.yml` (external-consumer fixture: installs
`@banto/*` / `banto-*` as Git dependencies, then dev server + browser, check,
build and cargo check; on PRs touching packages/crates, tags and dispatch -
docs/upgrading.md §8; not a required check, but do not merge a PR while it is
red), and `deploy-demo.yml` (GitHub Pages live demo). ci.yml is the
source of truth for the job list.

## Definition of Done (completion-report format for delegated tasks)

When you finish a change, always report the following (it feeds the review
stage of roadmap §7):

- **Invariants touched**: which section of conventions.md the change relates to
  (if none, say "none")
- **Impact on both REST / Tauri**: if you touched a mutating operation, did you
  implement and test both paths + denied as a pair (conventions §1)
- **Tests added / updated**: files and test names
- **Verification commands run and results**: `pnpm check` / `cargo test` /
  `pnpm e2e`, etc.
- **Verification that could not be run**: things skipped due to environment
  constraints, e.g. compiling src-tauri
- **Whether docs were updated**: reflected into README / docs / CHANGELOG

## How work proceeds (roadmap §7)

The orchestrator finalizes the design, splits it into tasks, delegates
research/implementation, reviews the deliverables, verifies with
`pnpm check` / `cargo test` / CI, and creates and merges a PR per milestone
(CI gate required). Details in
[docs/roadmap.md §7](docs/roadmap.md#7-実施プロセス).
