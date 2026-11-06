/**
 * i18n locale runtime for the admin-template app (ADR-0005). **App layer
 * ONLY** — the `@banto/*` packages never import
 * this (conventions §5); they receive already-resolved strings via `messages`
 * props (i18n layer ①). This module bridges Paraglide's compiled runtime
 * (`#lib/paraglide`) to Banto's existing provider/settings plumbing so locale
 * resolution + persistence stay in the provider/setup layer (conventions §10),
 * exactly like theme/vibrancy in settings.svelte.ts.
 *
 * base/source locale is English (the message source of truth, conventions §13),
 * but the effective **default display locale is Japanese** so single-language
 * installs see zero visual change. That split is implemented by a custom
 * Paraglide client strategy `"custom-banto"` (registered below; compiled into
 * the `strategy` array in vite.config.ts and the `paraglide:compile` script),
 * which resolves the locale from:
 *   1. this tab's `localStorage['banto.locale']` — the FOUC cache, same role
 *      as `banto.theme` (app.html restores `<html lang>` from it before first
 *      paint); else
 *   2. `DEFAULT_LOCALE` (`'ja'`).
 * Because the custom strategy always returns a value in the browser, the
 * `'baseLocale'` fallback in the strategy array only fires on the
 * server/prerender (the empty SPA shell), keeping `en` as the compile-time
 * base without ever showing English by default in a real tab. adapter-static
 * has no server runtime, so locale is resolved entirely client-side — no URL
 * prefixes, cookies parsed on a server, or SvelteKit hooks (ADR-0005).
 *
 * Persistence rides on the mode-matched `UiSettingsProvider` (M12,
 * `getUiSettings()`) like theme: localStorage is the always-written FOUC cache
 * + demo fallback, the provider write is best-effort (an unauthenticated write
 * fails server-side and is swallowed), and `syncLocaleFromProvider()` pulls the
 * saved value once per login.
 */
import { defineCustomClientStrategy, isLocale, type Locale } from '#lib/paraglide/runtime.js';
import { getUiSettings } from './setup';

/**
 * Effective default display locale when nothing is stored. Japanese keeps the
 * current UI byte-identical for single-language installs (zero visual
 * regression), even though the base/source locale is English (conventions §13).
 */
const DEFAULT_LOCALE: Locale = 'ja';

/** localStorage FOUC cache key — MUST match the restore snippet in app.html. */
const LOCALE_KEY = 'banto.locale';
/** `UiSettingsProvider` key (wire contract, M12), namespaced under `ui.`. */
const LOCALE_SETTING = 'ui.locale';

/** Read + validate the cached locale; falls back to DEFAULT_LOCALE (ja). */
function readCachedLocale(): Locale {
	if (typeof localStorage === 'undefined') return DEFAULT_LOCALE;
	const stored = localStorage.getItem(LOCALE_KEY);
	return isLocale(stored) ? stored : DEFAULT_LOCALE;
}

/** Reflect the active locale onto `<html lang>` (client only). */
function applyHtmlLang(locale: Locale): void {
	if (typeof document !== 'undefined') {
		document.documentElement.lang = locale;
	}
}

// Register the custom Paraglide client strategy at module load (this module is
// imported for its side effect from the root layout, before any route/component
// renders), so getLocale()/setLocale() are wired before the first message call.
// The guards keep it inert on the server/prerender: getLocale returns undefined
// there, so Paraglide's strategy loop falls through to `baseLocale` (en) for the
// empty shell.
defineCustomClientStrategy('custom-banto', {
	getLocale: () => {
		if (typeof localStorage === 'undefined') return undefined; // server → baseLocale
		return readCachedLocale();
	},
	setLocale: (locale) => {
		// Paraglide only ever passes a valid Locale here. Write the FOUC cache
		// synchronously (always), update <html lang>, then persist to the
		// provider best-effort (M12), mirroring settings.svelte.ts.
		const next = locale as Locale;
		if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_KEY, next);
		applyHtmlLang(next);
		void getUiSettings()
			.set(LOCALE_SETTING, next)
			.catch(() => {});
	}
});

/**
 * Apply the cached locale to `<html lang>` on mount. Called once from the root
 * layout (next to `settings.init()`); no provider write since nothing changed.
 * app.html already sets `lang` before first paint, so this only keeps the DOM
 * in sync after hydration and centralizes the "lang follows locale" rule here.
 */
export function initLocale(): void {
	applyHtmlLang(readCachedLocale());
}

/**
 * Pull the saved locale from the `UiSettingsProvider` and cache it locally
 * (updating `<html lang>`). Called once per login from
 * `routes/(app)/+layout.ts`, right after `settings.syncFromProvider()`, so a
 * locale saved from another client/session beats this tab's stale localStorage.
 * Best-effort: an offline/unauthenticated read keeps the current value, and it
 * never echoes back to the provider. In B1 the value only needs to be cached +
 * `<html lang>` correct; the eager reload on an actual switch is the future B3
 * language-picker's job (Paraglide's `setLocale()` reloads by default).
 */
export async function syncLocaleFromProvider(): Promise<void> {
	try {
		const saved = await getUiSettings().get(LOCALE_SETTING);
		if (isLocale(saved) && typeof localStorage !== 'undefined') {
			localStorage.setItem(LOCALE_KEY, saved);
			applyHtmlLang(saved);
		}
	} catch {
		// Best-effort: offline/unauthenticated reads keep the local value.
	}
}
