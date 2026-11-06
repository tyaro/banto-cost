/** Inline editors expose their column name and associate validation errors with the control. */
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
	for (const mode of ['Client', 'Server']) {
		test(`inline grid editors preserve names, errors and correction (${locale}, ${mode})`, async ({
			page
		}) => {
			await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
			await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
			await page.goto('/items');
			await page.getByRole('button', { name: copy[`items.mode${mode}`], exact: true }).click();
			const grid = page.getByRole('grid');
			const priceCell = grid.locator('[data-cell-row="0"][data-cell-field="price"]');
			await priceCell.dblclick();
			const price = grid.getByRole('spinbutton', { name: copy['items.fieldPrice'], exact: true });
			await expect(price).toBeFocused();
			await expect(price).toHaveAttribute('aria-invalid', 'false');
			await expect(priceCell).toHaveAttribute('aria-busy', 'false');
			const original = Number(await price.inputValue());
			await price.fill('-1');
			await price.press('Enter');
			await expect(price).toHaveAttribute('aria-invalid', 'true');
			const errorId = await price.getAttribute('aria-describedby');
			expect(errorId).toBeTruthy();
			const error = page.locator(`[id="${errorId}"]`);
			await expect(error).toHaveAttribute('role', 'alert');
			await expect(error).toBeVisible();
			await expect(price).toHaveAccessibleDescription(await error.innerText());
			const errorRegion = page.getByRole('region', {
				name: copy['grid.inlineEditErrorLabel'].replace('{header}', copy['items.fieldPrice']),
				exact: true
			});
			await expect(errorRegion).toBeVisible();
			await price.press('Tab');
			await expect(errorRegion).toBeFocused();
			await errorRegion.press('Escape');
			await expect(price).toBeFocused();
			await price.blur();
			await price.focus();
			await expect(price).toHaveAccessibleDescription(await error.innerText());
			const scan = await new AxeBuilder({ page })
				.include('[role="grid"]')
				.withTags(['wcag2a', 'wcag2aa'])
				.analyze();
			expect(scan.violations).toEqual([]);

			await price.fill(String(original + 1));
			await price.press('Enter');
			await expect(grid.locator('.cell-editor')).toHaveCount(0);
			await expect(error).toHaveCount(0);
			await expect(grid).toBeFocused();
			await priceCell.dblclick();
			await expect(price).toHaveValue(String(original + 1));
			await expect(price).toHaveAttribute('aria-invalid', 'false');
			await expect(price).not.toHaveAttribute('aria-describedby');
			await price.press('Escape');

			await grid.locator('[data-cell-row="0"][data-cell-field="name"]').dblclick();
			const name = grid.getByRole('textbox', { name: copy['items.fieldName'], exact: true });
			await expect(name).toBeFocused();
			await name.fill('');
			await name.press('Enter');
			await expect(name).toHaveAttribute('aria-invalid', 'true');
			await expect(name).toHaveAccessibleDescription(/.+/);
			await name.press('Escape');
			await expect(grid.getByRole('alert')).toHaveCount(0);
			await expect(grid).toBeFocused();
		});
	}
}
