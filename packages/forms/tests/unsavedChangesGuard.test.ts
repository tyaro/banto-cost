// @vitest-environment jsdom
/**
 * `guardUnsavedChanges` component wiring (spec §7, issue #214): guards join
 * the shared registry on mount and leave it on destroy, several guards on
 * one screen answer a navigation with ONE prompt, and a save in flight
 * counts as pending. `beforeNavigate` is a fake that records callbacks the
 * way SvelteKit does (every callback receives the same navigation object).
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GuardHarness from './GuardHarness.svelte';
import {
	hasUnsavedChanges,
	type LeaveNavigation,
	type UnsavedChangesGuard
} from '../src/unsavedChanges.svelte';

afterEach(cleanup);

function fakeRouter() {
	const callbacks: ((navigation: LeaveNavigation) => void)[] = [];
	return {
		beforeNavigate: (callback: (navigation: LeaveNavigation) => void) => {
			callbacks.push(callback);
		},
		/** Fire one navigation through every registered callback; returns whether it was cancelled. */
		navigate(type = 'link', to: string | null = '/elsewhere'): boolean {
			let cancelled = false;
			const navigation: LeaveNavigation = {
				type,
				from: { url: new URL('/here', 'http://app.test') },
				to: to ? { url: new URL(to, 'http://app.test') } : null,
				cancel: () => {
					cancelled = true;
				}
			};
			callbacks.forEach((callback) => callback(navigation));
			return cancelled;
		},
		/**
		 * Start a navigation whose completion the test controls (the target
		 * screen "still loading" until `finish()`/`fail()`), like SvelteKit's
		 * `Navigation.complete`.
		 */
		start(to: string) {
			let cancelled = false;
			let finish!: () => void;
			let fail!: () => void;
			const complete = new Promise<void>((resolve, reject) => {
				finish = resolve;
				fail = () => reject(new Error('navigation aborted'));
			});
			const navigation: LeaveNavigation = {
				type: 'link',
				from: { url: new URL('/here', 'http://app.test') },
				to: { url: new URL(to, 'http://app.test') },
				cancel: () => {
					cancelled = true;
					fail();
				},
				complete
			};
			callbacks.forEach((callback) => callback(navigation));
			return { cancelled: () => cancelled, finish, fail, settled: complete.catch(() => {}) };
		}
	};
}

/**
 * What the item pages do when a save finishes: go back to the list unless
 * the guard says the user already chose to be elsewhere. Records each
 * automatic `goto` it would make.
 */
function saveFinished(guard: UnsavedChangesGuard, autoGotos: string[]): void {
	if (guard.canAutoNavigate) autoGotos.push('/items');
}

describe('guardUnsavedChanges', () => {
	it('prompts once for two dirty guards and cancels on "stay"', () => {
		const router = fakeRouter();
		const confirm = vi.fn(() => false);
		const common = { beforeNavigate: router.beforeNavigate, confirm, message: 'discard?' };
		render(GuardHarness, { ...common, isDirty: () => true });
		render(GuardHarness, { ...common, isDirty: () => true });

		expect(router.navigate()).toBe(true);
		expect(confirm).toHaveBeenCalledOnce();
		expect(confirm).toHaveBeenCalledWith('discard?');
	});

	it('asks when only the second of two guards is dirty', () => {
		const router = fakeRouter();
		const confirm = vi.fn(() => false);
		const common = { beforeNavigate: router.beforeNavigate, confirm, message: 'discard?' };
		render(GuardHarness, { ...common, isDirty: () => false });
		render(GuardHarness, { ...common, isDirty: () => true });

		expect(router.navigate()).toBe(true);
		expect(confirm).toHaveBeenCalledOnce();
	});

	it('does not ask when every guard is clean', () => {
		const router = fakeRouter();
		const confirm = vi.fn(() => false);
		render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm,
			message: 'discard?',
			isDirty: () => false
		});

		expect(router.navigate()).toBe(false);
		expect(confirm).not.toHaveBeenCalled();
		expect(hasUnsavedChanges()).toBe(false);
	});

	it('treats a save in flight as pending', () => {
		const router = fakeRouter();
		const confirm = vi.fn(() => false);
		render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm,
			message: 'discard?',
			isDirty: () => false,
			isSaving: () => true
		});

		expect(hasUnsavedChanges()).toBe(true);
		expect(router.navigate()).toBe(true);
	});

	it('leaves the registry and reports disposed after unmount', () => {
		const router = fakeRouter();
		let guard!: UnsavedChangesGuard;
		const { unmount } = render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm: () => false,
			message: 'discard?',
			isDirty: () => true,
			onGuard: (g: UnsavedChangesGuard) => {
				guard = g;
			}
		});
		expect(hasUnsavedChanges()).toBe(true);
		expect(guard.pending).toBe(true);
		expect(guard.disposed).toBe(false);

		unmount();
		expect(hasUnsavedChanges()).toBe(false);
		expect(guard.disposed).toBe(true);
	});

	it('cancels an unload (native prompt) without calling confirm', () => {
		const router = fakeRouter();
		const confirm = vi.fn(() => true);
		render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm,
			message: 'discard?',
			isDirty: () => true
		});

		expect(router.navigate('leave', null)).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	// Owner review on PR #232: "agree to leave -> save succeeds -> the chosen
	// screen finishes loading" must end on the chosen screen. `disposed` alone
	// only flips at unmount, i.e. AFTER the chosen screen has loaded.
	it('suppresses the post-save goto while an agreed exit is still loading', async () => {
		const router = fakeRouter();
		let guard!: UnsavedChangesGuard;
		render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm: () => true,
			message: 'discard?',
			isDirty: () => false,
			isSaving: () => true,
			onGuard: (g: UnsavedChangesGuard) => {
				guard = g;
			}
		});
		const autoGotos: string[] = [];

		const exit = router.start('/dashboard');
		expect(exit.cancelled()).toBe(false);
		expect(guard.leaving).toBe(true);
		saveFinished(guard, autoGotos); // the save wins the race
		exit.finish();
		await exit.settled;

		expect(autoGotos).toEqual([]); // the user stays on /dashboard
	});

	it('lets the post-save goto run again when the exit is cancelled or fails', async () => {
		const router = fakeRouter();
		let guard!: UnsavedChangesGuard;
		render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm: () => true,
			message: 'discard?',
			isDirty: () => true,
			onGuard: (g: UnsavedChangesGuard) => {
				guard = g;
			}
		});
		const exit = router.start('/dashboard');
		expect(guard.canAutoNavigate).toBe(false);
		exit.fail();
		await exit.settled;
		expect(guard.leaving).toBe(false);
		expect(guard.canAutoNavigate).toBe(true);
	});

	it('does not count "stay" as leaving', () => {
		const router = fakeRouter();
		let guard!: UnsavedChangesGuard;
		render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm: () => false,
			message: 'discard?',
			isDirty: () => true,
			onGuard: (g: UnsavedChangesGuard) => {
				guard = g;
			}
		});
		const exit = router.start('/dashboard');
		expect(exit.cancelled()).toBe(true);
		expect(guard.leaving).toBe(false);
	});

	it('keeps leaving until the LATEST exit settles (an older one is superseded)', async () => {
		const router = fakeRouter();
		let guard!: UnsavedChangesGuard;
		render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm: () => true,
			message: 'discard?',
			isDirty: () => false,
			onGuard: (g: UnsavedChangesGuard) => {
				guard = g;
			}
		});
		const first = router.start('/dashboard');
		const second = router.start('/users');
		first.fail(); // superseded by the second click
		await first.settled;
		expect(guard.leaving).toBe(true);
		second.finish();
		await second.settled;
		expect(guard.leaving).toBe(false);
	});
});
