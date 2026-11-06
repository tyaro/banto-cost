/** Portable theme switches use native checkbox state, labels, keyboard and form submission. */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { FULL_MATRIX, comboLabel } from './theme';

const css = readFileSync(
	new URL('../../packages/theme/src/css/banto.css', import.meta.url),
	'utf8'
).replace(
	"@import './banto-glass.css';",
	readFileSync(new URL('../../packages/theme/src/css/banto-glass.css', import.meta.url), 'utf8')
);
const markup = `<!doctype html><html lang="en"><head><title>Boolean settings</title><style>${css}</style></head><body><main><h1>Boolean settings</h1><form aria-label="Preferences">
<label class="banto-switch-field"><input class="banto-switch" type="checkbox" role="switch" name="sync" value="yes">Automatically synchronize new records across connected devices</label>
<label class="banto-switch-field"><input class="banto-switch" type="checkbox" role="switch" checked>Notifications</label>
<label class="banto-switch-field"><input class="banto-switch" type="checkbox" role="switch" disabled name="locked">Unavailable off</label>
<label class="banto-switch-field"><input class="banto-switch" type="checkbox" role="switch" disabled checked name="locked-on">Unavailable on</label>
<label><input type="checkbox" name="native">Native checkbox</label></form></main></body></html>`;

for (const combo of FULL_MATRIX)
	for (const density of ['standard', 'compact']) {
		test(`portable switches preserve native interaction (${comboLabel(combo)}, ${density})`, async ({
			page
		}) => {
			await page.setContent(markup);
			await page.evaluate(
				({ theme, preset, density }) => {
					document.documentElement.dataset.theme = theme;
					document.documentElement.dataset.bantoPreset = preset;
					document.documentElement.dataset.bantoDensity = density;
				},
				{ ...combo, density }
			);
			const sync = page.getByRole('switch', { name: /^Automatically/ });
			await expect(sync).not.toBeChecked();
			await sync.focus();
			await expect(sync).toHaveCSS('outline-style', 'solid');
			await sync.press('Space');
			await expect(sync).toBeChecked();
			expect(
				await page
					.locator('form')
					.evaluate((form: HTMLFormElement) => [...new FormData(form).entries()])
			).toEqual([['sync', 'yes']]);
			await page
				.getByText('Automatically synchronize new records across connected devices', {
					exact: true
				})
				.click();
			await expect(sync).not.toBeChecked();
			await sync.focus();
			await sync.press('Tab');
			await expect(page.getByRole('switch', { name: 'Notifications', exact: true })).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(page.getByRole('checkbox', { name: 'Native checkbox' })).toBeFocused();
			await expect(page.getByRole('switch', { name: 'Unavailable off' })).toBeDisabled();
			await expect(page.getByRole('switch', { name: 'Unavailable on' })).toBeChecked();
			await expect(page.getByRole('checkbox', { name: 'Native checkbox' })).toHaveCSS(
				'appearance',
				'auto'
			);
			await page.setViewportSize({ width: 320, height: 700 });
			await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				320
			);
			const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
			expect(results.violations).toEqual([]);
		});
	}

test('forced colors preserve switch track, thumb position and keyboard focus', async ({ page }) => {
	await page.setContent(markup);
	await page.emulateMedia({ forcedColors: 'active' });
	const controls = page.getByRole('switch');
	const paints = await controls.evaluateAll((elements) =>
		elements.map((element) => ({
			track: getComputedStyle(element).backgroundColor,
			thumb: getComputedStyle(element, '::before').backgroundColor,
			offset: getComputedStyle(element, '::before').transform
		}))
	);
	for (const paint of paints) expect(paint.track).not.toBe(paint.thumb);
	expect(paints[0].offset).not.toBe(paints[1].offset);
	expect(paints[2].offset).not.toBe(paints[3].offset);
	await controls.first().focus();
	await expect(controls.first()).toHaveCSS('outline-style', 'solid');
	await controls.first().press('Space');
	await expect(controls.first()).toBeChecked();
});
