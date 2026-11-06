/**
 * `@banto/ui` Modal / Drawer on the `/ui-demo` page (ADR-0018 §10, phase 4):
 * the Esc / focus layering in a real browser (jsdom has no layout, so the
 * package's unit tests stub geometry and the scoped CSS that carries the
 * `--banto-z-modal` z-index), the Menu's long-menu cap and internal scroll
 * (#427), plus an axe scan of the open layers in the two
 * diagonal theme combos (the closed page's pixels are covered by the
 * `ui-demo` screenshot in visual.spec.ts). Same `visual` project as the other
 * specs here (vite preview, browser demo mode, reduced motion - so the
 * transitions take 0ms).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, comboLabel, primeThemeAndAuth } from './theme';

async function gotoDemo(page: Page): Promise<void> {
	await page.goto('/ui-demo');
	await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
}

test.describe('ui-demo Modal / Drawer behaviour', () => {
	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await gotoDemo(page);
	});

	test('Modal: focus moves in, Esc closes, focus returns to the opener', async ({ page }) => {
		const opener = page.getByTestId('ui-demo-open-modal');
		await opener.click();
		const modal = page.getByRole('dialog', { name: '見本のモーダル' });
		await expect(modal).toBeVisible();
		await expect(modal.getByRole('button', { name: '閉じる' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(modal).toBeHidden();
		await expect(opener).toBeFocused();
		await expect(page.getByTestId('ui-demo-overlay-closed')).toContainText('1');
	});

	test('Drawer: dirty blocks Esc, a stacked Modal closes first, × closes the Drawer', async ({
		page
	}) => {
		const opener = page.getByTestId('ui-demo-open-drawer');
		await opener.click();
		const drawer = page.getByRole('dialog', { name: '見本のドロワー' });
		await expect(drawer).toBeVisible();

		await page.getByTestId('ui-demo-drawer-note').fill('draft');
		await page.keyboard.press('Escape');
		await expect(drawer).toBeVisible();
		await expect(
			page.getByText('未保存の入力があります。閉じるには × を押してください。')
		).toBeVisible();

		const nestedOpener = page.getByTestId('ui-demo-open-nested');
		await nestedOpener.click();
		const nested = page.getByRole('dialog', { name: '重ねたモーダル' });
		await expect(nested).toBeVisible();
		// The focus trap of the Drawer below must not pull focus out of the stacked Modal.
		await page.keyboard.press('Tab');
		await expect(nested.getByRole('button', { name: '閉じる' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(nested).toBeHidden();
		await expect(drawer).toBeVisible();
		await expect(nestedOpener).toBeFocused();

		await drawer.getByRole('button', { name: '閉じる' }).first().click();
		await expect(drawer).toBeHidden();
		await expect(opener).toBeFocused();
	});
});

// Standard: the panels rest at `transform: none`, so a Modal placed in the
// Drawer's body is NOT confined to it - full-viewport backdrop, centred in
// the viewport (a resting translateX(0) / scale(1) would confine it).
test('standard: a Modal stacked in a Drawer covers and centres in the whole viewport', async ({
	page
}) => {
	await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
	await gotoDemo(page);
	await page.getByTestId('ui-demo-open-drawer').click();
	await page.getByTestId('ui-demo-open-nested').click();
	const nested = page.getByRole('dialog', { name: '重ねたモーダル' });
	await expect(nested).toBeVisible();
	const viewport = page.viewportSize() ?? { width: 0, height: 0 };
	const backdrop = await nested.locator('xpath=..').boundingBox();
	expect(backdrop).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
	const box = await nested.boundingBox();
	expect(box).not.toBeNull();
	if (box) {
		expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
		expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(2);
	}
	const transforms = await page
		.locator('[role="dialog"]')
		.evaluateAll((els) => els.map((el) => getComputedStyle(el).transform));
	expect(transforms).toEqual(['none', 'none']);
});

// A non-zero exit (the project forces reduced motion, i.e. 0ms): while the
// stacked Modal fades out it is inert, so Tab / Enter from the Drawer never
// reach it; reopening the Drawer during its own exit works.
test('non-zero exit: a leaving layer is unreachable by keyboard; reopening mid-exit works', async ({
	page
}) => {
	await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
	await gotoDemo(page);
	await page.addStyleTag({ content: ':root { --banto-duration-base: 1s !important; }' });
	const opener = page.getByTestId('ui-demo-open-drawer');
	await opener.click();
	const nestedOpener = page.getByTestId('ui-demo-open-nested');
	await nestedOpener.click();
	await expect(page.getByRole('dialog', { name: '重ねたモーダル' })).toBeVisible();
	await page.keyboard.press('Escape');
	const leaving = page.locator('[role="dialog"][aria-label="重ねたモーダル"]');
	await expect(leaving).toHaveAttribute('data-layer-inactive', 'true');
	await expect(leaving.locator('xpath=..')).toHaveAttribute('inert', '');
	await expect(nestedOpener).toBeFocused();
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press('Tab');
		const inLeaving = await page.evaluate(
			() => document.activeElement?.closest('[aria-label="重ねたモーダル"]') !== null
		);
		expect(inLeaving).toBe(false);
	}
	// Not focusable at all while leaving (a programmatic focus() is refused too).
	const refused = await page.evaluate(() => {
		const close = document.querySelector<HTMLElement>('[aria-label="重ねたモーダル"] button');
		close?.focus();
		return document.activeElement !== close;
	});
	expect(refused).toBe(true);
	await expect(leaving).toHaveCount(0);

	const drawer = page.locator('[role="dialog"][aria-label="見本のドロワー"]');
	await drawer.getByRole('button', { name: '閉じる' }).click();
	await expect(drawer).toHaveAttribute('data-layer-inactive', 'true');
	await opener.click();
	await expect(drawer).not.toHaveAttribute('data-layer-inactive', 'true');
	await expect(drawer.locator('xpath=..')).not.toHaveAttribute('inert', '');
	await expect(drawer.getByRole('button', { name: '閉じる' })).toBeFocused();
	await page.waitForTimeout(1200);
	await expect(drawer).toBeVisible();
});

// Glass, with the Drawer panel forced to be a containing block (`will-change:
// transform` - what an app's transform / filter, or an engine treating
// backdrop-filter that way, does): the stacked Modal's backdrop then covers
// only the Drawer, and a click left of the Drawer lands on the Drawer's own
// backdrop. That click must not close the Drawer (and the Modal with it).
test('glass: a click on the Drawer backdrop beside a stacked Modal closes nothing', async ({
	page
}) => {
	await primeThemeAndAuth(page, DIAGONAL_MATRIX[1]);
	await gotoDemo(page);
	await page.addStyleTag({
		content: '[role="dialog"][aria-label="見本のドロワー"] { will-change: transform; }'
	});
	const opener = page.getByTestId('ui-demo-open-drawer');
	await opener.click();
	const drawer = page.getByRole('dialog', { name: '見本のドロワー' });
	await page.getByTestId('ui-demo-open-nested').click();
	const nested = page.getByRole('dialog', { name: '重ねたモーダル' });
	await expect(nested).toBeVisible();
	// The precondition: the Modal's backdrop is confined, so (100, 450) is the Drawer's backdrop.
	const confined = await nested.locator('xpath=..').boundingBox();
	expect(confined?.x ?? 0).toBeGreaterThan(100);

	await page.mouse.click(100, 450);
	await expect(nested).toBeVisible();
	await expect(drawer).toBeVisible();

	// Esc closes the stacked Modal first; then the backdrop click closes the Drawer.
	await page.keyboard.press('Escape');
	await expect(nested).toBeHidden();
	await page.mouse.click(100, 450);
	await expect(drawer).toBeHidden();

	// Closing the Drawer also reset the stacked Modal: reopening shows only the Drawer.
	await opener.click();
	await expect(drawer).toBeVisible();
	await expect(nested).toBeHidden();
});

/** Readable failure message: rule id + impact + affected node selectors. */
function formatViolations(violations: import('axe-core').Result[]): string {
	return violations
		.map((v) => {
			const nodes = v.nodes.map((n) => `    - ${n.target.join(' ')}`).join('\n');
			return `[${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n${nodes}`;
		})
		.join('\n\n');
}

for (const combo of DIAGONAL_MATRIX) {
	test.describe(`a11y ui-demo overlays ${comboLabel(combo)}`, () => {
		test('open Modal has no wcag2a/wcag2aa violations', async ({ page }) => {
			await primeThemeAndAuth(page, combo);
			await gotoDemo(page);
			await page.getByTestId('ui-demo-open-modal').click();
			await expect(page.getByRole('dialog', { name: '見本のモーダル' })).toBeVisible();
			const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
			expect(results.violations, formatViolations(results.violations)).toEqual([]);
		});

		test('open Drawer with a stacked Modal has no wcag2a/wcag2aa violations', async ({ page }) => {
			await primeThemeAndAuth(page, combo);
			await gotoDemo(page);
			await page.getByTestId('ui-demo-open-drawer').click();
			await page.getByTestId('ui-demo-open-nested').click();
			await expect(page.getByRole('dialog', { name: '重ねたモーダル' })).toBeVisible();
			const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
			expect(results.violations, formatViolations(results.violations)).toEqual([]);
		});
	});
}

// Long menus (#427). The demo Menu has 4 items (~200px), so instead of adding
// items to the page (it is the `ui-demo` visual baseline) the viewport is made
// shorter than the menu on both sides of its trigger: 960x240 with the trigger
// scrolled to the middle leaves ~100px per side - the same "fits on neither
// side" path a 30-40 item menu takes at 960x480.
test.describe('ui-demo Menu longer than the space beside its trigger', () => {
	test.use({ viewport: { width: 960, height: 240 } });

	const menuOf = (page: Page) => page.getByRole('menu', { name: '見本のメニュー' });
	const triggerOf = (page: Page) =>
		page.getByRole('button', { name: 'メニューを開く', exact: true });

	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await gotoDemo(page);
		await triggerOf(page).evaluate((el) => el.scrollIntoView({ block: 'center' }));
	});

	async function expectInsideViewport(page: Page, box: { y: number; height: number } | null) {
		const viewport = page.viewportSize() ?? { width: 0, height: 0 };
		expect(box).not.toBeNull();
		if (box) {
			expect(box.y).toBeGreaterThanOrEqual(0);
			expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
		}
	}

	test('is capped to the viewport and scrolls inside without closing or moving the page', async ({
		page
	}) => {
		await triggerOf(page).click();
		const menu = menuOf(page);
		await expect(menu).toBeVisible();
		await expectInsideViewport(page, await menu.boundingBox());
		expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

		// Scroll offsets of everything but the menu (window included).
		const pageScroll = () =>
			page.evaluate(() =>
				[...document.querySelectorAll('*')]
					.filter((el) => el.getAttribute('role') !== 'menu')
					.map((el) => el.scrollTop)
					.concat(window.scrollY)
					.join()
			);
		const before = await pageScroll();
		const box = await menu.boundingBox();
		if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		// Far more than the menu's own overflow: the rest must not chain to the page.
		await page.mouse.wheel(0, 2000);
		await expect.poll(() => menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
		await expect(menu).toBeVisible();
		const lastItem = menu.getByRole('menuitem', { name: '削除' });
		await expectInsideViewport(page, await lastItem.boundingBox());
		// Only the menu itself scrolled (overscroll-behavior: contain).
		expect(await pageScroll()).toBe(before);

		await lastItem.click();
		await expect(menu).toBeHidden();
		await expect(page.getByTestId('ui-demo-menu-selected')).toContainText('削除');
	});

	test('End focuses the last item in view and keeps the menu open', async ({ page }) => {
		await triggerOf(page).focus();
		await page.keyboard.press('ArrowDown');
		const menu = menuOf(page);
		await expect(menu).toBeVisible();
		await page.keyboard.press('End');
		const lastItem = menu.getByRole('menuitem', { name: '削除' });
		await expect(lastItem).toBeFocused();
		await expect(menu).toBeVisible();
		await expectInsideViewport(page, await lastItem.boundingBox());
		await page.keyboard.press('Home');
		await expect(menu.getByRole('menuitem', { name: '編集' })).toBeFocused();
		await expect(menu).toBeVisible();
	});

	test('ArrowUp on the trigger opens at the last item, in view', async ({ page }) => {
		await triggerOf(page).focus();
		await page.keyboard.press('ArrowUp');
		const lastItem = menuOf(page).getByRole('menuitem', { name: '削除' });
		await expect(lastItem).toBeFocused();
		await expectInsideViewport(page, await lastItem.boundingBox());
	});

	test('an outer scroll still closes it', async ({ page }) => {
		await triggerOf(page).click();
		const menu = menuOf(page);
		await expect(menu).toBeVisible();
		// Scroll whatever ancestor of the trigger actually scrolls (the app
		// shell's main area or the document).
		await triggerOf(page).evaluate((el) => {
			let node: HTMLElement | null = el.parentElement;
			while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;
			(node ?? document.scrollingElement ?? document.documentElement).scrollTop += 40;
		});
		await expect(menu).toBeHidden();
	});

	test('Esc closes it and returns focus to the trigger', async ({ page }) => {
		await triggerOf(page).click();
		const menu = menuOf(page);
		await expect(menu).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden();
		await expect(triggerOf(page)).toBeFocused();
	});
});
