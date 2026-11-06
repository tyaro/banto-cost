/**
 * The `(app)` route guard and startup (Issue #321): opened before startup has
 * finished, the guard must neither wait for it (that kept the first load, and
 * with it the startup splash, blank while the server was unreachable) nor run
 * ahead of it - it defers before touching the session or any provider.
 */
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	ready: false,
	getSessionController: vi.fn(),
	getAuthProvider: vi.fn(),
	resolveSettled: vi.fn(),
	grantFallback: vi.fn(),
	publicNavItems: [] as { path: string }[]
}));

vi.mock('#lib/banto/setup.js', () => ({
	isBantoReady: () => mocks.ready,
	// A guard that awaited this would never settle while startup waits for the
	// user's reconnect - the bug this file pins down.
	bantoReady: new Promise<void>(() => {})
}));
vi.mock('@banto/admin-core', () => ({
	getSessionController: mocks.getSessionController,
	getAuthProvider: mocks.getAuthProvider,
	resolveSettled: mocks.resolveSettled,
	grantFallback: mocks.grantFallback
}));
vi.mock('#lib/paraglide/messages.js', () => ({
	'app.starting': () => '起動中…',
	'app.sessionCheckFailed.title': () => 'title',
	'app.sessionCheckFailed.body': () => 'body'
}));
vi.mock('#lib/banto/locale.js', () => ({ syncLocaleFromProvider: vi.fn(async () => {}) }));
vi.mock('#lib/settings.svelte.js', () => ({
	settings: { syncFromProvider: vi.fn(async () => {}) }
}));
// The real `resolveAppPath` (SvelteKit's `resolve()`, base path '' here):
// the public-viewer screen allowlist below must compare through it.
vi.mock('#lib/navigation.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/navigation.js')>()),
	publicNavItems: () => mocks.publicNavItems
}));

import { load } from './+layout';

type GuardEvent = Parameters<typeof load>[0];
const event = { url: new URL('http://127.0.0.1/dashboard') } as unknown as GuardEvent;

describe('(app) guard before startup has finished (Issue #321)', () => {
	beforeEach(() => {
		mocks.ready = false;
		mocks.publicNavItems = [];
		vi.clearAllMocks();
	});

	it('defers at once with the startup deferral, touching neither the session nor a provider', async () => {
		const settled = await Promise.race([
			load(event).then(
				() => ({ kind: 'returned' as const }),
				(err: unknown) => ({ kind: 'threw' as const, err })
			),
			new Promise<{ kind: 'pending' }>((resolve) =>
				setTimeout(() => resolve({ kind: 'pending' }), 50)
			)
		]);
		expect(settled.kind).toBe('threw');
		const err = (settled as { err: unknown }).err;
		expect(isHttpError(err, 503)).toBe(true);
		expect((err as { body: App.Error }).body.startupPending).toBe(true);
		expect(mocks.getSessionController).not.toHaveBeenCalled();
		expect(mocks.getAuthProvider).not.toHaveBeenCalled();
		expect(mocks.resolveSettled).not.toHaveBeenCalled();
	});

	it('confirms the session as usual once startup has finished', async () => {
		mocks.ready = true;
		const controller = {};
		mocks.getSessionController.mockReturnValue(controller);
		mocks.resolveSettled.mockResolvedValue({
			outcome: 'confirmed',
			snapshot: { status: 'active', kind: 'account', generation: 7 }
		});
		await expect(load(event)).resolves.toEqual({ sessionGeneration: 7 });
		expect(mocks.resolveSettled).toHaveBeenCalledWith(controller, { cause: 'navigation' });
	});

	it('a session check that cannot be verified is still the ordinary retry page, not the deferral', async () => {
		mocks.ready = true;
		mocks.getSessionController.mockReturnValue({});
		mocks.resolveSettled.mockResolvedValue({ outcome: 'unverified', snapshot: {} });
		const err = await load(event).then(
			() => null,
			(e: unknown) => e
		);
		expect(isHttpError(err, 503)).toBe(true);
		// The whole body, so the `error(status, message)` form (#325 PR3) is
		// pinned to what the `error(status, { message })` form produced.
		expect((err as { body: App.Error }).body).toEqual({ status: 503, message: 'title: body' });
	});
});

describe('(app) guard: public-viewer screen allowlist (viewer-public-plan §3.1-6)', () => {
	beforeEach(() => {
		mocks.ready = true;
		mocks.publicNavItems = [{ path: '/dashboard' }, { path: '/items' }];
		vi.clearAllMocks();
		mocks.getSessionController.mockReturnValue({});
		mocks.resolveSettled.mockResolvedValue({
			outcome: 'confirmed',
			snapshot: { status: 'active', kind: 'publicViewer', generation: 3 }
		});
	});

	const at = (pathname: string) =>
		({ url: new URL(`http://127.0.0.1${pathname}`) }) as unknown as GuardEvent;

	it('lets an allowlisted screen and its sub-paths open', async () => {
		await expect(load(at('/dashboard'))).resolves.toEqual({ sessionGeneration: 3 });
		await expect(load(at('/items'))).resolves.toEqual({ sessionGeneration: 3 });
		await expect(load(at('/items/42'))).resolves.toEqual({ sessionGeneration: 3 });
	});

	it('sends any other screen to the first allowlisted entry', async () => {
		for (const pathname of ['/users', '/itemsx', '/settings/appearance']) {
			const err = await load(at(pathname)).then(
				() => null,
				(e: unknown) => e
			);
			expect(isRedirect(err)).toBe(true);
			expect((err as { status: number; location: string }).location).toBe('/dashboard');
		}
	});
});
