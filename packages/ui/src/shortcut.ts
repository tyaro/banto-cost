/**
 * Command definitions and keyboard-shortcut protection
 * (docs/design/shared-primitives-upstream-plan.md §3.6 / §4.3, PR-7 "#435-a";
 * placement decided in shared-primitives-upstream-plan D2-a: the key
 * parsing / matching, the guards and the dispatcher live here because they
 * need `layering.ts`; `@banto/admin-core`'s `PaletteCommand` only gains the
 * optional `enabled` / `checked` / `shortcut` fields and stays structurally
 * compatible with {@link CommandSpec} - neither package imports the other,
 * conventions §4 / §5).
 *
 * Pure DOM logic, no runes and no listeners of its own: the app calls
 * `dispatcher.handle(event)` from its window `keydown` (rank 3 in
 * shared-primitives-upstream-plan §4.3 - below the topmost Modal / Drawer /
 * Menu / CommandPalette, which consume their own keys first).
 *
 * ## The guards ({@link shouldHandleShortcut})
 *
 * A shortcut is refused - the event is left to the browser and to whoever
 * else listens - when:
 *
 * 1. an IME is composing (`isComposing`, or `keyCode 229` from engines that
 *    report the composition keydown that way);
 * 2. someone already consumed it (`defaultPrevented` - layer promise 1 of
 *    `layering.ts`);
 * 3. it is an auto-repeat (`repeat`) and the command did not opt in with
 *    `allowRepeat`;
 * 4. focus is in an editable element (text-entry `input`, `textarea`,
 *    `select`, `contenteditable`) and the command did not opt in with
 *    `allowInEditable` - native editing, clipboard and Undo stay native;
 * 5. a visible modal layer or menu is shown ({@link hasVisibleModalLayer} /
 *    {@link hasVisibleMenuLayer}). Non-modal `role="dialog"` layers (the dock's
 *    floating windows) do not block. A command with `ownerLayer` ignores its
 *    own layer and the layers below it, so the palette's Ctrl+K still closes
 *    the palette.
 *
 * The text this module produces ({@link formatShortcut}) is keycap symbols
 * only, never a sentence - UI wording stays with the app (conventions §13).
 */
import { hasVisibleMenuLayer, hasVisibleModalLayer } from './layering';

/** Which modifier `Mod` means: Meta (Command) on macOS, Ctrl elsewhere. */
export type ShortcutPlatform = 'mac' | 'other';

/**
 * One operation, shared by the shortcut dispatcher and (by `id`) by menus,
 * toolbars and context menus. `@banto/admin-core`'s `PaletteCommand` is
 * assignable to it (structural - same convention as `CommandPaletteItem`).
 */
export interface CommandSpec {
	/** Stable id, unique across the app (menus look the command up by it). */
	readonly id: string;
	/** Visible label (already resolved text - conventions §13). */
	readonly title: string;
	/** `'Mod+S'`, `'Shift+Alt+ArrowUp'`, `'Escape'` ... ({@link parseShortcut}). `Mod` = Ctrl, or Meta on macOS. */
	readonly shortcut?: string;
	/**
	 * Is the command usable now? Called for display and **again right before
	 * `run`** by the dispatcher, so a stale selection or closure never runs.
	 * Omitted = always enabled.
	 */
	readonly enabled?: () => boolean;
	/** Toggle state for menus (display only). */
	readonly checked?: () => boolean;
	/** Omitted = visible. A hidden command takes no key, so a lower scope's command may. */
	readonly visible?: () => boolean;
	/** Accept the key inside an editable element (Ctrl+S). Default `false`: native editing, clipboard and Undo win. */
	readonly allowInEditable?: boolean;
	/** Accept auto-repeated keydowns (`event.repeat`). Default `false`. */
	readonly allowRepeat?: boolean;
	/** When disabled, still `preventDefault` the key (e.g. keep Ctrl+S from opening the browser's "save page"). Default `false`. */
	readonly preventDefaultWhenDisabled?: boolean;
	/**
	 * Root of the layer this command belongs to (e.g. the palette's
	 * `aria-modal="true"` dialog). When it returns an element, only modal
	 * layers / menus **above** it block the command (the same idea as
	 * `hasVisibleLayerAbove({ except })`); returning `null` (layer closed)
	 * means any modal layer / menu blocks it.
	 */
	readonly ownerLayer?: () => Element | null;
	run(): void | Promise<void>;
}

/** A parsed shortcut. `mod` is resolved against the platform at match time. */
export interface ParsedShortcut {
	/** Normalized `KeyboardEvent.key`: lowercase for single characters, canonical name otherwise (`'Escape'`, `'ArrowUp'`, `' '`). */
	readonly key: string;
	readonly mod: boolean;
	readonly ctrl: boolean;
	readonly meta: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

const MODIFIERS: Record<string, 'mod' | 'ctrl' | 'meta' | 'alt' | 'shift'> = {
	mod: 'mod',
	ctrl: 'ctrl',
	control: 'ctrl',
	meta: 'meta',
	cmd: 'meta',
	command: 'meta',
	alt: 'alt',
	option: 'alt',
	shift: 'shift'
};

/** Own-property lookup: user text such as `constructor` must not hit `Object.prototype`. */
function own<V>(table: Record<string, V>, name: string): V | undefined {
	return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}

const KEY_ALIASES: Record<string, string> = {
	esc: 'Escape',
	escape: 'Escape',
	enter: 'Enter',
	return: 'Enter',
	space: ' ',
	spacebar: ' ',
	tab: 'Tab',
	backspace: 'Backspace',
	delete: 'Delete',
	del: 'Delete',
	insert: 'Insert',
	home: 'Home',
	end: 'End',
	pageup: 'PageUp',
	pagedown: 'PageDown',
	up: 'ArrowUp',
	down: 'ArrowDown',
	left: 'ArrowLeft',
	right: 'ArrowRight',
	arrowup: 'ArrowUp',
	arrowdown: 'ArrowDown',
	arrowleft: 'ArrowLeft',
	arrowright: 'ArrowRight',
	plus: '+'
};

function normalizeKey(raw: string): string | null {
	if (raw.length === 1) return raw.toLowerCase();
	const lower = raw.toLowerCase();
	const alias = own(KEY_ALIASES, lower);
	if (alias !== undefined) return alias;
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
	return null;
}

/**
 * Parse `'Mod+Shift+K'`-style text (case-insensitive, `+`-separated, the key
 * last; `'Mod++'` / `'Plus'` for the plus key). Modifiers: `Mod`, `Ctrl` /
 * `Control`, `Meta` / `Cmd` / `Command`, `Alt` / `Option`, `Shift`. Keys: one
 * character, `F1`-`F24`, or a name (`Escape` / `Esc`, `Enter`, `Space`, `Tab`,
 * `Backspace`, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, `ArrowUp` /
 * `Up` ...). Returns `null` for anything else (unknown key or modifier,
 * duplicate modifier, empty).
 */
export function parseShortcut(shortcut: string): ParsedShortcut | null {
	const text = shortcut.trim();
	if (text === '') return null;
	let parts: string[];
	if (text === '+') parts = ['+'];
	else if (text.endsWith('++')) parts = [...text.slice(0, -2).split('+'), '+'];
	else parts = text.split('+');
	const keyPart = parts.pop();
	if (keyPart === undefined || keyPart.trim() === '') return null;
	const key = normalizeKey(keyPart.trim());
	if (key === null) return null;
	const flags = { mod: false, ctrl: false, meta: false, alt: false, shift: false };
	for (const part of parts) {
		const modifier = own(MODIFIERS, part.trim().toLowerCase());
		if (!modifier || flags[modifier]) return null;
		flags[modifier] = true;
	}
	return { key, ...flags };
}

/** Physical key for an ASCII letter / digit (`'s'` -> `'KeyS'`), used when the layout is not Latin. */
function codeFor(key: string): string | null {
	if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
	if (/^[0-9]$/.test(key)) return `Digit${key}`;
	return null;
}

/**
 * Does `event` press `shortcut`? Modifiers must match exactly (with `Mod`
 * resolved to Meta on `'mac'`, Ctrl otherwise), except that Shift is not
 * compared for a single non-alphanumeric character whose shortcut does not
 * name Shift (`'?'` is typed with Shift on many layouts). AltGr (reported as
 * Ctrl+Alt on Windows) never matches. The key is `event.key` (case-insensitive);
 * for ASCII letters / digits, a non-Latin layout (`event.key` is not ASCII)
 * falls back to `event.code`. An unparsable shortcut never matches.
 */
export function matchShortcut(
	event: KeyboardEvent,
	shortcut: string | ParsedShortcut,
	platform: ShortcutPlatform
): boolean {
	const parsed = typeof shortcut === 'string' ? parseShortcut(shortcut) : shortcut;
	if (!parsed) return false;
	if (event.getModifierState?.('AltGraph')) return false;
	const wantCtrl = parsed.ctrl || (parsed.mod && platform !== 'mac');
	const wantMeta = parsed.meta || (parsed.mod && platform === 'mac');
	if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta || event.altKey !== parsed.alt) {
		return false;
	}
	// A printable symbol (`?`, `+`) may need Shift to type, so its Shift is not
	// compared unless the shortcut names it. Space is a named key, not a symbol:
	// `Space` and `Shift+Space` must stay distinct.
	const symbol = parsed.key.length === 1 && parsed.key !== ' ' && !/^[a-z0-9]$/.test(parsed.key);
	if (!(symbol && !parsed.shift) && event.shiftKey !== parsed.shift) return false;
	const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
	if (eventKey === parsed.key) return true;
	const code = codeFor(parsed.key);
	// eslint-disable-next-line no-control-regex
	return code !== null && !/^[\x00-\x7f]$/.test(event.key) && event.code === code;
}

const MAC_MODIFIERS = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' } as const;
const OTHER_MODIFIERS = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' } as const;

const MAC_KEYS: Record<string, string> = {
	Escape: '⎋',
	Enter: '↩',
	' ': 'Space',
	Tab: '⇥',
	Backspace: '⌫',
	Delete: '⌦',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	PageUp: '⇞',
	PageDown: '⇟',
	Home: '↖',
	End: '↘'
};

const OTHER_KEYS: Record<string, string> = {
	Escape: 'Esc',
	' ': 'Space',
	Delete: 'Del',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→'
};

/**
 * Display text for a shortcut - keycap symbols only, no wording to
 * translate (conventions §13). `'mac'`: `⌃⌥⇧⌘` + key, no separator
 * (`'Mod+Shift+S'` -> `'⇧⌘S'`). `'other'`: `Ctrl+Alt+Shift+Meta+Key`
 * (`'Ctrl+Shift+S'`). Letters are upper-case. An unparsable shortcut is
 * returned as given.
 */
export function formatShortcut(shortcut: string, platform: ShortcutPlatform): string {
	const parsed = parseShortcut(shortcut);
	if (!parsed) return shortcut;
	const mac = platform === 'mac';
	const ctrl = parsed.ctrl || (parsed.mod && !mac);
	const meta = parsed.meta || (parsed.mod && mac);
	const names = mac ? MAC_MODIFIERS : OTHER_MODIFIERS;
	const mods: string[] = [];
	if (ctrl) mods.push(names.ctrl);
	if (parsed.alt) mods.push(names.alt);
	if (parsed.shift) mods.push(names.shift);
	if (meta) mods.push(names.meta);
	const keyNames = mac ? MAC_KEYS : OTHER_KEYS;
	const key =
		keyNames[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
	return mac ? `${mods.join('')}${key}` : [...mods, key].join('+');
}

/** `'mac'` on macOS / iOS (from `navigator.userAgentData.platform` or `navigator.platform`), else `'other'`. */
export function detectShortcutPlatform(): ShortcutPlatform {
	if (typeof navigator === 'undefined') return 'other';
	const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	const platform = data?.platform || navigator.platform || '';
	return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'other';
}

/** `input` types that are not text entry (no native editing / clipboard / Undo to protect). */
const NON_TEXT_INPUT_TYPES = new Set([
	'button',
	'checkbox',
	'color',
	'file',
	'image',
	'radio',
	'range',
	'reset',
	'submit'
]);

/** Is `target` (or the element inside a shadow root it retargets from) an editable element? */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
	if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type);
	if (target instanceof HTMLElement && target.isContentEditable) return true;
	// jsdom does not implement `isContentEditable`: the nearest `contenteditable` decides.
	const host = target.closest('[contenteditable]');
	if (!host) return false;
	const value = (host.getAttribute('contenteditable') ?? '').toLowerCase();
	return value === '' || value === 'true' || value === 'plaintext-only';
}

function eventTarget(event: KeyboardEvent): EventTarget | null {
	const path = event.composedPath?.();
	return path && path.length > 0 ? path[0] : event.target;
}

/**
 * May `spec` take this keydown (the guards in the module doc)? Does not
 * look at the key itself - {@link matchShortcut} does - nor at `enabled` /
 * `visible`.
 */
export function shouldHandleShortcut(
	event: KeyboardEvent,
	spec: Pick<CommandSpec, 'allowInEditable' | 'allowRepeat' | 'ownerLayer'> = {}
): boolean {
	if (event.isComposing || event.keyCode === 229) return false;
	if (event.defaultPrevented) return false;
	if (event.repeat && !spec.allowRepeat) return false;
	if (!spec.allowInEditable && isEditableTarget(eventTarget(event))) return false;
	const except = spec.ownerLayer?.() ?? null;
	if (hasVisibleModalLayer({ except }) || hasVisibleMenuLayer({ except })) return false;
	return true;
}

export interface ShortcutDispatcher {
	/**
	 * Add a scope's (page's, pane's) commands. A later registration takes
	 * precedence over earlier ones; within one registration the array order
	 * decides. Returns the function that removes this registration (safe to
	 * call more than once, and from inside a `run`).
	 */
	register(scope: string, commands: readonly CommandSpec[]): () => void;
	/**
	 * Call from the window `keydown`. Returns `true` when it consumed the
	 * event (`preventDefault`): it ran a command, or the command was disabled
	 * with `preventDefaultWhenDisabled`.
	 */
	handle(event: KeyboardEvent): boolean;
}

interface Registration {
	readonly scope: string;
	readonly entries: readonly { command: CommandSpec; parsed: ParsedShortcut }[];
}

/**
 * The shortcut dispatcher (shared-primitives-upstream-plan §3.6). For one
 * keydown it picks the **first visible command whose shortcut matches**,
 * newest registration first - a pane's command shadows the page's for the
 * same key, and a hidden one (`visible() === false`) lets the next one have
 * it. Then, for that command only:
 *
 * - {@link shouldHandleShortcut} refuses -> nothing happens (`false`), the
 *   key stays native. A shadowed lower command is not tried instead.
 * - `enabled()` is called right before running; `false` -> `preventDefault`
 *   only if `preventDefaultWhenDisabled`.
 * - otherwise `preventDefault`, then `run()`.
 *
 * The registrations are copied before any command code (`visible`,
 * `enabled`, `run`) is called, and nothing is remembered between calls, so a
 * `run` may register, unregister or dispatch another event. A rejected
 * `run()` promise is the command's to handle.
 */
export function createShortcutDispatcher(
	options: { platform?: ShortcutPlatform } = {}
): ShortcutDispatcher {
	const platform = options.platform ?? detectShortcutPlatform();
	let registrations: Registration[] = [];

	return {
		register(scope, commands) {
			const entries = commands.flatMap((command) => {
				const parsed = command.shortcut ? parseShortcut(command.shortcut) : null;
				return parsed ? [{ command, parsed }] : [];
			});
			const registration: Registration = { scope, entries };
			registrations = [...registrations, registration];
			return () => {
				registrations = registrations.filter((r) => r !== registration);
			};
		},
		handle(event) {
			const snapshot = registrations;
			let chosen: CommandSpec | null = null;
			for (let i = snapshot.length - 1; i >= 0 && !chosen; i--) {
				for (const { command, parsed } of snapshot[i].entries) {
					if (!matchShortcut(event, parsed, platform)) continue;
					if (command.visible && !command.visible()) continue;
					chosen = command;
					break;
				}
			}
			if (!chosen || !shouldHandleShortcut(event, chosen)) return false;
			if (chosen.enabled && !chosen.enabled()) {
				if (!chosen.preventDefaultWhenDisabled) return false;
				event.preventDefault();
				return true;
			}
			event.preventDefault();
			void chosen.run();
			return true;
		}
	};
}
