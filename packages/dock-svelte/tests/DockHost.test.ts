// @vitest-environment jsdom
//
// Component/interaction tests for the dock drag layer (M-review 2026-08 M-8).
// The pure data model (`DockState`, `core/*`) already has logic tests; what was
// untested is the gesture path that turns a real pointer drag on a titlebar into
// a `DockState.move` / `DockState.undockPanel` call — `DockWindow`/`DockedTree`
// arming a drag + `core/drag.svelte.ts`'s `DragController` resolving the drop.
// These two scenarios (drag-move a floating window; float/undock a docked pane)
// drive that path end to end through a mounted `DockHost`.
//
// jsdom has no layout engine, so three stubs are load-bearing (see comments):
// ResizeObserver (DockHost binds clientWidth/clientHeight), non-zero host
// dimensions (so `DockState.move`'s clamp does not mangle coordinates), and
// `document.elementFromPoint` (so the controller's hit test lands "inside the
// host, over no docked pane" → the float branch). Pointer events are dispatched
// as plain `Event`s with coordinates assigned, since jsdom has no `PointerEvent`.
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

beforeAll(() => {
	// DockHost binds clientWidth/clientHeight via a ResizeObserver; jsdom has none.
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;

	// jsdom reports 0 for every dimension. Stub the host size non-zero so
	// `DockState.move`'s clamp-to-host keeps the moved window where the drag put
	// it instead of clamping x/y to the min-visible edge.
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get() {
			return 800;
		}
	});
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get() {
			return 600;
		}
	});

	// The DragController hit-tests the drop point with `elementFromPoint`
	// (null in jsdom). Return the host so the point resolves as "inside the host,
	// not over a [data-dock-drop-id] pane" → the float/reposition branch.
	Object.defineProperty(document, 'elementFromPoint', {
		configurable: true,
		value: () => document.querySelector('[data-dock-host]')
	});
});

afterEach(cleanup);

/**
 * Dispatch a pointer gesture step. jsdom has no `PointerEvent` constructor, so
 * assign the coordinates/ids onto a plain bubbling `Event` (same technique as
 * grid-svelte's FilterPopover test). A consistent `pointerId`/`button` keeps the
 * handlers' guards satisfied across the whole gesture.
 */
function firePointer(target: EventTarget, type: string, x: number, y: number) {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, button: 0 });
	target.dispatchEvent(ev);
}

describe('DockHost drag interactions', () => {
	it('drag-moving a floating window titlebar repositions it via dock.move', () => {
		const layout: DockLayout = {
			version: 2,
			floating: [{ id: 'a', title: 'A', x: 0, y: 0, width: 300, height: 200, open: true }],
			docked: null
		};
		const dock = createDockState(layout);
		render(DockHostHarness, { dock });

		const titlebar = screen.getByRole('dialog', { name: 'A' }).querySelector('.titlebar');
		expect(titlebar).not.toBeNull();

		// pointerdown arms the candidate; the first move past DRAG_THRESHOLD_PX (5)
		// starts the drag; the controller then owns subsequent window-level events.
		firePointer(titlebar!, 'pointerdown', 100, 100);
		firePointer(window, 'pointermove', 130, 130); // >5px → drag.start(source:'floating')
		firePointer(window, 'pointermove', 300, 300); // recompute hover → hoverFloating
		firePointer(window, 'pointerup', 300, 300); // finish → dock.move

		// Read the reactive source of truth (state updates synchronously in the
		// handlers, so no re-render tick is needed).
		expect(dock.layout.docked).toBeNull();
		expect(dock.layout.floating).toHaveLength(1);
		const win = dock.layout.floating[0];
		expect(win.x).toBeGreaterThan(0);
		expect(win.y).toBeGreaterThan(0);
	});

	it('dragging a docked pane titlebar into floating space undocks it', () => {
		const layout: DockLayout = {
			version: 2,
			floating: [],
			docked: { type: 'panel', id: 'a', title: 'A' }
		};
		const dock = createDockState(layout);
		render(DockHostHarness, { dock });

		const toolbar = screen.getByRole('toolbar', { name: 'A' }); // docked pane titlebar
		firePointer(toolbar, 'pointerdown', 100, 100);
		firePointer(window, 'pointermove', 130, 130); // >5px → drag.start(source:'docked')
		firePointer(window, 'pointermove', 300, 300); // hoverFloating (host, no drop-id)
		firePointer(window, 'pointerup', 300, 300); // finish → dock.undockPanel

		expect(dock.layout.docked).toBeNull();
		expect(dock.layout.floating).toHaveLength(1);
		expect(dock.layout.floating[0]).toMatchObject({ id: 'a', title: 'A', open: true });
	});
});
