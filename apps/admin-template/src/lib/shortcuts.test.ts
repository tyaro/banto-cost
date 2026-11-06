/**
 * The app's shortcut wiring (shortcuts.ts, Issue #435 PR-11). `@banto/ui` is
 * replaced by fakes: the node test environment has no DOM for the
 * dispatcher's layer guards, and the dispatcher itself (guards, scope order,
 * the re-check of `enabled`) is tested in `packages/ui/tests/shortcut.test.ts`.
 * This file is about what the app adds: the repeat flag, `firstPressOnly` and
 * the Ctrl+K command's spec. The DOM behaviour is the e2e smoke test 9a.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CommandSpec, ShortcutDispatcher } from '@banto/ui';

vi.mock('@banto/ui', () => ({
	createShortcutDispatcher: () => ({ register: () => () => {}, handle: () => false }),
	detectShortcutPlatform: () => 'other',
	formatShortcut: (shortcut: string, platform: string) => `${platform}:${shortcut}`
}));

import {
	COMMAND_PALETTE_COMMAND_ID,
	COMMAND_PALETTE_SHORTCUT,
	commandPaletteCommand,
	createAppShortcuts,
	firstPressOnly
} from './shortcuts';

function keydown(init: { repeat?: boolean } = {}): KeyboardEvent {
	return { repeat: init.repeat ?? false } as KeyboardEvent;
}

function fakeDispatcher(onHandle: (event: KeyboardEvent) => boolean = () => true) {
	const off = vi.fn();
	const dispatcher = {
		register: vi.fn((_scope: string, _commands: readonly CommandSpec[]) => off),
		handle: vi.fn(onHandle)
	} satisfies ShortcutDispatcher;
	return { dispatcher, off };
}

describe('createAppShortcuts', () => {
	it('passes register and handle through, and formats for its platform', () => {
		const { dispatcher, off } = fakeDispatcher(() => true);
		const shortcuts = createAppShortcuts(dispatcher, 'mac');
		const commands: CommandSpec[] = [{ id: 'a', title: 'A', run: () => {} }];
		expect(shortcuts.register('page', commands)).toBe(off);
		expect(dispatcher.register).toHaveBeenCalledWith('page', commands);
		const event = keydown();
		expect(shortcuts.handle(event)).toBe(true);
		expect(dispatcher.handle).toHaveBeenCalledWith(event);
		expect(shortcuts.platform).toBe('mac');
		expect(shortcuts.format('Mod+S')).toBe('mac:Mod+S');
	});

	it('isRepeat follows the event being dispatched, and is false outside handle', () => {
		const seen: boolean[] = [];
		const shortcuts = createAppShortcuts(
			fakeDispatcher(() => {
				seen.push(shortcuts.isRepeat());
				return false;
			}).dispatcher,
			'other'
		);
		expect(shortcuts.isRepeat()).toBe(false);
		shortcuts.handle(keydown({ repeat: true }));
		shortcuts.handle(keydown({ repeat: false }));
		expect(seen).toEqual([true, false]);
		expect(shortcuts.isRepeat()).toBe(false);
	});

	it('resets isRepeat when a command throws', () => {
		const shortcuts = createAppShortcuts(
			fakeDispatcher(() => {
				throw new Error('boom');
			}).dispatcher,
			'other'
		);
		expect(() => shortcuts.handle(keydown({ repeat: true }))).toThrow('boom');
		expect(shortcuts.isRepeat()).toBe(false);
	});

	it('a nested dispatch (a run that dispatches another key) restores the outer flag', () => {
		let inner = true;
		const seen: boolean[] = [];
		const shortcuts = createAppShortcuts(
			fakeDispatcher(() => {
				if (inner) {
					inner = false;
					shortcuts.handle(keydown({ repeat: false }));
				}
				seen.push(shortcuts.isRepeat());
				return true;
			}).dispatcher,
			'other'
		);
		shortcuts.handle(keydown({ repeat: true }));
		expect(seen).toEqual([false, true]);
	});
});

describe('firstPressOnly', () => {
	const run = vi.fn();
	const base: CommandSpec = {
		id: 'x',
		title: 'X',
		shortcut: 'Mod+S',
		allowInEditable: true,
		run
	};

	it('takes repeats past the guards but consumes them as a disabled press', () => {
		let repeat = false;
		const spec = firstPressOnly(base, () => repeat);
		expect(spec).toMatchObject({
			id: 'x',
			title: 'X',
			shortcut: 'Mod+S',
			allowInEditable: true,
			allowRepeat: true,
			preventDefaultWhenDisabled: true
		});
		expect(spec.enabled?.()).toBe(true);
		repeat = true;
		expect(spec.enabled?.()).toBe(false);
		spec.run();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('keeps the wrapped command`s own enabled (checked on every call)', () => {
		let dirty = false;
		const spec = firstPressOnly({ ...base, enabled: () => dirty }, () => false);
		expect(spec.enabled?.()).toBe(false);
		dirty = true;
		expect(spec.enabled?.()).toBe(true);
	});
});

describe('commandPaletteCommand (Ctrl+K)', () => {
	it('is a Mod+K toggle taken inside inputs, owned by the palette dialog', () => {
		const toggle = vi.fn();
		const dialog = { role: 'dialog' } as unknown as Element;
		let open: Element | null = null;
		let repeat = false;
		const command = commandPaletteCommand({
			title: 'palette',
			toggle,
			layer: () => open,
			isRepeat: () => repeat
		});
		expect(command).toMatchObject({
			id: COMMAND_PALETTE_COMMAND_ID,
			title: 'palette',
			shortcut: COMMAND_PALETTE_SHORTCUT,
			allowInEditable: true,
			allowRepeat: true,
			preventDefaultWhenDisabled: true
		});
		expect(COMMAND_PALETTE_SHORTCUT).toBe('Mod+K');
		// Closed: no owner layer, so any modal / menu blocks it (the dispatcher's guard).
		expect(command.ownerLayer?.()).toBeNull();
		open = dialog;
		expect(command.ownerLayer?.()).toBe(dialog);

		expect(command.enabled?.()).toBe(true);
		repeat = true;
		expect(command.enabled?.()).toBe(false); // a held Ctrl+K toggles once
		command.run();
		expect(toggle).toHaveBeenCalledTimes(1);
	});
});
