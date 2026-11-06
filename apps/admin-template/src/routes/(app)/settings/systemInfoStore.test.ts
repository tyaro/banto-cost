import { beforeEach, describe, expect, it, vi } from 'vitest';
import { systemInfoStore } from './systemInfoStore.svelte';

/**
 * Issue #244: `systemInfoStore.available` used to be a `readonly` field
 * (`readonly available = isSystemInfoAvailable();`), evaluated exactly once
 * when this module was first imported. Route-level code splitting can import
 * this module before `bantoReady` (setup.ts) resolves and sets the real
 * `getBantoMode()` result - the field then froze at the default `'demo'`
 * reading (`available === false`) forever, hiding the System Info card and
 * skipping its `settings/+layout.svelte` load effect (E2E 11a flake).
 *
 * This mocks `#lib/banto/setup` (a mutable `mode` the test controls) so it
 * can reproduce that exact ordering: the store is imported ONCE, statically,
 * while the mode is still `'demo'` (module loaded ahead of `bantoReady`),
 * THEN the tests flip the mode to `'server'` (bantoReady resolves) without
 * re-importing - the regression is `available` never reflecting that later
 * flip. A frozen field would stay `false` and fail the `true` assertions.
 *
 * Why a static import rather than `vi.resetModules()` + `await import()` in
 * the test body: the first evaluation of the module graph (Svelte rune compile
 * of `systemInfoStore.svelte.ts` plus `#lib/banto/systemAdmin`'s imports) took
 * ~1s unloaded, and under CPU load (parallel cargo builds) blew vitest's 5s
 * per-test timeout. A static import pays that cost in vitest's collect phase,
 * outside the per-test timeout, and import-once is faithful to #244: the
 * regression is precisely "evaluated once at import, never re-read".
 */
// The hoisted initial mode is 'demo', and static imports are evaluated after
// vi.hoisted/vi.mock run, so the store module is first evaluated while the mode
// is 'demo' (the #244 ordering: module loaded before bantoReady resolves).
const setupMock = vi.hoisted(() => ({ mode: 'demo' as 'demo' | 'server' | 'tauri' }));
vi.mock('#lib/banto/setup.js', () => ({
	CSRF_HEADER: { 'X-Banto-Client': 'banto' },
	getBantoMode: () => setupMock.mode
}));

describe('systemInfoStore.available (Issue #244)', () => {
	beforeEach(() => {
		setupMock.mode = 'demo'; // each test starts as if bantoReady has not resolved
	});

	it('reflects a mode change to server AFTER import, without a re-import', () => {
		expect(systemInfoStore.available).toBe(false);

		setupMock.mode = 'server'; // simulates bantoReady resolving with a real backend
		expect(systemInfoStore.available).toBe(true);
	});

	it('is false again once demo mode is current, still without a re-import', () => {
		setupMock.mode = 'server';
		expect(systemInfoStore.available).toBe(true);

		setupMock.mode = 'demo';
		expect(systemInfoStore.available).toBe(false);
	});
});
