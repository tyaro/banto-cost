/** Theme-only HTML consumer: no app.css, Tailwind, router, or Svelte wrapper. */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { FULL_MATRIX, comboLabel } from './theme';

const glass = readFileSync(
	new URL('../../packages/theme/src/css/banto-glass.css', import.meta.url),
	'utf8'
);
// setContent has no stylesheet base URL. Expand the relative import in place
// so the standalone consumer exercises the real presets and cascade.
const css = readFileSync(
	new URL('../../packages/theme/src/css/banto.css', import.meta.url),
	'utf8'
).replace("@import './banto-glass.css';", glass);
const markup = `<!doctype html><html lang="en"><head><title>Native controls</title>
<style>${css}</style></head><body><main>
<h1>Native controls</h1>
<nav class="banto-section-nav" aria-label="Sections">
  <a href="#general" aria-current="page">General</a>
  <a href="#connection">Connection</a>
  <a href="#details">Detailed connection information and advanced options</a>
</nav>
<form aria-label="Settings">
  <label class="banto-field"><input class="banto-field-control" type="text" placeholder=" ">
    <span class="banto-field-label">Name</span></label>
  <label class="banto-field"><input class="banto-field-control" type="password" placeholder=" " autocomplete="new-password">
    <span class="banto-field-label">Password</span></label>
  <label class="banto-field"><input class="banto-field-control" type="number" placeholder=" " value="0">
    <span class="banto-field-label">Quantity</span></label>
  <label class="banto-field"><select class="banto-field-control">
    <option value="">Choose a connection</option><option value="local">Local</option></select>
    <span class="banto-field-label">Connection</span></label>
  <label class="banto-field"><input class="banto-field-control" type="text" readonly value="reference-42" placeholder=" ">
    <span class="banto-field-label">Reference</span></label>
  <label class="banto-field"><input class="banto-field-control" type="text" disabled value="Unavailable" placeholder=" ">
    <span class="banto-field-label">Disabled</span></label>
  <label class="banto-field"><input class="banto-field-control" type="text" value="bad" placeholder=" " aria-invalid="true" aria-describedby="name-error">
    <span class="banto-field-label">Invalid name</span></label>
  <p id="name-error">Enter a valid name.</p>
  <label class="banto-field banto-field--stacked"><input class="banto-field-control" type="date" value="2026-11-04">
    <span class="banto-field-label">Date</span></label>
  <label class="banto-field banto-field--stacked"><textarea class="banto-field-control" rows="4">One\nTwo\nThree\nFour</textarea>
    <span class="banto-field-label">Notes</span></label>
  <label class="banto-field banto-field--stacked"><input class="banto-field-control" type="text" value="Kept clear of the label" placeholder=" ">
    <span class="banto-field-label">A long translated label that must remain fully readable above the input value at narrow widths and enlarged text</span></label>
</form>
</main></body></html>`;

async function labelBox(control: Locator) {
	return control.evaluate((element) => {
		const label = element.nextElementSibling!.getBoundingClientRect();
		const field = element.getBoundingClientRect();
		return {
			top: label.top,
			bottom: label.bottom,
			valueTop: field.top + parseFloat(getComputedStyle(element).paddingTop)
		};
	});
}

for (const combo of FULL_MATRIX) {
	for (const density of ['standard', 'compact']) {
		test(`theme-only controls: ${comboLabel(combo)}, ${density}`, async ({ page }) => {
			await page.setContent(markup);
			await page.evaluate(
				({ theme, preset, density }) => {
					document.documentElement.dataset.theme = theme;
					document.documentElement.dataset.bantoPreset = preset;
					document.documentElement.dataset.bantoDensity = density;
				},
				{ ...combo, density }
			);
			const backdrop = await page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue('--banto-backdrop').trim()
			);
			expect(backdrop).toBe(combo.preset === 'glass' ? 'blur(14px) saturate(1.5)' : 'none');
			const currentLink = page.getByRole('link', { name: 'General', exact: true });
			const selectedColor = await currentLink.evaluate(
				(element) => getComputedStyle(element).color
			);
			await currentLink.hover();
			await expect(currentLink).toHaveCSS('color', selectedColor);

			const name = page.getByLabel('Name', { exact: true });
			const empty = await labelBox(name);
			await name.focus();
			expect((await labelBox(name)).top).toBeLessThan(empty.top);
			await name.fill('日本語の値');
			await name.blur();
			expect((await labelBox(name)).bottom).toBeLessThan((await labelBox(name)).valueTop);
			await name.fill('');
			await name.blur();
			expect((await labelBox(name)).top).toBeCloseTo(empty.top, 0);
			// Autofill/programmatic values need no application event to raise the label.
			await name.evaluate((element: HTMLInputElement) => (element.value = 'autofilled'));
			expect((await labelBox(name)).top).toBeLessThan(empty.top);

			const connection = page.getByRole('combobox', { name: 'Connection', exact: true });
			for (const control of [page.getByLabel('Quantity', { exact: true }), connection]) {
				const box = await labelBox(control);
				expect(box.bottom).toBeLessThan(box.valueTop);
			}
			await connection.selectOption('local');
			await expect(connection).toHaveValue('local');
			await expect(connection).toHaveCSS('appearance', 'auto');
			const date = page.getByLabel('Date', { exact: true });
			await date.fill('2027-03-04');
			await expect(date).toHaveValue('2027-03-04');
			await expect(date).toHaveCSS('appearance', 'auto');
			const notes = page.getByRole('textbox', { name: 'Notes', exact: true });
			await expect(notes).toHaveCSS('resize', 'vertical');
			const fourRows = (await notes.boundingBox())!.height;
			await notes.evaluate((element: HTMLTextAreaElement) => (element.rows = 1));
			expect(fourRows).toBeGreaterThan((await notes.boundingBox())!.height + 10);
			await notes.evaluate((element: HTMLTextAreaElement) => (element.rows = 4));

			const reference = page.getByLabel('Reference');
			for (const control of await page.locator('.banto-field-control').all()) {
				await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				if (await control.isEnabled()) {
					await control.hover();
					await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				}
			}
			await reference.focus();
			await expect(reference).toBeFocused();
			await reference.press('ControlOrMeta+A');
			expect(await reference.evaluate((element: HTMLInputElement) => element.selectionEnd)).toBe(
				12
			);
			await reference.pressSequentially('changed');
			await expect(reference).toHaveValue('reference-42');
			await expect(reference).toHaveCSS('opacity', '1');
			await expect(page.getByLabel('Disabled')).toBeDisabled();
			await expect(page.getByLabel('Disabled')).toHaveCSS('border-bottom-style', 'dashed');
			await expect(page.getByLabel('Invalid name')).toHaveAccessibleDescription(
				'Enter a valid name.'
			);

			await page.setViewportSize({ width: 320, height: 700 });
			await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
			const stacked = page.getByRole('textbox', { name: /^A long translated label/ });
			const stackedBox = await labelBox(stacked);
			expect(stackedBox.bottom).toBeLessThan(stackedBox.valueTop);
			await stacked.focus();
			expect((await labelBox(stacked)).bottom).toBeLessThan((await labelBox(stacked)).valueTop);
			const japaneseLabel =
				'装置から取得した現在の測定値を保存する際に使用する項目名と、その値が表す単位を確認してください';
			await stacked.evaluate((element, text) => {
				element.nextElementSibling!.textContent = text;
				element.nextElementSibling!.setAttribute('lang', 'ja');
			}, japaneseLabel);
			const japaneseBox = await labelBox(page.getByRole('textbox', { name: japaneseLabel }));
			expect(japaneseBox.bottom).toBeLessThan(japaneseBox.valueTop);
			for (const control of [date, notes]) {
				const box = await labelBox(control);
				expect(box.bottom).toBeLessThan(box.valueTop);
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				320
			);
			const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
			expect(results.violations).toEqual([]);
		});
	}
}

test('theme-only focus and current page remain visible in forced colors', async ({ page }) => {
	await page.emulateMedia({ forcedColors: 'active' });
	await page.setContent(markup);
	await page.keyboard.press('Tab');
	const nav = page.getByRole('navigation', { name: 'Sections' });
	await expect(nav.getByRole('link', { name: 'General', exact: true })).toHaveCSS(
		'border-bottom-style',
		'solid'
	);
	await expect(nav.getByRole('link', { name: 'Connection', exact: true })).toHaveCSS(
		'border-bottom-style',
		'none'
	);
	await expect(nav.getByRole('link', { name: 'General', exact: true })).toHaveCSS(
		'outline-style',
		'solid'
	);
	const reference = page.getByLabel('Reference');
	await reference.focus();
	await expect(reference).toHaveCSS('outline-style', 'solid');
	const outline = await reference.evaluate((element) => {
		const style = getComputedStyle(element);
		return { width: parseFloat(style.outlineWidth), color: style.outlineColor };
	});
	expect(outline.width).toBeGreaterThan(0);
	// Forced colors may substitute a system focus color for currentColor.
	expect(outline.color).not.toBe('transparent');
	expect(outline.color).not.toBe('rgba(0, 0, 0, 0)');
});
