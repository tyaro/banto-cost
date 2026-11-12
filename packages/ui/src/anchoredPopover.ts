/**
 * Placement of a `position: fixed` popover next to its anchor, shared by
 * `Menu`, `DateInput` and `TimeInput` (date-time-pickers §5.2: "位置決めは Menu から切り出して
 * 共有する（Menu の挙動は変えない）"). Moved out of `Menu.svelte` unchanged
 * (visual-refresh-design.md §7.4, #427): default below the anchor, flip above
 * when there is no room below, and when the popover fits on neither side cap
 * its height to the roomier side so it scrolls internally; clamp
 * horizontally to the viewport.
 *
 * Package-internal (not exported from `index.ts`): the shapes of the two
 * callers decide its API, not an app.
 */

/** Distance between the anchor and the popover, and the popover and the viewport edges (px). */
export const ANCHORED_POPOVER_GAP = 4;

export type AnchoredPlacement = 'bottom-start' | 'bottom-end';

/**
 * Measure `popover` against `anchor` and return its viewport coordinates.
 * Side effect (kept from Menu): sets / clears `popover.style.maxHeight` - set
 * imperatively, not through a `style:` directive, so the cap is in place
 * synchronously, before the open-time focus scrolls an item into view.
 * Dropping the cap resets the popover's own scroll, so it is restored
 * afterwards (resize).
 */
export function computeAnchoredPosition(
	anchor: Element,
	popover: HTMLElement,
	placement: AnchoredPlacement
): { top: number; left: number } {
	const GAP = ANCHORED_POPOVER_GAP;
	// Measure the natural height: drop the cap a previous call (e.g. before a
	// resize) may have set.
	const scrollTop = popover.scrollTop;
	popover.style.removeProperty('max-height');
	const anchorRect = anchor.getBoundingClientRect();
	const popoverRect = popover.getBoundingClientRect();
	const viewportWidth = document.documentElement.clientWidth;
	const viewportHeight = document.documentElement.clientHeight;

	const below = anchorRect.bottom + GAP;
	const aboveTop = anchorRect.top - popoverRect.height - GAP;
	let top = below;
	let height = popoverRect.height;
	if (below + popoverRect.height <= viewportHeight) {
		// Fits below (the default side).
	} else if (aboveTop >= 0) {
		top = aboveTop;
	} else {
		// Fits on neither side: take the roomier one and cap the popover's
		// whole box (padding and border included) to it.
		const spaceBelow = Math.max(viewportHeight - below - GAP, 0);
		const spaceAbove = Math.max(anchorRect.top - GAP - GAP, 0);
		if (spaceAbove > spaceBelow) {
			height = Math.min(popoverRect.height, spaceAbove);
			top = anchorRect.top - height - GAP;
		} else {
			height = Math.min(popoverRect.height, spaceBelow);
		}
	}
	if (height < popoverRect.height) {
		// Under `content-box` (the browser default; apps often reset to
		// `border-box`) `max-height` excludes padding + border, so take
		// them off the whole-box space computed above.
		const style = getComputedStyle(popover);
		const frame =
			style.boxSizing === 'border-box'
				? 0
				: [
						style.paddingTop,
						style.paddingBottom,
						style.borderTopWidth,
						style.borderBottomWidth
					].reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
		popover.style.maxHeight = `${Math.max(height - frame, 0)}px`;
		popover.scrollTop = scrollTop;
	}

	let left = placement === 'bottom-start' ? anchorRect.left : anchorRect.right - popoverRect.width;
	left = Math.min(Math.max(left, GAP), viewportWidth - popoverRect.width - GAP);

	return { top, left };
}

/**
 * While a popover is open: recompute on window resize, and close on any
 * ancestor scroll (popovers are short-lived; re-tracking the anchor is not
 * worth the complexity, §7.4). The popover's own scroll (a long menu: wheel,
 * or the browser bringing a focused item into view, #427) does not count.
 * Returns the detach function (call it from the `$effect` teardown).
 */
export function watchAnchoredPopover(
	popover: HTMLElement | undefined,
	handlers: { reposition: () => void; close: () => void }
): () => void {
	function handleResize(): void {
		handlers.reposition();
	}
	function handleScroll(event: Event): void {
		if (event.target instanceof Node && popover?.contains(event.target)) return;
		handlers.close();
	}
	window.addEventListener('resize', handleResize);
	window.addEventListener('scroll', handleScroll, true);
	return () => {
		window.removeEventListener('resize', handleResize);
		window.removeEventListener('scroll', handleScroll, true);
	};
}

/**
 * Scroll `popover` itself so `item` is inside its visible box (a popover whose
 * height `computeAnchoredPosition` capped, or a list with its own max height,
 * scrolls internally). Only the popover's `scrollTop` / `scrollLeft` change:
 * `scrollIntoView` would scroll the ancestors as well, and an ancestor scroll
 * closes the popover (`watchAnchoredPopover`). `block`: `'nearest'` (default)
 * moves as little as possible; `'center'` puts an item that is not fully
 * visible in the middle (a list opening on its value). Moved out of
 * DateInput (date-time-pickers PR-2, shared with TimeInput).
 */
export function revealInPopover(
	popover: HTMLElement,
	item: HTMLElement,
	block: 'nearest' | 'center' = 'nearest'
): void {
	const box = popover.getBoundingClientRect();
	const rect = item.getBoundingClientRect();
	const top = box.top + popover.clientTop;
	const bottom = top + popover.clientHeight;
	if (rect.top < top || rect.bottom > bottom) {
		if (block === 'center') {
			popover.scrollTop += rect.top + rect.height / 2 - (top + popover.clientHeight / 2);
		} else if (rect.top < top) {
			popover.scrollTop -= top - rect.top;
		} else {
			popover.scrollTop += rect.bottom - bottom;
		}
	}
	const left = box.left + popover.clientLeft;
	const right = left + popover.clientWidth;
	if (rect.left < left) popover.scrollLeft -= left - rect.left;
	else if (rect.right > right) popover.scrollLeft += rect.right - right;
}
