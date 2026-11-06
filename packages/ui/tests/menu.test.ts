// @vitest-environment jsdom
/**
 * @banto/ui menu contracts (docs/adr/0018-shared-ui-package.md §8, phase 2a):
 * open/close through the trigger, the ARIA wiring, roving keyboard focus
 * (arrows wrapping, Home/End, disabled items skipped, Tab closes), item
 * activation + close, and focus returning to the trigger, plus the long-menu
 * rules of #427 (height capped to the space beside the trigger from stubbed
 * rects; the menu's own scroll does not close it, an outer scroll does).
 * Real placement and the top-layer look are browser behaviour
 * (e2e/visual/ui-overlays.spec.ts), not asserted here.
 *
 * jsdom has no Popover API, so a minimal stand-in is installed: it flips a
 * `data-popover-open` marker and fires the `toggle` event asynchronously like
 * browsers do (the component's `open` state follows `ToggleEvent.newState`).
 * Newer jsdom hides `[popover]:not(:popover-open)` with `display: none` (and
 * cannot match `:popover-open` for the stand-in), so the stand-in also toggles
 * an inline `display: block`; otherwise the items are not focusable.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import MenuHarness from './fixtures/MenuHarness.svelte';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

function fireToggle(el: HTMLElement, newState: 'open' | 'closed'): void {
	queueMicrotask(() => {
		const event = new Event('toggle');
		Object.defineProperty(event, 'newState', { value: newState });
		el.dispatchEvent(event);
	});
}

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as PopoverElement;
	proto.showPopover = function (this: HTMLElement) {
		if (this.dataset.popoverOpen === 'true') throw new Error('already open');
		this.dataset.popoverOpen = 'true';
		this.style.display = 'block';
		fireToggle(this, 'open');
	};
	proto.hidePopover = function (this: HTMLElement) {
		if (this.dataset.popoverOpen !== 'true') return;
		delete this.dataset.popoverOpen;
		this.style.removeProperty('display');
		fireToggle(this, 'closed');
	};
});

afterEach(cleanup);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const item = (label: string) => screen.getByText(label).closest('button') as HTMLElement;

function setup() {
	const onProfile = vi.fn();
	const onDisabled = vi.fn();
	const onLogout = vi.fn();
	render(MenuHarness, { onProfile, onDisabled, onLogout });
	const trigger = screen.getByRole('button', { name: 'Open' });
	// The popover is `visibility: hidden` until opened, which also empties
	// its accessible name - so closed-state queries use `hidden` and no name.
	const menu = screen.getByRole('menu', { hidden: true });
	return { trigger, menu, onProfile, onDisabled, onLogout };
}

describe('Menu', () => {
	it('wires the trigger and popover with ARIA and starts closed', () => {
		const { trigger, menu } = setup();
		expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(menu.getAttribute('popover')).toBe('auto');
		expect(menu.getAttribute('aria-label')).toBe('User menu');
		expect(menu.dataset.popoverOpen).toBeUndefined();
	});

	it('opens on click, focuses the first enabled item and reflects aria-expanded', async () => {
		const { trigger, menu } = setup();
		await fireEvent.click(trigger);
		await flush();
		expect(menu.dataset.popoverOpen).toBe('true');
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		expect(document.activeElement).toBe(item('Profile'));
	});

	it('closes on a second trigger click and returns focus to the trigger', async () => {
		const { trigger, menu } = setup();
		await fireEvent.click(trigger);
		await flush();
		await fireEvent.click(trigger);
		await flush();
		expect(menu.dataset.popoverOpen).toBeUndefined();
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(trigger);
	});

	it('opens from the keyboard: ArrowDown focuses the first item, ArrowUp the last', async () => {
		const { trigger, menu } = setup();
		await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
		await flush();
		expect(document.activeElement).toBe(item('Profile'));
		(menu as PopoverElement).hidePopover();
		await flush();
		await fireEvent.keyDown(trigger, { key: 'ArrowUp' });
		await flush();
		expect(document.activeElement).toBe(item('Log out'));
	});

	it('roves focus with arrows (wrapping, skipping disabled), Home and End', async () => {
		const { trigger, menu } = setup();
		await fireEvent.click(trigger);
		await flush();
		const profile = item('Profile');
		const logout = item('Log out');
		await fireEvent.keyDown(menu, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(logout); // Billing is disabled -> skipped
		await fireEvent.keyDown(menu, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(profile); // wraps
		await fireEvent.keyDown(menu, { key: 'ArrowUp' });
		expect(document.activeElement).toBe(logout); // wraps backwards
		await fireEvent.keyDown(menu, { key: 'Home' });
		expect(document.activeElement).toBe(profile);
		await fireEvent.keyDown(menu, { key: 'End' });
		expect(document.activeElement).toBe(logout);
	});

	it('closes on Tab without trapping focus', async () => {
		const { trigger, menu } = setup();
		await fireEvent.click(trigger);
		await flush();
		await fireEvent.keyDown(menu, { key: 'Tab' });
		await flush();
		expect(menu.dataset.popoverOpen).toBeUndefined();
	});

	it('activates an item: callback fires once, then the menu closes', async () => {
		const { trigger, menu, onProfile, onLogout } = setup();
		await fireEvent.click(trigger);
		await flush();
		await fireEvent.click(item('Profile'));
		await flush();
		expect(onProfile).toHaveBeenCalledTimes(1);
		expect(onLogout).not.toHaveBeenCalled();
		expect(menu.dataset.popoverOpen).toBeUndefined();
		expect(document.activeElement).toBe(trigger);
	});

	it('ignores clicks on a disabled item and keeps the menu open', async () => {
		const { trigger, menu, onDisabled } = setup();
		await fireEvent.click(trigger);
		await flush();
		const billing = item('Billing');
		expect(billing.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(billing);
		await flush();
		expect(onDisabled).not.toHaveBeenCalled();
		expect(menu.dataset.popoverOpen).toBe('true');
	});

	it('gives items tabindex=-1 (roving focus only) and hides item icons from AT', () => {
		setup();
		for (const item of screen.getAllByRole('menuitem', { hidden: true })) {
			expect(item.getAttribute('tabindex')).toBe('-1');
		}
		const icon = screen.getByTestId('custom-icon');
		expect(icon.getAttribute('aria-hidden')).toBe('true');
		expect(icon.getAttribute('data-size')).toBe('16');
	});

	it('renders a labelled group, a separator and marks the danger item', () => {
		setup();
		expect(screen.getByRole('group', { hidden: true })).toBeTruthy();
		expect(screen.getByRole('separator', { hidden: true })).toBeTruthy();
		expect(item('Log out').className).toContain('danger');
	});

	describe('long menus (#427)', () => {
		const root = document.documentElement;

		afterEach(() => {
			vi.restoreAllMocks();
			// Drop the own-property overrides so jsdom's prototype getters return.
			delete (root as unknown as Record<string, unknown>).clientHeight;
			delete (root as unknown as Record<string, unknown>).clientWidth;
		});

		/** 960x480 viewport, a trigger at the given vertical span, and a menu
		 * whose natural box is 900px tall (far more than either side). */
		function stubLayout(
			trigger: HTMLElement,
			menu: HTMLElement,
			top: number,
			bottom: number
		): void {
			Object.defineProperty(root, 'clientHeight', { configurable: true, value: 480 });
			Object.defineProperty(root, 'clientWidth', { configurable: true, value: 960 });
			vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
				top,
				bottom,
				left: 800,
				right: 900,
				width: 100,
				height: bottom - top
			} as DOMRect);
			vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({
				top: 0,
				bottom: 900,
				left: 0,
				right: 200,
				width: 200,
				height: 900
			} as DOMRect);
		}

		const maxHeightOf = (menu: HTMLElement) => parseFloat(menu.style.maxHeight);

		it('caps the height to the space below a trigger near the top', async () => {
			const { trigger, menu } = setup();
			stubLayout(trigger, menu, 10, 40);
			await fireEvent.click(trigger);
			await flush();
			expect(menu.style.top).toBe('44px');
			// 480 - (40 + 4) - 4 = 432 for the whole box, less padding + border.
			expect(maxHeightOf(menu)).toBeGreaterThan(400);
			expect(maxHeightOf(menu)).toBeLessThanOrEqual(432);
		});

		it('flips above and caps the height when the space above is larger', async () => {
			const { trigger, menu } = setup();
			stubLayout(trigger, menu, 400, 430);
			await fireEvent.click(trigger);
			await flush();
			// 400 - 4 - 4 = 392 for the whole box, placed 4px from the top edge.
			expect(menu.style.top).toBe('4px');
			expect(maxHeightOf(menu)).toBeGreaterThan(360);
			expect(maxHeightOf(menu)).toBeLessThanOrEqual(392);
		});

		it('does not cap a menu that fits, and clears the cap on close', async () => {
			const { trigger, menu } = setup();
			stubLayout(trigger, menu, 10, 40);
			await fireEvent.click(trigger);
			await flush();
			expect(menu.style.maxHeight).not.toBe('');
			(menu as PopoverElement).hidePopover();
			await flush();
			expect(menu.style.maxHeight).toBe('');
			vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({
				height: 120,
				width: 200
			} as DOMRect);
			await fireEvent.click(trigger);
			await flush();
			expect(menu.style.maxHeight).toBe('');
		});

		it("stays open on the menu's own scroll and closes on an outer scroll", async () => {
			const { trigger, menu } = setup();
			await fireEvent.click(trigger);
			await flush();
			// Wheel inside the menu, or the browser scrolling a focused item
			// into view, targets the menu itself (scroll does not bubble; the
			// component listens in the capture phase on window).
			menu.dispatchEvent(new Event('scroll'));
			item('Log out').dispatchEvent(new Event('scroll'));
			await flush();
			expect(menu.dataset.popoverOpen).toBe('true');
			document.dispatchEvent(new Event('scroll'));
			await flush();
			expect(menu.dataset.popoverOpen).toBeUndefined();
		});

		it('closes on an ancestor element scroll', async () => {
			const { trigger, menu } = setup();
			await fireEvent.click(trigger);
			await flush();
			(menu.parentElement as HTMLElement).dispatchEvent(new Event('scroll'));
			await flush();
			expect(menu.dataset.popoverOpen).toBeUndefined();
		});
	});
});
