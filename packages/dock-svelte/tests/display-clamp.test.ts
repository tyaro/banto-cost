// Display clamp vs. saved preference (shared-primitives-upstream-plan §3.2, #434):
// pure geometry plus DockState.move/resize starting from the DRAWN geometry.
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MIN_VISIBLE,
	applyDrag,
	clampWindowToHost,
	displayWindowGeometry
} from '../src/core/geometry';
import { createDockState } from '../src/state.svelte';
import type { FloatingWindow } from '../src/types';

function win(overrides: Partial<FloatingWindow> = {}): FloatingWindow {
	return { id: 'a', title: 'A', x: 100, y: 100, width: 300, height: 200, open: true, ...overrides };
}

describe('displayWindowGeometry', () => {
	// Issue #434's observation: x=452 in a 1000px host; the host shrinks to 400px.
	const saved = win({ x: 452, y: 40, width: 300, height: 200 });

	it('brings a window that would be outside a shrunken host back inside, without touching the saved window', () => {
		const before = JSON.stringify(saved);
		const shown = displayWindowGeometry(saved, 400, 600);
		expect(shown.x).toBeLessThanOrEqual(400 - DEFAULT_MIN_VISIBLE);
		expect(shown.x + shown.width).toBeGreaterThan(0);
		expect(JSON.stringify(saved)).toBe(before);
		expect(saved.x).toBe(452);
	});

	it('returns to the saved placement when the host grows back', () => {
		expect(displayWindowGeometry(saved, 400, 600).x).not.toBe(452);
		expect(displayWindowGeometry(saved, 1000, 600)).toEqual(saved);
	});

	it('draws an unmeasured host (0 x 0) as saved', () => {
		expect(displayWindowGeometry(saved, 0, 0)).toBe(saved);
		expect(displayWindowGeometry(saved, 400, 0)).toBe(saved);
	});

	it('uses the consumer minimums and minVisible instead of the package defaults', () => {
		const shown = displayWindowGeometry(win({ width: 100, height: 100 }), 1000, 800, {
			minW: 280,
			minH: 240,
			minVisible: 100
		});
		expect(shown.width).toBe(280);
		expect(shown.height).toBe(240);
		expect(displayWindowGeometry(win({ x: 5000 }), 1000, 800, { minVisible: 100 }).x).toBe(900);
	});
});

describe('clampWindowToHost narrowHost policy', () => {
	const wide = win({ x: 0, y: 0, width: 400, height: 300 });

	it("'overflow' (default) keeps the minimum width, wider than the host, with minVisible px reachable", () => {
		const c = clampWindowToHost({ ...wide, x: 500 }, 200, 600, { minW: 280 });
		expect(c.width).toBe(280);
		expect(c.x).toBe(200 - DEFAULT_MIN_VISIBLE);
	});

	it("'fit' shrinks the window to the host so it stays fully visible", () => {
		const c = clampWindowToHost({ ...wide, x: 500 }, 200, 600, { minW: 280, narrowHost: 'fit' });
		expect(c.width).toBe(200);
		expect(c.x).toBe(0);
	});

	it("'fit' still honours the minimum when the host is wide enough", () => {
		const c = clampWindowToHost(win({ width: 100 }), 1000, 600, { minW: 280, narrowHost: 'fit' });
		expect(c.width).toBe(280);
	});
});

describe('applyDrag with clamp options', () => {
	it('passes the consumer minVisible through', () => {
		const dragged = applyDrag(win({ x: 0 }), 10_000, 0, 800, 600, { minVisible: 100 });
		expect(dragged.x).toBe(700);
	});
});

describe('DockState keeps the saved preference when the host shrinks', () => {
	const layout = {
		version: 2 as const,
		floating: [win({ x: 452, y: 40, width: 300, height: 200 })],
		docked: null
	};

	it('serialize() is identical before and after drawing in a smaller host', () => {
		const dock = createDockState(layout);
		const before = dock.serialize();
		// Drawing is a pure function of (saved, host): it never writes back.
		displayWindowGeometry(dock.layout.floating[0], 400, 600);
		expect(dock.serialize()).toBe(before);
	});

	it('move starts from the drawn position and saves the result as the new preference', () => {
		const dock = createDockState(layout);
		// In a 400px host the window is drawn at the clamped x (352), not at 452.
		const drawn = displayWindowGeometry(dock.layout.floating[0], 400, 600);
		dock.move('a', -100, 0, 400, 600);
		expect(dock.layout.floating[0].x).toBe(drawn.x - 100);
	});

	it('resize starts from the drawn geometry and honours consumer minimums', () => {
		const dock = createDockState(layout);
		dock.resize('a', 'e', -1000, 0, 1000, 600, { minW: 280, minH: 240 });
		expect(dock.layout.floating[0].width).toBe(280);
	});
});
