/** Current-password autofill is authentication, not a replacement-password draft. */
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

	test(`only replacement password input marks the account form unsaved (${locale})`, async ({
		page
	}) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
		await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
		await page.goto('/settings/account');
		const current = page.getByLabel(copy['settings.currentPassword']);
		const next = page.getByLabel(copy['common.newPasswordMinLabel']);
		const confirmation = page.getByLabel(copy['settings.newPasswordConfirm']);
		const notice = page.getByText(copy['unsaved.notice'], { exact: true });
		const categories = page.getByRole('navigation', { name: copy['settings.sectionNavAria'] });
		for (const field of [current, next, confirmation]) {
			await field.focus();
			await field.blur();
			await expect(notice).toHaveCount(0);
		}

		// Model a password manager updating the bound value. This does not
		// claim coverage of a particular browser's native password manager.
		await current.evaluate((element: HTMLInputElement) => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
			setter.call(element, 'saved-credential');
			element.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await expect(current).toHaveValue('saved-credential');
		await expect(notice).toHaveCount(0);
		const dialogs: string[] = [];
		page.on('dialog', async (dialog) => {
			dialogs.push(dialog.message());
			await dialog.dismiss();
		});
		await categories.getByRole('link', { name: copy['settings.sectionAppearance'] }).click();
		await expect(page).toHaveURL(/\/settings\/appearance$/);
		expect(dialogs).toEqual([]);
		await categories.getByRole('link', { name: copy['settings.sectionAccount'] }).click();
		await expect(page).toHaveURL(/\/settings\/account$/);
		await current.fill('saved-credential');

		// Either replacement field alone is valuable draft input. Clearing
		// both makes the form clean even while current credentials remain.
		for (const field of [next, confirmation]) {
			const expectedDialogs = dialogs.length + 1;
			await field.fill('draft-password');
			await expect(notice).toBeVisible();
			await categories.getByRole('link', { name: copy['settings.sectionAppearance'] }).click();
			await expect.poll(() => dialogs.length).toBe(expectedDialogs);
			await expect(page).toHaveURL(/\/settings\/account$/);
			await expect(field).toHaveValue('draft-password');
			await field.fill('');
			await expect(notice).toHaveCount(0);
			await expect(current).toHaveValue('saved-credential');
		}
		expect(dialogs).toEqual([copy['unsaved.confirmLeave'], copy['unsaved.confirmLeave']]);
		await categories.getByRole('link', { name: copy['settings.sectionAppearance'] }).click();
		await expect(page).toHaveURL(/\/settings\/appearance$/);
		expect(dialogs).toHaveLength(2);
	});
}
