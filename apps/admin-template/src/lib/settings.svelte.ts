/**
 * App settings store (Svelte 5 runes).
 *
 * Persistence (spec §12.1, M12): TWO layers per setting -
 * - localStorage, written synchronously on every change. This is the FOUC
 *   cache: app.html's inline script restores `banto.theme`/`banto.preset`/
 *   `banto.density` from it before first paint, and it is also the whole
 *   story in demo mode.
 * - the mode-matched `UiSettingsProvider` (`getUiSettings()`, setup.ts):
 *   Tauri settings DB / REST `settings` table, written fire-and-forget on
 *   every change (an unauthenticated write fails server-side and is
 *   swallowed - the local cache already has the value). Read back once per
 *   login via `syncFromProvider()` (called from the `(app)` route guard
 *   after the SessionController confirmed the session), so a value saved from another
 *   client/session wins over this tab's stale localStorage.
 */
import { untrack } from 'svelte';
import {
	applyDensity,
	applyPreset,
	applyTheme,
	isThemeDensity,
	isThemeMode,
	isThemePreset,
	resolveTheme,
	watchSystemTheme,
	type ResolvedTheme,
	type ThemeDensity,
	type ThemeMode,
	type ThemePreset
} from '@banto/theme';
import { getUiSettings } from './banto/setup';

const THEME_KEY = 'banto.theme';
const PRESET_KEY = 'banto.preset';
const DENSITY_KEY = 'banto.density';
const KIOSK_KEY = 'banto.kiosk';
const NAV_LAYOUT_KEY = 'banto.navLayout';
const LAUNCHER_OPACITY_KEY = 'banto.launcherOpacity';
const LAUNCHER_POSITION_KEY = 'banto.launcherPosition';

/** `UiSettingsProvider` keys (wire contract, spec M12). */
const MODE_SETTING = 'theme.mode';
const PRESET_SETTING = 'theme.preset';
const DENSITY_SETTING = 'theme.density';
const KIOSK_SETTING = 'shell.kiosk';
const NAV_LAYOUT_SETTING = 'shell.navLayout';
const LAUNCHER_OPACITY_SETTING = 'shell.launcherOpacity';
const LAUNCHER_POSITION_SETTING = 'shell.launcherPosition';

/**
 * Kiosk shell default (display-preset-plan.md D1-b/§3.2). `false` here keeps
 * this unit's behavior byte-for-byte unchanged for every existing app -
 * `scripts/scaffold.mjs --preset display` (PR-D2, not yet implemented) flips
 * ONLY this constant to `true` so a fresh display-preset app boots straight
 * into the kiosk shell. Do not seed `kiosk` from anywhere else.
 */
export const KIOSK_DEFAULT = false;

/** Shell navigation layout (nav-launcher-plan.md §3, D1): the sidebar or the dock-like launcher (shown as "Dock"). */
export type NavLayout = 'sidebar' | 'launcher';

/**
 * Navigation layout default (nav-launcher-plan.md §3, D3-a). `'sidebar'`
 * keeps every existing app's shell unchanged; an app that wants the dock by
 * default changes ONLY this constant (no server change - the provider key is
 * generic). Same rule as `KIOSK_DEFAULT`: do not seed `navLayout` from
 * anywhere else.
 */
export const NAV_LAYOUT_DEFAULT: NavLayout = 'sidebar';

/**
 * Which screen edge the dock sits on (nav-launcher-plan.md §3, D4). The same
 * values as `@banto/ui`'s `LauncherPosition`; <=900px is always the bottom
 * tab bar whatever this says (D5).
 */
export type LauncherPosition = 'bottom' | 'top' | 'left' | 'right';

/** Dock position default (nav-launcher-plan.md §3): the bottom edge. */
export const LAUNCHER_POSITION_DEFAULT: LauncherPosition = 'bottom';

/** Launcher bar opacity in whole percent (nav-launcher-plan.md D7): the slider's range, step and default (the theme's own default is the same 50%). */
export const LAUNCHER_OPACITY_MIN = 40;
export const LAUNCHER_OPACITY_MAX = 100;
export const LAUNCHER_OPACITY_STEP = 5;
export const LAUNCHER_OPACITY_DEFAULT = 50;

/** The only theme token the app writes for the launcher (the colour formula stays in banto.css, D7). */
const LAUNCHER_OPACITY_TOKEN = '--banto-shell-launcher-opacity';

export function isNavLayout(value: unknown): value is NavLayout {
	return value === 'sidebar' || value === 'launcher';
}

export function isLauncherPosition(value: unknown): value is LauncherPosition {
	return value === 'bottom' || value === 'top' || value === 'left' || value === 'right';
}

/** A whole percent on the slider's grid (40-100, step 5). */
export function isLauncherOpacity(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= LAUNCHER_OPACITY_MIN &&
		value <= LAUNCHER_OPACITY_MAX &&
		(value - LAUNCHER_OPACITY_MIN) % LAUNCHER_OPACITY_STEP === 0
	);
}

/** Stored string -> opacity; anything off the slider's grid is the default (same rule as the theme guards). */
export function parseLauncherOpacity(stored: string | null): number {
	if (stored === null || !/^\d+$/.test(stored)) return LAUNCHER_OPACITY_DEFAULT;
	const value = Number(stored);
	return isLauncherOpacity(value) ? value : LAUNCHER_OPACITY_DEFAULT;
}

function loadThemeMode(): ThemeMode {
	if (typeof localStorage === 'undefined') return 'system';
	const stored = localStorage.getItem(THEME_KEY);
	return isThemeMode(stored) ? stored : 'system';
}

function loadResolvedTheme(): ResolvedTheme {
	// No `window` (SSR/prerender): the same default as an unset mode on a light OS.
	if (typeof window === 'undefined') return 'light';
	return resolveTheme(loadThemeMode());
}

function loadThemePreset(): ThemePreset {
	if (typeof localStorage === 'undefined') return 'standard';
	const stored = localStorage.getItem(PRESET_KEY);
	return isThemePreset(stored) ? stored : 'standard';
}

function loadThemeDensity(): ThemeDensity {
	if (typeof localStorage === 'undefined') return 'standard';
	const stored = localStorage.getItem(DENSITY_KEY);
	return isThemeDensity(stored) ? stored : 'standard';
}

function loadKiosk(): boolean {
	if (typeof localStorage === 'undefined') return KIOSK_DEFAULT;
	const stored = localStorage.getItem(KIOSK_KEY);
	if (stored === 'true') return true;
	if (stored === 'false') return false;
	return KIOSK_DEFAULT;
}

function loadNavLayout(): NavLayout {
	if (typeof localStorage === 'undefined') return NAV_LAYOUT_DEFAULT;
	const stored = localStorage.getItem(NAV_LAYOUT_KEY);
	return isNavLayout(stored) ? stored : NAV_LAYOUT_DEFAULT;
}

function loadLauncherPosition(): LauncherPosition {
	if (typeof localStorage === 'undefined') return LAUNCHER_POSITION_DEFAULT;
	const stored = localStorage.getItem(LAUNCHER_POSITION_KEY);
	return isLauncherPosition(stored) ? stored : LAUNCHER_POSITION_DEFAULT;
}

function loadLauncherOpacity(): number {
	if (typeof localStorage === 'undefined') return LAUNCHER_OPACITY_DEFAULT;
	return parseLauncherOpacity(localStorage.getItem(LAUNCHER_OPACITY_KEY));
}

/** Best-effort provider write: an unauthenticated/offline failure is expected and ignored (localStorage already holds the value). */
function persistRemote(key: string, value: string): void {
	void getUiSettings()
		.set(key, value)
		.catch(() => {});
}

class Settings {
	themeMode: ThemeMode = $state(loadThemeMode());
	/**
	 * The theme actually on screen (light/dark): `themeMode` with "system"
	 * resolved against the OS. The header's toggle shows the opposite of this.
	 * Kept current by `#applyThemeMode` and, while following the system, by the
	 * OS watcher.
	 */
	resolvedTheme: ResolvedTheme = $state(loadResolvedTheme());
	themePreset: ThemePreset = $state(loadThemePreset());
	themeDensity: ThemeDensity = $state(loadThemeDensity());
	kiosk: boolean = $state(loadKiosk());
	navLayout: NavLayout = $state(loadNavLayout());
	/** The dock's screen edge (only used while `navLayout === 'launcher'`). */
	launcherPosition: LauncherPosition = $state(loadLauncherPosition());
	/** Whole percent (40-100, step 5), written to the root's `--banto-shell-launcher-opacity`. */
	launcherOpacity: number = $state(loadLauncherOpacity());
	/**
	 * Kiosk shell (display-preset-plan.md D1-b): the fold is not itself
	 * persisted (unchanged from before this unit - it always started at
	 * `false`), so "unless the user has a persisted sidebarCollapsed value"
	 * never applies today. The initial value only is seeded from `kiosk` so a
	 * kiosk app starts collapsed; nothing re-forces it afterwards, so the
	 * user can still expand it via `toggleSidebar()`.
	 */
	sidebarCollapsed = $state(this.kiosk);

	#unwatchSystem: (() => void) | undefined;

	/**
	 * Stale-read guard for `syncFromProvider()` (#424 review): `(app)/+layout.ts`
	 * does not await the sync, so the user can change a setting while its
	 * reads are in flight. Keys set locally since the sync began are not
	 * overwritten by its (older) results, and a newer sync supersedes an older one.
	 */
	#syncGeneration = 0;
	#changedSinceSync = new Set<string>();

	/** Apply + cache locally, WITHOUT the provider write (init/syncFromProvider must not echo values back). */
	#applyThemeMode(mode: ThemeMode) {
		this.themeMode = mode;
		localStorage.setItem(THEME_KEY, mode);
		this.resolvedTheme = applyTheme(mode);

		this.#unwatchSystem?.();
		this.#unwatchSystem = undefined;
		if (mode === 'system') {
			this.#unwatchSystem = watchSystemTheme(() => {
				this.resolvedTheme = applyTheme('system');
			});
		}
	}

	#applyThemePreset(preset: ThemePreset) {
		this.themePreset = preset;
		localStorage.setItem(PRESET_KEY, preset);
		applyPreset(preset);
	}

	#applyThemeDensity(density: ThemeDensity) {
		this.themeDensity = density;
		localStorage.setItem(DENSITY_KEY, density);
		applyDensity(density);
	}

	/** Apply + cache locally, WITHOUT the provider write - same split as the theme appliers above. Deliberately does NOT touch `sidebarCollapsed` (only the field's initial value is seeded from `kiosk`; a value arriving later via `syncFromProvider()` must not yank a fold the user already changed this session). */
	#applyKiosk(kiosk: boolean) {
		this.kiosk = kiosk;
		localStorage.setItem(KIOSK_KEY, String(kiosk));
	}

	/** Apply + cache locally, WITHOUT the provider write (nav-launcher-plan.md §3). */
	#applyNavLayout(layout: NavLayout) {
		this.navLayout = layout;
		localStorage.setItem(NAV_LAYOUT_KEY, layout);
	}

	/** Apply + cache locally, WITHOUT the provider write (nav-launcher-plan.md §3, D4). */
	#applyLauncherPosition(position: LauncherPosition) {
		this.launcherPosition = position;
		localStorage.setItem(LAUNCHER_POSITION_KEY, position);
	}

	/** Apply + cache locally, WITHOUT the provider write: the one theme token the slider changes (D7). */
	#applyLauncherOpacity(opacity: number) {
		const value = isLauncherOpacity(opacity) ? opacity : LAUNCHER_OPACITY_DEFAULT;
		this.launcherOpacity = value;
		localStorage.setItem(LAUNCHER_OPACITY_KEY, String(value));
		document.documentElement.style.setProperty(LAUNCHER_OPACITY_TOKEN, `${value}%`);
	}

	setThemeMode(mode: ThemeMode) {
		this.#changedSinceSync.add(MODE_SETTING);
		this.#applyThemeMode(mode);
		persistRemote(MODE_SETTING, mode);
	}

	/**
	 * The header's sun/moon button: pin the opposite of the theme on screen
	 * (so from "system" it stores `light` or `dark` and stops following the OS).
	 * The read is untracked so this is safe to call from an `$effect`.
	 */
	toggleThemeMode() {
		const next: ThemeMode = untrack(() => this.resolvedTheme) === 'dark' ? 'light' : 'dark';
		this.setThemeMode(next);
	}

	setThemePreset(preset: ThemePreset) {
		this.#changedSinceSync.add(PRESET_SETTING);
		this.#applyThemePreset(preset);
		persistRemote(PRESET_SETTING, preset);
	}

	setThemeDensity(density: ThemeDensity) {
		this.#changedSinceSync.add(DENSITY_SETTING);
		this.#applyThemeDensity(density);
		persistRemote(DENSITY_SETTING, density);
	}

	setKiosk(kiosk: boolean) {
		this.#changedSinceSync.add(KIOSK_SETTING);
		this.#applyKiosk(kiosk);
		persistRemote(KIOSK_SETTING, String(kiosk));
	}

	setNavLayout(layout: NavLayout) {
		this.#changedSinceSync.add(NAV_LAYOUT_SETTING);
		this.#applyNavLayout(layout);
		persistRemote(NAV_LAYOUT_SETTING, layout);
	}

	setLauncherPosition(position: LauncherPosition) {
		this.#changedSinceSync.add(LAUNCHER_POSITION_SETTING);
		this.#applyLauncherPosition(position);
		persistRemote(LAUNCHER_POSITION_SETTING, position);
	}

	/**
	 * Live apply while the slider moves (its `input` event): the real dock
	 * follows at once, but the provider is written only once the value is
	 * committed (`setLauncherOpacity`, the `change` event), so a drag does not
	 * fire a burst of writes that could land out of order.
	 */
	previewLauncherOpacity(opacity: number) {
		this.#changedSinceSync.add(LAUNCHER_OPACITY_SETTING);
		this.#applyLauncherOpacity(opacity);
	}

	/** Commit (the slider's `change` event); an off-grid value falls back to the default. */
	setLauncherOpacity(opacity: number) {
		this.#changedSinceSync.add(LAUNCHER_OPACITY_SETTING);
		this.#applyLauncherOpacity(opacity);
		persistRemote(LAUNCHER_OPACITY_SETTING, String(this.launcherOpacity));
	}

	/** Call once on app mount to sync the DOM and start OS-theme watching. No provider write - nothing changed yet. */
	init() {
		this.#applyThemeMode(this.themeMode);
		this.#applyThemePreset(this.themePreset);
		this.#applyThemeDensity(this.themeDensity);
		this.#applyKiosk(this.kiosk);
		this.#applyNavLayout(this.navLayout);
		this.#applyLauncherPosition(this.launcherPosition);
		this.#applyLauncherOpacity(this.launcherOpacity);
	}

	/**
	 * Pull theme settings from the `UiSettingsProvider` and apply whatever it
	 * holds (updating the localStorage cache too). Called once per login from
	 * `routes/(app)/+layout.ts` - that's the earliest point the provider is
	 * guaranteed authenticated (the session was just confirmed). A
	 * missing key (never saved) or any provider failure leaves the current
	 * (localStorage-seeded) values in place - except the navigation layout
	 * and the launcher position and opacity (nav-launcher-plan.md §3, #421
	 * review): the localStorage cache is not per user, so a successful read
	 * with no value resets those three to their defaults (cached locally, not written back),
	 * or a user who never chose would inherit the previous user's dock on a
	 * shared browser. A failed read keeps the local values for them too.
	 * A key the user changed while the reads were in flight keeps the user's
	 * value, and a sync superseded by a newer one applies nothing.
	 */
	async syncFromProvider(): Promise<void> {
		const ui = getUiSettings();
		const generation = ++this.#syncGeneration;
		this.#changedSinceSync.clear();
		try {
			const [mode, preset, density, kiosk, navLayout, launcherPosition, launcherOpacity] =
				await Promise.all([
					ui.get(MODE_SETTING),
					ui.get(PRESET_SETTING),
					ui.get(DENSITY_SETTING),
					ui.get(KIOSK_SETTING),
					ui.get(NAV_LAYOUT_SETTING),
					ui.get(LAUNCHER_POSITION_SETTING),
					ui.get(LAUNCHER_OPACITY_SETTING)
				]);
			if (generation !== this.#syncGeneration) return;
			const fresh = (key: string): boolean => !this.#changedSinceSync.has(key);
			if (fresh(MODE_SETTING) && isThemeMode(mode)) this.#applyThemeMode(mode);
			if (fresh(PRESET_SETTING) && isThemePreset(preset)) this.#applyThemePreset(preset);
			if (fresh(DENSITY_SETTING) && isThemeDensity(density)) this.#applyThemeDensity(density);
			if (fresh(KIOSK_SETTING) && (kiosk === 'true' || kiosk === 'false'))
				this.#applyKiosk(kiosk === 'true');
			if (fresh(NAV_LAYOUT_SETTING))
				this.#applyNavLayout(isNavLayout(navLayout) ? navLayout : NAV_LAYOUT_DEFAULT);
			if (fresh(LAUNCHER_POSITION_SETTING))
				this.#applyLauncherPosition(
					isLauncherPosition(launcherPosition) ? launcherPosition : LAUNCHER_POSITION_DEFAULT
				);
			if (fresh(LAUNCHER_OPACITY_SETTING))
				this.#applyLauncherOpacity(parseLauncherOpacity(launcherOpacity));
		} catch {
			// Best-effort: offline/unauthenticated reads keep the local values.
		}
	}

	toggleSidebar() {
		this.sidebarCollapsed = !this.sidebarCollapsed;
	}
}

export const settings = new Settings();
