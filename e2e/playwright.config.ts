/**
 * Playwright config for Banto's E2E suites: TWO independent projects that
 * never interfere with each other (visual-refresh-plan.md Phase 0).
 *
 * - `chromium` (testDir `./tests`): the M18 smoke suite described below.
 * - `visual` (testDir `./visual`): the Phase 0 visual-regression +
 *   axe-core project (visual-refresh-design.md §12). It runs against the
 *   SAME static build as `chromium`, but served by plain `vite preview`
 *   (browser demo mode - InMemory data + fixed admin/admin auth, spec
 *   §11.1's third environment) instead of `banto-serve`, so its screenshots
 *   never depend on a live SQLite backend. `pnpm --filter banto-cost-app
 *   build` must run first here too - see visual/README.md.
 *
 * `webServer` is an array (Playwright starts every entry regardless of
 * which `--project` is selected; set `BANTO_E2E_SERVERS=visual` to start
 * only the `vite preview` entry, as CI's visual job does), so running just
 * the smoke suite still spins up the idle preview server - harmless as long as `build/` already
 * exists, which the smoke suite already requires (see below). Root
 * `package.json`'s `e2e` script pins `--project=chromium` so a plain
 * `pnpm e2e` never runs the visual suite (and vice versa for `e2e:visual`).
 *
 * ---
 *
 * `chromium` project scope (docs/roadmap.md M18, docs/history/improvements.md §4):
 * a LAN/REST-mode smoke pass, NOT a mocked-frontend test. `pnpm --filter
 * admin-template build` produces the static SvelteKit build, and a `cargo
 * build -p admin-template-core --bin banto-serve --features embed-ui`
 * produces the binary this config's `webServer` launches directly (NOT
 * `cargo run` - launching the already-built binary keeps startup
 * near-instant and avoids a surprise recompile mid-test-run). Neither
 * build step runs from this config; run them first (see README/CI
 * workflow), same division of labor as `.claude/launch.json`'s
 * `banto-serve` entry.
 *
 * The whole suite runs single-worker/serial (project `workers: 1`) in one spec file
 * (`tests/smoke.spec.ts`) against one shared `page` - each scenario builds
 * on state the previous one created (the admin account, the item, the
 * viewer account, ...), mirroring how a person would actually click through
 * the app once. That is also why `webServer` always starts a fresh server
 * against a fresh temp-directory SQLite file: scenario 1 exercises the
 * first-run setup screen, which only appears against a database with zero
 * users - reusing a server/db left over from a previous run would skip it.
 */
import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '..');

const PORT = 8799;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// `public-viewer` project (viewer-public-plan.md §3.1-8, Issue #189): a SECOND
// `banto-serve` on its own port and its own fresh DB, started with
// `BANTO_VIEWER_PUBLIC=1`. It has to be a separate server: viewer-public is a
// settings-DB flag with no REST route to toggle it (server settings are
// desktop-only), and switching it on the smoke server would change scenario
// 1's "unauthenticated visit shows the setup screen" premise.
const PUBLIC_VIEWER_PORT = 8798;
const PUBLIC_VIEWER_BASE_URL = `http://127.0.0.1:${PUBLIC_VIEWER_PORT}`;

// `visual` project (browser demo mode, vite preview - see doc comment above).
const VISUAL_PORT = 4173;
const VISUAL_BASE_URL = `http://127.0.0.1:${VISUAL_PORT}`;

// `SqliteConnectOptions::create_if_missing` (crates/banto-storage/src/
// sqlite.rs) creates the DB *file* but not missing parent directories, so
// the temp dir itself must exist before banto-serve starts.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-e2e-'));
const dbPath = path.join(dbDir, 'banto-e2e.sqlite3');
// Same temp dir (one teardown removes both), separate file: the two servers
// must never share a users table.
const publicViewerDbPath = path.join(dbDir, 'banto-e2e-public-viewer.sqlite3');
// Read by global-teardown.ts to remove `dbDir` again after the run - see
// that file's doc comment for why an env var, not a direct import.
process.env.BANTO_E2E_DB_DIR = dbDir;

const bantoServeBin = path.join(
	repoRoot,
	'target',
	'debug',
	process.platform === 'win32' ? 'banto-serve.exe' : 'banto-serve'
);

/**
 * `BANTO_E2E_SERVERS=visual` narrows `webServer` to the `vite preview` entry
 * (matched by its URL, not its position) - CI's separate visual job only
 * needs that, so it can skip building `banto-serve`. Unset (every local
 * `pnpm e2e*`) keeps all entries.
 */
function selectWebServers<T extends { url?: string }>(servers: T[]): T[] {
	if (process.env.BANTO_E2E_SERVERS !== 'visual') return servers;
	const visual = servers.filter((s) => s.url === VISUAL_BASE_URL);
	if (visual.length !== 1) {
		throw new Error(`BANTO_E2E_SERVERS=visual: expected one webServer at ${VISUAL_BASE_URL}`);
	}
	return visual;
}

export default defineConfig({
	testDir: './tests',
	// Explicit (not the './test-results'/'./playwright-report' defaults):
	// Playwright resolves those defaults relative to the process's current
	// working directory, not this config file's directory, and `pnpm e2e`
	// (root package.json) invokes this config via `--config=e2e/...` from
	// the repo root - an implicit default would litter the repo root
	// instead of staying under e2e/ (see .gitignore's `e2e/test-results/`).
	outputDir: path.join(dirname, 'test-results'),
	globalTeardown: path.join(dirname, 'global-teardown.ts'),
	fullyParallel: false,
	// Total worker limit. The two smoke projects pin themselves to one worker
	// below (their single spec file shares one `page` and builds state scenario
	// by scenario); only `visual` actually fans out. Its specs are independent
	// (browser demo mode: each test gets a fresh context, so InMemory data and
	// localStorage never leak between files), and running them on one worker
	// made it the slowest CI job (2026-11-06: 4.5 min of a 5.5 min job).
	// Files run in parallel; tests inside one file stay in order
	// (`fullyParallel: false`). GitHub's ubuntu runners have 4 vCPUs.
	workers: process.env.CI ? 4 : undefined,
	// A single retry in CI absorbs shared-runner hiccups (slow first paint,
	// a cold-cache SQLite VACUUM INTO for the backup scenario) without
	// masking a genuinely broken scenario - locally we want an immediate,
	// unambiguous failure instead.
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI
		? [
				['github'],
				['html', { open: 'never', outputFolder: path.join(dirname, 'playwright-report') }]
			]
		: [['list']],
	expect: {
		// Slightly above the 5s default: several assertions here wait on a
		// real SQLite round trip (grid filter -> server-mode fetch, backup
		// creation) rather than an in-memory mock.
		timeout: 10_000
	},
	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		// View Transitions (visual-refresh-design.md §11.1) freeze the OLD
		// page's snapshot for the crossfade duration, so right after a
		// navigation the DOM briefly still shows the previous page - locators
		// can pin the wrong element in that window. reduced-motion makes
		// onNavigate skip startViewTransition entirely (and zeroes every
		// --banto-duration-* token), keeping the suite deterministic - the
		// same setting §12.1 prescribes for the visual-regression project.
		reducedMotion: 'reduce'
	},
	projects: [
		// M18 smoke suite (unchanged behavior): explicit testDir so adding the
		// `visual` project below can never pull tests/visual/*.spec.ts into the
		// wrong project or vice versa.
		{ name: 'chromium', testDir: './tests', workers: 1, use: { ...devices['Desktop Chrome'] } },
		// Viewer-public mode (Issue #189): LAN/REST mode like `chromium`, but
		// against the second banto-serve started with BANTO_VIEWER_PUBLIC=1
		// (see `webServer` below). Own testDir so neither project can pick up
		// the other's specs.
		{
			name: 'public-viewer',
			testDir: './tests-public-viewer',
			workers: 1,
			use: { ...devices['Desktop Chrome'], baseURL: PUBLIC_VIEWER_BASE_URL }
		},
		// Phase 0 visual regression + axe-core (visual-refresh-design.md §12).
		// 1440x900 is the project-wide default viewport; individual specs
		// override it per visual-refresh-plan.md's Phase 0 matrix (1024x768,
		// 768x1024) via `test.use({ viewport })`.
		{
			name: 'visual',
			testDir: './visual',
			testMatch: /.*\.spec\.ts/,
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1440, height: 900 },
				reducedMotion: 'reduce',
				baseURL: VISUAL_BASE_URL
			},
			expect: {
				// §12.1: pixel-level tolerance for the whole project, so specs
				// only need to name the screenshot, not repeat these options.
				//
				// ABSOLUTE, not a ratio (choiapp-feedback-2026-09 §6). The former
				// `maxDiffPixelRatio: 0.001` was a share of the WHOLE fullPage
				// screenshot, so a tall page bought itself a proportionally larger
				// blind spot: the 1440x3255 dashboard tolerated ~4,700 differing
				// pixels, the 1440x900 items page ~1,300. Measured consequence: the
				// 2026-09 header status chips register as only 568-828 perceptually
				// different pixels (pixelmatch YIQ at the default `threshold: 0.2`),
				// so a visible new element slipped past every page's tolerance and
				// the baselines silently went stale.
				//
				// 250 sits below that 568 floor (so a chip/badge-sized change is
				// caught) and above the observed noise: re-rendering the same build
				// twice in one environment differs by exactly 0 pixels - Chromium is
				// deterministic given the same binary, fonts and `reducedMotion`, and
				// CI pins both the runner image and the Playwright version. The
				// buffer is there for incidental antialiasing, not for jitter.
				//
				// Trade-off accepted: a Playwright/Chromium/runner-image bump that
				// shifts rendering now turns this suite red instead of passing
				// unnoticed. That is the intended behavior - review the diff, then
				// regenerate via `.github/workflows/visual-baselines.yml`
				// (see e2e/visual/README.md).
				toHaveScreenshot: { animations: 'disabled', maxDiffPixels: 250 }
			}
		}
	],
	webServer: selectWebServers([
		{
			command: bantoServeBin,
			url: BASE_URL,
			// Never reuse a leftover server: it would carry over yesterday's
			// (already-set-up) database, which breaks scenario 1's "database
			// starts empty" assumption on a second local run.
			reuseExistingServer: false,
			timeout: 30_000,
			// Playwright's default swallows webServer stdout, which turns any
			// "server never became ready" failure into an undebuggable 30s
			// timeout in CI logs. Piping it costs a few startup lines per run
			// and preserves the evidence (bind address, DB path) when it counts.
			stdout: 'pipe',
			env: {
				PORT: String(PORT),
				BANTO_BIND: '127.0.0.1',
				BANTO_DB: dbPath,
				// spec §8.2 / banto-serve.rs: POST /api/auth/setup is 403'd unless
				// explicitly opted into - required for scenario 1.
				BANTO_ALLOW_SETUP: '1'
			}
		},
		{
			// Second banto-serve for the `public-viewer` project (Issue #189) -
			// same binary, own port/DB, viewer-public seeded ON at startup.
			// BANTO_ALLOW_SETUP stays on so the spec can also create the first
			// admin from the LAN login screen and prove the "ログイン" path back
			// into the normal UI.
			command: bantoServeBin,
			url: PUBLIC_VIEWER_BASE_URL,
			reuseExistingServer: false,
			timeout: 30_000,
			stdout: 'pipe',
			env: {
				PORT: String(PUBLIC_VIEWER_PORT),
				BANTO_BIND: '127.0.0.1',
				BANTO_DB: publicViewerDbPath,
				BANTO_ALLOW_SETUP: '1',
				BANTO_VIEWER_PUBLIC: '1'
			}
		},
		{
			// Browser demo mode (spec §11.1's third environment): no Rust
			// backend at all, so unlike `banto-serve` above this has no `env`/DB
			// to isolate - reusing a server left running from a previous local
			// run is safe (and convenient for `--update-snapshots` iteration).
			//
			// `--host 127.0.0.1` is load-bearing: vite's default host is
			// `localhost`, which on hosts whose `localhost` resolves to `::1`
			// first (GitHub's ubuntu runners) makes vite bind ONLY the IPv6
			// loopback - while Playwright polls the IPv4 `url` below and gets
			// ECONNREFUSED until the 30s webServer timeout kills the whole run.
			// Pinning the bind address to the exact address being polled keeps
			// the two sides agreeing everywhere.
			command: `pnpm --filter banto-cost-app preview --port ${VISUAL_PORT} --strictPort --host 127.0.0.1`,
			cwd: repoRoot,
			url: VISUAL_BASE_URL,
			reuseExistingServer: !process.env.CI,
			timeout: 30_000,
			// Same rationale as the banto-serve entry above - vite's startup
			// banner records which host it actually bound.
			stdout: 'pipe'
		}
	])
});
