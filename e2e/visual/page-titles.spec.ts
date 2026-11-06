/** The shell supplies visible titles; content keeps its accessible document heading. */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DIAGONAL_MATRIX, primeKiosk, primeThemeAndAuth } from './theme';

for (const [index, locale] of ['ja', 'en'].entries()) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	const resource = copy['customers.resourceLabel'];
	const pages = [
		['/dashboard', copy['nav.dashboard']],
		['/customers', copy['nav.customers'], resource],
		['/customers/new', copy['customers.createTitle'].replace('{resource}', resource)],
		['/customers/1', copy['customers.editTitle'].replace('{resource}', resource)],
		['/users', copy['nav.users']],
		['/audit-log', copy['nav.auditLog']],
		['/ui-demo', copy['nav.uiDemo']],
		['/settings/account', copy['nav.settings']]
	];

	test(`shell title is visible and duplicate content title takes no space (${locale})`, async ({
		page
	}) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
		await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
		for (const width of [1440, 390]) {
			await page.setViewportSize({ width, height: 900 });
			for (const [path, title, contentTitle = title] of pages) {
				await page.goto(path);
				await expect(page.locator('.page-title')).toHaveText(title);
				await expect(page.locator('.page-title')).toBeVisible();
				const heading = page
					.getByRole('main')
					.getByRole('heading', { name: contentTitle, level: 1, exact: true });
				await expect(heading).toHaveCount(1);
				await expect(heading).toHaveCSS('position', 'absolute');
				await expect(heading).toHaveCSS('clip-path', 'inset(50%)');
			}
		}
		await expect(page.getByLabel(copy['settings.currentPassword'])).toBeVisible();
		await page.goto('/customers');
		await expect(
			page.getByRole('button', { name: copy['customers.create'], exact: true })
		).toBeVisible();
		await page.goto('/customers/new');
		await expect(page.getByRole('main').locator('.page-header')).toHaveCount(0);
		await expect(page.getByLabel(copy['customers.fieldName'])).toBeVisible();
		await primeKiosk(page);
		await page.goto('/dashboard');
		await expect(page.locator('.page-title')).toBeVisible();
	});
}
