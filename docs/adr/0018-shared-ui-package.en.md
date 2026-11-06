# ADR-0018: Move general-purpose UI components into a new `@banto/ui` package in stages, and have callers inject text, icons, state and actions

> 日本語: [0018-shared-ui-package.md](0018-shared-ui-package.md)

- Status: Accepted (phases 1-5 done; phase 4 = Modal / Drawer and the layering helpers, after the owner revised decision 10 on 2026-10-11, §10; phase 5 = LauncherBar, 2026-10-20, §11)
- Date: 2026-10-07
- Related: Issue #220 / [conventions.md](../conventions.en.md) §4, §5, §9, §13, §14 /
  [ADR-0002](0002-minimal-dependencies.en.md), [ADR-0005](0005-i18n-paraglide.en.md),
  [ADR-0007](0007-derived-app-dev-optimizer-exclude.en.md), [ADR-0008](0008-machine-check-stop-gate.en.md),
  [ADR-0011](0011-git-tag-distribution.en.md) / [template-scope.md](../template-scope.md) §2.1, §3.1 /
  banto-industrial #381 (the Esc layering contract), T19 S2-c2 (the undo button on toasts)

## Context

General-purpose components such as `PageHeader` and `SurfaceCard` live in
`apps/admin-template/src/lib/components/`, and derived apps copy them. Copies do not receive
later improvements or fixes. In practice the two banto-industrial apps (banto-hub and
chronogazer) copied `CommandPalette` and `ToastHost` at different times, and there are now three
variants (see the inventory below). Issue #220 proposed keeping the monorepo and sharing common
UI as a package under `packages/`. The owner's plan (2026-10-07) has four phases:

- Phase 0 (this ADR): inventory and design. No code moves.
- Phase 1: move the seven components in `components/ui/` (EmptyState, ErrorState, IconButton,
  LoadingState, PageHeader, StatusBadge, SurfaceCard) into the new package and make
  admin-template its consumer.
- Phase 2: the menu components (`components/menu/`), CommandPalette and ToastHost, reconciled
  with the banto-industrial copies (banto-hub's CommandPalette, ToastHost, Modal, Drawer and the
  focusTrap, escLayering and focusRestore helpers; chronogazer's CommandPalette and ToastHost).
- Phase 3: banto-industrial switches to the new package.

### Inventory (the seven phase-1 components, v5.1.0 + main 03c69d1)

| Component      | Lines | Non-app imports                  | Props / snippets                                  | Consumer files   |
| -------------- | ----- | -------------------------------- | ------------------------------------------------- | ---------------- |
| `EmptyState`   | 64    | `@lucide/svelte` (Inbox)         | `icon?` `title` `description?` `action?`(snippet) | 3                |
| `ErrorState`   | 66    | `@lucide/svelte` (OctagonAlert)  | `icon?` `title` `description?` `action?`(snippet) | 1                |
| `IconButton`   | 61    | none                             | `label` `icon` `size?` `onclick`                  | 2 (4 call sites) |
| `LoadingState` | 91    | **`#lib/paraglide/messages.js`** | `label?` `lines?`                                 | 6                |
| `PageHeader`   | 68    | none                             | `title` `description?` `actions?`(snippet)        | 8                |
| `StatusBadge`  | 87    | `@lucide/svelte` (5 icons)       | `variant` `label` `icon?`                         | 4                |
| `SurfaceCard`  | 83    | none                             | `title?` `description?` `children` `footer?`      | 9                |

- **The only app-specific import is Paraglide in `LoadingState`** (the default announced text,
  `common.loading`). None of the components imports `$app/*`, stores, Tauri or `@banto/*`. Only
  one call site (`users/+page.svelte`) relies on `LoadingState`'s default text; the other five
  pass `label`.
- **Three components, seven icons depend on lucide** (Inbox, OctagonAlert, Circle, CircleCheck,
  TriangleAlert, CircleAlert, Info). All of them are defaults that `icon` can replace. Neither
  banto-industrial app depends on `@lucide/svelte`.
- **Keyboard and assistive technology**: `IconButton` is a `<button>` that puts `label` into both
  `aria-label` and `title`, with `--banto-focus-ring` on `:focus-visible`. `LoadingState` is
  `role="status"` + `aria-live="polite"` with visually hidden text, and stops the pulse under
  `prefers-reduced-motion`. `ErrorState` is `role="alert"`. `StatusBadge` never relies on colour
  alone and always renders an icon (`aria-hidden`). `PageHeader` renders `<h1>` with
  `view-transition-name: page-header`; `EmptyState`, `ErrorState` and `SurfaceCard` render a
  fixed `<h2>`.
- **Tokens used** (all already in `@banto/theme`): `--banto-text`, `-text-muted`, `-danger`,
  `-primary`, `-primary-hover`, `-surface`, `-surface-subtle`, `-surface-hover`, `-border`,
  `-radius-sm/md/lg`, `-shadow-sm`, `-control-height(-sm)`, `-focus-ring`, `-duration-fast`,
  `-ease-out`, `-backdrop`, `-{success,warning,danger}-tint(-text)`. There are no raw colour values
  (`StatusBadge`'s `info` builds its tint from tokens with `color-mix()`).
- banto-industrial uses none of these seven (banto-hub's settings page notes that "the
  template's `PageHeader` is not there" and has no heading of its own). The phase-1 gain is a
  smaller copy surface in admin-template and new components that derived apps can start using.

### Inventory (phase-2 candidates, three variants)

| Component                            | admin-template | banto-hub   | chronogazer | Consumers (template / hub / cg) |
| ------------------------------------ | -------------- | ----------- | ----------- | ------------------------------- |
| `menu/` (Menu + 3 parts + context)   | 437 lines      | -           | -           | Header only / - / -             |
| `CommandPalette`                     | 335 lines      | 325 lines   | 278 lines   | 1 / 1 / 1                       |
| `ToastHost`                          | 132 lines      | 104 lines   | 77 lines    | 1 / 1 / 1                       |
| `Modal` / `Drawer`                   | -              | 307 / 307   | -           | - / 4 files / -                 |
| focusTrap, focusRestore, escLayering | -              | 98, 48, 190 | -           | - / 10 files / -                |

**Menu components**: import nothing but `svelte` (the code already says it avoids app-specific
imports so it can be promoted to a shared package). `popover="auto"` (top layer; the browser
handles outside clicks and Esc) + `role="menu"`, roving focus (Up/Down, Home, End; Tab closes),
flips above the trigger when there is no room below, closes on scroll, and returns focus to the
trigger on close (without stealing it if focus has already moved elsewhere). `MenuItem` supports
`aria-disabled` and `danger`. It can move as is.

**How the three CommandPalette variants differ** (shared: overlay + `role="dialog"` +
combobox/listbox, group headings, Up/Down and Enter, closes on an outside pointerdown, disabled
while a command runs, failures go through admin-core's `notify`):

- Only admin-template has: four Paraglide strings, **closing itself when the session changes**
  (#258, `currentSessionScope`/`isCurrentSessionScope`), recent commands recorded per session
  (`#lib/recentCommands`), the post-visual-refresh tokens (`--banto-surface-overlay`,
  `--banto-radius-lg`, `--banto-shadow-lg`) and entry motion (`@starting-style`), and a
  `--banto-surface-hover` selected row.
- Only banto-hub has: a **focus trap** (`attachFocusTrap`), **returning focus to where it was
  opened from** (checked after `tick()`, falling back to `header button`), and **Esc handled on
  window** (closes even when focus is outside the palette). Its text is hard-coded Japanese,
  recent commands are not split per session, the selected row is a primary tint
  (`--banto-accent-gradient` under glass), and the shadow and overlay use raw `rgba()`.
- chronogazer: admin-template's pre-#258, pre-visual-refresh shape with hard-coded Japanese. No
  focus trap, no focus return, no window-level Esc.
- All three import `@banto/admin-core` (`searchCommands`, `PaletteCommand`, `notify`,
  `isProviderError`) and the app's `#lib/commands` and `#lib/commandPalette.svelte`. All three use
  `rgba(0, 0, 0, 0.35)` for the overlay background.

**How the three ToastHost variants differ**: admin-template has tinted backgrounds per kind
(including warning), slide-in motion, glass, `:focus-visible` on the close button and a Paraglide
"close" label. banto-hub has an **optional action button** (undo; its store's `push` accepts
`{ action, durationMs }` and returns the `id`), hard-coded Japanese and the older style (left
stripe only, raw `rgba()` shadow, no warning colours). chronogazer is banto-hub without the
action. All three import the app's `#lib/toast.svelte`, and the store shape (`toasts`, `push`,
`dismiss`) is the same.

**Modal / Drawer (banto-hub only)**: nearly identical logic with different looks (centred,
fade + scale, 560px default / right side, fade + fly, 480px default). Props: `open`, `title`,
`width`, `closeOnOverlayClick`, `onclose`, `onRequestClose` (return `false` to stay open),
`dirty` (Esc and overlay do not close; × still does), `onBlockedClose`, `focusFallback`,
`children`. Esc, overlay and × all go through one `requestClose`, which does not close twice
(`closing` and `data-layer-inactive`); focus before opening is captured in `$effect.pre` and
restored after `tick()`; a focus trap; Esc yields when a layer is in front
(`hasVisibleLayerAbove`). z-index 900, raw `rgba()` shadow and overlay, and the ×'s `aria-label`
is hard-coded Japanese. `escLayering.ts` holds the seven-point layering contract and the
z-index table, reading z-index from computed CSS. admin-template's only modal layer is
CommandPalette.

### Existing rules that constrain the design

- conventions §4 (rules `empty-deps`, `no-cross-package`): packages have empty `dependencies`/
  `peerDependencies` and no cross-package imports. Not even `svelte` is declared (resolution is
  left to the consumer). Today the only bare specifiers imported from `packages/*/src` are
  `svelte` and `svelte/*`.
- conventions §5 (rule `no-app-import`): no `#lib`/`$lib` imports; transports are injected.
- conventions §9 (rule `raw-colors`): no raw colour values in package `<style>` blocks.
- conventions §13 / ADR-0005: packages have no Paraglide and no dictionaries; text comes in via
  layer-1 injection (defaults stay the current Japanese, as with `defaultGridMessages`).
- conventions §14 / ADR-0007: a package with `.svelte.ts` must be in `optimizeDeps.exclude` and
  the external-consumer fixture (rules `optimizedeps-svelte-source`,
  `external-consumer-fixture`). Packages with only `.svelte` and `.ts` are out of scope.
- The sync tripwire in `scripts/scaffold.test.mjs`: a new package must be registered as core,
  asset or excluded, or CI fails. `scripts/check-versions.mjs` picks up `packages/*` by itself.

## Decision

**Create one new package, `packages/ui` (`@banto/ui`), and move components into it in phases 1
to 3. Components receive text, icons, state and actions through props, snippets and callbacks,
and import no app code, stores, `$app/*`, Tauri, other `@banto/*` packages or third-party
packages.** Each phase is below (the phase-1 decision points are settled in
[Owner decisions (2026-10-07)](#owner-decisions-2026-10-07), as are the phase-2 ones; Modal /
Drawer and the layering helpers are not part of phase 2).

### 1. Package shape (phase 1)

- `packages/ui/`: `package.json` (same shape as the other packages: same `version`,
  `files: ["src"]`, `exports` = `{ ".": { "svelte": "./src/index.ts", "default": "./src/index.ts" } }`,
  empty `dependencies`/`peerDependencies`, the same devDependencies as forms), `tsconfig.json`,
  `svelte.config.js`, `vite.config.ts` (`svelte()` + `svelteTesting()`), `README.md`, `src/`,
  `tests/`.
- `src/index.ts` exports the seven components, the types (`StatusBadgeVariant`,
  `UiIconComponent`, `UiMessages`) and `defaultUiMessages` by name. No subpath exports.
- **No `types` condition**: as in the other packages, `svelte`/`default` point at the TS source,
  and consumers' `svelte-check` (including the external-consumer fixture) already resolves types
  that way. Adding a `types` condition should be a separate change across all packages.
- The phase-1 components are `.svelte` and `.ts` only, with no `.svelte.ts`. So the package is
  **not** listed in `optimizeDeps.exclude` (rule `optimizedeps-svelte-source` would flag it as
  extra). When phase 2 adds a `.svelte.ts` (for example a toast store), that same PR lists it in both the
  exclude and the fixture (the rules catch omissions).

### 2. Phase-1 public API

The current props become the public API (admin-template's call sites only change their import
lines). Only two things are added:

- **Icons**: `icon` is typed as `UiIconComponent` (a `Component` that accepts `size?: number`
  and `aria-hidden`). lucide components can be passed as they are. The default icons are the
  SVGs of the seven lucide icons, **vendored** under `src/icons/` (keeping the ISC notice in the
  files), so the look does not change. The vendored icons are not exported (this is not an icon
  set).
- **Text**: `LoadingState`'s `label` defaults to the package's `defaultUiMessages.loading()`
  (`'読み込み中…'`). admin-template passes `label={m['common.loading']()}` at the one call site
  that relied on the default (so English display does not show Japanese). When phase 2 adds more
  text, components take `messages?: UiMessages`, as grid does.

Adding `disabled` and the like to `IconButton` is not part of phase 1 (the public API is fixed in
its current shape; extensions come in a later minor).

### 3. CSS and theme

Each component keeps its CSS in a scoped Svelte `<style>` using only `--banto-*` tokens. No
separate CSS file is shipped. Consumers load `@banto/theme/css` as they do today (without it the
tokens do not resolve); the README says so. Glass works through `--banto-backdrop` as before.

### 4. Dependency direction, core and options

`@banto/ui` is **core** (the shell's Header and Sidebar use it): add a row to template-scope
§2.1 and add it to `CORE` in `scripts/scaffold.test.mjs`. It imports no other `@banto/*`, so a
core → option dependency cannot arise.

### 5. Machine checks, distribution, scaffold and external use

- The existing rules (`no-cross-package`, `no-app-import`, `raw-colors`, `empty-deps`,
  `docs-package-refs`) walk `packages/`, so they apply to the new package unchanged.
- **Add one rule** (it meets ADR-0008's three conditions; record it in that ledger): bare import
  specifiers in `packages/*/src` are limited to `svelte` and `svelte/*`. Because dependencies
  cannot be declared (`empty-deps`), importing `@lucide/svelte` or similar works in the monorepo
  (admin-template's dependency is visible through hoisting) and breaks only in derived apps that
  lack it (banto-industrial has no lucide). No allowlist is needed (zero violations today). The
  idea of adding `$app/` and `@tauri-apps/` to `no-app-import` is covered by the same rule.
- `check-versions.mjs` needs no change (it picks up `packages/*`). Update publishing.md's install
  examples and package list, and the list of "packages with `.svelte.ts`" in conventions §14
  (stating that phase 1 is out of scope).
- External-consumer fixture: not required by the rule (no `.svelte.ts`), but add `@banto/ui` to
  its dependencies and to the `+page.svelte` imports (not to the exclude) to confirm that the Git
  dependency with `path:packages/ui` installs and passes `svelte-check` and `vite build`. This
  goes into the **phase-1 PR**: the workflow `.github/workflows/external-consumer.yml` rewrites
  the fixture refs to the PR head SHA before install, so the Git-subdirectory package,
  `svelte-check` and the Vite build are verified before the tag is published. Only the committed
  ref update to the new tag remains for the post-tag PR (the "bump the fixture ref after
  tagging" step in publishing.md).
  The fixture lockfile is resolved in that same ref bump, to a tag that contains `@banto/ui`.
- Because this ADR names `@banto/ui`, it goes into `DOCS_PACKAGE_REF_ALLOWLIST` in
  `verify-architecture.mjs` with a reason until phase 1. Remove it once the package exists.

### 6. Tests and visual checks

- `packages/ui/tests/` gets a jsdom test per component (`@testing-library/svelte`): `IconButton`'s
  `aria-label`/`title`, `StatusBadge` rendering an icon for every variant, `LoadingState`'s
  `role="status"` with default and given text, `ErrorState`'s `role="alert"`, snippet rendering.
- DOM and CSS do not change, so `e2e/visual` (visual regression) and a11y (axe) results are
  expected to stay the same. Svelte's scoping class hashes change, but the pixels do not. The
  phase-1 PR confirms that visual regression passes; if a difference shows up, fix the cause
  instead of updating baselines.
- **One lightweight demo page** (owner decision 7): admin-template gets a page that lays out the
  main states of the seven components, shown in the nav only in demo mode (the normal nav does
  not change, so existing baselines do not move). No UI-catalogue infrastructure. The page is added
  to the visual regression suite (new baselines). Reasons: #220 completion criterion 3, existing
  pages exercise only some states, and it is also used to check phase 2's interactive components.
  The package README also documents the props with minimal examples.

### 7. Versioning and compatibility

Phase 1 is **additive only** (a new package and changed import lines in admin-template) and does
not change any existing `@banto/*` public API: a SemVer minor. v6.0.0 was published on
2026-10-07, so phase 1 ships in **v6.1.0** (owner decision 5). Version and tag are shared with the other packages (publishing.md). Copies of
`components/ui/` that derived apps took from admin-template keep working (migration is optional;
upgrading.md gets the steps).

### 8. Phase-2 reconciliation (settled by the owner on 2026-10-07)

- **Menu components**: move as is. Callers already pass `label`. Keep relying on the `popover`
  API (decision 12). Whether banto-hub's `TreeContextMenu` moves onto `Menu` is decided in phase 3
  (decided on 2026-10-08: it does not; see §9).
- **CommandPalette**: the package holds only the **presentation and interaction** component. It
  receives the command list, a search function, execution, a close request and text (`items`,
  `search(query) => items`, `onExecute(item)`, `onClose()`, `messages`) and does not import
  admin-core (its types match `PaletteCommand` structurally). Session scoping (#258), recording
  recent commands, the `Ctrl+K` wiring and failure notifications stay in the app. banto-hub's
  **focus trap, focus return and window-level Esc** become standard behaviour. The look follows
  admin-template's current one (tokens, motion, `--banto-surface-hover` selected row) (decision 8).
- **ToastHost**: the package holds `ToastHost` (a presentation component taking `store` and
  `messages`) together with **`createToastStore()`** (runes `.svelte.ts`: `toasts`,
  `push`, `dismiss`, auto-dismiss time). banto-hub's **action button**
  (`action?: { label, onAction }`, renamed from `onClick` in 2c) is standard and the look follows admin-template's current one.
  The app keeps only the wiring from admin-core's `notify` (Notifier) to the store (for example
  admin-template's `setup.ts`: `notify: (kind, message) => toastStore.push(kind, message)`)
  (decision 9). Reason: the three stores (admin-template 31 lines, ChronoGazer 31, banto-hub 66) are
  near-identical and differ only by the action button; keeping three copies is exactly the
  duplication #220 removes, and the cost is one `optimizeDeps.exclude` entry per consumer, which
  the existing machine checks already enforce.
  **Consequence**: because `@banto/ui` then contains a `.svelte.ts`, the PR that adds the store
  must, in that same PR, add `@banto/ui` to `optimizeDeps.exclude` (admin-template's vite config,
  scaffold, rule `optimizedeps-svelte-source`, conventions §14's list) and to the external-consumer
  fixture's usage (ADR-0007, #478).
- **Modal / Drawer and the layering helpers** (focusTrap, focusRestore, escLayering,
  drawerCloseGuard): **not part of phase 2**. They wait for phase 3 or until banto-industrial
  needs them. Owner note: "後ほど banto 側に入れるかもしれないが、その時はその時で" (may be brought
  into banto later; decide then) (decision 10). If they go in, banto-hub's contracts
  (`onRequestClose`, `dirty`/`onBlockedClose`, `focusFallback`, no double close, the layering
  contract) come over in full, with z-index and the overlay background taken from tokens.
- **Theme**: the overlay background (`rgba(0, 0, 0, 0.35)` in all three variants) trips rule
  `raw-colors`, so add the token `--banto-scrim` to `@banto/theme` (the current value,
  `rgb(0 0 0 / 0.35)`, shared by light, dark and glass). z-index becomes layer tokens:
  `--banto-z-header` (100), `--banto-z-sidebar-scrim` (850), `--banto-z-sidebar` (900),
  `--banto-z-modal` (900, reserved for phase 3's Modal / Drawer), `--banto-z-overlay` (1000,
  CommandPalette) and `--banto-z-toast` (1000). Values equal today's literals, so neither the look
  nor the stacking order changes (decision 11). Shadows move to the existing `--banto-shadow-lg`.

Phase-2 progress:

| Step | Content                                                                                       | Status      |
| ---- | --------------------------------------------------------------------------------------------- | ----------- |
| 2a   | Theme tokens (`--banto-scrim`, `--banto-z-*`) + menu components (`Menu` and four more)        | Done (#361) |
| 2b   | CommandPalette (presentation and interaction)                                                 | Done (#363) |
| 2c   | ToastHost + `createToastStore()` (with the action button; exclude and fixture in the same PR) | Done (#364) |

With 2c, phase 2 is complete (Modal / Drawer and the layering helpers stay in phase 3 or later per
decision 10).

The 2b public API (decision 8 made concrete): `CommandPalette` takes `open` (bindable), `items`,
`search?(query, items)` (default `defaultCommandPaletteSearch`: substring match on `title` and
`keywords`, order as given), `recentIds?` (shown first under a "recent" heading for an empty
query; the app keeps the record), `onExecute(item)` (a returned promise disables the rows until
it settles, then the palette closes), `onClose?(reason)` (`'escape' | 'outside' | 'execute'`),
`focusFallback?` and `messages?` (the `commandPalette*` keys of `UiMessages`). The item type
`CommandPaletteItem` (`id`, `title`, `group?`, `keywords?`, `icon?`, `disabled?`, `shortcut?`)
matches `PaletteCommand` structurally, so admin-core's array can be passed as is. The focus trap,
focus return and window-level Esc (yielding to an Esc already consumed and to a layer above) live
in a package-internal helper (`overlayFocus.ts`, not exported) that reads banto-hub's layer markers
(`role="dialog"`, `role="menu"`, `data-esc-layer`, `data-layer-inactive`) as they are. Layers with
equal z-index are ordered by document order (the CSS paint order). Exporting layer helpers for
Modal / Drawer remains phase 3 (decision 10).

The 2c public API (decision 9 made concrete): `createToastStore(options?)` (`autoDismissMs`,
default 4000; `maxToasts`, default unlimited, dismissing the oldest when exceeded) returns a
`ToastStore` with `toasts`, `push(kind, message, options?)` and `dismiss(id)`. `push` returns the
id; `options` are `action?: { label, onAction }`, `durationMs?` (`0`, negative or `Infinity`
never auto-dismiss) and `id?` (an id that is already shown replaces that toast in place and
restarts its timer). `kind` is `'success' | 'error' | 'info' | 'warning'` (structurally admin-core's
`NotificationKind`). An action dismisses the toast after the caller's handler (even when it
throws) and never runs twice. `ToastHost` takes `store` and `messages?` (`toastClose`) and
announces through two persistent live regions (`error` and `warning` in `role="alert"`, `success`
and `info` in `role="status"`). Placement is the CSS custom properties `--banto-toast-right` and
`--banto-toast-bottom` (default `1rem`). The three copies were reconciled as follows: look from
admin-template (tint per kind, slide-in from the right, glass, `:focus-visible`, the
`--banto-z-toast` token), the action from banto-hub (including `data-testid="toast-action-<id>"`;
the button is outlined in the toast's own text colour so it reads on every tint), text through
`UiMessages.toastClose`, and admin-template's 4000 ms auto-dismiss. When banto-hub and chronogazer
migrate (phase 3), note `onClick` → `onAction` and ids changing from numbers to strings.

### 9. Phase 3

banto-industrial upgrades to a tag that contains `@banto/ui` (v6.0.0's #344 migration is
also needed) and replaces CommandPalette and ToastHost (both apps) and, if phase 2 included them,
Modal, Drawer and the layering helpers (banto-hub). Whether banto-hub's `TreeContextMenu` moves to
`Menu` is decided separately in phase 3. The replacements are confirmed by banto-industrial's E2E
(accidental drawer close, Esc layering, and so on).

Outcome (2026-10-08):

- banto-industrial #522 upgraded to v6.2.0 and replaced CommandPalette, ToastHost and the toast
  store in both apps with `@banto/ui`. The command list, search, recent history and the `Ctrl+K`
  wiring stay in the apps. banto-hub's layering contract (#381) and the palette's `overlayFocus.ts`
  share the layer markers and z-index, so they compose without workarounds (banto-hub's E2E covers
  closing one layer per Esc, the focus trap and focus restore).
- **`TreeContextMenu` does not move to `Menu`** (owner decision, 2026-10-08). `Menu` is a dropdown
  attached to a trigger (`popover` API), while `TreeContextMenu` is a context menu placed at the
  right-click coordinates (with `aria-disabled` items and hooks into banto-hub's Esc layering).
  Moving it would mean adding coordinate placement to `Menu`, which is not worth it.
- Modal / Drawer and the layering helpers stay deferred per decision 10. If something other than
  banto-industrial needs them, open a new issue. -> Added as phase 4 on 2026-10-11 (§10).

### 10. Phase 4: Modal / Drawer and the layering helpers (owner decision, 2026-10-11)

Owner decision (2026-10-11): move banto-hub's `Modal`, `Drawer` and layering helpers
(`escLayering.ts`, `focusTrap.ts`, `focusRestore.ts`, `drawerCloseGuard.ts`) into `@banto/ui` so
both banto-industrial apps (banto-hub, and ChronoGazer, which now has a copy) can share them
(revising decision 10).

- **Components**: `Modal` (centred, fade + scale, default 560px) and `Drawer` (right edge, full
  height, fade + slide, default 480px) are public. Both are thin wrappers around one internal
  `OverlayPanel.svelte`; only placement and motion differ (banto-hub kept two copies edited in
  lockstep). The props are banto-hub's (`open`, `title`, `width`, `closeOnOverlayClick`,
  `onclose`, `onRequestClose`, `dirty`, `onBlockedClose`, `focusFallback`, `children`; type
  `OverlayProps`); the only addition is `messages` (`UiMessages.overlayClose`, the ×'s name,
  default `'閉じる'`). The parent owns `open` (the component never writes it). The contract is
  unchanged: Esc, the scrim and × go through one `requestClose`; `onRequestClose` can veto; while
  `dirty`, Esc and the scrim do not close and report `onBlockedClose` (× still goes through); no
  double close; `data-layer-inactive` from the moment the close is decided; focus to the first
  focusable on open; focus trap; focus back to the opener after `tick()` (else `focusFallback`).
  banto-hub's `Drawer` has no non-modal mode (#375's tag-edit right pane is a page-level split
  view), so neither does this one. On narrow screens (#378) the width stays within the viewport
  width minus 2rem.
- **Look**: z-index `--banto-z-modal`, scrim `--banto-scrim`, surface `--banto-surface-overlay`
  (as CommandPalette; glass's `--banto-backdrop` applies), shadow `--banto-shadow-lg`, the × is an
  `IconButton` with a vendored lucide X. No raw `rgba()` is left. Motion is CSS instead of Svelte
  `transition:` (as Menu, ToastHost and CommandPalette), with durations and easing from the theme's
  `--banto-duration-fast`, `--banto-duration-base` and `--banto-ease-out` (0ms under
  `prefers-reduced-motion`). The entry uses `@starting-style`; on exit the layer stays mounted for
  `--banto-duration-base` (with `data-layer-inactive` and `inert` - without `inert`, Tab and Enter
  reach the fading layer). The resting state is `transform: none` (even `translateX(0)` /
  `scale(1)` makes the panel the containing block of fixed descendants, confining a `Modal` in a
  `Drawer` in every theme). Distances (48px, 0.96) live in the
  component CSS like the other components'. No new tokens.
- **The backdrop click also yields to a layer above** (#389 review): when the `Drawer` panel becomes
  the containing block of fixed descendants (at review time because of the resting `translateX(0)`,
  fixed with `transform: none`; an app's `transform` / `filter` on it, or an engine treating
  `backdrop-filter` that way, can still cause it), a nested `Modal`'s backdrop covers only the
  `Drawer`. A click beside it lands on the `Drawer`'s own backdrop
  and used to close the `Drawer` with the `Modal`, skipping the `Modal`'s `dirty` / `onRequestClose`.
  The backdrop click now yields through the same `hasVisibleLayerAbove` as Esc. Moving the child's
  overlay to `<body>` (a portal) was not chosen: Svelte 5 has no built-in portal, and moving the DOM
  would break the "nested layer with its own z-index is above" check and the focus trap's
  `contains`, and change CSS inheritance for callers. The visual extent stays, but the closing path
  is closed.
- **Closed means `open` is false**: with no `onclose`, or a parent that keeps `open` true, the layer
  stays fully usable and keeps counting in the layer checks (banto-hub marked it inactive as soon as
  the close was requested, which left a visible layer that ignored itself). No double close is kept
  by blocking re-entry within the same tick and any action after `open` became false.
- **One layering module** (`layering.ts`): phase 2b's package-internal `overlayFocus.ts` for the
  palette and banto-hub's four files are merged into one, used by `CommandPalette`, `Modal` and
  `Drawer` alike (no two parallel mechanisms). It is public so an app's own layers (a retreating
  tree, a context menu, a page-level Esc) can use it: `hasVisibleLayerAbove`,
  `hasVisibleMenuLayer`, `attachFocusTrap`, `focusablesIn`, `restoreFocus`, `canRestoreFocusTo`,
  `effectiveZIndex`, `isCloseAllowed`, `LAYER_SELECTOR`, `MENU_LAYER_SELECTOR`,
  `LAYER_MARKER_ATTR`, `LAYER_INACTIVE_ATTR`, `FOCUSABLE_SELECTOR`. Names and shapes follow
  banto-hub (only `LAYER_ABOVE_SELECTOR` became `LAYER_SELECTOR`). The seven layer promises moved
  into the file's header doc.
- **Reconciling the two checks** (the union, kept within what changes neither side's results):
  - "Above": a higher z (banto-hub), plus at equal z the later one in document order (palette), an
    open popover (palette), and a layer **inside** `except` with its own z-index (new: a `Modal`
    placed in a `Drawer`'s body, a popup inside a dialog). A nested layer without its own z-index
    is part of `except`. banto-hub never shows two equal-z layers at once
    (`blockedByOtherResourceDrawer`), so the equal-z rule does not change its results (a pair that
    used to deadlock now closes the later one first).
  - "Not there": `data-layer-inactive` (self or ancestor), inside `inert`, no client rects,
    `display: none`, `visibility: hidden`. banto-hub checked rects and the palette checked `inert`
    and ancestor markers, so both are checked. For the palette the only difference is that a layer
    that is not laid out no longer counts as above.
  - Focus trap: the panel's `keydown` leaves a Tab already handled by a nested layer
    (`defaultPrevented`) alone, so a `Modal` inside a `Drawer` does not wrap twice. It never
    happens for the palette.
  - `restoreFocus(target, fallback)`: an element returned by `fallback` gets the same check and is
    focused; a `fallback` that returns nothing may move focus itself (accepting both the palette's
    and banto-hub's call shapes).
- **Tests**: `packages/ui/tests/layering.test.ts` (the stack, equal z, nesting, layers that are
  not there, the trap, restore-target selection, banto-hub's `drawerCloseGuard.test.ts` ported) and
  `overlay.test.ts` (the three close routes, veto, `dirty`, no double close, Esc one layer at a time
  through a `Modal` in a `Drawer` and a `CommandPalette` over it, trap, restore). The
  `CommandPalette` tests pass unchanged. The `/ui-demo` page gains `Modal` and `Drawer`, and
  `e2e/visual/ui-overlays.spec.ts` checks the layering in a real browser plus axe on the open
  layers. The closed demo page gains one card, so the `ui-demo` baselines are regenerated with
  visual-baselines.yml.
- **Version**: additive (minor). `@banto/ui` has been under `optimizeDeps.exclude` since phase 2c,
  so derived apps' config does not change. banto-industrial's migration is mostly an import swap
  with the same props (`LAYER_ABOVE_SELECTOR` -> `LAYER_SELECTOR`, `DrawerCloseSource` ->
  `OverlayCloseSource`).

### 11. Phase 5: LauncherBar (owner decision, 2026-10-20)

Owner decision (2026-10-20, all of D1-D6 in [nav-launcher-plan.md](../design/nav-launcher-plan.md) §9
as option a): the navigation can also be shown as a dock-like launcher instead of the sidebar. Its
presentation and interaction live in `@banto/ui` as `LauncherBar`; the wiring stays in the app
(D2-a). No new ADR - this extends the placement decision, so it is recorded here.

- **In the package**: `LauncherBar.svelte` (presentation and interaction only) and `launcher.ts`
  (types `LauncherPosition`, `LauncherItem`, `LauncherGroup` and the pure `magnifyScale`). Props:
  `groups` (`{ id, ariaLabel, items }[]`), `position` (default `'bottom'`), `magnify` (default
  `true`), `ariaLabel`. One `<nav aria-label>` per group with a rule between groups, plain
  `<a href>` with `aria-current="page"`, a visually hidden real-text name (label + badge label),
  magnification (mouse `pointermove` throttled with `requestAnimationFrame`, changing the item
  size; off under reduced motion, `(hover: none)`, <=900px and for non-mouse pointers), a tooltip
  (`aria-hidden`, hoverable, Esc handled on `window` only while shown, yielding to
  `hasVisibleLayerAbove()` and never consuming the event) and the <=900px tab bar. All text comes
  through props, so `UiMessages` does not grow.
- **In the app**: the nav definition (`navigation.ts`), role and public-viewer filtering, the
  active-page check, badge counts, the dictionary (Paraglide), the setting (sidebar or launcher),
  the shell's bottom reserve and the toast position. In admin-template a ~50-line
  `ShellLauncher.svelte` only passes props to `@banto/ui` (plan PR-3).
- **Why**: (1) no growth of the copied surface - the ~250 lines of magnification, tooltip, Esc and
  a11y are not copied into derived apps and fixes propagate (this ADR's motivation). (2) Both
  banto-industrial apps keep their own `Sidebar.svelte` and can use the same component. (3) The
  component does not know the nav definition (`NavItem`); it is a generic "row of links"
  (conventions §5, rule `package-bare-imports`; callers pass lucide components as icons).
- **No `.svelte.ts`**: state is `$state` inside the `.svelte` file. `@banto/ui` is already under
  `optimizeDeps.exclude` since phase 2c, so it would do no harm, but it would add to what
  conventions §14 keeps in sync.
- **The sidebar does not move**: a large move with no behaviour change, with a big impact on the
  baselines and banto-industrial. Planned as a separate phase if needed.
- **Position**: the `position` prop existed from the start with `'bottom'` only. Left / right
  (plan D4, PR-4) were added as `LauncherPosition = 'bottom' | 'left' | 'right'` without breaking
  existing callers: a vertical bar centred on that screen edge, magnifying along the vertical axis,
  with the tooltips beside the items on the page side. At <=900px every position is the bottom tab
  bar (D5). Top (`'top'`, plan PR-6) was added on 2026-10-21: the bottom bar mirrored, magnifying
  downwards with the tooltips below. To sit below the header, the component is pushed down by the
  token `--banto-shell-launcher-inset-top` (default `0px`), which the shell - the one that knows its
  header's height - sets (the component does not know the header).
- **Theme**: sizes, the magnification ratio and the stacking order are new tokens
  `--banto-shell-launcher-*` (`item-size`, `magnify-max`, `gap`, `padding`, `offset`, `reserve`)
  and `--banto-z-launcher` (200). `--banto-dock-*` belongs to `@banto/dock-svelte` and is not used
  (the name is `launcher` throughout, plan D1). Colours use existing tokens only. The component
  reads the ratio with `getComputedStyle` and does not magnify if it cannot.
- **Tests**: `packages/ui/tests/launcher.test.ts` (the curve) and `LauncherBar.test.ts`
  (landmarks, names, `aria-current`, separators, the tooltip's `aria-hidden` and Esc, yielding to
  layers, the magnification wiring). The `/ui-demo` card was dropped (a fixed bar would float over
  the demo page and force regenerating the `ui-demo` baselines); the real-browser look and axe
  come with the shell wiring's visual tests (plan PR-3).
- **Version**: additive (minor).

## Alternatives considered

- **Option A (adopted): one `@banto/ui`, filled in phases, with injection.** Pros: the existing
  distribution (Git tag + subdirectory), version check and machine checks work as they are; it
  starts small and grows with demand. Cons: one more package, and more sync points across
  scaffold, the fixture and docs.
- **Option B (rejected): put them in `@banto/admin-core`.** admin-core is headless (it has no
  `.svelte` components); mixing presentation components in breaks its responsibility.
- **Option C (rejected): several packages per group (status, menu, overlay).** Each package needs
  its own version, scaffold, fixture and docs sync, which does not pay off for small components.
  Split the overlay group later if it grows large.
- **Option D (rejected): make lucide a `peerDependencies` entry.** It is an exception to
  conventions §4's "empty dependencies" (needing an ADR) and forces derived apps without lucide
  (banto-industrial) to add it. Vendoring seven icons is a few dozen lines and, by ADR-0002's
  criteria, cheaper.
- **Option E (rejected): no default icons, `icon` required.** More code at each call site, and
  every call would have to recreate `StatusBadge`'s "not colour alone" default (an icon per
  variant).
- **Option F (rejected): keep copying and ask for sync through docs.** There are already three
  variants (see the inventory); the sync has not held.
- **Option G (out of scope): a separate repository, registry publishing, independent
  versioning.** Issue #220's re-evaluation conditions (owner, audience or release cycle becoming
  independent of the base) are not met. ADR-0011 stays.

## Consequences

- `@banto/ui` components import no app code, stores, `$app/*`, Tauri, other `@banto/*` packages
  or third-party packages (checked by a rule). Text is injected with defaults, icons are vendored
  defaults replaceable through `icon`, and colours and sizes come only from tokens.
- Changing a component's props is a change to a `@banto/*` public API and follows SemVer and the
  CHANGELOG's "notes for consumers" (publishing.md).
- Vendored lucide icons keep their source version and ISC notice in the files. They do not track
  lucide's visual updates (replace them if needed).
- Adding the toast store (`.svelte.ts`) in phase 2c brings `@banto/ui` under
  `optimizeDeps.exclude` and the external-consumer fixture (existing rules catch omissions; added
  in the same PR).
- The phase-1 PR deletes admin-template's `components/ui/`. Copies in derived apps keep working,
  so migration is optional; upgrading.md gets the steps.

## Owner decisions (2026-10-07)

The phase-1 decision points (1 to 7 below) are settled as follows. The phase-2 decision points
(8 to 12) were settled the same day.

1. **Name and standing**: `packages/ui` / `@banto/ui` as core (scaffold leaves it alone): adopted.
2. **Default icons**: (a) vendor the seven lucide icons with their ISC notice.
3. **`LoadingState`'s default text**: (a) package default, and admin-template passes it
   explicitly everywhere.
4. **Public API**: freeze at the current props.
5. **Version**: v6.1.0 (v6.0.0 was published on 2026-10-07, so phase 1 ships in v6.1.0).
6. **Machine check**: add the rule restricting bare imports (comments excluded from the check).
7. **Showcase**: one lightweight demo page (admin-template lays out the main states of the seven
   components; shown in the nav only in demo mode; no UI-catalogue infrastructure; added to
   visual regression. Reasons: #220 completion criterion 3, existing pages show only some states,
   and it is also used to check phase 2's interactive components).

Phase-2 decision points (added 2026-10-07):

8. **CommandPalette**: the package holds presentation and interaction only. Session scoping,
   recent items, the `Ctrl+K` wiring and notifications stay in the app. banto-hub's focus trap,
   focus return and window-level Esc become standard behaviour. The selected-row look follows
   admin-template.
9. **ToastHost**: banto-hub's action button (for example "undo") becomes standard. **The store is
   shared too**: `@banto/ui` bundles `createToastStore()` (runes `.svelte.ts`) with `ToastHost`
   (changed from the initial "store stays in the app" on the same day). The app keeps only the
   wiring from `notify` to the store. Because a `.svelte.ts` comes in, the same PR adds the package
   to `optimizeDeps.exclude` and the external-consumer fixture.
10. **Modal / Drawer and the layering helpers**: not part of phase 2; deferred to phase 3 or to
    when banto-industrial needs them (owner note: "後ほど banto 側に入れるかもしれないが、その時は
    その時で"). -> Owner decision 2026-10-11: added as phase 4 (shared by banto-hub and ChronoGazer, §10).
11. **Theme tokens**: the overlay scrim and the z-index layers become theme tokens.
12. **Menu**: keep the `popover` API assumption. Whether banto-hub's `TreeContextMenu` aligns
    with `Menu` is decided in phase 3. -> Phase 3 (owner decision, 2026-10-08): it does **not** (§9).

## Owner decision points

Points 1 to 7 and 8 to 12 are settled in the owner decisions above (kept for history).

Before phase 1:

1. **Name and standing**: `packages/ui` / `@banto/ui` as core (scaffold leaves it alone)?
2. **Default icons**: (a) vendor the seven lucide icons (recommended; no visual change) / (b) no
   default (`icon` required) / (c) lucide as `peerDependencies` (a §4 exception, needing its own
   ADR).
3. **`LoadingState`'s default text**: (a) package default `'読み込み中…'` and admin-template passes
   it explicitly everywhere (recommended) / (b) make `label` required.
4. **Freeze the public API at the current props?** (`disabled` on `IconButton` and the like in a
   later minor.)
5. **Version**: v6.1.0 (v6.0.0 was published on 2026-10-07, so phase 1 ships in v6.1.0 or the
   next available minor).
6. **New machine check**: add the rule limiting packages' bare imports to `svelte` and `svelte/*`
   (+ `$app/`, `@tauri-apps/`)? (Recorded in ADR-0008's ledger.)
7. **Showcase**: no new demo page; are the existing pages plus the package README enough?
   -> Decided: one lightweight demo page.

Before phase 2 (settled; see decisions 8 to 12 in the owner decisions):

8. **CommandPalette**: keep only presentation and interaction in the package, leaving session
   scoping, recent-command recording, `Ctrl+K` and notifications in the app? Make banto-hub's
   focus trap, focus return and window-level Esc standard? Follow admin-template's selected-row
   look and drop banto-hub's primary tint and glass gradient (or make them an option)?
   -> Decided: as recommended (drop them).
9. **ToastHost**: make banto-hub's action button standard? Ship the store (`.svelte.ts` → exclude
   and fixture obligations) or keep it in the app?
   -> Decided: action button standard; the store is bundled in `@banto/ui` too (exclude and fixture in the same PR).
10. **Modal / Drawer and the layering helpers**: include them in phase 2 (admin-template has no
    page that uses them), or leave them to phase 3 as banto-industrial's need? If included, bring
    all of banto-hub's contracts as options, or drop some?
    -> Decided: not in phase 2 (phase 3 or when needed).
    -> Owner decision 2026-10-11: added as phase 4 (§10).
11. **Theme tokens**: make the overlay background (`--banto-scrim` or similar) and the z-index
    layers (1000 / 900 and so on) tokens?
    -> Decided: make them tokens.
12. **Menu**: keep relying on the `popover` API (including Tauri's WebView2 / WebKitGTK)? Move
    banto-hub's `TreeContextMenu` to `Menu` in phase 3?
    -> Decided: keep `popover`; the `TreeContextMenu` alignment is phase 3.
    -> Phase 3 (owner decision, 2026-10-08): `TreeContextMenu` does not move to `Menu` (different
    shape; §9).
