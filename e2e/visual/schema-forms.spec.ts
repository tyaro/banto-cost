/** Exercise the actual schema renderer and its scoped CSS with theme styling. */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

for (const [index, locale] of ['ja', 'en'].entries()) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	test(`item schema form keeps labels, errors and numeric styles (${locale})`, async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
		await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
		await page.goto('/items/new');
		const form = page.locator('form');
		const name = form.getByLabel(copy['items.fieldName']);
		const price = form.getByRole('spinbutton', { name: copy['items.fieldPrice'] });
		await expect(name).toBeVisible();
		await expect(name).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await name.hover();
		await expect(name).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(form.locator('.banto-field-control')).toHaveCount(4);
		await expect(price).toHaveCSS('border-bottom-width', '2px');
		await expect(price).toHaveCSS('font-variant-numeric', 'tabular-nums');
		await form.getByRole('button', { name: copy['common.save'], exact: true }).click();
		await expect(name).toHaveAttribute('aria-invalid', 'true');
		const errorId = await name.getAttribute('aria-describedby');
		expect(errorId).toBeTruthy();
		const error = page.locator(`[id="${errorId}"]`);
		await expect(error).toBeVisible();
		expect(await error.evaluate((element) => element.closest('label'))).toBeNull();
		await name.fill('Example');
		await expect(name).not.toHaveAttribute('aria-describedby');
		await expect(error).toHaveCount(0);
		await price.fill('12');
		await form.getByRole('spinbutton', { name: copy['items.fieldStock'] }).fill('2');
		const date = form.getByLabel(copy['items.fieldUpdatedAt']);
		await expect(date).toHaveJSProperty('readOnly', true);
		await expect(date).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(date).toBeEnabled();
		await date.focus();
		await expect(date).toBeFocused();
		await expect(date).toHaveCSS('outline-style', 'solid');

		await page.setViewportSize({ width: 320, height: 700 });
		await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
		for (const control of await form.locator('.banto-field-control').all()) {
			const bounds = await control.evaluate((element) => ({
				labelBottom: element.nextElementSibling!.getBoundingClientRect().bottom,
				valueTop:
					element.getBoundingClientRect().top + parseFloat(getComputedStyle(element).paddingTop)
			}));
			expect(bounds.labelBottom).toBeLessThan(bounds.valueTop);
		}
		for (const action of await form.locator('.footer > button, .footer > a.banto-btn').all()) {
			const fits = await action.evaluate((element) => ({
				width: element.scrollWidth <= element.clientWidth,
				height: element.scrollHeight <= element.clientHeight
			}));
			expect(fits).toEqual({ width: true, height: true });
		}
		await page.emulateMedia({ forcedColors: 'active' });
		await price.focus();
		await expect(price).toHaveCSS('outline-style', 'solid');
		await page.emulateMedia({ forcedColors: 'none' });
		const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
		expect(results.violations).toEqual([]);
	});
}
