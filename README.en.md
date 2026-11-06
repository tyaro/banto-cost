# Banto

> This is an abridged English summary; the Japanese [README.md](README.md) is
> canonical and much more complete.

**Live demo**: <https://tyaro.github.io/banto/> (log in as `admin` / `admin` —
a browser-only demo with in-memory data).

**Banto is a template for building line-of-business apps that start on a
single PC and can later be shared to browsers on the LAN.** It ships the
common parts of such apps (data lists, input forms, auth, role-based access,
audit log); you copy the template and adapt the bundled sample to your own
business. Technically it is a full-stack admin framework/template for
**Tauri v2 + SvelteKit** (Svelte 5 runes). It pairs a refine-like headless core with a custom data
grid, schema-driven forms, charts, and a docking layout. The backend is Rust
(axum + sqlx; SQLite by default, PostgreSQL supported). It runs as a desktop
app, and — via an embedded web
server — can serve the same UI to browsers on the local network. The name
comes from _banto_, the senior clerk who ran an Edo-period merchant house on
the owner's behalf.

Architecture overview (Japanese, Mermaid diagrams):
[docs/architecture-overview.md](docs/architecture-overview.md) /
[docs/architecture-flows.md](docs/architecture-flows.md).

## Features

- **Data grid** (`@banto/grid-svelte`): virtual scrolling, multi-column sort,
  column filters, column resize/reorder, **column show/hide** (the
  `ColumnsMenu` manager UI plus `GridColumn.hidden` for columns that start
  hidden), Excel-like cell editing, range selection, copy & paste, client
  and server modes, grouping with aggregation. Columns can be
  **auto-derived from a form schema** (`columnsFromSchema`, M23, validation
  included — write one schema and get both the list view and the form; the
  grid's column order is set with `order`, independent of the form's field
  order).
- **Schema-driven forms** (`@banto/forms`): input UI, validation, and state
  management generated from a definition object.
- **Charts** (`@banto/charts`): dependency-free SVG charts, 14 types in
  total — line/area, bar (incl. stacked), pie/donut, scatter, sparkline,
  combo (bar + line), radar, heatmap, gauge, SPC charts (histogram, Pareto,
  box plot), stacked area, and Gantt.
- **Docking layout** (`@banto/dock-svelte`): floating windows, split/tab
  panes, drag-to-rearrange with snapping, layout persisted as JSON.
- **Refine-like headless core** (`@banto/admin-core`): resource definitions,
  `DataProvider`/`AuthProvider` abstractions, `createListResource`/
  `createFormResource` composables. Defaults to Tauri `invoke()` (local
  Rust), swappable for InMemory or HTTP.
- **Embedded web server** (`banto-server`): opt-in; once enabled, other
  devices on the same LAN can use the same admin UI in a browser over
  REST + SSE. Ships a web manifest + icons so the browser build is an
  **installable PWA** ("Add to Home Screen"), though — since browsers only
  offer install over a secure context — that requires HTTPS/localhost or a
  TLS reverse proxy, not the default plain-HTTP LAN. No service worker
  (no offline mode).
- **Auth, RBAC, and user management**: argon2id credential store with
  first-run setup, three roles (admin/editor/viewer), a user management
  screen, and identical permission checks across both the REST and Tauri
  paths.
- **Audit log**, a settings framework (`SettingsProvider`), and an
  auto-login / no-login mode. The desktop first-run screen offers "Start
  without a login" - a small app can begin with no account at all and
  switch to login-based operation later as it grows; see
  [docs/recipes/no-login-app.md](docs/recipes/no-login-app.md) (Japanese).
- **Pinned header/sidebar, nav badges, and status chips** (2026-09): the
  header and sidebar stay pinned while the content scrolls; sidebar nav
  entries show an unseen-updates badge when another client changes their
  resource (declare `NavItem.badgeResource` to opt your own resources in);
  the header shows demo-mode / current-role status chips.
  The settings page is organized into titled category sections with an
  in-page jump nav.
- **CSV/Excel import & export**, a command palette (Ctrl+K), and SQLite
  backup/restore.
- **Toast notifications** with four kinds (info/success/warning/error) and a
  server-pushed `Notice` event recipe (SSE), plus an admin-only **system info
  card** (v1.2.0) on the settings page showing app version, DB backend, and
  runtime form (`GET /api/system/info` / Tauri `system_info`).
- **Databases: SQLite (default) and PostgreSQL.** V2 made the whole app
  runnable on PostgreSQL too (`banto-storage`'s `Db`/`Dialect` dialect
  abstraction plus per-dialect migrations); point `banto-serve`'s `BANTO_DB`
  env var at a `postgres://` URL to use it (default is local SQLite).
  On PostgreSQL, `BANTO_ATTACHMENTS_DIR` (where attachment files go, one
  subdirectory per database) is required - `banto-serve` refuses to start
  without it (#208).
  Backup/restore is SQLite-only (PostgreSQL returns an explicit error).
- **PostgreSQL backup**: the built-in backup/restore (Settings page backup
  section) is SQLite-only and returns an explicit error on PostgreSQL. Back
  it up with `pg_dump` (e.g. `pg_dump -Fc banto > banto.dump`) and restore
  with `pg_restore` (or `psql` for the plain-text format) — PostgreSQL has
  no equivalent of SQLite's `VACUUM INTO` or the startup-time file swap the
  built-in restore relies on.
- Optional, removable extension packages: reporting/print
  (`@banto/report`), attachment/image management (`@banto/attachments`),
  barcode/QR scanner input (`@banto/scan-wedge`), and a **tree view**
  (`@banto/tree-svelte`: expand/collapse, single/multi selection with tri-state
  checkboxes, lazy loading, drag reorder, inline rename, an optional tree-grid
  columns mode, and a tree-select popover). report/attachments/tree-svelte ship
  with deletable demo wiring (the tree view is the sidebar "Tree view" = `/tree`
  demo, reachable on the live demo too); scan-wedge is recipe-only (not wired
  into the demo app). Per-package integration recipes live under
  [docs/recipes/](docs/recipes/) (scan-wedge, notifications, tree-svelte,
  image-assets).

## Try it first: browser demo (in-memory)

Requirements: Node 24+ / pnpm 10+. This is the standalone browser **demo
mode**: data lives in memory and `admin / admin` is a demo-only fixed account.
To run the real thing with a SQLite database, install Rust and start the
desktop app (`pnpm --filter admin-template tauri dev`; the first run creates
the admin account — see [docs/recipes/windows-setup.md](docs/recipes/windows-setup.md),
Japanese).

```sh
git clone https://github.com/tyaro/banto.git my-app
cd my-app
pnpm install
pnpm dev        # http://localhost:1420 (standalone browser demo, log in as admin / admin)
```

Once it's running, there are three files to edit next (see
[docs/recipes/add-resource.md](docs/recipes/add-resource.md) for the full
walkthrough):

1. `apps/admin-template/src/lib/banto/resources/items.ts` — resource
   definition and schema
2. `apps/admin-template/core/migrations-sqlite/0001_items.sql` — table
   definition (PostgreSQL version in `migrations-postgres/0001_items.sql`)
3. `apps/admin-template/core/src/items.rs` — service layer (CRUD)

To turn this template into your own app, go in this order: copy → rename →
pick a scaffold preset (drop unused optional assets) → implement your own
screens and logic (replace the `items` demo) → configure LAN serving. First,
the rename script:

```sh
node scripts/rename.mjs \
  --name my-app \
  --title "My App" \
  --identifier com.example.myapp \
  --repo https://github.com/me/my-app   # optional
# add --dry-run to preview the changes first
pnpm install   # pick up the workspace rename
```

Next, drop the optional assets (dock layout, charts, glass theme, command
palette, attachments, reporting) as a batch with the scaffold script. Pick the
preset before implementing, because `display` also removes the `items` demo
and the dashboard:

```sh
pnpm scaffold --preset minimal   # minimal | standard | full | display
# --interactive to choose per asset, --dry-run to preview the changes
```

`display` is the display-only preset (andon board / always-on dashboard /
kiosk demo): on top of what `minimal` removes it drops the `items` demo
resource, the users / audit-log **screens** and `/dashboard`, then adds a
`/monitor` page plus LAN-public-viewing first-boot defaults, kiosk shell
defaults and `banto.i18n = "raw"`. See docs/design/display-preset-plan.md.

For assets scaffold doesn't touch, or to remove things by hand, see
[docs/recipes/remove-optional-assets.md](docs/recipes/remove-optional-assets.md)
(Japanese; `pnpm scaffold --interactive` covers most of it without reading
Japanese). The other app-author guides (rename details, consuming `@banto/*`
as a git dependency, LAN access, database/backup, Windows setup) live under
[docs/recipes/](docs/recipes/) as well.

## Security note

The LAN server is plain HTTP by default — enable it only on trusted
networks. See [docs/recipes/lan-access.md](docs/recipes/lan-access.md)
(Japanese) for the TLS reverse-proxy recipe (Caddy example).

Session tokens are held in memory, so restarting the server (the desktop app
/ resident process) drops every session and forces a re-login. The 30-day /
7-day "Remember me" limits are upper bounds under uninterrupted operation; on
a device rebooted daily the session ends each time (an accepted v1 tradeoff).

---

Full documentation is in Japanese: see [README.md](README.md). Maintainer
docs live under [docs/](docs/), AI agent guide in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
