# ADR-0009: Make UI declaration a schema-driven incremental extension and place additional renderers outside the boundary as REST clients

> The Japanese [`0009-schema-ui-rest-renderer-boundary.md`](0009-schema-ui-rest-renderer-boundary.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-08-25
- Related: Discussion #173, [conventions.md §1, §2, §5](../conventions.en.md),
  [ADR-0001](0001-rest-tauri-two-path-symmetry.en.md),
  [ADR-0002](0002-minimal-dependencies.en.md),
  [template-scope.md §3.1, §4.2](../template-scope.md),
  [roadmap.md §3](../roadmap.md) (the chart-performance escalation
  ladder), spec §2.2, §3.1

## Context

The emergence of Rust-native UI toolkits such as GPUI prompted a look at a
"Core → shared UI definition → both Web and native renderers" concept.
Two things needed deciding: (1) how far to unify the UI declaration
layer, and (2) where to attach additional renderers. As a premise, LAN
browser delivery is the template's core form
([ADR-0001](0001-rest-tauri-two-path-symmetry.en.md)) and the Web renderer
cannot be removed — an additional renderer is structurally always a "+1";
"replacement" is not an available option.

## Decision

1. **Keep the core of the UI declaration layer as serializable data.** Field
   types, constraints, enums, `capabilities`, and column derivation
   (spec §3.1's `columnsFromSchema`) belong to this core. Existing
   function-value slots (forms' `FieldDef.validate`, grid's accessor/format,
   i18n's label getter, etc.) are **renderer-non-portable extension
   points** — do not assume they are shared across renderers. If declarative
   conditions (e.g. `visibleWhen`) are added in the future, keep them to "a
   data representation of simple comparisons" at most — a closed operator
   set (roughly `eq`/`ne`/`gt`/`lt`/`in`/`empty`), no AND/OR or nesting, able
   to reference only fields on the same record, with the evaluator kept as a
   single pure function rather than duplicated per renderer. Introducing a
   string expression language or condition composition is out of scope for
   this ADR and requires a new one.
2. **Additional renderers (native, etc.) connect as REST + SSE clients
   outside the `banto-server` boundary.** Direct links to the service layer
   (`banto-admin-services`, etc.) are forbidden — an in-process direct link
   can bypass the authorization, audit, and rate-limit gates. The only Rust
   types that may be shared are `banto-core`'s wire types.
3. **Do not build a generic UI DSL (a renderer-independent intermediate UI
   description layer) or a cross-renderer common widget layer.**

## Alternatives considered

- **Option A (adopted): schema incremental extension + REST client
  boundary.** Keeps existing investment (spec §3.1's `columnsFromSchema`
  etc., schema-to-form/grid derivation) and the machine-check assets intact.
- **Option B (rejected): generic UI DSL + bundling multiple renderers.**
  The Web UI parity surface measures 27,994 lines plus 9,737 lines of tests
  (the ceiling value for taking full parity; even narrowing to the
  worthwhile subset — the monitoring dashboard alone — is about 13,000
  lines), which locks in double maintenance and puts the learning and
  upkeep burden of a second language on every copy-template user.
  Least-common-denominator widgets and keeping multiple implementations'
  semantics in sync also tend to fail, per precedent (React Native's
  retreat, .NET MAUI's stagnation).
- **Option C (rejected): a native renderer accessing the service layer
  directly.** An in-process client can pass straight through authorization,
  audit, and throttling, which would force conventions §1's denied
  pair-test obligation, machine-check rule 8 (`DUAL_PATH`), and the audit
  `origin` (currently two values, `"rest"`/`"tauri"`, decided server-side)
  to extend across every mutating operation.
- **Option D (rejected; recorded here as considered for the first time):
  unify the desktop onto REST too and fold away the two-path split
  itself.** The current desktop has the strong security property of zero
  listening sockets by default; an always-listening loopback changes the
  threat model to things like a lockout DoS from other local processes.
  Desktop-only commands such as keyring auto-login, vibrancy, and folder-open
  also do not fit onto REST. Recorded as a revisit candidate for when a
  future renderer is added (an option that was absent from
  [ADR-0001](0001-rest-tauri-two-path-symmetry.en.md)'s alternatives).

## Consequences

- **Measured values (2026-08-25, recorded together with the commands to
  re-measure them)**: UI-independent Rust is 16,117 lines = crates 10,941
  (banto-core 357 / banto-storage 1,689 / banto-server 3,581 /
  banto-admin-services 4,199 / banto-attachments 1,115) + admin-template-core
  5,176. Measured with:
  `for c in banto-core banto-storage banto-server banto-admin-services banto-attachments; do find crates/$c/src -name '*.rs' | xargs wc -l | tail -1; done`
  / `find apps/admin-template/core/src -name '*.rs' | xargs wc -l | tail -1`.
  The Web UI parity surface is 27,994 lines = `packages/*/src` +
  `apps/admin-template/src` (excluding paraglide) `.ts`/`.svelte` at 30,470
  lines, minus non-UI (admin-core 2,036 / theme 78 / scan-wedge 362).
  Separately, `*.test.ts` is 9,737 lines. Measured with:
  `find packages/*/src \( -name '*.ts' -o -name '*.svelte' \) | xargs wc -l | tail -1`
  / `find apps/admin-template/src \( -name '*.ts' -o -name '*.svelte' \) -not -path '*paraglide*' | xargs wc -l | tail -1`
  / `find packages apps/admin-template -name '*.test.ts' -not -path '*node_modules*' | xargs wc -l | tail -1`.
- The observation of native candidates and their promotion/retreat
  conditions live in [roadmap.md §3](../roadmap.md), "the
  chart-performance escalation ladder" (the canonical, living document).
  This ADR holds only the principle: "do not start until the earlier
  rungs — server-side aggregation, Canvas 2D — fail to meet requirements."
- **Record of candidate status as of 2026-08-25**: gpui has had no release
  on crates.io for 10 months since 0.2.2 (2025-10-22), Zed the company has
  announced it is halting GPUI development for the community, and forks have
  split into three lines — gpui-ce / open-gpui / Glass-HQ — none of which
  has reached critical mass (a handful to a few hundred stars, some
  individually maintained). The re-entry signal is a set of fork-independent
  convergence conditions — organizational backing (bus factor > 1), regular
  releases every 6-12 months, working component assets, production quality
  on Windows — plus, for the GPUI lineage, watching Zed's own activity too.
- **Prerequisites if a PoC is run**: run it as a REST/SSE client (direct
  links to the service layer are forbidden — measuring via a direct link
  would diverge from the configuration used at adoption and defeat the
  point of the measurement); limit it to a single real-time trend screen;
  compare SVG / disposable Canvas / native three ways on the same workload;
  fix numeric targets in advance.
- **Open items (need design work at adoption time)**: a third value for
  audit `origin` (a client's self-reported kind can be spoofed, so the
  server should bind the client type at token issuance, etc.); the storage
  convention for bearer tokens on the native side (OS keychain, etc.); a
  threat-model evaluation of an always-listening loopback.
- If PoC code is brought into the workspace, first put in place a machine
  check forbidding "UI client crate → service layer" dependencies (via
  cargo metadata, the same shape as rule 4). Whether to add it is judged by
  [ADR-0008](0008-machine-check-stop-gate.en.md)'s three-condition gate.
