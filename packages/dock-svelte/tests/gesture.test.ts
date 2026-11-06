// @vitest-environment jsdom
//
// GestureOwner state machine (core/gesture.svelte.ts, shared-primitives-
// upstream-plan §3.3, #433): one session at a time, only the owning primary
// pointer moves / commits, every cancel trigger restores the snapshot of a
// live-writing kind, listeners never outlive a session, and callbacks may
// re-enter (start a new session / dispose) without leaking.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GestureOwner,
	type GestureCancelReason,
	type GestureKind,
	type GestureOwnerOptions
} from '../src/core/gesture.svelte';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

const layout = (): DockLayout => ({
	version: 2,
	floating: [{ id: 'a', title: 'A', x: 40, y: 40, width: 320, height: 200, open: true }],
	docked: null
});

function pointer(type: string, init: Record<string, unknown> = {}): Event {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: 0, clientY: 0, pointerId: 1, button: 0, isPrimary: true, ...init });
	return ev;
}

function key(keyName: string, init: KeyboardEventInit = {}): KeyboardEvent {
	return new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init });
}

/** Net listeners added to window/document for the owner's event types (adds - removes). */
const TYPES = new Set([
	'pointermove',
	'pointerup',
	'pointercancel',
	'lostpointercapture',
	'keydown',
	'blur',
	'visibilitychange'
]);
let net = 0;

beforeEach(() => {
	net = 0;
	for (const target of [window, document] as EventTarget[]) {
		const add = target.addEventListener.bind(target);
		const remove = target.removeEventListener.bind(target);
		vi.spyOn(target, 'addEventListener').mockImplementation((type, fn, opts) => {
			if (TYPES.has(type)) net++;
			add(type, fn, opts);
		});
		vi.spyOn(target, 'removeEventListener').mockImplementation((type, fn, opts) => {
			if (TYPES.has(type)) net--;
			remove(type, fn, opts);
		});
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

function setup(options: GestureOwnerOptions = {}) {
	const dock = createDockState(layout());
	const owner = new GestureOwner(
		dock,
		() => null,
		() => options
	);
	return { dock, owner };
}

/** A `resize`-like session that widens window `a` by the pointer's dx on every move. */
function beginResize(
	owner: GestureOwner,
	dock: ReturnType<typeof createDockState>,
	kind: GestureKind = 'resize'
) {
	const calls = { move: 0, commit: 0, cancel: [] as GestureCancelReason[] };
	let last = 0;
	const ok = owner.begin(pointer('pointerdown') as PointerEvent, {
		kind,
		panelId: 'a',
		move(e) {
			calls.move++;
			dock.resize('a', 'e', e.clientX - last, 0, 1000, 600);
			last = e.clientX;
		},
		commit() {
			calls.commit++;
		},
		cancel(reason) {
			calls.cancel.push(reason);
		}
	});
	return { ok, calls };
}

describe('GestureOwner: one session, owning pointer only', () => {
	it('refuses a second session, a non-primary pointer and a non-main button', () => {
		const { dock, owner } = setup();
		expect(
			owner.begin(pointer('pointerdown', { isPrimary: false }) as PointerEvent, { kind: 'resize' })
		).toBe(false);
		expect(
			owner.begin(pointer('pointerdown', { button: 2 }) as PointerEvent, { kind: 'resize' })
		).toBe(false);
		expect(net).toBe(0);
		expect(beginResize(owner, dock).ok).toBe(true);
		expect(
			owner.begin(pointer('pointerdown', { pointerId: 2 }) as PointerEvent, { kind: 'divider' })
		).toBe(false);
		expect(owner.session?.kind).toBe('resize');
		owner.cancel();
		expect(net).toBe(0);
	});

	it("ignores another pointer's move, up, cancel and capture loss", () => {
		const { dock, owner } = setup();
		const { calls } = beginResize(owner, dock);
		window.dispatchEvent(pointer('pointermove', { pointerId: 999, clientX: 50 }));
		window.dispatchEvent(pointer('pointerup', { pointerId: 999, clientX: 50 }));
		window.dispatchEvent(pointer('pointercancel', { pointerId: 999 }));
		document.body.dispatchEvent(pointer('lostpointercapture', { pointerId: 999 }));
		expect(calls).toEqual({ move: 0, commit: 0, cancel: [] });
		expect(owner.active).toBe(true);
		window.dispatchEvent(pointer('pointerup', { clientX: 0 }));
		expect(calls.commit).toBe(1);
		expect(owner.active).toBe(false);
		expect(net).toBe(0);
	});

	it('commits on the owning pointerup with the session closed and listeners gone', () => {
		const onEnd = vi.fn();
		const { dock, owner } = setup({ onEnd });
		let activeInCommit: boolean | null = null;
		let netInCommit = -1;
		owner.begin(pointer('pointerdown') as PointerEvent, {
			kind: 'resize',
			commit() {
				activeInCommit = owner.active;
				netInCommit = net;
			}
		});
		window.dispatchEvent(pointer('pointerup'));
		expect(activeInCommit).toBe(false);
		expect(netInCommit).toBe(0);
		expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ kind: 'resize' }), 'commit');
		expect(dock.layout.floating[0].width).toBe(320);
	});
});

describe('GestureOwner: cancel restores the snapshot and frees listeners', () => {
	const triggers: [GestureCancelReason, () => void][] = [
		['escape', () => window.dispatchEvent(key('Escape'))],
		['pointercancel', () => window.dispatchEvent(pointer('pointercancel'))],
		['lostpointercapture', () => document.body.dispatchEvent(pointer('lostpointercapture'))],
		['blur', () => window.dispatchEvent(new Event('blur'))],
		[
			'hidden',
			() => {
				Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
				document.dispatchEvent(new Event('visibilitychange'));
				Reflect.deleteProperty(document, 'visibilityState');
			}
		]
	];

	for (const [reason, fire] of triggers) {
		it(`${reason}: back to the pre-gesture layout, later moves ignored`, () => {
			const onEnd = vi.fn();
			const { dock, owner } = setup({ onEnd });
			const { calls } = beginResize(owner, dock);
			window.dispatchEvent(pointer('pointermove', { clientX: 70 }));
			expect(dock.layout.floating[0].width).toBe(390);
			fire();
			expect(dock.layout.floating[0].width).toBe(320);
			expect(calls.cancel).toEqual([reason]);
			expect(onEnd).toHaveBeenCalledWith(
				expect.objectContaining({ kind: 'resize' }),
				'cancel',
				reason
			);
			expect(net).toBe(0);
			window.dispatchEvent(pointer('pointermove', { clientX: 140 }));
			window.dispatchEvent(pointer('pointerup', { clientX: 140 }));
			expect(dock.layout.floating[0].width).toBe(320);
			expect(calls.move).toBe(1);
			expect(calls.commit).toBe(0);
		});
	}

	it('dispose (DockHost unmount) cancels with "unmount" and refuses new sessions', () => {
		const { dock, owner } = setup();
		const { calls } = beginResize(owner, dock);
		window.dispatchEvent(pointer('pointermove', { clientX: 30 }));
		owner.dispose();
		expect(dock.layout.floating[0].width).toBe(320);
		expect(calls.cancel).toEqual(['unmount']);
		expect(net).toBe(0);
		expect(beginResize(owner, dock).ok).toBe(false);
		expect(net).toBe(0);
	});

	it('a drag kind restores nothing (no live write), so a concurrent app change survives', () => {
		const { dock, owner } = setup();
		owner.begin(pointer('pointerdown') as PointerEvent, { kind: 'drag-candidate' });
		owner.setKind('drag');
		dock.close('a');
		window.dispatchEvent(key('Escape'));
		expect(owner.active).toBe(false);
		expect(dock.layout.floating[0].open).toBe(false);
	});

	it('ignores a capture loss whose target left the document (a DOM move is not an abort)', () => {
		const { dock, owner } = setup();
		beginResize(owner, dock);
		const detached = document.createElement('div');
		detached.dispatchEvent(pointer('lostpointercapture'));
		document.dispatchEvent(pointer('lostpointercapture'));
		expect(owner.active).toBe(true);
		owner.cancel();
	});
});

describe('GestureOwner: Esc is taken only when nobody else did', () => {
	it('consumes an unclaimed Esc (preventDefault)', () => {
		const { dock, owner } = setup();
		beginResize(owner, dock);
		const ev = key('Escape');
		window.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(owner.active).toBe(false);
	});

	it('yields an Esc a higher layer already consumed', () => {
		const { dock, owner } = setup();
		beginResize(owner, dock);
		const ev = key('Escape');
		ev.preventDefault();
		window.dispatchEvent(ev);
		expect(owner.active).toBe(true);
		owner.cancel();
	});

	it('yields while the isEscapeBlocked hook says so, and passes the active layer', () => {
		const layer = document.createElement('div');
		const isEscapeBlocked = vi.fn(() => true);
		const { owner } = setup({ isEscapeBlocked });
		owner.begin(pointer('pointerdown') as PointerEvent, { kind: 'resize', activeLayer: layer });
		const ev = key('Escape');
		window.dispatchEvent(ev);
		expect(isEscapeBlocked).toHaveBeenCalledWith(layer);
		expect(ev.defaultPrevented).toBe(false);
		expect(owner.active).toBe(true);
		owner.cancel();
	});

	it('ignores Esc during IME composition and other keys', () => {
		const { dock, owner } = setup();
		beginResize(owner, dock);
		window.dispatchEvent(key('Escape', { isComposing: true }));
		window.dispatchEvent(key('Enter'));
		expect(owner.active).toBe(true);
		owner.cancel();
	});
});

describe('GestureOwner: re-entrant callbacks', () => {
	it('a commit callback may start the next session; it gets exactly one set of listeners', () => {
		const { owner } = setup();
		const listenersPerSession = (() => {
			owner.begin(pointer('pointerdown') as PointerEvent, { kind: 'resize' });
			const n = net;
			owner.cancel();
			return n;
		})();
		let second = false;
		owner.begin(pointer('pointerdown') as PointerEvent, {
			kind: 'drag-candidate',
			commit() {
				second = owner.begin(pointer('pointerdown', { pointerId: 2 }) as PointerEvent, {
					kind: 'divider'
				});
			}
		});
		window.dispatchEvent(pointer('pointerup'));
		expect(second).toBe(true);
		expect(owner.session?.kind).toBe('divider');
		expect(owner.session?.pointerId).toBe(2);
		expect(net).toBe(listenersPerSession);
		// The old pointer no longer drives anything; the new one does.
		window.dispatchEvent(pointer('pointerup'));
		expect(owner.active).toBe(true);
		window.dispatchEvent(pointer('pointerup', { pointerId: 2 }));
		expect(owner.active).toBe(false);
		expect(net).toBe(0);
	});

	it('an onEnd hook may dispose the owner mid-cancel without leaking or double-ending', () => {
		const ends: string[] = [];
		const dock = createDockState(layout());
		const owner: GestureOwner = new GestureOwner(
			dock,
			() => null,
			() => ({
				onEnd(_s, outcome, reason) {
					ends.push(`${outcome}:${reason}`);
					owner.dispose();
				}
			})
		);
		beginResize(owner, dock);
		window.dispatchEvent(pointer('pointermove', { clientX: 50 }));
		window.dispatchEvent(new Event('blur'));
		expect(ends).toEqual(['cancel:blur']);
		expect(dock.layout.floating[0].width).toBe(320);
		expect(net).toBe(0);
		expect(owner.active).toBe(false);
	});
});

describe('cancel undoes only the gesture target (PR #445)', () => {
	it('a resize with restore puts back the window geometry and keeps an app change made meanwhile', () => {
		const { dock, owner } = setup();
		let last = 0;
		owner.begin(pointer('pointerdown') as PointerEvent, {
			kind: 'resize',
			panelId: 'a',
			move(e) {
				dock.resize('a', 'e', e.clientX - last, 0, 1000, 600);
				last = e.clientX;
			},
			restore: (snapshot) => dock.restoreWindowGeometry('a', snapshot)
		});
		window.dispatchEvent(pointer('pointermove', { clientX: 70 }));
		dock.ensureWindow({ id: 'b', title: 'B', width: 200, height: 150 }, 1000, 600); // the app opens a window
		window.dispatchEvent(key('Escape'));
		expect(dock.layout.floating.find((w) => w.id === 'a')?.width).toBe(320);
		expect(dock.layout.floating.some((w) => w.id === 'b')).toBe(true);
		expect(net).toBe(0);
	});

	it('restoreSplitSizes puts back one split and leaves the rest of the tree as it is now', () => {
		const dock = createDockState({
			version: 2,
			floating: [{ id: 'f', title: 'F', x: 0, y: 0, width: 100, height: 100, open: true }],
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: [
					{ type: 'panel', id: 'p1', title: 'P1' },
					{ type: 'panel', id: 'p2', title: 'P2' }
				]
			}
		});
		const before = JSON.parse(JSON.stringify(dock.layout)) as DockLayout;
		dock.resizeSplit('s', 0, 0.2);
		dock.close('f'); // an app change during the drag
		dock.restoreSplitSizes('s', before);
		const split = dock.layout.docked;
		expect(split?.type === 'split' && split.sizes).toEqual([0.5, 0.5]);
		expect(dock.layout.floating[0].open).toBe(false);
	});
});

describe('dispose refuses a session begun from its own cancel callbacks (PR #445 review)', () => {
	it('dispose -> cancel / onEnd -> begin leaves no live session or listener', () => {
		const restarted: boolean[] = [];
		const options: GestureOwnerOptions = {};
		const { dock, owner } = setup(options);
		options.onEnd = () => {
			restarted.push(
				owner.begin(pointer('pointerdown', { pointerId: 2 }) as PointerEvent, { kind: 'divider' })
			);
		};
		owner.begin(pointer('pointerdown') as PointerEvent, {
			kind: 'resize',
			panelId: 'a',
			cancel: () => {
				restarted.push(
					owner.begin(pointer('pointerdown', { pointerId: 3 }) as PointerEvent, { kind: 'divider' })
				);
			}
		});
		owner.dispose();
		expect(restarted).toEqual([false, false]);
		expect(owner.active).toBe(false);
		expect(net).toBe(0);
		window.dispatchEvent(pointer('pointerup', { pointerId: 2 }));
		expect(dock.layout.floating[0].width).toBe(320);
	});
});

describe('hooks and keyboard sessions (#433-b, PR-5)', () => {
	it('canStart refuses before a session exists: no listener, no onEnd', () => {
		const onEnd = vi.fn();
		const canStart = vi.fn(() => false);
		const { owner } = setup({ canStart, onEnd });
		expect(
			owner.begin(pointer('pointerdown') as PointerEvent, { kind: 'resize', panelId: 'a' })
		).toBe(false);
		expect(owner.beginKeyboard({ kind: 'move', panelId: 'a' })).toBe(false);
		const apply = vi.fn();
		expect(owner.instant('divider', null, apply)).toBe(false);
		expect(canStart.mock.calls).toEqual([
			['resize', 'a'],
			['move', 'a'],
			['divider', null]
		]);
		expect(apply).not.toHaveBeenCalled();
		expect(onEnd).not.toHaveBeenCalled();
		expect(owner.active).toBe(false);
		expect(net).toBe(0);
	});

	it('canStart is not asked for drag-candidate, but as drag by setKind; a refusal discards the press silently', () => {
		const canStart = vi.fn(() => false);
		const onEnd = vi.fn();
		const commit = vi.fn();
		const cancel = vi.fn();
		const { owner } = setup({ canStart, onEnd });
		expect(
			owner.begin(pointer('pointerdown') as PointerEvent, {
				kind: 'drag-candidate',
				panelId: 'a',
				commit,
				cancel
			})
		).toBe(true);
		expect(canStart).not.toHaveBeenCalled();
		expect(owner.setKind('drag')).toBe(false);
		expect(canStart).toHaveBeenCalledWith('drag', 'a');
		// The vetoed gesture never started: no session, no listener, and the
		// release reports nothing (PR #446 review).
		expect(owner.active).toBe(false);
		expect(net).toBe(0);
		window.dispatchEvent(pointer('pointerup'));
		expect(commit).not.toHaveBeenCalled();
		expect(cancel).not.toHaveBeenCalled();
		expect(onEnd).not.toHaveBeenCalled();
	});

	it('a canStart hook that starts a session itself makes the outer start fail (re-entrancy)', () => {
		const options: GestureOwnerOptions = {};
		const { owner } = setup(options);
		let inner = false;
		options.canStart = (kind) => {
			if (kind === 'resize') inner = owner.beginKeyboard({ kind: 'move', panelId: 'a' });
			return true;
		};
		expect(owner.begin(pointer('pointerdown') as PointerEvent, { kind: 'resize' })).toBe(false);
		expect(inner).toBe(true);
		expect(owner.session?.kind).toBe('move');
		owner.cancel();
		expect(net).toBe(0);
	});

	it('a keyboard session ignores pointers, commits by commitKeyboard and cancels by blur', () => {
		const onEnd = vi.fn();
		const { dock, owner } = setup({ onEnd });
		const commit = vi.fn();
		expect(owner.beginKeyboard({ kind: 'move', panelId: 'a', commit })).toBe(true);
		expect(owner.session?.pointerId).toBeNull();
		window.dispatchEvent(pointer('pointerup'));
		window.dispatchEvent(pointer('pointercancel'));
		expect(owner.active).toBe(true);
		dock.move('a', 10, 0, 1000, 600);
		owner.commitKeyboard();
		expect(commit).toHaveBeenCalledOnce();
		expect(onEnd).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ kind: 'move' }),
			'commit'
		);
		expect(dock.layout.floating[0].x).toBe(50);
		expect(net).toBe(0);

		owner.beginKeyboard({
			kind: 'resize',
			panelId: 'a',
			restore: (snap) => dock.restoreWindowGeometry('a', snap)
		});
		dock.resize('a', 'se', 30, 0, 1000, 600);
		window.dispatchEvent(new Event('blur'));
		expect(dock.layout.floating[0].width).toBe(320);
		expect(onEnd).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: 'resize' }),
			'cancel',
			'blur'
		);
		expect(net).toBe(0);
	});

	it('commitKeyboard does not end a pointer session', () => {
		const { owner } = setup();
		owner.begin(pointer('pointerdown') as PointerEvent, { kind: 'resize' });
		owner.commitKeyboard();
		expect(owner.active).toBe(true);
		owner.cancel();
		expect(net).toBe(0);
	});

	it('instant applies and reports one commit; refused while a session is active or disposed', () => {
		const onEnd = vi.fn();
		const { owner } = setup({ onEnd });
		const apply = vi.fn();
		expect(owner.instant('divider', null, apply)).toBe(true);
		expect(apply).toHaveBeenCalledOnce();
		expect(onEnd).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ kind: 'divider', pointerId: null }),
			'commit'
		);
		owner.beginKeyboard({ kind: 'move', panelId: 'a' });
		expect(owner.instant('divider', null, apply)).toBe(false);
		owner.dispose();
		expect(owner.instant('divider', null, apply)).toBe(false);
		expect(apply).toHaveBeenCalledOnce();
		expect(net).toBe(0);
	});
});
