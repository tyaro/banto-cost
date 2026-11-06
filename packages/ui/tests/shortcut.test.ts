// @vitest-environment jsdom
/**
 * @banto/ui `shortcut.ts` (docs/design/shared-primitives-upstream-plan.md
 * §3.6 / §4.3, PR-7 "#435-a"): key parsing / matching / display, the guards
 * of `shouldHandleShortcut` (IME, defaultPrevented, repeat, editable
 * elements, modal / menu layers, `ownerLayer`) and the dispatcher (scope
 * precedence, `enabled` re-checked right before `run`,
 * `preventDefaultWhenDisabled`, re-entrancy).
 *
 * Events are dispatched from a real target so `composedPath()` / `target`
 * are what a window `keydown` listener sees. jsdom lays nothing out, so
 * `getClientRects()` is stubbed as in layering.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	createShortcutDispatcher,
	formatShortcut,
	isEditableTarget,
	matchShortcut,
	parseShortcut,
	shouldHandleShortcut,
	type CommandSpec,
	type ShortcutDispatcher
} from '../src/index';

beforeAll(() => {
	Element.prototype.getClientRects = function (this: Element) {
		if (!this.isConnected) return [] as unknown as DOMRectList;
		const hidden = (node: Element | null): boolean =>
			node !== null && (getComputedStyle(node).display === 'none' || hidden(node.parentElement));
		return (hidden(this) ? [] : [{}]) as unknown as DOMRectList;
	};
});

afterEach(() => {
	document.body.replaceChildren();
});

type KeyInit = KeyboardEventInit & { keyCode?: number };

function keydown(init: KeyInit): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
	return event;
}

/** Dispatch `init` from `target` and run `listener` as a window keydown listener would. */
function press<T>(
	target: EventTarget,
	init: KeyInit,
	listener: (event: KeyboardEvent) => T
): { event: KeyboardEvent; result: T } {
	const event = keydown(init);
	let result!: T;
	const onKey = (e: Event): void => {
		result = listener(e as KeyboardEvent);
	};
	window.addEventListener('keydown', onKey);
	try {
		target.dispatchEvent(event);
	} finally {
		window.removeEventListener('keydown', onKey);
	}
	return { event, result };
}

/** A fixed overlay at `z` holding a panel with `attrs` (the Modal / Drawer / palette / dock window shape). */
function layer(
	z: number,
	attrs: Record<string, string>
): { overlay: HTMLElement; panel: HTMLElement } {
	const overlay = document.createElement('div');
	overlay.style.position = 'fixed';
	overlay.style.zIndex = String(z);
	const panel = document.createElement('div');
	for (const [name, value] of Object.entries(attrs)) panel.setAttribute(name, value);
	overlay.append(panel);
	document.body.append(overlay);
	return { overlay, panel };
}

const modal = (z = 900) => layer(z, { role: 'dialog', 'aria-modal': 'true' });

function command(overrides: Partial<CommandSpec> & { id: string }): CommandSpec {
	return { title: overrides.id, run: vi.fn(), ...overrides };
}

describe('parseShortcut', () => {
	it('reads modifiers in any order and case, the key last', () => {
		expect(parseShortcut('Mod+S')).toEqual({
			key: 's',
			mod: true,
			ctrl: false,
			meta: false,
			alt: false,
			shift: false
		});
		expect(parseShortcut('shift+ctrl+alt+K')).toMatchObject({
			key: 'k',
			ctrl: true,
			alt: true,
			shift: true
		});
		expect(parseShortcut('Cmd+Option+Up')).toMatchObject({ key: 'ArrowUp', meta: true, alt: true });
	});

	it('names keys canonically (Esc, Space, F-keys, plus)', () => {
		expect(parseShortcut('Esc')?.key).toBe('Escape');
		expect(parseShortcut('Space')?.key).toBe(' ');
		expect(parseShortcut('f12')?.key).toBe('F12');
		expect(parseShortcut('Mod++')).toMatchObject({ key: '+', mod: true });
		expect(parseShortcut('Ctrl+Plus')?.key).toBe('+');
	});

	it('rejects empty text, unknown keys / modifiers and duplicate modifiers', () => {
		for (const bad of ['', 'Mod+', 'Hyper+K', 'Ctrl+Ctrl+K', 'Ctrl+Banana', 'F25']) {
			expect(parseShortcut(bad), bad).toBeNull();
		}
	});
});

describe('matchShortcut', () => {
	it('Mod is Ctrl on other platforms and Meta on mac, exactly', () => {
		const ctrlS = keydown({ key: 's', ctrlKey: true });
		const metaS = keydown({ key: 's', metaKey: true });
		expect(matchShortcut(ctrlS, 'Mod+S', 'other')).toBe(true);
		expect(matchShortcut(metaS, 'Mod+S', 'other')).toBe(false);
		expect(matchShortcut(metaS, 'Mod+S', 'mac')).toBe(true);
		expect(matchShortcut(ctrlS, 'Mod+S', 'mac')).toBe(false);
		expect(matchShortcut(ctrlS, 'Ctrl+S', 'mac')).toBe(true);
	});

	it('extra or missing modifiers do not match; letters are case-insensitive', () => {
		expect(
			matchShortcut(keydown({ key: 'S', ctrlKey: true, shiftKey: true }), 'Mod+S', 'other')
		).toBe(false);
		expect(
			matchShortcut(keydown({ key: 'S', ctrlKey: true, shiftKey: true }), 'Mod+Shift+S', 'other')
		).toBe(true);
		expect(matchShortcut(keydown({ key: 's' }), 'Mod+S', 'other')).toBe(false);
		expect(
			matchShortcut(keydown({ key: 's', ctrlKey: true, altKey: true }), 'Mod+S', 'other')
		).toBe(false);
	});

	it('Shift is not compared for a symbol the shortcut does not shift', () => {
		expect(matchShortcut(keydown({ key: '?', shiftKey: true }), '?', 'other')).toBe(true);
		expect(matchShortcut(keydown({ key: '?' }), '?', 'other')).toBe(true);
	});

	it('falls back to event.code for letters on a non-Latin layout only', () => {
		expect(
			matchShortcut(keydown({ key: 'ы', code: 'KeyS', ctrlKey: true }), 'Mod+S', 'other')
		).toBe(true);
		// AZERTY: the key says "a" although the physical key is KeyQ - the key wins.
		expect(
			matchShortcut(keydown({ key: 'a', code: 'KeyQ', ctrlKey: true }), 'Mod+Q', 'other')
		).toBe(false);
	});

	it('an unparsable shortcut never matches', () => {
		expect(matchShortcut(keydown({ key: 'k', ctrlKey: true }), 'Ctrl+Banana', 'other')).toBe(false);
	});
});

describe('formatShortcut', () => {
	it('mac: ⌃⌥⇧⌘ order without separators', () => {
		expect(formatShortcut('Mod+Shift+S', 'mac')).toBe('⇧⌘S');
		expect(formatShortcut('Shift+Alt+Ctrl+Mod+K', 'mac')).toBe('⌃⌥⇧⌘K');
		expect(formatShortcut('Escape', 'mac')).toBe('⎋');
	});

	it('other: Ctrl+Alt+Shift+Key', () => {
		expect(formatShortcut('Mod+Shift+S', 'other')).toBe('Ctrl+Shift+S');
		expect(formatShortcut('Alt+ArrowUp', 'other')).toBe('Alt+↑');
		expect(formatShortcut('Esc', 'other')).toBe('Esc');
	});

	it('returns unparsable text as given', () => {
		expect(formatShortcut('Ctrl+Banana', 'other')).toBe('Ctrl+Banana');
	});
});

describe('isEditableTarget', () => {
	it('text-entry inputs, textarea, select and contenteditable are editable', () => {
		const make = (html: string): Element => {
			const wrap = document.createElement('div');
			wrap.innerHTML = html;
			document.body.append(wrap);
			return wrap.querySelector('[data-t]')!;
		};
		expect(isEditableTarget(make('<input data-t>'))).toBe(true);
		expect(isEditableTarget(make('<input type="number" data-t>'))).toBe(true);
		expect(isEditableTarget(make('<textarea data-t></textarea>'))).toBe(true);
		expect(isEditableTarget(make('<select data-t></select>'))).toBe(true);
		expect(isEditableTarget(make('<div contenteditable><b data-t>x</b></div>'))).toBe(true);
		expect(isEditableTarget(make('<div contenteditable="plaintext-only" data-t></div>'))).toBe(
			true
		);
		expect(
			isEditableTarget(
				make('<div contenteditable><span contenteditable="false" data-t></span></div>')
			)
		).toBe(false);
		expect(isEditableTarget(make('<input type="checkbox" data-t>'))).toBe(false);
		expect(isEditableTarget(make('<button data-t></button>'))).toBe(false);
		expect(isEditableTarget(null)).toBe(false);
	});
});

describe('shouldHandleShortcut: event guards', () => {
	const check = (init: KeyInit, spec = {}) =>
		press(document.body, init, (e) => shouldHandleShortcut(e, spec)).result;

	it('accepts a plain Ctrl+K on the page', () => {
		expect(check({ key: 'k', ctrlKey: true })).toBe(true);
	});

	it('refuses while an IME composes (isComposing, keyCode 229)', () => {
		expect(check({ key: 'k', ctrlKey: true, isComposing: true })).toBe(false);
		expect(check({ key: 'Process', ctrlKey: true, keyCode: 229 })).toBe(false);
		expect(check({ key: 'k', ctrlKey: true, isComposing: true }, { allowInEditable: true })).toBe(
			false
		);
	});

	it('refuses an event someone already consumed', () => {
		const first = (e: KeyboardEvent): void => e.preventDefault();
		document.body.addEventListener('keydown', first);
		expect(check({ key: 'k', ctrlKey: true })).toBe(false);
		document.body.removeEventListener('keydown', first);
	});

	it('refuses auto-repeat unless allowRepeat', () => {
		expect(check({ key: 'k', ctrlKey: true, repeat: true })).toBe(false);
		expect(check({ key: 'k', ctrlKey: true, repeat: true }, { allowRepeat: true })).toBe(true);
	});
});

describe('shouldHandleShortcut: editable elements', () => {
	for (const html of [
		'<input>',
		'<textarea></textarea>',
		'<select></select>',
		'<div contenteditable="true"></div>'
	]) {
		it(`protects native editing in ${html} unless allowInEditable`, () => {
			const wrap = document.createElement('div');
			wrap.innerHTML = html;
			document.body.append(wrap);
			const target = wrap.firstElementChild!;
			const ctrlC = { key: 'c', ctrlKey: true };
			expect(press(target, ctrlC, (e) => shouldHandleShortcut(e)).result).toBe(false);
			expect(
				press(target, ctrlC, (e) => shouldHandleShortcut(e, { allowInEditable: true })).result
			).toBe(true);
		});
	}
});

describe('shouldHandleShortcut: layers', () => {
	const check = (spec = {}) =>
		press(document.body, { key: 'k', ctrlKey: true }, (e) => shouldHandleShortcut(e, spec)).result;

	it('a modal layer blocks', () => {
		modal();
		expect(check()).toBe(false);
	});

	it('a menu blocks', () => {
		layer(700, { role: 'menu' });
		expect(check()).toBe(false);
	});

	it('a non-modal role="dialog" (a dock floating window) does not block', () => {
		layer(300, { role: 'dialog', 'aria-label': 'Floating pane' });
		layer(301, { role: 'dialog', 'aria-label': 'Another floating pane' });
		expect(check()).toBe(true);
	});

	it('a closing modal (data-layer-inactive) does not block', () => {
		modal().panel.setAttribute('data-layer-inactive', '');
		expect(check()).toBe(true);
	});

	it('ownerLayer: the owner palette itself and the layers below do not block; one above does', () => {
		const below = modal(900);
		const palette = modal(1000);
		const spec = { ownerLayer: () => palette.panel };
		expect(check()).toBe(false);
		expect(check(spec)).toBe(true);
		const above = modal(1100);
		expect(check(spec)).toBe(false);
		above.overlay.remove();
		layer(1200, { role: 'menu' });
		expect(check(spec)).toBe(false);
		expect(below.panel.isConnected).toBe(true);
	});

	it('ownerLayer returning null (closed layer) behaves like no owner', () => {
		modal();
		expect(check({ ownerLayer: () => null })).toBe(false);
	});
});

describe('createShortcutDispatcher', () => {
	function run(dispatcher: ShortcutDispatcher, init: KeyInit, target: EventTarget = document.body) {
		return press(target, init, (e) => dispatcher.handle(e));
	}

	it('runs the matching command and consumes the event', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'other' });
		const save = command({ id: 'save', shortcut: 'Mod+S' });
		dispatcher.register('page', [save]);
		const { event, result } = run(dispatcher, { key: 's', ctrlKey: true });
		expect(result).toBe(true);
		expect(event.defaultPrevented).toBe(true);
		expect(save.run).toHaveBeenCalledTimes(1);
		const other = run(dispatcher, { key: 'x', ctrlKey: true });
		expect(other.result).toBe(false);
		expect(other.event.defaultPrevented).toBe(false);
	});

	it('uses the mac Mod (Meta) when told so', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'mac' });
		const save = command({ id: 'save', shortcut: 'Mod+S' });
		dispatcher.register('page', [save]);
		expect(run(dispatcher, { key: 's', ctrlKey: true }).result).toBe(false);
		expect(run(dispatcher, { key: 's', metaKey: true }).result).toBe(true);
	});

	it('the later scope wins; unregistering it gives the key back; hidden commands fall through', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'other' });
		const page = command({ id: 'page.find', shortcut: 'Mod+F' });
		let paneVisible = true;
		const pane = command({ id: 'pane.find', shortcut: 'Mod+F', visible: () => paneVisible });
		dispatcher.register('page', [page]);
		const off = dispatcher.register('pane', [pane]);
		run(dispatcher, { key: 'f', ctrlKey: true });
		expect(pane.run).toHaveBeenCalledTimes(1);
		expect(page.run).not.toHaveBeenCalled();
		paneVisible = false;
		run(dispatcher, { key: 'f', ctrlKey: true });
		expect(page.run).toHaveBeenCalledTimes(1);
		paneVisible = true;
		off();
		off();
		run(dispatcher, { key: 'f', ctrlKey: true });
		expect(page.run).toHaveBeenCalledTimes(2);
		expect(pane.run).toHaveBeenCalledTimes(1);
	});

	it('a shadowing command refused by a guard leaves the key native (no fall-through)', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'other' });
		const page = command({ id: 'page.save', shortcut: 'Mod+S', allowInEditable: true });
		const pane = command({ id: 'pane.save', shortcut: 'Mod+S' });
		dispatcher.register('page', [page]);
		dispatcher.register('pane', [pane]);
		const input = document.createElement('input');
		document.body.append(input);
		const { event, result } = run(dispatcher, { key: 's', ctrlKey: true }, input);
		expect(result).toBe(false);
		expect(event.defaultPrevented).toBe(false);
		expect(page.run).not.toHaveBeenCalled();
		expect(pane.run).not.toHaveBeenCalled();
	});

	it('re-checks enabled right before run (a stale enabled state never runs)', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'other' });
		let selection: string | null = 'row-1';
		const enabled = vi.fn(() => selection !== null);
		const remove = command({ id: 'remove', shortcut: 'Delete', enabled });
		dispatcher.register('page', [remove]);
		expect(remove.enabled?.()).toBe(true); // what a menu showed
		selection = null; // the selection went away before the key arrived
		const { event, result } = run(dispatcher, { key: 'Delete' });
		expect(enabled).toHaveBeenCalledTimes(2);
		expect(remove.run).not.toHaveBeenCalled();
		expect(result).toBe(false);
		expect(event.defaultPrevented).toBe(false);
	});

	it('preventDefaultWhenDisabled consumes the key of a disabled command without running it', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'other' });
		const save = command({
			id: 'save',
			shortcut: 'Mod+S',
			enabled: () => false,
			preventDefaultWhenDisabled: true
		});
		dispatcher.register('page', [save]);
		const { event, result } = run(dispatcher, { key: 's', ctrlKey: true });
		expect(result).toBe(true);
		expect(event.defaultPrevented).toBe(true);
		expect(save.run).not.toHaveBeenCalled();
	});

	it('the palette Ctrl+K (ownerLayer + allowInEditable) closes from its own search input', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'other' });
		const palette = modal(1000);
		const search = document.createElement('input');
		palette.panel.append(search);
		const toggle = command({
			id: 'palette.toggle',
			shortcut: 'Mod+K',
			allowInEditable: true,
			ownerLayer: () => palette.panel
		});
		const save = command({ id: 'save', shortcut: 'Mod+S', allowInEditable: true });
		dispatcher.register('app', [toggle, save]);
		expect(run(dispatcher, { key: 'k', ctrlKey: true }, search).result).toBe(true);
		expect(toggle.run).toHaveBeenCalledTimes(1);
		// Ctrl+S has no owner layer: the palette (a modal) blocks it.
		expect(run(dispatcher, { key: 's', ctrlKey: true }, search).result).toBe(false);
		expect(save.run).not.toHaveBeenCalled();
	});

	it('ignores commands without a (valid) shortcut', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'other' });
		const a = command({ id: 'a' });
		const b = command({ id: 'b', shortcut: 'Ctrl+Banana' });
		dispatcher.register('page', [a, b]);
		expect(run(dispatcher, { key: 'b', ctrlKey: true }).result).toBe(false);
	});

	it('is re-entrant: run may unregister itself, register another and dispatch again', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'other' });
		const inner = command({ id: 'inner', shortcut: 'Mod+J' });
		const nested: boolean[] = [];
		let off = (): void => {};
		const outer = command({
			id: 'outer',
			shortcut: 'Mod+J',
			run: vi.fn(() => {
				off();
				dispatcher.register('replacement', [inner]);
				nested.push(dispatcher.handle(keydown({ key: 'j', ctrlKey: true })));
			})
		});
		off = dispatcher.register('page', [outer]);
		expect(run(dispatcher, { key: 'j', ctrlKey: true }).result).toBe(true);
		expect(outer.run).toHaveBeenCalledTimes(1);
		expect(nested).toEqual([true]);
		expect(inner.run).toHaveBeenCalledTimes(1);
		run(dispatcher, { key: 'j', ctrlKey: true });
		expect(outer.run).toHaveBeenCalledTimes(1);
		expect(inner.run).toHaveBeenCalledTimes(2);
	});
});

describe('CommandSpec structural compatibility', () => {
	it("accepts @banto/admin-core's PaletteCommand shape without importing it", () => {
		// Mirror of admin-core `PaletteCommand` (packages/admin-core/src/commands.ts).
		interface PaletteCommandShape {
			id: string;
			title: string;
			group: string;
			keywords?: string[];
			visible?: () => boolean;
			enabled?: () => boolean;
			checked?: () => boolean;
			shortcut?: string;
			run: () => void | Promise<void>;
		}
		const palette: PaletteCommandShape = {
			id: 'x',
			title: 'X',
			group: 'g',
			shortcut: 'Mod+X',
			run: () => {}
		};
		const spec: CommandSpec = palette;
		expect(spec.shortcut).toBe('Mod+X');
	});
});

describe('parseShortcut rejects names inherited from Object.prototype (PR #444 review)', () => {
	it.each([
		'constructor+K',
		'toString+K',
		'__proto__+K',
		'hasOwnProperty+K',
		'constructor',
		'toString'
	])('%s is not a valid shortcut', (shortcut) => {
		expect(parseShortcut(shortcut)).toBeNull();
	});

	it('a dispatcher ignores such a shortcut instead of running on a plain key', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'other' });
		let runs = 0;
		dispatcher.register('page', [
			{ id: 'bad', title: 'Bad', shortcut: 'constructor+K', run: () => void runs++ }
		]);
		const event = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', cancelable: true });
		expect(dispatcher.handle(event)).toBe(false);
		expect(runs).toBe(0);
	});
});

describe('Space keeps an exact Shift match (PR #444 review)', () => {
	const key = (init: KeyboardEventInit) =>
		new KeyboardEvent('keydown', { cancelable: true, ...init });

	it('Shift+Space matches only Shift+Space, and Space only Space', () => {
		expect(matchShortcut(key({ key: ' ', code: 'Space', shiftKey: true }), 'Space', 'other')).toBe(
			false
		);
		expect(
			matchShortcut(key({ key: ' ', code: 'Space', shiftKey: true }), 'Shift+Space', 'other')
		).toBe(true);
		expect(matchShortcut(key({ key: ' ', code: 'Space' }), 'Space', 'other')).toBe(true);
		expect(
			matchShortcut(
				key({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true }),
				'Mod+Space',
				'other'
			)
		).toBe(false);
	});

	it('a dispatcher runs the Shift+Space command even when Space is registered first in the same scope', () => {
		const dispatcher = createShortcutDispatcher({ platform: 'other' });
		const ran: string[] = [];
		dispatcher.register('page', [
			{ id: 'space', title: 'Space', shortcut: 'Space', run: () => void ran.push('space') },
			{
				id: 'shift-space',
				title: 'Shift+Space',
				shortcut: 'Shift+Space',
				run: () => void ran.push('shift-space')
			}
		]);
		dispatcher.handle(key({ key: ' ', code: 'Space', shiftKey: true }));
		expect(ran).toEqual(['shift-space']);
	});

	it('a symbol that needs Shift to type still matches without naming Shift', () => {
		expect(matchShortcut(key({ key: '?', code: 'Slash', shiftKey: true }), '?', 'other')).toBe(
			true
		);
	});
});
