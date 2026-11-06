/**
 * Sidebar toggle. Above 900px the ONE fold button is the first control of the
 * sidebar's top row, left of the logo (the header no longer carries it); at
 * <=900px the header's button opens/closes the drawer. Same `visual` project as
 * the other specs here (vite preview, browser demo mode).
 */
import { expect, test, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeKiosk, primeThemeAndAuth } from './theme';

async function gotoDashboard(page: Page): Promise<void> {
	await page.goto('/dashboard');
	await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}

test.describe('sidebar toggle', () => {
	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
	});

	test('>900px: the button left of the logo folds / unfolds the sidebar, in place', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await gotoDashboard(page);
		const aside = page.locator('#app-sidebar');
		const collapse = aside.getByRole('button', { name: 'サイドバーをたたむ' });
		await expect(collapse).toHaveAttribute('aria-expanded', 'true');
		await expect(collapse).toHaveAttribute('aria-controls', 'app-sidebar');
		const wide = (await aside.boundingBox())!.width;
		const spot = (await collapse.boundingBox())!;

		// Left of the logo, and the header no longer has a toggle.
		const logo = (await aside.locator('.brand-mark').boundingBox())!;
		expect(spot.x + spot.width).toBeLessThanOrEqual(logo.x);
		await expect(page.locator('header').getByRole('button', { name: /サイドバー/ })).toHaveCount(0);

		await collapse.click();
		const expand = aside.getByRole('button', { name: 'サイドバーを開く' });
		await expect(expand).toHaveAttribute('aria-expanded', 'false');
		await expect.poll(async () => (await aside.boundingBox())!.width).toBeLessThan(wide);
		// Folded: only the button stays in the top row (logo hidden), in the same place,
		// and it keeps focus.
		await expect(aside.getByText('Banto', { exact: true })).toBeHidden();
		await expect(expand).toBeFocused();
		await expect.poll(async () => await expand.boundingBox()).toEqual(spot);

		await expand.click();
		await expect(aside.getByRole('button', { name: 'サイドバーをたたむ' })).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		await expect.poll(async () => (await aside.boundingBox())!.width).toBe(wide);
		await expect(aside.getByText('Banto', { exact: true })).toBeVisible();

		// The logo is not a control: pressing it changes nothing.
		await aside.locator('.brand-mark').click({ force: true });
		expect((await aside.boundingBox())!.width).toBe(wide);
		await expect(aside.getByRole('button')).toHaveCount(1);
	});

	test('<=900px: the same button opens / closes the drawer, Esc closes it', async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 900 });
		await gotoDashboard(page);
		const aside = page.locator('#app-sidebar');
		const header = page.locator('header');
		// Only the header's drawer button exists here; the sidebar's fold button is not rendered.
		await expect(aside.getByRole('button')).toHaveCount(0);
		const open = header.getByRole('button', { name: 'サイドバーを開く' });
		await expect(open).toHaveAttribute('aria-expanded', 'false');
		await expect(aside).not.toHaveClass(/overlay-open/);

		await open.click();
		await expect(aside).toHaveClass(/overlay-open/);
		const close = header.getByRole('button', { name: 'サイドバーを閉じる' });
		await expect(close).toHaveAttribute('aria-expanded', 'true');

		// The drawer (z-index above the header) covers the button, as the old
		// hamburger was: pointer users close via the backdrop, keyboard users
		// via the still-focused button.
		await close.focus();
		await page.keyboard.press('Enter');
		await expect(aside).not.toHaveClass(/overlay-open/);
		await expect(open).toHaveAttribute('aria-expanded', 'false');

		await open.click();
		await expect(aside).toHaveClass(/overlay-open/);
		await page.keyboard.press('Escape');
		await expect(aside).not.toHaveClass(/overlay-open/);
	});

	test('keyboard: the fold button is the first focusable control of the sidebar', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await gotoDashboard(page);
		const first = page.locator('#app-sidebar').locator('a, button, [tabindex]').first();
		await expect(first).toHaveAccessibleName('サイドバーをたたむ');
		await first.focus();
		await expect(first).toBeFocused();
	});

	test('kiosk (folded by default) keeps the button in the sidebar top row', async ({ page }) => {
		await primeKiosk(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await gotoDashboard(page);
		await expect(
			page.locator('#app-sidebar').getByRole('button', { name: 'サイドバーを開く' })
		).toBeVisible();
	});
});
