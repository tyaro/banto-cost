// @vitest-environment jsdom
/**
 * @banto/ui LauncherBar contracts (docs/design/nav-launcher-plan.md §4, §7.1):
 * one `<nav aria-label>` per group with a separator between groups only,
 * plain links with real-text accessible names (badge label included) and
 * `aria-current`, the `aria-hidden` tooltip and its Esc (window-level, only
 * registered while shown, yielding to a visible layer), and the
 * magnification wiring (`--_scale` for a mouse, none under reduced motion or
 * for touch).
 *
 * jsdom lays nothing out: item rects are all zero (every centre is at x = 0,
 * so a mouse at x = 0 magnifies every item), the tokens are set inline on the
 * bar, and `getClientRects()` is stubbed so a layer counts as visible
 * (layering.test.ts does the same). The look - sizes, the tab bar under
 * 900px - is for the visual tests of the shell (plan §7.3).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LauncherBar, type LauncherGroup, type LauncherPosition } from '../src/index';
import CustomIcon from './fixtures/CustomIcon.svelte';

const groups: LauncherGroup[] = [
	{
		id: 'main',
		ariaLabel: 'Main navigation',
		items: [
			{ id: 'dashboard', href: '/dashboard', label: 'Dashboard', icon: CustomIcon, active: true },
			{
				id: 'items',
				href: '/items',
				label: 'Items',
				icon: CustomIcon,
				badge: { text: '3', label: '3 updates' }
			}
		]
	},
	{
		id: 'admin',
		ariaLabel: 'Admin navigation',
		items: [{ id: 'users', href: '/users', label: 'Users', icon: CustomIcon }]
	}
];

/** Media queries reported as matching by the matchMedia stub. */
let matching = new Set<string>();

beforeAll(() => {
	Element.prototype.getClientRects = function (this: Element) {
		return (this.isConnected ? [{}] : []) as unknown as DOMRectList;
	};
});

beforeEach(() => {
	matching = new Set();
	vi.stubGlobal(
		'matchMedia',
		(query: string) =>
			({
				matches: matching.has(query),
				media: query,
				addEventListener: () => {},
				removeEventListener: () => {}
			}) as unknown as MediaQueryList
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function renderBar(
	props: Partial<{ magnify: boolean; ariaLabel: string; position: LauncherPosition }> = {}
) {
	const result = render(LauncherBar, { groups, ...props });
	const bar = result.container.querySelector<HTMLElement>('.launcher__bar')!;
	bar.style.setProperty('--banto-shell-launcher-magnify-max', '1.5');
	bar.style.setProperty('--banto-shell-launcher-item-size', '44px');
	return { ...result, bar };
}

const itemOf = (name: string) => screen.getByRole('link', { name }).closest('li') as HTMLElement;
const scaled = (container: HTMLElement) =>
	[...container.querySelectorAll<HTMLElement>('[data-launcher-item]')].filter(
		(li) => li.style.getPropertyValue('--_scale') !== ''
	);

describe('LauncherBar structure', () => {
	it('renders one labelled <nav> per group with its links', () => {
		renderBar();
		const main = screen.getByRole('navigation', { name: 'Main navigation' });
		const admin = screen.getByRole('navigation', { name: 'Admin navigation' });
		expect(within(main).getAllByRole('link')).toHaveLength(2);
		expect(within(admin).getAllByRole('link')).toHaveLength(1);
	});

	it('gives links their href and a real-text name including the badge label', () => {
		renderBar();
		expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('href')).toBe('/dashboard');
		const items = screen.getByRole('link', { name: 'Items 3 updates' });
		expect(items.getAttribute('href')).toBe('/items');
		expect(items.hasAttribute('aria-label')).toBe(false);
		expect(items.hasAttribute('title')).toBe(false);
		expect(within(items).getByText('3').getAttribute('aria-hidden')).toBe('true');
	});

	it('marks only the active link with aria-current="page"', () => {
		renderBar();
		expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe(
			'page'
		);
		expect(screen.getByRole('link', { name: 'Users' }).hasAttribute('aria-current')).toBe(false);
	});

	it('draws a separator between groups only', () => {
		const { container } = renderBar();
		const separators = container.querySelectorAll('.launcher__separator');
		expect(separators).toHaveLength(groups.length - 1);
		const main = screen.getByRole('navigation', { name: 'Main navigation' });
		expect(main.nextElementSibling).toBe(separators[0]);
	});

	it('has the position class and no group role without ariaLabel', () => {
		const { container } = renderBar();
		const root = container.querySelector('.launcher')!;
		expect(root.classList.contains('launcher--bottom')).toBe(true);
		expect(root.classList.contains('launcher--vertical')).toBe(false);
		expect(root.hasAttribute('role')).toBe(false);
	});

	it.each(['left', 'right'] as const)('marks a %s bar as vertical', (position) => {
		const { container } = renderBar({ position });
		const root = container.querySelector('.launcher')!;
		expect(root.classList.contains(`launcher--${position}`)).toBe(true);
		expect(root.classList.contains('launcher--vertical')).toBe(true);
		expect(root.classList.contains('launcher--bottom')).toBe(false);
	});

	it('marks a top bar as horizontal, like the bottom one', () => {
		const { container } = renderBar({ position: 'top' });
		const root = container.querySelector('.launcher')!;
		expect(root.classList.contains('launcher--top')).toBe(true);
		expect(root.classList.contains('launcher--vertical')).toBe(false);
		expect(root.classList.contains('launcher--bottom')).toBe(false);
	});

	it.each(['top', 'left', 'right'] as const)(
		'keeps the edge item classes on a %s bar',
		(position) => {
			renderBar({ position });
			expect(itemOf('Dashboard').classList.contains('launcher__item--first')).toBe(true);
			expect(itemOf('Users').classList.contains('launcher__item--last')).toBe(true);
		}
	);

	it('names the whole bar as a group when ariaLabel is given', () => {
		renderBar({ ariaLabel: 'Launcher' });
		expect(screen.getByRole('group', { name: 'Launcher' })).toBeTruthy();
	});

	it('hides the tooltip from assistive technology', () => {
		renderBar();
		const tooltip = itemOf('Dashboard').querySelector('.launcher__tooltip')!;
		expect(tooltip.getAttribute('aria-hidden')).toBe('true');
		expect(tooltip.textContent).toBe('Dashboard');
	});

	it('marks only the outermost items so their tooltips grow inwards across groups', () => {
		renderBar();
		const edges = (name: string) => {
			const li = itemOf(name);
			return [
				li.classList.contains('launcher__item--first'),
				li.classList.contains('launcher__item--last')
			];
		};
		expect(edges('Dashboard')).toEqual([true, false]);
		expect(edges('Items 3 updates')).toEqual([false, false]);
		expect(edges('Users')).toEqual([false, true]);
	});

	it('treats a single item as first only and skips empty groups', () => {
		render(LauncherBar, {
			groups: [
				{ id: 'empty', ariaLabel: 'Empty', items: [] },
				{
					id: 'main',
					ariaLabel: 'Main navigation',
					items: [{ id: 'only', href: '/only', label: 'Only', icon: CustomIcon }]
				}
			]
		});
		const li = itemOf('Only');
		expect(li.classList.contains('launcher__item--first')).toBe(true);
		expect(li.classList.contains('launcher__item--last')).toBe(false);
	});
});

describe('LauncherBar tooltip Esc', () => {
	it('hides on Esc with focus outside the bar and drops the window listener', async () => {
		const outside = document.createElement('button');
		document.body.append(outside);
		renderBar();
		outside.focus();
		const add = vi.spyOn(window, 'addEventListener');
		const remove = vi.spyOn(window, 'removeEventListener');
		const item = itemOf('Dashboard');

		await fireEvent.pointerEnter(item, { pointerType: 'mouse' });
		const keydownAdds = add.mock.calls.filter(([type]) => type === 'keydown');
		expect(keydownAdds).toHaveLength(1);
		const listener = keydownAdds[0][1];

		const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		outside.dispatchEvent(event);
		await tick();
		expect(event.defaultPrevented).toBe(false);
		expect(item.classList.contains('launcher__item--quiet')).toBe(true);
		expect(remove.mock.calls.some(([type, fn]) => type === 'keydown' && fn === listener)).toBe(
			true
		);

		// Pointer still on the item: no re-show; leaving clears the quiet state.
		await fireEvent.pointerMove(item, { pointerType: 'mouse' });
		expect(item.classList.contains('launcher__item--quiet')).toBe(true);
		await fireEvent.pointerLeave(item, { pointerType: 'mouse' });
		expect(item.classList.contains('launcher__item--quiet')).toBe(false);
	});

	it('registers no listener while no tooltip is shown', () => {
		const add = vi.spyOn(window, 'addEventListener');
		renderBar();
		expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
	});

	it('leaves Esc to a visible layer above', async () => {
		renderBar();
		const dialog = document.createElement('div');
		dialog.setAttribute('role', 'dialog');
		document.body.append(dialog);
		const item = itemOf('Items 3 updates');
		await fireEvent.pointerEnter(item, { pointerType: 'mouse' });
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(item.classList.contains('launcher__item--quiet')).toBe(false);
	});

	it('still hides on Esc while a lower in-page window (role="dialog") is shown', async () => {
		const dialog = document.createElement('div');
		dialog.setAttribute('role', 'dialog');
		dialog.style.position = 'absolute';
		dialog.style.zIndex = '5';
		document.body.append(dialog);
		const { container } = renderBar();
		const root = container.querySelector<HTMLElement>('.launcher')!;
		root.style.position = 'fixed';
		root.style.zIndex = '200';
		const item = itemOf('Items 3 updates');
		await fireEvent.pointerEnter(item, { pointerType: 'mouse' });
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(item.classList.contains('launcher__item--quiet')).toBe(true);
	});

	it('ignores an Esc another handler already consumed', async () => {
		renderBar();
		const item = itemOf('Users');
		await fireEvent.pointerEnter(item, { pointerType: 'mouse' });
		const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		event.preventDefault();
		window.dispatchEvent(event);
		await tick();
		expect(item.classList.contains('launcher__item--quiet')).toBe(false);
	});
});

describe('LauncherBar magnification', () => {
	it('sets --_scale on items near a mouse pointer and clears it on leave', async () => {
		const { bar, container } = renderBar();
		await fireEvent.pointerMove(bar, { pointerType: 'mouse', clientX: 0 });
		await nextFrame();
		await tick();
		const items = scaled(container);
		expect(items).toHaveLength(3);
		expect(items[0].style.getPropertyValue('--_scale')).toBe('1.5');

		await fireEvent.pointerLeave(bar, { pointerType: 'mouse' });
		expect(scaled(container)).toHaveLength(0);
	});

	it('does not magnify under prefers-reduced-motion', async () => {
		matching.add('(prefers-reduced-motion: reduce)');
		const { bar, container } = renderBar();
		await fireEvent.pointerMove(bar, { pointerType: 'mouse', clientX: 0 });
		await nextFrame();
		await tick();
		expect(scaled(container)).toHaveLength(0);
	});

	it('does not magnify for a touch pointer', async () => {
		const { bar, container } = renderBar();
		await fireEvent.pointerMove(bar, { pointerType: 'touch', clientX: 0 });
		await nextFrame();
		await tick();
		expect(scaled(container)).toHaveLength(0);
	});

	it('does not magnify with magnify={false}', async () => {
		const { bar, container } = renderBar({ magnify: false });
		await fireEvent.pointerMove(bar, { pointerType: 'mouse', clientX: 0 });
		await nextFrame();
		await tick();
		expect(scaled(container)).toHaveLength(0);
	});

	/**
	 * Items stacked vertically (centres at y = 22, 72, 122) on x = 22; the
	 * pointer is on the first item's vertical centre but 500px off on x.
	 */
	function stackItems(container: HTMLElement): void {
		const items = [...container.querySelectorAll<HTMLElement>('[data-launcher-item]')];
		items.forEach((li, index) => {
			vi.spyOn(li, 'getBoundingClientRect').mockReturnValue({
				left: 0,
				top: index * 50,
				width: 44,
				height: 44
			} as DOMRect);
		});
	}

	it.each(['left', 'right'] as const)(
		'magnifies along the vertical axis on a %s bar',
		async (position) => {
			const { bar, container } = renderBar({ position });
			stackItems(container);
			await fireEvent.pointerMove(bar, { pointerType: 'mouse', clientX: 500, clientY: 22 });
			await nextFrame();
			await tick();
			expect(itemOf('Dashboard').style.getPropertyValue('--_scale')).toBe('1.5');
			const items = Number(itemOf('Items 3 updates').style.getPropertyValue('--_scale'));
			const users = Number(itemOf('Users').style.getPropertyValue('--_scale'));
			expect(items).toBeGreaterThan(users);
			expect(users).toBeGreaterThan(1);
		}
	);

	it.each(['bottom', 'top'] as const)(
		'magnifies along the horizontal axis on the %s bar',
		async (position) => {
			const { bar, container } = renderBar({ position });
			stackItems(container);
			await fireEvent.pointerMove(bar, { pointerType: 'mouse', clientX: 500, clientY: 22 });
			await nextFrame();
			await tick();
			expect(scaled(container)).toHaveLength(0);
		}
	);

	it('does not magnify when the max token is unreadable', async () => {
		const { bar, container } = renderBar();
		bar.style.removeProperty('--banto-shell-launcher-magnify-max');
		await fireEvent.pointerMove(bar, { pointerType: 'mouse', clientX: 0 });
		await nextFrame();
		await tick();
		expect(scaled(container)).toHaveLength(0);
	});
});
