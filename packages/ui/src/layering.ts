/**
 * Esc / focus layering for overlays - the one module behind CommandPalette,
 * Modal and Drawer, and public so an app's own layers (a retreating split
 * pane, a context menu, a page-level Esc handler) follow the same rules
 * (docs/adr/0018-shared-ui-package.md §10, phase 4). Phase 2b kept a minimal
 * package-internal copy (`overlayFocus.ts`) for the palette; phase 4 merged it
 * with banto-industrial banto-hub's `escLayering.ts` / `focusTrap.ts` /
 * `focusRestore.ts` / `drawerCloseGuard.ts`, so there is one mechanism, not two.
 *
 * ## The layer promises (banto-hub #378 / #381)
 *
 * Overlapping UI closes **one layer per Esc, topmost first**:
 *
 * 1. The layer that closes on Esc **consumes** the event (`preventDefault`);
 *    a handler that sees `event.defaultPrevented` yields. Not enough alone:
 *    window listeners cannot `stopPropagation` each other and run in
 *    registration order ("which opened first"), hence 2.
 * 2. A layer **yields Esc (and its focus pull-back) while a visible, active
 *    layer is above it** ({@link hasVisibleLayerAbove} with `except`). "Above"
 *    is a z comparison, not "any other layer" (a palette at 1000 over a
 *    drawer at 900 must not each think the other is on top). A handler that is
 *    not a layer itself (the page underneath) calls it without `except`: any
 *    visible layer wins. Non-modal layers carry no role, so they opt in with
 *    {@link LAYER_MARKER_ATTR} while open.
 * 3. Layers handle Esc **at window level**, so a layer still closes when
 *    focus was moved outside it by something else.
 * 4. A layer that says `aria-modal="true"` **traps focus**
 *    ({@link attachFocusTrap}): Tab wraps inside (panel `keydown`) and focus
 *    landing outside is pulled back (document `focusin`) - otherwise Tab
 *    reaches an opener behind the scrim and stacks a second layer.
 * 5. On close, **focus returns to the element focused when the layer opened**
 *    ({@link restoreFocus}) - only if it is still connected, not inert and
 *    visible; otherwise to the caller's fallback, else nowhere (never forced
 *    onto `<body>`, from where Tab bypasses every trap).
 * 6. A layer that is closing or retreated **says so in the DOM**: an outro
 *    keeps the panel laid out, so Modal / Drawer set
 *    {@link LAYER_INACTIVE_ATTR} the moment they decide to close; a retreated
 *    pane uses `visibility: hidden` + `inert`. Conversely an opening layer must
 *    be visible from its first frame (never transition `visibility` on open).
 * 7. Non-modal layers (sidebar, retreated tree) cannot trap, so whoever
 *    **opens a lower one closes the upper one first** (caller's job).
 *
 * ## What counts as "above"
 *
 * Layers are `[role="dialog"]`, `[role="menu"]` and `[data-esc-layer]`
 * ({@link LAYER_SELECTOR}). Active = not inside {@link LAYER_INACTIVE_ATTR} or
 * `inert`, laid out (has client rects) and not `display: none` /
 * `visibility: hidden`. Against `except`, an active layer is above when:
 *
 * - it is in an open popover (the browser's top layer, above any z-index);
 * - its effective z-index ({@link effectiveZIndex}, read from CSS - so the
 *   theme's `--banto-z-*` tokens decide, nothing is copied here) is higher;
 * - its z-index is equal and it comes later in document order (CSS paint
 *   order), so two equal layers never both yield;
 * - it sits **inside** `except` with its own positioned z-index (a Modal
 *   opened from a Drawer's content, a popup menu inside a dialog). A nested
 *   layer without its own z-index is part of `except`, not above it.
 *
 * `except` itself and its ancestors never count.
 *
 * {@link hasVisibleMenuLayer} and {@link hasVisibleModalLayer} apply the same
 * rules to the menus / the `aria-modal="true"` layers only - what keyboard
 * shortcuts yield to (`shortcut.ts`, shared-primitives-upstream-plan §3.6),
 * so a non-modal floating window does not silence them.
 */

/** Set on a layer that is closing (still in the DOM during an outro) - promise 6. */
export const LAYER_INACTIVE_ATTR = 'data-layer-inactive';

/** Marker for a layer that has no `dialog` / `menu` role (e.g. an off-canvas sidebar) - set only while open. */
export const LAYER_MARKER_ATTR = 'data-esc-layer';

/** Elements that count as Esc-closable layers. */
export const LAYER_SELECTOR = `[role="dialog"], [role="menu"], [${LAYER_MARKER_ATTR}]`;

/** Only the `[role="menu"]` layers (context menus). */
export const MENU_LAYER_SELECTOR = '[role="menu"]';

/**
 * Only the modal layers - those that say `aria-modal="true"` (Modal, Drawer,
 * CommandPalette; promise 4). A subset of what blocks the page, used where a
 * non-modal `role="dialog"` must not count ({@link hasVisibleModalLayer}).
 */
export const MODAL_LAYER_SELECTOR = '[aria-modal="true"]';

/** What the focus trap and the "focus first" of Modal / Drawer enumerate. */
export const FOCUSABLE_SELECTOR =
	'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])';

/** Is `el` laid out and not hidden by `display` / `visibility`? */
function isRendered(el: Element): boolean {
	if (el.getClientRects().length === 0) return false;
	const style = getComputedStyle(el);
	return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * Focusables inside `panel` that Tab can reach now, in DOM order: in the tab
 * order (`tabIndex >= 0`, so a native control with `tabindex="-1"` is out),
 * not effectively disabled (`:disabled` also covers controls inside a
 * disabled `<fieldset>`), not inside `inert`, laid out. Counted on every call
 * - form parts come and go while a layer is open.
 */
export function focusablesIn(panel: HTMLElement): HTMLElement[] {
	return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
		(el) =>
			el.tabIndex >= 0 &&
			!el.matches(':disabled') &&
			!el.closest('[inert]') &&
			el.getClientRects().length > 0
	);
}

/** Numeric z-index of `node` if it is positioned and has one, else `null`. */
function ownZIndex(node: Element): number | null {
	const style = getComputedStyle(node);
	const z = Number.parseInt(style.zIndex, 10);
	return !Number.isNaN(z) && style.position !== 'static' ? z : null;
}

/**
 * Effective z-index of `el`: the first positioned ancestor-or-self with a
 * numeric z-index; `0` if none. Panels are usually not positioned themselves -
 * the overlay around them carries the z-index - hence the walk.
 */
export function effectiveZIndex(el: Element): number {
	for (let node: Element | null = el; node; node = node.parentElement) {
		const z = ownZIndex(node);
		if (z !== null) return z;
	}
	return 0;
}

/** Does `el` (inside `root`) get its own z-index from a node strictly inside `root`? */
function hasOwnZIndexWithin(el: Element, root: Element): boolean {
	for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
		if (ownZIndex(node) !== null) return true;
	}
	return false;
}

function isActiveLayer(el: Element): boolean {
	if (el.closest(`[${LAYER_INACTIVE_ATTR}]`)) return false;
	if (el.closest('[inert]')) return false;
	return isRendered(el);
}

/** Inside an open popover (browser top layer - above any z-index). */
function isInOpenPopover(el: Element): boolean {
	const popover = el.closest('[popover]');
	if (!popover) return false;
	try {
		return popover.matches(':popover-open');
	} catch {
		// Engines without the selector (jsdom) have no top layer either.
		return false;
	}
}

/** Is the active layer `el` above `self` (see the module doc)? */
function isAbove(el: Element, self: Element, selfZ: number): boolean {
	if (isInOpenPopover(el)) return true;
	if (self.contains(el)) return hasOwnZIndexWithin(el, self);
	const z = effectiveZIndex(el);
	if (z !== selfZ) return z > selfZ;
	return (self.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Is a visible, active layer above `except` (promise 2)? Without `except`
 * (the caller is not a layer - the page underneath), any visible, active layer
 * counts. Pass the element that carries the layer's role as `except`.
 */
export function hasVisibleLayerAbove(options: { except?: Element | null } = {}): boolean {
	return hasVisibleLayerMatching(LAYER_SELECTOR, options.except ?? null);
}

/** Is a visible, active layer matching `selector` shown - above `except` when given (same rules as {@link hasVisibleLayerAbove})? */
function hasVisibleLayerMatching(selector: string, except: Element | null): boolean {
	const selfZ = except ? effectiveZIndex(except) : 0;
	for (const el of document.querySelectorAll(selector)) {
		if (except && (el === except || el.contains(except))) continue;
		if (!isActiveLayer(el)) continue;
		if (!except || isAbove(el, except, selfZ)) return true;
	}
	return false;
}

/**
 * Is a visible, active `[role="menu"]` shown (e.g. to keep Ctrl+K from
 * opening a palette over it)? With `except`, only menus above it count (a
 * popup menu inside the `except` dialog counts only with its own z-index).
 */
export function hasVisibleMenuLayer(options: { except?: Element | null } = {}): boolean {
	return hasVisibleLayerMatching(MENU_LAYER_SELECTOR, options.except ?? null);
}

/**
 * Is a visible, active **modal** layer shown ({@link MODAL_LAYER_SELECTOR}:
 * `aria-modal="true"` - Modal, Drawer, CommandPalette)? Unlike
 * {@link hasVisibleLayerAbove}, a non-modal `role="dialog"` (the dock's
 * floating windows), a `data-esc-layer` (off-canvas sidebar) and a menu do
 * not count - pair it with {@link hasVisibleMenuLayer} for "modal or menu".
 * With `except`, the `except` layer itself, its ancestors and the layers
 * below it do not count (shortcut `ownerLayer`, the dock's divider Esc:
 * shared-primitives-upstream-plan §3.6 / §4.3).
 */
export function hasVisibleModalLayer(options: { except?: Element | null } = {}): boolean {
	return hasVisibleLayerMatching(MODAL_LAYER_SELECTOR, options.except ?? null);
}

/**
 * Trap focus inside `panel` (promise 4) and return the detach function.
 * Two parts: the panel's `keydown` wraps Tab / Shift+Tab (a Tab already
 * handled by a nested layer is left alone), and a document `focusin` pulls
 * focus that landed outside back to the first focusable - once outside,
 * later Tabs never reach the panel's keydown. The pull-back does not act while
 * a layer above owns focus. With no focusable inside, Tab is swallowed.
 */
export function attachFocusTrap(panel: HTMLElement): () => void {
	const onKeydown = (event: KeyboardEvent): void => {
		if (event.key !== 'Tab' || event.defaultPrevented) return;
		const items = focusablesIn(panel);
		if (items.length === 0) {
			event.preventDefault();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (event.shiftKey) {
			if (active === first) {
				event.preventDefault();
				last.focus();
			}
		} else if (active === last) {
			event.preventDefault();
			first.focus();
		}
	};
	const onFocusIn = (event: FocusEvent): void => {
		const target = event.target;
		if (target instanceof Node && panel.contains(target)) return;
		if (hasVisibleLayerAbove({ except: panel })) return;
		(focusablesIn(panel)[0] ?? panel).focus();
	};
	panel.addEventListener('keydown', onKeydown);
	document.addEventListener('focusin', onFocusIn);
	return () => {
		panel.removeEventListener('keydown', onKeydown);
		document.removeEventListener('focusin', onFocusIn);
	};
}

/**
 * Can focus go back to `el`? Connected, not `<body>` / `<html>` (a layer
 * opened while nothing had focus must not count as "restored"), not inside
 * `inert`, laid out and visible.
 */
export function canRestoreFocusTo(el: HTMLElement): boolean {
	if (el === document.body || el === document.documentElement) return false;
	if (!el.isConnected) return false;
	if (el.closest('[inert]')) return false;
	return isRendered(el);
}

/**
 * Focus `target` if it can still take focus (promise 5). Otherwise call
 * `fallback`: if it returns an element, that element gets the same check and
 * is focused when it passes; a fallback that returns nothing is free to move
 * focus itself. Without a usable target or fallback, focus is left alone.
 */
export function restoreFocus(
	target: HTMLElement | null | undefined,
	fallback?: () => HTMLElement | null | undefined | void
): void {
	if (target && canRestoreFocusTo(target)) {
		target.focus();
		return;
	}
	const alternative = fallback?.();
	if (alternative && canRestoreFocusTo(alternative)) alternative.focus();
}

/** How Modal / Drawer was asked to close. */
export type OverlayCloseSource = 'escape' | 'overlay' | 'close-button';

/**
 * Unsaved-changes guard (banto-hub TAG-UX-C): may `source` go on to request a
 * close? The close button always may (deliberate; the caller's
 * `onRequestClose` still confirms). Esc and an overlay click - the accidental
 * routes - may not while `dirty`; the component reports `onBlockedClose`
 * instead.
 */
export function isCloseAllowed(source: OverlayCloseSource, dirty: boolean): boolean {
	if (source === 'close-button') return true;
	return !dirty;
}
