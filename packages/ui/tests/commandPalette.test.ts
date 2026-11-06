// @vitest-environment jsdom
/**
 * @banto/ui CommandPalette contracts (docs/adr/0018-shared-ui-package.md §8,
 * phase 2b): open/close through the bindable `open`, the built-in and a
 * custom search, grouping + the recent section, keyboard selection (wrapping,
 * disabled rows skipped), Enter/click execution then close, and the standard
 * focus behaviour taken from banto-hub (#381): focus trap, focus restored to
 * the opener, window-level Escape that yields to a consumed event or a layer
 * above. Look and motion are browser behaviour (e2e/visual), not asserted.
 *
 * jsdom lays nothing out, so `getClientRects()` is empty for every element;
 * the restore check ("is the opener still visible?") is given a non-empty
 * rect list for connected elements.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	defaultCommandPaletteSearch,
	defaultUiMessages,
	type CommandPaletteItem
} from '../src/index';
import CommandPaletteHarness from './fixtures/CommandPaletteHarness.svelte';
import CustomIcon from './fixtures/CustomIcon.svelte';

beforeAll(() => {
	Element.prototype.getClientRects = function (this: Element) {
		return (this.isConnected ? [{}] : []) as unknown as DOMRectList;
	};
});

afterEach(cleanup);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ITEMS: CommandPaletteItem[] = [
	{ id: 'nav.items', title: 'Items', group: 'Navigation', keywords: ['products'] },
	{ id: 'nav.users', title: 'Users', group: 'Navigation' },
	{ id: 'nav.locked', title: 'Locked page', group: 'Navigation', disabled: true },
	{ id: 'theme.dark', title: 'Dark theme', group: 'Theme', icon: CustomIcon, shortcut: 'Ctrl+D' },
	{ id: 'session.logout', title: 'Log out', group: 'Session' }
];

type HarnessProps = {
	onExecute?: (item: CommandPaletteItem) => void | Promise<void>;
	search?: (query: string, items: readonly CommandPaletteItem[]) => CommandPaletteItem[];
	recentIds?: string[];
	messages?: Record<string, () => string>;
	focusFallback?: () => HTMLElement | null;
	layerAbove?: boolean;
	layerZ?: number;
};

async function openPalette(props: HarnessProps = {}) {
	const onExecute = vi.fn(props.onExecute ?? (() => {}));
	const onClose = vi.fn();
	render(CommandPaletteHarness, { items: ITEMS, ...props, onExecute, onClose });
	const opener = screen.getByTestId('opener');
	opener.focus();
	await fireEvent.click(opener);
	await flush();
	const dialog = screen.getByRole('dialog', { name: props.messages ? /.+/ : 'コマンドパレット' });
	const input = screen.getByRole('combobox') as HTMLInputElement;
	return { opener, dialog, input, onExecute, onClose };
}

const titles = () => screen.queryAllByRole('option').map((el) => el.textContent?.trim());

const option = (title: string) =>
	screen.getAllByRole('option').find((el) => el.textContent?.includes(title)) as HTMLElement;

const selectedTitle = () =>
	screen
		.getAllByRole('option')
		.find((el) => el.getAttribute('aria-selected') === 'true')
		?.textContent?.trim();

const state = () => screen.getByTestId('state').textContent;

const headings = (dialog: HTMLElement) =>
	[...dialog.querySelectorAll('.group-heading')].map((el) => el.textContent);

describe('CommandPalette: open / close', () => {
	it('renders nothing while closed', () => {
		render(CommandPaletteHarness, { items: ITEMS, onExecute: () => {} });
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('opens as a modal dialog with the default text and focuses the search input', async () => {
		const { dialog, input } = await openPalette();
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(input.placeholder).toBe(defaultUiMessages.commandPalettePlaceholder());
		const list = screen.getByRole('listbox');
		expect(list.getAttribute('aria-label')).toBe('コマンド一覧');
		expect(input.getAttribute('aria-controls')).toBe(list.id);
		expect(document.activeElement).toBe(input);
	});

	it('closes on a pointerdown outside the palette (reason "outside")', async () => {
		const { onClose } = await openPalette();
		await fireEvent.pointerDown(screen.getByTestId('outside'));
		await flush();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(state()).toBe('closed');
		expect(onClose).toHaveBeenCalledWith('outside');
	});

	it('stays open on a pointerdown inside the palette', async () => {
		const { input } = await openPalette();
		await fireEvent.pointerDown(input);
		expect(screen.getByRole('dialog')).toBeTruthy();
	});
});

describe('CommandPalette: search and grouping', () => {
	it('groups by `group` with one heading each, in first-appearance order', async () => {
		const { dialog } = await openPalette();
		expect(headings(dialog)).toEqual(['Navigation', 'Theme', 'Session']);
		expect(screen.getAllByRole('option')).toHaveLength(ITEMS.length);
	});

	it('filters case-insensitively by title and keywords, and shows the empty text', async () => {
		const { input } = await openPalette();
		await fireEvent.input(input, { target: { value: 'USE' } });
		expect(titles()).toEqual(['Users']);
		await fireEvent.input(input, { target: { value: 'products' } });
		expect(titles()).toEqual(['Items']);
		await fireEvent.input(input, { target: { value: 'zzz' } });
		expect(titles()).toEqual([]);
		expect(screen.getByText(defaultUiMessages.commandPaletteEmpty())).toBeTruthy();
	});

	it('uses a custom `search` instead of the built-in one', async () => {
		const search = vi.fn((query: string, items: readonly CommandPaletteItem[]) =>
			query === '' ? [...items].reverse() : items.filter((item) => item.id === 'nav.users')
		);
		const { input } = await openPalette({ search });
		expect(titles()[0]).toBe('Log out');
		await fireEvent.input(input, { target: { value: 'anything' } });
		expect(titles()).toEqual(['Users']);
		expect(search).toHaveBeenCalledWith('anything', ITEMS);
	});

	it('shows `recentIds` first under the recent heading, for an empty query only', async () => {
		const { dialog, input } = await openPalette({ recentIds: ['session.logout', 'gone'] });
		expect(headings(dialog)).toEqual([
			defaultUiMessages.commandPaletteRecent(),
			'Navigation',
			'Theme'
		]);
		expect(titles()[0]).toBe('Log out');
		expect(titles()).toHaveLength(ITEMS.length); // not repeated in its own group
		await fireEvent.input(input, { target: { value: 'o' } });
		expect(headings(dialog)).not.toContain(defaultUiMessages.commandPaletteRecent());
	});

	it('renders the icon (aria-hidden) and the shortcut hint', async () => {
		await openPalette();
		const row = option('Dark theme');
		const icon = row.querySelector('[data-testid="custom-icon"]');
		expect(icon?.getAttribute('aria-hidden')).toBe('true');
		expect(row.querySelector('kbd')?.textContent).toBe('Ctrl+D');
	});

	it('defaultCommandPaletteSearch keeps order and returns everything for a blank query', () => {
		expect(defaultCommandPaletteSearch('  ', ITEMS)).toEqual(ITEMS);
		expect(defaultCommandPaletteSearch('T', ITEMS).map((item) => item.id)).toEqual([
			'nav.items',
			'theme.dark',
			'session.logout'
		]);
	});
});

describe('CommandPalette: keyboard and execution', () => {
	it('moves the selection with arrows, wrapping and skipping disabled rows', async () => {
		const { input } = await openPalette();
		expect(selectedTitle()).toBe('Items');
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		expect(selectedTitle()).toBe('Users');
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		expect(selectedTitle()).toContain('Dark theme'); // Locked page skipped
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		expect(selectedTitle()).toBe('Items'); // wrapped
		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		expect(selectedTitle()).toBe('Log out'); // wrapped backwards
		expect(input.getAttribute('aria-activedescendant')).toBe(option('Log out').id);
	});

	it('resets the selection to the first row when the query changes', async () => {
		const { input } = await openPalette();
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.input(input, { target: { value: 'e' } });
		expect(selectedTitle()).toBe(titles()[0]);
	});

	it('marks disabled rows and never executes them', async () => {
		const { onExecute } = await openPalette();
		const locked = option('Locked page');
		expect(locked.getAttribute('aria-disabled')).toBe('true');
		expect(locked.hasAttribute('disabled')).toBe(true);
		await fireEvent.click(locked);
		expect(onExecute).not.toHaveBeenCalled();
		expect(screen.getByRole('dialog')).toBeTruthy();
	});

	it('follows the mouse: hovering a row selects it', async () => {
		await openPalette();
		await fireEvent.mouseEnter(option('Log out'));
		expect(selectedTitle()).toBe('Log out');
	});

	it('Enter executes the selected item once, then closes (reason "execute")', async () => {
		const { input, onExecute, onClose } = await openPalette();
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'Enter' });
		await flush();
		expect(onExecute).toHaveBeenCalledTimes(1);
		expect(onExecute.mock.calls[0][0].id).toBe('nav.users');
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(state()).toBe('closed');
		expect(onClose).toHaveBeenCalledWith('execute');
	});

	it('disables the rows while an async onExecute is pending and closes when it settles', async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => (finish = resolve));
		const { onClose } = await openPalette({ onExecute: () => pending });
		await fireEvent.click(option('Users'));
		expect(option('Items').hasAttribute('disabled')).toBe(true);
		expect(onClose).not.toHaveBeenCalled();
		finish();
		await flush();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(onClose).toHaveBeenCalledWith('execute');
	});

	it('a stale pending onExecute settling after Esc + reopen does not close the new palette', async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => (finish = resolve));
		const { opener, input, onClose } = await openPalette({ onExecute: () => pending });
		await fireEvent.click(option('Users'));
		await fireEvent.keyDown(window, { key: 'Escape' });
		await flush();
		expect(screen.queryByRole('dialog')).toBeNull();
		await fireEvent.click(opener);
		await flush();
		const fresh = screen.getByRole('combobox') as HTMLInputElement;
		expect(fresh).not.toBe(input);
		await fireEvent.input(fresh, { target: { value: 'log' } });
		onClose.mockClear();
		finish();
		await flush();
		expect(screen.queryByRole('dialog')).not.toBeNull();
		expect(state()).toBe('open');
		expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('log');
		expect(titles()).toEqual(['Log out']);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('selects nothing when every item is disabled (no aria-selected, Enter does nothing)', async () => {
		const items: CommandPaletteItem[] = [
			{ id: 'a', title: 'Alpha', disabled: true },
			{ id: 'b', title: 'Beta', disabled: true }
		];
		const onExecute = vi.fn();
		const onClose = vi.fn();
		render(CommandPaletteHarness, { items, onExecute, onClose });
		await fireEvent.click(screen.getByTestId('opener'));
		await flush();
		const input = screen.getByRole('combobox');
		expect(selectedTitle()).toBeUndefined();
		expect(input.hasAttribute('aria-activedescendant')).toBe(false);
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		await fireEvent.keyDown(input, { key: 'Enter' });
		await flush();
		expect(selectedTitle()).toBeUndefined();
		expect(onExecute).not.toHaveBeenCalled();
		expect(state()).toBe('open');
	});

	it('selects nothing when the search leaves only disabled items, and recovers when selectable ones return', async () => {
		const { input, onExecute } = await openPalette();
		await fireEvent.input(input, { target: { value: 'locked' } });
		await flush();
		expect(titles()).toEqual(['Locked page']);
		expect(selectedTitle()).toBeUndefined();
		expect(input.hasAttribute('aria-activedescendant')).toBe(false);
		await fireEvent.keyDown(input, { key: 'Enter' });
		await flush();
		expect(onExecute).not.toHaveBeenCalled();
		await fireEvent.input(input, { target: { value: 'u' } });
		await flush();
		expect(selectedTitle()).toBeDefined();
		await fireEvent.keyDown(input, { key: 'Enter' });
		await flush();
		expect(onExecute).toHaveBeenCalledTimes(1);
	});

	it('uses overridden messages', async () => {
		const messages = {
			commandPaletteLabel: () => 'Command palette',
			commandPalettePlaceholder: () => 'Search…',
			commandPaletteListLabel: () => 'Commands',
			commandPaletteEmpty: () => 'Nothing found'
		};
		const { dialog, input } = await openPalette({ messages });
		expect(dialog.getAttribute('aria-label')).toBe('Command palette');
		expect(input.placeholder).toBe('Search…');
		expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe('Commands');
		await fireEvent.input(input, { target: { value: 'zzz' } });
		expect(screen.getByText('Nothing found')).toBeTruthy();
	});
});

describe('CommandPalette: standard focus behaviour (banto-hub #381)', () => {
	it('Escape closes from the window and restores focus to the opener', async () => {
		const { opener, onClose } = await openPalette();
		await fireEvent.keyDown(window, { key: 'Escape' });
		await flush();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(state()).toBe('closed');
		expect(onClose).toHaveBeenCalledWith('escape');
		expect(document.activeElement).toBe(opener);
	});

	it('Escape consumes the event so a lower layer can yield', async () => {
		await openPalette();
		const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});

	it('Escape yields when the event was already consumed', async () => {
		await openPalette();
		const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		event.preventDefault();
		window.dispatchEvent(event);
		await flush();
		expect(screen.getByRole('dialog', { name: 'コマンドパレット' })).toBeTruthy();
	});

	it('Escape yields to a visible layer above (higher z-index)', async () => {
		await openPalette({ layerAbove: true });
		await fireEvent.keyDown(window, { key: 'Escape' });
		await flush();
		expect(screen.getByRole('dialog', { name: 'コマンドパレット' })).toBeTruthy();
	});

	it('Escape yields to an equal-z layer later in document order (paint order)', async () => {
		await openPalette({ layerAbove: true, layerZ: 0 });
		await fireEvent.keyDown(window, { key: 'Escape' });
		await flush();
		expect(screen.getByRole('dialog', { name: 'コマンドパレット' })).toBeTruthy();
	});

	it('Escape still closes the palette over a lower layer (smaller z-index)', async () => {
		await openPalette({ layerAbove: true, layerZ: -1 });
		await fireEvent.keyDown(window, { key: 'Escape' });
		await flush();
		expect(screen.queryByRole('dialog', { name: 'コマンドパレット' })).toBeNull();
	});

	it('restores focus to the opener after executing', async () => {
		const { opener, input } = await openPalette();
		await fireEvent.keyDown(input, { key: 'Enter' });
		await flush();
		await flush();
		expect(document.activeElement).toBe(opener);
	});

	it('falls back to `focusFallback` when the opener is gone', async () => {
		const fallback = document.createElement('button');
		document.body.append(fallback);
		try {
			const { opener } = await openPalette({ focusFallback: () => fallback });
			opener.remove();
			await fireEvent.keyDown(window, { key: 'Escape' });
			await flush();
			expect(document.activeElement).toBe(fallback);
		} finally {
			fallback.remove();
		}
	});

	it('traps Tab: Tab on the last row wraps to the input, Shift+Tab on the input to the last row', async () => {
		const { input } = await openPalette();
		const last = option('Log out');
		last.focus();
		await fireEvent.keyDown(last, { key: 'Tab' });
		expect(document.activeElement).toBe(input);
		await fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(last);
	});

	it('traps focus: focus landing outside is pulled back into the palette', async () => {
		const { input } = await openPalette();
		screen.getByTestId('outside').focus();
		expect(document.activeElement).toBe(input);
	});

	it('does not pull focus back while a layer above owns it', async () => {
		await openPalette({ layerAbove: true });
		const above = screen.getByTestId('above-button');
		above.focus();
		expect(document.activeElement).toBe(above);
	});
});
