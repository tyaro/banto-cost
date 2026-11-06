/** Synthetic IME/handled key events must not run the grid's edit commands. */
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
	for (const mode of ['Client', 'Server']) {
		test(`IME and handled keys preserve the draft until an explicit commit (${locale}, ${mode})`, async ({
			page
		}) => {
			await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
			await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
			await page.goto('/items');
			const modeButton = page.getByRole('button', { name: copy[`items.mode${mode}`], exact: true });
			await modeButton.click();
			const grid = page.getByRole('grid');
			const cell = grid.locator('[data-cell-row="0"][data-cell-field="name"]');
			await cell.dblclick();
			const input = grid.getByRole('textbox', { name: copy['items.fieldName'], exact: true });
			const original = await input.inputValue();
			const draft = `${original} 日本語`;
			await input.fill(draft);
			await input.evaluate((el) => {
				el.dataset.imeIdentity = 'same';
			});
			for (const owner of ['composing', 'legacy', 'handled'] as const) {
				for (const key of ['Enter', 'Escape', 'Tab']) {
					const event = await dispatchOwnedKey(input, key, owner);
					expect(event.prevented).toBe(owner === 'handled');
					expect(event.bubbled).toBe(false);
					if (owner === 'legacy') expect(event.legacy).toBe(229);
					await expect(input).toBeFocused();
					await expect(input).toHaveValue(draft);
					await expect(input).toHaveAttribute('data-ime-identity', 'same');
					await expect(cell).toHaveClass(/active/);
					await expect(cell).toHaveAttribute('aria-busy', 'false');
				}
			}
			await input.press('Enter');
			await expect(input).toHaveCount(0);
			await expect(grid).toBeFocused();
			await cell.dblclick();
			await expect(input).toHaveValue(draft);
			const blurDraft = `${draft} blur`;
			await input.fill(blurDraft);
			await dispatchOwnedKey(input, 'Tab', 'composing');
			await expect(input).toBeFocused();
			// Native Tab can blur; an actual later blur retains the existing save contract.
			await modeButton.click();
			await expect(input).toHaveCount(0);
			await expect(modeButton).toBeFocused();
			await expect(cell).toHaveText(blurDraft);

			const label = copy['grid.filterAriaLabel'].replace('{header}', copy['items.fieldName']);
			const trigger = grid.getByRole('button', { name: label, exact: true });
			await trigger.click();
			const dialog = grid.getByRole('dialog', { name: label, exact: true });
			const value = dialog.getByRole('textbox', {
				name: copy['grid.filterValueLabel'],
				exact: true
			});
			await value.fill(blurDraft);
			for (const owner of ['composing', 'legacy', 'handled'] as const) {
				for (const key of ['Enter', 'Escape']) {
					const event = await dispatchOwnedKey(value, key, owner);
					expect(event.prevented).toBe(owner === 'handled');
					if (owner === 'legacy') expect(event.legacy).toBe(229);
					await expect(dialog).toBeVisible();
					await expect(value).toBeFocused();
					await expect(value).toHaveValue(blurDraft);
					await expect(trigger).not.toHaveClass(/active/);
				}
			}
			await value.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect(trigger).toBeFocused();
			await trigger.press('Enter');
			await expect(value).toHaveValue('');
			await value.fill(blurDraft);
			await value.press('Enter');
			await expect(dialog).toHaveCount(0);
			await expect(trigger).toBeFocused();
			await expect(trigger).toHaveClass(/active/);
			await expect(cell).toHaveText(blurDraft);
		});
	}
}
