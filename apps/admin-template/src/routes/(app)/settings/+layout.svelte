<script lang="ts">
	/**
	 * Settings shell (settings-routes step 2, choiapp-feedback-2026-09 §3.2 -
	 * overrides step 1/§3's "tabs vs anchors" call, see that doc section for
	 * why): a description + a category nav + the active category's own route
	 * rendered via `{@render children()}`.
	 *
	 * Categories come from `+layout.ts`'s visible subset (`data.categories`)
	 * so the nav only ever lists what the current session may reach - same
	 * capability-hide rule step 1 used for its in-page anchor nav (spec
	 * §11.3), now applied to real routes instead of anchors.
	 *
	 * The nav is a horizontal strip above the content at every width (no left
	 * rail any more, so the content is not narrowed next to the app sidebar).
	 *
	 * `.settings-page` stays the shared root class (unchanged from step 1)
	 * so `settings.css` - and every category page's markup classes
	 * (`.settings-section`/`.settings-grid`/etc.) - keep applying to
	 * whichever category page renders inside `{@render children()}`. The
	 * nav uses the shared @banto/theme/css page-link styles (ADR-0023);
	 * route selection and visibility remain in this layout.
	 *
	 * Copilot review on PR #198 also moved the shared cross-category stores'
	 * INITIAL loads here (see the `$effect`s below) - previously
	 * `authSettingsStore.load()`/`systemInfoStore.load()` only ran inside
	 * whichever section happened to own the mount effect
	 * (SecuritySection/ConnectivitySection), which was fine back when every
	 * category rendered on one page but left a direct visit to a
	 * READ-ONLY-consumer route (`/settings/account`'s autologin status,
	 * `/settings/connectivity`'s auth-disabled LAN gate,
	 * `/settings/data`'s `backupPostgresDialect`) with a `null` store
	 * forever. This layout is the one thing every category route shares, so
	 * loading here - with the exact same conditions those sections used -
	 * guarantees the value is fetched regardless of which category is opened
	 * first. Sections keep their own POST-SAVE reloads unchanged (only the
	 * mount-time fetch moved); see `authSettingsStore.svelte.ts` /
	 * `systemInfoStore.svelte.ts`'s doc comments for the corresponding
	 * `error` fields these effects write to.
	 */
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { isAdmin } from '#lib/permissions.js';
	import { isPathActive, resolveAppPath } from '#lib/navigation.js';
	import { errorMessage, tauri } from './shared';
	import { reloadAuthSettings } from './authSettingsStore.svelte';
	import { systemInfoStore } from './systemInfoStore.svelte';
	import type { SettingsCategory } from './categories';
	import type { LayoutProps } from './$types';
	import './settings.css';

	let { data, children }: LayoutProps = $props();

	/**
	 * Mirrors Sidebar.svelte's `isActive` / `navBadges.svelte.ts`'s
	 * `pathOwns`: a category owns its own path and any sub-path.
	 * `base`-prefixed (Copilot review on PR #198): `page.url.pathname`
	 * always includes the app's base path (e.g. the GitHub Pages demo's
	 * `BASE_PATH=/banto`), but `category.path` from `categories.ts` never
	 * does - comparing the bare path against it meant no category was ever
	 * active there.
	 */
	function isActive(category: SettingsCategory): boolean {
		return isPathActive(category.path, page.url.pathname);
	}

	// authSettingsStore's initial load (M11 login-not-required mode) - Tauri
	// only, same condition SecuritySection's own mount effect used.
	$effect(() => {
		if (!tauri) return;
		void reloadAuthSettings();
	});

	// systemInfoStore's initial load (M-review 2026-08 §2.4) - same
	// availability/role gate ConnectivitySection's own mount effect used.
	$effect(() => {
		if (!systemInfoStore.available || !isAdmin(sessionStore.role)) return;
		void (async () => {
			systemInfoStore.error = null;
			try {
				await systemInfoStore.load();
			} catch (err) {
				systemInfoStore.error = errorMessage(err);
			}
		})();
	});
</script>

<div class="page settings-page">
	<!-- The shell already shows the page title. Keep a document heading for
	     assistive technology without repeating the visible title in the content. -->
	<h1 class="sr-only">{m['nav.settings']()}</h1>
	<p class="settings-description">{m['settings.pageDescription']()}</p>

	<div class="settings-layout">
		<nav class="banto-section-nav" aria-label={m['settings.sectionNavAria']()}>
			{#each data.categories as category (category.id)}
				<a
					href={resolveAppPath(category.path)}
					aria-current={isActive(category) ? 'page' : undefined}
				>
					{m[category.labelKey]()}
				</a>
			{/each}
		</nav>

		<div class="settings-content">
			{@render children()}
		</div>
	</div>
</div>

<style>
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}

	.settings-description {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-md);
		text-wrap: pretty;
	}

	.settings-layout {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
		min-width: 0;
	}

	.settings-content {
		min-width: 0;
	}
</style>
