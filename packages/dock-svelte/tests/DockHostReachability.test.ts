// @vitest-environment jsdom
//
// DockHost reachability and capabilities (shared-primitives-upstream-plan §3.2,
// #434). jsdom has no layout engine, so the host size is injected: a
// controllable `clientWidth`/`clientHeight` plus a ResizeObserver stub whose
// callbacks the test fires (Svelte's `bind:clientWidth` re-reads the property
// when the observer fires). Plan §10's open question - "can jsdom inject
// clientWidth?" - is answered by this file.
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

let hostWidth = 1000;
let hostHeight = 600;
const observed = new Set<Element>();
let fire: (() => void) | null = null;

/** Change the (stubbed) host size and notify every ResizeObserver listener. */
function resizeHost(w: number, h: number): void {
	hostWidth = w;
	hostHeight = h;
	fire?.();
	flushSync();
}

beforeAll(() => {
	globalThis.ResizeObserver = class {
		#cb: ResizeObserverCallback;
		constructor(cb: ResizeObserverCallback) {
			this.#cb = cb;
			fire = () =>
				this.#cb(
					[...observed].map((target) => ({ target }) as ResizeObserverEntry),
					this as unknown as ResizeObserver
				);
		}
		observe(el: Element) {
			observed.add(el);
		}
		unobserve(el: Element) {
			observed.delete(el);
		}
		disconnect() {
			observed.clear();
		}
	} as unknown as typeof ResizeObserver;
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get() {
			return hostWidth;
		}
	});
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get() {
			return hostHeight;
		}
	});
	Object.defineProperty(document, 'elementFromPoint', {
		configurable: true,
		value: () => document.querySelector('[data-dock-host]')
	});
});

afterEach(() => {
	cleanup();
	observed.clear();
	hostWidth = 1000;
	hostHeight = 600;
});

function firePointer(target: EventTarget, type: string, x: number, y: number) {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, button: 0 });
	target.dispatchEvent(ev);
}

const floatingLayout = (): DockLayout => ({
	version: 2,
	floating: [{ id: 'd', title: 'D', x: 452, y: 40, width: 300, height: 200, open: true }],
	docked: null
});

function leftPx(name: string): number {
	return parseFloat(screen.getByRole('dialog', { name }).style.left);
}

describe('DockHost host shrink (Issue #434: 1000px -> 400px, x=452)', () => {
	it('draws the window inside the shrunken host and restores it when the host grows, leaving the saved layout untouched', () => {
		const dock = createDockState(floatingLayout());
		const saved = dock.serialize();
		render(DockHostHarness, { dock });
		expect(leftPx('D')).toBe(452);

		resizeHost(400, 600);
		// Left edge must be inside the host (it was at 452 > 400: fully hidden).
		expect(leftPx('D')).toBeLessThan(400);
		expect(leftPx('D')).toBeLessThanOrEqual(400 - 48);

		// The saved preference is not rewritten by the display clamp.
		expect(dock.serialize()).toBe(saved);
		expect(dock.layout.floating[0].x).toBe(452);

		resizeHost(1000, 600);
		expect(leftPx('D')).toBe(452);
		expect(dock.serialize()).toBe(saved);
	});

	it('applies the consumer clamp policy (minimum size and narrow-host fit)', () => {
		const dock = createDockState(floatingLayout());
		render(DockHostHarness, { dock, clamp: { minW: 280, minH: 240, narrowHost: 'fit' } });
		const dialog = screen.getByRole('dialog', { name: 'D' });
		// Saved 300x200: height is raised to the consumer minimum 240 for drawing only.
		expect(dialog.style.height).toBe('240px');
		expect(dock.layout.floating[0].height).toBe(200);

		resizeHost(200, 600);
		expect(dialog.style.width).toBe('200px');
		expect(dialog.style.left).toBe('0px');
		expect(dock.layout.floating[0].width).toBe(300);
	});
});

describe('DockHost capabilities', () => {
	it('hides the close button of a pane whose capabilities say close: false', () => {
		const dock = createDockState({
			version: 2,
			floating: [
				{ id: 'keep', title: 'Keep', x: 0, y: 0, width: 300, height: 200, open: true },
				{ id: 'other', title: 'Other', x: 50, y: 50, width: 300, height: 200, open: true }
			],
			docked: null
		});
		render(DockHostHarness, {
			dock,
			capabilities: (id: string) => (id === 'keep' ? { close: false } : undefined)
		});
		const keep = screen.getByRole('dialog', { name: 'Keep' });
		const other = screen.getByRole('dialog', { name: 'Other' });
		expect(keep.querySelector('.close-btn')).toBeNull();
		expect(other.querySelector('.close-btn')).not.toBeNull();
	});

	it('hides the close button of a docked pane with close: false', () => {
		const dock = createDockState({
			version: 2,
			floating: [],
			docked: { type: 'panel', id: 'canvas', title: 'Canvas' }
		});
		render(DockHostHarness, { dock, capabilities: () => ({ close: false }) });
		expect(screen.getByRole('toolbar', { name: 'Canvas' }).querySelector('.close-btn')).toBeNull();
	});

	it('a floating window with move: false does not move when its title bar is dragged', () => {
		const dock = createDockState({
			version: 2,
			floating: [{ id: 'a', title: 'A', x: 0, y: 0, width: 300, height: 200, open: true }],
			docked: null
		});
		render(DockHostHarness, { dock, capabilities: () => ({ move: false }) });
		const titlebar = screen.getByRole('dialog', { name: 'A' }).querySelector('.titlebar')!;
		firePointer(titlebar, 'pointerdown', 100, 100);
		firePointer(window, 'pointermove', 130, 130);
		firePointer(window, 'pointermove', 300, 300);
		firePointer(window, 'pointerup', 300, 300);
		expect(dock.layout.floating[0]).toMatchObject({ x: 0, y: 0 });
	});

	it('a docked pane with move: false cannot be dragged out; with undock: false it stays docked', () => {
		for (const caps of [{ move: false }, { undock: false }]) {
			const dock = createDockState({
				version: 2,
				floating: [],
				docked: { type: 'panel', id: 'a', title: 'A' }
			});
			render(DockHostHarness, { dock, capabilities: () => caps });
			const toolbar = screen.getByRole('toolbar', { name: 'A' });
			firePointer(toolbar, 'pointerdown', 100, 100);
			firePointer(window, 'pointermove', 130, 130);
			firePointer(window, 'pointermove', 300, 300);
			firePointer(window, 'pointerup', 300, 300);
			expect(dock.layout.docked).not.toBeNull();
			expect(dock.layout.floating).toHaveLength(0);
			cleanup();
		}
	});

	it('defaults allow everything (a docked pane can still be floated)', () => {
		const dock = createDockState({
			version: 2,
			floating: [],
			docked: { type: 'panel', id: 'a', title: 'A' }
		});
		render(DockHostHarness, { dock });
		const toolbar = screen.getByRole('toolbar', { name: 'A' });
		firePointer(toolbar, 'pointerdown', 100, 100);
		firePointer(window, 'pointermove', 130, 130);
		firePointer(window, 'pointermove', 300, 300);
		firePointer(window, 'pointerup', 300, 300);
		expect(dock.layout.docked).toBeNull();
		expect(dock.layout.floating).toHaveLength(1);
	});
});
