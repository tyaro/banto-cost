/**
 * Which layers the dashboard's dock gestures yield Esc to (dockEscape.ts,
 * shared-primitives-upstream-plan §3.3 / §4.3, #433-b). The layer checks of
 * `@banto/ui` are replaced by spies: this file is about the routing (which
 * check, with which `except`), and the node test environment has no DOM.
 * The DOM behaviour itself - Esc during a divider gesture with a floating
 * window open returns it to where it started - is the dock-svelte jsdom test
 * `DockHostKeyboard.test.ts` ("plan regression").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const layering = vi.hoisted(() => ({
	hasVisibleLayerAbove: vi.fn((_options?: { except?: unknown }) => false),
	hasVisibleModalLayer: vi.fn((_options?: { except?: unknown }) => false),
	hasVisibleMenuLayer: vi.fn((_options?: { except?: unknown }) => false)
}));
vi.mock('@banto/ui', () => layering);

import { isDockEscapeBlocked } from './dockEscape';

beforeEach(() => {
	for (const fn of Object.values(layering)) {
		fn.mockReset();
		fn.mockReturnValue(false);
	}
});

describe('isDockEscapeBlocked', () => {
	it('a floating window gesture yields only to layers above that window', () => {
		const win = { role: 'dialog' } as unknown as HTMLElement;
		expect(isDockEscapeBlocked(win)).toBe(false);
		expect(layering.hasVisibleLayerAbove).toHaveBeenCalledExactlyOnceWith({ except: win });
		layering.hasVisibleLayerAbove.mockReturnValue(true);
		expect(isDockEscapeBlocked(win)).toBe(true);
		expect(layering.hasVisibleModalLayer).not.toHaveBeenCalled();
	});

	it('a divider / docked gesture does not count non-modal floating windows', () => {
		// Plan regression: a floating window is open (a `role="dialog"` that
		// `hasVisibleLayerAbove()` would count) - the Esc must still cancel.
		layering.hasVisibleLayerAbove.mockReturnValue(true);
		expect(isDockEscapeBlocked(null)).toBe(false);
		expect(layering.hasVisibleLayerAbove).not.toHaveBeenCalled();
	});

	it('a divider / docked gesture yields to a Modal or a menu', () => {
		layering.hasVisibleModalLayer.mockReturnValue(true);
		expect(isDockEscapeBlocked(null)).toBe(true);
		layering.hasVisibleModalLayer.mockReturnValue(false);
		layering.hasVisibleMenuLayer.mockReturnValue(true);
		expect(isDockEscapeBlocked(null)).toBe(true);
	});
});
