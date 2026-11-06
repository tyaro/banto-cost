/**
 * Banto theme runtime: resolves a ThemeMode preference to a concrete
 * light/dark theme on <html data-theme="...">, following the OS setting
 * when mode is "system" (spec §8.2).
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
	if (mode === 'system') {
		return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
	}
	return mode;
}

/** Apply the resolved theme to the document root. */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
	const resolved = resolveTheme(mode);
	document.documentElement.dataset.theme = resolved;
	return resolved;
}

/**
 * Keep the document in sync with the OS theme while mode is "system".
 * Returns an unsubscribe function.
 */
export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
	const query = window.matchMedia(DARK_QUERY);
	const handler = (event: MediaQueryListEvent) => {
		onChange(event.matches ? 'dark' : 'light');
	};
	query.addEventListener('change', handler);
	return () => query.removeEventListener('change', handler);
}

export function isThemeMode(value: unknown): value is ThemeMode {
	return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Theme PRESET axis (spec M12), orthogonal to the light/dark mode above:
 * `data-theme` (light/dark) x `data-banto-preset` (standard/glass) on
 * <html>. `standard` is the existing opaque look; `glass` switches the
 * shell surfaces to translucent + backdrop-filter via the variable
 * overrides in css/banto-glass.css (loaded together with banto.css;
 * inert unless the attribute says `glass`).
 */
export type ThemePreset = 'standard' | 'glass';

/** Apply the preset to the document root (`data-banto-preset`). */
export function applyPreset(preset: ThemePreset): void {
	document.documentElement.dataset.bantoPreset = preset;
}

export function isThemePreset(value: unknown): value is ThemePreset {
	return value === 'standard' || value === 'glass';
}

/**
 * Theme DENSITY axis (spec visual-refresh-design.md §4), orthogonal to mode
 * and preset above: `data-banto-density` on <html>. `standard` is the
 * existing control/grid-row sizing; `compact` switches to the smaller
 * dimension tokens defined under [data-banto-density="compact"] in
 * css/banto.css (a pure variable swap, same approach as the preset axis).
 */
export type ThemeDensity = 'standard' | 'compact';

/** Apply the density to the document root (`data-banto-density`). */
export function applyDensity(density: ThemeDensity): void {
	document.documentElement.dataset.bantoDensity = density;
}

export function isThemeDensity(value: unknown): value is ThemeDensity {
	return value === 'standard' || value === 'compact';
}
