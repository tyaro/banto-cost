<script lang="ts">
	/**
	 * App shell sidebar (visual-refresh-design.md §8.3). Sections: top row
	 * (fold button + brand) / primary nav / admin nav (role-gated, own
	 * heading). The fold button is the first control of the top row, left of
	 * the logo, above 900px only (aria-controls="app-sidebar"); folded, the
	 * row keeps just that button, in the same place, so a second press
	 * unfolds. At <=900px the drawer is opened by Header.svelte's button.
	 * `overlayOpen` is owned by (app)/+layout.svelte (no
	 * new global store) and only matters at <=900px, where this component
	 * renders as a fixed slide-in drawer instead of the flex column.
	 */
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import {
		isPathActive,
		navGroups,
		navSections,
		resolveAppPath,
		type AppPath
	} from '#lib/navigation.js';
	import { NAV_ICONS } from './navIcons';
	import { navBadges } from '#lib/navBadges.svelte.js';
	import { settings } from '#lib/settings.svelte.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { narrowViewport } from '#lib/narrowViewport.svelte.js';
	import { IconButton } from '@banto/ui';
	import { PanelLeftClose, PanelLeftOpen } from '@lucide/svelte';

	interface Props {
		/** <=900px overlay drawer state (design.md §8.1); not a fold state - see the media query below. */
		overlayOpen?: boolean;
	}

	let { overlayOpen = false }: Props = $props();

	function isActive(path: AppPath): boolean {
		return isPathActive(path, page.url.pathname);
	}

	// RBAC hiding + viewer-public allowlist: see navSections() in #lib/navigation.ts.
	const sections = $derived(
		navSections({ publicViewer: sessionStore.publicViewer, role: sessionStore.role })
	);
	// banto-cost: the main entries under their work-order headings (review D-3).
	const mainGroups = $derived(navGroups(sections.main));
	const adminItems = $derived(sections.admin);

	const foldLabel = $derived(
		settings.sidebarCollapsed ? m['shell.expandSidebar']() : m['shell.collapseSidebar']()
	);

	/** Unseen-change badge text (wired by (app)/+layout.svelte). Capped for layout stability. */
	function badgeText(count: number): string {
		return count > 99 ? '99+' : String(count);
	}
</script>

<aside
	id="app-sidebar"
	class:collapsed={settings.sidebarCollapsed}
	class:overlay-open={overlayOpen}
	class:compact={settings.kiosk}
>
	<div class="brand" class:with-toggle={!narrowViewport.current}>
		{#if !narrowViewport.current}
			<!-- One persistent element: folding only changes its props, so focus
			     stays on it. Not rendered at <=900px (the header's drawer button
			     is the control there). -->
			<IconButton
				label={foldLabel}
				icon={settings.sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
				expanded={!settings.sidebarCollapsed}
				controls="app-sidebar"
				onclick={() => settings.toggleSidebar()}
			/>
		{/if}
		<!-- The logo is decoration, not a link or a toggle. Hidden while folded. -->
		<div class="brand-logo">
			<span class="brand-mark" aria-hidden="true">
				<svg viewBox="0 0 24 24" width="14" height="14">
					<rect x="10" y="3" width="4" height="2" rx="1" />
					<circle cx="12" cy="12" r="6" />
					<rect x="10" y="19" width="4" height="2" rx="1" />
				</svg>
			</span>
			<!-- "Banto" is the product brand (owner-fixed): kept as a component
			     constant, never keyed (PR-B2 scope rule). -->
			<span class="brand-name">Banto Cost</span>
		</div>
	</div>

	<nav class="nav-section" aria-label={m['shell.mainNav']()}>
		{#each mainGroups as group, gi (gi)}
			<div
				class="nav-group"
				role={group.group ? 'group' : undefined}
				aria-label={group.group ? m[group.group]() : undefined}
			>
				{#if group.group}
					<p class="section-heading" aria-hidden="true">{m[group.group]()}</p>
				{:else if gi > 0}
					<div class="group-divider"></div>
				{/if}
				{#each group.items as item (item.path)}
					{@const Icon = NAV_ICONS[item.icon]}
					{@const badgeCount = navBadges.count(item.path)}
					<a
						href={resolveAppPath(item.path)}
						class="nav-item"
						class:active={isActive(item.path)}
						aria-current={isActive(item.path) ? 'page' : undefined}
						title={settings.sidebarCollapsed ? m[item.labelKey]() : undefined}
					>
						<span class="icon"><Icon size={20} aria-hidden="true" /></span>
						<span class="label">{m[item.labelKey]()}</span>
						{#if badgeCount > 0}
							<span class="nav-badge" aria-label={m['shell.navUpdates']({ count: badgeCount })}
								>{badgeText(badgeCount)}</span
							>
						{/if}
					</a>
				{/each}
			</div>
		{/each}
	</nav>

	{#if adminItems.length > 0}
		<div class="section-divider"></div>
		<nav class="nav-section" aria-label={m['shell.adminNav']()}>
			<p class="section-heading" aria-hidden="true">{m['shell.adminHeading']()}</p>
			{#each adminItems as item (item.path)}
				{@const Icon = NAV_ICONS[item.icon]}
				{@const badgeCount = navBadges.count(item.path)}
				<a
					href={resolveAppPath(item.path)}
					class="nav-item"
					class:active={isActive(item.path)}
					aria-current={isActive(item.path) ? 'page' : undefined}
					title={settings.sidebarCollapsed ? m[item.labelKey]() : undefined}
				>
					<span class="icon"><Icon size={20} aria-hidden="true" /></span>
					<span class="label">{m[item.labelKey]()}</span>
					{#if badgeCount > 0}
						<span class="nav-badge" aria-label={m['shell.navUpdates']({ count: badgeCount })}
							>{badgeText(badgeCount)}</span
						>
					{/if}
				</a>
			{/each}
		</nav>
	{/if}
</aside>

<style>
	aside {
		/* Pinned to the viewport while the page body scrolls
		   (choiapp-feedback-2026-09 §2): sticky keeps the document itself as the one
		   scroll container (SvelteKit scroll handling, anchor links and
		   full-page screenshots all keep working), unlike an inner
		   overflow pane. Long nav lists scroll within the aside. */
		position: sticky;
		top: 0;
		height: 100vh;
		height: 100dvh;
		overflow-y: auto;
		width: var(--banto-shell-sidebar-width);
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		background: var(--banto-surface);
		border-right: var(--banto-border-width) solid var(--banto-border);
		transition: width var(--banto-duration-base) var(--banto-ease-out);
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}

	aside.collapsed {
		width: var(--banto-shell-sidebar-width-collapsed);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		height: var(--banto-shell-header-height);
		padding: 0 var(--banto-space-4);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		font-weight: 700;
	}

	/* Fold button at the left (>900px): space-2 matches the nav items' own
	   inset (space-2 section + space-2 item), so the 36px button is centred on
	   the icon column and fits the folded width exactly. */
	.brand.with-toggle {
		gap: var(--banto-space-1);
		padding: 0 var(--banto-space-2);
	}

	/* The button never shrinks while the aside's width transitions. */
	.brand.with-toggle :global(.icon-button) {
		flex-shrink: 0;
	}

	.brand-logo {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		min-width: 0;
		overflow: hidden;
		opacity: 1;
		transition:
			opacity var(--banto-duration-base) var(--banto-ease-out),
			visibility var(--banto-duration-base) var(--banto-ease-out);
	}

	/* Folded: the row keeps only the button. visibility (not just opacity)
	   takes the wordmark out of the accessibility tree. */
	aside.collapsed .brand-logo {
		opacity: 0;
		visibility: hidden;
	}

	/* Kiosk shell (display-preset-plan.md D1-b): keep the brand row aligned
	   with Header.svelte's compact height. */
	aside.compact .brand {
		height: var(--banto-shell-header-height-compact);
	}

	.brand-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 26px;
		height: 26px;
		border-radius: var(--banto-radius-md);
		background: var(--banto-accent-gradient);
	}

	.brand-mark svg {
		fill: var(--banto-text-inverse);
	}

	.brand-name {
		overflow: hidden;
		white-space: nowrap;
		opacity: 1;
		transition: opacity var(--banto-duration-base) var(--banto-ease-out);
	}

	.nav-section {
		display: flex;
		flex-direction: column;
		padding: var(--banto-space-2);
		gap: 2px;
	}

	.nav-group {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.group-divider {
		height: 1px;
		margin: var(--banto-space-2) var(--banto-space-2);
		background: var(--banto-border);
	}

	.section-divider {
		height: 1px;
		margin: var(--banto-space-1) var(--banto-space-4);
		background: var(--banto-border);
	}

	.section-heading {
		margin: var(--banto-space-2) var(--banto-space-2) var(--banto-space-1);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		overflow: hidden;
		white-space: nowrap;
		opacity: 1;
		transition: opacity var(--banto-duration-base) var(--banto-ease-out);
	}

	aside.collapsed .section-heading {
		opacity: 0;
	}

	.nav-item {
		position: relative;
		display: grid;
		/* Fixed icon column (design.md §8.3): the icon's X coordinate never
		   moves on collapse - only the label track shrinks with the aside's
		   own width transition above. The third (auto) track holds the
		   unseen-change badge and collapses to 0 when absent. */
		grid-template-columns: 20px minmax(0, 1fr) auto;
		align-items: center;
		column-gap: var(--banto-space-2);
		padding: var(--banto-space-2) var(--banto-space-2);
		border-radius: var(--banto-radius-md);
		color: var(--banto-text-muted);
		text-decoration: none;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.nav-item:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.nav-item.active {
		background: color-mix(in srgb, var(--banto-primary) 14%, transparent);
		/* axe-core wcag2aa color-contrast (visual-refresh-plan.md §7.1): plain
		   --banto-primary on this tint background measures ~4.24:1, just under
		   the 4.5:1 text minimum - --banto-primary-hover (already defined,
		   previously unused) is darker/lighter enough per theme to clear it. */
		color: var(--banto-primary-hover);
		font-weight: 600;
	}

	.nav-item.active::before {
		content: '';
		position: absolute;
		inset-block: 4px;
		left: 0;
		width: 2px;
		border-radius: 2px;
		background: var(--banto-primary);
	}

	/* Glass preset accent (spec M12): the active nav item gets the accent
	   gradient. Scoped by the preset attribute so standard keeps the flat
	   tint above untouched. */
	:global([data-banto-preset='glass']) .nav-item.active {
		background: var(--banto-accent-gradient);
		color: var(--banto-text-inverse);
	}

	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.label {
		overflow: hidden;
		white-space: nowrap;
		opacity: 1;
		transition: opacity var(--banto-duration-base) var(--banto-ease-out);
	}

	aside.collapsed .label {
		opacity: 0;
	}

	.nav-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
		font-size: var(--banto-font-size-xs);
		font-weight: 700;
		line-height: 1;
	}

	/* Collapsed fold (>900px): the label track is gone, so the count pill
	   degrades to an unread dot pinned to the icon's corner. The count text
	   stays in the DOM for the aria-label; it is hidden visually via a zero
	   font-size (an sr-only clip would collapse the dot box itself). */
	aside.collapsed .nav-badge {
		position: absolute;
		top: 4px;
		left: 24px;
		min-width: 8px;
		width: 8px;
		height: 8px;
		padding: 0;
		font-size: 0;
	}

	@media (max-width: 900px) {
		aside {
			position: fixed;
			inset: 0 auto 0 0;
			z-index: var(--banto-z-sidebar);
			/* Overlay mode has no fold concept (design.md §8.3): always full
			   width regardless of the persisted collapsed setting. */
			width: var(--banto-shell-sidebar-width);
			box-shadow: var(--banto-shadow-lg);
			transform: translateX(-100%);
			transition: transform var(--banto-duration-base) var(--banto-ease-spring);
		}

		aside.collapsed {
			width: var(--banto-shell-sidebar-width);
		}

		aside.collapsed .label,
		aside.collapsed .brand-logo,
		aside.collapsed .section-heading {
			opacity: 1;
			visibility: visible;
		}

		/* Overlay mode always shows labels, so the badge stays a count pill
		   (undo the collapsed-fold dot above). */
		aside.collapsed .nav-badge {
			position: static;
			min-width: 18px;
			width: auto;
			height: 18px;
			padding: 0 5px;
			font-size: var(--banto-font-size-xs);
		}

		aside.overlay-open {
			transform: translateX(0);
		}
	}
</style>
