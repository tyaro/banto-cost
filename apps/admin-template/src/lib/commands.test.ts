/**
 * The palette's navigation commands follow `navSections()` (sidebar / dock):
 * a LAN viewer-public session (ADR-0012) and non-admin roles do not see pages
 * they cannot open.
 */
import { describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ publicViewer: false, role: 'viewer', authDisabled: false }));
vi.mock('./session.svelte', () => ({ sessionStore: session }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => `/${path}` }));
vi.mock('./banto/logout.svelte', () => ({ logoutAndLeave: vi.fn() }));
vi.mock('./banto/logoutNotice', () => ({ notifyLogoutOutcome: vi.fn() }));
vi.mock('./settings.svelte', () => ({ settings: {} }));

import { buildCommands } from './commands';
import { navItems } from './navigation';

function visibleNavPaths(): string[] {
	return buildCommands()
		.filter((c) => c.id.startsWith('nav.') && (c.visible?.() ?? true))
		.map((c) => c.id.slice('nav.'.length));
}

describe('navigation commands visibility', () => {
	it('publicViewer session sees only the allowlisted pages', () => {
		session.publicViewer = true;
		session.role = 'viewer';
		const allowed = navItems.filter((i) => i.publicViewer).map((i) => i.path);
		expect(visibleNavPaths()).toEqual(allowed);
		for (const i of navItems.filter((i) => !i.publicViewer)) {
			expect(visibleNavPaths()).not.toContain(i.path);
		}
	});

	it('publicViewer session never sees adminOnly pages, even with an admin role', () => {
		session.publicViewer = true;
		session.role = 'admin';
		for (const i of navItems.filter((i) => i.adminOnly)) {
			expect(visibleNavPaths()).not.toContain(i.path);
		}
	});

	it('a normal viewer sees everything except adminOnly', () => {
		session.publicViewer = false;
		session.role = 'viewer';
		expect(visibleNavPaths()).toEqual(navItems.filter((i) => !i.adminOnly).map((i) => i.path));
	});

	it('a normal admin sees every page', () => {
		session.publicViewer = false;
		session.role = 'admin';
		expect(visibleNavPaths()).toEqual(navItems.map((i) => i.path));
	});
});
