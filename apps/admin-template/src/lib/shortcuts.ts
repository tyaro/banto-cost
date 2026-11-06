/**
 * The app's keyboard shortcuts (Issue #435 PR-11, shared-primitives-upstream-plan
 * §3.6 / §4.3): ONE `@banto/ui` shortcut dispatcher for the whole app.
 * `(app)/+layout.svelte` feeds it every window `keydown` and registers the
 * shell's command (Ctrl+K / Cmd+K, the command palette); a page registers its
 * own commands for its lifetime (the dashboard's Ctrl+S, the memo save) and
 * calls the returned function on unmount.
 *
 * The dispatcher's guards decide whether a key is taken at all (IME
 * composition, `defaultPrevented`, editable targets unless `allowInEditable`,
 * a modal layer or a menu - `ownerLayer` excepted). A key that is not taken
 * stays the browser's: Ctrl+S outside the dashboard is the browser's
 * "save page", as before.
 *
 * No Paraglide import here: titles come in resolved (conventions §13), which
 * also keeps the pure parts testable in the node vitest environment.
 */
import {
	createShortcutDispatcher,
	detectShortcutPlatform,
	formatShortcut,
	type CommandSpec,
	type ShortcutDispatcher,
	type ShortcutPlatform
} from '@banto/ui';

/** Open / close the command palette (spec M16). */
export const COMMAND_PALETTE_SHORTCUT = 'Mod+K';
/** Save the page's unapplied input (the dashboard memo). */
export const SAVE_SHORTCUT = 'Mod+S';
/** The shell command's id (stable: menus would look a command up by it, plan §3.6). */
export const COMMAND_PALETTE_COMMAND_ID = 'shell.commandPalette';

export interface AppShortcuts extends ShortcutDispatcher {
	/** The platform `Mod` resolves to. */
	readonly platform: ShortcutPlatform;
	/** `formatShortcut` for {@link platform}: `'Mod+S'` -> `'Ctrl+S'` / `'⌘S'` (symbols only, no text). */
	format(shortcut: string): string;
	/** Is the keydown being dispatched an auto-repeat? `false` outside `handle`. */
	isRepeat(): boolean;
}

/**
 * `dispatcher` plus {@link AppShortcuts.isRepeat}: `handle` records the
 * event's `repeat` while the dispatcher runs, so a command's `enabled` can
 * tell a held key from a press ({@link firstPressOnly}).
 */
export function createAppShortcuts(
	dispatcher: ShortcutDispatcher,
	platform: ShortcutPlatform
): AppShortcuts {
	let repeat = false;
	return {
		platform,
		format: (shortcut) => formatShortcut(shortcut, platform),
		register: (scope, commands) => dispatcher.register(scope, commands),
		handle(event) {
			const outer = repeat;
			repeat = event.repeat;
			try {
				return dispatcher.handle(event);
			} finally {
				repeat = outer;
			}
		},
		isRepeat: () => repeat
	};
}

/**
 * Run on the first keydown only, and still consume the auto-repeats of a
 * held key. With the dispatcher's default (`allowRepeat: false`) a repeat is
 * refused by the guards and goes to the browser - a held Ctrl+S would open
 * "save page" after the first save, a held Ctrl+K would move focus to the
 * address bar. Here a repeat passes the guards (`allowRepeat`) and is a
 * DISABLED press (`enabled` is false while {@link AppShortcuts.isRepeat}), and
 * `preventDefaultWhenDisabled` keeps it from the browser. Outside a keydown
 * (a menu or button reading `enabled`) only `spec.enabled` decides.
 */
export function firstPressOnly(spec: CommandSpec, isRepeat: () => boolean): CommandSpec {
	return {
		...spec,
		allowRepeat: true,
		preventDefaultWhenDisabled: true,
		enabled: () => !isRepeat() && (spec.enabled ? spec.enabled() : true)
	};
}

export interface CommandPaletteCommandOptions {
	/** Resolved label (conventions §13). */
	title: string;
	toggle: () => void;
	/** The open palette's `aria-modal="true"` dialog, or `null` while closed. */
	layer: () => Element | null;
	isRepeat: () => boolean;
}

/**
 * Ctrl+K / Cmd+K (spec M16), a toggle. Taken inside inputs too
 * (`allowInEditable`): it must CLOSE the palette while focus is in the
 * palette's own search box. The palette is itself a modal layer, so it is
 * the command's `ownerLayer`: the open palette does not block the key that
 * closes it, while any OTHER modal (Modal, Drawer) or menu does - Ctrl+K
 * does not open the palette over them. The narrow-screen sidebar overlay is
 * not modal and does not block it (plan §5.1, PR-11).
 */
export function commandPaletteCommand(options: CommandPaletteCommandOptions): CommandSpec {
	return firstPressOnly(
		{
			id: COMMAND_PALETTE_COMMAND_ID,
			title: options.title,
			shortcut: COMMAND_PALETTE_SHORTCUT,
			allowInEditable: true,
			ownerLayer: options.layer,
			run: options.toggle
		},
		options.isRepeat
	);
}

const platform = detectShortcutPlatform();

/** The app-wide instance (module singleton, like `commandPaletteStore`). */
export const appShortcuts: AppShortcuts = createAppShortcuts(
	createShortcutDispatcher({ platform }),
	platform
);
