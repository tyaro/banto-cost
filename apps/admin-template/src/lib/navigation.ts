/**
 * Sidebar navigation definition.
 *
 * From M2, entries for CRUD pages are derived from resource definitions
 * (spec §3.1); manual entries like the ones below remain possible.
 */
import { isPathActive, type AppPath } from '#lib/appPath.js';
import type { RouteId } from '$app/types';
import { isDemoBuild } from '#lib/banto/environment.js';
import { resources } from '#lib/banto/resources/index.js';
import { isAdmin, type Role } from '#lib/permissions.js';
import * as m from '#lib/paraglide/messages.js';

/** Icon resolution key (visual-refresh-design.md §5.1). Resolved to an actual
 *  icon component only in the display layer (#lib/components/navIcons.ts) -
 *  this module stays UI-agnostic. */
export type NavIconKey = 'dashboard' | 'users' | 'audit-log' | 'settings';

/** Paraglide message key for a nav entry's visible label (i18n layer ②,
 *  ADR-0005). The label itself is resolved at render time via `m[labelKey]()`
 *  so it tracks the active locale — see `pageTitle` below and Sidebar.svelte. */
export type NavLabelKey = 'nav.dashboard' | 'nav.users' | 'nav.auditLog' | 'nav.settings';

/** banto-cost business screens (P3a). A separate union rather than more members in
 *  the two above: scaffold's removers edit those by exact text (scripts/scaffold.mjs). */
export type CostNavIconKey =
	| 'pipeline'
	| 'outlook'
	| 'projects'
	| 'customers'
	| 'calc-basis'
	| 'time'
	| 'approvals'
	| 'costs'
	| 'closing'
	| 'fixed-costs'
	| 'recurring-revenue'
	| 'work-masters';
export type CostNavLabelKey =
	| 'nav.pipeline'
	| 'nav.outlook'
	| 'nav.projects'
	| 'nav.customers'
	| 'nav.calcBasis'
	| 'nav.time'
	| 'nav.approvals'
	| 'nav.costs'
	| 'nav.closing'
	| 'nav.fixedCosts'
	| 'nav.recurringRevenue'
	| 'nav.workMasters';

/** Keys of the demo-only catalog entry (`NavItem.demoOnly`). Kept out of the unions above on purpose:
 *  scaffold's removers edit those unions by exact text (scripts/scaffold.mjs). */
export type DemoNavIconKey = 'ui-demo';
export type DemoNavLabelKey = 'nav.uiDemo';

export interface NavItem {
	path: AppPath;
	labelKey: NavLabelKey | CostNavLabelKey | DemoNavLabelKey;
	icon: NavIconKey | CostNavIconKey | DemoNavIconKey;
	/** Resource whose current localized label is passed to route-specific titles. */
	pageTitleResource?: string;
	/** Exact route IDs keep static child pages distinct from record-edit routes. */
	pageTitles?: Partial<Record<RouteId, (resourceLabel: string) => string>>;
	/** Spec M10 RBAC: only shown to the `admin` role. Undefined/false = visible to every role. */
	adminOnly?: boolean;
	/**
	 * admin-core resource name whose `invalidate()` bus (spec §3.4 - own
	 * mutations AND `resource_changed` server events) feeds this entry's
	 * unseen-change badge (#lib/navBadges.svelte.ts, wired by
	 * routes/(app)/+layout.svelte). Undefined = no badge for this entry.
	 */
	badgeResource?: string;

	/**
	 * Opt-in allowlist for the LAN "viewer-public" session
	 * (viewer-public-plan §3.1-6, ADR-0012): `sessionStore.publicViewer`
	 * sessions see ONLY entries with `publicViewer: true` in the sidebar, and
	 * `(app)/+layout.ts`'s guard redirects any other path to the first such
	 * entry. This narrows the SCREEN surface only - the actual data boundary
	 * is RBAC's `viewer` role (ADR-0012 §帰結), so this flag must never be
	 * treated as an authorization check. Undefined/false = hidden from a
	 * public-viewer session. banto-cost: `/dashboard` only (the template's
	 * `/items` demo was removed).
	 */
	publicViewer?: boolean;

	/**
	 * Show this entry in the sidebar / command palette only in the static demo
	 * build (`VITE_BANTO_DEMO=1`, see `isDemoBuild`). The route itself stays
	 * reachable by URL in every build - this hides the nav entry, nothing more
	 * (a catalog page like `/ui-demo`, not a feature).
	 */
	demoOnly?: boolean;
}

export { isPathActive, resolveAppPath, type AppPath } from '#lib/appPath.js';

const allNavItems: NavItem[] = [
	{ path: '/dashboard', labelKey: 'nav.dashboard', icon: 'dashboard', publicViewer: true },
	// banto-cost P3a. Not `publicViewer`: amounts and project scope are capability-gated.
	{ path: '/pipeline', labelKey: 'nav.pipeline', icon: 'pipeline' },
	// banto-cost P3b: 月次売上見通し (amounts, scope `amount_projects`).
	{ path: '/outlook', labelKey: 'nav.outlook', icon: 'outlook' },
	{
		path: '/projects',
		labelKey: 'nav.projects',
		icon: 'projects',
		badgeResource: 'projects',
		pageTitleResource: 'projects',
		pageTitles: {
			'/(app)/projects/new': (resource) => m['projects.createTitle']({ resource }),
			'/(app)/projects/[id]': (resource) => m['projects.editTitle']({ resource })
		}
	},
	{
		path: '/customers',
		labelKey: 'nav.customers',
		icon: 'customers',
		badgeResource: 'customers',
		pageTitleResource: 'customers',
		pageTitles: {
			'/(app)/customers/new': (resource) => m['customers.createTitle']({ resource }),
			'/(app)/customers/[id]': (resource) => m['customers.editTitle']({ resource })
		}
	},
	// banto-cost P4b: 工数入力・承認一覧 (spec §6.1 / §9). Capability-gated by the server.
	{ path: '/time', labelKey: 'nav.time', icon: 'time' },
	// banto-cost P4d: 直接費入力 (spec §6.3 / §9). Capability-gated by the server.
	{ path: '/costs', labelKey: 'nav.costs', icon: 'costs' },
	{ path: '/approvals', labelKey: 'nav.approvals', icon: 'approvals' },
	// banto-cost P4a: 計算基準 (design 第10章). Amounts: capability-gated by the server.
	{ path: '/calc-basis', labelKey: 'nav.calcBasis', icon: 'calc-basis' },
	// banto-cost P6b: 月次締め (spec §7 / §9, T11). Accounting only (finance.close, server-side).
	{ path: '/closing', labelKey: 'nav.closing', icon: 'closing' },
	// banto-cost P7b: 月額固定原価 (design §9.4, T37). finance.rate + amount.view (server-side).
	{ path: '/fixed-costs', labelKey: 'nav.fixedCosts', icon: 'fixed-costs' },
	// banto-cost P7c: 定期売上 (design §9.4, T38). finance.close + amount.view (server-side).
	{ path: '/recurring-revenue', labelKey: 'nav.recurringRevenue', icon: 'recurring-revenue' },
	// banto-cost P4b: 工程・共通活動 masters (spec §5.2).
	{ path: '/work-masters', labelKey: 'nav.workMasters', icon: 'work-masters' },
	{ path: '/ui-demo', labelKey: 'nav.uiDemo', icon: 'ui-demo', demoOnly: true },
	{ path: '/users', labelKey: 'nav.users', icon: 'users', adminOnly: true },
	{ path: '/audit-log', labelKey: 'nav.auditLog', icon: 'audit-log', adminOnly: true },
	{ path: '/settings', labelKey: 'nav.settings', icon: 'settings' }
];

/** The entries the shell shows: `demoOnly` ones only in the demo build (`isDemoBuild()` is a build-time constant). */
export const navItems: NavItem[] = allNavItems.filter((item) => !item.demoOnly || isDemoBuild());

/** `navItems` entries visible to a LAN "viewer-public" session (see `NavItem.publicViewer`'s doc comment). Order preserved - the first entry is the guard's redirect target. */
export function publicNavItems(): NavItem[] {
	return navItems.filter((item) => item.publicViewer);
}

/**
 * The sidebar's two sections for a session: `main` (primary nav) and `admin`
 * (own heading). Pure - the session values come in as arguments so this module
 * stays UI-agnostic (Sidebar.svelte passes `sessionStore` fields).
 *
 * Spec M10 RBAC: admin-only entries (the user-management page) are hidden
 * rather than shown disabled - navigation-level hiding, same as
 * routes/(app)/users/+page.ts redirecting a non-admin instead of rendering a
 * 403 screen.
 *
 * viewer-public-plan §3.1-6 (ADR-0012): a LAN "viewer-public" session sees ONLY
 * the `publicViewer` allowlist and never the admin section, regardless of role
 * (a publicViewer grant identity's role is always `viewer`, so `admin` would
 * already be empty, but the explicit check keeps this correct even if that
 * ever changed).
 */
export function navSections(session: { publicViewer: boolean; role: Role }): {
	main: NavItem[];
	admin: NavItem[];
} {
	return {
		main: session.publicViewer ? publicNavItems() : navItems.filter((item) => !item.adminOnly),
		admin:
			!session.publicViewer && isAdmin(session.role)
				? navItems.filter((item) => item.adminOnly)
				: []
	};
}

// "Banto" is the product brand (owner-fixed): kept as a component constant,
// never entered into the dictionary (PR-B2 scope rule).
const BRAND = 'Banto Cost';

export function pageTitle(pathname: string, routeId?: RouteId | null): string {
	// Over every entry, not just the visible ones: a `demoOnly` page keeps its title when opened by URL.
	const item = allNavItems.find((entry) => isPathActive(entry.path, pathname));
	if (!item) return BRAND;
	const title = routeId ? item.pageTitles?.[routeId] : undefined;
	if (title) {
		// Read the definition lazily: localized getters and replacement resources
		// work without requiring the runtime registry to have been initialized.
		const label = resources.find((resource) => resource.name === item.pageTitleResource)?.label;
		return title(label ?? m[item.labelKey]());
	}
	return m[item.labelKey]();
}
