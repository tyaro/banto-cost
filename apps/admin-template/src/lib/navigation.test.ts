/**
 * #332: under a non-empty `BASE_PATH` (the GitHub Pages demo) `page.url.pathname`
 * carries the base while the nav tables hold base-less paths. `isPathActive` /
 * `pageTitle` / `navBadges` must still match. `$app/paths`' `resolve` is mocked
 * to prepend a configurable base (SvelteKit 3: `resolve('items')` -> `base/items`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidate, onInvalidate } from '@banto/admin-core';
import type { RouteId } from '$app/types';
import { resources } from './banto/resources';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('$app/paths', () => ({
	resolve: (path: string) => `${state.base}/${path}`
}));

import { isPathActive, navItems, navSections, pageTitle, type AppPath } from './navigation';
import { navBadges } from './navBadges.svelte';
import * as m from '#lib/paraglide/messages.js';

// Scaffold presets remove nav entries (items, dashboard, ...), so the cases below
// derive their paths and titles from whatever `navItems` the copy still has.
const first = navItems[0];
const other = navItems[1];

describe.each(['', '/banto'])('base=%j', (base) => {
	afterEach(() => {
		state.base = '';
	});
	const at = (p: string) => {
		state.base = base;
		return `${base}${p}`;
	};

	it('isPathActive owns the path and its sub-paths only', () => {
		expect(isPathActive(first.path, at(first.path))).toBe(true);
		expect(isPathActive(first.path, at(`${first.path}/3`))).toBe(true);
		expect(isPathActive(first.path, at(`${first.path}-other`))).toBe(false);
		expect(isPathActive(other.path, at(first.path))).toBe(false);
	});

	it('pageTitle resolves the entry title from a base-carrying pathname', () => {
		expect(pageTitle(at(first.path))).toBe(m[first.labelKey]());
		expect(pageTitle(at(`${first.path}/3`))).toBe(m[first.labelKey]());
		expect(pageTitle(at('/nowhere'))).toBe('Banto');
	});

	it('uses exact route titles and preserves entry and unknown-route fallbacks', () => {
		for (const entry of navItems) {
			for (const [route, title] of Object.entries(entry.pageTitles ?? {})) {
				const routeId = route as RouteId;
				const path = route.replace(/\/\([^/]+\)/g, '').replace(/\[[^/]+\]/g, 'record-42');
				const label = resources.find(
					(resource) => resource.name === entry.pageTitleResource
				)?.label;
				expect(pageTitle(at(path), routeId)).toBe(title(label ?? m[entry.labelKey]()));
				expect(pageTitle(at(`${path}/`), routeId)).toBe(title(label ?? m[entry.labelKey]()));
				expect(pageTitle(at(path))).toBe(m[entry.labelKey]());
				expect(pageTitle(at(path), null)).toBe(m[entry.labelKey]());
				expect(pageTitle(at('/nowhere'), routeId)).toBe('Banto');
				// Keep the route group, but choose an unconfigured static sibling.
				const reportRoute = route.replace(/\/[^/]+$/, '/report') as RouteId;
				expect(pageTitle(at(`${entry.path}/report`), reportRoute)).toBe(m[entry.labelKey]());

				const resourceIndex = resources.findIndex(
					(resource) => resource.name === entry.pageTitleResource
				);
				if (resourceIndex >= 0) {
					const original = resources[resourceIndex];
					try {
						resources[resourceIndex] = { ...original, label: 'Replacement resource' };
						expect(pageTitle(at(path), routeId)).toBe(title('Replacement resource'));
					} finally {
						resources[resourceIndex] = original;
					}
				}
			}
		}
	});

	it('navBadges counts elsewhere, not on the owning page, and clears on arrival', () => {
		const key = '/nbt-items' as AppPath;
		const off = onInvalidate('nbt-items', (_r, reason) =>
			navBadges.noteInvalidation(key, at(first.path), reason)
		);
		invalidate('nbt-items');
		expect(navBadges.count(key)).toBe(1);
		navBadges.noteInvalidation(key, at('/nbt-items/3'), 'change');
		expect(navBadges.count(key)).toBe(1);
		navBadges.clearFor(at('/nbt-items/3'));
		expect(navBadges.count(key)).toBe(0);
		off();
	});
});

// navSections() (nav-launcher-plan PR-1): expectations derive from `navItems` so the
// table also holds for scaffold presets that remove entries.
describe('navSections', () => {
	const paths = (items: { path: string }[]) => items.map((item) => item.path);
	const normal = navItems.filter((item) => !item.adminOnly);
	const adminOnly = navItems.filter((item) => item.adminOnly);
	const publicOnly = navItems.filter((item) => item.publicViewer);

	it.each([
		{ name: 'viewer', publicViewer: false, role: 'viewer' as const, main: normal, admin: [] },
		{ name: 'editor', publicViewer: false, role: 'editor' as const, main: normal, admin: [] },
		{ name: 'admin', publicViewer: false, role: 'admin' as const, main: normal, admin: adminOnly },
		{
			name: 'publicViewer',
			publicViewer: true,
			role: 'viewer' as const,
			main: publicOnly,
			admin: []
		},
		{
			name: 'publicViewer with role admin',
			publicViewer: true,
			role: 'admin' as const,
			main: publicOnly,
			admin: []
		}
	])('$name: main/admin contents and order', ({ publicViewer, role, main, admin }) => {
		const sections = navSections({ publicViewer, role });
		expect(paths(sections.main)).toEqual(paths(main));
		expect(paths(sections.admin)).toEqual(paths(admin));
	});

	it('never lists a demoOnly entry in a non-demo build', () => {
		for (const publicViewer of [false, true]) {
			const { main, admin } = navSections({ publicViewer, role: 'admin' });
			expect([...main, ...admin].some((item) => item.demoOnly)).toBe(false);
		}
	});

	it('keeps admin-only entries out of main for every session', () => {
		for (const publicViewer of [false, true]) {
			expect(navSections({ publicViewer, role: 'admin' }).main.some((i) => i.adminOnly)).toBe(
				false
			);
		}
	});
});
