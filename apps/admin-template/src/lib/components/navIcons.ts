/**
 * Icon resolution for navigation entries (visual-refresh-design.md §5.2).
 *
 * `navigation.ts` stays UI-agnostic and only holds the `NavIconKey` string
 * key; the actual icon component is resolved here, in the display layer.
 */
import type { Component } from 'svelte';
import { LayoutDashboard, Users, ScrollText, Settings } from '@lucide/svelte';
import { Palette } from '@lucide/svelte';
import { Building, CalendarRange, FolderKanban, TrendingUp } from '@lucide/svelte';
import type { CostNavIconKey, DemoNavIconKey, NavIconKey } from '#lib/navigation.js';

export const NAV_ICONS: Record<NavIconKey | CostNavIconKey | DemoNavIconKey, Component> = {
	dashboard: LayoutDashboard,
	users: Users,
	'audit-log': ScrollText,
	settings: Settings,
	'ui-demo': Palette,
	pipeline: TrendingUp,
	outlook: CalendarRange,
	projects: FolderKanban,
	customers: Building
};
