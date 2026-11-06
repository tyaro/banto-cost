/**
 * Composition root: wires @banto/admin-core for the admin-template app
 * (spec §3, §8, §11). Imported once (side-effect) from the root layout,
 * before any route guard runs.
 *
 * M6 Phase B (spec §11.1): THREE environments are distinguished:
 * 1. **Tauri webview** (`isTauri()`) — `TauriDataProvider`/
 *    `TauriAuthProvider` over `invoke()`, `TauriEventProvider` over the
 *    `banto://event` Tauri event (no network either way).
 * 2. **LAN browser served by the embedded server** (`probeBackend()`,
 *    async probe; a failed probe is retried/surfaced, never read as demo —
 *    Issue #286, `startup.ts`) —`HttpDataProvider`/`HttpAuthProvider` over `fetch()`
 *    against the same REST API `admin-template-core::rest` exposes, and
 *    `SseEventProvider` over `GET /api/events`. This is what a second
 *    machine on the LAN gets, and it's also what `banto-serve` (this repo's
 *    Tauri-free dev vehicle) serves.
 * 3. **Plain `vite dev`/`vite preview`** (neither of the above) — the M2
 *    Phase A `InMemoryDataProvider` + demo sessionStorage auth, so the app
 *    still runs with no Rust backend at all (tests, quick UI iteration).
 *
 * Detecting (2) requires an async network probe, so provider selection as a
 * whole is async: `bantoReady` is the promise every entry point
 * (`routes/+layout.svelte`, the `(app)` route guard, the login page) awaits
 * before touching `getDataProvider()`/`getAuthProvider()`. The
 * resource/schema definitions and AuthProvider/DataProvider/EventProvider
 * contracts stay identical across all three - UI code never branches on
 * environment (spec §11.1).
 *
 * Layout (improvement-plan-2026-07.md P3-4) - this file stays the app's one
 * public entry point (everything below is re-exported here), but the parts
 * an app author actually edits live in their own files:
 * - `resources/items.ts` + `resources/index.ts` — resource definitions and
 *   registration (**the files you replace**, docs/recipes/add-resource.md)
 * - `environment.ts` — isTauri / isEmbeddedServer / CSRF_HEADER detection
 * - `providers/demo.ts` — the demo-mode AuthProvider
 */
import {
	connectEvents,
	createHttpAuthProvider,
	createHttpDataProvider,
	createHttpUiSettings,
	createInMemoryDataProvider,
	createLocalUiSettings,
	createSseEventProvider,
	createTauriAuthProvider,
	createTauriDataProvider,
	createTauriEventProvider,
	createTauriUiSettings,
	initBanto
} from '@banto/admin-core';
import type { Notifier, UiSettingsProvider } from '@banto/admin-core';
// Safe to import in a plain browser (no Tauri runtime): only ever *called*
// when isTauri() is true.
import { invoke } from '@tauri-apps/api/core';
import { toastStore } from '#lib/toast.svelte.js';
import { CSRF_HEADER, isDemoBuild, isTauri, probeBackend } from './environment';
import { demoAuthProvider } from './providers/demo';
import { resources } from './resources';
import { sampleItems } from './sampleData';
import { resolveStartupTarget } from './startup';
import { setStartupStatus, waitForStartupRetry } from './startupState.svelte';

// Re-exported so the rest of the app keeps importing from './setup' (one
// public entry point; the split into environment.ts is an internal detail).
export { CSRF_HEADER, isTauri };

/**
 * Which of the three spec §11.1 environments this tab ended up wired to -
 * `usersAdmin.ts` (spec M10) needs this to pick invoke() vs fetch() vs "not
 * available", the same three-way split `bantoReady` below already resolves,
 * just exposed as a plain synchronous read instead of re-running the async
 * probe. Set exactly once, at the end of whichever `bantoReady` branch runs;
 * defaults to 'demo' so a read before `bantoReady` resolves (should not
 * happen - see that promise's own doc comment) fails toward "unavailable"
 * rather than silently guessing 'tauri'/'server'.
 */
export type BantoMode = 'tauri' | 'server' | 'demo';
let bantoMode: BantoMode = 'demo';
export function getBantoMode(): BantoMode {
	return bantoMode;
}

/**
 * UI-settings persistence (spec §12.1, M12): mode-matched like the
 * data/auth providers above - Tauri -> `ui_settings_get/set` commands,
 * embedded server -> `/api/ui-settings/{key}` REST, plain-browser demo ->
 * localStorage. Defaults to the localStorage implementation so a read
 * before `bantoReady` resolves (e.g. `settings.svelte.ts`'s eager module
 * init) degrades to the local cache rather than crashing; the real
 * provider is swapped in by whichever `bantoReady` branch runs. Callers
 * treat writes as best-effort (unauthenticated writes fail server-side and
 * are swallowed - localStorage remains the always-written FOUC cache).
 */
let uiSettings: UiSettingsProvider = createLocalUiSettings();
export function getUiSettings(): UiSettingsProvider {
	return uiSettings;
}

const notifier: Notifier = { notify: (kind, message) => toastStore.push(kind, message) };

/** Set once {@link bantoReady} resolves - see {@link isBantoReady}. */
let ready = false;

/**
 * Resolves once `initBanto()` has run AND the matching `EventProvider` (if
 * any) is connected. Every place that calls `getDataProvider()`/
 * `getAuthProvider()` before the root layout has definitely mounted (the
 * login page's submit handler, a pop-out panel) must `await` this first;
 * `routes/+layout.svelte` awaits it with `{#await}` before rendering
 * `children()` at all, so everything downstream of that is already safe.
 *
 * Issue #321: a route guard must NOT simply `await` this while it is pending - on a
 * first load SvelteKit renders nothing (not even the root layout's splash)
 * until every load has finished, and while the server is unreachable this
 * waits for the user's "reconnect" on that very splash. The `(app)` guard
 * checks {@link isBantoReady} instead and defers (`startupGate.ts`).
 */
export const bantoReady: Promise<void> = (async () => {
	// Deployment kind is decided explicitly (Tauri / `VITE_BANTO_DEMO` build /
	// a definitive "no Banto API here" answer); a transient probe failure is
	// NOT "demo" - it stays on the splash screen with a retry button until the
	// server answers (Issue #286, startup.ts).
	const target = await resolveStartupTarget({
		isTauri,
		isDemoBuild,
		probe: () => probeBackend(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		setStatus: setStartupStatus,
		waitForRetry: waitForStartupRetry
	});

	if (target === 'tauri') {
		bantoMode = 'tauri';
		const dataProvider = createTauriDataProvider({ invoke });
		const authProvider = createTauriAuthProvider({ invoke });
		uiSettings = createTauriUiSettings({ invoke });
		initBanto({ dataProvider, authProvider, notifier, resources });

		// Dynamic import: @tauri-apps/api/event's `listen` talks to a real
		// Tauri IPC channel that does not exist outside the webview, so it must
		// not be evaluated at module load time in the other two environments.
		const { listen } = await import('@tauri-apps/api/event');
		connectEvents(createTauriEventProvider({ listen }));
		return;
	}

	if (target === 'server') {
		bantoMode = 'server';
		const authProvider = createHttpAuthProvider();
		const dataProvider = createHttpDataProvider({ getToken: authProvider.getToken });
		uiSettings = createHttpUiSettings({ getToken: authProvider.getToken });
		initBanto({ dataProvider, authProvider, notifier, resources });
		connectEvents(createSseEventProvider({ getToken: authProvider.getToken }));
		return;
	}

	// Intended demo (static hosting / `vite dev`/`vite preview`, or a
	// `VITE_BANTO_DEMO=1` build): no Banto backend at all, no EventProvider.
	bantoMode = 'demo';
	initBanto({
		dataProvider: createInMemoryDataProvider({ items: { rows: sampleItems } }),
		authProvider: demoAuthProvider,
		notifier,
		resources
	});
})().then(() => {
	ready = true;
});

/**
 * Whether {@link bantoReady} has resolved (Issue #321): a synchronous read for
 * the `(app)` route guard, which must decide WITHOUT waiting whether it can run
 * now or has to defer to the startup splash (`startupGate.ts`). Set in the
 * promise's own continuation, so it is already true for anything chained on
 * `bantoReady` (the root layout's re-run).
 */
export function isBantoReady(): boolean {
	return ready;
}
