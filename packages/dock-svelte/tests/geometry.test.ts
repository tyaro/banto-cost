import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MIN_HEIGHT,
	DEFAULT_MIN_WIDTH,
	applyDrag,
	applyResize,
	bringToFront,
	cascadePosition,
	clampWindowToHost
} from '../src/core/geometry';
import type { DockLayout, FloatingWindow } from '../src/types';

function win(overrides: Partial<FloatingWindow> = {}): FloatingWindow {
	return { id: 'a', title: 'A', x: 100, y: 100, width: 300, height: 200, open: true, ...overrides };
}

describe('clampWindowToHost', () => {
	it('keeps at least minVisible px visible when dragged far negative', () => {
		const clamped = clampWindowToHost(win({ x: -10_000, y: -10_000 }), 800, 600, {
			minVisible: 48
		});
		// Right/bottom edge of the window must still cover at least 48px inside the host.
		expect(clamped.x + clamped.width).toBeGreaterThanOrEqual(48);
		expect(clamped.y + clamped.height).toBeGreaterThanOrEqual(48);
	});

	it('keeps at least minVisible px visible when dragged far positive', () => {
		const clamped = clampWindowToHost(win({ x: 10_000, y: 10_000 }), 800, 600, { minVisible: 48 });
		expect(clamped.x).toBeLessThanOrEqual(800 - 48);
		expect(clamped.y).toBeLessThanOrEqual(600 - 48);
	});

	it('leaves an in-bounds window untouched', () => {
		const clamped = clampWindowToHost(win({ x: 50, y: 60 }), 800, 600);
		expect(clamped.x).toBe(50);
		expect(clamped.y).toBe(60);
		expect(clamped.width).toBe(300);
		expect(clamped.height).toBe(200);
	});

	it('clamps size to configured minima', () => {
		const clamped = clampWindowToHost(win({ width: 10, height: 10 }), 800, 600, {
			minW: 160,
			minH: 120
		});
		expect(clamped.width).toBe(160);
		expect(clamped.height).toBe(120);
	});

	it('clamps size to the host when larger than the host', () => {
		const clamped = clampWindowToHost(win({ width: 5000, height: 5000 }), 800, 600);
		expect(clamped.width).toBe(800);
		expect(clamped.height).toBe(600);
	});

	it('centers the window when the host is too small for any valid clamp range', () => {
		// minVisible=200 with a 160x120 window on a 60x40 host makes both the
		// horizontal and vertical clamp ranges empty (maxX < minX, maxY < minY),
		// which is the condition that falls back to centering.
		const clamped = clampWindowToHost(win({ width: 160, height: 120, x: 0, y: 0 }), 60, 40, {
			minVisible: 200
		});
		expect(clamped.x).toBeCloseTo((60 - clamped.width) / 2);
		expect(clamped.y).toBeCloseTo((40 - clamped.height) / 2);
	});
});

describe('applyDrag', () => {
	it('moves by (dx, dy) when the result stays in bounds', () => {
		const moved = applyDrag(win({ x: 100, y: 100 }), 20, -30, 800, 600);
		expect(moved.x).toBe(120);
		expect(moved.y).toBe(70);
	});

	it('clamps the result via clampWindowToHost', () => {
		const moved = applyDrag(win({ x: 100, y: 100 }), -100_000, 0, 800, 600);
		expect(moved.x).toBeGreaterThan(-100_000);
		expect(moved.x + moved.width).toBeGreaterThanOrEqual(48);
	});
});

describe('applyResize', () => {
	const base = win({ x: 100, y: 100, width: 300, height: 200 });

	it('e: grows width, keeps left/top/bottom fixed', () => {
		const resized = applyResize(base, 'e', 40, 0, 800, 600, 160, 120);
		expect(resized.x).toBe(100);
		expect(resized.y).toBe(100);
		expect(resized.width).toBe(340);
		expect(resized.height).toBe(200);
	});

	it('w: moves left edge, keeps right edge fixed', () => {
		const rightEdge = base.x + base.width;
		// Dragging the west handle left (dx=-40) widens the window by 40px.
		const resized = applyResize(base, 'w', -40, 0, 800, 600, 160, 120);
		expect(resized.x).toBe(60);
		expect(resized.width).toBe(340);
		expect(resized.x + resized.width).toBe(rightEdge);
		expect(resized.y).toBe(100);
		expect(resized.height).toBe(200);
	});

	it('s: grows height, keeps top fixed', () => {
		const resized = applyResize(base, 's', 0, 50, 800, 600, 160, 120);
		expect(resized.y).toBe(100);
		expect(resized.height).toBe(250);
		expect(resized.x).toBe(100);
		expect(resized.width).toBe(300);
	});

	it('n: moves top edge, keeps bottom edge fixed', () => {
		const bottomEdge = base.y + base.height;
		const resized = applyResize(base, 'n', 0, -50, 800, 600, 160, 120);
		expect(resized.y).toBe(50);
		expect(resized.height).toBe(250);
		expect(resized.y + resized.height).toBe(bottomEdge);
	});

	it('ne: grows width and moves+shrinks from top, keeps left/bottom fixed', () => {
		const bottomEdge = base.y + base.height;
		const resized = applyResize(base, 'ne', 40, -20, 800, 600, 160, 120);
		expect(resized.x).toBe(100);
		expect(resized.width).toBe(340);
		expect(resized.y).toBe(80);
		expect(resized.height).toBe(220);
		expect(resized.y + resized.height).toBe(bottomEdge);
	});

	it('nw: keeps bottom-right corner fixed', () => {
		const rightEdge = base.x + base.width;
		const bottomEdge = base.y + base.height;
		const resized = applyResize(base, 'nw', -30, -30, 800, 600, 160, 120);
		expect(resized.x + resized.width).toBe(rightEdge);
		expect(resized.y + resized.height).toBe(bottomEdge);
	});

	it('se: keeps top-left corner fixed', () => {
		const resized = applyResize(base, 'se', 30, 30, 800, 600, 160, 120);
		expect(resized.x).toBe(100);
		expect(resized.y).toBe(100);
		expect(resized.width).toBe(330);
		expect(resized.height).toBe(230);
	});

	it('sw: keeps top-right corner fixed', () => {
		const rightEdge = base.x + base.width;
		const resized = applyResize(base, 'sw', -30, 30, 800, 600, 160, 120);
		expect(resized.x + resized.width).toBe(rightEdge);
		expect(resized.y).toBe(100);
		expect(resized.height).toBe(230);
	});

	it('respects minW when shrinking from the east', () => {
		const resized = applyResize(base, 'e', -1000, 0, 800, 600, 160, 120);
		expect(resized.width).toBe(160);
		expect(resized.x).toBe(100);
	});

	it('respects minW when shrinking from the west, still keeping the right edge fixed', () => {
		const rightEdge = base.x + base.width;
		const resized = applyResize(base, 'w', 1000, 0, 800, 600, 160, 120);
		expect(resized.width).toBe(160);
		expect(resized.x + resized.width).toBe(rightEdge);
	});

	it('respects minH when shrinking from the south', () => {
		const resized = applyResize(base, 's', 0, -1000, 800, 600, 160, 120);
		expect(resized.height).toBe(120);
	});

	it('respects minH when shrinking from the north, keeping the bottom edge fixed', () => {
		const bottomEdge = base.y + base.height;
		const resized = applyResize(base, 'n', 0, 1000, 800, 600, 160, 120);
		expect(resized.height).toBe(120);
		expect(resized.y + resized.height).toBe(bottomEdge);
	});

	it('does not grow the east edge past the host bound (when room >= minW)', () => {
		// x=600 leaves 200px of room to the host's right edge, comfortably
		// above minW=160, so the host bound - not the minima - is what caps growth.
		const resized = applyResize(
			win({ x: 600, y: 100, width: 50, height: 50 }),
			'e',
			1000,
			0,
			800,
			600,
			160,
			120
		);
		expect(resized.x + resized.width).toBe(800);
	});

	it('lets minW win over the host bound when the two conflict (host room < minW)', () => {
		// Only 100px of room to the host's right edge but minW=160 - the
		// documented tradeoff (see clampWindowToHost) is minima wins.
		const resized = applyResize(
			win({ x: 700, y: 100, width: 50, height: 50 }),
			'e',
			1000,
			0,
			800,
			600,
			160,
			120
		);
		expect(resized.width).toBe(160);
	});

	it('does not move the west edge past the host bound (x >= 0)', () => {
		const resized = applyResize(
			win({ x: 10, y: 100, width: 300, height: 200 }),
			'w',
			-1000,
			0,
			800,
			600,
			160,
			120
		);
		expect(resized.x).toBeGreaterThanOrEqual(0);
	});

	it('uses DEFAULT_MIN_WIDTH/HEIGHT when minW/minH omitted', () => {
		const resized = applyResize(base, 'e', -1000, 0, 800, 600);
		expect(resized.width).toBe(DEFAULT_MIN_WIDTH);
		const resizedS = applyResize(base, 's', 0, -1000, 800, 600);
		expect(resizedS.height).toBe(DEFAULT_MIN_HEIGHT);
	});
});

describe('bringToFront', () => {
	function layoutOf(ids: string[]): DockLayout {
		return { version: 2, floating: ids.map((id) => win({ id })), docked: null };
	}

	it('moves the target window to the end of the array', () => {
		const layout = layoutOf(['a', 'b', 'c']);
		const next = bringToFront(layout, 'a');
		expect(next.floating.map((w) => w.id)).toEqual(['b', 'c', 'a']);
	});

	it('is a no-op (same reference) when already frontmost', () => {
		const layout = layoutOf(['a', 'b', 'c']);
		const next = bringToFront(layout, 'c');
		expect(next).toBe(layout);
	});

	it('is idempotent when called twice for the same id', () => {
		const layout = layoutOf(['a', 'b', 'c']);
		const once = bringToFront(layout, 'a');
		const twice = bringToFront(once, 'a');
		expect(twice).toBe(once);
		expect(twice.floating.map((w) => w.id)).toEqual(['b', 'c', 'a']);
	});

	it('returns the same layout reference for an unknown id', () => {
		const layout = layoutOf(['a', 'b']);
		expect(bringToFront(layout, 'zzz')).toBe(layout);
	});
});

describe('cascadePosition', () => {
	it('staggers by 32px per index', () => {
		expect(cascadePosition(0, 1000, 1000, 300, 200)).toEqual({ x: 0, y: 0 });
		expect(cascadePosition(1, 1000, 1000, 300, 200)).toEqual({ x: 32, y: 32 });
		expect(cascadePosition(2, 1000, 1000, 300, 200)).toEqual({ x: 64, y: 64 });
	});

	it('wraps back to the origin once the stagger runs out of room', () => {
		const hostW = 1000;
		const hostH = 1000;
		const defaultW = 300;
		const defaultH = 200;
		const avail = Math.min(hostW - defaultW, hostH - defaultH);
		const maxSteps = Math.floor(avail / 32) + 1;
		expect(cascadePosition(maxSteps, hostW, hostH, defaultW, defaultH)).toEqual({ x: 0, y: 0 });
	});

	it('never places a window with a negative offset even on a tiny host', () => {
		const { x, y } = cascadePosition(5, 100, 100, 300, 200);
		expect(x).toBeGreaterThanOrEqual(0);
		expect(y).toBeGreaterThanOrEqual(0);
	});
});
