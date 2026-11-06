/**
 * The origin check in `isTauri()` (Issue #396). When a Tauri shell navigates
 * its WebView to a local service (`http://127.0.0.1:<port>/`), Tauri injects
 * `__TAURI_INTERNALS__` into that window too. Detecting by the internals alone
 * would pick the `invoke()` path there and break, so the origin has to be one
 * where Tauri serves its own assets as well.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import tauriConf from '../../../src-tauri/tauri.conf.json';
import { TAURI_DEV_ORIGIN, TAURI_ORIGINS, isTauri, isTauriOrigin } from './environment';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('isTauriOrigin (pure)', () => {
	const cases: [string, string | undefined, boolean][] = [
		['http://tauri.localhost', undefined, true],
		['https://tauri.localhost', undefined, true],
		['tauri://localhost', undefined, true],
		// A local service / LAN page is not Tauri's own.
		['http://127.0.0.1:8721', undefined, false],
		['http://localhost:8721', undefined, false],
		['http://[::1]:8721', undefined, false],
		['http://192.0.2.10:8721', undefined, false],
		// The dev origin counts only when the caller passes it (a dev build).
		['http://localhost:1420', undefined, false],
		['http://localhost:1420', TAURI_DEV_ORIGIN, true],
		['http://127.0.0.1:8721', TAURI_DEV_ORIGIN, false],
		// Look-alikes are rejected.
		['http://tauri.localhost.evil.example', undefined, false],
		['http://tauri.localhost:8080', undefined, false]
	];
	for (const [origin, devOrigin, expected] of cases) {
		it(`${origin} (dev: ${devOrigin ?? 'none'}) -> ${expected}`, () => {
			expect(isTauriOrigin(origin, devOrigin)).toBe(expected);
		});
	}

	it('TAURI_ORIGINS is the Windows (http / https) and macOS / Linux trio', () => {
		expect([...TAURI_ORIGINS].sort()).toEqual(
			['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'].sort()
		);
	});
});

describe('TAURI_DEV_ORIGIN matches tauri.conf.json devUrl', () => {
	it('is the origin of build.devUrl', () => {
		expect(new URL(tauriConf.build.devUrl).origin).toBe(TAURI_DEV_ORIGIN);
	});
});

describe('isTauri()', () => {
	it('is false without a window (SSR / node)', () => {
		expect(isTauri()).toBe(false);
	});

	it('is false without the internals, even on a Tauri origin', () => {
		vi.stubGlobal('window', { location: { origin: 'http://tauri.localhost' } });
		expect(isTauri()).toBe(false);
	});

	it("is true with the internals on Tauri's own origin", () => {
		for (const origin of TAURI_ORIGINS) {
			vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, location: { origin } });
			expect(isTauri()).toBe(true);
		}
	});

	it('is false with the internals in a window navigated to a service (127.0.0.1)', () => {
		vi.stubGlobal('window', {
			__TAURI_INTERNALS__: {},
			location: { origin: 'http://127.0.0.1:8721' }
		});
		expect(isTauri()).toBe(false);
	});

	it('counts the `tauri dev` origin in a dev build (vitest is DEV)', () => {
		expect(import.meta.env.DEV).toBe(true);
		vi.stubGlobal('window', {
			__TAURI_INTERNALS__: {},
			location: { origin: TAURI_DEV_ORIGIN }
		});
		expect(isTauri()).toBe(true);
	});

	it('does not count the dev origin in a production build', () => {
		vi.stubEnv('DEV', false);
		vi.stubGlobal('window', {
			__TAURI_INTERNALS__: {},
			location: { origin: TAURI_DEV_ORIGIN }
		});
		expect(isTauri()).toBe(false);
	});
});
