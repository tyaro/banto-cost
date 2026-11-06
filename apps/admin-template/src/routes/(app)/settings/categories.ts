/**
 * Settings category table (settings-routes step 2,
 * choiapp-feedback-2026-09 §3.2). Single source of truth for the 5
 * categories' route `path` and nav label, consumed by:
 * - `+layout.ts` (filters this list down to the visible subset for the
 *   current session and returns it as `categories`);
 * - `+layout.svelte` (renders the category nav from that visible subset);
 * - `+page.ts` (redirects `/settings` to `categories[0].path`);
 * - each category's own `+page.ts` (`guardCategory` below).
 */
import { redirect } from '@sveltejs/kit';
import { resolveAppPath, type AppPath } from '#lib/navigation.js';

export type SettingsCategoryId = 'appearance' | 'account' | 'connectivity' | 'data' | 'security';

export interface SettingsCategory {
	id: SettingsCategoryId;
	path: AppPath;
	/** Paraglide message key (conventions §13) for the category's nav/heading label. */
	labelKey:
		| 'settings.sectionAppearance'
		| 'settings.sectionAccount'
		| 'settings.sectionConnectivity'
		| 'settings.sectionData'
		| 'settings.sectionSecurity';
}

/** Every category, in nav order - `+layout.ts` filters this to what the current session may see. */
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
	{ id: 'appearance', path: '/settings/appearance', labelKey: 'settings.sectionAppearance' },
	{ id: 'account', path: '/settings/account', labelKey: 'settings.sectionAccount' },
	{ id: 'connectivity', path: '/settings/connectivity', labelKey: 'settings.sectionConnectivity' },
	{ id: 'data', path: '/settings/data', labelKey: 'settings.sectionData' },
	{ id: 'security', path: '/settings/security', labelKey: 'settings.sectionSecurity' }
];

/**
 * Guard for a single category page's `+page.ts`: redirect to the first
 * VISIBLE category when `id` isn't in the visible subset `+layout.ts`
 * computed for this session (e.g. a non-admin LAN user typing
 * `/settings/security` directly). Same "hidden by navigation" philosophy as
 * `users/+page.ts` (spec M10), just parametrized by category id instead of
 * a single admin check.
 */
export function guardCategory(categories: SettingsCategory[], id: SettingsCategoryId): void {
	if (categories.some((category) => category.id === id)) return;
	const first = categories[0];
	if (first) redirect(307, resolveAppPath(first.path));
}
