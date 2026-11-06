// @vitest-environment jsdom
/**
 * @banto/ui Modal / Drawer contracts (docs/adr/0018-shared-ui-package.md §10,
 * phase 4; banto-industrial banto-hub's T13-1 / T19 S1-b / TAG-UX-C / #381):
 * the three close routes through one guarded `requestClose` (veto, `dirty`,
 * idempotent), Esc one layer at a time (nested Modal over Drawer,
 * CommandPalette over both), focus to the first focusable on open, the trap,
 * focus back to the opener or `focusFallback`, and the overridable × label.
 * Look and motion are browser behaviour (e2e/visual), not asserted.
 *
 * jsdom lays nothing out and the components' scoped CSS is not loaded here,
 * so: `getClientRects()` returns one rect for a connected element; the scrim
 * (`role="presentation"`) gets `position: fixed; z-index: 900` from a test
 * style (the theme's `--banto-z-modal`); the palette's overlay gets 1000
 * inline when a test opens it; `inert` is reflected to its attribute (jsdom
 * lacks the IDL attribute). The motion tokens are unset, so the exit
 * motion takes 0ms unless a test sets `--banto-duration-base`.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	defaultUiMessages,
	focusablesIn,
	hasVisibleLayerAbove,
	LAYER_INACTIVE_ATTR,
	type UiMessages
} from '../src/index';
import OverlayHarness from './fixtures/OverlayHarness.svelte';

beforeAll(() => {
	Element.prototype.getClientRects = function (this: Element) {
		return (this.isConnected ? [{}] : []) as unknown as DOMRectList;
	};
	// jsdom has no `inert` IDL attribute; Svelte sets the property, so reflect
	// it to the content attribute the way browsers do.
	if (!('inert' in HTMLElement.prototype)) {
		Object.defineProperty(HTMLElement.prototype, 'inert', {
			configurable: true,
			get(this: HTMLElement) {
				return this.hasAttribute('inert');
			},
			set(this: HTMLElement, value: boolean) {
				this.toggleAttribute('inert', Boolean(value));
			}
		});
	}
	const style = document.createElement('style');
	style.textContent = '[role="presentation"] { position: fixed; z-index: 900; }';
	document.head.append(style);
});

afterEach(cleanup);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

type HarnessProps = {
	kind?: 'drawer' | 'modal';
	title?: string;
	width?: string;
	closeOnOverlayClick?: boolean;
	onRequestClose?: () => boolean;
	dirty?: boolean;
	onBlockedClose?: () => void;
	focusFallback?: () => HTMLElement | null;
	messages?: UiMessages;
	keepOpen?: boolean;
};

async function openOverlay(props: HarnessProps = {}) {
	const onclose = vi.fn();
	render(OverlayHarness, { ...props, onclose });
	const opener = screen.getByTestId('opener');
	opener.focus();
	await fireEvent.click(opener);
	await flush();
	const dialog = screen.getByRole('dialog', { name: props.title ?? 'Edit' });
	return { opener, dialog, onclose };
}

const state = () => screen.getByTestId('state').textContent;
const nestedState = () => screen.getByTestId('nested-state').textContent;
const closeButton = (dialog: HTMLElement) =>
	dialog.querySelector<HTMLButtonElement>('.header button') as HTMLButtonElement;
const escape = async () => {
	await fireEvent.keyDown(window, { key: 'Escape' });
	await flush();
};

describe('Modal / Drawer: rendering', () => {
	it('renders nothing while closed', () => {
		render(OverlayHarness, {});
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('opens as a labelled modal dialog with the default widths (Drawer 480px, Modal 560px)', async () => {
		const { dialog } = await openOverlay();
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(dialog.style.width).toBe('480px');
		expect(dialog.querySelector('h3')?.textContent).toBe('Edit');
		cleanup();
		const modal = await openOverlay({ kind: 'modal', title: 'Create', width: '36rem' });
		expect(modal.dialog.style.width).toBe('36rem');
	});

	it('focuses the first focusable (the × in the header) on open', async () => {
		const { dialog } = await openOverlay();
		expect(document.activeElement).toBe(closeButton(dialog));
	});

	it('names the × with the default text, or the `overlayClose` override', async () => {
		const { dialog } = await openOverlay();
		expect(closeButton(dialog).getAttribute('aria-label')).toBe(defaultUiMessages.overlayClose());
		cleanup();
		const other = await openOverlay({ messages: { overlayClose: () => 'Close' } });
		expect(closeButton(other.dialog).getAttribute('aria-label')).toBe('Close');
	});
});

describe('Modal / Drawer: close routes', () => {
	for (const kind of ['drawer', 'modal'] as const) {
		it(`${kind}: ×, Esc and the scrim close and restore focus to the opener`, async () => {
			const { opener, onclose } = await openOverlay({ kind });
			let dialog = screen.getByRole('dialog', { name: 'Edit' });
			await fireEvent.click(closeButton(dialog));
			await flush();
			expect(state()).toBe('closed');
			expect(onclose).toHaveBeenCalledTimes(1);
			expect(document.activeElement).toBe(opener);

			await fireEvent.click(opener);
			await flush();
			await escape();
			expect(state()).toBe('closed');
			expect(document.activeElement).toBe(opener);

			await fireEvent.click(opener);
			await flush();
			dialog = screen.getByRole('dialog', { name: 'Edit' });
			await fireEvent.click(dialog.parentElement as HTMLElement);
			await flush();
			expect(state()).toBe('closed');
			expect(onclose).toHaveBeenCalledTimes(3);
		});
	}

	it('a click inside the panel never closes (only the scrim itself)', async () => {
		const { dialog } = await openOverlay();
		await fireEvent.click(dialog);
		await fireEvent.click(screen.getByTestId('field'));
		await flush();
		expect(state()).toBe('open');
	});

	it('closeOnOverlayClick=false keeps the scrim click from closing', async () => {
		const { dialog } = await openOverlay({ closeOnOverlayClick: false });
		await fireEvent.click(dialog.parentElement as HTMLElement);
		await flush();
		expect(state()).toBe('open');
	});

	it('onRequestClose returning false vetoes every route', async () => {
		const onRequestClose = vi.fn(() => false);
		const { dialog, onclose } = await openOverlay({ onRequestClose });
		await fireEvent.click(closeButton(dialog));
		await escape();
		await fireEvent.click(dialog.parentElement as HTMLElement);
		await flush();
		expect(onRequestClose).toHaveBeenCalledTimes(3);
		expect(onclose).not.toHaveBeenCalled();
		expect(state()).toBe('open');
	});

	it('closing is idempotent: a second × during the close asks onRequestClose once', async () => {
		const onRequestClose = vi.fn(() => true);
		const { dialog, onclose } = await openOverlay({ onRequestClose });
		const close = closeButton(dialog);
		close.click();
		close.click();
		await flush();
		expect(onRequestClose).toHaveBeenCalledTimes(1);
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('a parent that does not close keeps a working, detectable layer (controls, Esc, layer checks)', async () => {
		const onRequestClose = vi.fn(() => true);
		const { dialog, onclose } = await openOverlay({ keepOpen: true, onRequestClose });
		await fireEvent.click(closeButton(dialog));
		await flush();
		expect(onclose).toHaveBeenCalledTimes(1);
		expect(state()).toBe('open');
		expect(dialog.hasAttribute(LAYER_INACTIVE_ATTR)).toBe(false);
		expect(hasVisibleLayerAbove()).toBe(true);
		await fireEvent.click(closeButton(dialog));
		await flush();
		expect(onclose).toHaveBeenCalledTimes(2);
		const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		await flush();
		expect(onRequestClose).toHaveBeenCalledTimes(3);
		expect(onclose).toHaveBeenCalledTimes(3);
		expect(screen.getByRole('dialog', { name: 'Edit' })).toBe(dialog);
	});

	it('keeps the layer mounted but inactive for the exit motion (--banto-duration-base), then unmounts', async () => {
		document.documentElement.style.setProperty('--banto-duration-base', '60ms');
		try {
			const { dialog, opener } = await openOverlay();
			await fireEvent.click(closeButton(dialog));
			expect(dialog.isConnected).toBe(true);
			expect(dialog.getAttribute(LAYER_INACTIVE_ATTR)).toBe('true');
			expect(dialog.parentElement?.classList.contains('leaving')).toBe(true);
			expect(dialog.parentElement?.hasAttribute('inert')).toBe(true);
			expect(hasVisibleLayerAbove()).toBe(false);
			await flush();
			expect(document.activeElement).toBe(opener);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(screen.queryByRole('dialog')).toBeNull();
		} finally {
			document.documentElement.style.removeProperty('--banto-duration-base');
		}
	});

	it('a leaving child (non-zero exit) is inert and out of the parent trap; Tab wraps past it', async () => {
		document.documentElement.style.setProperty('--banto-duration-base', '1s');
		try {
			const { dialog } = await openOverlay();
			const openNested = screen.getByTestId('open-nested');
			openNested.focus();
			await fireEvent.click(openNested);
			await flush();
			const nested = screen.getByRole('dialog', { name: 'Confirm' });
			await escape();
			expect(nestedState()).toBe('closed');
			expect(nested.isConnected).toBe(true);
			expect(nested.parentElement?.hasAttribute('inert')).toBe(true);
			expect(document.activeElement).toBe(openNested);
			const reachable = focusablesIn(dialog);
			expect(reachable.some((el) => nested.contains(el))).toBe(false);
			// Tab from the drawer's last reachable element wraps to its first, never into the child.
			const last = reachable[reachable.length - 1];
			last.focus();
			await fireEvent.keyDown(last, { key: 'Tab' });
			expect(document.activeElement).toBe(closeButton(dialog));
		} finally {
			document.documentElement.style.removeProperty('--banto-duration-base');
		}
	});

	it('reopening during the exit motion reuses the layer: not inert, focus on the first element', async () => {
		document.documentElement.style.setProperty('--banto-duration-base', '1s');
		try {
			const { dialog, opener } = await openOverlay();
			await fireEvent.click(closeButton(dialog));
			await flush();
			expect(dialog.parentElement?.hasAttribute('inert')).toBe(true);
			await fireEvent.click(opener);
			await flush();
			expect(screen.getByRole('dialog', { name: 'Edit' })).toBe(dialog);
			expect(dialog.parentElement?.hasAttribute('inert')).toBe(false);
			expect(dialog.hasAttribute(LAYER_INACTIVE_ATTR)).toBe(false);
			expect(document.activeElement).toBe(closeButton(dialog));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(dialog.isConnected).toBe(true);
		} finally {
			document.documentElement.style.removeProperty('--banto-duration-base');
		}
	});

	it('marks the panel inactive synchronously when the parent closes (promise 6)', async () => {
		const { dialog } = await openOverlay();
		expect(dialog.hasAttribute(LAYER_INACTIVE_ATTR)).toBe(false);
		closeButton(dialog).click();
		expect(dialog.getAttribute(LAYER_INACTIVE_ATTR)).toBe('true');
	});
});

describe('Modal / Drawer: unsaved changes (dirty)', () => {
	it('Esc and the scrim do not close while dirty and report onBlockedClose', async () => {
		const onBlockedClose = vi.fn();
		const onRequestClose = vi.fn(() => true);
		const { dialog } = await openOverlay({ dirty: true, onBlockedClose, onRequestClose });
		const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		await fireEvent.click(dialog.parentElement as HTMLElement);
		await flush();
		expect(onBlockedClose).toHaveBeenCalledTimes(2);
		expect(onRequestClose).not.toHaveBeenCalled();
		expect(state()).toBe('open');
	});

	it('× still goes through onRequestClose while dirty (the caller confirms)', async () => {
		const onRequestClose = vi.fn(() => true);
		const { dialog } = await openOverlay({ dirty: true, onRequestClose });
		await fireEvent.click(closeButton(dialog));
		await flush();
		expect(onRequestClose).toHaveBeenCalledTimes(1);
		expect(state()).toBe('closed');
	});
});

describe('Modal / Drawer: Esc layering and focus', () => {
	it('Esc consumes the event when it closes, and yields to an already consumed one', async () => {
		await openOverlay();
		const consumed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		consumed.preventDefault();
		window.dispatchEvent(consumed);
		await flush();
		expect(state()).toBe('open');
		const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});

	it('nested Modal over Drawer: Esc closes the Modal first (focus back inside the Drawer), then the Drawer', async () => {
		const { opener } = await openOverlay();
		const openNested = screen.getByTestId('open-nested');
		openNested.focus();
		await fireEvent.click(openNested);
		await flush();
		expect(screen.getByRole('dialog', { name: 'Confirm' })).toBeTruthy();
		await escape();
		expect(nestedState()).toBe('closed');
		expect(state()).toBe('open');
		expect(document.activeElement).toBe(openNested);
		await escape();
		expect(state()).toBe('closed');
		expect(document.activeElement).toBe(opener);
	});

	it("a click on the parent's backdrop is ignored while a child layer is open (no bypass of the child)", async () => {
		const { dialog } = await openOverlay();
		await fireEvent.click(screen.getByTestId('open-nested'));
		await flush();
		await fireEvent.click(dialog.parentElement as HTMLElement);
		await flush();
		expect(state()).toBe('open');
		expect(nestedState()).toBe('open');
		await escape();
		expect(nestedState()).toBe('closed');
		await fireEvent.click(dialog.parentElement as HTMLElement);
		await flush();
		expect(state()).toBe('closed');
	});

	it('CommandPalette over a Drawer: Esc closes the palette only, then the Drawer', async () => {
		await openOverlay();
		await fireEvent.click(screen.getByTestId('open-palette'));
		await flush();
		const palette = screen.getByRole('dialog', { name: 'コマンドパレット' });
		const paletteOverlay = palette.parentElement as HTMLElement;
		paletteOverlay.style.position = 'fixed';
		paletteOverlay.style.zIndex = '1000';
		await escape();
		expect(screen.queryByRole('dialog', { name: 'コマンドパレット' })).toBeNull();
		expect(state()).toBe('open');
		await escape();
		expect(state()).toBe('closed');
	});

	it('traps Tab inside and pulls stray focus back', async () => {
		const { dialog } = await openOverlay();
		const close = closeButton(dialog);
		const last = screen.getByTestId('open-palette');
		last.focus();
		await fireEvent.keyDown(last, { key: 'Tab' });
		expect(document.activeElement).toBe(close);
		await fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(last);
		screen.getByTestId('outside').focus();
		expect(document.activeElement).toBe(close);
	});

	it('falls back to `focusFallback` when the opener is gone, else leaves focus alone', async () => {
		const fallback = document.createElement('button');
		document.body.append(fallback);
		try {
			const { opener } = await openOverlay({ focusFallback: () => fallback });
			opener.remove();
			await escape();
			expect(document.activeElement).toBe(fallback);
		} finally {
			fallback.remove();
		}
	});
});
