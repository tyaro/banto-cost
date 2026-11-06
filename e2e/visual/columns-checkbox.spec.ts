/** Column checkboxes share native field sizing and keep the last-column lock. */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

for (const [index, locale] of ['ja', 'en'].entries()) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	test(`column checkboxes preserve keyboard interaction and the last visible column (${locale})`, async ({
		page
	}) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
		await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
		await page.goto('/items');
		const trigger = page.locator('.columns-menu .trigger');
		await trigger.focus();
		await trigger.press('Enter');
		await trigger.press('Tab');
		const menu = page.getByRole('dialog', { name: copy['grid.columnsMenuTitle'] });
		const boxes = menu.getByRole('checkbox');
		expect(await boxes.count()).toBeGreaterThan(2);
		const first = boxes.first();
		await expect(first).toBeFocused();
		await expect(first).toHaveCSS('outline-style', 'solid');
		const size = await first.evaluate((element) => ({
			checkbox: element.getBoundingClientRect().width,
			expected: parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.1,
			target: element.closest('label')!.getBoundingClientRect().height
		}));
		expect(size.checkbox).toBeCloseTo(size.expected, 1);
		expect(size.target).toBeGreaterThanOrEqual(28);
		for (const box of (await boxes.all()).slice(0, -1)) await box.uncheck();
		await expect(boxes.last()).toBeChecked();
		await expect(boxes.last()).toBeDisabled();
		await expect(boxes.last()).toHaveCSS('opacity', '0.5');
		await page.emulateMedia({ forcedColors: 'active' });
		await first.focus();
		await first.press('Space');
		await expect(first).toHaveCSS('outline-style', 'solid');
		await expect(first).toHaveCSS('outline-width', '2px');
		await expect(first).toBeChecked();
		await expect(boxes.last()).toBeEnabled();
		await first.press('Escape');
		await expect(menu).toHaveCount(0);
	});
}
