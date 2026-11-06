/**
 * Base-path-aware app path helpers, kept free of the paraglide messages so
 * logic-layer stores (`navBadges`) and their tests can import them alone.
 * Re-exported from `navigation.ts`.
 */
import { resolve } from '$app/paths';
import type { Path, ResolvedPathname } from '$app/types';

/**
 * An app route's pathname as written in the nav/category tables: a leading
 * `/` and no base path (e.g. `/items`, `/settings/appearance`). Typed from
 * SvelteKit 3's generated `Path` union, so a table entry pointing at a route
 * that does not exist is a type error. The tables keep the leading `/` because
 * it is also what they compare against (`pageTitle`, `navBadges`, the
 * public-viewer guard in `routes/(app)/+layout.ts`).
 */
export type AppPath = `/${Path}`;

/**
 * `AppPath` -> the href / `goto()` target with the base path prefixed
 * (SvelteKit 3 `resolve()`, which takes the pathname without its leading
 * `/`). Use this, not string concatenation, wherever an `AppPath` leaves the
 * app as a URL.
 */
export function resolveAppPath(path: AppPath): ResolvedPathname {
	return resolve(path.slice(1) as Path);
}

/**
 * Does `pathname` (a `page.url.pathname` / `navigation.to.url.pathname`, which
 * always carries the base path) lie on `path` or under it (`/items` owns
 * `/items` and `/items/3`)? The one place that compares a table path with a
 * real pathname: it resolves `path` first, so it also holds under a non-empty
 * `BASE_PATH` (the Pages demo, #332). With an empty base it is the plain
 * `pathname === path || pathname.startsWith(path + '/')`.
 */
export function isPathActive(path: AppPath, pathname: string): boolean {
	const full = resolveAppPath(path);
	return pathname === full || pathname.startsWith(full + '/');
}
