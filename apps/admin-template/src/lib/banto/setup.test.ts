/**
 * Issue #396: `bantoReady` in the composition root must go by `isTauri()`'s
 * origin check. A Tauri window navigated to a local service
 * (`http://127.0.0.1:<port>`) still has `__TAURI_INTERNALS__`, yet must probe
 * the service and wire `server` mode without ever calling `invoke()`; on
 * Tauri's own origin it stays `tauri` and never probes. Runs the real
 * `environment.ts` / `startup.ts`; only `initBanto` / `connectEvents` and
 * Tauri's `invoke` are replaced (to see WHICH path was taken).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ initBanto: vi.fn(), connectEvents: vi.fn() }));
const tauriCore = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriCore.invoke }));
vi.mock('@banto/admin-core', async (importOriginal) => ({
	...(await importOriginal<typeof import('@banto/admin-core')>()),
	initBanto: core.initBanto,
	connectEvents: core.connectEvents
}));

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Warm the module graph once (setup.ts pulls in all of admin-core): a cold first
// import can exceed the default timeout on a loaded machine, which would leave
// that import running into the next test.
beforeAll(async () => {
	vi.stubGlobal('location', { origin: 'http://lan.test' });
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('<html>', { status: 404 }))
	);
	try {
		const setup = await import('./setup');
		await setup.bantoReady;
	} finally {
		vi.unstubAllGlobals();
		core.initBanto.mockReset();
		core.connectEvents.mockReset();
	}
}, 60_000);

beforeEach(() => {
	vi.resetModules();
	core.initBanto.mockReset();
	core.connectEvents.mockReset();
	tauriCore.invoke.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('bantoReady: a window that has __TAURI_INTERNALS__', { timeout: 30_000 }, () => {
	it('on a service origin (http://127.0.0.1:<port>): probes, wires server mode, never invokes', async () => {
		vi.stubGlobal('location', { origin: 'http://127.0.0.1:8721' });
		vi.stubGlobal('window', {
			__TAURI_INTERNALS__: {},
			location: { origin: 'http://127.0.0.1:8721' }
		});
		const fetchMock = vi.fn(async () => json(401, { kind: 'unauthorized' }));
		vi.stubGlobal('fetch', fetchMock);

		const setup = await import('./setup');
		await setup.bantoReady;

		expect(setup.isTauri()).toBe(false);
		expect(setup.getBantoMode()).toBe('server');
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:8721/api/auth/check',
			expect.anything()
		);
		expect(core.connectEvents).toHaveBeenCalledTimes(1);
		expect(tauriCore.invoke).not.toHaveBeenCalled();
	});

	it("on Tauri's own origin (http://tauri.localhost): tauri mode, no probe", async () => {
		vi.stubGlobal('location', { origin: 'http://tauri.localhost' });
		vi.stubGlobal('window', {
			__TAURI_INTERNALS__: {},
			location: { origin: 'http://tauri.localhost' }
		});
		const fetchMock = vi.fn(async () => json(200, false));
		vi.stubGlobal('fetch', fetchMock);

		const setup = await import('./setup');
		await setup.bantoReady;

		expect(setup.getBantoMode()).toBe('tauri');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
