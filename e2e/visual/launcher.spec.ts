/**
 * The dock layout of the app shell (nav-launcher-plan.md §3, §4, §7.2) in a
 * real browser: tooltip hover / Esc / keyboard behaviour (WCAG 1.4.13 and
 * `:focus-visible` specificity cannot be checked in jsdom), navigation and
 * `aria-current`, the <=900px tab bar, the toast lifted above the bar and
 * the settings card (radio + opacity slider). Same `visual` project as the
 * other specs here (vite preview, browser demo mode, reduced motion - so
 * the tooltip transitions take 0ms and magnification is off). No pixels:
 * the screenshots are in visual.spec.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeKiosk, primeLauncher, primeThemeAndAuth } from './theme';

function mainNav(page: Page): Locator {
	return page.getByRole('navigation', { name: '主要ナビゲーション' });
}

/** The launcher's `<li>` for an app path (`data-launcher-item` is the item id = its path). */
function launcherItem(page: Page, path: string): Locator {
	return page.locator(`.launcher [data-launcher-item="${path}"]`);
}

function tooltipOf(item: Locator): Locator {
	return item.locator('.launcher__tooltip');
}

async function visibilityOf(locator: Locator): Promise<string> {
	return locator.evaluate((el) => getComputedStyle(el).visibility);
}

async function gotoDashboard(page: Page): Promise<void> {
	await page.goto('/dashboard');
	await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
	await expect(page.locator('.launcher')).toBeVisible();
}

test.describe('dock layout (primed)', () => {
	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await primeLauncher(page);
	});

	test('replaces the sidebar: brand in the header, no hamburger, root marked for the toasts', async ({
		page
	}) => {
		await gotoDashboard(page);
		await expect(page.locator('aside')).toHaveCount(0);
		await expect(page.locator('header').getByText('Banto', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'サイドバーを開く' })).toHaveCount(0);
		await expect(page.locator('html')).toHaveAttribute('data-banto-shell-nav', 'launcher');
		// Admin session in demo mode: both groups.
		await expect(page.getByRole('navigation', { name: '管理ナビゲーション' })).toBeVisible();
	});

	test('a dock link navigates and moves aria-current', async ({ page }) => {
		await gotoDashboard(page);
		const nav = mainNav(page);
		await expect(nav.getByRole('link', { name: 'ダッシュボード' })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await nav.getByRole('link', { name: '商品' }).click();
		await expect(page).toHaveURL(/\/items$/);
		await expect(nav.getByRole('link', { name: '商品' })).toHaveAttribute('aria-current', 'page');
		await expect(nav.getByRole('link', { name: 'ダッシュボード' })).not.toHaveAttribute(
			'aria-current',
			'page'
		);
	});

	test('tooltip stays while the pointer moves onto it, and hides once it leaves (§4.4)', async ({
		page
	}) => {
		await gotoDashboard(page);
		const item = launcherItem(page, '/items');
		const tooltip = tooltipOf(item);
		await item.hover();
		await expect(tooltip).toBeVisible();

		const from = await item.boundingBox();
		const to = await tooltip.boundingBox();
		if (!from || !to) throw new Error('no layout for the item or its tooltip');
		// Straight up across the gap between the item and its tooltip.
		await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
		await expect(tooltip).toBeVisible();

		await page.mouse.move(to.x + to.width / 2, 200, { steps: 4 });
		await expect(tooltip).toBeHidden();
	});

	test('Esc hides a hovered tooltip while focus stays in a page input; a small move does not bring it back', async ({
		page
	}) => {
		await page.goto('/items/new');
		const name = page.getByLabel('商品名');
		await expect(name).toBeVisible();
		await name.fill('ドックのテスト');
		await expect(name).toBeFocused();

		const item = launcherItem(page, '/dashboard');
		const tooltip = tooltipOf(item);
		await item.hover();
		await expect(tooltip).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(tooltip).toBeHidden();
		await expect(name).toBeFocused();
		await expect(name).toHaveValue('ドックのテスト');

		const box = await item.boundingBox();
		if (!box) throw new Error('no layout for the item');
		await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2 + 2);
		await expect(tooltip).toBeHidden();
	});

	test('with the command palette open, Esc closes the palette and leaves the tooltip alone', async ({
		page
	}) => {
		await gotoDashboard(page);
		const item = launcherItem(page, '/items');
		await item.hover();
		await expect(tooltipOf(item)).toBeVisible();

		await page.keyboard.press('Control+K');
		const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
		await expect(palette).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(palette).toBeHidden();
		// The launcher yielded to the layer above: it did not mark the item quiet.
		await expect(item).not.toHaveClass(/launcher__item--quiet/);
	});

	test('a keyboard-shown tooltip hides on Esc, focus stays, and the next item shows its own (§7.2-3)', async ({
		page
	}) => {
		await gotoDashboard(page);
		await page.mouse.move(700, 200);

		const links = page.locator('.launcher a.launcher__link');
		await expect(links.first()).toBeVisible();
		// Tab until focus reaches the dock (it precedes .main in the DOM, §4.7).
		for (let i = 0; i < 20; i++) {
			await page.keyboard.press('Tab');
			if (await links.first().evaluate((el) => el === document.activeElement)) break;
		}
		const first = links.nth(0);
		const second = links.nth(1);
		await expect(first).toBeFocused();
		const firstTooltip = first.locator('xpath=..').locator('.launcher__tooltip');
		await expect.poll(() => visibilityOf(firstTooltip)).toBe('visible');

		await page.keyboard.press('Escape');
		await expect.poll(() => visibilityOf(firstTooltip)).toBe('hidden');
		await expect(first).toBeFocused();

		await page.keyboard.press('Tab');
		await expect(second).toBeFocused();
		const secondTooltip = second.locator('xpath=..').locator('.launcher__tooltip');
		await expect.poll(() => visibilityOf(secondTooltip)).toBe('visible');
	});

	test('a toast is lifted above the bar', async ({ page }) => {
		await page.goto('/ui-demo');
		await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
		await page.getByRole('button', { name: '成功を表示' }).click();
		const toast = page.locator('.toast-host .toast').first();
		await expect(toast).toBeVisible();
		const toastBox = await toast.boundingBox();
		const barBox = await page.locator('.launcher__bar').boundingBox();
		if (!toastBox || !barBox) throw new Error('no layout for the toast or the bar');
		expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(barBox.y);
	});

	test('<=900px: a full-width tab bar, no hamburger, toasts above it', async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 1024 });
		await gotoDashboard(page);
		await expect(page.getByRole('button', { name: 'サイドバーを開く' })).toHaveCount(0);
		const bar = await page.locator('.launcher__bar').boundingBox();
		if (!bar) throw new Error('no layout for the bar');
		expect(bar.width).toBeGreaterThanOrEqual(768 - 1);
		expect(Math.round(bar.y + bar.height)).toBe(1024);
		// The page keeps room for the bar below its content.
		const reserve = await page
			.locator('main')
			.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingBottom));
		expect(reserve).toBeGreaterThanOrEqual(bar.height);

		await page.goto('/ui-demo');
		await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
		await page.getByRole('button', { name: '成功を表示' }).click();
		const toast = page.locator('.toast-host .toast').first();
		await expect(toast).toBeVisible();
		const toastBox = await toast.boundingBox();
		const tabBar = await page.locator('.launcher__bar').boundingBox();
		if (!toastBox || !tabBar) throw new Error('no layout for the toast or the tab bar');
		expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(tabBar.y);
	});

	test('<=900px: the tab bar is never fainter than the 85% floor; wider screens follow the setting', async ({
		page
	}) => {
		/** Alpha of the bar's backdrop (`.launcher__bar::before`), as the browser computed it. */
		const barAlpha = () =>
			page.locator('.launcher__bar').evaluate((el) => {
				const colour = getComputedStyle(el, '::before').backgroundColor;
				const match =
					/\/\s*([\d.]+)\s*\)$/.exec(colour) ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(colour);
				return match ? Number(match[1]) : 1;
			});
		const setOpacity = (percent: number) =>
			page.evaluate(
				(value) =>
					document.documentElement.style.setProperty('--banto-shell-launcher-opacity', value),
				`${percent}%`
			);

		await page.setViewportSize({ width: 1440, height: 900 });
		await gotoDashboard(page);
		// The default 50% applies as is on a wide screen...
		expect(await barAlpha()).toBeCloseTo(0.5, 2);

		await page.setViewportSize({ width: 768, height: 1024 });
		// ...but the tab bar is raised to the floor,
		await expect.poll(barAlpha).toBeCloseTo(0.85, 2);
		// and a setting above the floor still wins.
		await setOpacity(95);
		await expect.poll(barAlpha).toBeCloseTo(0.95, 2);
	});
});

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.boundingBox();
	if (!box) throw new Error('no layout for the element');
	return box;
}

/** `main`'s content box (its padding is the room the shell keeps for the bar). */
async function mainContentBox(page: Page): Promise<{ left: number; right: number }> {
	return page.locator('main').evaluate((el) => {
		const rect = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		return {
			left: rect.left + Number.parseFloat(style.paddingLeft),
			right: rect.right - Number.parseFloat(style.paddingRight)
		};
	});
}

/** The tooltip is the element actually drawn at its own centre (not clipped by the scrolling track). */
async function drawnAtItsCentre(tooltip: Locator): Promise<boolean> {
	return tooltip.evaluate((el) => {
		const rect = el.getBoundingClientRect();
		const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		return hit !== null && el.contains(hit);
	});
}

// Left / right bars (nav-launcher-plan.md §4.1, D4).
for (const position of ['left', 'right'] as const) {
	test.describe(`dock on the ${position} edge (primed)`, () => {
		test.beforeEach(async ({ page }) => {
			await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
			await primeLauncher(page, position);
		});

		test('sits vertically centred on its edge and the content keeps clear of it', async ({
			page
		}) => {
			await gotoDashboard(page);
			await expect(page.locator(`.launcher--${position}`)).toBeVisible();
			await expect(page.locator('html')).toHaveAttribute(
				'data-banto-shell-launcher-position',
				position
			);
			const viewport = page.viewportSize();
			if (!viewport) throw new Error('no viewport');
			const bar = await boxOf(page.locator('.launcher__bar'));
			expect(bar.height).toBeGreaterThan(bar.width);
			expect(Math.abs(bar.y + bar.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2);
			const content = await mainContentBox(page);
			if (position === 'left') {
				expect(bar.x).toBeLessThan(20);
				expect(content.left).toBeGreaterThanOrEqual(bar.x + bar.width);
			} else {
				expect(viewport.width - (bar.x + bar.width)).toBeLessThan(20);
				expect(content.right).toBeLessThanOrEqual(bar.x);
			}
		});

		test('the tooltip shows beside the item on the page side, unclipped, and stays across the gap', async ({
			page
		}) => {
			await gotoDashboard(page);
			const viewport = page.viewportSize();
			if (!viewport) throw new Error('no viewport');
			// The first and the last item: the edges of the scrolling track.
			const items = page.locator('.launcher [data-launcher-item]');
			for (const item of [items.first(), items.last()]) {
				const tooltip = tooltipOf(item);
				await item.hover();
				await expect(tooltip).toBeVisible();
				await expect.poll(() => visibilityOf(tooltip)).toBe('visible');
				const itemBox = await boxOf(item);
				const tip = await boxOf(tooltip);
				if (position === 'left') expect(tip.x).toBeGreaterThanOrEqual(itemBox.x + itemBox.width);
				else expect(tip.x + tip.width).toBeLessThanOrEqual(itemBox.x);
				expect(tip.x).toBeGreaterThanOrEqual(0);
				expect(tip.x + tip.width).toBeLessThanOrEqual(viewport.width);
				const centreGap = Math.abs(tip.y + tip.height / 2 - (itemBox.y + itemBox.height / 2));
				expect(centreGap).toBeLessThanOrEqual(2);
				expect(await drawnAtItsCentre(tooltip)).toBe(true);

				// Sideways across the gap onto the tooltip (the hover bridge).
				await page.mouse.move(tip.x + tip.width / 2, tip.y + tip.height / 2, { steps: 12 });
				await expect(tooltip).toBeVisible();
				await page.mouse.move(viewport.width / 2, 200, { steps: 4 });
				await expect(tooltip).toBeHidden();
			}
		});

		test('a keyboard-shown tooltip still hides on Esc', async ({ page }) => {
			await gotoDashboard(page);
			await page.mouse.move(700, 200);
			const first = page.locator('.launcher a.launcher__link').first();
			for (let i = 0; i < 20; i++) {
				await page.keyboard.press('Tab');
				if (await first.evaluate((el) => el === document.activeElement)) break;
			}
			await expect(first).toBeFocused();
			const tooltip = first.locator('xpath=..').locator('.launcher__tooltip');
			await expect.poll(() => visibilityOf(tooltip)).toBe('visible');
			await page.keyboard.press('Escape');
			await expect.poll(() => visibilityOf(tooltip)).toBe('hidden');
			await expect(first).toBeFocused();
		});

		test('a toast does not overlap the bar', async ({ page }) => {
			await page.goto('/ui-demo');
			await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
			await page.getByRole('button', { name: '成功を表示' }).click();
			const toast = page.locator('.toast-host .toast').first();
			await expect(toast).toBeVisible();
			const t = await boxOf(toast);
			const bar = await boxOf(page.locator('.launcher__bar'));
			const overlaps =
				t.x < bar.x + bar.width &&
				bar.x < t.x + t.width &&
				t.y < bar.y + bar.height &&
				bar.y < t.y + t.height;
			expect(overlaps).toBe(false);
			if (position === 'right') expect(t.x + t.width).toBeLessThanOrEqual(bar.x);
		});

		test('<=900px: still the full-width bottom tab bar (D5)', async ({ page }) => {
			await page.setViewportSize({ width: 768, height: 1024 });
			await gotoDashboard(page);
			const bar = await boxOf(page.locator('.launcher__bar'));
			expect(bar.width).toBeGreaterThanOrEqual(768 - 1);
			expect(Math.round(bar.y + bar.height)).toBe(1024);
			const padding = await page.locator('main').evaluate((el) => {
				const style = getComputedStyle(el);
				return {
					left: Number.parseFloat(style.paddingLeft),
					right: Number.parseFloat(style.paddingRight),
					bottom: Number.parseFloat(style.paddingBottom)
				};
			});
			expect(padding.left).toBe(padding.right);
			expect(padding.bottom).toBeGreaterThanOrEqual(bar.height);
		});
	});
}

// Top bar (nav-launcher-plan.md §4.1, D4): below the header, which stays the
// top row; tooltips and magnification point down (the bottom bar mirrored).
test.describe('dock on the top edge (primed)', () => {
	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await primeLauncher(page, 'top');
	});

	test('sits centred below the header and the content starts below it', async ({ page }) => {
		await gotoDashboard(page);
		await expect(page.locator('.launcher--top')).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('data-banto-shell-launcher-position', 'top');
		const viewport = page.viewportSize();
		if (!viewport) throw new Error('no viewport');
		const header = await boxOf(page.locator('.main > header'));
		const bar = await boxOf(page.locator('.launcher__bar'));
		expect(bar.width).toBeGreaterThan(bar.height);
		expect(header.y).toBe(0);
		expect(bar.y).toBeGreaterThanOrEqual(header.y + header.height);
		expect(bar.y - (header.y + header.height)).toBeLessThan(20);
		expect(Math.abs(bar.x + bar.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
		const contentTop = await page.locator('main').evaluate((el) => {
			const rect = el.getBoundingClientRect();
			return rect.top + Number.parseFloat(getComputedStyle(el).paddingTop);
		});
		expect(contentTop).toBeGreaterThanOrEqual(bar.y + bar.height);
	});

	test('the tooltip shows below the item, unclipped, and stays across the gap', async ({
		page
	}) => {
		await gotoDashboard(page);
		const viewport = page.viewportSize();
		if (!viewport) throw new Error('no viewport');
		// The first and the last item: the edges of the scrolling track.
		const items = page.locator('.launcher [data-launcher-item]');
		for (const item of [items.first(), items.last()]) {
			const tooltip = tooltipOf(item);
			await item.hover();
			await expect(tooltip).toBeVisible();
			await expect.poll(() => visibilityOf(tooltip)).toBe('visible');
			const itemBox = await boxOf(item);
			const tip = await boxOf(tooltip);
			expect(tip.y).toBeGreaterThanOrEqual(itemBox.y + itemBox.height);
			expect(tip.x).toBeGreaterThanOrEqual(0);
			expect(tip.x + tip.width).toBeLessThanOrEqual(viewport.width);
			expect(await drawnAtItsCentre(tooltip)).toBe(true);

			// Down across the gap onto the tooltip (the hover bridge).
			await page.mouse.move(tip.x + tip.width / 2, tip.y + tip.height / 2, { steps: 12 });
			await expect(tooltip).toBeVisible();
			await page.mouse.move(viewport.width / 2, viewport.height - 100, { steps: 4 });
			await expect(tooltip).toBeHidden();
		}
	});

	test('magnifies downwards: the bar keeps its top edge', async ({ page }) => {
		// This suite reduces motion (no magnification); let it run here.
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await gotoDashboard(page);
		const before = await boxOf(page.locator('.launcher__bar'));
		const item = await boxOf(page.locator('.launcher [data-launcher-item]').first());
		await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2, { steps: 4 });
		await expect
			.poll(async () => (await boxOf(page.locator('.launcher__bar'))).height)
			.toBeGreaterThan(before.height);
		const after = await boxOf(page.locator('.launcher__bar'));
		expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
	});

	test('the user menu is drawn over the bar', async ({ page }) => {
		await gotoDashboard(page);
		await page.getByRole('button', { name: 'ユーザーメニューを開く' }).click();
		const logout = page.getByRole('menuitem', { name: 'ログアウト' });
		await expect(logout).toBeVisible();
		// The menu is a top-layer popover: whatever it overlaps, it is on top.
		const onTop = await logout.evaluate((el) => {
			const rect = el.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return hit !== null && el.contains(hit);
		});
		expect(onTop).toBe(true);
	});

	test('a toast does not overlap the bar', async ({ page }) => {
		await page.goto('/ui-demo');
		await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
		await page.getByRole('button', { name: '成功を表示' }).click();
		const toast = page.locator('.toast-host .toast').first();
		await expect(toast).toBeVisible();
		const t = await boxOf(toast);
		const bar = await boxOf(page.locator('.launcher__bar'));
		expect(t.y).toBeGreaterThanOrEqual(bar.y + bar.height);
	});

	test('<=900px: still the full-width bottom tab bar (D5)', async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 1024 });
		await gotoDashboard(page);
		const bar = await boxOf(page.locator('.launcher__bar'));
		expect(bar.width).toBeGreaterThanOrEqual(768 - 1);
		expect(Math.round(bar.y + bar.height)).toBe(1024);
		const padding = await page.locator('main').evaluate((el) => {
			const style = getComputedStyle(el);
			return {
				top: Number.parseFloat(style.paddingTop),
				bottom: Number.parseFloat(style.paddingBottom)
			};
		});
		expect(padding.top).toBeLessThan(bar.height);
		expect(padding.bottom).toBeGreaterThanOrEqual(bar.height);
	});

	test('kiosk: sits below the compact header', async ({ page }) => {
		await primeKiosk(page);
		await gotoDashboard(page);
		const header = await boxOf(page.locator('.main > header'));
		const bar = await boxOf(page.locator('.launcher__bar'));
		expect(bar.y).toBeGreaterThanOrEqual(header.y + header.height);
		expect(bar.y - (header.y + header.height)).toBeLessThan(20);
	});
});

test('settings: choosing Dock shows the opacity slider, which applies live; Sidebar puts it back', async ({
	page
}) => {
	await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();
	const group = page.getByRole('radiogroup', { name: 'ナビゲーションの表示形式' });
	await expect(group).toBeVisible();
	await expect(page.getByRole('slider', { name: /ドックの不透明度/ })).toHaveCount(0);

	await group.getByText('ドック', { exact: true }).click();
	await expect(page.locator('.launcher')).toBeVisible();
	await expect(page.locator('aside')).toHaveCount(0);
	await expect(page.locator('html')).toHaveAttribute('data-banto-shell-nav', 'launcher');

	const slider = page.getByRole('slider', { name: /ドックの不透明度/ });
	await expect(slider).toHaveValue('50');
	await slider.fill('80');
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.documentElement.style.getPropertyValue('--banto-shell-launcher-opacity')
			)
		)
		.toBe('80%');
	await expect(page.locator('.launcher-preview')).toHaveAttribute(
		'style',
		/--banto-shell-launcher-opacity:\s*80%/
	);
	await expect(page.getByText('80%', { exact: true })).toBeVisible();

	// Kept across a reload (cache + demo provider).
	await page.reload();
	await expect(page.locator('.launcher')).toBeVisible();
	await expect(slider).toHaveValue('80');

	// The edge (D4): a radiogroup shown only for the dock, keyboard-operable.
	const positions = page.getByRole('radiogroup', { name: 'ドックの位置' });
	await expect(positions.getByRole('radio', { name: '下' })).toBeChecked();
	await positions.getByText('右', { exact: true }).click();
	await expect(page.locator('.launcher--right')).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('data-banto-shell-launcher-position', 'right');
	await positions.getByRole('radio', { name: '右' }).focus();
	await page.keyboard.press('ArrowUp');
	await expect(positions.getByRole('radio', { name: '左' })).toBeChecked();
	await expect(page.locator('.launcher--left')).toBeVisible();
	await page.reload();
	await expect(page.locator('.launcher--left')).toBeVisible();
	await positions.getByText('下', { exact: true }).click();
	await expect(page.locator('.launcher--bottom')).toBeVisible();

	await page
		.getByRole('radiogroup', { name: 'ナビゲーションの表示形式' })
		.getByText('サイドバー', { exact: true })
		.click();
	await expect(page.locator('.launcher')).toHaveCount(0);
	await expect(page.locator('aside')).toBeVisible();
	await expect(page.locator('html')).not.toHaveAttribute('data-banto-shell-nav', 'launcher');
	await expect(page.locator('html')).not.toHaveAttribute('data-banto-shell-launcher-position');
});

// #428 review: under glass the surfaces are already translucent, so the
// tab bar mixes an opaque base (`--banto-shell-launcher-tabbar-base`) - the
// 85% floor must hold there too, not drop to ~0.43-0.53.
test.describe('dock tab bar floor under glass', () => {
	for (const theme of ['light', 'dark'] as const) {
		test(`<=900px ${theme}-glass: the tab bar is still at least 85% opaque`, async ({ page }) => {
			await primeThemeAndAuth(page, { theme, preset: 'glass' });
			await primeLauncher(page);
			await page.setViewportSize({ width: 768, height: 1024 });
			await gotoDashboard(page);
			const alpha = await page.locator('.launcher__bar').evaluate((el) => {
				const colour = getComputedStyle(el, '::before').backgroundColor;
				const match =
					/\/\s*([\d.]+)\s*\)$/.exec(colour) ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(colour);
				return match ? Number(match[1]) : 1;
			});
			expect(alpha).toBeGreaterThanOrEqual(0.85 - 0.005);
		});
	}
});
