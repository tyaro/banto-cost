/**
 * Shared `AuthSettings` (M11 login-not-required mode) load state. Module
 * singleton (same pattern as `#lib/session.svelte.ts`), needed here because
 * the settings-split refactor (choiapp-feedback-2026-09 §3) has THREE
 * readers of the same loaded value in different components:
 * - `AccountSection.svelte`'s autologin card (read-only; also refreshes it
 *   via `load()` after enabling/disabling autologin).
 * - `ConnectivitySection.svelte`'s LAN-toggle gating (read-only:
 *   `value?.disabled`).
 * - `SecuritySection.svelte`, which owns the mutating controls
 *   (`disabledDraft`/`disabledRoleDraft`) and re-syncs its own drafts via its
 *   own `$effect` whenever `.value` changes here - including when
 *   AccountSection's autologin actions call `load()`.
 *
 * The INITIAL load (settings-routes step 2, Copilot review on PR #198) now
 * runs once in the persistent `settings/+layout.svelte` instead of inside
 * SecuritySection's own mount effect - a direct visit to
 * `/settings/account` or `/settings/connectivity` needs this value too
 * (autologin status / the LAN auth-disabled gate) and neither of those
 * sections' own routes used to run SecuritySection's effect. `error` mirrors
 * that same move: the layout's load effect writes here instead of a
 * SecuritySection-local `authError`, so the section can keep showing the
 * same error text without owning the fetch.
 */
import { getAuthSettings, type AuthSettings } from '#lib/banto/authAdmin.js';
import { errorMessage } from './shared';

class AuthSettingsStore {
	value: AuthSettings | null = $state(null);
	error: string | null = $state(null);

	async load(): Promise<void> {
		// Module singleton (unlike the former page-local `$state(null)`): a
		// revisit of /settings would otherwise render the PREVIOUS response
		// while this fetch is pending (stale uptime/sessions/metrics, or
		// drafts seeded from an old AuthSettings that a save could then
		// overwrite). Reset first so consumers see "unknown" until it lands -
		// same lifecycle the old per-mount state had (Copilot review on PR #197).
		this.value = null;
		this.value = await getAuthSettings();
	}
}

export const authSettingsStore = new AuthSettingsStore();

/**
 * Load with the error written to `authSettingsStore.error` instead of thrown:
 * the layout's initial load, and SecuritySection's retry button (owner
 * review on PR #232 - its drafts stay disabled until this succeeds).
 */
export async function reloadAuthSettings(): Promise<void> {
	authSettingsStore.error = null;
	try {
		await authSettingsStore.load();
	} catch (err) {
		authSettingsStore.error = errorMessage(err);
	}
}
