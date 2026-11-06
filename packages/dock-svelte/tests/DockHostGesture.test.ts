// @vitest-environment jsdom
//
// DockHost gestures through the single GestureOwner (#433, shared-primitives-
// upstream-plan §3.3 / PR-4). The first four cases are the Issue's
// observations as regressions:
//  1. Esc during a floating resize returns to the pre-gesture size.
//  2. After a window blur, later pointermoves are ignored and the resize is undone.
//  3. A different pointerId's pointerup does not drop a title-bar drag.
//  4. focusin on an input of a back window raises it (without moving its DOM).
// Then pointercancel / lostpointercapture / unmount, the divider, the host
// re-measure before commit, and "no listener survives a gesture".
//
// jsdom has no layout engine: the host size is a controllable `clientWidth` /
// `clientHeight` (restored in afterAll), and `elementFromPoint` returns the
// host (= "free floating space"). Pointer events are plain `Event`s with the
// fields assigned (jsdom has no `PointerEvent`).
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

let hostWidth = 1000;
let hostHeight = 600;
const saved: [object, string, PropertyDescriptor | undefined][] = [];

function stub(target: object, prop: string, descriptor: PropertyDescriptor): void {
	saved.push([target, prop, Object.getOwnPropertyDescriptor(target, prop)]);
	Object.defineProperty(target, prop, { configurable: true, ...descriptor });
}

beforeAll(() => {
	stub(globalThis, 'ResizeObserver', {
		writable: true,
		value: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
	});
	stub(HTMLElement.prototype, 'clientWidth', { get: () => hostWidth });
	stub(HTMLElement.prototype, 'clientHeight', { get: () => hostHeight });
	stub(document, 'elementFromPoint', {
		writable: true,
		value: () => document.querySelector('[data-dock-host]')
	});
});

afterAll(() => {
	for (const [target, prop, descriptor] of saved.reverse()) {
		if (descriptor) Object.defineProperty(target, prop, descriptor);
		else Reflect.deleteProperty(target, prop);
	}
});

// Net window listeners for the gesture owner's event types (adds - removes).
const TYPES = new Set([
	'pointermove',
	'pointerup',
	'pointercancel',
	'lostpointercapture',
	'keydown',
	'blur'
]);
let net = 0;
beforeEach(() => {
	net = 0;
	const add = window.addEventListener.bind(window);
	const remove = window.removeEventListener.bind(window);
	vi.spyOn(window, 'addEventListener').mockImplementation((type, fn, opts) => {
		if (TYPES.has(type)) net++;
		add(type, fn, opts);
	});
	vi.spyOn(window, 'removeEventListener').mockImplementation((type, fn, opts) => {
		if (TYPES.has(type)) net--;
		remove(type, fn, opts);
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	hostWidth = 1000;
	hostHeight = 600;
});

function firePointer(
	target: EventTarget,
	type: string,
	x: number,
	y: number,
	pointerId = 1
): Event {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId, button: 0, isPrimary: pointerId === 1 });
	target.dispatchEvent(ev);
	return ev;
}

function pressEscape(): KeyboardEvent {
	const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
	window.dispatchEvent(ev);
	return ev;
}

const floatingA = (): DockLayout => ({
	version: 2,
	floating: [{ id: 'a', title: 'A', x: 40, y: 40, width: 320, height: 200, open: true }],
	docked: null
});

function mountFloating(layout: DockLayout = floatingA()) {
	const dock = createDockState(layout);
	const view = render(DockHostHarness, { dock });
	const dialog = (name: string) => screen.getByRole('dialog', { name });
	return { dock, view, dialog };
}

const widthOf = (dock: ReturnType<typeof createDockState>, id = 'a') =>
	dock.layout.floating.find((w) => w.id === id)!.width;

describe('Issue #433 observations (regressions)', () => {
	it('1. Esc during a resize returns to the size before the press and consumes the key', () => {
		const { dock, dialog } = mountFloating();
		const handle = dialog('A').querySelector('.handle-se')!;
		firePointer(handle, 'pointerdown', 360, 240);
		firePointer(window, 'pointermove', 430, 240);
		expect(widthOf(dock)).toBe(390);
		const esc = pressEscape();
		expect(esc.defaultPrevented).toBe(true);
		expect(widthOf(dock)).toBe(320);
		firePointer(window, 'pointerup', 430, 240);
		expect(widthOf(dock)).toBe(320);
		expect(net).toBe(0);
	});

	it('2. after a window blur, later pointermoves are ignored and the resize is undone', () => {
		const { dock, dialog } = mountFloating();
		const handle = dialog('A').querySelector('.handle-se')!;
		firePointer(handle, 'pointerdown', 360, 240);
		firePointer(window, 'pointermove', 380, 240);
		expect(widthOf(dock)).toBe(340);
		window.dispatchEvent(new Event('blur'));
		expect(widthOf(dock)).toBe(320);
		firePointer(window, 'pointermove', 430, 240);
		firePointer(window, 'pointerup', 430, 240);
		expect(widthOf(dock)).toBe(320);
		expect(net).toBe(0);
	});

	it("3. another pointer's pointerup does not drop a title-bar drag; the owning one does", () => {
		const { dock, dialog } = mountFloating();
		const titlebar = dialog('A').querySelector('.titlebar')!;
		firePointer(titlebar, 'pointerdown', 100, 100);
		firePointer(window, 'pointermove', 130, 130); // threshold crossed → ghost
		firePointer(window, 'pointermove', 200, 160);
		flushSync();
		expect(document.querySelector('.drag-ghost')).not.toBeNull();

		firePointer(window, 'pointerup', 201, 160, 999);
		flushSync();
		expect(document.querySelector('.drag-ghost')).not.toBeNull();
		expect(dock.layout.floating[0].x).toBe(40);

		firePointer(window, 'pointerup', 200, 160);
		flushSync();
		expect(document.querySelector('.drag-ghost')).toBeNull();
		expect(dock.layout.floating[0].x).not.toBe(40);
		expect(net).toBe(0);
	});

	it('4. focusin on an input of a back window raises it, keeping focus and the DOM order', () => {
		const { dock, dialog } = mountFloating({
			version: 2,
			floating: [
				{ id: 'a', title: 'A', x: 40, y: 40, width: 320, height: 200, open: true },
				{ id: 'd', title: 'D', x: 100, y: 80, width: 320, height: 200, open: true }
			],
			docked: null
		});
		const a = dialog('A');
		const d = dialog('D');
		const domOrder = () => [...document.querySelectorAll('[role="dialog"]')];
		expect(domOrder()).toEqual([a, d]);

		const input = screen.getByRole('textbox', { name: 'A input' });
		input.focus(); // jsdom fires focusin
		flushSync();

		expect(dock.layout.floating.map((w) => w.id)).toEqual(['d', 'a']);
		expect(document.activeElement).toBe(input);
		// Same nodes, same DOM (= Tab) order; the stacking moved instead.
		expect(dialog('A')).toBe(a);
		expect(domOrder()).toEqual([a, d]);
		expect(Number(a.style.zIndex)).toBeGreaterThan(Number(d.style.zIndex));
		expect(a.classList.contains('frontmost')).toBe(true);
		expect(d.classList.contains('frontmost')).toBe(false);
	});
});

describe('other cancel triggers free the gesture', () => {
	for (const [name, fire] of [
		['pointercancel', () => firePointer(window, 'pointercancel', 0, 0)],
		[
			'lostpointercapture',
			() => firePointer(screen.getByRole('dialog', { name: 'A' }), 'lostpointercapture', 0, 0)
		]
	] as const) {
		it(`${name} undoes the resize and removes the listeners`, () => {
			const { dock, dialog } = mountFloating();
			firePointer(dialog('A').querySelector('.handle-se')!, 'pointerdown', 360, 240);
			firePointer(window, 'pointermove', 400, 240);
			expect(widthOf(dock)).toBe(360);
			fire();
			expect(widthOf(dock)).toBe(320);
			expect(net).toBe(0);
		});
	}

	it('unmounting the DockHost mid-resize restores the layout and removes the listeners', () => {
		const { dock, view, dialog } = mountFloating();
		firePointer(dialog('A').querySelector('.handle-se')!, 'pointerdown', 360, 240);
		firePointer(window, 'pointermove', 400, 240);
		expect(net).toBeGreaterThan(0);
		view.unmount();
		expect(widthOf(dock)).toBe(320);
		expect(net).toBe(0);
		firePointer(window, 'pointermove', 500, 240);
		expect(widthOf(dock)).toBe(320);
	});

	it('Esc during a title-bar drag drops nothing and removes the ghost', () => {
		const { dock, dialog } = mountFloating();
		firePointer(dialog('A').querySelector('.titlebar')!, 'pointerdown', 100, 100);
		firePointer(window, 'pointermove', 200, 200);
		pressEscape();
		flushSync();
		expect(document.querySelector('.drag-ghost')).toBeNull();
		firePointer(window, 'pointerup', 200, 200);
		expect(dock.layout.floating[0]).toMatchObject({ x: 40, y: 40 });
		expect(net).toBe(0);
	});
});

describe('commit re-measures the host', () => {
	it('a pointerup before the resize notification commits against the current host size', () => {
		const { dock, dialog } = mountFloating();
		firePointer(dialog('A').querySelector('.handle-se')!, 'pointerdown', 360, 240);
		firePointer(window, 'pointermove', 700, 240);
		expect(widthOf(dock)).toBe(660);
		// The host shrinks, but no ResizeObserver notification arrives (the
		// bound hostW is still 1000) before the release.
		hostWidth = 500;
		firePointer(window, 'pointerup', 700, 240);
		const win = dock.layout.floating[0];
		expect(win.x + win.width).toBeLessThanOrEqual(500);
		expect(net).toBe(0);
	});
});

describe('split divider', () => {
	const split = (): DockLayout => ({
		version: 2,
		floating: [{ id: 'f', title: 'F', x: 600, y: 300, width: 300, height: 200, open: true }],
		docked: {
			type: 'split',
			id: 's',
			direction: 'row',
			sizes: [0.5, 0.5],
			children: [
				{ type: 'panel', id: 'l', title: 'L' },
				{ type: 'panel', id: 'r', title: 'R' }
			]
		}
	});
	const sizes = (dock: ReturnType<typeof createDockState>) =>
		(dock.layout.docked as { sizes: number[] }).sizes;

	it('Esc with a floating window open returns the divider to where it started', () => {
		const { dock } = mountFloating(split());
		const divider = screen.getByRole('separator');
		firePointer(divider, 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 600, 100);
		expect(sizes(dock)[0]).toBeCloseTo(0.6);
		expect(pressEscape().defaultPrevented).toBe(true);
		expect(sizes(dock)).toEqual([0.5, 0.5]);
		expect(net).toBe(0);
	});

	it('commits on the owning pointerup, applying its last delta', () => {
		const { dock } = mountFloating(split());
		firePointer(screen.getByRole('separator'), 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 550, 100);
		firePointer(window, 'pointerup', 600, 100, 7); // another pointer: ignored
		expect(sizes(dock)[0]).toBeCloseTo(0.55);
		firePointer(window, 'pointerup', 600, 100);
		expect(sizes(dock)[0]).toBeCloseTo(0.6);
		expect(net).toBe(0);
	});

	it('a second gesture cannot start while one is active', () => {
		const { dock, dialog } = mountFloating(split());
		firePointer(screen.getByRole('separator'), 'pointerdown', 500, 100);
		firePointer(dialog('F').querySelector('.handle-se')!, 'pointerdown', 900, 500, 2);
		firePointer(window, 'pointermove', 950, 500, 2);
		expect(widthOf(dock, 'f')).toBe(300);
		firePointer(window, 'pointerup', 500, 100);
		expect(net).toBe(0);
	});
});
