/** Column filters retain native controls and own only their opening/closing focus. */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

async function expectSolidFocus(control: Locator) {
	await expect(control).toBeFocused();
	await expect(control).toHaveCSS('outline-style', 'solid');
	expect(
		await control.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth))
	).toBeGreaterThan(0);
}

for (const [index, locale] of ['ja', 'en'].entries()) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	for (const mode of ['Client', 'Server']) {
		test(`grid range and filter names, focus and native keys (${locale}, ${mode})`, async ({
			page
		}, testInfo) => {
			await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
			await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
			await page.goto('/items');
			const modeButton = page.getByRole('button', { name: copy[`items.mode${mode}`], exact: true });
			await modeButton.click();
			const grid = page.getByRole('grid');
			const firstName = grid.locator('[data-cell-row="0"][data-cell-field="name"]');
			const originalName = (await firstName.innerText()).trim();
			await firstName.click();
			await page.keyboard.press('Shift+ArrowRight');
			await page.keyboard.press('Shift+ArrowDown');
			await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(4);
			await expectSolidFocus(grid);
			const scrollBefore = await grid.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
			await page.emulateMedia({ forcedColors: 'active' });
			const range = grid.locator('.cell.in-range');
			await expect(range).toHaveCount(3);
			for (const cell of await range.all()) {
				await expect(cell).toHaveCSS('outline-style', 'dashed');
				expect(
					await cell.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth))
				).toBeGreaterThan(0);
			}
			await expect(grid.locator('.cell.active')).toHaveCSS('outline-style', 'solid');
			await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(4);
			expect(await grid.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }))).toEqual(
				scrollBefore
			);
			await grid.screenshot({ path: testInfo.outputPath('range-forced-colors.png') });
			await page.emulateMedia({ forcedColors: 'none' });

			const header = grid.getByRole('columnheader').filter({ hasText: copy['items.fieldName'] });
			await header.locator('.cell-body').focus();
			await expectSolidFocus(header.locator('.cell-body'));
			await page.keyboard.press('Tab');
			const label = copy['grid.filterAriaLabel'].replace('{header}', copy['items.fieldName']);
			const trigger = grid.getByRole('button', { name: label, exact: true });
			await expectSolidFocus(trigger);
			await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
			await expect(trigger).toHaveAttribute('aria-expanded', 'false');
			await expect(trigger).not.toHaveAttribute('aria-controls');
			await trigger.press('Enter');
			const dialog = grid.getByRole('dialog', { name: label, exact: true });
			const input = dialog.getByRole('textbox', {
				name: copy['grid.filterValueLabel'],
				exact: true
			});
			const operator = dialog.getByRole('combobox', {
				name: copy['grid.filterOperatorLabel'],
				exact: true
			});
			await expectSolidFocus(input);
			await expect(trigger).toHaveAttribute('aria-expanded', 'true');
			const dialogId = await trigger.getAttribute('aria-controls');
			expect(dialogId).toBeTruthy();
			await expect(dialog).toHaveAttribute('id', dialogId!);
			const scan = await new AxeBuilder({ page })
				.include('[role="grid"]')
				.withTags(['wcag2a', 'wcag2aa'])
				.analyze();
			expect(scan.violations).toEqual([]);

			await input.press('Shift+Tab');
			await expectSolidFocus(operator);
			await operator.press('ArrowDown');
			await expect(operator).toHaveValue('starts_with');
			await operator.press('Tab');
			await expect(input).toBeFocused();
			await input.fill(originalName);
			await input.press('Home');
			await input.press('ArrowRight');
			expect(await input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(1);
			await input.press('Tab');
			await expectSolidFocus(
				dialog.getByRole('button', { name: copy['grid.filterApply'], exact: true })
			);
			expect(
				await dialog
					.getByRole('button', { name: copy['grid.filterApply'], exact: true })
					.evaluate((el) => {
						const style = getComputedStyle(el);
						return style.outlineColor !== style.backgroundColor;
					})
			).toBe(true);
			await page.keyboard.press('Tab');
			await expectSolidFocus(
				dialog.getByRole('button', { name: copy['grid.filterClear'], exact: true })
			);
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expectSolidFocus(trigger);

			await trigger.press('Enter');
			await expect(input).toHaveValue('');
			await operator.selectOption('eq');
			await input.fill(originalName);
			await input.press('Enter');
			await expect(dialog).toHaveCount(0);
			await expect(trigger).toBeFocused();
			await expect(trigger).toHaveClass(/active/);
			await expect(firstName).toHaveText(originalName);
			await trigger.press('Enter');
			await expect(input).toHaveValue(originalName);
			await expect(operator).toHaveValue('eq');
			await dialog.getByRole('button', { name: copy['grid.filterClear'], exact: true }).click();
			await expect(dialog).toHaveCount(0);
			await expect(trigger).toBeFocused();
			await expect(trigger).not.toHaveClass(/active/);

			await trigger.click();
			await expect(input).toBeFocused();
			await modeButton.focus();
			await modeButton.press('Escape');
			await expect(modeButton).toBeFocused();
			await expect(dialog).toBeVisible();
			await trigger.click();
			await expect(dialog).toHaveCount(0);
			await expect(trigger).toHaveAttribute('aria-expanded', 'false');
			await expect(trigger).not.toHaveAttribute('aria-controls');
			await trigger.click();
			await expect(input).toBeFocused();
			await modeButton.click();
			await expect(dialog).toHaveCount(0);
			await expect(modeButton).toBeFocused();

			await trigger.click();
			const priceLabel = copy['grid.filterAriaLabel'].replace('{header}', copy['items.fieldPrice']);
			const priceTrigger = grid.getByRole('button', { name: priceLabel, exact: true });
			await priceTrigger.click();
			await expect(dialog).toHaveCount(0);
			const priceDialog = grid.getByRole('dialog', { name: priceLabel, exact: true });
			const priceInput = priceDialog.getByRole('spinbutton', {
				name: copy['grid.filterValueLabel'],
				exact: true
			});
			await expect(priceInput).toBeFocused();
			expect(await priceTrigger.getAttribute('aria-controls')).not.toBe(dialogId);
			await priceDialog
				.getByRole('combobox', { name: copy['grid.filterOperatorLabel'], exact: true })
				.selectOption('gte');
			await priceInput.fill('0');
			await priceInput.press('Enter');
			await expect(priceTrigger).toBeFocused();
			await priceTrigger.press('Enter');
			await expect(priceInput).toHaveValue('0');
			await priceInput.fill('');
			await priceInput.press('Enter');
			await expect(priceDialog).toHaveCount(0);
			await expect(priceTrigger).toBeFocused();
			await expect(priceTrigger).not.toHaveClass(/active/);
			await expect(firstName).toBeVisible();

			await trigger.press('Enter');
			await expect(input).toBeFocused();
			await page.emulateMedia({ forcedColors: 'active' });
			await expectSolidFocus(input);
			await input.press('Shift+Tab');
			await expectSolidFocus(operator);
			await operator.press('Shift+Tab');
			await expectSolidFocus(trigger);
			await expect(dialog).toBeVisible();
			await trigger.press('Tab');
			await expectSolidFocus(operator);
			await operator.press('Tab');
			await expectSolidFocus(input);
			await input.press('Tab');
			await expectSolidFocus(
				dialog.getByRole('button', { name: copy['grid.filterApply'], exact: true })
			);
			await page.keyboard.press('Tab');
			await expectSolidFocus(
				dialog.getByRole('button', { name: copy['grid.filterClear'], exact: true })
			);
			await page.keyboard.press('Escape');
			await expect(trigger).toBeFocused();
			await expect(dialog).toHaveCount(0);
			await expect(grid.locator('.cell-editor')).toHaveCount(0);
		});
	}
}
