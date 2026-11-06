# ADR-0007: Reconcile source-shipped `.svelte.ts` with derived-app dev via consumer `optimizeDeps.exclude`

> The Japanese [`0007-derived-app-dev-optimizer-exclude.md`](0007-derived-app-dev-optimizer-exclude.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-08-14
- Related: [conventions.md §3](../conventions.en.md) (no added dependencies),
  [ADR-0002](0002-minimal-dependencies.en.md) (minimal dependencies),
  [publishing.md](../publishing.md) (source distribution / git deps), issue #150

## Context

Banto's `@banto/*` packages ship **source** (`exports` point at
`./src/index.ts`, raw `.svelte.ts` runes modules published as-is,
`files: ["src"]`; the M18 decision in publishing.md). In a derived app that
consumes the template via git tag + `path:` deps, these become **real
node_modules packages**.

Issue #150: in a derived app `pnpm dev` fails - Vite 8's dependency optimizer
(Rolldown) prebundles `@banto/admin-core` etc. and chokes on `.svelte.ts`
TS-only syntax like `import type`, throwing "Unexpected token"
(js_parse_error) → HTTP 500. `pnpm build` / `pnpm check` succeed.

Root cause (confirmed by source analysis + reproduction):

- `vite-plugin-svelte` defaults `prebundleSvelteLibraries` to true in dev
  (`options.js:152`, `!isBuild`), and when enabled it clears the automatic
  exclude of svelte libraries (`options.js:527`). `@banto` packages carrying a
  `svelte` export condition are treated as framework packages and, as real
  node_modules in a derived app, become prebundle targets.
- The optimizer's module path (`compileSvelteModule` in `setup-optimizer.js`)
  hands `.svelte.ts` to `svelte.compileModule` **without preprocessing**, so
  TS-only syntax fails. The normal dev transform path (`compile-module.js`'s
  `enforce:'post'`) is fine because Vite core strips the TS first.
- The template itself resolves `@banto/*` via workspace symlinks (realpath
  outside node_modules), so they are never prebundled - harmless. Build has
  prebundle disabled via `isBuild`; check never runs Vite.

## Decision

**Place `optimizeDeps.exclude` in the consumer template's
`apps/admin-template/vite.config.ts`, excluding the `@banto/*` packages that
ship `.svelte.ts` from the dev optimizer's prebundling** (option D). The
source-distribution policy is kept.

## Alternatives considered

- **Option D (adopted): consumer `optimizeDeps.exclude`.** Keeps source
  distribution (publishing.md) and minimal dependencies (ADR-0002) intact,
  solved entirely by consumer config. Excluded packages go through the normal
  dev transform path and compile correctly. Reproduced: the 4 js_parse_errors
  clear (exit 0). No-op (no regression) for the template itself, which is never
  prebundled. Downside: excluded packages are served as individual modules in
  dev (slightly slower cold start; no functional impact); the list needs
  maintaining (→ machine-checked, see Consequences).
- **Option B (rejected): dist distribution.** Compiling `.svelte.ts` to JS via
  `@sveltejs/package` would stop the optimizer from choking, but **reverses the
  source-distribution policy** in publishing.md and adds a build-pipeline
  dependency (ADR-0002's "no") plus dist double-maintenance. Not worth the
  total maintenance cost.
- **Option C (rejected, already satisfied): adding the `svelte` export
  condition.** All `@banto/*` already carry it, but the default
  `prebundleSvelteLibraries: true` clears the exclude, so it **does not work on
  its own**.
- **Option D-alt (fallback): `vitePlugin: { prebundleSvelteLibraries: false }`
  in `svelte.config.js`.** No list to maintain and auto-tracks future
  `.svelte.ts` packages, but stops prebundling `@lucide/svelte` too (slower
  cold start). Kept as the fallback if the enumerated exclude is missed or
  proves insufficient.

## Consequences

- **Maintenance rule (invariant)**: every `@banto/*` dependency that
  source-ships a `.svelte.ts` under src/ MUST be listed in
  `apps/admin-template/vite.config.ts`'s `optimizeDeps.exclude`, kept in sync on
  new additions. Packages with only `.svelte` components
  (charts/attachments/report) go through the preprocessing path and are exempt.
  This invariant is recorded in conventions.md, and `verify:architecture` (rule
  `optimizedeps-svelte-source`) machine-checks that the exclude list matches
  "the `@banto/*` deps of admin-template that carry a `.svelte.ts`".
- **Verification limits**: this ADR is backed by `vite-plugin-svelte` source
  analysis and a node_modules-materialized reproduction (`vite optimize
--force` yields the same 4 js_parse_errors as the issue → adding the exclude
  gives exit 0). The real path that triggers the issue (`pnpm add
"github:tyaro/banto#<tag>&path:packages/*"` git-tag deps run in a real dev
  server) needs private-tag auth and a live run and was not exercised. The
  durable guard is the `verify:architecture` list-match check.
  - **Update 2026-10-01 (#271)**: the end-to-end path is now covered in CI.
    [external-consumer.yml](../../.github/workflows/external-consumer.yml)
    installs `@banto/*` into `fixtures/external-consumer/` as Git dependencies
    (PR head SHA, release tags, etc.), opens `vite dev` in a browser and checks
    that the page renders (with the exclude = the pass condition). A diagnostic
    job without the exclude (not a pass condition) records whether #150 still
    reproduces. Measured: 11 js_parse_errors at v1.7.3 and 14 at main
    (212c3a0) without the exclude, 0 with it. **If the diagnostic job reports
    "not reproduced", upstream may have fixed it - revisit this ADR.** The
    fixture's exclude list is also checked by `verify:architecture` (rule
    `external-consumer-fixture`).
- **Coupling to distribution policy**: publishing.md now states that
  source-shipped `.svelte.ts` only works together with the consumer's dev config
  (`optimizeDeps.exclude`). The previous pack-only distribution checks did not
  cover the dev-optimizer path.
