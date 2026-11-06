/** Synthetic IME/handled key events must not run the grid's filter commands. */
import { readFileSync } from 'node:fs';
import { expect, test, type Locator } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

type Owner = 'composing' | 'legacy' | 'handled';

async function dispatchOwnedKey(control: Locator, key: string, owner: Owner) {
	return control.evaluate(
		(el, { key, owner }) => {
			const event = new KeyboardEvent('keydown', {
				key,
				code: key,
				isComposing: owner === 'composing',
				keyCode: owner === 'legacy' ? 229 : 0,
				bubbles: true,
				cancelable: true
			});
			if (owner === 'handled') event.preventDefault();
			let bubbled = false;
			const record = () => {
				bubbled = true;
			};
			// Svelte handles delegated events above the grid DOM node. Observe
			// propagation beyond that root rather than a raw listener below it.
			window.addEventListener('keydown', record);
			try {
				el.dispatchEvent(event);
			} finally {
				window.removeEventListener('keydown', record);
			}
			return { prevented: event.defaultPrevented, bubbled, legacy: event.keyCode };
		},
		{ key, owner }
	);
}

for (const [index, locale] of ['ja', 'en'].entries()) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	test(`IME and handled keys do not apply or close a column filter (${locale})`, async ({
		page
	}) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
		await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
		// banto-cost: the template also drove an inline cell editor on the items
		// page; the project ledger grid is read-only, so only the filter half stays.
		await page.goto('/projects');
		const grid = page.getByRole('grid');
		const cell = grid.locator('[data-cell-row="0"][data-cell-field="name"]');
		const name = (await cell.innerText()).trim();

		const label = copy['grid.filterAriaLabel'].replace('{header}', copy['projects.fieldName']);
		const trigger = grid.getByRole('button', { name: label, exact: true });
		await trigger.click();
		const dialog = grid.getByRole('dialog', { name: label, exact: true });
		const value = dialog.getByRole('textbox', {
			name: copy['grid.filterValueLabel'],
			exact: true
		});
		await value.fill(name);
		for (const owner of ['composing', 'legacy', 'handled'] as const) {
			for (const key of ['Enter', 'Escape']) {
				const event = await dispatchOwnedKey(value, key, owner);
				expect(event.prevented).toBe(owner === 'handled');
				if (owner === 'legacy') expect(event.legacy).toBe(229);
				await expect(dialog).toBeVisible();
				await expect(value).toBeFocused();
				await expect(value).toHaveValue(name);
				await expect(trigger).not.toHaveClass(/active/);
			}
		}
		await value.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await trigger.press('Enter');
		await expect(value).toHaveValue('');
		await value.fill(name);
		await value.press('Enter');
		await expect(dialog).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await expect(trigger).toHaveClass(/active/);
		await expect(cell).toHaveText(name);
	});
}
