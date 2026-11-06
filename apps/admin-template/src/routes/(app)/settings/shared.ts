/**
 * Small bits shared by 2+ of the settings/ section components
 * (AppearanceSection/AccountSection/ConnectivitySection/DataSection/
 * SecuritySection.svelte). This is the settings-split refactor's
 * "used-by-more-than-one" bucket - anything needed by exactly one section
 * stays local to that section's own `<script>` instead of moving here.
 *
 * Plain TS only (no runes) - the cross-section *reactive* state
 * (`AuthSettings`/`SystemInfo`) lives in `authSettingsStore.svelte.ts` /
 * `systemInfoStore.svelte.ts` instead, since Svelte 5 runes require a
 * `.svelte.ts` module (conventions §8).
 */
import { isProviderError } from '@banto/admin-core';
import { isTauri } from '#lib/banto/setup.js';

/**
 * `validation` `ProviderError`s (e.g. a corrupt/foreign backup file
 * rejected by `PRAGMA integrity_check`, spec M17) carry the server's
 * actual reason in `field_errors`, not in `Error.message` (which is just
 * the generic "validation failed" - see `packages/admin-core/src/errors.ts`'s
 * `describe()`). Surface that reason instead so a toast shown from it is
 * useful, not generic.
 */
export function errorMessage(err: unknown): string {
	if (isProviderError(err)) {
		if (err.body.kind === 'validation' && err.body.field_errors.length > 0) {
			return err.body.field_errors.map((fe) => fe.message).join(' / ');
		}
		return err.message;
	}
	return String(err);
}

/** Shared by ConnectivitySection's System Info card and DataSection's backup list (byte sizes). */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unitIndex = -1;
	do {
		value /= 1024;
		unitIndex++;
	} while (value >= 1024 && unitIndex < units.length - 1);
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}

// M6 Phase B (spec §11.4): the server controls only exist inside the Tauri
// webview - a LAN browser client has nothing here to configure (it IS the
// remote side of this same server). Decided once per page load (module
// singleton, read by every section below); isTauri() never changes at
// runtime.
export const tauri = isTauri();
