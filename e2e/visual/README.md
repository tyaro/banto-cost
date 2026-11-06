# Visual regression + axe-core (`visual` Playwright project)

Phase 0 of `docs/design/visual-refresh-plan.md` / §12 of
`docs/design/visual-refresh-design.md`. Separate from the `chromium` (M18 smoke)
project in `e2e/playwright.config.ts` - different `testDir`, different
`webServer` (plain `vite preview` in browser demo mode, not `banto-serve`),
never runs together with smoke.

## What's here

- `theme.ts` - shared helpers: the light/dark × standard/glass matrix and
  `primeTheme`/`primeThemeAndAuth`, which inject `localStorage`/
  `sessionStorage` via `addInitScript` before first paint (same keys
  `app.html`'s FOUC script and `setup.ts`'s demo `AuthProvider` read).
- `visual.spec.ts` - `expect(page).toHaveScreenshot()` baselines for login,
  dashboard, items, users, settings, and the command palette.
- `a11y.spec.ts` - `@axe-core/playwright` scans (`wcag2a`/`wcag2aa`) of
  dashboard, items, settings, and login.
- `settings-controls.spec.ts` - checks fixed upper labels against selected and typed
  values, empty/error states, and a narrow English layout.
- `ui-overlays.spec.ts` - `@banto/ui` Modal / Drawer on `/ui-demo`: the Esc /
  focus layering in a real browser (dirty guard, a Modal stacked in a Drawer,
  focus restore) and axe scans of the open layers (ADR-0018 §10).

## Running

```sh
# Build the static admin-template first - the `visual` project's webServer
# is `vite preview`, which serves apps/admin-template/build/.
pnpm --filter admin-template build

pnpm e2e:visual
```

`pnpm e2e` (the M18 smoke suite) never runs these specs - it's pinned to
`--project=chromium`. Conversely `pnpm e2e:visual` is pinned to
`--project=visual` and never runs `e2e/tests/smoke.spec.ts`.

## Updating baselines

After an intentional visual change, regenerate the baselines and review the
diff like any other source change:

```sh
pnpm --filter admin-template build
pnpm e2e:visual --update-snapshots=all
```

Re-run `pnpm e2e:visual` (without `--update-snapshots`) afterwards to
confirm the new baselines actually pass.

**Always `=all`, never the bare `--update-snapshots`.** The bare form is
Playwright's `changed` mode, which rewrites only the snapshots that
FAILED - so a real change small enough to fit under the tolerance below
keeps its old baseline, and that staleness accumulates silently until a
later run trips over it as a mystery diff. `=all` regenerates every
baseline from the current build.

**The tolerance is absolute: `maxDiffPixels: 250`** (`e2e/playwright.config.ts`).
It was a ratio (`maxDiffPixelRatio: 0.001`) until 2026-09, which meant a
tall page bought a proportionally larger blind spot - the 1440x3255
dashboard tolerated ~4,700 differing pixels, the 1440x900 items page
~1,300. The 2026-09 header status chips measured only a few hundred
differing pixels and slipped past every page, leaving the baselines
stale. A flat 250 sits under that floor, so a chip/badge-sized change is
caught on every page regardless of its height (verified: restoring a
pre-chip dashboard baseline now fails with "514 pixels are different",
where the old ratio passed it).

What this means in practice: **a Playwright/Chromium/runner-image bump
that shifts rendering will turn this suite red.** That is intended, not a
flake - review the diff, then regenerate the baselines with the workflow
below. Re-rendering the same build twice in one environment differs by
exactly 0 pixels, so a red run always means something actually changed.

**Baseline images are OS-specific.** Playwright appends the platform to
each snapshot's filename (e.g. `...-linux.png`). This repo's baselines were
generated on Linux; running `--update-snapshots` on macOS or Windows adds
`-darwin`/`-win32` files alongside them rather than replacing them. Generate
baselines on Linux (matches CI) unless you specifically need another
platform's set.

Without a Linux box, dispatch `.github/workflows/visual-baselines.yml` on the
branch carrying the visual change: it regenerates the `-linux` baselines on
the same `ubuntu-latest` image CI uses, re-runs the suite against them to
prove they pass, and uploads them as an artifact. Dispatch it again with
`commit: true` to push the regenerated PNGs back to that branch.

One more step after `commit: true`: the workflow pushes with the built-in
`GITHUB_TOKEN`, so `ci.yml` does not start on the baseline commit by itself.
It is **parked, not missing** — GitHub still creates the `pull_request` run
for that commit but leaves it awaiting approval (`action_required`, zero
jobs, no checks on the PR head). Start it from the run's page in the Actions
tab (Approve / Re-run all jobs) or from the CLI:

```sh
gh run rerun <run-id>   # the action_required CI run on the baseline commit
```

An empty commit also works and is what this file used to recommend, but it
is not needed — the run is already there, waiting. (Verified 2026-09-01 on
PRs #182/#183: both baseline commits produced an `action_required` CI run
with zero jobs; re-running #183's started it and it went green.)

## Notes

- Theme/preset are forced explicitly (`light`/`dark`, `standard`/`glass`) -
  never `system` - so screenshots never depend on the runner's OS color
  scheme. Density is always `standard`.
- Auth is bypassed via the same `sessionStorage` flag the demo
  `AuthProvider` sets on a real login (`banto.auth.demo`), not a UI login
  flow - faster and avoids adding an unrelated source of flakiness to pixel
  comparisons.
- No `waitForLoadState('networkidle')`: browser demo mode has no backend
  round trips (no SSE, no REST) to go idle on. Each test waits for a
  concrete visible element instead, plus a short fixed settle for chart/dock
  layout math (animations are already zeroed by `reducedMotion: 'reduce'`).
- The dock's default layout (docked monthly/priceBuckets panels + floating
  memo panel) is what a fresh `localStorage` always produces - these tests
  never touch a pre-existing dock layout.
