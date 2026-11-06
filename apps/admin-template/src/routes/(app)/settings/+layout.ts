import { isAdmin } from '#lib/permissions.js';
import { sessionStore } from '#lib/session.svelte.js';
import { isAuditLogAvailable } from '#lib/banto/auditLogAdmin.js';
import { isBackupsAvailable } from '#lib/banto/backupsAdmin.js';
import { tauri } from './shared';
import { SETTINGS_CATEGORIES, type SettingsCategoryId } from './categories';

/**
 * Visible-category subset for the whole `settings/` route group
 * (settings-routes step 2, choiapp-feedback-2026-09 §3.2). `await parent()`
 * guarantees `(app)/+layout.ts` has already confirmed the session `sessionStore` is derived from before
 * these visibility checks run - same ordering requirement as
 * `users/+page.ts` (see `session.svelte.ts`'s doc comment).
 *
 * Visibility expressions are copied 1:1 from step 1's `+page.svelte`
 * (choiapp-feedback-2026-09 §3/§3.1) so behavior doesn't change - only the
 * URL shape does.
 */
export async function load({ parent }) {
	await parent();

	const auditAvailable = isAuditLogAvailable();
	const backupsAvailable = isBackupsAvailable();

	// ESCAPE HATCH (spec M11, mirrors step-1's comment / `auth_config_apply`'s
	// Rust doc comment): while login-not-required mode is CURRENTLY on, any
	// role may still reach the security category - otherwise a synthetic
	// session below `admin` (e.g. a kiosk set to `viewer`) could never turn
	// auth back on.
	const canManageAuthMode = isAdmin(sessionStore.role) || sessionStore.authDisabled;

	const visible: Record<SettingsCategoryId, boolean> = {
		appearance: true,
		account: true,
		connectivity: isAdmin(sessionStore.role),
		data: isAdmin(sessionStore.role) && (auditAvailable || backupsAvailable),
		security: tauri && canManageAuthMode
	};

	return { categories: SETTINGS_CATEGORIES.filter((category) => visible[category.id]) };
}
