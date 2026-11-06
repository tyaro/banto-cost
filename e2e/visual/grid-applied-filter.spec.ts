/** Applied state is distinct from expanded state, including without author colors. */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

async function dimensions(header: Locator) {
	return header.evaluate((el) => {
		const button = el.querySelector('.filter-button')!.getBoundingClientRect();
		const label = el.querySelector('.label')!.getBoundingClientRect();
		return {
			width: el.getBoundingClientRect().width,
			buttonWidth: button.width,
			buttonHeight: button.height,
			labelWidth: label.width
		};
	});
}

for (const [index, locale] of ['ja', 'en'].entries()) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	for (const mode of ['Client', 'Server']) {
		test(`applied filters retain a mark, description and layout (${locale}, ${mode})`, async ({
			page
		}, testInfo) => {
			await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
			await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
			await page.goto('/items');
			const modeButton = page.getByRole('button', { name: copy[`items.mode${mode}`], exact: true });
			await modeButton.click();
			const grid = page.getByRole('grid');
			const header = grid.getByRole('columnheader').filter({ hasText: copy['items.fieldName'] });
			const label = copy['grid.filterAriaLabel'].replace('{header}', copy['items.fieldName']);
			const description = copy['grid.filterAppliedDescription'].replace(
				'{header}',
				copy['items.fieldName']
			);
			const trigger = grid.getByRole('button', { name: label, exact: true });
			const original = (
				await grid.locator('[data-cell-row="0"][data-cell-field="name"]').innerText()
			).trim();
			const before = await dimensions(header);
			await expect(trigger).toHaveAttribute('aria-expanded', 'false');
			await expect(trigger).not.toHaveAttribute('aria-describedby');
			await expect(trigger).not.toHaveAttribute('aria-pressed');
			await expect(trigger).toHaveCSS('text-decoration-line', 'none');
			await trigger.press('Enter');
			const dialog = grid.getByRole('dialog', { name: label, exact: true });
			const value = dialog.getByRole('textbox', {
				name: copy['grid.filterValueLabel'],
				exact: true
			});
			await expect(trigger).toHaveAttribute('aria-expanded', 'true');
			await value.fill(original);
			await expect(trigger).not.toHaveAttribute('aria-describedby');
			await expect(trigger).toHaveCSS('text-decoration-line', 'none');
			await value.press('Escape');
			await expect(trigger).toHaveAttribute('aria-expanded', 'false');
			await expect(trigger).not.toHaveAttribute('aria-describedby');
			await trigger.press('Enter');
			await expect(value).toHaveValue('');
			await value.fill(original);
			await value.press('Enter');
			await expect(dialog).toHaveCount(0);
			await expect(trigger).toBeFocused();
			await expect(trigger).toHaveAccessibleName(label);
			await expect(trigger).toHaveAccessibleDescription(description);
			await expect(trigger).toHaveAttribute('title', description);
			await expect(trigger).toHaveAttribute('aria-expanded', 'false');
			await expect(trigger).toHaveCSS('text-decoration-line', 'underline');
			await expect(trigger).toHaveCSS('text-decoration-style', 'double');
			expect(await dimensions(header)).toEqual(before);
			const appliedMarkup = await header.evaluate((el) => el.outerHTML);
			const descriptionId = await trigger.getAttribute('aria-describedby');
			expect(descriptionId).toBeTruthy();
			const hiddenDescription = page.locator(`[id="${descriptionId}"]`);
			await expect(hiddenDescription).toHaveAttribute('hidden', '');
			await expect(hiddenDescription).toHaveText(description);

			await modeButton.focus();
			await page.emulateMedia({ forcedColors: 'active' });
			await expect(trigger).toHaveCSS('text-decoration-line', 'underline');
			await expect(trigger).toHaveCSS('text-decoration-style', 'double');
			expect(
				await trigger.evaluate((el) => parseFloat(getComputedStyle(el).textDecorationThickness))
			).toBeGreaterThan(0);
			await grid
				.locator('.header-row')
				.screenshot({ path: testInfo.outputPath('applied-filter-forced-colors.png') });
			await trigger.focus();
			await expect(trigger).toHaveCSS('outline-style', 'solid');
			await expect(trigger).toHaveCSS('text-decoration-style', 'double');
			await trigger.press('Enter');
			await expect(trigger).toHaveAttribute('aria-expanded', 'true');
			await expect(trigger).toHaveAttribute('aria-describedby', descriptionId!);
			await expect(trigger).toHaveAccessibleDescription(description);
			await expect(value).toHaveValue(original);
			await value.fill('Unsaved draft');
			await value.press('Escape');
			await expect(trigger).toHaveAccessibleDescription(description);
			await trigger.press('Enter');
			await expect(value).toHaveValue(original);
			await dialog.getByRole('button', { name: copy['grid.filterClear'], exact: true }).click();
			await expect(trigger).toBeFocused();
			await expect(trigger).not.toHaveAttribute('aria-describedby');
			await expect(trigger).not.toHaveAttribute('title');
			await expect(trigger).toHaveCSS('text-decoration-line', 'none');
			await expect(hiddenDescription).toHaveCount(0);
			expect(await dimensions(header)).toEqual(before);
			await page.emulateMedia({ forcedColors: 'none' });

			const priceLabel = copy['grid.filterAriaLabel'].replace('{header}', copy['items.fieldPrice']);
			const priceTrigger = grid.getByRole('button', { name: priceLabel, exact: true });
			await priceTrigger.click();
			const priceDialog = grid.getByRole('dialog', { name: priceLabel, exact: true });
			const price = priceDialog.getByRole('spinbutton', {
				name: copy['grid.filterValueLabel'],
				exact: true
			});
			await price.fill('0');
			await price.press('Enter');
			await expect(priceTrigger).toHaveAccessibleDescription(
				copy['grid.filterAppliedDescription'].replace('{header}', copy['items.fieldPrice'])
			);
			await priceTrigger.press('Enter');
			await expect(price).toHaveValue('0');
			await price.fill('');
			await price.press('Enter');
			await expect(priceTrigger).not.toHaveAttribute('aria-describedby');
			await expect(priceTrigger).toHaveCSS('text-decoration-line', 'none');
			const scan = await new AxeBuilder({ page })
				.include('[role="grid"]')
				.withTags(['wcag2a', 'wcag2aa'])
				.analyze();
			expect(scan.violations).toEqual([]);

			// Appearance-only probes use the actual rendered/scoped header markup.
			// They compare active/inactive dimensions at a narrow width without changing grid state.
			await page.setViewportSize({ width: 320, height: 900 });
			await page.evaluate((markup) => {
				document.documentElement.style.fontSize = '200%';
				const probe = document.createElement('div');
				probe.id = 'filter-appearance-probe';
				probe.setAttribute('aria-hidden', 'true');
				Object.assign(probe.style, {
					position: 'fixed',
					top: '10px',
					left: '10px',
					zIndex: '2000',
					fontSize: '0.875rem',
					background: 'var(--banto-surface)'
				});
				const template = document.createElement('template');
				template.innerHTML = markup;
				const active = template.content.firstElementChild as HTMLElement;
				active.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
				active
					.querySelectorAll('[aria-describedby]')
					.forEach((el) => el.removeAttribute('aria-describedby'));
				Object.assign(active.style, { width: '80px', height: '60px' });
				const inactive = active.cloneNode(true) as HTMLElement;
				inactive.querySelector('.filter-button')!.classList.remove('active');
				probe.append(active, inactive);
				document.body.append(probe);
			}, appliedMarkup);
			const probes = page.locator('#filter-appearance-probe .header-cell');
			expect(await dimensions(probes.nth(0))).toEqual(await dimensions(probes.nth(1)));
			for (const colors of ['none', 'active'] as const) {
				await page.emulateMedia({ forcedColors: colors });
				await expect(probes.nth(0).locator('.filter-button')).toHaveCSS(
					'text-decoration-style',
					'double'
				);
				await expect(probes.nth(1).locator('.filter-button')).toHaveCSS(
					'text-decoration-line',
					'none'
				);
			}
			await page
				.locator('#filter-appearance-probe')
				.screenshot({ path: testInfo.outputPath('applied-filter-narrow-200.png') });
			await page.locator('#filter-appearance-probe').evaluate((el) => el.remove());
		});
	}
}
