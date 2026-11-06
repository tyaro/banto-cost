# ADR-0005: Adopt Paraglide JS as the UI i18n runtime (a deliberate exception to ADR-0002)

> The Japanese [`0005-i18n-paraglide.md`](0005-i18n-paraglide.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-07-29
- Related: [conventions.md §3](../conventions.en.md), [ADR-0002](0002-minimal-dependencies.en.md),
  docs/i18n-plan.md (§3.5 / §5 / §6.1), docs/conventions.en.md §5・§10, Theme B PR-B1

## Context

In implementing the ② foundation of UI internationalization (i18n) — the
`t()` equivalent, locale resolution, persistence, and language switching — we
needed to decide whether to **implement the i18n runtime in-house or pull in an
external library** (open question 1 of i18n-plan §3.5 / §6.1).

Banto is "a template you copy and use," and every dependency is inherited,
audited, and updated by the user ([ADR-0002](0002-minimal-dependencies.en.md)).
Selecting the i18n runtime is therefore a foundational decision that carries a
trade-off between functional requirements (type safety, SSG/client-side
resolution, runtime cost) and dependency minimization. The underlying setup is
Svelte 5 / SvelteKit 2 / Vite 6 / `@sveltejs/adapter-static` (SSG, SPA
fallback), with no server runtime (locale resolution is completed on the client
side, i18n-plan §3.3).

The judgment criteria of ADR-0002 (P1-5) are "the goal is not zero
dependencies but **minimizing total maintenance cost**," and it says to
consider dependency adoption favorably when several apply: ① the in-house
implementation would bloat, ② a security boundary, ③ a domain with many edge
cases such as plurals, language tags, future ICU, ④ the crate/package is
sufficiently mature, ⑤ it can be pulled scoped to a single feature, ⑥ the
bundle increase has been measured. i18n is a domain that begins to fall under
③ (plurals, language tags, future ICU).

## Decision

**Adopt [Paraglide JS (inlang)](https://paraglidejs.com/) as the UI i18n
runtime** (`@inlang/paraglide-js`, a devDependency). This is a **deliberate
exception** to ADR-0002 "add no dependencies," and this ADR records that
judgment and the comparison of alternatives.

- **Primary language (base-locale) = English**, target locales = en + ja
  (i18n-plan §6.1).
- The dependency is **compile-time only**. Paraglide **compiles** the message
  JSON into tree-shakeable message functions (`src/lib/paraglide/`), and the
  output is self-contained with no runtime dependency on `@inlang/paraglide-js`
  (i.e. the "runtime dependency" the user inherits is effectively zero, and the
  binary/bundle carries only the messages actually used).
- The output is **not committed and is gitignored**. In both CI and locally,
  `paraglide:compile` generates it as a step before build/check (the Vite
  plugin + a CLI pre-step for `pnpm check`).
- i18n is **the app layer only** (conventions §5). `@banto/*` does not import
  Paraglide; it receives copy via the existing props injection (i18n layer ①).
  Locale resolution and persistence are confined to the provider/settings layer
  (conventions §10) — the default display locale stays Japanese (zero visual
  regression), and even with base-locale English the initial display is ja (the
  custom client strategy `custom-banto` resolves to the localStorage default
  ja).

## Alternatives considered

- **Option A (adopted): Paraglide JS.** Pros: **compile-time i18n with a
  minimal runtime dependency** (the output is self-contained and
  tree-shakeable, so the user's inherited dependency tree does not grow — this
  sidesteps most of ADR-0002's concern); **full type safety** (message function
  arguments and locales are typed, checked by `pnpm check`); it is SvelteKit's
  official i18n integration with a ready-made Vite plugin; and a custom strategy
  rides naturally on adapter-static's client-side resolution. Future ICU
  MessageFormat (plurals, gender) can also be extended on the same runtime.
  Cons: it adds one external dependency (a restraint target of ADR-0002), it
  requires wiring a compile step into build/CI, and it needs management of the
  generated-output directory (gitignore).
- **Option B (rejected): in-house implementation (a flat dictionary +
  `{name}` interpolation).** Pros: zero dependencies, most consistent with
  ADR-0002, small and easy to grasp. Cons: the **burden of providing type
  safety yourself** is heavy, and you end up hand-building checks for missing
  keys and locale coverage. It is reasonable while it is a simple JA+EN
  dictionary (i18n-plan §3.5 assessed it that way too), but once you look ahead
  as the ② foundation to provider wiring, language tags, and future
  plurals/ICU, a mature compiler (Option A) has a **lower total maintenance
  cost** (falls under ③④ of P1-5). Since layer ① alone (props injection) can be
  kept dependency-free, the in-house-vs-dependency judgment can be confined to
  the ② foundation, and there Option A wins.
- **Option C (rejected): `svelte-i18n`.** A runtime dictionary-loading approach
  with **weak type safety** (keys are strings, no compile-time checking), and
  because it holds the dictionary at runtime, tree-shaking does not work. It is
  inferior to Option A in that it makes template users inherit a runtime
  dependency and bundle.
- **Option D (rejected): `typesafe-i18n`.** It provides type safety, but given
  its maintenance stagnation (ecosystem activity lower than Paraglide/inlang)
  and thin first-class support for SvelteKit/Vite, we choose Option A as the
  foundation the template will inherit for the long term.

## Consequences

- **The ADR-0002 table and principle are maintained.** This ADR is "an
  exception limited to the i18n runtime," and the in-house-implementation policy
  for other domains (dates, MIME, markdown, logging, etc.) is unchanged. Add
  one line in conventions §3 referencing this ADR, so that "i18n is a deliberate
  exception that pulls in Paraglide" is traceable.
- **Obligation to keep the nature of the dependency minimal**: keep Paraglide as
  a devDependency (compile-time only), and do not adopt usage that adds a
  runtime dependency on the output (server middleware, URL strategy, and other
  SSR-premised features) — also because of adapter-static's constraints.
  Confine it to client-side resolution (localStorage/settings).
- **Keep the compile-step wiring intact**: `src/lib/paraglide/` is gitignored.
  `pnpm build` generates it via the Vite plugin, and `pnpm check` via the
  `paraglide:compile` pre-step. Because `strategy` is **managed in two places**
  — the Vite plugin config and the CLI script — keep both at the same value
  (`custom-banto` + `baseLocale`) (noted in a comment in vite.config.ts).
- **Obligation to stay consistent with the invariants**: do not bring i18n into
  `@banto/*` (§5, mechanically checked by `verify:architecture`'s no-app-import).
  Keep locale branching confined to the provider/settings layer (§10). Maintain
  zero visual regression with the default display being Japanese.
- **Re-evaluation conditions**: if Paraglide's maintenance stagnates or a
  breaking change makes maintaining the compile wiring heavy, or if the
  requirements no longer fit Paraglide's design (e.g. "runtime dictionary
  loading"), supersede this ADR and decide anew (ADRs are not rewritten).

---

Addendum (2026-08-13): `docs/i18n-plan.md`, referenced by the body and the
"related" list, does not exist in the repository (lost before the history
truncation; see
[maintenance-review-2026-08.md §2.2](../reviews/maintenance-review-2026-08.md)).
The current primary sources are
[conventions.md §13](../conventions.en.md#i18n-messages) (layer-① injection /
message-key rule) and this ADR (the layer decision). The old references in code
were rewritten to conventions §13 / ADR-0005 on the same day. The body itself
stays unchanged per the ADR immutability rule.
