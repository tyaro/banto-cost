/**
 * Shared dashboard-panel id/title/icon defs (spec §5.3 v2 pop-out).
 *
 * A single source of truth used from TWO places:
 *  - the dashboard page (`routes/(app)/dashboard/+page.svelte`), which feeds
 *    this straight into `@banto/dock-svelte`'s `FloatingWindowDef[]` shape
 *    (`DockState.ensureWindow`/`reset`/its own `defaultLayout()`);
 *  - the standalone `routes/panel/[id]/+page.svelte` route, which is what a
 *    panel renders as once popped out into a REAL Tauri `WebviewWindow` (spec
 *    §5.3) - it has no access to the dashboard page's own locals, so it looks
 *    the title/icon up here instead.
 *
 * Kept as a plain array (not a `Record`) so it stays directly assignable to
 * `FloatingWindowDef[]`; `findPanelDef` below is the map-like lookup the
 * route needs.
 */
import type { FloatingWindowDef } from '@banto/dock-svelte';
import * as m from '#lib/paraglide/messages.js';

// i18n (ADR-0005, PR-B2/B2b): panel titles use a lazy `get title()` getter
// (typed `string`, so @banto/dock-svelte's `FloatingWindowDef` contract is
// untouched — conventions §4/§5) rather than an eager `m['…']()`. This module
// is evaluated at app startup BEFORE locale.ts registers the `custom-banto`
// strategy, so an eager call would freeze to the English `baseLocale`; the
// getter defers resolution to the point the title is read (the dashboard
// toolbar / `defaultLayout()` / the pop-out route), by which point the locale
// is resolved — keeping the default (ja) display byte-identical.
// NOTE (B3 follow-up): the dashboard serializes each panel's title INTO the
// persisted dock layout at the moment the layout is built, so a saved layout
// stores the title in whatever locale was active then. That is invisible for a
// single-locale (ja) install, but a future language switch (B3) should key the
// layout on panel id and resolve titles at render, not persist them.
export const PANEL_DEFS: FloatingWindowDef[] = [
	{
		id: 'monthly',
		get title() {
			return m['panels.monthly']();
		},
		icon: '📈',
		width: 420,
		height: 320
	},
	{
		id: 'priceBuckets',
		get title() {
			return m['panels.priceBuckets']();
		},
		icon: '🥧',
		width: 360,
		height: 320
	},
	// M13 (roadmap.md): SPC panel (histogram + Pareto + box plot, one SVG
	// export button) and a streaming trend panel (zoom/pan, bands, markers,
	// second y-axis). Not in `defaultLayout()`'s docked split - they only
	// appear once toggled from the toolbar, so an existing saved layout
	// (seeded before M13) is never disturbed (spec: 既存パネルのレイアウトを壊さない).
	{
		id: 'spc',
		get title() {
			return m['panels.spc']();
		},
		icon: '📊',
		width: 460,
		height: 640
	},
	{
		id: 'trend',
		get title() {
			return m['panels.trend']();
		},
		icon: '📉',
		width: 640,
		height: 360
	},
	{
		id: 'memo',
		get title() {
			return m['panels.memo']();
		},
		icon: '📝',
		width: 320,
		height: 220
	}
];

/** Look up a panel def by id; `undefined` for an unknown id (e.g. a stale/typo'd panel window). */
export function findPanelDef(id: string): FloatingWindowDef | undefined {
	return PANEL_DEFS.find((def) => def.id === id);
}
