// @vitest-environment jsdom
/**
 * @banto/ui `layering.ts` (docs/adr/0018-shared-ui-package.md §10, phase 4):
 * the one Esc / focus layering module behind CommandPalette, Modal and Drawer.
 * Pure DOM logic, so the stack is built by hand: which layer is "above"
 * (z-index, document order at equal z, nested layers, inactive / inert /
 * hidden layers), the focus trap, the focus-restore target selection and
 * the unsaved-changes guard (ported from banto-hub's drawerCloseGuard.test.ts).
 *
 * jsdom lays nothing out, so `getClientRects()` is stubbed: one rect for a
 * connected element unless it or an ancestor is `display: none`.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	attachFocusTrap,
	canRestoreFocusTo,
	effectiveZIndex,
	focusablesIn,
	hasVisibleLayerAbove,
	hasVisibleMenuLayer,
	hasVisibleModalLayer,
	isCloseAllowed,
	LAYER_INACTIVE_ATTR,
	LAYER_MARKER_ATTR,
	restoreFocus
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

/** A fixed overlay at `z` holding a `role="dialog"` panel (the Modal / Drawer / palette shape). */
function layer(z: number | null, options: { role?: string; parent?: Element } = {}) {
	const overlay = document.createElement('div');
	overlay.style.position = 'fixed';
	if (z !== null) overlay.style.zIndex = String(z);
	const panel = document.createElement('div');
	panel.setAttribute('role', options.role ?? 'dialog');
	const button = document.createElement('button');
	button.textContent = 'inside';
	panel.append(button);
	overlay.append(panel);
	(options.parent ?? document.body).append(overlay);
	return { overlay, panel, button };
}

function button(label: string, parent: Element = document.body): HTMLButtonElement {
	const el = document.createElement('button');
	el.textContent = label;
	parent.append(el);
	return el;
}

describe('effectiveZIndex', () => {
	it('reads the first positioned ancestor-or-self with a numeric z-index, else 0', () => {
		const { panel, overlay } = layer(900);
		expect(effectiveZIndex(panel)).toBe(900);
		overlay.style.position = 'static';
		expect(effectiveZIndex(panel)).toBe(0);
	});
});

describe('hasVisibleLayerAbove: the stack', () => {
	it('without `except` (the page underneath): any visible layer counts', () => {
		expect(hasVisibleLayerAbove()).toBe(false);
		layer(900);
		expect(hasVisibleLayerAbove()).toBe(true);
	});

	it('push / pop: a higher z is above, and removing it pops the stack', () => {
		const drawer = layer(900);
		expect(hasVisibleLayerAbove({ except: drawer.panel })).toBe(false);
		const palette = layer(1000);
		expect(hasVisibleLayerAbove({ except: drawer.panel })).toBe(true);
		expect(hasVisibleLayerAbove({ except: palette.panel })).toBe(false);
		palette.overlay.remove();
		expect(hasVisibleLayerAbove({ except: drawer.panel })).toBe(false);
	});

	it('CommandPalette (1000) over a Modal (900): only the palette is topmost, whatever the DOM order', () => {
		const palette = layer(1000);
		const modal = layer(900);
		expect(hasVisibleLayerAbove({ except: palette.panel })).toBe(false);
		expect(hasVisibleLayerAbove({ except: modal.panel })).toBe(true);
	});

	it('equal z: the later one in document order is above (paint order), so they never both yield', () => {
		const first = layer(900);
		const second = layer(900);
		expect(hasVisibleLayerAbove({ except: first.panel })).toBe(true);
		expect(hasVisibleLayerAbove({ except: second.panel })).toBe(false);
	});

	it('a lower z is not above, even later in document order', () => {
		const modal = layer(900);
		layer(610);
		expect(hasVisibleLayerAbove({ except: modal.panel })).toBe(false);
	});

	it('nested Modal over Drawer: a layer inside `except` with its own z-index is above', () => {
		const drawer = layer(900);
		const nested = layer(900, { parent: drawer.panel });
		expect(hasVisibleLayerAbove({ except: drawer.panel })).toBe(true);
		expect(hasVisibleLayerAbove({ except: nested.panel })).toBe(false);
	});

	it('a nested layer without its own z-index is part of `except`, not above it', () => {
		const drawer = layer(900);
		const inline = document.createElement('div');
		inline.setAttribute('role', 'menu');
		drawer.panel.append(inline);
		expect(hasVisibleLayerAbove({ except: drawer.panel })).toBe(false);
	});

	it('ignores `except` itself and its ancestors', () => {
		const outer = document.createElement('div');
		outer.setAttribute(LAYER_MARKER_ATTR, '');
		outer.style.position = 'fixed';
		outer.style.zIndex = '2000';
		document.body.append(outer);
		const inner = layer(900, { parent: outer });
		expect(hasVisibleLayerAbove({ except: inner.panel })).toBe(false);
	});

	it('`data-esc-layer` marks a role-less layer', () => {
		const modal = layer(900);
		const sidebar = document.createElement('nav');
		sidebar.style.position = 'fixed';
		sidebar.style.zIndex = '950';
		document.body.append(sidebar);
		expect(hasVisibleLayerAbove({ except: modal.panel })).toBe(false);
		sidebar.setAttribute(LAYER_MARKER_ATTR, '');
		expect(hasVisibleLayerAbove({ except: modal.panel })).toBe(true);
	});
});

describe('hasVisibleLayerAbove: layers that are "not there" (promise 6)', () => {
	it('skips a closing layer (`data-layer-inactive` on it or an ancestor)', () => {
		const modal = layer(900);
		const above = layer(1000);
		above.panel.setAttribute(LAYER_INACTIVE_ATTR, 'true');
		expect(hasVisibleLayerAbove({ except: modal.panel })).toBe(false);
		above.panel.removeAttribute(LAYER_INACTIVE_ATTR);
		above.overlay.setAttribute(LAYER_INACTIVE_ATTR, 'true');
		expect(hasVisibleLayerAbove({ except: modal.panel })).toBe(false);
	});

	it('skips a layer inside `inert`, hidden by `visibility` or not laid out (`display: none` above it)', () => {
		const modal = layer(900);
		const above = layer(1000);
		above.overlay.setAttribute('inert', '');
		expect(hasVisibleLayerAbove({ except: modal.panel })).toBe(false);
		above.overlay.removeAttribute('inert');
		above.panel.style.visibility = 'hidden';
		expect(hasVisibleLayerAbove({ except: modal.panel })).toBe(false);
		above.panel.style.visibility = '';
		above.overlay.style.display = 'none';
		expect(hasVisibleLayerAbove({ except: modal.panel })).toBe(false);
		above.overlay.style.display = '';
		expect(hasVisibleLayerAbove({ except: modal.panel })).toBe(true);
	});

	it('hasVisibleMenuLayer: only an active `role="menu"`', () => {
		layer(900);
		expect(hasVisibleMenuLayer()).toBe(false);
		const menu = layer(1000, { role: 'menu' });
		expect(hasVisibleMenuLayer()).toBe(true);
		menu.panel.setAttribute(LAYER_INACTIVE_ATTR, 'true');
		expect(hasVisibleMenuLayer()).toBe(false);
	});
});

describe('focus trap (promise 4)', () => {
	function trapped() {
		const outside = button('outside');
		const modal = layer(900);
		const second = button('second', modal.panel);
		const detach = attachFocusTrap(modal.panel);
		return { outside, modal, first: modal.button, second, detach };
	}

	function tab(target: HTMLElement, shiftKey = false): KeyboardEvent {
		const event = new KeyboardEvent('keydown', {
			key: 'Tab',
			shiftKey,
			bubbles: true,
			cancelable: true
		});
		target.dispatchEvent(event);
		return event;
	}

	it('focusablesIn skips disabled, inert and not-laid-out elements', () => {
		const { modal, first, second } = trapped();
		const disabled = button('disabled', modal.panel);
		disabled.disabled = true;
		const inertWrap = document.createElement('div');
		inertWrap.setAttribute('inert', '');
		button('inert', inertWrap);
		const hidden = document.createElement('div');
		hidden.style.display = 'none';
		button('hidden', hidden);
		modal.panel.append(inertWrap, hidden);
		expect(focusablesIn(modal.panel)).toEqual([first, second]);
	});

	it('focusablesIn skips controls out of the tab order and controls disabled by a <fieldset>', () => {
		const { modal, first, second } = trapped();
		const untabbable = button('untabbable', modal.panel);
		untabbable.tabIndex = -1;
		modal.panel.prepend(untabbable.cloneNode(true));
		const fieldset = document.createElement('fieldset');
		fieldset.disabled = true;
		const input = document.createElement('input');
		fieldset.append(input);
		button('in fieldset', fieldset);
		modal.panel.append(fieldset);
		expect(focusablesIn(modal.panel)).toEqual([first, second]);
	});

	it('wraps Tab between the real first / last when tabindex="-1" controls sit at both ends', () => {
		const { modal, first, second } = trapped();
		const head = document.createElement('button');
		head.tabIndex = -1;
		modal.panel.prepend(head);
		const tail = button('tail', modal.panel);
		tail.tabIndex = -1;
		second.focus();
		expect(tab(second).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
		expect(tab(first, true).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(second);
	});

	it('wraps Tab on the last and Shift+Tab on the first', () => {
		const { first, second } = trapped();
		second.focus();
		expect(tab(second).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
		expect(tab(first, true).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(second);
	});

	it('leaves a Tab already handled by a nested layer alone', () => {
		const { second, first } = trapped();
		second.focus();
		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		event.preventDefault();
		second.dispatchEvent(event);
		expect(document.activeElement).toBe(second);
		expect(document.activeElement).not.toBe(first);
	});

	it('pulls focus that lands outside back to the first focusable, unless a layer above owns it', () => {
		const { outside, first } = trapped();
		outside.focus();
		expect(document.activeElement).toBe(first);
		const above = layer(1000);
		above.button.focus();
		expect(document.activeElement).toBe(above.button);
	});

	it('detaches cleanly', () => {
		const { outside, detach } = trapped();
		detach();
		outside.focus();
		expect(document.activeElement).toBe(outside);
	});

	it('swallows Tab when nothing inside can take focus', () => {
		const modal = layer(900);
		modal.button.disabled = true;
		attachFocusTrap(modal.panel);
		modal.panel.tabIndex = -1;
		modal.panel.focus();
		expect(tab(modal.panel).defaultPrevented).toBe(true);
	});
});

describe('focus restore target (promise 5)', () => {
	it('canRestoreFocusTo: connected, not body, not inert, laid out and visible', () => {
		const ok = button('ok');
		expect(canRestoreFocusTo(ok)).toBe(true);
		expect(canRestoreFocusTo(document.body)).toBe(false);
		expect(canRestoreFocusTo(document.createElement('button'))).toBe(false);
		ok.setAttribute('inert', '');
		expect(canRestoreFocusTo(ok)).toBe(false);
		ok.removeAttribute('inert');
		ok.style.visibility = 'hidden';
		expect(canRestoreFocusTo(ok)).toBe(false);
		ok.style.visibility = '';
		ok.style.display = 'none';
		expect(canRestoreFocusTo(ok)).toBe(false);
	});

	it('focuses the opener while it is alive, without calling the fallback', () => {
		const opener = button('opener');
		let asked = false;
		restoreFocus(opener, () => {
			asked = true;
			return null;
		});
		expect(document.activeElement).toBe(opener);
		expect(asked).toBe(false);
	});

	it('falls back to the returned element when the opener is gone (same check applies to it)', () => {
		const opener = button('opener');
		const fallback = button('fallback');
		opener.remove();
		restoreFocus(opener, () => fallback);
		expect(document.activeElement).toBe(fallback);
	});

	it('leaves focus alone when neither the opener nor the fallback can take it (never <body>)', () => {
		const current = button('current');
		current.focus();
		const deadFallback = document.createElement('button');
		restoreFocus(document.body, () => deadFallback);
		expect(document.activeElement).toBe(current);
		restoreFocus(null);
		expect(document.activeElement).toBe(current);
	});

	it('a fallback that returns nothing may move focus itself', () => {
		const target = button('target');
		restoreFocus(null, () => {
			target.focus();
		});
		expect(document.activeElement).toBe(target);
	});
});

describe('isCloseAllowed (unsaved-changes guard)', () => {
	it('dirty=false: Esc, the scrim and × are all allowed', () => {
		expect(isCloseAllowed('escape', false)).toBe(true);
		expect(isCloseAllowed('overlay', false)).toBe(true);
		expect(isCloseAllowed('close-button', false)).toBe(true);
	});

	it('dirty=true: Esc and the scrim are blocked (accidental routes)', () => {
		expect(isCloseAllowed('escape', true)).toBe(false);
		expect(isCloseAllowed('overlay', true)).toBe(false);
	});

	it('dirty=true: × is still allowed (onRequestClose has the final say)', () => {
		expect(isCloseAllowed('close-button', true)).toBe(true);
	});
});

describe('hasVisibleModalLayer (shared-primitives-upstream-plan §3.6)', () => {
	function modalLayer(z: number, parent?: Element) {
		const l = layer(z, { parent });
		l.panel.setAttribute('aria-modal', 'true');
		return l;
	}

	it('counts only aria-modal="true" layers: not a non-modal dialog, a menu or a marker', () => {
		expect(hasVisibleModalLayer()).toBe(false);
		layer(300); // dock floating window: role="dialog" without aria-modal
		layer(700, { role: 'menu' });
		const sidebar = document.createElement('aside');
		sidebar.setAttribute(LAYER_MARKER_ATTR, '');
		document.body.append(sidebar);
		expect(hasVisibleLayerAbove()).toBe(true);
		expect(hasVisibleModalLayer()).toBe(false);
		modalLayer(900);
		expect(hasVisibleModalLayer()).toBe(true);
	});

	it('ignores closing, inert and hidden modal layers', () => {
		const a = modalLayer(900);
		a.panel.setAttribute(LAYER_INACTIVE_ATTR, '');
		const b = modalLayer(901);
		b.overlay.setAttribute('inert', '');
		const c = modalLayer(902);
		c.overlay.style.display = 'none';
		expect(hasVisibleModalLayer()).toBe(false);
	});

	it('with `except`: itself and lower layers do not count, a higher or nested-with-z one does', () => {
		const drawer = modalLayer(900);
		const palette = modalLayer(1000);
		expect(hasVisibleModalLayer({ except: palette.panel })).toBe(false);
		expect(hasVisibleModalLayer({ except: drawer.panel })).toBe(true);
		const nested = modalLayer(1100, palette.panel);
		expect(hasVisibleModalLayer({ except: palette.panel })).toBe(true);
		nested.overlay.remove();
		expect(hasVisibleModalLayer({ except: null })).toBe(true);
	});
});

describe('hasVisibleMenuLayer with `except`', () => {
	it('only menus above the given layer count', () => {
		const palette = layer(1000);
		layer(700, { role: 'menu' });
		expect(hasVisibleMenuLayer()).toBe(true);
		expect(hasVisibleMenuLayer({ except: palette.panel })).toBe(false);
		layer(1200, { role: 'menu' });
		expect(hasVisibleMenuLayer({ except: palette.panel })).toBe(true);
	});
});
