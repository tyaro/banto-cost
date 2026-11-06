// @vitest-environment jsdom
//
// DockHost gesture hooks and keyboard operation (#433-b, shared-primitives-
// upstream-plan §3.3 / §4.3 / D5, PR-5):
//  - `canStartGesture` / `onGestureEnd` / `isEscapeBlocked(activeLayer)`;
//  - the divider as a WAI-ARIA Window Splitter, the floating window's explicit
//    keyboard move / resize mode, the tab strip's arrows;
//  - keys in inputs, during IME composition, with modifiers or on the window
//    are not taken, and a higher Menu / Modal keeps its Esc;
//  - the plan's regression: with a floating window open, Esc during a divider
//    gesture returns it to where it started (the app's `isEscapeBlocked` does
//    not count the non-modal floating `role="dialog"`).
//
// Same jsdom setup as DockHostGesture.test.ts (controllable host size,
// restored in afterAll; plain `Event`s carrying the pointer fields).
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

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
	stub(HTMLElement.prototype, 'clientWidth', { get: () => 1000 });
	stub(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
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

// Net listeners of the gesture owner's event types: window ones, and the
// document's `visibilitychange` (Svelte's own delegated listeners on the
// document are not counted).
const TYPES: [EventTarget, Set<string>][] = [];
let net = 0;
beforeEach(() => {
	net = 0;
	TYPES.length = 0;
	TYPES.push(
		[
			window,
			new Set([
				'pointermove',
				'pointerup',
				'pointercancel',
				'lostpointercapture',
				'keydown',
				'blur'
			])
		],
		[document, new Set(['visibilitychange'])]
	);
	for (const [target, types] of TYPES) {
		const add = target.addEventListener.bind(target);
		const remove = target.removeEventListener.bind(target);
		vi.spyOn(target, 'addEventListener').mockImplementation((type, fn, opts) => {
			if (types.has(type)) net++;
			add(type, fn, opts);
		});
		vi.spyOn(target, 'removeEventListener').mockImplementation((type, fn, opts) => {
			if (types.has(type)) net--;
			remove(type, fn, opts);
		});
	}
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	document.querySelectorAll('.test-layer').forEach((el) => el.remove());
});

function firePointer(target: EventTarget, type: string, x: number, y: number, pointerId = 1) {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId, button: 0, isPrimary: pointerId === 1 });
	target.dispatchEvent(ev);
	return ev;
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(ev);
	flushSync();
	return ev;
}

/** A keydown that is part of IME composition. */
function pressComposing(target: EventTarget, key: string): KeyboardEvent {
	const ev = new KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		isComposing: true
	});
	target.dispatchEvent(ev);
	flushSync();
	return ev;
}

/** What `apps/admin-template` passes, written without `@banto/ui` (a package may not import another). */
function appLikeEscapeBlocked(activeLayer: HTMLElement | null): boolean {
	const visible = [...document.querySelectorAll('[role="dialog"], [role="menu"]')];
	if (activeLayer) {
		// Above = any other layer outside the active one that is marked as a test overlay.
		return visible.some((el) => el !== activeLayer && el.classList.contains('test-layer'));
	}
	return document.querySelector('[aria-modal="true"], [role="menu"]') !== null;
}

function addLayer(attrs: Record<string, string>): HTMLElement {
	const el = document.createElement('div');
	el.className = 'test-layer';
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	document.body.appendChild(el);
	return el;
}

const floating = (): DockLayout => ({
	version: 2,
	floating: [
		{ id: 'a', title: 'A', x: 40, y: 40, width: 320, height: 200, open: true },
		{ id: 'b', title: 'B', x: 500, y: 300, width: 300, height: 200, open: true }
	],
	docked: null
});

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

const tabs = (): DockLayout => ({
	version: 2,
	floating: [],
	docked: {
		type: 'tabs',
		id: 't',
		activeIndex: 0,
		children: [
			{ type: 'panel', id: 'x', title: 'X' },
			{ type: 'panel', id: 'y', title: 'Y' },
			{ type: 'panel', id: 'z', title: 'Z' }
		]
	}
});

type Hooks = {
	canStartGesture?: (kind: string, panelId: string | null) => boolean;
	onGestureEnd?: (kind: string, outcome: 'commit' | 'cancel', reason?: string) => void;
	isEscapeBlocked?: (activeLayer: HTMLElement | null) => boolean;
};

function mount(layout: DockLayout, hooks: Hooks = {}) {
	const dock = createDockState(layout);
	const view = render(DockHostHarness, { dock, ...hooks });
	const dialog = (name: string) => screen.getByRole('dialog', { name });
	return { dock, view, dialog };
}

const win = (dock: ReturnType<typeof createDockState>, id: string) =>
	dock.layout.floating.find((w) => w.id === id)!;
const sizes = (dock: ReturnType<typeof createDockState>) =>
	(dock.layout.docked as { sizes: number[] }).sizes;

/** Focus the window's keyboard-mode button and turn the mode on. */
function enterMode(dialog: HTMLElement, mode: 'move' | 'resize'): HTMLButtonElement {
	const name = mode === 'move' ? /キーボードで移動/ : /キーボードでサイズ変更/;
	const button = [...dialog.querySelectorAll<HTMLButtonElement>('button.key-btn')].find((b) =>
		name.test(b.getAttribute('aria-label') ?? '')
	)!;
	button.focus();
	button.click();
	flushSync();
	return button;
}

describe('canStartGesture', () => {
	it('refuses a resize: nothing moves, no listener, no onGestureEnd', () => {
		const canStartGesture = vi.fn(() => false);
		const onGestureEnd = vi.fn();
		const { dock, dialog } = mount(floating(), { canStartGesture, onGestureEnd });
		firePointer(dialog('A').querySelector('.handle-se')!, 'pointerdown', 360, 240);
		firePointer(window, 'pointermove', 430, 240);
		firePointer(window, 'pointerup', 430, 240);
		expect(canStartGesture).toHaveBeenCalledWith('resize', 'a');
		expect(win(dock, 'a').width).toBe(320);
		expect(onGestureEnd).not.toHaveBeenCalled();
		expect(net).toBe(0);
	});

	it('is asked as `drag` at the threshold; a refused drag drops nothing and is not a click', () => {
		const canStartGesture = vi.fn(() => false);
		const onGestureEnd = vi.fn();
		const { dock } = mount(tabs(), { canStartGesture, onGestureEnd });
		const tabY = screen.getByRole('tab', { name: 'Y' });
		firePointer(tabY, 'pointerdown', 100, 10);
		expect(canStartGesture).not.toHaveBeenCalled();
		firePointer(window, 'pointermove', 140, 60);
		flushSync();
		expect(canStartGesture).toHaveBeenCalledWith('drag', 'y');
		expect(document.querySelector('.drag-ghost')).toBeNull();
		firePointer(window, 'pointerup', 140, 60);
		expect((dock.layout.docked as { activeIndex: number }).activeIndex).toBe(0);
		// The vetoed gesture never started, so it reports no end (PR #446 review).
		expect(onGestureEnd).not.toHaveBeenCalled();
		expect(net).toBe(0);
	});

	it('does not stand in the way of a plain tab click (never asked below the threshold)', () => {
		const canStartGesture = vi.fn(() => false);
		const { dock } = mount(tabs(), { canStartGesture });
		const tabZ = screen.getByRole('tab', { name: 'Z' });
		firePointer(tabZ, 'pointerdown', 100, 10);
		firePointer(window, 'pointerup', 101, 10);
		expect((dock.layout.docked as { activeIndex: number }).activeIndex).toBe(2);
		expect(canStartGesture).not.toHaveBeenCalled();
	});

	it('refuses the keyboard mode and a divider key step', () => {
		const canStartGesture = vi.fn(() => false);
		const { dock, dialog } = mount(split(), { canStartGesture });
		const button = enterMode(dialog('F'), 'move');
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(canStartGesture).toHaveBeenCalledWith('move', 'f');
		const divider = screen.getByRole('separator');
		press(divider, 'ArrowRight');
		expect(canStartGesture).toHaveBeenCalledWith('divider', null);
		expect(sizes(dock)).toEqual([0.5, 0.5]);
		expect(net).toBe(0);
	});
});

describe('onGestureEnd', () => {
	it('reports a commit exactly once, after the layout has it', () => {
		const seen: number[] = [];
		const { dock, dialog } = mount(floating(), {
			onGestureEnd: (kind, outcome, reason) => {
				expect([kind, outcome, reason]).toEqual(['resize', 'commit', undefined]);
				seen.push(win(dock, 'a').width);
			}
		});
		firePointer(dialog('A').querySelector('.handle-se')!, 'pointerdown', 360, 240);
		firePointer(window, 'pointermove', 400, 240);
		firePointer(window, 'pointerup', 430, 240);
		expect(seen).toEqual([390]);
	});

	it('reports a cancel with its reason exactly once, after the target was restored', () => {
		const onGestureEnd = vi.fn();
		const { dock, dialog } = mount(floating(), {
			onGestureEnd: (...args) => onGestureEnd(...args, win(dock, 'a').width)
		});
		firePointer(dialog('A').querySelector('.handle-se')!, 'pointerdown', 360, 240);
		firePointer(window, 'pointermove', 430, 240);
		press(window, 'Escape');
		firePointer(window, 'pointerup', 430, 240);
		expect(onGestureEnd).toHaveBeenCalledExactlyOnceWith('resize', 'cancel', 'escape', 320);
	});

	it('may unmount the host from inside the hook (re-entrancy): no listener survives', () => {
		let unmount: () => void = () => {};
		const onGestureEnd = vi.fn(() => unmount());
		const { dialog, view } = mount(floating(), { onGestureEnd });
		unmount = () => view.unmount();
		const button = enterMode(dialog('A'), 'move');
		press(button, 'ArrowRight');
		press(button, 'Enter');
		expect(onGestureEnd).toHaveBeenCalledExactlyOnceWith('move', 'commit', undefined);
		expect(document.querySelector('[data-dock-host]')).toBeNull();
		expect(net).toBe(0);
	});

	it('may start the next keyboard mode from inside the hook (re-entrancy)', () => {
		let again: () => void = () => {};
		const onGestureEnd = vi.fn(() => {
			again();
			again = () => {};
		});
		const { dock, dialog } = mount(floating(), { onGestureEnd });
		const moveBtn = enterMode(dialog('A'), 'move');
		again = () => moveBtn.click();
		press(moveBtn, 'Enter'); // ends the first mode; the hook enters it again
		flushSync();
		expect(moveBtn.getAttribute('aria-pressed')).toBe('true');
		press(moveBtn, 'ArrowDown');
		expect(win(dock, 'a').y).toBe(50);
		press(moveBtn, 'Escape');
		expect(win(dock, 'a').y).toBe(40);
		expect(onGestureEnd).toHaveBeenCalledTimes(2);
		expect(net).toBe(0);
	});
});

describe('isEscapeBlocked', () => {
	it('is asked with the floating window root; true yields the Esc and the gesture goes on', () => {
		const isEscapeBlocked = vi.fn(() => true);
		const { dock, dialog } = mount(floating(), { isEscapeBlocked });
		firePointer(dialog('A').querySelector('.handle-se')!, 'pointerdown', 360, 240);
		firePointer(window, 'pointermove', 430, 240);
		const esc = press(window, 'Escape');
		expect(isEscapeBlocked).toHaveBeenCalledWith(dialog('A'));
		expect(esc.defaultPrevented).toBe(false);
		expect(win(dock, 'a').width).toBe(390);
		firePointer(window, 'pointerup', 430, 240);
		expect(win(dock, 'a').width).toBe(390);
		expect(net).toBe(0);
	});

	it('is not asked for an Esc a higher layer already consumed', () => {
		const isEscapeBlocked = vi.fn(() => false);
		const { dock, dialog } = mount(floating(), { isEscapeBlocked });
		const button = enterMode(dialog('A'), 'move');
		press(button, 'ArrowRight');
		const consumer = (e: KeyboardEvent) => e.preventDefault();
		button.addEventListener('keydown', consumer);
		press(button, 'Escape');
		button.removeEventListener('keydown', consumer);
		expect(isEscapeBlocked).not.toHaveBeenCalled();
		expect(win(dock, 'a').x).toBe(50);
		press(button, 'Enter');
		expect(net).toBe(0);
	});
});

describe('plan regression: a floating window open, Esc during a divider gesture', () => {
	it('returns the divider to where it started (the hook gets null and ignores the non-modal window)', () => {
		const isEscapeBlocked = vi.fn(appLikeEscapeBlocked);
		const { dock } = mount(split(), { isEscapeBlocked });
		expect(screen.getByRole('dialog', { name: 'F' })).toBeTruthy();
		firePointer(screen.getByRole('separator'), 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 600, 100);
		expect(sizes(dock)[0]).toBeCloseTo(0.6);
		expect(press(window, 'Escape').defaultPrevented).toBe(true);
		expect(isEscapeBlocked).toHaveBeenCalledWith(null);
		expect(sizes(dock)).toEqual([0.5, 0.5]);
		expect(net).toBe(0);
	});

	it('yields the Esc to an open Modal, and to a Menu', () => {
		for (const attrs of <Record<string, string>[]>[
			{ role: 'dialog', 'aria-modal': 'true' },
			{ role: 'menu' }
		]) {
			const { dock } = mount(split(), { isEscapeBlocked: appLikeEscapeBlocked });
			const layer = addLayer(attrs);
			firePointer(screen.getByRole('separator'), 'pointerdown', 500, 100);
			firePointer(window, 'pointermove', 600, 100);
			expect(press(window, 'Escape').defaultPrevented).toBe(false);
			expect(sizes(dock)[0]).toBeCloseTo(0.6);
			firePointer(window, 'pointerup', 600, 100);
			layer.remove();
			cleanup();
		}
		expect(net).toBe(0);
	});
});

describe('divider: WAI-ARIA Window Splitter', () => {
	it('is a focusable separator with the pair share as its value', () => {
		mount(split());
		const divider = screen.getByRole('separator');
		expect(divider.getAttribute('tabindex')).toBe('0');
		expect(divider.getAttribute('aria-orientation')).toBe('vertical');
		expect(divider.getAttribute('aria-valuenow')).toBe('50');
		expect(divider.getAttribute('aria-valuemin')).toBe('10');
		expect(divider.getAttribute('aria-valuemax')).toBe('90');
	});

	it('arrows of its axis, Shift, Home and End move it; each step is one committed divider gesture', () => {
		const onGestureEnd = vi.fn();
		const { dock } = mount(split(), { onGestureEnd });
		const divider = screen.getByRole('separator');
		expect(press(divider, 'ArrowRight').defaultPrevented).toBe(true);
		expect(divider.getAttribute('aria-valuenow')).toBe('52');
		press(divider, 'ArrowRight', { shiftKey: true });
		expect(divider.getAttribute('aria-valuenow')).toBe('62');
		press(divider, 'ArrowLeft');
		expect(sizes(dock)[0]).toBeCloseTo(0.6);
		expect(press(divider, 'ArrowUp').defaultPrevented).toBe(false); // not this axis
		press(divider, 'Home');
		expect(divider.getAttribute('aria-valuenow')).toBe('10');
		press(divider, 'End');
		expect(divider.getAttribute('aria-valuenow')).toBe('90');
		expect(onGestureEnd).toHaveBeenCalledTimes(5);
		expect(onGestureEnd).toHaveBeenLastCalledWith('divider', 'commit', undefined);
		expect(net).toBe(0);
	});

	it('leaves IME composition and modifier combinations alone', () => {
		const { dock } = mount(split());
		const divider = screen.getByRole('separator');
		expect(pressComposing(divider, 'ArrowRight').defaultPrevented).toBe(false);
		expect(
			press(divider, 'ArrowRight', { keyCode: 229 } as KeyboardEventInit).defaultPrevented
		).toBe(false);
		expect(press(divider, 'ArrowRight', { ctrlKey: true }).defaultPrevented).toBe(false);
		expect(sizes(dock)).toEqual([0.5, 0.5]);
	});

	it('does nothing while a pointer gesture is active', () => {
		const { dock, dialog } = mount(split());
		firePointer(dialog('F').querySelector('.handle-se')!, 'pointerdown', 900, 500);
		press(screen.getByRole('separator'), 'ArrowRight');
		expect(sizes(dock)).toEqual([0.5, 0.5]);
		firePointer(window, 'pointerup', 900, 500);
		expect(net).toBe(0);
	});
});

describe('floating window: explicit keyboard move / resize mode', () => {
	it('move: arrows move, Shift moves more, Enter commits', () => {
		const onGestureEnd = vi.fn();
		const { dock, dialog } = mount(floating(), { onGestureEnd });
		const button = enterMode(dialog('A'), 'move');
		expect(button.getAttribute('aria-pressed')).toBe('true');
		expect(press(button, 'ArrowRight').defaultPrevented).toBe(true);
		press(button, 'ArrowDown', { shiftKey: true });
		expect([win(dock, 'a').x, win(dock, 'a').y]).toEqual([50, 90]);
		expect(press(button, 'Enter').defaultPrevented).toBe(true);
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(onGestureEnd).toHaveBeenCalledExactlyOnceWith('move', 'commit', undefined);
		// After the mode, arrows on the button do nothing.
		press(button, 'ArrowRight');
		expect(win(dock, 'a').x).toBe(50);
		expect(net).toBe(0);
	});

	it('the button again commits too', () => {
		const { dock, dialog } = mount(floating());
		const button = enterMode(dialog('A'), 'move');
		press(button, 'ArrowLeft');
		button.click();
		flushSync();
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(win(dock, 'a').x).toBe(30);
		expect(net).toBe(0);
	});

	it('Esc cancels and restores only this window (an app change meanwhile is kept)', () => {
		const onGestureEnd = vi.fn();
		const { dock, dialog } = mount(floating(), { onGestureEnd });
		const button = enterMode(dialog('A'), 'move');
		press(button, 'ArrowRight', { shiftKey: true });
		dock.move('b', 20, 0, 1000, 600); // the app moves another window meanwhile
		expect(press(button, 'Escape').defaultPrevented).toBe(true);
		expect([win(dock, 'a').x, win(dock, 'a').y]).toEqual([40, 40]);
		expect(win(dock, 'b').x).toBe(520);
		expect(onGestureEnd).toHaveBeenCalledExactlyOnceWith('move', 'cancel', 'escape');
		expect(net).toBe(0);
	});

	it('resize: arrows change the size from the bottom-right corner; Esc restores it', () => {
		const { dock, dialog } = mount(floating());
		const button = enterMode(dialog('A'), 'resize');
		press(button, 'ArrowRight');
		press(button, 'ArrowDown', { shiftKey: true });
		expect([win(dock, 'a').width, win(dock, 'a').height]).toEqual([330, 250]);
		expect([win(dock, 'a').x, win(dock, 'a').y]).toEqual([40, 40]);
		press(button, 'Escape');
		expect([win(dock, 'a').width, win(dock, 'a').height]).toEqual([320, 200]);
		expect(net).toBe(0);
	});

	it('moving the focus away cancels the mode (reason blur)', () => {
		const onGestureEnd = vi.fn();
		const { dock, dialog } = mount(floating(), { onGestureEnd });
		const button = enterMode(dialog('A'), 'move');
		press(button, 'ArrowRight');
		screen.getByRole('textbox', { name: 'A input' }).focus();
		flushSync();
		expect(win(dock, 'a').x).toBe(40);
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(onGestureEnd).toHaveBeenCalledExactlyOnceWith('move', 'cancel', 'blur');
		expect(net).toBe(0);
	});

	it('leaves IME composition and modifier combinations alone', () => {
		const { dock, dialog } = mount(floating());
		const button = enterMode(dialog('A'), 'move');
		expect(pressComposing(button, 'ArrowRight').defaultPrevented).toBe(false);
		expect(pressComposing(button, 'Enter').defaultPrevented).toBe(false);
		expect(press(button, 'ArrowRight', { altKey: true }).defaultPrevented).toBe(false);
		expect(win(dock, 'a').x).toBe(40);
		expect(button.getAttribute('aria-pressed')).toBe('true');
		// Esc during composition is not a cancel either.
		pressComposing(button, 'Escape');
		expect(button.getAttribute('aria-pressed')).toBe('true');
		press(button, 'Enter');
		expect(net).toBe(0);
	});

	it('yields the Esc to a layer above the window, then Enter still commits', () => {
		const isEscapeBlocked = vi.fn(appLikeEscapeBlocked);
		const { dock, dialog } = mount(floating(), { isEscapeBlocked });
		const button = enterMode(dialog('A'), 'move');
		press(button, 'ArrowRight');
		const modal = addLayer({ role: 'dialog', 'aria-modal': 'true' });
		expect(press(button, 'Escape').defaultPrevented).toBe(false);
		expect(isEscapeBlocked).toHaveBeenCalledWith(dialog('A'));
		expect(button.getAttribute('aria-pressed')).toBe('true');
		modal.remove();
		press(button, 'Enter');
		expect(win(dock, 'a').x).toBe(50);
		expect(net).toBe(0);
	});

	it('the move button is absent when the window may not move; resize stays', () => {
		const dock = createDockState(floating());
		render(DockHostHarness, {
			dock,
			capabilities: (id: string) => (id === 'a' ? { move: false } : undefined)
		});
		const buttons = screen.getByRole('dialog', { name: 'A' }).querySelectorAll('button.key-btn');
		expect(buttons).toHaveLength(1);
		expect(buttons[0].getAttribute('aria-label')).toMatch(/サイズ変更/);
	});
});

describe('keys the dock does not take', () => {
	it('arrows in a panel input, and arrows on the window, change nothing', () => {
		const { dock } = mount(split());
		const input = screen.getByRole('textbox', { name: 'L input' });
		input.focus();
		expect(press(input, 'ArrowRight').defaultPrevented).toBe(false);
		expect(press(window, 'ArrowRight').defaultPrevented).toBe(false);
		expect(press(document.body, 'Escape').defaultPrevented).toBe(false);
		expect(sizes(dock)).toEqual([0.5, 0.5]);
		expect(net).toBe(0);
	});
});

describe('tab strip: arrows', () => {
	it('roving tabindex: only the active tab is a Tab stop', () => {
		mount(tabs());
		const t = screen.getAllByRole('tab');
		expect(t.map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
	});

	it('Right / Left (wrapping), Home and End select and focus a tab', () => {
		const { dock } = mount(tabs());
		const active = () => (dock.layout.docked as { activeIndex: number }).activeIndex;
		const tab = (name: string) => screen.getByRole('tab', { name });
		tab('X').focus();
		expect(press(tab('X'), 'ArrowRight').defaultPrevented).toBe(true);
		expect(active()).toBe(1);
		expect(document.activeElement).toBe(tab('Y'));
		expect(tab('Y').getAttribute('tabindex')).toBe('0');
		press(tab('Y'), 'End');
		expect(active()).toBe(2);
		press(tab('Z'), 'ArrowRight');
		expect(active()).toBe(0);
		press(tab('X'), 'ArrowLeft');
		expect(active()).toBe(2);
		press(tab('Z'), 'Home');
		expect(active()).toBe(0);
		expect(document.activeElement).toBe(tab('X'));
	});

	it('ignores keys from its nested buttons, IME composition and modifiers', () => {
		const { dock } = mount(tabs());
		const active = () => (dock.layout.docked as { activeIndex: number }).activeIndex;
		const closeBtn = screen.getByRole('tab', { name: 'X' }).querySelector('button')!;
		expect(press(closeBtn, 'ArrowRight').defaultPrevented).toBe(false);
		expect(
			pressComposing(screen.getByRole('tab', { name: 'X' }), 'ArrowRight').defaultPrevented
		).toBe(false);
		expect(
			press(screen.getByRole('tab', { name: 'X' }), 'ArrowRight', { metaKey: true })
				.defaultPrevented
		).toBe(false);
		expect(active()).toBe(0);
	});
});

describe('keyboard mode ends when its window or button goes away (PR #446 review)', () => {
	it('closing the window in move mode cancels that session (no blur needed), so other windows work again', () => {
		const onGestureEnd = vi.fn();
		const { dock, dialog } = mount(floating(), { onGestureEnd });
		const names = dock.layout.floating.map((w) => w.id);
		enterMode(dialog(names[0].toUpperCase()), 'move');
		dock.close(names[0]);
		flushSync();
		expect(onGestureEnd).toHaveBeenCalledWith('move', 'cancel', 'unmount');
		const other = enterMode(dialog(names[1].toUpperCase()), 'move');
		expect(other.getAttribute('aria-pressed')).toBe('true');
	});

	it("another window's teardown does not cancel this window's mode", () => {
		const onGestureEnd = vi.fn();
		const { dock, dialog } = mount(floating(), { onGestureEnd });
		const names = dock.layout.floating.map((w) => w.id);
		const button = enterMode(dialog(names[0].toUpperCase()), 'resize');
		dock.close(names[1]);
		flushSync();
		expect(onGestureEnd).not.toHaveBeenCalled();
		expect(button.getAttribute('aria-pressed')).toBe('true');
	});

	it('hiding the move button through capabilities ends the move mode', async () => {
		const onGestureEnd = vi.fn();
		const { dock, view, dialog } = mount(floating(), { onGestureEnd });
		const id = dock.layout.floating[0].id;
		enterMode(dialog(id.toUpperCase()), 'move');
		await view.rerender({ capabilities: () => ({ move: false }) });
		flushSync();
		expect(onGestureEnd).toHaveBeenCalledWith('move', 'cancel', 'api');
	});
});
